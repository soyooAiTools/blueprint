#!/usr/bin/env node
'use strict';

// task #52 (v1.4d-ε) + task #53 (v1.4d-ζ Axis A) — scripts/migrate-v1.3-to-v1.4d.cjs
// unit coverage. Uses tiny synthetic source HTML with a 3-phase PHASES array
// + ENTITY_STYLE block + minimal v1.3 contract; no Path B harness dependency.
// Also covers field-diff Stage 5 severity downgrade for plain-string
// pre-v1.4 contracts, and (task #53) golden 8-phase entity-label formula
// pinned against the real source HTML.
//
// Covers:
//   1. extractPhasesBlock catches `const PHASES = [...]`
//   2. parsePhases pulls `{id, guideText, firstStepTarget}` from each entry
//   3. buildPolymorphicHud produces correct {perPhase: {...}} for all 3 slots
//      — hud.targethint uses `entityStyleLabel[firstStepTarget]` (task #53)
//   4. happy path: 3-phase HTML + ENTITY_STYLE + v1.3 contract → bump 1.4.0,
//      all 3 hud slots rewritten as polymorphic
//   5. partial: PHASES missing → stays at 1.3.0 (partialMigration)
//   6. partial: 1 of 3 hud slots missing from contract → stays at 1.3.0
//   7. idempotency: re-run on v1.4 contract → 0 rewritten, 3 alreadyPolymorphic
//   8. forceReextract overwrites existing polymorphic records
//   9. no sourceHtml → partialMigration with v14d-no-source-html advisory
//  10. input schemaVersion not 1.3/1.4 → throws
//  11. preserves non-targeted hud entries verbatim (hud.iceHud / hud.label.*)
//  12. Stage 5: v1.3 plain-string contract + per-phase observed → blocking=false
//      (advisory downgrade, backward-compat for v0.5/v1.0~v1.3)
//  13. Stage 5: v1.4 polymorphic contract + matching observed → no diff
//  14. Stage 5: v1.4 plain-string contract + per-phase observed → blocking=true
//      (authoring bug at v1.4+)
//  15. Stage 5: non-eligible hud id (hud.iceHud) plain-string mismatch stays blocking
//  16. (task #53) golden 8-phase hud.targethint formula against real source HTML
//      — pins `"目标：" + ENTITY_STYLE[steps[0].target].label` for all 8 phases
//  17. (task #53) buildPolymorphicHud: missing ENTITY_STYLE label → phase
//      surfaced in unresolvedTargetHintPhases (slot skipped, no bad fold)
//  18. (task #53) migrate: ENTITY_STYLE missing entry → advisory gap
//      `v14d-targethint-unresolved` + hud.targethint slot left untouched +
//      schemaVersion stays at 1.3.0 (partial — no false 1.4 promotion)

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var migrateLib = require('../scripts/migrate-v1.3-to-v1.4d.cjs');
var fieldDiff = require('../engine/stages/lib/field-diff.cjs');

var tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-v14d-'));
function tmpPath(name) { return path.join(tmpRoot, name); }
function writeFile(p, content) { fs.writeFileSync(p, content, 'utf8'); return p; }

function syntheticHtml(opts) {
  opts = opts || {};
  if (opts.skipPhases) {
    return '<html><body><script>\nvar OTHER = 1;\n</script></body></html>\n';
  }
  var phases = opts.phases || [
    { id: 'phase1', guideText: 'go to A', firstStepTarget: 'EntityA' },
    { id: 'phase2', guideText: 'go to B', firstStepTarget: 'EntityB' },
    { id: 'phase3', guideText: 'go to C', firstStepTarget: 'EntityC' }
  ];
  var entityStyle = opts.entityStyle || {
    EntityA: 'A-label',
    EntityB: 'B-label',
    EntityC: 'C-label'
  };
  var entityEntries = Object.keys(entityStyle).map(function(name) {
    return '  ' + name + ':{label:"' + entityStyle[name] + '",color:0xffffff,kind:"k"}';
  }).join(',\n');
  var entries = phases.map(function(p) {
    var target = p.firstStepTarget || 'X';
    return '  {id:"' + p.id + '",name:"n",guideText:"' + p.guideText + '",steps:[{target:"' + target + '",label:"l"}],trigger:{type:"t"}}';
  }).join(',\n');
  return (
    '<html><body><script>\n' +
    'const ENTITY_STYLE = {\n' + entityEntries + '\n};\n' +
    'const PHASES = [\n' + entries + '\n];\n' +
    'window.PHASES = PHASES;\n' +
    '</script></body></html>\n'
  );
}

