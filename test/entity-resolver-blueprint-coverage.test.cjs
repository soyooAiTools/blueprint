const assert = require('assert');

const { resolveEntities } = require('../adapters/entity-resolver.cjs');
const { generateSkeleton } = require('../adapters/skeleton-generator.cjs');

{
  const specs = [
    {
      phaseId: 'enemyAttack',
      phaseName: 'Enemy Attack',
      duration: { min: 1, max: 3 },
      entitiesRequired: [
        { name: 'OurBase', terminalState: 2, description: 'base ready' },
      ],
      requiredInteractions: ['click:OurBase'],
      triggerNext: { condition: 'OurBaseDone', description: '' },
      endCondition: 'true',
      playerMustAct: true,
      autoAllowed: false,
    },
  ];
  const blueprintEntities = [
    { name: 'OurBase', template: 'Buildable' },
    { name: 'GoldRecycler', template: 'Static' },
    { name: 'Bullet', template: 'Mover' },
    { name: 'TowerShooter', template: 'Shooter' },
  ];

  const resolved = resolveEntities(specs, blueprintEntities);
  assert.ok(resolved.entityPoolMap.OurBase);
  assert.ok(resolved.entityPoolMap.GoldRecycler);
  assert.ok(resolved.entityPoolMap.Bullet);
  assert.ok(resolved.entityPoolMap.TowerShooter);
}

{
  const specs = [
    {
      phaseId: 'collectGold',
      phaseName: 'Collect Gold',
      duration: { min: 1, max: 3 },
      entitiesRequired: [
        { name: 'OurBase', terminalState: 2, description: 'base ready' },
      ],
      requiredInteractions: ['collect:Gold', 'deliver:GoldRecycler'],
      triggerNext: { condition: 'collectGoldDone', description: '' },
      endCondition: 'true',
      playerMustAct: true,
      autoAllowed: false,
    },
  ];
  const blueprintEntities = [
    { name: 'OurBase', template: 'Buildable' },
    { name: 'GoldRecycler', template: 'Static' },
    { name: 'Gold', template: 'Collectible' },
  ];
  const resolved = resolveEntities(specs, blueprintEntities);
  const code = generateSkeleton(specs, {
    entityPoolMap: resolved.entityPoolMap,
    entities: blueprintEntities,
  });
  const mainCode = typeof code === 'string' ? code : code.main;
  const resourceCode = typeof code === 'string' ? code : code.resource;

  assert.match(mainCode, /GameObject GoldRecycler;/);
  assert.match(mainCode, /GameObject Gold;/);
  assert.match(mainCode, /void SpawnGoldRecycler\(int count\)/);
  assert.match(mainCode, /void SpawnGold\(int count\)/);
  assert.match(resourceCode, /class InventoryCompat/);
  assert.match(resourceCode, /InventoryCompat _inventory = new InventoryCompat\(\);/);
}

{
  const specs = [
    {
      phaseId: 'enemyWave',
      phaseName: 'Enemy Wave',
      duration: { min: 1, max: 3 },
      entitiesRequired: [],
      requiredInteractions: ['attack:EnemyAstronaut'],
      triggerNext: { condition: 'waveDone', description: '' },
      endCondition: 'true',
      playerMustAct: true,
      autoAllowed: false,
    },
  ];
  const blueprintEntities = [
    { name: 'EnemyBase', template: 'Spawner' },
    { name: 'EnemyAstronaut', template: 'Mover' },
    { name: 'OurBase', template: 'Buildable' },
  ];
  const resolved = resolveEntities(specs, blueprintEntities);
  const code = generateSkeleton(specs, {
    entityPoolMap: resolved.entityPoolMap,
    entities: blueprintEntities,
  });
  const mainCode = typeof code === 'string' ? code : code.main;

  assert.match(mainCode, /void SpawnEnemyAstronaut\(int count\)/);
  assert.match(mainCode, /void SpawnEnemy\(int count\)/);
  assert.match(mainCode, /SpawnEnemyAstronaut\(count\);/);
}

console.log('entity resolver blueprint coverage tests passed');
