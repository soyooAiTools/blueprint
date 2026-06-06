#!/usr/bin/env node
'use strict';

const assert = require('assert');

const {
  buildSnapshotSchema,
  buildCuaPlans,
  buildCuaSpecs,
  buildGameStateShim,
} = require('../adapters/demo2spec/snapshot-schema.js');

const gameSchema = {
  gameConfig: {},
  entities: [
    { name: 'Player', chineseName: '玩家', pool: '__Pool_Cube_White_01', initPos: [0, 0, 0] },
    { name: 'OurBaseGate', chineseName: '基地门', pool: '__Pool_Cube_Blue_01', initPos: [-8, 0, 0] },
    { name: 'EnemyRocket', chineseName: '敌方火箭', pool: '__Pool_Cube_Red_01', initPos: [-4, 0, 0] },
    { name: 'RocketDebris', chineseName: '火箭残骸', pool: '__Pool_Cube_Gray_01', initPos: [2, 0, 0] },
    { name: 'Recycler', chineseName: '回收机', pool: '__Pool_Cube_Green_01', initPos: [8, 0, 0] },
  ],
  resources: [{ name: 'Scrap', entity: 'RocketDebris', convertRatio: 1 }],
  phases: [{
    phaseId: 'phase1',
    guideText: '回收子弹',
    showEntities: ['Player', 'OurBaseGate', 'EnemyRocket', 'RocketDebris', 'Recycler'],
    trigger: { type: 'near_entity', entity: 'Recycler', range: 2 },
    steps: [
      { target: 'OurBaseGate', setEntity: 'OurBaseGate', state: 2 },
      { target: 'EnemyRocket', damage: true },
      { target: 'RocketDebris', gain: 'Scrap', amount: 1 },
      { target: 'Recycler' },
    ],
  }],
};

const snapshotDoc = buildSnapshotSchema({
  spec: { meta: { project: 'snapshot-phase-steps-fixture' }, phases: [] },
  gameSchema,
  contractDoc: { contractVersion: 'test', moduleProbeContracts: {} },
  generatedAt: '2026-06-07T00:00:00.000Z',
});

const phase = snapshotDoc.project.phases[0];
assert.deepStrictEqual(
  phase.targetSequence,
  ['OurBaseGate', 'EnemyRocket', 'RocketDebris', 'Recycler'],
  'snapshot project phase should preserve source step target sequence'
);
assert.ok(phase.plannedModuleIds.includes('collect_on_near'));
assert.ok(phase.plannedModuleIds.includes('apply_damage'));
assert.ok(phase.plannedModuleIds.includes('build_progress'));

const plans = buildCuaPlans(snapshotDoc);
assert.deepStrictEqual(
  plans.cuaPlan.steps[0].actions.map(action => [action.kind, action.target || action.item || '', action.item || '']),
  [
    ['move_to', 'OurBaseGate', ''],
    ['build', 'OurBaseGate', ''],
    ['move_to', 'EnemyRocket', ''],
    ['attack', 'EnemyRocket', ''],
    ['move_to', 'RocketDebris', ''],
    ['approach_collect', 'RocketDebris', 'Scrap'],
    ['move_to', 'Recycler', ''],
  ],
  'CUA plan should drive every source step, not only the phase exit trigger'
);
assert.ok(plans.cuaPlan.steps[0].phaseEvidenceExpectedSignals.includes('target_hp_decreased_or_target_dead'));
assert.ok(plans.cuaPlan.steps[0].phaseEvidenceExpectedSignals.includes('entity_state_changed'));

const specs = buildCuaSpecs(gameSchema);
assert.ok(specs[0].requiredInteractions.includes('move_to:OurBaseGate'));
assert.ok(specs[0].requiredInteractions.includes('attack:EnemyRocket'));
assert.ok(specs[0].requiredInteractions.includes('collect:Scrap:1'));
assert.ok(specs[0].requiredInteractions.includes('build:OurBaseGate'));

const shim = buildGameStateShim(snapshotDoc);
assert.ok(shim.indexOf('"targetSequence": [') >= 0);
assert.ok(shim.indexOf('targetEntity: targetEntity') >= 0);

console.log('demo2spec snapshot schema phase steps tests passed');
