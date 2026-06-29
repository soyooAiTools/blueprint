'use strict';

var assert = require('assert');
var htmlBridge = require('../engine/storyboard-html-bridge.cjs');
var storyboardSourceIrCompiler = require('../engine/storyboard-source-ir-compiler.cjs');
var {
  analyzeSourceIrPhaseLiveness,
} = require('../engine/source-ir-phase-liveness.cjs');

var storyboard = {
  projectName: '太空捡垃圾HTML',
  phases: [
    {
      title: '拾取垃圾换得美金',
      sceneText: '玩家在太空回收站外拾取垃圾碎片。',
      playerAction: '引导玩家靠近垃圾并收集。',
      feedback: '垃圾碎片飞入背包，金币增加。',
      uiText: '跟随箭头拾取垃圾',
      canonicalInteraction: 'collect:Garbage:1',
      primaryTarget: 'GarbagePile',
    },
    {
      title: '建造锻造间',
      sceneText: '玩家回到基地建造锻造间。',
      playerAction: '引导玩家靠近建造点。',
      feedback: '锻造间从地贴变成完成状态。',
      uiText: '建造锻造间',
      canonicalInteraction: 'build:ForgeRoom',
      primaryTarget: 'ForgeRoom',
    },
    {
      title: 'CTA收口',
      sceneText: '展示完整空间站和下载按钮。',
      playerAction: '引导玩家到达下载按钮。',
      feedback: '出现下载提示。',
      uiText: '立即下载',
      canonicalInteraction: 'click:CtaButton',
      primaryTarget: 'CtaButton',
    },
  ],
};

var blueprint = htmlBridge.buildBlueprintFromStoryboardAi(storyboard, {
  projectName: '太空捡垃圾HTML',
});

assert.strictEqual(blueprint.projectName, '太空捡垃圾HTML');
assert.strictEqual(blueprint.specs.length, 3);
assert.ok(blueprint.entities.some(function(entity) { return entity.name === 'Player' && entity.kind === 'player'; }));
assert.ok(blueprint.entities.some(function(entity) { return entity.name === 'Garbage_Pile' && entity.kind === 'resource'; }));
assert.ok(blueprint.entities.some(function(entity) { return entity.name === 'Forge_Room' && entity.kind === 'facility'; }));
assert.ok(blueprint.entities.some(function(entity) { return entity.name === 'CtaButton' && entity.kind === 'cta'; }));
assert.deepStrictEqual(blueprint.specs[0].requiredInteractions, ['collect:Garbage:1']);
assert.strictEqual(blueprint.specs[0].trigger.type, 'resource_collected');
assert.ok(blueprint.specs[0].plannedModuleIds.indexOf('player_input_joystick') >= 0);
assert.ok(blueprint.specs[0].plannedModuleIds.indexOf('collect_on_near') >= 0);
assert.strictEqual(blueprint.specs[1].trigger.type, 'entity_state_reached');
assert.strictEqual(blueprint.specs[1].trigger.state, 2);
assert.strictEqual(blueprint.specs[2].trigger.type, 'near_entity');
assert.strictEqual(blueprint.specs[2].trigger.entity, 'CtaButton');
assert.ok(blueprint.specs[2].plannedModuleIds.indexOf('cta_finish') >= 0);

var bundle = htmlBridge.buildStoryboard2HtmlInputFromStoryboardAi(storyboard, {
  projectName: '太空捡垃圾HTML',
  htmlPath: '/tmp/storyboard-html-bridge/generated.html',
  outDir: '/tmp/storyboard-html-bridge',
});

assert.strictEqual(bundle.kind, 'blueprint.storyboard2html.input');
assert.strictEqual(bundle.projectName, '太空捡垃圾HTML');
assert.strictEqual(bundle.specs.length, 3);
assert.ok(bundle.entities.some(function(entity) { return entity.name === 'Garbage_Pile' && entity.kind === 'resource'; }));
assert.ok(bundle.acceptancePlan.artifacts.sourceSceneIrPreflightReport.indexOf('source-ir-report.json') >= 0);

