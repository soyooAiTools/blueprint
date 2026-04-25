var assert = require('assert');

var assemblyStage = require('../engine/stages/assembly-plan.cjs');
var assemblyComplexityGateStage = require('../engine/stages/assembly-complexity-gate.cjs');
var codegenSchemaStage = require('../engine/stages/codegen-schema.cjs');
var pipeline = require('../engine/pipeline.cjs');

var ctx = {
  taskId: 'assembly_stage_test',
  blueprint: {
    projectName: 'AssemblyStagePrompt',
    storyboard: {
      frames: [
        { title: 'Intro', interaction: 'move_to:ConveyorBelt', camera: '镜头拉高看到全局', ui: '高亮传送带' },
        { title: 'Build', interaction: 'build:ConveyorBelt', note: '金币+1飘字' }
      ],
      config: { cameraAngle: 'topDown45' }
    },
    entities: [
      {
        name: 'Player',
        label: '玩家',
        template: 'PlayerController',
        visual: { position: '(0,0,0)', scale: '1×1×1' },
        behavior: { moveSpeed: 5 }
      },
      {
        name: 'ConveyorBelt',
        label: '传送带',
        template: 'Buildable',
        visual: { position: '(1,0,1)', scale: '1×1×1' },
        trigger: { type: 'proximity', params: { radius: 2, cost: { gold: 1 } } },
        behavior: {
          buildTime: 2,
          onBuilt: [{ type: 'activate', params: { target: 'Turret' } }]
        }
      },
      {
        name: 'Turret',
        label: '炮塔',
        template: 'Shooter',
        visual: { position: '(2,0,2)', scale: '1×1×1' },
        behavior: { projectile: 'Arrow', fireRate: 1, damage: 1, targetTag: 'enemy', range: 8 }
      }
    ],
    phases: [
      { id: 1, name: 'intro', activate: ['Player', 'ConveyorBelt'], guide: '靠近传送带', camera: { lookAt: 'ConveyorBelt', zoom: 1.1 } },
      { id: 2, name: 'build', activate: ['Turret'], guide: '建造并查看炮塔' }
    ],
    specs: [
      { phaseId: 'intro', requiredInteractions: ['move_to:ConveyorBelt'] },
      { phaseId: 'build', requiredInteractions: ['build:ConveyorBelt'] }
    ]
  },
  addLog: function() {}
};

var result = assemblyStage.execute(ctx);

assert.ok(ctx.blueprint.plans, 'assembly-plan stage should attach plans');
assert.ok(ctx.blueprint.planValidation && ctx.blueprint.planValidation.ok, 'plan validation should pass');
assert.ok(result.atomCount >= 4, 'atomCount should be populated');
assert.ok(result.moduleInstanceCount >= 4, 'moduleInstanceCount should be populated');
assert.ok(result.cuaStepCount >= 2, 'cuaStepCount should be populated');
assert.ok(ctx.blueprint.assemblyCoverage > 0, 'assemblyCoverage should be set');

var gateResult = assemblyComplexityGateStage.execute(ctx);
assert.ok(ctx.blueprint.assemblyDecision, 'assembly-complexity-gate should set assemblyDecision');
assert.ok(ctx.blueprint.assemblyRiskLevel, 'assembly-complexity-gate should set assemblyRiskLevel');
assert.ok(ctx.blueprint.assemblyImplementationCoverage > 0, 'assembly-complexity-gate should set implementation coverage');
assert.ok(Array.isArray(ctx.blueprint.assemblyImplementationMissingModuleIds), 'assembly-complexity-gate should set missing implementation module ids');
assert.ok(gateResult.decision, 'assembly-complexity-gate should return a decision');

var cautionWithMissing = assemblyComplexityGateStage._internals.decideAssemblyRisk({
  unresolvedCount: 0,
  assemblyCoverage: 0.9,
  assemblyImplementationCoverage: 0.99,
  assemblyImplementationMissingCount: 1,
});
assert.strictEqual(cautionWithMissing.decision, 'assembly_caution', 'missing impl can still be caution by coverage');
assert.strictEqual(cautionWithMissing.fallbackRequired, true, 'missing impl must require fallback');

var prompt = codegenSchemaStage._internals.buildSchemaPrompt(ctx);
assert.ok(prompt.indexOf('## Assembly Plan（必须遵守）') >= 0, 'schema prompt should include assembly plan section');
assert.ok(prompt.indexOf('"phaseBindings"') >= 0, 'schema prompt should include phaseBindings');
assert.ok(prompt.indexOf('"stateOwners"') >= 0, 'schema prompt should include stateOwners');

var stageNames = pipeline.createLunaPipeline().stages.map(function(stage) { return stage.name; });
var complexityIdx = stageNames.indexOf('complexity-gate');
var assemblyIdx = stageNames.indexOf('assembly-plan');
var assemblyGateIdx = stageNames.indexOf('assembly-complexity-gate');
var codegenIdx = stageNames.indexOf('codegen');
assert.ok(complexityIdx >= 0 && assemblyIdx > complexityIdx, 'assembly-plan should run after complexity-gate');
assert.ok(assemblyGateIdx > assemblyIdx, 'assembly-complexity-gate should run after assembly-plan');
assert.ok(codegenIdx > assemblyGateIdx, 'assembly-complexity-gate should run before codegen');

console.log('assembly-stage-and-prompt tests passed');
