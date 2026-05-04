// [WAVE F] 玩家可读性回归：spec 新字段（playerInstruction/goal/autoModeHint/subAction）
// 必须正确驱动 skeleton-generator 发射 SetGuideText / SetPhaseGoal / goalText / 注释；
// 旧 spec（无新字段）必须保持完全一致，零 WAVE F 残留——加性扩展不允许污染历史输出。

const assert = require('assert');
const { generateSkeleton } = require('../adapters/skeleton-generator.cjs');

function joinAll(out) {
  return [out.main, out.flow, out.input, out.resource, out.ui, out.scene]
    .filter(Boolean).join('\n');
}

// ---------- Case A：spec 携带新字段，应触发 WAVE F 全套发射 ----------
{
  const out = generateSkeleton([
    {
      phaseId: 'collect',
      phaseName: 'Collect',
      entitiesRequired: [{ name: 'Ore' }],
      requiredInteractions: [
        { verb: 'click', target: 'Ore', subAction: 'pickUp' },
        { verb: 'collect', target: 'Ore' },
      ],
      triggerNext: { condition: 'true' },
      duration: { min: 1, max: 2 },
      playerMustAct: true,
      playerInstruction: '点击太空垃圾收集',
      goal: { kind: 'amount', target: 5, displayResource: 'MetalScrap' },
    },
    {
      phaseId: 'autoPhase',
      phaseName: 'Auto',
      entitiesRequired: [{ name: 'Truck' }],
      requiredInteractions: ['wait:3'],
      triggerNext: { condition: 'true' },
      duration: { min: 3, max: 3 },
      playerMustAct: false,
      autoAllowed: true,
      autoModeHint: '观察粉碎车自动采集',
      // playerInstruction 在 autoAllowed 时应被 autoModeHint 覆盖。
      playerInstruction: '原本是手动指引但应该被覆盖',
    },
  ], {
    entityPoolMap: { Ore: '__Pool_Ore', Truck: '__Pool_Truck' },
    entities: [{ name: 'Ore' }, { name: 'Truck' }],
  });

  const all = joinAll(out);

  // playerInstruction → SetGuideText
  assert.match(all, /SetGuideText\("点击太空垃圾收集"\)/,
    'collect phase 应发射 playerInstruction guideText');

  // autoModeHint 优先于 playerInstruction（autoAllowed=true 时）
  assert.match(all, /SetGuideText\("观察粉碎车自动采集"\)/,
    'auto phase 应发射 autoModeHint');
  assert.doesNotMatch(all, /SetGuideText\("原本是手动指引但应该被覆盖"\)/,
    'autoAllowed=true 时 playerInstruction 不应被使用');

  // goal → SetPhaseGoal + UI/字段
  assert.match(all, /SetPhaseGoal\("amount", 5, "MetalScrap"\)/,
    'goal 应转换成 SetPhaseGoal 调用');
  assert.match(all, /Text goalText;/, '应声明 goalText 字段');
  assert.match(all, /goalText = GFM_UI\.CreateText/,
    'Start() 应创建 goalText UI');
  assert.match(all, /void UpdateGoalDisplay\(\)/,
    '应定义 UpdateGoalDisplay 方法');
  assert.match(all, /void SetPhaseGoal\(string kind, int target, string displayResource\)/,
    '应定义 SetPhaseGoal helper');

  // subAction → 注释暴露给 codegen prompt
  assert.match(all, /\[WAVE F\] subAction 消歧/,
    '同 entity 多动作的 phase 应注释 subAction 路由提示');
  assert.match(all, /click:Ore → subAction="pickUp"/,
    'subAction 注释应包含 verb:target → subAction= 行');
}

// ---------- Case B：旧 spec 无新字段，应零 WAVE F 残留 ----------
{
  const out = generateSkeleton([
    {
      phaseId: 'intro',
      phaseName: 'Intro',
      entitiesRequired: [{ name: 'Ore' }],
      requiredInteractions: ['click:Ore'],
      triggerNext: { condition: 'true' },
      duration: { min: 1, max: 2 },
      playerMustAct: true,
    },
    {
      phaseId: 'tap2',
      phaseName: 'Tap2',
      entitiesRequired: [{ name: 'Truck' }],
      requiredInteractions: ['click:Truck'],
      triggerNext: { condition: 'true' },
      duration: { min: 1, max: 2 },
      playerMustAct: true,
    },
  ], {
    entityPoolMap: { Ore: '__Pool_Ore', Truck: '__Pool_Truck' },
    entities: [{ name: 'Ore' }, { name: 'Truck' }],
  });

  const all = joinAll(out);

  assert.doesNotMatch(all, /\[WAVE F\]/, '旧 spec 不得出现 WAVE F 标记');
  assert.doesNotMatch(all, /goalText/, '旧 spec 不得声明 goalText');
  assert.doesNotMatch(all, /_goalKind|_goalTarget|_goalResource/,
    '旧 spec 不得声明 goal 私有字段');
  assert.doesNotMatch(all, /SetPhaseGoal|ClearPhaseGoal|UpdateGoalDisplay/,
    '旧 spec 不得发射 goal helper 方法/调用');
}

// ---------- Case C：goal 无 displayResource，autoModeHint 单独存在 ----------
// 验证字段稀疏组合不会爆炸，且 goalText 仅当确实有任一字段时声明。
{
  const out = generateSkeleton([
    {
      phaseId: 'p1',
      phaseName: 'P1',
      entitiesRequired: [{ name: 'Ore' }],
      requiredInteractions: ['click:Ore'],
      triggerNext: { condition: 'true' },
      duration: { min: 1, max: 2 },
      playerMustAct: true,
      goal: { kind: 'count', target: 3 }, // displayResource 缺省
    },
  ], {
    entityPoolMap: { Ore: '__Pool_Ore' },
    entities: [{ name: 'Ore' }],
  });

  const all = joinAll(out);
  assert.match(all, /SetPhaseGoal\("count", 3, ""\)/,
    'displayResource 缺省时应传空字符串，不应崩溃');
  assert.match(all, /Text goalText;/, 'goal 单独存在也应触发 goalText 声明');
  // SetGuideText 方法本身始终定义，但 WAVE F 注入的引导调用必须缺席。
  assert.doesNotMatch(all, /\[WAVE F\] 玩家可读引导：来自 spec\.(playerInstruction|autoModeHint)/,
    '无 playerInstruction/autoModeHint 时不应发射 WAVE F 引导调用');
}

console.log('skeleton player-readability (WAVE F) regression tests passed');
