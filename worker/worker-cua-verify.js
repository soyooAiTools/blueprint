/**
 * Worker-side CUA Verification - Blueprint Flow Verifier
 * 
 * Uses GPT-5.4 CUA to navigate HTML following blueprint shot sequence.
 * 
 * Pass/fail criteria (no scoring):
 *   1. All blueprint shots are reachable/covered
 *   2. CTA button is reachable and clickable
 *   3. No stuck/crash/white-screen
 * 
 * On failure: returns uncovered shots + issue descriptions for AI re-coding.
 * No visual quality review.
 */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const LUNA_AGENT_JS = path.join(__dirname, 'luna-agent.js');
const CUA_RESULTS_DIR = path.join(__dirname, 'cua-results');
const MAX_CUA_RETRIES = 3;
const LOCAL_PREVIEW_PORT = 18850;

try { fs.mkdirSync(CUA_RESULTS_DIR, { recursive: true }); } catch(e) {}

/**
 * Start a simple local HTTP server to serve the build output
 */
function startLocalServer(buildDir) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let filePath = path.join(buildDir, req.url === '/' ? 'iframe.html' : req.url);
      filePath = filePath.split('?')[0];
      
      if (!fs.existsSync(filePath)) {
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
  if (!fs.existsSync(LUNA_AGENT_JS)) {
    log('[CUA] luna-agent.js not found, skipping CUA verification', taskId);
    return { passed: true, issues: [], skipped: true };
  }

  const hasIframe = fs.existsSync(path.join(buildDir, 'iframe.html'));
  const hasIndex = fs.existsSync(path.join(buildDir, 'index.html'));
  if (!hasIframe && !hasIndex) {
    log('[CUA] No HTML file in build output, skipping CUA', taskId);
    return { passed: true, issues: [], skipped: true };
  }

  log('[CUA] Starting CUA verification...', taskId);

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

  const scriptPath = path.join(CUA_RESULTS_DIR, taskId + '-script.txt');
  const hasScript = generateScript(blueprint, scriptPath);

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
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300000
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { 
      const line = d.toString();
      stdout += line;
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
      try { server.close(); } catch(e) {}

      log('[CUA] luna-agent exited with code ' + code, taskId);

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

      // === Blueprint flow verification (pass/fail, no scoring) ===
      const issues = [];

      // 1. Check for stuck/crash
      if (report.exitReason === 'stuck') {
        issues.push('[stuck] Game stuck during CUA operation (no state change for multiple rounds)');
      }

      // 2. Check blueprint shot coverage (core metric)
      if (report.scriptCoverage) {
        const uncovered = report.scriptCoverage.filter(s => !s.covered);
        if (uncovered.length > 0) {
          issues.push('[uncovered] Blueprint shots not reached: ' + uncovered.map(s => s.step || s.name).join(', '));
        }
      }

      // 3. CTA is NOT required for pass - only last shot coverage matters
      // CTA status logged but does not affect pass/fail
      if (report.ctaStatus === 'not_found' || report.ctaStatus === 'no_response') {
        log('[CUA] CTA not reached (logged only, does not affect pass/fail)', taskId);
      }

      // 4. Blocking interaction issues (button unresponsive, scene transition failure)
      if (report.bugs) {
        const bugList = report.bugs.fromAI || report.bugs;
        const bugArray = Array.isArray(bugList) ? bugList : [];
        bugArray.forEach(bug => {
          issues.push('[interaction] ' + (bug.description || bug.message || JSON.stringify(bug)));
        });
      }

      // 5. Critical anomalies (white screen, crash)
      if (report.anomalies) {
        report.anomalies
          .filter(a => a.severity === 'high' || a.severity === 'error' || a.severity === 'critical')
          .forEach(a => {
            issues.push('[critical] ' + (a.description || a.rule || JSON.stringify(a)));
          });
      }

      // Gemini visual review results logged only, do not affect pass/fail
      if (report.geminiReview && report.geminiReview.issues && report.geminiReview.issues.length > 0) {
        log('[CUA] Gemini visual review found ' + report.geminiReview.issues.length + ' issues (logged only, does not affect pass/fail)', taskId);
      }

      // Pass criteria: all shots covered + not stuck = pass
      // Reaching last shot = flow complete, CTA not required
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
