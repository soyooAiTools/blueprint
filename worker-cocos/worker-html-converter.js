// Cocos build/web-mobile → single-file HTML per channel
// Strategy: PNG→WebP, text-like→zlib+base64, images→base64
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
let sharp;
try { sharp = require('sharp'); } catch(e) { sharp = null; }

var commonJumpLogic = 'const ua=navigator.userAgent.toLowerCase();const isIOSUA=/iphone|ipad|ipod/.test(ua);const isDesktop=navigator.platform==="MacIntel"||navigator.platform==="Win32";const isRealIOSSafari=!isDesktop&&isIOSUA&&/safari/.test(ua)&&!/crios|fxios/.test(ua);let shouldJump=false;function tryJump(){if(!shouldJump)return;shouldJump=false;if(typeof doJump==="function")doJump();}if(isRealIOSSafari){document.addEventListener("touchend",tryJump,true);document.addEventListener("click",tryJump,true);}';

var CHANNELS = {
  appLovin: '!(function(){' + commonJumpLogic + 'function doJump(){var cfg=window.__channelConfig||{};var url=isIOSUA?cfg.iosLink:cfg.androidLink;typeof mraid!=="undefined"?mraid.open(url):window.open(url);}window.__onCTA=function(){shouldJump=true;if(!isRealIOSSafari)tryJump();};})();',
  facebook: '!(function(){' + commonJumpLogic + 'function doJump(){typeof FbPlayableAd!=="undefined"?FbPlayableAd.onCTAClick():window.open("");}window.__onCTA=function(){shouldJump=true;if(!isRealIOSSafari)tryJump();};})();',
  google: '!(function(){' + commonJumpLogic + 'function doJump(){typeof ExitApi!=="undefined"&&ExitApi.exit?ExitApi.exit():window.open("");}window.__onCTA=function(){shouldJump=true;if(!isRealIOSSafari)tryJump();};})();',
  tiktok: '!(function(){window.__onCTA=function(){window.openAppStore&&window.openAppStore();};})();',
  mintegral: '!(function(){window.gameReady&&window.gameReady();window.__onCTA=function(){window.install&&window.install();};})();',
  preview: '!(function(){window.__onCTA=function(){var url=/iphone|ipad|ipod/i.test(navigator.userAgent)?(window.__channelConfig||{}).iosLink:(window.__channelConfig||{}).androidLink;window.open(url,"_blank");};})();',
};

// Text-like extensions benefit from zlib
var TEXT_EXTS = ['.json', '.bin', '.cconb', '.ccon', '.js'];
// Image/audio extensions — already compressed, skip zlib
var MEDIA_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.mp3', '.ogg', '.wav'];
var ALL_EXTS = TEXT_EXTS.concat(MEDIA_EXTS);

function* walkFiles(dir) {
  var entries = fs.readdirSync(dir, { withFileTypes: true });
  for (var i = 0; i < entries.length; i++) {
    var full = path.join(dir, entries[i].name);
    if (entries[i].isDirectory()) yield* walkFiles(full);
    else yield full;
  }
}

// Convert PNGs to WebP, returns map of original path → {buf, newExt}
async function convertPngs(assetFiles) {
  if (!sharp) {
    console.log('[converter] sharp not available, skipping PNG→WebP conversion');
    return {};
  }
  var converted = {};
  var pngs = assetFiles.filter(f => path.extname(f).toLowerCase() === '.png');
  console.log('[converter] Converting ' + pngs.length + ' PNGs to WebP...');
  var totalBefore = 0, totalAfter = 0;
  for (var f of pngs) {
    try {
      var origBuf = fs.readFileSync(f);
      totalBefore += origBuf.length;
      var webpBuf = await sharp(origBuf).webp({ quality: 85 }).toBuffer();
      totalAfter += webpBuf.length;
      converted[f] = { buf: webpBuf, newExt: '.webp' };
    } catch(e) {
      // Keep original if conversion fails
    }
  }
  if (pngs.length > 0) {
    console.log('[converter] PNG→WebP: ' + (totalBefore/1024/1024).toFixed(1) + 'MB → ' + (totalAfter/1024/1024).toFixed(1) + 'MB (' + Math.round((1 - totalAfter/totalBefore) * 100) + '% saved)');
  }
  return converted;
}

