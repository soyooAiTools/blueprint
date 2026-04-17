/**
 * Stage: compile — Bridge.NET build with auto-fix loop
 *
 * Reads: ctx.csCode, ctx.extraFiles, ctx.blueprint, ctx.workDir
 * Writes: ctx.htmlOutput, ctx.buildTime
 */

var fs = require('fs');
var path = require('path');
var helpers = require('../helpers.cjs');
var { recode } = require('../recode.cjs');
var { createFixLoop } = require('../fix-loop.cjs');
var config = require('../../lib/config.cjs');

var MAX_BUILD_FIX_ATTEMPTS = 5;
// Early exit if the build fails with the same error signature 3 rounds in a row —
// the AI is stuck on the same root cause, additional rounds will only burn tokens.
var SAME_BUILD_ERROR_EXIT = 3;

module.exports = {
  name: 'compile',
  canRetry: false,
  assertBefore: function(ctx) {
    if (!ctx.csCode || ctx.csCode.length === 0) throw new Error('No C# code to compile');
  },
  execute: function(ctx) {
    ctx.addLog('compile', 'Starting Bridge.NET compilation...');
    var buildUrl = ctx.workerConfig.buildUrl;
    var lastCsCode = ctx.csCode;
    var lastExtraFiles = Object.assign({}, ctx.extraFiles);
    // Count by signature (not consecutive): catches A->B->A->B oscillation that the
    // old consecutive-match logic kept resetting on every flip. (P2-新2, 2026-04-15)
    var errSigCounts = {};

    var loop = createFixLoop({
      name: 'compile',
      maxRounds: MAX_BUILD_FIX_ATTEMPTS,
      onExhausted: 'throw',
      beforeRound: function(ctx, round, maxRounds) {
        var label = round === 1 ? '' : ' (fix attempt ' + (round - 1) + '/' + maxRounds + ')';
        ctx.reportStatus('building', { message: '[Linux] Bridge.NET compiling...' + label });
      },
      attempt: function(ctx, round, maxRounds) {
        return helpers.buildRequest(buildUrl, '/build', lastCsCode, lastExtraFiles)
          .catch(function(e) { return { ok: false, error: e.message }; })
          .then(function(buildResult) {
            if (buildResult.ok) {
              ctx.addLog('compile', 'Build OK in ' + buildResult.buildTime + 's');
              ctx.csCode = lastCsCode;
              ctx.extraFiles = lastExtraFiles;
              ctx.buildTime = buildResult.buildTime;

              return helpers.buildRequest(buildUrl, '/build-html', lastCsCode, lastExtraFiles)
                .then(function(htmlData) {
                  if (!htmlData || htmlData.length < 10240) {
                    throw new Error('HTML output too small (' + (htmlData ? htmlData.length : 0) + ' bytes) — likely empty build');
                  }
                  ctx.htmlOutput = htmlData;
                  ctx.addLog('compile', 'HTML: ' + (htmlData.length / 1048576).toFixed(1) + 'MB');

                  // Persist C# source for SVN/git archival
                  try {
                    var sourcesDir = path.join(config.SOURCES_DIR, ctx.taskId);
                    fs.mkdirSync(sourcesDir, { recursive: true });
                    fs.writeFileSync(path.join(sourcesDir, 'GameFlowManagerMain.cs'), lastCsCode, 'utf-8');
                    var efKeys = Object.keys(lastExtraFiles);
                    for (var ei = 0; ei < efKeys.length; ei++) {
                      fs.writeFileSync(path.join(sourcesDir, efKeys[ei]), lastExtraFiles[efKeys[ei]], 'utf-8');
                    }
                    ctx.addLog('compile', 'C# source saved to project-sources/' + ctx.taskId);
                  } catch(saveErr) {
                    ctx.addLog('compile', 'WARN: Failed to save C# source: ' + saveErr.message);
                  }

                  return { done: true, result: { ok: true, buildTime: buildResult.buildTime, htmlSize: htmlData.length } };
                });
            }

            var buildError = buildResult.error || '';
            ctx.addLog('compile', 'Build failed: ' + buildError.slice(0, 1000));

            // Same-error early exit: signature on first ~200 chars of error.
            // CS error codes (e.g. "CS0117") plus the offending identifier are typically captured here.
            // We count occurrences across ALL rounds (not just consecutive), so an A->B->A->B
            // oscillation also trips the gate once either signature reaches the threshold.
            var errSig = buildError.slice(0, 200);
            if (errSig) {
              errSigCounts[errSig] = (errSigCounts[errSig] || 0) + 1;
              if (errSigCounts[errSig] >= SAME_BUILD_ERROR_EXIT) {
                throw new Error('Build failed with same error ' + errSigCounts[errSig] + ' times across rounds — stopping (saves token budget): ' + errSig.slice(0, 160));
              }
            }

            if (round >= maxRounds) {
              throw new Error('Build failed after ' + maxRounds + ' fix attempts: ' + buildError.slice(0, 200));
            }

            ctx.addLog('compile', 'AI fixing build error (' + round + '/' + maxRounds + ')...');
            ctx.reportStatus('processing', { message: '[Linux] Build failed, AI fixing... (' + round + '/' + maxRounds + ')' });

            if (!ctx.blueprint.feedbackHistory) ctx.blueprint.feedbackHistory = [];
            ctx.blueprint.feedbackHistory.push({
              data: { text: 'Build compilation failed:\n' + buildError.slice(0, 1500) + '\nPlease fix the C# compilation errors.' },
              source: 'build-fix-attempt-' + round,
              status: 'pending',
              timestamp: Date.now(),
            });

            return recode({
              taskId: ctx.taskId,
              currentCode: lastCsCode,
              extraFiles: lastExtraFiles,
              blueprint: ctx.blueprint,
              label: 'buildfix',
              round: round,
              log: function(msg) { ctx.addLog('compile', msg); },
            }).then(function(result) {
              if (result.ok) {
                lastCsCode = result.code;
                // Pick up partial class files (e.g. Systems.cs) from recode
                if (result.extraFiles) {
                  for (var efn in result.extraFiles) {
                    if (result.extraFiles.hasOwnProperty(efn)) {
                      lastExtraFiles[efn] = result.extraFiles[efn];
                    }
                  }
                }
                ctx.addLog('compile', 'Build fix ' + round + ': got fixed code (' + lastCsCode.length + ' chars)');
              } else {
                ctx.addLog('compile', 'Build fix re-code failed: ' + result.error);
              }
              return { done: false };
            });
          });
      },
    });

    return loop.run(ctx);
  },
};
