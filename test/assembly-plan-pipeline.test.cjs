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

var ctaCasePlans = buildProjectPlans({
  name: 'CtaCaseExactWins',
  storyboardFrames: [],
  entities: [
    { name: 'Player', template: 'PlayerController', behavior: { moveSpeed: 5 } },
    { name: 'CTAButton', label: '下载按钮', template: 'UI' },
    { name: 'CtaButton', label: '增援', template: 'UI' }
  ],
  phases: [{ id: 1, name: '下载', activate: ['CTAButton'] }],
  specs: [{ phaseId: 'finish', requiredInteractions: ['move_to:CTAButton'] }]
});
var ctaMoveAtom = ctaCasePlans.storyboardAtomPlan.items.find(function(atom) {
  return atom.atomId === 'move_to' && atom.phaseId === 'finish';
});
assert.ok(ctaMoveAtom, 'CTA move atom missing');
assert.strictEqual(ctaMoveAtom.params.target, 'CTAButton', 'exact CTAButton should not be normalized to fallback CtaButton when both exist');
var ctaMoveModule = ctaCasePlans.assemblyPlan.moduleInstances.find(function(module) {
  return module.id === 'Player::move_to_target';
});
assert.ok(ctaMoveModule, 'CTA move_to_target module missing');
assert.strictEqual(ctaMoveModule.params.target, 'CTAButton', 'move_to_target should preserve exact CTAButton target');

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

var resourceTargetPlans = buildProjectPlans({
  name: 'ResourceTargetFallbackKeepsSemanticResource',
  storyboardFrames: [
    { title: '采冰', interaction: 'move_to:IceChunk,collect:Ice:5' }
  ],
  entities: [
    { name: 'Player', template: 'PlayerController', behavior: { moveSpeed: 5 } },
    { name: 'IceSpawner', template: 'Static' },
    { name: 'IceChunk', template: 'Static' }
  ],
  phases: [{ id: 1, name: '采冰', activate: ['Player', 'IceSpawner', 'IceChunk'], guide: '采冰' }],
  specs: [{
    phaseId: 'phase1',
    requiredInteractions: ['move_to:IceChunk', 'collect:Ice:5'],
    entitiesRequired: [{ name: 'Player' }, { name: 'IceSpawner' }, { name: 'IceChunk', resource: 'Ice' }]
  }]
});
assert.strictEqual(resourceTargetPlans.storyboardAtomPlan.unresolved.length, 0, 'resource collect should not become unresolved when resource name is not an entity');
var iceCollectAtom = resourceTargetPlans.storyboardAtomPlan.items.find(function(atom) {
  return atom.atomId === 'collect_nearby' && atom.phaseId === 'phase1';
});
assert.ok(iceCollectAtom, 'semantic resource collect atom missing');
assert.strictEqual(iceCollectAtom.params.target, 'IceChunk', 'collect target should fall back to visible phase resource entity');
assert.strictEqual(iceCollectAtom.params.item, 'Ice', 'collect item should keep semantic resource name');
assert.strictEqual(iceCollectAtom.params.count, 5, 'collect count should keep trigger amount');
assert.strictEqual(
  resourceTargetPlans.storyboardAtomPlan.items.filter(function(atom) {
    return atom.atomId === 'collect_nearby' && atom.phaseId === 'phase1';
  }).length,
  1,
  'structured storyboard frame DSL should not create a duplicate collect atom'
);
var iceCollectModule = resourceTargetPlans.assemblyPlan.moduleInstances.find(function(module) {
  return module.id === 'IceChunk::collect_on_near';
});
assert.ok(iceCollectModule, 'visible resource target should own collect_on_near');
assert.strictEqual(iceCollectModule.params.resource, 'Ice', 'collect_on_near should add semantic resource, not visible entity id');
assert.strictEqual(iceCollectModule.params.item, 'Ice', 'collect_on_near item should remain semantic resource');
assert.strictEqual(iceCollectModule.params.count, 5, 'collect_on_near count should remain semantic amount');
var iceCuaStep = resourceTargetPlans.cuaPlan.steps.find(function(step) { return step.phaseId === 'phase1'; });
assert.ok(iceCuaStep.actions.some(function(action) {
  return action.kind === 'approach_collect' && action.target === 'IceChunk' && action.item === 'Ice' && action.count === 5;
}), 'CUA plan should steer to visible target while validating semantic resource');

