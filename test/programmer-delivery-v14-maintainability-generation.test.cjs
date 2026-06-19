'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var cleaner = require('../lib/programmer-delivery-cleaner.cjs');

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

(function testEntityProgressLivesInReusableEntityLayer() {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), 'programmer-v14-entity-'));
  try {
    var managerDir = path.join(root, 'Assets', 'Scripts', 'Manager');
    fs.mkdirSync(managerDir, { recursive: true });
    fs.writeFileSync(path.join(root, 'README.md'), '# Unity 工程导出\n\n## 程序员交付边界\n- old\n');
    fs.writeFileSync(path.join(managerDir, 'GameFlowManagerMain.cs'), [
      'using UnityEngine;',
      '',
      'public class GameFlowManagerMain : MonoBehaviour',
      '{',
      '    GameObject Chef;',
      '    GameObject ShrimpPlate;',
      '    GameObject CtaButton;',
      '    void Start() {}',
      '    void Update() {}',
      '}',
    ].join('\n'));

    cleaner.cleanProgrammerDelivery(root, {
      project: { id: 'entity-fixture', name: '实体 fixture' }
    });

    var baseFile = path.join(root, 'Assets', 'Scripts', 'Core', 'Base', 'GMP_BaseGameFlowEntity.cs');
    var restaurantFile = path.join(root, 'Assets', 'Scripts', 'Game', 'Entities', 'GMP_RestaurantEntity.cs');
    var chefFile = path.join(root, 'Assets', 'Scripts', 'Game', 'Entities', 'GMP_ChefEntity.cs');
    assert.ok(fs.existsSync(baseFile), 'base entity should be generated');
    assert.ok(fs.existsSync(restaurantFile), 'reusable restaurant entity should be generated');
    assert.ok(!fs.existsSync(chefFile), 'fake per-entity shell should not be generated');

    var baseCode = fs.readFileSync(baseFile, 'utf8');
    assert.match(baseCode, /public int InteractionCount/);
    assert.match(baseCode, /public bool IsCompleted/);
    assert.match(baseCode, /public virtual void MarkCompleted\(\)/);

    var entityCode = fs.readFileSync(restaurantFile, 'utf8');
    assert.match(entityCode, /public enum GMP_RestaurantEntityKind/);
    assert.match(entityCode, /public class GMP_RestaurantEntity : GMP_BaseGameFlowEntity/);
    assert.match(entityCode, /public void GrantReward\(GMP_EconomyManager economy\)/);
    assert.doesNotMatch(entityCode, /GameFlowStateBase/);
  } finally {
    cleanup(root);
  }
})();

