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
var archiveWriter;
try { archiveWriter = require('./archive-writer.cjs'); }
catch(e) { archiveWriter = { appendStageLog: function() {}, writeModelFatal: function() {} }; }
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
  if (checkpoint && checkpoint.blueprint && typeof checkpoint.blueprint === 'object') {
    this.blueprint = JSON.parse(JSON.stringify(checkpoint.blueprint));
  }

  // Backfill blueprint.sourceHtmlPath from top-level task fields so that
  // orchestrators which set the field outside blueprint_json are honoured.
  // This must run BEFORE the ctx.sourceHtmlPath shortcut read below so that
  // source-html-bind.assertBefore (and any direct ctx.sourceHtmlPath consumer)
  // sees the value without needing an additional task-field probe.
  if (this.blueprint && !this.blueprint.sourceHtmlPath) {
    var topLevelHtmlPath = task.sourceHtmlPath || task.source_html_path || null;
    if (topLevelHtmlPath) {
      this.blueprint.sourceHtmlPath = topLevelHtmlPath;
      var topLevelSha256 = task.sourceHtmlSha256 || task.source_html_sha256 || null;
      if (topLevelSha256) this.blueprint.sourceHtmlSha256 = topLevelSha256;
    }
  }

  this.sourceHtmlPath = null;
  this.sourceHtmlSha256 = null;
  if (this.blueprint && this.blueprint.sourceHtmlPath) {
    this.sourceHtmlPath = this.blueprint.sourceHtmlPath;
    this.sourceHtmlSha256 = this.blueprint.sourceHtmlSha256 || null;
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

  // Always load GFM toolkit files — checkpoint resume skips clone which normally sets this
  try {
    delete this.extraFiles['GFM_Tools.cs']; // remove legacy monolithic file
    var gfmFiles = require('../worker/gfm-files.cjs').loadGfmFiles();
    for (var gk in gfmFiles) { if (gfmFiles.hasOwnProperty(gk)) this.extraFiles[gk] = gfmFiles[gk]; }
  } catch(e) { /* ignore */ }
  this.stageResults = (checkpoint && checkpoint.stageResults)
    ? JSON.parse(JSON.stringify(checkpoint.stageResults))
    : {};
  this.lastStageError = null;
  this.log = [];
  this.previewReadyAt = (checkpoint && checkpoint.previewReadyAt) || null;
}

PipelineContext.prototype.addLog = function(stage, message) {
  var entry = { stage: stage, message: message, at: new Date().toISOString() };
  this.log.push(entry);
  console.log('[pipeline][' + stage + '] ' + message);
  // Persist to per-task JSONL so stage-by-stage diagnostics survive a failed
  // pipeline. Previously ctx.log lived only in memory → lost at process exit.
  try {
    archiveWriter.appendStageLog(this.taskId, { stage: stage, event: 'log', message: message });
  } catch(e) { /* never block addLog */ }
};

PipelineContext.prototype.saveCheckpointData = function() {
  return {
    completedStages: this.completedStages.slice(),
    blueprint: this.blueprint ? JSON.parse(JSON.stringify(this.blueprint)) : null,
    csCode: this.csCode,
    extraFiles: this.extraFiles,
    feedbackHistory: this.blueprint ? this.blueprint.feedbackHistory : [],
    stageResults: this.stageResults,
    cuaRound: this.checkpoint.cuaRound || 0,
    fixHistory: this.checkpoint.fixHistory || [],
    previewReadyAt: this.previewReadyAt || null,
  };
};

/**
 * Report task status to blueprint server (convenience method for stages)
 */
