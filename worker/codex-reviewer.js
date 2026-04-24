/**
 * Codex Code Reviewer — 用 Codex CLI 替代 GPT-5.4 API 做代码审查
 * 
 * 使用 codex exec 非交互模式，传入 REVIEW_RULES 作为 system prompt，
 * 让 Codex 以 agent 身份审查代码，可以自己读文件、分析问题。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// 复用现有 review 规则
const {
  REVIEW_RULES,
  loadPendingRules,
  loadInjectablePromotedRules,
  isSkeletonReviewFalsePositive,
} = require('./code-reviewer.js');

// ============ Config ============
const CODEX_CMD = process.env.CODEX_CMD || 'codex';
const CODEX_TIMEOUT_MS = parseInt(process.env.CODEX_REVIEW_TIMEOUT_MS) || 4 * 60 * 1000; // align with codex-text default
const CODEX_MODEL = process.env.CODEX_REVIEW_MODEL || 'gpt-5.4';

// ============ Preflight Health Check ============
let _codexPreflightResult = null; // null = not checked, true = ok, false = broken
let _codexPreflightReason = null; // human-readable failure reason ('quota_exceeded' / 'auth' / etc.)
let _codexPreflightCheckedAt = null; // ms timestamp of last preflight run

function getPreflightReason() { return _codexPreflightReason; }
function getPreflightCheckedAt() { return _codexPreflightCheckedAt; }

/**
 * One-time health check: verify codex exec can run (sandbox + auth).
 * Result is cached so it only runs once per process lifetime.
 */
async function preflightCheck() {
  if (_codexPreflightResult !== null) return _codexPreflightResult;

  // Check auth: API key OR ChatGPT auth file (~/.codex/auth.json)
  var hasChatGPTAuth = false;
  try {
    var authFile = path.join(os.homedir(), '.codex', 'auth.json');
    if (fs.existsSync(authFile)) {
      var auth = JSON.parse(fs.readFileSync(authFile, 'utf-8'));
      hasChatGPTAuth = auth.auth_mode === 'chatgpt' && (auth.tokens || auth.OPENAI_API_KEY);
    }
  } catch (e) {}
  if (!process.env.CODEX_API_KEY && !process.env.OPENAI_API_KEY && !hasChatGPTAuth) {
    console.log('[codex-reviewer] Preflight SKIP: no API key or ChatGPT auth configured');
    _codexPreflightResult = false;
    _codexPreflightReason = 'no_api_key';
    _codexPreflightCheckedAt = Date.now();
    return false;
  }

  // Quick test: spawn codex with a trivial task and short timeout
  try {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-preflight-'));
    fs.writeFileSync(path.join(testDir, 'test.txt'), 'hello');

    const result = await new Promise((resolve) => {
      // 2026-04-15: 不再走 mindrix API 中转。改用 codex 内置默认 provider +
      // ChatGPT auth (~/.codex/auth.json auth_mode=chatgpt)。必须从子进程 env
      // 里显式剥离 OPENAI_API_KEY / CODEX_API_KEY / OPENAI_BASE_URL — 只要这些
      // 存在 codex 就会误以为你想用 API key 模式去 api.openai.com,
      // 然后拿 blueprint-editor .env 里的 mindrix 中转 key 401 invalid_api_key。
      const { OPENAI_API_KEY, CODEX_API_KEY, OPENAI_BASE_URL, HTTP_PROXY, HTTPS_PROXY, http_proxy, https_proxy, ALL_PROXY, all_proxy, NO_PROXY, no_proxy, ...cleanEnv } = process.env;
      const child = spawn(CODEX_CMD, [
        'exec',
        '--skip-git-repo-check',
        '--ephemeral',
        '-m', CODEX_MODEL,
        '-s', 'danger-full-access',
        '-C', testDir,
      ], {
        cwd: testDir,
        env: { ...cleanEnv, RUST_LOG: 'error' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', d => stdout += d);
      child.stderr.on('data', d => stderr += d);
      child.stdin.write('Read test.txt and respond with its content.');
      child.stdin.end();

      const timer = setTimeout(() => { child.kill('SIGTERM'); }, 20000);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ code: -1, stdout: '', stderr: err.message });
      });
    });

    // Cleanup
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (e) {}

    _codexPreflightCheckedAt = Date.now();

    // Check for known failures first — codex prints "Quota exceeded" / auth
    // errors to stdout or stderr, so scan both streams.
    var combined = (result.stdout || '') + '\n' + (result.stderr || '');
    if (result.code === 0 && !/Quota exceeded/i.test(combined) && !/401|unauthor/i.test(combined)) {
      // Exit code 0 = codex ran successfully. Don't require stdout content —
      // in PM2 cluster mode, codex stdout can be empty even on success due to
      // fd inheritance quirks; actual review runs in worker processes unaffected.
      console.log('[codex-reviewer] Preflight OK: codex exec exit 0' + (result.stdout.length > 0 ? ' (stdout: ' + result.stdout.length + 'b)' : ' (stdout empty, PM2 cluster mode)'));
      _codexPreflightResult = true;
      _codexPreflightReason = 'ok';
      return true;
    }

    if (/Quota exceeded/i.test(combined)) {
      console.log('[codex-reviewer] Preflight FAIL: quota exceeded');
      _codexPreflightReason = 'quota_exceeded';
    } else if (combined.includes('bwrap') || combined.includes('argv0')) {
      console.log('[codex-reviewer] Preflight FAIL: bwrap sandbox broken -', combined.substring(0, 200));
      _codexPreflightReason = 'sandbox_broken';
    } else if (/401|unauthor|auth/i.test(combined)) {
      console.log('[codex-reviewer] Preflight FAIL: authentication issue -', combined.substring(0, 200));
      _codexPreflightReason = 'auth_failed';
    } else {
      console.log(`[codex-reviewer] Preflight FAIL: exit code ${result.code}, output: ${combined.substring(0, 200)}`);
      _codexPreflightReason = 'exit_code_' + result.code;
    }
    _codexPreflightResult = false;
    return false;
  } catch (err) {
    console.log('[codex-reviewer] Preflight FAIL: exception -', err.message);
    _codexPreflightResult = false;
    _codexPreflightReason = 'exception';
    _codexPreflightCheckedAt = Date.now();
    return false;
  }
}

