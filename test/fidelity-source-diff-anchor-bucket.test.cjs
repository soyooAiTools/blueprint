#!/usr/bin/env node
'use strict';

// v1.2.0 fidelity-source-diff stage — anchor bucket integration smoke.
// Verifies:
//   1. Stage module loads cleanly + exposes expected _internals
//   2. runAnchorDiff entries produced by lib correctly route into 'anchor'
//      bucket when fed through the stage's L143-147 aggregator pattern
//   3. blocking/advisory split on `d.blocking !== false` works for both
//      anchor-mismatch (blocking) and anchor-mismatch-off-viewport (advisory)
//
// Full stage execute() requires playwright + a browser; out of scope for unit
// test. This smoke covers the wiring/contract between lib and stage.

var assert = require('assert');
var stage = require('../engine/stages/fidelity-source-diff.cjs');
var fieldDiff = require('../engine/stages/lib/field-diff.cjs');

// ─── module surface ────────────────────────────────────────────────────────────
assert.strictEqual(stage.name, 'fidelity-source-diff');
assert.strictEqual(typeof stage.execute, 'function');
assert.strictEqual(typeof stage.canSkip, 'function');
assert.strictEqual(typeof stage.assertBefore, 'function');
assert.strictEqual(typeof stage._internals.resolvePixelGateThreshold, 'function');
assert.strictEqual(typeof stage._internals.DEFAULT_PIXEL_GATE_THRESHOLD_PERCENT, 'number');
assert.strictEqual(typeof stage._internals.runFieldLevelDiff, 'function');

// ─── bucket aggregator pattern (L143-147 in stage) ─────────────────────────────
// Reproduce the stage's per-phase aggregation: bucket = category.split('-')[0].
function aggregate(entries) {
  var buckets = {};
  var blocking = 0;
  var advisory = 0;
  entries.forEach(function(d) {
    if (!d || !d.category) return;
    var bucket = d.category.split('-')[0];
    buckets[bucket] = (buckets[bucket] || 0) + 1;
    if (d.blocking === false) advisory++;
    else blocking++;
  });
  return { buckets: buckets, blocking: blocking, advisory: advisory };
}

// ─── case A: in-viewport mismatch → 'anchor' bucket, blocking ──────────────────
var inVp = fieldDiff.runAnchorDiff('phase1',
  { Player: { x_px: 100, y_px: 100, w_px: 50, h_px: 50, provenance: 'extracted' } },
  { Player: { x_px: 200, y_px: 100, w_px: 50, h_px: 50 } },
  { width: 1280, height: 720 }, 8
);
var inVpAgg = aggregate(inVp);
assert.ok(inVpAgg.buckets.anchor > 0, 'in-viewport diffs must land in anchor bucket');
assert.strictEqual(inVpAgg.advisory, 0);
assert.strictEqual(inVpAgg.blocking, inVp.length);

// ─── case B: off-viewport mismatch → 'anchor' bucket, advisory ─────────────────
var offVp = fieldDiff.runAnchorDiff('phase1',
  { Coin: { x_px: 2000, y_px: 5000, w_px: 50, h_px: 50, provenance: 'extracted' } },
  { Coin: { x_px: 100, y_px: 100, w_px: 50, h_px: 50 } },
  { width: 1280, height: 720 }, 8
);
var offVpAgg = aggregate(offVp);
assert.ok(offVpAgg.buckets.anchor > 0, 'off-viewport diffs still land in anchor bucket');
assert.strictEqual(offVpAgg.blocking, 0, 'off-viewport diffs must all be advisory');
assert.strictEqual(offVpAgg.advisory, offVp.length);

// ─── case C: mixed entries (anchor + other categories) coexist ─────────────────
var mixed = inVp.concat([
  { category: 'entity-missing', blocking: true },
  { category: 'phase-mismatch', blocking: true },
  { category: 'hud-extra', blocking: true },
  { category: 'worldLabel-missing', blocking: false }
]);
var mixedAgg = aggregate(mixed);
assert.ok(mixedAgg.buckets.anchor > 0);
assert.strictEqual(mixedAgg.buckets.entity, 1);
assert.strictEqual(mixedAgg.buckets.phase, 1);
assert.strictEqual(mixedAgg.buckets.hud, 1);
assert.strictEqual(mixedAgg.buckets.worldLabel, 1);
assert.strictEqual(mixedAgg.advisory, 1, 'only worldLabel is advisory in this mix');

// ─── case D: empty inputs → no entries, no crash ───────────────────────────────
assert.strictEqual(fieldDiff.runAnchorDiff('phase1', {}, {}, { width: 1280, height: 720 }, 8).length, 0);

// ─── case E: actualAnchors missing entity → blocking diff (in viewport) ────────
var missingEnt = fieldDiff.runAnchorDiff('phase1',
  { Player: { x_px: 100, y_px: 100, w_px: 50, h_px: 50, provenance: 'extracted' } },
  {}, { width: 1280, height: 720 }, 8
);
assert.strictEqual(missingEnt.length, 1);
assert.strictEqual(missingEnt[0].actual, 'missing');
var missAgg = aggregate(missingEnt);
assert.strictEqual(missAgg.buckets.anchor, 1);
assert.strictEqual(missAgg.blocking, 1);

// ─── resolvePixelGateThreshold honors env override ────────────────────────────
var origEnv = process.env.FIDELITY_PIXEL_GATE_THRESHOLD_PERCENT;
delete process.env.FIDELITY_PIXEL_GATE_THRESHOLD_PERCENT;
assert.strictEqual(stage._internals.resolvePixelGateThreshold(),
  stage._internals.DEFAULT_PIXEL_GATE_THRESHOLD_PERCENT);
process.env.FIDELITY_PIXEL_GATE_THRESHOLD_PERCENT = '3';
assert.strictEqual(stage._internals.resolvePixelGateThreshold(), 3);
process.env.FIDELITY_PIXEL_GATE_THRESHOLD_PERCENT = '0';
assert.strictEqual(stage._internals.resolvePixelGateThreshold(), 0, '0 must bypass gate');
process.env.FIDELITY_PIXEL_GATE_THRESHOLD_PERCENT = 'invalid';
assert.strictEqual(stage._internals.resolvePixelGateThreshold(),
  stage._internals.DEFAULT_PIXEL_GATE_THRESHOLD_PERCENT);
if (origEnv === undefined) delete process.env.FIDELITY_PIXEL_GATE_THRESHOLD_PERCENT;
else process.env.FIDELITY_PIXEL_GATE_THRESHOLD_PERCENT = origEnv;

console.log('v1.2 fidelity source-diff anchor bucket tests passed');
