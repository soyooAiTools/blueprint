const assert = require('assert');

const methodCheck = require('../engine/stages/method-check.cjs');

{
  const ctx = {
    csCode: [
      'using UnityEngine;',
      'public partial class GameFlowManagerMain : MonoBehaviour',
      '{',
      '    float moveSpeed = 5f; // [SKELETON]',
      '    bool DefenseTowerDone = false; // [SKELETON]',
      '    void Update()',
      '    {',
      '        float moveSpeed = 1f;',
      '        bool DefenseTowerDone = false;',
      '    }',
      '}',
    ].join('\n'),
    extraFiles: {
      'GameFlowManagerMain.Flow.cs': [
        'using UnityEngine;',
        'public partial class GameFlowManagerMain : MonoBehaviour',
        '{',
        '    float moveSpeed = 8f;',
        '    bool DefenseTowerDone = false;',
        '}',
      ].join('\n'),
    },
  };
  const changed = methodCheck.autoRepairDuplicateSimpleFields(ctx);
  assert.strictEqual(changed, true);
  assert.match(ctx.csCode, /float moveSpeed = 5f;/);
  assert.match(ctx.csCode, /bool DefenseTowerDone = false; \/\/ \[SKELETON\]/);
  assert.match(ctx.csCode, /float moveSpeed = 1f;/);
  assert.match(ctx.csCode, /bool DefenseTowerDone = false;\n    }\n}$/);
  assert.doesNotMatch(ctx.extraFiles['GameFlowManagerMain.Flow.cs'], /float moveSpeed = 8f;/);
  assert.doesNotMatch(ctx.extraFiles['GameFlowManagerMain.Flow.cs'], /bool DefenseTowerDone = false;/);
}

{
  const ctx = {
    csCode: [
      'using UnityEngine;',
      'public class FirstManager : MonoBehaviour',
      '{',
      '    private bool _inited = false;',
      '}',
    ].join('\n'),
    extraFiles: {
      'SecondManager.cs': [
        'using UnityEngine;',
        'public class SecondManager : MonoBehaviour',
        '{',
        '    private bool _inited = false;',
        '}',
      ].join('\n'),
    },
  };
  const changed = methodCheck.autoRepairDuplicateSimpleFields(ctx);
  assert.strictEqual(changed, false);
  assert.match(ctx.csCode, /private bool _inited = false;/);
  assert.match(ctx.extraFiles['SecondManager.cs'], /private bool _inited = false;/);
}

{
  const ctx = {
    csCode: [
      'using UnityEngine;',
      'public class CameraOwner : MonoBehaviour',
      '{',
      '    GameObject target;',
      '}',
    ].join('\n'),
    extraFiles: {
      'PlayerOwner.cs': [
        'using UnityEngine;',
        'public class PlayerOwner : MonoBehaviour',
        '{',
        '    GameObject target;',
        '}',
      ].join('\n'),
    },
  };
  const changed = methodCheck.autoRepairDuplicateObjectFields(ctx);
  assert.strictEqual(changed, false);
  assert.match(ctx.csCode, /GameObject target;/);
  assert.match(ctx.extraFiles['PlayerOwner.cs'], /GameObject target;/);
}

{
  const ctx = {
    csCode: [
      'using UnityEngine;',
      'public class Demo : MonoBehaviour',
      '{',
      '    GameObject Worker1;',
      '    void Update()',
      '    {',
      '        AutoWorkerTick(Worker1, ref _carry, ref _state);',
      '    }',
      '    int _carry;',
      '    int _state;',
      '}',
    ].join('\n'),
    extraFiles: {},
  };

  const beforeMissing = methodCheck.checkCompleteness(ctx.csCode, ctx.extraFiles);
  assert.deepStrictEqual(beforeMissing, ['AutoWorkerTick']);

  const changed = methodCheck.injectMissingHelpers(ctx, beforeMissing);
  assert.strictEqual(changed, true);
  assert.match(ctx.csCode, /void AutoWorkerTick\(GameObject worker, ref int carry, ref int state\)/);

  const afterMissing = methodCheck.checkCompleteness(ctx.csCode, ctx.extraFiles);
  assert.deepStrictEqual(afterMissing, []);
}

