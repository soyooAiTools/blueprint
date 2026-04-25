/**
 * Pipeline Metrics Collector
 * Writes one JSONL record per pipeline run for data-driven optimization.
 * Read with: node -e "require('./engine/metrics.cjs').getMetricsSummary(50)"
 */

var fs = require('fs');
var path = require('path');

var METRICS_DIR = path.join(__dirname, '..', 'server-data', 'metrics');
var METRICS_FILE = path.join(METRICS_DIR, 'pipeline-metrics.jsonl');
var BASELINE_FILE = path.join(METRICS_DIR, 'baseline.json');

function readBaselineMeta() {
  try {
    if (!fs.existsSync(BASELINE_FILE)) return null;
    return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf-8'));
  } catch(e) {
    return null;
  }
}

function writeBaselineMeta(meta) {
  try {
    fs.mkdirSync(METRICS_DIR, { recursive: true });
  } catch(e) {}
  fs.writeFileSync(BASELINE_FILE, JSON.stringify(meta || {}, null, 2) + '\n');
}

function recordPipelineMetrics(ctx, stageResults) {
  try { fs.mkdirSync(METRICS_DIR, { recursive: true }); } catch(e) {}

  var record = {
    taskId: ctx.taskId,
    timestamp: new Date().toISOString(),
    totalDurationMs: Date.now() - (ctx._pipelineStartTime || Date.now()),
    hadPreviewReady: !!ctx.previewReadyAt,
    timeToFirstPreviewMs: ctx.previewReadyAt && ctx._pipelineStartTime
      ? Math.max(0, ctx.previewReadyAt - ctx._pipelineStartTime)
      : null,
    previewUrl: ctx.previewUrl || null,
    success: !ctx._pipelineError,
    failedAtStage: ctx._failedAtStage || null,
    failReason: ctx._failReason ? ctx._failReason.substring(0, 500) : null,
    failClassification: ctx._failClassification || null,
    completedStages: ctx.completedStages ? ctx.completedStages.slice() : [],
    skippedStages: ctx._skippedStages ? ctx._skippedStages.slice() : [],
    stages: {},
  };

  var stageNames = ['spec-extract', 'spec-validate', 'complexity-gate', 'assembly-plan', 'assembly-complexity-gate', 'codegen', 'method-check', 'review', 'compile', 'visual-check', 'runtime-contract', 'cua-verify', 'upload'];
  for (var i = 0; i < stageNames.length; i++) {
    var name = stageNames[i];
    var sr = stageResults[name];
    if (!sr) continue;
    record.stages[name] = {
      durationMs: sr.durationMs || 0,
      rounds: sr.rounds || 1,
      passed: sr.passed !== false,
      patchUsed: !!sr.patchApplied,
    };
  }

  // Phase coverage on first codegen pass
  if (stageResults.codegen && stageResults.codegen.phaseDetection) {
    var pd = stageResults.codegen.phaseDetection;
    record.firstPassPhaseCoverage = pd.implementedPhases + '/' + pd.expectedPhases;
    record.missingPhases = pd.missing || [];
  }

  // Review details
  if (stageResults.review) {
    record.reviewRounds = stageResults.review.rounds || 1;
    record.reviewWarningOnly = !!stageResults.review.warningOnly;
  }

  if (stageResults['runtime-contract']) {
    var rc = stageResults['runtime-contract'];
    record.runtimeContractPassed = rc.contractPassed === true;
    record.runtimeContractNeedsEscalation = rc.needsEscalation !== false;
    record.runtimeContractPlanCoverage = rc.planCoverage || null;
    record.runtimeContractSignalCoverage = rc.signalCoverage || null;
    record.runtimeContractSignalValidationPassed = rc.signalValidationPassed !== false;
    record.runtimeContractMissingSignalCount = rc.missingSignalCount || 0;
    record.runtimeContractUnsupportedSignalCount = rc.unsupportedSignalCount || 0;
    record.runtimeContractVisualFailCount = rc.visualFailCount || 0;
    record.runtimeContractSilentPassSignals = rc.silentPassSignals || [];
    record.runtimeContractDefaultInteractionPassed = rc.defaultInteractionPassed === undefined ? null : rc.defaultInteractionPassed;
    record.runtimeContractDefaultInteractionReason = rc.defaultInteractionReason || '';
  }

  // CUA details
  if (stageResults['cua-verify']) {
    var cua = stageResults['cua-verify'];
    record.cuaRounds = cua.round || 1;
    record.cuaReason = cua.reason || '';
    record.cuaPlanCoverage = cua.planCoverage || null;
    record.cuaSignalCoverage = cua.signalCoverage || null;
    record.cuaSignalValidationPassed = cua.signalValidationPassed !== false;
    record.cuaMissingSignalCount = cua.missingSignalCount || 0;
    record.cuaUnsupportedSignalCount = cua.unsupportedSignalCount || 0;
    // Silent-pass detection signals (recorded even on success)
    record.cuaTotalActions = cua.totalActions !== undefined ? cua.totalActions : null;
    record.cuaSilentPassSignals = cua.silentPassSignals || [];
    record.cuaSilentPass = !!(cua.silentPassSignals && cua.silentPassSignals.length > 0);
    // D1 (2026-04-20): fingerprint circuit breaker observability.
    record.cuaFingerprintRepeats = cua.maxFingerprintRepeats || 0;
    record.cuaCircuitBreakerTriggered = !!cua.circuitBreakerTriggered;
    // A.2 (2026-04-20): stuck diagnosis observability — 58.6% of CUA failures
    // previously had no rootCause in metrics. Now every failure round populates.
    if (cua.lastStuckDiagnosis) {
      record.cuaRootCause  = cua.lastStuckDiagnosis.rootCause  || '';
      record.cuaStuckPhase = cua.lastStuckDiagnosis.stuckPhase || '';
      record.cuaNextPhase  = cua.lastStuckDiagnosis.nextPhase  || '';
    }
  }

  // Schema-driven codegen metrics (8 fields per spec Section 6.1)
  if (ctx && ctx.blueprint) {
    if (ctx.blueprint.gameSchema) {
      record.codegenMode = 'schema';
      record.schemaTokensIn = ctx.blueprint.schemaTokensIn || 0;
      record.schemaTokensOut = ctx.blueprint.schemaTokensOut || 0;
      record.templateFillMs = ctx.blueprint.templateFillMs || 0;
      record.templateCoverage = ctx.blueprint.templateCoverage || 0;
      record.todoSectionsRemaining = ctx.blueprint.todoSectionsRemaining || 0;
      record.customLogicUsed = !!(ctx.blueprint.gameSchema.customLogic && ctx.blueprint.gameSchema.customLogic.length > 0);
      record.customLogicTokensIn = ctx.blueprint.customLogicTokensIn || 0;
      record.customLogicRounds = ctx.blueprint.customLogicRounds || 0;
      record.customLogicScopeFixCount = ctx.blueprint.customLogicScopeFixCount || 0;
      record.customLogicRoute = ctx.blueprint.customLogicRoute || null;
      record.customLogicRouteReason = ctx.blueprint.customLogicRouteReason || null;
    } else {
      record.codegenMode = 'legacy';
    }
    if (ctx.blueprint.plans) {
      record.planRegistryVersion = ctx.blueprint.plans.registryVersion || null;
      record.storyboardAtomCount = ctx.blueprint.storyboardAtomCount || ((ctx.blueprint.plans.storyboardAtomPlan && ctx.blueprint.plans.storyboardAtomPlan.items || []).length);
      record.moduleInstanceCount = ctx.blueprint.moduleInstanceCount || ((ctx.blueprint.plans.assemblyPlan && ctx.blueprint.plans.assemblyPlan.moduleInstances || []).length);
      record.assemblySlotCount = ctx.blueprint.assemblySlotCount != null ? ctx.blueprint.assemblySlotCount : 0;
      record.cuaPlanSteps = ctx.blueprint.cuaPlanStepCount || ((ctx.blueprint.plans.cuaPlan && ctx.blueprint.plans.cuaPlan.steps || []).length);
      record.assemblyUnresolvedCount = ctx.blueprint.assemblyUnresolvedCount != null
        ? ctx.blueprint.assemblyUnresolvedCount
        : ((ctx.blueprint.plans.assemblyPlan && ctx.blueprint.plans.assemblyPlan.unresolved || []).length);
      record.planValidationWarnings = ctx.blueprint.planValidationWarningCount != null
        ? ctx.blueprint.planValidationWarningCount
        : ((ctx.blueprint.planValidation && ctx.blueprint.planValidation.warnings || []).length);
      record.assemblyCoverage = ctx.blueprint.assemblyCoverage != null ? ctx.blueprint.assemblyCoverage : null;
      record.assemblyImplementationCoverage = ctx.blueprint.assemblyImplementationCoverage != null ? ctx.blueprint.assemblyImplementationCoverage : null;
      record.assemblyImplementationMissingCount = ctx.blueprint.assemblyImplementationMissingCount != null ? ctx.blueprint.assemblyImplementationMissingCount : null;
      record.assemblyImplementationMissingModuleIds = ctx.blueprint.assemblyImplementationMissingModuleIds || [];
      record.assemblyImplementationTotal = ctx.blueprint.assemblyImplementationTotal != null ? ctx.blueprint.assemblyImplementationTotal : null;
      record.assemblyImplementationImplemented = ctx.blueprint.assemblyImplementationImplemented != null ? ctx.blueprint.assemblyImplementationImplemented : null;
      record.customLogicSuppressedCount = ctx.blueprint.customLogicSuppressedCount || 0;
      record.assemblyDeterministicReady = ctx.blueprint.assemblyDecision === 'assembly_ready' &&
        record.assemblyUnresolvedCount === 0 &&
        record.assemblyCoverage != null &&
        record.assemblyCoverage >= 0.999 &&
        record.assemblyImplementationCoverage != null &&
        record.assemblyImplementationCoverage >= 0.999 &&
        (record.assemblyImplementationMissingCount || 0) === 0;
      record.assemblyFallbackRequired = record.assemblyUnresolvedCount > 0 ||
        (record.assemblyImplementationCoverage != null && record.assemblyImplementationCoverage < 0.999) ||
        ((record.assemblyImplementationMissingCount || 0) > 0);
      record.assemblyDecision = ctx.blueprint.assemblyDecision || null;
      record.assemblyRiskLevel = ctx.blueprint.assemblyRiskLevel || null;
      record.codegenInputMode = ctx.blueprint.gameSchema ? 'assembly-first' : 'assembly-plan-ready';
    }
    record.legacyComplexityScore = ctx.blueprint.legacyComplexityScore != null ? ctx.blueprint.legacyComplexityScore : null;
    record.legacyComplexityBand = ctx.blueprint.legacyComplexityBand || null;
  }

  try {
    // Rotate if file exceeds 10MB
    try {
      var stat = fs.statSync(METRICS_FILE);
      if (stat.size > 10 * 1024 * 1024) {
        var rotatedPath = METRICS_FILE + '.bak.' + new Date().toISOString().slice(0, 10).replace(/-/g, '');
        fs.renameSync(METRICS_FILE, rotatedPath);
        console.log('[metrics] Rotated metrics file to ' + rotatedPath + ' (' + (stat.size / 1048576).toFixed(1) + 'MB)');
      }
    } catch(rotateErr) {
      // rotation check failed — continue writing to existing file
    }
    fs.appendFileSync(METRICS_FILE, JSON.stringify(record) + '\n');
  } catch(e) { console.error('[metrics] Write failed:', e.message); }

  return record;
}

