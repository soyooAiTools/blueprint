#!/usr/bin/env node
'use strict';

// v1.2.0 fidelityContract validator + per-entity anchor delta tests.
// Locked 2026-05-29 via triple sign-off + youth-nick ratify:
//   - cameraTransform (informative) + projectedAnchors (normative) required at v1.2+
//   - 1:1 showEntities ↔ projectedAnchors enforcement (vacuous when both empty)
//   - persistence boundary: visibility booleans MUST NOT appear in anchor records
//   - diffFidelityRoundTrip uses per-entity tolerance (DEFAULT_ANCHOR_TOLERANCE_PX)

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
function entity(id) {
  return {
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
}
function anchor(provenanceKind, x, y, w, h) {
  var a = { x_px: x, y_px: y, w_px: w, h_px: h, provenance: provenanceKind };
  if (provenanceKind === 'extracted' || provenanceKind === 'anchor-only') {
    a.lookupPath = 'Scene/' + provenanceKind;
    a.matchedAlias = 'alias';
    a.resolverRule = 'direct';
  }
  return a;
}
function v12Contract(phases) {
  return {
    schemaVersion: '1.2.0',
    kind: 'blueprint.fidelityContract',
    producerVersion: 't',
    requiredCapabilities: ['c1'],
    coordinateSystem: { source: 'three-rh', target: 'unity-lh', handedness: 'h', zFlip: true, unitScale: 1 },
    rendererAdapter: rendererAdapter(),
    entities: [entity('Player'), entity('Coin')],
    phases: phases,
    hud: [],
    unityCoverage: { status: 'complete' },
    unresolvedFidelityGaps: [],
    contractConflicts: []
  };
}
function v12Phase(id, showEntities, anchors, opts) {
  var p = {
    id: id,
    showEntities: showEntities,
    trigger: { type: 't' },
    interactionGate: { type: 'g' },
    autoPlayGate: { type: 'g' },
    manualGate: { type: 'g' },
    cameraTransform: { position: vec(0, 0, 0), target: vec(0, 0, 0) },
    projectedAnchors: anchors
  };
  if (opts) Object.assign(p, opts);
  return p;
}

// ─── happy path: v1.2 contract with 1:1 anchors validates clean ────────────────
var happy = v12Contract([
  v12Phase('phase1', ['Player', 'Coin'], {
    Player: anchor('extracted', 100, 100, 50, 50),
    Coin: anchor('extracted', 200, 200, 30, 30)
  })
]);
var result = fidelity.validateFidelityContract(happy);
assert.strictEqual(result.valid, true, 'v1.2 happy path should validate clean. errors=' + JSON.stringify(result.errors));

// ─── 1:1 enforcement: showEntities entry missing from projectedAnchors blocks ──
var oneOneMissing = v12Contract([
  v12Phase('phase1', ['Player', 'Coin'], {
    Player: anchor('extracted', 100, 100, 50, 50)
    // Coin missing
  })
]);
var ooResult = fidelity.validateFidelityContract(oneOneMissing);
assert.strictEqual(ooResult.valid, false, '1:1 missing should block');
assert.ok(ooResult.errors.some(function(e) { return /projectedAnchors\.Coin is required \(1:1/.test(e); }),
  '1:1 error should be specific. errors=' + JSON.stringify(ooResult.errors));

// ─── empty showEntities + empty projectedAnchors is valid (vacuous 1:1) ────────
var emptyPhase = v12Contract([
  v12Phase('phase1', [], {})
]);
var epResult = fidelity.validateFidelityContract(emptyPhase);
assert.strictEqual(epResult.valid, true, 'empty showEntities + {} should be valid. errors=' + JSON.stringify(epResult.errors));

// ─── omit projectedAnchors key = blocks (per requiredKeys) ─────────────────────
var omitAnchors = v12Contract([
  v12Phase('phase1', [], {}, { projectedAnchors: undefined })
]);
delete omitAnchors.phases[0].projectedAnchors;
var omitResult = fidelity.validateFidelityContract(omitAnchors);
assert.strictEqual(omitResult.valid, false, 'omit projectedAnchors should block');
assert.ok(omitResult.errors.some(function(e) { return /projectedAnchors is required/.test(e); }),
  'omit error should be specific. errors=' + JSON.stringify(omitResult.errors));

// ─── invalid provenance enum blocks ────────────────────────────────────────────
var badProv = v12Contract([
  v12Phase('phase1', ['Player'], {
    Player: { x_px: 100, y_px: 100, w_px: 50, h_px: 50, provenance: 'wrong-value' }
  })
]);
var bpResult = fidelity.validateFidelityContract(badProv);
assert.strictEqual(bpResult.valid, false, 'invalid provenance should block');
assert.ok(bpResult.errors.some(function(e) { return /provenance must be one of/.test(e); }),
  'provenance error should be specific. errors=' + JSON.stringify(bpResult.errors));

// ─── persistence boundary: visibility booleans in anchor blocks ────────────────
var taintedAnchor = anchor('extracted', 100, 100, 50, 50);
taintedAnchor.effectiveVisible = true;
taintedAnchor.viewportIntersection = true;
taintedAnchor.selfVisible = true;
var tainted = v12Contract([
  v12Phase('phase1', ['Player'], { Player: taintedAnchor })
]);
var taintedResult = fidelity.validateFidelityContract(tainted);
assert.strictEqual(taintedResult.valid, false, 'visibility booleans in anchor record should block');
['selfVisible', 'effectiveVisible', 'viewportIntersection'].forEach(function(k) {
  assert.ok(taintedResult.errors.some(function(e) { return e.indexOf(k) >= 0; }),
    'persistence boundary error for ' + k + ' missing. errors=' + JSON.stringify(taintedResult.errors));
});

// ─── inferred-default provenance allows missing audit fields ───────────────────
var inferredAnchor = { x_px: 0, y_px: 0, w_px: 50, h_px: 50, provenance: 'inferred-default' };
var inferred = v12Contract([
  v12Phase('phase1', ['Player'], { Player: inferredAnchor })
]);
var infResult = fidelity.validateFidelityContract(inferred);
assert.strictEqual(infResult.valid, true, 'inferred-default with no audit fields should validate. errors=' + JSON.stringify(infResult.errors));

// ─── extracted provenance REQUIRES audit fields ────────────────────────────────
var extractedMissing = { x_px: 100, y_px: 100, w_px: 50, h_px: 50, provenance: 'extracted' };
var extMissing = v12Contract([
  v12Phase('phase1', ['Player'], { Player: extractedMissing })
]);
var emResult = fidelity.validateFidelityContract(extMissing);
assert.strictEqual(emResult.valid, false, 'extracted without audit fields should block');
assert.ok(emResult.errors.some(function(e) { return /lookupPath must be a non-empty string/.test(e); }),
  'lookupPath enforcement missing. errors=' + JSON.stringify(emResult.errors));

// ─── negative dimensions block ─────────────────────────────────────────────────
var negDim = v12Contract([
  v12Phase('phase1', ['Player'], {
    Player: { x_px: 0, y_px: 0, w_px: -5, h_px: 50, provenance: 'inferred-default' }
  })
]);
var ndResult = fidelity.validateFidelityContract(negDim);
assert.strictEqual(ndResult.valid, false, 'negative w_px should block');

// ─── non-finite numerics block ─────────────────────────────────────────────────
var nan = v12Contract([
  v12Phase('phase1', ['Player'], {
    Player: { x_px: NaN, y_px: 0, w_px: 50, h_px: 50, provenance: 'inferred-default' }
  })
]);
var nanResult = fidelity.validateFidelityContract(nan);
assert.strictEqual(nanResult.valid, false, 'NaN x_px should block');

// ─── diffFidelityRoundTrip — within tolerance passes ───────────────────────────
var rtBase = v12Contract([
  v12Phase('phase1', ['Player'], {
    Player: anchor('extracted', 100, 100, 50, 50)
  })
]);
var rtActualClose = JSON.parse(JSON.stringify(rtBase));
rtActualClose.phases[0].projectedAnchors.Player.x_px = 105; // 5px shift, within 8px tolerance
var rtCloseResult = fidelity.diffFidelityRoundTrip(rtBase, rtActualClose);
assert.strictEqual(rtCloseResult.passed, true, 'within-tolerance shift should pass roundtrip. diffs=' + JSON.stringify(rtCloseResult.diffs));

// ─── diffFidelityRoundTrip — exceeds tolerance fails with deltaPx ──────────────
var rtActualFar = JSON.parse(JSON.stringify(rtBase));
rtActualFar.phases[0].projectedAnchors.Player.x_px = 120; // 20px shift > 8
var rtFarResult = fidelity.diffFidelityRoundTrip(rtBase, rtActualFar);
assert.strictEqual(rtFarResult.passed, false, 'out-of-tolerance shift should fail roundtrip');
var farDiff = rtFarResult.diffs.find(function(d) { return d.path === 'phases.phase1.projectedAnchors.Player.x_px'; });
assert.ok(farDiff, 'specific anchor diff missing. diffs=' + JSON.stringify(rtFarResult.diffs));
assert.strictEqual(farDiff.deltaPx, 20);
assert.strictEqual(farDiff.tolerancePx, 8);

// ─── diffFidelityRoundTrip — missing actual anchor flagged ─────────────────────
var rtMissing = JSON.parse(JSON.stringify(rtBase));
delete rtMissing.phases[0].projectedAnchors.Player;
// also fix 1:1 so contract validates (showEntities still has Player → would block)
rtMissing.phases[0].showEntities = [];
var rtMissingResult = fidelity.diffFidelityRoundTrip(rtBase, rtMissing);
assert.strictEqual(rtMissingResult.passed, false);
assert.ok(rtMissingResult.diffs.some(function(d) {
  return d.path === 'phases.phase1.projectedAnchors.Player' && d.expected === 'present' && d.actual === 'missing';
}));

// ─── v1.0.0 contracts still validate (backward compat — no v1.2 enforcement) ───
var v10 = {
  schemaVersion: '1.0.0',
  kind: 'blueprint.fidelityContract',
  producerVersion: 't',
  requiredCapabilities: ['c1'],
  coordinateSystem: { source: 'three-rh', target: 'unity-lh', handedness: 'h', zFlip: true, unitScale: 1 },
  rendererAdapter: rendererAdapter(),
  entities: [entity('Player')],
  phases: [{
    id: 'phase1', showEntities: ['Player'],
    trigger: { type: 't' }, interactionGate: { type: 'g' },
    autoPlayGate: { type: 'g' }, manualGate: { type: 'g' }
    // no cameraTransform, no projectedAnchors — and that's fine at v1.0.0
  }],
  hud: [],
  unityCoverage: { status: 'complete' },
  unresolvedFidelityGaps: [],
  contractConflicts: []
};
var v10Result = fidelity.validateFidelityContract(v10);
assert.strictEqual(v10Result.valid, true, 'v1.0.0 backward compat broke. errors=' + JSON.stringify(v10Result.errors));

// ─── exports surface ───────────────────────────────────────────────────────────
assert.strictEqual(typeof fidelity.validateProjectedAnchor, 'function');
assert.strictEqual(fidelity.ANCHOR_PROVENANCE_ENUM['extracted'], true);
assert.strictEqual(fidelity.ANCHOR_PROVENANCE_ENUM['inferred-default'], true);
assert.strictEqual(fidelity.ANCHOR_PROVENANCE_ENUM['anchor-only'], true);
assert.strictEqual(typeof fidelity.DEFAULT_ANCHOR_TOLERANCE_PX, 'number');
assert.strictEqual(fidelity._internals.gteSemver('1.2.0', '1.2.0'), true);
assert.strictEqual(fidelity._internals.gteSemver('1.1.0', '1.2.0'), false);
assert.strictEqual(fidelity._internals.gteSemver('1.10.0', '1.2.0'), true);
assert.strictEqual(fidelity.SCHEMA_VERSION, '1.2.0');
assert.strictEqual(fidelity.ACCEPTED_INSTANCE_SCHEMA_VERSIONS['1.2.0'], true);

console.log('v1.2 fidelity contract tests passed');
