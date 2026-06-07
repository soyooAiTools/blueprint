#!/usr/bin/env node

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var worker = require('../worker/worker-playableagent.js');
var playableAgentSrc = fs.readFileSync(path.join(__dirname, '..', 'worker', 'worker-playableagent.js'), 'utf8');

assert.ok(
  playableAgentSrc.indexOf('BLUEPRINT_MANUAL_JOYSTICK_FLOW_ARRIVAL_RANGE') >= 0 &&
    playableAgentSrc.indexOf('continue;') >= 0,
  'manual joystick flow probe should wait/tap inside the runtime arrival ring instead of dragging through the target'
);
assert.ok(
  playableAgentSrc.indexOf('BLUEPRINT_STORYBOARD_VIDEO_DRAG_TIMEOUT_MS') >= 0 &&
    playableAgentSrc.indexOf('storyboard video forced touchEnd') >= 0,
  'storyboard video audit drags should be timeout-bounded and release touch input on failure'
);
assert.ok(
  /BLUEPRINT_STORYBOARD_VIDEO_AUDIT_INPUT[\s\S]{0,500}'dom-pointer'\)\)/.test(playableAgentSrc),
  'storyboard video audit should default to DOM pointer input; touch CDP mode is available only when explicitly requested'
);
assert.ok(
  playableAgentSrc.indexOf("source: 'fallback', x: 90, y: 750, radius: 78") >= 0,
  'storyboard video audit fallback joystick origin should match the proven manual probe origin'
);
assert.ok(
  playableAgentSrc.indexOf('BLUEPRINT_MANUAL_JOYSTICK_PROBE_TOUCH_MODE') >= 0 &&
    playableAgentSrc.indexOf("pointerType: 'touch'") >= 0,
  'manual joystick probe should default touch-only check to DOM pointer touch events instead of CDP touch'
);
assert.ok(
  playableAgentSrc.indexOf('Runtime joystick drag follows world X/Z direction') >= 0 &&
    playableAgentSrc.indexOf('x: dx / mag') >= 0,
  'manual joystick flow probe should steer in runtime world-space direction'
);
assert.ok(
  playableAgentSrc.indexOf('extractBlueprintPhaseTargetMap') >= 0 &&
    playableAgentSrc.indexOf('extractBlueprintPhaseTargetSequenceMap') >= 0 &&
    playableAgentSrc.indexOf('choosePhaseVisibleTarget') >= 0 &&
    playableAgentSrc.indexOf('targetExistsInPhaseSpec') >= 0 &&
    playableAgentSrc.indexOf('targetFromGuidanceLine ? roundPos(line && line.target) : null') >= 0,
  'manual joystick flow probe should prefer visible phase targets over stale UI guidance or counter targets'
);
assert.ok(
  playableAgentSrc.indexOf('const lineTarget = line && line.targetName') >= 0 &&
    playableAgentSrc.indexOf('const sequence = args.phaseTargetSequences') >= 0 &&
    playableAgentSrc.indexOf('if (isVisibleWorldPos(stateEntityPos(gs, name))) return name;') >= 0,
  'manual joystick flow probe should advance through visible per-phase target sequences before stale overlay fallback targets'
);
assert.ok(
  playableAgentSrc.indexOf('window.__bpManualFlowTargetCursor') >= 0 &&
    playableAgentSrc.indexOf('store.indexes[phaseKey] = targetSequenceIndex + 1') >= 0 &&
    playableAgentSrc.indexOf('targetSequenceIndex') >= 0 &&
    playableAgentSrc.indexOf('arrivalRange })') >= 0,
  'manual joystick flow probe should keep a browser-side cursor through multi-target phase sequences'
);
assert.ok(
  playableAgentSrc.indexOf("BLUEPRINT_MANUAL_JOYSTICK_FLOW_TOUCH_MODE || 'dom-pointer'") >= 0 &&
    playableAgentSrc.indexOf("flowTouchMode === 'cdp'") >= 0 &&
    playableAgentSrc.indexOf('manual joystick flow dom pointer') >= 0,
  'manual joystick flow probe should default to DOM pointer input while retaining explicit CDP touch mode'
);
assert.ok(
  playableAgentSrc.indexOf("{ pos: runtimePlayer, source: 'runtime-player' }") >= 0 &&
    playableAgentSrc.indexOf("{ pos: stateTarget, source: 'state-target' }") >= 0 &&
    playableAgentSrc.indexOf('isVisibleWorldPos') >= 0,
  'manual joystick flow samples must prefer visible Luna/GFM runtime positions over the source overlay'
);
assert.ok(
  /\{ pos: stateTarget, source: 'state-target' \}[\s\S]{0,120}\{ pos: rootTarget, source: 'overlay-root-target' \}[\s\S]{0,120}\{ pos: lineTargetPos, source: 'overlay-guidance-target' \}/.test(playableAgentSrc),
  'manual joystick flow target samples should prefer real Luna/GFM target positions before storyboard overlay targets'
);
assert.ok(
  playableAgentSrc.indexOf('function currentPhaseEvidence') >= 0 &&
    playableAgentSrc.indexOf('resources = clonePlainObject') >= 0 &&
    playableAgentSrc.indexOf('phaseEvidence,') >= 0 &&
    playableAgentSrc.indexOf('entityStateTarget') >= 0,
  'manual joystick flow samples should include resources and current phase evidence for generated-game gate diagnosis'
);
assert.ok(
  playableAgentSrc.indexOf('BLUEPRINT_MANUAL_JOYSTICK_FLOW_HOLD_MS') >= 0 &&
    playableAgentSrc.indexOf('computeManualJoystickFlowBudget') >= 0 &&
    playableAgentSrc.indexOf('phaseCount, env') >= 0 &&
    playableAgentSrc.indexOf('distanceBefore') >= 0,
  'manual joystick flow probe should use longer distance-aware drags and a window large enough for multi-phase routes'
);
assert.ok(
  playableAgentSrc.indexOf('maxFlowIterations') >= 0 &&
    playableAgentSrc.indexOf('closeTargetTicks < 2') >= 0 &&
    playableAgentSrc.indexOf('iterationBudgetReached') >= 0,
  'manual joystick flow probe should not wait forever just outside a stricter runtime arrival gate'
);
assert.ok(
  playableAgentSrc.indexOf('BLUEPRINT_MANUAL_JOYSTICK_FLOW_SAMPLE_INTERVAL_MS') >= 0 &&
    playableAgentSrc.indexOf("sample('during-' + label") >= 0 &&
    playableAgentSrc.indexOf('holdSampleCount') >= 0,
  'manual joystick flow probe should sample during long drags so short timer phases remain observable'
);
assert.ok(
  playableAgentSrc.indexOf("flowDriver = String(process.env.BLUEPRINT_MANUAL_JOYSTICK_FLOW_DRIVER || 'autonav')") >= 0 &&
    playableAgentSrc.indexOf('autonav_joystick') >= 0 &&
    playableAgentSrc.indexOf('{ x: -lastDir.x, y: -lastDir.y }') >= 0,
  'AutoNav joystick flow should drive the runtime joystick override with the inverse sign required by the bridge, not teleport the player'
);
assert.ok(
  playableAgentSrc.indexOf('missingPhasePath') >= 0 &&
    playableAgentSrc.indexOf('manual joystick flow skipped observable phase path') >= 0,
  'manual joystick flow probe must fail when completedCount jumps over unobserved phases'
);
assert.ok(
  playableAgentSrc.indexOf('BLUEPRINT_MANUAL_JOYSTICK_CHECKPOINT_PHASE') >= 0 &&
    playableAgentSrc.indexOf('BLUEPRINT_MANUAL_JOYSTICK_CHECKPOINT_ONLY') >= 0 &&
    playableAgentSrc.indexOf('manual joystick checkpoint driveToPhase') >= 0 &&
    playableAgentSrc.indexOf('__driveToPhase') >= 0,
  'manual joystick checkpoint CUA must be explicit debug-only runtime phase driving, not the default full-flow gate'
);
assert.ok(
  playableAgentSrc.indexOf('isHighComplexity ? 1 : 5') >= 0 &&
    playableAgentSrc.indexOf('BLUEPRINT_CUA_SPEED_MULTIPLIER') >= 0,
  'high-complexity observe mode should default to 1x speed so screenshot-timing remains meaningful'
);
assert.ok(
  playableAgentSrc.indexOf('manual joystick flow mouseDown tap') >= 0 &&
    playableAgentSrc.indexOf('manual joystick flow mouseUp tap') >= 0,
  'manual joystick flow CTA taps should hit the Unity mouse input path, not only synthetic DOM pointer events'
);
assert.ok(
  playableAgentSrc.indexOf('__bpApplyManualClickOverride') >= 0 &&
    playableAgentSrc.indexOf('manual joystick flow runtime click override') >= 0 &&
    playableAgentSrc.indexOf('__bpManualClickOverride') >= 0,
  'manual joystick flow CTA taps should bridge through the runtime click override when the source overlay masks Unity input'
);
assert.ok(
  playableAgentSrc.indexOf('tap-final-') >= 0 &&
    playableAgentSrc.indexOf('after-final-tap') >= 0 &&
    playableAgentSrc.indexOf('canTapFinalTarget(current)') >= 0,
  'manual joystick flow should tap a visible final CTA directly instead of dragging the player toward UI'
);
assert.ok(
  playableAgentSrc.indexOf('manual joystick flow fallback tap point') >= 0 &&
    playableAgentSrc.indexOf('Math.round(w * 0.5)') >= 0 &&
    playableAgentSrc.indexOf('Math.round(h * 0.82)') >= 0,
  'manual joystick flow should tap final CTA targets even when no projected target rect is available'
);
assert.ok(
  playableAgentSrc.indexOf("withTimeout(browser.close(), 15000, 'manual joystick flow browser close')") >= 0,
  'manual joystick flow browser shutdown should be timeout bounded'
);

