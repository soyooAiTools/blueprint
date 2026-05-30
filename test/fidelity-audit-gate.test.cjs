#!/usr/bin/env node
'use strict';

var assert = require('assert');
var auditGate = require('../engine/fidelity-audit-gate.cjs');

function vec(x, y, z) { return { x: x, y: y, z: z }; }
function transform(x, y, z) {
  return { localPosition: vec(x, y, z), localRotation: vec(0, 0, 0), localScale: vec(1, 1, 1) };
}
function provenance(source, propertyPath) {
  return {
    source: source || 'unity',
    assetPath: 'Assets/Scenes/Game.unity',
    guid: 'scene-guid',
    fileID: '123',
    propertyPath: propertyPath || 'm_LocalPosition',
    confidence: 1
  };
}
function rendererAdapter() {
  return {
    three: { shader: {}, animator: {}, physics: {}, audio: {}, ui: {} },
    unity: { shader: {}, animator: {}, physics: {}, audio: {}, ui: {} }
  };
}

function sampleContract(overrides) {
  var doc = {
    schemaVersion: '1.0.0',
    kind: 'blueprint.fidelityContract',
    producerVersion: 'audit-gate-test.1',
    requiredCapabilities: [
      'geometry.primitiveHierarchy.v1',
      'geometry.localTransform.v1',
      'geometry.pivotBounds.v1',
      'material.fullSurface.v1',
      'material.precomputedGuid.v1',
      'rendererAdapter.driverMap.v1',
      'provenance.fieldLevel.v1'
    ],
    coordinateSystem: { source: 'three-rh', target: 'unity-lh', handedness: 'source-rh-target-lh', zFlip: true, unitScale: 1 },
    rendererAdapter: rendererAdapter(),
    entities: [
      {
        id: 'Player',
        name: 'Player',
        parentPath: '/SceneRoot',
        transform: transform(0, 0, 0),
        pivot: vec(0, 0.5, 0),
        bounds: { center: vec(0, 0.5, 0), size: vec(1, 1, 1) },
        provenance: provenance('unity', 'GameObject.Player'),
        primitives: [
          {
            id: 'Player.Body',
            name: 'SourcePrimitive_Player_00',
            parentPath: '/SceneRoot/Player',
            transform: transform(0, 0.5, 0),
            pivot: vec(0, 0.5, 0),
            bounds: { center: vec(0, 0.5, 0), size: vec(1, 1, 1) },
            mesh: { type: 'BoxGeometry', args: [1, 1, 1] },
            material: {
              id: 'mat.Player.Body',
              shader: 'URP/Lit',
              colors: { _Color: [0.91, 0.98, 1, 1], _ColorTint: [0.91, 0.98, 1, 1], _EmissionColor: [0.32, 0.34, 0.35, 1] },
              alpha: 1,
              blendMode: 'opaque',
              guid: '0d9c0a0a3f444962b10e6f41e06ef001',
              guidSeed: 'SourcePrimitive_Player_00.mat',
              guidAlgorithm: 'md5-lower-hex-32',
              contentHash: 'sha256:player-body'
            },
            provenance: provenance('unity', 'SourcePrimitive_Player_00')
          }
        ]
      }
    ],
    phases: [
      {
        id: 'phase1',
        showEntities: ['Player'],
        trigger: { type: 'steps_complete' },
        interactionGate: { type: 'arrival' },
        autoPlayGate: { type: 'arrival' },
        manualGate: { type: 'arrival' }
      }
    ],
    hud: [
      {
        id: 'targetHint',
        text: 'Target',
        anchor: { canvas: 'top-left', x: 24, y: 24 },
        consumer: ['html', 'unity'],
        provenance: provenance('html', 'Text_TargetHint')
      }
    ],
    unityCoverage: { status: 'complete', source: 'space-ranger-v15.6.15.22' },
    unresolvedFidelityGaps: [],
    contractConflicts: []
  };
  return Object.assign(doc, overrides || {});
}

var doc = sampleContract();
var passResult = auditGate.runAuditGate(doc, { target: 'unity', supportedCapabilities: doc.requiredCapabilities });
assert.strictEqual(passResult.kind, 'blueprint.fidelityContract.auditGate');
assert.strictEqual(passResult.passed, true, passResult.errors.join('\n'));
assert.strictEqual(passResult.schemaErrors.length, 0);
assert.strictEqual(passResult.blockingGaps.length, 0);
assert.strictEqual(passResult.unresolvedConflicts.length, 0);
assert.strictEqual(passResult.missingCapabilities.length, 0);
assert.strictEqual(passResult.unityCoverageFailure, false);
assert.strictEqual(passResult.unityCoverageStatus, 'complete');

var schemaBroken = sampleContract({ rendererAdapter: { three: {}, unity: {} } });
var schemaResult = auditGate.runAuditGate(schemaBroken, { target: 'unity', supportedCapabilities: schemaBroken.requiredCapabilities });
assert.strictEqual(schemaResult.passed, false);
assert.ok(schemaResult.schemaErrors.length > 0);
assert.ok(schemaResult.schemaErrors.some(function(error) { return error.indexOf('rendererAdapter.three.shader') >= 0; }));

var withGap = sampleContract({
  unresolvedFidelityGaps: [
    { id: 'missing-emission-color', path: 'entities.Player.primitives[0].material.colors._EmissionColor', blocking: true },
    { id: 'advisory-note', path: 'phases[0].interactionGate.threshold', blocking: false }
  ]
});
var gapResult = auditGate.runAuditGate(withGap, { target: 'unity', supportedCapabilities: withGap.requiredCapabilities });
assert.strictEqual(gapResult.passed, false);
assert.strictEqual(gapResult.blockingGaps.length, 1);
assert.strictEqual(gapResult.blockingGaps[0].id, 'missing-emission-color');
assert.ok(gapResult.errors.some(function(error) { return error.indexOf('missing-emission-color') >= 0; }));

