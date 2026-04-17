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
      ctx.addLog('review', 'No reviewer module available — aborting (no silent skip)');
      throw new Error('MODEL_FATAL: no reviewer available (neither codex-reviewer nor code-reviewer loaded)');
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

    // Spec conformance check: verify code semantics match blueprint
    // P1-6: Only inject as feedback if there are genuine critical issues after fuzzy matching
    // This prevents "phaseId naming mismatch" from poisoning the fix loop
    if (ctx.blueprint.specs && ctx.blueprint.specs.length > 0) {
      var conformance = checkConformance(reviewedCode, ctx.blueprint);
      ctx.addLog('review', 'Spec conformance: ' + conformance.criticalCount + ' critical, ' + conformance.warningCount + ' warnings');
      if (!conformance.passed && conformance.criticalCount > 0) {
        // Only inject critical issues (not warnings) into feedback to avoid noise
        var criticalIssues = conformance.issues.filter(function(i) { return i.severity === 'critical'; });
        var confIssues = criticalIssues.map(function(i) {
          return '[critical] ' + i.phase + ': ' + i.message;
        }).join('\n');
        if (!ctx.blueprint.feedbackHistory) ctx.blueprint.feedbackHistory = [];
        ctx.blueprint.feedbackHistory.push({
          data: { text: 'SPEC CONFORMANCE VIOLATIONS (critical only):\n' + confIssues },
          source: 'spec-conformance',
          status: 'pending',
          timestamp: Date.now(),
        });
      } else if (conformance.passed) {
        ctx.addLog('review', 'Spec conformance: all phases verified');
      } else {
        ctx.addLog('review', 'Spec conformance: only warnings (not injecting as feedback to avoid fix loop poisoning)');
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
        // Static pre-check: catch forbidden APIs every round. Runs BEFORE the
        // LLM reviewer so static violations trigger a recode pass even when:
        //  - codex preflight fails silently and returns passed:true
        //  - LLM reviewer misses blocking APIs
        //  - Network to reviewer is flaky
        // Before bqh33t 2026-04-15 this check only ran once at the top of
        // execute() and only injected feedback, which was ignored on clean
        // reviewer pass — leading to known-broken GFM_Create.Obj() code
        // advancing to visual-check → cua-verify with black screen.
        var reviewPromise;
        var preCheck = staticCheck(reviewedCode);
        if (!preCheck.passed) {
          var staticIssues = preCheck.issues.map(function(i) {
            return 'L' + i.line + ': ' + i.message + ' — ' + i.text;
          }).join('\n');
          ctx.addLog('review', 'Static check (round ' + round + ') found ' + preCheck.issues.length + ' blocking violations — forcing recode without LLM review');
          // Synthesize a failed review result so the existing recode path runs.
          // Uses source='static-precheck' (no parseError/error) so the codex→GPT fallback
          // branch doesn't trigger — we want a direct recode, not another LLM pass.
          reviewPromise = Promise.resolve({
            passed: false,
            feedback: 'STATIC CHECK VIOLATIONS (must fix, these bypass LLM review):\n' + staticIssues,
            issues: preCheck.issues.map(function(i) {
              return { severity: 'critical', line: i.line, message: i.message, text: i.text, rule: i.rule };
            }),
            criticalCount: preCheck.issues.length,
            source: 'static-precheck',
          });
        } else if (USE_CODEX_REVIEW && codexReviewer) {
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
          // Unreachable: the top-of-execute guard already throws MODEL_FATAL
          // if neither reviewer is loaded. Retained as defense-in-depth —
          // any future code path that lands here aborts rather than pretending
          // the review passed.
          throw new Error('MODEL_FATAL: no reviewer invocation path matched');
        }

        return reviewPromise.then(function(reviewResult) {
          // Codex → GPT-5.4 fallback, ONLY for transient parse/env errors.
          // Definitive model failures (quota/auth/402) are now thrown from
          // codex-reviewer as MODEL_FATAL and reject this promise directly,
          // so they never reach this .then. This guard is defense-in-depth:
          // if any future code path returns a fake {error: "quota..."} result,
          // we refuse to cascade into GPT-5.4 (which shares the same OPENAI_API_KEY
          // and would hit the same quota wall — doubling the wasted attempt).
          var isDefinitive = reviewResult.error && /MODEL_FATAL|quota|insufficient|\b401\b|\b402\b|\b403\b|invalid.?api.?key|unauthoriz/i.test(reviewResult.error);
          if (!reviewResult.passed && (reviewResult.parseError || reviewResult.error) && !isDefinitive && USE_CODEX_REVIEW && codexReviewer && codeReviewer) {
            ctx.addLog('review', 'Codex had transient env/parse error, falling back to GPT-5.4');
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
            // Do NOT read from ctx.workDir here — recode() writes to a fresh temp dir,
            // leaving ctx.workDir untouched. The authoritative source is the closure
            // variable reviewedCode, which is synced after every recode pass.
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

          var failRules = (reviewResult.issues || []).map(function(fri) { return fri.rule; }).filter(Boolean);
          var uniqFailRules = failRules.filter(function(r, idx) { return failRules.indexOf(r) === idx; });
          var failRulesTag = uniqFailRules.length > 0 ? ' [' + uniqFailRules.slice(0, 3).join(',') + (uniqFailRules.length > 3 ? ',…' : '') + ']' : '';
          ctx.addLog('review', reviewerName + ' review FAIL (' + round + '/' + maxRounds + ')' + failRulesTag + ', fixing...');
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

          // patchRecode 走 Sonnet 直出，不经过 CC CLI / 完整 prompt — 比 full recode 省 ~150KB token。
          // 旧条件要求所有 issue 都有 line>0，命中率太低（codex 输出经常缺 line）；
          // 改为只要 ≤3 issue 且至少 1 个有 line 就尝试 patch，patchRecode 自身失败时再回落到 full recode。
          var issuesWithLine = (reviewResult.issues || []).filter(function(i) { return i.line > 0; });
          var usePatch = reviewResult.issues && reviewResult.issues.length <= 3
            && issuesWithLine.length >= 1;
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
              // P2-8: Save pre-fix state for rollback if fix makes things worse
              var preFixCode = reviewedCode;
              var preFixExtras = {};
              for (var pfk in reviewExtraFiles) {
                if (reviewExtraFiles.hasOwnProperty(pfk)) preFixExtras[pfk] = reviewExtraFiles[pfk];
              }
              var preFixIssueCount = (reviewResult.criticalCount || 0) + (reviewResult.issues ? reviewResult.issues.length : 0);

              reviewedCode = recodeResult.code;
              if (recodeResult.extraFiles) {
                for (var efn in recodeResult.extraFiles) {
                  if (recodeResult.extraFiles.hasOwnProperty(efn)) {
                    reviewExtraFiles[efn] = recodeResult.extraFiles[efn];
                  }
                }
              }

              // Quick static check: if fix introduced significantly more issues, rollback
              var postFixConformance = checkConformance(reviewedCode, ctx.blueprint);
              var postFixIssueEstimate = postFixConformance.criticalCount + postFixConformance.warningCount;
              var preFixConformance = checkConformance(preFixCode, ctx.blueprint);
              var preFixIssueEstimate = preFixConformance.criticalCount + preFixConformance.warningCount;
              if (postFixIssueEstimate > preFixIssueEstimate + 2) {
                ctx.addLog('review', 'Fix rollback: conformance issues increased (' + preFixIssueEstimate + ' → ' + postFixIssueEstimate + '), reverting to pre-fix code');
                reviewedCode = preFixCode;
                reviewExtraFiles = preFixExtras;
              } else {
                ctx.addLog('review', 'Review fix applied (' + reviewedCode.length + ' chars' + (recodeResult.patchApplied ? ', patch mode' : '') + ')');
              }
            }
            return { done: false };
          });
        });
      },
    });

    return loop.run(ctx).then(function(result) {
      // Sync ctx.csCode from the authoritative in-memory reviewedCode.
      // Do NOT read from ctx.workDir — recode() writes to a fresh temp dir
      // (/tmp/linux-reviewfix-<id>-<round>/), leaving ctx.workDir untouched.
      // Reading from disk would clobber ctx.csCode with the stale pre-recode
      // codegen file, causing the coverage gate below to see 0 phase IDs.
      ctx.csCode = reviewedCode;
      if (reviewExtraFiles) {
        ctx.extraFiles = Object.assign({}, reviewExtraFiles);
      }

      // Phase coverage gate: block if < 80% of spec phases are implemented
      // P1: Use normalized fuzzy matching to avoid false negatives from phaseId naming differences
      var specs = ctx.blueprint.specs || [];
      if (specs.length > 0) {
        var code = ctx.csCode || '';
        // Also check extra files (partial classes)
        var allCode = code;
        if (ctx.extraFiles) {
          for (var efk in ctx.extraFiles) {
            allCode += '\n' + ctx.extraFiles[efk];
          }
        }
        var codeLower = allCode.toLowerCase();

        // Extract all phaseId strings from AddCompletedPhase/ReportPhase calls in actual code
        var codePhaseIds = [];
        var phaseIdMatches = allCode.match(/(?:AddCompletedPhase|ReportPhase)\s*\(\s*"([^"]+)"/g) || [];
        for (var pmi = 0; pmi < phaseIdMatches.length; pmi++) {
          var idMatch = phaseIdMatches[pmi].match(/"([^"]+)"/);
          if (idMatch) codePhaseIds.push(idMatch[1]);
        }
        var codePhaseIdsLower = codePhaseIds.map(function(id) { return id.toLowerCase().replace(/[_\s-]/g, ''); });

        var implementedCount = 0;
        for (var si = 0; si < specs.length; si++) {
          var pid = specs[si].phaseId;
          // Level 1: exact match
          if (codeLower.indexOf('"' + pid.toLowerCase() + '"') >= 0) {
            implementedCount++;
            continue;
          }
          // Level 2: normalized match (strip underscores, case-insensitive)
          var pidNorm = pid.toLowerCase().replace(/[_\s-]/g, '');
          var foundNorm = false;
          for (var cpi = 0; cpi < codePhaseIdsLower.length; cpi++) {
            if (codePhaseIdsLower[cpi] === pidNorm ||
                codePhaseIdsLower[cpi].indexOf(pidNorm) >= 0 ||
                pidNorm.indexOf(codePhaseIdsLower[cpi]) >= 0) {
              foundNorm = true;
              break;
            }
          }
          if (foundNorm) {
            implementedCount++;
            continue;
          }
          // Level 3: keyword overlap — split camelCase into words and check overlap
          var specWords = pid.replace(/([A-Z])/g, ' $1').toLowerCase().trim().split(/\s+/);
          for (var cwi = 0; cwi < codePhaseIds.length; cwi++) {
            var codeWords = codePhaseIds[cwi].replace(/([A-Z])/g, ' $1').toLowerCase().trim().split(/\s+/);
            var overlap = 0;
            for (var swi = 0; swi < specWords.length; swi++) {
              if (specWords[swi].length >= 3 && codeWords.indexOf(specWords[swi]) >= 0) overlap++;
            }
            if (overlap >= Math.max(2, Math.floor(specWords.length * 0.5))) {
              implementedCount++;
              foundNorm = true;
              break;
            }
          }
        }
        var coverage = implementedCount / specs.length;
        ctx.addLog('review', 'Phase coverage (fuzzy): ' + implementedCount + '/' + specs.length + ' (' + Math.round(coverage * 100) + '%)');
        if (coverage < 0.8) {
          var missingPhases = [];
          for (var mi = 0; mi < specs.length; mi++) {
            var mpid = specs[mi].phaseId;
            var mpidNorm = mpid.toLowerCase().replace(/[_\s-]/g, '');
            var found = codeLower.indexOf('"' + mpid.toLowerCase() + '"') >= 0;
            if (!found) {
              for (var mci = 0; mci < codePhaseIdsLower.length; mci++) {
                if (codePhaseIdsLower[mci] === mpidNorm ||
                    codePhaseIdsLower[mci].indexOf(mpidNorm) >= 0 ||
                    mpidNorm.indexOf(codePhaseIdsLower[mci]) >= 0) {
                  found = true;
                  break;
                }
              }
            }
            if (!found) missingPhases.push(mpid);
          }
          throw new Error('Phase coverage too low: ' + implementedCount + '/' + specs.length +
            ' (' + Math.round(coverage * 100) + '%). Missing: ' + missingPhases.join(', '));
        }
      }

      return result;
    });
  },
};