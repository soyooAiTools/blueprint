var assert = require('assert');
var fs = require('fs');

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
assert.ok(emitted.files.flow.indexOf('GFM_CameraController.Instance.SetOrthographicSize') >= 0 || emitted.files.scene.indexOf('GFM_CameraController.Instance.SetOrthographicSize') >= 0, 'camera zoom slot should emit smooth controller zoom');
assert.ok(emitted.files.flow.indexOf('mainCam.orthographicSize = ') < 0 && emitted.files.scene.indexOf('mainCam.orthographicSize = ') < 0, 'camera zoom slot must not directly assign ortho size');
assert.ok(emitted.files.input.indexOf('Vector3.MoveTowards(__assemblyBefore, __joystickTarget.transform.position') >= 0, 'player movement should be owned by joystick/autoplay input path');
assert.ok(emitted.files.flow.indexOf('move_to_target records arrival evidence only') >= 0, 'player move_to_target slot should not drive Player transform directly');
assert.ok(emitted.files.flow.indexOf('Player.transform.position = __assemblyNext') < 0, 'player move_to_target slot must not write Player.transform');
assert.ok(emitted.files.flow.indexOf('__assemblyPlayer.transform.position = __assemblyPlayerBefore') < 0, 'missing-actor move_to_target fallback must not move Player');
assert.ok(emitted.files.flow.indexOf('RecordPhaseEvidenceFlag(currentPhaseName, "player_position_changed")') >= 0, 'move_to_target should record player motion evidence');
assert.ok(emitted.files.flow.indexOf('RecordPhaseEvidenceFlag(currentPhaseName, "entity_state_equals_built")') >= 0, 'build_progress should record built evidence');
assert.ok(emitted.files.flow.indexOf('RecordPhaseEvidenceObject(currentPhaseName, "build_progress"') >= 0, 'build_progress should emit structured phase evidence snapshot');
assert.ok(emitted.files.input.indexOf('RecordPhaseEvidenceFlag(currentPhaseName, "tap_registered")') >= 0, 'tap/click slot should record tap evidence');
assert.ok(emitted.files.resource.indexOf('string __costGateResource = GFM_ResourceIds.Gold;') >= 0, 'cost_gate should bind configured resource through owner API');
assert.ok(emitted.files.resource.indexOf('TrySpend(__costGateResource, 1)') >= 0, 'cost_gate should spend configured resource through owner API');
assert.ok(emitted.files.resource.indexOf('RecordPhaseEvidenceFlag(currentPhaseName, "resource_decremented")') >= 0, 'cost_gate should record resource decrement evidence');
assert.ok(emitted.files.resource.indexOf('RecordPhaseEvidenceObject(currentPhaseName, "cost_gate"') >= 0, 'cost_gate should emit structured phase evidence snapshot');
var legacyUpgradeCostPlans = JSON.parse(JSON.stringify(plans));
legacyUpgradeCostPlans.assemblyPlan.moduleInstances.forEach(function(module) {
  if (module.id === 'ConveyorBelt::cost_gate') {
    module.params.resource = 'resource';
    module.sources = ['template:Upgradeable', 'atom:upgrade_entity'];
  }
});
var legacyUpgradeCostEmitted = assemblyEmitter.applyAssemblyPlanToSkeleton(skeleton, legacyUpgradeCostPlans);
assert.ok(legacyUpgradeCostEmitted.files.resource.indexOf('string __costGateResource = GFM_ResourceIds.Gold;') >= 0, 'legacy build/upgrade cost_gate placeholder resource should fall back to Gold');
var legacySpendCostPlans = JSON.parse(JSON.stringify(plans));
legacySpendCostPlans.assemblyPlan.moduleInstances.forEach(function(module) {
  if (module.id === 'ConveyorBelt::cost_gate') {
    module.params.resource = 'resource';
    module.sources = ['atom:spend_resource'];
  }
});
var legacySpendCostEmitted = assemblyEmitter.applyAssemblyPlanToSkeleton(skeleton, legacySpendCostPlans);
assert.ok(legacySpendCostEmitted.files.resource.indexOf('string __costGateResource = GFM_ResourceIds.Normalize("resource");') >= 0, 'generic spend_resource cost_gate should preserve generic resource id');
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
    '        if (ConveyorBeltState < 2) ConveyorBeltState = 2;',
    '        if (ConveyorBeltState < 2) ConveyorBeltState = 2;\n        PlaceObj(ConveyorBelt, 1f, 2f, 3f);'
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
      },
      {
        id: 'Recycler::collect_on_near',
        moduleId: 'collect_on_near',
        entity: 'Recycler',
        params: { resource: 'debris', item: 'debris', count: 1, range: 1.5 },
        ownerFiles: ['GameFlowManagerMain.Resource.cs'],
        statesWritten: ['Recycler.collectState'],
        sources: ['test'],
        sourceAtomIds: ['atom_002']
      }
    ],
    fileOwners: [
      { file: 'GameFlowManagerMain.Resource.cs', moduleInstanceIds: ['Recycler::deliver_to_target', 'Recycler::collect_on_near'] }
    ],
    phaseBindings: [],
    stateOwners: [],
    eventGraph: [],
    unresolved: []
  },
  cuaPlan: { steps: [] }
};
var genericEmitted = assemblyEmitter.applyAssemblyPlanToSkeleton(genericSkeleton, genericPlans);
assert.ok(genericEmitted.files.resource.indexOf('string __deliverRewardResource = GFM_ResourceIds.Normalize("energy");') >= 0, 'deliver slot should bind parameterized reward resource');
assert.ok(genericEmitted.files.resource.indexOf('AddResource(__deliverRewardResource, 2 * deliverCount);') >= 0, 'deliver slot should grant parameterized reward resource');
assert.ok(genericEmitted.files.resource.indexOf('AddGold(2 * deliverCount);') === -1, 'non-gold deliver reward should not hardcode AddGold');
assert.ok(genericEmitted.files.resource.indexOf('RecordPhaseEvidenceFlag(currentPhaseName, "inventory_decremented")') >= 0, 'deliver slot should record inventory evidence');
assert.ok(genericEmitted.files.resource.indexOf('RecordPhaseEvidenceFlag(currentPhaseName, "reward_incremented")') >= 0, 'deliver slot should record reward evidence');
assert.ok(genericEmitted.files.resource.indexOf('RecordPhaseEvidenceObject(currentPhaseName, "deliver_to_target"') >= 0, 'deliver slot should emit structured phase evidence snapshot');
assert.ok(genericEmitted.files.resource.indexOf('" energy"') >= 0, 'floating text should use parameterized reward label');
assert.ok(genericEmitted.files.resource.indexOf('RecyclerState =') === -1, 'resource collect/deliver slots must not mutate generic entity state owned by flow modules');

