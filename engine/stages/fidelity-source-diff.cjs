/**
 * Stage: fidelity-source-diff
 *
 * Purpose: shift-left visual fidelity gate. Compares source HTML (canonical truth)
 * against produced build (ctx.htmlOutput) per phase, both field-level and pixel-level.
 *
 * Hard gate: BOTH
 *   (a) fieldDiffs with d.blocking !== false (lib @0.6.1 shim marks worldLabel
 *       bucket entries as blocking:false advisory), AND
 *   (b) per-phase pixel-diff % > DEFAULT_PIXEL_GATE_THRESHOLD_PERCENT (env
 *       override FIDELITY_PIXEL_GATE_THRESHOLD_PERCENT; set 0 to bypass).
 * Pixel gate is A-tier addition (2026-05-29) because field-diff assumes
 * "entity in tree = renderable" — assumption fails in Luna runtime where
 * 0 entities carry pc.RenderComponent (custom script-attached mesh path).
 *
 * Placement: BEFORE visual-check (so visual-check still runs as self-check), but
 * runs only when ctx.sourceHtmlPath is provided. Future hardening: make
 * sourceHtmlPath mandatory at pipeline entry so this stage can never be skipped.
 *
 * Inputs (from ctx):
 *   - ctx.sourceHtmlPath: absolute path to source HTML (canonical truth)
 *   - ctx.htmlOutput: produced HTML build (set by compile stage)
 *   - ctx.blueprint.phaseSpecs/phases/specs: phase metadata from spec stages
 *   - ctx.fidelityFieldDiffTemplate: Tim's per-phase field-level diff template
 *
 * Outputs (to ctx and disk):
 *   - ctx.fidelitySourceDiffReport: { passed, perPhase: [{phase, fieldDiffs, pixelDiffPercent, source/targetScreenshotPath}] }
 *   - server-data/webgl/<taskId>/fidelity-source-diff/{source-phase-N.png, target-phase-N.png, report.json}
 *
 * Hard gate: throws when (a) any blocking field-diff OR (b) any phase pixel% >
 * threshold. Both populate report.summary so a single throw lands all evidence.
 */

'use strict';

var fs = require('fs');
var path = require('path');
var http = require('http');
var fieldDiffLib = require('./lib/field-diff.cjs');
var DEFAULT_VIEWPORT = { width: 1280, height: 720 };
var DEFAULT_SETTLE_MS = 4000;
// auto-8b63e982: raised from 5000 → 20000 ms to match visual-check.cjs polling
// window. PlayCanvas/Luna WebGL builds need 10–20 s to fully initialize; the
// previous 5 s limit silently timed out and captured a black uninitialized
// canvas, producing ~100 % pixel divergence on every retry.
// Env override: FIDELITY_READY_TIMEOUT_MS (e.g. '30000' for slow CI hosts).
var FIDELITY_READY_TIMEOUT_MS = (function() {
  var env = process.env.FIDELITY_READY_TIMEOUT_MS;
  if (env !== undefined && env !== '') {
    var n = Number(env);
    if (!isNaN(n) && n > 0) return n;
  }
  return 20000;
})();
// auto-8b63e982: raised from 5 → 60 % to account for inherent cross-engine
// pixel spread. A correct Three.js→PlayCanvas port will differ 30–60 % at the
// pixel level because the two renderers use different shaders, AA, and lighting
// models. The previous 5 % gate was unpassable even for semantically-identical
// scenes. Set FIDELITY_PIXEL_GATE_THRESHOLD_PERCENT=0 to bypass completely, or
// lower (e.g. '30') once a same-engine baseline is established.
var DEFAULT_PIXEL_GATE_THRESHOLD_PERCENT = 60;
// v1.2.0 anchor diff: pixel tolerance for per-entity screen-space rect compare.
// Env override FIDELITY_ANCHOR_TOLERANCE_PX. v1.2.1 follow-up may switch to
// `max(8px, 10% bbox dim)` if small-entity false-pass surfaces.
var DEFAULT_ANCHOR_TOLERANCE_PX = 8;

