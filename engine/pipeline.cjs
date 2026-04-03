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
    buildUrl: process.env.LINUX_BUILD_URL || 'http://120.55.70.226:3080',
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
    if (stageIndex >= self.stages.length) {
      try { recordPipelineMetrics(ctx, ctx.stageResults); } catch(e) {}
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
        if (onProgress) onProgress(stage.name, 'gate-failed', ctx);
        throw new Error(gateMsg);
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
        ctx.addLog(stage.name, 'attempt ' + attempt + '/' + maxAttempts + ' failed: ' + err.message);

        if (attempt < maxAttempts) {
          ctx.lastStageError = { stage: stage.name, error: err.message, attempt: attempt };
          return tryExecute();
        }

        if (onProgress) onProgress(stage.name, 'failed', ctx);
        ctx._pipelineError = true;
        try { recordPipelineMetrics(ctx, ctx.stageResults); } catch(e) {}
        throw new Error('Pipeline failed at ' + stage.name + ': ' + err.message);
      });
    }

    return tryExecute();
  }

  return runNext();
};

// ============ Real Stage Implementations ============

var cloneStage = require('./stages/clone.cjs');
var specValidateStage = require('./stages/spec-validate.cjs');
var codegenStage = require('./stages/codegen.cjs');
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
    codegenStage,
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
  createLunaPipeline: createLunaPipeline,
  createCocosPipeline: createCocosPipeline,
  stages: {
    clone: cloneStage,
    specValidate: specValidateStage,
    codegen: codegenStage,
    review: reviewStage,
    compile: compileStage,
    visualCheck: visualCheckStage,
    cuaVerify: cuaVerifyStage,
    upload: uploadStage,
  },
};
