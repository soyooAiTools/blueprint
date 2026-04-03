/**
 * Stage: review — Code review (Codex or GPT-5.4 fallback) with fix loop
 *
 * Reads: ctx.csCode, ctx.blueprint, ctx.workDir
 * Writes: ctx.csCode (updated with reviewed code)
 */

var fs = require('fs');
var path = require('path');
var helpers = require('../helpers.cjs');
var { recode } = require('../recode.cjs');
var { createFixLoop } = require('../fix-loop.cjs');
var { staticCheck } = require('../static-check.cjs');

var MAX_REVIEW_ROUNDS = 6;

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
            ctx.addLog('review', reviewerName + ' review still FAIL after ' + maxRounds + ' rounds (0 critical, warnings only), proceeding');
            return { done: true, result: { passed: false, rounds: round, criticalCount: 0, warningOnly: true } };
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

          return recode({
            taskId: ctx.taskId,
            currentCode: reviewedCode,
            blueprint: fixBlueprint,
            label: 'reviewfix',
            round: round,
            log: function(msg) { ctx.addLog('review', msg); },
          }).then(function(recodeResult) {
            if (recodeResult.ok) {
              reviewedCode = recodeResult.code;
              ctx.addLog('review', 'Review fix applied (' + reviewedCode.length + ' chars)');
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
      return result;
    });
  },
};
