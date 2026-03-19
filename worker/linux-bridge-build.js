/**
 * Linux Bridge Build — Luna C#→JS→HTML on Linux (Mono 6.12 + msbuild)
 * 
 * Minimal implementation:
 *   Input:  C# source code (GameFlowManagerMain.cs)
 *   Output: Single HTML file (playable ad)
 * 
 * Prerequisites on Linux:
 *   - Mono 6.12+ (msbuild 16.6.0)
 *   - Node.js 20+
 *   - /opt/luna/packages/   (Bridge.NET + all DLLs)
 *   - /opt/luna/Scripts/    (csproj template + Vendor DLLs)
 *   - /opt/luna/engine/     (Luna JS runtime)
 *   - /opt/luna/stage1-cache/ (asset templates)
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');

// ─── Config ───
const isLinux = os.platform() === 'linux';
const LUNA_BASE = isLinux ? '/opt/luna' : 'D:\\Luna\\pipeline\\templates\\LunaCompiler';
const PACKAGES_DIR = path.join(LUNA_BASE, 'packages');
const SCRIPTS_TEMPLATE_DIR = path.join(LUNA_BASE, 'Scripts');
const ENGINE_DIR = isLinux ? '/opt/luna/engine' : 'D:\\Luna\\engine';
const STAGE1_CACHE = isLinux ? '/opt/luna/stage1-cache' : path.join(__dirname, 'stage1-cache');
const MSBUILD_CMD = isLinux ? 'msbuild' : '"C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\MSBuild\\Current\\Bin\\MSBuild.exe"';
// Pre-built engine JS files (bridge.js, UnityEngine.js, etc.) — not from Bridge.NET compilation
const ENGINE_JS_DIR = isLinux ? '/opt/luna-poc/LunaCompiler/bin' : 'D:\\Luna\\pipeline\\templates\\LunaCompiler\\bin';

/**
 * Build a playable ad HTML from C# source code
 * @param {string} csCode - The C# source (GameFlowManagerMain.cs content)
 * @param {object} opts
 * @param {string} opts.taskId - Task identifier
 * @param {function} opts.log - Logger function
 * @param {string} opts.className - Main class name (default: GameFlowManagerMain)
 * @returns {Promise<{ok: boolean, html?: string, error?: string, buildTime?: number}>}
 */
