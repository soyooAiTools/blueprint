'use strict';

var auditGate = require('./fidelity-audit-gate.cjs');

var REPORT_KIND = 'blueprint.fidelityContract.report';
var REPORT_VERSION = '1.0.0';

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeEvidencePolicy(input) {
  input = input || {};
  var raw = input.evidencePolicy || {};
  return {
    visualRequired: !!(input.requireVisual || raw.visualRequired || raw.visual === 'required'),
    vlmRequired: !!(input.requireVlm || raw.vlmRequired || raw.vlm === 'required')
  };
}

function verdictForEvidence(item) {
  if (!item) return null;
  if (typeof item.passed === 'boolean') return !!item.passed;
  if (typeof item.ok === 'boolean') return !!item.ok;
  if (item.verdict === 'pass' || item.verdict === 'consistent') return true;
  if (item.verdict === 'fail' || item.verdict === 'inconsistent') return false;
  return null;
}

function summarize(audit, roundTrip, visual, vlm, evidencePolicy) {
  evidencePolicy = evidencePolicy || normalizeEvidencePolicy();
  var visualVerdict = verdictForEvidence(visual);
  var vlmVerdictPassed = verdictForEvidence(vlm);
  var visualOk = evidencePolicy.visualRequired ? visualVerdict === true : visualVerdict !== false;
  var vlmOk = evidencePolicy.vlmRequired ? vlmVerdictPassed === true : vlmVerdictPassed !== false;
  return {
    passed: !!(audit && audit.passed) && (roundTrip ? !!roundTrip.passed : true) && visualOk && vlmOk,
    auditPassed: !!(audit && audit.passed),
    roundTripPassed: roundTrip ? !!roundTrip.passed : null,
    visualRequired: !!evidencePolicy.visualRequired,
    visualPassed: visualVerdict,
    visualMissing: !!evidencePolicy.visualRequired && !visual,
    vlmRequired: !!evidencePolicy.vlmRequired,
    vlmPassed: vlmVerdictPassed,
    vlmMissing: !!evidencePolicy.vlmRequired && !vlm,
    schemaErrorCount: audit ? audit.schemaErrors.length : 0,
    blockingGapCount: audit ? audit.blockingGaps.length : 0,
    unresolvedConflictCount: audit ? audit.unresolvedConflicts.length : 0,
    missingCapabilityCount: audit ? audit.missingCapabilities.length : 0,
    unityCoverageFailure: !!(audit && audit.unityCoverageFailure),
    roundTripDiffCount: roundTrip ? roundTrip.diffCount : null,
    visualDiffMaxPercent: visual ? visual.maxPercent : null,
    vlmVerdict: vlm ? vlm.verdict : null
  };
}

function buildFidelityReport(input) {
  input = input || {};
  var contract = input.contract || null;
  var audit = input.auditResult || null;
  if (!audit) {
    if (!contract) {
      throw new Error('buildFidelityReport requires either contract (+ auditOptions.supportedCapabilities) or precomputed auditResult');
    }
    if (!input.auditOptions || !Array.isArray(input.auditOptions.supportedCapabilities)) {
      throw new Error('buildFidelityReport: auditOptions.supportedCapabilities is required when running audit from contract; pass writer capabilities or supply a precomputed auditResult');
    }
    audit = auditGate.runAuditGate(contract, input.auditOptions);
  }
  var roundTrip = input.roundTrip || null;
  var visual = input.visual || null;
  var vlm = input.vlm || null;
  var evidencePolicy = normalizeEvidencePolicy(input);
  var fixture = input.fixture || (contract && contract.unityCoverage && contract.unityCoverage.source) || null;
  var summary = summarize(audit, roundTrip, visual, vlm, evidencePolicy);
  var json = {
    schemaVersion: REPORT_VERSION,
    kind: REPORT_KIND,
    generatedAt: input.generatedAt || new Date().toISOString(),
    fixture: fixture,
    contractKind: contract && contract.kind || null,
    contractSchemaVersion: contract && contract.schemaVersion || null,
    producerVersion: contract && contract.producerVersion || null,
    summary: summary,
    audit: audit,
    roundTrip: roundTrip,
    visual: visual,
    vlm: vlm,
    evidencePolicy: evidencePolicy,
    advisoryNotes: safeArray(input.advisoryNotes)
  };
  return { json: json, html: renderHtml(json) };
}

