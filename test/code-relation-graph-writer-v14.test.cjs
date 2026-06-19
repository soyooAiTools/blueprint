'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var writer = require('../lib/code-relation-graph-writer.cjs');

var root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-relation-v14-'));
try {
  fs.mkdirSync(path.join(root, 'Assets', 'Scripts', 'Core', 'Modules'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Assets', 'Scripts', 'Core', 'Common'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Assets', 'Scripts', 'Game', 'Level'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Assets', 'Scripts', 'Game', 'Entities'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Assets', 'Scripts', 'Game', 'Player'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Assets', 'Scripts', 'Game', 'Phases'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Assets', 'Scripts', 'Tool'), { recursive: true });
  fs.mkdirSync(path.join(root, 'ProjectSettings'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), '# Unity 工程导出\n\n## 目录\n');
  fs.writeFileSync(path.join(root, 'Assets', 'Scripts', 'Core', 'Modules', 'GMP_MainManager.cs'), [
    'public class GMP_MainManager',
    '{',
    '  public void Start() {}',
    '  public void Update() {}',
    '}',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'Assets', 'Scripts', 'Core', 'Modules', 'GMP_PhaseController.cs'), 'public class GMP_PhaseController {}\n');
  fs.writeFileSync(path.join(root, 'Assets', 'Scripts', 'Core', 'Common', 'GMP_SceneObjectRegistry.cs'), 'public class GMP_SceneObjectRegistry {}\n');
  fs.writeFileSync(path.join(root, 'Assets', 'Scripts', 'Game', 'Level', 'GMP_LevelRuleEngine.cs'), 'public class GMP_LevelRuleEngine {}\n');
  fs.writeFileSync(path.join(root, 'Assets', 'Scripts', 'Game', 'Entities', 'GMP_ChefEntity.cs'), 'public class GMP_ChefEntity {}\n');
  fs.writeFileSync(path.join(root, 'Assets', 'Scripts', 'Game', 'Player', 'GMP_Player.cs'), 'public class GMP_Player {}\n');
  fs.writeFileSync(path.join(root, 'Assets', 'Scripts', 'Tool', 'GMP_CameraTool.cs'), 'public class GMP_CameraTool {}\n');
  fs.writeFileSync(path.join(root, 'Assets', 'Scripts', 'Game', 'Phases', 'Phase1.asset'), [
    '--- !u!114 &11400000',
    'MonoBehaviour:',
    '  m_Name: Phase1',
    '  mPhaseId: serve',
    ''
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'Assets', 'Scripts', 'Game', 'Phases', 'Phase2.asset'), [
    '--- !u!114 &11400000',
    'MonoBehaviour:',
    '  m_Name: Phase2',
    '  mPhaseId: unlock',
    ''
  ].join('\n'));

  writer.writeCodeRelationGraphs(root, { projectId: 'p', projectName: 'Blueprint 2.0 Fixture' });

  var md = fs.readFileSync(path.join(root, 'CODE_RELATION_GRAPH.md'), 'utf8');
  var html = fs.readFileSync(path.join(root, 'CODE_RELATION_GRAPH.html'), 'utf8');
  [md, html].forEach(function(text) {
    assert.doesNotMatch(text, /\bv14\b/i);
    assert.doesNotMatch(text, /\bCheckEventRules\b/);
    assert.doesNotMatch(text, /\bGFM_Player\b/);
    assert.doesNotMatch(text, /\bPhase_(?:[A-Za-z0-9_]+_)?OnTap\b|\bPhase_OnTap\b/);
    assert.doesNotMatch(text, /\bRunGeneratedAssemblySlotRunners\b/);
    assert.doesNotMatch(text, /Common\(s\)\/GFM_\*\.cs/);
    assert.match(text, /Blueprint 2\.0/);
    assert.match(text, /Core\/Modules\/GMP_MainManager\.cs/);
    assert.match(text, /GMP_PhaseController/);
    assert.match(text, /GMP_LevelRuleEngine/);
    assert.match(text, /serve|unlock/);
  });
  assert.match(md, /Core\/Common/);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('code relation graph writer v14 tests passed');