function buildCodexReviewArgs(workDir, outputPath) {
  return [
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '-m', CODEX_MODEL,
    '-s', 'danger-full-access', // bwrap 0.4.0 不支持 --argv0，read-only 模式下无法执行命令
    '-C', workDir,
    '-o', outputPath,
  ];
}

/**
 * 运行 Codex exec 进行代码审查
 */
function runCodexReview(workDir, userPrompt, log, taskId) {
  return new Promise((resolve, reject) => {
    const outputPath = path.join(workDir, 'codex-review-last-message.txt');
    const args = buildCodexReviewArgs(workDir, outputPath);

    log(`[codex-reviewer] Spawning: ${CODEX_CMD} ${args.join(' ')}`, taskId);

    // 2026-04-15: ChatGPT auth 模式, 必须剥离 OPENAI_API_KEY / CODEX_API_KEY /
    // OPENAI_BASE_URL — 否则 codex 会用 blueprint-editor .env 里的 mindrix 中转 key
    // 去撞 api.openai.com 拿 401。~/.codex/config.toml 也已删除 [model_providers.OpenAI] 自定义块。
    const { OPENAI_API_KEY, CODEX_API_KEY, OPENAI_BASE_URL, HTTP_PROXY, HTTPS_PROXY, http_proxy, https_proxy, ALL_PROXY, all_proxy, NO_PROXY, no_proxy, ...cleanEnv } = process.env;
    const child = spawn(CODEX_CMD, args, {
      cwd: workDir,
      env: { ...cleanEnv, RUST_LOG: 'error' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      log(`[codex-reviewer] ⚠️ Timeout (${CODEX_TIMEOUT_MS / 1000}s), killing`, taskId);
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000);
    }, CODEX_TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(timer);
      let lastMessage = '';
      try {
        if (fs.existsSync(outputPath)) lastMessage = fs.readFileSync(outputPath, 'utf8') || '';
      } catch (_err) {}
      log(`[codex-reviewer] Process exited code=${code}, last=${lastMessage.length} chars, stdout=${stdout.length} chars, stderr=${stderr.length} chars`, taskId);
      resolve({
        ok: code === 0,
        output: lastMessage || stdout,
        rawStdout: stdout,
        error: code !== 0 ? (stderr || `Exit code ${code}`) : null,
        timedOut: timedOut,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: '', rawStdout: '', error: err.message, timedOut: timedOut });
    });

    // 写入 prompt
    child.stdin.write(userPrompt);
    child.stdin.end();
  });
}

