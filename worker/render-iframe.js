/**
 * Render iframe.html from Luna pipeline pug templates.
 * Produces the same output as jake stage4, without needing Unity Editor.
 * 
 * Usage: node render-iframe.js <stage4Dir> [lunaJsonPath]
 * Output: writes iframe.html to stage4Dir
 */
const fs = require('fs');
const path = require('path');

const stage4Dir = process.argv[2] || 'D:\\work\\test-luna\\LunaTemp\\stage4\\develop';
const lunaJsonPath = process.argv[3] || path.join(path.dirname(path.dirname(path.dirname(stage4Dir))), 'luna.json');

// Read luna.json for environment config
let lunaJson = {};
if (fs.existsSync(lunaJsonPath)) {
  try { lunaJson = JSON.parse(fs.readFileSync(lunaJsonPath, 'utf8')); } catch(e) {}
}

const runtimeAnalysisModules = lunaJson.runtimeAnalysisModules || ['physics3d', 'physics2d', 'particle_system', 'reflection', 'prefabs', 'mecanim'];
const scenes = lunaJson.scenes || [];
const projectId = lunaJson.projectId || '';
const version = lunaJson.version || '6.4.0';

// Build $environment
const envObj = {
  baseUrl: './',
  resourceConfig: { json: 'external', image: 'external', video: 'external', blob: 'external', sound: 'external' },
  runtimeAnalysisModules,
  scenes,
  startupScene: 0,
  projectId,
  version
};

// Collect scripts in correct order from stage4
const engineDir = path.join(stage4Dir, 'engine', 'unity', 'bin');
const lunaDir = path.join(stage4Dir, 'engine', 'luna');
const jsDir = path.join(stage4Dir, 'js');

// Active modules for manifest.json filtering
const activeModules = runtimeAnalysisModules.slice();
const moduleMap = { 'mecanim-wasm': 'mecanim', 'mecanim': 'mecanim', 'particle-system': 'particle_system', 'particle_system': 'particle_system', 'urp': 'urp' };

const scripts = [];

// 1. Bridge.NET core
const bridgeOrder = ['bridge.js', 'bridge.meta.js', 'Bridge.Locales.js'];
const unityOrder = ['UnityEngine.js', 'UnityEngine.UI.js', 'UnityEngine.UniversalRenderPipeline.js',
                    'DOTween.js', 'newtonsoft.json.js', 'TextMeshPro.js', 'JetBrains.js'];
const engineFiles = fs.existsSync(engineDir) ? fs.readdirSync(engineDir).filter(f => f.endsWith('.js')) : [];

for (const f of bridgeOrder) {
  if (engineFiles.includes(f)) scripts.push('engine/unity/bin/' + f);
}
for (const f of unityOrder) {
  if (engineFiles.includes(f)) scripts.push('engine/unity/bin/' + f);
}
for (const f of engineFiles) {
  if (!bridgeOrder.includes(f) && !unityOrder.includes(f) && f !== 'UnityScriptsCompiler.js') {
    scripts.push('engine/unity/bin/' + f);
  }
}

// 2. Luna/PlayCanvas engine (from manifest.json)
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
        if (mod && !activeModules.includes(mod)) continue;
        if (unlessMod && activeModules.includes(unlessMod)) continue;
        if (lunaFiles.includes(entry.src)) lunaLoadOrder.push(entry.src);
      }
    } catch(e) {}
  }
  if (lunaLoadOrder.length === 0) lunaLoadOrder = lunaFiles.filter(f => f !== 'manifest.json').sort();
  for (const f of lunaLoadOrder) scripts.push('engine/luna/' + f);
}

// 3. UnityScriptsCompiler.js (user code)
if (engineFiles.includes('UnityScriptsCompiler.js')) {
  scripts.push('engine/unity/bin/UnityScriptsCompiler.js');
}

// 4. Additional JS
if (fs.existsSync(jsDir)) {
  for (const f of fs.readdirSync(jsDir).filter(f => f.endsWith('.js'))) {
    scripts.push('js/' + f);
  }
}

// Read pi.js from Luna pipeline
const piJsPath = 'D:\\Luna\\pipeline\\templates\\html\\resources\\js\\pi.js';
let piJs = '';
if (fs.existsSync(piJsPath)) {
  piJs = fs.readFileSync(piJsPath, 'utf8');
}

// Read touch-emulator.js
const touchEmulatorPath = 'D:\\Luna\\pipeline\\templates\\html\\resources\\js\\touch-emulator.js';
let touchEmulatorJs = '';
if (fs.existsSync(touchEmulatorPath)) {
  touchEmulatorJs = fs.readFileSync(touchEmulatorPath, 'utf8');
}

