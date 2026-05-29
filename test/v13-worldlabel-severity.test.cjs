#!/usr/bin/env node
'use strict';

// task #45 (v1.3) PR #32 Blocker #3 lock: shape-discriminated worldLabel
// severity. v1.3 rich-record `worldLabel = { text, worldOffset:{x,y,z}, color?,
// fontSize?, consumer? }` is a normative gate field — missing/mismatch BLOCKS
// acceptance (youth red line: "模型一致 + 视觉一致"). Legacy v0.5 plain-string
// / v1.1 polymorphic `{ default?, perPhase? }` / v0.5 transitional
// `hud.label.*` stays advisory (HTML overlay target legitimately does not
// render world-space labels in those era contracts; preserves backward-compat
// behavior that #29 originally locked).
//
// Jonny msg=9307fdee diagnosed the prior surface: `diffWorldLabelBucket()`
// hard-coded `blocking:false` on every entry AND the `runFieldLevelDiff` shim
// flatten ALSO hard-coded `blocking:false`. Real Path B trace: 24
// worldLabel-missing, blocking=0/advisory=24. With the fix both surfaces
// must split on shape.
//
// Asserts:
//   1. v1.3 rich worldLabel missing → blocking:true
//   2. v1.3 rich worldLabel mismatch → blocking:true
//   3. v1.1 polymorphic {default, perPhase} worldLabel missing → blocking:false (advisory)
//   4. v0.5 plain-string worldLabel missing → blocking:false (advisory)
//   5. v0.5 transitional hud.label.* missing → blocking:false (advisory)
//   6. runFieldLevelDiff shim transparently passes blocking flag through (no hard-code)
//   7. mixed contract (one rich + one legacy) → bucket emits BOTH severities

var assert = require('assert');
var fd = require('../engine/stages/lib/field-diff.cjs');

function makeContract(entities, hud) {
  return {
    schemaVersion: '1.3.0',
    phases: [{ id: 'phase1', showEntities: entities.map(function(e) { return '_' + (e.id || e.name).toLowerCase(); }) }],
    entities: entities,
    hud: hud || []
  };
}

// ─── case 1: v1.3 rich worldLabel missing → blocking:true ──────────────────────
var idx1 = fd.indexContract(makeContract([{
  id: 'Player',
  worldLabel: { text: '宇航员', worldOffset: { x: 0, y: 3.1, z: 0 }, color: '#ffffff', fontSize: 26 }
}]));
var wl1 = fd.diffWorldLabelBucket(idx1, 'phase1', {
  visibleEntities: ['Player'], entityDetails: { Player: {} }
});
assert.strictEqual(wl1.length, 1, 'v1.3 rich missing must emit one entry');
assert.strictEqual(wl1[0].status, 'missing');
assert.strictEqual(wl1[0].blocking, true,
  'v1.3 rich worldLabel missing MUST be blocking (youth red line: 模型一致 + 视觉一致)');
assert.strictEqual(wl1[0].entityId, 'Player');

// ─── case 2: v1.3 rich worldLabel mismatch → blocking:true ─────────────────────
var wl2 = fd.diffWorldLabelBucket(idx1, 'phase1', {
  visibleEntities: ['Player'],
  entityDetails: { Player: { worldLabel: '飞船' } } // wrong text
});
assert.strictEqual(wl2.length, 1);
assert.strictEqual(wl2[0].status, 'mismatch');
assert.strictEqual(wl2[0].blocking, true,
  'v1.3 rich worldLabel mismatch MUST be blocking');

// ─── case 3: v1.1 polymorphic worldLabel missing → blocking:false (advisory) ───
var idx3 = fd.indexContract(makeContract([{
  id: 'Player',
  worldLabel: { default: 'Player', perPhase: { phase1: 'Player (phase1)' } }
}]));
var wl3 = fd.diffWorldLabelBucket(idx3, 'phase1', {
  visibleEntities: ['Player'], entityDetails: { Player: {} }
});
assert.strictEqual(wl3.length, 1);
assert.strictEqual(wl3[0].status, 'missing');
assert.strictEqual(wl3[0].blocking, false,
  'v1.1 polymorphic {default, perPhase} worldLabel missing must stay advisory (backward compat)');

