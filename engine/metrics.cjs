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

function getMetricsSummary(lastN) {
  lastN = lastN || 50;
  try {
    var data = fs.readFileSync(METRICS_FILE, 'utf-8').trim();
    if (!data) return { totalRuns: 0 };
    var lines = data.split('\n');
    var records = lines.slice(-lastN).map(function(l) {
      try { return JSON.parse(l); } catch(e) { return null; }
    }).filter(Boolean);

    if (records.length === 0) return { totalRuns: 0 };

    var successCount = records.filter(function(r) { return r.success; }).length;
    var summary = {
      totalRuns: records.length,
      successRate: (successCount / records.length * 100).toFixed(1) + '%',
      avgDurationMin: (records.reduce(function(a, r) { return a + (r.totalDurationMs || 0); }, 0) / records.length / 60000).toFixed(1),
      stageAvgRounds: {},
    };

    // Per-stage average rounds
    ['review', 'compile', 'visual-check', 'cua-verify'].forEach(function(sn) {
      var rounds = records.map(function(r) { return r.stages[sn] ? r.stages[sn].rounds : 0; }).filter(function(r) { return r > 0; });
      if (rounds.length > 0) {
        summary.stageAvgRounds[sn] = (rounds.reduce(function(a, b) { return a + b; }, 0) / rounds.length).toFixed(1);
      }
    });

    // Phase coverage first-pass rate
    var coverageRecords = records.filter(function(r) { return r.firstPassPhaseCoverage; });
    if (coverageRecords.length > 0) {
      var fullCoverage = coverageRecords.filter(function(r) {
        var parts = r.firstPassPhaseCoverage.split('/');
        return parts[0] === parts[1];
      }).length;
      summary.codegenFirstPassFullCoverage = (fullCoverage / coverageRecords.length * 100).toFixed(1) + '%';
    }

    // Warning-only pass rate
    var reviewRecords = records.filter(function(r) { return r.reviewWarningOnly !== undefined; });
    if (reviewRecords.length > 0) {
      var warningOnly = reviewRecords.filter(function(r) { return r.reviewWarningOnly; }).length;
      summary.reviewWarningOnlyRate = (warningOnly / reviewRecords.length * 100).toFixed(1) + '%';
    }

    return summary;
  } catch(e) {
    return { error: e.message };
  }
}

module.exports = { recordPipelineMetrics: recordPipelineMetrics, getMetricsSummary: getMetricsSummary };
