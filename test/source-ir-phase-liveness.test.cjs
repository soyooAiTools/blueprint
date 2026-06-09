#!/usr/bin/env node
'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var {
  buildSourceIrPreviewHtml,
} = require('../engine/source-ir-preview-renderer.cjs');
var {
  analyzeSourceIrPhaseLiveness,
  evaluateSourceIrPhaseLiveness,
} = require('../engine/source-ir-phase-liveness.cjs');
var {
  SOURCE_SCENE_IR_SCHEMA_VERSION,
  normalizeSourceSceneIr,
} = require('../engine/source-scene-ir.cjs');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fixtureSourceIr() {
  return normalizeSourceSceneIr({
    schemaVersion: SOURCE_SCENE_IR_SCHEMA_VERSION,
    kind: 'blueprint.sourceSceneIR',
    project: { name: 'source-ir-phase-liveness-fixture', theme: 'default' },
    scene: {
      backgroundColor: '#101820',
      camera: { fov: 55, position: [0, 8, 12], lookAt: [0, 0, 0] },
      ground: { kind: 'plane', size: [20, 20], color: '#203040' },
    },
    entities: [
      { id: 'Player', label: 'Player', kind: 'player', position: [0, 0, 0], visual: { primitive: 'capsule', color: '#66ccff' } },
      { id: 'WaterDrop', label: 'Water', kind: 'resource', position: [3, 0, 0], visual: { primitive: 'sphere', color: '#33aaff' } },
      { id: 'Pump', label: 'Pump', kind: 'station', position: [6, 0, 0], visual: { primitive: 'box', color: '#ffaa33' } },
      { id: 'CtaButton', label: 'Install', kind: 'cta', position: [9, 0, 0], visual: { primitive: 'box', color: '#22cc88' } },
      { id: 'GoldUI', label: 'Gold UI', kind: 'ui_marker', position: [4, 0, 5.4], visual: { primitive: 'box', color: '#ffe45c' } },
    ],
    resources: [{ id: 'Water', label: 'Water', carrierEntity: 'WaterDrop', kind: 'resource', initial: 0 }],
    phases: [
      {
        id: 'phase1',
        title: 'Collect water',
        guideText: 'Collect water',
        showEntities: ['Player', 'WaterDrop', 'GoldUI'],
        plannedModuleIds: ['player_input_joystick', 'move_to_target', 'collect_on_near'],
        steps: [
          { kind: 'move_to', target: 'WaterDrop', radius: 1.2 },
          { kind: 'collect', resource: 'Water', amount: 2, from: 'WaterDrop' },
        ],
        gate: { kind: 'resource', resource: 'Water', threshold: 2 },
      },
      {
        id: 'phase2',
        title: 'Build pump',
        guideText: 'Build pump',
        showEntities: ['Player', 'Pump'],
        plannedModuleIds: ['player_input_joystick', 'move_to_target', 'build_progress'],
        steps: [
          { kind: 'move_to', target: 'Pump', radius: 1.2 },
          { kind: 'build', entity: 'Pump', state: 2 },
        ],
        gate: { kind: 'entity_state', entity: 'Pump', state: 2 },
      },
      {
        id: 'phase3',
        title: 'Install',
        guideText: 'Go to install',
        showEntities: ['Player', 'CtaButton'],
        plannedModuleIds: ['player_input_joystick', 'move_to_target', 'cta_finish'],
        steps: [{ kind: 'cta_finish', entity: 'CtaButton' }],
        gate: { kind: 'cta_arrival', entity: 'CtaButton', radius: 1.8 },
      },
    ],
    hud: { tip: { source: 'phase.guideText' }, resourceBar: ['Water'], cta: { entity: 'CtaButton', arrivalGated: true } },
    runtimeContract: { requiresJoystick: true, requiresArrivalGate: true, forbidAutoplayProgress: true },
  }, {
    html: '<div id="joystick"></div>',
    generatedAt: '2026-06-07T00:00:00.000Z',
  });
}

function assertStaticViolation(ir, code) {
  var report = analyzeSourceIrPhaseLiveness(ir, { repairPhaseLiveness: false });
  assert.strictEqual(report.passed, false);
  assert.ok(report.violations.some(function(violation) {
    return violation.code === code;
  }), JSON.stringify(report.violations, null, 2));
}

