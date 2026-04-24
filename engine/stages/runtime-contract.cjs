// Source: engine/stages/runtime-contract.cjs
/**
 * Stage: runtime-contract — structured runtime verification gate
 *
 * Runs one PlayableAgent observe pass to collect __gameState-backed plan/signal
 * coverage and lightweight visual smoke verdicts. This stage does NOT fix code;
 * it only decides whether heavy CUA escalation is necessary.
 */

var fs = require('fs');
var path = require('path');
var os = require('os');

function parseCoverageLabel(label) {
  if (!label) return null;
  var match = String(label).match(/(\d+)\s*\/\s*(\d+)/);
  if (!match) return null;
  return {
    covered: parseInt(match[1], 10) || 0,
    total: parseInt(match[2], 10) || 0,
  };
}

function buildHardBlockingSignals(silentSignals, isAutoPlayMode) {
  return (silentSignals || []).filter(function(signal) {
    if (signal.indexOf('uniform-timing') === 0 && isAutoPlayMode) return false;
    return signal.indexOf('uniform-timing') === 0
      || signal.indexOf('phase-order-violation') === 0
      || signal.indexOf('all-vars-zero') === 0
      || signal.indexOf('batch-completion') === 0
      || signal.indexOf('no-phase-timestamps') === 0;
  });
}

function buildEscalationReasons(meta) {
  var reasons = [];
  if (!meta.hasGameState) reasons.push('missing-game-state');
  if ((meta.unsupportedSignals || []).length > 0) reasons.push('unsupported-signals');
  if (!meta.planPassed) reasons.push('plan-coverage-incomplete');
  if (!meta.signalPassed) reasons.push('signal-validation-failed');
  if ((meta.hardBlockingSignals || []).length > 0) reasons.push('silent-pass-blocked');
  if (!meta.visualSmokePassed) reasons.push('visual-smoke-failed');
  return reasons;
}

function summarizeRuntimeContractResult(result) {
  if (!result) {
    throw new Error('Runtime contract returned no result');
  }

  if (result.skipped && !result.passed) {
    var skipReason = (result.issues && result.issues[0]) || result.error || 'runtime contract prerequisite missing';
    throw new Error('Runtime contract infra skip: ' + skipReason);
  }

  var planParts = parseCoverageLabel(result.planCoverage);
  var signalParts = parseCoverageLabel(result.signalCoverage);
  var missingSignals = result.missingSignals || [];
  var unsupportedSignals = result.unsupportedSignals || [];
  var visualFailReasons = result.visualFailReasons || [];
  var silentSignals = result.silentPassSignals || [];
  var hardBlockingSignals = result.hardBlockingSilentSignals || buildHardBlockingSignals(silentSignals, result.isAutoPlayMode === true);
  var hasGameState = !!(result.report && result.report.gameState);
  var planPassed = !!(planParts && planParts.total > 0 && planParts.covered >= planParts.total);
  var signalPassed = result.signalValidationPassed !== false && missingSignals.length === 0;
  var visualSmokePassed = visualFailReasons.length === 0;
  var evidenceReliable = hasGameState && unsupportedSignals.length === 0;
  var contractPassed = evidenceReliable && planPassed && signalPassed && hardBlockingSignals.length === 0 && visualSmokePassed;
  var escalationReasons = buildEscalationReasons({
    hasGameState: hasGameState,
    unsupportedSignals: unsupportedSignals,
    planPassed: planPassed,
    signalPassed: signalPassed,
    hardBlockingSignals: hardBlockingSignals,
    visualSmokePassed: visualSmokePassed,
  });

  return {
    passed: contractPassed,
    contractPassed: contractPassed,
    needsEscalation: escalationReasons.length > 0,
    escalationReasons: escalationReasons,
    planCoverage: result.planCoverage || null,
    signalCoverage: result.signalCoverage || null,
    signalValidationPassed: result.signalValidationPassed !== false,
    planCoveredCount: planParts ? planParts.covered : null,
    planTotalCount: planParts ? planParts.total : null,
    signalCoveredCount: signalParts ? signalParts.covered : null,
    signalTotalCount: signalParts ? signalParts.total : null,
    missingSignalCount: missingSignals.length,
    unsupportedSignalCount: unsupportedSignals.length,
    missingSignals: missingSignals.slice(0, 12),
    unsupportedSignals: unsupportedSignals.slice(0, 12),
    silentPassSignals: silentSignals.slice(),
    hardBlockingSilentSignals: hardBlockingSignals.slice(),
    visualFailCount: visualFailReasons.length,
    visualFailReasons: visualFailReasons.slice(0, 12),
    visualSmokePassed: visualSmokePassed,
    hasGameState: hasGameState,
    evidenceReliable: evidenceReliable,
    totalActions: result.totalActions !== undefined ? result.totalActions : -1,
    isAutoPlayMode: result.isAutoPlayMode === true,
    exitReason: result.exitReason || (result.report && result.report.exitReason) || '',
  };
}

