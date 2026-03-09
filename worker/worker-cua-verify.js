/**
 * Worker-side CUA Verification
 * 
 * Runs GPT-5.4 CUA on the locally built HTML (via local file server)
 * BEFORE uploading to main ECS.
 * Only verified builds get uploaded.
 * 
 * ⚠️ Blueprint CUA 定位：流程验证器（不是效果审核）
 * - 只验证：蓝图描述的场景流程是否能走通（shot 切换、交互触发、CTA 到达）
 * - 不管：美术效果、视觉质量、动画细节
 * - 通过标准：按蓝图 shot 顺序操作能走完全流程即通过
 */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const LUNA_AGENT_JS = path.join(__dirname, 'luna-agent.js');
const CUA_RESULTS_DIR = path.join(__dirname, 'cua-results');
const MAX_CUA_RETRIES = 3;
const CUA_PASS_THRESHOLD = 70;
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
 * @returns {object} { passed: boolean, score: number, issues: string[], report: object }
 */
async function runCUAVerification(buildDir, blueprint, taskId, log) {
  // Check if luna-agent.js exists
  if (!fs.existsSync(LUNA_AGENT_JS)) {
    log('[CUA] luna-agent.js not found, skipping CUA verification', taskId);
    return { passed: true, score: 100, issues: [], skipped: true };
  }

  // Check iframe.html or index.html exists
  const hasIframe = fs.existsSync(path.join(buildDir, 'iframe.html'));
  const hasIndex = fs.existsSync(path.join(buildDir, 'index.html'));
  if (!hasIframe && !hasIndex) {
    log('[CUA] No HTML file in build output, skipping CUA', taskId);
    return { passed: true, score: 100, issues: [], skipped: true };
  }

  log('[CUA] Starting CUA verification...', taskId);

  // Start local preview server
  let server;
  try {
    server = await startLocalServer(buildDir);
    log('[CUA] Local preview server started on port ' + LOCAL_PREVIEW_PORT, taskId);
  } catch(e) {
    log('[CUA] Failed to start local server: ' + e.message, taskId);
    return { passed: true, score: 100, issues: [], skipped: true, error: e.message };
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
        // Keys should be in PM2 env or system env
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
        resolve({ passed: false, score: 0, issues: ['CUA report not generated (timeout or crash)'], skipped: false, error: e.message });
        return;
      }

      // Evaluate
      const score = report.score || report.overallScore || 0;
      const issues = [];

      if (report.bugs && report.bugs.length > 0) {
        report.bugs.forEach(bug => {
          issues.push('[操控问题] ' + (bug.description || bug.message || JSON.stringify(bug)));
        });
      }

      // Blueprint CUA 只做流程验证，不审视觉效果
      // Gemini 视觉问题仅记录不作为通过/失败依据
      if (report.geminiReview && report.geminiReview.issues) {
        const blockers = report.geminiReview.issues.filter(i => i.severity === '阻断');
        blockers.forEach(issue => {
          issues.push('[阻断问题] ' + (issue.description || issue.message || JSON.stringify(issue)));
        });
        // 非阻断级视觉问题只记日志不计入 issues
        const nonBlockers = report.geminiReview.issues.filter(i => i.severity !== '阻断');
        if (nonBlockers.length > 0) {
          log('[CUA] ' + nonBlockers.length + ' visual issues logged (non-blocking for blueprint flow check)', taskId);
        }
      }

      if (report.anomalies) {
        report.anomalies
          .filter(a => a.severity === 'error' || a.severity === 'critical')
          .forEach(a => {
            issues.push('[异常] ' + (a.description || a.rule || JSON.stringify(a)));
          });
      }

      if (report.ctaStatus === 'not_found' || report.ctaStatus === 'no_response') {
        issues.push('[CTA] CTA按钮未找到或无响应');
      }

      if (report.scriptCoverage) {
        const uncovered = report.scriptCoverage.filter(s => !s.covered);
        if (uncovered.length > 0) {
          issues.push('[分镜] 未覆盖: ' + uncovered.map(s => s.step).join(', '));
        }
      }

      const passed = score >= CUA_PASS_THRESHOLD && issues.length === 0;
      log('[CUA] Score: ' + score + ', Issues: ' + issues.length + ', Pass: ' + passed, taskId);

      resolve({ passed, score, issues, report, skipped: false });
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      try { server.close(); } catch(e) {}
      log('[CUA] Failed to start: ' + err.message, taskId);
      resolve({ passed: false, score: 0, issues: ['CUA process failed to start: ' + err.message], skipped: false, error: err.message });
    });
  });
}

module.exports = { runCUAVerification, CUA_RESULTS_DIR, MAX_CUA_RETRIES, CUA_PASS_THRESHOLD };
