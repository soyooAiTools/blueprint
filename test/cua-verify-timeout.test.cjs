#!/usr/bin/env node
/**
 * G1 (2026-04-20): computeVerifyTimeoutMs phase-count scaling.
 *
 * Anchors the kill-switch formula so future edits don't accidentally
 * make simple tasks wait 15min on Python hangs.
 */

var assert = require('assert');
var { computeVerifyTimeoutMs } = require('../worker/worker-playableagent.js');

// ── Floor: <=1 phase clamps to 180s ──────────────────────────────────
assert.strictEqual(computeVerifyTimeoutMs(0), 180_000, '[1.1] 0 phases → 180s floor');
assert.strictEqual(computeVerifyTimeoutMs(1), 180_000, '[1.2] 1 phase (150<180) → 180s floor');
assert.strictEqual(computeVerifyTimeoutMs(1.5), 180_000, '[1.3] 1.5 coerced to 1');

// ── Linear zone ───────────────────────────────────────────────────────
assert.strictEqual(computeVerifyTimeoutMs(3), 270_000, '[2.1] 3 phases → 270s');
assert.strictEqual(computeVerifyTimeoutMs(5), 390_000, '[2.2] 5 phases → 390s');
assert.strictEqual(computeVerifyTimeoutMs(8), 570_000, '[2.3] 8 phases → 570s');
assert.strictEqual(computeVerifyTimeoutMs(11), 750_000, '[2.4] 11 phases → 750s');

// ── Cap: 14+ phases clamps to 900s ────────────────────────────────────
assert.strictEqual(computeVerifyTimeoutMs(13), 870_000, '[3.1] 13 phases → 870s (under cap)');
assert.strictEqual(computeVerifyTimeoutMs(14), 900_000, '[3.2] 14 phases → 900s (first hit cap)');
assert.strictEqual(computeVerifyTimeoutMs(30), 900_000, '[3.3] 30 phases → 900s cap');

// ── Defensive: negatives / junk ───────────────────────────────────────
assert.strictEqual(computeVerifyTimeoutMs(-5), 180_000, '[4.1] negative → floor');
assert.strictEqual(computeVerifyTimeoutMs(null), 180_000, '[4.2] null → floor');
assert.strictEqual(computeVerifyTimeoutMs(undefined), 180_000, '[4.3] undefined → floor');
assert.strictEqual(computeVerifyTimeoutMs('abc'), 180_000, '[4.4] NaN string → floor');
assert.strictEqual(computeVerifyTimeoutMs('7'), 510_000, '[4.5] numeric string parses → 7 phases');

// ── Regression: simple task must NOT get 15min ────────────────────────
assert.ok(computeVerifyTimeoutMs(3) < 600_000, '[5.1] 3-phase kill-switch must be <10min (old 15min regression check)');
assert.ok(computeVerifyTimeoutMs(5) < 600_000, '[5.2] 5-phase kill-switch must be <10min');

console.log('OK — all G1 computeVerifyTimeoutMs assertions passed');
console.log('  sample:');
[1, 3, 5, 8, 11, 14, 20].forEach(function(n) {
  console.log('    ' + n + ' phases → ' + (computeVerifyTimeoutMs(n)/1000) + 's');
});
