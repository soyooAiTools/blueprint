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

const { spawn, execSync, execFile } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const silentPassDetectors = require('../adapters/silent-pass-detectors.cjs');
const { buildSpecsFromPlans } = require('../adapters/cua-plan-bridge.cjs');

const CUA_RESULTS_DIR = path.join(__dirname, 'cua-results');
let LOCAL_PREVIEW_PORT = 0; // Dynamic port to avoid multi-worker conflicts
const PYTHON = '/usr/bin/python3.8';
const VERIFY_SCRIPT = '/root/cua-agent/blueprint_verify.py';

function safeRunId(value) {
  return String(value || 'task').replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'task';
}

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

function computeManualJoystickFlowBudget(phaseCount, env) {
  var n = Math.max(0, parseInt(phaseCount, 10) || 0);
  var source = env || process.env || {};
  var defaultWindowMs = Math.max(240000, Math.min(n * 90000 + 150000, 1200000));
  var defaultMaxDrags = Math.min(Math.max(n * 18, 36), 220);
  var windowMs = Number(source.BLUEPRINT_MANUAL_JOYSTICK_FLOW_WINDOW_MS || defaultWindowMs);
  var maxDrags = Number(source.BLUEPRINT_MANUAL_JOYSTICK_FLOW_MAX_DRAGS || defaultMaxDrags);
  return {
    windowMs: Math.max(60000, Number.isFinite(windowMs) ? windowMs : defaultWindowMs),
    maxDrags: Math.max(12, Number.isFinite(maxDrags) ? Math.floor(maxDrags) : defaultMaxDrags),
    defaultWindowMs,
    defaultMaxDrags,
  };
}

function readBuildTelemetryMs(buildDir) {
  try {
    const buildResult = readJsonIfExists(path.join(buildDir, 'build-result.json'));
    if (!buildResult || typeof buildResult !== 'object') return null;
    const buildMs = Number(buildResult.buildMs);
    if (Number.isFinite(buildMs) && buildMs >= 0) return Math.round(buildMs);
    const buildTime = Number(buildResult.buildTime);
    if (Number.isFinite(buildTime) && buildTime >= 0) return Math.round(buildTime * 1000);
  } catch(e) {}
  return null;
}

function createCuaTelemetry(meta) {
  meta = meta || {};
  const startedAtMs = Date.now();
  return {
    schemaVersion: 'blueprint-cua-telemetry.v1',
    taskId: meta.taskId || null,
    buildDir: meta.buildDir || null,
    runner: meta.runner || 'playableagent',
    startedAt: new Date(startedAtMs).toISOString(),
    _startedAtMs: startedAtMs,
    phaseCount: null,
    speedMultiplier: null,
    verifyTimeoutMs: null,
    buildMs: typeof meta.buildMs === 'number' ? meta.buildMs : null,
    proofMs: null,
    serverMs: null,
    observeMs: null,
    manualProbeMs: null,
    checkpointProbeMs: null,
    manualFlowMs: null,
    storyboardVisualAuditMs: null,
    storyboardVideoAuditMs: null,
    totalMs: null,
  };
}

function snapshotCuaTelemetry(telemetry) {
  const finishedAtMs = Date.now();
  const snapshot = {};
  Object.keys(telemetry || {}).forEach(function(key) {
    if (key.charAt(0) === '_') return;
    snapshot[key] = telemetry[key];
  });
  snapshot.finishedAt = new Date(finishedAtMs).toISOString();
  snapshot.totalMs = Math.max(0, finishedAtMs - ((telemetry && telemetry._startedAtMs) || finishedAtMs));
  return snapshot;
}

function attachCuaTelemetry(result, telemetry) {
  const snapshot = snapshotCuaTelemetry(telemetry);
  const target = result && typeof result === 'object' ? result : {};
  target.telemetry = snapshot;
  if (target.report && typeof target.report === 'object') {
    target.report.telemetry = snapshot;
    if (target.report.diagnostics && typeof target.report.diagnostics === 'object') {
      target.report.diagnostics.telemetry = snapshot;
    }
  }
  return target;
}

async function measureCuaTelemetry(telemetry, key, fn) {
  const startedAt = Date.now();
  try {
    return await fn();
  } finally {
    if (telemetry && key) telemetry[key] = Math.max(0, Date.now() - startedAt);
  }
}

function parseCoverageLabel(label) {
  var match = String(label || '').match(/(\d+)\s*\/\s*(\d+)/);
  if (!match) return null;
  return {
    covered: parseInt(match[1], 10) || 0,
    total: parseInt(match[2], 10) || 0,
  };
}

function isFullCoverage(label) {
  var parsed = parseCoverageLabel(label);
  return !!(parsed && parsed.total > 0 && parsed.covered >= parsed.total);
}

function hasHealthyObserveVisuals(report) {
  if (!report || !report.observe_mode) return false;
  if (Array.isArray(report.visual_fail_reasons) && report.visual_fail_reasons.length > 0) return false;

  var visualQuality = report.visual_quality || {};
  if (typeof visualQuality.changed_frames !== 'number' || typeof visualQuality.total_frames !== 'number') return false;
  if (visualQuality.total_frames <= 0 || visualQuality.changed_frames <= 0) return false;
  var freezeEval = visualQuality.freeze_eval || {};
  if (freezeEval.failed === true) return false;
  if (typeof visualQuality.frozen_ratio === 'number' && visualQuality.frozen_ratio > 0.5 && freezeEval.waived !== true) return false;
  if (typeof visualQuality.max_frozen_streak === 'number' && visualQuality.max_frozen_streak > 2 && freezeEval.failed !== false && freezeEval.waived !== true) return false;

  var visualSmoke = report.visual_smoke || {};
  if (typeof visualSmoke.maxBadScreenStreak === 'number' && visualSmoke.maxBadScreenStreak > 1) return false;
  return true;
}

function hasFullSpecPhaseCoverage(report) {
  report = report || {};
  var specPhases = Array.isArray(report.specPhases) ? report.specPhases : [];
  var coveredPhases = Array.isArray(report.coveredPhases) ? report.coveredPhases : [];
  if (specPhases.length === 0) return false;
  var covered = {};
  coveredPhases.forEach(function(id) { covered[String(id)] = true; });
  return specPhases.every(function(id) { return covered[String(id)]; });
}