var popPlans = {
  entityPlan: {
    entities: [
      { name: 'CTAButton' }
    ]
  },
  assemblyPlan: {
    moduleInstances: [
      {
        id: 'CTAButton::pop_animation',
        moduleId: 'pop_animation',
        entity: 'CTAButton',
        params: { target: 'CTAButton', intensity: 0.2 },
        ownerFiles: ['GameFlowManagerMain.Flow.cs'],
        statesWritten: ['CTAButton.animationState'],
        sourceAtomIds: ['atom_pop']
      }
    ],
    fileOwners: [
      { file: 'GameFlowManagerMain.Flow.cs', moduleInstanceIds: ['CTAButton::pop_animation'] }
    ],
    phaseBindings: [
      { phaseId: 'cta', activateEntities: ['CTAButton'], atomIds: ['atom_pop'] }
    ],
    stateOwners: [],
    eventGraph: [],
    unresolved: []
  },
  cuaPlan: { steps: [] }
};
var popEmitted = assemblyEmitter.applyAssemblyPlanToSkeleton(genericSkeleton, popPlans);
assert.ok(popEmitted.files.flow.indexOf('AssemblySlot_Flow_CTAButton__pop_animation') >= 0, 'pop_animation slot should be emitted');
assert.ok(popEmitted.files.flow.indexOf('SetScale(CTAButton, __assemblyPopScale, __assemblyPopScale, __assemblyPopScale);') >= 0, 'pop_animation should use deterministic scale pulse');
assert.ok(popEmitted.files.flow.indexOf('RecordPhaseEvidenceFlag(currentPhaseName, "visual_variant_changed")') >= 0, 'pop_animation should record visual evidence');
assert.ok(popEmitted.files.flow.indexOf('RecordPhaseEvidenceFlag(currentPhaseName, "entity_position_changed")') === -1, 'pop_animation should not record position evidence without moving');

var formSwitchPlans = {
  assemblyPlan: {
    moduleInstances: [
      {
        id: 'Player::form_switch',
        moduleId: 'form_switch',
        entity: 'Player',
        params: { formId: 'form_water' },
        ownerFiles: ['GameFlowManagerMain.Flow.cs'],
        sourceAtomIds: ['atom_form']
      }
    ],
    fileOwners: [
      { file: 'GameFlowManagerMain.Flow.cs', moduleInstanceIds: ['Player::form_switch'] }
    ],
    phaseBindings: [
      { phaseId: 'form', atomIds: ['atom_form'], activateEntities: ['Player'] }
    ],
    stateOwners: [],
    eventGraph: [],
    unresolved: []
  },
  cuaPlan: { steps: [] }
};
var formSwitchEmitted = assemblyEmitter.applyAssemblyPlanToSkeleton(genericSkeleton, formSwitchPlans);
assert.ok(formSwitchEmitted.files.flow.indexOf('GFM_Player.Instance.SwitchForm(__formSwitchTargetIndex);') >= 0, 'form_switch should resolve and switch to a target form');
assert.ok(formSwitchEmitted.files.flow.indexOf('RecordPhaseEvidenceObject(currentPhaseName, "form_switch"') >= 0, 'form_switch should emit structured phase evidence snapshot');

