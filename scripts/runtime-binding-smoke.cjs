#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const checkpointCli = require('./cua-checkpoint-probe.cjs');

function usage() {
  return [
    'Usage: node scripts/runtime-binding-smoke.cjs <webgl-build-dir> [--out report.json]',
    '  [--settle-ms N] [--load-timeout-ms N] [--no-require-player]',
    '',
    'Runs a short debug-only browser smoke for runtime bindings before full CUA.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = (argv || process.argv).slice(2);
  const parsed = {
    buildDir: '',
    outPath: '',
    settleMs: 5000,
    loadTimeoutMs: 60000,
    requirePlayer: true,
    help: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--out') {
      parsed.outPath = String(args[++i] || '').trim();
    } else if (arg === '--settle-ms') {
      parsed.settleMs = Math.max(0, Math.floor(Number(args[++i] || 0) || 0));
    } else if (arg === '--load-timeout-ms') {
      parsed.loadTimeoutMs = Math.max(1000, Math.floor(Number(args[++i] || 0) || 0));
    } else if (arg === '--no-require-player') {
      parsed.requirePlayer = false;
    } else if (!parsed.buildDir) {
      parsed.buildDir = arg;
    } else {
      throw new Error('Unexpected argument: ' + arg);
    }
  }
  return parsed;
}

function safeRunId(value) {
  const raw = String(value || 'runtime-binding-smoke');
  const hasNonAscii = /[^\x00-\x7F]/.test(raw);
  let safe = raw.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '');
  if (hasNonAscii) {
    const hash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 8);
    const base = safe.replace(/[-_.]+$/g, '') || 'runtime-binding-smoke';
    safe = base + '-' + hash;
  }
  return safe.slice(0, 100) || 'runtime-binding-smoke';
}

function consoleText(log) {
  return String(log && log.text || '').slice(0, 1000);
}

function isMissingPoolLog(text) {
  return /\[EntityBinding\]\s+Missing pool object/i.test(String(text || ''));
}

function isPlayerMissingLog(text) {
  return /Missing pool object for Player/i.test(String(text || '')) ||
    /GFM_Player\s+找不到场景\s+Player/i.test(String(text || '')) ||
    /GFM_Player.*missing.*Player/i.test(String(text || ''));
}

function addViolation(out, code, message, extra) {
  out.push(Object.assign({ code, message }, extra || {}));
}

function analyzeRuntimeBindingSnapshot(snapshot, options) {
  options = options || {};
  const requirePlayer = options.requirePlayer !== false;
  const logs = Array.isArray(snapshot && snapshot.logs) ? snapshot.logs : [];
  const violations = [];
  const missingPoolLogs = logs.filter(log => isMissingPoolLog(consoleText(log)));
  const playerMissingLogs = logs.filter(log => isPlayerMissingLog(consoleText(log)));
  const pageErrors = logs.filter(log => String(log && log.type || '') === 'pageerror');

  if (pageErrors.length > 0) {
    addViolation(violations, 'runtime_page_error', 'browser page emitted runtime errors', {
      count: pageErrors.length,
      samples: pageErrors.slice(0, 5),
    });
  }
  if (playerMissingLogs.length > 0) {
    addViolation(violations, 'runtime_player_binding_log', 'runtime reported missing Player binding', {
      count: playerMissingLogs.length,
      samples: playerMissingLogs.slice(0, 5),
    });
  }
  if (missingPoolLogs.length > 0) {
    addViolation(violations, 'runtime_pool_binding_log', 'runtime reported missing entity pool bindings', {
      count: missingPoolLogs.length,
      samples: missingPoolLogs.slice(0, 8),
    });
  }

  const runtime = snapshot && snapshot.runtime || {};
  const player = runtime.player || {};
  if (requirePlayer) {
    if (!runtime.hasGfmPlayer) {
      addViolation(violations, 'runtime_gfm_player_missing', 'window.GFM_Player is missing after WebGL load');
    } else if (!player.hasInstance) {
      addViolation(violations, 'runtime_gfm_player_instance_missing', 'GFM_Player.Instance is missing after WebGL load');
    } else if (!player.hasGo) {
      addViolation(violations, 'runtime_gfm_player_go_missing', 'GFM_Player.Instance.Go is missing after WebGL load');
    }
    if (player.position && Number(player.position.y) <= -100) {
      addViolation(violations, 'runtime_player_hidden_below_world', 'GFM_Player.Instance.Go is hidden below the world', {
        position: player.position,
      });
    }
    if (runtime.playerState && runtime.playerState.visible === false) {
      addViolation(violations, 'runtime_player_state_not_visible', 'game state marks Player invisible after startup', {
        playerState: runtime.playerState,
      });
    }
  }

  return {
    passed: violations.length === 0,
    violations,
    summary: {
      requirePlayer,
      hasGameState: !!runtime.hasGameState,
      hasGfmPlayer: !!runtime.hasGfmPlayer,
      hasPlayerInstance: !!player.hasInstance,
      hasPlayerGo: !!player.hasGo,
      missingPoolLogCount: missingPoolLogs.length,
      playerMissingLogCount: playerMissingLogs.length,
      pageErrorCount: pageErrors.length,
    },
  };
}

