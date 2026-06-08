#!/usr/bin/env node
'use strict';

var assert = require('assert');
var fidelity = require('../engine/fidelity-contract.cjs');
var sourceIrFidelity = require('../adapters/source-ir/fidelity-contract.js');

function vec(x, y, z) {
  return { x: x, y: y, z: z };
}

function transform(x, y, z) {
  return {
    localPosition: vec(x, y, z),
    localRotation: vec(0, 0, 0),
    localScale: vec(1, 1, 1)
  };
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
    three: {
      shader: { model: 'MeshPhongMaterial' },
      animator: { model: 'AnimationMixer', supported: false },
      physics: { model: 'none' },
      audio: { model: 'WebAudio' },
      ui: { model: 'DOM/CSS' }
    },
    unity: {
      shader: { model: 'URP/Lit' },
      animator: { model: 'Animator', supported: false },
      physics: { model: 'PhysX', supported: false },
      audio: { model: 'AudioSource' },
      ui: { model: 'uGUI Canvas' }
    }
  };
}

function sampleContract(overrides) {
  var doc = {
    schemaVersion: '1.0.0',
    kind: 'blueprint.fidelityContract',
    producerVersion: 'test.1',
    requiredCapabilities: [
      'geometry.primitiveHierarchy.v1',
      'geometry.localTransform.v1',
      'geometry.pivotBounds.v1',
      'material.fullSurface.v1',
      'material.precomputedGuid.v1',
      'rendererAdapter.driverMap.v1',
      'provenance.fieldLevel.v1'
    ],
    coordinateSystem: {
      source: 'three-rh',
      target: 'unity-lh',
      handedness: 'source-rh-target-lh',
      zFlip: true,
      unitScale: 1
    },
    rendererAdapter: rendererAdapter(),
    entities: [
      {
        id: 'Player',
        name: 'Player',
        parentPath: '/SceneRoot',
        unityPath: 'Assets/Scenes/Game.unity:/SceneRoot/Player',
        transform: transform(-8, 0, -2),
        pivot: vec(0, 0.5, 0),
        bounds: { center: vec(0, 0.5, 0), size: vec(1, 1, 1) },
        label: {
          text: 'Player',
          anchor: vec(0, 1.4, 0),
          billboard: true,
          consumer: ['html', 'unity']
        },
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
              colors: {
                _Color: [0.9098, 0.9843, 1, 1],
                _ColorTint: [0.9098, 0.9843, 1, 1],
                _EmissionColor: [0.3184, 0.3445, 0.35, 1]
              },
              baseColor: '#E8FBFF',
              alpha: 1,
              blendMode: 'opaque',
              texture: null,
              textureHash: null,
              tiling: [1, 1],
              offset: [0, 0],
              renderQueue: 2000,
              font: null,
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
        trigger: { type: 'steps_complete', stepIndexAtLeast: 3 },
        interactionGate: { type: 'arrival', target: 'Coin', threshold: 1.8 },
        autoPlayGate: { sharedWithManual: true, type: 'arrival' },
        manualGate: { sharedWithAutoPlay: true, type: 'arrival' }
      }
    ],
    hud: [
      {
        id: 'targetHint',
        text: '目标：收集金币',
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

var schema = fidelity.loadSchema();
assert.strictEqual(fidelity.validateSchema(schema), true);
assert.strictEqual(schema.instanceKind, 'blueprint.fidelityContract');
assert.ok(schema.requiredRoots.indexOf('rendererAdapter') >= 0);
assert.ok(schema.rendererAdapter.requiredBuckets.indexOf('shader') >= 0);
assert.ok(schema.primitiveContract.materialRequiredKeys.indexOf('guidSeed') >= 0);
assert.ok(schema.primitiveContract.materialColorKeys.indexOf('_EmissionColor') >= 0);

var doc = sampleContract();
var validation = fidelity.validateFidelityContract(doc);
assert.strictEqual(validation.valid, true, validation.errors.join('\n'));
assert.strictEqual(fidelity.assertWriterReady(doc, {
  target: 'unity',
  supportedCapabilities: doc.requiredCapabilities
}), true);
assert.strictEqual(sourceIrFidelity.assertFidelityWriterReady(doc, { target: 'unity' }), true);
assert.ok(sourceIrFidelity.supportedCapabilitiesFor('unity').indexOf('runtime.noFixtureBridgeConstants.v1') >= 0);

var missingAdapter = sampleContract({ rendererAdapter: { three: {}, unity: {} } });
var missingAdapterValidation = fidelity.validateFidelityContract(missingAdapter);
assert.strictEqual(missingAdapterValidation.valid, false);
assert.ok(missingAdapterValidation.errors.some(function(error) {
  return error.indexOf('rendererAdapter.three.shader') >= 0;
}));

var withGap = sampleContract({
  unresolvedFidelityGaps: [
    { id: 'missing-player-primitive-position', path: 'entities.Player.primitives[0].transform', blocking: true }
  ]
});
assert.throws(function() {
  fidelity.assertWriterReady(withGap, { target: 'unity', supportedCapabilities: withGap.requiredCapabilities });
}, /unresolved fidelity gaps block writer/);

var withConflict = sampleContract({
  contractConflicts: [
    { id: 'player-position-html-vs-unity', path: 'entities.Player.transform.localPosition' }
  ]
});
assert.throws(function() {
  fidelity.assertWriterReady(withConflict, { target: 'unity', supportedCapabilities: withConflict.requiredCapabilities });
}, /unresolved contract conflicts block writer/);

var resolvedConflict = sampleContract({
  contractConflicts: [
    { id: 'player-position-html-vs-unity', path: 'entities.Player.transform.localPosition', resolution: { status: 'accepted', winner: 'unity' } }
  ]
});
assert.strictEqual(fidelity.assertWriterReady(resolvedConflict, {
  target: 'unity',
  supportedCapabilities: resolvedConflict.requiredCapabilities
}), true);

assert.throws(function() {
  fidelity.assertWriterReady(doc, {
    target: 'unity',
    supportedCapabilities: ['geometry.primitiveHierarchy.v1']
  });
}, /writer missing required capabilities/);

var htmlOnly = sampleContract({ unityCoverage: { status: 'missing', reason: 'pure HTML fixture migration' } });
assert.throws(function() {
  fidelity.assertWriterReady(htmlOnly, { target: 'unity', supportedCapabilities: htmlOnly.requiredCapabilities });
}, /unity writer requires unityCoverage/);
assert.strictEqual(fidelity.assertWriterReady(htmlOnly, {
  target: 'unity',
  allowMissingUnityCoverage: true,
  supportedCapabilities: htmlOnly.requiredCapabilities
}), true);

var roundTrip = fidelity.diffFidelityRoundTrip(doc, JSON.parse(JSON.stringify(doc)));
assert.strictEqual(roundTrip.passed, true, JSON.stringify(roundTrip.diffs, null, 2));
var roundTripSummary = sourceIrFidelity.buildFidelityRoundTripSummary(doc, JSON.parse(JSON.stringify(doc)));
assert.strictEqual(roundTripSummary.kind, 'blueprint.fidelityContract.roundTripSummary');
assert.strictEqual(roundTripSummary.passed, true);
assert.strictEqual(roundTripSummary.diffCount, 0);

var changed = JSON.parse(JSON.stringify(doc));
changed.entities[0].primitives[0].material.colors._EmissionColor = [1, 0, 0, 1];
var changedDiff = fidelity.diffFidelityRoundTrip(doc, changed);
assert.strictEqual(changedDiff.passed, false);
assert.ok(changedDiff.diffs.some(function(diff) {
  return diff.path === 'entities.Player.primitives.Player.Body.material';
}));

console.log('fidelity contract tests passed');
