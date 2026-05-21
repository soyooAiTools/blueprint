/**
 * Module Gap Ledger
 *
 * Converts LLM intervention points into structured module-gap records.
 * This is intentionally observational: it must not change pipeline routing.
 */

var fs = require('fs');
var path = require('path');

var METRICS_DIR = path.join(__dirname, '..', 'server-data', 'metrics');
var DEFAULT_LEDGER_FILE = path.join(METRICS_DIR, 'module-gap-ledger.jsonl');
var DEFAULT_METRICS_FILE = path.join(METRICS_DIR, 'pipeline-metrics.jsonl');

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniq(values) {
  var seen = {};
  var out = [];
  toArray(values).forEach(function(value) {
    var key = String(value || '').trim();
    if (!key || seen[key]) return;
    seen[key] = true;
    out.push(key);
  });
  return out;
}

function countMapAdd(map, key, amount) {
  key = String(key || 'unknown');
  map[key] = (map[key] || 0) + (amount || 1);
}

function parseTime(value) {
  var ms = Date.parse(value || '');
  return isFinite(ms) ? ms : null;
}

function truncate(text, maxLen) {
  text = String(text || '').replace(/\s+/g, ' ').trim();
  maxLen = maxLen || 240;
  return text.length > maxLen ? text.slice(0, maxLen) : text;
}

function topEntries(map, limit) {
  return Object.keys(map || {})
    .sort(function(a, b) { return map[b] - map[a] || a.localeCompare(b); })
    .slice(0, limit || 10)
    .map(function(key) { return { key: key, count: map[key] }; });
}

function stageRounds(record, stage) {
  var stages = record && record.stages || {};
  var sr = stages[stage] || {};
  var n = Number(sr.rounds || 0);
  return isFinite(n) ? n : 0;
}

function inferGapTypeFromCustomLogicRoute(record) {
  var route = String(record && record.customLogicRoute || '');
  if (route === 'runner_unresolved') return 'missing_atom_or_registry_mapping';
  if (route === 'runner_implementation_gap') return 'missing_emitter';
  if (route === 'runner_coverage_gap') return 'coverage_gate_gap';
  if (route === 'runner_no_assembly_plan') return 'missing_assembly_plan';
  if (route === 'none' || route === 'deterministic_suppressed') return null;
  if (record && record.customLogicUsed) return 'custom_logic_fallback';
  return null;
}

function inferCuaGapType(record) {
  if (record && (record.cuaSilentPass === true || toArray(record.cuaSilentPassSignals).length > 0)) {
    return 'missing_semantic_assertion';
  }
  var hay = [
    record && record.cuaRootCause,
    record && record.cuaReason,
    record && record.failReason,
    toArray(record && record.cuaSilentPassSignals).join(' '),
  ].join(' ').toLowerCase();
  if (/missing.*signal|signal.*missing|signal-validation|unsupported.*signal/.test(hay)) return 'missing_runtime_evidence';
  if (/autoplay-zero-steps|autoplay|idle/.test(hay)) return 'missing_cua_probe_or_autoplay_mapping';
  if (/visual freeze|screenshot sharing|batch completion|pre-contamination/.test(hay)) return 'missing_visual_progress_contract';
  if (/phase:progress|stuck phase|no progress|time limit/.test(hay)) return 'missing_phase_progress_contract';
  if (/silent-pass/.test(hay)) return 'missing_semantic_assertion';
  return 'cua_repair_fallback';
}

function inferCuaGapReason(record) {
  if (!record) return 'CUA required repair or emitted validation signal';
  if (record.cuaRootCause) return record.cuaRootCause;
  var silentSignals = toArray(record.cuaSilentPassSignals);
  if (record.cuaSilentPass === true || silentSignals.length > 0) {
    return 'silent-pass signals: ' + (silentSignals.length > 0 ? silentSignals.join(',') : 'unknown');
  }
  if (record.cuaReason && record.cuaReason !== 'runtime-contract-passed') return record.cuaReason;
  return record.failReason || 'CUA required repair or emitted validation signal';
}

