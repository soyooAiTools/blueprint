#!/usr/bin/env node
/**
 * Promote top-priority failure families into governance-task drafts.
 *
 * These drafts are action-oriented: they answer "what should we do next" for
 * each P0/P1 family, rather than just recording that the family exists.
 */

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var metrics = require('./metrics.cjs');

var LEARNING_ROOT = process.env.BLUEPRINT_LEARNING_REPO || '/opt/blueprint-learning';
var OUTPUT_ROOT = path.join(LEARNING_ROOT, 'drafts', 'governance-tasks');

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

function classifyAction(owner, family) {
  if (owner === 'static-check') return 'add-deterministic-guard';
  if (owner === 'review/static-check') return 'promote-structural-rule';
  if (owner === 'infrastructure') return 'add-fallback-or-health-guard';
  if (owner === 'night-monitor') return 'improve-monitor-recovery';
  if (owner === 'schema') return 'tighten-schema-normalizer';
  if (owner === 'method-check') return 'tighten-partial-scan';
  if (owner === 'complexity-gate') return 'repair-parser';
  if (/^cua/.test(owner)) return 'tighten-observe-protocol';
  if (/^codegen/.test(owner)) return 'tighten-codegen-guard';
  if (/review\.nonconverging_structural/.test(family)) return 'promote-structural-rule';
  return 'triage-and-classify';
}

function suggestedTargets(owner, family) {
  var targets = [];
  if (family === 'infra.schema_backend') {
    targets.push({ type: 'file', path: '/opt/blueprint-editor/engine/stages/codegen-schema.cjs', why: 'schema backend fallback / infra classification' });
    targets.push({ type: 'file', path: '/opt/blueprint-editor/engine/error-classifier.cjs', why: 'classify schema relay failures as infra early' });
    targets.push({ type: 'file', path: '/opt/blueprint-editor/engine/night-monitor.cjs', why: 'escalate repeated infra failures instead of blind resubmit' });
  } else if (family === 'codegen.marker_coverage') {
    targets.push({ type: 'file', path: '/opt/blueprint-editor/engine/stages/codegen-schema.cjs', why: 'combined marker coverage for split outputs' });
    targets.push({ type: 'file', path: '/opt/blueprint-editor/adapters/skeleton-generator.cjs', why: 'preserve TODO markers across split generation' });
    targets.push({ type: 'rule', path: 'rules/pipeline/template-marker-coverage.json', why: 'curate long-lived prevention rule' });
  } else if (family === 'method_check.partial_visibility') {
    targets.push({ type: 'file', path: '/opt/blueprint-editor/engine/stages/method-check.cjs', why: 'scan main + extraFiles and ignore comment ghosts' });
    targets.push({ type: 'draft', path: 'drafts/failure-families/draft-family-7dc119c07b.json', why: 'family-level draft already exists' });
  } else if (family === 'review.nonconverging_structural') {
    targets.push({ type: 'file', path: '/opt/blueprint-editor/engine/static-check.cjs', why: 'promote recurring structural criticals to deterministic guards' });
    targets.push({ type: 'file', path: '/opt/blueprint-editor/engine/stages/review.cjs', why: 'stop repeated same-fingerprint fix loops earlier' });
    targets.push({ type: 'regression', path: 'regressions/aborted-same-code-error-repeated-n-rounds-fix-loop-not-converging-review-blocked/meta.json', why: 'existing regression archive' });
  } else if (family === 'schema.invalid_trigger_shape') {
    targets.push({ type: 'file', path: '/opt/blueprint-editor/engine/stages/codegen-schema.cjs', why: 'tighten deterministic trigger normalizer' });
    targets.push({ type: 'draft', path: 'drafts/failure-families/', why: 'promote family draft once generated' });
  } else if (family === 'monitor.stuck_or_timeout') {
    targets.push({ type: 'file', path: '/opt/blueprint-editor/engine/night-monitor.cjs', why: 'stuck detection / recovery policy' });
    targets.push({ type: 'file', path: '/opt/blueprint-editor/dashboard.html', why: 'surface stuck/recovery telemetry and priority' });
  } else if (family === 'complexity_gate.bad_simplify_json') {
    targets.push({ type: 'file', path: '/opt/blueprint-editor/engine/stages/complexity-gate.cjs', why: 'balanced JSON extraction and repair' });
  } else {
    targets.push({ type: 'owner', path: owner, why: 'needs explicit target mapping' });
  }
  return targets;
}

