const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../frontend/src/App.jsx'), 'utf8');
const start = source.indexOf('const PHASE_WORD_BLACKLIST');
const end = source.indexOf('function splitIdentifierWords');
assert.ok(start >= 0 && end > start, 'preview phase helper source slice should exist');

const sandbox = { module: { exports: {} }, exports: {} };
vm.runInNewContext(
  source.slice(start, end) +
    '\nmodule.exports = { getOrderedPreviewPhaseStates, isRuntimeMetaPhase };',
  sandbox
);

const { getOrderedPreviewPhaseStates, isRuntimeMetaPhase } = sandbox.module.exports;

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const specs = [
  { phaseId: 'enemyAttackWarning', phaseName: '敌方进攻预警' },
  { phaseId: 'upgradeOurBase', phaseName: '升级基地防御' },
  { phaseId: 'enemyImpactExplosion', phaseName: '敌方撞击爆炸' },
];

assert.strictEqual(isRuntimeMetaPhase('gameStart'), true);
assert.strictEqual(isRuntimeMetaPhase('gameEnd'), true);
assert.strictEqual(isRuntimeMetaPhase('enemyAttackWarning'), false);

let states = getOrderedPreviewPhaseStates(
  specs,
  ['gameStart', 'enemyAttackWarning', 'upgradeOurBase'],
  'enemyImpactExplosion',
  ['gameStart', 'enemyAttackWarning', 'upgradeOurBase'],
  true
);
assert.deepStrictEqual(plain(states), [
  { done: true, active: false, awaiting: false },
  { done: true, active: false, awaiting: false },
  { done: false, active: true, awaiting: false },
]);

states = getOrderedPreviewPhaseStates(
  specs,
  ['gameStart', 'enemyAttackWarning', 'upgradeOurBase', 'enemyImpactExplosion', 'gameEnd'],
  'gameEnd',
  ['gameStart', 'enemyAttackWarning', 'upgradeOurBase', 'enemyImpactExplosion', 'gameEnd'],
  true
);
assert.deepStrictEqual(plain(states.map((item) => item.done)), [true, true, true]);

// 反馈 01 #4：SHOT 进度跳号(完成 1 和 3,缺 2)时,phase 3 必须保持未完成 + awaiting 提示。
states = getOrderedPreviewPhaseStates(
  specs,
  ['enemyAttackWarning', 'enemyImpactExplosion'],
  'upgradeOurBase',
  ['enemyAttackWarning', 'upgradeOurBase', 'enemyImpactExplosion'],
  true
);
assert.deepStrictEqual(plain(states), [
  { done: true, active: false, awaiting: false },
  { done: false, active: true, awaiting: false },
  { done: false, active: false, awaiting: true },
]);

// 反馈 01 #4：连续推进(1→2→3) awaiting 不应触发,phase 1/2 done,phase 3 active。
states = getOrderedPreviewPhaseStates(
  specs,
  ['enemyAttackWarning', 'upgradeOurBase'],
  'enemyImpactExplosion',
  ['enemyAttackWarning', 'upgradeOurBase', 'enemyImpactExplosion'],
  true
);
assert.deepStrictEqual(plain(states.map((s) => s.awaiting)), [false, false, false]);
assert.deepStrictEqual(plain(states.map((s) => s.done)), [true, true, false]);
assert.strictEqual(states[2].active, true);

// 反馈 01 #4：从中间开始单点上报(只完成第 2 个) 也算跳号,phase 2 保持 awaiting。
states = getOrderedPreviewPhaseStates(
  specs,
  ['upgradeOurBase'],
  '',
  ['enemyAttackWarning', 'upgradeOurBase', 'enemyImpactExplosion'],
  true
);
assert.deepStrictEqual(plain(states.map((s) => s.done)), [false, false, false]);
assert.deepStrictEqual(plain(states.map((s) => s.awaiting)), [false, true, false]);

console.log('preview phase states tests passed');
