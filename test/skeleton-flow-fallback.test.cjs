const assert = require('assert');

const { generateSkeleton } = require('../adapters/skeleton-generator.cjs');

function spec(phaseId, phaseName, entitiesRequired, requiredInteractions, playerMustAct, min, max) {
  return {
    phaseId,
    phaseName,
    entitiesRequired: entitiesRequired.map((name) => ({ name })),
    requiredInteractions,
    triggerNext: { condition: phaseId + '_done', description: phaseName + ' done' },
    duration: { min, max },
    playerMustAct,
  };
}

const specs = [
  spec('enemyAttackWarning', 'Enemy Attack Warning', ['OurBase', 'EnemyAstronaut'], [], false, 3, 3),
  spec('upgradeOurBase', 'Upgrade Our Base', ['OurBase', 'Gold'], ['click:OurBase', 'spend:Gold:1', 'upgrade:OurBase:2'], true, 3, 8),
  spec('enemyImpactExplosion', 'Enemy Impact Explosion', ['OurBase'], [], false, 3, 3),
  spec('dispatchAstronautAttack', 'Dispatch Astronaut Attack', ['OurAstronaut'], ['click:OurAstronaut', 'attack:EnemyAstronaut'], true, 4, 9),
  spec('enemyUnitDefeated', 'Enemy Unit Defeated', ['EnemyAstronaut'], [], false, 3, 3),
  spec('collectRocketDebris', 'Collect Rocket Debris', ['RocketDebris'], ['click:RocketDebris', 'collect:RocketDebris:1'], true, 3, 8),
  spec('recycleDebrisGetGold', 'Recycle Debris Get Gold', ['RocketDebris', 'Gold'], ['deliver:RocketDebris:GoldRecycler', 'click:Gold', 'collect:Gold:1'], true, 3, 8),
  spec('buildDefenseTower', 'Build Defense Tower', ['DefenseTower', 'Gold'], ['click:DefenseTower', 'spend:Gold:1', 'build:DefenseTower'], true, 3, 8),
  spec('buildBarrack', 'Build Barrack', ['Barrack', 'Gold'], ['click:Barrack', 'spend:Gold:1', 'build:Barrack'], true, 4, 9),
  spec('buildConveyorBelt', 'Build Conveyor Belt', ['ConveyorBelt', 'Gold'], ['click:ConveyorBelt', 'spend:Gold:1', 'build:ConveyorBelt'], true, 4, 9),
  spec('occupyEnemyBaseCTA', 'Occupy Enemy Base CTA', ['CTAButton'], ['defeat:EnemyBase', 'click:CTAButton'], true, 5, 10),
];

const entityNames = [
  'OurBase',
  'EnemyAstronaut',
  'Gold',
  'OurAstronaut',
  'RocketDebris',
  'DefenseTower',
  'Barrack',
  'ConveyorBelt',
  'CTAButton',
  'EnemyBase',
  'GoldRecycler',
];

const entityPoolMap = {};
entityNames.forEach((name, index) => {
  entityPoolMap[name] = '__Pool_Test_' + index;
});

const skeleton = generateSkeleton(specs, {
  entityPoolMap,
  entities: entityNames.map((name) => ({ name })),
});

assert.ok(skeleton && skeleton.flow, 'expected split skeleton with flow partial');

const flow = skeleton.flow;
const ui = skeleton.ui;
const resource = skeleton.resource;
assert.match(
  flow,
  /void Phase_upgradeOurBase_OnAutoPlayArrive\(string targetName\)[\s\S]*if \(ShouldRunAutoPlayFallback\(\) && !upgradeOurBaseInteractionDone && !upgradeOurBasePlayerActed\)/,
);
assert.match(flow, /AddResource\(GFM_ResourceIds\.Gold, 1\);/);
assert.match(flow, /TrySpend\(GFM_ResourceIds\.Gold, 1\);/);
assert.match(flow, /RecordPhaseEvidenceDistance\("collectRocketDebris", "distance_to_target_below_threshold", 0\.5f\);/);
assert.match(flow, /RecordPhaseEvidenceFlag\("buildDefenseTower", "entity_state_equals_built"\);/);
assert.match(resource, /RecordPhaseEvidenceDelta\(currentPhaseName, "resource_decremented"/);
assert.match(resource, /amount < 0 && after < before/);
assert.match(ui, /BuildPhaseEvidenceJson\(\)/);
assert.match(flow, /OurBaseDone = true;/);
assert.match(flow, /GoldDone = true;/);
assert.match(flow, /AddResource\(GFM_ResourceIds\.RocketDebris, 1\);/);
assert.match(flow, /UpdateGameState\(\);/);
const tapBody = flow.match(/void Phase_upgradeOurBase_OnTap\(\)[\s\S]*?TODO_PHASE_upgradeOurBase_ONTAP_END/);
assert.ok(tapBody, 'tap handler should exist');
assert.doesNotMatch(tapBody[0], /ShouldRunAutoPlayFallback|SKELETON FALLBACK/);

const enemyAliasSkeleton = generateSkeleton([
  spec('enemyPhase', 'Enemy Phase', ['Enemy', 'EnemySpawner'], ['click:EnemySpawner'], true, 3, 6),
], {
  entityPoolMap: { Enemy: '__Pool_Enemy', EnemySpawner: '__Pool_EnemySpawner' },
  entities: [{ name: 'Enemy' }, { name: 'EnemySpawner' }],
});
const enemyAliasMain = typeof enemyAliasSkeleton === 'string' ? enemyAliasSkeleton : enemyAliasSkeleton.main;
const spawnEnemyMatches = enemyAliasMain.match(/void SpawnEnemy\s*\(int count\)/g) || [];
assert.strictEqual(spawnEnemyMatches.length, 1, 'literal Enemy entity must not get a second generic SpawnEnemy alias');

console.log('skeleton flow fallback tests passed');
