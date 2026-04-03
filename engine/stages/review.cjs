/**
 * Stage: review — Code review (Codex or GPT-5.4 fallback) with fix loop
 *
 * Reads: ctx.csCode, ctx.blueprint, ctx.workDir
 * Writes: ctx.csCode (updated with reviewed code)
 */

var fs = require('fs');
var path = require('path');
var helpers = require('../helpers.cjs');

var MAX_REVIEW_ROUNDS = 6;

module.exports = {
  name: 'review',
  canRetry: false, // has its own internal retry loop
  canSkip: function(ctx) {
    return process.env.SKIP_CODE_REVIEW === 'true' || !ctx.csCode;
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

    // Build pool name map for reviewer context
    var reviewPoolNameMap = null;
    try {
      var promptV5 = require('../../worker/prompt-v5-basetemplate.js');
      if (ctx.blueprint.entities && ctx.blueprint.entities.length > 0) {
        reviewPoolNameMap = promptV5.matchPrefabs(ctx.blueprint.entities);
      }
    } catch(e) {}

    var reviewerName = (USE_CODEX_REVIEW && codexReviewer) ? 'Codex' : 'GPT-5.4';
    if (ctx.reportStatus) {
      ctx.reportStatus('processing', { message: '[Linux] ' + reviewerName + ' 代码审核中...' });
    }

    var USE_CLAUDE_CODE = process.env.USE_CLAUDE_CODE !== 'false';
    var reviewedCode = ctx.csCode;
    var round = 0;

    function doReviewRound() {
      round++;
      if (round > MAX_REVIEW_ROUNDS) {
        return Promise.resolve({ passed: false, rounds: round - 1 });
      }

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
        return Promise.resolve({ passed: true, skipped: true });
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
          if (ctx.reportStatus) {
            ctx.reportStatus('processing', {
              message: ('[Linux] ' + reviewerName + ' 审核通过' + (round > 1 ? ' (第' + round + '轮)' : '')).slice(0, 100),
              qualityData: { reviewResult: { passed: true, reviewer: reviewerName, round: round } },
            });
          }
          // Update csCode from file (may have been modified during review fix)
          var allCs = helpers.findFiles(ctx.workDir, '.cs');
          var mainCs = null;
          for (var i = 0; i < allCs.length; i++) {
            if (allCs[i].indexOf('GameFlowManagerMain.cs') !== -1) { mainCs = allCs[i]; break; }
          }
          if (mainCs) ctx.csCode = fs.readFileSync(mainCs, 'utf-8');
          return { passed: true, rounds: round };
        }

        if (round >= MAX_REVIEW_ROUNDS) {
          var critCount = reviewResult.criticalCount || 0;
          if (critCount > 0) {
            ctx.addLog('review', '⚠️ ' + reviewerName + ' review still has ' + critCount + ' critical issues after ' + MAX_REVIEW_ROUNDS + ' rounds — proceeding anyway (CUA will catch real problems)');
            if (ctx.reportStatus) {
              ctx.reportStatus('processing', { message: '[Linux] ' + reviewerName + ' 审核有 ' + critCount + ' 个critical问题，跳过继续 (CUA将验证)' });
            }
          } else {
            ctx.addLog('review', reviewerName + ' review still FAIL after ' + MAX_REVIEW_ROUNDS + ' rounds (0 critical), proceeding');
          }
          return { passed: false, rounds: round, noCritical: critCount === 0, criticalCount: critCount, warningOnly: true };
        }

        ctx.addLog('review', reviewerName + ' review FAIL (round ' + round + '/' + MAX_REVIEW_ROUNDS + '), fixing...');
        if (ctx.reportStatus) {
          ctx.reportStatus('processing', { message: '[Linux] ' + reviewerName + ' 审核失败 (' + round + '/' + MAX_REVIEW_ROUNDS + ')，AI修复中...' });
        }

        // Feed review feedback to AI for fixing
        var fixBlueprint = Object.assign({}, ctx.blueprint, {
          feedbackHistory: (ctx.blueprint.feedbackHistory || []).concat([
            { text: reviewResult.feedback, source: 'code-review' },
          ]),
        });

        var generator;
        try {
          if (USE_CLAUDE_CODE) {
            generator = require('../../worker/claude-code-coder.js').generateWithClaudeCode;
          } else {
            generator = require('../../worker/worker-coder.js').generateCodeV5;
          }
        } catch(e) {
          return Promise.resolve({ passed: false, rounds: round, error: 'No generator for fix' });
        }

        return generator(fixBlueprint, ctx.workDir, function(msg) { ctx.addLog('review', msg); }, ctx.taskId, 'unity')
          .then(function(fixResult) {
            if (fixResult.ok) {
              var allCs = helpers.findFiles(ctx.workDir, '.cs');
              var mainCs = null;
              for (var i = 0; i < allCs.length; i++) {
                if (allCs[i].indexOf('GameFlowManagerMain.cs') !== -1) { mainCs = allCs[i]; break; }
              }
              if (mainCs) {
                reviewedCode = fs.readFileSync(mainCs, 'utf-8');
                ctx.addLog('review', 'Review fix applied (' + reviewedCode.length + ' chars), re-reviewing...');
              }
            }
            return doReviewRound();
          });
      });
    }

    return doReviewRound().then(function(result) {
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
