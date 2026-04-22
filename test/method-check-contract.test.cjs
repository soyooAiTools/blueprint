const assert = require('assert');

const methodCheck = require('../engine/stages/method-check.cjs');

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
  assert.ok(invalidPools.data.includes('__Pool_Cube_Gold_01'));
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

console.log('method-check contract tests passed');
