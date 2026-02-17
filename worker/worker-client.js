// Worker Client v4 — Poll from Blueprint Editor API, build via Luna jake pipeline
// Flow: Poll task → SVN update → Pre-build patch → Luna build → Upload zip → Report status
// Also handles: fix_needed (re-build), commit_needed (SVN commit + cleanup)

const http = require('http');
const https = require('https');
const { exec, execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { detectScenes, fixLunaJson, generateExportAssets } = require('./worker-patch.js');
const { runBridgeBuild, bridgeRequest } = require('./worker-bridge-build.js');
const { generateCode } = require('./worker-coder.js');
const { convertAndSave } = require('./worker-html-converter.js');

// ============ Config ============
const WORKER_ID = process.env.WORKER_ID || 'workerA';
const BASE_URL = process.env.BASE_URL || 'https://playcools.top/blueprintEditor';
const POLL_INTERVAL = 8000;       // 8s between polls
const HEARTBEAT_INTERVAL = 30000; // 30s heartbeat
const WORK_DIR = 'D:\\work';
const FIXED_PROJECT_DIR = path.join(WORK_DIR, 'test-luna'); // Fixed SVN working copy
const CLIENT_DIR = path.join(FIXED_PROJECT_DIR, 'Client');
const SVN_USER = 'openclaw';
const SVN_PASS = 'openclaw';
const SVN_FLAGS = `--non-interactive --no-auth-cache --username ${SVN_USER} --password ${SVN_PASS}`;
const MAX_CONCURRENT = 1; // Only 1 task at a time (Unity can only open 1 project)
const LUNA_DIR = 'D:\\Luna';

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

async function reportStatus(taskId, status, extra) {
  const payload = { workerId: WORKER_ID, taskId, status };
  if (extra) Object.assign(payload, extra);
  try {
    await apiRequest('POST', '/api/worker/status', payload);
    log(`Status → ${status}${extra && extra.message ? ': ' + extra.message : ''}`, taskId);
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

  // Restore original status if server used atomic assign
  if (task.originalStatus) {
    task.status = task.originalStatus;
    delete task.originalStatus;
  }

  if (task.status === 'commit_needed') {
    return await handleCommit(task);
  }

  try {
    // === Step 1: SVN Update ===
    await reportStatus(taskId, 'processing', { message: 'SVN update 中...' });

    if (!fs.existsSync(FIXED_PROJECT_DIR)) {
      // First time: SVN checkout
      const svnUrl = task.svnUrl || 'svn://47.101.191.213:3690/test0213';
      log('SVN checkout (first time)...', taskId);
      const checkout = runCmd(`svn checkout ${SVN_FLAGS} "${svnUrl}" "${FIXED_PROJECT_DIR}"`, undefined, 600000);
      if (!checkout.ok) {
        await reportStatus(taskId, 'failed', { message: 'SVN checkout failed: ' + checkout.output.slice(0, 300) });
        return;
      }
    } else {
      // SVN update existing working copy
      const update = runCmd(`svn update ${SVN_FLAGS}`, FIXED_PROJECT_DIR, 120000);
      if (!update.ok) {
        await reportStatus(taskId, 'failed', { message: 'SVN update failed: ' + update.output.slice(0, 300) });
        return;
      }
      log('SVN update OK: ' + update.output.split('\n').pop(), taskId);
    }

    if (!fs.existsSync(CLIENT_DIR)) {
      await reportStatus(taskId, 'failed', { message: 'Client directory not found after SVN update' });
      return;
    }

    // === Step 2: AI Coding ===
    await reportStatus(taskId, 'processing', { message: 'AI 编码中...' });

    // Fetch blueprint from server
    let blueprint = null;
    try {
      blueprint = await apiRequest('GET', `/api/tasks/${taskId}/blueprint`);
    } catch (e) {
      log('Failed to fetch blueprint: ' + e.message, taskId);
    }

    if (blueprint && blueprint.nodes && blueprint.nodes.length > 0) {
      log(`Blueprint: ${blueprint.nodes.length} nodes, ${(blueprint.edges || []).length} edges`, taskId);
      const codeResult = await generateCode(blueprint, CLIENT_DIR, log, taskId);
      if (codeResult.ok && !codeResult.skipped) {
        log(`AI coding done: ${codeResult.filesWritten} files written`, taskId);
        await reportStatus(taskId, 'processing', { message: `AI 编码完成 (${codeResult.filesWritten} 文件)` });
      } else if (!codeResult.ok) {
        log('AI coding failed: ' + codeResult.error, taskId);
        await reportStatus(taskId, 'processing', { message: 'AI 编码失败，使用现有代码继续构建' });
      }
    } else {
      log('Empty or missing blueprint, skipping AI coding', taskId);
    }

    // === Step 3: Pre-build Patch ===
    await reportStatus(taskId, 'building', { message: '预处理 + Luna 构建中...' });

    // Clean old LunaTemp
    const lunaTempDir = path.join(CLIENT_DIR, 'LunaTemp');
    if (fs.existsSync(lunaTempDir)) {
      log('Cleaning old LunaTemp...', taskId);
      try { fs.rmSync(lunaTempDir, { recursive: true, force: true }); } catch (e) {
        log('Warning cleaning LunaTemp: ' + e.message, taskId);
      }
    }

    // Detect scenes and fix luna.json
    const scenes = detectScenes(CLIENT_DIR);
    if (scenes.length === 0) {
      await reportStatus(taskId, 'failed', { message: 'No scenes found in project' });
      return;
    }
    log(`Detected ${scenes.length} scene(s): ${scenes.join(', ')}`, taskId);

    fixLunaJson(CLIENT_DIR, scenes);
    generateExportAssets(CLIENT_DIR, scenes);
    log('Pre-build patch applied', taskId);

    // === Step 4: Luna Build ===
    const buildResult = await runBridgeBuild(CLIENT_DIR, log, taskId);
    if (!buildResult.ok) {
      await reportStatus(taskId, 'failed', { message: 'Luna build failed: ' + (buildResult.error || '').slice(0, 300) });
      return;
    }
    log(`Luna build OK in ${buildResult.buildTime}s`, taskId);

    // === Step 5: HTML Conversion (single-file per channel) ===
    await reportStatus(taskId, 'processing', { message: 'HTML 渠道转换中...' });
    const stage4Dir = path.join(CLIENT_DIR, 'LunaTemp', 'stage4', 'develop');
    const htmlOutputDir = path.join(WORK_DIR, taskId + '-html');
    try {
      const defaultChannels = ['appLovin'];
      const htmlResults = convertAndSave(stage4Dir, htmlOutputDir, {
        channels: defaultChannels,
        projectName: taskId
      });
      log(`HTML conversion done: ${htmlResults.length} channels, sizes: ${htmlResults.map(r => r.channel + '=' + r.size + 'KB').join(', ')}`, taskId);
    } catch (e) {
      log(`HTML conversion failed (non-fatal): ${e.message}`, taskId);
      // Non-fatal: still upload the multi-file zip
    }

    // === Step 6: Upload Build ===
    await reportStatus(taskId, 'processing', { message: '上传构建产物...' });
    const uploaded = await uploadBuild(taskId);
    if (!uploaded) {
      await reportStatus(taskId, 'failed', { message: 'Build upload failed' });
      return;
    }

    // === Step 7: Upload single-file HTMLs ===
    if (fs.existsSync(htmlOutputDir)) {
      await reportStatus(taskId, 'processing', { message: '上传渠道 HTML...' });
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
        // Cleanup
        try { fs.rmSync(htmlOutputDir, { recursive: true, force: true }); } catch (e) {}
      } catch (e) {
        log(`HTML upload failed (non-fatal): ${e.message}`, taskId);
      }
    }

    // === Step 8: Done → reviewing ===
    await reportStatus(taskId, 'reviewing', { message: `构建完成 (${buildResult.buildTime}s)，等待审核` });
    log('Task completed → reviewing', taskId);

  } catch (e) {
    log(`Task error: ${e.message}`, taskId);
    await reportStatus(taskId, 'failed', { message: 'Error: ' + e.message.slice(0, 300) });
  }
}

async function uploadBuild(taskId) {
  // Find build output — stage4/develop/index.html is the standard output
  const searchDirs = [
    path.join(CLIENT_DIR, 'LunaTemp', 'stage4', 'develop'),
    path.join(CLIENT_DIR, 'LunaTemp', 'package', 'default'),
    path.join(CLIENT_DIR, 'LunaTemp', 'package'),
  ];

  let buildDir = null;
  for (const d of searchDirs) {
    if (fs.existsSync(path.join(d, 'index.html'))) {
      buildDir = d;
      break;
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
  await reportStatus(taskId, 'processing', { message: 'SVN commit 中...' });

  if (!fs.existsSync(FIXED_PROJECT_DIR)) {
    await reportStatus(taskId, 'failed', { message: 'Working copy not found' });
    return;
  }

  // Add new files, commit
  runCmd(`svn add --force . ${SVN_FLAGS}`, FIXED_PROJECT_DIR);

  // Ignore build artifacts
  const ignoreList = ['Library', 'Temp', 'LunaTemp', 'obj', 'Logs', 'UserSettings', '.vs'];
  for (const dir of ignoreList) {
    const dirPath = path.join(FIXED_PROJECT_DIR, 'Client', dir);
    if (fs.existsSync(dirPath)) {
      runCmd(`svn revert --depth infinity "Client/${dir}" 2>nul`, FIXED_PROJECT_DIR);
    }
  }

  const commitMsg = `[AutoCoding] ${task.projectName || 'Project'} - ${taskId}`;
  const result = runCmd(`svn commit -m "${commitMsg}" ${SVN_FLAGS}`, FIXED_PROJECT_DIR, 600000);

  if (!result.ok) {
    log(`SVN commit failed: ${result.output}`, taskId);
    await reportStatus(taskId, 'failed', { message: 'SVN commit failed: ' + result.output.slice(0, 200) });
    return;
  }

  let svnRevision = null;
  const revMatch = result.output.match(/Committed revision (\d+)/);
  if (revMatch) svnRevision = parseInt(revMatch[1]);

  log(`SVN commit OK: r${svnRevision}`, taskId);

  // Callback to Blueprint Editor
  try {
    await apiRequest('POST', `/api/projects/${taskId}/committed`, { svnRevision, message: commitMsg });
    log('Committed callback OK', taskId);
  } catch (e) {
    log(`Committed callback failed: ${e.message}`, taskId);
  }

  await reportStatus(taskId, 'committed', { message: `SVN committed r${svnRevision}` });
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
    activeTasks.set(task.taskId, { task, startedAt: Date.now() });

    processTask(task)
      .catch(e => log(`Unhandled error: ${e.message}`, task.taskId))
      .finally(() => {
        activeTasks.delete(task.taskId);
        log(`Task done. Slots: ${activeTasks.size}/${MAX_CONCURRENT}`, task.taskId);
      });
  } catch (e) {
    // Poll error — server might be down, silently retry
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
log(`Worker v4 starting | ID: ${WORKER_ID} | Server: ${BASE_URL}`);
log(`Work dir: ${FIXED_PROJECT_DIR} | Luna: ${LUNA_DIR}`);

poll();
setInterval(poll, POLL_INTERVAL);
setInterval(heartbeat, HEARTBEAT_INTERVAL);
heartbeat();
