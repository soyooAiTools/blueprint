// Worker Client v5 �?Poll from Blueprint Editor API, build via Luna jake pipeline
// Flow: Poll task �?Git clone/reset base template �?Pre-build patch �?Luna build �?converter-v3 �?Upload �?CUA
// Also handles: fix_needed (re-build), commit_needed (cleanup)

// Load .env config
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const http = require('http');
const https = require('https');
const { exec, execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { detectScenes, fixLunaJson, generateExportAssets, injectMaterialSourceAll, cleanScene } = require('./worker-patch.js');
const { runBridgeBuild, bridgeRequest } = require('./worker-bridge-build.js');
const { generateCode, generateCodeV5 } = require('./worker-coder.js');

// V5 base template mode - set to true to enable
const USE_BASE_TEMPLATE = process.env.USE_BASE_TEMPLATE === 'true' || true;

// Linux build mode - uses remote Linux ECS for C#→JS→HTML (faster, no Unity needed)
const USE_LINUX_BUILD = process.env.USE_LINUX_BUILD === 'true';
const LINUX_BUILD_URL = process.env.LINUX_BUILD_URL || 'http://100.84.246.49:18860';

// Smart code generator: V5 (base template) or legacy
function smartGenerateCode(blueprint, clientDir, log, taskId, engine) {
  if (engine === 'unity' && USE_BASE_TEMPLATE && blueprint.entities && blueprint.entities.length > 0) {
    log('[smart] Using V5 BASE TEMPLATE mode', taskId);
    return generateCodeV5(blueprint, clientDir, log, taskId, engine);
  }
  log('[smart] Using legacy generateCode mode', taskId);
  return generateCode(blueprint, clientDir, log, taskId, engine);
}
// === Linux Build Function ===
async function runLinuxBuild(csCode, extraFiles, log, taskId) {
  log('[linux-build] Calling Linux Build API...', taskId);
  const startTime = Date.now();
  const body = JSON.stringify({ csCode, extraFiles: extraFiles || {}, taskId });
  
  return new Promise((resolve) => {
    const url = new URL(LINUX_BUILD_URL + '/build');
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 120000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.ok) {
            const html = Buffer.from(result.htmlBase64, 'base64').toString('utf8');
            const buildTime = ((Date.now() - startTime) / 1000).toFixed(1);
            log(`[linux-build] �?Success: ${(html.length/1024).toFixed(0)} KB in ${buildTime}s`, taskId);
            resolve({ ok: true, html, buildTime, htmlSize: html.length });
          } else {
            log(`[linux-build] �?Failed: ${result.error}`, taskId);
            resolve({ ok: false, error: result.error, buildLog: result.buildLog });
          }
        } catch(e) {
          resolve({ ok: false, error: 'Invalid response from Linux build API: ' + e.message });
        }
      });
    });
    req.on('error', e => resolve({ ok: false, error: 'Linux build API error: ' + e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Linux build API timeout (120s)' }); });
    req.write(body);
    req.end();
  });
}

// === Unified Build Helper (Windows or Linux) ===
async function doBuild(clientDir, log, taskId) {
  if (USE_LINUX_BUILD) {
    const csPath = path.join(clientDir, 'Assets', 'Program', 'Script', 'Manager', 'GameFlowManagerMain.cs');
    const gfmPath = path.join(__dirname, 'GFM_Tools.cs');
    if (!fs.existsSync(csPath)) return { ok: false, error: 'GameFlowManagerMain.cs not found' };
    const csCode = fs.readFileSync(csPath, 'utf8');
    const extraFiles = {};
    if (fs.existsSync(gfmPath)) extraFiles['GFM_Tools.cs'] = fs.readFileSync(gfmPath, 'utf8');
    const result = await runLinuxBuild(csCode, extraFiles, log, taskId);
    if (result.ok) {
      // Write HTML to multiple locations for downstream compatibility
      const htmlOutputDir = path.join(WORK_DIR, taskId + '-html');
      fs.mkdirSync(htmlOutputDir, { recursive: true });
      fs.writeFileSync(path.join(htmlOutputDir, taskId + '.html'), result.html);
      fs.writeFileSync(path.join(htmlOutputDir, 'index.html'), result.html);
      
      // Also write to stage4/develop so CUA, preview-check, upload all work unchanged
      const stage4Dir = path.join(clientDir, 'LunaTemp', 'stage4', 'develop');
      fs.mkdirSync(stage4Dir, { recursive: true });
      fs.writeFileSync(path.join(stage4Dir, 'iframe.html'), result.html);
      fs.writeFileSync(path.join(stage4Dir, 'index.html'), result.html);
      log(`[linux-build] HTML written to stage4/develop for CUA compatibility`, taskId);
    }
    return result;
  } else {
    return await runBridgeBuild(clientDir, log, taskId);
  }
}

// converter-v3: stage4→single HTML (replaces old worker-html-converter.js)
const { convertV3 } = require('./converter-v3-wrapper.cjs');
const { patchLunaBuild } = require('./worker-luna-patch.js');

// Cocos modules (optional ?loaded dynamically to avoid crash if not present)
let cocosPatch, cocosBuild, cocosHtmlConverter;
try {
  cocosPatch = require('../worker-cocos/worker-patch.js');
  cocosBuild = require('../worker-cocos/worker-cocos-build.js');
  cocosHtmlConverter = require('../worker-cocos/worker-html-converter.js');
} catch (e) {
  // Cocos modules not available ?cocos tasks will fail gracefully
}

// ============ Config ============
const WORKER_ID = process.env.WORKER_ID || 'workerA';
const BASE_URL = process.env.BASE_URL || 'https://playcools.top/blueprint';
const POLL_INTERVAL = 8000;       // 8s between polls
const HEARTBEAT_INTERVAL = 30000; // 30s heartbeat
const WORK_DIR = process.env.WORK_DIR || '/tmp/work';
const FIXED_PROJECT_DIR = path.join(WORK_DIR, 'test-luna'); // Git base template root
// luna-base-template repo IS the Unity project (Assets/Packages/ProjectSettings at root)
// No 'Client' subdirectory �?the repo root is the Client dir
const CLIENT_DIR = FIXED_PROJECT_DIR;
const COCOS_PROJECT_DIR = process.env.COCOS_PROJECT_DIR || path.join(WORK_DIR, 'test-cocos'); // Fixed SVN working copy (Cocos)
const SVN_USER = 'openclaw';
const SVN_PASS = 'openclaw';
const SVN_FLAGS = `--non-interactive --no-auth-cache --username ${SVN_USER} --password ${SVN_PASS}`;
// GitHub base template repo
const BASE_TEMPLATE_REPO = 'https://github.com/soyooAiTools/luna-base-template.git';
const BASE_TEMPLATE_BRANCH = 'main';
const MAX_CONCURRENT = 1; // Only 1 task at a time (Unity can only open 1 project)
const LUNA_DIR = 'D:\\Luna';

// ============ Task Notification Webhook ============
const NOTIFY_URL = process.env.NOTIFY_URL || 'https://playcools.top/notify/webhook';
// Feishu DM notifications via feishu-notify.js (App Bot API, no webhook needed)
const taskDebugBy = new Map(); // Track debugBy flag per task (set when task JSON has debugBy field)

function notifyEvent(taskId, event, message, extra) {
  // Check if task has debugBy flag (set by XiaoBai when actively debugging)
  const debugBy = (extra && extra.debugBy) || taskDebugBy.get(taskId);
  try {
    const data = JSON.stringify({
      taskId, event, message,
      projectName: (extra && extra.projectName) || taskId,
      status: (extra && extra.status) || event,
      details: (extra && extra.details) || null
    });
    // Send to playcools notify endpoint
    const url = new URL(NOTIFY_URL);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: url.pathname,
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 5000, rejectUnauthorized: false
    }, () => {});
    req.on('error', () => {});
    req.write(data);
    req.end();
  } catch(e) {}

  // Send to Feishu DM via App Bot API
  const feishuNotify = require('./feishu-notify.js');
  const feishuExtra = debugBy ? Object.assign({}, extra || {}, { debugBy }) : extra;
  feishuNotify.send(taskId, event, message, feishuExtra).catch(() => {});
}

// ============ Resilience Config ============
const MAX_TASK_RETRIES = 3;
const RETRY_DELAYS = [30, 60, 120];
const MAX_CUA_ROUNDS = 20; // Keep trying until pass. Nick: "keep trying until pass"
const TASK_TIMEOUT_MS = 45 * 60 * 1000;
const TRANSIENT_RETRIES = 3;
const taskRetryCount = new Map();

