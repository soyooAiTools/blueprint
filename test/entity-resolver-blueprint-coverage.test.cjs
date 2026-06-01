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
      phaseId: 'spaceVisuals',
      phaseName: 'Space Visuals',
      duration: { min: 1, max: 3 },
      entitiesRequired: [{ name: 'SpaceShip' }, { name: 'IceSmall' }, { name: 'BaseOne' }],
      requiredInteractions: ['move_to:SpaceShip'],
      triggerNext: { condition: 'SpaceShipDone', description: '' },
      endCondition: 'true',
      playerMustAct: true,
      autoAllowed: false,
    },
  ];
  const blueprintEntities = [
    { name: 'SpaceShip', template: 'Static', pool: '__Pool_Cylinder_Blue_01' },
    { name: 'IceSmall', template: 'Collectible', pool: '__Pool_Sphere_Cyan_01' },
    { name: 'BaseOne', template: 'Static', pool: '__Pool_Cylinder_White_01' },
  ];
  const resolved = resolveEntities(specs, blueprintEntities);
  assert.strictEqual(resolved.entityPoolMap.SpaceShip, '__Pool_Cylinder_Blue_01');
  assert.strictEqual(resolved.entityPoolMap.IceSmall, '__Pool_Sphere_Cyan_01');
  assert.strictEqual(resolved.entityPoolMap.BaseOne, '__Pool_Cylinder_White_01');
}

{
  const specs = [
    {
      phaseId: 'invalidExplicitPool',
      phaseName: 'Invalid Explicit Pool',
      duration: { min: 1, max: 3 },
      entitiesRequired: [{ name: 'CtaButton' }, { name: 'Panel' }],
      requiredInteractions: ['click:CtaButton'],
      triggerNext: { condition: 'CtaButtonDone', description: '' },
      endCondition: 'true',
      playerMustAct: true,
      autoAllowed: false,
    },
  ];
  const blueprintEntities = [
    { name: 'CtaButton', template: 'UI', pool: '__Pool_Ui_Button_01' },
    { name: 'Panel', template: 'Static', pool: '__Pool_Cylinder_Yellow_99' },
  ];
  const resolved = resolveEntities(specs, blueprintEntities);
  assert.match(resolved.entityPoolMap.CtaButton, /^__Pool_Cube_/);
  assert.notStrictEqual(resolved.entityPoolMap.Panel, '__Pool_Cylinder_Yellow_99');
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

{
  const specs = [
    {
      phaseId: 'phase1',
      phaseName: 'Space Phase',
      duration: { min: 1, max: 3 },
      entitiesRequired: [{ name: 'Player' }, { name: 'SpaceShip' }],
      requiredInteractions: ['move_to:SpaceShip'],
      playerInstruction: '飞向基地',
      autoModeHint: '飞向基地',
      triggerNext: { condition: 'SpaceShipDone', description: '' },
      endCondition: 'true',
      playerMustAct: true,
      autoAllowed: false,
    },
  ];
  const code = generateSkeleton(specs, {
    entityPoolMap: { Player: '__Pool_Cylinder_Cyan_01', SpaceShip: '__Pool_Cylinder_Blue_01' },
    entities: [
      { name: 'Player', chineseName: '玩家', showLabel: true, pool: '__Pool_Cylinder_Cyan_01', initPos: [-8, 0, 2], scale: 0.65 },
      { name: 'SpaceShip', chineseName: '飞船', showLabel: true, pool: '__Pool_Cylinder_Blue_01', initPos: [-10, 0, 4], scale: 0.7 },
    ],
    visualAssets: {
      sourceEntityContract: { sourceEntityCount: 2 },
      sourceSceneContract: {
        present: true,
        backgroundColor: '#071026',
        ambientLight: { color: '#FFFFFF', intensity: 0.62 },
        ground: { color: '#13233A' },
      },
    },
  });
  const mainCode = typeof code === 'string' ? code : code.main;
  assert.match(mainCode, /STORYBOARD2HTML VISUAL PARITY/);
  assert.match(mainCode, /string\[\] _entityBindingPools = new string\[\] \{[\s\S]*"_player"[\s\S]*"__Pool_Cylinder_Blue_01"/);
  assert.match(mainCode, /void NormalizeSourcePlayerSceneObject\(\)[\s\S]*GameObject\.Find\("__Pool_Cylinder_Cyan_01"\)[\s\S]*sourcePlayer\.name = "_player"/);
  assert.match(mainCode, /NormalizeSourcePlayerSceneObject\(\);[\s\S]*RegisterEntityBindings\(\);/);
  assert.match(mainCode, /mainCam\.orthographic = false;/);
  assert.match(mainCode, /new Color\(0\.0275f, 0\.0627f, 0\.149f\)/);
  assert.match(mainCode, /RenderSettings\.ambientLight = new Color\(0\.62f, 0\.62f, 0\.62f\);/);
  assert.match(mainCode, /__bpGroundMat\.color = new Color\(0\.0745f, 0\.1373f, 0\.2275f\);/);
  assert.match(mainCode, /guideText = GFM_UI\.CreateText\(uiCanvas, "", new Vector2\(0, 482\), 30\);/);
}

console.log('entity resolver blueprint coverage tests passed');