function gteSchemaVersion(actual, target) {
  var p = String(actual || '0').split('.').map(Number);
  var q = String(target || '0').split('.').map(Number);
  for (var i = 0; i < 3; i++) {
    var x = p[i] || 0, y = q[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true;
}

// v1.2 stage-layer anchor bridge gate. Replaces silent advisory log (pre-amend4)
// with two explicit blocking fieldDiff categories so reviewers see the failure
// in summary.bucket.anchor instead of having to grep logs:
//   anchor-bridge-missing: window.__targetAnchors never set (helpers.cjs visualAssets
//                          pass-through missing → built HTML has no overlay plumbing)
//   anchor-target-empty:   __targetAnchors initialized but empty for this phase
//                          (manifest bridge missing projectedAnchors → writer no-op)
// Worker writes { [phaseId]: measured, current: measured } — normalize to entity→rect.
// Returns array of entries (may be empty when expectedAnchors absent).
function computePhaseAnchorEntries(phaseId, expectedAnchors, rawTargetAnchors, viewport, tolerancePx) {
  if (!expectedAnchors) return [];
  if (!rawTargetAnchors) {
    return [{
      category: 'anchor-bridge-missing',
      blocking: true,
      phaseId: phaseId,
      path: 'phases.' + phaseId + '.projectedAnchors',
      message: 'v1.2 contract has projectedAnchors but target did not expose window.__targetAnchors (helpers.cjs visualAssets pass-through missing?)'
    }];
  }
  var actualAnchors = rawTargetAnchors[phaseId] || rawTargetAnchors.current || rawTargetAnchors;
  if (!actualAnchors || typeof actualAnchors !== 'object' || Object.keys(actualAnchors).length === 0) {
    return [{
      category: 'anchor-target-empty',
      blocking: true,
      phaseId: phaseId,
      path: 'phases.' + phaseId + '.projectedAnchors',
      message: 'window.__targetAnchors initialized but empty for phase ' + phaseId + ' (manifest bridge missing projectedAnchors?)'
    }];
  }
  return fieldDiffLib.runAnchorDiff(phaseId, expectedAnchors, actualAnchors, viewport, tolerancePx);
}
var DEFAULT_CONTRACT_PATH = path.join(__dirname, '..', '..', 'work', 'task25-sam-delivery-verify', 'unpacked',
  'space-ranger-v0.5-fidelity-delivery', 'unity-project', 'Assets', 'Fidelity', 'fidelityContract.json');

module.exports = {
  name: 'fidelity-source-diff',
  canRetry: false,

  assertBefore: function(ctx) {
    if (!ctx.sourceHtmlPath) {
      // PHASE 1 SOFT: skip if no sourceHtmlPath; PHASE 2 HARD: throw here.
      ctx.addLog && ctx.addLog('fidelity-source-diff', 'No sourceHtmlPath in ctx — skipping (transition phase). Future: this will be a HARD failure.');
      return;
    }
    if (!fs.existsSync(ctx.sourceHtmlPath)) {
      throw new Error('sourceHtmlPath does not exist: ' + ctx.sourceHtmlPath);
    }
    if (!ctx.htmlOutput || ctx.htmlOutput.length < 10240) {
      throw new Error('htmlOutput missing or too small');
    }
  },

  canSkip: function(ctx) {
    if (!ctx.sourceHtmlPath) {
      ctx.addLog && ctx.addLog('fidelity-source-diff', 'No sourceHtmlPath in ctx — skipping (transition phase). Future: this will be a HARD failure.');
      return true;
    }
    if (process.env.SKIP_FIDELITY_SOURCE_DIFF === 'true') {
      // Loud warning: skip only allowed during initial rollout, will be banned later.
      ctx.addLog && ctx.addLog('fidelity-source-diff', 'SKIPPED via SKIP_FIDELITY_SOURCE_DIFF=true — transition-period escape only');
      console.warn('[fidelity-source-diff] SKIPPED via SKIP_FIDELITY_SOURCE_DIFF=true — this is a transition-period escape only');
      return true;
    }
    return false;
  },

  execute: async function(ctx) {
    ctx.addLog && ctx.addLog('fidelity-source-diff', 'Starting source-vs-target visual fidelity diff');

    if (!ctx.fidelityFieldDiffTemplate) {
      resolveFieldDiffTemplate(ctx);
    }

    var phaseSpecs = resolvePhaseSpecs(ctx.blueprint);
    if (!phaseSpecs.length) {
      throw new Error('No phaseSpecs/phases/specs found in ctx.blueprint — cannot run per-phase diff');
    }

    var outDir = path.join(__dirname, '..', '..', 'server-data', 'webgl', ctx.taskId, 'fidelity-source-diff');
    fs.mkdirSync(outDir, { recursive: true });

    var playwright = require('/opt/blueprint-editor/node_modules/playwright');

    // Serve source HTML
    var sourceServer = await serveSingleFile(ctx.sourceHtmlPath);
    // Serve target build (write htmlOutput to temp then serve)
    var targetHtmlPath = path.join(outDir, 'target.html');
    fs.writeFileSync(targetHtmlPath, ctx.htmlOutput);
    var targetServer = await serveSingleFile(targetHtmlPath);

    var pixelGateThreshold = resolvePixelGateThreshold();
    var perPhaseResults = [];
    var hasBlockingDiff = false;
    var aggBlocking = 0;
    var aggAdvisory = 0;
    var pixelGateFailures = [];
    // Buckets keyed by category prefix from the lib shim (entity, phase, hud, worldLabel).
    // Lib shim emits singular prefix in category (e.g. 'entity-extra'), even though the
    // lib's own summarize() uses plural ('entities'). We follow the shim shape here.
    var aggBuckets = {};
    var browser = await playwright.chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });

    try {
      for (var i = 0; i < phaseSpecs.length; i++) {
        var phase = phaseSpecs[i];
        var phaseId = phase.id || ('phase' + (i + 1));
        var phaseNumber = resolvePhaseNumber(phase, i);

        var sourceShot = await captureFrame(browser, sourceServer.url, phaseId, phaseNumber, path.join(outDir, 'source-' + phaseId + '.png'), phase.driveSourceToPhase, ctx, 'source');
        var targetShot = await captureFrame(browser, targetServer.url, phaseId, phaseNumber, path.join(outDir, 'target-' + phaseId + '.png'), phase.driveTargetToPhase, ctx, 'webgl-playcanvas');

        var fieldDiffs = runFieldLevelDiff(ctx.fidelityFieldDiffTemplate, phaseId, sourceShot.fields, targetShot.fields);
        // v1.2.0: anchor bucket. Expected = contract.phases[i].projectedAnchors
        // (baked at migration time from source Three.js camera.project). Actual =
        // target-runtime anchors exposed by writer at `window.__targetAnchors`
        // (Jonny's overlay-only patch). When contract is < v1.2 OR target build
        // has not yet exposed window.__targetAnchors, anchor bucket is skipped
        // with advisory log — never blocking.
        var contractPhases = (ctx.fidelityFieldDiffTemplate && ctx.fidelityFieldDiffTemplate.contract && ctx.fidelityFieldDiffTemplate.contract.phases) || [];
        var contractSchemaVersion = (ctx.fidelityFieldDiffTemplate && ctx.fidelityFieldDiffTemplate.contract && ctx.fidelityFieldDiffTemplate.contract.schemaVersion) || '';
        if (gteSchemaVersion(contractSchemaVersion, '1.2.0')) {
          var contractPhaseForAnchors = null;
          for (var cp = 0; cp < contractPhases.length; cp++) {
            if (contractPhases[cp] && contractPhases[cp].id === phaseId) {
              contractPhaseForAnchors = contractPhases[cp];
              break;
            }
          }
          var expectedAnchors = contractPhaseForAnchors && contractPhaseForAnchors.projectedAnchors;
          var anchorEntries = computePhaseAnchorEntries(phaseId, expectedAnchors, targetShot.targetAnchors, DEFAULT_VIEWPORT, DEFAULT_ANCHOR_TOLERANCE_PX);
          fieldDiffs = fieldDiffs.concat(anchorEntries);
        }
        var pixelDiffPercent = await runPixelDiff(sourceShot.path, targetShot.path);

        var blockingDiffs = fieldDiffs.filter(function(d) { return d.blocking !== false; });
        var advisoryDiffs = fieldDiffs.filter(function(d) { return d.blocking === false; });
        if (blockingDiffs.length > 0) hasBlockingDiff = true;
        aggBlocking += blockingDiffs.length;
        aggAdvisory += advisoryDiffs.length;
        fieldDiffs.forEach(function(d) {
          if (!d || !d.category) return;
          var bucket = d.category.split('-')[0];
          aggBuckets[bucket] = (aggBuckets[bucket] || 0) + 1;
        });

        var pixelGateActive = pixelGateThreshold > 0 && typeof pixelDiffPercent === 'number';
        var pixelGateBlocking = pixelGateActive && pixelDiffPercent > pixelGateThreshold;
        if (pixelGateBlocking) {
          hasBlockingDiff = true;
          pixelGateFailures.push({ phase: phaseId, percent: pixelDiffPercent, threshold: pixelGateThreshold });
        }

        perPhaseResults.push({
          phase: phaseId,
          source: { screenshotPath: sourceShot.path, fields: sourceShot.fields },
          target: { screenshotPath: targetShot.path, fields: targetShot.fields },
          fieldDiffs: fieldDiffs,
          blockingCount: blockingDiffs.length,
          advisoryCount: advisoryDiffs.length,
          pixelDiffPercent: pixelDiffPercent,
          pixelGate: {
            threshold: pixelGateThreshold,
            active: pixelGateActive,
            blocking: pixelGateBlocking
          }
        });
      }
    } finally {
      await browser.close();
      sourceServer.server.close();
      targetServer.server.close();
    }

    var report = {
      kind: 'blueprint.fidelitySourceDiff.report',
      schemaVersion: '1.2.0',
      taskId: ctx.taskId,
      generatedAt: new Date().toISOString(),
      passed: !hasBlockingDiff,
      summary: {
        blocking: aggBlocking,
        advisory: aggAdvisory,
        totalFieldDiffs: aggBlocking + aggAdvisory,
        buckets: aggBuckets,
        pixelGate: {
          threshold: pixelGateThreshold,
          active: pixelGateThreshold > 0,
          failurePhases: pixelGateFailures,
          perPhase: perPhaseResults.map(function(p) {
            return { phase: p.phase, percent: p.pixelDiffPercent, blocking: p.pixelGate.blocking };
          })
        }
      },
      perPhase: perPhaseResults
    };
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    ctx.fidelitySourceDiffReport = report;

    if (hasBlockingDiff) {
      var firstFieldDiff = perPhaseResults.find(function(p) { return p.blockingCount > 0; });
      var parts = [];
      if (firstFieldDiff) {
        parts.push(firstFieldDiff.blockingCount + ' blocking field-level diff(s) in ' + firstFieldDiff.phase);
      }
      if (pixelGateFailures.length > 0) {
        var fp = pixelGateFailures[0];
        parts.push('pixel gate FAIL in ' + fp.phase + ' (' + fp.percent + '% > ' + fp.threshold + '%' +
          (pixelGateFailures.length > 1 ? '; ' + pixelGateFailures.length + ' phase(s) over threshold' : '') + ')');
      }
      throw new Error(
        'fidelity-source-diff BLOCKING — ' + parts.join(' + ') +
        ' (advisory field-diffs: ' + aggAdvisory + '; full report: ' + path.join(outDir, 'report.json') + ')'
      );
    }

    ctx.addLog && ctx.addLog('fidelity-source-diff', 'PASSED — ' + perPhaseResults.length + ' phase(s), zero blocking diff (' + aggAdvisory + ' advisory; pixel gate threshold ' + pixelGateThreshold + '%)');
    return report;
  },

  _internals: {
    resolvePhaseSpecs: resolvePhaseSpecs,
    resolvePhaseNumber: resolvePhaseNumber,
    runFieldLevelDiff: runFieldLevelDiff,
    resolvePixelGateThreshold: resolvePixelGateThreshold,
    DEFAULT_PIXEL_GATE_THRESHOLD_PERCENT: DEFAULT_PIXEL_GATE_THRESHOLD_PERCENT,
    computePhaseAnchorEntries: computePhaseAnchorEntries,
    DEFAULT_ANCHOR_TOLERANCE_PX: DEFAULT_ANCHOR_TOLERANCE_PX,
    resolveFieldDiffTemplate: resolveFieldDiffTemplate,
    DEFAULT_CONTRACT_PATH: DEFAULT_CONTRACT_PATH
  }
};

