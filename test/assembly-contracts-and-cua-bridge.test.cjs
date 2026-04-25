var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var assemblyPlanContracts = require('../engine/assembly-plan-contracts.cjs');
var { buildProjectPlans } = require('../adapters/assembly-plan-pipeline.cjs');
var { buildSpecsFromPlans } = require('../adapters/cua-plan-bridge.cjs');
var { writeSpecsFile } = require('../worker/worker-playableagent.js');

var project = {
  name: 'AssemblyContractBridge',
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
};

var plans = buildProjectPlans(project);
assert.ok(plans.validation.ok, 'plans should validate');

var guidance = assemblyPlanContracts.buildReviewPlanGuidance(plans);
assert.ok(guidance.indexOf('"fileOwners"') >= 0, 'review guidance should include file owners');
assert.ok(guidance.indexOf('"cuaSteps"') >= 0, 'review guidance should include cua steps');
assert.ok(guidance.indexOf('"phaseEvidenceSchema"') >= 0, 'review guidance should include phase evidence schema');

assert.deepStrictEqual(
  assemblyPlanContracts.collectExpectedPhaseIds({ specs: project.specs, plans: plans }),
  ['intro', 'build'],
  'spec phases should take priority'
);
assert.deepStrictEqual(
  assemblyPlanContracts.collectExpectedPhaseIds({ plans: plans }),
  ['intro', 'build'],
  'plan phases should be used when specs are absent'
);

var coverage = assemblyPlanContracts.computePhaseCoverage(
  'AddCompletedPhase("intro");\nReportPhase("build");',
  ['intro', 'build']
);
assert.strictEqual(coverage.coverage, 1, 'coverage should be full for matching phase ids');
assert.deepStrictEqual(coverage.missingPhaseIds, [], 'matching code should have no missing phases');

var missingOwnerCtx = {
  csCode: 'void Update() { AddCompletedPhase("intro"); AddCompletedPhase("build"); }',
  extraFiles: {},
  blueprint: {
    plans: plans,
    planValidation: plans.validation
  }
};
var violations = assemblyPlanContracts.detectAssemblyContractViolations(missingOwnerCtx);
assert.ok(violations.some(function(item) { return item.rule === 'assembly-owner-file-missing'; }), 'missing owner files should be reported');

var slotOwnership = assemblyPlanContracts.extractAssemblySlotOwnership({
  'GameFlowManagerMain.Flow.cs': '// [ASSEMBLY SLOT] ConveyorBelt::build_progress',
  'GameFlowManagerMain.UI.cs': '// [ASSEMBLY SLOT] system::guide_ui'
});
assert.deepStrictEqual(slotOwnership['ConveyorBelt::build_progress'], ['GameFlowManagerMain.Flow.cs'], 'slot ownership should be indexed per file');
assert.strictEqual(
  assemblyPlanContracts.fileMayWriteState('guideText = "Build now";', 'ui.guideText'),
  true,
  'guideText assignment should be treated as a UI state write'
);
assert.strictEqual(
  assemblyPlanContracts.fileMayWriteState('// guideText = "comment only";', 'ui.guideText'),
  false,
  'comment-only state mentions should be ignored'
);
assert.strictEqual(
  assemblyPlanContracts.fileMayWriteState('string buildState = BuildEntityBuildState(stateCode);', 'Barrack.buildState'),
  false,
  'entity build state should not be falsely matched by a local helper variable name'
);
assert.strictEqual(
  assemblyPlanContracts.fileMayWriteState('BarrackState = Mathf.Max(BarrackState, 2);', 'Barrack.buildState'),
  true,
  'entity build state should map to the owning skeleton field alias'
);
assert.strictEqual(
  assemblyPlanContracts.fileMayWriteState('OurBaseState++;', 'OurBase.upgradeLevel'),
  true,
  'upgrade level should recognize the shared buildable state field alias'
);
assert.strictEqual(
  assemblyPlanContracts.fileMayWriteState('if (Gold == null) return;', 'economy.gold'),
  false,
  'economy gold writes should not treat equality checks as assignments'
);
assert.strictEqual(
  assemblyPlanContracts.fileMayWriteState('Gold.transform.position = Vector3.zero;', 'economy.gold'),
  false,
  'economy gold writes should not confuse Gold GameObject mutations with resource balance'
);
assert.strictEqual(
  assemblyPlanContracts.isStrictAssemblyOwnerState('ConveyorBelt.buildState'),
  true,
  'entity build state should remain a strict owner state'
);
assert.strictEqual(
  assemblyPlanContracts.isStrictAssemblyOwnerState('ConveyorBelt.position'),
  false,
  'entity position should be treated as a shared runtime state'
);
assert.strictEqual(
  assemblyPlanContracts.isStrictAssemblyOwnerState('ui.scoreText'),
  false,
  'shared UI feedback state should not use strict ownership'
);

