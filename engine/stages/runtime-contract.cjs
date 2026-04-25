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
var http = require('http');

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

function sanitizePhaseId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9]/g, '');
}

function extractSpecs(blueprint) {
  if (!blueprint) return [];
  if (Array.isArray(blueprint.specs)) return blueprint.specs;
  if (Array.isArray(blueprint.phases)) return blueprint.phases;
  if (blueprint.blueprint) return extractSpecs(blueprint.blueprint);
  return [];
}

function isPlayerInteractionSpec(spec) {
  if (!spec) return false;
  var interactions = Array.isArray(spec.requiredInteractions) ? spec.requiredInteractions : [];
  if (spec.playerMustAct === true) return true;
  if (spec.autoAllowed === false && interactions.length > 0) return true;
  for (var i = 0; i < interactions.length; i++) {
    var verb = String(interactions[i] || '').split(':')[0].toLowerCase();
    if (verb && ['wait', 'timer', 'observe', 'show', 'camera'].indexOf(verb) < 0) return true;
  }
  return false;
}

function getInteractivePhaseIds(blueprint) {
  return extractSpecs(blueprint).filter(isPlayerInteractionSpec).map(function(spec) {
    return String(spec.phaseId || spec.id || spec.name || '');
  }).filter(Boolean);
}

function phaseMatches(id, phaseSet) {
  var phase = String(id || '');
  if (!phase) return false;
  return !!(phaseSet[phase] || phaseSet[sanitizePhaseId(phase)]);
}

function getStatePhase(state) {
  if (!state) return '';
  return String(state.currentPhase || state.phase || state.currentPhaseName || '');
}

function getStateCompletedCount(state) {
  if (!state) return 0;
  var completed = state.completedPhases || state.completed || null;
  if (Array.isArray(completed)) return completed.length;
  if (completed && typeof completed === 'object') {
    return Object.keys(completed).filter(function(key) { return completed[key]; }).length;
  }
  var numeric = parseInt(state.completedPhaseCount || state.phaseCompletedCount || 0, 10);
  return Number.isFinite(numeric) ? numeric : 0;
}

function getSpecCompletedCount(state, specs) {
  if (!state) return 0;
  var completed = state.completedPhases || state.completed || null;
  if (!Array.isArray(completed)) return getStateCompletedCount(state);
  var specSet = {};
  (specs || []).forEach(function(spec) {
    var id = String(spec.phaseId || spec.id || spec.name || '');
    if (id) {
      specSet[id] = true;
      specSet[sanitizePhaseId(id)] = true;
    }
  });
  var count = 0;
  completed.forEach(function(id) {
    if (phaseMatches(id, specSet)) count++;
  });
  if (count > 0) return count;
  return completed.filter(function(id) {
    return ['gameStart', 'start', 'init', 'initialize'].indexOf(String(id || '')) < 0;
  }).length;
}

function isTerminalPhase(phase) {
  return ['gameEnd', 'cta', 'CTA', 'ctaPhase'].indexOf(String(phase || '')) >= 0;
}

function startRawPreviewServer(buildDir) {
  return new Promise(function(resolve, reject) {
    var server = http.createServer(function(req, res) {
      var urlPath = (req.url || '/').split('?')[0];
      var filePath = path.join(buildDir, urlPath === '/' ? 'index.html' : urlPath);
      if (!fs.existsSync(filePath) && urlPath === '/') filePath = path.join(buildDir, 'iframe.html');
      if (!fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      var ext = path.extname(filePath).toLowerCase();
      var mime = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.wasm': 'application/wasm',
        '.bin': 'application/octet-stream',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
      }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      fs.createReadStream(filePath).pipe(res);
    });
    server.listen(0, '127.0.0.1', function() { resolve(server); });
    server.on('error', reject);
  });
}

function readGameState(page) {
  return page.evaluate(function() {
    try {
      var state = window.__gameState || null;
      if (!state && typeof window.__getGameState === 'function') state = window.__getGameState();
      if (!state) return null;
      return JSON.parse(JSON.stringify(state));
    } catch(e) {
      return null;
    }
  }).catch(function() { return null; });
}

