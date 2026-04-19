/**
 * Archive Writer — unified append+rotate for per-task observability archives
 *
 * Writes JSONL/JSON archives for pipeline logs, silent-pass snapshots,
 * MODEL_FATAL raw responses, and auto-fix diagnostics. Centralises the
 * 10MB rotation logic so every archive stream ages out the same way.
 *
 * Archive layout:
 *   server-data/task-logs/<taskId>/pipeline.jsonl       — stage timeline
 *   server-data/task-logs/<taskId>/silent-pass.jsonl    — semantic false-pass snapshots
 *   server-data/task-logs/<taskId>/model-fatal.jsonl    — raw provider API body
 *   server-data/task-logs/auto-fix/<recipeId>-<ts>.json — one file per attempt
 *   server-data/task-logs/auto-fix/_index.jsonl         — global attempt index
 *   server-data/model-fatal-index.jsonl                 — global MODEL_FATAL index
 *
 * Feature flag: BLUEPRINT_ARCHIVE_LEVEL = off | critical | full (default: full)
 *   - off:      no writes (emergency disable)
 *   - critical: only silent-pass + MODEL_FATAL (P0)
 *   - full:     everything (default)
 *
 * Failure handling: P0 writes (silent-pass, MODEL_FATAL) fall back to
 * alerts.json + console.error if disk fails. Other writes log and
 * continue — never block pipeline.
 */

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var REPO_ROOT = path.join(__dirname, '..');
var TASK_LOGS_DIR = path.join(REPO_ROOT, 'server-data', 'task-logs');
var AUTO_FIX_ARCHIVE_DIR = path.join(TASK_LOGS_DIR, 'auto-fix');
var MODEL_FATAL_INDEX = path.join(REPO_ROOT, 'server-data', 'model-fatal-index.jsonl');
var ALERTS_FILE = path.join(REPO_ROOT, 'server-data', 'alerts.json');

var ROTATE_BYTES = 10 * 1024 * 1024; // 10 MB — matches metrics.cjs
var MAX_RAW_RESPONSE_BYTES = 4 * 1024;
var MAX_ACTION_SAMPLE = 250; // 200 head + 50 tail
var MAX_SUB_AGENT_PROMPT_HEAD = 4 * 1024;

function archiveLevel() {
  var v = (process.env.BLUEPRINT_ARCHIVE_LEVEL || 'full').toLowerCase();
  if (v === 'off' || v === 'critical' || v === 'full') return v;
  return 'full';
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch(e) {}
}

function taskDir(taskId) {
  var safe = String(taskId || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(TASK_LOGS_DIR, safe);
}

function rotateIfLarge(filePath) {
  try {
    var stat = fs.statSync(filePath);
    if (stat.size > ROTATE_BYTES) {
      var stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      fs.renameSync(filePath, filePath + '.bak.' + stamp);
    }
  } catch(e) { /* file missing or stat failed — fine */ }
}

function appendJsonl(filePath, record) {
  ensureDir(path.dirname(filePath));
  rotateIfLarge(filePath);
  fs.appendFileSync(filePath, JSON.stringify(record) + '\n');
}

function criticalFallback(kind, payload, err) {
  // P0 writes: if disk failed, still leave a breadcrumb in alerts.json +
  // stderr so operators notice the observability gap.
  try {
    var alerts = [];
    try { alerts = JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf-8')); } catch(e) {}
    if (!Array.isArray(alerts)) alerts = [];
    alerts.push({
      severity: 'critical',
      source: 'archive-writer',
      at: new Date().toISOString(),
      kind: kind,
      archiveError: err && err.message ? err.message : String(err),
      payloadHead: JSON.stringify(payload).slice(0, 500),
    });
    if (alerts.length > 500) alerts = alerts.slice(-500);
    fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts, null, 2));
  } catch(e2) {}
  console.error('[archive-writer] CRITICAL ' + kind + ' archive failed: ' + (err && err.message || err));
}

// ─── Pipeline stage log (P1) ────────────────────────────────────────

function appendStageLog(taskId, entry) {
  if (archiveLevel() !== 'full') return;
  if (!taskId) return;
  try {
    var file = path.join(taskDir(taskId), 'pipeline.jsonl');
    var record = Object.assign({ ts: new Date().toISOString(), taskId: taskId }, entry || {});
    appendJsonl(file, record);
  } catch(e) {
    console.error('[archive-writer] appendStageLog failed (' + taskId + '): ' + e.message);
  }
}

// ─── Silent-pass snapshot (P0) ──────────────────────────────────────