function makeBaseEntry(record, source, gapType, detail) {
  detail = detail || {};
  var stage = detail.stage || null;
  return {
    timestamp: record.timestamp || new Date().toISOString(),
    taskId: record.taskId || null,
    source: source,
    gapType: gapType,
    stage: stage,
    confidence: detail.confidence || 'medium',
    route: detail.route || null,
    reason: truncate(detail.reason || record.failReason || record.cuaReason || record.customLogicRouteReason || ''),
    moduleIds: uniq(detail.moduleIds || record.assemblyImplementationMissingModuleIds || []),
    codeTokenIn: Number(detail.codeTokenIn || 0) || 0,
    planTokenIn: Number(detail.planTokenIn || 0) || 0,
    metadata: detail.metadata || {},
  };
}

function createGapEntriesFromRecord(record) {
  if (!record || typeof record !== 'object') return [];
  var entries = [];

  var planTokenIn = Number(record.schemaTokensIn || 0) || 0;
  var codeTokenIn = Number(record.customLogicTokensIn || 0) || 0;
  var customGapType = inferGapTypeFromCustomLogicRoute(record);
  var route = record.customLogicRoute || null;
  var customLogicTriggered = !!record.customLogicUsed ||
    (route && route !== 'none' && route !== 'deterministic_suppressed');

  if (customGapType && customLogicTriggered) {
    entries.push(makeBaseEntry(record, 'custom_logic', customGapType, {
      stage: 'codegen',
      confidence: route === 'runner_implementation_gap' || route === 'runner_unresolved' ? 'high' : 'medium',
      route: route,
      reason: record.customLogicRouteReason || 'customLogic fallback used',
      moduleIds: record.assemblyImplementationMissingModuleIds || [],
      codeTokenIn: codeTokenIn,
      planTokenIn: planTokenIn,
      metadata: {
        customLogicRounds: record.customLogicRounds || 0,
        customLogicScopeFixCount: record.customLogicScopeFixCount || 0,
        assemblyCoverage: record.assemblyCoverage,
        assemblyImplementationCoverage: record.assemblyImplementationCoverage,
        assemblyUnresolvedCount: record.assemblyUnresolvedCount,
      },
    }));
  }

  if ((record.assemblyImplementationMissingCount || 0) > 0) {
    entries.push(makeBaseEntry(record, 'implementation_coverage', 'missing_emitter', {
      stage: 'assembly-complexity-gate',
      confidence: 'high',
      reason: 'assembly implementation missing: ' + uniq(record.assemblyImplementationMissingModuleIds || []).join(','),
      moduleIds: record.assemblyImplementationMissingModuleIds || [],
      planTokenIn: planTokenIn,
      metadata: {
        missingCount: record.assemblyImplementationMissingCount,
        implementationCoverage: record.assemblyImplementationCoverage,
      },
    }));
  }

  if ((record.assemblyUnresolvedCount || 0) > 0) {
    entries.push(makeBaseEntry(record, 'assembly_unresolved', 'missing_atom_or_registry_mapping', {
      stage: 'assembly-plan',
      confidence: 'high',
      reason: 'assembly unresolved count=' + record.assemblyUnresolvedCount,
      planTokenIn: planTokenIn,
      metadata: {
        unresolvedCount: record.assemblyUnresolvedCount,
        assemblyCoverage: record.assemblyCoverage,
      },
    }));
  }

  var compileRounds = stageRounds(record, 'compile');
  if (compileRounds > 1) {
    entries.push(makeBaseEntry(record, 'coder_repair', 'compile_recode_or_repair', {
      stage: 'compile',
      confidence: 'medium',
      reason: 'compile required ' + compileRounds + ' rounds',
      codeTokenIn: 0,
      metadata: { rounds: compileRounds },
    }));
  }

  var reviewRounds = record.reviewRounds || stageRounds(record, 'review');
  if (reviewRounds > 1) {
    entries.push(makeBaseEntry(record, 'review_repair', 'review_recode_or_patch', {
      stage: 'review',
      confidence: 'medium',
      reason: 'review required ' + reviewRounds + ' rounds',
      codeTokenIn: 0,
      metadata: { rounds: reviewRounds, warningOnly: !!record.reviewWarningOnly },
    }));
  }

  var cuaRounds = record.cuaRounds || stageRounds(record, 'cua-verify');
  var cuaNeedsGap = cuaRounds > 1 ||
    record.failedAtStage === 'cua-verify' ||
    (record.cuaMissingSignalCount || 0) > 0 ||
    (record.cuaUnsupportedSignalCount || 0) > 0 ||
    record.cuaSignalValidationPassed === false ||
    record.cuaSilentPass === true;
  if (cuaNeedsGap) {
    entries.push(makeBaseEntry(record, 'cua_repair', inferCuaGapType(record), {
      stage: 'cua-verify',
      confidence: record.failedAtStage === 'cua-verify' ? 'high' : 'medium',
      reason: inferCuaGapReason(record),
      metadata: {
        rounds: cuaRounds,
        missingSignalCount: record.cuaMissingSignalCount || 0,
        unsupportedSignalCount: record.cuaUnsupportedSignalCount || 0,
        silentPassSignals: record.cuaSilentPassSignals || [],
        rootCause: record.cuaRootCause || '',
        stuckPhase: record.cuaStuckPhase || '',
      },
    }));
  }

  if ((record.runtimeContractMissingSignalCount || 0) > 0 ||
      (record.runtimeContractUnsupportedSignalCount || 0) > 0 ||
      record.runtimeContractSignalValidationPassed === false) {
    entries.push(makeBaseEntry(record, 'runtime_contract', 'missing_runtime_evidence', {
      stage: 'runtime-contract',
      confidence: 'high',
      reason: record.runtimeContractDefaultInteractionReason || 'runtime contract signal validation failed',
      metadata: {
        missingSignalCount: record.runtimeContractMissingSignalCount || 0,
        unsupportedSignalCount: record.runtimeContractUnsupportedSignalCount || 0,
        silentPassSignals: record.runtimeContractSilentPassSignals || [],
      },
    }));
  }

  return entries;
}

