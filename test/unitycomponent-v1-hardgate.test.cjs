#!/usr/bin/env node
'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var hardgate = require('../lib/unitycomponent-v1-hardgate.cjs');
var projector = require('../lib/unity-delivery-spec-projector.cjs');
var emitter = require('../lib/unitycomponent-v1-emitter.cjs');

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function sourceIrFixture() {
  return {
    schemaVersion: 'source-scene-ir.v1',
    kind: 'blueprint.sourceSceneIR',
    semanticHash: 'unitycomponent-hardgate-source-hash',
    source: { htmlSha256: 'b'.repeat(64) },
    entities: [
      { id: 'Player', kind: 'player' },
      { id: 'Gem', kind: 'resource' },
      { id: 'BulletFx', kind: 'effect' }
    ],
    resources: [{ id: 'GemCount', label: 'Gems', kind: 'resource' }],
    phases: [
      {
        id: 'phase1',
        guideText: 'Collect the gem',
        showEntities: ['Player', 'Gem'],
        plannedModuleIds: ['player_input_joystick', 'collect_on_near'],
        steps: [{ kind: 'move_to', target: 'Gem' }, { kind: 'collect', resource: 'GemCount', from: 'Gem', amount: 1 }],
        gate: { kind: 'resource', resource: 'GemCount', threshold: 1 }
      },
      {
        id: 'phase2',
        guideText: 'Show the effect',
        showEntities: ['Player', 'BulletFx'],
        plannedModuleIds: ['spawn_effect'],
        steps: [{ kind: 'show', target: 'BulletFx' }],
        gate: { kind: 'entity_state', entity: 'BulletFx', state: 'complete' }
      }
    ]
  };
}

function writePositiveProject(root) {
  var sourceIr = sourceIrFixture();
  var spec = projector.buildUnityDeliverySpec({
    sourceIr: sourceIr,
    gameSchema: { phases: [] },
    playableSceneIr: { semanticHash: 'playable-hardgate-hash' },
    assetManifest: { assets: [] },
    unityAssetPlan: { actions: [], entityBindings: {} }
  }, { generatedAt: '2026-06-23T00:00:00.000Z' });
  emitter.emitUnityComponentProject(spec, root, { sourceIr: sourceIr });
}

function makeRoot() {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), 'unitycomponent-v1-hardgate-'));
  writePositiveProject(root);
  return root;
}

var root = makeRoot();
var report = hardgate.validateUnityComponentV1(root);
assert.strictEqual(report.passed, true, JSON.stringify(report.errors, null, 2));
assert.strictEqual(report.summary.phaseCount, 2);
assert.strictEqual(report.summary.poolArchetypeCount, 1);

var legacyRoot = makeRoot();
write(path.join(legacyRoot, 'Assets', 'SLGFrameWork', 'Scripts', 'Entity', 'LegacyLeak.cs'), [
  'public class LegacyLeak',
  '{',
  '  public string Name = "GMP_Player";',
  '}'
].join('\n'));
var legacyReport = hardgate.validateUnityComponentV1(legacyRoot);
assert.strictEqual(legacyReport.passed, false);
assert.ok(legacyReport.errors.some(function(error) { return error.id === 'forbidden-identifier'; }));

var findRoot = makeRoot();
write(path.join(findRoot, 'Assets', 'SLGFrameWork', 'Scripts', 'Entity', 'FinderEntity.cs'), [
  'using UnityEngine;',
  'public class FinderEntity : Entity',
  '{',
  '  public void Patch() { GameObject.Find("Player"); }',
  '}'
].join('\n'));
var findReport = hardgate.validateUnityComponentV1(findRoot);
assert.strictEqual(findReport.passed, false);
assert.ok(findReport.errors.some(function(error) { return error.id === 'runtime-scene-patching'; }));

var skillRoot = makeRoot();
write(path.join(skillRoot, 'Assets', 'SLGFrameWork', 'Scripts', 'Component', 'SkillComponent', 'SkillComponent.cs'), [
  'using System;',
  '[Serializable]',
  'public class SkillComponent : BaseComponent',
  '{',
  '  public float cooldown = 1f;',
  '  public void Cast() { cooldown = 1f; }',
  '}'
].join('\n'));
var skillReport = hardgate.validateUnityComponentV1(skillRoot);
assert.strictEqual(skillReport.passed, false);
assert.ok(skillReport.errors.some(function(error) { return error.id === 'default-optional-component-without-evidence'; }));

var shellRoot = makeRoot();
write(path.join(shellRoot, 'Assets', 'SLGFrameWork', 'Scripts', 'Component', 'PickUpComponent', 'PickUpComponent.cs'), [
  'using System;',
  '[Serializable]',
  'public class PickUpComponent : BaseComponent',
  '{',
  '  public float Tuning = 1f;',
  '  public void Execute() {}',
  '}'
].join('\n'));
var shellReport = hardgate.validateUnityComponentV1(shellRoot);
assert.strictEqual(shellReport.passed, false);
assert.ok(shellReport.errors.some(function(error) { return error.id === 'decorative-component-shell'; }));

