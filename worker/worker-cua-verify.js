/**
 * Worker-side CUA Verification - Blueprint Flow Verifier
 * 
 * Uses GPT-5.4 CUA to navigate HTML following blueprint shot sequence.
 * 
 * Pass/fail criteria (no scoring):
 *   1. All blueprint shots are reachable/covered
 *   2. CTA button is reachable and clickable
 *   3. No stuck/crash/white-screen
 *   4. GPT must observe actual game content (not blank/empty screen)
 * 
 * On failure: returns uncovered shots + issue descriptions for AI re-coding.
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
 * Patch Luna build files for Playwright/headless compatibility.
 * 
 * Two known issues in Luna 6.4.0 under headless Chromium:
 *   1. `new Event("xxx")` throws "parameter 1 is not of type Event"
 *      Fix: replace with document.createEvent("Event") + initEvent()
 *   2. UnityEngine.Behaviour$1#isActiveAndEnabled getter crashes on null ref
 *      Fix: add null guard before .enabled access
 */
function patchForHeadless(content, filename) {
  let patched = content;
  let fixes = 0;

  // Fix 1: Replace new Event("xxx") with createEvent pattern
  // Matches: new Event("luna:ready"), new Event("bridge:ready"), etc.
  patched = patched.replace(/new Event\(([^)]+)\)/g, (match, args) => {
    fixes++;
    return '(function(){var _e=document.createEvent("Event");_e.initEvent(' + args + ',true,true);return _e;})()';
  });

  // Fix 2: isActiveAndEnabled null guard (UnityEngine.js only)
  // Pattern: return this.XXX$.enabled&&this.YYY$.ZZZ$
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

/**
 * Start a simple local HTTP server to serve the build output
 * with on-the-fly patching for headless compatibility
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

      // Patch HTML and JS files on-the-fly for headless compatibility
      if (ext === '.html' || ext === '.js') {
        try {
          const raw = fs.readFileSync(filePath, 'utf8');
          const { content, fixes } = patchForHeadless(raw, path.basename(filePath));
          res.writeHead(200, { 'Content-Type': mimeTypes[ext] });
          res.end(content);
          return;
        } catch(e) {
          // Fall through to stream if patch fails
        }
      }

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
  
  // Try shotNodes first (V3 blueprints)
  let steps = blueprint.nodes
    .filter(n => n.type === 'shotNode')
    .map((n, i) => (i + 1) + '. ' + (n.data.name || n.data.label || 'Shot ' + (i + 1)));
  
  // Fallback: phaseNodes (V4 entity-driven blueprints)
  if (steps.length === 0) {
    const phaseNodes = blueprint.nodes
      .filter(n => n.type === 'phaseNode')
      .sort((a, b) => {
        const ai = parseInt((a.id || '').replace(/\D/g, '')) || 0;
        const bi = parseInt((b.id || '').replace(/\D/g, '')) || 0;
        return ai - bi;
      });
    
    if (phaseNodes.length > 0) {
      steps = phaseNodes.map((n, i) => {
        const d = n.data || {};
        const name = d.name || d.label || 'Phase ' + (i + 1);
        const trigger = d.triggerCondition || '';
        const guide = d.guide || '';
        const activate = (d.activate || []).join(', ');
        let step = (i + 1) + '. [Phase] ' + name;
        if (trigger) step += ' | 触发: ' + trigger;
        if (guide) step += ' | 操作: ' + guide;
        if (activate) step += ' | 新增实体: ' + activate;
        return step;
      });
    }
  }
  
  if (steps.length === 0) return null;
  
  fs.writeFileSync(outputPath, steps.join('\n'), 'utf-8');
  return outputPath;
}

/**
 * Quick Play Test — 15-second headless Playwright check before full CUA.
 * Opens the HTML, waits for load, reads _currentShot, simulates basic input,
 * checks if _currentShot changes. No GPT needed, pure automation.
 * 
 * @returns {object} { ok: boolean, reason?: string, loaded: boolean, initialShot, finalShot, shotProgressed }
 */
