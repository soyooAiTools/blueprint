'use strict';

var assert = require('assert');
var crypto = require('crypto');
var fs = require('fs');
var os = require('os');
var path = require('path');

var hardgate = require('../lib/programmer-delivery-hardgate.cjs');
var hydration = require('../lib/programmer-delivery-hydration-report.cjs');

function walkFiles(root) {
  var files = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function(entry) {
      var full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    });
  }
  walk(root);
  return files.sort();
}

function hashTree(root) {
  var hash = crypto.createHash('sha256');
  walkFiles(root).forEach(function(file) {
    hash.update(path.relative(root, file).split(path.sep).join('/'));
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  });
  return hash.digest('hex');
}

function hashSourceArtifacts(root) {
  var hash = crypto.createHash('sha256');
  [
    'source-scene-ir.json',
    'source-ir.json',
    'source-ir-preview.html',
    'asset-manifest.json'
  ].forEach(function(rel) {
    var file = path.join(root, rel);
    if (!fs.existsSync(file)) return;
    hash.update(rel);
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  });
  return hash.digest('hex');
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function guidForRel(rel) {
  return crypto.createHash('sha1').update(rel).digest('hex').slice(0, 32);
}

function ensureMeta(root, rel) {
  var file = path.join(root, rel);
  writeFile(file + '.meta', [
    'fileFormatVersion: 2',
    'guid: ' + guidForRel(rel),
    'MonoImporter:',
    '  externalObjects: {}',
    ''
  ].join('\n'));
  return guidForRel(rel);
}

function countCodeLines(text) {
  var lines = String(text || '').split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

function sceneObjectYaml(name, guid, index, audio) {
  var go = 1000 + index * 100;
  var tr = go + 1;
  var mb = go + 2;
  var lines = [
    '--- !u!1 &' + go,
    'GameObject:',
    '  m_Component:',
    '  - component: {fileID: ' + tr + '}',
    '  - component: {fileID: ' + mb + '}'
  ];
  if (audio) {
    for (var a = 0; a < 4; a++) lines.push('  - component: {fileID: ' + (go + 10 + a) + '}');
  }
  lines = lines.concat([
    '  m_Name: ' + name,
    '--- !u!4 &' + tr,
    'Transform:',
    '  m_GameObject: {fileID: ' + go + '}',
    '--- !u!114 &' + mb,
    'MonoBehaviour:',
    '  m_GameObject: {fileID: ' + go + '}',
    '  m_Script: {fileID: 11500000, guid: ' + guid + ', type: 3}'
  ]);
  if (audio) {
    for (var i = 0; i < 4; i++) {
      lines = lines.concat([
        '--- !u!82 &' + (go + 10 + i),
        'AudioSource:',
        '  m_GameObject: {fileID: ' + go + '}'
      ]);
    }
  }
  return lines.join('\n');
}

function writeRequiredScene(root) {
  var required = [
    { name: 'GMP_MainManager', rel: 'Assets/Scripts/Core/Modules/GMP_MainManager.cs' },
    { name: 'GMP_PhaseController', rel: 'Assets/Scripts/Core/Modules/GMP_PhaseController.cs' },
    { name: 'GMP_Audio', rel: 'Assets/Scripts/Core/Modules/GMP_Audio.cs', audio: true },
    { name: 'GMP_UIManager', rel: 'Assets/Scripts/Core/Modules/GMP_UIManager.cs' },
    { name: 'GMP_HudController', rel: 'Assets/Scripts/Core/Modules/GMP_HudController.cs' },
    { name: 'GMP_EventModule', rel: 'Assets/Scripts/Core/Modules/GMP_EventModule.cs' },
    { name: 'GMP_CameraController', rel: 'Assets/Scripts/Tool/GMP_CameraController.cs' },
    { name: 'GMP_EntityBindingManager', rel: 'Assets/Scripts/Game/Level/GMP_EntityBindingManager.cs' },
    { name: 'GMP_LevelRuleEngine', rel: 'Assets/Scripts/Game/Level/GMP_LevelRuleEngine.cs' },
    { name: 'GMP_Player', rel: 'Assets/Scripts/Game/Player/GMP_Player.cs' },
    { name: 'GMP_AutoPlayDriver', rel: 'Assets/Scripts/Game/AutoPlay/GMP_AutoPlayDriver.cs' }
  ];
  writeFile(path.join(root, 'Assets', 'Scenes', 'Game.unity'), ['%YAML 1.1'].concat(required.map(function(item, index) {
    return sceneObjectYaml(item.name, ensureMeta(root, item.rel), index + 1, item.audio);
  }), ['']).join('\n'));
}

function makeDeliverableRoot() {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), 'programmer-feature-sim-'));
  fs.mkdirSync(path.join(root, 'Assets', 'Scripts', 'Core', 'Base'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Assets', 'Scripts', 'Core', 'Modules'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Assets', 'Scripts', 'Game', 'Entities'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Assets', 'Scripts', 'Game', 'Level'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Assets', 'Scripts', 'Game', 'AutoPlay'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Assets', 'Scripts', 'Game', 'Player'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Assets', 'Scripts', 'Tool'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Assets', 'Scenes'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Packages'), { recursive: true });
  writeFile(path.join(root, 'Packages', 'manifest.json'), JSON.stringify({ dependencies: {} }, null, 2) + '\n');
  writeFile(path.join(root, 'source-scene-ir.json'), JSON.stringify({
    schemaVersion: 'source-scene-ir.v1',
    project: { id: 'chef-sim', name: 'Chef feature simulation' },
    entities: [{ id: '_chef', label: 'Chef' }, { id: '_shrimpPlate', label: 'Shrimp plate' }],
    phases: [{ phaseId: 'serve', guideText: 'Serve shrimp' }]
  }, null, 2) + '\n');
  writeFile(path.join(root, 'source-ir.json'), JSON.stringify({
    kind: 'blueprint.sourceIR',
    phases: [{ id: 'serve', guideText: 'Serve shrimp' }]
  }, null, 2) + '\n');
  writeFile(path.join(root, 'asset-manifest.json'), JSON.stringify({ entities: ['_chef', '_shrimpPlate'] }, null, 2) + '\n');
  writeFile(path.join(root, 'source-ir-preview.html'), '<!doctype html><title>Chef feature simulation</title>\n');

  var main = [
    'public class GMP_MainManager : MonoSingleton<GMP_MainManager>',
    '{',
    '    public void InitCoreModules() {}',
    '    public void Start() { InitCoreModules(); }',
    '    public void Update() {}',
    '}',
    ''
  ].join('\n');
  writeFile(path.join(root, 'Assets', 'Scripts', 'Core', 'Modules', 'GMP_MainManager.cs'), main);
  writeFile(path.join(root, 'Assets', 'Scripts', 'Core', 'Modules', 'GMP_PhaseController.cs'), [
    'public class GMP_PhaseController : MonoSingleton<GMP_PhaseController>',
    '{',
    '    public void StartFlow() {}',
    '    public void Tick(float dt) {}',
    '}',
    ''
  ].join('\n'));
  writeFile(path.join(root, 'Assets', 'Scripts', 'Core', 'Modules', 'GMP_Audio.cs'), [
    'using UnityEngine;',
    'public class GMP_Audio : MonoBehaviour',
    '{',
    '    public AudioSource[] mLoopSources = new AudioSource[0];',
    '    public AudioSource[] mOneShotSources = new AudioSource[0];',
    '    public void PlayLoop(string key, AudioClip clip) {}',
    '    public void StopLoop(string key) {}',
    '    public void PlayOneShot(AudioClip clip) {}',
    '    public void PlayBGM(AudioClip clip) { PlayLoop("bgm", clip); }',
    '    public void PlaySFX(AudioClip clip) { PlayOneShot(clip); }',
    '}',
    ''
  ].join('\n'));
  writeFile(path.join(root, 'Assets', 'Scripts', 'Core', 'Modules', 'GMP_UIManager.cs'), [
    'public class GMP_UIManager : MonoSingleton<GMP_UIManager>',
    '{',
    '    public void SyncSceneEntityLabels() {}',
    '}',
    ''
  ].join('\n'));
  writeFile(path.join(root, 'Assets', 'Scripts', 'Core', 'Modules', 'GMP_HudController.cs'), [
    'public class GMP_HudController : MonoSingleton<GMP_HudController>',
    '{',
    '    public void SetGuideText(int index, int count, string text) {}',
    '}',
    ''
  ].join('\n'));
  writeFile(path.join(root, 'Assets', 'Scripts', 'Core', 'Modules', 'GMP_EventModule.cs'), [
    'public class GMP_EventModule : MonoSingleton<GMP_EventModule>',
    '{',
    '    public void Publish(string eventName, string payload) {}',
    '}',
    ''
  ].join('\n'));
  writeFile(path.join(root, 'Assets', 'Scripts', 'Core', 'Modules', 'GMP_PhasePreset.cs'), [
    'public class GMP_PhaseStep',
    '{',
    '    public GMP_EntityState mSetState = GMP_EntityState.Hidden;',
    '}',
    ''
  ].join('\n'));
  writeFile(path.join(root, 'Assets', 'Scripts', 'Core', 'Base', 'MonoSingleton.cs'), [
    'using UnityEngine;',
    'public class MonoSingleton<T> : MonoBehaviour where T : MonoBehaviour',
    '{',
    '    public static T instance;',
    '}',
    ''
  ].join('\n'));
  writeFile(path.join(root, 'Assets', 'Scripts', 'Core', 'Base', 'GMP_EntityState.cs'), [
    'public enum GMP_EntityState',
    '{',
    '    Hidden = 0,',
    '    Active = 1,',
    '    Completed = 2',
    '}',
    ''
  ].join('\n'));
  writeFile(path.join(root, 'Assets', 'Scripts', 'Core', 'Base', 'GMP_BaseGameFlowEntity.cs'), [
    'using UnityEngine;',
    'public class GMP_BaseGameFlowEntity : MonoBehaviour',
    '{',
    '    public GameObject SourceObject;',
    '    public GMP_EntityState mState = GMP_EntityState.Hidden;',
    '    public int InteractionCount = 0;',
    '    public bool IsCompleted = false;',
    '    public Vector3 InitialPosition = Vector3.zero;',
    '    public Vector3 LastKnownPosition = Vector3.zero;',
    '    public virtual void Bind(GameObject source, string entityId, string displayName) { SourceObject = source; }',
    '    public virtual void MarkInteracted() { InteractionCount += 1; }',
    '    public virtual void MarkCompleted() { IsCompleted = true; mState = GMP_EntityState.Completed; }',
    '    public virtual void ResetProgress() { InteractionCount = 0; IsCompleted = false; mState = GMP_EntityState.Hidden; }',
    '    public virtual void MoveToPosition(Vector3 target, float duration = 0.25f) {}',
    '}',
    ''
  ].join('\n'));
  writeFile(path.join(root, 'Assets', 'Scripts', 'Core', 'Base', 'GMP_PlayerBase.cs'), [
    'public class GMP_PlayerBase : GMP_BaseGameFlowEntity',
    '{',
    '    public float MoveSpeed = 6f;',
    '}',
    ''
  ].join('\n'));
  writeFile(path.join(root, 'Assets', 'Scripts', 'Tool', 'GMP_CameraController.cs'), [
    'public class GMP_CameraController',
    '{',
    '    public void FrameCurrentPhase() {}',
    '}',
    ''
  ].join('\n'));
  writeFile(path.join(root, 'Assets', 'Scripts', 'Game', 'Player', 'GMP_Player.cs'), [
    'public class GMP_Player : GMP_PlayerBase',
    '{',
    '    public void TickInput(float dt) {}',
    '}',
    ''
  ].join('\n'));
  writeFile(path.join(root, 'Assets', 'Scripts', 'Game', 'Entities', 'GMP_RestaurantEntity.cs'), [
    'using UnityEngine;',
    'public enum GMP_RestaurantEntityKind { Decor, Workstation, ResourceSource, UnlockArea, Upgrade, Queue, Pickup, DeliveryTarget }',
    'public class GMP_RestaurantEntity : GMP_BaseGameFlowEntity',
    '{',
    '    public GMP_RestaurantEntityKind mKind = GMP_RestaurantEntityKind.Workstation;',
    '    public string mResourceId = "coin";',
    '    public int mRewardAmount = 1;',
    '    public bool HasReward { get { return !string.IsNullOrEmpty(mResourceId) && mRewardAmount > 0; } }',
    '}',
    ''
  ].join('\n'));
  writeFile(path.join(root, 'Assets', 'Scripts', 'Game', 'Level', 'GMP_LevelRuleEngine.cs'), [
    'public class GMP_LevelRuleEngine : MonoSingleton<GMP_LevelRuleEngine>',
    '{',
    '    public int ServedCount = 0;',
    '    public void TryServe(GMP_RestaurantEntity chef)',
    '    {',
    '        if (chef == null) return;',
    '        chef.MarkInteracted();',
    '        ServedCount += 1;',
    '    }',
    '}',
    ''
  ].join('\n'));
  writeFile(path.join(root, 'Assets', 'Scripts', 'Game', 'Level', 'GMP_EntityBindingManager.cs'), [
    'using System.Collections.Generic;',
    'using UnityEngine;',
    'public class GMP_EntityBinding',
    '{',
    '    public string mEntityName;',
    '    public GameObject mSceneObject;',
    '    public int mInitialState;',
    '    public GMP_EntityState mRuntimeState;',
    '}',
    'public class GMP_EntityBindingManager : MonoSingleton<GMP_EntityBindingManager>',
    '{',
    '    public List<GMP_EntityBinding> mBindings = new List<GMP_EntityBinding>();',
    '    public void SetState(string entityName, GMP_EntityState state)',
    '    {',
    '        for (int i = 0; i < mBindings.Count; i++) if (mBindings[i].mEntityName == entityName) { mBindings[i].mRuntimeState = state; return; }',
    '    }',
    '    public GMP_EntityState GetState(string entityName)',
    '    {',
    '        for (int i = 0; i < mBindings.Count; i++) if (mBindings[i].mEntityName == entityName) return mBindings[i].mRuntimeState;',
    '        return GMP_EntityState.Hidden;',
    '    }',
    '}',
    ''
  ].join('\n'));
  writeFile(path.join(root, 'Assets', 'Scripts', 'Game', 'AutoPlay', 'GMP_AutoPlayDriver.cs'), [
    'public class GMP_AutoPlayDriver : MonoSingleton<GMP_AutoPlayDriver>',
    '{',
    '    public void Tick(float dt) {}',
    '}',
    ''
  ].join('\n'));
  writeFile(path.join(root, 'README.md'), [
    '# Unity 工程导出',
    '',
    '## 程序员交付边界',
    '- Core / Tool / Game',
    ''
  ].join('\n'));
  writeFile(path.join(root, 'CODE_RELATION_GRAPH.md'), [
    '# 代码关系图',
    '',
    'GMP_MainManager.InitCoreModules -> GMP_PhaseController.Tick -> GMP_LevelRuleEngine',
    ''
  ].join('\n'));
  writeFile(path.join(root, 'PROGRAMMER_HANDOFF.md'), [
    '# 程序员交付版说明',
    '',
    '## 后续维护建议',
    '- 新增业务逻辑优先写入 `Assets/Scripts/Game/`。',
    '',
    '## 清理统计',
    '- GMP_MainManager.cs 行数：' + countCodeLines(main),
    ''
  ].join('\n'));
  walkFiles(path.join(root, 'Assets', 'Scripts')).forEach(function(file) {
    if (/\.cs$/i.test(file)) ensureMeta(root, path.relative(root, file).split(path.sep).join('/'));
  });
  writeRequiredScene(root);
  hydration.writeHydrationReport(root, path.join(root, 'MCP_HYDRATION_REPORT.json'));
  return root;
}

