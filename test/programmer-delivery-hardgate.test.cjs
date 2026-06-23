'use strict';

var assert = require('assert');
var crypto = require('crypto');
var fs = require('fs');
var os = require('os');
var path = require('path');

var hardgate = require('../lib/programmer-delivery-hardgate.cjs');
var hydration = require('../lib/programmer-delivery-hydration-report.cjs');

function writeEditorHydrationReport(root) {
  var file = path.join(root, 'MCP_HYDRATION_REPORT.json');
  hydration.writeHydrationReport(root, file, { mode: 'aibridge-editor' });
  var report = JSON.parse(fs.readFileSync(file, 'utf8'));
  report.mode = 'aibridge-editor';
  report.toolLayer = 'aibridge-editor';
  report.editorConnected = true;
  report.summary = report.summary || {};
  report.summary.aibridgeRan = true;
  report.summary.aibridgeFailedCommandCount = 0;
  report.summary.editorConnected = true;
  report.aibridge = {
    ran: true,
    required: true,
    cliPath: '/usr/local/bin/AIBridgeCLI',
    cliVia: 'test-fixture',
    scenePath: 'Assets/Scenes/Game.unity',
    editorConnected: true,
    commandCount: 2,
    failedCommandCount: 0,
    commands: [
      { label: 'harness-status', command: 'AIBridgeCLI harness status --timeout 5000', exitCode: 0, passed: true },
      { label: 'editor-get-state', command: 'AIBridgeCLI editor get_state --timeout 5000', exitCode: 0, passed: true }
    ]
  };
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
}