var ownerMismatchCtx = {
  csCode: 'void Update() { AddCompletedPhase("intro"); AddCompletedPhase("build"); }',
  extraFiles: {
    'GameFlowManagerMain.Flow.cs': [
      '// [ASSEMBLY SLOT] system::camera_focus',
      '// [ASSEMBLY SLOT] system::camera_lift',
      '// [ASSEMBLY SLOT] system::camera_zoom'
    ].join('\n'),
    'GameFlowManagerMain.Input.cs': [
      '// [ASSEMBLY SLOT] Player::player_input_joystick',
      '// [ASSEMBLY SLOT] Turret::click_trigger'
    ].join('\n'),
    'GameFlowManagerMain.Resource.cs': '// [ASSEMBLY SLOT] ConveyorBelt::cost_gate',
    'GameFlowManagerMain.UI.cs': [
      '// [ASSEMBLY SLOT] ConveyorBelt::build_progress',
      '// [ASSEMBLY SLOT] system::floating_text_feedback',
      '// [ASSEMBLY SLOT] system::guide_ui',
      '// [ASSEMBLY SLOT] system::highlight_target',
      '// [ASSEMBLY SLOT] system::world_label',
      'void WrongWrite() { ConveyorBeltState = 1; }'
    ].join('\n'),
    'GameFlowManagerMain.Scene.cs': [
      '// [ASSEMBLY SLOT] Player::visual_binding',
      '// [ASSEMBLY SLOT] ConveyorBelt::visual_binding',
      '// [ASSEMBLY SLOT] Turret::visual_binding',
      '// [ASSEMBLY SLOT] system::camera_focus',
      '// [ASSEMBLY SLOT] system::camera_lift',
      '// [ASSEMBLY SLOT] system::camera_zoom'
    ].join('\n')
  },
  blueprint: {
    plans: plans,
    planValidation: plans.validation
  }
};
var ownerMismatchViolations = assemblyPlanContracts.detectAssemblyContractViolations(ownerMismatchCtx);
assert.ok(
  ownerMismatchViolations.some(function(item) { return item.rule === 'assembly-module-owner-mismatch' && item.data.moduleInstanceId === 'ConveyorBelt::build_progress'; }),
  'module slots in the wrong owner file should be reported'
);
assert.ok(
  ownerMismatchViolations.some(function(item) { return item.rule === 'assembly-state-owner-mismatch' && item.data.state === 'ConveyorBelt.buildState'; }),
  'state writes from a non-owner file should be reported'
);
assert.ok(
  !ownerMismatchViolations.some(function(item) { return item.rule === 'assembly-state-owner-mismatch' && item.data.state === 'ConveyorBelt.position'; }),
  'shared runtime position state should not be flagged as an ownership violation'
);

var localizedSlotOwnership = assemblyPlanContracts.extractAssemblySlotOwnership({
  'GameFlowManagerMain.Flow.cs': '// [ASSEMBLY SLOT] 装配槽 ConveyorBelt::build_progress'
});
assert.deepStrictEqual(
  localizedSlotOwnership['ConveyorBelt::build_progress'],
  ['GameFlowManagerMain.Flow.cs'],
  'localized assembly slot comments should still map to the original module id'
);

var derivedSpecs = buildSpecsFromPlans(plans);
assert.strictEqual(derivedSpecs.length, 2, 'cua plan should derive two specs');
assert.ok(derivedSpecs[0].requiredInteractions.some(function(text) { return text.indexOf('move_to:') === 0; }), 'move_to action should map into derived specs');
assert.ok(derivedSpecs[1].requiredInteractions.some(function(text) { return text.indexOf('build:') === 0; }), 'build action should map into derived specs');

var tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-cua-plans-'));
process.env.SPECS_DATA_DIR = tmpRoot;
var specsFile = writeSpecsFile({ plans: plans }, 'proj_plan_only');
var diskSpecs = JSON.parse(fs.readFileSync(specsFile, 'utf8'));
assert.strictEqual(diskSpecs.length, 2, 'writeSpecsFile should fall back to plan-derived specs');
delete process.env.SPECS_DATA_DIR;
fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log('assembly-contracts-and-cua-bridge tests passed');