var strictStoryboard = {
  projectName: '太空捡垃圾HTML',
  phases: [
    {
      title: '拾取垃圾换得美金',
      sceneText: '玩家靠近太空垃圾堆，拾取金属碎片后送到回收站。',
      playerAction: '拾取碎片，送回回收站换钱。',
      requiredInteractions: ['collect:MetalScrap:1', 'deliver:MetalScrap:RecycleStation:1', 'reward:Cash:5'],
      primaryTarget: 'RecycleStation',
    },
    {
      title: '建造锻造间',
      sceneText: '玩家消耗美金建造锻造间。',
      playerAction: '投入美金并建造锻造间。',
      requiredInteractions: ['transfer:Cash:ForgeRoom:5', 'build:ForgeRoom'],
      primaryTarget: 'ForgeRoom',
    },
    {
      title: 'CTA收口',
      sceneText: '展示下载按钮。',
      playerAction: '到达下载按钮。',
      requiredInteractions: ['click:CtaButton'],
      primaryTarget: 'CtaButton',
    },
  ],
};

var strictBlueprint = htmlBridge.buildBlueprintFromStoryboardAi(strictStoryboard, {
  projectName: '太空捡垃圾HTML',
});
assert.deepStrictEqual(strictBlueprint.specs[0].requiredInteractions, [
  'collect:MetalScrap:1',
  'deliver:MetalScrap:RecycleStation:1',
  'reward:Cash:5',
]);
assert.ok(strictBlueprint.resources.some(function(resource) {
  return resource.name === 'MetalScrap' && resource.carrierEntity === 'ScrapPile';
}));
assert.ok(strictBlueprint.resources.some(function(resource) {
  return resource.name === 'Cash' && resource.carrierEntity === 'CashCounter';
}));
assert.ok(strictBlueprint.entities.some(function(entity) {
  return entity.name === 'RecycleStation' && entity.label === '回收站';
}));
assert.ok(strictBlueprint.specs[0].plannedModuleIds.indexOf('deliver_to_target') >= 0);
assert.strictEqual(strictBlueprint.specs[0].trigger.type, 'resource_collected');
assert.strictEqual(strictBlueprint.specs[0].trigger.resource, 'Cash');

var strictSourceIr = storyboardSourceIrCompiler.compileSourceSceneIrFromStoryboard(strictBlueprint, {
  sourceHtmlPath: '/tmp/storyboard-html-bridge/strict.html',
});
assert.ok(strictSourceIr.phases[0].steps.some(function(step) {
  return step.kind === 'collect' && step.resource === 'MetalScrap' && step.from === 'ScrapPile';
}));
assert.ok(strictSourceIr.phases[0].steps.some(function(step) {
  return step.kind === 'deliver' && step.resource === 'MetalScrap' && step.target === 'RecycleStation';
}));
assert.ok(strictSourceIr.phases[0].steps.some(function(step) {
  return step.kind === 'reward' && step.resource === 'Cash' && step.amount === 5;
}));
assert.deepStrictEqual(strictSourceIr.phases[0].gate, { kind: 'resource', resource: 'Cash', threshold: 5 });
assert.strictEqual(strictSourceIr.phases[1].steps.filter(function(step) {
  return step.kind === 'move_to' && step.target === 'ForgeRoom';
}).length, 1);
assert.ok(strictSourceIr.phases[1].steps.some(function(step) {
  return step.kind === 'transfer' && step.target === 'ForgeRoom';
}));
assert.ok(strictSourceIr.phases[1].steps.some(function(step) {
  return step.kind === 'build' && step.entity === 'ForgeRoom';
}));
assert.strictEqual(analyzeSourceIrPhaseLiveness(strictSourceIr, {}).passed, true);

console.log('storyboard html bridge tests passed');
