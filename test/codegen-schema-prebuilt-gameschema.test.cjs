'use strict';

const assert = require('assert');

const codegenSchema = require('../engine/stages/codegen-schema.cjs');

const gameSchema = {
  gameConfig: {
    cameraBackground: [0.04, 0.07, 0.16],
    groundColor: [0.1, 0.16, 0.13],
    moveSpeed: 5,
    collectRange: 2,
    maxCarry: 10,
  },
  entities: [
    { name: 'Box', chineseName: '箱子', showLabel: true, pool: '__Pool_Cube_Blue_01', initPos: [0, 1, 0], scale: 1 },
    { name: 'Coin', chineseName: '金币', showLabel: true, pool: '__Pool_Cylinder_Yellow_01', initPos: [1, 1, 0], scale: 1 },
    { name: 'CtaButton', chineseName: '下载', showLabel: false, pool: '__Pool_Cube_Green_01', initPos: [0, 1, 1], scale: 0.5 },
  ],
  resources: [],
  phases: [
    {
      phaseId: 'phase1',
      showEntities: ['Box', 'Coin', 'CtaButton'],
      hideEntities: [],
      guideText: '点击下载',
      trigger: { type: 'click_entity', entity: 'CtaButton' },
      onEnter: [],
      onComplete: [],
    },
  ],
  customLogic: [],
};

async function main() {
  const logs = [];
  const ctx = {
    taskId: 'test-prebuilt-gameschema',
    csCode: null,
    extraFiles: {},
    blueprint: {
      prebuiltGameSchema: true,
      gameSchema,
      entities: gameSchema.entities,
      specs: [
        {
          phaseId: 'phase1',
          phaseName: '点击下载',
          requiredInteractions: ['click:CtaButton'],
          entitiesRequired: [{ name: 'Box' }, { name: 'Coin' }, { name: 'CtaButton' }],
          duration: { min: 12, max: 15 },
          playerInstruction: '点击下载',
        },
      ],
      plans: {
        assemblyPlan: { moduleInstances: [], fileOwners: [], phaseBindings: [], unresolved: [] },
        cuaPlan: { steps: [] },
      },
    },
    addLog(stage, message) {
      logs.push({ stage, message });
    },
  };

  assert.strictEqual(codegenSchema._internals.shouldUsePrebuiltGameSchema(ctx), true);
  await codegenSchema.execute(ctx);

  assert.strictEqual(ctx.blueprint.prebuiltGameSchemaUsed, true);
  assert.strictEqual(ctx.blueprint.schemaTokensIn, 0);
  assert.strictEqual(ctx.blueprint.schemaTokensOut, 0);
  assert.strictEqual(ctx.blueprint.templateValidation.passed, true);
  assert.ok(ctx.csCode.includes('public partial class GameFlowManagerMain'));
  assert.ok(ctx.extraFiles['GameFlowManagerMain.Flow.cs'], 'W1b flow partial should be emitted');
  assert.ok(logs.some(entry => /Using prebuilt gameSchema/.test(entry.message)));

  console.log('codegen-schema prebuilt gameSchema test passed');
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