async function captureRuntimeSnapshot(page, logs) {
  const runtime = await page.evaluate(function() {
    function roundPosition(pos) {
      if (!pos) return null;
      function n(value) {
        var out = Number(value);
        return Number.isFinite(out) ? Math.round(out * 1000) / 1000 : null;
      }
      return { x: n(pos.x), y: n(pos.y), z: n(pos.z) };
    }
    function getGameState() {
      try {
        if (typeof window.__getGameState === 'function') return window.__getGameState();
      } catch(e) {}
      try {
        if (typeof window.__gameState === 'function') return window.__gameState();
      } catch(e2) {}
      try {
        if (window.__gameState && typeof window.__gameState === 'object') return window.__gameState;
      } catch(e3) {}
      return null;
    }
    function firstPlayerState(gs) {
      var states = gs && (gs.entityStates || gs.entity_states || gs.entities) || {};
      if (!states || typeof states !== 'object') return null;
      var candidates = ['Player', '_player', 'player', 'Hero', 'hero'];
      for (var i = 0; i < candidates.length; i += 1) {
        if (states[candidates[i]]) return states[candidates[i]];
      }
      var keys = Object.keys(states);
      for (var k = 0; k < keys.length; k += 1) {
        if (/player|hero|主角|角色/i.test(keys[k])) return states[keys[k]];
      }
      return null;
    }
    var cls = null;
    var inst = null;
    var go = null;
    try {
      cls = window.GFM_Player || null;
      inst = cls && (cls.Instance || cls.instance || cls._instance) || null;
      go = inst && (inst.Go || inst.go || inst._player) || null;
    } catch(ePlayer) {}
    var pos = null;
    try {
      pos = go && go.transform && go.transform.position || null;
    } catch(ePos) {}
    var gs = getGameState();
    var playerState = firstPlayerState(gs);
    return {
      url: String(window.location && window.location.href || ''),
      hasGameState: !!gs,
      currentPhase: gs && (gs.currentPhase || gs.phase) || '',
      completedPhases: gs && (gs.completedPhases || gs.completed) || [],
      hasGfmPlayer: !!cls,
      player: {
        hasInstance: !!inst,
        hasGo: !!go,
        goName: go && (go.name || go.Name) || '',
        position: roundPosition(pos),
      },
      playerState: playerState ? {
        visible: playerState.visible,
        active: playerState.active,
        position: roundPosition(playerState.position || playerState.pos),
      } : null,
    };
  });
  return {
    runtime,
    logs: logs.slice(),
  };
}

async function run(argv, log) {
  const logger = typeof log === 'function' ? log : console.log;
  const parsed = parseArgs(argv || process.argv);
  if (parsed.help) {
    logger(usage());
    return { exitCode: 0, help: true };
  }
  if (!parsed.buildDir) throw new Error(usage());
  const buildDir = path.resolve(parsed.buildDir);
  const entry = checkpointCli.findEntryHtml(buildDir);
  const outPath = path.resolve(parsed.outPath || path.join(buildDir, 'runtime-binding-smoke-report.json'));
  const startedAt = Date.now();
  let server = null;
  let browser = null;
  try {
    server = await checkpointCli.startStaticServer(buildDir);
    const port = server.address().port;
    const url = 'http://127.0.0.1:' + port + '/' + entry + '?runtimeBindingSmoke=1&cb=' + Date.now();
    const playwright = require('playwright');
    browser = await playwright.chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const logs = [];
    page.on('console', msg => {
      logs.push({ type: msg.type(), text: String(msg.text() || '').slice(0, 1000) });
    });
    page.on('pageerror', err => {
      logs.push({ type: 'pageerror', text: String(err && err.stack || err).slice(0, 1000) });
    });
    await page.goto(url, { waitUntil: 'load', timeout: parsed.loadTimeoutMs });
    await page.waitForFunction(function() {
      return !!window.GFM_Player || !!window.__gameState || typeof window.__getGameState === 'function';
    }, null, { timeout: Math.min(15000, parsed.loadTimeoutMs) }).catch(function() { return null; });
    await page.waitForTimeout(parsed.settleMs);
    const snapshot = await captureRuntimeSnapshot(page, logs);
    const assessment = analyzeRuntimeBindingSnapshot(snapshot, {
      requirePlayer: parsed.requirePlayer,
    });
    const report = {
      schemaVersion: 'blueprint-runtime-binding-smoke.v1',
      kind: 'blueprint.runtimeBindingSmokeReport',
      debugOnly: true,
      buildDir,
      entry,
      url,
      passed: assessment.passed,
      summary: assessment.summary,
      violations: assessment.violations,
      snapshot,
      telemetry: {
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date().toISOString(),
        totalMs: Date.now() - startedAt,
      },
    };
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
    logger('[runtime-binding-smoke] ' + (report.passed ? 'PASS' : 'FAIL') + ' -> ' + outPath);
    return { exitCode: report.passed ? 0 : 2, report, reportPath: outPath };
  } finally {
    if (browser) await browser.close();
    if (server) await new Promise(resolve => server.close(resolve));
  }
}

if (require.main === module) {
  run(process.argv).then(result => {
    process.exitCode = result.exitCode || 0;
  }).catch(err => {
    console.error('[runtime-binding-smoke] FAIL ' + (err && err.stack || err));
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  analyzeRuntimeBindingSnapshot,
  captureRuntimeSnapshot,
  run,
  safeRunId,
  usage,
};
