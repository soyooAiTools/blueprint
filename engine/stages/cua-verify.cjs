/**
 * Stage: cua-verify — CUA verification + auto-fix loop
 *
 * Reads: ctx.htmlOutput, ctx.csCode, ctx.blueprint, ctx.extraFiles
 * Writes: ctx.htmlOutput (updated), ctx.csCode (updated)
 */

var fs = require('fs');
var path = require('path');
var helpers = require('../helpers.cjs');
var cloneStage = require('./clone.cjs');

var MAX_CUA_ROUNDS = 20;
var SAME_ISSUE_REGEN_THRESHOLD = 3;

module.exports = {
  name: 'cua-verify',
  canRetry: false, // has its own internal loop
  canSkip: function(ctx) {
    return process.env.SKIP_CUA === 'true';
  },
  execute: function(ctx) {
    ctx.addLog('cua-verify', 'Starting CUA verification...');
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
    var _infraFailCount = 0;

    var cuaRound = startRound - 1;

    function doRound() {
      cuaRound++;
      if (cuaRound > MAX_CUA_ROUNDS) {
        throw new Error('CUA failed after ' + MAX_CUA_ROUNDS + ' rounds');
      }

      if (ctx.reportStatus) {
        ctx.reportStatus('processing', { message: '[Linux] CUA verifying... (round ' + cuaRound + '/' + MAX_CUA_ROUNDS + ')', previewUrl: ctx.previewUrl });
      }

      var cuaBuildDir = path.join(require('os').tmpdir(), 'linux-cua-' + ctx.taskId + '-r' + cuaRound);
      fs.mkdirSync(cuaBuildDir, { recursive: true });
      fs.writeFileSync(path.join(cuaBuildDir, 'iframe.html'), lastHtmlData);

      return runCUAVerification(cuaBuildDir, ctx.blueprint, ctx.taskId, function(msg) { ctx.addLog('cua-verify', msg); })
        .catch(function(cuaErr) {
          ctx.addLog('cua-verify', 'Round ' + cuaRound + ' error: ' + cuaErr.message);
          try { fs.rmSync(cuaBuildDir, { recursive: true, force: true }); } catch(e) {}

          if (lastIssueCategory === 'crash') { consecutiveSameIssue++; }
          else { consecutiveSameIssue = 1; lastIssueCategory = 'crash'; }

          if (consecutiveSameIssue >= 3) {
            throw new Error('CUA crashed ' + consecutiveSameIssue + ' consecutive rounds');
          }
          return doRound();
        })
        .then(function(cuaResult) {
          if (!cuaResult) return doRound(); // error path returned undefined
          try { fs.rmSync(cuaBuildDir, { recursive: true, force: true }); } catch(e) {}

          // Solid color detection
          if (cuaResult.quickTestDetail && cuaResult.quickTestDetail.solidColor) {
            if (!cuaResult.quickTestDetail.codeBug) {
              // True black = headless no GPU — pass
              ctx.addLog('cua-verify', 'Solid black screen (headless no GPU) — passing');
              ctx.htmlOutput = lastHtmlData;
              ctx.csCode = lastCsCode;
              if (ctx.reportStatus) {
                ctx.reportStatus('done', { message: '[Linux] Build OK, CUA通过 (headless无GPU)', previewUrl: ctx.previewUrl });
              }
              return { passed: true, round: cuaRound, reason: 'headless-pass' };
            }
            // Non-black solid = code bug, fall through to fix cycle
            cuaResult.issues = ['[quick-test] Solid color screen — objects not visible'];
            cuaResult.passed = false;
          }

          if (cuaResult.passed || cuaResult.skipped) {
            ctx.htmlOutput = lastHtmlData;
            ctx.csCode = lastCsCode;
            ctx.addLog('cua-verify', 'CUA ' + (cuaResult.skipped ? 'SKIPPED' : 'PASSED') + ' round ' + cuaRound);
            if (ctx.reportStatus) {
              ctx.reportStatus('cua_passed', {
                message: '[Linux] CUA passed (round ' + cuaRound + ')!',
                previewUrl: ctx.previewUrl,
                qualityData: { cuaResult: { passed: true, round: cuaRound }, cuaRetries: cuaRound },
              });
            }
            return { passed: true, round: cuaRound };
          }

          // Infra failure detection
          if (cuaResult.report && (cuaResult.report.cuaApiUnreachable || cuaResult.report.infraFailure)) {
            _infraFailCount++;
            if (_infraFailCount >= 3) {
              throw new Error('CUA API unreachable after 3 attempts');
            }
            ctx.addLog('cua-verify', 'API unreachable (attempt ' + _infraFailCount + '/3), retrying...');
            return new Promise(function(r) { setTimeout(r, 5000); }).then(doRound);
          }

          ctx.addLog('cua-verify', 'FAILED round ' + cuaRound + '/' + MAX_CUA_ROUNDS + ': ' + (cuaResult.issues || []).length + ' issues');

          // Consecutive same-issue detection
          var currentIssueCategory = helpers.categorizeIssue(cuaResult);
          var phaseCoverage = helpers.extractPhaseCoverage(cuaResult);
          var currentPhaseCompleted = phaseCoverage ? phaseCoverage.completed : -1;
          var isProgressing = currentPhaseCompleted > lastPhaseCompleted && lastPhaseCompleted >= 0;

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

          if (consecutiveSameIssue >= SAME_ISSUE_REGEN_THRESHOLD * 2) {
            throw new Error('Same issue "' + currentIssueCategory + '" after ' + consecutiveSameIssue + ' rounds (no progress)');
          }

          // Autoplay detection
          var hasAutoplay = (cuaResult.issues || []).some(function(i) {
            return i.includes('[autoplay') || i.includes('autoplay');
          });
          if (hasAutoplay) {
            _autoplayFailCount++;
            if (_autoplayFailCount >= 3) {
              throw new Error('Autoplay detected ' + _autoplayFailCount + ' consecutive rounds');
            }
          } else {
            _autoplayFailCount = 0;
          }

          if (cuaRound >= MAX_CUA_ROUNDS) {
            throw new Error('CUA failed after ' + MAX_CUA_ROUNDS + ' rounds');
          }

          // Full regen on repeated same issue
          if (consecutiveSameIssue >= SAME_ISSUE_REGEN_THRESHOLD) {
            var regenReason = 'Previous ' + consecutiveSameIssue + ' attempts all failed with "' + currentIssueCategory + '". ' +
              'You MUST implement ALL phases. Every phase transition must have real conditions.';
            ctx.blueprint.feedbackHistory = [{ text: regenReason, source: 'full-regen-hint', status: 'pending', timestamp: Date.now() }];
            fixHistory.length = 0;
          }

          // Build feedback + fix cycle
          if (ctx.reportStatus) {
            ctx.reportStatus('processing', { message: '[Linux] CUA round ' + cuaRound + ' failed, AI re-coding...', previewUrl: ctx.previewUrl });
          }

          var fixEntry = {
            round: cuaRound,
            issueCategory: currentIssueCategory,
            issues: (cuaResult.issues || []).slice(0, 3),
            codeLines: lastCsCode ? lastCsCode.split('\n').length : 0,
          };
          fixHistory.push(fixEntry);

          var cuaFeedback = helpers.buildStructuredFeedback(cuaRound, cuaResult, ctx.blueprint, fixHistory, lastCsCode);
          if (!ctx.blueprint.feedbackHistory) ctx.blueprint.feedbackHistory = [];
          if (ctx.blueprint.feedbackHistory.length >= 2) {
            ctx.blueprint.feedbackHistory = ctx.blueprint.feedbackHistory.slice(-1);
          }
          ctx.blueprint.feedbackHistory.push({
            data: cuaFeedback,
            source: 'cua-linux-round-' + cuaRound,
            status: 'pending',
            timestamp: Date.now(),
          });

          // Re-code: surgical fix (early rounds) vs full regen (after repeated same issue)
          var isSurgicalFix = consecutiveSameIssue < SAME_ISSUE_REGEN_THRESHOLD;
          var fixTempDir = path.join(require('os').tmpdir(), 'linux-fix-' + ctx.taskId + '-r' + cuaRound);
          if (fs.existsSync(fixTempDir)) fs.rmSync(fixTempDir, { recursive: true, force: true });

          try {
            cloneStage.getBaseTemplate(fixTempDir, function(msg) { ctx.addLog('cua-verify', msg); }, ctx.taskId);
          } catch(cloneErr) {
            ctx.addLog('cua-verify', 'CUA fix git clone failed: ' + cloneErr.message);
            return doRound();
          }

          var fixAssetsDir = path.join(fixTempDir, 'Assets', 'Program', 'Script', 'Manager');
          fs.mkdirSync(fixAssetsDir, { recursive: true });
          // Always write current code so AI has context for surgical fixes
          fs.writeFileSync(path.join(fixAssetsDir, 'GameFlowManagerMain.cs'), lastCsCode);

          if (isSurgicalFix) {
            // Surgical fix: add targeted instruction referencing specific code lines
            ctx.addLog('cua-verify', 'Surgical fix mode (round ' + cuaRound + '): targeting specific code sections');
            if (!ctx.blueprint.feedbackHistory) ctx.blueprint.feedbackHistory = [];
            // Keep existing feedback, add surgical instruction
            ctx.blueprint.feedbackHistory.push({
              data: { text: 'SURGICAL FIX MODE: Do NOT rewrite the entire file. Only modify the specific lines/functions that cause the issue below.\n' + cuaFeedback.text },
              source: 'cua-surgical-round-' + cuaRound,
              status: 'pending',
              timestamp: Date.now(),
            });
          } else {
            ctx.addLog('cua-verify', 'Full regen mode (consecutive same issue: ' + consecutiveSameIssue + ')');
          }

          var USE_CLAUDE_CODE = process.env.USE_CLAUDE_CODE !== 'false';
          var generator;
          try {
            generator = USE_CLAUDE_CODE
              ? require('../../worker/claude-code-coder.js').generateWithClaudeCode
              : require('../../worker/worker-coder.js').generateCodeV5;
          } catch(e) {
            try { fs.rmSync(fixTempDir, { recursive: true, force: true }); } catch(e2) {}
            return doRound();
          }

          return generator(ctx.blueprint, fixTempDir, function(msg) { ctx.addLog('cua-verify', msg); }, ctx.taskId, 'unity')
            .then(function(fixResult) {
              if (!fixResult.ok) {
                ctx.addLog('cua-verify', 'Fix re-code failed');
                try { fs.rmSync(fixTempDir, { recursive: true, force: true }); } catch(e) {}
                return doRound();
              }

              var fixCsFiles = helpers.findFiles(fixTempDir, '.cs');
              var fixMainCs = null;
              for (var i = 0; i < fixCsFiles.length; i++) {
                if (fixCsFiles[i].indexOf('GameFlowManagerMain.cs') !== -1) { fixMainCs = fixCsFiles[i]; break; }
              }
              if (!fixMainCs) {
                try { fs.rmSync(fixTempDir, { recursive: true, force: true }); } catch(e) {}
                return doRound();
              }

              lastCsCode = fs.readFileSync(fixMainCs, 'utf-8');
              var fixExtraFiles = Object.assign({}, ctx.extraFiles);
              try { fs.rmSync(fixTempDir, { recursive: true, force: true }); } catch(e) {}

              // Rebuild
              if (ctx.reportStatus) {
                ctx.reportStatus('building', { message: '[Linux] CUA fix rebuilding... (round ' + (cuaRound + 1) + ')' });
              }

              return helpers.buildRequest(buildUrl, '/build', lastCsCode, fixExtraFiles)
                .then(function(buildResult) {
                  if (!buildResult.ok) {
                    ctx.addLog('cua-verify', 'Fix rebuild failed: ' + (buildResult.error || ''));
                    return doRound();
                  }
                  ctx.addLog('cua-verify', 'Fix rebuild OK in ' + buildResult.buildTime + 's');

                  // Save checkpoint
                  ctx.checkpoint.cuaRound = cuaRound;
                  ctx.checkpoint.fixHistory = fixHistory;

                  // Download new HTML
                  return helpers.buildRequest(buildUrl, '/build-html', lastCsCode, fixExtraFiles);
                })
                .then(function(newHtml) {
                  lastHtmlData = newHtml;
                  lastExtraFiles = fixExtraFiles;
                  ctx.addLog('cua-verify', 'Fix HTML: ' + (newHtml.length / 1048576).toFixed(1) + 'MB');
                  fs.writeFileSync(path.join(previewDir, 'index.html'), lastHtmlData);
                  return doRound();
                })
                .catch(function(err) {
                  ctx.addLog('cua-verify', 'Fix rebuild/HTML error: ' + err.message);
                  return doRound();
                });
            });
        });
    }

    return doRound();
  },
};