{
  const ctx = {
    csCode: [
      'using UnityEngine;',
      'public class Demo : MonoBehaviour',
      '{',
      '    void Update()',
      '    {',
      '        ShowCTA();',
      '    }',
      '}',
    ].join('\n'),
    extraFiles: {},
  };
  const missing = methodCheck.checkCompleteness(ctx.csCode, ctx.extraFiles);
  assert.deepStrictEqual(missing, []);
  const changed = methodCheck.injectMissingHelpers(ctx, missing);
  assert.strictEqual(changed, false);
}

{
  const ctx = {
    csCode: [
      'using UnityEngine;',
      'using UnityEngine.UI;',
      'public class Demo : MonoBehaviour',
      '{',
      '    Canvas uiCanvas;',
      '    Text guideText;',
      '    Text scoreText;',
      '    GameObject target;',
      '    void Start()',
      '    {',
      '        AddLocalWorldLabel(target, "目标", 1.5f);',
      '        uiCanvas = CreateLocalCanvas(1920, 1080);',
      '        guideText = CreateLocalText(uiCanvas, "GuideText", "点击目标", new Vector2(0, 100), 42);',
      '        scoreText = CreateLocalText(uiCanvas, "ScoreText", "Score: 0", new Vector2(0, 0), 32);',
      '    }',
      '    void Update() { }',
      '}',
    ].join('\n'),
    extraFiles: {},
  };
  const beforeMissing = methodCheck.checkCompleteness(ctx.csCode, ctx.extraFiles).sort();
  assert.deepStrictEqual(beforeMissing, ['AddLocalWorldLabel', 'CreateLocalCanvas', 'CreateLocalText']);

  const changed = methodCheck.autoRepairLocalUiHelperAliases(ctx);
  assert.strictEqual(changed, true);
  assert.match(ctx.csCode, /GFM_UI\.AddWorldLabel\(target, "目标", 1\.5f\)/);
  assert.match(ctx.csCode, /uiCanvas = GFM_UI\.CreateCanvas\(1920, 1080\)/);
  assert.match(ctx.csCode, /guideText = GFM_UI\.CreateText\(uiCanvas, "点击目标", new Vector2\(0, 100\), 42\)/);
  assert.match(ctx.csCode, /scoreText = GFM_UI\.CreateText\(uiCanvas, "Score: 0", new Vector2\(0, 0\), 32\)/);

  const afterMissing = methodCheck.checkCompleteness(ctx.csCode, ctx.extraFiles);
  assert.deepStrictEqual(afterMissing, []);
}

{
  const ctx = {
    csCode: [
      'using UnityEngine;',
      'public partial class Demo : MonoBehaviour',
      '{',
      '    GameObject Player;',
      '    void Update()',
      '    {',
      '        if (player != null) { }',
      '        if (PlayerAvatar != null) { }',
      '    }',
      '}',
    ].join('\n'),
    extraFiles: {
      'GameFlowManagerMain.Flow.cs': [
        'using UnityEngine;',
        'public partial class Demo : MonoBehaviour',
        '{',
        '    // [ASSEMBLY SLOT] Player::move_to_target',
        '    void Tick() { PlayerAvatar = Player; }',
        '}',
      ].join('\n'),
    },
  };
  const changed = methodCheck.autoRepairPlayerAliasDrift(ctx);
  assert.strictEqual(changed, true);
  assert.strictEqual(methodCheck.detectPlayerAliasDrift(methodCheck.buildTaskAggregateCode(ctx)).length, 0);
  assert.match(ctx.csCode, /\bPlayer\b/);
  assert.doesNotMatch(ctx.csCode, /\bplayer\b/);
  assert.doesNotMatch(ctx.csCode, /\bPlayerAvatar\b/);
  assert.match(ctx.extraFiles['GameFlowManagerMain.Flow.cs'], /\[ASSEMBLY SLOT\] Player::move_to_target/);
}

