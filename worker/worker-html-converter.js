// Worker HTML Converter — Luna stage4/develop → single-file HTML per channel
// Extracted from playable-tools-v2/electron/onePlaygroundCore
// Dependencies: brotli, html-minifier

const fs = require('fs');
const path = require('path');
const brotli = require('brotli');
const { minify } = require('html-minifier');

// ============ Paths (set by caller or defaults) ============
const TEMPLATES_DIR = process.env.TEMPLATES_DIR || path.join(__dirname, 'html-templates');

// ============ Load templates lazily ============
var _templateHtml = null;
var _decompressScript = null;

function getTemplateHtml() {
  if (!_templateHtml) _templateHtml = fs.readFileSync(path.join(TEMPLATES_DIR, 'index.template.html'), 'utf-8');
  return _templateHtml;
}

function getDecompressScript() {
  if (!_decompressScript) {
    var raw = fs.readFileSync(path.join(TEMPLATES_DIR, 'decompressScript.js'), 'utf-8');
    // The file exports a base64-encoded string, extract it
    var match = raw.match(/export\s+(?:var|const|let)\s+decompressScript\s*=\s*["`']([^"'`]+)["`']/s);
    if (match) {
      _decompressScript = Buffer.from(match[1], 'base64').toString('utf-8');
    } else {
      // Try as CJS module
      try {
        var mod = require(path.join(TEMPLATES_DIR, 'decompressScript.cjs'));
        _decompressScript = Buffer.from(mod.decompressScript, 'base64').toString('utf-8');
      } catch (e) {
        // Fallback: use as-is (might already be the script)
        _decompressScript = raw;
      }
    }
  }
  return _decompressScript;
}

// ============ Injection Scripts (from injection.js) ============

var xhrInterpreter = `
Object.defineProperty(XMLHttpRequest.prototype, "response", {
  configurable: true, enumerable: true, value: "", writable: true
});
Object.defineProperty(XMLHttpRequest.prototype, "responseText", {
  configurable: true, enumerable: true, value: "", writable: true
});
Object.defineProperty(XMLHttpRequest.prototype, "status", {
  configurable: true, enumerable: true, value: "", writable: true
});
var originalOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function(_, fileName) {
  if (fileName.startsWith(location.origin)) {
    fileName = fileName.replace(location.origin, ".").replace(location.pathname.slice(0, -11), '');
  }
  if (fileName.slice(0, 4) == "http") {
    this.__useOriginal = true;
    return originalOpen.apply(this, arguments)
  }
  if (fileName.slice(0, 2) == "./") fileName = fileName.slice(2);
  fileName = fileName.slice(fileName.lastIndexOf("assets"))
  var item = __fileDict[fileName];
  Promise.resolve(item.ic ? eval(item.d + "('" + item.data + "')") : item.data).then(response => {
    this.responseText = this.response = response;
    if (this.responseType == "json") this.response = JSON.parse(this.response);
    else if (this.responseType == "arraybuffer" && typeof response == "string") this.response = base64ToArrayBuffer(response);
    this.readyState = 4; this.status = 200; this.onload();
  })
}
function base64ToArrayBuffer(base64) {
  var binaryString = atob(base64);
  var bytes = new Uint8Array(binaryString.length);
  for (var i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
  return bytes.buffer;
}
var originalSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.send = function() {
  if (this.__useOriginal) originalSend.apply(this, arguments);
  this.status = this.Done;
}
`;

var imageInterpreter = `
var imageDescriptor = Object.getOwnPropertyDescriptor(Image.prototype, "src");
Object.defineProperty(Image.prototype, "src", {
  get: imageDescriptor.get.bind(this),
  set(newValue) {
    if ($environment.baseUrl.startsWith('http') || newValue.startsWith('http') || newValue.startsWith("blob:") || newValue.startsWith("data:")) {
      imageDescriptor.set.call(this, newValue);
    } else {
      if (newValue.slice(0, 2) == "./") newValue = newValue.slice(2);
      var image = "";
      var suffix = newValue.slice(newValue.lastIndexOf(".") + 1);
      if (newValue.slice(0, 4) == "data") image = newValue;
      else if (__fileDict[newValue]) image = "data:image/" + suffix + ";base64," + __fileDict[newValue].data;
      else console.log("image not found: " + newValue);
      imageDescriptor.set.call(this, image);
    }
  },
  enumerable: true, configurable: true,
});
`;

