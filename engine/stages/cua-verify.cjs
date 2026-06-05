// Source: engine/stages/cua-verify.cjs
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
var { normalizeFingerprint } = require('../metrics.cjs');
var runtimeContractStage;
try { runtimeContractStage = require('./runtime-contract.cjs'); } catch(e) { runtimeContractStage = null; }
var archiveWriter;
try { archiveWriter = require('../archive-writer.cjs'); } catch(e) { archiveWriter = { writeSilentPass: function() {} }; }

/**
 * Build structured diagnosis when CUA is stuck (no phase progress).
 * Analyzes: what phase is stuck, what issues were reported, what the likely root cause is.
 */
function _buildStuckDiagnosis(cuaResult, stuckAtPhase, issueCategory, noProgressRounds, blueprint, consolePhaseCoverage) {
  var specs = blueprint.specs || [];
  var totalPhases = specs.length;
  var completedPhases = consolePhaseCoverage || [];
  var issues = cuaResult.issues || [];

  var stuckPhaseId = 'unknown';
  var nextPhaseId = 'unknown';
  if (completedPhases.length > 0 && completedPhases.length < totalPhases) {
    stuckPhaseId = completedPhases[completedPhases.length - 1];
    for (var i = 0; i < specs.length; i++) {
      if (specs[i].phaseId === stuckPhaseId && i + 1 < specs.length) {
        nextPhaseId = specs[i + 1].phaseId;
        break;
      }
    }
  } else if (completedPhases.length === 0 && totalPhases > 0) {
    stuckPhaseId = '(none completed)';
    nextPhaseId = specs[0].phaseId;
  }

  var rootCause = 'unknown';
  var issueTexts = issues.map(function(i) { return typeof i === 'string' ? i : (i.message || i.text || ''); });
  var allIssueText = issueTexts.join(' ').toLowerCase();

  var VISUAL_FREEZE_PHRASES = [
    'visual frozen', 'visual-freeze', 'visually frozen', 'visually stuck',
    'virtually identical', 'no meaningful visual change', 'no phase progression',
    'essentially unchanged', 'positions .* unchanged', 'no animation', 'no movement',
    'game is visually stuck', 'frozen despite running', 'screenshot sharing',
  ];
  var hasVisualFreezePhrase = VISUAL_FREEZE_PHRASES.some(function(p) {
    return p.indexOf('.*') >= 0 ? new RegExp(p).test(allIssueText) : allIssueText.indexOf(p) >= 0;
  }) || (allIssueText.indexOf('static') >= 0 && allIssueText.indexOf('screen') >= 0);

  var noPhasesCompleted = (completedPhases.length === 0) || (stuckAtPhase != null && stuckAtPhase <= 0);

  var hasNullPropertyError = /cannot set propert(?:y|ies) of null|cannot read propert(?:y|ies) of null|cannot set propert(?:y|ies) of undefined|cannot read propert(?:y|ies) of undefined/.test(allIssueText);
  var hasTypeErrorLabel = allIssueText.indexOf('typeerror') >= 0 || allIssueText.indexOf('uncaught') >= 0;
  if (noPhasesCompleted && noProgressRounds >= 2) {
    rootCause = 'codegen_init_failure';
  } else if (hasNullPropertyError) {
    rootCause = 'null_property_crash';
  } else if (hasTypeErrorLabel) {
    rootCause = 'runtime_error';
  } else if (hasVisualFreezePhrase) {
    rootCause = completedPhases.length > 0 ? 'phase_transition_broken' : 'visual_freeze';
  } else if (allIssueText.indexOf('variable') >= 0 && (allIssueText.indexOf('stagnation') >= 0 || allIssueText.indexOf('initial values') >= 0 || allIssueText.indexOf('remain') >= 0)) {
    rootCause = 'variable_stagnation';
  } else if (allIssueText.indexOf('solid color') >= 0 || allIssueText.indexOf('black screen') >= 0 || allIssueText.indexOf('blank') >= 0) {
    rootCause = 'rendering_failure';
  } else if (allIssueText.indexOf('not respond') >= 0 || allIssueText.indexOf('no reaction') >= 0 || allIssueText.indexOf('click') >= 0 && allIssueText.indexOf('nothing') >= 0) {
    rootCause = 'interaction_dead';
  } else if (allIssueText.indexOf('spec-phase-skipped') >= 0) {
    rootCause = 'spec_phase_skipped';
  } else if (allIssueText.indexOf('trigger') >= 0 || allIssueText.indexOf('condition') >= 0 || allIssueText.indexOf('transition') >= 0) {
    rootCause = 'phase_transition_broken';
  } else if (allIssueText.indexOf('null') >= 0 || allIssueText.indexOf('error') >= 0 || allIssueText.indexOf('exception') >= 0) {
    rootCause = 'runtime_error';
  } else if (allIssueText.indexOf('autoplay-zero-steps') >= 0) {
    rootCause = 'autoplay_zero_steps';
  } else if (allIssueText.indexOf('autoplay') >= 0 || allIssueText.indexOf('idle') >= 0) {
    rootCause = 'autoplay_or_idle';
  } else if (allIssueText.indexOf('batch') >= 0 && allIssueText.indexOf('completion') >= 0) {
    rootCause = 'batch_phase_skip';
  } else if (issueCategory) {
    rootCause = issueCategory;
  }

  var transitionContext = '';
  if (nextPhaseId !== 'unknown') {
    for (var j = 0; j < specs.length; j++) {
      if (specs[j].phaseId === nextPhaseId) {
        var nextSpec = specs[j];
        transitionContext = 'Next phase "' + nextPhaseId + '" requires: ';
        if (nextSpec.requiredInteractions && nextSpec.requiredInteractions.length > 0) {
          transitionContext += 'interactions=[' + nextSpec.requiredInteractions.join(', ') + '] ';
        }
        if (nextSpec.triggerNext && nextSpec.triggerNext.condition) {
          transitionContext += 'trigger="' + nextSpec.triggerNext.condition + '"';
        }
        break;
      }
    }
  }

  var summary = 'Stuck at phase ' + stuckPhaseId + ' → ' + nextPhaseId + ', root cause: ' + rootCause + ' (' + noProgressRounds + ' rounds)';

  var rootCauseAdvice = {
    visual_freeze: 'Game screen is visually static despite phases completing. Phases are completing too fast (batch-firing) so CUA sees no visual change between screenshots.\n' +
      '⛔ CRITICAL: Do NOT create AutoPlayForceAdvance or any function that bypasses the skeleton 20f gate.\n' +
      '⛔ Do NOT reduce _autoInteractTimer threshold (must stay >= 3f).\n' +
      '⛔ Do NOT reduce the safety net threshold (must stay >= 50f).\n' +
      '⛔ Do NOT set ruleTriggered[] outside of CheckEventRules phase gate blocks.\n' +
      'Fix: (1) Each phase transition MUST move/show/hide entities via transform.position. (2) Update UI text (gold, score, progress). (3) The 20f autoPlay gate ensures CUA has time to capture screenshots — do NOT bypass it. (4) Each phase should PlaceObj/HideObj at least 2 entities to create visible change.',
    variable_stagnation: 'All gameplay variables (gold, score, count) stayed at initial values. Phase transitions are empty shells without real game logic. Fix: (1) Each phase must UPDATE game variables (gold += reward, score++). (2) Use variables in UI display. (3) Phase transition conditions should depend on these variables, not just phaseTimer.',
    null_property_crash: 'Runtime crashed with "Cannot set/read properties of null". In Luna this is almost always: (a) chained `new GameObject(...).AddComponent<Text>()` (link: AddComponent returns null if the GameObject was built without RectTransform — split into `new GameObject(name, typeof(RectTransform), typeof(Text))` then `GetComponent<Text>()`), (b) `GameObject.Find("X")` returned null and you did not null-check, (c) `Resources.Load<Font>` returned null and you assigned it to `.font` without guarding. The whole Update loop halts after the throw, so downstream phases look "stuck" but the root cause is the initial crash. Fix the first TypeError, not the apparent stuck phase.',
    batch_phase_skip: 'Multiple phases completed in one poll interval — phases are timer-skipping without gameplay. Fix: ensure each phase has a minimum 20s duration gate and performs real gameplay actions during that time.',
    rendering_failure: 'Objects are not visible. Check: (1) SetActive(true) is called, (2) objects are positioned within camera view, (3) no Z-fighting or off-screen placement.',
    interaction_dead: 'User interactions have no effect. Check: (1) colliders exist on interactive objects, (2) raycast/click handlers are wired up, (3) interaction zone is large enough.',
    phase_transition_broken: 'Phase transition condition never becomes true. Check: (1) the trigger condition variable is actually modified by gameplay, (2) AddCompletedPhase is called with correct phaseId, (3) no early return before the transition check.',
    runtime_error: 'Runtime errors prevent execution. Check: (1) GameObject.Find returns null for missing objects, (2) array index out of bounds, (3) division by zero.',
    autoplay_or_idle: 'Game progresses without user input. Check: (1) phase transitions require playerMustAct=true, (2) timer-only transitions should not exist, (3) autoAllowed=false phases must wait for user action.',
    autoplay_zero_steps: 'Observe-mode/autoPlay run completed phases by TIMER alone — no OnAutoPlayArrive calls fired for the listed phases.\n' +
      '⛔ DO NOT disable autoplay (do NOT set playerMustAct=true / autoAllowed=false). Observe-mode REQUIRES autoplay to be enabled by design.\n' +
      '⛔ DO NOT reduce phaseTimer/safety-net thresholds — that masks the bug.\n' +
      'Root cause: the listed phases are advancing solely because the 50f safety-net timer expired, not because game logic produced an OnAutoPlayArrive event.\n' +
      'Fix: For EACH listed phase, implement an autoPlay tap target and OnAutoPlayArrive(target) handler that performs the same gameplay action a real player would (collect resource, attack enemy, deliver item, click button). The skeleton calls OnAutoPlayArrive() when the autoPlay driver "moves" the player to a target; if your phase has no target or the handler is empty, autoPlayStepsThisPhase stays 0 and this signal fires.\n' +
      'Verify: After your fix, each listed phase must produce autoPlayStepsThisPhase > 0 in __gameState — i.e. OnAutoPlayArrive must be called at least once before the phase completes.',
    spec_phase_skipped: 'CUA reports [spec-phase-skipped]: the blueprint spec phases were never triggered by the game. The AddCompletedPhase() calls for one or more phases are either missing, gated behind a condition that never becomes true, or using the wrong phaseId string. Fix: (1) Verify every spec phase has a corresponding AddCompletedPhase("exact-phase-id") call. (2) Confirm the trigger condition for the blocked phase is actually evaluated each Update tick. (3) Check that phaseId strings match EXACTLY — see expected IDs below. (4) Ensure the phase gate (e.g. currentPhase == PhaseN) is not short-circuited by an early return.',
  };

  var phaseIdMismatchNote = '';
  if (completedPhases.length > 0 && totalPhases > 0) {
    var specIds = specs.map(function(s) { return s.phaseId; });
    var hasMatch = completedPhases.some(function(cp) { return specIds.indexOf(cp) >= 0; });
    if (!hasMatch) {
      phaseIdMismatchNote = '\n⛔ PHASE ID MISMATCH: Your code uses AddCompletedPhase("' + completedPhases[0] + '") but CUA expects these EXACT IDs:\n';
      for (var pi = 0; pi < specs.length; pi++) {
        phaseIdMismatchNote += '  - AddCompletedPhase("' + specs[pi].phaseId + '")  // ' + (specs[pi].name || 'phase ' + pi) + '\n';
      }
      phaseIdMismatchNote += 'Fix: Replace ALL semantic phase names in AddCompletedPhase() and currentPhaseName with the exact IDs above.\n';
      if (rootCause === 'variable_stagnation' || rootCause === 'unknown') {
        rootCause = 'phase_id_mismatch';
      }
    }
  } else if (completedPhases.length === 0 && totalPhases > 0) {
    phaseIdMismatchNote = '\nExpected phase IDs (use these exact strings in AddCompletedPhase):\n';
    for (var qi = 0; qi < specs.length; qi++) {
      phaseIdMismatchNote += '  - "' + specs[qi].phaseId + '"  // ' + (specs[qi].name || 'phase ' + qi) + '\n';
    }
  }

  var detail = '=== CUA STUCK DIAGNOSIS (round ' + noProgressRounds + ') ===\n' +
    'Completed phases: [' + completedPhases.join(' → ') + '] (' + completedPhases.length + '/' + totalPhases + ')\n' +
    'Stuck at: ' + stuckPhaseId + ' → cannot reach: ' + nextPhaseId + '\n' +
    'Root cause: ' + rootCause + '\n' +
    (transitionContext ? transitionContext + '\n' : '') +
    'CUA issues: ' + issueTexts.slice(0, 3).join('; ') + '\n' +
    phaseIdMismatchNote +
    '\nACTION REQUIRED: ' + (rootCauseAdvice[rootCause] || 'Investigate why phase "' + nextPhaseId + '" is never reached. The transition condition or interaction handler is likely broken.') + '\n' +
    'IMPORTANT: Focus your fix ONLY on the transition from "' + stuckPhaseId + '" to "' + nextPhaseId + '". Do NOT rewrite phases that already work.';

  return { summary: summary, detail: detail, rootCause: rootCause, stuckPhase: stuckPhaseId, nextPhase: nextPhaseId };
}

