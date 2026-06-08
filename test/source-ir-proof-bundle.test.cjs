#!/usr/bin/env node
'use strict';

var assert = require('assert');
var {
  buildProofBundle,
  moduleProofContract,
} = require('../adapters/source-ir/proof-bundle.cjs');
var {
  buildBlueprintProject,
} = require('../adapters/source-ir/blueprint-project.js');

function baseFixture() {
  return {
    gameSchema: {
      phases: [
        {
          phaseId: 'phase1',
          guideText: 'Collect ice',
          showEntities: ['Player', 'IceSpawner', 'IceChunk'],
          trigger: { type: 'resource_collected', resource: 'Ice', amount: 5 },
        },
        {
          phaseId: 'phase2',
          guideText: 'Build turret',
          showEntities: ['TurretUnlock', 'Turret'],
          trigger: { type: 'entity_state_reached', entity: 'Turret', state: 2 },
        },
      ],
    },
    assetManifest: {
      source: '/tmp/source.html',
      sourcePhaseContract: {
        phases: [
          {
            id: 'phase1',
            name: 'Collect ice',
            guideText: 'Collect ice',
            showEntities: ['Player', 'IceSpawner', 'IceChunk'],
            steps: [{ target: 'IceChunk', label: 'ice' }],
          },
          {
            id: 'phase2',
            name: 'Build turret',
            guideText: 'Build turret',
            showEntities: ['TurretUnlock', 'Turret'],
            steps: [{ target: 'TurretUnlock', label: 'unlock' }],
          },
        ],
      },
    },
    plans: {
      assemblyPlan: {
        phaseBindings: [
          {
            phaseId: 'phase1',
            index: 0,
            atomIds: ['atom_001', 'atom_002'],
            completionSignals: ['player_position_changed', 'resource_incremented', 'phase_advanced'],
          },
          {
            phaseId: 'phase2',
            index: 1,
            atomIds: ['atom_003'],
            completionSignals: ['entity_state_equals_built', 'visual_variant_changed', 'phase_advanced'],
          },
        ],
        moduleInstances: [
          {
            id: 'Player::player_input_joystick',
            moduleId: 'player_input_joystick',
            entity: 'Player',
            params: { speed: 5 },
            expectedSignals: ['player_position_changed'],
            sourceAtomIds: ['atom_001'],
          },
          {
            id: 'IceChunk::collect_on_near',
            moduleId: 'collect_on_near',
            entity: 'IceChunk',
            params: { resource: 'Ice', item: 'Ice', count: 5, range: 1.5 },
            expectedSignals: ['resource_incremented', 'source_hidden_or_moved'],
            sourceAtomIds: ['atom_002'],
          },
          {
            id: 'Turret::activate_targets',
            moduleId: 'activate_targets',
            entity: 'Turret',
            params: { targets: ['Turret'] },
            expectedSignals: ['downstream_entity_visible'],
            sourceAtomIds: ['atom_003'],
          },
          {
            id: 'Turret::build_progress',
            moduleId: 'build_progress',
            entity: 'Turret',
            params: { buildTime: 1 },
            expectedSignals: ['entity_state_equals_built', 'visual_variant_changed'],
            sourceAtomIds: ['atom_003'],
          },
        ],
      },
      cuaPlan: {
        steps: [
          {
            phaseId: 'phase1',
            atomIds: ['atom_001', 'atom_002'],
            actions: [
              { kind: 'move_to', actor: 'Player', target: 'IceChunk', range: 1.5 },
              { kind: 'approach_collect', target: 'IceChunk', item: 'Ice', count: 5 },
            ],
            expectedSignals: ['player_position_changed', 'resource_incremented', 'phase_advanced'],
          },
          {
            phaseId: 'phase2',
            atomIds: ['atom_003'],
            actions: [{ kind: 'move_to', actor: 'Player', target: 'TurretUnlock', range: 1.5 }, { kind: 'build', target: 'Turret' }],
            expectedSignals: ['entity_state_equals_built', 'visual_variant_changed', 'phase_advanced'],
          },
        ],
      },
    },
    specs: [
      { phaseId: 'phase1', requiredInteractions: ['move_to:IceChunk', 'collect:Ice:5'] },
      { phaseId: 'phase2', requiredInteractions: ['build:Turret'] },
    ],
  };
}

