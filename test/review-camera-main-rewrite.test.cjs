/**
 * 2026-05-12: Camera.main → mainCam deterministic rewrite test.
 *
 * 静态规则 camera-main blocking;过去触发即派 Codex round 走 ~7min。本 patcher 在
 * review pre-repair 直接替换,跳过 LLM。屏蔽字符串/注释,保留 grep/log 字面量完整。
 */

var assert = require('assert');
var fs = require('fs');
var path = require('path');

// 在 test 文件里 inline 函数(避开 review.cjs 主初始化路径)
function rewriteCameraMain(code) {
  if (!code || code.indexOf('Camera.main') < 0) return { code: code, changed: false, fixes: 0 };
  // Safety: must have `Camera mainCam` declaration (skeleton). GFM_*.cs utility files don't.
  if (!/\b(?:private|protected|internal|public|static)?\s*Camera\s+mainCam\s*[;=]/.test(code)) {
    return { code: code, changed: false, fixes: 0 };
  }
  var mask = new Array(code.length).fill(true);
  var i = 0;
  while (i < code.length) {
    if (code[i] === '/' && code[i+1] === '/') {
      while (i < code.length && code[i] !== '\n') { mask[i] = false; i++; }
    } else if (code[i] === '/' && code[i+1] === '*') {
      mask[i] = false; mask[i+1] = false; i += 2;
      while (i < code.length - 1 && !(code[i] === '*' && code[i+1] === '/')) { mask[i] = false; i++; }
      if (i < code.length - 1) { mask[i] = false; mask[i+1] = false; i += 2; }
    } else if (code[i] === '"') {
      mask[i] = false; i++;
      while (i < code.length && code[i] !== '"' && code[i] !== '\n') {
        if (code[i] === '\\') { mask[i] = false; i++; }
        if (i < code.length) { mask[i] = false; i++; }
      }
      if (i < code.length) { mask[i] = false; i++; }
    } else { i++; }
  }
  var fixes = 0;
  var out = '';
  var j = 0;
  while (j < code.length) {
    if (mask[j] && code.substr(j, 11) === 'Camera.main' &&
        !/[A-Za-z0-9_]/.test(code[j - 1] || '') &&
        !/[A-Za-z0-9_]/.test(code[j + 11] || '')) {
      var lineEnd = code.indexOf('\n', j);
      if (lineEnd < 0) lineEnd = code.length;
      var suffix = code.slice(j + 11, lineEnd);
      if (/^\s*;?\s*\/\/\s*(?:(?:说明：)?ok\b|正常)/.test(suffix)) {
        out += 'Camera.main';
        j += 11;
        continue;
      }
      out += 'mainCam';
      j += 11;
      fixes++;
    } else { out += code[j]; j++; }
  }
  return { code: fixes > 0 ? out : code, changed: fixes > 0, fixes: fixes };
}

function repairMainCamSelfAssignment(code) {
  if (!code || code.indexOf('mainCam') < 0 || code.indexOf('= mainCam') < 0) return { code: code, changed: false, fixes: 0 };
  var lines = code.split('\n');
  var fixes = 0;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var commentIdx = line.indexOf('//');
    var codePart = commentIdx >= 0 ? line.slice(0, commentIdx) : line;
    if (!/\bmainCam\s*=\s*mainCam\s*;/.test(codePart)) continue;
    var fixedCodePart = codePart.replace(/\bmainCam\s*=\s*mainCam\s*;/g, 'mainCam = Camera.main;');
    lines[i] = fixedCodePart.replace(/\s+$/, '') + ' // 正常';
    fixes++;
  }
  return { code: fixes > 0 ? lines.join('\n') : code, changed: fixes > 0, fixes: fixes };
}

(function testReplacesBasic() {
  var input = 'public class GFM { Camera mainCam; void Setup() { Camera.main.transform.position = Vector3.zero; } }';
  var r = rewriteCameraMain(input);
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.fixes, 1);
  assert.ok(/mainCam\.transform/.test(r.code));
  assert.ok(!/Camera\.main\.transform/.test(r.code));
  console.log('  ✓ basic: Camera.main.x → mainCam.x');
})();

(function testReplacesMultiple() {
  var input = 'class GFM { Camera mainCam;\nvoid F() {\nCamera.main.fieldOfView = 60;\nCamera.main.backgroundColor = Color.red;\nvar c = Camera.main; } }';
  var r = rewriteCameraMain(input);
  assert.strictEqual(r.fixes, 3);
  console.log('  ✓ multiple: 3 occurrences all replaced');
})();

(function testIgnoresInComment() {
  var input = 'class GFM { Camera mainCam; void Setup() { // Camera.main is deprecated\n var x = mainCam; } }';
  var r = rewriteCameraMain(input);
  assert.strictEqual(r.changed, false, 'Comment 里的 Camera.main 不替换');
  console.log('  ✓ comment: Camera.main inside // ignored');
})();

(function testIgnoresInBlockComment() {
  var input = 'class GFM { Camera mainCam; /* note: Camera.main is bad */\nvoid F() { var x = mainCam; } }';
  var r = rewriteCameraMain(input);
  assert.strictEqual(r.changed, false);
  console.log('  ✓ block comment: Camera.main inside /* */ ignored');
})();