var driftRoot = makeRoot();
var specPath = path.join(driftRoot, 'Assets', 'BlueprintDelivery', 'UnityDeliverySpec.json');
var spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
spec.phases[0].guideText = 'Drifted guide';
write(specPath, JSON.stringify(spec, null, 2) + '\n');
var driftReport = hardgate.validateUnityComponentV1(driftRoot);
assert.strictEqual(driftReport.passed, false);
assert.ok(driftReport.errors.some(function(error) { return error.id === 'unity-delivery-spec-source-drift'; }));

var noSourceRoot = makeRoot();
fs.unlinkSync(path.join(noSourceRoot, 'source-ir.json'));
var noSourceReport = hardgate.validateUnityComponentV1(noSourceRoot);
assert.strictEqual(noSourceReport.passed, false);
assert.ok(noSourceReport.errors.some(function(error) { return error.id === 'source-ir-missing'; }));

var templateRoot = makeRoot();
fs.appendFileSync(path.join(templateRoot, 'Assets', 'SLGFrameWork', 'Scripts', 'Base', 'Entity.cs'), '\n// unauthorized framework rewrite\n');
var templateReport = hardgate.validateUnityComponentV1(templateRoot);
assert.strictEqual(templateReport.passed, false);
assert.ok(templateReport.errors.some(function(error) { return error.id === 'framework-template-file-modified'; }));

var dataBoundaryRoot = makeRoot();
fs.appendFileSync(path.join(dataBoundaryRoot, 'Assets', 'SLGFrameWork', 'Scripts', 'Manager', 'BlueprintDelivery', 'GeneratedDeliveryData.cs'), '\npublic class BadGeneratedRuntime { void Update() {} }\n');
var dataBoundaryReport = hardgate.validateUnityComponentV1(dataBoundaryRoot);
assert.strictEqual(dataBoundaryReport.passed, false);
assert.ok(dataBoundaryReport.errors.some(function(error) { return error.id === 'logical-data-boundary-violation'; }));

var toolBoundaryRoot = makeRoot();
fs.appendFileSync(path.join(toolBoundaryRoot, 'Assets', 'SLGFrameWork', 'Scripts', 'Manager', 'BlueprintDelivery', 'BlueprintPlayableManager.cs'), '\npublic class BadProjectBranch { public string copy = "Collect the gem"; }\n');
var toolBoundaryReport = hardgate.validateUnityComponentV1(toolBoundaryRoot);
assert.strictEqual(toolBoundaryReport.passed, false);
assert.ok(toolBoundaryReport.errors.some(function(error) { return error.id === 'logical-tool-boundary-violation'; }));

var prefabRoot = makeRoot();
var prefabPath = path.join(prefabRoot, 'Assets', 'SLGFrameWork', 'Scripts', 'Prefab', 'GameEntry.prefab');
write(prefabPath, fs.readFileSync(prefabPath, 'utf8').replace(/guid: [0-9a-f]{32}, type: 3/, 'guid: 00000000000000000000000000000000, type: 3'));
var prefabReport = hardgate.validateUnityComponentV1(prefabRoot);
assert.strictEqual(prefabReport.passed, false);
assert.ok(prefabReport.errors.some(function(error) { return error.id === 'gameentry-prefab-composition-incomplete'; }));

var invalidPrefabScriptRoot = makeRoot();
var invalidPrefabPath = path.join(invalidPrefabScriptRoot, 'Assets', 'SLGFrameWork', 'Scripts', 'Prefab', 'GameEntry.prefab');
var invalidPrefabText = fs.readFileSync(invalidPrefabPath, 'utf8');
var stubGuid = require('crypto').createHash('sha1').update('unitycomponent-v1-meta:Assets/SLGFrameWork/Scripts/Manager/FrameworkManagerStubs.cs').digest('hex').slice(0, 32);
write(invalidPrefabPath, invalidPrefabText.replace(
  /m_Script: \{fileID: 11500000, guid: [0-9a-f]{32}, type: 3\}/,
  'm_Script: {fileID: 11500000, guid: ' + stubGuid + ', type: 3}'
));
var invalidPrefabScriptReport = hardgate.validateUnityComponentV1(invalidPrefabScriptRoot);
assert.strictEqual(invalidPrefabScriptReport.passed, false);
assert.ok(invalidPrefabScriptReport.errors.some(function(error) { return error.id === 'gameentry-prefab-script-invalid'; }));

var runtimeSpecRoot = makeRoot();
write(path.join(runtimeSpecRoot, 'Assets', 'SLGFrameWork', 'Scripts', 'Manager', 'BlueprintDelivery', 'RuntimeSpecReader.cs'), [
  'using System.IO;',
  'public class RuntimeSpecReader',
  '{',
  '  public string Read() { return File.ReadAllText("UnityDeliverySpec.json"); }',
  '}'
].join('\n'));
var runtimeSpecReport = hardgate.validateUnityComponentV1(runtimeSpecRoot);
assert.strictEqual(runtimeSpecReport.passed, false);
assert.ok(runtimeSpecReport.errors.some(function(error) { return error.id === 'unity-delivery-spec-runtime-read'; }));

console.log('unitycomponent v1 hardgate tests passed');
