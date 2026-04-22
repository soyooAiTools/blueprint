/**
 * Linux Worker Client — Polls tasks from Blueprint Server, builds via Linux Bridge.NET pipeline
 *
 * Flow: Poll task → Git clone base template → AI coding → Code review → Bridge.NET build → CUA → Upload
 *
 * Base template: https://github.com/soyooAiTools/luna-base-template.git
 * Each task starts by git cloning the base Unity project, then AI generates code on top of it.
 *
 * This runs on the main ECS (120.55.70.226) alongside linux-bridge-build.js
 * Worker ID starts with "linux" so server.cjs assigns independently from Windows worker
 *
 * Dependencies: dotenv (npm install dotenv)
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true });

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
let patchForHeadless; try { patchForHeadless = require('./worker-cua-verify.js').patchForHeadless; } catch(e) {}

// ============ Base Template Cache (avoid repeated git clones) ============
const TEMPLATE_CACHE_DIR = path.join(require('os').tmpdir(), 'luna-base-cache');
const TEMPLATE_CACHE_LOCK = TEMPLATE_CACHE_DIR + '.lock';
const TEMPLATE_CACHE_MAX_AGE = 3600 * 1000; // 1 hour
const LOCK_TIMEOUT = 120000; // 2 min max wait

function acquireCacheLock() {
  const start = Date.now();
  while (Date.now() - start < LOCK_TIMEOUT) {
    try {
      fs.mkdirSync(TEMPLATE_CACHE_LOCK);
      return true;
    } catch (e) {
      try {
        const lockAge = Date.now() - fs.statSync(TEMPLATE_CACHE_LOCK).mtimeMs;
        if (lockAge > LOCK_TIMEOUT) {
          try { fs.rmdirSync(TEMPLATE_CACHE_LOCK); } catch (e2) {}
          continue;
        }
      } catch (e2) { continue; }
      require('child_process').execSync('sleep 0.5');
    }
  }
  throw new Error('Failed to acquire cache lock after ' + LOCK_TIMEOUT + 'ms');
}

function releaseCacheLock() {
  try { fs.rmdirSync(TEMPLATE_CACHE_LOCK); } catch (e) {}
}

function getBaseTemplate(targetDir, log, taskId) {
  const { execSync } = require('child_process');

  acquireCacheLock();
  try {
    const cacheValid = fs.existsSync(TEMPLATE_CACHE_DIR)
      && fs.existsSync(path.join(TEMPLATE_CACHE_DIR, '.git'))
      && fs.existsSync(path.join(TEMPLATE_CACHE_DIR, 'Assets'))
      && (Date.now() - fs.statSync(TEMPLATE_CACHE_DIR).mtimeMs) < TEMPLATE_CACHE_MAX_AGE;

    if (!cacheValid) {
      if (fs.existsSync(TEMPLATE_CACHE_DIR)) fs.rmSync(TEMPLATE_CACHE_DIR, { recursive: true, force: true });
      const repo = process.env.BASE_TEMPLATE_REPO || 'https://github.com/soyooAiTools/luna-base-template.git';
      execSync(`git clone --depth 1 ${repo} "${TEMPLATE_CACHE_DIR}"`, { timeout: 60000, stdio: 'pipe' });
      log('[cache] Base template cache refreshed', taskId);
    } else {
      log('[cache] Using cached base template', taskId);
    }

    execSync(`cp -r "${TEMPLATE_CACHE_DIR}/." "${targetDir}"`, { timeout: 30000, stdio: 'pipe' });
  } finally {
    releaseCacheLock();
  }
}

// ============ Task Checkpoint (persist best code across worker restarts) ============
const CHECKPOINT_DIR = path.join(__dirname, '..', 'server-data', 'checkpoints');
const checkpointHelper = require('../lib/checkpoint.cjs');

function getCheckpointPath(taskId) {
  return path.join(CHECKPOINT_DIR, taskId);
}

function saveCheckpoint(taskId, data) {
  const dir = getCheckpointPath(taskId);
  fs.mkdirSync(dir, { recursive: true });
  var payload = {
    csCode: data.csCode,
    cuaRound: data.cuaRound,
    feedbackHistory: data.feedbackHistory,
    fixHistory: data.fixHistory || [],
    completedStages: data.completedStages || [],
    extraFiles: data.extraFiles || {},
    stageResults: data.stageResults || {},
    workDir: data.workDir || null,
    pipelineVersion: checkpointHelper.computePipelineFingerprint(),
    savedAt: new Date().toISOString()
  };
  // htmlOutput can be large (>10MB) — save as separate file to avoid JSON bloat
  // Use atomic write (tmp + rename) to prevent corruption on SIGTERM
  if (data.htmlOutput) {
    var htmlTmp = path.join(dir, 'htmlOutput.bin.tmp');
    var htmlFinal = path.join(dir, 'htmlOutput.bin');
    fs.writeFileSync(htmlTmp, data.htmlOutput);
    fs.renameSync(htmlTmp, htmlFinal);
    payload.hasHtmlOutput = true;
  }
  var jsonTmp = path.join(dir, 'checkpoint.json.tmp');
  var jsonFinal = path.join(dir, 'checkpoint.json');
  fs.writeFileSync(jsonTmp, JSON.stringify(payload));
  fs.renameSync(jsonTmp, jsonFinal);
}

function loadCheckpoint(taskId) {
  const dir = getCheckpointPath(taskId);
  const fp = path.join(dir, 'checkpoint.json');
  if (fs.existsSync(fp)) {
    try {
      var data = JSON.parse(fs.readFileSync(fp, 'utf8'));
      // Load htmlOutput from separate file if it exists
      if (data.hasHtmlOutput) {
        var htmlPath = path.join(dir, 'htmlOutput.bin');
        if (fs.existsSync(htmlPath)) {
          data.htmlOutput = fs.readFileSync(htmlPath, 'utf8');
        }
      }
      return data;
    } catch (e) { return null; }
  }
  return null;
}

function clearCheckpoint(taskId) {
  const dir = getCheckpointPath(taskId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Categorize CUA issues into a short tag for consecutive-same-issue detection (BUG-0007).
 * Returns a string like 'solid-color', 'phase-skipped', 'quick-test', etc.
 */
