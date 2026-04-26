const assert = require('assert');

const { staticCheckProject } = require('../engine/static-check.cjs');

{
  const result = staticCheckProject(
    [
      'using UnityEngine;',
      'public partial class GameFlowManagerMain : MonoBehaviour',
      '{',
      '    void SpawnEnemy(int count) { }',
      '    void SpawnEnemySpawner(int count) { }',
      '    void SpawnEnemy(int count) { SpawnEnemySpawner(count); }',
      '}',
    ].join('\n'),
    { extraFiles: {} }
  );
  const hit = result.issues.find(function(issue) {
    return issue.rule === 'partial-method-duplicate' && /duplicated earlier in the same file/.test(issue.text);
  });
  assert.ok(hit, 'same-file duplicate methods should be caught before compile');
}

console.log('static-check duplicate method tests passed');