assert.strictEqual(
  worker.blueprintNeedsManualJoystickProbe({
    plans: {
      cuaPlan: {
        steps: [{ strategy: 'joystick_move', objective: 'move_to IceBlock' }]
      }
    }
  }, {}),
  true,
  'joystick/move_to plans must require the manual joystick probe'
);

assert.strictEqual(
  worker.blueprintNeedsManualJoystickProbe({
    specs: [
      { phaseId: 'phase1' },
      { phaseId: 'phase2' },
    ]
  }, {}),
  true,
  'multi-phase playable specs must require the manual joystick probe even when the plan omits joystick keywords'
);

assert.strictEqual(
  worker.blueprintNeedsManualJoystickProbe({}, {
    coveredSignals: ['intro:player_position_changed']
  }),
  true,
  'player_position_changed signal coverage must require the manual joystick probe'
);

assert.deepStrictEqual(
  worker.extractBlueprintPhaseTargetMap({
    specs: [{ phaseId: 'phase1' }, { phaseId: 'phase2' }, { phaseId: 'phase3' }],
    plans: {
      cuaPlan: {
        steps: [
          { phaseId: 'phase1', actions: [{ kind: 'move_to', actor: 'Player', target: 'WaterTank' }] },
          { phaseId: 'phase2', actions: [{ kind: 'move_to', actor: 'Player', target: 'PopcornMachine' }] },
          { phaseId: 'phase3', actions: [{ kind: 'tap', target: 'CTAButton' }] },
        ]
      }
    }
  }),
  { phase1: 'WaterTank', phase2: 'PopcornMachine', phase3: 'CTAButton' },
  'manual joystick flow should extract authoritative phase targets from the CUA plan'
);

