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

  if (noPhasesCompleted && noProgressRounds >= 2) {
    rootCause = 'codegen_init_failure';
  } else if (hasVisualFreezePhrase) {
    rootCause = 'visual_freeze';
  } else if (allIssueText.indexOf('variable') >= 0 && (allIssueText.indexOf('stagnation') >= 0 || allIssueText.indexOf('initial values') >= 0 || allIssueText.indexOf('remain') >= 0)) {
    rootCause = 'variable_stagnation';
  } else if (allIssueText.indexOf('solid color') >= 0 || allIssueText.indexOf('black screen') >= 0 || allIssueText.indexOf('blank') >= 0) {
    rootCause = 'rendering_failure';
  } else if (allIssueText.indexOf('not respond') >= 0 || allIssueText.indexOf('no reaction') >= 0 || allIssueText.indexOf('click') >= 0 && allIssueText.indexOf('nothing') >= 0) {
    rootCause = 'interaction_dead';
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
    batch_phase_skip: 'Multiple phases completed in one poll interval — phases are timer-skipping without gameplay. Fix: ensure each phase has a minimum 20s duration gate and performs real gameplay actions during that time.',
    rendering_failure: 'Objects are not visible. Check: (1) SetActive(true) is called, (2) objects are positioned within camera view, (3) no Z-fighting or off-screen placement.',
    interaction_dead: 'User interactions have no effect. Check: (1) colliders exist on interactive objects, (2) raycast/click handlers are wired up, (3) interaction zone is large enough.',
    phase_transition_broken: 'Phase transition condition never becomes true. Check: (1) the trigger condition variable is actually modified by gameplay, (2) AddCompletedPhase is called with correct phaseId, (3) no early return before the transition check.',
    runtime_error: 'Runtime errors prevent execution. Check: (1) GameObject.Find returns null for missing objects, (2) array index out of bounds, (3) division by zero.',
    autoplay_or_idle: 'Game progresses without user input. Check: (1) phase transitions require playerMustAct=true, (2) timer-only transitions should not exist, (3) autoAllowed=false phases must wait for user action.',
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

var MAX_CUA_ROUNDS = 10;
// Wall-clock cap: default 75 min, overridable via CUA_TOTAL_TIMEOUT_MS env var.
// Raised from 45 min — a single Opus recode+rebuild cycle can take 8-10 min on a complex
// ad, which previously pushed elapsed past the 45 min limit after the 5 min pre-recode
// guard fired at 40 min. The env override lets operators tune without a code change.
var MAX_CUA_TOTAL_MS = process.env.CUA_TOTAL_TIMEOUT_MS
  ? parseInt(process.env.CUA_TOTAL_TIMEOUT_MS, 10)
  : 75 * 60 * 1000; // 75 min default (Opus fix rounds ~8-10 min each on complex ads)
var NO_PROGRESS_EXIT_ROUNDS = 4; // exit if no phase progress in N consecutive rounds (was 5 — tightened to save tokens)
var SAME_ISSUE_REGEN_THRESHOLD = 3;

module.exports = {
  name: 'cua-verify',
  canRetry: false,
  assertBefore: function(ctx) {
    if (!ctx.htmlOutput) throw new Error('No HTML output from compile stage');
    if (ctx.htmlOutput.length < 10240) throw new Error('HTML output too small (' + ctx.htmlOutput.length + ' bytes) — likely empty build');
  },
  canSkip: function(ctx) {
    if (process.env.SKIP_CUA === 'true') {
      console.warn('[CUA-GATE] ⚠️  SKIP_CUA=true — CUA hard gate DISABLED. Set SKIP_CUA= to re-enable.');
      ctx.addLog('cua-verify', 'WARNING: CUA skipped via SKIP_CUA env — hard gate disabled');
    }
    return process.env.SKIP_CUA === 'true';
  },
  execute: function(ctx) {
    ctx.addLog('cua-verify', 'Starting CUA verification...');
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

    var loop = createFixLoop({
      name: 'cua-verify',
      maxRounds: MAX_CUA_ROUNDS,
      onExhausted: 'throw',  // CUA is a hard gate — must pass
      beforeRound: function(ctx, round) {
        ctx.reportStatus('processing', { message: '[Linux] CUA verifying... (round ' + round + '/' + MAX_CUA_ROUNDS + ')', previewUrl: ctx.previewUrl });
      },
      attempt: function(ctx, round) {
        // Time limit check
        var elapsed = Date.now() - cuaStartTime;
        if (elapsed > MAX_CUA_TOTAL_MS) {
          throw new Error('CUA total time limit exceeded (' + Math.round(elapsed / 60000) + 'min > ' + Math.round(MAX_CUA_TOTAL_MS / 60000) + 'min)');
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
                    || s.indexOf('all-vars-zero') === 0;
              });
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
                } };
              }
            }

            // Infra failure — let error-classifier handle via throw
            if (cuaResult.report && (cuaResult.report.cuaApiUnreachable || cuaResult.report.infraFailure)) {
              throw new Error('CUA API unreachable');
            }

            ctx.addLog('cua-verify', 'FAILED: ' + (cuaResult.issues || []).length + ' issues');

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

            // No-progress handling: graduated strategy with failure attribution
            if (isProgressing) {
              _noProgressRounds = 0;
            } else {
              _noProgressRounds++;

              // Build structured failure attribution for recode context
              var diagPhases = completedPhaseIds.length > 0 ? completedPhaseIds : consolePhaseCoverage;
              var stuckDiagnosis = _buildStuckDiagnosis(cuaResult, currentPhaseCompleted, currentIssueCategory, _noProgressRounds, ctx.blueprint, diagPhases);
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
              if ((stuckDiagnosis.rootCause === 'visual_freeze' || stuckDiagnosis.rootCause === 'codegen_init_failure') && _noProgressRounds >= 2) {
                if (consecutiveSameIssue < SAME_ISSUE_REGEN_THRESHOLD) {
                  ctx.addLog('cua-verify', stuckDiagnosis.rootCause + ': surgical fix insufficient — escalating to full regen before FATAL (' + _noProgressRounds + ' rounds)');
                  consecutiveSameIssue = SAME_ISSUE_REGEN_THRESHOLD;
                } else if (stuckDiagnosis.rootCause === 'codegen_init_failure') {
                  throw new Error('Codegen init failure: no phases completed after ' + _noProgressRounds + ' rounds of full regen. ' + stuckDiagnosis.summary);
                } else {
                  throw new Error('Visual freeze FATAL: ' + _noProgressRounds + ' consecutive rounds — surgical and full-regen both failed. ' + stuckDiagnosis.summary);
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

            // Pre-recode time guard: if fewer than 15 minutes remain in the wall-clock budget,
            // skip launching another recode/rebuild cycle. Opus recode can take 8-10min, rebuild
            // 2-4min, so 15min buffer prevents overshoot. Previous 10min buffer was too tight.
            var elapsedBeforeRecode = Date.now() - cuaStartTime;
            var RECODE_BUFFER_MS = 15 * 60 * 1000;
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
                      return { done: false };
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
};