PipelineContext.prototype.reportStatus = function(status, extra) {
  if (status === 'preview_ready' && !this.previewReadyAt) {
    this.previewReadyAt = Date.now();
  }
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
  if (self.options.recordMetrics === false) ctx._metricsRecorded = true;

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
      try {
        archiveWriter.appendStageLog(ctx.taskId, {
          stage: 'pipeline', event: 'pipeline-end', success: false,
          classification: 'CANCELLED',
          completedStages: ctx.completedStages.slice(),
          skippedStages: ctx._skippedStages || [],
        });
      } catch(e) {}
      var cancelErr = new Error(ctx._cancelledMessage || ('Task ' + ctx.taskId + ' cancelled server-side'));
      cancelErr.name = ctx._cancelledErrorName || 'TaskCancelledError';
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
      try {
        archiveWriter.appendStageLog(ctx.taskId, {
          stage: 'pipeline', event: 'pipeline-end', success: true,
          completedStages: ctx.completedStages.slice(),
          skippedStages: ctx._skippedStages || [],
          totalDurationMs: Date.now() - (ctx._pipelineStartTime || Date.now()),
        });
      } catch(e) {}
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
      try {
        archiveWriter.appendStageLog(ctx.taskId, {
          stage: stage.name, event: 'skip', reason: 'checkpoint',
          completedStagesSnapshot: ctx.completedStages.slice(),
        });
      } catch(e) {}
      return runNext();
    }

    // Optional skip condition
    if (stage.canSkip && stage.canSkip(ctx)) {
      ctx.addLog(stage.name, 'skipped (condition)');
      ctx._skippedStages = ctx._skippedStages || [];
      ctx._skippedStages.push({ name: stage.name, reason: 'condition' });
      try {
        archiveWriter.appendStageLog(ctx.taskId, {
          stage: stage.name, event: 'skip', reason: 'condition',
          completedStagesSnapshot: ctx.completedStages.slice(),
        });
      } catch(e) {}
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
        try {
          archiveWriter.appendStageLog(ctx.taskId, {
            stage: 'pipeline', event: 'pipeline-end', success: false,
            failedAtStage: stage.name, failReason: 'gate: ' + gateErr.message,
            classification: 'GATE',
            completedStages: ctx.completedStages.slice(),
            skippedStages: ctx._skippedStages || [],
          });
        } catch(e) {}
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
    var stageStartAt = Date.now();

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
        var stageResult = (result && typeof result === 'object') ? Object.assign({}, result) : { value: result };
        stageResult.durationMs = Date.now() - stageStartAt;
        if (stageResult.rounds == null) stageResult.rounds = attempt;
        if (stageResult.passed == null) stageResult.passed = true;
        ctx.stageResults[stage.name] = stageResult;
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
          // P0 archive: persist raw model backend error so quota/auth failures
          // never vanish into a truncated failReason.
          try {
            archiveWriter.writeModelFatal(err, { taskId: ctx.taskId, stage: stage.name, attempt: attempt });
          } catch(awErr) { ctx.addLog(stage.name, 'archive-writer MODEL_FATAL failed: ' + awErr.message); }
        } else if (earlyClassified === 'FATAL') {
          // FATAL classification means error-classifier flagged the failure as
          // not-retryable by design (e.g. schema timeout exit 143, spec validation,
          // missing generator/reviewer). Without this short-circuit a single FATAL
          // fault gets multiplied by maxAttempts (3×) and amplifies waste.
          ctx.addLog(stage.name, 'FATAL classification — skipping stage retries');
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
          // Archive MODEL_FATAL if final classification caught it (earlyClassified
          // path above may have missed it for wrapped PipelineErrors whose inner
          // message matches MODEL_FATAL patterns only after unwrapping).
          if (ctx._failClassification === 'MODEL_FATAL' && earlyClassified !== 'MODEL_FATAL') {
            try {
              archiveWriter.writeModelFatal(err, { taskId: ctx.taskId, stage: ctx._failedAtStage, attempt: attempt });
            } catch(awErr) { ctx.addLog(stage.name, 'archive-writer MODEL_FATAL (final) failed: ' + awErr.message); }
          }
        }
        if (!ctx.stageResults[stage.name]) {
          ctx.stageResults[stage.name] = {
            durationMs: Date.now() - stageStartAt,
            rounds: attempt,
            passed: false,
            error: rootReason,
          };
        }
        if (!ctx._metricsRecorded) {
          try { recordPipelineMetrics(ctx, ctx.stageResults); ctx._metricsRecorded = true; } catch(e) { ctx.addLog(stage.name, 'Metrics recording failed: ' + e.message); }
        }
        try {
          archiveWriter.appendStageLog(ctx.taskId, {
            stage: 'pipeline', event: 'pipeline-end', success: false,
            failedAtStage: ctx._failedAtStage, failReason: rootReason,
            classification: ctx._failClassification,
            completedStages: ctx.completedStages.slice(),
            skippedStages: ctx._skippedStages || [],
            totalDurationMs: Date.now() - (ctx._pipelineStartTime || Date.now()),
          });
        } catch(e) {}
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

