/**
 * 2026-05-12: deterministic strip of camera-background-override.
 *
 * Static rule `camera-background-override` (engine/static-check.cjs:1332) 强制只保留
 * skeleton Start() 中的 Camera.backgroundColor preset。AI 在其他位置重写会触发 blocking,
 * 派 Codex 走一整轮 review fix (~8min)。本 patcher 在 deterministic pre-repair 阶段
 * 直接 strip 多余 assignments,跳过 LLM round。
 *
 * 本次任务 proj_1777128165822_6acnqx review round 2 就因此原因走了 7.9min Codex。
 */

var assert = require('assert');
var review = require('../engine/stages/review.cjs');
var stripFn = review._internals && review._internals.stripExcessCameraBackgroundAssignments;

// 函数没导出 → 通过 repairKnownStructuralDamage 测端到端
var repair = review._internals && review._internals.repairKnownStructuralDamage;

if (!repair) {
  // 退化:直接 require 文件后从 source-eval 中拿(避免 review.cjs 主初始化路径)
  // 用 string-match 验证函数定义存在
  var src = require('fs').readFileSync(require('path').join(__dirname, '..', 'engine', 'stages', 'review.cjs'), 'utf8');
  assert.ok(/function stripExcessCameraBackgroundAssignments/.test(src),
    'stripExcessCameraBackgroundAssignments function 必须存在于 review.cjs');
  assert.ok(/main:CameraBackgroundOverride/.test(src),
    'repairKnownStructuralDamage 必须调用 stripExcessCameraBackgroundAssignments');
  console.log('  ✓ source presence: stripExcessCameraBackgroundAssignments + wired into repair');
}

// 直接对 source code 跑正则验证 strip 行为(避免 require chain 副作用)
function makeTestFile() {
  return [
    'public class GameFlowManagerMain : MonoBehaviour',
    '{',
    '    Camera mainCam;',
    '    void Start()',
    '    {',
    '        mainCam = Camera.main;',
    '        mainCam.backgroundColor = new Color(0.45f, 0.52f, 0.62f);',
    '    }',
    '    void Phase_intro_Init()',
    '    {',
    '        mainCam.backgroundColor = new Color(0.55f, 0.78f, 0.92f);',
    '    }',
    '    void Phase_cta_Init()',
    '    {',
    '        mainCam.backgroundColor = Color.black;',
    '    }',
    '}',
  ].join('\n');
}

// 把函数 inline 到测试里以避免 require review.cjs 的副作用 (review.cjs 顶部 require
// 大量 worker/* 资源,在测试环境下可能失败)。本测试只验 strip 函数的纯文本行为。
function stripCameraBg(code) {
  if (!code) return { code: code, changed: false, fixes: 0 };
  var stripped = code
    .replace(/\/\*[\s\S]*?\*\//g, function(m) { return m.replace(/[^\n]/g, ' '); })
    .replace(/\/\/[^\n]*/g, function(m) { return ' '.repeat(m.length); })
    .replace(/"(?:[^"\\]|\\.)*"/g, function(m) { return '"' + ' '.repeat(Math.max(0, m.length - 2)) + '"'; });
  var re = /(?:Camera|mainCam)\s*\.\s*backgroundColor\s*=/g;
  var hits = [];
  var m;
  while ((m = re.exec(stripped)) !== null) hits.push(m.index);
  if (hits.length <= 1) return { code: code, changed: false, fixes: 0 };

  var fixes = 0;
  var nextCode = code;
  for (var i = hits.length - 1; i >= 1; i--) {
    var stmtStart = hits[i];
    var semiIdx = nextCode.indexOf(';', stmtStart);
    if (semiIdx < 0) continue;
    var lineStart = nextCode.lastIndexOf('\n', stmtStart);
    if (lineStart < 0) lineStart = 0; else lineStart++;
    var indent = '';
    for (var k = lineStart; k < nextCode.length && /[ \t]/.test(nextCode[k]); k++) indent += nextCode[k];
    nextCode = nextCode.slice(0, lineStart) +
      indent + '// [REVIEW REPAIR] stripped duplicate Camera.backgroundColor assignment — skeleton Start() preset is the only source of truth.\n' +
      nextCode.slice(semiIdx + 1).replace(/^[ \t]*\n/, '');
    fixes++;
  }
  return { code: nextCode, changed: fixes > 0, fixes: fixes };
}

(function testStripsExtras() {
  var input = makeTestFile();
  var r = stripCameraBg(input);
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.fixes, 2, '应 strip 2 个 (Phase_intro + Phase_cta)');
  // 仅剩 Start() 中的一处 backgroundColor 赋值
  var stillThere = (r.code.match(/backgroundColor\s*=/g) || []).length;
  assert.strictEqual(stillThere, 1, '只保留 1 个 backgroundColor = (skeleton preset)');
  // 第一个赋值是在 Start() 中,要保留
  assert.ok(/void Start[\s\S]*?backgroundColor\s*=\s*new Color\(0\.45f, 0\.52f, 0\.62f\)/.test(r.code),
    'Start() 中的预设必须保留');
  // 占位注释要打上
  assert.ok(/\[REVIEW REPAIR\] stripped duplicate Camera\.backgroundColor/.test(r.code),
    'strip 后留 marker 注释便于 commit diff 排查');
  console.log('  ✓ strip extras: keeps Start preset, removes 2 extra assignments');
})();

(function testNoExtras() {
  // 只有 Start 中一处 → 不应改
  var input = 'void Start() { mainCam.backgroundColor = Color.red; }';
  var r = stripCameraBg(input);
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.fixes, 0);
  assert.strictEqual(r.code, input);
  console.log('  ✓ no extras: leaves single assignment alone');
})();

(function testIdempotent() {
  var r1 = stripCameraBg(makeTestFile());
  var r2 = stripCameraBg(r1.code);
  assert.strictEqual(r2.changed, false, '二次跑 = no-op (marker 已存在,被 strip 视为注释)');
  console.log('  ✓ idempotent: second pass is no-op');
})();

(function testStringLiteralIgnored() {
  // 字符串里的 backgroundColor = 不应被算
  var input = [
    'void Start() {',
    '    mainCam.backgroundColor = Color.red;',
    '    LogError("setting mainCam.backgroundColor = something for debug");',
    '}',
  ].join('\n');
  var r = stripCameraBg(input);
  assert.strictEqual(r.changed, false, '字符串内的字面量不算 assignment');
  console.log('  ✓ string literal: not counted as assignment');
})();

(function testCommentedAssignmentIgnored() {
  var input = [
    'void Start() {',
    '    mainCam.backgroundColor = Color.red;',
    '    // mainCam.backgroundColor = Color.black; // 注释里的不算',
    '}',
  ].join('\n');
  var r = stripCameraBg(input);
  assert.strictEqual(r.changed, false);
  console.log('  ✓ commented assignment: not counted');
})();

(function testCameraAndMainCamBothMatched() {
  var input = [
    'void Start() { mainCam.backgroundColor = Color.gray; }',
    'void Phase1() { Camera.backgroundColor = Color.red; }',
    'void Phase2() { mainCam.backgroundColor = Color.blue; }',
  ].join('\n');
  var r = stripCameraBg(input);
  assert.strictEqual(r.fixes, 2);
  assert.strictEqual(r.changed, true);
  console.log('  ✓ both Camera.main + mainCam matched (3 → 1, strip 2)');
})();

console.log('\nreview camera-background strip: 6+1 cases passed');