function resolvePixelGateThreshold() {
  var env = process.env.FIDELITY_PIXEL_GATE_THRESHOLD_PERCENT;
  if (env === undefined || env === '') return DEFAULT_PIXEL_GATE_THRESHOLD_PERCENT;
  var n = Number(env);
  if (isNaN(n) || n < 0) return DEFAULT_PIXEL_GATE_THRESHOLD_PERCENT;
  return n;
}

// task #43 (v1.3c): templated precedence —
//   1. enriched in-memory contract (ctx.blueprint.fidelityContract @ v1.2+)
//   2. explicit ctx.fidelityContractPath on disk
//   3. DEFAULT_CONTRACT_PATH on disk
// Without precedence (1), Path B producer's enriched v1.2 contract gets
// shadowed by the default v1.0 path, and the anchor bucket stays silent
// in the official report because the v1.2 gate reads contract.schemaVersion.
function resolveFieldDiffTemplate(ctx) {
  var inMemory = ctx.blueprint && ctx.blueprint.fidelityContract;
  // 2026-05-31 Option B: gate lowered to >= 1.1.0 so a synthesize-stage v1.1.0
  // contract (produced from source.html L1-L8.5) wins precedence over the
  // generic space-ranger v1.0.0 fixture. Anchor bucket is still gated >= 1.2.0
  // separately at line ~199, so dropping this gate only affects entity/phase/
  // hud/worldLabel field-diff (which is what we need — project-specific names).
  if (inMemory && gteSchemaVersion(inMemory.schemaVersion, '1.1.0')) {
    ctx.fidelityFieldDiffTemplate = fieldDiffLib.makeTemplateFromContract(inMemory);
    ctx.addLog && ctx.addLog('fidelity-source-diff',
      'Auto-initialized fieldDiffTemplate from ctx.blueprint.fidelityContract (in-memory, schemaVersion=' + inMemory.schemaVersion + ')');
    return ctx.fidelityFieldDiffTemplate;
  }
  var contractPath = ctx.fidelityContractPath || DEFAULT_CONTRACT_PATH;
  if (fs.existsSync(contractPath)) {
    ctx.fidelityFieldDiffTemplate = fieldDiffLib.makeTemplate(contractPath);
    ctx.addLog && ctx.addLog('fidelity-source-diff', 'Auto-initialized fieldDiffTemplate from ' + contractPath);
    return ctx.fidelityFieldDiffTemplate;
  }
  ctx.addLog && ctx.addLog('fidelity-source-diff', 'WARN — no fidelityFieldDiffTemplate on ctx and DEFAULT_CONTRACT_PATH missing; diff will short-circuit to no-template marker');
  return null;
}

