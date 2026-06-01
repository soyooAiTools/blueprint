#!/usr/bin/env node
/**
 * 2026-05-31: raw-resource-string-call activation-gate comment-mask fix.
 *
 * The rule `raw-resource-string-call` (engine/static-check.cjs) only activates when
 * `GFM_ResourceIds` appears in the file. Its activation gate previously read the RAW
 * (unmasked) code, so a `GFM_ResourceIds` mention living ONLY inside a comment — e.g.
 * the skeleton-generator's ASCII-ONLY warning banner that shows
 * `// ✗ AddResource("金币", 5) → ✓ AddResource(GFM_ResourceIds.Gold, 5)` — falsely
 * activated the rule and flagged genuine raw AddResource("X") calls in real code.
 * Same FP class as the non-ascii-resource-key buildCodeMask fix. The gate now reads a
 * comment-stripped copy.
 */

var assert = require('assert');
var { staticCheckProject } = require('../engine/static-check.cjs');

function rawHits(code, extras) {
  return staticCheckProject(code, { filename: 'GameFlowManagerMain.cs', extraFiles: extras || {} })
    .issues.filter(function(i) { return i.rule === 'raw-resource-string-call' && i.blocking; });
}

// Case A: GFM_ResourceIds mentioned ONLY in a comment + a raw call in real code.
// The comment must NOT activate the rule → no blocking (the false positive being fixed).
(function caseA_falsePositiveFixed() {
  var code = [
    'public partial class GameFlowManagerMain : MonoBehaviour {',
    '  void Update() {',
    '    // ✗ AddResource("金币", 5) → ✓ AddResource(GFM_ResourceIds.Gold, 5)',
    '    AddResource("coins", 5);',
    '  }',
    '}',
  ].join('\n');
  assert.strictEqual(rawHits(code).length, 0,
    'GFM_ResourceIds only in a comment must NOT activate raw-resource-string-call');
  console.log('  ✓ case A: comment-only GFM_ResourceIds does not activate the rule (FP fixed)');
})();

// Case A2: same, but the GFM_ResourceIds mention lives in a partial file's comment.
(function caseA2_extraFileCommentOnly() {
  var main = [
    'public partial class GameFlowManagerMain : MonoBehaviour {',
    '  void Update() { AddResource("coins", 5); }',
    '}',
  ].join('\n');
  var extras = {
    'GameFlowManagerMain.Resource.cs': [
      'public partial class GameFlowManagerMain {',
      '  // see GFM_ResourceIds.Normalize for the canonical form',
      '  void Helper() {}',
      '}',
    ].join('\n'),
  };
  assert.strictEqual(rawHits(main, extras).length, 0,
    'GFM_ResourceIds only in a partial-file comment must NOT activate the rule');
  console.log('  ✓ case A2: comment-only GFM_ResourceIds in a partial does not activate the rule');
})();

// Case B: GFM_ResourceIds used in REAL code + a raw call → must STILL fire (true positive).
(function caseB_truePositivePreserved() {
  var code = [
    'public partial class GameFlowManagerMain : MonoBehaviour {',
    '  void Update() {',
    '    AddResource(GFM_ResourceIds.Normalize("gold"), 1);',
    '    AddResource("coins", 5);',
    '  }',
    '}',
  ].join('\n');
  var hits = rawHits(code);
  assert.ok(hits.length >= 1, 'real GFM_ResourceIds usage + a raw call must still be flagged');
  assert.ok(/AddResource\("coins"/.test(hits[0].text), 'flags the raw call');
  console.log('  ✓ case B: real GFM_ResourceIds usage keeps the rule active (true positive preserved)');
})();

// Case C: real GFM_ResourceIds usage, no raw string calls → clean.
(function caseC_clean() {
  var code = [
    'public partial class GameFlowManagerMain : MonoBehaviour {',
    '  void Update() { AddResource(GFM_ResourceIds.Normalize("coins"), 5); }',
    '}',
  ].join('\n');
  assert.strictEqual(rawHits(code).length, 0, 'compliant resource calls produce no blocking');
  console.log('  ✓ case C: compliant GFM_ResourceIds calls are clean');
})();

console.log('\nstatic-check raw-resource-string-call comment-mask: 4 cases passed');
