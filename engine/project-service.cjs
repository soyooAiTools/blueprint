/**
 * Project Service — business logic for project lifecycle operations
 * Extracted from api/projects.cjs to keep handlers thin.
 */

var fs = require('fs');
var path = require('path');
var { projectSM } = require('../lib/state-machine.cjs');
var { clearCheckpoint } = require('../lib/checkpoint.cjs');
var { ensureProjectPlans, writePlansArtifact } = require('../adapters/assembly-plan-pipeline.cjs');

/**
 * Submit a project to the autoCoding pipeline.
 *
 * @param {object} project - The project object
 * @param {object} opts - { taskQueue, readProject, writeProject, resetCUARetries, wakeOpenClaw, exportBlueprintForAgent, PORT, WEBGL_DIR }
 * @returns {Promise<{status: string, message: string, taskId: string}>}
 */
async function submitProject(project, opts) {
  var taskQueue = opts.taskQueue;
  var writeProject = opts.writeProject;
  var resetCUARetries = opts.resetCUARetries;
  var wakeOpenClaw = opts.wakeOpenClaw;
  var exportBlueprintForAgent = opts.exportBlueprintForAgent;
  var PORT = opts.PORT;
  var WEBGL_DIR = opts.WEBGL_DIR;

  // Validate transition
  var allowed = ['editing', 'feedback', 'failed'];
  if (allowed.indexOf(project.status) < 0) {
    throw new Error('当前状态「' + project.status + '」不允许提交');
  }

  resetCUARetries(project.id);
  ensureProjectPlans(project);

  var taskId = project.id;
  var isFeedbackResubmit = project.status === 'feedback';
  var hasStoryboard = project.storyboardFrames && project.storyboardFrames.length > 0;

  // Export blueprint (strip base64 images)
  var blueprintExport = exportBlueprintForAgent(project);

  var metadata = {
    svnUrl: project.svnUrl || '',
    blueprintEditorId: project.id,
    blueprintServerUrl: 'http://localhost:' + PORT,
    unityPort: 18801,
    unityBridge: 'http://localhost:18801',
    source: 'blueprint-editor',
  };

  // Enqueue or resubmit task
  var existingTask = taskQueue.get(taskId);
  // Fresh submit (editing/failed, not feedback) wipes any stale checkpoint —
  // even when the task row was deleted manually (existingTask=null) the file
  // may still sit on disk from a previous run, and worker.processTask() will
  // silently resume completedStages from it and skip codegen. Feedback
  // resubmits keep the checkpoint: those loops deliberately reuse earlier
  // stages and only re-run review + downstream.
  if (!isFeedbackResubmit) {
    try {
      var cpResult = clearCheckpoint(taskId);
      if (cpResult.cleared) console.log('[submit] checkpoint wiped for fresh submit: ' + taskId);
    } catch(e) { console.warn('[submit] checkpoint wipe failed: ' + e.message); }
  }

  project.autoCodingTaskId = taskId;
  project.updatedAt = new Date().toISOString();

  // Storyboard projects must confirm extracted specs before entering the queue.
  if (hasStoryboard && !isFeedbackResubmit) {
    projectSM.forceTransition(project, 'spec_extracting', 'submit-service');
    writeProject(project);

    _extractSpecsAsync(project, taskId, {
      writeProject: writeProject,
      taskQueue: taskQueue,
      wakeOpenClaw: wakeOpenClaw,
      exportBlueprintForAgent: exportBlueprintForAgent,
      WEBGL_DIR: WEBGL_DIR,
      metadata: metadata
    });

    return { status: 'spec_extracting', message: '正在提取体验规格，完成后请确认...', taskId: taskId };
  }

  if (isFeedbackResubmit && existingTask) {
    var feedback = null;
    if (project.feedbackHistory && project.feedbackHistory.length > 0) {
      feedback = project.feedbackHistory[project.feedbackHistory.length - 1];
    }
    taskQueue.resubmit(taskId, blueprintExport, feedback);
  } else if (existingTask) {
    taskQueue.updateBlueprint(taskId, blueprintExport);
    // actor='admin' forces the transition — without this, resubmitting a
    // 'cancelled' or 'failed' task is rejected by taskSM.validate (terminal
    // states can't go to 'pending' from a 'server' actor), leaving the task
    // row stuck while the project row moves forward → watchdog F14-desync
    // reverts project back to cancelled. (2026-04-20)
    taskQueue.updateStatus(taskId, 'pending', 'resubmitted', 'admin');
  } else {
    taskQueue.enqueue(taskId, project.id, project.name, blueprintExport, metadata);
  }

  // Direct submit (no specs needed)
  var result = projectSM.validate(project.status, 'submitted');
  if (!result.valid) throw new Error(result.error);

  project.status = 'submitted';
  writeProject(project);

  wakeOpenClaw('[蓝图编辑器] 新任务已提交到 autoCoding 队列。项目: ' + project.name + ', taskId: ' + taskId);
  return { status: 'submitted', taskId: taskId };
}

/**
 * Async spec extraction (fire-and-forget from submit)
 */
async function _extractSpecsAsync(project, taskId, opts) {
  try {
    var specExtractor = require('../adapters/spec-extractor.cjs');
    console.log('[submit] Extracting specs from ' + project.storyboardFrames.length + ' frames...');
    var projectEntities = (project.blueprint && project.blueprint.entities) || project.entities || [];
    var specs = await specExtractor.extractSpecs(project.storyboardFrames, {
      projectName: project.name,
      gameType: 'SLG',
      entities: projectEntities,
    });
    project.specs = specs;
    ensureProjectPlans(project);
    projectSM.forceTransition(project, 'spec_review', 'spec-extraction-success');
    opts.writeProject(project);

    // Save specs to disk
    try {
      var specsDir = path.join(opts.WEBGL_DIR, taskId);
      fs.mkdirSync(specsDir, { recursive: true });
      fs.writeFileSync(path.join(specsDir, 'specs.json'), JSON.stringify(specs, null, 2), 'utf-8');
      writePlansArtifact(specsDir, project.plans);
    } catch(e) { console.error('[submit] save specs:', e.message); }

    console.log('[submit] Specs extracted: ' + specs.length + ' phases, awaiting spec confirmation');
  } catch(specErr) {
    console.error('[submit] Spec extraction failed:', specErr.message);
    projectSM.forceTransition(project, 'submitted', 'spec-extraction-failed');
    ensureProjectPlans(project);
    opts.writeProject(project);
    var blueprintExport = opts.exportBlueprintForAgent(project);
    blueprintExport.specs = project.specs || [];
    var existingTask = opts.taskQueue.get(taskId);
    if (existingTask) {
      opts.taskQueue.updateBlueprint(taskId, blueprintExport);
      opts.taskQueue.updateStatus(taskId, 'pending', 'specs extraction failed, skipped', 'server');
    } else {
      opts.taskQueue.enqueue(taskId, project.id, project.name, blueprintExport, opts.metadata || {});
    }
    opts.wakeOpenClaw('[蓝图编辑器] 新任务已提交(spec提取失败,跳过)。项目: ' + project.name + ', taskId: ' + taskId);
  }
}

module.exports = {
  submitProject: submitProject,
};
