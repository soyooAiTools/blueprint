#!/usr/bin/env node
'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var {
  SOURCE_SCENE_IR_SCHEMA_VERSION,
  normalizeSourceSceneIr,
} = require('../engine/source-scene-ir.cjs');
var {
  SOURCE_VISUAL_IR_SCHEMA_VERSION,
  SOURCE_VISUAL_IR_KIND,
  buildSourceVisualIrFromSourceSceneIr,
  collectSourceVisualIrViolations,
  computeSourceVisualIrHash,
  validateSourceVisualIr,
  writeSourceVisualIr,
} = require('../engine/source-visual-ir.cjs');

var sourceIr = normalizeSourceSceneIr({
  schemaVersion: SOURCE_SCENE_IR_SCHEMA_VERSION,
  kind: 'blueprint.sourceSceneIR',
  project: { name: 'source-visual-ir-fixture', theme: 'default' },
  scene: {
    backgroundColor: '#0a1020',
    camera: { fov: 55, position: [0, 8, 12], lookAt: [0, 0, 0] },
    ground: { kind: 'plane', size: [20, 20], color: '#203040' },
    guidance: { targetRing: { enabled: true, color: '#ffffff' } },
  },
  entities: [
    { id: 'Player', label: '玩家', kind: 'player', position: [0, 0, 0], visual: { primitive: 'capsule', color: '#66ccff' } },
    { id: 'WaterDrop', label: '水滴', kind: 'resource', position: [3, 0, 0], visual: { primitive: 'sphere', color: '#33aaff' } },
    { id: 'CtaButton', label: '下载', kind: 'cta', position: [6, 0, 0], visual: { primitive: 'box', color: '#22cc88' } },
  ],
  resources: [{ id: 'Water', label: '水', carrierEntity: 'WaterDrop', kind: 'resource', initial: 0 }],
  phases: [
    {
      id: 'phase1',
      title: '收集水滴',
      guideText: '拖摇杆收集水滴',
      showEntities: ['Player', 'WaterDrop'],
      targetSequence: ['WaterDrop'],
      steps: [{ kind: 'move_to', target: 'WaterDrop', radius: 1.2 }],
      gate: { kind: 'near_entity', entity: 'WaterDrop', radius: 1.2 },
    },
    {
      id: 'phase2',
      title: '下载',
      guideText: '到达按钮下载',
      showEntities: ['Player', 'CtaButton'],
      steps: [{ kind: 'cta_finish', entity: 'CtaButton' }],
      gate: { kind: 'cta_arrival', entity: 'CtaButton' },
    },
  ],
  hud: {
    tip: { source: 'phase.guideText' },
    resourceBar: ['Water'],
    cta: { entity: 'CtaButton', arrivalGated: true, title: '立即下载' },
    domHudContract: { initialText: { ctaButton: '安装完整游戏' } },
  },
  runtimeContract: { requiresJoystick: true, requiresArrivalGate: true, forbidAutoplayProgress: true },
}, {
  html: '<div id="joystick"></div>',
  generatedAt: '2026-06-07T00:00:00.000Z',
});

var visualIr = buildSourceVisualIrFromSourceSceneIr(sourceIr, {
  generatedAt: '2026-06-07T00:00:00.000Z',
});

assert.strictEqual(visualIr.schemaVersion, SOURCE_VISUAL_IR_SCHEMA_VERSION);
assert.strictEqual(visualIr.kind, SOURCE_VISUAL_IR_KIND);
assert.strictEqual(visualIr.source.sourceSceneIrHash, sourceIr.semanticHash);
assert.strictEqual(visualIr.visual.scene.backgroundColor, '#0a1020');
assert.strictEqual(visualIr.visual.entities[0].meshOps[0].kind, 'primitive');
assert.strictEqual(visualIr.visual.entities[1].material.color, '#33aaff');
assert.deepStrictEqual(visualIr.visual.phaseStates[0].visibleEntities, ['Player', 'WaterDrop']);
assert.strictEqual(visualIr.visual.phaseStates[0].guidance.primaryTarget, 'WaterDrop');
assert.strictEqual(visualIr.visual.phaseStates[1].ctaVisible, true);
assert.strictEqual(visualIr.visual.guidance.phaseTargets[0].primaryTarget, 'WaterDrop');
assert.strictEqual(visualIr.visual.cta.entity, 'CtaButton');
assert.strictEqual(visualIr.visual.cta.buttonText, '安装完整游戏');
assert.strictEqual(validateSourceVisualIr(visualIr, { sourceSceneIr: sourceIr }), true);
assert.strictEqual(computeSourceVisualIrHash(visualIr), visualIr.semanticHash);

var bad = JSON.parse(JSON.stringify(visualIr));
bad.visual.phaseStates[0].visibleEntities.push('MissingEntity');
assert.ok(collectSourceVisualIrViolations(bad).some(function(violation) {
  return violation.code === 'source_visual_ir_visible_entity_missing';
}));

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-visual-ir-'));
var outPath = path.join(tmp, 'source-visual-ir.json');
writeSourceVisualIr(outPath, visualIr);
assert.strictEqual(JSON.parse(fs.readFileSync(outPath, 'utf8')).semanticHash, visualIr.semanticHash);

console.log('source visual IR tests passed');
