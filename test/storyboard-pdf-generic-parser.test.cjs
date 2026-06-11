#!/usr/bin/env node
'use strict';

var assert = require('assert');

var pdfSamples = require('../scripts/process-storyboard-pdf-samples.cjs');
var storyboardIr = require('../engine/storyboard-ir.cjs');
var storyboardSpecCompiler = require('../engine/storyboard-spec-compiler.cjs');
var storyboardSourceIrCompiler = require('../engine/storyboard-source-ir-compiler.cjs');

var internals = pdfSamples._internals;

var phaseText = [
  '取木射箭',
  '需求描述',
  'Phas',
  'e1:',
  '开局森林基地 + 解锁传送带',
  '玩家看到什么：森林营地，木围栏，有两条道通向基地。',
  '玩家做什么：投入金币，去修建传送带，不断获得木头。',
  '镜头：跟随玩家，俯视角。',
  '大约耗时：2-3秒',
  '',
  'Phas',
  'e2:',
  '出敌人+收集木头+弩炮射击',
  '玩家看到什么：沿路前进的红色士兵，一条引导线引玩家去弩炮附近。',
  '玩家做什么：移动到弩炮附近，交付木头，弩炮自动开火。',
  '感觉：简单明确的搬运循环。',
  '',
  'Phas',
  'e10:',
  '结束页面 过场动画',
  '玩家看到什么：基地范围扩大，建筑样式升级。',
  '玩家做什么：无操作，纯欣赏。',
].join('\n');

var frames = internals.parseGenericFrames(phaseText, '取木射箭');
assert.strictEqual(frames.length, 3);
assert.deepStrictEqual(frames.map(function(frame) { return frame.chapter; }), [1, 2, 10]);
assert.strictEqual(frames[0].parser, 'phase-marker');
assert.ok(frames[0].title.indexOf('开局森林基地') >= 0);
assert.ok(/^(collect|move_to|transfer|unlock):/.test(frames[1].interaction));
assert.strictEqual(frames[2].interaction, 'click:CtaButton');

assert.strictEqual(
  internals.inferInteraction('镜头推近，修建木屋。第一座木屋建完，旁边出现招募工人地贴。', '取木射箭 3'),
  'unlock:Target'
);
assert.strictEqual(
  internals.inferInteraction('展示助手技能 助手进度条满会释放技能', '太空救星'),
  'show:Target'
);
assert.strictEqual(
  internals.inferInteraction('选择助手角色 只剩一个角色', '太空救星'),
  'select:Item'
);
assert.strictEqual(
  internals.inferInteraction('把物品放入容器，再提交给目标。', '通用交付'),
  'transfer:Item:Target:1'
);
assert.strictEqual(
  internals.inferInteraction('售卖完成订单，获得奖励。', '通用完成'),
  'deliver:Item:Consumer:1'
);

var forestProfile = internals.inferSampleProfile('取木射箭', phaseText, phaseText.length);
assert.strictEqual(forestProfile.kind, 'generic');
assert.strictEqual(forestProfile.parser, 'phase-marker');
assert.ok(forestProfile.actionScores.transfer > 0 || forestProfile.actionScores.unlock > 0);

var ramenWithCornProfile = internals.inferSampleProfile('MC原创_3D流水线拉面', [
  '核心流程（全自动面条 + 手动配菜）',
  '面团自动流水线：上排传送带不断送来面团，小人自动表演抻面动画，面条飞入煮锅。',
  '配菜传送带：下排传送带持续送来叉烧、海苔、葱花、溏心蛋、玉米粒等。',
  '玩家点击订单所需配菜，点错会出现红叉并扣除倒计时。',
].join('\n'), 160);
assert.strictEqual(ramenWithCornProfile.kind, 'generic');
assert.strictEqual(ramenWithCornProfile.contentScores.guard, undefined);
assert.strictEqual(ramenWithCornProfile.contentScores.burger_merge, undefined);
assert.ok(ramenWithCornProfile.actionScores.select > 0);
assert.ok(ramenWithCornProfile.actionScores.wait > 0);
var ramenLabels = internals.entitiesForKind('generic', [
  '核心流程（全自动面条 + 手动配菜）',
  '配菜传送带持续送来叉烧、海苔、葱花、溏心蛋、玉米粒。',
  '玩家点击订单所需配菜。',
].join('\n')).reduce(function(out, entity) {
  out[entity.name] = entity.label;
  return out;
}, {});
assert.strictEqual(ramenLabels.Player, '玩家');
assert.strictEqual(ramenLabels.Item, '配菜');
assert.notStrictEqual(ramenLabels.Player, 'Actor');
assert.notStrictEqual(ramenLabels.Item, 'Item');