function _truncateActions(actions) {
  if (!Array.isArray(actions) || actions.length <= MAX_ACTION_SAMPLE) return actions || [];
  var head = actions.slice(0, 200);
  var tail = actions.slice(-50);
  return head.concat([{ _truncated: actions.length - 250 }]).concat(tail);
}

function writeSilentPass(ctx, cuaResult, extras) {
  if (archiveLevel() === 'off') return;
  var taskId = ctx && ctx.taskId;
  if (!taskId) return;

  var signals = (cuaResult && cuaResult.silentPassSignals) || [];
  var record = {
    ts: new Date().toISOString(),
    taskId: taskId,
    stage: 'cua-verify',
    verdict: (extras && extras.verdict) || 'hard-block',
    signals: signals,
    totalActions: cuaResult && cuaResult.totalActions !== undefined ? cuaResult.totalActions : null,
    cuaRound: (extras && extras.round) || null,
    actionSample: _truncateActions(cuaResult && cuaResult.actions),
    phaseOrder: (cuaResult && cuaResult.phaseOrder) || (cuaResult && cuaResult.report && cuaResult.report.phaseOrder) || [],
    interactionVars: (cuaResult && cuaResult.interactionVars) || (cuaResult && cuaResult.report && cuaResult.report.interactionVars) || null,
    screenshots: (cuaResult && cuaResult.screenshots) || (cuaResult && cuaResult.report && cuaResult.report.screenshots) || [],
    issuesHead: ((cuaResult && cuaResult.issues) || []).slice(0, 5),
    blueprintDigest: ctx.blueprint ? {
      name: ctx.blueprint.name || null,
      specsCount: (ctx.blueprint.specs || []).length,
      entitiesCount: (ctx.blueprint.entities || []).length,
    } : null,
  };

  try {
    var file = path.join(taskDir(taskId), 'silent-pass.jsonl');
    appendJsonl(file, record);
  } catch(e) {
    criticalFallback('silent-pass', { taskId: taskId, signals: signals }, e);
  }
}

// ─── MODEL_FATAL raw response (P0) ──────────────────────────────────

function writeModelFatal(err, ctxOrMeta) {
  if (archiveLevel() === 'off') return;
  var meta = (ctxOrMeta && ctxOrMeta.taskId) ? {
    taskId: ctxOrMeta.taskId,
    stage: ctxOrMeta._failedAtStage || ctxOrMeta.currentStage || ctxOrMeta.stage || null,
    endpoint: ctxOrMeta.endpoint || null,
    model: ctxOrMeta.model || null,
    httpStatus: ctxOrMeta.httpStatus || null,
    attempt: ctxOrMeta.attempt || null,
  } : (ctxOrMeta || {});
  var taskId = meta.taskId || 'unknown';

  var rawBody = (err && (err._rawResponse || err.rawResponse || err.body)) || null;
  var rawStr = rawBody == null ? '' :
    (typeof rawBody === 'string' ? rawBody : (function() {
      try { return JSON.stringify(rawBody); } catch(e) { return String(rawBody); }
    })());

  var record = {
    ts: new Date().toISOString(),
    taskId: taskId,
    stage: meta.stage || null,
    classification: 'MODEL_FATAL',
    pattern: (err && err._modelFatalPattern) || null,
    message: (err && err.message ? err.message : String(err)).slice(0, 500),
    endpoint: (err && err._endpoint) || meta.endpoint || null,
    model: (err && err._model) || meta.model || null,
    httpStatus: (err && err._httpStatus) || meta.httpStatus || null,
    retryAttempt: meta.attempt || null,
    rawResponseHead: rawStr.slice(0, MAX_RAW_RESPONSE_BYTES),
    rawResponseHash: rawStr ? crypto.createHash('sha256').update(rawStr).digest('hex').slice(0, 16) : null,
    rawResponseLen: rawStr.length,
  };

  var perTaskFile = path.join(taskDir(taskId), 'model-fatal.jsonl');
  try {
    appendJsonl(perTaskFile, record);
  } catch(e) {
    criticalFallback('model-fatal-per-task', record, e);
  }
  try {
    ensureDir(path.dirname(MODEL_FATAL_INDEX));
    rotateIfLarge(MODEL_FATAL_INDEX);
    fs.appendFileSync(MODEL_FATAL_INDEX, JSON.stringify(record) + '\n');
  } catch(e) {
    criticalFallback('model-fatal-index', record, e);
  }
}

// ─── Auto-fix attempt (P2) ──────────────────────────────────────────

