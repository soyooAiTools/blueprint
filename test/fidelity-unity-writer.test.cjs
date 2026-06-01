#!/usr/bin/env node
'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var writer = require('../adapters/demo2spec/fidelity-unity-writer.js');
var demo2specFidelity = require('../adapters/demo2spec/fidelity-contract.js');

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
    producerVersion: 'unity-writer-test.1',
    requiredCapabilities: demo2specFidelity.UNITY_WRITER_CAPABILITIES.slice(),
    coordinateSystem: { source: 'unity-lh', target: 'unity-lh', handedness: 'left', zFlip: false, unitScale: 1 },
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
            id: 'SourcePrimitive_Player_00',
            name: 'SourcePrimitive_Player_00',
            parentPath: '/SceneRoot/Player',
            transform: transform(0, 0.5, 0),
            pivot: vec(0, 0.5, 0),
            bounds: { center: vec(0, 0.5, 0), size: vec(1, 1, 1) },
            mesh: { type: 'SphereGeometry', args: [0.45, 24, 16] },
            material: {
              id: 'SourcePrimitive_Player_00',
              shader: { name: 'Assets/Shader/SimpleLit.shader', guid: 'shader-guid' },
              colors: { _Color: [0.91, 0.98, 1, 1], _ColorTint: [0.91, 0.98, 1, 1], _EmissionColor: [0.32, 0.34, 0.35, 1] },
              alpha: 1,
              blendMode: 'Opaque',
              guid: 'mat-guid',
              guidSeed: 'SourcePrimitive_Player_00',
              guidAlgorithm: 'unity-meta-v1',
              contentHash: 'sha256:player-body'
            },
            provenance: provenance('unity', 'GameObject(SourcePrimitive_Player_00)')
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
    unityCoverage: { status: 'complete', source: 'unit-test' },
    unresolvedFidelityGaps: [],
    contractConflicts: []
  };
  return Object.assign(doc, overrides || {});
}

var tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fidelity-unity-writer-'));
var contract = sampleContract();
var result = writer.runUnityFidelityRoundTrip(contract, tempDir, { generatedAt: '2026-05-28T16:40:00.000Z' });
assert.strictEqual(result.roundTrip.kind, 'blueprint.fidelityContract.roundTripSummary');
assert.strictEqual(result.roundTrip.passed, true, JSON.stringify(result.roundTrip.diffs, null, 2));
assert.strictEqual(result.auditResult.passed, true);
assert.ok(fs.existsSync(result.manifestPath), 'manifest must be written');
assert.ok(fs.existsSync(result.assetIndexPath), 'asset index must be written');
assert.strictEqual(result.manifestPath, path.join(tempDir, writer.DEFAULT_MANIFEST_RELATIVE_PATH));
assert.strictEqual(result.assetIndexPath, path.join(tempDir, writer.DEFAULT_ASSET_INDEX_RELATIVE_PATH));
var manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
assert.strictEqual(manifest.kind, writer.MANIFEST_KIND);
assert.strictEqual(manifest.contract.kind, 'blueprint.fidelityContract');
assert.strictEqual(manifest.writer.mode, 'fidelity-asset-pack-v1');
var assetIndex = JSON.parse(fs.readFileSync(result.assetIndexPath, 'utf8'));
assert.strictEqual(assetIndex.kind, writer.ASSET_INDEX_KIND);
assert.strictEqual(assetIndex.assets.entities.length, 1);
assert.strictEqual(assetIndex.assets.materials.length, 1);
assert.strictEqual(assetIndex.assets.phases.length, 1);
assert.strictEqual(assetIndex.assets.hud.length, 1);
assert.ok(fs.existsSync(path.join(tempDir, assetIndex.assets.entities[0].file)), 'entity asset must be written');
assert.ok(fs.existsSync(path.join(tempDir, assetIndex.assets.materials[0].file)), 'material asset must be written');
assert.ok(fs.existsSync(path.join(tempDir, assetIndex.assets.phases[0].file)), 'phase asset must be written');
assert.ok(fs.existsSync(path.join(tempDir, assetIndex.assets.hud[0].file)), 'hud asset must be written');

var readback = writer.readUnityFidelityManifest(tempDir);
assert.strictEqual(readback.entities[0].primitives[0].material.colors._EmissionColor[0], 0.32);
assert.strictEqual(readback.hud[0].text, 'Target');
manifest.contract.hud[0].text = 'BROKEN_MANIFEST_COPY';
fs.writeFileSync(result.manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
assert.strictEqual(writer.readUnityFidelityManifest(tempDir).hud[0].text, 'Target', 'readback must use emitted assets, not manifest copy');

var materialPath = path.join(tempDir, assetIndex.assets.materials[0].file);
var materialAsset = JSON.parse(fs.readFileSync(materialPath, 'utf8'));
materialAsset.material.colors._EmissionColor = [1, 0, 0, 1];
fs.writeFileSync(materialPath, JSON.stringify(materialAsset, null, 2) + '\n', 'utf8');
var changedReadback = writer.readUnityFidelityManifest(tempDir);
var changedSummary = demo2specFidelity.buildFidelityRoundTripSummary(contract, changedReadback);
assert.strictEqual(changedSummary.passed, false);
assert.ok(changedSummary.diffs.some(function(diff) {
  return diff.path === 'entities.Player.primitives.SourcePrimitive_Player_00.material';
}));

var customDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fidelity-unity-writer-custom-'));
var custom = writer.writeUnityFidelityManifest(contract, customDir, { manifestRelativePath: path.join('Assets', 'Custom', 'fidelity.json') });
assert.ok(custom.manifestPath.endsWith(path.join('Assets', 'Custom', 'fidelity.json')));
assert.strictEqual(writer.readUnityFidelityManifest(customDir, { manifestRelativePath: path.join('Assets', 'Custom', 'fidelity.json') }).producerVersion, 'unity-writer-test.1');

var withGap = sampleContract({
  unresolvedFidelityGaps: [
    { id: 'phases.missing', path: '$.phases', blocking: true }
  ]
});
assert.throws(function() {
  writer.runUnityFidelityRoundTrip(withGap, fs.mkdtempSync(path.join(os.tmpdir(), 'fidelity-unity-writer-gap-')));
}, /fidelity audit gate failed/);

var missingCoverage = sampleContract({ unityCoverage: { status: 'missing', reason: 'pure html migration' } });
assert.throws(function() {
  writer.runUnityFidelityRoundTrip(missingCoverage, fs.mkdtempSync(path.join(os.tmpdir(), 'fidelity-unity-writer-coverage-')));
}, /unity writer requires unityCoverage/);

assert.strictEqual(writer.runUnityFidelityRoundTrip(missingCoverage, fs.mkdtempSync(path.join(os.tmpdir(), 'fidelity-unity-writer-allow-')), {
  allowMissingUnityCoverage: true
}).roundTrip.passed, true);

console.log('fidelity unity writer tests passed');
