#!/usr/bin/env node
// [WAVE F] _deriveGoalFromSpec 兜底回归：
// LLM 漏写 goal 时，spec-extractor 必须从 triggerNext.condition / spend / collect /
// build 推断出 HUD 目标。否则玩家在该 phase 看不到进度数字（短板根因）。

var assert = require('assert');
var { _internals } = require('../adapters/spec-extractor.cjs');
var derive = _internals.deriveGoalFromSpec;
var isValid = _internals.isValidGoal;

// ---------- isValidGoal ----------
assert.strictEqual(isValid(null), false);
assert.strictEqual(isValid({}), false);
assert.strictEqual(isValid({ kind: 'amount', target: 5 }), true);
assert.strictEqual(isValid({ kind: 'unknown', target: 5 }), false, 'kind 必须 ∈ {amount,count,state}');
assert.strictEqual(isValid({ kind: 'amount', target: 0 }), false, 'target 必须 > 0');
assert.strictEqual(isValid({ kind: 'amount', target: -3 }), false);
assert.strictEqual(isValid({ kind: 'amount', target: 'abc' }), false);
assert.strictEqual(isValid({ kind: 'count', target: 3, displayResource: '' }), true);

// ---------- triggerNext.condition 优先 ----------
{
  // 太空捡垃圾的真实形态：触发条件 GoldUI.value >= 200
  var goal = derive({
    triggerNext: { condition: 'GoldUI.value >= 200' },
    requiredInteractions: ['click:SpaceDebris'],
  });
  assert.deepStrictEqual(goal, { kind: 'amount', target: 200, displayResource: 'Gold' },
    'GoldUI.value >= 200 应推出 amount/200/Gold');
}

{
  // PlayerAstronaut.amount >= 5
  var goal = derive({
    triggerNext: { condition: 'PlayerAstronaut.amount >= 5' },
    requiredInteractions: [],
  });
  assert.deepStrictEqual(goal, { kind: 'amount', target: 5, displayResource: 'PlayerAstronaut' });
}

// ---------- spend:resource:N（最大值优先）----------
{
  var goal = derive({
    triggerNext: { condition: 'ForgeWorkshop.state == 2' },
    requiredInteractions: ['click:ForgeWorkshop', 'spend:gold:50', 'build:ForgeWorkshop'],
  });
  assert.deepStrictEqual(goal, { kind: 'amount', target: 50, displayResource: 'Gold' },
    'spend:gold:50 应推出 amount/50/Gold（首字母大写）');
}

{
  // 多个 spend 取最大值
  var goal = derive({
    triggerNext: { condition: '' },
    requiredInteractions: ['spend:gold:30', 'spend:gold:200'],
  });
  assert.strictEqual(goal.target, 200, '多个 spend 取最大值');
}

// ---------- collect:item:N ----------
{
  var goal = derive({
    triggerNext: { condition: '' },
    requiredInteractions: ['collect:MetalScrap:5'],
  });
  assert.deepStrictEqual(goal, { kind: 'amount', target: 5, displayResource: 'MetalScrap' });
}

// ---------- 多个 build → count ----------
{
  var goal = derive({
    triggerNext: { condition: '' },
    requiredInteractions: [
      'click:CanteenModule', 'build:CanteenModule',
      'click:DormModule',    'build:DormModule',
      'click:PastureModule', 'build:PastureModule',
    ],
  });
  assert.deepStrictEqual(goal, { kind: 'count', target: 3, displayResource: '' },
    '3 个 build 应推出 count/3');
}

// ---------- 单个 build 不算（一对一不需要 HUD 计数）----------
{
  var goal = derive({
    triggerNext: { condition: 'BasicDrill.level == 2' },
    requiredInteractions: ['click:ForgeWorkshop', 'build:ForgeWorkshop'],
  });
  assert.strictEqual(goal, null, '单个 build 没有数字目标 → 不应推出 goal');
}

// ---------- 没有可量化目标 → null ----------
{
  var goal = derive({
    triggerNext: { condition: 'CTAButton.clicked == true' },
    requiredInteractions: ['click:CTAButton'],
  });
  assert.strictEqual(goal, null, '纯交互 phase 不应推出 goal');
}

// ---------- 兼容对象形 requiredInteractions ----------
{
  var goal = derive({
    triggerNext: { condition: '' },
    requiredInteractions: [{ verb: 'spend', target: 'gold', amount: 100 }],
  });
  assert.deepStrictEqual(goal, { kind: 'amount', target: 100, displayResource: 'Gold' });
}

// ---------- triggerNext.condition 优先于 spend ----------
{
  // condition 显式给了 200 → 即使有 spend:50 也用 200
  var goal = derive({
    triggerNext: { condition: 'GoldUI.value >= 200' },
    requiredInteractions: ['spend:gold:50'],
  });
  assert.strictEqual(goal.target, 200, 'condition 显式数值应优先于 spend');
}

console.log('OK — spec-extractor goal-derivation tests passed (' +
  '11 assertions: triggerNext condition / spend / collect / build-count / null / object-form)');