var registry = JSON.parse(fs.readFileSync(__dirname + '/../adapters/schema/assembly-registry-v1/runtime-modules.v1.json', 'utf-8'));
var registryItems = registry.items || [];
var registryModuleIds = registryItems.map(function(item) { return item.id; });
var registryOwnerMap = {};
registryItems.forEach(function(item) {
  (item.ownerFiles || ['GameFlowManagerMain.Flow.cs']).forEach(function(file) {
    registryOwnerMap[file] = registryOwnerMap[file] || [];
    registryOwnerMap[file].push('RegistryTarget::' + item.id);
  });
});
var registryPlans = {
  entityPlan: {
    entities: [
      { name: 'RegistryTarget' }
    ]
  },
  assemblyPlan: {
    moduleInstances: registryItems.map(function(item) {
      return {
        id: 'RegistryTarget::' + item.id,
        moduleId: item.id,
        entity: 'RegistryTarget',
        params: { target: 'RegistryTarget', targets: ['RegistryTarget'], resource: 'gold', amount: 1, value: 1, intensity: 0.1 },
        ownerFiles: item.ownerFiles || ['GameFlowManagerMain.Flow.cs'],
        sourceAtomIds: ['atom_registry']
      };
    }),
    fileOwners: Object.keys(registryOwnerMap).map(function(file) {
      return { file: file, moduleInstanceIds: registryOwnerMap[file] };
    }),
    phaseBindings: [
      { phaseId: 'registry', activateEntities: ['RegistryTarget'], atomIds: ['atom_registry'] }
    ],
    stateOwners: [],
    eventGraph: [],
    unresolved: []
  },
  cuaPlan: { steps: [] }
};
var registryCoverage = assemblyEmitter.computeImplementationCoverage(registryPlans);
assert.deepStrictEqual(registryCoverage.missingModuleIds, [], 'every runtime registry module should have deterministic emitter coverage');

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

var narrativeMoveSkeleton = {
  mode: 'w1b-5partial',
  main: fallbackSkeleton.main,
  flow: [
    'public partial class GameFlowManagerMain',
    '{',
    '    void Phase_enemyAttackWarning_OnAutoPlayArrive(string targetName)',
    '    {',
    '        // TODO_PHASE_enemyAttackWarning_ONAUTOARRIVE_START',
    '        // TODO: narrative intro has no generated fallback body.',
    '        // TODO_PHASE_enemyAttackWarning_ONAUTOARRIVE_END',
    '    }',
    '}',
    ''
  ].join('\n'),
  input: genericSkeleton.input,
  resource: genericSkeleton.resource,
  ui: genericSkeleton.ui,
  scene: genericSkeleton.scene
};
var narrativeMovePlans = {
  assemblyPlan: {
    moduleInstances: [],
    fileOwners: [],
    phaseBindings: [
      {
        phaseId: 'enemyAttackWarning',
        completionSignals: ['guide_text_visible', 'player_position_changed']
      }
    ],
    stateOwners: [],
    eventGraph: [],
    unresolved: []
  },
  cuaPlan: {
    steps: [
      {
        phaseId: 'enemyAttackWarning',
        actions: [{ kind: 'move_to', actor: 'Player', target: 'narrative intro target text' }],
        expectedSignals: ['player_position_changed']
      }
    ]
  }
};
var narrativeMoveEmitted = assemblyEmitter.applyAssemblyPlanToSkeleton(narrativeMoveSkeleton, narrativeMovePlans);
assert.ok(narrativeMoveEmitted.files.flow.indexOf('RecordPhaseEvidenceFlag("enemyAttackWarning", "player_position_changed")') >= 0, 'autoplay fallback should record narrative move_to player motion even without a guide-text anchor');

