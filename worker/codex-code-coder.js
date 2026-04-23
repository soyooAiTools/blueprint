/**
 * Codex worker implementation — runs the CLI-based Luna codegen pipeline
 * behind Codex-facing exports.
 *
 * 这一轮只做命名 / 路径收口，不重写底层 CLI 实现。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
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
const CODEX_CMD = process.env.CODEX_CMD || 'codex';
const CLAUDE_TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS) || 25 * 60 * 1000; // 25 min (fresh gen can take 15-20min)
const CLAUDE_MAX_BUDGET = process.env.CLAUDE_MAX_BUDGET_USD || '0'; // 0 = no limit
const CLAUDE_MODEL = process.env.CLAUDE_CODE_MODEL || 'claude-opus-4-7';
const CODEX_CODE_MODEL = process.env.CODEX_CODE_MODEL || 'gpt-5.4';
const CODEX_CODE_BACKEND = process.env.CODEX_CODE_BACKEND || 'codex-exec';
const GLM_MODEL = process.env.GLM_MODEL || 'glm-5.1';
const GLM_API_BASE = process.env.GLM_API_BASE || 'https://api.aaxe.cn/api/anthropic';
const GLM_API_KEY = process.env.GLM_API_KEY || 'oki-d82fb9cf928492b23847db9569dd1f912906cc09135c62fe20b5fa3f0576';
const SYSTEM_PROMPT_PATH = path.join(__dirname, 'luna-codex-code.md');
const BUILD_URL = process.env.LINUX_BUILD_URL || 'http://localhost:3080';
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const CODEX_SYSTEM_PROMPT_FILE = 'CODEX.md';
const CODEX_AGENTS_FILE = 'AGENTS.md';
const LEGACY_SYSTEM_PROMPT_FILE = 'CLAUDE.md';
const CODEX_SETTINGS_DIRNAME = '.codex';
const DEFAULT_TEXT_RUNNER_MODE = process.env.BLUEPRINT_TEXT_RUNNER || 'claude-print';

// ============ Cross-process Codex CLI concurrency semaphore ============
// Uses file-based slot locking: /tmp/codex-code-slots/slot-N.lock
// MAX_CONCURRENT_CLAUDE controls how many Codex code sessions run in parallel
const MAX_CONCURRENT_CLAUDE = parseInt(process.env.MAX_CONCURRENT_CLAUDE) || 3;
const LOCK_DIR = '/tmp/codex-code-slots';
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
    log(`[codex-lock] Acquired slot ${slot}/${MAX_CONCURRENT_CLAUDE}`, taskId);
    return slot;
  }
  // Wait for a slot
  log(`[codex-lock] All ${MAX_CONCURRENT_CLAUDE} slots busy, waiting...`, taskId);
  const waitStart = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const s = _tryAcquireSlot(taskId);
      if (s >= 0) {
        clearInterval(timer);
        const waited = Math.round((Date.now() - waitStart) / 1000);
        log(`[codex-lock] Acquired slot ${s}/${MAX_CONCURRENT_CLAUDE} after ${waited}s wait`, taskId);
        resolve(s);
        return;
      }
      if (Date.now() - waitStart > LOCK_TIMEOUT_MS) {
        clearInterval(timer);
        log(`[codex-lock] Timeout waiting for slot — proceeding without lock`, taskId);
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
    log(`[codex-lock] Released slot ${slot}`, taskId);
  } catch(e) {}
}

// Session switch marker written by shell helpers.
// Prefer CODEX_HOME, keep the legacy ~/.claude file readable for compatibility.
const AUTH_ACTIVE_FILES = [
  path.join(CODEX_HOME, 'auth-active.json'),
  path.join(os.homedir(), '.claude-auth-active.json'),
];

function resolveAuthActiveFile() {
  for (const file of AUTH_ACTIVE_FILES) {
    if (fs.existsSync(file)) return file;
  }
  return AUTH_ACTIVE_FILES[0];
}

function resolveClaudeAuthEnv(baseEnv, log, taskId) {
  const env = Object.assign({}, baseEnv);
  let mode = 'oauth';
  let cfg = null;
  const authActiveFile = resolveAuthActiveFile();
  try {
    if (fs.existsSync(authActiveFile)) {
      cfg = JSON.parse(fs.readFileSync(authActiveFile, 'utf8'));
      if (cfg && cfg.mode === 'relay') mode = 'relay';
    }
  } catch (e) {
    log && log(`[codex-auth] failed to read ${authActiveFile}: ${e.message} — falling back to oauth`, taskId);
  }

  if (mode === 'relay' && cfg && cfg.ANTHROPIC_BASE_URL && cfg.ANTHROPIC_AUTH_TOKEN) {
    env.ANTHROPIC_BASE_URL = cfg.ANTHROPIC_BASE_URL;
    env.ANTHROPIC_AUTH_TOKEN = cfg.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_API_KEY;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    log && log(`[codex-auth] mode=relay via ${env.ANTHROPIC_BASE_URL}`, taskId);
  } else {
    // OAuth: CC CLI uses CLAUDE_CODE_OAUTH_TOKEN / legacy ~/.claude credentials.
    // Strip relay vars so a stale ANTHROPIC_BASE_URL cannot hijack routing.
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_BASE_URL;
    log && log('[codex-auth] mode=oauth', taskId);
  }
  return env;
}

/**
 * 准备 Codex 工作目录
 * - 写入 CODEX.md（Luna 规则）
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

  // 1. CODEX.md — explicit system prompt file passed to the CLI
  const systemPromptSrc = SYSTEM_PROMPT_PATH;
  if (fs.existsSync(systemPromptSrc)) {
    const codexPromptPath = path.join(workDir, CODEX_SYSTEM_PROMPT_FILE);
    fs.copyFileSync(systemPromptSrc, codexPromptPath);
    // Legacy alias kept for any tooling that still looks for CLAUDE.md in temp dirs.
    fs.copyFileSync(systemPromptSrc, path.join(workDir, LEGACY_SYSTEM_PROMPT_FILE));
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
      log(`[codex-code] Split skeleton written: main=${skeleton.main.split('\n').length} lines, systems=${skeleton.systems.split('\n').length} lines`, taskId);
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

  // 4. GFM toolkit files → Commons/ (split from monolithic GFM_Tools.cs)
  var gfmHelper = require('./gfm-files.cjs');
  gfmHelper.copyGfmToProjectDir(workDir);
  gfmHelper.cleanupLegacyGfm(workDir);

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
# 编译验证脚本：读取 GameFlowManagerMain.cs (+ Systems.cs + Commons/GFM_*.cs) 并调用 Bridge.NET 编译
CS_FILE="Assets/Program/Script/Manager/GameFlowManagerMain.cs"
if [ ! -f "$CS_FILE" ]; then
  echo '{"ok":false,"error":"GameFlowManagerMain.cs not found"}'
  exit 1
fi

# 收集 Manager/ 和 Commons/ 下所有额外 .cs 文件
EXTRA=$(python3 -c "
import json, os, sys
extra = {}
dirs = ['Assets/Program/Script/Manager', 'Assets/Program/Script/Commons']
main_file = 'GameFlowManagerMain.cs'
for d in dirs:
    if not os.path.isdir(d): continue
    for f in os.listdir(d):
        if f.endswith('.cs') and f != main_file:
            extra[f] = open(os.path.join(d, f)).read()
print(json.dumps(extra))
" 2>/dev/null || echo '{}')

# 构建 JSON payload
python3 -c "
import json, sys
code = open(sys.argv[1]).read()
extra = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
payload = {'csCode': code, 'code': code, 'extraFiles': extra}
print(json.dumps(payload))
" "$CS_FILE" "$EXTRA" | curl -s -X POST \${BUILD_URL}/build \\
  -H "Content-Type: application/json" \\
  -d @-
`;
  fs.writeFileSync(path.join(workDir, 'build-test.sh'), buildScript, { mode: 0o755 });

  // 6. .codex/settings.local.json — 预授权所有工具（最高权限）
  const codexSettingsDir = path.join(workDir, CODEX_SETTINGS_DIRNAME);
  fs.mkdirSync(codexSettingsDir, { recursive: true });
  fs.writeFileSync(path.join(codexSettingsDir, 'settings.local.json'), JSON.stringify({
    permissions: {
      allow: [
        'Bash(*)',
        'Read(*)',
        'Write(*)',
        'Edit(*)'
      ]
    }
  }, null, 2));

  log(`[codex-code] Work dir prepared: ${workDir}`, taskId);
}

/**
 * 运行 Codex CLI code worker
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
      '--debug-file', '/tmp/codex-debug-' + (taskId || 'unknown') + '.log',  // debug log for diagnosis
      '--tools', 'Read,Write,Edit,Bash',  // only essential tools, no Glob/Grep/Agent overhead
      '--system-prompt-file', path.join(workDir, CODEX_SYSTEM_PROMPT_FILE),  // 直接传入 system prompt
    ];

    // 如果有追加系统提示（如增量修复指令）
    if (opts.appendSystemPrompt) {
      args.push('--append-system-prompt', opts.appendSystemPrompt);
    }

    log(`[codex-code] Spawning: ${CLAUDE_CMD} ${args.join(' ')}`, taskId);
    log(`[codex-code] Prompt length: ${userPrompt.length} chars`, taskId);

    // === Prompt cache hit instrumentation ===
    // Server-side prompt cache hashes the stable prefix (system prompt + tools + early user message bytes).
    // Logging sha1 of:
    //   - CODEX.md file (system prompt) — should be IDENTICAL across all tasks if cache is going to hit
    //   - userPrompt head 1000 bytes — should be identical across all tasks for the same template/skeleton
    //   - userPrompt tail 500 bytes — usually task-specific (verifies it varies as expected)
    // To check cache hit rate: grep '[prompt-cache]' on logs from multiple tasks; head sha1 should match.
    try {
      const codexMdPath = path.join(workDir, CODEX_SYSTEM_PROMPT_FILE);
      let codexMdSha = 'missing';
      let codexMdLen = 0;
      if (fs.existsSync(codexMdPath)) {
        const codexMdContent = fs.readFileSync(codexMdPath);
        codexMdSha = crypto.createHash('sha1').update(codexMdContent).digest('hex').slice(0, 12);
        codexMdLen = codexMdContent.length;
      }
      const headBytes = Buffer.from(userPrompt.slice(0, 1000), 'utf8');
      const tailBytes = Buffer.from(userPrompt.slice(-500), 'utf8');
      const headSha = crypto.createHash('sha1').update(headBytes).digest('hex').slice(0, 12);
      const tailSha = crypto.createHash('sha1').update(tailBytes).digest('hex').slice(0, 12);
      log(`[prompt-cache] CODEX.md sha1=${codexMdSha} len=${codexMdLen} | userPrompt headSha=${headSha} tailSha=${tailSha} totalLen=${userPrompt.length}`, taskId);
    } catch (cacheLogErr) {
      log(`[prompt-cache] instrumentation error: ${cacheLogErr.message}`, taskId);
    }

    // Record file mtimes before spawn to detect actual modifications (Bug fix: skeleton pre-write false positive)
    // Dynamically scan `GameFlowManagerMain*.cs` — covers Systems.cs AND the W1b 5-partial
    // split (Flow/Input/Resource/UI/Scene). A successful INCREMENTAL_FIX round may touch
    // any subset of these; a zero-edit round touches none.
    // 2026-04-15: added Systems.cs tracking (was main-only). 2026-04-20: switched to dynamic
    // scan so future partial additions (W1c, ...) don't require editing this list.
    const managerDirForMtime = path.join(opts.workDir || workDir, 'Assets', 'Program', 'Script', 'Manager');
    const watchedCsFilesForMtime = [];
    try {
      const partialFiles = fs.readdirSync(managerDirForMtime)
        .filter(function(f) { return /^GameFlowManagerMain.*\.cs$/.test(f); });
      for (const f of partialFiles) {
        watchedCsFilesForMtime.push(path.join(managerDirForMtime, f));
      }
    } catch (_e) {}
    // Fallback: at least watch the main file so detection is never empty.
    if (watchedCsFilesForMtime.length === 0) {
      watchedCsFilesForMtime.push(path.join(managerDirForMtime, 'GameFlowManagerMain.cs'));
    }
    const preSpawnMtimes = {};
    try {
      for (const f of watchedCsFilesForMtime) {
        preSpawnMtimes[f] = fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0;
      }
    } catch (_e) {}
    // Legacy var kept for any external reference — reflects the main file only
    let preSpawnMtimeMs = preSpawnMtimes[watchedCsFilesForMtime[0]] || 0;
    const spawnStartTime = Date.now();

    const cleanEnv = resolveClaudeAuthEnv(process.env, log, taskId);

    const child = spawn(CLAUDE_CMD, args, {
      cwd: workDir,
      env: cleanEnv,
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
        log(`[codex-code] Output progress: ${stdout.length} chars...`, taskId);
      }
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    // 超时保护
    const timer = setTimeout(() => {
      log(`[codex-code] ⚠️ Timeout (${CLAUDE_TIMEOUT_MS / 1000}s), killing process`, taskId);
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000);
    }, CLAUDE_TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (child.pid && process._activeChildPIDs) process._activeChildPIDs.delete(child.pid);
      log(`[codex-code] Process exited with code ${code}, stdout ${stdout.length} chars, stderr ${stderr.length} chars`, taskId);
      
      if (stderr && stderr.length > 0) {
        // 过滤掉 Claude Code 的正常 stderr 输出（进度条等）
        const significantErrors = stderr.split('\n').filter(line => {
          return line && !line.includes('Thinking') && !line.includes('⠋') && !line.includes('⠙');
        }).join('\n');
        if (significantErrors) {
          log(`[codex-code] Stderr: ${significantErrors.slice(0, 500)}`, taskId);
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
          ? `MODEL_FATAL: Codex code runner auth/quota failure — ${baseErr.slice(0, 300)}`
          : baseErr;
        log(`[codex-code] ❌ CLI error detected: exit code ${code}, elapsed ${elapsedMs}ms, stdout ${stdout.length} chars${isModelFatal ? ' (MODEL_FATAL)' : ''} — treating as hard failure`, taskId);
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
      // 2026-04-15 fix: require EITHER main OR Systems partial class to have newer mtime.
      // A zero-edit round (Claude wasted time on files that get overwritten or wrong targets)
      // is now detected even with exit code 0 and rejected as ZERO_EDITS.
      let fileActuallyModified = false;
      const modifiedFiles = [];
      try {
        if (opts.workDir) {
          for (const f of watchedCsFilesForMtime) {
            if (fs.existsSync(f)) {
              const currentMtimeMs = fs.statSync(f).mtimeMs;
              if (currentMtimeMs > (preSpawnMtimes[f] || 0)) {
                fileActuallyModified = true;
                modifiedFiles.push(path.basename(f));
              }
            }
          }
        }
      } catch (_e) {}

      if (code !== 0 && fileActuallyModified) {
        log(`[codex-code] Process exited non-zero (${code}) but code file was modified after spawn (${modifiedFiles.join(', ')}) — treating as partial success`, taskId);
      } else if (code !== 0 && !fileActuallyModified) {
        log(`[codex-code] Process exited non-zero (${code}) and no watched code file was modified — treating as failure`, taskId);
      } else if (code === 0 && !fileActuallyModified) {
        log(`[codex-code] ⚠️ Process exited 0 but NO watched .cs file was modified — ZERO-EDIT ROUND (likely the coder edited GFM_*.cs in Commons/ or similar non-target file). Treating as failure to force retry with better prompt.`, taskId);
      } else if (code === 0 && fileActuallyModified) {
        log(`[codex-code] ✅ Exit 0 and modified: ${modifiedFiles.join(', ')}`, taskId);
      }

      const trueOk = code === 0 && fileActuallyModified;

      // Build a non-constant error string when stderr is empty so that fix-loop's
      // circuit breaker does not see three identical signatures and abort prematurely.
      // Prefer stderr (most diagnostic), then the tail of stdout (actual CC output),
      // and only fall back to the generic exit-code string as a last resort.
      const _buildExitError = (exitCode, stdoutStr, stderrStr) => {
        if (stderrStr && stderrStr.trim()) return stderrStr.slice(0, 500);
        if (stdoutStr && stdoutStr.trim()) return `stdout: ${stdoutStr.slice(-500)}`;
        return `Exit code ${exitCode}`;
      };

      resolve({
        ok: trueOk,
        exitCode: code,
        output: stdout,
        error: !trueOk
          ? (code !== 0 && fileActuallyModified
              ? null  // partial success path below
              : (code === 0 && !fileActuallyModified
                  ? ('ZERO_EDITS: Claude Code exited 0 but did not modify any of the watched partial class files: '
                      + watchedCsFilesForMtime.map(function(f){ return path.basename(f); }).join(', ')
                      + '. It may have edited read-only files (e.g. Commons/GFM_*.cs) that get restored every round. Re-run with stricter prompt targeting the correct files.')
                  : _buildExitError(code, stdout, stderr)))
          : null,
        partialSuccess: code !== 0 && fileActuallyModified,
        modifiedFiles: modifiedFiles,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      log(`[codex-code] Spawn error: ${err.message}`, taskId);
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

function runCodexExecCode(workDir, userPrompt, log, taskId, opts) {
  opts = opts || {};
  var finalPrompt = opts.appendSystemPrompt
    ? ('Additional execution rules:\n' + opts.appendSystemPrompt + '\n\nTask:\n' + userPrompt)
    : userPrompt;

  return new Promise((resolve) => {
    const outputPath = path.join(workDir, 'codex-last-message.txt');
    const args = [
      'exec',
      '--skip-git-repo-check',
      '--ephemeral',
      '-m', opts.model || CODEX_CODE_MODEL,
      '-c', 'model_reasoning_effort="' + (opts.effort || 'medium') + '"',
      '-s', 'danger-full-access',
      '-C', workDir,
      '-o', outputPath,
    ];

    log(`[codex-code] Spawning codex exec: ${CODEX_CMD} ${args.join(' ')}`, taskId);
    log(`[codex-code] Prompt length: ${finalPrompt.length} chars`, taskId);

    const managerDirForMtime = path.join(opts.workDir || workDir, 'Assets', 'Program', 'Script', 'Manager');
    const watchedCsFilesForMtime = [];
    try {
      const partialFiles = fs.readdirSync(managerDirForMtime)
        .filter(function(f) { return /^GameFlowManagerMain.*\.cs$/.test(f); });
      for (const f of partialFiles) watchedCsFilesForMtime.push(path.join(managerDirForMtime, f));
    } catch (_e) {}
    if (watchedCsFilesForMtime.length === 0) {
      watchedCsFilesForMtime.push(path.join(managerDirForMtime, 'GameFlowManagerMain.cs'));
    }
    const preSpawnMtimes = {};
    try {
      for (const f of watchedCsFilesForMtime) preSpawnMtimes[f] = fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0;
    } catch (_e) {}
    const spawnStartTime = Date.now();

    const { OPENAI_API_KEY, CODEX_API_KEY, OPENAI_BASE_URL, ...cleanEnv } = process.env;
    const child = spawn(CODEX_CMD, args, {
      cwd: workDir,
      env: { ...cleanEnv, RUST_LOG: 'error' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (child.pid) {
      if (!process._activeChildPIDs) process._activeChildPIDs = new Set();
      process._activeChildPIDs.add(child.pid);
    }

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    const timer = setTimeout(() => {
      log(`[codex-code] ⚠️ Timeout (${CLAUDE_TIMEOUT_MS / 1000}s), killing process`, taskId);
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000);
    }, CLAUDE_TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (child.pid && process._activeChildPIDs) process._activeChildPIDs.delete(child.pid);
      log(`[codex-code] codex exec exited with code ${code}, stdout ${stdout.length} chars, stderr ${stderr.length} chars`, taskId);

      let fileActuallyModified = false;
      const modifiedFiles = [];
      try {
        for (const f of watchedCsFilesForMtime) {
          if (fs.existsSync(f)) {
            const currentMtimeMs = fs.statSync(f).mtimeMs;
            if (currentMtimeMs > (preSpawnMtimes[f] || 0)) {
              fileActuallyModified = true;
              modifiedFiles.push(path.basename(f));
            }
          }
        }
      } catch (_e) {}

      let finalOutput = stdout;
      try {
        if (fs.existsSync(outputPath)) finalOutput = fs.readFileSync(outputPath, 'utf8') || stdout;
      } catch (_e) {}

      const elapsedMs = Date.now() - spawnStartTime;
      const streams = (stdout || '') + '\n' + (stderr || '');
      const isModelFatal = /quota|insufficient|\b401\b|\b402\b|\b403\b|invalid.?api.?key|unauthoriz|authentication.?fail|access.?denied|billing/i.test(streams);
      const buildExitError = function(exitCode, stdoutStr, stderrStr) {
        if (stderrStr && stderrStr.trim()) return stderrStr.slice(0, 500);
        if (stdoutStr && stdoutStr.trim()) return `stdout: ${stdoutStr.slice(-500)}`;
        return `Exit code ${exitCode}`;
      };

      if (code !== 0 && elapsedMs < 10000 && stdout.length < 200 && !fileActuallyModified) {
        const baseErr = stdout || stderr || `CLI error: exit code ${code} in ${elapsedMs}ms`;
        return resolve({
          ok: false,
          exitCode: code,
          output: finalOutput,
          error: isModelFatal
            ? `MODEL_FATAL: Codex code runner auth/quota failure — ${baseErr.slice(0, 300)}`
            : baseErr,
          partialSuccess: false,
        });
      }

      const trueOk = code === 0 && fileActuallyModified;
      resolve({
        ok: trueOk,
        exitCode: code,
        output: finalOutput,
        error: !trueOk
          ? (code !== 0 && fileActuallyModified
              ? null
              : (code === 0 && !fileActuallyModified
                  ? ('ZERO_EDITS: codex exec exited 0 but did not modify any watched GameFlowManagerMain*.cs file.')
                  : buildExitError(code, stdout, stderr)))
          : null,
        partialSuccess: code !== 0 && fileActuallyModified,
        modifiedFiles: modifiedFiles,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: -1,
        output: '',
        error: err.message,
        partialSuccess: false,
      });
    });

    child.stdin.write(finalPrompt);
    child.stdin.end();
  });
}

/**
 * runCodexText — 文本模式 CLI spawn
 *
 * 用于 patchRecode / visual-check 等 "给一段输入(+可选附件文件), 拿一段文本输出" 场景。
 * 和 runClaudeCode 的关键区别:
 *   - 不需要 Unity 工程目录; 自己创建 /tmp/codex-text-<taskId>-XXX 临时 workDir
 *   - 不做 mtime 检查; ok 判据只看 exit code === 0 && stdout.length >= minOutputLen
 *   - tools 缩到 Read(最小权限, 视觉也靠 Read 加载图片)
 *   - systemPrompt 写到临时 CODEX.md 作为 --system-prompt-file 传入
 *   - opts.additionalFiles 预写到 workDir, 供 prompt 里指令模型 Read (图片/附件)
 *
 * 设计目的: 让所有本来直连 Claude API 的场景(patchRecode / visual-check)统一走
 * CC CLI relay, 故障特征、MODEL_FATAL 检测、计费归一。
 *
 * @param {object} opts
 * @param {string} opts.systemPrompt - 写入 CODEX.md 的系统提示
 * @param {string} opts.userPrompt - 经 stdin 喂给 CLI 的用户消息
 * @param {object} [opts.additionalFiles] - 可选 {filename: Buffer|string}, 写入 workDir 根
 * @param {string} [opts.model] - 默认 claude-sonnet-4-6
 * @param {string} [opts.effort] - 默认 medium
 * @param {number} [opts.timeoutMs] - 默认 240000 (4min)
 * @param {number} [opts.minOutputLen] - 成功判据最小 stdout 长度, 默认 50
 * @param {function} [opts.log]
 * @param {string} [opts.taskId]
 * @returns {Promise<{ok, text, exitCode, error}>}
 */
