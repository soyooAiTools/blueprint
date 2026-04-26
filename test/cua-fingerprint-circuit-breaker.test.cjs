#!/usr/bin/env node
/**
 * D1 (2026-04-20): cua-verify fingerprint circuit breaker.
 *
 * Anchors the normalization contract that the circuit breaker relies on.
 * The breaker itself lives inside execute()'s closure, so we verify that:
 *   (1) urbib0-style issue variants collapse to ONE fingerprint (would repeat)
 *   (2) distinct root causes produce DIFFERENT fingerprints (would reset)
 *   (3) the slice(0,3) + ' | ' join the stage uses is stable
 *   (4) error-classifier routes "Fingerprint repeat FATAL" to FATAL
 */

var assert = require('assert');
var { normalizeFingerprint } = require('../engine/metrics.cjs');
var { classify } = require('../engine/error-classifier.cjs');
var cuaVerify = require('../engine/stages/cua-verify.cjs');
var cuaInternals = cuaVerify._internals || {};

function buildFp(issues) {
  var raw = (issues || []).slice(0, 3).map(function(i) {
    return typeof i === 'string' ? i : (i && (i.message || i.text) || '');
  }).join(' | ');
  return raw ? normalizeFingerprint(raw) : null;
}

// ── Case 1: urbib0 variants must collapse ─────────────────────────────
// These are the exact kind of per-round variants that burned 40+ rounds
// because categorizeIssue bucketed them separately.

var round1 = [
  '[silent-pass-block] uniform-timing:avg=50.0s, cv=0% — game logic did not run correctly despite passed=true',
  '[silent-pass-block] zero-actions — game logic did not run correctly despite passed=true',
  'Stuck at phase phase_2 → phase_3',
];
var round2 = [
  '[silent-pass-block] uniform-timing:avg=48.2s, cv=0% — game logic did not run correctly despite passed=true',
  '[silent-pass-block] zero-actions — game logic did not run correctly despite passed=true',
  'Stuck at phase phase_2 → phase_3',
];
var round3 = [
  '[silent-pass-block] uniform-timing:avg=51.7s, cv=0% — game logic did not run correctly despite passed=true',
  '[silent-pass-block] zero-actions — game logic did not run correctly despite passed=true',
  'Stuck at phase phase_4 → phase_5',
];

var fp1 = buildFp(round1);
var fp2 = buildFp(round2);
var fp3 = buildFp(round3);

assert.ok(fp1, '[1.1] round1 produced fingerprint');
assert.strictEqual(fp1, fp2, '[1.2] avg=50.0 vs 48.2 must collapse (both uniform-timing cv=0%)\n  fp1=' + fp1 + '\n  fp2=' + fp2);
assert.strictEqual(fp1, fp3, '[1.3] different phase numbers must not fracture fingerprint\n  fp1=' + fp1 + '\n  fp3=' + fp3);

// ── Case 2: distinct root causes must NOT collapse ────────────────────
// A legitimate different issue should reset the counter, not trip the breaker.

var roundDifferent = [
  '[silent-pass-block] all-vars-zero — game logic did not run correctly despite passed=true',
  'Phase coverage too low: 1/5 (20%). Missing: phase_3, phase_4, phase_5',
  'Visual freeze: virtually identical screenshots across poll window',
];
var fpDiff = buildFp(roundDifferent);
assert.notStrictEqual(fp1, fpDiff, '[2.1] uniform-timing vs all-vars-zero must differ (counter resets)\n  fp1=' + fp1 + '\n  fpDiff=' + fpDiff);

// ── Case 3: empty / absent issues produce null, breaker skips ────────
assert.strictEqual(buildFp([]), null, '[3.1] empty issues → null (breaker no-op)');
assert.strictEqual(buildFp(null), null, '[3.2] null issues → null (breaker no-op)');
// Structured-but-empty issues produce " | " joined string; stage code's
// `_rawFp ? normalize(_rawFp) : null` treats that as truthy. This is an
// accepted corner case — in practice CUA issues always have text.
var fpEmpty = buildFp([{}, {}]);
assert.ok(fpEmpty === null || fpEmpty.length < 5,
  '[3.3] structured-but-empty → null or trivially short: ' + fpEmpty);

