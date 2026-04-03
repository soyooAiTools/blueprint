/**
 * Stage: compile — Bridge.NET build with auto-fix loop
 *
 * Reads: ctx.csCode, ctx.extraFiles, ctx.blueprint, ctx.workDir
 * Writes: ctx.htmlOutput, ctx.buildTime
 */

var fs = require('fs');
var path = require('path');
var helpers = require('../helpers.cjs');
var cloneStage = require('./clone.cjs');

var MAX_BUILD_FIX_ATTEMPTS = 5;

module.exports = {
  name: 'compile',
  canRetry: false, // has its own internal fix loop
  execute: function(ctx) {
    ctx.addLog('compile', 'Starting Bridge.NET compilation...');
    var buildUrl = ctx.workerConfig.buildUrl;
    var lastCsCode = ctx.csCode;
    var lastExtraFiles = Object.assign({}, ctx.extraFiles);
    var attempt = 0;

    function tryBuild() {
      attempt++;
      var attemptLabel = attempt === 1 ? '' : ' (fix attempt ' + (attempt - 1) + '/' + MAX_BUILD_FIX_ATTEMPTS + ')';

      if (ctx.reportStatus) {
        ctx.reportStatus('building', { message: '[Linux] Bridge.NET compiling...' + attemptLabel });
      }

      return helpers.buildRequest(buildUrl, '/build', lastCsCode, lastExtraFiles)
        .catch(function(e) { return { ok: false, error: e.message }; })
        .then(function(buildResult) {
          if (buildResult.ok) {
            ctx.addLog('compile', 'Build OK in ' + buildResult.buildTime + 's' + attemptLabel);
            ctx.csCode = lastCsCode;
            ctx.extraFiles = lastExtraFiles;
            ctx.buildTime = buildResult.buildTime;

            // Download HTML
            return helpers.buildRequest(buildUrl, '/build-html', lastCsCode, lastExtraFiles)
              .then(function(htmlData) {
                ctx.htmlOutput = htmlData;
                ctx.addLog('compile', 'HTML: ' + (htmlData.length / 1048576).toFixed(1) + 'MB');
                return { ok: true, buildTime: buildResult.buildTime, htmlSize: htmlData.length };
              });
          }

          var buildError = buildResult.error || '';
          ctx.addLog('compile', 'Build failed' + attemptLabel + ': ' + buildError.slice(0, 300));

          if (attempt > MAX_BUILD_FIX_ATTEMPTS) {
            throw new Error('Build failed after ' + MAX_BUILD_FIX_ATTEMPTS + ' fix attempts: ' + buildError.slice(0, 200));
          }

          // Auto-fix: feed compile error to AI
          ctx.addLog('compile', 'AI fixing build error (attempt ' + attempt + '/' + MAX_BUILD_FIX_ATTEMPTS + ')...');
          if (ctx.reportStatus) {
            ctx.reportStatus('processing', { message: '[Linux] Build failed, AI fixing... (' + attempt + '/' + MAX_BUILD_FIX_ATTEMPTS + ')' });
          }

          if (!ctx.blueprint.feedbackHistory) ctx.blueprint.feedbackHistory = [];
          ctx.blueprint.feedbackHistory.push({
            data: { text: 'Build compilation failed:\n' + buildError.slice(0, 1500) + '\nPlease fix the C# compilation errors.' },
            source: 'build-fix-attempt-' + attempt,
            status: 'pending',
            timestamp: Date.now(),
          });

          // Clone fresh template for fix attempt
          var fixTempDir = path.join(require('os').tmpdir(), 'linux-buildfix-' + ctx.taskId + '-' + attempt);
          if (fs.existsSync(fixTempDir)) fs.rmSync(fixTempDir, { recursive: true, force: true });

          try {
            cloneStage.getBaseTemplate(fixTempDir, function(msg) { ctx.addLog('compile', msg); }, ctx.taskId);
          } catch(cloneErr) {
            ctx.addLog('compile', 'Build fix git clone failed: ' + cloneErr.message);
            return tryBuild(); // skip this fix attempt
          }

          var fixAssetsDir = path.join(fixTempDir, 'Assets', 'Program', 'Script', 'Manager');
          fs.mkdirSync(fixAssetsDir, { recursive: true });
          fs.writeFileSync(path.join(fixAssetsDir, 'GameFlowManagerMain.cs'), lastCsCode);

          var USE_CLAUDE_CODE = process.env.USE_CLAUDE_CODE !== 'false';
          var generator;
          try {
            if (USE_CLAUDE_CODE) {
              generator = require('../../worker/claude-code-coder.js').generateWithClaudeCode;
            } else {
              generator = require('../../worker/worker-coder.js').generateCodeV5;
            }
          } catch(e) {
            try { fs.rmSync(fixTempDir, { recursive: true, force: true }); } catch(e2) {}
            return tryBuild();
          }

          return generator(ctx.blueprint, fixTempDir, function(msg) { ctx.addLog('compile', msg); }, ctx.taskId, 'unity')
            .then(function(fixResult) {
              if (!fixResult.ok) {
                ctx.addLog('compile', 'Build fix re-code failed: ' + fixResult.error);
                try { fs.rmSync(fixTempDir, { recursive: true, force: true }); } catch(e) {}
                return tryBuild();
              }

              var fixCsFiles = helpers.findFiles(fixTempDir, '.cs');
              var fixMainCs = null;
              for (var i = 0; i < fixCsFiles.length; i++) {
                if (fixCsFiles[i].indexOf('GameFlowManagerMain.cs') !== -1) { fixMainCs = fixCsFiles[i]; break; }
              }
              if (!fixMainCs) {
                ctx.addLog('compile', 'Build fix: no GameFlowManagerMain.cs found');
                try { fs.rmSync(fixTempDir, { recursive: true, force: true }); } catch(e) {}
                return tryBuild();
              }

              lastCsCode = fs.readFileSync(fixMainCs, 'utf-8');
              try { fs.rmSync(fixTempDir, { recursive: true, force: true }); } catch(e) {}
              ctx.addLog('compile', 'Build fix ' + attempt + ': got fixed code (' + lastCsCode.length + ' chars), retrying...');

              return tryBuild();
            })
            .catch(function(err) {
              try { fs.rmSync(fixTempDir, { recursive: true, force: true }); } catch(e) {}
              return tryBuild();
            });
        });
    }

    return tryBuild();
  },
};
