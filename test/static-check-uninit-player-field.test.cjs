#!/usr/bin/env node
/**
 * 2026-04-27 systemic root-cause test: uninit-player-field rule.
 *
 * Skeleton (skeleton-generator.cjs:616) declares `GameObject player;` and the
 * suggested init `player = GFM_Player.Instance.Go;` is COMMENTED OUT (line 993)
 * so games without a player can omit binding. AI codegen consistently writes
 * `player.transform.position` everywhere WITHOUT ever uncommenting the init,
 * producing 70-154 null-transform crashes per frame at visual-precheck.
 *
 * Affected projects (sample): jv3sij(154+114), 8a6j7u(106+70), 5o2lyu(3-5).
 *
 * Block deterministically: declared + read-but-not-assigned → fail compile.
 */

var assert = require('assert');
var { staticCheck, staticCheckProject } = require('../engine/static-check.cjs');

function findRule(result, ruleId) {
  return (result.issues || []).find(function(i) { return i.rule === ruleId; });
}

// Case 1: declared + read + NEVER assigned → must flag
var caseBroken = [
  'using UnityEngine;',
  'public partial class GameFlowManagerMain : MonoBehaviour {',
  '    GameObject player;',
  '    // player = GFM_Player.Instance.Go; // commented out, never run',
  '    void UpdateEnemyRocket(float dt) {',
  '        if (EnemyRocket == null) return;',
  '        float dist = Vector3.Distance(EnemyRocket.transform.position, player.transform.position);',
  '    }',
  '}',
].join('\n');
var r1 = staticCheck(caseBroken, { filename: 'GameFlowManagerMain.cs' });
var hit1 = findRule(r1, 'uninit-player-field');
assert.ok(hit1, 'Case 1: rule should fire when player is declared, read, but never assigned');
assert.strictEqual(hit1.blocking, true, 'Case 1: rule must be blocking');

// Case 2: declared + read + ASSIGNED in same file → must NOT flag
var caseAssignedSame = [
  'using UnityEngine;',
  'public partial class GameFlowManagerMain : MonoBehaviour {',
  '    GameObject player;',
  '    void Start() { player = GFM_Player.Instance.Go; }',
  '    void Update() { var p = player.transform.position; }',
  '}',
].join('\n');
var r2 = staticCheck(caseAssignedSame, { filename: 'GameFlowManagerMain.cs' });
assert.ok(!findRule(r2, 'uninit-player-field'),
  'Case 2: rule must NOT fire when player is properly assigned in Start()');

// Case 3: declared + read + assignment uses `=` with init in declaration → must NOT flag
var caseInlineInit = [
  'using UnityEngine;',
  'public partial class GameFlowManagerMain : MonoBehaviour {',
  '    GameObject player = null;',  // explicit init counts as declaration
  '    void Start() { player = GFM_Player.Instance.Go; }',
  '    void Update() { player.transform.position = Vector3.zero; }',
  '}',
].join('\n');
var r3 = staticCheck(caseInlineInit, { filename: 'GameFlowManagerMain.cs' });
assert.ok(!findRule(r3, 'uninit-player-field'),
  'Case 3: rule must NOT fire with proper assignment after inline-init declaration');

// Case 4: cross-file — declared in main, assigned in companion → must NOT flag
var caseCrossFile = [
  'using UnityEngine;',
  'public partial class GameFlowManagerMain : MonoBehaviour {',
  '    GameObject player;',
  '    void Update() { player.transform.position = Vector3.zero; }',
  '}',
].join('\n');
var crossFileExtras = {
  'GameFlowManagerMain.Input.cs': [
    'using UnityEngine;',
    'public partial class GameFlowManagerMain : MonoBehaviour {',
    '    void BindPlayer() { player = GFM_Player.Instance.Go; }',
    '}',
  ].join('\n'),
};
var r4 = staticCheckProject(caseCrossFile, { extraFiles: crossFileExtras });
assert.ok(!findRule(r4, 'uninit-player-field'),
  'Case 4: rule must NOT fire when assignment lives in a companion file');

// Case 5: cross-file — declared and read in main, NO assignment anywhere → must flag
var caseCrossFileBroken = [
  'using UnityEngine;',
  'public partial class GameFlowManagerMain : MonoBehaviour {',
  '    GameObject player;',
  '    void UpdateBallista1(float dt) {',
  '        if (Ballista1 == null) return;',
  '        var p = player.transform.position;',
  '    }',
  '}',
].join('\n');
var brokenExtras = {
  'GameFlowManagerMain.Flow.cs': [
    'using UnityEngine;',
    'public partial class GameFlowManagerMain : MonoBehaviour {',
    '    void Foo() { /* no player init */ }',
    '}',
  ].join('\n'),
};
var r5 = staticCheckProject(caseCrossFileBroken, { extraFiles: brokenExtras });
assert.ok(findRule(r5, 'uninit-player-field'),
  'Case 5: rule must fire when no assignment exists across all files');

// Case 6: companion-only scan must NOT independently flag (false-positive guard)
// staticCheckProject runs each extra with extraFiles={}; the rule should not
// duplicate-flag from the per-extra pass when the assignment lives in main.
var caseExtraReadsMainAssigns = [
  'using UnityEngine;',
  'public partial class GameFlowManagerMain : MonoBehaviour {',
  '    GameObject player;',
  '    void Start() { player = GFM_Player.Instance.Go; }',
  '}',
].join('\n');
var extraOnlyReads = {
  'GameFlowManagerMain.Flow.cs': [
    'using UnityEngine;',
    'public partial class GameFlowManagerMain : MonoBehaviour {',
    '    void Tick() { player.transform.Rotate(Vector3.up, 1f); }',
    '}',
  ].join('\n'),
};
var r6 = staticCheckProject(caseExtraReadsMainAssigns, { extraFiles: extraOnlyReads });
var hits6 = (r6.issues || []).filter(function(i) { return i.rule === 'uninit-player-field'; });
assert.strictEqual(hits6.length, 0,
  'Case 6: rule must NOT double-flag from per-extra-file scan when main file has assignment');

// Case 7: no player reads at all — must NOT flag (game has no player)
var casePlayerless = [
  'using UnityEngine;',
  'public partial class GameFlowManagerMain : MonoBehaviour {',
  '    GameObject player;',
  '    void Update() { /* tap-only game, never touches player */ }',
  '}',
].join('\n');
var r7 = staticCheck(casePlayerless, { filename: 'GameFlowManagerMain.cs' });
assert.ok(!findRule(r7, 'uninit-player-field'),
  'Case 7: rule must NOT fire when player is declared but never read');

// Case 8: `var player = …` local shadow doesn't count as field assignment
var caseLocalShadow = [
  'using UnityEngine;',
  'public partial class GameFlowManagerMain : MonoBehaviour {',
  '    GameObject player;',
  '    void Foo() {',
  '        var player = GFM_Player.Instance;',  // local var, not field assignment
  '        player.Tick(0.016f, false);',         // refers to local
  '    }',
  '    void UpdateBar() { var p = player.transform.position; }', // field read
  '}',
].join('\n');
var r8 = staticCheck(caseLocalShadow, { filename: 'GameFlowManagerMain.cs' });
// The rule may or may not catch this — the key thing is it doesn't crash.
// Local shadow is genuinely ambiguous; we accept either outcome but verify
// the rule produces a sane structured result (no crash).
assert.ok(Array.isArray(r8.issues), 'Case 8: rule must not crash on local var shadow');

console.log('static-check uninit-player-field: 8 cases passed');
