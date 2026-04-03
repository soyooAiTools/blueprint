/**
 * Stage: compile — Bridge.NET build with auto-fix loop
 *
 * Reads: ctx.csCode, ctx.extraFiles, ctx.blueprint, ctx.workDir
 * Writes: ctx.htmlOutput, ctx.buildTime
 */

var helpers = require('../helpers.cjs');
var { recode } = require('../recode.cjs');
var { createFixLoop } = require('../fix-loop.cjs');

var MAX_BUILD_FIX_ATTEMPTS = 5;

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
                  return { done: true, result: { ok: true, buildTime: buildResult.buildTime, htmlSize: htmlData.length } };
                });
            }

            var buildError = buildResult.error || '';
            ctx.addLog('compile', 'Build failed: ' + buildError.slice(0, 1000));

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
              blueprint: ctx.blueprint,
              label: 'buildfix',
              round: round,
              log: function(msg) { ctx.addLog('compile', msg); },
            }).then(function(result) {
              if (result.ok) {
                lastCsCode = result.code;
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
