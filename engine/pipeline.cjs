/**
 * Pipeline Engine — pluggable stage-based execution for build tasks
 *
 * Usage:
 *   var pipeline = createLunaPipeline();
 *   var ctx = new PipelineContext(task, checkpoint, workerConfig);
 *   await pipeline.run(ctx, onProgress);
 */

var fs = require('fs');
var path = require('path');
var helpers = require('./helpers.cjs');
var { recordPipelineMetrics } = require('./metrics.cjs');
var notify;
try { notify = require('../adapters/notify.cjs'); } catch(e) { notify = { alert: function() {} }; }
var lessonExtractor;
try { lessonExtractor = require('./lesson-extractor.cjs'); } catch(e) { lessonExtractor = { extractLesson: function() {} }; }
var autoPromotePendingRules;
try { autoPromotePendingRules = require('../worker/code-reviewer.js').autoPromotePendingRules; } catch(e) { autoPromotePendingRules = function() {}; }

// ============ Pipeline Error ============
// Custom error that carries root cause + failing stage without message wrapping.
// This prevents the "Pipeline failed at X: Pipeline failed at Y: ..." nesting problem.

function PipelineError(stage, rootCause, classification) {
  this.name = 'PipelineError';
  this.stage = stage;
  this.rootCause = rootCause;
  this.classification = classification || 'UNKNOWN';
  this.message = '[' + stage + '] ' + rootCause;
}
PipelineError.prototype = Object.create(Error.prototype);
PipelineError.prototype.constructor = PipelineError;

/**
 * Extract the root cause message from any error, unwrapping PipelineError
 * and legacy "Pipeline failed at X:" prefixes.
 */
function unwrapRootCause(err) {
  if (err && err.name === 'PipelineError') return err.rootCause;
  var msg = (err && err.message) ? err.message : String(err);
  var pipelinePrefix = /^(?:Pipeline failed at \w[\w-]*:\s*|\[\w[\w-]*\]\s*)/;
  while (pipelinePrefix.test(msg)) {
    msg = msg.replace(pipelinePrefix, '');
  }
  return msg;
}

// ============ Pipeline Context ============

function PipelineContext(task, checkpoint, workerConfig) {
  this.task = task;
  this.taskId = task.id || task.taskId;

  // Blueprint
  this.blueprint = null;
  try {
    this.blueprint = typeof task.blueprint_json === 'string'
      ? JSON.parse(task.blueprint_json)
      : (task.blueprint || {});
  } catch(e) {
    this.blueprint = {};
  }

  // Worker config (URLs, IDs)
  this.workerConfig = workerConfig || {
    workerId: process.env.LINUX_WORKER_ID || 'linux-worker-1',
    baseUrl: process.env.LINUX_BASE_URL || 'http://120.55.70.226:3901',
    buildUrl: process.env.LINUX_BUILD_URL || 'http://127.0.0.1:18860',
  };

  // Stage state
  this.workDir = null;
  this.csCode = null;
  this.htmlOutput = null;
  this.previewUrl = null;
  this.extraFiles = {};
  this.buildTime = 0;

  // Checkpoint + resume
  this.checkpoint = checkpoint || {};
  this.completedStages = (checkpoint && checkpoint.completedStages) || [];

  // Always load GFM_Tools.cs — checkpoint resume skips clone which normally sets this
  try {
    var gfmPath = require('path').join(__dirname, '..', 'worker', 'GFM_Tools.cs');
    if (require('fs').existsSync(gfmPath)) {
      this.extraFiles['GFM_Tools.cs'] = require('fs').readFileSync(gfmPath, 'utf-8');
    }
  } catch(e) { /* ignore */ }
  this.stageResults = {};
  this.lastStageError = null;
  this.log = [];
}

PipelineContext.prototype.addLog = function(stage, message) {
  var entry = { stage: stage, message: message, at: new Date().toISOString() };
  this.log.push(entry);
  console.log('[pipeline][' + stage + '] ' + message);
};

PipelineContext.prototype.saveCheckpointData = function() {
  return {
    completedStages: this.completedStages.slice(),
    csCode: this.csCode,
    extraFiles: this.extraFiles,
    feedbackHistory: this.blueprint ? this.blueprint.feedbackHistory : [],
    stageResults: this.stageResults,
    cuaRound: this.checkpoint.cuaRound || 0,
    fixHistory: this.checkpoint.fixHistory || [],
  };
};

