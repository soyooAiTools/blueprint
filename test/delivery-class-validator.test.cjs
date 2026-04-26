var assert = require('assert');
var v = require('../engine/delivery-class-validator.cjs');

// ============ findMethods ============

(function testFindMethodsBasic() {
  var code = [
    'public partial class Foo {',
    '  void Start() {',
    '    DoStuff();',
    '  }',
    '  int Compute(int x) {',
    '    return x * 2;',
    '  }',
    '}',
  ].join('\n');
  var methods = v.findMethods(code);
  assert.strictEqual(methods.length, 2, 'expected 2 methods');
  assert.strictEqual(methods[0].name, 'Start');
  assert.strictEqual(methods[1].name, 'Compute');
  assert.strictEqual(methods[0].line, 2);
  assert.strictEqual(methods[1].line, 5);
  console.log('  ✓ findMethods basic');
})();

(function testFindMethodsSkipsExpressionBodied() {
  // Foo() => 42; 不算方法体,不应被识别
  var code = 'int Foo() => 42;\nvoid Bar() { }';
  var methods = v.findMethods(code);
  assert.strictEqual(methods.length, 1);
  assert.strictEqual(methods[0].name, 'Bar');
  console.log('  ✓ findMethods skips expression-bodied');
})();

(function testFindMethodsSkipsInterfaceDecl() {
  var code = 'void Abstract();\nvoid Real() { }';
  var methods = v.findMethods(code);
  assert.strictEqual(methods.length, 1);
  assert.strictEqual(methods[0].name, 'Real');
  console.log('  ✓ findMethods skips interface/abstract decl');
})();

(function testFindMethodsSkipsConstructor() {
  // 构造器 — name 跟 class 同名时应被过滤
  var code = [
    'public class Helper {',
    '  public Helper() {',
    '    Init();',
    '  }',
    '  void Real() { }',
    '}',
  ].join('\n');
  var methods = v.findMethods(code);
  var names = methods.map(function(m) { return m.name; });
  assert.deepStrictEqual(names, ['Real'], 'expected only Real, got: ' + JSON.stringify(names));
  console.log('  ✓ findMethods skips constructor');
})();

(function testFindMethodsSkipsObjectInitializer() {
  // `new Helper() { A = 1 }` — Helper 跟前置 `new` 一起,应被过滤
  var code = [
    'void Setup() {',
    '  var x = new Helper() { A = 1, B = 2 };',
    '  var y = new GameFlowEntity() { Name = "x" };',
    '}',
  ].join('\n');
  var methods = v.findMethods(code);
  var names = methods.map(function(m) { return m.name; });
  assert.deepStrictEqual(names, ['Setup'], 'expected only Setup, got: ' + JSON.stringify(names));
  console.log('  ✓ findMethods skips object initializer');
})();

// ============ maxNestingDepth ============

(function testNestingFlat() {
  var body = '\n    DoA();\n    DoB();\n';
  assert.strictEqual(v.maxNestingDepth(body), 0);
  console.log('  ✓ maxNestingDepth flat = 0');
})();

(function testNestingDeep() {
  var body = [
    '    if (a) {',
    '      if (b) {',
    '        if (c) {',
    '          Do();',
    '        }',
    '      }',
    '    }',
  ].join('\n');
  assert.strictEqual(v.maxNestingDepth(body), 3);
  console.log('  ✓ maxNestingDepth nested if = 3');
})();

(function testNestingIgnoresStringBraces() {
  // 字符串和注释里的 { 不应计入嵌套
  var body = 'var s = "{{{";\nvar c = \'{\';\n// {{{\n/* {{{ */\nif (a) { Do(); }';
  assert.strictEqual(v.maxNestingDepth(body), 1);
  console.log('  ✓ maxNestingDepth ignores braces in strings/comments');
})();

(function testNestingVerbatimString() {
  var body = 'var s = @"{{}}{{}}";\nif (a) { Do(); }';
  assert.strictEqual(v.maxNestingDepth(body), 1);
  console.log('  ✓ maxNestingDepth handles verbatim string');
})();

// ============ validateFileSize ============

(function testFileSizeUnderThreshold() {
  var code = new Array(100).fill('// pad').join('\n');
  var w = v.validateFileSize(code, 'Foo.cs', { fileLines: 800 });
  assert.strictEqual(w.length, 0);
  console.log('  ✓ validateFileSize under threshold');
})();

(function testFileSizeOverThreshold() {
  var code = new Array(801).fill('// pad').join('\n');
  var w = v.validateFileSize(code, 'GameFlowManagerMain.cs', { fileLines: 800 });
  assert.strictEqual(w.length, 1);
  assert.strictEqual(w[0].rule, 'delivery-class-file-size');
  assert.strictEqual(w[0].severity, 'warning');
  assert.strictEqual(w[0].file, 'GameFlowManagerMain.cs');
  assert.strictEqual(w[0].details.lines, 801);
  assert.match(w[0].message, /反馈条 4\/5/);
  console.log('  ✓ validateFileSize over threshold emits warning');
})();