var implementationPlans = {
  entityPlan: {
    entities: [
      { name: 'Player' },
      { name: 'EnemyBase' },
      { name: 'RocketDebris' },
      { name: 'Gold' },
      { name: 'DefenseTower' },
      { name: 'CTAButton' }
    ]
  },
  assemblyPlan: {
    moduleInstances: [
      {
        id: 'Player::player_input_joystick',
        moduleId: 'player_input_joystick',
        entity: 'Player',
        params: { target: 'EnemyBase', speed: 4 },
        ownerFiles: ['GameFlowManagerMain.Input.cs'],
        sourceAtomIds: ['atom_move']
      },
      {
        id: 'system::move_to_target',
        moduleId: 'move_to_target',
        entity: '',
        params: { target: 'narrative target', speed: 5 },
        ownerFiles: ['GameFlowManagerMain.Flow.cs'],
        sourceAtomIds: ['atom_move']
      },
      {
        id: 'system::apply_damage',
        moduleId: 'apply_damage',
        entity: '',
        params: { source: 'Player', amount: 1 },
        ownerFiles: ['GameFlowManagerMain.Flow.cs'],
        sourceAtomIds: ['atom_attack']
      },
      {
        id: 'system::projectile_emit',
        moduleId: 'projectile_emit',
        entity: '',
        params: { damage: 1 },
        ownerFiles: ['GameFlowManagerMain.Flow.cs'],
        sourceAtomIds: ['atom_attack']
      },
      {
        id: 'system::target_acquire',
        moduleId: 'target_acquire',
        entity: '',
        params: { targetTag: 'enemy' },
        ownerFiles: ['GameFlowManagerMain.Flow.cs'],
        sourceAtomIds: ['atom_attack']
      },
      {
        id: 'DefenseTower::activate_targets',
        moduleId: 'activate_targets',
        entity: 'DefenseTower',
        params: { targets: [] },
        ownerFiles: ['GameFlowManagerMain.Flow.cs'],
        sourceAtomIds: ['atom_build']
      },
      {
        id: 'system::collect_on_near',
        moduleId: 'collect_on_near',
        entity: '',
        params: { resource: 'gold', count: 1 },
        ownerFiles: ['GameFlowManagerMain.Resource.cs'],
        sourceAtomIds: ['atom_collect']
      },
      {
        id: 'system::inventory_wallet',
        moduleId: 'inventory_wallet',
        entity: '',
        params: { resourceKinds: ['gold'] },
        ownerFiles: ['GameFlowManagerMain.Resource.cs'],
        sourceAtomIds: ['atom_collect']
      },
      {
        id: 'system::score_feedback',
        moduleId: 'score_feedback',
        entity: '',
        params: { resource: 'gold', label: 'Gold' },
        ownerFiles: ['GameFlowManagerMain.UI.cs'],
        sourceAtomIds: ['atom_collect']
      },
      {
        id: 'CTAButton::guide_ui',
        moduleId: 'guide_ui',
        entity: 'CTAButton',
        params: {},
        ownerFiles: ['GameFlowManagerMain.UI.cs'],
        sourceAtomIds: ['atom_cta']
      },
      {
        id: 'system::cta_finish',
        moduleId: 'cta_finish',
        entity: '',
        params: { target: 'CTAButton' },
        ownerFiles: ['GameFlowManagerMain.UI.cs'],
        sourceAtomIds: ['atom_cta']
      },
      {
        id: 'system::visual_variant_swap',
        moduleId: 'visual_variant_swap',
        entity: '',
        params: { entity: 'narrative entity', variantId: 'red' },
        ownerFiles: ['GameFlowManagerMain.Scene.cs'],
        sourceAtomIds: ['atom_visual']
      }
    ],
    fileOwners: [
      {
        file: 'GameFlowManagerMain.Flow.cs',
        moduleInstanceIds: [
          'system::move_to_target',
          'system::apply_damage',
          'system::projectile_emit',
          'system::target_acquire',
          'DefenseTower::activate_targets'
        ]
      },
      { file: 'GameFlowManagerMain.Input.cs', moduleInstanceIds: ['Player::player_input_joystick'] },
      { file: 'GameFlowManagerMain.Resource.cs', moduleInstanceIds: ['system::collect_on_near', 'system::inventory_wallet'] },
      { file: 'GameFlowManagerMain.UI.cs', moduleInstanceIds: ['system::score_feedback', 'CTAButton::guide_ui', 'system::cta_finish'] },
      { file: 'GameFlowManagerMain.Scene.cs', moduleInstanceIds: ['system::visual_variant_swap'] }
    ],
    phaseBindings: [
      {
        phaseId: 'combat',
        atomIds: ['atom_move', 'atom_attack', 'atom_build', 'atom_collect', 'atom_visual'],
        activateEntities: ['Player', 'EnemyBase', 'RocketDebris', 'Gold', 'DefenseTower'],
        guide: '战斗'
      },
      {
        phaseId: 'finish',
        atomIds: ['atom_cta'],
        activateEntities: ['CTAButton'],
        guide: '安装'
      }
    ],
    stateOwners: [],
    eventGraph: [],
    unresolved: []
  },
  cuaPlan: {
    steps: [
      {
        phaseId: 'combat',
        actions: [
          { kind: 'move_to', target: 'EnemyBase' },
          { kind: 'attack', target: 'EnemyBase' },
          { kind: 'collect', target: 'Gold' }
        ],
        expectedSignals: ['player_position_changed', 'target_hp_decreased_or_target_dead', 'resource_incremented']
      },
      {
        phaseId: 'finish',
        actions: [{ kind: 'click', target: 'CTAButton' }],
        expectedSignals: ['downstream_entity_visible']
      }
    ]
  }
};
var implementationCoverage = assemblyEmitter.computeImplementationCoverage(implementationPlans);
assert.strictEqual(implementationCoverage.coverage, 1, 'all deterministic fallback modules should be covered');
assert.deepStrictEqual(implementationCoverage.missing, [], 'deterministic fallback coverage should not leave missing slots');