assert.deepStrictEqual(
  worker.extractBlueprintPhaseTargetMap({
    specs: [
      {
        phaseId: 'phase8',
        requiredInteractions: ['move_to:EnemyKillCount', 'collect:EnemyKillCount:10'],
        entitiesRequired: [{ name: 'AlienSmallSpawner' }, { name: 'AlienSmall' }],
      },
    ],
    plans: {
      cuaPlan: {
        steps: [
          {
            phaseId: 'phase8',
            actions: [
              { kind: 'move_to', actor: 'Player', target: 'EnemyKillCount' },
              { kind: 'approach_collect', target: 'EnemyKillCount', item: 'EnemyKillCount', count: 10 },
            ],
          },
        ],
      },
    },
  }),
  { phase8: 'AlienSmall' },
  'manual joystick flow should steer toward visible phase entities when the plan target is a hidden counter resource'
);

var proofBlueprint = {
  proofBundle: {
    expectedPhasePath: ['phase1', 'phase2'],
    phases: [
      { phaseId: 'phase1', target: 'IceChunk' },
      { phaseId: 'phase2', target: 'Turret' }
    ]
  },
  specs: [{ phaseId: 'phase1' }, { phaseId: 'phase2' }],
  plans: {
    cuaPlan: {
      steps: [
        { phaseId: 'phase1', actions: [{ kind: 'move_to', target: 'AlienSmall' }] },
        { phaseId: 'phase2', actions: [{ kind: 'build', target: 'AlienSmall' }] }
      ]
    }
  }
};
assert.deepStrictEqual(
  worker.extractBlueprintPhaseIds(proofBlueprint),
  ['phase1', 'phase2'],
  'manual joystick flow should use proof bundle phase path when available'
);
assert.deepStrictEqual(
  worker.extractBlueprintPhaseTargetMap(proofBlueprint),
  { phase1: 'IceChunk', phase2: 'Turret' },
  'manual joystick flow should use proof bundle targets over stale merged CUA module targets'
);
assert.deepStrictEqual(
  worker.extractBlueprintPhaseTargetSequenceMap({
    proofBundle: {
      expectedPhasePath: ['phase1', 'phase2'],
      phases: [
        { phaseId: 'phase1', target: 'Furnace', targetSequence: ['Furnace'] },
        { phaseId: 'phase2', target: 'WaterBottle', targetSequence: ['WaterBottle', 'AstronautQueue'] },
      ],
    },
  }),
  { phase1: ['Furnace'], phase2: ['WaterBottle', 'AstronautQueue'] },
  'manual joystick flow should preserve multi-step target sequences from proof bundles'
);

var uiTargetBlueprint = {
  proofBundle: {
    expectedPhasePath: ['phase1', 'phase2', 'phase3'],
    phases: [
      { phaseId: 'phase1', target: 'CabinDoor', targetSequence: ['CabinDoor'] },
      { phaseId: 'phase2', target: 'GuideUI', targetSequence: ['GuideUI'] },
      { phaseId: 'phase3', target: 'CTAButton', targetSequence: ['CTAButton'] },
    ],
  },
  specs: [
    { phaseId: 'phase1', entitiesRequired: [{ name: 'CabinDoor' }, { name: 'GuideUI' }] },
    { phaseId: 'phase2', entitiesRequired: [{ name: 'GuideUI' }, { name: 'RecoveryBathtub' }] },
    { phaseId: 'phase3', entitiesRequired: [{ name: 'CTAButton' }, { name: 'GuideUI' }] },
  ],
  plans: {
    cuaPlan: {
      steps: [
        { phaseId: 'phase2', actions: [{ kind: 'move_to', target: 'GuideUI' }, { kind: 'build', target: 'RecoveryBathtub' }] },
      ],
    },
  },
};
assert.deepStrictEqual(
  worker.extractBlueprintPhaseTargetMap(uiTargetBlueprint),
  { phase1: 'CabinDoor', phase2: 'RecoveryBathtub', phase3: 'CTAButton' },
  'manual joystick flow should replace non-navigable GuideUI proof targets with real phase entities'
);
assert.deepStrictEqual(
  worker.extractBlueprintPhaseTargetSequenceMap(uiTargetBlueprint),
  { phase1: ['CabinDoor'], phase2: ['RecoveryBathtub'], phase3: ['CTAButton'] },
  'manual joystick flow target sequences should filter GuideUI and recover build/setEntity targets'
);

