#!/usr/bin/env node
/**
 * Generate implementation-plan drafts from governance-task drafts.
 *
 * This turns "what to fix" into a concrete patch plan:
 * - ordered steps
 * - target files
 * - validation commands
 * - expected outcome
 */

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var LEARNING_ROOT = process.env.BLUEPRINT_LEARNING_REPO || '/opt/blueprint-learning';
var GOV_ROOT = path.join(LEARNING_ROOT, 'drafts', 'governance-tasks');
var OUT_ROOT = path.join(LEARNING_ROOT, 'drafts', 'implementation-plans');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function sha(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 10);
}

function listGovernanceDrafts() {
  var index = readJson(path.join(GOV_ROOT, 'index.json'), { items: [] });
  return (index.items || []).map(function(item) {
    var body = readJson(path.join(LEARNING_ROOT, item.file || ''), null);
    return body;
  }).filter(Boolean);
}

function buildPlan(draft) {
  var family = draft.rootCause || draft.evidence && draft.evidence.family || 'unknown';
  var targets = draft.suggestedTargets || [];
  var files = targets.filter(function(t) { return t.type === 'file'; }).map(function(t) { return t.path; });
  var validation = [];
  var steps = [];

  if (family === 'infra.schema_backend') {
    steps = [
      'Tighten schema backend fallback in codegen-schema before retry budget is consumed.',
      'Classify transport/connectivity errors as infra earlier so they skip code fix-loops.',
      'Escalate repeated infra failures through dashboard/watchdog diagnostics instead of blind resubmit loops.'
    ];
    validation = [
      'node -c /opt/blueprint-editor/engine/stages/codegen-schema.cjs',
      'node -c /opt/blueprint-editor/engine/error-classifier.cjs'
    ];
  } else if (family === 'review.nonconverging_structural') {
    steps = [
      'Promote recurring structural review failures into deterministic static-check rules.',
      'Short-circuit repeated same-fingerprint review loops earlier in review.cjs.',
      'Bind the new rule to the archived regression so future hits are tracked as the same family.'
    ];
    validation = [
      'node -c /opt/blueprint-editor/engine/static-check.cjs',
      'node -c /opt/blueprint-editor/engine/stages/review.cjs'
    ];
  } else if (family === 'method_check.partial_visibility') {
    steps = [
      'Ensure method-check scans all partial companions, not just the main file.',
      'Ignore false positives caused by comments or stale helper references.',
      'Backfill deterministic tests around the known missing-method patterns.'
    ];
    validation = [
      'node -c /opt/blueprint-editor/engine/stages/method-check.cjs'
    ];
  } else if (family === 'codegen.marker_coverage') {
    steps = [
      'Guard split-output marker coverage across main and Flow companions.',
      'Preserve TODO markers during skeleton split/merge.',
      'Keep the curated marker coverage rule aligned with the actual split path.'
    ];
    validation = [
      'node -c /opt/blueprint-editor/engine/stages/codegen-schema.cjs',
      'node -c /opt/blueprint-editor/adapters/skeleton-generator.cjs'
    ];
  } else {
    steps = [
      'Confirm root cause family and target the highest-leverage deterministic fix.',
      'Choose whether this should become a static rule, runtime fallback, or monitor policy.',
      'Add validation for the exact family fingerprint after patching.'
    ];
    validation = files.filter(Boolean).map(function(f) { return 'node -c ' + f; });
  }

  return {
    id: 'draft-impl-' + sha(family),
    sourceType: 'implementation-plan',
    status: 'candidate',
    title: 'Implementation plan: ' + family,
    priority: draft.priority || 'P1',
    family: family,
    owner: draft.owner || 'triage',
    action: draft.action || 'triage-and-classify',
    targetFiles: files,
    orderedSteps: steps,
    validationCommands: validation,
    expectedOutcome: 'Reduce recurrence of ' + family + ' and lower its failure/waste contribution in the failure map.',
    linkedGovernanceDraft: draft.id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function promoteImplementationPlanDrafts() {
  var drafts = listGovernanceDrafts();
  ensureDir(OUT_ROOT);
  var manifest = [];
  drafts.forEach(function(draft) {
    var plan = buildPlan(draft);
    var file = path.join(OUT_ROOT, plan.id + '.json');
    writeJson(file, plan);
    manifest.push({
      id: plan.id,
      title: plan.title,
      family: plan.family,
      priority: plan.priority,
      file: path.relative(LEARNING_ROOT, file)
    });
  });
  writeJson(path.join(OUT_ROOT, 'index.json'), {
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

if (require.main === module) promoteImplementationPlanDrafts();

module.exports = {
  promoteImplementationPlanDrafts: promoteImplementationPlanDrafts
};
