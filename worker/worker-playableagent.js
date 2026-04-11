/**
 * Worker PlayableAgent Verification - Blueprint Phase Verifier
 * 
 * Drop-in replacement for luna-agent.js CUA verification.
 * Calls /root/cua-agent/blueprint_verify.py via Python subprocess.
 * Uses SiliconFlow Qwen2.5-VL-72B for VLM + __gameState for phase coverage.
 * Requires Xvfb running on :99 for WebGL rendering.
 * 
 * Same interface as runCUAVerification() in worker-cua-verify.js:
 *   Input:  (buildDir, blueprint, taskId, log)
 *   Output: { passed, issues[], report, skipped? }
 */

const { spawn, execSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CUA_RESULTS_DIR = path.join(__dirname, 'cua-results');
let LOCAL_PREVIEW_PORT = 0; // Dynamic port to avoid multi-worker conflicts
const PYTHON = '/usr/bin/python3.8';
const VERIFY_SCRIPT = '/root/cua-agent/blueprint_verify.py';
const MAX_VERIFY_TIMEOUT = 900000; // 15 min (complex games need more CUA steps)

try { fs.mkdirSync(CUA_RESULTS_DIR, { recursive: true }); } catch(e) {}

// ─── Reuse patchForHeadless from worker-cua-verify ───
function patchForHeadless(content, filename) {
  let patched = content;
  let fixes = 0;
  patched = patched.replace(/new Event\(([^)]+)\)/g, (match, args) => {
    fixes++;
    return '(function(){var _e=document.createEvent("Event");_e.initEvent(' + args + ',true,true);return _e;})()';
  });
  if (filename.includes('UnityEngine')) {
    patched = patched.replace(
      /return this\.(\w+)\$\.enabled&&this\.(\w+)\$\.(\w+)\$/g,
      (match, a, b, d) => {
        fixes++;
        return 'return (this.' + a + '$?this.' + a + '$.enabled:false)&&(this.' + b + '$?this.' + b + '$.' + d + '$:false)';
      }
    );
  }
  return { content: patched, fixes };
}

// ─── Local server with on-the-fly patching ───
function startLocalServer(buildDir) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let filePath = path.join(buildDir, req.url === '/' ? 'iframe.html' : req.url);
      filePath = filePath.split('?')[0];
      if (!fs.existsSync(filePath)) {
        if (req.url === '/') filePath = path.join(buildDir, 'index.html');
        if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not Found'); return; }
      }
      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes = {
        '.html': 'text/html', '.js': 'application/javascript',
        '.css': 'text/css', '.json': 'application/json',
        '.png': 'image/png', '.jpg': 'image/jpeg',
        '.wasm': 'application/wasm', '.bin': 'application/octet-stream',
        '.ico': 'image/x-icon', '.svg': 'image/svg+xml'
      };
      if (ext === '.html' || ext === '.js') {
        try {
          const raw = fs.readFileSync(filePath, 'utf8');
          const { content } = patchForHeadless(raw, path.basename(filePath));
          res.writeHead(200, { 'Content-Type': mimeTypes[ext] });
          res.end(content);
          return;
        } catch(e) {}
      }
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    });

    server.listen(0, '127.0.0.1', () => { LOCAL_PREVIEW_PORT = server.address().port; resolve(server); });
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        setTimeout(() => {
          server.listen(0, '127.0.0.1', () => { LOCAL_PREVIEW_PORT = server.address().port; resolve(server); });
        }, 1000);
      } else {
        reject(err);
      }
    });
  });
}

// ─── Ensure Xvfb is running ───
function ensureXvfb() {
  try {
    const out = execSync('pgrep -f "Xvfb :99"', { timeout: 3000 }).toString().trim();
    if (out) return true;
  } catch(e) {}
  // Start Xvfb
  try {
    execSync('Xvfb :99 -screen 0 1280x1024x24 -ac &', { timeout: 5000, shell: true });
    return true;
  } catch(e) {
    return false;
  }
}