async function buildFromCS(csCode, opts = {}) {
  const { taskId = 'build', log = console.log, className = 'GameFlowManagerMain', extraFiles = {} } = opts;
  // extraFiles: { 'GFM_Tools.cs': '...code...' }
  const startTime = Date.now();

  // Create temp work directory
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-build-'));
  const scriptsDir = path.join(workDir, 'Scripts');
  const packagesDir = path.join(workDir, 'packages');
  const binDir = path.join(scriptsDir, 'bin', 'Debug');

  try {
    log(`[linux-build] Starting build in ${workDir}`, taskId);

    // 1. Set up project structure
    fs.mkdirSync(path.join(scriptsDir, 'Sources'), { recursive: true });
    fs.mkdirSync(path.join(scriptsDir, 'Properties'), { recursive: true });
    fs.mkdirSync(path.join(scriptsDir, 'Vendor'), { recursive: true });

    // Symlink packages (save disk space)
    fs.symlinkSync(PACKAGES_DIR, packagesDir);

    // Copy Vendor DLLs
    const vendorSrc = path.join(SCRIPTS_TEMPLATE_DIR, 'Vendor');
    if (fs.existsSync(vendorSrc)) {
      for (const f of fs.readdirSync(vendorSrc)) {
        fs.copyFileSync(path.join(vendorSrc, f), path.join(scriptsDir, 'Vendor', f));
      }
    }

    // 2. Write C# source(s)
    fs.writeFileSync(path.join(scriptsDir, 'Sources', `${className}.cs`), csCode);
    for (const [fileName, fileCode] of Object.entries(extraFiles)) {
      fs.writeFileSync(path.join(scriptsDir, 'Sources', fileName), fileCode);
    }

    // AssemblyInfo
    fs.writeFileSync(path.join(scriptsDir, 'Properties', 'AssemblyInfo.cs'),
      `using System.Reflection;\n[assembly: AssemblyTitle("UnityScriptsCompiler")]\n[assembly: AssemblyVersion("1.0.0.0")]\n`);

    // 3. Write bridge.json (CRITICAL: outputFormatting must be Formatted to avoid AjaxMin crash on Mono)
    fs.writeFileSync(path.join(scriptsDir, 'bridge.json'), JSON.stringify({
      output: 'bin/Debug',
      cleanOutputFolderBeforeBuild: false,
      outputFormatting: 'Formatted',
      ignoreDuplicateTypes: true,
      reflection: { target: 'Inline' },
      console: { enabled: false },
      sourceMap: { enabled: false },
      generateTypeScript: false,
      rules: {
        anonymousType: 'Plain',
        arrayIndex: 'Plain',
        autoProperty: 'Plain',
        boxing: 'Managed',
        integer: 'Managed',
        lambda: 'Plain'
      }
    }, null, 2));

    // 4. Generate csproj
    const csproj = generateCsproj(className, Object.keys(extraFiles));
    fs.writeFileSync(path.join(scriptsDir, 'Scripts.csproj'), csproj);

    // 5. Run msbuild
    log('[linux-build] Running msbuild...', taskId);
    const msbuildStart = Date.now();
    try {
      const result = execSync(
        `${MSBUILD_CMD} Scripts.csproj /t:Build /p:Configuration=Debug /v:minimal 2>&1`,
        { cwd: scriptsDir, timeout: 60000, encoding: 'utf-8' }
      );
      const msbuildTime = Math.floor((Date.now() - msbuildStart) / 1000);
      log(`[linux-build] msbuild done in ${msbuildTime}s`, taskId);

      // Check for errors
      if (result.includes('error CS') || result.includes('error :')) {
        const errors = result.split('\n').filter(l => /error/i.test(l)).slice(0, 10);
        return { ok: false, error: `Compilation errors:\n${errors.join('\n')}` };
      }
    } catch (e) {
      const errOut = (e.stdout || '') + '\n' + (e.stderr || '');
      const csErrors = errOut.split('\n').filter(l => /error CS\d+/i.test(l)).slice(0, 10);
      return { ok: false, error: `msbuild failed: ${csErrors.join('\n') || errOut.slice(-2000)}` };
    }

    // 6. Verify JS output
    const jsPath = path.join(binDir, 'UnityScriptsCompiler.js');
    if (!fs.existsSync(jsPath)) {
      return { ok: false, error: 'Build succeeded but UnityScriptsCompiler.js not found' };
    }

    const js = fs.readFileSync(jsPath, 'utf-8');
    if (!js.includes(className)) {
      return { ok: false, error: `JS output does not contain ${className} — compilation may have failed silently` };
    }

    log(`[linux-build] JS generated: ${(js.length / 1024).toFixed(0)} KB`, taskId);

    // 7. Assemble stage4
    log('[linux-build] Assembling stage4...', taskId);
    const stage4Dir = path.join(workDir, 'stage4');
    assembleStage4(stage4Dir, binDir, STAGE1_CACHE);

    // 8. Inject GameFlowManagerMain into iframe.html
    injectGameManager(stage4Dir, className);

    // 9. Patch script1.js (prevent Awake crash)
    patchScript1(stage4Dir, log, taskId);

    // 10. Convert to single HTML
    log('[linux-build] Converting to single HTML...', taskId);
    const html = convertToSingleHTML(stage4Dir);

    const totalTime = Math.floor((Date.now() - startTime) / 1000);
    log(`[linux-build] ✅ Build complete in ${totalTime}s, HTML: ${(html.length / 1024).toFixed(0)} KB`, taskId);

    return { ok: true, html, buildTime: totalTime };

  } finally {
    // Cleanup temp dir
    // DEBUG: keep temp dir
    // try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) {}
  }
}