function categorizeIssue(cuaResult) {
  if (cuaResult.quickTestDetail && cuaResult.quickTestDetail.solidColor) return 'solid-color';
  const issues = (cuaResult.issues || []).join(' ').toLowerCase();
  if (issues.includes('solid color') || issues.includes('纯色')) return 'solid-color';
  if (issues.includes('phase-skipped') || issues.includes('phases were skipped')) return 'phase-skipped';
  if (issues.includes('entity-incomplete')) return 'entity-incomplete';
  if (issues.includes('quick-test') || issues.includes('quick test')) return 'quick-test';
  if (issues.includes('stuck')) return 'stuck';
  if (issues.includes('[cta]') || issues.includes('cta')) return 'cta-missing';
  if (issues.includes('[uncovered]') || issues.includes('not covered')) return 'uncovered-shots';
  if (issues.includes('engine-not-ready')) return 'engine-not-ready';
  // Default: hash the first issue to detect repetition
  return (cuaResult.issues && cuaResult.issues[0]) ? cuaResult.issues[0].substring(0, 50) : 'unknown';
}

/**
 * Extract phase coverage numbers from CUA result (e.g. "8/11 phases completed").
 * Returns { completed, total } or null if not a phase-coverage issue.
 */
function extractPhaseCoverage(cuaResult) {
  for (const issue of (cuaResult.issues || [])) {
    const m = issue.match(/\[phase-coverage\]\s*(\d+)\/(\d+)/);
    if (m) return { completed: parseInt(m[1]), total: parseInt(m[2]) };
  }
  return null;
}

/**
 * Map issue type to severity level.
 */
function getIssueSeverity(type) {
  const HIGH = ['phase-coverage', 'entity-incomplete', 'stuck', 'engine-not-ready', 'no-content', 'stuck-pattern', 'no-coverage'];
  const MEDIUM = ['uncovered', 'cta', 'solid-color', 'interaction', 'suspicious-script'];
  if (HIGH.indexOf(type) >= 0) return 'high';
  if (MEDIUM.indexOf(type) >= 0) return 'medium';
  return 'low';
}

/**
 * Generate a fix hint based on issue type.
 */
function getFixHint(type) {
  switch (type) {
    case 'phase-coverage':
      return 'Ensure all phases are reachable via player interaction. Check trigger conditions and interaction radius. Do not use auto-progression or timers to skip phases.';
    case 'entity-incomplete':
      return 'Buildable entities must reach state=2 (built). Check build triggers, resource requirements, and player interaction with the build area.';
    case 'stuck':
    case 'stuck-pattern':
      return 'Game is stuck with no state changes. Check if player movement works, interaction targets are reachable, and trigger conditions can be satisfied.';
    case 'uncovered':
      return 'Some blueprint shots were not reached. Check if phase transitions trigger correctly and if the player can navigate to all game areas.';
    case 'cta':
      return 'CTA button was not reached or unresponsive. Ensure the final phase completes and CTA button calls Luna.Unity.Playable.InstallFullGame().';
    case 'no-content':
      return 'Game content was not visible. Check if objects are moved from pool position (y=-999) to visible positions during Start() or phase activation.';
    case 'solid-color':
      return 'Screen is a single color. Ground plane must be neutral gray, >=3 different-colored objects at y>=0, Camera.backgroundColor must differ from ground by >=0.3.';
    case 'engine-not-ready':
      return 'Luna engine failed to initialize. Check for JS errors in the build output and ensure Bridge.NET transpilation succeeded.';
    default:
      return '';
  }
}

/**
 * Build structured CUA feedback object (BUG-0011: structured JSON for better AI fixes).
 * Returns { text: string, structured: object }.
 *   .text = legacy human-readable string (backward compat)
 *   .structured = machine-parseable JSON for prompt rendering
 */
