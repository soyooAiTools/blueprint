/**
 * Project Service — business logic for project lifecycle operations
 * Extracted from api/projects.cjs to keep handlers thin.
 */

var fs = require('fs');
var path = require('path');
var { projectSM } = require('../lib/state-machine.cjs');

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

  var taskId = project.id;
  var isFeedbackResubmit = project.status === 'feedback';

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
  if (isFeedbackResubmit && existingTask) {
    var feedback = null;
    if (project.feedbackHistory && project.feedbackHistory.length > 0) {
      feedback = project.feedbackHistory[project.feedbackHistory.length - 1];
    }
    taskQueue.resubmit(taskId, blueprintExport, feedback);
  } else if (existingTask) {
    taskQueue.updateBlueprint(taskId, blueprintExport);
    taskQueue.updateStatus(taskId, 'pending', 'resubmitted', 'server');
  } else {
    taskQueue.enqueue(taskId, project.id, project.name, blueprintExport, metadata);
  }

  project.autoCodingTaskId = taskId;
  project.updatedAt = new Date().toISOString();

  // Spec extraction path (async, non-blocking)
  var hasStoryboard = project.storyboardFrames && project.storyboardFrames.length > 0;
  if (hasStoryboard && !isFeedbackResubmit) {
    projectSM.forceTransition(project, 'spec_extracting', 'submit-service');
    writeProject(project);

    // Fire-and-forget spec extraction
    _extractSpecsAsync(project, taskId, {
      writeProject: writeProject,
      taskQueue: taskQueue,
      wakeOpenClaw: wakeOpenClaw,
      exportBlueprintForAgent: exportBlueprintForAgent,
      WEBGL_DIR: WEBGL_DIR,
    });

    return { status: 'spec_extracting', message: '正在提取体验规格，完成后请确认...', taskId: taskId };
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
    projectSM.forceTransition(project, 'submitted', 'spec-extraction-success');
    opts.writeProject(project);

    // Save specs to disk
    try {
      var specsDir = path.join(opts.WEBGL_DIR, taskId);
      fs.mkdirSync(specsDir, { recursive: true });
      fs.writeFileSync(path.join(specsDir, 'specs.json'), JSON.stringify(specs, null, 2), 'utf-8');
    } catch(e) { console.error('[submit] save specs:', e.message); }

    // Update blueprint in SQLite with specs
    var blueprintExport = opts.exportBlueprintForAgent(project);
    blueprintExport.specs = specs;
    opts.taskQueue.updateBlueprint(taskId, blueprintExport);
    opts.taskQueue.updateStatus(taskId, 'pending', 'specs extracted', 'server');
    opts.wakeOpenClaw('[蓝图编辑器] 新任务已提交。项目: ' + project.name + ', taskId: ' + taskId);
    console.log('[submit] Specs extracted: ' + specs.length + ' phases, task pending');
  } catch(specErr) {
    console.error('[submit] Spec extraction failed:', specErr.message);
    projectSM.forceTransition(project, 'submitted', 'spec-extraction-failed');
    opts.writeProject(project);
    opts.taskQueue.updateStatus(taskId, 'pending', 'specs extraction failed, skipped', 'server');
    opts.wakeOpenClaw('[蓝图编辑器] 新任务已提交(spec提取失败,跳过)。项目: ' + project.name + ', taskId: ' + taskId);
  }
}

module.exports = {
  submitProject: submitProject,
};
