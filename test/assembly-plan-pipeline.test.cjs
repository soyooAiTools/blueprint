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
    { id: 1, name: 'intro', activate: ['Player', 'ConveyorBelt'], guide: '靠近传送带', camera: { lookAt: 'ConveyorBelt', zoom: 1.2 } },
    { id: 2, name: 'build', activate: ['Turret'], guide: '建造并查看炮塔' }
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

console.log('assembly-plan-pipeline tests passed');
