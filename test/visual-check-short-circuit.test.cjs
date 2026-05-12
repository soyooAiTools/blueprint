/**
 * 2026-05-12 P2: visual-check phaseLog 短路 VLM 测试。
 *
 * 当 engine 被证明在跑 (足量 __PHASE__: 信号 + 多 phase + 0 critical error + 足量 frame),
 * 跳过 VLM 直接 pass。VLM 留作"engine 卡死/黑屏"的 hard gate。
 */

var assert = require('assert');
var visualCheck = require('../engine/stages/visual-check.cjs');
var evaluate = visualCheck._evaluateVisualCheckShortCircuit;

// ---------- 触发条件全部满足:短路 ----------

(function testCanSkipHappyPath() {
  var phaseLog = [
    { phase: 'gameStart', time: 1 },
    { phase: 'intro', time: 2 },
    { phase: 'collect', time: 3 },
    { phase: 'build', time: 4 },
  ];
  var r = evaluate(phaseLog, [], 3, {});
  assert.strictEqual(r.canSkip, true);
  assert.strictEqual(r.distinctPhaseCount, 4);
  assert.strictEqual(r.criticalErrors, 0);
  console.log('  ✓ happy path: 4 distinct phases / 3 frames → short-circuit');
})();

// ---------- 边界:phaseLog=3 / distinct=2 / frames=2 ----------

(function testCanSkipMinimalThreshold() {
  var phaseLog = [
    { phase: 'a', time: 1 },
    { phase: 'b', time: 2 },
    { phase: 'a', time: 3 }, // 重复 a → distinct=2
  ];
  var r = evaluate(phaseLog, [], 2, {});
  assert.strictEqual(r.canSkip, true);
  assert.strictEqual(r.distinctPhaseCount, 2);
  console.log('  ✓ minimal threshold: phaseLog=3 distinct=2 frames=2 → short-circuit');
})();

// ---------- 拒绝条件 ----------

(function testRejectShortPhaseLog() {
  var phaseLog = [{ phase: 'a' }, { phase: 'b' }]; // 只 2 条
  var r = evaluate(phaseLog, [], 3, {});
  assert.strictEqual(r.canSkip, false);
  assert.match(r.reason, /phaseLog too short/);
  console.log('  ✓ reject: phaseLog<3');
})();

(function testRejectSinglePhase() {
  // 6 个 __PHASE__: 但全是同一 phase → engine 可能卡在原地
  var phaseLog = new Array(6).fill(null).map(function() { return { phase: 'stuck' }; });
  var r = evaluate(phaseLog, [], 3, {});
  assert.strictEqual(r.canSkip, false);
  assert.strictEqual(r.distinctPhaseCount, 1);
  assert.match(r.reason, /too few distinct phases/);
  console.log('  ✓ reject: distinctPhaseCount<2 (engine stuck on same phase)');
})();

(function testRejectCriticalError() {
  var phaseLog = [{ phase: 'a' }, { phase: 'b' }, { phase: 'c' }];
  var errors = ['[pageerror] TypeError: cannot read property x of null'];
  var r = evaluate(phaseLog, errors, 3, {});
  assert.strictEqual(r.canSkip, false);
  assert.strictEqual(r.criticalErrors, 1);
  assert.match(r.reason, /critical console error/);
  console.log('  ✓ reject: pageerror present');
})();

(function testRejectReferenceError() {
  var r = evaluate([{phase:'a'},{phase:'b'},{phase:'c'}],
    ['[error] ReferenceError: foo is not defined'], 3, {});
  assert.strictEqual(r.canSkip, false);
  assert.strictEqual(r.criticalErrors, 1);
  console.log('  ✓ reject: ReferenceError counted as critical');
})();

(function testRejectTypeError() {
  var r = evaluate([{phase:'a'},{phase:'b'},{phase:'c'}],
    ['[error] TypeError: x.y is undefined'], 3, {});
  assert.strictEqual(r.canSkip, false);
  console.log('  ✓ reject: TypeError counted as critical');
})();

(function testNonCriticalErrorAllowed() {
  // 普通 console warning 不计入 critical
  var r = evaluate([{phase:'a'},{phase:'b'},{phase:'c'}],
    ['[warning] CSS deprecation', '[error] some non-fatal app warn'], 3, {});
  assert.strictEqual(r.canSkip, true, '普通 warning/error 不应触发拒绝');
  console.log('  ✓ allow: generic warnings not flagged as critical');
})();

(function testRejectInsufficientFrames() {
  var r = evaluate([{phase:'a'},{phase:'b'},{phase:'c'}], [], 1, {});
  assert.strictEqual(r.canSkip, false);
  assert.match(r.reason, /insufficient frame samples/);
  console.log('  ✓ reject: frameCount<2');
})();

// ---------- env flag 关闭开关 ----------

(function testEnvOffDisablesShortCircuit() {
  var r = evaluate([{phase:'a'},{phase:'b'},{phase:'c'},{phase:'d'}], [], 3,
    { BLUEPRINT_VISUAL_CHECK_SKIP_VLM: 'off' });
  assert.strictEqual(r.canSkip, false);
  assert.match(r.reason, /disabled/);
  console.log('  ✓ env: BLUEPRINT_VISUAL_CHECK_SKIP_VLM=off forces VLM call');
})();

(function testEnvDefaultAllowsShortCircuit() {
  var r = evaluate([{phase:'a'},{phase:'b'},{phase:'c'}], [], 2, {}); // 空 env
  assert.strictEqual(r.canSkip, true, '默认应允许短路');
  console.log('  ✓ env: default (unset) allows short-circuit');
})();

// ---------- 防御性 ----------

(function testEmptyInputsDefensive() {
  var r1 = evaluate(null, null, 0, {});
  assert.strictEqual(r1.canSkip, false);
  var r2 = evaluate([], [], 0, {});
  assert.strictEqual(r2.canSkip, false);
  // 不应抛异常
  console.log('  ✓ defensive: null/empty inputs → canSkip=false, no throw');
})();

(function testMalformedPhaseEntries() {
  // 含 null / 缺 phase 字段的条目应被忽略
  var phaseLog = [
    { phase: 'a' },
    null,
    { time: 1 }, // 缺 phase
    { phase: 'b' },
    { phase: 'c' },
  ];
  var r = evaluate(phaseLog, [], 3, {});
  assert.strictEqual(r.distinctPhaseCount, 3, 'null / 缺字段条目应被跳过');
  assert.strictEqual(r.canSkip, true);
  console.log('  ✓ defensive: malformed phase entries skipped');
})();

console.log('\nvisual-check short-circuit: 12 cases passed');
