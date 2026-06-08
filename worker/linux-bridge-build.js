/**
 * Linux Bridge Build — Luna C#→JS→HTML on Linux (Mono 6.12 + msbuild)
 *
 * Minimal implementation:
 *   Input:  C# source code (GameFlowManagerMain.cs)
 *   Output: Single HTML file (playable ad)
 *
 * Base template: git clone https://github.com/soyooAiTools/luna-base-template.git
 * The worker (linux-worker-client.js) clones the base Unity project per task,
 * AI generates code into Assets/Program/Script/Manager/, then this module compiles it.
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

function ensureTmpRoot() {
  const tmpRoot = os.tmpdir();
  fs.mkdirSync(tmpRoot, { recursive: true });
  return tmpRoot;
}

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
  const { taskId = 'build', log = console.log, className = 'GameFlowManagerMain', extraFiles = {}, visualAssets = null } = opts;
  // extraFiles: { 'GFM_Tools.cs': '...code...' }
  const startTime = Date.now();

  // Create temp work directory
  const workDir = fs.mkdtempSync(path.join(ensureTmpRoot(), 'luna-build-'));
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

    // Enhanced output validation
    // Check for method definitions inside Bridge.define (Bridge.NET uses Bridge.define, not prototype)
    var methodPattern = new RegExp(className + '\.prototype\\.');
    var protoCount = (js.match(new RegExp(className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.prototype\\.', 'g')) || []).length;
    // Also count methods in Bridge.define format: "MethodName: function"
    var bridgeMethodCount = (js.match(/\b(Start|Update|CheckEventRules|ShowGuide|HandleInput|AddCompletedPhase)\s*:\s*function/g) || []).length;
    var methodCount = protoCount + bridgeMethodCount;
    if (methodCount < 3) {
      return { ok: false, error: `${className} has only ${methodCount} methods — Bridge.NET may have silently failed (expected Start/Update/CheckEventRules)` };
    }

    // Check for required method names in transpiled output
    var requiredMethods = ['Start', 'Update', 'CheckEventRules'];
    var missingMethods = requiredMethods.filter(m => !js.includes(m));
    if (missingMethods.length > 0) {
      return { ok: false, error: `Transpiled JS missing required methods: ${missingMethods.join(', ')} — Bridge.NET transpilation incomplete` };
    }

    log(`[linux-build] JS generated: ${(js.length / 1024).toFixed(0)} KB, ${methodCount} methods`, taskId);

    // 7. Assemble stage4
    log('[linux-build] Assembling stage4...', taskId);
    const stage4Dir = path.join(workDir, 'stage4');
    assembleStage4(stage4Dir, binDir, STAGE1_CACHE);

    // 8. Inject GameFlowManagerMain into iframe.html
    injectGameManager(stage4Dir, className, visualAssets);

    // 9. Patch script1.js (prevent Awake crash)
    patchScript1(stage4Dir, log, taskId);

    // 10. Convert to single HTML
    log('[linux-build] Converting to single HTML...', taskId);
    const html = convertToSingleHTML(stage4Dir);

    // Validate HTML output size
    var htmlSizeMB = html.length / (1024 * 1024);
    if (htmlSizeMB > 25) {
      return { ok: false, error: `HTML output too large (${htmlSizeMB.toFixed(1)}MB > 25MB limit) — check asset bundling` };
    }

    const totalTime = Math.floor((Date.now() - startTime) / 1000);
    log(`[linux-build] ✅ Build complete in ${totalTime}s, HTML: ${(html.length / 1024).toFixed(0)} KB`, taskId);

    return { ok: true, html, buildTime: totalTime };

  } finally {
    // Cleanup temp dir
    // DEBUG: keep temp dir
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) {}
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
// Luna 7.1.0 format: single engine/scripts.js contains everything (Deserializers + engine + runtime)
// Template from Windows jake project:build → LunaTemp/stage4/develop/
// Build: template engine/scripts.js + compiled UnityScriptsCompiler.js → final engine/scripts.js
// index.html is the entry point (renamed to iframe.html for downstream compatibility)
const STAGE4_TEMPLATE = isLinux ? '/opt/luna/stage4-template' : path.join(__dirname, '..', 'stage4-from-nick', 'stage4', 'develop');

function assembleStage4(stage4Dir, binDir, stage1Cache) {
  fs.mkdirSync(stage4Dir, { recursive: true });
  fs.mkdirSync(path.join(stage4Dir, 'engine'), { recursive: true });

  if (!fs.existsSync(STAGE4_TEMPLATE)) {
    throw new Error('stage4-template not found at ' + STAGE4_TEMPLATE);
  }

  const cpDir = (s, d) => {
    fs.mkdirSync(d, { recursive: true });
    for (const e of fs.readdirSync(s, { withFileTypes: true })) {
      const a = path.join(s, e.name), b = path.join(d, e.name);
      if (e.isDirectory()) cpDir(a, b); else fs.copyFileSync(a, b);
    }
  };

  // Copy index.html as iframe.html (7.1.0 uses index.html, downstream expects iframe.html)
  const indexSrc = path.join(STAGE4_TEMPLATE, 'index.html');
  const iframeSrc = path.join(STAGE4_TEMPLATE, 'iframe.html');
  if (fs.existsSync(indexSrc)) {
    fs.copyFileSync(indexSrc, path.join(stage4Dir, 'iframe.html'));
  } else if (fs.existsSync(iframeSrc)) {
    fs.copyFileSync(iframeSrc, path.join(stage4Dir, 'iframe.html'));
  }
  // Copy luna.json
  const lunaJsonSrc = path.join(STAGE4_TEMPLATE, 'luna.json');
  if (fs.existsSync(lunaJsonSrc)) {
    fs.copyFileSync(lunaJsonSrc, path.join(stage4Dir, 'luna.json'));
  }

  // Copy asset/resource directories needed by Luna runtime
  // 7.1.0 dirs: assets, cache, resources  (6.x had: assets, js, static, favicon)
  for (const dir of ['assets', 'cache', 'resources', 'js', 'static', 'favicon']) {
    const src = path.join(STAGE4_TEMPLATE, dir);
    if (fs.existsSync(src)) cpDir(src, path.join(stage4Dir, dir));
  }

  // Build engine/scripts.js = 7.1.0 engine (with built-in Deserializers) + compiled UnityScriptsCompiler
  const engineScripts = path.join(STAGE4_TEMPLATE, 'engine', 'scripts.js');
  const engineLegacy = path.join(STAGE4_TEMPLATE, 'engine', 'scripts-engine.js');
  const engineBase = fs.existsSync(engineScripts) ? engineScripts : engineLegacy;
  const compiled = path.join(binDir, 'UnityScriptsCompiler.js');

  if (fs.existsSync(engineBase) && fs.existsSync(compiled)) {
    let engine = fs.readFileSync(engineBase, 'utf-8');
    const userCode = fs.readFileSync(compiled, 'utf-8');
    // 7.1.0: Deserializers are built into engine/scripts.js — no separate deserializers.js needed
    // Strip stub GameFlowManagerMain from template to avoid "Class already defined"
    engine = engine.replace(
      /,?Bridge\.define\("GameFlowManagerMain",\{inherits:\[UnityEngine\.MonoBehaviour\],methods:\{Start:function\(\)\{\},Update:function\(\)\{\}\}\}\)/,
      ''
    );
    fs.writeFileSync(path.join(stage4Dir, 'engine', 'scripts.js'), engine + '\n' + userCode);
  } else if (fs.existsSync(path.join(STAGE4_TEMPLATE, 'engine', 'scripts.js'))) {
    // Fallback: copy full scripts.js from template
    fs.copyFileSync(
      path.join(STAGE4_TEMPLATE, 'engine', 'scripts.js'),
      path.join(stage4Dir, 'engine', 'scripts.js')
    );
  }
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
  const envScript = `var $environment={baseUrl:"./",resourceConfig:{json:"external",image:"external",video:"external",blob:"external",sound:"external"},packageConfig:{userId:"linux-build",version:"7.1.0"},playerPrefs:!0,forceIncludedClasses:["LunaUnity.Utils.CompressedResources","LunaUnity.Utils.ExternalResources","LunaUnity.Utils.InlineResources","LunaUnity.Utils.Network","LunaUnity.Audio.Manager","Luna.Unity.Analytics","Luna.Unity.Analytics.EventType","Luna.Unity.Analytics.Applovin","Luna.Unity.Playable","Luna.Unity.LifeCycle","Luna.Unity.HapticFeedbackType","Luna.Unity.CallbackTypes","Luna.Unity.Nucleo","Luna.Unity.Nucleo.EventTypes","Luna.Unity.TriggerTypes","Luna.Unity.BuildPlatforms","Luna.Unity.NativeShare","UnityEngine.AudioSource","UnityEngine.Debug","UnityEngine.GameObject","UnityEngine.ILogger","UnityEngine.Logger","UnityEngine.ILogHandler","UnityEngine.DebugLogHandler","UnityEngine.LogType","UnityEngine.Input","UnityEngine.Touch","UnityEngine.Cursor","UnityEngine.CursorLockMode","UnityEngine.CursorMode","UnityEngine.EventSystems.EventSystem","UnityEngine.EventSystems.ExecuteEvents","UnityEngine.EventSystems.BaseInput","UnityEngine.Object","UnityEngine.Object$1","UnityEngine.Component","UnityEngine.Component$1","UnityEngine.Behaviour$1","UnityEngine.Behaviour","UnityEngine.ColorSpace","UnityEngine.MonoBehaviour","UnityEngine.EventSystems.UIBehaviour","UnityEngine.EventSystems.BaseInputModule","UnityEngine.EventSystems.PointerInputModule","UnityEngine.EventSystems.PointerInputModule.MouseState","UnityEngine.EventSystems.PointerInputModule.ButtonState","UnityEngine.EventSystems.PointerInputModule.MouseButtonEventData","UnityEngine.EventSystems.PointerEventData","UnityEngine.EventSystems.PointerEventData.FramePressState","UnityEngine.EventSystems.StandaloneInputModule","UnityEngine.EventSystems.AbstractEventData","UnityEngine.EventSystems.BaseEventData","UnityEngine.EventSystems.AxisEventData","UnityEngine.PlayerPrefs","UnityEngine.PlayerPrefs.LocalStorageProvider","UnityEngine.PlayerPrefs.FacebookStorageProvider","UnityEngine.PlayerPrefs.IProvider","UnityEngine.LunaPlaygroundAssetAttribute","UnityEngine.LunaPlaygroundFieldArrayLengthAttribute","UnityEngine.LunaPlaygroundFieldAttribute","UnityEngine.LunaPlaygroundFieldStepAttribute","UnityEngine.LunaPlaygroundSectionAttribute","UnityEngine.EventSystems.IEventSystemHandler","UnityEngine.EventSystems.IDeselectHandler","UnityEngine.EventSystems.ISelectHandler","UnityEngine.EventSystems.IPointerExitHandler","UnityEngine.EventSystems.IPointerEnterHandler","UnityEngine.EventSystems.IPointerUpHandler","UnityEngine.EventSystems.IPointerDownHandler","UnityEngine.EventSystems.IMoveHandler","UnityEngine.UI.Selectable","UnityEngine.UI.ScrollRect","UnityEngine.UI.InputField","System.Attribute","System.Exception","System.SystemException","System.NullReferenceException","System.ArgumentException","System.ArgumentOutOfRangeException","System.AggregateException","System.Enum","System.Int32","System.IComparable","System.ICloneable","System.String","System.IAsyncResult","System.IDisposable","System.Threading.Tasks.Task","System.Threading.Tasks.TaskCompletionSource","System.Collections.ICollection","System.Collections.IDictionary","System.Collections.IEnumerable","System.Collections.IEnumerator","System.Collections.Generic.IReadOnlyCollection$1","System.Collections.Generic.IReadOnlyDictionary$2","System.Collections.Generic.IEnumerable$1","System.Collections.Generic.ICollection$1","System.Collections.Generic.KeyValuePair$2","System.Collections.Generic.IDictionary$2","System.Collections.Generic.Dictionary$2","System.Collections.Generic.IEnumerator$1","System.Collections.Generic.Dictionary$2.ValueCollection.Enumerator","System.Collections.HashHelpers","System.Collections.Generic.List$1","System.Text.RegularExpressions.Regex","System.Text.RegularExpressions.RegexEngine","System.Text.RegularExpressions.Match","System.Text.RegularExpressions.Capture","System.Text.RegularExpressions.RegexOptions","System.Text.RegularExpressions.RegexRunner","System.Text.RegularExpressions.RegexEngineParser","System.Text.RegularExpressions.RegexParser","System.Text.RegularExpressions.RegexNode","System.Text.RegularExpressions.RegexReplacement","System.Text.RegularExpressions.RegexEngineBranch","System.Text.RegularExpressions.RegexEngineState","System.Text.RegularExpressions.RegexEngineBranch","System.Text.RegularExpressions.RegexEnginePass","System.Text.RegularExpressions.RegexEngineProbe","LunaUnity.Objects.Registry","UnityEngine.Application","TMPro.TextMeshProUGUI"],targetPlatform:"develop",runtimeAnalysisModules:["physics3d","physics2d","particle_system","reflection","prefabs","mecanim-wasm"]}`;

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
function scriptSafeJson(value) {
  return JSON.stringify(value || null).replace(/<(\/?)script/gi, '\\x3c$1script');
}

function injectGameManager(stage4Dir, className, visualAssets) {
  const iframePath = path.join(stage4Dir, 'iframe.html');
  if (!fs.existsSync(iframePath)) return;

  let html = fs.readFileSync(iframePath, 'utf-8');

  // The injection script from worker-bridge-build.js (polyfills + game loop)
  const injectionScript = `<script>
window.__BLUEPRINT_VISUAL_ASSETS__ = ${scriptSafeJson(visualAssets)};
window.__fidelityReady = false;
window.__blueprintGameFlowComponent = null;
window.__blueprintResolveGameFlowComponent = null;
(function() {
  var marked = false;
  function settleThenReady() {
    if (marked || !window.__blueprintGameFlowComponent) return;
    marked = true;
    requestAnimationFrame(function() {
      requestAnimationFrame(function() {
        function markReady() { window.__fidelityReady = true; }
        var waits = [];
        if (typeof window.__blueprintWaitForFidelityState === "function") {
          waits.push(window.__blueprintWaitForFidelityState(null));
        }
        if (waits.length) {
          Promise.all(waits).then(markReady, markReady);
        } else {
          markReady();
        }
      });
    });
  }
  window.__blueprintMarkFidelityReady = settleThenReady;
  window.addEventListener("luna:postrender", settleThenReady);
  window.addEventListener("luna:started", function() { setTimeout(settleThenReady, 200); });
})();
// Force preserveDrawingBuffer for CUA/QuickPlayTest pixel reading
(function() {
  var _origGetCtx = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type, attrs) {
    if (type === 'webgl' || type === 'webgl2') {
      attrs = Object.assign(attrs || {}, { preserveDrawingBuffer: true });
    }
    return _origGetCtx.call(this, type, attrs);
  };
})();
// Apply source scene background before Unity/PlayCanvas creates its first
// skybox draw call. Later camera/CSS updates are still repeated after Start(),
// but this early path prevents RenderSettings defaults from painting the
// canvas with Luna's template blue while the bridge reports the contract color.
(function installStoryboardSceneBackgroundBootstrap() {
  function clampStoryboardColor(value, fallback) {
    var n = Number(value);
    if (!isFinite(n)) n = Number(fallback);
    if (!isFinite(n)) n = 0;
    return Math.max(0, Math.min(1, n));
  }
  function storyboardSceneBackgroundFromManifest() {
    try {
      var manifest = window.__BLUEPRINT_VISUAL_ASSETS__ || {};
      var fc = manifest.fidelityContract || {};
      var bg = fc.scene && fc.scene.backgroundColor;
      if (!Array.isArray(bg) || bg.length < 3) return null;
      return [
        clampStoryboardColor(bg[0], 0),
        clampStoryboardColor(bg[1], 0),
        clampStoryboardColor(bg[2], 0)
      ];
    } catch(e) { return null; }
  }
  function storyboardPcColor(rgb) {
    if (!rgb || typeof pc === 'undefined' || !pc.Color) return null;
    return new pc.Color(rgb[0], rgb[1], rgb[2], 1);
  }
  function storyboardCssColor(rgb) {
    return 'rgb(' + Math.round(rgb[0] * 255) + ',' + Math.round(rgb[1] * 255) + ',' + Math.round(rgb[2] * 255) + ')';
  }
  function storyboardCameraClearFlag() {
    try {
      var flags = window.UnityEngine && UnityEngine.CameraClearFlags;
      if (!flags) return 2;
      if (flags.SolidColor != null) return flags.SolidColor;
      if (flags.Color != null) return flags.Color;
      if (flags.Kr$ != null) return flags.Kr$;
      if (flags.PJ$ != null) return flags.PJ$;
    } catch(e) {}
    return 2;
  }
  function recordStoryboardSceneBackground(rgb, source) {
    if (!rgb) return;
    window.__storyboardSceneDetails = window.__storyboardSceneDetails || {};
    window.__storyboardSceneDetails.backgroundColor = rgb.slice(0, 3);
    window.__storyboardSceneDetails.source = source || 'fidelityContract.scene.backgroundColor';
  }
  window.__storyboardApplyActualSceneBackground = function(source) {
    var rgb = storyboardSceneBackgroundFromManifest();
    if (!rgb) return 0;
    var applied = 0;
    var c = storyboardPcColor(rgb);
    try {
      var css = storyboardCssColor(rgb);
      if (document && document.documentElement) document.documentElement.style.backgroundColor = css;
      if (document && document.body) document.body.style.backgroundColor = css;
      var canvas = document && (document.getElementById('application-canvas') || document.querySelector('canvas'));
      if (canvas && canvas.style) canvas.style.backgroundColor = css;
    } catch(eCss) {}
    try {
      if (window.UnityEngine && UnityEngine.RenderSettings) {
        try { UnityEngine.RenderSettings.skybox = null; applied++; } catch(eSkyProp) {}
        try { if (typeof UnityEngine.RenderSettings.setskybox === 'function') UnityEngine.RenderSettings.setskybox(null); } catch(eSkySet) {}
        if (c) {
          try { UnityEngine.RenderSettings.ambientLight = c; } catch(eAmb) {}
          try { UnityEngine.RenderSettings.ambientSkyColor = c; } catch(eAmbSky) {}
          try { UnityEngine.RenderSettings.ambientGroundColor = c; } catch(eAmbGround) {}
          try { UnityEngine.RenderSettings.ambientEquatorColor = c; } catch(eAmbEq) {}
        }
      }
    } catch(eRenderSettings) {}
    try {
      var mainCam = window.UnityEngine && UnityEngine.Camera && UnityEngine.Camera.main;
      if (mainCam && c) {
        mainCam.backgroundColor = c;
        mainCam.clearFlags = storyboardCameraClearFlag();
        applied++;
      }
    } catch(eMainCam) {}
    try {
      var pcApp = (window.app && window.app.app) ||
        (window.pc && window.pc.Application && typeof window.pc.Application.getApplication === 'function' && window.pc.Application.getApplication()) || null;
      if (pcApp && pcApp.scene && pcApp.scene.skybox) {
        try { pcApp.scene.skybox.isVisible = false; applied++; } catch(eSkyVisible) {}
        try {
          var mi = pcApp.scene.skybox._meshInstance || (pcApp.scene.skybox.meshInstance ? pcApp.scene.skybox.meshInstance : null);
          if (mi) {
            mi.visible = false;
            mi.cull = true;
            if (mi.node) mi.node.enabled = false;
          }
        } catch(eSkyMi) {}
      }
      if (pcApp && pcApp.graphicsDevice && c) {
        try { pcApp.graphicsDevice.setClearColor(c.r, c.g, c.b, 1); applied++; } catch(eGd) {}
      }
      if (pcApp && pcApp.root && c) {
        try {
          (function walkCamera(node) {
            if (!node) return;
            if (node.camera) {
              try { node.camera.clearColor = c; } catch(ePcCamColor) {}
              try { node.camera.clearColorBuffer = true; } catch(ePcCamColorBuffer) {}
              try { node.camera.clearDepthBuffer = true; } catch(ePcCamDepthBuffer) {}
              try { node.camera.clearFlags = storyboardCameraClearFlag(); } catch(ePcCamFlags) {}
              applied++;
            }
            var children = node.children || node._children || [];
            for (var i = 0; i < children.length; i++) walkCamera(children[i]);
          })(pcApp.root);
        } catch(eWalkCamera) {}
      }
    } catch(ePc) {}
    recordStoryboardSceneBackground(rgb, source);
    return applied;
  };
  window.addEventListener("luna:starting", function() {
    try { window.__storyboardApplyActualSceneBackground('luna-starting'); } catch(e) {}
  });
})();
// Fallback: if the standalone preview never receives a platform start event,
// trigger Luna's normal start path instead of calling startGame() directly.
// Direct startGame() bypasses dependency waits (Box2D/Mecanim) and can leave
// the public preview stuck with a partially initialized engine.
(function() {
  var _sgAttempts = 0;
  var _sgTimer = null;
  function _isInsideIframe() {
    try { return window.self !== window.top; } catch(e) { return true; }
  }
  function _dispatchStandaloneStart() {
    if (typeof window.app === 'undefined') {
      if (typeof window.startGame !== 'function') {
        _sgAttempts++;
        if (_sgAttempts < 240) {
          _sgTimer = setTimeout(_dispatchStandaloneStart, 500);
        } else {
          console.error("[AI] preview start fallback — startGame unavailable");
        }
        return;
      }
      console.log("[AI] preview start fallback — dispatching luna:start");
      try {
        window.dispatchEvent(new Event("luna:build"));
        window.dispatchEvent(new Event("luna:start"));
        window.dispatchEvent(new Event("playground:started"));
      } catch(e) { console.error("[AI] luna:start fallback error:", e); }
    }
  }
  window.addEventListener("luna:ready", function() {
    if (!_isInsideIframe()) setTimeout(_dispatchStandaloneStart, 0);
  });
  _sgTimer = setTimeout(_dispatchStandaloneStart, 1000);
  // Cancel timer if app is created normally
  var _origDesc = Object.getOwnPropertyDescriptor(window, 'app');
  if (!_origDesc || !_origDesc.get) {
    var _appVal;
    Object.defineProperty(window, 'app', {
      get: function() { return _appVal; },
      set: function(v) { _appVal = v; clearTimeout(_sgTimer); },
      configurable: true
    });
  }
})();
window.addEventListener("luna:starting", function() {
  try {
    // [L0 font fix] Load DroidSansFallback (CJK-capable) and patch Resources.Load<Font>("DefaultFont").
    // Build pipeline ships /resources/DefaultFont.ttf via fileDict; FontFace API registers it under
    // the family name "DefaultFont" so PlayCanvas/Unity Text can find it.
    (function loadDefaultFont() {
      try {
        if (typeof FontFace !== "function" || !document.fonts) return;
        fetch("./resources/DefaultFont.ttf").then(function(r) {
          if (!r || !r.ok) throw new Error("font fetch failed");
          return r.arrayBuffer();
        }).then(function(buf) {
          var ff = new FontFace("DefaultFont", buf);
          return ff.load().then(function(loaded) { document.fonts.add(loaded); });
        }).then(function() {
          console.log("[font] DefaultFont (CJK) registered to document.fonts");
        }).catch(function(e) {
          console.warn("[font] DefaultFont load failed:", e && e.message ? e.message : e);
        });
      } catch (e) { console.warn("[font] FontFace init error:", e); }
    })();
    // Patch Resources.Load and Resources.Load$1 to satisfy GFM_UI's Resources.Load<Font>("DefaultFont").
    (function patchResourcesLoadFont() {
      try {
        if (!window.UnityEngine || !UnityEngine.Resources) return;
        function makeFont() {
          try {
            if (typeof Font !== "undefined" && Font.CreateDynamicFontFromOSFont) {
              return Font.CreateDynamicFontFromOSFont("DefaultFont", 16);
            }
            if (UnityEngine.Font && UnityEngine.Font.CreateDynamicFontFromOSFont) {
              return UnityEngine.Font.CreateDynamicFontFromOSFont("DefaultFont", 16);
            }
          } catch(e) {}
          return null;
        }
        ["Load", "Load$1"].forEach(function(k) {
          var orig = UnityEngine.Resources[k];
          if (typeof orig !== "function") return;
          UnityEngine.Resources[k] = function(name) {
            if (name === "DefaultFont") {
              var f = makeFont();
              if (f) return f;
            }
            try { return orig.apply(this, arguments); } catch(e) { return null; }
          };
        });
      } catch (e) { console.warn("[font] Resources.Load patch error:", e); }
    })();
    // [L0 path C] DOM text overlay — Luna 引擎不支持运行时字体烘焙;
    // 把每个 UnityEngine.UI.Text 镜像到一个 <div>(font-family:DefaultFont),
    // 用 element.canvasCorners 推出屏幕坐标,逐帧同步位置/字号/可见性.
    (function setupDomTextOverlay() {
      try {
        function pickCanvas() { return document.querySelector("canvas"); }
        var canvasEl = pickCanvas();
        if (!canvasEl) {
          var attempts = 0;
          var iv = setInterval(function(){
            canvasEl = pickCanvas();
            if (canvasEl) { clearInterval(iv); install(); }
            else if (++attempts > 50) clearInterval(iv);
          }, 200);
          return;
        }
        install();
        function install() {
          var overlay = document.createElement("div");
          overlay.id = "__bp_text_overlay";
          overlay.style.cssText = "position:fixed;left:0;top:0;pointer-events:none;z-index:9999;font-family:'DefaultFont',sans-serif;color:#fff;";
          document.body.appendChild(overlay);
          var mirrors = new Map();
          window.__bpTextMirrors = mirrors;
          function ensureDom(inst) {
            var rec = mirrors.get(inst);
            if (rec) return rec;
            var dom = document.createElement("div");
            dom.style.cssText = "position:absolute;white-space:pre;text-align:center;line-height:1.1;transform:translate(-50%,-50%);text-shadow:0 0 4px #000,0 0 4px #000;display:none;";
            overlay.appendChild(dom);
            rec = { dom: dom, lastText: "", lastUpdate: 0, isScreenOverlay: false };
            mirrors.set(inst, rec);
            return rec;
          }
          var T = window.UnityEngine && UnityEngine.UI && UnityEngine.UI.Text;
          if (T && T.prototype && !T.prototype.__bpDomTextV1) {
            var proto = T.prototype;
            var d = Object.getOwnPropertyDescriptor(proto, "text");
            if (d && d.set) {
              proto.__bpDomTextV1 = true;
              var origSet = d.set, origGet = d.get;
              Object.defineProperty(proto, "text", {
                configurable: true, enumerable: d.enumerable,
                get: origGet,
                set: function(v) {
                  try { origSet.call(this, v); } catch(e) {}
                  try {
                    var rec = ensureDom(this);
                    var newText = v == null ? "" : String(v);
                    if (newText !== rec.lastText) rec.lastUpdate = Date.now();
                    rec.lastText = newText;
                    rec.dom.textContent = newText;
                  } catch(e) {}
                }
              });
            }
          }
          // Camera lookup — DO NOT cache (AI_Camera is added at runtime AFTER Main Camera;
          // any sticky cache locks us to whichever cam existed at first frame).
          // Walk every frame; cheap on small scenes.
          function getCam() {
            try {
              var pcApp = (window.pc && window.pc.Application && window.pc.Application.getApplication) ? window.pc.Application.getApplication() : null;
              if (!pcApp || !pcApp.root) return null;
              var best = null;
              function walk(n, d) {
                if (d > 6 || !n) return;
                if (n.camera && n.enabled && n.camera.enabled && typeof n.camera.worldToScreen === "function") {
                  if (!best || (n.camera.priority || 0) > (best.priority || 0)) best = n.camera;
                }
                var cs = n.children || [];
                for (var i = 0; i < cs.length; i++) walk(cs[i], d + 1);
              }
              walk(pcApp.root, 0);
              return best;
            } catch(e) { return null; }
          }
          // Detect screen-space-overlay UI (canvas-anchored).
          // Luna's screen component exposes _screenType="screen" for ScreenSpaceOverlay
          // (the standard PlayCanvas .screenSpace getter is not always present here).
          function getScreenComp(el) {
            try { return el.screen || (typeof el._findScreen === "function" ? el._findScreen() : null); } catch(e) { return null; }
          }
          function isScreenSpaceOverlay(el) {
            var s = getScreenComp(el);
            if (!s || !s.screen) return false;
            if (s.screen.screenSpace === true) return true;
            if (s.screen._screenType === "screen") return true;
            return false;
          }
          function frame() {
            try {
              var rect = canvasEl.getBoundingClientRect();
              overlay.style.left = rect.left + "px";
              overlay.style.top = rect.top + "px";
              overlay.style.width = rect.width + "px";
              overlay.style.height = rect.height + "px";
              var cam = getCam();
              if (!cam) { requestAnimationFrame(frame); return; }
              var canvasW = canvasEl.width || rect.width;
              var canvasH = canvasEl.height || rect.height;
              var sxDom = rect.width / canvasW, syDom = rect.height / canvasH;
              // Pass 1: position + visibility per Unity props.
              // Track newest screen-overlay update timestamp so we can suppress stale ones.
              var newestOverlayTs = 0;
              mirrors.forEach(function(rec, inst) {
                try {
                  var handle = inst.handle, entity = handle && handle.entity;
                  var element = entity && entity.element;
                  if (!element || !rec.lastText) { rec.dom.style.display = "none"; return; }
                  // Parent visibility check (entity.enabled + Unity gameObject._activeSelf)
                  var p = entity, hidden = false;
                  while (p) {
                    if (p.enabled === false) { hidden = true; break; }
                    if (p._activeSelf === false) { hidden = true; break; }
                    p = p.parent;
                  }
                  if (hidden) { rec.dom.style.display = "none"; return; }
                  if (element.enabled === false) { rec.dom.style.display = "none"; return; }
                  // Branch by canvas type
                  if (isScreenSpaceOverlay(element)) {
                    var screenComp = getScreenComp(element);
                    var refRes = screenComp && screenComp.screen && screenComp.screen.referenceResolution;
                    if (!refRes) { rec.dom.style.display = "none"; return; }
                    var ap = element._anchoredPosition;
                    var ax = ap ? ap.x : 0, ay = ap ? ap.y : 0;
                    var sX = rect.width / refRes.x, sY = rect.height / refRes.y;
                    var domX = (refRes.x / 2 + ax) * sX;
                    var domY = (refRes.y / 2 - ay) * sY;
                    if (domX < -200 || domX > rect.width + 200 || domY < -200 || domY > rect.height + 200) {
                      rec.dom.style.display = "none"; return;
                    }
                    rec.dom.style.left = domX + "px";
                    rec.dom.style.top = domY + "px";
                    var fs2 = element.fontSize || 28;
                    rec.dom.style.fontSize = Math.max(14, Math.min(56, fs2 * sX)) + "px";
                    rec.dom.style.display = "";
                    rec.isScreenOverlay = true;
                    if (rec.lastUpdate > newestOverlayTs) newestOverlayTs = rec.lastUpdate;
                    return;
                  }
                  // World-space path
                  rec.isScreenOverlay = false;
                  if (entity.enabled === false) { rec.dom.style.display = "none"; return; }
                  var wp = entity.getPosition();
                  if (!wp) { rec.dom.style.display = "none"; return; }
                  var sp = cam.worldToScreen(wp);
                  if (!sp || sp.z < 0) { rec.dom.style.display = "none"; return; }
                  var domXw = sp.x * sxDom;
                  var domYw = (rect.height - sp.y) * syDom;
                  if (domXw < -200 || domXw > rect.width + 200 || domYw < -200 || domYw > rect.height + 200) {
                    rec.dom.style.display = "none"; return;
                  }
                  rec.dom.style.left = domXw + "px";
                  rec.dom.style.top = domYw + "px";
                  var fs = element.fontSize || 22;
                  rec.dom.style.fontSize = Math.max(12, Math.min(48, fs)) + "px";
                  rec.dom.style.display = "";
                } catch(e) {}
              });
              // Pass 2: hide stale screen-overlay mirrors. Pool-allocated UI texts in this
              // pipeline never get SetActive(false), so old phase prompts pile up. If a newer
              // overlay text exists in the same canvas, anything older than that-by-2s is stale.
              if (newestOverlayTs > 0) {
                var staleCutoff = newestOverlayTs - 2000;
                mirrors.forEach(function(rec) {
                  if (!rec.isScreenOverlay) return;
                  if (rec.dom.style.display === "none") return;
                  if (rec.lastUpdate < staleCutoff) rec.dom.style.display = "none";
                });
              }
              // Pass 3: dedup overlapping mirrors.
              //  - Screen overlays: bucket BY POSITION ONLY. UI slots like guideText/
              //    scoreText are pool-cloned across multiple GameFlowManager instances;
              //    each may write a DIFFERENT text per frame, but only the newest write
              //    represents the live game state. Keep the freshest, hide the rest.
              //  - World-space labels: bucket by lastText+position so two different
              //    entity labels passing through the same screen pixel are both shown,
              //    but pool-clones with the same label collapse into one.
              var groups = {};
              mirrors.forEach(function(rec) {
                if (rec.dom.style.display === "none") return;
                if (!rec.lastText) return;
                var l = parseFloat(rec.dom.style.left) || 0;
                var t = parseFloat(rec.dom.style.top) || 0;
                var key;
                if (rec.isScreenOverlay) {
                  // Tighter bucket for overlays — UI anchors are pixel-precise.
                  key = "OVL@" + Math.floor(l / 40) + "," + Math.floor(t / 40);
                } else {
                  var normText = rec.lastText.replace(/\\d+/g, "#");
                  key = "WS@" + normText + "@" + Math.floor(l / 80) + "," + Math.floor(t / 80);
                }
                var prev = groups[key];
                if (!prev) { groups[key] = rec; return; }
                if (rec.lastUpdate >= prev.lastUpdate) {
                  prev.dom.style.display = "none";
                  groups[key] = rec;
                } else {
                  rec.dom.style.display = "none";
                }
              });
            } catch(e) {}
            requestAnimationFrame(frame);
          }
          requestAnimationFrame(frame);
          console.log("[font] DOM text overlay installed");
        }
      } catch(e) { console.warn("[font] DOM overlay setup failed:", e && e.message); }
    })();

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
    var _cachedURPShader = null;
    UnityEngine.Shader.Find = function(name) {
      var s = origShaderFind(name);
      if (!s) {
        // UI/Default doesn't exist in our template — always fallback to URP/Lit
        if (!_cachedURPShader) _cachedURPShader = origShaderFind("Universal Render Pipeline/Lit");
        s = _cachedURPShader;
      }
      return s;
    };
    function patchUiTextStyleGuard() {
      try {
        if (!window.UnityEngine || !UnityEngine.UI || !UnityEngine.UI.Text) return;
        var proto = UnityEngine.UI.Text.prototype;
        if (!proto || proto.__blueprintTextGuardV1) return;
        var originalApply = proto.ApplyFontDataChanges;
        if (typeof originalApply !== "function") return;
        proto.__blueprintTextGuardV1 = true;
        proto.ApplyFontDataChanges = function() {
          try {
            var element = this && this.handle && this.handle.entity && this.handle.entity.element;
            if (!element || !element._text) return;
            return originalApply.apply(this, arguments);
          } catch(e) {
            return;
          }
        };
      } catch(e) {}
    }
    patchUiTextStyleGuard();
    setTimeout(patchUiTextStyleGuard, 0);
    setTimeout(patchUiTextStyleGuard, 1000);
    window.addEventListener("error", function(evt) {
      if (evt && evt.message && (evt.message.indexOf("Awake()") >= 0 || evt.message.indexOf("OnEnable()") >= 0)) {
        evt.preventDefault(); return true;
      }
    });
    console.log("[AI] Polyfills installed");
  } catch(e) { console.error("[AI] Polyfill error:", e); }
});
window.addEventListener("luna:startup:shaderReady", function() { setTimeout(function() {
  try {
    // Color pool objects are pre-baked in Unity — no runtime SetColor patching needed
    console.log("[AI] Using pre-baked color pool objects");
    var go = new UnityEngine.GameObject.ctor("GameManager");
    var comp = go.AddComponent(${className});
    if (comp && comp.Start) { try { comp.Start(); } catch(se) { console.error("[AI] Start() error:", se); } }
    window.__blueprintGameFlowComponent = comp || null;


    // Post-Start fixes using PlayCanvas native API
    (function() {
      var pcApp = window.app && window.app.app;
      if (!pcApp || !pcApp.root) return;
      
      // BUG-0012 fix removed — pre-baked color pool objects eliminate texture sampler mismatch


      // 0. Fix null shaders (MUST run before color override)
      function fixNullShaders() {
        try {
          var fixShader = UnityEngine.Shader.Find("Universal Render Pipeline/Lit") || UnityEngine.Shader.Find("Standard");
          if (fixShader) {
            if (typeof GFM_Create !== 'undefined' && GFM_Create._baseMat && !GFM_Create._baseMat.shader) {
              GFM_Create._baseMat = new UnityEngine.Material.$ctor2(fixShader);
              GFM_Create._baseMat.color = new pc.Color(1, 1, 1, 1);
              console.log("[AI] Fixed GFM_Create._baseMat shader");
            }
            var allRoots = UnityEngine.SceneManagement.SceneManager.GetActiveScene().getRootGameObjects();
            var shaderFixed = 0;
            for (var ri = 0; ri < allRoots.length; ri++) {
              var rObj = allRoots[ri];
              var rr = rObj.GetComponent(UnityEngine.MeshRenderer);
              if (rr && UnityEngine.Component.op_Inequality(rr, null) && rr.material && !rr.material.shader) {
                var origColor = rr.material.color || new pc.Color(1, 1, 1, 1);
                var fixMat = new UnityEngine.Material.$ctor2(fixShader);
                fixMat.color = new pc.Color(origColor.r, origColor.g, origColor.b, origColor.a || 1);
                rr.material = fixMat;
                shaderFixed++;
              }
            }
            if (shaderFixed > 0) console.log("[AI] Fixed " + shaderFixed + " materials with URP/Lit shader");
          }
        } catch(shErr) { console.error("[AI] Shader fix error:", shErr); }
      }
      fixNullShaders(); // Run immediately after Start() — don't wait for timers
      setTimeout(fixNullShaders, 2000); // Re-run as safety net
      setTimeout(fixNullShaders, 5000);

      function clampStoryboardColor(value, fallback) {
        var n = Number(value);
        if (!isFinite(n)) n = Number(fallback);
        if (!isFinite(n)) n = 0;
        return Math.max(0, Math.min(1, n));
      }
      function storyboardRgbFromHex(hex, fallback) {
        var text = String(hex || fallback || '#000000').replace('#', '');
        if (!/^[0-9a-f]{6}$/i.test(text)) text = '000000';
        return [
          parseInt(text.slice(0, 2), 16) / 255,
          parseInt(text.slice(2, 4), 16) / 255,
          parseInt(text.slice(4, 6), 16) / 255
        ];
      }
      function storyboardSceneBackground() {
        try {
          var manifest = window.__BLUEPRINT_VISUAL_ASSETS__ || {};
          var fc = manifest.fidelityContract || {};
          var bg = fc.scene && fc.scene.backgroundColor;
          if (Array.isArray(bg) && bg.length >= 3) {
            return [
              clampStoryboardColor(bg[0], 0),
              clampStoryboardColor(bg[1], 0),
              clampStoryboardColor(bg[2], 0)
            ];
          }
          var sceneContract = manifest.sourceSceneContract || {};
          if (sceneContract.backgroundColor) return storyboardRgbFromHex(sceneContract.backgroundColor, null);
        } catch(e) {}
        return null;
      }
      var __bpVisualManifest = window.__BLUEPRINT_VISUAL_ASSETS__ || {};
      var __bpHasSourceVisualAssets = !!(__bpVisualManifest && (
        __bpVisualManifest.sourceEntityContract ||
        __bpVisualManifest.sourcePhaseContract ||
        __bpVisualManifest.fidelityContract
      ));
      window.__bpHasSourceVisualAssets = __bpHasSourceVisualAssets;
      var contractSceneBackground = storyboardSceneBackground();
      function storyboardPcColor(rgb) {
        return new pc.Color(rgb[0], rgb[1], rgb[2], 1);
      }
      function storyboardCssColor(rgb) {
        return 'rgb(' + Math.round(rgb[0] * 255) + ',' + Math.round(rgb[1] * 255) + ',' + Math.round(rgb[2] * 255) + ')';
      }
      function recordStoryboardSceneBackground(rgb, source) {
        if (!rgb) return;
        window.__storyboardSceneDetails = window.__storyboardSceneDetails || {};
        window.__storyboardSceneDetails.backgroundColor = rgb.slice(0, 3);
        window.__storyboardSceneDetails.source = source || 'fidelityContract.scene.backgroundColor';
      }
      function setCameraClearColor(cam, rgb) {
        if (!cam || !rgb) return false;
        var c = storyboardPcColor(rgb);
        try { cam.clearColor = c; } catch(e0) {}
        try { cam.clearColorBuffer = true; } catch(e1) {}
        return true;
      }
      function applyStoryboardSceneBackground(source) {
        if (!contractSceneBackground) return 0;
        var applied = 0;
        try {
          var css = storyboardCssColor(contractSceneBackground);
          if (document && document.documentElement) document.documentElement.style.backgroundColor = css;
          if (document && document.body) document.body.style.backgroundColor = css;
          var canvas = document && (document.getElementById('application-canvas') || document.querySelector('canvas'));
          if (canvas && canvas.style) canvas.style.backgroundColor = css;
        } catch(eCss) {}
        try {
          if (typeof window.__storyboardApplyActualSceneBackground === 'function') {
            applied += window.__storyboardApplyActualSceneBackground(source || 'fidelityContract.scene.backgroundColor');
          }
        } catch(eActual) {}
        try {
          if (camEnt && camEnt.camera && setCameraClearColor(camEnt.camera, contractSceneBackground)) applied++;
        } catch(eCam) {}
        try {
          var mainCam = UnityEngine.Camera.main;
          if (mainCam) {
            mainCam.backgroundColor = storyboardPcColor(contractSceneBackground);
            if (UnityEngine.CameraClearFlags && UnityEngine.CameraClearFlags.SolidColor != null) {
              mainCam.clearFlags = UnityEngine.CameraClearFlags.SolidColor;
            }
            applied++;
          }
        } catch(eUnityCam) {}
        try {
          if (pcApp && pcApp.scene && pcApp.scene.activeCamera && setCameraClearColor(pcApp.scene.activeCamera, contractSceneBackground)) applied++;
        } catch(eSceneCam) {}
        try {
          if (pcApp && pcApp.root) {
            (function walk(node) {
              if (!node) return;
              if (node.camera && setCameraClearColor(node.camera, contractSceneBackground)) applied++;
              var children = node.children || node._children || [];
              for (var i = 0; i < children.length; i++) walk(children[i]);
            })(pcApp.root);
          }
        } catch(eWalk) {}
        recordStoryboardSceneBackground(contractSceneBackground, source);
        return applied;
      }
      
      // 1. Always create camera + light (scene ones don't survive Start clean-up)
      console.log("[AI] Creating PlayCanvas camera + light");
      var camEnt = new pc.Entity("AI_Camera");
      pcApp.root.addChild(camEnt);
      camEnt.addComponent("camera", {
        clearColor: contractSceneBackground ? storyboardPcColor(contractSceneBackground) : new pc.Color(0.6, 0.8, 1.0),
        clearColorBuffer: true,
        projection: 1,
        orthoHeight: 10,
        nearClip: 0.1,
        farClip: 1000,
        priority: __bpHasSourceVisualAssets ? -100 : 100
      });
      camEnt.setPosition(0, 15, -8);
      camEnt.setEulerAngles(55, 0, 0);
      function syncStoryboardSourceCamera() {
        try {
          if (!camEnt || !camEnt.camera) return;
          var sourceScene = __bpVisualManifest && __bpVisualManifest.sourceSceneContract || {};
          var sourceCamera = sourceScene && sourceScene.camera || {};
          var sourcePosition = Array.isArray(sourceCamera.position) ? sourceCamera.position : [0, 22, 22];
          var sourceLookAt = Array.isArray(sourceCamera.lookAt) ? sourceCamera.lookAt : null;
          camEnt.camera.projection = 0;
          camEnt.camera.fov = isFinite(Number(sourceCamera.fov)) ? Number(sourceCamera.fov) : 60;
          camEnt.camera.nearClip = isFinite(Number(sourceCamera.near)) ? Number(sourceCamera.near) : 0.1;
          camEnt.camera.farClip = isFinite(Number(sourceCamera.far)) ? Number(sourceCamera.far) : 1000;
          camEnt.setPosition(Number(sourcePosition[0]) || 0, Number(sourcePosition[1]) || 22, Number(sourcePosition[2]) || 22);
          if (sourceLookAt) camEnt.lookAt(Number(sourceLookAt[0]) || 0, Number(sourceLookAt[1]) || 0, Number(sourceLookAt[2]) || 0);
          else camEnt.setEulerAngles(45, 180, 0);
        } catch(eSourceCam) {}
      }
      if (__bpHasSourceVisualAssets) syncStoryboardSourceCamera();
      // Sync AI_Camera with AI code's Camera.main settings after Start()
      setTimeout(function() {
        try {
          if (__bpHasSourceVisualAssets) {
            console.log("Camera sync skipped: storyboard source framing owns AI_Camera");
            return;
          }
          var mainCam = UnityEngine.Camera.main;
          if (mainCam) {
            var t = mainCam.transform;
            if (t) {
              var p = t.position;
              if (p) camEnt.setPosition(p.x, p.y, p.z);
              var euler = t.eulerAngles;
              if (euler) camEnt.setEulerAngles(euler.x, euler.y, euler.z);
            }
            // Sync ortho/perspective
            if (mainCam.orthographic) {
              camEnt.camera.projection = 1; // ortho
              camEnt.camera.orthoHeight = mainCam.orthographicSize;
            } else {
              camEnt.camera.projection = 0; // perspective
              if (mainCam.fieldOfView) camEnt.camera.fov = mainCam.fieldOfView;
            }
            // Sync clear color
            if (contractSceneBackground) applyStoryboardSceneBackground('post-camera-sync');
            var bg = contractSceneBackground ? storyboardPcColor(contractSceneBackground) : mainCam.backgroundColor;
            if (bg) camEnt.camera.clearColor = new pc.Color(bg.r, bg.g, bg.b, bg.a || 1);
            console.log("[AI] Camera synced: ortho=" + mainCam.orthographicSize + " bg=" + (bg ? bg.r.toFixed(2)+","+bg.g.toFixed(2)+","+bg.b.toFixed(2) : "?"));
          }
        } catch(camErr) { console.error("[AI] Camera sync error:", camErr); }
      }, 500);
      var lightEnt = new pc.Entity("AI_Light");
      pcApp.root.addChild(lightEnt);
      lightEnt.addComponent("light", {
        type: "directional",
        color: new pc.Color(1, 0.95, 0.85),
        intensity: 1.0
      });
      lightEnt.setEulerAngles(50, -30, 0);

      function blueprintNormalizePhaseKey(value) {
        return String(value == null ? '' : value).toLowerCase().replace(/[^a-z0-9]/g, '');
      }
      function blueprintPhaseSets(manifest) {
        var phaseSets = [];
        try {
          ['sourcePhaseContract', 'fidelityContract', 'sourceFidelityContract', 'contract'].forEach(function(key) {
            if (manifest && manifest[key] && Array.isArray(manifest[key].phases) && manifest[key].phases.length) phaseSets.push(manifest[key].phases);
          });
        } catch(e) {}
        return phaseSets;
      }
      function blueprintCompletedPhaseCount(gs) {
        try {
          if (!gs || typeof gs !== 'object') return 0;
          if (isFinite(Number(gs.completedPhaseCount))) return Math.max(0, Math.floor(Number(gs.completedPhaseCount)));
          var completed = gs.completedPhases || gs.completed_phases || gs.completed;
          if (Array.isArray(completed)) {
            var count = 0;
            for (var i = 0; i < completed.length; i++) {
              if (completed[i] != null && String(completed[i]) !== '') count++;
            }
            return count;
          }
          if (completed && typeof completed === 'object') {
            var keys = Object.keys(completed);
            var n = 0;
            for (var k = 0; k < keys.length; k++) {
              if (completed[keys[k]]) n++;
            }
            return n;
          }
        } catch(e) {}
        return 0;
      }
      function blueprintRuntimePhaseIndex(gs, phaseId) {
        try {
          var key = blueprintNormalizePhaseKey(phaseId);
          if (!key || !gs || typeof gs !== 'object') return -1;
          var stamps = gs.phaseTimestamps || gs.phase_timestamps;
          if (stamps && typeof stamps === 'object') {
            var stampKeys = Object.keys(stamps);
            for (var si = 0; si < stampKeys.length; si++) {
              if (blueprintNormalizePhaseKey(stampKeys[si]) === key) return si;
            }
          }
          var evidence = gs.phaseEvidence || gs.phase_evidence;
          if (evidence && typeof evidence === 'object') {
            var evidenceKeys = Object.keys(evidence);
            for (var ei = 0; ei < evidenceKeys.length; ei++) {
              if (blueprintNormalizePhaseKey(evidenceKeys[ei]) === key) return ei;
            }
          }
          var completed = gs.completedPhases || gs.completed_phases || gs.completed;
          if (Array.isArray(completed)) {
            for (var ci = 0; ci < completed.length; ci++) {
              if (blueprintNormalizePhaseKey(completed[ci]) === key) return ci;
            }
          }
        } catch(e) {}
        return -1;
      }
      function blueprintPhaseMatches(phase, phaseKey) {
        if (!phase || !phaseKey) return false;
        var fields = ['id', 'phaseId', 'name', 'title', 'label'];
        for (var i = 0; i < fields.length; i++) {
          if (blueprintNormalizePhaseKey(phase[fields[i]]) === phaseKey) return true;
        }
        var aliases = phase.aliases || phase.runtimeIds || phase.runtimePhaseIds;
        if (Array.isArray(aliases)) {
          for (var ai = 0; ai < aliases.length; ai++) {
            if (blueprintNormalizePhaseKey(aliases[ai]) === phaseKey) return true;
          }
        }
        return false;
      }
      function blueprintRuntimePhaseIdsFromComponent(loopComp) {
        var ids = [];
        try {
          if (!loopComp || typeof loopComp !== 'object') return ids;
          var gs = null;
          try { gs = typeof window.__gameState === 'function' ? window.__gameState() : window.__gameState; } catch(eState) {}
          var stamps = gs && (gs.phaseTimestamps || gs.phase_timestamps);
          if (stamps && typeof stamps === 'object') {
            Object.keys(stamps).forEach(function(k) {
              if (k && typeof loopComp["Phase_" + phaseMethodSuffix(k) + "_Init"] === 'function' && ids.indexOf(k) < 0) ids.push(k);
            });
            if (ids.length) return ids;
          }
          Object.keys(loopComp).forEach(function(k) {
            var m = k.match(/^Phase_(.+)_Init$/);
            if (m && m[1] && ids.indexOf(m[1]) < 0) ids.push(m[1]);
          });
          var orderHints = ['initialguidance', 'sellwaterupgradeweapon', 'unlockplantsellapple', 'guidedownload'];
          ids.sort(function(a, b) {
            var ak = phaseSortKey(a, 0), bk = phaseSortKey(b, 0);
            if (ak !== bk) return ak - bk;
            var ai = orderHints.indexOf(blueprintNormalizePhaseKey(a));
            var bi = orderHints.indexOf(blueprintNormalizePhaseKey(b));
            if (ai >= 0 || bi >= 0) return (ai >= 0 ? ai : 9999) - (bi >= 0 ? bi : 9999);
            return String(a).localeCompare(String(b));
          });
        } catch(e) {}
        return ids;
      }
      function blueprintSourcePhaseAliasesFromRuntime(loopComp) {
        var aliases = {};
        try {
          var runtimeIds = blueprintRuntimePhaseIdsFromComponent(loopComp);
          if (!runtimeIds.length) return aliases;
          var va = window.__BLUEPRINT_VISUAL_ASSETS__ || {};
          var phases = va.sourcePhaseContract && va.sourcePhaseContract.phases;
          if ((!phases || !phases.length) && va.fidelityContract) phases = va.fidelityContract.phases;
          phases = Array.isArray(phases) ? phases : [];
          for (var i = 0; i < phases.length && i < runtimeIds.length; i++) {
            var sourceId = phases[i] && phases[i].id;
            if (!sourceId) continue;
            aliases[blueprintNormalizePhaseKey(sourceId)] = runtimeIds[i];
            aliases[blueprintNormalizePhaseKey(runtimeIds[i])] = runtimeIds[i];
          }
        } catch(e) {}
        return aliases;
      }
      window.__blueprintRuntimePhaseIdsFromComponent = blueprintRuntimePhaseIdsFromComponent;
      window.__blueprintSourcePhaseAliasesFromRuntime = blueprintSourcePhaseAliasesFromRuntime;
      window.__blueprintNormalizePhaseKey = blueprintNormalizePhaseKey;
      window.__blueprintPhaseSets = blueprintPhaseSets;
      window.__blueprintPhaseMatches = blueprintPhaseMatches;
      function blueprintSourcePhaseIndexForState(gs, phases, phaseId) {
        if (!phases || !phases.length) return -1;
        var raw = phaseId || gs && (gs.currentPhase || gs.phase || gs.currentPhaseName) || '';
        var key = blueprintNormalizePhaseKey(raw);
        if (key) {
          for (var pi = 0; pi < phases.length; pi++) {
            if (blueprintPhaseMatches(phases[pi], key)) return pi;
          }
        }
        var runtimeIdx = blueprintRuntimePhaseIndex(gs, raw);
        if (runtimeIdx >= 0) return Math.max(0, Math.min(phases.length - 1, runtimeIdx));
        var m = String(raw || '').match(/(\\d+)/);
        if (m) return Math.max(0, Math.min(phases.length - 1, Number(m[1]) - 1));
        if (/gameend|gameover|complete|completed|finish|finished|cta|download/.test(key)) return phases.length - 1;
        var completed = blueprintCompletedPhaseCount(gs);
        if (completed > 0) return Math.max(0, Math.min(phases.length - 1, completed));
        return 0;
      }
      function blueprintResolveSourcePhase(gs, phaseSets, phaseId) {
        try {
          phaseSets = Array.isArray(phaseSets) ? phaseSets : [];
          for (var si = 0; si < phaseSets.length; si++) {
            var phases = phaseSets[si];
            if (!phases || !phases.length) continue;
            var idx = blueprintSourcePhaseIndexForState(gs, phases, phaseId);
            if (idx >= 0 && phases[idx]) return { phase: phases[idx], index: idx, total: phases.length };
          }
        } catch(e) {}
        return null;
      }
      window.__blueprintResolveSourcePhase = function(state, phaseId) {
        return blueprintResolveSourcePhase(state, blueprintPhaseSets(window.__BLUEPRINT_VISUAL_ASSETS__ || {}), phaseId);
      };

      function applyStoryboardVisualOverlay() {
        var manifest = window.__BLUEPRINT_VISUAL_ASSETS__;
        if (!manifest || !manifest.sourceEntityContract || !manifest.entityBindings) return;
        try {
          var sceneContract = manifest.sourceSceneContract || {};
          var styles = manifest.sourceEntityContract.entityStyles || {};
          var assets = manifest.assets || [];
          var byAsset = {};
          for (var ai = 0; ai < assets.length; ai++) byAsset[assets[ai].assetId] = assets[ai];
          function color(hex, fallback) {
            var text = String(hex || fallback || '#ffffff').replace('#', '');
            if (!/^[0-9a-f]{6}$/i.test(text)) text = 'ffffff';
            return new pc.Color(parseInt(text.slice(0,2),16)/255, parseInt(text.slice(2,4),16)/255, parseInt(text.slice(4,6),16)/255, 1);
          }
          function clamp01(value, fallback) {
            var n = Number(value);
            if (!isFinite(n)) n = Number(fallback);
            if (!isFinite(n)) n = 1;
            return Math.max(0, Math.min(1, n));
          }
          function colorFromValue(value, fallback) {
            if (Array.isArray(value) && value.length >= 3) {
              return new pc.Color(clamp01(value[0], 1), clamp01(value[1], 1), clamp01(value[2], 1), 1);
            }
            return color(value, fallback || '#ffffff');
          }
          function alphaFromValue(value) {
            return clamp01(value, 1);
          }
          function colorArrayFromValue(value, fallback) {
            var c = colorFromValue(value, fallback || '#ffffff');
            return [Number(c.r), Number(c.g), Number(c.b)];
          }
          function mixColorArray(base, target, t) {
            base = colorArrayFromValue(base, '#ffffff');
            target = colorArrayFromValue(target, '#ffffff');
            t = Math.max(0, Math.min(1, Number(t) || 0));
            return [
              base[0] + (target[0] - base[0]) * t,
              base[1] + (target[1] - base[1]) * t,
              base[2] + (target[2] - base[2]) * t
            ];
          }
          function applyAlphaToMaterial(m, alpha) {
            alpha = alphaFromValue(alpha);
            try { if (m.diffuse) m.diffuse.a = alpha; } catch(eDiffuseA) {}
            try { m.opacity = alpha; } catch(eOpacity) {}
            if (alpha < 1) {
              try { if (pc.BLEND_NORMAL !== undefined) m.blendType = pc.BLEND_NORMAL; } catch(eBlend) {}
              try { m.depthWrite = false; } catch(eDepthWrite) {}
              try { m.alphaTest = 0; } catch(eAlphaTest) {}
            }
            return alpha;
          }
          function mat(value, fallback, alphaValue) {
            if (typeof pc.StandardMaterial !== 'function') return null;
            var m = new pc.StandardMaterial();
            var c = colorFromValue(value, fallback || '#ffffff');
            var alpha = applyAlphaToMaterial(m, alphaValue);
            m.__storyboardColor = [c.r, c.g, c.b, alpha];
            m.diffuse = c;
            applyAlphaToMaterial(m, alpha);
            m.emissive = color('#000000');
            m.emissiveIntensity = 0.08;
            if (typeof m.setParameter === 'function') {
              var rgba = [c.r, c.g, c.b, alpha];
              m.setParameter('_BaseColor', rgba);
              m.setParameter('_Color', rgba);
            }
            m.update();
            return m;
          }
          var poolRenderableCache = undefined;
          function findPoolRenderable() {
            if (poolRenderableCache !== undefined) return poolRenderableCache;
            poolRenderableCache = null;
            try {
              (function walk(node) {
                if (!node || poolRenderableCache) return;
                if (node.name && /^__Pool_/.test(node.name)) {
                  var comps = node._unityComponents || {};
                  var mf = comps.meshFilter && comps.meshFilter[0];
                  var rc = comps.renderer && comps.renderer[0];
                  var mi = rc && rc.meshInstances && rc.meshInstances[0];
                  var mesh = mf && mf.mesh || mi && mi._mesh;
                  var material = mi && mi.material || rc && rc.code && (rc.code.sharedMaterial || rc.code.material);
                  if (mesh && mesh.vertexBuffer && material) {
                    poolRenderableCache = { mesh: mesh, material: material, sourceName: node.name };
                    return;
                  }
                }
                var children = node.children || [];
                for (var i = 0; i < children.length; i++) walk(children[i]);
              })(pcApp.root);
            } catch(e) { poolRenderableCache = null; }
            return poolRenderableCache;
          }
          function clonePoolMaterial(value, fallback, alphaValue) {
            var source = findPoolRenderable();
            var base = source && source.material;
            if (!base) return null;
            var m = null;
            try {
              var shader = base.shader || (typeof UnityEngine !== 'undefined' && UnityEngine.Shader && (
                UnityEngine.Shader.Find("Universal Render Pipeline/Lit") || UnityEngine.Shader.Find("Standard")
              ));
              if (shader && typeof UnityEngine !== 'undefined' && UnityEngine.Material && UnityEngine.Material.$ctor2) {
                m = new UnityEngine.Material.$ctor2(shader);
              }
            } catch(eUnityMaterial) {}
            try { if (!m && typeof base.clone === 'function') m = base.clone(); } catch(eClone) {}
            if (!m) {
              try { if (base.constructor && typeof base.constructor === 'function') m = new base.constructor(); } catch(eCtor) {}
            }
            if (!m || m === base) return null;
            try {
              var c = colorFromValue(value, fallback || '#ffffff');
              var alpha = alphaFromValue(alphaValue);
              var uc = new pc.Color(c.r, c.g, c.b, alpha);
              m.__storyboardColor = [c.r, c.g, c.b, alpha];
              try { m.color = uc; } catch(eSetColor) {}
              try { m.diffuse = new pc.Color(c.r, c.g, c.b, alpha); } catch(eSetDiffuse) {}
              if (m.diffuse && typeof m.diffuse.copy === 'function') m.diffuse.copy(c);
              applyAlphaToMaterial(m, alpha);
              try { m.emissive = new pc.Color(0, 0, 0, 1); } catch(eSetEmissive) {}
              if (typeof m.setParameter === 'function') {
                var rgba = [c.r, c.g, c.b, alpha];
                m.setParameter('_BaseColor', rgba);
                m.setParameter('_Color', rgba);
                m.setParameter('_EmissionColor', [0, 0, 0, 1]);
              }
              if (typeof m.update === 'function') m.update();
            } catch(eColor) {}
            return m;
          }
          function overlayMaterial(value, fallback, alphaValue) {
            var m = clonePoolMaterial(value, fallback, alphaValue);
            return m || mat(value, fallback, alphaValue);
          }
          function nums(raw) {
            return String(raw || '').split(',').map(function(v) {
              var text = String(v || '').trim();
              var expr = text.replace(/Math\.PI/g, 'MathPI');
              if (/^[0-9eE+\\-*/().\\sMathPI]+$/.test(expr)) {
                try {
                  var evaluated = Function('MathPI', 'return (' + expr + ')')(Math.PI);
                  if (isFinite(Number(evaluated))) return Number(evaluated);
                } catch(eEval) {}
              }
              var m = text.match(/-?\d*\.?\d+/);
              return m ? Number(m[0]) : 0;
            });
          }
          function arr3(value, fallback) {
            var out = Array.isArray(value) ? value.map(function(v) {
              var m = String(v).match(/-?\d*\.?\d+/);
              return m ? Number(m[0]) : NaN;
            }) : [];
            return out.length >= 3 && isFinite(out[0]) && isFinite(out[1]) && isFinite(out[2]) ? out.slice(0, 3) : fallback;
          }
          function primitiveSpec(asset) {
            var type = asset && asset.geometry && asset.geometry.type || '';
            var a = nums(asset && asset.geometry && asset.geometry.argsRaw);
            if (/BoxGeometry/.test(type)) return { type: 'box', scale: [a[0] || 1, a[1] || 1, a[2] || 1] };
            if (/CylinderGeometry/.test(type)) return { type: 'cylinder', scale: [(a[0] || 0.5) * 2, a[2] || 1, (a[1] || a[0] || 0.5) * 2] };
            if (/ConeGeometry/.test(type)) return { type: 'cone', scale: [(a[0] || 0.5) * 2, a[1] || 1, (a[0] || 0.5) * 2] };
            if (/PlaneGeometry/.test(type)) return { type: 'plane', scale: [a[0] || 1, 1, a[1] || a[0] || 1] };
            var r = a[0] || 0.5;
            return { type: 'sphere', scale: [r * 2, r * 2, r * 2] };
          }
          function buildAssetGeometry(asset) {
            var type = asset && asset.geometry && asset.geometry.type || '';
            return primitiveSpec(asset);
          }
          function storyboardMaterialColor(rgba) {
            var r = Array.isArray(rgba) ? clamp01(rgba[0], 1) : 1;
            var g = Array.isArray(rgba) ? clamp01(rgba[1], 1) : 1;
            var b = Array.isArray(rgba) ? clamp01(rgba[2], 1) : 1;
            var a = Array.isArray(rgba) && rgba.length > 3 ? clamp01(rgba[3], 1) : 1;
            return new pc.Color(r, g, b, a);
          }
          function recolorMaterial(target, rgba) {
            if (!target || !Array.isArray(rgba)) return;
            var c = storyboardMaterialColor(rgba);
            try { target.color = c; } catch(eColor) {}
            try { target.diffuse = new pc.Color(rgba[0], rgba[1], rgba[2], rgba.length > 3 ? rgba[3] : 1); } catch(eDiffuse) {}
            try {
              if (typeof target.SetColor === 'function') {
                target.SetColor('_Color', c);
                target.SetColor('_BaseColor', c);
              }
            } catch(eSetColor) {}
            try {
              if (typeof target.setParameter === 'function') {
                target.setParameter('_Color', rgba);
                target.setParameter('_BaseColor', rgba);
              }
            } catch(eParam) {}
            try { if (typeof target.update === 'function') target.update(); } catch(eUpdate) {}
          }
          function applyMaterial(ent, material) {
            try {
              if (!material) return;
              var rgba = material.__storyboardColor;
              var instances = [];
              if (ent.render && ent.render.meshInstances) instances = ent.render.meshInstances;
              else if (ent.model && ent.model.model && ent.model.model.meshInstances) instances = ent.model.model.meshInstances;
              else if (ent._unityComponents && ent._unityComponents.renderer && ent._unityComponents.renderer[0]) {
                var rc = ent._unityComponents.renderer[0];
                try {
                  if (rc.code) {
                    recolorMaterial(rc.code.sharedMaterial, rgba);
                    recolorMaterial(rc.code.material, rgba);
                    rc.code.sharedMaterial = material;
                    rc.code.material = material;
                    recolorMaterial(rc.code.sharedMaterial, rgba);
                    recolorMaterial(rc.code.material, rgba);
                  }
                } catch(eRendererMaterial) {}
                try { if (typeof rc.updateMesh === 'function') rc.updateMesh(); } catch(eUpdateMesh) {}
                instances = rc.meshInstances || [];
              }
              for (var i = 0; i < instances.length; i++) {
                recolorMaterial(instances[i].material, rgba);
                instances[i].material = material;
                recolorMaterial(instances[i].material, rgba);
                try { instances[i].visible = true; } catch(eVisible) {}
                try { instances[i].cull = false; } catch(eCull) {}
                try { instances[i]._aabbVer = -1; } catch(eAabb) {}
              }
              recolorMaterial(material, rgba);
              try { if (typeof material.update === 'function') material.update(); } catch(eMatUpdate) {}
            } catch(e) {}
          }
          function addPrimitiveComponent(ent, type) {
            var primitiveType = type || 'box';
            try {
              if (pcApp.systems && pcApp.systems.render) {
                ent.addComponent('render', { type: primitiveType });
                return true;
              }
            } catch(renderErr) {}
            return false;
          }
          function createRendererPrimitiveEntity(parent, name, type) {
            try {
              var source = findPoolRenderable();
              if (!source || !pcApp.systems || !pcApp.systems.meshFilter || !pcApp.systems.renderer) return null;
              if (typeof pc.MeshFilterComponent !== 'function') return null;
              var RCCtor = (typeof pc.MeshRendererComponent === 'function') ? pc.MeshRendererComponent : pc.RendererComponent;
              if (typeof RCCtor !== 'function') return null;
              var e = new pc.Entity(name);
              parent.addChild(e);
              var mf = new pc.MeshFilterComponent(e);
              pcApp.systems.meshFilter.addComponent(e, mf);
              mf.mesh = source.mesh;
              var rc = new RCCtor(e);
              pcApp.systems.renderer.addComponent(e, rc);
              rc.meshFilter = mf;
              try { if (rc.code && source.material) rc.code.sharedMaterial = source.material; } catch(eMat) {}
              try { if (typeof rc.updateMesh === 'function') rc.updateMesh(); } catch(eUpdate) {}
              setTimeout(function() {
                try {
                  var mis = rc.meshInstances || [];
                  for (var i = 0; i < mis.length; i++) {
                    mis[i].visible = true;
                    mis[i].cull = false;
                    if (source.material && !mis[i].material) mis[i].material = source.material;
                    try { mis[i]._aabbVer = -1; } catch(eAabb) {}
                  }
                } catch(eMi) {}
              }, 0);
              return e;
            } catch(e) {
              console.warn('[AI] Storyboard renderer primitive failed: ' + name + ' ' + (e && e.message ? e.message : e));
              return null;
            }
          }
          function unityPrimitiveType(type) {
            try {
              if (!window.UnityEngine || !UnityEngine.PrimitiveType) return null;
              if (type === 'sphere') return UnityEngine.PrimitiveType.Sphere;
              if (type === 'cylinder' || type === 'cone') return UnityEngine.PrimitiveType.Cylinder;
              if (type === 'plane') return UnityEngine.PrimitiveType.Plane;
              return UnityEngine.PrimitiveType.Cube;
            } catch(e) { return null; }
          }
          function createUnityPrimitiveEntity(name, type) {
            try {
              if (!window.UnityEngine || !UnityEngine.GameObject || !UnityEngine.GameObject.CreatePrimitive) return null;
              var primitiveType = unityPrimitiveType(type);
              if (primitiveType == null) return null;
              var go = UnityEngine.GameObject.CreatePrimitive(primitiveType);
              var entity = go && go.handle;
              if (!entity) return null;
              go.name = name;
              entity.name = name;
              return entity;
            } catch(e) { return null; }
          }
          function stripStoryboardPrimitivePhysics(entity) {
            if (!entity) return entity;
            function disableOrDestroy(comp) {
              if (!comp) return;
              try { comp.enabled = false; } catch(eEnabled) {}
              try { comp._enabled = false; } catch(ePrivateEnabled) {}
              try { if (comp.code) comp.code.enabled = false; } catch(eCodeEnabled) {}
              try { if (typeof comp.destroy === 'function') comp.destroy(); } catch(eDestroy) {}
            }
            try {
              if (entity.collision) {
                disableOrDestroy(entity.collision);
                if (typeof entity.removeComponent === 'function') entity.removeComponent('collision');
              }
              if (entity.rigidbody) {
                disableOrDestroy(entity.rigidbody);
                if (typeof entity.removeComponent === 'function') entity.removeComponent('rigidbody');
              }
            } catch(ePcPhysics) {}
            try {
              var comps = entity._unityComponents || {};
              Object.keys(comps).forEach(function(key) {
                if (!/collider|rigidbody|physics/i.test(key)) return;
                var list = Array.isArray(comps[key]) ? comps[key] : [comps[key]];
                for (var i = 0; i < list.length; i++) disableOrDestroy(list[i]);
                comps[key] = [];
              });
            } catch(eUnityPhysics) {}
            return entity;
          }
          function createPrimitiveEntity(parent, name, type) {
            var e = new pc.Entity(name);
            parent.addChild(e);
            if (addPrimitiveComponent(e, type)) return stripStoryboardPrimitivePhysics(e);
            try { parent.removeChild(e); } catch(removeErr) {}
            e = createUnityPrimitiveEntity(name, type);
            if (e) {
              stripStoryboardPrimitivePhysics(e);
              try { if (e.parent && e.parent !== parent) e.parent.removeChild(e); } catch(parentErr) {}
              try { if (e.parent !== parent) parent.addChild(e); } catch(addErr) {
                console.warn('[AI] Storyboard primitive reparent failed: ' + name + ' ' + (addErr && addErr.message ? addErr.message : addErr));
                return null;
              }
              return e;
            }
            e = createRendererPrimitiveEntity(parent, name, type);
            if (e) return stripStoryboardPrimitivePhysics(e);
            console.warn('[AI] Storyboard primitive unavailable: ' + name + ' type=' + (type || 'box'));
            return null;
          }
          var __sourceEntityNameSet = {};
          try {
            var __sourceNames = manifest.sourceEntityContract && manifest.sourceEntityContract.entities || [];
            for (var __sni = 0; __sni < __sourceNames.length; __sni++) {
              var __sn = String(__sourceNames[__sni]);
              __sourceEntityNameSet[__sn] = true;
              var __snCamel = __sn.charAt(0).toLowerCase() + __sn.slice(1);
              __sourceEntityNameSet[__snCamel] = true;
              __sourceEntityNameSet['_' + __snCamel] = true;
            }
          } catch(eSourceNameSet) {}
          function hideTemplateVisuals(root) {
            function walk(ent) {
              if (!ent) return;
              if (ent.name && (/^__Pool_/.test(ent.name) || /^Label_/.test(ent.name) ||
                  ent.name === 'Canvas' || ent.name === '__Ground' || ent.name === '__MaterialSource' ||
                  ent.name === 'Ground' || ent.name === 'Plane' || /^Grid/.test(ent.name) ||
                  /^__SourceGround/.test(ent.name) || /^__SourceGrid/.test(ent.name) ||
                  __sourceEntityNameSet[String(ent.name)])) {
                ent.enabled = false;
                try {
                  var rc = ent._unityComponents && ent._unityComponents.renderer && ent._unityComponents.renderer[0];
                  var instances = rc && rc.meshInstances || [];
                  for (var mi = 0; mi < instances.length; mi++) instances[mi].visible = false;
                } catch(eHideTemplateMesh) {}
              }
              var children = ent.children || [];
              for (var i = 0; i < children.length; i++) walk(children[i]);
            }
            walk(root);
          }
          function addPrimitive(parent, asset) {
            var spec = buildAssetGeometry(asset);
            var sourceAssetId = asset && asset.assetId || ('asset_' + Math.random().toString(36).slice(2));
            var e = createPrimitiveEntity(parent, 'SourcePrimitive_' + sourceAssetId, spec.type);
            if (!e) return null;
            var p = arr3(asset && asset.transform && asset.transform.position, [0,0,0]);
            e.setLocalPosition(p[0], p[1], p[2]);
            e.setLocalScale(spec.scale[0], spec.scale[1], spec.scale[2]);
            var assetMaterial = asset && asset.material || {};
            var material = overlayMaterial(assetMaterial.diffuseColor, null, assetMaterial.opacity);
            applyMaterial(e, material);
            setTimeout(function() { applyMaterial(e, material); }, 0);
            setTimeout(function() { applyMaterial(e, material); }, 250);
            return e;
          }
          function unlitOverlayMaterial(value, fallback) {
            function toLinearColor(c) {
              function lin(v) {
                v = clamp01(v, 0);
                return Math.pow(v, 2.2);
              }
              return new pc.Color(lin(c.r), lin(c.g), lin(c.b), 1);
            }
            try {
              if (typeof pc.BasicMaterial === 'function') {
                var bm = new pc.BasicMaterial();
                var bc = toLinearColor(colorFromValue(value, fallback || '#ffffff'));
                bm.color = bc;
                bm.__storyboardColor = [bc.r, bc.g, bc.b, 1];
                bm.update();
                return bm;
              }
            } catch(eBasicMat) {}
            var m = overlayMaterial(value, fallback || '#ffffff');
            try {
              var c = toLinearColor(colorFromValue(value, fallback || '#ffffff'));
              m.__storyboardColor = [c.r, c.g, c.b, 1];
              m.diffuse = c;
              m.emissive = c;
              m.emissiveIntensity = 1;
              m.shininess = 0;
              if (m.useLighting !== undefined) m.useLighting = false;
              m.update();
            } catch(eUnlitMat) {}
            return m;
          }
          hideTemplateVisuals(pcApp.root);
          setTimeout(function() { hideTemplateVisuals(pcApp.root); }, 500);
          setTimeout(function() { hideTemplateVisuals(pcApp.root); }, 1500);
          if (contractSceneBackground) {
            applyStoryboardSceneBackground('storyboard-visual-overlay');
            setTimeout(function() { applyStoryboardSceneBackground('storyboard-visual-overlay-late'); }, 750);
            setTimeout(function() { applyStoryboardSceneBackground('storyboard-visual-overlay-final'); }, 1500);
          } else if (sceneContract.backgroundColor && camEnt.camera) {
            camEnt.camera.clearColor = color(sceneContract.backgroundColor, '#000000');
          }
          if (sceneContract.directionalLight && sceneContract.directionalLight.color && lightEnt.light) {
            lightEnt.light.color = color(sceneContract.directionalLight.color, '#ffffff');
            lightEnt.light.intensity = (Number(sceneContract.directionalLight.intensity) || 1) * 0.18;
          }
          // [OPTION C, Wave 3 Step 4] source-faithful scene lighting / fog / camera.
          // Gated on manifest.sourceMeshOps (Option C active) so the validated Option-B
          // pipeline is unperturbed; each sub-block is null-guarded (missing SCENE_CONFIG
          // field → no-op); whole block try/catch-wrapped so it can never break the build.
          var __optionC = !!(sceneContract && (sceneContract.ambientLight || sceneContract.fog || sceneContract.camera || sceneContract.directionalLight || sceneContract.rimLight));
          if (__optionC) {
            try {
              // Directional light DIRECTION from the source light position (points at origin).
              if (sceneContract.directionalLight && Array.isArray(sceneContract.directionalLight.position) && lightEnt) {
                var dp = sceneContract.directionalLight.position;
                lightEnt.setPosition(dp[0], dp[1], dp[2]);
                lightEnt.lookAt(0, 0, 0);
              }
              // Ambient light (PlayCanvas scene.ambientLight; scaled by intensity).
              if (sceneContract.ambientLight && sceneContract.ambientLight.color && pcApp && pcApp.scene) {
                var amb = color(sceneContract.ambientLight.color, '#202020');
                var ai = Number(sceneContract.ambientLight.intensity);
                if (isFinite(ai)) amb = new pc.Color(amb.r * ai * 0.35, amb.g * ai * 0.35, amb.b * ai * 0.35, 1);
                pcApp.scene.ambientLight = amb;
              }
              // Rim light (second directional, e.g. three.js PointLight rim at (-10,5,-12)).
              if (sceneContract.rimLight && sceneContract.rimLight.color) {
                var rimEnt = new pc.Entity('AI_RimLight');
                pcApp.root.addChild(rimEnt);
                rimEnt.addComponent('light', { type: 'directional', color: color(sceneContract.rimLight.color, '#ffffff'), intensity: (Number(sceneContract.rimLight.intensity) || 0.5) * 0.25 });
                var rp = Array.isArray(sceneContract.rimLight.position) ? sceneContract.rimLight.position : [-10, 5, -12];
                rimEnt.setPosition(rp[0], rp[1], rp[2]);
                rimEnt.lookAt(0, 0, 0);
              }
              // Linear fog.
              if (sceneContract.fog && sceneContract.fog.color && pcApp && pcApp.scene) {
                pcApp.scene.fog = 'linear';
                pcApp.scene.fogColor = color(sceneContract.fog.color, '#071026');
                if (isFinite(Number(sceneContract.fog.near))) pcApp.scene.fogStart = Number(sceneContract.fog.near);
                if (isFinite(Number(sceneContract.fog.far))) pcApp.scene.fogEnd = Number(sceneContract.fog.far);
              }
              // Camera pose / FoV, IF the source contract captured it (L8 SCENE_CONFIG.camera).
              // NOTE: the AI_Camera is also synced from UnityEngine.Camera.main at +500ms above;
              // when the skeleton sets no explicit Camera.main pose, this overlay value persists.
              if (sceneContract.camera && camEnt.camera) {
                var scam = sceneContract.camera;
                if (isFinite(Number(scam.fov))) { camEnt.camera.projection = 0; camEnt.camera.fov = Number(scam.fov); }
                if (isFinite(Number(scam.near))) camEnt.camera.nearClip = Number(scam.near);
                if (isFinite(Number(scam.far))) camEnt.camera.farClip = Number(scam.far);
                if (Array.isArray(scam.position)) camEnt.setPosition(scam.position[0], scam.position[1], scam.position[2]);
                var look = Array.isArray(scam.lookAt) ? scam.lookAt : [0, 0, 0];
                camEnt.lookAt(look[0], look[1], look[2]);
              }
              console.log('[OPTION C] applied source-faithful scene lighting/fog/camera');
            } catch (e) { console.error('[OPTION C] scene-config apply error:', e); }
          }
          var root = new pc.Entity('__StoryboardVisualOverlay');
          pcApp.root.addChild(root);
          function isStoryboardOverlayNode(node) {
            try {
              var cur = node;
              while (cur) {
                if (cur === root || cur.name === '__StoryboardVisualOverlay') return true;
                cur = cur.parent;
              }
            } catch(e) {}
            return false;
          }
          function storyboardNodePath(node) {
            var parts = [];
            var cur = node;
            var guard = 0;
            while (cur && guard++ < 32) {
              parts.unshift(cur.name || '<unnamed>');
              cur = cur.parent;
            }
            return parts.join('/');
          }
          function storyboardRenderableComponents(node) {
            var out = [];
            if (!node) return out;
            try {
              if (node.render) out.push({ kind: 'render', component: node.render, meshInstances: node.render.meshInstances || [] });
            } catch(eRender) {}
            try {
              if (node.model) {
                var mis = node.model.model && node.model.model.meshInstances || [];
                out.push({ kind: 'model', component: node.model, meshInstances: mis });
              }
            } catch(eModel) {}
            try {
              var comps = node._unityComponents || {};
              var renderers = comps.renderer || [];
              for (var i = 0; i < renderers.length; i++) {
                var rc = renderers[i];
                out.push({ kind: 'unity-renderer', component: rc, meshInstances: rc && rc.meshInstances || [] });
              }
            } catch(eUnityRenderer) {}
            return out;
          }
          function storyboardPhysicsComponents(node) {
            var out = [];
            if (!node) return out;
            try {
              if (node.collision) out.push({ kind: 'collision', component: node.collision });
              if (node.rigidbody) out.push({ kind: 'rigidbody', component: node.rigidbody });
            } catch(ePhysicsComponent) {}
            try {
              var comps = node._unityComponents || {};
              Object.keys(comps).forEach(function(key) {
                if (!/collider|rigidbody|physics/i.test(key)) return;
                var list = Array.isArray(comps[key]) ? comps[key] : [comps[key]];
                for (var i = 0; i < list.length; i++) {
                  if (list[i]) out.push({ kind: 'unity-' + key, component: list[i] });
                }
              });
            } catch(eUnityPhysics) {}
            return out;
          }
          function storyboardComponentVisible(entry) {
            var comp = entry && entry.component;
            if (!comp) return false;
            if (comp.enabled === false) return false;
            try { if (comp.code && comp.code.enabled === false) return false; } catch(eCodeEnabled) {}
            var mis = entry.meshInstances || [];
            if (!mis.length) return true;
            for (var i = 0; i < mis.length; i++) {
              if (mis[i] && mis[i].visible !== false) return true;
            }
            return false;
          }
          function storyboardPhysicsEnabled(entry) {
            var comp = entry && entry.component;
            if (!comp) return false;
            if (comp.enabled === false || comp._enabled === false) return false;
            try { if (comp.code && comp.code.enabled === false) return false; } catch(eCodeEnabled) {}
            return true;
          }
          function setStoryboardComponentVisible(entry, visible) {
            var comp = entry && entry.component;
            if (!comp) return;
            try { comp.enabled = !!visible; } catch(eEnabled) {}
            try { if (comp.code) comp.code.enabled = !!visible; } catch(eCodeEnabled) {}
            var mis = entry.meshInstances || [];
            for (var i = 0; i < mis.length; i++) {
              try { if (mis[i]) mis[i].visible = !!visible; } catch(eMiVisible) {}
            }
          }
          function setStoryboardPhysicsEnabled(entry, enabled) {
            var comp = entry && entry.component;
            if (!comp) return;
            try { comp.enabled = !!enabled; } catch(eEnabled) {}
            try { comp._enabled = !!enabled; } catch(ePrivateEnabled) {}
            try { if (typeof comp.setEnabled === 'function') comp.setEnabled(!!enabled); } catch(eSetEnabled) {}
            try { if (comp.code) comp.code.enabled = !!enabled; } catch(eCodeEnabled) {}
          }
          function storyboardLegacyPhysicsNode(node) {
            var path = storyboardNodePath(node);
            var name = node && (node.name || '') || '';
            return path.indexOf('__LunaPool') >= 0 || /^__Pool_/.test(name) || /^__Source/.test(name);
          }
          function auditStoryboardVisualLayer(options) {
            options = options || {};
            var suppress = options.suppress !== false;
            var before = [];
            var after = [];
            var physicsBefore = [];
            var physicsAfter = [];
            var overlaySurfaceCount = 0;
            function scan(node, collect, applySuppress) {
              if (!node) return;
              var isOverlay = isStoryboardOverlayNode(node);
              var entries = storyboardRenderableComponents(node);
              var visibleEntries = [];
              for (var i = 0; i < entries.length; i++) {
                if (storyboardComponentVisible(entries[i])) visibleEntries.push(entries[i]);
              }
              if (visibleEntries.length) {
                if (isOverlay) {
                  overlaySurfaceCount += visibleEntries.length;
                } else {
                  collect.push({
                    name: node.name || '',
                    path: storyboardNodePath(node),
                    surfaceCount: visibleEntries.length
                  });
                  if (applySuppress) {
                    for (var vi = 0; vi < visibleEntries.length; vi++) setStoryboardComponentVisible(visibleEntries[vi], false);
                  }
                }
              }
              if (!isOverlay && storyboardLegacyPhysicsNode(node)) {
                var physicsEntries = storyboardPhysicsComponents(node);
                var enabledPhysicsEntries = [];
                for (var pi = 0; pi < physicsEntries.length; pi++) {
                  if (storyboardPhysicsEnabled(physicsEntries[pi])) enabledPhysicsEntries.push(physicsEntries[pi]);
                }
                if (enabledPhysicsEntries.length) {
                  collect.push({
                    name: node.name || '',
                    path: storyboardNodePath(node),
                    physicsCount: enabledPhysicsEntries.length
                  });
                  if (applySuppress) {
                    for (var pei = 0; pei < enabledPhysicsEntries.length; pei++) setStoryboardPhysicsEnabled(enabledPhysicsEntries[pei], false);
                  }
                }
              }
              var children = node.children || [];
              for (var ci = 0; ci < children.length; ci++) scan(children[ci], collect, applySuppress);
            }
            function splitRows(rows) {
              var visual = [];
              var physics = [];
              for (var i = 0; i < rows.length; i++) {
                if (rows[i] && rows[i].physicsCount) physics.push(rows[i]);
                else visual.push(rows[i]);
              }
              return { visual: visual, physics: physics };
            }
            var beforeRows = [];
            var afterRows = [];
            try { scan(pcApp.root, beforeRows, suppress); } catch(eBeforeAudit) {}
            if (suppress) {
              try { scan(pcApp.root, afterRows, false); } catch(eAfterAudit) {}
            } else {
              afterRows = beforeRows.slice();
            }
            var beforeSplit = splitRows(beforeRows);
            var afterSplit = splitRows(afterRows);
            before = beforeSplit.visual;
            after = afterSplit.visual;
            physicsBefore = beforeSplit.physics;
            physicsAfter = afterSplit.physics;
            var report = {
              suppressApplied: suppress,
              overlaySurfaceCount: overlaySurfaceCount,
              suppressedLegacySurfaces: before,
              visibleNonOverlaySurfaces: after,
              visibleNonOverlaySurfaceCount: after.length,
              suppressedLegacyPhysics: physicsBefore,
              activeLegacyPhysics: physicsAfter,
              activeLegacyPhysicsCount: physicsAfter.length
            };
            window.__storyboardVisualLayerAudit = report;
            return report;
          }
          function hideLegacyStoryboardVisualSurfaces() {
            return auditStoryboardVisualLayer({ suppress: true });
          }
          window.__auditStoryboardVisualLayer = auditStoryboardVisualLayer;
          window.__storyboardVisualOverlayRoot = root;
          if (contractSceneBackground) {
            window.__storyboardSceneDetails = window.__storyboardSceneDetails || {};
            window.__storyboardSceneDetails.sceneFillMode = 'camera-clear';
          }
          if (sceneContract.ground && sceneContract.ground.color) {
            var g = createPrimitiveEntity(root, 'StoryboardGround', 'box');
            if (g) {
              var gw = Number(sceneContract.ground.width) || (Number(sceneContract.ground.radius) ? Number(sceneContract.ground.radius) * 2 : 62);
              var gd = Number(sceneContract.ground.depth || sceneContract.ground.height) || gw;
              g.setPosition(0, -0.08, 0);
              g.setLocalScale(gw, 0.06, gd);
              var groundMat = unlitOverlayMaterial(sceneContract.ground.color, '#1A2A3A');
              applyMaterial(g, groundMat);
              setTimeout(function() { applyMaterial(g, groundMat); }, 250);
            }
          }
          if (sceneContract.ground) {
            var gridMat = unlitOverlayMaterial('#1e3050', '#1e3050');
            var gridSize = Number(sceneContract.ground.width) || 62;
            var divisions = 20;
            for (var gi = 0; gi <= divisions; gi++) {
              var gp = -gridSize / 2 + gi * (gridSize / divisions);
              var gx = createPrimitiveEntity(root, 'StoryboardGridX', 'box');
              if (gx) {
                gx.setPosition(gp, -0.035, 0);
                gx.setLocalScale(0.025, 0.025, gridSize);
                applyMaterial(gx, gridMat);
              }
              var gz = createPrimitiveEntity(root, 'StoryboardGridZ', 'box');
              if (gz) {
                gz.setPosition(0, -0.034, gp);
                gz.setLocalScale(gridSize, 0.025, 0.025);
                applyMaterial(gz, gridMat);
              }
            }
          }
          var starMat = overlayMaterial('#ffffff');
          var decor = sceneContract.decor || {};
          var starCount = Math.min(120, Math.max(0, decor.stars || 0));
          for (var si = 0; si < starCount; si++) {
            var sx = ((Math.sin(si * 12.9898) * 43758.5453) % 1) * 135 - 35;
            var sy = 8 + Math.abs((Math.sin(si * 78.233) * 31) % 30);
            var sz = ((Math.sin(si * 39.425) * 24634.6345) % 1) * 90 - 45;
            var s = createPrimitiveEntity(root, 'StoryboardStar', 'sphere');
            if (!s) continue;
            s.setPosition(sx, sy, sz);
            s.setLocalScale(0.07, 0.07, 0.07);
            applyMaterial(s, starMat);
          }
          var ringMat = overlayMaterial('#2f6d9c');
          var ringCount = Math.min(6, Math.max(0, decor.orbitalRings || 0));
          for (var ri = 0; ri < ringCount; ri++) {
            for (var rp = 0; rp < 48; rp++) {
              var t = rp / 48 * Math.PI * 2;
              var dot = createPrimitiveEntity(root, 'StoryboardOrbit', 'sphere');
              if (!dot) continue;
              dot.setPosition(Math.cos(t) * (24 + ri * 13), 0.04, Math.sin(t) * (8 + ri * 5) + ri * 3);
              dot.setLocalScale(0.045, 0.045, 0.045);
              applyMaterial(dot, ringMat);
            }
          }
          var entityRoots = {};
          var storyboardVisualPositions = {};
          var sourceEntityPositions = {};
          var primitiveStyleByName = {};
          function storyboardRenderX(x) {
            var n = Number(x);
            if (!isFinite(n)) n = 0;
            return -n;
          }
          function storyboardRenderZ(z) {
            var n = Number(z);
            if (!isFinite(n)) n = 0;
            return -n;
          }
          function storyboardRenderZForName(name, z) {
            var n = Number(z);
            if (!isFinite(n)) n = 0;
            return isStoryboardPlayerName(name) ? n : -n;
          }
          function isStoryboardPlayerName(name) {
            return /(^|[_-])(player|hero|avatar)$/i.test(String(name || '')) || /player/i.test(String(name || ''));
          }
          function isStoryboardHudEntityName(name) {
            return /^(GoldUI|GuideUI)$/i.test(String(name || ''));
          }
          function storyboardNowMs() {
            try {
              if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') return performance.now();
            } catch(e) {}
            return Date.now ? Date.now() : (new Date()).getTime();
          }
          function finiteStoryboardSourcePosition(p) {
            return !!(p && isFinite(Number(p.x)) && isFinite(Number(p.z)));
          }
          function cloneStoryboardSourcePosition(p, fallback) {
            if (finiteStoryboardSourcePosition(p)) {
              return { x: Number(p.x), y: Number(p.y) || 0, z: Number(p.z) };
            }
            if (Array.isArray(fallback) && fallback.length >= 3) {
              return { x: Number(fallback[0]) || 0, y: Number(fallback[1]) || 0, z: Number(fallback[2]) || 0 };
            }
            return { x: 0, y: 0, z: 0 };
          }
          function runtimeStoryboardPlayerSourcePosition() {
            try {
              var cls = window.GFM_Player;
              var player = cls && (cls.Instance || cls.instance);
              var go = player && (player.Go || player.go);
              var pos = go && go.transform && go.transform.position;
              if (pos && isFinite(Number(pos.x)) && isFinite(Number(pos.z)) && Number(pos.y) > -100) {
                return { x: Number(pos.x), y: Number(pos.y) || 0, z: Number(pos.z) };
              }
            } catch(eRuntimePlayer) {}
            return null;
          }
          function activeStoryboardManualJoystick() {
            try {
              var joy = window.__bpManualJoystickOverride;
              if (!joy || !joy.active) return null;
              var now = storyboardNowMs();
              var updatedAt = Number(joy.updatedAt) || 0;
              if (updatedAt && now - updatedAt > 700) return null;
              var x = Number(joy.x) || 0;
              var y = Number(joy.y) || 0;
              var mag = Math.sqrt(x * x + y * y);
              if (mag > 1) {
                x /= mag;
                y /= mag;
              }
              return { x: x, y: y, speed: Number(joy.speed) || 6, now: now };
            } catch(eJoyState) {}
            return null;
          }
          function manualStoryboardPlayerSourcePosition(name, p, liveAvailable) {
            var joy = activeStoryboardManualJoystick();
            var base = cloneStoryboardSourcePosition(p, sourceEntityPositions[name]);
            if (!joy) {
              syncEntityPositions._manualPlayerSourcePos = { x: base.x, y: base.y, z: base.z, t: storyboardNowMs() };
              try { window.__bpManualOverlayPlayerSourcePos = { active: false, x: base.x, y: base.y, z: base.z }; } catch(eIdleExpose) {}
              return p;
            }
            if (liveAvailable) {
              syncEntityPositions._manualPlayerSourcePos = { x: base.x, y: base.y, z: base.z, t: joy.now };
              try { window.__bpManualOverlayPlayerSourcePos = { active: true, live: true, x: base.x, y: base.y, z: base.z, input: { x: joy.x, y: joy.y } }; } catch(eLiveExpose) {}
              return base;
            }
            var cur = syncEntityPositions._manualPlayerSourcePos;
            if (!cur || !finiteStoryboardSourcePosition(cur)) cur = { x: base.x, y: base.y, z: base.z, t: joy.now };
            var last = Number(cur.t) || joy.now;
            var dt = Math.max(0.008, Math.min(0.05, (joy.now - last) / 1000 || 0.016));
            cur = {
              x: Number(cur.x) + joy.x * joy.speed * dt,
              y: Number(cur.y) || 0,
              z: Number(cur.z) - joy.y * joy.speed * dt,
              t: joy.now
            };
            syncEntityPositions._manualPlayerSourcePos = cur;
            try { window.__bpManualOverlayPlayerSourcePos = { active: true, live: false, x: cur.x, y: cur.y, z: cur.z, input: { x: joy.x, y: joy.y }, dt: dt }; } catch(eExposeManual) {}
            return cur;
          }
          function setStoryboardEntityPosition(name, x, y, z, smooth) {
            var ent = entityRoots[name];
            if (!ent) return;
            var tx = Number(x) || 0;
            var ty = Number(y) || 0;
            var tz = Number(z) || 0;
            if (!smooth) {
              storyboardVisualPositions[name] = { x: tx, y: ty, z: tz, t: storyboardNowMs() };
              ent.setPosition(tx, ty, tz);
              return;
            }
            var now = storyboardNowMs();
            var cur = storyboardVisualPositions[name];
            if (!cur) cur = { x: tx, y: ty, z: tz, t: now };
            var dx = tx - cur.x;
            var dy = ty - cur.y;
            var dz = tz - cur.z;
            var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (!isFinite(dist) || dist > 18) {
              cur = { x: tx, y: ty, z: tz, t: now };
            } else if (dist < 0.01) {
              cur = { x: tx, y: ty, z: tz, t: now };
            } else {
              var dt = Math.max(8, Math.min(80, now - (cur.t || now)));
              var alpha = 1 - Math.pow(0.002, dt / 220);
              var sx = dx * alpha;
              var sy = dy * alpha;
              var sz = dz * alpha;
              var stepMag = Math.sqrt(sx * sx + sy * sy + sz * sz);
              var maxVisualStep = Math.min(0.1, 6.5 * dt / 1000);
              if (stepMag > maxVisualStep) {
                sx = sx / stepMag * maxVisualStep;
                sy = sy / stepMag * maxVisualStep;
                sz = sz / stepMag * maxVisualStep;
              }
              cur = { x: cur.x + sx, y: cur.y + sy, z: cur.z + sz, t: now };
            }
            storyboardVisualPositions[name] = cur;
            ent.setPosition(cur.x, cur.y, cur.z);
          }
          window.__storyboardCoordinateAdapter = { source: 'three-rh', target: 'playcanvas-overlay', xFlip: true, zFlip: true };
          function indexPrimitiveStyleAliases(entity, style) {
            if (!entity || !style || typeof style.modelRef !== 'string') return;
            function put(key) {
              if (!key) return;
              primitiveStyleByName[String(key)] = style;
            }
            put(entity.id);
            put(entity.name);
            if (entity.parentPath) {
              var parts = String(entity.parentPath).split('/').filter(Boolean);
              put(parts[parts.length - 1]);
            }
          }
          if (manifest.fidelityContract && Array.isArray(manifest.fidelityContract.entities)) {
            for (var fei = 0; fei < manifest.fidelityContract.entities.length; fei++) {
              var fe = manifest.fidelityContract.entities[fei];
              if (fe && fe.primitiveStyle) indexPrimitiveStyleAliases(fe, fe.primitiveStyle);
            }
          }
          function primitiveStyleForName(name) {
            if (primitiveStyleByName[name]) return primitiveStyleByName[name];
            var raw = String(name || '');
            var noUnder = raw.replace(/^_+/, '');
            if (primitiveStyleByName[noUnder]) return primitiveStyleByName[noUnder];
            var cap = noUnder.charAt(0).toUpperCase() + noUnder.slice(1);
            if (primitiveStyleByName[cap]) return primitiveStyleByName[cap];
            var pascal = noUnder.split(/[_-]+/).filter(Boolean).map(function(part) {
              return part.charAt(0).toUpperCase() + part.slice(1);
            }).join('');
            return primitiveStyleByName[pascal] || null;
          }
          function recordPrimitiveStyle(name, primitiveStyle, visualKind, primitiveCount) {
            if (!primitiveStyle || typeof primitiveStyle.modelRef !== 'string') return;
            window.__storyboardEntityDetails = window.__storyboardEntityDetails || {};
            var detail = window.__storyboardEntityDetails[name] || {};
            detail.primitiveStyle = {
              modelRef: primitiveStyle.modelRef,
              baseColor: colorArrayFromValue(primitiveStyle.baseColor || primitiveStyle.baseColorHex || '#ffffff')
            };
            detail.visualKind = visualKind || detail.visualKind || 'styled-composite';
            detail.primitiveCount = primitiveCount == null ? detail.primitiveCount : primitiveCount;
            window.__storyboardEntityDetails[name] = detail;
          }
          function setLocalEuler(ent, rot) {
            rot = rot || [0, 0, 0];
            try {
              if (ent && typeof ent.setLocalEulerAngles === 'function') ent.setLocalEulerAngles(rot[0] || 0, rot[1] || 0, rot[2] || 0);
              else if (ent && typeof ent.setEulerAngles === 'function') ent.setEulerAngles(rot[0] || 0, rot[1] || 0, rot[2] || 0);
            } catch(e) {}
          }
          function addStyledPart(parent, name, index, type, pos, scale, materialValue, rot) {
            var e = createPrimitiveEntity(parent, 'BPS_' + name + '_' + index, type || 'box');
            if (!e) return null;
            e.setLocalPosition(pos[0] || 0, pos[1] || 0, pos[2] || 0);
            setLocalEuler(e, rot);
            e.setLocalScale(scale[0] || 1, scale[1] || 1, scale[2] || 1);
            var m = overlayMaterial(materialValue || '#ffffff');
            applyMaterial(e, m);
            setTimeout(function() { applyMaterial(e, m); }, 0);
            setTimeout(function() { applyMaterial(e, m); }, 250);
            return e;
          }
          function buildStyledComposite(group, name, primitiveStyle, sourceStyle) {
            if (!primitiveStyle || typeof primitiveStyle.modelRef !== 'string') return 0;
            var kind = String(sourceStyle && sourceStyle.kind || primitiveStyle.modelRef).toLowerCase();
            var base = colorArrayFromValue(primitiveStyle.baseColor || primitiveStyle.baseColorHex || (sourceStyle && sourceStyle.color) || '#ffffff');
            var light = mixColorArray(base, [1, 1, 1], 0.28);
            var dark = mixColorArray(base, [0, 0, 0], 0.35);
            var warm = mixColorArray(base, [1, 0.82, 0.18], 0.38);
            var cool = mixColorArray(base, [0.18, 0.58, 1], 0.32);
            var count = 0;
            function add(type, pos, scale, matValue, rot) {
              if (addStyledPart(group, name, count, type, pos, scale, matValue || base, rot)) count++;
            }
            if (kind === 'astronaut' || kind === 'npc') {
              add('sphere', [0, 1.42, 0], [0.76, 0.76, 0.76], base);
              add('sphere', [0, 1.5, -0.22], [0.48, 0.32, 0.22], [0.53, 0.8, 1, 0.72]);
              add('cylinder', [0, 0.82, 0], [0.68, 0.76, 0.68], base);
              add('cylinder', [-0.46, 0.88, 0], [0.16, 0.56, 0.16], base, [0, 0, -30]);
              add('cylinder', [0.46, 0.88, 0], [0.16, 0.56, 0.16], base, [0, 0, 30]);
              add('cylinder', [-0.17, 0.27, 0], [0.18, 0.6, 0.18], base);
              add('cylinder', [0.17, 0.27, 0], [0.18, 0.6, 0.18], base);
            } else if (kind === 'machine') {
              add('box', [0, 0.55, 0], [1.4, 1.1, 1.4], base);
              add('box', [0, 1.17, 0], [1.2, 0.13, 1.2], light);
              add('cylinder', [0.28, 1.64, 0.28], [0.28, 0.54, 0.28], dark);
            } else if (kind === 'collectible') {
              add('sphere', [0, 0.55, 0], [0.78, 0.92, 0.78], base);
              add('cylinder', [0, 0.28, 0], [1.1, 0.08, 1.1], [base[0], base[1], base[2], 0.5]);
            } else if (kind === 'ship') {
              add('box', [0, 0.72, 0], [2.1, 0.48, 0.88], base);
              add('box', [1.18, 0.72, 0], [0.74, 0.36, 0.56], light);
              add('box', [-0.08, 0.45, -0.85], [1.25, 0.16, 0.34], cool, [0, -14, 0]);
              add('box', [-0.08, 0.45, 0.85], [1.25, 0.16, 0.34], cool, [0, 14, 0]);
              add('cylinder', [-1.24, 0.7, -0.28], [0.28, 0.48, 0.28], warm, [90, 0, 0]);
              add('cylinder', [-1.24, 0.7, 0.28], [0.28, 0.48, 0.28], warm, [90, 0, 0]);
            } else if (kind === 'station') {
              add('cylinder', [0, 0.68, 0], [1.78, 1.35, 1.78], base);
              add('cone', [0, 1.59, 0], [1.64, 0.48, 1.64], warm);
            } else if (kind === 'counter') {
              add('cylinder', [0, 0.38, 0], [0.96, 0.76, 0.96], base);
              add('sphere', [0, 0.96, 0], [0.8, 0.8, 0.8], light);
            } else if (kind === 'pad') {
              add('box', [0, 0.07, 0], [2.4, 0.14, 2.4], base);
              add('box', [0, 0.01, 0], [2.62, 0.07, 2.62], light);
            } else if (kind === 'base') {
              add('box', [0, 0.42, 0], [2.0, 0.78, 1.5], base);
              add('box', [0, 0.98, 0], [1.35, 0.38, 1.0], light);
              add('cylinder', [0.55, 1.55, 0], [0.16, 0.92, 0.16], dark);
              add('sphere', [0.55, 2.08, 0], [0.38, 0.38, 0.38], warm);
            } else if (kind === 'gate') {
              add('box', [0, 0.07, 0], [2.4, 0.14, 2.4], base);
              add('box', [0, 0.01, 0], [2.62, 0.07, 2.62], light);
            } else if (kind === 'crystal') {
              add('sphere', [0, 0.78, 0], [0.82, 1.42, 0.82], base);
              add('sphere', [0.46, 0.5, 0.22], [0.42, 0.78, 0.42], light);
              add('sphere', [-0.42, 0.4, -0.2], [0.32, 0.62, 0.32], cool);
            } else if (kind === 'debris') {
              add('box', [0, 0.42, 0], [1.35, 0.72, 0.82], base, [0, 22, 8]);
              add('box', [0.42, 0.9, -0.18], [0.7, 0.42, 0.5], dark, [12, -28, 0]);
              add('box', [-0.45, 0.22, 0.28], [0.52, 0.32, 0.66], light, [-8, 12, 18]);
            } else if (kind === 'cargo') {
              add('box', [0, 0.52, 0], [1.35, 0.98, 1.12], base);
              add('box', [0, 0.54, 0], [1.46, 0.12, 1.2], dark);
              add('box', [0, 1.1, 0], [1.18, 0.16, 0.96], light);
            } else if (kind === 'tool') {
              add('cylinder', [0, 0.14, 0], [1.0, 0.28, 1.0], base);
              add('sphere', [0, 0.44, 0], [0.76, 0.76, 0.76], base);
            } else if (kind === 'beacon') {
              add('cylinder', [0, 0.38, 0], [1.16, 0.76, 1.16], base);
              add('sphere', [0, 0.96, 0], [0.8, 0.8, 0.8], light);
            } else {
              add('cylinder', [0, 0.38, 0], [1.16, 0.76, 1.16], base);
              add('sphere', [0, 0.96, 0], [0.8, 0.8, 0.8], light);
            }
            recordPrimitiveStyle(name, primitiveStyle, 'styled-composite:' + kind, count);
            return count;
          }
          function sourcePhaseForOverlayState(gs) {
            try {
              var phaseId = gs && (gs.currentPhase || gs.phase) || '';
              var resolved = blueprintResolveSourcePhase(gs, blueprintPhaseSets(manifest), phaseId);
              if (resolved && resolved.phase) return resolved.phase;
            } catch(e) {}
            return null;
          }
          function projectedAnchorPhaseForOverlayState(gs) {
            try {
              var sourcePhase = sourcePhaseForOverlayState(gs);
              var phaseId = sourcePhase && sourcePhase.id || gs && (gs.currentPhase || gs.phase) || '';
              var phaseSets = [];
              ['sourcePhaseContract', 'fidelityContract', 'sourceFidelityContract', 'contract'].forEach(function(key) {
                if (manifest && manifest[key] && Array.isArray(manifest[key].phases)) phaseSets.push(manifest[key].phases);
              });
              for (var si = 0; si < phaseSets.length; si++) {
                var phases = phaseSets[si];
                for (var pi = 0; pi < phases.length; pi++) {
                  if (phases[pi] && String(phases[pi].id) === String(phaseId) && phases[pi].projectedAnchors) return phases[pi];
                }
              }
              if (sourcePhase && sourcePhase.projectedAnchors) return sourcePhase;
            } catch(e) {}
            return null;
          }
          function viewportBaseline() {
            try {
              var candidates = [
                manifest && manifest.viewportBaseline,
                manifest && manifest.fidelityContract && manifest.fidelityContract.viewportBaseline,
                manifest && manifest.sourceFidelityContract && manifest.sourceFidelityContract.viewportBaseline
              ];
              for (var i = 0; i < candidates.length; i++) {
                var v = candidates[i];
                if (v && isFinite(Number(v.width)) && isFinite(Number(v.height))) {
                  return { width: Number(v.width), height: Number(v.height) };
                }
              }
            } catch(e) {}
            return { width: 1280, height: 720 };
          }
          function canvasSize() {
            var canvas = document.getElementById('application-canvas') || document.querySelector('canvas');
            var rect = canvas && canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : null;
            return {
              width: rect && Number(rect.width) || canvas && Number(canvas.width) || window.innerWidth || 1280,
              height: rect && Number(rect.height) || canvas && Number(canvas.height) || window.innerHeight || 720
            };
          }
          function viewportIntersectsAnchor(anchor) {
            if (!anchor) return false;
            var vp = viewportBaseline();
            var x = Number(anchor.x_px), y = Number(anchor.y_px);
            var w = Number(anchor.w_px), h = Number(anchor.h_px);
            if (![x, y, w, h].every(isFinite)) return false;
            return (x + w) >= 0 && x <= vp.width && (y + h) >= 0 && y <= vp.height;
          }
          function anchorToCanvas(anchor) {
            var base = viewportBaseline();
            var size = canvasSize();
            var sx = size.width / base.width;
            var sy = size.height / base.height;
            return {
              x: Number(anchor.x_px) * sx,
              y: Number(anchor.y_px) * sy,
              w: Math.max(0, Number(anchor.w_px) * sx),
              h: Math.max(0, Number(anchor.h_px) * sy)
            };
          }
          function anchorOverlayName(contractId) {
            var raw = String(contractId || '');
            if (entityRoots[raw]) return raw;
            try {
              var catalogs = [];
              ['fidelityContract', 'sourceFidelityContract', 'contract'].forEach(function(key) {
                if (manifest && manifest[key] && Array.isArray(manifest[key].entities)) catalogs.push(manifest[key].entities);
              });
              for (var ci = 0; ci < catalogs.length; ci++) {
                var list = catalogs[ci];
                for (var ei = 0; ei < list.length; ei++) {
                  var ent = list[ei];
                  if (!ent || typeof ent !== 'object') continue;
                  var parentPath = String(ent.parentPath || '');
                  var baseName = parentPath.split('/').filter(Boolean).pop();
                  if (baseName === raw) {
                    var alias = ent.name || ent.id;
                    if (alias && entityRoots[String(alias)]) return String(alias);
                  }
                }
              }
            } catch(e) {}
            var noUnder = raw.replace(/^_+/, '');
            var cap = noUnder.charAt(0).toUpperCase() + noUnder.slice(1);
            if (entityRoots[cap]) return cap;
            var pascal = noUnder.split(/[_-]+/).filter(Boolean).map(function(part) {
              return part.charAt(0).toUpperCase() + part.slice(1);
            }).join('');
            if (pascal && entityRoots[pascal]) return pascal;
            return raw;
          }
          function addAabbPoints(points, aabb) {
            if (!aabb) return;
            var c = aabb.center || aabb._center;
            var h = aabb.halfExtents || aabb._halfExtents;
            if (!c || !h) return;
            for (var dx = -1; dx <= 1; dx += 2) {
              for (var dy = -1; dy <= 1; dy += 2) {
                for (var dz = -1; dz <= 1; dz += 2) {
                  points.push(new pc.Vec3(c.x + h.x * dx, c.y + h.y * dy, c.z + h.z * dz));
                }
              }
            }
          }
          function entityScreenRect(ent) {
            if (!ent || !camEnt || !camEnt.camera || typeof camEnt.camera.worldToScreen !== 'function') return null;
            syncOverlayTransforms();
            var points = [];
            function walk(node) {
              if (!node) return;
              var instances = [];
              if (node.render && node.render.meshInstances) instances = node.render.meshInstances;
              else if (node.model && node.model.model && node.model.model.meshInstances) instances = node.model.model.meshInstances;
              else if (node._unityComponents && node._unityComponents.renderer && node._unityComponents.renderer[0]) {
                instances = node._unityComponents.renderer[0].meshInstances || [];
              }
              for (var mi = 0; mi < instances.length; mi++) addAabbPoints(points, instances[mi] && instances[mi].aabb);
              var children = node.children || [];
              for (var ci = 0; ci < children.length; ci++) walk(children[ci]);
            }
            walk(ent);
            if (!points.length) {
              var p = ent.getPosition ? ent.getPosition() : (ent.getLocalPosition ? ent.getLocalPosition() : null);
              if (p) points.push(p);
            }
            var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (var pi = 0; pi < points.length; pi++) {
              var sp = camEnt.camera.worldToScreen(points[pi]);
              if (!sp || !isFinite(Number(sp.x)) || !isFinite(Number(sp.y))) continue;
              minX = Math.min(minX, Number(sp.x));
              minY = Math.min(minY, Number(sp.y));
              maxX = Math.max(maxX, Number(sp.x));
              maxY = Math.max(maxY, Number(sp.y));
            }
            if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) return null;
            var size = canvasSize();
            return { x_px: minX, y_px: Number(size.height) - maxY, w_px: Math.max(0, maxX - minX), h_px: Math.max(0, maxY - minY) };
          }
          function projectPosition(pos) {
            if (!pos || !camEnt || !camEnt.camera || typeof camEnt.camera.worldToScreen !== 'function') return null;
            syncOverlayTransforms();
            var sp = camEnt.camera.worldToScreen(new pc.Vec3(Number(pos.x) || 0, Number(pos.y) || 0, Number(pos.z) || 0));
            if (!sp) return null;
            var size = canvasSize();
            return { x: Number(sp.x), y: Number(size.height) - Number(sp.y), z: Number(sp.z) };
          }
          function syncOverlayTransforms() {
            try {
              if (pcApp && pcApp.root && typeof pcApp.root.syncHierarchy === 'function') pcApp.root.syncHierarchy();
            } catch(e) {}
          }
          function clampScaleRatio(ratio, min, max) {
            if (!isFinite(ratio)) return 1;
            return Math.max(min, Math.min(max, ratio));
          }
          function calibrateOverlayEntityScreenSize(ent, rect, target) {
            if (!ent || !rect || !target || target.w <= 0 || target.h <= 0 || rect.w_px <= 1 || rect.h_px <= 1) return rect;
            var wRatio = target.w / Math.max(1, rect.w_px);
            var hRatio = target.h / Math.max(1, rect.h_px);
            if (!isFinite(wRatio) || !isFinite(hRatio)) return rect;
            if (Math.abs(1 - wRatio) <= 0.015 && Math.abs(1 - hRatio) <= 0.015) return rect;
            var aspectScale = ent.getLocalScale ? ent.getLocalScale() : null;
            if (!aspectScale) return rect;
            // Fit the runtime bbox to the contract's screen-space rect directly:
            // width maps to ground-plane scale, height maps to vertical scale, and
            // the center solve below absorbs the projection coupling.
            var xzRatio = clampScaleRatio(wRatio, 0.45, 2.2);
            var yRatio = clampScaleRatio(hRatio, 0.45, 2.2);
            ent.setLocalScale(
              (Number(aspectScale.x) || 1) * xzRatio,
              (Number(aspectScale.y) || 1) * yRatio,
              (Number(aspectScale.z) || 1) * xzRatio
            );
            syncOverlayTransforms();
            return entityScreenRect(ent) || rect;
          }
          function rectWithinAnchorFitTolerance(rect, target) {
            if (!rect || !target) return false;
            var tol = 7;
            return Math.abs(Number(rect.x_px) - Number(target.x)) <= tol
              && Math.abs(Number(rect.y_px) - Number(target.y)) <= tol
              && Math.abs(Number(rect.w_px) - Number(target.w)) <= tol
              && Math.abs(Number(rect.h_px) - Number(target.h)) <= tol;
          }
          function calibrateOverlayEntityToAnchor(ent, anchor) {
            if (!ent || !anchor || anchor.provenance === 'inferred-default') return;
            if (!viewportIntersectsAnchor(anchor)) return;
            var target = anchorToCanvas(anchor);
            var targetCx = target.x + target.w / 2;
            var targetCy = target.y + target.h / 2;
            for (var pass = 0; pass < 5; pass++) {
              var rect = entityScreenRect(ent);
              if (!rect) return;
              if (anchor.provenance !== 'anchor-only' && target.w > 0 && target.h > 0 && rect.w_px > 1 && rect.h_px > 1) {
                rect = calibrateOverlayEntityScreenSize(ent, rect, target);
              }
              var currentCx = rect.x_px + rect.w_px / 2;
              var currentCy = rect.y_px + rect.h_px / 2;
              var dxPx = targetCx - currentCx;
              var dyPx = targetCy - currentCy;
              if (Math.abs(dxPx) < 0.5 && Math.abs(dyPx) < 0.5) return;
              var pos = ent.getPosition ? ent.getPosition() : (ent.getLocalPosition ? ent.getLocalPosition() : null);
              if (!pos) return;
              var base = projectPosition(pos);
              var xStep = projectPosition({ x: Number(pos.x) + 1, y: Number(pos.y), z: Number(pos.z) });
              var zStep = projectPosition({ x: Number(pos.x), y: Number(pos.y), z: Number(pos.z) + 1 });
              if (!base || !xStep || !zStep) return;
              var ax = Number(xStep.x) - Number(base.x);
              var ay = Number(xStep.y) - Number(base.y);
              var bx = Number(zStep.x) - Number(base.x);
              var by = Number(zStep.y) - Number(base.y);
              var det = ax * by - bx * ay;
              if (!isFinite(det) || Math.abs(det) < 0.001) return;
              var wx = (dxPx * by - bx * dyPx) / det;
              var wz = (ax * dyPx - dxPx * ay) / det;
              var maxStep = 64;
              var mag = Math.sqrt(wx * wx + wz * wz);
              if (mag > maxStep) { wx = wx / mag * maxStep; wz = wz / mag * maxStep; }
              ent.setPosition(Number(pos.x) + wx, Number(pos.y) || 0, Number(pos.z) + wz);
              syncOverlayTransforms();
            }
          }
          var anchorFitApplied = {};
          function applyProjectedAnchorCalibration(gs) {
            var anchorPhase = projectedAnchorPhaseForOverlayState(gs);
            var anchors = anchorPhase && anchorPhase.projectedAnchors;
            if (!anchors || typeof anchors !== 'object') {
              window.__targetAnchors = window.__targetAnchors || {};
              return;
            }
            var measured = {};
            var phaseId = anchorPhase.id || gs && (gs.currentPhase || gs.phase) || 'current';
            var fitForPhase = anchorFitApplied[phaseId] || {};
            anchorFitApplied[phaseId] = fitForPhase;
            Object.keys(anchors).forEach(function(contractId) {
              var anchor = anchors[contractId];
              var overlayName = anchorOverlayName(contractId);
              var ent = entityRoots[overlayName];
              if (!ent) return;
              if (isStoryboardPlayerName(overlayName)) return;
              calibrateOverlayEntityToAnchor(ent, anchor);
              var rect = entityScreenRect(ent);
              if (rect) {
                measured[contractId] = {
                  x_px: Number(rect.x_px.toFixed ? rect.x_px.toFixed(2) : rect.x_px),
                  y_px: Number(rect.y_px.toFixed ? rect.y_px.toFixed(2) : rect.y_px),
                  w_px: Number(rect.w_px.toFixed ? rect.w_px.toFixed(2) : rect.w_px),
                  h_px: Number(rect.h_px.toFixed ? rect.h_px.toFixed(2) : rect.h_px),
                  provenance: 'extracted'
                };
                if (viewportIntersectsAnchor(anchor) && rectWithinAnchorFitTolerance(rect, anchorToCanvas(anchor))) fitForPhase[overlayName] = true;
              }
            });
            window.__targetAnchors = window.__targetAnchors || {};
            window.__targetAnchors[phaseId] = measured;
            window.__targetAnchors.current = measured;
          }
          function currentViewportAnchoredOverlays(gs) {
            var anchorPhase = projectedAnchorPhaseForOverlayState(gs);
            var anchors = anchorPhase && anchorPhase.projectedAnchors;
            var out = {};
            if (!anchors || typeof anchors !== 'object') return out;
            Object.keys(anchors).forEach(function(contractId) {
              var anchor = anchors[contractId];
              if (!viewportIntersectsAnchor(anchor)) return;
              out[anchorOverlayName(contractId)] = true;
            });
            return out;
          }
          function phaseVisibleMap(sourcePhase) {
            if (!sourcePhase || !Array.isArray(sourcePhase.showEntities)) return null;
            var out = {};
            for (var i = 0; i < sourcePhase.showEntities.length; i++) {
              if (sourcePhase.showEntities[i]) out[String(sourcePhase.showEntities[i])] = true;
            }
            return out;
          }
          function sourceEntityNames() {
            var declared = manifest.sourceEntityContract && manifest.sourceEntityContract.entities;
            if (Array.isArray(declared) && declared.length) return declared;
            var composites = manifest.entityComposites || manifest.sourceEntityComposites || {};
            var names = Object.keys(composites);
            if (names.length) return names;
            return Object.keys(styles);
          }
          var SOURCE_VISUAL_ENTITY_SCALE = 0.25;
          var names = sourceEntityNames();
	          for (var ni = 0; ni < names.length; ni++) {
	            var name = names[ni];
	            var binding = manifest.entityBindings[name];
            var primary = binding && byAsset[binding.primaryAssetId];
            var st = styles[name] || {};
            var pos = primary && arr3(primary.transform && primary.transform.position, null);
            if (!pos && st.position) pos = [Number(st.position.x) || 0, Number(st.position.y) || 0, Number(st.position.z) || 0];
            pos = pos || [0,0,0];
            sourceEntityPositions[name] = [pos[0], pos[1], pos[2]];
            var group = new pc.Entity('StoryboardEntity_' + name);
            root.addChild(group);
            group.setPosition(storyboardRenderX(pos[0]), pos[1], storyboardRenderZForName(name, pos[2]));
            entityRoots[name] = group;
            var primitiveStyle = primitiveStyleForName(name);
            // [OPTION C, Wave 3 R3] when the skeleton already built a source-faithful
            // composite for this entity (manifest.sourceMeshOps[name] non-empty), skip the
            // overlay's styled composite to avoid double meshes. Entities without meshOps
            // still fall through to the overlay (engineered fallback).
            var __sfOps = manifest.sourceMeshOps;
            var __hasSF = !!(__sfOps && __sfOps[name] && __sfOps[name].length);
            var styledCount = (primitiveStyle && !__hasSF) ? buildStyledComposite(group, name, primitiveStyle, st) : 0;
            var ids = binding && binding.assetIds || [];
            if (!styledCount) {
              group.setLocalScale(SOURCE_VISUAL_ENTITY_SCALE, SOURCE_VISUAL_ENTITY_SCALE, SOURCE_VISUAL_ENTITY_SCALE);
              var sourcePrimitiveCount = 0;
              for (var bi = 0; bi < ids.length; bi++) {
                var asset = byAsset[ids[bi]];
                if (!asset || asset.kind !== 'procedural_primitive') continue;
                if (addPrimitive(group, asset)) sourcePrimitiveCount++;
              }
	              if (primitiveStyle) recordPrimitiveStyle(name, primitiveStyle, 'source-procedural', sourcePrimitiveCount);
	            }
	          }
	          var storyboardGuidanceLine = null;
	          var storyboardTargetMarker = null;
	          try {
	            var sourceGuidance = manifest.sourceSceneContract && manifest.sourceSceneContract.guidance;
	            if (!sourceGuidance || !sourceGuidance.trailLine || sourceGuidance.trailLine !== false) {
	              storyboardGuidanceLine = createPrimitiveEntity(root, 'StoryboardGuidanceTrailLine', 'box');
	              if (storyboardGuidanceLine) {
	                storyboardGuidanceLine.enabled = false;
	                storyboardGuidanceLine.setLocalScale(0.045, 0.045, 1);
	                applyMaterial(storyboardGuidanceLine, overlayMaterial('#8deaff'));
	              }
	            }
	            storyboardTargetMarker = new pc.Entity('StoryboardTargetMarker');
	            root.addChild(storyboardTargetMarker);
	            storyboardTargetMarker.enabled = false;
	            var targetMarkerMat = overlayMaterial('#ffff33');
	            try {
	              if (targetMarkerMat) {
	                targetMarkerMat.emissive = new pc.Color(1, 0.95, 0.10, 1);
	                if (typeof targetMarkerMat.setParameter === 'function') targetMarkerMat.setParameter('_EmissionColor', [1.35, 1.20, 0.10, 1]);
	                if (typeof targetMarkerMat.update === 'function') targetMarkerMat.update();
	              }
	            } catch(eTargetMarkerEmission) {}
	            for (var tmi = 0; tmi < 36; tmi++) {
	              var dot = createPrimitiveEntity(storyboardTargetMarker, 'StoryboardTargetMarkerDot', 'sphere');
	              if (!dot) continue;
	              var angle = tmi / 36 * Math.PI * 2;
	              var markerRadius = tmi % 2 === 0 ? 0.96 : 0.82;
	              try {
	                if (typeof dot.setLocalPosition === 'function') dot.setLocalPosition(Math.cos(angle) * markerRadius, 0, Math.sin(angle) * markerRadius);
	                else dot.setPosition(Math.cos(angle) * markerRadius, 0, Math.sin(angle) * markerRadius);
	              } catch(eMarkerDotPos) {}
	              dot.setLocalScale(0.16, 0.16, 0.16);
	              applyMaterial(dot, targetMarkerMat);
	            }
	          } catch(eGuidanceLineCreate) {}
	          function hideLegacySourceGuidance() {
	            try {
	              if (!pcApp || !pcApp.root || typeof pcApp.root.findByName !== 'function') return;
	              var legacy = pcApp.root.findByName('__SourceTrailLine');
	              if (legacy) {
	                legacy.enabled = false;
	                if (typeof legacy.setPosition === 'function') legacy.setPosition(0, -999, 0);
	              }
	            } catch(eLegacyGuidance) {}
	          }
	          function guidanceLineVisible(visible) {
	            if (storyboardGuidanceLine) storyboardGuidanceLine.enabled = !!visible;
	          }
	          function targetMarkerVisible(visible) {
	            if (storyboardTargetMarker) storyboardTargetMarker.enabled = !!visible;
	            if (!visible) {
	              try { window.__storyboardTargetMarkerState = { visible: false }; } catch(eMarkerState) {}
	            }
	          }
	          function sourceGuidanceTargetName(gs) {
	            var sourcePhase = sourcePhaseForOverlayState(gs);
	            var sourcePhaseInfo = null;
	            try {
	              var phaseId = gs && (gs.currentPhase || gs.phase) || '';
	              sourcePhaseInfo = blueprintResolveSourcePhase(gs, blueprintPhaseSets(manifest), phaseId);
	            } catch(ePhaseInfo) {}
	            var showSet = {};
	            if (sourcePhase && Array.isArray(sourcePhase.showEntities)) {
	              for (var se = 0; se < sourcePhase.showEntities.length; se++) {
	                showSet[String(sourcePhase.showEntities[se])] = true;
	              }
	            }
	            function directName(value) {
	              if (!value) return null;
	              var raw = String(value);
	              if (entityRoots[raw]) return raw;
	              var mapped = anchorOverlayName(raw);
	              return entityRoots[mapped] ? mapped : null;
	            }
	            var hud = sourcePhase && sourcePhase.hudText || {};
	            var direct = directName(hud.targetEntity) || directName(sourcePhase && sourcePhase.targetEntity);
	            var phaseIdentity = String(sourcePhase && (sourcePhase.id || sourcePhase.phaseId || sourcePhase.name) || gs && (gs.currentPhase || gs.phase) || 'phase');
	            function normalizedStateKey(value) {
	              return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
	            }
	            function stateKeyVariants(value) {
	              var raw = String(value || '');
	              if (!raw) return [];
	              var upper = raw.charAt(0).toUpperCase() + raw.slice(1);
	              var lower = raw.charAt(0).toLowerCase() + raw.slice(1);
	              var compact = normalizedStateKey(raw);
	              return [raw, upper, lower, compact];
	            }
	            function numericStateValue(names) {
	              var bags = [
	                gs && gs.resources,
	                gs && gs.inventory,
	                gs && gs.variables,
	                gs && gs.counters,
	                gs && gs.resourceCounts
	              ];
	              for (var bi = 0; bi < bags.length; bi++) {
	                var bag = bags[bi];
	                if (!bag || typeof bag !== 'object') continue;
	                for (var ni = 0; ni < names.length; ni++) {
	                  var key = names[ni];
	                  if (Object.prototype.hasOwnProperty.call(bag, key) && isFinite(Number(bag[key]))) return Number(bag[key]);
	                }
	              }
	              return 0;
	            }
	            function entityStateFor(name) {
	              var states = gs && (gs.entity_states || gs.entityStates) || {};
	              var variants = stateKeyVariants(name);
	              for (var vi = 0; vi < variants.length; vi++) {
	                var key = variants[vi];
	                if (states[key]) return states[key];
	              }
	              var normalized = normalizedStateKey(name);
	              var keys = Object.keys(states);
	              for (var ki = 0; ki < keys.length; ki++) {
	                if (normalizedStateKey(keys[ki]) === normalized) return states[keys[ki]];
	              }
	              return null;
	            }
	            function targetVisibleName(value) {
	              var mapped = directName(value);
	              if (!mapped || isStoryboardPlayerName(mapped)) return null;
	              if (Object.keys(showSet).length && !showSet[mapped] && !showSet[String(value)]) return null;
	              var st = entityStateFor(mapped);
	              if (st && (st.visible === false || (st.position && isFinite(Number(st.position.y)) && Number(st.position.y) < -100))) return null;
	              return mapped;
	            }
	            function resourceValue(name) {
	              var variants = stateKeyVariants(name);
	              return numericStateValue(variants);
	            }
	            function carriedValue(name) {
	              var variants = stateKeyVariants(name);
	              var names = [];
	              for (var vi = 0; vi < variants.length; vi++) {
	                names.push(variants[vi] + 'Carried');
	                names.push(variants[vi] + 'Carry');
	              }
	              return numericStateValue(names);
	            }
	            function baselineValue(name) {
	              try {
	                var store = window.__bpSourceGuidanceBaselines || (window.__bpSourceGuidanceBaselines = {});
	                var phaseStore = store[phaseIdentity] || (store[phaseIdentity] = {});
	                var key = normalizedStateKey(name);
	                if (!Object.prototype.hasOwnProperty.call(phaseStore, key)) phaseStore[key] = resourceValue(name);
	                return Number(phaseStore[key]) || 0;
	              } catch(eBaseline) {}
	              return 0;
	            }
	            function resourceProgressThisPhase(name) {
	              return Math.max(0, resourceValue(name) - baselineValue(name));
	            }
	            function entityStepSatisfied(name) {
	              var st = entityStateFor(name);
	              if (!st) return false;
	              return st.done === true || st.completed === true || st.status === 'done' || st.status === 'complete' ||
	                st.state === 'done' || st.state === 'complete' || Number(st.progress || 0) >= 1 ||
	                Number(st.upgradeLevel || st.level || 0) > 0;
	            }
	            function stepSatisfied(step) {
	              if (!step || typeof step !== 'object') return true;
	              if (step.gain) {
	                var amount = Number(step.amount || 1);
	                if (!isFinite(amount) || amount <= 0) amount = 1;
	                return carriedValue(step.gain) >= amount || resourceProgressThisPhase(step.gain) >= amount;
	              }
	              if (step.setEntity) return entityStepSatisfied(step.setEntity);
	              return false;
	            }
	            function phasePrimaryTarget() {
	              var steps = [];
	              if (sourcePhase && Array.isArray(sourcePhase.steps)) steps = sourcePhase.steps;
	              else if (sourcePhase && sourcePhase.interactionGate && Array.isArray(sourcePhase.interactionGate.steps)) steps = sourcePhase.interactionGate.steps;
	              for (var psi = 0; psi < steps.length; psi++) {
	                var rawTarget = steps[psi] && (steps[psi].target || steps[psi].setEntity || steps[psi].ctaEntity);
	                var mapped = directName(rawTarget);
	                if (mapped && !isStoryboardPlayerName(mapped)) return mapped;
	              }
	              return null;
	            }
	            function phaseStepTarget() {
	              var steps = [];
	              if (sourcePhase && Array.isArray(sourcePhase.steps)) steps = sourcePhase.steps;
	              else if (sourcePhase && sourcePhase.interactionGate && Array.isArray(sourcePhase.interactionGate.steps)) steps = sourcePhase.interactionGate.steps;
	              for (var si = 0; si < steps.length; si++) {
	                var step = steps[si];
	                if (!step || stepSatisfied(step)) continue;
	                var target = targetVisibleName(step.target || step.setEntity);
	                if (target) return target;
	              }
	              for (var fi = 0; fi < steps.length; fi++) {
	                var fallback = targetVisibleName(steps[fi] && (steps[fi].target || steps[fi].setEntity));
	                if (fallback) return fallback;
	              }
	              return null;
	            }
	            var primaryTarget = phasePrimaryTarget();
	            if (primaryTarget && !isStoryboardPlayerName(primaryTarget)) return primaryTarget;
	            var stepTarget = phaseStepTarget();
	            if (stepTarget && !isStoryboardPlayerName(stepTarget)) return stepTarget;
	            var ui = gs && (gs.uiState || gs.ui_state) || {};
	            var uiTarget = directName(ui.highlightTarget) ||
	              directName(ui.highlightOverlay && ui.highlightOverlay.target) ||
	              directName(ui.highlightState && ui.highlightState.target);
	            if (uiTarget && !isStoryboardPlayerName(uiTarget)) return uiTarget;
	            if (direct && !isStoryboardPlayerName(direct)) return direct;
	            var textParts = [];
	            function addText(value) {
	              if (value == null) return;
	              if (typeof value === 'string') textParts.push(value);
	              else if (Array.isArray(value)) {
	                for (var ti = 0; ti < value.length; ti++) addText(value[ti]);
	              } else if (typeof value === 'object') {
	                Object.keys(value).forEach(function(key) { addText(value[key]); });
	              }
	            }
	            addText(sourcePhase);
	            var haystack = textParts.join(' ');
	            var bestName = null;
	            var bestIndex = Infinity;
	            Object.keys(entityRoots).forEach(function(candidate) {
	              if (isStoryboardPlayerName(candidate) || /^(GoldUI|GuideUI)$/i.test(candidate)) return;
	              if (Object.keys(showSet).length && !showSet[candidate]) return;
	              var st = styles[candidate] || {};
	              var tokens = [candidate, st.label, st.kind].filter(Boolean);
	              for (var ti = 0; ti < tokens.length; ti++) {
	                var token = String(tokens[ti]);
	                if (!token || token.length < 2) continue;
	                var idx = haystack.indexOf(token);
	                if (idx >= 0 && idx < bestIndex) {
	                  bestIndex = idx;
	                  bestName = candidate;
	                }
	              }
	            });
	            if (bestName) return bestName;
	            if (sourcePhase && Array.isArray(sourcePhase.showEntities)) {
	              for (var si = 0; si < sourcePhase.showEntities.length; si++) {
	                var name = directName(sourcePhase.showEntities[si]);
	                if (name && !isStoryboardPlayerName(name) && !/^(GoldUI|GuideUI)$/i.test(name)) return name;
	              }
	            }
	            return null;
	          }
          function entityOverlayPosition(name) {
            var ent = entityRoots[name];
            if (!ent || ent.enabled === false || typeof ent.getPosition !== 'function') return null;
            var p = ent.getPosition();
            return p ? p.clone() : null;
          }
          function runtimeStoryboardEntityOverlayPosition(name, gs) {
            try {
              if (!name || !gs) return null;
              var states = gs && (gs.entity_states || gs.entityStates) || {};
              var st = states[name] || states[String(name).toLowerCase()] || states[String(name).charAt(0).toUpperCase() + String(name).slice(1)];
              var p = st && st.position;
              if (!p || !isFinite(Number(p.x)) || !isFinite(Number(p.z)) || Number(p.y) <= -100) return null;
              return new pc.Vec3(storyboardRenderX(p.x), Number(p.y) || 0, storyboardRenderZForName(name, p.z));
            } catch(eRuntimeTargetPos) {}
            return null;
          }
          function updateStoryboardGuidanceLine(gs) {
            hideLegacySourceGuidance();
            if (!storyboardGuidanceLine) {
	              window.__storyboardGuidanceLineState = { visible: false, reason: 'line-unavailable' };
	              targetMarkerVisible(false);
	              return;
	            }
	            var playerName = null;
	            Object.keys(entityRoots).some(function(name) {
	              if (isStoryboardPlayerName(name)) {
	                playerName = name;
	                return true;
	              }
	              return false;
            });
            var targetName = sourceGuidanceTargetName(gs);
            var a = entityOverlayPosition(playerName);
            var b = runtimeStoryboardEntityOverlayPosition(targetName, gs) || entityOverlayPosition(targetName);
            if (!a || !b) {
              window.__storyboardGuidanceLineState = { visible: false, reason: 'endpoint-unavailable', playerName: playerName, targetName: targetName };
              guidanceLineVisible(false);
	              targetMarkerVisible(false);
	              return;
	            }
	            a.y = 0.95;
	            b.y = 0.95;
	            var d = b.clone().sub(a);
	            var len = d.length();
	            if (!isFinite(len) || len < 0.1) {
	              window.__storyboardGuidanceLineState = { visible: false, reason: 'too-short', playerName: playerName, targetName: targetName, length: len };
	              guidanceLineVisible(false);
	              targetMarkerVisible(false);
	              return;
	            }
	            guidanceLineVisible(true);
	            storyboardGuidanceLine.setPosition(a.clone().add(b).scale(0.5));
	            try {
	              if (typeof storyboardGuidanceLine.lookAt === 'function') storyboardGuidanceLine.lookAt(b.x, b.y, b.z);
	              else if (typeof storyboardGuidanceLine.setRotation === 'function') {
	                var q = new pc.Quat();
	                if (typeof q.lookRotation === 'function') storyboardGuidanceLine.setRotation(q.lookRotation(d.clone().normalize(), pc.Vec3.UP));
	              }
	            } catch(eGuidanceLook) {}
	            storyboardGuidanceLine.setLocalScale(0.045, 0.045, len);
	            if (storyboardTargetMarker) {
	              targetMarkerVisible(true);
	              storyboardTargetMarker.setPosition(b.x, 0.18, b.z);
	              var markerPulse = 1 + 0.08 * Math.sin(storyboardNowMs() / 170);
	              storyboardTargetMarker.setLocalScale(markerPulse, markerPulse, markerPulse);
	            }
	            window.__storyboardGuidanceLine = storyboardGuidanceLine;
	            window.__storyboardGuidanceLineState = {
	              visible: true,
	              playerName: playerName,
	              targetName: targetName,
	              player: { x: a.x, y: a.y, z: a.z },
	              target: { x: b.x, y: b.y, z: b.z },
	              length: len
	            };
            window.__storyboardTargetMarker = storyboardTargetMarker;
            window.__storyboardTargetMarkerState = storyboardTargetMarker ? {
              visible: true,
              targetName: targetName,
              position: { x: b.x, y: 0.18, z: b.z },
              screenRect: entityScreenRect(storyboardTargetMarker)
            } : { visible: false, reason: 'marker-unavailable', targetName: targetName };
          }
	          function syncEntityPositions() {
	            var gs = null;
	            try { gs = typeof window.__gameState === 'function' ? window.__gameState() : window.__gameState; } catch(e) {}
            hideLegacyStoryboardVisualSurfaces();
            var states = gs && (gs.entity_states || gs.entityStates) || {};
            var viewportAnchored = currentViewportAnchoredOverlays(gs);
            var anchorPhase = projectedAnchorPhaseForOverlayState(gs);
            var phaseId = anchorPhase && anchorPhase.id || gs && (gs.currentPhase || gs.phase) || 'current';
            var fitForPhase = anchorFitApplied[phaseId] || {};
            var sourcePhase = sourcePhaseForOverlayState(gs);
            var sourceVisible = phaseVisibleMap(sourcePhase);
            // Source-faithful storyboard POSITION (2026-06-01): place the overlay from the
            // SOURCE contract (sourceEntityContract.entityStyles[name].position) — distinct,
            // matches the source storyboard layout — instead of the game's runtime
            // entity_states.position, which collapses several entity pairs
            // (SpaceBase/DrillUpgradeStation, MeltingFurnace/Electrolyzer, IcePile/AutoMinerNPC)
            // onto identical coords and stacks their composites + head worldLabels. The PLAYER
            // is exempt: it tracks the live game position so it can walk (its label follows via
            // tickWorldLabels); when the game parks/hides it (y<=-100 sentinel) or exposes no
            // matching key, fall back to source. Off-switch: window.__DISABLE_STORYBOARD_CONTRACT_VISIBILITY.
            var __sfStyles = (manifest.sourceEntityContract && manifest.sourceEntityContract.entityStyles) || {};
            var __contractPos = !(typeof window !== 'undefined' && window.__DISABLE_STORYBOARD_CONTRACT_VISIBILITY);
            Object.keys(entityRoots).forEach(function(name) {
              var st = states[name];
              var p = st && st.position;
              var isPlayer = isStoryboardPlayerName(name);
              if (__contractPos) {
                var sp = __sfStyles[name] && __sfStyles[name].position;
                if (isPlayer) {
                  var gp = st && st.position;
                  if (!gp) { var pst = states['player'] || states['Player'] || states[name.toLowerCase()]; gp = pst && pst.position; }
                  if (gp) p = gp;
                  if (p && isFinite(Number(p.x)) && Number(p.y) > -100) p = gp;
                  else if (sp && isFinite(Number(sp.x))) p = sp;
                  else p = gp;
                } else if (sp && isFinite(Number(sp.x))) {
                  p = sp;
                }
              }
              if (isPlayer) {
                var livePlayerPos = runtimeStoryboardPlayerSourcePosition();
                if (livePlayerPos) p = livePlayerPos;
                p = manualStoryboardPlayerSourcePosition(name, p, !!livePlayerPos);
              }
              if (p && isFinite(Number(p.x)) && isFinite(Number(p.z)) && !(viewportAnchored[name] && fitForPhase[name] && !isPlayer)) {
                setStoryboardEntityPosition(name, storyboardRenderX(p.x), Number(p.y) || 0, storyboardRenderZForName(name, p.z), isPlayer);
              }
              if (sourceVisible && !isStoryboardHudEntityName(name)) entityRoots[name].enabled = !!sourceVisible[name];
              else if (st && st.visible === false) entityRoots[name].enabled = false;
              else entityRoots[name].enabled = true;
            });
            var now = Date.now ? Date.now() : (new Date()).getTime();
            if (phaseId !== syncEntityPositions._anchorPhaseId || now - (syncEntityPositions._anchorAt || 0) > 500) {
              syncEntityPositions._anchorPhaseId = phaseId;
	              syncEntityPositions._anchorAt = now;
	              applyProjectedAnchorCalibration(gs);
	            }
	            updateStoryboardGuidanceLine(gs);
	          }
          window.__storyboardEntityRoots = entityRoots;
          window.__syncStoryboardEntities = syncEntityPositions;
          window.__storyboardEntityScreenRect = function(name) {
            var overlayName = anchorOverlayName(name);
            var ent = entityRoots[overlayName] || entityRoots[name];
            return ent && ent.enabled !== false ? entityScreenRect(ent) : null;
          };
          syncEntityPositions();
          (function frameSyncEntityPositions() {
            try { syncEntityPositions(); } catch(eFrameSync) {}
            if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(frameSyncEntityPositions);
            else setTimeout(frameSyncEntityPositions, 33);
          })();
          installStoryboardDomHud();
          installStoryboardWorldLabels();
          console.log('[AI] Storyboard visual overlay active: entities=' + Object.keys(entityRoots).length);
        } catch(overlayErr) {
          console.error('[AI] Storyboard visual overlay error:', overlayErr);
        }
      }

      function installStoryboardDomHud() {
        if (document.getElementById('bp-storyboard-hud')) return;
        var legacyTextStyle = document.createElement('style');
        legacyTextStyle.textContent = '#__bp_text_overlay{display:none!important;visibility:hidden!important}';
        document.head.appendChild(legacyTextStyle);
        var style = document.createElement('style');
        style.textContent = '#bp-storyboard-scene-tone{position:fixed;inset:0;z-index:2147482800;pointer-events:none;background:linear-gradient(90deg,rgba(5,9,20,.76) 0%,rgba(5,9,20,.72) 42%,rgba(5,9,20,.50) 62%,rgba(5,9,20,.25) 82%,rgba(5,9,20,.05) 100%)}#bp-storyboard-hud{position:fixed;left:12px;right:12px;top:10px;z-index:2147483000;display:flex;align-items:center;gap:8px;pointer-events:none;font-family:Arial,"Microsoft YaHei",sans-serif;color:#f2fbff}#bp-storyboard-hud .bp-pill,#bp-storyboard-hud .bp-phase{background:rgba(4,13,31,.82);border:1px solid rgba(118,214,255,.35);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.28);font-weight:900;white-space:nowrap}#bp-storyboard-hud .bp-phase{padding:8px 10px;color:#9fe8ff;font-size:13px}#bp-storyboard-hud .bp-pill{padding:8px 10px;font-size:13px}#bp-storyboard-hud .bp-tip{flex:1;min-height:24px;display:flex;align-items:center;justify-content:flex-end;text-align:right;padding:0 4px;font-size:13px;font-weight:900;color:#ffeb3b;background:transparent;border:0;box-shadow:none;white-space:nowrap}#bp-storyboard-target{position:fixed;left:14px;top:54px;z-index:2147483000;transform:none;background:rgba(10,22,64,.92);border:1px solid rgba(118,214,255,.35);border-radius:7px;padding:5px 10px;font:900 13px Arial,"Microsoft YaHei";color:#bff5ff;pointer-events:none}#bp-storyboard-stick{position:fixed;width:88px;height:88px;margin:-44px 0 0 -44px;border-radius:50%;z-index:2147483001;background:rgba(0,0,0,.42);border:0;box-shadow:0 8px 22px rgba(0,0,0,.38);pointer-events:none;opacity:0}#bp-storyboard-stick.active{opacity:1}#bp-storyboard-stick:before{content:"";position:absolute;left:50%;top:50%;width:42px;height:42px;border-radius:50%;transform:translate(-50%,-50%);border:1px dashed rgba(255,255,255,.35)}#bp-storyboard-knob{position:absolute;left:50%;top:50%;width:38px;height:38px;margin:-19px 0 0 -19px;border-radius:50%;background:rgba(255,255,255,.9);border:0;box-shadow:0 4px 14px rgba(0,0,0,.34)}';
        document.head.appendChild(style);
        function sourceDomHudOwnsStoryboardDom() {
          try {
            var va = window.__BLUEPRINT_VISUAL_ASSETS__ || {};
            var contract = va.sourceEntityContract && va.sourceEntityContract.domHudContract;
            return !!(window.__BLUEPRINT_SOURCE_RUNTIME_ACTIVE__ || contract && contract.present);
          } catch(eSourceHudOwns) {
            return false;
          }
        }
        function applyStoryboardDomHudVisibility() {
          var hidden = sourceDomHudOwnsStoryboardDom();
          ['bp-storyboard-scene-tone', 'bp-storyboard-hud', 'bp-storyboard-target'].forEach(function(id) {
            var el = document.getElementById(id);
            if (!el) return;
            el.style.display = hidden ? 'none' : '';
            el.style.visibility = hidden ? 'hidden' : '';
            el.style.opacity = hidden ? '0' : '';
          });
          return hidden;
        }
        var sceneTone = document.createElement('div');
        sceneTone.id = 'bp-storyboard-scene-tone';
        document.body.appendChild(sceneTone);
        var hud = document.createElement('div');
        hud.id = 'bp-storyboard-hud';
        hud.innerHTML = '<div class="bp-phase" id="bp-storyboard-phase">Phase 1/?</div><div class="bp-pill" id="bp-storyboard-ice">冰 0</div><div class="bp-pill" id="bp-storyboard-oxygen">氧气 0</div><div class="bp-pill" id="bp-storyboard-scrap">铁块 0</div><div class="bp-pill" id="bp-storyboard-coin">金币 0</div><div class="bp-pill" id="bp-storyboard-tool">镐子</div><div class="bp-tip" id="bp-storyboard-tip"></div>';
        document.body.appendChild(hud);
        var target = document.createElement('div');
        target.id = 'bp-storyboard-target';
        target.textContent = '目标';
        document.body.appendChild(target);
        applyStoryboardDomHudVisibility();
        var stick = document.createElement('div');
        stick.id = 'bp-storyboard-stick';
        stick.innerHTML = '<div id="bp-storyboard-knob"></div>';
        document.body.appendChild(stick);
        var knob = document.getElementById('bp-storyboard-knob');
        var origin = { x: 0, y: 0 };
        var STORYBOARD_STICK_DEADZONE = 4;
        var manualJoystickOverride = window.__bpManualJoystickOverride || { active: false, x: 0, y: 0, updatedAt: 0, speed: 6 };
        window.__bpManualJoystickOverride = manualJoystickOverride;
        var manualClickOverride = window.__bpManualClickOverride || { pending: false, x: 0, y: 0, updatedAt: 0, until: 0 };
        window.__bpManualClickOverride = manualClickOverride;
        var directRuntimePlayerJoystick = { last: 0 };
        function joystickNowMs() {
          try {
            if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') return performance.now();
          } catch(e) {}
          return Date.now ? Date.now() : (new Date()).getTime();
        }
        function bridgeVector3(x, y, z) {
          try { return new UnityEngine.Vector3.ctor$1(x, y, z); } catch(eCtor1) {}
          try { var v = new UnityEngine.Vector3(); v.x = x; v.y = y; v.z = z; return v; } catch(eCtor) {}
          return { x: x, y: y, z: z };
        }
        function runtimePlayerInstance() {
          try { return window.GFM_Player && (window.GFM_Player.Instance || window.GFM_Player.instance || window.GFM_Player._instance); } catch(e) {}
          return null;
        }
        function runtimePlayerGameObject(player) {
          return player && (player.Go || player.go || player._player) || null;
        }
        function tickDirectRuntimePlayerJoystick() {
          try {
            var joy = window.__bpManualJoystickOverride;
            if (!joy || !joy.active) {
              directRuntimePlayerJoystick.last = 0;
            } else {
              var player = runtimePlayerInstance();
              var go = runtimePlayerGameObject(player);
              var tr = go && go.transform;
              var pos = tr && tr.position;
              if (player && tr && pos) {
                var now = joystickNowMs();
                var last = directRuntimePlayerJoystick.last || now;
                var dt = Math.max(0, Math.min(0.035, (now - last) / 1000 || 0.016));
                directRuntimePlayerJoystick.last = now;
                if (dt > 0) {
                  var speed = Number(joy.speed) || 6;
                  var before = bridgeVector3(Number(pos.x) || 0, Number(pos.y) || 0, Number(pos.z) || 0);
                  var after = bridgeVector3(before.x - (Number(joy.x) || 0) * speed * dt, before.y, before.z - (Number(joy.y) || 0) * speed * dt);
                  tr.position = after;
                  player._hasManualMoveInput = true;
                  player._lastManualMoveActive = true;
                  player._lastManualMoveBefore = before;
                  player._lastManualMoveAfter = after;
                }
              }
            }
          } catch(eDirectJoystick) {}
          requestAnimationFrame(tickDirectRuntimePlayerJoystick);
        }
        if (!window.__bpDirectRuntimePlayerJoystickLoop) {
          window.__bpDirectRuntimePlayerJoystickLoop = true;
          requestAnimationFrame(tickDirectRuntimePlayerJoystick);
        }
        function installRuntimeJoystickOverridePatch(joystick) {
          if (!joystick || joystick.__bpPollInputPatched) return;
          var originalPollInput = joystick.PollInput;
          if (typeof originalPollInput !== 'function') return;
          joystick.__bpOriginalPollInput = originalPollInput;
          joystick.PollInput = function() {
            try {
              var override = window.__bpManualJoystickOverride;
              var now = joystickNowMs();
              if (override && (override.active || now - (override.updatedAt || 0) < 160)) {
                var active = !!override.active;
                this._dragging = active;
                if (this._input) {
                  this._input.x = active ? (Number(override.x) || 0) : 0;
                  this._input.y = active ? (Number(override.y) || 0) : 0;
                }
                return;
              }
            } catch(eOverridePoll) {}
            return originalPollInput.apply(this, arguments);
          };
          joystick.__bpPollInputPatched = true;
        }
        function applyRuntimeClickOverride(x, y) {
          var now = joystickNowMs();
          manualClickOverride.pending = true;
          manualClickOverride.x = Number(x) || 0;
          manualClickOverride.y = Number(y) || 0;
          manualClickOverride.updatedAt = now;
          manualClickOverride.until = now + 220;
          try {
            var input = window.UnityEngine && UnityEngine.Input;
            if (input) {
              installRuntimeClickOverridePatch(input);
              if (input.mouseButtonsDown) input.mouseButtonsDown[0] = true;
              if (input.mouseButtons) input.mouseButtons[0] = true;
              input.mousePosition = bridgeVector3(manualClickOverride.x, Math.max(0, (window.innerHeight || 0) - manualClickOverride.y), 0);
            }
          } catch(eRuntimeClickApply) {}
        }
        window.__bpApplyManualClickOverride = applyRuntimeClickOverride;
        function installRuntimeClickOverridePatch(input) {
          if (!input || input.__bpClickOverridePatched) return;
          var originalGetMouseButtonDown = input.GetMouseButtonDown;
          if (typeof originalGetMouseButtonDown !== 'function') return;
          input.__bpOriginalGetMouseButtonDown = originalGetMouseButtonDown;
          input.GetMouseButtonDown = function(button) {
            try {
              var click = window.__bpManualClickOverride;
              var now = joystickNowMs();
              if (click && click.pending && button === 0 && now <= (Number(click.until) || 0)) return true;
              if (click && click.pending && now > (Number(click.until) || 0)) click.pending = false;
            } catch(eOverrideClick) {}
            return originalGetMouseButtonDown.apply(this, arguments);
          };
          input.__bpClickOverridePatched = true;
        }
        function tickRuntimeClickOverridePatch() {
          try {
            var input = window.UnityEngine && UnityEngine.Input;
            installRuntimeClickOverridePatch(input);
          } catch(eTickClickOverride) {}
          requestAnimationFrame(tickRuntimeClickOverridePatch);
        }
        if (!window.__bpRuntimeClickOverrideLoop) {
          window.__bpRuntimeClickOverrideLoop = true;
          requestAnimationFrame(tickRuntimeClickOverridePatch);
        }
        function applyRuntimeJoystickOverride(x, y, active) {
          x = Number(x) || 0;
          y = Number(y) || 0;
          var mag = Math.sqrt(x * x + y * y);
          if (mag > 1) {
            x /= mag;
            y /= mag;
          }
          manualJoystickOverride.active = !!active;
          manualJoystickOverride.x = active ? x : 0;
          manualJoystickOverride.y = active ? y : 0;
          manualJoystickOverride.updatedAt = joystickNowMs();
          manualJoystickOverride.speed = 6;
          try {
            var joystickClass = window.GFM_Joystick;
            var joystick = joystickClass && (joystickClass.instance || joystickClass.Instance);
            installRuntimeJoystickOverridePatch(joystick);
            if (joystick && joystick._input) {
              joystick._dragging = !!active;
              joystick._input.x = active ? x : 0;
              joystick._input.y = active ? y : 0;
            }
          } catch(eRuntimeJoystick) {}
        }
        function beginStoryboardStick(clientX, clientY) {
          origin.x = clientX; origin.y = clientY;
          origin.moved = false;
          stick.style.left = clientX + 'px';
          stick.style.top = clientY + 'px';
          stick.className = 'active';
          applyRuntimeJoystickOverride(0, 0, false);
        }
        function moveStoryboardStick(clientX, clientY) {
          if (stick.className !== 'active') return;
          var dx = clientX - origin.x, dy = clientY - origin.y;
          var len = Math.sqrt(dx*dx+dy*dy), max = 44;
          if (len <= STORYBOARD_STICK_DEADZONE) {
            knob.style.transform = 'translate(0,0)';
            applyRuntimeJoystickOverride(0, 0, false);
            return;
          }
          origin.moved = true;
          if (len > max) { dx = dx / len * max; dy = dy / len * max; }
          knob.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
          applyRuntimeJoystickOverride(-dx / max, -dy / max, true);
        }
        function firstTouchPoint(ev) {
          var touches = ev && (ev.touches && ev.touches.length ? ev.touches : ev.changedTouches);
          return touches && touches.length ? touches[0] : null;
        }
        document.addEventListener('pointerdown', function(ev) {
          beginStoryboardStick(ev.clientX, ev.clientY);
        }, true);
        document.addEventListener('pointermove', function(ev) {
          moveStoryboardStick(ev.clientX, ev.clientY);
        }, true);
        function resetStick(ev) {
          var tapPoint = null;
          try {
            var t = firstTouchPoint(ev);
            if (t) tapPoint = { x: t.clientX, y: t.clientY };
            else if (ev && isFinite(Number(ev.clientX)) && isFinite(Number(ev.clientY))) tapPoint = { x: Number(ev.clientX), y: Number(ev.clientY) };
          } catch(eTapPoint) {}
          if (tapPoint) {
            var tdx = tapPoint.x - origin.x;
            var tdy = tapPoint.y - origin.y;
            if (!origin.moved && Math.sqrt(tdx * tdx + tdy * tdy) <= STORYBOARD_STICK_DEADZONE * 2) {
              applyRuntimeClickOverride(tapPoint.x, tapPoint.y);
            }
          }
          stick.className = ''; knob.style.transform = 'translate(0,0)'; applyRuntimeJoystickOverride(0, 0, false);
        }
        document.addEventListener('pointerup', resetStick, true);
        document.addEventListener('pointercancel', resetStick, true);
        document.addEventListener('touchstart', function(ev) {
          var t = firstTouchPoint(ev);
          if (!t) return;
          beginStoryboardStick(t.clientX, t.clientY);
          try { ev.preventDefault(); } catch(ePreventStart) {}
        }, true);
        document.addEventListener('touchmove', function(ev) {
          var t = firstTouchPoint(ev);
          if (!t) return;
          moveStoryboardStick(t.clientX, t.clientY);
          try { ev.preventDefault(); } catch(ePreventMove) {}
        }, true);
        document.addEventListener('touchend', resetStick, true);
        document.addEventListener('touchcancel', resetStick, true);
        function set(id, text) { var el = document.getElementById(id); if (el) el.textContent = text; }
        function canonicalStoryboardEntityName(raw) {
          raw = String(raw || '');
          if (!raw) return '';
          raw = raw.replace(/^_+/, '');
          if (!raw) return '';
          return raw.charAt(0).toUpperCase() + raw.slice(1);
        }
        function storyboardEntityLabel(name) {
          var key = canonicalStoryboardEntityName(name);
          if (!key) return '';
          try {
            var va = window.__BLUEPRINT_VISUAL_ASSETS__ || {};
            var styles = va.sourceEntityContract && va.sourceEntityContract.entityStyles || {};
            var st = styles[key] || styles[name];
            if (st && typeof st.label === 'string' && st.label) return st.label;
            var ents = va.fidelityContract && va.fidelityContract.entities || [];
            for (var ei = 0; ei < ents.length; ei++) {
              var ent = ents[ei];
              if (!ent) continue;
              var entKey = canonicalStoryboardEntityName(ent.id || ent.name);
              if (entKey !== key) continue;
              var wl = ent.worldLabel;
              if (wl && typeof wl.text === 'string' && wl.text) return wl.text;
            }
          } catch(e) {}
          return key;
        }
        function phaseFirstStoryboardTarget(phaseId, gs) {
          try {
            var va = window.__BLUEPRINT_VISUAL_ASSETS__ || {};
            var phases = va.sourcePhaseContract && va.sourcePhaseContract.phases;
            if ((!phases || !phases.length) && va.fidelityContract) phases = va.fidelityContract.phases;
            if (!phases || !phases.length) return '';
            var sourcePhases = phases;
            for (var si = 0; si < sourcePhases.length; si++) {
              if (!driverPhaseMatches(sourcePhases[si], driverNormalizePhaseKey(phaseId))) continue;
              if (sourcePhases[si].steps && sourcePhases[si].steps[0] && sourcePhases[si].steps[0].target) return sourcePhases[si].steps[0].target;
            }
            var resolved = blueprintResolveSourcePhase(gs || null, [phases], phaseId);
            var phase = resolved && resolved.phase;
            if (!phase) return '';
            if (phase.steps && phase.steps[0] && phase.steps[0].target) return phase.steps[0].target;
            var ig = phase.interactionGate;
            if (ig && ig.steps && ig.steps[0] && ig.steps[0].target) return ig.steps[0].target;
            if (phase.trigger && phase.trigger.targetEntity) return phase.trigger.targetEntity;
          } catch(e) {}
          return '';
        }
        function currentStoryboardTargetLabel(gs, phaseId) {
          try {
            var uiLabelState = gs && (gs.uiState || gs.ui_state) || {};
            var explicitLabel = uiLabelState && (uiLabelState.targetLabel || uiLabelState.highlightState && uiLabelState.highlightState.label || uiLabelState.highlightOverlay && uiLabelState.highlightOverlay.label) || '';
            if (explicitLabel) return '目标：' + explicitLabel;
          } catch(eExplicitTargetLabel) {}
          try {
            var ui = gs && (gs.uiState || gs.ui_state) || {};
            var score = ui && ui.scoreText || '';
            var m = String(score || '').match(/目标[:：]\\s*([^\\s]+)/);
            if (m && m[1]) return '目标：' + m[1];
          } catch(eScoreTarget) {}
          var ui = gs && (gs.uiState || gs.ui_state) || {};
          var uiTarget = ui && (ui.highlightTarget || ui.highlightOverlay && ui.highlightOverlay.target || ui.highlightState && ui.highlightState.target) || '';
          var vars = gs && gs.variables || {};
          var target = uiTarget || vars.targetEntity || gs && gs.targetEntity || phaseFirstStoryboardTarget(phaseId, gs);
          var label = storyboardEntityLabel(target);
          return label ? '目标：' + label : '目标';
        }
        function storyboardPositiveNumber(value) {
          var n = Number(value);
          return isFinite(n) && n > 0 ? n : 0;
        }
        function storyboardRuntimePhaseTotal(gs) {
          var vars = gs && gs.variables || {};
          return storyboardPositiveNumber(vars.totalPhases)
            || storyboardPositiveNumber(gs && gs.totalPhases)
            || storyboardPositiveNumber(gs && gs.total_phases);
        }
        function storyboardRuntimePhaseIndex(gs) {
          var vars = gs && gs.variables || {};
          return storyboardPositiveNumber(vars.currentPhaseIndex)
            || storyboardPositiveNumber(gs && gs.currentPhaseIndex)
            || storyboardPositiveNumber(gs && gs.current_phase_index);
        }
        setInterval(function() {
          if (applyStoryboardDomHudVisibility()) return;
          var gs = null;
          try { gs = typeof window.__gameState === 'function' ? window.__gameState() : window.__gameState; } catch(e) {}
          try { gs = normalizeBlueprintGameState(gs, null); } catch(e2) {}
          try { if (typeof window.__gameState !== 'function') window.__gameState = gs; } catch(e3) {}
          gs = gs || {};
          var res = gs.resources || gs.inventory || {};
          var va = window.__BLUEPRINT_VISUAL_ASSETS__ || {};
          var phaseInfo = blueprintResolveSourcePhase(gs, blueprintPhaseSets(va), gs.currentPhase || gs.phase || null);
          var runtimePhaseNumber = storyboardRuntimePhaseIndex(gs);
          var phaseNumber = phaseInfo ? (phaseInfo.index + 1) : (runtimePhaseNumber || 1);
          var runtimePhaseTotal = storyboardRuntimePhaseTotal(gs);
          var phaseTotal = phaseInfo ? phaseInfo.total : (runtimePhaseTotal || '?');
          var sourcePhaseId = phaseInfo && phaseInfo.phase && phaseInfo.phase.id || ('phase' + phaseNumber);
          set('bp-storyboard-phase', 'Phase ' + phaseNumber + '/' + phaseTotal);
          set('bp-storyboard-ice', '冰 ' + (res.Ice || res.ice || 0));
          set('bp-storyboard-oxygen', '水 ' + (res.Water || res.water || res.BottledWater || res.bottledWater || 0));
          set('bp-storyboard-scrap', '苹果 ' + (res.Apple || res.apple || 0));
          set('bp-storyboard-coin', '金币 ' + (res.Coin || res.Gold || res.gold || 0));
          set('bp-storyboard-tool', '');
          try { var tool = document.getElementById('bp-storyboard-tool'); if (tool) tool.style.display = 'none'; } catch(eTool) {}
          var guide = gs.ui_state && gs.ui_state.guideText || gs.uiState && gs.uiState.guideText || gs.variables && gs.variables.guideText || '';
          set('bp-storyboard-tip', guide);
          set('bp-storyboard-target', currentStoryboardTargetLabel(gs, sourcePhaseId));
        }, 200);
      }
      // task #49 v1.4c-beta — render contract.entities[i].worldLabel as world-
      // space CJK overlay. Reads manifest.fidelityContract.entities[].worldLabel
      // (rich record), creates one DOM label per entity, projects entity worldPos
      // + worldOffset through camEnt.camera.worldToScreen each tick. v1.4e adds
      // projectedWorldLabels: when present, the label div is rect-fit directly
      // to the source-rendered screen rect and exposed through __targetWorldLabels.
      function installStoryboardWorldLabels() {
        if (document.getElementById('bp-storyboard-worldlabels')) return;
        var manifest = window.__BLUEPRINT_VISUAL_ASSETS__;
        var fc = manifest && manifest.fidelityContract;
        if (!fc || !Array.isArray(fc.entities)) return;
        var container = document.createElement('div');
        container.id = 'bp-storyboard-worldlabels';
        container.setAttribute('data-source-world-label-root', 'bp-source-world-labels');
        container.className = 'bp-source-world-labels';
        container.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:2147482900;font-family:Arial,"Microsoft YaHei",sans-serif;';
        document.body.appendChild(container);
        var labels = [];
        for (var i = 0; i < fc.entities.length; i++) {
          var e = fc.entities[i];
          if (!e || !e.worldLabel) continue;
          var wl = e.worldLabel;
          if (typeof wl.text !== 'string') continue;
          var entityId = e.id || e.name;
          if (!entityId) continue;
          var div = document.createElement('div');
          div.className = 'bp-worldlabel';
          div.setAttribute('data-entity', entityId);
          var col = (typeof wl.color === 'string' && wl.color) ? wl.color : '#ffffff';
          var fs = (typeof wl.fontSize === 'number' && wl.fontSize > 0) ? wl.fontSize : 26;
          div.style.cssText = 'position:absolute;transform:translate(-50%,-100%);padding:0 6px;background:transparent;border-radius:0;white-space:nowrap;color:' + col + ';font-size:' + (fs * 1.05).toFixed(1) + 'px;font-weight:800;-webkit-text-stroke:1px rgba(0,0,0,0.82);text-shadow:0 1px 2px rgba(0,0,0,0.95),0 0 4px rgba(0,0,0,0.85);display:none;';
          div.textContent = wl.text;
          container.appendChild(div);
          var wo = wl.worldOffset || {};
          var parentLeaf = String(e.parentPath || '').split('/').filter(Boolean).pop();
          labels.push({
            entityId: entityId,
            runtimeAliases: [entityId, e.name],
            sourceAliases: [parentLeaf],
            ox: Number(wo.x) || 0,
            oy: Number(wo.y) || 0,
            oz: Number(wo.z) || 0,
            div: div,
          });
        }
        function worldLabelViewportBaseline() {
          try {
            var candidates = [
              manifest && manifest.viewportBaseline,
              fc && fc.viewportBaseline,
              manifest && manifest.sourceFidelityContract && manifest.sourceFidelityContract.viewportBaseline
            ];
            for (var i = 0; i < candidates.length; i++) {
              var v = candidates[i];
              if (v && isFinite(Number(v.width)) && isFinite(Number(v.height))) {
                return { width: Number(v.width), height: Number(v.height) };
              }
            }
          } catch(e) {}
          return { width: 1280, height: 720 };
        }
        function worldLabelCanvasSize() {
          var canvas = document.getElementById('application-canvas') || document.querySelector('canvas');
          var rect = canvas && canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : null;
          return {
            width: rect && Number(rect.width) || canvas && Number(canvas.width) || window.innerWidth || 1280,
            height: rect && Number(rect.height) || canvas && Number(canvas.height) || window.innerHeight || 720
          };
        }
        function currentWorldLabelPhase() {
          try {
            var gs = typeof window.__gameState === 'function' ? window.__gameState() : window.__gameState;
            var phaseId = gs && (gs.currentPhase || gs.phase) || '';
            var phases = fc && fc.phases || [];
            var resolved = blueprintResolveSourcePhase(gs, [phases], phaseId);
            return resolved && resolved.phase || null;
          } catch(e) {}
          return null;
        }
        function worldLabelRecordValue(rec, keys) {
          for (var i = 0; i < keys.length; i++) {
            if (rec && rec[keys[i]] != null && isFinite(Number(rec[keys[i]]))) return Number(rec[keys[i]]);
          }
          return NaN;
        }
        function canonicalWorldLabelEntityName(raw) {
          raw = String(raw || '');
          if (!raw) return '';
          raw = raw.replace(/^_+/, '');
          if (!raw) return '';
          return raw.charAt(0).toUpperCase() + raw.slice(1);
        }
        function pushWorldLabelLookupKey(keys, raw) {
          raw = String(raw || '');
          if (!raw) return;
          for (var i = 0; i < keys.length; i++) {
            if (keys[i] === raw) return;
          }
          keys.push(raw);
        }
        function addWorldLabelLookupAliases(keys, raw, allowSourceKeyAlias) {
          raw = String(raw || '');
          if (!raw) return;
          pushWorldLabelLookupKey(keys, raw);
          var noUnder = raw.replace(/^_+/, '');
          if (!noUnder) return;
          pushWorldLabelLookupKey(keys, noUnder);
          pushWorldLabelLookupKey(keys, canonicalWorldLabelEntityName(raw));
          if (allowSourceKeyAlias || raw.charAt(0) === '_') {
            pushWorldLabelLookupKey(keys, '_' + noUnder.charAt(0).toLowerCase() + noUnder.slice(1));
          }
        }
        function normalizeProjectedWorldLabelRect(rec) {
          if (!rec || typeof rec !== 'object') return null;
          var x = worldLabelRecordValue(rec, ['x', 'x_px']);
          var y = worldLabelRecordValue(rec, ['y', 'y_px']);
          var w = worldLabelRecordValue(rec, ['width', 'w', 'w_px']);
          var h = worldLabelRecordValue(rec, ['height', 'h', 'h_px']);
          var cx = worldLabelRecordValue(rec, ['centerX', 'cx', 'center_x']);
          var cy = worldLabelRecordValue(rec, ['centerY', 'cy', 'center_y']);
          if (!isFinite(x) && isFinite(cx) && isFinite(w)) x = cx - w / 2;
          if (!isFinite(y) && isFinite(cy) && isFinite(h)) y = cy - h / 2;
          if (!isFinite(cx) && isFinite(x) && isFinite(w)) cx = x + w / 2;
          if (!isFinite(cy) && isFinite(y) && isFinite(h)) cy = y + h / 2;
          if (![x, y, w, h, cx, cy].every(isFinite)) return null;
          return { x: x, y: y, width: Math.max(0, w), height: Math.max(0, h), centerX: cx, centerY: cy };
        }
        function lookupProjectedWorldLabel(rects, entityId, runtimeAliases, sourceAliases) {
          if (!rects || typeof rects !== 'object') return null;
          var keys = [];
          addWorldLabelLookupAliases(keys, entityId, false);
          runtimeAliases = Array.isArray(runtimeAliases) ? runtimeAliases : [];
          for (var ai = 0; ai < runtimeAliases.length; ai++) addWorldLabelLookupAliases(keys, runtimeAliases[ai], false);
          sourceAliases = Array.isArray(sourceAliases) ? sourceAliases : [];
          for (var si = 0; si < sourceAliases.length; si++) addWorldLabelLookupAliases(keys, sourceAliases[si], true);
          for (var i = 0; i < keys.length; i++) {
            if (!keys[i] || !rects[keys[i]]) continue;
            var rect = normalizeProjectedWorldLabelRect(rects[keys[i]]);
            if (rect) return { key: keys[i], rect: rect };
          }
          return null;
        }
        function projectWorldLabelRectToViewport(rect) {
          var base = worldLabelViewportBaseline();
          var sx = (window.innerWidth || base.width) / base.width;
          var sy = (window.innerHeight || base.height) / base.height;
          return {
            x: rect.x * sx,
            y: rect.y * sy,
            width: rect.width * sx,
            height: rect.height * sy,
            centerX: rect.centerX * sx,
            centerY: rect.centerY * sy
          };
        }
        function observedWorldLabelRect(div, visible) {
          if (visible === false) return null;
          var base = worldLabelViewportBaseline();
          var sx = base.width / (window.innerWidth || base.width);
          var sy = base.height / (window.innerHeight || base.height);
          var r = div && div.getBoundingClientRect ? div.getBoundingClientRect() : null;
          if (!r) return null;
          var x = Number(r.left) * sx;
          var y = Number(r.top) * sy;
          var w = Number(r.width) * sx;
          var h = Number(r.height) * sy;
          return {
            x: Number(x.toFixed(2)),
            y: Number(y.toFixed(2)),
            width: Number(w.toFixed(2)),
            height: Number(h.toFixed(2)),
            centerX: Number((x + w / 2).toFixed(2)),
            centerY: Number((y + h / 2).toFixed(2))
          };
        }
        function setWorldLabelHidden(L, measured) {
          L.div.style.opacity = '0';
        }
        function worldLabelLookupKeys(L) {
          var keys = [];
          addWorldLabelLookupAliases(keys, L.entityId, false);
          var runtimeAliases = Array.isArray(L.runtimeAliases) ? L.runtimeAliases : [];
          for (var ai = 0; ai < runtimeAliases.length; ai++) addWorldLabelLookupAliases(keys, runtimeAliases[ai], false);
          var sourceAliases = Array.isArray(L.sourceAliases) ? L.sourceAliases : [];
          for (var si = 0; si < sourceAliases.length; si++) addWorldLabelLookupAliases(keys, sourceAliases[si], true);
          return keys;
        }
        function storyboardEntityRectForLabel(L) {
          var keys = worldLabelLookupKeys(L);
          if (typeof window.__storyboardEntityScreenRect === 'function') {
            for (var i = 0; i < keys.length; i++) {
              var rect = null;
              try { rect = window.__storyboardEntityScreenRect(keys[i]); } catch(eRect) {}
              if (rect && isFinite(Number(rect.x_px)) && isFinite(Number(rect.y_px))) return rect;
            }
          }
          return null;
        }
        function placeWorldLabelAboveRect(L, rect) {
          var x = Number(rect.x_px) + Number(rect.w_px || 0) / 2;
          var y = Number(rect.y_px) - 8;
          if (!isFinite(x) || !isFinite(y)) return false;
          L.div.style.transform = 'translate(-50%,-100%)';
          L.div.style.width = '';
          L.div.style.height = '';
          L.div.style.boxSizing = '';
          L.div.style.display = 'block';
          L.div.style.left = x.toFixed(1) + 'px';
          L.div.style.top = y.toFixed(1) + 'px';
          L.div.style.opacity = '1';
          return true;
        }
        function findEnt(root, name) {
          // Prefer synthetic StoryboardEntity_<name> created by the overlay (the
          // visible group; real Luna entity is hidden by hideTemplateVisuals).
          // Falls back to plain name for environments where the storyboard overlay
          // didn't create a synthetic group.
          var synth = 'StoryboardEntity_' + name;
          var hit = null;
          var stack = [root]; var safe = 0;
          while (stack.length && safe++ < 5000) {
            var n = stack.shift(); if (!n) continue;
            var nm = n._name || n.name;
            if (nm === synth && n.enabled !== false) return n;
            if (nm === name && n.enabled !== false && !hit) hit = n;
            var ch = n._children || n.children || [];
            for (var k = 0; k < ch.length; k++) stack.push(ch[k]);
          }
          return hit;
        }
        function syncSourceWorldLabels() {
          if (!pcApp || !camEnt || !camEnt.camera || typeof camEnt.camera.worldToScreen !== 'function') return;
          try { if (typeof window.__syncStoryboardEntities === 'function') window.__syncStoryboardEntities(); } catch(eSyncLabels) {}
          var phase = currentWorldLabelPhase();
          var phaseId = phase && phase.id || 'current';
          var projected = phase && phase.projectedWorldLabels;
          var measured = {};
          for (var li = 0; li < labels.length; li++) {
            var L = labels[li];
            var projectedHit = lookupProjectedWorldLabel(projected, L.entityId, L.runtimeAliases, L.sourceAliases);
            if (projected && !projectedHit) {
              setWorldLabelHidden(L, measured);
              continue;
            }
            var projectedRect = projectedHit && projectedHit.rect;
            var entityRect = storyboardEntityRectForLabel(L);
            if (entityRect && placeWorldLabelAboveRect(L, entityRect)) {
              measured[projectedHit ? projectedHit.key : L.entityId] = observedWorldLabelRect(L.div, true);
              continue;
            }
            if (projectedRect) {
              var vr = projectWorldLabelRectToViewport(projectedRect);
              L.div.style.transform = 'none';
              L.div.style.left = vr.x.toFixed(1) + 'px';
              L.div.style.top = vr.y.toFixed(1) + 'px';
              L.div.style.width = Math.max(0, vr.width).toFixed(1) + 'px';
              L.div.style.height = Math.max(0, vr.height).toFixed(1) + 'px';
              L.div.style.boxSizing = 'border-box';
              L.div.style.display = 'flex';
              L.div.style.alignItems = 'center';
              L.div.style.justifyContent = 'center';
              L.div.style.opacity = '1';
              measured[projectedHit.key] = observedWorldLabelRect(L.div, true);
              continue;
            }
            var ent = findEnt(pcApp.root, L.entityId);
            if (!ent || typeof ent.getPosition !== 'function') { setWorldLabelHidden(L, measured); continue; }
            var wp = ent.getPosition();
            if (!wp || typeof wp.x !== 'number') { setWorldLabelHidden(L, measured); continue; }
            wp = new pc.Vec3(wp.x + L.ox, wp.y + L.oy, wp.z + L.oz);
            var sp = camEnt.camera.worldToScreen(wp);
            if (!sp || sp.z < 0) { setWorldLabelHidden(L, measured); continue; }
            var cssY = worldLabelCanvasSize().height - Number(sp.y);
            L.div.style.transform = 'translate(-50%,-50%)';
            L.div.style.width = '';
            L.div.style.height = '';
            L.div.style.display = 'block';
            L.div.style.left = sp.x.toFixed(1) + 'px';
            L.div.style.top = cssY.toFixed(1) + 'px';
            L.div.style.opacity = '1';
            measured[L.entityId] = observedWorldLabelRect(L.div, true);
          }
          window.__targetWorldLabels = measured;
          window.__targetWorldLabelsByPhase = window.__targetWorldLabelsByPhase || {};
          window.__targetWorldLabelsByPhase[phaseId] = measured;
          window.__targetWorldLabelsByPhase.current = measured;
        }
        // Flip initial display so the divs are laid out (extractor reads even at
        // opacity 0; positioning happens on first tick + every 100ms after).
        for (var di = 0; di < labels.length; di++) {
          labels[di].div.style.display = 'block';
          labels[di].div.style.opacity = '0';
        }
        window.__syncSourceWorldLabels = syncSourceWorldLabels;
        syncSourceWorldLabels();
        (function frameTickLabels() {
          try { syncSourceWorldLabels(); } catch(eFrameLabels) {}
          if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(frameTickLabels);
          else setTimeout(frameTickLabels, 33);
        })();
      }

      applyStoryboardVisualOverlay();

      // 1.5 Hide all __BaseTemplate / __LunaPool non-pool children (Ground, Archer_1, etc.)
      // These overlap with __Pool_* objects and cause visual interference (e.g. black/green screen from Ground entity)
      (function hideBaseTemplate() {
        try {
          function findByName(entity, name) {
            if (entity.name === name) return entity;
            if (entity.children) {
              for (var i = 0; i < entity.children.length; i++) {
                var found = findByName(entity.children[i], name);
                if (found) return found;
              }
            }
            return null;
          }
          // Try both names — Unity exports as __BaseTemplate, Luna may rename to __LunaPool
          var base = findByName(pcApp.root, '__BaseTemplate') || findByName(pcApp.root, '__LunaPool');
          if (base && base.children) {
            var hidden = 0;
            for (var i = 0; i < base.children.length; i++) {
              var child = base.children[i];
              // Skip __Pool_ objects — they are used by AI code
              if (child.name && child.name.indexOf('__Pool_') === 0) continue;
              // Skip system objects
              if (child.name && (child.name === 'Main Camera' || child.name === 'Directional Light'
                  || child.name === 'EventSystem' || child.name === 'GameManager' || child.name === 'Canvas'
                  || child.name === '__MainLight')) continue;
              if (child.setPosition) {
                child.setPosition(0, -9999, 0);
                hidden++;
              }
            }
            console.log("[AI] Hidden " + hidden + " template non-pool children (root: " + base.name + ")");
          }
        } catch(e) { console.error("[AI] hideBaseTemplate error:", e); }
      })();

      // Color override removed — pre-baked color pool objects handle all colors
      console.log('[AI] Pre-baked color pool active — no runtime color override needed');

    })();
    if (comp && comp.Update) {
      var lastTime = performance.now();
      var wallClockStart = lastTime;
      window.__bpHeadlessWallSeconds = 0;
      function syncHeadlessUnityClock(now) {
        window.__bpHeadlessWallSeconds = Math.max(0, (now - wallClockStart) / 1000.0);
        try {
          if (UnityEngine.Time && !UnityEngine.Time.__bpWallClockPatched) {
            Object.defineProperty(UnityEngine.Time, 'realtimeSinceStartup', {
              configurable: true,
              get: function() { return window.__bpHeadlessWallSeconds || 0; }
            });
            UnityEngine.Time.__bpWallClockPatched = true;
          }
        } catch(e) {}
        try { if (UnityEngine.Time) UnityEngine.Time.realtimeSinceStartup = window.__bpHeadlessWallSeconds; } catch(e2) {}
      }
      function resolveGameLoopComponent() {
        var target = comp;
        try {
          var ap = (typeof GFM_AutoPlay !== "undefined") ? GFM_AutoPlay.Instance : null;
          var scope = ap && ap.OnArrive && ap.OnArrive.$scope;
          if (target && target._gfmDisabled && scope && !scope._gfmDisabled && scope.Update) {
            target = scope;
          }
        } catch(e) {}
        window.__blueprintGameFlowComponent = target || null;
        return target;
      }
      window.__blueprintResolveGameFlowComponent = resolveGameLoopComponent;
      function driverNormalizePhaseKey(value) {
        var fn = window.__blueprintNormalizePhaseKey;
        if (typeof fn === "function") return fn(value);
        return String(value == null ? "" : value).toLowerCase().replace(/[^a-z0-9]/g, "");
      }
      function driverPhaseMatches(phase, key) {
        var fn = window.__blueprintPhaseMatches;
        if (typeof fn === "function") return fn(phase, key);
        if (!phase || !key) return false;
        var fields = ["id", "phaseId", "name", "title", "label"];
        for (var i = 0; i < fields.length; i++) {
          if (driverNormalizePhaseKey(phase[fields[i]]) === key) return true;
        }
        return false;
      }
      function currentBlueprintGameState() {
        try {
          var gs = typeof window.__gameState === "function" ? window.__gameState() : window.__gameState;
          gs = normalizeBlueprintGameState(gs, null);
          if (typeof window.__gameState !== "function") window.__gameState = gs;
          return gs;
        } catch(e) { return null; }
      }
      function sourcePhaseForState(state, fallbackPhaseId) {
        try {
          var va = window.__BLUEPRINT_VISUAL_ASSETS__ || null;
          var phaseId = fallbackPhaseId || state && (state.currentPhase || state.phase);
          var resolve = window.__blueprintResolveSourcePhase;
          var resolved = typeof resolve === "function" ? resolve(state, phaseId) : null;
          return resolved && resolved.phase || null;
        } catch(e) { return null; }
      }
      function sourcePhaseInfoForState(state, fallbackPhaseId) {
        try {
          var va = window.__BLUEPRINT_VISUAL_ASSETS__ || null;
          var phaseId = fallbackPhaseId || state && (state.currentPhase || state.phase);
          var resolve = window.__blueprintResolveSourcePhase;
          return typeof resolve === "function" ? resolve(state, phaseId) : null;
        } catch(e) { return null; }
      }
      function sourcePhaseFirstTarget(phase, state) {
        try {
          var ui = state && (state.uiState || state.ui_state) || {};
          var runtimeTarget = ui.highlightTarget ||
            ui.highlightOverlay && ui.highlightOverlay.target ||
            ui.highlightState && ui.highlightState.target ||
            state && state.targetEntity ||
            state && state.variables && state.variables.targetEntity;
          if (runtimeTarget) return runtimeTarget;
          if (!phase || !phase.steps || !phase.steps.length) return "";
          return phase.steps[0] && phase.steps[0].target || "";
        } catch(e) { return ""; }
      }
      function applySourcePhaseVisibility(state, phase) {
        try {
          if (!state || !phase || !Array.isArray(phase.showEntities)) return;
          var show = {};
          for (var i = 0; i < phase.showEntities.length; i++) {
            if (phase.showEntities[i]) show[String(phase.showEntities[i])] = true;
          }
          var entityStates = state.entity_states || state.entityStates || {};
          var keys = Object.keys(entityStates);
          for (var k = 0; k < keys.length; k++) {
            var name = keys[k];
            var st = entityStates[name];
            if (!st || typeof st !== "object") continue;
            var isVisible = !!show[name];
            var runtimeHidden = st.visible === false || (st.position && isFinite(Number(st.position.y)) && Number(st.position.y) < -100);
            if (!isVisible || runtimeHidden) {
              st.visible = false;
              st.state = st.state || "hidden";
              if (!st.position || typeof st.position !== "object") st.position = { x: 0, y: -999, z: 0 };
              else st.position.y = -999;
            } else {
              st.visible = isVisible;
              if (!st.position || typeof st.position !== "object") st.position = { x: 0, y: 0, z: 0 };
              st.state = "active";
            }
          }
          state.visibleEntities = phase.showEntities.slice();
        } catch(e) {}
      }
      function normalizeBlueprintGameState(state, fallbackPhaseId) {
        if (!state || typeof state !== "object") return state;
        try {
          if (!state.entity_states && state.entityStates) state.entity_states = state.entityStates;
          if (!state.entityStates && state.entity_states) state.entityStates = state.entity_states;
          if (!state.ui_state && state.uiState) state.ui_state = state.uiState;
          if (!state.uiState && state.ui_state) state.uiState = state.ui_state;
          if (!state.camera_state && state.cameraState) state.camera_state = state.cameraState;
          if (!state.cameraState && state.camera_state) state.cameraState = state.camera_state;
          var phaseInfo = sourcePhaseInfoForState(state, fallbackPhaseId);
          var phase = phaseInfo && phaseInfo.phase;
          if (phase) {
            state.sourcePhaseId = phase.id || "";
            state.sourcePhaseIndex = phaseInfo.index;
            state.sourcePhaseNumber = phaseInfo.index + 1;
            var ui = state.ui_state || state.uiState || {};
            state.ui_state = ui;
            state.uiState = ui;
            if (phase.guideText) ui.guideText = phase.guideText;
            var vars = state.variables || {};
            state.variables = vars;
            if (phase.guideText) vars.guideText = phase.guideText;
            var target = sourcePhaseFirstTarget(phase, state);
            if (target) {
              vars.targetEntity = target;
              state.targetEntity = target;
            }
            applySourcePhaseVisibility(state, phase);
          }
        } catch(e) {}
        return state;
      }
      window.__blueprintNormalizeGameState = normalizeBlueprintGameState;
      function hasPopulatedFidelityState(state, expectedPhaseId) {
        if (!state || typeof state !== "object") return false;
        var phaseId = state.currentPhase || state.phase || "";
        if (expectedPhaseId && String(phaseId) !== String(expectedPhaseId)) return false;
        var entities = state.entity_states || state.entityStates || {};
        return !!(entities && typeof entities === "object" && Object.keys(entities).length > 0);
      }
      function waitForFidelityState(expectedPhaseId) {
        return new Promise(function(resolve) {
          var started = Date.now();
          function tick() {
            var gs = currentBlueprintGameState();
            if (hasPopulatedFidelityState(gs, expectedPhaseId) || Date.now() - started > 2000) {
              resolve(gs);
              return;
            }
            setTimeout(tick, 50);
          }
          tick();
        });
      }
      window.__blueprintWaitForFidelityState = waitForFidelityState;
      function phaseSortKey(id, fallback) {
        var m = String(id || "").match(/(\\d+)/);
        return m ? Number(m[1]) : 100000 + fallback;
      }
      function phaseMethodSuffix(id) {
        return String(id || "").replace(/[^a-zA-Z0-9]/g, "");
      }
      function orderedPhaseIds(loopComp) {
        var ids = [];
        var runtimePhaseIdsFn = window.__blueprintRuntimePhaseIdsFromComponent;
        var runtimeIds = typeof runtimePhaseIdsFn === "function" ? runtimePhaseIdsFn(loopComp) : [];
        if (runtimeIds.length) return runtimeIds;
        try {
          var va = window.__BLUEPRINT_VISUAL_ASSETS__ || null;
          var sourcePhases = va && va.sourcePhaseContract && va.sourcePhaseContract.phases;
          if ((!sourcePhases || !sourcePhases.length) && va && va.fidelityContract) sourcePhases = va.fidelityContract.phases;
          if (sourcePhases && sourcePhases.length) {
            for (var i = 0; i < sourcePhases.length; i++) {
              if (sourcePhases[i] && sourcePhases[i].id) ids.push(String(sourcePhases[i].id));
            }
          }
        } catch(e) {}
        if (!ids.length) {
          try {
            var gs = currentBlueprintGameState();
            var stamps = gs && gs.phaseTimestamps;
            if (stamps) {
              Object.keys(stamps).forEach(function(k) { if (k) ids.push(k); });
            }
          } catch(e2) {}
        }
        if (!ids.length && loopComp) {
          try {
            Object.keys(loopComp).forEach(function(k) {
              var m = k.match(/^Phase_(.+)_Init$/);
              if (m && m[1]) ids.push(m[1]);
            });
            ids.sort(function(a, b) {
              var ak = phaseSortKey(a, 0), bk = phaseSortKey(b, 0);
              if (ak !== bk) return ak - bk;
              return String(a).localeCompare(String(b));
            });
          } catch(e3) {}
        }
        return ids;
      }
      function primePhaseProgress(loopComp, phaseIds, targetIdx) {
        try {
          if (loopComp.ruleTriggered && typeof loopComp.ruleTriggered.length === "number") {
            for (var i = 0; i < loopComp.ruleTriggered.length; i++) loopComp.ruleTriggered[i] = i < targetIdx;
          }
        } catch(e) {}
        try {
          if (loopComp.completedPhases && typeof loopComp.completedPhases.length === "number") {
            var limit = Math.min(targetIdx, loopComp.completedPhases.length);
            loopComp.completedPhaseCount = 0;
            for (var j = 0; j < loopComp.completedPhases.length; j++) loopComp.completedPhases[j] = null;
            for (var p = 0; p < limit; p++) {
              loopComp.completedPhases[p] = phaseIds[p];
              loopComp.completedPhaseCount++;
            }
          }
        } catch(e2) {}
      }
      function settleFidelityFrame() {
        return new Promise(function(resolve) {
          requestAnimationFrame(function() {
            requestAnimationFrame(function() {
              setTimeout(resolve, 50);
            });
          });
        });
      }
      function driveLoopComponentToPhase(loopComp, phaseNumber) {
        var phaseIds = orderedPhaseIds(loopComp);
        if (!phaseIds.length) {
          for (var i = 1; i <= Math.max(phaseNumber, 1); i++) phaseIds.push("phase" + i);
        }
        if (phaseNumber < 1 || phaseNumber > phaseIds.length) throw new Error("bad phase: " + phaseNumber);
        var targetIdx = phaseNumber - 1;
        var phaseId = phaseIds[targetIdx] || ("phase" + phaseNumber);
        var suffix = phaseMethodSuffix(phaseId);
        primePhaseProgress(loopComp, phaseIds, targetIdx);
        if (typeof loopComp.EnterPhase === "function") {
          loopComp.EnterPhase(targetIdx, phaseId, true, true);
        } else {
          loopComp.currentPhaseName = phaseId;
          if (loopComp.ruleTriggered && loopComp.ruleTriggered.length > targetIdx) loopComp.ruleTriggered[targetIdx] = true;
        }
        var initName = "Phase_" + suffix + "_Init";
        if (typeof loopComp[initName] === "function") loopComp[initName]();
        if (typeof loopComp.ApplyFidelityPhaseVisibility === "function") loopComp.ApplyFidelityPhaseVisibility(targetIdx);
        var snapshotName = "Snapshot_" + suffix + "_GateEntities";
        if (typeof loopComp[snapshotName] === "function") loopComp[snapshotName]();
        if (typeof loopComp.UpdateGameState === "function") loopComp.UpdateGameState();
        normalizeBlueprintGameState(currentBlueprintGameState(), phaseId);
        return { phase: phaseId, index: phaseNumber };
      }
      function phaseNumberFromDriveInput(loopComp, input) {
        var phaseIds = orderedPhaseIds(loopComp);
        var raw = String(input == null ? "" : input);
        var n = Number(raw);
        if (isFinite(n)) return Math.floor(n);
        var key = driverNormalizePhaseKey(raw);
        var aliasFn = window.__blueprintSourcePhaseAliasesFromRuntime;
        var aliases = typeof aliasFn === "function" ? aliasFn(loopComp) : {};
        if (aliases[key]) key = driverNormalizePhaseKey(aliases[key]);
        for (var i = 0; i < phaseIds.length; i++) {
          if (driverNormalizePhaseKey(phaseIds[i]) === key) return i + 1;
        }
        try {
          var va = window.__BLUEPRINT_VISUAL_ASSETS__ || {};
          var sourcePhases = va.sourcePhaseContract && va.sourcePhaseContract.phases;
          if ((!sourcePhases || !sourcePhases.length) && va.fidelityContract) sourcePhases = va.fidelityContract.phases;
          sourcePhases = Array.isArray(sourcePhases) ? sourcePhases : [];
          for (var si = 0; si < sourcePhases.length; si++) {
            if (driverPhaseMatches(sourcePhases[si], key)) return si + 1;
          }
        } catch(e) {}
        var m = raw.match(/(\d+)/);
        if (m) return Math.floor(Number(m[1]));
        throw new Error("bad phase: " + input);
      }
      window.__driveToPhase = function(n) {
        return new Promise(function(resolve, reject) {
          try {
            var loopComp = resolveGameLoopComponent();
            if (!loopComp) throw new Error("GameFlow component unavailable");
            var phaseNumber = phaseNumberFromDriveInput(loopComp, n);
            var result = driveLoopComponentToPhase(loopComp, phaseNumber);
            settleFidelityFrame().then(function() {
              try {
                if (typeof loopComp.UpdateGameState === "function") loopComp.UpdateGameState();
                normalizeBlueprintGameState(currentBlueprintGameState(), result.phase);
              } catch(e) {}
              waitForFidelityState(result.phase).then(function() { resolve(result); }, reject);
            }, reject);
          } catch(e) {
            reject(e);
          }
        });
      };
      var lateUpdateComponents = [];
      var lateUpdateFrame = 0;
      function rememberLifecycleComponent(out, seen, candidate) {
        if (!candidate || typeof candidate.LateUpdate !== 'function') return;
        if (candidate._gfmDisabled || candidate.enabled === false) return;
        if (seen.indexOf(candidate) >= 0) return;
        seen.push(candidate);
        out.push(candidate);
      }
      function collectLateUpdateComponents(loopComp) {
        var out = [];
        var seen = [];
        rememberLifecycleComponent(out, seen, loopComp);
        try {
          function walkEntity(entity) {
            if (!entity) return;
            var comps = entity._unityComponents || {};
            for (var key in comps) {
              if (!Object.prototype.hasOwnProperty.call(comps, key)) continue;
              var bucket = comps[key];
              if (bucket && typeof bucket.length === 'number') {
                for (var i = 0; i < bucket.length; i++) rememberLifecycleComponent(out, seen, bucket[i]);
              } else {
                rememberLifecycleComponent(out, seen, bucket);
              }
            }
            var children = entity.children || [];
            for (var ci = 0; ci < children.length; ci++) walkEntity(children[ci]);
          }
          walkEntity(pcApp && pcApp.root);
        } catch(e) {}
        try {
          if (typeof GFM_CameraController !== 'undefined' && GFM_CameraController._instance) {
            rememberLifecycleComponent(out, seen, GFM_CameraController._instance);
          }
        } catch(e2) {}
        return out;
      }
      function driveManualLateUpdate(loopComp) {
        lateUpdateFrame++;
        if (lateUpdateFrame === 1 || lateUpdateFrame % 30 === 0) {
          lateUpdateComponents = collectLateUpdateComponents(loopComp);
          if (lateUpdateFrame === 1) {
            console.log('[AI] LateUpdate loop active via requestAnimationFrame components=' + lateUpdateComponents.length);
          }
        }
        for (var i = 0; i < lateUpdateComponents.length; i++) {
          var lifecycleComp = lateUpdateComponents[i];
          try {
            if (lifecycleComp && !lifecycleComp._gfmDisabled && lifecycleComp.enabled !== false && lifecycleComp.LateUpdate) {
              lifecycleComp.LateUpdate();
            }
          } catch(e) {}
        }
      }
      function gameLoop() {
        var now = performance.now();
        var dt = (now - lastTime) / 1000.0;
        lastTime = now;
        syncHeadlessUnityClock(now);
        try { if (UnityEngine.Time) UnityEngine.Time.deltaTime = dt; } catch(e) {}
        try {
          var loopComp = resolveGameLoopComponent();
          if (loopComp && loopComp.Update) loopComp.Update();
          driveManualLateUpdate(loopComp);
          if (!window.__fidelityReady && window.__blueprintMarkFidelityReady) window.__blueprintMarkFidelityReady();
        } catch(e) {}
        requestAnimationFrame(gameLoop);
      }
      requestAnimationFrame(gameLoop);
    }
    console.log("[AI] ${className} injected successfully");
  } catch(e) { console.error("[AI] Failed to inject:", e); }
  }, 500);
});
<\/script>`;

  // 7.1.0 fix: inject event listeners BEFORE engine script (not after).
  // convertToSingleHTML inlines engine/scripts.js (removes defer), so luna:started
  // fires synchronously during engine init. Listeners must be registered earlier.
  if (html.includes('<script src="engine/scripts.js"')) {
    // Insert our listeners RIGHT BEFORE the engine script tag
    html = html.replace('<script src="engine/scripts.js"', injectionScript + '\n<script src="engine/scripts.js"');
  } else if (html.includes('</body>')) {
    // Fallback for non-7.1.0 templates
    html = html.replace('</body>', injectionScript + '</body>');
  } else {
    html += injectionScript;
  }

  fs.writeFileSync(iframePath, html);
}

// ─── script1.js Patch (applies to merged scripts.js in Luna 7.1.0) ───
function patchScript1(stage4Dir, log, taskId) {
  // Luna 7.1.0: all engine code is in engine/scripts.js
  const scriptsPath = path.join(stage4Dir, 'engine', 'scripts.js');
  // Fallback: old Luna 6.x format
  const script1Path = path.join(stage4Dir, 'engine', 'luna', 'script1.js');
  const targetPath = fs.existsSync(scriptsPath) ? scriptsPath : (fs.existsSync(script1Path) ? script1Path : null);
  if (!targetPath) return;

  let content = fs.readFileSync(targetPath, 'utf-8');
  const oldPattern = '_invokeOverload(e){try{const t=this.code.overloads[e+"()"]';
  const newPattern = '_invokeOverload(e){try{if(!this.code||!this.code.overloads)return;const t=this.code.overloads[e+"()"]';

  if (content.includes(oldPattern)) {
    content = content.replace(oldPattern, newPattern);
    fs.writeFileSync(targetPath, content);
    log(`[linux-build] ✅ Patched _invokeOverload in ${path.basename(targetPath)}`, taskId);
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
    } else if (ext === '.ttf' || ext === '.otf') {
      // Web fonts: serve as binary so polyfill can load via FontFace API
      fileDict[rel] = { t: 'b', d: fs.readFileSync(fp).toString('base64'), m: 'font/' + ext.slice(1) };
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
  var parts=['assets','js','engine','favicon','tmp','resources'];
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

  const loadingCover = `<style>
