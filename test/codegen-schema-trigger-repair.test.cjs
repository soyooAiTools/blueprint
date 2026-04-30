const assert = require('assert');

const codegenSchema = require('../engine/stages/codegen-schema.cjs');
const codexCodeCoder = require('../worker/codex-code-coder.js');

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

{
  const schema = makeSchema();
  schema.phases[0].duration = { min: 10, max: 15 };
  schema.phases[0].camera = { lookAt: 'EnemyAstronaut' };
  schema.phases[0].notes = 'LLM-only commentary';
  codegenSchema._repairSchema(schema, []);
  assert.strictEqual(schema.phases[0].duration, undefined);
  assert.strictEqual(schema.phases[0].camera, undefined);
  assert.strictEqual(schema.phases[0].notes, undefined);
  assert.deepStrictEqual(codegenSchema._validateSchema(schema).allErrors, []);
}

assert.strictEqual(codegenSchema._internals.isSchemaInfraError('Connection error.'), true);
assert.strictEqual(codegenSchema._internals.isSchemaInfraError('Request timed out.'), true);
assert.strictEqual(codegenSchema._internals.isSchemaInfraError("There's an issue with the selected model (gpt-5.4-mini). It may not exist or you may not have access to it."), true);
assert.strictEqual(codegenSchema._internals.isSchemaInfraError('schema malformed'), false);

{
  const runner = codegenSchema._internals.resolveSchemaRunnerConfig({});
  assert.strictEqual(runner.codexModel, 'gpt-5.5');
  assert.strictEqual(runner.claudeModel, 'claude-sonnet-4-6');
  assert.notStrictEqual(runner.codexModel, 'gpt-5.4-mini');
  assert.strictEqual(codegenSchema._internals.resolveSchemaTimeoutMs({}), 360000);
  assert.strictEqual(codegenSchema._internals.resolveSchemaTimeoutMs({ CODEX_SCHEMA_TIMEOUT_MS: '420000' }), 420000);

  const envRunner = codegenSchema._internals.resolveSchemaRunnerConfig({
    CODEX_SCHEMA_MODEL: 'gpt-custom',
    CLAUDE_SCHEMA_MODEL: 'claude-custom',
  });
  assert.deepStrictEqual(envRunner, { codexModel: 'gpt-custom', claudeModel: 'claude-custom' });

  assert.strictEqual(codexCodeCoder._internals.resolveClaudePrintModel({ model: 'gpt-5.5' }, {}), 'claude-sonnet-4-6');
  assert.strictEqual(codexCodeCoder._internals.resolveClaudePrintModel({ model: 'claude-haiku-4-5-20251001' }, {}), 'claude-haiku-4-5-20251001');
  assert.strictEqual(codexCodeCoder._internals.isModelUnavailableError('selected model may not exist or you may not have access'), true);
}

{
  const merged = codegenSchema._internals.mergeSchemaEntitiesForResolution(
    [{ name: 'Player', template: 'hero' }, { name: 'CTAButton', template: 'cta' }],
    [{ name: 'BulletItem', template: 'collectible' }, { name: 'Player', template: 'schema-player' }]
  );
  assert.deepStrictEqual(merged.map((entity) => entity.name), ['Player', 'CTAButton', 'BulletItem']);
  assert.strictEqual(merged[0].template, 'hero');
}

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

{
  const longText = '这是一段会把 prompt 撑爆的 CUA 动作说明'.repeat(80);
  const plans = {
    registryVersion: 'v-test',
    storyboardAtomPlan: {
      items: [
        {
          id: 'atom_001',
          atomId: 'move_to',
          phaseId: 'collect',
          params: { actor: 'Player', target: longText, unusedNarrative: longText },
          mappedModules: ['move_to_target', 'player_input_joystick'],
          cuaAssertions: ['player_position_changed'],
        },
      ],
    },
    entityPlan: {
      entities: [
        {
          name: 'Player',
          label: '玩家',
          modules: [
            { moduleId: 'move_to_target' },
            { moduleId: 'move_to_target' },
            { moduleId: 'player_input_joystick' },
          ],
        },
      ],
      systemModules: [{ moduleId: 'camera_follow' }],
    },
    assemblyPlan: {
      moduleInstances: [
        {
          id: 'Player::move_to_target',
          moduleId: 'move_to_target',
          entity: 'Player',
          expectedSignals: ['player_position_changed', 'distance_to_target_below_threshold'],
          observableFeedback: [longText],
          phaseEvidenceSchema: [
            {
              signal: 'player_position_changed',
              phaseEvidencePath: 'phaseEvidence["collect"]["player_position_changed"]',
              variableEvidenceKey: 'evidence.collect.player_position_changed',
            },
          ],
        },
      ],
      phaseBindings: [
        {
          phaseId: 'collect',
          activateEntities: ['Player', 'Gold'],
          atomIds: ['atom_001'],
          completionSignals: ['player_position_changed'],
        },
      ],
      stateOwners: [{ state: 'Player.position', moduleInstanceId: 'Player::move_to_target' }],
      fileOwners: [{ file: 'GameFlowManagerMain.Flow.cs', moduleInstanceIds: ['Player::move_to_target'] }],
      unresolved: [],
    },
    cuaPlan: {
      steps: [
        {
          phaseId: 'collect',
          actions: [{ kind: 'move_to', target: longText }],
          expectedSignals: ['player_position_changed'],
          phaseEvidenceSchema: [{ signal: 'player_position_changed', phaseEvidencePath: longText }],
        },
      ],
    },
  };
  const summary = codegenSchema._internals.summarizePlansForPrompt(plans);
  assert.ok(summary.length < 2500, 'compact assembly summary should stay small');
  const summaryLines = summary.split('\n');
  const longestLine = summaryLines.reduce((max, line) => Math.max(max, line.length), 0);
  assert.ok(summaryLines.length > 10, 'compact assembly summary should stay wrapped');
  assert.ok(longestLine < 1000, 'compact assembly summary should not contain ultra-long lines');
  assert.ok(summary.indexOf('"phaseEvidenceSignals"') >= 0);
  assert.ok(summary.indexOf('"stateOwners"') >= 0);
  assert.ok(summary.indexOf('observableFeedback') < 0);
  assert.ok(summary.indexOf('phaseEvidencePath') < 0);
  assert.ok(summary.indexOf(longText) < 0);
}

