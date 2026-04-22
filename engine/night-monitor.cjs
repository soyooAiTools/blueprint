#!/usr/bin/env node
/**
 * Night Monitor
 *
 * A long-running recovery monitor that wakes up every 30 minutes, inspects all
 * projects, records diagnostics for failed ones, runs the watchdog/self-heal
 * pipeline, promotes learning drafts, and resubmits eligible failed projects.
 *
 * This is intentionally conservative:
 * - it never mutates active/running tasks
 * - it only auto-resubmits projects already in `failed`
 * - it backs off repeated identical fingerprints unless repo code changed
 */

var fs = require('fs');
var path = require('path');
var http = require('http');
var { execSync } = require('child_process');
var Database = require('better-sqlite3');

var config = require('../lib/config.cjs');
var metrics = require('./metrics.cjs');
var exportLearning = require('./export-learning.cjs');
var promoteDrafts = require('./promote-learning-drafts.cjs');
var promoteFamilyDrafts = require('./promote-family-drafts.cjs');
var promoteGovernanceDrafts = require('./promote-governance-drafts.cjs');
var promoteImplementationPlans = require('./promote-implementation-plan-drafts.cjs');
var promotePatchTasks = require('./promote-patch-task-drafts.cjs');
var promotePatchRuns = require('./promote-patch-run-records.cjs');
var executePatchRuns = require('./execute-patch-runs.cjs');
var promotePatchFeedback = require('./promote-patch-feedback-drafts.cjs');
var curateDrafts = require('./curate-learning-drafts.cjs');

var INTERVAL_MS = 30 * 60 * 1000;
var STATE_FILE = path.join(config.DATA_DIR, 'night-monitor-state.json');
var LOG_DIR = path.join(config.DATA_DIR, 'night-monitor');
var INCIDENT_DIR = path.join(LOG_DIR, 'incidents');
var SUMMARY_FILE = path.join(LOG_DIR, 'last-summary.json');
var HEARTBEAT_FILE = path.join(LOG_DIR, 'heartbeat.json');
var HISTORY_FILE = path.join(LOG_DIR, 'history.jsonl');
var TASK_DB_FILE = path.join(config.DATA_DIR, 'blueprint.db');
var STUCK_PROCESSING_MS = 45 * 60 * 1000;
var STUCK_REVIEW_MS = 45 * 60 * 1000;

function nowIso() { return new Date().toISOString(); }

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function writeHeartbeat(data) {
  writeJson(HEARTBEAT_FILE, Object.assign({ ts: nowIso() }, data || {}));
}

function appendHistory(record) {
  ensureDir(path.dirname(HISTORY_FILE));
  fs.appendFileSync(HISTORY_FILE, JSON.stringify(record) + '\n', 'utf8');
}

function loadProjects() {
  var dir = config.PROJECTS_DIR;
  var files = [];
  try { files = fs.readdirSync(dir).filter(function(f) { return /\.json$/.test(f); }); }
  catch (e) { return []; }
  return files.map(function(file) {
    try { return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); }
    catch (e) { return null; }
  }).filter(Boolean);
}

function loadTasksByProjectId() {
  var byProjectId = {};
  try {
    var db = new Database(TASK_DB_FILE, { readonly: true, fileMustExist: true });
    var rows = db.prepare(
      "SELECT project_id, id, status, status_message, assigned_to, updated_at, code_retry_count, infra_retry_count " +
      "FROM tasks WHERE status != 'cancelled'"
    ).all();
    db.close();
    for (var i = 0; i < rows.length; i++) {
      byProjectId[rows[i].project_id] = rows[i];
    }
  } catch (e) {}
  return byProjectId;
}

function getRepoHead() {
  try {
    return execSync('git -C /opt/blueprint-editor rev-parse HEAD', { encoding: 'utf8', timeout: 5000 }).trim();
  } catch (e) {
    return 'unknown';
  }
}