function loadRecords(lastN) {
  lastN = lastN || 50;
  try {
    var data = fs.readFileSync(METRICS_FILE, 'utf-8').trim();
    if (!data) return [];
    var lines = data.split('\n');
    return lines.slice(-lastN).map(function(l) {
      try { return JSON.parse(l); } catch(e) { return null; }
    }).filter(Boolean);
  } catch(e) {
    return [];
  }
}

/**
 * Normalize a failure reason into a stable fingerprint.
 *
 * Strips dynamic fragments (paths, IDs, hex hashes, numbers, timestamps) so the
 * same root cause yields the same fingerprint across runs. Keeps the structural
 * English phrases that identify the defect class.
 *
 * 2026-04-16 — introduced to kill "19 retries of one stuck task = 19 separate
 * fail reasons" display bug.
 */
/**
 * Collapse repeated same-prefix clauses into a single "<prefix> (N occurrences)"
 * form, so 7 inline "entity case mismatch" errors in a single failReason don't
 * each become an independent fingerprint.
 *
 * Matches any line starting with a repeated structural prefix (≥3 hits).
 * Safe default: returns reason unchanged if no clear cluster is found.
 */
function collapseRepeatedClauses(reason) {
  if (!reason || typeof reason !== 'string') return reason;
  // Split into candidate clauses — newlines OR leading Spec[N] markers
  var rawClauses = reason.split(/\n+/).filter(Boolean);
  if (rawClauses.length < 3) return reason;
  // Build a structural key per clause: strip Spec[N], quoted strings, numbers
  function keyOf(line) {
    return line
      .replace(/^Spec\[\d+\]\s*[a-zA-Z_]\w*\s*:\s*/, 'Spec[N] <phase>: ')
      .replace(/"[^"]*"/g, '"<entity>"')
      .replace(/\b\d+\b/g, 'N')
      .slice(0, 80);
  }
  var byKey = {};
  rawClauses.forEach(function(c) {
    var k = keyOf(c);
    if (!byKey[k]) byKey[k] = { count: 0, first: c };
    byKey[k].count++;
  });
  var keys = Object.keys(byKey);
  var cluster = keys.filter(function(k) { return byKey[k].count >= 3; });
  if (cluster.length === 0) return reason;
  // Rebuild reason: one line per cluster (first sample + count), rest untouched
  var used = {};
  var out = [];
  rawClauses.forEach(function(c) {
    var k = keyOf(c);
    if (byKey[k].count >= 3) {
      if (!used[k]) {
        out.push(byKey[k].first + ' (' + byKey[k].count + ' occurrences)');
        used[k] = true;
      }
    } else {
      out.push(c);
    }
  });
  return out.join('\n');
}

