#!/usr/bin/env node
'use strict';

// v1.2.0 anchor bucket — runAnchorDiff unit tests.
// Locked 2026-05-29: derive-at-consume viewportIntersection from expected
// x/y/w/h vs viewport baseline (NEVER from contract record). Off-viewport
// expected anchors route to advisory (category=anchor-mismatch-off-viewport,
// blocking:false). Category prefix 'anchor-*' so stage-layer bucket aggregator
// (split('-')[0]) routes entries into 'anchor' bucket.

var assert = require('assert');
var fieldDiff = require('../engine/stages/lib/field-diff.cjs');

var runAnchorDiff = fieldDiff.runAnchorDiff;
assert.strictEqual(typeof runAnchorDiff, 'function', 'runAnchorDiff should be exported');

var VIEWPORT = { width: 1280, height: 720 };

// ─── happy path: 0 diffs when actual matches expected exactly ─────────────────
var hp = runAnchorDiff('phase1',
  { Player: { x_px: 100, y_px: 100, w_px: 50, h_px: 50, provenance: 'extracted' } },
  { Player: { x_px: 100, y_px: 100, w_px: 50, h_px: 50 } },
  VIEWPORT, 8
);
assert.strictEqual(hp.length, 0, 'exact match should produce 0 diffs. got=' + JSON.stringify(hp));

// ─── within tolerance: 0 diffs ────────────────────────────────────────────────
var withinTol = runAnchorDiff('phase1',
  { Player: { x_px: 100, y_px: 100, w_px: 50, h_px: 50, provenance: 'extracted' } },
  { Player: { x_px: 105, y_px: 103, w_px: 51, h_px: 49 } },
  VIEWPORT, 8
);
assert.strictEqual(withinTol.length, 0, 'within tolerance should produce 0 diffs');

// ─── exceeds tolerance: per-field diffs with deltaPx + blocking:true ──────────
var exceedTol = runAnchorDiff('phase1',
  { Player: { x_px: 100, y_px: 100, w_px: 50, h_px: 50, provenance: 'extracted' } },
  { Player: { x_px: 120, y_px: 130, w_px: 50, h_px: 50 } },
  VIEWPORT, 8
);
assert.strictEqual(exceedTol.length, 2, 'should have 2 field diffs (x, y). got=' + JSON.stringify(exceedTol));
exceedTol.forEach(function(e) {
  assert.strictEqual(e.category, 'anchor-mismatch');
  assert.strictEqual(e.blocking, true);
  assert.strictEqual(e.tolerancePx, 8);
  assert.ok(e.deltaPx > 8);
});
var xDiff = exceedTol.find(function(e) { return e.key === 'x_px'; });
assert.strictEqual(xDiff.expected, 100);
assert.strictEqual(xDiff.actual, 120);
assert.strictEqual(xDiff.deltaPx, 20);

// ─── off-viewport: advisory (blocking:false, category=anchor-mismatch-off-viewport) ──
// expected rect is fully outside viewport (x > W)
var offVp = runAnchorDiff('phase1',
  { Player: { x_px: 2000, y_px: 5000, w_px: 50, h_px: 50, provenance: 'extracted' } },
  { Player: { x_px: 100, y_px: 100, w_px: 50, h_px: 50 } }, // massively different
  VIEWPORT, 8
);
assert.ok(offVp.length > 0, 'off-viewport with mismatch should produce diffs');
offVp.forEach(function(e) {
  assert.strictEqual(e.category, 'anchor-mismatch-off-viewport');
  assert.strictEqual(e.blocking, false, 'off-viewport entries must be advisory');
});

// ─── bbox-rect (not center-point): partially in viewport = in-viewport ────────
// expected x=-20 w=50 means right edge at 30 — still intersects [0, 1280]
var partial = runAnchorDiff('phase1',
  { Player: { x_px: -20, y_px: -20, w_px: 50, h_px: 50, provenance: 'extracted' } },
  { Player: { x_px: 100, y_px: 100, w_px: 50, h_px: 50 } },
  VIEWPORT, 8
);
assert.ok(partial.length > 0);
partial.forEach(function(e) {
  assert.strictEqual(e.category, 'anchor-mismatch', 'partial-in-viewport should be blocking');
  assert.strictEqual(e.blocking, true);
});

// ─── missing actual: entry per missing entity ─────────────────────────────────
var missingActual = runAnchorDiff('phase1',
  { Player: { x_px: 100, y_px: 100, w_px: 50, h_px: 50, provenance: 'extracted' } },
  {}, // no actual entries
  VIEWPORT, 8
);
assert.strictEqual(missingActual.length, 1);
assert.strictEqual(missingActual[0].category, 'anchor-mismatch');
assert.strictEqual(missingActual[0].actual, 'missing');
assert.strictEqual(missingActual[0].blocking, true);

// ─── missing actual + off-viewport expected: advisory ─────────────────────────
var missingOffVp = runAnchorDiff('phase1',
  { Player: { x_px: 5000, y_px: 5000, w_px: 50, h_px: 50, provenance: 'extracted' } },
  {},
  VIEWPORT, 8
);
assert.strictEqual(missingOffVp.length, 1);
assert.strictEqual(missingOffVp[0].category, 'anchor-mismatch-off-viewport');
assert.strictEqual(missingOffVp[0].blocking, false);

// ─── null/undefined inputs: empty result, no throw ────────────────────────────
assert.strictEqual(runAnchorDiff('p1', null, {}, VIEWPORT, 8).length, 0);
assert.strictEqual(runAnchorDiff('p1', undefined, {}, VIEWPORT, 8).length, 0);
assert.strictEqual(runAnchorDiff('p1', {}, null, VIEWPORT, 8).length, 0);

// ─── default viewport (1280×720) when omitted ─────────────────────────────────
var noVp = runAnchorDiff('p1',
  { Player: { x_px: 1500, y_px: 100, w_px: 50, h_px: 50 } },
  { Player: { x_px: 100, y_px: 100, w_px: 50, h_px: 50 } },
  null, 8
);
assert.ok(noVp.length > 0);
assert.strictEqual(noVp[0].category, 'anchor-mismatch-off-viewport',
  'expected x=1500 > default W=1280 so should be off-viewport');

// ─── default tolerance 8px when omitted/invalid ───────────────────────────────
var defTol = runAnchorDiff('p1',
  { Player: { x_px: 100, y_px: 100, w_px: 50, h_px: 50 } },
  { Player: { x_px: 105, y_px: 100, w_px: 50, h_px: 50 } },
  VIEWPORT // tolerance omitted
);
assert.strictEqual(defTol.length, 0, '5px delta within default 8px tolerance');

// ─── bucket-aggregator-compatibility: category split on '-' yields 'anchor' ───
var bucketTest = runAnchorDiff('p1',
  { Player: { x_px: 100, y_px: 100, w_px: 50, h_px: 50, provenance: 'extracted' } },
  { Player: { x_px: 200, y_px: 100, w_px: 50, h_px: 50 } },
  VIEWPORT, 8
);
assert.ok(bucketTest.length > 0);
assert.strictEqual(bucketTest[0].category.split('-')[0], 'anchor',
  'category prefix must be "anchor" so stage aggregator buckets correctly');

// ─── path field populated for stage-level entry shape compat ──────────────────
assert.ok(bucketTest[0].path.indexOf('phases.p1.projectedAnchors.Player') === 0,
  'path should be phase-keyed for stage-layer report grouping');

console.log('v1.2 anchor diff tests passed');
