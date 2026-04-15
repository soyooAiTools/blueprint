/**
 * Claude Code Coder — 用 Claude Code CLI 替代 API 调用生成 Luna 代码
 * 
 * 方案 B：Claude Code 以 agent 模式工作，自己读文件、写代码、编译验证、修 bug
 * 
 * 依赖：claude CLI 已安装且环境变量已配置（ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY）
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync, spawn } = require('child_process');

// 复用现有 prompt 模块
const promptV5Module = require('./prompt-v5-basetemplate.js');

// Spec 系统（可选）
let specExtractor, skeletonGenerator;
try {
  specExtractor = require('../adapters/spec-extractor.cjs');
  skeletonGenerator = require('../adapters/skeleton-generator.cjs');
} catch (e) {}

// ============ Config ============
const CLAUDE_CMD = process.env.CLAUDE_CMD || 'claude';
const CLAUDE_TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS) || 25 * 60 * 1000; // 25 min (fresh gen can take 15-20min)
const CLAUDE_MAX_BUDGET = process.env.CLAUDE_MAX_BUDGET_USD || '0'; // 0 = no limit
const CLAUDE_MODEL = process.env.CLAUDE_CODE_MODEL || 'opus';
const GLM_MODEL = process.env.GLM_MODEL || 'glm-5.1';
const GLM_API_BASE = process.env.GLM_API_BASE || 'https://api.aaxe.cn/api/anthropic';
const GLM_API_KEY = process.env.GLM_API_KEY || 'oki-d82fb9cf928492b23847db9569dd1f912906cc09135c62fe20b5fa3f0576';
const SYSTEM_PROMPT_PATH = path.join(__dirname, 'luna-claude-code.md');
const BUILD_URL = process.env.LINUX_BUILD_URL || 'http://localhost:3080';

// ============ Cross-process Claude Code concurrency semaphore ============
// Uses file-based slot locking: /tmp/claude-code-slots/slot-N.lock
// MAX_CONCURRENT_CLAUDE controls how many Claude Code sessions run in parallel
const MAX_CONCURRENT_CLAUDE = parseInt(process.env.MAX_CONCURRENT_CLAUDE) || 3;
const LOCK_DIR = '/tmp/claude-code-slots';
const LOCK_POLL_MS = 5000;   // poll every 5s
const LOCK_TIMEOUT_MS = 20 * 60 * 1000; // 20min max wait (slightly over CLAUDE_TIMEOUT)

try { fs.mkdirSync(LOCK_DIR, { recursive: true }); } catch(e) {}

function _cleanStaleLocks() {
  // Remove locks older than 25 min OR whose owner PID is dead
  try {
    const files = fs.readdirSync(LOCK_DIR);
    const now = Date.now();
    for (const f of files) {
      if (!f.endsWith('.lock')) continue;
      const fp = path.join(LOCK_DIR, f);
      try {
        const stat = fs.statSync(fp);
        // Time-based stale check
        if (now - stat.mtimeMs > LOCK_TIMEOUT_MS) {
          fs.unlinkSync(fp);
          continue;
        }
        // PID-based stale check: if owner process is dead, remove lock
        try {
          const content = JSON.parse(fs.readFileSync(fp, 'utf8'));
          if (content.pid) {
            try { process.kill(content.pid, 0); } catch(e) {
              // process.kill(pid, 0) throws if PID doesn't exist
              fs.unlinkSync(fp);
            }
          }
        } catch(e) {}
      } catch(e) {}
    }
  } catch(e) {}
}

function _tryAcquireSlot(taskId) {
  _cleanStaleLocks();
  for (let i = 0; i < MAX_CONCURRENT_CLAUDE; i++) {
    const lockFile = path.join(LOCK_DIR, `slot-${i}.lock`);
    try {
      // O_EXCL ensures atomic creation — only one process wins
      const fd = fs.openSync(lockFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      fs.writeSync(fd, JSON.stringify({ taskId, pid: process.pid, at: new Date().toISOString() }));
      fs.closeSync(fd);
      return i; // acquired slot index
    } catch(e) {
      // Slot taken — try next
    }
  }
  return -1; // all slots busy
}

async function acquireLock(taskId, log) {
  const slot = _tryAcquireSlot(taskId);
  if (slot >= 0) {
    log(`[claude-lock] Acquired slot ${slot}/${MAX_CONCURRENT_CLAUDE}`, taskId);
    return slot;
  }
  // Wait for a slot
  log(`[claude-lock] All ${MAX_CONCURRENT_CLAUDE} slots busy, waiting...`, taskId);
  const waitStart = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const s = _tryAcquireSlot(taskId);
      if (s >= 0) {
        clearInterval(timer);
        const waited = Math.round((Date.now() - waitStart) / 1000);
        log(`[claude-lock] Acquired slot ${s}/${MAX_CONCURRENT_CLAUDE} after ${waited}s wait`, taskId);
        resolve(s);
        return;
      }
      if (Date.now() - waitStart > LOCK_TIMEOUT_MS) {
        clearInterval(timer);
        log(`[claude-lock] Timeout waiting for slot — proceeding without lock`, taskId);
        resolve(-1); // proceed anyway after timeout
      }
    }, LOCK_POLL_MS);
  });
}

function releaseLock(slot, taskId, log) {
  if (slot < 0) return;
  const lockFile = path.join(LOCK_DIR, `slot-${slot}.lock`);
  try {
    fs.unlinkSync(lockFile);
    log(`[claude-lock] Released slot ${slot}`, taskId);
  } catch(e) {}
}

/**
 * 准备 Claude Code 工作目录
 * - 写入 CLAUDE.md（Luna 规则）
 * - 写入 blueprint.json（蓝图数据）
 * - 写入 prompt.md（V5 prompt，含对象分配表）
 * - 写入 GFM_Tools.cs（API 参考）
 * - 写入 behavior-templates.md（行为模板参考）
 * - 创建 Assets/Program/Script/Manager/ 目录
 */