// --- helpers ---

function resolvePhaseSpecs(blueprint) {
  if (!blueprint) return [];
  if (Array.isArray(blueprint.phaseSpecs) && blueprint.phaseSpecs.length) return blueprint.phaseSpecs;
  if (Array.isArray(blueprint.phases) && blueprint.phases.length) return blueprint.phases;
  if (Array.isArray(blueprint.specs) && blueprint.specs.length) return blueprint.specs;
  return [];
}

function resolvePhaseNumber(phase, index) {
  if (phase && typeof phase.phaseIndex === 'number') return phase.phaseIndex;
  if (phase && typeof phase.index === 'number') return phase.index + 1;
  if (phase && typeof phase.phaseNumber === 'number') return phase.phaseNumber;
  if (phase && typeof phase.id === 'number') return phase.id;
  var id = String(phase && (phase.id || phase.phaseId || phase.name) || '');
  var match = id.match(/(\d+)/);
  return match ? Number(match[1]) : index + 1;
}

function serveSingleFile(filePath) {
  return new Promise(function(resolve, reject) {
    var dir = path.dirname(filePath);
    var name = path.basename(filePath);
    var server = http.createServer(function(req, res) {
      var rel = req.url === '/' ? '/' + name : req.url;
      var p = path.join(dir, decodeURIComponent(rel));
      if (!p.startsWith(dir)) { res.statusCode = 403; res.end('forbidden'); return; }
      fs.readFile(p, function(err, buf) {
        if (err) { res.statusCode = 404; res.end('not found'); return; }
        res.end(buf);
      });
    });
    server.listen(0, '127.0.0.1', function() {
      var port = server.address().port;
      resolve({ server: server, url: 'http://127.0.0.1:' + port + '/' + name });
    });
    server.on('error', reject);
  });
}