// ─── case 4: v0.5 plain-string worldLabel missing → blocking:false (advisory) ──
var idx4 = fd.indexContract(makeContract([{
  id: 'Player',
  worldLabel: 'Player'
}]));
var wl4 = fd.diffWorldLabelBucket(idx4, 'phase1', {
  visibleEntities: ['Player'], entityDetails: { Player: {} }
});
assert.strictEqual(wl4.length, 1);
assert.strictEqual(wl4[0].status, 'missing');
assert.strictEqual(wl4[0].blocking, false,
  'v0.5 plain-string worldLabel missing must stay advisory (backward compat)');

// ─── case 5: v0.5 transitional hud.label.* missing → blocking:false (advisory) ──
var idx5 = fd.indexContract(makeContract(
  [{ id: 'Player' /* no worldLabel field */ }],
  [{ id: 'label.Player', text: 'Player', role: 'world-label' }]
));
var wl5 = fd.diffWorldLabelBucket(idx5, 'phase1', {
  visibleEntities: ['Player'], entityDetails: { Player: {} }
});
assert.strictEqual(wl5.length, 1);
assert.strictEqual(wl5[0].status, 'missing');
assert.strictEqual(wl5[0].blocking, false,
  'v0.5 transitional hud.label.* missing must stay advisory (backward compat)');

// ─── case 6: runFieldLevelDiff shim transparently passes blocking through ──────
// Mixed contract: rich label on Player + legacy plain label on Ship. Shim must
// flatten BOTH, and the v1.3 rich entry must surface as blocking:true while the
// legacy entry stays blocking:false.
var template6 = fd.makeTemplateFromContract(makeContract([
  {
    id: 'Player',
    worldLabel: { text: '宇航员', worldOffset: { x: 0, y: 3.1, z: 0 } }
  },
  {
    id: 'Ship',
    worldLabel: 'Ship'
  }
]));
var flat6 = fd.runFieldLevelDiff(template6, 'phase1',
  { visibleEntities: ['Player', 'Ship'] }, // source — unused by current shim
  { visibleEntities: ['Player', 'Ship'], entityDetails: { Player: {}, Ship: {} } }
);
var wlFlat6 = flat6.filter(function(e) { return e.category === 'worldLabel-missing'; });
assert.strictEqual(wlFlat6.length, 2, 'shim must flatten both worldLabel-missing entries');
var playerFlat = wlFlat6.filter(function(e) { return e.path === 'worldLabel.Player'; })[0];
var shipFlat = wlFlat6.filter(function(e) { return e.path === 'worldLabel.Ship'; })[0];
assert.ok(playerFlat, 'shim must emit worldLabel.Player entry');
assert.ok(shipFlat, 'shim must emit worldLabel.Ship entry');
assert.strictEqual(playerFlat.blocking, true,
  'shim must NOT hard-code blocking:false — v1.3 rich Player must surface as blocking:true');
assert.strictEqual(shipFlat.blocking, false,
  'shim must NOT hard-code blocking:true — v0.5 plain-string Ship must stay advisory');

// ─── case 7: mixed bucket directly — both severities present ───────────────────
var idx7 = fd.indexContract(makeContract([
  {
    id: 'Player',
    worldLabel: { text: '宇航员', worldOffset: { x: 0, y: 3.1, z: 0 } }
  },
  {
    id: 'Ship',
    worldLabel: 'Ship'
  }
]));
var wl7 = fd.diffWorldLabelBucket(idx7, 'phase1', {
  visibleEntities: ['Player', 'Ship'], entityDetails: { Player: {}, Ship: {} }
});
assert.strictEqual(wl7.length, 2);
var blockingCount = wl7.filter(function(e) { return e.blocking === true; }).length;
var advisoryCount = wl7.filter(function(e) { return e.blocking === false; }).length;
assert.strictEqual(blockingCount, 1, 'one rich → blocking');
assert.strictEqual(advisoryCount, 1, 'one legacy → advisory');

console.log('v13-worldlabel-severity.test.cjs PASS');
console.log('  case 1 v1.3 rich missing      → blocking=' + wl1[0].blocking);
console.log('  case 2 v1.3 rich mismatch     → blocking=' + wl2[0].blocking);
console.log('  case 3 v1.1 polymorphic miss  → blocking=' + wl3[0].blocking);
console.log('  case 4 v0.5 plain string miss → blocking=' + wl4[0].blocking);
console.log('  case 5 v0.5 hud.label.* miss  → blocking=' + wl5[0].blocking);
console.log('  case 6 shim Player(rich)      → blocking=' + playerFlat.blocking);
console.log('  case 6 shim Ship(legacy)      → blocking=' + shipFlat.blocking);
console.log('  case 7 mixed bucket           → ' + blockingCount + ' blocking + ' + advisoryCount + ' advisory');
