/**
 * Linux Worker Client — Polls tasks from Blueprint Server, builds via Linux Bridge.NET pipeline
 * 
 * Flow: Poll task → AI coding (via Anthropic API) → POST /build (localhost:3080) → CUA → Upload
 * 
 * This runs on the main ECS (120.55.70.226) alongside linux-bridge-build.js
 * Worker ID starts with "linux" so server.cjs assigns independently from Windows worker
 * 
 * Dependencies: dotenv (npm install dotenv)
 * No Windows-specific deps (no Unity, no jake, no Bridge on Windows)
 */

/**
 * NOTE: This script runs on the LOCAL MACHINE (Windows), NOT on the Linux ECS.
 * It polls tasks, does AI coding locally, then calls the Linux ECS /build API for compilation.
 * This way we reuse worker-coder.js and all prompt files without porting to Linux.
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { generateCodeV5 } = require('./worker-coder.js');

// ============ Config ============
const WORKER_ID = process.env.LINUX_WORKER_ID || 'linux-worker-1';
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

    // === Step 2: AI Coding (generate C# code in local temp dir) ===
    const tempDir = path.join(require('os').tmpdir(), `linux-task-${taskId}`);
    const assetsDir = path.join(tempDir, 'Assets', 'Scripts');
    fs.mkdirSync(assetsDir, { recursive: true });

    // Copy GFM_Tools.cs to temp dir
    const gfmSrc = path.join(__dirname, 'GFM_Tools.cs');
    if (fs.existsSync(gfmSrc)) {
      fs.copyFileSync(gfmSrc, path.join(assetsDir, 'GFM_Tools.cs'));
    }

    const codeResult = await generateCodeV5(blueprint, tempDir, log, taskId, 'unity');
    if (!codeResult.ok) {
      log('AI coding failed: ' + codeResult.error, taskId);
      await reportStatus(taskId, 'failed', { message: '[Linux] AI coding failed: ' + (codeResult.error || '').slice(0, 200) });
      return;
    }
    log(`AI coding done: ${codeResult.filesWritten} files`, taskId);
    await reportStatus(taskId, 'processing', { message: `[Linux] AI coding done (${codeResult.filesWritten} files), building...` });

    // === Step 3: Read generated C# files (search recursively) ===
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
    
    const allCs = findFiles(tempDir, '.cs');
    const mainCsPath = allCs.find(f => f.includes('GameFlowManagerMain.cs'));
    
    if (!mainCsPath) {
      log('No GameFlowManagerMain.cs found in: ' + allCs.join(', '), taskId);
      await reportStatus(taskId, 'failed', { message: '[Linux] No GameFlowManagerMain.cs generated' });
      return;
    }
    
    const csCode = fs.readFileSync(mainCsPath, 'utf-8');
    log(`Main CS: ${mainCsPath} (${csCode.length} chars)`, taskId);
    // Always use canonical GFM_Tools.cs from worker dir (never AI-generated version)
    const extraFiles = {};
    const canonicalGfm = path.join(__dirname, 'GFM_Tools.cs');
    if (fs.existsSync(canonicalGfm)) {
      extraFiles['GFM_Tools.cs'] = fs.readFileSync(canonicalGfm, 'utf-8');
    }

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
      const fixAssetsDir = path.join(fixTempDir, 'Assets', 'Scripts');
      fs.mkdirSync(fixAssetsDir, { recursive: true });
      
      // Copy GFM_Tools and current code for context
      const gfmSrcFix = path.join(__dirname, 'GFM_Tools.cs');
      if (fs.existsSync(gfmSrcFix)) fs.copyFileSync(gfmSrcFix, path.join(fixAssetsDir, 'GFM_Tools.cs'));
      fs.writeFileSync(path.join(fixAssetsDir, 'GameFlowManagerMain.cs'), lastCsCode);

      let fixResult;
      try {
        fixResult = await generateCodeV5(blueprint, fixTempDir, log, taskId, 'unity');
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

    // === Step 6: CUA Verification + Auto-Fix Loop ===
    const MAX_CUA_ROUNDS = 20;
    const { runCUAVerification } = require('./worker-cua-verify.js');
    let cuaPassed = false;
    let lastHtmlData = htmlData;
    // lastCsCode already defined in Step 4 (may have been updated by build fix loop)

    for (let cuaRound = 1; cuaRound <= MAX_CUA_ROUNDS; cuaRound++) {
      await reportStatus(taskId, 'processing', { message: `[Linux] CUA verifying... (round ${cuaRound}/${MAX_CUA_ROUNDS})` });
      
      // Write HTML to temp dir for CUA
      const cuaBuildDir = path.join(require('os').tmpdir(), `linux-cua-${taskId}-r${cuaRound}`);
      fs.mkdirSync(cuaBuildDir, { recursive: true });
      fs.writeFileSync(path.join(cuaBuildDir, 'iframe.html'), lastHtmlData);
      
      let cuaResult;
      try {
        cuaResult = await runCUAVerification(cuaBuildDir, blueprint, taskId, log);
      } catch (cuaErr) {
        log(`CUA round ${cuaRound} error: ${cuaErr.message}`, taskId);
        if (cuaRound >= MAX_CUA_ROUNDS) {
          await reportStatus(taskId, 'done', { message: `[Linux] Done (CUA error after ${cuaRound} rounds)` });
        }
        try { fs.rmSync(cuaBuildDir, { recursive: true, force: true }); } catch(e) {}
        continue;
      }
      
      try { fs.rmSync(cuaBuildDir, { recursive: true, force: true }); } catch(e) {}

      if (cuaResult.passed || cuaResult.skipped) {
        cuaPassed = true;
        log(`CUA ${cuaResult.skipped ? 'SKIPPED' : 'PASSED'} round ${cuaRound}, total ${((Date.now() - startTime) / 1000).toFixed(0)}s`, taskId);
        await reportStatus(taskId, 'cua_passed', { message: `[Linux] CUA passed (round ${cuaRound})! Total: ${((Date.now() - startTime) / 1000).toFixed(0)}s` });
        break;
      }

      log(`CUA FAILED round ${cuaRound}/${MAX_CUA_ROUNDS}: ${cuaResult.issues.length} issues`, taskId);
      cuaResult.issues.forEach(i => log(`  - ${i}`, taskId));

      // Auto-stop: engine not initialized = infrastructure issue
      if (cuaResult.report && cuaResult.report.diagnostics && !cuaResult.report.diagnostics.engineReady) {
        log('CUA auto-stop: engine not initialized — infrastructure issue, AI re-coding won\'t help', taskId);
        await reportStatus(taskId, 'failed', { message: '[Linux] Engine not initialized — infrastructure issue' });
        break;
      }

      if (cuaRound >= MAX_CUA_ROUNDS) {
        await reportStatus(taskId, 'failed', { message: `[Linux] CUA failed after ${MAX_CUA_ROUNDS} rounds` });
        break;
      }

      // === Fix cycle: build CUA feedback → re-code → rebuild → retry ===
      await reportStatus(taskId, 'processing', { message: `[Linux] CUA round ${cuaRound} failed, AI re-coding...` });

      // Build detailed feedback
      let cuaFeedbackText = `CUA blueprint flow verification failed (round ${cuaRound}):\n` + cuaResult.issues.join('\n');
      if (cuaResult.report && cuaResult.report.diagnostics) {
        const diag = cuaResult.report.diagnostics;
        if (diag.consoleErrors && diag.consoleErrors.length > 0) {
          cuaFeedbackText += '\nConsole errors:\n' + diag.consoleErrors.slice(0, 10).map(e => '  - ' + e).join('\n');
        }
      }
      if (cuaResult.report && cuaResult.report.gameState) {
        const gs = cuaResult.report.gameState;
        cuaFeedbackText += '\n\n📊 Game State at failure:';
        cuaFeedbackText += '\n  Current Phase: ' + (gs.currentPhase || 'unknown');
        cuaFeedbackText += '\n  Completed Phases: ' + ((gs.completedPhases || []).join(', ') || 'none');
        if (gs.variables) cuaFeedbackText += '\n  Variables: ' + JSON.stringify(gs.variables);
        if (gs.entityStates) cuaFeedbackText += '\n  Entity States: ' + JSON.stringify(gs.entityStates);
      }
      cuaFeedbackText += '\n\nPlease fix the code to ensure blueprint flow works. Focus on the specific phase/entity that failed.';

      // Inject feedback into blueprint for INCREMENTAL FIX mode
      if (!blueprint.feedbackHistory) blueprint.feedbackHistory = [];
      blueprint.feedbackHistory.push({
        data: { text: cuaFeedbackText },
        source: 'cua-linux-round-' + cuaRound,
        status: 'pending',
        timestamp: Date.now()
      });

      // Re-generate code
      const fixTempDir = path.join(require('os').tmpdir(), `linux-fix-${taskId}-r${cuaRound}`);
      const fixAssetsDir = path.join(fixTempDir, 'Assets', 'Scripts');
      fs.mkdirSync(fixAssetsDir, { recursive: true });
      if (fs.existsSync(gfmSrc)) fs.copyFileSync(gfmSrc, path.join(fixAssetsDir, 'GFM_Tools.cs'));
      // Copy previous code so AI can do incremental fix
      fs.writeFileSync(path.join(fixAssetsDir, 'GameFlowManagerMain.cs'), lastCsCode);

      let fixResult;
      try {
        fixResult = await generateCodeV5(blueprint, fixTempDir, log, taskId, 'unity');
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

      // Download new HTML
      try {
        lastHtmlData = await buildRequest('/build-html', lastCsCode, fixExtraFiles);
        log(`Fix HTML: ${(lastHtmlData.length / 1048576).toFixed(1)}MB`, taskId);
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

  } catch (e) {
    log('Task error: ' + e.message, taskId);
    await reportStatus(taskId, 'failed', { message: '[Linux] Error: ' + e.message.slice(0, 200) });
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