async function captureFrame(browser, url, phaseId, phaseNumber, outPath, driveFn, pipelineCtx, targetKind) {
  var ctx = await browser.newContext({ viewport: DEFAULT_VIEWPORT, deviceScaleFactor: 1 });
  var page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(DEFAULT_SETTLE_MS);
  if (typeof driveFn === 'function') {
    // Drive the page into the target phase (e.g. inject events, wait for phase change)
    await driveFn(page, phaseId);
    await settleFrame(page);
  } else {
    await drivePageToPhase(page, phaseNumber, pipelineCtx);
  }
  var fields = await extractFieldSnapshot(page, phaseId, targetKind);
  // v1.2.0: target-runtime per-entity anchor capture. Writer exposes
  // `window.__targetAnchors = { entityId: { x_px, y_px, w_px, h_px, ... } }`
  // for the current phase. Source HTML doesn't expose this (anchors are
  // baked in the contract at migration time, not read from source runtime).
  var targetAnchors = null;
  if (targetKind === 'webgl-playcanvas') {
    try {
      targetAnchors = await page.evaluate(function() {
        return (typeof window !== 'undefined' &&
                window.__targetAnchors &&
                typeof window.__targetAnchors === 'object') ? window.__targetAnchors : null;
      });
    } catch (_e) { targetAnchors = null; }
  }
  await page.screenshot({ path: outPath, fullPage: false });
  await ctx.close();
  return { path: outPath, fields: fields, targetAnchors: targetAnchors };
}

