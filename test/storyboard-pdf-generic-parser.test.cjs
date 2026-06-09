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
assert.ok(frames[0].scene.indexOf('玩家看到什么') >= 0);
assert.ok(frames[1].interaction.indexOf('collect:') >= 0 || frames[1].interaction.indexOf('move_to:') >= 0);
assert.strictEqual(frames[2].interaction, 'click:CtaButton');

assert.strictEqual(
  internals.inferInteraction('镜头推近，修建木屋。第一座木屋建完，旁边出现招募工人地贴。', '取木射箭 3'),
  'build:BaseCamp'
);
assert.strictEqual(
  internals.inferInteraction('展示助手技能 助手进度条满会释放技能', '太空救星'),
  'upgrade:SkillMeter:2'
);
assert.strictEqual(
  internals.inferInteraction('选择助手角色 只剩一个角色', '太空救星'),
  'click:RoleCard'
);
assert.strictEqual(
  internals.inferInteraction('解锁右侧炮塔和工人木屋地贴，花费资源建造。', '解锁右侧', { kind: 'forest_defense' }),
  'build:RightCrossbowTurret'
);
assert.strictEqual(
  internals.inferInteraction('巨大Boss跟在敌人的最后，搬运木头到弩炮打Boss', 'Boss来袭', { kind: 'forest_defense' }),
  'attack:BossEnemy'
);

var forestProfile = internals.inferSampleProfile('取木射箭', phaseText, phaseText.length);
assert.strictEqual(forestProfile.kind, 'forest_defense');
assert.strictEqual(forestProfile.parser, 'phase-marker');

var shelterProfile = internals.inferSampleProfile('搜屋取暖', [
  '搜屋取暖',
  'Phase1:',
  '开局：房间中间有一个熄灭的小火堆，周围是冻僵的人群，门口有木材。',
  'Phase2:',
  '玩家收集木材并修复火堆取暖。',
  'Phase3:',
  '玩家升级电塔，电线连接各个房间。',
].join('\n'), 120);
assert.strictEqual(shelterProfile.kind, 'shelter_warmth');
assert.strictEqual(shelterProfile.parser, 'phase-marker');

var shelterWarmthText = [
  '搜屋取暖',
  '玩家看到什么：冰雪场景，风雪吹灭篝火，中间有一个熄灭的小火堆。',
  '玩家做什么：无行动，先感受寒意。',
  '玩家看到什么：篝火需要点燃，能看到周围部分房间。',
  '玩家做什么：先捡木材然后指引玩家去点燃篝火。',
  '玩家看到什么：篝火点燃后变旺，几个角色解冻。玩家做什么：指引去右侧中间房间。',
  '玩家看到什么：右侧中间房间里有数量较多的丧尸，家具和发光显示的宝箱。',
  '玩家做什么：先破坏家具、获得宝箱，再出丧尸击杀。',
  '玩家看到什么：右下房间里也有丧尸，家具和发光显示的宝箱。',
  '玩家做什么：去右下角房间，破坏家具收集足够的木材，宝箱中有斧子。',
  '玩家看到什么：缴纳木材后篝火升级为电塔，地面温暖范围扩大。',
  '玩家做什么：收集足够后跟随指引回到篝火处，缴纳木材，升级篝火。',
  '玩家看到什么：升级后电塔上方再度出现气泡，需要木材和电池。',
  '左下房间获取钥匙，玩家击杀丧尸获得宝箱，宝箱里有钥匙。',
  '玩家看到什么：房间里的宝箱家具和丧尸。',
  '左上右上房间获取电池，玩家击杀丧尸获得宝箱，宝箱里有电池。',
  '玩家看到什么：电塔需要物资，玩家做什么：去电塔处缴纳电池和木材。',
  '玩家看到什么：全场景积雪融化，出现绿地树木，人们欢呼。',
  '结束页面：弹出游戏logo和CTA。',
].join('\n');
var shelterWarmthFrames = internals.enrichFramesWithVisibleEntities(internals.parseShelterWarmthFrames(shelterWarmthText), 'shelter_warmth');
assert.strictEqual(shelterWarmthFrames.length, 10);
assert.deepStrictEqual(shelterWarmthFrames.map(function(frame) { return frame.interaction; }), [
  'move_to:Campfire',
  'collect:Wood:1',
  'move_to:ShelterRoom',
  'attack:Enemy',
  'collect:Wood:1',
  'upgrade:PowerTower:2',
  'collect:Key:1',
  'collect:Battery:1',
  'upgrade:PowerTower:3',
  'click:CtaButton',
]);
var shelterWarmthIr = storyboardIr.normalizeStoryboardIr({
  projectName: 'shelter warmth profile',
  storyboardFrames: shelterWarmthFrames,
  entities: internals.entitiesForKind('shelter_warmth'),
}, {
  projectName: 'shelter warmth profile',
  entities: internals.entitiesForKind('shelter_warmth'),
});
var shelterWarmthSpecs = storyboardSpecCompiler.compileSpecsFromStoryboardIr(shelterWarmthIr, {
  entities: internals.entitiesForKind('shelter_warmth'),
});
var shelterWarmthSourceIr = storyboardSourceIrCompiler.compileSourceSceneIrFromStoryboard({
  projectName: 'shelter warmth profile',
  entities: internals.entitiesForKind('shelter_warmth'),
  resources: internals.resourcesForKind('shelter_warmth'),
  specs: shelterWarmthSpecs.specs,
  storyboardIr: shelterWarmthIr,
});
assert.deepStrictEqual(shelterWarmthSourceIr.phases.map(function(phase) {
  var step = (phase.steps || []).filter(function(item) { return item.target || item.entity || item.from || item.ctaId; })[0] || {};
  return step.target || step.entity || step.from || step.ctaId || '';
}), ['Campfire', 'WoodPile', 'ShelterRoom', 'Enemy', 'WoodPile', 'PowerTower', 'KeyItem', 'Battery', 'PowerTower', 'CtaButton']);

