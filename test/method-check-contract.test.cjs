const assert = require('assert');

const methodCheck = require('../engine/stages/method-check.cjs');
const gfmFiles = require('../worker/gfm-files.cjs').loadGfmFiles();

{
  const ctx = {
    csCode: [
      'using UnityEngine;',
      'public class Demo : MonoBehaviour',
      '{',
      '    int LaserTurretState;',
      '    int LaserTurretState;',
      '    void Update() { }',
      '}',
    ].join('\n'),
    extraFiles: {},
    blueprint: { entities: [] },
  };
  const violations = methodCheck.detectContractViolations(ctx);
  assert.ok(violations.some(v => v.rule === 'duplicate-state-fields'));
}

{
  const ctx = {
    csCode: [
      'using UnityEngine;',
      'public partial class GameFlowManagerMain : MonoBehaviour',
      '{',
      '    int LaserTurretState = 0; // [SKELETON]',
      '    int EnemyState = 0; // [SKELETON]',
      '}',
    ].join('\n'),
    extraFiles: {
      'GameFlowManagerMain.UI.cs': [
        'public partial class GameFlowManagerMain',
        '{',
        '    int LaserTurretState = 1; // AI duplicate with trailing comment',
        '}',
      ].join('\n'),
      'GameFlowManagerMain.Resource.cs': [
        'public partial class GameFlowManagerMain',
        '{',
        '    int EnemyState = 2; /* another duplicate with trailing block comment */',
        '}',
      ].join('\n'),
    },
    blueprint: { entities: [] },
  };
  const changed = methodCheck.autoRepairDuplicateStateFields(ctx);
  assert.strictEqual(changed, true);
  assert.ok(ctx.csCode.includes('int LaserTurretState = 0; // [SKELETON]'));
  assert.ok(ctx.csCode.includes('int EnemyState = 0; // [SKELETON]'));
  assert.ok(!ctx.extraFiles['GameFlowManagerMain.UI.cs'].includes('LaserTurretState = 1'));
  assert.ok(!ctx.extraFiles['GameFlowManagerMain.Resource.cs'].includes('EnemyState = 2'));
  const violations = methodCheck.detectContractViolations(ctx);
  assert.ok(!violations.some(v => v.rule === 'duplicate-state-fields'));
}

{
  const ctx = {
    csCode: [
      'using UnityEngine;',
      'public class Demo : MonoBehaviour',
      '{',
      '    Rigidbody rb;',
      '    void Update() { rb = gameObject.GetComponent<Rigidbody>(); }',
      '}',
    ].join('\n'),
    extraFiles: {},
    blueprint: { entities: [] },
  };
  const violations = methodCheck.detectContractViolations(ctx);
  assert.ok(violations.some(v => v.rule === 'forbidden-generic-api'));
}

{
  const ctx = {
    csCode: [
      'using UnityEngine;',
      'public class Demo : MonoBehaviour',
      '{',
      '    GameObject Player;',
      '    GameObject PlayerAvatar;',
      '    void Update() { if (player != null) {} if (Player != null) {} if (PlayerAvatar != null) {} }',
      '}',
    ].join('\n'),
    extraFiles: {},
    blueprint: { entities: [] },
  };
  const violations = methodCheck.detectContractViolations(ctx);
  assert.ok(violations.some(v => v.rule === 'player-alias-drift'));
  const drift = violations.find(v => v.rule === 'player-alias-drift');
  assert.strictEqual(drift.data.canonicalAlias, 'Player');
  assert.ok(/Normalize all player references to `Player`/.test(drift.message));
}

{
  const ctx = {
    csCode: [
      'using UnityEngine;',
      'public class Demo : MonoBehaviour',
      '{',
      '    void Start() { var x = GameObject.Find("__Pool_Cube_Gold_01"); }',
      '    void Update() { }',
      '}',
    ].join('\n'),
    extraFiles: {},
    blueprint: {
      entities: [
        { pool: '__Pool_Cube_Blue_01' },
        { pool: '__Pool_Sphere_Red_02' },
      ],
    },
  };
  const violations = methodCheck.detectContractViolations(ctx);
  const invalidPools = violations.find(v => v.rule === 'invalid-pool-literals');
  assert.ok(invalidPools);
  assert.ok(invalidPools.data.invalidPools.includes('__Pool_Cube_Gold_01'));
  assert.ok(invalidPools.data.allowedPools.includes('__Pool_Cube_Blue_01'));
}

{
  const ctx = {
    csCode: [
      'using UnityEngine;',
      'public class Demo : MonoBehaviour',
      '{',
      '    GameObject player;',
      '    int LaserTurretState;',
      '    void Update() { ShowCTA(); var x = GameObject.Find("__Pool_Cube_Blue_01"); }',
      '}',
    ].join('\n'),
    extraFiles: {},
    blueprint: {
      entities: [
        { pool: '__Pool_Cube_Blue_01' },
      ],
    },
  };
  const violations = methodCheck.detectContractViolations(ctx);
  assert.deepStrictEqual(violations, []);
}

{
  const ctx = {
    csCode: [
      'using UnityEngine;',
      'public class Demo : MonoBehaviour',
      '{',
      '    // player is mentioned in comment only',
      '    string s = "PlayerAvatar";',
      '    GameObject player;',
      '    void Update() { if (player != null) {} }',
      '}',
    ].join('\n'),
    extraFiles: {},
    blueprint: { entities: [] },
  };
  const violations = methodCheck.detectContractViolations(ctx);
  assert.deepStrictEqual(violations, []);
}

{
  const ctx = {
    csCode: [
      'using UnityEngine;',
      'public partial class GameFlowManagerMain : MonoBehaviour',
      '{',
      '    void Update() { }',
      '}',
    ].join('\n'),
    extraFiles: gfmFiles,
    blueprint: { entities: [] },
  };
  const violations = methodCheck.detectContractViolations(ctx);
  assert.deepStrictEqual(violations, []);
}

{
  const ctx = {
    csCode: [
      'using UnityEngine;',
      'public partial class GameFlowManagerMain : MonoBehaviour',
      '{',
      '    void Update() { var x = gameObject.GetComponent<Renderer>(); }',
      '}',
    ].join('\n'),
    extraFiles: Object.assign({}, gfmFiles),
    blueprint: { entities: [] },
  };
  const violations = methodCheck.detectContractViolations(ctx);
  assert.ok(violations.some(v => v.rule === 'forbidden-generic-api'));
}

console.log('method-check contract tests passed');