var checkpointBlueprint = {
  proofBundle: {
    expectedPhasePath: ['phase1', 'phase2', 'phase3', 'phase4'],
    phases: [
      { phaseId: 'phase1', target: 'IceChunk' },
      { phaseId: 'phase2', target: 'MeltingFurnace' },
      { phaseId: 'phase3', target: 'WaterBottle' },
      { phaseId: 'phase4', target: 'CTAButton' }
    ]
  }
};
var checkpointWindow = worker.selectManualJoystickPhaseWindow(checkpointBlueprint, {
  checkpointPhase: 'phase2',
  maxPhases: 2
});
assert.deepStrictEqual(
  checkpointWindow.phaseIds,
  ['phase2', 'phase3'],
  'manual joystick checkpoint should slice the proof phase path from the requested phase'
);
assert.deepStrictEqual(
  checkpointWindow.phaseTargets,
  { phase2: 'MeltingFurnace', phase3: 'WaterBottle' },
  'manual joystick checkpoint should preserve proof targets for the local phase window'
);
assert.deepStrictEqual(
  checkpointWindow.phaseTargetSequences,
  { phase2: ['MeltingFurnace'], phase3: ['WaterBottle'] },
  'manual joystick checkpoint should preserve proof target sequences for the local phase window'
);
assert.strictEqual(checkpointWindow.checkpointPhaseIndex, 2);
assert.strictEqual(checkpointWindow.checkpointPhase, 'phase2');
assert.strictEqual(
  worker.selectManualJoystickPhaseWindow(checkpointBlueprint, { checkpointPhase: '3', maxPhases: 1 }).checkpointPhase,
  'phase3',
  'manual joystick checkpoint should accept numeric phase indexes for local reruns'
);
assert.ok(
  worker.selectManualJoystickPhaseWindow(checkpointBlueprint, { checkpointPhase: 'missingPhase' }).checkpointError.indexOf('unknown checkpoint phase') >= 0,
  'manual joystick checkpoint should hard-fail an unknown phase instead of silently running the full path'
);

var sidecarDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'blueprint-sidecar-cua-'));
fs.writeFileSync(path.join(sidecarDir, 'blueprint-specs.json'), JSON.stringify([{ phaseId: 'phase1' }]));
fs.writeFileSync(path.join(sidecarDir, 'blueprint-plans.json'), JSON.stringify({ cuaPlan: { steps: [{ phaseId: 'phase1' }] } }));
fs.writeFileSync(path.join(sidecarDir, 'blueprint-proof-bundle.json'), JSON.stringify({
  schemaVersion: 'blueprint-proof-bundle.v1',
  expectedPhasePath: ['phase1'],
  phases: [{ phaseId: 'phase1', target: 'IceChunk' }],
  contractDiff: { passed: true, blocking: [], warnings: [], summary: { blocking: 0, warnings: 0 } }
}));
var sidecarBlueprint = worker.attachBlueprintProofBundle(sidecarDir, {}, 'sidecar-task', function() {});
assert.deepStrictEqual(sidecarBlueprint.specs, [{ phaseId: 'phase1' }], 'CUA should load blueprint-specs sidecar for direct WebGL verification');
assert.deepStrictEqual(sidecarBlueprint.plans.cuaPlan.steps, [{ phaseId: 'phase1' }], 'CUA should load blueprint-plans sidecar for direct WebGL verification');
assert.strictEqual(sidecarBlueprint.proofBundle.schemaVersion, 'blueprint-proof-bundle.v1', 'CUA should load proof bundle sidecar for direct WebGL verification');

var stuck = worker.evaluateManualJoystickProbeResult({
  samples: [
    {
      runtimePlayer: { x: 0, y: 0.9, z: 1 },
      joy: { h: 0, v: 0 }
    },
    {
      runtimePlayer: { x: 0, y: 0.9, z: 1 },
      joy: { h: 0.7, v: 0.7 }
    }
  ]
});

assert.strictEqual(stuck.passed, false, 'responding joystick with stationary player must fail');
assert.ok(stuck.reason.indexOf('player position did not change') >= 0);
assert.ok(stuck.maxInput > 0.9);
assert.strictEqual(stuck.maxPlayerDistance, 0);

var moved = worker.evaluateManualJoystickProbeResult({
  samples: [
    {
      runtimePlayer: { x: 0, y: 0.9, z: 1 },
      joy: { h: 0, v: 0 }
    },
    {
      runtimePlayer: { x: 0.25, y: 0.9, z: 1.2 },
      joy: { h: 0.7, v: 0.7 }
    }
  ]
});

assert.strictEqual(moved.passed, true, 'manual joystick probe should pass when input and player position both change');
assert.ok(moved.maxPlayerDistance > 0.05);