async function buildSingleHtml(buildDir) {
  var indexPath = path.join(buildDir, 'index.html');
  if (!fs.existsSync(indexPath)) throw new Error('index.html not found in ' + buildDir);
  var html = fs.readFileSync(indexPath, 'utf-8');

  // Inline CSS
  html = html.replace(/<link[^>]+href="([^"]+\.css)"[^>]*>/g, function(match, href) {
    var cssPath = path.join(buildDir, href);
    if (fs.existsSync(cssPath)) return '<style>' + fs.readFileSync(cssPath, 'utf-8') + '</style>';
    return match;
  });

  // Inline JS
  html = html.replace(/<script[^>]+src="([^"]+\.js)"[^>]*><\/script>/g, function(match, src) {
    if (src.startsWith('http')) return match;
    var jsPath = path.join(buildDir, src);
    if (fs.existsSync(jsPath)) return '<script>' + fs.readFileSync(jsPath, 'utf-8') + '</script>';
    return match;
  });

  // Collect asset files
  var assetFiles = [];
  var seen = {};
  var scanDirs = ['assets', 'cocos-js', 'src'];
  for (var d of scanDirs) {
    var dir = path.join(buildDir, d);
    if (!fs.existsSync(dir)) continue;
    for (var f of walkFiles(dir)) {
      var ext = path.extname(f).toLowerCase();
      if (ALL_EXTS.indexOf(ext) >= 0) {
        var rel = path.relative(buildDir, f).replace(/\\/g, '/');
        if (!seen[rel]) { assetFiles.push(f); seen[rel] = true; }
      }
    }
  }

  // Convert PNGs to WebP
  var pngConverted = await convertPngs(assetFiles);

  // Build file dict: {relativePath: {d: base64data, z: bool}}
  // z=true means data is zlib-deflated before base64
  var fileDict = {};
  var totalRaw = 0, totalEncoded = 0;

  for (var f of assetFiles) {
    var rel = path.relative(buildDir, f).replace(/\\/g, '/');
    var ext = path.extname(f).toLowerCase();
    var buf;

    if (pngConverted[f]) {
      // Use WebP version, update the key to .webp extension
      buf = pngConverted[f].buf;
      // Keep original rel as key (engine requests original path)
    } else {
      buf = fs.readFileSync(f);
    }

    totalRaw += buf.length;

    if (TEXT_EXTS.indexOf(ext) >= 0) {
      // Compress then base64
      var compressed = zlib.deflateSync(buf, { level: 9 });
      fileDict[rel] = { d: compressed.toString('base64'), z: 1 };
      totalEncoded += compressed.toString('base64').length;
    } else {
      // Direct base64
      fileDict[rel] = { d: buf.toString('base64') };
      totalEncoded += buf.toString('base64').length;
    }
  }

  console.log('[converter] Assets: ' + assetFiles.length + ' files, raw=' + (totalRaw/1024/1024).toFixed(1) + 'MB, encoded=' + (totalEncoded/1024/1024).toFixed(1) + 'MB');

  // Client-side interceptor with zlib inflate support (tiny inline pako-inflate)
  var interceptor = '<script>'
    // Tiny inflate from pako (sync, ~3KB minified) — we inline a minimal version
    + 'var __fd=' + JSON.stringify(fileDict) + ';'
    // Base64 decode helper
    + 'function b64d(s){var b=atob(s),a=new Uint8Array(b.length);for(var i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return a;}'
    // Use DecompressionStream for zlib (async, but we cache results)
    + 'var __cache={};'
    + 'async function inflateB64(s){var c=await new Response(new Blob([b64d(s)]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer();return new Uint8Array(c);}'
    + 'var _xo=XMLHttpRequest.prototype.open,_xs=XMLHttpRequest.prototype.send;'
    + 'XMLHttpRequest.prototype.open=function(m,u){this.__u=u;return _xo.apply(this,arguments);};'
    + 'XMLHttpRequest.prototype.send=function(){'
    + 'var u=this.__u;if(u&&!u.startsWith("http")){var k=u.replace("./","");var e=__fd[k];if(e){'
    + 'var xhr=this;'
    + 'function done(a){'
    + 'try{Object.defineProperty(xhr,"status",{value:200,writable:true});}catch(e){}'
    + 'try{Object.defineProperty(xhr,"readyState",{value:4,writable:true});}catch(e){}'
    + 'try{Object.defineProperty(xhr,"response",{value:a.buffer,writable:true});}catch(e){}'
    + 'try{Object.defineProperty(xhr,"responseText",{value:new TextDecoder().decode(a),writable:true});}catch(e){}'
    + 'if(xhr.onload)xhr.onload();if(xhr.onreadystatechange)xhr.onreadystatechange();'
    + '}'
    + 'if(e.z){inflateB64(e.d).then(done);}else{done(b64d(e.d));}'
    + 'return;}}'
    + 'return _xs.apply(this,arguments);};'
    + '</script>';

  var headEnd = html.indexOf('</head>');
  if (headEnd > -1) html = html.slice(0, headEnd) + interceptor + html.slice(headEnd);

  return html;
}

async function convertToHtml(buildDir, options) {
  options = options || {};
  var channels = options.channels || ['appLovin', 'preview'];
  console.log('[converter] Building base HTML from: ' + buildDir);
  var baseHtml = await buildSingleHtml(buildDir);
  var results = {};
  for (var i = 0; i < channels.length; i++) {
    var ch = channels[i];
    var script = CHANNELS[ch];
    if (!script) { console.warn('[converter] Unknown channel: ' + ch); continue; }
    var bodyEnd = baseHtml.indexOf('</body>');
    results[ch] = bodyEnd > -1 ? baseHtml.slice(0, bodyEnd) + '<script>' + script + '</script>' + baseHtml.slice(bodyEnd) : baseHtml + '<script>' + script + '</script>';
  }
  return results;
}

async function convertAndSave(buildDir, outputDir, options) {
  options = options || {};
  var projectName = options.projectName || 'playable';
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  var results = await convertToHtml(buildDir, options);
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

if (require.main === module) {
  var buildDir = process.argv[2];
  if (!buildDir) { console.log('Usage: node worker-html-converter.js <build/web-mobile/>'); process.exit(1); }
  convertAndSave(buildDir, './output', { channels: (process.argv[3]||'appLovin,preview').split(',') });
}
