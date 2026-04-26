var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var workerApi = require('../api/worker.cjs');
var { projectSM } = require('../lib/state-machine.cjs');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createCtx() {
  var tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-worker-status-'));
  var storedProject = null;
  var reportCalls = [];
  var heartbeatCalls = [];
  var task = null;

  return {
    tmpRoot: tmpRoot,
    setProject: function(project) { storedProject = clone(project); },
    getProject: function() { return storedProject; },
    setTask: function(nextTask) { task = nextTask ? clone(nextTask) : null; },
    reportCalls: reportCalls,
    heartbeatCalls: heartbeatCalls,
    handlers: workerApi.init({
      taskQueue: {
        get: function() { return task ? clone(task) : null; },
        getBlueprint: function() { return null; },
        report: function(taskId, status, data) {
          reportCalls.push({ taskId: taskId, status: status, data: clone(data || {}) });
          return {
            id: taskId,
            status: status,
            code_retry_count: 0,
            status_message: data && data.message || null,
          };
        },
        cancel: function() {},
        heartbeat: function(workerId, status, currentTask, uptime) {
          heartbeatCalls.push({
            workerId: workerId,
            status: status,
            currentTask: currentTask,
            uptime: uptime,
          });
        }
      },
      config: {
        PORT: 3901,
        WEBGL_DIR: path.join(tmpRoot, 'webgl')
      },
      sendJSON: function(res, payload, statusCode) {
        res.statusCode = statusCode || 200;
        res.payload = payload;
      },
      readProject: function() { return storedProject ? clone(storedProject) : null; },
      writeProject: function(project) { storedProject = clone(project); }
    })
  };
}

{
  var harness = createCtx();
  harness.setProject({
    id: 'proj_worker_guard',
    status: 'spec_extracting',
    statusHistory: [],
    updatedAt: new Date().toISOString()
  });
  harness.setTask({
    id: 'proj_worker_guard',
    status: 'failed',
    assigned_to: null,
    status_message: 'old failure'
  });

  var res = {};
  harness.handlers.workerStatus({}, res, JSON.stringify({
    workerId: 'linux-worker-1',
    taskId: 'proj_worker_guard',
    status: 'processing',
    message: '[Linux] AI coding...'
  }), {});

  assert.strictEqual(res.statusCode, 200, 'stale report should be acknowledged');
  assert.strictEqual(res.payload.dropped, true, 'stale report should be dropped before status mutation');
  assert.strictEqual(harness.reportCalls.length, 0, 'dropped stale report must not mutate task queue');
  assert.strictEqual(harness.getProject().status, 'spec_extracting', 'project should stay in spec_extracting');
  fs.rmSync(harness.tmpRoot, { recursive: true, force: true });
}

{
  var harness2 = createCtx();
  harness2.setProject({
    id: 'proj_worker_guard_live',
    status: 'submitted',
    statusHistory: [],
    updatedAt: new Date().toISOString()
  });
  harness2.setTask({
    id: 'proj_worker_guard_live',
    status: 'assigned',
    assigned_to: 'linux-worker-2',
    status_message: null
  });

  var res2 = {};
  harness2.handlers.workerStatus({}, res2, JSON.stringify({
    workerId: 'linux-worker-2',
    taskId: 'proj_worker_guard_live',
    status: 'processing',
    message: '[Linux] AI coding...'
  }), {});

  assert.strictEqual(res2.statusCode, 200, 'live worker report should succeed');
  assert.ok(!res2.payload.dropped, 'live worker report should not be dropped');
  assert.strictEqual(harness2.reportCalls.length, 1, 'live worker report should update task queue');
  assert.strictEqual(harness2.getProject().status, 'processing', 'submitted project should move to processing');
  fs.rmSync(harness2.tmpRoot, { recursive: true, force: true });
}

{
  var harnessCuaDone = createCtx();
  harnessCuaDone.setProject({
    id: 'proj_worker_guard_cua_done',
    status: 'reviewing',
    statusHistory: [],
    updatedAt: new Date().toISOString()
  });
  harnessCuaDone.setTask({
    id: 'proj_worker_guard_cua_done',
    status: 'cua_passed',
    assigned_to: null,
    status_message: '[Linux] CUA passed'
  });

  var resCuaDone = {};
  harnessCuaDone.handlers.workerStatus({}, resCuaDone, JSON.stringify({
    workerId: 'linux-worker-2',
    taskId: 'proj_worker_guard_cua_done',
    status: 'done',
    message: '[Linux] Build complete. Preview: https://playcools.top/webgl/proj_worker_guard_cua_done/index.html',
    previewUrl: 'https://playcools.top/webgl/proj_worker_guard_cua_done/index.html'
  }), {});

  assert.strictEqual(resCuaDone.statusCode, 200, 'cua_passed -> done report should succeed');
  assert.ok(!resCuaDone.payload.dropped, 'cua_passed -> done report should not be dropped');
  assert.strictEqual(harnessCuaDone.reportCalls.length, 1, 'cua_passed -> done should update task queue');
  assert.strictEqual(harnessCuaDone.reportCalls[0].status, 'done');
  assert.strictEqual(harnessCuaDone.reportCalls[0].data.previewUrl, 'https://playcools.top/webgl/proj_worker_guard_cua_done/index.html');
  fs.rmSync(harnessCuaDone.tmpRoot, { recursive: true, force: true });
}

{
  var harnessHeartbeat = createCtx();
  harnessHeartbeat.setTask({
    id: 'proj_worker_guard_owner',
    status: 'processing',
    assigned_to: 'linux-worker-2',
    status_message: null
  });

  var resHeartbeat = {};
  harnessHeartbeat.handlers.workerHeartbeat({}, resHeartbeat, JSON.stringify({
    workerId: 'linux-worker-1',
    status: 'busy',
    currentTask: 'proj_worker_guard_owner',
    uptime: 300,
  }), {});

  assert.strictEqual(resHeartbeat.statusCode, 200, 'ownership conflict heartbeat should be acknowledged');
  assert.strictEqual(resHeartbeat.payload.lostOwnership, true, 'heartbeat should tell stale worker to stop');
  assert.strictEqual(resHeartbeat.payload.assignedTo, 'linux-worker-2');
  assert.strictEqual(harnessHeartbeat.heartbeatCalls.length, 1, 'heartbeat should still be recorded');
  assert.strictEqual(harnessHeartbeat.heartbeatCalls[0].status, 'stale');
  assert.strictEqual(harnessHeartbeat.heartbeatCalls[0].currentTask, null);
  fs.rmSync(harnessHeartbeat.tmpRoot, { recursive: true, force: true });
}

{
  var validate = projectSM.validate('failed', 'spec_extracting');
  assert.strictEqual(validate.valid, true, 'failed projects should be allowed to re-enter spec_extracting on resubmit');
}

{
  var cancelledProjectValidate = projectSM.validate('cancelled', 'submitted');
  assert.strictEqual(cancelledProjectValidate.valid, true, 'cancelled projects should be allowed to resume via submit');
}

{
  var taskValidate = require('../lib/state-machine.cjs').taskSM.validate('processing', 'pending');
  assert.strictEqual(taskValidate.valid, true, 'processing tasks should be allowed to requeue to pending');
  var cancelledValidate = require('../lib/state-machine.cjs').taskSM.validate('cancelled', 'pending');
  assert.strictEqual(cancelledValidate.valid, true, 'cancelled tasks should be allowed to reuse the same task id on resubmit');
}

console.log('worker-status guard tests passed');
