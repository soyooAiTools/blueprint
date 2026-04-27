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

const silentPassDetectors = require('../adapters/silent-pass-detectors.cjs');
const { buildSpecsFromPlans } = require('../adapters/cua-plan-bridge.cjs');

const CUA_RESULTS_DIR = path.join(__dirname, 'cua-results');
let LOCAL_PREVIEW_PORT = 0; // Dynamic port to avoid multi-worker conflicts
const PYTHON = '/usr/bin/python3.8';
const VERIFY_SCRIPT = '/root/cua-agent/blueprint_verify.py';

// G1 (2026-04-20): kill-switch timeout scales with phase count so simple tasks
// abort faster on Python hangs. Floor 3min / cap 15min — Python agent has its
// own per-mode timers (observe max_observe_s, interact max_interact_s), so
// this is the outer safety net, not the primary timer.
// Formula: max(180, min(phases*60 + 90, 900)) seconds.
// Table: 1p→180s, 3p→270s, 5p→390s, 8p→570s, 11p→750s, 14p+→900s (cap).
function computeVerifyTimeoutMs(phaseCount) {
  var n = Math.max(0, parseInt(phaseCount, 10) || 0);
  var seconds = Math.max(180, Math.min(n * 60 + 90, 900));
  return seconds * 1000;
}

try { fs.mkdirSync(CUA_RESULTS_DIR, { recursive: true }); } catch(e) {}

// ─── Reuse patchForHeadless from worker-cua-verify ───
// highComplexity flag: for games with many phases (>8), use conservative
// timer reduction to prevent phase batch-fire. At 5x speed + 2s gates,
// all phases complete in <1 poll cycle (1.5s) and CUA can't observe them.
var _patchHighComplexity = false;

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
  if (filename.includes('.html') || filename.includes('index')) {
    if (_patchHighComplexity) {
      // High complexity (>8 phases): keep original timer gates, only reduce
      // extremely high values. With 2x speed this gives ~3s real-time per phase.
      patched = patched.replace(/this\.phaseTimer\s*>=\s*(\d+)\.0/g, (match, val) => {
        var orig = parseInt(val, 10);
        if (orig > 30) { fixes++; return 'this.phaseTimer >= 20.0'; }
        return match;
      });
      patched = patched.replace(/this\._autoInteractTimer\s*>=\s*3\.0/g, () => {
        fixes++;
        return 'this._autoInteractTimer >= 2.0';
      });
    } else {
      // Normal complexity (<=8 phases): aggressive reduction for speed
      patched = patched.replace(/this\.phaseTimer\s*>=\s*(\d+)\.0/g, (match, val) => {
        var orig = parseInt(val, 10);
        if (orig >= 5) { fixes++; return 'this.phaseTimer >= 2.0'; }
        return match;
      });
      patched = patched.replace(/this\._autoInteractTimer\s*>=\s*3\.0/g, () => {
        fixes++;
        return 'this._autoInteractTimer >= 1.0';
      });
      patched = patched.replace(/this\.phaseTimer\s*>=\s*\(false\s*\?\s*50\.0\s*:\s*50\.0\)/g, () => {
        fixes++;
        return 'this.phaseTimer >= (false ? 15.0 : 15.0)';
      });
    }
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
  let specs = blueprint.specs || blueprint.phases || [];
  if ((!specs || specs.length === 0) && blueprint.plans) {
    specs = buildSpecsFromPlans(blueprint.plans);
  }
  if (specs.length > 0) {
    fs.mkdirSync(specsDataDir, { recursive: true });
    const outPath = path.join(specsDataDir, taskId + '-specs.json');
    fs.writeFileSync(outPath, JSON.stringify(specs, null, 2));
    return outPath;
  }
  throw new Error('No phase specs available (no file on disk and no specs/phases in blueprint)');
}

function writePlansFile(blueprint, taskId) {
  if (!blueprint || !blueprint.plans) return null;
  const specsDataDir = process.env.SPECS_DATA_DIR || path.join(__dirname, '..', 'spec-data');
  const targetDir = path.join(specsDataDir, taskId);
  fs.mkdirSync(targetDir, { recursive: true });
  const outPath = path.join(targetDir, 'plans.json');
  fs.writeFileSync(outPath, JSON.stringify(blueprint.plans, null, 2));
  return outPath;
}

