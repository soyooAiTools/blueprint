#!/usr/bin/env node
'use strict';

// task #45 (v1.3): fidelityContract validator coverage for v1.3 field family.
//   - scene.backgroundColor (informative)
//   - entity.worldLabel rich record (text + worldOffset + optional color/fontSize/consumer)
//   - entity.primitiveStyle ({modelRef, baseColor[, baseColorHex]})
// Builds on v1.2 base (cameraTransform + projectedAnchors) so the validator's
// per-phase requireKeys still pass; v1.3 just layers on three new optional
// blocks. The validator must:
//   1. accept a clean v1.3 contract
//   2. reject malformed scene.backgroundColor (wrong shape / out-of-range)
//   3. reject malformed primitiveStyle (missing modelRef / wrong baseColor)
//   4. reject malformed worldLabel rich record (missing text or worldOffset)
//   5. still accept v1.2 contracts without scene / primitiveStyle / worldLabel
//   6. still accept v1.1 polymorphic-text worldLabel (back-compat for v1.1 base)

var assert = require('assert');
var fidelity = require('../engine/fidelity-contract.cjs');

function vec(x, y, z) { return { x: x, y: y, z: z }; }
function transform(x, y, z) {
  return { localPosition: vec(x, y, z), localRotation: vec(0, 0, 0), localScale: vec(1, 1, 1) };
}
function provenance() {
  return { source: 'unity', assetPath: 'a.unity', guid: 'g', fileID: '1', propertyPath: 'x', confidence: 1 };
}
function rendererAdapter() {
  return {
    three: { shader: { m: 1 }, animator: { m: 1 }, physics: { m: 1 }, audio: { m: 1 }, ui: { m: 1 } },
    unity: { shader: { m: 1 }, animator: { m: 1 }, physics: { m: 1 }, audio: { m: 1 }, ui: { m: 1 } }
  };
}
function baseEntity(id, extra) {
  var e = {
    id: id, name: id, parentPath: '/Root',
    transform: transform(0, 0, 0), pivot: vec(0, 0, 0),
    bounds: { center: vec(0, 0, 0), size: vec(1, 1, 1) },
    primitives: [{
      id: id + '.Body', name: id + '.Body', parentPath: '/Root/' + id,
      transform: transform(0, 0, 0), pivot: vec(0, 0, 0),
      bounds: { center: vec(0, 0, 0), size: vec(1, 1, 1) },
      mesh: { type: 'BoxGeometry', args: [1, 1, 1] },
      material: {
        id: 'm', shader: 'URP/Lit',
        colors: { _Color: [1, 1, 1, 1], _ColorTint: [1, 1, 1, 1], _EmissionColor: [0, 0, 0, 1] },
        alpha: 1, blendMode: 'opaque',
        guid: 'mat-guid', guidSeed: 's', guidAlgorithm: 'md5-lower-hex-32', contentHash: 'sha256:x'
      },
      provenance: provenance()
    }],
    provenance: provenance()
  };
  if (extra) Object.assign(e, extra);
  return e;
}
function anchor(prov, x, y, w, h) {
  var a = { x_px: x, y_px: y, w_px: w, h_px: h, provenance: prov };
  if (prov === 'extracted' || prov === 'anchor-only') {
    a.lookupPath = 'Scene/' + prov; a.matchedAlias = 'alias'; a.resolverRule = 'direct';
  }
  return a;
}
function phase(id, showEntities, anchors) {
  return {
    id: id, showEntities: showEntities,
    trigger: { type: 't' }, interactionGate: { type: 'g' },
    autoPlayGate: { type: 'g' }, manualGate: { type: 'g' },
    cameraTransform: { position: vec(0, 0, 0), target: vec(0, 0, 0) },
    projectedAnchors: anchors
  };
}
function v13Contract(opts) {
  opts = opts || {};
  return {
    schemaVersion: opts.schemaVersion || '1.3.0',
    kind: 'blueprint.fidelityContract',
    producerVersion: 't',
    requiredCapabilities: ['c1'],
    coordinateSystem: { source: 'three-rh', target: 'unity-lh', handedness: 'h', zFlip: true, unitScale: 1 },
    rendererAdapter: rendererAdapter(),
    entities: opts.entities || [baseEntity('Player')],
    phases: opts.phases || [phase('phase1', ['Player'], { Player: anchor('extracted', 100, 100, 50, 50) })],
    hud: [],
    scene: opts.scene,
    unityCoverage: { status: 'complete' },
    unresolvedFidelityGaps: [],
    contractConflicts: []
  };
}