function baseV13Contract(opts) {
  opts = opts || {};
  var hud = opts.hud || [
    { id: 'hud.phase', text: 'Phase 1/3', role: 'hud-slot', consumer: ['hud-overlay'], anchor: { space: 'canvas-2d' }, provenance: { source: 'auth' } },
    { id: 'hud.tip', text: 'tip placeholder', role: 'hud-slot', consumer: ['hud-overlay'], anchor: { space: 'canvas-2d' }, provenance: { source: 'auth' } },
    { id: 'hud.targethint', text: 'old hint', role: 'hud-slot', consumer: ['hud-overlay'], anchor: { space: 'canvas-2d' }, provenance: { source: 'auth' } },
    { id: 'hud.iceHud', text: '冰 0', role: 'hud-slot', consumer: ['hud-overlay'], anchor: { space: 'canvas-2d' }, provenance: { source: 'auth' } }
  ];
  return {
    schemaVersion: opts.schemaVersion || '1.3.0',
    kind: 'blueprint.fidelityContract',
    producerVersion: 't', requiredCapabilities: [],
    coordinateSystem: { source: 'three-rh', target: 'unity-lh', handedness: 'h', zFlip: true, unitScale: 1 },
    rendererAdapter: {
      three: { shader: {}, animator: {}, physics: {}, audio: {}, ui: {} },
      unity: { shader: {}, animator: {}, physics: {}, audio: {}, ui: {} }
    },
    entities: [],
    phases: [],
    hud: hud,
    unityCoverage: { status: 'complete' },
    unresolvedFidelityGaps: [],
    contractConflicts: []
  };
}

// ─── case 1: extractPhasesBlock ───────────────────────────────────────────────
var html1 = syntheticHtml();
var block = migrateLib.extractPhasesBlock(html1);
assert.ok(block && block.length > 0, 'extractPhasesBlock should return non-empty body');
assert.strictEqual(migrateLib.extractPhasesBlock('<no phases here>'), null,
  'extractPhasesBlock returns null when PHASES absent');

// ─── case 2: parsePhases ──────────────────────────────────────────────────────
var phases1 = migrateLib.parsePhases(block);
assert.strictEqual(phases1.length, 3, 'parsePhases should find 3 entries');
assert.strictEqual(phases1[0].id, 'phase1');
assert.strictEqual(phases1[0].guideText, 'go to A');
assert.strictEqual(phases1[0].firstStepTarget, 'EntityA',
  'parsePhases should pull firstStepTarget from steps[0].target (task #53)');
assert.strictEqual(phases1[2].id, 'phase3');
assert.strictEqual(phases1[2].guideText, 'go to C');
assert.strictEqual(phases1[2].firstStepTarget, 'EntityC');

// ─── case 2b: extractEntityStyleBlock + parseEntityStyle (task #53) ───────────
var esBlock = migrateLib.extractEntityStyleBlock(html1);
assert.ok(esBlock && esBlock.length > 0, 'extractEntityStyleBlock should return non-empty body');
var entityStyle1 = migrateLib.parseEntityStyle(esBlock);
assert.strictEqual(entityStyle1.EntityA, 'A-label');
assert.strictEqual(entityStyle1.EntityB, 'B-label');
assert.strictEqual(entityStyle1.EntityC, 'C-label');

// ─── case 3: buildPolymorphicHud (task #53 — entity-label targethint) ─────────
var poly = migrateLib.buildPolymorphicHud(phases1, entityStyle1);
assert.deepStrictEqual(poly['hud.phase'], { perPhase: { phase1: 'Phase 1/3', phase2: 'Phase 2/3', phase3: 'Phase 3/3' } });
assert.deepStrictEqual(poly['hud.tip'], { perPhase: { phase1: 'go to A', phase2: 'go to B', phase3: 'go to C' } });
assert.deepStrictEqual(poly['hud.targethint'], { perPhase: {
  phase1: '\u76ee\u6807\uff1aA-label',
  phase2: '\u76ee\u6807\uff1aB-label',
  phase3: '\u76ee\u6807\uff1aC-label'
}}, 'hud.targethint must use ENTITY_STYLE[steps[0].target].label, not guideText (task #53)');
assert.deepStrictEqual(poly.unresolvedTargetHintPhases, [],
  'all 3 phases should resolve against ENTITY_STYLE');