// ─── csproj Generator ───
function generateCsproj(className, extraFileNames = []) {
  const compileEntries = [`    <Compile Include="Sources/${className}.cs" />`];
  for (const fn of extraFileNames) {
    compileEntries.push(`    <Compile Include="Sources/${fn}" />`);
  }
  compileEntries.push(`    <Compile Include="Properties/AssemblyInfo.cs" />`);

  return `<?xml version="1.0" encoding="utf-8"?>
<Project DefaultTargets="Build" ToolsVersion="4.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup>
    <Configuration Condition=" '$(Configuration)' == '' ">Debug</Configuration>
    <Platform Condition=" '$(Platform)' == '' ">AnyCPU</Platform>
    <OutputType>Library</OutputType>
    <RootNamespace>UnityScriptsCompiler</RootNamespace>
    <AssemblyName>UnityScriptsCompiler</AssemblyName>
    <TargetFrameworkVersion>v4.7</TargetFrameworkVersion>
    <TreatWarningsAsErrors>false</TreatWarningsAsErrors>
  </PropertyGroup>
  <PropertyGroup Condition=" '$(Configuration)|$(Platform)' == 'Debug|AnyCPU' ">
    <DebugSymbols>true</DebugSymbols>
    <Optimize>false</Optimize>
    <OutputPath>bin/Debug</OutputPath>
    <DefineConstants>;UNITY_LUNA;CSHARP_7_OR_LATER;CSHARP_7_3_OR_NEWER</DefineConstants>
    <NoStdLib>true</NoStdLib>
    <NoWarn>CS0626</NoWarn>
    <LangVersion>7.2</LangVersion>
  </PropertyGroup>
  <ItemGroup>
${compileEntries.join('\n')}
  </ItemGroup>
  <ItemGroup>
    <Reference Include="Bridge">
      <HintPath>../packages/Bridge.Core.17.9.42-luna/lib/net40/Bridge.dll</HintPath>
    </Reference>
    <Reference Include="Bridge.Html5">
      <HintPath>../packages/Bridge.Html5.17.9.0/lib/net40/Bridge.Html5.dll</HintPath>
    </Reference>
    <Reference Include="Bridge.WebGL">
      <HintPath>../packages/Bridge.WebGL.1.22.0/lib/net40/Bridge.WebGL.dll</HintPath>
    </Reference>
    <Reference Include="Newtonsoft.Json">
      <HintPath>../packages/Bridge.Newtonsoft.Json.1.16.0/lib/net40/Newtonsoft.Json.dll</HintPath>
    </Reference>
    <Reference Include="Retyped.Core">
      <HintPath>../packages/Retyped.Core.1.6.6733/lib/net40/Retyped.Core.dll</HintPath>
    </Reference>
    <Reference Include="Retyped.dom">
      <HintPath>../packages/Retyped.dom.2.8.6733/lib/net40/Retyped.dom.dll</HintPath>
    </Reference>
    <Reference Include="Retyped.es5">
      <HintPath>../packages/Retyped.es5.2.8.6733/lib/net40/Retyped.es5.dll</HintPath>
    </Reference>
    <Reference Include="Retyped.scripthost">
      <HintPath>../packages/Retyped.scripthost.2.8.6733/lib/net40/Retyped.scripthost.dll</HintPath>
    </Reference>
    <Reference Include="UnityEngine">
      <HintPath>Vendor/UnityEngine.dll</HintPath>
    </Reference>
    <Reference Include="UnityEngine.UI">
      <HintPath>../packages/com.unity.ui/1.2.1/UnityEngine.UI.dll</HintPath>
    </Reference>
    <Reference Include="UnityEngine.UniversalRenderPipeline">
      <HintPath>../packages/com.unity.urp/7.6/UnityEngine.UniversalRenderPipeline.dll</HintPath>
    </Reference>
    <Reference Include="DOTween">
      <HintPath>../packages/DOTween.1.2.705/lib/net40/DOTween.dll</HintPath>
    </Reference>
    <Reference Include="TextMeshPro">
      <HintPath>../packages/com.unity.textmeshpro/3.0.6/TextMeshPro.dll</HintPath>
    </Reference>
    <Reference Include="JetBrains">
      <HintPath>../packages/com.unity.ide.rider/3.0.0/JetBrains.dll</HintPath>
    </Reference>
  </ItemGroup>
  <ItemGroup>
    <None Include="bridge.json" />
  </ItemGroup>
  <PropertyGroup>
    <CSharpTargetsPath>$(MSBuildBinPath)/Microsoft.CSharp.targets</CSharpTargetsPath>
    <CSharpTargetsPath Condition="$(MSBuildBinPath.Contains('xbuild'))">$(MSBuildBinPath)/../../14.0/bin/Microsoft.CSharp.targets</CSharpTargetsPath>
  </PropertyGroup>
  <Import Project="$(CSharpTargetsPath)"/>
  <Import Project="../packages/Bridge.Min.17.9.42-luna/build/Bridge.Min.targets"
          Condition="Exists('../packages/Bridge.Min.17.9.42-luna/build/Bridge.Min.targets')" />
</Project>`;
}

// ─── Stage4 Assembly ───
// Strategy: copy the entire stage4-template (from real Unity/Luna export),
// then ONLY replace UnityScriptsCompiler.js with our Bridge.NET compiled output.
const STAGE4_TEMPLATE = isLinux ? '/opt/luna/stage4-template' : path.join(__dirname, '..', 'stage4-from-nick', 'stage4', 'develop');

function assembleStage4(stage4Dir, binDir, stage1Cache) {
  fs.mkdirSync(stage4Dir, { recursive: true });

  const cpDir = (s, d) => {
    fs.mkdirSync(d, { recursive: true });
    for (const e of fs.readdirSync(s, { withFileTypes: true })) {
      const a = path.join(s, e.name), b = path.join(d, e.name);
      if (e.isDirectory()) cpDir(a, b); else fs.copyFileSync(a, b);
    }
  };

  // Copy entire stage4 template (iframe.html, engine, assets, js, etc.)
  if (fs.existsSync(STAGE4_TEMPLATE)) {
    cpDir(STAGE4_TEMPLATE, stage4Dir);
  } else {
    throw new Error('stage4-template not found at ' + STAGE4_TEMPLATE);
  }

  // Replace UnityScriptsCompiler.js with our compiled version
  if (fs.existsSync(binDir)) {
    const compiled = path.join(binDir, 'UnityScriptsCompiler.js');
    if (fs.existsSync(compiled)) {
      const dest = path.join(stage4Dir, 'engine', 'unity', 'bin', 'UnityScriptsCompiler.js');
      fs.copyFileSync(compiled, dest);
    }
  }

  // luna.json already exists in template, but regenerate to be safe
  // Generate luna.json
  fs.writeFileSync(path.join(stage4Dir, 'luna.json'), JSON.stringify({
    version: '6.4.0', platform: 'WebGL', optimizations: {}
  }));
}

