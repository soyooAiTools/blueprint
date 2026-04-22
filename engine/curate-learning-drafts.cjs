#!/usr/bin/env node
/**
 * Curate reviewable drafts from blueprint-learning/drafts into long-lived
 * curated assets under the learning repository.
 *
 * Usage:
 *   node engine/curate-learning-drafts.cjs --all
 *   node engine/curate-learning-drafts.cjs --group pending-rules
 *   node engine/curate-learning-drafts.cjs --id draft-rule-xxxx
 *
 * This script is intentionally deterministic. It copies draft content into the
 * recommended curated location and marks the draft as promoted.
 */

var fs = require('fs');
var path = require('path');

var LEARNING_ROOT = process.env.BLUEPRINT_LEARNING_REPO || '/opt/blueprint-learning';
var DRAFTS_ROOT = path.join(LEARNING_ROOT, 'drafts');

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

function parseArgs(argv) {
  var out = { all: false, group: null, id: null };
  for (var i = 0; i < argv.length; i++) {
    if (argv[i] === '--all') out.all = true;
    else if (argv[i] === '--group') out.group = argv[++i] || null;
    else if (argv[i] === '--id') out.id = argv[++i] || null;
  }
  return out;
}

function listDraftFiles() {
  var groups = ['pending-fixes', 'pending-rules', 'regressions'];
  var files = [];
  groups.forEach(function(group) {
    var dir = path.join(DRAFTS_ROOT, group);
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir).forEach(function(name) {
      if (!/\.json$/.test(name) || name === 'index.json') return;
      files.push({ group: group, file: path.join(dir, name) });
    });
  });
  return files;
}

function targetPathForDraft(draft) {
  var proposed = draft.proposedAsset || {};
  var kind = proposed.kind || 'rule';
  var prefix = proposed.recommendedPathPrefix || 'rules/systemic';

  if (kind === 'regression') {
    return path.join(LEARNING_ROOT, prefix, 'meta.json');
  }
  if (kind === 'rule-or-recipe' || kind === 'rule') {
    return path.join(LEARNING_ROOT, prefix, draft.id + '.json');
  }
  if (kind === 'recipe') {
    return path.join(LEARNING_ROOT, prefix, draft.id + '.json');
  }
  return path.join(LEARNING_ROOT, 'rules', 'systemic', draft.id + '.json');
}

function curatedBodyForDraft(draft) {
  if (draft.sourceType === 'regression') {
    return {
      id: draft.id,
      title: draft.title,
      fingerprint: draft.evidence && draft.evidence.fingerprint || '',
      category: draft.category,
      stage: draft.evidence && draft.evidence.failedAtStage || draft.evidence && draft.evidence.stage || 'unknown',
      resolvedAt: draft.evidence && draft.evidence.resolvedAt || null,
      regressedAt: draft.evidence && draft.evidence.regressedAt || null,
      impactedProjects: draft.evidence && draft.evidence.sampleTaskIds || [],
      status: 'active',
      notes: draft.suggestedAction || ''
    };
  }
  return {
    id: draft.id,
    title: draft.title,
    category: draft.category,
    layer: draft.layer,
    severity: draft.severity,
    status: 'active',
    symptom: draft.symptom,
    rootCause: draft.rootCause,
    fix: {
      short: draft.suggestedAction || ''
    },
    prevention: {},
    evidenceProjects: draft.evidence && draft.evidence.sampleTaskIds || [],
    owner: 'learning-curation',
    sourceDraft: draft.id,
    createdAt: draft.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function curateOne(fileInfo) {
  var draft = readJson(fileInfo.file, null);
  if (!draft) return { ok: false, file: fileInfo.file, error: 'invalid json' };
  if (draft.status === 'promoted') return { ok: true, file: fileInfo.file, skipped: true };

  var target = targetPathForDraft(draft);
  var body = curatedBodyForDraft(draft);
  writeJson(target, body);

  draft.status = 'promoted';
  draft.promotedAt = new Date().toISOString();
  draft.curatedPath = path.relative(LEARNING_ROOT, target);
  writeJson(fileInfo.file, draft);

  return { ok: true, file: fileInfo.file, target: target };
}

function curateDrafts(opts) {
  opts = opts || {};
  var candidates = listDraftFiles().filter(function(info) {
    if (opts.group && info.group !== opts.group) return false;
    if (opts.id && path.basename(info.file, '.json') !== opts.id) return false;
    return true;
  });
  if (!opts.all && !opts.group && !opts.id) {
    throw new Error('Specify --all, --group <name>, or --id <draft-id>');
  }

  var results = candidates.map(curateOne);
  var summary = {
    curatedAt: new Date().toISOString(),
    total: results.length,
    promoted: results.filter(function(r) { return r.ok && !r.skipped; }).length,
    skipped: results.filter(function(r) { return r.skipped; }).length,
    errors: results.filter(function(r) { return !r.ok; })
  };
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

if (require.main === module) {
  curateDrafts(parseArgs(process.argv.slice(2)));
}

module.exports = {
  curateDrafts: curateDrafts
};