var implementationEmitted = assemblyEmitter.applyAssemblyPlanToSkeleton(genericSkeleton, implementationPlans);
assert.ok(implementationEmitted.files.input.indexOf('RecordPhaseEvidenceFlag(currentPhaseName, "player_position_changed")') >= 0, 'joystick slot should record player movement evidence');
assert.ok(implementationEmitted.files.flow.indexOf('HideObj(EnemyBase);') >= 0, 'system damage fallback should hide a concrete enemy target');
assert.ok(implementationEmitted.files.flow.indexOf('RecordPhaseEvidenceFlag(currentPhaseName, "projectile_visible")') >= 0, 'system projectile fallback should record projectile evidence');
assert.ok(implementationEmitted.files.flow.indexOf('DefenseTowerState = Mathf.Max(DefenseTowerState, 1);') >= 0, 'activate_targets fallback should activate its owner when targets are empty');
assert.ok(implementationEmitted.files.flow.indexOf('RecordPhaseEvidenceObject(currentPhaseName, "activate_targets"') >= 0, 'activate_targets should emit structured phase evidence snapshot');
assert.ok(implementationEmitted.files.input.indexOf('RecordPhaseEvidenceObject(currentPhaseName, "player_input_joystick"') >= 0, 'player_input_joystick should emit structured phase evidence snapshot');
assert.ok(implementationEmitted.files.resource.indexOf('string __collectResource = GFM_ResourceIds.Gold;') >= 0, 'system collect fallback should bind the configured resource');
assert.ok(implementationEmitted.files.resource.indexOf('AddResource(__collectResource, 1);') >= 0, 'system collect fallback should add the configured resource');
assert.ok(implementationEmitted.files.resource.indexOf('RecordPhaseEvidenceObject(currentPhaseName, "collect_on_near"') >= 0, 'collect_on_near should emit structured phase evidence snapshot');
assert.ok(implementationEmitted.files.resource.indexOf('string __inventoryWalletResource = GFM_ResourceIds.Gold;') >= 0, 'inventory_wallet should observe configured resource kinds');
assert.ok(implementationEmitted.files.resource.indexOf('RecordPhaseEvidenceObject(currentPhaseName, "inventory_wallet"') >= 0, 'inventory_wallet should emit structured phase evidence snapshot');
assert.ok(implementationEmitted.files.ui.indexOf('RecordPhaseEvidenceObject(currentPhaseName, "score_feedback"') >= 0, 'score_feedback should emit structured phase evidence snapshot');
assert.ok(implementationEmitted.files.ui.indexOf('ShowCTA();') >= 0, 'cta_finish should deterministically show CTA');
assert.ok(implementationEmitted.files.ui.indexOf('RecordPhaseEvidenceObject(currentPhaseName, "cta_finish"') >= 0, 'cta_finish should emit structured phase evidence snapshot');
assert.ok(implementationEmitted.files.ui.indexOf('RecordPhaseEvidenceFlag(currentPhaseName, "guide_text_visible")') >= 0, 'CTA guide_ui should still emit guide evidence');
assert.ok(implementationEmitted.files.scene.indexOf('RecordPhaseEvidenceFlag(currentPhaseName, "visual_variant_changed")') >= 0, 'system visual variant fallback should record visual evidence');

var genericFallbackPlans = {
  entityPlan: {
    entities: [
      { name: 'Player' },
      { name: 'SpawnerMachine' },
      { name: 'UpgradeStation' },
      { name: 'EnemyTarget' }
    ]
  },
  assemblyPlan: {
    moduleInstances: [
      {
        id: 'SpawnerMachine::spawn_interval',
        moduleId: 'spawn_interval',
        entity: 'SpawnerMachine',
        params: { entity: 'MissingSpawnedEntity', interval: 1, maxAlive: 1 },
        ownerFiles: ['GameFlowManagerMain.Flow.cs']
      },
      {
        id: 'system::damageable',
        moduleId: 'damageable',
        entity: '',
        params: {},
        ownerFiles: ['GameFlowManagerMain.Flow.cs']
      },
      {
        id: 'system::upgrade_progress',
        moduleId: 'upgrade_progress',
        entity: '',
        params: {},
        ownerFiles: ['GameFlowManagerMain.Flow.cs']
      }
    ],
    fileOwners: [
      {
        file: 'GameFlowManagerMain.Flow.cs',
        moduleInstanceIds: ['SpawnerMachine::spawn_interval', 'system::damageable', 'system::upgrade_progress']
      }
    ],
    phaseBindings: [
      {
        phaseId: 'fallback',
        atomIds: [],
        activateEntities: ['SpawnerMachine', 'UpgradeStation', 'EnemyTarget']
      }
    ],
    stateOwners: [],
    eventGraph: [],
    unresolved: []
  },
  cuaPlan: { steps: [] }
};
var genericFallbackCoverage = assemblyEmitter.computeImplementationCoverage(genericFallbackPlans);
assert.strictEqual(genericFallbackCoverage.coverage, 1, 'generic/system assembly modules should still have deterministic fallback coverage');
assert.deepStrictEqual(genericFallbackCoverage.missing, [], 'generic/system fallback modules must not be reported missing');
var genericFallbackEmitted = assemblyEmitter.applyAssemblyPlanToSkeleton(genericSkeleton, genericFallbackPlans);
assert.ok(genericFallbackEmitted.files.flow.indexOf('PlaceObj(SpawnerMachine') >= 0, 'spawn_interval should use owner entity as visible proxy when spawned entity is not declared');
assert.ok(genericFallbackEmitted.files.flow.indexOf('RecordPhaseEvidenceObject(currentPhaseName, "spawn_interval"') >= 0, 'spawn_interval should emit structured phase evidence snapshot');
assert.ok(genericFallbackEmitted.files.flow.indexOf('RecordPhaseEvidenceFlag(currentPhaseName, "target_hp_decreased_or_target_dead")') >= 0, 'system damageable should emit combat evidence instead of an empty slot');
assert.ok(genericFallbackEmitted.files.flow.indexOf('RecordPhaseEvidenceFlag(currentPhaseName, "upgrade_level_changed")') >= 0, 'system upgrade_progress should emit upgrade evidence instead of an empty slot');
assert.ok(genericFallbackEmitted.files.flow.indexOf('RecordPhaseEvidenceObject(currentPhaseName, "upgrade_progress"') >= 0, 'upgrade_progress should emit structured phase evidence snapshot');