{
  const ctx = {
    csCode: 'public partial class GameFlowManagerMain { void Update() { } }',
    extraFiles: {
      'GameFlowManagerMain.Resource.cs': [
        'public partial class GameFlowManagerMain',
        '{',
        '    // [ASSEMBLY SLOT] player::cost_gate',
        '    void AssemblySlot_Resource_Player__cost_gate() { }',
        '}',
      ].join('\n'),
    },
    blueprint: {
      plans: {
        assemblyPlan: {
          moduleInstances: [
            { id: 'Player::cost_gate', moduleId: 'cost_gate', ownerFiles: ['GameFlowManagerMain.Resource.cs'] },
          ],
          fileOwners: [
            { file: 'GameFlowManagerMain.Resource.cs', moduleInstanceIds: ['Player::cost_gate'] },
          ],
          stateOwners: [],
          phaseBindings: [],
        },
      },
    },
  };
  assert.ok(methodCheck.detectContractViolations(ctx).some(v => v.rule === 'assembly-module-owner-mismatch'));
  const changed = methodCheck.autoRepairAssemblyModuleOwnerMismatch(ctx);
  assert.strictEqual(changed, true);
  assert.match(ctx.extraFiles['GameFlowManagerMain.Resource.cs'], /\[ASSEMBLY SLOT\] Player::cost_gate/);
  assert.ok(!methodCheck.detectContractViolations(ctx).some(v => v.rule === 'assembly-module-owner-mismatch'));
}

{
  const ctx = {
    csCode: 'public partial class GameFlowManagerMain { void Update() { } }',
    extraFiles: {
      'GameFlowManagerMain.Flow.cs': [
        'public partial class GameFlowManagerMain',
        '{',
        '    // [ASSEMBLY SLOT] ForgeWorkshop::build_progress',
        '    void AssemblySlot_Flow_ForgeWorkshop__build_progress() { ForgeWorkshopState = 2; }',
        '}',
      ].join('\n'),
      'GameFlowManagerMain.Resource.cs': [
        'public partial class GameFlowManagerMain',
        '{',
        '    // [ASSEMBLY SLOT] ForgeWorkshop::collect_on_near',
        '    void AssemblySlot_Resource_ForgeWorkshop__collect_on_near()',
        '    {',
        '        ForgeWorkshopState = Mathf.Max(ForgeWorkshopState, 1);',
        '        RecordPhaseEvidenceFlag(currentPhaseName, "source_hidden_or_moved");',
        '    }',
        '}',
      ].join('\n'),
    },
    blueprint: {
      plans: {
        assemblyPlan: {
          moduleInstances: [
            { id: 'ForgeWorkshop::build_progress', moduleId: 'build_progress', ownerFiles: ['GameFlowManagerMain.Flow.cs'] },
            { id: 'ForgeWorkshop::collect_on_near', moduleId: 'collect_on_near', ownerFiles: ['GameFlowManagerMain.Resource.cs'] },
          ],
          fileOwners: [
            { file: 'GameFlowManagerMain.Flow.cs', moduleInstanceIds: ['ForgeWorkshop::build_progress'] },
            { file: 'GameFlowManagerMain.Resource.cs', moduleInstanceIds: ['ForgeWorkshop::collect_on_near'] },
          ],
          stateOwners: [
            { state: 'ForgeWorkshop.buildState', moduleInstanceId: 'ForgeWorkshop::build_progress' },
          ],
          phaseBindings: [],
        },
      },
    },
  };
  assert.ok(methodCheck.detectContractViolations(ctx).some(v => v.rule === 'assembly-state-owner-mismatch'));
  const changed = methodCheck.autoRepairAssemblyStateOwnerMismatch(ctx);
  assert.strictEqual(changed, true);
  assert.doesNotMatch(ctx.extraFiles['GameFlowManagerMain.Resource.cs'], /ForgeWorkshopState =/);
  assert.ok(!methodCheck.detectContractViolations(ctx).some(v => v.rule === 'assembly-state-owner-mismatch'));
}