// ── Case 4: object-form issues with .message or .text ─────────────────
var objIssues = [
  { message: '[silent-pass-block] uniform-timing:avg=50.0s, cv=0%' },
  { text: 'zero-actions detected' },
];
var fpObj = buildFp(objIssues);
assert.ok(fpObj && fpObj.length > 0, '[4.1] object issues extract message/text: ' + fpObj);

// ── Case 5: error-classifier routes "Fingerprint repeat FATAL" to FATAL ─
var classification = classify(new Error('Fingerprint repeat FATAL: identical normalized fingerprint "uniform-timing" for 2 consecutive rounds; Claude fix ineffective'));
assert.strictEqual(classification.type, 'FATAL', '[5.1] must classify as FATAL, not INFRA/CODE — got ' + classification.type);
assert.strictEqual(classification.retryable, false, '[5.2] must be non-retryable');

// ── Case 6: graduated thresholds — 2=enhanced diagnostic, 3=FATAL ──────
// 2026-04-21: was hard-abort at 2; now round 2 injects an enhanced-diagnostic
// feedback entry (continue) and round 3 aborts. Reason: nqw7z3 / w7113b burned
// their 6-round budget because the breaker fired before Claude saw that its
// prior fix was ineffective. Giving one more round with a hard-worded
// diagnostic recovers genuine fixable cases without re-opening the 40-round
// token burn regression (count=3 still aborts).
var state = { _lastNormalizedFp: null, _fpRepeatCount: 1, _maxFpRepeat: 1, _enhancedDiagInjected: false };
var ENHANCED_AT = 2;
var FATAL_AT = 3;
function tick(issues) {
  var fp = buildFp(issues);
  if (!fp) return null;
  if (fp === state._lastNormalizedFp) {
    state._fpRepeatCount++;
    if (state._fpRepeatCount > state._maxFpRepeat) state._maxFpRepeat = state._fpRepeatCount;
  } else {
    state._fpRepeatCount = 1;
    state._lastNormalizedFp = fp;
    state._enhancedDiagInjected = false;
  }
  if (state._fpRepeatCount >= FATAL_AT) return 'ABORT';
  if (state._fpRepeatCount >= ENHANCED_AT && !state._enhancedDiagInjected) {
    state._enhancedDiagInjected = true;
    return 'DIAGNOSTIC';
  }
  return 'CONTINUE';
}

assert.strictEqual(tick(round1), 'CONTINUE',   '[6.1] round 1 continues (count=1)');
assert.strictEqual(tick(round2), 'DIAGNOSTIC', '[6.2] round 2 identical-fp injects diagnostic (count=2)');
assert.strictEqual(tick(round2), 'ABORT',      '[6.3] round 3 identical-fp aborts FATAL (count=3)');
assert.strictEqual(state._maxFpRepeat, 3,      '[6.4] maxFpRepeat tracks peak');

// Reset and verify a heterogeneous sequence does NOT trip
state = { _lastNormalizedFp: null, _fpRepeatCount: 1, _maxFpRepeat: 1, _enhancedDiagInjected: false };
assert.strictEqual(tick(round1),         'CONTINUE',   '[6.5] first distinct fp');
assert.strictEqual(tick(roundDifferent), 'CONTINUE',   '[6.6] diff fp resets counter');
assert.strictEqual(tick(round1),         'CONTINUE',   '[6.7] return to fp1 but counter=1');
assert.strictEqual(tick(round1),         'DIAGNOSTIC', '[6.8] fp1 twice → diagnostic');
assert.strictEqual(tick(round1),         'ABORT',      '[6.9] fp1 thrice → FATAL');

// ── Case 7: screenshot-sharing fingerprints are owned by no-progress escalation ─
// This fingerprint is expected to be stable until a batch-firing/full-regen fix lands.
// The generic FP breaker must not throw FATAL before that path can run.
assert.strictEqual(typeof cuaInternals.isFingerprintCircuitBreakerExempt, 'function',
  '[7.1] cua-verify exposes fingerprint exemption predicate');
