#!/usr/bin/env node
/**
 * Stage-level rerun helper.
 *
 * Requeues an existing task without a full submit by trimming checkpoint
 * completedStages and resetting the SQLite task row back to pending.
 */

var fs = require('fs');
var path = require('path');
var TaskQueue = require('../lib/task-queue.cjs');
var { computePipelineFingerprint } = require('../lib/checkpoint.cjs');

var STAGE_ORDER = ['clone', 'spec-extract', 'spec-validate', 'complexity-gate', 'codegen', 'method-check', 'review', 'visual-check', 'cua-verify'];

function parseArgs(argv) {
  var out = { projectId: '', fromStage: 'review', dryRun: false };
  for (var i = 2; i < argv.length; i++) {
    var arg = argv[i];
    if (arg === '--project' && argv[i + 1]) out.projectId = argv[++i];
    else if (arg === '--from' && argv[i + 1]) out.fromStage = argv[++i];
    else if (arg === '--dry-run') out.dryRun = true;
  }
  return out;
}

function die(msg) {
  console.error('[stage-rerun] ' + msg);
  process.exit(1);
}

function readJson(fp) { return JSON.parse(fs.readFileSync(fp, 'utf8')); }
function writeJson(fp, data) { fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf8'); }

function keptStagesFor(fromStage) {
  var idx = STAGE_ORDER.indexOf(fromStage);
  if (idx < 0) die('unsupported --from stage: ' + fromStage);
  return STAGE_ORDER.slice(0, idx);
}

function scrubCheckpointFor(fromStage, checkpoint) {
  checkpoint = checkpoint || {};
  checkpoint.completedStages = keptStagesFor(fromStage);
  checkpoint.stageResults = checkpoint.stageResults || {};
  Object.keys(checkpoint.stageResults).forEach(function(stage) {
    if (checkpoint.completedStages.indexOf(stage) < 0) delete checkpoint.stageResults[stage];
  });

  // If we rerun from codegen or earlier, stale generated code should not remain
  // in checkpoint payload, otherwise worker resume can keep feeding old broken
  // csCode/extraFiles into downstream review even though codegen is expected to
  // regenerate them.
  if (STAGE_ORDER.indexOf(fromStage) <= STAGE_ORDER.indexOf('codegen')) {
    delete checkpoint.csCode;
    delete checkpoint.extraFiles;
  }
  return checkpoint;
}

function main() {
  var args = parseArgs(process.argv);
  if (!args.projectId) die('usage: node engine/stage-rerun.cjs --project <projectId> --from <review|method-check|codegen|spec-validate|spec-extract>');

  var projectFile = path.join('/opt/blueprint-editor/server-data/projects', args.projectId + '.json');
  if (!fs.existsSync(projectFile)) die('project not found: ' + args.projectId);
  var project = readJson(projectFile);

  var taskId = project.autoCodingTaskId || args.projectId;
  var queue = new TaskQueue();
  var task = queue.get(taskId);
  if (!task) die('task not found: ' + taskId);

  var keep = keptStagesFor(args.fromStage);
  var checkpointFile = path.join('/opt/blueprint-editor/server-data/checkpoints', taskId, 'checkpoint.json');
  if (fs.existsSync(checkpointFile)) {
    var checkpoint = readJson(checkpointFile);
    checkpoint = scrubCheckpointFor(args.fromStage, checkpoint);
    checkpoint.pipelineVersion = computePipelineFingerprint();
    checkpoint.savedAt = new Date().toISOString();
    if (!args.dryRun) writeJson(checkpointFile, checkpoint);
  }

  var nowIso = new Date().toISOString();
  var message = '[stage-rerun] restart from ' + args.fromStage;
  if (!args.dryRun) {
    queue.db.prepare(
      "UPDATE tasks SET status='pending', assigned_to=NULL, assigned_at=NULL, retry_after=NULL, status_message=?, updated_at=datetime('now') WHERE id=?"
    ).run(message, taskId);
    queue.db.prepare(
      "INSERT INTO task_history (task_id, from_status, to_status, actor, message) VALUES (?, ?, 'pending', 'admin', ?)"
    ).run(taskId, task.status, message);

    project.status = 'submitted';
    project.statusMessage = message;
    project.updatedAt = nowIso;
    writeJson(projectFile, project);
  }

  console.log(JSON.stringify({
    ok: true,
    projectId: args.projectId,
    taskId: taskId,
    rerunFrom: args.fromStage,
    keptStages: keep,
    checkpointUpdated: fs.existsSync(checkpointFile),
    dryRun: !!args.dryRun,
  }, null, 2));
}

main();