// ─── iframe.html Generator ───
function generateIframeHTML(stage4Dir) {
  // ─── Collect JS files in the EXACT order Luna expects ───
  // Order from real iframe.html: deserializers → script-1 → bridge → physics3d-0
  // → physics2d-0 → mecanim → script1 → urp-1 → physics3d-1 → particle-system-1
  // → physics2d-1 → Bridge.Locales → UnityEngine → UnityEngine.UI → URP → DOTween
  // → UnityScriptsCompiler → script3 → ExternalJS/*

  const lunaEngineOrder = [
    'script-1.js', 'script1.js', 'mecanim-wasm-0.js',
    'particle-system-1-stub.js', 'particle-system-1.js',
    'physics2d-0.js', 'physics2d-1-stub.js', 'physics2d-1.js',
    'physics3d-0-stub.js', 'physics3d-0.js', 'physics3d-1-stub.js', 'physics3d-1.js',
    'script3.js', 'urp-1-stub.js', 'urp-1.js'
  ];

  const unityBinOrder = [
    'bridge.js', 'Bridge.Locales.js', 'bridge.meta.js',
    'UnityEngine.js', 'UnityEngine.UI.js',
    'UnityEngine.UniversalRenderPipeline.js',
    'DOTween.js', 'JetBrains.js', 'newtonsoft.json.js',
    'UnityScriptsCompiler.js'
  ];

  // Exact load order from real iframe.html:
  const orderedPaths = [];

  // 1. js/deserializers.js first
  const jsDir = path.join(stage4Dir, 'js');
  if (fs.existsSync(path.join(jsDir, 'deserializers.js'))) {
    orderedPaths.push('js/deserializers.js');
  }

  // 2. engine/luna/script-1.js
  const lunaDir = path.join(stage4Dir, 'engine', 'luna');
  if (fs.existsSync(lunaDir)) {
    // First: script-1.js (sets up window.pc)
    if (fs.existsSync(path.join(lunaDir, 'script-1.js')))
      orderedPaths.push('engine/luna/script-1.js');
  }

  // 3. engine/unity/bin/bridge.js
  const unityBinDir = path.join(stage4Dir, 'engine', 'unity', 'bin');
  if (fs.existsSync(unityBinDir)) {
    if (fs.existsSync(path.join(unityBinDir, 'bridge.js')))
      orderedPaths.push('engine/unity/bin/bridge.js');
  }

  // 4. Luna physics/mecanim/particle modules
  const lunaModules = ['physics3d-0.js', 'physics2d-0.js', 'mecanim-wasm-0.js'];
  for (const m of lunaModules) {
    if (fs.existsSync(path.join(lunaDir, m)))
      orderedPaths.push(`engine/luna/${m}`);
  }

  // 5. script1.js (Bridge.NET runtime extensions)
  if (fs.existsSync(path.join(lunaDir, 'script1.js')))
    orderedPaths.push('engine/luna/script1.js');

  // 6. urp, physics/particle stubs and full modules
  const lunaModules2 = [
    'urp-1.js', 'physics3d-1.js', 'particle-system-1.js', 'physics2d-1.js'
  ];
  for (const m of lunaModules2) {
    if (fs.existsSync(path.join(lunaDir, m)))
      orderedPaths.push(`engine/luna/${m}`);
  }

  // 7. Unity bin: Bridge.Locales → UnityEngine → UI → URP → DOTween → UnityScriptsCompiler
  const unityModules = [
    'Bridge.Locales.js', 'UnityEngine.js', 'UnityEngine.UI.js',
    'UnityEngine.UniversalRenderPipeline.js', 'DOTween.js',
    'JetBrains.js', 'newtonsoft.json.js', 'UnityScriptsCompiler.js'
  ];
  for (const m of unityModules) {
    if (fs.existsSync(path.join(unityBinDir, m)))
      orderedPaths.push(`engine/unity/bin/${m}`);
  }

  // 8. script3.js
  if (fs.existsSync(path.join(lunaDir, 'script3.js')))
    orderedPaths.push('engine/luna/script3.js');

  // 9. ExternalJS files
  const extJsDir = path.join(jsDir, 'ExternalJS');
  if (fs.existsSync(extJsDir)) {
    const extFiles = fs.readdirSync(extJsDir).filter(f => f.endsWith('.js'));
    for (const f of extFiles) orderedPaths.push(`js/ExternalJS/${f}`);
  }

  // 10. Any remaining JS files not yet included
  const included = new Set(orderedPaths);
  if (fs.existsSync(lunaDir)) {
    for (const f of fs.readdirSync(lunaDir).filter(f => f.endsWith('.js'))) {
      const p = `engine/luna/${f}`;
      if (!included.has(p)) orderedPaths.push(p);
    }
  }
  if (fs.existsSync(unityBinDir)) {
    for (const f of fs.readdirSync(unityBinDir).filter(f => f.endsWith('.js'))) {
      const p = `engine/unity/bin/${f}`;
      if (!included.has(p)) orderedPaths.push(p);
    }
  }

  const scriptTags = orderedPaths
    .map(p => `<script src="${p}" defer="defer" type="text/javascript"><\/script>`)
    .join('\n');

  // ─── Luna $environment (for inline single-HTML mode) ───
  const envScript = `var $environment={baseUrl:"./",resourceConfig:{json:"external",image:"external",video:"external",blob:"external",sound:"external"},packageConfig:{userId:"linux-build",version:"6.4.0"},playerPrefs:!0,forceIncludedClasses:["LunaUnity.Utils.CompressedResources","LunaUnity.Utils.ExternalResources","LunaUnity.Utils.InlineResources","LunaUnity.Utils.Network","LunaUnity.Audio.Manager","Luna.Unity.Analytics","Luna.Unity.Analytics.EventType","Luna.Unity.Playable","Luna.Unity.LifeCycle","Luna.Unity.HapticFeedbackType","Luna.Unity.CallbackTypes","Luna.Unity.Nucleo","Luna.Unity.Nucleo.EventTypes","Luna.Unity.TriggerTypes","Luna.Unity.BuildPlatforms","Luna.Unity.NativeShare","UnityEngine.AudioSource","UnityEngine.Debug","UnityEngine.GameObject","UnityEngine.ILogger","UnityEngine.Logger","UnityEngine.ILogHandler","UnityEngine.DebugLogHandler","UnityEngine.LogType","UnityEngine.Input","UnityEngine.Touch","UnityEngine.Cursor","UnityEngine.CursorLockMode","UnityEngine.CursorMode","UnityEngine.EventSystems.EventSystem","UnityEngine.EventSystems.ExecuteEvents","UnityEngine.EventSystems.BaseInput","UnityEngine.Object","UnityEngine.Object$1","UnityEngine.Component","UnityEngine.Component$1","UnityEngine.Behaviour$1","UnityEngine.Behaviour","UnityEngine.ColorSpace","UnityEngine.MonoBehaviour","UnityEngine.EventSystems.UIBehaviour","UnityEngine.EventSystems.BaseInputModule","UnityEngine.EventSystems.PointerInputModule","UnityEngine.EventSystems.StandaloneInputModule","UnityEngine.EventSystems.AbstractEventData","UnityEngine.EventSystems.BaseEventData","UnityEngine.EventSystems.AxisEventData","UnityEngine.PlayerPrefs","UnityEngine.LunaPlaygroundAssetAttribute","UnityEngine.LunaPlaygroundFieldAttribute","UnityEngine.LunaPlaygroundSectionAttribute","LunaUnity.Objects.Registry","UnityEngine.Application","TMPro.TextMeshProUGUI"],targetPlatform:"develop",runtimeAnalysisModules:["physics3d","physics2d","particle_system","reflection","prefabs","mecanim-wasm"]}`;

  // ─── Luna bootstrap (loaded from luna-bootstrap.html file) ───
  const bootstrapFile = path.join(__dirname, 'luna-bootstrap.html');
  const bootstrapHTML = fs.existsSync(bootstrapFile)
    ? fs.readFileSync(bootstrapFile, 'utf8')
    : '<canvas id="application-canvas"></canvas>';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>
* { margin:0; padding:0; }
html,body { width:100%; height:100%; overflow:hidden; background:#000; }
#application-canvas { margin:0 auto; display:block; background:#000; position:absolute; width:100%!important; height:100%!important; top:0; left:0; }
</style>
<script>${envScript}<\/script>
</head>
<body>
${scriptTags}
${bootstrapHTML}
</body>
</html>`;
}

// ─── GameFlowManagerMain Injection ───
function injectGameManager(stage4Dir, className) {
  const iframePath = path.join(stage4Dir, 'iframe.html');
  if (!fs.existsSync(iframePath)) return;

  let html = fs.readFileSync(iframePath, 'utf-8');

  // The injection script from worker-bridge-build.js (polyfills + game loop)
  const injectionScript = `<script>
window.addEventListener("luna:starting", function() {
  try {
    var origGetBuiltin = UnityEngine.Resources.GetBuiltinResource;
    UnityEngine.Resources.GetBuiltinResource = function(type, name) {
      if (name && name.indexOf(".ttf") >= 0) {
        try { return Font.CreateDynamicFontFromOSFont("Arial", 14); } catch(e) {}
        return null;
      }
      if (type && type.$$name === "Mesh") {
        var mesh = new UnityEngine.Mesh.ctor();
        if (name === "Cube.fbx") {
          mesh.vertices = Bridge.Array.init([ new UnityEngine.Vector3.ctor$1(-0.5,-0.5,-0.5), new UnityEngine.Vector3.ctor$1(0.5,-0.5,-0.5), new UnityEngine.Vector3.ctor$1(0.5,0.5,-0.5), new UnityEngine.Vector3.ctor$1(-0.5,0.5,-0.5), new UnityEngine.Vector3.ctor$1(-0.5,-0.5,0.5), new UnityEngine.Vector3.ctor$1(0.5,-0.5,0.5), new UnityEngine.Vector3.ctor$1(0.5,0.5,0.5), new UnityEngine.Vector3.ctor$1(-0.5,0.5,0.5) ], UnityEngine.Vector3);
          mesh.triangles = Bridge.Array.init([0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,2,3,7,2,7,6,0,4,7,0,7,3,1,2,6,1,6,5], System.Int32);
          mesh.RecalculateNormals();
        } else {
          mesh.vertices = Bridge.Array.init([ new UnityEngine.Vector3.ctor$1(-0.5,-0.5,-0.5), new UnityEngine.Vector3.ctor$1(0.5,-0.5,-0.5), new UnityEngine.Vector3.ctor$1(0.5,0.5,-0.5), new UnityEngine.Vector3.ctor$1(-0.5,0.5,-0.5), new UnityEngine.Vector3.ctor$1(-0.5,-0.5,0.5), new UnityEngine.Vector3.ctor$1(0.5,-0.5,0.5), new UnityEngine.Vector3.ctor$1(0.5,0.5,0.5), new UnityEngine.Vector3.ctor$1(-0.5,0.5,0.5) ], UnityEngine.Vector3);
          mesh.triangles = Bridge.Array.init([0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,2,3,7,2,7,6,0,4,7,0,7,3,1,2,6,1,6,5], System.Int32);
          mesh.RecalculateNormals();
        }
        return mesh;
      }
      if (type && type.$$name === "Material") {
        var sh = UnityEngine.Shader.Find("Universal Render Pipeline/Lit") || UnityEngine.Shader.Find("UI/Default");
        if (sh) return new UnityEngine.Material.ctor(sh);
        return null;
      }
      if (origGetBuiltin) try { return origGetBuiltin.apply(this, arguments); } catch(e) {}
      return null;
    };
    var origShaderFind = UnityEngine.Shader.Find;
    UnityEngine.Shader.Find = function(name) {
      var s = origShaderFind(name);
      if (!s) s = origShaderFind("UI/Default");
      return s;
    };
    window.addEventListener("error", function(evt) {
      if (evt && evt.message && (evt.message.indexOf("Awake()") >= 0 || evt.message.indexOf("OnEnable()") >= 0)) {
        evt.preventDefault(); return true;
      }
    });
    console.log("[AI] Polyfills installed");
  } catch(e) { console.error("[AI] Polyfill error:", e); }
});
window.addEventListener("luna:started", function() {
  try {
    var go = new UnityEngine.GameObject.ctor("GameManager");
    var comp = go.AddComponent(${className});
    if (comp && comp.Start) { try { comp.Start(); } catch(se) { console.error("[AI] Start() error:", se); } }
    // Post-Start fixes using PlayCanvas native API
    (function() {
      var pcApp = window.app && window.app.app;
      if (!pcApp || !pcApp.root) return;
      
      // 1. Always create camera + light (scene ones don't survive Start clean-up)
      console.log("[AI] Creating PlayCanvas camera + light");
      var camEnt = new pc.Entity("AI_Camera");
      pcApp.root.addChild(camEnt);
      camEnt.addComponent("camera", {
        clearColor: new pc.Color(0.6, 0.8, 1.0),
        projection: 1,
        orthoHeight: 10,
        nearClip: 0.1,
        farClip: 1000,
        priority: 100
      });
      camEnt.setPosition(0, 15, -8);
      camEnt.setEulerAngles(55, 0, 0);
      var lightEnt = new pc.Entity("AI_Light");
      pcApp.root.addChild(lightEnt);
      lightEnt.addComponent("light", {
        type: "directional",
        color: new pc.Color(1, 0.95, 0.85),
        intensity: 1.0
      });
      lightEnt.setEulerAngles(50, -30, 0);
      
      // 2. Material color sync: Bridge.NET material.color → PlayCanvas _Color parameter
      var mis = pcApp.scene._meshInstances || [];
      var colorFixed = 0;
      for (var i = 0; i < mis.length; i++) {
        var mi = mis[i];
        if (!mi || !mi.material || !mi.node) continue;
        try {
          var goName = mi.node.name;
          var go = UnityEngine.GameObject.Find(goName);
          if (!go) continue;
          var renderer = go.GetComponent(UnityEngine.Renderer);
          if (!renderer || !renderer.material || !renderer.material.color) continue;
          var c = renderer.material.color;
          mi.material.setParameter("_Color", [c.r, c.g, c.b, c.a]);
          mi.material.setParameter("_BaseColor", [c.r, c.g, c.b, c.a]);
          colorFixed++;
        } catch(e) {}
      }
      console.log("[AI] Material colors synced:", colorFixed);
    })();
    if (comp && comp.Update) {
      var lastTime = performance.now();
      function gameLoop() {
        var now = performance.now();
        var dt = (now - lastTime) / 1000.0;
        lastTime = now;
        try { if (UnityEngine.Time) UnityEngine.Time.deltaTime = dt; } catch(e) {}
        try { comp.Update(); } catch(e) {}
        requestAnimationFrame(gameLoop);
      }
      requestAnimationFrame(gameLoop);
    }
    console.log("[AI] ${className} injected successfully");
  } catch(e) { console.error("[AI] Failed to inject:", e); }
});
<\/script>`;

  if (html.includes('</body>')) {
    html = html.replace('</body>', injectionScript + '</body>');
  } else {
    html += injectionScript;
  }

  fs.writeFileSync(iframePath, html);
}

// ─── script1.js Patch ───
function patchScript1(stage4Dir, log, taskId) {
  const script1Path = path.join(stage4Dir, 'engine', 'luna', 'script1.js');
  if (!fs.existsSync(script1Path)) return;

  let script1 = fs.readFileSync(script1Path, 'utf-8');
  const oldPattern = '_invokeOverload(e){try{const t=this.code.overloads[e+"()"]';
  const newPattern = '_invokeOverload(e){try{if(!this.code||!this.code.overloads)return;const t=this.code.overloads[e+"()"]';

  if (script1.includes(oldPattern)) {
    script1 = script1.replace(oldPattern, newPattern);
    fs.writeFileSync(script1Path, script1);
    log('[linux-build] ✅ Patched script1.js _invokeOverload', taskId);
  }
}

// ─── Single HTML Converter (inline version of converter-v3) ───
function convertToSingleHTML(stage4Dir) {
  let html = fs.readFileSync(path.join(stage4Dir, 'iframe.html'), 'utf8');

  // Collect non-JS files for fileDict
  function walkFiles(dir) {
    const result = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) result.push(...walkFiles(full));
      else result.push(full);
    }
    return result;
  }

  const allFiles = walkFiles(stage4Dir);
  const fileDict = {};

  for (const fp of allFiles) {
    const rel = path.relative(stage4Dir, fp).replace(/\\/g, '/');
    const ext = path.extname(fp).toLowerCase();
    if (['.html', '.css'].includes(ext)) continue;
    if (ext === '.js') continue;

    if (ext === '.json') {
      fileDict[rel] = { t: 'j', d: fs.readFileSync(fp, 'utf8') };
    } else if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) {
      const mime = ext === '.jpg' ? 'image/jpeg' : `image/${ext.slice(1)}`;
      fileDict[rel] = { t: 'i', d: fs.readFileSync(fp).toString('base64'), m: mime };
    } else if (['.blob', '.bin', '.dat', '.fnt'].includes(ext)) {
      fileDict[rel] = { t: 'b', d: fs.readFileSync(fp).toString('base64') };
    }
  }

  // Build XHR/fetch interceptor
  const interceptor = `<script>
window.DEVELOP=true;window.TRACE=false;window.TESTS=false;window.DEBUG=false;window.FORCE_STABLE_RANDOM_SEED=false;
window.MODULE_physics3d=true;window.MODULE_physics2d=true;window.MODULE_particle_system=true;
window.MODULE_reflection=true;window.MODULE_prefabs=true;window.MODULE_mecanim=true;
(function(){
var __fd = ${JSON.stringify(fileDict).replace(/<(\/?)script/gi, '\\x3c$1script')};
function b2ab(b){var s=atob(b),a=new Uint8Array(s.length);for(var i=0;i<s.length;i++)a[i]=s.charCodeAt(i);return a.buffer}
function findEntry(url){
  var fn=url;if(!fn)return null;
  if(fn.startsWith('./'))fn=fn.slice(2);
  if(fn.startsWith('/'))fn=fn.slice(1);
  fn=fn.replace(/\\\\/g,'/');
  if(__fd[fn])return __fd[fn];
  var parts=['assets','js','engine','favicon','tmp'];
  for(var p=0;p<parts.length;p++){var idx=fn.indexOf(parts[p]+'/');if(idx>-1){var k=fn.slice(idx);if(__fd[k])return __fd[k]}}
  return null;
}
var _xhrOpen=XMLHttpRequest.prototype.open,_xhrSend=XMLHttpRequest.prototype.send;
var _baseOrigin=window.location.origin+'/';
XMLHttpRequest.prototype.open=function(m,url,async){this.__url=url;this.__async=async!==false;_xhrOpen.apply(this,arguments)};
XMLHttpRequest.prototype.send=function(){
  var url=this.__url;
  // Strip origin prefix so interceptor can match relative paths
  if(url&&url.startsWith(_baseOrigin))url=url.slice(_baseOrigin.length);
  if(url&&(url.startsWith('http://')||url.startsWith('https://')||url.startsWith('blob:')||url.startsWith('data:')))return _xhrSend.apply(this,arguments);
  var item=findEntry(url);
  if(!item){return _xhrSend.apply(this,arguments)}
  var self=this;
  function deliver(){
    var data;
    if(item.t==='j'){
      if(self.responseType==='json')try{data=JSON.parse(item.d)}catch(e){data=item.d}
      else if(self.responseType==='arraybuffer'){var enc=new TextEncoder();data=enc.encode(item.d).buffer}
      else data=item.d;
    }else if(item.t==='b'||item.t==='i'){data=b2ab(item.d)}
    Object.defineProperty(self,'readyState',{get:function(){return 4},configurable:true});
    Object.defineProperty(self,'status',{get:function(){return 200},configurable:true});
    Object.defineProperty(self,'response',{get:function(){return data},configurable:true});
    if(typeof data==='string')Object.defineProperty(self,'responseText',{get:function(){return data},configurable:true});
    if(self.onreadystatechange)self.onreadystatechange();
    if(self.onload)self.onload();
  }
  if(this.__async){setTimeout(deliver,0)}else{deliver()}
};
var _fetch=window.fetch;
window.fetch=function(url,opts){
  var u=typeof url==='string'?url:'';
  if(u&&u.startsWith(_baseOrigin))u=u.slice(_baseOrigin.length);
  if(u&&(u.startsWith('http://')||u.startsWith('https://')||u.startsWith('blob:')||u.startsWith('data:')))return _fetch.apply(this,arguments);
  var item=findEntry(u);
  if(!item)return _fetch.apply(this,arguments);
  var data=item.d;
  return Promise.resolve({ok:true,status:200,headers:new Headers(),
    text:function(){return Promise.resolve(data)},
    json:function(){return Promise.resolve(typeof data==='string'?JSON.parse(data):data)},
    arrayBuffer:function(){return Promise.resolve(item.t==='j'?new TextEncoder().encode(data).buffer:b2ab(data))}
  });
};
var _imgSet=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src')||Object.getOwnPropertyDescriptor(Image.prototype,'src');
if(_imgSet&&_imgSet.set){
  Object.defineProperty(HTMLImageElement.prototype,'src',{
    get:_imgSet.get,
    set:function(v){
      if(!v||v.startsWith('http')||v.startsWith('blob:')||v.startsWith('data:')){_imgSet.set.call(this,v);return}
      var item=findEntry(v);
      if(item&&item.t==='i'){_imgSet.set.call(this,'data:'+item.m+';base64,'+item.d)}
      else{_imgSet.set.call(this,v)}
    },enumerable:true,configurable:true
  });
}
})();
<\/script>`;

  // Inject interceptor after <body>
  html = html.replace('<body>', '<body>' + interceptor);

  // Replace external script src with inline content
  html = html.replace(/<script\s+src="([^"]+)"\s+defer="defer"\s+type="text\/javascript"><\/script>/g, (match, src) => {
    const normalizedSrc = src.replace(/\\/g, '/');
    const fp = path.join(stage4Dir, normalizedSrc);
    if (fs.existsSync(fp)) {
      let content = fs.readFileSync(fp, 'utf8');
      content = content.replace(/<(\/?)script/gi, '\\x3c$1script');
      return `<script>/* ${normalizedSrc} */\n${content}\n<\/script>`;
    }
    return match;
  });

  return html;
}

// ─── HTTP Server ───
function startServer(port = 3080) {
  const http = require('http');

  const server = http.createServer(async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', mono: isLinux }));
      return;
    }

    if (req.method === 'POST' && req.url === '/build') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const parsed = JSON.parse(body);
          const { code, className, extraFiles } = parsed;
          console.log(`[build] body=${body.length}b, code=${(code||'').length}b, extraFiles=${JSON.stringify(Object.keys(extraFiles||{}))}`);
          if (!code) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Missing "code" field' }));
            return;
          }

          const result = await buildFromCS(code, { className, extraFiles });

          if (result.ok) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              ok: true,
              buildTime: result.buildTime,
              htmlSize: result.html.length,
              htmlSizeKB: Math.round(result.html.length / 1024)
            }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: result.error }));
          }
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/build-html') {
      // Returns the actual HTML directly (for download/preview)
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { code, className, extraFiles } = JSON.parse(body);
          const result = await buildFromCS(code, { className, extraFiles });
          if (result.ok) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(result.html);
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: result.error }));
          }
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  server.listen(port, () => {
    console.log(`🚀 Linux Bridge Build Server listening on :${port}`);
    console.log(`   POST /build      — Build C# → JSON response`);
    console.log(`   POST /build-html — Build C# → HTML response`);
    console.log(`   GET  /health     — Health check`);
  });
}

module.exports = { buildFromCS, startServer };

if (require.main === module) {
  const port = parseInt(process.env.PORT || '3080');
  startServer(port);
}