var withConflict = sampleContract({
  contractConflicts: [
    { id: 'player-position-html-vs-unity', path: 'entities.Player.transform.localPosition' },
    { id: 'resolved-color', path: 'entities.Player.primitives[0].material.colors._Color', resolution: { status: 'accepted', winner: 'unity' } },
    { id: 'deferred-shader', path: 'rendererAdapter.unity.shader', resolution: { status: 'deferred' } }
  ]
});
var conflictResult = auditGate.runAuditGate(withConflict, { target: 'unity', supportedCapabilities: withConflict.requiredCapabilities });
assert.strictEqual(conflictResult.passed, false);
assert.strictEqual(conflictResult.unresolvedConflicts.length, 1);
assert.strictEqual(conflictResult.unresolvedConflicts[0].id, 'player-position-html-vs-unity');

var capResult = auditGate.runAuditGate(doc, { target: 'unity', supportedCapabilities: ['geometry.primitiveHierarchy.v1'] });
assert.strictEqual(capResult.passed, false);
assert.ok(capResult.missingCapabilities.indexOf('material.fullSurface.v1') >= 0);
assert.ok(capResult.missingCapabilities.indexOf('rendererAdapter.driverMap.v1') >= 0);

var htmlOnly = sampleContract({ unityCoverage: { status: 'missing', reason: 'pure HTML fixture' } });
var unityBlocked = auditGate.runAuditGate(htmlOnly, { target: 'unity', supportedCapabilities: htmlOnly.requiredCapabilities });
assert.strictEqual(unityBlocked.passed, false);
assert.strictEqual(unityBlocked.unityCoverageFailure, true);
var unityAllowed = auditGate.runAuditGate(htmlOnly, { target: 'unity', supportedCapabilities: htmlOnly.requiredCapabilities, allowMissingUnityCoverage: true });
assert.strictEqual(unityAllowed.passed, true);
assert.strictEqual(unityAllowed.unityCoverageFailure, false);
var htmlTarget = auditGate.runAuditGate(htmlOnly, { target: 'html', supportedCapabilities: htmlOnly.requiredCapabilities });
assert.strictEqual(htmlTarget.passed, true);
assert.strictEqual(htmlTarget.unityCoverageFailure, false);

assert.throws(function() {
  auditGate.assertAuditGate(withGap, { target: 'unity', supportedCapabilities: withGap.requiredCapabilities });
}, /fidelity audit gate failed/);

var multiFail = sampleContract({
  unresolvedFidelityGaps: [{ id: 'gap-a', path: 'entities.Player', blocking: true }],
  contractConflicts: [{ id: 'conflict-b', path: 'phases[0].trigger' }]
});
var multiResult = auditGate.runAuditGate(multiFail, { target: 'unity', supportedCapabilities: ['geometry.primitiveHierarchy.v1'] });
assert.strictEqual(multiResult.passed, false);
assert.strictEqual(multiResult.blockingGaps.length, 1);
assert.strictEqual(multiResult.unresolvedConflicts.length, 1);
assert.ok(multiResult.missingCapabilities.length >= 5);
assert.strictEqual(multiResult.errors.length, 3);

// Regression: schema-invalid contract must still surface gaps/conflicts/missingCaps (P1 fix)
var schemaInvalidWithGapsAndConflicts = sampleContract({
  rendererAdapter: { three: {}, unity: {} },
  unresolvedFidelityGaps: [
    { id: 'phantom-Delivery__gold', path: 'materials.Delivery__gold.mat', blocking: true }
  ],
  contractConflicts: [
    { id: 'player-position', path: 'entities.Player.transform.localPosition' }
  ]
});
var schemaInvalidResult = auditGate.runAuditGate(schemaInvalidWithGapsAndConflicts, {
  target: 'unity',
  supportedCapabilities: ['geometry.primitiveHierarchy.v1']
});
assert.strictEqual(schemaInvalidResult.passed, false);
assert.ok(schemaInvalidResult.schemaErrors.length > 0, 'schema errors must be reported');
assert.strictEqual(schemaInvalidResult.blockingGaps.length, 1, 'gaps must surface even when schema is invalid');
assert.strictEqual(schemaInvalidResult.blockingGaps[0].id, 'phantom-Delivery__gold');
assert.strictEqual(schemaInvalidResult.unresolvedConflicts.length, 1, 'conflicts must surface even when schema is invalid');
assert.strictEqual(schemaInvalidResult.unresolvedConflicts[0].id, 'player-position');
assert.ok(schemaInvalidResult.missingCapabilities.length > 0, 'missing caps must surface even when schema is invalid');
assert.ok(schemaInvalidResult.errors.some(function(error) { return error.indexOf('phantom-Delivery__gold') >= 0; }), 'gap label must reach errors[] alongside schema errors');
assert.ok(schemaInvalidResult.errors.some(function(error) { return error.indexOf('player-position') >= 0; }));

// Regression: unityCoverage=missing must surface even when schema is invalid
var schemaInvalidUnityMissing = sampleContract({
  rendererAdapter: { three: {}, unity: {} },
  unityCoverage: { status: 'missing', reason: 'pure HTML fixture' }
});
var schemaInvalidUnityResult = auditGate.runAuditGate(schemaInvalidUnityMissing, {
  target: 'unity',
  supportedCapabilities: schemaInvalidUnityMissing.requiredCapabilities
});
assert.strictEqual(schemaInvalidUnityResult.unityCoverageFailure, true);

console.log('fidelity audit gate tests passed');
