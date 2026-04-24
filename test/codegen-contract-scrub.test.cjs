const assert = require('assert');

const codegenSchema = require('../engine/stages/codegen-schema.cjs');
const methodCheck = require('../engine/stages/method-check.cjs');

const ctx = {
  csCode: [
    'using UnityEngine;',
    'public partial class GameFlowManagerMain : MonoBehaviour',
    '{',
    '    GameObject Player;',
    '    int LaserTurretState = 0;',
    '    void Update()',
    '    {',
    '        var rb = gameObject.GetComponent<Rigidbody>();',
    '        if (player != null) { }',
    '        var obj = GameObject.Find("__Pool_Cube_Gold_01");',
    '    }',
    '}',
  ].join('\n'),
  extraFiles: {
    'GameFlowManagerMain.Flow.cs': [
      'using UnityEngine;',
      'public partial class GameFlowManagerMain : MonoBehaviour',
      '{',
      '    int LaserTurretState = 1;',
      '    GameObject Player;',
      '    void Tick() { PlayerAvatar = Player; }',
      '}',
    ].join('\n'),
  },
  blueprint: {
    entities: [
      { pool: '__Pool_Cube_Blue_01' },
    ],
  },
};

const result = codegenSchema._applyGeneratedCodeContractScrub(ctx);
assert.strictEqual(result.changed, true);
assert.ok(result.fixes.includes('ForbiddenGenericApi'));
assert.ok(result.fixes.includes('DuplicateStateFields'));
assert.ok(result.fixes.includes('DuplicateObjectFields'));
assert.ok(result.fixes.includes('PlayerAliasDrift'));
assert.ok(result.fixes.includes('InvalidPoolLiterals'));
assert.deepStrictEqual(methodCheck.detectContractViolations(ctx), []);

console.log('codegen contract scrub tests passed');