function coverageReason(label, name) {
  var parsed = parseCoverageLabel(label);
  if (!parsed) return null;
  if (parsed.total <= 0 || parsed.covered >= parsed.total) return null;
  return '[' + name + '-coverage] ' + name + ' coverage incomplete: ' + parsed.covered + '/' + parsed.total;
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
        if (orig > 30 && orig < 60) { fixes++; return 'this.phaseTimer >= 20.0'; }
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
        // Do not patch the generated stuck-phase sentinel (`phaseTimer >= 90.0`).
        // If that guard is shortened it sets phaseTimer=60 and can make dwell
        // gates pass in one observe poll, producing screenshot-sharing failures.
        if (orig >= 5 && orig < 60) { fixes++; return 'this.phaseTimer >= 2.0'; }
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

function blueprintNeedsManualJoystickProbe(blueprint, report) {
  const chunks = [];
  const proofPhases = blueprint && blueprint.proofBundle && Array.isArray(blueprint.proofBundle.phases)
    ? blueprint.proofBundle.phases
    : [];
  const specs = blueprint && (blueprint.specs || blueprint.phases) || [];
  const planSteps = blueprint && blueprint.plans && blueprint.plans.cuaPlan && blueprint.plans.cuaPlan.steps || [];
  if (proofPhases.length > 1) return true;
  if (Array.isArray(planSteps) && planSteps.length > 1) return true;
  if (Array.isArray(specs) && specs.length > 1) return true;
  try { chunks.push(JSON.stringify(blueprint || {})); } catch(e) {}
  try {
    chunks.push(JSON.stringify({
      coveredSignals: report && report.coveredSignals,
      missingSignals: report && report.missingSignals,
      signalAssertions: report && report.signalAssertions,
      specs: report && report.specPhases,
    }));
  } catch(e) {}
  const haystack = chunks.join('\n');
  return /player_input_joystick|joystick_move|joystick|move_to|player_position_changed/i.test(haystack);
}

function normalizePhaseKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function extractBlueprintPhaseIds(blueprint) {
  const proofPath = blueprint && blueprint.proofBundle && Array.isArray(blueprint.proofBundle.expectedPhasePath)
    ? blueprint.proofBundle.expectedPhasePath
    : [];
  if (proofPath.length > 0) return proofPath.map(String).filter(Boolean);
  const proofPhases = blueprint && blueprint.proofBundle && Array.isArray(blueprint.proofBundle.phases)
    ? blueprint.proofBundle.phases
    : [];
  if (proofPhases.length > 0) {
    return proofPhases.map((phase, idx) => String(phase && phase.phaseId || ('phase' + (idx + 1)))).filter(Boolean);
  }
  const specs = blueprint && (blueprint.specs || blueprint.phases) || [];
  if (!Array.isArray(specs)) return [];
  return specs.map((spec, idx) => String(spec && (spec.phaseId || spec.id || spec.name) || ('phase' + (idx + 1)))).filter(Boolean);
}

function phaseEntityName(entry) {
  if (!entry) return '';
  if (typeof entry === 'string') return entry.trim();
  if (typeof entry === 'object') return String(entry.name || entry.entity || entry.id || entry.target || '').trim();
  return '';
}

function phaseEntityNames(spec) {
  const names = [];
  const seen = {};
  ['entitiesRequired', 'showEntities', 'activate', 'targetEntities'].forEach(field => {
    const values = spec && Array.isArray(spec[field]) ? spec[field] : [];
    values.forEach(entry => {
      const name = phaseEntityName(entry);
      const key = normalizePhaseKey(name);
      if (name && !seen[key]) {
        seen[key] = true;
        names.push(name);
      }
    });
  });
  return names;
}

function isPhaseFallbackTargetName(name) {
  const text = String(name || '');
  if (!text) return false;
  if (/^(player|hero|protagonist)$/i.test(text)) return false;
  if (/guide|text|label|canvas|hud|score|ui/i.test(text)) return false;
  return true;
}

function choosePhaseVisibleTarget(spec, plannedTarget) {
  const names = phaseEntityNames(spec).filter(isPhaseFallbackTargetName);
  if (!names.length) return '';
  const plannedKey = normalizePhaseKey(plannedTarget);
  if (plannedKey) {
    const exact = names.find(name => normalizePhaseKey(name) === plannedKey);
    if (exact) return exact;
  }
  const targetKey = normalizePhaseKey(plannedTarget);
  function score(name, idx) {
    const key = normalizePhaseKey(name);
    let value = 100 - idx;
    if (targetKey && (key.indexOf(targetKey) >= 0 || targetKey.indexOf(key) >= 0)) value += 1000;
    if (/enemy|alien|monster|boss/.test(key) && /count|kill|enemy|alien|monster|boss/.test(targetKey)) value += 600;
    if (!/spawner|spawn|generator|field|machine|unlock|button/.test(key)) value += 120;
    return value;
  }
  return names.slice().sort((a, b) => score(b, names.indexOf(b)) - score(a, names.indexOf(a)))[0] || '';
}

function targetExistsInPhaseSpec(spec, target) {
  const key = normalizePhaseKey(target);
  if (!key) return false;
  return phaseEntityNames(spec).some(name => normalizePhaseKey(name) === key);
}

function extractBlueprintPhaseTargetMap(blueprint) {
  const out = {};
  const proofPhases = blueprint && blueprint.proofBundle && Array.isArray(blueprint.proofBundle.phases)
    ? blueprint.proofBundle.phases
    : [];
  proofPhases.forEach((phase, idx) => {
    const phaseId = String(phase && phase.phaseId || ('phase' + (idx + 1))).trim();
    const target = String(phase && phase.target || '').trim();
    if (phaseId && target) out[normalizePhaseKey(phaseId)] = target;
  });
  if (Object.keys(out).length > 0) return out;
  const plans = [];
  if (blueprint && blueprint.plans && blueprint.plans.cuaPlan && Array.isArray(blueprint.plans.cuaPlan.steps)) {
    plans.push(blueprint.plans.cuaPlan.steps);
  }
  if (blueprint && blueprint.cuaPlan && Array.isArray(blueprint.cuaPlan.steps)) {
    plans.push(blueprint.cuaPlan.steps);
  }
  if (blueprint && blueprint.plan && Array.isArray(blueprint.plan.steps)) {
    plans.push(blueprint.plan.steps);
  }
  const phaseIds = extractBlueprintPhaseIds(blueprint);
  const specs = blueprint && (blueprint.specs || blueprint.phases) || [];
  const specsByPhase = {};
  if (Array.isArray(specs)) {
    specs.forEach((spec, idx) => {
      const phaseId = String(spec && (spec.phaseId || spec.id || spec.name) || phaseIds[idx] || '').trim();
      if (phaseId) specsByPhase[normalizePhaseKey(phaseId)] = spec;
    });
  }
  const targetFields = ['target', 'to', 'item', 'entity', 'object', 'button'];
  const actionPriority = {
    move_to: 1,
    joystick_move: 1,
    go_to: 1,
    approach: 1,
    approach_collect: 1,
    collect: 2,
    deliver: 2,
    build: 2,
    upgrade: 2,
    attack: 2,
    tap: 3,
    click: 3,
  };
  function cleanTarget(value) {
    const text = String(value || '').trim();
    if (!text || /^player$/i.test(text)) return '';
    return text;
  }
  function actionTarget(action) {
    if (!action || typeof action !== 'object') return '';
    for (const field of targetFields) {
      const target = cleanTarget(action[field]);
      if (target) return target;
    }
    return '';
  }
  function orderedActions(step) {
    const actions = Array.isArray(step && step.actions) ? step.actions.slice() : [];
    if (step && typeof step === 'object') actions.push(step);
    return actions.sort((a, b) => {
      const ak = String(a && a.kind || '').toLowerCase();
      const bk = String(b && b.kind || '').toLowerCase();
      return (actionPriority[ak] || 10) - (actionPriority[bk] || 10);
    });
  }
  for (const steps of plans) {
    steps.forEach((step, idx) => {
      if (!step || typeof step !== 'object') return;
      const phaseId = String(step.phaseId || step.phase || step.phaseName || phaseIds[idx] || '').trim();
      const phaseKey = normalizePhaseKey(phaseId);
      if (!phaseKey || out[phaseKey]) return;
      const actions = orderedActions(step);
      for (const action of actions) {
        const target = actionTarget(action);
        if (target) {
          const spec = specsByPhase[phaseKey] || null;
          const visibleTarget = spec && !targetExistsInPhaseSpec(spec, target)
            ? choosePhaseVisibleTarget(spec, target)
            : '';
          out[phaseKey] = visibleTarget || target;
          return;
        }
      }
    });
  }
  return out;
}

function selectManualJoystickPhaseWindow(blueprint, options) {
  options = options || {};
  const allPhaseIds = extractBlueprintPhaseIds(blueprint);
  const allPhaseTargets = extractBlueprintPhaseTargetMap(blueprint);
  const rawStart = String(options.checkpointPhase || options.startPhase || '').trim();
  let startIndex = 0;
  let checkpointError = '';
  if (rawStart) {
    if (!allPhaseIds.length) {
      checkpointError = 'no phase path available';
    } else {
      const startKey = normalizePhaseKey(rawStart);
      let found = allPhaseIds.findIndex(id => normalizePhaseKey(id) === startKey);
      if (found < 0 && /^\d+$/.test(rawStart)) {
        const numeric = Number(rawStart);
        if (Number.isFinite(numeric) && numeric >= 1 && numeric <= allPhaseIds.length) found = Math.floor(numeric) - 1;
      }
      if (found < 0) {
        checkpointError = 'unknown checkpoint phase: ' + rawStart;
      } else {
        startIndex = found;
      }
    }
  }
  const maxPhasesRaw = Number(options.maxPhases || 0);
  const maxPhases = Number.isFinite(maxPhasesRaw) && maxPhasesRaw > 0 ? Math.floor(maxPhasesRaw) : 0;
  const endIndex = maxPhases > 0 ? Math.min(allPhaseIds.length, startIndex + maxPhases) : allPhaseIds.length;
  const phaseIds = checkpointError ? [] : allPhaseIds.slice(startIndex, endIndex);
  const phaseTargets = {};
  phaseIds.forEach(id => {
    const key = normalizePhaseKey(id);
    if (allPhaseTargets[key]) phaseTargets[key] = allPhaseTargets[key];
  });
  return {
    checkpointMode: !!rawStart,
    checkpointPhaseInput: rawStart,
    checkpointPhase: rawStart && phaseIds.length ? phaseIds[0] : '',
    checkpointPhaseIndex: rawStart && phaseIds.length ? startIndex + 1 : 0,
    checkpointError,
    maxPhases,
    fullPhaseIds: allPhaseIds,
    fullPhaseTargets: allPhaseTargets,
    phaseIds,
    phaseTargets,
  };
}

function readProbePosition(sample) {
  if (!sample) return null;
  const pos = sample.runtimePlayer || sample.playerPos || (sample.playerState && sample.playerState.position) || null;
  if (!pos) return null;
  const x = Number(pos.x);
  const y = Number(pos.y);
  const z = Number(pos.z);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return { x, y, z };
}

function distance3(a, b) {
  if (!a || !b) return 0;
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function isManualJoystickFlowAction(action) {
  if (!action || typeof action !== 'object') return false;
  return action.type === 'drag' || action.type === 'autonav_joystick';
}

function evaluateManualJoystickFlowProbeResult(probe) {
  probe = probe || {};
  const samples = Array.isArray(probe.samples) ? probe.samples : [];
  const rawPhaseIds = Array.isArray(probe.phaseIds) && probe.phaseIds.length
    ? probe.phaseIds
    : Array.from({ length: Math.max(0, Number(probe.targetCompleted || 0) || 0) }, (_, i) => 'phase' + (i + 1));
  const norm = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const expectedPhaseIds = rawPhaseIds.map(id => String(id || '')).filter(Boolean);
  const first = samples.find(sample => sample && Number.isFinite(Number(sample.completedCount))) || samples[0] || null;
  let completedAfter = first && Number.isFinite(Number(first.completedCount)) ? Number(first.completedCount) : 0;
  const targetCompleted = Number(probe.targetCompleted || 0);
  let terminalReached = false;
  let maxDistance = 0;
  const firstPos = readProbePosition(first);
  const samplePhasePath = [];
  const samplePhaseSeen = new Set();
  function pushPhasePath(path, seen, phase) {
    const text = String(phase || '');
    if (!text || seen.has(norm(text))) return;
    seen.add(norm(text));
    path.push(text);
  }
  for (const sample of samples) {
    if (!sample) continue;
    if (Number.isFinite(Number(sample.completedCount))) completedAfter = Math.max(completedAfter, Number(sample.completedCount));
    if (sample.isTerminal === true) terminalReached = true;
    pushPhasePath(samplePhasePath, samplePhaseSeen, sample.currentPhase);
    const pos = readProbePosition(sample);
    if (firstPos && pos) maxDistance = Math.max(maxDistance, distance3(firstPos, pos));
  }
  function witnessPhasesFrom(value) {
    const out = [];
    const seen = new Set();
    function add(phase) { pushPhasePath(out, seen, phase); }
    if (!value || typeof value !== 'object') return out;
    if (Array.isArray(value.path)) value.path.forEach(add);
    if (Array.isArray(value.events)) {
      value.events.forEach(function(event) { add(event && event.phase); });
    }
    return out;
  }
  const witnessPath = [];
  const witnessSeen = new Set();
  witnessPhasesFrom(probe.phaseWitness).forEach(function(phase) {
    pushPhasePath(witnessPath, witnessSeen, phase);
  });
  samples.forEach(function(sample) {
    witnessPhasesFrom(sample && sample.phaseWitness).forEach(function(phase) {
      pushPhasePath(witnessPath, witnessSeen, phase);
    });
  });
  function completedWitnessPhasesFrom(value) {
    const out = [];
    const seen = new Set();
    if (!value || typeof value !== 'object') return out;
    if (Array.isArray(value.completedPath)) {
      value.completedPath.forEach(function(phase) { pushPhasePath(out, seen, phase); });
    }
    if (Array.isArray(value.completedEvents)) {
      value.completedEvents.forEach(function(event) { pushPhasePath(out, seen, event && event.phase); });
    }
    return out;
  }
  const completedWitnessPath = [];
  const completedWitnessSeen = new Set();
  completedWitnessPhasesFrom(probe.phaseWitness).forEach(function(phase) {
    pushPhasePath(completedWitnessPath, completedWitnessSeen, phase);
  });
  samples.forEach(function(sample) {
    completedWitnessPhasesFrom(sample && sample.phaseWitness).forEach(function(phase) {
      pushPhasePath(completedWitnessPath, completedWitnessSeen, phase);
    });
  });
  function orderedCoverage(path) {
    let total = 0;
    let searchFrom = 0;
    for (const id of expectedPhaseIds) {
      const key = norm(id);
      let foundAt = -1;
      for (let i = searchFrom; i < path.length; i++) {
        if (norm(path[i]) === key) {
          foundAt = i;
          break;
        }
      }
      if (foundAt < 0) break;
      total++;
      searchFrom = foundAt + 1;
    }
    return total;
  }
  let phasePath = samplePhasePath.slice();
  let phasePathSource = 'samples';
  if (witnessPath.length > 0 && orderedCoverage(witnessPath) > orderedCoverage(samplePhasePath)) {
    phasePath = witnessPath.slice();
    phasePathSource = 'phase-witness';
    const seen = new Set(phasePath.map(norm));
    samplePhasePath.forEach(function(phase) {
      if (/gameend|cta|finish|complete|download|install/i.test(String(phase || ''))) {
        pushPhasePath(phasePath, seen, phase);
      }
    });
  }
  if (completedWitnessPath.length > 0 &&
      targetCompleted > 0 &&
      completedAfter >= targetCompleted &&
      orderedCoverage(completedWitnessPath) > orderedCoverage(phasePath)) {
    phasePath = completedWitnessPath.slice();
    phasePathSource = 'phase-completion-witness';
    const seen = new Set(phasePath.map(norm));
    samplePhasePath.forEach(function(phase) {
      if (/gameend|cta|finish|complete|download|install/i.test(String(phase || ''))) {
        pushPhasePath(phasePath, seen, phase);
      }
    });
  }
  const observedByKey = {};
  phasePath.forEach(phase => { observedByKey[norm(phase)] = phase; });
  const missingPhasePath = expectedPhaseIds.filter(id => !observedByKey[norm(id)]);
  let phasePathOrderOk = true;
  let searchFrom = 0;
  for (const id of expectedPhaseIds) {
    const key = norm(id);
    let foundAt = -1;
    for (let i = searchFrom; i < phasePath.length; i++) {
      if (norm(phasePath[i]) === key) {
        foundAt = i;
        break;
      }
    }
    if (foundAt < 0) {
      phasePathOrderOk = false;
      break;
    }
    searchFrom = foundAt + 1;
  }
  const phasePathComplete = expectedPhaseIds.length > 0 && missingPhasePath.length === 0 && phasePathOrderOk;
  const completedBefore = first && Number.isFinite(Number(first.completedCount)) ? Number(first.completedCount) : 0;
  const joystickActionCount = Array.isArray(probe.actions)
    ? probe.actions.filter(isManualJoystickFlowAction).length
    : 0;
  const dragCount = Number(probe.dragCount || joystickActionCount);
  const deadlineReached = probe.deadlineReached === true;
  const dragBudgetReached = probe.dragBudgetReached === true;
  const iterationBudgetReached = probe.iterationBudgetReached === true;
  const playerMoved = maxDistance > 0.05;
  const fullFlowCompleted = targetCompleted > 0 && completedAfter >= targetCompleted;
  const passed = dragCount > 0 && playerMoved && (fullFlowCompleted || terminalReached) && phasePathComplete;
  let reason = 'manual joystick flow probe passed';
  if (targetCompleted <= 0) reason = 'no target phase count for manual joystick flow probe';
  else if (dragCount <= 0) reason = 'manual joystick flow probe did not perform joystick drags';
  else if (!playerMoved) reason = 'manual joystick flow probe did not move the player';
  else if (!fullFlowCompleted && !terminalReached && deadlineReached) reason = 'manual joystick flow timed out: completed ' + completedAfter + '/' + targetCompleted;
  else if (!fullFlowCompleted && !terminalReached && dragBudgetReached) reason = 'manual joystick flow exhausted drag budget: completed ' + completedAfter + '/' + targetCompleted;
  else if (!fullFlowCompleted && !terminalReached && iterationBudgetReached) reason = 'manual joystick flow exhausted iteration budget: completed ' + completedAfter + '/' + targetCompleted;
  else if (!fullFlowCompleted && !terminalReached) reason = 'manual joystick flow incomplete: completed ' + completedAfter + '/' + targetCompleted;
  else if (!phasePathComplete && missingPhasePath.length > 0) reason = 'manual joystick flow skipped observable phase path: missing ' + missingPhasePath.join(', ');
  else if (!phasePathComplete) reason = 'manual joystick flow observed phase path out of order';
  return {
    passed,
    reason,
    completedBefore,
    completedAfter,
    targetCompleted,
    terminalReached,
    phasePath,
    phasePathSource,
    expectedPhasePath: expectedPhaseIds,
    missingPhasePath,
    phasePathOrderOk,
    dragCount,
    deadlineReached,
    dragBudgetReached,
    iterationBudgetReached,
    maxPlayerDistance: Number(maxDistance.toFixed(4)),
  };
}

function evaluateManualJoystickProbeResult(probe) {
  probe = probe || {};
  const samples = Array.isArray(probe.samples) ? probe.samples : [];
  const before = readProbePosition(samples[0]);
  let maxDistance = 0;
  let maxInput = 0;
  function joystickMagnitude(sample) {
    let value = 0;
    const joy = sample && sample.joy;
    if (joy) {
      const h = Number(joy.h);
      const v = Number(joy.v);
      if (Number.isFinite(h) && Number.isFinite(v)) {
        value = Math.max(value, Math.sqrt(h * h + v * v));
      }
      if (joy.input) {
        const ix = Number(joy.input.x);
        const iy = Number(joy.input.y);
        if (Number.isFinite(ix) && Number.isFinite(iy)) {
          value = Math.max(value, Math.sqrt(ix * ix + iy * iy));
        }
      }
    }
    const override = sample && sample.manualJoystickOverride;
    if (override && override.active) {
      const ox = Number(override.x);
      const oy = Number(override.y);
      if (Number.isFinite(ox) && Number.isFinite(oy)) {
        value = Math.max(value, Math.sqrt(ox * ox + oy * oy));
      }
    }
    const stick = sample && sample.domStick;
    if (stick && /\bactive\b/.test(String(stick.className || ''))) {
      const match = String(stick.knobTransform || '').match(/translate\(\s*(-?\d+(?:\.\d+)?)px\s*,\s*(-?\d+(?:\.\d+)?)px\s*\)/);
      if (match) {
        const dx = Number(match[1]);
        const dy = Number(match[2]);
        if (Number.isFinite(dx) && Number.isFinite(dy)) {
          value = Math.max(value, Math.min(1, Math.sqrt(dx * dx + dy * dy) / 44));
        }
      }
    }
    return value;
  }
  for (const sample of samples) {
    const pos = readProbePosition(sample);
    if (before && pos) maxDistance = Math.max(maxDistance, distance3(before, pos));
    maxInput = Math.max(maxInput, joystickMagnitude(sample));
  }
  const joystickResponded = maxInput > 0.1;
  const playerMoved = maxDistance > 0.05;
  const touchBeforeSample = samples.find((sample) => sample && sample.label === 'before-touch');
  const touchDuringSample = samples.find((sample) => sample && sample.label === 'during-touch-hold');
  let touchOnlyDistance = null;
  let touchOnlyInput = null;
  let touchOnlyPassed = true;
  if (touchBeforeSample && touchDuringSample) {
    const touchBefore = readProbePosition(touchBeforeSample);
    const touchDuring = readProbePosition(touchDuringSample);
    touchOnlyDistance = Number(distance3(touchBefore, touchDuring).toFixed(4));
    touchOnlyInput = Number(joystickMagnitude(touchDuringSample).toFixed(4));
    touchOnlyPassed = touchOnlyInput > 0.1 && touchOnlyDistance > 0.05;
  }
  const passed = joystickResponded && playerMoved && touchOnlyPassed;
  let reason = 'manual joystick probe passed';
  if (!before) reason = 'player position unavailable during manual joystick probe';
  else if (!joystickResponded) reason = 'joystick input did not respond to synthetic drag';
  else if (!playerMoved) reason = 'joystick input responded, but player position did not change';
  else if (!touchOnlyPassed) reason = 'touch-only joystick input did not move the player';
  return {
    passed,
    reason,
    maxInput: Number(maxInput.toFixed(4)),
    maxPlayerDistance: Number(maxDistance.toFixed(4)),
    touchOnlyInput,
    touchOnlyDistance,
  };
}

function evaluateStoryboardVisualAuditResult(audit) {
  audit = audit || {};
  const issues = [];
  const labelCenterTolerancePx = Number(audit.labelCenterTolerancePx || 8);
  const labelGapTargetPx = Number(audit.labelGapTargetPx || 8);
  const labelGapTolerancePx = Number(audit.labelGapTolerancePx || 8);
  const maxMotionStepPx = Number(audit.maxMotionStepPx || 6);
  const minDirectionalTravelPx = Number(audit.minDirectionalTravelPx || 8);
  const maxClickDisplacementPx = Number(audit.maxClickDisplacementPx || 1.5);
  const maxGuidanceLinePlayerDelta = Number(audit.maxGuidanceLinePlayerDeltaWorld || 0.08);
  const maxNonOverlayVisibleSurfaceCount = Number(audit.maxNonOverlayVisibleSurfaceCount || 0);
  function isHudOnlyEntity(name) {
    return /^(GoldUI|GuideUI)$/i.test(String(name || ''));
  }
  function uniqueNames(values) {
    const out = [];
    const seen = {};
    for (const value of values || []) {
      const name = String(value || '').trim();
      if (!name || seen[name]) continue;
      seen[name] = true;
      out.push(name);
    }
    return out;
  }

  const phaseAudits = Array.isArray(audit.phaseAudits) ? audit.phaseAudits : [];
  for (const phaseAudit of phaseAudits) {
    const phase = phaseAudit && phaseAudit.phase || 'current';
    const labels = Array.isArray(phaseAudit && phaseAudit.labels) ? phaseAudit.labels : [];
    for (const row of labels) {
      if (!row || !row.visible) continue;
      if (!row.entityRect) {
        issues.push('[storyboard-label] ' + phase + '/' + (row.entity || '?') + ' visible label has no matching entity rect');
        continue;
      }
      const centerDx = Number(row.centerDx);
      const topGap = Number(row.topGap);
      if (!Number.isFinite(centerDx) || Math.abs(centerDx) > labelCenterTolerancePx) {
        issues.push('[storyboard-label] ' + phase + '/' + (row.entity || '?') + ' center drift ' + centerDx + 'px');
      }
      if (!Number.isFinite(topGap) || Math.abs(topGap - labelGapTargetPx) > labelGapTolerancePx) {
        issues.push('[storyboard-label] ' + phase + '/' + (row.entity || '?') + ' top gap ' + topGap + 'px');
      }
    }
    const expected = uniqueNames(phaseAudit && phaseAudit.expectedVisibleEntities).filter((name) => !isHudOnlyEntity(name));
    const actual = uniqueNames(phaseAudit && phaseAudit.actualVisibleEntities).filter((name) => !isHudOnlyEntity(name));
    if (expected.length || actual.length) {
      const expectedSet = new Set(expected);
      const actualSet = new Set(actual);
      const missing = expected.filter((name) => !actualSet.has(name));
      const extra = actual.filter((name) => !expectedSet.has(name));
      if (missing.length) {
        issues.push('[storyboard-entity-visibility] ' + phase + ' missing visible entities: ' + missing.slice(0, 5).join(','));
      }
      if (extra.length) {
        issues.push('[storyboard-entity-visibility] ' + phase + ' unexpected visible entities: ' + extra.slice(0, 5).join(','));
      }
    }
  }

  const layerAudits = Array.isArray(audit.visualLayerAudits) ? audit.visualLayerAudits : [];
  for (const layerAudit of layerAudits) {
    const phase = layerAudit && layerAudit.phase || 'current';
    const surfaces = Array.isArray(layerAudit && layerAudit.visibleNonOverlaySurfaces)
      ? layerAudit.visibleNonOverlaySurfaces
      : [];
    const count = Number.isFinite(Number(layerAudit && layerAudit.visibleNonOverlaySurfaceCount))
      ? Number(layerAudit.visibleNonOverlaySurfaceCount)
      : surfaces.length;
    if (count > maxNonOverlayVisibleSurfaceCount) {
      const names = surfaces.map((row) => row && row.name).filter(Boolean).slice(0, 5).join(',');
      issues.push('[storyboard-visual-layer] ' + phase + ' visible non-overlay renderers: ' + count + (names ? ' (' + names + ')' : ''));
    }
    const activePhysics = Array.isArray(layerAudit && layerAudit.activeLegacyPhysics)
      ? layerAudit.activeLegacyPhysics
      : [];
    const activePhysicsCount = Number.isFinite(Number(layerAudit && layerAudit.activeLegacyPhysicsCount))
      ? Number(layerAudit.activeLegacyPhysicsCount)
      : activePhysics.length;
    if (activePhysicsCount > 0) {
      const names = activePhysics.map((row) => row && row.name).filter(Boolean).slice(0, 5).join(',');
      issues.push('[storyboard-legacy-physics] ' + phase + ' active legacy colliders: ' + activePhysicsCount + (names ? ' (' + names + ')' : ''));
    }
  }

  const movementAudits = Array.isArray(audit.movementAudits) ? audit.movementAudits : [];
  for (const moveAudit of movementAudits) {
    const dir = moveAudit && moveAudit.direction || 'move';
    const maxStep = Number(moveAudit && moveAudit.maxAbsStepPx);
    if (Number.isFinite(maxStep) && maxStep > maxMotionStepPx) {
      issues.push('[storyboard-motion] ' + dir + ' visible player step too large: ' + maxStep + 'px > ' + maxMotionStepPx + 'px');
    }
    const lineDelta = Number(moveAudit && moveAudit.maxGuidanceLinePlayerDelta);
    if (Number.isFinite(lineDelta) && lineDelta > maxGuidanceLinePlayerDelta) {
      issues.push('[storyboard-guidance-line] ' + dir + ' line/player anchor delta ' + lineDelta + 'wu > ' + maxGuidanceLinePlayerDelta + 'wu');
    }
    const screenDx = Number(moveAudit && moveAudit.screenDx);
    const screenDy = Number(moveAudit && moveAudit.screenDy);
    if (dir === 'right' && (!Number.isFinite(screenDx) || screenDx < minDirectionalTravelPx)) {
      issues.push('[storyboard-direction] right drag moved player dx=' + screenDx + 'px');
    } else if (dir === 'left' && (!Number.isFinite(screenDx) || screenDx > -minDirectionalTravelPx)) {
      issues.push('[storyboard-direction] left drag moved player dx=' + screenDx + 'px');
    } else if (dir === 'up' && (!Number.isFinite(screenDy) || screenDy > -minDirectionalTravelPx)) {
      issues.push('[storyboard-direction] up drag moved player dy=' + screenDy + 'px');
    } else if (dir === 'down' && (!Number.isFinite(screenDy) || screenDy < minDirectionalTravelPx)) {
      issues.push('[storyboard-direction] down drag moved player dy=' + screenDy + 'px');
    }
    const checks = Array.isArray(moveAudit && moveAudit.labelDirectionChecks) ? moveAudit.labelDirectionChecks : [];
    for (const check of checks) {
      const dy = Number(check && check.dEntityY);
      const ly = Number(check && check.dLabelBottom);
      if (!Number.isFinite(dy) || !Number.isFinite(ly)) continue;
      if (Math.abs(dy) < 0.5 || Math.abs(ly) < 0.5) continue;
      if (dy * ly < 0) {
        issues.push('[storyboard-label-motion] ' + dir + ' label moved opposite to player: entityY=' + dy + ', labelY=' + ly);
      }
    }
  }
  const clickAudits = Array.isArray(audit.clickAudits) ? audit.clickAudits : [];
  for (const clickAudit of clickAudits) {
    const displacement = Number(clickAudit && clickAudit.maxDisplacementPx);
    if (!Number.isFinite(displacement) || displacement > maxClickDisplacementPx) {
      issues.push('[storyboard-click-zero] click without drag moved player ' + displacement + 'px');
    }
  }
  const targetMarkerAudits = Array.isArray(audit.targetMarkerAudits) ? audit.targetMarkerAudits : [];
  for (const markerAudit of targetMarkerAudits) {
    if (!markerAudit || markerAudit.visible !== true || !markerAudit.targetName) {
      issues.push('[storyboard-target-marker] ' + (markerAudit && markerAudit.phase || 'current') + ' target marker missing: ' + (markerAudit && markerAudit.reason || 'not visible'));
    }
  }

  return {
    passed: issues.length === 0,
    reason: issues.length ? issues.slice(0, 5).join('; ') : 'storyboard visual audit passed',
    issues,
  };
}

async function runStoryboardVisualAudit(previewUrl, taskId, log) {
  const logger = typeof log === 'function' ? log : function() {};
  if (process.env.BLUEPRINT_SKIP_STORYBOARD_VISUAL_AUDIT === '1') {
    return { passed: true, skipped: true, reason: 'skipped by BLUEPRINT_SKIP_STORYBOARD_VISUAL_AUDIT' };
  }

  let chromium;
  try {
    chromium = require('playwright').chromium;
  } catch(e) {
    return { passed: false, skipped: false, reason: 'playwright unavailable for storyboard visual audit: ' + e.message };
  }

  const outDir = path.join(CUA_RESULTS_DIR, taskId + '-storyboard-visual-audit');
  try { fs.mkdirSync(outDir, { recursive: true }); } catch(e) {}
  const audit = {
    passed: false,
    skipped: false,
    url: previewUrl,
    outDir,
    phaseAudits: [],
    movementAudits: [],
    clickAudits: [],
    targetMarkerAudits: [],
    visualLayerAudits: [],
    labelCenterTolerancePx: 8,
    labelGapTargetPx: 8,
    labelGapTolerancePx: 8,
    maxMotionStepPx: 6,
    minDirectionalTravelPx: 8,
    maxClickDisplacementPx: 1.5,
    maxGuidanceLinePlayerDeltaWorld: 0.08,
    maxNonOverlayVisibleSurfaceCount: 0,
  };
  let browser = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-web-security']
    });
    const context = await browser.newContext({
      viewport: { width: 800, height: 600 },
      deviceScaleFactor: 1,
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    await page.goto(previewUrl, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(7000);
    const ready = await page.evaluate(() => {
      return typeof window.__storyboardEntityScreenRect === 'function' &&
        document.querySelectorAll('[data-entity]').length > 0;
    }).catch(() => false);
    if (!ready) {
      audit.skipped = true;
      audit.passed = true;
      audit.reason = 'storyboard label surfaces unavailable';
      return audit;
    }

    async function labelRows(phase) {
      return page.evaluate((phaseName) => {
        function rectObj(r) {
          return r ? {
            x: Number(r.x.toFixed(2)),
            y: Number(r.y.toFixed(2)),
            w: Number(r.width.toFixed(2)),
            h: Number(r.height.toFixed(2)),
            cx: Number((r.x + r.width / 2).toFixed(2)),
            bottom: Number((r.y + r.height).toFixed(2)),
          } : null;
        }
        return Array.from(document.querySelectorAll('[data-entity]')).map((el) => {
          const entity = el.getAttribute('data-entity') || '';
          const lr = el.getBoundingClientRect();
          let er = null;
          try {
            er = window.__storyboardEntityScreenRect(entity) || window.__storyboardEntityScreenRect(entity.replace(/^_+/, ''));
          } catch(e) {}
          const label = rectObj(lr);
          const entityRect = er ? {
            x: Number(er.x_px.toFixed(2)),
            y: Number(er.y_px.toFixed(2)),
            w: Number(er.w_px.toFixed(2)),
            h: Number(er.h_px.toFixed(2)),
            cx: Number((er.x_px + er.w_px / 2).toFixed(2)),
            bottom: Number((er.y_px + er.h_px).toFixed(2)),
          } : null;
          const style = getComputedStyle(el);
          const visible = style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0.05;
          return {
            phase: phaseName,
            entity,
            text: (el.textContent || '').trim(),
            visible,
            label,
            entityRect,
            centerDx: entityRect && label ? Number((label.cx - entityRect.cx).toFixed(2)) : null,
            topGap: entityRect && label ? Number((entityRect.y - label.bottom).toFixed(2)) : null,
          };
        });
      }, phase);
    }

    async function visualLayerRows(phase) {
      return page.evaluate((phaseName) => {
        function isDescendantOf(node, ancestor) {
          let cur = node;
          let guard = 0;
          while (cur && guard++ < 32) {
            if (cur === ancestor || cur.name === '__StoryboardVisualOverlay') return true;
            cur = cur.parent;
          }
          return false;
        }
        function nodePath(node) {
          const parts = [];
          let cur = node;
          let guard = 0;
          while (cur && guard++ < 32) {
            parts.unshift(cur.name || '<unnamed>');
            cur = cur.parent;
          }
          return parts.join('/');
        }
        function renderEntries(node) {
          const out = [];
          try {
            if (node.render) out.push({ kind: 'render', component: node.render, meshInstances: node.render.meshInstances || [] });
          } catch(eRender) {}
          try {
            if (node.model) out.push({ kind: 'model', component: node.model, meshInstances: node.model.model && node.model.model.meshInstances || [] });
          } catch(eModel) {}
          try {
            const renderers = node._unityComponents && node._unityComponents.renderer || [];
            for (let i = 0; i < renderers.length; i++) {
              const rc = renderers[i];
              out.push({ kind: 'unity-renderer', component: rc, meshInstances: rc && rc.meshInstances || [] });
            }
          } catch(eUnity) {}
          return out;
        }
        function entryVisible(entry) {
          const comp = entry && entry.component;
          if (!comp || comp.enabled === false) return false;
          try { if (comp.code && comp.code.enabled === false) return false; } catch(eCode) {}
          const mis = entry.meshInstances || [];
          if (!mis.length) return true;
          return mis.some((mi) => mi && mi.visible !== false);
        }
        function fallbackLayerAudit() {
          const app = window.app && window.app.app;
          const root = app && app.root;
          const overlay = window.__storyboardVisualOverlayRoot || root && root.findByName && root.findByName('__StoryboardVisualOverlay');
          const visible = [];
          let overlaySurfaceCount = 0;
          function walk(node) {
            if (!node) return;
            const isOverlay = overlay && isDescendantOf(node, overlay);
            const entries = renderEntries(node).filter(entryVisible);
            if (entries.length) {
              if (isOverlay) {
                overlaySurfaceCount += entries.length;
              } else {
                visible.push({ name: node.name || '', path: nodePath(node), surfaceCount: entries.length });
              }
            }
            (node.children || []).forEach(walk);
          }
          if (root) walk(root);
          return {
            suppressApplied: false,
            overlaySurfaceCount,
            suppressedLegacySurfaces: [],
            visibleNonOverlaySurfaces: visible,
            visibleNonOverlaySurfaceCount: visible.length
          };
        }
        let layer = null;
        try {
          if (typeof window.__auditStoryboardVisualLayer === 'function') {
            layer = window.__auditStoryboardVisualLayer({ suppress: false });
          }
        } catch(eAudit) {}
        if (!layer) layer = fallbackLayerAudit();
        const actualVisibleEntities = [];
        try {
          const roots = window.__storyboardEntityRoots || {};
          Object.keys(roots).forEach((name) => {
            const ent = roots[name];
            if (!ent || ent.enabled === false) return;
            let rect = null;
            try {
              rect = typeof window.__storyboardEntityScreenRect === 'function' ? window.__storyboardEntityScreenRect(name) : null;
            } catch(eRect) {}
            if (rect && Number(rect.w_px) > 0 && Number(rect.h_px) > 0) actualVisibleEntities.push(name);
          });
        } catch(eEntities) {}
        layer.phase = phaseName;
        return { visualLayer: layer, actualVisibleEntities };
      }, phase);
    }

    const phases = await page.evaluate(() => {
      const va = window.__BLUEPRINT_VISUAL_ASSETS__ || {};
      const list = va.sourcePhaseContract && va.sourcePhaseContract.phases ||
        va.fidelityContract && va.fidelityContract.phases || [];
      return Array.isArray(list) && list.length ? list.map((p, i) => ({
        index: i + 1,
        id: p && p.id || ('phase' + (i + 1)),
        showEntities: Array.isArray(p && p.showEntities) ? p.showEntities.slice() : []
      })) : [{ index: 1, id: 'current', showEntities: [] }];
    }).catch(() => [{ index: 1, id: 'current' }]);

    for (const phase of phases) {
      try {
        const sep = previewUrl.indexOf('?') >= 0 ? '&' : '?';
        await page.goto(previewUrl + sep + 'storyboardPhaseAudit=' + encodeURIComponent(String(phase.index)) + '&cb=' + Date.now(), { waitUntil: 'load', timeout: 60000 });
      } catch(e) {}
      await page.waitForTimeout(phase.index <= 1 ? 7000 : 1200);
      if (phase.index > 1) {
        try {
          await page.evaluate(async (n) => {
            if (typeof window.__driveToPhase === 'function') await window.__driveToPhase(n);
          }, phase.index - 1);
        } catch(e) {}
      }
      await page.waitForTimeout(1800);
      const layerRows = await visualLayerRows(phase.id);
      audit.visualLayerAudits.push(layerRows.visualLayer);
      audit.phaseAudits.push({
        phase: phase.id,
        expectedVisibleEntities: phase.showEntities || [],
        actualVisibleEntities: layerRows.actualVisibleEntities || [],
        labels: await labelRows(phase.id)
      });
      const markerAudit = await page.evaluate((phaseName) => {
        const state = window.__storyboardTargetMarkerState || { visible: false, reason: 'state-unavailable' };
        return Object.assign({ phase: phaseName }, state);
      }, phase.id).catch(() => ({ phase: phase.id, visible: false, reason: 'eval-failed' }));
      audit.targetMarkerAudits.push(markerAudit);
    }
    try {
      const sep = previewUrl.indexOf('?') >= 0 ? '&' : '?';
      await page.goto(previewUrl + sep + 'storyboardMotionAudit=1&cb=' + Date.now(), { waitUntil: 'load', timeout: 60000 });
    } catch(e) {}
    await page.waitForTimeout(7000);

    async function samplePlayerVisualState(sampleLabel) {
      return page.evaluate((label) => {
        const er = typeof window.__storyboardEntityScreenRect === 'function'
          ? (window.__storyboardEntityScreenRect('Player') || window.__storyboardEntityScreenRect('_player'))
          : null;
        const el = Array.from(document.querySelectorAll('[data-entity]')).find((node) => /player/i.test(node.getAttribute('data-entity') || '')) ||
          Array.from(document.querySelectorAll('[data-entity]')).find((node) => /玩家|player/i.test(node.textContent || ''));
        const lr = el && el.getBoundingClientRect();
        return {
          label,
          t: performance.now(),
          entityCx: er ? er.x_px + er.w_px / 2 : null,
          entityY: er ? er.y_px : null,
          labelCx: lr ? lr.x + lr.width / 2 : null,
          labelBottom: lr ? lr.y + lr.height : null,
        };
      }, sampleLabel).catch(() => null);
    }

    async function auditClickNoMove() {
      const before = await samplePlayerVisualState('click-before');
      await page.mouse.move(400, 300);
      await page.mouse.click(400, 300);
      await page.waitForTimeout(650);
      const after = await samplePlayerVisualState('click-after');
      const dx = before && after && Number.isFinite(before.entityCx) && Number.isFinite(after.entityCx)
        ? after.entityCx - before.entityCx
        : NaN;
      const dy = before && after && Number.isFinite(before.entityY) && Number.isFinite(after.entityY)
        ? after.entityY - before.entityY
        : NaN;
      audit.clickAudits.push({
        before,
        after,
        screenDx: Number.isFinite(dx) ? Number(dx.toFixed(2)) : null,
        screenDy: Number.isFinite(dy) ? Number(dy.toFixed(2)) : null,
        maxDisplacementPx: Number.isFinite(dx) && Number.isFinite(dy) ? Number(Math.sqrt(dx * dx + dy * dy).toFixed(2)) : null,
      });
    }

    async function startPlayerLabelCapture(captureLabel) {
      await page.evaluate((label) => {
        window.__bpStoryboardMotionCapture = {
          label,
          stop: false,
          samples: [],
        };
	        function sample() {
	          const cap = window.__bpStoryboardMotionCapture;
	          if (!cap || cap.stop) return;
          const er = typeof window.__storyboardEntityScreenRect === 'function'
            ? (window.__storyboardEntityScreenRect('Player') || window.__storyboardEntityScreenRect('_player'))
            : null;
          const el = Array.from(document.querySelectorAll('[data-entity]')).find((node) => /player/i.test(node.getAttribute('data-entity') || '')) ||
            Array.from(document.querySelectorAll('[data-entity]')).find((node) => /玩家|player/i.test(node.textContent || ''));
	          const lr = el && el.getBoundingClientRect();
	          let linePlayerDelta = null;
	          try {
	            const state = window.__storyboardGuidanceLineState || null;
	            const roots = window.__storyboardEntityRoots || {};
	            const root = roots[state && state.playerName || 'Player'] || roots.Player || roots._player;
	            const pp = root && root.getPosition && root.getPosition();
	            if (state && state.visible && state.player && pp) {
	              const dx = Number(state.player.x) - Number(pp.x);
	              const dz = Number(state.player.z) - Number(pp.z);
	              if (Number.isFinite(dx) && Number.isFinite(dz)) linePlayerDelta = Math.sqrt(dx * dx + dz * dz);
	            }
	          } catch(eLine) {}
	          cap.samples.push({
	            label: label + '-' + cap.samples.length,
	            t: performance.now(),
	            entityCx: er ? er.x_px + er.w_px / 2 : null,
	            entityY: er ? er.y_px : null,
	            labelCx: lr ? lr.x + lr.width / 2 : null,
	            labelBottom: lr ? lr.y + lr.height : null,
	            linePlayerDelta: Number.isFinite(linePlayerDelta) ? Number(linePlayerDelta.toFixed(4)) : null,
	          });
          requestAnimationFrame(sample);
        }
        requestAnimationFrame(sample);
      }, captureLabel);
    }

    async function stopPlayerLabelCapture() {
      return page.evaluate(() => {
        const cap = window.__bpStoryboardMotionCapture;
        if (!cap) return [];
        cap.stop = true;
        const samples = Array.isArray(cap.samples) ? cap.samples.slice() : [];
        window.__bpStoryboardMotionCapture = null;
        return samples;
      });
    }

    async function auditMove(direction, dx, dy) {
      const center = { x: 130, y: 520 };
      await startPlayerLabelCapture(direction);
      await page.mouse.move(center.x, center.y);
      await page.mouse.down();
      await page.mouse.move(center.x + dx, center.y + dy, { steps: 16 });
      await page.waitForTimeout(900);
      await page.mouse.up();
      await page.waitForTimeout(120);
      const samples = await stopPlayerLabelCapture();
      const stepPx = [];
      const labelDirectionChecks = [];
      for (let i = 1; i < samples.length; i++) {
        const a = samples[i - 1];
        const b = samples[i];
        if (Number.isFinite(a.entityCx) && Number.isFinite(b.entityCx) && Number.isFinite(a.entityY) && Number.isFinite(b.entityY)) {
          const sx = b.entityCx - a.entityCx;
          const sy = b.entityY - a.entityY;
          stepPx.push(Math.sqrt(sx * sx + sy * sy));
        }
        if (Number.isFinite(a.entityY) && Number.isFinite(b.entityY) && Number.isFinite(a.labelBottom) && Number.isFinite(b.labelBottom)) {
          labelDirectionChecks.push({
            dEntityY: Number((b.entityY - a.entityY).toFixed(2)),
            dLabelBottom: Number((b.labelBottom - a.labelBottom).toFixed(2)),
          });
        }
      }
      const scoredSteps = stepPx.slice(1);
      const first = samples[0] || null;
      const last = samples[samples.length - 1] || null;
      const lineDeltas = samples.map((sample) => Number(sample && sample.linePlayerDelta)).filter(Number.isFinite);
      const screenDx = first && last && Number.isFinite(first.entityCx) && Number.isFinite(last.entityCx)
        ? Number((last.entityCx - first.entityCx).toFixed(2))
        : null;
      const screenDy = first && last && Number.isFinite(first.entityY) && Number.isFinite(last.entityY)
        ? Number((last.entityY - first.entityY).toFixed(2))
        : null;
      audit.movementAudits.push({
        direction,
        screenDx,
        screenDy,
        maxGuidanceLinePlayerDelta: lineDeltas.length ? Number(Math.max.apply(Math, lineDeltas).toFixed(4)) : null,
        maxAbsStepPx: scoredSteps.length ? Number(Math.max.apply(Math, scoredSteps).toFixed(2)) : 0,
        sampleCount: samples.length,
        samples,
        labelDirectionChecks,
      });
    }

    await auditClickNoMove();
    await auditMove('right', 44, 0);
    await auditMove('up', 0, -44);
    await auditMove('down', 0, 44);
    await auditMove('left', -44, 0);
    Object.assign(audit, evaluateStoryboardVisualAuditResult(audit));
  } catch(e) {
    audit.passed = false;
    audit.reason = 'storyboard visual audit failed: ' + e.message;
  } finally {
    try {
      fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(audit, null, 2));
    } catch(e) {}
    if (browser) {
      try { await browser.close(); } catch(e) {}
    }
  }

  logger('[PlayableAgent] Storyboard visual audit: ' + (audit.passed ? 'PASS' : 'FAIL') + ' | ' + audit.reason, taskId);
  return audit;
}

function shouldRunStoryboardVideoAudit(env) {
  env = env || process.env;
  if (/^(1|true|on|yes)$/i.test(String(env.BLUEPRINT_SKIP_STORYBOARD_VIDEO_AUDIT || ''))) return false;
  if (/^(0|false|off|no)$/i.test(String(env.BLUEPRINT_STORYBOARD_VIDEO_AUDIT || ''))) return false;
  if (/^(0|false|off|no)$/i.test(String(env.BLUEPRINT_VOLC_VIDEO_AUDIT || ''))) return false;
  if (/^(1|true|on|yes)$/i.test(String(env.BLUEPRINT_STORYBOARD_VIDEO_AUDIT || ''))) return true;
  if (/^(1|true|on|yes)$/i.test(String(env.BLUEPRINT_VOLC_VIDEO_AUDIT || ''))) return true;
  return false;
}

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise(function(_, reject) {
      timer = setTimeout(function() {
        reject(new Error(label + ' timed out after ' + timeoutMs + 'ms'));
      }, timeoutMs);
    }),
  ]).finally(function() {
    if (timer) clearTimeout(timer);
  });
}