/**
 * @param {string} reason - raw failure reason text
 * @param {object} [opts] - { stage?: string } — optional stage prefix for
 *   disambiguating otherwise-generic errors (e.g. a null-deref can happen
 *   in any stage; binding stage prevents recipes from false-matching).
 *   When stage is provided, output becomes "<stage>|<normalized>".
 *   Callers opt in explicitly; legacy callers keep pre-D3 behavior.
 */
function normalizeFingerprint(reason, opts) {
  if (!reason) return 'unknown';
  var s = String(reason);
  // 2026-04-19: collapse repeated clauses BEFORE everything else so the rest
  // of the pipeline sees a fingerprint shape that's stable even when
  // spec-validate aggregation is bypassed (e.g. legacy records).
  s = collapseRepeatedClauses(s);
  // Drop leading "prefix: " stage tags if present
  s = s.replace(/^(review|codegen|compile|visual-check|runtime-contract|cua-verify|upload|spec-validate|spec-extract|build|complexity-gate|assembly-complexity-gate|method-check)[ :]+/i, '');
  // D3: fraction normalization MUST run before path regex — previously
  // "2/11 overlap" was swallowed by the path regex as "2<path> overlap",
  // leaving 9%/18%/27% as distinct fingerprints that each bypassed the
  // others' cooldowns. Real examples live in server-data/auto-fix-state.json
  // circa 2026-04-19 ("Spec fingerprint drift", "Phase coverage too low").
  s = s.replace(/\b(\d+)\s*\/\s*(\d+)\b/g, 'N/N');
  // D3: percent literals — "(18%)" and "(9%)" were distinct fingerprints.
  s = s.replace(/\(\s*\d+(?:\.\d+)?\s*%\s*\)/g, '(N%)');
  s = s.replace(/\b\d+(?:\.\d+)?%/g, 'N%');
  // Unix paths — require first segment to start with a letter/underscore
  // AND demand either ≥2 segments or a file extension, so the regex no
  // longer eats number-fraction tails like "/11 overlap" nor the synthetic
  // "/N" left behind by the fraction-collapse pass above.
  s = s.replace(/\/[a-zA-Z_][\w.\-]*(?:\/[\w.\-]+)+/g, '<path>');                    // multi-segment
  s = s.replace(/\/[a-zA-Z_][\w.\-]*\.[a-zA-Z][\w]*/g, '<path>');                    // single seg with ext
  // Windows paths
  s = s.replace(/[A-Z]:\\[\w\\.\-]+/g, '<path>');
  // Task IDs like proj_1774794237502_k0rbwx
  s = s.replace(/proj_\d{10,}_[a-z0-9]+/gi, '<taskId>');
  // Standalone long numbers (timestamps, bytes, line offsets)
  s = s.replace(/\b\d{5,}\b/g, '<num>');
  // Hex hashes
  s = s.replace(/\b[a-f0-9]{7,40}\b/g, '<hash>');
  // "round X" → "round N"
  s = s.replace(/round\s+\d+/gi, 'round N');
  // "X rounds" / "X attempts" → "N rounds"
  s = s.replace(/\d+\s+(rounds?|attempts?)/gi, 'N $1');
  // 2026-04-17: Normalize short numbers in common patterns that caused
  // auto-fix idle loop — "47min > 45min" vs "51min > 45min" were treated
  // as separate fingerprints, each bypassing the other's cooldown.
  // "(Nmin > Nmin)" pattern (CUA time limit exceeded)
  s = s.replace(/\d+min/g, 'Nmin');
  // "N error(s)" / "N warning(s)" (spec validation count)
  s = s.replace(/\d+\s+(error|warning)\(s\)/gi, 'N $1(s)');
  // D3: "1 critical" vs "2 critical" (review blocker counts)
  s = s.replace(/\b\d+\s+(critical|blocker|issue)s?/gi, 'N $1');
  // D3: JSON-schema array indexes — ".entities[0]" vs ".entities[1]" etc.
  s = s.replace(/(\.[a-zA-Z_]\w*)\[\d+\]/g, '$1[N]');
  // D3: process exit codes — "Exit code 143" (SIGTERM) vs "Exit code 137" (SIGKILL).
  s = s.replace(/\bExit\s+code\s+\d+/gi, 'Exit code N');
  // Quoted entity names: "forgeWorkshop", "drill", "dormitory" etc.
  // These vary per task but the root cause is the same class of mismatch
  s = s.replace(/"[a-zA-Z_]\w*"/g, '"<entity>"');
  // "Spec[N] phaseId:" — normalize both the index and the per-task phaseId
  s = s.replace(/Spec\[\d+\]\s*[a-zA-Z]\w*/g, 'Spec[N] <phase>');
  // "N consecutive" (visual freeze round counts)
  s = s.replace(/\d+\s+consecutive/gi, 'N consecutive');
  // 2026-04-21: screenshot-timing fingerprint stabilisation — "Screenshot sharing:
  // N spec phases share only N screenshot(s)" uses small counts (1–9) that survive
  // the \b\d{5,}\b filter above and produce distinct fingerprints for tasks with
  // different phase counts (e.g. 2-phase vs 3-phase tasks), silently bypassing the
  // per-fingerprint circuit-breaker cooldown on every new task.
  // FIX: removed `:` from both `[^.:\n]` exclusion classes so the regex can
  // traverse the colon-space separator ("sharing: N …") and reach the counts.
  // Normalise the entire message to a fixed shape so all instances land on one key.
  s = s.replace(/screenshot\s+sharing[^.\n]*\d+[^.\n]*/gi, 'screenshot sharing N phases N screenshots');
  // 2026-04-19: silent-pass-block fingerprint stabilisation.
  // The tail (" — game logic did not run correctly despite passed=true")
  // plus the signal class (uniform-timing / phase-order-violation /
  // all-vars-zero) is the recurring structure. Drop the tail so all three
  // classes land in matching fingerprints regardless of per-task detail.
  s = s.replace(/\[silent-pass-block\]\s*([a-z-]+)(?::[^—]*)?\s*—\s*.*$/i, 'silent-pass-block $1');
  // 2026-04-19: MODEL_FATAL fingerprint stabilisation — route all quota/auth
  // flavors to MODEL_FATAL:<endpoint> so auto-fix cooldown groups them.
  s = s.replace(/MODEL_FATAL:?\s*([a-z0-9._-]+)?(?::|\b).*$/i, function(_m, ep) {
    return 'MODEL_FATAL:' + (ep || 'provider');
  });
  // Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();
  // Cap at 100 chars to prevent unbounded keys
  var capped = s.slice(0, 100);
  // D3: optional stage dimension — prepended so recipes can scope themselves
  // to a single stage and generic errors like "Cannot read properties of
  // undefined (reading 'length')" no longer cross-match recipes from other
  // stages. Callers that don't pass a stage get the legacy behavior.
  if (opts && opts.stage) {
    return String(opts.stage).toLowerCase() + '|' + capped;
  }
  return capped;
}