{
  const ctx = {
    csCode: 'public partial class GameFlowManagerMain { void Update() { } }',
    extraFiles: {
      'GameFlowManagerMain.Resource.cs': [
        'public partial class GameFlowManagerMain',
        '{',
        '    // [ASSEMBLY SLOT] system::inventory_wallet',
        '    void AddResource(string id, int amount) { }',
        '    void UpdateResourceUI() { }',
        '}',
      ].join('\n'),
      'GameFlowManagerMain.UI.cs': [
        'public partial class GameFlowManagerMain',
        '{',
        '    int gold = 0;',
        '    // [ASSEMBLY SLOT] system::score_feedback',
        '    void AddGold(int amount)',
        '    {',
        '        gold += amount;',
        '        if (scoreText != null) scoreText.text = "G " + gold;',
        '    }',
        '}',
      ].join('\n'),
    },
    blueprint: {
      plans: {
        assemblyPlan: {
          moduleInstances: [
            { id: 'system::inventory_wallet', moduleId: 'inventory_wallet', ownerFiles: ['GameFlowManagerMain.Resource.cs'] },
            { id: 'system::score_feedback', moduleId: 'score_feedback', ownerFiles: ['GameFlowManagerMain.UI.cs'] },
          ],
          fileOwners: [
            { file: 'GameFlowManagerMain.Resource.cs', moduleInstanceIds: ['system::inventory_wallet'] },
            { file: 'GameFlowManagerMain.UI.cs', moduleInstanceIds: ['system::score_feedback'] },
          ],
          stateOwners: [
            { state: 'economy.gold', moduleInstanceId: 'system::inventory_wallet' },
          ],
          phaseBindings: [],
        },
      },
    },
  };
  assert.ok(methodCheck.detectContractViolations(ctx).some(v => v.rule === 'assembly-state-owner-mismatch'));
  const changed = methodCheck.autoRepairAssemblyStateOwnerMismatch(ctx);
  assert.strictEqual(changed, true);
  assert.doesNotMatch(ctx.extraFiles['GameFlowManagerMain.UI.cs'], /\bint gold\b|\bgold \+=| \+ gold/);
  assert.match(ctx.extraFiles['GameFlowManagerMain.UI.cs'], /AddResource\(GFM_ResourceIds\.Gold, amount\)/);
  assert.match(ctx.extraFiles['GameFlowManagerMain.UI.cs'], /UpdateResourceUI\(\);/);
  assert.ok(!methodCheck.detectContractViolations(ctx).some(v => v.rule === 'assembly-state-owner-mismatch'));
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
  const changed = methodCheck.autoRepairInvalidPoolLiterals(ctx);
  assert.strictEqual(changed, true);
  assert.match(ctx.csCode, /__Pool_Cube_Blue_01/);
  assert.deepStrictEqual(methodCheck.detectInvalidPoolLiterals(ctx.csCode, ctx), []);
}

{
  const ctx = {
    csCode: [
      'using UnityEngine;',
      'public partial class GameFlowManagerMain : MonoBehaviour',
      '{',
      '    Vector3 _snap_goldObjPos;',
      '    GameObject goldObj;',
      '    bool[] ruleTriggered = new bool[2];',
      '    string currentPhaseName = "buildForge";',
      '    bool EntityAdvanced(GameObject obj, Vector3 snap) { return false; }',
      '    void Update()',
      '        {',
      '            if (!ruleTriggered[1] && currentPhaseName == "buildForge")',
      '            {',
      '                // TODO_PHASE_1_INIT_START',
      '                PlaceObj(goldObj, 1f, 2f, 3f);',
      '                _snap_goldObjPos = goldObj.transform.position;',
      '                // TODO_PHASE_1_INIT_END',
      '                currentPhaseName = "buildForge";',
      '            }',
      '            switch (currentPhaseName)',
      '            {',
      '                case "buildForge":',
      '                    break;',
      '            }',
      '            if (EntityAdvanced(goldObj, _snap_goldObjPos))',
      '            {',
      '                ruleTriggered[1] = true;',
      '            }',
      '        }',
      '    void OnAutoPlayArrive(string phaseName)',
      '    {',
      '        switch (phaseName)',
      '        {',
      '            case "buildForge":',
      '                break;',
      '        }',
      '    }',
      '    void PlaceObj(GameObject obj, float x, float y, float z) {}',
      '}',
    ].join('\n'),
    extraFiles: {},
    blueprint: { entities: [] },
  };
  const before = methodCheck.detectPhaseGateViolations(ctx);
  assert.ok(before.some(v => v.rule === 'phase-entity-init-only'));
  const repair = methodCheck.autoRepairPhaseGateViolations(ctx, 2);
  assert.strictEqual(repair.changed, true);
  assert.deepStrictEqual(repair.violations, []);
}