// ─── case 4: happy path — bump 1.3.0 → 1.4.0, all 3 rewritten ─────────────────
var htmlPath4 = writeFile(tmpPath('case4.html'), html1);
var r4 = migrateLib.migrate(baseV13Contract(), { sourceHtml: htmlPath4 });
assert.strictEqual(r4.report.bumpedSchemaVersion, true);
assert.strictEqual(r4.report.toVersion, '1.4.0');
assert.strictEqual(r4.contract.schemaVersion, '1.4.0');
assert.strictEqual(r4.report.counts.hudSlotsRewritten, 3);
assert.strictEqual(r4.report.counts.phasesExtracted, 3);
var hudByIdR4 = {};
r4.contract.hud.forEach(function(h) { hudByIdR4[h.id] = h; });
assert.ok(hudByIdR4['hud.phase'].text.perPhase);
assert.strictEqual(hudByIdR4['hud.phase'].text.perPhase.phase2, 'Phase 2/3');
assert.strictEqual(hudByIdR4['hud.phase'].provenance.source, 'html',
  'rewritten HUD provenance must use validator-accepted source enum');

// ─── case 5: PHASES missing → stays at 1.3.0 ──────────────────────────────────
var htmlPath5 = writeFile(tmpPath('case5.html'), syntheticHtml({ skipPhases: true }));
var r5 = migrateLib.migrate(baseV13Contract(), { sourceHtml: htmlPath5 });
assert.strictEqual(r5.report.bumpedSchemaVersion, false);
assert.strictEqual(r5.contract.schemaVersion, '1.3.0');
assert.strictEqual(r5.report.counts.phasesExtracted, 0);
assert.ok(r5.report.advisoryGaps.some(function(g) { return g.id === 'v14d-phases-missing'; }));

// ─── case 6: missing hud slot → stays at 1.3.0, partial ───────────────────────
var c6 = baseV13Contract({ hud: [
  { id: 'hud.phase', text: 'Phase 1/3' },
  // hud.tip + hud.targethint missing
  { id: 'hud.iceHud', text: '冰 0' }
]});
var r6 = migrateLib.migrate(c6, { sourceHtml: htmlPath4 });
assert.strictEqual(r6.report.bumpedSchemaVersion, false);
assert.strictEqual(r6.report.counts.hudSlotsRewritten, 1);
assert.strictEqual(r6.report.counts.hudSlotsMissingInContract, 2);

// ─── case 7: idempotency — re-run on v1.4 contract is no-op ───────────────────
var r7 = migrateLib.migrate(r4.contract, { sourceHtml: htmlPath4 });
assert.strictEqual(r7.report.counts.hudSlotsRewritten, 0);
assert.strictEqual(r7.report.counts.hudSlotsAlreadyPolymorphic, 3);
assert.strictEqual(r7.contract.schemaVersion, '1.4.0');

// ─── case 8: forceReextract overwrites existing polymorphic records ───────────
var c8 = JSON.parse(JSON.stringify(r4.contract));
// mutate one polymorphic entry to confirm overwrite
c8.hud.forEach(function(h) { if (h.id === 'hud.phase') h.text = { perPhase: { phase1: 'MUTATED' } }; });
var r8 = migrateLib.migrate(c8, { sourceHtml: htmlPath4, forceReextract: true });
assert.strictEqual(r8.report.counts.hudSlotsRewritten, 3);
var phaseEntryR8 = r8.contract.hud.filter(function(h) { return h.id === 'hud.phase'; })[0];
assert.strictEqual(phaseEntryR8.text.perPhase.phase1, 'Phase 1/3', 'forceReextract should overwrite');

