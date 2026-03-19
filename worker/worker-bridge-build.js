// Luna build via jake pipeline + MSBuild Rebuild for code injection
// Does NOT require Unity Bridge (port 18801) or AssetDatabase.Refresh
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const LUNA_DIR = 'D:\\Luna';
const PIPELINE_DIR = path.join(LUNA_DIR, 'pipeline');
const MSBUILD_PATH = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\MSBuild\\Current\\Bin\\MSBuild.exe';
const CSPROJ_DIR = path.join(LUNA_DIR, 'pipeline', 'templates', 'LunaCompiler', 'Scripts');
const CSPROJ_PATH = path.join(CSPROJ_DIR, 'Scripts.csproj');
const BRIDGE_JS_OUTPUT = path.join(LUNA_DIR, 'pipeline', 'templates', 'LunaCompiler', 'bin', 'UnityScriptsCompiler.js');

/**
 * Run Luna build with AI code injection via MSBuild Rebuild
 * Flow:
 *   1. jake project:build (Stage1-4, template code, ~30s)
 *   2. Clean MSBuild obj cache
 *   3. MSBuild Rebuild Scripts.csproj (compiles .cs from disk → JS via Bridge.NET, ~8s)
 *   4. Copy new UnityScriptsCompiler.js to stage3+stage4 output
 *
 * @param {string} clientDir - Unity project Client directory
 * @param {function} log - Logger
 * @param {string} taskId - Task ID
 * @returns {object} { ok, output, error, buildTime, outputDir }
 */
