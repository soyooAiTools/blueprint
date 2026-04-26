/**
 * Worker API handlers
 * Extracted from server.cjs — worker poll, status, heartbeat, upload-build
 */
var fs = require('fs');
var path = require('path');
var url = require('url');
var AdmZip = require('adm-zip');
var { projectSM } = require("../lib/state-machine.cjs");
var { clearCheckpoint } = require('../lib/checkpoint.cjs');

var PREQUEUE_PROJECT_STATUSES = ['spec_extracting', 'spec_review'];
var INACTIVE_TASK_STATUSES = ['pending', 'failed', 'done', 'cua_passed', 'completed', 'cancelled'];

function shouldDropWorkerReport(task, project, workerId, status, mappedStatus) {
  if (!task) return 'task not found';
  if (project && project.status === 'cancelled') return 'project cancelled';
  if (project && PREQUEUE_PROJECT_STATUSES.indexOf(project.status) >= 0) {
    return 'project not yet submitted';
  }
  if (task.assigned_to && workerId && task.assigned_to !== workerId) {
    return 'task currently assigned to ' + task.assigned_to;
  }
  if (!task.assigned_to && task.status === 'cua_passed' && status === 'done') {
    // `cua_passed` is an intermediate terminal-looking milestone inside the
    // worker pipeline. The same pipeline still runs upload afterwards, so its
    // final `done` report must be allowed to persist previewUrl/build status.
    return null;
  }
  if (!task.assigned_to && INACTIVE_TASK_STATUSES.indexOf(task.status) >= 0) {
    return 'task is ' + task.status + ' and unassigned';
  }
  if (project && project.status === 'failed') {
    if (task.status === 'failed') return 'project/task already failed';
    if (mappedStatus !== 'failed') return 'project already failed';
  }
  return null;
}