var dessertLabels = internals.entitiesForKind('generic', [
  '甜品餐厅物品二合试玩',
  '画面整体呈现：多巴胺甜品餐厅。',
  '升级链设计：咖啡豆、可颂、水果舒芙蕾等合成链。',
].join('\n')).reduce(function(out, entity) {
  out[entity.name] = entity.label;
  return out;
}, {});
assert.strictEqual(dessertLabels.Item, '甜品');
assert.strictEqual(dessertLabels.Target, '餐厅');
assert.strictEqual(dessertLabels.UpgradePoint, '合成链');

var nounOnlyProfile = internals.inferSampleProfile('名词堆叠需求', [
  '玉米 爆米花 异形 英雄塔 孢子 飞船舱室',
  '画面包含冰块、玉米粒、爆米花机器。',
].join('\n'), 80);
assert.strictEqual(nounOnlyProfile.kind, 'generic');
assert.deepStrictEqual(nounOnlyProfile.actionIds, []);

var combineProduceProfile = internals.inferSampleProfile('Nova_GDD_挂机合成_汉堡店', [
  '核心玩法：玩家拖拽两个制作台进行合成，购买新的收银台。',
  '店员生产汉堡，顾客排队，玩家取走金币并升级装修店铺。',
  '后续解锁更多制作台和收银台。',
].join('\n'), 160);
assert.strictEqual(combineProduceProfile.kind, 'generic');
assert.strictEqual(combineProduceProfile.parser, 'generic');
assert.ok(combineProduceProfile.actionScores.combine > 0);
assert.ok(combineProduceProfile.actionScores.produce > 0);
assert.ok(combineProduceProfile.actionScores.unlock > 0);
assert.strictEqual(combineProduceProfile.contentScores.burger_merge, undefined);

assert.strictEqual(typeof internals.guardContentFallbackAllowed, 'undefined');
assert.strictEqual(typeof internals.parseBurgerMergeFrames, 'undefined');
assert.strictEqual(typeof internals.parseShelterWarmthFrames, 'undefined');
assert.strictEqual(typeof internals.inferTargetId, 'undefined');

var numberedText = [
  '太空救星',
  '需求描述',
  '序号                    文字描述                    画面',
  '开局主角在一个休眠仓中苏醒，出门后来到主空间。',
  '1',
  '周围怪物围拢过来，主角击杀怪物。',
  '2',
  '引导线引导玩家到第一个休眠舱，金币自动填充 UI。',
  '3 选择助手角色',
  '4 展示助手技能',
  '5 镜头拉开，随后自动跟随玩家打怪。',
  '6 引导线引导玩家到第二个休眠舱，解锁第二个助手。',
  '7 选择助手角色，两个角色卡片随机出现。',
  '8 展示助手技能，助手进度条满会释放技能。',
  '9 镜头拉开，随后自动跟随玩家打怪。',
  '10 引导线引导玩家到第三个休眠舱，解锁第三个助手。',
  '11 选择助手角色，选择过的角色不会再出现。',
  '12 展示助手技能，助手进度条满会释放技能。',
  '13 镜头拉开，随后自动跟随玩家打怪。',
  '14 引导线引导玩家到第四个休眠舱，解锁第四个助手。',
  '15 选择助手角色，只剩一个角色。',
  '16 展示助手技能，助手进度条满会释放技能。',
  '17 展示战斗画面。',
  '18 清屏跳转。',
  '大底图设定',
].join('\n');

var numberedProfile = internals.inferSampleProfile('太空救星', numberedText, numberedText.length);
assert.strictEqual(numberedProfile.kind, 'generic');
assert.strictEqual(numberedProfile.parser, 'numbered-table');
assert.ok(numberedProfile.actionScores.unlock > 0);
assert.ok(numberedProfile.actionScores.select > 0);
var numberedFrames = internals.parseGenericFrames(numberedText, '太空救星');
assert.strictEqual(numberedFrames.length, 18);
assert.ok(numberedFrames[0].title.indexOf('序号') < 0);
var cappedNumbered = internals.capRuntimePhases(numberedFrames, { min: 10, max: 13 });
assert.strictEqual(cappedNumbered.frames.length, numberedFrames.length);
assert.ok(internals.runtimePhaseCount(cappedNumbered.frames) <= 13);
assert.ok(cappedNumbered.diagnostics.some(function(item) {
  return item.code === 'storyboard_pdf_runtime_phase_merge' && item.fromPhaseCount === 18;
}));

