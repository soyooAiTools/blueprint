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

require('dotenv').config({ path: require('path').join(__dirname, '.env'), override: true });

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
let generateCodeV5; try { generateCodeV5 = require('./worker-coder.js').generateCodeV5; } catch(e) {}
let generateWithClaudeCode; try { generateWithClaudeCode = require('./claude-code-coder.js').generateWithClaudeCode; } catch(e) {}
let patchForHeadless; try { patchForHeadless = require('./worker-cua-verify.js').patchForHeadless; } catch(e) {}

// Claude Code 模式开关：设为 true 使用 Claude Code CLI agent，false 使用传统 API 调用
const USE_CLAUDE_CODE = process.env.USE_CLAUDE_CODE !== 'false'; // 默认开启

// ============ Base Template Cache (avoid repeated git clones) ============
const TEMPLATE_CACHE_DIR = path.join(require('os').tmpdir(), 'luna-base-cache');
const TEMPLATE_CACHE_MAX_AGE = 3600 * 1000; // 1 hour

function getBaseTemplate(targetDir, log, taskId) {
  const { execSync } = require('child_process');
  const cacheValid = fs.existsSync(TEMPLATE_CACHE_DIR)
    && fs.existsSync(path.join(TEMPLATE_CACHE_DIR, '.git'))
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
}

// ============ Task Checkpoint (persist best code across worker restarts) ============
const CHECKPOINT_DIR = path.join(__dirname, '..', 'server-data', 'checkpoints');

function getCheckpointPath(taskId) {
  return path.join(CHECKPOINT_DIR, taskId);
}

function saveCheckpoint(taskId, data) {
  const dir = getCheckpointPath(taskId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'checkpoint.json'), JSON.stringify({
    csCode: data.csCode,
    cuaRound: data.cuaRound,
    feedbackHistory: data.feedbackHistory,
    fixHistory: data.fixHistory || [],
    savedAt: new Date().toISOString()
  }));
}

function loadCheckpoint(taskId) {
  const fp = path.join(getCheckpointPath(taskId), 'checkpoint.json');
  if (fs.existsSync(fp)) {
    try {
      return JSON.parse(fs.readFileSync(fp, 'utf8'));
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
const BUILD_URL = process.env.LINUX_BUILD_URL || 'http://120.55.70.226:3080';
const POLL_INTERVAL = 10000;       // 10s between polls
const HEARTBEAT_INTERVAL = 30000;
const MAX_CUA_ROUNDS = 5;
const TASK_TIMEOUT_MS = 30 * 60 * 1000; // 30 min

const activeTasks = new Map();
let pollLock = false;

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
const { createLunaPipeline, PipelineContext } = require('../engine/pipeline.cjs');

async function processTask(task) {
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
    const checkpoint = loadCheckpoint(taskId);
    if (checkpoint) {
      log(`[checkpoint] Resuming from saved checkpoint at ${checkpoint.savedAt}`, taskId);
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
    if (checkpoint && checkpoint.csCode) {
      // If we have saved code, skip clone+codegen+review and resume from compile
      pipelineCheckpoint.completedStages = ['clone', 'codegen', 'review'];
      pipelineCheckpoint.cuaRound = checkpoint.cuaRound || 0;
      pipelineCheckpoint.fixHistory = checkpoint.fixHistory || [];
      log(`[checkpoint] Resuming pipeline after review stage (CUA round ${pipelineCheckpoint.cuaRound})`, taskId);
    }

    const ctx = new PipelineContext(pipelineTask, pipelineCheckpoint, workerConfig);

    // Restore checkpoint state
    if (checkpoint && checkpoint.csCode) {
      ctx.csCode = checkpoint.csCode;
      ctx.blueprint.feedbackHistory = checkpoint.feedbackHistory || [];
    }

    // === Step 4: Run pipeline ===
    const pipeline = createLunaPipeline();

    const onProgress = function(stageName, status, pCtx) {
      log(`[pipeline] ${stageName}: ${status}`, taskId);
      if (status === 'completed' && pCtx.csCode) {
        // Save checkpoint after each major stage
        saveCheckpoint(taskId, {
          csCode: pCtx.csCode,
          cuaRound: pCtx.checkpoint.cuaRound || 0,
          codingPhase: stageName + '-complete',
          feedbackHistory: pCtx.blueprint.feedbackHistory || [],
          fixHistory: pCtx.checkpoint.fixHistory || [],
        });
      }
    };

    await pipeline.run(ctx, onProgress);

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
    log('Task error: ' + e.message, taskId);

    // Extract structured failure info from pipeline context or error message
    var failInfo = { message: '[Linux] Error: ' + e.message.slice(0, 200) };
    var stageMatch = e.message.match(/Pipeline failed at (\S+):/);
    var gateMatch = e.message.match(/Quality gate failed before (\S+):/);
    if (stageMatch) {
      failInfo.failedAtStage = stageMatch[1];
      failInfo.failReason = e.message.replace('Pipeline failed at ' + stageMatch[1] + ': ', '');
    } else if (gateMatch) {
      failInfo.failedAtStage = gateMatch[1];
      failInfo.failReason = 'gate: ' + e.message.replace('Quality gate failed before ' + gateMatch[1] + ': ', '');
    }
    // Classify error
    try {
      var { classify } = require('../engine/error-classifier.cjs');
      failInfo.failClassification = classify(e).type;
    } catch(ce) {}

    failInfo.failedAt = new Date().toISOString();
    failInfo.durationMs = Date.now() - startTime;

    await reportStatus(taskId, 'failed', failInfo);
    clearCheckpoint(taskId);
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

// ============ Error Handling ============
process.on('uncaughtException', (e) => { log('UNCAUGHT: ' + e.stack); });
process.on('unhandledRejection', (e) => { log('UNHANDLED: ' + (e.stack || e)); });

// ============ Start ============
log(`Linux Worker starting | ID: ${WORKER_ID} | Server: ${BASE_URL} | Build: ${BUILD_URL}`);
setInterval(poll, POLL_INTERVAL);
poll();

// Heartbeat
setInterval(() => {
  apiRequest('POST', '/api/worker/heartbeat', JSON.stringify({
    workerId: WORKER_ID, type: 'linux', status: 'idle',
    activeTasks: activeTasks.size,
  })).catch(() => {});
}, HEARTBEAT_INTERVAL);
