var assert = require('assert');

var { buildProjectPlans } = require('../adapters/assembly-plan-pipeline.cjs');

var project = {
  name: 'AssemblyPlanSmoke',
  storyboardFrames: [
    { title: 'Intro', interaction: 'move_to:ConveyorBelt', camera: '镜头拉高看到全局', ui: '高亮传送带' },
    { title: 'Build', interaction: 'build:ConveyorBelt', note: '金币+1飘字' }
  ],
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
    },
    {
      name: 'Enemy',
      label: '敌人',
      template: 'Mover+Damageable',
      visual: { position: '(4,0,4)', scale: '1×1×1' },
      behavior: { moveTarget: 'Player', moveSpeed: 2, hp: 3 }
    }
  ],
  phases: [
    { id: 1, name: '靠近传送带', activate: ['Player', 'ConveyorBelt'], guide: '靠近传送带', camera: { lookAt: 'ConveyorBelt', zoom: 1.2 } },
    { id: 2, name: '建造炮塔', activate: ['Turret'], guide: '建造并查看炮塔' }
  ],
  specs: [
    { phaseId: 'intro', requiredInteractions: ['move_to:ConveyorBelt'] },
    { phaseId: 'build', requiredInteractions: ['build:ConveyorBelt'] }
  ]
};

var plans = buildProjectPlans(project);

assert.ok(plans.validation.ok, 'plans should validate');
assert.ok(plans.storyboardAtomPlan.items.some(function(atom) { return atom.atomId === 'move_to'; }), 'move_to atom missing');
assert.ok(plans.storyboardAtomPlan.items.some(function(atom) { return atom.atomId === 'build_entity'; }), 'build_entity atom missing');
assert.ok(plans.storyboardAtomPlan.items.some(function(atom) { return atom.atomId === 'camera_lift'; }), 'camera_lift atom missing');
assert.ok(plans.storyboardAtomPlan.items.some(function(atom) { return atom.atomId === 'highlight_target'; }), 'highlight_target atom missing');
assert.ok(plans.storyboardAtomPlan.items.some(function(atom) { return atom.atomId === 'show_floating_text'; }), 'show_floating_text atom missing');

var player = plans.entityPlan.entities.find(function(entity) { return entity.name === 'Player'; });
var conveyor = plans.entityPlan.entities.find(function(entity) { return entity.name === 'ConveyorBelt'; });
var enemy = plans.entityPlan.entities.find(function(entity) { return entity.name === 'Enemy'; });

assert.ok(player.modules.some(function(module) { return module.moduleId === 'player_input_joystick'; }), 'player_input_joystick missing');
assert.ok(conveyor.modules.some(function(module) { return module.moduleId === 'build_progress'; }), 'build_progress missing');
assert.ok(conveyor.modules.some(function(module) { return module.moduleId === 'cost_gate'; }), 'cost_gate missing');
assert.ok(conveyor.modules.some(function(module) { return module.moduleId === 'activate_targets'; }), 'activate_targets missing');
assert.ok(enemy.modules.some(function(module) { return module.moduleId === 'move_to_target'; }), 'enemy move_to_target missing');
assert.ok(enemy.modules.some(function(module) { return module.moduleId === 'damageable'; }), 'enemy damageable missing');

assert.ok(plans.entityPlan.systemModules.some(function(module) { return module.moduleId === 'guide_ui'; }), 'guide_ui system module missing');
assert.ok(plans.entityPlan.systemModules.some(function(module) { return module.moduleId === 'camera_focus'; }), 'camera_focus system module missing');

var buildStep = plans.cuaPlan.steps.find(function(step) { return step.phaseId === 'build'; });
assert.ok(buildStep, 'build cua step missing');
assert.ok(buildStep.actions.some(function(action) { return action.kind === 'build'; }), 'build action missing');
assert.ok(buildStep.expectedSignals.indexOf('entity_state_equals_built') >= 0, 'build completion signal missing');
assert.ok(
  buildStep.phaseEvidenceSchema.some(function(entry) { return entry.signal === 'entity_state_equals_built'; }),
  'build phase evidence schema missing entity_state_equals_built'
);
var conveyorBuildModule = plans.assemblyPlan.moduleInstances.find(function(module) {
  return module.id === 'ConveyorBelt::build_progress';
});
assert.ok(conveyorBuildModule, 'build_progress module instance missing');
assert.ok(
  conveyorBuildModule.expectedSignals.indexOf('entity_state_equals_built') >= 0,
  'module contract expected signal missing'
);
assert.ok(
  conveyorBuildModule.phaseEvidenceSchema.some(function(entry) { return entry.signal === 'entity_state_equals_built'; }),
  'module contract phase evidence schema missing'
);
assert.ok(plans.storyboardAtomPlan.items.every(function(item) {
  return item.phaseId === 'intro' || item.phaseId === 'build';
}), 'storyboard atoms should use canonical spec phase IDs');
assert.ok(player.phaseRefs.indexOf('intro') >= 0, 'player phaseRefs should use canonical intro phaseId');
assert.ok(conveyor.phaseRefs.indexOf('intro') >= 0, 'conveyor phaseRefs should use canonical intro phaseId');
assert.ok(plans.assemblyPlan.phaseBindings.every(function(binding, index) {
  return binding.phaseId === (index === 0 ? 'intro' : 'build');
}), 'assembly phaseBindings should use canonical spec phase IDs');
assert.ok(
  plans.assemblyPlan.unresolved.every(function(item) { return item.kind !== 'state_owner_conflict'; }),
  'P0 module plan should not emit state owner conflicts'
);
var playerMoveModule = plans.assemblyPlan.moduleInstances.find(function(module) {
  return module.id === 'Player::move_to_target';
});
assert.ok(playerMoveModule, 'move_to atom should attach move_to_target to actor/player');
assert.strictEqual(playerMoveModule.params.target, 'ConveyorBelt', 'move_to_target actor module should preserve target param');