function buildStructuredFeedback(round, cuaResult, blueprint, fixHistory) {
  // Parse "[type] message" issues into structured objects
  const issues = (cuaResult.issues || []).map(function(issueStr) {
    const match = issueStr.match(/^\[([^\]]+)\]\s*(.*)/s);
    const type = match ? match[1] : 'unknown';
    const message = match ? match[2] : issueStr;

    const issue = {
      type: type,
      severity: getIssueSeverity(type),
      message: message,
      details: {},
      fix_hint: getFixHint(type)
    };

    // Enrich details based on type
    if (type === 'phase-coverage') {
      const coverageMatch = message.match(/(\d+)\/(\d+) phases completed/);
      if (coverageMatch) {
        issue.details.covered = parseInt(coverageMatch[1]);
        issue.details.total = parseInt(coverageMatch[2]);
      }
      const missingMatch = message.match(/Missing: (.+?)(?:\. |$)/);
      if (missingMatch) {
        issue.details.missing = missingMatch[1].split('; ').map(function(m) {
          const parts = m.match(/(.+?) \(trigger: (.+?)\)/);
          return parts ? { phaseId: parts[1].trim(), trigger: parts[2].trim() } : { phaseId: m.trim() };
        });
      }
    } else if (type === 'entity-incomplete') {
      const entityMatches = message.match(/(\w+)=(\d+)\s*\(expected (\d+)=(\w+)\)/g) || [];
      issue.details.entities = entityMatches.map(function(em) {
        const parts = em.match(/(\w+)=(\d+)\s*\(expected (\d+)=(\w+)\)/);
        return parts ? { entity: parts[1], currentState: parseInt(parts[2]), requiredState: parseInt(parts[3]), stateLabel: parts[4] } : {};
      });
    } else if (type === 'quick-test' && cuaResult.quickTestDetail) {
      if (cuaResult.quickTestDetail.solidColor) {
        issue.details.solidColor = cuaResult.quickTestDetail.solidColorDetail || {};
      }
    }

    return issue;
  });

  // Game state snapshot
  const gameState = {};
  if (cuaResult.report && cuaResult.report.gameState) {
    const gs = cuaResult.report.gameState;
    gameState.currentPhase = gs.currentPhase || 'unknown';
    gameState.completedPhases = gs.completedPhases || [];
    gameState.entityStates = gs.entityStates || {};
    gameState.variables = gs.variables || {};
  }

  // Console errors
  const consoleErrors = [];
  if (cuaResult.report && cuaResult.report.diagnostics && cuaResult.report.diagnostics.consoleErrors) {
    for (var i = 0; i < Math.min(cuaResult.report.diagnostics.consoleErrors.length, 10); i++) {
      consoleErrors.push(cuaResult.report.diagnostics.consoleErrors[i]);
    }
  }

  // Fix history summary
  const fixHistorySummary = (fixHistory || []).slice(-3).map(function(h) {
    return { round: h.round, category: h.issueCategory, topIssue: (h.issues && h.issues[0]) || 'unknown' };
  });

  // Structured payload
  const structured = {
    round: round,
    summary: issues.length + ' issue(s): ' + issues.map(function(i) { return i.type; }).join(', '),
    issues: issues,
    gameState: gameState,
    consoleErrors: consoleErrors,
    fixHistory: fixHistorySummary
  };

  // Legacy text (backward compatibility — same format as before)
  let text = 'CUA blueprint flow verification failed (round ' + round + '):\n' + (cuaResult.issues || []).join('\n');
  if (consoleErrors.length > 0) {
    text += '\nConsole errors:\n' + consoleErrors.map(function(e) { return '  - ' + e; }).join('\n');
  }
  if (cuaResult.report && cuaResult.report.gameState) {
    const gs = cuaResult.report.gameState;
    text += '\n\nGame State at failure:';
    text += '\n  Current Phase: ' + (gs.currentPhase || 'unknown');
    text += '\n  Completed Phases: ' + ((gs.completedPhases || []).join(', ') || 'none');
    if (gs.variables) text += '\n  Variables: ' + JSON.stringify(gs.variables);
    if (gs.entityStates) text += '\n  Entity States: ' + JSON.stringify(gs.entityStates);
  }
  text += '\n\nPlease fix the code to ensure blueprint flow works. Focus on the specific phase/entity that failed.';
  if (fixHistory && fixHistory.length > 1) {
    text += '\n\nFix history (do not repeat):';
    for (var hi = Math.max(0, fixHistory.length - 5); hi < fixHistory.length; hi++) {
      var h = fixHistory[hi];
      text += '\n  Round ' + h.round + ': ' + h.issueCategory + ' — ' + ((h.issues && h.issues[0]) || 'unknown');
    }
    text += '\nTry a different fix strategy.';
  }


  return { text: text, structured: structured };
}