function dataWindow(records) {
  if (!records.length) return null;
  var from = null, to = null;
  for (var i = 0; i < records.length; i++) {
    var ts = records[i].timestamp;
    if (!ts) continue;
    if (!from || ts < from) from = ts;
    if (!to || ts > to) to = ts;
  }
  return { from: from, to: to };
}

function classifyFailureFamily(record) {
  var stage = String(record && record.failedAtStage || 'unknown');
  var raw = String(record && (record.failReason || '') || '');
  var fp = normalizeFingerprint(raw, { stage: stage });
  var hay = (stage + ' ' + raw + ' ' + fp).toLowerCase();

  if (/econnreset|request timed out|unable to connect to api|schema generation failed/.test(hay)) {
    return 'infra.schema_backend';
  }
  if (/template marker coverage failed|missing skeleton markers/.test(hay)) {
    return 'codegen.marker_coverage';
  }
  if (/trigger should have required property .type.|trigger should not have additional properties|invalid trigger shape/.test(hay)) {
    return 'schema.invalid_trigger_shape';
  }
  if (/method completeness failed|missing methods:/.test(hay)) {
    return 'method_check.partial_visibility';
  }
  if (/same code error repeated|fix-loop not converging|review aborted/.test(hay)) {
    return 'review.nonconverging_structural';
  }
  if (/main-file-reintroduced-phase-logic/.test(hay)) {
    return 'review.main_file_reintroduced_phase_logic';
  }
  if (/forbidden-init-material-from-scene/.test(hay)) {
    return 'review.forbidden_init_material_from_scene';
  }
  if (/phase-condition-false-literal/.test(hay)) {
    return 'review.phase_condition_false_literal';
  }
  if (/visual freeze|screenshot sharing|batch completion|pre-contamination/.test(hay)) {
    return 'cua.observe_protocol';
  }
  if (/time limit exceeded|no progress timeout|stuck phase|stuck-processing|stuck-review/.test(hay)) {
    return 'monitor.stuck_or_timeout';
  }
  if (/expected ',' or '}' after property value|bad_simplify_json|auto-simplifying/.test(hay)) {
    return 'complexity_gate.bad_simplify_json';
  }
  if (/silent-pass-block/.test(hay)) {
    return 'cua.silent_pass';
  }
  if (/model_fatal/.test(hay)) {
    return 'infra.model_fatal';
  }
  if (/review/.test(stage)) return 'review.other';
  if (/runtime-contract|cua-verify/.test(stage)) return 'cua.other';
  if (/assembly-plan|assembly-complexity-gate|codegen|method-check|spec-validate|complexity-gate/.test(stage)) return 'generation.other';
  return 'unknown';
}