var genericSpendPlans = buildProjectPlans({
  name: 'GenericSpendDefaults',
  storyboardFrames: [],
  entities: project.entities,
  phases: [{ id: 1, name: '花费资源', activate: ['ConveyorBelt'] }],
  specs: [{ phaseId: 'spendPhase', requiredInteractions: ['spend::2:ConveyorBelt'] }]
});
var spendTarget = genericSpendPlans.entityPlan.entities.find(function(entity) { return entity.name === 'ConveyorBelt'; });
var spendGate = spendTarget.modules.find(function(module) { return module.moduleId === 'cost_gate'; });
assert.ok(spendGate, 'generic spend should resolve to cost_gate');
assert.strictEqual(spendGate.params.resource, 'resource', 'empty spend resource should default to generic resource kind');
assert.strictEqual(spendGate.params.amount, 2, 'generic spend amount should be preserved');

var implicitBuildCostPlans = buildProjectPlans({
  name: 'ImplicitBuildUpgradeCostDefaults',
  storyboardFrames: [],
  entities: [
    { name: 'Player', template: 'PlayerController', behavior: { moveSpeed: 5 } },
    { name: 'ConveyorBelt', template: 'Buildable', trigger: { type: 'proximity', params: { radius: 2 } }, behavior: { buildTime: 2 } },
    { name: 'TripleDrill', template: 'Upgradeable', behavior: { upgradeLevels: [2] } }
  ],
  phases: [{ id: 1, name: '建造升级', activate: ['ConveyorBelt', 'TripleDrill'] }],
  specs: [{ phaseId: 'buildUpgrade', requiredInteractions: ['build:ConveyorBelt', 'upgrade:TripleDrill:2'] }]
});
var implicitBuildTarget = implicitBuildCostPlans.entityPlan.entities.find(function(entity) { return entity.name === 'ConveyorBelt'; });
var implicitUpgradeTarget = implicitBuildCostPlans.entityPlan.entities.find(function(entity) { return entity.name === 'TripleDrill'; });
var implicitBuildGate = implicitBuildTarget.modules.find(function(module) { return module.moduleId === 'cost_gate'; });
var implicitUpgradeGate = implicitUpgradeTarget.modules.find(function(module) { return module.moduleId === 'cost_gate'; });
assert.strictEqual(implicitBuildGate.params.resource, 'gold', 'implicit build cost_gate should default placeholder resource to gold');
assert.strictEqual(implicitUpgradeGate.params.resource, 'gold', 'implicit upgrade cost_gate should default placeholder resource to gold');

var recruitPlans = buildProjectPlans({
  name: 'RecruitWorkerPlan',
  storyboardFrames: [],
  entities: [
    { name: 'Player', template: 'PlayerController', behavior: { moveSpeed: 5 } },
    { name: 'WorkerAI', label: 'worker', template: 'Static' },
    { name: 'BasePlatform', template: 'Buildable', behavior: { buildTime: 1 } }
  ],
  phases: [{ id: 1, name: '招募工人', activate: ['WorkerAI'] }],
  specs: [{ phaseId: 'recruitWorker', requiredInteractions: ['click:BasePlatform', 'spend:gold:20', 'recruit:worker:1'] }]
});
assert.ok(recruitPlans.validation.ok, 'recruit plans should validate');
assert.strictEqual(recruitPlans.assemblyPlan.unresolved.length, 0, 'recruit interaction should not be unresolved');
assert.ok(
  recruitPlans.storyboardAtomPlan.items.some(function(atom) {
    return atom.atomId === 'spawn_entity' && atom.params.entity === 'WorkerAI' && atom.params.count === 1;
  }),
  'recruit should map to spawn_entity on the worker entity'
);
assert.ok(
  recruitPlans.assemblyPlan.moduleInstances.some(function(module) {
    return module.id === 'WorkerAI::spawn_once';
  }),
  'recruit should attach spawn_once to recruited worker'
);

var pipeTemplatePlans = buildProjectPlans({
  name: 'PipeTemplateAliases',
  storyboardFrames: [],
  entities: [
    { name: 'Player', template: 'PlayerController', behavior: { moveSpeed: 5 } },
    { name: 'EnemyA', template: 'Damageable|Mover', behavior: { hp: 3, moveTarget: 'Player', moveSpeed: 2 } }
  ],
  phases: [{ id: 1, name: '敌人移动', activate: ['EnemyA'] }],
  specs: [{ phaseId: 'enemyMove', requiredInteractions: ['attack:EnemyA'] }]
});
assert.strictEqual(pipeTemplatePlans.assemblyPlan.unresolved.length, 0, 'pipe-separated templates should not be unresolved');
var enemyA = pipeTemplatePlans.entityPlan.entities.find(function(entity) { return entity.name === 'EnemyA'; });
assert.ok(enemyA.modules.some(function(module) { return module.moduleId === 'damageable'; }), 'Damageable module should be parsed from pipe template');
assert.ok(enemyA.modules.some(function(module) { return module.moduleId === 'move_to_target'; }), 'Mover module should be parsed from pipe template');

console.log('assembly-plan-pipeline tests passed');
