#!/usr/bin/env node
'use strict';

// task #45 (v1.4b) — scripts/migrate-v1.2-to-v1.3.cjs unit coverage.
// Uses tiny synthetic source HTML + minimal v1.2 contract; no Path B harness
// dependency. Covers:
//   1. extractBackgroundColorHex regex catches SCENE_CONFIG.backgroundColor
//   2. extractEntityStyleMap regex catches per-entity {label, color, kind}
//   3. hexToLinearRgb (0x → linear-RGB 0..1, 4-decimal precision)
//   4. happy path: bg + 2/2 entities → schemaVersion bumps to 1.3.0
//   5. partial: bg extracted but 1 entity not in source → bumps when source-declared coverage is full
//   6. partial: bg missing → stays at 1.2.0 (partialMigration)
//   7. idempotency: re-run on v1.3 contract is no-op (preservedExistingWorldLabel)
//   8. forceReextract overwrites existing worldLabel + primitiveStyle
//   9. no sourceHtml → partialMigration with v13-no-source-html advisory
//  10. input schemaVersion not 1.2/1.3 → throws
//  11. unknown modelKind tracked in report.unknownModelKinds

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var migrateLib = require('../scripts/migrate-v1.2-to-v1.3.cjs');

var tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-v13-'));
function tmpPath(name) { return path.join(tmpRoot, name); }

function writeFile(p, content) { fs.writeFileSync(p, content, 'utf8'); return p; }

function syntheticHtml(opts) {
  opts = opts || {};
  var entities = opts.entities || { Player: { label: '玩家', color: '0xe8fbff', kind: 'astronaut' },
                                     OxygenShop: { label: '氧气站', color: '0xff8800', kind: 'station' } };
  var styleEntries = Object.keys(entities).map(function(id) {
    var e = entities[id];
    return '    ' + id + ': { label: "' + e.label + '", color: ' + e.color + ', kind: "' + e.kind + '" }';
  }).join(',\n');
  var sceneBlock = opts.skipScene
    ? ''
    : 'const SCENE_CONFIG = {\n  backgroundColor: ' + (opts.bg || '0x071026') + ',\n  ambient: 0x444444,\n};\n';
  var styleBlockWrapper = opts.skipStyle
    ? ''
    : 'const ENTITY_STYLE = {\n' + styleEntries + '\n};\n';
  return '<html><body><script>\n' + sceneBlock + styleBlockWrapper + '</script></body></html>\n';
}

function baseContract(opts) {
  opts = opts || {};
  return {
    schemaVersion: opts.schemaVersion || '1.2.0',
    kind: 'blueprint.fidelityContract',
    producerVersion: 't', requiredCapabilities: ['c1'],
    coordinateSystem: { source: 'three-rh', target: 'unity-lh', handedness: 'h', zFlip: true, unitScale: 1 },
    rendererAdapter: {
      three: { shader: {}, animator: {}, physics: {}, audio: {}, ui: {} },
      unity: { shader: {}, animator: {}, physics: {}, audio: {}, ui: {} }
    },
    entities: opts.entities || [
      { id: 'Player', name: 'Player', parentPath: '/Root',
        transform: {}, pivot: {}, bounds: {}, primitives: [], provenance: { source: 'unity', confidence: 1 } },
      { id: 'OxygenShop', name: 'OxygenShop', parentPath: '/Root',
        transform: {}, pivot: {}, bounds: {}, primitives: [], provenance: { source: 'unity', confidence: 1 } }
    ],
    phases: [], hud: [],
    unityCoverage: { status: 'complete' },
    unresolvedFidelityGaps: [], contractConflicts: []
  };
}

// ─── case 1: extractBackgroundColorHex ─────────────────────────────────────────
var html1 = syntheticHtml();
assert.strictEqual(migrateLib.extractBackgroundColorHex(html1), '071026',
  'extractBackgroundColorHex should match 0x071026');
assert.strictEqual(migrateLib.extractBackgroundColorHex('<no scene block>'), null,
  'extractBackgroundColorHex returns null on missing block');

// ─── case 2: extractEntityStyleMap ─────────────────────────────────────────────
var styleMap = migrateLib.extractEntityStyleMap(html1);
assert.deepStrictEqual(Object.keys(styleMap).sort(), ['OxygenShop', 'Player']);
assert.deepStrictEqual(styleMap.Player, { label: '玩家', colorHex: 'e8fbff', kind: 'astronaut' });
assert.deepStrictEqual(styleMap.OxygenShop, { label: '氧气站', colorHex: 'ff8800', kind: 'station' });

// ─── case 3: hexToLinearRgb ────────────────────────────────────────────────────
var rgb = migrateLib.hexToLinearRgb('071026');
assert.deepStrictEqual(rgb, [0.0275, 0.0627, 0.149]);
var white = migrateLib.hexToLinearRgb('ffffff');
assert.deepStrictEqual(white, [1, 1, 1]);

// ─── case 4: happy path bump to 1.3.0 ──────────────────────────────────────────
var src4 = writeFile(tmpPath('case4.html'), html1);
var out4 = migrateLib.migrate(baseContract(), { sourceHtml: src4 });
assert.strictEqual(out4.report.bumpedSchemaVersion, true, 'happy path must bump');
assert.strictEqual(out4.contract.schemaVersion, '1.3.0');
assert.deepStrictEqual(out4.contract.scene.backgroundColor, [0.0275, 0.0627, 0.149]);
assert.strictEqual(out4.contract.entities[0].worldLabel.text, '玩家');
assert.deepStrictEqual(out4.contract.entities[0].worldLabel.worldOffset, { x: 0, y: 3.1, z: 0 });
assert.strictEqual(out4.contract.entities[0].primitiveStyle.modelRef, 'astronaut');
assert.deepStrictEqual(out4.contract.entities[0].primitiveStyle.baseColor, [0.9098, 0.9843, 1]);
assert.strictEqual(out4.report.counts.worldLabelPopulated, 2);
assert.strictEqual(out4.report.counts.primitiveStylePopulated, 2);

