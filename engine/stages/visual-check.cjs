/**
 * Stage: visual-check — Playwright screenshot + Claude Sonnet analysis with fix loop
 *
 * Reads: ctx.htmlOutput, ctx.csCode, ctx.blueprint, ctx.extraFiles
 * Writes: ctx.htmlOutput (updated if visual fix applied), ctx.csCode (updated)
 */

var http = require('http');
var fs = require('fs');
var path = require('path');
var helpers = require('../helpers.cjs');
var { recode } = require('../recode.cjs');
var { createFixLoop } = require('../fix-loop.cjs');

var MAX_VISUAL_ROUNDS = 8;

module.exports = {
  name: 'visual-check',
  canRetry: false,
  assertBefore: function(ctx) {
    if (!ctx.htmlOutput) throw new Error('No HTML output from compile stage');
    if (ctx.htmlOutput.length < 10240) throw new Error('HTML output too small (' + ctx.htmlOutput.length + ' bytes) — likely empty build');
  },
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

    var patchForHeadless;
    try { patchForHeadless = require('../../worker/worker-cua-verify.js').patchForHeadless; } catch(e) {}

    var loop = createFixLoop({
      name: 'visual-check',
      maxRounds: MAX_VISUAL_ROUNDS,
      onExhausted: 'throw',
      beforeRound: function(ctx, round, maxRounds) {
        ctx.reportStatus('processing', { message: '[Linux] 视觉预检 (' + round + '/' + maxRounds + ')...', previewUrl: ctx.previewUrl });
      },
      attempt: function(ctx, round, maxRounds) {
        var screenshotPath = '/tmp/visual-check-' + ctx.taskId + '-r' + round + '.png';
        var tmpBuildDir = '/tmp/visual-check-build-' + ctx.taskId + '-r' + round;
        fs.mkdirSync(tmpBuildDir, { recursive: true });
        fs.writeFileSync(path.join(tmpBuildDir, 'index.html'), lastHtmlForVisual);

        var visualServer;

        return new Promise(function(resolve, reject) {
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
            resolve(srv.address().port);
          });
          srv.on('error', reject);
        })
        .then(function(visualPort) {
          var chromium = require('playwright').chromium;
          return chromium.launch({ headless: true, args: ['--no-sandbox'] })
            .then(function(browser) {
              return browser.newPage({ viewport: { width: 960, height: 640 } })
                .then(function(page) {
                  var consoleErrors = [];
                  var phaseLog = [];
                  page.on('console', function(msg) {
                    var text = msg.text();
                    if (text.indexOf('__PHASE__:') === 0) {
                        phaseLog.push({ phase: text.substring(10), time: Date.now() });
                    }
                    if (msg.type() === 'error' || msg.type() === 'warning') {
                      consoleErrors.push('[' + msg.type() + '] ' + text.slice(0, 300));
                    }
                  });
                  page.on('pageerror', function(err) { consoleErrors.push('[pageerror] ' + err.message.slice(0, 300)); });

                  return page.goto('http://127.0.0.1:' + visualPort + '/index.html', { waitUntil: 'load', timeout: 30000 })
                    .then(function() {
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
                      // Multi-frame capture: t=0s, t=3s, t=8s
                      var frames = [];
                      var frameDelays = [0, 3000, 5000]; // cumulative: 0, 3s, 8s
                      var frameIdx = 0;
                      function captureNextFrame() {
                        if (frameIdx >= frameDelays.length) return Promise.resolve();
                        var delay = frameDelays[frameIdx];
                        var framePath = screenshotPath.replace('.png', '-f' + frameIdx + '.png');
                        return page.waitForTimeout(delay)
                          .then(function() { return page.screenshot({ path: framePath }); })
                          .then(function() {
                            frames.push({ path: framePath, timeMs: (frameIdx === 0 ? 0 : frameIdx === 1 ? 3000 : 8000) });
                            frameIdx++;
                            return captureNextFrame();
                          });
                      }
                      return captureNextFrame().then(function() {
                        // Adaptive capture: extend if no phase activity detected
                        if (phaseLog.length === 0 && consoleErrors.length === 0) {
                          ctx.addLog('visual-check', 'No phase activity after base capture, extending to 15s');
                          // Capture 2 more frames at +3s and +4s
                          return page.waitForTimeout(3000)
                            .then(function() {
                              var extraPath1 = screenshotPath.replace('.png', '-f3.png');
                              return page.screenshot({ path: extraPath1 }).then(function() {
                                frames.push({ path: extraPath1, timeMs: 11000 });
                                return page.waitForTimeout(4000);
                              });
                            })
                            .then(function() {
                              var extraPath2 = screenshotPath.replace('.png', '-f4.png');
                              return page.screenshot({ path: extraPath2 }).then(function() {
                                frames.push({ path: extraPath2, timeMs: 15000 });
                              });
                            })
                            .then(function() {
                              return page.context().close().catch(function() {}).then(function() {
                                return browser.close();
                              }).then(function() {
                                try { visualServer.close(); } catch(e) {}
                                try { fs.rmSync(tmpBuildDir, { recursive: true, force: true }); } catch(e) {}
                                return { frames: frames, consoleErrors: consoleErrors, phaseLog: phaseLog };
                              });
                            });
                        }
                        return page.context().close().catch(function() {}).then(function() {
                          return browser.close();
                        }).then(function() {
                          try { visualServer.close(); } catch(e) {}
                          try { fs.rmSync(tmpBuildDir, { recursive: true, force: true }); } catch(e) {}
                          return { frames: frames, consoleErrors: consoleErrors, phaseLog: phaseLog };
                        });
                      });
                    });
                });
            });
        })
        .then(function(result) {
          // Build multi-frame analysis
          var frameImages = [];
          if (result.frames && result.frames.length > 0) {
            for (var fi = 0; fi < result.frames.length; fi++) {
              try { frameImages.push({ base64: fs.readFileSync(result.frames[fi].path).toString('base64'), timeMs: result.frames[fi].timeMs }); } catch(e) {}
            }
          }
          var imgBase64 = frameImages.length > 0 ? frameImages[0].base64 : '';
          var sceneDesc = 'A game scene with multiple colored objects';
          var expectedEntities = '';
          var cameraInfo = '';
          try {
            var shots = ctx.blueprint.shots || (ctx.blueprint.storyboard && ctx.blueprint.storyboard.frames) || [];
            if (shots.length > 0) {
              var shot1 = shots[0].data || shots[0];
              sceneDesc = shot1.sceneDescription || shot1.description || shot1.title || sceneDesc;
            }
            // Inject expected entities from blueprint
            if (ctx.blueprint.entities && ctx.blueprint.entities.length > 0) {
              expectedEntities = ctx.blueprint.entities.slice(0, 8).map(function(e) { return e.name + (e.poolName ? ' (' + e.poolName + ')' : ''); }).join(', ');
            } else if (ctx.blueprint.entityPoolMap) {
              var epKeys = Object.keys(ctx.blueprint.entityPoolMap).slice(0, 8);
              expectedEntities = epKeys.map(function(k) { return k + ' (' + ctx.blueprint.entityPoolMap[k] + ')'; }).join(', ');
            }
            // Camera info from blueprint settings
            var gs = ctx.blueprint.globalSettings || {};
            if (gs.cameraType) cameraInfo = 'Camera: ' + gs.cameraType + (gs.cameraDistance ? ' distance=' + gs.cameraDistance : '');
          } catch(e) {}

          var frameCount = frameImages.length;
          var analysisPrompt = 'You are a playable ad visual quality inspector.\n';
          if (expectedEntities) {
            analysisPrompt += 'Expected visible entities: ' + expectedEntities + '\n';
          }
          if (cameraInfo) {
            analysisPrompt += cameraInfo + '\n';
          }
          if (frameCount > 1) {
            analysisPrompt += 'You are given ' + frameCount + ' frames captured at different times (t=0s, t=3s, t=8s).\n';
            analysisPrompt += 'Check for PROGRESSION: objects should move/change between frames. If all frames are identical, the game may be stuck.\n';
          }
          if (phaseLog.length > 0) {
            analysisPrompt += 'Phase progression detected from game instrumentation: ' +
                phaseLog.map(function(p) { return p.phase; }).join(' \u2192 ') + '\n';
            analysisPrompt += 'Phase activity detected via console instrumentation: [' +
                phaseLog.map(function(p) { return p.phase; }).join(', ') +
                ']. The game IS running. Focus on visual correctness, not whether it started.\n';
          } else {
            analysisPrompt += 'No phase activity detected in console after capture period. The game may be stuck, crashed, or never initialized. Be strict.\n';
          }
          analysisPrompt += 'Scene: ' + sceneDesc + '\n' +
            'FAIL if: solid color screen, black screen, loading bar, empty scene, no game objects, all frames identical (no progression).\n' +
            'PASS if: multiple colored game objects visible AND (if multi-frame) some visual change between frames.\n' +
            'Reply JSON only: {"passed": true/false, "reason": "brief explanation"}';

          var claudeProvider = require('../../lib/model-provider.cjs').createProvider('claude', {});
          // Send all frames if multiple available
          var visionImages = frameCount > 1 ? frameImages.map(function(f) { return f.base64; }) : imgBase64;
          return claudeProvider.generateVision(visionImages, analysisPrompt, { model: 'claude-sonnet-4-6', maxTokens: 300, timeoutMs: 60000 })
            .then(function(visionResult) {
              var jsonMatch = (visionResult.text || '').match(/\{[\s\S]*\}/);
              if (jsonMatch) return JSON.parse(jsonMatch[0]);
              return { passed: false, reason: 'Could not parse analysis response' };
            })
            .catch(function(err) {
              ctx.addLog('visual-check', 'Vision API error: ' + err.message);
              return { passed: false, reason: 'Vision API unavailable: ' + err.message };
            })
            .then(function(analysis) {
              ctx.addLog('visual-check', (analysis.passed ? 'PASSED' : 'FAILED') + ' — ' + analysis.reason);

              if (analysis.passed) {
                ctx.htmlOutput = lastHtmlForVisual;
                ctx.csCode = lastCsCode;
                return { done: true, result: { passed: true, rounds: round } };
              }

              if (round >= maxRounds) {
                ctx.htmlOutput = lastHtmlForVisual;
                ctx.csCode = lastCsCode;
                return { done: true, result: { passed: false, rounds: round } };
              }

              // Visual fix
              ctx.reportStatus('processing', { message: '[Linux] 视觉预检失败: ' + analysis.reason + '，AI修复中...', previewUrl: ctx.previewUrl });

              if (!ctx.blueprint.feedbackHistory) ctx.blueprint.feedbackHistory = [];
              var diagText = '';
              if (result.consoleErrors && result.consoleErrors.length > 0) {
                diagText += '\n\nJavaScript Runtime Errors:\n' + result.consoleErrors.slice(0, 15).join('\n');
              }
              ctx.blueprint.feedbackHistory.push({
                data: { text: 'Visual pre-check failed (round ' + round + '): ' + analysis.reason + diagText },
                source: 'visual-precheck-round-' + round,
                status: 'pending',
                timestamp: Date.now(),
              });

              // Record visual failures to pending-rules for knowledge retention
              try {
                var codeReviewer = require('../../worker/code-reviewer.js');
                codeReviewer.recordNewIssues([{
                  severity: 'critical',
                  description: '[Visual] ' + analysis.reason.slice(0, 200),
                  rule: 'Visual Check',
                  fix: 'Fix visual layout/rendering issue',
                  line: '',
                }], ctx.taskId).catch(function() {});
              } catch(e) {}

              return recode({
                taskId: ctx.taskId,
                currentCode: lastCsCode,
                blueprint: ctx.blueprint,
                label: 'vfix',
                round: round,
                log: function(msg) { ctx.addLog('visual-check', msg); },
              }).then(function(recodeResult) {
                if (!recodeResult.ok) {
                  ctx.addLog('visual-check', 'Visual fix re-code failed: ' + recodeResult.error);
                  ctx.htmlOutput = lastHtmlForVisual;
                  ctx.csCode = lastCsCode;
                  return { done: true, result: { passed: false, rounds: round } };
                }

                lastCsCode = recodeResult.code;
                ctx.reportStatus('building', { message: '[Linux] 视觉修复重编译 (round ' + (round + 1) + ')...' });

                return helpers.buildRequest(buildUrl, '/build', lastCsCode, lastExtraFiles)
                  .then(function(buildResult) {
                    if (!buildResult.ok) throw new Error('Visual fix rebuild failed');
                    ctx.addLog('visual-check', 'Visual fix rebuild OK in ' + buildResult.buildTime + 's');
                    return helpers.buildRequest(buildUrl, '/build-html', lastCsCode, lastExtraFiles);
                  })
                  .then(function(newHtml) {
                    lastHtmlForVisual = newHtml;
                    lastExtraFiles = Object.assign({}, ctx.extraFiles);
                    fs.writeFileSync(path.join(previewDir, 'index.html'), lastHtmlForVisual);
                    return { done: false };
                  })
                  .catch(function(err) {
                    ctx.addLog('visual-check', 'Visual fix rebuild error: ' + err.message);
                    ctx.htmlOutput = lastHtmlForVisual;
                    ctx.csCode = lastCsCode;
                    return { done: true, result: { passed: false, rounds: round } };
                  });
              });
            });
        })
        .catch(function(err) {
          ctx.addLog('visual-check', 'Error: ' + err.message);
          try { if (visualServer) visualServer.close(); } catch(e) {}
          try { fs.rmSync(tmpBuildDir, { recursive: true, force: true }); } catch(e) {}
          ctx.htmlOutput = lastHtmlForVisual;
          ctx.csCode = lastCsCode;
          // Re-throw so fix-loop can classify and retry or abort
          throw err;
        });
      },
    });

    return loop.run(ctx);
  },
};