var sourceHtmlBindStage = require('./stages/source-html-bind.cjs');
var fidelityContractSynthesizeStage = require('./stages/fidelity-contract-synthesize.cjs');
var sourceMeshExtractStage = require('./stages/source-mesh-extract.cjs'); // Wave 3 Step 2: flag-gated default-off (OPTION_C_SOURCE_FAITHFUL_BUILD)
var cloneStage = require('./stages/clone.cjs');
var specExtractStage = require('./stages/spec-extract.cjs');
var specValidateStage = require('./stages/spec-validate.cjs');
var complexityGateStage = require('./stages/complexity-gate.cjs');
var assemblyPlanStage = require('./stages/assembly-plan.cjs');
var assemblyComplexityGateStage = require('./stages/assembly-complexity-gate.cjs');
var codegenStage = require('./stages/codegen.cjs');
var methodCheckStage = require('./stages/method-check.cjs');
var staticPreReviewStage = require('./stages/static-pre-review.cjs'); // Wave 2 #3: flag-gated default-off
var reviewStage = require('./stages/review.cjs');
var fidelityContractProduceStage = require('./stages/fidelity-contract-produce.cjs');
var compileStage = require('./stages/compile.cjs');
var fidelitySourceDiffStage = require('./stages/fidelity-source-diff.cjs');
var visualCheckStage = require('./stages/visual-check.cjs');
var runtimeContractStage = require('./stages/runtime-contract.cjs');
var cuaVerifyStage = require('./stages/cua-verify.cjs');
var uploadStage = require('./stages/upload.cjs');

// ============ Pipeline Factories ============

function createLunaPipeline(options) {
  return new Pipeline([
    sourceHtmlBindStage,
    fidelityContractSynthesizeStage,
    sourceMeshExtractStage,
    cloneStage,
    specExtractStage,
    specValidateStage,
    complexityGateStage,
    assemblyPlanStage,
    assemblyComplexityGateStage,
    codegenStage,
    methodCheckStage,
    staticPreReviewStage,
    reviewStage,
    fidelityContractProduceStage,
    compileStage,
    fidelitySourceDiffStage,
    visualCheckStage,
    runtimeContractStage,
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
    sourceHtmlBind: sourceHtmlBindStage,
    sourceMeshExtract: sourceMeshExtractStage,
    clone: cloneStage,
    specExtract: specExtractStage,
    specValidate: specValidateStage,
    complexityGate: complexityGateStage,
    assemblyPlan: assemblyPlanStage,
    assemblyComplexityGate: assemblyComplexityGateStage,
    codegen: codegenStage,
    methodCheck: methodCheckStage,
    staticPreReview: staticPreReviewStage,
    review: reviewStage,
    fidelityContractProduce: fidelityContractProduceStage,
    compile: compileStage,
    fidelitySourceDiff: fidelitySourceDiffStage,
    visualCheck: visualCheckStage,
    runtimeContract: runtimeContractStage,
    cuaVerify: cuaVerifyStage,
    upload: uploadStage,
  },
};