function getMetricsSummary(lastN) {
  var records = loadRecords(lastN);
  var baseline = readBaselineMeta();
  if (records.length === 0) {
    return {
      totalRuns: 0,
      baselineStartedAt: baseline && baseline.startedAt || null,
      baselineReason: baseline && baseline.reason || null,
      message: 'No metrics data yet. Run a pipeline to start collecting.'
    };
  }

  var successCount = records.filter(function(r) { return r.success; }).length;
  var failedRecords = records.filter(function(r) { return !r.success; });

  var summary = {
    totalRuns: records.length,
    successRate: (successCount / records.length * 100).toFixed(1) + '%',
    successCount: successCount,
    failCount: failedRecords.length,
    avgDurationMin: (records.reduce(function(a, r) { return a + (r.totalDurationMs || 0); }, 0) / records.length / 60000).toFixed(1),
    avgTimeToFinalVerdictMin: (records.reduce(function(a, r) { return a + (r.totalDurationMs || 0); }, 0) / records.length / 60000).toFixed(1),
    stageAvgRounds: {},
    baselineStartedAt: baseline && baseline.startedAt || null,
    baselineReason: baseline && baseline.reason || null,
  };

  var retryWasteMs = 0;
  var retryWasteByStage = {};
  records.forEach(function(r) {
    var stages = r.stages || {};
    Object.keys(stages).forEach(function(stage) {
      var sr = stages[stage] || {};
      var rounds = sr.rounds || 1;
      var durationMs = sr.durationMs || 0;
      if (rounds <= 1 || durationMs <= 0) return;
      var estimatedWaste = durationMs * (rounds - 1) / rounds;
      retryWasteMs += estimatedWaste;
      retryWasteByStage[stage] = (retryWasteByStage[stage] || 0) + estimatedWaste;
    });
  });
  summary.avgEstimatedRetryWasteMin = (retryWasteMs / records.length / 60000).toFixed(1);
  summary.retryWasteByStage = Object.keys(retryWasteByStage)
    .map(function(stage) {
      return {
        stage: stage,
        minutes: (retryWasteByStage[stage] / 60000).toFixed(1),
      };
    })
    .sort(function(a, b) { return parseFloat(b.minutes) - parseFloat(a.minutes); });

  var previewRecords = records.filter(function(r) {
    return r.timeToFirstPreviewMs !== null && r.timeToFirstPreviewMs !== undefined;
  });
  if (previewRecords.length > 0) {
    var totalTtfp = previewRecords.reduce(function(a, r) { return a + (r.timeToFirstPreviewMs || 0); }, 0);
    var previewReadyCount = records.filter(function(r) { return r.hadPreviewReady; }).length;
    var previewThenFailedCount = records.filter(function(r) { return r.hadPreviewReady && !r.success; }).length;
    var previewThenFailedByStage = {};
    records.forEach(function(r) {
      if (!(r.hadPreviewReady && !r.success)) return;
      var stage = r.failedAtStage || 'unknown';
      previewThenFailedByStage[stage] = (previewThenFailedByStage[stage] || 0) + 1;
    });
    summary.previewReadyRate = (previewReadyCount / records.length * 100).toFixed(1) + '%';
    summary.avgTimeToFirstPreviewMin = (totalTtfp / previewRecords.length / 60000).toFixed(1);
    summary.previewThenFailedCount = previewThenFailedCount;
    summary.previewThenFailedRate = previewReadyCount > 0
      ? (previewThenFailedCount / previewReadyCount * 100).toFixed(1) + '%'
      : '0.0%';
    summary.previewThenFailedByStage = Object.keys(previewThenFailedByStage)
      .map(function(stage) {
        return {
          stage: stage,
          count: previewThenFailedByStage[stage],
          pct: previewThenFailedCount > 0
            ? (previewThenFailedByStage[stage] / previewThenFailedCount * 100).toFixed(0) + '%'
            : '0%',
        };
      })
      .sort(function(a, b) { return b.count - a.count; });
  }

  // ---- Failure hotspot: which stage fails most ----
  var stageFailCounts = {};
  var classificationCounts = {};
  var familyCounts = {};
  var familyWasteMs = {};
  for (var fi = 0; fi < failedRecords.length; fi++) {
    var fr = failedRecords[fi];
    var fStage = fr.failedAtStage || 'unknown';
    stageFailCounts[fStage] = (stageFailCounts[fStage] || 0) + 1;
    var fClass = fr.failClassification || 'unknown';
    classificationCounts[fClass] = (classificationCounts[fClass] || 0) + 1;
    var family = classifyFailureFamily(fr);
    familyCounts[family] = (familyCounts[family] || 0) + 1;
    familyWasteMs[family] = (familyWasteMs[family] || 0) + (fr.totalDurationMs || 0);
  }
  // Sort by count descending
  summary.failureHotspots = Object.keys(stageFailCounts)
    .map(function(k) { return { stage: k, count: stageFailCounts[k], pct: (stageFailCounts[k] / failedRecords.length * 100).toFixed(0) + '%' }; })
    .sort(function(a, b) { return b.count - a.count; });

  summary.failureClassifications = classificationCounts;
  summary.failureFamilies = Object.keys(familyCounts)
    .map(function(k) {
      return {
        family: k,
        count: familyCounts[k],
        pct: failedRecords.length > 0 ? (familyCounts[k] / failedRecords.length * 100).toFixed(0) + '%' : '0%',
      };
    })
    .sort(function(a, b) { return b.count - a.count; });
  summary.wasteByFamily = Object.keys(familyWasteMs)
    .map(function(k) {
      return {
        family: k,
        minutes: (familyWasteMs[k] / 60000).toFixed(1),
      };
    })
    .sort(function(a, b) { return parseFloat(b.minutes) - parseFloat(a.minutes); });

  // ---- Bottleneck: stage with highest avg rounds ----
  var bottleneck = { stage: null, avgRounds: 0 };
  ['review', 'compile', 'visual-check', 'runtime-contract', 'cua-verify'].forEach(function(sn) {
    var rounds = records.map(function(r) { return r.stages[sn] ? r.stages[sn].rounds : 0; }).filter(function(r) { return r > 0; });
    if (rounds.length > 0) {
      var avg = rounds.reduce(function(a, b) { return a + b; }, 0) / rounds.length;
      summary.stageAvgRounds[sn] = avg.toFixed(1);
      if (avg > bottleneck.avgRounds) {
        bottleneck = { stage: sn, avgRounds: avg.toFixed(1) };
      }
    }
  });
  if (bottleneck.stage) summary.bottleneckStage = bottleneck;

  // ---- Per-stage pass rate ----
  summary.stagePassRates = {};
  var allStages = ['spec-extract', 'spec-validate', 'complexity-gate', 'assembly-plan', 'assembly-complexity-gate', 'codegen', 'review', 'compile', 'visual-check', 'runtime-contract', 'cua-verify', 'upload'];
  for (var si = 0; si < allStages.length; si++) {
    var sn = allStages[si];
    var attempted = records.filter(function(r) { return r.stages[sn] || r.failedAtStage === sn; }).length;
    if (attempted === 0) continue;
    var passed = records.filter(function(r) { return r.stages[sn] && r.stages[sn].passed; }).length;
    summary.stagePassRates[sn] = {
      attempted: attempted,
      passed: passed,
      rate: (passed / attempted * 100).toFixed(0) + '%',
    };
  }

  // ---- Phase coverage first-pass rate ----
  var coverageRecords = records.filter(function(r) { return r.firstPassPhaseCoverage; });
  if (coverageRecords.length > 0) {
    var fullCoverage = coverageRecords.filter(function(r) {
      var parts = r.firstPassPhaseCoverage.split('/');
      return parts[0] === parts[1];
    }).length;
    summary.codegenFirstPassFullCoverage = (fullCoverage / coverageRecords.length * 100).toFixed(1) + '%';
  }

  // ---- Warning-only pass rate ----
  var reviewRecords = records.filter(function(r) { return r.reviewWarningOnly !== undefined; });
  if (reviewRecords.length > 0) {
    var warningOnly = reviewRecords.filter(function(r) { return r.reviewWarningOnly; }).length;
    summary.reviewWarningOnlyRate = (warningOnly / reviewRecords.length * 100).toFixed(1) + '%';
  }

  var assemblyRecords = records.filter(function(r) {
    return r.storyboardAtomCount !== undefined || r.assemblyCoverage !== undefined;
  });
  if (assemblyRecords.length > 0) {
    var totalAtoms = 0;
    var totalModules = 0;
    var totalSlots = 0;
    var totalSteps = 0;
    var totalCoverage = 0;
    var coverageCount = 0;
    var totalImplementationCoverage = 0;
    var implementationCoverageCount = 0;
    var missingImplementationTotal = 0;
    var fallbackCount = 0;
    var deterministicReadyCount = 0;
    var customLogicUsedCount = 0;
    var postImplementationGateCount = 0;
    var postImplementationGateCustomLogicCount = 0;
    var customLogicSuppressedTotal = 0;
    var customLogicRoutes = {};
    var totalScopeFixes = 0;
    var signalCoverageCovered = 0;
    var signalCoverageTotal = 0;
    var signalCoverageCount = 0;
    var signalValidationFailures = 0;
    assemblyRecords.forEach(function(r) {
      totalAtoms += r.storyboardAtomCount || 0;
      totalModules += r.moduleInstanceCount || 0;
      totalSlots += r.assemblySlotCount || 0;
      totalSteps += r.cuaPlanSteps || 0;
      if (r.assemblyCoverage !== null && r.assemblyCoverage !== undefined) {
        totalCoverage += r.assemblyCoverage;
        coverageCount++;
      }
      if (r.assemblyImplementationCoverage !== null && r.assemblyImplementationCoverage !== undefined) {
        totalImplementationCoverage += r.assemblyImplementationCoverage;
        implementationCoverageCount++;
      }
      missingImplementationTotal += r.assemblyImplementationMissingCount || 0;
      if (r.assemblyFallbackRequired) fallbackCount++;
      if (r.assemblyDeterministicReady) deterministicReadyCount++;
      if (r.customLogicUsed) customLogicUsedCount++;
      if (r.customLogicRoute) customLogicRoutes[r.customLogicRoute] = (customLogicRoutes[r.customLogicRoute] || 0) + 1;
      if (r.assemblyImplementationCoverage !== null && r.assemblyImplementationCoverage !== undefined) {
        postImplementationGateCount++;
        if (r.customLogicUsed) postImplementationGateCustomLogicCount++;
      }
      customLogicSuppressedTotal += r.customLogicSuppressedCount || 0;
      totalScopeFixes += r.customLogicScopeFixCount || 0;
      if (r.cuaSignalCoverage && /^\d+\/\d+$/.test(r.cuaSignalCoverage)) {
        var parts = r.cuaSignalCoverage.split('/');
        signalCoverageCovered += parseInt(parts[0], 10) || 0;
        signalCoverageTotal += parseInt(parts[1], 10) || 0;
        signalCoverageCount++;
      }
      if (r.cuaSignalValidationPassed === false) signalValidationFailures++;
    });
    summary.avgStoryboardAtoms = (totalAtoms / assemblyRecords.length).toFixed(1);
    summary.avgModuleInstances = (totalModules / assemblyRecords.length).toFixed(1);
    summary.avgAssemblySlots = (totalSlots / assemblyRecords.length).toFixed(1);
    summary.avgCuaPlanSteps = (totalSteps / assemblyRecords.length).toFixed(1);
    summary.avgAssemblyCoverage = coverageCount > 0 ? (totalCoverage / coverageCount * 100).toFixed(1) + '%' : null;
    summary.avgAssemblyImplementationCoverage = implementationCoverageCount > 0 ? (totalImplementationCoverage / implementationCoverageCount * 100).toFixed(1) + '%' : null;
    summary.avgAssemblyImplementationMissing = (missingImplementationTotal / assemblyRecords.length).toFixed(1);
    summary.assemblyDeterministicReadyRate = (deterministicReadyCount / assemblyRecords.length * 100).toFixed(1) + '%';
    summary.assemblyFallbackRate = (fallbackCount / assemblyRecords.length * 100).toFixed(1) + '%';
    summary.customLogicUsedRate = (customLogicUsedCount / assemblyRecords.length * 100).toFixed(1) + '%';
    summary.customLogicUsedAfterImplementationGateRate = postImplementationGateCount > 0
      ? (postImplementationGateCustomLogicCount / postImplementationGateCount * 100).toFixed(1) + '%'
      : null;
    summary.customLogicRoutes = customLogicRoutes;
    summary.customLogicSuppressedTotal = customLogicSuppressedTotal;
    summary.avgCustomLogicScopeFixes = (totalScopeFixes / assemblyRecords.length).toFixed(1);
    summary.avgCuaSignalCoverage = signalCoverageTotal > 0 ? (signalCoverageCovered / signalCoverageTotal * 100).toFixed(1) + '%' : null;
    summary.cuaSignalFailureRate = signalCoverageCount > 0 ? (signalValidationFailures / signalCoverageCount * 100).toFixed(1) + '%' : null;
  }

  // ---- Trend: last 5 vs previous 5 ----
  if (records.length >= 10) {
    var recent5 = records.slice(-5);
    var prev5 = records.slice(-10, -5);
    var recentSuccess = recent5.filter(function(r) { return r.success; }).length;
    var prevSuccess = prev5.filter(function(r) { return r.success; }).length;
    summary.trend = {
      recent5SuccessRate: (recentSuccess / 5 * 100).toFixed(0) + '%',
      previous5SuccessRate: (prevSuccess / 5 * 100).toFixed(0) + '%',
      direction: recentSuccess > prevSuccess ? 'improving' : recentSuccess < prevSuccess ? 'declining' : 'stable',
    };
  }

  // ---- Top failure fingerprints (deduplicated by (taskId, fingerprint)) ----
  // Previous bug: substring(0,100) as key → 1 stuck task × 19 retries = 19 rows.
  // Now: group by fingerprint, track uniqueTasks (distinct taskIds) and retries
  // (total occurrences), plus firstSeen / lastSeen / sampleReason / failedAtStage.
  var fpData = {};
  for (var ri = 0; ri < failedRecords.length; ri++) {
    var fr = failedRecords[ri];
    if (!fr.failReason) continue;
    var fp = normalizeFingerprint(fr.failReason);
    // Group by (stage, fingerprint) so the same message from codegen vs
    // spec-validate lands in separate rows — recipe lookup and cooldown
    // should scope to the stage that actually raised the error.
    var stage = fr.failedAtStage || 'unknown';
    var key = stage + '|' + fp;
    if (!fpData[key]) {
      fpData[key] = {
        fingerprint: fp,
        sampleReason: fr.failReason.slice(0, 200),
        uniqueTasks: {},
        retries: 0,
        firstSeen: fr.timestamp,
        lastSeen: fr.timestamp,
        failedAtStage: stage,
        classification: fr.failClassification || 'unknown',
      };
    }
    var slot = fpData[key];
    slot.retries += 1;
    if (fr.taskId) slot.uniqueTasks[fr.taskId] = true;
    if (fr.timestamp && fr.timestamp < slot.firstSeen) slot.firstSeen = fr.timestamp;
    if (fr.timestamp && fr.timestamp > slot.lastSeen) slot.lastSeen = fr.timestamp;
  }
  summary.topFailReasons = Object.keys(fpData).map(function(k) {
    var s = fpData[k];
    return {
      fingerprint: s.fingerprint,
      sampleReason: s.sampleReason,
      uniqueTasks: Object.keys(s.uniqueTasks).length,
      retries: s.retries,
      firstSeen: s.firstSeen,
      lastSeen: s.lastSeen,
      failedAtStage: s.failedAtStage,
      classification: s.classification,
      // Kept for backwards compat with any external consumer that still reads
      // { reason, count }; both fields now reflect unique-task view, not inflated
      // retry counts.
      reason: s.sampleReason.slice(0, 100),
      count: Object.keys(s.uniqueTasks).length,
    };
  }).sort(function(a, b) {
    // Sort by uniqueTasks desc, then retries desc — a fingerprint hitting 3
    // different tasks is more actionable than 19 retries of one stuck task.
    if (b.uniqueTasks !== a.uniqueTasks) return b.uniqueTasks - a.uniqueTasks;
    return b.retries - a.retries;
  }).slice(0, 10);
  summary.repeatedNonConvergingFingerprints = summary.topFailReasons
    .filter(function(item) {
      return /same code error repeated|fix-loop not converging|review aborted/i.test(String(item.sampleReason || '') + ' ' + String(item.fingerprint || ''));
    })
    .slice(0, 8);

  // ---- Data window (helps dashboard call out stale data) ----
  summary.dataWindow = dataWindow(records);

  return summary;
}