var fetchInterpreter = `
var originalFetch = fetch;
fetch = function() {
  var url = arguments[0];
  if (url.slice(0, 4) == "http") return originalFetch.apply(this, arguments);
  var fileName = url.slice(0, 2) == "./" ? url.slice(2) : url;
  var item = __fileDict[fileName];
  return Promise.resolve(item.ic ? eval(item.d + "('" + item.data + "')") : item.data).then(data => {
    return { headers: new Headers(), arrayBuffer: () => data }
  })
}
`;

// ============ Channel Scripts ============

var commonJumpLogic = `
const ua = navigator.userAgent.toLowerCase();
const isIOSUA = /iphone|ipad|ipod/.test(ua);
const isSafariUA = /safari/.test(ua) && !/crios|fxios|edgios/.test(ua);
const isDesktop = navigator.platform === 'MacIntel' || navigator.platform === 'Win32' || navigator.platform === 'Linux x86_64';
const isRealIOSSafari = !isDesktop && isIOSUA && isSafariUA;
let shouldJump = false;
function tryJump() { if (!shouldJump) return; shouldJump = false; if (typeof doJump === 'function') doJump(); }
if (isRealIOSSafari) { document.addEventListener('touchend', tryJump, true); document.addEventListener('click', tryJump, true); }
`;

var installFullGameStandard = `
Luna.Unity.Playable.InstallFullGame = function(n, e) {
  window.pi.logCta();
  shouldJump = true;
  if (!isRealIOSSafari) tryJump();
};
`;

var mraidCommon = `
var n=!1,e=!1;function i(){return mraid.isViewable()&&"hidden"!==mraid.getState()}function a(){n?i()&&e?(window.dispatchEvent(new Event("luna:resume")),e=!1):i()||e||(window.dispatchEvent(new Event("luna:pause")),e=!0):i()&&(window.dispatchEvent(new Event("luna:start")),n=!0)}function t(){}function d(n){window.dispatchEvent(new Event(n?"luna:unsafe:unmute":"luna:unsafe:mute"))}var o=function(){"undefined"!=typeof mraid?(mraid.removeEventListener("ready",o),mraid.addEventListener("viewableChange",a),mraid.addEventListener("stateChange",a),mraid.addEventListener("orientationchange",t),mraid.addEventListener("audioVolumeChange",d),a()):window.dispatchEvent(new Event("luna:start"))};
`;

var CHANNELS = {
  unity: `!(function(){${mraidCommon}${commonJumpLogic}
function doJump(){const cfg=window.$environment.packageConfig||{};const url=isIOSUA?cfg.iosLink:cfg.androidLink;typeof mraid!=='undefined'?mraid.open(url):window.open(url);}
window.addEventListener("luna:build",function(){window.pi.logLoaded(),"undefined"!=typeof mraid?"loading"===mraid.getState()?mraid.addEventListener("ready",o):o():window.dispatchEvent(new Event("luna:start")),Bridge.ready(function(){${installFullGameStandard}});});})();`,

  mintegral: `!(function(){let n=!1;window.gameStart=function(){n?window.dispatchEvent(new Event("luna:resume")):(n=!0,window.dispatchEvent(new Event("luna:start")))},window.gameClose=function(){window.dispatchEvent(new Event("luna:pause"))},window.addEventListener("luna:started",()=>{window.gameReady&&window.gameReady()}),window.addEventListener("luna:build",()=>{window.dispatchEvent(new Event("luna:start"));Bridge.ready(()=>{Luna.Unity.Playable.InstallFullGame=function(){window.pi.logCta(),window.install&&window.install()},Luna.Unity.LifeCycle.GameEnded=function(){window.pi.logGameEnd(),window.gameEnd&&window.gameEnd()}})});window.addEventListener("luna:build",()=>{window.pi.logLoaded()})})();`,

  tiktok: `window.addEventListener("luna:build",(function(){window.pi.logLoaded(),window.dispatchEvent(new Event("luna:start"))}));window.addEventListener("luna:build",()=>{Bridge.ready(()=>{Luna.Unity.Playable.InstallFullGame=function(){window.pi.logCta(),window.openAppStore()}})})`,

  facebook: `${commonJumpLogic}
function doJump(){const cfg=window.$environment.packageConfig||{};const url=isIOSUA?cfg.iosLink:cfg.androidLink;typeof FbPlayableAd!=='undefined'?FbPlayableAd.onCTAClick():window.open(url);}
window.addEventListener("luna:build",()=>{window.dispatchEvent(new Event("luna:start"));Bridge.ready(()=>{${installFullGameStandard}})})`,

  google: `${commonJumpLogic}
function doJump(){const cfg=window.$environment.packageConfig||{};const url=isIOSUA?cfg.iosLink:cfg.androidLink;typeof ExitApi!=='undefined'?ExitApi&&ExitApi.exit&&ExitApi.exit():window.open(url);}
window.addEventListener("luna:build",()=>{window.dispatchEvent(new Event("luna:start"));Bridge.ready(()=>{${installFullGameStandard}})})`,

  snapchat: `window.addEventListener("luna:build",()=>{window.dispatchEvent(new Event("luna:start"));Bridge.ready(()=>{Luna.Unity.Playable.InstallFullGame=function(){ScPlayableAd.onCTAClick()}})})`,

  preview: `window.addEventListener("luna:build",()=>{window.dispatchEvent(new Event("luna:start"));Bridge.ready(()=>{Luna.Unity.Playable.InstallFullGame=function(){var n=window.$environment.packageConfig.iosLink;var e=window.$environment.packageConfig.androidLink;const i=/iphone|ipad|ipod|macintosh/i.test(window.navigator.userAgent.toLowerCase())?n:e;window.open(i,"_blank")}})})`,
};