function runRuntimeContractPass(ctx, options) {
  options = options || {};
  var stageName = options.stageName || 'runtime-contract';
  var writeStageResult = options.writeStageResult !== false;
  var reportStatus = options.reportStatus !== false;
  var statusPrefix = options.statusPrefix || '[Linux] Runtime contract';
  var startTime = Date.now();

  ctx.addLog(stageName, 'Starting runtime contract verification...');
  if (reportStatus) {
    ctx.reportStatus('processing', {
      message: statusPrefix + ' verifying...',
      previewUrl: ctx.previewUrl,
    });
  }

  var runCUAVerification;
  try { runCUAVerification = require('../../worker/worker-playableagent.js').runCUAVerification; } catch(e) {}
  if (!runCUAVerification) {
    return Promise.reject(new Error('worker-playableagent.js not available'));
  }

  var buildDir = path.join(os.tmpdir(), 'linux-runtime-contract-' + ctx.taskId + '-' + Date.now());
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(path.join(buildDir, 'iframe.html'), ctx.htmlOutput);

  return runCUAVerification(buildDir, ctx.blueprint, ctx.taskId, function(msg) {
    ctx.addLog(stageName, msg);
  }).then(function(result) {
    try { fs.rmSync(buildDir, { recursive: true, force: true }); } catch(e) {}

    var summary = summarizeRuntimeContractResult(result);
    summary.durationMs = Date.now() - startTime;
    summary.rounds = 1;

    if (summary.needsEscalation) {
      ctx.addLog(stageName,
        'Escalation required: ' + summary.escalationReasons.join(', ') +
        ' | plan=' + (summary.planCoverage || 'n/a') +
        ' signal=' + (summary.signalCoverage || 'n/a'));
      if (reportStatus) {
        ctx.reportStatus('processing', {
          message: statusPrefix + ' flagged issues, escalating to heavy CUA...',
          previewUrl: ctx.previewUrl,
        });
      }
    } else {
      ctx.addLog(stageName,
        'Runtime contract passed: plan=' + (summary.planCoverage || 'n/a') +
        ', signal=' + (summary.signalCoverage || 'n/a') +
        ' — heavy CUA not required');
      if (reportStatus) {
        ctx.reportStatus('processing', {
          message: statusPrefix + ' passed, heavy CUA skipped',
          previewUrl: ctx.previewUrl,
        });
      }
    }

    if (writeStageResult) {
      ctx.stageResults = ctx.stageResults || {};
      ctx.stageResults['runtime-contract'] = summary;
    }

    return summary;
  }).catch(function(err) {
    try { fs.rmSync(buildDir, { recursive: true, force: true }); } catch(e) {}
    throw err;
  });
}

module.exports = {
  name: 'runtime-contract',
  canRetry: false,
  assertBefore: function(ctx) {
    if (!ctx.htmlOutput) throw new Error('No HTML output from compile stage');
    if (ctx.htmlOutput.length < 10240) throw new Error('HTML output too small (' + ctx.htmlOutput.length + ' bytes) — likely empty build');
  },
  canSkip: function(ctx) {
    if (process.env.SKIP_RUNTIME_CONTRACT === 'true') {
      ctx.addLog('runtime-contract', 'WARNING: runtime contract skipped via SKIP_RUNTIME_CONTRACT env');
      return true;
    }
    if (process.env.SKIP_CUA === 'true') {
      ctx.addLog('runtime-contract', 'WARNING: runtime contract skipped via SKIP_CUA env');
      return true;
    }
    return false;
  },
  execute: function(ctx) {
    return runRuntimeContractPass(ctx, {
      stageName: 'runtime-contract',
      reportStatus: true,
      writeStageResult: true,
      statusPrefix: '[Linux] Runtime contract',
    });
  },
  runRuntimeContractPass: runRuntimeContractPass,
};