// ─── case 9: no sourceHtml → partialMigration with v14d-no-source-html ────────
var r9 = migrateLib.migrate(baseV13Contract(), {});
assert.strictEqual(r9.report.partialMigration, true);
assert.strictEqual(r9.contract.schemaVersion, '1.3.0');
assert.ok(r9.report.advisoryGaps.some(function(g) { return g.id === 'v14d-no-source-html'; }));

// ─── case 10: input schemaVersion not 1.3/1.4 → throws ────────────────────────
assert.throws(function() {
  migrateLib.migrate(baseV13Contract({ schemaVersion: '1.2.0' }), { sourceHtml: htmlPath4 });
}, /input schemaVersion must be 1.3.0 or 1.4.0/);

// ─── case 11: non-targeted hud entries preserved verbatim ─────────────────────
var iceEntryR4 = r4.contract.hud.filter(function(h) { return h.id === 'hud.iceHud'; })[0];
assert.strictEqual(iceEntryR4.text, '冰 0',
  'hud.iceHud (non-polymorphic-eligible) must be preserved verbatim');

// ─── case 12: Stage 5 severity downgrade — v1.3 plain-string + per-phase obs ─
// v1.3 contract has plain-string phase1 text; observed (per-phase extractor) reports
// per-phase strings. Mismatches MUST be advisory (blocking:false) for backward-compat.
var v13Contract = {
  schemaVersion: '1.3.0',
  hud: [
    { id: 'hud.phase', text: 'Phase 1/3', anchor: { space: 'canvas-2d' } },
    { id: 'hud.tip', text: 'tip phase1', anchor: { space: 'canvas-2d' } },
    { id: 'hud.iceHud', text: '冰 0', anchor: { space: 'canvas-2d' } }
  ],
  entities: [], phases: []
};
var indexed12 = fieldDiff.indexContract(v13Contract);
// observed phase2 has DIFFERENT text for hud.phase (per-phase dynamic)
var observed12 = { hud: [
  { id: 'hud.phase', text: 'Phase 2/3' },        // mismatch — should downgrade to advisory
  { id: 'hud.tip', text: 'tip phase2' },         // mismatch — should downgrade to advisory
  { id: 'hud.iceHud', text: '冰 0' }              // match
]};
var diffs12 = fieldDiff.diffHudBucket(indexed12, 'phase2', observed12);
var phaseDiff12 = diffs12.filter(function(d) { return d.id === 'hud.phase'; })[0];
var tipDiff12 = diffs12.filter(function(d) { return d.id === 'hud.tip'; })[0];
assert.ok(phaseDiff12, 'expected hud.phase mismatch entry');
assert.strictEqual(phaseDiff12.blocking, false,
  'v1.3 plain-string hud.phase per-phase mismatch must downgrade to advisory');
assert.ok(tipDiff12, 'expected hud.tip mismatch entry');
assert.strictEqual(tipDiff12.blocking, false,
  'v1.3 plain-string hud.tip per-phase mismatch must downgrade to advisory');

// ─── case 13: Stage 5 — v1.4 polymorphic matching → no diff ───────────────────
var v14ContractMatch = {
  schemaVersion: '1.4.0',
  hud: [
    { id: 'hud.phase', text: { perPhase: { phase1: 'Phase 1/3', phase2: 'Phase 2/3' } }, anchor: { space: 'canvas-2d' } },
    { id: 'hud.tip', text: { perPhase: { phase1: 'A', phase2: 'B' } }, anchor: { space: 'canvas-2d' } }
  ],
  entities: [], phases: []
};
var indexed13 = fieldDiff.indexContract(v14ContractMatch);
var observed13 = { hud: [
  { id: 'hud.phase', text: 'Phase 2/3' },
  { id: 'hud.tip', text: 'B' }
]};
var diffs13 = fieldDiff.diffHudBucket(indexed13, 'phase2', observed13);
assert.strictEqual(diffs13.length, 0,
  'v1.4 polymorphic matching observed should produce zero diffs (got ' + JSON.stringify(diffs13) + ')');

