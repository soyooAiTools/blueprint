// Luna build via jake pipeline (requires Unity Editor running with HTTP Bridge)
const { execSync, spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const BRIDGE_PORT = 18801;
const BRIDGE_HOST = 'localhost';
const LUNA_DIR = 'D:\\Luna';
const PIPELINE_DIR = path.join(LUNA_DIR, 'pipeline');

function bridgeRequest(endpoint, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://${BRIDGE_HOST}:${BRIDGE_PORT}${endpoint}`, { timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf-8');
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function checkBridge() {
  try {
    const status = await bridgeRequest('/status', 5000);
    return status && status.ok;
  } catch { return false; }
}

/**
 * Run Luna build via jake pipeline
 * @param {string} clientDir - Unity project Client directory
 * @param {function} log - Logger
 * @param {string} taskId - Task ID
 * @returns {object} { ok, output, error, buildTime }
 */
async function runBridgeBuild(clientDir, log, taskId) {
  log = log || console.log;
  const startTime = Date.now();

  // 1. Check bridge is alive
  log('[luna-build] Checking Unity Bridge...', taskId);
  const alive = await checkBridge();
  if (!alive) {
    return { ok: false, error: 'Unity Bridge not responding on port ' + BRIDGE_PORT };
  }
  log('[luna-build] Bridge OK', taskId);

  // 2. Clean old LunaTemp
  const lunaTempDir = path.join(clientDir, 'LunaTemp');
  if (fs.existsSync(lunaTempDir)) {
    log('[luna-build] Cleaning old LunaTemp...', taskId);
    try { fs.rmSync(lunaTempDir, { recursive: true, force: true }); } catch (e) {
      log('[luna-build] Warning: ' + e.message, taskId);
    }
  }

  // 3. Run jake project:build
  log('[luna-build] Running jake project:build...', taskId);
  
  return new Promise((resolve) => {
    const env = { ...process.env, PROJECT_PATH: clientDir };
    const child = spawn('node', [
      '--max-old-space-size=8192',
      'jake.js', '-f', 'Jakefile.js', '--quiet', 'project:build'
    ], {
      cwd: PIPELINE_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let lastLog = Date.now();

    child.stdout.on('data', (data) => {
      const text = data.toString();
      stdout += text;
      // Log stage completions
      if (text.includes('Stage')) {
        const lines = text.split('\n').filter(l => l.includes('Stage'));
        lines.forEach(l => log('[luna-build] ' + l.trim(), taskId));
      }
      // Progress dots - log periodically
      if (Date.now() - lastLog > 30000 && text.includes('.')) {
        log('[luna-build] Still running... (' + Math.floor((Date.now() - startTime) / 1000) + 's)', taskId);
        lastLog = Date.now();
      }
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      const buildTime = Math.floor((Date.now() - startTime) / 1000);
      if (code === 0) {
        // Verify output exists
        const stage4 = path.join(lunaTempDir, 'stage4', 'develop');
        const hasOutput = fs.existsSync(path.join(stage4, 'index.html'));
        if (hasOutput) {
          log(`[luna-build] Build completed in ${buildTime}s`, taskId);
          resolve({ ok: true, output: `Build completed in ${buildTime}s`, buildTime, outputDir: stage4 });
        } else {
          resolve({ ok: false, error: 'Build exited 0 but no output in stage4/develop', buildTime });
        }
      } else {
        log(`[luna-build] Build failed (code ${code}) after ${buildTime}s`, taskId);
        // Extract error message
        const errorLines = stdout.split('\n').filter(l => /fail|error/i.test(l)).slice(-5);
        resolve({ ok: false, error: `Exit code ${code}: ${errorLines.join('; ') || stderr.slice(-500)}`, buildTime });
      }
    });

    // Timeout after 10 minutes
    setTimeout(() => {
      child.kill();
      resolve({ ok: false, error: 'Build timed out after 600s' });
    }, 600000);
  });
}

module.exports = { runBridgeBuild, checkBridge, bridgeRequest };

if (require.main === module) {
  (async () => {
    const clientDir = process.argv[2] || 'D:\\work\\test-luna\\Client';
    const result = await runBridgeBuild(clientDir, console.log, 'test');
    console.log('Result:', JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  })();
}