function encodeFrameSequenceToVideo(framesDir, outputPath, fps) {
  fps = Number(fps);
  if (!Number.isFinite(fps) || fps <= 0) fps = 4;
  return new Promise(function(resolve, reject) {
    execFile('ffmpeg', [
      '-y',
      '-framerate', String(fps),
      '-i', path.join(framesDir, 'frame-%04d.jpg'),
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      outputPath,
    ], { timeout: 120000 }, function(err) {
      if (err) return reject(new Error('storyboard video ffmpeg encode failed: ' + err.message));
      resolve(outputPath);
    });
  });
}

async function runStoryboardVideoAudit(previewUrl, taskId, log) {
  const logger = typeof log === 'function' ? log : function() {};
  const outDir = path.join(CUA_RESULTS_DIR, taskId + '-storyboard-video-audit');
  try { fs.mkdirSync(outDir, { recursive: true }); } catch(e) {}

  const result = {
    passed: false,
    skipped: false,
    url: previewUrl,
    outDir,
    recording: null,
    volcengineVideoAudit: null,
  };

  if (!shouldRunStoryboardVideoAudit(process.env)) {
    result.passed = true;
    result.skipped = true;
    result.reason = 'skipped by storyboard/video audit env';
    return result;
  }

  const recordOnly = /^(1|true|on|yes)$/i.test(String(process.env.BLUEPRINT_STORYBOARD_VIDEO_AUDIT_RECORD_ONLY || ''));
  let videoAudit = null;
  if (!recordOnly) {
    try {
      videoAudit = require('./volcengine-video-audit.cjs');
    } catch(e) {
      result.passed = false;
      result.reason = 'volcengine video audit module unavailable: ' + e.message;
      try { fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2)); } catch(writeErr) {}
      return result;
    }

    const hasCredentials = typeof videoAudit.hasVolcengineVideoAuditCredentials === 'function'
      ? videoAudit.hasVolcengineVideoAuditCredentials()
      : !!(process.env.ARK_API_KEY || process.env.DOUBAO_API_KEY);
    if (!hasCredentials) {
      result.passed = process.env.BLUEPRINT_VOLC_VIDEO_AUDIT_REQUIRED !== '1';
      result.skipped = true;
      result.reason = 'Volcengine video audit skipped: ARK_API_KEY/DOUBAO_API_KEY missing';
      try { fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2)); } catch(writeErr) {}
      return result;
    }
  }

  let chromium;
  try {
    chromium = require('playwright').chromium;
  } catch(e) {
    result.passed = false;
    result.reason = 'playwright unavailable for storyboard video audit: ' + e.message;
    try { fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2)); } catch(writeErr) {}
    return result;
  }

  const framesDir = path.join(outDir, 'frames');
  try { fs.rmSync(framesDir, { recursive: true, force: true }); } catch(e) {}
  try { fs.mkdirSync(framesDir, { recursive: true }); } catch(e) {}
  let browser = null;
  let finalVideoPath = null;
  let frameIndex = 0;
  try {
    logger('[PlayableAgent] Storyboard video audit: launching mobile recorder', taskId);
    browser = await withTimeout(chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-web-security'],
    }), 20000, 'storyboard video browser launch');
    const context = await withTimeout(browser.newContext({
      viewport: { width: 540, height: 960 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      ignoreHTTPSErrors: true,
    }), 10000, 'storyboard video browser context');
    const page = await withTimeout(context.newPage(), 10000, 'storyboard video page create');
    page.setDefaultTimeout(15000);
    logger('[PlayableAgent] Storyboard video audit: loading preview', taskId);
    await withTimeout(page.goto(previewUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }), 50000, 'storyboard video preview load');
    await page.waitForTimeout(5000);
    logger('[PlayableAgent] Storyboard video audit: waiting for playable readiness', taskId);
    await withTimeout(page.waitForFunction(() => {
      return typeof window.__storyboardEntityScreenRect === 'function' ||
        (typeof UnityEngine !== 'undefined' && typeof Bridge !== 'undefined');
    }, null, { timeout: 15000 }).catch(() => null), 18000, 'storyboard video readiness wait');
    await page.waitForTimeout(2000);

    async function captureFrame(label) {
      frameIndex++;
      const framePath = path.join(framesDir, 'frame-' + String(frameIndex).padStart(4, '0') + '.jpg');
      await withTimeout(page.screenshot({ path: framePath, type: 'jpeg', quality: 82 }), 10000, 'storyboard video screenshot ' + label);
      return framePath;
    }
    async function holdFrames(label, count, delayMs) {
      for (let i = 0; i < count; i++) {
        await captureFrame(label + '-' + i);
        if (delayMs > 0) await page.waitForTimeout(delayMs);
      }
    }
    async function setAuditStepLabel(text) {
      await page.evaluate((labelText) => {
        let el = document.getElementById('bp-video-audit-step');
        if (!el) {
          el = document.createElement('div');
          el.id = 'bp-video-audit-step';
          el.style.cssText = [
            'position:fixed',
            'right:12px',
            'bottom:12px',
            'z-index:2147483600',
            'pointer-events:none',
            'padding:7px 11px',
            'border-radius:7px',
            'background:rgba(0,0,0,.78)',
            'border:1px solid rgba(255,235,59,.65)',
            'color:#ffeb3b',
            'font:900 16px Arial,"Microsoft YaHei",sans-serif',
            'box-shadow:0 8px 22px rgba(0,0,0,.35)'
          ].join(';');
          document.body.appendChild(el);
        }
        el.textContent = labelText || '';
        el.style.display = labelText ? 'block' : 'none';
      }, text).catch(() => null);
    }
    async function setAuditPointerOverlay(label, sx, sy, x, y, active) {
      await page.evaluate((args) => {
        let root = document.getElementById('bp-video-audit-pointer');
        if (!root) {
          root = document.createElement('div');
          root.id = 'bp-video-audit-pointer';
          root.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483599;pointer-events:none;font-family:Arial,"Microsoft YaHei",sans-serif';
          root.innerHTML = [
            '<div class="bp-audit-origin"></div>',
            '<div class="bp-audit-line"></div>',
            '<div class="bp-audit-dot"></div>',
            '<div class="bp-audit-label"></div>'
          ].join('');
          const style = document.createElement('style');
          style.textContent = [
            '#bp-video-audit-pointer .bp-audit-origin{position:fixed;width:28px;height:28px;margin:-14px 0 0 -14px;border:3px solid #ffeb3b;border-radius:50%;box-shadow:0 0 0 3px rgba(0,0,0,.45)}',
            '#bp-video-audit-pointer .bp-audit-dot{position:fixed;width:22px;height:22px;margin:-11px 0 0 -11px;background:#ffeb3b;border:3px solid #111827;border-radius:50%;box-shadow:0 2px 10px rgba(0,0,0,.45)}',
            '#bp-video-audit-pointer .bp-audit-line{position:fixed;height:6px;margin:-3px 0 0 0;background:#ffeb3b;border-radius:3px;box-shadow:0 2px 8px rgba(0,0,0,.5);transform-origin:0 50%}',
            '#bp-video-audit-pointer .bp-audit-label{position:fixed;margin:14px 0 0 14px;padding:4px 7px;border-radius:6px;background:rgba(0,0,0,.78);color:#ffeb3b;font:900 13px Arial,"Microsoft YaHei",sans-serif;white-space:nowrap}'
          ].join('');
          document.head.appendChild(style);
          document.body.appendChild(root);
        }
        root.style.display = args.active ? 'block' : 'none';
        if (!args.active) return;
        const origin = root.querySelector('.bp-audit-origin');
        const dot = root.querySelector('.bp-audit-dot');
        const line = root.querySelector('.bp-audit-line');
        const text = root.querySelector('.bp-audit-label');
        const sx = Number(args.sx) || 0;
        const sy = Number(args.sy) || 0;
        const x = Number(args.x) || sx;
        const y = Number(args.y) || sy;
        const dx = x - sx;
        const dy = y - sy;
        const len = Math.sqrt(dx * dx + dy * dy);
        const angle = Math.atan2(dy, dx);
        origin.style.left = sx + 'px';
        origin.style.top = sy + 'px';
        dot.style.left = x + 'px';
        dot.style.top = y + 'px';
        line.style.left = sx + 'px';
        line.style.top = sy + 'px';
        line.style.width = Math.max(1, len) + 'px';
        line.style.transform = 'rotate(' + angle + 'rad)';
        text.style.left = x + 'px';
        text.style.top = y + 'px';
        text.textContent = String(args.label || '').toUpperCase();
      }, { label, sx, sy, x, y, active }).catch(() => null);
    }
    async function samplePlayerVideoAuditState(label) {
      return page.evaluate((sampleLabel) => {
        function roundedRect(rect) {
          if (!rect) return null;
          return {
            x: Number(Number(rect.x).toFixed(2)),
            y: Number(Number(rect.y).toFixed(2)),
            w: Number(Number(rect.width).toFixed(2)),
            h: Number(Number(rect.height).toFixed(2)),
            cx: Number(Number(rect.x + rect.width / 2).toFixed(2)),
            cy: Number(Number(rect.y + rect.height / 2).toFixed(2)),
            bottom: Number(Number(rect.y + rect.height).toFixed(2)),
          };
        }
        function roundedEntityRect(rect) {
          if (!rect) return null;
          return {
            x: Number(Number(rect.x_px).toFixed(2)),
            y: Number(Number(rect.y_px).toFixed(2)),
            w: Number(Number(rect.w_px).toFixed(2)),
            h: Number(Number(rect.h_px).toFixed(2)),
            cx: Number(Number(rect.x_px + rect.w_px / 2).toFixed(2)),
            cy: Number(Number(rect.y_px + rect.h_px / 2).toFixed(2)),
          };
        }
        function roundedPosition(pos) {
          if (!pos) return null;
          return {
            x: Number(Number(pos.x).toFixed(3)),
            y: Number(Number(pos.y || 0).toFixed(3)),
            z: Number(Number(pos.z).toFixed(3)),
          };
        }
        let gamePos = null;
        try {
          const gs = typeof window.__gameState === 'function' ? window.__gameState() : window.__gameState;
          const states = gs && (gs.entity_states || gs.entityStates) || {};
          const st = states.Player || states.player;
          gamePos = st && st.position ? roundedPosition(st.position) : null;
        } catch(e) {}
        const labelEl = document.querySelector('.bp-worldlabel[data-entity="Player"]');
        const labelRect = labelEl && labelEl.getBoundingClientRect ? labelEl.getBoundingClientRect() : null;
	        let entityRect = null;
	        try {
	          entityRect = window.__storyboardEntityScreenRect && window.__storyboardEntityScreenRect('Player');
	        } catch(e) {}
	        let linePlayerDelta = null;
	        try {
	          const state = window.__storyboardGuidanceLineState || null;
	          const roots = window.__storyboardEntityRoots || {};
	          const root = roots[state && state.playerName || 'Player'] || roots.Player || roots._player;
	          const pp = root && root.getPosition && root.getPosition();
	          if (state && state.visible && state.player && pp) {
	            const dx = Number(state.player.x) - Number(pp.x);
	            const dz = Number(state.player.z) - Number(pp.z);
	            if (Number.isFinite(dx) && Number.isFinite(dz)) linePlayerDelta = Number(Math.sqrt(dx * dx + dz * dz).toFixed(4));
	          }
	        } catch(eLine) {}
	        const label = roundedRect(labelRect);
	        const rect = roundedEntityRect(entityRect);
	        return {
	          label: sampleLabel,
	          gamePos,
	          entityRect: rect,
	          labelRect: label,
	          labelAnchorDelta: label && rect ? Number(Number(label.bottom - (rect.y - 8)).toFixed(2)) : null,
	          linePlayerDelta,
	        };
	      }, label).catch(() => null);
	    }
    function summarizeVideoAuditStep(before, samples, after) {
      const first = before || (samples && samples[0]) || null;
      const last = after || (samples && samples[samples.length - 1]) || null;
      const summary = { sampleCount: Array.isArray(samples) ? samples.length : 0 };
      if (first && last && first.gamePos && last.gamePos) {
        summary.gameDx = Number((last.gamePos.x - first.gamePos.x).toFixed(3));
        summary.gameDz = Number((last.gamePos.z - first.gamePos.z).toFixed(3));
      }
      if (first && last && first.entityRect && last.entityRect) {
        summary.rectDx = Number((last.entityRect.cx - first.entityRect.cx).toFixed(2));
        summary.rectDy = Number((last.entityRect.y - first.entityRect.y).toFixed(2));
      }
      if (first && last && first.labelRect && last.labelRect) {
        summary.labelDx = Number((last.labelRect.cx - first.labelRect.cx).toFixed(2));
        summary.labelDy = Number((last.labelRect.bottom - first.labelRect.bottom).toFixed(2));
      }
	      const deltas = [before, ...(Array.isArray(samples) ? samples : []), after]
	        .map((sample) => sample && sample.labelAnchorDelta)
	        .filter((value) => Number.isFinite(Number(value)))
	        .map((value) => Math.abs(Number(value)));
	      if (deltas.length) summary.maxLabelAnchorDelta = Number(Math.max(...deltas).toFixed(2));
	      const lineDeltas = [before, ...(Array.isArray(samples) ? samples : []), after]
	        .map((sample) => sample && sample.linePlayerDelta)
	        .filter((value) => Number.isFinite(Number(value)))
	        .map((value) => Math.abs(Number(value)));
	      if (lineDeltas.length) summary.maxGuidanceLinePlayerDelta = Number(Math.max(...lineDeltas).toFixed(4));
	      return summary;
	    }
    function evaluateVideoMovementSummaries(steps) {
      const issues = [];
      const minTravel = Number(process.env.BLUEPRINT_STORYBOARD_VIDEO_MIN_TRAVEL_PX || 10);
      const maxAnchorDelta = Number(process.env.BLUEPRINT_STORYBOARD_VIDEO_MAX_LABEL_ANCHOR_DELTA_PX || 2);
      for (const step of steps || []) {
        const label = step && step.label || 'move';
        const summary = step && step.summary || {};
        const rectDx = Number(summary.rectDx);
        const rectDy = Number(summary.rectDy);
        if (label === 'right' && (!Number.isFinite(rectDx) || rectDx < minTravel)) {
          issues.push('right rectDx=' + rectDx);
        } else if (label === 'left' && (!Number.isFinite(rectDx) || rectDx > -minTravel)) {
          issues.push('left rectDx=' + rectDx);
        } else if (label === 'up' && (!Number.isFinite(rectDy) || rectDy > -minTravel)) {
          issues.push('up rectDy=' + rectDy);
        } else if (label === 'down' && (!Number.isFinite(rectDy) || rectDy < minTravel)) {
          issues.push('down rectDy=' + rectDy);
        }
        const anchorDelta = Number(summary.maxLabelAnchorDelta);
        if (Number.isFinite(anchorDelta) && anchorDelta > maxAnchorDelta) {
          issues.push(label + ' maxLabelAnchorDelta=' + anchorDelta);
        }
        const lineDelta = Number(summary.maxGuidanceLinePlayerDelta);
        if (Number.isFinite(lineDelta) && lineDelta > 0.08) {
          issues.push(label + ' maxGuidanceLinePlayerDelta=' + lineDelta);
        }
      }
      return issues;
    }

    await holdFrames('initial', 1, 0);

	    const inputModeRaw = String(process.env.BLUEPRINT_STORYBOARD_VIDEO_AUDIT_INPUT || '').toLowerCase();
	    const inputMode = /^(runtime|runtime-joystick|internal)$/.test(inputModeRaw)
	      ? 'runtime-joystick'
	      : (/^(mouse|playwright-mouse)$/.test(inputModeRaw)
	        ? 'mouse'
	        : (/^(touch|cdp-touch)$/.test(inputModeRaw) ? 'touch' : 'dom-pointer'));
    const client = inputMode === 'touch'
      ? await withTimeout(context.newCDPSession(page), 10000, 'storyboard video CDP session')
      : null;
    async function drag(label, sx, sy, ex, ey) {
      logger('[PlayableAgent] Storyboard video audit: ' + inputMode + ' drag ' + label, taskId);
      const stepRecord = { label, inputMode, start: [sx, sy], end: [ex, ey] };
      await setAuditStepLabel('AUDIT DRAG ' + String(label || '').toUpperCase());
      await setAuditPointerOverlay(label, sx, sy, sx, sy, true);
      stepRecord.before = await samplePlayerVideoAuditState(label + '-before');
      if (inputMode === 'runtime-joystick') {
        await captureFrame(label + '-before');
        const vector = label === 'right' ? { x: 1, y: 0 } :
          label === 'left' ? { x: -1, y: 0 } :
          label === 'up' ? { x: 0, y: 1 } :
          { x: 0, y: -1 };
        const applied = await page.evaluate((dir) => {
          const joystick = window.GFM_Joystick && window.GFM_Joystick.instance;
          if (!joystick || !joystick._input) return false;
          joystick._dragging = true;
          joystick._input.x = dir.x;
          joystick._input.y = dir.y;
          return true;
        }, vector).catch(() => false);
        if (!applied) throw new Error('runtime joystick instance unavailable');
        const dragMs = Math.max(600, Number(process.env.BLUEPRINT_STORYBOARD_VIDEO_DRAG_MS || 1800) || 1800);
        const movingFrameCount = Math.max(2, Math.min(12, Number(process.env.BLUEPRINT_STORYBOARD_VIDEO_FRAMES_PER_DRAG || 4) || 4));
        const movingDelay = Math.max(80, Math.round(dragMs / movingFrameCount));
        stepRecord.samples = [];
	        for (let i = 0; i < movingFrameCount; i++) {
	          await page.waitForTimeout(movingDelay);
	          const px = sx + (ex - sx) * (i + 1) / movingFrameCount;
	          const py = sy + (ey - sy) * (i + 1) / movingFrameCount;
	          await setAuditPointerOverlay(label, sx, sy, px, py, true);
	          await captureFrame(label + '-move-' + i);
	          const sample = await samplePlayerVideoAuditState(label + '-move-' + i);
          if (sample) stepRecord.samples.push(sample);
        }
        await page.waitForTimeout(350);
        await captureFrame(label + '-hold');
        await page.evaluate(() => {
          const joystick = window.GFM_Joystick && window.GFM_Joystick.instance;
          if (joystick && joystick._input) {
            joystick._dragging = false;
            joystick._input.x = 0;
            joystick._input.y = 0;
          }
        }).catch(() => null);
	      } else if (inputMode === 'touch') {
	        await captureFrame(label + '-before');
	        stepRecord.samples = [];
	        await withTimeout(client.send('Input.dispatchTouchEvent', {
	          type: 'touchStart',
	          touchPoints: [{ x: sx, y: sy, id: 1, radiusX: 9, radiusY: 9 }],
	        }), 5000, 'storyboard video touchStart ' + label);
	        for (let i = 1; i <= 24; i++) {
	          const x = Math.round(sx + (ex - sx) * i / 24);
	          const y = Math.round(sy + (ey - sy) * i / 24);
	          await setAuditPointerOverlay(label, sx, sy, x, y, true);
	          await withTimeout(client.send('Input.dispatchTouchEvent', {
	            type: 'touchMove',
	            touchPoints: [{ x, y, id: 1, radiusX: 9, radiusY: 9 }],
	          }), 5000, 'storyboard video touchMove ' + label);
	          if (i % 6 === 0) {
	            await captureFrame(label + '-move-' + i);
	            const sample = await samplePlayerVideoAuditState(label + '-move-' + i);
	            if (sample) stepRecord.samples.push(sample);
	          }
	          await page.waitForTimeout(35);
	        }
	        await page.waitForTimeout(900);
	        await captureFrame(label + '-hold');
	        await withTimeout(client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }), 5000, 'storyboard video touchEnd ' + label);
	      } else if (inputMode === 'mouse') {
	        await captureFrame(label + '-before');
	        stepRecord.samples = [];
	        await withTimeout(page.mouse.move(sx, sy), 5000, 'storyboard video mouse move start ' + label);
	        await withTimeout(page.mouse.down(), 5000, 'storyboard video mouse down ' + label);
	        for (let i = 1; i <= 16; i++) {
	          const x = Math.round(sx + (ex - sx) * i / 16);
	          const y = Math.round(sy + (ey - sy) * i / 16);
	          await setAuditPointerOverlay(label, sx, sy, x, y, true);
	          await withTimeout(page.mouse.move(x, y), 5000, 'storyboard video mouse move ' + label);
	          if (i % 4 === 0) {
	            await captureFrame(label + '-move-' + i);
	            const sample = await samplePlayerVideoAuditState(label + '-move-' + i);
	            if (sample) stepRecord.samples.push(sample);
	          }
	          await page.waitForTimeout(30);
	        }
        await captureFrame(label + '-end');
        await holdFrames(label + '-hold', 1, 0);
        await withTimeout(page.mouse.up(), 5000, 'storyboard video mouse up ' + label);
	      } else {
	        await captureFrame(label + '-before');
	        stepRecord.samples = [];
	        async function emitDomPointer(type, x, y, buttons) {
	          await withTimeout(page.evaluate((args) => {
          function makeMouseEvent(type, x, y, buttons) {
            return new MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              view: window,
              clientX: x,
              clientY: y,
              screenX: x,
              screenY: y,
              button: 0,
              buttons,
            });
          }
          function makePointerEvent(type, x, y, buttons) {
            if (typeof PointerEvent !== 'function') return null;
            return new PointerEvent(type, {
              bubbles: true,
              cancelable: true,
              view: window,
              clientX: x,
              clientY: y,
              screenX: x,
              screenY: y,
              button: 0,
              buttons,
              pointerId: 1,
              pointerType: 'mouse',
              isPrimary: true,
            });
          }
          function emitOne(target, event) {
            try { target.dispatchEvent(event); } catch(e) {}
          }
          function emit(type, x, y, buttons) {
            const hit = document.elementFromPoint(x, y);
            const targets = [hit, document, window].filter(Boolean);
            for (const target of targets) {
              const pointerType = type.replace(/^mouse/, 'pointer');
              const pointerEvent = makePointerEvent(pointerType, x, y, buttons);
              if (pointerEvent) emitOne(target, pointerEvent);
              emitOne(target, makeMouseEvent(type, x, y, buttons));
            }
          }
	          emit(args.type, args.x, args.y, args.buttons);
	        }, { type, x, y, buttons }), 5000, 'storyboard video dom pointer ' + type + ' ' + label);
	        }
	        await emitDomPointer('mousemove', sx, sy, 0);
	        await emitDomPointer('mousedown', sx, sy, 1);
	        for (let i = 1; i <= 24; i++) {
	          const x = Math.round(sx + (ex - sx) * i / 24);
	          const y = Math.round(sy + (ey - sy) * i / 24);
	          await setAuditPointerOverlay(label, sx, sy, x, y, true);
	          await emitDomPointer('mousemove', x, y, 1);
	          if (i % 6 === 0) {
	            const sample = await samplePlayerVideoAuditState(label + '-move-' + i);
	            if (sample) stepRecord.samples.push(sample);
	          }
	          await page.waitForTimeout(35);
	        }
	        for (let hold = 0; hold < 10; hold++) {
	          await emitDomPointer('mousemove', ex, ey, 1);
	          await page.waitForTimeout(80);
	        }
	        await captureFrame(label + '-hold');
	        const holdSample = await samplePlayerVideoAuditState(label + '-hold');
	        if (holdSample) stepRecord.samples.push(holdSample);
	        await emitDomPointer('mouseup', ex, ey, 0);
        await captureFrame(label + '-end');
        await holdFrames(label + '-dom-hold', 1, 0);
      }
	      stepRecord.after = await samplePlayerVideoAuditState(label + '-after');
	      stepRecord.summary = summarizeVideoAuditStep(stepRecord.before, stepRecord.samples, stepRecord.after);
	      await setAuditPointerOverlay(label, sx, sy, ex, ey, false);
	      await page.waitForTimeout(450);
      result.recordingSteps = result.recordingSteps || [];
      result.recordingSteps.push(stepRecord);
    }
    async function runVideoAuditDrag(label, sx, sy, ex, ey) {
      const timeoutMs = Math.max(10000, Number(process.env.BLUEPRINT_STORYBOARD_VIDEO_DRAG_TIMEOUT_MS || 30000) || 30000);
      try {
        await withTimeout(drag(label, sx, sy, ex, ey), timeoutMs, 'storyboard video drag ' + label);
      } finally {
        try {
          if (client) await withTimeout(client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }), 3000, 'storyboard video forced touchEnd ' + label);
        } catch(e) {}
        try { await setAuditPointerOverlay(label, sx, sy, ex, ey, false); } catch(e2) {}
      }
    }

	    const joystickTarget = inputMode === 'runtime-joystick' ? { source: 'runtime-joystick', x: 0, y: 0, radius: 0 } : await page.evaluate(() => {
	      function rectFor(selector) {
	        const el = document.querySelector(selector);
	        if (!el) return null;
	        let node = el;
	        while (node && node.nodeType === 1) {
	          const style = getComputedStyle(node);
	          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.05) return null;
	          node = node.parentElement;
	        }
	        const rect = el.getBoundingClientRect();
	        if (!rect || rect.width <= 0 || rect.height <= 0) return null;
	        const vw = window.innerWidth || 540;
	        const vh = window.innerHeight || 960;
	        if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > vw || rect.y + rect.height > vh) return null;
	        return {
	          x: rect.x,
          y: rect.y,
          w: rect.width,
          h: rect.height,
          cx: rect.x + rect.width / 2,
          cy: rect.y + rect.height / 2,
	        };
	      }
      const stick = rectFor('#bp-storyboard-stick') || rectFor('[id*="stick" i]') || rectFor('[class*="stick" i]');
      const knob = rectFor('#bp-storyboard-knob') || rectFor('[id*="knob" i]') || rectFor('[class*="knob" i]');
      const base = stick || knob;
      if (!base) return null;
      const vw = window.innerWidth || 540;
      const vh = window.innerHeight || 960;
      const radius = Math.max(36, Math.min(80, Math.min(base.w || 96, base.h || 96) * 0.45));
      return {
        source: stick ? 'stick' : 'knob',
        x: Math.max(8, Math.min(vw - 8, base.cx)),
        y: Math.max(8, Math.min(vh - 8, base.cy)),
        radius,
        rect: base,
      };
    }).catch(() => null);
    const joy = joystickTarget || { source: 'fallback', x: 90, y: 750, radius: 78 };
    result.joystickTarget = joy;
    await runVideoAuditDrag('right', joy.x, joy.y, joy.x + joy.radius, joy.y);
    await runVideoAuditDrag('up', joy.x, joy.y, joy.x, joy.y - joy.radius);
    await runVideoAuditDrag('down', joy.x, joy.y, joy.x, joy.y + joy.radius);
    await runVideoAuditDrag('left', joy.x, joy.y, joy.x - joy.radius, joy.y);
    await holdFrames('final', 1, 0);

    logger('[PlayableAgent] Storyboard video audit: finalizing screenshot video', taskId);
    finalVideoPath = path.join(outDir, 'joystick-pointer.mp4');
    const recordFps = Number(process.env.BLUEPRINT_STORYBOARD_VIDEO_RECORD_FPS || 4);
    await encodeFrameSequenceToVideo(framesDir, finalVideoPath, recordFps);
	    result.recording = {
	      path: finalVideoPath,
	      format: 'mp4',
	      inputMode,
	      directions: ['right', 'up', 'down', 'left'],
	      frameCount: frameIndex,
	    };
	    result.deterministicMovementIssues = evaluateVideoMovementSummaries(result.recordingSteps || []);
	    if (result.deterministicMovementIssues.length) {
	      result.passed = false;
	      result.reason = 'storyboard video deterministic movement failed: ' + result.deterministicMovementIssues.slice(0, 5).join('; ');
	      return result;
	    }

	    logger('[PlayableAgent] Storyboard video audit recording saved: ' + finalVideoPath, taskId);
    if (recordOnly) {
      result.passed = true;
      result.skipped = true;
      result.reason = 'recording only; Volcengine video model call skipped by BLUEPRINT_STORYBOARD_VIDEO_AUDIT_RECORD_ONLY';
      return result;
    }
    const movementSummary = (result.recordingSteps || []).map((step) => {
      const s = step.summary || {};
      return step.label + ': gameDx=' + (s.gameDx ?? 'n/a') +
        ', gameDz=' + (s.gameDz ?? 'n/a') +
        ', rectDx=' + (s.rectDx ?? 'n/a') +
        ', rectDy=' + (s.rectDy ?? 'n/a') +
	        ', labelDx=' + (s.labelDx ?? 'n/a') +
	        ', labelDy=' + (s.labelDy ?? 'n/a') +
	        ', maxLabelAnchorDelta=' + (s.maxLabelAnchorDelta ?? 'n/a') +
	        ', maxGuidanceLinePlayerDelta=' + (s.maxGuidanceLinePlayerDelta ?? 'n/a');
    }).join('; ');
    const modelAudit = await videoAudit.runVolcengineVideoAudit(finalVideoPath, {
      fps: process.env.BLUEPRINT_VOLC_VIDEO_AUDIT_FPS || 4,
      model: process.env.BLUEPRINT_VOLC_VIDEO_AUDIT_MODEL || process.env.DOUBAO_VIDEO_AUDIT_MODEL || process.env.DOUBAO_VIDEO_MODEL,
      maxDurationSeconds: process.env.BLUEPRINT_VOLC_VIDEO_AUDIT_MAX_SECONDS || 30,
      keepPreparedVideo: true,
      context: [
        'This is an automated mobile-touch recording of the playable ad.',
        'The test drags the virtual joystick with pointer input in this exact order: right, up, down, left.',
        'Audit Player movement continuity and whether visible entity labels stay above their entities during all four drags.',
        movementSummary ? ('Recorder measured Player movement and label anchoring: ' + movementSummary + '.') : '',
      ].join(' '),
    });
    result.volcengineVideoAudit = modelAudit;
    result.passed = modelAudit.passed === true;
    result.reason = modelAudit.passed ? 'storyboard video audit passed' : (modelAudit.summary || 'storyboard video audit failed');
  } catch(e) {
    result.passed = process.env.BLUEPRINT_VOLC_VIDEO_AUDIT_REQUIRED === '0';
    result.reason = 'storyboard video audit failed: ' + e.message;
    result.error = e.stack || e.message;
  } finally {
    try {
      fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
    } catch(e) {}
    if (browser) {
      try { await browser.close(); } catch(e) {}
    }
  }

  logger('[PlayableAgent] Storyboard video audit: ' + (result.passed ? 'PASS' : 'FAIL') + ' | ' + result.reason, taskId);
  return result;
}

