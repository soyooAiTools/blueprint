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
    // 一个干净的小文件(带方法注释,避免新加的 comment-coverage 规则误报)
    fs.writeFileSync(path.join(tmp, 'Scripts', 'GameFlowSmall.cs'),
      'public class S {\n  // 占位方法\n  void Tiny() { Do(); }\n}');
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

// ============ findFields (Wave B / 反馈条 1) ============

(function testFindFieldsBasic() {
  var code = [
    'public class Foo {',
    '  public int Score = 0;',
    '  private string _name;',
    '  protected float Speed;',
    '  internal Vector3 _pos;',
    '  void DoStuff() { var local = 1; }',
    '}',
  ].join('\n');
  var fields = v.findFields(code);
  var names = fields.map(function(f) { return f.name; });
  assert.deepStrictEqual(names.sort(), ['Score', 'Speed', '_name', '_pos'].sort());
  console.log('  ✓ findFields basic');
})();

(function testFindFieldsSkipsClassDecl() {
  var code = [
    'public class Foo {',
    '  public class Inner {}',
    '  private int X;',
    '}',
  ].join('\n');
  var names = v.findFields(code).map(function(f) { return f.name; });
  assert.deepStrictEqual(names, ['X']);
  console.log('  ✓ findFields skips inner class decl');
})();

// ============ findConditions ============

(function testFindConditionsSkipsTinyBlocks() {
  var code = [
    'void Foo() {',
    '  if (a) return;',
    '  if (b) {',
    '    DoX();',
    '    DoY();',
    '    DoZ();',
    '  }',
    '}',
  ].join('\n');
  // 第一个 if 1 行,跳过;第二个 4 行,被保留(>=3)
  var conds = v.findConditions(code, 3);
  assert.strictEqual(conds.length, 1);
  assert.strictEqual(conds[0].kind, 'if');
  console.log('  ✓ findConditions skips tiny blocks');
})();

// ============ hasCommentAbove ============

(function testCommentAboveLeading() {
  var lines = [
    '// 上面这段注释解释为什么',
    'private int x;',
  ];
  assert.strictEqual(v.hasCommentAbove(lines, 2), true);
  console.log('  ✓ hasCommentAbove: leading // line');
})();

(function testCommentAboveXmlDoc() {
  var lines = [
    '/// <summary>玩家速度</summary>',
    'public float Speed;',
  ];
  assert.strictEqual(v.hasCommentAbove(lines, 2), true);
  console.log('  ✓ hasCommentAbove: /// XML doc');
})();

(function testCommentAboveTrailing() {
  var lines = ['public int Score = 0; // 玩家累计得分'];
  assert.strictEqual(v.hasCommentAbove(lines, 1), true);
  console.log('  ✓ hasCommentAbove: trailing // on same line');
})();

(function testCommentAboveMissing() {
  var lines = ['', '', 'public int Naked;'];
  assert.strictEqual(v.hasCommentAbove(lines, 3), false);
  console.log('  ✓ hasCommentAbove: missing → false');
})();

// ============ validateCommentCoverage ============

(function testCoverageFieldMissing() {
  var code = 'public class X {\n  public int Naked;\n}';
  var w = v.validateCommentCoverage(code, 'X.cs', { conditionMinBlockLines: 3 });
  var fieldWarn = w.find(function(x) { return x.rule === 'delivery-comment-coverage-field'; });
  assert.ok(fieldWarn, 'expected field-coverage warning');
  assert.match(fieldWarn.message, /反馈条 1/);
  console.log('  ✓ coverage: field missing');
})();

(function testCoverageMethodMissing() {
  var code = 'public class X {\n  public void Naked() { Do(); }\n}';
  var w = v.validateCommentCoverage(code, 'X.cs', { conditionMinBlockLines: 3 });
  var methWarn = w.find(function(x) { return x.rule === 'delivery-comment-coverage-method'; });
  assert.ok(methWarn, 'expected method-coverage warning');
  assert.match(methWarn.message, /反馈条 1/);
  console.log('  ✓ coverage: method missing');
})();

(function testCoverageMethodWithDocPasses() {
  var code = [
    'public class X {',
    '  /// <summary>启动逻辑</summary>',
    '  public void Start() { Do(); }',
    '}',
  ].join('\n');
  var w = v.validateCommentCoverage(code, 'X.cs', { conditionMinBlockLines: 3 });
  var methWarn = w.find(function(x) { return x.rule === 'delivery-comment-coverage-method'; });
  assert.strictEqual(methWarn, undefined, 'methods with /// summary should not warn');
  console.log('  ✓ coverage: /// summary satisfies method rule');
})();

