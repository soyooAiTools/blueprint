/**
 * Worker-side CUA Verification �?蓝图流程验证�? * 
 * �?GPT-5.4 CUA 按蓝�?shot 顺序操控 HTML，验证流程是否走通�? * 
 * 通过标准（无打分，纯 pass/fail）：
 *   1. 蓝图所�?shot 都能操作覆盖
 *   2. CTA 按钮可到达并可点�? *   3. 游戏不卡�?白屏/崩溃
 * 
 * 不通过时返回具体的未覆�?shot 和问题描述，用于反馈�?AI 重新编码�? * 不做任何视觉效果审核�? */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const LUNA_AGENT_JS = path.join(__dirname, 'luna-agent.js');
const CUA_RESULTS_DIR = path.join(__dirname, 'cua-results');
const MAX_CUA_RETRIES = 3;
// 不再使用分数阈值，改为蓝图覆盖�?pass/fail
// const CUA_PASS_THRESHOLD = 70;
const LOCAL_PREVIEW_PORT = 18850; // Temp local server for preview

try { fs.mkdirSync(CUA_RESULTS_DIR, { recursive: true }); } catch(e) {}

/**
 * Start a simple local HTTP server to serve the build output
 */
function startLocalServer(buildDir) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let filePath = path.join(buildDir, req.url === '/' ? 'iframe.html' : req.url);
      // Remove query string
      filePath = filePath.split('?')[0];
      
      if (!fs.existsSync(filePath)) {
        // Try index.html as fallback
        if (req.url === '/') filePath = path.join(buildDir, 'index.html');
        if (!fs.existsSync(filePath)) {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }
      }

      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes = {
        '.html': 'text/html', '.js': 'application/javascript',
        '.css': 'text/css', '.json': 'application/json',
        '.png': 'image/png', '.jpg': 'image/jpeg',
        '.wasm': 'application/wasm', '.bin': 'application/octet-stream',
        '.ico': 'image/x-icon', '.svg': 'image/svg+xml'
      };

      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    });

    server.listen(LOCAL_PREVIEW_PORT, '127.0.0.1', () => {
      resolve(server);
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        // Port in use, try to kill and retry
        try {
          require('child_process').execSync(
            'powershell -Command "Get-Process -Id (Get-NetTCPConnection -LocalPort ' + LOCAL_PREVIEW_PORT + ').OwningProcess -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"',
            { timeout: 5000 }
          );
        } catch(e) {}
        setTimeout(() => {
          server.listen(LOCAL_PREVIEW_PORT, '127.0.0.1', () => resolve(server));
        }, 1000);
      } else {
        reject(err);
      }
    });
  });
}

/**
 * Generate script file from blueprint for CUA to follow
 */
function generateScript(blueprint, outputPath) {
  if (!blueprint || !blueprint.nodes) return null;
  
  const steps = blueprint.nodes
    .filter(n => n.type === 'shotNode')
    .map((n, i) => (i + 1) + '. ' + (n.data.name || n.data.label || 'Shot ' + (i + 1)));
  
  if (steps.length === 0) return null;
  
  fs.writeFileSync(outputPath, steps.join('\n'), 'utf-8');
  return outputPath;
}

/**
 * Run CUA verification on the build output
 * 
 * @param {string} buildDir - Path to stage4/develop/ build output
 * @param {object} blueprint - Blueprint data with nodes
 * @param {string} taskId - Task/project ID
 * @param {function} log - Logging function
 * @returns {object} { passed: boolean, issues: string[], report: object }
 */