var forestVisible = internals.inferVisibleEntitiesForFrame({
  title: '建造传送带和弩炮',
  scene: '森林基地里有木材堆、传送带、弩炮和红色士兵，工人搬运木头。',
  interaction: 'build:Conveyor',
}, 'forest_defense');
assert.ok(forestVisible.indexOf('BaseCamp') >= 0);
assert.ok(forestVisible.indexOf('WoodPile') >= 0);
assert.ok(forestVisible.indexOf('CrossbowTurret') >= 0);
assert.ok(forestVisible.indexOf('Enemy') >= 0);

var disambiguatedForestFrames = internals.enrichFramesWithVisibleEntities([{
  title: '搬运木头，并送至自己所在一侧的弩炮处',
  scene: '镜头在基地左边。',
  interaction: 'build:CrossbowTurret',
}, {
  title: '解锁右侧（炮塔+木屋）地贴',
  scene: '右边建造，花费资源建造。',
  interaction: 'build:CrossbowTurret',
}, {
  title: '此时全部建筑修建完成',
  scene: '右侧开始刷新敌人，炮塔自动射击敌人。玩家做什么：招募右侧工人。',
  interaction: 'attack:Enemy',
}, {
  title: 'Boss来袭',
  scene: '巨大Boss跟在敌人的最后，头顶显示血条，搬运木头到弩炮打Boss。',
  interaction: 'attack:Enemy',
}], 'forest_defense');
assert.deepStrictEqual(disambiguatedForestFrames.map(function(frame) { return frame.interaction; }), [
  'build:LeftCrossbowTurret',
  'build:RightCrossbowTurret',
  'attack:RightEnemyWave',
  'attack:BossEnemy',
]);
assert.ok(disambiguatedForestFrames[1].visibleEntities.indexOf('RightWorkerHouse') >= 0);
assert.ok(disambiguatedForestFrames[3].visibleEntities.indexOf('BossEnemy') >= 0);
var disambiguatedForestIr = storyboardIr.normalizeStoryboardIr({
  projectName: 'forest disambiguation',
  storyboardFrames: disambiguatedForestFrames.map(function(frame, index) {
    return Object.assign({ chapter: index + 1 }, frame);
  }),
  entities: internals.entitiesForKind('forest_defense'),
}, {
  projectName: 'forest disambiguation',
  entities: internals.entitiesForKind('forest_defense'),
});
var disambiguatedForestSpecs = storyboardSpecCompiler.compileSpecsFromStoryboardIr(disambiguatedForestIr, {
  entities: internals.entitiesForKind('forest_defense'),
});
assert.deepStrictEqual(disambiguatedForestSpecs.specs.map(function(spec) { return spec.requiredInteractions[0]; }), [
  'build:LeftCrossbowTurret',
  'build:RightCrossbowTurret',
  'attack:RightEnemyWave',
  'attack:BossEnemy',
]);
var disambiguatedForestSourceIr = storyboardSourceIrCompiler.compileSourceSceneIrFromStoryboard({
  projectName: 'forest disambiguation',
  entities: internals.entitiesForKind('forest_defense'),
  specs: disambiguatedForestSpecs.specs,
  storyboardIr: disambiguatedForestIr,
});
assert.ok(disambiguatedForestSourceIr.entities.some(function(entity) { return entity.id === 'LeftCrossbowTurret'; }));
assert.ok(disambiguatedForestSourceIr.entities.some(function(entity) { return entity.id === 'RightCrossbowTurret'; }));
assert.ok(disambiguatedForestSourceIr.entities.some(function(entity) { return entity.id === 'RightEnemyWave'; }));
assert.ok(disambiguatedForestSourceIr.entities.some(function(entity) { return entity.id === 'BossEnemy'; }));
assert.strictEqual(disambiguatedForestSourceIr.phases[0].steps[0].target, 'LeftCrossbowTurret');
assert.strictEqual(disambiguatedForestSourceIr.phases[1].steps[0].target, 'RightCrossbowTurret');
assert.strictEqual(disambiguatedForestSourceIr.phases[2].steps[0].target, 'RightEnemyWave');
assert.strictEqual(disambiguatedForestSourceIr.phases[3].steps[0].target, 'BossEnemy');