// ============ validateMethodLength ============

(function testMethodLengthOk() {
  var code = 'void Foo() {\n' + new Array(5).fill('  Do();').join('\n') + '\n}';
  var w = v.validateMethodLength(code, 'X.cs', { methodLines: 100 });
  assert.strictEqual(w.length, 0);
  console.log('  ✓ validateMethodLength ok');
})();

(function testMethodLengthOver() {
  var bigBody = new Array(150).fill('  Do();').join('\n');
  var code = 'void HandlePlayerInteractions() {\n' + bigBody + '\n}';
  var w = v.validateMethodLength(code, 'GameFlowManagerMain.cs', { methodLines: 100 });
  assert.strictEqual(w.length, 1);
  assert.strictEqual(w[0].rule, 'delivery-method-length');
  assert.strictEqual(w[0].details.method, 'HandlePlayerInteractions');
  assert.ok(w[0].details.lines >= 150);
  assert.match(w[0].message, /反馈条 6/);
  console.log('  ✓ validateMethodLength over threshold');
})();

// ============ validateNestingDepth ============

(function testNestingDepthOk() {
  var code = 'void Foo() {\n  if (a) { Do(); }\n}';
  var w = v.validateNestingDepth(code, 'X.cs', { nestingDepth: 5 });
  assert.strictEqual(w.length, 0);
  console.log('  ✓ validateNestingDepth ok');
})();

(function testNestingDepthOver() {
  var code = [
    'void HandlePlayerInteractions() {',
    '  if (a) {',
    '    if (b) {',
    '      if (c) {',
    '        if (d) {',
    '          if (e) { Do(); }',
    '        }',
    '      }',
    '    }',
    '  }',
    '}',
  ].join('\n');
  var w = v.validateNestingDepth(code, 'GameFlowManagerMain.cs', { nestingDepth: 5 });
  assert.strictEqual(w.length, 1);
  assert.strictEqual(w[0].rule, 'delivery-method-nesting');
  assert.ok(w[0].details.depth >= 5);
  assert.match(w[0].message, /反馈条 6/);
  console.log('  ✓ validateNestingDepth over threshold');
})();

// ============ validateCSharpSource (合并) ============

(function testCombined() {
  var code = [
    'public class GameFlowManagerMain {',
  ].concat(new Array(820).fill('  // pad'))
   .concat([
    '  void HandlePlayerInteractions() {',
   ])
   .concat(new Array(110).fill('    Do();'))
   .concat([
    '  }',
    '}',
  ]).join('\n');
  var w = v.validateCSharpSource(code, 'GameFlowManagerMain.cs');
  // 期望 file-size + method-length 至少各 1 条
  var rules = w.map(function(x) { return x.rule; });
  assert.ok(rules.indexOf('delivery-class-file-size') >= 0, 'expected file-size warning');
  assert.ok(rules.indexOf('delivery-method-length') >= 0, 'expected method-length warning');
  console.log('  ✓ validateCSharpSource combined warnings');
})();

// ============ validateDeliveryDirectory ============

(function testDeliveryDirectory() {
  var os = require('os');
  var fs = require('fs');
  var path = require('path');
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-validator-'));
  try {
    fs.mkdirSync(path.join(tmp, 'Scripts'), { recursive: true });
    // 制造一个超长方法的文件
    var longMethod = 'public class X {\n  void Big() {\n' +
      new Array(150).fill('    Do();').join('\n') +
      '\n  }\n}';
    fs.writeFileSync(path.join(tmp, 'Scripts', 'GameFlowBig.cs'), longMethod);
    // 一个干净的小文件
    fs.writeFileSync(path.join(tmp, 'Scripts', 'GameFlowSmall.cs'),
      'public class S { void Tiny() { Do(); } }');
    // 一个 README,不应被扫到
    fs.writeFileSync(path.join(tmp, 'README.md'), '# stuff');

    var warnings = v.validateDeliveryDirectory(tmp);
    var bigWarnings = warnings.filter(function(w) { return w.file === 'GameFlowBig.cs'; });
    var smallWarnings = warnings.filter(function(w) { return w.file === 'GameFlowSmall.cs'; });
    var mdWarnings = warnings.filter(function(w) { return w.file === 'README.md'; });
    assert.ok(bigWarnings.length >= 1, 'expected warnings for GameFlowBig.cs');
    assert.strictEqual(smallWarnings.length, 0);
    assert.strictEqual(mdWarnings.length, 0);
    console.log('  ✓ validateDeliveryDirectory walks .cs only');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();

// ============ thresholds override ============

(function testThresholdsOverride() {
  // 用极低阈值,让普通代码也触发
  var code = 'void Foo() {\n  Do();\n  Do();\n  Do();\n}';
  var w = v.validateMethodLength(code, 'X.cs', { methodLines: 1 });
  assert.strictEqual(w.length, 1);
  console.log('  ✓ thresholds override works');
})();

console.log('\nAll delivery-class-validator tests passed (18).');