function prepareWorkDir(workDir, blueprint, prompt, skeleton, log, taskId) {
  // 创建目录结构
  const managerDir = path.join(workDir, 'Assets', 'Program', 'Script', 'Manager');
  fs.mkdirSync(managerDir, { recursive: true });

  // 1. CLAUDE.md — Claude Code 会自动读取
  const claudeMdSrc = SYSTEM_PROMPT_PATH;
  if (fs.existsSync(claudeMdSrc)) {
    fs.copyFileSync(claudeMdSrc, path.join(workDir, 'CLAUDE.md'));
  }

  // 2. blueprint.json
  fs.writeFileSync(path.join(workDir, 'blueprint.json'), JSON.stringify(blueprint, null, 2));

  // 3. prompt.md — V5 prompt（对象分配表 + 实体行为 + 事件规则）
  fs.writeFileSync(path.join(workDir, 'prompt.md'), prompt);

  // 3b. 如果有 skeleton，直接写入 .cs 文件（省去 Claude Code 读 prompt 再复制的时间）
  if (skeleton) {
    const csPath = path.join(managerDir, 'GameFlowManagerMain.cs');
    // NOTE: check `typeof object` not `skeleton.split` — a plain string has `.split` as a
    // method (truthy function), which would otherwise send us into the multi-file branch
    // and throw `fs.writeFileSync(path, undefined)`. The generator flags split mode with
    // `split: true` on a returned object.
    if (typeof skeleton === 'object' && skeleton.split === true) {
      // Multi-file skeleton: main + systems
      fs.writeFileSync(csPath, skeleton.main);
      const sysPath = path.join(managerDir, 'GameFlowManagerMain.Systems.cs');
      fs.writeFileSync(sysPath, skeleton.systems);
      fs.appendFileSync(path.join(workDir, 'prompt.md'),
        '\n\n## CODE SKELETON (SPLIT MODE)\n\n'
        + '⚠️ 骨架代码已拆分为两个文件（partial class）：\n'
        + '- `GameFlowManagerMain.cs` — 阶段流程（CheckEventRules、Start、Update）\n'
        + '- `GameFlowManagerMain.Systems.cs` — 游戏子系统（移动、战斗、生成、经济、UI）\n\n'
        + '**规则：**\n'
        + '1. 阶段流程代码写在 GameFlowManagerMain.cs 的 TODO 区域\n'
        + '2. 可复用的游戏子系统（UpdatePlayer, SpawnEnemy, HandleCombat 等）写在 Systems.cs\n'
        + '3. 每个文件控制在 800-1200 行，合计可达 2400 行\n'
        + '4. 不要删除 [SKELETON] 标记行、phaseTimer 检查、CheckEventRules() 跳转条件\n'
        + '5. 两个文件都是 `partial class GameFlowManagerMain`，共享所有字段和方法\n');
      log(`[claude-code] Split skeleton written: main=${skeleton.main.split('\n').length} lines, systems=${skeleton.systems.split('\n').length} lines`, taskId);
    } else {
      // Single file skeleton (≤10 phases)
      const skeletonStr = typeof skeleton === 'string' ? skeleton : skeleton.main || String(skeleton);
      fs.writeFileSync(csPath, skeletonStr);
      fs.appendFileSync(path.join(workDir, 'prompt.md'),
        '\n\n## CODE SKELETON\n\n'
        + '⚠️ 骨架代码已预写入 `Assets/Program/Script/Manager/GameFlowManagerMain.cs`。\n'
        + '请直接在该文件上修改和填充 TODO，不需要从头创建文件。\n'
        + '规则：不要删除 [SKELETON] 标记行、phaseTimer 检查、CheckEventRules() 跳转条件。\n');
    }
  }

  // 4. GFM_Tools.cs — 编译需要的真实源文件（managerDir 那一份）
  // 注意：以前在 workDir 也放了一份"方便 Claude Code 找到"，但这导致 Claude
  // 经常 Read 整份 ~48KB 文件，浪费 token。GFM_Tools_API.md 已经在 prompt 里内联
  // 了完整 API 表面，不需要 Claude 去读源码，所以 workDir 副本已删除。
  const gfmSrc = path.join(__dirname, 'GFM_Tools.cs');
  if (fs.existsSync(gfmSrc)) {
    fs.copyFileSync(gfmSrc, path.join(managerDir, 'GFM_Tools.cs'));
  }

  // 5. behavior-templates.md — NOT copied to workDir (P2-新1, 2026-04-15).
  // filterBehaviorTemplates() in parseBlueprintToPromptV5 already inlines only the
  // USED behaviors into prompt.md. Leaving an 11KB copy on disk was poisoning
  // Claude Code's first Read (~3K tokens wasted per codegen session) — the same
  // pattern as the GFM_Tools.cs workDir copy fix from P1.

  // 5b. promoted rules + phase state machine 已经由 parseBlueprintToPromptV5 内部注入到 prompt.md，
  //     这里不再 append（避免与 prompt-v5-basetemplate.js 的统一注入点重复）

  // 5c. GFM_Tools_API.md — extended API documentation
  const apiDocSrc = path.join(__dirname, 'GFM_Tools_API.md');
  if (fs.existsSync(apiDocSrc)) {
    fs.copyFileSync(apiDocSrc, path.join(workDir, 'GFM_Tools_API.md'));
  }

  // 6. 创建 build-test.sh — 方便 Claude Code 调用编译验证
  const buildScript = `#!/bin/bash
# 编译验证脚本：读取 GameFlowManagerMain.cs (+ Systems.cs) 并调用 Bridge.NET 编译
CS_FILE="Assets/Program/Script/Manager/GameFlowManagerMain.cs"
if [ ! -f "$CS_FILE" ]; then
  echo '{"ok":false,"error":"GameFlowManagerMain.cs not found"}'
  exit 1
fi

# 读取 C# 代码并发送到编译服务
CODE=$(cat "$CS_FILE")

# 读取所有额外 .cs 文件（GFM_Tools.cs, Systems.cs 等）
# python3 脚本动态收集 Manager 目录下除主文件外的所有 .cs 文件
MANAGER_DIR="Assets/Program/Script/Manager"
EXTRA=$(python3 -c "
import json, os, sys
extra = {}
manager_dir = sys.argv[1]
main_file = 'GameFlowManagerMain.cs'
for f in os.listdir(manager_dir):
    if f.endswith('.cs') and f != main_file:
        extra[f] = open(os.path.join(manager_dir, f)).read()
print(json.dumps(extra))
" "$MANAGER_DIR" 2>/dev/null || echo '{}')

# 构建 JSON payload
python3 -c "
import json, sys
code = open(sys.argv[1]).read()
extra = {}
gfm = sys.argv[2] if len(sys.argv) > 2 else ''
if gfm:
    try:
        extra = {'GFM_Tools.cs': open(gfm).read()}
    except: pass
payload = {'csCode': code, 'code': code, 'extraFiles': extra}
print(json.dumps(payload))
" "$CS_FILE" "$GFM_FILE" | curl -s -X POST ${BUILD_URL}/build \
  -H "Content-Type: application/json" \
  -d @-
`;
  fs.writeFileSync(path.join(workDir, 'build-test.sh'), buildScript, { mode: 0o755 });

  // 6. .claude/settings.local.json — 预授权所有工具（最高权限）
  const claudeSettingsDir = path.join(workDir, '.claude');
  fs.mkdirSync(claudeSettingsDir, { recursive: true });
  fs.writeFileSync(path.join(claudeSettingsDir, 'settings.local.json'), JSON.stringify({
    permissions: {
      allow: [
        'Bash(*)',
        'Read(*)',
        'Write(*)',
        'Edit(*)'
      ]
    }
  }, null, 2));

  log(`[claude-code] Work dir prepared: ${workDir}`, taskId);
}