function appendEntries(entries, opts) {
  entries = toArray(entries);
  if (entries.length === 0) return 0;
  opts = opts || {};
  var file = opts.file || DEFAULT_LEDGER_FILE;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  var text = entries.map(function(entry) {
    return JSON.stringify(entry);
  }).join('\n') + '\n';
  fs.appendFileSync(file, text);
  return entries.length;
}

function recordModuleGapsFromPipelineRecord(record, opts) {
  var entries = createGapEntriesFromRecord(record);
  appendEntries(entries, opts);
  return entries;
}

function readJsonl(file) {
  try {
    var data = fs.readFileSync(file, 'utf-8').trim();
    if (!data) return [];
    return data.split('\n').map(function(line) {
      try { return JSON.parse(line); } catch(e) { return null; }
    }).filter(Boolean);
  } catch(e) {
    return [];
  }
}

function loadGapEntries(opts) {
  opts = opts || {};
  var file = opts.file || DEFAULT_LEDGER_FILE;
  var entries = readJsonl(file);
  return filterEntries(entries, opts);
}

function filterEntries(entries, opts) {
  opts = opts || {};
  var sinceMs = null;
  if (opts.since) sinceMs = parseTime(opts.since);
  if (!sinceMs && opts.days) sinceMs = Date.now() - Number(opts.days) * 24 * 60 * 60 * 1000;
  if (sinceMs) {
    entries = entries.filter(function(entry) {
      var ms = parseTime(entry.timestamp);
      return ms == null || ms >= sinceMs;
    });
  }
  if (opts.lastN && entries.length > opts.lastN) {
    entries = entries.slice(-opts.lastN);
  }
  return entries;
}

function loadPipelineRecords(opts) {
  opts = opts || {};
  var records = readJsonl(opts.metricsFile || DEFAULT_METRICS_FILE);
  return filterEntries(records, opts);
}

function buildGapEntriesFromMetrics(opts) {
  var records = loadPipelineRecords(opts);
  var entries = [];
  records.forEach(function(record) {
    entries = entries.concat(createGapEntriesFromRecord(record));
  });
  return entries;
}