async function runManualJoystickProbe(previewUrl, taskId, log) {
  const logger = typeof log === 'function' ? log : function() {};
  if (process.env.BLUEPRINT_SKIP_MANUAL_JOYSTICK_PROBE === '1') {
    return { passed: true, skipped: true, reason: 'skipped by BLUEPRINT_SKIP_MANUAL_JOYSTICK_PROBE' };
  }

  let chromium;
  try {
    chromium = require('playwright').chromium;
  } catch(e) {
    return { passed: false, skipped: false, reason: 'playwright unavailable for manual joystick probe: ' + e.message };
  }

  const outDir = path.join(CUA_RESULTS_DIR, taskId + '-manual-joystick-probe');
  try { fs.mkdirSync(outDir, { recursive: true }); } catch(e) {}
  const result = { passed: false, skipped: false, url: previewUrl, outDir, samples: [], logs: [] };
  let browser = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-web-security']
    });
    const context = await browser.newContext({
      viewport: { width: 540, height: 960 },
      deviceScaleFactor: 2,
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    page.on('console', msg => {
      const type = msg.type();
      const text = msg.text();
      if (type === 'error' || type === 'warning' || text.indexOf('__PHASE') >= 0) {
        result.logs.push({ type, text: text.slice(0, 500) });
      }
    });
    page.on('pageerror', err => {
      result.logs.push({ type: 'pageerror', text: String(err).slice(0, 500) });
    });

    await page.goto(previewUrl, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(8000);

    async function sample(label) {
      return page.evaluate((sampleLabel) => {
        let gs = null;
        try { gs = typeof window.__gameState === 'function' ? window.__gameState() : window.__gameState; } catch(e) { gs = { error: String(e) }; }
        const stick = document.getElementById('bp-storyboard-stick');
        const knob = document.getElementById('bp-storyboard-knob');
        let joy = null;
        try {
          if (window.GFM_Joystick && window.GFM_Joystick.instance) {
            const j = window.GFM_Joystick.instance;
            joy = {
              dragging: !!j._dragging,
              input: j._input ? { x: j._input.x, y: j._input.y } : null,
              h: j.Horizontal,
              v: j.Vertical,
            };
          }
        } catch(e) { joy = { error: String(e) }; }
        let runtimePlayer = null;
        let manualJoystickOverride = null;
        try {
          const o = window.__bpManualJoystickOverride;
          if (o) {
            manualJoystickOverride = {
              active: !!o.active,
              x: Number(o.x) || 0,
              y: Number(o.y) || 0,
              updatedAt: Number(o.updatedAt) || 0,
            };
          }
        } catch(e) { manualJoystickOverride = null; }
        try {
          if (window.GFM_Player) {
            const p = window.GFM_Player.Instance;
            const go = p && p.Go;
            const pos = go && go.transform && go.transform.position;
            runtimePlayer = pos ? { x: pos.x, y: pos.y, z: pos.z } : null;
          }
        } catch(e) { runtimePlayer = null; }
        return {
          label: sampleLabel,
          currentPhase: gs && gs.currentPhase,
          completedPhases: gs && gs.completedPhases,
          playerState: gs && gs.entityStates && (gs.entityStates.player || gs.entityStates.Player),
          runtimePlayer,
          domStick: stick ? {
            className: stick.className,
            opacity: getComputedStyle(stick).opacity,
            knobTransform: knob && knob.style.transform
          } : null,
          manualJoystickOverride,
          joy,
        };
      }, label);
    }

    result.samples.push(await sample('before'));
    await page.mouse.move(90, 750);
    await page.mouse.down();
    for (let i = 1; i <= 20; i++) {
      const x = 90 + (150 - 90) * i / 20;
      const y = 750 + (690 - 750) * i / 20;
      await page.mouse.move(x, y);
      await page.waitForTimeout(40);
    }
    await page.waitForTimeout(1200);
    result.samples.push(await sample('during-mouse-hold'));
    await page.mouse.up();
    await page.waitForTimeout(500);

    result.samples.push(await sample('before-touch'));
    const touchMode = String(process.env.BLUEPRINT_MANUAL_JOYSTICK_PROBE_TOUCH_MODE || 'dom-pointer').toLowerCase();
    if (touchMode === 'cdp') {
      const client = await withTimeout(context.newCDPSession(page), 10000, 'manual joystick touch CDP session');
      await withTimeout(client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 90, y: 750, id: 0, radiusX: 10, radiusY: 10 }] }), 5000, 'manual joystick touchStart');
      for (let i = 1; i <= 15; i++) {
        const x = Math.round(90 + (150 - 90) * i / 15);
        const y = Math.round(750 + (690 - 750) * i / 15);
        await withTimeout(client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id: 0, radiusX: 10, radiusY: 10 }] }), 5000, 'manual joystick touchMove');
        await page.waitForTimeout(40);
      }
      await page.waitForTimeout(1200);
      result.samples.push(await sample('during-touch-hold'));
      await withTimeout(client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }), 5000, 'manual joystick touchEnd');
    } else {
      async function emitTouchPointer(type, x, y, buttons) {
        await withTimeout(page.evaluate((args) => {
          function pointer(typeName, px, py, btns) {
            if (typeof PointerEvent === 'function') {
              return new PointerEvent(typeName, {
                bubbles: true,
                cancelable: true,
                clientX: px,
                clientY: py,
                screenX: px,
                screenY: py,
                button: 0,
                buttons: btns,
                pointerId: 23,
                pointerType: 'touch',
                isPrimary: true,
              });
            }
            return new MouseEvent(typeName.replace(/^pointer/, 'mouse'), {
              bubbles: true,
              cancelable: true,
              clientX: px,
              clientY: py,
              screenX: px,
              screenY: py,
              button: 0,
              buttons: btns,
            });
          }
          const hit = document.elementFromPoint(args.x, args.y);
          const targets = [hit, document, window].filter(Boolean);
          for (const target of targets) {
            try { target.dispatchEvent(pointer(args.type, args.x, args.y, args.buttons)); } catch(e) {}
          }
        }, { type, x, y, buttons }), 5000, 'manual joystick dom touch ' + type);
      }
      await emitTouchPointer('pointerdown', 90, 750, 1);
      for (let i = 1; i <= 15; i++) {
        const x = Math.round(90 + (150 - 90) * i / 15);
        const y = Math.round(750 + (690 - 750) * i / 15);
        await emitTouchPointer('pointermove', x, y, 1);
        await page.waitForTimeout(40);
      }
      await page.waitForTimeout(1200);
      result.samples.push(await sample('during-touch-hold'));
      await emitTouchPointer('pointerup', 150, 690, 0);
    }

    Object.assign(result, evaluateManualJoystickProbeResult(result));
  } catch(e) {
    result.passed = false;
    result.reason = 'manual joystick probe failed: ' + e.message;
  } finally {
    try {
      fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
    } catch(e) {}
    if (browser) {
      try { await browser.close(); } catch(e) {}
    }
  }

  logger('[PlayableAgent] Manual joystick probe: ' + (result.passed ? 'PASS' : 'FAIL') +
    ' | maxInput=' + (result.maxInput || 0) +
    ' | maxPlayerDistance=' + (result.maxPlayerDistance || 0) +
    ' | ' + result.reason, taskId);
  return result;
}