// ─── case 14: Stage 5 — v1.4 plain-string + per-phase obs → blocking=true ─────
var v14ContractPlainBug = {
  schemaVersion: '1.4.0',
  hud: [
    { id: 'hud.phase', text: 'Phase 1/3', anchor: { space: 'canvas-2d' } }  // authoring bug at v1.4
  ],
  entities: [], phases: []
};
var indexed14 = fieldDiff.indexContract(v14ContractPlainBug);
var observed14 = { hud: [{ id: 'hud.phase', text: 'Phase 2/3' }] };
var diffs14 = fieldDiff.diffHudBucket(indexed14, 'phase2', observed14);
assert.strictEqual(diffs14.length, 1);
assert.strictEqual(diffs14[0].blocking, true,
  'v1.4 plain-string on polymorphic-eligible id is authoring bug → blocking=true');

// ─── case 15: non-eligible id plain-string mismatch stays blocking ────────────
var v13ContractOther = {
  schemaVersion: '1.3.0',
  hud: [{ id: 'hud.iceHud', text: '冰 0', anchor: { space: 'canvas-2d' } }],
  entities: [], phases: []
};
var indexed15 = fieldDiff.indexContract(v13ContractOther);
var observed15 = { hud: [{ id: 'hud.iceHud', text: '冰 5' }] };
var diffs15 = fieldDiff.diffHudBucket(indexed15, 'phase1', observed15);
assert.strictEqual(diffs15.length, 1);
assert.strictEqual(diffs15[0].blocking, true,
  'hud.iceHud is NOT polymorphic-eligible — plain-string mismatch stays blocking');

// ─── case 16: task #53 golden — 8-phase hud.targethint formula against REAL source ─
// Reads the actual source-html the Path A harness consumes. Pins the
// `"目标：" + ENTITY_STYLE[steps[0].target].label` formula for every phase.
// If source HTML PHASES or ENTITY_STYLE drifts, this will fail loudly.
var REAL_SOURCE_HTML = '/opt/blueprint-editor/work/task25-sam-delivery-verify/unpacked/space-ranger-v0.5-fidelity-delivery/source-html/space-ranger-3d.html';
if (fs.existsSync(REAL_SOURCE_HTML)) {
  var realHtml = fs.readFileSync(REAL_SOURCE_HTML, 'utf8');
  var realPhasesBlock = migrateLib.extractPhasesBlock(realHtml);
  var realPhases = migrateLib.parsePhases(realPhasesBlock);
  assert.strictEqual(realPhases.length, 8, 'source HTML must declare 8 phases (task #53 golden)');
  var realEsBlock = migrateLib.extractEntityStyleBlock(realHtml);
  var realEntityStyle = migrateLib.parseEntityStyle(realEsBlock);

  // Golden mapping — frozen against source HTML L60-L85 ENTITY_STYLE +
  // L93-L101 PHASES[].steps[0].target. If this fails, EITHER:
  //   (a) source HTML changed → update this fixture intentionally, OR
  //   (b) parser drifted → fix parser.
  var GOLDEN_TARGETHINT = {
    phase1: '\u76ee\u6807\uff1a\u6c27\u6c14\u8d2d\u4e70\u53f0',   // 目标：氧气购买台 (OxygenShop)
    phase2: '\u76ee\u6807\uff1a\u5c0f\u51b0\u5757',              // 目标：小冰块 (IceSmall)
    phase3: '\u76ee\u6807\uff1a\u5927\u51b0\u5757',              // 目标：大冰块 (IceLarge)
    phase4: '\u76ee\u6807\uff1a\u5236\u6c27\u88c5\u7f6e',         // 目标：制氧装置 (OxygenPlant)
    phase5: '\u76ee\u6807\uff1a\u5927\u51b0\u5757',              // 目标：大冰块 (IceLarge)
    phase6: '\u76ee\u6807\uff1a\u7834\u788e\u88c5\u7f6e',         // 目标：破碎装置 (Crusher)
    phase7: '\u76ee\u6807\uff1a\u51b0\u5c01\u5783\u573e',         // 目标：冰封垃圾 (FrozenDebris)
    phase8: '\u76ee\u6807\uff1a\u7834\u788e\u88c5\u7f6e'          // 目标：破碎装置 (Crusher)
  };
  var GOLDEN_FIRST_STEP = {
    phase1: 'OxygenShop', phase2: 'IceSmall', phase3: 'IceLarge',
    phase4: 'OxygenPlant', phase5: 'IceLarge', phase6: 'Crusher',
    phase7: 'FrozenDebris', phase8: 'Crusher'
  };
  realPhases.forEach(function(p) {
    assert.strictEqual(p.firstStepTarget, GOLDEN_FIRST_STEP[p.id],
      'phase ' + p.id + ' firstStepTarget golden mismatch (got ' + p.firstStepTarget + ', expected ' + GOLDEN_FIRST_STEP[p.id] + ')');
    var label = realEntityStyle[p.firstStepTarget];
    assert.ok(label, 'ENTITY_STYLE label missing for ' + p.firstStepTarget);
  });
  var realPoly = migrateLib.buildPolymorphicHud(realPhases, realEntityStyle);
  assert.deepStrictEqual(realPoly.unresolvedTargetHintPhases, [],
    'all 8 real phases must resolve against ENTITY_STYLE');
  Object.keys(GOLDEN_TARGETHINT).forEach(function(pid) {
    assert.strictEqual(realPoly['hud.targethint'].perPhase[pid], GOLDEN_TARGETHINT[pid],
      'task #53 golden — hud.targethint perPhase[' + pid + '] mismatch');
  });
} else {
  console.log('  case 16 SKIPPED — real source HTML not present at ' + REAL_SOURCE_HTML);
}