function addProgrammerFeature(root) {
  var levelRuleFile = path.join(root, 'Assets', 'Scripts', 'Game', 'Level', 'GMP_LevelRuleEngine.cs');
  var levelRule = fs.readFileSync(levelRuleFile, 'utf8');
  levelRule = levelRule.replace(
    '    public int ServedCount = 0;\n',
    [
      '    public int ServedCount = 0;',
      '    public int BonusCoins = 0;',
      '',
      '    public void AddBonusCoins(int amount)',
      '    {',
      '        if (amount <= 0) return;',
      '        BonusCoins += amount;',
      '    }',
      ''
    ].join('\n') + '\n'
  );
  fs.writeFileSync(levelRuleFile, levelRule);

  writeFile(path.join(root, 'Assets', 'Scripts', 'Game', 'Level', 'GMP_ChefComboBonusFeature.cs'), [
    'using UnityEngine;',
    '',
    'public class GMP_ChefComboBonusFeature : MonoBehaviour',
    '{',
    '    public string mChefEntityName = "_chef";',
    '    public int mRequiredInteractions = 3;',
    '    public int mBonusCoins = 25;',
    '    public bool IsBonusGranted { get; private set; }',
    '',
    '    public bool TryGrant(GMP_RestaurantEntity chef, GMP_LevelRuleEngine rules)',
    '    {',
    '        if (chef == null || rules == null || IsBonusGranted) return false;',
    '        chef.MarkInteracted();',
    '        if (chef.InteractionCount < mRequiredInteractions) return false;',
    '        IsBonusGranted = true;',
    '        chef.MarkCompleted();',
    '        rules.AddBonusCoins(mBonusCoins);',
    '        if (GMP_EntityBindingManager.instance != null)',
    '        {',
    '            GMP_EntityBindingManager.instance.SetState(mChefEntityName, GMP_EntityState.Completed);',
    '        }',
    '        return true;',
    '    }',
    '}',
    ''
  ].join('\n'));
}

