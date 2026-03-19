/**
 * Render iframe.html from Luna pipeline pug templates.
 * Replicates the exact structure of jake-generated develop iframe.html.
 * 
 * Usage: node render-iframe.js <stage4Dir> [lunaJsonPath]
 */
const fs = require('fs');
const path = require('path');

const stage4Dir = process.argv[2] || 'D:\\work\\test-luna\\LunaTemp\\stage4\\develop';
const lunaJsonPath = process.argv[3] || path.join(path.dirname(path.dirname(path.dirname(stage4Dir))), 'luna.json');

// Read luna.json
let lunaJson = {};
if (fs.existsSync(lunaJsonPath)) {
  try { lunaJson = JSON.parse(fs.readFileSync(lunaJsonPath, 'utf8')); } catch(e) {}
}
const runtimeAnalysisModules = lunaJson.runtimeAnalysisModules || ['physics3d', 'physics2d', 'particle_system', 'reflection', 'prefabs', 'mecanim'];
const scenes = lunaJson.scenes || ['Assets/Scenes/templeteScene.unity'];
const projectId = lunaJson.projectId || '';
const version = lunaJson.version || '6.4.0';
const startupScene = scenes[0] || 'Assets/Scenes/templeteScene.unity';

const envObj = {
  baseUrl: './',
  resourceConfig: { json: 'external', image: 'external', video: 'external', blob: 'external', sound: 'external' },
  runtimeAnalysisModules, scenes, startupScene: 0, projectId, version
};

// Collect scripts in correct order
const engineDir = path.join(stage4Dir, 'engine', 'unity', 'bin');
const lunaDir = path.join(stage4Dir, 'engine', 'luna');
const jsDir = path.join(stage4Dir, 'js');
const moduleMap = { 'mecanim-wasm': 'mecanim', 'mecanim': 'mecanim', 'particle-system': 'particle_system', 'particle_system': 'particle_system', 'urp': 'urp' };

const scripts = [];
const engineFiles = fs.existsSync(engineDir) ? fs.readdirSync(engineDir).filter(f => f.endsWith('.js')) : [];

// === LOAD ORDER (critical!) ===
// 1. Luna/PlayCanvas engine FIRST (defines `pc` global, needed by UnityEngine.js)
// 2. Bridge.NET core (bridge.js defines Bridge runtime)
// 3. .NET assemblies (UnityEngine.js etc. reference both `pc` and `Bridge`)
// 4. UnityScriptsCompiler.js (user code)
// 5. Additional JS (deserializers)

// 1. Luna/PlayCanvas engine (from manifest.json)
if (fs.existsSync(lunaDir)) {
  const lunaFiles = fs.readdirSync(lunaDir).filter(f => f.endsWith('.js'));
  const manifestPath = path.join(lunaDir, 'manifest.json');
  let lunaLoadOrder = [];
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      manifest.sort((a, b) => (a.priority || 0) - (b.priority || 0));
      for (const entry of manifest) {
        const mod = entry.ifModule ? (moduleMap[entry.ifModule] || entry.ifModule) : null;
        const unlessMod = entry.unlessModule ? (moduleMap[entry.unlessModule] || entry.unlessModule) : null;
        if (mod && !runtimeAnalysisModules.includes(mod)) continue;
        if (unlessMod && runtimeAnalysisModules.includes(unlessMod)) continue;
        if (lunaFiles.includes(entry.src)) lunaLoadOrder.push(entry.src);
      }
    } catch(e) {}
  }
  if (lunaLoadOrder.length === 0) lunaLoadOrder = lunaFiles.filter(f => f !== 'manifest.json').sort();
  for (const f of lunaLoadOrder) scripts.push('engine/luna/' + f);
}

// 2. Bridge.NET core
const bridgeOrder = ['bridge.js', 'bridge.meta.js', 'Bridge.Locales.js'];
for (const f of bridgeOrder) { if (engineFiles.includes(f)) scripts.push('engine/unity/bin/' + f); }

