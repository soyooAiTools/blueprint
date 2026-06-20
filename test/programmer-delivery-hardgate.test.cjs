'use strict';

var assert = require('assert');
var crypto = require('crypto');
var fs = require('fs');
var os = require('os');
var path = require('path');

var hardgate = require('../lib/programmer-delivery-hardgate.cjs');
var hydration = require('../lib/programmer-delivery-hydration-report.cjs');

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
  function sceneObject(name, guid, idx, audio) {
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
  fs.writeFileSync(path.join(root, 'Packages', 'manifest.json'), JSON.stringify({ dependencies: {} }, null, 2));
  var scriptGuids = [];
  scriptGuids.push({ name: 'GMP_MainManager', guid: writeScript('Assets/Scripts/Core/Modules/GMP_MainManager.cs', 'using UnityEngine;\npublic class GMP_MainManager : MonoBehaviour { void Start() {} void Update() {} }\n') });
  scriptGuids.push({ name: 'GMP_PhaseController', guid: writeScript('Assets/Scripts/Core/Modules/GMP_PhaseController.cs', 'using UnityEngine;\npublic class GMP_PhaseController : MonoBehaviour {}\n') });
  var audioGuid = writeScript('Assets/Scripts/Core/Modules/GMP_Audio.cs', [
    'using UnityEngine;',
    'public class GMP_Audio : MonoBehaviour',
    '{',
    '  public AudioSource[] mLoopSources = new AudioSource[0];',
    '  public AudioSource[] mOneShotSources = new AudioSource[0];',
    '}',
  ].join('\n'));
  scriptGuids.push({ name: 'GMP_Audio', guid: audioGuid, audio: true });
  scriptGuids.push({ name: 'GMP_UIManager', guid: writeScript('Assets/Scripts/Core/Modules/GMP_UIManager.cs', 'using UnityEngine;\npublic class GMP_UIManager : MonoBehaviour {}\n') });
  scriptGuids.push({ name: 'GMP_HudController', guid: writeScript('Assets/Scripts/Core/Modules/GMP_HudController.cs', 'using UnityEngine;\npublic class GMP_HudController : MonoBehaviour {}\n') });
  scriptGuids.push({ name: 'GMP_EventModule', guid: writeScript('Assets/Scripts/Core/Modules/GMP_EventModule.cs', 'using UnityEngine;\npublic class GMP_EventModule : MonoBehaviour {}\n') });
  scriptGuids.push({ name: 'GMP_CameraController', guid: writeScript('Assets/Scripts/Tool/GMP_CameraController.cs', 'using UnityEngine;\npublic class GMP_CameraController : MonoBehaviour {}\n') });
  scriptGuids.push({ name: 'GMP_SceneEntityRefs', guid: writeScript('Assets/Scripts/Game/Level/GMP_SceneEntityRefs.cs', 'using UnityEngine;\npublic class GMP_SceneEntityRefs : MonoBehaviour {}\n') });
  scriptGuids.push({ name: 'GMP_LevelRuleEngine', guid: writeScript('Assets/Scripts/Game/Level/GMP_LevelRuleEngine.cs', 'using UnityEngine;\npublic class GMP_LevelRuleEngine : MonoBehaviour {}\n') });
  scriptGuids.push({ name: 'GMP_Player', guid: writeScript('Assets/Scripts/Game/Player/GMP_Player.cs', 'public class GMP_Player : GMP_PlayerBase {}\n') });
  scriptGuids.push({ name: 'GMP_AutoPlayDriver', guid: writeScript('Assets/Scripts/Game/AutoPlay/GMP_AutoPlayDriver.cs', 'using UnityEngine;\npublic class GMP_AutoPlayDriver : MonoBehaviour {}\n') });
  fs.writeFileSync(path.join(root, 'Assets', 'Scenes', 'Game.unity'), ['%YAML 1.1'].concat(scriptGuids.map(function(item, index) {
    return sceneObject(item.name, item.guid, index + 1, item.audio);
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
  hydration.writeHydrationReport(root, path.join(root, 'MCP_HYDRATION_REPORT.json'));
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
assert.strictEqual(passing.passed, true);

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
hydration.writeHydrationReport(legacyRefsRoot, path.join(legacyRefsRoot, 'MCP_HYDRATION_REPORT.json'));
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