var overlayMoved = worker.evaluateManualJoystickProbeResult({
  samples: [
    {
      label: 'before',
      runtimePlayer: { x: 0, y: 0.9, z: 1 },
      joy: null,
      domStick: { className: '', knobTransform: '' },
      manualJoystickOverride: { active: false, x: 0, y: 0 }
    },
    {
      label: 'during-mouse-hold',
      runtimePlayer: { x: 0.25, y: 0.9, z: 1.2 },
      joy: null,
      domStick: { className: 'active', knobTransform: 'translate(31px, -31px)' },
      manualJoystickOverride: { active: true, x: -0.7, y: 0.7 }
    },
    {
      label: 'before-touch',
      runtimePlayer: { x: 0.25, y: 0.9, z: 1.2 },
      joy: null,
      domStick: { className: '', knobTransform: 'translate(0px, 0px)' },
      manualJoystickOverride: { active: false, x: 0, y: 0 }
    },
    {
      label: 'during-touch-hold',
      runtimePlayer: { x: 0.55, y: 0.9, z: 1.5 },
      joy: null,
      domStick: { className: 'active', knobTransform: 'translate(31px, -31px)' },
      manualJoystickOverride: { active: true, x: -0.7, y: 0.7 }
    }
  ]
});
assert.strictEqual(overlayMoved.passed, true, 'DOM overlay joystick should count as joystick input when it moves the player');
assert.ok(overlayMoved.maxInput > 0.9);

var touchMaskedByMouse = worker.evaluateManualJoystickProbeResult({
  samples: [
    {
      label: 'before',
      runtimePlayer: { x: 0, y: 0.9, z: 1 },
      joy: { h: 0, v: 0 }
    },
    {
      label: 'during-mouse-hold',
      runtimePlayer: { x: 0.25, y: 0.9, z: 1.2 },
      joy: { h: 0.7, v: 0.7 }
    },
    {
      label: 'before-touch',
      runtimePlayer: { x: 0.25, y: 0.9, z: 1.2 },
      joy: { h: 0, v: 0 }
    },
    {
      label: 'during-touch-hold',
      runtimePlayer: { x: 0.25, y: 0.9, z: 1.2 },
      joy: { h: 0, v: 0 }
    }
  ]
});
assert.strictEqual(touchMaskedByMouse.passed, false, 'mouse movement must not mask a broken touch-only joystick path');
assert.ok(touchMaskedByMouse.reason.indexOf('touch-only') >= 0);

var touchOk = worker.evaluateManualJoystickProbeResult({
  samples: [
    {
      label: 'before',
      runtimePlayer: { x: 0, y: 0.9, z: 1 },
      joy: { h: 0, v: 0 }
    },
    {
      label: 'during-mouse-hold',
      runtimePlayer: { x: 0.25, y: 0.9, z: 1.2 },
      joy: { h: 0.7, v: 0.7 }
    },
    {
      label: 'before-touch',
      runtimePlayer: { x: 0.25, y: 0.9, z: 1.2 },
      joy: { h: 0, v: 0 }
    },
    {
      label: 'during-touch-hold',
      runtimePlayer: { x: 0.55, y: 0.9, z: 1.5 },
      joy: { h: 0.7, v: 0.7 }
    }
  ]
});
assert.strictEqual(touchOk.passed, true, 'touch-only joystick path should pass when touch input and player movement both change');

var longFlowBudget = worker.computeManualJoystickFlowBudget(11, {});
assert.ok(longFlowBudget.windowMs > 600000, '11-phase manual flow budget must exceed the old 600s cap');
assert.ok(longFlowBudget.maxDrags >= 11 * 18, '11-phase manual flow drag budget should scale with phase count');

var flowOk = worker.evaluateManualJoystickFlowProbeResult({
  targetCompleted: 3,
  phaseIds: ['phase1', 'phase2', 'phase3'],
  dragCount: 8,
  samples: [
    { label: 'start', currentPhase: 'phase1', completedCount: 0, playerPos: { x: 0, y: 0, z: 0 } },
    { label: 'mid', currentPhase: 'phase2', completedCount: 1, playerPos: { x: 0.4, y: 0, z: 0.2 } },
    { label: 'final-phase', currentPhase: 'phase3', completedCount: 2, playerPos: { x: 0.8, y: 0, z: 0.5 } },
    { label: 'end', currentPhase: 'gameEnd', completedCount: 3, isTerminal: true, playerPos: { x: 1.1, y: 0, z: 0.7 } },
  ],
});
assert.strictEqual(flowOk.passed, true, 'manual joystick flow should pass when drags move player and complete all phases');
assert.strictEqual(flowOk.completedAfter, 3);
assert.deepStrictEqual(flowOk.phasePath, ['phase1', 'phase2', 'phase3', 'gameEnd']);
assert.deepStrictEqual(flowOk.missingPhasePath, []);

var checkpointFlowOk = worker.evaluateManualJoystickFlowProbeResult({
  targetCompleted: 1,
  phaseIds: ['phase3'],
  dragCount: 2,
  samples: [
    { label: 'checkpoint-start', currentPhase: 'phase3', completedCount: 0, playerPos: { x: 0, y: 0, z: 0 } },
    { label: 'checkpoint-end', currentPhase: 'phase3', completedCount: 1, playerPos: { x: 0.7, y: 0, z: 0.4 } },
  ],
});
assert.strictEqual(checkpointFlowOk.passed, true, 'checkpoint flow should validate a one-phase local window when joystick movement completes that phase');
assert.deepStrictEqual(checkpointFlowOk.expectedPhasePath, ['phase3']);

