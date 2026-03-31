/**
 * Claude Code Coder — 用 Claude Code CLI 替代 API 调用生成 Luna 代码
 * 
 * 方案 B：Claude Code 以 agent 模式工作，自己读文件、写代码、编译验证、修 bug
 * 
 * 依赖：claude CLI 已安装且环境变量已配置（ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY）
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

// 复用现有 prompt 模块
const promptV5Module = require('./prompt-v5-basetemplate.js');

// Spec 系统（可选）
let specExtractor, skeletonGenerator;
try {
  specExtractor = require('../spec-extractor.cjs');
  skeletonGenerator = require('../skeleton-generator.cjs');
} catch (e) {}

// ============ Config ============
const CLAUDE_CMD = process.env.CLAUDE_CMD || 'claude';
const CLAUDE_TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS) || 20 * 60 * 1000; // 20 min (12 min timed out when 3 tasks run concurrently through proxy)
const CLAUDE_MAX_BUDGET = process.env.CLAUDE_MAX_BUDGET_USD || '5';
const CLAUDE_MODEL = process.env.CLAUDE_CODE_MODEL || 'claude-opus-4-6';
const GLM_MODEL = process.env.GLM_MODEL || 'glm-5.1';
const GLM_API_BASE = process.env.GLM_API_BASE || 'https://api.aaxe.cn/api/anthropic';
const GLM_API_KEY = process.env.GLM_API_KEY || 'oki-d82fb9cf928492b23847db9569dd1f912906cc09135c62fe20b5fa3f0576';
const SYSTEM_PROMPT_PATH = path.join(__dirname, 'luna-claude-code.md');
const BUILD_URL = process.env.LINUX_BUILD_URL || 'http://localhost:3080';

// ============ Global concurrency lock — DISABLED (allow parallel Claude Code) ============
async function acquireLock(taskId, log) {
  log(`[claude-lock] Lock disabled, proceeding immediately`, taskId);
  return true;
}

function releaseLock(taskId, log) {
  // no-op
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
    fs.writeFileSync(csPath, skeleton);
    // 同时在 prompt.md 末尾加一行提示
    fs.appendFileSync(path.join(workDir, 'prompt.md'),
      '\n\n## CODE SKELETON\n\n'
      + '⚠️ 骨架代码已预写入 `Assets/Program/Script/Manager/GameFlowManagerMain.cs`。\n'
      + '请直接在该文件上修改和填充 TODO，不需要从头创建文件。\n'
      + '规则：不要删除 [SKELETON] 标记行、phaseTimer 检查、CheckEventRules() 跳转条件。\n');
  }

  // 4. GFM_Tools.cs — API 参考
  const gfmSrc = path.join(__dirname, 'GFM_Tools.cs');
  if (fs.existsSync(gfmSrc)) {
    fs.copyFileSync(gfmSrc, path.join(managerDir, 'GFM_Tools.cs'));
    // 也在根目录放一份，方便 Claude Code 找到
    fs.copyFileSync(gfmSrc, path.join(workDir, 'GFM_Tools.cs'));
  }

  // 5. behavior-templates.md
  const behaviorSrc = path.join(__dirname, 'behavior-templates.md');
  if (fs.existsSync(behaviorSrc)) {
    fs.copyFileSync(behaviorSrc, path.join(workDir, 'behavior-templates.md'));
  }

  // 6. 创建 build-test.sh — 方便 Claude Code 调用编译验证
  const buildScript = `#!/bin/bash
# 编译验证脚本：读取 GameFlowManagerMain.cs 并调用 Bridge.NET 编译
CS_FILE="Assets/Program/Script/Manager/GameFlowManagerMain.cs"
if [ ! -f "$CS_FILE" ]; then
  echo '{"ok":false,"error":"GameFlowManagerMain.cs not found"}'
  exit 1
fi

# 读取 C# 代码并发送到编译服务
CODE=$(cat "$CS_FILE")

# 同时读取 GFM_Tools.cs
EXTRA=""
GFM_FILE="Assets/Program/Script/Manager/GFM_Tools.cs"
if [ -f "$GFM_FILE" ]; then
  GFM_CODE=$(cat "$GFM_FILE")
  EXTRA=$(python3 -c "import json,sys; print(json.dumps({'GFM_Tools.cs': open(sys.argv[1]).read()}))" "$GFM_FILE" 2>/dev/null || echo '{}')
fi

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
payload = {'code': code, 'extraFiles': extra}
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
      '--model', (opts.useGlm ? GLM_MODEL : CLAUDE_MODEL),
      '--output-format', 'text',
      '--max-budget-usd', CLAUDE_MAX_BUDGET,
      '--no-session-persistence',              // 不保存 session（每次全新）
      '--system-prompt-file', path.join(workDir, 'CLAUDE.md'),  // 直接传入 system prompt
    ];

    // 如果有追加系统提示（如增量修复指令）
    if (opts.appendSystemPrompt) {
      args.push('--append-system-prompt', opts.appendSystemPrompt);
    }

    log(`[claude-code] Spawning: ${CLAUDE_CMD} ${args.join(' ')}`, taskId);
    log(`[claude-code] Prompt length: ${userPrompt.length} chars`, taskId);

    const child = spawn(CLAUDE_CMD, args, {
      cwd: workDir,
      env: {
        ...process.env,
        // 确保用正确的 API 配置
        ANTHROPIC_BASE_URL: opts.useGlm ? GLM_API_BASE : (process.env.ANTHROPIC_BASE_URL || 'https://chat.nuoda.vip/claudecode'),
        ANTHROPIC_API_KEY: opts.useGlm ? GLM_API_KEY : (process.env.ANTHROPIC_API_KEY || ''),
        // 禁止 Claude Code 在内部再次尝试 OAuth
        CLAUDE_CODE_SIMPLE: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

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

      // 即使超时(143)或非零退出，也检查文件是否已生成
      // Claude Code 可能在被 kill 前已经写好了文件
      const mainFile = path.join(opts.workDir || '', 'Assets', 'Program', 'Script', 'Manager', 'GameFlowManagerMain.cs');
      const fileExists = opts.workDir && fs.existsSync(mainFile);
      
      if (code !== 0 && fileExists) {
        log(`[claude-code] Process exited non-zero (${code}) but code file exists — treating as partial success`, taskId);
      }

      resolve({
        ok: code === 0 || fileExists,  // 文件存在就算成功
        exitCode: code,
        output: stdout,
        error: (code !== 0 && !fileExists) ? (stderr || `Exit code ${code}`) : null,
        partialSuccess: code !== 0 && fileExists,
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
      log('[claude-code] Extracting specs from storyboard frames...', taskId);
      const specs = await specExtractor.extractSpecs(storyboardFrames, {
        projectName: blueprint.projectName || taskId,
        gameType: blueprint.gameType || 'SLG',
      });
      log(`[claude-code] Extracted ${specs.length} phase specs`, taskId);

      const specsDataDir = process.env.SPECS_DATA_DIR || path.join(__dirname, '..', 'spec-data');
      specExtractor.saveSpecs(specs, taskId, specsDataDir);

      // Generate skeleton with entity→pool mapping
      const entityPoolMap = (blueprint.entities && blueprint.entities.length > 0)
        ? promptV5Module.matchPrefabs(blueprint.entities)
        : {};
      skeleton = skeletonGenerator.generateSkeleton(specs, {
        projectName: blueprint.projectName || taskId,
        entityPoolMap: entityPoolMap
      });
      log(`[claude-code] Skeleton generated: ${skeleton.split('\n').length} lines`, taskId);
    } catch (specErr) {
      log(`[claude-code] Spec extraction failed (non-fatal): ${specErr.message}`, taskId);
    }
  }

  // === Step 3: 准备工作目录 ===
  prepareWorkDir(clientDir, blueprint, prompt, skeleton, log, taskId);

  // === Step 4: 构建用户 Prompt ===
  let userPrompt;
  if (hasFeedback) {
    userPrompt = `## 增量修复模式

⚠️ 这是一个 FIX 请求。保持现有代码结构，只修改反馈要求的部分。
⚠️ 禁止重写整个文件！使用 Edit 工具做局部修改。

请完成以下步骤：
1. 阅读 prompt.md 了解详细需求（包含反馈信息）
2. 阅读现有的 Assets/Program/Script/Manager/GameFlowManagerMain.cs（1000+ 行）
3. 使用 Edit 工具（不是 Write）根据反馈做**局部修改**
4. 只修改反馈提到的具体问题，不要动其他代码
5. 运行 bash build-test.sh 验证编译
6. 如果编译失败，用 Edit 修复错误并重试
7. 编译通过后完成

重要：修改后文件行数不应减少。如果你发现文件变短了，说明你错误地重写了整个文件。`;
  } else {
    userPrompt = skeleton
      ? `请完成以下步骤生成 Luna 试玩广告代码：

1. 阅读 prompt.md 了解详细需求（对象分配表、实体行为、事件规则）
2. 阅读 GFM_Tools.cs 了解可用 API（只读参考，不要修改）
3. 阅读 behavior-templates.md 了解行为模板参考
4. 打开 Assets/Program/Script/Manager/GameFlowManagerMain.cs — 骨架代码已预填充
5. 填充所有 TODO 标记的部分，实现完整游戏逻辑
6. 代码必须遵循 CLAUDE.md 中的所有规则
7. 运行 bash build-test.sh 验证编译是否通过
8. 如果编译失败，阅读错误信息，修复代码，再次运行 build-test.sh
9. 重复修复直到编译通过

重要：骨架已在 .cs 文件中，直接在此基础上填充。代码必须完整（通常 1300-1600 行），不要省略任何部分。`
      : `请完成以下步骤生成 Luna 试玩广告代码：

1. 阅读 blueprint.json 了解蓝图结构（节点、边、实体）
2. 阅读 prompt.md 了解详细需求（对象分配表、实体行为、事件规则）
3. 阅读 GFM_Tools.cs 了解可用 API（只读参考，不要修改）
4. 阅读 behavior-templates.md 了解行为模板参考
5. 在 Assets/Program/Script/Manager/GameFlowManagerMain.cs 中生成完整代码
6. 代码必须遵循 CLAUDE.md 中的所有规则
7. 运行 bash build-test.sh 验证编译是否通过
8. 如果编译失败，阅读错误信息，修复代码，再次运行 build-test.sh
9. 重复修复直到编译通过

重要：代码必须完整（通常 1300-1600 行），不要省略任何部分。`;
  }

  // === Step 5: 运行 Claude Code（全局串行锁，避免代理限流）===
  await acquireLock(taskId, log);
  log('[claude-code] 🚀 Starting Claude Code agent...', taskId);
  let result;
  try {
  const useGlm = hasFeedback; // skeleton fill -> Opus 4.6, all fixes -> GLM 5.1
  log(`[claude-code] Model: ${useGlm ? 'GLM 5.1' : 'Opus 4.6'}`, taskId);
  result = await runClaudeCode(clientDir, userPrompt, log, taskId, {
    useGlm: useGlm,
    appendSystemPrompt: hasFeedback
      ? 'INCREMENTAL FIX MODE — CRITICAL RULES:\n'
        + '1. Use the Edit tool (NOT Write) to modify GameFlowManagerMain.cs\n'
        + '2. NEVER rewrite the entire file — only change the specific lines that need fixing\n'
        + '3. The existing code is 1000+ lines. Your edits must preserve all existing code.\n'
        + '4. Read the existing .cs file FIRST, then apply targeted edits based on the feedback.\n'
        + '5. If the file becomes shorter after your edits, you have made a mistake.'
      : null,
    workDir: clientDir,
  });
  } finally {
    releaseLock(taskId, log);
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
  const lineCount = mainSrc.split('\n').length;
  const findCalls = (mainSrc.match(/GameObject\.Find/g) || []).length;
  const gfmCreateCalls = (mainSrc.match(/GFM_Create\.Obj/g) || []).length;
  const hasGameEnded = /GameEnded/.test(mainSrc);

  log(`[claude-code] ✅ Code generated: ${lineCount} lines, ${findCalls} Find() calls, ${gfmCreateCalls} GFM_Create.Obj() calls`, taskId);

  // === 增量修复回退保护：如果修复后代码变短了超过 30%，恢复原始代码 ===
  if (hasFeedback && opts.existingCode) {
    const origLines = opts.existingCode.split('\n').length;
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
  // Count real unfilled TODOs (not skeleton section markers like TODO_VARIABLES_START/END)
  const realTodoCount = (mainSrc.match(/\/\/ TODO(?!_\w+(?:START|END))/gi) || []).length;
  // Check if skeleton was completely unmodified: [SKELETON] markers present AND code didn't grow
  const skeletonLineCount = skeleton ? skeleton.split('\n').length : 0;
  const codeGrowthRatio = skeletonLineCount > 0 ? lineCount / skeletonLineCount : 999;
  const isUnmodifiedSkeleton = /\[SKELETON\]/.test(mainSrc) && codeGrowthRatio < 1.5;
  if (lineCount < 100 || findCalls === 0 || isUnmodifiedSkeleton) {
    const stubReason = lineCount < 100
      ? `Only ${lineCount} lines (need ≥100)`
      : isUnmodifiedSkeleton
        ? `Skeleton barely modified (${skeletonLineCount}→${lineCount} lines, ${codeGrowthRatio.toFixed(1)}x growth) — Claude Code likely timed out`
        : `0 GameObject.Find() calls (objects won't be loaded)`;
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
