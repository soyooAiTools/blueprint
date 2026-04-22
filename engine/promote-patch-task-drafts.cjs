#!/usr/bin/env node
/**
 * Generate executable patch-task drafts from implementation plans.
 *
 * This is the final handoff layer before real execution:
 * - keeps the concrete target files
 * - preserves ordered steps + validation commands
 * - adds an execution-ready task envelope for future automation
 */

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var LEARNING_ROOT = process.env.BLUEPRINT_LEARNING_REPO || '/opt/blueprint-learning';
var PLAN_ROOT = path.join(LEARNING_ROOT, 'drafts', 'implementation-plans');
var OUT_ROOT = path.join(LEARNING_ROOT, 'drafts', 'patch-tasks');

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

function listImplementationPlans() {
  var index = readJson(path.join(PLAN_ROOT, 'index.json'), { items: [] });
  return (index.items || []).map(function(item) {
    return readJson(path.join(LEARNING_ROOT, item.file || ''), null);
  }).filter(Boolean);
}

function buildPatchTask(plan) {
  var family = plan.family || 'unknown';
  var targetFiles = plan.targetFiles || [];
  var primaryTarget = targetFiles[0] || null;
  var executionMode = /^infra\./.test(family) ? 'manual-guarded' : 'auto-patch-candidate';
  var validationCommands = (plan.validationCommands || []).slice(0, 8);

  return {
    id: 'draft-patch-' + sha(family),
    sourceType: 'patch-task',
    status: 'candidate',
    title: 'Patch task: ' + family,
    priority: plan.priority || 'P1',
    family: family,
    owner: plan.owner || 'triage',
    executionMode: executionMode,
    primaryTarget: primaryTarget,
    targetFiles: targetFiles,
    orderedSteps: plan.orderedSteps || [],
    validationCommands: validationCommands,
    patchStrategy: {
      kind: plan.action || 'triage-and-classify',
      shouldUseApplyPatch: true,
      shouldRestartServices: true,
      services: [
        'blueprint-editor',
        'blueprint-night-monitor'
      ]
    },
    expectedOutcome: plan.expectedOutcome || ('Reduce recurrence of ' + family + '.'),
    linkedImplementationPlan: plan.id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function promotePatchTaskDrafts() {
  var plans = listImplementationPlans();
  ensureDir(OUT_ROOT);
  var manifest = [];
  plans.forEach(function(plan) {
    var task = buildPatchTask(plan);
    var file = path.join(OUT_ROOT, task.id + '.json');
    writeJson(file, task);
    manifest.push({
      id: task.id,
      title: task.title,
      family: task.family,
      priority: task.priority,
      owner: task.owner,
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

if (require.main === module) promotePatchTaskDrafts();

module.exports = {
  promotePatchTaskDrafts: promotePatchTaskDrafts
};
