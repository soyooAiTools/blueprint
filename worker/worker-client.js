// Worker Client v4 — Poll from Blueprint Editor API, build via Luna jake pipeline
// Flow: Poll task → SVN update → Pre-build patch → Luna build → Upload zip → Report status
// Also handles: fix_needed (re-build), commit_needed (SVN commit + cleanup)

// 加载 .env（所有环境变量的唯一来源，子进程也自动继承）
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const http = require('http');
const https = require('https');
const { exec, execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { detectScenes, fixLunaJson, generateExportAssets, injectMaterialSourceAll, cleanScene } = require('./worker-patch.js');
const { runBridgeBuild, bridgeRequest } = require('./worker-bridge-build.js');
const { generateCode } = require('./worker-coder.js');
const { convertAndSave } = require('./worker-html-converter.js');
const { patchLunaBuild } = require('./worker-luna-patch.js');

// Cocos modules (optional — loaded dynamically to avoid crash if not present)
let cocosPatch, cocosBuild, cocosHtmlConverter;
try {
  cocosPatch = require('../worker-cocos/worker-patch.js');
  cocosBuild = require('../worker-cocos/worker-cocos-build.js');
  cocosHtmlConverter = require('../worker-cocos/worker-html-converter.js');
} catch (e) {
  // Cocos modules not available — cocos tasks will fail gracefully
}

// ============ Config ============
const WORKER_ID = process.env.WORKER_ID || 'workerA';
const BASE_URL = process.env.BASE_URL || 'https://playcools.top/blueprint';
const POLL_INTERVAL = 8000;       // 8s between polls
const HEARTBEAT_INTERVAL = 30000; // 30s heartbeat
const WORK_DIR = 'D:\\work';
const FIXED_PROJECT_DIR = path.join(WORK_DIR, 'test-luna'); // Fixed SVN working copy (Unity)
const CLIENT_DIR = path.join(FIXED_PROJECT_DIR, 'Client');
const COCOS_PROJECT_DIR = path.join(WORK_DIR, 'test-cocos'); // Fixed SVN working copy (Cocos)
const SVN_USER = 'openclaw';
const SVN_PASS = 'openclaw';
const SVN_FLAGS = `--non-interactive --no-auth-cache --username ${SVN_USER} --password ${SVN_PASS}`;
const MAX_CONCURRENT = 1; // Only 1 task at a time (Unity can only open 1 project)
const LUNA_DIR = 'D:\\Luna';

// ============ Task Notification Webhook ============
const NOTIFY_URL = process.env.NOTIFY_URL || 'https://playcools.top/notify/webhook';
// Feishu DM notifications via feishu-notify.js (App Bot API, no webhook needed)

function notifyEvent(taskId, event, message, extra) {
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
  feishuNotify.send(taskId, event, message, extra).catch(() => {});
}

// ============ Resilience Config ============
const MAX_TASK_RETRIES = 3;
const RETRY_DELAYS = [30, 60, 120];
const MAX_CUA_ROUNDS = 20; // Keep trying until pass. Nick: "不接受几轮没好就直接报终止"
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
        notifyEvent(taskId, 'retry', `${label} 失败，自动重试 (${i + 1}/${retries})`,
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

// [REMOVED] Screenshot review on Main ECS — replaced by CUA verification on Worker (Step 5.5b)

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
        await reportStatus(taskId, 'processing', { message: '上传构建产物 (CUA已通过，重试上传)...' });
        const uploaded = await uploadBuild(taskId);
        if (!uploaded) {
          await reportStatus(taskId, 'failed', { message: 'Build upload failed (retry)' });
          throw new TaskFailedError('Build upload failed (retry)');
        }
        await reportStatus(taskId, 'completed', { message: 'CUA已通过，构建上传完成' });
        log('CUA resume: upload retry succeeded', taskId);
        throw new TaskFailedError('Task failed');
      }

      log('CUA resume: previous CUA did not pass, re-running CUA verification', taskId);
      await reportStatus(taskId, 'processing', { message: 'CUA断点续跑 (跳过编码+构建)...' });

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

      for (let cuaRound = 1; cuaRound <= MAX_CUA_ROUNDS; cuaRound++) {
        try {
          const { runCUAVerification } = require('./worker-cua-verify.js');
          await reportStatus(taskId, 'processing', { 
            message: `CUA断点续跑 - GPT-5.4 操控验证中... (第${cuaRound}/${MAX_CUA_ROUNDS}轮)` 
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

          log(`CUA resume: FAILED round ${cuaRound}/${MAX_CUA_ROUNDS}, ${cuaResult.issues.length} issues`, taskId);
          cuaResult.issues.forEach(issue => log(`  - ${issue}`, taskId));

          if (cuaRound >= MAX_CUA_ROUNDS) {
            await reportStatus(taskId, 'failed', { 
              message: 'CUA蓝图流程验证' + MAX_CUA_ROUNDS + '轮后未通过: ' + cuaResult.issues.slice(0, 2).join('; ').slice(0, 200)
            });
            throw new TaskFailedError('CUA verification failed after ' + MAX_CUA_ROUNDS + ' rounds');
          }

          // Fix cycle: re-code with CUA feedback, rebuild, retry
          log(`CUA resume: round ${cuaRound} failed, fix cycle...`, taskId);
          await reportStatus(taskId, 'processing', { message: `CUA第${cuaRound}轮不通过，AI 重新编码修复中...` });

          const cuaFeedbackText = 'CUA按蓝图流程操控验证未通过:\n' + cuaResult.issues.join('\n') + '\n\n请修改代码确保蓝图流程走通。';
          try {
            await apiRequest('POST', '/api/projects/' + taskId + '/feedback', 
              JSON.stringify({ text: cuaFeedbackText, source: 'cua-resume-round-' + cuaRound }),
              false, { 'Content-Type': 'application/json' });
          } catch(fbErr) {}

          if (cuaBlueprint && cuaBlueprint.nodes) {
            // Inject CUA feedback into blueprint so generateCode sees it and uses INCREMENTAL FIX mode
            if (!cuaBlueprint.feedbackHistory) cuaBlueprint.feedbackHistory = [];
            cuaBlueprint.feedbackHistory.push({
              data: { text: cuaFeedbackText },
              source: 'cua-resume-round-' + cuaRound,
              status: 'pending',
              timestamp: Date.now()
            });
            log(`CUA resume: injected feedback into blueprint (${cuaBlueprint.feedbackHistory.length} entries) → INCREMENTAL FIX`, taskId);

            const fixResult = await generateCode(cuaBlueprint, CLIENT_DIR, log, taskId, 'unity');
            if (!fixResult.ok) {
              await reportStatus(taskId, 'failed', { message: 'CUA fix re-code failed: ' + (fixResult.error || '').slice(0, 200) });
              throw new TaskFailedError('CUA fix re-code failed: ' + (fixResult.error || '').slice(0, 200));
            }
            log(`CUA resume fix re-code done: ${fixResult.filesWritten} files`, taskId);
          }

          // Rebuild
          await reportStatus(taskId, 'building', { message: `CUA修复后重新构建中...` });
          const ltDir = path.join(CLIENT_DIR, 'LunaTemp');
          for (const sub of ['stage2', 'stage3', 'stage4']) {
            const sd = path.join(ltDir, sub);
            if (fs.existsSync(sd)) try { fs.rmSync(sd, { recursive: true, force: true }); } catch(e) {}
          }
          if (cleanScene(CLIENT_DIR)) log('Scene re-cleaned for CUA fix', taskId);
          const fixScenes = detectScenes(CLIENT_DIR);
          fixLunaJson(CLIENT_DIR, fixScenes);
          generateExportAssets(CLIENT_DIR, fixScenes);

          const fixBuild = await runBridgeBuild(CLIENT_DIR, log, taskId);
          if (!fixBuild.ok) {
            await reportStatus(taskId, 'failed', { message: 'CUA fix rebuild failed: ' + (fixBuild.error || '').slice(0, 300) });
            throw new TaskFailedError('CUA fix rebuild failed: ' + (fixBuild.error || '').slice(0, 300));
          }
          log(`CUA resume fix rebuild OK in ${fixBuild.buildTime}s`, taskId);

          try {
            convertAndSave(path.join(CLIENT_DIR, 'LunaTemp', 'stage4', 'develop'), 
              path.join(WORK_DIR, taskId + '-html'), { channels: ['appLovin'], projectName: taskId });
          } catch(e) {}

        } catch (cuaErr) {
          log(`CUA resume error round ${cuaRound}: ${cuaErr.message}`, taskId);
          await reportStatus(taskId, 'failed', { message: 'CUA verification crashed: ' + cuaErr.message.slice(0, 200) });
          throw new TaskFailedError('CUA verification crashed: ' + cuaErr.message.slice(0, 200));
        }
      }

      if (cuaPassed) {
        // Jump to upload
        await reportStatus(taskId, 'processing', { message: '上传构建产物...' });
        const uploaded = await uploadBuild(taskId);
        if (!uploaded) {
          await reportStatus(taskId, 'failed', { message: 'Build upload failed' });
          throw new TaskFailedError('Build upload failed');
        }
        await reportStatus(taskId, 'completed', { message: 'CUA断点续跑完成，构建已上传' });
        log('CUA resume completed successfully', taskId);
        throw new TaskFailedError('Task failed');
      }
      return;
    }

    // === Step 1: SVN Update ===
    await reportStatus(taskId, 'processing', { message: 'SVN update 中...' });

    if (!fs.existsSync(FIXED_PROJECT_DIR)) {
      const svnUrl = task.svnUrl || 'svn://47.101.191.213:3690/test0213';
      log('SVN checkout (first time)...', taskId);
      const checkout = runCmd(`svn checkout ${SVN_FLAGS} "${svnUrl}" "${FIXED_PROJECT_DIR}"`, undefined, 600000);
      if (!checkout.ok) {
        await reportStatus(taskId, 'failed', { message: 'SVN checkout failed: ' + checkout.output.slice(0, 300) });
        throw new TaskFailedError('SVN checkout failed: ' + checkout.output.slice(0, 300));
      }
    } else {
      const update = runCmd(`svn update ${SVN_FLAGS}`, FIXED_PROJECT_DIR, 120000);
      if (!update.ok) {
        await reportStatus(taskId, 'failed', { message: 'SVN update failed: ' + update.output.slice(0, 300) });
        throw new TaskFailedError('SVN update failed: ' + update.output.slice(0, 300));
      }
      log('SVN update OK: ' + update.output.split('\n').pop(), taskId);
    }

    if (!fs.existsSync(CLIENT_DIR)) {
      await reportStatus(taskId, 'failed', { message: 'Client directory not found after SVN update' });
      throw new TaskFailedError('Client directory not found after SVN update');
    }

    // === Step 1.5: Clean old AI-generated scripts from Assets/Scripts ===
    // SVN update restores deleted files; we must clean before AI coding
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
    await reportStatus(taskId, 'processing', { message: 'AI 编码中...' });
    let blueprint = null;
    for (let bpRetry = 0; bpRetry < 3; bpRetry++) {
      try {
        blueprint = await apiRequest('GET', `/api/tasks/${taskId}/blueprint`);
        if (blueprint && blueprint.nodes && blueprint.nodes.length > 0) break;
        log('Blueprint empty/missing, retry ' + (bpRetry + 1) + '/3...', taskId);
        await new Promise(r => setTimeout(r, 5000));
      } catch (e) {
        log('Failed to fetch blueprint (retry ' + (bpRetry + 1) + '): ' + e.message, taskId);
        await new Promise(r => setTimeout(r, 5000));
      }
    }

    if (blueprint && blueprint.nodes && blueprint.nodes.length > 0) {
      log(`Blueprint: ${blueprint.nodes.length} nodes, ${(blueprint.edges || []).length} edges`, taskId);
      const codeResult = await generateCode(blueprint, CLIENT_DIR, log, taskId, 'unity');
      if (codeResult.ok && !codeResult.skipped) {
        log(`AI coding done: ${codeResult.filesWritten} files written`, taskId);
        notifyEvent(taskId, 'coding_done', `AI 编码完成 (${codeResult.filesWritten} 文件)`, { projectName: task.projectName });
        await reportStatus(taskId, 'processing', { message: `AI 编码完成 (${codeResult.filesWritten} 文件)` });
      } else if (!codeResult.ok) {
        log('AI coding failed: ' + codeResult.error + ', retrying...', taskId);
        await reportStatus(taskId, 'processing', { message: 'AI 编码失败，重试中...' });
        // Retry once
        const retryResult = await generateCode(blueprint, CLIENT_DIR, log, taskId, 'unity');
        if (retryResult.ok && !retryResult.skipped) {
          log(`AI coding retry done: ${retryResult.filesWritten} files written`, taskId);
          await reportStatus(taskId, 'processing', { message: `AI 编码完成 (${retryResult.filesWritten} 文件, 重试)` });
        } else {
          log('AI coding retry also failed: ' + (retryResult.error || 'unknown'), taskId);
          await reportStatus(taskId, 'error', { message: 'AI 编码失败: ' + (codeResult.error || 'unknown') });
          throw new Error('AI coding failed after retry: ' + (retryResult.error || codeResult.error));
        }
      }
    } else {
      log('Empty or missing blueprint, skipping AI coding', taskId);
    }

    // === Step 3: Pre-build Patch ===
    await reportStatus(taskId, 'building', { message: '预处理 + Luna 构建中...' });

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
    if (cleanScene(CLIENT_DIR)) {
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
    // NOTE: scene injection disabled — causes Luna jake build to hang
    // Material solution is now code-only (AI uses Object.FindObjectOfType<Renderer>())
    log('Pre-build patch applied', taskId);

    // === Step 4: Luna Build ===
    const buildResult = await runBridgeBuild(CLIENT_DIR, log, taskId);
    if (!buildResult.ok) {
      await reportStatus(taskId, 'failed', { message: 'Luna build failed: ' + (buildResult.error || '').slice(0, 300) });
      throw new TaskFailedError('Luna build failed: ' + (buildResult.error || '').slice(0, 300));
    }
    log(`Luna build OK in ${buildResult.buildTime}s`, taskId);

    // === Step 5: HTML Conversion ===
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
    }

    // === Step 5.5a: Luna Runtime Compatibility Patches ===
    // Fix known issues: new Event() in headless Chromium, isActiveAndEnabled null ref
    try {
      const patchResult = patchLunaBuild(stage4Dir, log, taskId);
      if (patchResult.patched) {
        log(`Luna patches applied: ${patchResult.details.join('; ')}`, taskId);
      }
    } catch (patchErr) {
      log(`Luna patch error (non-fatal): ${patchErr.message}`, taskId);
    }

    // === Step 5.6: Preview Health Check + Self-Heal Loop ===
    // 白屏/黑屏/卡进度条/JS崩溃 → 反馈给 AI 增量修复 → 重新构建 → 再检查，最多 3 轮
    {
      const { runPreviewCheck } = require('./worker-preview-check.js');
      const MAX_PREVIEW_FIX_ROUNDS = 3;

      for (let previewRound = 1; previewRound <= MAX_PREVIEW_FIX_ROUNDS; previewRound++) {
        const cuaStage4Pre = path.join(CLIENT_DIR, 'LunaTemp', 'stage4', 'develop');
        const previewResult = await runPreviewCheck(cuaStage4Pre, taskId, log);

        if (previewResult.ok) {
          log(`[preview-check] PASSED (round ${previewRound}) - game loaded successfully`, taskId);
          notifyEvent(taskId, 'preview_check', `✅ 预览检查通过，进入 CUA 验证`, { projectName: task.projectName });
          break;
        }

        log(`[preview-check] FAILED round ${previewRound}/${MAX_PREVIEW_FIX_ROUNDS}: ${previewResult.error}`, taskId);
        if (previewResult.consoleErrors && previewResult.consoleErrors.length > 0) {
          log(`[preview-check] JS errors: ${previewResult.consoleErrors.slice(0, 5).join(' | ').slice(0, 500)}`, taskId);
        }

        if (previewRound >= MAX_PREVIEW_FIX_ROUNDS) {
          notifyEvent(taskId, 'compile_error', `❌ 预览检查 ${MAX_PREVIEW_FIX_ROUNDS} 轮失败: ${(previewResult.error||'').slice(0,100)}`, { projectName: task.projectName });
          throw new TaskFailedError(`Preview health check failed after ${MAX_PREVIEW_FIX_ROUNDS} fix rounds: ${previewResult.error}`);
        }

        // === Self-heal: feed error back to AI coder for targeted fix ===
        log(`[preview-check] Self-healing: feeding error to AI for fix (round ${previewRound})...`, taskId);
        await reportStatus(taskId, 'processing', {
          message: `预览检查失败(${previewResult.error?.slice(0, 50)})，AI 自修复中... (第${previewRound}/${MAX_PREVIEW_FIX_ROUNDS}轮)`
        });

        // Build feedback for AI coder
        const previewFeedback = {
          type: 'preview_health_check_failure',
          round: previewRound,
          error: previewResult.error,
          consoleErrors: (previewResult.consoleErrors || []).slice(0, 10),
          details: previewResult.details || {},
          instruction: `游戏构建后预览检查失败。问题: ${previewResult.error}。` +
            (previewResult.consoleErrors?.length ? `浏览器控制台错误: ${previewResult.consoleErrors.slice(0, 5).join('; ')}。` : '') +
            `请检查并修复代码中导致此问题的原因。常见原因: Start()中有未捕获异常导致游戏无法初始化、死循环阻塞主线程、引用了不存在的资源、UI元素未正确创建。` +
            `修复时保留已有代码结构，只修改导致问题的部分。`
        };

        // Inject feedback into blueprint for incremental fix
        if (!blueprint.feedbackHistory) blueprint.feedbackHistory = [];
        blueprint.feedbackHistory.push(previewFeedback);

        // Re-generate code with feedback
        const fixResult = await generateCode(blueprint, CLIENT_DIR, log, taskId, 'unity');
        if (!fixResult || !fixResult.success) {
          log(`[preview-check] AI fix failed, skipping to next round`, taskId);
          continue;
        }

        // Re-build
        log(`[preview-check] AI fix done, rebuilding...`, taskId);
        const fixBuild = await runBridgeBuild(CLIENT_DIR, log, taskId);
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
    }

    // === Step 5.7: CUA Verification Loop (GPT-5.4 操控验证 → 不通过则修复重试) ===
    let cuaPassed = false;
    
    for (let cuaRound = 1; cuaRound <= MAX_CUA_ROUNDS; cuaRound++) {
      try {
        const { runCUAVerification } = require('./worker-cua-verify.js');
        await reportStatus(taskId, 'processing', { 
          message: `GPT-5.4 CUA 操控验证中... (第${cuaRound}/${MAX_CUA_ROUNDS}轮)` 
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
          log(`CUA verification PASSED (round ${cuaRound}): 蓝图流程全部走通`, taskId);
          notifyEvent(taskId, 'cua_pass', `✅ CUA验证通过 (第${cuaRound}轮)! 蓝图流程全部走通`, { projectName: task.projectName });
          cuaPassed = true;
          break;
        }

        // CUA failed — log issues
        log(`CUA verification FAILED round ${cuaRound}/${MAX_CUA_ROUNDS}, ${cuaResult.issues.length} issues`, taskId);
        cuaResult.issues.forEach(issue => log(`  - ${issue}`, taskId));
        // Calculate coverage stats for notification
        var coveredCount = 0, totalSteps = 0;
        if (cuaResult.scriptCoverage) {
          totalSteps = cuaResult.scriptCoverage.length;
          coveredCount = cuaResult.scriptCoverage.filter(function(s) { return s.covered; }).length;
        }
        var coverageStr = totalSteps > 0 ? ` | 分镜覆盖: ${coveredCount}/${totalSteps}` : '';
        // Build AI fix strategy summary for notification
        var fixStrategy = '';
        if (cuaResult.issues && cuaResult.issues.length > 0) {
          var issueTypes = cuaResult.issues.map(function(i) { return i.split(']')[0].replace('[','').trim(); });
          var hasNoCoverage = issueTypes.indexOf('uncovered') >= 0 || cuaResult.issues.some(function(i) { return i.indexOf('not reached') >= 0; });
          var hasStuck = cuaResult.issues.some(function(i) { return i.indexOf('stuck') >= 0 || i.indexOf('卡住') >= 0; });
          
          fixStrategy = '\n\n🔧 AI修复思路:';
          if (hasNoCoverage) {
            var covPct = totalSteps > 0 ? Math.round(coveredCount / totalSteps * 100) : 0;
            fixStrategy += '\n• 分镜覆盖' + covPct + '% → 需要加强shot转场触发逻辑';
            if (coveredCount === 0) fixStrategy += '（0覆盖=场景可能空白/物体不可见/相机位置错误）';
          }
          if (hasStuck) fixStrategy += '\n• 游戏卡住 → 检查状态机/Update循环是否正常推进';
          // Include CUA's last observation
          if (cuaResult.report && cuaResult.report.history && cuaResult.report.history.length > 0) {
            var lastObs = cuaResult.report.history[cuaResult.report.history.length - 1];
            if (lastObs.thinking) fixStrategy += '\n• CUA最后观察: ' + (lastObs.thinking || '').slice(0, 150);
          }
          // Include specific uncovered shots
          if (cuaResult.scriptCoverage) {
            var missed = cuaResult.scriptCoverage.filter(function(s) { return !s.covered; }).map(function(s) { return s.step; });
            if (missed.length > 0 && missed.length <= 10) fixStrategy += '\n• 未覆盖: ' + missed.slice(0, 5).join(', ') + (missed.length > 5 ? '...' : '');
          }
        }
        notifyEvent(taskId, 'cua_round', `CUA第${cuaRound}/${MAX_CUA_ROUNDS}轮未通过${coverageStr}\n问题: ${cuaResult.issues.slice(0,3).join('\n').slice(0,200)}${fixStrategy}`, { projectName: task.projectName });

        if (cuaRound >= MAX_CUA_ROUNDS) {
          // Max retries exhausted — fail the task with details
          const feedbackText = 'CUA蓝图流程验证不通过 (' + MAX_CUA_ROUNDS + '轮修复后仍有问题):\n' + cuaResult.issues.join('\n');
          try {
            await apiRequest('POST', '/api/projects/' + taskId + '/feedback', 
              JSON.stringify({ text: feedbackText, source: 'cua-auto' }),
              false, { 'Content-Type': 'application/json' });
          } catch(fbErr) {
            log('CUA feedback submit failed: ' + fbErr.message, taskId);
          }
          await reportStatus(taskId, 'failed', { 
            message: 'CUA蓝图流程验证' + MAX_CUA_ROUNDS + '轮后未通过: ' + cuaResult.issues.slice(0, 2).join('; ').slice(0, 200),
            cuaReview: { issues: cuaResult.issues.length, rounds: cuaRound, details: cuaResult.issues }
          });
          throw new TaskFailedError('CUA verification failed after ' + MAX_CUA_ROUNDS + ' rounds');
        }

        // Not final round — use CUA feedback to re-code and rebuild
        log(`CUA round ${cuaRound} failed, starting fix cycle...`, taskId);
        
        // Build rich feedback with visual context so AI knows WHAT the screen looks like
        let visualContext = '';
        if (cuaResult.report) {
          if (cuaResult.report.summary) {
            visualContext += '\n\n## CUA观察到的画面:\n' + cuaResult.report.summary;
          }
          if (cuaResult.report.history && cuaResult.report.history.length > 0) {
            const lastRound = cuaResult.report.history[cuaResult.report.history.length - 1];
            if (lastRound.thinking) visualContext += '\n\nGPT最后一轮观察: ' + (lastRound.thinking || '').slice(0, 500);
          }
          // Detect uniform/empty scene from score vs coverage mismatch
          const allUncovered = cuaResult.report.scriptCoverage && cuaResult.report.scriptCoverage.every(s => !s.covered);
          if (allUncovered) {
            visualContext += '\n\n⚠️ 严重问题: 所有分镜头都未覆盖到 (0/' + (cuaResult.report.scriptCoverage || []).length + ')。这通常意味着:\n'
              + '1. 场景物体不可见（所有物体颜色相同，和背景融为一体）\n'
              + '2. 相机位置/朝向错误，看不到物体\n'
              + '3. 物体创建失败（GFM_Create.Obj()返回null）\n'
              + '请检查: 每种物体是否有不同颜色？相机是否对准了场景中心？_mainCam.backgroundColor是否设为天蓝色(0.6f,0.8f,1f)？';
          }
        }
        
        const cuaFeedbackText = 'CUA按蓝图流程操控验证未通过，以下问题必须修复才能让流程走通:\n' + cuaResult.issues.join('\n') + visualContext + '\n\n请针对以上问题修改代码，确保蓝图描述的所有场景能按顺序操作通过，最终到达CTA。';

        // Re-code with CUA feedback as context
        await reportStatus(taskId, 'processing', { message: `CUA第${cuaRound}轮不通过，AI 重新编码修复中...` });
        
        // Inject CUA feedback into the task's feedback history for AI coder to see
        try {
          await apiRequest('POST', '/api/projects/' + taskId + '/feedback', 
            JSON.stringify({ text: cuaFeedbackText, source: 'cua-auto-round-' + cuaRound }),
            false, { 'Content-Type': 'application/json' });
        } catch(fbErr) {
          log('CUA feedback inject failed: ' + fbErr.message, taskId);
        }

        // Re-run AI coding (incremental fix with CUA feedback)
        let fixBlueprint = null;
        try { fixBlueprint = await apiRequest('GET', `/api/tasks/${taskId}/blueprint`); } catch(e) {}
        
        if (fixBlueprint && fixBlueprint.nodes) {
          // Ensure feedbackHistory is populated so generateCode uses INCREMENTAL FIX mode
          if (!fixBlueprint.feedbackHistory || fixBlueprint.feedbackHistory.length === 0) {
            fixBlueprint.feedbackHistory = [{
              data: { text: cuaFeedbackText },
              source: 'cua-auto-round-' + cuaRound,
              status: 'pending',
              timestamp: Date.now()
            }];
            log(`CUA fix: feedbackHistory was empty, injected CUA feedback → INCREMENTAL FIX`, taskId);
          }

          const fixResult = await generateCode(fixBlueprint, CLIENT_DIR, log, taskId, 'unity');
          if (fixResult.ok) {
            log(`CUA fix re-code done: ${fixResult.filesWritten} files written`, taskId);
          } else {
            log(`CUA fix re-code failed: ${fixResult.error}`, taskId);
            await reportStatus(taskId, 'failed', { message: 'CUA fix re-code failed: ' + (fixResult.error || '').slice(0, 200) });
            throw new TaskFailedError('CUA fix re-code failed: ' + (fixResult.error || '').slice(0, 200));
          }
        }

        // Re-build
        await reportStatus(taskId, 'building', { message: `CUA修复后重新构建中... (第${cuaRound + 1}轮验证)` });
        
        // Clean stage2-4 for rebuild
        const ltDir = path.join(CLIENT_DIR, 'LunaTemp');
        for (const sub of ['stage2', 'stage3', 'stage4']) {
          const sd = path.join(ltDir, sub);
          if (fs.existsSync(sd)) try { fs.rmSync(sd, { recursive: true, force: true }); } catch(e) {}
        }

        if (cleanScene(CLIENT_DIR)) log('Scene re-cleaned for CUA fix rebuild', taskId);
        const fixScenes = detectScenes(CLIENT_DIR);
        fixLunaJson(CLIENT_DIR, fixScenes);
        generateExportAssets(CLIENT_DIR, fixScenes);

        const fixBuild = await runBridgeBuild(CLIENT_DIR, log, taskId);
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
          convertAndSave(fixStage4, fixHtmlDir, { channels: ['appLovin'], projectName: taskId });
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
    await reportStatus(taskId, 'processing', { message: '上传构建产物...' });
    const uploaded = await uploadBuild(taskId);
    if (!uploaded) {
      await reportStatus(taskId, 'failed', { message: 'Build upload failed' });
      throw new TaskFailedError('Build upload failed');
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
        try { fs.rmSync(htmlOutputDir, { recursive: true, force: true }); } catch (e) {}
      } catch (e) {
        log(`HTML upload failed (non-fatal): ${e.message}`, taskId);
      }
    }

    // === Step 8: Done (CUA verification already done in Step 5.5b) ===
    await reportStatus(taskId, 'reviewing', { message: `构建完成 (${buildResult.buildTime}s)，CUA验证通过，等待人工审核` });
    notifyEvent(taskId, 'done', `🎉 任务完成！构建 ${buildResult.buildTime}s，CUA 验证通过，等待人工审核`, { projectName: task.projectName });
    log('Task completed → reviewing', taskId);

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
    await reportStatus(taskId, 'processing', { message: 'AI 编码中 (Cocos)...' });
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
        await reportStatus(taskId, 'processing', { message: `AI 编码完成 (${codeResult.filesWritten} 文件)` });
      } else if (!codeResult.ok) {
        log('AI coding failed: ' + codeResult.error + ', retrying...', taskId);
        await reportStatus(taskId, 'processing', { message: 'AI 编码失败，重试中...' });
        const retryResult = await generateCode(blueprint, COCOS_PROJECT_DIR, log, taskId, 'cocos');
        if (retryResult.ok && !retryResult.skipped) {
          log(`AI coding retry done: ${retryResult.filesWritten} files`, taskId);
        } else {
          await reportStatus(taskId, 'error', { message: 'AI 编码失败: ' + (codeResult.error || 'unknown') });
          throw new Error('AI coding failed after retry: ' + (retryResult.error || codeResult.error));
        }
      }
    }

    // === Step 3: Pre-build + Cocos Build ===
    await reportStatus(taskId, 'building', { message: 'Cocos 构建中...' });

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
    await reportStatus(taskId, 'processing', { message: 'HTML 渠道转换中...' });
    const htmlOutputDir = path.join(WORK_DIR, taskId + '-html');
    const htmlConverter = cocosHtmlConverter || { convertAndSave };
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
    await reportStatus(taskId, 'processing', { message: '上传 HTML...' });
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

    await reportStatus(taskId, 'reviewing', { message: `Cocos 构建完成 (${buildResult.buildTime}s)，等待审核` });
    log('Task completed → reviewing (Cocos)', taskId);

  } catch (e) {
    log(`Task error (Cocos): ${e.message}`, taskId);
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
  const engine = task.engine || 'unity';
  const isCocos = engine === 'cocos';
  const projectDir = isCocos ? COCOS_PROJECT_DIR : FIXED_PROJECT_DIR;

  await reportStatus(taskId, 'processing', { message: 'SVN commit 中...' });

  if (!fs.existsSync(projectDir)) {
    await reportStatus(taskId, 'failed', { message: 'Working copy not found' });
    throw new TaskFailedError('Working copy not found');
  }

  // === Delete cache directories before commit ===
  const cacheList = isCocos
    ? ['build', 'temp', 'local', 'library', 'node_modules', '.vs']
    : ['Library', 'Temp', 'LunaTemp', 'obj', 'Logs', 'UserSettings', '.vs'];
  const cachePrefix = isCocos ? '' : 'Client';
  for (const dir of cacheList) {
    const dirPath = cachePrefix ? path.join(projectDir, cachePrefix, dir) : path.join(projectDir, dir);
    const svnRelPath = cachePrefix ? `${cachePrefix}/${dir}` : dir;
    if (fs.existsSync(dirPath)) {
      log(`Deleting cache: ${svnRelPath}`, taskId);
      try {
        runCmd(`svn revert --depth infinity "${svnRelPath}" ${SVN_FLAGS}`, projectDir);
        fs.rmSync(dirPath, { recursive: true, force: true });
        log(`Deleted cache: ${svnRelPath}`, taskId);
      } catch (e) {
        log(`Warning: failed to delete ${svnRelPath}: ${e.message}`, taskId);
      }
    }
  }
  await reportStatus(taskId, 'processing', { message: '缓存已清理，准备提交...' });

  runCmd(`svn add --force . ${SVN_FLAGS}`, projectDir);

  for (const dir of cacheList) {
    const dirPath = cachePrefix ? path.join(projectDir, cachePrefix, dir) : path.join(projectDir, dir);
    const svnRelPath = cachePrefix ? `${cachePrefix}/${dir}` : dir;
    if (fs.existsSync(dirPath)) {
      runCmd(`svn revert --depth infinity "${svnRelPath}" 2>nul`, projectDir);
    }
  }

  const commitMsg = `[AutoCoding] ${task.projectName || 'Project'} - ${taskId}`;
  const result = runCmd(`svn commit -m "${commitMsg}" ${SVN_FLAGS}`, projectDir, 600000);

  if (!result.ok) {
    log(`SVN commit failed: ${result.output}`, taskId);
    await reportStatus(taskId, 'failed', { message: 'SVN commit failed: ' + result.output.slice(0, 200) });
    throw new TaskFailedError('SVN commit failed: ' + result.output.slice(0, 200));
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
    activeTasks.set(task.taskId, { task, startedAt: Date.now(), projectName: task.projectName });
    notifyEvent(task.taskId, 'task_started', `开始处理: ${task.projectName || task.taskId}`, { projectName: task.projectName });

    // Task execution with auto-retry + global timeout
    const runWithRetry = async () => {
      const taskTimeout = setTimeout(() => {
        log(`⏰ Task timeout (${TASK_TIMEOUT_MS/60000}min)`, task.taskId);
        notifyEvent(task.taskId, 'timeout', `任务超时 (${TASK_TIMEOUT_MS/60000}分钟)`, { projectName: task.projectName });
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
            `任务失败，${delay/1000}秒后自动重试 (${retries + 1}/${MAX_TASK_RETRIES}): ${e.message.slice(0, 100)}`,
            { projectName: task.projectName });
          await new Promise(r => setTimeout(r, delay));
          // Clean CUA cache so retry goes full path (not resume)
          try {
            const cuaDir = path.join(__dirname, 'cua-results');
            ['-cua.log', '-report.json'].forEach(suf => {
              const f = path.join(cuaDir, task.taskId + suf);
              if (fs.existsSync(f)) fs.unlinkSync(f);
            });
            log('Cleared CUA cache for fresh retry', task.taskId);
          } catch(ce) {}
          await processTask(task);
        } else {
          throw e;
        }
      } finally {
        clearTimeout(taskTimeout);
      }
    };
    runWithRetry()
      .catch(e => {
        log(`❌ Task failed permanently: ${e.message}`, task.taskId);
        notifyEvent(task.taskId, 'task_failed_final',
          `任务最终失败 (已重试${taskRetryCount.get(task.taskId) || 0}次): ${e.message.slice(0, 150)}`,
          { projectName: task.projectName });
      })
      .finally(() => {
        activeTasks.delete(task.taskId);
        taskRetryCount.delete(task.taskId);
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
log(`Worker v4 (unified) starting | ID: ${WORKER_ID} | Server: ${BASE_URL}`);
log(`Unity dir: ${FIXED_PROJECT_DIR} | Cocos dir: ${COCOS_PROJECT_DIR} | Luna: ${LUNA_DIR}`);

poll();
setInterval(poll, POLL_INTERVAL);
setInterval(heartbeat, HEARTBEAT_INTERVAL);
heartbeat();
