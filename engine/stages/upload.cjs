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
  return String(value || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
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

function captureVisualFrame(page, sharp) {
  if (!sharp) return Promise.resolve(null);
  return page.screenshot({ type: 'jpeg', quality: 72 }).then(function(buffer) {
    return sharp(buffer)
      .removeAlpha()
      .resize(160, 120, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });
  }).then(function(frame) {
    return {
      data: frame.data,
      width: frame.info.width,
      height: frame.info.height,
      channels: frame.info.channels,
    };
  }).catch(function() {
    return null;
  });
}

function visualDiffRatio(a, b) {
  if (!a || !b || !a.data || !b.data) return 0;
  var aChannels = a.channels || 3;
  var bChannels = b.channels || 3;
  var channels = Math.min(aChannels, bChannels, 3);
  var pixels = Math.min(
    Math.floor(a.data.length / aChannels),
    Math.floor(b.data.length / bChannels)
  );
  if (!pixels || channels <= 0) return 0;

  var changed = 0;
  for (var i = 0; i < pixels; i++) {
    var ai = i * aChannels;
    var bi = i * bChannels;
    var delta = 0;
    for (var c = 0; c < channels; c++) {
      delta += Math.abs(a.data[ai + c] - b.data[bi + c]);
    }
    if (delta > 35) changed++;
  }
  return changed / pixels;
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
  var sharp = null;
  var visualBaseline = null;
  var visualLastFrame = null;
  var visualMaxDiff = 0;
  var visualFrames = 0;
  var minVisualDiff = parseFloat(process.env.PUBLIC_PREVIEW_MIN_VISUAL_DIFF_RATIO || '0.005');
  if (!Number.isFinite(minVisualDiff) || minVisualDiff < 0) minVisualDiff = 0.005;
  var targetSpecCount = Math.min(Math.max(specs.length, 1), specs.length <= 3 ? specs.length : 3);
  var deadlineMs = parseInt(process.env.PUBLIC_PREVIEW_VERIFY_WINDOW_MS || '70000', 10);
  if (!Number.isFinite(deadlineMs) || deadlineMs < 10000) deadlineMs = 70000;

  // How long to wait for Unity WebGL engine init (window.__gameState) before
  // starting the progress-sampling deadline clock.
  var gameStateInitTimeoutMs = parseInt(
    process.env.PUBLIC_PREVIEW_GAME_STATE_INIT_TIMEOUT_MS ||
    process.env.PUBLIC_PREVIEW_GAME_STATE_INIT_MS ||
    '90000',
    10
  );
  if (!Number.isFinite(gameStateInitTimeoutMs) || gameStateInitTimeoutMs < 5000) gameStateInitTimeoutMs = 90000;

  if (process.env.SKIP_PUBLIC_PREVIEW_VISUAL_VERIFY !== 'true') {
    try { sharp = require('sharp'); } catch(e) {
      return Promise.reject(new Error('Public preview visual verifier unavailable: sharp not installed'));
    }
  }

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
    ctx.addLog('upload', 'Waiting for Unity engine init (window.app/window.__gameState)…');
    return page.waitForFunction(
      function() {
        if (window.__gameState) return true;
        if (typeof window.__getGameState === 'function') {
          try { if (window.__getGameState()) return true; } catch(e) {}
        }
        return !!(window.app && window.app.app);
      },
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
    return captureVisualFrame(page, sharp).then(function(frame) {
      if (frame) {
        visualBaseline = frame;
        visualLastFrame = frame;
        visualFrames = 1;
      }
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
      function timeoutResult(state) {
        return {
          passed: false,
          reason: state ? 'public-preview-no-progress' : 'public-preview-no-game-state',
          phaseBefore: getStatePhase(firstState),
          phaseAfter: getStatePhase(bestState || state),
          completedBefore: firstState ? getSpecCompletedCount(firstState, specs) : 0,
          completedAfter: Math.max(bestCount, 0),
          targetCompleted: targetSpecCount,
          phaseChanges: phaseChanges,
          visualMaxDiff: visualMaxDiff,
          visualFrames: visualFrames,
          console: consoleMessages.slice(-8),
        };
      }

      function successOrVisualFailure(phase, count) {
        if (visualBaseline && visualMaxDiff < minVisualDiff) {
          return {
            passed: false,
            reason: 'public-preview-visual-frozen',
            phaseBefore: getStatePhase(firstState),
            phaseAfter: phase,
            completedBefore: getSpecCompletedCount(firstState, specs),
            completedAfter: count,
            targetCompleted: targetSpecCount,
            phaseChanges: phaseChanges,
            visualMaxDiff: visualMaxDiff,
            visualFrames: visualFrames,
            visualMinDiff: minVisualDiff,
            console: consoleMessages.slice(-8),
          };
        }

        return {
          passed: true,
          reason: 'public-preview-progressed',
          phaseBefore: getStatePhase(firstState),
          phaseAfter: phase,
          completedBefore: getSpecCompletedCount(firstState, specs),
          completedAfter: count,
          targetCompleted: targetSpecCount,
          phaseChanges: phaseChanges,
          visualMaxDiff: visualMaxDiff,
          visualFrames: visualFrames,
          console: consoleMessages.slice(-8),
        };
      }

      return readGameState(page).then(function(state) {
        if (state) {
          if (!firstState) firstState = state;
          var phase = getStatePhase(state);
          var phaseChanged = !!(lastPhase && phase && phase !== lastPhase);
          if (phaseChanged) phaseChanges++;
          if (phase) lastPhase = phase;
          var count = getSpecCompletedCount(state, specs);
          var countImproved = count > bestCount;
          if (count > bestCount) {
            bestCount = count;
            bestState = state;
          }

          var doneEnough = isTerminalPhase(phase) || count >= targetSpecCount;
          var shouldCapture = !!(visualBaseline && (phaseChanged || countImproved || doneEnough));
          var afterVisual = shouldCapture
            ? captureVisualFrame(page, sharp).then(function(frame) {
              if (frame) {
                var fromBaseline = visualDiffRatio(visualBaseline, frame);
                var fromLast = visualDiffRatio(visualLastFrame, frame);
                visualMaxDiff = Math.max(visualMaxDiff, fromBaseline, fromLast);
                visualLastFrame = frame;
                visualFrames++;
              }
            })
            : Promise.resolve();

          if (doneEnough) {
            return afterVisual.then(function() {
              return successOrVisualFailure(phase, count);
            });
          }

          if (shouldCapture) {
            return afterVisual.then(function() {
              if (Date.now() >= deadline) return timeoutResult(state);
              return page.waitForTimeout(1000).then(sample);
            });
          }
        }

        if (Date.now() >= deadline) {
          return timeoutResult(state);
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
      ' completed=' + result.completedAfter + '/' + result.targetCompleted +
      (result.visualFrames ? ' visualDiff=' + (result.visualMaxDiff || 0).toFixed(3) : ''));
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
  _internals: {
    visualDiffRatio: visualDiffRatio,
    getSpecCompletedCount: getSpecCompletedCount,
  },
};