var b2b3Plans = {
  entityPlan: {
    entities: [
      { name: 'Player' },
      { name: 'SpawnPod' },
      { name: 'EnemyGrunt' }
    ]
  },
  assemblyPlan: {
    moduleInstances: [
      {
        id: 'SpawnPod::spawn_once',
        moduleId: 'spawn_once',
        entity: 'SpawnPod',
        params: { entity: 'EnemyGrunt' },
        ownerFiles: ['GameFlowManagerMain.Flow.cs'],
        sourceAtomIds: ['atom_spawn_once']
      },
      {
        id: 'system::phase_gate_timer',
        moduleId: 'phase_gate_timer',
        entity: '',
        params: { seconds: 0.5 },
        ownerFiles: ['GameFlowManagerMain.Flow.cs'],
        sourceAtomIds: ['atom_timer']
      },
      {
        id: 'system::player_input_tap',
        moduleId: 'player_input_tap',
        entity: '',
        params: { raycastLayer: 'Default' },
        ownerFiles: ['GameFlowManagerMain.Input.cs'],
        sourceAtomIds: ['atom_tap']
      }
    ],
    fileOwners: [
      { file: 'GameFlowManagerMain.Flow.cs', moduleInstanceIds: ['SpawnPod::spawn_once', 'system::phase_gate_timer'] },
      { file: 'GameFlowManagerMain.Input.cs', moduleInstanceIds: ['system::player_input_tap'] }
    ],
    phaseBindings: [
      { phaseId: 'spawn', atomIds: ['atom_spawn_once'], activateEntities: ['SpawnPod', 'EnemyGrunt'] },
      { phaseId: 'timerTap', atomIds: ['atom_timer', 'atom_tap'], activateEntities: ['Player'] }
    ],
    stateOwners: [],
    eventGraph: [],
    unresolved: []
  },
  cuaPlan: { steps: [] }
};
var b2b3Coverage = assemblyEmitter.computeImplementationCoverage(b2b3Plans);
assert.strictEqual(b2b3Coverage.coverage, 1, 'B2/B3 phaseEvidence modules should be deterministic-covered');
assert.deepStrictEqual(b2b3Coverage.missing, [], 'B2/B3 phaseEvidence modules should not be missing');
var b2b3Emitted = assemblyEmitter.applyAssemblyPlanToSkeleton(genericSkeleton, b2b3Plans);
assert.ok(b2b3Emitted.files.flow.indexOf('RecordPhaseEvidenceObject(currentPhaseName, "spawn_once"') >= 0, 'spawn_once should emit structured phase evidence snapshot');
assert.ok(b2b3Emitted.files.flow.indexOf('\\"phase_advanced_by_timer\\"') >= 0, 'phase_gate_timer snapshot should include timer boundary ownership');
assert.ok(b2b3Emitted.files.flow.indexOf('RecordPhaseEvidenceObject(currentPhaseName, "phase_gate_timer"') >= 0, 'phase_gate_timer should emit structured phase evidence snapshot');
assert.ok(b2b3Emitted.files.input.indexOf('RecordPhaseEvidenceObject(currentPhaseName, "player_input_tap"') >= 0, 'player_input_tap should emit structured phase evidence snapshot');
assert.ok(b2b3Emitted.files.input.indexOf('\\"tap_position\\"') >= 0, 'player_input_tap should include optional tap_position for present_full coverage');

