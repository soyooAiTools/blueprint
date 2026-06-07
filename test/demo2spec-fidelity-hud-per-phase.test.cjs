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

var harvestDamageHtml = [
  '<script>',
  'const ENTITY_STYLE = {',
  '  IceBlock: { label: "冰晶", kind: "ice" },',
  '  EnemyAstronaut: { label: "敌方宇航员", kind: "enemy" }',
  '};',
  'const PHASES = [',
  '  {id:"phase1", guideText:"靠近冰晶，电锯会自动切割", steps:[{target:"IceBlock", label:"切割冰晶", damage:true}, {target:"IceBlock", label:"拾取冰晶", gain:"Ice", amount:1}]},',
  '  {id:"phase2", guideText:"击败来犯敌人", steps:[{target:"EnemyAstronaut", label:"击败敌人", damage:true}]}',
  '];',
  '</script>',
].join('\n');
var harvestDamageManifest = visualAssets.extractVisualAssetManifest(harvestDamageHtml, { source: 'harvest-damage.html' });
assert.strictEqual(harvestDamageManifest.sourcePhaseContract.phases[0].steps[0].damage, false);
assert.strictEqual(harvestDamageManifest.sourcePhaseContract.phases[0].diagnostics[0].code, 'harvest_damage_step_normalized');
assert.strictEqual(harvestDamageManifest.sourcePhaseContract.phases[1].steps[0].damage, true);

var triggerOnlyHtml = [
  '<script>',
  'const ENTITY_STYLE = {',
  '  PlayerCharacter: { label: "玩家角色", kind: "astronaut" },',
  '  ResourceCube: { label: "资源方块", kind: "collectible" },',
  '  BallistaBuildSpot1: { label: "弩炮建造位1", kind: "pad" },',
  '  CTAButton: { label: "下载按钮", kind: "beacon" }',
  '};',
  'const PHASES = [',
  '  {id:"phase1", guideText:"采集资源", showEntities:["PlayerCharacter","ResourceCube"], trigger:{type:"resource_collected", resource:"Wood", amount:1}},',
  '  {id:"phase2", guideText:"建造弩炮", showEntities:["PlayerCharacter","BallistaBuildSpot1"], trigger:{type:"entity_state_reached", entity:"BallistaBuildSpot1", state:2}},',
  '  {id:"phase3", guideText:"下载", showEntities:["PlayerCharacter","CTAButton"], trigger:{type:"near_entity", entity:"CTAButton", distance:3.5}}',
  '];',
  '</script>',
].join('\n');
var triggerManifest = visualAssets.extractVisualAssetManifest(triggerOnlyHtml, { source: 'trigger-only.html' });
assert.deepStrictEqual(triggerManifest.sourcePhaseContract.phases.map(function (phase) {
  return {
    id: phase.id,
    trigger: phase.trigger && phase.trigger.type,
    target: phase.steps[0] && phase.steps[0].target,
    label: phase.hudText.targetLabel,
  };
}), [
  { id: 'phase1', trigger: 'resource_collected', target: 'ResourceCube', label: '资源方块' },
  { id: 'phase2', trigger: 'entity_state_reached', target: 'BallistaBuildSpot1', label: '弩炮建造位1' },
  { id: 'phase3', trigger: 'near_entity', target: 'CTAButton', label: '下载按钮' },
]);

var plannedCollectHtml = [
  '<script>',
  'const ENTITY_STYLE = {',
  '  OurAstronaut: { label: "我方宇航员", kind: "astronaut" },',
  '  EnemyRocket: { label: "敌方小火箭", kind: "debris" },',
  '  RocketDebris: { label: "火箭残骸", kind: "collectible" },',
  '  Recycler: { label: "回收机", kind: "machine" }',
  '};',
  'const PHASES = [',
  '  {id:"phase1", guideText:"击败敌方火箭收集残骸送回收机", showEntities:["OurAstronaut","EnemyRocket","RocketDebris","Recycler"], plannedModuleIds:["collect_on_near","guide_ui"], trigger:{type:"near_entity", entity:"Recycler"}}',
  '];',
  '</script>',
].join('\n');
var plannedCollectManifest = visualAssets.extractVisualAssetManifest(plannedCollectHtml, { source: 'planned-collect.html' });
assert.deepStrictEqual(plannedCollectManifest.sourcePhaseContract.phases[0].steps, [
  { index: 0, target: 'RocketDebris', label: '火箭残骸', gain: 'Scrap', amount: 1 },
  { index: 1, target: 'Recycler', label: '回收机' },
]);
assert.strictEqual(plannedCollectManifest.sourcePhaseContract.phases[0].hudText.targetEntity, 'RocketDebris');

var runtimeTargetHtml = [
  '<script>',
  'const ENTITY_STYLE = {',
  '  OurBaseGate: { label: "基地大门", kind: "gate" },',
  '  EnemyRocket: { label: "敌方小火箭", kind: "debris" },',
  '  RocketDebris: { label: "火箭残骸", kind: "collectible" },',
  '  Recycler: { label: "回收机", kind: "machine" },',
  '  Gold: { label: "金币", kind: "collectible" },',
  '  DefenseTower: { label: "防御塔", kind: "beacon" }',
  '};',
  'const PHASES = [',
  '  {id:"phase1", guideText:"移动到基地大门升级，再击败敌方火箭收集残骸送回收机", showEntities:["OurBaseGate","EnemyRocket","RocketDebris","Recycler"], plannedModuleIds:["collect_on_near"], trigger:{type:"near_entity", entity:"Recycler"}},',
  '  {id:"phase2", guideText:"移动到金币处收集，再走到防御塔部署宇航员", showEntities:["Gold","DefenseTower"], plannedModuleIds:["collect_on_near"], trigger:{type:"near_entity", entity:"DefenseTower"}}',
  '];',
  'function enterPhase1(){ setTarget("OurBaseGate"); }',
  'function enterPhase2(){ setTarget("Gold"); }',
  'function animate(){',
  '  if(phaseIndex===0){ if(step===0){ setTarget("OurBaseGate"); } else if(step===1){ setTarget("EnemyRocket"); } else if(step===2){ setTarget("RocketDebris"); } else if(step===3){ setTarget("Recycler"); } }',
  '  if(phaseIndex===1){ if(step===0){ setTarget("Gold"); } else if(step===1){ setTarget("DefenseTower"); } }',
  '}',
  '</script>',
].join('\n');
var runtimeTargetManifest = visualAssets.extractVisualAssetManifest(runtimeTargetHtml, { source: 'runtime-target.html' });
assert.deepStrictEqual(runtimeTargetManifest.sourcePhaseContract.phases[0].targetSequence, ['OurBaseGate', 'EnemyRocket', 'RocketDebris', 'Recycler']);
assert.strictEqual(runtimeTargetManifest.sourcePhaseContract.phases[0].stepSource, 'runtime_setTarget');
assert.strictEqual(runtimeTargetManifest.sourcePhaseContract.phases[0].steps[1].damage, true);
assert.strictEqual(runtimeTargetManifest.sourcePhaseContract.phases[0].steps[2].gain, 'Scrap');
assert.deepStrictEqual(runtimeTargetManifest.sourcePhaseContract.phases[1].targetSequence, ['Gold', 'DefenseTower']);
assert.strictEqual(runtimeTargetManifest.sourceEntityContract.worldLabelContract.present, false);

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