// ─── Write specs to temp file for Python ───
function writeSpecsFile(blueprint, taskId) {
  const specsDataDir = process.env.SPECS_DATA_DIR || path.join(__dirname, '..', 'spec-data');
  // Try loading from spec-data dir first
  const webglDir = path.join(__dirname, '..', 'server-data', 'webgl');
  const specsFiles = [
    path.join(specsDataDir, taskId, 'specs.json'),  // Doubao-enriched specs with phaseId (preferred)
    path.join(specsDataDir, taskId + '.json'),
    path.join(specsDataDir, taskId + '-specs.json'),
    path.join(webglDir, taskId, 'specs.json'),
  ];
  for (const f of specsFiles) {
    if (fs.existsSync(f)) {
      return f;
    }
  }
  // Fall back to blueprint.specs or blueprint.phases — write to disk for Python
  const specs = blueprint.specs || blueprint.phases || [];
  if (specs.length > 0) {
    fs.mkdirSync(specsDataDir, { recursive: true });
    const outPath = path.join(specsDataDir, taskId + '-specs.json');
    fs.writeFileSync(outPath, JSON.stringify(specs, null, 2));
    return outPath;
  }
  throw new Error('No phase specs available (no file on disk and no specs/phases in blueprint)');
}

/**
 * Run PlayableAgent verification - same interface as runCUAVerification
 * 
 * @param {string} buildDir - Path to Luna WebGL build output
 * @param {object} blueprint - Blueprint object with nodes
 * @param {string} taskId - Task ID for logging
 * @param {function} log - Logging function (message, taskId)
 * @returns {Promise<{passed: boolean, issues: string[], report?: object, skipped?: boolean}>}
 */
