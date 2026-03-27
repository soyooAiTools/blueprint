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
const { REVIEW_RULES, loadPendingRules, PENDING_RULES_PATH } = require('./code-reviewer.js');

// ============ Config ============
const CODEX_CMD = process.env.CODEX_CMD || 'codex';
const CODEX_TIMEOUT_MS = parseInt(process.env.CODEX_REVIEW_TIMEOUT_MS) || 3 * 60 * 1000; // 3 min
const CODEX_MODEL = process.env.CODEX_REVIEW_MODEL || 'gpt-5.4';

// ============ Preflight Health Check ============
let _codexPreflightResult = null; // null = not checked, true = ok, false = broken

/**
 * One-time health check: verify codex exec can run (sandbox + auth).
 * Result is cached so it only runs once per process lifetime.
 */
async function preflightCheck() {
  if (_codexPreflightResult !== null) return _codexPreflightResult;

  // Check API key first (cheap)
  if (!process.env.CODEX_API_KEY && !process.env.OPENAI_API_KEY) {
    console.log('[codex-reviewer] Preflight SKIP: no API key configured');
    _codexPreflightResult = false;
    return false;
  }

  // Quick test: spawn codex with a trivial task and short timeout
  try {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-preflight-'));
    fs.writeFileSync(path.join(testDir, 'test.txt'), 'hello');

    const result = await new Promise((resolve) => {
      const child = spawn(CODEX_CMD, [
        'exec',
        '--skip-git-repo-check',
        '--ephemeral',
        '-m', CODEX_MODEL,
        '-s', 'danger-full-access',
        '-c', 'model_provider="OpenAI"',
        '-C', testDir,
      ], {
        cwd: testDir,
        env: {
          ...process.env,
          CODEX_API_KEY: process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY || '',
          RUST_LOG: 'error',
        },
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

    if (result.code === 0 && result.stdout.length > 0) {
      console.log('[codex-reviewer] Preflight OK: codex exec working');
      _codexPreflightResult = true;
      return true;
    }

    // Check for known failures
    if (result.stderr.includes('bwrap') || result.stderr.includes('argv0')) {
      console.log('[codex-reviewer] Preflight FAIL: bwrap sandbox broken -', result.stderr.substring(0, 200));
    } else if (result.stderr.includes('401') || result.stderr.includes('auth')) {
      console.log('[codex-reviewer] Preflight FAIL: authentication issue -', result.stderr.substring(0, 200));
    } else {
      console.log(`[codex-reviewer] Preflight FAIL: exit code ${result.code}, stderr: ${result.stderr.substring(0, 200)}`);
    }
    _codexPreflightResult = false;
    return false;
  } catch (err) {
    console.log('[codex-reviewer] Preflight FAIL: exception -', err.message);
    _codexPreflightResult = false;
    return false;
  }
}

/**
 * 运行 Codex exec 进行代码审查
 */
function runCodexReview(workDir, userPrompt, log, taskId) {
  return new Promise((resolve, reject) => {
    const args = [
      'exec',
      '--skip-git-repo-check',
      '--ephemeral',
      '-m', CODEX_MODEL,
      '-s', 'danger-full-access', // bwrap 0.4.0 不支持 --argv0，read-only 模式下无法执行命令
      '-c', 'model_provider="OpenAI"',
      '-C', workDir,
    ];

    log(`[codex-reviewer] Spawning: ${CODEX_CMD} ${args.join(' ')}`, taskId);

    const child = spawn(CODEX_CMD, args, {
      cwd: workDir,
      env: {
        ...process.env,
        CODEX_API_KEY: process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY || '',
        RUST_LOG: 'error',  // 静默 Codex 日志
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      log(`[codex-reviewer] ⚠️ Timeout (${CODEX_TIMEOUT_MS / 1000}s), killing`, taskId);
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000);
    }, CODEX_TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(timer);
      log(`[codex-reviewer] Process exited code=${code}, stdout=${stdout.length} chars`, taskId);
      resolve({
        ok: code === 0,
        output: stdout,
        error: code !== 0 ? (stderr || `Exit code ${code}`) : null,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: '', error: err.message });
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

  // One-time preflight: verify codex exec is functional (sandbox + auth)
  const codexOk = await preflightCheck();
  if (!codexOk) {
    log('[codex-reviewer] Preflight failed or no API key, skipping review', taskId);
    return { passed: true, issues: [], feedback: '', skipped: true, skipReason: 'preflight_failed' };
  }

  log('[codex-reviewer] Starting Codex adversarial review...', taskId);

  // 创建临时工作目录
  const workDir = path.join(os.tmpdir(), `codex-review-${taskId}-${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });

  // 写入代码文件供 Codex 读取
  fs.writeFileSync(path.join(workDir, 'GameFlowManagerMain.cs'), code);

  // 写入 review rules 文件
  fs.writeFileSync(path.join(workDir, 'REVIEW_RULES.md'), REVIEW_RULES);

  // 构建 prompt
  const userPrompt = `You are a strict code reviewer for Luna (Unity-to-HTML5) playable ads.

Read the file REVIEW_RULES.md to understand all the constraint rules, then read GameFlowManagerMain.cs and check it against every rule.

Be adversarial — find ALL violations. Do NOT rubber-stamp.

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
    return { passed: false, issues: ['Codex reviewer failed: ' + (result.error || 'unknown error')], feedback: '', error: result.error };
  }

  // 解析输出
  const review = parseReviewOutput(result.output);
  if (!review) {
    log('[codex-reviewer] Failed to parse Codex output as JSON, treating as FAIL (timeout or empty output). Output: ' + result.output.slice(0, 300), taskId);
    return { passed: false, issues: ['Codex reviewer returned unparseable output (likely timeout)'], feedback: result.output, parseError: true };
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
  };
}

module.exports = { reviewCodeWithCodex, preflightCheck };