function monitorDefaultPreviewProgress(page, specs, options, consoleMessages) {
  var targetSpecCount = options.defaultPreviewTargetSpecCount
    || Math.min(Math.max(specs.length, 1), specs.length <= 3 ? specs.length : 3);
  var deadline = Date.now() + (options.defaultPreviewWindowMs || 70000);
  var firstState = null;
  var bestState = null;
  var bestSpecCompleted = -1;
  var phaseChanges = 0;
  var lastPhase = '';

  function sample() {
    return readGameState(page).then(function(state) {
      if (!state) {
        if (Date.now() >= deadline) return null;
        return page.waitForTimeout(1000).then(sample);
      }
      if (!firstState) firstState = state;
      var phase = getStatePhase(state);
      if (lastPhase && phase && phase !== lastPhase) phaseChanges++;
      if (phase) lastPhase = phase;
      var specCompleted = getSpecCompletedCount(state, specs);
      if (specCompleted > bestSpecCompleted) {
        bestSpecCompleted = specCompleted;
        bestState = state;
      }
      if (isTerminalPhase(phase) || specCompleted >= targetSpecCount) {
        return {
          defaultInteractionRequired: true,
          defaultInteractionPassed: true,
          defaultInteractionReason: 'default-preview-progressed',
          defaultInteractionPhaseBefore: getStatePhase(firstState),
          defaultInteractionPhaseAfter: phase,
          defaultInteractionCompletedBefore: getSpecCompletedCount(firstState, specs),
          defaultInteractionCompletedAfter: specCompleted,
          defaultInteractionTargetCompleted: targetSpecCount,
          defaultInteractionPhaseChanges: phaseChanges,
          defaultInteractionConsole: (consoleMessages || []).slice(-8),
        };
      }
      if (Date.now() >= deadline) {
        return {
          defaultInteractionRequired: true,
          defaultInteractionPassed: false,
          defaultInteractionReason: 'default-preview-no-progress',
          defaultInteractionPhaseBefore: getStatePhase(firstState),
          defaultInteractionPhaseAfter: getStatePhase(bestState || state),
          defaultInteractionCompletedBefore: getSpecCompletedCount(firstState, specs),
          defaultInteractionCompletedAfter: Math.max(bestSpecCompleted, specCompleted),
          defaultInteractionTargetCompleted: targetSpecCount,
          defaultInteractionPhaseChanges: phaseChanges,
          defaultInteractionConsole: (consoleMessages || []).slice(-8),
        };
      }
      return page.waitForTimeout(options.defaultPreviewSampleMs || 1000).then(sample);
    });
  }

  return sample();
}

function runDefaultInteractionProbe(ctx, buildDir, options) {
  options = options || {};
  if (process.env.SKIP_DEFAULT_INTERACTION_PROBE === 'true') {
    return Promise.resolve({
      defaultInteractionRequired: false,
      defaultInteractionPassed: null,
      defaultInteractionReason: 'skipped-by-env',
    });
  }

  var specs = extractSpecs(ctx && ctx.blueprint);
  var interactiveIds = getInteractivePhaseIds(ctx && ctx.blueprint);
  if (specs.length === 0) {
    return Promise.resolve({
      defaultInteractionRequired: false,
      defaultInteractionPassed: null,
      defaultInteractionReason: 'no-phase-specs',
    });
  }

  var server;
  var browser;
  var page;

  return startRawPreviewServer(buildDir).then(function(srv) {
    server = srv;
    var port = server.address().port;
    var chromium = require('playwright').chromium;
    return chromium.launch({ headless: true, args: ['--no-sandbox'] }).then(function(b) {
      browser = b;
      return browser.newPage({ viewport: { width: 960, height: 640 } });
    }).then(function(p) {
      page = p;
      var consoleMessages = [];
      page.on('console', function(msg) {
        var text = msg.text();
        if (text.indexOf('__PHASE__') >= 0 || text.indexOf('__PHASE_STUCK__') >= 0) {
          consoleMessages.push(text.slice(0, 260));
        }
      });
      return page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'load', timeout: options.gotoTimeoutMs || 30000 })
        .then(function() {
          return page.waitForFunction(function() {
            return !!window.__gameState || typeof window.__getGameState === 'function';
          }, null, { timeout: options.gameStateTimeoutMs || 20000 });
        })
        .then(function() {
          return monitorDefaultPreviewProgress(page, specs, options, consoleMessages);
        });
    });
  }).catch(function(err) {
    return {
      defaultInteractionRequired: true,
      defaultInteractionPassed: false,
      defaultInteractionReason: 'probe-error: ' + (err && err.message ? err.message : String(err)),
      defaultInteractionExpectedPhases: interactiveIds.slice(0, 8),
    };
  }).then(function(result) {
    var closePage = page ? page.close().catch(function() {}) : Promise.resolve();
    return closePage.then(function() {
      return browser ? browser.close().catch(function() {}) : null;
    }).then(function() {
      if (server) {
        try { server.close(); } catch(e) {}
      }
      return result;
    });
  });
}