/**
 * Report task status to blueprint server (convenience method for stages)
 */
PipelineContext.prototype.reportStatus = function(status, extra) {
  return helpers.reportStatus(
    this.workerConfig.baseUrl,
    this.workerConfig.workerId,
    this.taskId,
    status,
    extra
  );
};

// ============ Pipeline Runner ============

function Pipeline(stages, options) {
  this.stages = stages || [];
  this.options = options || {};
  this.maxRetries = options && options.maxRetries || 3;
}

Pipeline.prototype.run = function(ctx, onProgress) {
  var self = this;
  var stageIndex = 0;

  // Record pipeline start time for metrics
  ctx._pipelineStartTime = Date.now();
  // Guard: only record metrics once per pipeline run
  ctx._metricsRecorded = false;

  // Deduplicate completedStages from checkpoint to prevent cross-run accumulation
  if (ctx.completedStages && ctx.completedStages.length > 0) {
    var seen = {};
    var deduped = [];
    for (var di = 0; di < ctx.completedStages.length; di++) {
      var s = ctx.completedStages[di];
      if (!seen[s]) { seen[s] = true; deduped.push(s); }
    }
    if (deduped.length !== ctx.completedStages.length) {
      ctx.addLog('pipeline', 'Deduplicated completedStages: ' + ctx.completedStages.length + ' → ' + deduped.length);
      ctx.completedStages = deduped;
    }
  }

  // Cleanup stale temp dirs from previous runs (older than 2 hours)
  try {
    var os = require('os');
    var tmpDir = os.tmpdir();
    var cutoff = Date.now() - 2 * 3600 * 1000;
    var entries = fs.readdirSync(tmpDir);
    var cleaned = 0;
    for (var ti = 0; ti < entries.length; ti++) {
      var name = entries[ti];
      if (name.indexOf('linux-') === 0 || name.indexOf('visual-check-') === 0) {
        var fp = path.join(tmpDir, name);
        try {
          var stat = fs.statSync(fp);
          if (stat.mtimeMs < cutoff) {
            fs.rmSync(fp, { recursive: true, force: true });
            cleaned++;
          }
        } catch(e) {}
      }
    }
    if (cleaned > 0) ctx.addLog('pipeline', 'Cleaned ' + cleaned + ' stale temp dirs');
  } catch(e) {}

  function runNext() {
    // Cancellation check — worker polls /api/tasks/:id/status in a background
    // interval and sets ctx._cancelled when the server reports 'cancelled'.
    // Unwind with TaskCancelledError so the worker's outer catch can exit
    // without reporting 'failed' or burning another stage.
    if (ctx._cancelled) {
      ctx.addLog('pipeline', 'Cancellation detected, unwinding pipeline');
      var cancelErr = new Error('Task ' + ctx.taskId + ' cancelled server-side');
      cancelErr.name = 'TaskCancelledError';
      return Promise.reject(cancelErr);
    }
    if (stageIndex >= self.stages.length) {
      if (!ctx._metricsRecorded) {
        try {
          recordPipelineMetrics(ctx, ctx.stageResults);
          ctx._metricsRecorded = true;
          ctx.addLog('pipeline', 'Metrics recorded (success)');
        } catch(e) {
          ctx.addLog('pipeline', 'Metrics recording failed: ' + e.message);
        }
      }
      // Auto-promote pending rules on success too (closes learning loop)
      try { autoPromotePendingRules(); } catch(e) { ctx.addLog('pipeline', 'autoPromotePendingRules failed: ' + e.message); }
      // Auto-learn behavior templates from successful code
      try {
        var templateLearner = require('./template-learner.cjs');
        templateLearner.learnFromSuccess(ctx);
      } catch(e) {
        ctx.addLog('pipeline', 'Template learning skipped: ' + e.message);
      }
      return Promise.resolve(ctx);
    }

    var stage = self.stages[stageIndex];
    stageIndex++;

    // Skip if already completed (checkpoint resume)
    if (ctx.completedStages.indexOf(stage.name) >= 0) {
      ctx.addLog(stage.name, 'skipped (checkpoint)');
      return runNext();
    }

    // Optional skip condition
    if (stage.canSkip && stage.canSkip(ctx)) {
      ctx.addLog(stage.name, 'skipped (condition)');
      return runNext();
    }

    // ---- Quality Gate: assertBefore ----
    if (stage.assertBefore) {
      try {
        stage.assertBefore(ctx);
      } catch(gateErr) {
        var gateMsg = 'Quality gate failed before ' + stage.name + ': ' + gateErr.message;
        ctx.addLog(stage.name, gateMsg);
        ctx._pipelineError = true;
        ctx._failedAtStage = stage.name;
        ctx._failReason = 'gate: ' + gateErr.message;
        ctx._failClassification = 'GATE';
        if (!ctx._metricsRecorded) {
          try { recordPipelineMetrics(ctx, ctx.stageResults); ctx._metricsRecorded = true; } catch(e) { ctx.addLog(stage.name, 'Metrics recording failed (gate): ' + e.message); }
        }
        try { notify.alert('warning', 'Pipeline gate failed', gateErr.message, { stage: stage.name, classification: 'GATE', taskId: ctx.taskId }); } catch(e) { ctx.addLog(stage.name, 'Notify failed (gate): ' + e.message); }
        try { lessonExtractor.extractLesson(ctx); } catch(e) { ctx.addLog(stage.name, 'Lesson extraction failed (gate): ' + e.message); }
        try { autoPromotePendingRules(); } catch(e) { ctx.addLog(stage.name, 'autoPromote failed (gate): ' + e.message); }
        if (onProgress) onProgress(stage.name, 'gate-failed', ctx);
        throw new PipelineError(stage.name, 'gate: ' + gateErr.message, 'GATE');
      }
    }

    ctx.addLog(stage.name, 'started');
    if (onProgress) onProgress(stage.name, 'running', ctx);

    var maxAttempts = stage.canRetry ? (stage.maxRetries || self.maxRetries) : 1;
    var attempt = 0;

    function tryExecute() {
      attempt++;
      // Fixture dump for testing
      if (process.env.DUMP_FIXTURES) {
          try {
              var fixtureDir = path.join(__dirname, '..', 'fixtures', stage.name);
              fs.mkdirSync(fixtureDir, { recursive: true });
              var fixtureData = {
                  taskId: ctx.taskId,
                  csCode: ctx.csCode,
                  htmlOutput: ctx.htmlOutput ? '(omitted, ' + ctx.htmlOutput.length + ' bytes)' : null,
                  blueprint: ctx.blueprint,
                  extraFiles: ctx.extraFiles,
                  workDir: ctx.workDir,
                  completedStages: ctx.completedStages.slice(),
              };
              fs.writeFileSync(
                  path.join(fixtureDir, ctx.taskId + '.json'),
                  JSON.stringify(fixtureData, null, 2)
              );
              ctx.addLog(stage.name, 'Fixture dumped');
          } catch(dumpErr) {
              // Fixture dump is best-effort, never block pipeline
          }
      }
      return Promise.resolve().then(function() {
        return stage.execute(ctx);
      }).then(function(result) {
        ctx.stageResults[stage.name] = result;
        ctx.completedStages.push(stage.name);
        ctx.lastStageError = null;
        ctx.addLog(stage.name, 'completed');
        if (onProgress) onProgress(stage.name, 'completed', ctx);
        return runNext();
      }).catch(function(err) {
        // Propagate cancellation immediately — no retry, no 'failed' report.
        if (err && err.name === 'TaskCancelledError') {
          throw err;
        }
        // CRITICAL: If this error originated from a DOWNSTREAM stage, do NOT
        // retry the current stage or fire 'failed' for it. Just propagate.
        // Without this guard, rejection bubbles back through the recursive
        // .then→runNext chain, causing earlier stages (especially clone with
        // canRetry:true) to retry and accidentally skip the failing stage.
        if (err && err.name === 'PipelineError' && err.stage !== stage.name) {
          throw err;
        }

        ctx.addLog(stage.name, 'attempt ' + attempt + '/' + maxAttempts + ' failed: ' + err.message);

        // MODEL_FATAL short-circuit: never retry a stage when the classifier
        // says the model backend is unusable (quota/auth/invalid-key). Retrying
        // just burns tokens against a dead endpoint. Check via classify() so any
        // stage (not just review) benefits from the short-circuit.
        var earlyClassified = null;
        try {
          var ecModule = require('./error-classifier.cjs');
          earlyClassified = ecModule.classify(err, { stage: stage.name }).type;
        } catch(ecErr) { ctx.addLog(stage.name, 'error-classifier failed: ' + ecErr.message); }
        if (earlyClassified === 'MODEL_FATAL') {
          ctx.addLog(stage.name, 'MODEL_FATAL classification — skipping stage retries');
        } else if (attempt < maxAttempts) {
          ctx.lastStageError = { stage: stage.name, error: err.message, attempt: attempt };
          return tryExecute();
        }

        if (onProgress) onProgress(stage.name, 'failed', ctx);

        // Unwrap to root cause — handles both PipelineError and legacy string prefixes
        var rootReason = unwrapRootCause(err);
        // If a downstream stage already set the failure context, preserve it
        // (the first stage to fail is the real root cause)
        if (!ctx._pipelineError) {
          ctx._pipelineError = true;
          ctx._failedAtStage = (err.name === 'PipelineError') ? err.stage : stage.name;
          ctx._failReason = rootReason;
          try {
            var errorClassifier = require('./error-classifier.cjs');
            ctx._failClassification = errorClassifier.classify({ message: rootReason }, { stage: ctx._failedAtStage }).type;
          } catch(ce) { ctx._failClassification = 'UNKNOWN'; }
        }
        if (!ctx._metricsRecorded) {
          try { recordPipelineMetrics(ctx, ctx.stageResults); ctx._metricsRecorded = true; } catch(e) { ctx.addLog(stage.name, 'Metrics recording failed: ' + e.message); }
        }
        try { notify.alert('critical', 'Pipeline failed', rootReason, { stage: ctx._failedAtStage, classification: ctx._failClassification, taskId: ctx.taskId }); } catch(e) { ctx.addLog(stage.name, 'Notify failed: ' + e.message); }
        try { lessonExtractor.extractLesson(ctx); } catch(e) { ctx.addLog(stage.name, 'Lesson extraction failed: ' + e.message); }
        // Auto-promote pending rules after lesson extraction (closes learning loop)
        try { autoPromotePendingRules(); } catch(e) { ctx.addLog(stage.name, 'autoPromote failed: ' + e.message); }
        // Throw PipelineError with root cause — no re-wrapping
        throw new PipelineError(ctx._failedAtStage, rootReason, ctx._failClassification);
      });
    }

    return tryExecute();
  }

  return runNext();
};