function _unifiedDiff(beforeText, afterText, relPath) {
  // Minimal unified diff — line-by-line, no external dep. Good enough for
  // dashboard rendering; full context is not required since we also keep
  // backup snapshots under server-data/auto-fix-backups.
  var beforeLines = String(beforeText || '').split('\n');
  var afterLines = String(afterText || '').split('\n');
  var out = ['--- a/' + relPath, '+++ b/' + relPath];
  var i = 0, j = 0;
  while (i < beforeLines.length || j < afterLines.length) {
    if (i < beforeLines.length && j < afterLines.length && beforeLines[i] === afterLines[j]) {
      i++; j++;
      continue;
    }
    // Hunk at (i, j)
    var hunkStartB = i + 1, hunkStartA = j + 1;
    var delLines = [], addLines = [];
    // Greedy: collect lines until we resync or run out
    while (i < beforeLines.length && (j >= afterLines.length || beforeLines[i] !== afterLines[j])) {
      delLines.push(beforeLines[i++]);
      if (delLines.length > 200) break;
    }
    while (j < afterLines.length && (i >= beforeLines.length || afterLines[j] !== (beforeLines[i] || null))) {
      addLines.push(afterLines[j++]);
      if (addLines.length > 200) break;
    }
    out.push('@@ -' + hunkStartB + ',' + delLines.length + ' +' + hunkStartA + ',' + addLines.length + ' @@');
    delLines.forEach(function(l) { out.push('-' + l); });
    addLines.forEach(function(l) { out.push('+' + l); });
    if (out.length > 5000) { out.push('... (diff truncated)'); break; }
  }
  return out.join('\n');
}

function writeAutoFixAttempt(attempt) {
  if (archiveLevel() === 'off') return null;
  // attempt: {
  //   recipeId, fingerprint, subAgentPrompt, subAgentOutputHead,
  //   filesBefore: { rel: content }, filesAfter: { rel: content },
  //   rejectedPaths, verifyErrors, outcome, reverted, followUpFingerprint,
  //   error, diagnosis
  // }
  var recipeId = attempt.recipeId || 'unknown';
  var ts = new Date().toISOString();
  var hashSource = recipeId + '|' + ts + '|' + (attempt.fingerprint || '');
  var attemptHash = crypto.createHash('md5').update(hashSource).digest('hex').slice(0, 10);
  var safeId = recipeId.replace(/[^a-zA-Z0-9._-]/g, '_');
  var fileBase = safeId + '-' + attemptHash;

  ensureDir(AUTO_FIX_ARCHIVE_DIR);

  // Build parsedFiles with diffs
  var parsedFiles = [];
  var before = attempt.filesBefore || {};
  var after = attempt.filesAfter || {};
  var allPaths = Object.keys(Object.assign({}, before, after));
  allPaths.forEach(function(rel) {
    var b = before[rel] || '';
    var a = after[rel] || '';
    parsedFiles.push({
      path: rel,
      sizeDelta: (a.length || 0) - (b.length || 0),
      lineDeltaBefore: b ? b.split('\n').length : 0,
      lineDeltaAfter: a ? a.split('\n').length : 0,
      diffUnified: _unifiedDiff(b, a, rel).slice(0, 20000),
    });
  });

  var systemPromptStr = (attempt.subAgentPrompt && attempt.subAgentPrompt.system) || '';
  var userPromptStr = (attempt.subAgentPrompt && attempt.subAgentPrompt.user) || '';
  var record = {
    recipeId: recipeId,
    attemptHash: attemptHash,
    fingerprint: attempt.fingerprint || null,
    ts: ts,
    subAgentPrompt: {
      systemHead: systemPromptStr.slice(0, MAX_SUB_AGENT_PROMPT_HEAD),
      systemLen: systemPromptStr.length,
      systemHash: systemPromptStr ? crypto.createHash('sha256').update(systemPromptStr).digest('hex').slice(0, 16) : null,
      userHead: userPromptStr.slice(0, MAX_SUB_AGENT_PROMPT_HEAD),
      userLen: userPromptStr.length,
      userHash: userPromptStr ? crypto.createHash('sha256').update(userPromptStr).digest('hex').slice(0, 16) : null,
    },
    subAgentOutputHead: (attempt.subAgentOutputHead || '').slice(0, 4 * 1024),
    subAgentOutputLen: attempt.subAgentOutputLen || 0,
    parsedFiles: parsedFiles,
    rejectedPaths: attempt.rejectedPaths || [],
    verifyErrors: attempt.verifyErrors || [],
    outcome: attempt.outcome || 'unknown',
    reverted: !!attempt.reverted,
    followUpFingerprint: attempt.followUpFingerprint || null,
    error: attempt.error || null,
    diagnosis: (attempt.diagnosis || '').slice(0, 800),
  };

  var attemptFile = path.join(AUTO_FIX_ARCHIVE_DIR, fileBase + '.json');
  try {
    fs.writeFileSync(attemptFile, JSON.stringify(record, null, 2));
    // Keep full prompt body in a sidecar for deep inspection — 30-day TTL
    if (systemPromptStr.length > MAX_SUB_AGENT_PROMPT_HEAD || userPromptStr.length > MAX_SUB_AGENT_PROMPT_HEAD) {
      fs.writeFileSync(
        path.join(AUTO_FIX_ARCHIVE_DIR, fileBase + '.prompt.txt'),
        '=== SYSTEM ===\n' + systemPromptStr + '\n\n=== USER ===\n' + userPromptStr
      );
    }
  } catch(e) {
    console.error('[archive-writer] writeAutoFixAttempt file failed: ' + e.message);
    return null;
  }

  // Global index
  try {
    var indexFile = path.join(AUTO_FIX_ARCHIVE_DIR, '_index.jsonl');
    rotateIfLarge(indexFile);
    fs.appendFileSync(indexFile, JSON.stringify({
      ts: ts,
      recipeId: recipeId,
      attemptHash: attemptHash,
      fingerprint: attempt.fingerprint || null,
      outcome: record.outcome,
      reverted: record.reverted,
      filesChanged: parsedFiles.map(function(f) { return f.path; }),
      error: record.error,
      archive: path.relative(REPO_ROOT, attemptFile),
    }) + '\n');
  } catch(e) {
    console.error('[archive-writer] writeAutoFixAttempt index failed: ' + e.message);
  }

  return { attemptHash: attemptHash, archivePath: attemptFile };
}