// ─── case 5: bg + auxiliary entity → still bumps (source-declared coverage rule) ──
var src5 = writeFile(tmpPath('case5.html'), html1);
var ct5 = baseContract();
ct5.entities.push({
  id: 'LaserLine', name: 'LaserLine', parentPath: '/Root',
  transform: {}, pivot: {}, bounds: {}, primitives: [], provenance: { source: 'unity', confidence: 1 }
});
var out5 = migrateLib.migrate(ct5, { sourceHtml: src5 });
assert.strictEqual(out5.report.bumpedSchemaVersion, true,
  'auxiliary entities not in source must NOT block bump (Unity-internal effect overlays)');
assert.strictEqual(out5.contract.schemaVersion, '1.3.0');
assert.strictEqual(out5.report.counts.entitiesMissingFromSource, 1);
assert.ok(out5.report.advisoryGaps.some(function(g) { return g.id === 'v13-entity-not-in-source:LaserLine'; }),
  'expect advisory gap for LaserLine');

// ─── case 6: bg missing → stays at 1.2.0 ───────────────────────────────────────
var html6 = syntheticHtml({ skipScene: true });
var src6 = writeFile(tmpPath('case6.html'), html6);
var out6 = migrateLib.migrate(baseContract(), { sourceHtml: src6 });
assert.strictEqual(out6.report.bumpedSchemaVersion, false, 'bg missing must NOT bump');
assert.strictEqual(out6.contract.schemaVersion, '1.2.0', 'schemaVersion stays at 1.2.0');
assert.strictEqual(out6.report.partialMigration, true);
assert.strictEqual(out6.report.counts.backgroundColorExtracted, false);
// worldLabel + primitiveStyle still populated (data shipped, just no schema bump)
assert.strictEqual(out6.report.counts.worldLabelPopulated, 2);

// ─── case 7: idempotency on v1.3 input ─────────────────────────────────────────
var out7 = migrateLib.migrate(out4.contract, { sourceHtml: src4 });
assert.strictEqual(out7.contract.schemaVersion, '1.3.0');
// preservedExistingWorldLabel counts the no-op preserve
assert.strictEqual(out7.report.counts.preservedExistingWorldLabel, 2,
  'second run preserves existing worldLabel');
assert.strictEqual(out7.report.counts.worldLabelPopulated, 0,
  'second run does not re-populate worldLabel');
// bump check: source-declared (2) == covered (preserved 2) → still bumps to 1.3
assert.strictEqual(out7.report.bumpedSchemaVersion, true);

// ─── case 8: forceReextract overwrites ─────────────────────────────────────────
// Mutate contract.entities[0].worldLabel.text to a stale value, then force.
var stale = JSON.parse(JSON.stringify(out4.contract));
stale.entities[0].worldLabel.text = 'STALE';
var out8 = migrateLib.migrate(stale, { sourceHtml: src4, forceReextract: true });
assert.strictEqual(out8.contract.entities[0].worldLabel.text, '玩家',
  'forceReextract overwrites stale worldLabel.text');
assert.strictEqual(out8.report.counts.worldLabelPopulated, 2,
  'forceReextract counts re-population, not preservation');

// ─── case 9: no sourceHtml → partial advisory ──────────────────────────────────
var out9 = migrateLib.migrate(baseContract(), {});
assert.strictEqual(out9.report.partialMigration, true);
assert.strictEqual(out9.report.bumpedSchemaVersion, false);
assert.strictEqual(out9.contract.schemaVersion, '1.2.0');
assert.ok(out9.report.advisoryGaps.some(function(g) { return g.id === 'v13-no-source-html'; }),
  'expect v13-no-source-html advisory');

// ─── case 10: bad input schemaVersion throws ───────────────────────────────────
assert.throws(function() {
  migrateLib.migrate(baseContract({ schemaVersion: '1.1.0' }), { sourceHtml: src4 });
}, /input schemaVersion must be 1\.2\.0 or 1\.3\.0/);
assert.throws(function() { migrateLib.migrate(null); }, /must be an object/);

// ─── case 11: unknown modelKind tracked ────────────────────────────────────────
var html11 = syntheticHtml({ entities: {
  Player: { label: '玩家', color: '0xe8fbff', kind: 'astronaut' },
  Weird: { label: '怪东西', color: '0xff00ff', kind: 'spaceyak' }
}});
var src11 = writeFile(tmpPath('case11.html'), html11);
var ct11 = baseContract();
ct11.entities = [
  ct11.entities[0],
  { id: 'Weird', name: 'Weird', parentPath: '/Root',
    transform: {}, pivot: {}, bounds: {}, primitives: [], provenance: { source: 'unity', confidence: 1 } }
];
var out11 = migrateLib.migrate(ct11, { sourceHtml: src11 });
assert.deepStrictEqual(out11.report.unknownModelKinds, ['spaceyak'],
  'unknown kind tracked for #46 writer fallback');
assert.strictEqual(out11.contract.entities[1].primitiveStyle.modelRef, 'spaceyak',
  'unknown kind still set as modelRef (writer will fallback)');

// cleanup
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { /* ignore */ }

console.log('migrate-v1.2-to-v1.3.test.cjs PASS');