/**
 * Print a human-readable diagnostics report to stdout.
 */
function printDiagnostics(lastN) {
  var s = getMetricsSummary(lastN);
  if (s.totalRuns === 0) {
    console.log('\n  No pipeline runs recorded yet.\n');
    return;
  }

  console.log('\n========== Pipeline Diagnostics ==========');
  console.log('  Total runs:    ' + s.totalRuns);
  console.log('  Success rate:  ' + s.successRate + ' (' + s.successCount + '/' + s.totalRuns + ')');
  console.log('  Avg duration:  ' + s.avgDurationMin + ' min');
  if (s.avgTimeToFirstPreviewMin) {
    console.log('  Avg TTFP:      ' + s.avgTimeToFirstPreviewMin + ' min');
    console.log('  Preview rate:  ' + s.previewReadyRate);
    console.log('  Preview→Fail:  ' + s.previewThenFailedRate + ' (' + s.previewThenFailedCount + ')');
    if (s.previewThenFailedByStage && s.previewThenFailedByStage.length > 0) {
      console.log('  Preview→Fail by stage: ' + s.previewThenFailedByStage.map(function(x) {
        return x.stage + '=' + x.count;
      }).join(', '));
    }
  }
  console.log('  Avg TTFV:      ' + s.avgTimeToFinalVerdictMin + ' min');
  console.log('  Retry waste:   ' + s.avgEstimatedRetryWasteMin + ' min/run');

  if (s.bottleneckStage) {
    console.log('  Bottleneck:    ' + s.bottleneckStage.stage + ' (avg ' + s.bottleneckStage.avgRounds + ' rounds)');
  }

  if (s.failureHotspots && s.failureHotspots.length > 0) {
    console.log('\n  --- Failure Hotspots ---');
    for (var i = 0; i < s.failureHotspots.length; i++) {
      var h = s.failureHotspots[i];
      console.log('    ' + h.stage + ': ' + h.count + 'x (' + h.pct + ')');
    }
  }

  if (s.failureClassifications) {
    console.log('\n  --- Error Classifications ---');
    var keys = Object.keys(s.failureClassifications);
    for (var ci = 0; ci < keys.length; ci++) {
      console.log('    ' + keys[ci] + ': ' + s.failureClassifications[keys[ci]]);
    }
  }

  if (s.stagePassRates && Object.keys(s.stagePassRates).length > 0) {
    console.log('\n  --- Stage Pass Rates ---');
    var stages = Object.keys(s.stagePassRates);
    for (var pi = 0; pi < stages.length; pi++) {
      var sp = s.stagePassRates[stages[pi]];
      console.log('    ' + stages[pi] + ': ' + sp.rate + ' (' + sp.passed + '/' + sp.attempted + ')');
    }
  }

  if (s.avgStoryboardAtoms) {
    console.log('\n  --- Assembly Plan ---');
    console.log('    Avg atoms:     ' + s.avgStoryboardAtoms);
    console.log('    Avg modules:   ' + s.avgModuleInstances);
    console.log('    Avg slots:     ' + s.avgAssemblySlots);
    console.log('    Avg CUA steps: ' + s.avgCuaPlanSteps);
    if (s.avgAssemblyCoverage) console.log('    Avg coverage:  ' + s.avgAssemblyCoverage);
    if (s.avgAssemblyImplementationCoverage) console.log('    Avg impl cov:  ' + s.avgAssemblyImplementationCoverage);
    if (s.avgAssemblyImplementationMissing) console.log('    Missing impl:  ' + s.avgAssemblyImplementationMissing);
    if (s.assemblyDeterministicReadyRate) console.log('    Direct ready:  ' + s.assemblyDeterministicReadyRate);
    if (s.customLogicUsedRate) console.log('    Custom logic:  ' + s.customLogicUsedRate);
    if (s.customLogicUsedAfterImplementationGateRate) console.log('    Custom gated:  ' + s.customLogicUsedAfterImplementationGateRate);
    if (s.avgCuaSignalCoverage) console.log('    Avg signals:   ' + s.avgCuaSignalCoverage);
    if (s.cuaSignalFailureRate) console.log('    Signal fails:  ' + s.cuaSignalFailureRate);
    if (s.avgCustomLogicScopeFixes) console.log('    Scope scrubs:  ' + s.avgCustomLogicScopeFixes);
    console.log('    Fallback rate: ' + s.assemblyFallbackRate);
  }

  if (s.topFailReasons && s.topFailReasons.length > 0) {
    console.log('\n  --- Top Failure Reasons ---');
    for (var ti = 0; ti < s.topFailReasons.length; ti++) {
      var r = s.topFailReasons[ti];
      console.log('    [' + r.count + 'x] ' + r.reason);
    }
  }

  if (s.trend) {
    console.log('\n  --- Trend ---');
    console.log('    Recent 5:   ' + s.trend.recent5SuccessRate);
    console.log('    Previous 5: ' + s.trend.previous5SuccessRate);
    console.log('    Direction:  ' + s.trend.direction);
  }

  console.log('==========================================\n');
}

module.exports = {
  recordPipelineMetrics: recordPipelineMetrics,
  getMetricsSummary: getMetricsSummary,
  printDiagnostics: printDiagnostics,
  normalizeFingerprint: normalizeFingerprint,
  classifyFailureFamily: classifyFailureFamily,
  collapseRepeatedClauses: collapseRepeatedClauses,
  loadRecords: loadRecords,
  readBaselineMeta: readBaselineMeta,
  writeBaselineMeta: writeBaselineMeta,
};

// CLI: node engine/metrics.cjs [lastN]
if (require.main === module) {
  var lastN = parseInt(process.argv[2]) || 50;
  printDiagnostics(lastN);
}
