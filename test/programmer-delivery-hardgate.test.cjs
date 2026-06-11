'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var hardgate = require('../lib/programmer-delivery-hardgate.cjs');

function makeRoot() {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), 'programmer-delivery-hardgate-'));
  fs.mkdirSync(path.join(root, 'Assets', 'Scripts', 'Core', 'Modules'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Assets', 'Scripts', 'Game', 'Player'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Assets', 'Scripts', 'Tool'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Assets', 'Scenes'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Packages'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Assets', 'Scenes', 'Game.unity'), [
    '%YAML 1.1',
    '--- !u!1 &100',
    'GameObject:',
    '  m_Component:',
    '  - component: {fileID: 101}',
    '  - component: {fileID: 102}',
    '  - component: {fileID: 103}',
    '  - component: {fileID: 104}',
    '  - component: {fileID: 105}',
    '  - component: {fileID: 106}',
    '  m_Name: GMP_Audio',
    '--- !u!4 &101',
    'Transform:',
    '  m_GameObject: {fileID: 100}',
    '--- !u!114 &102',
    'MonoBehaviour:',
    '  m_GameObject: {fileID: 100}',
    '--- !u!82 &103',
    'AudioSource:',
    '  m_GameObject: {fileID: 100}',
    '--- !u!82 &104',
    'AudioSource:',
    '  m_GameObject: {fileID: 100}',
    '--- !u!82 &105',
    'AudioSource:',
    '  m_GameObject: {fileID: 100}',
    '--- !u!82 &106',
    'AudioSource:',
    '  m_GameObject: {fileID: 100}',
    ''
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'Packages', 'manifest.json'), JSON.stringify({ dependencies: {} }, null, 2));
  fs.writeFileSync(path.join(root, 'Assets', 'Scripts', 'Core', 'Modules', 'GMP_Audio.cs'), [
    'using UnityEngine;',
    'public class GMP_Audio : MonoBehaviour',
    '{',
    '  public AudioSource[] mLoopSources = new AudioSource[0];',
    '  public AudioSource[] mOneShotSources = new AudioSource[0];',
    '  public void PlayLoop(string key, AudioClip clip) {}',
    '  public void PlayOneShot(AudioClip clip) {}',
    '}',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'Assets', 'Scripts', 'Core', 'Modules', 'GMP_PhasePreset.cs'), [
    'public class GMP_PhaseStep',
    '{',
    '  public GMP_EntityState mSetState = GMP_EntityState.Hidden;',
    '}',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'Assets', 'Scripts', 'Game', 'Player', 'GMP_Player.cs'),
    'public class GMP_Player : GMP_PlayerBase {}\n');
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

var summaryPath = path.join(passingRoot, 'PROGRAMMER_DELIVERY_SUMMARY.json');
var validationPath = path.join(passingRoot, 'DELIVERY_VALIDATION.json');
fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
var written = hardgate.writeDeliveryValidation(passingRoot, summaryPath, validationPath);
assert.strictEqual(written.passed, true);
assert.ok(fs.existsSync(validationPath));

console.log('programmer delivery hardgate tests passed');