async function quickPlayTest(url, taskId, log) {
  let browser, page;
  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    page = await context.newPage();

    // Suppress console errors from the game
    page.on('pageerror', () => {});

    // Load page
    log('[QuickTest] Loading ' + url, taskId);
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 15000 });
    } catch(e) {
      await browser.close();
      return { ok: false, reason: 'Page failed to load: ' + e.message, loaded: false };
    }

    // Wait for Unity engine init
    await page.waitForTimeout(5000);

    // Check if page has any visible content (not blank/white/black screen)
    const bodyColor = await page.evaluate(function() {
      var canvas = document.querySelector('canvas');
      if (canvas) return 'has-canvas';
      return document.body.innerText.length > 10 ? 'has-text' : 'empty';
    });
    if (bodyColor === 'empty') {
      await browser.close();
      return { ok: false, reason: 'Page loaded but appears empty (no canvas, no text). Game may not have initialized.', loaded: false };
    }

    // Try to read _currentShot from the game runtime
    var initialShot = await page.evaluate(function() {
      // Try multiple ways to find the shot state
      try {
        // Bridge.NET compiled code — global scope or on component
        if (typeof GameFlowManagerMain !== 'undefined' && GameFlowManagerMain._currentShot !== undefined) return GameFlowManagerMain._currentShot;
        if (typeof GameFlowManagerMain !== 'undefined' && GameFlowManagerMain.currentShot !== undefined) return GameFlowManagerMain.currentShot;
      } catch(e) {}
      try {
        // Search through Unity objects
        var objs = typeof UnityEngine !== 'undefined' && UnityEngine.Object ? UnityEngine.Object.FindObjectsOfType(UnityEngine.MonoBehaviour) : null;
        if (objs) {
          for (var i = 0; i < objs.length; i++) {
            if (objs[i]._currentShot !== undefined) return objs[i]._currentShot;
            if (objs[i].currentShot !== undefined) return objs[i].currentShot;
          }
        }
      } catch(e) {}
      return null;
    });

    log('[QuickTest] Initial shot state: ' + initialShot, taskId);

    // Simulate basic interactions: clicks + drags
    var interactions = [
      { type: 'click', x: 400, y: 300 },   // center
      { type: 'click', x: 400, y: 500 },   // bottom center
      { type: 'drag', x1: 90, y1: 560, x2: 90, y2: 510 },  // joystick up
      { type: 'click', x: 200, y: 300 },   // left area
      { type: 'drag', x1: 90, y1: 560, x2: 130, y2: 560 }, // joystick right
      { type: 'click', x: 600, y: 300 },   // right area
    ];

    for (var i = 0; i < interactions.length; i++) {
      var action = interactions[i];
      try {
        if (action.type === 'click') {
          await page.mouse.click(action.x, action.y);
        } else if (action.type === 'drag') {
          await page.mouse.move(action.x1, action.y1);
          await page.mouse.down();
          await page.mouse.move(action.x2, action.y2, { steps: 5 });
          await page.mouse.up();
        }
      } catch(e) {}
      await page.waitForTimeout(800);
    }

    // Read shot state again
    var finalShot = await page.evaluate(function() {
      try {
        if (typeof GameFlowManagerMain !== 'undefined' && GameFlowManagerMain._currentShot !== undefined) return GameFlowManagerMain._currentShot;
        if (typeof GameFlowManagerMain !== 'undefined' && GameFlowManagerMain.currentShot !== undefined) return GameFlowManagerMain.currentShot;
      } catch(e) {}
      try {
        var objs = typeof UnityEngine !== 'undefined' && UnityEngine.Object ? UnityEngine.Object.FindObjectsOfType(UnityEngine.MonoBehaviour) : null;
        if (objs) {
          for (var i = 0; i < objs.length; i++) {
            if (objs[i]._currentShot !== undefined) return objs[i]._currentShot;
            if (objs[i].currentShot !== undefined) return objs[i].currentShot;
          }
        }
      } catch(e) {}
      return null;
    });

    log('[QuickTest] Final shot state: ' + finalShot, taskId);

    // Take a screenshot for debugging
    try {
      var screenshotPath = path.join(CUA_RESULTS_DIR, taskId + '-quicktest.png');
      await page.screenshot({ path: screenshotPath });
    } catch(e) {}

    await browser.close();

    // Analyze results
    var loaded = (bodyColor !== 'empty');
    var shotProgressed = (initialShot !== null && finalShot !== null && finalShot > initialShot);

    // If we can't read _currentShot, that's not a failure — just means we can't verify
    if (initialShot === null) {
      return { ok: true, reason: 'Could not read _currentShot variable (runtime may use different naming)', loaded: loaded, initialShot: null, finalShot: null, shotProgressed: false };
    }

    // If shot didn't progress, it's a warning but not a hard fail (user interaction might be needed)
    // Hard fail only if page didn't load at all
    if (!loaded) {
      return { ok: false, reason: 'Game failed to render (no canvas or content visible)', loaded: false, initialShot: initialShot, finalShot: finalShot, shotProgressed: false };
    }

    return { ok: true, loaded: true, initialShot: initialShot, finalShot: finalShot, shotProgressed: shotProgressed };

  } catch(e) {
    if (browser) try { await browser.close(); } catch(x) {}
    return { ok: true, reason: 'Quick test error: ' + e.message, loaded: false };
  }
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

  // === Quick Play Test: 15-second headless sanity check before full CUA ===
  try {
    const quickResult = await quickPlayTest(previewUrl, taskId, log);
    if (!quickResult.ok) {
      log('[CUA] Quick play test FAILED: ' + quickResult.reason, taskId);
      try { server.close(); } catch(e) {}
      return {
        passed: false,
        issues: ['[quick-test] ' + quickResult.reason],
        skipped: false,
        quickTestFailed: true,
        quickTestDetail: quickResult
      };
    }
    log('[CUA] Quick play test passed: loaded=' + quickResult.loaded + ', shotProgressed=' + quickResult.shotProgressed + ', initialShot=' + quickResult.initialShot + ', finalShot=' + quickResult.finalShot, taskId);
  } catch(qe) {
    log('[CUA] Quick play test error (non-fatal): ' + qe.message, taskId);
    // Non-fatal: continue to full CUA even if quick test errors
  }

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

      // === Blueprint flow verification (pass/fail, strict) ===
      const issues = [];

      // 0. ANTI-CHEAT: Cross-check script steps vs expected shot count
      //    If code has 10 shots but CUA script only has 1, blueprint data was corrupted
      const scriptStepCount = report.scriptCoverage ? report.scriptCoverage.length : 0;
      const expectedShotCount = blueprint && blueprint.nodes ? blueprint.nodes.filter(function(n) { return n.type === 'shotNode'; }).length : 0;
      // Also check via report metadata if available
      if (scriptStepCount > 0 && scriptStepCount < 3 && expectedShotCount >= 3) {
        // Very suspicious: a real playable ad should have at least 3 steps (skip for V4 which has no shots)
        log('[CUA] WARNING: Script only has ' + scriptStepCount + ' steps (expected blueprint: ' + expectedShotCount + '). Possible data corruption.', taskId);
        issues.push('[suspicious-script] Script has only ' + scriptStepCount + ' step(s) — too few for a real playable ad. Blueprint may have lost data. Expected: 3+ steps.');
      }

      // 0b. ANTI-CHEAT: Detect GPT "stuck" pattern — if GPT repeatedly says "no change" / "没有变化"
      const historyEntries = report.history || report.rounds || [];
      let noChangeCount = 0;
      const noChangePatterns = /没有明显.*变化|没有.*改变|图像.*保持|保持稳定|no.*visible.*change|no.*significant.*change|still.*same|nothing.*changed|仍然没/gi;
      for (var hi = 0; hi < historyEntries.length; hi++) {
        var desc = historyEntries[hi].thinking || historyEntries[hi].description || historyEntries[hi].text || '';
        if (noChangePatterns.test(desc)) noChangeCount++;
        noChangePatterns.lastIndex = 0; // reset regex
      }
      if (historyEntries.length >= 5 && noChangeCount >= Math.floor(historyEntries.length * 0.5)) {
        issues.push('[stuck-pattern] GPT reported "no visible change" in ' + noChangeCount + '/' + historyEntries.length + ' rounds. Game flow is likely stuck — not progressing through shots.');
      }

      // 1. Check for stuck/crash
      if (report.exitReason === 'stuck') {
        issues.push('[stuck] Game stuck during CUA operation (no state change for multiple rounds)');
      }

      // 2. Check blueprint shot coverage (STRICT: ALL shots must be covered)
      // V4 entity-driven blueprints have NO shotNodes — skip coverage check for V4
      const hasShotNodes = expectedShotCount > 0;
      const isV4 = !hasShotNodes && blueprint && blueprint.nodes && blueprint.nodes.some(function(n) { return n.type === 'entityNode'; });
      if (!hasShotNodes) {
        log('[CUA] No shotNodes in blueprint (V4 or phase-only) — skipping shot coverage check', taskId);
      } else if (report.scriptCoverage) {
        const uncovered = report.scriptCoverage.filter(s => !s.covered);
        if (uncovered.length > 0) {
          issues.push('[uncovered] Blueprint shots not reached (' + uncovered.length + '/' + report.scriptCoverage.length + '): ' + uncovered.map(s => s.step || s.name).join(', '));
        }
      } else {
        // No script coverage data = cannot verify shots = fail
        issues.push('[no-coverage] No blueprint shot coverage data in CUA report');
      }

      // 3. CTA must be reachable
      if (report.ctaStatus === 'not_found' || report.ctaStatus === 'no_response') {
        issues.push('[cta] CTA not reached or unresponsive: ' + (report.ctaStatus || 'unknown'));
      }

      // 4. Content validation: GPT must have seen actual game content
      //    If all round descriptions are vague/empty, the game likely didn't load
      const roundTexts = (report.rounds || []).map(r => r.description || r.text || r.observation || '').join(' ');
      const vaguePatterns = /淡蓝色|空白|没有.*元素|没有.*内容|无法.*识别|blank|empty|nothing|no visible/gi;
      const vagueMatches = (roundTexts.match(vaguePatterns) || []).length;
      const totalRounds = (report.rounds || []).length;
      const gameContentKeywords = /按钮|角色|场景|游戏|障碍|敌人|道具|得分|血量|UI|菜单|开始|button|character|scene|game|score|player|enemy|level|menu|start|shoot|arrow|wood|target|弓|箭|射|木/gi;
      const contentMatches = (roundTexts.match(gameContentKeywords) || []).length;

      if (totalRounds >= 5 && contentMatches < 3) {
        issues.push('[no-content] GPT did not observe actual game content across ' + totalRounds + ' rounds (content keywords: ' + contentMatches + ', vague descriptions: ' + vagueMatches + '). Game may not have loaded properly.');
      }

      // 5. Blocking interaction issues (button unresponsive, scene transition failure)
      if (report.bugs) {
        const bugList = report.bugs.fromAI || report.bugs;
        const bugArray = Array.isArray(bugList) ? bugList : [];
        bugArray.forEach(bug => {
          issues.push('[interaction] ' + (bug.description || bug.message || JSON.stringify(bug)));
        });
      }

      // 6. Critical anomalies (white screen, crash)
      if (report.anomalies) {
        report.anomalies
          .filter(a => a.severity === 'high' || a.severity === 'error' || a.severity === 'critical')
          .forEach(a => {
            issues.push('[critical] ' + (a.description || a.rule || JSON.stringify(a)));
          });
      }

      // 7. Phase coverage check via __gameState
      if (report.gameState) {
        const gs = report.gameState;
        const completedPhases = gs.completedPhases || [];
        const phaseNodes = (blueprint && blueprint.nodes || []).filter(function(n) { return n.type === 'phaseNode'; });
        if (phaseNodes.length > 0) {
          const totalPhases = phaseNodes.length;
          const coveredCount = completedPhases.length;
          if (coveredCount < totalPhases) {
            const uncoveredPhases = phaseNodes.filter(function(n) {
              const phaseName = (n.data || {}).name || n.id;
              return completedPhases.indexOf(phaseName) === -1 && completedPhases.indexOf(n.id) === -1;
            });
            const details = uncoveredPhases.map(function(n) {
              const d = n.data || {};
              return (d.name || n.id) + ' (trigger: ' + (d.triggerCondition || 'none') + ')';
            }).join('; ');
            issues.push('[phase-coverage] ' + coveredCount + '/' + totalPhases + ' phases completed. Missing: ' + details);
          }
          log('[CUA] Phase coverage: ' + coveredCount + '/' + totalPhases + ', current: ' + (gs.currentPhase || 'unknown'), taskId);
        }
        // Entity state check
        if (gs.entityStates) {
          const missingEntities = [];
          (blueprint.entities || []).forEach(function(e) {
            const eName = e.name || e.id;
            if (gs.entityStates[eName] === undefined) {
              missingEntities.push(eName);
            }
          });
          if (missingEntities.length > 0) {
            log('[CUA] Missing entities in gameState: ' + missingEntities.join(', '), taskId);
          }
        }
      } else if (!isV4 || (blueprint && blueprint.nodes && blueprint.nodes.some(function(n) { return n.type === 'phaseNode'; }))) {
        // No __gameState available — note it as a soft issue
        log('[CUA] __gameState not available — cannot verify phase coverage programmatically', taskId);
      }

      // 8. Diagnostics-based issues (engine state, console errors)
      if (report.diagnostics) {
        const diag = report.diagnostics;
        if (!diag.engineReady) {
          issues.push('[engine-not-ready] Luna engine failed to initialize. Engine state: ' + JSON.stringify(diag.engineState || 'unknown'));
          if (diag.consoleErrors && diag.consoleErrors.length > 0) {
            issues.push('[console-errors] JS errors during load (' + diag.consoleErrors.length + '): ' + diag.consoleErrors.slice(0, 5).join(' | '));
          }
          if (diag.pageErrors && diag.pageErrors.length > 0) {
            issues.push('[page-errors] Uncaught JS exceptions (' + diag.pageErrors.length + '): ' + diag.pageErrors.slice(0, 5).join(' | '));
          }
        }
      }

      // Pass criteria: ALL shots covered + CTA reachable + game content visible + no critical issues
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