function draftForPriority(item) {
  return {
    id: 'draft-governance-' + sha(item.family),
    sourceType: 'governance-task',
    status: 'candidate',
    title: 'Governance task: ' + item.family,
    priority: item.priority,
    owner: item.owner,
    action: classifyAction(item.owner, item.family),
    suggestedTargets: suggestedTargets(item.owner, item.family),
    symptom: 'Top priority failure family from runtime metrics',
    rootCause: item.family,
    suggestedAction: item.remedy,
    evidence: {
      family: item.family,
      count: item.count,
      pct: item.pct,
      wasteMinutes: item.wasteMinutes,
      knowledgeCoverage: item.knowledgeCoverage,
      hasDraft: item.hasDraft,
      draftFile: item.draftFile || null,
      reason: item.reason,
    },
    proposedAsset: {
      kind: 'governance-task',
      recommendedPathPrefix: 'incidents/governance'
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function promoteGovernanceDrafts() {
  var summary = metrics.getMetricsSummary(100);
  var priorities = summary.failureFamilies || [];
  var wasteIndex = {};
  (summary.wasteByFamily || []).forEach(function(item) { wasteIndex[item.family] = parseFloat(item.minutes || '0') || 0; });

  // Rebuild the same priority heuristics used by dashboard so the draft layer
  // stays deterministic even when run headless from night-monitor.
  var top = priorities.map(function(item) {
    var family = item.family;
    var wasteMinutes = wasteIndex[family] || 0;
    var knowledgeCovered = false;
    var hasDraft = false;
    if (family === 'codegen.marker_coverage') knowledgeCovered = true;
    if (family === 'review.nonconverging_structural') hasDraft = true;
    var owner = 'triage';
    var remedy = '分类并补充治理方案';
    if (family === 'infra.schema_backend') { owner = 'infrastructure'; remedy = 'Add backend fallback, health checks, and early infra classification.'; }
    else if (family === 'codegen.marker_coverage') { owner = 'codegen'; remedy = 'Protect template fill output and validate combined split files before codegen passes.'; }
    else if (family === 'schema.invalid_trigger_shape') { owner = 'schema'; remedy = 'Normalize invalid trigger JSON deterministically before schema validation.'; }
    else if (family === 'method_check.partial_visibility') { owner = 'method-check'; remedy = 'Scan main + companion partial files and ignore comment ghosts.'; }
    else if (family === 'review.nonconverging_structural') { owner = 'review/static-check'; remedy = 'Convert recurring structural review failures into deterministic static guards.'; }
    else if (family === 'monitor.stuck_or_timeout') { owner = 'night-monitor'; remedy = 'Detect stuck processing/review states and cancel+resubmit with escalation.'; }
    else if (family === 'complexity_gate.bad_simplify_json') { owner = 'complexity-gate'; remedy = 'Use balanced JSON extraction and repair for simplify responses.'; }
    var priority = 'P2';
    var reason = '已有知识覆盖，继续观察';
    if (item.count >= 3 && wasteMinutes >= 10 && !knowledgeCovered && !hasDraft) {
      priority = 'P0'; reason = '高频 + 高浪费 + 无知识覆盖';
    } else if (item.count >= 2 && !knowledgeCovered && hasDraft) {
      priority = 'P1'; reason = '高频且已有 draft，优先转 curated';
    } else if (item.count >= 2 && knowledgeCovered && wasteMinutes >= 10) {
      priority = 'P1'; reason = '已知问题但仍高浪费，优先加强拦截';
    } else if (!knowledgeCovered && !hasDraft) {
      priority = 'P1'; reason = '已有重复迹象但知识链未覆盖';
    }
    return {
      family: family,
      priority: priority,
      owner: owner,
      remedy: remedy,
      count: item.count,
      pct: item.pct,
      wasteMinutes: wasteMinutes.toFixed(1),
      knowledgeCoverage: knowledgeCovered ? '1/1' : '0/0',
      hasDraft: hasDraft,
      reason: reason,
    };
  }).filter(function(item) {
    return item.priority === 'P0' || item.priority === 'P1';
  }).slice(0, 8);

  ensureDir(OUTPUT_ROOT);
  var manifest = [];
  top.forEach(function(item) {
    var draft = draftForPriority(item);
    var file = path.join(OUTPUT_ROOT, draft.id + '.json');
    writeJson(file, draft);
    manifest.push({
      id: draft.id,
      title: draft.title,
      family: item.family,
      priority: item.priority,
      owner: item.owner,
      file: path.relative(LEARNING_ROOT, file)
    });
  });
  writeJson(path.join(OUTPUT_ROOT, 'index.json'), {
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

if (require.main === module) promoteGovernanceDrafts();

module.exports = {
  promoteGovernanceDrafts: promoteGovernanceDrafts
};