var MAX_CUA_ROUNDS = 5;
function _clampEnvMs(envName, defaultMs, minMs, maxMs) {
  var raw = process.env[envName];
  if (!raw) return defaultMs;
  var parsed = parseInt(raw, 10);
  if (!isFinite(parsed) || parsed <= 0) {
    console.warn('[cua-verify] ' + envName + '=' + raw + ' 不是合法整数, 用默认 ' + defaultMs + 'ms');
    return defaultMs;
  }
  if (parsed < minMs) {
    console.warn('[cua-verify] ' + envName + '=' + parsed + ' < ' + minMs + ' 下限, 夹紧');
    return minMs;
  }
  if (parsed > maxMs) {
    console.warn('[cua-verify] ' + envName + '=' + parsed + ' > ' + maxMs + ' 上限, 夹紧');
    return maxMs;
  }
  return parsed;
}
var MAX_CUA_TOTAL_MS = _clampEnvMs('CUA_TOTAL_TIMEOUT_MS', 75 * 60 * 1000, 30 * 60 * 1000, 120 * 60 * 1000);
var RECODE_BUFFER_MS = 12 * 60 * 1000;
if (process.env.RECODE_BUFFER_MS) {
  console.warn('[cua-verify] 忽略 RECODE_BUFFER_MS env(' + process.env.RECODE_BUFFER_MS + '), 使用硬编 12min — 请从 .env 删除该变量');
}
console.log('[cua-verify] MAX_CUA_TOTAL_MS=' + Math.round(MAX_CUA_TOTAL_MS/60000) + 'min, RECODE_BUFFER_MS=' + Math.round(RECODE_BUFFER_MS/60000) + 'min, pre-recode threshold=' + Math.round((MAX_CUA_TOTAL_MS-RECODE_BUFFER_MS)/60000) + 'min');
var NO_PROGRESS_EXIT_ROUNDS = 3;
var SAME_ISSUE_REGEN_THRESHOLD = 3;
var LOW_COVERAGE_MIN_PHASES = 3;
var LOW_COVERAGE_RATIO = 0.5;