var flowSkipped = worker.evaluateManualJoystickFlowProbeResult({
  targetCompleted: 4,
  phaseIds: ['phase1', 'phase2', 'phase3', 'phase4'],
  dragCount: 4,
  samples: [
    { label: 'start', currentPhase: 'phase1', completedCount: 0, playerPos: { x: 0, y: 0, z: 0 } },
    { label: 'jump', currentPhase: 'phase4', completedCount: 3, playerPos: { x: 1, y: 0, z: 0.5 } },
    { label: 'end', currentPhase: 'gameEnd', completedCount: 4, isTerminal: true, playerPos: { x: 2, y: 0, z: 1 } },
  ],
});
assert.strictEqual(flowSkipped.passed, false, 'manual joystick flow must fail when observable phase path skips phases');
assert.deepStrictEqual(flowSkipped.missingPhasePath, ['phase2', 'phase3']);
assert.ok(flowSkipped.reason.indexOf('skipped observable phase path') >= 0);

var flowWitnessRecovered = worker.evaluateManualJoystickFlowProbeResult({
  targetCompleted: 4,
  phaseIds: ['phase1', 'phase2', 'phase3', 'phase4'],
  actions: [
    { type: 'autonav_joystick', label: 'autonav-0' },
    { type: 'autonav_joystick', label: 'autonav-1' },
  ],
  phaseWitness: {
    schemaVersion: 'blueprint-cua-phase-witness.v1',
    path: ['phase1', 'phase2', 'phase3', 'phase4'],
    events: [
      { phase: 'phase1', completedCount: 0 },
      { phase: 'phase2', completedCount: 1 },
      { phase: 'phase3', completedCount: 2 },
      { phase: 'phase4', completedCount: 3 },
    ],
  },
  samples: [
    { label: 'start', currentPhase: 'phase1', completedCount: 0, playerPos: { x: 0, y: 0, z: 0 } },
    { label: 'jump', currentPhase: 'phase4', completedCount: 3, playerPos: { x: 1, y: 0, z: 0.5 } },
    { label: 'end', currentPhase: 'gameEnd', completedCount: 4, isTerminal: true, playerPos: { x: 2, y: 0, z: 1 } },
  ],
});
assert.strictEqual(flowWitnessRecovered.passed, true, 'phase witness should recover short phases missed by low-frequency samples');
assert.strictEqual(flowWitnessRecovered.phasePathSource, 'phase-witness');
assert.deepStrictEqual(flowWitnessRecovered.missingPhasePath, []);
assert.deepStrictEqual(flowWitnessRecovered.phasePath, ['phase1', 'phase2', 'phase3', 'phase4', 'gameEnd']);
assert.strictEqual(flowWitnessRecovered.dragCount, 2, 'autonav joystick actions should count as manual joystick flow actions');

var flowCompletionWitnessRecovered = worker.evaluateManualJoystickFlowProbeResult({
  targetCompleted: 4,
  phaseIds: ['phase1', 'phase2', 'phase3', 'phase4'],
  actions: [
    { type: 'autonav_joystick', label: 'autonav-0' },
    { type: 'autonav_joystick', label: 'autonav-1' },
  ],
  phaseWitness: {
    schemaVersion: 'blueprint-cua-phase-witness.v1',
    path: ['phase1', 'phase4'],
    completedPath: ['phase1', 'phase2', 'phase3', 'phase4'],
    completedEvents: [
      { phase: 'phase1', completedCount: 1 },
      { phase: 'phase2', completedCount: 2 },
      { phase: 'phase3', completedCount: 3 },
      { phase: 'phase4', completedCount: 4 },
    ],
  },
  samples: [
    { label: 'start', currentPhase: 'phase1', completedCount: 0, playerPos: { x: 0, y: 0, z: 0 } },
    { label: 'jump', currentPhase: 'phase4', completedCount: 4, playerPos: { x: 1, y: 0, z: 0.5 } },
    { label: 'end', currentPhase: 'gameEnd', completedCount: 4, isTerminal: true, playerPos: { x: 2, y: 0, z: 1 } },
  ],
});
assert.strictEqual(flowCompletionWitnessRecovered.passed, true, 'completedPhases witness should recover very short phases after the full joystick flow completes');
assert.strictEqual(flowCompletionWitnessRecovered.phasePathSource, 'phase-completion-witness');
assert.deepStrictEqual(flowCompletionWitnessRecovered.phasePath, ['phase1', 'phase2', 'phase3', 'phase4', 'gameEnd']);

var incompleteCompletionWitness = worker.evaluateManualJoystickFlowProbeResult({
  targetCompleted: 4,
  phaseIds: ['phase1', 'phase2', 'phase3', 'phase4'],
  actions: [
    { type: 'autonav_joystick', label: 'autonav-0' },
  ],
  phaseWitness: {
    completedPath: ['phase1', 'phase2', 'phase3', 'phase4'],
  },
  samples: [
    { label: 'start', currentPhase: 'phase1', completedCount: 0, playerPos: { x: 0, y: 0, z: 0 } },
    { label: 'stuck', currentPhase: 'phase2', completedCount: 2, playerPos: { x: 1, y: 0, z: 0.5 } },
  ],
});
assert.strictEqual(incompleteCompletionWitness.passed, false, 'completedPhases witness must not mask an incomplete joystick flow');

