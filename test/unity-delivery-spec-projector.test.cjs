#!/usr/bin/env node
'use strict';

var assert = require('assert');
var projector = require('../lib/unity-delivery-spec-projector.cjs');

function makeSourceIr() {
  return {
    schemaVersion: 'source-scene-ir.v1',
    kind: 'blueprint.sourceSceneIR',
    semanticHash: 'source-hash-fixture',
    source: { htmlSha256: 'a'.repeat(64) },
    project: { name: 'unitycomponent projector fixture' },
    entities: [
      { id: 'Player', kind: 'player', label: 'Player' },
      { id: 'Gem', kind: 'resource', label: 'Gem' },
      { id: 'BulletFx', kind: 'effect', label: 'Bullet FX' },
      { id: 'CtaButton', kind: 'cta', label: 'Install' }
    ],
    resources: [
      { id: 'GemCount', label: 'Gems', kind: 'resource' }
    ],
    phases: [
      {
        id: 'phase1',
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
        guideText: 'Fire at the target',
        showEntities: ['Player', 'BulletFx'],
        plannedModuleIds: ['combat_attack', 'spawn_effect'],
        steps: [
          { kind: 'attack', target: 'BulletFx', damage: 1 }
        ],
        gate: { kind: 'entity_state', entity: 'BulletFx', state: 'complete' }
      },
      {
        id: 'phase3',
        guideText: 'Tap install',
        showEntities: ['Player', 'CtaButton'],
        plannedModuleIds: ['cta_finish'],
        steps: [{ kind: 'cta_finish', entity: 'CtaButton' }],
        gate: { kind: 'cta_arrival', entity: 'CtaButton' }
      }
    ],
    hud: { cta: { entity: 'CtaButton' } }
  };
}

var sourceIr = makeSourceIr();
var spec = projector.buildUnityDeliverySpec({
  sourceIr: sourceIr,
  gameSchema: { phases: [] },
  playableSceneIr: { semanticHash: 'playable-hash' },
  assetManifest: {
    assets: [
      { assetId: 'PlayerModel', kind: 'procedural_primitive' },
      { assetId: 'GemModel', kind: 'procedural_primitive' }
    ]
  },
  unityAssetPlan: {
    actions: [
      { assetId: 'PlayerModel', actionId: 'uap_PlayerModel', prefabPath: 'Assets/Prefabs/Player.prefab', status: 'ready' },
      { assetId: 'GemModel', actionId: 'uap_GemModel', prefabPath: 'Assets/Prefabs/Gem.prefab', status: 'ready' }
    ],
    entityBindings: {
      Player: { primaryAssetId: 'PlayerModel', prefabPath: 'Assets/Prefabs/Player.prefab' },
      Gem: { primaryAssetId: 'GemModel', prefabPath: 'Assets/Prefabs/Gem.prefab' }
    }
  }
}, { generatedAt: '2026-06-23T00:00:00.000Z' });

assert.strictEqual(spec.kind, projector.KIND);
assert.strictEqual(spec.schemaVersion, projector.SCHEMA_VERSION);
assert.strictEqual(spec.profile, 'unitycomponent-v1');
assert.strictEqual(spec.namespace, '');
assert.strictEqual(spec.phases.length, 3);
assert.deepStrictEqual(spec.phases[0].targetSequence, ['Gem', 'GemCount']);
assert.ok(spec.components.some(function(item) { return item.component === 'MoveComponent'; }), 'move component selected from movement evidence');
assert.ok(spec.components.some(function(item) { return item.component === 'PickUpComponent'; }), 'PickUpComponent selected from collect evidence');
assert.ok(spec.components.some(function(item) { return item.component === 'AttackComponent'; }), 'attack component selected from combat evidence');
assert.strictEqual(spec.components.some(function(item) { return item.component === 'SkillComponent'; }), false, 'SkillComponent must not appear without feature evidence');
assert.ok(spec.sceneRefs.some(function(item) { return item.sourceId === 'Player'; }), 'Player is a persistent scene ref');
assert.ok(spec.poolArchetypes.some(function(item) { return item.sourceId === 'BulletFx'; }), 'effect entity is a pool archetype');
assert.ok(spec.uiRefs.some(function(item) { return item.role === 'guideText'; }), 'guide label UI ref required');
assert.ok(/^[0-9a-f]{64}$/.test(spec.semanticHash));

assert.deepStrictEqual(projector.assertDeliverySpecSourceParity(spec, sourceIr), {
  passed: true,
  checked: ['phases', 'entities', 'resources']
});

var minimal = projector.minimalUnityVisibleSpec(spec);
assert.strictEqual(minimal.diagnostics, undefined, 'Unity-visible minimal spec must omit diagnostics');
assert.strictEqual(minimal.phases[0].guideText, 'Collect the gem');

var drifted = JSON.parse(JSON.stringify(spec));
drifted.phases[0].guideText = 'Drifted copy';
assert.throws(function() {
  projector.assertDeliverySpecSourceParity(drifted, sourceIr);
}, /source parity failed/);

console.log('unity delivery spec projector tests passed');