// 3. .NET assemblies (depend on both pc and Bridge)
const unityOrder = ['UnityEngine.js', 'UnityEngine.UI.js', 'UnityEngine.UniversalRenderPipeline.js',
                    'DOTween.js', 'newtonsoft.json.js', 'TextMeshPro.js', 'JetBrains.js'];
for (const f of unityOrder) { if (engineFiles.includes(f)) scripts.push('engine/unity/bin/' + f); }
for (const f of engineFiles) {
  if (!bridgeOrder.includes(f) && !unityOrder.includes(f) && f !== 'UnityScriptsCompiler.js') {
    scripts.push('engine/unity/bin/' + f);
  }
}

// 4. UnityScriptsCompiler.js (user code)
if (engineFiles.includes('UnityScriptsCompiler.js')) scripts.push('engine/unity/bin/UnityScriptsCompiler.js');
if (fs.existsSync(jsDir)) {
  for (const f of fs.readdirSync(jsDir).filter(f => f.endsWith('.js'))) scripts.push('js/' + f);
}

// Read template resources from Luna pipeline
const pipelineDir = 'D:\\Luna\\pipeline\\templates\\html\\resources';
function readFile(p) { try { return fs.readFileSync(p, 'utf8'); } catch(e) { return ''; } }
const touchEmulatorJs = readFile(path.join(pipelineDir, 'js', 'touch-emulator.js'));
const defaultCss = readFile(path.join(pipelineDir, 'css', 'default.css'));
const piJs = readFile(path.join(pipelineDir, '..', '..', 'resources', 'js', 'pi.js')) ||
             readFile('D:\\Luna\\pipeline\\templates\\html\\resources\\js\\pi.js');
const contentJs = readFile('D:\\Luna\\pipeline\\templates\\html\\playground\\content.js');
const runtimeJs = readFile('D:\\Luna\\pipeline\\templates\\html\\playground\\runtime.js');
const sharedJs = readFile('D:\\Luna\\pipeline\\templates\\html\\resources\\pug\\content\\shared.pug'); // might be pug, skip if so

// Script tags WITHOUT defer (synchronous, matching body.pug inline structure)
const scriptTags = scripts.map(s => `<script src="${s}"></script>`).join('\n');

// Fix new Event() for headless compatibility
const safeEvent = (name) => `(function(){var _e=document.createEvent("Event");_e.initEvent("${name}",true,true);return _e;})()`;

const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<meta http-equiv="cache-control" content="no-cache, no-store, must-revalidate, post-check=0, pre-check=0">
<meta http-equiv="cache-control" content="max-age=0">
<meta http-equiv="expires" content="0">
<meta http-equiv="pragma" content="no-cache">
</head>
<body>
${touchEmulatorJs ? '<script>' + touchEmulatorJs + '</script>' : ''}
<style>${defaultCss}</style>

<!-- layout.pug: config block -->
<script>
var $environment = ${JSON.stringify(envObj)};
</script>

<!-- layout.pug: libraries block (pi.js) -->
${piJs ? '<script>' + piJs + '</script>' : ''}

<!-- layout.pug: global variables (MUST be before engine scripts) -->
<script>
window.DEBUG = false;
window.TRACE = false;
window.DEVELOP = true;
window.TESTS = false;
window.FORCE_STABLE_RANDOM_SEED = false;
</script>

<!-- layout.pug: pi block (module variables) -->
<script>
for (var _m of $environment.runtimeAnalysisModules) {
  window['MODULE_' + _m] = true;
}
</script>

<!-- body.pug: canvas element -->
<canvas id="application-canvas"></canvas>

