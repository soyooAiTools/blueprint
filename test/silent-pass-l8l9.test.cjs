#!/usr/bin/env node
/**
 * D2 regression: silent-pass L8/L9 detectors.
 *
 * L8 batch-completion: ts span ≤2s across ≥3 phases.
 * L9 no-phase-timestamps: passed=true + declared≥2 + tsCount=0.
 */

var assert = require('assert');
var d = require('../adapters/silent-pass-detectors.cjs');

// ── L8 batch-completion ────────────────────────────────────────────────

assert.strictEqual(
  d.detectBatchCompletion([100.0, 100.2, 100.5, 101.0]),
  'batch-completion:span=1.0s,phases=4',
  '[L8.1] 1.0s span across 4 phases must flag'
);

assert.strictEqual(
  d.detectBatchCompletion([50.0, 50.0, 50.0]),
  'batch-completion:span=0.0s,phases=3',
  '[L8.2] identical timestamps flag (0s span)'
);

assert.strictEqual(
  d.detectBatchCompletion([10, 22, 34, 46, 58]),
  null,
  '[L8.3] real autoPlay with 12s spacing must NOT flag'
);

assert.strictEqual(
  d.detectBatchCompletion([100, 101]),
  null,
  '[L8.4] only 2 phases must not flag (min 3)'
);

assert.strictEqual(
  d.detectBatchCompletion([]),
  null,
  '[L8.5] empty must not flag'
);

assert.strictEqual(
  d.detectBatchCompletion(null),
  null,
  '[L8.6] null must not flag'
);

assert.strictEqual(
  d.detectBatchCompletion([10, 12.5, 13]),
  null,
  '[L8.7] 3.0s span exceeds 2s threshold'
);

// ── L9 no-phase-timestamps ─────────────────────────────────────────────

assert.strictEqual(
  d.detectNoPhaseTimestamps(true, 5, 0),
  'no-phase-timestamps:declared=5',
  '[L9.1] passed=true with 5 declared and 0 recorded must flag'
);

assert.strictEqual(
  d.detectNoPhaseTimestamps(false, 5, 0),
  null,
  '[L9.2] passed=false must not flag (already failing)'
);

assert.strictEqual(
  d.detectNoPhaseTimestamps(true, 1, 0),
  null,
  '[L9.3] declared=1 below min must not flag'
);

assert.strictEqual(
  d.detectNoPhaseTimestamps(true, 5, 3),
  null,
  '[L9.4] tsCount > 0 must not flag'
);

assert.strictEqual(
  d.detectNoPhaseTimestamps(true, 0, 0),
  null,
  '[L9.5] no declared phases must not flag'
);

// ── Constants are exported so callers can reason about thresholds ─────

assert.strictEqual(d._constants.BATCH_COMPLETION_MAX_SPAN_SEC, 2);
assert.strictEqual(d._constants.BATCH_COMPLETION_MIN_PHASES, 3);
assert.deepStrictEqual(d.L8_L9_HARD_BLOCK_PREFIXES, ['batch-completion', 'no-phase-timestamps']);

console.log('OK — 15 silent-pass L8/L9 assertions passed');