{
  const schema = makeSchema();
  schema.customLogic = ['duplicate module work'];
  const ctx = {
    blueprint: {
      assemblyCoverage: 1,
      assemblyDecision: 'assembly_ready',
      plans: {
        entityPlan: {
          entities: [
            { name: 'Player' },
            { name: 'EnemyBase' },
            { name: 'CTAButton' },
          ],
        },
        assemblyPlan: {
          moduleInstances: [
            {
              id: 'Player::player_input_joystick',
              moduleId: 'player_input_joystick',
              entity: 'Player',
              params: { target: 'EnemyBase' },
              ownerFiles: ['GameFlowManagerMain.Input.cs'],
              sourceAtomIds: ['atom_move'],
            },
            {
              id: 'system::cta_finish',
              moduleId: 'cta_finish',
              entity: '',
              params: { target: 'CTAButton' },
              ownerFiles: ['GameFlowManagerMain.UI.cs'],
              sourceAtomIds: ['atom_cta'],
            },
          ],
          fileOwners: [
            { file: 'GameFlowManagerMain.Input.cs', moduleInstanceIds: ['Player::player_input_joystick'] },
            { file: 'GameFlowManagerMain.UI.cs', moduleInstanceIds: ['system::cta_finish'] },
          ],
          phaseBindings: [
            {
              phaseId: 'move',
              atomIds: ['atom_move'],
              activateEntities: ['Player', 'EnemyBase'],
            },
            {
              phaseId: 'finish',
              atomIds: ['atom_cta'],
              activateEntities: ['CTAButton'],
            },
          ],
          unresolved: [],
        },
        cuaPlan: {
          steps: [
            { phaseId: 'move', actions: [{ kind: 'move_to', target: 'EnemyBase' }] },
            { phaseId: 'finish', actions: [{ kind: 'click', target: 'CTAButton' }] },
          ],
        },
      },
    },
  };
  const result = codegenSchema._internals.suppressCustomLogicWhenAssemblyCovered(ctx, schema);
  assert.strictEqual(result.suppressedCount, 1);
  assert.deepStrictEqual(schema.customLogic, []);
  assert.strictEqual(ctx.blueprint.customLogicSuppressedCount, 1);
  assert.strictEqual(ctx.blueprint.assemblyImplementationCoverage, 1);
  assert.strictEqual(ctx.blueprint.customLogicRoute, 'deterministic_suppressed');
}

{
  const schema = makeSchema();
  schema.customLogic = ['requires missing module'];
  const ctx = {
    blueprint: {
      assemblyCoverage: 1,
      plans: {
        entityPlan: { entities: [] },
        assemblyPlan: {
          moduleInstances: [
            {
              id: 'system::unknown',
              moduleId: 'unknown_module',
              entity: '',
              params: {},
              ownerFiles: ['GameFlowManagerMain.Flow.cs'],
            },
          ],
          fileOwners: [
            { file: 'GameFlowManagerMain.Flow.cs', moduleInstanceIds: ['system::unknown'] },
          ],
          phaseBindings: [],
          unresolved: [],
        },
        cuaPlan: { steps: [] },
      },
    },
  };
  const result = codegenSchema._internals.suppressCustomLogicWhenAssemblyCovered(ctx, schema);
  assert.strictEqual(result.suppressedCount, 0);
  assert.deepStrictEqual(schema.customLogic, ['requires missing module']);
  assert.strictEqual(ctx.blueprint.assemblyImplementationMissingCount, 1);
  assert.strictEqual(ctx.blueprint.customLogicRoute, 'runner_implementation_gap');
}

console.log('codegen-schema trigger repair tests passed');
