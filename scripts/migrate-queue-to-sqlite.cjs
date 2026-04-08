#!/usr/bin/env node
/**
 * One-time migration: autoCoding-tasks/queue/*.json → SQLite
 * Safe to run multiple times (INSERT OR IGNORE)
 */
const fs = require('fs');
const path = require('path');
const TaskQueue = require('../lib/task-queue.cjs');

const QUEUE_DIR = path.join(__dirname, '..', '..', 'autoCoding-tasks', 'queue');

if (!fs.existsSync(QUEUE_DIR)) {
  console.error('Queue directory not found:', QUEUE_DIR);
  process.exit(1);
}

const queue = new TaskQueue();
let migrated = 0;
let skipped = 0;

const files = fs.readdirSync(QUEUE_DIR).filter(function(f) {
  return f.endsWith('.json') && !f.includes('-blueprint') && !f.includes('.cancelled');
});

console.log('Found ' + files.length + ' task files to migrate');

for (const file of files) {
  try {
    const taskPath = path.join(QUEUE_DIR, file);
    const task = JSON.parse(fs.readFileSync(taskPath, 'utf-8'));
    const taskId = task.taskId || file.replace('.json', '');

    // Check if already migrated
    if (queue.get(taskId)) {
      console.log('  SKIP (exists): ' + taskId);
      skipped++;
      continue;
    }

    // Read blueprint if exists
    const bpFile = path.join(QUEUE_DIR, taskId + '-blueprint.json');
    const blueprint = fs.existsSync(bpFile)
      ? fs.readFileSync(bpFile, 'utf-8')
      : '{}';

    // Build metadata from extra fields
    const metadata = {
      svnUrl: task.svnUrl || '',
      unityPort: task.unityPort,
      unityBridge: task.unityBridge,
      unityProjectPath: task.unityProjectPath,
      agents: task.agents,
      outputs: task.outputs,
      workerAssignments: task.workerAssignments,
      latestFeedback: task.latestFeedback,
      reviewResult: task.reviewResult,
      quickTestResult: task.quickTestResult,
      cuaResult: task.cuaResult,
      cuaRetries: task.cuaRetries,
    };

    // Insert
    queue.db.prepare(
      "INSERT OR IGNORE INTO tasks " +
      "(id, project_id, project_name, status, assigned_to, assigned_at, " +
      "created_at, updated_at, fail_count, infra_retry_count, code_retry_count, " +
      "retry_after, status_message, preview_url, blueprint_json, metadata_json, timeline_json) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      taskId,
      task.blueprintEditorId || taskId,
      task.projectName || '',
      task.status || 'pending',
      task.assignedTo || null,
      task.assignedAt || null,
      task.createdAt || new Date().toISOString(),
      task.updatedAt || new Date().toISOString(),
      task.failCount || 0,
      task.infraRetryCount || 0,
      task.codeRetryCount || 0,
      task.retryAfter || null,
      task.statusMessage || null,
      task.previewUrl || null,
      blueprint,
      JSON.stringify(metadata),
      JSON.stringify(task.timeline || [])
    );

    // Record migration in history
    queue.db.prepare(
      "INSERT INTO task_history (task_id, from_status, to_status, actor, message) " +
      "VALUES (?, ?, ?, ?, ?)"
    ).run(taskId, null, task.status || 'pending', 'migration', 'migrated from JSON file');

    console.log('  OK: ' + taskId + ' (' + (task.status || 'pending') + ')');
    migrated++;
  } catch (e) {
    console.error('  ERROR: ' + file + ' — ' + e.message);
  }
}

// Also migrate cancelled tasks
const cancelledFiles = fs.readdirSync(QUEUE_DIR).filter(function(f) {
  return f.endsWith('.cancelled.json');
});
for (const file of cancelledFiles) {
  try {
    const taskPath = path.join(QUEUE_DIR, file);
    const task = JSON.parse(fs.readFileSync(taskPath, 'utf-8'));
    const taskId = task.taskId || file.replace('.cancelled.json', '');

    if (queue.get(taskId)) { skipped++; continue; }

    queue.db.prepare(
      "INSERT OR IGNORE INTO tasks (id, project_id, project_name, status, created_at, updated_at) " +
      "VALUES (?, ?, ?, 'cancelled', ?, ?)"
    ).run(taskId, task.blueprintEditorId || taskId, task.projectName || '',
      task.createdAt || new Date().toISOString(), task.updatedAt || new Date().toISOString());

    console.log('  OK (cancelled): ' + taskId);
    migrated++;
  } catch (e) {
    console.error('  ERROR (cancelled): ' + file + ' — ' + e.message);
  }
}

console.log('\nMigration complete: ' + migrated + ' migrated, ' + skipped + ' skipped');

// Verify
const stats = queue.stats();
console.log('DB stats:', JSON.stringify(stats.tasks));

queue.close();
