var assert = require('assert');
var fs = require('fs');
var path = require('path');

var projectService = require('../engine/project-service.cjs');
var checkpoint = require('../lib/checkpoint.cjs');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createProject(id) {
  return {
    id: id,
    name: id,
    status: 'cancelled',
    blueprint: { nodes: [], edges: [] },
    storyboardFrames: [
      { title: 'Intro', interaction: 'move_to:ConveyorBelt' },
      { title: 'Build', interaction: 'build:ConveyorBelt' }
    ],
    entities: [
      { name: 'Player', template: 'PlayerController' },
      { name: 'ConveyorBelt', template: 'Buildable' }
    ],
    phases: [
      { id: 1, name: 'intro', activate: ['Player', 'ConveyorBelt'] }
    ],
    updatedAt: new Date().toISOString()
  };
}

function writeCheckpoint(taskId, completedStages) {
  var dir = checkpoint.checkpointDirFor(taskId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'checkpoint.json'), JSON.stringify({
    completedStages: completedStages,
    blueprint: { projectName: taskId },
    extraFiles: {},
    stageResults: {},
    pipelineVersion: checkpoint.computePipelineFingerprint(),
    savedAt: new Date().toISOString()
  }), 'utf8');
  return dir;
}

function withThrowingSpecExtractor(fn) {
  var specExtractorPath = require.resolve('../adapters/spec-extractor.cjs');
  var original = require.cache[specExtractorPath];
  require.cache[specExtractorPath] = {
    id: specExtractorPath,
    filename: specExtractorPath,
    loaded: true,
    exports: {
      extractSpecs: async function() {
        throw new Error('extractSpecs should not be called during cancelled resume');
      }
    }
  };
  return Promise.resolve()
    .then(fn)
    .finally(function() {
      if (original) require.cache[specExtractorPath] = original;
      else delete require.cache[specExtractorPath];
    });
}

(async function() {
  var projectId = 'proj_cancelled_resume_' + Date.now();
  var checkpointDir = writeCheckpoint(projectId, [
    'clone',
    'spec-extract',
    'spec-validate',
    'complexity-gate',
    'assembly-plan',
    'assembly-complexity-gate',
    'codegen',
    'method-check',
    'review',
    'compile',
    'visual-check'
  ]);

  var storedProject = createProject(projectId);
  var taskQueue = {
    _task: {
      id: projectId,
      status: 'cancelled',
      metadata_json: JSON.stringify({ outerFpHistory: ['same-error'], source: 'blueprint-editor' }),
      timeline_json: '[]'
    },
    updatedBlueprint: null,
    reruns: [],
    get: function(taskId) {
      return taskId === projectId ? clone(this._task) : null;
    },
    updateBlueprint: function(taskId, blueprint) {
      this.updatedBlueprint = { taskId: taskId, blueprint: clone(blueprint) };
    },
    resetForRerun: function(taskId, message, actor) {
      this.reruns.push({ taskId: taskId, message: message, actor: actor });
      this._task.status = 'pending';
    },
    enqueue: function() {
      throw new Error('enqueue should not be called when resuming an existing cancelled task');
    }
  };

  await withThrowingSpecExtractor(async function() {
    var result = await projectService.submitProject(storedProject, {
      taskQueue: taskQueue,
      writeProject: function(project) { storedProject = clone(project); },
      resetCUARetries: function() {},
      wakeOpenClaw: function() {},
      exportBlueprintForAgent: function(project) {
        return {
          projectName: project.name,
          entities: project.entities || [],
          phases: project.phases || [],
          specs: project.specs || [],
          plans: project.plans || null,
        };
      },
      PORT: 3901,
      WEBGL_DIR: '/tmp'
    });

    assert.strictEqual(result.status, 'submitted');
    assert.strictEqual(result.resumedFromStage, 'runtime-contract');
    assert.strictEqual(taskQueue.reruns.length, 1, 'cancelled resume should reset task for rerun');
    assert.match(taskQueue.reruns[0].message, /runtime-contract/, 'rerun message should mention resume stage');
    assert.strictEqual(storedProject.status, 'submitted');
    assert.match(storedProject.statusMessage || '', /runtime-contract/, 'project should mention resumed stage');
    assert.ok(taskQueue.updatedBlueprint, 'latest blueprint should still sync into task row');
  });

  fs.rmSync(checkpointDir, { recursive: true, force: true });
  console.log('project-service cancelled resume tests passed');
})().catch(function(err) {
  console.error(err);
  process.exit(1);
});
