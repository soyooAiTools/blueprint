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
  maxRetries: 3,
  execute: function(ctx) {
    ctx.addLog('upload', 'Saving build artifacts...');

    if (!ctx.htmlOutput) {
      ctx.addLog('upload', 'No HTML output to save, skipping');
      return Promise.resolve({ uploaded: false, reason: 'no html' });
    }

    var previewDir = path.join(__dirname, '..', '..', 'server-data', 'webgl', ctx.taskId);
    fs.mkdirSync(previewDir, { recursive: true });
    fs.writeFileSync(path.join(previewDir, 'index.html'), ctx.htmlOutput);

    ctx.previewUrl = 'https://playcools.top/webgl/' + ctx.taskId + '/index.html';
    ctx.addLog('upload', 'Preview saved: ' + ctx.previewUrl);

    if (ctx.reportStatus) {
      ctx.reportStatus('done', {
        message: '[Linux] Build complete. Preview: ' + ctx.previewUrl,
        previewUrl: ctx.previewUrl,
      });
    }

    return Promise.resolve({ uploaded: true, previewUrl: ctx.previewUrl });
  },
};