async function main() {
  var ir = fixtureSourceIr();
  assert.strictEqual(ir.entities.some(function(entity) { return entity.id === 'CtaButton'; }), false);
  assert.strictEqual(ir.hud.cta.ctaId, 'CtaButton');
  assert.strictEqual(ir.hud.cta.entity, undefined);
  var staticReport = analyzeSourceIrPhaseLiveness(ir, {});
  assert.strictEqual(staticReport.passed, true, JSON.stringify(staticReport.violations, null, 2));
  assert.strictEqual(staticReport.summary.checkedPhases, 3);
  assert.deepStrictEqual(staticReport.phases.map(function(phase) { return phase.id; }), ['phase1', 'phase2', 'phase3']);

  var missingPlayer = clone(ir);
  missingPlayer.phases[1].showEntities = ['Pump'];
  assertStaticViolation(missingPlayer, 'source_ir_phase_player_not_visible');

  var hudTarget = clone(ir);
  hudTarget.phases[0].steps = [{ kind: 'move_to', target: 'GoldUI', radius: 1.2 }];
  hudTarget.phases[0].gate = { kind: 'near_entity', entity: 'GoldUI', radius: 1.2 };
  assertStaticViolation(hudTarget, 'source_ir_phase_target_hud_only');

  var sharedConsecutiveTarget = clone(ir);
  sharedConsecutiveTarget.phases[1].showEntities = ['Player', 'WaterDrop'];
  sharedConsecutiveTarget.phases[1].steps = [{ kind: 'move_to', target: 'WaterDrop', radius: 1.2 }];
  sharedConsecutiveTarget.phases[1].gate = { kind: 'near_entity', entity: 'WaterDrop', radius: 1.2 };
  assertStaticViolation(sharedConsecutiveTarget, 'source_ir_consecutive_phase_target_shared');

  var unsatisfiedResource = clone(ir);
  unsatisfiedResource.phases[0].steps = [{ kind: 'move_to', target: 'WaterDrop', radius: 1.2 }];
  assertStaticViolation(unsatisfiedResource, 'source_ir_gate_resource_unsatisfied');

  var hiddenCollectCarrier = clone(ir);
  hiddenCollectCarrier.phases[0].showEntities = ['Player'];
  hiddenCollectCarrier.phases[0].steps = [{ kind: 'collect', resource: 'Water', amount: 1 }];
  assertStaticViolation(hiddenCollectCarrier, 'source_ir_collect_carrier_not_visible');

  var wrongCollectCarrier = clone(ir);
  wrongCollectCarrier.phases[0].steps = [{ kind: 'collect', resource: 'Water', from: 'Pump', amount: 1 }];
  assertStaticViolation(wrongCollectCarrier, 'source_ir_collect_carrier_mismatch');

  var unsatisfiedState = clone(ir);
  unsatisfiedState.phases[1].steps[1].state = 1;
  assertStaticViolation(unsatisfiedState, 'source_ir_gate_entity_state_unsatisfied');

  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-ir-phase-liveness-'));
  var htmlPath = path.join(tmp, 'preview.html');
  fs.writeFileSync(htmlPath, buildSourceIrPreviewHtml(ir, {
    html: '<div id="joystick"></div>',
    includeThree: false,
    generatedAt: '2026-06-07T00:00:00.000Z',
  }));
  var browserReport = await evaluateSourceIrPhaseLiveness(htmlPath, {
    maxTicks: 420,
    settleMs: 80,
    generatedAt: '2026-06-07T00:00:00.000Z',
  });
  assert.strictEqual(browserReport.passed, true, JSON.stringify(browserReport.violations, null, 2));
  assert.strictEqual(browserReport.summary.staticPassed, true);
  assert.strictEqual(browserReport.summary.browserProbePassed, true);
  assert.strictEqual(browserReport.summary.browserProbeSkipped, false);
  assert.deepStrictEqual(browserReport.summary.completedPhases, ['phase1', 'phase2', 'phase3']);
  assert.ok(browserReport.browser.samples.length >= 3);

  var gateAfterStepIr = normalizeSourceSceneIr({
    schemaVersion: SOURCE_SCENE_IR_SCHEMA_VERSION,
    kind: 'blueprint.sourceSceneIR',
    project: { name: 'source-ir-gate-after-step-fixture', theme: 'default' },
    scene: { camera: { fov: 55, position: [0, 8, 12], lookAt: [0, 0, 0] } },
    entities: [
      { id: 'Player', label: 'Player', kind: 'player', position: [0, 0, 0], visual: { primitive: 'capsule', color: '#66ccff' } },
      { id: 'Pile', label: 'Pile', kind: 'resource', position: [3, 0, 0], visual: { primitive: 'box', color: '#ffcc33' } },
      { id: 'Pump', label: 'Pump', kind: 'station', position: [6, 0, 0], visual: { primitive: 'box', color: '#ffaa33' } },
      { id: 'CtaButton', label: 'Install', kind: 'cta', position: [9, 0, 0], visual: { primitive: 'box', color: '#22cc88' } },
    ],
    resources: [{ id: 'Gold', label: 'Gold', carrierEntity: 'Pile', kind: 'resource', initial: 0 }],
    phases: [
      {
        id: 'phase1',
        title: 'Collect then return',
        showEntities: ['Player', 'Pile', 'Pump'],
        steps: [{ kind: 'collect', resource: 'Gold', amount: 1, from: 'Pile' }],
        gate: { kind: 'near_entity', entity: 'Pump', radius: 1.2 },
      },
      {
        id: 'phase2',
        title: 'Install',
        showEntities: ['Player', 'CtaButton'],
        steps: [{ kind: 'cta_finish', entity: 'CtaButton' }],
        gate: { kind: 'cta_arrival', entity: 'CtaButton', radius: 1.8 },
      },
    ],
    runtimeContract: { requiresJoystick: true, requiresArrivalGate: true, forbidAutoplayProgress: true },
  }, {
    html: '<div id="joystick"></div>',
    generatedAt: '2026-06-07T00:00:00.000Z',
  });
  var gateAfterStepHtmlPath = path.join(tmp, 'gate-after-step-preview.html');
  fs.writeFileSync(gateAfterStepHtmlPath, buildSourceIrPreviewHtml(gateAfterStepIr, {
    html: '<div id="joystick"></div>',
    includeThree: false,
    generatedAt: '2026-06-07T00:00:00.000Z',
  }));
  var gateAfterStepReport = await evaluateSourceIrPhaseLiveness(gateAfterStepHtmlPath, {
    maxTicks: 420,
    settleMs: 80,
    generatedAt: '2026-06-07T00:00:00.000Z',
  });
  assert.strictEqual(gateAfterStepReport.passed, true, JSON.stringify(gateAfterStepReport.violations, null, 2));
  assert.deepStrictEqual(gateAfterStepReport.summary.completedPhases, ['phase1', 'phase2']);

  console.log('source IR phase liveness tests passed');
}

main().catch(function(error) {
  console.error(error && error.stack || error);
  process.exit(1);
});