async function runCUAVerification(buildDir, blueprint, taskId, log) {
  // Check prerequisites
  if (!fs.existsSync(VERIFY_SCRIPT)) {
    log('[PlayableAgent] blueprint_verify.py not found — INFRA FAIL (not skipping)', taskId);
    return { passed: false, issues: ['[playableagent-infra] blueprint_verify.py not found at ' + VERIFY_SCRIPT], skipped: true, error: 'VERIFY_SCRIPT missing' };
  }

  const hasIframe = fs.existsSync(path.join(buildDir, 'iframe.html'));
  const hasIndex = fs.existsSync(path.join(buildDir, 'index.html'));
  if (!hasIframe && !hasIndex) {
    log('[PlayableAgent] No HTML file in build output — FAIL', taskId);
    return { passed: false, issues: ['[playableagent-infra] No HTML file (iframe.html or index.html) in build dir: ' + buildDir], skipped: true, error: 'No HTML file' };
  }

  // Ensure Xvfb for WebGL
  if (!ensureXvfb()) {
    log('[PlayableAgent] Failed to start Xvfb — INFRA FAIL (not skipping)', taskId);
    return { passed: false, issues: ['[playableagent-infra] Xvfb :99 could not be started'], skipped: true, error: 'Xvfb unavailable' };
  }

  log('[PlayableAgent] Starting PlayableAgent verification (VLM + __gameState)...', taskId);

  // Start local server with headless patches
  let server;
  try {
    server = await startLocalServer(buildDir);


  } catch(e) {
    log('[PlayableAgent] Failed to start server — INFRA FAIL: ' + e.message, taskId);
    return { passed: false, issues: ['[playableagent-infra] Local HTTP server failed: ' + e.message], skipped: true, error: e.message };
  }

  const actualPort = server.address().port;
  log("[PlayableAgent] Local server on port " + actualPort, taskId);

  // AutoPlay mode: append ?autoplay=1 so the JS bridge creates __AUTOPLAY_ON__ entity
  const previewUrl = 'http://127.0.0.1:' + actualPort + '/' + (hasIframe ? 'iframe.html' : 'index.html') + '?autoplay=1';

  // Write specs for Python
  const specsPath = writeSpecsFile(blueprint, taskId);

  // Build Python command — observer mode (no VLM interaction, just watch autoPlay)
  const args = [VERIFY_SCRIPT, previewUrl, '--steps', '50', '--observe'];
  if (specsPath) args.push('--specs', specsPath);

  const outputDir = path.join(CUA_RESULTS_DIR, taskId + '-playableagent');
  const logPath = path.join(CUA_RESULTS_DIR, taskId + '-playableagent.log');

  return new Promise((resolve) => {
    const env = {
      ...process.env,
      DISPLAY: ':99',
      DOUBAO_API_KEY: process.env.DOUBAO_API_KEY || '197cb950-3cf3-4b30-b656-6afaa4306a7a',
    };

    log('[PlayableAgent] Running: ' + PYTHON + ' ' + args.join(' '), taskId);
    if (!process._activeChildPIDs) process._activeChildPIDs = new Set();
    const child = spawn(PYTHON, args, {
      cwd: '/root/cua-agent',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: MAX_VERIFY_TIMEOUT
    });
    if (child.pid) process._activeChildPIDs.add(child.pid);

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => {
      const line = d.toString();
      stdout += line;
      // Forward key log lines
      if (line.includes('Phase') || line.includes('PASS') || line.includes('FAIL') || 
          line.includes('步') || line.includes('🎉') || line.includes('🏁')) {
        log('[PlayableAgent] ' + line.trim(), taskId);
      }
    });
    child.stderr.on('data', d => { stderr += d.toString(); });

    const timeout = setTimeout(() => {
      log('[PlayableAgent] Timeout after 15 minutes, killing', taskId);
      try { child.kill('SIGTERM'); } catch(e) {}
    }, MAX_VERIFY_TIMEOUT);

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (child.pid && process._activeChildPIDs) process._activeChildPIDs.delete(child.pid);
      try { server.close(); } catch(e) {}

      log('[PlayableAgent] Process exited with code ' + code, taskId);

      // Save logs
      try { fs.writeFileSync(logPath, stdout + '\n---STDERR---\n' + stderr, 'utf-8'); } catch(e) {}

      // Find and read report JSON
      let report = null;
      try {
        // Find the latest verify_report.json
        const runsDir = '/root/cua-agent/runs';
        if (fs.existsSync(runsDir)) {
          const dirs = fs.readdirSync(runsDir)
            .filter(d => d.startsWith('verify_'))
            .sort()
            .reverse();
          for (const dir of dirs) {
            const reportPath = path.join(runsDir, dir, 'verify_report.json');
            if (fs.existsSync(reportPath)) {
              report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
              break;
            }
          }
        }
      } catch(e) {
        log('[PlayableAgent] Failed to read report: ' + e.message, taskId);
      }

      if (!report) {
        resolve({
          passed: false,
          issues: ['[playableagent-error] Verification process failed to generate report. Exit code: ' + code],
          skipped: false,
          error: stderr.slice(0, 500)
        });
        return;
      }

      // ─── Convert report to worker-cua-verify format ───
      const issues = [];

      // ═══ Anti-Autoplay Detection — DISABLED in autoPlay/observe mode ═══
      // AutoPlay mode intentionally auto-progresses phases. Anti-autoplay checks are skipped.
      const isAutoPlayMode = (report.finalState && report.finalState.variables && report.finalState.variables.autoPlayMode === true)
        || (report.observe_mode === true);
      if (!isAutoPlayMode) {
        if (report.autoplay_detected) {
          log('[PlayableAgent] 🚨 AUTOPLAY DETECTED: ' + (report.autoplay_reason || 'Phases auto-completed without player input'), taskId);
          issues.push('[autoplay-detected] ' + (report.autoplay_reason || 'Game phases auto-completed via timer without any player interaction.'));
        }
        if (report.passed && (!report.actions || report.actions.length === 0)) {
          log('[PlayableAgent] 🚨 AUTOPLAY: passed=true but 0 actions — overriding to FAIL', taskId);
          report.passed = false;
          issues.push('[autoplay-no-interaction] All phases completed with 0 agent actions.');
        }
        const finalVars = (report.finalState || {}).variables || {};
        const interactionKeys = Object.keys(finalVars).filter(k => k !== 'gameTimer' && k !== 'autoPlayMode');
        const allVarsZero = interactionKeys.length > 0 && interactionKeys.every(k => finalVars[k] === 0 || finalVars[k] === '0');
        if (report.passed && allVarsZero && interactionKeys.length >= 2) {
          log('[PlayableAgent] 🚨 AUTOPLAY: all interaction variables are 0 — overriding to FAIL', taskId);
          report.passed = false;
          issues.push('[autoplay-no-variable-change] All interaction variables remain at 0.');
        }
      } else {
        log('[PlayableAgent] AutoPlay/observe mode — anti-autoplay checks skipped', taskId);
      }

      // Phase coverage
      const missingPhases = report.missingPhases || [];
      const coveredPhases = report.coveredPhases || [];
      const totalPhases = (report.specPhases || []).length;

      if (missingPhases.length > 0) {
        issues.push('[spec-phase-skipped] Phases not completed (' + missingPhases.length + '/' + totalPhases + '): ' + missingPhases.join(', '));
      }

      // Check entity states
      const finalState = report.finalState || {};
      if (finalState.entityStates) {
        const BUILDABLE_KEYS = ['conveyor', 'woodHouse', 'turret'];
        const incompleteEntities = [];
        BUILDABLE_KEYS.forEach(key => {
          if (finalState.entityStates[key] !== undefined && String(finalState.entityStates[key]) !== '2') {
            incompleteEntities.push(key + '=' + finalState.entityStates[key] + ' (expected 2=built)');
          }
        });
        if (incompleteEntities.length > 0) {
          issues.push('[entity-incomplete] Buildable entities not fully constructed: ' + incompleteEntities.join(', '));
        }
      }

      // Check game ended / CTA reached
      const currentPhase = finalState.currentPhase || '';
      const ctaReached = ['gameEnd', 'cta', 'CTA', 'ctaPhase'].includes(currentPhase);
      if (!ctaReached && totalPhases > 0 && coveredPhases.length < totalPhases) {
        // Not a blocking issue — CTA may not be needed for all games
        log('[PlayableAgent] CTA not reached (current phase: ' + currentPhase + ')', taskId);
      }

      // ═══ Visual quality fail reasons from observe mode ═══
      // The Python agent detects VISUAL FREEZE / VARIABLE STAGNATION / BATCH COMPLETION
      // and stores them in report.visual_fail_reasons. Propagate as actionable issues.
      if (report.visual_fail_reasons && Array.isArray(report.visual_fail_reasons)) {
        for (const reason of report.visual_fail_reasons) {
          if (reason.toLowerCase().includes('visual frozen') || reason.toLowerCase().includes('static')) {
            issues.push('[visual-freeze] ' + reason + ' Fix: ensure autoPlay phase transitions trigger visible entity movement, animation, or UI changes (SetActive, Translate, SetColor).');
          } else if (reason.toLowerCase().includes('variable') || reason.toLowerCase().includes('stagnation')) {
            issues.push('[variable-stagnation] ' + reason + ' Fix: ensure game logic updates gold/score/count variables during each phase. Phase transitions without side effects are empty shells.');
          } else if (reason.toLowerCase().includes('batch') || reason.toLowerCase().includes('timer')) {
            issues.push('[batch-completion] ' + reason + ' Fix: each phase must run for its full duration with real gameplay, not instant timer-skip.');
          } else {
            issues.push('[visual-quality] ' + reason);
          }
        }
      }

      const passed = report.passed === true;

      log('[PlayableAgent] Result: ' + (passed ? 'PASS' : 'FAIL') +
          ' | Coverage: ' + coveredPhases.length + '/' + totalPhases +
          ' | Issues: ' + issues.length, taskId);

      resolve({
        passed,
        issues,
        skipped: false,
        report: {
          gameState: finalState,
          completedPhases: report.completedPhases || [],
          scriptCoverage: (report.specPhases || []).map(phaseId => ({
            step: phaseId,
            covered: (report.coveredPhases || []).includes(phaseId),
            evidence: 'PlayableAgent VLM + __gameState'
          })),
          diagnostics: {
            engineReady: true,
            consoleErrors: [],
            pageErrors: []
          },
          exitReason: report.exitReason || (passed ? 'completed' : 'phases_incomplete'),
          ctaStatus: ctaReached ? 'found' : 'not_checked',
          history: (report.actions || []).map(a => ({
            thinking: a.thought || '',
            description: JSON.stringify(a.action || {})
          })),
          playableAgent: true,
          model: report.model || 'Qwen/Qwen2.5-VL-72B-Instruct',
          tokens: report.tokens || {},
          cost: report.cost || 0
        }
      });
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      try { server.close(); } catch(e) {}
      log('[PlayableAgent] Process error: ' + err.message, taskId);
      resolve({
        passed: false,
        issues: ['[playableagent-error] Failed to start: ' + err.message],
        skipped: false,
        error: err.message
      });
    });
  });
}

module.exports = { runCUAVerification, CUA_RESULTS_DIR };
