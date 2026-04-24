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

console.log('skeleton autoplay observe tests passed');
