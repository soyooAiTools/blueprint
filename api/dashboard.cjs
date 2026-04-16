/**
 * Dashboard API handlers
 * Extracted from server.cjs — dashboard stats, workers, tasks, watchdog
 */
var fs = require('fs');
var path = require('path');
var { projectSM } = require('../lib/state-machine.cjs');

// API health cache — healthCheck() pings Doubao (5-6s) + Claude (0.4s) for
// every request. Front-end calls this on dashboard load, blocking first render
// ~6s. Cache results with background refresh so the endpoint returns instantly.
var apiHealthCache = { data: null, ts: 0, inflight: null };
var API_HEALTH_TTL_MS = 60 * 1000;

module.exports.init = function(ctx) {
  var taskQueue = ctx.taskQueue;
  var config = ctx.config;
  var sendJSON = ctx.sendJSON;
  var readProject = ctx.readProject;
  var writeProject = ctx.writeProject;
  var parseStats = ctx.parseStats;
  var modelProvider = ctx.modelProvider;

  var PROJECTS_DIR = config.PROJECTS_DIR;

  // Refresh apiHealthCache in the background — never awaited from the request
  // path, so the endpoint always returns the last known snapshot instantly.
  function refreshApiHealth() {
    if (apiHealthCache.inflight) return apiHealthCache.inflight;
    apiHealthCache.inflight = Promise.resolve()
      .then(function() { return modelProvider.healthCheck(); })
      .then(function(mpResults) {
        apiHealthCache.data = mpResults || {};
        apiHealthCache.ts = Date.now();
      })
      .catch(function(e) {
        // Keep stale data; just record the error so the dashboard can show it.
        if (!apiHealthCache.data) apiHealthCache.data = {};
        apiHealthCache.data.healthCheckError = e && e.message ? e.message : String(e);
        apiHealthCache.ts = Date.now();
      })
      .then(function() { apiHealthCache.inflight = null; });
    return apiHealthCache.inflight;
  }
  // Prime the cache on init + schedule periodic refresh so the dashboard never
  // sees a cold cache after the server has been running > 30s.
  refreshApiHealth();
  setInterval(refreshApiHealth, 30 * 1000);

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

      // Phase 2: Project ↔ Task desync — mapping from task status to the project
      // status that should reflect it. Only sync if the current project status
      // isn't already in the "compatible" set (e.g. a task in 'processing' may
      // legitimately correspond to project 'processing' or 'building').
      // Previously this only covered 3 cases and left cancelled/permanent_fail
      // projects stuck on stale 'processing' — visible as "dashboard didn't sync".
      var DESYNC_GRACE_MS = 60 * 1000;
      // Query all non-cancelled tasks AND a batch of cancelled ones so we can
      // propagate cancellation to project files too.
      var allTasks = taskQueue.listForDashboard(50);
      var cancelledTasks = taskQueue.list('cancelled') || [];
      cancelledTasks.forEach(function(t) {
        allTasks.push({
          taskId: t.id,
          status: t.status,
          updatedAt: t.updated_at,
        });
      });

      // Task → project status mapping. `target` is what the project should
      // become; `compatible` lists project states that are considered already
      // in-sync and should NOT be touched.
      var TASK_TO_PROJECT = {
        pending:     { target: 'submitted', compatible: ['submitted', 'pending', 'assigned'] },
        assigned:    { target: 'processing', compatible: ['assigned', 'processing', 'building', 'developing'] },
        processing:  { target: 'processing', compatible: ['processing', 'building', 'developing'] },
        building:    { target: 'building',   compatible: ['building', 'processing'] },
        fix_needed:  { target: 'processing', compatible: ['processing', 'building'] },
        failed:      { target: 'failed',     compatible: ['failed'] },
        done:        { target: 'reviewing',  compatible: ['reviewing', 'approved', 'committed'] },
        cua_passed:  { target: 'reviewing',  compatible: ['reviewing', 'approved', 'committed'] },
        completed:   { target: 'reviewing',  compatible: ['reviewing', 'approved', 'committed'] },
        cancelled:   { target: 'cancelled',  compatible: ['cancelled', 'committed'] },
      };

      allTasks.forEach(function(t) {
        var proj = readProject(t.taskId);
        if (!proj) return;
        var age = t.updatedAt ? now - new Date(t.updatedAt + 'Z').getTime() : 0;
        // Cancelled tasks should sync immediately (no grace period — manual
        // cancellations need to propagate to the UI within one watchdog cycle).
        if (t.status !== 'cancelled' && age < DESYNC_GRACE_MS) return;

        var mapping = TASK_TO_PROJECT[t.status];
        if (!mapping) return;
        if (mapping.compatible.indexOf(proj.status) >= 0) return;

        issues.push('[F14-desync] Project ' + t.taskId + ' "' + proj.status + '" but task "' + t.status + '"');
        projectSM.forceTransition(proj, mapping.target, 'watchdog');
        proj.statusMessage = '[watchdog] Synced: task was ' + t.status;
        writeProject(proj);
        fixes.push('[fix] Project ' + t.taskId + ' → ' + mapping.target + ' (task=' + t.status + ')');
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

      // Phase 6: Regression watcher (L3)
      // Scan latest 100 metrics records. For each failure fingerprint we
      // compute, ask bindKnowledge if it has a resolvedBy/resolvedAt. If a
      // record's timestamp is AFTER the resolvedAt (i.e. "fixed 2 days ago but
      // happened again today"), flag it as a regression.
      //
      // Regressions are persisted to server-data/regressions.json (upsert
      // by fingerprint) and optionally pushed to 飞书 via the existing
      // feishu-notify.js bot. Throttled: we only fire a 飞书 alert once per
      // 30 minutes per fingerprint to avoid paging spam.
      try {
        var metricsModule = require('../engine/metrics.cjs');
        var fpModule = require('../engine/failure-fingerprint.cjs');
        var records = metricsModule.loadRecords(100);
        var regFile = path.join(__dirname, '..', 'server-data', 'regressions.json');
        var existing = [];
        try {
          if (fs.existsSync(regFile)) existing = JSON.parse(fs.readFileSync(regFile, 'utf-8')) || [];
        } catch(e) { existing = []; }
        var byFp = {};
        existing.forEach(function(r) { byFp[r.fingerprint] = r; });

        var failedRecords = records.filter(function(r) { return !r.success && r.failReason; });
        var fpToRecords = {};
        failedRecords.forEach(function(fr) {
          var fp = metricsModule.normalizeFingerprint(fr.failReason);
          if (!fpToRecords[fp]) fpToRecords[fp] = [];
          fpToRecords[fp].push(fr);
        });

        var NOTIFY_THROTTLE_MS = 30 * 60 * 1000;
        var changed = false;

        Object.keys(fpToRecords).forEach(function(fp) {
          var frs = fpToRecords[fp];
          var kb;
          try { kb = fpModule.bindKnowledge(fp); } catch(e) { return; }
          if (!kb.resolvedBy || !kb.resolvedAt) return;
          var resolvedAtMs = new Date(kb.resolvedAt).getTime();
          if (!resolvedAtMs) return;
          // Find records that occurred strictly AFTER resolvedAt
          var postFix = frs.filter(function(r) {
            return r.timestamp && new Date(r.timestamp).getTime() > resolvedAtMs;
          });
          if (postFix.length === 0) return;

          var latestTs = postFix.reduce(function(acc, r) {
            return !acc || r.timestamp > acc ? r.timestamp : acc;
          }, null);

          var prev = byFp[fp];
          var reg = {
            fingerprint: fp,
            sampleReason: frs[0].failReason.slice(0, 200),
            resolvedBy: kb.resolvedBy,
            resolvedAt: kb.resolvedAt,
            regressedAt: latestTs,
            count: postFix.length,
            firstRegressedAt: prev ? prev.firstRegressedAt || latestTs : latestTs,
            notifiedAt: prev ? prev.notifiedAt : null,
          };
          byFp[fp] = reg;
          changed = true;

          issues.push('[F20-regression] ' + fp.slice(0, 60) + ' (resolved ' + kb.resolvedBy.slice(0,7) + ', ' + postFix.length + ' new hits)');
          fixes.push('[info] Logged regression → server-data/regressions.json');

          // Throttled 飞书 notification
          var lastNotified = prev && prev.notifiedAt ? new Date(prev.notifiedAt).getTime() : 0;
          if (now - lastNotified > NOTIFY_THROTTLE_MS) {
            try {
              var feishu = require('../worker/feishu-notify.js');
              feishu.send(frs[0].taskId || 'regression', 'stuck',
                '[Regression] ' + fp.slice(0, 80) + '\n' +
                '先前由 ' + kb.resolvedBy.slice(0, 7) + ' 修复\n' +
                '命中 ' + postFix.length + ' 次\n' +
                '最近: ' + latestTs,
                { fingerprint: fp, resolvedBy: kb.resolvedBy }
              ).catch(function() {});
              byFp[fp].notifiedAt = new Date().toISOString();
            } catch(e) {}
          }
        });

        if (changed) {
          try {
            fs.mkdirSync(path.dirname(regFile), { recursive: true });
            fs.writeFileSync(regFile, JSON.stringify(Object.keys(byFp).map(function(k) { return byFp[k]; }), null, 2));
          } catch(e) {}
        }
      } catch(e) {
        issues.push('[error] Regression watcher failed: ' + e.message);
      }

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

    getApiHealth: function(req, res, body, params) {
      // Serve from cache (populated by refreshApiHealth on init + 30s interval).
      // If the cache is stale, trigger a background refresh but still return the
      // stale data — never block the request. First load after server start may
      // get an empty snapshot; the periodic refresh backfills within ~6s.
      var results = {};
      if (apiHealthCache.data) Object.assign(results, apiHealthCache.data);
      var age = Date.now() - apiHealthCache.ts;
      if (age > API_HEALTH_TTL_MS) refreshApiHealth();
      results._cachedAt = apiHealthCache.ts || null;
      results._cacheAgeMs = apiHealthCache.ts ? age : null;
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

    getPipelineMetrics: function(req, res, body, params) {
      try {
        var u = new URL(req.url, 'http://localhost');
        var lastN = parseInt(u.searchParams.get('last')) || 50;
        var { getMetricsSummary } = require('../engine/metrics.cjs');
        var { bindKnowledge } = require('../engine/failure-fingerprint.cjs');
        var summary = getMetricsSummary(lastN);

        // L2: decorate each top fingerprint with memory/git/recipe binding.
        // Swallow errors per-fingerprint so a git failure doesn't 500 the whole
        // dashboard — we still want the raw metrics to render.
        if (summary.topFailReasons) {
          summary.topFailReasons.forEach(function(fp) {
            try { fp.knowledge = bindKnowledge(fp.fingerprint); }
            catch(e) { fp.knowledge = { error: e.message }; }
          });
        }

        // Also load recent failure history from projects
        var projectFailures = [];
        try {
          if (fs.existsSync(PROJECTS_DIR)) {
            fs.readdirSync(PROJECTS_DIR).filter(function(f) { return f.endsWith('.json'); }).forEach(function(f) {
              try {
                var p = JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, f), 'utf-8'));
                if (p.lastFailure) {
                  projectFailures.push({
                    projectId: p.id,
                    projectName: p.name,
                    status: p.status,
                    lastFailure: p.lastFailure,
                    failureCount: p.failureHistory ? p.failureHistory.length : 0,
                  });
                }
              } catch(e) {}
            });
          }
        } catch(e) {}

        // L3: read regressions.json so the dashboard surfaces active regressions
        // next to the metrics. Written by runWatchdogCycle's regression phase.
        var regressions = [];
        try {
          var regFile = path.join(__dirname, '..', 'server-data', 'regressions.json');
          if (fs.existsSync(regFile)) {
            var regs = JSON.parse(fs.readFileSync(regFile, 'utf-8'));
            // Only surface regressions from the last 7 days — older ones clutter
            // the dashboard and probably mean the detection rule is too loose
            var weekAgo = Date.now() - 7 * 86400 * 1000;
            regressions = (regs || []).filter(function(r) {
              return r.regressedAt && new Date(r.regressedAt).getTime() > weekAgo;
            });
          }
        } catch(e) {}

        sendJSON(res, {
          pipeline: summary,
          projectFailures: projectFailures,
          regressions: regressions,
        });
      } catch(e) {
        sendJSON(res, { error: e.message }, 500);
      }
    },

    getRegressions: function(req, res, body, params) {
      try {
        var regFile = path.join(__dirname, '..', 'server-data', 'regressions.json');
        var data = [];
        if (fs.existsSync(regFile)) {
          data = JSON.parse(fs.readFileSync(regFile, 'utf-8')) || [];
        }
        sendJSON(res, { regressions: data, count: data.length });
      } catch(e) {
        sendJSON(res, { error: e.message }, 500);
      }
    },

    runAutoFix: function(req, res, body, params) {
      try {
        var autoFix = require('../engine/auto-fix.cjs');
        autoFix.applyRecipe(params.fingerprintId)
          .then(function(result) { sendJSON(res, result); })
          .catch(function(e) { sendJSON(res, { error: e.message }, 500); });
      } catch(e) {
        sendJSON(res, { error: e.message }, 500);
      }
    },

    /**
     * POST /api/dashboard/reset-stats
     * Body (optional): { parse?:bool, tasks?:bool, metrics?:bool, archive?:bool }
     * Defaults: all true except tasks (requires explicit opt-in — destructive).
     *
     * Clears in-memory + on-disk "historical" counters without restarting the server.
     * Safe because: parseStats is mutated by reference (shared with server.cjs);
     * cancelled tasks are deleted directly via SQL; metrics file is renamed, not deleted.
     *
     * IMPORTANT: we NEVER delete the currently-running task. It's detected by status
     * filter (status NOT IN ('cancelled','completed','failed')) — anything mid-pipeline
     * is preserved.
     */
    resetStats: function(req, res, body, params) {
      var opts = {};
      if (body) {
        try { opts = JSON.parse(body) || {}; } catch(e) { opts = {}; }
      }
      if (opts.parse === undefined) opts.parse = true;
      if (opts.metrics === undefined) opts.metrics = true;
      if (opts.archive === undefined) opts.archive = true;
      // tasks is OPT-IN (explicit) because deleting DB rows is more destructive
      if (opts.tasks === undefined) opts.tasks = false;

      var report = {};

      // 1. parseStats — mutate in place so both memory & disk update
      if (opts.parse) {
        try {
          parseStats.total = 0;
          parseStats.success = 0;
          parseStats.failed = 0;
          parseStats.totalTimeMs = 0;
          parseStats.history.length = 0;
          fs.writeFileSync(config.PARSE_STATS_FILE, JSON.stringify(parseStats, null, 2));
          report.parse = 'reset (in-memory + disk)';
        } catch(e) {
          report.parse = 'error: ' + e.message;
        }
      }

      // 2. Cancelled task rows — opt-in only
      if (opts.tasks) {
        try {
          var db = taskQueue.db;
          // Keep anything that could still be running (processing/pending/etc.)
          var terminal = ['cancelled', 'completed', 'failed'];
          var placeholders = terminal.map(function() { return '?'; }).join(',');
          var histStmt = db.prepare(
            'DELETE FROM task_history WHERE task_id IN (SELECT id FROM tasks WHERE status IN (' + placeholders + '))'
          );
          var taskStmt = db.prepare(
            'DELETE FROM tasks WHERE status IN (' + placeholders + ')'
          );
          var deletedHistory = histStmt.run.apply(histStmt, terminal).changes;
          var deletedTasks = taskStmt.run.apply(taskStmt, terminal).changes;
          report.tasks = 'deleted ' + deletedTasks + ' tasks, ' + deletedHistory + ' history rows';
        } catch(e) {
          report.tasks = 'error: ' + e.message;
        }
      }

      // 3. pipeline-metrics.jsonl → archive (rename, never delete)
      if (opts.metrics) {
        try {
          var metricsFile = path.join(__dirname, '..', 'server-data', 'metrics', 'pipeline-metrics.jsonl');
          if (fs.existsSync(metricsFile)) {
            var stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
            fs.renameSync(metricsFile, metricsFile + '.bak.' + stamp);
            report.metrics = 'archived to pipeline-metrics.jsonl.bak.' + stamp;
          } else {
            report.metrics = 'no file to archive';
          }
          // Also clear regressions.json since stale resolvedBy links confuse L3
          var regFile = path.join(__dirname, '..', 'server-data', 'regressions.json');
          if (fs.existsSync(regFile)) {
            fs.writeFileSync(regFile, '[]');
            report.regressions = 'reset to []';
          }
        } catch(e) {
          report.metrics = 'error: ' + e.message;
        }
      }

      sendJSON(res, { ok: true, report: report, note: 'tasks deletion is opt-in via body {"tasks":true}' });
    },

    // Expose for server.cjs interval usage
    runWatchdogCycle: runWatchdogCycle,
  };
};
