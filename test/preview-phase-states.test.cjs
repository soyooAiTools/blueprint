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
  { done: true, active: false },
  { done: true, active: false },
  { done: false, active: true },
]);

states = getOrderedPreviewPhaseStates(
  specs,
  ['gameStart', 'enemyAttackWarning', 'upgradeOurBase', 'enemyImpactExplosion', 'gameEnd'],
  'gameEnd',
  ['gameStart', 'enemyAttackWarning', 'upgradeOurBase', 'enemyImpactExplosion', 'gameEnd'],
  true
);
assert.deepStrictEqual(plain(states.map((item) => item.done)), [true, true, true]);

console.log('preview phase states tests passed');
