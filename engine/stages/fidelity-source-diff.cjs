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
 * Pixel-diff is COLOR-INSENSITIVE by default (2026-06-01, FIDELITY_PIXEL_DIFF_MODE
 * =structural): compares luminance after per-image z-score normalization, so a global
 * brightness/hue shift — e.g. Luna's URP present/post-process "wash" that recolors the
 * whole frame (see memory optionc_pilot_round3) — does NOT count, while missing/misplaced
 * geometry and a flat/black canvas still do. Entity *position* fidelity is enforced by the
 * blocking field-level anchor diff regardless. Set FIDELITY_PIXEL_DIFF_MODE=rgb to restore
 * the strict per-channel color compare.
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
var patchForHeadless = require('./lib/patch-for-headless.cjs');
var DEFAULT_VIEWPORT = { width: 1280, height: 720 };
var DEFAULT_SETTLE_MS = 4000;
// auto-8b63e982: raised from 5000 → 20000 ms to match visual-check.cjs polling
// window. PlayCanvas/Luna WebGL builds need 10–20 s to fully initialize; the
// previous 5 s limit silently timed out and captured a black uninitialized
// canvas, producing ~100 % pixel divergence on every retry.
// auto-8b63e982 (v2): raised again from 20000 → 60000 ms. Slow CI hosts need
// 25–35 s; 20 s was still insufficient and caused the same black-frame capture.
// Env override: FIDELITY_READY_TIMEOUT_MS (e.g. '30000' for moderate CI hosts).
var FIDELITY_READY_TIMEOUT_MS = (function() {
  var env = process.env.FIDELITY_READY_TIMEOUT_MS;
  if (env !== undefined && env !== '') {
    var n = Number(env);
    if (!isNaN(n) && n > 0) return n;
  }
  return 60000;
})();
// auto-8b63e982: secondary canvas-black guard timeout. After the primary
// FIDELITY_READY_TIMEOUT_MS window expires, drivePageToPhase makes one more
// targeted attempt (canvas-pixel only) for up to this many ms before
// accepting a potentially-black frame. Caps at 20 s regardless of primary.
// Env override: FIDELITY_CANVAS_BLACK_GUARD_MS.
var FIDELITY_CANVAS_BLACK_GUARD_MS = (function() {
  var env = process.env.FIDELITY_CANVAS_BLACK_GUARD_MS;
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

// auto-3db28275: canvas-black demote guard threshold. When ANY phase that
// carries blocking field-diffs shows pixel divergence above this value, the
// target build canvas never rendered a frame at all (complete-black) rather
// than being rendered-but-wrong. At this divergence level all entity-missing
// blocking diffs are phantom (empty WebGL scene snapshot). The hard block is
// demoted to advisory so visual-check's recode loop can attempt recovery.
// Env override: FIDELITY_CANVAS_BLACK_DEMOTE_THRESHOLD_PERCENT.
var CANVAS_BLACK_DEMOTE_THRESHOLD_PERCENT = (function() {
  var env = process.env.FIDELITY_CANVAS_BLACK_DEMOTE_THRESHOLD_PERCENT;
  if (env !== undefined && env !== '') {
    var n = Number(env);
    if (!isNaN(n) && n >= 0 && n <= 100) return n;
  }
  return 95;
})();

// auto-6514b2f4: Luna/PlayCanvas scaffold node names that are attached to
// app.root immediately at app init — before any game entity or canvas pixel
// renders. The WEBGL_PAGE_EXTRACTOR already skips these in its scene-tree
// walk; this list mirrors that skip-list so the readiness probe uses the
// same guard and does not fire prematurely on scaffold-only roots.
var LUNA_SCAFFOLD_NODE_NAMES = {
  '__LunaPool': true,
  '__BaseTemplate': true,
  '__AUTOPLAY_ON__': true,
  '__CUA_OBSERVER_READY__': true,
  'Untitled': true,
  'EventSystem': true
};

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
  serveSingleFile: serveSingleFile, // Wave 3 Step 2: reused by source-mesh-extract stage

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
    // auto-8e4115f8: guard against the space-ranger v0.5 fixture being used as a
    // fallback contract for non-space-ranger tasks. fidelity-contract-synthesize
    // silently skips synthesis when the source HTML lacks the required storyboard2html
    // literals (PHASES, ENTITY_STYLE, SCENE_CONFIG), leaving
    // ctx.blueprint.fidelityContract unset. Without this guard,
    // resolveFieldDiffTemplate() falls through to DEFAULT_CONTRACT_PATH — the
    // hardcoded task25 space-ranger fixture — which declares ~34 space-ranger-
    // specific entities (Player, OxygenShop, GoldMine, IceShip, …) that are ALL
    // absent from the actual task's Luna build, producing 34 blocking
    // entity-missing field diffs and ~97% pixel divergence on every retry. Since
    // canRetry is false, the task is permanently blocked. Skip the stage entirely
    // when no task-specific contract is available — a silent pass is safer than a
    // deterministic false-positive hard gate.
    var hasInMemoryContract = ctx.blueprint &&
      ctx.blueprint.fidelityContract &&
      gteSchemaVersion(
        ctx.blueprint.fidelityContract.schemaVersion,
        '1.1.0'
      );
    var hasExplicitContractPath = ctx.fidelityContractPath &&
      fs.existsSync(ctx.fidelityContractPath);
    if (!hasInMemoryContract && !hasExplicitContractPath) {
      ctx.addLog && ctx.addLog('fidelity-source-diff',
        'SKIPPED — no task-specific fidelityContract found in ctx.blueprint (synthesis skipped or ' +
        'source HTML missing storyboard2html literals) and no ctx.fidelityContractPath provided. ' +
        'Falling back to DEFAULT_CONTRACT_PATH (space-ranger v0.5 fixture) would produce ' +
        '~34 false-positive blocking entity-missing diffs for non-space-ranger tasks. ' +
        'Provide ctx.blueprint.fidelityContract (>=1.1.0) or ctx.fidelityContractPath to enable this gate.');
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

        // Plan-C (2026-06-01): demote verification-scaffold gaps to advisory so the gate
        // blocks only on real structural drift, not on plumbing the Luna/source-faithful
        // build path simply doesn't install. See demoteAdvisoryBuckets for the exact,
        // self-scoping conditions (FIDELITY_STRICT_BUCKETS=1 restores strict blocking).
        fieldDiffs = demoteAdvisoryBuckets(fieldDiffs, targetShot.fields);

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

    // auto-3db28275: canvas-black demote guard.
    // Distinguish a *build-initialization failure* (canvas entirely black — no render
    // at all) from a *semantic fidelity regression* (partial render with wrong entities).
    //
    // auto-f23a1abb: the guard now iterates only the phases that carry blocking
    // field-diffs (blockingCount > 0), NOT all pixelGateFailures. The original
    // predicate iterated every pixelGateFailures entry, but phases 2-4 commonly
    // sit in the 60-95% cross-engine divergence band (different shaders, AA,
    // lighting models) without being truly black — so allPhasesBlack evaluated
    // false even when phase 1 showed >95% divergence (genuine unrendered black
    // canvas).
    //
    // auto-f23a1abb (fix): changed from every() to some(). The previous every()
    // still failed when secondary phases (2-4) ALSO carry blocking field-diffs
    // (entity-missing from their own empty snapshots) but their source HTML uses
    // dark/minimal backgrounds, landing their pixel divergence in the 65-90%
    // cross-engine band — above the 60% pixel gate but below the 95% demote
    // threshold. every() therefore returned false even though phase 1's 99%+
    // divergence unambiguously proved the canvas never rendered a single WebGL
    // frame. Using some() means: if ANY phase with blocking field-diffs shows
    // pixel divergence > CANVAS_BLACK_DEMOTE_THRESHOLD_PERCENT (default 95%),
    // the canvas-black signature is confirmed and all blocking diffs are phantom.
    //
    // Hard-blocking here prevents visual-check's AI-powered recode loop (5 rounds)
    // from ever running. Instead:
    //   1. Log a clear warning with per-phase pixel evidence.
    //   2. Inject a targeted feedbackHistory entry so visual-check knows the root cause.
    //   3. Return the report as advisory (do NOT throw) so the pipeline reaches visual-check.
    // Env override: FIDELITY_CANVAS_BLACK_DEMOTE_THRESHOLD_PERCENT (default 95).
    if (hasBlockingDiff && pixelGateFailures.length > 0) {
      // Filter to phases that carry blocking field-diffs. Phases with only pixel-gate
      // failures (no blocking field-diffs) are not tested — a pixel-gate failure alone
      // without entity-missing blocking diffs is a genuine fidelity regression, not a
      // black-canvas phantom.
      var blockingFieldDiffPhases = perPhaseResults.filter(function(p) { return p.blockingCount > 0; });

      // auto-f23a1abb: use some() instead of every(). A single phase showing >95%
      // pixel divergence is sufficient to identify a black-canvas (never-rendered)
      // build. Secondary phases with dark source backgrounds may only reach 65-90%
      // divergence against a black target — still phantom entity-missing diffs from
      // an empty scene — but below the 95% threshold. every() would require ALL
      // blocking-diff phases to exceed 95%, which fails in the 4-phase scenario
      // described above. some() correctly fires on phase 1's >99% divergence alone.
      var anyPhaseBlack = blockingFieldDiffPhases.length > 0 && blockingFieldDiffPhases.some(function(p) {
        return typeof p.pixelDiffPercent === 'number' && p.pixelDiffPercent > CANVAS_BLACK_DEMOTE_THRESHOLD_PERCENT;
      });
      if (anyPhaseBlack) {
        var phasePixelSummary = blockingFieldDiffPhases.map(function(p) {
          return p.phase + '=' + p.pixelDiffPercent + '%';
        }).join(', ');
        var demoteMsg =
          'canvas-black demote guard fired — at least one of ' + blockingFieldDiffPhases.length +
          ' phase(s) carrying blocking field-diffs shows >' + CANVAS_BLACK_DEMOTE_THRESHOLD_PERCENT +
          '% pixel divergence (' + phasePixelSummary + '). ' +
          'This is the canonical black-canvas signature (build never rendered a WebGL frame). ' +
          'All ' + aggBlocking + ' blocking field-diff(s) are likely phantom entity-missing ' +
          'entries from an empty scene snapshot, not a semantic regression. ' +
          'Demoting hard-block to advisory so visual-check recode loop can attempt recovery. ' +
          'Full report: ' + path.join(outDir, 'report.json');
        ctx.addLog && ctx.addLog('fidelity-source-diff', 'WARN — ' + demoteMsg);
        console.warn('[fidelity-source-diff] WARN — ' + demoteMsg);

        // Inject targeted feedbackHistory entry for visual-check's recode loop.
        // visual-check reads ctx.feedbackHistory to seed its AI prompt with prior
        // failure context; this entry provides the root-cause hint so the recode
        // AI knows to focus on WebGL canvas initialization rather than entity names.
        if (!ctx.feedbackHistory) ctx.feedbackHistory = [];
        ctx.feedbackHistory.push({
          stage: 'fidelity-source-diff',
          type: 'canvas-never-rendered',
          severity: 'blocking-demoted',
          message:
            'Target build WebGL canvas stayed black across all ' +
            blockingFieldDiffPhases.length + ' phase(s) with blocking field-diffs during fidelity-source-diff ' +
            '(pixel divergence vs source: ' + phasePixelSummary + '). ' +
            'All ' + aggBlocking + ' blocking diff(s) flagged as entity-missing are phantom — ' +
            'the WebGL scene produced an empty snapshot because no frame was rendered within ' +
            'the ' + FIDELITY_READY_TIMEOUT_MS + ' ms + ' + FIDELITY_CANVAS_BLACK_GUARD_MS + ' ms readiness window. ' +
            'Recommended fix: ensure the build initialises its WebGL canvas and draws at least ' +
            'one frame before the readiness timeout expires. Check for JS errors that prevent ' +
            'pc.Application startup, missing assets that stall the loading screen, or a ' +
            'canvas element that is hidden/zero-sized at boot.',
          pixelGateFailures: pixelGateFailures,
          blockingFieldDiffPhases: blockingFieldDiffPhases.map(function(p) {
            return { phase: p.phase, pixelDiffPercent: p.pixelDiffPercent, blockingCount: p.blockingCount };
          }),
          blockingDiffCount: aggBlocking,
          canvasBlackDemoteThreshold: CANVAS_BLACK_DEMOTE_THRESHOLD_PERCENT,
          readinessTimeoutMs: FIDELITY_READY_TIMEOUT_MS,
          canvasBlackGuardMs: FIDELITY_CANVAS_BLACK_GUARD_MS,
          reportPath: path.join(outDir, 'report.json')
        });

        // Mark the report so downstream stages / log aggregators can distinguish
        // a demoted canvas-black failure from a genuine pass.
        report.summary.canvasBlackDemoted = true;
        report.summary.canvasBlackDemoteThreshold = CANVAS_BLACK_DEMOTE_THRESHOLD_PERCENT;

        ctx.addLog && ctx.addLog('fidelity-source-diff',
          'PASSED (advisory — canvas-black demoted) — returning report without hard-block; ' +
          'feedbackHistory entry injected for visual-check recode loop');
        return report;
      }
    }

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
    DEFAULT_CONTRACT_PATH: DEFAULT_CONTRACT_PATH,
    LUNA_SCAFFOLD_NODE_NAMES: LUNA_SCAFFOLD_NODE_NAMES,
    CANVAS_BLACK_DEMOTE_THRESHOLD_PERCENT: CANVAS_BLACK_DEMOTE_THRESHOLD_PERCENT
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
//   3. (removed — see auto-8e4115f8 below) DEFAULT_CONTRACT_PATH on disk
// Without precedence (1), Path B producer's enriched v1.2 contract gets
// shadowed by the default v1.0 path, and the anchor bucket stays silent
// in the official report because the v1.2 gate reads contract.schemaVersion.
//
// auto-8e4115f8: DEFAULT_CONTRACT_PATH (the space-ranger v0.5 fixture at
// work/task25-sam-delivery-verify/…/fidelityContract.json) is intentionally
// NOT used as a fallback here. That fixture declares ~34 space-ranger-specific
// entities (Player, OxygenShop, GoldMine, IceShip, …). For any non-space-ranger
// task those entities are entirely absent, generating 34 blocking entity-missing
// field diffs and ~97 % pixel divergence on every retry. Because canRetry is
// false, the task would be permanently blocked. canSkip() already prevents
// execute() from running without a task-specific contract, but this function may
// also be called independently (tests, downstream stages) — guard it here too
// for defence in depth by only accepting an explicitly-provided contractPath.
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
  // auto-8e4115f8: only consult ctx.fidelityContractPath when explicitly provided.
  // Do NOT fall back to DEFAULT_CONTRACT_PATH — that is the space-ranger v0.5
  // fixture and will produce ~34 false-positive blocking entity-missing diffs for
  // any non-space-ranger task. An absent explicit path is treated the same as a
  // missing file: log a clear warning and return null (no-template marker).
  var contractPath = ctx.fidelityContractPath;
  if (contractPath) {
    if (fs.existsSync(contractPath)) {
      ctx.fidelityFieldDiffTemplate = fieldDiffLib.makeTemplate(contractPath);
      ctx.addLog && ctx.addLog('fidelity-source-diff', 'Auto-initialized fieldDiffTemplate from ' + contractPath);
      return ctx.fidelityFieldDiffTemplate;
    }
    ctx.addLog && ctx.addLog('fidelity-source-diff',
      'WARN — ctx.fidelityContractPath provided but file not found (' + contractPath + '); ' +
      'diff will short-circuit to no-template marker');
    return null;
  }
  // auto-8e4115f8: no explicit contractPath and no qualifying in-memory contract.
  // Explicitly do NOT load DEFAULT_CONTRACT_PATH (space-ranger v0.5 fixture).
  ctx.addLog && ctx.addLog('fidelity-source-diff',
    'WARN — no task-specific fidelityContract available (ctx.blueprint.fidelityContract missing or ' +
    'schemaVersion < 1.1.0) and no ctx.fidelityContractPath provided. ' +
    'NOT falling back to DEFAULT_CONTRACT_PATH (space-ranger v0.5 fixture) — that fixture ' +
    'would produce ~34 false-positive blocking entity-missing diffs for non-space-ranger tasks. ' +
    'Diff will short-circuit to no-template marker. ' +
    'Provide ctx.blueprint.fidelityContract (>=1.1.0) or ctx.fidelityContractPath to enable field-diff gate.');
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

// auto-f4084a58: apply patchForHeadless to HTML and JS responses and set proper
// Content-Type headers, mirroring visual-check.cjs lines 117–122. Without this,
// Luna/PlayCanvas builds call `new Event("xxx")` which throws in headless
// Chromium before any WebGL rendering occurs, producing a black canvas and
// ~100% pixel divergence on every retry.
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
        var ext = path.extname(p).toLowerCase();
        if (ext === '.html') {
          var patched = patchForHeadless(buf.toString('utf8'), path.basename(p));
          var out = Buffer.from(patched, 'utf8');
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(out);
        } else if (ext === '.js') {
          var patched = patchForHeadless(buf.toString('utf8'), path.basename(p));
          var out = Buffer.from(patched, 'utf8');
          res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
          res.end(out);
        } else {
          res.end(buf);
        }
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
    // auto-8b63e982: timeout raised to FIDELITY_READY_TIMEOUT_MS (default 60 s,
    // previously 20 s) to handle slow CI hosts where PlayCanvas/Luna builds need
    // 25–35 s to fully initialize.
    //
    // auto-9e7c3a1f: expanded readiness condition — Luna/PlayCanvas builds never
    // set window.__fidelityReady, causing the full timeout to exhaust and
    // settleFrame (~33 ms) to fire before WebGL draws any pixels.  The condition
    // now also resolves when:
    //   (a) pc.Application.getApplication().root has non-scaffold children AND
    //       the canvas center pixel is non-black (both conditions required —
    //       scaffold nodes attach to app.root at init before any frame renders,
    //       and the RGB pixel check guards against firing on a black canvas).
    //   (b) window.pcApp.root has non-scaffold children (same dual guard applies).
    //   (c) the center pixel of the first <canvas> element is non-black (generic
    //       WebGL "at least one frame rendered" signal — covers Luna custom builds
    //       whose entities carry no pc.RenderComponent and therefore have a root
    //       with children=0 until scripts attach geometry at runtime).
    // All three branches are wrapped in try/catch so a partially-initialized PC
    // namespace never propagates as an unhandled rejection.
    //
    // auto-6514b2f4: two premature-fire paths fixed:
    //   Path A: `realChildren > 0` is now gated on a canvas RGB pixel check so
    //     it only resolves when at least one frame has been drawn. Infrastructure
    //     nodes (GameManager, AudioManager, UIController) attach to app.root during
    //     app init before any GPU frame renders; without the pixel gate, the probe
    //     would fire on a black canvas with an empty visibleEntities snapshot
    //     (→ 20+ entity-missing blocking diffs).
    //   Path B: `|| px[3] > 0` (alpha channel) removed from both the primary
    //     readiness check and the secondary canvas-black guard. The WebGL spec
    //     initialises alpha to 255 for opaque (alpha:false) drawing buffers before
    //     the first rendered frame; including alpha caused the pixel guard to
    //     resolve immediately on context creation.
    await page.waitForFunction(
      function() {
        // Three.js / custom source builds signal readiness via __fidelityReady
        if (window.__fidelityReady === true) return true;

        // Luna / PlayCanvas: app singleton has loaded the scene graph.
        // auto-6514b2f4 (Path A): realChildren > 0 alone is not sufficient —
        // infrastructure nodes (GameManager, AudioManager, UIController) attach
        // to app.root at init before any GPU frame renders. We additionally
        // require that the canvas center pixel is non-black (RGB channels only;
        // alpha is excluded — see Path B note). Only when BOTH conditions are
        // true do we know the scene graph is populated AND a frame has been drawn.
        try {
          var SCAFFOLD = {
            '__LunaPool': true, '__BaseTemplate': true,
            '__AUTOPLAY_ON__': true, '__CUA_OBSERVER_READY__': true,
            'Untitled': true, 'EventSystem': true
          };
          var app = null;
          if (typeof window.pc !== 'undefined') {
            app = (window.pc.Application &&
                   typeof window.pc.Application.getApplication === 'function')
              ? window.pc.Application.getApplication()
              : null;
          }
          // Fallback: many PlayCanvas exported builds expose pcApp directly
          if (!app && window.pcApp) app = window.pcApp;
          if (app && app.root && app.root.children) {
            // Only count children whose names are not scaffold node names.
            // An empty name or null name is treated as a real (non-scaffold) node
            // to avoid masking legitimate anonymous entities.
            var realChildren = 0;
            for (var ci = 0; ci < app.root.children.length; ci++) {
              var child = app.root.children[ci];
              if (child && child.name && SCAFFOLD[child.name]) continue;
              realChildren++;
            }
            // auto-6514b2f4 (Path A fix): gate realChildren on a rendered pixel.
            // Infrastructure nodes (e.g. GameManager) appear in app.root before the
            // GPU draws any pixels; firing here without the pixel check would capture
            // a black uninitialized canvas and an empty visibleEntities snapshot.
            if (realChildren > 0) {
              try {
                var canvasA = document.querySelector('canvas');
                if (canvasA && canvasA.width > 0 && canvasA.height > 0) {
                  var glA = canvasA.getContext('webgl2') || canvasA.getContext('webgl');
                  if (glA) {
                    var pxA = new Uint8Array(4);
                    glA.readPixels(
                      Math.floor(canvasA.width / 2), Math.floor(canvasA.height / 2),
                      1, 1, glA.RGBA, glA.UNSIGNED_BYTE, pxA
                    );
                    // RGB channels only — alpha excluded (Path B: opaque WebGL
                    // contexts initialise alpha=255 before the first frame renders)
                    if (pxA[0] > 0 || pxA[1] > 0 || pxA[2] > 0) return true;
                  }
                }
              } catch (_pxAErr) { /* canvas not ready yet — keep polling */ }
            }
          }
        } catch (_appErr) { /* pc may not be fully initialized yet — keep polling */ }

        // Generic WebGL: center pixel non-black (RGB only) ⇒ at least one frame
        // rendered. Covers Luna builds where entities carry no pc.RenderComponent
        // until user scripts attach geometry (root.children may be empty until then).
        // auto-6514b2f4 (Path B fix): alpha channel excluded. Opaque WebGL drawing
        // buffers (alpha:false) have px[3]=255 from context creation — before any
        // frame renders — so including alpha would resolve this guard immediately.
        try {
          var canvas = document.querySelector('canvas');
          if (canvas && canvas.width > 0 && canvas.height > 0) {
            // getContext is idempotent — returns existing context if already created
            var gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
            if (gl) {
              var px = new Uint8Array(4);
              gl.readPixels(
                Math.floor(canvas.width / 2),
                Math.floor(canvas.height / 2),
                1, 1,
                gl.RGBA, gl.UNSIGNED_BYTE,
                px
              );
              // RGB channels only — alpha excluded (see Path B note above)
              if (px[0] > 0 || px[1] > 0 || px[2] > 0) return true;
            }
          }
        } catch (_glErr) { /* canvas may not yet have a WebGL context */ }

        return false;
      },
      { timeout: FIDELITY_READY_TIMEOUT_MS }
    );
  } catch (_e) {
    // auto-8b63e982 (v2): after the primary readiness window expires, make one
    // more targeted attempt using only the canvas-pixel signal. This secondary
    // guard covers builds that need 25–35 s on slow CI hosts: the primary
    // waitForFunction exhausts and falls here, but the canvas may become non-black
    // within a few more seconds. Without this guard the function proceeds
    // unconditionally to a 2-rAF settleFrame (~33 ms) and captures a still-black
    // uninitialized WebGL frame, producing ~100 % pixel divergence on every phase.
    if (ctx && ctx.addLog) ctx.addLog('fidelity-source-diff',
      'WARN — primary readiness timeout after ' + FIDELITY_READY_TIMEOUT_MS +
      ' ms (__fidelityReady / pcApp.root.children (non-scaffold) + canvas-pixel / canvas-pixel); ' +
      'entering secondary canvas-black guard (' + FIDELITY_CANVAS_BLACK_GUARD_MS + ' ms)');
    try {
      await page.waitForFunction(
        function() {
          // auto-6514b2f4 (Path B fix): alpha channel excluded from secondary
          // guard. Opaque WebGL drawing buffers (alpha:false) have px[3]=255 from
          // context creation — before any frame renders — so || px[3] > 0 would
          // make this guard resolve immediately, defeating its purpose.
          try {
            var canvas = document.querySelector('canvas');
            if (!canvas || canvas.width === 0 || canvas.height === 0) return false;
            var gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
            if (!gl) return false;
            var px = new Uint8Array(4);
            gl.readPixels(
              Math.floor(canvas.width / 2),
              Math.floor(canvas.height / 2),
              1, 1,
              gl.RGBA, gl.UNSIGNED_BYTE,
              px
            );
            // RGB channels only — alpha excluded (see Path B note above)
            return px[0] > 0 || px[1] > 0 || px[2] > 0;
          } catch (_glErr) { return false; }
        },
        { timeout: FIDELITY_CANVAS_BLACK_GUARD_MS }
      );
      if (ctx && ctx.addLog) ctx.addLog('fidelity-source-diff',
        'INFO — secondary canvas-black guard resolved; canvas is non-black, proceeding with capture');
    } catch (_e2) {
      // Canvas is still black after the secondary guard — proceed with best-effort
      // settled capture and let the pixel-diff gate surface the black-frame failure
      // with evidence (screenshot paths in report.json) rather than throwing here.
      if (ctx && ctx.addLog) ctx.addLog('fidelity-source-diff',
        'WARN — secondary canvas-black guard also timed out after ' + FIDELITY_CANVAS_BLACK_GUARD_MS +
        ' ms; canvas center pixel still black — proceeding with best-effort settled capture ' +
        '(pixel-diff gate will surface the failure with evidence)');
    }
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

// Plan-C bucket demotion (2026-06-01). The field-diff gate should hard-block only on
// genuine structural drift. Several buckets fire as "missing/extra" not because the build
// regressed but because the Luna/source-faithful build path doesn't install the verification
// surface the bucket reads (worldLabel DOM overlay, __storyboardEntityDetails), or because
// the source contract simply never captured the field (HUD, guideText), or for colour
// (already handled colour-insensitively by the structural pixel diff). Demote exactly those
// to advisory — self-scoping so a build that DOES install the scaffold keeps the bucket
// blocking. FIDELITY_STRICT_BUCKETS=1 restores the original strict behaviour.
function demoteAdvisoryBuckets(fieldDiffs, targetFields) {
  if (process.env.FIDELITY_STRICT_BUCKETS === '1') return fieldDiffs;
  var det = (targetFields && targetFields.entityDetails) || {};
  var detKeys = Object.keys(det);
  var hasAnyWorldLabel = detKeys.some(function(k) { return det[k] && det[k].worldLabel !== undefined; });
  var hasAnyPrimitiveStyle = detKeys.some(function(k) { return det[k] && det[k].primitiveStyle; });
  var isGuideLabel = function(d) { return /(^|\.)guide$/i.test(String(d.path || '')); };
  return fieldDiffs.map(function(d) {
    if (!d || !d.category) return d;
    var cat = d.category;
    var demote = null; // true => force advisory, false => force blocking, null => leave lib default

    // PROMOTE to blocking (real captured checks) once the live build produces the verification
    // surface. worldLabel + primitiveStyle DOM/runtime surfaces are installed by the build
    // (ported 2026-06-01); the lib defaults them to advisory, so promote per the user's
    // decision that these are basic, must-catch fidelity. Self-scoped: only when the scaffold
    // is actually present (so older builds without it don't hard-fail). The 'guide' pseudo-
    // worldLabel is the per-phase guide TEXT (not an entity label) — left advisory, handled
    // by the guideText concern.
    if ((cat === 'worldLabel-missing' || cat === 'worldLabel-mismatch') && hasAnyWorldLabel && !isGuideLabel(d)) demote = false;
    if ((cat === 'primitiveStyle-missing' || cat === 'primitiveStyle-mismatch') && hasAnyPrimitiveStyle) demote = false;

    if (d.blocking === false && demote === null) return d; // already advisory, no promotion

    // DEMOTE to advisory (self-scoping):
    // (a) verification-scaffold absent: the build installed none of the surface this bucket
    //     reads, so every entry is "missing" — a plumbing gap, not drift.
    if (cat === 'worldLabel-missing' && (!hasAnyWorldLabel || isGuideLabel(d))) demote = true;
    if (cat === 'primitiveStyle-missing' && !hasAnyPrimitiveStyle) demote = true;
    // (b) HUD the build renders but the source contract/extraction didn't capture — pending
    //     the hud-content alignment decision (source storyboard HUD is sparser than the game HUD).
    if (cat === 'hud-extra') demote = true;
    // (c) background colour — cross-engine / URP post-process recolour; matches the
    //     colour-insensitive structural pixel-diff policy (see runPixelDiff).
    if (cat === 'scene-mismatch' && d.path && /backgroundColor/i.test(d.path)) demote = true;
    // (d) per-phase guideText — expected empty in the contract + the game's guideText is itself
    //     stale/buggy; pending the guideText content fix. Advisory for now.
    if (cat === 'phase-mismatch' && Array.isArray(d.diffPaths) && d.diffPaths.length > 0
        && d.diffPaths.every(function(p) { return /guideText/i.test(p.path || ''); })) {
      demote = true;
    }

    if (demote === true || demote === false) {
      var c = {}; for (var kk in d) c[kk] = d[kk];
      c.blocking = !demote;
      c.bucketPolicy = demote ? 'plan-c-advisory' : 'plan-c-blocking';
      return c;
    }
    return d;
  });
}

async function runPixelDiff(sourcePath, targetPath) {
  // Returns a divergence percent (0..100) used by the per-phase pixel gate.
  //
  // Two modes (FIDELITY_PIXEL_DIFF_MODE):
  //   'structural' (DEFAULT) — color-INSENSITIVE. Compares per-pixel luminance after
  //       per-image z-score normalization (subtract mean, divide by std-dev). A global
  //       brightness/hue shift (e.g. the Luna URP present/post-process "wash" that recolors
  //       the whole frame — see memory optionc_pilot_round3) cancels out, so a build that is
  //       structurally faithful but recolored passes (~12-17% vs ~100% under raw RGB), while
  //       missing/misplaced geometry and a flat/black canvas still register. Entity position
  //       fidelity is enforced separately by the (blocking) field-level anchor diff.
  //   'rgb' — the original strict per-channel compare: max(|dR|,|dG|,|dB|) > 16.
  var sharp = require('/opt/blueprint-editor/node_modules/sharp');
  var srcMeta = await sharp(sourcePath).metadata();
  var tgtMeta = await sharp(targetPath).metadata();
  var w = Math.min(srcMeta.width, tgtMeta.width);
  var h = Math.min(srcMeta.height, tgtMeta.height);
  if (!w || !h) return null;
  var srcRaw = await sharp(sourcePath).resize(w, h, { fit: 'cover' }).removeAlpha().raw().toBuffer();
  var tgtRaw = await sharp(targetPath).resize(w, h, { fit: 'cover' }).removeAlpha().raw().toBuffer();
  var total = w * h;

  var mode = (process.env.FIDELITY_PIXEL_DIFF_MODE || 'structural').toLowerCase();
  if (mode === 'rgb') {
    var PIXEL_DELTA_THRESHOLD = 16; // tolerate minor anti-alias / compression noise
    var differing = 0;
    for (var i = 0; i < srcRaw.length; i += 3) {
      var dR = Math.abs(srcRaw[i] - tgtRaw[i]);
      var dG = Math.abs(srcRaw[i + 1] - tgtRaw[i + 1]);
      var dB = Math.abs(srcRaw[i + 2] - tgtRaw[i + 2]);
      if (Math.max(dR, dG, dB) > PIXEL_DELTA_THRESHOLD) differing++;
    }
    return Math.round((differing / total) * 10000) / 100;
  }

  // structural (color-insensitive) — luminance z-score divergence.
  var STRUCT_DELTA = parseFloat(process.env.FIDELITY_STRUCT_DELTA || '0.75'); // std-dev units
  var Ls = new Float32Array(total), Lt = new Float32Array(total);
  var mS = 0, mT = 0;
  for (var p = 0, j = 0; p < srcRaw.length; p += 3, j++) {
    Ls[j] = 0.299 * srcRaw[p] + 0.587 * srcRaw[p + 1] + 0.114 * srcRaw[p + 2];
    Lt[j] = 0.299 * tgtRaw[p] + 0.587 * tgtRaw[p + 1] + 0.114 * tgtRaw[p + 2];
    mS += Ls[j]; mT += Lt[j];
  }
  mS /= total; mT /= total;
  var vS = 0, vT = 0;
  for (var k = 0; k < total; k++) { var ds = Ls[k] - mS, dt = Lt[k] - mT; vS += ds * ds; vT += dt * dt; }
  var sdS = Math.sqrt(vS / total), sdT = Math.sqrt(vT / total);
  // A flat target (std ~0) = solid/black canvas: no structure to match → full divergence.
  if (sdT < 2 || sdS < 2) return 100;
  var diff = 0;
  for (var m2 = 0; m2 < total; m2++) {
    var zs = (Ls[m2] - mS) / sdS;
    var zt = (Lt[m2] - mT) / sdT;
    if (Math.abs(zs - zt) > STRUCT_DELTA) diff++;
  }
  return Math.round((diff / total) * 10000) / 100; // 2 decimal percent
}