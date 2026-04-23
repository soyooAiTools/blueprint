var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var projectService = require('../engine/project-service.cjs');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function waitFor(check, timeoutMs) {
  timeoutMs = timeoutMs || 2000;
  var start = Date.now();
  return new Promise(function(resolve, reject) {
    (function poll() {
      if (check()) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error('waitFor timeout after ' + timeoutMs + 'ms'));
      }
      setTimeout(poll, 20);
    })();
  });
}

function withStubbedSpecExtractor(specs, fn) {
  var specExtractorPath = require.resolve('../adapters/spec-extractor.cjs');
  var original = require.cache[specExtractorPath];
  require.cache[specExtractorPath] = {
    id: specExtractorPath,
    filename: specExtractorPath,
    loaded: true,
    exports: {
      extractSpecs: async function() {
        return clone(specs);
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

function createProject(id) {
  return {
    id: id,
    name: id,
    status: 'editing',
    blueprint: { nodes: [], edges: [] },
    storyboardFrames: [
      { title: 'Intro', interaction: 'move_to:ConveyorBelt' },
      { title: 'Build', interaction: 'build:ConveyorBelt', camera: '镜头拉高看到全图' }
    ],
    entities: [
      {
        name: 'Player',
        label: '玩家',
        template: 'PlayerController',
        visual: { position: '(0,0,0)', scale: '1×1×1' },
        behavior: { moveSpeed: 5 }
      },
      {
        name: 'ConveyorBelt',
        label: '传送带',
        template: 'Buildable',
        visual: { position: '(1,0,1)', scale: '1×1×1' },
        trigger: { type: 'proximity', params: { radius: 2, cost: { gold: 1 } } },
        behavior: { buildTime: 2 }
      }
    ],
    phases: [
      { id: 1, name: 'intro', activate: ['Player', 'ConveyorBelt'], guide: '靠近传送带', camera: { lookAt: 'ConveyorBelt', zoom: 1.1 } }
    ],
    updatedAt: new Date().toISOString()
  };
}

function createHarness(tmpRoot) {
  var storedProject = null;
  var taskQueue = {
    queued: [],
    updated: [],
    get: function(taskId) {
      for (var i = 0; i < this.queued.length; i++) {
        if (this.queued[i].taskId === taskId) return this.queued[i];
      }
      return null;
    },
    updateBlueprint: function(taskId, blueprint) {
      var task = this.get(taskId);
      if (task) task.blueprint = blueprint;
    },
    updateStatus: function(taskId, status, reason, actor) {
      this.updated.push({ taskId: taskId, status: status, reason: reason, actor: actor });
    },
    enqueue: function(taskId, id, name, blueprint, metadata) {
      this.queued.push({ taskId: taskId, id: id, name: name, blueprint: blueprint, metadata: metadata });
    }
  };

  return {
    taskQueue: taskQueue,
    setProject: function(project) {
      storedProject = clone(project);
    },
    getProject: function() {
      return storedProject;
    },
    opts: {
      taskQueue: taskQueue,
      writeProject: function(project) {
        storedProject = clone(project);
      },
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
      WEBGL_DIR: path.join(tmpRoot, 'webgl')
    }
  };
}

(async function() {
  var tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-project-service-'));
  fs.mkdirSync(path.join(tmpRoot, 'webgl'), { recursive: true });

  await withStubbedSpecExtractor([
    { phaseId: 'intro', phaseName: 'Intro', requiredInteractions: ['move_to:ConveyorBelt', 'build:ConveyorBelt'], duration: { min: 10, max: 20 } }
  ], async function() {
    var harness = createHarness(tmpRoot);
    harness.setProject(createProject('proj_auto_confirm'));

    var result = await projectService.submitProject(harness.getProject(), harness.opts);
    assert.strictEqual(result.status, 'spec_extracting', 'submit should enter spec_extracting first');

    await waitFor(function() {
      return harness.getProject() && harness.getProject().status === 'submitted';
    });

    var project = harness.getProject();
    assert.strictEqual(project.status, 'submitted', 'clean specs should auto-confirm to submitted');
    assert.ok(project.planReview && project.planReview.autoConfirmed, 'auto-confirm should record planReview.autoConfirmed');
    assert.strictEqual(project.planReview.mode, 'auto', 'auto-confirm should record auto mode');
    assert.match(project.statusMessage || '', /自动确认/, 'statusMessage should mention auto confirm');
    assert.strictEqual(harness.taskQueue.queued.length, 1, 'task should be enqueued after auto-confirm');
    assert.ok(fs.existsSync(path.join(tmpRoot, 'webgl', 'proj_auto_confirm', 'specs.json')), 'specs artifact missing after auto-confirm');
    assert.ok(fs.existsSync(path.join(tmpRoot, 'webgl', 'proj_auto_confirm', 'plans.json')), 'plans artifact missing after auto-confirm');
  });

  await withStubbedSpecExtractor([], async function() {
    var harness = createHarness(tmpRoot);
    harness.setProject(createProject('proj_manual_review'));

    var result = await projectService.submitProject(harness.getProject(), harness.opts);
    assert.strictEqual(result.status, 'spec_extracting', 'submit should enter spec_extracting first');

    await waitFor(function() {
      return harness.getProject() && harness.getProject().status === 'spec_review';
    });

    var project = harness.getProject();
    assert.strictEqual(project.status, 'spec_review', 'invalid/empty specs should stay in spec_review');
    assert.match(project.statusMessage || '', /人工检查/, 'statusMessage should mention manual review');
    assert.strictEqual(harness.taskQueue.queued.length, 0, 'manual review path should not enqueue task');
    assert.ok(fs.existsSync(path.join(tmpRoot, 'webgl', 'proj_manual_review', 'specs.json')), 'specs artifact missing for manual review');
    assert.ok(fs.existsSync(path.join(tmpRoot, 'webgl', 'proj_manual_review', 'plans.json')), 'plans artifact missing for manual review');
  });

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('project-service auto-confirm tests passed');
})().catch(function(err) {
  console.error(err && err.stack || err);
  process.exit(1);
});
