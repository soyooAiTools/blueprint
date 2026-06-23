#!/usr/bin/env node
'use strict';

var assert = require('assert');
var sourceSceneIr = require('../engine/source-scene-ir.cjs');
var projector = require('../lib/unity-delivery-spec-projector.cjs');

function normalize(raw, name) {
  raw.project = raw.project || { name: name };
  raw.schemaVersion = 'source-scene-ir.v1';
  raw.kind = 'blueprint.sourceSceneIR';
  return sourceSceneIr.normalizeSourceSceneIr(raw, {
    sourceHtmlPath: '/tmp/' + name + '.html',
    html: '',
    generatedAt: '2026-06-23T00:00:00.000Z'
  });
}

function base(project, phases, extraEntities, resources) {
  return normalize({
    project: { name: project },
    scene: {
      backgroundColor: '#101820',
      camera: { position: [0, 8, 12], lookAt: [0, 0, 0], fov: 55 },
      ground: { kind: 'plane', size: [20, 20], color: '#203040' }
    },
    entities: [
      { id: 'Player', kind: 'player', label: 'Player', position: [0, 0, 0], visual: { primitive: 'capsule', color: '#66ccff' } }
    ].concat(extraEntities || []),
    resources: resources || [],
    phases: phases
  }, project);
}

var corpus = [
  base('move-guide', [
    {
      id: 'phase1',
      guideText: 'Move to the marker',
      showEntities: ['Player', 'Marker'],
      plannedModuleIds: ['player_input_joystick', 'move_to_target'],
      steps: [{ kind: 'move_to', target: 'Marker' }],
      gate: { kind: 'near_entity', entity: 'Marker', radius: 1.2 }
    }
  ], [{ id: 'Marker', kind: 'target', label: 'Marker', position: [2, 0, 0], visual: { primitive: 'box', color: '#ffffff' } }]),
  base('resource-stack', [
    {
      id: 'phase1',
      guideText: 'Collect coins',
      showEntities: ['Player', 'Coin'],
      plannedModuleIds: ['collect_on_near', 'inventory_wallet'],
      steps: [{ kind: 'collect', target: 'Coin', resource: 'CoinCount', amount: 3 }],
      gate: { kind: 'resource', resource: 'CoinCount', threshold: 3 }
    }
  ], [{ id: 'Coin', kind: 'resource', label: 'Coin', position: [2, 0, 0], visual: { primitive: 'sphere', color: '#ffdd55' } }], [{ id: 'CoinCount', label: 'Coins', kind: 'resource' }]),
  base('combat-hp', [
    {
      id: 'phase1',
      guideText: 'Attack the dummy',
      showEntities: ['Player', 'Dummy'],
      plannedModuleIds: ['combat_attack', 'hp_damage'],
      steps: [{ kind: 'attack', target: 'Dummy', damage: 1 }],
      gate: { kind: 'entity_state', entity: 'Dummy', state: 'defeated' }
    }
  ], [{ id: 'Dummy', kind: 'enemy', label: 'Dummy', position: [2, 0, 0], visual: { primitive: 'box', color: '#aa3333' } }]),
  base('ui-cta-guide', [
    {
      id: 'phase1',
      guideText: 'Tap the install button',
      showEntities: ['Player', 'CtaButton'],
      plannedModuleIds: ['cta_finish'],
      steps: [{ kind: 'cta_finish', entity: 'CtaButton' }],
      gate: { kind: 'cta_arrival', entity: 'CtaButton' }
    }
  ], [{ id: 'CtaButton', kind: 'cta', label: 'Install', position: [3, 0, 0], visual: { primitive: 'box', color: '#22cc88' } }]),
  base('pool-effect', [
    {
      id: 'phase1',
      guideText: 'Trigger the hit effect',
      showEntities: ['Player', 'HitEffect'],
      plannedModuleIds: ['spawn_effect'],
      steps: [{ kind: 'show', target: 'HitEffect' }],
      gate: { kind: 'entity_state', entity: 'HitEffect', state: 'complete' }
    }
  ], [{ id: 'HitEffect', kind: 'effect', label: 'Hit', position: [2, 0, 0], visual: { primitive: 'sphere', color: '#ffaa33' } }])
];

corpus.forEach(function(sourceIr) {
  var spec = projector.buildUnityDeliverySpec({
    sourceIr: sourceIr,
    gameSchema: { phases: [] },
    playableSceneIr: { semanticHash: 'playable-' + sourceIr.project.name },
    assetManifest: { assets: [] },
    unityAssetPlan: { actions: [], entityBindings: {} }
  }, { generatedAt: '2026-06-23T00:00:00.000Z' });
  assert.deepStrictEqual(projector.assertDeliverySpecSourceParity(spec, sourceIr), {
    passed: true,
    checked: ['phases', 'entities', 'resources']
  }, sourceIr.project.name);
  assert.strictEqual(spec.phases.length, sourceIr.phases.length, sourceIr.project.name + ' phase count');
  assert.deepStrictEqual(spec.phases.map(function(phase) { return phase.guideText; }), sourceIr.phases.map(function(phase) { return phase.guideText; }), sourceIr.project.name + ' guide text');
});

var drifted = projector.buildUnityDeliverySpec({
  sourceIr: corpus[0],
  gameSchema: { phases: [] },
  playableSceneIr: { semanticHash: 'playable-drift' },
  assetManifest: { assets: [] },
  unityAssetPlan: { actions: [], entityBindings: {} }
});
drifted.phases[0].targetSequence = ['WrongTarget'];
assert.throws(function() {
  projector.assertDeliverySpecSourceParity(drifted, corpus[0]);
}, /source parity failed/);

console.log('delivery spec source parity tests passed');
