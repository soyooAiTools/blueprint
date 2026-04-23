var assert = require('assert');

var { generateSkeleton } = require('../adapters/skeleton-generator.cjs');
var assemblyEmitter = require('../adapters/assembly-emitter.cjs');
var { buildProjectPlans } = require('../adapters/assembly-plan-pipeline.cjs');

var project = {
  name: 'AssemblyEmitterProject',
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
      behavior: { buildTime: 2 }
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
    { phaseId: 'intro', phaseName: 'Intro', requiredInteractions: ['move_to:ConveyorBelt'], duration: { min: 12, max: 18 } },
    { phaseId: 'build', phaseName: 'Build', requiredInteractions: ['build:ConveyorBelt'], duration: { min: 12, max: 18 } }
  ]
};

var plans = buildProjectPlans(project);
var skeleton = generateSkeleton(project.specs, {
  entityPoolMap: {
    Player: '__Pool_Cube_White_01',
    ConveyorBelt: '__Pool_Cube_Red_02',
    Turret: '__Pool_Cylinder_Blue_03'
  },
  entities: project.entities.map(function(entity) {
    return {
      name: entity.name,
      chineseName: entity.label,
      showLabel: true
    };
  }),
  w1bSplit: true
});

assert.strictEqual(skeleton.mode, 'w1b-5partial', 'expected 5-partial skeleton');

var emitted = assemblyEmitter.applyAssemblyPlanToSkeleton(skeleton, plans);
assert.ok(emitted.slotCount > 0, 'expected assembly slot count > 0');
assert.ok(emitted.files.input.indexOf('AssemblySlot_Input_Player__player_input_joystick') >= 0, 'input slot missing');
assert.ok(emitted.files.resource.indexOf('[ASSEMBLY OWNER MANIFEST]') >= 0, 'resource owner manifest missing');
assert.ok(emitted.files.scene.indexOf('AssemblySlot_Scene_Player__visual_binding') >= 0, 'scene slot missing');
assert.ok(emitted.files.ui.indexOf('AssemblySlot_UI_system__guide_ui') >= 0, 'ui system slot missing');
assert.ok(emitted.files.flow.indexOf('[ASSEMBLY PHASE] phaseId=intro') >= 0, 'flow phase annotation missing');
assert.ok(emitted.files.flow.indexOf('AssemblySlot_Flow_ConveyorBelt__build_progress') >= 0, 'flow slot missing');

var generatedFlow = emitted.files.flow
  .replace('// ownerFile: GameFlowManagerMain.Flow.cs', '// ownerFile: HACKED')
  .replace(
    '// Implement only `build_progress` for `ConveyorBelt` in this owner file.',
    '        PlaceObj(ConveyorBelt, 1f, 2f, 3f);'
  );
var mergedFlow = assemblyEmitter.mergeAssemblySlotEdits(emitted.files.flow, generatedFlow);
assert.strictEqual(mergedFlow.preservedSlotCount > 0, true, 'slot merge should preserve slot body edits');
assert.strictEqual(mergedFlow.strippedEditCount > 0, true, 'slot merge should strip outside-slot edits');
assert.ok(mergedFlow.content.indexOf('PlaceObj(ConveyorBelt, 1f, 2f, 3f);') >= 0, 'slot body edit should survive');
assert.ok(mergedFlow.content.indexOf('// ownerFile: HACKED') === -1, 'outside-slot manifest edit should be stripped');

var noSlotMerge = assemblyEmitter.mergeAssemblySlotEdits(
  'public partial class Demo\n{\n    void Tick() {}\n}\n',
  'public partial class Demo\n{\n    void Tick() { Debug.Log("hack"); }\n}\n'
);
assert.strictEqual(noSlotMerge.content.indexOf('Debug.Log("hack");') === -1, true, 'files without slots should stay on baseline');
assert.strictEqual(noSlotMerge.strippedEditCount > 0, true, 'non-slot edits should be reported as stripped');

console.log('assembly-emitter tests passed');
