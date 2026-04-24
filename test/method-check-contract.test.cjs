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
      'public partial class GameFlowManagerMain : MonoBehaviour',
      '{',
      '    GameObject GoldRecycler; // [SKELETON]',
      '    void Update() { }',
      '}',
    ].join('\n'),
    extraFiles: {
      'GameFlowManagerMain.UI.cs': [
        'using UnityEngine;',
        'public partial class GameFlowManagerMain : MonoBehaviour',
        '{',
        '    GameObject GoldRecycler;',
        '}',
      ].join('\n'),
    },
    blueprint: { entities: [] },
  };
  const violations = methodCheck.detectContractViolations(ctx);
  assert.ok(violations.some(v => v.rule === 'duplicate-object-fields'));
  const changed = methodCheck.autoRepairDuplicateObjectFields(ctx);
  assert.strictEqual(changed, true);
  assert.ok(!ctx.extraFiles['GameFlowManagerMain.UI.cs'].includes('GameObject GoldRecycler;'));
  assert.ok(!methodCheck.detectContractViolations(ctx).some(v => v.rule === 'duplicate-object-fields'));
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
      '    void Update() { if (IsNear(, 2f)) { } }',
      '}',
    ].join('\n'),
    extraFiles: {},
    blueprint: { entities: [] },
  };
  const violations = methodCheck.detectContractViolations(ctx);
  assert.ok(violations.some(v => v.rule === 'malformed-isnear-call'));
  const changed = methodCheck.autoRepairMalformedIsNear(ctx);
  assert.strictEqual(changed, true);
  assert.ok(!/IsNear\(\s*,/.test(ctx.csCode));
}

{
  const ctx = {
    csCode: [
      'using UnityEngine;',
      'public class Demo : MonoBehaviour',
      '{',
      '    void Update() { var rb = gameObject.GetComponent<Rigidbody>(); ((Rigidbody)gameObject.GetComponent(typeof(Rigidbody))).velocity = Vector3.zero; }',
      '}',
    ].join('\n'),
    extraFiles: {},
    blueprint: { entities: [] },
  };
  const changed = methodCheck.autoRepairForbiddenGenericApis(ctx);
  assert.strictEqual(changed, true);
  assert.ok(ctx.csCode.includes('var rb = ((Rigidbody)gameObject.GetComponent(typeof(Rigidbody)));'));
  assert.ok(!/GetComponent\s*</.test(ctx.csCode));
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

{
  const ctx = {
    csCode: [
      'using UnityEngine;',
      'using UnityEngine.UI;',
      'public partial class GameFlowManagerMain : MonoBehaviour',
      '{',
      '    float phaseTimer = 0f;',
      '    string lastPhaseForTimer = "";',
      '    string currentPhaseName = "init";',
      '    bool _autoPlayMode = false;',
      '    int _autoPlaySteps = 0;',
      '    int _autoPlayStepsAtPhaseStart = 0;',
      '    float gameTimer = 0f;',
      '    bool gameEnded = false;',
      '    bool[] ruleTriggered;',
      '    string[] completedPhases;',
      '    int completedPhaseCount = 0;',
      '    float[] phaseEnterTimes;',
      '    Text guideText;',
      '    Text scoreText;',
      '    void Start() { _inventory["Gold"] = 0; _SyncResourcesToManager(); GFM_AutoPlay.Instance.OnArrive = OnAutoPlayArrive; }',
      '    void Update() { SyncAutoPlayState(gameTimer); UpdatePhaseTimer(Time.deltaTime); if (_collectCooldown <= 0f && IsNear(null, collectCooldownInterval)) { if (_lastScoreText != "x") _lastScoreText = "x"; AddGold(1); ShowFloatingText(player != null ? player.transform.position : Vector3.zero, "x", Color.yellow); } }',
      '    void AddCompletedPhase(string phaseName) { }',
      '    void ReportPhase(string phaseId) { }',
      '    void UpdateGameState() { }',
      '    void ShowCTA() { }',
      '    void Phase_OnTap() { }',
      '}',
    ].join('\n'),
    extraFiles: Object.assign({}, gfmFiles),
    blueprint: { entities: [] },
  };
  const changed = methodCheck.autoRepairMissingSkeletonBridgeInfra(ctx);
  assert.strictEqual(changed, true);
  assert.ok(ctx.csCode.includes('ResourceDef[] _resources;'));
  assert.ok(ctx.csCode.includes('InventoryCompat _inventory = new InventoryCompat();'));
  assert.ok(ctx.csCode.includes('float collectCooldownInterval = 0.3f;'));
  assert.ok(ctx.csCode.includes('float _collectCooldown = 0f;'));
  assert.ok(ctx.csCode.includes('string _lastScoreText = "";'));
  assert.ok(ctx.csCode.includes('GameObject player'));
  assert.ok(ctx.csCode.includes('void SyncAutoPlayState(float now)'));
  assert.ok(ctx.csCode.includes('void UpdatePhaseTimer(float dt)'));
  assert.ok(ctx.csCode.includes('void _SyncResourcesToManager()'));
  assert.ok(ctx.csCode.includes('bool IsNear(GameObject target, float range)'));
  assert.ok(ctx.csCode.includes('void AddGold(int amount)'));
  assert.ok(ctx.csCode.includes('void ShowFloatingText(Vector3 worldPos, string text, Color color)'));
  assert.ok(!ctx.csCode.includes('GFM_UIManager.Instance'));
  assert.ok(ctx.csCode.includes('void OnAutoPlayArrive(string targetName)'));
}

console.log('method-check contract tests passed');