/**
 * 解析 Codex 输出中的 JSON review 结果
 */
function parseReviewOutput(output) {
  // 尝试从输出中提取 JSON
  // Codex 输出可能包含 "codex\n" 前缀和 "tokens used\n..." 后缀
  const lines = output.split('\n');
  let jsonStr = '';
  let inJson = false;
  let braceCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inJson && line.trim().startsWith('{')) {
      inJson = true;
    }
    if (inJson) {
      jsonStr += line + '\n';
      for (let c = 0; c < line.length; c++) {
        if (line[c] === '{') braceCount++;
        if (line[c] === '}') braceCount--;
      }
      if (braceCount <= 0 && jsonStr.trim().length > 0) {
        break;
      }
    }
  }

  if (jsonStr.trim()) {
    try {
      // 去掉 markdown code fences
      jsonStr = jsonStr.replace(/^```json?\s*/im, '').replace(/\s*```$/im, '').trim();
      return JSON.parse(jsonStr);
    } catch (e) {
      // 再尝试整体匹配
      const match = output.match(/\{[\s\S]*?"verdict"[\s\S]*?"issues"[\s\S]*?\}/);
      if (match) {
        try { return JSON.parse(match[0]); } catch (e2) {}
      }
    }
  }
  return null;
}

/**
 * 用 Codex 审查代码
 * 
 * @param {string} code - C# 源代码
 * @param {object} options - { taskId, log, blueprint }
 * @returns {object} { passed, issues, feedback, summary, criticalCount, warningCount }
 */
