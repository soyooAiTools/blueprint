'use strict';
// Wave 2 #3 (2026-05-31): early deterministic static-check gate, sits between
// method-check and review in createLunaPipeline. Runs staticCheckProject on the
// codegen output; if any BLOCKING rule fires, rejects with a CODE-classified error
// carrying structured per-file/line feedback so the fix-loop forces an LLM recode
// BEFORE the (expensive) review round — instead of discovering the blocking issue
// only at review's synthetic static-precheck.
//
// DEFAULT-ON as of 2026-06-01 (P2). Disable with STATIC_PRE_REVIEW_ENABLED=false. Rationale:
//   1. The original hazard — rejecting blocking issues that review's deterministic pre-repair
//      (runAllPreRepairs) would auto-fix for free, trading a free fix for a wasted recode — is
//      removed: execute() now runs that SAME pre-repair FIRST and rejects only on issues that
//      SURVIVE it (genuinely-unfixable code review would also reject). The gate can no longer
//      cost a recode for an auto-fixable issue, so it is convergence-safe.
//   2. Enabling it moves the recode for genuinely-broken code BEFORE the expensive review
//      round (faster convergence). Worker restart picks up the new default.
//
// PREREQUISITE (satisfied 2026-05-31, Wave 1.a): the non-ascii-resource-key rule's
// custom() callback now masks comments via buildCodeMask. Without that, the skeleton's
// own ASCII-ONLY warning banner (which embeds CJK reverse-examples in comments) trips
// this gate on EVERY task (incident doc §7). Do NOT enable this stage on a build that
// lacks that fix.
//
// Coexistence (incident doc §6): review.cjs pre-repair (runAllPreRepairs) and review's
// synthetic static-precheck loop are RETAINED as belt-and-suspenders. This stage is an
// additional early gate, not a replacement.

var { staticCheckProject } = require('../static-check.cjs');
var methodCheck = require('./method-check.cjs');

// Starter remediation hints (incident doc §5.1). Preferred long-term home is a
// `remediation` field on the rule in static-check.cjs RULES[] (single source of truth);
// migrating all ~58 blocking rules is the documented incremental follow-up. Until then
// this stage-local map covers the highest-frequency recode drivers, and formatFeedback
// falls back to the rule's own message when no hint is present.
var REMEDIATION = {
  'non-ascii-resource-key':
    'Use an ASCII identifier — GFM_ResourceIds.Gold (or AddResource("Gold", 5)). For\n' +
    '       phase/evidence keys use currentPhaseName / RecordPhaseEvidenceFlag(currentPhaseName, key).',
  'update-new-vector-in-hot-path':
    'Avoid per-frame Vector3 allocation in Update(). Use the pre-declared class field\n' +
    '       _hotV3.Set(x,y,z), or struct-copy: var p = obj.transform.position; p.z += dz; obj.transform.position = p;',
  'camera-main':
    'Cache Camera.main once into the `mainCam` field in Awake/Start; reference mainCam\n' +
    '       elsewhere. (Append "// 正常" only on the single intentional cache line.)',
  'setscale-wrong-params':
    'Call SetScale(obj, uniform) or SetScale(obj, x, y, z) — 2 or 4 args only.',
};

// Render the structured feedback block (incident doc §5).
function formatFeedback(blocking) {
  var lines = ['STATIC CHECK FAILED — ' + blocking.length +
    ' blocking violation(s). Fix all before resubmitting.', ''];
  blocking.forEach(function(b) {
    var hint = b.remediation || REMEDIATION[b.rule] || 'See REASON above.';
    lines.push('[' + b.rule + '] ' + (b.file || 'main') + ':' + (b.line || '?'));
    if (b.text) lines.push('  ' + String(b.text).trim());
    lines.push('  REASON: ' + (b.message || b.rule));
    lines.push('  FIX: ' + hint);
    lines.push('');
  });
  return lines.join('\n').replace(/\n+$/, '\n');
}

function execute(ctx) {
  // Convergence hardening (2026-06-01, P2): apply the SAME deterministic pre-repairs the
  // review stage runs (repairKnownStructuralDamage → runAllPreRepairs) FIRST, then static-check
  // the REPAIRED code. Reject only on blocking issues that SURVIVE the pre-repair — i.e.
  // genuinely-unfixable code that review would also reject. This removes the original
  // default-off hazard (incident doc §6.1): rejecting issues runAllPreRepairs would auto-fix
  // for free, trading a free fix for a wasted recode round. Auto-fixable issues now flow
  // through to review, which applies the same repair and passes. Lazy require avoids a load
  // cycle (review.cjs is downstream of this stage in the pipeline).
  var checkCode = ctx.csCode || '';
  var checkExtras = ctx.extraFiles || {};
  try {
    var repaired = require('./review.cjs').repairKnownStructuralDamage(checkCode, checkExtras, ctx.blueprint);
    if (repaired && typeof repaired.code === 'string') {
      checkCode = repaired.code;
      checkExtras = repaired.extraFiles || checkExtras;
    }
  } catch (e) {
    // Pre-repair is best-effort; fall back to checking the raw code (still strictly better
    // than nothing, and review's own pre-repair remains as belt-and-suspenders).
    ctx.addLog && ctx.addLog('static-pre-review', 'pre-repair skipped (' + (e && e.message || e) + '); checking raw code');
  }
  var result = staticCheckProject(checkCode, {
    extraFiles: checkExtras,
    blueprint: ctx.blueprint,
    filename: 'GameFlowManagerMain.cs',
  });
  var blocking = (result.issues || []).filter(function(i) { return i.blocking; });
  if (blocking.length === 0) return Promise.resolve(ctx);

  // Push each violation into feedbackHistory (dedup) so the recode prompt sees it,
  // then invalidate the codegen checkpoint so the retry actually re-runs codegen.
  blocking.forEach(function(b) {
    methodCheck.pushFeedbackUnique(ctx, {
      source: 'static-pre-review',
      rule: b.rule,
      file: b.file || 'main',
      line: b.line,
      message: b.message,
      text: b.text,
    });
  });
  methodCheck.invalidateCodegenCheckpoint(ctx);
  ctx.addLog && ctx.addLog('static-pre-review',
    blocking.length + ' blocking violation(s): ' +
    blocking.map(function(b) { return b.rule + '@' + (b.file || 'main') + ':' + b.line; }).join(', '));

  var err = new Error('STATIC_PRECHECK: ' + blocking.length + ' blocking violation(s)');
  err.classification = 'CODE';       // routed to recode by error-classifier / fix-loop
  err.structured = blocking;
  err.feedbackText = formatFeedback(blocking);
  return Promise.reject(err);
}

module.exports = {
  name: 'static-pre-review',
  canRetry: true,
  // DEFAULT-ON (2026-06-01, P2): now convergence-safe (pre-repair-aware execute rejects only
  // residual blocking). Skip only when explicitly disabled (STATIC_PRE_REVIEW_ENABLED=false)
  // or when there's no code yet.
  canSkip: function(ctx) {
    return process.env.STATIC_PRE_REVIEW_ENABLED === 'false' || !ctx || !ctx.csCode;
  },
  execute: execute,
  formatFeedback: formatFeedback, // exported for unit tests
};
