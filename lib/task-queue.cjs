/**
 * TaskQueue — SQLite-backed task queue replacing file-based autoCoding-tasks/queue/
 *
 * Features:
 *   - Atomic claim (no race conditions between workers)
 *   - Persistent state (no in-memory claimedTasks map needed)
 *   - Full status history (task_history table)
 *   - Worker heartbeat tracking (worker_heartbeats table)
 *   - Infrastructure vs code failure split retry
 *   - Watchdog stale-task recovery
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { taskSM } = require('./state-machine.cjs');

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'server-data', 'blueprint.db');
const MAX_INFRA_RETRIES = 5;
const MAX_CODE_RETRIES = 5;

class TaskQueue {
  constructor(dbPath) {
    dbPath = dbPath || DEFAULT_DB_PATH;
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    this._initSchema();
    this._prepareStatements();
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id              TEXT PRIMARY KEY,
        project_id      TEXT NOT NULL,
        project_name    TEXT DEFAULT '',
        status          TEXT NOT NULL DEFAULT 'pending',
        assigned_to     TEXT,
        assigned_at     TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
        fail_count      INTEGER DEFAULT 0,
        infra_retry_count INTEGER DEFAULT 0,
        code_retry_count  INTEGER DEFAULT 0,
        retry_after     INTEGER,
        status_message  TEXT,
        preview_url     TEXT,
        blueprint_json  TEXT,
        metadata_json   TEXT,
        timeline_json   TEXT DEFAULT '[]'
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to);

      CREATE TABLE IF NOT EXISTS task_history (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id     TEXT NOT NULL,
        from_status TEXT,
        to_status   TEXT NOT NULL,
        actor       TEXT,
        message     TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_history_task ON task_history(task_id);

      CREATE TABLE IF NOT EXISTS worker_heartbeats (
        worker_id    TEXT PRIMARY KEY,
        status       TEXT NOT NULL DEFAULT 'unknown',
        current_task TEXT,
        uptime       REAL DEFAULT 0,
        ip           TEXT,
        port         INTEGER,
        last_seen    TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  _prepareStatements() {
    this._stmts = {
      getTask: this.db.prepare('SELECT * FROM tasks WHERE id = ?'),
      getTasksByStatus: this.db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC'),
      getAllTasks: this.db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC'),
      getRecentTasks: this.db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?'),

      insertTask: this.db.prepare(
        "INSERT INTO tasks (id, project_id, project_name, status, blueprint_json, metadata_json, created_at, updated_at) " +
        "VALUES (?, ?, ?, 'pending', ?, ?, datetime('now'), datetime('now'))"
      ),

      claimTask: this.db.prepare(
        "UPDATE tasks SET status = 'assigned', assigned_to = ?, assigned_at = datetime('now'), updated_at = datetime('now') " +
        "WHERE id = (SELECT id FROM tasks WHERE status IN ('pending', 'fix_needed') AND (retry_after IS NULL OR retry_after < ?) ORDER BY created_at ASC LIMIT 1) " +
        "RETURNING *"
      ),

      updateStatus: this.db.prepare(
        "UPDATE tasks SET status = ?, status_message = ?, updated_at = datetime('now') WHERE id = ?"
      ),

      updateTaskFull: this.db.prepare(
        "UPDATE tasks SET status = ?, assigned_to = ?, status_message = ?, " +
        "fail_count = ?, infra_retry_count = ?, code_retry_count = ?, " +
        "retry_after = ?, preview_url = COALESCE(?, preview_url), " +
        "timeline_json = ?, metadata_json = COALESCE(?, metadata_json), " +
        "updated_at = datetime('now') WHERE id = ?"
      ),

      recordHistory: this.db.prepare(
        "INSERT INTO task_history (task_id, from_status, to_status, actor, message) VALUES (?, ?, ?, ?, ?)"
      ),

      upsertHeartbeat: this.db.prepare(
        "INSERT INTO worker_heartbeats (worker_id, status, current_task, uptime, ip, port, last_seen) " +
        "VALUES (?, ?, ?, ?, ?, ?, datetime('now')) " +
        "ON CONFLICT(worker_id) DO UPDATE SET " +
        "status = excluded.status, current_task = excluded.current_task, " +
        "uptime = excluded.uptime, ip = COALESCE(excluded.ip, worker_heartbeats.ip), " +
        "port = COALESCE(excluded.port, worker_heartbeats.port), last_seen = datetime('now')"
      ),

      getAllWorkers: this.db.prepare('SELECT * FROM worker_heartbeats ORDER BY last_seen DESC'),

      findStaleTasks: this.db.prepare(
        "SELECT t.*, w.last_seen as worker_last_seen, " +
        "CASE WHEN w.worker_id IS NULL THEN 1 " +
        "WHEN (julianday('now') - julianday(w.last_seen)) * 86400 > ? THEN 1 ELSE 0 END as worker_dead " +
        "FROM tasks t LEFT JOIN worker_heartbeats w ON t.assigned_to = w.worker_id " +
        "WHERE t.status IN ('assigned', 'processing', 'building') " +
        "AND (julianday('now') - julianday(t.updated_at)) * 86400 > ?"
      ),

      taskStats: this.db.prepare(
        "SELECT status, COUNT(*) as count FROM tasks WHERE status != 'cancelled' GROUP BY status"
      ),
    };
  }

  // ======================== Core Operations ========================

  enqueue(taskId, projectId, projectName, blueprintJson, metadataJson) {
    this._stmts.insertTask.run(
      taskId, projectId, projectName || '',
      typeof blueprintJson === 'string' ? blueprintJson : JSON.stringify(blueprintJson || {}),
      typeof metadataJson === 'string' ? metadataJson : JSON.stringify(metadataJson || {})
    );
    this._recordHistory(taskId, null, 'pending', 'server', 'enqueued');
    return this.get(taskId);
  }

  resubmit(taskId, blueprintJson, feedback) {
    var task = this.get(taskId);
    if (!task) return null;

    var oldStatus = task.status;
    var metadata = this._parseJson(task.metadata_json, {});
    if (feedback) metadata.latestFeedback = feedback;

    this.db.prepare(
      "UPDATE tasks SET status = 'fix_needed', blueprint_json = ?, metadata_json = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(
      typeof blueprintJson === 'string' ? blueprintJson : JSON.stringify(blueprintJson),
      JSON.stringify(metadata),
      taskId
    );
    this._recordHistory(taskId, oldStatus, 'fix_needed', 'server', 'feedback resubmit');
    return this.get(taskId);
  }

  claim(workerId) {
    var nowMs = Date.now();
    var task = this._stmts.claimTask.get(workerId, nowMs);
    if (task) {
      this._recordHistory(task.id, 'pending', 'assigned', workerId, 'claimed by worker');
    }
    return task || null;
  }

  report(taskId, status, data) {
    data = data || {};
    var task = this.get(taskId);
    if (!task) return null;

    var workerId = data.workerId || task.assigned_to;
    var message = data.message || '';
    var oldStatus = task.status;

    var newStatus = status;
    var failCount = task.fail_count;
    var infraRetryCount = task.infra_retry_count;
    var codeRetryCount = task.code_retry_count;
    var retryAfter = task.retry_after;
    var assignedTo = task.assigned_to;
    var statusMessage = message || task.status_message;

    if (status === 'done' || status === 'cua_passed') {
      newStatus = status;
      assignedTo = null;
    } else if (status === 'failed') {
      failCount++;
      var isInfra = this._isInfraFailure(message);

      if (isInfra) {
        infraRetryCount++;
        if (infraRetryCount <= MAX_INFRA_RETRIES) {
          var backoffMs = Math.min(5 * 60 * 1000 * Math.pow(2, infraRetryCount - 1), 80 * 60 * 1000);
          newStatus = 'pending';
          retryAfter = Date.now() + backoffMs;
          failCount = 0;
          assignedTo = null;
          statusMessage = 'Infrastructure failure (retry ' + infraRetryCount + '/' + MAX_INFRA_RETRIES +
            ', next in ' + Math.round(backoffMs / 60000) + 'min): ' + (message || '').substring(0, 200);
        } else {
          newStatus = 'failed';
          statusMessage = 'Infrastructure failure persisted after ' + infraRetryCount + ' retries';
        }
      } else {
        codeRetryCount++;
        if (codeRetryCount <= MAX_CODE_RETRIES) {
          var backoffMs2 = Math.min(30000 * codeRetryCount, 300000);
          newStatus = 'pending';
          retryAfter = Date.now() + backoffMs2;
          failCount = 0;
          assignedTo = null;
          statusMessage = 'Code failure retry ' + codeRetryCount + '/' + MAX_CODE_RETRIES + ': ' + (message || '').substring(0, 200);
        } else {
          newStatus = 'failed';
          statusMessage = 'Permanently failed after ' + codeRetryCount + ' code retries';
        }
      }
    }

    var timeline = this._parseJson(task.timeline_json, []);
    timeline.push({ status: status, message: message || '', workerId: workerId, timestamp: Date.now() });
    if (timeline.length > 50) timeline.splice(0, timeline.length - 50);

    var metadataJson = task.metadata_json;
    if (data.qualityData) {
      var metadata = this._parseJson(metadataJson, {});
      if (data.qualityData.reviewResult)    metadata.reviewResult = data.qualityData.reviewResult;
      if (data.qualityData.quickTestResult) metadata.quickTestResult = data.qualityData.quickTestResult;
      if (data.qualityData.cuaResult)       metadata.cuaResult = data.qualityData.cuaResult;
      if (data.qualityData.cuaRetries)      metadata.cuaRetries = data.qualityData.cuaRetries;
      metadataJson = JSON.stringify(metadata);
    }

    this._stmts.updateTaskFull.run(
      newStatus, assignedTo, statusMessage,
      failCount, infraRetryCount, codeRetryCount,
      retryAfter, data.previewUrl || null,
      JSON.stringify(timeline), metadataJson,
      taskId
    );

    this._recordHistory(taskId, oldStatus, newStatus, workerId, message);
    return this.get(taskId);
  }

  updateStatus(taskId, status, message, actor) {
    var task = this.get(taskId);
    if (!task) return null;
    // State machine validation (enforced)
    var validation = taskSM.validate(task.status, status);
    if (!validation.valid) {
      if (actor === 'watchdog' || actor === 'admin') {
        console.warn('[force] ' + validation.error);
      } else {
        console.warn(validation.error);
        return null; // reject invalid transition
      }
    }
    this._stmts.updateStatus.run(status, message || null, taskId);
    this._recordHistory(taskId, task.status, status, actor || 'server', message);

    var timeline = this._parseJson(task.timeline_json, []);
    timeline.push({ status: status, message: message || '', workerId: actor, timestamp: Date.now() });
    if (timeline.length > 50) timeline.splice(0, timeline.length - 50);
    this.db.prepare('UPDATE tasks SET timeline_json = ? WHERE id = ?').run(JSON.stringify(timeline), taskId);

    return this.get(taskId);
  }

  cancel(taskId, actor) {
    var task = this.get(taskId);
    if (!task) return null;
    this.db.prepare("UPDATE tasks SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(taskId);
    this._recordHistory(taskId, task.status, 'cancelled', actor || 'server', 'cancelled');
    return this.get(taskId);
  }

  // ======================== Worker Heartbeat ========================

  heartbeat(workerId, status, currentTask, uptime, ip, port) {
    this._stmts.upsertHeartbeat.run(
      workerId,
      status || 'unknown',
      typeof currentTask === 'object' ? JSON.stringify(currentTask) : (currentTask || null),
      uptime || 0,
      ip || null,
      port || null
    );
  }

  getWorkers() {
    return this._stmts.getAllWorkers.all();
  }

  getOnlineWorkers(thresholdMs) {
    thresholdMs = thresholdMs || 90000;
    var thresholdSec = thresholdMs / 1000;
    return this.db.prepare(
      "SELECT * FROM worker_heartbeats WHERE (julianday('now') - julianday(last_seen)) * 86400 < ? ORDER BY last_seen DESC"
    ).all(thresholdSec);
  }

  // ======================== Watchdog ========================

  reclaimStale(orphanThresholdSec, workerDeadSec) {
    orphanThresholdSec = orphanThresholdSec || 300;
    workerDeadSec = workerDeadSec || 180;

    var issues = [];
    var fixes = [];
    var staleTasks = this._stmts.findStaleTasks.all(workerDeadSec, orphanThresholdSec);

    for (var i = 0; i < staleTasks.length; i++) {
      var task = staleTasks[i];
      var reason;
      if (!task.assigned_to) {
        reason = 'orphan (no assignee)';
      } else if (task.worker_dead) {
        reason = 'worker ' + task.assigned_to + ' dead';
      } else {
        var worker = this.db.prepare('SELECT * FROM worker_heartbeats WHERE worker_id = ?').get(task.assigned_to);
        if (worker && (!worker.current_task || worker.current_task === 'null')) {
          // Freshly-restarted workers need a grace period — they poll every 10s
          // and resume checkpointed tasks, during which heartbeat reports idle.
          // Without this guard, a worker restart mid-task instantly triggers
          // reclaimStale -> re-queue, racing the worker's own resume and
          // burning a code_retry_count slot for nothing.
          if ((worker.uptime || 0) < 180) {
            continue;
          }
          reason = 'worker idle desync';
        } else {
          continue;
        }
      }

      issues.push('[watchdog] ' + task.id + ' is ' + task.status + ' — ' + reason);

      // Watchdog re-queue must respect MAX_CODE_RETRIES — previously it directly
      // UPDATE status='pending' and bypassed the retry counter, causing infinite
      // re-dispatch loops that burned ~$5-10 per cycle. Now we increment
      // code_retry_count and, if the cap is reached, mark the task permanently failed.
      var newCodeRetryCount = (task.code_retry_count || 0) + 1;
      if (newCodeRetryCount > MAX_CODE_RETRIES) {
        var failMsg = '[watchdog] Permanently failed after ' + newCodeRetryCount +
          ' re-queues (' + reason + '). Last: ' + (task.status_message || '').slice(0, 120);
        this.db.prepare(
          "UPDATE tasks SET status = 'failed', assigned_to = NULL, assigned_at = NULL, " +
          "code_retry_count = ?, status_message = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(newCodeRetryCount, failMsg, task.id);
        this._recordHistory(task.id, task.status, 'failed', 'watchdog', 'max re-queue exceeded: ' + reason);
        fixes.push('[fix] ' + task.id + ' -> failed (max re-queue: ' + reason + ')');
      } else {
        this.db.prepare(
          "UPDATE tasks SET status = 'pending', assigned_to = NULL, assigned_at = NULL, " +
          "code_retry_count = ?, status_message = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(
          newCodeRetryCount,
          '[watchdog] Re-queued ' + newCodeRetryCount + '/' + MAX_CODE_RETRIES + ': ' + reason,
          task.id
        );
        this._recordHistory(task.id, task.status, 'pending', 'watchdog', reason + ' (retry ' + newCodeRetryCount + '/' + MAX_CODE_RETRIES + ')');
        fixes.push('[fix] ' + task.id + ' -> pending (' + reason + ' ' + newCodeRetryCount + '/' + MAX_CODE_RETRIES + ')');
      }
    }

    return { issues: issues, fixes: fixes, count: fixes.length };
  }

  // ======================== Queries ========================

  get(taskId) {
    return this._stmts.getTask.get(taskId) || null;
  }

  getByProject(projectId) {
    return this.db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC LIMIT 1').get(projectId) || null;
  }

  list(status, limit) {
    if (status) return this._stmts.getTasksByStatus.all(status);
    return limit ? this._stmts.getRecentTasks.all(limit) : this._stmts.getAllTasks.all();
  }

  listForDashboard(limit) {
    limit = limit || 30;
    return this.db.prepare(
      "SELECT id as taskId, project_name as projectName, status, " +
      "status_message as statusMessage, assigned_to as workerId, " +
      "preview_url as previewUrl, fail_count as failCount, " +
      "infra_retry_count as infraRetryCount, code_retry_count as codeRetryCount, " +
      "timeline_json as timelineJson, metadata_json as metadataJson, " +
      "created_at as createdAt, updated_at as updatedAt " +
      "FROM tasks WHERE status != 'cancelled' ORDER BY updated_at DESC LIMIT ?"
    ).all(limit);
  }

  history(taskId) {
    return this.db.prepare('SELECT * FROM task_history WHERE task_id = ? ORDER BY created_at').all(taskId);
  }

  stats() {
    var taskRows = this._stmts.taskStats.all();
    var taskStats = {};
    for (var i = 0; i < taskRows.length; i++) {
      taskStats[taskRows[i].status] = taskRows[i].count;
    }

    var workers = this.getWorkers();
    var now = Date.now();
    var online = 0;
    for (var j = 0; j < workers.length; j++) {
      // SQLite stores datetime as UTC without timezone suffix. `new Date(utcString)`
      // in Node interprets it as local time, which shifts the value by ±8h in CST
      // and made every worker look permanently offline on the dashboard. Append 'Z'
      // so the string is parsed as UTC. Same fix as api/dashboard.cjs lines 146/350.
      if (workers[j].last_seen && (now - new Date(workers[j].last_seen + 'Z').getTime()) < 90000) online++;
    }

    return {
      tasks: taskStats,
      workers: { total: workers.length, online: online, offline: workers.length - online }
    };
  }

  dashboardStats() {
    var stats = this.stats();
    var workers = this.getWorkers();
    var now = Date.now();

    var workerList = workers.map(function(w) {
      return {
        workerId: w.worker_id,
        status: w.status,
        currentTask: w.current_task,
        uptime: w.uptime,
        lastSeen: w.last_seen,
        ip: w.ip,
        port: w.port,
      };
    });

    var recentTasks = this.listForDashboard(50);

    var recentHistory = this.db.prepare(
      'SELECT * FROM task_history ORDER BY created_at DESC LIMIT 100'
    ).all();

    return {
      tasks: stats.tasks,
      workers: {
        total: workers.length,
        online: stats.workers.online,
        offline: stats.workers.offline,
        list: workerList,
      },
      recentTasks: recentTasks,
      recentHistory: recentHistory,
    };
  }

  // ======================== Blueprint Access ========================

  getBlueprint(taskId) {
    var task = this.get(taskId);
    if (!task) return null;
    return this._parseJson(task.blueprint_json, null);
  }

  updateBlueprint(taskId, blueprintJson) {
    this.db.prepare("UPDATE tasks SET blueprint_json = ?, updated_at = datetime('now') WHERE id = ?")
      .run(typeof blueprintJson === 'string' ? blueprintJson : JSON.stringify(blueprintJson), taskId);
  }

  // ======================== Internal Helpers ========================

  _recordHistory(taskId, from, to, actor, message) {
    this._stmts.recordHistory.run(taskId, from || null, to, actor || null, message || null);
  }

  _isInfraFailure(message) {
    if (!message) return false;
    var m = message.toLowerCase();
    return m.indexOf('api_unavailable') >= 0 || m.indexOf('api unavailable') >= 0 ||
           m.indexOf('[infra]') >= 0 || m.indexOf('econnreset') >= 0 ||
           m.indexOf('econnrefused') >= 0 || m.indexOf('git clone') >= 0 ||
           m.indexOf('401') >= 0 || m.indexOf('503') >= 0;
  }

  _parseJson(str, fallback) {
    if (!str) return fallback;
    try { return JSON.parse(str); } catch(e) { return fallback; }
  }

  close() {
    this.db.close();
  }
}

module.exports = TaskQueue;