/**
 * 运行 Claude Code CLI
 * 返回 Promise<{ ok, code, output, error }>
 */
function runClaudeCode(workDir, userPrompt, log, taskId, opts) {
  opts = opts || {};
  
  return new Promise((resolve, reject) => {
    const args = [
      '--print',                              // 非交互模式
      '--model', opts.model || (opts.useGlm ? GLM_MODEL : CLAUDE_MODEL),
      '--output-format', 'text',
      // Budget: 0 means no limit; only pass flag if > 0
      ...(parseInt(CLAUDE_MAX_BUDGET) > 0 ? ['--max-budget-usd', CLAUDE_MAX_BUDGET] : []),
      // Note: --no-session-persistence intentionally NOT set so that server-side prompt
      // cache can hash-match the stable system prompt + tools prefix across fix-loop rounds.
      // Each round still gets a fresh CLI process; "session" here only affects cache identity.
      '--effort', opts.effort || 'medium',  // medium effort to avoid 5min API stream timeout during extended thinking
      '--debug-file', '/tmp/claude-debug-' + (taskId || 'unknown') + '.log',  // debug log for diagnosis
      '--tools', 'Read,Write,Edit,Bash',  // only essential tools, no Glob/Grep/Agent overhead
      '--system-prompt-file', path.join(workDir, 'CLAUDE.md'),  // 直接传入 system prompt
    ];

    // 如果有追加系统提示（如增量修复指令）
    if (opts.appendSystemPrompt) {
      args.push('--append-system-prompt', opts.appendSystemPrompt);
    }

    log(`[claude-code] Spawning: ${CLAUDE_CMD} ${args.join(' ')}`, taskId);
    log(`[claude-code] Prompt length: ${userPrompt.length} chars`, taskId);

    // === Prompt cache hit instrumentation ===
    // Server-side prompt cache hashes the stable prefix (system prompt + tools + early user message bytes).
    // Logging sha1 of:
    //   - CLAUDE.md file (system prompt) — should be IDENTICAL across all tasks if cache is going to hit
    //   - userPrompt head 1000 bytes — should be identical across all tasks for the same template/skeleton
    //   - userPrompt tail 500 bytes — usually task-specific (verifies it varies as expected)
    // To check cache hit rate: grep '[prompt-cache]' on logs from multiple tasks; head sha1 should match.
    try {
      const claudeMdPath = path.join(workDir, 'CLAUDE.md');
      let claudeMdSha = 'missing';
      let claudeMdLen = 0;
      if (fs.existsSync(claudeMdPath)) {
        const claudeMdContent = fs.readFileSync(claudeMdPath);
        claudeMdSha = crypto.createHash('sha1').update(claudeMdContent).digest('hex').slice(0, 12);
        claudeMdLen = claudeMdContent.length;
      }
      const headBytes = Buffer.from(userPrompt.slice(0, 1000), 'utf8');
      const tailBytes = Buffer.from(userPrompt.slice(-500), 'utf8');
      const headSha = crypto.createHash('sha1').update(headBytes).digest('hex').slice(0, 12);
      const tailSha = crypto.createHash('sha1').update(tailBytes).digest('hex').slice(0, 12);
      log(`[prompt-cache] CLAUDE.md sha1=${claudeMdSha} len=${claudeMdLen} | userPrompt headSha=${headSha} tailSha=${tailSha} totalLen=${userPrompt.length}`, taskId);
    } catch (cacheLogErr) {
      log(`[prompt-cache] instrumentation error: ${cacheLogErr.message}`, taskId);
    }

    // Record file mtime before spawn to detect actual modifications (Bug fix: skeleton pre-write false positive)
    const mainFileForMtime = path.join(opts.workDir || workDir, 'Assets', 'Program', 'Script', 'Manager', 'GameFlowManagerMain.cs');
    let preSpawnMtimeMs = 0;
    try {
      if (fs.existsSync(mainFileForMtime)) {
        preSpawnMtimeMs = fs.statSync(mainFileForMtime).mtimeMs;
      }
    } catch (_e) {}
    const spawnStartTime = Date.now();

    const child = spawn(CLAUDE_CMD, args, {
      cwd: workDir,
      env: {
        ...process.env,
        // Let Claude CLI use its own auth (OAuth token from CLAUDE_CODE_OAUTH_TOKEN env)
        // Do NOT override ANTHROPIC_API_KEY — it breaks OAuth when set to a non-Anthropic key
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Track child PID for graceful shutdown cleanup (shared via process global)
    if (child.pid) {
      if (!process._activeChildPIDs) process._activeChildPIDs = new Set();
      process._activeChildPIDs.add(child.pid);
    }

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
      // 实时日志（每 2000 字符输出一次进度）
      if (stdout.length % 2000 < 100) {
        log(`[claude-code] Output progress: ${stdout.length} chars...`, taskId);
      }
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    // 超时保护
    const timer = setTimeout(() => {
      log(`[claude-code] ⚠️ Timeout (${CLAUDE_TIMEOUT_MS / 1000}s), killing process`, taskId);
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000);
    }, CLAUDE_TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (child.pid && process._activeChildPIDs) process._activeChildPIDs.delete(child.pid);
      log(`[claude-code] Process exited with code ${code}, stdout ${stdout.length} chars, stderr ${stderr.length} chars`, taskId);
      
      if (stderr && stderr.length > 0) {
        // 过滤掉 Claude Code 的正常 stderr 输出（进度条等）
        const significantErrors = stderr.split('\n').filter(line => {
          return line && !line.includes('Thinking') && !line.includes('⠋') && !line.includes('⠙');
        }).join('\n');
        if (significantErrors) {
          log(`[claude-code] Stderr: ${significantErrors.slice(0, 500)}`, taskId);
        }
      }

      // Bug fix: Check elapsed time + stdout length to detect CLI errors (auth failure, connection error)
      const elapsedMs = Date.now() - spawnStartTime;
      if (code !== 0 && elapsedMs < 10000 && stdout.length < 200) {
        // Scan both streams for quota/auth indicators — if Claude relay rejects
        // our request, the CLI exits early with the API error dumped to stderr/stdout.
        // Detected definitive failures get MODEL_FATAL: prefix so error-classifier
        // routes them to cancel-task instead of burning more retries.
        const streams = (stdout || '') + '\n' + (stderr || '');
        const isModelFatal = /quota|insufficient|\b401\b|\b402\b|\b403\b|invalid.?api.?key|unauthoriz|authentication.?fail|access.?denied|billing/i.test(streams);
        const baseErr = stdout || stderr || `CLI error: exit code ${code} in ${elapsedMs}ms`;
        const errorMsg = isModelFatal
          ? `MODEL_FATAL: Claude Code CLI auth/quota failure — ${baseErr.slice(0, 300)}`
          : baseErr;
        log(`[claude-code] ❌ CLI error detected: exit code ${code}, elapsed ${elapsedMs}ms, stdout ${stdout.length} chars${isModelFatal ? ' (MODEL_FATAL)' : ''} — treating as hard failure`, taskId);
        resolve({
          ok: false,
          exitCode: code,
          output: stdout,
          error: errorMsg,
          partialSuccess: false,
        });
        return;
      }

      // 即使超时(143)或非零退出，也检查文件是否已实际修改
      // Claude Code 可能在被 kill 前已经写好了文件
      const mainFile = path.join(opts.workDir || '', 'Assets', 'Program', 'Script', 'Manager', 'GameFlowManagerMain.cs');
      let fileActuallyModified = false;
      try {
        if (opts.workDir && fs.existsSync(mainFile)) {
          const currentMtimeMs = fs.statSync(mainFile).mtimeMs;
          fileActuallyModified = currentMtimeMs > preSpawnMtimeMs;
        }
      } catch (_e) {}
      
      if (code !== 0 && fileActuallyModified) {
        log(`[claude-code] Process exited non-zero (${code}) but code file was modified after spawn — treating as partial success`, taskId);
      } else if (code !== 0 && !fileActuallyModified) {
        log(`[claude-code] Process exited non-zero (${code}) and code file was NOT modified — treating as failure`, taskId);
      }

      resolve({
        ok: code === 0 || fileActuallyModified,  // file must have been actually modified to count as success
        exitCode: code,
        output: stdout,
        error: (code !== 0 && !fileActuallyModified) ? (stderr || `Exit code ${code}`) : null,
        partialSuccess: code !== 0 && fileActuallyModified,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      log(`[claude-code] Spawn error: ${err.message}`, taskId);
      resolve({
        ok: false,
        exitCode: -1,
        output: '',
        error: err.message,
      });
    });

    // 写入 prompt
    child.stdin.write(userPrompt);
    child.stdin.end();
  });
}

/**
 * 主入口：generateWithClaudeCode
 * 
 * 替代 generateCodeV5 的 callClaudeWithRetry 部分。
 * 保留原有的 V5 prompt 生成逻辑（对象分配表等），但让 Claude Code 自己读文件、写代码、编译验证。
 */
async function generateWithClaudeCode(blueprint, clientDir, log, taskId, engine) {
  if (engine === 'cocos') {
    log('[claude-code] Cocos not supported, falling back to V4 API', taskId);
    // Cocos 暂时还用旧方式
    const { generateCodeV4 } = require('./worker-coder.js');
    return generateCodeV4(blueprint, clientDir, log, taskId, engine);
  }

  const startTime = Date.now();
  const hasFeedback = blueprint.feedbackHistory && blueprint.feedbackHistory.length > 0;

  // === Step 1: 生成 V5 Prompt（复用现有逻辑）===
  let opts = {};
  if (hasFeedback) {
    opts.feedback = blueprint.feedbackHistory;
    const mainFile = path.join(clientDir, 'Assets', 'Program', 'Script', 'Manager', 'GameFlowManagerMain.cs');
    if (fs.existsSync(mainFile)) {
      opts.existingCode = fs.readFileSync(mainFile, 'utf-8');
    }
    // Also track Systems file for split-mode regression detection
    const sysFile = path.join(clientDir, 'Assets', 'Program', 'Script', 'Manager', 'GameFlowManagerMain.Systems.cs');
    if (fs.existsSync(sysFile)) {
      opts.existingSystemsCode = fs.readFileSync(sysFile, 'utf-8');
    }
  }
  const prompt = promptV5Module.parseBlueprintToPromptV5(blueprint, opts);
  log(`[claude-code] V5 prompt generated: ${prompt.length} chars, mode=${hasFeedback ? 'INCREMENTAL_FIX' : 'FULL_GENERATION'}`, taskId);

  // === Step 2: Spec + Skeleton（可选）===
  let skeleton = null;
  const storyboardFrames = (blueprint.storyboard && blueprint.storyboard.frames && blueprint.storyboard.frames.length > 0)
    ? blueprint.storyboard.frames
    : (blueprint.storyboardFrames && blueprint.storyboardFrames.length > 0 ? blueprint.storyboardFrames : null);
  if (!hasFeedback && specExtractor && skeletonGenerator && storyboardFrames) {
    try {
      const specsDataDir = process.env.SPECS_DATA_DIR || path.join(__dirname, '..', 'spec-data');
      // P0 FIX: Use blueprint.specs (from DB, same source as review/conformance) as single source of truth
      // This prevents phaseId mismatch between skeleton (Path B) and review checks (Path A)
      let specs = (blueprint.specs && blueprint.specs.length > 0) ? blueprint.specs : null;
      if (specs) {
        log(`[claude-code] Using blueprint.specs (DB): ${specs.length} phase specs — single source of truth`, taskId);
      }
      // Fallback: try cached spec-data
      if (!specs || specs.length === 0) {
        specs = specExtractor.loadSpecs(taskId, specsDataDir);
        if (specs && specs.length > 0) {
          log(`[claude-code] Using cached specs: ${specs.length} phase specs — re-validating entity names`, taskId);
          // Re-validate cached specs against current blueprint entities
          const cachedEntities = blueprint.entities || [];
          if (cachedEntities.length > 0) {
            const knownNames = new Set(cachedEntities.map(e => e.name).filter(Boolean));
            let hasInvalid = false;
            for (const s of specs) {
              for (const ent of (s.entitiesRequired || [])) {
                if (ent.name && !knownNames.has(ent.name)) { hasInvalid = true; break; }
              }
              if (hasInvalid) break;
            }
            if (hasInvalid) {
              log('[claude-code] Cached specs have entity mismatches — re-extracting', taskId);
              specs = null;
            }
          }
        }
      }
      // Last resort: extract fresh (and save to both spec-data and blueprint)
      if (!specs || specs.length === 0) {
        log('[claude-code] Extracting specs from storyboard frames...', taskId);
        specs = await specExtractor.extractSpecs(storyboardFrames, {
          projectName: blueprint.projectName || taskId,
          gameType: blueprint.gameType || 'SLG',
          entities: blueprint.entities || [],
        });
        log(`[claude-code] Extracted ${specs.length} phase specs`, taskId);
        specExtractor.saveSpecs(specs, taskId, specsDataDir);
        // Write back to blueprint so review/conformance uses the same phaseIds
        blueprint.specs = specs;
      }

      // === Generate skeleton for ALL phases (no longer limiting to first 3) ===
      let activeSpecs = specs;

      // Generate skeleton with entity→pool mapping
      const entityPoolMap = (blueprint.entities && blueprint.entities.length > 0)
        ? promptV5Module.matchPrefabs(blueprint.entities)
        : {};
      skeleton = skeletonGenerator.generateSkeleton(activeSpecs, {
        projectName: blueprint.projectName || taskId,
        entityPoolMap: entityPoolMap
      });
      const skelLines = typeof skeleton === 'string' ? skeleton.split('\n').length
        : ((skeleton.main || '').split('\n').length + (skeleton.systems || '').split('\n').length);
      log(`[claude-code] Skeleton generated: ${skelLines} lines (${activeSpecs.length}/${specs.length} phases)`, taskId);
    } catch (specErr) {
      log(`[claude-code] Spec extraction failed (non-fatal): ${specErr.message}`, taskId);
    }
  }

  // === Step 3: 准备工作目录 ===
  prepareWorkDir(clientDir, blueprint, prompt, skeleton, log, taskId);

  // === Step 4: 构建用户 Prompt ===
  let userPrompt;
  if (hasFeedback) {
    // Extract feedback text to inject directly into prompt (don't rely on AI reading prompt.md)
    const feedbackTexts = blueprint.feedbackHistory.map(fb => {
      if (fb.data && fb.data.text) return fb.data.text;
      if (fb.text) return fb.text;
      return JSON.stringify(fb);
    }).join('\n---\n');

    userPrompt = `## 增量修复模式

⚠️ 这是一个 FIX 请求。保持现有代码结构，只修改反馈要求的部分。
⚠️ 禁止重写整个文件！使用 Edit 工具做局部修改。

## CUA 验证反馈（必须修复以下问题）：
${feedbackTexts}

请完成以下步骤：
1. 仔细阅读上面的 CUA 反馈，理解具体失败原因
2. 阅读 prompt.md 了解完整需求
3. 阅读现有的 Assets/Program/Script/Manager/GameFlowManagerMain.cs
4. 根据 CUA 反馈做**针对性修改**（使用 Edit 工具，不是 Write）
5. 如果反馈说缺少 phase，必须添加完整的 phase 实现代码
6. 如果反馈说 phase-skipped/game_ended，检查 phase 过渡条件是否正确（不能用 true 占位）
7. 运行 bash build-test.sh 验证编译
8. 如果编译失败，修复错误并重试
9. 编译通过后完成

重要：修改后文件行数不应减少。如果你发现文件变短了，说明你错误地重写了整个文件。`;
  } else {
    // Inline key file contents to minimize Read tool calls — speeds up fresh gen significantly
    // Note: behavior-templates.md is already injected into prompt.md by parseBlueprintToPromptV5
    // (filtered to only the behaviors actually used by current entities), so no separate inline read.
    let inlinePromptMd = '';
    let inlineGfmApi = '';
    try {
      inlinePromptMd = fs.readFileSync(path.join(clientDir, 'prompt.md'), 'utf-8');
    } catch(e) {}
    try {
      inlineGfmApi = fs.readFileSync(path.join(clientDir, 'GFM_Tools_API.md'), 'utf-8');
    } catch(e) {}

    // Also inline skeleton contents to avoid Read calls on large skeleton files
    let inlineSkeletonMain = '';
    let inlineSkeletonSystems = '';
    if (skeleton && skeleton.split) {
      try {
        inlineSkeletonMain = fs.readFileSync(path.join(clientDir, 'Assets', 'Program', 'Script', 'Manager', 'GameFlowManagerMain.cs'), 'utf-8');
      } catch(e) {}
      try {
        inlineSkeletonSystems = fs.readFileSync(path.join(clientDir, 'Assets', 'Program', 'Script', 'Manager', 'GameFlowManagerMain.Systems.cs'), 'utf-8');
      } catch(e) {}
    } else if (skeleton) {
      try {
        inlineSkeletonMain = fs.readFileSync(path.join(clientDir, 'Assets', 'Program', 'Script', 'Manager', 'GameFlowManagerMain.cs'), 'utf-8');
      } catch(e) {}
    }

    userPrompt = skeleton
      ? (skeleton.split
        ? `## 任务：生成 Luna 试玩广告代码（拆分模式）

所有参考信息和骨架代码都在下面。

${inlineGfmApi ? '### GFM API 参考（完整 API 表面 — 不要 Read GFM_Tools.cs，所有可用方法都在下面）\n' + inlineGfmApi + '\n⛔ DO NOT Read GFM_Tools.cs (~48KB) — its complete public API is already inlined above. Reading the source file wastes tokens and gives you no extra information.\n\n' : ''}
### 详细需求
${inlinePromptMd}

### 骨架代码 — GameFlowManagerMain.cs（填充 TODO 区域）
\`\`\`csharp
${inlineSkeletonMain}
\`\`\`

### 骨架代码 — GameFlowManagerMain.Systems.cs（实现子系统）
\`\`\`csharp
${inlineSkeletonSystems}
\`\`\`

## 指令 — 分段编辑（每次一个 phase）

⚠️ **关键：为了避免 API 超时，每次 Edit 调用只修改一小段代码（一个 TODO 区域）。不要一次 Write 整个文件。**

1. 先 Read 两个 .cs 骨架文件（它们已在磁盘上）
2. 逐个 TODO 区域使用 Edit 工具替换：
   - 先填充 GameFlowManagerMain.cs 中的变量声明 TODO
   - 然后逐个 phase 的 TODO：Phase 1 初始化、Phase 2 初始化... 直到最后一个 phase
   - 最后填充 GameFlowManagerMain.Systems.cs 中的子系统 TODO
3. 每个 Edit 只替换一个 TODO 标记区域（约 20-80 行）
4. 全部填充完成后运行 bash build-test.sh 验证编译
5. 如果编译失败，用 Edit 修复，再次运行 build-test.sh

两个文件是 partial class，共享所有字段。主文件放阶段流程，Systems 文件放子系统。`
        : `## 任务：生成 Luna 试玩广告代码

所有参考信息和骨架代码都在下面。

${inlineGfmApi ? '### GFM API 参考（完整 API 表面 — 不要 Read GFM_Tools.cs，所有可用方法都在下面）\n' + inlineGfmApi + '\n⛔ DO NOT Read GFM_Tools.cs (~48KB) — its complete public API is already inlined above. Reading the source file wastes tokens and gives you no extra information.\n\n' : ''}
### 详细需求
${inlinePromptMd}

### 骨架代码 — GameFlowManagerMain.cs（填充 TODO 区域）
\`\`\`csharp
${inlineSkeletonMain}
\`\`\`

## 指令 — 分段编辑

⚠️ **每次 Edit 调用只修改一个 TODO 区域。不要一次 Write 整个文件。**

1. 先 Read GameFlowManagerMain.cs（已在磁盘上）
2. 逐个 TODO 区域使用 Edit 工具替换（每次约 20-80 行）
3. 全部填充完成后运行 bash build-test.sh 验证编译
4. 如果编译失败，用 Edit 修复，再次运行 build-test.sh

代码必须完整（1300-1600 行），不要省略任何部分。`)
      : `## 任务：生成 Luna 试玩广告代码

所有参考信息都在下面。

${inlineGfmApi ? '### GFM API 参考（完整 API 表面 — 不要 Read GFM_Tools.cs，所有可用方法都在下面）\n' + inlineGfmApi + '\n⛔ DO NOT Read GFM_Tools.cs (~48KB) — its complete public API is already inlined above. Reading the source file wastes tokens and gives you no extra information.\n\n' : ''}
### 详细需求
${inlinePromptMd}

## 指令

1. 基于上面的需求，生成完整的 GameFlowManagerMain.cs 代码
2. 用 Write 工具写入 Assets/Program/Script/Manager/GameFlowManagerMain.cs（注意：先 Read 一下文件）
3. 运行 bash build-test.sh 验证编译
4. 如果编译失败，用 Edit 工具修复，再次运行 build-test.sh

代码必须完整（1300-1600 行），不要省略任何部分。`;
  }

  // === Step 5: 运行 Claude Code（跨进程信号量，限制并发数）===
  const slot = await acquireLock(taskId, log);
  log('[claude-code] 🚀 Starting Claude Code agent...', taskId);
  let result;
  try {
  // Use Opus for both fresh and fix — quality matters. Inline prompt + Edit approach avoids 5min timeout.
  const codegenModel = CLAUDE_MODEL;
  log(`[claude-code] Model: ${codegenModel === 'haiku' ? 'Haiku 4.5' : codegenModel === 'sonnet' ? 'Sonnet 4.6' : 'Opus 4.6'}`, taskId);
  result = await runClaudeCode(clientDir, userPrompt, log, taskId, {
    model: codegenModel,
    // effort: always 'medium' to avoid API stream timeout (5min) during extended thinking
    // INCREMENTAL FIX MODE rules — kept minimal. The ⛔ FORBIDDEN PATTERNS block
    // that used to live here was removed 2026-04-14 because it fully duplicated
    // luna-claude-code.md §L87-98 (autoPlay gates, _autoInteractTimer ≥3f,
    // safety net ≥50f, ruleTriggered[], VISUAL FREEZE, phaseId preservation).
    // Sending it twice wasted ~750 bytes per fix round with zero additional signal.
    // Only the FIX-ONLY rules (Edit-not-Write, no-rewrite, Read-first) stay here
    // because they'd confuse fresh-gen tasks if moved into CLAUDE.md.
    appendSystemPrompt: hasFeedback
      ? 'INCREMENTAL FIX MODE — CRITICAL RULES:\n'
        + '1. Use the Edit tool (NOT Write) to modify .cs files\n'
        + '2. NEVER rewrite the entire file — only change the specific lines that need fixing\n'
        + '3. The existing code is 1000+ lines (may be split across GameFlowManagerMain.cs + GameFlowManagerMain.Systems.cs). Your edits must preserve all existing code.\n'
        + '4. Read ALL existing .cs files FIRST, then apply targeted edits based on the feedback.\n'
        + '5. If any file becomes shorter after your edits, you have made a mistake.\n'
        + '6. If GameFlowManagerMain.Systems.cs exists, game subsystems live there — edit it for movement/combat/spawning/economy fixes.'
      : null,
    workDir: clientDir,
  });
  } finally {
    releaseLock(slot, taskId, log);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`[claude-code] Agent finished in ${elapsed}s, ok=${result.ok}`, taskId);

  if (!result.ok) {
    return {
      ok: false,
      error: `Claude Code failed (exit ${result.exitCode}): ${(result.error || '').slice(0, 500)}`,
    };
  }

  // === Step 6: 验证输出 ===
  const mainFilePath = path.join(clientDir, 'Assets', 'Program', 'Script', 'Manager', 'GameFlowManagerMain.cs');
  
  if (!fs.existsSync(mainFilePath)) {
    log('[claude-code] ❌ GameFlowManagerMain.cs not found after Claude Code run', taskId);
    return {
      ok: false,
      error: 'Claude Code did not generate GameFlowManagerMain.cs',
    };
  }

  const mainSrc = fs.readFileSync(mainFilePath, 'utf-8');
  const mainLineCount = mainSrc.split('\n').length;

  // Check for Systems partial class file
  const systemsFilePath = path.join(clientDir, 'Assets', 'Program', 'Script', 'Manager', 'GameFlowManagerMain.Systems.cs');
  const hasSystems = fs.existsSync(systemsFilePath);
  const systemsSrc = hasSystems ? fs.readFileSync(systemsFilePath, 'utf-8') : '';
  const systemsLineCount = hasSystems ? systemsSrc.split('\n').length : 0;

  // Combined metrics across all partial class files
  const combinedSrc = mainSrc + '\n' + systemsSrc;
  const lineCount = mainLineCount + systemsLineCount;
  const findCalls = (combinedSrc.match(/GameObject\.Find/g) || []).length;
  const gfmCreateCalls = (combinedSrc.match(/GFM_Create\.Obj/g) || []).length;
  const hasGameEnded = /GameEnded/.test(combinedSrc);

  if (hasSystems) {
    log(`[claude-code] ✅ Code generated (split): main=${mainLineCount} lines + systems=${systemsLineCount} lines = ${lineCount} total, ${findCalls} Find() calls`, taskId);
  } else {
    log(`[claude-code] ✅ Code generated: ${lineCount} lines, ${findCalls} Find() calls, ${gfmCreateCalls} GFM_Create.Obj() calls`, taskId);
  }

  // === 增量修复回退保护：如果修复后代码变短了超过 30%，恢复原始代码 ===
  if (hasFeedback && opts.existingCode) {
    const origLines = opts.existingCode.split('\n').length;
    // Compare combined line count (main+systems) against original main file
    if (lineCount < origLines * 0.7) {
      log(`[claude-code] ⚠️ REGRESSION DETECTED: code shrank from ${origLines} to ${lineCount} lines (${Math.round((1 - lineCount/origLines) * 100)}% reduction). Restoring original.`, taskId);
      fs.writeFileSync(mainFilePath, opts.existingCode);
      return {
        ok: false,
        error: `Incremental fix regressed code from ${origLines} to ${lineCount} lines — restored original`,
        regression: true,
      };
    }
  }

  if (gfmCreateCalls > 0) {
    log('[claude-code] ⚠️ WARNING: AI used GFM_Create.Obj() — should use Find() instead', taskId);
  }
  if (!hasGameEnded) {
    log('[claude-code] ⚠️ WARNING: No GameEnded() call', taskId);
  }

  // === Stub 检测：空壳代码不允许进入修复循环 ===
  // Count real unfilled TODOs across all files (not skeleton section markers like TODO_VARIABLES_START/END)
  const realTodoCount = (combinedSrc.match(/\/\/ TODO(?!_\w+(?:START|END))/gi) || []).length;
  // Check if skeleton was completely unmodified: [SKELETON] markers present AND code didn't grow
  const skeletonLineCount = skeleton
    ? (skeleton.split ? (skeleton.main || '').split('\n').length + (skeleton.systems || '').split('\n').length
       : (typeof skeleton === 'string' ? skeleton.split('\n').length : 0))
    : 0;
  const codeGrowthRatio = skeletonLineCount > 0 ? lineCount / skeletonLineCount : 999;
  // Skeleton includes IdleGameKit (~400 lines of working code), so growth ratio is less relevant.
  // Instead check: are TODO sections still unfilled? (realTodoCount > 5 = still a stub)
  const isUnmodifiedSkeleton = /\[SKELETON\]/.test(mainSrc) && codeGrowthRatio < 1.2 && realTodoCount > 5;
  if (lineCount < 100 || (findCalls === 0 && gfmCreateCalls === 0) || isUnmodifiedSkeleton) {
    const stubReason = lineCount < 100
      ? `Only ${lineCount} lines (need ≥100)`
      : isUnmodifiedSkeleton
        ? `Skeleton unmodified (${skeletonLineCount}→${lineCount} lines, ${realTodoCount} unfilled TODOs) — Claude Code likely timed out`
        : `0 Find() and 0 GFM_Create.Obj() calls (no objects created)`;
    log(`[claude-code] ❌ STUB CODE DETECTED: ${stubReason}. Rejecting output.`, taskId);
    // 清空 feedbackHistory 强制下一轮走 FULL_GENERATION
    if (blueprint.feedbackHistory && blueprint.feedbackHistory.length > 0) {
      log('[claude-code] Clearing feedbackHistory to force FULL_GENERATION on next attempt', taskId);
      blueprint.feedbackHistory.length = 0;
    }
    return {
      ok: false,
      error: `Stub code detected (${lineCount} lines, ${findCalls} Find calls, growth=${codeGrowthRatio.toFixed(1)}x) — need full regeneration`,
      stubDetected: true,
    };
  }
  if (codeGrowthRatio < 3 && codeGrowthRatio >= 1.5) {
    log(`[claude-code] ⚠️ WARNING: Code only grew ${codeGrowthRatio.toFixed(1)}x from skeleton (${skeletonLineCount}→${lineCount}). May be partially filled.`, taskId);
  }

  // Post-fix: 替换泛型方法（Luna 不支持）
  let fixedSrc = mainSrc;
  fixedSrc = fixedSrc.replace(/Resources\.GetBuiltinResource<(\w+)>\(([^)]+)\)/g, '($1)Resources.GetBuiltinResource(typeof($1), $2)');
  fixedSrc = fixedSrc.replace(/FindObjectOfType<(\w+)>\(\)/g, '($1)FindObjectOfType(typeof($1))');
  fixedSrc = fixedSrc.replace(/\.GetComponent<(\w+)>\(\)/g, '.GetComponent(typeof($1)) as $1');
  
  if (fixedSrc !== mainSrc) {
    fs.writeFileSync(mainFilePath, fixedSrc);
    log('[claude-code] Post-fix: stripped generic method calls for Luna compatibility', taskId);
  }

  // 确保 GFM_Tools.cs 是正版
  const canonicalGfm = path.join(__dirname, 'GFM_Tools.cs');
  const gfmDst = path.join(clientDir, 'Assets', 'Program', 'Script', 'Manager', 'GFM_Tools.cs');
  if (fs.existsSync(canonicalGfm)) {
    fs.copyFileSync(canonicalGfm, gfmDst);
  }

  return {
    ok: true,
    skipped: false,
    v5: true,
    claudeCode: true,
    entityCount: (blueprint.entities || []).length,
    lineCount: lineCount,
    findCalls: findCalls,
    gfmCreateCalls: gfmCreateCalls,
    elapsedSeconds: parseFloat(elapsed),
    filesWritten: 1,
  };
}

module.exports = { generateWithClaudeCode };
