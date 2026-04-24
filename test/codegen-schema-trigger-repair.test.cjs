const assert = require('assert');

const codegenSchema = require('../engine/stages/codegen-schema.cjs');

function makeSchema() {
  return {
    gameConfig: {
      cameraBackground: [0.5, 0.7, 1],
      groundColor: [0.3, 0.6, 0.2],
      moveSpeed: 5,
      collectRange: 2,
      maxCarry: 10,
    },
    entities: [
      {
        name: 'EnemyAstronaut',
        chineseName: '敌方宇航员',
        showLabel: true,
        pool: '__Pool_Cube_White_01',
        initPos: [0, 1, 0],
        scale: 1,
      },
      {
        name: 'CTAButton',
        chineseName: '安装按钮',
        showLabel: false,
        pool: '__Pool_Cube_Red_02',
        initPos: [1, 1, 0],
        scale: 1,
      },
    ],
    resources: [],
    phases: [
      {
        phaseId: 'enemyAttackWarning',
        showEntities: ['EnemyAstronaut'],
        trigger: { type: 'timer', seconds: 3 },
      },
      {
        phaseId: 'occupyEnemyBaseCTA',
        showEntities: ['CTAButton'],
        trigger: { type: 'click_entity', entity: 'CTAButton' },
      },
    ],
    npcs: [],
    customLogic: [],
  };
}

const original = makeSchema();
const before = codegenSchema._validateSchema(original);
assert(before.allErrors.some((err) => /timer trigger must be inside compound/.test(err)));

codegenSchema._repairSchema(original, []);

const repairedTrigger = original.phases[0].trigger;
assert.strictEqual(repairedTrigger.type, 'compound');
assert.strictEqual(repairedTrigger.operator, 'and');
assert.strictEqual(repairedTrigger.triggers.length, 2);
assert.deepStrictEqual(repairedTrigger.triggers, [
  { type: 'timer', seconds: 3 },
  { type: 'timer', seconds: 3 },
]);

const after = codegenSchema._validateSchema(original);
assert.deepStrictEqual(after.allErrors, []);

assert.strictEqual(codegenSchema._internals.isSchemaInfraError('Connection error.'), true);
assert.strictEqual(codegenSchema._internals.isSchemaInfraError('Request timed out.'), true);
assert.strictEqual(codegenSchema._internals.isSchemaInfraError('schema malformed'), false);

{
  const schema = {
    gameConfig: {},
    entities: [
      {
        name: 'EnemyAstronaut',
        chineseName: '敌方宇航员',
        showLabel: true,
        pool: '__Pool_Cube_White_01',
        initPos: [0, 1, 0],
        scale: 1,
      },
    ],
    resources: [],
    phases: [
      {
        phaseId: 'enemyAttack',
        onEnter: [
          { action: 'spawn_enemies', entity: 'Enemy', count: 1 },
        ],
        onComplete: [
          { action: 'spawn_enemies', entity: 'Enemy', count: 2 },
        ],
      },
    ],
    npcs: [
      {
        entity: 'EnemyAstronaut',
        template: 'chase_attack',
        params: {},
      },
    ],
    customLogic: [],
  };
  const blueprintEntities = [
    {
      name: 'EnemyAstronaut',
      label: '敌方宇航员',
      visual: { position: '(1, 0, 2)', scale: '0.8×0.8×0.8' },
    },
    {
      name: 'GoldRecycler',
      label: '金币回收机',
      visual: { position: '(-7, 0, -2)', scale: '2×2×2' },
    },
    {
      name: 'CTAButton',
      label: '安装按钮',
      visual: { position: '(5, 1, 0)', scale: '1×1×1' },
    },
  ];

  codegenSchema._repairSchema(schema, blueprintEntities);

  const byName = Object.fromEntries(schema.entities.map((entity) => [entity.name, entity]));
  assert.ok(byName.GoldRecycler);
  assert.strictEqual(byName.GoldRecycler.chineseName, '金币回收机');
  assert.deepStrictEqual(byName.GoldRecycler.initPos, [-6, 0.5, -2]);
  assert.strictEqual(byName.GoldRecycler.scale, 2);
  assert.strictEqual(byName.GoldRecycler.showLabel, true);
  assert.ok(byName.CTAButton);
  assert.strictEqual(byName.CTAButton.showLabel, false);
  assert.strictEqual(schema.phases[0].onEnter[0].entity, 'EnemyAstronaut');
  assert.strictEqual(schema.phases[0].onComplete[0].entity, 'EnemyAstronaut');
}

console.log('codegen-schema trigger repair tests passed');
