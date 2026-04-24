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

  // Identify which phase we're stuck at
  var stuckPhaseId = 'unknown';
  var nextPhaseId = 'unknown';
  if (completedPhases.length > 0 && completedPhases.length < totalPhases) {
    stuckPhaseId = completedPhases[completedPhases.length - 1];
    // Find next expected phase from spec order
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

  // Classify the root cause from CUA issues
  var rootCause = 'unknown';
  var issueTexts = issues.map(function(i) { return typeof i === 'string' ? i : (i.message || i.text || ''); });
  var allIssueText = issueTexts.join(' ').toLowerCase();

  // 2026-04-16 (proj_xrbkl1 postmortem): widen visual_freeze keyword set so we actually
  // short-circuit instead of burning 5 CUA rounds. The VLM often phrases a stuck game as
  // "virtually identical", "no meaningful visual change", "positions unchanged", "no
  // phase progression", "visually stuck" — none of which matched the old narrow set.
  // Also fix A || B || C && D precedence with explicit parens.
  var VISUAL_FREEZE_PHRASES = [
    'visual frozen', 'visual-freeze', 'visually frozen', 'visually stuck',
    'virtually identical', 'no meaningful visual change', 'no phase progression',
    'essentially unchanged', 'positions .* unchanged', 'no animation', 'no movement',
    'game is visually stuck', 'frozen despite running',
  ];
  var hasVisualFreezePhrase = VISUAL_FREEZE_PHRASES.some(function(p) {
    return p.indexOf('.*') >= 0 ? new RegExp(p).test(allIssueText) : allIssueText.indexOf(p) >= 0;
  }) || (allIssueText.indexOf('static') >= 0 && allIssueText.indexOf('screen') >= 0);

  // Terminal fallback: if no phases complete across multiple rounds, the game literally
  // never starts — that IS a codegen init failure regardless of issue text wording.
  //
  // FIX (auto-b1675811): The original AND condition required BOTH stuckAtPhase <= 0
  // (from issue-text numeric parse) AND completedPhases.length === 0 (from
  // consolePhaseCoverage). These two sources can disagree: e.g. "[phase-coverage] 1/5"
  // in issue text makes stuckAtPhase=1>0, so the first condition was false and
  // noPhasesCompleted=false even when consolePhaseCoverage=[] (no phases actually
  // completed). This let visual_freeze win over codegen_init_failure, routing to FATAL
  // instead of the retryable CODE path.
  //
  // Changed to OR: if EITHER source indicates no phases completed, treat it as such.
  // consolePhaseCoverage (real instrumented IDs) is more reliable than issue-text parse,
  // so completedPhases.length === 0 is the primary signal.
  var noPhasesCompleted = (completedPhases.length === 0) || (stuckAtPhase != null && stuckAtPhase <= 0);

  // Runtime crashes swamp all other signals. When the WebGL page throws, variables freeze
  // and LLM issue text legitimately mentions "variables remain at initial" — which was
  // previously mis-classified as variable_stagnation. Promote crash detection above
  // variable_stagnation so font-null / TypeError gets its specific advice.
  var hasNullPropertyError = /cannot set propert(?:y|ies) of null|cannot read propert(?:y|ies) of null|cannot set propert(?:y|ies) of undefined|cannot read propert(?:y|ies) of undefined/.test(allIssueText);
  var hasTypeErrorLabel = allIssueText.indexOf('typeerror') >= 0 || allIssueText.indexOf('uncaught') >= 0;
  if (noPhasesCompleted && noProgressRounds >= 2) {
    rootCause = 'codegen_init_failure';
  } else if (hasNullPropertyError) {
    rootCause = 'null_property_crash';
  } else if (hasTypeErrorLabel) {
    rootCause = 'runtime_error';
  } else if (hasVisualFreezePhrase) {
    // FIX (auto-9742d195): When phases have already completed (completedPhases.length > 0)
    // but the game appears visually frozen, the screen is static because the game is
    // waiting for an unmet phase-transition trigger condition — the visual freeze is a
    // downstream symptom, not the root cause. Assigning 'visual_freeze' here would feed
    // Claude incorrect batch-firing advice and trigger the visual_freeze fast-escalation
    // path (FATAL after 3–4 rounds) instead of the appropriate phase_transition_broken
    // advice. Only assign 'visual_freeze' when no phases have completed yet (the whole
    // game is frozen from the start).
    rootCause = completedPhases.length > 0 ? 'phase_transition_broken' : 'visual_freeze';
  } else if (allIssueText.indexOf('variable') >= 0 && (allIssueText.indexOf('stagnation') >= 0 || allIssueText.indexOf('initial values') >= 0 || allIssueText.indexOf('remain') >= 0)) {
    rootCause = 'variable_stagnation';
  } else if (allIssueText.indexOf('solid color') >= 0 || allIssueText.indexOf('black screen') >= 0 || allIssueText.indexOf('blank') >= 0) {
    rootCause = 'rendering_failure';
  } else if (allIssueText.indexOf('not respond') >= 0 || allIssueText.indexOf('no reaction') >= 0 || allIssueText.indexOf('click') >= 0 && allIssueText.indexOf('nothing') >= 0) {
    rootCause = 'interaction_dead';
  } else if (allIssueText.indexOf('spec-phase-skipped') >= 0) {
    // 2026-04-21 (auto-edb29e02): detect [spec-phase-skipped] before the generic
    // phase_transition_broken fallthrough. CUA emits this token when blueprint spec
    // phases were never triggered by the game logic. Without this branch the label
    // resolves to 'unknown', which is not in the fast-escalation guard, wasting up
    // to 7 recode rounds before FATAL.
    rootCause = 'spec_phase_skipped';
  } else if (allIssueText.indexOf('trigger') >= 0 || allIssueText.indexOf('condition') >= 0 || allIssueText.indexOf('transition') >= 0) {
    rootCause = 'phase_transition_broken';
  } else if (allIssueText.indexOf('null') >= 0 || allIssueText.indexOf('error') >= 0 || allIssueText.indexOf('exception') >= 0) {
    rootCause = 'runtime_error';
  } else if (allIssueText.indexOf('autoplay') >= 0 || allIssueText.indexOf('idle') >= 0) {
    rootCause = 'autoplay_or_idle';
  } else if (allIssueText.indexOf('batch') >= 0 && allIssueText.indexOf('completion') >= 0) {
    rootCause = 'batch_phase_skip';
  } else if (issueCategory) {
    rootCause = issueCategory;
  }

  // Build the spec context for the stuck phase transition
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
    spec_phase_skipped: 'CUA reports [spec-phase-skipped]: the blueprint spec phases were never triggered by the game. The AddCompletedPhase() calls for one or more phases are either missing, gated behind a condition that never becomes true, or using the wrong phaseId string. Fix: (1) Verify every spec phase has a corresponding AddCompletedPhase("exact-phase-id") call. (2) Confirm the trigger condition for the blocked phase is actually evaluated each Update tick. (3) Check that phaseId strings match EXACTLY — see expected IDs below. (4) Ensure the phase gate (e.g. currentPhase == PhaseN) is not short-circuited by an early return.',
  };

  // Phase ID mismatch detection: if completedPhases use semantic names but specs use phase_N
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
    // No phases completed — include expected IDs as context
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
// Wall-clock cap: default 75 min, overridable via CUA_TOTAL_TIMEOUT_MS env var.
// 合法范围 [30min, 120min]，超出夹紧并日志告警——避免运维误写 env 导致 silent cutoff。
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
// Pre-recode buffer: 为一轮 recode+rebuild 预留的尾段时间。2026-04-20 观测到
// `63min > 60min pre-recode guard`——.env 里 RECODE_BUFFER_MS=900000(15min) 让合法 63min
// 运行被提前 3min 砍掉。硬编 12min 不再暴露 env override,避免运维改 env 误伤。
// (历史 env 变量 RECODE_BUFFER_MS 若仍在 .env 中,会被忽略并日志提示。)
var RECODE_BUFFER_MS = 12 * 60 * 1000;
if (process.env.RECODE_BUFFER_MS) {
  console.warn('[cua-verify] 忽略 RECODE_BUFFER_MS env(' + process.env.RECODE_BUFFER_MS + '), 使用硬编 12min — 请从 .env 删除该变量');
}
console.log('[cua-verify] MAX_CUA_TOTAL_MS=' + Math.round(MAX_CUA_TOTAL_MS/60000) + 'min, RECODE_BUFFER_MS=' + Math.round(RECODE_BUFFER_MS/60000) + 'min, pre-recode threshold=' + Math.round((MAX_CUA_TOTAL_MS-RECODE_BUFFER_MS)/60000) + 'min');
var NO_PROGRESS_EXIT_ROUNDS = 3; // exit if no phase progress in N consecutive rounds — tighter to reduce long fix-loops
var SAME_ISSUE_REGEN_THRESHOLD = 3;
var LOW_COVERAGE_MIN_PHASES = 3;      // D1 L7: only enforce on non-trivial games
var LOW_COVERAGE_RATIO = 0.5;         // D1 L7: completedCount / totalPhases floor

