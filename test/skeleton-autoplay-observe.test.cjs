const assert = require('assert');

const { generateSkeleton } = require('../adapters/skeleton-generator.cjs');

const specs = [
  {
    phaseId: 'warning',
    phaseName: 'Warning',
    entitiesRequired: [{ name: 'Enemy' }],
    requiredInteractions: ['click:Enemy'],
    triggerNext: { condition: 'enemyMoved', description: 'enemy moved' },
    duration: { min: 2, max: 4 },
    playerMustAct: true,
  },
  {
    phaseId: 'buildTower',
    phaseName: 'Build Tower',
    entitiesRequired: [{ name: 'Tower' }],
    requiredInteractions: ['click:Tower', 'build:Tower'],
    triggerNext: { condition: 'towerBuilt', description: 'tower built' },
    duration: { min: 2, max: 4 },
    playerMustAct: true,
  },
];

const skeleton = generateSkeleton(specs, {
  entityPoolMap: {
    Enemy: '__Pool_Enemy',
    Tower: '__Pool_Tower',
  },
  entities: [{ name: 'Enemy' }, { name: 'Tower' }],
});

const code = typeof skeleton === 'string' ? skeleton : skeleton.main;

assert.match(code, /string\[\] _autoTargets = new string\[\] \{ "Enemy", "Tower" \};/);
assert.match(code, /void AutoPlayUpdate\(\)[\s\S]*GFM_AutoPlay\.Instance\.Tick\(\);/);
assert.match(code, /void AutoPlayUpdate\(\)[\s\S]*MaybeAssistAutoPlayPhase\(\);/);
assert.match(code, /void MaybeAssistAutoPlayPhase\(\)[\s\S]*OnAutoPlayArrive\("__phase_auto__"\);/);
assert.match(code, /GFM_AutoPlay\.Instance\.SetTargets\(_autoTargets\);/);
assert.match(code, /else GFM_Player\.Instance\.Tick\(dt, false\);/);

const planOrderedSkeleton = generateSkeleton(specs, {
  entityPoolMap: {
    Enemy: '__Pool_Enemy',
    Tower: '__Pool_Tower',
    Gold: '__Pool_Gold',
  },
  entities: [{ name: 'Enemy' }, { name: 'Tower' }, { name: 'Gold' }],
  plans: {
    cuaPlan: {
      steps: [
        { phaseId: 'warning', actions: [{ kind: 'move_to', target: 'Tower' }] },
        { phaseId: 'buildTower', actions: [{ kind: 'collect', target: 'Gold' }, { kind: 'attack', target: 'Enemy' }] },
      ],
    },
  },
});
const planOrderedCode = typeof planOrderedSkeleton === 'string' ? planOrderedSkeleton : planOrderedSkeleton.main;
assert.match(
  planOrderedCode,
  /string\[\] _autoTargets = new string\[\] \{ "Tower", "Gold", "Enemy" \};/,
  'autoplay target order should prefer CUA plan actions when available'
);

const idleSkeleton = generateSkeleton([
  {
    phaseId: 'moveToOre',
    phaseName: 'Move',
    entitiesRequired: [{ name: 'Ore' }],
    requiredInteractions: ['move_to:Ore'],
    duration: { min: 10, max: 12 },
    playerMustAct: true,
  },
  {
    phaseId: 'collectOre',
    phaseName: 'Collect',
    entitiesRequired: [{ name: 'Ore' }],
    requiredInteractions: ['collect:Ore'],
    duration: { min: 10, max: 12 },
    playerMustAct: true,
  },
], {
  entityPoolMap: { Ore: '__Pool_Ore' },
  entities: [{ name: 'Ore' }],
});
const idleCode = typeof idleSkeleton === 'string'
  ? idleSkeleton
  : [idleSkeleton.main, idleSkeleton.flow, idleSkeleton.input, idleSkeleton.resource, idleSkeleton.ui, idleSkeleton.scene].join('\n');
assert.match(idleCode, /GameObject player;/);
assert.match(idleCode, /player = GFM_Player\.Instance\.Go;/);

console.log('skeleton autoplay observe tests passed');
