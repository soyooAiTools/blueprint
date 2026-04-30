const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const reviewStage = require('../engine/stages/review.cjs');
const { staticCheckProject } = require('../engine/static-check.cjs');

const reviewFile = '/opt/blueprint-editor/engine/stages/review.cjs';
const source = fs.readFileSync(reviewFile, 'utf8');

function extractFunction(name) {
  const sig = 'function ' + name + '(';
  const start = source.indexOf(sig);
  if (start < 0) throw new Error('Missing function ' + name);
  let i = source.indexOf('{', start) + 1;
  let depth = 1;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  return source.slice(start, i);
}

const sandbox = { process: { env: {} } };
vm.createContext(sandbox);
vm.runInContext([
  extractFunction('rewriteHotPathVectorAllocations'),
  extractFunction('normalizeSetScaleCalls'),
  extractFunction('stripInteractionFlagShortcutsFromPhaseGates'),
  extractFunction('shouldUsePatchRecode'),
].join('\n'), sandbox);

{
  const result = sandbox.rewriteHotPathVectorAllocations(
    'void Update(){ foo.transform.position += new Vector3(1f, 0, -2f); ' +
    'Vector3 p = bar.transform.position + new Vector3(0, 3f, 0); ' +
    'p = target.transform.position + new Vector3(-1.2f, 0f, 0f); ' +
    'baz.transform.position = new Vector3(baz.transform.position.x + 1f, baz.transform.position.y, baz.transform.position.z - 4f); }'
  );
  assert.strictEqual(result.changed, true);
  assert.match(result.code, /foo\.transform\.position = __hpPos1;/);
  assert.match(result.code, /Vector3 p = bar\.transform\.position; p\.y \+= 3f;/);
  assert.match(result.code, /p = target\.transform\.position; p\.x \+= -1\.2f;/);
  assert.match(result.code, /baz\.transform\.position = __hpPos\d+;/);
  assert.doesNotMatch(result.code, /foo\.transform\.position \+= new Vector3/);
  assert.doesNotMatch(result.code, /p = target\.transform\.position \+ new Vector3/);
  assert.doesNotMatch(result.code, /var p = target\.transform\.position/);
  assert.doesNotMatch(result.code, /\bp = p;/);
}