(function testCoverageConditionMissing() {
  var code = [
    '// 方法注释',
    'void Handle() {',
    '  if (player.IsDead) {',
    '    LogA();',
    '    LogB();',
    '    LogC();',
    '  }',
    '}',
  ].join('\n');
  var w = v.validateCommentCoverage(code, 'X.cs', { conditionMinBlockLines: 3 });
  var condWarn = w.find(function(x) { return x.rule === 'delivery-comment-coverage-condition'; });
  assert.ok(condWarn, 'expected condition-coverage warning');
  assert.match(condWarn.message, /反馈条 2/);
  console.log('  ✓ coverage: condition missing');
})();

(function testCoverageConditionWithCommentPasses() {
  var code = [
    '// 方法注释',
    'void Handle() {',
    '  // 玩家死亡时清理状态机',
    '  if (player.IsDead) {',
    '    Cleanup();',
    '    Reset();',
    '    Reload();',
    '  }',
    '}',
  ].join('\n');
  var w = v.validateCommentCoverage(code, 'X.cs', { conditionMinBlockLines: 3 });
  var condWarn = w.find(function(x) { return x.rule === 'delivery-comment-coverage-condition'; });
  assert.strictEqual(condWarn, undefined);
  console.log('  ✓ coverage: commented condition does not warn');
})();

(function testCoverageDisableViaOpts() {
  var code = 'public class X {\n  public int Naked;\n  public void Bare() { Do(); }\n}';
  var w = v.validateCSharpSource(code, 'X.cs', { commentCoverage: false });
  var coverageWarns = w.filter(function(x) { return x.rule.indexOf('comment-coverage') >= 0; });
  assert.strictEqual(coverageWarns.length, 0, 'commentCoverage:false should disable rule');
  console.log('  ✓ coverage: opts.commentCoverage=false disables rule');
})();

// ============ Wave D 反馈 6 (2026-05-02) — blocking GateReady 校验 ============

(function testCheckEventRulesShapeCleanIsOK() {
  // 正确的 dispatcher 形态:不出现 EntityAdvanced
  var code = [
    'public class X {',
    '  void CheckEventRules() {',
    '    if (!ruleTriggered[0] && Phase_intro_GateReady()) {',
    '      EnterPhase(0, "intro", true, true);',
    '      Phase_intro_Init();',
    '      return;',
    '    }',
    '    if (!gameEnded && EndGame_GateReady()) { FinishGame("intro"); return; }',
    '  }',
    '}',
  ].join('\n');
  var errs = v.validateCheckEventRulesShape(code, 'X.cs');
  assert.strictEqual(errs.length, 0, 'clean dispatcher should produce no errors, got: ' + JSON.stringify(errs));
  console.log('  ✓ check-event-rules-shape: clean dispatcher passes');
})();

(function testCheckEventRulesShapeFlagsInlinedGate() {
  // 回归到内联 gate (EntityAdvanced) — 必须报错
  var code = [
    'public class X {',
    '  void CheckEventRules() {',
    '    if (!ruleTriggered[0] && phaseTimer >= 1f && EntityAdvanced(player, _snap_playerPos)) {',
    '      EnterPhase(0, "intro", true, true);',
    '    }',
    '  }',
    '}',
  ].join('\n');
  var errs = v.validateCheckEventRulesShape(code, 'X.cs');
  assert.strictEqual(errs.length, 1);
  assert.strictEqual(errs[0].rule, 'delivery-check-event-rules-shape');
  assert.strictEqual(errs[0].severity, 'error');
  console.log('  ✓ check-event-rules-shape: inlined EntityAdvanced flagged');
})();

