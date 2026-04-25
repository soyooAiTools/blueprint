/**
 * Stage: upload — Save build artifacts to webgl dir
 *
 * Reads: ctx.htmlOutput, ctx.taskId, ctx.previewUrl
 * Writes: (saves files to disk)
 */

var fs = require('fs');
var path = require('path');

function extractSpecs(blueprint) {
  if (!blueprint) return [];
  if (Array.isArray(blueprint.specs)) return blueprint.specs;
  if (Array.isArray(blueprint.phases)) return blueprint.phases;
  if (Array.isArray(blueprint)) return blueprint;
  if (blueprint.blueprint) return extractSpecs(blueprint.blueprint);
  return [];
}

function sanitizePhaseId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9]/g, '');
}

function getStatePhase(state) {
  if (!state) return '';
  return String(state.currentPhase || state.phase || state.currentPhaseName || '');
}

function isTerminalPhase(phase) {
  return ['gameEnd', 'cta', 'CTA', 'ctaPhase'].indexOf(String(phase || '')) >= 0;
}

function getSpecCompletedCount(state, specs) {
  if (!state) return 0;
  var completed = state.completedPhases || state.completed || null;
  if (!Array.isArray(completed)) return 0;

  var specSet = {};
  (specs || []).forEach(function(spec) {
    var id = String(spec.phaseId || spec.id || spec.name || '');
    if (id) {
      specSet[id] = true;
      specSet[sanitizePhaseId(id)] = true;
    }
  });

  var count = 0;
  completed.forEach(function(id) {
    var phase = String(id || '');
    if (specSet[phase] || specSet[sanitizePhaseId(phase)]) count++;
  });
  return count;
}

function readGameState(page) {
  return page.evaluate(function() {
    try {
      var state = window.__gameState || null;
      if (!state && typeof window.__getGameState === 'function') state = window.__getGameState();
      if (!state) return null;
      return JSON.parse(JSON.stringify(state));
    } catch(e) {
      return null;
    }
  }).catch(function() { return null; });
}

function appendCacheBuster(url) {
  var sep = String(url || '').indexOf('?') >= 0 ? '&' : '?';
  return String(url || '') + sep + 'publicPreviewProbe=' + Date.now();
}

function verifyPublicPreviewProgress(ctx, previewUrl) {
  if (process.env.SKIP_PUBLIC_PREVIEW_VERIFY === 'true') {
    return Promise.resolve({ skipped: true, reason: 'skipped-by-env' });
  }

  var specs = extractSpecs(ctx && ctx.blueprint);
  if (specs.length === 0) {
    return Promise.resolve({ skipped: true, reason: 'no-phase-specs' });
  }

  var chromium;
  try { chromium = require('playwright').chromium; } catch(e) {
    return Promise.reject(new Error('Public preview verifier unavailable: Playwright not installed'));
  }

  var browser;
  var context;
  var page;
  var consoleMessages = [];
  var targetSpecCount = Math.min(Math.max(specs.length, 1), specs.length <= 3 ? specs.length : 3);
  var deadlineMs = parseInt(process.env.PUBLIC_PREVIEW_VERIFY_WINDOW_MS || '70000', 10);
  if (!Number.isFinite(deadlineMs) || deadlineMs < 10000) deadlineMs = 70000;

  // How long to wait for Unity WebGL engine init (window.__gameState) before
  // starting the progress-sampling deadline clock.
  var gameStateInitTimeoutMs = parseInt(process.env.PUBLIC_PREVIEW_GAME_STATE_INIT_MS || '25000', 10);
  if (!Number.isFinite(gameStateInitTimeoutMs) || gameStateInitTimeoutMs < 5000) gameStateInitTimeoutMs = 25000;

  ctx.addLog('upload', 'Verifying public preview default progress...');

  return chromium.launch({ headless: true, args: ['--no-sandbox'] }).then(function(b) {
    browser = b;
    return browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 960, height: 640 } });
  }).then(function(c) {
    context = c;
    return context.newPage();
  }).then(function(p) {
    page = p;
    page.on('console', function(msg) {
      var text = msg.text();
      if (msg.type() === 'error' || msg.type() === 'warning' || text.indexOf('__PHASE__') >= 0) {
        consoleMessages.push('[' + msg.type() + '] ' + text.slice(0, 260));
      }
    });
    page.on('pageerror', function(err) {
      consoleMessages.push('[pageerror] ' + String(err && err.message || err).slice(0, 260));
    });
    return page.goto(appendCacheBuster(previewUrl), { waitUntil: 'load', timeout: 45000 });
  }).then(function() {
    // Wait for Unity WebGL WASM compilation and engine init to complete before
    // starting the progress-sampling deadline clock.  Without this guard the
    // 70-second deadline expires before window.__gameState is ever written.
    ctx.addLog('upload', 'Waiting for Unity engine init (window.__gameState)…');
    return page.waitForFunction(
      function() { return !!(window.__gameState || (typeof window.__getGameState === 'function' && window.__getGameState())); },
      null,
      { timeout: gameStateInitTimeoutMs }
    ).then(function() {
      ctx.addLog('upload', 'Unity engine ready — starting progress sampling');
    }).catch(function(initErr) {
      // Engine did not initialise in time; surface a clear failure immediately
      // rather than burning the full deadline and mis-attributing the failure.
      throw new Error(
        'Unity engine did not initialise within ' + gameStateInitTimeoutMs + 'ms ' +
        '(window.__gameState never set): ' + String(initErr && initErr.message || initErr)
      );
    });
  }).then(function() {
    // Deadline clock starts only after engine is confirmed ready.
    var deadline = Date.now() + deadlineMs;
    var firstState = null;
    var bestState = null;
    var bestCount = -1;
    var phaseChanges = 0;
    var lastPhase = '';

    function sample() {
      return readGameState(page).then(function(state) {
        if (state) {
          if (!firstState) firstState = state;
          var phase = getStatePhase(state);
          if (lastPhase && phase && phase !== lastPhase) phaseChanges++;
          if (phase) lastPhase = phase;
          var count = getSpecCompletedCount(state, specs);
          if (count > bestCount) {
            bestCount = count;
            bestState = state;
          }
          if (isTerminalPhase(phase) || count >= targetSpecCount) {
            return {
              passed: true,
              reason: 'public-preview-progressed',
              phaseBefore: getStatePhase(firstState),
              phaseAfter: phase,
              completedBefore: getSpecCompletedCount(firstState, specs),
              completedAfter: count,
              targetCompleted: targetSpecCount,
              phaseChanges: phaseChanges,
              console: consoleMessages.slice(-8),
            };
          }
        }

        if (Date.now() >= deadline) {
          return {
            passed: false,
            reason: state ? 'public-preview-no-progress' : 'public-preview-no-game-state',
            phaseBefore: getStatePhase(firstState),
            phaseAfter: getStatePhase(bestState || state),
            completedBefore: firstState ? getSpecCompletedCount(firstState, specs) : 0,
            completedAfter: Math.max(bestCount, 0),
            targetCompleted: targetSpecCount,
            phaseChanges: phaseChanges,
            console: consoleMessages.slice(-8),
          };
        }

        return page.waitForTimeout(1000).then(sample);
      });
    }

    return sample();
  }).then(function(result) {
    if (!result || result.passed !== true) {
      var summary = result ? JSON.stringify(result) : 'no result';
      throw new Error('Public preview did not progress: ' + summary);
    }
    ctx.addLog('upload',
      'Public preview progress OK: ' + result.phaseBefore + ' → ' + result.phaseAfter +
      ' completed=' + result.completedAfter + '/' + result.targetCompleted);
    return result;
  }).then(function(result) {
    return (context ? context.close().catch(function() {}) : Promise.resolve()).then(function() {
      return browser ? browser.close().catch(function() {}) : null;
    }).then(function() { return result; });
  }).catch(function(err) {
    return (context ? context.close().catch(function() {}) : Promise.resolve()).then(function() {
      return browser ? browser.close().catch(function() {}) : null;
    }).then(function() { throw err; });
  });
}

