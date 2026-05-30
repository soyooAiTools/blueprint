#!/usr/bin/env node
'use strict';

const assert = require('assert');

const {
  buildSourceResourceTargetIndex,
  sourceResourceTarget,
} = require('../adapters/demo2spec/source-contract-mapping.js');
const {
  normalizeGameSchemaForBlueprint,
  buildBlueprintProject,
} = require('../adapters/demo2spec/blueprint-project.js');

const assetManifest = {
  sourceEntityContract: {
    entities: ['Player', 'SellCounter', 'IceSmall', 'BigDebris', 'FrozenDebris', 'CtaButton'],
  },
  sourcePhaseContract: {
    phases: [
      { id: 'phase1', steps: [{ gain: 'Coin', target: 'SellCounter' }] },
      { id: 'phase2', steps: [{ gain: 'Ice', target: 'IceSmall' }] },
      { id: 'phase5', steps: [{ gain: 'Scrap', target: 'BigDebris' }] },
      { id: 'phase7', steps: [{ gain: 'Scrap', target: 'FrozenDebris' }] },
    ],
  },
};

const targetIndex = buildSourceResourceTargetIndex(assetManifest);
assert.strictEqual(targetIndex.Gold, 'SellCounter', 'Gold should alias source Coin target');
assert.strictEqual(sourceResourceTarget(assetManifest, 'Ice'), 'IceSmall');
assert.strictEqual(sourceResourceTarget(assetManifest, 'Scrap'), 'BigDebris');

const gameSchema = {
  gameConfig: { cameraBackground: [0, 0, 0], groundColor: [0, 0, 0], moveSpeed: 5, collectRange: 2, maxCarry: 10 },
  entities: [
    { name: 'Player', chineseName: '玩家', pool: '__Pool_Cube_White_01', initPos: [0, 0, 0], scale: 1 },
    { name: 'SellCounter', chineseName: '售卖台', pool: '__Pool_Cube_Yellow_01', initPos: [1, 0, 0], scale: 1 },
    { name: 'IceSmall', chineseName: '小冰块', pool: '__Pool_Cube_Cyan_01', initPos: [2, 0, 0], scale: 1 },
    { name: 'BigDebris', chineseName: '残骸', pool: '__Pool_Cube_Brown_01', initPos: [3, 0, 0], scale: 1 },
    { name: 'FrozenDebris', chineseName: '冰封残骸', pool: '__Pool_Cube_Blue_01', initPos: [4, 0, 0], scale: 1 },
    { name: 'CtaButton', chineseName: '下载', pool: '__Pool_Cube_Green_01', initPos: [5, 0, 0], scale: 1 },
  ],
  resources: [
    { name: 'Gold', entity: 'CtaButton', convertRatio: 1 },
    { name: 'Ice', entity: '', convertRatio: 1 },
    { name: 'Scrap', entity: 'MissingScrapCarrier', convertRatio: 1 },
  ],
  phases: [
    { phaseId: 'phase1', showEntities: ['Player', 'SellCounter'], guideText: 'sell', trigger: { type: 'resource_collected', resource: 'Gold', amount: 6 } },
    { phaseId: 'phase2', showEntities: ['Player', 'IceSmall'], guideText: 'ice', trigger: { type: 'resource_collected', resource: 'Ice', amount: 3 } },
    { phaseId: 'phase7', showEntities: ['Player', 'FrozenDebris'], guideText: 'scrap', trigger: { type: 'resource_collected', resource: 'Scrap', amount: 8 } },
    { phaseId: 'phase8', showEntities: ['Player', 'CtaButton'], guideText: 'cta', trigger: { type: 'near_entity', entity: 'CtaButton', range: 2 } },
  ],
};

const normalized = normalizeGameSchemaForBlueprint(gameSchema, { assetManifest });
assert.deepStrictEqual(
  normalized.resources.map(r => [r.name, r.entity]),
  [['Gold', 'SellCounter'], ['Ice', 'IceSmall'], ['Scrap', 'BigDebris']],
  'source resources should map to real source phase targets instead of CtaButton/generated carriers'
);
assert.strictEqual(
  normalized.entities.some(entity => /^(Gold|Ice|Scrap)$/.test(entity.name) && entity.demo2specGeneratedCarrier),
  false,
  'normalization must not synthesize Gold/Ice/Scrap carrier entities when source targets exist'
);

const project = buildBlueprintProject(normalized, { assetManifest });
const phase7 = project.specs.find(spec => spec.phaseId === 'phase7');
assert.ok(phase7.requiredInteractions.includes('move_to:FrozenDebris'), 'phase-local Scrap collection should use the source phase target');
assert.ok(!phase7.requiredInteractions.includes('move_to:BigDebris'), 'phase-local target should override the global first Scrap target');

console.log('demo2spec source contract mapping tests passed');
