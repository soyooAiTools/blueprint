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
    var baseComponentFile = path.join(root, 'Assets', 'Scripts', 'Core', 'Base', 'GMP_BaseComponent.cs');
    var entityManagerFile = path.join(root, 'Assets', 'Scripts', 'Core', 'Modules', 'GMP_EntityManager.cs');
    var restaurantFile = path.join(root, 'Assets', 'Scripts', 'Game', 'Entities', 'GMP_RestaurantEntity.cs');
    var chefFile = path.join(root, 'Assets', 'Scripts', 'Game', 'Entities', 'GMP_ChefEntity.cs');
    assert.ok(fs.existsSync(baseComponentFile), 'pure base component should be generated');
    assert.ok(fs.existsSync(entityManagerFile), 'entity manager should be generated');
    assert.ok(fs.existsSync(baseFile), 'base entity should be generated');
    assert.ok(fs.existsSync(restaurantFile), 'reusable restaurant entity should be generated');
    assert.ok(!fs.existsSync(chefFile), 'fake per-entity shell should not be generated');

    var baseCode = fs.readFileSync(baseFile, 'utf8');
    assert.match(baseCode, /AddEcsComponent/);
    assert.match(baseCode, /GetEcsComponent<T>/);
    assert.match(baseCode, /GetFirstEcsComponent<T>/);
    assert.doesNotMatch(baseCode, /InteractionCount|IsCompleted|MarkCompleted|ResetProgress|MoveToPosition|SetVisible|SetPosition/);

    var baseComponentCode = fs.readFileSync(baseComponentFile, 'utf8');
    assert.match(baseComponentCode, /\[Serializable\]/);
    assert.match(baseComponentCode, /public virtual void OnAwake\(\)/);
    assert.match(baseComponentCode, /public virtual void OnUpdate\(\)/);

    var entityManagerCode = fs.readFileSync(entityManagerFile, 'utf8');
    assert.match(entityManagerCode, /public class GMP_EntityManager : MonoBehaviour/);
    assert.match(entityManagerCode, /RegisterEntity\(GMP_BaseGameFlowEntity entity\)/);
    assert.match(entityManagerCode, /entity\.OnTick\(\)/);

    var entityCode = fs.readFileSync(restaurantFile, 'utf8');
    assert.match(entityCode, /public enum GMP_RestaurantEntityKind/);
    assert.match(entityCode, /public class GMP_RestaurantEntity : GMP_BaseGameFlowEntity/);
    assert.match(entityCode, /public bool IsCompleted = false/);
    assert.match(entityCode, /public void GrantReward\(GMP_EconomyManager economy\)/);
    assert.doesNotMatch(entityCode, /GameFlowStateBase/);
  } finally {
    cleanup(root);
  }
})();

(function testSceneEntityRefsUsesExplicitFields() {
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

    var refItemFile = path.join(root, 'Assets', 'Scripts', 'Game', 'Level', 'GMP_SceneEntityRef.cs');
    var refsFile = path.join(root, 'Assets', 'Scripts', 'Game', 'Level', 'GMP_SceneEntityRefs.cs');
    assert.ok(fs.existsSync(refItemFile), 'scene entity ref item should be generated');
    assert.ok(fs.existsSync(refsFile), 'scene entity refs should be generated');

    var refsCode = fs.readFileSync(refsFile, 'utf8');
    assert.match(refsCode, /public GMP_SceneEntityRef mPlayer = new GMP_SceneEntityRef\(\)/);
    assert.match(refsCode, /public GMP_SceneEntityRef mChef = new GMP_SceneEntityRef\(\)/);
    assert.match(refsCode, /AddSceneEntity\("_chef", mChef\)/);
    assert.match(refsCode, /private GMP_SceneEntityRef EntityFor\(string entityName\)/);
    assert.doesNotMatch(refsCode, /\bmBindings\b/);
    assert.doesNotMatch(refsCode, /\bmEntityNames\b/);
    assert.doesNotMatch(refsCode, /\bmDefaultPositions\b/);
    assert.doesNotMatch(refsCode, /\bmDefaultScales\b/);
    assert.doesNotMatch(refsCode, /GMP_EntityBindingManager/);
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
    var entityManagerFile = path.join(root, 'Assets', 'Scripts', 'Core', 'Modules', 'GMP_EntityManager.cs');
    var phaseFile = path.join(root, 'Assets', 'Scripts', 'Core', 'Modules', 'GMP_PhaseController.cs');
    assert.ok(fs.existsSync(mainFile), 'GMP_MainManager.cs should be restored');
    assert.ok(fs.existsSync(entityManagerFile), 'GMP_EntityManager.cs should be restored');
    assert.ok(fs.existsSync(phaseFile), 'GMP_PhaseController.cs should be restored');
    var mainCode = fs.readFileSync(mainFile, 'utf8');
    var entityManagerCode = fs.readFileSync(entityManagerFile, 'utf8');
    var phaseCode = fs.readFileSync(phaseFile, 'utf8');
    assert.match(mainCode, /public class GMP_MainManager : MonoBehaviour/);
    assert.match(mainCode, /private static GMP_MainManager mInstance;/);
    assert.match(mainCode, /public static GMP_MainManager instance \{ get \{ return mInstance; \} \}/);
    assert.doesNotMatch(mainCode, /MonoSingleton|GMP_SingletonBase/);
    assert.match(entityManagerCode, /public class GMP_EntityManager : MonoBehaviour/);
    assert.match(entityManagerCode, /RegisterEntity\(GMP_BaseGameFlowEntity entity\)/);
    assert.match(phaseCode, /public class GMP_PhaseController : MonoBehaviour/);
    assert.match(phaseCode, /private static GMP_PhaseController mInstance;/);
    assert.match(phaseCode, /public static GMP_PhaseController instance \{ get \{ return mInstance; \} \}/);
    assert.doesNotMatch(phaseCode, /MonoSingleton|GMP_SingletonBase/);
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
