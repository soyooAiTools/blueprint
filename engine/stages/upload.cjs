/**
 * Stage: upload — Save build artifacts to webgl dir
 *
 * Reads: ctx.htmlOutput, ctx.taskId, ctx.previewUrl
 * Writes: (saves files to disk)
 */

var fs = require('fs');
var path = require('path');

module.exports = {
  name: 'upload',
  canRetry: true,
  assertBefore: function(ctx) {
    if (!ctx.htmlOutput) throw new Error('No HTML output to upload');
  },
  maxRetries: 3,
  execute: function(ctx) {
    ctx.addLog('upload', 'Saving build artifacts...');

    if (!ctx.htmlOutput) {
      ctx.addLog('upload', 'No HTML output to save, skipping');
      return Promise.resolve({ uploaded: false, reason: 'no html' });
    }

    var previewDir = path.join(__dirname, '..', '..', 'server-data', 'webgl', ctx.taskId);
    fs.mkdirSync(previewDir, { recursive: true });

    // Version history: archive previous build before overwriting (keep last 3)
    var existingHtml = path.join(previewDir, 'index.html');
    if (fs.existsSync(existingHtml)) {
      var versionDir = path.join(previewDir, 'versions');
      fs.mkdirSync(versionDir, { recursive: true });
      var ts = new Date().toISOString().replace(/[:.]/g, '-');
      try {
        fs.renameSync(existingHtml, path.join(versionDir, 'index-' + ts + '.html'));
        var versions = fs.readdirSync(versionDir).sort().reverse();
        for (var vi = 3; vi < versions.length; vi++) {
          fs.unlinkSync(path.join(versionDir, versions[vi]));
        }
      } catch(e) { ctx.addLog('upload', 'Version archive skipped: ' + e.message); }
    }

    fs.writeFileSync(path.join(previewDir, 'index.html'), ctx.htmlOutput);

    // gzip for nginx gzip_static
    try {
      var zlib = require('zlib');
      var gzipped = zlib.gzipSync(ctx.htmlOutput, { level: 6 });
      fs.writeFileSync(path.join(previewDir, 'index.html.gz'), gzipped);
      ctx.addLog('upload', 'Compressed: ' + (ctx.htmlOutput.length / 1048576).toFixed(1) + 'MB → ' + (gzipped.length / 1048576).toFixed(1) + 'MB');
    } catch(e) { ctx.addLog('upload', 'gzip skipped: ' + e.message); }

    ctx.previewUrl = 'https://playcools.top/webgl/' + ctx.taskId + '/index.html';
    ctx.addLog('upload', 'Preview saved: ' + ctx.previewUrl);

    if (ctx.reportStatus) {
      ctx.reportStatus('done', {
        message: '[Linux] Build complete. Preview: ' + ctx.previewUrl,
        previewUrl: ctx.previewUrl,
      });
    }

    // Metrics are recorded at pipeline level (pipeline.cjs runNext), not here
    return Promise.resolve({ uploaded: true, previewUrl: ctx.previewUrl });
  },
};
