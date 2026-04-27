#!/usr/bin/env node
/**
 * 2026-04-27 (auto-fb07a3a6): the new L10 silent-pass signal `autoplay-zero-steps`
 * (added earlier this session to worker-playableagent.js) was being misclassified
 * by _buildStuckDiagnosis() because its substring `autoplay` matched the generic
 * `autoplay_or_idle` branch BEFORE any specific check existed. The advice for
 * autoplay_or_idle tells Claude to DISABLE autoplay (playerMustAct=true), which
 * is the exact opposite of the correct fix in observe-mode → Claude fix
 * ineffective → fingerprint repeats 3x → FATAL.
 *
 * Lock the routing so any future signal name reorderings can't regress this.
 *
 * Anchors:
 *   1. autoplay-zero-steps issue text → rootCause === 'autoplay_zero_steps'
 *   2. autoplay_zero_steps advice MUST tell Claude to KEEP autoplay enabled
 *   3. Generic 'autoplay'/'idle' issue text still routes to autoplay_or_idle
 *   4. hardBlockers filter must include autoplay-zero-steps (engine ↔ worker sync)
 */

var assert = require('assert');
var fs = require('fs');
var path = require('path');

var cuaVerify = require('../engine/stages/cua-verify.cjs');
var buildStuckDiagnosis = cuaVerify._internals && cuaVerify._internals.buildStuckDiagnosis;
assert.ok(buildStuckDiagnosis, 'buildStuckDiagnosis must be exported via _internals');

function makeCuaResult(issueText) {
  return {
    issues: [{ message: issueText }],
    isAutoPlayMode: true,
  };
}

// Provide a populated consolePhaseCoverage so we don't hit the early
// codegen_init_failure short-circuit (which fires when completedPhases.length===0
// && noProgressRounds>=2). Use 2 completed out of 3 specs so the diagnosis is
// "stuck mid-game", which is the realistic scenario for autoplay-zero-steps.
var blueprint = { specs: [
  { phaseId: 'phase_1', name: 'phase 1' },
  { phaseId: 'phase_2', name: 'phase 2' },
  { phaseId: 'phase_3', name: 'phase 3' },
] };
var consolePhaseCoverage = ['phase_1', 'phase_2'];

// Case 1: autoplay-zero-steps must route to its own branch
var diag1 = buildStuckDiagnosis(
  makeCuaResult('[silent-pass-block] autoplay-zero-steps:initialSceneLoad,firstWaveEnemyIncoming — game logic did not run correctly'),
  'phase_2',
  null,
  3,
  blueprint,
  consolePhaseCoverage
);
assert.strictEqual(diag1.rootCause, 'autoplay_zero_steps',
  'autoplay-zero-steps issue must route to autoplay_zero_steps, not autoplay_or_idle. Got: ' + diag1.rootCause);

// Case 2: advice for autoplay_zero_steps must NOT tell Claude to disable autoplay
assert.ok(/DO NOT disable autoplay/i.test(diag1.detail) || /do.*not.*playerMustAct\s*=\s*true/i.test(diag1.detail),
  'Advice must explicitly forbid disabling autoplay (no "playerMustAct=true"). Got: ' + diag1.detail.slice(0, 800));
assert.ok(/OnAutoPlayArrive/.test(diag1.detail),
  'Advice must mention OnAutoPlayArrive — the actual mechanism that needs to fire.');
assert.ok(/autoPlayStepsThisPhase/.test(diag1.detail),
  'Advice must reference autoPlayStepsThisPhase — the verification metric.');

// Case 3: generic "autoplay" / "idle" still routes to autoplay_or_idle
var diag3 = buildStuckDiagnosis(
  makeCuaResult('Game appears idle, no input registered'),
  'phase_2',
  null,
  3,
  blueprint,
  consolePhaseCoverage
);
assert.strictEqual(diag3.rootCause, 'autoplay_or_idle',
  'Plain "idle" must still route to autoplay_or_idle. Got: ' + diag3.rootCause);

var diag3b = buildStuckDiagnosis(
  makeCuaResult('autoplay detected with no actions'),
  'phase_2',
  null,
  3,
  blueprint,
  consolePhaseCoverage
);
assert.strictEqual(diag3b.rootCause, 'autoplay_or_idle',
  'Plain "autoplay" (no -zero-steps) must still route to autoplay_or_idle. Got: ' + diag3b.rootCause);

// Case 4: engine hardBlockers filter must include autoplay-zero-steps (sync with worker)
var src = fs.readFileSync(path.join(__dirname, '..', 'engine', 'stages', 'cua-verify.cjs'), 'utf8');
assert.ok(/autoplay-zero-steps/.test(src),
  'cua-verify.cjs must reference autoplay-zero-steps for engine↔worker filter sync');
// Find the hardBlockers filter block and assert autoplay-zero-steps is in it
var filterBlockMatch = src.match(/var hardBlockers = silentSignals\.filter\(function\(s\) \{[\s\S]*?\}\);/);
assert.ok(filterBlockMatch, 'hardBlockers filter block must exist');
assert.ok(/autoplay-zero-steps/.test(filterBlockMatch[0]),
  'autoplay-zero-steps MUST appear in hardBlockers filter block (sync with worker-playableagent.js:370). Block: ' +
  filterBlockMatch[0].slice(0, 600));

// Case 5: regression — confirm autoplay-zero-steps is checked BEFORE the generic
// 'autoplay' branch in _buildStuckDiagnosis (order matters because both contain 'autoplay').
var zeroStepsIdx = src.indexOf("indexOf('autoplay-zero-steps')");
var genericAutoplayIdx = src.indexOf("indexOf('autoplay') >= 0 || allIssueText.indexOf('idle')");
assert.ok(zeroStepsIdx > 0 && genericAutoplayIdx > 0,
  'Both branches must exist in _buildStuckDiagnosis');
assert.ok(zeroStepsIdx < genericAutoplayIdx,
  'autoplay-zero-steps branch must appear BEFORE the generic autoplay/idle branch (substring containment trap).');

console.log('cua-verify autoplay-zero-steps routing: 5 cases passed');