// ============ Config ============
const WORKER_ID = process.env.LINUX_WORKER_ID || process.env.name || ('linux-worker-' + (process.env.pm_id || '1'));
const BASE_URL = process.env.LINUX_BASE_URL || 'http://120.55.70.226:3901';
// Fallback is local build-api (/opt/luna-poc/build-api.js). The old remote
// 120.55.70.226:3080 is a zombie (accepts TCP, returns empty reply) and silently
// turns every compile into ECONNRESET — see memory `feedback_dotenv_path_mismatch`.
const BUILD_URL = process.env.LINUX_BUILD_URL || 'http://127.0.0.1:18860';
const POLL_INTERVAL = 10000;       // 10s between polls
const HEARTBEAT_INTERVAL = 30000;
const MAX_CUA_ROUNDS = 5;
const TASK_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
// Worker start time — reported in heartbeat so watchdog can skip idle-desync
// reclaim for freshly-started workers (they need a grace period to re-poll
// and recover activeTasks state; otherwise a race with watchdog re-queues
// tasks mid-execution, bypassing MAX_CODE_RETRIES).
const WORKER_START_TIME = Date.now();

const activeTasks = new Map();
let pollLock = false;

// Track child process PIDs for graceful shutdown cleanup
const activeChildPIDs = new Set();

// ============ Logging ============
function log(msg, taskId) {
  const ts = new Date().toISOString().slice(11, 19);
  const prefix = taskId ? `[${ts}][${taskId}]` : `[${ts}]`;
  console.log(`${prefix} ${msg}`);
}

// ============ HTTP Helpers ============
function handleResponse(resolve, reject) {
  return (res) => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      if (res.statusCode === 204) return resolve(null);
      if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
      try { resolve(JSON.parse(data)); } catch(e) { resolve(data); }
    });
  };
}

