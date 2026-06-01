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

var MAX_VISUAL_ROUNDS = 5;
// Early exit if VLM returns the same failure reason 3 rounds in a row — root cause
// is misdiagnosed and additional fix attempts only burn tokens.
var SAME_REASON_EXIT = 3;

function isVisualInfraFailureReason(reason) {
  var text = String(reason || '').toLowerCase();
  return /vision cli unavailable|vision api unavailable|vision cli returned empty response|could not parse analysis response|vision backend not producing valid analysis|exit code 143/.test(text);
}

/**
 * 2026-05-12 P2: phaseLog 短路条件判定。
 * engine 必须被证明在跑(足量 __PHASE__: 信号 + 多个不同 phase + 零关键 console error)。
 * 命中后可跳过 VLM 视觉检查,把它留作"engine 没在跑/卡死"的 hard gate。
 *
 * @param {Array<{phase:string}>} phaseLog
 * @param {Array<string>} consoleErrors
 * @param {number} frameCount
 * @param {Object} [env]
 * @returns {{canSkip:boolean, distinctPhaseCount:number, criticalErrors:number, reason:string}}
 */
function evaluateVisualCheckShortCircuit(phaseLog, consoleErrors, frameCount, env) {
  env = env || process.env;
  var enabled = /^(1|true|on|yes)$/i.test(String(env.BLUEPRINT_VISUAL_CHECK_SKIP_VLM || ''));
  var distinctSet = Object.create(null);
  (phaseLog || []).forEach(function(p) {
    if (p && p.phase) distinctSet[p.phase] = true;
  });
  var distinct = Object.keys(distinctSet).length;
  var critical = (consoleErrors || []).filter(function(e) {
    return /\[pageerror\]|TypeError|ReferenceError/.test(String(e || ''));
  }).length;
  var phaseLogLen = (phaseLog || []).length;
  var fc = Number(frameCount) || 0;

  var ok = enabled && phaseLogLen >= 3 && distinct >= 2 && critical === 0 && fc >= 2;
  var reason;
  if (!enabled) reason = 'short-circuit disabled (set BLUEPRINT_VISUAL_CHECK_SKIP_VLM=on to opt in)';
  else if (phaseLogLen < 3) reason = 'phaseLog too short (' + phaseLogLen + ' < 3)';
  else if (distinct < 2) reason = 'too few distinct phases (' + distinct + ' < 2) — engine may be stuck';
  else if (critical > 0) reason = critical + ' critical console error(s)';
  else if (fc < 2) reason = 'insufficient frame samples (' + fc + ' < 2)';
  else reason = 'short-circuit: ' + distinct + ' distinct phases, no critical errors';
  return { canSkip: ok, distinctPhaseCount: distinct, criticalErrors: critical, reason: reason };
}