function makeRoot() {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), 'programmer-delivery-hardgate-'));
  fs.mkdirSync(path.join(root, 'Assets', 'Scripts', 'Core', 'Modules'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Assets', 'Scripts', 'Game', 'Entities'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Assets', 'Scripts', 'Game', 'Level'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Assets', 'Scripts', 'Game', 'AutoPlay'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Assets', 'Scripts', 'Game', 'Player'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Assets', 'Scripts', 'Tool'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Assets', 'Scenes'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Packages'), { recursive: true });
  function guidFor(rel) {
    return crypto.createHash('sha1').update(rel).digest('hex').slice(0, 32);
  }
  function writeScript(rel, code) {
    var file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, code);
    fs.writeFileSync(file + '.meta', [
      'fileFormatVersion: 2',
      'guid: ' + guidFor(rel),
      'MonoImporter:',
      '  externalObjects: {}',
      ''
    ].join('\n'));
    return guidFor(rel);
  }
  function sceneObject(name, guid, idx, audio, parentTransformId) {
    var go = 1000 + idx * 100;
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
      '  m_Father: {fileID: ' + (parentTransformId || 0) + '}',
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
  function mainGameObject() {
    return [
      '--- !u!1 &50',
      'GameObject:',
      '  m_Component:',
      '  - component: {fileID: 51}',
      '  m_Name: MainGame',
      '--- !u!4 &51',
      'Transform:',
      '  m_GameObject: {fileID: 50}',
      '  m_Father: {fileID: 0}',
      ''
    ].join('\n');
  }
  function canvasObject() {
    return [
      '--- !u!1 &60000',
      'GameObject:',
      '  m_Component:',
      '  - component: {fileID: 60001}',
      '  - component: {fileID: 60002}',
      '  - component: {fileID: 60003}',
      '  - component: {fileID: 60004}',
      '  m_Name: Canvas',
      '--- !u!224 &60001',
      'RectTransform:',
      '  m_GameObject: {fileID: 60000}',
      '  m_Father: {fileID: 0}',
      '--- !u!223 &60002',
      'Canvas:',
      '  m_GameObject: {fileID: 60000}',
      '  m_RenderMode: 0',
      '  m_SortingOrder: 100',
      '--- !u!114 &60003',
      'MonoBehaviour:',
      '  m_GameObject: {fileID: 60000}',
      '  m_ReferenceResolution: {x: 1080, y: 1920}',
      '  m_MatchWidthOrHeight: 0.5',
      '--- !u!114 &60004',
      'MonoBehaviour:',
      '  m_GameObject: {fileID: 60000}',
      ''
    ].join('\n');
  }
  function flowGuideDocs() {
    return [
      '## 流程增删改指南',
      '- 修改流程：编辑 FlowXX_<业务语义>.asset 的 mGuideText、mGate、mSteps，并同步 GMP_PhaseController.mPhases。',
      '- 删除流程：从 mPhases 移除对应 Flow 资产，删除不再引用的场景实体字段。',
      '- 增加流程：新增 Flow03_collect_food.asset，补 mPhaseId、场景引用和 LevelRuleEngine 规则。',
      '- 例子：把 flow03_collect_food 改成 flow04_upgrade_chef 时，同步 Flow04_upgrade_chef.asset 与 README 说明。'
    ].join('\n');
  }
  fs.writeFileSync(path.join(root, 'Packages', 'manifest.json'), JSON.stringify({ dependencies: {} }, null, 2));
  var scriptGuids = [];
  scriptGuids.push({ name: 'GMP_MainManager', guid: writeScript('Assets/Scripts/Core/Modules/GMP_MainManager.cs', [
    'using System;',
    'using UnityEngine;',
    'public class GMP_MainManager : MonoBehaviour',
    '{',
    '  public GMP_EventModule mEventModule;',
    '  void Start()',
    '  {',
    '    if (mEventModule == null) return;',
    '    Action<object> callback = OnEvent;',
    '    mEventModule.Subscribe("ready", callback);',
    '    mEventModule.Unsubscribe("ready", callback);',
    '    mEventModule.UnSubScribe("ready", callback);',
    '    mEventModule.Publish("ready", null);',
    '  }',
    '  void Update() {}',
    '  void OnEvent(object payload) {}',
    '}',
  ].join('\n')) });
  scriptGuids.push({ name: 'GMP_EntityManager', guid: writeScript('Assets/Scripts/Core/Modules/GMP_EntityManager.cs', 'using UnityEngine;\npublic class GMP_EntityManager : MonoBehaviour {}\n') });
  scriptGuids.push({ name: 'GMP_PhaseController', guid: writeScript('Assets/Scripts/Core/Modules/GMP_PhaseController.cs', 'using UnityEngine;\npublic class GMP_PhaseController : MonoBehaviour {}\n') });
  var audioGuid = writeScript('Assets/Scripts/Core/Modules/GMP_Audio.cs', [
    'using UnityEngine;',
    'public class GMP_Audio : MonoBehaviour',
    '{',
    '  public AudioSource[] mLoopSources = new AudioSource[0];',
    '  public AudioSource[] mOneShotSources = new AudioSource[0];',
    '  void Awake() { GetComponents<AudioSource>(); }',
    '}',
  ].join('\n'));
  scriptGuids.push({ name: 'GMP_Audio', guid: audioGuid, audio: true });
  scriptGuids.push({ name: 'GMP_UIManager', guid: writeScript('Assets/Scripts/Core/Modules/GMP_UIManager.cs', 'using UnityEngine;\npublic class GMP_UIManager : MonoBehaviour {}\n') });
  scriptGuids.push({ name: 'GMP_HudController', guid: writeScript('Assets/Scripts/Core/Modules/GMP_HudController.cs', 'using UnityEngine;\npublic class GMP_HudController : MonoBehaviour {}\n') });
  scriptGuids.push({ name: 'GMP_EventModule', guid: writeScript('Assets/Scripts/Core/Modules/GMP_EventModule.cs', [
    'using System;',
    'using UnityEngine;',
    'public class GMP_EventModule : MonoBehaviour',
    '{',
    '  public void Subscribe(string eventName, Action<object> callback) {}',
    '  public void Unsubscribe(string eventName, Action<object> callback) {}',
    '  public void UnSubScribe(string eventName, Action<object> callback) {}',
    '  public void Publish(string eventName, object payload) {}',
    '}',
  ].join('\n')) });
  scriptGuids.push({ name: 'GMP_CameraController', guid: writeScript('Assets/Scripts/Tool/GMP_CameraController.cs', 'using UnityEngine;\npublic class GMP_CameraController : MonoBehaviour {}\n') });
  scriptGuids.push({ name: 'GMP_SceneEntityRefs', guid: writeScript('Assets/Scripts/Game/Level/GMP_SceneEntityRefs.cs', 'using UnityEngine;\npublic class GMP_SceneEntityRefs : MonoBehaviour {}\n') });
  scriptGuids.push({ name: 'GMP_LevelRuleEngine', guid: writeScript('Assets/Scripts/Game/Level/GMP_LevelRuleEngine.cs', 'using UnityEngine;\npublic class GMP_LevelRuleEngine : MonoBehaviour {}\n') });
  scriptGuids.push({ name: 'GMP_Player', guid: writeScript('Assets/Scripts/Game/Player/GMP_Player.cs', 'public class GMP_Player : GMP_PlayerBase {}\n') });
  scriptGuids.push({ name: 'GMP_AutoPlayDriver', guid: writeScript('Assets/Scripts/Game/AutoPlay/GMP_AutoPlayDriver.cs', 'using UnityEngine;\npublic class GMP_AutoPlayDriver : MonoBehaviour {}\n') });
  fs.writeFileSync(path.join(root, 'Assets', 'Scenes', 'Game.unity'), ['%YAML 1.1', mainGameObject(), canvasObject()].concat(scriptGuids.map(function(item, index) {
    return sceneObject(item.name, item.guid, index + 1, item.audio, 51);
  }), ['']).join('\n'));
  writeScript('Assets/Scripts/Core/Modules/GMP_PhasePreset.cs', [
    'public class GMP_PhaseStep',
    '{',
    '  public GMP_EntityState mSetState = GMP_EntityState.Hidden;',
    '}',
  ].join('\n'));
  writeScript('Assets/Scripts/Game/Entities/GMP_ChefEntity.cs', [
    'public class GMP_ChefEntity : GMP_BaseGameFlowEntity',
    '{',
    '  public int ServedCount;',
    '  public string CurrentRecipe = "shrimp";',
    '}',
  ].join('\n'));
  writeEditorHydrationReport(root);
  fs.writeFileSync(path.join(root, 'README.md'), flowGuideDocs());
  fs.writeFileSync(path.join(root, 'PROGRAMMER_HANDOFF.md'), flowGuideDocs());
  fs.writeFileSync(path.join(root, 'CODE_RELATION_GRAPH.md'), flowGuideDocs());
  return root;
}

var summary = {
  errors: [],
  initialPhaseEntitiesMissing: 0,
  joystickObjectsPresent: true,
  hudTextObjectsPresent: true,
  fallbackMaterialMissingGuidCount: 0,
  fallbackMaterialShaderMissing: false,
  sourcePrimitiveEntityCount: 1,
};

var passingRoot = makeRoot();
var passing = hardgate.validateProgrammerDelivery(passingRoot, summary);
assert.strictEqual(passing.passed, true, JSON.stringify(passing.errors, null, 2));

var legacyRefsRoot = makeRoot();
var newRefsRel = 'Assets/Scripts/Game/Level/GMP_SceneEntityRefs.cs';
var oldRefsRel = 'Assets/Scripts/Game/Level/GMP_EntityBindingManager.cs';
var newRefsGuid = crypto.createHash('sha1').update(newRefsRel).digest('hex').slice(0, 32);
var oldRefsGuid = crypto.createHash('sha1').update(oldRefsRel).digest('hex').slice(0, 32);
fs.rmSync(path.join(legacyRefsRoot, newRefsRel), { force: true });
fs.rmSync(path.join(legacyRefsRoot, newRefsRel + '.meta'), { force: true });
fs.writeFileSync(path.join(legacyRefsRoot, oldRefsRel), 'using UnityEngine;\npublic class GMP_EntityBindingManager : MonoBehaviour {}\n');
fs.writeFileSync(path.join(legacyRefsRoot, oldRefsRel + '.meta'), [
  'fileFormatVersion: 2',
  'guid: ' + oldRefsGuid,
  'MonoImporter:',
  '  externalObjects: {}',
  ''
].join('\n'));
var legacyRefsScene = path.join(legacyRefsRoot, 'Assets', 'Scenes', 'Game.unity');
fs.writeFileSync(legacyRefsScene, fs.readFileSync(legacyRefsScene, 'utf8')
  .replace(/GMP_SceneEntityRefs/g, 'GMP_EntityBindingManager')
  .replace(new RegExp(newRefsGuid, 'g'), oldRefsGuid));
writeEditorHydrationReport(legacyRefsRoot);
var legacyRefsPassing = hardgate.validateProgrammerDelivery(legacyRefsRoot, summary);
assert.strictEqual(legacyRefsPassing.passed, false);

var failingRoot = makeRoot();
fs.mkdirSync(path.join(failingRoot, 'Assets', 'Program'), { recursive: true });
fs.writeFileSync(path.join(failingRoot, 'Packages', 'manifest.json'), JSON.stringify({
  dependencies: { 'com.unity.playworks.upp': 'file:/opt/blueprint-editor/7.1.0/scripts' },
}, null, 2));
var failing = hardgate.validateProgrammerDelivery(failingRoot, Object.assign({}, summary, {
  joystickObjectsPresent: false,
  initialPhaseEntitiesMissing: 2,
}));
assert.strictEqual(failing.passed, false);
assert.ok(failing.errors.some(function(error) { return error.indexOf('joystickObjectsPresent') >= 0; }));
assert.ok(failing.errors.some(function(error) { return error.indexOf('Assets/Program') >= 0; }));
assert.ok(failing.errors.some(function(error) { return error.indexOf('Playworks') >= 0; }));

var layoutFailRoot = makeRoot();
fs.mkdirSync(path.join(layoutFailRoot, 'Assets', 'Scripts', 'Manager'), { recursive: true });
fs.writeFileSync(path.join(layoutFailRoot, 'Assets', 'Scripts', 'Manager', 'Legacy.cs'), 'public class Legacy {}\n');
fs.writeFileSync(path.join(layoutFailRoot, 'Assets', 'Scripts', 'Core', 'Modules', 'GMP_HudController.cs'), [
  'public class GMP_HudController',
  '{',
  '  string Name(string entityName) { if (entityName == "_gold") return "金币"; return entityName; }',
  '}',
].join('\n'));
var layoutFail = hardgate.validateProgrammerDelivery(layoutFailRoot, summary);
assert.strictEqual(layoutFail.passed, false);
assert.ok(layoutFail.errors.some(function(error) { return error.indexOf('Core/Tool/Game') >= 0; }));
assert.ok(layoutFail.errors.some(function(error) { return error.indexOf('project-specific entity label mapping') >= 0; }));

var phaseNameFailRoot = makeRoot();
fs.mkdirSync(path.join(phaseNameFailRoot, 'Assets', 'Scripts', 'Game', 'Phases'), { recursive: true });
fs.writeFileSync(path.join(phaseNameFailRoot, 'Assets', 'Scripts', 'Game', 'Phases', 'Phase1.asset'), [
  '%YAML 1.1',
  '--- !u!114 &11400000',
  'MonoBehaviour:',
  '  m_Name: Phase1',
  '  mPhaseId: phase1',
  ''
].join('\n'));
var phaseNameFail = hardgate.validateProgrammerDelivery(phaseNameFailRoot, summary);
assert.strictEqual(phaseNameFail.passed, false);
assert.ok(phaseNameFail.errors.some(function(error) { return error.indexOf('bare numbered Phase asset naming') >= 0; }));
assert.ok(phaseNameFail.errors.some(function(error) { return error.indexOf('bare numbered mPhaseId') >= 0; }));

var audioFailRoot = makeRoot();
fs.writeFileSync(path.join(audioFailRoot, 'Assets', 'Scripts', 'Game', 'Level', 'GMP_AudioCaller.cs'), [
  'using UnityEngine;',
  'public class GMP_AudioCaller : MonoBehaviour',
  '{',
  '  void Start()',
  '  {',
  '    if (GMP_Audio.instance != null) GMP_Audio.instance.PlayLoop("bgm", null);',
  '  }',
  '}',
].join('\n'));
fs.writeFileSync(path.join(audioFailRoot, 'Assets', 'Scripts', 'Core', 'Modules', 'GMP_Audio.cs'), [
  'using UnityEngine;',
  'public class GMP_Audio : MonoBehaviour',
  '{',
  '  private AudioSource mBgmSource;',
  '  private AudioSource mSfxSource;',
  '  public void PlaySFX(AudioClip clip) {}',
  '}',
].join('\n'));
fs.writeFileSync(path.join(audioFailRoot, 'Assets', 'Scenes', 'Game.unity'), [
  '%YAML 1.1',
  '--- !u!1 &100',
  'GameObject:',
  '  m_Name: GMP_Audio',
  '--- !u!82 &103',
  'AudioSource:',
  '  m_GameObject: {fileID: 100}',
  ''
].join('\n'));
var audioFail = hardgate.validateProgrammerDelivery(audioFailRoot, summary);
assert.strictEqual(audioFail.passed, false);
assert.ok(audioFail.errors.some(function(error) { return error.indexOf('mLoopSources') >= 0; }));
assert.ok(audioFail.errors.some(function(error) { return error.indexOf('mOneShotSources') >= 0; }));
assert.ok(audioFail.errors.some(function(error) { return error.indexOf('PlayLoop') >= 0; }));
assert.ok(audioFail.errors.some(function(error) { return error.indexOf('fixed BGM/SFX') >= 0; }));
assert.ok(audioFail.errors.some(function(error) { return error.indexOf('multiple AudioSource') >= 0; }));

var monoSingletonFailRoot = makeRoot();
fs.writeFileSync(path.join(monoSingletonFailRoot, 'Assets', 'Scripts', 'Core', 'Modules', 'GMP_LegacySingleton.cs'), [
  'using UnityEngine;',
  'public class GMP_LegacySingleton : MonoSingleton<GMP_LegacySingleton> {}',
].join('\n'));
var monoSingletonFail = hardgate.validateProgrammerDelivery(monoSingletonFailRoot, summary);
assert.strictEqual(monoSingletonFail.passed, false);
assert.ok(monoSingletonFail.errors.some(function(error) { return error.indexOf('MonoSingleton/GMP_SingletonBase is forbidden') >= 0; }));

var sceneSingletonFailRoot = makeRoot();
fs.writeFileSync(path.join(sceneSingletonFailRoot, 'Assets', 'Scripts', 'Core', 'Modules', 'GMP_BadManager.cs'), [
  'using UnityEngine;',
  'public class GMP_BadManager : MonoBehaviour',
  '{',
  '  public static GMP_BadManager instance;',
  '  void Awake() { instance = this; }',
  '}',
].join('\n'));
var sceneSingletonFail = hardgate.validateProgrammerDelivery(sceneSingletonFailRoot, summary);
assert.strictEqual(sceneSingletonFail.passed, false);
assert.ok(sceneSingletonFail.errors.some(function(error) { return error.indexOf('public static field or auto-property') >= 0; }));
assert.ok(sceneSingletonFail.errors.some(function(error) { return error.indexOf('Scene singleton instance contract incomplete') >= 0; }));

var eventApiFailRoot = makeRoot();
fs.writeFileSync(path.join(eventApiFailRoot, 'Assets', 'Scripts', 'Core', 'Modules', 'GMP_EventModule.cs'), 'using UnityEngine;\npublic class GMP_EventModule : MonoBehaviour { public void Publish(string eventName, object payload) {} }\n');
var eventApiFail = hardgate.validateProgrammerDelivery(eventApiFailRoot, summary);
assert.strictEqual(eventApiFail.passed, false);
assert.ok(eventApiFail.errors.some(function(error) { return error.indexOf('Subscribe(string eventName') >= 0; }));
assert.ok(eventApiFail.errors.some(function(error) { return error.indexOf('UnSubScribe alias') >= 0; }));

var canvasFailRoot = makeRoot();
var canvasFailScene = path.join(canvasFailRoot, 'Assets', 'Scenes', 'Game.unity');
fs.writeFileSync(canvasFailScene, fs.readFileSync(canvasFailScene, 'utf8')
  .replace('m_RenderMode: 0', 'm_RenderMode: 1')
  .replace('m_ReferenceResolution: {x: 1080, y: 1920}', 'm_ReferenceResolution: {x: 960, y: 640}')
  .replace('m_MatchWidthOrHeight: 0.5', 'm_MatchWidthOrHeight: 0'));
var canvasFail = hardgate.validateProgrammerDelivery(canvasFailRoot, summary);
assert.strictEqual(canvasFail.passed, false);
assert.ok(canvasFail.errors.some(function(error) { return error.indexOf('Screen Space - Overlay') >= 0; }));
assert.ok(canvasFail.errors.some(function(error) { return error.indexOf('1080x1920') >= 0; }));
assert.ok(canvasFail.errors.some(function(error) { return error.indexOf('matchWidthOrHeight') >= 0; }));

var hierarchyFailRoot = makeRoot();
var hierarchyFailScene = path.join(hierarchyFailRoot, 'Assets', 'Scenes', 'Game.unity');
fs.writeFileSync(hierarchyFailScene, fs.readFileSync(hierarchyFailScene, 'utf8').replace(
  /m_Name: GMP_MainManager[\s\S]*?m_Father: \{fileID: 51\}/,
  function(match) { return match.replace('m_Father: {fileID: 51}', 'm_Father: {fileID: 0}'); }
));
var hierarchyFail = hardgate.validateProgrammerDelivery(hierarchyFailRoot, summary);
assert.strictEqual(hierarchyFail.passed, false);
assert.ok(hierarchyFail.errors.some(function(error) { return error.indexOf('children of MainGame') >= 0 && error.indexOf('GMP_MainManager') >= 0; }));

var sceneGuidFailRoot = makeRoot();
var sceneFile = path.join(sceneGuidFailRoot, 'Assets', 'Scenes', 'Game.unity');
fs.writeFileSync(sceneFile, fs.readFileSync(sceneFile, 'utf8').replace(
  /m_Name: GMP_MainManager[\s\S]*?m_Script: \{fileID: 11500000, guid: [0-9a-f]+, type: 3\}/,
  function(match) {
    return match.replace(/guid: [0-9a-f]+/, 'guid: 11111111111111111111111111111111');
  }
));
var sceneGuidFail = hardgate.validateProgrammerDelivery(sceneGuidFailRoot, summary);
assert.strictEqual(sceneGuidFail.passed, false);
assert.ok(sceneGuidFail.errors.some(function(error) { return error.indexOf('GMP_MainManager') >= 0 && error.indexOf('guid') >= 0; }));

var missingHydrationRoot = makeRoot();
fs.rmSync(path.join(missingHydrationRoot, 'MCP_HYDRATION_REPORT.json'), { force: true });
var missingHydration = hardgate.validateProgrammerDelivery(missingHydrationRoot, summary);
assert.strictEqual(missingHydration.passed, false);
assert.ok(missingHydration.errors.some(function(error) { return error.indexOf('MCP_HYDRATION_REPORT.json missing') >= 0; }));

var staticHydrationRoot = makeRoot();
hydration.writeHydrationReport(staticHydrationRoot, path.join(staticHydrationRoot, 'MCP_HYDRATION_REPORT.json'), { mode: 'static-unity-yaml' });
var staticHydration = hardgate.validateProgrammerDelivery(staticHydrationRoot, summary);
assert.strictEqual(staticHydration.passed, false);
assert.ok(staticHydration.errors.some(function(error) { return error.indexOf('final Unity delivery requires live Editor hydration') >= 0; }));
assert.ok(staticHydration.errors.some(function(error) { return error.indexOf('active Unity Editor/AIBridge session') >= 0; }));

var staleSummaryRoot = makeRoot();
var staleSummary = hardgate.validateProgrammerDelivery(staleSummaryRoot, Object.assign({}, summary, {
  unusedScriptNamesRemoved: ['GMP_Audio.cs']
}));
assert.strictEqual(staleSummary.passed, false);
assert.ok(staleSummary.errors.some(function(error) { return error.indexOf('PROGRAMMER_DELIVERY_SUMMARY') >= 0 && error.indexOf('GMP_Audio.cs') >= 0; }));

var logicVisualRoot = makeRoot();
var chefGuid = crypto.createHash('sha1').update('Assets/Scripts/Game/Entities/GMP_ChefEntity.cs').digest('hex').slice(0, 32);
fs.appendFileSync(path.join(logicVisualRoot, 'Assets', 'Scenes', 'Game.unity'), [
  '--- !u!1 &9000',
  'GameObject:',
  '  m_Component:',
  '  - component: {fileID: 9001}',
  '  - component: {fileID: 9002}',
  '  - component: {fileID: 9003}',
  '  m_Name: ChefVisualRig',
  '--- !u!4 &9001',
  'Transform:',
  '  m_GameObject: {fileID: 9000}',
  '--- !u!114 &9002',
  'MonoBehaviour:',
  '  m_GameObject: {fileID: 9000}',
  '  m_Script: {fileID: 11500000, guid: ' + chefGuid + ', type: 3}',
  '--- !u!95 &9003',
  'Animator:',
  '  m_GameObject: {fileID: 9000}',
  ''
].join('\n'));
var logicVisual = hardgate.validateProgrammerDelivery(logicVisualRoot, summary);
assert.strictEqual(logicVisual.passed, false);
assert.ok(logicVisual.errors.some(function(error) { return error.indexOf('logic script mounted on visual rig object') >= 0; }));

var summaryPath = path.join(passingRoot, 'PROGRAMMER_DELIVERY_SUMMARY.json');
var validationPath = path.join(passingRoot, 'DELIVERY_VALIDATION.json');
fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
var written = hardgate.writeDeliveryValidation(passingRoot, summaryPath, validationPath);
assert.strictEqual(written.passed, true);
assert.ok(fs.existsSync(validationPath));
assert.ok(fs.existsSync(path.join(passingRoot, 'MCP_HYDRATION_REPORT.json')));
assert.ok(fs.existsSync(path.join(passingRoot, 'PROGRAMMER_MAINTAINABILITY_REPORT.json')));

console.log('programmer delivery hardgate tests passed');