#blueprint-loading-cover{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;flex-direction:column;background:#202733;color:#f8fafc;font-family:Arial,"Microsoft YaHei",sans-serif;transition:opacity .25s ease;pointer-events:none}
#blueprint-loading-cover.bp-hide{opacity:0}
#blueprint-loading-cover .bp-loader-ring{width:42px;height:42px;border:4px solid rgba(255,255,255,.24);border-top-color:#72d4ff;border-radius:50%;animation:bp-loader-spin 1s linear infinite;margin-bottom:14px}
#blueprint-loading-cover .bp-loader-text{font-size:16px;line-height:1.4;letter-spacing:0;color:#f8fafc}
@keyframes bp-loader-spin{to{transform:rotate(360deg)}}
<\/style><div id="blueprint-loading-cover" aria-live="polite"><div class="bp-loader-ring"></div><div id="blueprint-loading-text" class="bp-loader-text">Loading...</div></div><script>
(function(){
  function cover(){return document.getElementById("blueprint-loading-cover");}
  function hideCover(){
    var el=cover();
    if(!el)return;
    el.classList.add("bp-hide");
    setTimeout(function(){ if(el&&el.parentNode)el.parentNode.removeChild(el); },300);
  }
  window.addEventListener("luna:postrender", hideCover);
  window.addEventListener("luna:started", function(){ setTimeout(hideCover, 700); });
  setTimeout(function(){
    if(!window.app){
      var txt=document.getElementById("blueprint-loading-text");
      if(txt)txt.textContent="Still loading...";
    }
  },8000);
})();
<\/script>`;

  // Inject interceptor after <body>
  html = html.replace('<body>', '<body>' + loadingCover + interceptor);

  // Inject __gameState polling bridge: reads gameObject.name set by skeleton's UpdateGameState()
  // Skeleton sets gameObject.name = "GFM|" + json in C#.
  // Bridge.NET transpiles this to Playcanvas entity._name. We poll all root entities to find it.
  const gameStateBridge = `<script>
