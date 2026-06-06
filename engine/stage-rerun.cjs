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

var STAGE_ORDER = ['source-html-bind', 'clone', 'spec-extract', 'spec-validate', 'complexity-gate', 'assembly-plan', 'assembly-complexity-gate', 'codegen', 'method-check', 'review', 'compile', 'fidelity-source-diff', 'visual-check', 'runtime-contract', 'cua-verify'];

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

function scrubTaskMetadataJsonForRerun(metadataJson) {
  var raw = metadataJson;
  if (raw && typeof raw !== 'string') raw = JSON.stringify(raw);
  if (!raw) raw = '{}';
  try {
    var parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      delete parsed.outerFpHistory;
    }
    return JSON.stringify(parsed || {});
  } catch (_err) {
    return raw;
  }
}

function buildTaskReset(task, message) {
  return {
    status: 'pending',
    assigned_to: null,
    assigned_at: null,
    retry_after: null,
    status_message: message,
    fail_count: 0,
    infra_retry_count: 0,
    code_retry_count: 0,
    metadata_json: scrubTaskMetadataJsonForRerun(task && task.metadata_json),
  };
}

function prepareProjectForRerun(project, message, nowIso) {
  var next = Object.assign({}, project || {});
  next.status = 'submitted';
  next.statusMessage = message;
  next.updatedAt = nowIso || new Date().toISOString();
  delete next.lastFailure;
  return next;
}

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
  if (STAGE_ORDER.indexOf(fromStage) <= STAGE_ORDER.indexOf('compile')) {
    delete checkpoint.htmlOutput;
    delete checkpoint.hasHtmlOutput;
    delete checkpoint.previewReadyAt;
  }
  return checkpoint;
}

function main() {
  var args = parseArgs(process.argv);
  if (!args.projectId) die('usage: node engine/stage-rerun.cjs --project <projectId> --from <cua-verify|runtime-contract|visual-check|fidelity-source-diff|compile|review|method-check|codegen|assembly-complexity-gate|assembly-plan|complexity-gate|spec-validate|spec-extract|clone|source-html-bind>');

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
    var taskReset = buildTaskReset(task, message);
    queue.db.prepare(
      "UPDATE tasks SET status=?, assigned_to=?, assigned_at=?, retry_after=?, status_message=?, fail_count=?, infra_retry_count=?, code_retry_count=?, metadata_json=?, updated_at=datetime('now') WHERE id=?"
    ).run(
      taskReset.status,
      taskReset.assigned_to,
      taskReset.assigned_at,
      taskReset.retry_after,
      taskReset.status_message,
      taskReset.fail_count,
      taskReset.infra_retry_count,
      taskReset.code_retry_count,
      taskReset.metadata_json,
      taskId
    );
    queue.db.prepare(
      "INSERT INTO task_history (task_id, from_status, to_status, actor, message) VALUES (?, ?, 'pending', 'admin', ?)"
    ).run(taskId, task.status, message);

    project = prepareProjectForRerun(project, message, nowIso);
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

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs: parseArgs,
  keptStagesFor: keptStagesFor,
  scrubCheckpointFor: scrubCheckpointFor,
  scrubTaskMetadataJsonForRerun: scrubTaskMetadataJsonForRerun,
  buildTaskReset: buildTaskReset,
  prepareProjectForRerun: prepareProjectForRerun,
  main: main,
};