var cTierPlans = {
  entityPlan: {
    entities: [
      { name: 'Player' },
      { name: 'EnemyBoss' },
      { name: 'CoinPickup' },
      { name: 'GuideTarget' },
      { name: 'CTAButton' },
      { name: 'Turret' },
      { name: 'ArrowProjectile' },
      { name: 'Ingredient' },
      { name: 'Pot' },
      { name: 'CooldownTower' }
    ]
  },
  assemblyPlan: {
    moduleInstances: [
      { id: 'EnemyBoss::visual_binding', moduleId: 'visual_binding', entity: 'EnemyBoss', params: { position: '(1,0.5,1)', scale: '1.1,1.1,1.1' }, ownerFiles: ['GameFlowManagerMain.Scene.cs'], sourceAtomIds: ['atom_c1'] },
      { id: 'EnemyBoss::visual_variant_swap', moduleId: 'visual_variant_swap', entity: 'EnemyBoss', params: { variantId: 'phase2' }, ownerFiles: ['GameFlowManagerMain.Scene.cs'], sourceAtomIds: ['atom_c1'] },
      { id: 'CoinPickup::floating_text_feedback', moduleId: 'floating_text_feedback', entity: 'CoinPickup', params: { target: 'CoinPickup', text: '+10' }, ownerFiles: ['GameFlowManagerMain.UI.cs'], sourceAtomIds: ['atom_c1'] },
      { id: 'GuideTarget::world_label', moduleId: 'world_label', entity: 'GuideTarget', params: { target: 'GuideTarget', text: '目标' }, ownerFiles: ['GameFlowManagerMain.UI.cs'], sourceAtomIds: ['atom_c1'] },
      { id: 'CoinPickup::pop_animation', moduleId: 'pop_animation', entity: 'CoinPickup', params: { intensity: 0.2 }, ownerFiles: ['GameFlowManagerMain.Flow.cs'], sourceAtomIds: ['atom_c1'] },
      { id: 'GuideTarget::highlight_target', moduleId: 'highlight_target', entity: 'GuideTarget', params: { target: 'GuideTarget' }, ownerFiles: ['GameFlowManagerMain.UI.cs'], sourceAtomIds: ['atom_c1'] },
      { id: 'system::guide_ui', moduleId: 'guide_ui', entity: '', params: {}, ownerFiles: ['GameFlowManagerMain.UI.cs'], sourceAtomIds: ['atom_c1'] },
      { id: 'system::camera_focus', moduleId: 'camera_focus', entity: '', params: { target: 'EnemyBoss' }, ownerFiles: ['GameFlowManagerMain.Scene.cs'], sourceAtomIds: ['atom_c2'] },
      { id: 'system::camera_lift', moduleId: 'camera_lift', entity: '', params: { amount: 2 }, ownerFiles: ['GameFlowManagerMain.Scene.cs'], sourceAtomIds: ['atom_c2'] },
      { id: 'system::camera_zoom', moduleId: 'camera_zoom', entity: '', params: { value: 1.3 }, ownerFiles: ['GameFlowManagerMain.Scene.cs'], sourceAtomIds: ['atom_c2'] },
      { id: 'EnemyBoss::damageable', moduleId: 'damageable', entity: 'EnemyBoss', params: { target: 'EnemyBoss' }, ownerFiles: ['GameFlowManagerMain.Flow.cs'], sourceAtomIds: ['atom_c3'] },
      { id: 'EnemyBoss::apply_damage', moduleId: 'apply_damage', entity: 'EnemyBoss', params: { source: 'Turret', target: 'EnemyBoss', amount: 3 }, ownerFiles: ['GameFlowManagerMain.Flow.cs'], sourceAtomIds: ['atom_c3'] },
      { id: 'EnemyBoss::on_death_drop', moduleId: 'on_death_drop', entity: 'EnemyBoss', params: { loot: 'CoinPickup' }, ownerFiles: ['GameFlowManagerMain.Flow.cs'], sourceAtomIds: ['atom_c3'] },
      { id: 'Turret::target_acquire', moduleId: 'target_acquire', entity: 'Turret', params: { target: 'EnemyBoss' }, ownerFiles: ['GameFlowManagerMain.Flow.cs'], sourceAtomIds: ['atom_c3'] },
      { id: 'Turret::projectile_emit', moduleId: 'projectile_emit', entity: 'Turret', params: { projectile: 'ArrowProjectile', velocity: 12 }, ownerFiles: ['GameFlowManagerMain.Flow.cs'], sourceAtomIds: ['atom_c3'] },
      { id: 'Ingredient::drag_trigger', moduleId: 'drag_trigger', entity: 'Ingredient', params: { source: 'Ingredient', target: 'Pot' }, ownerFiles: ['GameFlowManagerMain.Input.cs'], sourceAtomIds: ['atom_c4'] },
      { id: 'CTAButton::hold_trigger', moduleId: 'hold_trigger', entity: 'CTAButton', params: { target: 'CTAButton', duration: 1.2 }, ownerFiles: ['GameFlowManagerMain.Input.cs'], sourceAtomIds: ['atom_c4'] },
      { id: 'Player::move_to_target', moduleId: 'move_to_target', entity: 'Player', params: { target: 'GuideTarget', speed: 4 }, ownerFiles: ['GameFlowManagerMain.Flow.cs'], sourceAtomIds: ['atom_c4'] },
      { id: 'CooldownTower::cooldown', moduleId: 'cooldown', entity: 'CooldownTower', params: { seconds: 1 }, ownerFiles: ['GameFlowManagerMain.Flow.cs'], sourceAtomIds: ['atom_c4'] },
      { id: 'CTAButton::click_trigger', moduleId: 'click_trigger', entity: 'CTAButton', params: { target: 'CTAButton' }, ownerFiles: ['GameFlowManagerMain.Input.cs'], sourceAtomIds: ['atom_c4'] }
    ],
    fileOwners: [
      { file: 'GameFlowManagerMain.Scene.cs', moduleInstanceIds: ['EnemyBoss::visual_binding', 'EnemyBoss::visual_variant_swap', 'system::camera_focus', 'system::camera_lift', 'system::camera_zoom'] },
      { file: 'GameFlowManagerMain.UI.cs', moduleInstanceIds: ['CoinPickup::floating_text_feedback', 'GuideTarget::world_label', 'GuideTarget::highlight_target', 'system::guide_ui'] },
      { file: 'GameFlowManagerMain.Flow.cs', moduleInstanceIds: ['CoinPickup::pop_animation', 'EnemyBoss::damageable', 'EnemyBoss::apply_damage', 'EnemyBoss::on_death_drop', 'Turret::target_acquire', 'Turret::projectile_emit', 'Player::move_to_target', 'CooldownTower::cooldown'] },
      { file: 'GameFlowManagerMain.Input.cs', moduleInstanceIds: ['Ingredient::drag_trigger', 'CTAButton::hold_trigger', 'CTAButton::click_trigger'] }
    ],
    phaseBindings: [
      { phaseId: 'visual', atomIds: ['atom_c1'], activateEntities: ['EnemyBoss', 'CoinPickup', 'GuideTarget'], guide: '看这里' },
      { phaseId: 'camera', atomIds: ['atom_c2'], activateEntities: ['EnemyBoss'], camera: { lookAt: 'EnemyBoss', zoom: 1.3, height: 2 } },
      { phaseId: 'combat', atomIds: ['atom_c3'], activateEntities: ['EnemyBoss', 'Turret', 'ArrowProjectile', 'CoinPickup'] },
      { phaseId: 'control', atomIds: ['atom_c4'], activateEntities: ['Player', 'Ingredient', 'Pot', 'CTAButton', 'CooldownTower', 'GuideTarget'] }
    ],
    stateOwners: [],
    eventGraph: [],
    unresolved: []
  },
  cuaPlan: { steps: [] }
};
var cTierCoverage = assemblyEmitter.computeImplementationCoverage(cTierPlans);
assert.strictEqual(cTierCoverage.coverage, 1, 'C-tier phaseEvidence modules should be deterministic-covered');
assert.deepStrictEqual(cTierCoverage.missing, [], 'C-tier phaseEvidence modules should not be missing');
var cTierEmitted = assemblyEmitter.applyAssemblyPlanToSkeleton(genericSkeleton, cTierPlans);
[
  ['scene', 'visual_binding'],
  ['scene', 'visual_variant_swap'],
  ['ui', 'floating_text_feedback'],
  ['ui', 'world_label'],
  ['flow', 'pop_animation'],
  ['ui', 'highlight_target'],
  ['ui', 'guide_ui'],
  ['scene', 'camera_focus'],
  ['scene', 'camera_lift'],
  ['scene', 'camera_zoom'],
  ['flow', 'damageable'],
  ['flow', 'apply_damage'],
  ['flow', 'on_death_drop'],
  ['flow', 'target_acquire'],
  ['flow', 'projectile_emit'],
  ['input', 'drag_trigger'],
  ['input', 'hold_trigger'],
  ['flow', 'move_to_target'],
  ['flow', 'cooldown'],
  ['input', 'click_trigger']
].forEach(function(pair) {
  assert.ok(cTierEmitted.files[pair[0]].indexOf('RecordPhaseEvidenceObject(currentPhaseName, "' + pair[1] + '"') >= 0, pair[1] + ' should emit structured phase evidence snapshot');
});
assert.ok(cTierEmitted.files.scene.indexOf('\\"framing.look_at\\"') >= 0, 'camera_focus should use literal dotted framing.look_at key expected by evaluator');
assert.ok(cTierEmitted.files.input.indexOf('RecordPhaseEvidenceFlag(currentPhaseName, "drag_path_completed")') >= 0, 'drag_trigger should emit declared drag_path_completed flag');
assert.ok(cTierEmitted.files.ui.indexOf('RecordPhaseEvidenceFlag(currentPhaseName, "highlight_overlay_visible")') >= 0, 'highlight_target should emit overlay flag');

console.log('assembly-emitter tests passed');
