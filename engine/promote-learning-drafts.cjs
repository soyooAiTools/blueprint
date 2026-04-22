#!/usr/bin/env node
/**
 * Promote runtime learning signals into reviewable draft assets inside the
 * external blueprint-learning repository.
 *
 * This script does NOT mark anything as permanently promoted. Instead it
 * creates deterministic draft files that can be reviewed, edited, and then
 * moved into curated long-lived locations inside the learning repository.
 */

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var REPO_ROOT = path.join(__dirname, '..');
var LEARNING_ROOT = process.env.BLUEPRINT_LEARNING_REPO || '/opt/blueprint-learning';
var DRAFTS_ROOT = path.join(LEARNING_ROOT, 'drafts');
var DATA_DIR = path.join(REPO_ROOT, 'server-data');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }
}

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

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}

function classifyStage(stage) {
  stage = String(stage || '').toLowerCase();
  if (stage.indexOf('cua') >= 0) return { category: 'cua', layer: ['cua-verify', 'worker'] };
  if (stage.indexOf('visual') >= 0) return { category: 'visual', layer: ['visual-check', 'worker'] };
  if (stage.indexOf('review') >= 0) return { category: 'review', layer: ['reviewer'] };
  if (stage.indexOf('codegen') >= 0) return { category: 'pipeline', layer: ['skeleton', 'worker'] };
  if (stage.indexOf('compile') >= 0) return { category: 'pipeline', layer: ['worker'] };
  if (stage.indexOf('spec') >= 0) return { category: 'pipeline', layer: ['worker'] };
  return { category: 'systemic', layer: ['worker'] };
}

function priorityToSeverity(priority) {
  if (priority === 'p0') return 'critical';
  if (priority === 'p1') return 'high';
  if (priority === 'p2') return 'medium';
  return 'low';
}

function normalizePendingFix(item) {
  var classification = classifyStage(item.failedAtStage);
  var fingerprint = item.fingerprint || item.sampleError || item.reason || item.id;
  return {
    id: 'draft-fix-' + sha(item.id || fingerprint),
    sourceType: 'pending-fix',
    sourceId: item.id || null,
    status: 'candidate',
    title: 'Draft fix: ' + String(fingerprint).slice(0, 80),
    category: classification.category,
    layer: classification.layer,
    severity: priorityToSeverity(item.priority),
    symptom: item.sampleError || fingerprint,
    rootCause: 'Derived from repeated runtime failure fingerprint; root cause still needs review.',
    suggestedAction: item.suggestedAction || '',
    evidence: {
      fingerprint: item.fingerprint || '',
      failedAtStage: item.failedAtStage || null,
      hitCount: item.hitCount || 0,
      uniqueTasks: item.uniqueTasks || 0,
      firstSeen: item.firstSeen || null,
      lastSeen: item.lastSeen || null
    },
    proposedAsset: {
      kind: 'rule-or-recipe',
      recommendedPathPrefix: classification.category === 'pipeline' ? 'rules/pipeline' : 'rules/systemic'
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function normalizePendingRule(item) {
  return {
    id: 'draft-rule-' + sha(item.id || item.phrase),
    sourceType: 'pending-rule',
    sourceId: item.id || null,
    status: 'candidate',
    title: 'Draft rule: ' + String((item.suggestedRule && item.suggestedRule.slug) || item.id || 'pending-rule'),
    category: 'systemic',
    layer: ['prompt', 'reviewer'],
    severity: (item.suggestedRule && item.suggestedRule.severity) || 'medium',
    symptom: item.phrase || '',
    rootCause: 'Auto-mined from repeated reviewer warnings; requires human review before promotion.',
    suggestedAction: 'Review regex hint and convert this warning cluster into a curated long-lived rule.',
    evidence: {
      hitCount: item.hitCount || 0,
      uniqueTasks: item.uniqueTasks || 0,
      sampleTaskIds: item.sampleTaskIds || [],
      sampleSnippets: item.sampleSnippets || [],
      suggestedRule: item.suggestedRule || null
    },
    proposedAsset: {
      kind: 'rule',
      recommendedPathPrefix: 'rules/systemic'
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function normalizeRegression(item) {
  var fingerprint = item.fingerprint || item.sampleReason || 'unknown-regression';
  return {
    id: 'draft-regression-' + sha(fingerprint),
    sourceType: 'regression',
    status: 'candidate',
    title: 'Draft regression: ' + String(fingerprint).slice(0, 80),
    category: 'pipeline',
    layer: ['worker', 'dashboard'],
    severity: 'high',
    symptom: item.sampleReason || fingerprint,
    rootCause: 'Previously resolved fingerprint reappeared in runtime telemetry.',
    suggestedAction: 'Promote this into a regression archive and link it to the owning rule/recipe.',
    evidence: {
      fingerprint: item.fingerprint || '',
      resolvedBy: item.resolvedBy || null,
      resolvedAt: item.resolvedAt || null,
      regressedAt: item.regressedAt || null,
      count: item.count || 0,
      firstRegressedAt: item.firstRegressedAt || null
    },
    proposedAsset: {
      kind: 'regression',
      recommendedPathPrefix: 'regressions/' + slugify(fingerprint)
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function exportDraftGroup(groupName, items) {
  var root = path.join(DRAFTS_ROOT, groupName);
  ensureDir(root);
  var manifest = [];
  items.forEach(function(item) {
    var file = path.join(root, item.id + '.json');
    writeJson(file, item);
    manifest.push({
      id: item.id,
      title: item.title,
      sourceType: item.sourceType,
      severity: item.severity,
      file: path.relative(LEARNING_ROOT, file)
    });
  });
  writeJson(path.join(root, 'index.json'), {
    updatedAt: new Date().toISOString(),
    count: manifest.length,
    items: manifest
  });
  return manifest.length;
}

function promoteDrafts() {
  var pendingFixes = readJson(path.join(DATA_DIR, 'pending-fixes.json'), { items: [] });
  var pendingRules = readJson(path.join(DATA_DIR, 'pending-rules.json'), { items: [] });
  var regressions = readJson(path.join(DATA_DIR, 'regressions.json'), []);

  var fixDrafts = (pendingFixes.items || []).map(normalizePendingFix);
  var ruleDrafts = (pendingRules.items || []).map(normalizePendingRule);
  var regressionDrafts = (regressions || []).map(normalizeRegression);

  var counts = {
    pendingFixes: exportDraftGroup('pending-fixes', fixDrafts),
    pendingRules: exportDraftGroup('pending-rules', ruleDrafts),
    regressions: exportDraftGroup('regressions', regressionDrafts)
  };

  var summary = {
    promotedAt: new Date().toISOString(),
    sourceRepo: REPO_ROOT,
    targetRepo: LEARNING_ROOT,
    counts: counts
  };
  writeJson(path.join(DRAFTS_ROOT, 'index.json'), summary);
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) promoteDrafts();

module.exports = {
  promoteDrafts: promoteDrafts
};
