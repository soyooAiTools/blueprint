/**
 * Stage: review — Code review (Codex or GPT-5.4 fallback) with fix loop
 *
 * Reads: ctx.csCode, ctx.blueprint, ctx.workDir
 * Writes: ctx.csCode (updated with reviewed code)
 */

var fs = require('fs');
var path = require('path');
var helpers = require('../helpers.cjs');
var { recode, patchRecode } = require('../recode.cjs');
var { createFixLoop } = require('../fix-loop.cjs');
var { staticCheck } = require('../static-check.cjs');
var { checkConformance } = require('../spec-conformance.cjs');

var MAX_REVIEW_ROUNDS = 4;

module.exports = {
  name: 'review',
  canRetry: false,
  canSkip: function(ctx) {
    return process.env.SKIP_CODE_REVIEW === 'true' || !ctx.csCode;
  },
  assertBefore: function(ctx) {
    if (!ctx.csCode) throw new Error('No code to review');
    var lines = ctx.csCode.split('\n');
    var lineCount = lines.length;
    var findCalls = (ctx.csCode.match(/GameObject\.Find/g) || []).length;
    var gfmCalls = (ctx.csCode.match(/GFM_Create\.Obj/g) || []).length;
    var todoLines = lines.filter(function(l) { return /\/\/ TODO(?!_\w+(?:START|END))/i.test(l); }).length;
    var todoRatio = todoLines / lineCount;
    if (lineCount < 100) throw new Error('Stub code: only ' + lineCount + ' lines');
    if (findCalls === 0 && gfmCalls === 0) throw new Error('No GameObject.Find or GFM_Create calls — likely stub');
    if (todoRatio > 0.2) throw new Error('Too many unfilled TODOs: ' + Math.round(todoRatio * 100) + '%');
  },
  execute: function(ctx) {
    ctx.addLog('review', 'Starting code review...');

    var codeReviewer, codexReviewer;
    try { codeReviewer = require('../../worker/code-reviewer.js'); } catch(e) {}
    try { codexReviewer = require('../../worker/codex-reviewer.js'); } catch(e) {}
    var USE_CODEX_REVIEW = process.env.USE_CODEX_REVIEW !== 'false';

    if (!USE_CODEX_REVIEW && !codexReviewer && !codeReviewer) {
      ctx.addLog('review', 'No reviewer available, skipping');
      return Promise.resolve({ skipped: true });
    }

    var reviewPoolNameMap = null;
    try {
      var promptV5 = require('../../worker/prompt-v5-basetemplate.js');
      if (ctx.blueprint.entities && ctx.blueprint.entities.length > 0) {
        reviewPoolNameMap = promptV5.matchPrefabs(ctx.blueprint.entities);
      }
    } catch(e) {}

    var reviewerName = (USE_CODEX_REVIEW && codexReviewer) ? 'Codex' : 'GPT-5.4';
    ctx.reportStatus('processing', { message: '[Linux] ' + reviewerName + ' 代码审核中...' });

    var reviewedCode = ctx.csCode;
    var reviewExtraFiles = Object.assign({}, ctx.extraFiles);

    // Static pre-check: catch forbidden APIs before burning LLM tokens
    var preCheck = staticCheck(reviewedCode);
    if (!preCheck.passed) {
      var staticIssues = preCheck.issues.map(function(i) { return 'L' + i.line + ': ' + i.message + ' — ' + i.text; }).join('\n');
      ctx.addLog('review', 'Static pre-check found ' + preCheck.issues.length + ' issues, injecting as feedback');
      if (!ctx.blueprint.feedbackHistory) ctx.blueprint.feedbackHistory = [];
      ctx.blueprint.feedbackHistory.push({
        data: { text: 'STATIC CHECK VIOLATIONS (must fix before review):\n' + staticIssues },
        source: 'static-precheck',
        status: 'pending',
        timestamp: Date.now(),
      });
    }

    // Spec conformance check: verify code semantics match blueprint
    if (ctx.blueprint.specs && ctx.blueprint.specs.length > 0) {
      var conformance = checkConformance(reviewedCode, ctx.blueprint);
      if (!conformance.passed) {
        var confIssues = conformance.issues.map(function(i) {
          return '[' + i.severity + '] ' + i.phase + ': ' + i.message;
        }).join('\n');
        ctx.addLog('review', 'Spec conformance: ' + conformance.criticalCount + ' critical, ' + conformance.warningCount + ' warnings');
        if (!ctx.blueprint.feedbackHistory) ctx.blueprint.feedbackHistory = [];
        ctx.blueprint.feedbackHistory.push({
          data: { text: 'SPEC CONFORMANCE VIOLATIONS (must fix):\n' + confIssues },
          source: 'spec-conformance',
          status: 'pending',
          timestamp: Date.now(),
        });
      } else {
        ctx.addLog('review', 'Spec conformance: all phases verified');
      }
    }

    var loop = createFixLoop({
      name: 'review',
      maxRounds: MAX_REVIEW_ROUNDS,
      onExhausted: 'throw',
      beforeRound: function(ctx, round, maxRounds) {
        if (round > 1) {
          ctx.reportStatus('processing', { message: '[Linux] ' + reviewerName + ' 审核 (' + round + '/' + maxRounds + ')...' });
        }
      },
      attempt: function(ctx, round, maxRounds) {
        var reviewPromise;
        if (USE_CODEX_REVIEW && codexReviewer) {
          reviewPromise = codexReviewer.reviewCodeWithCodex(reviewedCode, {
            taskId: ctx.taskId,
            log: function(msg) { ctx.addLog('review', msg); },
            extraFiles: reviewExtraFiles,
          });
        } else if (codeReviewer) {
          reviewPromise = codeReviewer.reviewCode(reviewedCode, {
            taskId: ctx.taskId,
            log: function(msg) { ctx.addLog('review', msg); },
            poolNameMap: reviewPoolNameMap,
          });
        } else {
          return Promise.resolve({ done: true, result: { passed: true, skipped: true } });
        }

        return reviewPromise.then(function(reviewResult) {
          // Codex fallback to GPT-5.4 on env/parse errors
          if (!reviewResult.passed && (reviewResult.parseError || reviewResult.error) && USE_CODEX_REVIEW && codexReviewer && codeReviewer) {
            ctx.addLog('review', 'Codex had env/parse error, falling back to GPT-5.4');
            return codeReviewer.reviewCode(reviewedCode, {
              taskId: ctx.taskId,
              log: function(msg) { ctx.addLog('review', msg); },
              poolNameMap: reviewPoolNameMap,
            });
          }
          return reviewResult;
        }).then(function(reviewResult) {
          if (reviewResult.passed) {
            ctx.addLog('review', reviewerName + ' review PASSED' + (round > 1 ? ' (round ' + round + ')' : ''));
            ctx.reportStatus('processing', {
              message: ('[Linux] ' + reviewerName + ' 审核通过' + (round > 1 ? ' (第' + round + '轮)' : '')).slice(0, 100),
              qualityData: { reviewResult: { passed: true, reviewer: reviewerName, round: round } },
            });
            var allCs = helpers.findFiles(ctx.workDir, '.cs');
            var mainCs = null;
            for (var i = 0; i < allCs.length; i++) {
              if (allCs[i].indexOf('GameFlowManagerMain.cs') !== -1) { mainCs = allCs[i]; break; }
            }
            if (mainCs) ctx.csCode = fs.readFileSync(mainCs, 'utf-8');
            return { done: true, result: { passed: true, rounds: round } };
          }

          if (round >= maxRounds) {
            var critCount = reviewResult.criticalCount || 0;
            if (critCount > 0) {
              ctx.addLog('review', reviewerName + ' review still has ' + critCount + ' critical issues after ' + maxRounds + ' rounds — BLOCKING');
              throw new Error('Review blocked: ' + critCount + ' critical issues remain after ' + maxRounds + ' rounds');
            }
            // Classify remaining warnings — block high-risk types
            var remainingIssues = reviewResult.issues || [];
            var highRiskWarnings = remainingIssues.filter(function(i) {
              var msg = (i.message || i.text || '').toLowerCase();
              return msg.indexOf('infinite loop') >= 0 ||
                     msg.indexOf('null reference') >= 0 ||
                     msg.indexOf('pool object') >= 0 ||
                     msg.indexOf('phase missing') >= 0 ||
                     msg.indexOf('phase will never complete') >= 0 ||
                     msg.indexOf('autoplay') >= 0 ||
                     msg.indexOf('instantiate') >= 0 ||
                     msg.indexOf('forbidden') >= 0 ||
                     msg.indexOf('setactive') >= 0 ||
                     msg.indexOf('destroy(') >= 0 ||
                     msg.indexOf('coroutine') >= 0 ||
                     msg.indexOf('startcoroutine') >= 0 ||
                     msg.indexOf('addcomponent') >= 0;
            });
            if (highRiskWarnings.length > 0) {
              ctx.addLog('review', 'High-risk warnings after ' + maxRounds + ' rounds — BLOCKING: ' +
                highRiskWarnings.map(function(w) { return w.message || w.text; }).join('; '));
              throw new Error('Review blocked: ' + highRiskWarnings.length + ' high-risk warnings remain');
            }
            ctx.addLog('review', remainingIssues.length + ' low-risk warnings after ' + maxRounds + ' rounds, passing with context');
            ctx.reviewWarnings = remainingIssues;
            return { done: true, result: { passed: false, rounds: round, criticalCount: 0, warningOnly: true, warnings: remainingIssues } };
          }

          ctx.addLog('review', reviewerName + ' review FAIL (' + round + '/' + maxRounds + '), fixing...');
          ctx.reportStatus('processing', { message: '[Linux] ' + reviewerName + ' 审核失败 (' + round + '/' + maxRounds + ')，AI修复中...' });

          // Attach line numbers for issues found in review
          var reviewFeedbackText = reviewResult.feedback || '';
          if (reviewResult.issues && reviewResult.issues.length > 0) {
            var codeLines = reviewedCode.split('\n');
            var codeSnippets = [];
            for (var ri = 0; ri < Math.min(reviewResult.issues.length, 5); ri++) {
              var issue = reviewResult.issues[ri];
              var issueLine = issue.line || 0;
              if (issueLine > 0 && issueLine <= codeLines.length) {
                var snippetStart = Math.max(0, issueLine - 3);
                var snippetEnd = Math.min(codeLines.length, issueLine + 5);
                var snippet = [];
                for (var si = snippetStart; si < snippetEnd; si++) {
                  snippet.push('L' + (si + 1) + ': ' + codeLines[si]);
                }
                codeSnippets.push('Issue: ' + (issue.message || issue.text || '') + '\n' + snippet.join('\n'));
              }
            }
            if (codeSnippets.length > 0) {
              reviewFeedbackText += '\n\n=== CODE CONTEXT (fix these specific lines) ===\n' + codeSnippets.join('\n\n');
            }
          }

          var fixBlueprint = Object.assign({}, ctx.blueprint, {
            feedbackHistory: (ctx.blueprint.feedbackHistory || []).concat([
              { text: reviewFeedbackText, source: 'code-review' },
            ]),
          });

          var usePatch = reviewResult.issues && reviewResult.issues.length <= 3
            && reviewResult.issues.every(function(i) { return i.line > 0; });
          var fixLog = function(msg) { ctx.addLog('review', msg); };

          var fixPromise;
          if (usePatch) {
            fixPromise = patchRecode({
              taskId: ctx.taskId,
              currentCode: reviewedCode,
              extraFiles: reviewExtraFiles,
              issues: reviewResult.issues,
              blueprint: fixBlueprint,
              label: 'reviewfix',
              round: round,
              log: fixLog,
            }).then(function(patchResult) {
              if (patchResult.ok) return patchResult;
              fixLog('patchRecode failed, falling back to full recode');
              return recode({
                taskId: ctx.taskId,
                currentCode: reviewedCode,
                extraFiles: reviewExtraFiles,
                blueprint: fixBlueprint,
                label: 'reviewfix',
                round: round,
                log: fixLog,
              });
            });
          } else {
            fixPromise = recode({
              taskId: ctx.taskId,
              currentCode: reviewedCode,
              extraFiles: reviewExtraFiles,
              blueprint: fixBlueprint,
              label: 'reviewfix',
              round: round,
              log: fixLog,
            });
          }

          return fixPromise.then(function(recodeResult) {
            if (recodeResult.ok) {
              reviewedCode = recodeResult.code;
              if (recodeResult.extraFiles) {
                for (var efn in recodeResult.extraFiles) {
                  if (recodeResult.extraFiles.hasOwnProperty(efn)) {
                    reviewExtraFiles[efn] = recodeResult.extraFiles[efn];
                  }
                }
              }
              ctx.addLog('review', 'Review fix applied (' + reviewedCode.length + ' chars' + (recodeResult.patchApplied ? ', patch mode' : '') + ')');
            }
            return { done: false };
          });
        });
      },
    });

    return loop.run(ctx).then(function(result) {
      // Final update of csCode
      var allCs = helpers.findFiles(ctx.workDir, '.cs');
      var mainCs = null;
      for (var i = 0; i < allCs.length; i++) {
        if (allCs[i].indexOf('GameFlowManagerMain.cs') !== -1) { mainCs = allCs[i]; break; }
      }
      if (mainCs) ctx.csCode = fs.readFileSync(mainCs, 'utf-8');

      // Phase coverage gate: block if < 80% of spec phases are implemented
      var specs = ctx.blueprint.specs || [];
      if (specs.length > 0) {
        var code = ctx.csCode || '';
        var implementedCount = 0;
        for (var si = 0; si < specs.length; si++) {
          var pid = specs[si].phaseId;
          if (code.indexOf('AddCompletedPhase("' + pid + '"') >= 0 ||
              code.indexOf('ReportPhase("' + pid + '"') >= 0 ||
              code.indexOf('CheckEventRules("' + pid + '"') >= 0) {
            implementedCount++;
          }
        }
        var coverage = implementedCount / specs.length;
        ctx.addLog('review', 'Phase coverage: ' + implementedCount + '/' + specs.length + ' (' + Math.round(coverage * 100) + '%)');
        if (coverage < 0.8) {
          var missingPhases = [];
          for (var mi = 0; mi < specs.length; mi++) {
            var mpid = specs[mi].phaseId;
            if (code.indexOf('AddCompletedPhase("' + mpid + '"') < 0 &&
                code.indexOf('ReportPhase("' + mpid + '"') < 0 &&
                code.indexOf('CheckEventRules("' + mpid + '"') < 0) {
              missingPhases.push(mpid);
            }
          }
          throw new Error('Phase coverage too low: ' + implementedCount + '/' + specs.length +
            ' (' + Math.round(coverage * 100) + '%). Missing: ' + missingPhases.join(', '));
        }
      }

      return result;
    });
  },
};