(function testEntityBindingManagerUsesDataTables() {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), 'programmer-v14-binding-'));
  try {
    var scriptsDir = path.join(root, 'Assets', 'Scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(root, 'README.md'), '# Unity 工程导出\n\n## 程序员交付边界\n- old\n');
    fs.writeFileSync(path.join(scriptsDir, 'MainManager.cs'), [
      'using UnityEngine;',
      '',
      'public class MainManager : MonoSingleton<MainManager>',
      '{',
      '    string[] mEntityBindingIds = new string[] { "_chef", "_shrimpPlate", "_ctaButton" };',
      '    void Start() {}',
      '    void Update() {}',
      '}',
    ].join('\n'));

    cleaner.cleanProgrammerDelivery(root, {
      project: { id: 'binding-fixture', name: '绑定 fixture' }
    });

    var bindingFile = path.join(root, 'Assets', 'Scripts', 'Game', 'Level', 'GMP_EntityBindingManager.cs');
    assert.ok(fs.existsSync(bindingFile), 'entity binding manager should be generated');
    var bindingCode = fs.readFileSync(bindingFile, 'utf8');
    assert.match(bindingCode, /public List<GMP_EntityBinding> mBindings = new List<GMP_EntityBinding>\(\)/);
    assert.match(bindingCode, /public string mPlayerEntityName = "_player"/);
    assert.match(bindingCode, /private GMP_EntityBinding BindingFor\(string entityName\)/);
    assert.doesNotMatch(bindingCode, /\bmEntityNames\b/);
    assert.doesNotMatch(bindingCode, /\bmDefaultPositions\b/);
    assert.doesNotMatch(bindingCode, /\bmDefaultScales\b/);
    assert.doesNotMatch(bindingCode, /\bif\s*\(\s*entityName\s*==\s*"_/);
  } finally {
    cleanup(root);
  }
})();

(function testMissingV14EntryScriptsAreRestoredFromSceneGuids() {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), 'programmer-v14-entry-'));
  try {
    fs.mkdirSync(path.join(root, 'Assets', 'Scripts', 'Core', 'Modules'), { recursive: true });
    fs.mkdirSync(path.join(root, 'Assets', 'Scripts', 'Game', 'Level'), { recursive: true });
    fs.mkdirSync(path.join(root, 'Assets', 'Scripts', 'Game', 'Entities'), { recursive: true });
    fs.mkdirSync(path.join(root, 'Assets', 'Scripts', 'Tool'), { recursive: true });
    fs.mkdirSync(path.join(root, 'Assets', 'Scenes'), { recursive: true });
    fs.writeFileSync(path.join(root, 'README.md'), '# Unity 工程导出\n\n## 目录\n\n## 程序员交付边界\n- old\n');
    var mainGuid = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    var phaseGuid = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    fs.writeFileSync(path.join(root, 'Assets', 'Scenes', 'Game.unity'), [
      '%YAML 1.1',
      '--- !u!1 &100',
      'GameObject:',
      '  m_Component:',
      '  - component: {fileID: 101}',
      '  - component: {fileID: 102}',
      '  m_Name: GMP_MainManager',
      '--- !u!4 &101',
      'Transform:',
      '  m_GameObject: {fileID: 100}',
      '--- !u!114 &102',
      'MonoBehaviour:',
      '  m_GameObject: {fileID: 100}',
      '  m_Script: {fileID: 11500000, guid: ' + mainGuid + ', type: 3}',
      '--- !u!1 &200',
      'GameObject:',
      '  m_Component:',
      '  - component: {fileID: 201}',
      '  - component: {fileID: 202}',
      '  m_Name: GMP_PhaseController',
      '--- !u!4 &201',
      'Transform:',
      '  m_GameObject: {fileID: 200}',
      '--- !u!114 &202',
      'MonoBehaviour:',
      '  m_GameObject: {fileID: 200}',
      '  m_Script: {fileID: 11500000, guid: ' + phaseGuid + ', type: 3}',
      '  mPhases: []',
      ''
    ].join('\n'));

    cleaner.cleanProgrammerDelivery(root, {
      project: { id: 'entry-fixture', name: '入口修复 fixture' }
    });

    var mainFile = path.join(root, 'Assets', 'Scripts', 'Core', 'Modules', 'GMP_MainManager.cs');
    var phaseFile = path.join(root, 'Assets', 'Scripts', 'Core', 'Modules', 'GMP_PhaseController.cs');
    assert.ok(fs.existsSync(mainFile), 'GMP_MainManager.cs should be restored');
    assert.ok(fs.existsSync(phaseFile), 'GMP_PhaseController.cs should be restored');
    assert.match(fs.readFileSync(mainFile, 'utf8'), /public class GMP_MainManager : MonoSingleton<GMP_MainManager>/);
    assert.match(fs.readFileSync(phaseFile, 'utf8'), /public class GMP_PhaseController : MonoSingleton<GMP_PhaseController>/);
    assert.match(fs.readFileSync(mainFile + '.meta', 'utf8'), new RegExp('guid: ' + mainGuid));
    assert.match(fs.readFileSync(phaseFile + '.meta', 'utf8'), new RegExp('guid: ' + phaseGuid));
    var handoff = fs.readFileSync(path.join(root, 'PROGRAMMER_HANDOFF.md'), 'utf8');
    var graph = fs.readFileSync(path.join(root, 'CODE_RELATION_GRAPH.md'), 'utf8');
    assert.doesNotMatch(handoff, /GMP_MainManager\.cs 行数：0/);
    assert.match(graph, /Core\/Modules\/GMP_MainManager\.cs/);
  } finally {
    cleanup(root);
  }
})();

console.log('programmer delivery v14 maintainability generation tests passed');