<!-- body.pug: bridge ready / luna ready event chain -->
<script>
window._bridgeReady = false;
window._domReady = false;
window._readyEventEmitted = false;
window.addEventListener("DOMContentLoaded", function() {
  if (window._compressedAssets) {
    Promise.all(window._compressedAssets).then(function() {
      window.dispatchEvent(${safeEvent('bridge:ready')});
    });
  }
});
window.addEventListener("bridge:ready", function() {
  window._bridgeReady = true;
  if (window._domReady && !window._readyEventEmitted) {
    window._readyEventEmitted = true;
    window.dispatchEvent(${safeEvent('luna:ready')});
  }
});
window.addEventListener("DOMContentLoaded", function() {
  window._domReady = true;
  if ("Bridge" in window) { window._bridgeReady = true; }
  if (window._bridgeReady && !window._readyEventEmitted) {
    window._readyEventEmitted = true;
    window.dispatchEvent(${safeEvent('luna:ready')});
  }
});
</script>

<!-- body.pug: startGame function -->
<script>
function startGame() {
  return new Promise(function(resolve, reject) {
    pc.TextGenerator.fontRatio = 2.0;
    window.app = new LunaUnity.Application(
      document.getElementById("application-canvas"),
      window.$environment,
      new LunaUnity.Application.StartupScene("-1", "${startupScene}")
    );
    var initializeTask = (window.app.InitializeAsync && window.app.InitializeAsync()) || System.Threading.Tasks.Task.fromResult(true);
    initializeTask.continueWith(function(status) {
      if (status.exception) {
        console.error('Cannot start the game due to exception');
        reject(status.exception);
        return;
      }
      window.dispatchEvent(${safeEvent('luna:initialized')});
      window.dispatchEvent(${safeEvent('luna:starting')});
      window.app.StartWithJSCallback(function() {
        var preloader = document.getElementById("application-preloader");
        if (preloader != null) { preloader.parentNode.removeChild(preloader); }
        resolve();
      });
    });
  });
}
</script>

<!-- body.pug: volume/pause/resume handlers -->
<script>
(function() {
  var _mute = false;
  window.audioVolumeToggle = function(mute) {
    if (mute !== _mute) {
      _mute = mute;
      if (mute) {
        try { Luna.Unity.LifeCycle.OnMute(); } catch(e) {}
        try { window.app.app.muteAudio(); } catch(e) {}
      } else {
        try { Luna.Unity.LifeCycle.OnUnmute(); } catch(e) {}
        try { window.app.app.unmuteAudio(); } catch(e) {}
      }
      if (window.app && window.app.AudioManager) {
        window.app.AudioManager.TriggerMasterVolumeChange(_mute ? 0 : 1);
      }
    }
  };
  window.addEventListener("luna:unmute", function() { window.audioVolumeToggle(false); });
  window.addEventListener("luna:mute", function() { window.audioVolumeToggle(true); });
  window.addEventListener("luna:pause", function() {
    if (window.app && window.app.app) { try { Luna.Unity.LifeCycle.OnPause(); window.app.app.pause(); } catch(e) {} }
  });
  window.addEventListener("luna:resume", function() {
    if (window.app && window.app.app) { try { Luna.Unity.LifeCycle.OnResume(); window.app.app.resume(); } catch(e) {} }
  });
})();
</script>

<!-- layout.pug: engine script tags (synchronous, in dependency order) -->
${scriptTags}

<!-- develop/index.pug: content block (auto-start when not in iframe) -->
<script>
window.addEventListener('luna:ready', function() {
  if (!(function() { try { return window.self !== window.top; } catch(e) { return true; } })()) {
    window.dispatchEvent(${safeEvent('luna:build')});
    window.dispatchEvent(${safeEvent('luna:start')});
    window.dispatchEvent(${safeEvent('playground:started')});
  }
});
</script>

<!-- playground content.js and runtime.js -->
${contentJs ? '<script>' + contentJs + '</script>' : ''}
${runtimeJs ? '<script>' + runtimeJs + '</script>' : ''}

</body>
</html>`;

const outPath = path.join(stage4Dir, 'iframe.html');
fs.writeFileSync(outPath, html);
console.log('Generated iframe.html: ' + (html.length / 1024).toFixed(1) + 'KB');
console.log('Scripts (' + scripts.length + '): ' + scripts.join(', '));
process.exit(0);