async function runManualJoystickFlowProbe(previewUrl, blueprint, taskId, log, options) {
  const logger = typeof log === 'function' ? log : function() {};
  const phaseWindow = selectManualJoystickPhaseWindow(blueprint, options || {});
  const phaseIds = phaseWindow.phaseIds;
  const phaseTargets = phaseWindow.phaseTargets;
  if (phaseWindow.checkpointError) {
    return {
      passed: false,
      skipped: false,
      reason: 'manual joystick checkpoint unavailable: ' + phaseWindow.checkpointError,
      targetCompleted: 0,
      checkpoint: phaseWindow,
    };
  }
  if (process.env.BLUEPRINT_SKIP_MANUAL_JOYSTICK_FLOW_PROBE === '1') {
    return { passed: true, skipped: true, reason: 'skipped by BLUEPRINT_SKIP_MANUAL_JOYSTICK_FLOW_PROBE', targetCompleted: phaseIds.length };
  }
  if (phaseIds.length <= 0) {
    return { passed: false, skipped: false, reason: 'no phase path available for manual joystick flow probe', targetCompleted: 0 };
  }
  if (phaseIds.length <= 1 && !phaseWindow.checkpointMode) {
    return { passed: true, skipped: true, reason: 'single-phase playable does not require manual joystick flow probe', targetCompleted: phaseIds.length };
  }

  let chromium;
  try {
    chromium = require('playwright').chromium;
  } catch(e) {
    return { passed: false, skipped: false, reason: 'playwright unavailable for manual joystick flow probe: ' + e.message, targetCompleted: phaseIds.length };
  }

  const outDir = path.join(CUA_RESULTS_DIR, taskId + (phaseWindow.checkpointMode
    ? '-manual-joystick-checkpoint-' + safeRunId(phaseWindow.checkpointPhase || phaseWindow.checkpointPhaseInput)
    : '-manual-joystick-flow-probe'));
  try { fs.mkdirSync(outDir, { recursive: true }); } catch(e) {}
  const flowBudget = computeManualJoystickFlowBudget(phaseIds.length, process.env);
  const deadlineMs = flowBudget.windowMs;
  const maxDrags = flowBudget.maxDrags;
  const result = {
    passed: false,
    skipped: false,
    url: previewUrl,
    outDir,
    flowBudget,
    windowMs: deadlineMs,
    maxDrags,
    targetCompleted: phaseIds.length,
    phaseIds,
    phaseTargets,
    fullPhaseIds: phaseWindow.fullPhaseIds,
    samples: [],
    actions: [],
    logs: [],
  };
  if (phaseWindow.checkpointMode) {
    result.checkpoint = {
      debugOnly: true,
      requestedPhase: phaseWindow.checkpointPhaseInput,
      phase: phaseWindow.checkpointPhase,
      index: phaseWindow.checkpointPhaseIndex,
      maxPhases: phaseWindow.maxPhases,
      applied: false,
      driveResult: null,
    };
  }
  let browser = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-web-security']
    });
    const context = await browser.newContext({
      viewport: { width: 540, height: 960 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    page.on('console', msg => {
      const type = msg.type();
      const text = msg.text();
      if (type === 'error' || type === 'warning' || text.indexOf('__PHASE') >= 0) {
        result.logs.push({ type, text: text.slice(0, 500) });
      }
    });
    page.on('pageerror', err => {
      result.logs.push({ type: 'pageerror', text: String(err).slice(0, 500) });
    });

    await page.goto(previewUrl, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(8000);
    await page.waitForFunction(() => {
      return !!window.__gameState || typeof window.__getGameState === 'function' || !!window.GFM_Player;
    }, null, { timeout: 20000 }).catch(() => null);

    if (phaseWindow.checkpointMode) {
      const checkpointDrive = await withTimeout(page.evaluate(async (phase) => {
        if (typeof window.__driveToPhase !== 'function') throw new Error('__driveToPhase unavailable');
        const driveResult = await window.__driveToPhase(phase);
        let state = null;
        try {
          state = typeof window.__getGameState === 'function' ? window.__getGameState() : window.__gameState;
        } catch(e) {}
        return {
          driveResult,
          currentPhase: state && (state.currentPhase || state.phase) || '',
          completedPhases: state && (state.completedPhases || state.completed) || [],
        };
      }, phaseWindow.checkpointPhase || phaseWindow.checkpointPhaseInput), 20000, 'manual joystick checkpoint driveToPhase');
      result.checkpoint.applied = true;
      result.checkpoint.driveResult = checkpointDrive && checkpointDrive.driveResult || checkpointDrive;
      result.checkpoint.currentPhase = checkpointDrive && checkpointDrive.currentPhase || '';
      result.checkpoint.completedPhases = checkpointDrive && checkpointDrive.completedPhases || [];
      await page.waitForTimeout(1000);
    }

    const flowTouchMode = String(process.env.BLUEPRINT_MANUAL_JOYSTICK_FLOW_TOUCH_MODE || 'dom-pointer').toLowerCase();
    result.inputMode = flowTouchMode;
    const client = flowTouchMode === 'cdp'
      ? await withTimeout(context.newCDPSession(page), 10000, 'manual joystick flow CDP session')
      : null;
    const flowDriver = String(process.env.BLUEPRINT_MANUAL_JOYSTICK_FLOW_DRIVER || 'autonav').toLowerCase() === 'legacy-drag'
      ? 'legacy-drag'
      : 'autonav-joystick';
    result.driver = flowDriver;

    async function installPhaseWitness(label) {
      return page.evaluate((args) => {
        function nowMs() {
          try {
            if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') return performance.now();
          } catch(e) {}
          return Date.now ? Date.now() : (new Date()).getTime();
        }
        function norm(value) {
          return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        }
        function getState() {
          let gs = null;
          try { gs = typeof window.__gameState === 'function' ? window.__gameState() : window.__gameState; } catch(e) {}
          try { if (!gs && typeof window.__getGameState === 'function') gs = window.__getGameState(); } catch(e2) {}
          try {
            if (gs && typeof window.__blueprintNormalizeGameState === 'function') gs = window.__blueprintNormalizeGameState(gs, gs.currentPhase || gs.phase || null);
          } catch(e3) {}
          return gs || {};
        }
        function countCompleted(gs) {
          const phaseKeys = {};
          (args.phaseIds || []).forEach((id) => { phaseKeys[norm(id)] = true; });
          const completed = gs.completedPhases || gs.completed || [];
          if (Array.isArray(completed)) {
            const seen = {};
            completed.forEach((id) => {
              const key = norm(id);
              if (phaseKeys[key]) seen[key] = true;
            });
            return Object.keys(seen).length;
          }
          const numeric = Number(gs.completedPhaseCount || gs.phaseCompletedCount || 0);
          return Number.isFinite(numeric) ? numeric : 0;
        }
        try {
          if (window.__bpCuaPhaseWitness && typeof window.__bpCuaPhaseWitness.stop === 'function') {
            window.__bpCuaPhaseWitness.stop();
          }
        } catch(eStop) {}
        const expected = Array.isArray(args.phaseIds) ? args.phaseIds.map(String) : [];
        const expectedKeys = {};
        expected.forEach((id) => { expectedKeys[norm(id)] = true; });
        const witness = {
          schemaVersion: 'blueprint-cua-phase-witness.v1',
          label: args.label || '',
          expectedPhasePath: expected,
          startedAt: nowMs(),
          path: [],
          completedPath: [],
          events: [],
          completedEvents: [],
          tickCount: 0,
          stopped: false,
          _seen: {},
          _completedSeen: {},
          _lastPhase: '',
          _raf: 0,
        };
        function isTerminalPhase(phase) {
          return /gameend|cta|finish|complete|download|install/i.test(String(phase || ''));
        }
        function record(phase, source, gs) {
          const text = String(phase || '');
          const key = norm(text);
          if (!text || (!expectedKeys[key] && !isTerminalPhase(text))) return;
          const completedCount = countCompleted(gs || {});
          if (!witness._seen[key]) {
            witness._seen[key] = true;
            witness.path.push(text);
          }
          if (text !== witness._lastPhase) {
            witness._lastPhase = text;
            witness.events.push({
              t: Number((nowMs() - witness.startedAt).toFixed(1)),
              phase: text,
              source: source || 'currentPhase',
              completedCount,
            });
            if (witness.events.length > 600) witness.events.shift();
          }
        }
        function recordCompleted(gs) {
          const completed = gs && (gs.completedPhases || gs.completed) || [];
          if (!Array.isArray(completed) || completed.length === 0) return;
          const completedKeys = {};
          completed.forEach((id) => { completedKeys[norm(id)] = true; });
          const completedCount = countCompleted(gs || {});
          expected.forEach((phase) => {
            const key = norm(phase);
            if (!completedKeys[key] || witness._completedSeen[key]) return;
            witness._completedSeen[key] = true;
            witness.completedPath.push(phase);
            witness.completedEvents.push({
              t: Number((nowMs() - witness.startedAt).toFixed(1)),
              phase,
              source: 'completedPhases',
              completedCount,
            });
            if (witness.completedEvents.length > 600) witness.completedEvents.shift();
          });
        }
        function tick() {
          if (witness.stopped) return;
          witness.tickCount++;
          const gs = getState();
          record(gs.currentPhase || gs.phase || '', 'currentPhase', gs);
          recordCompleted(gs);
          witness._raf = requestAnimationFrame(tick);
        }
        witness.stop = function() {
          witness.stopped = true;
          try { if (witness._raf) cancelAnimationFrame(witness._raf); } catch(eCancel) {}
        };
        window.__bpCuaPhaseWitness = witness;
        tick();
        return { installed: true, schemaVersion: witness.schemaVersion, expectedPhasePath: expected };
      }, { phaseIds, label });
    }

    async function readPhaseWitness(label) {
      try {
        return await page.evaluate((sampleLabel) => {
          const w = window.__bpCuaPhaseWitness || {};
          return {
            schemaVersion: w.schemaVersion || 'blueprint-cua-phase-witness.v1',
            label: sampleLabel || '',
            expectedPhasePath: Array.isArray(w.expectedPhasePath) ? w.expectedPhasePath.slice() : [],
            path: Array.isArray(w.path) ? w.path.slice() : [],
            completedPath: Array.isArray(w.completedPath) ? w.completedPath.slice() : [],
            events: Array.isArray(w.events) ? w.events.slice() : [],
            completedEvents: Array.isArray(w.completedEvents) ? w.completedEvents.slice() : [],
            tickCount: Number(w.tickCount || 0),
            stopped: w.stopped === true,
          };
        }, label || '');
      } catch(e) {
        return {
          schemaVersion: 'blueprint-cua-phase-witness.v1',
          label: label || '',
          path: [],
          events: [],
          error: e && e.message ? e.message : String(e),
        };
      }
    }
    await installPhaseWitness(phaseWindow.checkpointMode ? 'checkpoint-flow-start' : 'full-flow-start');

    async function sample(label) {
      return page.evaluate((args) => {
        function norm(value) {
          return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        }
        function roundPos(pos) {
          if (!pos) return null;
          const x = Number(pos.x);
          const y = Number(pos.y || 0);
          const z = Number(pos.z);
          if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
          return { x: Number(x.toFixed(3)), y: Number(y.toFixed(3)), z: Number(z.toFixed(3)) };
        }
        function isVisibleWorldPos(pos) {
          if (!pos) return false;
          const x = Number(pos.x);
          const y = Number(pos.y || 0);
          const z = Number(pos.z);
          return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) &&
            y > -100 && Math.abs(x) < 10000 && Math.abs(z) < 10000;
        }
        function roundRect(rect) {
          if (!rect) return null;
          const x = Number(rect.x_px != null ? rect.x_px : rect.x);
          const y = Number(rect.y_px != null ? rect.y_px : rect.y);
          const w = Number(rect.w_px != null ? rect.w_px : rect.width);
          const h = Number(rect.h_px != null ? rect.h_px : rect.height);
          if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
          return { x: Number(x.toFixed(2)), y: Number(y.toFixed(2)), w: Number(w.toFixed(2)), h: Number(h.toFixed(2)), cx: Number((x + w / 2).toFixed(2)), cy: Number((y + h / 2).toFixed(2)) };
        }
        function getState() {
          let gs = null;
          try { gs = typeof window.__gameState === 'function' ? window.__gameState() : window.__gameState; } catch(e) {}
          try { if (!gs && typeof window.__getGameState === 'function') gs = window.__getGameState(); } catch(e2) {}
          try {
            if (gs && typeof window.__blueprintNormalizeGameState === 'function') gs = window.__blueprintNormalizeGameState(gs, gs.currentPhase || gs.phase || null);
          } catch(e3) {}
          return gs || {};
        }
        function entityStates(gs) {
          return gs.entityStates || gs.entity_states || {};
        }
        function findEntityState(gs, name) {
          const states = entityStates(gs);
          if (!states || !name) return null;
          if (states[name]) return states[name];
          const key = norm(name);
          const names = Object.keys(states);
          for (const item of names) {
            if (norm(item) === key) return states[item];
          }
          return null;
        }
        function entityRootPos(name) {
          try {
            const roots = window.__storyboardEntityRoots || {};
            const root = roots[name] || roots[String(name || '').replace(/^_+/, '')] || roots[norm(name)];
            const p = root && root.getPosition && root.getPosition();
            return roundPos(p);
          } catch(e) { return null; }
        }
        function stateEntityPos(gs, name) {
          const st = findEntityState(gs, name);
          return roundPos(st && st.position);
        }
        function runtimePlayerPos() {
          try {
            const p = window.GFM_Player && (window.GFM_Player.Instance || window.GFM_Player.instance || window.GFM_Player._instance);
            const go = p && (p.Go || p.go || p._player);
            const pos = go && go.transform && go.transform.position;
            return roundPos(pos);
          } catch(e) { return null; }
        }
        function targetRect(name) {
          try {
            if (!name || typeof window.__storyboardEntityScreenRect !== 'function') return null;
            return roundRect(window.__storyboardEntityScreenRect(name));
          } catch(e) { return null; }
        }
        function countCompleted(gs) {
          const phaseKeys = {};
          (args.phaseIds || []).forEach((id) => { phaseKeys[norm(id)] = true; });
          const completed = gs.completedPhases || gs.completed || [];
          if (Array.isArray(completed)) {
            const seen = {};
            completed.forEach((id) => {
              const key = norm(id);
              if (phaseKeys[key]) seen[key] = true;
            });
            return Object.keys(seen).length;
          }
          if (completed && typeof completed === 'object') {
            let total = 0;
            Object.keys(completed).forEach((id) => {
              if (completed[id] && phaseKeys[norm(id)]) total++;
            });
            return total;
          }
          const numeric = Number(gs.completedPhaseCount || gs.phaseCompletedCount || 0);
          return Number.isFinite(numeric) ? numeric : 0;
        }
        function targetNameForState(gs, line, phase) {
          const plannedTarget = args.phaseTargets && args.phaseTargets[norm(phase)];
          const ui = gs.uiState || gs.ui_state || {};
          const runtimeTarget = ui.highlightTarget ||
            ui.highlightOverlay && ui.highlightOverlay.target ||
            ui.highlightState && ui.highlightState.target ||
            ui.targetEntity ||
            gs.targetEntity ||
            gs.variables && gs.variables.targetEntity ||
            '';
          const lineTarget = line && line.targetName || '';
          return runtimeTarget || lineTarget || plannedTarget || '';
        }
        function choosePosition(candidates) {
          for (const item of candidates) {
            if (item && isVisibleWorldPos(item.pos)) return item;
          }
          return { pos: null, source: '' };
        }
        const gs = getState();
        const line = window.__storyboardGuidanceLineState || null;
        const phase = String(gs.currentPhase || gs.phase || '');
        const linePlayerPos = roundPos(line && line.player);
        const runtimePlayer = runtimePlayerPos();
        const statePlayer = stateEntityPos(gs, 'Player') || stateEntityPos(gs, 'player');
        const rootPlayer = entityRootPos('Player');
        const playerChoice = choosePosition([
          { pos: runtimePlayer, source: 'runtime-player' },
          { pos: statePlayer, source: 'state-player' },
          { pos: linePlayerPos, source: 'overlay-guidance-player' },
          { pos: rootPlayer, source: 'overlay-root-player' },
        ]);
        const playerPos = playerChoice.pos;
        const targetName = targetNameForState(gs, line, phase);
        const targetFromGuidanceLine = line && line.targetName && norm(line.targetName) === norm(targetName);
        const lineTargetPos = targetFromGuidanceLine ? roundPos(line && line.target) : null;
        const stateTarget = stateEntityPos(gs, targetName);
        const rootTarget = entityRootPos(targetName);
        const targetChoice = choosePosition([
          { pos: lineTargetPos, source: 'overlay-guidance-target' },
          { pos: rootTarget, source: 'overlay-root-target' },
          { pos: stateTarget, source: 'state-target' },
        ]);
        const targetPos = targetChoice.pos;
        const rect = targetRect(targetName);
        let distanceToTarget = null;
        if (playerPos && targetPos) {
          const dx = targetPos.x - playerPos.x;
          const dz = targetPos.z - playerPos.z;
          distanceToTarget = Number(Math.sqrt(dx * dx + dz * dz).toFixed(4));
        }
        const completedCount = countCompleted(gs);
        const terminal = /gameend|cta|finish|complete|download|install/i.test(phase) || completedCount >= (args.phaseIds || []).length;
        return {
          label: args.label,
          currentPhase: phase,
          completedPhases: gs.completedPhases || gs.completed || [],
          completedCount,
          targetCompleted: (args.phaseIds || []).length,
          isTerminal: terminal,
          playerPos,
          playerPosSource: playerChoice.source,
          targetName,
          plannedTargetName: args.phaseTargets && args.phaseTargets[norm(phase)] || '',
          targetPos,
          targetPosSource: targetChoice.source,
          runtimePlayerPos: runtimePlayer,
          statePlayerPos: statePlayer,
          stateTargetPos: stateTarget,
          overlayPlayerPos: linePlayerPos || rootPlayer,
          overlayTargetPos: lineTargetPos || rootTarget,
          targetRect: rect,
          distanceToTarget,
        };
      }, { label, phaseIds, phaseTargets });
    }

    function sampleComplete(row) {
      return !!(row && (row.isTerminal === true || Number(row.completedCount || 0) >= phaseIds.length));
    }

    function canTapFinalTarget(row) {
      const label = String((row && row.targetName) || '') + ' ' + String((row && row.currentPhase) || '');
      return /cta|button|download|install|finish|complete/i.test(label);
    }

    function directionFromSample(row, idx) {
      if (row && row.playerPos && row.targetPos) {
        const dx = Number(row.targetPos.x) - Number(row.playerPos.x);
        const dz = Number(row.targetPos.z) - Number(row.playerPos.z);
        const mag = Math.sqrt(dx * dx + dz * dz);
        // Runtime joystick drag follows world X/Z direction; samples prefer Luna/GFM state over the source overlay.
        if (mag > 0.05) {
          const defaultHoldMs = mag > 10 ? 6800 : (mag > 6 ? 5200 : (mag > 3 ? 3400 : 1500));
          const holdMs = Math.max(500, Math.min(9000, Number(process.env.BLUEPRINT_MANUAL_JOYSTICK_FLOW_HOLD_MS || defaultHoldMs) || defaultHoldMs));
          return { x: dx / mag, y: dz / mag, source: row.targetPosSource || 'target', distance: mag, holdMs };
        }
      }
      const fallback = [
        { x: 1, y: 0, source: 'scan-right' },
        { x: 0, y: 1, source: 'scan-down' },
        { x: -1, y: 0, source: 'scan-left' },
        { x: 0, y: -1, source: 'scan-up' },
      ];
      return fallback[idx % fallback.length];
    }

    async function emitFlowDomPointer(type, x, y, buttons, label, pointerId) {
      await withTimeout(page.evaluate((args) => {
        function makeEvent(typeName, px, py, btns) {
          if (typeof PointerEvent === 'function') {
            return new PointerEvent(typeName, {
              bubbles: true,
              cancelable: true,
              clientX: px,
              clientY: py,
              screenX: px,
              screenY: py,
              button: 0,
              buttons: btns,
              pointerId: args.pointerId,
              pointerType: 'touch',
              isPrimary: true,
            });
          }
          return new MouseEvent(typeName.replace(/^pointer/, 'mouse'), {
            bubbles: true,
            cancelable: true,
            clientX: px,
            clientY: py,
            screenX: px,
            screenY: py,
            button: 0,
            buttons: btns,
          });
        }
        const hit = document.elementFromPoint(args.x, args.y);
        const targets = [hit, document, window].filter(Boolean);
        for (const target of targets) {
          try { target.dispatchEvent(makeEvent(args.type, args.x, args.y, args.buttons)); } catch(e) {}
        }
      }, { type, x, y, buttons, pointerId }), 5000, 'manual joystick flow dom pointer ' + label + ' ' + type);
    }

    async function waitWithFlowSamples(label, holdMs) {
      const intervalMs = Math.max(250, Math.min(1500, Number(process.env.BLUEPRINT_MANUAL_JOYSTICK_FLOW_SAMPLE_INTERVAL_MS || 750) || 750));
      let elapsed = 0;
      let sampleIndex = 0;
      while (elapsed < holdMs) {
        const waitMs = Math.min(intervalMs, holdMs - elapsed);
        await page.waitForTimeout(waitMs);
        elapsed += waitMs;
        if (holdMs >= intervalMs) {
          const during = await sample('during-' + label + '-' + sampleIndex);
          result.samples.push(during);
          sampleIndex++;
        }
      }
      return { intervalMs, sampleCount: sampleIndex };
    }

    async function dragJoystick(dir, label) {
      const originX = Number(process.env.BLUEPRINT_MANUAL_JOYSTICK_FLOW_ORIGIN_X || 90);
      const originY = Number(process.env.BLUEPRINT_MANUAL_JOYSTICK_FLOW_ORIGIN_Y || 750);
      const radius = Number(process.env.BLUEPRINT_MANUAL_JOYSTICK_FLOW_RADIUS || 78);
      const endX = Math.round(originX + Math.max(-1, Math.min(1, dir.x)) * radius);
      const endY = Math.round(originY + Math.max(-1, Math.min(1, dir.y)) * radius);
      const touchId = 7;
      const holdMs = Math.max(250, Math.min(10000, Number(dir.holdMs || process.env.BLUEPRINT_MANUAL_JOYSTICK_FLOW_HOLD_MS || 1300) || 1300));
      if (flowTouchMode === 'cdp') {
        await withTimeout(client.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x: originX, y: originY, id: touchId, radiusX: 10, radiusY: 10 }],
        }), 5000, 'manual joystick flow touchStart ' + label);
        for (let i = 1; i <= 12; i++) {
          const x = Math.round(originX + (endX - originX) * i / 12);
          const y = Math.round(originY + (endY - originY) * i / 12);
          await withTimeout(client.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ x, y, id: touchId, radiusX: 10, radiusY: 10 }],
          }), 5000, 'manual joystick flow touchMove ' + label);
          await page.waitForTimeout(55);
        }
        var holdSampling = await waitWithFlowSamples(label, holdMs);
        await withTimeout(client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }), 5000, 'manual joystick flow touchEnd ' + label);
      } else {
        await emitFlowDomPointer('pointerdown', originX, originY, 1, label, touchId);
        for (let i = 1; i <= 12; i++) {
          const x = Math.round(originX + (endX - originX) * i / 12);
          const y = Math.round(originY + (endY - originY) * i / 12);
          await emitFlowDomPointer('pointermove', x, y, 1, label, touchId);
          await page.waitForTimeout(55);
        }
        var holdSampling = await waitWithFlowSamples(label, holdMs);
        await emitFlowDomPointer('pointerup', endX, endY, 0, label, touchId);
      }
      await page.waitForTimeout(220);
      return {
        type: 'drag',
        label,
        inputMode: flowTouchMode,
        direction: { x: Number(dir.x.toFixed(3)), y: Number(dir.y.toFixed(3)), source: dir.source || 'target' },
        holdMs,
        holdSampleCount: holdSampling ? holdSampling.sampleCount : 0,
        holdSampleIntervalMs: holdSampling ? holdSampling.intervalMs : 0,
        distanceBefore: Number.isFinite(Number(dir.distance)) ? Number(Number(dir.distance).toFixed(4)) : null,
      };
    }

    async function applyAutoNavJoystick(dir, active, label) {
      await withTimeout(page.evaluate((args) => {
        function nowMs() {
          try {
            if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') return performance.now();
          } catch(e) {}
          return Date.now ? Date.now() : (new Date()).getTime();
        }
        let x = Number(args.x) || 0;
        let y = Number(args.y) || 0;
        const mag = Math.sqrt(x * x + y * y);
        if (mag > 1) {
          x /= mag;
          y /= mag;
        }
        const override = window.__bpManualJoystickOverride || { active: false, x: 0, y: 0, updatedAt: 0, speed: 6 };
        override.active = !!args.active;
        override.x = override.active ? x : 0;
        override.y = override.active ? y : 0;
        override.updatedAt = nowMs();
        override.speed = Number(args.speed) || 6;
        override.source = 'cua-autonav-joystick';
        override.label = args.label || '';
        window.__bpManualJoystickOverride = override;
        try {
          const joystickClass = window.GFM_Joystick;
          const joystick = joystickClass && (joystickClass.instance || joystickClass.Instance);
          if (joystick && joystick._input) {
            joystick._dragging = override.active;
            joystick._input.x = override.x;
            joystick._input.y = override.y;
          }
        } catch(eJoystick) {}
      }, {
        x: dir && dir.x,
        y: dir && dir.y,
        active: active === true,
        speed: Number(process.env.BLUEPRINT_MANUAL_JOYSTICK_AUTONAV_SPEED || 6) || 6,
        label,
      }), 5000, 'manual joystick autonav override ' + label);
    }

    async function autoNavJoystick(row, label) {
      const intervalMs = Math.max(80, Math.min(500, Number(process.env.BLUEPRINT_MANUAL_JOYSTICK_AUTONAV_INTERVAL_MS || 160) || 160));
      const speed = Math.max(1, Number(process.env.BLUEPRINT_MANUAL_JOYSTICK_AUTONAV_SPEED || 6) || 6);
      const distanceBefore = Number(row && row.distanceToTarget);
      const estimatedTravelMs = Number.isFinite(distanceBefore) && distanceBefore > 0
        ? Math.ceil(distanceBefore / speed * 1000 + 500)
        : 1200;
      const maxHoldMs = Math.max(500, Math.min(4500, Number(process.env.BLUEPRINT_MANUAL_JOYSTICK_AUTONAV_MAX_HOLD_MS || estimatedTravelMs) || estimatedTravelMs));
      const startCompleted = Number(row && row.completedCount || 0);
      const startPhase = String(row && row.currentPhase || '');
      let latest = row;
      let elapsed = 0;
      let sampleCount = 0;
      let lastDir = directionFromSample(latest, sampleCount);
      try {
        while (elapsed < maxHoldMs && Date.now() < deadlineAt) {
          lastDir = directionFromSample(latest || row, sampleCount);
          await applyAutoNavJoystick({ x: -lastDir.x, y: -lastDir.y }, true, label);
          await page.waitForTimeout(intervalMs);
          elapsed += intervalMs;
          const during = await sample('during-' + label + '-' + sampleCount);
          result.samples.push(during);
          latest = during;
          sampleCount++;
          if (sampleComplete(latest)) break;
          const completedNow = Number(latest && latest.completedCount || 0);
          const phaseNow = String(latest && latest.currentPhase || '');
          if (completedNow > startCompleted || (phaseNow && startPhase && phaseNow !== startPhase)) break;
          if (Number.isFinite(Number(latest && latest.distanceToTarget)) && Number(latest.distanceToTarget) <= arrivalRange) break;
        }
      } finally {
        await applyAutoNavJoystick({ x: 0, y: 0 }, false, label + '-stop').catch(() => null);
      }
      await page.waitForTimeout(80);
      return {
        type: 'autonav_joystick',
        label,
        inputMode: 'runtime-joystick-override',
        direction: lastDir ? { x: Number(lastDir.x.toFixed(3)), y: Number(lastDir.y.toFixed(3)), source: lastDir.source || 'target' } : null,
        holdMs: elapsed,
        holdSampleCount: sampleCount,
        holdSampleIntervalMs: intervalMs,
        distanceBefore: Number.isFinite(distanceBefore) ? Number(distanceBefore.toFixed(4)) : null,
      };
    }

    async function tapTarget(row, label) {
      if (!row || !row.targetRect) return null;
      const x = Math.round(row.targetRect.cx);
      const y = Math.round(row.targetRect.cy);
      const touchId = 8;
      await withTimeout(page.evaluate(({ x, y }) => {
        try {
          if (typeof window.__bpApplyManualClickOverride === 'function') {
            window.__bpApplyManualClickOverride(x, y);
          } else {
            const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            window.__bpManualClickOverride = { pending: true, x, y, updatedAt: now, until: now + 220 };
          }
        } catch(e) {}
      }, { x, y }), 5000, 'manual joystick flow runtime click override ' + label);
      if (flowTouchMode === 'cdp') {
        await withTimeout(client.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x, y, id: touchId, radiusX: 9, radiusY: 9 }],
        }), 5000, 'manual joystick flow tapStart ' + label);
        await page.waitForTimeout(90);
        await withTimeout(client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }), 5000, 'manual joystick flow tapEnd ' + label);
      } else {
        await withTimeout(page.mouse.move(x, y), 5000, 'manual joystick flow mouseMove tap ' + label);
        await withTimeout(page.mouse.down(), 5000, 'manual joystick flow mouseDown tap ' + label);
        await emitFlowDomPointer('pointerdown', x, y, 1, label, touchId);
        await page.waitForTimeout(90);
        await emitFlowDomPointer('pointerup', x, y, 0, label, touchId);
        await withTimeout(page.mouse.up(), 5000, 'manual joystick flow mouseUp tap ' + label);
      }
      await page.waitForTimeout(300);
      return { type: 'tap', label, targetName: row.targetName || '', inputMode: flowTouchMode, x, y };
    }

    let current = await sample('flow-start');
    result.samples.push(current);
    const deadlineAt = Date.now() + deadlineMs;
    let closeTargetTicks = 0;
    const arrivalRange = Math.max(1.2, Number(process.env.BLUEPRINT_MANUAL_JOYSTICK_FLOW_ARRIVAL_RANGE || 2.0) || 2.0);
    const maxFlowIterations = Math.max(maxDrags * 4, maxDrags + phaseIds.length * 24);
    let flowIterations = 0;
    for (let i = 0; i < maxFlowIterations && Date.now() < deadlineAt && !sampleComplete(current); i++, flowIterations++) {
      if (current && current.targetRect && canTapFinalTarget(current)) {
        const tapAction = await tapTarget(current, 'tap-final-' + i);
        if (tapAction) result.actions.push(tapAction);
        const tapped = await sample('after-final-tap-' + i);
        result.samples.push(tapped);
        current = tapped;
        if (sampleComplete(current)) break;
        await page.waitForTimeout(500);
        const waitedTap = await sample('after-final-tap-wait-' + i);
        result.samples.push(waitedTap);
        current = waitedTap;
        if (sampleComplete(current)) break;
      }
      const closeToTarget = current && Number.isFinite(Number(current.distanceToTarget)) && Number(current.distanceToTarget) <= arrivalRange;
      if (closeToTarget) {
        closeTargetTicks++;
        if (current.targetRect && canTapFinalTarget(current)) {
          const tapAction = await tapTarget(current, 'tap-' + i);
          if (tapAction) result.actions.push(tapAction);
          const tapped = await sample('after-tap-' + i);
          result.samples.push(tapped);
          current = tapped;
          if (sampleComplete(current)) break;
        }
        await page.waitForTimeout(closeTargetTicks >= 2 ? 900 : 500);
        const waited = await sample('after-close-wait-' + i);
        result.samples.push(waited);
        current = waited;
        if (sampleComplete(current)) break;
        if (closeTargetTicks < 2) continue;
      } else {
        closeTargetTicks = 0;
      }
      const currentDragCount = result.actions.filter(isManualJoystickFlowAction).length;
      if (currentDragCount >= maxDrags) break;
      const dir = directionFromSample(current, i);
      const action = flowDriver === 'legacy-drag'
        ? await dragJoystick(dir, 'drag-' + i)
        : await autoNavJoystick(current, 'autonav-' + i);
      result.actions.push(action);
      const after = await sample('after-drag-' + i);
      result.samples.push(after);
      current = after;
    }
    result.flowIterations = flowIterations;
    result.iterationBudgetReached = !sampleComplete(current) && flowIterations >= maxFlowIterations;
    result.dragCount = result.actions.filter(isManualJoystickFlowAction).length;
    result.deadlineReached = !sampleComplete(current) && Date.now() >= deadlineAt;
    result.dragBudgetReached = !sampleComplete(current) && result.dragCount >= maxDrags;
    result.phaseWitness = await readPhaseWitness('flow-end');
    Object.assign(result, evaluateManualJoystickFlowProbeResult(result));
  } catch(e) {
    result.passed = false;
    result.reason = 'manual joystick flow probe failed: ' + e.message;
    result.error = e.stack || e.message;
  } finally {
    try {
      fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
    } catch(e) {}
    if (browser) {
      try { await withTimeout(browser.close(), 15000, 'manual joystick flow browser close'); } catch(e) {}
    }
  }

  logger('[PlayableAgent] Manual joystick flow probe: ' + (result.passed ? 'PASS' : 'FAIL') +
    ' | completed=' + (result.completedAfter || 0) + '/' + (result.targetCompleted || 0) +
    ' | drags=' + (result.dragCount || 0) +
    ' | maxPlayerDistance=' + (result.maxPlayerDistance || 0) +
    ' | ' + result.reason, taskId);
  return result;
}

