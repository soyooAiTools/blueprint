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

// ── Case 6: threshold is 2 (semantic assertion via simulating loop) ────
// Simulate the in-closure state machine manually to verify the threshold.
var state = { _lastNormalizedFp: null, _fpRepeatCount: 1, _maxFpRepeat: 1 };
var THRESHOLD = 2;
function tick(issues) {
  var fp = buildFp(issues);
  if (!fp) return null;
  if (fp === state._lastNormalizedFp) {
    state._fpRepeatCount++;
    if (state._fpRepeatCount > state._maxFpRepeat) state._maxFpRepeat = state._fpRepeatCount;
  } else {
    state._fpRepeatCount = 1;
    state._lastNormalizedFp = fp;
  }
  return state._fpRepeatCount >= THRESHOLD ? 'ABORT' : 'CONTINUE';
}

assert.strictEqual(tick(round1), 'CONTINUE', '[6.1] round 1 continues (count=1)');
assert.strictEqual(tick(round2), 'ABORT',    '[6.2] round 2 identical-fp triggers abort (count=2)');
assert.strictEqual(state._maxFpRepeat, 2,    '[6.3] maxFpRepeat tracks peak');

// Reset and verify a heterogeneous sequence does NOT trip
state = { _lastNormalizedFp: null, _fpRepeatCount: 1, _maxFpRepeat: 1 };
assert.strictEqual(tick(round1),         'CONTINUE', '[6.4] first distinct fp');
assert.strictEqual(tick(roundDifferent), 'CONTINUE', '[6.5] diff fp resets counter');
assert.strictEqual(tick(round1),         'CONTINUE', '[6.6] return to fp1 but counter=1');
assert.strictEqual(tick(round1),         'ABORT',    '[6.7] fp1 twice in a row aborts');

console.log('OK — all D1 circuit-breaker assertions passed');
console.log('  urbib0 fp:           ' + fp1);
console.log('  heterogeneous fp:    ' + fpDiff);
console.log('  error-classifier → ' + classification.type);
