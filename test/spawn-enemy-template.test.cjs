const assert = require('assert');

const { generatePhaseInit } = require('../adapters/templates/phase-init.cjs');
const { generateAutoPlay } = require('../adapters/templates/autoplay-mirror.cjs');

const schema = {
  entities: [
    { name: 'EnemyBase', initPos: [4, 1, 0], scale: 1, terminalState: 2 },
    { name: 'EnemyAstronaut', initPos: [2, 1, 0], scale: 1, terminalState: 1 },
    { name: 'OurBase', initPos: [-2, 1, 0], scale: 1, terminalState: 2 },
  ],
  npcs: [
    { entity: 'EnemyAstronaut', template: 'chase_attack', params: {} },
  ],
  phases: [
    {
      phaseId: 'enemyAttack',
      showEntities: ['EnemyAstronaut'],
      trigger: { type: 'click_entity', entity: 'OurBase' },
      onEnter: [
        { action: 'spawn_enemies', entity: 'Enemy', count: 1 },
      ],
      onComplete: [
        { action: 'spawn_enemies', entity: 'Enemy', count: 2 },
      ],
    },
  ],
};

const initCode = generatePhaseInit(schema.phases[0], schema);
assert.match(initCode, /SpawnEnemyAstronaut\(1\);/);
assert.doesNotMatch(initCode, /SpawnEnemy\(1\);/);

const autoplayCode = generateAutoPlay(schema);
assert.match(autoplayCode, /SpawnEnemyAstronaut\(2\);/);
assert.doesNotMatch(autoplayCode, /SpawnEnemy\(2\);/);

const unresolvedInit = generatePhaseInit({
  phaseId: 'cleanup',
  showEntities: ['MissingCrate'],
  hideEntities: ['MissingCrate'],
  onEnter: [
    { action: 'set_entity_state', entity: 'Unknown', state: 1 },
    { action: 'set_entity_state', entity: 'MissingCrate', state: 1 },
    { action: 'add_resource', resource: 'default', amount: 1 },
    { action: 'show_floating_text', color: 'yellow' },
  ],
}, schema);
assert.match(unresolvedInit, /skipped unresolved set_entity_state/);
assert.match(unresolvedInit, /skipped unresolved add_resource/);
assert.match(unresolvedInit, /skipped unresolved floating_text/);
assert.doesNotMatch(unresolvedInit, /UnknownState = 1;/);
assert.doesNotMatch(unresolvedInit, /MissingCrateState = 1;/);
assert.doesNotMatch(unresolvedInit, /HideObj\(MissingCrate\)/);
assert.doesNotMatch(unresolvedInit, /PlaceObj\(MissingCrate/);
assert.doesNotMatch(unresolvedInit, /AddResource\("default"/);
assert.doesNotMatch(unresolvedInit, /"undefined"/);

console.log('spawn enemy template tests passed');