function runCodexText(opts) {
  opts = opts || {};
  const log = opts.log || function() {};
  const taskId = opts.taskId || 'text';
  const textRunnerMode = opts.backend || DEFAULT_TEXT_RUNNER_MODE;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-text-' + taskId + '-'));
  const execDir = opts.workDir || tempDir;
  const cleanupTempDir = !opts.workDir;

  return new Promise(function(resolve) {
    const finish = function(result) {
      if (cleanupTempDir) {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch(_) {}
      }
      resolve(result);
    };

    // 1. 写 CODEX.md (system prompt)
    try {
      fs.writeFileSync(path.join(tempDir, CODEX_SYSTEM_PROMPT_FILE), opts.systemPrompt || 'You are a helpful assistant.');
    } catch(e) {
      return finish({ ok: false, error: 'Failed to write CODEX.md: ' + e.message });
    }
    // Codex exec currently cannot take a custom system prompt in headless mode.
    // Mirror the same content into AGENTS.md for the experimental exec backend.
    try {
      fs.writeFileSync(path.join(tempDir, CODEX_AGENTS_FILE), opts.systemPrompt || 'You are a helpful assistant.');
    } catch(e) {
      return finish({ ok: false, error: 'Failed to write AGENTS.md: ' + e.message });
    }

    // 2. 写附件文件 (图片或任何需要 Read 的 blob)
    if (opts.additionalFiles) {
      try {
        const names = Object.keys(opts.additionalFiles);
        for (const fname of names) {
          fs.writeFileSync(path.join(tempDir, fname), opts.additionalFiles[fname]);
        }
        log('[codex-text] wrote ' + names.length + ' additional file(s) to ' + execDir, taskId);
      } catch(e) {
        return finish({ ok: false, error: 'Failed to write additional files: ' + e.message });
      }
    }

    const runClaudePrintBackend = function() {
      const args = [
      '--print',
      '--model', opts.model || 'claude-sonnet-4-6',
      '--output-format', 'text',
      '--effort', opts.effort || 'medium',
      '--system-prompt-file', path.join(tempDir, CODEX_SYSTEM_PROMPT_FILE),
      '--debug-file', '/tmp/codex-text-' + taskId + '.log',
      ];
      // noTools: skip --tools Read → pure text generation, single API round trip
      if (!opts.noTools) {
        args.push('--tools', 'Read');
      }

      log('[codex-text] Spawning: ' + CLAUDE_CMD + ' ' + args.join(' '), taskId);
      log('[codex-text] systemPrompt=' + (opts.systemPrompt || '').length + 'c userPrompt=' + (opts.userPrompt || '').length + 'c cwd=' + execDir, taskId);

      const cleanEnv = resolveClaudeAuthEnv(process.env, log, taskId);
      // PM2 cluster mode drops proxy vars from process.env despite them being in
      // /proc/PID/environ. CC CLI needs the proxy to reach api.anthropic.com.
      // Hard-code fallback — this host requires proxy for outbound HTTPS.
      if (!cleanEnv.HTTPS_PROXY && !cleanEnv.https_proxy) {
        cleanEnv.HTTPS_PROXY = 'http://127.0.0.1:7890';
        cleanEnv.HTTP_PROXY = 'http://127.0.0.1:7890';
        cleanEnv.NO_PROXY = 'localhost,127.0.0.1,120.55.70.226,crs.mindrix.app,*.mindrix.app,*.volces.com,*.siliconflow.cn';
        log('[codex-text] Injected proxy vars (PM2 cluster mode workaround)', taskId);
      }

      const child = spawn(CLAUDE_CMD, args, {
        cwd: execDir,
        env: cleanEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (child.pid) {
        if (!process._activeChildPIDs) process._activeChildPIDs = new Set();
        process._activeChildPIDs.add(child.pid);
      }

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', function(d) { stdout += d.toString(); });
      child.stderr.on('data', function(d) { stderr += d.toString(); });

      const timeoutMs = opts.timeoutMs || 240000;
      const timer = setTimeout(function() {
        log('[codex-text] ⚠️ Timeout ' + (timeoutMs / 1000) + 's, killing', taskId);
        child.kill('SIGTERM');
        setTimeout(function() { child.kill('SIGKILL'); }, 5000);
      }, timeoutMs);

      child.on('close', function(code) {
        clearTimeout(timer);
        if (child.pid && process._activeChildPIDs) process._activeChildPIDs.delete(child.pid);
        log('[codex-text] exit=' + code + ' stdout=' + stdout.length + 'c stderr=' + stderr.length + 'c', taskId);

        // MODEL_FATAL 检测 (镜像 runClaudeCode line 413-419 规则)
        const streams = (stdout || '') + '\n' + (stderr || '');
        const isModelFatal = /quota|insufficient|\b401\b|\b402\b|\b403\b|invalid.?api.?key|unauthoriz|authentication.?fail|access.?denied|billing/i.test(streams);

        const minOutputLen = opts.minOutputLen != null ? opts.minOutputLen : 50;
        if (code === 0 && stdout.length >= minOutputLen) {
          return finish({ ok: true, text: stdout, exitCode: 0, backend: 'claude-print' });
        }
        // Build a non-constant error string: prefer stderr, then stdout tail, then generic.
        const baseErr = (stderr && stderr.trim()) ? stderr
          : (stdout && stdout.trim()) ? `stdout: ${stdout.slice(-500)}`
          : `Exit code ${code}`;
        const errorMsg = isModelFatal
          ? 'MODEL_FATAL: Codex text runner auth/quota — ' + baseErr.slice(0, 300)
          : baseErr.slice(0, 500);
        finish({ ok: false, text: stdout, exitCode: code, error: errorMsg, backend: 'claude-print' });
      });

      child.on('error', function(err) {
        clearTimeout(timer);
        finish({ ok: false, error: 'spawn error: ' + err.message, backend: 'claude-print' });
      });

      try {
        child.stdin.write(opts.userPrompt || '');
        child.stdin.end();
      } catch(e) {
        clearTimeout(timer);
        finish({ ok: false, error: 'stdin write error: ' + e.message, backend: 'claude-print' });
      }
    };

    if (textRunnerMode === 'codex-exec') {
      return runCodexExecText(execDir, tempDir, opts, log, taskId, function(result) {
        var allowFallback = opts.allowBackendFallback !== false;
        if (!result.ok && allowFallback) {
          log('[codex-text] codex-exec failed, auto-fallback to claude-print: ' + (result.error || 'unknown error').slice(0, 200), taskId);
          return runClaudePrintBackend();
        }
        return finish(result);
      });
    }

    return runClaudePrintBackend();
  });
}

function runCodexExecText(execDir, tempDir, opts, log, taskId, finish) {
  const outputPath = path.join(tempDir, 'codex-last-message.txt');
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '-m', opts.model || 'gpt-5.4',
    '-c', 'model_reasoning_effort="' + (opts.effort || 'medium') + '"',
    '-s', opts.execSandbox || 'read-only',
    '-C', execDir,
    '-o', outputPath,
  ];

  log('[codex-text] Spawning experimental exec backend: ' + CODEX_CMD + ' ' + args.join(' '), taskId);
  log('[codex-text] backend=codex-exec systemPrompt=' + (opts.systemPrompt || '').length + 'c userPrompt=' + (opts.userPrompt || '').length + 'c cwd=' + execDir, taskId);

  // Match codex-reviewer behavior: prefer ChatGPT auth / CODEX_HOME and avoid
  // accidentally forcing API-key mode via unrelated blueprint-editor env vars.
  const { OPENAI_API_KEY, CODEX_API_KEY, OPENAI_BASE_URL, ...cleanEnv } = process.env;
  const child = spawn(CODEX_CMD, args, {
    cwd: execDir,
    env: { ...cleanEnv, RUST_LOG: 'error' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (child.pid) {
    if (!process._activeChildPIDs) process._activeChildPIDs = new Set();
    process._activeChildPIDs.add(child.pid);
  }

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', function(d) { stdout += d.toString(); });
  child.stderr.on('data', function(d) { stderr += d.toString(); });

  const timeoutMs = opts.timeoutMs || 240000;
  const timer = setTimeout(function() {
    log('[codex-text] ⚠️ codex exec timeout ' + (timeoutMs / 1000) + 's, killing', taskId);
    child.kill('SIGTERM');
    setTimeout(function() { child.kill('SIGKILL'); }, 5000);
  }, timeoutMs);

  child.on('close', function(code) {
    clearTimeout(timer);
    if (child.pid && process._activeChildPIDs) process._activeChildPIDs.delete(child.pid);

    let lastMessage = '';
    try {
      if (fs.existsSync(outputPath)) lastMessage = fs.readFileSync(outputPath, 'utf8');
    } catch (_) {}

    log('[codex-text] codex-exec exit=' + code + ' last=' + lastMessage.length + 'c stdout=' + stdout.length + 'c stderr=' + stderr.length + 'c', taskId);

    const streams = [lastMessage, stdout, stderr].join('\n');
    const isModelFatal = /quota|insufficient|\b401\b|\b402\b|\b403\b|invalid.?api.?key|unauthoriz|authentication.?fail|access.?denied|billing/i.test(streams);
    const minOutputLen = opts.minOutputLen != null ? opts.minOutputLen : 50;
    if (code === 0 && lastMessage.length >= minOutputLen) {
      return finish({ ok: true, text: lastMessage, exitCode: 0, backend: 'codex-exec' });
    }

    const baseErr = (stderr && stderr.trim()) ? stderr
      : (lastMessage && lastMessage.trim()) ? ('lastMessage: ' + lastMessage.slice(-500))
      : (stdout && stdout.trim()) ? ('stdout: ' + stdout.slice(-500))
      : ('Exit code ' + code);
    const errorMsg = isModelFatal
      ? 'MODEL_FATAL: Codex exec text auth/quota — ' + baseErr.slice(0, 300)
      : baseErr.slice(0, 500);
    finish({ ok: false, text: lastMessage || stdout, exitCode: code, error: errorMsg, backend: 'codex-exec' });
  });

  child.on('error', function(err) {
    clearTimeout(timer);
    finish({ ok: false, error: 'spawn error: ' + err.message, backend: 'codex-exec' });
  });

  try {
    child.stdin.write(opts.userPrompt || '');
    child.stdin.end();
  } catch(e) {
    clearTimeout(timer);
    finish({ ok: false, error: 'stdin write error: ' + e.message, backend: 'codex-exec' });
  }
}

function buildFeedbackText(feedbackItem) {
  if (!feedbackItem) return '';
  if (feedbackItem.data && feedbackItem.data.text) return feedbackItem.data.text;
  if (feedbackItem.message) return feedbackItem.message;
  if (feedbackItem.text) return feedbackItem.text;
  return JSON.stringify(feedbackItem);
}

function stripGenericMethodCallsForLuna(src) {
  let next = String(src || '');
  next = next.replace(/Resources\.GetBuiltinResource\s*<\s*([A-Za-z_][A-Za-z0-9_]*)\s*>\s*\(([^)]+)\)/g, '($1)Resources.GetBuiltinResource(typeof($1), $2)');
  next = next.replace(/FindObjectOfType\s*<\s*([A-Za-z_][A-Za-z0-9_]*)\s*>\s*\(\s*\)/g, '($1)FindObjectOfType(typeof($1))');
  next = next.replace(/\.GetComponent\s*<\s*([A-Za-z_][A-Za-z0-9_.]*)\s*>\s*\(\s*\)/g, '.GetComponent(typeof($1)) as $1');
  return next;
}

function applyLunaPostFixesToManagerPartials(clientDir, log, taskId) {
  const managerDir = path.join(clientDir, 'Assets', 'Program', 'Script', 'Manager');
  let files = [];
  try {
    files = fs.readdirSync(managerDir)
      .filter(function(file) { return /^GameFlowManagerMain.*\.cs$/.test(file); })
      .sort();
  } catch (_err) {
    files = [];
  }
  let changedFiles = [];
  for (const fileName of files) {
    const filePath = path.join(managerDir, fileName);
    let src;
    try {
      src = fs.readFileSync(filePath, 'utf-8');
    } catch (_err) {
      continue;
    }
    const next = stripGenericMethodCallsForLuna(src);
    if (next !== src) {
      fs.writeFileSync(filePath, next);
      changedFiles.push(fileName);
    }
  }
  if (changedFiles.length > 0) {
    log('[codex-code] Post-fix: stripped generic method calls for Luna compatibility in ' + changedFiles.join(', '), taskId);
  }
  return changedFiles;
}

/**
 * 主入口：generateWithCodex
 * 
 * 替代 generateCodeV5 的 callClaudeWithRetry 部分。
 * 保留原有的 V5 prompt 生成逻辑（对象分配表等），但让 Codex worker 自己读文件、写代码、编译验证。
 */
async function generateWithCodex(blueprint, clientDir, log, taskId, engine) {
  if (engine === 'cocos') {
    log('[codex-code] Cocos not supported, falling back to V4 API', taskId);
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
  log(`[codex-code] V5 prompt generated: ${prompt.length} chars, mode=${hasFeedback ? 'INCREMENTAL_FIX' : 'FULL_GENERATION'}`, taskId);

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
        log(`[codex-code] Using blueprint.specs (DB): ${specs.length} phase specs — single source of truth`, taskId);
      }
      // Fallback: try cached spec-data
      if (!specs || specs.length === 0) {
        specs = specExtractor.loadSpecs(taskId, specsDataDir);
        if (specs && specs.length > 0) {
          log(`[codex-code] Using cached specs: ${specs.length} phase specs — re-validating entity names`, taskId);
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
              log('[codex-code] Cached specs have entity mismatches — re-extracting', taskId);
              specs = null;
            }
          }
        }
      }
      // Last resort: extract fresh (and save to both spec-data and blueprint)
      if (!specs || specs.length === 0) {
        log('[codex-code] Extracting specs from storyboard frames...', taskId);
        specs = await specExtractor.extractSpecs(storyboardFrames, {
          projectName: blueprint.projectName || taskId,
          gameType: blueprint.gameType || 'SLG',
          entities: blueprint.entities || [],
        });
        log(`[codex-code] Extracted ${specs.length} phase specs`, taskId);
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
        entityPoolMap: entityPoolMap,
        entities: blueprint.entities || []
      });
      const skelLines = typeof skeleton === 'string' ? skeleton.split('\n').length
        : ((skeleton.main || '').split('\n').length + (skeleton.systems || '').split('\n').length);
      log(`[codex-code] Skeleton generated: ${skelLines} lines (${activeSpecs.length}/${specs.length} phases)`, taskId);
    } catch (specErr) {
      log(`[codex-code] Spec extraction failed (non-fatal): ${specErr.message}`, taskId);
    }
  }

  // === Step 3: 准备工作目录 ===
  prepareWorkDir(clientDir, blueprint, prompt, skeleton, log, taskId);

  // === Step 4: 构建用户 Prompt ===
  let userPrompt;
  if (hasFeedback) {
    // Extract feedback text to inject directly into prompt (don't rely on AI reading prompt.md)
    const feedbackTexts = blueprint.feedbackHistory.map(buildFeedbackText).join('\n---\n');
    const allowedPools = Array.from(new Set(Object.values(promptV5Module.matchPrefabs(blueprint.entities || []))));

    // Dynamically enumerate partial class files on disk so W1b 5-partial (or future W1c)
    // gets listed in whitelist / Read step / ZERO_EDITS warning without hardcoding names.
    const managerDirForList = path.join(clientDir, 'Assets', 'Program', 'Script', 'Manager');
    let partialFilesList = [];
    try {
      partialFilesList = fs.readdirSync(managerDirForList)
        .filter(function(f) { return /^GameFlowManagerMain.*\.cs$/.test(f); })
        .sort();
    } catch (_e) {}
    if (partialFilesList.length === 0) partialFilesList = ['GameFlowManagerMain.cs'];
    const whitelistBlock = partialFilesList.map(function(f) {
      return '- `Assets/Program/Script/Manager/' + f + '`';
    }).join('\n');
    const partialNamesInline = partialFilesList.join(' / ');
    log('[codex-code] INCREMENTAL_FIX watched partials: ' + partialNamesInline, taskId);

    userPrompt = `## 增量修复模式

⚠️ 这是一个 FIX 请求。保持现有代码结构，只修改反馈要求的部分。
⚠️ 禁止重写整个文件！使用 Edit 工具做局部修改。

### ⛔ 允许修改的文件（WHITELIST — 只能改这些 partial class 文件）
${whitelistBlock}

所有上述文件都是 \`partial class GameFlowManagerMain\`，共享字段与方法签名。**Phase 分派逻辑（\`Phase_<id>_OnTap()\`）在 \`GameFlowManagerMain.Flow.cs\`（如存在）里，不要去主文件找**；游戏子系统在 \`GameFlowManagerMain.Systems.cs\`（如存在）里。按文件名语义定位要改的位置。

### ⛔ 禁止修改的文件（READ-ONLY — 改了等于白做）
- \`Assets/Program/Script/Commons/GFM_*.cs\` — 工具库文件，每轮结束会被 canonical 版本覆盖。你对它做的任何修改都会被 wipe 掉，纯属浪费时间
- \`prompt.md\`, \`CODEX.md\`, \`GFM_Tools_API.md\` — 需求/参考文档
- 任何 \`build-*.sh\` 脚本

### ⛔ 静态违规的修复原则
如果反馈里的违规定位在 \`GFM_*.cs\`（例如 "GFM_UI.cs L133: SetActive() forbidden"），**不要去改 Commons/ 下的 GFM_*.cs 文件**（它们是 canonical toolkit，不能碰）。违规的真实原因是你的 GameFlowManagerMain*.cs 中某处调用了会触发这个模式的代码，或者是你自己复制了同名方法/重新实现了类似函数。**去 WHITELIST 列出的 partial 文件里找禁用 API 的调用并删除/替换**。

### ⛔ 当前任务的硬约束
- 禁止使用泛型 API：\`GetComponent<T>()\`、\`FindObjectOfType<T>()\`、\`Resources.GetBuiltinResource<T>()\`
- 如果某个 phase gate 用 \`EntityAdvanced(X, _snap_XPos)\`，那么 **X 必须在 OnTap / OnAutoPlayArrive / 运行时交互里再次移动**
- 只在 \`Phase_<id>_Init()\` 里移动 X 不算 phase 完成
- 禁止发明新的 pool literal 或动态拼接 \`__Pool_*\`
- 当前任务允许的 pool literal 只有这些：${allowedPools.map(function(pool) { return '`' + pool + '`'; }).join(', ')}

## CUA 验证反馈（必须修复以下问题）：
${feedbackTexts}

请完成以下步骤：
1. 仔细阅读上面的 CUA 反馈，理解具体失败原因
2. 阅读 prompt.md 了解完整需求
3. Read 所有 WHITELIST 列出的 partial 文件（${partialFilesList.length} 个）— 完整理解现有代码分布后再动手
4. 根据 CUA 反馈做**针对性修改**（使用 Edit 工具，不是 Write）— **只能改上面 WHITELIST 里的文件**
5. 如果反馈说缺少 phase，必须添加完整的 phase 实现代码（通常在 Flow.cs 的 \`Phase_<id>_OnTap()\` 里）
6. 如果反馈说 phase-skipped/game_ended，检查 phase 过渡条件是否正确（不能用 true 占位）
7. 运行 bash build-test.sh 验证编译
8. 如果编译失败，修复错误并重试
9. 编译通过后完成

重要：修改后文件行数不应减少。如果你发现文件变短了，说明你错误地重写了整个文件。
重要：如果你一轮结束时没有对任何一个 WHITELIST 里的 partial 文件做 Edit，这一轮会被判定为 ZERO_EDITS 失败并强制重试 — 所以确保你的 Edit 目标正确。`;
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

${inlineGfmApi ? '### GFM API 参考（完整 API 表面 — 不要 Read Commons/GFM_*.cs，所有可用方法都在下面）\n' + inlineGfmApi + '\n⛔ DO NOT Read GFM_*.cs in Commons/ (~48KB total) — its complete public API is already inlined above. Reading the source file wastes tokens and gives you no extra information.\n\n' : ''}
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

${inlineGfmApi ? '### GFM API 参考（完整 API 表面 — 不要 Read Commons/GFM_*.cs，所有可用方法都在下面）\n' + inlineGfmApi + '\n⛔ DO NOT Read GFM_*.cs in Commons/ (~48KB total) — its complete public API is already inlined above. Reading the source file wastes tokens and gives you no extra information.\n\n' : ''}
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

${inlineGfmApi ? '### GFM API 参考（完整 API 表面 — 不要 Read Commons/GFM_*.cs，所有可用方法都在下面）\n' + inlineGfmApi + '\n⛔ DO NOT Read GFM_*.cs in Commons/ (~48KB total) — its complete public API is already inlined above. Reading the source file wastes tokens and gives you no extra information.\n\n' : ''}
### 详细需求
${inlinePromptMd}

## 指令

1. 基于上面的需求，生成完整的 GameFlowManagerMain.cs 代码
2. 用 Write 工具写入 Assets/Program/Script/Manager/GameFlowManagerMain.cs（注意：先 Read 一下文件）
3. 运行 bash build-test.sh 验证编译
4. 如果编译失败，用 Edit 工具修复，再次运行 build-test.sh

代码必须完整（1300-1600 行），不要省略任何部分。`;
  }

  // === Step 5: 运行代码 agent（跨进程信号量，限制并发数）===
  const slot = await acquireLock(taskId, log);
  log('[codex-code] 🚀 Starting Codex code agent...', taskId);
  let result;
  try {
  const codegenBackend = CODEX_CODE_BACKEND;
  const codegenModel = codegenBackend === 'codex-exec' ? CODEX_CODE_MODEL : CLAUDE_MODEL;
  log(`[codex-code] Backend: ${codegenBackend}`, taskId);
  log(`[codex-code] Model: ${codegenModel}`, taskId);
  result = await (codegenBackend === 'codex-exec' ? runCodexExecCode : runClaudeCode)(clientDir, userPrompt, log, taskId, {
    model: codegenModel,
    // effort: always 'medium' to avoid API stream timeout (5min) during extended thinking
    // INCREMENTAL FIX MODE rules — kept minimal. The ⛔ FORBIDDEN PATTERNS block
    // that used to live here was removed 2026-04-14 because it fully duplicated
    // luna-codex-code.md §L87-98 (autoPlay gates, _autoInteractTimer ≥3f,
    // safety net ≥50f, ruleTriggered[], VISUAL FREEZE, phaseId preservation).
    // Sending it twice wasted ~750 bytes per fix round with zero additional signal.
    // Only the FIX-ONLY rules (Edit-not-Write, no-rewrite, Read-first) stay here
    // because they'd confuse fresh-gen tasks if moved into CLAUDE.md.
    appendSystemPrompt: hasFeedback
      ? 'INCREMENTAL FIX MODE — CRITICAL RULES:\n'
        + '1. Use the Edit tool (NOT Write) to modify .cs files\n'
        + '2. NEVER rewrite the entire file — only change the specific lines that need fixing\n'
        + '3. The existing code is split across multiple `partial class GameFlowManagerMain` files under Assets/Program/Script/Manager/ (e.g. GameFlowManagerMain.cs + GameFlowManagerMain.Flow.cs + .Input.cs + .Resource.cs + .UI.cs + .Scene.cs + .Systems.cs). All of these share fields with the main file. Your edits must preserve all existing code.\n'
        + '4. Read ALL existing GameFlowManagerMain*.cs partial files FIRST, then apply targeted edits based on the feedback. Do NOT invent file names — use `ls` or `Glob` on the Manager/ directory to discover which partials actually exist.\n'
        + '5. If any file becomes shorter after your edits, you have made a mistake.\n'
        + '6. Phase dispatch logic (Phase_OnTap, Phase_<id>_OnTap, per-phase trigger checks) lives in GameFlowManagerMain.Flow.cs when that file exists — edit Flow.cs for phase advancement / tap handling / visual-freeze fixes. Systems.cs (if present) owns game subsystems — edit it for movement/combat/spawning/economy fixes.'
      : null,
    workDir: clientDir,
  });
  } finally {
    releaseLock(slot, taskId, log);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`[codex-code] Agent finished in ${elapsed}s, ok=${result.ok}`, taskId);

  if (!result.ok) {
    return {
      ok: false,
      error: `Codex code runner failed (exit ${result.exitCode}): ${(result.error || '').slice(0, 500)}`,
    };
  }

  // === Step 6: 验证输出 ===
  const mainFilePath = path.join(clientDir, 'Assets', 'Program', 'Script', 'Manager', 'GameFlowManagerMain.cs');
  
  if (!fs.existsSync(mainFilePath)) {
    log('[codex-code] ❌ GameFlowManagerMain.cs not found after Codex code run', taskId);
    return {
      ok: false,
      error: 'Codex code runner did not generate GameFlowManagerMain.cs',
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
    log(`[codex-code] ✅ Code generated (split): main=${mainLineCount} lines + systems=${systemsLineCount} lines = ${lineCount} total, ${findCalls} Find() calls`, taskId);
  } else {
    log(`[codex-code] ✅ Code generated: ${lineCount} lines, ${findCalls} Find() calls, ${gfmCreateCalls} GFM_Create.Obj() calls`, taskId);
  }

  // === 增量修复回退保护：如果修复后代码变短了超过 30%，恢复原始代码 ===
  if (hasFeedback && opts.existingCode) {
    const origLines = opts.existingCode.split('\n').length;
    // Compare combined line count (main+systems) against original main file
    if (lineCount < origLines * 0.7) {
      log(`[codex-code] ⚠️ REGRESSION DETECTED: code shrank from ${origLines} to ${lineCount} lines (${Math.round((1 - lineCount/origLines) * 100)}% reduction). Restoring original.`, taskId);
      fs.writeFileSync(mainFilePath, opts.existingCode);
      return {
        ok: false,
        error: `Incremental fix regressed code from ${origLines} to ${lineCount} lines — restored original`,
        regression: true,
      };
    }
  }

  if (gfmCreateCalls > 0) {
    log('[codex-code] ⚠️ WARNING: AI used GFM_Create.Obj() — should use Find() instead', taskId);
  }
  if (!hasGameEnded) {
    log('[codex-code] ⚠️ WARNING: No GameEnded() call', taskId);
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
        ? `Skeleton unmodified (${skeletonLineCount}→${lineCount} lines, ${realTodoCount} unfilled TODOs) — codex code runner likely timed out`
        : `0 Find() and 0 GFM_Create.Obj() calls (no objects created)`;
    log(`[codex-code] ❌ STUB CODE DETECTED: ${stubReason}. Rejecting output.`, taskId);
    // 清空 feedbackHistory 强制下一轮走 FULL_GENERATION
    if (blueprint.feedbackHistory && blueprint.feedbackHistory.length > 0) {
      log('[codex-code] Clearing feedbackHistory to force FULL_GENERATION on next attempt', taskId);
      blueprint.feedbackHistory.length = 0;
    }
    return {
      ok: false,
      error: `Stub code detected (${lineCount} lines, ${findCalls} Find calls, growth=${codeGrowthRatio.toFixed(1)}x) — need full regeneration`,
      stubDetected: true,
    };
  }
  if (codeGrowthRatio < 3 && codeGrowthRatio >= 1.5) {
    log(`[codex-code] ⚠️ WARNING: Code only grew ${codeGrowthRatio.toFixed(1)}x from skeleton (${skeletonLineCount}→${lineCount}). May be partially filled.`, taskId);
  }

  // Post-fix: 替换所有 partial 文件中的泛型方法（Luna 不支持）
  applyLunaPostFixesToManagerPartials(clientDir, log, taskId);

  // 确保 GFM toolkit 文件是正版 → Commons/
  var gfmHelper2 = require('./gfm-files.cjs');
  gfmHelper2.copyGfmToProjectDir(clientDir);
  gfmHelper2.cleanupLegacyGfm(clientDir);

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

module.exports = {
  generateWithCodex,
  runCodexText,
  buildFeedbackText,
  stripGenericMethodCallsForLuna,
  applyLunaPostFixesToManagerPartials,

  // Legacy export names kept for non-migrated callers.
  generateWithClaudeCode: generateWithCodex,
  runClaudeCodeText: runCodexText,
};