// ─── case 1: clean v1.3 contract validates ─────────────────────────────────────
var clean = v13Contract({
  scene: { backgroundColor: [0.0275, 0.0627, 0.149], backgroundColorHex: '#071026' },
  entities: [baseEntity('Player', {
    worldLabel: {
      text: '玩家', worldOffset: { x: 0, y: 3.1, z: 0 },
      color: '#ffffff', fontSize: 26, consumer: ['worldOverlay']
    },
    primitiveStyle: { modelRef: 'astronaut', baseColor: [0.9098, 0.9843, 1.0], baseColorHex: '#e8fbff' }
  })]
});
var r = fidelity.validateFidelityContract(clean);
assert.strictEqual(r.valid, true, 'clean v1.3 contract should validate. errors=' + JSON.stringify(r.errors));

// ─── case 2a: malformed scene.backgroundColor — wrong arity ────────────────────
var badScene = v13Contract({ scene: { backgroundColor: [0.1, 0.2] } });
var r2a = fidelity.validateFidelityContract(badScene);
assert.strictEqual(r2a.valid, false, 'scene.backgroundColor with wrong arity must reject');
assert.ok(r2a.errors.some(function(e) { return /scene\.backgroundColor/.test(e); }),
  'expected error mentioning scene.backgroundColor; got ' + JSON.stringify(r2a.errors));

// ─── case 2b: malformed scene.backgroundColor — out of [0,1] range ─────────────
var oobScene = v13Contract({ scene: { backgroundColor: [1.5, 0, 0] } });
var r2b = fidelity.validateFidelityContract(oobScene);
assert.strictEqual(r2b.valid, false, 'scene.backgroundColor out-of-range must reject');

// ─── case 3a: missing primitiveStyle.modelRef ──────────────────────────────────
var noModelRef = v13Contract({
  entities: [baseEntity('Player', { primitiveStyle: { baseColor: [0.5, 0.5, 0.5] } })]
});
var r3a = fidelity.validateFidelityContract(noModelRef);
assert.strictEqual(r3a.valid, false, 'primitiveStyle.modelRef missing must reject');
assert.ok(r3a.errors.some(function(e) { return /primitiveStyle\.modelRef/.test(e); }),
  'expected error mentioning primitiveStyle.modelRef; got ' + JSON.stringify(r3a.errors));

// ─── case 3b: malformed primitiveStyle.baseColor — not 3-array ─────────────────
var badColor = v13Contract({
  entities: [baseEntity('Player', { primitiveStyle: { modelRef: 'astronaut', baseColor: [0.5, 0.5] } })]
});
var r3b = fidelity.validateFidelityContract(badColor);
assert.strictEqual(r3b.valid, false, 'primitiveStyle.baseColor wrong arity must reject');

// ─── case 4a: worldLabel rich record with non-numeric worldOffset rejects ──────
var badLabel = v13Contract({
  entities: [baseEntity('Player', {
    worldLabel: { text: '玩家', worldOffset: { x: 0, y: 'oops', z: 0 } }
  })]
});
var r4 = fidelity.validateFidelityContract(badLabel);
assert.strictEqual(r4.valid, false, 'worldLabel.worldOffset with non-numeric component must reject');
assert.ok(r4.errors.some(function(e) { return /worldOffset\.y/.test(e); }),
  'expected error mentioning worldOffset.y; got ' + JSON.stringify(r4.errors));

// ─── case 4b: worldLabel rich record with empty text rejects ───────────────────
var emptyTextLabel = v13Contract({
  entities: [baseEntity('Player', {
    worldLabel: { text: '', worldOffset: { x: 0, y: 3.1, z: 0 } }
  })]
});
// `text: ''` is a string but the rich-record path requires non-empty text. The
// dispatch L267 also checks `typeof label.text === 'string'`, which '' satisfies,
// so it routes to validateWorldLabelRecord which requires non-empty.
// But because empty-string text + numeric worldOffset still satisfies the rich
// dispatch (text is a string), the rich validator catches the empty-text issue.
// However isPlainObject(worldOffset) is true → routes to rich → rich rejects.
// So expect reject:
var r4b = fidelity.validateFidelityContract(emptyTextLabel);
assert.strictEqual(r4b.valid, false, 'worldLabel.text empty must reject under rich-record path');

// ─── case 5: clean v1.2 contract (no scene / primitiveStyle / worldLabel) ──────
var v12 = v13Contract({ schemaVersion: '1.2.0' });
delete v12.scene;
var r5 = fidelity.validateFidelityContract(v12);
assert.strictEqual(r5.valid, true,
  'v1.2 contract without v1.3 fields should still validate clean. errors=' + JSON.stringify(r5.errors));

// ─── case 6: v1.1 polymorphic-text worldLabel still accepted ───────────────────
var polyLabel = v13Contract({
  entities: [baseEntity('Player', {
    worldLabel: { default: '玩家', perPhase: { phase1: 'Player' } }
  })]
});
var r6 = fidelity.validateFidelityContract(polyLabel);
assert.strictEqual(r6.valid, true,
  'v1.1 polymorphic-text worldLabel must remain accepted under v1.3. errors=' + JSON.stringify(r6.errors));

console.log('fidelity-contract-v13-fields.test.cjs PASS');