/**
 * 2026-04-20 D1: silent-pass L7 — low-phase-coverage detection.
 * When VLM reports passed=true but the game only traversed a fraction of
 * declared phases, it's a false-positive (xrbkl1 postmortem). Returns
 * the signal string when block is warranted, null otherwise.
 */
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
      reason: 'Pre-contamination FATAL: ' + pre.offset + '/' + (pre.total || '?') + ' spec phases completed before observe window opened',
      detail: (pre.phases || []).slice(0, 8).join(', '),
    };
  }

  if ((hasScreenshotSharing && hasBatchCompletion) || (hasBatchCompletion && pre && pre.offset > 0)) {
    return {
      reason: 'Observation protocol FATAL: multiple spec phases collapsed into a single observe window',
      detail: issues.filter(function(issue) {
        var lower = issue.toLowerCase();
        return lower.indexOf('screenshot sharing') >= 0 || lower.indexOf('batch completion') >= 0 || lower.indexOf('pre-contamination') >= 0;
      }).slice(0, 3).join(' | '),
    };
  }

  return null;
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
    // D1 (2026-04-20): fingerprint circuit breaker. urbib0 burned 45min looping
    // on `uniform-timing:avg=50.0s, cv=0%` + `zero-actions` for 40+ rounds
    // because `categorizeIssue()` is too coarse to catch it. Normalize the top
    // issues via metrics.normalizeFingerprint (same dedup function dashboard
    // uses) and abort when identical fingerprint repeats.
    var _lastNormalizedFp = null;
    var _fpRepeatCount = 1;
    var _maxFpRepeat = 1;
    // 2026-04-21: graduated FP repeat handling (was: hard FATAL at 2).
    // At 2 repeats, inject an enhanced diagnostic telling Claude its previous
    // fix did not affect the CUA symptom (with code-changed-or-not hint), then
    // give it one more round. Only at 3 repeats do we throw FATAL. Reason:
    // nqw7z3 / w7113b burned their 6-round budget because the breaker fired
    // at round 2 before Claude had a chance to see that its fix was ineffective.
    var FP_REPEAT_ENHANCED_AT = 2;
    var FP_REPEAT_FATAL_AT = 3;
    var _enhancedDiagInjected = false; // one diagnostic per streak
    var _codeAtFpStreakStart = null; // snapshot for code-changed detection
    // FIX (auto-751aeb4f): track whether full-regen was triggered in the
    // current no-progress streak. _visualFreezeRegenAttempted is scoped to the
    // streak (reset on isProgressing) and replaces the cross-streak
    // consecutiveSameIssue < SAME_ISSUE_REGEN_THRESHOLD guard in the
    // visual_freeze / codegen_init_failure escalation block. This prevents
    // FATAL from firing at _noProgressRounds=2 when consecutiveSameIssue
    // carried over from a prior streak already equals the threshold.
    var _visualFreezeRegenAttempted = false;

    var loop = createFixLoop({
      name: 'cua-verify',
      maxRounds: MAX_CUA_ROUNDS,
      onExhausted: 'throw',  // CUA is a hard gate — must pass
      beforeRound: function(ctx, round) {
        ctx.reportStatus('processing', { message: '[Linux] CUA verifying... (round ' + round + '/' + MAX_CUA_ROUNDS + ')', previewUrl: ctx.previewUrl });
      },
      attempt: function(ctx, round) {
        // Time limit check — use the stricter pre-recode threshold so we don't
        // start a CUA round that can never finish within the recode budget.
        // RECODE_BUFFER_MS is now module-level (hoisted from the inline declaration
        // on the failure path) so it is available here at round entry.
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

            // MODEL_FATAL (Doubao VLM quota/auth) must propagate — otherwise we
            // silently retry and burn more rounds against a dead model backend.
            // Throw so error-classifier routes to cancel-task.
            if (cuaErr && /MODEL_FATAL/i.test(cuaErr.message || '')) {
              throw cuaErr;
            }

            if (lastIssueCategory === 'crash') { consecutiveSameIssue++; }
            else { consecutiveSameIssue = 1; lastIssueCategory = 'crash'; }

            // CUA crash is classified as INFRA by error-classifier.cjs,
            // so fix-loop will retry with backoff without counting against round limit.
            // Throw so error-classifier can handle it properly.
            if (consecutiveSameIssue >= 3) {
              throw new Error('CUA crashed ' + consecutiveSameIssue + ' consecutive rounds');
            }
            return null; // Will trigger { done: false }
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

            // Solid color detection — ALWAYS fail, never auto-pass.
            // A solid color screen means rendering is broken (no GPU, missing assets,
            // loading failure, etc.) and should never be treated as a pass.
            if (cuaResult.quickTestDetail && cuaResult.quickTestDetail.solidColor) {
              cuaResult.issues = (cuaResult.issues || []).concat(['[quick-test] Solid color screen — rendering broken or GPU unavailable, objects not visible']);
              cuaResult.passed = false;
              ctx.addLog('cua-verify', 'Solid color screen detected — FAIL (was previously auto-passed, now hard-fail)');
            }

            // Infra skip (Xvfb down, script missing, etc.) → throw INFRA error for retry
            if (cuaResult.skipped && !cuaResult.passed) {
              var skipReason = (cuaResult.issues && cuaResult.issues[0]) || cuaResult.error || 'CUA infra prerequisite missing';
              ctx.addLog('cua-verify', 'CUA SKIPPED (infra) — will retry: ' + skipReason);
              throw new Error('CUA infra skip: ' + skipReason);
            }

            // Anti-autoplay gate: DISABLED — CUA now uses autoPlay mode (observer)
            // Game intentionally auto-progresses; agent watches instead of interacting.
            // Phase coverage and visual quality are verified, not player-interaction counts.

            if (cuaResult.passed) {
              var silentSignals = cuaResult.silentPassSignals || [];
              // Hard-block: semantic silent-pass signals override passed=true.
              // zero-actions alone is expected in observe mode (already exempted
              // inside worker-playableagent). Other signals mean the game logic
              // didn't actually run — per feedback_cua_hard_gate, CUA must be a
              // hard gate, not a soft signal. Enforcing here (not only inside
              // worker-playableagent) so hot-reload picks it up immediately.
              // 2026-04-20: uniform-timing must be exempted in observe/autoPlay
              // mode (autoPlay driver is a fixed-interval timer → cv≈0% is a
              // physical consequence, not a silent-pass bug). Mirror the worker
              // layer's isAutoPlayMode exemption to avoid flipping genuine PASS
              // runs to FAIL. See worker-playableagent.js:441-446.
              var cuaIsAutoPlayMode = cuaResult.isAutoPlayMode === true;
              var hardBlockers = silentSignals.filter(function(s) {
                if (s.indexOf('uniform-timing') === 0 && cuaIsAutoPlayMode) return false;
                return s.indexOf('uniform-timing') === 0
                    || s.indexOf('phase-order-violation') === 0
                    || s.indexOf('all-vars-zero') === 0
                    || s.indexOf('batch-completion') === 0
                    || s.indexOf('no-phase-timestamps') === 0;
              });

              // 2026-04-20 D1: 7th silent-pass layer — low-phase-coverage.
              // Even when all prior signals are clean, passed=true is a
              // false-positive when the game only traversed a fraction of
              // declared phases. xrbkl1 postmortem: VLM flagged "looks fine"
              // while console showed 1/5 phases completed. Applies equally
              // to autoPlay and interact mode: autoPlay driver is *supposed*
              // to force phase transitions, so low coverage means the logic
              // broke regardless of visual.
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
                // P0 archive: persist full snapshot so silent-pass is never a black hole.
                try {
                  archiveWriter.writeSilentPass(ctx, cuaResult, { round: round, verdict: 'hard-block' });
                } catch(awErr) { ctx.addLog('cua-verify', 'archive-writer hard-block failed: ' + awErr.message); }
                // Fall through to the normal failure path below.
              } else {
                ctx.htmlOutput = lastHtmlData;
                ctx.csCode = lastCsCode;
                if (silentSignals.length > 0) {
                  ctx.addLog('cua-verify', 'CUA PASSED (⚠️ silent-pass signals: ' + silentSignals.join(', ') + ')');
                  // Even for soft-warn signals (e.g. zero-actions exempted in observe mode),
                  // archive the snapshot so operators can audit whether the exemption was
                  // really warranted. verdict distinguishes from the hard-block path above.
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

            // Infra failure — let error-classifier handle via throw
            if (cuaResult.report && (cuaResult.report.cuaApiUnreachable || cuaResult.report.infraFailure)) {
              throw new Error('CUA API unreachable');
            }

            ctx.addLog('cua-verify', 'FAILED: ' + (cuaResult.issues || []).length + ' issues');

            // 2026-04-21: surface pre-contamination offset metadata. Non-fatal
            // pre-contamination (ratio ≤ 50%) no longer appears in issues, but we
            // still want the offset visible in pipeline logs for observability
            // and to help downstream detect if observation is systematically late.
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
              throw new Error(observationProtocolFailure.reason + (observationProtocolFailure.detail ? ': ' + observationProtocolFailure.detail : ''));
            }

            // D1 fingerprint circuit breaker: fires BEFORE coarse categorizeIssue so
            // "uniform-timing:avg=50s cv=0%" type persistent loops abort within 2
            // rounds instead of burning 40. Uses metrics.normalizeFingerprint so the
            // semantics match dashboard dedup exactly — no dynamic numbers, no
            // phaseIds, no counters.
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
              // 2026-04-21 (auto-edb29e02): [spec-phase-skipped] exemption.
              // normalizeFingerprint() strips numeric fractions but leaves the
              // unquoted trailing phase-name list intact (e.g.
              // "exchangeGoldAtStation, buildForgeWorkshop, ..."). Those names
              // are structurally unreachable until the preceding transition is
              // fixed, so the fingerprint is round-stable within any given task.
              // The _noProgressRounds path below already owns escalation (full
              // regen at NO_PROGRESS_EXIT_ROUNDS, FATAL at +3) — let it decide
              // for this class instead of the FP circuit breaker.
              var isPhaseSkippedFp = _currentFp.indexOf('spec-phase-skipped') >= 0;

              if (_fpRepeatCount >= FP_REPEAT_FATAL_AT && !isPhaseSkippedFp) {
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
              } else if (_fpRepeatCount >= FP_REPEAT_ENHANCED_AT && !isPhaseSkippedFp && !_enhancedDiagInjected) {
                // 2nd repeat: inject a hard-worded diagnostic into feedbackHistory
                // explaining that the previous fix did not change the observed CUA
                // symptom. Include a code-diff hint so Claude can tell whether it
                // no-op'd or changed the wrong location. Do not throw — give one
                // more round; FATAL fires at FP_REPEAT_FATAL_AT if it still repeats.
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
              } else if (_fpRepeatCount >= FP_REPEAT_ENHANCED_AT && isPhaseSkippedFp) {
                ctx.addLog('cua-verify',
                  '⚠️ Fingerprint repeat (' + _fpRepeatCount + ') for [spec-phase-skipped] — ' +
                  'circuit breaker exempted; deferring to _noProgressRounds escalation');
              }
            }

            // Consecutive same-issue detection
            var currentIssueCategory = helpers.categorizeIssue(cuaResult);
            var phaseCoverage = helpers.extractPhaseCoverage(cuaResult);
            var currentPhaseCompleted = phaseCoverage ? phaseCoverage.completed : -1;
            var completedPhaseIds = (phaseCoverage && phaseCoverage.phases) || [];

            // Fallback: console-based phase tracking (if instrumented)
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

            // First round with phases completed counts as progress (lastPhaseCompleted starts at -1)
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

            // A.2 (2026-04-20): build stuck diagnosis EVERY failure round (keyword
            // match cost is negligible) and sticky-write rootCause/stuckPhase/
            // nextPhase to stageResults so metrics.cjs can persist them.
            // Previously only the no-progress branch built this, so 58.6% of
            // failures had no rootCause in metrics.
            var diagPhases = completedPhaseIds.length > 0 ? completedPhaseIds : consolePhaseCoverage;
            var stuckDiagnosis = _buildStuckDiagnosis(
              cuaResult,
              currentPhaseCompleted,
              currentIssueCategory,
              _noProgressRounds + (isProgressing ? 0 : 1), // preview next _noProgressRounds for detail text
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

            // No-progress handling: graduated strategy with failure attribution
            if (isProgressing) {
              _noProgressRounds = 0;
              // Reset per-streak escalation flag when progress resumes so a fresh
              // streak always gets a full-regen attempt before FATAL.
              _visualFreezeRegenAttempted = false;
            } else {
              _noProgressRounds++;

              // Only push the detailed diagnosis text into feedbackHistory on
              // no-progress rounds (otherwise we'd spam the recode prompt).
              ctx.addLog('cua-verify', 'No-progress diagnosis: ' + stuckDiagnosis.summary);
              if (!ctx.blueprint.feedbackHistory) ctx.blueprint.feedbackHistory = [];
              ctx.blueprint.feedbackHistory.push({
                data: { text: stuckDiagnosis.detail },
                source: 'cua-stuck-diagnosis',
                status: 'pending',
                timestamp: Date.now(),
              });

              // visual_freeze 无法通过 claude incremental-fix 修复 —— 画面冻结通常是
              // Camera/Canvas/初始化/交互逻辑缺失问题，不是单行代码改动能解决的。
              // 连续 3 round 直接熔断，避免每 round 烧 $5-10 的 claude-code 调用。
              // 2026-04-16 (xrbkl1): threshold was hit in diagnosis path, but issue text
              // didn't match old narrow keywords so short-circuit never fired and we burned
              // 45min of CUA. Keyword list widened in _buildStuckDiagnosis and fallback
              // added for "never completed any phase". Threshold tightened 3 → 2 for
              // noPhasesCompleted case: if phase 1 can't start in 2 rounds, 3 won't help.
              //
              // FIX (auto-751aeb4f): Use _visualFreezeRegenAttempted (per-streak flag)
              // instead of consecutiveSameIssue < SAME_ISSUE_REGEN_THRESHOLD to gate the
              // escalation. consecutiveSameIssue is a cross-streak counter that carries
              // over from prior streaks; it can already be >= SAME_ISSUE_REGEN_THRESHOLD
              // when _noProgressRounds first reaches 2, causing FATAL to fire via the
              // else branch without any full-regen being attempted in the current streak.
              //
              // FIX (auto-edb29e02): Add spec_phase_skipped to the fast-escalation guard.
              // Without this, spec_phase_skipped resolves to 'unknown' in _buildStuckDiagnosis
              // (no matching branch) and misses this block entirely, burning up to
              // NO_PROGRESS_EXIT_ROUNDS+3=7 rounds before FATAL instead of 3.
              //
              // FIX (auto-28eae46e): Add minimum-rounds guard to the visual_freeze FATAL
              // branch. Previously the bare else { throw } fired at _noProgressRounds=3
              // (the very first CUA round after full regen), giving the regenerated code
              // only one verification pass. visual_freeze is a rendering/animation
              // deficiency that a full regen can resolve — it needs at least 2 CUA rounds
              // to confirm progress. codegen_init_failure and spec_phase_skipped retain
              // their single-shot cutoff (zero phases / wont-fix schema mismatch).
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
                  // visual_freeze: require at least 2 CUA rounds post-regen before FATAL.
                  // Full regen was triggered at _noProgressRounds=2; the regenerated code
                  // needs until _noProgressRounds=4 to have had 2 verification passes.
                  // Fall through on rounds 3 to let normal no-progress handling continue.
                  if (_noProgressRounds >= 4) {
                    throw new Error('Visual freeze FATAL: ' + _noProgressRounds + ' consecutive rounds — surgical and full-regen both failed. ' + stuckDiagnosis.summary);
                  }
                  ctx.addLog('cua-verify', 'visual_freeze: post-regen round ' + _noProgressRounds + ' — waiting for round 4 minimum before FATAL');
                }
              }

              if (_noProgressRounds >= NO_PROGRESS_EXIT_ROUNDS + 3) {
                // Hard exit after NO_PROGRESS_EXIT_ROUNDS+3 no-progress rounds — code genuinely can't pass
                throw new Error('No phase progress in ' + _noProgressRounds + ' consecutive rounds. Diagnosis: ' + stuckDiagnosis.summary);
              } else if (_noProgressRounds === NO_PROGRESS_EXIT_ROUNDS) {
                // Force full regen strategy after NO_PROGRESS_EXIT_ROUNDS rounds, but keep trying
                ctx.addLog('cua-verify', 'No progress for ' + _noProgressRounds + ' rounds — escalating to full regen');
                consecutiveSameIssue = SAME_ISSUE_REGEN_THRESHOLD;
              }
            }

            if (consecutiveSameIssue >= SAME_ISSUE_REGEN_THRESHOLD * 2) {
              throw new Error('Same issue "' + currentIssueCategory + '" after ' + consecutiveSameIssue + ' rounds (no progress)');
            }

            // (Anti-autoplay zero-actions check moved BEFORE the cuaResult.passed return above)

            // Autoplay detection — disabled (CUA uses autoPlay/observe mode)
            // _autoplayFailCount tracking removed: autoPlay is now by-design, not a defect.

            // Full regen on repeated same issue — PRESERVE failure context
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

            // Build feedback
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

            // Record CUA failures to pending-rules for knowledge retention
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

            // Pre-recode time guard: RECODE_BUFFER_MS is now module-level (hoisted above),
            // so this check is consistent with the round-entry guard above. No local
            // re-declaration needed here.
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
              // patchRecode 走 Sonnet 直出，省 ~150KB token vs full recode。
              // 旧条件要求所有 issue 都有 line>0，命中率太低；改为只要至少 1 个 issue 有 line 就尝试 patch，
              // patchRecode 自身失败时再回落到 full recode（双保险）。
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
              // Capture updated extraFiles from recode (e.g. Systems.cs partial class)
              if (recodeResult.extraFiles) {
                for (var efKey in recodeResult.extraFiles) {
                  if (recodeResult.extraFiles.hasOwnProperty(efKey)) {
                    lastExtraFiles[efKey] = recodeResult.extraFiles[efKey];
                  }
                }
              }
              ctx.reportStatus('building', { message: '[Linux] CUA fix rebuilding... (round ' + (round + 1) + ')' });

              return helpers.buildRequest(buildUrl, '/build', lastCsCode, Object.assign({}, lastExtraFiles))
                .then(function(buildResult) {
                  if (!buildResult.ok) {
                    ctx.addLog('cua-verify', 'Fix rebuild failed: ' + (buildResult.error || ''));
                    return { done: false };
                  }
                  ctx.addLog('cua-verify', 'Fix rebuild OK in ' + buildResult.buildTime + 's');
                  ctx.checkpoint.cuaRound = round;
                  ctx.checkpoint.fixHistory = fixHistory;

                  return helpers.buildRequest(buildUrl, '/build-html', lastCsCode, Object.assign({}, lastExtraFiles))
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

  // Exposed for unit testing (D1 L7 silent-pass detection)
  _internals: {
    detectLowCoverageSignal: detectLowCoverageSignal,
    LOW_COVERAGE_MIN_PHASES: LOW_COVERAGE_MIN_PHASES,
    LOW_COVERAGE_RATIO: LOW_COVERAGE_RATIO,
  },
};
