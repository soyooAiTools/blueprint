const assert = require('assert');

const compileStage = require('../engine/stages/compile.cjs');

{
  const repaired = compileStage._applyDeterministicBuildRepairs(
    [
      'using UnityEngine;',
      'public partial class GameFlowManagerMain : MonoBehaviour',
      '{',
      '    float moveSpeed = 5f; // [SKELETON]',
      '    bool DefenseTowerDone = false; // [SKELETON]',
      '    void Update()',
      '    {',
      '        float moveSpeed = 1f;',
      '    }',
      '}',
    ].join('\n'),
    {
      'GameFlowManagerMain.Flow.cs': [
        'using UnityEngine;',
        'public partial class GameFlowManagerMain : MonoBehaviour',
        '{',
        '    float moveSpeed = 8f;',
        '    bool DefenseTowerDone = false;',
        '}',
      ].join('\n'),
    },
    { entities: [] }
  );

  assert.strictEqual(repaired.changed, true);
  assert.ok(repaired.fixes.includes('DuplicateSimpleFields'));
  assert.ok(repaired.code.includes('float moveSpeed = 5f; // [SKELETON]'));
  assert.ok(repaired.code.includes('float moveSpeed = 1f;'));
  assert.ok(!repaired.extraFiles['GameFlowManagerMain.Flow.cs'].includes('float moveSpeed = 8f;'));
  assert.ok(!repaired.extraFiles['GameFlowManagerMain.Flow.cs'].includes('bool DefenseTowerDone = false;'));
}

{
  const repaired = compileStage._applyDeterministicBuildRepairs(
    [
      'using UnityEngine;',
      'public class GFM_UIManager : MonoBehaviour',
      '{',
      '    private bool _inited = false;',
      '    public void Init() { if (_inited) return; _inited = true; }',
      '}',
    ].join('\n'),
    {
      'GFM_Player.cs': [
        'using UnityEngine;',
        'public class GFM_Player : MonoBehaviour',
        '{',
        '    private bool _inited = false;',
        '    public void Init() { if (_inited) return; _inited = true; }',
        '}',
      ].join('\n'),
      'GFM_AutoPlay.cs': [
        'using UnityEngine;',
        'public class GFM_AutoPlay : MonoBehaviour',
        '{',
        '    private string[] _autoTargets;',
        '    private bool _inited = false;',
        '    public void Init() { if (_inited) return; _inited = true; }',
        '}',
      ].join('\n'),
    },
    { entities: [] }
  );

  assert.strictEqual(repaired.changed, false);
  assert.ok(repaired.code.includes('private bool _inited = false;'));
  assert.ok(repaired.extraFiles['GFM_Player.cs'].includes('private bool _inited = false;'));
  assert.ok(repaired.extraFiles['GFM_AutoPlay.cs'].includes('private bool _inited = false;'));
  assert.ok(repaired.extraFiles['GFM_AutoPlay.cs'].includes('private string[] _autoTargets;'));
}

{
  const repaired = compileStage._applyDeterministicBuildRepairs(
    [
      'using UnityEngine;',
      'public partial class GameFlowManagerMain : MonoBehaviour',
      '{',
      '    GameObject GoldRecycler; // [SKELETON]',
      '    int GoldRecyclerState = 0; // [SKELETON]',
      '}',
    ].join('\n'),
    {
      'GameFlowManagerMain.UI.cs': [
        'using UnityEngine;',
        'public partial class GameFlowManagerMain : MonoBehaviour',
        '{',
        '    GameObject GoldRecycler;',
        '    int GoldRecyclerState = 1;',
        '}',
      ].join('\n'),
    },
    { entities: [] }
  );

  assert.strictEqual(repaired.changed, true);
  assert.ok(repaired.fixes.includes('DuplicateObjectFields'));
  assert.ok(repaired.fixes.includes('DuplicateStateFields'));
  assert.ok(!repaired.extraFiles['GameFlowManagerMain.UI.cs'].includes('GameObject GoldRecycler;'));
  assert.ok(!repaired.extraFiles['GameFlowManagerMain.UI.cs'].includes('int GoldRecyclerState = 1;'));
}