{
  const source = [
    'void Update()',
    '{',
    '    if (!_autoPlayMode && Input.GetMouseButtonDown(0))',
    '    {',
    '        Phase_OnTap();',
    '',
    '        switch (currentPhaseName)',
    '        {',
    '            case "upgradeOurBase":',
    '            {',
    '                PlaceObj(OurBase, -5f, 0.5f, 0f);',
    '                PlaceObj(Gold, -3f, 0.5f, -1f);',
    '                break;',
    '            }',
    '        }',
    '',
    '        switch (currentPhaseName) {',
    '            case "buildDefenseTower": {',
    '                HideObj(Gold);',
    '                break;',
    '            }',
    '        }',
    '    }',
    '    UpdateSystems();',
    '}',
  ].join('\n');
  const result = reviewStage.removePostTapPhaseResetBlocks(source);
  assert.strictEqual(result.changed, true);
  assert.strictEqual(result.fixes, 2);
  assert.match(result.code, /Phase_OnTap\(\);/);
  assert.match(result.code, /UpdateSystems\(\);/);
  assert.doesNotMatch(result.code, /switch \(currentPhaseName\)/);
  assert.doesNotMatch(result.code, /PlaceObj\(OurBase/);
  assert.doesNotMatch(result.code, /HideObj\(Gold/);
}

{
  const source = [
    'void Update()',
    '{',
    '    Phase_OnTap();',
    '    switch (currentPhaseName)',
    '    {',
    '        case "custom":',
    '            RunCustomSystem();',
    '            break;',
    '    }',
    '}',
  ].join('\n');
  const result = reviewStage.removePostTapPhaseResetBlocks(source);
  assert.strictEqual(result.changed, false);
  assert.match(result.code, /RunCustomSystem/);
}

{
  const result = sandbox.normalizeSetScaleCalls(
    'void Apply(){ SetScale(Player, scale, scale, scale); SetScale(Crate, 1f, 2f, 3f, 1f); }'
  );
  assert.strictEqual(result.changed, true);
  assert.match(result.code, /SetScale\(Player, scale\);/);
  assert.match(result.code, /SetScale\(Crate, 1f, 2f, 3f\);/);
  assert.doesNotMatch(result.code, /SetScale\(Player, scale, scale, scale\)/);
  assert.doesNotMatch(result.code, /SetScale\(Crate, 1f, 2f, 3f, 1f\)/);
}

{
  const source = [
    'using UnityEngine;',
    'public partial class GameFlowManagerMain',
    '{',
    '    void RepositionReward()',
    '    {',
    '        if (SalesPoint != null && SalesPoint.transform.position.y > -900f)',
    '        {',
    '            PlaceObj(goldObj, 1f, 1f, 1f);',
    '        }',
    '        else if (UpgradeStation != null && UpgradeStation.transform.position.y > -900f)',
    '        {',
    '            PlaceObj(goldObj, 2f, 1f, 1f);',
    '        }',
    '    }',
    '}',
  ].join('\n');
  const result = reviewStage.addMissingComplexBranchComments(source);
  assert.strictEqual(result.changed, true);
  assert.strictEqual(result.fixes, 2);
  assert.match(result.code, /Branch gate: documents the generated multi-part condition before review\.\n        if \(SalesPoint != null/);
  assert.match(result.code, /Branch gate: documents the generated multi-part condition before review\.\n        else if \(UpgradeStation != null/);
}

{
  const source = [
    'using UnityEngine;',
    'public partial class GameFlowManagerMain',
    '{',
    '    int _currentFormIndex = 0;',
    '}',
  ].join('\n');
  const result = reviewStage.addMissingSkeletonMemberComments(source);
  assert.strictEqual(result.changed, true);
  assert.match(result.code, /\/\/ 玩家形态：记录可切换形态配置和当前形态索引。\n    int _currentFormIndex = 0;/);
}

{
  const source = [
    'using UnityEngine;',
    'public partial class GameFlowManagerMain',
    '{',
    '    GameObject WaterResource;',
    '    bool WaterResourceDone = false;',
    '    void Update()',
    '    {',
    '    }',
    '}',
  ].join('\n');
  const result = reviewStage.addMissingSkeletonMemberComments(source);
  assert.strictEqual(result.changed, true);
  const checked = staticCheckProject(result.code, { extraFiles: {} });
  assert.ok(!checked.issues.some(i => i.rule === 'require-member-doc'), 'member docs should satisfy static check');
}

{
  const result = reviewStage.declareMissingInteractionFlags([
    'using UnityEngine;',
    'public partial class GameFlowManagerMain',
    '{',
    '    void Update()',
    '    {',
    '        WaterResourceDone = true;',
    '        if (GoldUIDone) { }',
    '    }',
    '}',
  ].join('\n'), {});
  assert.strictEqual(result.changed, true);
  assert.match(result.code, /bool GoldUIDone = false; \/\/ 交互标记/);
  assert.match(result.code, /bool WaterResourceDone = false; \/\/ 交互标记/);
}

{
  const main = [
    'using UnityEngine;',
    'public partial class GameFlowManagerMain',
    '{',
    '    void Start()',
    '    {',
    '        mainCam = Camera.main;',
    '    }',
    '}',
  ].join('\n');
  const extras = {
    'GameFlowManagerMain.Input.cs': [
      'using UnityEngine;',
      'public partial class GameFlowManagerMain',
      '{',
      '    GameObject player;',
      '    void MovePlayer() { player.transform.position = Vector3.zero; }',
      '}',
    ].join('\n'),
  };
  const result = reviewStage.repairKnownStructuralDamage(main, extras, {});
  assert.strictEqual(result.changed, true);
  assert.match(result.code, /player = GFM_Player\.Instance\.Go;/);
  const staticResult = staticCheckProject(result.code, {
    filename: 'GameFlowManagerMain.cs',
    extraFiles: result.extraFiles,
  });
  assert.ok(!staticResult.issues.some(function(issue) { return issue.rule === 'uninit-player-field'; }));
}

{
  const main = [
    'using UnityEngine;',
    'public partial class GameFlowManagerMain',
    '{',
    '    GameObject player;',
    '    void Start() { player = GFM_Player.Instance.Go; }',
    '}',
  ].join('\n');
  const extras = {
    'GameFlowManagerMain.Flow.cs': [
      'using UnityEngine;',
      'public partial class GameFlowManagerMain',
      '{',
      '    void Move() { Player.transform.position = Vector3.zero; Player.name = "p"; }',
      '}',
    ].join('\n'),
  };
  const before = staticCheckProject(main + '\n' + extras['GameFlowManagerMain.Flow.cs'], { filename: 'GameFlowManagerMain.cs' });
  assert.ok(before.issues.some(function(issue) { return issue.rule === 'player-alias-drift'; }));
  const result = reviewStage.repairKnownStructuralDamage(main, extras, {});
  assert.strictEqual(result.changed, true);
  assert.match(result.extraFiles['GameFlowManagerMain.Flow.cs'], /player\.transform\.position/);
  assert.doesNotMatch(result.extraFiles['GameFlowManagerMain.Flow.cs'], /\bPlayer\s*\./);
  const after = staticCheckProject(result.code + '\n' + result.extraFiles['GameFlowManagerMain.Flow.cs'], { filename: 'GameFlowManagerMain.cs' });
  assert.ok(!after.issues.some(function(issue) { return issue.rule === 'player-alias-drift'; }));
}

{
  const result = sandbox.stripInteractionFlagShortcutsFromPhaseGates(
    'if (!ruleTriggered[2] && (EntityAdvanced(Box, _snap_BoxPos) || boxDone || harvestPlayerActed) && phaseTimer > 3f) {}',
    { specs: [{ phaseId: 'a' }, { phaseId: 'b' }, { phaseId: 'c' }, { phaseId: 'd' }] }
  );
  assert.strictEqual(result.changed, true);
  assert.match(result.code, /\(EntityAdvanced\(Box, _snap_BoxPos\)\)/);
  assert.doesNotMatch(result.code, /boxDone|harvestPlayerActed/);
}

{
  assert.strictEqual(sandbox.shouldUsePatchRecode({
    source: 'static-precheck',
    issues: [{ line: 10, rule: 'phase-entity-init-only' }],
  }), false);
  assert.strictEqual(sandbox.shouldUsePatchRecode({
    source: 'codex-review',
    issues: [{ line: 10, rule: 'custom-warning' }],
  }), true);
}

{
  const result = reviewStage.rewriteLongIfChainsAsSwitches([
    'void Update()',
    '{',
    '    if (currentPhaseName == "intro")',
    '    {',
    '        EnterIntro();',
    '    }',
    '    else if (currentPhaseName == "collect")',
    '    {',
    '        RunCollect();',
    '    }',
    '    else if (currentPhaseName == "sell")',
    '    {',
    '        RunSell();',
    '    }',
    '    else if (currentPhaseName == "finish")',
    '    {',
    '        FinishGame();',
    '    }',
    '}',
  ].join('\n'));
  assert.strictEqual(result.changed, true);
  assert.match(result.code, /switch \(currentPhaseName\)/);
  assert.match(result.code, /case "intro":/);
  assert.match(result.code, /case "finish":/);
  assert.doesNotMatch(result.code, /else if \(currentPhaseName ==/);
}

{
  const result = reviewStage.rewriteLongIfChainsAsSwitches([
    'void HandleTap()',
    '{',
    '    if (currentPhaseName == "intro")',
    '    {',
    '        EnterIntro();',
    '    }',
    '',
    '    if (currentPhaseName == "collect")',
    '    {',
    '        RunCollect();',
    '    }',
    '',
    '    if (currentPhaseName == "sell")',
    '    {',
    '        RunSell();',
    '    }',
    '',
    '    if (currentPhaseName == "finish")',
    '    {',
    '        FinishGame();',
    '    }',
    '}',
  ].join('\n'));
  assert.strictEqual(result.changed, true);
  assert.match(result.code, /switch \(currentPhaseName\)/);
  assert.match(result.code, /case "collect":/);
  assert.doesNotMatch(result.code, /if \(currentPhaseName == "sell"\)/);
}

{
  process.env.OPENAI_API_KEY = '';
  assert.strictEqual(reviewStage.shouldFallbackToLegacyReviewer({
    passed: false,
    parseError: true,
    error: 'Codex reviewer timed out before producing JSON output',
  }, true, true, true), false);

  process.env.OPENAI_API_KEY = 'sk-test';
  assert.strictEqual(reviewStage.shouldFallbackToLegacyReviewer({
    passed: false,
    parseError: true,
    error: 'Codex reviewer timed out before producing JSON output',
  }, true, true, true), true);

  assert.strictEqual(reviewStage.shouldFallbackToLegacyReviewer({
    passed: false,
    parseError: true,
    error: 'MODEL_FATAL: quota exceeded',
  }, true, true, true), false);

  assert.strictEqual(reviewStage.shouldUseDeterministicReviewFallback({
    passed: false,
    parseError: true,
    error: 'Codex reviewer timed out before producing JSON output',
    source: 'codex-reviewer',
  }, true, true, true), true);

  assert.strictEqual(reviewStage.shouldUseDeterministicReviewFallback({
    message: 'GPT Review parse error: ',
  }, true, true, true), true);

  assert.strictEqual(reviewStage.shouldUseDeterministicReviewFallback({
    message: 'getaddrinfo ENOTFOUND sub.mindrix.app',
  }, true, true, true), true);

  assert.strictEqual(reviewStage.shouldUseDeterministicReviewFallback({
    message: 'connect ECONNREFUSED 127.0.0.1:443',
  }, true, true, true), true);

  assert.strictEqual(reviewStage.shouldUseDeterministicReviewFallback({
    message: 'MODEL_FATAL: quota exceeded',
  }, true, true, true), false);

  delete process.env.OPENAI_API_KEY;
}

{
  const mainCode = [
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

  const flowCode = [
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
    '        PlaceObj(goldObj, 1f, 2f, 3f);',
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
    '}',
  ].join('\n');

  const result = reviewStage.repairPhaseGateRuntimeMovesAcrossPartials(mainCode, {
    'GameFlowManagerMain.Flow.cs': flowCode,
  });
  assert.strictEqual(result.changed, true);
  assert.match(result.code, /Phase_OnTap\(\);[\s\S]*if \(currentPhaseName == "buildForge"\)[\s\S]*PlaceObj\(goldObj, 1f, 2f, 3f\);/);
  assert.match(result.extraFiles['GameFlowManagerMain.Flow.cs'], /TODO_PHASE_buildForge_ONTAP_START[\s\S]*PlaceObj\(goldObj, 1f, 2f, 3f\);[\s\S]*TODO_PHASE_buildForge_ONTAP_END/);
  assert.match(result.extraFiles['GameFlowManagerMain.Flow.cs'], /TODO_PHASE_buildForge_ONAUTOARRIVE_START[\s\S]*PlaceObj\(goldObj, 1f, 2f, 3f\);[\s\S]*TODO_PHASE_buildForge_ONAUTOARRIVE_END/);
}

{
  const mainCode = [
    'using UnityEngine;',
    'public partial class GameFlowManagerMain',
    '{',
    '    string currentPhaseName;',
    '    bool[] ruleTriggered;',
    '    Vector3 _snap_GoldPos;',
    '    GameObject Gold;',
    '    void Update()',
    '    {',
    '        Phase_OnTap();',
    '    }',
    '    void CheckEventRules()',
    '    {',
    '        if (!ruleTriggered[1]',
    '            && currentPhaseName == "recycleDebrisGetGold"',
    '            && EntityAdvanced(Gold, _snap_GoldPos))',
    '        {',
    '            EnterPhase(1, "buildDefenseTower", true, true);',
    '        }',
    '    }',
    '    bool EntityAdvanced(GameObject go, Vector3 snapPos) { return true; }',
    '    void EnterPhase(int i, string p, bool r, bool s) {}',
    '}',
  ].join('\n');

  const flowCode = [
    'using UnityEngine;',
    'public partial class GameFlowManagerMain',
    '{',
    '    void Phase_OnTap() {}',
    '    void Phase_recycleDebrisGetGold_Init()',
    '    {',
    '        PlaceObj(Gold, -3.8f, 0.5f, -1.2f);',
    '    }',
    '    void Phase_recycleDebrisGetGold_OnTap()',
    '    {',
    '        // TODO_PHASE_recycleDebrisGetGold_ONTAP_START',
    '        PlaceObj(Gold, -3.7f, 0.5f, -1.1f);',
    '        // TODO_PHASE_recycleDebrisGetGold_ONTAP_END',
    '    }',
    '    void Phase_recycleDebrisGetGold_OnAutoPlayArrive(string targetName)',
    '    {',
    '        // TODO_PHASE_recycleDebrisGetGold_ONAUTOARRIVE_START',
    '        PlaceObj(Gold, -3.7f, 0.5f, -1.1f);',
    '        // TODO_PHASE_recycleDebrisGetGold_ONAUTOARRIVE_END',
    '    }',
    '}',
  ].join('\n');

  const result = reviewStage.repairPhaseGateRuntimeMovesAcrossPartials(mainCode, {
    'GameFlowManagerMain.Flow.cs': flowCode,
  });
  assert.strictEqual(result.changed, true);
  assert.match(result.extraFiles['GameFlowManagerMain.Flow.cs'], /__gateMovePos_recycleDebrisGetGold_Gold = Gold\.transform\.position/);
  assert.match(result.extraFiles['GameFlowManagerMain.Flow.cs'], /__gateMovePos_recycleDebrisGetGold_Gold\.y \+= 2f/);
}

{
  const broken = [
    'using UnityEngine;',
    'public partial class GameFlowManagerMain',
    '{',
    '    void Phase_build_OnTap()',
    '    {',
    '        if (Gold != null)',
    '            var __gateMovePos4 = Gold.transform.position;',
    '            __gateMovePos4.y += 2f;',
    '            Gold.transform.position = __gateMovePos4;',
    '    }',
    '}',
  ].join('\n');
  const normalized = reviewStage.normalizePhaseGateConditionalDeclarations(broken);
  assert.strictEqual(normalized.changed, true);
  assert.match(normalized.code, /if \(Gold != null\)\s*\{\s*var __gateMovePos4 = Gold\.transform\.position;[\s\S]*Gold\.transform\.position = __gateMovePos4;\s*\}/);
}

{
  const broken = [
    'using UnityEngine;',
    'public partial class GameFlowManagerMain',
    '{',
    '    void Phase_recycleDebrisGetGold_OnTap()',
    '    {',
    '        if (Gold != null)',
    '            var __gateMovePos_recycleDebrisGetGold_Gold = Gold.transform.position;',
    '            __gateMovePos_recycleDebrisGetGold_Gold.y += 2f;',
    '            Gold.transform.position = __gateMovePos_recycleDebrisGetGold_Gold;',
    '    }',
    '}',
  ].join('\n');
  const normalized = reviewStage.normalizePhaseGateConditionalDeclarations(broken);
  assert.strictEqual(normalized.changed, true);
  assert.match(normalized.code, /if \(Gold != null\)\s*\{\s*var __gateMovePos_recycleDebrisGetGold_Gold = Gold\.transform\.position;[\s\S]*Gold\.transform\.position = __gateMovePos_recycleDebrisGetGold_Gold;\s*\}/);
}

{
  const code = [
    'public partial class GameFlowManagerMain',
    '{',
    '    const int RULE_COUNT = 13;',
    '    void CheckEventRules()',
    '    {',
    '        if (!ruleTriggered[11]',
    '            && currentPhaseName == "phase11")',
    '        {',
    '            EnterPhase(11, "gameEnd", false, false);',
    '            CompletePhaseProgress("gameStart");',
    '            ReportPhase("gameEnd");',
    '            FinishGame("phase11");',
    '        }',
    '    }',
    '}',
  ].join('\n');
  const result = reviewStage.normalizeRuntimePhaseContract(code, {
    specs: Array.from({ length: 11 }, (_, i) => ({ phaseId: 'phase' + (i + 1) })),
  });
  assert.strictEqual(result.changed, true);
  assert.match(result.code, /const int RULE_COUNT = 11;/);
  assert.match(result.code, /if \(!gameEnded\s+&& currentPhaseName == "phase11"\)/);
  assert.match(result.code, /currentPhaseName = "gameEnd";/);
  assert.match(result.code, /cameraFocusTarget = "gameEnd";/);
  assert.doesNotMatch(result.code, /CompletePhaseProgress\("gameStart"\)/);
  assert.doesNotMatch(result.code, /ReportPhase\("gameEnd"\)/);
  assert.doesNotMatch(result.code, /EnterPhase\(11, "gameEnd"/);
}

{
  const code = [
    'public partial class GameFlowManagerMain',
    '{',
    '    void Update()',
    '    {',
    '        UpdateGameState();',
    '    }',
    '    void AssemblyRunFlowSlots() {}',
    '    void AssemblyRunInputSlots() {}',
    '    void AssemblyRunResourceSlots() {}',
    '    void AssemblyRunUISlots() {}',
    '    void AssemblyRunSceneSlots() {}',
    '}',
  ].join('\n');
  const result = reviewStage.ensureAssemblySlotRunnerCalls(code);
  assert.strictEqual(result.changed, true);
  assert.match(result.code, /AssemblyRunFlowSlots\(\);\n\s*AssemblyRunInputSlots\(\);\n\s*AssemblyRunResourceSlots\(\);\n\s*AssemblyRunUISlots\(\);\n\s*AssemblyRunSceneSlots\(\);\n\s*UpdateGameState\(\);/);
}

{
  const main = [
    'public partial class GameFlowManagerMain',
    '{',
    '    void Update()',
    '    {',
    '        UpdateInput();',
    '        UpdateGameState();',
    '    }',
    '}',
  ].join('\n');
  const extras = {
    'GameFlowManagerMain.Flow.cs': [
      'public partial class GameFlowManagerMain',
      '{',
      '    void AssemblyRunFlowSlots() {}',
      '}',
    ].join('\n'),
    'GameFlowManagerMain.Resource.cs': [
      'public partial class GameFlowManagerMain',
      '{',
      '    void AssemblyRunResourceSlots() {}',
      '}',
    ].join('\n'),
  };
  const result = reviewStage.ensureAssemblySlotRunnerCallsAcrossPartials(main, extras);
  assert.strictEqual(result.changed, true);
  assert.match(result.code, /UpdateInput\(\);\n\s*AssemblyRunFlowSlots\(\);\n\s*AssemblyRunResourceSlots\(\);\n\s*UpdateGameState\(\);/);
}

console.log('review deterministic repair tests passed');