var spaceVisible = internals.inferVisibleEntitiesForFrame({
  title: '选择助手角色',
  scene: '太空舱休眠舱旁出现助手角色卡片，怪物围拢，太阳能板在舱外。',
  interaction: 'build:HelperWorker',
}, 'space');
assert.ok(spaceVisible.indexOf('DormantPod') >= 0);
assert.ok(spaceVisible.indexOf('HelperWorker') >= 0);
assert.ok(spaceVisible.indexOf('RoleCard') >= 0);
assert.ok(spaceVisible.indexOf('Enemy') >= 0);

var shelterVisible = internals.inferVisibleEntitiesForFrame({
  title: '搜刮房间获取电池',
  scene: '房间里有火堆、木材、丧尸、家具、宝箱、钥匙和电池，冻僵人群在篝火旁。',
  interaction: 'attack:Enemy',
}, 'shelter_warmth');
assert.ok(shelterVisible.indexOf('Campfire') >= 0);
assert.ok(shelterVisible.indexOf('ShelterRoom') >= 0);
assert.ok(shelterVisible.indexOf('Enemy') >= 0);
assert.ok(shelterVisible.indexOf('Chest') >= 0);

var sparseVisible = internals.inferVisibleEntitiesForFrame({
  title: '清屏跳转',
  scene: '清屏跳转。',
  interaction: 'click:CtaButton',
}, 'space');
assert.deepStrictEqual(sparseVisible, ['Player', 'CtaButton']);

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
assert.strictEqual(numberedProfile.kind, 'space');
assert.strictEqual(numberedProfile.parser, 'numbered-table');
var numberedFrames = internals.parseGenericFrames(numberedText, '太空救星');
assert.strictEqual(numberedFrames.length, 18);
assert.ok(numberedFrames[0].title.indexOf('序号') < 0);
var cappedNumbered = internals.capRuntimePhases(numberedFrames, { min: 10, max: 13 });
assert.strictEqual(cappedNumbered.frames.length, numberedFrames.length);
assert.ok(internals.runtimePhaseCount(cappedNumbered.frames) <= 13);
assert.ok(cappedNumbered.diagnostics.some(function(item) {
  return item.code === 'storyboard_pdf_runtime_phase_merge' && item.fromPhaseCount === 18;
}));

