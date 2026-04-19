// Source: engine/stages/spec-extract.cjs
/**
 * Stage: spec-extract — Ensure ctx.blueprint.specs is populated before any
 * downstream stage that assumes specs exist (spec-validate, complexity-gate,
 * codegen-schema, codegen-legacy).
 *
 * Background: Before this stage existed, spec extraction was only inlined in
 * claude-code-coder.js (legacy path). Schema codegen bypassed it entirely and
 * crashed in generateSkeleton(undefined) with "Cannot read properties of
 * undefined (reading 'length')". api/projects.cjs exportBlueprint also did not
 * forward project.specs to worker even when already cached.
 *
 * Priority order:
 *   1. Reuse existing ctx.blueprint.specs (from DB export or feedback round)
 *      — ONLY if all entitiesRequired refs match current ctx.blueprint.entities
 *   2. Load cached spec-data/<taskId>.json
 *   3. Extract fresh from storyboard frames via LLM
 *   4. FATAL if no frames and no cached specs — nothing to generate from
 *
 * Reads:  ctx.blueprint.specs, ctx.blueprint.storyboard.frames / storyboardFrames, ctx.blueprint.entities
 * Writes: ctx.blueprint.specs (canonical), spec-data/<taskId>.json (cache)
 */

var path = require('path');
var specExtractor = require('../../adapters/spec-extractor.cjs');

/**
 * Returns true only when every entitiesRequired ref in `specs` resolves to a
 * known entity name in `entities`.  An empty entities list is treated as
 * "unconstrained" so that tasks that intentionally have no entities still skip.
 */
function specsAreReusable(specs, entities) {
  if (!Array.isArray(specs) || specs.length === 0) return false;
  if (!Array.isArray(entities) || entities.length === 0) return true;
  var known = new Set(entities.map(function(e) { return e.name; }).filter(Boolean));
  for (var i = 0; i < specs.length; i++) {
    var ereq = specs[i].entitiesRequired || [];
    for (var j = 0; j < ereq.length; j++) {
      if (ereq[j].name && !known.has(ereq[j].name)) return false;
    }
  }
  return true;
}

module.exports = {
  name: 'spec-extract',
  canRetry: true,
  maxRetries: 1,

  canSkip: function(ctx) {
    // Skip only when we already have valid specs whose entity references are
    // consistent with the current blueprint entities.  DB-exported specs with
    // stale/camelCase names must NOT skip — they need to flow through execute()
    // so spec-extractor's 3-layer entity-name correction pipeline runs.
    // Never skip because of *missing* input; missing input must fall through to
    // the FATAL branch so it surfaces in metrics instead of silently crashing
    // in codegen.
    var specs = ctx.blueprint && ctx.blueprint.specs;
    if (!Array.isArray(specs) || specs.length === 0) return false;
    var entities = (ctx.blueprint && ctx.blueprint.entities) || [];
    return specsAreReusable(specs, entities);
  },

  execute: function(ctx) {
    var bp = ctx.blueprint || {};
    var taskId = ctx.taskId;
    var specsDataDir = process.env.SPECS_DATA_DIR || path.join(__dirname, '..', '..', 'spec-data');

    // Frame source — matches claude-code-coder.js resolution order.
    var frames = (bp.storyboard && Array.isArray(bp.storyboard.frames) && bp.storyboard.frames.length > 0)
      ? bp.storyboard.frames
      : (Array.isArray(bp.storyboardFrames) && bp.storyboardFrames.length > 0 ? bp.storyboardFrames : null);

    // Try cached spec-data first — avoids a 30-90s LLM round-trip on retry.
    try {
      var cached = specExtractor.loadSpecs(taskId, specsDataDir);
      if (cached && cached.length > 0) {
        // Re-validate against current entities; drop cache if entity set drifted.
        var entities = bp.entities || [];
        if (specsAreReusable(cached, entities)) {
          ctx.blueprint.specs = cached;
          ctx.addLog('spec-extract', 'Using cached specs: ' + cached.length + ' phases');
          return Promise.resolve();
        }
        ctx.addLog('spec-extract', 'Cached specs stale (entity mismatch) — re-extracting');
      }
    } catch (e) {
      ctx.addLog('spec-extract', 'Cache lookup failed: ' + e.message + ' — falling through');
    }

    if (!frames) {
      // FATAL — no frames and no cache means we can't produce specs. Failing
      // here is the right answer: downstream would crash in generateSkeleton
      // anyway, and surfacing it at spec-extract puts the error on the correct
      // stage so fingerprint + autofix can target the actual root cause.
      var err = new Error('No storyboard frames and no cached specs — cannot generate phase specs');
      err.classification = 'FATAL';
      return Promise.reject(err);
    }

    ctx.addLog('spec-extract', 'Extracting specs from ' + frames.length + ' storyboard frames...');
    return specExtractor.extractSpecs(frames, {
      projectName: bp.projectName || taskId,
      gameType: bp.gameType || 'SLG',
      entities: bp.entities || [],
    }).then(function(specs) {
      if (!Array.isArray(specs) || specs.length === 0) {
        throw new Error('Spec extractor returned 0 phases');
      }
      ctx.blueprint.specs = specs;
      try { specExtractor.saveSpecs(specs, taskId, specsDataDir); } catch (e) {
        ctx.addLog('spec-extract', 'saveSpecs failed (non-fatal): ' + e.message);
      }
      ctx.addLog('spec-extract', 'Extracted ' + specs.length + ' phase specs');
    });
  }
};