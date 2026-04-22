const assert = require('assert');

const methodCheck = require('../engine/stages/method-check.cjs');

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

console.log('method-check auto-repair tests passed');