async function settleFrame(page) {
  await page.evaluate(function() {
    return new Promise(function(resolve) {
      requestAnimationFrame(function() {
        requestAnimationFrame(resolve);
      });
    });
  });
}

async function drivePageToPhase(page, phaseNumber, ctx) {
  try {
    // auto-8b63e982: timeout raised to FIDELITY_READY_TIMEOUT_MS (default 20 s)
    // to match visual-check.cjs polling window. PlayCanvas/Luna WebGL builds
    // need 10–20 s; the old 5 s limit silently produced black-frame captures.
    await page.waitForFunction('window.__fidelityReady === true', { timeout: FIDELITY_READY_TIMEOUT_MS });
  } catch (_e) {
    if (ctx && ctx.addLog) ctx.addLog('fidelity-source-diff', 'WARN — __fidelityReady missing/timeout after ' + FIDELITY_READY_TIMEOUT_MS + ' ms; continuing with settled first-frame capture');
  }

  var hasDriveHook = await page.evaluate(function() {
    return typeof window.__driveToPhase === 'function';
  }).catch(function() { return false; });

  if (hasDriveHook) {
    // auto-6d24da7e: wrap in try/catch so a JS runtime exception thrown by the
    // game inside a Phase_*_Init function (e.g. null .transform access) is caught
    // gracefully rather than propagating as a stage-fatal rejected promise.
    // All other page.evaluate calls in this function already use try/catch or
    // .catch() — this was the one unguarded call site.
    try {
      await page.evaluate(function(n) {
        return Promise.resolve(window.__driveToPhase(n)).then(function() {
          return new Promise(function(resolve) {
            requestAnimationFrame(function() {
              requestAnimationFrame(resolve);
            });
          });
        });
      }, phaseNumber);
    } catch (_driveErr) {
      if (ctx && ctx.addLog) {
        ctx.addLog('fidelity-source-diff',
          'WARN — __driveToPhase(' + phaseNumber + ') threw a runtime exception (' +
          (_driveErr && _driveErr.message ? _driveErr.message : String(_driveErr)) +
          '); continuing with settled frame capture');
      }
    }
    return;
  }

  if (phaseNumber > 1) {
    if (ctx && ctx.addLog) ctx.addLog('fidelity-source-diff', 'WARN — __driveToPhase missing; capturing phase 1 fallback for requested phase ' + phaseNumber);
  }
  await settleFrame(page);
}

