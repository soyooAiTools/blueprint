const assert = require('assert');

const methodCheck = require('../engine/stages/method-check.cjs');

const code = [
  'using UnityEngine;',
  'public partial class GameFlowManagerMain : MonoBehaviour',
  '{',
  '    Vector3 _snap_goldObjPos;',
  '    GameObject goldObj;',
  '    bool[] ruleTriggered = new bool[2];',
  '    string currentPhaseName = "";',
  '    bool EntityAdvanced(GameObject obj, Vector3 snap) { return false; }',
  '    void Snapshot_buildForge_GateEntities()',
  '    {',
  '        _snap_goldObjPos = goldObj.transform.position;',
  '    }',
  '    void Phase_buildForge_Init()',
  '    {',
  '        PlaceObj(goldObj, 1f, 2f, 3f);',
  '    }',
  '    void CheckEventRules()',
  '    {',
  '        if (!ruleTriggered[1] && EntityAdvanced(goldObj, _snap_goldObjPos))',
  '        {',
  '            currentPhaseName = "buildForge";',
  '        }',
  '    }',
  '    // TODO_PHASE_buildForge_ONTAP_START',
  '    // TODO_PHASE_buildForge_ONTAP_END',
  '    // TODO_PHASE_buildForge_ONAUTOARRIVE_START',
  '    // TODO_PHASE_buildForge_ONAUTOARRIVE_END',
  '    void OnAutoPlayArrive(string phaseName) { }',
  '    void Update() { CheckEventRules(); }',
  '    void PlaceObj(GameObject obj, float x, float y, float z) {}',
  '}',
].join('\n');

{
  const ctx = {
    csCode: code,
    extraFiles: {},
    blueprint: { entities: [] },
  };
  const repair = methodCheck.applyPhaseGatePreRepair(ctx);
  assert.strictEqual(repair.changed, true);
  assert.ok(repair.fixes.some(x => /PhaseGateRuntimeMove/.test(x)));
  assert.match(ctx.csCode, /TODO_PHASE_buildForge_ONTAP_START[\s\S]*PlaceObj\(goldObj, 1f, 2f, 3f\);[\s\S]*TODO_PHASE_buildForge_ONTAP_END/);
}

{
  const splitMain = [
    'using UnityEngine;',
    'public partial class GameFlowManagerMain : MonoBehaviour',
    '{',
    '    bool _autoPlayMode = false;',
    '    Vector3 _snap_goldObjPos;',
    '    GameObject goldObj;',
    '    bool[] ruleTriggered = new bool[2];',
    '    string currentPhaseName = "";',
    '    bool EntityAdvanced(GameObject obj, Vector3 snap) { return false; }',
    '    void EnterPhase(int ruleIdx, string phaseId, bool resetTimer, bool syncAutoPlayBaseline) { currentPhaseName = phaseId; }',
    '    void CheckEventRules()',
    '    {',
    '        if (!ruleTriggered[1] && EntityAdvanced(goldObj, _snap_goldObjPos))',
    '        {',
    '            EnterPhase(1, "buildForge", true, true);',
    '            Phase_buildForge_Init();',
    '        }',
    '    }',
    '    void Update()',
    '    {',
    '        if (!_autoPlayMode && Input.GetMouseButtonDown(0))',
    '        {',
    '            Phase_OnTap(); // dispatch to Phase_<id>_OnTap() in GameFlowManagerMain.Flow.cs',
    '        }',
    '        // TODO_UPDATE_START',
    '        // TODO_UPDATE_END',
    '    }',
    '}',
  ].join('\n');

  const splitFlow = [
    'using UnityEngine;',
    'public partial class GameFlowManagerMain',
    '{',
    '    void Phase_OnTap()',
    '    {',
    '        switch (currentPhaseName)',
    '        {',
    '            case "buildForge": Phase_buildForge_OnTap(); break;',
    '        }',
    '    }',
    '    void OnAutoPlayArrive(string targetName)',
    '    {',
    '        switch (currentPhaseName)',
    '        {',
    '            case "buildForge": Phase_buildForge_OnAutoPlayArrive(targetName); break;',
    '        }',
    '    }',
    '    void Phase_buildForge_Init()',
    '    {',
    '        // TODO_PHASE_1_INIT_START',
    '        PlaceObj(goldObj, 1f, 2f, 3f);',
    '        // TODO_PHASE_1_INIT_END',
    '    }',
    '    void Phase_buildForge_OnTap()',
    '    {',
    '        // TODO_PHASE_buildForge_ONTAP_START',
    '        // TODO_PHASE_buildForge_ONTAP_END',
    '    }',
    '    void Phase_buildForge_OnAutoPlayArrive(string targetName)',
    '    {',
    '        // TODO_PHASE_buildForge_ONAUTOARRIVE_START',
    '        // TODO_PHASE_buildForge_ONAUTOARRIVE_END',
    '    }',
    '    void PlaceObj(GameObject obj, float x, float y, float z) {}',
    '}',
  ].join('\n');

  const ctx = {
    csCode: splitMain,
    extraFiles: {
      'GameFlowManagerMain.Flow.cs': splitFlow,
    },
    blueprint: { entities: [] },
  };
  const repair = methodCheck.applyPhaseGatePreRepair(ctx);
  assert.strictEqual(repair.changed, true);
  assert.ok(repair.fixes.some(x => /partials:PhaseGateRuntimeMove/.test(x)));
  assert.match(ctx.csCode, /Phase_OnTap\(\);[\s\S]*if \(currentPhaseName == "buildForge"\)[\s\S]*PlaceObj\(goldObj, 1f, 2f, 3f\);/);
  assert.match(ctx.extraFiles['GameFlowManagerMain.Flow.cs'], /TODO_PHASE_buildForge_ONTAP_START[\s\S]*PlaceObj\(goldObj, 1f, 2f, 3f\);[\s\S]*TODO_PHASE_buildForge_ONTAP_END/);
  assert.match(ctx.extraFiles['GameFlowManagerMain.Flow.cs'], /TODO_PHASE_buildForge_ONAUTOARRIVE_START[\s\S]*PlaceObj\(goldObj, 1f, 2f, 3f\);[\s\S]*TODO_PHASE_buildForge_ONAUTOARRIVE_END/);
}

console.log('method-check phase-gate tests passed');