var resourceMoveTargetPlans = buildProjectPlans({
  name: 'ResourceMoveTargetKeepsSemanticCount',
  storyboardFrames: [
    { title: '掉落资源', interaction: '收集敌人掉落资源' }
  ],
  entities: [
    { name: 'Player', template: 'PlayerController', behavior: { moveSpeed: 5 } },
    { name: 'DropResource', template: 'Static' }
  ],
  phases: [{ id: 1, name: '掉落资源', activate: ['Player', 'DropResource'], guide: '收集掉落资源' }],
  specs: [{
    phaseId: 'phase4',
    requiredInteractions: ['move_to:DropResource', 'collect:Gold:80'],
    entitiesRequired: [{ name: 'DropResource' }]
  }]
});
var dropCollectModule = resourceMoveTargetPlans.assemblyPlan.moduleInstances.find(function(module) {
  return module.id === 'DropResource::collect_on_near';
});
assert.ok(dropCollectModule, 'collect resource should be owned by the visible move target even without entitiesRequired.resource');
assert.strictEqual(dropCollectModule.params.resource, 'Gold', 'visible collect target must not overwrite semantic resource');
assert.strictEqual(dropCollectModule.params.item, 'Gold', 'visible collect target must not overwrite semantic item');
assert.strictEqual(dropCollectModule.params.count, 80, 'fallback collect text must not downgrade semantic resource count to 1');
var dropCuaStep = resourceMoveTargetPlans.cuaPlan.steps.find(function(step) { return step.phaseId === 'phase4'; });
assert.ok(dropCuaStep.actions.some(function(action) {
  return action.kind === 'approach_collect' && action.target === 'DropResource' && action.item === 'Gold' && action.count === 80;
}), 'CUA plan should steer to DropResource while asserting Gold:80');
assert.strictEqual(
  dropCuaStep.actions.filter(function(action) { return action.kind === 'approach_collect'; }).length,
  1,
  'guide/prose collect fallback should not add a second count=1 collect action when spec already has collect'
);

var prebuiltSchemaPlans = buildProjectPlans({
  name: 'PrebuiltSchemaSuppressesGameplayTextAtoms',
  schemaSource: 'source-scene-ir',
  prebuiltGameSchema: true,
  storyboardFrames: [
    { title: '升级钻头', interaction: 'build:ForgeWorkshop', ui: '使用新钻头采集垃圾拾取垃圾 build:ForgeWorkshop' }
  ],
  entities: [
    { name: 'Player', template: 'PlayerController', behavior: { moveSpeed: 5 } },
    { name: 'ForgeWorkshop', template: 'Buildable', behavior: { buildTime: 1 } },
    { name: 'Drill', template: 'Static' }
  ],
  phases: [{ id: 1, name: '升级钻头', activate: ['Player', 'ForgeWorkshop'], guide: '使用新钻头采集垃圾拾取垃圾' }],
  specs: [{
    phaseId: 'phase3',
    requiredInteractions: ['move_to:ForgeWorkshop', 'build:ForgeWorkshop'],
    entitiesRequired: [{ name: 'Player' }, { name: 'ForgeWorkshop' }]
  }]
});
assert.strictEqual(prebuiltSchemaPlans.storyboardAtomPlan.sourceSummary.gameplayTextAtomsEnabled, false);
assert.strictEqual(
  prebuiltSchemaPlans.storyboardAtomPlan.items.filter(function(atom) {
    return atom.atomId === 'collect_nearby' && atom.source && atom.source.kind === 'frame_text';
  }).length,
  0,
  'prebuilt SourceIR/schema phases must not infer extra gameplay collect atoms from guide text'
);

console.log('assembly-plan-pipeline tests passed');
