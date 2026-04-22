#!/usr/bin/env node
/**
 * Export long-lived learning assets from blueprint-editor into the external
 * blueprint-learning repository.
 *
 * Scope:
 * - worker/promoted-rules.json
 * - worker/fix-recipes.json
 * - worker/luna-anomaly-rules.js
 * - server-data/regressions.json
 * - server-data/pending-fixes.json
 * - server-data/pending-rules.json
 *
 * The goal is not to replace curated assets in the learning repo. Instead,
 * this script writes a generated mirror under `generated/` so the learning repo
 * can serve as the single long-lived knowledge source without mixing in the
 * editor's runtime state files directly.
 */

var fs = require('fs');
var path = require('path');

var REPO_ROOT = path.join(__dirname, '..');
var LEARNING_ROOT = process.env.BLUEPRINT_LEARNING_REPO || '/opt/blueprint-learning';
var OUTPUT_ROOT = path.join(LEARNING_ROOT, 'generated');

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

function writeText(file, text) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text, 'utf8');
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}

function mapPromotedRules(rules) {
  return (rules || []).map(function(rule, idx) {
    var category = 'systemic';
    var sourceRule = String(rule.rule || '').toLowerCase();
    if (sourceRule.indexOf('luna') >= 0) category = 'luna';
    else if (sourceRule.indexOf('cua') >= 0) category = 'cua';
    else if (sourceRule.indexOf('visual') >= 0 || sourceRule.indexOf('render') >= 0) category = 'visual';
    else if (sourceRule.indexOf('architecture') >= 0 || sourceRule.indexOf('code') >= 0) category = 'systemic';

    return {
      id: 'promoted-' + slugify(rule.rule || ('rule-' + idx)),
      title: String(rule.rule || 'Promoted Rule'),
      category: category,
      layer: ['prompt', 'reviewer'],
      severity: rule.severity || 'medium',
      status: 'active',
      symptom: String(rule.description || ''),
      rootCause: 'Derived from promoted reviewer knowledge in blueprint-editor.',
      fix: {
        short: String(rule.fix || '')
      },
      prevention: {
        promptHints: [String(rule.description || '')]
      },
      evidenceProjects: Array.isArray(rule.triggerProjects) ? rule.triggerProjects : [],
      owner: 'learning-sync',
      source: {
        type: 'promoted-rule',
        promotedAt: rule.promotedAt || null,
        triggerCount: rule.triggerCount || 0,
        totalOccurrences: rule.totalOccurrences || 0
      },
      createdAt: rule.promotedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  });
}

function mapRecipes(recipes) {
  return (recipes || []).map(function(recipe) {
    var stage = 'runtime';
    if (Array.isArray(recipe.affectedFiles)) {
      if (recipe.affectedFiles.some(function(f) { return /cua-verify/.test(f); })) stage = 'cua-verify';
      else if (recipe.affectedFiles.some(function(f) { return /spec-validate/.test(f); })) stage = 'spec-validate';
      else if (recipe.affectedFiles.some(function(f) { return /codegen/.test(f); })) stage = 'codegen';
      else if (recipe.affectedFiles.some(function(f) { return /compile/.test(f); })) stage = 'compile';
    }
    return {
      id: recipe.id,
      title: recipe.description || recipe.id,
      category: 'pipeline',
      stage: stage,
      fingerprintPatterns: recipe.fingerprintPattern ? [recipe.fingerprintPattern] : [],
      strategy: recipe.description || '',
      affectedFiles: recipe.affectedFiles || [],
      verification: [
        'node -c on changed .js/.cjs files',
        're-run relevant stage after applying recipe'
      ],
      status: 'active',
      metadata: {
        risk: recipe.risk || 'unknown',
        autoApply: recipe.autoApply === true,
        requiresApproval: recipe.requiresApproval === true,
        recipeFile: recipe.recipeFile || null,
        relatedCommits: recipe.relatedCommits || [],
        relatedMemories: recipe.relatedMemories || []
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  });
}

function mapRegressions(regressions) {
  return (regressions || []).map(function(item, idx) {
    return {
      id: 'regression-' + slugify(item.fingerprint || ('item-' + idx)),
      title: 'Regression: ' + String(item.fingerprint || 'unknown'),
      fingerprint: item.fingerprint || '',
      category: 'pipeline',
      stage: 'unknown',
      resolvedAt: item.resolvedAt || null,
      regressedAt: item.regressedAt || null,
      impactedProjects: [],
      status: 'active',
      notes: item.sampleReason || ''
    };
  });
}

function exportAll() {
  var promotedRules = readJson(path.join(REPO_ROOT, 'worker', 'promoted-rules.json'), []);
  var fixRecipes = readJson(path.join(REPO_ROOT, 'worker', 'fix-recipes.json'), []);
  var regressions = readJson(path.join(REPO_ROOT, 'server-data', 'regressions.json'), []);
  var pendingFixes = readJson(path.join(REPO_ROOT, 'server-data', 'pending-fixes.json'), { items: [] });
  var pendingRules = readJson(path.join(REPO_ROOT, 'server-data', 'pending-rules.json'), { items: [] });
  var lunaRulesSource = fs.readFileSync(path.join(REPO_ROOT, 'worker', 'luna-anomaly-rules.js'), 'utf8');

  ensureDir(OUTPUT_ROOT);

  var promotedMirror = mapPromotedRules(promotedRules);
  var recipeMirror = mapRecipes(fixRecipes);
  var regressionMirror = mapRegressions(regressions);

  writeJson(path.join(OUTPUT_ROOT, 'rules', 'promoted-rules.mirror.json'), promotedMirror);
  writeJson(path.join(OUTPUT_ROOT, 'recipes', 'fix-recipes.mirror.json'), recipeMirror);
  writeJson(path.join(OUTPUT_ROOT, 'regressions', 'runtime-regressions.mirror.json'), regressionMirror);
  writeJson(path.join(OUTPUT_ROOT, 'signals', 'pending-fixes.snapshot.json'), pendingFixes);
  writeJson(path.join(OUTPUT_ROOT, 'signals', 'pending-rules.snapshot.json'), pendingRules);
  writeText(path.join(OUTPUT_ROOT, 'luna', 'luna-anomaly-rules.snapshot.js'), lunaRulesSource);

  var manifest = {
    exportedAt: new Date().toISOString(),
    sourceRepo: REPO_ROOT,
    targetRepo: LEARNING_ROOT,
    counts: {
      promotedRules: promotedMirror.length,
      fixRecipes: recipeMirror.length,
      regressions: regressionMirror.length,
      pendingFixes: Array.isArray(pendingFixes.items) ? pendingFixes.items.length : 0,
      pendingRules: Array.isArray(pendingRules.items) ? pendingRules.items.length : 0
    },
    files: [
      'generated/rules/promoted-rules.mirror.json',
      'generated/recipes/fix-recipes.mirror.json',
      'generated/regressions/runtime-regressions.mirror.json',
      'generated/signals/pending-fixes.snapshot.json',
      'generated/signals/pending-rules.snapshot.json',
      'generated/luna/luna-anomaly-rules.snapshot.js'
    ]
  };
  writeJson(path.join(OUTPUT_ROOT, 'manifest.json'), manifest);
  console.log(JSON.stringify(manifest, null, 2));
}

if (require.main === module) exportAll();

module.exports = {
  exportAll: exportAll
};