// Aliases
CHANNELS.appLovin = CHANNELS.unity;
CHANNELS.ironSource = CHANNELS.unity;
CHANNELS.chartboost = CHANNELS.unity;
CHANNELS.liftoff = CHANNELS.unity;
CHANNELS.appier = CHANNELS.unity;
CHANNELS.moloco = CHANNELS.facebook;

// ============ Helpers ============

function insertAt(str, pos, content) {
  return str.slice(0, pos) + content + str.slice(pos);
}

function* walkFiles(dir) {
  var entries = fs.readdirSync(dir, { withFileTypes: true });
  for (var i = 0; i < entries.length; i++) {
    var full = path.join(dir, entries[i].name);
    if (entries[i].isDirectory()) yield* walkFiles(full);
    else yield full;
  }
}

function minifyHtml(html) {
  try {
    return minify(html, {
      removeComments: true,
      collapseWhitespace: true,
      collapseBooleanAttributes: true,
      removeAttributeQuotes: true,
      removeRedundantAttributes: true,
      useShortDoctype: true,
      removeEmptyAttributes: true,
      removeScriptTypeAttributes: true,
      removeStyleLinkTypeAttributes: true,
      minifyJS: true,
      minifyCSS: true,
    });
  } catch (e) {
    console.warn('[converter] minify failed, using raw html:', e.message);
    return html;
  }
}

// ============ Core Build Logic ============

function buildSingleHtml(targetPath, options) {
  options = options || {};
  var templateHtml = getTemplateHtml();
  var decompScript = getDecompressScript();

  var html = templateHtml;

  // 1. Inject decompress script before first <script>
  var firstScript = html.indexOf('<script>');
  if (firstScript > -1) {
    html = insertAt(html, firstScript, decompScript);
  }

  // 2. Inject cache scripts into <head>
  var headEnd = html.indexOf('</head>');
  var cacheFiles = ['cache/210/blobs.js', 'cache/210/jsons.js', 'cache/210/scripts.js'];
  for (var i = 0; i < cacheFiles.length; i++) {
    var cachePath = path.join(targetPath, cacheFiles[i]);
    if (fs.existsSync(cachePath)) {
      var cacheContent = fs.readFileSync(cachePath, 'utf-8');
      var tag = '<script>' + cacheContent + '</script>';
      html = insertAt(html, headEnd, tag);
      headEnd = html.indexOf('</head>'); // recalc after insert
    }
  }

  // 3. Inline images and videos as base64
  var mediaHtml = '';
  for (var f of walkFiles(targetPath)) {
    var rel = path.relative(targetPath, f).replace(/\\/g, '/');
    var ext = path.extname(f).toLowerCase();

    if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
      var imgData = fs.readFileSync(f).toString('base64');
      var imgType = ext === '.jpg' ? 'jpeg' : ext.slice(1);
      mediaHtml += '<img src="data:image/' + imgType + ';base64,' + imgData + '" id="' + rel + '" style="display:none" crossorigin="">';
    } else if (ext === '.mp4') {
      var vidData = fs.readFileSync(f).toString('base64');
      mediaHtml += '<video src="data:video/mp4;base64,' + vidData + '" id="' + rel + '" style="display:none" preload="auto" muted="" playsinline="" crossorigin=""></video>';
    }
  }

  // Insert media after last </script>
  var lastScriptEnd = html.lastIndexOf('</script>') + '</script>'.length;
  html = insertAt(html, lastScriptEnd, mediaHtml);

  return html;
}

