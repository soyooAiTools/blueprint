#!/usr/bin/env node
/**
 * 2026-05-31 Wave 2 #3 — static-pre-review stage.
 *
 * Early deterministic static-check gate (method-check → static-pre-review → review),
 * flag-gated default-off via STATIC_PRE_REVIEW_ENABLED. Verifies: (1) inert no-op
 * when the flag is off, (2) clean code passes, (3) blocking code rejects with a
 * CODE-classified error + structured feedback + codegen-checkpoint invalidation,
 * (4) the Wave 1.a synergy — the skeleton's ASCII-ONLY banner (CJK in comments) does
 * NOT trip the gate, (5) formatFeedback shape, (6) pipeline wiring order.
 */

var assert = require('assert');
var stage = require('../engine/stages/static-pre-review.cjs');
var pipeline = require('../engine/pipeline.cjs');

function makeCtx(csCode, extraFiles) {
  return {
    csCode: csCode,
    extraFiles: extraFiles || {},
    blueprint: { feedbackHistory: [] },
    completedStages: ['codegen', 'method-check'],
    logs: [],
    addLog: function(stageName, msg) { this.logs.push(stageName + ': ' + msg); },
  };
}

// ---- synchronous cases ----
(function testFlagOff() {
  delete process.env.STATIC_PRE_REVIEW_ENABLED;
  assert.strictEqual(stage.canSkip(makeCtx('x')), true, 'default-off: must skip');
  process.env.STATIC_PRE_REVIEW_ENABLED = 'true';
  assert.strictEqual(stage.canSkip(makeCtx('x')), false, 'enabled + csCode: must NOT skip');
  assert.strictEqual(stage.canSkip(makeCtx('')), true, 'enabled but no csCode: skip');
  delete process.env.STATIC_PRE_REVIEW_ENABLED;
  console.log('  ✓ flag gate: default-off skips; enabled+csCode runs');
})();

(function testFormatFeedback() {
  var out = stage.formatFeedback([
    { rule: 'non-ascii-resource-key', file: 'GameFlowManagerMain.Resource.cs', line: 495, text: 'AddResource("金币", 5);', message: 'CJK leak' },
  ]);
  assert.ok(/STATIC CHECK FAILED — 1 blocking/.test(out));
  assert.ok(/\[non-ascii-resource-key\] GameFlowManagerMain\.Resource\.cs:495/.test(out));
  assert.ok(/REASON: CJK leak/.test(out));
  assert.ok(/FIX: Use an ASCII identifier/.test(out));
  console.log('  ✓ formatFeedback: renders [rule] file:line / REASON / FIX block');
})();

(function testWiring() {
  var p = pipeline.createLunaPipeline();
  var names = p.stages.map(function(s) { return s.name; });
  var mc = names.indexOf('method-check');
  var spr = names.indexOf('static-pre-review');
  var rv = names.indexOf('review');
  assert.ok(spr > mc && spr < rv, 'static-pre-review between method-check and review (got ' + names.slice(mc, rv + 1).join(' → ') + ')');
  assert.strictEqual(pipeline.stages.staticPreReview, stage, 'exported in stages map');
  console.log('  ✓ pipeline wiring: method-check → static-pre-review → review');
})();

// ---- async cases ----
async function testCleanPasses() {
  var clean = [
    'using UnityEngine;',
    'public partial class GameFlowManagerMain : MonoBehaviour',
    '{',
    '    void Update() { AddResource("coins", 5); }',
    '}',
  ].join('\n');
  var ctx = await stage.execute(makeCtx(clean));
  assert.ok(ctx, 'clean code resolves with ctx');
  console.log('  ✓ clean code: execute resolves');
}

async function testBlockingRejects() {
  var bad = [
    'using UnityEngine;',
    'public partial class GameFlowManagerMain : MonoBehaviour',
    '{',
    '    void Update()',
    '    {',
    '        AddResource("金币", 5);',     // distinct line → distinct feedback signature
    '        GameObject.Find("敌人");',
    '    }',
    '}',
  ].join('\n');
  var ctx = makeCtx(bad);
  var rejected = false;
  try {
    await stage.execute(ctx);
  } catch (err) {
    rejected = true;
    assert.strictEqual(err.classification, 'CODE', 'error classified CODE');
    assert.ok(Array.isArray(err.structured) && err.structured.length >= 2, 'structured carries blocking issues');
    assert.ok(/STATIC CHECK FAILED/.test(err.feedbackText), 'feedbackText rendered');
    assert.ok(/non-ascii-resource-key/.test(err.feedbackText), 'feedback names the rule');
    assert.ok(/FIX:/.test(err.feedbackText), 'feedback has a FIX hint');
    assert.ok(ctx.completedStages.indexOf('codegen') < 0, 'codegen checkpoint invalidated');
    assert.ok(ctx.blueprint.feedbackHistory.length >= 2, 'feedbackHistory populated');
    assert.ok(ctx.blueprint.feedbackHistory.every(function(e) { return e.source === 'static-pre-review'; }), 'feedback tagged source');
  }
  assert.ok(rejected, 'must reject on blocking violations');
  console.log('  ✓ blocking code: rejects CODE + structured + feedback + checkpoint invalidated');
}

async function testSkeletonBannerNotBlocking() {
  var skeletonLike = [
    'using UnityEngine;',
    'public partial class GameFlowManagerMain : MonoBehaviour',
    '{',
    '    void Update()',
    '    {',
    '        // ║   ✗  AddResource("金币", 5)             → ✓  AddResource(GFM_ResourceIds.Gold, 5)',
    '        // ║   ✗  RecordPhaseEvidenceFlag("中文", k) → ✓  RecordPhaseEvidenceFlag(currentPhaseName, k)',
    '        transform.position = Vector3.zero;',
    '    }',
    '}',
  ].join('\n');
  await stage.execute(makeCtx(skeletonLike)); // must resolve (0 blocking)
  console.log('  ✓ Wave 1.a synergy: skeleton ASCII-ONLY banner does NOT trip the gate');
}

(async function main() {
  await testCleanPasses();
  await testBlockingRejects();
  await testSkeletonBannerNotBlocking();
  console.log('\nstatic-pre-review stage: all cases passed');
})().catch(function(err) {
  console.error('FAIL:', err && err.message);
  process.exit(1);
});
