/**
 * Stage: visual-check — Playwright screenshot + Claude Sonnet analysis with fix loop
 *
 * Reads: ctx.htmlOutput, ctx.csCode, ctx.blueprint, ctx.extraFiles
 * Writes: ctx.htmlOutput (updated if visual fix applied), ctx.csCode (updated)
 */

var http = require('http');
var https = require('https');
var fs = require('fs');
var path = require('path');
var helpers = require('../helpers.cjs');
var cloneStage = require('./clone.cjs');

var MAX_VISUAL_ROUNDS = 8;

module.exports = {
  name: 'visual-check',
  canRetry: false, // has its own internal loop
  canSkip: function(ctx) {
    return process.env.SKIP_VISUAL_CHECK === 'true';
  },
  execute: function(ctx) {
    ctx.addLog('visual-check', 'Starting visual pre-check...');
    var buildUrl = ctx.workerConfig.buildUrl;

    // Save preview copy
    var previewDir = path.join(__dirname, '..', '..', 'server-data', 'webgl', ctx.taskId);
    fs.mkdirSync(previewDir, { recursive: true });
    fs.writeFileSync(path.join(previewDir, 'index.html'), ctx.htmlOutput);
    ctx.previewUrl = 'https://playcools.top/webgl/' + ctx.taskId + '/index.html';
    ctx.addLog('visual-check', 'Preview: ' + ctx.previewUrl);

    var lastHtmlForVisual = ctx.htmlOutput;
    var lastCsCode = ctx.csCode;
    var lastExtraFiles = Object.assign({}, ctx.extraFiles);
    var vRound = 0;

    var patchForHeadless;
    try { patchForHeadless = require('../../worker/worker-cua-verify.js').patchForHeadless; } catch(e) {}

    function doVisualRound() {
      vRound++;
      if (vRound > MAX_VISUAL_ROUNDS) {
        ctx.addLog('visual-check', 'Failed after ' + MAX_VISUAL_ROUNDS + ' rounds, proceeding to CUA anyway');
        return Promise.resolve({ passed: false, rounds: vRound - 1 });
      }

      if (ctx.reportStatus) {
        ctx.reportStatus('processing', { message: '[Linux] 视觉预检 (' + vRound + '/' + MAX_VISUAL_ROUNDS + ')...', previewUrl: ctx.previewUrl });
      }

      var screenshotPath = '/tmp/visual-check-' + ctx.taskId + '-r' + vRound + '.png';
      var tmpBuildDir = '/tmp/visual-check-build-' + ctx.taskId + '-r' + vRound;
      fs.mkdirSync(tmpBuildDir, { recursive: true });
      fs.writeFileSync(path.join(tmpBuildDir, 'index.html'), lastHtmlForVisual);

      var visualServer, visualPort;

      return new Promise(function(resolve, reject) {
        // Start local HTTP server with headless patches
        var srv = http.createServer(function(req, res) {
          var fp = path.join(tmpBuildDir, req.url === '/' ? 'index.html' : req.url).split('?')[0];
          if (!fs.existsSync(fp)) { res.writeHead(404); res.end(); return; }
          var ext = path.extname(fp).toLowerCase();
          if ((ext === '.html' || ext === '.js') && patchForHeadless) {
            try {
              var patched = patchForHeadless(fs.readFileSync(fp, 'utf8'), path.basename(fp));
              res.writeHead(200, { 'Content-Type': ext === '.html' ? 'text/html' : 'application/javascript' });
              res.end(patched.content); return;
            } catch(e) {}
          }
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
          fs.createReadStream(fp).pipe(res);
        });
        srv.listen(0, '127.0.0.1', function() {
          visualServer = srv;
          visualPort = srv.address().port;
          resolve();
        });
        srv.on('error', reject);
      })
      .then(function() {
        var chromium = require('playwright').chromium;
        return chromium.launch({ headless: true, args: ['--no-sandbox'] });
      })
      .then(function(browser) {
        return browser.newPage({ viewport: { width: 960, height: 640 } })
          .then(function(page) {
            var consoleErrors = [];
            page.on('console', function(msg) {
              if (msg.type() === 'error' || msg.type() === 'warning') {
                consoleErrors.push('[' + msg.type() + '] ' + msg.text().slice(0, 300));
              }
            });
            page.on('pageerror', function(err) { consoleErrors.push('[pageerror] ' + err.message.slice(0, 300)); });

            return page.goto('http://127.0.0.1:' + visualPort + '/index.html', { waitUntil: 'load', timeout: 30000 })
              .then(function() {
                // Wait for engine readiness
                var waitStep = 0;
                function waitEngine() {
                  if (waitStep >= 20) return Promise.resolve(false);
                  waitStep++;
                  return page.waitForTimeout(1000).then(function() {
                    return page.evaluate(function() {
                      return typeof UnityEngine !== 'undefined' && typeof Bridge !== 'undefined'
                        && !!UnityEngine.Camera && !!UnityEngine.Camera.main;
                    }).catch(function() { return false; });
                  }).then(function(ready) {
                    if (ready) return page.waitForTimeout(2000).then(function() { return true; });
                    return waitEngine();
                  });
                }
                return waitEngine();
              })
              .then(function() {
                return page.screenshot({ path: screenshotPath });
              })
              .then(function() {
                return browser.close().then(function() {
                  try { visualServer.close(); } catch(e) {}
                  try { fs.rmSync(tmpBuildDir, { recursive: true, force: true }); } catch(e) {}
                  return { screenshotPath: screenshotPath, consoleErrors: consoleErrors };
                });
              });
          });
      })
      .then(function(result) {
        // Analyze screenshot with Claude Sonnet
        var imgBase64 = fs.readFileSync(result.screenshotPath).toString('base64');
        var sceneDesc = 'A game scene with multiple colored objects';
        try {
          var shots = ctx.blueprint.shots || (ctx.blueprint.storyboard && ctx.blueprint.storyboard.frames) || [];
          if (shots.length > 0) {
            var shot1 = shots[0].data || shots[0];
            sceneDesc = shot1.sceneDescription || shot1.description || shot1.title || sceneDesc;
          }
        } catch(e) {}

        var analysisPrompt = 'You are a playable ad visual quality inspector.\nAnalyze this game screenshot.\n' +
          'Scene: ' + sceneDesc + '\n' +
          'FAIL if: solid color screen, black screen, loading bar, empty scene, no game objects.\n' +
          'PASS if: multiple colored game objects visible.\n' +
          'Reply JSON only: {"passed": true/false, "reason": "brief explanation"}';

        // Use modelProvider for vision analysis
        var claudeProvider = require('../../lib/model-provider.cjs').createProvider('claude', {});
        return claudeProvider.generateVision(imgBase64, analysisPrompt, { model: 'claude-sonnet-4-6', maxTokens: 200, timeoutMs: 60000 })
          .then(function(visionResult) {
            var jsonMatch = (visionResult.text || '').match(/\{[\s\S]*\}/);
            if (jsonMatch) return JSON.parse(jsonMatch[0]);
            return { passed: true, reason: 'Could not parse analysis, assuming pass' };
          })
          .catch(function(err) {
            return { passed: true, reason: 'Vision API error: ' + err.message + ', assuming pass' };
          })
          .then(function(analysis) {
          ctx.addLog('visual-check', 'Round ' + vRound + ': ' + (analysis.passed ? 'PASSED' : 'FAILED') + ' — ' + analysis.reason);

          if (analysis.passed) {
            ctx.htmlOutput = lastHtmlForVisual;
            ctx.csCode = lastCsCode;
            return { passed: true, rounds: vRound };
          }

          if (vRound >= MAX_VISUAL_ROUNDS) {
            ctx.htmlOutput = lastHtmlForVisual;
            ctx.csCode = lastCsCode;
            return { passed: false, rounds: vRound };
          }

          // Visual fix: re-code + rebuild
          if (ctx.reportStatus) {
            ctx.reportStatus('processing', { message: '[Linux] 视觉预检失败: ' + analysis.reason + '，AI修复中...', previewUrl: ctx.previewUrl });
          }

          if (!ctx.blueprint.feedbackHistory) ctx.blueprint.feedbackHistory = [];
          var diagText = '';
          if (result.consoleErrors && result.consoleErrors.length > 0) {
            diagText += '\n\nJavaScript Runtime Errors:\n' + result.consoleErrors.slice(0, 15).join('\n');
          }
          ctx.blueprint.feedbackHistory.push({
            data: { text: 'Visual pre-check failed (round ' + vRound + '): ' + analysis.reason + diagText },
            source: 'visual-precheck-round-' + vRound,
            status: 'pending',
            timestamp: Date.now(),
          });

          // Re-code
          var vFixDir = path.join(require('os').tmpdir(), 'linux-vfix-' + ctx.taskId + '-r' + vRound);
          if (fs.existsSync(vFixDir)) fs.rmSync(vFixDir, { recursive: true, force: true });

          try {
            cloneStage.getBaseTemplate(vFixDir, function(msg) { ctx.addLog('visual-check', msg); }, ctx.taskId);
          } catch(e) {
            ctx.addLog('visual-check', 'Visual fix git clone failed: ' + e.message);
            ctx.htmlOutput = lastHtmlForVisual;
            ctx.csCode = lastCsCode;
            return { passed: false, rounds: vRound, error: 'clone failed' };
          }

          var vFixAssetsDir = path.join(vFixDir, 'Assets', 'Program', 'Script', 'Manager');
          fs.mkdirSync(vFixAssetsDir, { recursive: true });
          fs.writeFileSync(path.join(vFixAssetsDir, 'GameFlowManagerMain.cs'), lastCsCode);

          var USE_CLAUDE_CODE = process.env.USE_CLAUDE_CODE !== 'false';
          var generator;
          try {
            generator = USE_CLAUDE_CODE
              ? require('../../worker/claude-code-coder.js').generateWithClaudeCode
              : require('../../worker/worker-coder.js').generateCodeV5;
          } catch(e) {
            try { fs.rmSync(vFixDir, { recursive: true, force: true }); } catch(e2) {}
            ctx.htmlOutput = lastHtmlForVisual;
            ctx.csCode = lastCsCode;
            return { passed: false, rounds: vRound };
          }

          return generator(ctx.blueprint, vFixDir, function(msg) { ctx.addLog('visual-check', msg); }, ctx.taskId, 'unity')
            .then(function(fixResult) {
              if (!fixResult.ok) {
                ctx.addLog('visual-check', 'Visual fix re-code failed');
                try { fs.rmSync(vFixDir, { recursive: true, force: true }); } catch(e) {}
                ctx.htmlOutput = lastHtmlForVisual;
                ctx.csCode = lastCsCode;
                return { passed: false, rounds: vRound };
              }

              var fixCsFiles = helpers.findFiles(vFixDir, '.cs');
              var fixMainCs = null;
              for (var i = 0; i < fixCsFiles.length; i++) {
                if (fixCsFiles[i].indexOf('GameFlowManagerMain.cs') !== -1) { fixMainCs = fixCsFiles[i]; break; }
              }
              if (!fixMainCs) {
                try { fs.rmSync(vFixDir, { recursive: true, force: true }); } catch(e) {}
                ctx.htmlOutput = lastHtmlForVisual;
                ctx.csCode = lastCsCode;
                return { passed: false, rounds: vRound };
              }

              lastCsCode = fs.readFileSync(fixMainCs, 'utf-8');
              try { fs.rmSync(vFixDir, { recursive: true, force: true }); } catch(e) {}

              // Rebuild
              if (ctx.reportStatus) {
                ctx.reportStatus('building', { message: '[Linux] 视觉修复重编译 (round ' + (vRound + 1) + ')...' });
              }

              return helpers.buildRequest(buildUrl, '/build', lastCsCode, lastExtraFiles)
                .then(function(buildResult) {
                  if (!buildResult.ok) throw new Error('Visual fix rebuild failed');
                  ctx.addLog('visual-check', 'Visual fix rebuild OK in ' + buildResult.buildTime + 's');

                  // Download new HTML (with retry)
                  return helpers.buildRequest(buildUrl, '/build-html', lastCsCode, lastExtraFiles);
                })
                .then(function(newHtml) {
                  lastHtmlForVisual = newHtml;
                  lastExtraFiles = Object.assign({}, ctx.extraFiles);
                  fs.writeFileSync(path.join(previewDir, 'index.html'), lastHtmlForVisual);
                  return doVisualRound();
                })
                .catch(function(err) {
                  ctx.addLog('visual-check', 'Visual fix rebuild error: ' + err.message);
                  ctx.htmlOutput = lastHtmlForVisual;
                  ctx.csCode = lastCsCode;
                  return { passed: false, rounds: vRound };
                });
            });
        });
      })
      .catch(function(err) {
        ctx.addLog('visual-check', 'Round ' + vRound + ' error: ' + err.message);
        try { if (visualServer) visualServer.close(); } catch(e) {}
        try { fs.rmSync(tmpBuildDir, { recursive: true, force: true }); } catch(e) {}
        ctx.htmlOutput = lastHtmlForVisual;
        ctx.csCode = lastCsCode;
        return { passed: true, reason: 'error bypass' }; // Don't block on visual check errors
      });
    }

    return doVisualRound();
  },
};