(function testGateReadyCoverageMissing() {
  // 临时目录:main 调用 EnterPhase("intro") + EnterPhase("collectIce")
  // 但 flow 文件只定义 Phase_intro_GateReady,缺 collectIce
  var fs = require('fs');
  var path = require('path');
  var os = require('os');
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ready-test-'));
  try {
    fs.writeFileSync(path.join(tmp, 'GameFlowManagerMain.cs'),
      'public partial class GameFlowManagerMain {\n' +
      '  void CheckEventRules() {\n' +
      '    if (Phase_intro_GateReady()) EnterPhase(0, "intro", true, true);\n' +
      '    if (Phase_collectIce_GateReady()) EnterPhase(1, "collectIce", true, true);\n' +
      '  }\n' +
      '}\n');
    fs.writeFileSync(path.join(tmp, 'GameFlowManagerMain.Flow.cs'),
      'public partial class GameFlowManagerMain {\n' +
      '  bool Phase_intro_GateReady() { return true; }\n' +
      '}\n');
    var errs = v.validateGateReadyCoverage(tmp);
    assert.strictEqual(errs.length, 1);
    assert.strictEqual(errs[0].rule, 'delivery-gate-ready-missing');
    assert.strictEqual(errs[0].details.phaseId, 'collectIce');
    console.log('  ✓ gate-ready-coverage: missing GateReady flagged');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();

(function testGateReadyCoverageComplete() {
  // 全部 EnterPhase 都有对应 GateReady,不应报错
  var fs = require('fs');
  var path = require('path');
  var os = require('os');
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ready-test-'));
  try {
    fs.writeFileSync(path.join(tmp, 'GameFlowManagerMain.cs'),
      'public partial class GameFlowManagerMain {\n' +
      '  void CheckEventRules() {\n' +
      '    if (Phase_intro_GateReady()) EnterPhase(0, "intro", true, true);\n' +
      '  }\n' +
      '}\n');
    fs.writeFileSync(path.join(tmp, 'GameFlowManagerMain.Flow.cs'),
      'public partial class GameFlowManagerMain {\n' +
      '  bool Phase_intro_GateReady() { return true; }\n' +
      '}\n');
    var errs = v.validateGateReadyCoverage(tmp);
    assert.strictEqual(errs.length, 0, 'complete coverage should pass, got: ' + JSON.stringify(errs));
    console.log('  ✓ gate-ready-coverage: complete coverage passes');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();

// ============ 反馈 01 #1/#6 — class hierarchy violation (blocking) ============

(function testClassHierarchyClean() {
  var fs = require('fs');
  var path = require('path');
  var os = require('os');
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'class-hierarchy-clean-'));
  try {
    fs.mkdirSync(path.join(tmp, 'Scripts'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'Scripts', 'GameFlowManagerMain.cs'), 'public class GameFlowManagerMain {}');
    fs.writeFileSync(path.join(tmp, 'Scripts', 'BaseBuildElement.cs'), 'public class BaseBuildElement {}');
    fs.writeFileSync(path.join(tmp, 'Scripts', 'BuildEntity.cs'), 'public class BuildEntity : BaseBuildElement {}');
    var errs = v.validateClassHierarchy(tmp);
    assert.strictEqual(errs.length, 0, '领域 OOP 命名不该报错, got: ' + JSON.stringify(errs));
    console.log('  ✓ class-hierarchy: domain-named classes pass');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();

(function testClassHierarchyFlagsForbiddenBase() {
  var fs = require('fs');
  var path = require('path');
  var os = require('os');
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'class-hierarchy-bad-'));
  try {
    fs.mkdirSync(path.join(tmp, 'Scripts'), { recursive: true });
    // 三个不同维度的横切拆分都应被抓
    fs.writeFileSync(path.join(tmp, 'Scripts', 'GameFlowPhaseFlowBase.cs'), '// stub');
    fs.writeFileSync(path.join(tmp, 'Scripts', 'GameFlowRuntimeBase.cs'), '// stub');
    fs.writeFileSync(path.join(tmp, 'Scripts', 'GameFlowUiBase.cs'), '// stub');
    // 一个允许的也放进来作 sanity 对照
    fs.writeFileSync(path.join(tmp, 'Scripts', 'GameFlowManagerMain.cs'), 'public class GameFlowManagerMain {}');
    var errs = v.validateClassHierarchy(tmp);
    assert.strictEqual(errs.length, 3, '应该抓到 3 条横切拆分, got ' + errs.length + ': ' + JSON.stringify(errs));
    errs.forEach(function(e) {
      assert.strictEqual(e.rule, 'delivery-class-hierarchy-violation');
      assert.strictEqual(e.severity, 'error');
      assert.match(e.message, /反馈 01 #1\/#6/);
    });
    var files = errs.map(function(e) { return path.basename(e.file); }).sort();
    assert.deepStrictEqual(files, ['GameFlowPhaseFlowBase.cs', 'GameFlowRuntimeBase.cs', 'GameFlowUiBase.cs']);
    console.log('  ✓ class-hierarchy: forbidden cross-cut base files flagged');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();

(function testClassHierarchyCaseInsensitive() {
  // 文件系统大小写敏感性不一,显式黑名单做小写归一对照
  var fs = require('fs');
  var path = require('path');
  var os = require('os');
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'class-hierarchy-case-'));
  try {
    fs.mkdirSync(path.join(tmp, 'Scripts'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'Scripts', 'GameFlowUIBase.cs'), '// stub'); // UI 全大写变体
    var errs = v.validateClassHierarchy(tmp);
    assert.strictEqual(errs.length, 1);
    assert.strictEqual(errs[0].rule, 'delivery-class-hierarchy-violation');
    console.log('  ✓ class-hierarchy: UI casing variant flagged');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();

(function testValidateBlockingRulesIncludesHierarchy() {
  var fs = require('fs');
  var path = require('path');
  var os = require('os');
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blocking-hierarchy-'));
  try {
    fs.mkdirSync(path.join(tmp, 'Scripts'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'Scripts', 'GameFlowStateBase.cs'), '// stub');
    var errs = v.validateBlockingRules(tmp);
    assert.ok(errs.some(function(e) { return e.rule === 'delivery-class-hierarchy-violation'; }),
      'validateBlockingRules 应聚合 class-hierarchy-violation');
    console.log('  ✓ validateBlockingRules: class-hierarchy errors surface');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();

// ============ 反馈 01 #7 — unnamed scene object (.unity YAML warning) ============

(function testUnnamedSceneObjectFlagsPrimitiveName() {
  var fs = require('fs');
  var path = require('path');
  var os = require('os');
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unnamed-scene-'));
  try {
    fs.mkdirSync(path.join(tmp, 'Assets', 'Scenes'), { recursive: true });
    // 三种 default 命名变体:裸名 / (Clone) / (1)
    fs.writeFileSync(path.join(tmp, 'Assets', 'Scenes', 'Main.unity'),
      [
        '%YAML 1.1',
        '--- !u!1 &123',
        'GameObject:',
        '  m_Name: Cube',
        '--- !u!1 &124',
        'GameObject:',
        '  m_Name: Cylinder (Clone)',
        '--- !u!1 &125',
        'GameObject:',
        '  m_Name: Sphere (1)',
        '--- !u!1 &126',
        'GameObject:',
        '  m_Name: 我方基地', // 领域名,不该被抓
      ].join('\n'));
    var warns = v.validateUnnamedSceneObjects(tmp);
    assert.strictEqual(warns.length, 3, '三个 primitive default 名应被抓, got: ' + JSON.stringify(warns));
    warns.forEach(function(w) {
      assert.strictEqual(w.rule, 'unnamed-scene-object');
      assert.strictEqual(w.severity, 'warning');
      assert.match(w.message, /反馈 01 #7/);
    });
    var primitives = warns.map(function(w) { return w.details.primitive; }).sort();
    assert.deepStrictEqual(primitives, ['Cube', 'Cylinder', 'Sphere']);
    console.log('  ✓ unnamed-scene-object: primitive m_Name flagged');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();

(function testUnnamedSceneObjectIgnoresNonUnity() {
  var fs = require('fs');
  var path = require('path');
  var os = require('os');
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unnamed-scene-skip-'));
  try {
    fs.mkdirSync(path.join(tmp, 'Scripts'), { recursive: true });
    // .cs 文件即使含 m_Name: Cube 字符串也不应被扫(那是注释里出现的可能性)
    fs.writeFileSync(path.join(tmp, 'Scripts', 'Foo.cs'), '// m_Name: Cube\npublic class Foo {}');
    // .meta 之类 Unity 配套文件也不扫
    fs.writeFileSync(path.join(tmp, 'Scripts', 'Foo.cs.meta'), 'fileFormatVersion: 2\nm_Name: Cube');
    var warns = v.validateUnnamedSceneObjects(tmp);
    assert.strictEqual(warns.length, 0);
    console.log('  ✓ unnamed-scene-object: only .unity files scanned');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();

(function testUnnamedSceneObjectFolderWalk() {
  // 嵌套目录下的 .unity 文件也要扫到
  var fs = require('fs');
  var path = require('path');
  var os = require('os');
  var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unnamed-scene-walk-'));
  try {
    fs.mkdirSync(path.join(tmp, 'Assets', 'Scenes', 'Sub'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'Assets', 'Scenes', 'Sub', 'Nested.unity'),
      'GameObject:\n  m_Name: Plane\n');
    var warns = v.validateUnnamedSceneObjects(tmp);
    assert.strictEqual(warns.length, 1);
    assert.strictEqual(warns[0].details.primitive, 'Plane');
    console.log('  ✓ unnamed-scene-object: nested folders walked');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();

console.log('\nAll delivery-class-validator tests passed (40).');