function renderListSection(title, items, formatter, emptyText) {
  if (!items || !items.length) {
    return '<section><h2>' + escapeHtml(title) + '</h2><p class="ok">' + escapeHtml(emptyText) + '</p></section>';
  }
  var rows = items.map(function(item) {
    return '<li>' + formatter(item) + '</li>';
  }).join('');
  return '<section><h2>' + escapeHtml(title) + ' <span class="count fail">' + items.length + '</span></h2><ul>' + rows + '</ul></section>';
}

function formatGap(gap) {
  var bits = [];
  bits.push('<strong>' + escapeHtml(gap.id || '<no-id>') + '</strong>');
  if (gap.path) bits.push('<code>' + escapeHtml(gap.path) + '</code>');
  if (gap.reason) bits.push(escapeHtml(gap.reason));
  if (gap.blocking === false) bits.push('<em>non-blocking</em>');
  return bits.join(' · ');
}

function formatConflict(conflict) {
  var bits = [];
  bits.push('<strong>' + escapeHtml(conflict.id || '<no-id>') + '</strong>');
  if (conflict.path) bits.push('<code>' + escapeHtml(conflict.path) + '</code>');
  var status = conflict.resolution && conflict.resolution.status;
  if (status) bits.push('resolution=' + escapeHtml(status));
  if (conflict.html !== undefined || conflict.unity !== undefined) {
    bits.push('html=' + escapeHtml(JSON.stringify(conflict.html)) + ' vs unity=' + escapeHtml(JSON.stringify(conflict.unity)));
  }
  return bits.join(' · ');
}

function formatCapability(capability) {
  return '<code>' + escapeHtml(capability) + '</code>';
}

function formatSchemaError(error) {
  return '<code>' + escapeHtml(error) + '</code>';
}

function formatRoundTripDiff(diff) {
  return '<code>' + escapeHtml(diff.path) + '</code> expected=' + escapeHtml(JSON.stringify(diff.expected)) + ' actual=' + escapeHtml(JSON.stringify(diff.actual));
}

function renderRoundTripSection(roundTrip) {
  if (!roundTrip) {
    return '<section><h2>Round-trip diff <span class="count pending">pending</span></h2><p>Waiting for Unity writer readback + Tim space-ranger contract output.</p></section>';
  }
  if (roundTrip.passed) {
    return '<section><h2>Round-trip diff</h2><p class="ok">readback diff = 0 ✓</p></section>';
  }
  return renderListSection('Round-trip diff', safeArray(roundTrip.diffs), formatRoundTripDiff, 'no diffs');
}

function renderVisualSection(visual, summary) {
  if (!visual) {
    var cls = summary && summary.visualRequired ? 'fail' : 'pending';
    var label = summary && summary.visualRequired ? 'required missing' : 'advisory pending';
    return '<section><h2>Visual diff <span class="count ' + cls + '">' + label + '</span></h2><p>Per-phase screenshot comparison after hard gate passes.</p></section>';
  }
  var visualVerdict = verdictForEvidence(visual);
  var verdictClass = visualVerdict === false ? 'fail' : (visualVerdict === true ? 'ok' : 'advisory');
  var verdictText = visualVerdict === null ? 'advisory' : (visualVerdict ? 'pass' : 'fail');
  var rows = safeArray(visual.phases).map(function(phase) {
    return '<tr><td>' + escapeHtml(phase.id) + '</td><td>' + escapeHtml(String(phase.diffPercent)) + '%</td><td>' + escapeHtml(phase.verdict || '') + '</td></tr>';
  }).join('');
  var note = visual.reason ? '<p class="' + verdictClass + '">' + escapeHtml(visual.reason) + '</p>' : '';
  return '<section><h2>Visual diff <span class="count ' + verdictClass + '">' + escapeHtml(verdictText) + ' · ' + escapeHtml(String(visual.maxPercent || 0)) + '% max</span></h2>' + note + '<table><thead><tr><th>phase</th><th>diff%</th><th>verdict</th></tr></thead><tbody>' + rows + '</tbody></table></section>';
}

function renderVlmSection(vlm, summary) {
  if (!vlm) {
    var cls = summary && summary.vlmRequired ? 'fail' : 'pending';
    var label = summary && summary.vlmRequired ? 'required missing' : 'pending';
    return '<section><h2>VLM advisory <span class="count ' + cls + '">' + label + '</span></h2><p>Human-readable cross-check sample after hard gate passes.</p></section>';
  }
  return '<section><h2>VLM advisory</h2><p class="' + (vlm.verdict === 'consistent' ? 'ok' : 'warn') + '">' + escapeHtml(vlm.verdict) + ': ' + escapeHtml(vlm.note || '') + '</p></section>';
}