module.exports = {
  name: 'upload',
  canRetry: true,
  assertBefore: function(ctx) {
    if (!ctx.htmlOutput) throw new Error('No HTML output to upload');
  },
  maxRetries: 3,
  execute: function(ctx) {
    ctx.addLog('upload', 'Saving build artifacts...');

    if (!ctx.htmlOutput) {
      ctx.addLog('upload', 'No HTML output to save, skipping');
      return Promise.resolve({ uploaded: false, reason: 'no html' });
    }

    var previewDir = path.join(__dirname, '..', '..', 'server-data', 'webgl', ctx.taskId);
    fs.mkdirSync(previewDir, { recursive: true });

    // Version history: archive previous build before overwriting (keep last 3)
    var existingHtml = path.join(previewDir, 'index.html');
    if (fs.existsSync(existingHtml)) {
      var versionDir = path.join(previewDir, 'versions');
      fs.mkdirSync(versionDir, { recursive: true });
      var ts = new Date().toISOString().replace(/[:.]/g, '-');
      try {
        fs.renameSync(existingHtml, path.join(versionDir, 'index-' + ts + '.html'));
        var versions = fs.readdirSync(versionDir).sort().reverse();
        for (var vi = 3; vi < versions.length; vi++) {
          fs.unlinkSync(path.join(versionDir, versions[vi]));
        }
      } catch(e) { ctx.addLog('upload', 'Version archive skipped: ' + e.message); }
    }

    fs.writeFileSync(path.join(previewDir, 'index.html'), ctx.htmlOutput);

    // gzip for nginx gzip_static
    try {
      var zlib = require('zlib');
      var gzipped = zlib.gzipSync(ctx.htmlOutput, { level: 6 });
      fs.writeFileSync(path.join(previewDir, 'index.html.gz'), gzipped);
      ctx.addLog('upload', 'Compressed: ' + (ctx.htmlOutput.length / 1048576).toFixed(1) + 'MB → ' + (gzipped.length / 1048576).toFixed(1) + 'MB');
    } catch(e) { ctx.addLog('upload', 'gzip skipped: ' + e.message); }

    ctx.previewUrl = 'https://playcools.top/webgl/' + ctx.taskId + '/index.html';
    ctx.addLog('upload', 'Preview saved: ' + ctx.previewUrl);

    return verifyPublicPreviewProgress(ctx, ctx.previewUrl).then(function(publicPreview) {
      if (ctx.reportStatus) {
        ctx.reportStatus('done', {
          message: '[Linux] Build complete. Preview: ' + ctx.previewUrl,
          previewUrl: ctx.previewUrl,
        });
      }

      // Metrics are recorded at pipeline level (pipeline.cjs runNext), not here
      return { uploaded: true, previewUrl: ctx.previewUrl, publicPreview: publicPreview };
    });
  },
  _verifyPublicPreviewProgress: verifyPublicPreviewProgress,
};