function apiRequest(method, urlPath, body, isJSON) {
  return new Promise((resolve, reject) => {
    const fullUrl = new URL(BASE_URL + urlPath);
    const useProxy = process.env.https_proxy || process.env.HTTPS_PROXY;
    let mod, opts;
    
    if (useProxy && fullUrl.protocol === 'https:') {
      // HTTPS through HTTP CONNECT proxy
      const proxyUrl = new URL(useProxy);
      mod = http;
      opts = {
        hostname: proxyUrl.hostname,
        port: proxyUrl.port,
        path: fullUrl.hostname + ':' + (fullUrl.port || 443),
        method: 'CONNECT',
        timeout: 30000,
      };
      // Use CONNECT tunnel
      const tunnelReq = http.request(opts);
      tunnelReq.on('connect', (res, socket) => {
        const tls = require('tls');
        const tlsSocket = tls.connect({ host: fullUrl.hostname, socket, servername: fullUrl.hostname }, () => {
          const req = https.request({
            hostname: fullUrl.hostname,
            path: fullUrl.pathname + fullUrl.search,
            method,
            headers: { 'Content-Type': 'application/json' },
            socket: tlsSocket,
            agent: false,
            timeout: 30000,
          }, handleResponse(resolve, reject));
          req.on('error', reject);
          if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
          req.end();
        });
      });
      tunnelReq.on('error', reject);
      tunnelReq.end();
      return;
    }
    
    mod = fullUrl.protocol === 'https:' ? https : http;
    opts = {
      hostname: fullUrl.hostname,
      port: fullUrl.port || (fullUrl.protocol === 'https:' ? 443 : 80),
      path: fullUrl.pathname + fullUrl.search,
      method,
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000,
    };
    const req = mod.request(opts, handleResponse(resolve, reject));
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function reportStatus(taskId, status, extra) {
  const data = { workerId: WORKER_ID, taskId, status, message: (extra && extra.message) || '' };
  if (extra && extra.previewUrl) data.previewUrl = extra.previewUrl;
  if (extra && extra.qualityData) data.qualityData = extra.qualityData;
  // Forward structured failure attribution
  if (extra && extra.failedAtStage) data.failedAtStage = extra.failedAtStage;
  if (extra && extra.failReason) data.failReason = extra.failReason;
  if (extra && extra.failClassification) data.failClassification = extra.failClassification;
  if (extra && extra.failedAt) data.failedAt = extra.failedAt;
  if (extra && extra.durationMs) data.durationMs = extra.durationMs;
  return apiRequest('POST', '/api/worker/status', JSON.stringify(data)).catch(e => {
    log(`Status report failed: ${e.message}`, taskId);
  });
}

// POST /api/tasks/:taskId/cancel — used when classify() returns MODEL_FATAL
// so the task transitions to `cancelled` (terminal, not retried by the server
// watchdog) instead of `failed` (which is eligible for retry).
function cancelTaskViaApi(taskId, actor, reason) {
  var body = { actor: actor || 'worker:model-fatal' };
  if (reason) body.reason = reason;
  return apiRequest('POST', '/api/tasks/' + taskId + '/cancel', JSON.stringify(body));
}

// Thrown when a task is found to be cancelled server-side. Carries a distinct
// name so the outer processTask catch can handle it separately from regular
// failures (no 'failed' report, no retry counter bump).
class TaskCancelledError extends Error {
  constructor(taskId, serverStatus) {
    super('Task ' + taskId + ' cancelled server-side (status=' + serverStatus + ')');
    this.name = 'TaskCancelledError';
    this.taskId = taskId;
    this.serverStatus = serverStatus;
  }
}

// Probe server-side task status. Used between stages to detect manual
// cancellation; if the task is cancelled (or missing), we throw and the
// pipeline unwinds cleanly instead of burning more stages (and tokens).
// Returns the task status string on success; treats network errors as
// non-cancellation so a transient blueprint-editor hiccup doesn't kill
// in-progress work.
async function checkTaskCancelled(taskId) {
  try {
    var info = await apiRequest('GET', '/api/tasks/' + taskId + '/status');
    if (!info || !info.status) return null;
    if (info.status === 'cancelled') {
      throw new TaskCancelledError(taskId, info.status);
    }
    return info.status;
  } catch (e) {
    if (e instanceof TaskCancelledError) throw e;
    // Network/parse error — swallow. Better to keep running than to abort on
    // a transient server hiccup.
    return null;
  }
}

function buildRequest(endpoint, csCode, extraFiles) {
  return new Promise((resolve, reject) => {
    const url = new URL(BUILD_URL + endpoint);
    const body = JSON.stringify({ code: csCode, className: 'GameFlowManagerMain', extraFiles });
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 120000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (endpoint === '/build-html') return resolve(buf);
        try { resolve(JSON.parse(buf.toString())); } catch(e) { reject(new Error('Bad response: ' + buf.toString().slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Build timeout')); });
    req.write(body);
    req.end();
  });
}

// ============ Main Task Processing ============

// ============ Pipeline Integration ============
// Initial load — will be reloaded per-task to pick up auto-fix changes
var { createLunaPipeline, PipelineContext } = require('../engine/pipeline.cjs');

function reloadEngineModules() {
  var engineDir = path.resolve(__dirname, '..', 'engine');
  var adaptersDir = path.resolve(__dirname, '..', 'adapters');
  var workerDir = path.resolve(__dirname); // worker/ — where LLM adapters live
  // Never reload the worker entry script itself: it's the currently-executing
  // module and dropping its cache entry doesn't give us new code (we're already
  // running it) but breaks relative require resolution inside it.
  var selfPath = path.resolve(__filename);
  var count = 0;
  var workerCount = 0;
  Object.keys(require.cache).forEach(function(key) {
    if (key === selfPath) return;
    // Skip node_modules even if they live inside a scanned dir
    if (key.indexOf('node_modules') !== -1) return;
    if (key.startsWith(engineDir) || key.startsWith(adaptersDir)) {
      delete require.cache[key];
      count++;
    } else if (key.startsWith(workerDir)) {
      // Pipeline stages require many worker/ modules (codex-coder,
      // code-reviewer, codex-reviewer, worker-coder, screenshot-review, etc).
      // Without clearing them, edits to those files stay invisible until a
      // pm2 restart — exactly the "stale code" symptom that kept recurring.
      delete require.cache[key];
      workerCount++;
    }
  });
  if (count > 0 || workerCount > 0) {
    var fresh = require('../engine/pipeline.cjs');
    createLunaPipeline = fresh.createLunaPipeline;
    PipelineContext = fresh.PipelineContext;
    log('[hot-reload] Reloaded ' + count + ' engine/adapters + ' + workerCount + ' worker modules');
  }
}

async function processTask(task) {
  reloadEngineModules();
  const taskId = task.taskId;
  if (task.originalStatus) { task.status = task.originalStatus; }
  if (task.status === 'commit_needed') { log('Skip commit_needed task', taskId); return; }

  const startTime = Date.now();
  try {
    // === Step 1: Fetch Blueprint ===
    await reportStatus(taskId, 'processing', { message: '[Linux] AI coding...' });
    let blueprint = null;
    try {
      blueprint = await apiRequest('GET', `/api/tasks/${taskId}/blueprint`);
    } catch (e) {
      log('Failed to fetch blueprint: ' + e.message, taskId);
      await reportStatus(taskId, 'failed', { message: 'Blueprint fetch failed' });
      return;
    }

    if (!blueprint || !blueprint.entities || !Array.isArray(blueprint.entities) || blueprint.entities.length === 0) {
      log('Empty blueprint (no entities)', taskId);
      await reportStatus(taskId, 'failed', { message: 'Empty blueprint - no entities found' });
      return;
    }
    log(`Blueprint: ${blueprint.entities.length} entities`, taskId);

    // === Step 2: Check checkpoint for resume ===
    // Plan D: compare stored pipelineVersion vs current codegen fingerprint. On mismatch,
    // drop codegen + downstream stages (keep pure-upstream clone/spec-*), and wipe restored
    // csCode / extraFiles / stageResults so the resumed run regenerates from upstream.
    const checkpoint = loadCheckpoint(taskId);
    let checkpointDecision = null;
    if (checkpoint) {
      const currentFp = checkpointHelper.computePipelineFingerprint();
      checkpointDecision = checkpointHelper.reconcileCheckpoint(checkpoint, currentFp);
      if (checkpointDecision.action === 'resume') {
        log(`[checkpoint] Resuming (fingerprint match ${currentFp.hash}) from ${checkpoint.savedAt}`, taskId);
      } else if (checkpointDecision.action === 'resume-legacy') {
        log(`[checkpoint] Resuming pre-D checkpoint at ${checkpoint.savedAt} — ${checkpointDecision.warn}`, taskId);
      } else if (checkpointDecision.action === 'invalidate') {
        log(`[checkpoint] Pipeline fingerprint changed (saved=${checkpointDecision.savedHash} current=${checkpointDecision.currentHash}). Dropping stages: [${checkpointDecision.droppedStages.join(', ')}]. Keeping: [${checkpointDecision.completedStages.join(', ')}]`, taskId);
      }
    }

    // === Step 3: Build pipeline context ===
    const pipelineTask = {
      taskId: taskId,
      blueprint: blueprint,
    };

    const workerConfig = {
      workerId: WORKER_ID,
      baseUrl: BASE_URL,
      buildUrl: BUILD_URL,
    };

    // Map checkpoint to pipeline format
    const pipelineCheckpoint = {};
    const invalidated = checkpointDecision && checkpointDecision.action === 'invalidate';
    if (checkpoint && checkpoint.csCode) {
      if (invalidated) {
        // Fingerprint mismatch: keep only upstream pure-input stages, force codegen re-run.
        pipelineCheckpoint.completedStages = checkpointDecision.completedStages;
      } else if (checkpoint.completedStages && checkpoint.completedStages.length > 0) {
        pipelineCheckpoint.completedStages = checkpoint.completedStages;
        log(`[checkpoint] Resuming with completedStages: [${checkpoint.completedStages.join(', ')}]`, taskId);
      } else {
        // Legacy checkpoint without completedStages — fall back to old behavior
        pipelineCheckpoint.completedStages = ['clone', 'codegen', 'review'];
        log(`[checkpoint] Legacy checkpoint — resuming after review stage`, taskId);
      }
      pipelineCheckpoint.cuaRound = invalidated ? 0 : (checkpoint.cuaRound || 0);
      pipelineCheckpoint.fixHistory = invalidated ? [] : (checkpoint.fixHistory || []);
    }

    const ctx = new PipelineContext(pipelineTask, pipelineCheckpoint, workerConfig);

    // Restore full checkpoint state — skip csCode/extraFiles/stageResults on invalidate so
    // downstream stages re-derive from upstream. Keep feedbackHistory (blueprint-level state).
    if (checkpoint && checkpoint.csCode && !invalidated) {
      ctx.csCode = checkpoint.csCode;
      ctx.blueprint.feedbackHistory = checkpoint.feedbackHistory || [];
      if (checkpoint.extraFiles) {
        // GFM_* canonical files must stay fresh-from-disk (loaded in PipelineContext).
        // A stale checkpoint from before a GFM fix will otherwise silently override
        // the on-disk fix for the life of the task (2026-04-20 w7113b Stage 1
        // realtimeSinceStartup fix was masked by 22:58 checkpoint extraFiles).
        var gfmList = require('./gfm-files.cjs').GFM_FILES || [];
        var gfmSet = {};
        for (var gi = 0; gi < gfmList.length; gi++) gfmSet[gfmList[gi]] = 1;
        for (var efk in checkpoint.extraFiles) {
          if (!checkpoint.extraFiles.hasOwnProperty(efk)) continue;
          if (gfmSet[efk]) continue;
          ctx.extraFiles[efk] = checkpoint.extraFiles[efk];
        }
      }
      if (checkpoint.stageResults) {
        ctx.stageResults = checkpoint.stageResults;
      }
      if (checkpoint.htmlOutput) {
        ctx.htmlOutput = checkpoint.htmlOutput;
        log(`[checkpoint] Restored htmlOutput (${(checkpoint.htmlOutput.length / 1048576).toFixed(1)}MB)`, taskId);
      }
      if (checkpoint.workDir && fs.existsSync(checkpoint.workDir)) {
        ctx.workDir = checkpoint.workDir;
        log(`[checkpoint] Restored workDir: ${checkpoint.workDir}`, taskId);
      }
    } else if (invalidated) {
      // Preserve feedbackHistory only; everything else must regenerate.
      ctx.blueprint.feedbackHistory = checkpoint.feedbackHistory || [];
    }

    // Store pipeline context reference for graceful shutdown
    if (activeTasks.has(taskId)) {
      activeTasks.get(taskId).pipelineCtx = ctx;
    }

    // === Step 4: Run pipeline ===
    const pipeline = createLunaPipeline();

    const onProgress = function(stageName, status, pCtx) {
      log(`[pipeline] ${stageName}: ${status}`, taskId);
      if (status === 'completed') {
        // Save full checkpoint after each completed stage
        saveCheckpoint(taskId, {
          csCode: pCtx.csCode,
          cuaRound: pCtx.checkpoint.cuaRound || 0,
          feedbackHistory: pCtx.blueprint.feedbackHistory || [],
          fixHistory: pCtx.checkpoint.fixHistory || [],
          completedStages: pCtx.completedStages,
          extraFiles: pCtx.extraFiles,
          stageResults: pCtx.stageResults,
          workDir: pCtx.workDir,
          htmlOutput: pCtx.htmlOutput,
        });
      }
    };

    // Cancellation poller — every 30s, check server-side task status.
    // If cancelled, set ctx._cancelled so pipeline unwinds at the next stage
    // boundary. Transient network errors are swallowed inside checkTaskCancelled.
    var cancelPollHandle = setInterval(function() {
      checkTaskCancelled(taskId).catch(function(e) {
        if (e && e.name === 'TaskCancelledError') {
          ctx._cancelled = true;
          log('[cancel] Server reports task cancelled — pipeline will unwind', taskId);
        }
      });
    }, 30000);

    try {
      await pipeline.run(ctx, onProgress);
    } finally {
      clearInterval(cancelPollHandle);
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(0);
    log(`Task completed in ${totalTime}s`, taskId);

    // Report success to server so project status transitions correctly
    await reportStatus(taskId, 'done', {
      message: '[Linux] Build OK (' + totalTime + 's)',
      durationMs: Date.now() - startTime,
    });

    // Cleanup
    if (ctx.workDir && fs.existsSync(ctx.workDir)) {
      try { fs.rmSync(ctx.workDir, { recursive: true, force: true }); } catch(e) {}
    }
    clearCheckpoint(taskId);
    log(`[checkpoint] Cleared for task ${taskId}`, taskId);

  } catch (e) {
    // Cancellation path — server already set status=cancelled, nothing to report.
    // Clear the checkpoint (cancelled is terminal, no resume) and any workdir.
    if (e && e.name === 'TaskCancelledError') {
      log('Task cancelled server-side — exiting cleanly', taskId);
      try { clearCheckpoint(taskId); } catch(_) {}
      return;
    }

    log('Task error: ' + e.message, taskId);

    // Extract structured failure info from PipelineError or legacy message format
    var failInfo = { message: '[Linux] Error: ' + e.message.slice(0, 200) };
    if (e.name === 'PipelineError') {
      // New format: PipelineError carries stage + rootCause directly
      failInfo.failedAtStage = e.stage;
      failInfo.failReason = e.rootCause;
      failInfo.failClassification = e.classification;
    } else {
      // Legacy format: parse from message string
      var stageMatch = e.message.match(/Pipeline failed at (\S+):/);
      var gateMatch = e.message.match(/Quality gate failed before (\S+):/);
      if (stageMatch) {
        failInfo.failedAtStage = stageMatch[1];
        failInfo.failReason = e.message.replace('Pipeline failed at ' + stageMatch[1] + ': ', '');
      } else if (gateMatch) {
        failInfo.failedAtStage = gateMatch[1];
        failInfo.failReason = 'gate: ' + e.message.replace('Quality gate failed before ' + gateMatch[1] + ': ', '');
      }
    }
    // Classify error (if not already classified by PipelineError)
    if (!failInfo.failClassification) {
      try {
        var { classify } = require('../engine/error-classifier.cjs');
        failInfo.failClassification = classify(e).type;
      } catch(ce) {}
    }

    failInfo.failedAt = new Date().toISOString();
    failInfo.durationMs = Date.now() - startTime;

    // MODEL_FATAL → cancel the task outright instead of reporting 'failed'.
    // 'failed' is retried by the server watchdog, which would just burn more
    // tokens on the same dead model backend. 'cancelled' is terminal.
    // See project_pipeline_fixes_20260415.md + plans/precious-swimming-pine.md.
    if (failInfo.failClassification === 'MODEL_FATAL') {
      log('[worker] MODEL_FATAL detected — cancelling task ' + taskId + ' (reason: ' + (failInfo.failReason || 'unknown') + ')', taskId);
      try {
        await cancelTaskViaApi(taskId, 'worker:model-fatal', failInfo.failReason);
        log('[worker] Task ' + taskId + ' cancelled via API', taskId);
        // Cancelled is terminal — clear the checkpoint (no resume point).
        try { clearCheckpoint(taskId); } catch(_) {}
        return;
      } catch (cancelErr) {
        log('[worker] cancelTaskViaApi failed, falling back to reportStatus(failed): ' + cancelErr.message, taskId);
        // fall through to reportStatus below
      }
    }

    await reportStatus(taskId, 'failed', failInfo);
    // Keep checkpoint on failure — allows resume on retry instead of starting from scratch
    // clearCheckpoint(taskId); // DISABLED: preserve checkpoint for restart resilience
  }
}

// ============ Poll Loop ============
async function poll() {
  if (pollLock || activeTasks.size >= 1) return;
  pollLock = true;
  try {
    const task = await apiRequest('GET', `/api/worker/poll?workerId=${WORKER_ID}`);
    if (!task || !task.taskId) return;
    if (activeTasks.has(task.taskId)) return;

    log(`Got task: ${task.taskId}, project: ${task.projectName || '?'}`, task.taskId);
    activeTasks.set(task.taskId, { startedAt: Date.now() });

    processTask(task).then(() => {
      activeTasks.delete(task.taskId);
    }).catch(e => {
      log('Task fatal: ' + e.message, task.taskId);
      activeTasks.delete(task.taskId);
    });
  } catch (e) {
    // No tasks or network error — silent
  } finally {
    pollLock = false;
  }
}

// ============ Graceful Shutdown ============
var shuttingDown = false;

function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('[shutdown] ' + signal + ' received — saving checkpoints and cleaning up...');

  // Stop polling and heartbeat timers
  pollLock = true;
  try { clearInterval(pollTimer); } catch(e) {}
  try { clearInterval(heartbeatTimer); } catch(e) {}

  // Kill all tracked child processes (LLM CLI, python CUA, etc.)
  var allPIDs = new Set(activeChildPIDs);
  if (process._activeChildPIDs) {
    process._activeChildPIDs.forEach(function(p) { allPIDs.add(p); });
  }
  allPIDs.forEach(function(pid) {
    try {
      process.kill(pid, 'SIGTERM');
      log('[shutdown] Killed child PID ' + pid);
    } catch(e) {
      // Process already exited — ignore
    }
  });

  // Kill entire process tree (children + grandchildren like nested CLI subprocesses)
  try {
    var myPid = process.pid;
    var { execSync } = require('child_process');
    // pkill -TERM -P sends SIGTERM to all direct children; repeat for grandchildren
    execSync('pkill -TERM -P ' + myPid + ' 2>/dev/null; sleep 0.1; pkill -TERM -P ' + myPid + ' 2>/dev/null', { timeout: 5000, shell: true });
    log('[shutdown] Killed child process tree via pkill');
  } catch(e) {
    // pkill returns 1 if no processes matched — fine
  }

  // Save checkpoint for all active tasks
  var saved = 0;
  activeTasks.forEach(function(info, taskId) {
    var ctx = info.pipelineCtx;
    if (ctx && ctx.csCode) {
      try {
        saveCheckpoint(taskId, {
          csCode: ctx.csCode,
          cuaRound: ctx.checkpoint ? ctx.checkpoint.cuaRound || 0 : 0,
          feedbackHistory: ctx.blueprint ? ctx.blueprint.feedbackHistory || [] : [],
          fixHistory: ctx.checkpoint ? ctx.checkpoint.fixHistory || [] : [],
          completedStages: ctx.completedStages,
          extraFiles: ctx.extraFiles,
          stageResults: ctx.stageResults,
          workDir: ctx.workDir,
          htmlOutput: ctx.htmlOutput,
        });
        log('[shutdown] Checkpoint saved for ' + taskId + ' (stages: ' + ctx.completedStages.join(',') + ')', taskId);
        saved++;
      } catch(e) {
        log('[shutdown] Failed to save checkpoint for ' + taskId + ': ' + e.message, taskId);
      }
    } else {
      log('[shutdown] No pipeline context for ' + taskId + ' — cannot save', taskId);
    }
  });

  log('[shutdown] Saved ' + saved + '/' + activeTasks.size + ' checkpoints. Exiting.');
  process.exit(0);
}

process.on('SIGTERM', function() { gracefulShutdown('SIGTERM'); });
process.on('SIGINT', function() { gracefulShutdown('SIGINT'); });

// ============ Error Handling ============
process.on('uncaughtException', (e) => {
  log('UNCAUGHT: ' + e.stack);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});
process.on('unhandledRejection', (e) => {
  log('UNHANDLED REJECTION: ' + (e && e.stack ? e.stack : e));
  // Don't crash — log and continue. The task-level catch will handle it.
});

// ============ Start ============
log(`Linux Worker starting | ID: ${WORKER_ID} | Server: ${BASE_URL} | Build: ${BUILD_URL}`);
var pollTimer = setInterval(poll, POLL_INTERVAL);
poll();

// Heartbeat
var heartbeatTimer = setInterval(() => {
  var currentTaskId = null;
  var workerStatus = 'idle';
  if (activeTasks.size > 0) {
    currentTaskId = activeTasks.keys().next().value;
    workerStatus = 'busy';
  }
  apiRequest('POST', '/api/worker/heartbeat', JSON.stringify({
    workerId: WORKER_ID, type: 'linux',
    status: workerStatus,
    currentTask: currentTaskId,
    activeTasks: activeTasks.size,
    uptime: Math.floor((Date.now() - WORKER_START_TIME) / 1000),
  })).catch(() => {});
}, HEARTBEAT_INTERVAL);