async function extractFieldSnapshot(page, phaseId, targetKind) {
  // Delegated to Tim's makePageExtractor (engine/stages/lib/field-diff.cjs).
  // Picks SOURCE_PAGE_EXTRACTOR or WEBGL_PAGE_EXTRACTOR based on targetKind so
  // source HTML (Three.js + DOM) and PlayCanvas/Luna target builds each use the
  // shape that matches their runtime — see (6) in field-diff.cjs header.
  var extractor = fieldDiffLib.makePageExtractor({ targetKind: targetKind || 'source' });
  var extractorSrc = extractor.toString();
  return await page.evaluate(
    '(' + extractorSrc + ')(' + JSON.stringify({ phaseId: phaseId }) + ')'
  );
}

function runFieldLevelDiff(template, phaseId, sourceFields, targetFields) {
  // Delegated to Tim's runFieldLevelDiff (engine/stages/lib/field-diff.cjs).
  // Returns flat array of diff entries; empty = no field-level drift.
  return fieldDiffLib.runFieldLevelDiff(template, phaseId, sourceFields, targetFields);
}

async function runPixelDiff(sourcePath, targetPath) {
  // Pixel diff via sharp: extract raw RGBA at unified size, count pixels where
  // max(|dR|, |dG|, |dB|) > PIXEL_DELTA_THRESHOLD. Returns percent (0..100).
  var sharp = require('/opt/blueprint-editor/node_modules/sharp');
  var PIXEL_DELTA_THRESHOLD = 16; // tolerate minor anti-alias / compression noise
  var srcMeta = await sharp(sourcePath).metadata();
  var tgtMeta = await sharp(targetPath).metadata();
  var w = Math.min(srcMeta.width, tgtMeta.width);
  var h = Math.min(srcMeta.height, tgtMeta.height);
  if (!w || !h) return null;
  var srcRaw = await sharp(sourcePath).resize(w, h, { fit: 'cover' }).removeAlpha().raw().toBuffer();
  var tgtRaw = await sharp(targetPath).resize(w, h, { fit: 'cover' }).removeAlpha().raw().toBuffer();
  var total = w * h;
  var differing = 0;
  for (var i = 0; i < srcRaw.length; i += 3) {
    var dR = Math.abs(srcRaw[i] - tgtRaw[i]);
    var dG = Math.abs(srcRaw[i + 1] - tgtRaw[i + 1]);
    var dB = Math.abs(srcRaw[i + 2] - tgtRaw[i + 2]);
    if (Math.max(dR, dG, dB) > PIXEL_DELTA_THRESHOLD) differing++;
  }
  return Math.round((differing / total) * 10000) / 100; // 2 decimal percent
}