function detectLowCoverageSignal(cuaResult, totalPhases) {
  if (totalPhases < LOW_COVERAGE_MIN_PHASES) return null;
  var phaseCov = helpers.extractPhaseCoverage(cuaResult) || {};
  var consoleCov = helpers.extractPhaseFromConsole(
    (cuaResult.report && cuaResult.report.diagnostics && cuaResult.report.diagnostics.consoleMessages) || []
  );
  var completedCount = Math.max(phaseCov.completed || 0, consoleCov.length || 0);
  if (completedCount < Math.ceil(totalPhases * LOW_COVERAGE_RATIO)) {
    return 'low-phase-coverage-' + completedCount + '/' + totalPhases;
  }
  return null;
}

function isFingerprintCircuitBreakerExempt(fp) {
  var text = String(fp || '').toLowerCase();
  if (!text) return false;
  if (text.indexOf('spec-phase-skipped') >= 0) return true;
  if (text.indexOf('visual-freeze') >= 0) return true;
  if (text.indexOf('visual freeze') >= 0) return true;
  if (text.indexOf('visual_freeze') >= 0) return true;
  if (text.indexOf('screenshot-timing') >= 0) return true;
  if (text.indexOf('screenshot') >= 0 && text.indexOf('sharing') >= 0) return true;
  return false;
}

function detectObservationProtocolFailure(cuaResult) {
  var report = cuaResult && cuaResult.report || {};
  var pre = report.preContamination;
  var issues = (cuaResult && cuaResult.issues || []).map(function(issue) {
    return typeof issue === 'string' ? issue : (issue && (issue.message || issue.text) || '');
  });
  var issueText = issues.join(' | ').toLowerCase();
  var hasScreenshotSharing = issueText.indexOf('screenshot sharing') >= 0;
  var hasBatchCompletion = issueText.indexOf('batch completion') >= 0 || issueText.indexOf('batch-completion') >= 0;

  if (pre && pre.fatal) {
    return {
      isFatal: true,
      reason: 'Pre-contamination FATAL: ' + pre.offset + '/' + (pre.total || '?') + ' spec phases completed before observe window opened',
      detail: (pre.phases || []).slice(0, 8).join(', '),
    };
  }

  if ((hasScreenshotSharing && hasBatchCompletion) || (hasBatchCompletion && pre && pre.offset > 0)) {
    return {
      isFatal: false,
      reason: 'Observation protocol warning: multiple spec phases collapsed into a single observe window',
      detail: issues.filter(function(issue) {
        var lower = issue.toLowerCase();
        return lower.indexOf('screenshot sharing') >= 0 || lower.indexOf('batch completion') >= 0 || lower.indexOf('pre-contamination') >= 0;
      }).slice(0, 3).join(' | '),
    };
  }

  return null;
}

function parsePlanCoverageLabel(label) {
  var match = String(label || '').match(/(\d+)\s*\/\s*(\d+)/);
  if (!match) return null;
  return {
    covered: parseInt(match[1], 10) || 0,
    total: parseInt(match[2], 10) || 0,
  };
}

function getIncompletePlanCoverageIssue(planCoverage) {
  var parsed = parsePlanCoverageLabel(planCoverage);
  if (!parsed || parsed.total <= 0 || parsed.covered >= parsed.total) return null;
  return '[plan-coverage] Plan coverage incomplete: ' + parsed.covered + '/' + parsed.total +
    ' — CUA cannot pass on phase/signal coverage alone.';
}

