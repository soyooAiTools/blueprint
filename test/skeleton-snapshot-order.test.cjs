const assert = require('assert');

const { generateSkeleton } = require('../adapters/skeleton-generator.cjs');

const specs = [
  {
    phaseId: 'intro',
    phaseName: 'Intro',
    entitiesRequired: [{ name: 'Player' }],
    requiredInteractions: ['click:Player'],
    triggerNext: { condition: 'playerMoved', description: 'player moved' },
    duration: { min: 1, max: 2 },
    playerMustAct: true,
  },
  {
    phaseId: 'buildBase',
    phaseName: 'Build Base',
    entitiesRequired: [{ name: 'Base' }],
    requiredInteractions: ['click:Base', 'build:Base'],
    triggerNext: { condition: 'baseBuilt', description: 'base built' },
    duration: { min: 2, max: 4 },
    playerMustAct: true,
  },
];

const skeleton = generateSkeleton(specs, {
  entityPoolMap: {
    Player: '__Pool_Player',
    Base: '__Pool_Base',
  },
  entities: [{ name: 'Player' }, { name: 'Base' }],
});

const code = typeof skeleton === 'string' ? skeleton : skeleton.main;

const phase0Init = code.indexOf('Phase_intro_Init();');
const phase0Snap = code.indexOf('Snapshot_intro_GateEntities();');
assert(phase0Init >= 0, 'expected phase 0 init call');
assert(phase0Snap >= 0, 'expected phase 0 snapshot call');
assert(phase0Snap > phase0Init, 'phase 0 snapshot should happen after init');

const phase1Init = code.indexOf('Phase_buildBase_Init();');
const phase1Snap = code.indexOf('Snapshot_buildBase_GateEntities();');
assert(phase1Init >= 0, 'expected phase 1 init call');
assert(phase1Snap >= 0, 'expected phase 1 snapshot call');
assert(phase1Snap > phase1Init, 'phase 1 snapshot should happen after init');

console.log('skeleton snapshot order tests passed');