{
  const ctx = {
    csCode: [
      'using UnityEngine;',
      'public partial class GameFlowManagerMain : MonoBehaviour',
      '{',
      '    Vector3 _snap_OxygenTankPos;',
      '    GameObject OxygenTank;',
      '    bool[] ruleTriggered = new bool[3];',
      '    string currentPhaseName = "";',
      '    bool EntityAdvanced(GameObject obj, Vector3 snap) { return false; }',
      '    void Update()',
      '    {',
      '        if (!ruleTriggered[2] && phaseTimer >= 1f)',
      '        {',
      '            currentPhaseName = "sellOxygen";',
      '            // TODO_PHASE_2_INIT_START',
      '            PlaceObj(OxygenTank, 0f, 1f, 2f);',
      '            _snap_OxygenTankPos = OxygenTank.transform.position;',
      '            // TODO_PHASE_2_INIT_END',
      '        }',
      '        if (currentPhaseName == "sellOxygen")',
      '        {',
      '        }',
      '        if (!ruleTriggered[2] && EntityAdvanced(OxygenTank, _snap_OxygenTankPos))',
      '        {',
      '            ruleTriggered[2] = true;',
      '        }',
      '    }',
      '    void OnAutoPlayArrive(string phaseName) { }',
      '    float phaseTimer;',
      '    void PlaceObj(GameObject obj, float x, float y, float z) {}',
      '}',
    ].join('\n'),
    extraFiles: {},
    blueprint: { entities: [] },
  };
  const before = methodCheck.detectPhaseGateViolations(ctx);
  assert.ok(before.some(v => v.rule === 'phase-entity-init-only'));
  const repair = methodCheck.autoRepairPhaseGateViolations(ctx, 2);
  assert.strictEqual(repair.changed, true);
  assert.deepStrictEqual(repair.violations, []);
  assert.match(ctx.csCode, /if \(currentPhaseName == "sellOxygen"\)[\s\S]*PlaceObj\(OxygenTank, 0f, 1f, 2f\);/);
}

{
  const ctx = {
    csCode: [
      'using UnityEngine;',
      'public partial class GameFlowManagerMain : MonoBehaviour',
      '{',
      '    int LaserTurretState = 0;',
      '    void Update()',
      '    {',
      '        CustomAIOnlyHelper();',
      '    }',
      '}',
    ].join('\n'),
    extraFiles: {
      'GameFlowManagerMain.UI.cs': [
        'using UnityEngine;',
        'public partial class GameFlowManagerMain : MonoBehaviour',
        '{',
        '    int LaserTurretState = 1;',
        '}',
      ].join('\n'),
    },
    blueprint: {
      entities: [
        { pool: '__Pool_Cube_Blue_01' },
      ],
      feedbackHistory: [],
    },
  };
  methodCheck.execute(ctx).catch(function() {});
  assert.ok(!ctx.extraFiles['GameFlowManagerMain.UI.cs'].includes('LaserTurretState = 1'));
}

{
  const ctx = {
    csCode: [
      'using UnityEngine;',
      'public class GameFlowManagerMain : MonoBehaviour',
      '{',
      '    void Update() { }',
      '}',
    ].join('\n'),
    extraFiles: {
      'GameFlowManagerMain.Flow.cs': [
        'using UnityEngine;',
        'public partial class GameFlowManagerMain : MonoBehaviour',
        '{',
        '    void Tick() { }',
        '}',
      ].join('\n'),
    },
  };
  const changed = methodCheck.autoRepairPartialClassMismatch(ctx);
  assert.strictEqual(changed, true);
  assert.match(ctx.csCode, /public partial class GameFlowManagerMain : MonoBehaviour/);
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
    extraFiles: {
      'GameFlowManagerMain.Flow.cs': [
        'using UnityEngine;',
        'public partial class GameFlowManagerMain',
        '{',
        '    GameObject EnemyAstronaut;',
        '    void Phase_enemyAttack_OnTap()',
        '    {',
        '        SpawnEnemyAstronaut(1);',
        '    }',
        '}',
      ].join('\n'),
    },
  };
  const missing = methodCheck.checkCompleteness(ctx.csCode, ctx.extraFiles);
  assert.deepStrictEqual(missing, ['SpawnEnemyAstronaut']);
}

console.log('method-check auto-repair tests passed');
