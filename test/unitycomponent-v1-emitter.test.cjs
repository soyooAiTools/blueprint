#!/usr/bin/env node
'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

var sourceIrArtifacts = require('../adapters/source-ir/index.js');
var sourceSceneIr = require('../engine/source-scene-ir.cjs');
var emitter = require('../lib/unitycomponent-v1-emitter.cjs');
var hardgate = require('../lib/unitycomponent-v1-hardgate.cjs');

function walkFiles(root) {
  var out = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir).forEach(function(name) {
      var file = path.join(dir, name);
      var stat = fs.statSync(file);
      if (stat.isDirectory()) walk(file);
      else out.push(file);
    });
  }
  walk(root);
  return out;
}

function readAll(root) {
  return walkFiles(root).filter(function(file) {
    return /\.(cs|json|prefab|asset)$/i.test(file);
  }).map(function(file) {
    return fs.readFileSync(file, 'utf8');
  }).join('\n');
}

function makeSourceIr() {
  var raw = {
    schemaVersion: 'source-scene-ir.v1',
    kind: 'blueprint.sourceSceneIR',
    project: { name: 'unitycomponent-v1-emitter-fixture', theme: 'restaurant' },
    scene: {
      backgroundColor: '#102030',
      camera: { position: [0, 8, 12], lookAt: [0, 0, 0], fov: 55 },
      ground: { kind: 'plane', size: [20, 20], color: '#203040' }
    },
    entities: [
      { id: 'Player', label: 'Player', kind: 'player', position: [0, 0, 0], visual: { primitive: 'capsule', color: '#66ccff' } },
      { id: 'Gem', label: 'Gem', kind: 'resource', position: [3, 0, 0], visual: { primitive: 'sphere', color: '#33aaff' } },
      { id: 'BulletFx', label: 'Spark', kind: 'effect', position: [4, 0, 0], visual: { primitive: 'sphere', color: '#ffaa33' } },
      { id: 'CtaButton', label: 'Install', kind: 'cta', position: [6, 0, 0], visual: { primitive: 'box', color: '#22cc88' } }
    ],
    resources: [{ id: 'GemCount', label: 'Gems', carrierEntity: 'Gem', kind: 'resource', initial: 0 }],
    phases: [
      {
        id: 'phase1',
        title: 'Collect',
        guideText: 'Collect the gem',
        showEntities: ['Player', 'Gem'],
        plannedModuleIds: ['player_input_joystick', 'move_to_target', 'collect_on_near', 'inventory_wallet'],
        steps: [
          { kind: 'move_to', target: 'Gem', radius: 1.2 },
          { kind: 'collect', resource: 'GemCount', amount: 1, from: 'Gem' }
        ],
        gate: { kind: 'resource', resource: 'GemCount', threshold: 1 }
      },
      {
        id: 'phase2',
        title: 'Effect',
        guideText: 'Show the effect',
        showEntities: ['Player', 'BulletFx'],
        plannedModuleIds: ['spawn_effect'],
        steps: [{ kind: 'show', target: 'BulletFx' }],
        gate: { kind: 'entity_state', entity: 'BulletFx', state: 'complete' }
      },
      {
        id: 'phase3',
        title: 'Install',
        guideText: 'Tap install',
        showEntities: ['Player', 'CtaButton'],
        plannedModuleIds: ['cta_finish'],
        steps: [{ kind: 'cta_finish', entity: 'CtaButton' }],
        gate: { kind: 'cta_arrival', entity: 'CtaButton' }
      }
    ],
    hud: { tip: { source: 'phase.guideText' }, resourceBar: ['GemCount'], cta: { entity: 'CtaButton', arrivalGated: true } }
  };
  return sourceSceneIr.normalizeSourceSceneIr(raw, {
    sourceHtmlPath: '/tmp/unitycomponent-v1-emitter-fixture.html',
    sourceHtmlSha256: 'a'.repeat(64),
    html: '',
    generatedAt: '2026-06-23T00:00:00.000Z'
  });
}

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unitycomponent-v1-emitter-'));
var artifactsDir = path.join(tmp, 'artifacts');
var unityDir = path.join(tmp, 'unity');
var sourceIr = makeSourceIr();
sourceIrArtifacts.buildSourceIrArtifacts('', artifactsDir, {
  sourceIr: sourceIr,
  noBlueprint: true,
  generatedAt: '2026-06-23T00:00:00.000Z'
});