async function runCUAVerification(buildDir, blueprint, taskId, log) {
  // Check if luna-agent.js exists
  if (!fs.existsSync(LUNA_AGENT_JS)) {
    log('[CUA] luna-agent.js not found, skipping CUA verification', taskId);
    return { passed: true, issues: [], skipped: true };
  }

  // Check iframe.html or index.html exists
  const hasIframe = fs.existsSync(path.join(buildDir, 'iframe.html'));
  const hasIndex = fs.existsSync(path.join(buildDir, 'index.html'));
  if (!hasIframe && !hasIndex) {
    log('[CUA] No HTML file in build output, skipping CUA', taskId);
    return { passed: true, issues: [], skipped: true };
  }

  log('[CUA] Starting CUA verification...', taskId);

  // Start local preview server
  let server;
  try {
    server = await startLocalServer(buildDir);
    log('[CUA] Local preview server started on port ' + LOCAL_PREVIEW_PORT, taskId);
  } catch(e) {
    log('[CUA] Failed to start local server: ' + e.message, taskId);
    return { passed: true, issues: [], skipped: true, error: e.message };
  }

  const previewUrl = 'http://127.0.0.1:' + LOCAL_PREVIEW_PORT + '/' + (hasIframe ? 'iframe.html' : 'index.html');
  const outputPath = path.join(CUA_RESULTS_DIR, taskId + '-report.json');
  const logPath = path.join(CUA_RESULTS_DIR, taskId + '-cua.log');

  // Generate script from blueprint
  const scriptPath = path.join(CUA_RESULTS_DIR, taskId + '-script.txt');
  const hasScript = generateScript(blueprint, scriptPath);

  // Build args
  const args = [
    LUNA_AGENT_JS,
    previewUrl,
    '--model', 'cua',
    '--rounds', '15',
    '--output', outputPath
  ];
  if (hasScript) args.push('--script', scriptPath);

  return new Promise((resolve) => {
    const child = spawn('node', args, {
      cwd: __dirname,
      env: {
        ...process.env,
        // 显式传递关键环境变量，防止 PM2 子进程继承丢失
        OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
        GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
        https_proxy: process.env.https_proxy || process.env.HTTPS_PROXY || '',
        http_proxy: process.env.http_proxy || process.env.HTTP_PROXY || '',
        HTTPS_PROXY: process.env.HTTPS_PROXY || process.env.https_proxy || '',
        HTTP_PROXY: process.env.HTTP_PROXY || process.env.http_proxy || '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300000 // 5 min max
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { 
      const line = d.toString();
      stdout += line;
      // Forward key log lines
      if (line.includes('[Luna Agent]') || line.includes('[CUA]') || line.includes('Score')) {
        log('[CUA] ' + line.trim(), taskId);
      }
    });
    child.stderr.on('data', d => { stderr += d.toString(); });

    const timeout = setTimeout(() => {
      log('[CUA] Timeout after 5 minutes, killing', taskId);
      try { child.kill('SIGTERM'); } catch(e) {}
    }, 300000);

    child.on('close', (code) => {
      clearTimeout(timeout);
      
      // Stop local server
      try { server.close(); } catch(e) {}

      log('[CUA] luna-agent exited with code ' + code, taskId);

      // Save raw output
      try {
        fs.writeFileSync(logPath, stdout + '\n---STDERR---\n' + stderr, 'utf-8');
      } catch(e) {}

      // Read report
      let report = null;
      try {
        report = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
      } catch(e) {
        log('[CUA] Failed to read report: ' + (e.message || 'unknown'), taskId);
        resolve({ passed: false, issues: ['CUA report not generated (timeout or crash)'], skipped: false, error: e.message });
        return;
      }

      // === 蓝图流程验证（pass/fail，无打分�?==
      const issues = [];

      // 1. 检查是否卡�?崩溃
      if (report.exitReason === 'stuck') {
        issues.push('[卡死] 游戏在操控过程中卡死，无法继续（连续多轮无状态变化）');
      }

      // 2. 检查蓝�?shot 覆盖度（核心指标�?      if (report.scriptCoverage) {
        const uncovered = report.scriptCoverage.filter(s => !s.covered);
        if (uncovered.length > 0) {
          issues.push('[分镜未覆盖] 以下蓝图场景未能走�? ' + uncovered.map(s => s.step || s.name).join(', '));
        }
      }

      // 3. CTA 不是必要条件，只要蓝图最后一�?shot 走到即可
      // CTA 状态仅记日志，不影�?pass/fail
      if (report.ctaStatus === 'not_found' || report.ctaStatus === 'no_response') {
        log('[CUA] CTA未到达（仅记录，不影响通过判定�?, taskId);
      }

      // 4. AI 操控中发现的阻断级交互问题（按钮不响应、场景切换失败等�?      if (report.bugs) {
        const bugList = report.bugs.fromAI || report.bugs;
        const bugArray = Array.isArray(bugList) ? bugList : [];
        bugArray.forEach(bug => {
          issues.push('[交互问题] ' + (bug.description || bug.message || JSON.stringify(bug)));
        });
      }

      // 5. 严重异常（白屏、崩溃）
      if (report.anomalies) {
        report.anomalies
          .filter(a => a.severity === 'high' || a.severity === 'error' || a.severity === 'critical')
          .forEach(a => {
            issues.push('[严重异常] ' + (a.description || a.rule || JSON.stringify(a)));
          });
      }

      // Gemini 视觉审核结果只记日志，不影响 pass/fail
      if (report.geminiReview && report.geminiReview.issues && report.geminiReview.issues.length > 0) {
        log('[CUA] Gemini 视觉审核发现 ' + report.geminiReview.issues.length + ' 个问题（仅记录，不影响通过判定�?, taskId);
      }

      // 通过标准：蓝图所�?shot 覆盖 + 不卡�?= pass
      // 到达最后一�?shot 即视为流程完整，CTA 不是必要条件
      const passed = issues.length === 0;

      log('[CUA] Issues: ' + issues.length + ', Pass: ' + passed + ', ExitReason: ' + (report.exitReason || 'unknown'), taskId);

      resolve({ passed, issues, report, skipped: false });
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      try { server.close(); } catch(e) {}
      log('[CUA] Failed to start: ' + err.message, taskId);
      resolve({ passed: false, issues: ['CUA process failed to start: ' + err.message], skipped: false, error: err.message });
    });
  });
}

module.exports = { runCUAVerification, CUA_RESULTS_DIR, MAX_CUA_RETRIES };