var flowIncomplete = worker.evaluateManualJoystickFlowProbeResult({
  targetCompleted: 4,
  phaseIds: ['phase1', 'phase2', 'phase3', 'phase4'],
  dragCount: 10,
  samples: [
    { label: 'start', currentPhase: 'phase1', completedCount: 0, playerPos: { x: 0, y: 0, z: 0 } },
    { label: 'stuck', currentPhase: 'phase2', completedCount: 2, playerPos: { x: 1, y: 0, z: 0.5 } },
  ],
});
assert.strictEqual(flowIncomplete.passed, false, 'manual joystick flow must fail when player moves but phases do not complete');
assert.ok(flowIncomplete.reason.indexOf('incomplete') >= 0);

var flowTimedOut = worker.evaluateManualJoystickFlowProbeResult({
  targetCompleted: 11,
  phaseIds: ['phase1', 'phase2', 'phase3', 'phase4', 'phase5', 'phase6', 'phase7', 'phase8', 'phase9', 'phase10', 'phase11'],
  dragCount: 20,
  deadlineReached: true,
  samples: [
    { label: 'start', currentPhase: 'phase1', completedCount: 0, playerPos: { x: 0, y: 0, z: 0 } },
    { label: 'late', currentPhase: 'phase8', completedCount: 7, playerPos: { x: 12, y: 0, z: 4 } },
  ],
});
assert.strictEqual(flowTimedOut.passed, false, 'manual joystick flow must fail when the CUA window expires before completion');
assert.ok(flowTimedOut.reason.indexOf('timed out') >= 0, 'manual joystick flow timeout should be explicit in the reason');

var flowIterationBudget = worker.evaluateManualJoystickFlowProbeResult({
  targetCompleted: 3,
  phaseIds: ['phase1', 'phase2', 'phase3'],
  dragCount: 5,
  iterationBudgetReached: true,
  samples: [
    { label: 'start', currentPhase: 'phase1', completedCount: 0, playerPos: { x: 0, y: 0, z: 0 } },
    { label: 'near-stuck', currentPhase: 'phase2', completedCount: 1, playerPos: { x: 1, y: 0, z: 0.5 } },
  ],
});
assert.strictEqual(flowIterationBudget.passed, false, 'manual joystick flow must fail explicitly when non-drag iterations are exhausted');
assert.ok(flowIterationBudget.reason.indexOf('iteration budget') >= 0);

var visualOk = worker.evaluateStoryboardVisualAuditResult({
  phaseAudits: [
    { phase: 'phase1', labels: [
      { visible: true, entity: 'Player', entityRect: { x: 1 }, centerDx: 0.2, topGap: 8.1 }
    ] }
  ],
	  movementAudits: [
	    {
	      direction: 'up',
	      screenDx: 0.3,
	      screenDy: -18,
	      maxGuidanceLinePlayerDelta: 0.01,
	      maxAbsStepPx: 3.2,
	      labelDirectionChecks: [{ dEntityY: -2.5, dLabelBottom: -2.4 }]
	    }
	  ],
	  clickAudits: [{ maxDisplacementPx: 0.2 }],
	  targetMarkerAudits: [{ phase: 'phase1', visible: true, targetName: 'IceBlock' }]
	});
assert.strictEqual(visualOk.passed, true, 'well-anchored labels and smooth motion should pass storyboard visual audit');

var visualBadLabel = worker.evaluateStoryboardVisualAuditResult({
  phaseAudits: [
    { phase: 'phase2', labels: [
      { visible: true, entity: 'UpgradeStation', entityRect: { x: 1 }, centerDx: 28, topGap: -35 }
    ] }
  ]
});
assert.strictEqual(visualBadLabel.passed, false, 'far-away visible labels must fail storyboard visual audit');
assert.ok(visualBadLabel.reason.indexOf('storyboard-label') >= 0);

