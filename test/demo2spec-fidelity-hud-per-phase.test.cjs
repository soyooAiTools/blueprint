#!/usr/bin/env node
'use strict';

var assert = require('assert');

var visualAssets = require('../adapters/demo2spec/visual-assets.js');
var demo2specFidelity = require('../adapters/demo2spec/fidelity-contract.js');
var fidelity = require('../engine/fidelity-contract.cjs');

function sampleContract() {
  return {
    schemaVersion: '1.1.0',
    kind: 'blueprint.fidelityContract',
    producerVersion: 'test',
    requiredCapabilities: demo2specFidelity.supportedCapabilitiesFor('html'),
    coordinateSystem: { source: 'three-rh', target: 'unity-lh', handedness: 'source-rh-target-lh', zFlip: true, unitScale: 1 },
    rendererAdapter: { three: { shader: {}, animator: {}, physics: {}, audio: {}, ui: {} }, unity: { shader: {}, animator: {}, physics: {}, audio: {}, ui: {} } },
    entities: [],
    phases: [
      { id: 'phase1', showEntities: [], trigger: {}, interactionGate: {}, autoPlayGate: {}, manualGate: {} },
      { id: 'phase2', showEntities: [], trigger: {}, interactionGate: {}, autoPlayGate: {}, manualGate: {} },
    ],
    hud: [
      { id: 'hud.phase', text: 'Phase 1/2', anchor: {}, consumer: ['hud-overlay'], provenance: { source: 'unity', confidence: 1 } },
      { id: 'hud.targethint', text: '目标：氧气购买台', anchor: {}, consumer: ['hud-overlay'], provenance: { source: 'unity', confidence: 1 } },
      { id: 'hud.tip', text: '买氧气', anchor: {}, consumer: ['hud-overlay'], provenance: { source: 'unity', confidence: 1 } },
      { id: 'hud.coin', text: '金币 0', anchor: {}, consumer: ['hud-overlay'], provenance: { source: 'unity', confidence: 1 } },
    ],
    unityCoverage: { status: 'missing' },
    unresolvedFidelityGaps: [],
    contractConflicts: [],
  };
}

var sourceHtml = [
  '<script>',
  'const ENTITY_STYLE = {',
  '  OxygenShop: { label: "氧气购买台", kind: "station" },',
  '  IceSmall: { label: "小冰块", kind: "crystal" }',
  '};',
  'const PHASES = [',
  '  {id:"phase1", guideText:"买氧气", steps:[{target:"OxygenShop", label:"购买氧气"}]},',
  '  {id:"phase2", guideText:"采冰块", steps:[{target:"IceSmall", label:"镐子凿冰"}]}',
  '];',
  '<div id="joystick"><div id="joystick-knob"></div></div>',
  '</script>',
].join('\n');

var manifest = visualAssets.extractVisualAssetManifest(sourceHtml, { source: 'inline-fixture.html' });
assert.strictEqual(manifest.sourcePhaseContract.phaseCount, 2);
assert.deepStrictEqual(manifest.sourcePhaseContract.phases.map(function (phase) {
  return phase.hudText;
}), [
  { phase: 'Phase 1/2', targethint: '目标：氧气购买台', tip: '买氧气', targetEntity: 'OxygenShop', targetLabel: '氧气购买台' },
  { phase: 'Phase 2/2', targethint: '目标：小冰块', tip: '采冰块', targetEntity: 'IceSmall', targetLabel: '小冰块' },
]);
assert.deepStrictEqual(manifest.sourceEntityContract.uiOverlayContract.entities.map(function (entry) {
  return { id: entry.id, role: entry.role };
}), [
  { id: 'Canvas', role: 'ui-canvas' },
  { id: 'JoystickBG', role: 'joystick-background' },
  { id: 'JoystickHandle', role: 'joystick-handle' },
]);

var result = demo2specFidelity.applySourceHudPerPhase(sampleContract(), manifest, { includeSummary: true });
assert.deepStrictEqual(result.summary.updated.map(function (item) { return item.id; }), ['hud.phase', 'hud.targethint', 'hud.tip']);

var hudById = {};
result.contract.hud.forEach(function (entry) { hudById[entry.id] = entry; });
assert.deepStrictEqual(hudById['hud.phase'].text, { perPhase: { phase1: 'Phase 1/2', phase2: 'Phase 2/2' } });
assert.deepStrictEqual(hudById['hud.targethint'].text, { perPhase: { phase1: '目标：氧气购买台', phase2: '目标：小冰块' } });
assert.deepStrictEqual(hudById['hud.tip'].text, { perPhase: { phase1: '买氧气', phase2: '采冰块' } });
assert.strictEqual(hudById['hud.coin'].text, '金币 0');

var validation = fidelity.validateFidelityContract(result.contract);
assert.strictEqual(validation.valid, true, validation.errors.join('\n'));

var overlayResult = demo2specFidelity.applySourceUiOverlayContract(sampleContract(), {
  sourceEntityContract: {
    uiOverlayContract: {
      present: true,
      entities: [{ id: 'Canvas', role: 'ui-canvas' }, { id: 'JoystickBG', role: 'joystick-background' }],
    },
  },
}, { includeSummary: true });
assert.deepStrictEqual(overlayResult.summary.entities, [
  { id: 'Canvas', role: 'ui-canvas' },
  { id: 'JoystickBG', role: 'joystick-background' },
]);
assert.deepStrictEqual(overlayResult.contract.sourceEntityContract.uiOverlayContract.entities, [
  { id: 'Canvas', role: 'ui-canvas' },
  { id: 'JoystickBG', role: 'joystick-background' },
]);

console.log('demo2spec fidelity HUD perPhase tests passed');