var bundle = buildProofBundle(baseFixture());
assert.strictEqual(bundle.schemaVersion, 'blueprint-proof-bundle.v1');
assert.strictEqual(bundle.contractDiff.passed, true, 'valid source/WebGL proof contract should pass');
assert.deepStrictEqual(bundle.expectedPhasePath, ['phase1', 'phase2']);
assert.strictEqual(bundle.phases[0].target, 'IceChunk');
assert.deepStrictEqual(bundle.phases[0].targetSequence, ['IceChunk']);
assert.strictEqual(bundle.phases[0].userAffordance, 'joystick_move_near');
assert.ok(bundle.phases[0].exitEvidence.some(item => item.indexOf('PhaseResourceProgress(Ice) >= 5') >= 0));
assert.ok(bundle.phases[1].exitEvidence.some(item => item.indexOf('EntityAdvanced(Turret)') >= 0));
assert.ok(bundle.semanticHash && bundle.phases[0].semanticHash, 'proof bundle should carry reusable semantic hashes');

var buildContract = moduleProofContract({
  id: 'Turret::build_progress',
  moduleId: 'build_progress',
  entity: 'Turret',
  params: { buildTime: 1 },
  expectedSignals: ['entity_state_equals_built'],
}, 'Turret');
assert.ok(buildContract.exitEvidence.indexOf('EntityAdvanced(Turret)') >= 0, 'build module proof must include real progress evidence');

var hiddenCounterFixture = baseFixture();
hiddenCounterFixture.plans.cuaPlan.steps[0].actions = [
  { kind: 'move_to', actor: 'Player', target: 'Ice', range: 1.5 },
  { kind: 'approach_collect', target: 'Ice', item: 'Ice', count: 5 },
];
var hiddenCounterBundle = buildProofBundle(hiddenCounterFixture);
assert.strictEqual(hiddenCounterBundle.contractDiff.passed, false, 'hidden resource targets must fail before CUA');
assert.ok(hiddenCounterBundle.contractDiff.blocking.some(item => item.code === 'target_not_in_storyboard_phase'));

var missingResourceFixture = baseFixture();
missingResourceFixture.plans.cuaPlan.steps[0].actions = [
  { kind: 'move_to', actor: 'Player', target: 'IceChunk', range: 1.5 },
  { kind: 'approach_collect', target: 'IceChunk', item: 'Ice', count: 1 },
];
missingResourceFixture.plans.assemblyPlan.moduleInstances = missingResourceFixture.plans.assemblyPlan.moduleInstances.filter(function(module) {
  return module.moduleId !== 'collect_on_near';
});
var missingResourceBundle = buildProofBundle(missingResourceFixture);
assert.strictEqual(missingResourceBundle.contractDiff.passed, false, 'resource/count drift must fail before CUA');
assert.ok(missingResourceBundle.contractDiff.blocking.some(item => item.code === 'resource_action_contract_missing'));
assert.ok(missingResourceBundle.contractDiff.blocking.some(item => item.code === 'resource_module_contract_missing'));

var wrongModuleResourceFixture = baseFixture();
wrongModuleResourceFixture.plans.assemblyPlan.moduleInstances.forEach(function(module) {
  if (module.id === 'IceChunk::collect_on_near') {
    module.params.resource = 'IceChunk';
    module.params.item = 'IceChunk';
  }
});
var wrongModuleResourceBundle = buildProofBundle(wrongModuleResourceFixture);
assert.strictEqual(wrongModuleResourceBundle.contractDiff.passed, false, 'correct CUA action must not mask wrong implementation resource');
assert.ok(wrongModuleResourceBundle.contractDiff.blocking.some(item => item.code === 'resource_module_contract_missing'));

var resourceTargetProject = buildBlueprintProject({
  entities: [
    { name: 'Player' },
    { name: 'AreaBarrier' },
    { name: 'NewAreaResource' }
  ],
  resources: [{ name: 'Gold' }],
  phases: [
    {
      phaseId: 'phase6',
      guideText: '新区域资源收集阶段',
      showEntities: ['AreaBarrier', 'NewAreaResource'],
      trigger: { type: 'resource_collected', resource: 'Gold', amount: 60 },
    }
  ]
}, {
  assetManifest: {
    sourcePhaseContract: {
      phases: [
        {
          id: 'phase6',
          showEntities: ['AreaBarrier', 'NewAreaResource'],
          steps: [{ target: 'NewAreaResource', label: '收集新区域资源' }],
          hudText: { targetEntity: 'NewAreaResource' },
        }
      ]
    }
  }
});
assert.deepStrictEqual(
  resourceTargetProject.specs[0].requiredInteractions,
  ['move_to:NewAreaResource', 'collect:Gold:60'],
  'resource phases should prefer source step target over passive barriers when building required interactions'
);

console.log('source-ir proof bundle tests passed');
