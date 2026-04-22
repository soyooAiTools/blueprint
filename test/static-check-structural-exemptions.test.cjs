const assert = require('assert');

const { staticCheck } = require('../engine/static-check.cjs');

{
  const code = [
    'using UnityEngine;',
    'public partial class GameFlowManagerMain : MonoBehaviour',
    '{',
    '    string currentPhaseName;',
    '    void Phase_intro_OnTap() { }',
    '    void Phase_collect_OnTap() { }',
    '    void Phase_finish_OnTap() { }',
    '    void Phase_OnTap()',
    '    {',
    '        switch (currentPhaseName)',
    '        {',
    '            case "intro": Phase_intro_OnTap(); break;',
    '            case "collect": Phase_collect_OnTap(); break;',
    '            case "finish": Phase_finish_OnTap(); break;',
    '        }',
    '    }',
    '}',
  ].join('\n');
  const issues = staticCheck(code, { filename: 'GameFlowManagerMain.Flow.cs' }).issues;
  assert.ok(!issues.some(i => i.rule === 'thin-input-coordinator'));
}

{
  const code = [
    'using UnityEngine;',
    'public partial class GameFlowManagerMain : MonoBehaviour',
    '{',
    '    string currentPhaseName;',
    '    string[] completedPhases;',
    '    int completedPhaseCount;',
    '    int[] phaseEnterTimes;',
    '    float gameTimer;',
    '    bool _autoPlayMode;',
    '    int _autoPlaySteps;',
    '    int _autoPlayStepsAtPhaseStart;',
    '    int ForgeState;',
    '    GameObject gameObject;',
    '    void UpdateGameState()',
    '    {',
    '        string completedJson = "[]";',
    '        string json = "{"',
    '            + "\\"currentPhase\\":\\"" + currentPhaseName + "\\","',
    '            + "\\"completedPhases\\":" + completedJson + ","',
    '            + "\\"entityStates\\":{"',
    '            + "\\"Forge\\":\\"" + ForgeState + "\\""',
    '            + "},"',
    '            + "\\"variables\\":{"',
    '            + "\\"gameTimer\\":" + (int)gameTimer',
    '            + ",\\"autoPlayMode\\":" + (_autoPlayMode ? "true" : "false")',
    '            + ",\\"autoPlaySteps\\":" + _autoPlaySteps',
    '            + ",\\"autoPlayStepsThisPhase\\":" + (_autoPlaySteps - _autoPlayStepsAtPhaseStart)',
    '            + "}"',
    '            + ",\\"phaseTimestamps\\":{"',
    '            + "\\"intro\\":" + (phaseEnterTimes[0] > 0 ? phaseEnterTimes[0] : 0)',
    '            + "}"',
    '            + "}";',
    '        gameObject.name = "GFM|" + json;',
    '    }',
    '}',
  ].join('\n');
  const issues = staticCheck(code, { filename: 'GameFlowManagerMain.UI.cs' }).issues;
  assert.ok(!issues.some(i => i.rule === 'method-too-long'));
}

{
  const code = [
    'using UnityEngine;',
    'public partial class GameFlowManagerMain : MonoBehaviour',
    '{',
    '    string currentPhaseName;',
    '    float phaseTimer;',
    '    bool _autoPlayMode;',
    '    bool[] ruleTriggered = new bool[12];',
    '    bool TryReportStuckPhase()',
    '    {',
    '        switch (currentPhaseName)',
    '        {',
    '            case "a": if (!ruleTriggered[1]) { Debug.Log("__PHASE_STUCK__:a"); phaseTimer = 60f; return true; } break;',
    '            case "b": if (!ruleTriggered[2]) { Debug.Log("__PHASE_STUCK__:b"); phaseTimer = 60f; return true; } break;',
    '            case "c": if (!ruleTriggered[3]) { Debug.Log("__PHASE_STUCK__:c"); phaseTimer = 60f; return true; } break;',
    '            case "d": if (!ruleTriggered[4]) { Debug.Log("__PHASE_STUCK__:d"); phaseTimer = 60f; return true; } break;',
    '            case "e": if (!ruleTriggered[5]) { Debug.Log("__PHASE_STUCK__:e"); phaseTimer = 60f; return true; } break;',
    '        }',
    '        return false;',
    '    }',
    '}',
  ].join('\n');
  const issues = staticCheck(code, { filename: 'GameFlowManagerMain.Flow.cs' }).issues;
  assert.ok(!issues.some(i => i.rule === 'method-too-long'));
}

{
  const code = [
    'using UnityEngine;',
    'public partial class GameFlowManagerMain : MonoBehaviour',
    '{',
    '    string currentPhaseName;',
    '    void HandleInput()',
    '    {',
    '        if (currentPhaseName == "intro") { EnterIntro(); }',
    '        if (currentPhaseName == "collect") { EnterCollect(); }',
    '        if (currentPhaseName == "sell") { EnterSell(); }',
    '        if (currentPhaseName == "finish") { FinishGame(); }',
    '        if (currentPhaseName == "bonus") { EnterBonus(); }',
    '    }',
    '}',
  ].join('\n');
  const issues = staticCheck(code, { filename: 'GameFlowManagerMain.Flow.cs' }).issues;
  assert.ok(issues.some(i => i.rule === 'thin-input-coordinator'));
}

console.log('static-check structural exemption tests passed');
