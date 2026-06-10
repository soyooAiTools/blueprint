'use strict';

var assert = require('assert');
var htmlBridge = require('../engine/storyboard-html-bridge.cjs');

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

console.log('storyboard html bridge tests passed');
