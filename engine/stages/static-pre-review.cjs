'use strict';
// Wave 2 #3 (2026-05-31): early deterministic static-check gate, sits between
// method-check and review in createLunaPipeline. Runs staticCheckProject on the
// codegen output; if any BLOCKING rule fires, rejects with a CODE-classified error
// carrying structured per-file/line feedback so the fix-loop forces an LLM recode
// BEFORE the (expensive) review round — instead of discovering the blocking issue
// only at review's synthetic static-precheck.
//
// FLAG-GATED, DEFAULT-OFF (set STATIC_PRE_REVIEW_ENABLED=true to activate). Rationale:
//   1. It changes live pipeline behavior: it rejects blocking issues — INCLUDING ones
//      the review stage's deterministic pre-repair (runAllPreRepairs) would auto-fix
//      for free — trading a recode round for earlier structured feedback. The incident
//      doc (§6) accepts this cost but flags it for telemetry review before broad
//      rollout. The operator should weigh that recode-cost tradeoff before enabling.
//   2. This repo runs live workers; default-off keeps the wiring inert (a pure no-op
//      via canSkip) until explicitly enabled, even across worker restarts.
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
  var result = staticCheckProject(ctx.csCode || '', {
    extraFiles: ctx.extraFiles || {},
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
  // Default-OFF: inert no-op unless STATIC_PRE_REVIEW_ENABLED=true (or no code yet).
  canSkip: function(ctx) {
    return process.env.STATIC_PRE_REVIEW_ENABLED !== 'true' || !ctx || !ctx.csCode;
  },
  execute: execute,
  formatFeedback: formatFeedback, // exported for unit tests
};
