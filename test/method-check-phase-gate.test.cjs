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

console.log('method-check phase-gate tests passed');
