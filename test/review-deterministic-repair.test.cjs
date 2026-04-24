const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const reviewStage = require('../engine/stages/review.cjs');

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

console.log('review deterministic repair tests passed');