function renderUnityCoverageSection(audit) {
  if (!audit) return '';
  var status = audit.unityCoverageStatus || 'unknown';
  var cls = audit.unityCoverageFailure ? 'fail' : (status === 'complete' ? 'ok' : 'warn');
  return '<section><h2>Unity coverage</h2><p class="' + cls + '">status=' + escapeHtml(status) + (audit.unityCoverageFailure ? ' (blocks unity writer)' : '') + '</p></section>';
}

function renderSummary(json) {
  var summary = json.summary;
  var verdict = summary.passed ? '<span class="ok">PASS</span>' : '<span class="fail">FAIL</span>';
  return '<header><h1>Fidelity Contract Report</h1>' +
    '<p>Verdict ' + verdict + ' · audit=' + (summary.auditPassed ? '✓' : '✗') +
    ' · roundTrip=' + (summary.roundTripPassed === null ? 'pending' : (summary.roundTripPassed ? '✓' : '✗')) +
    ' · visual=' + (summary.visualPassed === null ? (summary.visualRequired ? 'missing' : 'pending') : (summary.visualPassed ? '✓' : '✗')) +
    ' · gaps=' + summary.blockingGapCount +
    ' · conflicts=' + summary.unresolvedConflictCount +
    ' · missingCaps=' + summary.missingCapabilityCount + '</p>' +
    '<p>Fixture: ' + escapeHtml(json.fixture || 'unknown') + ' · producer=' + escapeHtml(json.producerVersion || '?') +
    ' · generated=' + escapeHtml(json.generatedAt) + '</p></header>';
}

function renderAdvisorySection(notes) {
  if (!notes.length) return '';
  var items = notes.map(function(note) { return '<li>' + escapeHtml(note) + '</li>'; }).join('');
  return '<section><h2>Advisory notes</h2><ul>' + items + '</ul></section>';
}

function renderHtml(json) {
  var audit = json.audit || { schemaErrors: [], blockingGaps: [], unresolvedConflicts: [], missingCapabilities: [] };
  var body = [
    renderSummary(json),
    renderListSection('Schema errors', audit.schemaErrors, formatSchemaError, 'schema valid'),
    renderListSection('Blocking gaps', audit.blockingGaps, formatGap, 'no blocking gaps'),
    renderListSection('Unresolved conflicts', audit.unresolvedConflicts, formatConflict, 'no unresolved conflicts'),
    renderListSection('Missing capabilities', audit.missingCapabilities, formatCapability, 'all required capabilities supported'),
    renderUnityCoverageSection(audit),
    renderRoundTripSection(json.roundTrip),
    renderVisualSection(json.visual, json.summary),
    renderVlmSection(json.vlm, json.summary),
    renderAdvisorySection(json.advisoryNotes)
  ].join('\n');
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fidelity Report' +
    (json.fixture ? ' · ' + escapeHtml(json.fixture) : '') +
    '</title><style>' +
    'body{font-family:system-ui,-apple-system,sans-serif;max-width:960px;margin:24px auto;padding:0 16px;color:#111}' +
    'header{border-bottom:1px solid #ddd;padding-bottom:12px;margin-bottom:16px}' +
    'section{margin:16px 0;padding:12px;border:1px solid #eee;border-radius:6px}' +
    'h1{margin:0 0 8px}h2{margin:0 0 8px;font-size:1.05rem}' +
    'code{font-family:ui-monospace,Consolas,monospace;background:#f6f6f6;padding:1px 4px;border-radius:3px}' +
    'ul{margin:0;padding-left:20px}li{margin:4px 0}' +
    'table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:4px 8px;text-align:left}' +
    '.ok{color:#0a7a2a}.fail{color:#b00020;font-weight:600}.warn{color:#a36400}.pending{color:#666}.advisory{color:#a36400}' +
    '.count{font-size:0.85rem;font-weight:600;margin-left:6px}' +
    '</style></head><body>' + body + '</body></html>';
}

module.exports = {
  REPORT_KIND: REPORT_KIND,
  REPORT_VERSION: REPORT_VERSION,
  buildFidelityReport: buildFidelityReport,
  _internals: {
    summarize: summarize,
    normalizeEvidencePolicy: normalizeEvidencePolicy,
    verdictForEvidence: verdictForEvidence,
    renderHtml: renderHtml,
    escapeHtml: escapeHtml
  }
};
