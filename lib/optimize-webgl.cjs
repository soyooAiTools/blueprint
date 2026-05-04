/**
 * Post-process Luna WebGL HTML builds to reduce file size.
 *
 * 1. Extract inline WASM data URIs → external .wasm files
 * 2. Disable DEVELOP/DEBUG/TRACE flags
 * 3. Strip MODULE_reflection metadata block (rarely used at runtime)
 * 4. Re-generate .gz for nginx gzip_static
 */
var fs = require('fs');
var path = require('path');
var zlib = require('zlib');

function optimize(htmlPath) {
  if (!fs.existsSync(htmlPath)) return { changed: false };

  var dir = path.dirname(htmlPath);
  var html = fs.readFileSync(htmlPath, 'utf-8');
  var originalSize = html.length;

  // 1. Disable debug flags
  html = html.replace(/window\.DEVELOP\s*=\s*true/g, 'window.DEVELOP=false');
  html = html.replace(/window\.DEBUG\s*=\s*true/g, 'window.DEBUG=false');
  html = html.replace(/window\.TRACE\s*=\s*true/g, 'window.TRACE=false');

  // 2. Extract WASM data URIs into external files
  var wasmIdx = 0;
  html = html.replace(/"data:application\/octet-stream;base64,(AGFzbQ[A-Za-z0-9+/=]+)"/g, function(match, b64) {
    try {
      var buf = Buffer.from(b64, 'base64');
      var fname = 'physics_' + wasmIdx + '.wasm';
      fs.writeFileSync(path.join(dir, fname), buf, { mode: 0o644 });
      wasmIdx++;
      return '"' + fname + '"';
    } catch (e) {
      return match; // keep original on error
    }
  });

  // 3. Strip MODULE_reflection guarded block
  var reflMatch = html.match(/if\s*\(\s*MODULE_reflection\s*\)\s*\{/);
  if (reflMatch) {
    var start = html.indexOf(reflMatch[0]);
    var depth = 0;
    var end = start;
    for (var i = start + reflMatch[0].length - 1; i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}') depth--;
      if (depth === 0) { end = i + 1; break; }
    }
    if (end > start) {
      html = html.substring(0, start) + '/* reflection stripped */' + html.substring(end);
    }
  }

  var newSize = html.length;
  var saved = originalSize - newSize;

  if (saved > 0) {
    fs.writeFileSync(htmlPath, html, { encoding: 'utf-8', mode: 0o644 });
  }
  // Always regenerate .gz — nginx gzip_static serves it to every gzip-aware
  // client. If the .gz drifts from .html (because the optimize step found
  // nothing further to strip on this run), browsers execute stale code.
  var gz = zlib.gzipSync(Buffer.from(html, 'utf-8'), { level: 9 });
  fs.writeFileSync(htmlPath + '.gz', gz, { mode: 0o644 });
  console.log('[optimize-webgl] ' + path.basename(htmlPath) + ': ' +
    (originalSize / 1024).toFixed(0) + 'KB → ' + (newSize / 1024).toFixed(0) + 'KB ' +
    '(saved ' + (saved / 1024).toFixed(0) + 'KB, gz=' + (gz.length / 1024).toFixed(0) + 'KB)');
  return { changed: saved > 0, originalSize: originalSize, newSize: newSize, saved: saved, gzSize: gz.length };
}

module.exports = { optimize: optimize };