function requestJson(method, pathname, bodyObj) {
  return new Promise(function(resolve, reject) {
    var body = bodyObj ? JSON.stringify(bodyObj) : '';
    var req = http.request({
      hostname: '127.0.0.1',
      port: Number(config.PORT || 3901),
      path: pathname,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 30000,
    }, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        var text = Buffer.concat(chunks).toString('utf8');
        var parsed = null;
        try { parsed = text ? JSON.parse(text) : {}; }
        catch (e) { parsed = { raw: text }; }
        if (res.statusCode >= 400) {
          var err = new Error('HTTP ' + res.statusCode + ' ' + pathname);
          err.payload = parsed;
          return reject(err);
        }
        resolve(parsed);
      });
    });
    req.on('timeout', function() {
      req.destroy(new Error('timeout ' + pathname));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function tailTaskArchive(projectId) {
  var file = path.join(config.DATA_DIR, 'task-logs', projectId, 'pipeline.jsonl');
  try {
    var lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-20).map(function(line) {
      try { return JSON.parse(line); } catch (e) { return { raw: line }; }
    });
  } catch (e) {
    return [];
  }
}

function loadState() {
  return readJson(STATE_FILE, {
    cycles: 0,
    projects: {},
    lastRepoHead: null,
  });
}

function summarizeFailure(project, state, repoHead) {
  var rawReason = project.statusMessage || (project.lastFailure && project.lastFailure.reason) || 'failed';
  var fingerprint = metrics.normalizeFingerprint(rawReason);
  var prev = state.projects[project.id] || {};
  var sameFingerprint = prev.lastFingerprint === fingerprint;
  var sameFingerprintCount = sameFingerprint ? (prev.sameFingerprintCount || 0) + 1 : 1;
  var taskTail = tailTaskArchive(project.id);
  var incident = {
    projectId: project.id,
    projectName: project.name || '',
    status: project.status || '',
    statusMessage: project.statusMessage || '',
    fingerprint: fingerprint,
    repoHead: repoHead,
    sameFingerprintCount: sameFingerprintCount,
    capturedAt: nowIso(),
    taskTail: taskTail,
    feedbackHistorySize: Array.isArray(project.feedbackHistory) ? project.feedbackHistory.length : 0,
  };
  writeJson(path.join(INCIDENT_DIR, project.id + '.json'), incident);
  return {
    fingerprint: fingerprint,
    sameFingerprintCount: sameFingerprintCount,
    lastRepoHead: repoHead,
    lastSeenAt: incident.capturedAt,
    lastStatusMessage: project.statusMessage || '',
    lastIncidentFile: path.relative(config.DATA_DIR, path.join('night-monitor', 'incidents', project.id + '.json')),
    lastResubmitAt: prev.lastResubmitAt || null,
    lastResubmitHead: prev.lastResubmitHead || null,
  };
}

function updateActiveState(project, state, repoHead, task) {
  var prev = state.projects[project.id] || {};
  var sameStatus = prev.lastStatus === project.status;
  var sameMessage = prev.lastStatusMessage === (project.statusMessage || '');
  var sameStatusCount = sameStatus && sameMessage ? (prev.sameStatusCount || 0) + 1 : 1;
  return Object.assign({}, prev, {
    lastStatus: project.status || '',
    lastStatusMessage: project.statusMessage || '',
    sameStatusCount: sameStatusCount,
    lastSeenAt: nowIso(),
    lastRepoHead: repoHead,
    lastTaskStatus: task && task.status || null,
    lastTaskUpdatedAt: task && task.updated_at || null,
  });
}

function detectStuckProject(project, projectState, task) {
  if (!project) return null;
  if (['processing', 'preview_ready', 'reviewing'].indexOf(project.status) < 0) return null;
  var projectTs = project.updatedAt ? new Date(project.updatedAt).getTime() : 0;
  var taskTs = task && task.updated_at ? new Date(task.updated_at + 'Z').getTime() : 0;
  var latestTs = Math.max(projectTs || 0, taskTs || 0);
  if (!latestTs) return null;
  var ageMs = Date.now() - latestTs;
  var statusMessage = String(project.statusMessage || '');
  var kind = (project.status === 'reviewing' || statusMessage.indexOf('审核') >= 0) ? 'stuck-review' : 'stuck-processing';
  var threshold = kind === 'stuck-review' ? STUCK_REVIEW_MS : STUCK_PROCESSING_MS;
  if (ageMs < threshold) return null;
  if ((projectState.sameStatusCount || 0) < 2) return null;
  return {
    kind: kind,
    ageMs: ageMs,
    thresholdMs: threshold,
    taskStatus: task && task.status || null,
    taskUpdatedAt: task && task.updated_at || null,
    sameStatusCount: projectState.sameStatusCount || 0,
  };
}

function summarizeStuck(project, state, repoHead, task, stuckInfo) {
  var fingerprint = stuckInfo.kind + ': ' + metrics.normalizeFingerprint(project.statusMessage || project.status || 'stuck');
  var taskTail = tailTaskArchive(project.id);
  var incident = {
    projectId: project.id,
    projectName: project.name || '',
    kind: stuckInfo.kind,
    status: project.status || '',
    statusMessage: project.statusMessage || '',
    fingerprint: fingerprint,
    repoHead: repoHead,
    sameStatusCount: stuckInfo.sameStatusCount,
    ageMs: stuckInfo.ageMs,
    taskStatus: stuckInfo.taskStatus,
    taskUpdatedAt: stuckInfo.taskUpdatedAt,
    capturedAt: nowIso(),
    taskTail: taskTail,
  };
  writeJson(path.join(INCIDENT_DIR, project.id + '.stuck.json'), incident);
  return Object.assign({}, state.projects[project.id] || {}, {
    lastFingerprint: fingerprint,
    sameFingerprintCount: (state.projects[project.id] && state.projects[project.id].lastFingerprint === fingerprint)
      ? ((state.projects[project.id].sameFingerprintCount || 0) + 1)
      : 1,
    lastSeenAt: incident.capturedAt,
    lastStatusMessage: project.statusMessage || '',
    lastIncidentFile: path.relative(config.DATA_DIR, path.join('night-monitor', 'incidents', project.id + '.stuck.json')),
    lastResubmitAt: state.projects[project.id] && state.projects[project.id].lastResubmitAt || null,
    lastResubmitHead: state.projects[project.id] && state.projects[project.id].lastResubmitHead || null,
    lastStatus: project.status || '',
    sameStatusCount: stuckInfo.sameStatusCount,
  });
}

async function recoverStuckProject(project, projectState, repoHead, stuckInfo) {
  var projectFile = path.join(config.PROJECTS_DIR, project.id + '.json');
  try {
    try {
      await requestJson('POST', '/api/tasks/' + encodeURIComponent(project.id) + '/cancel', { actor: 'night-monitor' });
    } catch (e) {
      if (!/404/.test(String(e.message || ''))) throw e;
    }
    var fresh = readJson(projectFile, project);
    fresh.status = 'failed';
    fresh.statusMessage = '[night-monitor] ' + stuckInfo.kind + ' recovered after ' + Math.round(stuckInfo.ageMs / 60000) + 'min';
    fresh.updatedAt = nowIso();
    writeJson(projectFile, fresh);
    await requestJson('POST', '/api/projects/' + encodeURIComponent(project.id) + '/submit', {});
    projectState.lastResubmitAt = nowIso();
    projectState.lastResubmitHead = repoHead;
    projectState.lastRecoveryKind = stuckInfo.kind;
    projectState.lastRecoveryAt = nowIso();
    return true;
  } catch (e) {
    throw e;
  }
}

function shouldResubmit(projectState, repoHead) {
  var lastResubmitAt = projectState.lastResubmitAt ? new Date(projectState.lastResubmitAt).getTime() : 0;
  var age = Date.now() - lastResubmitAt;
  var sameHeadAsLastSubmit = projectState.lastResubmitHead === repoHead;
  if (!lastResubmitAt) return true;
  if (!sameHeadAsLastSubmit) return true;
  if ((projectState.sameFingerprintCount || 0) >= 3) return false;
  if ((projectState.sameFingerprintCount || 0) <= 2 && age >= INTERVAL_MS) return true;
  return false;
}

function isPermanentFailure(project) {
  var statusMessage = String(project && project.statusMessage || '');
  var failReason = String(project && project.lastFailure && project.lastFailure.failReason || '');
  return /Permanently failed after \d+ code retries/i.test(statusMessage) ||
    /Permanently failed after \d+ code retries/i.test(failReason);
}

async function runCycle(trigger) {
  ensureDir(INCIDENT_DIR);
  writeHeartbeat({ phase: 'cycle-start', trigger: trigger || 'manual' });
  var state = loadState();
  var repoHead = getRepoHead();
  var summary = {
    trigger: trigger || 'manual',
    startedAt: nowIso(),
    repoHead: repoHead,
    watchdog: null,
    learning: null,
    failedProjects: [],
    stuckProjects: [],
    resubmitted: [],
    recoveredStuck: [],
    errors: [],
  };

  try {
    summary.watchdog = await requestJson('POST', '/api/watchdog/run', {});
  } catch (e) {
    summary.errors.push('watchdog: ' + e.message);
  }

  try {
    exportLearning.exportAll();
    promoteDrafts.promoteDrafts();
    promoteFamilyDrafts.promoteFamilyDrafts();
    promoteGovernanceDrafts.promoteGovernanceDrafts();
    promoteImplementationPlans.promoteImplementationPlanDrafts();
    promotePatchTasks.promotePatchTaskDrafts();
    promotePatchRuns.promotePatchRunRecords();
    executePatchRuns.executePatchRuns();
    promotePatchFeedback.promotePatchFeedbackDrafts();
    curateDrafts.curateDrafts({ all: true });
    summary.learning = 'ok';
  } catch (e) {
    summary.errors.push('learning: ' + e.message);
  }

  var projects = loadProjects();
  var tasksByProjectId = loadTasksByProjectId();
  for (var pi = 0; pi < projects.length; pi++) {
    var activeProject = projects[pi];
    var activeTask = tasksByProjectId[activeProject.id];
    state.projects[activeProject.id] = updateActiveState(activeProject, state, repoHead, activeTask);
    var stuckInfo = detectStuckProject(activeProject, state.projects[activeProject.id], activeTask);
    if (!stuckInfo) continue;
    var stuckState = summarizeStuck(activeProject, state, repoHead, activeTask, stuckInfo);
    state.projects[activeProject.id] = stuckState;
    summary.stuckProjects.push({
      id: activeProject.id,
      kind: stuckInfo.kind,
      fingerprint: stuckState.fingerprint,
      ageMin: Math.round(stuckInfo.ageMs / 60000),
      sameStatusCount: stuckInfo.sameStatusCount,
      status: activeProject.status,
      taskStatus: stuckInfo.taskStatus,
      statusMessage: (activeProject.statusMessage || '').slice(0, 240),
    });
    if (!shouldResubmit(stuckState, repoHead)) continue;
    try {
      await recoverStuckProject(activeProject, stuckState, repoHead, stuckInfo);
      state.projects[activeProject.id] = stuckState;
      summary.recoveredStuck.push({
        id: activeProject.id,
        kind: stuckInfo.kind,
        fingerprint: stuckState.fingerprint,
        ageMin: Math.round(stuckInfo.ageMs / 60000),
      });
    } catch (e) {
      summary.errors.push('recover-stuck ' + activeProject.id + ': ' + e.message + (e.payload && e.payload.error ? ' — ' + e.payload.error : ''));
    }
  }

  var failed = projects.filter(function(p) { return p.status === 'failed'; });
  for (var i = 0; i < failed.length; i++) {
    var project = failed[i];
    var projectState = summarizeFailure(project, state, repoHead);
    state.projects[project.id] = projectState;
    var permanentFailure = isPermanentFailure(project);
    summary.failedProjects.push({
      id: project.id,
      name: project.name || '',
      fingerprint: projectState.fingerprint,
      sameFingerprintCount: projectState.sameFingerprintCount,
      statusMessage: (project.statusMessage || '').slice(0, 240),
      permanentFailure: permanentFailure,
    });

    if (permanentFailure) continue;
    if (!shouldResubmit(projectState, repoHead)) continue;
    try {
      await requestJson('POST', '/api/projects/' + encodeURIComponent(project.id) + '/submit', {});
      projectState.lastResubmitAt = nowIso();
      projectState.lastResubmitHead = repoHead;
      state.projects[project.id] = projectState;
      summary.resubmitted.push({
        id: project.id,
        fingerprint: projectState.fingerprint,
        sameFingerprintCount: projectState.sameFingerprintCount,
      });
    } catch (e) {
      summary.errors.push('resubmit ' + project.id + ': ' + e.message + (e.payload && e.payload.error ? ' — ' + e.payload.error : ''));
    }
  }

  state.cycles = (state.cycles || 0) + 1;
  state.lastRepoHead = repoHead;
  state.lastRunAt = nowIso();
  writeJson(STATE_FILE, state);

  summary.finishedAt = nowIso();
  writeJson(SUMMARY_FILE, summary);
  appendHistory({
    ts: summary.finishedAt,
    trigger: summary.trigger,
    repoHead: summary.repoHead,
    failedProjects: summary.failedProjects || [],
    stuckProjects: summary.stuckProjects || [],
    resubmitted: summary.resubmitted || [],
    recoveredStuck: summary.recoveredStuck || [],
    errors: summary.errors || [],
  });
  writeHeartbeat({
    phase: 'cycle-finish',
    trigger: trigger || 'manual',
    failedProjects: summary.failedProjects.length,
    stuckProjects: summary.stuckProjects.length,
    resubmitted: summary.resubmitted.length,
    recoveredStuck: summary.recoveredStuck.length,
    errors: summary.errors.length,
    finishedAt: summary.finishedAt,
    nextRunAt: new Date(Date.now() + INTERVAL_MS).toISOString(),
  });
  console.log('[night-monitor] cycle done failed=' + summary.failedProjects.length +
    ' stuck=' + summary.stuckProjects.length +
    ' resubmitted=' + summary.resubmitted.length +
    ' recoveredStuck=' + summary.recoveredStuck.length +
    ' errors=' + summary.errors.length);
  return summary;
}

function start() {
  console.log('[night-monitor] started interval=' + INTERVAL_MS + 'ms');
  writeHeartbeat({
    phase: 'started',
    intervalMs: INTERVAL_MS,
    startedAt: nowIso(),
    nextRunAt: new Date(Date.now() + INTERVAL_MS).toISOString(),
  });

  function scheduleNext(delayMs) {
    writeHeartbeat({
      phase: 'sleeping',
      intervalMs: INTERVAL_MS,
      sleepingForMs: delayMs,
      nextRunAt: new Date(Date.now() + delayMs).toISOString(),
    });
    setTimeout(runScheduledCycle, delayMs);
  }

  function runScheduledCycle() {
    runCycle('interval')
      .catch(function(e) {
        console.error('[night-monitor] interval cycle failed:', e.message);
        writeHeartbeat({
          phase: 'cycle-error',
          trigger: 'interval',
          error: e.message,
          nextRunAt: new Date(Date.now() + INTERVAL_MS).toISOString(),
        });
      })
      .finally(function() {
        scheduleNext(INTERVAL_MS);
      });
  }

  runCycle('startup')
    .catch(function(e) {
      console.error('[night-monitor] startup cycle failed:', e.message);
      writeHeartbeat({
        phase: 'cycle-error',
        trigger: 'startup',
        error: e.message,
      });
    })
    .finally(function() {
      scheduleNext(INTERVAL_MS);
    });
}

// PM2 fork mode may load the script in a way where `require.main !== module`,
// so also treat `pm_id` as an executable entrypoint signal.
if (require.main === module || process.env.pm_id != null) start();

module.exports = {
  runCycle: runCycle,
  start: start,
  shouldResubmit: shouldResubmit,
  isPermanentFailure: isPermanentFailure,
};