var result = emitter.emitFromArtifacts(artifactsDir, unityDir, { generatedAt: '2026-06-23T00:00:00.000Z' });
assert.strictEqual(result.report.passed, true, JSON.stringify(result.report.errors, null, 2));
assert.ok(fs.existsSync(path.join(unityDir, 'Assets', 'SLGFrameWork', 'Scripts', 'Base', 'Entity.cs')));
assert.ok(fs.existsSync(path.join(unityDir, 'Assets', 'SLGFrameWork', 'Scripts', 'Base', 'GameEntry.cs')));
assert.ok(fs.existsSync(path.join(unityDir, 'Assets', 'SLGFrameWork', 'Scripts', 'Manager', 'BlueprintDelivery', 'GeneratedDeliveryData.cs')));
assert.ok(fs.existsSync(path.join(unityDir, 'Assets', 'SLGFrameWork', 'Scripts', 'Component', 'MoveComponent', 'MoveComponent.cs')));
assert.ok(fs.existsSync(path.join(unityDir, 'Assets', 'SLGFrameWork', 'Scripts', 'Component', 'PickUpComponent', 'PickUpComponent.cs')));
assert.ok(fs.existsSync(path.join(unityDir, 'Assets', 'SLGFrameWork', 'Scripts', 'Entity', 'PlayerEntity.cs')));
assert.strictEqual(fs.existsSync(path.join(unityDir, 'Assets', 'Scripts', 'Base', 'Entity.cs')), false);
assert.ok(fs.existsSync(path.join(unityDir, 'Assets', 'BlueprintDelivery', 'UnityDeliverySpec.json')));
assert.ok(fs.existsSync(path.join(unityDir, 'Assets', 'BlueprintDelivery', 'FrameworkTemplateManifest.json')));
assert.ok(fs.existsSync(path.join(unityDir, 'UNITYCOMPONENT_V1_VALIDATION.json')));

var text = readAll(unityDir);
assert.strictEqual(/GMP_|GFM_|MonoSingleton|mSpawnEntities/.test(text), false, 'v1 export must not contain legacy identifiers');
assert.strictEqual(/GameObject\.Find|FindObjectOfType|FindWithTag/.test(text), false, 'v1 export must not use runtime scene scans');
assert.strictEqual(/namespace Blueprint\.UnityComponent/.test(text), false, 'SLGFrameWork export must not use the old generated namespace');
assert.strictEqual(/"name":\s*"Blueprint\.UnityComponent/.test(text), false, 'SLGFrameWork export must not generate old asmdef layers');
assert.ok(/OnOpen/.test(text) && /OnClose/.test(text), 'v1 export must use v1 lifecycle terms');
assert.ok(/OnAwake -> OnEnable -> OnStart -> OnUpdate -> OnDisable -> OnDestroy/.test(text) || /public virtual void OnEnable/.test(text), 'v1 export must keep BaseComponent lifecycle terms');
assert.ok(/Vector3\.MoveTowards/.test(text), 'MoveComponent must own movement update behavior');
assert.ok(/IsCanPickUpable/.test(text), 'PickUpComponent must own pickup state');
assert.ok(/UiRefs = new UiRefData\[\]/.test(text), 'GeneratedDeliveryData must bake UI refs');
assert.ok(/AssetBindings = new AssetBindingData\[\]/.test(text), 'GeneratedDeliveryData must bake asset bindings');
assert.strictEqual(/ExecuteMove\s*\(\)\s*\{\s*\}/.test(text), false, 'components must not be empty Execute shells');

var prefabText = fs.readFileSync(path.join(unityDir, 'Assets', 'SLGFrameWork', 'Scripts', 'Prefab', 'GameEntry.prefab'), 'utf8');
assert.ok(/MonoBehaviour:/g.test(prefabText), 'GameEntry.prefab must include MonoBehaviour components');
assert.ok(/\nTransform:\n/.test(prefabText), 'GameEntry.prefab must include a Transform component for Unity import');
assert.strictEqual((prefabText.match(/MonoBehaviour:/g) || []).length, 4, 'GameEntry.prefab must compose only valid SLGFrameWork entry managers');

var spec = JSON.parse(fs.readFileSync(path.join(unityDir, 'Assets', 'BlueprintDelivery', 'UnityDeliverySpec.json'), 'utf8'));
assert.strictEqual(spec.profile, 'unitycomponent-v1');
assert.ok(spec.poolArchetypes.some(function(item) { return item.sourceId === 'BulletFx'; }), 'effect must be classified as pool archetype');
assert.ok(spec.components.some(function(item) { return item.component === 'MoveComponent'; }), 'move component selected by evidence');
assert.ok(spec.components.some(function(item) { return item.component === 'PickUpComponent'; }), 'pickup component uses UnityComponent(3) spelling');
assert.strictEqual(spec.components.some(function(item) { return item.component === 'SkillComponent'; }), false, 'SkillComponent must not appear without evidence');

var hardgateReport = hardgate.validateUnityComponentV1(unityDir);
assert.strictEqual(hardgateReport.passed, true, JSON.stringify(hardgateReport.errors, null, 2));

var cliDir = path.join(tmp, 'unity-cli');
var stdout = childProcess.execFileSync(process.execPath, ['scripts/export-unitycomponent-v1.cjs', artifactsDir, cliDir], {
  cwd: path.join(__dirname, '..'),
  encoding: 'utf8'
});
var cliResult = JSON.parse(stdout);
assert.strictEqual(cliResult.ok, true);
assert.strictEqual(hardgate.validateUnityComponentV1(cliDir).passed, true);

console.log('unitycomponent v1 emitter tests passed');