{
  const repaired = compileStage._applyDeterministicBuildRepairs(
    [
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
      '    void Update() { SyncAutoPlayState(gameTimer); UpdatePhaseTimer(Time.deltaTime); if (_collectCooldown <= 0f && IsNear(null, collectCooldownInterval)) { AddGold(1); ShowFloatingText(player != null ? player.transform.position : Vector3.zero, "x", Color.yellow); } }',
      '    void AddCompletedPhase(string phaseName) { }',
      '    void ReportPhase(string phaseId) { }',
      '    void UpdateGameState() { }',
      '    void ShowCTA() { }',
      '    void Phase_OnTap() { }',
      '}',
    ].join('\n'),
    {},
    { entities: [] }
  );

  assert.strictEqual(repaired.changed, true);
  assert.ok(repaired.fixes.includes('MissingSkeletonBridgeInfra'));
  assert.ok(repaired.code.includes('InventoryCompat _inventory = new InventoryCompat();'));
  assert.ok(repaired.code.includes('void SyncAutoPlayState(float now)'));
  assert.ok(repaired.code.includes('void OnAutoPlayArrive(string targetName)'));
}

{
  const repaired = compileStage._applyDeterministicBuildRepairs(
    [
      'using UnityEngine;',
      'public partial class GameFlowManagerMain : MonoBehaviour',
      '{',
      '    GameObject EnemyAstronaut;',
      '    GameObject OurSoldier;',
      '    GameObject Bullet;',
      '    Text scoreText;',
      '    string _lastScoreText = "";',
      '    void Update() {',
      '        string display = "";',
      '        if (gold > 0) display += "gold: " + gold;',
      '        var spawned = GFM_Pool.Get("EnemyAstronaut");',
      '        var ally = GFM_Pool.Get("OurSoldier");',
      '        var proj = GFM_Pool.Get("projectile");',
      '        ((Rigidbody)proj.GetComponent(typeof(Rigidbody))).velocity = Vector3.zero;',
      '    }',
      '}',
    ].join('\n'),
    {},
    {
      entities: [
        { name: 'EnemyAstronaut', behavior: {} },
        { name: 'OurSoldier', behavior: {} },
        { name: 'Bullet', behavior: {} },
        { name: 'TowerShooter', behavior: { projectile: 'Bullet' } },
      ],
      resources: [{ name: 'Gold' }],
    }
  );

  assert.strictEqual(repaired.changed, true);
  assert.ok(repaired.fixes.includes('StringPoolPrefabLiterals x3'));
  assert.ok(repaired.fixes.includes('LegacyScoreDisplayAlias x1'));
  assert.ok(repaired.code.includes('if (GetResource("Gold") > 0) display += "gold: " + GetResource("Gold");'));
  assert.ok(repaired.code.includes('var spawned = GFM_Pool.Get(EnemyAstronaut);'));
  assert.ok(repaired.code.includes('var ally = GFM_Pool.Get(OurSoldier);'));
  assert.ok(repaired.code.includes('var proj = GFM_Pool.Get(Bullet);'));
}

{
  const repaired = compileStage._applyDeterministicBuildRepairs(
    [
      'using UnityEngine;',
      'public partial class GameFlowManagerMain : MonoBehaviour',
      '{',
      '    void Update() { }',
      '}',
    ].join('\n'),
    {
      'GameFlowManagerMain.Flow.cs': [
        'using UnityEngine;',
        'public partial class GameFlowManagerMain',
        '{',
        '    void Phase_Test_Init() {',
        '        AddResource("default", 1);',
        '        UnknownState = 1;',
        '        ShowFloatingText(player.transform.position, "undefined", Color.yellow);',
        '    }',
        '}',
      ].join('\n'),
    },
    { entities: [] }
  );

  assert.strictEqual(repaired.changed, true);
  assert.ok(repaired.fixes.includes('GameFlowManagerMain.Flow.cs:UnresolvedPhaseInitArtifacts x3'));
  assert.ok(!repaired.extraFiles['GameFlowManagerMain.Flow.cs'].includes('UnknownState = 1;'));
  assert.ok(!repaired.extraFiles['GameFlowManagerMain.Flow.cs'].includes('AddResource("default", 1);'));
  assert.ok(repaired.extraFiles['GameFlowManagerMain.Flow.cs'].includes('ShowFloatingText(player.transform.position, "", Color.yellow);'));
}

{
  const repaired = compileStage._applyDeterministicBuildRepairs(
    [
      'using UnityEngine;',
      'public partial class GameFlowManagerMain : MonoBehaviour',
      '{',
      '    void Update() {',
      '        if (IsNear(, 2f)) { }',
      '        if (GoldRecycler != null && IsNear(, collectRange)) { }',
      '    }',
      '}',
    ].join('\n'),
    {},
    { entities: [] }
  );

  assert.strictEqual(repaired.changed, true);
  assert.ok(repaired.fixes.includes('MalformedIsNear'));
  assert.ok(!/IsNear\(\s*,/.test(repaired.code));
  assert.ok(repaired.code.includes('if (false /* stripped malformed IsNear */) { }'));
}

console.log('compile deterministic repair tests passed');