function buildEscalationReasons(meta) {
  var reasons = [];
  if (!meta.hasGameState) reasons.push('missing-game-state');
  if ((meta.unsupportedSignals || []).length > 0) reasons.push('unsupported-signals');
  if (!meta.planPassed) reasons.push('plan-coverage-incomplete');
  if (!meta.moduleContractReady) reasons.push('module-contract-incomplete');
  if (!meta.signalPassed) reasons.push('signal-validation-failed');
  if ((meta.hardBlockingSignals || []).length > 0) reasons.push('silent-pass-blocked');
  if (!meta.visualSmokePassed) reasons.push('visual-smoke-failed');
  if (meta.defaultInteractionPassed === false) reasons.push('default-interaction-failed');
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
  // Gray policy for module-contract-as-primary-gate: only skip heavy CUA when
  // the run exposes an actual signal contract and every declared signal is covered.
  var moduleContractReady = !!(signalParts && signalParts.total > 0);
  var signalPassed = moduleContractReady && result.signalValidationPassed !== false && missingSignals.length === 0;
  var visualSmokePassed = visualFailReasons.length === 0;
  var defaultInteractionPassed = result.defaultInteractionPassed;
  var evidenceReliable = hasGameState && unsupportedSignals.length === 0;
  var contractPassed = evidenceReliable && planPassed && moduleContractReady && signalPassed
    && hardBlockingSignals.length === 0 && visualSmokePassed && defaultInteractionPassed !== false;
  var escalationReasons = buildEscalationReasons({
    hasGameState: hasGameState,
    unsupportedSignals: unsupportedSignals,
    planPassed: planPassed,
    moduleContractReady: moduleContractReady,
    signalPassed: signalPassed,
    hardBlockingSignals: hardBlockingSignals,
    visualSmokePassed: visualSmokePassed,
    defaultInteractionPassed: defaultInteractionPassed,
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
    moduleContractReady: moduleContractReady,
    missingSignalCount: missingSignals.length,
    unsupportedSignalCount: unsupportedSignals.length,
    missingSignals: missingSignals.slice(0, 12),
    unsupportedSignals: unsupportedSignals.slice(0, 12),
    silentPassSignals: silentSignals.slice(),
    hardBlockingSilentSignals: hardBlockingSignals.slice(),
    visualFailCount: visualFailReasons.length,
    visualFailReasons: visualFailReasons.slice(0, 12),
    visualSmokePassed: visualSmokePassed,
    visualSmoke: (result.report && result.report.visualSmoke) || result.visualSmoke || null,
    defaultInteractionRequired: result.defaultInteractionRequired === true,
    defaultInteractionPassed: defaultInteractionPassed === undefined ? null : defaultInteractionPassed,
    defaultInteractionReason: result.defaultInteractionReason || '',
    defaultInteractionExpectedPhases: result.defaultInteractionExpectedPhases || [],
    defaultInteractionPhaseBefore: result.defaultInteractionPhaseBefore || '',
    defaultInteractionPhaseAfter: result.defaultInteractionPhaseAfter || '',
    defaultInteractionCompletedBefore: result.defaultInteractionCompletedBefore,
    defaultInteractionCompletedAfter: result.defaultInteractionCompletedAfter,
    defaultInteractionConsole: result.defaultInteractionConsole || [],
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
  fs.writeFileSync(path.join(buildDir, 'index.html'), ctx.htmlOutput);

  return runCUAVerification(buildDir, ctx.blueprint, ctx.taskId, function(msg) {
    ctx.addLog(stageName, msg);
  }).then(function(result) {
    return runDefaultInteractionProbe(ctx, buildDir, { stageName: stageName }).then(function(defaultProbe) {
      return Object.assign({}, result || {}, defaultProbe || {});
    });
  }).then(function(result) {
    try { fs.rmSync(buildDir, { recursive: true, force: true }); } catch(e) {}

    var summary = summarizeRuntimeContractResult(result);
    summary.durationMs = Date.now() - startTime;
    summary.rounds = 1;

    if (summary.needsEscalation) {
      ctx.addLog(stageName,
        'Escalation required: ' + summary.escalationReasons.join(', ') +
        ' | plan=' + (summary.planCoverage || 'n/a') +
        ' signal=' + (summary.signalCoverage || 'n/a') +
        (summary.defaultInteractionPassed === false ? ' defaultInteraction=' + summary.defaultInteractionReason : ''));
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
  summarizeRuntimeContractResult: summarizeRuntimeContractResult,
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
  runDefaultInteractionProbe: runDefaultInteractionProbe,
  getInteractivePhaseIds: getInteractivePhaseIds,
};