module.exports.init = function(ctx) {
  var taskQueue = ctx.taskQueue;
  var config = ctx.config;
  var sendJSON = ctx.sendJSON;
  var readProject = ctx.readProject;
  var writeProject = ctx.writeProject;

  var PORT = config.PORT;
  var WEBGL_DIR = config.WEBGL_DIR;

  return {
    workerPoll: function(req, res, body, params) {
      var parsedUrl = url.parse(req.url, true);
      var workerId = parsedUrl.query.workerId;

      if (!workerId) {
        return sendJSON(res, { error: 'workerId required' }, 400);
      }

      try {
        var task = taskQueue.claim(workerId);
        if (!task) {
          res.writeHead(204);
          res.end();
          return;
        }

        // Parse blueprint from task.blueprint_json
        var blueprint = task.blueprint_json ? JSON.parse(task.blueprint_json) : null;
        var metadata = task.metadata_json ? JSON.parse(task.metadata_json) : {};

        console.log('[Worker Poll] Assigned task ' + task.id + ' to worker ' + workerId);

        sendJSON(res, {
          taskId: task.id,
          projectName: task.project_name,
          blueprintEditorId: task.project_id,
          blueprintServerUrl: 'http://localhost:' + PORT,
          status: task.status,
          blueprint: blueprint,
          originalStatus: 'pending',
          source: 'blueprint-editor',
          // Include metadata for backward compatibility
          svnUrl: metadata.svnUrl || '',
          unityPort: metadata.unityPort || 18801,
          unityBridge: metadata.unityBridge || 'http://localhost:18801',
        });
      } catch (e) {
        console.error('[Worker Poll] Error: ' + e.message);
        sendJSON(res, { error: 'Poll failed: ' + e.message }, 500);
      }
    },

    getTaskBlueprint: function(req, res, body, params) {
      var taskId = params.taskId;
      try {
        var blueprint = taskQueue.getBlueprint(taskId);
        if (!blueprint) {
          return sendJSON(res, { error: 'Blueprint not found for task ' + taskId }, 404);
        }
        sendJSON(res, blueprint);
      } catch (e) {
        console.error('[Get Blueprint] Error: ' + e.message);
        sendJSON(res, { error: 'Failed to read blueprint: ' + e.message }, 500);
      }
    },

    getTaskStatus: function(req, res, body, params) {
      // Lightweight status probe used by the worker cancellation check.
      // Returns just {status, statusMessage, assignedTo} — no blueprint, no
      // metadata — so the worker can poll between stages without blowing up
      // response size. A missing task returns 404 so the worker can abort too.
      var taskId = params.taskId;
      try {
        var task = taskQueue.get(taskId);
        if (!task) {
          return sendJSON(res, { error: 'Task not found', taskId: taskId }, 404);
        }
        sendJSON(res, {
          taskId: task.id,
          status: task.status,
          statusMessage: task.status_message || null,
          assignedTo: task.assigned_to || null,
        });
      } catch (e) {
        console.error('[Get Task Status] Error: ' + e.message);
        sendJSON(res, { error: 'Status fetch failed: ' + e.message }, 500);
      }
    },

    cancelTask: function(req, res, body, params) {
      var taskId = params.taskId;
      try {
        var actor = 'api';
        var preserveCheckpoint = false;
        try {
          var parsed = body ? JSON.parse(body) : {};
          if (parsed && parsed.actor) actor = parsed.actor;
          preserveCheckpoint = !!(parsed && parsed.preserveCheckpoint);
        } catch(e) {}
        var task = taskQueue.get(taskId);
        if (!task) return sendJSON(res, { error: 'Task not found', taskId: taskId }, 404);
        taskQueue.cancel(taskId, actor);
        // Propagate to project JSON so dashboard reflects the change instantly
        // instead of waiting for the next watchdog cycle.
        try {
          var project = readProject(taskId);
          if (project) {
            projectSM.forceTransition(project, 'cancelled', actor);
            project.statusMessage = '[' + actor + '] Cancelled';
            writeProject(project);
          }
        } catch(e) {}
        if (!preserveCheckpoint) {
          // Wipe checkpoint. Without this, shutdown handler may re-serialize
          // the in-flight ctx, and the next resubmit with the same taskId will
          // silently resume completedStages and skip codegen.
          try {
            var cpResult = clearCheckpoint(taskId);
            if (cpResult.cleared) console.log('[Cancel Task] checkpoint cleared: ' + taskId);
          } catch(e) { console.warn('[Cancel Task] checkpoint clear failed: ' + e.message); }
        } else {
          console.log('[Cancel Task] checkpoint preserved for resumable cancel: ' + taskId);
        }
        console.log('[Cancel Task] ' + taskId + ' cancelled by ' + actor);
        sendJSON(res, { success: true, taskId: taskId, status: 'cancelled', checkpointPreserved: preserveCheckpoint });
      } catch (e) {
        console.error('[Cancel Task] Error: ' + e.message);
        sendJSON(res, { error: 'Cancel failed: ' + e.message }, 500);
      }
    },

    workerStatus: function(req, res, body, params) {
      try {
        var data = JSON.parse(body);
        var workerId = data.workerId;
        var taskId = data.taskId;
        var status = data.status;
        var message = data.message;

        if (!workerId || !taskId || !status) {
          return sendJSON(res, { error: 'workerId, taskId and status required' }, 400);
        }

        console.log('[Worker Status] ' + workerId + ' - Task ' + taskId + ': ' + status + (message ? ' (' + message + ')' : ''));

        var task = taskQueue.get(taskId);
        // Update project status if exists
        var project = readProject(taskId);
        var mappedStatus = (status === 'cua_passed' || status === 'done') ? 'reviewing' : status;
        var dropReason = shouldDropWorkerReport(task, project, workerId, status, mappedStatus);
        if (dropReason) {
          console.log('[Worker Status] Dropping stale report for task ' + taskId + ' (worker=' + workerId + ', reported=' + status + ', reason=' + dropReason + ')');
          return sendJSON(res, { success: true, taskId: taskId, status: status, dropped: true, reason: dropReason });
        }

        if (project) {
          // Cancelled is terminal — worker may still be unwinding mid-stage
          // and will fire one last status report. Drop it entirely so the
          // cancellation sticks (prior bug: round-9 'processing' report after
          // cancel resurrected the task into a 3rd hour of burning compute).
          if (project.status === 'cancelled') {
            console.log('[Worker Status] Dropping report for cancelled task ' + taskId + ' (worker=' + workerId + ', reported=' + status + ')');
            return sendJSON(res, { success: true, taskId: taskId, status: 'cancelled', dropped: true });
          }
          // Skip no-op transitions (e.g. worker reports 'processing' on every
          // fix round; project is already 'processing' or has progressed to
          // 'building'). Only transition forward, never regress.
          var isNoop = project.status === mappedStatus;
          var isRegression = (project.status === 'building' && mappedStatus === 'processing') ||
                             (project.status === 'developing' && mappedStatus === 'processing') ||
                             (project.status === 'preview_ready' && (mappedStatus === 'processing' || mappedStatus === 'building' || mappedStatus === 'developing')) ||
                             (project.status === 'reviewing' && (mappedStatus === 'processing' || mappedStatus === 'building' || mappedStatus === 'developing' || mappedStatus === 'preview_ready'));
          if (!isNoop && !isRegression) {
            projectSM.forceTransition(project, mappedStatus, 'worker-' + workerId);
          }
          if (message) project.statusMessage = message;
          project.updatedAt = new Date().toISOString();
          // Persist structured failure attribution
          if (status === 'failed') {
            project.lastFailure = {
              failedAtStage: data.failedAtStage || null,
              failReason: data.failReason ? String(data.failReason).substring(0, 500) : null,
              failClassification: data.failClassification || null,
              failedAt: data.failedAt || new Date().toISOString(),
              durationMs: data.durationMs || null,
              workerId: workerId,
            };
            // Accumulate failure history (keep last 10)
            if (!project.failureHistory) project.failureHistory = [];
            project.failureHistory.push(project.lastFailure);
            if (project.failureHistory.length > 10) project.failureHistory = project.failureHistory.slice(-10);
          }
          // Persist preview/build path as soon as preview is available.
          if ((status === 'preview_ready' || status === 'cua_passed' || status === 'done') && !project.webglPath) {
            var webglDir = path.join(WEBGL_DIR, taskId);
            var hasIframe = fs.existsSync(path.join(webglDir, 'iframe.html'));
            var buildFile = hasIframe ? 'iframe.html' : 'index.html';
            if (fs.existsSync(path.join(webglDir, buildFile))) {
              project.webglPath = '/webgl/' + taskId + '/' + buildFile;
              if (!project.buildCompletedAt) project.buildCompletedAt = new Date().toISOString();
            }
          }
          writeProject(project);
        }

        // Report to task queue (handles all retry logic internally)
        var result = taskQueue.report(taskId, status, {
          workerId: workerId,
          message: message,
          previewUrl: data.previewUrl,
          qualityData: data.qualityData,
        });

        // If result shows permanent fail, update project
        if (result && result.status === 'failed' && result.code_retry_count > 5) {
          if (project && project.status !== 'failed') {
            projectSM.forceTransition(project, 'failed', 'worker-permanent-fail');
            project.statusMessage = result.status_message;
            project.updatedAt = new Date().toISOString();
            writeProject(project);
          }
        }

        // If auto-retry (result.status === 'pending'), update project to submitted
        if (result && result.status === 'pending' && status === 'failed') {
          if (project) {
            projectSM.forceTransition(project, 'submitted', 'worker-auto-retry');
            project.statusMessage = result.status_message;
            project.updatedAt = new Date().toISOString();
            writeProject(project);
          }
        }

        sendJSON(res, { success: true, taskId: taskId, status: status });
      } catch (e) {
        console.error('[Worker Status] Error: ' + e.message);
        sendJSON(res, { error: 'Status update failed: ' + e.message }, 500);
      }
    },

    uploadBuild: function(req, res, body, params) {
      var taskId = params.taskId;
      console.log('[Upload Build] Receiving build for task:', taskId);

      // Read raw binary body
      var chunks = [];
      req.on('data', function(c) { chunks.push(c); });
      req.on('end', function() {
        try {
          var buffer = Buffer.concat(chunks);
          console.log('[Upload Build] Received ' + (buffer.length / 1024 / 1024).toFixed(1) + ' MB');

          // Extract zip to webgl dir
          var webglDir = path.join(WEBGL_DIR, taskId);
          if (fs.existsSync(webglDir)) fs.rmSync(webglDir, { recursive: true, force: true });
          fs.mkdirSync(webglDir, { recursive: true });

          var zip = new AdmZip(buffer);
          zip.extractAllTo(webglDir, true);
          console.log('[Upload Build] Extracted to:', webglDir);

          // Fix absolute paths to relative in HTML files (Luna uses absolute /static/, /favicon/ etc.)
          ['index.html', 'iframe.html'].forEach(function(htmlFile) {
            var htmlPath = path.join(webglDir, htmlFile);
            if (fs.existsSync(htmlPath)) {
              var content = fs.readFileSync(htmlPath, 'utf-8');
              content = content.replace(/href="\//g, 'href="./').replace(/src="\//g, 'src="./');
              // Fix Windows backslashes in paths (Luna on Windows generates backslash paths)
              content = content.replace(/src="([^"]*?)\\([^"]*?)"/g, function(m) { return m.replace(/\\/g, '/'); });
              fs.writeFileSync(htmlPath, content, 'utf-8');
              console.log('[Upload Build] Fixed paths in ' + htmlFile);
            }
          });

          // Update project status
          var project = readProject(taskId);
          var buildFile = fs.existsSync(path.join(webglDir, 'iframe.html')) ? 'iframe.html' : 'index.html';
          if (project) {
            projectSM.forceTransition(project, 'reviewing', 'upload-build');
            project.webglPath = '/webgl/' + taskId + '/' + buildFile;
            project.buildCompletedAt = new Date().toISOString();
            writeProject(project);
            console.log('[Upload Build] Project updated: status=reviewing, webglPath=' + project.webglPath);
          }

          sendJSON(res, {
            success: true,
            url: '/webgl/' + taskId + '/' + buildFile,
            webglPath: '/webgl/' + taskId + '/index.html',
          });

          // CUA verification is now done on Worker side (before upload)
          // Only verified builds reach this point
        } catch (e) {
          console.log('[Upload Build] Error:', e.message);
          sendJSON(res, { error: e.message }, 500);
        }
      });
      return; // don't let the normal body handler process this
    },

    workerHeartbeat: function(req, res, body, params) {
      try {
        var data = JSON.parse(body);
        var workerId = data.workerId;

        if (!workerId) {
          return sendJSON(res, { error: 'workerId required' }, 400);
        }

        var currentTask = data.currentTask;
        var currentTaskId = typeof currentTask === 'object'
          ? (currentTask && (currentTask.taskId || currentTask.id || null))
          : (currentTask || null);
        var ownerConflict = null;
        if (currentTaskId) {
          var currentTaskRow = taskQueue.get(currentTaskId);
          if (currentTaskRow && currentTaskRow.assigned_to && currentTaskRow.assigned_to !== workerId) {
            ownerConflict = {
              taskId: currentTaskId,
              assignedTo: currentTaskRow.assigned_to,
              status: currentTaskRow.status,
            };
          }
        }

        taskQueue.heartbeat(
          workerId,
          ownerConflict ? 'stale' : data.status,
          ownerConflict ? null : data.currentTask,
          data.uptime
        );

        console.log('[Worker Heartbeat] ' + workerId + ' - ' + (data.status || 'unknown') +
                    (data.currentTask ? ' (task: ' + (data.currentTask.taskId || data.currentTask) + ')' : ''));

        if (ownerConflict) {
          console.log('[Worker Heartbeat] Ownership lost: worker ' + workerId +
            ' reported task ' + ownerConflict.taskId + ' but assigned_to=' + ownerConflict.assignedTo);
          return sendJSON(res, {
            success: true,
            workerId: workerId,
            lostOwnership: true,
            taskId: ownerConflict.taskId,
            assignedTo: ownerConflict.assignedTo,
            status: ownerConflict.status,
          });
        }

        sendJSON(res, { success: true, workerId: workerId });
      } catch (e) {
        console.error('[Worker Heartbeat] Error: ' + e.message);
        sendJSON(res, { error: 'Heartbeat failed: ' + e.message }, 500);
      }
    },
  };
};