var summary = {
  errors: [],
  initialPhaseEntities: 2,
  initialPhaseEntitiesPositioned: 2,
  initialPhaseEntitiesMissing: 0,
  joystickObjectsPresent: true,
  hudTextObjectsPresent: true,
  fallbackMaterialMissingGuidCount: 0,
  fallbackMaterialShaderMissing: false,
  sourcePrimitiveEntityCount: 1
};

var root = makeDeliverableRoot();
try {
  var before = hardgate.validateProgrammerDelivery(root, summary);
  assert.strictEqual(before.passed, true, JSON.stringify(before.errors, null, 2));
  assert.strictEqual(before.maintainability.summary.gameObjectFindGameLayerCount, 0);
  assert.strictEqual(before.maintainability.summary.thinEntityClassCount, 0);

  var coreHash = hashTree(path.join(root, 'Assets', 'Scripts', 'Core'));
  var toolHash = hashTree(path.join(root, 'Assets', 'Scripts', 'Tool'));
  var sourceHash = hashSourceArtifacts(root);

  addProgrammerFeature(root);

  assert.strictEqual(hashTree(path.join(root, 'Assets', 'Scripts', 'Core')), coreHash, 'programmer feature must not modify Core');
  assert.strictEqual(hashTree(path.join(root, 'Assets', 'Scripts', 'Tool')), toolHash, 'programmer feature must not modify Tool');
  assert.strictEqual(hashSourceArtifacts(root), sourceHash, 'programmer feature must not modify SourceIR/source HTML inputs');

  var featureFile = path.join(root, 'Assets', 'Scripts', 'Game', 'Level', 'GMP_ChefComboBonusFeature.cs');
  var featureCode = fs.readFileSync(featureFile, 'utf8');
  assert.match(featureCode, /GMP_RestaurantEntity/);
  assert.match(featureCode, /chef\.MarkInteracted\(\)/);
  assert.match(featureCode, /rules\.AddBonusCoins\(mBonusCoins\)/);
  assert.doesNotMatch(featureCode, /GameObject\.Find|FindObjectOfType/);

  var after = hardgate.validateProgrammerDelivery(root, summary);
  assert.strictEqual(after.passed, true, JSON.stringify(after.errors, null, 2));
  assert.strictEqual(after.maintainability.summary.thinEntityClassCount, 0);
  assert.strictEqual(after.maintainability.summary.gameObjectFindGameLayerCount, 0);
  assert.strictEqual(after.maintainability.summary.coreEntityNameBranchCount, 0);

  var summaryPath = path.join(root, 'PROGRAMMER_DELIVERY_SUMMARY.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n');
  var validation = hardgate.writeDeliveryValidation(root, summaryPath, path.join(root, 'DELIVERY_VALIDATION.json'));
  assert.strictEqual(validation.passed, true, JSON.stringify(validation.errors, null, 2));
  assert.ok(fs.existsSync(path.join(root, 'PROGRAMMER_MAINTAINABILITY_REPORT.json')));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('programmer delivery feature extension simulation tests passed');
