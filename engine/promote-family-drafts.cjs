#!/usr/bin/env node
/**
 * Promote top failure families from runtime metrics into draft knowledge items.
 *
 * Unlike pending-fixes/pending-rules (signal-level), this produces family-level
 * governance drafts so recurring clusters like review.nonconverging_structural
 * or infra.schema_backend can be reviewed as first-class knowledge assets.
 */

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var metrics = require('./metrics.cjs');

var REPO_ROOT = path.join(__dirname, '..');
var LEARNING_ROOT = process.env.BLUEPRINT_LEARNING_REPO || '/opt/blueprint-learning';
var DRAFTS_ROOT = path.join(LEARNING_ROOT, 'drafts', 'failure-families');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function sha(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 10);
}

function readPlaybookCatalog() {
  var dashboardApi = require('../api/dashboard.cjs');
  if (typeof dashboardApi.init !== 'function') return {};
  // We only need the catalog metadata, not the initialized handlers.
  // Duplicate the mapping here intentionally avoided; instead, use a tiny
  // local static fallback for robustness.
  return {};
}

function defaultOwner(family) {
  if (/^infra\./.test(family)) return 'infrastructure';
  if (/^review\./.test(family)) return 'review/static-check';
  if (/^cua\./.test(family)) return 'cua';
  if (/^monitor\./.test(family)) return 'night-monitor';
  if (/^schema\./.test(family)) return 'schema';
  if (/^codegen\./.test(family) || /^generation\./.test(family)) return 'codegen';
  if (/^method_check\./.test(family)) return 'method-check';
  if (/^complexity_gate\./.test(family)) return 'complexity-gate';
  return 'triage';
}

function defaultRemedy(family) {
  var map = {
    'infra.schema_backend': 'Add backend fallback, health checks, and early infra classification.',
    'codegen.marker_coverage': 'Protect template fill output and validate combined split files before codegen passes.',
    'schema.invalid_trigger_shape': 'Normalize invalid trigger JSON deterministically before schema validation.',
    'method_check.partial_visibility': 'Scan main + companion partial files and ignore comment ghosts.',
    'review.nonconverging_structural': 'Convert recurring structural review failures into deterministic static guards.',
    'review.main_file_reintroduced_phase_logic': 'Block phase/helper logic from being written back into GameFlowManagerMain.cs.',
    'review.forbidden_init_material_from_scene': 'Reject obsolete Luna material init calls before review.',
    'review.phase_condition_false_literal': 'Reject dead phase gates before review/compile.',
    'cua.observe_protocol': 'Use observer-ready handshake and early fatal exit for protocol failures.',
    'monitor.stuck_or_timeout': 'Detect stuck processing/review states and cancel+resubmit with escalation.',
    'complexity_gate.bad_simplify_json': 'Use balanced JSON extraction and repair for simplify responses.',
    'cua.silent_pass': 'Strengthen semantic silent-pass detection and event-centered verification.',
    'infra.model_fatal': 'Improve provider failover and auth/quota isolation.',
  };
  return map[family] || 'Classify root cause and promote deterministic prevention where possible.';
}

function buildDraft(summaryItem) {
  var family = summaryItem.family;
  return {
    id: 'draft-family-' + sha(family),
    sourceType: 'failure-family',
    status: 'candidate',
    title: 'Draft family: ' + family,
    category: family.split('.')[0] || 'systemic',
    layer: ['dashboard', 'metrics', 'learning'],
    severity: (summaryItem.count || 0) >= 5 ? 'high' : 'medium',
    symptom: 'Recurring failure family observed in runtime metrics: ' + family,
    rootCause: 'Derived from aggregated pipeline metrics and fingerprint family classification.',
    suggestedAction: defaultRemedy(family),
    owner: defaultOwner(family),
    evidence: {
      family: family,
      count: summaryItem.count || 0,
      pct: summaryItem.pct || '0%',
      wastedMinutes: summaryItem.wastedMinutes || '0.0',
      sampleFingerprints: summaryItem.sampleFingerprints || [],
    },
    proposedAsset: {
      kind: 'family-playbook',
      recommendedPathPrefix: 'rules/' + (family.split('.')[0] || 'systemic')
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function promoteFamilyDrafts() {
  var summary = metrics.getMetricsSummary(100);
  var families = summary.failureFamilies || [];
  var wasteIndex = {};
  (summary.wasteByFamily || []).forEach(function(item) {
    wasteIndex[item.family] = item.minutes;
  });
  var fpByFamily = {};
  (summary.topFailReasons || []).forEach(function(item) {
    var fakeRecord = { failedAtStage: item.failedAtStage, failReason: item.sampleReason };
    var family = metrics.classifyFailureFamily(fakeRecord);
    if (!fpByFamily[family]) fpByFamily[family] = [];
    fpByFamily[family].push(item.fingerprint);
  });

  var drafts = families.slice(0, 8).map(function(item) {
    return buildDraft({
      family: item.family,
      count: item.count,
      pct: item.pct,
      wastedMinutes: wasteIndex[item.family] || '0.0',
      sampleFingerprints: (fpByFamily[item.family] || []).slice(0, 3),
    });
  });

  ensureDir(DRAFTS_ROOT);
  var manifest = [];
  drafts.forEach(function(item) {
    var file = path.join(DRAFTS_ROOT, item.id + '.json');
    writeJson(file, item);
    manifest.push({
      id: item.id,
      title: item.title,
      family: item.evidence.family,
      severity: item.severity,
      file: path.relative(LEARNING_ROOT, file)
    });
  });
  writeJson(path.join(DRAFTS_ROOT, 'index.json'), {
    updatedAt: new Date().toISOString(),
    count: manifest.length,
    items: manifest
  });
  console.log(JSON.stringify({
    promotedAt: new Date().toISOString(),
    targetRepo: LEARNING_ROOT,
    count: manifest.length
  }, null, 2));
}

if (require.main === module) promoteFamilyDrafts();

module.exports = {
  promoteFamilyDrafts: promoteFamilyDrafts
};