function summarizeModuleGaps(entries) {
  entries = toArray(entries);
  var bySource = {};
  var byGapType = {};
  var byStage = {};
  var byRoute = {};
  var byModule = {};
  var byReason = {};
  var taskIds = {};
  var planTokenIn = 0;
  var codeTokenIn = 0;

  entries.forEach(function(entry) {
    countMapAdd(bySource, entry.source);
    countMapAdd(byGapType, entry.gapType);
    countMapAdd(byStage, entry.stage || 'unknown');
    if (entry.route) countMapAdd(byRoute, entry.route);
    toArray(entry.moduleIds).forEach(function(moduleId) { countMapAdd(byModule, moduleId); });
    if (entry.reason) countMapAdd(byReason, entry.reason);
    if (entry.taskId) taskIds[entry.taskId] = true;
    planTokenIn += Number(entry.planTokenIn || 0) || 0;
    codeTokenIn += Number(entry.codeTokenIn || 0) || 0;
  });

  return {
    totalGaps: entries.length,
    taskCount: Object.keys(taskIds).length,
    planTokenIn: planTokenIn,
    codeTokenIn: codeTokenIn,
    codeTokenPerTask: Object.keys(taskIds).length > 0 ? codeTokenIn / Object.keys(taskIds).length : 0,
    bySource: topEntries(bySource, 20),
    byGapType: topEntries(byGapType, 20),
    byStage: topEntries(byStage, 20),
    byRoute: topEntries(byRoute, 20),
    topModules: topEntries(byModule, 20),
    topReasons: topEntries(byReason, 20),
  };
}

function getModuleGapReport(opts) {
  opts = opts || {};
  var source = opts.source || 'metrics';
  var entries = source === 'ledger'
    ? loadGapEntries(opts)
    : buildGapEntriesFromMetrics(opts);
  return {
    source: source,
    days: opts.days || null,
    generatedAt: new Date().toISOString(),
    entries: entries,
    summary: summarizeModuleGaps(entries),
  };
}

function printReport(report) {
  var s = report.summary;
  console.log('Module Gap Report');
  console.log('source=' + report.source + (report.days ? ' days=' + report.days : '') + ' generatedAt=' + report.generatedAt);
  console.log('totalGaps=' + s.totalGaps + ' taskCount=' + s.taskCount +
    ' codeTokenIn=' + s.codeTokenIn + ' planTokenIn=' + s.planTokenIn +
    ' codeTokenPerTask=' + s.codeTokenPerTask.toFixed(1));
  function section(title, rows) {
    console.log('\n' + title);
    if (!rows || rows.length === 0) {
      console.log('  (none)');
      return;
    }
    rows.forEach(function(row) {
      console.log('  ' + row.key + ': ' + row.count);
    });
  }
  section('By Source', s.bySource);
  section('By Gap Type', s.byGapType);
  section('By Route', s.byRoute);
  section('Top Modules', s.topModules);
  section('Top Reasons', s.topReasons.slice(0, 8));
}

function parseCliArgs(argv) {
  var opts = { source: 'metrics', days: 30, json: false };
  for (var i = 0; i < argv.length; i++) {
    var arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--ledger') opts.source = 'ledger';
    else if (arg === '--metrics') opts.source = 'metrics';
    else if (arg === '--days') opts.days = Number(argv[++i] || 30);
    else if (arg === '--metrics-file') opts.metricsFile = argv[++i];
    else if (arg === '--ledger-file') opts.file = argv[++i];
    else if (arg === '--last') opts.lastN = Number(argv[++i] || 0);
  }
  return opts;
}

if (require.main === module) {
  var opts = parseCliArgs(process.argv.slice(2));
  var report = getModuleGapReport(opts);
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }
}

module.exports = {
  DEFAULT_LEDGER_FILE: DEFAULT_LEDGER_FILE,
  createGapEntriesFromRecord: createGapEntriesFromRecord,
  recordModuleGapsFromPipelineRecord: recordModuleGapsFromPipelineRecord,
  loadGapEntries: loadGapEntries,
  buildGapEntriesFromMetrics: buildGapEntriesFromMetrics,
  summarizeModuleGaps: summarizeModuleGaps,
  getModuleGapReport: getModuleGapReport,
};