var compactFrames = [
  {
    id: 'compact-1',
    chapter: 1,
    title: '开局',
    scene: '玩家看到什么：场景出现起始目标。玩家做什么：先收集物品。玩家看到什么：目标需要填充。玩家做什么：把物品交付到目标。',
    interaction: 'collect:Item:1',
  },
  {
    id: 'compact-2',
    chapter: 2,
    title: '推进',
    scene: '玩家看到什么：新目标出现。玩家做什么：点击选择物品。玩家看到什么：进度提高。玩家做什么：继续升级目标。',
    interaction: 'upgrade:UpgradePoint:2',
  },
  {
    id: 'compact-3',
    chapter: 3,
    title: '收口',
    scene: '玩家看到什么：奖励出现。玩家做什么：获得奖励。结束页面：弹出游戏logo和CTA。',
    interaction: 'click:CtaButton',
  },
];
var expandedCompact = internals.capRuntimePhases(compactFrames, { min: 10, max: 13 });
assert.ok(internals.runtimePhaseCount(expandedCompact.frames) >= 10);
assert.ok(internals.runtimePhaseCount(expandedCompact.frames) <= 13);
assert.ok(expandedCompact.frames.length >= compactFrames.length);

var terminalTailFrames = [
  {
    id: 'terminal-tail-1',
    chapter: 1,
    title: '制作台合成',
    scene: '玩家拖拽两个制作台进行合成，解锁新的餐厅区域。',
    interaction: 'combine:Item:UpgradePoint:1',
  },
  {
    id: 'terminal-tail-2',
    chapter: 2,
    title: '成功跳转：最终 End Card 下载界面',
    scene: '点击按钮后进入下载界面。',
    interaction: 'click:CtaButton',
  },
  {
    id: 'terminal-tail-3',
    chapter: 3,
    title: 'Play / App Store',
    scene: '失败跳转前拉起应用商店，超时提示一直存在。',
    interaction: 'click:CtaButton',
  },
  {
    id: 'terminal-tail-4',
    chapter: 4,
    title: '绿色发光虚线路径',
    scene: '停下会亮起一条直通目标的绿色发光虚线路。',
    interaction: 'show:Target',
  },
];
var collapsedTerminalTail = internals.capRuntimePhases(terminalTailFrames, { min: 1, max: 13 });
assert.strictEqual(internals.runtimePhaseCount(collapsedTerminalTail.frames), 2);
assert.deepStrictEqual(collapsedTerminalTail.frames.map(function(frame) { return frame.chapter; }), [1, 2, 2, 2]);
assert.ok(collapsedTerminalTail.diagnostics.some(function(item) {
  return item.code === 'storyboard_pdf_terminal_cta_merge' && item.fromPhaseCount === 4 && item.toPhaseCount === 2;
}));

var ir = storyboardIr.normalizeStoryboardIr({
  projectName: '取木射箭',
  storyboardFrames: frames,
  entities: internals.entitiesForKind('generic'),
}, {
  projectName: '取木射箭',
  entities: internals.entitiesForKind('generic'),
});
var compiled = storyboardSpecCompiler.compileSpecsFromStoryboardIr(ir, {
  entities: internals.entitiesForKind('generic'),
  minActionCoverage: 0.35,
});
assert.strictEqual(compiled.ok, true);
assert.ok(!/^[A-Za-z_]+:/.test(compiled.specs[0].playerInstruction || ''));
assert.strictEqual(internals.storyboardQualityDiagnostics(compiled, 'generic').length, 0);

var sourceIr = storyboardSourceIrCompiler.compileSourceSceneIrFromStoryboard({
  projectName: 'generic action source',
  entities: internals.entitiesForKind('generic'),
  resources: internals.resourcesForKind('generic'),
  specs: compiled.specs,
  storyboardIr: ir,
});
assert.ok(sourceIr.phases.every(function(phase) {
  return phase.guideText && phase.guideText.length <= 58;
}), 'generated SourceIR guideText should be short enough for the HUD');
assert.ok(!sourceIr.phases.some(function(phase) {
  return /玩家看到什么|玩家做什么|玩法逻辑|Phase\s*\d|^[A-Za-z_]+:/.test(phase.guideText || '');
}), 'generated SourceIR guideText should be plain player guidance, not raw PDF text or interaction ids');
assert.ok(sourceIr.entities.some(function(entity) { return entity.id === 'Item'; }));
assert.ok(sourceIr.entities.some(function(entity) { return entity.id === 'Target'; }));
assert.ok(sourceIr.phases.some(function(phase) {
  return (phase.steps || []).some(function(step) { return step.kind === 'transfer' || step.kind === 'unlock'; });
}));

var weakCompiled = {
  specs: Array.from({ length: 22 }).map(function(_, index) {
    return { phaseId: 'phase' + (index + 1), requiredInteractions: [] };
  }),
  diagnostics: [{ code: 'storyboard_spec_phase_no_actions', severity: 'warning', phaseId: 'phase1' }],
};
var diagnostics = internals.storyboardQualityDiagnostics(weakCompiled, 'generic');
assert.ok(diagnostics.some(function(item) { return item.code === 'storyboard_pdf_low_quality_phase_split'; }));
assert.ok(diagnostics.some(function(item) { return item.code === 'storyboard_pdf_consecutive_timer_only_phases'; }));

console.log('storyboard PDF generic parser tests passed');