// Read default.css
const defaultCssPath = 'D:\\Luna\\pipeline\\templates\\html\\resources\\css\\default.css';
let defaultCss = '';
if (fs.existsSync(defaultCssPath)) {
  defaultCss = fs.readFileSync(defaultCssPath, 'utf8');
}

// Read content.js and runtime.js from playground template
const contentJsPath = 'D:\\Luna\\pipeline\\templates\\html\\playground\\content.js';
let contentJs = '';
if (fs.existsSync(contentJsPath)) {
  contentJs = fs.readFileSync(contentJsPath, 'utf8');
}

const runtimeJsPath = 'D:\\Luna\\pipeline\\templates\\html\\playground\\runtime.js';
let runtimeJs = '';
if (fs.existsSync(runtimeJsPath)) {
  runtimeJs = fs.readFileSync(runtimeJsPath, 'utf8');
}

// Generate script tags with defer (matching jake output)
const scriptTags = scripts.map(s => `<script src="${s}" defer data-startup-only></script>`).join('\n');

// Module variables
const moduleVars = runtimeAnalysisModules.map(m => `window['MODULE_${m}'] = true;`).join('\n        ');

// Generate HTML matching layout.pug + develop/index.pug structure
const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<meta http-equiv="cache-control" content="no-cache, no-store, must-revalidate, post-check=0, pre-check=0">
<meta http-equiv="cache-control" content="max-age=0">
<meta http-equiv="expires" content="0">
<meta http-equiv="expires" content="Tue, 01 Jan 1980 1:00:00 GMT">
<meta http-equiv="pragma" content="no-cache">
</head>
<body>
${touchEmulatorJs ? '<script>' + touchEmulatorJs + '</script>' : ''}
<style>${defaultCss}</style>
<script>var $environment = ${JSON.stringify(envObj)};</script>
${piJs ? '<script>' + piJs + '</script>' : ''}
<script>
window._bridgeReady = false;
window._domReady = false;
window._readyEventEmitted = false;
window.addEventListener("DOMContentLoaded", function() {
  if (window._compressedAssets) {
    Promise.all(window._compressedAssets).then(function() {
      window.dispatchEvent((function(){var _e=document.createEvent("Event");_e.initEvent("bridge:ready",true,true);return _e;})());
    });
  }
});
window.addEventListener("bridge:ready", function() {
  window._bridgeReady = true;
  if (window._domReady && !window._readyEventEmitted) {
    window._readyEventEmitted = true;
    window.dispatchEvent((function(){var _e=document.createEvent("Event");_e.initEvent("luna:ready",true,true);return _e;})());
  }
});
window.addEventListener("DOMContentLoaded", function() {
  window._domReady = true;
  if ("Bridge" in window) { window._bridgeReady = true; }
  if (window._bridgeReady && !window._readyEventEmitted) {
    window._readyEventEmitted = true;
    window.dispatchEvent((function(){var _e=document.createEvent("Event");_e.initEvent("luna:ready",true,true);return _e;})());
  }
});
</script>
<script>
window.DEBUG = false;
window.TRACE = false;
window.DEVELOP = true;
window.TESTS = false;
window.FORCE_STABLE_RANDOM_SEED = false;

for (var _m of $environment.runtimeAnalysisModules) {
  window['MODULE_' + _m] = true;
}
</script>
${scriptTags}
<script>
window.addEventListener('luna:ready', function() {
  if (!(function() { try { return window.self !== window.top; } catch(e) { return true; } })()) {
    window.dispatchEvent((function(){var _e=document.createEvent("Event");_e.initEvent("luna:build",true,true);return _e;})());
    window.dispatchEvent((function(){var _e=document.createEvent("Event");_e.initEvent("luna:start",true,true);return _e;})());
    window.dispatchEvent((function(){var _e=document.createEvent("Event");_e.initEvent("playground:started",true,true);return _e;})());
  }
});
</script>
${contentJs ? '<script>' + contentJs + '</script>' : ''}
${runtimeJs ? '<script>' + runtimeJs + '</script>' : ''}
</body>
</html>`;

const outPath = path.join(stage4Dir, 'iframe.html');
fs.writeFileSync(outPath, html);
console.log('Generated iframe.html: ' + (html.length / 1024).toFixed(1) + 'KB');
console.log('Scripts (' + scripts.length + '): ' + scripts.join(', '));
process.exit(0);