// ─── case 17: buildPolymorphicHud — missing ENTITY_STYLE → unresolved phase ───
var phasesMissing = [
  { id: 'phase1', guideText: 'g1', firstStepTarget: 'KnownEntity' },
  { id: 'phase2', guideText: 'g2', firstStepTarget: 'UnknownEntity' }
];
var polyMissing = migrateLib.buildPolymorphicHud(phasesMissing, { KnownEntity: 'known-label' });
assert.deepStrictEqual(polyMissing.unresolvedTargetHintPhases, ['phase2'],
  'phase2 should be reported as unresolved (UnknownEntity not in ENTITY_STYLE)');
assert.strictEqual(polyMissing['hud.targethint'].perPhase.phase1, '\u76ee\u6807\uff1aknown-label');
assert.ok(!('phase2' in polyMissing['hud.targethint'].perPhase),
  'phase2 should NOT have a fabricated targethint entry');

// ─── case 18: migrate — ENTITY_STYLE missing entry → advisory + slot skipped ──
// Build a synthetic HTML where PHASES has 3 phases but ENTITY_STYLE only
// covers 2 of the targets. migrate() must:
//   (a) leave hud.targethint untouched (preserve plain-string old shape)
//   (b) emit advisory gap `v14d-targethint-unresolved`
//   (c) NOT bump schemaVersion (stays at 1.3.0)
var htmlPath18 = writeFile(tmpPath('case18.html'), syntheticHtml({
  phases: [
    { id: 'phase1', guideText: 'g1', firstStepTarget: 'EntityA' },
    { id: 'phase2', guideText: 'g2', firstStepTarget: 'EntityB' },
    { id: 'phase3', guideText: 'g3', firstStepTarget: 'EntityMissing' }
  ],
  entityStyle: { EntityA: 'A-label', EntityB: 'B-label' }
}));
var r18 = migrateLib.migrate(baseV13Contract(), { sourceHtml: htmlPath18 });
var targetHintEntry18 = r18.contract.hud.filter(function(h) { return h.id === 'hud.targethint'; })[0];
assert.strictEqual(targetHintEntry18.text, 'old hint',
  'hud.targethint should be left untouched when ENTITY_STYLE coverage is partial');
assert.ok(
  r18.report.advisoryGaps.some(function(g) { return g.id === 'v14d-targethint-unresolved'; }),
  'expected v14d-targethint-unresolved advisory gap'
);
assert.strictEqual(r18.contract.schemaVersion, '1.3.0',
  'partial ENTITY_STYLE coverage must NOT bump schemaVersion');
assert.strictEqual(r18.report.bumpedSchemaVersion, false);
// hud.phase + hud.tip should still be rewritten (independent of targethint)
var phaseEntry18 = r18.contract.hud.filter(function(h) { return h.id === 'hud.phase'; })[0];
assert.ok(phaseEntry18.text.perPhase, 'hud.phase should still rewrite under partial targethint');

console.log('migrate-v1.3-to-v1.4d.test.cjs PASS — 18 cases');