function getRuntimeDefaultInteractionFailure(ctx) {
  var runtimeContract = ctx && ctx.stageResults && ctx.stageResults['runtime-contract'];
  if (!runtimeContract || runtimeContract.defaultInteractionPassed !== false) return null;
  return {
    reason: runtimeContract.defaultInteractionReason || 'default-interaction-failed',
    phaseBefore: runtimeContract.defaultInteractionPhaseBefore || '',
    phaseAfter: runtimeContract.defaultInteractionPhaseAfter || '',
    completedBefore: runtimeContract.defaultInteractionCompletedBefore,
    completedAfter: runtimeContract.defaultInteractionCompletedAfter,
  };
}

module.exports = {
  name: 'cua-verify',
  canRetry: false,
  assertBefore: function(ctx) {
    if (!ctx.htmlOutput) throw new Error('No HTML output from compile stage');
    if (ctx.htmlOutput.length < 10240) throw new Error('HTML output too small (' + ctx.htmlOutput.length + ' bytes) — likely empty build');
  },
  canSkip: function(ctx) {
    var runtimeContract = ctx && ctx.stageResults && ctx.stageResults['runtime-contract'];
    if (runtimeContract && runtimeContract.defaultInteractionPassed === false) {
      ctx.addLog('cua-verify', 'Runtime contract default preview interaction failed — heavy CUA cannot be skipped');
      return false;
    }
    if (runtimeContract && runtimeContract.needsEscalation === false) {
      ctx.stageResults['cua-verify'] = {
        passed: true,
        skipped: true,
        skippedByRuntimeContract: true,
        rounds: 0,
        durationMs: 0,
        reason: 'runtime-contract-passed',
        planCoverage: runtimeContract.planCoverage || null,
        signalCoverage: runtimeContract.signalCoverage || null,
        signalValidationPassed: runtimeContract.signalValidationPassed !== false,
        missingSignalCount: runtimeContract.missingSignalCount || 0,
        unsupportedSignalCount: runtimeContract.unsupportedSignalCount || 0,
        silentPassSignals: runtimeContract.silentPassSignals || [],
        totalActions: runtimeContract.totalActions !== undefined ? runtimeContract.totalActions : null,
      };
      ctx.addLog('cua-verify', 'Skipping heavy CUA — runtime contract already passed');
      return true;
    }
    if (process.env.SKIP_CUA === 'true') {
      console.warn('[CUA-GATE] ⚠️  SKIP_CUA=true — CUA hard gate DISABLED. Set SKIP_CUA= to re-enable.');
      ctx.addLog('cua-verify', 'WARNING: CUA skipped via SKIP_CUA env — hard gate disabled');
    }
    return process.env.SKIP_CUA === 'true';
  },
  execute: function(ctx) {
    ctx.addLog('cua-verify', 'Starting CUA verification...');
    var expectedPlanSteps = (ctx.blueprint && ctx.blueprint.plans && ctx.blueprint.plans.cuaPlan && ctx.blueprint.plans.cuaPlan.steps || []).length;
    if (expectedPlanSteps > 0) {
      ctx.addLog('cua-verify', 'Module-aware CUA plan active: ' + expectedPlanSteps + ' steps');
      ctx.stageResults['cua-verify'] = Object.assign({}, ctx.stageResults['cua-verify'] || {}, {
        expectedPlanSteps: expectedPlanSteps
      });
    }
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
    var _lastNormalizedFp = null;
    var _fpRepeatCount = 1;
    var _maxFpRepeat = 1;
    var FP_REPEAT_ENHANCED_AT = 2;
    var FP_REPEAT_FATAL_AT = 3;
    var _enhancedDiagInjected = false;
    var _codeAtFpStreakStart = null;
    var _visualFreezeRegenAttempted = false;

    var loop = createFixLoop({
      name: 'cua-verify',
      maxRounds: MAX_CUA_ROUNDS,
      onExhausted: 'throw',
      beforeRound: function(ctx, round) {
        ctx.reportStatus('processing', { message: '[Linux] CUA verifying... (round ' + round + '/' + MAX_CUA_ROUNDS + ')', previewUrl: ctx.previewUrl });
      },
      attempt: function(ctx, round) {
        var elapsed = Date.now() - cuaStartTime;
        if (elapsed > MAX_CUA_TOTAL_MS - RECODE_BUFFER_MS) {
          throw new Error('CUA total time limit exceeded (' + Math.round(elapsed / 60000) + 'min > ' + Math.round((MAX_CUA_TOTAL_MS - RECODE_BUFFER_MS) / 60000) + 'min pre-recode guard)');
        }
        var cuaBuildDir = path.join(require('os').tmpdir(), 'linux-cua-' + ctx.taskId + '-r' + round);
        fs.mkdirSync(cuaBuildDir, { recursive: true });
        fs.writeFileSync(path.join(cuaBuildDir, 'iframe.html'), lastHtmlData);

        return runCUAVerification(cuaBuildDir, ctx.blueprint, ctx.taskId, function(msg) { ctx.addLog('cua-verify', msg); })
          .catch(function(cuaErr) {
            ctx.addLog('cua-verify', 'CUA error: ' + cuaErr.message);
            try { fs.rmSync(cuaBuildDir, { recursive: true, force: true }); } catch(e) {}

            if (cuaErr && /MODEL_FATAL/i.test(cuaErr.message || '')) {
              throw cuaErr;
            }

            if (lastIssueCategory === 'crash') { consecutiveSameIssue++; }
            else { consecutiveSameIssue = 1; lastIssueCategory = 'crash'; }

            if (consecutiveSameIssue >= 3) {
              throw new Error('CUA crashed ' + consecutiveSameIssue + ' consecutive rounds');
            }
            return null;
          })
          .then(function(cuaResult) {
            if (!cuaResult) return { done: false };
            try { fs.rmSync(cuaBuildDir, { recursive: true, force: true }); } catch(e) {}

            var signalCoverage = cuaResult.signalCoverage || (cuaResult.report && cuaResult.report.signalCoverage) || null;
            var planCoverage = cuaResult.planCoverage || (cuaResult.report && cuaResult.report.planCoverage) || null;
            var signalValidationPassed = cuaResult.signalValidationPassed;
            if (signalValidationPassed === undefined && cuaResult.report) {
              signalValidationPassed = cuaResult.report.signalValidationPassed;
            }
            var missingSignals = cuaResult.missingSignals || (cuaResult.report && cuaResult.report.missingSignals) || [];
            var unsupportedSignals = cuaResult.unsupportedSignals || (cuaResult.report && cuaResult.report.unsupportedSignals) || [];

            ctx.stageResults['cua-verify'] = Object.assign({}, ctx.stageResults['cua-verify'] || {}, {
              round: round,
              planCoverage: planCoverage,
              signalCoverage: signalCoverage,
              signalValidationPassed: signalValidationPassed !== false,
              missingSignalCount: missingSignals.length,
              unsupportedSignalCount: unsupportedSignals.length,
              missingSignals: missingSignals.slice(0, 12),
              unsupportedSignals: unsupportedSignals.slice(0, 12),
            });
            if (signalCoverage || planCoverage) {
              ctx.addLog('cua-verify', 'Plan/signal coverage: plan=' + (planCoverage || 'n/a') + ', signal=' + (signalCoverage || 'n/a'));
            }
            if (signalValidationPassed === false && missingSignals.length > 0) {
              ctx.addLog('cua-verify', 'Signal validation failed: ' + missingSignals.slice(0, 8).join(', '));
            }

            var incompletePlanIssue = getIncompletePlanCoverageIssue(planCoverage);
            if (incompletePlanIssue && cuaResult.passed) {
              cuaResult.passed = false;
              cuaResult.issues = (cuaResult.issues || []).concat([incompletePlanIssue]);
              ctx.addLog('cua-verify', 'CUA passed=true overridden by plan coverage gate: ' + incompletePlanIssue);
            }

            if (cuaResult.quickTestDetail && cuaResult.quickTestDetail.solidColor) {
              cuaResult.issues = (cuaResult.issues || []).concat(['[quick-test] Solid color screen — rendering broken or GPU unavailable, objects not visible']);
              cuaResult.passed = false;
              ctx.addLog('cua-verify', 'Solid color screen detected — FAIL (was previously auto-passed, now hard-fail)');
            }

            if (cuaResult.skipped && !cuaResult.passed) {
              var skipReason = (cuaResult.issues && cuaResult.issues[0]) || cuaResult.error || 'CUA infra prerequisite missing';
              ctx.addLog('cua-verify', 'CUA SKIPPED (infra) — will retry: ' + skipReason);
              throw new Error('CUA infra skip: ' + skipReason);
            }

            var runtimeDefaultFailure = getRuntimeDefaultInteractionFailure(ctx);
            if (runtimeDefaultFailure && cuaResult.passed) {
              cuaResult.passed = false;
              var defaultIssue = '[default-interaction-failed] Raw public preview did not advance after user actions'
                + (runtimeDefaultFailure.phaseBefore ? ' at phase ' + runtimeDefaultFailure.phaseBefore : '')
                + ' (' + runtimeDefaultFailure.reason + '). Observe/autoplay CUA pass is not sufficient.';
              cuaResult.issues = (cuaResult.issues || []).concat([defaultIssue]);
              ctx.addLog('cua-verify', 'CUA passed=true overridden by runtime default interaction probe: ' + defaultIssue);
              ctx.stageResults['cua-verify'] = Object.assign({}, ctx.stageResults['cua-verify'] || {}, {
                defaultInteractionBlocked: true,
                defaultInteractionReason: runtimeDefaultFailure.reason,
                defaultInteractionPhaseBefore: runtimeDefaultFailure.phaseBefore,
                defaultInteractionPhaseAfter: runtimeDefaultFailure.phaseAfter,
              });
            }

            if (cuaResult.passed) {
              var silentSignals = cuaResult.silentPassSignals || [];
              var cuaIsAutoPlayMode = cuaResult.isAutoPlayMode === true;
              var workerHardBlockers = Array.isArray(cuaResult.hardBlockingSilentSignals)
                ? cuaResult.hardBlockingSilentSignals.slice()
                : null;
              var hardBlockers = workerHardBlockers || silentSignals.filter(function(s) {
                if (s.indexOf('uniform-timing') === 0 && cuaIsAutoPlayMode) return false;
                return s.indexOf('uniform-timing') === 0
                    || s.indexOf('phase-order-violation') === 0
                    || s.indexOf('all-vars-zero') === 0
                    || s.indexOf('batch-completion') === 0
                    || s.indexOf('no-phase-timestamps') === 0
                    || s.indexOf('autoplay-zero-steps') === 0;
              });

              if (hardBlockers.length === 0) {
                var totalPhases = (ctx.blueprint && ctx.blueprint.specs && ctx.blueprint.specs.length) || 0;
                var lowCovSig = detectLowCoverageSignal(cuaResult, totalPhases);
                if (lowCovSig) {
                  silentSignals.push(lowCovSig);
                  hardBlockers.push(lowCovSig);
                  ctx.addLog('cua-verify',
                    '🚨 silent-pass L7: ' + lowCovSig +
                    ' — passed=true but coverage below ' +
                    Math.round(LOW_COVERAGE_RATIO * 100) + '% floor; VLM false-positive');
                }
              }

              if (hardBlockers.length > 0) {
                ctx.addLog('cua-verify', '🚨 CUA passed=true overridden by silent-pass hard-block: ' + hardBlockers.join(', '));
                cuaResult.passed = false;
                cuaResult.issues = (cuaResult.issues || []).concat(hardBlockers.map(function(s) {
                  return '[silent-pass-block] ' + s + ' — game logic did not run correctly despite passed=true';
                }));
                try {
                  archiveWriter.writeSilentPass(ctx, cuaResult, { round: round, verdict: 'hard-block' });
                } catch(awErr) { ctx.addLog('cua-verify', 'archive-writer hard-block failed: ' + awErr.message); }
              } else {
                ctx.htmlOutput = lastHtmlData;
                ctx.csCode = lastCsCode;
                if (silentSignals.length > 0) {
                  ctx.addLog('cua-verify', 'CUA PASSED (⚠️ silent-pass signals: ' + silentSignals.join(', ') + ')');
                  try {
                    archiveWriter.writeSilentPass(ctx, cuaResult, { round: round, verdict: 'soft-warn' });
                  } catch(awErr) { ctx.addLog('cua-verify', 'archive-writer soft-warn failed: ' + awErr.message); }
                } else {
                  ctx.addLog('cua-verify', 'CUA PASSED');
                }
                ctx.reportStatus('cua_passed', {
                  message: '[Linux] CUA passed (round ' + round + ')!',
                  previewUrl: ctx.previewUrl,
                  qualityData: { cuaResult: { passed: true, round: round }, cuaRetries: round },
                });
                return { done: true, result: {
                  passed: true,
                  round: round,
                  totalActions: cuaResult.totalActions !== undefined ? cuaResult.totalActions : -1,
                  silentPassSignals: silentSignals,
                  planCoverage: planCoverage,
                  signalCoverage: signalCoverage,
                  signalValidationPassed: signalValidationPassed !== false,
                  missingSignalCount: missingSignals.length,
                  unsupportedSignalCount: unsupportedSignals.length,
                } };
              }
            }

            if (cuaResult.report && (cuaResult.report.cuaApiUnreachable || cuaResult.report.infraFailure)) {
              throw new Error('CUA API unreachable');
            }

            ctx.addLog('cua-verify', 'FAILED: ' + (cuaResult.issues || []).length + ' issues');

            try {
              var _preC = cuaResult.report && cuaResult.report.preContamination;
              if (_preC && _preC.phases && _preC.phases.length > 0) {
                ctx.addLog('cua-verify',
                  'Pre-contamination offset: ' + _preC.offset + ' phase(s) pre-fired ' +
                  '(ratio=' + Math.round((_preC.ratio || 0) * 100) + '%' +
                  (_preC.fatal ? ', FATAL' : ', non-fatal — deferring to phase-coverage/silent-pass') + '): [' +
                  (_preC.phases || []).slice(0, 5).join(', ') + ']');
              }
            } catch (_preCErr) {}

            var observationProtocolFailure = detectObservationProtocolFailure(cuaResult);
            if (observationProtocolFailure) {
              ctx.addLog('cua-verify', observationProtocolFailure.reason + (observationProtocolFailure.detail ? ' — ' + observationProtocolFailure.detail : ''));
              if (observationProtocolFailure.isFatal) {
                throw new Error(observationProtocolFailure.reason + (observationProtocolFailure.detail ? ': ' + observationProtocolFailure.detail : ''));
              }
            }

            var _rawFp = (cuaResult.issues || []).slice(0, 3).map(function(i) {
              return typeof i === 'string' ? i : (i && (i.message || i.text) || '');
            }).join(' | ');
            var _currentFp = _rawFp ? normalizeFingerprint(_rawFp) : null;
            if (_currentFp) {
              if (_currentFp === _lastNormalizedFp) {
                _fpRepeatCount++;
                if (_fpRepeatCount > _maxFpRepeat) _maxFpRepeat = _fpRepeatCount;
              } else {
                _fpRepeatCount = 1;
                _lastNormalizedFp = _currentFp;
                _enhancedDiagInjected = false;
                _codeAtFpStreakStart = lastCsCode;
              }
              var isExemptFp = isFingerprintCircuitBreakerExempt(_currentFp);
              var exemptLabel = _currentFp.indexOf('spec-phase-skipped') >= 0
                ? '[spec-phase-skipped]'
                : (_currentFp.indexOf('visual-freeze') >= 0 || _currentFp.indexOf('visual freeze') >= 0 || _currentFp.indexOf('visual_freeze') >= 0
                  ? '[visual-freeze]'
                  : ((_currentFp.indexOf('screenshot') >= 0 && _currentFp.indexOf('sharing') >= 0)
                    ? '[screenshot-sharing]'
                    : '[exempt]'));

              if (_fpRepeatCount >= FP_REPEAT_FATAL_AT && !isExemptFp) {
                ctx.addLog('cua-verify',
                  '🚨 Fingerprint repeat FATAL: "' + _currentFp.slice(0, 80) +
                  '" for ' + _fpRepeatCount + ' consecutive rounds — Claude fix ineffective even after enhanced diagnostic');
                ctx.stageResults = ctx.stageResults || {};
                ctx.stageResults['cua-verify'] = Object.assign({}, ctx.stageResults['cua-verify'] || {}, {
                  round: round,
                  maxFingerprintRepeats: _maxFpRepeat,
                  circuitBreakerTriggered: true,
                  lastFingerprint: _currentFp,
                  reason: 'fingerprint-repeat-' + _fpRepeatCount,
                });
                throw new Error('Fingerprint repeat FATAL: identical normalized fingerprint "' +
                  _currentFp.slice(0, 100) + '" for ' + _fpRepeatCount +
                  ' consecutive rounds (enhanced diagnostic also failed); Claude fix ineffective');
              } else if (_fpRepeatCount >= FP_REPEAT_ENHANCED_AT && !isExemptFp && !_enhancedDiagInjected) {
                _enhancedDiagInjected = true;
                var _codeChanged = _codeAtFpStreakStart !== null && lastCsCode !== _codeAtFpStreakStart;
                var _diagMsg =
                  '🚨 ENHANCED DIAGNOSTIC — YOUR PREVIOUS FIX DID NOT RESOLVE THE CUA FAILURE.\n' +
                  'Identical normalized error fingerprint repeated for ' + _fpRepeatCount + ' consecutive rounds.\n' +
                  '  Fingerprint: ' + _currentFp.slice(0, 200) + '\n' +
                  '  Code delta: ' + (_codeChanged
                    ? 'the code WAS modified between rounds but the CUA symptom is identical — your edit targeted the wrong location or logic path'
                    : 'the code was NOT modified between rounds — you returned the same code with no effective edits') + '\n\n' +
                  'ACTION REQUIRED: Do not repeat the same edit. Identify a DIFFERENT code path that could produce this symptom ' +
                  '(phase transition conditions, GameObject initial state/position, event handler wiring, or the skeleton scaffolding). ' +
                  'If the next round still reproduces this fingerprint, the pipeline will terminate as FATAL.';
                if (!ctx.blueprint.feedbackHistory) ctx.blueprint.feedbackHistory = [];
                ctx.blueprint.feedbackHistory.push({
                  data: { text: _diagMsg },
                  source: 'cua-fp-enhanced-diagnostic-r' + round,
                  status: 'pending',
                  timestamp: Date.now(),
                });
                ctx.addLog('cua-verify',
                  '⚠️ Fingerprint repeat (' + _fpRepeatCount + ') — enhanced diagnostic injected (code ' +
                  (_codeChanged ? 'changed but symptom persists' : 'unchanged') +
                  '); one more round before FATAL');
              } else if (_fpRepeatCount >= FP_REPEAT_ENHANCED_AT && isExemptFp) {
                ctx.addLog('cua-verify',
                  '⚠️ Fingerprint repeat (' + _fpRepeatCount + ') for ' + exemptLabel + ' — ' +
                  'circuit breaker exempted; deferring to _noProgressRounds escalation');
              }
            }

            var currentIssueCategory = helpers.categorizeIssue(cuaResult);
            var phaseCoverage = helpers.extractPhaseCoverage(cuaResult);
            var currentPhaseCompleted = phaseCoverage ? phaseCoverage.completed : -1;
            var completedPhaseIds = (phaseCoverage && phaseCoverage.phases) || [];

            var consolePhaseCoverage = helpers.extractPhaseFromConsole(
                (cuaResult.report && cuaResult.report.diagnostics && cuaResult.report.diagnostics.consoleMessages) || []
            );
            if (consolePhaseCoverage.length > 0) {
                currentPhaseCompleted = Math.max(currentPhaseCompleted, consolePhaseCoverage.length);
                ctx.addLog('cua-verify', 'Phase progress (instrumented): ' + consolePhaseCoverage.join(' → '));
            }

            if (currentPhaseCompleted >= 0) {
              ctx.addLog('cua-verify', 'Phase coverage: ' + currentPhaseCompleted + ' completed' + (completedPhaseIds.length > 0 ? ' [' + completedPhaseIds.slice(-3).join(' → ') + ']' : ''));
            }

            var isProgressing = currentPhaseCompleted > lastPhaseCompleted && currentPhaseCompleted > 0;

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

            var diagPhases = completedPhaseIds.length > 0 ? completedPhaseIds : consolePhaseCoverage;
            var stuckDiagnosis = _buildStuckDiagnosis(
              cuaResult,
              currentPhaseCompleted,
              currentIssueCategory,
              _noProgressRounds + (isProgressing ? 0 : 1),
              ctx.blueprint,
              diagPhases
            );
            ctx.stageResults = ctx.stageResults || {};
            ctx.stageResults['cua-verify'] = Object.assign({}, ctx.stageResults['cua-verify'] || {}, {
              lastStuckDiagnosis: {
                rootCause: stuckDiagnosis.rootCause,
                stuckPhase: stuckDiagnosis.stuckPhase,
                nextPhase: stuckDiagnosis.nextPhase,
              },
            });

            if (isProgressing) {
              _noProgressRounds = 0;
              _visualFreezeRegenAttempted = false;
            } else {
              _noProgressRounds++;

              ctx.addLog('cua-verify', 'No-progress diagnosis: ' + stuckDiagnosis.summary);
              if (!ctx.blueprint.feedbackHistory) ctx.blueprint.feedbackHistory = [];
              ctx.blueprint.feedbackHistory.push({
                data: { text: stuckDiagnosis.detail },
                source: 'cua-stuck-diagnosis',
                status: 'pending',
                timestamp: Date.now(),
              });

              if ((stuckDiagnosis.rootCause === 'visual_freeze' || stuckDiagnosis.rootCause === 'codegen_init_failure' || stuckDiagnosis.rootCause === 'spec_phase_skipped') && _noProgressRounds >= 2) {
                if (!_visualFreezeRegenAttempted) {
                  ctx.addLog('cua-verify', stuckDiagnosis.rootCause + ': surgical fix insufficient — escalating to full regen before FATAL (' + _noProgressRounds + ' rounds)');
                  consecutiveSameIssue = SAME_ISSUE_REGEN_THRESHOLD;
                  _visualFreezeRegenAttempted = true;
                } else if (stuckDiagnosis.rootCause === 'codegen_init_failure') {
                  throw new Error('Codegen init failure: no phases completed after ' + _noProgressRounds + ' rounds of full regen. ' + stuckDiagnosis.summary);
                } else if (stuckDiagnosis.rootCause === 'spec_phase_skipped') {
                  throw new Error('Spec phase skipped FATAL: blueprint spec phases still not triggered after ' + _noProgressRounds + ' rounds of full regen — AddCompletedPhase calls missing or gated by a condition that never becomes true. ' + stuckDiagnosis.summary);
                } else {
                  if (_noProgressRounds >= 4) {
                    throw new Error('Visual freeze FATAL: ' + _noProgressRounds + ' consecutive rounds — surgical and full-regen both failed. ' + stuckDiagnosis.summary);
                  }
                  ctx.addLog('cua-verify', 'visual_freeze: post-regen round ' + _noProgressRounds + ' — waiting for round 4 minimum before FATAL');
                }
              }

              if (_noProgressRounds >= NO_PROGRESS_EXIT_ROUNDS + 3) {
                throw new Error('No phase progress in ' + _noProgressRounds + ' consecutive rounds. Diagnosis: ' + stuckDiagnosis.summary);
              } else if (_noProgressRounds === NO_PROGRESS_EXIT_ROUNDS) {
                ctx.addLog('cua-verify', 'No progress for ' + _noProgressRounds + ' rounds — escalating to full regen');
                consecutiveSameIssue = SAME_ISSUE_REGEN_THRESHOLD;
              }
            }

            if (consecutiveSameIssue >= SAME_ISSUE_REGEN_THRESHOLD * 2) {
              throw new Error('Same issue "' + currentIssueCategory + '" after ' + consecutiveSameIssue + ' rounds (no progress)');
            }

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

            try {
              var codeReviewer = require('../../worker/code-reviewer.js');
              var cuaIssues = (cuaResult.issues || []).map(function(issueText, idx) {
                return {
                  severity: 'warning',
                  stage: 'cua-verify',
                  description: '[CUA] ' + issueText.slice(0, 200),
                  rule: 'CUA Verification',
                  fix: 'See CUA feedback for details',
                  line: '',
                };
              });
              codeReviewer.recordNewIssues(cuaIssues, ctx.taskId).catch(function() {});
            } catch(e) {}

            var elapsedBeforeRecode = Date.now() - cuaStartTime;
            if (elapsedBeforeRecode > MAX_CUA_TOTAL_MS - RECODE_BUFFER_MS) {
              throw new Error('CUA total time limit exceeded (' + Math.round(elapsedBeforeRecode / 60000) + 'min > ' + Math.round((MAX_CUA_TOTAL_MS - RECODE_BUFFER_MS) / 60000) + 'min pre-recode guard)');
            }

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
              var someHaveLines = structuredIssues.filter(function(i) { return i.line > 0; }).length >= 1;
              if (someHaveLines) {
                cuaFixPromise = patchRecode({
                  taskId: ctx.taskId,
                  currentCode: lastCsCode,
                  extraFiles: lastExtraFiles,
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
                    extraFiles: lastExtraFiles,
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
                extraFiles: lastExtraFiles,
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
              if (recodeResult.extraFiles) {
                for (var efKey in recodeResult.extraFiles) {
                  if (recodeResult.extraFiles.hasOwnProperty(efKey)) {
                    lastExtraFiles[efKey] = recodeResult.extraFiles[efKey];
                  }
                }
              }
              try {
                var __colorSanitizer = require('../../lib/cs-color-sanitizer.cjs');
                var __mainSan = __colorSanitizer.sanitizeColors(lastCsCode);
                if (__mainSan.changed) {
                  lastCsCode = __mainSan.code;
                  ctx.addLog('cua-verify', 'Color255To01 main x' + __mainSan.fixes);
                }
                Object.keys(lastExtraFiles || {}).forEach(function(__name) {
                  var __extraSan = __colorSanitizer.sanitizeColors(lastExtraFiles[__name]);
                  if (__extraSan.changed) {
                    lastExtraFiles[__name] = __extraSan.code;
                    ctx.addLog('cua-verify', 'Color255To01 ' + __name + ' x' + __extraSan.fixes);
                  }
                });
              } catch (_csErr) { /* sanitizer optional */ }
              ctx.reportStatus('building', { message: '[Linux] CUA fix rebuilding... (round ' + (round + 1) + ')' });

              var buildOptions = { visualAssets: helpers.buildVisualAssetsForRequest(ctx) };
              return helpers.buildRequest(buildUrl, '/build', lastCsCode, Object.assign({}, lastExtraFiles), buildOptions)
                .then(function(buildResult) {
                  if (!buildResult.ok) {
                    ctx.addLog('cua-verify', 'Fix rebuild failed: ' + (buildResult.error || ''));
                    return { done: false };
                  }
                  ctx.addLog('cua-verify', 'Fix rebuild OK in ' + buildResult.buildTime + 's');
                  ctx.checkpoint.cuaRound = round;
                  ctx.checkpoint.fixHistory = fixHistory;

                  return helpers.buildRequest(buildUrl, '/build-html', lastCsCode, Object.assign({}, lastExtraFiles), buildOptions)
                    .then(function(newHtml) {
                      lastHtmlData = newHtml;
                      ctx.addLog('cua-verify', 'Fix HTML: ' + (newHtml.length / 1048576).toFixed(1) + 'MB');
                      fs.writeFileSync(path.join(previewDir, 'index.html'), lastHtmlData);
                      if (!runtimeContractStage || typeof runtimeContractStage.runRuntimeContractPass !== 'function') {
                        return { done: false };
                      }

                      ctx.htmlOutput = lastHtmlData;
                      return runtimeContractStage.runRuntimeContractPass(ctx, {
                        stageName: 'cua-verify',
                        reportStatus: false,
                        writeStageResult: true,
                        statusPrefix: '[Linux] Post-fix runtime contract',
                      }).then(function(contractResult) {
                        if (contractResult && contractResult.needsEscalation === false) {
                          ctx.csCode = lastCsCode;
                          ctx.extraFiles = Object.assign({}, lastExtraFiles);
                          ctx.stageResults['cua-verify'] = Object.assign({}, ctx.stageResults['cua-verify'] || {}, {
                            passed: true,
                            skipped: true,
                            skippedByRuntimeContract: true,
                            postFixRuntimeContract: true,
                            round: round,
                            rounds: round,
                            reason: 'runtime-contract-passed-after-fix',
                            planCoverage: contractResult.planCoverage || null,
                            signalCoverage: contractResult.signalCoverage || null,
                            signalValidationPassed: contractResult.signalValidationPassed !== false,
                            missingSignalCount: contractResult.missingSignalCount || 0,
                            unsupportedSignalCount: contractResult.unsupportedSignalCount || 0,
                            missingSignals: (contractResult.missingSignals || []).slice(0, 12),
                            unsupportedSignals: (contractResult.unsupportedSignals || []).slice(0, 12),
                            silentPassSignals: contractResult.silentPassSignals || [],
                            totalActions: contractResult.totalActions !== undefined ? contractResult.totalActions : null,
                          });
                          ctx.addLog('cua-verify', 'Post-fix runtime contract passed — skipping remaining heavy CUA rounds');
                          ctx.reportStatus('cua_passed', {
                            message: '[Linux] Runtime contract passed after fix, heavy CUA skipped',
                            previewUrl: ctx.previewUrl,
                            qualityData: {
                              cuaResult: {
                                passed: true,
                                skippedByRuntimeContract: true,
                                round: round,
                              },
                              cuaRetries: round,
                            },
                          });
                          return {
                            done: true,
                            result: {
                              passed: true,
                              round: round,
                              skippedByRuntimeContract: true,
                              totalActions: contractResult.totalActions !== undefined ? contractResult.totalActions : -1,
                              silentPassSignals: contractResult.silentPassSignals || [],
                              planCoverage: contractResult.planCoverage || null,
                              signalCoverage: contractResult.signalCoverage || null,
                              signalValidationPassed: contractResult.signalValidationPassed !== false,
                              missingSignalCount: contractResult.missingSignalCount || 0,
                              unsupportedSignalCount: contractResult.unsupportedSignalCount || 0,
                            }
                          };
                        }

                        ctx.addLog('cua-verify',
                          'Post-fix runtime contract still needs escalation: ' +
                          ((contractResult && contractResult.escalationReasons && contractResult.escalationReasons.length > 0)
                            ? contractResult.escalationReasons.join(', ')
                            : 'unknown'));
                        return { done: false };
                      }).catch(function(err) {
                        ctx.addLog('cua-verify', 'Post-fix runtime contract recheck failed: ' + err.message);
                        return { done: false };
                      });
                    });
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

  _internals: {
    detectLowCoverageSignal: detectLowCoverageSignal,
    isFingerprintCircuitBreakerExempt: isFingerprintCircuitBreakerExempt,
    detectObservationProtocolFailure: detectObservationProtocolFailure,
    getRuntimeDefaultInteractionFailure: getRuntimeDefaultInteractionFailure,
    buildStuckDiagnosis: _buildStuckDiagnosis,
    LOW_COVERAGE_MIN_PHASES: LOW_COVERAGE_MIN_PHASES,
    LOW_COVERAGE_RATIO: LOW_COVERAGE_RATIO,
  },
};