async function reviewCodeWithCodex(code, options) {
  options = options || {};
  const log = options.log || console.log;
  const taskId = options.taskId || 'unknown';

  // One-time preflight: verify codex exec is functional (sandbox + auth).
  // On failure we THROW (prefixed MODEL_FATAL) rather than silently return
  // {passed:true}. The old skip-pretend-pass let quota-exhausted tasks burn
  // through compile/CUA with unreviewed code. error-classifier.cjs routes
  // this to MODEL_FATAL → linux-worker-client cancels the task outright.
  const codexOk = await preflightCheck();
  if (!codexOk) {
    const reason = getPreflightReason() || 'unknown';
    log('[codex-reviewer] Preflight FAIL (' + reason + ') — aborting task (no silent skip)', taskId);
    throw new Error('MODEL_FATAL: codex preflight failed (' + reason + ')');
  }

  log('[codex-reviewer] Starting Codex adversarial review...', taskId);

  // 创建临时工作目录
  const workDir = path.join(os.tmpdir(), `codex-review-${taskId}-${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });

  // 写入代码文件供 Codex 读取
  fs.writeFileSync(path.join(workDir, 'GameFlowManagerMain.cs'), code);

  // 写入 partial class 伴生文件 (Systems.cs 等)，避免 Codex 误报 "missing method definitions"
  // Exclude GFM toolkit files — canonical read-only, not AI-generated
  const _isGfm = require('./gfm-files.cjs').isGfmFile;
  const extraFiles = options.extraFiles || {};
  for (const efName of Object.keys(extraFiles)) {
    if (efName === 'GFM_Tools.cs' || _isGfm(efName)) continue;
    if (efName.endsWith('.cs') && extraFiles[efName]) {
      fs.writeFileSync(path.join(workDir, efName), extraFiles[efName]);
    }
  }

  // 写入 review rules 文件 (包含动态规则)
  var dynamicRulesText = '';
  try {
    var promoted = loadInjectablePromotedRules();
    if (promoted.length > 0) {
      dynamicRulesText = '\n\n## Auto-Promoted Rules (recurring cross-project failures)\n';
      for (var dri = 0; dri < promoted.length; dri++) {
        dynamicRulesText += '- ' + (promoted[dri].description || '') + ' — FIX: ' + (promoted[dri].fix || 'see rule') + '\n';
      }
    }
    // Also inject top pending-rules patterns (seen in 2+ projects)
    var pending = loadPendingRules();
    if (pending.length > 0) {
      var ruleGroups = {};
      for (var pri = 0; pri < pending.length; pri++) {
        if (isSkeletonReviewFalsePositive(pending[pri])) continue;
        var rKey = (pending[pri].rule || 'unknown').substring(0, 60);
        if (!ruleGroups[rKey]) ruleGroups[rKey] = { projects: {}, desc: pending[pri].description, fix: pending[pri].fix };
        if (pending[pri].taskId) ruleGroups[rKey].projects[pending[pri].taskId] = true;
      }
      var topPatterns = Object.entries(ruleGroups)
        .filter(function(e) { return Object.keys(e[1].projects).length >= 2; })
        .sort(function(a, b) { return Object.keys(b[1].projects).length - Object.keys(a[1].projects).length; })
        .slice(0, 15); // Increased from 8
      if (topPatterns.length > 0) {
        dynamicRulesText += '\n## Recurring Production Failures (flagged in ' + topPatterns.length + ' patterns)\n';
        for (var tpi = 0; tpi < topPatterns.length; tpi++) {
          var tp = topPatterns[tpi];
          dynamicRulesText += '- [' + tp[0] + '] ' + (tp[1].desc || '').substring(0, 150) + '\n';
        }
      }
    }
  } catch(e) {}
  fs.writeFileSync(path.join(workDir, 'REVIEW_RULES.md'), REVIEW_RULES + dynamicRulesText);
  if (options.assemblyPlanSummary) {
    fs.writeFileSync(path.join(workDir, 'ASSEMBLY_PLAN.md'), String(options.assemblyPlanSummary || ''));
  }

  // 构建 prompt — 告知 Codex 可能有多个 .cs 文件
  // Exclude GFM_Tools.cs from the companionNote list too — it is NOT a partial-class
  // companion and should not be advertised to Codex as one.
  const extraFileNames = Object.keys(extraFiles).filter(n => n.endsWith('.cs') && n !== 'GFM_Tools.cs' && !_isGfm(n));
  const companionNote = extraFileNames.length > 0
    ? `\n\nIMPORTANT: This project uses C# partial classes. The following companion files are also present and compiled together with GameFlowManagerMain.cs:\n${extraFileNames.map(n => '- ' + n).join('\n')}\nMethods defined in these companion files are NOT missing — they are part of the same class. Do NOT flag them as "missing method definitions".`
    : '';

  const planNote = options.assemblyPlanSummary
    ? '\n\nIMPORTANT: This task also has a project-specific assembly contract. Read ASSEMBLY_PLAN.md and treat it as a hard requirement: phase IDs, owner files, state owners, and CUA steps must stay aligned with that contract.'
    : '';
  const userPrompt = `You are a strict code reviewer for Luna (Unity-to-HTML5) playable ads.

Read the file REVIEW_RULES.md to understand all the constraint rules, then read ALL .cs files in this directory and check GameFlowManagerMain.cs against every rule.${companionNote}${planNote}

Be adversarial — find ALL violations. Do NOT rubber-stamp.

IMPORTANT EXCEPTIONS — these are NOT violations:
- OnAutoPlayArrive() is a REQUIRED skeleton method for CUA (Computer Use Agent) automated testing. It may move/hide/show phase-gate entities or call phase helpers so the game can be verified automatically. Do NOT flag it as "autoplay/auto-demo violation".
- ReportPhase("__PHASE__:...") and TryReportStuckPhase("__PHASE_STUCK__:...") are REQUIRED skeleton diagnostics for automated verification. Do NOT flag those helper-scoped Debug.Log calls as console-spam violations.
- UpdateCarryVisuals() and ShowFloatingText() are optional skeleton helpers. A no-op implementation is acceptable; do NOT require runtime object creation or dynamic pool-name construction inside them.
- The safety net (phaseTimer >= 50f with _autoPlayMode) is a REQUIRED skeleton feature that prevents CUA from getting stuck on broken phases. Do NOT flag it as "forced phase advancement".
- These two features exist because CUA needs to observe the game playing itself — they are part of the testing infrastructure, not cheating.

After your review, output a JSON object (no markdown fences, just raw JSON):
{
  "verdict": "PASS" or "FAIL",
  "issues": [
    { "severity": "critical" or "warning", "line": "line number or method name", "rule": "which rule violated", "description": "what's wrong", "fix": "how to fix it" }
  ],
  "summary": "one-line summary"
}

Rules:
- "critical" = code will definitely break at runtime
- "warning" = code might work but violates best practices
- Verdict = FAIL if ANY critical issues
- Output ONLY the JSON, nothing else`;

  const result = await runCodexReview(workDir, userPrompt, log, taskId);

  // 清理临时目录
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) {}

  if (!result.ok && !result.output) {
    log('[codex-reviewer] Codex review error (non-fatal, treating as FAIL): ' + (result.error || '').slice(0, 200), taskId);
    return {
      passed: false,
      issues: ['Codex reviewer failed: ' + (result.error || 'unknown error')],
      feedback: '',
      error: result.error,
      timedOut: !!result.timedOut,
      source: 'codex-reviewer',
    };
  }

  // 解析输出
  const review = parseReviewOutput(result.output);
  if (!review) {
    const parseReason = result.timedOut
      ? 'Codex reviewer timed out before producing JSON output'
      : (result.output ? 'Codex reviewer returned unparseable output' : 'Codex reviewer returned empty output');
    log('[codex-reviewer] Failed to parse Codex output as JSON: ' + parseReason + '. Output: ' + result.output.slice(0, 300), taskId);
    return {
      passed: false,
      issues: [parseReason],
      feedback: result.output || result.rawStdout || '',
      parseError: true,
      error: parseReason,
      timedOut: !!result.timedOut,
      source: 'codex-reviewer',
    };
  }

  const issues = review.issues || [];
  let criticalCount = 0;
  let warningCount = 0;

  for (let i = 0; i < issues.length; i++) {
    if (issues[i].severity === 'critical') criticalCount++;
    else warningCount++;
  }

  const passed = (review.verdict || '').toUpperCase() === 'PASS' && criticalCount === 0;

  // 日志
  log('[codex-reviewer] === FULL REVIEW RESULT ===', taskId);
  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i];
    log('[codex-reviewer]   ' + (issue.severity === 'critical' ? '❌' : '⚠️') +
      ' [' + issue.severity + '] ' + (issue.description || '').slice(0, 150) +
      ' | rule: ' + (issue.rule || '-') +
      ' | fix: ' + (issue.fix || '-').slice(0, 100), taskId);
  }
  log('[codex-reviewer] === END REVIEW ===', taskId);
  log('[codex-reviewer] Verdict: ' + (passed ? 'PASS ✅' : 'FAIL ❌') +
    ' (' + criticalCount + ' critical, ' + warningCount + ' warnings)' +
    ' — ' + (review.summary || ''), taskId);

  // 构建反馈
  let feedback = '';
  if (!passed) {
    feedback = '## Code Review Failed — Fix These Issues\n\n';
    for (let j = 0; j < issues.length; j++) {
      const issue = issues[j];
      if (issue.severity === 'critical') {
        feedback += '### ❌ CRITICAL: ' + issue.description + '\n';
        feedback += '- **Location**: ' + (issue.line || 'unknown') + '\n';
        feedback += '- **Rule**: ' + (issue.rule || 'unknown') + '\n';
        feedback += '- **Fix**: ' + (issue.fix || 'see rules') + '\n\n';
      }
    }
    for (let k = 0; k < issues.length; k++) {
      if (issues[k].severity === 'warning') {
        feedback += '### ⚠️ WARNING: ' + issues[k].description + '\n';
        feedback += '- **Fix**: ' + (issues[k].fix || 'optional') + '\n\n';
      }
    }
  }

  return {
    passed,
    issues,
    feedback,
    summary: review.summary || '',
    criticalCount,
    warningCount,
    codexReview: true,
    source: 'codex-reviewer',
  };
}

module.exports = {
  reviewCodeWithCodex,
  preflightCheck,
  getPreflightReason,
  getPreflightCheckedAt,
  _buildCodexReviewArgs: buildCodexReviewArgs,
  _parseReviewOutput: parseReviewOutput,
};
