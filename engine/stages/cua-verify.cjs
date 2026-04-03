/**
 * Stage: cua-verify — CUA verification + auto-fix loop
 *
 * Reads: ctx.htmlOutput, ctx.csCode, ctx.blueprint, ctx.extraFiles
 * Writes: ctx.htmlOutput (updated), ctx.csCode (updated)
 */

var fs = require('fs');
var path = require('path');
var helpers = require('../helpers.cjs');
var { recode, patchRecode } = require('../recode.cjs');
var { createFixLoop } = require('../fix-loop.cjs');

var MAX_CUA_ROUNDS = 20;
var MAX_CUA_TOTAL_MS = 30 * 60 * 1000; // 30 min absolute time limit
var NO_PROGRESS_EXIT_ROUNDS = 5; // exit if no phase progress in N consecutive rounds
var SAME_ISSUE_REGEN_THRESHOLD = 3;

module.exports = {
  name: 'cua-verify',
  canRetry: false,
  assertBefore: function(ctx) {
    if (!ctx.htmlOutput) throw new Error('No HTML output from compile stage');
    if (ctx.htmlOutput.length < 10240) throw new Error('HTML output too small (' + ctx.htmlOutput.length + ' bytes) — likely empty build');
  },
  canSkip: function(ctx) {
    return process.env.SKIP_CUA === 'true';
  },
  execute: function(ctx) {
    ctx.addLog('cua-verify', 'Starting CUA verification...');
    var cuaStartTime = Date.now();
    var buildUrl = ctx.workerConfig.buildUrl;

    var runCUAVerification;
    try { runCUAVerification = require('../../worker/worker-playableagent.js').runCUAVerification; } catch(e) {}
    if (!runCUAVerification) {
      return Promise.reject(new Error('worker-playableagent.js not available'));
    }

    var lastHtmlData = ctx.htmlOutput;
    var lastCsCode = ctx.csCode;
    var lastExtraFiles = Object.assign({}, ctx.extraFiles);
    var previewDir = path.join(__dirname, '..', '..', 'server-data', 'webgl', ctx.taskId);
    var startRound = (ctx.checkpoint.cuaRound || 0) + 1;
    var fixHistory = (ctx.checkpoint.fixHistory) || [];
    var consecutiveSameIssue = 0;
    var lastIssueCategory = null;
    var lastPhaseCompleted = -1;
    var _autoplayFailCount = 0;
    var _noProgressRounds = 0;

    var loop = createFixLoop({
      name: 'cua-verify',
      maxRounds: MAX_CUA_ROUNDS,
      onExhausted: 'throw',
      beforeRound: function(ctx, round) {
        ctx.reportStatus('processing', { message: '[Linux] CUA verifying... (round ' + round + '/' + MAX_CUA_ROUNDS + ')', previewUrl: ctx.previewUrl });
      },
      attempt: function(ctx, round) {
        // Time limit check
        var elapsed = Date.now() - cuaStartTime;
        if (elapsed > MAX_CUA_TOTAL_MS) {
          throw new Error('CUA total time limit exceeded (' + Math.round(elapsed / 60000) + 'min > ' + Math.round(MAX_CUA_TOTAL_MS / 60000) + 'min)');
        }
        var cuaBuildDir = path.join(require('os').tmpdir(), 'linux-cua-' + ctx.taskId + '-r' + round);
        fs.mkdirSync(cuaBuildDir, { recursive: true });
        fs.writeFileSync(path.join(cuaBuildDir, 'iframe.html'), lastHtmlData);

        return runCUAVerification(cuaBuildDir, ctx.blueprint, ctx.taskId, function(msg) { ctx.addLog('cua-verify', msg); })
          .catch(function(cuaErr) {
            ctx.addLog('cua-verify', 'CUA error: ' + cuaErr.message);
            try { fs.rmSync(cuaBuildDir, { recursive: true, force: true }); } catch(e) {}

            if (lastIssueCategory === 'crash') { consecutiveSameIssue++; }
            else { consecutiveSameIssue = 1; lastIssueCategory = 'crash'; }

            if (consecutiveSameIssue >= 3) {
              throw new Error('CUA crashed ' + consecutiveSameIssue + ' consecutive rounds');
            }
            return null; // Will trigger { done: false }
          })
          .then(function(cuaResult) {
            if (!cuaResult) return { done: false };
            try { fs.rmSync(cuaBuildDir, { recursive: true, force: true }); } catch(e) {}

            // Solid color detection
            if (cuaResult.quickTestDetail && cuaResult.quickTestDetail.solidColor) {
              if (!cuaResult.quickTestDetail.codeBug) {
                ctx.addLog('cua-verify', 'Solid black screen (headless no GPU) — passing');
                ctx.htmlOutput = lastHtmlData;
                ctx.csCode = lastCsCode;
                ctx.reportStatus('done', { message: '[Linux] Build OK, CUA通过 (headless无GPU)', previewUrl: ctx.previewUrl });
                return { done: true, result: { passed: true, round: round, reason: 'headless-pass' } };
              }
              cuaResult.issues = ['[quick-test] Solid color screen — objects not visible'];
              cuaResult.passed = false;
            }

            if (cuaResult.passed || cuaResult.skipped) {
              ctx.htmlOutput = lastHtmlData;
              ctx.csCode = lastCsCode;
              ctx.addLog('cua-verify', 'CUA ' + (cuaResult.skipped ? 'SKIPPED' : 'PASSED'));
              ctx.reportStatus('cua_passed', {
                message: '[Linux] CUA passed (round ' + round + ')!',
                previewUrl: ctx.previewUrl,
                qualityData: { cuaResult: { passed: true, round: round }, cuaRetries: round },
              });
              return { done: true, result: { passed: true, round: round } };
            }

            // Infra failure — let error-classifier handle via throw
            if (cuaResult.report && (cuaResult.report.cuaApiUnreachable || cuaResult.report.infraFailure)) {
              throw new Error('CUA API unreachable');
            }

            ctx.addLog('cua-verify', 'FAILED: ' + (cuaResult.issues || []).length + ' issues');

            // Consecutive same-issue detection
            var currentIssueCategory = helpers.categorizeIssue(cuaResult);
            var phaseCoverage = helpers.extractPhaseCoverage(cuaResult);
            var currentPhaseCompleted = phaseCoverage ? phaseCoverage.completed : -1;

            // Prefer console-based phase tracking over VLM analysis
            var consolePhaseCoverage = helpers.extractPhaseFromConsole(
                (cuaResult.report && cuaResult.report.diagnostics && cuaResult.report.diagnostics.consoleMessages) || []
            );
            if (consolePhaseCoverage.length > 0) {
                currentPhaseCompleted = consolePhaseCoverage.length;
                ctx.addLog('cua-verify', 'Phase progress (instrumented): ' + consolePhaseCoverage.join(' → '));
            }

            var isProgressing = currentPhaseCompleted > lastPhaseCompleted && lastPhaseCompleted > 0;

            if (isProgressing) {
              consecutiveSameIssue = 1;
              lastIssueCategory = currentIssueCategory;
            } else if (currentIssueCategory === lastIssueCategory) {
              consecutiveSameIssue++;
            } else {
              consecutiveSameIssue = 1;
              lastIssueCategory = currentIssueCategory;
            }
            if (currentPhaseCompleted >= 0) lastPhaseCompleted = currentPhaseCompleted;

            // No-progress handling: graduated strategy
            if (isProgressing) {
              _noProgressRounds = 0;
            } else {
              _noProgressRounds++;
              if (_noProgressRounds >= NO_PROGRESS_EXIT_ROUNDS + 3) {
                // Hard exit after 8 no-progress rounds
                throw new Error('No phase progress in ' + _noProgressRounds + ' consecutive rounds (stuck at phase ' + currentPhaseCompleted + ')');
              } else if (_noProgressRounds === NO_PROGRESS_EXIT_ROUNDS) {
                // Force full regen strategy after 5 rounds, but keep trying
                ctx.addLog('cua-verify', 'No progress for ' + _noProgressRounds + ' rounds \u2014 escalating to full regen');
                consecutiveSameIssue = SAME_ISSUE_REGEN_THRESHOLD;
              }
            }

            if (consecutiveSameIssue >= SAME_ISSUE_REGEN_THRESHOLD * 2) {
              throw new Error('Same issue "' + currentIssueCategory + '" after ' + consecutiveSameIssue + ' rounds (no progress)');
            }

            // Timing-based autoplay detection (complements text-based check)
            if (cuaResult.passed && consolePhaseCoverage.length >= 2) {
              var agentActions = (cuaResult.report && cuaResult.report.actions) || [];
              if (agentActions.length === 0) {
                ctx.addLog('cua-verify', 'All phases completed with 0 agent actions \u2014 overriding to FAIL (autoplay)');
                cuaResult.passed = false;
                cuaResult.issues = (cuaResult.issues || []).concat(
                  ['[autoplay-zero-actions] ' + consolePhaseCoverage.length + ' phases completed with 0 agent actions']
                );
              }
            }

            // Autoplay detection
            var hasAutoplay = (cuaResult.issues || []).some(function(i) {
              return i.includes('[autoplay') || i.includes('autoplay');
            });
            if (hasAutoplay) {
              _autoplayFailCount++;
              if (_autoplayFailCount >= 3) throw new Error('Autoplay detected ' + _autoplayFailCount + ' consecutive rounds');
            } else {
              _autoplayFailCount = 0;
            }

            // Full regen on repeated same issue — PRESERVE failure context
            if (consecutiveSameIssue >= SAME_ISSUE_REGEN_THRESHOLD) {
              var regenReason = 'Previous ' + consecutiveSameIssue + ' attempts all failed with "' + currentIssueCategory + '". ' +
                'You MUST implement ALL phases. Every phase transition must have real conditions.';
              var lastFailures = (ctx.blueprint.feedbackHistory || []).slice(-2).map(function(f) {
                return (f.data && f.data.text) ? f.data.text.slice(0, 300) : '';
              }).join('\n');
              ctx.blueprint.feedbackHistory = [{
                text: regenReason + '\n\nPrevious failure context:\n' + lastFailures,
                source: 'full-regen-with-history',
                status: 'pending',
                timestamp: Date.now(),
              }];
              fixHistory.length = 0;
            }

            // Build feedback
            ctx.reportStatus('processing', { message: '[Linux] CUA round ' + round + ' failed, AI re-coding...', previewUrl: ctx.previewUrl });

            fixHistory.push({
              round: round,
              issueCategory: currentIssueCategory,
              issues: (cuaResult.issues || []).slice(0, 3),
              codeLines: lastCsCode ? lastCsCode.split('\n').length : 0,
            });

            var cuaFeedback = helpers.buildStructuredFeedback(round, cuaResult, ctx.blueprint, fixHistory, lastCsCode);
            if (!ctx.blueprint.feedbackHistory) ctx.blueprint.feedbackHistory = [];
            if (ctx.blueprint.feedbackHistory.length >= 2) {
              ctx.blueprint.feedbackHistory = ctx.blueprint.feedbackHistory.slice(-1);
            }
            ctx.blueprint.feedbackHistory.push({
              data: cuaFeedback,
              source: 'cua-linux-round-' + round,
              status: 'pending',
              timestamp: Date.now(),
            });

            // Record CUA failures to pending-rules for knowledge retention
            try {
              var codeReviewer = require('../../worker/code-reviewer.js');
              var cuaIssues = (cuaResult.issues || []).map(function(issueText) {
                return {
                  severity: 'critical',
                  description: '[CUA] ' + issueText.slice(0, 200),
                  rule: 'CUA Verification',
                  fix: 'See CUA feedback for details',
                  line: '',
                };
              });
              codeReviewer.recordNewIssues(cuaIssues, ctx.taskId).catch(function() {});
            } catch(e) {}

            // Surgical vs full regen hint
            var isSurgicalFix = consecutiveSameIssue < SAME_ISSUE_REGEN_THRESHOLD;
            if (isSurgicalFix) {
              ctx.addLog('cua-verify', 'Surgical fix mode');
              ctx.blueprint.feedbackHistory.push({
                data: { text: 'SURGICAL FIX MODE: Do NOT rewrite the entire file. Only modify the specific lines/functions that cause the issue below.\n' + cuaFeedback.text },
                source: 'cua-surgical-round-' + round,
                status: 'pending',
                timestamp: Date.now(),
              });
            } else {
              ctx.addLog('cua-verify', 'Full regen mode (consecutive: ' + consecutiveSameIssue + ')');
            }

            var cuaFixLog = function(msg) { ctx.addLog('cua-verify', msg); };
            var cuaFixPromise;
            if (isSurgicalFix && cuaResult.issues && cuaResult.issues.length <= 3) {
              var structuredIssues = (cuaResult.issues || []).map(function(issueText, idx) {
                var lineMatch = typeof issueText === 'string' ? issueText.match(/[Ll]ine?\s*(\d+)/) : null;
                return {
                  line: (lineMatch ? parseInt(lineMatch[1], 10) : 0),
                  message: typeof issueText === 'string' ? issueText : (issueText.message || issueText.text || ''),
                };
              });
              var allHaveLines = structuredIssues.every(function(i) { return i.line > 0; });
              if (allHaveLines) {
                cuaFixPromise = patchRecode({
                  taskId: ctx.taskId,
                  currentCode: lastCsCode,
                  issues: structuredIssues,
                  blueprint: ctx.blueprint,
                  label: 'cuafix',
                  round: round,
                  log: cuaFixLog,
                }).then(function(patchResult) {
                  if (patchResult.ok) return patchResult;
                  cuaFixLog('patchRecode failed, falling back to full recode');
                  return recode({
                    taskId: ctx.taskId,
                    currentCode: lastCsCode,
                    blueprint: ctx.blueprint,
                    label: 'cuafix',
                    round: round,
                    log: cuaFixLog,
                  });
                });
              }
            }
            if (!cuaFixPromise) {
              cuaFixPromise = recode({
                taskId: ctx.taskId,
                currentCode: lastCsCode,
                blueprint: ctx.blueprint,
                label: 'cuafix',
                round: round,
                log: cuaFixLog,
              });
            }

            return cuaFixPromise.then(function(recodeResult) {
              if (!recodeResult.ok) {
                ctx.addLog('cua-verify', 'Fix re-code failed: ' + recodeResult.error);
                return { done: false };
              }

              lastCsCode = recodeResult.code;
              ctx.reportStatus('building', { message: '[Linux] CUA fix rebuilding... (round ' + (round + 1) + ')' });

              return helpers.buildRequest(buildUrl, '/build', lastCsCode, Object.assign({}, ctx.extraFiles))
                .then(function(buildResult) {
                  if (!buildResult.ok) {
                    ctx.addLog('cua-verify', 'Fix rebuild failed: ' + (buildResult.error || ''));
                    return { done: false };
                  }
                  ctx.addLog('cua-verify', 'Fix rebuild OK in ' + buildResult.buildTime + 's');
                  ctx.checkpoint.cuaRound = round;
                  ctx.checkpoint.fixHistory = fixHistory;

                  return helpers.buildRequest(buildUrl, '/build-html', lastCsCode, Object.assign({}, ctx.extraFiles));
                })
                .then(function(newHtml) {
                  lastHtmlData = newHtml;
                  ctx.addLog('cua-verify', 'Fix HTML: ' + (newHtml.length / 1048576).toFixed(1) + 'MB');
                  fs.writeFileSync(path.join(previewDir, 'index.html'), lastHtmlData);
                  return { done: false };
                })
                .catch(function(err) {
                  ctx.addLog('cua-verify', 'Fix rebuild/HTML error: ' + err.message);
                  return { done: false };
                });
            });
          });
      },
    });

    return loop.run(ctx);
  },
};
