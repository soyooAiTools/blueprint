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
assert.ok(emitted.files.flow.indexOf('cameraFocusTarget = "ConveyorBelt";') >= 0 || emitted.files.scene.indexOf('cameraFocusTarget = "ConveyorBelt";') >= 0, 'camera focus slot should bind phase target');
assert.ok(emitted.files.flow.indexOf('mainCam.orthographicSize = ') >= 0 || emitted.files.scene.indexOf('mainCam.orthographicSize = ') >= 0, 'camera zoom slot should emit deterministic ortho size');
assert.ok(emitted.files.flow.indexOf('Vector3.MoveTowards(__assemblyBefore, ConveyorBelt.transform.position') >= 0, 'move_to_target slot should move actor toward target');
assert.ok(emitted.files.flow.indexOf('RecordPhaseEvidenceFlag(currentPhaseName, "player_position_changed")') >= 0, 'move_to_target should record player motion evidence');
assert.ok(emitted.files.flow.indexOf('RecordPhaseEvidenceFlag(currentPhaseName, "entity_state_equals_built")') >= 0, 'build_progress should record built evidence');
assert.ok(emitted.files.input.indexOf('RecordPhaseEvidenceFlag(currentPhaseName, "tap_registered")') >= 0, 'tap/click slot should record tap evidence');
assert.ok(emitted.files.resource.indexOf('TrySpend("gold", 1)') >= 0, 'cost_gate should spend configured resource through owner API');
assert.ok(emitted.files.resource.indexOf('RecordPhaseEvidenceFlag(currentPhaseName, "resource_decremented")') >= 0, 'cost_gate should record resource decrement evidence');
assert.ok(emitted.files.input.indexOf('ConveyorBeltState = Mathf.Max') === -1, 'click/input slots must not mutate build state owner fields');
assert.ok(emitted.files.resource.indexOf('ConveyorBeltState = Mathf.Max') === -1, 'cost slots must not mutate build state owner fields');
assert.ok(emitted.files.scene.indexOf('ConveyorBeltState = Mathf.Max') === -1, 'visual slots must not mutate build state owner fields');
assert.ok(emitted.files.scene.indexOf('RecordPhaseEvidenceFlag(currentPhaseName, "entity_visible")') >= 0, 'visual_binding should record visibility evidence');
assert.ok(emitted.files.ui.indexOf('RecordPhaseEvidenceFlag(currentPhaseName, "guide_text_visible")') >= 0, 'guide_ui should record guide evidence');
assert.ok(emitted.files.scene.indexOf('RecordPhaseEvidenceFlag(currentPhaseName, "camera_zoom_changed")') >= 0, 'camera slots should record camera evidence');
assert.ok(emitted.files.main.indexOf('AssemblyRunFlowSlots();') >= 0, 'main should tick flow assembly runner');
assert.ok(emitted.files.main.indexOf('AssemblyRunUISlots();') >= 0, 'main should tick ui assembly runner');
assert.ok(/^\s*\/\/\s*"target":\s*".+"/m.test(emitted.files.input), 'multiline params should stay commented');
assert.ok(!/^\s*"target":\s*".+"/m.test(emitted.files.input), 'raw JSON params should not leak into C#');

var commentedJsonLines = assemblyEmitter.buildCommentedJsonLines('    // params: ', { target: 'OurBase', nested: { level: 2 } });
assert.deepStrictEqual(commentedJsonLines, [
  '    // params: {',
  '    //   "target": "OurBase",',
  '    //   "nested": {',
  '    //     "level": 2',
  '    //   }',
  '    // }'
], 'commented JSON lines should prefix every line');