module.exports = {
  name: 'visual-check',
  _isVisualInfraFailureReason: isVisualInfraFailureReason,
  _evaluateVisualCheckShortCircuit: evaluateVisualCheckShortCircuit,
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
    ctx.reportStatus('preview_ready', {
      message: '[Linux] 预览已生成，正在进行深度验证...',
      previewUrl: ctx.previewUrl,
    });

    var lastHtmlForVisual = ctx.htmlOutput;
    var lastCsCode = ctx.csCode;
    var lastExtraFiles = Object.assign({}, ctx.extraFiles);
    var lastVisualReasonKey = '';
    var sameReasonCount = 0;

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
                      // Multi-frame capture: 2 base frames at t=0s and t=6s.
                      // Was 3 frames (0/3/8s) — reduced to save VLM token cost. Two frames
                      // are sufficient to detect "no progression" (frame[0] vs frame[1]),
                      // and phaseLog already proves the engine is running.
                      // JPEG quality 80 is ~70% smaller than PNG for screenshots with no
                      // perceptible quality loss for "is there a solid color / are there objects" checks.
                      var frames = [];
                      var frameSchedule = [
                        { delay: 0, timeMs: 0 },
                        { delay: 6000, timeMs: 6000 },
                      ];
                      var frameIdx = 0;
                      function captureNextFrame() {
                        if (frameIdx >= frameSchedule.length) return Promise.resolve();
                        var slot = frameSchedule[frameIdx];
                        var framePath = screenshotPath.replace('.png', '-f' + frameIdx + '.jpg');
                        return page.waitForTimeout(slot.delay)
                          .then(function() { return page.screenshot({ path: framePath, type: 'jpeg', quality: 80 }); })
                          .then(function() {
                            frames.push({ path: framePath, timeMs: slot.timeMs });
                            frameIdx++;
                            return captureNextFrame();
                          });
                      }
                      return captureNextFrame().then(function() {
                        // Adaptive capture: if no phase activity AND no errors, extend
                        // by ONE extra frame at t=14s to give a slow-loading game more time.
                        // Was 2 extra frames (11s + 15s) — reduced to 1 to save tokens.
                        if (phaseLog.length === 0 && consoleErrors.length === 0) {
                          ctx.addLog('visual-check', 'No phase activity after base capture, extending to 14s');
                          return page.waitForTimeout(8000)
                            .then(function() {
                              var extraPath = screenshotPath.replace('.png', '-f2.jpg');
                              return page.screenshot({ path: extraPath, type: 'jpeg', quality: 80 }).then(function() {
                                frames.push({ path: extraPath, timeMs: 14000 });
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
            // Build actual timestamp list from the captured frames so the prompt
            // matches reality even when adaptive extension fires.
            var tsList = result.frames.map(function(f) {
              return 't=' + (f.timeMs / 1000).toFixed(0) + 's';
            }).join(', ');
            analysisPrompt += 'You are given ' + frameCount + ' frames captured at different times (' + tsList + ').\n';
            analysisPrompt += 'Check for PROGRESSION: objects should move/change between frames. If all frames are identical, the game may be stuck.\n';
          }
          var phaseLog = result.phaseLog || [];
          if (phaseLog.length > 0) {
            analysisPrompt += 'Phase progression detected from game instrumentation: ' +
                phaseLog.map(function(p) { return p.phase; }).join(' \u2192 ') + '\n';
            analysisPrompt += 'Phase activity detected via console instrumentation: [' +
                phaseLog.map(function(p) { return p.phase; }).join(', ') +
                ']. The game IS running. Focus on visual correctness, not whether it started.\n';
          } else {
            analysisPrompt += 'No phase activity detected in console after capture period. The game may be stuck, crashed, or never initialized. Be strict.\n';
          }
          // Inject console error context — critical runtime errors should cause stricter judgment
          if (result.consoleErrors && result.consoleErrors.length > 0) {
            var criticalErrors = result.consoleErrors.filter(function(e) {
              return e.indexOf('[pageerror]') >= 0 || e.indexOf('TypeError') >= 0 ||
                     e.indexOf('ReferenceError') >= 0 || e.indexOf('null') >= 0;
            });
            if (criticalErrors.length > 0) {
              analysisPrompt += '\nCRITICAL: ' + criticalErrors.length + ' runtime errors detected:\n' +
                criticalErrors.slice(0, 5).join('\n') + '\n' +
                'Runtime errors usually mean broken gameplay. Be very strict.\n';
            }
          }

          analysisPrompt += 'Scene: ' + sceneDesc + '\n' +
            'FAIL if: solid color screen, black screen, loading bar, empty scene, no game objects, all frames identical (no progression), ' +
            'critical runtime errors in console (TypeError/ReferenceError/null), no interactive elements visible.\n' +
            'PASS if: multiple colored game objects visible AND some visual change between frames AND no critical runtime errors.\n' +
            'Reply JSON only: {"passed": true/false, "reason": "brief explanation", "hasInteractiveElements": true/false}';

          // 2026-04-16: switched from direct Claude API (ClaudeProvider.generateVision HTTP POST)
          // to spawn the CLI multimodal path via runCodexText.
          // Model stays Sonnet 4.6 — we only change transport so all Claude calls share
          // the CC CLI relay's failure modes / MODEL_FATAL / billing.
          // Mechanism: write JPEG frames into tempDir as ./frame1.jpg, ./frame2.jpg, ... and
          // instruct the model to Read them. CC Read tool natively supports images and
          // passes them to Sonnet as multimodal content (same pipeline as direct vision API).
          var codexCoder = require('../../worker/codex-coder.js');
          var imagesBase64 = frameCount > 1 ? frameImages.map(function(f) { return f.base64; }) : [imgBase64];
          var _visionAdditionalFiles = {};
          var _visionFrameNames = [];
          for (var _fi = 0; _fi < imagesBase64.length; _fi++) {
            var _fname = 'frame' + (_fi + 1) + '.jpg';
            _visionAdditionalFiles[_fname] = Buffer.from(imagesBase64[_fi] || '', 'base64');
            _visionFrameNames.push(_fname);
          }

          var visionSystemPrompt =
            'You are a visual QA analyst for Luna playable ads. ' +
            'You will analyze JPEG screenshot frames. ' +
            'Reply with ONLY a single JSON object of the exact shape requested — no explanation, no markdown fences.';

          var visionUserPrompt =
            'Use the Read tool to load the following frame image(s) in order:\n' +
            _visionFrameNames.map(function(f) { return '- ./' + f; }).join('\n') + '\n\n' +
            'Then analyze them and return the JSON as specified below.\n\n' +
            analysisPrompt;

          // === [vision-cost] pre-call instrumentation (CLI mode) ===
          // Base64 bytes reflect what CC will read off disk. Token usage is not available
          // in CLI --print mode, so post-call we only log respTextLen + elapsedMs.
          var _visionImageBytes = 0;
          for (var _vbi = 0; _vbi < imagesBase64.length; _vbi++) _visionImageBytes += (imagesBase64[_vbi] || '').length;
          var _visionFrameCount = imagesBase64.length;
          var _visionStartedAt = Date.now();

          // 2026-05-12 P2: phaseLog 短路 VLM。
          // 见 evaluateVisualCheckShortCircuit (本文件顶部) — 全部条件命中才短路:
          // phaseLog>=3 / 不同 phase>=2 / 无 critical error / frame>=2。
          // 安全默认:不再默认跳过 VLM。只有显式设置
          // BLUEPRINT_VISUAL_CHECK_SKIP_VLM=on 时才允许短路,避免"流程在跑"
          // 被误读成"视觉复刻正确"。
          var _shortCircuit = evaluateVisualCheckShortCircuit(phaseLog, result.consoleErrors, frameCount);

          var _visionPromise;
          if (_shortCircuit.canSkip) {
            ctx.addLog('visual-check', '[short-circuit] skip VLM round=' + round +
              ' phaseLog=' + phaseLog.length +
              ' distinctPhases=' + _shortCircuit.distinctPhaseCount +
              ' criticalErrors=0' +
              ' frames=' + frameCount +
              ' — ' + _shortCircuit.reason);
            _visionPromise = Promise.resolve({
              passed: true,
              reason: _shortCircuit.reason,
              hasInteractiveElements: true,
              _shortCircuit: true,
            });
          } else {
            ctx.addLog('visual-check', '[vision-cost] pre round=' + round +
              ' frames=' + _visionFrameCount +
              ' base64Bytes=' + _visionImageBytes +
              ' promptChars=' + visionUserPrompt.length +
              ' mode=cc-cli');
            _visionPromise = codexCoder.runCodexText({
              systemPrompt: visionSystemPrompt,
              userPrompt: visionUserPrompt,
              additionalFiles: _visionAdditionalFiles,
              model: 'claude-sonnet-4-6',
              backend: process.env.BLUEPRINT_VISUAL_CHECK_TEXT_RUNNER || undefined,
              effort: process.env.CODEX_REASONING_EFFORT || 'high',
              timeoutMs: 120000, // CC cold start + Read images + inference + margin
              minOutputLen: 10,  // JSON of {passed, reason, ...} is at least a dozen chars
              taskId: (ctx.taskId || 'visual') + '-r' + round,
              log: function(msg) { ctx.addLog('visual-check', msg); },
            })
              .then(function(result) {
                // [vision-cost] post-call (CLI mode — no usage field available)
                ctx.addLog('visual-check', '[vision-cost] post round=' + round +
                  ' mode=' + (result.backend || 'cc-cli') + ' ok=' + result.ok +
                  ' respTextLen=' + ((result && result.text) || '').length +
                  ' elapsedMs=' + (Date.now() - _visionStartedAt));
                if (!result.ok) {
                  throw new Error('Vision CLI error: ' + (result.error || 'unknown'));
                }
                var rawText = (result.text || '').trim();
                var jsonMatch = rawText.match(/\{[\s\S]*\}/);
                if (jsonMatch) return JSON.parse(jsonMatch[0]);
                // Empty/unparseable response — bqh33t post-mortem 2026-04-15: dead backend
                // was returning text="" and pipeline advanced to CUA with a black screen.
                // Classify as MODEL_FATAL so fix-loop aborts instead of burning recode rounds.
                if (!rawText) {
                  throw new Error('MODEL_FATAL: Vision CLI returned empty response (likely auth/quota failure)');
                }
                return { passed: false, reason: 'Could not parse analysis response: ' + rawText.slice(0, 120) };
              })
              .catch(function(err) {
                var errMsg = err && err.message ? err.message : 'unknown';
                ctx.addLog('visual-check', '[vision-cost] error round=' + round +
                  ' elapsedMs=' + (Date.now() - _visionStartedAt) + ' msg=' + errMsg);
                ctx.addLog('visual-check', 'Vision CLI error: ' + errMsg);
                // Preserve real MODEL_FATALs (e.g. auth/quota) but allow the visual
                // stage to degrade gracefully when the vision backend simply times out
                // or returns no parseable analysis. CUA remains the real hard gate.
                if (err && /MODEL_FATAL/i.test(errMsg) && !isVisualInfraFailureReason(errMsg)) {
                  throw err;
                }
                return {
                  passed: false,
                  reason: 'Vision CLI unavailable: ' + errMsg,
                  infraDegraded: true,
                };
              });
          }
          return _visionPromise
            .then(function(analysis) {
              ctx.addLog('visual-check', (analysis.passed ? 'PASSED' : 'FAILED') + ' — ' + analysis.reason);

              // Same-reason early exit: if VLM returns the same failure reason multiple rounds in a row,
              // additional fix attempts won't help — exit early to save tokens.
              if (!analysis.passed) {
                var reasonKey = (analysis.reason || '').slice(0, 60).toLowerCase().replace(/\s+/g, ' ').trim();
                if (analysis.infraDegraded || isVisualInfraFailureReason(reasonKey)) {
                  ctx.addLog('visual-check', 'Vision backend degraded after preview capture — continuing with warning: ' + analysis.reason);
                  if (!ctx.blueprint.feedbackHistory) ctx.blueprint.feedbackHistory = [];
                  ctx.blueprint.feedbackHistory.push({
                    data: { text: '[visual-check warning] Vision backend unavailable, skipped visual QA: ' + analysis.reason },
                    source: 'visual-check-infra-warning',
                    status: 'info',
                    timestamp: Date.now(),
                  });
                  ctx.visualCheckDegraded = true;
                  ctx.htmlOutput = lastHtmlForVisual;
                  ctx.csCode = lastCsCode;
                  return {
                    done: true,
                    result: { passed: true, degraded: true, reason: analysis.reason },
                  };
                }
                if (reasonKey && reasonKey === lastVisualReasonKey) {
                  sameReasonCount++;
                  if (sameReasonCount >= SAME_REASON_EXIT - 1) {
                    ctx.addLog('visual-check', 'Same visual reason ' + (sameReasonCount + 1) + ' rounds in a row — early exit (saves token budget)');
                    ctx.htmlOutput = lastHtmlForVisual;
                    ctx.csCode = lastCsCode;
                    return { done: true, result: { passed: false, rounds: round, earlyExit: 'same-reason', reason: analysis.reason } };
                  }
                } else {
                  sameReasonCount = 0;
                  lastVisualReasonKey = reasonKey;
                }
              }

              // Additional hard gates even if VLM says passed:
              // 1. Critical runtime errors → override to fail
              if (analysis.passed && result.consoleErrors) {
                var fatalErrors = result.consoleErrors.filter(function(e) {
                  return e.indexOf('[pageerror]') >= 0 || e.indexOf('TypeError') >= 0 ||
                         e.indexOf('ReferenceError') >= 0;
                });
                if (fatalErrors.length >= 3) {
                  ctx.addLog('visual-check', 'Overriding VLM pass — ' + fatalErrors.length + ' critical runtime errors');
                  analysis.passed = false;
                  analysis.reason = 'Runtime errors: ' + fatalErrors.slice(0, 3).join('; ');
                }
              }

              // 2. No phase activity + no console activity after extended capture → warn
              if (analysis.passed && phaseLog.length === 0 && result.consoleErrors.length === 0 && frameCount >= 3) {
                ctx.addLog('visual-check', 'Warning: VLM passed but no phase activity and no console output — game may be static');
                // Don't override, but inject warning for downstream stages
                if (!ctx.blueprint.feedbackHistory) ctx.blueprint.feedbackHistory = [];
                ctx.blueprint.feedbackHistory.push({
                  data: { text: '[visual-check warning] Game appears visually correct but no phase instrumentation detected. CUA should verify interactivity.' },
                  source: 'visual-check-no-phase-warning',
                  status: 'info',
                  timestamp: Date.now(),
                });
              }

              if (analysis.passed) {
                ctx.htmlOutput = lastHtmlForVisual;
                ctx.csCode = lastCsCode;
                return { done: true, result: { passed: true, rounds: round, phaseLog: phaseLog.length, consoleErrors: (result.consoleErrors || []).length } };
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
                  severity: 'warning',
                  stage: 'visual-check',
                  description: '[Visual] ' + analysis.reason.slice(0, 200),
                  rule: 'Visual Check',
                  fix: 'Fix visual layout/rendering issue',
                  line: '',
                }], ctx.taskId).catch(function() {});
              } catch(e) {}

              return recode({
                taskId: ctx.taskId,
                currentCode: lastCsCode,
                extraFiles: lastExtraFiles,
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
                if (recodeResult.extraFiles) {
                  for (var efn in recodeResult.extraFiles) {
                    if (recodeResult.extraFiles.hasOwnProperty(efn)) {
                      lastExtraFiles[efn] = recodeResult.extraFiles[efn];
                    }
                  }
                }
                ctx.reportStatus('building', { message: '[Linux] 视觉修复重编译 (round ' + (round + 1) + ')...' });

                var buildOptions = { visualAssets: helpers.buildVisualAssetsForRequest(ctx) };
                return helpers.buildRequest(buildUrl, '/build', lastCsCode, lastExtraFiles, buildOptions)
                  .then(function(buildResult) {
                    if (!buildResult.ok) throw new Error('Visual fix rebuild failed');
                    ctx.addLog('visual-check', 'Visual fix rebuild OK in ' + buildResult.buildTime + 's');
                    // Nest /build-html inside /build success to prevent Object→writeFileSync crash
                    return helpers.buildRequest(buildUrl, '/build-html', lastCsCode, lastExtraFiles, buildOptions)
                      .then(function(newHtml) {
                        lastHtmlForVisual = newHtml;
                        fs.writeFileSync(path.join(previewDir, 'index.html'), lastHtmlForVisual);
                        return { done: false };
                      });
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