var compactShelterFrames = [
  {
    id: 'shelter-1',
    chapter: 1,
    title: '开局寒冷房间',
    scene: '玩家看到什么：冰雪场景，风雪吹灭篝火，中间有一个熄灭的小火堆。玩家做什么：先感受寒意。玩家看到什么：篝火需要点燃，能看到周围部分房间。玩家做什么：先捡木材然后指引玩家去点燃篝火。',
    interaction: 'collect:Wood:1',
  },
  {
    id: 'shelter-2',
    chapter: 2,
    title: '搜刮房间',
    scene: '玩家看到什么：右侧中间房间里有数量较多的丧尸，家具和发光宝箱。玩家做什么：破坏家具获得宝箱并击杀丧尸。玩家看到什么：右下房间里也有丧尸、家具和宝箱。玩家做什么：收集木材，开宝箱，拾取飞斧。',
    interaction: 'attack:Enemy',
  },
  {
    id: 'shelter-3',
    chapter: 3,
    title: '升级电塔',
    scene: '玩家看到什么：缴纳木材后篝火升级为电塔，地面温暖范围扩大。玩家做什么：回到篝火处缴纳木材。玩家看到什么：升级后电塔上方再度出现气泡，需要木材和电池。',
    interaction: 'upgrade:PowerTower:2',
  },
  {
    id: 'shelter-4',
    chapter: 4,
    title: '钥匙和电池',
    scene: '左下房间获取钥匙，玩家击杀丧尸获得宝箱，宝箱里有钥匙。左上右上房间获取电池，玩家击杀丧尸获得宝箱，宝箱里有电池。',
    interaction: 'collect:Wood:1',
  },
  {
    id: 'shelter-5',
    chapter: 5,
    title: '升级电塔完成',
    scene: '升级电塔，玩家去电塔处缴纳电池和木材。玩家看到什么：电塔升级，镜头以电塔为中心特写展示。',
    interaction: 'upgrade:PowerTower:2',
  },
  {
    id: 'shelter-6',
    chapter: 6,
    title: '胜利收口',
    scene: '获取胜利，全场景积雪融化，出现绿地树木，人们欢呼。结束页面：弹出游戏logo和CTA。',
    interaction: 'click:CtaButton',
  },
];
var expandedShelter = internals.capRuntimePhases(compactShelterFrames, { min: 10, max: 13 });
assert.ok(internals.runtimePhaseCount(expandedShelter.frames) >= 10);
assert.ok(internals.runtimePhaseCount(expandedShelter.frames) <= 13);
assert.ok(expandedShelter.frames.length >= compactShelterFrames.length);
assert.ok(expandedShelter.diagnostics.some(function(item) {
  return item.code === 'storyboard_pdf_runtime_phase_expand' && item.fromPhaseCount === 6;
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
assert.strictEqual(internals.storyboardQualityDiagnostics(compiled, 'generic').length, 0);

var fallbackPhases = storyboardSourceIrCompiler._internals.compilePhases([{
  phaseId: 'phase1',
  phaseName: 'No parsed action but visible target',
  requiredInteractions: [],
  visibleEntities: ['Player', 'Enemy', 'BaseCamp'],
  entitiesRequired: [{ name: 'Enemy' }],
}, {
  phaseId: 'phase2',
  phaseName: 'CTA',
  requiredInteractions: ['click:CtaButton'],
  visibleEntities: ['Player', 'CtaButton'],
}], []);
assert.deepStrictEqual(fallbackPhases[0].steps, [{
  kind: 'move_to',
  target: 'Enemy',
  radius: 1.8,
  fallback: 'storyboard-visible-entity',
}]);
assert.deepStrictEqual(fallbackPhases[0].gate, {
  kind: 'near_entity',
  entity: 'Enemy',
  radius: 1.8,
});

var fallbackSourceIr = storyboardSourceIrCompiler.compileSourceSceneIrFromStoryboard({
  projectName: 'fallback diagnostics',
  entities: internals.entitiesForKind('generic'),
  specs: [{
    phaseId: 'phase1',
    phaseName: 'Unknown visible action',
    requiredInteractions: [],
    visibleEntities: ['Player', 'Enemy'],
    autoModeHint: '展示没有命中规则的新语义',
  }, {
    phaseId: 'phase2',
    phaseName: 'CTA',
    requiredInteractions: ['click:CtaButton'],
    visibleEntities: ['Player', 'CtaButton'],
  }],
});
assert.ok(fallbackSourceIr.diagnostics.storyboardSemanticFallbacks.some(function(item) {
  return item.code === 'storyboard_semantic_fallback_visible_entity' &&
    item.phaseId === 'phase1' &&
    item.fallbackInteraction === 'move_to:Enemy';
}));
assert.ok(fallbackSourceIr.diagnostics.storyboardRuleLearningQueue.some(function(item) {
  return item.phaseId === 'phase1' && item.ruleAction === 'add_or_adjust_storyboard_semantic_rule';
}));

var unresolvedPhases = storyboardSourceIrCompiler._internals.compilePhases([{
  phaseId: 'phase1',
  phaseName: 'No parsed action and no target',
  requiredInteractions: [],
  visibleEntities: ['Player'],
}, {
  phaseId: 'phase2',
  phaseName: 'CTA',
  requiredInteractions: ['click:CtaButton'],
  visibleEntities: ['Player', 'CtaButton'],
}], []);
assert.strictEqual(unresolvedPhases[0].steps[0].fallback, 'storyboard-unresolved-semantic-block');
assert.strictEqual(unresolvedPhases[0].steps[0].seconds, storyboardSourceIrCompiler._internals.UNRESOLVED_SEMANTIC_WAIT_SECONDS);
assert.deepStrictEqual(unresolvedPhases[0].gate, {
  kind: 'timer',
  seconds: storyboardSourceIrCompiler._internals.UNRESOLVED_SEMANTIC_WAIT_SECONDS,
});

var unresolvedDiagnostics = storyboardSourceIrCompiler._internals.semanticFallbackDiagnosticsForSpecs([{
  phaseId: 'phase1',
  phaseName: 'No parsed action and no target',
  requiredInteractions: [],
  visibleEntities: ['Player'],
}, {
  phaseId: 'phase2',
  phaseName: 'CTA',
  requiredInteractions: ['click:CtaButton'],
  visibleEntities: ['Player', 'CtaButton'],
}], []);
assert.ok(unresolvedDiagnostics.some(function(item) {
  return item.code === 'storyboard_semantic_unresolved_no_target' &&
    item.severity === 'error' &&
    item.fallbackInteraction === 'wait:' + storyboardSourceIrCompiler._internals.UNRESOLVED_SEMANTIC_WAIT_SECONDS;
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