class TaskFailedError extends Error {
  constructor(message, noRetry = false) {
    super(message);
    this.name = 'TaskFailedError';
    this.noRetry = noRetry;
  }
}

async function withRetry(fn, retries, label, taskId, delayMs) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (e.noRetry) throw e;
      if (i < retries) {
        const wait = delayMs || (1000 * Math.pow(2, i));
        log(`[retry] ${label} failed (${i + 1}/${retries + 1}): ${e.message}, retrying in ${wait}ms...`, taskId);
        notifyEvent(taskId, 'retry', `${label}  failed, auto-retry (${i + 1}/${retries})`,
          { projectName: getProjectName(taskId), status: 'retrying' });
        await new Promise(r => setTimeout(r, wait));
      } else {
        throw e;
      }
    }
  }
}

function getProjectName(taskId) {
  const info = activeTasks.get(taskId);
  return (info && info.projectName) || taskId;
}

// ============ State ============
const activeTasks = new Map();
const startTime = Date.now();
let pollLock = false;

function log(msg, taskId) {
  const prefix = taskId ? `[${taskId.slice(-8)}]` : '[MAIN]';
  console.log(`[${new Date().toISOString()}] ${prefix} ${msg}`);
}

// ============ HTTP helpers ============
function apiRequest(method, urlPath, body, isBinary, extraHeaders) {
  return new Promise((resolve, reject) => {
    const fullUrl = new URL(BASE_URL + urlPath);
    const isHttps = fullUrl.protocol === 'https:';
    const lib = isHttps ? https : http;
    const opts = {
      hostname: fullUrl.hostname,
      port: fullUrl.port || (isHttps ? 443 : 80),
      path: fullUrl.pathname + fullUrl.search,
      method,
      headers: {},
      rejectUnauthorized: false,
      timeout: 120000
    };
    if (body && !isBinary) {
      const jsonStr = JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(jsonStr);
    }
    if (isBinary) {
      opts.headers['Content-Type'] = 'application/zip';
      opts.headers['Content-Length'] = body.length;
    }
    if (extraHeaders) Object.assign(opts.headers, extraHeaders);
    if (body && !opts.headers['Content-Length']) opts.headers['Content-Length'] = Buffer.byteLength(body);
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode === 204) return resolve(null);
        const data = Buffer.concat(chunks).toString('utf-8');
        try { resolve(JSON.parse(data)); } catch (e) { resolve(data); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    if (body) {
      if (isBinary) req.write(body);
      else req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// [REMOVED] Screenshot review on Main ECS ?replaced by CUA verification on Worker (Step 5.5b)

async function reportStatus(taskId, status, extra) {
  const payload = { workerId: WORKER_ID, taskId, status };
  if (extra) Object.assign(payload, extra);
  try {
    await apiRequest('POST', '/api/worker/status', payload);
    log(`Status ?${status}${extra && extra.message ? ': ' + extra.message : ''}`, taskId);
  } catch (e) {
    log(`Status report failed: ${e.message}`, taskId);
  }
}

function runCmd(cmd, cwd, timeoutMs = 300000) {
  try {
    const out = execSync(cmd, { cwd, timeout: timeoutMs, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { ok: true, output: out.trim() };
  } catch (e) {
    return { ok: false, output: ((e.stdout || '') + '\n' + (e.stderr || '')).trim(), error: e.message };
  }
}

// ============ Task Processing ============

async function processTask(task) {
  const taskId = task.taskId;
  const engine = task.engine || 'unity';

  // Restore original status if server used atomic assign
  if (task.originalStatus) {
    task.status = task.originalStatus;
    delete task.originalStatus;
  }

  if (task.status === 'commit_needed') {
    return await handleCommit(task);
  }

  if (engine === 'cocos') {
    return await processTaskCocos(task);
  }

  // ============ Unity (Luna) flow ============
  try {
    // === CUA Resume Check ===
    // If previous run failed at CUA stage and build artifacts still exist,
    // skip coding+build and jump directly to CUA verification
    const cuaStage4Path = path.join(CLIENT_DIR, 'LunaTemp', 'stage4', 'develop');
    const cuaResultsDir = path.join(__dirname, 'cua-results');
    const cuaLogPath = path.join(cuaResultsDir, taskId + '-cua.log');
    const hasCuaLog = fs.existsSync(cuaLogPath);
    const hasBuildArtifacts = fs.existsSync(path.join(cuaStage4Path, 'iframe.html')) || 
      fs.existsSync(path.join(cuaStage4Path, 'index.html'));
    // Resume if: previous CUA log exists (meaning CUA was attempted) AND build artifacts still on disk
    const isCuaRetry = hasCuaLog && hasBuildArtifacts;

    if (isCuaRetry) {
      log('CUA resume: previous build artifacts exist, checking last CUA result...', taskId);

      // Check if previous CUA already PASSED (upload failed, not CUA failed)
      const cuaReportPath = path.join(cuaResultsDir, taskId + '-report.json');
      let prevCuaPassed = false;
      try {
        if (fs.existsSync(cuaReportPath)) {
          const prevReport = JSON.parse(fs.readFileSync(cuaReportPath, 'utf-8'));
          // Check the CUA verify result: exitReason=max_rounds with no uncovered shots = passed
          // Or check if worker logged "PASSED" in the log
          if (prevReport.exitReason !== 'stuck') {
            // Also check log for PASSED marker
            const logContent = fs.readFileSync(cuaLogPath, 'utf-8');
            if (logContent.includes('Pass: true') || logContent.includes('PASSED')) {
              prevCuaPassed = true;
            }
          }
        }
      } catch(e) {}

      if (prevCuaPassed) {
        // CUA already passed last time, just retry upload
        log('CUA resume: previous CUA PASSED, skipping directly to upload', taskId);
        await reportStatus(taskId, 'processing', { message: 'Uploading build (CUA passed, retry upload)...' });
        const uploaded = await uploadBuild(taskId);
        if (!uploaded) {
          await reportStatus(taskId, 'failed', { message: 'Build upload failed (retry)' });
          throw new TaskFailedError('Build upload failed (retry)');
        }
        await reportStatus(taskId, 'completed', { message: 'CUA passed, build uploaded' });
        log('CUA resume: upload retry succeeded', taskId);
        throw new TaskFailedError('Task failed');
      }

      log('CUA resume: previous CUA did not pass, re-running CUA verification', taskId);
      await reportStatus(taskId, 'processing', { message: 'CUA resume (skip coding+build)...' });

      // Apply Luna runtime patches before CUA
      try {
        patchLunaBuild(cuaStage4Path, log, taskId);
      } catch(e) {
        log('CUA resume: Luna patch error (non-fatal): ' + e.message, taskId);
      }

      // Jump directly to CUA verification loop
      let cuaPassed = false;
      let cuaBlueprint = null;
      try { cuaBlueprint = await apiRequest('GET', `/api/tasks/${taskId}/blueprint`); } catch(e) {}

      let prevIssueSignature = '';
      let sameIssueCount = 0;
      for (let cuaRound = 1; cuaRound <= MAX_CUA_ROUNDS; cuaRound++) {
        try {
          const { runCUAVerification } = require('./worker-playableagent.js');
          await reportStatus(taskId, 'processing', { 
            message: `CUA resume - PlayableAgent verifying... (round ${cuaRound}/${MAX_CUA_ROUNDS})` 
          });

          const cuaResult = await runCUAVerification(cuaStage4Path, cuaBlueprint, taskId, log);

          if (cuaResult.skipped) {
            log(`CUA resume: verification skipped (round ${cuaRound})`, taskId);
            cuaPassed = true;
            break;
          }

          if (cuaResult.passed) {
            log(`CUA resume: verification PASSED (round ${cuaRound})`, taskId);
            cuaPassed = true;
            break;
          }

          log(`CUA verification FAILED round ${cuaRound}/${MAX_CUA_ROUNDS}, ${cuaResult.issues.length} issues`, taskId);
          cuaResult.issues.forEach(issue => log(`  - ${issue}`, taskId));

          // Auto-stop: same issues repeated 3+ rounds
          const issueSignature = cuaResult.issues.map(i => i.replace(/\d+/g, 'N')).sort().join('|');
          if (issueSignature === prevIssueSignature) {
            sameIssueCount++;
          } else {
            sameIssueCount = 1;
            prevIssueSignature = issueSignature;
          }
          if (sameIssueCount >= 3) {
            log(`CUA auto-stop: same issues repeated ${sameIssueCount} rounds, stopping to avoid waste`, taskId);
            await reportStatus(taskId, 'failed', { 
              message: 'CUA auto-stopped: same issues repeated ' + sameIssueCount + ' rounds. Issues: ' + cuaResult.issues.slice(0, 2).join('; ').slice(0, 200)
            });
            throw new TaskFailedError('CUA auto-stopped: repeated issues after ' + cuaRound + ' rounds');
          }

          // Auto-stop: engine not initialized = infrastructure issue, not code issue
          if (cuaResult.issues.some(i => i.includes('[engine-not-ready]'))) {
            log('CUA auto-stop: engine not initialized �?infrastructure issue, AI re-coding won\'t help', taskId);
            await reportStatus(taskId, 'failed', {
              message: 'Luna engine failed to initialize (infrastructure issue). ' + cuaResult.issues.filter(i => i.includes('[engine') || i.includes('[console') || i.includes('[page-error')).join('; ').slice(0, 300)
            });
            throw new TaskFailedError('Engine initialization failure �?not an AI code issue');
          }

          if (cuaRound >= MAX_CUA_ROUNDS) {
            await reportStatus(taskId, 'failed', { 
              message: 'CUA blueprint verification' + MAX_CUA_ROUNDS + ' rounds failed: ' + cuaResult.issues.slice(0, 2).join('; ').slice(0, 200)
            });
            throw new TaskFailedError('CUA verification failed after ' + MAX_CUA_ROUNDS + ' rounds');
          }

          // Fix cycle: re-code with CUA feedback, rebuild, retry
          log(`CUA resume: round ${cuaRound} failed, fix cycle...`, taskId);
          await reportStatus(taskId, 'processing', { message: `CUAround ${cuaRound} round failed, AI re-coding...` });

          // Build structured CUA diagnosis with root cause analysis and actionable fix suggestions
          const { buildStructuredDiagnosis } = require('./worker-cua-verify.js');
          const cuaFeedbackText = buildStructuredDiagnosis(cuaResult, cuaBlueprint, cuaRound);
          // NOTE: Removed POST /feedback call — handler requires status=reviewing, CUA is in submitted state
          if (cuaBlueprint && cuaBlueprint.nodes) {
            // Inject CUA feedback directly into blueprint for INCREMENTAL FIX mode
            if (!cuaBlueprint.feedbackHistory) cuaBlueprint.feedbackHistory = [];
            cuaBlueprint.feedbackHistory.push({
              data: { text: cuaFeedbackText },
              source: 'cua-resume-round-' + cuaRound,
              status: 'pending',
              timestamp: Date.now()
            });
            log(`CUA resume: injected feedback into blueprint (${cuaBlueprint.feedbackHistory.length} entries) ?INCREMENTAL FIX`, taskId);

            const fixResult = await smartGenerateCode(cuaBlueprint, CLIENT_DIR, log, taskId, 'unity');
            if (!fixResult.ok) {
              await reportStatus(taskId, 'failed', { message: 'CUA fix re-code failed: ' + (fixResult.error || '').slice(0, 200) });
              throw new TaskFailedError('CUA fix re-code failed: ' + (fixResult.error || '').slice(0, 200));
            }
            log(`CUA resume fix re-code done: ${fixResult.filesWritten} files`, taskId);
          }

          // Rebuild
          await reportStatus(taskId, 'building', { message: `CUA fix rebuilding...` });
          const ltDir = path.join(CLIENT_DIR, 'LunaTemp');
          for (const sub of ['stage2', 'stage3', 'stage4']) {
            const sd = path.join(ltDir, sub);
            if (fs.existsSync(sd)) try { fs.rmSync(sd, { recursive: true, force: true }); } catch(e) {}
          }
          if (!USE_BASE_TEMPLATE) {
            if (cleanScene(CLIENT_DIR)) log('Scene re-cleaned for CUA fix', taskId);
          } else {
            log('V5: Skipping cleanScene for CUA fix �?base template preserved', taskId);
          }
          const fixScenes = detectScenes(CLIENT_DIR);
          fixLunaJson(CLIENT_DIR, fixScenes);
          generateExportAssets(CLIENT_DIR, fixScenes);

          const fixBuild = await doBuild(CLIENT_DIR, log, taskId);
          if (!fixBuild.ok) {
            await reportStatus(taskId, 'failed', { message: 'CUA fix rebuild failed: ' + (fixBuild.error || '').slice(0, 300) });
            throw new TaskFailedError('CUA fix rebuild failed: ' + (fixBuild.error || '').slice(0, 300));
          }
          log(`CUA resume fix rebuild OK in ${fixBuild.buildTime}s`, taskId);

          try {
            convertV3(path.join(CLIENT_DIR, 'LunaTemp', 'stage4', 'develop'), 
              path.join(WORK_DIR, taskId + '-html'), { stripModules: ['TextMeshPro'], outputName: taskId });
          } catch(e) {}

        } catch (cuaErr) {
          log(`CUA resume error round ${cuaRound}: ${cuaErr.message}`, taskId);
          await reportStatus(taskId, 'failed', { message: 'CUA verification crashed: ' + cuaErr.message.slice(0, 200) });
          throw new TaskFailedError('CUA verification crashed: ' + cuaErr.message.slice(0, 200));
        }
      }

      if (cuaPassed) {
        // Jump to upload
        await reportStatus(taskId, 'processing', { message: 'Uploading build...' });
        const uploaded = await uploadBuild(taskId);
        if (!uploaded) {
          await reportStatus(taskId, 'failed', { message: 'Build upload failed' });
          throw new TaskFailedError('Build upload failed');
        }
        await reportStatus(taskId, 'completed', { message: 'CUA resume done, build uploaded' });
        log('CUA resume completed successfully', taskId);
        throw new TaskFailedError('Task failed');
      }
      return;
    }

    // === Step 1: Git Clone/Reset Base Template ===
    await reportStatus(taskId, 'processing', { message: 'Preparing base template from GitHub...' });

    if (!fs.existsSync(path.join(FIXED_PROJECT_DIR, '.git'))) {
      // First time: clone
      log('Git clone base template...', taskId);
      // Remove stale directory if exists (e.g. old SVN checkout, locked Unity files)
      if (fs.existsSync(FIXED_PROJECT_DIR)) {
        log('Removing stale directory: ' + FIXED_PROJECT_DIR, taskId);
        try { fs.rmSync(FIXED_PROJECT_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 }); } catch(e) {}
        // Fallback: rmdir + powershell
        if (fs.existsSync(FIXED_PROJECT_DIR)) {
          runCmd(`rmdir /s /q "${FIXED_PROJECT_DIR}"`, undefined, 60000);
        }
        if (fs.existsSync(FIXED_PROJECT_DIR)) {
          runCmd(`powershell -Command "Remove-Item -Path '${FIXED_PROJECT_DIR}' -Recurse -Force"`, undefined, 60000);
        }
        if (fs.existsSync(FIXED_PROJECT_DIR)) {
          // Last resort: rename and continue
          const bakDir = FIXED_PROJECT_DIR + '-bak-' + Date.now();
          try { fs.renameSync(FIXED_PROJECT_DIR, bakDir); log('Renamed stale dir to: ' + bakDir, taskId); } catch(e) { log('Cannot remove stale dir: ' + e.message, taskId); }
        }
      }
      const clone = runCmd(`git clone "${BASE_TEMPLATE_REPO}" "${FIXED_PROJECT_DIR}"`, undefined, 600000);
      if (!clone.ok) {
        await reportStatus(taskId, 'failed', { message: 'Git clone failed: ' + clone.output.slice(0, 300) });
        throw new TaskFailedError('Git clone failed: ' + clone.output.slice(0, 300));
      }
      log('Git clone OK', taskId);
    } else {
      // Already cloned: fetch + hard reset to clean state
      log('Git fetch + reset to latest base template...', taskId);
      const fetch = runCmd(`git fetch origin ${BASE_TEMPLATE_BRANCH}`, FIXED_PROJECT_DIR, 120000);
      if (!fetch.ok) {
        log('Git fetch warning: ' + fetch.output.slice(0, 200), taskId);
      }
      const reset = runCmd(`git reset --hard origin/${BASE_TEMPLATE_BRANCH}`, FIXED_PROJECT_DIR, 30000);
      if (!reset.ok) {
        await reportStatus(taskId, 'failed', { message: 'Git reset failed: ' + reset.output.slice(0, 300) });
        throw new TaskFailedError('Git reset failed: ' + reset.output.slice(0, 300));
      }
      // Clean untracked files (AI-generated .cs, build artifacts, etc.)
      runCmd('git clean -fdx -e LunaTemp/', FIXED_PROJECT_DIR, 30000);
      log('Git reset + clean OK', taskId);
    }

    if (!fs.existsSync(CLIENT_DIR)) {
      await reportStatus(taskId, 'failed', { message: 'Client directory not found after git clone' });
      throw new TaskFailedError('Client directory not found after git clone');
    }

    // === Step 1.5: Clean old AI-generated scripts from Assets/Scripts ===
    // git reset --hard should handle this, but double-check
    const scriptsDir = path.join(CLIENT_DIR, 'Assets', 'Scripts');
    if (fs.existsSync(scriptsDir)) {
      function cleanCsRecursive(dir) {
        let count = 0;
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const e of entries) {
            const fp = path.join(dir, e.name);
            if (e.isDirectory()) {
              count += cleanCsRecursive(fp);
              try { if (fs.readdirSync(fp).length === 0) fs.rmdirSync(fp); } catch(x) {}
            } else if (e.name.endsWith('.cs')) {
              try { fs.unlinkSync(fp); count++; } catch(x) {}
            }
          }
        } catch(x) {}
        return count;
      }
      const cleaned = cleanCsRecursive(scriptsDir);
      if (cleaned > 0) log(`Cleaned ${cleaned} old .cs files from Assets/Scripts`, taskId);
    }

    // === Step 2: AI Coding ===
    await reportStatus(taskId, 'processing', { message: 'AI coding...' });
    let blueprint = null;
    try {
      blueprint = await apiRequest('GET', `/api/tasks/${taskId}/blueprint`);
    } catch (e) {
      log('Failed to fetch blueprint: ' + e.message, taskId);
    }

    if (blueprint && blueprint.nodes && blueprint.nodes.length > 0) {
      log(`Blueprint: ${blueprint.nodes.length} nodes, ${(blueprint.edges || []).length} edges`, taskId);
      const codeResult = await smartGenerateCode(blueprint, CLIENT_DIR, log, taskId, 'unity');
      if (codeResult.ok && !codeResult.skipped) {
        log(`AI coding done: ${codeResult.filesWritten} files written`, taskId);
        notifyEvent(taskId, 'coding_done', `AI coding done (${codeResult.filesWritten} files)`, { projectName: task.projectName });
        await reportStatus(taskId, 'processing', { message: `AI coding done (${codeResult.filesWritten} files)` });
      } else if (!codeResult.ok) {
        log('AI coding failed: ' + codeResult.error + ', retrying...', taskId);
        await reportStatus(taskId, 'processing', { message: 'AI coding failed, retrying...' });
        // Retry once
        const retryResult = await smartGenerateCode(blueprint, CLIENT_DIR, log, taskId, 'unity');
        if (retryResult.ok && !retryResult.skipped) {
          log(`AI coding retry done: ${retryResult.filesWritten} files written`, taskId);
          await reportStatus(taskId, 'processing', { message: `AI coding done (${retryResult.filesWritten} files, retry)` });
        } else {
          log('AI coding retry also failed: ' + (retryResult.error || 'unknown'), taskId);
          await reportStatus(taskId, 'error', { message: 'AI coding failed: ' + (codeResult.error || 'unknown') });
          throw new Error('AI coding failed after retry: ' + (retryResult.error || codeResult.error));
        }
      }
    } else {
      log('Empty or missing blueprint, skipping AI coding', taskId);
    }

    // === Step 3: Pre-build Patch ===
    await reportStatus(taskId, 'building', { message: 'Pre-process + Luna build...' });

    // Clean old LunaTemp but PRESERVE stage1 cache (asset export is slow without Bridge)
    const lunaTempDir = path.join(CLIENT_DIR, 'LunaTemp');
    if (fs.existsSync(lunaTempDir)) {
      for (const sub of ['stage2', 'stage3', 'stage4']) {
        const subDir = path.join(lunaTempDir, sub);
        if (fs.existsSync(subDir)) {
          try { fs.rmSync(subDir, { recursive: true, force: true }); } catch (e) {
            log(`Warning cleaning ${sub}: ${e.message}`, taskId);
          }
        }
      }
      log('Cleaned LunaTemp (stage1 cache preserved)', taskId);
    }

    // Auto-restore stage1 from git cache if missing
    const stage1Dir = path.join(CLIENT_DIR, 'LunaTemp', 'stage1');
    if (!fs.existsSync(stage1Dir) || !fs.existsSync(path.join(stage1Dir, 'js'))) {
      log('[stage1] Cache missing! Restoring from git stage1-cache...', taskId);
      const stage1CacheDir = path.join(__dirname, 'stage1-cache');
      if (fs.existsSync(stage1CacheDir)) {
        const { execSync } = require('child_process');
        if (!fs.existsSync(path.join(CLIENT_DIR, 'LunaTemp'))) {
          fs.mkdirSync(path.join(CLIENT_DIR, 'LunaTemp'), { recursive: true });
        }
        // xcopy the entire stage1-cache to LunaTemp/stage1
        execSync(`xcopy "${stage1CacheDir}" "${stage1Dir}" /E /I /Y /Q`, { stdio: 'pipe' });
        log('[stage1] Restored from git cache successfully', taskId);
      } else {
        log('[stage1] WARNING: stage1-cache not found in worker directory!', taskId);
        throw new TaskFailedError('stage1 cache missing and no backup available - need Unity Bridge to regenerate');
      }
    }

    // Replace template scene with clean empty scene (Camera + Light + EventSystem + GameManager + MaterialSource only)
    // V5 BASE TEMPLATE: skip cleanScene to preserve 242 pre-built objects
    if (USE_BASE_TEMPLATE) {
      log('V5: Skipping cleanScene �?base template scene preserved with 242 objects', taskId);
    } else if (cleanScene(CLIENT_DIR)) {
      log('Scene cleaned: replaced template with empty scene', taskId);
    } else {
      log('Warning: cleanScene skipped (template not found)', taskId);
    }

    const scenes = detectScenes(CLIENT_DIR);
    if (scenes.length === 0) {
      await reportStatus(taskId, 'failed', { message: 'No scenes found in project' });
      throw new TaskFailedError('No scenes found in project');
    }
    log(`Detected ${scenes.length} scene(s): ${scenes.join(', ')}`, taskId);

    fixLunaJson(CLIENT_DIR, scenes);
    generateExportAssets(CLIENT_DIR, scenes);
    // NOTE: scene injection disabled ?causes Luna jake build to hang
    // Material solution is now code-only (AI uses Object.FindObjectOfType<Renderer>())
    log('Pre-build patch applied', taskId);

    // === Step 4: Build ===
    const htmlOutputDir = path.join(WORK_DIR, taskId + '-html');
    let stage4Dir = path.join(CLIENT_DIR, 'LunaTemp', 'stage4', 'develop');
    
    if (USE_LINUX_BUILD) {
      // === Linux Build Path: C# �?JS �?HTML via remote API ===
      log('[linux-build] Using Linux build path', taskId);
      const csPath = path.join(CLIENT_DIR, 'Assets', 'Program', 'Script', 'Manager', 'GameFlowManagerMain.cs');
      const gfmPath = path.join(__dirname, 'GFM_Tools.cs');
      
      if (!fs.existsSync(csPath)) {
        throw new TaskFailedError('GameFlowManagerMain.cs not found at ' + csPath);
      }
      
      const csCode = fs.readFileSync(csPath, 'utf8');
      const extraFiles = {};
      if (fs.existsSync(gfmPath)) {
        extraFiles['GFM_Tools.cs'] = fs.readFileSync(gfmPath, 'utf8');
      }
      
      const linuxResult = await runLinuxBuild(csCode, extraFiles, log, taskId);
      if (!linuxResult.ok) {
        await reportStatus(taskId, 'failed', { message: 'Linux build failed: ' + (linuxResult.error || '').slice(0, 300) });
        throw new TaskFailedError('Linux build failed: ' + (linuxResult.error || '').slice(0, 300));
      }
      log(`Linux build OK in ${linuxResult.buildTime}s`, taskId);
      var buildResult = linuxResult; // Alias for shared code path below
      
      // Write the HTML to multiple locations
      fs.mkdirSync(htmlOutputDir, { recursive: true });
      fs.writeFileSync(path.join(htmlOutputDir, taskId + '.html'), linuxResult.html);
      fs.writeFileSync(path.join(htmlOutputDir, 'index.html'), linuxResult.html);
      
      // Also write to stage4/develop for CUA, preview-check, upload compatibility
      fs.mkdirSync(stage4Dir, { recursive: true });
      fs.writeFileSync(path.join(stage4Dir, 'iframe.html'), linuxResult.html);
      fs.writeFileSync(path.join(stage4Dir, 'index.html'), linuxResult.html);
      log(`[linux-build] HTML written to ${htmlOutputDir} + stage4/develop (${(linuxResult.htmlSize/1024).toFixed(0)} KB)`, taskId);
      
    } else {
      // === Windows Build Path: Luna jake + MSBuild ===
      const buildResult = await runBridgeBuild(CLIENT_DIR, log, taskId);
      if (!buildResult.ok) {
        await reportStatus(taskId, 'failed', { message: 'Luna build failed: ' + (buildResult.error || '').slice(0, 300) });
        throw new TaskFailedError('Luna build failed: ' + (buildResult.error || '').slice(0, 300));
      }
      log(`Luna build OK in ${buildResult.buildTime}s`, taskId);

      // === Step 5: HTML Conversion (converter-v3) ===
      await reportStatus(taskId, 'processing', { message: 'HTML conversion (converter-v3)...' });
      try {
        const v3Result = convertV3(stage4Dir, htmlOutputDir, { stripModules: ['TextMeshPro'], outputName: taskId });
        log(`HTML conversion done: ${v3Result.rawMB}MB raw / ${v3Result.gzipMB}MB gzip`, taskId);
      } catch (e) {
        log(`HTML conversion failed (non-fatal): ${e.message}`, taskId);
      }

      // === Step 5.5a: Luna Runtime Compatibility Patches ===
      try {
        const patchResult = patchLunaBuild(stage4Dir, log, taskId);
        if (patchResult.patched) {
          log(`Luna patches applied: ${patchResult.details.join('; ')}`, taskId);
        }
      } catch (patchErr) {
        log(`Luna patch error (non-fatal): ${patchErr.message}`, taskId);
      }
    }

    // === Step 5.6: Preview Health Check + Self-Heal Loop ===
    // Skip preview-check when using generated iframe.html (jake-skip mode) �?converter-v3 output is the real artifact
    // The generated iframe.html loads scripts via <script src> which doesn't match Luna's runtime init sequence
    const htmlOutputExists = fs.existsSync(path.join(htmlOutputDir, taskId + '.html'));
    if (htmlOutputExists) {
      log('[preview-check] Skipping �?HTML converter output exists, using that as final artifact', taskId);
    }
    if (!htmlOutputExists) {
      const { runPreviewCheck } = require('./worker-preview-check.js');
      const MAX_PREVIEW_FIX_ROUNDS = 3;

      for (let previewRound = 1; previewRound <= MAX_PREVIEW_FIX_ROUNDS; previewRound++) {
        const cuaStage4Pre = path.join(CLIENT_DIR, 'LunaTemp', 'stage4', 'develop');
        const previewResult = await runPreviewCheck(cuaStage4Pre, taskId, log);

        if (previewResult.ok) {
          log(`[preview-check] PASSED (round ${previewRound}) - game loaded successfully`, taskId);
          notifyEvent(taskId, 'preview_check', `?Preview passed, entering CUA`, { projectName: task.projectName });
          break;
        }

        log(`[preview-check] FAILED round ${previewRound}/${MAX_PREVIEW_FIX_ROUNDS}: ${previewResult.error}`, taskId);
        if (previewResult.consoleErrors && previewResult.consoleErrors.length > 0) {
          log(`[preview-check] JS errors: ${previewResult.consoleErrors.slice(0, 5).join(' | ').slice(0, 500)}`, taskId);
        }

        if (previewRound >= MAX_PREVIEW_FIX_ROUNDS) {
          notifyEvent(taskId, 'compile_error', `?Preview check ${MAX_PREVIEW_FIX_ROUNDS}  rounds failed: ${(previewResult.error||'').slice(0,100)}`, { projectName: task.projectName });
          throw new TaskFailedError(`Preview health check failed after ${MAX_PREVIEW_FIX_ROUNDS} fix rounds: ${previewResult.error}`);
        }

        // === Self-heal: feed error back to AI coder for targeted fix ===
        log(`[preview-check] Self-healing: feeding error to AI for fix (round ${previewRound})...`, taskId);
        await reportStatus(taskId, 'processing', {
          message: `Preview check failed(${previewResult.error?.slice(0, 50)}),AI self-fixing... (round ${previewRound}/${MAX_PREVIEW_FIX_ROUNDS})`
        });

        // Build feedback for AI coder
        const previewFeedback = {
          type: 'preview_health_check_failure',
          round: previewRound,
          error: previewResult.error,
          consoleErrors: (previewResult.consoleErrors || []).slice(0, 10),
          details: previewResult.details || {},
          instruction: `Preview check failed after build. Issue: ${previewResult.error}。` +
            (previewResult.consoleErrors?.length ? `Browser console errors: ${previewResult.consoleErrors.slice(0, 5).join('; ')}。` : '') +
            `Check and fix root cause. Common issues: Start()has uncaught exception, infinite loop, missing resources, or UI not created.` +
            `Preserve code structure, only fix the problematic parts.`
        };

        // Inject feedback into blueprint for incremental fix
        if (!blueprint.feedbackHistory) blueprint.feedbackHistory = [];
        blueprint.feedbackHistory.push(previewFeedback);

        // Re-generate code with feedback
        const fixResult = await smartGenerateCode(blueprint, CLIENT_DIR, log, taskId, 'unity');
        if (!fixResult || !fixResult.ok) {
          log(`[preview-check] AI fix failed, skipping to next round`, taskId);
          continue;
        }

        // Re-build
        log(`[preview-check] AI fix done, rebuilding...`, taskId);
        const fixBuild = await doBuild(CLIENT_DIR, log, taskId);
        if (!fixBuild.ok) {
          log(`[preview-check] Rebuild failed: ${fixBuild.error}, trying next round`, taskId);
          continue;
        }

        // Apply Luna patches again
        try {
          const { patchLunaBuild } = require('./worker-luna-patch.js');
          patchLunaBuild(path.join(CLIENT_DIR, 'LunaTemp', 'stage4', 'develop'), log, taskId);
        } catch(e) { /* non-fatal */ }

        log(`[preview-check] Rebuild done, re-checking preview...`, taskId);
        // Loop back to check again
      }
    } // end if (!htmlOutputExists)

    // === Step 5.7: CUA Verification Loop (PlayableAgent verification, fix until pass) ===
    let cuaPassed = false;
    
    for (let cuaRound = 1; cuaRound <= MAX_CUA_ROUNDS; cuaRound++) {
      try {
        const { runCUAVerification } = require('./worker-playableagent.js');
        await reportStatus(taskId, 'processing', { 
          message: `PlayableAgent verifying... (round ${cuaRound}/${MAX_CUA_ROUNDS})` 
        });

        // Read blueprint from API (fixed: local autoCoding-tasks path doesn't exist on Worker ECS)
        let cuaBlueprint = blueprint; // reuse from Step 2
        if (!cuaBlueprint) {
          try { cuaBlueprint = await apiRequest('GET', `/api/tasks/${taskId}/blueprint`); } catch(e) {
            log('CUA: Failed to fetch blueprint from API: ' + e.message, taskId);
          }
        }

        const cuaStage4 = path.join(CLIENT_DIR, 'LunaTemp', 'stage4', 'develop');
        const cuaResult = await runCUAVerification(cuaStage4, cuaBlueprint, taskId, log);

        if (cuaResult.skipped) {
          log(`CUA verification skipped (round ${cuaRound}): ${cuaResult.error || 'no agent'}`, taskId);
          cuaPassed = true;
          break;
        }

        if (cuaResult.passed) {
          log(`CUA verification PASSED (round ${cuaRound}): all shots passed`, taskId);
          notifyEvent(taskId, 'cua_pass', `?CUA passed (round ${cuaRound})! all shots passed`, { projectName: task.projectName });
          cuaPassed = true;
          break;
        }

        // CUA failed ?log issues
        log(`CUA verification FAILED round ${cuaRound}/${MAX_CUA_ROUNDS}, ${cuaResult.issues.length} issues`, taskId);
        cuaResult.issues.forEach(issue => log(`  - ${issue}`, taskId));
        notifyEvent(taskId, 'cua_round', `CUAround ${cuaRound}/${MAX_CUA_ROUNDS} round failed (${cuaResult.issues.length} issues): ${cuaResult.issues.slice(0,2).join('; ').slice(0,150)}`, { projectName: task.projectName });

        if (cuaRound >= MAX_CUA_ROUNDS) {
          // Max retries exhausted — fail the task with structured diagnosis
          const { buildStructuredDiagnosis: buildFinalDiag } = require('./worker-cua-verify.js');
          const feedbackText = buildFinalDiag(cuaResult, cuaBlueprint || {}, cuaRound);
          try {
            await apiRequest('POST', '/api/projects/' + taskId + '/feedback', 
              JSON.stringify({ text: feedbackText, source: 'cua-auto' }),
              false, { 'Content-Type': 'application/json' });
          } catch(fbErr) {
            log('CUA feedback submit failed: ' + fbErr.message, taskId);
          }
          await reportStatus(taskId, 'failed', { 
            message: 'CUA blueprint verification' + MAX_CUA_ROUNDS + ' rounds failed: ' + cuaResult.issues.slice(0, 2).join('; ').slice(0, 200),
            cuaReview: { issues: cuaResult.issues.length, rounds: cuaRound, details: cuaResult.issues }
          });
          throw new TaskFailedError('CUA verification failed after ' + MAX_CUA_ROUNDS + ' rounds');
        }

        // Not final round — use CUA feedback to re-code and rebuild
        log(`CUA round ${cuaRound} failed, starting fix cycle...`, taskId);

        // Re-code with CUA feedback as context
        await reportStatus(taskId, 'processing', { message: `CUAround ${cuaRound} round failed, AI re-coding...` });

        // Re-run AI coding (incremental fix with CUA feedback)
        // NOTE: Do NOT use /api/projects/:id/feedback — that handler requires status=reviewing
        // and rejects CUA auto-feedback. Instead, inject directly into blueprint object.
        let fixBlueprint = null;
        try { fixBlueprint = await apiRequest('GET', `/api/tasks/${taskId}/blueprint`); } catch(e) {}

        // Build structured diagnosis with root cause analysis and actionable fix suggestions
        const { buildStructuredDiagnosis: buildDiag } = require('./worker-cua-verify.js');
        const cuaFeedbackText = buildDiag(cuaResult, fixBlueprint || {}, cuaRound);
        
        if (fixBlueprint && fixBlueprint.nodes) {
          // Always inject CUA feedback into feedbackHistory for INCREMENTAL FIX mode
          if (!fixBlueprint.feedbackHistory) fixBlueprint.feedbackHistory = [];
          fixBlueprint.feedbackHistory.push({
            data: { text: cuaFeedbackText },
            source: 'cua-auto-round-' + cuaRound,
            status: 'pending',
            timestamp: Date.now()
          });
          log(`CUA fix: injected feedback into blueprint (${fixBlueprint.feedbackHistory.length} entries) → INCREMENTAL FIX`, taskId);

          const fixResult = await smartGenerateCode(fixBlueprint, CLIENT_DIR, log, taskId, 'unity');
          if (fixResult.ok) {
            log(`CUA fix re-code done: ${fixResult.filesWritten} files written`, taskId);
          } else {
            log(`CUA fix re-code failed: ${fixResult.error}`, taskId);
            await reportStatus(taskId, 'failed', { message: 'CUA fix re-code failed: ' + (fixResult.error || '').slice(0, 200) });
            throw new TaskFailedError('CUA fix re-code failed: ' + (fixResult.error || '').slice(0, 200));
          }
        }

        // Re-build
        await reportStatus(taskId, 'building', { message: `CUA fix rebuilding... (round ${cuaRound + 1}verify)` });
        
        // Clean stage2-4 for rebuild
        const ltDir = path.join(CLIENT_DIR, 'LunaTemp');
        for (const sub of ['stage2', 'stage3', 'stage4']) {
          const sd = path.join(ltDir, sub);
          if (fs.existsSync(sd)) try { fs.rmSync(sd, { recursive: true, force: true }); } catch(e) {}
        }

        if (!USE_BASE_TEMPLATE) {
          if (cleanScene(CLIENT_DIR)) log('Scene re-cleaned for CUA fix rebuild', taskId);
        } else {
          log('V5: Skipping cleanScene for CUA rebuild �?base template preserved', taskId);
        }
        const fixScenes = detectScenes(CLIENT_DIR);
        fixLunaJson(CLIENT_DIR, fixScenes);
        generateExportAssets(CLIENT_DIR, fixScenes);

        const fixBuild = await doBuild(CLIENT_DIR, log, taskId);
        if (!fixBuild.ok) {
          await reportStatus(taskId, 'failed', { message: 'CUA fix rebuild failed: ' + (fixBuild.error || '').slice(0, 300) });
          throw new TaskFailedError('CUA fix rebuild failed: ' + (fixBuild.error || '').slice(0, 300));
        }
        log(`CUA fix rebuild OK in ${fixBuild.buildTime}s`, taskId);

        // Re-apply Luna runtime patches after rebuild
        try {
          const fixStage4 = path.join(CLIENT_DIR, 'LunaTemp', 'stage4', 'develop');
          patchLunaBuild(fixStage4, log, taskId);
        } catch(e) {
          log(`CUA fix Luna patch error (non-fatal): ${e.message}`, taskId);
        }

        // Re-convert HTML
        try {
          const fixStage4 = path.join(CLIENT_DIR, 'LunaTemp', 'stage4', 'develop');
          const fixHtmlDir = path.join(WORK_DIR, taskId + '-html');
          convertV3(fixStage4, fixHtmlDir, { stripModules: ['TextMeshPro'], outputName: taskId });
        } catch(e) {
          log(`CUA fix HTML conversion failed (non-fatal): ${e.message}`, taskId);
        }

        // Loop back to CUA verification
      } catch (cuaErr) {
        log(`CUA verification error round ${cuaRound} (fatal): ${cuaErr.message}`, taskId);
        await reportStatus(taskId, 'failed', { message: 'CUA verification crashed: ' + cuaErr.message.slice(0, 200) });
        throw new TaskFailedError('CUA verification crashed: ' + cuaErr.message.slice(0, 200));
      }
    }

    if (!cuaPassed) {
      await reportStatus(taskId, 'failed', { message: 'CUA verification did not pass after all rounds' });
      throw new TaskFailedError('CUA verification did not pass after all rounds');
    }

    // === Step 6: Upload Build ===
    await reportStatus(taskId, 'processing', { message: 'Uploading build...' });
    const uploaded = await uploadBuild(taskId);
    if (!uploaded) {
      await reportStatus(taskId, 'failed', { message: 'Build upload failed' });
      throw new TaskFailedError('Build upload failed');
    }

    // === Step 7: Upload single-file HTMLs ===
    if (fs.existsSync(htmlOutputDir)) {
      await reportStatus(taskId, 'processing', { message: 'Uploading channel HTML...' });
      try {
        const htmlFiles = fs.readdirSync(htmlOutputDir).filter(f => f.endsWith('.html'));
        for (const f of htmlFiles) {
          const htmlBuffer = fs.readFileSync(path.join(htmlOutputDir, f));
          await apiRequest('POST', `/api/tasks/${taskId}/upload-html`, htmlBuffer, false, {
            'Content-Type': 'text/html',
            'X-Filename': f
          });
          log(`Uploaded HTML: ${f} (${(htmlBuffer.length / 1024).toFixed(0)} KB)`, taskId);
        }
        try { fs.rmSync(htmlOutputDir, { recursive: true, force: true }); } catch (e) {}
      } catch (e) {
        log(`HTML upload failed (non-fatal): ${e.message}`, taskId);
      }
    }

    // === Step 8: Done (CUA verification already done in Step 5.5b) ===
    const _buildTime = (typeof buildResult !== 'undefined' && buildResult && buildResult.buildTime) ? buildResult.buildTime + 's' : (typeof linuxResult !== 'undefined' && linuxResult && linuxResult.buildTime) ? linuxResult.buildTime + 's' : 'N/A';
    await reportStatus(taskId, 'reviewing', { message: `Build done (${_buildTime}),CUA passed,waiting for review` });
    notifyEvent(taskId, 'done', `🎉 Task done! Build ${buildResult.buildTime}s, CUA passed, waiting for review`, { projectName: task.projectName });
    log('Task completed ?reviewing', taskId);

  } catch (e) {
    if (e instanceof TaskFailedError) throw e;
    log(`Task error: ${e.message}`, taskId);
    await reportStatus(taskId, 'failed', { message: 'Error: ' + e.message.slice(0, 300) });
    throw new TaskFailedError(e.message);
  }
}

// ============ Cocos Task Processing ============

async function processTaskCocos(task) {
  const taskId = task.taskId;

  if (!cocosPatch || !cocosBuild) {
    await reportStatus(taskId, 'failed', { message: 'Cocos modules not available on this worker' });
    throw new TaskFailedError('Cocos modules not available on this worker');
  }

  try {
    // === Step 1: SVN Update ===
    await reportStatus(taskId, 'processing', { message: 'SVN update (Cocos)...' });

    if (!fs.existsSync(COCOS_PROJECT_DIR)) {
      const svnUrl = task.svnUrl || 'svn://47.101.191.213:3690/test0213';
      log('SVN checkout (Cocos, first time)...', taskId);
      const checkout = runCmd(`svn checkout ${SVN_FLAGS} "${svnUrl}" "${COCOS_PROJECT_DIR}"`, undefined, 600000);
      if (!checkout.ok) {
        await reportStatus(taskId, 'failed', { message: 'SVN checkout failed: ' + checkout.output.slice(0, 300) });
        throw new TaskFailedError('SVN checkout failed: ' + checkout.output.slice(0, 300));
      }
    } else {
      const update = runCmd(`svn update ${SVN_FLAGS}`, COCOS_PROJECT_DIR, 120000);
      if (!update.ok) {
        await reportStatus(taskId, 'failed', { message: 'SVN update failed: ' + update.output.slice(0, 300) });
        throw new TaskFailedError('SVN update failed: ' + update.output.slice(0, 300));
      }
      log('SVN update OK: ' + update.output.split('\n').pop(), taskId);
    }

    // === Step 2: AI Coding ===
    await reportStatus(taskId, 'processing', { message: 'AI coding (Cocos)...' });
    let blueprint = null;
    try {
      blueprint = await apiRequest('GET', `/api/tasks/${taskId}/blueprint`);
    } catch (e) {
      log('Failed to fetch blueprint: ' + e.message, taskId);
    }

    if (blueprint && blueprint.nodes && blueprint.nodes.length > 0) {
      log(`Blueprint: ${blueprint.nodes.length} nodes`, taskId);
      const codeResult = await generateCode(blueprint, COCOS_PROJECT_DIR, log, taskId, 'cocos');
      if (codeResult.ok && !codeResult.skipped) {
        log(`AI coding done: ${codeResult.filesWritten} files`, taskId);
        await reportStatus(taskId, 'processing', { message: `AI coding done (${codeResult.filesWritten} files)` });
      } else if (!codeResult.ok) {
        log('AI coding failed: ' + codeResult.error + ', retrying...', taskId);
        await reportStatus(taskId, 'processing', { message: 'AI coding failed, retrying...' });
        const retryResult = await generateCode(blueprint, COCOS_PROJECT_DIR, log, taskId, 'cocos');
        if (retryResult.ok && !retryResult.skipped) {
          log(`AI coding retry done: ${retryResult.filesWritten} files`, taskId);
        } else {
          await reportStatus(taskId, 'error', { message: 'AI coding failed: ' + (codeResult.error || 'unknown') });
          throw new Error('AI coding failed after retry: ' + (retryResult.error || codeResult.error));
        }
      }
    }

    // === Step 3: Pre-build + Cocos Build ===
    await reportStatus(taskId, 'building', { message: 'Cocos building...' });

    const buildDir = path.join(COCOS_PROJECT_DIR, 'build', 'web-mobile');
    if (fs.existsSync(buildDir)) {
      try { fs.rmSync(buildDir, { recursive: true, force: true }); } catch (e) {}
    }

    const scenes = cocosPatch.detectScenes(COCOS_PROJECT_DIR);
    if (scenes.length === 0) {
      await reportStatus(taskId, 'failed', { message: 'No scenes found' });
      throw new TaskFailedError('No scenes found');
    }
    log(`Detected ${scenes.length} scene(s)`, taskId);
    cocosPatch.fixProjectSettings(COCOS_PROJECT_DIR, scenes);

    const buildResult = await cocosBuild.runCocosBuild(COCOS_PROJECT_DIR, log, taskId);
    if (!buildResult.ok) {
      await reportStatus(taskId, 'failed', { message: 'Cocos build failed: ' + (buildResult.error || '').slice(0, 300) });
      throw new TaskFailedError('Cocos build failed: ' + (buildResult.error || '').slice(0, 300));
    }
    log(`Cocos build OK in ${buildResult.buildTime}s`, taskId);

    // === Step 4: HTML Conversion ===
    await reportStatus(taskId, 'processing', { message: 'HTML channel conversion...' });
    const htmlOutputDir = path.join(WORK_DIR, taskId + '-html');
    // Cocos uses its own html converter (not converter-v3)
    const htmlConverter = cocosHtmlConverter;
    if (!htmlConverter) {
      log('Cocos HTML converter not available, skipping', taskId);
    }
    try {
      const htmlResults = await htmlConverter.convertAndSave(buildDir, htmlOutputDir, {
        channels: ['appLovin'],
        projectName: taskId
      });
      log(`HTML conversion done: ${htmlResults.length} channels`, taskId);
    } catch (e) {
      log(`HTML conversion failed (non-fatal): ${e.message}`, taskId);
    }

    // === Step 5: Upload HTMLs ===
    await reportStatus(taskId, 'processing', { message: 'Uploading HTML...' });
    if (fs.existsSync(htmlOutputDir)) {
      const htmlFiles = fs.readdirSync(htmlOutputDir).filter(f => f.endsWith('.html'));
      let uploadOk = false;
      for (const f of htmlFiles) {
        const htmlBuffer = fs.readFileSync(path.join(htmlOutputDir, f));
        log(`Uploading ${f} (${(htmlBuffer.length / 1024 / 1024).toFixed(1)}MB)`, taskId);
        try {
          await apiRequest('POST', `/api/tasks/${taskId}/upload-html`, htmlBuffer, true, {
            'Content-Type': 'text/html',
            'X-Filename': f
          });
          uploadOk = true;
        } catch (e) {
          log(`HTML upload failed: ${e.message}`, taskId);
        }
      }
      try { fs.rmSync(htmlOutputDir, { recursive: true, force: true }); } catch (e) {}
      if (!uploadOk) {
        await reportStatus(taskId, 'failed', { message: 'HTML upload failed' });
        throw new TaskFailedError('HTML upload failed');
      }
    } else {
      await reportStatus(taskId, 'failed', { message: 'No HTML output' });
      throw new TaskFailedError('No HTML output');
    }

    await reportStatus(taskId, 'reviewing', { message: `Cocos Build done (${buildResult.buildTime}s),waiting for review` });
    log('Task completed ?reviewing (Cocos)', taskId);

  } catch (e) {
    log(`Task error (Cocos): ${e.message}`, taskId);
    await reportStatus(taskId, 'failed', { message: 'Error: ' + e.message.slice(0, 300) });
  }
}

async function uploadBuild(taskId) {
  // Find build output
  // Linux build: single HTML at WORK_DIR/taskId-html/taskId.html
  // Windows build: stage4/develop/index.html
  const linuxHtmlDir = path.join(WORK_DIR, taskId + '-html');
  const linuxHtmlFile = path.join(linuxHtmlDir, taskId + '.html');
  
  const searchDirs = [
    path.join(CLIENT_DIR, 'LunaTemp', 'stage4', 'develop'),
    path.join(CLIENT_DIR, 'LunaTemp', 'package', 'default'),
    path.join(CLIENT_DIR, 'LunaTemp', 'package'),
  ];

  let buildDir = null;
  
  // Check Linux build output first
  if (USE_LINUX_BUILD && fs.existsSync(linuxHtmlFile)) {
    buildDir = linuxHtmlDir;
    // Rename to index.html for compatibility
    const indexPath = path.join(linuxHtmlDir, 'index.html');
    if (!fs.existsSync(indexPath)) {
      fs.copyFileSync(linuxHtmlFile, indexPath);
    }
    log(`[linux-build] Using Linux build output: ${linuxHtmlFile}`, taskId);
  } else {
    for (const d of searchDirs) {
      if (fs.existsSync(path.join(d, 'index.html'))) {
        buildDir = d;
        break;
      }
    }
  }

  if (!buildDir) {
    log('No build output found (no index.html)', taskId);
    return false;
  }

  log(`Build output found: ${buildDir}`, taskId);

  // Create zip
  const zipPath = path.join(WORK_DIR, taskId + '-build.zip');
  // Remove old zip if exists
  try { fs.unlinkSync(zipPath); } catch (e) {}

  const zipResult = runCmd(
    `powershell -Command "Compress-Archive -Path '${buildDir}\\*' -DestinationPath '${zipPath}' -Force"`,
    undefined, 60000
  );
  if (!zipResult.ok || !fs.existsSync(zipPath)) {
    log(`Zip failed: ${zipResult.output}`, taskId);
    return false;
  }

  const zipBuffer = fs.readFileSync(zipPath);
  log(`Uploading ${(zipBuffer.length / 1024).toFixed(0)} KB...`, taskId);

  try {
    const result = await apiRequest('POST', `/api/tasks/${taskId}/upload-build`, zipBuffer, true);
    log(`Upload OK: ${JSON.stringify(result)}`, taskId);
    try { fs.unlinkSync(zipPath); } catch (e) {}
    return result && result.success;
  } catch (e) {
    log(`Upload failed: ${e.message}`, taskId);
    return false;
  }
}

async function handleCommit(task) {
  const taskId = task.taskId;
  const engine = task.engine || 'unity';
  const isCocos = engine === 'cocos';
  const projectDir = isCocos ? COCOS_PROJECT_DIR : FIXED_PROJECT_DIR;

  await reportStatus(taskId, 'processing', { message: 'Finalizing project...' });

  if (!fs.existsSync(projectDir)) {
    await reportStatus(taskId, 'failed', { message: 'Working copy not found' });
    throw new TaskFailedError('Working copy not found');
  }

  // Git-based: no SVN commit needed. Just clean up build artifacts.
  const cacheList = isCocos
    ? ['build', 'temp', 'local', 'library', 'node_modules', '.vs']
    : ['Library', 'Temp', 'LunaTemp', 'obj', 'Logs', 'UserSettings', '.vs'];
  const cachePrefix = isCocos ? '' : 'Client';
  for (const dir of cacheList) {
    const dirPath = cachePrefix ? path.join(projectDir, cachePrefix, dir) : path.join(projectDir, dir);
    if (fs.existsSync(dirPath)) {
      try {
        fs.rmSync(dirPath, { recursive: true, force: true });
        log(`Cleaned: ${cachePrefix ? cachePrefix + '/' : ''}${dir}`, taskId);
      } catch (e) {
        log(`Warning: failed to clean ${dir}: ${e.message}`, taskId);
      }
    }
  }

  log('Project cleanup done (no SVN commit �?using Git base template)', taskId);

  // Callback to Blueprint Editor
  try {
    const commitMsg = `[AutoCoding] ${task.projectName || 'Project'} - ${taskId}`;
    await apiRequest('POST', `/api/projects/${taskId}/committed`, { svnRevision: null, message: commitMsg });
    log('Committed callback OK', taskId);
  } catch (e) {
    log(`Committed callback failed: ${e.message}`, taskId);
  }

  await reportStatus(taskId, 'committed', { message: 'Project finalized' });
}

// ============ Poll & Heartbeat ============

async function poll() {
  if (pollLock || activeTasks.size >= MAX_CONCURRENT) return;
  pollLock = true;
  try {
    const task = await apiRequest('GET', `/api/worker/poll?workerId=${WORKER_ID}`);
    if (!task || !task.taskId) return;
    if (activeTasks.has(task.taskId)) return;

    log(`Got task: ${task.taskId} (${task.status}), project: ${task.projectName || '?'}`, task.taskId);
    if (task.debugBy) { taskDebugBy.set(task.taskId, task.debugBy); log(`[debug] Task being debugged by: ${task.debugBy}`, task.taskId); }
    activeTasks.set(task.taskId, { task, startedAt: Date.now(), projectName: task.projectName });
    notifyEvent(task.taskId, 'task_started', `Started processing: ${task.projectName || task.taskId}`, { projectName: task.projectName });

    // Task execution with auto-retry + global timeout
    const runWithRetry = async () => {
      const taskTimeout = setTimeout(() => {
        log(`?Task timeout (${TASK_TIMEOUT_MS/60000}min)`, task.taskId);
        notifyEvent(task.taskId, 'timeout', `Task timeout (${TASK_TIMEOUT_MS/60000}min)`, { projectName: task.projectName });
      }, TASK_TIMEOUT_MS);
      try {
        await processTask(task);
      } catch (e) {
        clearTimeout(taskTimeout);
        const retries = taskRetryCount.get(task.taskId) || 0;
        if (retries < MAX_TASK_RETRIES && !e.noRetry) {
          taskRetryCount.set(task.taskId, retries + 1);
          const delay = (RETRY_DELAYS[retries] || 120) * 1000;
          log(`🔄 Task retry ${retries + 1}/${MAX_TASK_RETRIES} in ${delay/1000}s: ${e.message.slice(0, 100)}`, task.taskId);
          notifyEvent(task.taskId, 'task_retry',
            `Task failed, ${delay/1000}s auto-retry (${retries + 1}/${MAX_TASK_RETRIES}): ${e.message.slice(0, 100)}`,
            { projectName: task.projectName });
          await new Promise(r => setTimeout(r, delay));
          // Clean CUA cache ONLY if failure was NOT upload-related
          // If CUA passed but upload failed, keep CUA cache so retry skips to upload
          const isUploadFailure = e.message && (e.message.includes('upload') || e.message.includes('Upload'));
          if (!isUploadFailure) {
            try {
              const cuaDir = path.join(__dirname, 'cua-results');
              ['-cua.log', '-report.json'].forEach(suf => {
                const f = path.join(cuaDir, task.taskId + suf);
                if (fs.existsSync(f)) fs.unlinkSync(f);
              });
              log('Cleared CUA cache for fresh retry', task.taskId);
            } catch(ce) {}
          } else {
            log('Upload failure - keeping CUA cache for retry', task.taskId);
          }
          await processTask(task);
        } else {
          throw e;
        }
      } finally {
        clearTimeout(taskTimeout);
      }
    };
    runWithRetry()
      .catch(async e => {
        log(`?Task failed permanently: ${e.message}`, task.taskId);
        notifyEvent(task.taskId, 'task_failed_final',
          `Task failed permanently (retried${taskRetryCount.get(task.taskId) || 0} times): ${e.message.slice(0, 150)}`,
          { projectName: task.projectName });
        // Report failure to server so task doesn't stay stuck in assigned/processing
        try {
          await reportStatus(task.taskId, 'failed', { message: `Permanently failed: ${e.message.slice(0, 200)}` });
        } catch (re) {
          log(`Failed to report terminal status: ${re.message}`, task.taskId);
        }
      })
      .finally(() => {
        activeTasks.delete(task.taskId);
        taskRetryCount.delete(task.taskId);
        log(`Task done. Slots: ${activeTasks.size}/${MAX_CONCURRENT}`, task.taskId);
      });
  } catch (e) {
    // Poll error ?server might be down, silently retry
    if (!e.message.includes('timeout')) log(`Poll error: ${e.message}`);
  } finally {
    pollLock = false;
  }
}

async function heartbeat() {
  const tasks = [];
  for (const [taskId, info] of activeTasks) {
    tasks.push({ taskId, elapsed: Math.floor((Date.now() - info.startedAt) / 1000) });
  }
  try {
    await apiRequest('POST', '/api/worker/heartbeat', {
      workerId: WORKER_ID,
      status: activeTasks.size > 0 ? 'busy' : 'idle',
      activeTasks: tasks,
      activeCount: activeTasks.size,
      maxConcurrent: MAX_CONCURRENT,
      currentTask: tasks[0] || null,
      uptime: Math.floor((Date.now() - startTime) / 1000)
    });
  } catch (e) { /* silent */ }
}

// ============ Start ============
log(`Worker v4 (unified) starting | ID: ${WORKER_ID} | Server: ${BASE_URL}`);
log(`Unity dir: ${FIXED_PROJECT_DIR} | Cocos dir: ${COCOS_PROJECT_DIR} | Luna: ${LUNA_DIR}`);

poll();
setInterval(poll, POLL_INTERVAL);
setInterval(heartbeat, HEARTBEAT_INTERVAL);
heartbeat();
