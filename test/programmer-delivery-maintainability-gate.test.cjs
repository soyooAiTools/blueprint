'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var gate = require('../lib/programmer-delivery-maintainability-gate.cjs');

function lineCount(text) {
  return String(text || '').split(/\r?\n/).length;
}

function makeRoot(options) {
  options = options || {};
  var root = fs.mkdtempSync(path.join(os.tmpdir(), 'programmer-maintainability-'));
  fs.mkdirSync(path.join(root, 'Assets', 'Scripts', 'Core', 'Modules'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Assets', 'Scripts', 'Core', 'Common'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Assets', 'Scripts', 'Core', 'Base'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Assets', 'Scripts', 'Core', 'Components'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Assets', 'Scripts', 'Game', 'Entities'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Assets', 'Scripts', 'Game', 'Level'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Assets', 'Scripts', 'Game', 'Player'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Assets', 'Scripts', 'Tool'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Assets', 'Scenes'), { recursive: true });

  var main = [
    'public class GMP_MainManager : MonoSingleton<GMP_MainManager>',
    '{',
    '  GMP_LevelRuleEngine mLevel = new GMP_LevelRuleEngine();',
    '  GMP_ChefEntity mChef = new GMP_ChefEntity();',
    '  public void Start() { InitCoreModules(); mLevel.TryServe(mChef); }',
    '  public void Update() { }',
    '  void InitCoreModules() { }',
    '}',
  ].join('\n');
  fs.writeFileSync(path.join(root, 'Assets', 'Scripts', 'Core', 'Modules', 'GMP_MainManager.cs'), main);
  fs.writeFileSync(path.join(root, 'Assets', 'Scripts', 'Game', 'Level', 'GMP_LevelRuleEngine.cs'), [
    'public class GMP_LevelRuleEngine',
    '{',
    '  public void TryServe(GMP_ChefEntity chef) { chef.AddServedCount(); }',
    options.unusedMethodLeak ? '  public void NeverCalled() { }' : '',
    '}',
  ].filter(Boolean).join('\n'));
  fs.writeFileSync(path.join(root, 'Assets', 'Scripts', 'Game', 'Entities', 'GMP_ChefEntity.cs'), options.thinEntity ? [
    'public class GMP_ChefEntity : GMP_BaseGameFlowEntity',
    '{',
    '  public const string Id = "_chef";',
    '}',
  ].join('\n') : [
    'public class GMP_ChefEntity : GMP_BaseGameFlowEntity',
    '{',
    '  public int ServedCount;',
    '  public string CurrentRecipe = "shrimp";',
    '  public void AddServedCount() { ServedCount += 1; }',
    '}',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'source-scene-ir.json'), JSON.stringify(options.sourceIr || {
    schemaVersion: 'source-scene-ir.v1',
    project: { name: 'chef' },
    entities: [{ id: '_chef', label: 'Chef' }],
    phases: [{ phaseId: 'serve', guideText: 'Serve shrimp' }]
  }, null, 2));
  fs.writeFileSync(path.join(root, 'README.md'), '# Unity 工程导出\n\n## 程序员交付边界\n- Core / Tool / Game\n');
  fs.writeFileSync(path.join(root, 'CODE_RELATION_GRAPH.md'), options.staleDocs
    ? '# 代码关系图\n\nUpdate -> CheckEventRules -> GFM_Player -> Phase_OnTap\n'
    : (options.missingDocRef
    ? '# 代码关系图\n\n请从 `Core/Modules/GMP_MissingManager.cs` 开始阅读。\n'
    : '# 代码关系图\n\nGMP_MainManager -> GMP_PhaseController -> GMP_LevelRuleEngine\n'));
  if (options.missingDocRef) {
    fs.appendFileSync(path.join(root, 'README.md'), '\n- `Assets/Scripts/Game/Level/GMP_MissingFeature.cs`\n');
  }
  fs.writeFileSync(path.join(root, 'PROGRAMMER_HANDOFF.md'), [
    '# 程序员交付版说明',
    '',
    '## 清理统计',
    '- GMP_MainManager.cs 行数：' + (options.staleLineCount ? 999 : lineCount(main)),
    ''
  ].join('\n'));
  if (options.legacyLeak) {
    fs.writeFileSync(path.join(root, 'Assets', 'Scripts', 'Game', 'Level', 'GMP_OxygenLeak.cs'), [
      'public class GMP_OxygenLeak',
      '{',
      '  public string Legacy = "Oxygen";',
      '}',
    ].join('\n'));
  }
  if (options.findOveruse) {
    var lines = ['using UnityEngine;', 'public class GMP_FindLeak', '{', '  public void Bind()', '  {'];
    for (var i = 0; i < 25; i++) lines.push('    GameObject.Find("Obj' + i + '");');
    lines.push('  }', '}');
    fs.writeFileSync(path.join(root, 'Assets', 'Scripts', 'Game', 'Level', 'GMP_FindLeak.cs'), lines.join('\n'));
  }
  if (options.addComponentLeak) {
    fs.writeFileSync(path.join(root, 'Assets', 'Scripts', 'Game', 'Level', 'GMP_AddComponentLeak.cs'), [
      'using UnityEngine;',
      'public class GMP_AddComponentLeak',
      '{',
      '  public void Bind(GameObject obj)',
      '  {',
      '    if (obj == null) return;',
      '    obj.AddComponent<GMP_ChefEntity>();',
      '  }',
      '}'
    ].join('\n'));
  }
  if (options.newGameObjectLeak) {
    fs.writeFileSync(path.join(root, 'Assets', 'Scripts', 'Game', 'Level', 'GMP_NewObjectLeak.cs'), [
      'using UnityEngine;',
      'public class GMP_NewObjectLeak',
      '{',
      '  public GameObject Build() { return new GameObject("RuntimeOnly"); }',
      '}'
    ].join('\n'));
  }
  if (options.vectorDistanceLeak) {
    fs.writeFileSync(path.join(root, 'Assets', 'Scripts', 'Game', 'Level', 'GMP_DistanceLeak.cs'), [
      'using UnityEngine;',
      'public class GMP_DistanceLeak',
      '{',
      '  public bool IsNear(Vector3 a, Vector3 b) { return Vector3.Distance(a, b) < 2f; }',
      '}'
    ].join('\n'));
  }
  if (options.staticWorkflowLeak) {
    fs.writeFileSync(path.join(root, 'Assets', 'Scripts', 'Core', 'Modules', 'GMP_StaticWorkflowLeak.cs'), [
      'public class GMP_StaticWorkflowLeak',
      '{',
      '  public static void Init() { }',
      '}'
    ].join('\n'));
  }
  if (options.duplicateStateLeak) {
    fs.writeFileSync(path.join(root, 'Assets', 'Scripts', 'Game', 'Player', 'GMP_Player.cs'), [
      'public class GMP_Player : GMP_PlayerBase',
      '{',
      '  public struct FormDef { public string formId; public float moveSpeed; }',
      '  public FormDef[] Forms;',
      '  public float MoveSpeed { get { return Forms != null && Forms.Length > 0 ? Forms[0].moveSpeed : 6f; } }',
      '}'
    ].join('\n'));
    fs.writeFileSync(path.join(root, 'Assets', 'Scripts', 'Core', 'Base', 'GMP_PlayerBase.cs'), [
      'public class GMP_PlayerBase',
      '{',
      '  public float mMoveSpeed = 4f;',
      '}'
    ].join('\n'));
    fs.writeFileSync(path.join(root, 'Assets', 'Scripts', 'Core', 'Components', 'GMP_MovementComponent.cs'), [
      'public class GMP_MovementComponent',
      '{',
      '  public float mDefaultSpeed = 5f;',
      '}'
    ].join('\n'));
    fs.writeFileSync(path.join(root, 'Assets', 'Scripts', 'Core', 'Modules', 'GMP_EconomyManager.cs'), [
      'public class GMP_EconomyManager',
      '{',
      '  private int[] mInvVals = new int[8];',
      '  private int mGold = 0;',
      '}'
    ].join('\n'));
    fs.writeFileSync(path.join(root, 'Assets', 'Scripts', 'Core', 'Modules', 'GMP_UIManager.cs'), [
      'public class GMP_UIManager',
      '{',
      '  public object mTargetHintText;',
      '  public void SetTargetHint(string targetEntity) {}',
      '}'
    ].join('\n'));
    fs.writeFileSync(path.join(root, 'Assets', 'Scripts', 'Core', 'Modules', 'GMP_HudController.cs'), [
      'public class GMP_HudController',
      '{',
      '  public object mTargetHintText;',
      '  public void SetTargetHint(string targetEntity) {}',
      '}'
    ].join('\n'));
  }
  if (options.missingMainFile) {
    fs.rmSync(path.join(root, 'Assets', 'Scripts', 'Core', 'Modules', 'GMP_MainManager.cs'), { force: true });
  }
  return root;
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

var cleanRoot = makeRoot();
try {
  var clean = gate.validateMaintainability(cleanRoot, { strict: true });
  assert.strictEqual(clean.passed, true, JSON.stringify(clean.errors, null, 2));
  assert.strictEqual(clean.summary.thinEntityClassCount, 0);
} finally {
  cleanup(cleanRoot);
}

var staleRoot = makeRoot({ staleDocs: true });
try {
  var stale = gate.validateMaintainability(staleRoot, { strict: true });
  assert.strictEqual(stale.passed, false);
  assert.ok(stale.errors.some(function(error) { return error.code === 'stale-v14-delivery-docs'; }));
} finally {
  cleanup(staleRoot);
}

var thinRoot = makeRoot({ thinEntity: true });
try {
  var thin = gate.validateMaintainability(thinRoot, { strict: true });
  assert.strictEqual(thin.passed, false);
  assert.ok(thin.errors.some(function(error) { return error.code === 'thin-entity-classes'; }));
} finally {
  cleanup(thinRoot);
}

var leakRoot = makeRoot({ legacyLeak: true });
try {
  var leak = gate.validateMaintainability(leakRoot, { strict: true });
  assert.strictEqual(leak.passed, false);
  assert.ok(leak.errors.some(function(error) { return error.code === 'legacy-project-token-leakage'; }));
} finally {
  cleanup(leakRoot);
}

var allowedLeakRoot = makeRoot({
  legacyLeak: true,
  sourceIr: {
    schemaVersion: 'source-scene-ir.v1',
    project: { name: 'space oxygen game' },
    entities: [{ id: '_oxygen', label: 'Oxygen shop' }],
    phases: []
  }
});
try {
  var allowedLeak = gate.validateMaintainability(allowedLeakRoot, { strict: true });
  assert.strictEqual(allowedLeak.passed, true, JSON.stringify(allowedLeak.errors, null, 2));
} finally {
  cleanup(allowedLeakRoot);
}

var lineRoot = makeRoot({ staleLineCount: true });
try {
  var lineReport = gate.validateMaintainability(lineRoot, { strict: true });
  assert.strictEqual(lineReport.passed, false);
  assert.ok(lineReport.errors.some(function(error) { return error.code === 'handoff-main-line-count-stale'; }));
} finally {
  cleanup(lineRoot);
}

var missingMainRoot = makeRoot({ missingMainFile: true });
try {
  var missingMainReport = gate.validateMaintainability(missingMainRoot, { strict: true });
  assert.strictEqual(missingMainReport.passed, false);
  assert.ok(missingMainReport.errors.some(function(error) { return error.code === 'handoff-main-line-count-missing-file'; }));
} finally {
  cleanup(missingMainRoot);
}

var missingDocRefRoot = makeRoot({ missingDocRef: true });
try {
  var missingDocRefReport = gate.validateMaintainability(missingDocRefRoot, { strict: true });
  assert.strictEqual(missingDocRefReport.passed, false);
  assert.ok(missingDocRefReport.errors.some(function(error) { return error.code === 'doc-script-reference-missing'; }));
} finally {
  cleanup(missingDocRefRoot);
}

var findRoot = makeRoot({ findOveruse: true });
try {
  var findReport = gate.validateMaintainability(findRoot, { strict: true });
  assert.strictEqual(findReport.passed, false);
  assert.ok(findReport.errors.some(function(error) { return error.code === 'gameobject-find-overuse'; }));
} finally {
  cleanup(findRoot);
}

var addComponentRoot = makeRoot({ addComponentLeak: true });
try {
  var addComponentReport = gate.validateMaintainability(addComponentRoot, { strict: true });
  assert.strictEqual(addComponentReport.passed, false);
  assert.ok(addComponentReport.errors.some(function(error) { return error.code === 'addcomponent-runtime-binding'; }));
  assert.strictEqual(addComponentReport.summary.addComponentGameLayerCount, 1);
} finally {
  cleanup(addComponentRoot);
}

var newGameObjectRoot = makeRoot({ newGameObjectLeak: true });
try {
  var newGameObjectReport = gate.validateMaintainability(newGameObjectRoot, { strict: true });
  assert.strictEqual(newGameObjectReport.passed, false);
  assert.ok(newGameObjectReport.errors.some(function(error) { return error.code === 'new-gameobject-runtime-binding'; }));
  assert.strictEqual(newGameObjectReport.summary.newGameObjectGameLayerCount, 1);
} finally {
  cleanup(newGameObjectRoot);
}

var unusedMethodRoot = makeRoot({ unusedMethodLeak: true });
try {
  var unusedMethodReport = gate.validateMaintainability(unusedMethodRoot, { strict: true });
  assert.strictEqual(unusedMethodReport.passed, false);
  assert.ok(unusedMethodReport.errors.some(function(error) { return error.code === 'unused-methods'; }));
  assert.strictEqual(unusedMethodReport.summary.unusedMethodCount, 1);
} finally {
  cleanup(unusedMethodRoot);
}

var distanceRoot = makeRoot({ vectorDistanceLeak: true });
try {
  var distanceReport = gate.validateMaintainability(distanceRoot, { strict: true });
  assert.strictEqual(distanceReport.passed, false);
  assert.ok(distanceReport.errors.some(function(error) { return error.code === 'vector3-distance-threshold'; }));
  assert.strictEqual(distanceReport.summary.vector3DistanceCount, 1);
} finally {
  cleanup(distanceRoot);
}

var staticWorkflowRoot = makeRoot({ staticWorkflowLeak: true });
try {
  var staticWorkflowReport = gate.validateMaintainability(staticWorkflowRoot, { strict: true });
  assert.strictEqual(staticWorkflowReport.passed, false);
  assert.ok(staticWorkflowReport.errors.some(function(error) { return error.code === 'static-workflow-methods'; }));
  assert.strictEqual(staticWorkflowReport.summary.staticWorkflowMethodCount, 1);
} finally {
  cleanup(staticWorkflowRoot);
}

var duplicateStateRoot = makeRoot({ duplicateStateLeak: true });
try {
  var duplicateStateReport = gate.validateMaintainability(duplicateStateRoot, { strict: true });
  assert.strictEqual(duplicateStateReport.passed, false);
  assert.ok(duplicateStateReport.errors.some(function(error) { return error.code === 'duplicate-state-owners'; }));
  assert.ok(duplicateStateReport.summary.duplicateStateOwnerCount >= 4);
} finally {
  cleanup(duplicateStateRoot);
}

console.log('programmer delivery maintainability gate tests passed');