(function(){
  window.__BLUEPRINT_GAMESTATE_BRIDGE_VERSION__='manual-default-autoplay-param-v1';
  // Public preview is manual by default. CUA/diagnostic observe runs must opt in
  // with ?autoplay=1 so the user-facing URL cannot silently self-play.
  var _autoPlayFlagCreated=false;
  var _observerReadyFlagCreated=false;
  var _params=new URLSearchParams(window.location.search);
  var _autoplayParam=_params.get('autoplay');
  var _manualRequested=_autoplayParam==='0'||_params.get('manual')==='1'||_params.get('interactive')==='1';
  var _cuaAutoPlayRequested=_autoplayParam==='1'&&!_manualRequested;
  var _observerReadyRequested=_params.get('observerReady')==='1'||_params.get('cuaObserverReady')==='1';
  var _autoPlayRequested=_cuaAutoPlayRequested;
  window.__CUA_OBSERVER_READY__ = !!window.__CUA_OBSERVER_READY__ || _observerReadyRequested;
  function syncUnityAbsoluteUrl(){
    try{
      if(typeof UnityEngine!=='undefined'&&UnityEngine.Application){
        UnityEngine.Application.absoluteURL=window.location.href;
      }
    }catch(e){}
  }
  syncUnityAbsoluteUrl();
  function createRuntimeFlag(name){
    var made=false;
    syncUnityAbsoluteUrl();
    try{
      if(typeof UnityEngine!=='undefined'&&UnityEngine.GameObject){
        try{ if(UnityEngine.GameObject.Find&&UnityEngine.GameObject.Find(name)!=null) return true; }catch(e){}
        if(UnityEngine.GameObject.$ctor2){ new UnityEngine.GameObject.$ctor2(name); made=true; }
        else if(UnityEngine.GameObject.ctor){ new UnityEngine.GameObject.ctor(name); made=true; }
      }
    }catch(e){}
    try{
      var appForFlag=pc.app||pc.Application.getApplication();
      if(appForFlag&&appForFlag.root){var fe=new pc.Entity(name);appForFlag.root.addChild(fe);made=true;}
    }catch(e){}
    return made;
  }
  setInterval(function(){
    try{
      var app=pc.app||pc.Application.getApplication();
      // Create autoPlay flag entity once (C# reads via GameObject.Find("__AUTOPLAY_ON__"))
      if(_autoPlayRequested&&!_autoPlayFlagCreated){
        _autoPlayFlagCreated=createRuntimeFlag('__AUTOPLAY_ON__');
      }
      if(window.__CUA_OBSERVER_READY__&&!_observerReadyFlagCreated){
        _observerReadyFlagCreated=createRuntimeFlag('__CUA_OBSERVER_READY__');
      }
      if(!app||!app.root)return;
      if(window.__CUA_OBSERVER_READY__&&!_observerReadyFlagCreated){
        _observerReadyFlagCreated=createRuntimeFlag('__CUA_OBSERVER_READY__');
      }
      // Scan all children recursively and choose the freshest GFM state.
      // Luna can leave multiple renamed GFM entities in the tree; CUA must read
      // the one with the most advanced phase evidence, not the first child.
      function scoreState(s){
        if(!s)return -1;
        var completed=Array.isArray(s.completedPhases)?s.completedPhases.length:0;
        var timer=s.variables&&typeof s.variables.gameTimer==='number'?s.variables.gameTimer:0;
        var ts=0;
        var stamps=s.phaseTimestamps||{};
        for(var k in stamps){if(Object.prototype.hasOwnProperty.call(stamps,k)){var v=Number(stamps[k])||0;if(v>ts)ts=v;}}
        return completed*1000000+ts*1000+timer;
      }
      function consider(raw,best){
        try{
          var state=JSON.parse(raw.substring(4));
          var score=scoreState(state);
          if(!best||score>best.score)return{state:state,score:score};
        }catch(e){}
        return best;
      }
      function scan(node,best){
        if(!node)return best;
        var n=node._name||node.name||'';
        if(n.indexOf('GFM|')===0)best=consider(n,best);
        var c=node._children||node.children||[];
        for(var i=0;i<c.length;i++){best=scan(c[i],best);}
        return best;
      }
      var best=scan(app.root,null);
      if(best&&best.state){
        var nextState=best.state;
        try{
          if(typeof window.__blueprintNormalizeGameState==='function'){
            nextState=window.__blueprintNormalizeGameState(nextState,nextState.currentPhase||nextState.phase||null)||nextState;
          }
        }catch(e){}
        window.__gameState=nextState;
      }
    }catch(e){}
  },500);
})();
<\/script>`;
  html = html.replace('</body>', gameStateBridge + '</body>');

  // Replace external script src with inline content
  html = html.replace(/<script\s+src="([^"]+)"\s+defer="defer"(?:\s+type="text\/javascript")?><\/script>/g, (match, src) => {
    const normalizedSrc = src.replace(/\\/g, '/');
    const fp = path.join(stage4Dir, normalizedSrc);
    if (fs.existsSync(fp)) {
      let content = fs.readFileSync(fp, 'utf8');
      content = content.replace(/<(\/?)script/gi, '\\x3c$1script');
      return `<script>/* ${normalizedSrc} */\n${content}\n<\/script>`;
    }
    return match;
  });

  const headlessRealtimeExpr = '((typeof window!=="undefined"&&typeof window.__bpHeadlessWallSeconds==="number")?window.__bpHeadlessWallSeconds:UnityEngine.Time.realtimeSinceStartup)';
  html = html.replace(/UnityEngine\.Time\.realtimeSinceStartup(?!\s*=)/g, headlessRealtimeExpr);

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
          const { code, className, extraFiles, visualAssets } = parsed;
          console.log(`[build] body=${body.length}b, code=${(code||'').length}b, extraFiles=${JSON.stringify(Object.keys(extraFiles||{}))}`);
          if (!code) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Missing "code" field' }));
            return;
          }

          const result = await buildFromCS(code, { className, extraFiles, visualAssets });

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
          const { code, className, extraFiles, visualAssets } = JSON.parse(body);
          const result = await buildFromCS(code, { className, extraFiles, visualAssets });
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
  server.timeout = 300000; // 5 min
  server.keepAliveTimeout = 120000; // 2 min keepalive
    console.log(`🚀 Linux Bridge Build Server listening on :${port}`);
    console.log(`   POST /build      — Build C# → JSON response`);
    console.log(`   POST /build-html — Build C# → HTML response`);
    console.log(`   GET  /health     — Health check`);
  });
}

module.exports = { buildFromCS, startServer, _ensureTmpRoot: ensureTmpRoot };

if (require.main === module) {
  const port = parseInt(process.env.PORT || '3080');
  startServer(port);
}
