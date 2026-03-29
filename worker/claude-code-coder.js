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
const CLAUDE_TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS) || 5 * 60 * 1000; // 5 min (was 10 min — timeouts produce stubs, early kill + retry is faster)
const CLAUDE_MAX_BUDGET = process.env.CLAUDE_MAX_BUDGET_USD || '3';
const CLAUDE_MODEL = process.env.CLAUDE_CODE_MODEL || 'claude-opus-4-6';
const SYSTEM_PROMPT_PATH = path.join(__dirname, 'luna-claude-code.md');
const BUILD_URL = process.env.LINUX_BUILD_URL || 'http://localhost:3080';

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
  let promptContent = prompt;
  if (skeleton) {
    promptContent += '\n\n## CODE SKELETON (MANDATORY)\n\n'
      + '⚠️ 必须使用此骨架作为基础：\n'
      + '1. 填充所有 TODO 标记的部分\n'
      + '2. 不要删除 [SKELETON] 标记的行\n'
      + '3. 不要删除 phaseTimer 检查\n'
      + '4. 不要修改 CheckEventRules() 的跳转条件\n'
      + '5. 可以添加新方法和变量\n\n'
      + '```csharp\n' + skeleton + '\n```\n';
  }
  fs.writeFileSync(path.join(workDir, 'prompt.md'), promptContent);

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
      '--model', CLAUDE_MODEL,
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
        ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL || 'https://chat.nuoda.vip/claudecode',
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
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
  if (!hasFeedback && specExtractor && skeletonGenerator && blueprint.storyboard && blueprint.storyboard.frames && blueprint.storyboard.frames.length > 0) {
    try {
      log('[claude-code] Extracting specs from storyboard frames...', taskId);
      const specs = await specExtractor.extractSpecs(blueprint.storyboard.frames, {
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

请完成以下步骤：
1. 阅读 blueprint.json 了解蓝图需求
2. 阅读 prompt.md 了解对象分配表和详细需求（包含反馈信息）
3. 阅读现有的 Assets/Program/Script/Manager/GameFlowManagerMain.cs
4. 根据反馈修复代码
5. 运行 bash build-test.sh 验证编译
6. 如果编译失败，修复错误并重试
7. 编译通过后完成`;
  } else {
    userPrompt = `请完成以下步骤生成 Luna 试玩广告代码：

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

  // === Step 5: 运行 Claude Code ===
  log('[claude-code] 🚀 Starting Claude Code agent...', taskId);
  const result = await runClaudeCode(clientDir, userPrompt, log, taskId, {
    appendSystemPrompt: hasFeedback ? 'This is an incremental fix. Read the existing code and feedback before making changes.' : null,
    workDir: clientDir,
  });

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

  if (gfmCreateCalls > 0) {
    log('[claude-code] ⚠️ WARNING: AI used GFM_Create.Obj() — should use Find() instead', taskId);
  }
  if (findCalls === 0) {
    log('[claude-code] ⚠️ WARNING: No GameObject.Find() calls', taskId);
  }
  if (!hasGameEnded) {
    log('[claude-code] ⚠️ WARNING: No GameEnded() call', taskId);
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
