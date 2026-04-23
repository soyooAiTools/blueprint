/**
 * Project Service — business logic for project lifecycle operations
 * Extracted from api/projects.cjs to keep handlers thin.
 */

var fs = require('fs');
var path = require('path');
var { projectSM } = require('../lib/state-machine.cjs');
var { clearCheckpoint } = require('../lib/checkpoint.cjs');
var { ensureProjectPlans, writePlansArtifact } = require('../adapters/assembly-plan-pipeline.cjs');

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function getSpecReviewDecision(project) {
  var validation = project && project.planValidation || {};
  var planErrors = toArray(validation.errors);
  var unresolved = toArray(project && project.plans && project.plans.assemblyPlan && project.plans.assemblyPlan.unresolved);
  var specs = toArray(project && project.specs);
  var cuaSteps = toArray(project && project.plans && project.plans.cuaPlan && project.plans.cuaPlan.steps);
  var reasons = [];

  if (specs.length <= 0) reasons.push('no_specs');
  if (validation.ok === false || planErrors.length > 0) reasons.push('plan_validation_failed');
  if (cuaSteps.length <= 0) reasons.push('empty_cua_plan');

  return {
    requiresManualReview: reasons.length > 0,
    reasons: reasons,
    specCount: specs.length,
    cuaStepCount: cuaSteps.length,
    unresolvedCount: unresolved.length,
    validationErrorCount: planErrors.length,
    validationWarningCount: toArray(validation.warnings).length,
  };
}

function humanizeReviewReason(code) {
  if (code === 'no_specs') return '未生成 specs';
  if (code === 'plan_validation_failed') return 'plan 校验失败';
  if (code === 'assembly_unresolved') return 'assembly 存在 unresolved';
  if (code === 'empty_cua_plan') return 'CUA plan 为空';
  return code;
}

function buildPlanReviewRecord(project, mode, decision, extra) {
  var assemblyPlan = project && project.plans && project.plans.assemblyPlan || {};
  var cuaPlan = project && project.plans && project.plans.cuaPlan || {};
  return {
    mode: mode || 'manual',
    confirmedAt: new Date().toISOString(),
    reason: (extra && extra.reason) || ((mode === 'auto') ? 'validation_clean' : 'manual_confirm'),
    autoConfirmed: mode === 'auto',
    autoReviewReasons: decision && decision.reasons ? decision.reasons.slice() : [],
    specCount: Array.isArray(project && project.specs) ? project.specs.length : 0,
    moduleInstanceCount: Array.isArray(assemblyPlan.moduleInstances) ? assemblyPlan.moduleInstances.length : 0,
    cuaStepCount: Array.isArray(cuaPlan.steps) ? cuaPlan.steps.length : 0,
    unresolvedCount: Array.isArray(assemblyPlan.unresolved) ? assemblyPlan.unresolved.length : 0,
    validationErrorCount: decision && decision.validationErrorCount || 0,
    validationWarningCount: decision && decision.validationWarningCount || 0,
  };
}

function saveSpecsArtifacts(project, taskId, WEBGL_DIR) {
  try {
    var specsDir = path.join(WEBGL_DIR, taskId);
    fs.mkdirSync(specsDir, { recursive: true });
    fs.writeFileSync(path.join(specsDir, 'specs.json'), JSON.stringify(project.specs || [], null, 2), 'utf-8');
    writePlansArtifact(specsDir, project.plans);
    console.log('[confirm-specs] Specs saved for CUA verification: ' + toArray(project.specs).length + ' phases');
  } catch(e) {
    console.error('[confirm-specs] Failed to save specs for CUA:', e.message);
  }
}

function confirmProjectSpecs(project, opts, extra) {
  extra = extra || {};
  ensureProjectPlans(project);
  var taskId = project.id;
  var metadata = extra.metadata || opts.metadata || {
    svnUrl: project.svnUrl || '',
    blueprintEditorId: project.id,
    blueprintServerUrl: 'http://localhost:' + opts.PORT,
    source: 'blueprint-editor',
  };
  var mode = extra.mode || 'manual';
  var decision = extra.decision || getSpecReviewDecision(project);

  project.planReview = buildPlanReviewRecord(project, mode, decision, extra);
  saveSpecsArtifacts(project, taskId, opts.WEBGL_DIR);

  var blueprintExport = opts.exportBlueprintForAgent(project);
  blueprintExport.specs = project.specs || [];

  var existingTask = opts.taskQueue.get(taskId);
  if (existingTask) {
    opts.taskQueue.updateBlueprint(taskId, blueprintExport);
    opts.taskQueue.updateStatus(taskId, 'pending', extra.statusReason || (mode === 'auto' ? 'specs auto-confirmed' : 'specs confirmed'), 'server');
  } else {
    opts.taskQueue.enqueue(taskId, project.id, project.name, blueprintExport, metadata);
  }

  var result = projectSM.validate(project.status, 'submitted');
  if (!result.valid) throw new Error(result.error);

  project.status = 'submitted';
  project.statusMessage = extra.statusMessage || (mode === 'auto'
    ? '规格/计划已自动确认，任务已提交编码队列'
    : '规格/计划已确认，任务已提交编码队列');
  project.updatedAt = new Date().toISOString();
  opts.writeProject(project);

  opts.wakeOpenClaw('[蓝图编辑器] ' + (mode === 'auto' ? 'Spec 已自动确认' : 'Spec 已确认') + '，任务已提交。项目: ' + project.name + ', taskId: ' + taskId);
  return {
    status: 'submitted',
    taskId: taskId,
    autoConfirmed: mode === 'auto',
    message: project.statusMessage,
  };
}

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
  project.statusMessage = null;
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

    return { status: 'spec_extracting', message: '正在提取体验规格和计划，默认会自动确认；若检测到异常则转人工检查...', taskId: taskId };
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
    var decision = getSpecReviewDecision(project);
    if (decision.requiresManualReview) {
      project.statusMessage = '需要人工检查：' + decision.reasons.map(humanizeReviewReason).join('、');
      projectSM.forceTransition(project, 'spec_review', 'spec-extraction-success');
      opts.writeProject(project);
      saveSpecsArtifacts(project, taskId, opts.WEBGL_DIR);
      console.log('[submit] Specs extracted: ' + specs.length + ' phases, manual review required (' + decision.reasons.join(', ') + ')');
      return;
    }

    confirmProjectSpecs(project, opts, {
      mode: 'auto',
      reason: 'validation_clean',
      decision: decision,
      statusReason: 'specs auto-confirmed',
      statusMessage: '规格/计划已自动确认，任务已提交编码队列',
    });
    console.log('[submit] Specs extracted: ' + specs.length + ' phases, auto-confirmed and submitted');
  } catch(specErr) {
    console.error('[submit] Spec extraction failed:', specErr.message);
    projectSM.forceTransition(project, 'submitted', 'spec-extraction-failed');
    ensureProjectPlans(project);
    project.statusMessage = '规格提取失败，已跳过确认并直接入队';
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
  confirmProjectSpecs: confirmProjectSpecs,
  _internals: {
    getSpecReviewDecision: getSpecReviewDecision,
    buildPlanReviewRecord: buildPlanReviewRecord,
    humanizeReviewReason: humanizeReviewReason,
  }
};
