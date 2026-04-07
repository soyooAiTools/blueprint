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
    stages: {},
  };

  var stageNames = ['spec-validate', 'codegen', 'review', 'compile', 'visual-check', 'cua-verify', 'upload'];
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
  }

  try {
    fs.appendFileSync(METRICS_FILE, JSON.stringify(record) + '\n');
  } catch(e) {}

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

  // ---- Top failure reasons (deduplicated) ----
  var reasonCounts = {};
  for (var ri = 0; ri < failedRecords.length; ri++) {
    var reason = failedRecords[ri].failReason;
    if (!reason) continue;
    // Normalize: take first 100 chars
    var key = reason.substring(0, 100);
    reasonCounts[key] = (reasonCounts[key] || 0) + 1;
  }
  summary.topFailReasons = Object.keys(reasonCounts)
    .map(function(k) { return { reason: k, count: reasonCounts[k] }; })
    .sort(function(a, b) { return b.count - a.count; })
    .slice(0, 5);

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

module.exports = { recordPipelineMetrics: recordPipelineMetrics, getMetricsSummary: getMetricsSummary, printDiagnostics: printDiagnostics };

// CLI: node engine/metrics.cjs [lastN]
if (require.main === module) {
  var lastN = parseInt(process.argv[2]) || 50;
  printDiagnostics(lastN);
}