var screenshotSharingFp = buildFp([
  'Screenshot sharing: 2 spec phases share only 1 screenshot(s). Each phase must have a distinct visual state.',
  'screenshot-timing: screenshot sharing 2 phases 1 screenshots',
]);
assert.ok(screenshotSharingFp && screenshotSharingFp.indexOf('screenshot') >= 0,
  '[7.2] screenshot sharing fingerprint is normalized: ' + screenshotSharingFp);
assert.strictEqual(cuaInternals.isFingerprintCircuitBreakerExempt(screenshotSharingFp), true,
  '[7.3] screenshot-sharing fp must be exempt from generic FATAL breaker');
assert.strictEqual(cuaInternals.isFingerprintCircuitBreakerExempt('[spec-phase-skipped] missing phase'), true,
  '[7.4] existing spec-phase-skipped exemption preserved');
assert.strictEqual(cuaInternals.isFingerprintCircuitBreakerExempt(fp1), false,
  '[7.5] unrelated uniform-timing fp still uses generic breaker');

// ── Case 8: default preview interaction failure must prevent CUA skip ─
var skipLogs = [];
assert.strictEqual(cuaVerify.canSkip({
  stageResults: {
    'runtime-contract': {
      needsEscalation: false,
      defaultInteractionPassed: false,
      defaultInteractionReason: 'raw-actions-did-not-advance-phase',
    },
  },
  addLog: function(stage, msg) { skipLogs.push(stage + ':' + msg); },
}), false, '[8.1] CUA cannot be skipped when raw default interaction failed');
assert.ok(skipLogs.some(function(line) { return line.indexOf('default preview interaction failed') >= 0; }),
  '[8.2] skip override should leave an operator log');
assert.deepStrictEqual(cuaInternals.getRuntimeDefaultInteractionFailure({
  stageResults: {
    'runtime-contract': {
      defaultInteractionPassed: false,
      defaultInteractionReason: 'raw-actions-did-not-advance-phase',
      defaultInteractionPhaseBefore: 'upgradeOurBase',
    },
  },
}), {
  reason: 'raw-actions-did-not-advance-phase',
  phaseBefore: 'upgradeOurBase',
  phaseAfter: '',
  completedBefore: undefined,
  completedAfter: undefined,
}, '[8.3] runtime default failure metadata should be extractable');

// ── Case 9: observation protocol screenshot-timing must not bypass recode ─
assert.strictEqual(typeof cuaInternals.detectObservationProtocolFailure, 'function',
  '[9.1] cua-verify exposes observation protocol detector');
var observationWarning = cuaInternals.detectObservationProtocolFailure({
  issues: [
    'Screenshot sharing: 2 spec phases share only 1 screenshot(s).',
    'batch completion: multiple phases completed inside one observe window',
  ],
  report: { preContamination: { fatal: false, offset: 1, total: 11, phases: ['intro'] } },
});
assert.ok(observationWarning, '[9.2] screenshot sharing + batch completion should be detected');
assert.strictEqual(observationWarning.isFatal, false,
  '[9.3] screenshot-timing observation issue must defer to no-progress/full-regen path');
assert.ok(observationWarning.reason.indexOf('warning') >= 0,
  '[9.4] non-fatal observation issue should not be logged as FATAL');

var observationFatal = cuaInternals.detectObservationProtocolFailure({
  issues: [],
  report: { preContamination: { fatal: true, offset: 8, total: 11, phases: ['p1', 'p2'] } },
});
assert.ok(observationFatal, '[9.5] true pre-contamination fatal should still be detected');
assert.strictEqual(observationFatal.isFatal, true,
  '[9.6] true pre-contamination fatal must still throw at caller');

console.log('OK — all D1 circuit-breaker assertions passed');
console.log('  urbib0 fp:           ' + fp1);
console.log('  heterogeneous fp:    ' + fpDiff);
console.log('  screenshot fp:       ' + screenshotSharingFp);
console.log('  error-classifier → ' + classification.type);
