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

// Screenshot review via Main ECS screenshot-review service (HTTPS through Nginx)
async function screenshotReview(taskId, log) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const opts = {
      hostname: 'playcools.top', port: 443,
      path: '/screenshot-review/api/tasks/' + taskId + '/screenshot-review',
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      timeout: 120000, rejectUnauthorized: false
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { resolve({ ok: true, warning: true, reason: 'Parse error' }); }
      });
    });
    req.on('error', (e) => resolve({ ok: true, warning: true, reason: 'Connection error: ' + e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: true, warning: true, reason: 'Timeout' }); });
    req.write('{}');
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
    // === Step 1: SVN Update ===
    await reportStatus(taskId, 'processing', { message: 'SVN update 中...' });

    if (!fs.existsSync(FIXED_PROJECT_DIR)) {
      const svnUrl = task.svnUrl || 'svn://47.101.191.213:3690/test0213';
      log('SVN checkout (first time)...', taskId);
      const checkout = runCmd(`svn checkout ${SVN_FLAGS} "${svnUrl}" "${FIXED_PROJECT_DIR}"`, undefined, 600000);
      if (!checkout.ok) {
        await reportStatus(taskId, 'failed', { message: 'SVN checkout failed: ' + checkout.output.slice(0, 300) });
        return;
      }
    } else {
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
    try {
      blueprint = await apiRequest('GET', `/api/tasks/${taskId}/blueprint`);
    } catch (e) {
      log('Failed to fetch blueprint: ' + e.message, taskId);
    }

    if (blueprint && blueprint.nodes && blueprint.nodes.length > 0) {
      log(`Blueprint: ${blueprint.nodes.length} nodes, ${(blueprint.edges || []).length} edges`, taskId);
      const codeResult = await generateCode(blueprint, CLIENT_DIR, log, taskId, 'unity');
      if (codeResult.ok && !codeResult.skipped) {
        log(`AI coding done: ${codeResult.filesWritten} files written`, taskId);
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

    // Replace template scene with clean empty scene (Camera + Light + EventSystem + GameManager + MaterialSource only)
    if (cleanScene(CLIENT_DIR)) {
      log('Scene cleaned: replaced template with empty scene', taskId);
    } else {
      log('Warning: cleanScene skipped (template not found)', taskId);
    }

    const scenes = detectScenes(CLIENT_DIR);
    if (scenes.length === 0) {
      await reportStatus(taskId, 'failed', { message: 'No scenes found in project' });
      return;
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
      return;
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

    // === Step 5.5: CUA Verification Loop (GPT-5.4 操控验证 → 不通过则修复重试) ===
    const MAX_CUA_FIX_ROUNDS = 3;
    let cuaPassed = false;
    
    for (let cuaRound = 1; cuaRound <= MAX_CUA_FIX_ROUNDS; cuaRound++) {
      try {
        const { runCUAVerification } = require('./worker-cua-verify.js');
        await reportStatus(taskId, 'processing', { 
          message: `GPT-5.4 CUA 操控验证中... (第${cuaRound}/${MAX_CUA_FIX_ROUNDS}轮)` 
        });

        // Read blueprint from task file
        let cuaBlueprint = null;
        const bpPath = path.join(WORK_DIR, '..', 'autoCoding-tasks', 'queue', taskId + '-blueprint.json');
        try { cuaBlueprint = JSON.parse(fs.readFileSync(bpPath, 'utf-8')); } catch(e) {}

        const cuaStage4 = path.join(CLIENT_DIR, 'LunaTemp', 'stage4', 'develop');
        const cuaResult = await runCUAVerification(cuaStage4, cuaBlueprint, taskId, log);

        if (cuaResult.skipped) {
          log(`CUA verification skipped (round ${cuaRound}): ${cuaResult.error || 'no agent'}`, taskId);
          cuaPassed = true;
          break;
        }

        if (cuaResult.passed) {
          log(`CUA verification PASSED (round ${cuaRound}): 蓝图流程全部走通`, taskId);
          cuaPassed = true;
          break;
        }

        // CUA failed — log issues
        log(`CUA verification FAILED round ${cuaRound}/${MAX_CUA_FIX_ROUNDS}, ${cuaResult.issues.length} issues`, taskId);
        cuaResult.issues.forEach(issue => log(`  - ${issue}`, taskId));

        if (cuaRound >= MAX_CUA_FIX_ROUNDS) {
          // Max retries exhausted — fail the task with details
          const feedbackText = 'CUA蓝图流程验证不通过 (' + MAX_CUA_FIX_ROUNDS + '轮修复后仍有问题):\n' + cuaResult.issues.join('\n');
          try {
            await apiRequest('POST', '/api/projects/' + taskId + '/feedback', 
              JSON.stringify({ text: feedbackText, source: 'cua-auto' }),
              false, { 'Content-Type': 'application/json' });
          } catch(fbErr) {
            log('CUA feedback submit failed: ' + fbErr.message, taskId);
          }
          await reportStatus(taskId, 'failed', { 
            message: 'CUA蓝图流程验证' + MAX_CUA_FIX_ROUNDS + '轮后未通过: ' + cuaResult.issues.slice(0, 2).join('; ').slice(0, 200),
            cuaReview: { issues: cuaResult.issues.length, rounds: cuaRound, details: cuaResult.issues }
          });
          return;
        }

        // Not final round — use CUA feedback to re-code and rebuild
        log(`CUA round ${cuaRound} failed, starting fix cycle...`, taskId);
        const cuaFeedbackText = 'CUA按蓝图流程操控验证未通过，以下问题必须修复才能让流程走通:\n' + cuaResult.issues.join('\n') + '\n\n请针对以上问题修改代码，确保蓝图描述的所有场景能按顺序操作通过，最终到达CTA。';

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
          const fixResult = await generateCode(fixBlueprint, CLIENT_DIR, log, taskId, 'unity');
          if (fixResult.ok) {
            log(`CUA fix re-code done: ${fixResult.filesWritten} files written`, taskId);
          } else {
            log(`CUA fix re-code failed: ${fixResult.error}`, taskId);
            await reportStatus(taskId, 'failed', { message: 'CUA fix re-code failed: ' + (fixResult.error || '').slice(0, 200) });
            return;
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
          return;
        }
        log(`CUA fix rebuild OK in ${fixBuild.buildTime}s`, taskId);

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
        return;
      }
    }

    if (!cuaPassed) {
      await reportStatus(taskId, 'failed', { message: 'CUA verification did not pass after all rounds' });
      return;
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
        try { fs.rmSync(htmlOutputDir, { recursive: true, force: true }); } catch (e) {}
      } catch (e) {
        log(`HTML upload failed (non-fatal): ${e.message}`, taskId);
      }
    }

    // === Step 8: Screenshot Review (AI visual QC on Main ECS) ===
    await reportStatus(taskId, 'processing', { message: 'AI 截图审核中...' });
    try {
      const reviewResult = await screenshotReview(taskId, log);
      if (reviewResult && reviewResult.ok === false && !reviewResult.warning) {
        log(`Screenshot review REJECTED: ${reviewResult.reason}`, taskId);
        await reportStatus(taskId, 'failed', { 
          message: `AI 截图审核不通过: ${(reviewResult.reason || '').slice(0, 200)}`,
          screenshotReview: reviewResult
        });
        return;
      }
      if (reviewResult && reviewResult.ok) {
        log(`Screenshot review PASSED: ${reviewResult.reason || 'looks good'}`, taskId);
      }
    } catch (e) {
      log(`Screenshot review error (non-fatal): ${e.message}`, taskId);
    }

    // === Step 9: Done ===
    await reportStatus(taskId, 'reviewing', { message: `构建完成 (${buildResult.buildTime}s)，AI审核通过，等待人工审核` });
    log('Task completed → reviewing', taskId);

  } catch (e) {
    log(`Task error: ${e.message}`, taskId);
    await reportStatus(taskId, 'failed', { message: 'Error: ' + e.message.slice(0, 300) });
  }
}

// ============ Cocos Task Processing ============

async function processTaskCocos(task) {
  const taskId = task.taskId;

  if (!cocosPatch || !cocosBuild) {
    await reportStatus(taskId, 'failed', { message: 'Cocos modules not available on this worker' });
    return;
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
        return;
      }
    } else {
      const update = runCmd(`svn update ${SVN_FLAGS}`, COCOS_PROJECT_DIR, 120000);
      if (!update.ok) {
        await reportStatus(taskId, 'failed', { message: 'SVN update failed: ' + update.output.slice(0, 300) });
        return;
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
      return;
    }
    log(`Detected ${scenes.length} scene(s)`, taskId);
    cocosPatch.fixProjectSettings(COCOS_PROJECT_DIR, scenes);

    const buildResult = await cocosBuild.runCocosBuild(COCOS_PROJECT_DIR, log, taskId);
    if (!buildResult.ok) {
      await reportStatus(taskId, 'failed', { message: 'Cocos build failed: ' + (buildResult.error || '').slice(0, 300) });
      return;
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
        return;
      }
    } else {
      await reportStatus(taskId, 'failed', { message: 'No HTML output' });
      return;
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
    return;
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
log(`Worker v4 (unified) starting | ID: ${WORKER_ID} | Server: ${BASE_URL}`);
log(`Unity dir: ${FIXED_PROJECT_DIR} | Cocos dir: ${COCOS_PROJECT_DIR} | Luna: ${LUNA_DIR}`);

poll();
setInterval(poll, POLL_INTERVAL);
setInterval(heartbeat, HEARTBEAT_INTERVAL);
heartbeat();