function buildScriptCoverage(report) {
  return (report.specPhases || []).map(phaseId => ({
    step: phaseId,
    covered: (report.coveredPhases || []).includes(phaseId),
    evidence: 'PlayableAgent VLM + __gameState'
  }));
}

function summarizePlayableAgentReport(report, taskId, log) {
  report = report || {};
  var issues = [];
  var logger = typeof log === 'function' ? log : function() {};

  // ═══ Anti-Autoplay Detection ═══
  var isAutoPlayMode = (report.finalState && report.finalState.variables && report.finalState.variables.autoPlayMode === true)
    || (report.observe_mode === true);
  if (!isAutoPlayMode) {
    if (report.autoplay_detected) {
      logger('[PlayableAgent] 🚨 AUTOPLAY DETECTED: ' + (report.autoplay_reason || 'Phases auto-completed without player input'), taskId);
      issues.push('[autoplay-detected] ' + (report.autoplay_reason || 'Game phases auto-completed via timer without any player interaction.'));
    }
    if (report.passed && (!report.actions || report.actions.length === 0)) {
      logger('[PlayableAgent] 🚨 AUTOPLAY: passed=true but 0 actions — overriding to FAIL', taskId);
      report.passed = false;
      issues.push('[autoplay-no-interaction] All phases completed with 0 agent actions.');
    }
  } else {
    logger('[PlayableAgent] observe mode — skipping autoplay_detected/0-actions check (those are expected)', taskId);
  }

  // observe 模式下仍然检查: 游戏变量是否真的变化
  const finalVars = (report.finalState || {}).variables || {};
  const interactionKeys = Object.keys(finalVars).filter(k => k !== 'gameTimer' && k !== 'autoPlayMode' && k !== 'phaseTimer' && k !== 'autoPlaySteps');
  const allVarsZero = interactionKeys.length > 0 && interactionKeys.every(k => finalVars[k] === 0 || finalVars[k] === '0');
  if (report.passed && allVarsZero && interactionKeys.length >= 2) {
    logger('[PlayableAgent] 🚨 all interaction variables are 0 — overriding to FAIL (even in observe mode)', taskId);
    report.passed = false;
    issues.push('[no-variable-change] All interaction variables (gold/score/count/etc) remain at 0 — game logic never ran despite phase completion flags flipping.');
  }

  const missingPhases = report.missingPhases || [];
  const coveredPhases = report.coveredPhases || [];
  const totalPhases = (report.specPhases || []).length;
  if (missingPhases.length > 0) {
    issues.push('[spec-phase-skipped] Phases not completed (' + missingPhases.length + '/' + totalPhases + '): ' + missingPhases.join(', '));
  }

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

  const currentPhase = finalState.currentPhase || '';
  const ctaReached = ['gameEnd', 'cta', 'CTA', 'ctaPhase'].includes(currentPhase);
  if (!ctaReached && totalPhases > 0 && coveredPhases.length < totalPhases) {
    logger('[PlayableAgent] CTA not reached (current phase: ' + currentPhase + ')', taskId);
  }

  if (report.visual_fail_reasons && Array.isArray(report.visual_fail_reasons)) {
    for (const reason of report.visual_fail_reasons) {
      if (reason.toLowerCase().includes('visual frozen') || reason.toLowerCase().includes('static')) {
        issues.push('[visual-freeze] ' + reason + ' Fix: ensure autoPlay phase transitions trigger visible entity movement, animation, or UI changes (SetActive, Translate, SetColor).');
      } else if (reason.toLowerCase().includes('variable') || reason.toLowerCase().includes('stagnation')) {
        issues.push('[variable-stagnation] ' + reason + ' Fix: ensure game logic updates gold/score/count variables during each phase. Phase transitions without side effects are empty shells.');
      } else if (reason.toLowerCase().includes('batch') || reason.toLowerCase().includes('timer')) {
        issues.push('[batch-completion] ' + reason + ' Fix: each phase must run for its full duration with real gameplay, not instant timer-skip.');
      } else if (reason.toLowerCase().includes('screenshot')) {
        issues.push('[screenshot-timing] ' + reason + ' Fix: ensure each phase transition produces a sustained visual change (≥2 s) so the CUA camera can capture a distinct screenshot per phase. Extend the autoPlay phase duration or add a visible animation/UI update (SetActive, Translate, particle effect) that persists for at least 2 s after the transition trigger.');
      } else {
        issues.push('[visual-quality] ' + reason);
      }
    }
  }

  const signalCoverage = report.signalCoverage || null;
  const signalValidationPassed = report.signalValidationPassed !== false;
  const coveredSignals = Array.isArray(report.coveredSignals) ? report.coveredSignals.slice() : [];
  const missingSignals = Array.isArray(report.missingSignals) ? report.missingSignals.slice() : [];
  const unsupportedSignals = Array.isArray(report.unsupportedSignals) ? report.unsupportedSignals.slice() : [];
  const planCoverage = report.planCoverage || null;

  if (!signalValidationPassed || missingSignals.length > 0) {
    report.passed = false;
    if (!report.exitReason) report.exitReason = 'signal_validation_failed';
    issues.push('[signal-coverage] Missing expected signals (' + missingSignals.length + (signalCoverage ? ', coverage=' + signalCoverage : '') + '): ' + missingSignals.slice(0, 8).join(', '));
    if (missingSignals.length > 8) {
      issues.push('[signal-coverage-detail] ' + (missingSignals.length - 8) + ' more signals missing beyond first 8.');
    }
  }
  if (unsupportedSignals.length > 0) {
    logger('[PlayableAgent] Unsupported signal assertions (non-blocking): ' + unsupportedSignals.join(', '), taskId);
  }

  const passed = report.passed === true;

  const silentPassSignals = [];
  const totalActions = (report.actions || []).length;
  // zero-actions is only a silent-pass signal in *interactive* runs.
  // In observe/autoplay mode the agent intentionally never acts — the gameplay
  // is driven by OnAutoPlayArrive / autoplay timers — so 0 actions is the
  // contract, not a regression. Reporting it as silent-pass produced 9
  // baseline alerts that could never be cleared (see silent-passes.json).
  if (totalActions === 0 && passed && !isAutoPlayMode) {
    silentPassSignals.push('zero-actions');
  }
  const phaseTs = (finalState.phaseTimestamps) ? finalState.phaseTimestamps : {};
  const tsValues = Object.values(phaseTs).filter(t => typeof t === 'number' && t > 0).sort((a, b) => a - b);
  // Uniform phase timing (cv<15%) is a silent-pass tell only for *interactive*
  // runs — observe/autoplay deliberately advances each phase via a uniform
  // timer (`phaseTimer >= 12f` gate in skeleton-generator.cjs), so a cv near
  // 0% is the contract, not a regression. hardBlockingSignals already
  // suppressed this in autoplay; mirror that here so silent-passes.json and
  // metric `cuaSilentPass` don't carry the false alarm forward.
  if (tsValues.length > 3 && !isAutoPlayMode) {
    const intervals = [];
    for (let ti = 1; ti < tsValues.length; ti++) intervals.push(tsValues[ti] - tsValues[ti - 1]);
    const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    if (avg > 0) {
      const stddev = Math.sqrt(intervals.reduce((a, v) => a + (v - avg) * (v - avg), 0) / intervals.length);
      const cv = stddev / avg;
      if (cv < 0.15) {
        silentPassSignals.push('uniform-timing:avg=' + avg.toFixed(1) + 's,cv=' + (cv * 100).toFixed(0) + '%');
      }
    }
  }
  const completedList = report.completedPhases || [];
  if (completedList.length > 1) {
    const gameEndIdx = completedList.indexOf('gameEnd');
    if (gameEndIdx >= 0 && gameEndIdx < completedList.length - 1) {
      silentPassSignals.push('phase-order-violation:gameEnd-not-last');
    }
  }
  // 2026-04-27 silent-pass strict observe-mode: validate each completed phase
  // had >0 OnAutoPlayArrive steps. Skeleton's phase gate already requires
  // _autoPlaySteps > _autoPlayStepsAtPhaseStart in realCondition (skeleton-generator.cjs:236),
  // so any phase reaching `completedPhases` SHOULD have >0 steps. If it doesn't,
  // a future skeleton change or LLM-injected bypass let the gate slip.
  // This is hardBlocking in observe mode only — interactive runs do not advance via OnAutoPlayArrive.
  if (isAutoPlayMode && passed) {
    const phaseSteps = report.phaseStepsSnapshot || {};
    const zeroStepPhases = Object.keys(phaseSteps).filter(function(p) {
      return p !== 'gameEnd' && Number(phaseSteps[p]) === 0;
    });
    if (zeroStepPhases.length > 0) {
      silentPassSignals.push('autoplay-zero-steps:' + zeroStepPhases.slice(0, 4).join(',') +
        (zeroStepPhases.length > 4 ? '+' + (zeroStepPhases.length - 4) + ' more' : ''));
    }
  }
  if (allVarsZero && interactionKeys.length >= 2) {
    silentPassSignals.push('all-vars-zero:' + interactionKeys.length + '-keys');
  }
  var _l8 = silentPassDetectors.detectBatchCompletion(tsValues);
  if (_l8) silentPassSignals.push(_l8);
  var _l9 = silentPassDetectors.detectNoPhaseTimestamps(passed, (report.specPhases || []).length, tsValues.length);
  if (_l9) silentPassSignals.push(_l9);
  if (silentPassSignals.length > 0) {
    logger('[PlayableAgent] ⚠️ Silent-pass signals detected: ' + silentPassSignals.join(', '), taskId);
  }

  var hardBlockingSignals = silentPassSignals.filter(function(s) {
    if (s.indexOf('uniform-timing') === 0 && isAutoPlayMode) return false;
    return s.indexOf('uniform-timing') === 0
        || s.indexOf('phase-order-violation') === 0
        || s.indexOf('all-vars-zero') === 0
        || s.indexOf('batch-completion') === 0
        || s.indexOf('no-phase-timestamps') === 0
        || s.indexOf('autoplay-zero-steps') === 0;
  });
  var effectivePassed = passed;
  if (passed && hardBlockingSignals.length > 0) {
    logger('[PlayableAgent] 🚨 HARD BLOCK: silent-pass signals override passed=true → FAIL: ' + hardBlockingSignals.join(', '), taskId);
    effectivePassed = false;
    if (!report.exitReason) report.exitReason = 'silent_pass_blocked';
    hardBlockingSignals.forEach(function(sig) {
      issues.push('[silent-pass-block] ' + sig + ' — game logic did not run correctly despite phase flags flipping. See feedback_cua_silent_pass_blindspot.md');
    });
  }

  logger('[PlayableAgent] Result: ' + (effectivePassed ? 'PASS' : 'FAIL') +
      ' | Coverage: ' + coveredPhases.length + '/' + totalPhases +
      (signalCoverage ? ' | Signals: ' + signalCoverage : '') +
      ' | Issues: ' + issues.length, taskId);

  return {
    passed: effectivePassed,
    issues,
    skipped: false,
    totalActions: totalActions,
    silentPassSignals: silentPassSignals,
    hardBlockingSilentSignals: hardBlockingSignals.slice(),
    isAutoPlayMode: isAutoPlayMode,
    signalCoverage: signalCoverage,
    signalValidationPassed: signalValidationPassed,
    coveredSignals: coveredSignals,
    missingSignals: missingSignals,
    unsupportedSignals: unsupportedSignals,
    planCoverage: planCoverage,
    visualFailReasons: Array.isArray(report.visual_fail_reasons) ? report.visual_fail_reasons.slice() : [],
    visualSmoke: report.visual_smoke || null,
    exitReason: report.exitReason || (effectivePassed ? 'completed' : 'verification_failed'),
    report: {
      gameState: finalState,
      completedPhases: report.completedPhases || [],
      scriptCoverage: buildScriptCoverage(report),
      diagnostics: {
        engineReady: true,
        consoleErrors: [],
        pageErrors: []
      },
      exitReason: report.exitReason || (effectivePassed ? 'completed' : 'verification_failed'),
      ctaStatus: ctaReached ? 'found' : 'not_checked',
      history: (report.actions || []).map(a => ({
        thinking: a.thought || '',
        description: JSON.stringify(a.action || {})
      })),
      playableAgent: true,
      model: report.model || 'Qwen/Qwen2.5-VL-72B-Instruct',
      tokens: report.tokens || {},
      cost: report.cost || 0,
      preContamination: report.pre_contamination || null,
      observedPhaseOffset: typeof report.observed_phase_offset === 'number'
        ? report.observed_phase_offset
        : 0,
      planCoverage: planCoverage,
      signalCoverage: signalCoverage,
      signalValidationPassed: signalValidationPassed,
      coveredSignals: coveredSignals,
      missingSignals: missingSignals,
      unsupportedSignals: unsupportedSignals,
      signalAssertions: Array.isArray(report.signalAssertions) ? report.signalAssertions : [],
      visualFailReasons: Array.isArray(report.visual_fail_reasons) ? report.visual_fail_reasons.slice() : [],
      visualSmoke: report.visual_smoke || null,
      hardBlockingSilentSignals: hardBlockingSignals.slice(),
    }
  };
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

  // Determine complexity level for CUA speed adaptation
  const phaseCount = (
    (blueprint.plans && blueprint.plans.cuaPlan && Array.isArray(blueprint.plans.cuaPlan.steps) && blueprint.plans.cuaPlan.steps.length > 0)
      ? blueprint.plans.cuaPlan.steps.length
      : (blueprint.specs || blueprint.phases || []).length
  );
  const isHighComplexity = phaseCount > 8;
  const speedMultiplier = isHighComplexity ? 2 : 5;
  _patchHighComplexity = isHighComplexity;

  // G1: dynamic outer kill-switch by phase count
  const verifyTimeoutMs = computeVerifyTimeoutMs(phaseCount);

  if (isHighComplexity) {
    log('[PlayableAgent] High complexity detected (' + phaseCount + ' phases) — using ' + speedMultiplier + 'x speed, conservative timer gates', taskId);
  }
  log('[PlayableAgent] Starting PlayableAgent verification (VLM + __gameState, kill-switch ' + Math.round(verifyTimeoutMs/1000) + 's)...', taskId);

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
  const plansPath = writePlansFile(blueprint, taskId);
  if (plansPath) {
    log('[PlayableAgent] Assembly/CUA plans saved: ' + plansPath, taskId);
  }

  // Build Python command — observer mode (no VLM interaction, just watch autoPlay)
  const args = [VERIFY_SCRIPT, previewUrl, '--steps', '50', '--observe'];
  if (specsPath) args.push('--specs', specsPath);
  if (plansPath) args.push('--plans', plansPath);

  const outputDir = path.join(CUA_RESULTS_DIR, taskId + '-playableagent');
  const logPath = path.join(CUA_RESULTS_DIR, taskId + '-playableagent.log');

  return new Promise((resolve) => {
    const env = {
      ...process.env,
      DISPLAY: ':99',
      DOUBAO_API_KEY: process.env.DOUBAO_API_KEY || '197cb950-3cf3-4b30-b656-6afaa4306a7a',
      CUA_SPEED_MULTIPLIER: String(speedMultiplier),
    };

    log('[PlayableAgent] Running: ' + PYTHON + ' ' + args.join(' '), taskId);
    if (!process._activeChildPIDs) process._activeChildPIDs = new Set();
    const child = spawn(PYTHON, args, {
      cwd: '/root/cua-agent',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: verifyTimeoutMs
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
      log('[PlayableAgent] Timeout after ' + Math.round(verifyTimeoutMs/1000) + 's (dynamic kill-switch), killing', taskId);
      try { child.kill('SIGTERM'); } catch(e) {}
    }, verifyTimeoutMs);

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

      resolve(summarizePlayableAgentReport(report, taskId, log));
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

module.exports = {
  runCUAVerification,
  CUA_RESULTS_DIR,
  computeVerifyTimeoutMs,
  writeSpecsFile,
  summarizePlayableAgentReport,
};