(function testIgnoresInString() {
  var input = 'class GFM { Camera mainCam; void F() { LogError("avoid Camera.main please"); } }';
  var r = rewriteCameraMain(input);
  assert.strictEqual(r.changed, false);
  console.log('  ✓ string literal: Camera.main inside "..." ignored');
})();

(function testIgnoresPartialMatch() {
  // Camera.mainOther 不算
  var input = 'var x = Camera.mainOther;';
  var r = rewriteCameraMain(input);
  assert.strictEqual(r.changed, false);
  console.log('  ✓ partial match: Camera.mainOther preserved');
})();

(function testIgnoresPrefixMatch() {
  // SubCamera.main 不算
  var input = 'var x = SubCamera.main;';
  var r = rewriteCameraMain(input);
  assert.strictEqual(r.changed, false, 'SubCamera.main 前 identifier 不该替');
  console.log('  ✓ prefix match: SubCamera.main preserved');
})();

(function testNoOpOnCleanCode() {
  var input = 'var x = mainCam.transform.position;';
  var r = rewriteCameraMain(input);
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.code, input);
  console.log('  ✓ no-op when no Camera.main present');
})();

(function testIdempotent() {
  var r1 = rewriteCameraMain('class GFM { Camera mainCam; void F() { Camera.main.x = 1; } }');
  var r2 = rewriteCameraMain(r1.code);
  assert.strictEqual(r2.changed, false);
  console.log('  ✓ idempotent: second run is no-op');
})();

(function testKeepsAllowedSkeletonCameraCache() {
  var input = 'class GFM { Camera mainCam; void Start() { mainCam = Camera.main; // 正常\n } }';
  var r = rewriteCameraMain(input);
  assert.strictEqual(r.changed, false, 'skeleton camera cache line must remain Camera.main // 正常');
  assert.ok(/mainCam\s*=\s*Camera\.main;\s*\/\/\s*正常/.test(r.code));
  console.log('  ✓ skeleton cache: Camera.main // 正常 preserved');
})();

(function testRepairsMainCamSelfAssignment() {
  var input = 'class GFM { Camera mainCam; void Start() { mainCam = mainCam; // 正常\n } }';
  var repaired = repairMainCamSelfAssignment(input);
  assert.strictEqual(repaired.changed, true);
  assert.strictEqual(repaired.fixes, 1);
  assert.ok(/mainCam\s*=\s*Camera\.main;\s*\/\/\s*正常/.test(repaired.code));
  var rewritten = rewriteCameraMain(repaired.code);
  assert.strictEqual(rewritten.changed, false, 'camera rewrite must not regress repaired skeleton cache');
  console.log('  ✓ self assignment: mainCam = mainCam repaired and preserved');
})();

// 🔒 关键安全测试: GFM_*.cs 等独立工具类没有 mainCam 字段,绝不能替换
(function testSkipsFileWithoutMainCam() {
  var gfmUtilsLike = [
    'using UnityEngine;',
    'public static class GFM_Utils',
    '{',
    '    public static Vector3 WorldToScreen(Vector3 pos)',
    '    {',
    '        return Camera.main.WorldToScreenPoint(pos);',
    '    }',
    '    public static Camera Get() { return Camera.main; }',
    '}',
  ].join('\n');
  var r = rewriteCameraMain(gfmUtilsLike);
  assert.strictEqual(r.changed, false, '无 mainCam 字段的文件绝不能替换');
  assert.strictEqual(r.code, gfmUtilsLike);
  console.log('  ✓ safety: file without `Camera mainCam` field NOT rewritten (GFM_Utils.cs)');
})();

// 验证 review.cjs 的 rewriteCameraMainToMainCam 函数定义存在 + 接到 repair
// Wave 2 (2026-05-31): 编排从 review.cjs 抽到 engine/lib/static-rule-prerepair.cjs。
// fn body 仍在 review.cjs 并经 PREREPAIR_FNS 注入;main+extras 调用合并为 lib 的
// SHARED_BUNDLE 单一条目(同时覆盖 main pass 和 partial pass)。
(function testWired() {
  var src = fs.readFileSync(path.join(__dirname, '..', 'engine', 'stages', 'review.cjs'), 'utf8');
  assert.ok(/function rewriteCameraMainToMainCam/.test(src), 'function present in review.cjs');
  assert.ok(/rewriteCameraMainToMainCam: rewriteCameraMainToMainCam/.test(src), 'fn injected via PREREPAIR_FNS');
  assert.ok(/function repairMainCamSelfAssignment/.test(src), 'self-assignment repair present in review.cjs');
  assert.ok(/repairMainCamSelfAssignment: repairMainCamSelfAssignment/.test(src), 'self-assignment fn injected via PREREPAIR_FNS');
  var bundle = require('../engine/lib/static-rule-prerepair.cjs').SHARED_BUNDLE;
  assert.ok(bundle.some(function(e) { return e[0] === 'repairMainCamSelfAssignment' && e[1] === 'CameraMainSelfAssign'; }),
    'self-assignment repair wired into SHARED_BUNDLE');
  assert.ok(bundle.some(function(e) { return e[0] === 'rewriteCameraMainToMainCam' && e[1] === 'CameraMainRewrite'; }),
    'wired into SHARED_BUNDLE (covers main + extras)');
  console.log('  ✓ wired: function (review.cjs) + PREREPAIR_FNS + SHARED_BUNDLE (lib)');
})();

console.log('\nreview Camera.main rewrite: 12 cases passed');