// ─── Reader helpers (for dashboard) ─────────────────────────────────

function readTaskArchive(taskId, limit) {
  limit = limit || 500;
  var dir = taskDir(taskId);
  var result = { taskId: taskId, pipeline: [], silentPass: [], modelFatal: [] };
  function readJsonlTail(p) {
    try {
      var data = fs.readFileSync(p, 'utf-8').trim();
      if (!data) return [];
      var lines = data.split('\n');
      return lines.slice(-limit).map(function(l) {
        try { return JSON.parse(l); } catch(e) { return null; }
      }).filter(Boolean);
    } catch(e) { return []; }
  }
  result.pipeline = readJsonlTail(path.join(dir, 'pipeline.jsonl'));
  result.silentPass = readJsonlTail(path.join(dir, 'silent-pass.jsonl'));
  result.modelFatal = readJsonlTail(path.join(dir, 'model-fatal.jsonl'));
  return result;
}

function readAutoFixIndex(limit) {
  limit = limit || 100;
  var indexFile = path.join(AUTO_FIX_ARCHIVE_DIR, '_index.jsonl');
  try {
    var data = fs.readFileSync(indexFile, 'utf-8').trim();
    if (!data) return [];
    var lines = data.split('\n');
    return lines.slice(-limit).map(function(l) {
      try { return JSON.parse(l); } catch(e) { return null; }
    }).filter(Boolean).reverse();
  } catch(e) { return []; }
}

function readAutoFixAttempt(recipeId, attemptHash) {
  try {
    var safeId = String(recipeId).replace(/[^a-zA-Z0-9._-]/g, '_');
    var file = path.join(AUTO_FIX_ARCHIVE_DIR, safeId + '-' + attemptHash + '.json');
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch(e) { return null; }
}

function readModelFatalIndex(limit) {
  limit = limit || 100;
  try {
    var data = fs.readFileSync(MODEL_FATAL_INDEX, 'utf-8').trim();
    if (!data) return [];
    var lines = data.split('\n');
    return lines.slice(-limit).map(function(l) {
      try { return JSON.parse(l); } catch(e) { return null; }
    }).filter(Boolean).reverse();
  } catch(e) { return []; }
}

module.exports = {
  appendStageLog: appendStageLog,
  writeSilentPass: writeSilentPass,
  writeModelFatal: writeModelFatal,
  writeAutoFixAttempt: writeAutoFixAttempt,
  readTaskArchive: readTaskArchive,
  readAutoFixIndex: readAutoFixIndex,
  readAutoFixAttempt: readAutoFixAttempt,
  readModelFatalIndex: readModelFatalIndex,
  archiveLevel: archiveLevel,
  // Exposed for reuse / tests
  _rotateIfLarge: rotateIfLarge,
  _taskDir: taskDir,
};
