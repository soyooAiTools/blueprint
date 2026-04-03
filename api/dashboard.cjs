/**
 * Dashboard API handlers
var { projectSM } = require("../lib/state-machine.cjs");
 * Extracted from server.cjs — dashboard stats, workers, tasks, watchdog
 */
var fs = require('fs');
var path = require('path');

module.exports.init = function(ctx) {
  var taskQueue = ctx.taskQueue;
  var config = ctx.config;
  var sendJSON = ctx.sendJSON;
  var readProject = ctx.readProject;
  var writeProject = ctx.writeProject;
  var parseStats = ctx.parseStats;
  var modelProvider = ctx.modelProvider;

  var PROJECTS_DIR = config.PROJECTS_DIR;

  // ─── Core watchdog cycle (shared by interval + manual trigger) ───
  function runWatchdogCycle(trigger) {
    var now = Date.now();
    var issues = [];
    var fixes = [];

    try {
      // Phase 1: SQLite task recovery (orphaned/stale tasks)
      var reclaimResult = taskQueue.reclaimStale(300, 180);
      issues = issues.concat(reclaimResult.issues);
      fixes = fixes.concat(reclaimResult.fixes);

      // Phase 2: Project ↔ Task desync
      var DESYNC_GRACE_MS = 60 * 1000;
      var allTasks = taskQueue.listForDashboard(50);
      allTasks.forEach(function(t) {
        var proj = readProject(t.taskId);
        if (!proj) return;
        var age = t.updatedAt ? now - new Date(t.updatedAt + 'Z').getTime() : 0;
        if (age < DESYNC_GRACE_MS) return;

        var needSync = false;
        var newProjStatus = null;

        if ((t.status === 'pending' || t.status === 'failed') &&
            (proj.status === 'processing' || proj.status === 'building')) {
          newProjStatus = t.status === 'failed' ? 'failed' : 'submitted';
          needSync = true;
        }
        if (t.status === 'done' && proj.status === 'processing') {
          newProjStatus = 'reviewing';
          needSync = true;
        }

        if (needSync && newProjStatus) {
          issues.push('[F14-desync] Project ' + t.taskId + ' "' + proj.status + '" but task "' + t.status + '"');
          projectSM.forceTransition(proj, newProjStatus, 'watchdog');
          proj.statusMessage = '[watchdog] Synced: task was ' + t.status;
          writeProject(proj);
          fixes.push('[fix] Project ' + t.taskId + ' → ' + newProjStatus);
        }
      });

      // Phase 3: Kill zombie child processes
      try {
        var execSync = require('child_process').execSync;
        var psOut = execSync("ps -eo pid,etimes,args 2>/dev/null | grep -E 'claude.*--print.*--max-budget|codex.*exec' | grep -v grep || true",
          { encoding: 'utf-8', timeout: 5000 });
        psOut.trim().split('\n').filter(Boolean).forEach(function(line) {
          var parts = line.trim().split(/\s+/);
          var pid = parseInt(parts[0]);
          var elapsedSec = parseInt(parts[1]);
          if (isNaN(pid) || isNaN(elapsedSec)) return;
          if (elapsedSec > 900) {
            issues.push('[F10-zombie] PID ' + pid + ' running ' + Math.round(elapsedSec/60) + 'min');
            try {
              process.kill(pid, 'SIGTERM');
              fixes.push('[fix] SIGTERM → PID ' + pid);
            } catch(e) {}
          }
        });
      } catch(e) {}

      // Phase 4: Infrastructure checks
      try {
        var execSync3 = require('child_process').execSync;
        var buildCheck = execSync3('curl -s --max-time 3 http://localhost:3080/health 2>/dev/null || echo "FAIL"',
          { encoding: 'utf-8', timeout: 5000 }).trim();
        if (buildCheck === 'FAIL' || !buildCheck.includes('ok')) {
          issues.push('[F12-build] Build service (linux-bridge-build:3080) is unreachable');
          try {
            execSync3('pm2 restart linux-build 2>/dev/null', { timeout: 10000 });
            fixes.push('[fix] Restarted linux-build service');
          } catch(e) {}
        }
      } catch(e) {}

      // Phase 5: PM2 crash-loop detection
      try {
        var execSync4 = require('child_process').execSync;
        var pm2Json = execSync4('pm2 jlist 2>/dev/null', { encoding: 'utf-8', timeout: 5000 });
        var pm2Data = JSON.parse(pm2Json);
        pm2Data.forEach(function(p) {
          if (p.name.indexOf('linux-worker') !== 0) return;
          var env = p.pm2_env || {};
          if (env.status === 'online' && env.restart_time > 20) {
            var uptimeMs = Date.now() - (env.pm_uptime || Date.now());
            if (uptimeMs < 300000 && env.restart_time > 3) {
              issues.push('[F9-crash-loop] ' + p.name + ' restarted ' + env.restart_time + ' times');
              try {
                execSync4('pm2 stop ' + p.name + ' 2>/dev/null', { timeout: 5000 });
                fixes.push('[fix] Stopped crash-looping ' + p.name);
              } catch(e) {}
            }
          }
        });
      } catch(e) {}

    } catch (e) {
      issues.push('[error] Watchdog cycle error: ' + e.message);
    }

    return { trigger: trigger, timestamp: new Date().toISOString(), issues: issues, fixes: fixes, healthy: issues.length === 0, issueCount: issues.length, fixCount: fixes.length };
  }

  return {
    getDashboard: function(req, res, body, params) {
      var stats = taskQueue.stats();
      sendJSON(res, stats);
    },

    getWorkers: function(req, res, body, params) {
      var rawWorkers = taskQueue.getWorkers();
      var workers = rawWorkers.map(function(w) {
        var ct = w.current_task;
        var parsedTask = null;
        if (ct) {
          try { parsedTask = JSON.parse(ct); } catch(e) { parsedTask = ct; }
        }
        return {
          workerId: w.worker_id,
          status: w.status || 'unknown',
          currentTask: parsedTask ? (typeof parsedTask === 'string' ? parsedTask : parsedTask.taskId || parsedTask) : null,
          currentTaskName: parsedTask && parsedTask.projectName ? parsedTask.projectName : null,
          ip: w.ip || null,
          port: w.port || null,
          lastHeartbeat: w.last_seen ? new Date(w.last_seen + 'Z').getTime() : null,
          registeredAt: w.last_seen ? new Date(w.last_seen + 'Z').getTime() : null,
          uptime: w.uptime || 0,
        };
      });
      sendJSON(res, { workers: workers });
    },

    getTasks: function(req, res, body, params) {
      var u = new URL(req.url, 'http://localhost');
      var limit = parseInt(u.searchParams.get('limit')) || 30;
      var rawTasks = taskQueue.listForDashboard(limit);
      var tasks = rawTasks.map(function(t) {
        return {
          taskId: t.taskId,
          projectName: t.projectName || '-',
          status: t.status || 'pending',
          statusMessage: t.statusMessage || null,
          workerId: t.workerId || null,
          progress: 0,
          createdAt: t.createdAt ? new Date(t.createdAt + 'Z').getTime() : null,
          updatedAt: t.updatedAt ? new Date(t.updatedAt + 'Z').getTime() : null,
        };
      });
      sendJSON(res, { tasks: tasks });
    },

    getDashboardStats: function(req, res, body, params) {
      var now = Date.now();
      var onlineThreshold = 90000;

      // Get comprehensive stats from TaskQueue
      var dbStats = taskQueue.dashboardStats();

      // Project stats (still from filesystem)
      var projectStats = { total: 0, editing: 0, submitted: 0, reviewing: 0, approved: 0, feedback: 0, committed: 0, failed: 0 };
      try {
        if (fs.existsSync(PROJECTS_DIR)) {
          fs.readdirSync(PROJECTS_DIR).filter(function(f) { return f.endsWith('.json'); }).forEach(function(f) {
            try {
              var p = JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, f), 'utf-8'));
              projectStats.total++;
              var s = p.status || 'editing';
              if (projectStats[s] !== undefined) projectStats[s]++;
              else projectStats[s] = 1;
            } catch(e) {}
          });
        }
      } catch(e) {}

      // Parse stats (unchanged)
      var avgTimeMs = parseStats.success > 0 ? Math.round(parseStats.totalTimeMs / parseStats.success) : 0;
      var last24h = parseStats.history.filter(function(h) { return h.timestamp > now - 86400000; });
      var last24hSuccess = last24h.filter(function(h) { return h.success; }).length;
      var last24hFailed = last24h.filter(function(h) { return !h.success; }).length;
      var successRate = parseStats.total > 0 ? Math.round(parseStats.success / parseStats.total * 100) : 0;

      // Quality gate stats from recent tasks
      var qualityStats = { reviewPassed: 0, reviewFailed: 0, quickTestPassed: 0, quickTestFailed: 0, cuaPassed: 0, cuaFailed: 0, totalCuaRounds: 0, cuaCount: 0 };
      (dbStats.recentTasks || []).forEach(function(t) {
        var meta = {};
        try { meta = JSON.parse(t.metadataJson || '{}'); } catch(e) {}
        if (meta.reviewResult === 'pass') qualityStats.reviewPassed++;
        else if (meta.reviewResult === 'fail') qualityStats.reviewFailed++;
        if (meta.quickTestResult === 'pass') qualityStats.quickTestPassed++;
        else if (meta.quickTestResult === 'fail') qualityStats.quickTestFailed++;
        if (meta.cuaResult === 'pass') qualityStats.cuaPassed++;
        else if (meta.cuaResult === 'fail') qualityStats.cuaFailed++;
        if (meta.cuaRetries > 0) { qualityStats.totalCuaRounds += meta.cuaRetries; qualityStats.cuaCount++; }
      });

      // Map worker list for backward compatibility
      var workerList = (dbStats.workers.list || []).map(function(w) {
        var lastHbMs = w.lastSeen ? new Date(w.lastSeen + 'Z').getTime() : null;
        var isOnline = lastHbMs && (now - lastHbMs) < onlineThreshold;
        var ct = w.currentTask;
        var parsedTask = null;
        if (ct) { try { parsedTask = JSON.parse(ct); } catch(e) { parsedTask = ct; } }
        return {
          workerId: w.workerId,
          status: isOnline ? (w.status || 'idle') : 'offline',
          currentTask: parsedTask ? (typeof parsedTask === 'string' ? parsedTask : parsedTask.taskId || null) : null,
          currentTaskName: parsedTask && parsedTask.projectName ? parsedTask.projectName : null,
          lastHeartbeat: lastHbMs,
          uptime: w.uptime || 0,
        };
      });

      // Map recent tasks for backward compat
      var recentTasks = (dbStats.recentTasks || []).slice(0, 10).map(function(t) {
        var meta = {};
        try { meta = JSON.parse(t.metadataJson || '{}'); } catch(e) {}
        var timeline = [];
        try { timeline = JSON.parse(t.timelineJson || '[]'); } catch(e) {}
        return {
          taskId: t.taskId,
          projectName: t.projectName || '-',
          status: t.status || 'pending',
          statusMessage: t.statusMessage || null,
          previewUrl: t.previewUrl || null,
          workerId: t.workerId || null,
          progress: 0,
          createdAt: t.createdAt ? new Date(t.createdAt + 'Z').getTime() : null,
          updatedAt: t.updatedAt ? new Date(t.updatedAt + 'Z').getTime() : null,
          timeline: timeline.slice(-20),
          reviewResult: meta.reviewResult || null,
          quickTestResult: meta.quickTestResult || null,
          cuaResult: meta.cuaResult || null,
          cuaRetries: meta.cuaRetries || 0,
        };
      });

      sendJSON(res, {
        workers: {
          total: dbStats.workers.total,
          online: dbStats.workers.online,
          offline: dbStats.workers.offline,
          list: workerList,
        },
        tasks: dbStats.tasks,
        recentTasks: recentTasks,
        projects: projectStats,
        quality: {
          reviewPassed: qualityStats.reviewPassed,
          reviewFailed: qualityStats.reviewFailed,
          quickTestPassed: qualityStats.quickTestPassed,
          quickTestFailed: qualityStats.quickTestFailed,
          cuaPassed: qualityStats.cuaPassed,
          cuaFailed: qualityStats.cuaFailed,
          avgCuaRounds: qualityStats.cuaCount > 0 ? Math.round(qualityStats.totalCuaRounds / qualityStats.cuaCount * 10) / 10 : 0,
        },
        parse: {
          total: parseStats.total,
          success: parseStats.success,
          failed: parseStats.failed,
          successRate: successRate,
          avgTimeMs: avgTimeMs,
          avgTimeSec: Math.round(avgTimeMs / 1000),
          last24h: { success: last24hSuccess, failed: last24hFailed },
          recentHistory: parseStats.history.slice(-10).reverse(),
        },
      });
    },

    getApiHealth: async function(req, res, body, params) {
      var results = {};
      // Health checks via modelProvider abstraction
      try {
        var mpResults = await modelProvider.healthCheck();
        Object.assign(results, mpResults);
      } catch(e) {
        results.healthCheckError = e.message;
      }
      // Blueprint server uptime
      results.server = { status: 'ok', uptimeMs: process.uptime() * 1000, uptimeHuman: Math.round(process.uptime() / 3600) + 'h' };

      sendJSON(res, results);
    },

    getWatchdogStatus: function(req, res, body, params) {
      try {
        var now = Date.now();
        var report = {
          timestamp: new Date().toISOString(),
          tasks: [], workers: [], issues: [], infrastructure: {},
          healthy: true
        };

        // ── Tasks from SQLite ──
        var allTasks = taskQueue.listForDashboard(50);
        allTasks.forEach(function(t) {
          var proj = readProject(t.taskId);
          var age = t.updatedAt ? Math.round((now - new Date(t.updatedAt + 'Z').getTime()) / 1000) : -1;
          var entry = {
            taskId: t.taskId,
            projectName: t.projectName || '?',
            taskStatus: t.status,
            projectStatus: proj ? proj.status : '?',
            assignedTo: t.workerId || null,
            failCount: t.failCount || 0,
            ageSeconds: age,
            statusMessage: (t.statusMessage || '').slice(0, 120),
            synced: true
          };
          // Check desync
          if (proj) {
            var taskS = t.status, projS = proj.status;
            var validCombos = {
              pending: ['submitted'], assigned: ['processing'], processing: ['processing', 'building'],
              building: ['processing', 'building'], failed: ['failed'],
              done: ['reviewing', 'committed', 'done'], cua_passed: ['reviewing']
            };
            var allowed = validCombos[taskS] || [];
            if (taskS !== projS && allowed.indexOf(projS) === -1) {
              entry.synced = false;
              entry.desyncDetail = 'task=' + taskS + ' project=' + projS;
            }
          }
          report.tasks.push(entry);
        });

        // ── Workers from SQLite ──
        var rawWorkers = taskQueue.getWorkers();
        rawWorkers.forEach(function(w) {
          var lastSeenMs = w.last_seen ? new Date(w.last_seen + 'Z').getTime() : 0;
          var ageS = Math.round((now - lastSeenMs) / 1000);
          report.workers.push({
            workerId: w.worker_id,
            heartbeatStatus: w.status,
            currentTask: w.current_task,
            alive: ageS < 180,
            lastSeenAgo: ageS + 's'
          });
        });

        // ── Infrastructure ──
        try {
          var execSync = require('child_process').execSync;
          var pm2Json = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf-8', timeout: 5000 });
          var pm2Data = JSON.parse(pm2Json);
          var stoppedWorkers = pm2Data.filter(function(p) {
            return p.name.indexOf('linux-worker') === 0 && p.pm2_env && p.pm2_env.status === 'stopped';
          }).map(function(p) { return p.name; });
          report.infrastructure.stoppedWorkers = stoppedWorkers;
          report.infrastructure.totalWorkerProcesses = pm2Data.filter(function(p) { return p.name.indexOf('linux-worker') === 0; }).length;
          report.infrastructure.activeWorkerProcesses = pm2Data.filter(function(p) {
            return p.name.indexOf('linux-worker') === 0 && p.pm2_env && p.pm2_env.status === 'online';
          }).length;
        } catch(e) {
          report.infrastructure.pm2Error = e.message;
        }
        try {
          var execSync2 = require('child_process').execSync;
          var zombieOut = execSync2("ps -eo pid,etimes,args 2>/dev/null | grep -E 'claude.*--print.*--max-budget|codex.*exec' | grep -v grep || true", { encoding: 'utf-8', timeout: 5000 });
          var zombies = zombieOut.trim().split('\n').filter(Boolean).map(function(line) {
            var p = line.trim().split(/\s+/);
            return { pid: parseInt(p[0]), runningSec: parseInt(p[1]), cmd: p.slice(2).join(' ').slice(0, 80) };
          });
          report.infrastructure.childProcesses = zombies;
        } catch(e) {}

        // ── Diagnose Issues ──
        report.tasks.forEach(function(t) {
          if (!t.synced) report.issues.push({ type: 'desync', taskId: t.taskId, detail: t.desyncDetail });
        });
        if (report.infrastructure.childProcesses) {
          report.infrastructure.childProcesses.forEach(function(z) {
            if (z.runningSec > 900) report.issues.push({ type: 'zombie-process', pid: z.pid, detail: 'running ' + Math.round(z.runningSec/60) + 'min' });
          });
        }

        report.healthy = report.issues.length === 0;
        sendJSON(res, report);
      } catch (e) {
        sendJSON(res, { error: 'Watchdog status failed: ' + e.message }, 500);
      }
    },

    runWatchdog: function(req, res, body, params) {
      try {
        console.log('[Watchdog] Manual run triggered via API');
        var result = runWatchdogCycle('manual');
        sendJSON(res, result);
      } catch (e) {
        sendJSON(res, { error: 'Watchdog run failed: ' + e.message }, 500);
      }
    },

    // Expose for server.cjs interval usage
    runWatchdogCycle: runWatchdogCycle,
  };
};
