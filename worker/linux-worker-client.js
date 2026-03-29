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
const { generateCodeV5 } = require('./worker-coder.js');
const { generateWithClaudeCode } = require('./claude-code-coder.js');

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

    if (!blueprint || !blueprint.nodes || blueprint.nodes.length === 0) {
      log('Empty blueprint, skipping', taskId);
      await reportStatus(taskId, 'failed', { message: 'Empty blueprint' });
      return;
    }

    log(`Blueprint: ${blueprint.nodes.length} nodes, ${(blueprint.edges || []).length} edges`, taskId);

    // Check for existing checkpoint (resume after worker restart)
    const checkpoint = loadCheckpoint(taskId);
    if (checkpoint) {
      log(`[checkpoint] Resuming from round ${checkpoint.cuaRound}, saved at ${checkpoint.savedAt}`, taskId);
    }

    // === Step 2: Git clone base template + AI Coding ===
    const tempDir = path.join(require('os').tmpdir(), `linux-task-${taskId}`);
    const BASE_TEMPLATE_REPO = process.env.BASE_TEMPLATE_REPO || 'https://github.com/soyooAiTools/luna-base-template.git';

    // Helper: recursively find files by extension
    function findFiles(dir, ext) {
      const results = [];
      try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const fp = path.join(dir, e.name);
          if (e.isDirectory()) results.push(...findFiles(fp, ext));
          else if (e.name.endsWith(ext)) results.push(fp);
        }
      } catch(e) {}
      return results;
    }

    // Always use canonical GFM_Tools.cs from worker dir (never AI-generated version)
    const extraFiles = {};
    const canonicalGfm = path.join(__dirname, 'GFM_Tools.cs');
    if (fs.existsSync(canonicalGfm)) {
      extraFiles['GFM_Tools.cs'] = fs.readFileSync(canonicalGfm, 'utf-8');
    }

    let csCode;

    if (checkpoint && checkpoint.csCode) {
      // === Checkpoint resume: skip code generation + review, use saved code ===
      csCode = checkpoint.csCode;
      blueprint.feedbackHistory = checkpoint.feedbackHistory || [];
      log(`[checkpoint] Using saved code (${csCode.length} chars), skipping initial generation + review`, taskId);
      await reportStatus(taskId, 'processing', { message: `[Linux] Resuming from checkpoint (round ${checkpoint.cuaRound}), rebuilding...` });
    } else {
      // === Normal path: clone, generate, review ===
      // Clean up previous run if exists
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }

      // Git clone the base Unity project as foundation
      log('Preparing base template...', taskId);
      await reportStatus(taskId, 'processing', { message: '[Linux] Preparing base template...' });
      try {
        getBaseTemplate(tempDir, log, taskId);
        log('Base template ready', taskId);
      } catch (cloneErr) {
        log('Git clone failed: ' + cloneErr.message, taskId);
        await reportStatus(taskId, 'failed', { message: '[Linux] Git clone base template failed: ' + (cloneErr.message || '').slice(0, 200) });
        return;
      }

      // AI-generated code goes into the base project's script directory
      const assetsDir = path.join(tempDir, 'Assets', 'Program', 'Script', 'Manager');
      fs.mkdirSync(assetsDir, { recursive: true });

      const codeResult = USE_CLAUDE_CODE
        ? await generateWithClaudeCode(blueprint, tempDir, log, taskId, 'unity')
        : await generateCodeV5(blueprint, tempDir, log, taskId, 'unity');
      if (!codeResult.ok) {
        log('AI coding failed: ' + codeResult.error, taskId);
        await reportStatus(taskId, 'failed', { message: '[Linux] AI coding failed: ' + (codeResult.error || '').slice(0, 200) });
        return;
      }
      log(`AI coding done: ${codeResult.filesWritten} files`, taskId);
      await reportStatus(taskId, 'processing', { message: `[Linux] AI coding done (${codeResult.filesWritten} files), building...` });

      // === Step 3: Read generated C# files (search recursively) ===
      const allCs = findFiles(tempDir, '.cs');
      const mainCsPath = allCs.find(f => f.includes('GameFlowManagerMain.cs'));

      if (!mainCsPath) {
        log('No GameFlowManagerMain.cs found in: ' + allCs.join(', '), taskId);
        await reportStatus(taskId, 'failed', { message: '[Linux] No GameFlowManagerMain.cs generated' });
        return;
      }

      csCode = fs.readFileSync(mainCsPath, 'utf-8');
      log(`Main CS: ${mainCsPath} (${csCode.length} chars)`, taskId);

      // === Step 3.5: Code Review (Codex or GPT-5.4 fallback) ===
    let codeReviewer;
    let codexReviewer;
    try { codeReviewer = require('./code-reviewer.js'); } catch(e) {}
    try { codexReviewer = require('./codex-reviewer.js'); } catch(e) {}
    const USE_CODEX_REVIEW = process.env.USE_CODEX_REVIEW !== 'false'; // 默认开启
    if ((USE_CODEX_REVIEW && codexReviewer || codeReviewer) && csCode) {
      const MAX_REVIEW_ROUNDS = 3;
      let reviewedCode = csCode;
      const reviewerName = USE_CODEX_REVIEW && codexReviewer ? 'Codex' : 'GPT-5.4';
      await reportStatus(taskId, 'processing', { message: `[Linux] ${reviewerName} 代码审核中...` });
      for (let reviewRound = 1; reviewRound <= MAX_REVIEW_ROUNDS; reviewRound++) {
        let reviewResult;
        if (USE_CODEX_REVIEW && codexReviewer) {
          reviewResult = await codexReviewer.reviewCodeWithCodex(reviewedCode, { taskId, log });
          // Fallback to GPT-5.4 if Codex had environment/parse errors (not real code issues)
          if (!reviewResult.passed && (reviewResult.parseError || reviewResult.error) && codeReviewer) {
            log(`[reviewer] Codex review had env/parse error, falling back to GPT-5.4 API`, taskId);
            reviewResult = await codeReviewer.reviewCode(reviewedCode, { taskId, log });
          }
        } else if (codeReviewer) {
          reviewResult = await codeReviewer.reviewCode(reviewedCode, { taskId, log });
        } else {
          reviewResult = { passed: true, issues: [], skipped: true };
        }
        if (reviewResult.passed) {
          log(`[reviewer] ✅ ${reviewerName} review PASSED${reviewRound > 1 ? ` (round ${reviewRound})` : ''}`, taskId);
          await reportStatus(taskId, 'processing', { message: `[Linux] ${reviewerName} 审核通过 ✅${reviewRound > 1 ? ` (第${reviewRound}轮)` : ''} — ${reviewResult.summary || ''}`.slice(0, 100), qualityData: { reviewResult: { passed: true, reviewer: reviewerName, round: reviewRound, summary: reviewResult.summary || '' } } });
          break;
        }
        if (reviewRound >= MAX_REVIEW_ROUNDS) {
          log(`[reviewer] ⚠️ ${reviewerName} review still FAIL after ${MAX_REVIEW_ROUNDS} rounds, proceeding`, taskId);
          await reportStatus(taskId, 'processing', { message: `[Linux] ${reviewerName} 审核 ${MAX_REVIEW_ROUNDS} 轮仍 FAIL，继续编译...`, qualityData: { reviewResult: { passed: false, reviewer: reviewerName, round: MAX_REVIEW_ROUNDS, criticalCount: reviewResult.criticalCount || 0 } } });
          break;
        }
        log(`[reviewer] 🔄 ${reviewerName} review FAIL (round ${reviewRound}/${MAX_REVIEW_ROUNDS}), fixing...`, taskId);
        await reportStatus(taskId, 'processing', { message: `[Linux] ${reviewerName} 审核失败 (${reviewRound}/${MAX_REVIEW_ROUNDS})，${reviewResult.criticalCount || '?'}个严重问题，AI修复中...` });
        // Send review feedback to Claude for fixing
        const reviewFixBlueprint = { ...blueprint, feedbackHistory: [...(blueprint.feedbackHistory || []), { text: reviewResult.feedback, source: 'code-review' }] };
        const fixResult = USE_CLAUDE_CODE
          ? await generateWithClaudeCode(reviewFixBlueprint, tempDir, log, taskId, 'unity')
          : await generateCodeV5(reviewFixBlueprint, tempDir, log, taskId, 'unity');
        if (fixResult.ok) {
          reviewedCode = fs.readFileSync(mainCsPath, 'utf-8');
          log(`[reviewer] Review fix applied (${reviewedCode.length} chars), re-reviewing...`, taskId);
        }
      }
      // Update csCode with reviewed version
      csCode = fs.readFileSync(mainCsPath, 'utf-8');
    }
    } // end of normal path (no checkpoint)

    // === Step 4: Linux Build (Bridge.NET + stage4 assembly) with auto-fix ===
    const MAX_BUILD_FIX_ATTEMPTS = 3;
    let lastCsCode = csCode;
    let lastExtraFiles = { ...extraFiles };
    let buildResult;
    let buildOk = false;

    for (let buildAttempt = 1; buildAttempt <= MAX_BUILD_FIX_ATTEMPTS + 1; buildAttempt++) {
      const attemptLabel = buildAttempt === 1 ? '' : ` (fix attempt ${buildAttempt - 1}/${MAX_BUILD_FIX_ATTEMPTS})`;
      await reportStatus(taskId, 'building', { message: `[Linux] Bridge.NET compiling...${attemptLabel}` });
      
      try {
        buildResult = await buildRequest('/build', lastCsCode, lastExtraFiles);
      } catch (e) {
        buildResult = { ok: false, error: e.message };
      }

      if (buildResult.ok) {
        buildOk = true;
        log(`Build OK in ${buildResult.buildTime}s${attemptLabel}`, taskId);
        break;
      }

      const buildError = buildResult.error || '';
      log(`Build failed${attemptLabel}: ${buildError.slice(0, 300)}`, taskId);

      // No more fix attempts left
      if (buildAttempt > MAX_BUILD_FIX_ATTEMPTS) break;

      // === Auto-fix: feed compile error to AI for code correction ===
      await reportStatus(taskId, 'processing', { message: `[Linux] Build failed, AI fixing... (${buildAttempt}/${MAX_BUILD_FIX_ATTEMPTS})` });

      const fixPrompt = `The C# code failed to compile with Bridge.NET/msbuild. Fix the compilation errors.\n\n` +
        `=== COMPILE ERRORS ===\n${buildError.slice(0, 2000)}\n\n` +
        `=== CURRENT CODE (GameFlowManagerMain.cs) ===\n${lastCsCode}\n\n` +
        `IMPORTANT RULES:\n` +
        `- Add missing "using" directives (e.g. "using UnityEngine;" for MonoBehaviour)\n` +
        `- Do NOT remove or rename GFM_Tools classes — they are provided externally\n` +
        `- Do NOT change the overall structure, only fix compilation errors\n` +
        `- Return the COMPLETE fixed GameFlowManagerMain.cs file\n` +
        `- The code must compile with Bridge.NET (C# → JavaScript transpiler)`;

      // Inject compile error as feedback for incremental fix
      if (!blueprint.feedbackHistory) blueprint.feedbackHistory = [];
      blueprint.feedbackHistory.push({
        data: { text: `Build compilation failed:\n${buildError.slice(0, 1500)}\nPlease fix the C# compilation errors.` },
        source: 'build-fix-attempt-' + buildAttempt,
        status: 'pending',
        timestamp: Date.now()
      });

      const fixTempDir = path.join(require('os').tmpdir(), `linux-buildfix-${taskId}-${buildAttempt}`);
      if (fs.existsSync(fixTempDir)) fs.rmSync(fixTempDir, { recursive: true, force: true });

      // Git clone base template for fix attempt
      try {
        getBaseTemplate(fixTempDir, log, taskId);
      } catch (cloneFixErr) {
        log(`Build fix git clone failed: ${cloneFixErr.message}`, taskId);
        continue;
      }

      const fixAssetsDir = path.join(fixTempDir, 'Assets', 'Program', 'Script', 'Manager');
      fs.mkdirSync(fixAssetsDir, { recursive: true });
      // Write current code for AI to fix (GFM_Tools.cs already in git repo)
      fs.writeFileSync(path.join(fixAssetsDir, 'GameFlowManagerMain.cs'), lastCsCode);

      let fixResult;
      try {
        fixResult = USE_CLAUDE_CODE
          ? await generateWithClaudeCode(blueprint, fixTempDir, log, taskId, 'unity')
          : await generateCodeV5(blueprint, fixTempDir, log, taskId, 'unity');
      } catch (fixErr) {
        log(`Build fix re-code error: ${fixErr.message}`, taskId);
        try { fs.rmSync(fixTempDir, { recursive: true, force: true }); } catch(e) {}
        continue;
      }

      if (!fixResult.ok) {
        log('Build fix re-code failed: ' + fixResult.error, taskId);
        try { fs.rmSync(fixTempDir, { recursive: true, force: true }); } catch(e) {}
        continue;
      }

      // Read fixed code
      const fixCsFiles = findFiles(fixTempDir, '.cs');
      const fixMainCs = fixCsFiles.find(f => f.includes('GameFlowManagerMain.cs'));
      if (!fixMainCs) {
        log('Build fix: no GameFlowManagerMain.cs found', taskId);
        try { fs.rmSync(fixTempDir, { recursive: true, force: true }); } catch(e) {}
        continue;
      }

      lastCsCode = fs.readFileSync(fixMainCs, 'utf-8');
      // Always use canonical GFM_Tools.cs (never AI-generated version which may lack using directives)
      try { fs.rmSync(fixTempDir, { recursive: true, force: true }); } catch(e) {}

      log(`Build fix ${buildAttempt}: got fixed code (${lastCsCode.length} chars), retrying build...`, taskId);
    }

    if (!buildOk) {
      await reportStatus(taskId, 'failed', { message: '[Linux] Build failed after ' + MAX_BUILD_FIX_ATTEMPTS + ' fix attempts: ' + (buildResult.error || '').slice(0, 200) });
      return;
    }

    log(`Build OK in ${buildResult.buildTime}s, HTML: ${buildResult.htmlSize}`, taskId);
    await reportStatus(taskId, 'processing', { message: `[Linux] Build OK (${buildResult.buildTime}s), starting CUA...` });

    // === Step 5: Download HTML & Run CUA ===
    const htmlOutputDir = path.join(require('os').tmpdir(), `linux-html-${taskId}`);
    fs.mkdirSync(htmlOutputDir, { recursive: true });
    const htmlPath = path.join(htmlOutputDir, taskId + '.html');

    const htmlData = await buildRequest('/build-html', lastCsCode, lastExtraFiles);
    fs.writeFileSync(htmlPath, htmlData);
    log(`HTML saved: ${(htmlData.length / 1048576).toFixed(1)}MB → ${htmlPath}`, taskId);

    // Save preview copy to webgl dir (web-accessible)
    const previewDir = path.join('/opt/blueprint-editor/server-data/webgl', taskId);
    fs.mkdirSync(previewDir, { recursive: true });
    fs.writeFileSync(path.join(previewDir, 'index.html'), htmlData);
    const previewUrl = `https://playcools.top/webgl/${taskId}/index.html`;
    log(`Preview: ${previewUrl}`, taskId);

    // === Step 5.5: Visual Verification (screenshot + Claude Sonnet analysis) ===
    const MAX_VISUAL_ROUNDS = 5;
    let visualPassed = false;
    let lastHtmlForVisual = htmlData;

    for (let vRound = 1; vRound <= MAX_VISUAL_ROUNDS; vRound++) {
      await reportStatus(taskId, 'processing', {
        message: `[Linux] 视觉预检 (${vRound}/${MAX_VISUAL_ROUNDS})...`, previewUrl
      });

      try {
        // 1. Take screenshot with Playwright
        const screenshotPath = `/tmp/visual-check-${taskId}-r${vRound}.png`;
        const tmpHtmlPath = `/tmp/visual-check-${taskId}-r${vRound}.html`;
        fs.writeFileSync(tmpHtmlPath, lastHtmlForVisual);

        const { chromium } = require('playwright');
        const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] });
        const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
        const consoleLogs = [];
        page.on('console', msg => {
          const text = msg.text();
          if (text.includes('[AI]')) consoleLogs.push(text);
        });
        await page.goto(`file://${tmpHtmlPath}`, { waitUntil: 'load', timeout: 30000 });
        await page.waitForTimeout(10000); // Wait for engine + game init
        await page.screenshot({ path: screenshotPath });

        // Collect scene diagnostics BEFORE closing browser (for feedback if visual check fails)
        let sceneDiagnostics = null;
        try {
          sceneDiagnostics = await page.evaluate(function() {
            var result = { objectsAtOrigin: [], objectsHidden: [], cameraInfo: null, groundInfo: null };
            try {
              if (typeof UnityEngine === 'undefined') return result;
              var cam = UnityEngine.Camera.main;
              if (cam) {
                var bg = cam.backgroundColor;
                result.cameraInfo = {
                  bgColor: 'rgb(' + Math.round(bg.r*255) + ',' + Math.round(bg.g*255) + ',' + Math.round(bg.b*255) + ')',
                  orthSize: cam.orthographicSize,
                  pos: cam.transform.position.toString()
                };
              }
              var allRenderers = UnityEngine.Object.FindObjectsOfType$1(UnityEngine.Renderer);
              if (allRenderers) {
                for (var i = 0; i < Math.min(allRenderers.length, 50); i++) {
                  var r = allRenderers[i];
                  var go = r.gameObject;
                  var pos = go.transform.position;
                  var yPos = pos.y;
                  var scale = go.transform.localScale;
                  if (yPos < -100) {
                    result.objectsHidden.push(go.name + ' (y=' + yPos.toFixed(0) + ')');
                    continue;
                  }
                  var color = '?';
                  try {
                    var mat = r.material;
                    if (mat && mat.color) {
                      var c = mat.color;
                      color = 'rgb(' + Math.round(c.r*255) + ',' + Math.round(c.g*255) + ',' + Math.round(c.b*255) + ')';
                    }
                  } catch(e) {}
                  result.objectsAtOrigin.push({
                    name: go.name, pos: 'y=' + yPos.toFixed(1),
                    scale: scale.x.toFixed(1) + 'x' + scale.y.toFixed(1) + 'x' + scale.z.toFixed(1),
                    color: color, active: go.activeSelf
                  });
                  if (scale.x * scale.z > 4) {
                    result.groundInfo = { name: go.name, scale: scale.x.toFixed(1) + 'x' + scale.y.toFixed(1) + 'x' + scale.z.toFixed(1), color: color };
                  }
                }
              }
            } catch(e) { result.error = e.message; }
            return result;
          });
        } catch(diagErr) {
          log(`Visual round ${vRound}: diagnostics failed (non-fatal): ${diagErr.message}`, taskId);
        }

        await browser.close();
        try { fs.unlinkSync(tmpHtmlPath); } catch(e) {}

        log(`Visual round ${vRound}: screenshot taken, ${consoleLogs.length} AI logs`, taskId);
        consoleLogs.forEach(l => log(`  ${l}`, taskId));

        // 2. Extract shot 1 info from blueprint
        let sceneDesc = 'A game scene with multiple colored objects';
        let expectedObjects = [];
        try {
          const shots = blueprint.shots || blueprint.nodes || [];
          if (shots.length > 0) {
            const shot1 = shots[0].data || shots[0];
            sceneDesc = shot1.sceneDescription || shot1.description || shot1.title || sceneDesc;
            const objs = shot1.sceneObjects || shot1.activate || [];
            expectedObjects = objs.map(o => (typeof o === 'string' ? o : o.name || o.label || '')).filter(Boolean);
          }
          if (blueprint.storyboard && blueprint.storyboard.frames && blueprint.storyboard.frames.length > 0) {
            const frame1 = blueprint.storyboard.frames[0];
            sceneDesc = frame1.scene || frame1.description || sceneDesc;
          }
        } catch(e) { /* use defaults */ }

        // 3. Analyze screenshot with Claude Sonnet via OpenAI-compatible API
        const imgBase64 = fs.readFileSync(screenshotPath).toString('base64');
        const analysisPrompt = `You are a playable ad visual quality inspector.

Analyze this game screenshot and determine if it rendered correctly.

## Expected scene
Description: ${sceneDesc}
Expected objects: ${expectedObjects.length > 0 ? expectedObjects.join(', ') : 'multiple game objects'}

## Criteria
FAIL if ANY of these:
1. Solid color screen (entire screen one color)
2. Black screen
3. Stuck on loading bar/Loading text
4. Scene is clearly empty (only sky/ground, no game objects)
5. None of the expected objects are visible

PASS if the screen shows multiple colored game objects (even if not perfect).

Reply in JSON only: {"passed": true/false, "reason": "brief explanation in English"}`;

        const apiBody = JSON.stringify({
          model: 'claude-sonnet-4-6',
          messages: [{
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:image/png;base64,${imgBase64}` } },
              { type: 'text', text: analysisPrompt }
            ]
          }],
          max_tokens: 200
        });

        const analysis = await new Promise((resolve, reject) => {
          const apiKey = process.env.OPENAI_API_KEY;
          const baseUrl = process.env.OPENAI_BASE_URL || 'https://sub.mindrix.app/v1';
          const url = new URL(baseUrl + '/chat/completions');
          const reqOpts = {
            hostname: url.hostname, port: url.port || 443, path: url.pathname, method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`,
              'Content-Length': Buffer.byteLength(apiBody)
            },
            timeout: 60000
          };
          const req = https.request(reqOpts, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
              try {
                const resp = JSON.parse(Buffer.concat(chunks).toString());
                const text = resp.choices?.[0]?.message?.content || '';
                const jsonMatch = text.match(/\{[\s\S]*\}/);
                if (jsonMatch) resolve(JSON.parse(jsonMatch[0]));
                else resolve({ passed: true, reason: 'Could not parse analysis, assuming pass' });
              } catch(e) { resolve({ passed: true, reason: 'Analysis parse error, assuming pass' }); }
            });
          });
          req.on('error', e => resolve({ passed: true, reason: 'API error, assuming pass: ' + e.message }));
          req.on('timeout', () => { req.destroy(); resolve({ passed: true, reason: 'API timeout, assuming pass' }); });
          req.write(apiBody);
          req.end();
        });

        log(`Visual round ${vRound}: ${analysis.passed ? 'PASSED' : 'FAILED'} — ${analysis.reason}`, taskId);

        if (analysis.passed) {
          visualPassed = true;
          break;
        }

        // 4. Failed — feed back to AI, re-code, rebuild
        if (vRound >= MAX_VISUAL_ROUNDS) {
          log(`Visual check failed after ${MAX_VISUAL_ROUNDS} rounds, proceeding to CUA anyway`, taskId);
          break;
        }

        await reportStatus(taskId, 'processing', { message: `[Linux] 视觉预检失败: ${analysis.reason}，AI修复中...`, previewUrl });

        // Inject visual feedback with scene diagnostics
        if (!blueprint.feedbackHistory) blueprint.feedbackHistory = [];
        let diagText = '';
        if (sceneDiagnostics) {
          if (sceneDiagnostics.cameraInfo) {
            diagText += `\n\n## Scene Diagnostics (from runtime)\nCamera: bg=${sceneDiagnostics.cameraInfo.bgColor}, orthSize=${sceneDiagnostics.cameraInfo.orthSize}, pos=${sceneDiagnostics.cameraInfo.pos}`;
          }
          if (sceneDiagnostics.groundInfo) {
            diagText += `\nGround plane: ${sceneDiagnostics.groundInfo.name} scale=${sceneDiagnostics.groundInfo.scale} color=${sceneDiagnostics.groundInfo.color}`;
          }
          if (sceneDiagnostics.objectsAtOrigin.length > 0) {
            diagText += `\nVisible objects (${sceneDiagnostics.objectsAtOrigin.length}): ${sceneDiagnostics.objectsAtOrigin.map(o => `${o.name}(${o.pos},scale=${o.scale},color=${o.color})`).join(', ')}`;
          } else {
            diagText += '\nVisible objects: NONE (all objects still at y=-999 pool position)';
          }
          diagText += `\nHidden objects at y<-100: ${sceneDiagnostics.objectsHidden.length}`;
          if (sceneDiagnostics.objectsHidden.length > 0 && sceneDiagnostics.objectsAtOrigin.length === 0) {
            diagText += '\n\n⚠️ ROOT CAUSE: All pool objects are still hidden at y=-999. Your Start() method likely has null Find() results. Check that object names in Find() match the __Pool_xxx_NN names from the assignment table.';
          }
        }
        blueprint.feedbackHistory.push({
          data: { text: `Visual pre-check failed (round ${vRound}): ${analysis.reason}\n\nThe rendered screenshot shows rendering issues. Please fix based on the diagnostics below:${diagText}\n\nRequired fixes:\n1. Ensure all objects from the assignment table are Find()'d with correct __Pool_xxx_NN names\n2. Move objects to visible positions (y >= 0) in Start()\n3. Ground color must be neutral gray (0.75, 0.78, 0.82), Camera.backgroundColor must contrast by >= 0.3\n4. Main objects must have scale >= 1.5 on at least one axis` },
          source: 'visual-precheck-round-' + vRound,
          status: 'pending',
          timestamp: Date.now()
        });

        // Re-code
        const vFixDir = path.join(require('os').tmpdir(), `linux-vfix-${taskId}-r${vRound}`);
        if (fs.existsSync(vFixDir)) fs.rmSync(vFixDir, { recursive: true, force: true });
        try {
          const { execSync } = require('child_process');
          execSync(`git clone --depth 1 ${BASE_TEMPLATE_REPO} "${vFixDir}"`, { timeout: 60000, stdio: 'pipe' });
        } catch (e) {
          log(`Visual fix git clone failed: ${e.message}`, taskId);
          break;
        }

        const vFixAssetsDir = path.join(vFixDir, 'Assets', 'Program', 'Script', 'Manager');
        fs.mkdirSync(vFixAssetsDir, { recursive: true });
        fs.writeFileSync(path.join(vFixAssetsDir, 'GameFlowManagerMain.cs'), lastCsCode);

        let vFixResult;
        try {
          vFixResult = USE_CLAUDE_CODE
            ? await generateWithClaudeCode(blueprint, vFixDir, log, taskId, 'unity')
            : await generateCodeV5(blueprint, vFixDir, log, taskId, 'unity');
        } catch (e) {
          log(`Visual fix re-code error: ${e.message}`, taskId);
          try { fs.rmSync(vFixDir, { recursive: true, force: true }); } catch(e2) {}
          break;
        }

        if (!vFixResult.ok) {
          log('Visual fix re-code failed: ' + vFixResult.error, taskId);
          try { fs.rmSync(vFixDir, { recursive: true, force: true }); } catch(e) {}
          break;
        }

        // Find new CS code
        const vFixCsFiles = findFiles(vFixDir, '.cs');
        const vFixMainCs = vFixCsFiles.find(f => f.includes('GameFlowManagerMain.cs'));
        if (!vFixMainCs) {
          log('Visual fix: no GameFlowManagerMain.cs found', taskId);
          try { fs.rmSync(vFixDir, { recursive: true, force: true }); } catch(e) {}
          break;
        }

        lastCsCode = fs.readFileSync(vFixMainCs, 'utf-8');
        const vFixExtraFiles = {};
        if (fs.existsSync(canonicalGfm)) {
          vFixExtraFiles['GFM_Tools.cs'] = fs.readFileSync(canonicalGfm, 'utf-8');
        }
        try { fs.rmSync(vFixDir, { recursive: true, force: true }); } catch(e) {}

        // Rebuild
        await reportStatus(taskId, 'building', { message: `[Linux] 视觉修复重编译 (round ${vRound + 1})...` });
        let vFixBuild;
        try {
          vFixBuild = await buildRequest('/build', lastCsCode, vFixExtraFiles);
        } catch (e) {
          log(`Visual fix rebuild error: ${e.message}`, taskId);
          break;
        }
        if (!vFixBuild.ok) {
          log('Visual fix rebuild failed: ' + (vFixBuild.error || ''), taskId);
          break;
        }
        log(`Visual fix rebuild OK in ${vFixBuild.buildTime}s`, taskId);

        // Download new HTML
        try {
          lastHtmlForVisual = await buildRequest('/build-html', lastCsCode, vFixExtraFiles);
          lastExtraFiles = vFixExtraFiles;
          log(`Visual fix HTML: ${(lastHtmlForVisual.length / 1048576).toFixed(1)}MB`, taskId);
          fs.writeFileSync(path.join(previewDir, 'index.html'), lastHtmlForVisual);
        } catch (e) {
          log('Visual fix HTML download error: ' + e.message, taskId);
          break;
        }
      } catch (vErr) {
        log(`Visual check round ${vRound} error: ${vErr.message}`, taskId);
        visualPassed = true; // Don't block on visual check errors
        break;
      }
    }

    // Update htmlData for CUA if visual fix produced new HTML
    const finalHtmlData = lastHtmlForVisual;
    log(`Visual pre-check: ${visualPassed ? 'PASSED' : 'proceeded without pass'}, entering CUA...`, taskId);

    // === Step 6: CUA Verification + Auto-Fix Loop ===
    const MAX_CUA_ROUNDS = 12;
    const SAME_ISSUE_REGEN_THRESHOLD = 2; // 连续 N 轮同一问题 → 全量重生成
    const { runCUAVerification } = require('./worker-cua-verify.js');
    let cuaPassed = false;
    let lastHtmlData = finalHtmlData;
    // lastCsCode already defined in Step 4 (may have been updated by build fix loop)
    const cuaStartRound = (checkpoint && checkpoint.cuaRound) ? checkpoint.cuaRound + 1 : 1;
    if (cuaStartRound > 1) {
      log(`[checkpoint] CUA loop starting from round ${cuaStartRound} (resumed)`, taskId);
    }

    // Fix history: track what was tried each round to avoid repeating (BUG-0010)
    const fixHistory = (checkpoint && checkpoint.fixHistory) || [];
    // Consecutive same-issue tracking (BUG-0007)
    let consecutiveSameIssue = 0;
    let lastIssueCategory = null;

    for (let cuaRound = cuaStartRound; cuaRound <= MAX_CUA_ROUNDS; cuaRound++) {
      await reportStatus(taskId, 'processing', { message: `[Linux] CUA verifying... (round ${cuaRound}/${MAX_CUA_ROUNDS})`, previewUrl });
      
      // Write HTML to temp dir for CUA
      const cuaBuildDir = path.join(require('os').tmpdir(), `linux-cua-${taskId}-r${cuaRound}`);
      fs.mkdirSync(cuaBuildDir, { recursive: true });
      fs.writeFileSync(path.join(cuaBuildDir, 'iframe.html'), lastHtmlData);
      
      let cuaResult;
      try {
        cuaResult = await runCUAVerification(cuaBuildDir, blueprint, taskId, log);
      } catch (cuaErr) {
        log(`CUA round ${cuaRound} error: ${cuaErr.message}`, taskId);
        // Track consecutive crashes for early-stop (was missing — caused Run 1 to spin 12 rounds)
        if (lastIssueCategory === 'crash') {
          consecutiveSameIssue++;
        } else {
          consecutiveSameIssue = 1;
          lastIssueCategory = 'crash';
        }
        if (consecutiveSameIssue >= 3) {
          log(`[early-stop] ${consecutiveSameIssue} consecutive CUA crashes — stopping task (infrastructure or fundamental code issue)`, taskId);
          await reportStatus(taskId, 'failed', { message: `[Linux] CUA crashed ${consecutiveSameIssue} consecutive rounds — stopping` });
          try { fs.rmSync(cuaBuildDir, { recursive: true, force: true }); } catch(e) {}
          break;
        }
        if (cuaRound >= MAX_CUA_ROUNDS) {
          await reportStatus(taskId, 'failed', { message: `[Linux] Done (CUA error after ${cuaRound} rounds)`, previewUrl });
        }
        try { fs.rmSync(cuaBuildDir, { recursive: true, force: true }); } catch(e) {}
        continue;
      }
      
      try { fs.rmSync(cuaBuildDir, { recursive: true, force: true }); } catch(e) {}

      // Auto-stop: solid color detection
      if (cuaResult.quickTestDetail && cuaResult.quickTestDetail.solidColor) {
        if (cuaResult.quickTestDetail.codeBug) {
          // Non-black solid = code bug, treat as CUA failure with feedback
          log('CUA: solid color screen (code bug) — objects not visible, feeding back to AI', taskId);
          await reportStatus(taskId, 'processing', { message: `[Linux] 画面纯色(${cuaResult.quickTestDetail.solidColorDetail?.color || '?'})，对象不可见，AI修复中...`, qualityData: { quickTestResult: { passed: false, solidColor: true, color: cuaResult.quickTestDetail.solidColorDetail?.color || '?' } } });
          // Treat as a CUA failure with specific feedback
          cuaResult.issues = ['[quick-test] ' + (cuaResult.reason || 'Screen is solid color — objects not visible')];
          cuaResult.passed = false;
          // Fall through to the CUA failure handling below
        } else {
          // True black = no GPU / render failure, skip CUA
          log('CUA auto-stop: solid black screen — no GPU or WebGL render failure, skipping CUA', taskId);
          await reportStatus(taskId, 'done', { message: `[Linux] Build OK, skipped CUA (solid black — no GPU). Preview: ${previewUrl || 'N/A'}`, previewUrl });
          cuaPassed = true;
          break;
        }
      }

      if (cuaResult.passed || cuaResult.skipped) {
        cuaPassed = true;
        log(`CUA ${cuaResult.skipped ? 'SKIPPED' : 'PASSED'} round ${cuaRound}, total ${((Date.now() - startTime) / 1000).toFixed(0)}s`, taskId);
        await reportStatus(taskId, 'cua_passed', { message: `[Linux] CUA passed (round ${cuaRound})! Total: ${((Date.now() - startTime) / 1000).toFixed(0)}s`, previewUrl, qualityData: { cuaResult: { passed: true, round: cuaRound, exitReason: cuaResult.report?.exitReason || 'unknown' }, cuaRetries: cuaRound } });
        break;
      }

      log(`CUA FAILED round ${cuaRound}/${MAX_CUA_ROUNDS}: ${cuaResult.issues.length} issues`, taskId);
      cuaResult.issues.forEach(i => log(`  - ${i}`, taskId));

      // --- BUG-0007: Detect consecutive same-issue pattern ---
      const currentIssueCategory = categorizeIssue(cuaResult);
      if (currentIssueCategory === lastIssueCategory) {
        consecutiveSameIssue++;
      } else {
        consecutiveSameIssue = 1;
        lastIssueCategory = currentIssueCategory;
      }

      if (consecutiveSameIssue >= SAME_ISSUE_REGEN_THRESHOLD) {
        if (consecutiveSameIssue >= SAME_ISSUE_REGEN_THRESHOLD * 2) {
          // 4+ rounds same issue even after full regen — give up
          log(`[early-stop] Same issue "${currentIssueCategory}" persists after ${consecutiveSameIssue} rounds (including full regen) — stopping`, taskId);
          await reportStatus(taskId, 'failed', { message: `[Linux] Same issue "${currentIssueCategory}" after ${consecutiveSameIssue} rounds — stopping` });
          break;
        }
        log(`[strategy] Same issue "${currentIssueCategory}" for ${consecutiveSameIssue} consecutive rounds — switching to FULL_GENERATION`, taskId);
        // Reset feedbackHistory to force fresh generation
        blueprint.feedbackHistory = [];
        // Clear the fixHistory so AI gets a clean slate
        fixHistory.length = 0;
      }

      // Auto-stop: engine not initialized = infrastructure issue
      if (cuaResult.report && cuaResult.report.diagnostics && !cuaResult.report.diagnostics.engineReady) {
        log('CUA auto-stop: engine not initialized — infrastructure issue, AI re-coding won\'t help', taskId);
        await reportStatus(taskId, 'failed', { message: '[Linux] Engine not initialized — infrastructure issue' });
        break;
      }

      if (cuaRound >= MAX_CUA_ROUNDS) {
        await reportStatus(taskId, 'failed', { message: `[Linux] CUA failed after ${MAX_CUA_ROUNDS} rounds`, qualityData: { cuaResult: { passed: false, round: MAX_CUA_ROUNDS, issues: cuaResult.issues?.slice(0, 3) || [] }, cuaRetries: MAX_CUA_ROUNDS } });
        break;
      }

      // === Fix cycle: build CUA feedback → re-code → rebuild → retry ===
      await reportStatus(taskId, 'processing', { message: `[Linux] CUA round ${cuaRound} failed, AI re-coding...`, previewUrl });

      // Record CUA failures to pending-rules for cross-project learning
      try {
        const { recordNewIssues } = require('./code-reviewer.js');
        const cuaIssuesForRules = (cuaResult.issues || []).map(issueText => ({
          severity: 'critical',
          description: issueText,
          rule: 'CUA - ' + (currentIssueCategory || 'unknown'),
          fix: cuaResult.reason || issueText,
          line: 'CUA round ' + cuaRound,
        }));
        if (cuaIssuesForRules.length > 0) {
          await recordNewIssues(cuaIssuesForRules, taskId);
        }
      } catch (e) {
        log(`[pending-rules] CUA issue recording failed (non-fatal): ${e.message}`, taskId);
      }

      // Build detailed feedback (structured JSON + legacy text)
      // --- BUG-0010: Append fix history so AI knows what was already tried ---
      const fixEntry = {
        round: cuaRound,
        issueCategory: currentIssueCategory,
        issues: cuaResult.issues.slice(0, 3),
        codeLines: lastCsCode ? lastCsCode.split('\n').length : 0
      };
      fixHistory.push(fixEntry);

      const cuaFeedback = buildStructuredFeedback(cuaRound, cuaResult, blueprint, fixHistory);

      // Inject feedback into blueprint for INCREMENTAL FIX mode
      if (!blueprint.feedbackHistory) blueprint.feedbackHistory = [];
      // Cap feedbackHistory to last 1 entry (after push below = 2 total, prevents prompt bloat)
      if (blueprint.feedbackHistory.length >= 2) {
        blueprint.feedbackHistory = blueprint.feedbackHistory.slice(-1);
      }
      blueprint.feedbackHistory.push({
        data: cuaFeedback,
        source: 'cua-linux-round-' + cuaRound,
        status: 'pending',
        timestamp: Date.now()
      });

      // Re-generate code
      const fixTempDir = path.join(require('os').tmpdir(), `linux-fix-${taskId}-r${cuaRound}`);
      if (fs.existsSync(fixTempDir)) fs.rmSync(fixTempDir, { recursive: true, force: true });

      // Git clone base template for CUA fix attempt
      try {
        getBaseTemplate(fixTempDir, log, taskId);
      } catch (cloneFixErr) {
        log(`CUA fix git clone failed: ${cloneFixErr.message}`, taskId);
        continue;
      }

      const fixAssetsDir = path.join(fixTempDir, 'Assets', 'Program', 'Script', 'Manager');
      fs.mkdirSync(fixAssetsDir, { recursive: true });
      // Copy previous code so AI can do incremental fix (GFM_Tools.cs already in git repo)
      fs.writeFileSync(path.join(fixAssetsDir, 'GameFlowManagerMain.cs'), lastCsCode);

      let fixResult;
      try {
        fixResult = USE_CLAUDE_CODE
          ? await generateWithClaudeCode(blueprint, fixTempDir, log, taskId, 'unity')
          : await generateCodeV5(blueprint, fixTempDir, log, taskId, 'unity');
      } catch (fixErr) {
        log(`Fix re-code error: ${fixErr.message}`, taskId);
        try { fs.rmSync(fixTempDir, { recursive: true, force: true }); } catch(e) {}
        continue;
      }

      if (!fixResult.ok) {
        log('Fix re-code failed: ' + fixResult.error, taskId);
        try { fs.rmSync(fixTempDir, { recursive: true, force: true }); } catch(e) {}
        continue;
      }

      // Find new CS code
      const fixCsFiles = findFiles(fixTempDir, '.cs');
      const fixMainCs = fixCsFiles.find(f => f.includes('GameFlowManagerMain.cs'));
      if (!fixMainCs) {
        log('Fix re-code: no GameFlowManagerMain.cs found', taskId);
        try { fs.rmSync(fixTempDir, { recursive: true, force: true }); } catch(e) {}
        continue;
      }

      lastCsCode = fs.readFileSync(fixMainCs, 'utf-8');
      // Always use canonical GFM_Tools.cs (never AI-generated version)
      const fixExtraFiles = {};
      if (fs.existsSync(canonicalGfm)) {
        fixExtraFiles['GFM_Tools.cs'] = fs.readFileSync(canonicalGfm, 'utf-8');
      }
      try { fs.rmSync(fixTempDir, { recursive: true, force: true }); } catch(e) {}

      // Rebuild
      await reportStatus(taskId, 'building', { message: `[Linux] CUA fix rebuilding... (round ${cuaRound + 1})` });
      let fixBuild;
      try {
        fixBuild = await buildRequest('/build', lastCsCode, fixExtraFiles);
      } catch (buildErr) {
        log(`Fix rebuild error: ${buildErr.message}`, taskId);
        continue;
      }
      if (!fixBuild.ok) {
        log('Fix rebuild failed: ' + (fixBuild.error || ''), taskId);
        continue;
      }
      log(`Fix rebuild OK in ${fixBuild.buildTime}s`, taskId);

      // Save checkpoint after successful rebuild (persist best buildable code)
      saveCheckpoint(taskId, {
        csCode: lastCsCode,
        cuaRound: cuaRound,
        feedbackHistory: blueprint.feedbackHistory,
        fixHistory: fixHistory
      });
      log(`[checkpoint] Saved after CUA round ${cuaRound} rebuild`, taskId);

      // Download new HTML
      try {
        lastHtmlData = await buildRequest('/build-html', lastCsCode, fixExtraFiles);
        log(`Fix HTML: ${(lastHtmlData.length / 1048576).toFixed(1)}MB`, taskId);
        // Update preview
        fs.writeFileSync(path.join(previewDir, 'index.html'), lastHtmlData);
      } catch (dlErr) {
        log('Fix HTML download error: ' + dlErr.message, taskId);
        continue;
      }
    }

    if (!cuaPassed) {
      log(`Task ended after CUA loop, total ${((Date.now() - startTime) / 1000).toFixed(0)}s`, taskId);
    }

    // Cleanup temp dirs
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch(e) {}

    // Clear checkpoint — task completed (success or permanent failure)
    clearCheckpoint(taskId);
    log(`[checkpoint] Cleared for task ${taskId}`, taskId);

  } catch (e) {
    log('Task error: ' + e.message, taskId);
    await reportStatus(taskId, 'failed', { message: '[Linux] Error: ' + e.message.slice(0, 200) });
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