function insertChannelConfig(html, channelScript, lunaConfig) {
  var startupScene = 'SampleScene';
  try {
    var sceneMatch = /\/([^\/]+)\.unity/g.exec(lunaConfig.scenes[lunaConfig.startupScene]);
    if (sceneMatch) startupScene = sceneMatch[1];
  } catch (e) {}

  var pkgConfig = (lunaConfig.packages && lunaConfig.packages.default) || {};

  // Insert config before first <script>
  var firstScript = html.indexOf('<script>');
  var configBlock = '<script>'
    + 'window.$startupScene="' + startupScene + '";'
    + 'window.LUNA_PLAYGROUND_PACKAGE_CONFIG=' + JSON.stringify(pkgConfig) + ';'
    + '</script>';
  html = insertAt(html, firstScript, configBlock);

  // Insert channel script after last </script>
  var lastScriptEnd = html.lastIndexOf('</script>') + '</script>'.length;
  html = insertAt(html, lastScriptEnd, '<script>' + channelScript + '</script>');

  // Remove body placeholder if present
  html = html.replace('__bodyPlaceholder__', '');
  html = html.replace('__headContentPlaceholder__', '');
  html = html.replace('__loadingPlaceholder__', '');

  return html;
}

// ============ Main API ============

/**
 * Convert Luna stage4/develop output to single-file HTMLs
 * @param {string} targetPath - Path to stage4/develop/ directory
 * @param {object} options - { channels: ['unity','facebook',...], iosLink, androidLink }
 * @returns {object} { channelName: htmlString, ... }
 */
function convertToHtml(targetPath, options) {
  options = options || {};
  var requestedChannels = options.channels || ['unity', 'preview'];

  // Read luna.json
  var lunaJsonPath = path.join(targetPath, 'luna.json');
  var lunaConfig = {};
  if (fs.existsSync(lunaJsonPath)) {
    try {
      lunaConfig = JSON.parse(fs.readFileSync(lunaJsonPath, 'utf-8')).unity || {};
    } catch (e) {
      console.warn('[converter] Failed to parse luna.json:', e.message);
    }
  }

  // Override store links if provided
  if (lunaConfig.packages && lunaConfig.packages.default) {
    if (options.iosLink) lunaConfig.packages.default.iosLink = options.iosLink;
    if (options.androidLink) lunaConfig.packages.default.androidLink = options.androidLink;
  }

  // Build base HTML (channel-agnostic)
  console.log('[converter] Building base HTML from:', targetPath);
  var baseHtml = buildSingleHtml(targetPath, options);

  // Generate per-channel versions
  var results = {};
  for (var i = 0; i < requestedChannels.length; i++) {
    var ch = requestedChannels[i];
    var script = CHANNELS[ch];
    if (!script) {
      console.warn('[converter] Unknown channel: ' + ch + ', skipping');
      continue;
    }
    console.log('[converter] Building channel:', ch);
    var channelHtml = insertChannelConfig(baseHtml, script, lunaConfig);
    results[ch] = minifyHtml(channelHtml);
  }

  return results;
}

/**
 * Convert and save to disk
 * @param {string} targetPath - stage4/develop/ path
 * @param {string} outputDir - Where to save HTML files
 * @param {object} options - { channels, iosLink, androidLink, projectName }
 */
function convertAndSave(targetPath, outputDir, options) {
  options = options || {};
  var projectName = options.projectName || 'playable';

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  var results = convertToHtml(targetPath, options);
  var saved = [];

  for (var ch in results) {
    var filename = projectName + '_' + ch + '.html';
    var outPath = path.join(outputDir, filename);
    fs.writeFileSync(outPath, results[ch], 'utf-8');
    var size = (Buffer.byteLength(results[ch]) / 1024).toFixed(0);
    console.log('[converter] Saved: ' + filename + ' (' + size + ' KB)');
    saved.push({ channel: ch, path: outPath, size: parseInt(size) });
  }

  return saved;
}

module.exports = { convertToHtml, convertAndSave, CHANNELS };

// ============ CLI ============
if (require.main === module) {
  var targetPath = process.argv[2];
  var outputDir = process.argv[3] || './output';
  var channels = (process.argv[4] || 'unity,preview,facebook,tiktok,google').split(',');

  if (!targetPath) {
    console.log('Usage: node worker-html-converter.js <stage4/develop/path> [outputDir] [channels]');
    console.log('Channels: ' + Object.keys(CHANNELS).join(', '));
    process.exit(1);
  }

  console.log('Converting:', targetPath);
  console.log('Channels:', channels.join(', '));
  var results = convertAndSave(targetPath, outputDir, { channels: channels, projectName: 'playable' });
  console.log('Done! ' + results.length + ' files generated');
}