// ============ Real Stage Implementations ============

var cloneStage = require('./stages/clone.cjs');
var specValidateStage = require('./stages/spec-validate.cjs');
var complexityGateStage = require('./stages/complexity-gate.cjs');
var codegenStage = require('./stages/codegen.cjs');
var methodCheckStage = require('./stages/method-check.cjs');
var reviewStage = require('./stages/review.cjs');
var compileStage = require('./stages/compile.cjs');
var visualCheckStage = require('./stages/visual-check.cjs');
var cuaVerifyStage = require('./stages/cua-verify.cjs');
var uploadStage = require('./stages/upload.cjs');

// ============ Pipeline Factories ============

function createLunaPipeline(options) {
  return new Pipeline([
    cloneStage,
    specValidateStage,
    complexityGateStage,
    codegenStage,
    methodCheckStage,
    reviewStage,
    compileStage,
    visualCheckStage,
    cuaVerifyStage,
    uploadStage,
  ], options);
}

function createCocosPipeline(options) {
  return new Pipeline([
    cloneStage,
    codegenStage,
    // cocosCompileStage,
    uploadStage,
  ], options);
}

module.exports = {
  Pipeline: Pipeline,
  PipelineContext: PipelineContext,
  PipelineError: PipelineError,
  unwrapRootCause: unwrapRootCause,
  createLunaPipeline: createLunaPipeline,
  createCocosPipeline: createCocosPipeline,
  stages: {
    clone: cloneStage,
    specValidate: specValidateStage,
    complexityGate: complexityGateStage,
    codegen: codegenStage,
    methodCheck: methodCheckStage,
    review: reviewStage,
    compile: compileStage,
    visualCheck: visualCheckStage,
    cuaVerify: cuaVerifyStage,
    upload: uploadStage,
  },
};