var generatedFlow = emitted.files.flow
  .replace('// ownerFile: GameFlowManagerMain.Flow.cs', '// ownerFile: HACKED')
  .replace(
    '        ConveyorBeltState = 2;',
    '        ConveyorBeltState = 2;\n        PlaceObj(ConveyorBelt, 1f, 2f, 3f);'
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

var genericSkeleton = {
  mode: 'w1b-5partial',
  main: 'public partial class GameFlowManagerMain\n{\n    void Update()\n    {\n        // TODO_CUSTOM_START\n        // TODO_CUSTOM_END\n    }\n}\n',
  flow: 'public partial class GameFlowManagerMain\n{\n}\n',
  input: 'public partial class GameFlowManagerMain\n{\n    // TODO_INPUT_METHODS_START\n    // TODO_INPUT_METHODS_END\n}\n',
  resource: 'public partial class GameFlowManagerMain\n{\n    // TODO_RESOURCE_METHODS_START\n    // TODO_RESOURCE_METHODS_END\n}\n',
  ui: 'public partial class GameFlowManagerMain\n{\n    // TODO_UI_START\n    // TODO_UI_END\n}\n',
  scene: 'public partial class GameFlowManagerMain\n{\n}\n'
};
var genericPlans = {
  assemblyPlan: {
    moduleInstances: [
      {
        id: 'Recycler::deliver_to_target',
        moduleId: 'deliver_to_target',
        entity: 'Recycler',
        params: { resource: 'debris', target: 'Recycler', reward: 2, rewardResource: 'energy' },
        ownerFiles: ['GameFlowManagerMain.Resource.cs'],
        statesWritten: ['economy.resources'],
        sources: ['test'],
        sourceAtomIds: ['atom_001']
      }
    ],
    fileOwners: [
      { file: 'GameFlowManagerMain.Resource.cs', moduleInstanceIds: ['Recycler::deliver_to_target'] }
    ],
    phaseBindings: [],
    stateOwners: [],
    eventGraph: [],
    unresolved: []
  },
  cuaPlan: { steps: [] }
};
var genericEmitted = assemblyEmitter.applyAssemblyPlanToSkeleton(genericSkeleton, genericPlans);
assert.ok(genericEmitted.files.resource.indexOf('AddResource("energy", 2 * deliverCount);') >= 0, 'deliver slot should grant parameterized reward resource');
assert.ok(genericEmitted.files.resource.indexOf('AddGold(2 * deliverCount);') === -1, 'non-gold deliver reward should not hardcode AddGold');
assert.ok(genericEmitted.files.resource.indexOf('RecordPhaseEvidenceFlag(currentPhaseName, "inventory_decremented")') >= 0, 'deliver slot should record inventory evidence');
assert.ok(genericEmitted.files.resource.indexOf('RecordPhaseEvidenceFlag(currentPhaseName, "reward_incremented")') >= 0, 'deliver slot should record reward evidence');
assert.ok(genericEmitted.files.resource.indexOf('" energy"') >= 0, 'floating text should use parameterized reward label');

var fallbackSkeleton = {
  mode: 'w1b-5partial',
  main: 'public partial class GameFlowManagerMain\n{\n    void Update()\n    {\n        // TODO_CUSTOM_START\n        // TODO_CUSTOM_END\n    }\n}\n',
  flow: [
    'public partial class GameFlowManagerMain',
    '{',
    '    void Phase_buildDefenseTower_OnAutoPlayArrive(string targetName)',
    '    {',
    '        // TODO_PHASE_buildDefenseTower_ONAUTOARRIVE_START',
    '        if (!buildDefenseTowerInteractionDone && !buildDefenseTowerPlayerActed)',
    '        {',
    '            RecordPhaseEvidenceFlag("buildDefenseTower", "guide_text_visible");',
    '        }',
    '        // TODO_PHASE_buildDefenseTower_ONAUTOARRIVE_END',
    '    }',
    '    void Phase_buildConveyorBelt_OnAutoPlayArrive(string targetName)',
    '    {',
    '        // TODO_PHASE_buildConveyorBelt_ONAUTOARRIVE_START',
    '        if (!buildConveyorBeltInteractionDone && !buildConveyorBeltPlayerActed)',
    '        {',
    '            RecordPhaseEvidenceFlag("buildConveyorBelt", "guide_text_visible");',
    '        }',
    '        // TODO_PHASE_buildConveyorBelt_ONAUTOARRIVE_END',
    '    }',
    '    void Phase_occupyEnemyBaseCTA_OnAutoPlayArrive(string targetName)',
    '    {',
    '        // TODO_PHASE_occupyEnemyBaseCTA_ONAUTOARRIVE_START',
    '        if (!occupyEnemyBaseCTAInteractionDone && !occupyEnemyBaseCTAPlayerActed)',
    '        {',
    '            RecordPhaseEvidenceFlag("occupyEnemyBaseCTA", "guide_text_visible");',
    '        }',
    '        // TODO_PHASE_occupyEnemyBaseCTA_ONAUTOARRIVE_END',
    '    }',
    '}',
    ''
  ].join('\n'),
  input: genericSkeleton.input,
  resource: genericSkeleton.resource,
  ui: genericSkeleton.ui,
  scene: genericSkeleton.scene
};
var fallbackPlans = {
  assemblyPlan: {
    moduleInstances: [],
    fileOwners: [],
    phaseBindings: [
      {
        phaseId: 'buildDefenseTower',
        completionSignals: ['guide_text_visible', 'target_hp_decreased_or_target_dead']
      },
      {
        phaseId: 'buildConveyorBelt',
        completionSignals: ['guide_text_visible', 'source_hidden_or_moved', 'player_position_changed']
      },
      {
        phaseId: 'occupyEnemyBaseCTA',
        completionSignals: ['guide_text_visible', 'target_removed_or_hidden', 'loot_visible']
      }
    ],
    stateOwners: [],
    eventGraph: [],
    unresolved: []
  },
  cuaPlan: {
    steps: [
      {
        phaseId: 'buildDefenseTower',
        actions: [{ kind: 'attack', target: 'Gold' }],
        expectedSignals: ['target_hp_decreased_or_target_dead']
      },
      {
        phaseId: 'buildConveyorBelt',
        actions: [{ kind: 'approach_collect', target: 'RocketDebris' }, { kind: 'move_to', target: 'ConveyorBelt' }],
        expectedSignals: ['source_hidden_or_moved', 'player_position_changed']
      },
      {
        phaseId: 'occupyEnemyBaseCTA',
        actions: [{ kind: 'observe_defeat', target: 'EnemyBase' }],
        expectedSignals: ['target_removed_or_hidden', 'loot_visible']
      }
    ]
  }
};
var fallbackEmitted = assemblyEmitter.applyAssemblyPlanToSkeleton(fallbackSkeleton, fallbackPlans);
assert.ok(fallbackEmitted.files.flow.indexOf('RecordPhaseEvidenceFlag("buildDefenseTower", "target_hp_decreased_or_target_dead")') >= 0, 'autoplay fallback should record action-backed damage evidence');
assert.ok(fallbackEmitted.files.flow.indexOf('RecordPhaseEvidenceFlag("buildConveyorBelt", "source_hidden_or_moved")') >= 0, 'autoplay fallback should record action-backed collect movement evidence');
assert.ok(fallbackEmitted.files.flow.indexOf('RecordPhaseEvidenceFlag("buildConveyorBelt", "player_position_changed")') >= 0, 'autoplay fallback should record action-backed move_to evidence');
assert.ok(fallbackEmitted.files.flow.indexOf('if (EnemyBase != null) HideObj(EnemyBase);') >= 0, 'autoplay fallback should hide defeated target when action names one');
assert.ok(fallbackEmitted.files.flow.indexOf('RecordPhaseEvidenceFlag("occupyEnemyBaseCTA", "target_removed_or_hidden")') >= 0, 'autoplay fallback should record target removal evidence');
assert.ok(fallbackEmitted.files.flow.indexOf('RecordPhaseEvidenceFlag("occupyEnemyBaseCTA", "loot_visible")') >= 0, 'autoplay fallback should record death drop evidence for observe_defeat');

console.log('assembly-emitter tests passed');