var visualBadMotion = worker.evaluateStoryboardVisualAuditResult({
	  movementAudits: [
	    {
	      direction: 'down',
	      screenDx: 0.5,
	      screenDy: 18,
	      maxAbsStepPx: 12,
	      labelDirectionChecks: [{ dEntityY: 2.5, dLabelBottom: -2.4 }]
	    }
  ]
});
	assert.strictEqual(visualBadMotion.passed, false, 'jumpy motion and opposite-direction label movement must fail storyboard visual audit');
	assert.ok(visualBadMotion.reason.indexOf('storyboard-motion') >= 0 || visualBadMotion.reason.indexOf('storyboard-label-motion') >= 0);

	var visualBadDirection = worker.evaluateStoryboardVisualAuditResult({
	  movementAudits: [
	    {
	      direction: 'up',
	      screenDx: 0.2,
	      screenDy: 18,
	      maxAbsStepPx: 3,
	      labelDirectionChecks: [{ dEntityY: 2.5, dLabelBottom: 2.4 }]
	    }
	  ]
	});
	assert.strictEqual(visualBadDirection.passed, false, 'up drag that moves player down on screen must fail storyboard visual audit');
	assert.ok(visualBadDirection.reason.indexOf('storyboard-direction') >= 0);

	var visualBadClick = worker.evaluateStoryboardVisualAuditResult({
	  movementAudits: [
	    {
	      direction: 'right',
	      screenDx: 18,
	      screenDy: 0.2,
	      maxAbsStepPx: 3,
	      labelDirectionChecks: [{ dEntityY: 0.1, dLabelBottom: 0.1 }]
	    }
	  ],
	  clickAudits: [{ maxDisplacementPx: 4.5 }]
	});
	assert.strictEqual(visualBadClick.passed, false, 'click without drag that moves player must fail storyboard visual audit');
	assert.ok(visualBadClick.reason.indexOf('storyboard-click-zero') >= 0);

	var visualBadGuidanceLine = worker.evaluateStoryboardVisualAuditResult({
	  movementAudits: [
	    {
	      direction: 'right',
	      screenDx: 18,
	      screenDy: 0.2,
	      maxGuidanceLinePlayerDelta: 0.2,
	      maxAbsStepPx: 3,
	      labelDirectionChecks: [{ dEntityY: 0.1, dLabelBottom: 0.1 }]
	    }
	  ]
	});
	assert.strictEqual(visualBadGuidanceLine.passed, false, 'guidance line not anchored to visible player must fail storyboard visual audit');
	assert.ok(visualBadGuidanceLine.reason.indexOf('storyboard-guidance-line') >= 0);

	var visualBadLayer = worker.evaluateStoryboardVisualAuditResult({
	  visualLayerAudits: [
	    {
	      phase: 'phase1',
	      visibleNonOverlaySurfaceCount: 2,
	      visibleNonOverlaySurfaces: [
	        { name: 'GFM_Player', path: 'Root/GFM_Player' },
	        { name: '__SourceTargetRing', path: 'Root/__SourceTargetRing' }
	      ]
	    }
	  ]
	});
	assert.strictEqual(visualBadLayer.passed, false, 'legacy non-overlay renderers must fail storyboard visual audit');
	assert.ok(visualBadLayer.reason.indexOf('storyboard-visual-layer') >= 0);

	var visualBadPhysics = worker.evaluateStoryboardVisualAuditResult({
	  visualLayerAudits: [
	    {
	      phase: 'phase1',
	      activeLegacyPhysicsCount: 2,
	      activeLegacyPhysics: [
	        { name: '__Pool_Cube_Blue_01', path: 'Root/__LunaPool/__Pool_Cube_Blue_01' },
	        { name: '__SourceGround', path: 'Root/__SourceGround' }
	      ]
	    }
	  ]
	});
	assert.strictEqual(visualBadPhysics.passed, false, 'hidden legacy colliders must fail storyboard runtime audit');
	assert.ok(visualBadPhysics.reason.indexOf('storyboard-legacy-physics') >= 0);

	var visualBadEntitySet = worker.evaluateStoryboardVisualAuditResult({
	  phaseAudits: [
	    {
	      phase: 'phase1',
	      expectedVisibleEntities: ['Player', 'IceBlock', 'Astronaut', 'GoldUI'],
	      actualVisibleEntities: ['Player', 'Astronaut', 'MysteryCube', 'GoldUI'],
	      labels: []
	    }
	  ]
	});
	assert.strictEqual(visualBadEntitySet.passed, false, 'visible entity set drift must fail storyboard visual audit');
	assert.ok(visualBadEntitySet.reason.indexOf('storyboard-entity-visibility') >= 0);

	var visualBadTargetMarker = worker.evaluateStoryboardVisualAuditResult({
	  targetMarkerAudits: [
	    { phase: 'phase1', visible: false, targetName: '', reason: 'state-unavailable' }
	  ]
	});
	assert.strictEqual(visualBadTargetMarker.passed, false, 'missing visible destination marker must fail storyboard visual audit');
	assert.ok(visualBadTargetMarker.reason.indexOf('storyboard-target-marker') >= 0);

assert.strictEqual(
  worker.shouldRunStoryboardVideoAudit({}),
  false,
  'storyboard video audit should be opt-in so optional video recording cannot block production CUA'
);
assert.strictEqual(
  worker.shouldRunStoryboardVideoAudit({ BLUEPRINT_STORYBOARD_VIDEO_AUDIT: '1' }),
  true,
  'explicit storyboard video audit enable should run the video audit'
);
assert.strictEqual(
  worker.shouldRunStoryboardVideoAudit({ BLUEPRINT_SKIP_STORYBOARD_VIDEO_AUDIT: '1' }),
  false,
  'explicit skip should disable storyboard video audit'
);
assert.strictEqual(
  worker.shouldRunStoryboardVideoAudit({ BLUEPRINT_VOLC_VIDEO_AUDIT: '0' }),
  false,
  'global Volcengine video audit off switch should disable storyboard video audit'
);

assert.ok(
  playableAgentSrc.indexOf("await emitDomPointer('mousemove', x, y, 1)") >= 0 &&
    playableAgentSrc.indexOf('await page.waitForTimeout(35)') >= 0 &&
    playableAgentSrc.indexOf('for (let hold = 0; hold < 10; hold++)') >= 0,
  'dom-pointer video audit must keep pointer input active over time instead of dispatching all moves in one burst'
);

console.log('playableagent manual joystick probe tests passed');
