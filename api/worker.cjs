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
        try { var parsed = body ? JSON.parse(body) : {}; if (parsed && parsed.actor) actor = parsed.actor; } catch(e) {}
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
        // Wipe checkpoint. Without this, shutdown handler may re-serialize
        // the in-flight ctx, and the next resubmit with the same taskId will
        // silently resume completedStages and skip codegen.
        try {
          var cpResult = clearCheckpoint(taskId);
          if (cpResult.cleared) console.log('[Cancel Task] checkpoint cleared: ' + taskId);
        } catch(e) { console.warn('[Cancel Task] checkpoint clear failed: ' + e.message); }
        console.log('[Cancel Task] ' + taskId + ' cancelled by ' + actor);
        sendJSON(res, { success: true, taskId: taskId, status: 'cancelled' });
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

        // Update project status if exists
        var project = readProject(taskId);
        if (project) {
          // Map cua_passed/done to reviewing — means ready for human review
          var mappedStatus = (status === 'cua_passed' || status === 'done') ? 'reviewing' : status;
          // Skip no-op transitions (e.g. worker reports 'processing' on every
          // fix round; project is already 'processing' or has progressed to
          // 'building'). Only transition forward, never regress.
          var isNoop = project.status === mappedStatus;
          var isRegression = (project.status === 'building' && mappedStatus === 'processing') ||
                             (project.status === 'developing' && mappedStatus === 'processing') ||
                             (project.status === 'reviewing' && (mappedStatus === 'processing' || mappedStatus === 'building' || mappedStatus === 'developing'));
          if (!isNoop && !isRegression) {
            projectSM.forceTransition(project, mappedStatus, 'worker-' + workerId);
          }
          if (message) project.statusMessage = message;
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
          // Set webglPath if not already set (CUA passed or done with build available)
          if ((status === 'cua_passed' || status === 'done') && !project.webglPath) {
            var webglDir = path.join(WEBGL_DIR, taskId);
            var hasIframe = fs.existsSync(path.join(webglDir, 'iframe.html'));
            var buildFile = hasIframe ? 'iframe.html' : 'index.html';
            if (fs.existsSync(path.join(webglDir, buildFile))) {
              project.webglPath = '/webgl/' + taskId + '/' + buildFile;
              project.buildCompletedAt = new Date().toISOString();
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
          if (project) {
            projectSM.forceTransition(project, 'failed', 'worker-permanent-fail');
            project.statusMessage = result.status_message;
            writeProject(project);
          }
        }

        // If auto-retry (result.status === 'pending'), update project to submitted
        if (result && result.status === 'pending' && status === 'failed') {
          if (project) {
            projectSM.forceTransition(project, 'submitted', 'worker-auto-retry');
            project.statusMessage = result.status_message;
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

        taskQueue.heartbeat(workerId, data.status, data.currentTask, data.uptime);

        console.log('[Worker Heartbeat] ' + workerId + ' - ' + (data.status || 'unknown') +
                    (data.currentTask ? ' (task: ' + (data.currentTask.taskId || data.currentTask) + ')' : ''));

        sendJSON(res, { success: true, workerId: workerId });
      } catch (e) {
        console.error('[Worker Heartbeat] Error: ' + e.message);
        sendJSON(res, { error: 'Heartbeat failed: ' + e.message }, 500);
      }
    },
  };
};