async function runBridgeBuild(clientDir, log, taskId) {
  log = log || console.log;
  const startTime = Date.now();

  // 1. Clean old LunaTemp (preserve stage1 cache - asset export is slow/broken on cold start)
  const lunaTempDir = path.join(clientDir, 'LunaTemp');
  if (fs.existsSync(lunaTempDir)) {
    log('[luna-build] Cleaning LunaTemp (preserving stage1 cache)...', taskId);
    for (const sub of ['stage2', 'stage3', 'stage4']) {
      const subDir = path.join(lunaTempDir, sub);
      if (fs.existsSync(subDir)) {
        try { fs.rmSync(subDir, { recursive: true, force: true }); } catch (e) {
          log('[luna-build] Warning cleaning ' + sub + ': ' + e.message, taskId);
        }
      }
    }
  }

  // 2. Check if we can skip jake entirely using stage1 cache
  const stage1CacheDir = path.join(lunaTempDir, 'stage1');
  const stage1HasAssets = fs.existsSync(path.join(stage1CacheDir, 'assets'));
  const stage1HasJs = fs.existsSync(path.join(stage1CacheDir, 'js'));
  
  if (stage1HasAssets && stage1HasJs) {
    // Stage1 cache exists — skip jake completely, assemble stage4 from cache + Luna engine
    log('[luna-build] Stage1 cache found — skipping jake, assembling stage4 from cache...', taskId);
    
    const s4Dir = path.join(lunaTempDir, 'stage4', 'develop');
    fs.mkdirSync(s4Dir, { recursive: true });
    
    const cpDir = (s, d) => {
      fs.mkdirSync(d, { recursive: true });
      for (const e of fs.readdirSync(s, { withFileTypes: true })) {
        const a = path.join(s, e.name), b = path.join(d, e.name);
        if (e.isDirectory()) cpDir(a, b); else fs.copyFileSync(a, b);
      }
    };
    
    // Copy Luna engine
    const lunaEngineDir = path.join(LUNA_DIR, 'engine', 'luna');
    if (fs.existsSync(lunaEngineDir)) {
      cpDir(lunaEngineDir, path.join(s4Dir, 'engine', 'luna'));
    }
    
    // Copy compiled JS (bridge, UnityEngine, etc.) from LunaCompiler bin
    const binDir = path.join(CSPROJ_DIR, '..', 'bin');
    const unityBin = path.join(s4Dir, 'engine', 'unity', 'bin');
    fs.mkdirSync(unityBin, { recursive: true });
    if (fs.existsSync(binDir)) {
      for (const f of fs.readdirSync(binDir)) {
        if (f.endsWith('.js')) fs.copyFileSync(path.join(binDir, f), path.join(unityBin, f));
      }
    }
    
    // Copy stage1 assets
    cpDir(path.join(stage1CacheDir, 'assets'), path.join(s4Dir, 'assets'));
    
    // Copy stage1 js
    if (fs.existsSync(path.join(stage1CacheDir, 'js'))) {
      cpDir(path.join(stage1CacheDir, 'js'), path.join(s4Dir, 'js'));
    }
    
    // Copy luna.json
    if (fs.existsSync(path.join(clientDir, 'luna.json'))) {
      fs.copyFileSync(path.join(clientDir, 'luna.json'), path.join(s4Dir, 'luna.json'));
    }
    
    // Use iframe.html from luna-copy, stage1, or generate standard template
    const lunaCopyIframe = path.join(path.dirname(clientDir), 'luna-copy', 'iframe.html');
    const stage1Iframe = path.join(stage1CacheDir, 'tmp', 'iframe.html');
    const iframeDest = path.join(s4Dir, 'iframe.html');
    if (fs.existsSync(lunaCopyIframe)) {
      fs.copyFileSync(lunaCopyIframe, iframeDest);
      log('[luna-build] Used luna-copy iframe.html', taskId);
    } else if (fs.existsSync(stage1Iframe)) {
      fs.copyFileSync(stage1Iframe, iframeDest);
      log('[luna-build] Used stage1 iframe.html', taskId);
    } else {
      // Use luna-bootstrap.html template from worker directory
      const bootstrapPath = path.join(__dirname, 'luna-bootstrap.html');
      if (fs.existsSync(bootstrapPath)) {
        // Generate iframe.html: engine script tags + bootstrap HTML
        const engineDir = path.join(s4Dir, 'engine', 'unity', 'bin');
        const lunaDir = path.join(s4Dir, 'engine', 'luna');
        const jsDir = path.join(s4Dir, 'js');
        let scriptTags = '';

        // === Script load order (critical! dependency chain): ===
        // 1. Bridge.NET core (bridge.js, bridge.meta.js, Bridge.Locales.js)
        // 2. UnityEngine + other .NET assemblies (depend on Bridge)
        // 3. Luna/PlayCanvas engine (script3.js references Luna namespace from Bridge)
        // 4. UnityScriptsCompiler.js (user code, depends on everything)
        // 5. Additional JS (deserializers etc.)

        // 1. Bridge.NET core — must load first
        const engineOrder = ['bridge.js', 'bridge.meta.js', 'Bridge.Locales.js'];
        const engineFiles = fs.existsSync(engineDir) ? fs.readdirSync(engineDir).filter(f => f.endsWith('.js')) : [];
        for (const f of engineOrder) {
          if (engineFiles.includes(f)) scriptTags += `<script src="engine/unity/bin/${f}"></script>\n`;
        }

        // 2. .NET assemblies (UnityEngine, DOTween, etc.) — depend on Bridge
        // UnityEngine.js must come before DOTween/TextMeshPro (they reference UnityEngine)
        const unityOrder = ['UnityEngine.js', 'UnityEngine.UI.js', 'UnityEngine.UniversalRenderPipeline.js',
                           'DOTween.js', 'newtonsoft.json.js', 'TextMeshPro.js', 'JetBrains.js'];
        for (const f of unityOrder) {
          if (engineFiles.includes(f)) scriptTags += `<script src="engine/unity/bin/${f}"></script>\n`;
        }
        // Any remaining engine files not in explicit orders
        for (const f of engineFiles) {
          if (!engineOrder.includes(f) && !unityOrder.includes(f) && f !== 'UnityScriptsCompiler.js') {
            scriptTags += `<script src="engine/unity/bin/${f}"></script>\n`;
          }
        }

        // 3. Luna/PlayCanvas engine — depends on Bridge + Luna namespace
        if (fs.existsSync(lunaDir)) {
          const lunaFiles = fs.readdirSync(lunaDir).filter(f => f.endsWith('.js'));
          const manifestPath = path.join(lunaDir, 'manifest.json');
          let lunaLoadOrder = [];
          const activeModules = ['physics3d', 'physics2d', 'particle_system', 'reflection', 'prefabs', 'mecanim'];
          const moduleMap = { 'mecanim-wasm': 'mecanim', 'mecanim': 'mecanim', 'particle-system': 'particle_system', 'particle_system': 'particle_system', 'urp': 'urp' };
          if (fs.existsSync(manifestPath)) {
            try {
              const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
              manifest.sort((a, b) => (a.priority || 0) - (b.priority || 0));
              for (const entry of manifest) {
                const mod = entry.ifModule ? (moduleMap[entry.ifModule] || entry.ifModule) : null;
                const unlessMod = entry.unlessModule ? (moduleMap[entry.unlessModule] || entry.unlessModule) : null;
                if (mod && !activeModules.includes(mod)) continue;
                if (unlessMod && activeModules.includes(unlessMod)) continue;
                if (lunaFiles.includes(entry.src)) lunaLoadOrder.push(entry.src);
              }
            } catch(e) {
              log('[luna-build] Failed to parse manifest.json: ' + e.message, taskId);
            }
          }
          if (lunaLoadOrder.length === 0) lunaLoadOrder = lunaFiles.sort();
          for (const f of lunaLoadOrder) {
            scriptTags += `<script src="engine/luna/${f}"></script>\n`;
          }
          log('[luna-build] Added ' + lunaLoadOrder.length + ' Luna/PlayCanvas scripts (after Bridge): ' + lunaLoadOrder.join(', '), taskId);
        }

        // 4. UnityScriptsCompiler.js (user code — depends on UnityEngine + Bridge)
        if (engineFiles.includes('UnityScriptsCompiler.js')) {
          scriptTags += `<script src="engine/unity/bin/UnityScriptsCompiler.js"></script>\n`;
        }

        // 5. Additional JS (deserializers, etc.)
        if (fs.existsSync(jsDir)) {
          for (const f of fs.readdirSync(jsDir).filter(f => f.endsWith('.js'))) {
            scriptTags += `<script src="js/${f}"></script>\n`;
          }
        }
        const bootstrap = fs.readFileSync(bootstrapPath, 'utf-8');
        // Build $environment from luna.json (required by luna-bootstrap.html)
        let lunaJson = {};
        const lunaJsonPath = path.join(s4Dir, 'luna.json');
        try { lunaJson = JSON.parse(fs.readFileSync(lunaJsonPath, 'utf-8')); } catch(e) {}
        const scenes = (lunaJson.unity && lunaJson.unity.scenes) || [];
        const startupScene = scenes[lunaJson.unity?.startupScene || 0] || '';
        const sceneName = startupScene.replace(/^.*\//, '').replace('.unity', '');
        const envObj = {
          runtimeAnalysisModules: ['physics3d', 'physics2d', 'particle_system', 'reflection', 'prefabs', 'mecanim'],
          scenes: scenes,
          startupScene: lunaJson.unity?.startupScene || 0,
          projectId: lunaJson.projectId || '',
          version: lunaJson.version || ''
        };
        // Luna global variables must be defined BEFORE engine scripts load
        // bridge.js references TRACE, MODULE_* etc. at parse time — ReferenceError if missing
        const globalsScript = `<script>
window.DEVELOP=true;window.TRACE=false;window.TESTS=false;window.DEBUG=false;window.FORCE_STABLE_RANDOM_SEED=false;
window.MODULE_physics3d=true;window.MODULE_physics2d=true;window.MODULE_particle_system=true;
window.MODULE_reflection=true;window.MODULE_prefabs=true;window.MODULE_mecanim=true;
</script>`;
        const envScript = `<script>var $environment = ${JSON.stringify(envObj)};</script>`;
        const iframeHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{margin:0;padding:0}html,body{width:100%;height:100%;overflow:hidden}canvas{display:block;width:100%;height:100%}</style>
</head><body>
${globalsScript}
${envScript}
${scriptTags}
${bootstrap}
</body></html>`;
        fs.writeFileSync(iframeDest, iframeHtml, 'utf-8');
        log('[luna-build] Generated iframe.html from luna-bootstrap.html with ' + engineFiles.length + ' engine scripts', taskId);
      } else {
        log('[luna-build] WARNING: No iframe.html source found (no luna-copy, no stage1 cache, no bootstrap)', taskId);
      }
    }
    
    // Also create stage3 dir for MSBuild JS copy target
    const s3JsDir = path.join(lunaTempDir, 'stage3', 'engine', 'unity', 'bin');
    fs.mkdirSync(s3JsDir, { recursive: true });
    
    const items = fs.readdirSync(s4Dir);
    log(`[luna-build] Stage4 assembled from cache (${items.length} items, skipped jake)`, taskId);
  } else {
    // No stage1 cache — must run jake (needs Unity Editor)
    log('[luna-build] No stage1 cache — running jake project:build (requires Unity Editor)...', taskId);

  const jakeResult = await new Promise((resolve) => {
    const env = { ...process.env, PROJECT_PATH: clientDir };
    // Remove proxy vars — Worker proxy may not exist, causes TLS failures in jake
    delete env.http_proxy; delete env.https_proxy;
    delete env.HTTP_PROXY; delete env.HTTPS_PROXY;
    // Remove proxy vars — Worker proxy may not exist, causes TLS failures in jake license check
    delete env.http_proxy; delete env.https_proxy;
    delete env.HTTP_PROXY; delete env.HTTPS_PROXY;
    const child = spawn('node', [
      '--max-old-space-size=8192',
      'jake.js', '-f', 'Jakefile.js', '--quiet', 'project:build'
    ], {
      cwd: PIPELINE_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let lastLog = Date.now();

    child.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      if (text.includes('Stage')) {
        text.split('\n').filter(l => l.includes('Stage')).forEach(l => {
          log('[luna-build] ' + l.trim(), taskId);
        });
      }
      if (Date.now() - lastLog > 30000 && text.includes('.')) {
        log('[luna-build] Still running... (' + Math.floor((Date.now() - startTime) / 1000) + 's)', taskId);
        lastLog = Date.now();
      }
    });

    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });

    setTimeout(() => { child.kill(); resolve({ code: -1, stdout, stderr: 'Timeout' }); }, 300000);
  });

  if (jakeResult.code !== 0) {
    // Jake C# compilation may fail because processed-scripts are empty stubs.
    // If stage1 cache exists and stage4 has assets (from previous successful build),
    // fall back to MSBuild-only mode which compiles from original .cs sources.
    const stage1Exists = fs.existsSync(path.join(lunaTempDir, 'stage1'));
    const stage4HasAssets = fs.existsSync(path.join(lunaTempDir, 'stage4', 'develop', 'engine'));
    
    if (stage1Exists && stage4HasAssets) {
      log('[luna-build] Jake C# compilation failed but stage1 cache + stage4 assets exist — falling back to MSBuild-only mode', taskId);
    } else if (stage1Exists && fs.existsSync(path.join(lunaTempDir, 'stage3'))) {
      // Jake Stage3 C# failed but stage1-3 exist — manually assemble stage4 from templates + stage3 assets
      log('[luna-build] Jake Stage3 C# failed. Assembling stage4 manually from Luna engine + stage3 assets...', taskId);
      const s4Dir = path.join(lunaTempDir, 'stage4', 'develop');
      fs.mkdirSync(s4Dir, { recursive: true });
      
      // Copy Luna engine
      const lunaEngineDir = path.join(LUNA_DIR, 'engine', 'luna');
      if (fs.existsSync(lunaEngineDir)) {
        const cpDir = (s, d) => { fs.mkdirSync(d,{recursive:true}); for(const e of fs.readdirSync(s,{withFileTypes:true})){const a=path.join(s,e.name),b=path.join(d,e.name); if(e.isDirectory())cpDir(a,b);else fs.copyFileSync(a,b);} };
        cpDir(lunaEngineDir, path.join(s4Dir, 'engine', 'luna'));
      }
      // Copy compiled JS (bridge, UnityEngine, etc.)
      const binDir = path.join(CSPROJ_DIR, '..', 'bin');
      const unityBin = path.join(s4Dir, 'engine', 'unity', 'bin');
      fs.mkdirSync(unityBin, { recursive: true });
      if (fs.existsSync(binDir)) {
        for (const f of fs.readdirSync(binDir)) {
          if (f.endsWith('.js')) fs.copyFileSync(path.join(binDir, f), path.join(unityBin, f));
        }
      }
      // Copy stage3 assets + js
      const s3Dir = path.join(lunaTempDir, 'stage3');
      if (fs.existsSync(path.join(s3Dir, 'assets'))) {
        const cpDir2 = (s, d) => { fs.mkdirSync(d,{recursive:true}); for(const e of fs.readdirSync(s,{withFileTypes:true})){const a=path.join(s,e.name),b=path.join(d,e.name); if(e.isDirectory())cpDir2(a,b);else fs.copyFileSync(a,b);} };
        cpDir2(path.join(s3Dir, 'assets'), path.join(s4Dir, 'assets'));
      }
      if (fs.existsSync(path.join(s3Dir, 'js'))) {
        const cpDir3 = (s, d) => { fs.mkdirSync(d,{recursive:true}); for(const e of fs.readdirSync(s,{withFileTypes:true})){const a=path.join(s,e.name),b=path.join(d,e.name); if(e.isDirectory())cpDir3(a,b);else fs.copyFileSync(a,b);} };
        cpDir3(path.join(s3Dir, 'js'), path.join(s4Dir, 'js'));
      }
      // Copy luna.json
      if (fs.existsSync(path.join(clientDir, 'luna.json'))) {
        fs.copyFileSync(path.join(clientDir, 'luna.json'), path.join(s4Dir, 'luna.json'));
      }
      // Use original iframe.html from luna-copy or generate minimal one
      const lunaCopyIframe = path.join(path.dirname(clientDir), 'luna-copy', 'iframe.html');
      if (fs.existsSync(lunaCopyIframe)) {
        let ihtml = fs.readFileSync(lunaCopyIframe, 'utf-8');
        ihtml = ihtml.replace(/(src|href)="([^"]+)"/g, (m, attr, p) => attr + '="' + p.replace(/\\/g, '/') + '"');
        fs.writeFileSync(path.join(s4Dir, 'iframe.html'), ihtml);
        log('[luna-build] Used luna-copy iframe.html as base', taskId);
      }
      log('[luna-build] Stage4 manually assembled (' + (fs.readdirSync(s4Dir).length) + ' items)', taskId);
    } else {
      const errorLines = jakeResult.stdout.split('\n').filter(l => /fail|error/i.test(l)).slice(-5);
      return { ok: false, error: `Jake build failed (code ${jakeResult.code}): ${errorLines.join('; ') || jakeResult.stderr.slice(-500)}` };
    }
  }
  } // end else (no stage1 cache — ran jake)

  // Verify stage4 output
  const stage4Dir = path.join(lunaTempDir, 'stage4', 'develop');
  if (!fs.existsSync(stage4Dir) || !fs.existsSync(path.join(stage4Dir, 'engine'))) {
    return { ok: false, error: 'No stage4/develop output (jake failed and no cache available)' };
  }

  const jakeBuildTime = Math.floor((Date.now() - startTime) / 1000);
  log(`[luna-build] Jake build done in ${jakeBuildTime}s, starting MSBuild Rebuild...`, taskId);

  // 2.5a CRITICAL: Strip custom script components (type:4) from ALL stage scene data.
  // The empty-scene-template has GameManager (class:6) and Directional Light (class:5) with custom scripts.
  // After MSBuild recompilation with stubs, class indices shift → Luna instantiates wrong class → Awake() crash
  // → luna:started never fires → iframe injection never runs → empty scene.
  // We inject GameFlowManagerMain via iframe.html, so scene-baked script components are redundant and harmful.
  try {
    for (const stage of ['stage1', 'stage2', 'stage3', 'stage4']) {
      // Check multiple possible scene data locations
      const scenePaths = [
        path.join(lunaTempDir, stage, 'assets', 'scenes'),
        path.join(lunaTempDir, stage, 'develop', 'assets', 'scenes'),
        path.join(lunaTempDir, stage, 'develop', 'engine', 'assets', 'scenes'),
      ];
      for (const scenesDir of scenePaths) {
        if (!fs.existsSync(scenesDir)) continue;
        const sceneFiles = fs.readdirSync(scenesDir).filter(f => f.endsWith('.json'));
        for (const sf of sceneFiles) {
          const sfPath = path.join(scenesDir, sf);
          try {
            const sceneData = JSON.parse(fs.readFileSync(sfPath, 'utf-8'));
            let stripped = 0;
            if (sceneData.objects) {
              for (const obj of sceneData.objects) {
                if (obj.components) {
                  const before = obj.components.length;
                  obj.components = obj.components.filter(c => c.type !== 4);
                  stripped += before - obj.components.length;
                }
              }
            }
            if (stripped > 0) {
              fs.writeFileSync(sfPath, JSON.stringify(sceneData), 'utf-8');
              log(`[luna-build] Stripped ${stripped} custom script(s) from ${stage}/scenes/${sf}`, taskId);
            }
          } catch (pe) { /* skip non-scene JSON */ }
        }
      }
    }
  } catch (e) {
    log('[luna-build] Warning stripping scene scripts: ' + e.message, taskId);
  }

  // 2.5 DO NOT modify Event.cs or EventPool.cs — they are a partial class pair.
  // Modifying Event.cs breaks syntax (CS1022). EventPool conflicts are handled
  // in worker-coder.js pre-build by renaming AI's EventPool→GFM_EventPool in GameFlowManagerMain.cs.
  // See memory/2026-03-15.md commit 10fa378 and rules.md EventPool 铁律.

  // 3. Clean MSBuild obj cache to force recompilation
  const objDir = path.join(CSPROJ_DIR, 'obj');
  if (fs.existsSync(objDir)) {
    try { fs.rmSync(objDir, { recursive: true, force: true }); } catch (e) {
      log('[luna-build] Warning cleaning obj: ' + e.message, taskId);
    }
  }

  // 3.5 Fix csproj paths: replace hardcoded \Client\Assets\ with \Assets\
  // The csproj is generated by jake stage1 with the old project structure (had Client\ prefix)
  try {
    const csprojContent = fs.readFileSync(CSPROJ_PATH, 'utf-8');
    const clientPrefix = clientDir.replace(/\\/g, '\\') + '\\Client\\';
    const correctPrefix = clientDir.replace(/\\/g, '\\') + '\\';
    if (csprojContent.includes('\\Client\\Assets\\')) {
      const fixed = csprojContent.replace(/\\Client\\Assets\\/g, '\\Assets\\');
      fs.writeFileSync(CSPROJ_PATH, fixed, 'utf-8');
      log('[luna-build] Fixed csproj paths: removed \\Client\\ prefix', taskId);
    }
  } catch (e) {
    log('[luna-build] Warning fixing csproj paths: ' + e.message, taskId);
  }

  // 4. MSBuild Rebuild (compiles .cs from disk via Bridge.NET → JS)
  const msbuildStart = Date.now();
  try {
    const msbuildResult = execSync(
      `"${MSBUILD_PATH}" "${CSPROJ_PATH}" /t:Rebuild /p:Configuration=Debug /v:minimal 2>&1`,
      {
        cwd: CSPROJ_DIR,
        timeout: 120000,
        encoding: 'utf-8',
        env: { ...process.env, PROJECT_PATH: clientDir }
      }
    );
    const msbuildTime = Math.floor((Date.now() - msbuildStart) / 1000);
    log(`[luna-build] MSBuild Rebuild done in ${msbuildTime}s`, taskId);

    // Check for compilation errors
    if (msbuildResult.includes('个错误') || msbuildResult.includes(' error ')) {
      const errorMatch = msbuildResult.match(/(\d+) 个错误/);
      const errorCount = errorMatch ? parseInt(errorMatch[1]) : 0;
      if (errorCount > 0) {
        const errorLines = msbuildResult.split('\n').filter(l => /error CS/i.test(l)).slice(0, 10);
        return { ok: false, error: `MSBuild: ${errorCount} compilation errors: ${errorLines.join('; ')}` };
      }
    }
  } catch (e) {
    const fullErr = (e.stdout || '') + '\n' + (e.stderr || '') + '\n' + (e.message || '');
    try { fs.writeFileSync(path.join(clientDir, '..', 'msbuild-error.txt'), fullErr, 'utf-8'); } catch(we) {}
    // Extract actual CS error lines for clear reporting
    const csErrors = fullErr.split('\n').filter(l => /error CS\d+/i.test(l)).slice(0, 15);
    const errMsg = csErrors.length > 0 ? csErrors.join('\n') : fullErr.slice(-2000);
    return { ok: false, error: `MSBuild failed: ${errMsg}` };
  }

  // 5. Copy new UnityScriptsCompiler.js to stage3 and stage4
  if (!fs.existsSync(BRIDGE_JS_OUTPUT)) {
    return { ok: false, error: 'MSBuild succeeded but UnityScriptsCompiler.js not found at ' + BRIDGE_JS_OUTPUT };
  }

  const newJs = fs.readFileSync(BRIDGE_JS_OUTPUT);
  const stage3JsDir = path.join(lunaTempDir, 'stage3', 'engine', 'unity', 'bin');
  const stage4JsDir = path.join(stage4Dir, 'engine', 'unity', 'bin');

  const copyTargets = [stage3JsDir, stage4JsDir];
  for (const dir of copyTargets) {
    const target = path.join(dir, 'UnityScriptsCompiler.js');
    if (fs.existsSync(dir)) {
      fs.writeFileSync(target, newJs);
      log(`[luna-build] Copied new JS to ${target} (${newJs.length} bytes)`, taskId);
    }
  }

  // 6. Inject GameFlowManagerMain component into iframe.html
  // Luna scene data doesn't include GameManager object (not in SVN scene),
  // so we inject JS that creates it at runtime after Luna starts
  const iframePath = path.join(stage4Dir, 'iframe.html');
  if (fs.existsSync(iframePath)) {
    let html = fs.readFileSync(iframePath, 'utf-8');
    const injectionScript = `<script>
// Polyfill Resources.GetBuiltinResource for Luna (not implemented natively)
window.addEventListener("luna:starting", function() {
  try {
    var origGetBuiltin = UnityEngine.Resources.GetBuiltinResource;
    UnityEngine.Resources.GetBuiltinResource = function(type, name) {
      // Font request
      if (name && name.indexOf(".ttf") >= 0) {
        try { return Font.CreateDynamicFontFromOSFont("Arial", 14); } catch(e) {}
        return null;
      }
      // Mesh request (for CreatePrimitive)
      if (type && type.$$name === "Mesh") {
        var mesh = new UnityEngine.Mesh.ctor();
        if (name === "Cube.fbx") {
          mesh.vertices = Bridge.Array.init([ new UnityEngine.Vector3.ctor$1(-0.5,-0.5,-0.5), new UnityEngine.Vector3.ctor$1(0.5,-0.5,-0.5), new UnityEngine.Vector3.ctor$1(0.5,0.5,-0.5), new UnityEngine.Vector3.ctor$1(-0.5,0.5,-0.5), new UnityEngine.Vector3.ctor$1(-0.5,-0.5,0.5), new UnityEngine.Vector3.ctor$1(0.5,-0.5,0.5), new UnityEngine.Vector3.ctor$1(0.5,0.5,0.5), new UnityEngine.Vector3.ctor$1(-0.5,0.5,0.5) ], UnityEngine.Vector3);
          mesh.triangles = Bridge.Array.init([0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,2,3,7,2,7,6,0,4,7,0,7,3,1,2,6,1,6,5], System.Int32);
          mesh.RecalculateNormals();
        } else if (name === "Sphere.fbx" || name === "Capsule.fbx" || name === "Cylinder.fbx") {
          // Use cube mesh as fallback for all primitives
          mesh.vertices = Bridge.Array.init([ new UnityEngine.Vector3.ctor$1(-0.5,-0.5,-0.5), new UnityEngine.Vector3.ctor$1(0.5,-0.5,-0.5), new UnityEngine.Vector3.ctor$1(0.5,0.5,-0.5), new UnityEngine.Vector3.ctor$1(-0.5,0.5,-0.5), new UnityEngine.Vector3.ctor$1(-0.5,-0.5,0.5), new UnityEngine.Vector3.ctor$1(0.5,-0.5,0.5), new UnityEngine.Vector3.ctor$1(0.5,0.5,0.5), new UnityEngine.Vector3.ctor$1(-0.5,0.5,0.5) ], UnityEngine.Vector3);
          mesh.triangles = Bridge.Array.init([0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,2,3,7,2,7,6,0,4,7,0,7,3,1,2,6,1,6,5], System.Int32);
          mesh.RecalculateNormals();
        } else if (name === "Plane.fbx") {
          mesh.vertices = Bridge.Array.init([ new UnityEngine.Vector3.ctor$1(-5,0,-5), new UnityEngine.Vector3.ctor$1(5,0,-5), new UnityEngine.Vector3.ctor$1(5,0,5), new UnityEngine.Vector3.ctor$1(-5,0,5) ], UnityEngine.Vector3);
          mesh.triangles = Bridge.Array.init([0,2,1,0,3,2], System.Int32);
          mesh.RecalculateNormals();
        }
        return mesh;
      }
      // Material request
      if (type && type.$$name === "Material") {
        var sh = UnityEngine.Shader.Find("Universal Render Pipeline/Lit") || UnityEngine.Shader.Find("UI/Default") || UnityEngine.Shader.Find("Sprites/Default");
        if (sh) return new UnityEngine.Material.ctor(sh);
        return null;
      }
      if (origGetBuiltin) try { return origGetBuiltin.apply(this, arguments); } catch(e) {}
      return null;
    };
    // Also patch Shader.Find to fallback when shader not found
    var origShaderFind = UnityEngine.Shader.Find;
    UnityEngine.Shader.Find = function(name) {
      var s = origShaderFind(name);
      if (!s) s = origShaderFind("UI/Default");
      return s;
    };
    // Patch MeshRenderer.material to auto-create default material if null
    var mrProto = UnityEngine.MeshRenderer.prototype;
    if (mrProto) {
      var origMatGetter = Object.getOwnPropertyDescriptor(mrProto, "material") || 
                          Object.getOwnPropertyDescriptor(UnityEngine.Renderer.prototype, "material");
      if (origMatGetter && origMatGetter.get) {
        var origGet = origMatGetter.get;
        var origSet = origMatGetter.set;
        Object.defineProperty(UnityEngine.Renderer.prototype, "material", {
          get: function() {
            var m = origGet.call(this);
            if (!m) {
              var sh = UnityEngine.Shader.Find("Universal Render Pipeline/Lit");
              m = new UnityEngine.Material.ctor(sh);
              if (origSet) origSet.call(this, m);
            }
            return m;
          },
          set: origSet,
          configurable: true
        });
      }
    }
    // Patch _invokeOverload to catch Awake/OnEnable errors on template components
    // Luna's Bridge.NET compiled code calls _invokeOverload for lifecycle methods (Awake, OnEnable, etc.)
    // Template components (stubbed .cs files) may have undefined methods causing "Cannot read properties of undefined (reading 'Awake()')"
    try {
      var origInvokeOverload = Bridge.Reflection.Overloads ? Bridge.Reflection.Overloads.prototype._invokeOverload : null;
      // Patch at prototype level if accessible
      if (!origInvokeOverload) {
        // Try finding it on the function prototype chain used by components
        var sampleProto = UnityEngine.MonoBehaviour.prototype;
        if (sampleProto && sampleProto._invokeOverload) {
          origInvokeOverload = sampleProto._invokeOverload;
          sampleProto._invokeOverload = function() {
            try { return origInvokeOverload.apply(this, arguments); }
            catch(e) {
              if (e && e.message && (e.message.indexOf("Awake()") >= 0 || e.message.indexOf("OnEnable()") >= 0 || e.message.indexOf("undefined") >= 0)) {
                // Silent — stubbed template component, safe to ignore
                return undefined;
              }
              throw e;
            }
          };
        }
      }
      // Also patch the F (Function) prototype that Luna uses for component lifecycle dispatch
      // The error trace shows F._invokeOverload, so we need to find F's prototype
      // Broader approach: patch all MonoBehaviour-derived prototypes
      var allTypes = Bridge.Reflection ? Bridge.Reflection.getMembers : null;
      // Safest: global error handler for Awake-related errors
      var origOnError = window.onerror;
      window.addEventListener("error", function(evt) {
        if (evt && evt.message && (evt.message.indexOf("Awake()") >= 0 || evt.message.indexOf("OnEnable()") >= 0)) {
          evt.preventDefault();
          return true; // suppress
        }
      });
      console.log("[AI] Awake/OnEnable error protection installed");
    } catch(ae) { console.error("[AI] Awake protection setup error:", ae); }

    // Polyfill Transform.SetParent — Luna Canvas components may have undefined .transform
    // When canvas.transform is undefined, SetParent crashes with "Cannot read 'parent' of undefined"
    try {
      var origSetParent = UnityEngine.Transform.prototype.SetParent;
      if (origSetParent) {
        UnityEngine.Transform.prototype.SetParent = function(newParent, worldPositionStays) {
          if (!newParent) {
            console.warn("[AI] SetParent called with null/undefined parent, skipping");
            return;
          }
          try {
            return origSetParent.call(this, newParent, worldPositionStays);
          } catch(spe) {
            console.warn("[AI] SetParent error (suppressed):", spe.message);
          }
        };
        console.log("[AI] Transform.SetParent safety wrapper installed");
      }
    } catch(spe) { console.warn("[AI] SetParent polyfill error:", spe); }

    console.log("[AI] Resources.GetBuiltinResource + Shader.Find + Material polyfill + Awake protection installed");
  } catch(e) { console.error("[AI] Polyfill error:", e); }
});
// Inject GameFlowManagerMain component after Luna fully started
window.addEventListener("luna:started", function() {
  try {
    var go = new UnityEngine.GameObject.ctor("GameManager");
    var comp = go.AddComponent(GameFlowManagerMain);
    if (comp && comp.Start) { try { comp.Start(); } catch(se) { console.error("[AI] Start() error:", se); } }
    // Fix null shaders: Luna's __MaterialSource sharedMaterial has null shader after serialization
    // GFM_Create copies _baseMat from it, so all pool objects get null shader = invisible
    // Fix: recreate materials with URP/Lit shader, preserving original colors
    // MUST be delayed — PlayCanvas render pipeline needs a few seconds to stabilize before material reassignment triggers dirty flags
    function fixNullShaders() {
      try {
        var fixShader = UnityEngine.Shader.Find("Universal Render Pipeline/Lit") || UnityEngine.Shader.Find("Standard");
        if (fixShader) {
          if (GFM_Create && GFM_Create._baseMat && !GFM_Create._baseMat.shader) {
            GFM_Create._baseMat = new UnityEngine.Material.$ctor2(fixShader);
            GFM_Create._baseMat.color = new pc.Color(1, 1, 1, 1);
          }
          var allRoots = UnityEngine.SceneManagement.SceneManager.GetActiveScene().getRootGameObjects();
          var shaderFixed = 0;
          for (var ri = 0; ri < allRoots.length; ri++) {
            var rObj = allRoots[ri];
            var rr = rObj.GetComponent(UnityEngine.MeshRenderer);
            if (rr && UnityEngine.Component.op_Inequality(rr, null) && rr.material) {
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
    // Run shader fix after delay (PlayCanvas needs render loop running before material dirty flags work)
    setTimeout(fixNullShaders, 2000);
    // Also run again at 5s for safety (some objects may be created by Update loop after initial delay)
    setTimeout(fixNullShaders, 5000);
    // Luna injection: Update() is NOT called automatically by Unity runtime
    // Must manually drive the game loop via requestAnimationFrame
    if (comp && comp.Update) {
      var lastTime = performance.now();
      function gameLoop() {
        var now = performance.now();
        var dt = (now - lastTime) / 1000.0;
        lastTime = now;
        // Set Time.deltaTime for the frame (Luna exposes this)
        try { if (UnityEngine.Time) UnityEngine.Time.deltaTime = dt; } catch(e) {}
        try { comp.Update(); } catch(e) { /* silent — Update errors are common during transitions */ }
        requestAnimationFrame(gameLoop);
      }
      requestAnimationFrame(gameLoop);
      console.log("[AI] Update() loop started via requestAnimationFrame");
    }
    console.log("[AI] GameFlowManagerMain injected successfully");
  } catch(e) { console.error("[AI] Failed to inject GameFlowManagerMain:", e); }
});
<\/script>`;
    // Insert before closing </body> or </html>
    if (html.includes('</body>')) {
      html = html.replace('</body>', injectionScript + '</body>');
    } else {
      html = html.replace('</html>', injectionScript + '</html>');
    }
    fs.writeFileSync(iframePath, html);
    log('[luna-build] Injected GameFlowManagerMain component into iframe.html', taskId);
  }

  // 6.5 CRITICAL: Patch script1.js _invokeOverload to prevent Awake crash
  // Root cause: Scene data has components with class indices that don't match recompiled code.
  // Luna calls _invokeOverload("Awake") → this.code.overloads is undefined → crash → luna:started never fires.
  // Fix: Add null-check on this.code.overloads before accessing it.
  const script1Path = path.join(stage4Dir, 'engine', 'luna', 'script1.js');
  if (fs.existsSync(script1Path)) {
    let script1 = fs.readFileSync(script1Path, 'utf-8');
    const oldPattern = '_invokeOverload(e){try{const t=this.code.overloads[e+"()"]';
    const newPattern = '_invokeOverload(e){try{if(!this.code||!this.code.overloads)return;const t=this.code.overloads[e+"()"]';
    if (script1.includes(oldPattern)) {
      script1 = script1.replace(oldPattern, newPattern);
      fs.writeFileSync(script1Path, script1);
      log('[luna-build] ✅ Patched script1.js _invokeOverload: added null-check for code.overloads (prevents Awake crash)', taskId);
    } else {
      log('[luna-build] ⚠️ _invokeOverload pattern not found in script1.js — may already be patched or format changed', taskId);
    }
    // Also patch stage3 copy if exists
    const script1Stage3 = path.join(lunaTempDir, 'stage3', 'engine', 'luna', 'script1.js');
    if (fs.existsSync(script1Stage3)) {
      let s3 = fs.readFileSync(script1Stage3, 'utf-8');
      if (s3.includes(oldPattern)) {
        s3 = s3.replace(oldPattern, newPattern);
        fs.writeFileSync(script1Stage3, s3);
      }
    }
  }

  // 7. Verify AI code is in the build output (prevent template-only builds)
  const finalJsPath = path.join(stage4Dir, 'engine', 'unity', 'bin', 'UnityScriptsCompiler.js');
  if (fs.existsSync(finalJsPath)) {
    const finalJs = fs.readFileSync(finalJsPath, 'utf-8');
    if (!finalJs.includes('GameFlowManagerMain')) {
      log('[luna-build] ⚠️ WARNING: UnityScriptsCompiler.js does NOT contain GameFlowManagerMain — AI code may not be compiled in!', taskId);
      return { ok: false, error: 'Build verification failed: AI code (GameFlowManagerMain) not found in compiled JS. The build output may be template-only.' };
    }
    log(`[luna-build] ✅ Build verified: GameFlowManagerMain found in compiled JS (${(finalJs.length / 1024).toFixed(0)} KB)`, taskId);
  } else {
    log('[luna-build] ⚠️ UnityScriptsCompiler.js not found in stage4, skipping verification', taskId);
  }

  const totalTime = Math.floor((Date.now() - startTime) / 1000);
  log(`[luna-build] Build completed in ${totalTime}s (jake: ${jakeBuildTime}s + msbuild: ${totalTime - jakeBuildTime}s)`, taskId);

  return {
    ok: true,
    output: `Build completed in ${totalTime}s`,
    buildTime: totalTime,
    outputDir: stage4Dir
  };
}

// Legacy compatibility
async function checkBridge() { return true; }
function bridgeRequest() { return Promise.resolve({}); }

module.exports = { runBridgeBuild, checkBridge, bridgeRequest };

if (require.main === module) {
  (async () => {
    const clientDir = process.argv[2] || 'D:\\work\\test-luna\\Client';
    const result = await runBridgeBuild(clientDir, console.log, 'test');
    console.log('Result:', JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  })();
}