async function runManualJoystickCheckpointProbe(previewUrl, blueprint, taskId, log, checkpointPhase, maxPhases) {
  return runManualJoystickFlowProbe(previewUrl, blueprint, taskId, log, {
    checkpointPhase,
    maxPhases,
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

function readJsonIfExists(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch(e) {
    return null;
  }
}

function loadBlueprintProofBundle(buildDir, blueprint) {
  if (blueprint && blueprint.proofBundle && typeof blueprint.proofBundle === 'object') return blueprint.proofBundle;
  const explicit = blueprint && (blueprint.proofBundlePath || blueprint.blueprintProofBundlePath);
  const explicitBundle = explicit ? readJsonIfExists(explicit) : null;
  if (explicitBundle) return explicitBundle;
  return readJsonIfExists(path.join(buildDir, 'blueprint-proof-bundle.json'));
}

function attachBlueprintProofBundle(buildDir, blueprint, taskId, log) {
  const source = blueprint && typeof blueprint === 'object' ? blueprint : {};
  const specs = source.specs || readJsonIfExists(path.join(buildDir, 'blueprint-specs.json'));
  const plans = source.plans || readJsonIfExists(path.join(buildDir, 'blueprint-plans.json'));
  const visualAssets = source.visualAssets || readJsonIfExists(path.join(buildDir, 'blueprint-visual-assets.json'));
  const proofBundle = loadBlueprintProofBundle(buildDir, source);
  const next = Object.assign({}, source);
  if (specs) next.specs = specs;
  if (plans) next.plans = plans;
  if (visualAssets) next.visualAssets = visualAssets;
  if (proofBundle) next.proofBundle = proofBundle;
  const logger = typeof log === 'function' ? log : function() {};
  if (proofBundle) {
    const diff = proofBundle.contractDiff || {};
    logger('[PlayableAgent] Proof bundle loaded: phases=' + (proofBundle.phaseCount || (proofBundle.phases || []).length || 0) +
      ', contractBlocking=' + ((diff.summary && diff.summary.blocking) || (diff.blocking && diff.blocking.length) || 0), taskId);
  }
  if (specs || plans || visualAssets) {
    logger('[PlayableAgent] Blueprint sidecars loaded: specs=' + (specs ? 'yes' : 'no') +
      ', plans=' + (plans ? 'yes' : 'no') +
      ', visualAssets=' + (visualAssets ? 'yes' : 'no'), taskId);
  }
  return next;
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
  const planCoverageIssue = coverageReason(planCoverage, 'plan');
  if (planCoverageIssue) {
    report.passed = false;
    if (!report.exitReason) report.exitReason = 'plan_coverage_incomplete';
    issues.push(planCoverageIssue + ' — phase coverage alone is insufficient for approval.');
  }

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

  var autoplayZeroStepsSoftWarn = isAutoPlayMode
    && isFullCoverage(planCoverage)
    && isFullCoverage(signalCoverage)
    && signalValidationPassed
    && missingSignals.length === 0
    && hasHealthyObserveVisuals(report);
  if (autoplayZeroStepsSoftWarn && silentPassSignals.some(function(s) { return s.indexOf('autoplay-zero-steps') === 0; })) {
    logger('[PlayableAgent] autoplay-zero-steps downgraded to soft warn because plan/signal/visual observe coverage passed', taskId);
  }

  var hardBlockingSignals = silentPassSignals.filter(function(s) {
    if (s.indexOf('uniform-timing') === 0 && isAutoPlayMode) return false;
    if (s.indexOf('autoplay-zero-steps') === 0 && autoplayZeroStepsSoftWarn) return false;
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
  const telemetry = createCuaTelemetry({
    taskId,
    buildDir,
    buildMs: readBuildTelemetryMs(buildDir),
  });
  function finish(result) {
    return attachCuaTelemetry(result, telemetry);
  }

  // Check prerequisites
  if (!fs.existsSync(VERIFY_SCRIPT)) {
    log('[PlayableAgent] blueprint_verify.py not found — INFRA FAIL (not skipping)', taskId);
    return finish({ passed: false, issues: ['[playableagent-infra] blueprint_verify.py not found at ' + VERIFY_SCRIPT], skipped: true, error: 'VERIFY_SCRIPT missing' });
  }

  const hasIframe = fs.existsSync(path.join(buildDir, 'iframe.html'));
  const hasIndex = fs.existsSync(path.join(buildDir, 'index.html'));
  if (!hasIframe && !hasIndex) {
    log('[PlayableAgent] No HTML file in build output — FAIL', taskId);
    return finish({ passed: false, issues: ['[playableagent-infra] No HTML file (iframe.html or index.html) in build dir: ' + buildDir], skipped: true, error: 'No HTML file' });
  }

  const proofStartedAt = Date.now();
  blueprint = attachBlueprintProofBundle(buildDir, blueprint, taskId, log);
  telemetry.proofMs = Math.max(0, Date.now() - proofStartedAt);
  const proofDiff = blueprint && blueprint.proofBundle && blueprint.proofBundle.contractDiff || null;
  const proofBlocking = proofDiff && Array.isArray(proofDiff.blocking) ? proofDiff.blocking : [];
  if (proofBlocking.length > 0) {
    log('[PlayableAgent] Proof contract diff has blocking issues — FAIL before browser CUA', taskId);
    return finish({
      passed: false,
      issues: ['[proof-contract-diff] ' + JSON.stringify(proofBlocking.slice(0, 8))],
      skipped: false,
      proofBundle: blueprint.proofBundle,
      error: 'proof_contract_diff_failed'
    });
  }

  // Ensure Xvfb for WebGL
  if (!ensureXvfb()) {
    log('[PlayableAgent] Failed to start Xvfb — INFRA FAIL (not skipping)', taskId);
    return finish({ passed: false, issues: ['[playableagent-infra] Xvfb :99 could not be started'], skipped: true, error: 'Xvfb unavailable' });
  }

  // Determine complexity level for CUA speed adaptation
  const phaseCount = (
    (blueprint.plans && blueprint.plans.cuaPlan && Array.isArray(blueprint.plans.cuaPlan.steps) && blueprint.plans.cuaPlan.steps.length > 0)
      ? blueprint.plans.cuaPlan.steps.length
      : (blueprint.specs || blueprint.phases || []).length
  );
  const isHighComplexity = phaseCount > 8;
  const configuredSpeed = Number(process.env.BLUEPRINT_CUA_SPEED_MULTIPLIER || '');
  const speedMultiplier = Number.isFinite(configuredSpeed) && configuredSpeed > 0
    ? Math.max(1, Math.floor(configuredSpeed))
    : (isHighComplexity ? 1 : 5);
  _patchHighComplexity = isHighComplexity;

  // G1: dynamic outer kill-switch by phase count
  const verifyTimeoutMs = computeVerifyTimeoutMs(phaseCount);
  telemetry.phaseCount = phaseCount;
  telemetry.speedMultiplier = speedMultiplier;
  telemetry.verifyTimeoutMs = verifyTimeoutMs;

  if (isHighComplexity) {
    log('[PlayableAgent] High complexity detected (' + phaseCount + ' phases) — using ' + speedMultiplier + 'x speed, conservative timer gates', taskId);
  }
  log('[PlayableAgent] Starting PlayableAgent verification (VLM + __gameState, kill-switch ' + Math.round(verifyTimeoutMs/1000) + 's)...', taskId);

  // Start local server with headless patches
  let server;
  try {
    const serverStartedAt = Date.now();
    server = await startLocalServer(buildDir);
    telemetry.serverMs = Math.max(0, Date.now() - serverStartedAt);
  } catch(e) {
    log('[PlayableAgent] Failed to start server — INFRA FAIL: ' + e.message, taskId);
    return finish({ passed: false, issues: ['[playableagent-infra] Local HTTP server failed: ' + e.message], skipped: true, error: e.message });
  }

  const actualPort = server.address().port;
  log("[PlayableAgent] Local server on port " + actualPort, taskId);

  // AutoPlay mode: append ?autoplay=1 so the JS bridge creates __AUTOPLAY_ON__ entity
  const previewUrl = 'http://127.0.0.1:' + actualPort + '/' + (hasIframe ? 'iframe.html' : 'index.html') + '?autoplay=1';
  const manualProbeUrl = 'http://127.0.0.1:' + actualPort + '/' + (hasIframe ? 'iframe.html' : 'index.html') + '?manual=1&autoplay=0';

  // Write specs for Python
  const specsPath = writeSpecsFile(blueprint, taskId);
  const plansPath = writePlansFile(blueprint, taskId);
  if (plansPath) {
    log('[PlayableAgent] Assembly/CUA plans saved: ' + plansPath, taskId);
  }

  // Build Python command — observer mode (no VLM interaction, just watch autoPlay)
  const agentOutputDir = path.join('/root/cua-agent/runs', 'verify_' + safeRunId(taskId) + '_' + Date.now() + '_' + process.pid);
  try { fs.mkdirSync(agentOutputDir, { recursive: true }); } catch(e) {}

  const args = [VERIFY_SCRIPT, previewUrl, '--steps', '50', '--observe', '--output', agentOutputDir];
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
	      CUA_VERIFY_OUTPUT_DIR: agentOutputDir,
	    };

    log('[PlayableAgent] Running: ' + PYTHON + ' ' + args.join(' '), taskId);
    const verificationStartedAt = Date.now();
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

    child.on('close', async (code) => {
      clearTimeout(timeout);
      if (child.pid && process._activeChildPIDs) process._activeChildPIDs.delete(child.pid);
      telemetry.observeMs = Math.max(0, Date.now() - verificationStartedAt);

      log('[PlayableAgent] Process exited with code ' + code, taskId);

      // Save logs
      try { fs.writeFileSync(logPath, stdout + '\n---STDERR---\n' + stderr, 'utf-8'); } catch(e) {}

      // Find and read report JSON
      let report = null;
      try {
	        const agentReportPath = path.join(agentOutputDir, 'verify_report.json');
	        if (fs.existsSync(agentReportPath)) {
	          report = JSON.parse(fs.readFileSync(agentReportPath, 'utf-8'));
	        }
	        const explicitRunMatch = stdout.match(/输出:\s*(\/\S+)/);
	        if (!report && explicitRunMatch) {
	          const explicitReportPath = path.join(explicitRunMatch[1], 'verify_report.json');
	          if (fs.existsSync(explicitReportPath)) {
	            report = JSON.parse(fs.readFileSync(explicitReportPath, 'utf-8'));
	          }
	        }
        // Find the latest verify_report.json from this process window.
        const runsDir = '/root/cua-agent/runs';
        if (!report && fs.existsSync(runsDir)) {
          const dirs = fs.readdirSync(runsDir)
            .filter(d => d.startsWith('verify_'))
            .sort()
            .reverse();
          for (const dir of dirs) {
            const reportPath = path.join(runsDir, dir, 'verify_report.json');
            if (fs.existsSync(reportPath)) {
              const stat = fs.statSync(reportPath);
              if (stat.mtimeMs < verificationStartedAt - 5000) continue;
              report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
              break;
            }
          }
        }
      } catch(e) {
        log('[PlayableAgent] Failed to read report: ' + e.message, taskId);
      }

      if (!report) {
        try { server.close(); } catch(e) {}
        resolve(finish({
          passed: false,
          issues: ['[playableagent-error] Verification process failed to generate report. Exit code: ' + code],
          skipped: false,
          error: stderr.slice(0, 500)
        }));
        return;
      }

      const summary = summarizePlayableAgentReport(report, taskId, log);
      if (blueprint && blueprint.proofBundle) {
        summary.proofBundle = {
          schemaVersion: blueprint.proofBundle.schemaVersion || null,
          semanticHash: blueprint.proofBundle.semanticHash || null,
          expectedPhasePath: Array.isArray(blueprint.proofBundle.expectedPhasePath) ? blueprint.proofBundle.expectedPhasePath.slice() : [],
          contractDiff: blueprint.proofBundle.contractDiff || null,
        };
        if (summary.report) {
          summary.report.proofBundle = summary.proofBundle;
          if (summary.report.diagnostics) summary.report.diagnostics.proofBundle = summary.proofBundle;
        }
      }
      const manualJoystickProbeRequired = blueprintNeedsManualJoystickProbe(blueprint, report);
      summary.manualJoystickProbeRequired = manualJoystickProbeRequired;
      summary.manualJoystickFlowProbeRequired = manualJoystickProbeRequired;
      if (summary.report) {
        summary.report.manualJoystickProbeRequired = manualJoystickProbeRequired;
        summary.report.manualJoystickFlowProbeRequired = manualJoystickProbeRequired;
        if (summary.report.diagnostics) summary.report.diagnostics.manualJoystickProbeRequired = manualJoystickProbeRequired;
        if (summary.report.diagnostics) summary.report.diagnostics.manualJoystickFlowProbeRequired = manualJoystickProbeRequired;
      }
      if (summary.passed && manualJoystickProbeRequired) {
        const manualProbe = await measureCuaTelemetry(telemetry, 'manualProbeMs', function() {
          return runManualJoystickProbe(manualProbeUrl, taskId, log);
        });
        summary.manualJoystickProbe = manualProbe;
        if (summary.report) {
          summary.report.manualJoystickProbe = manualProbe;
          if (summary.report.diagnostics) summary.report.diagnostics.manualJoystickProbe = manualProbe;
        }
        if (!manualProbe.passed || manualProbe.skipped) {
          summary.passed = false;
          summary.exitReason = 'manual_joystick_probe_failed';
          summary.issues.push('[manual-joystick-probe] ' + (manualProbe.skipped ? 'required probe skipped: ' : '') + manualProbe.reason);
          if (summary.report) summary.report.exitReason = 'manual_joystick_probe_failed';
        }
      }
      const checkpointPhase = String(process.env.BLUEPRINT_MANUAL_JOYSTICK_CHECKPOINT_PHASE || '').trim();
      const checkpointOnly = checkpointPhase && process.env.BLUEPRINT_MANUAL_JOYSTICK_CHECKPOINT_ONLY === '1';
      if (summary.passed && manualJoystickProbeRequired && checkpointPhase) {
        const checkpointMaxPhases = Number(process.env.BLUEPRINT_MANUAL_JOYSTICK_CHECKPOINT_MAX_PHASES || 0) || 0;
        const checkpointProbe = await measureCuaTelemetry(telemetry, 'checkpointProbeMs', function() {
          return runManualJoystickCheckpointProbe(manualProbeUrl, blueprint, taskId, log, checkpointPhase, checkpointMaxPhases);
        });
        summary.manualJoystickCheckpointProbe = checkpointProbe;
        if (summary.report) {
          summary.report.manualJoystickCheckpointProbe = checkpointProbe;
          if (summary.report.diagnostics) summary.report.diagnostics.manualJoystickCheckpointProbe = checkpointProbe;
        }
        if (!checkpointProbe.passed || checkpointProbe.skipped) {
          summary.passed = false;
          summary.exitReason = 'manual_joystick_checkpoint_probe_failed';
          summary.issues.push('[manual-joystick-checkpoint-probe] ' + (checkpointProbe.skipped ? 'required probe skipped: ' : '') + checkpointProbe.reason);
          if (summary.report) summary.report.exitReason = 'manual_joystick_checkpoint_probe_failed';
        }
      }
      if (summary.passed && manualJoystickProbeRequired) {
        const flowProbe = checkpointOnly
          ? {
              passed: true,
              skipped: true,
              debugOnly: true,
              reason: 'full manual joystick flow probe skipped by BLUEPRINT_MANUAL_JOYSTICK_CHECKPOINT_ONLY; not valid for production CUA hardgate',
              targetCompleted: extractBlueprintPhaseIds(blueprint).length,
            }
          : await measureCuaTelemetry(telemetry, 'manualFlowMs', function() {
              return runManualJoystickFlowProbe(manualProbeUrl, blueprint, taskId, log);
            });
        if (checkpointOnly) telemetry.manualFlowMs = 0;
        if (checkpointOnly) {
          summary.debugOnly = true;
          if (summary.report) {
            summary.report.debugOnly = true;
            if (summary.report.diagnostics) summary.report.diagnostics.debugOnly = true;
          }
        }
        summary.manualJoystickFlowProbe = flowProbe;
        if (summary.report) {
          summary.report.manualJoystickFlowProbe = flowProbe;
          if (summary.report.diagnostics) summary.report.diagnostics.manualJoystickFlowProbe = flowProbe;
        }
        if ((!flowProbe.passed || flowProbe.skipped) && !checkpointOnly) {
          summary.passed = false;
          summary.exitReason = 'manual_joystick_flow_probe_failed';
          summary.issues.push('[manual-joystick-flow-probe] ' + (flowProbe.skipped ? 'required probe skipped: ' : '') + flowProbe.reason);
          if (summary.report) summary.report.exitReason = 'manual_joystick_flow_probe_failed';
        }
      }
      if (summary.passed) {
        const storyboardVisualAudit = await measureCuaTelemetry(telemetry, 'storyboardVisualAuditMs', function() {
          return runStoryboardVisualAudit(manualProbeUrl, taskId, log);
        });
        summary.storyboardVisualAudit = storyboardVisualAudit;
        if (summary.report) {
          summary.report.storyboardVisualAudit = storyboardVisualAudit;
          if (summary.report.diagnostics) summary.report.diagnostics.storyboardVisualAudit = storyboardVisualAudit;
        }
        if (!storyboardVisualAudit.passed) {
          summary.passed = false;
          summary.exitReason = 'storyboard_visual_audit_failed';
          summary.issues.push('[storyboard-visual-audit] ' + storyboardVisualAudit.reason);
          if (summary.report) summary.report.exitReason = 'storyboard_visual_audit_failed';
        }
      }
      if (summary.passed) {
        const storyboardVideoAudit = await measureCuaTelemetry(telemetry, 'storyboardVideoAuditMs', function() {
          return runStoryboardVideoAudit(manualProbeUrl, taskId, log);
        });
        summary.storyboardVideoAudit = storyboardVideoAudit;
        if (summary.report) {
          summary.report.storyboardVideoAudit = storyboardVideoAudit;
          if (summary.report.diagnostics) summary.report.diagnostics.storyboardVideoAudit = storyboardVideoAudit;
        }
        if (!storyboardVideoAudit.passed) {
          summary.passed = false;
          summary.exitReason = 'storyboard_video_audit_failed';
          summary.issues.push('[storyboard-video-audit] ' + storyboardVideoAudit.reason);
          if (summary.report) summary.report.exitReason = 'storyboard_video_audit_failed';
        }
      }
      try { server.close(); } catch(e) {}
      resolve(finish(summary));
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      telemetry.observeMs = Math.max(0, Date.now() - verificationStartedAt);
      try { server.close(); } catch(e) {}
      log('[PlayableAgent] Process error: ' + err.message, taskId);
      resolve(finish({
        passed: false,
        issues: ['[playableagent-error] Failed to start: ' + err.message],
        skipped: false,
        error: err.message
      }));
    });
  });
}

module.exports = {
  runCUAVerification,
  CUA_RESULTS_DIR,
  computeVerifyTimeoutMs,
  computeManualJoystickFlowBudget,
  createCuaTelemetry,
  attachCuaTelemetry,
  measureCuaTelemetry,
  patchForHeadless,
  writeSpecsFile,
  summarizePlayableAgentReport,
  blueprintNeedsManualJoystickProbe,
  extractBlueprintPhaseIds,
  extractBlueprintPhaseTargetMap,
  selectManualJoystickPhaseWindow,
  attachBlueprintProofBundle,
  evaluateManualJoystickProbeResult,
  evaluateManualJoystickFlowProbeResult,
  evaluateStoryboardVisualAuditResult,
  runManualJoystickProbe,
  runManualJoystickFlowProbe,
  runManualJoystickCheckpointProbe,
  runStoryboardVisualAudit,
  runStoryboardVideoAudit,
  shouldRunStoryboardVideoAudit,
};
