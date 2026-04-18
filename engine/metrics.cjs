/**
 * Pipeline Metrics Collector
 * Writes one JSONL record per pipeline run for data-driven optimization.
 * Read with: node -e "require('./engine/metrics.cjs').getMetricsSummary(50)"
 */

var fs = require('fs');
var path = require('path');

var METRICS_DIR = path.join(__dirname, '..', 'server-data', 'metrics');
var METRICS_FILE = path.join(METRICS_DIR, 'pipeline-metrics.jsonl');

function recordPipelineMetrics(ctx, stageResults) {
  try { fs.mkdirSync(METRICS_DIR, { recursive: true }); } catch(e) {}

  var record = {
    taskId: ctx.taskId,
    timestamp: new Date().toISOString(),
    totalDurationMs: Date.now() - (ctx._pipelineStartTime || Date.now()),
    success: !ctx._pipelineError,
    failedAtStage: ctx._failedAtStage || null,
    failReason: ctx._failReason ? ctx._failReason.substring(0, 500) : null,
    failClassification: ctx._failClassification || null,
    completedStages: ctx.completedStages ? ctx.completedStages.slice() : [],
    skippedStages: ctx._skippedStages ? ctx._skippedStages.slice() : [],
    stages: {},
  };

  var stageNames = ['spec-extract', 'spec-validate', 'complexity-gate', 'codegen', 'method-check', 'review', 'compile', 'visual-check', 'cua-verify', 'upload'];
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

  // CUA details
  if (stageResults['cua-verify']) {
    var cua = stageResults['cua-verify'];
    record.cuaRounds = cua.round || 1;
    record.cuaReason = cua.reason || '';
    // Silent-pass detection signals (recorded even on success)
    record.cuaTotalActions = cua.totalActions !== undefined ? cua.totalActions : null;
    record.cuaSilentPassSignals = cua.silentPassSignals || [];
    record.cuaSilentPass = !!(cua.silentPassSignals && cua.silentPassSignals.length > 0);
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
    } else {
      record.codegenMode = 'legacy';
    }
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
function normalizeFingerprint(reason) {
  if (!reason) return 'unknown';
  var s = String(reason);
  // Drop leading "prefix: " stage tags if present
  s = s.replace(/^(review|codegen|compile|visual-check|cua-verify|upload|spec-validate)[ :]+/i, '');
  // Unix paths
  s = s.replace(/\/[\w.\-/]+/g, '<path>');
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
  // Quoted entity names: "forgeWorkshop", "drill", "dormitory" etc.
  // These vary per task but the root cause is the same class of mismatch
  s = s.replace(/"[a-zA-Z_]\w*"/g, '"<entity>"');
  // "Spec[N] phaseId:" — normalize both the index and the per-task phaseId
  s = s.replace(/Spec\[\d+\]\s*[a-zA-Z]\w*/g, 'Spec[N] <phase>');
  // "N consecutive" (visual freeze round counts)
  s = s.replace(/\d+\s+consecutive/gi, 'N consecutive');
  // Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();
  // Cap at 100 chars to prevent unbounded keys
  return s.slice(0, 100);
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

function getMetricsSummary(lastN) {
  var records = loadRecords(lastN);
  if (records.length === 0) return { totalRuns: 0, message: 'No metrics data yet. Run a pipeline to start collecting.' };

  var successCount = records.filter(function(r) { return r.success; }).length;
  var failedRecords = records.filter(function(r) { return !r.success; });

  var summary = {
    totalRuns: records.length,
    successRate: (successCount / records.length * 100).toFixed(1) + '%',
    successCount: successCount,
    failCount: failedRecords.length,
    avgDurationMin: (records.reduce(function(a, r) { return a + (r.totalDurationMs || 0); }, 0) / records.length / 60000).toFixed(1),
    stageAvgRounds: {},
  };

  // ---- Failure hotspot: which stage fails most ----
  var stageFailCounts = {};
  var classificationCounts = {};
  for (var fi = 0; fi < failedRecords.length; fi++) {
    var fr = failedRecords[fi];
    var fStage = fr.failedAtStage || 'unknown';
    stageFailCounts[fStage] = (stageFailCounts[fStage] || 0) + 1;
    var fClass = fr.failClassification || 'unknown';
    classificationCounts[fClass] = (classificationCounts[fClass] || 0) + 1;
  }
  // Sort by count descending
  summary.failureHotspots = Object.keys(stageFailCounts)
    .map(function(k) { return { stage: k, count: stageFailCounts[k], pct: (stageFailCounts[k] / failedRecords.length * 100).toFixed(0) + '%' }; })
    .sort(function(a, b) { return b.count - a.count; });

  summary.failureClassifications = classificationCounts;

  // ---- Bottleneck: stage with highest avg rounds ----
  var bottleneck = { stage: null, avgRounds: 0 };
  ['review', 'compile', 'visual-check', 'cua-verify'].forEach(function(sn) {
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
  var allStages = ['spec-validate', 'codegen', 'review', 'compile', 'visual-check', 'cua-verify', 'upload'];
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
  loadRecords: loadRecords,
};

// CLI: node engine/metrics.cjs [lastN]
if (require.main === module) {
  var lastN = parseInt(process.argv[2]) || 50;
  printDiagnostics(lastN);
}
