#!/usr/bin/env node
/**
 * Promote patch-task drafts into execution-ready patch-run records.
 *
 * This layer does not execute code changes yet. It creates a concrete run
 * queue with explicit execution status so the dashboard and monitor can track
 * what is ready for automation vs. what still needs guarded/manual handling.
 */

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var LEARNING_ROOT = process.env.BLUEPRINT_LEARNING_REPO || '/opt/blueprint-learning';
var PATCH_TASK_ROOT = path.join(LEARNING_ROOT, 'drafts', 'patch-tasks');
var OUT_ROOT = path.join(LEARNING_ROOT, 'drafts', 'patch-runs');

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

function listPatchTasks() {
  var index = readJson(path.join(PATCH_TASK_ROOT, 'index.json'), { items: [] });
  return (index.items || []).map(function(item) {
    return readJson(path.join(LEARNING_ROOT, item.file || ''), null);
  }).filter(Boolean);
}

function buildRun(task) {
  var executionMode = task.executionMode || 'manual-guarded';
  var status = executionMode === 'auto-patch-candidate' ? 'queued' : 'awaiting-approval';
  var blockingReason = executionMode === 'auto-patch-candidate'
    ? null
    : 'Execution mode requires guarded/manual review before code mutation.';

  return {
    id: 'draft-run-' + sha(task.family),
    sourceType: 'patch-run',
    status: status,
    family: task.family || 'unknown',
    priority: task.priority || 'P1',
    owner: task.owner || 'triage',
    executionMode: executionMode,
    executionReady: executionMode === 'auto-patch-candidate',
    blockingReason: blockingReason,
    primaryTarget: task.primaryTarget || null,
    targetFiles: task.targetFiles || [],
    orderedSteps: task.orderedSteps || [],
    validationCommands: task.validationCommands || [],
    linkedPatchTask: task.id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function promotePatchRunRecords() {
  var tasks = listPatchTasks();
  ensureDir(OUT_ROOT);
  var manifest = [];
  tasks.forEach(function(task) {
    var run = buildRun(task);
    var file = path.join(OUT_ROOT, run.id + '.json');
    writeJson(file, run);
    manifest.push({
      id: run.id,
      family: run.family,
      priority: run.priority,
      status: run.status,
      executionMode: run.executionMode,
      executionReady: run.executionReady,
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

if (require.main === module) promotePatchRunRecords();

module.exports = {
  promotePatchRunRecords: promotePatchRunRecords
};
