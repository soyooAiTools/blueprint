'use strict';

/**
 * Stage: fidelity-contract-produce (v1.2 Path B — runtime injection)
 * task #37
 *
 * Purpose: enrich an existing v1.1 fidelityContract with `phases[].projectedAnchors`
 * by running the anchor-extractor against the bound `ctx.sourceHtmlPath` at
 * pipeline-time, so that downstream `compile` (via `helpers.buildVisualAssetsForRequest`)
 * has a v1.2 contract whose anchors the worker writer will surface on
 * `window.__targetAnchors`, which `fidelity-source-diff` then checks.
 *
 * NOT a from-scratch producer: the v1.2 contract surface area (producerVersion,
 * coordinateSystem, rendererAdapter, entities, hud, unityCoverage, ...) cannot
 * be synthesized from runtime extraction alone. This stage strictly augments
 * a base contract that already declares phases + showEntities.
 *
 * Persistence boundary (v6.1 lock, Jonny msg=0ec2b725 / Tim msg=52fe75ad):
 * `selfVisible`/`effectiveVisible`/`viewportIntersection` are NEVER written
 * into `projectedAnchors[entityId]` — they live in the report only. The
 * underlying `migrate()` already applies `sanitizeAnchorForContract`; this
 * stage relies on that rather than re-implementing it.
 *
 * Reads:
 *   ctx.sourceHtmlPath                       (from source-html-bind)
 *   ctx.blueprint.fidelityContract           (in-memory base, preferred)
 *   ctx.fidelityContractPath                 (file fallback)
 *   ctx.blueprint.fidelityContractPath       (file fallback)
 * Writes:
 *   ctx.blueprint.fidelityContract           (enriched, v1.2 if all-clean)
 *   ctx.fidelityContractProduceReport        (extractor + migration stats)
 *
 * canSkip:
 *   - FIDELITY_CONTRACT_PRODUCE_DISABLE=true → skip entirely
 *   - no base contract resolvable → skip (downstream helpers fail-loud path
 *     surfaces the bridge gap explicitly; this stage stays silent so it does
 *     not double-report)
 *   - base contract already has projectedAnchors on every phase → skip
 *   - no ctx.sourceHtmlPath bound → skip (can't extract; addLog WARN)
 */

var fs = require('fs');
var path = require('path');
var fidelityContract = require('../fidelity-contract.cjs');
var migrateLib = require('../../scripts/migrate-v1.1-to-v1.2.cjs');
var migrateV13Lib = require('../../scripts/migrate-v1.2-to-v1.3.cjs');
var migrateV14dLib = require('../../scripts/migrate-v1.3-to-v1.4d.cjs');
var migrateV14eLib = require('../../scripts/migrate-v1.4d-to-v1.4e.cjs');

function gteVersion(a, target) {
  if (typeof a !== 'string') return false;
  var av = a.split('.').map(function(n) { return parseInt(n, 10) || 0; });
  var tv = target.split('.').map(function(n) { return parseInt(n, 10) || 0; });
  for (var i = 0; i < Math.max(av.length, tv.length); i++) {
    var x = av[i] || 0, y = tv[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true;
}

function loadBaseContract(ctx) {
  if (ctx && ctx.blueprint && ctx.blueprint.fidelityContract) {
    return { contract: ctx.blueprint.fidelityContract, source: 'ctx.blueprint.fidelityContract' };
  }
  var candidates = [];
  if (ctx && ctx.fidelityContractPath) candidates.push(ctx.fidelityContractPath);
  if (ctx && ctx.blueprint && ctx.blueprint.fidelityContractPath) candidates.push(ctx.blueprint.fidelityContractPath);
  for (var i = 0; i < candidates.length; i++) {
    var p = candidates[i];
    if (p && fs.existsSync(p)) {
      try {
        return { contract: JSON.parse(fs.readFileSync(p, 'utf8')), source: p };
      } catch (e) {
        // swallow — fall through to next candidate
      }
    }
  }
  return null;
}

function alreadyHasProjectedAnchors(contract) {
  if (!contract || !Array.isArray(contract.phases) || contract.phases.length === 0) return false;
  return contract.phases.every(function(p) {
    return p && p.projectedAnchors && typeof p.projectedAnchors === 'object'
      && Object.keys(p.projectedAnchors).length > 0;
  });
}

// task #52 (v1.4d): contract is already "v1.4d-satisfied" for hud polymorphic?
// True iff there is no migratable work — either hud is absent / empty, or no
// polymorphic-eligible id is present, or every present polymorphic-eligible id
// already has {perPhase: {...}} text shape. False ONLY when at least one
// polymorphic-eligible id exists in hud with plain-string text (i.e. migrate
// would actually rewrite it).
function alreadyHasV14dHudPolymorphic(contract) {
  if (!contract) return false;
  if (!Array.isArray(contract.hud) || contract.hud.length === 0) return true;
  var POLYMORPHIC_HUD_IDS = migrateV14dLib.POLYMORPHIC_HUD_IDS;
  for (var i = 0; i < POLYMORPHIC_HUD_IDS.length; i++) {
    var slotId = POLYMORPHIC_HUD_IDS[i];
    var entry = null;
    for (var j = 0; j < contract.hud.length; j++) {
      if (contract.hud[j] && contract.hud[j].id === slotId) { entry = contract.hud[j]; break; }
    }
    if (!entry) continue; // slot not authored → not a migration target
    if (typeof entry.text === 'string') return false; // plain string → needs migrate
    if (!entry.text || !entry.text.perPhase || typeof entry.text.perPhase !== 'object') {
      return false; // structurally non-polymorphic → needs migrate
    }
  }
  return true;
}

// task #57 (v1.4e Axis A): contract is already "v1.4e-satisfied" for projectedWorldLabels?
// True iff there is no migratable work — either phases array is empty (defer to
// upstream skip), or every phase has nothing to label (showEntities absent or
// empty), or every phase with showEntities has a non-empty projectedWorldLabels
// object. False ONLY when at least one phase carries showEntities but lacks
// projectedWorldLabels coverage (i.e. v1.4e migrate would actually populate).
// Mirrors alreadyHasV14dHudPolymorphic vacuous-satisfaction semantics so legacy
// pre-1.4 fixtures (no showEntities) don't trip the gate.
function alreadyHasV14eWorldLabels(contract) {
  if (!contract || !Array.isArray(contract.phases) || contract.phases.length === 0) return false;
  return contract.phases.every(function(p) {
    if (!p) return true;
    if (!Array.isArray(p.showEntities) || p.showEntities.length === 0) return true;
    return p.projectedWorldLabels && typeof p.projectedWorldLabels === 'object'
      && Object.keys(p.projectedWorldLabels).length > 0;
  });
}

// task #45 (v1.3): contract has the source-HTML-derived field family already?
// True if scene.backgroundColor is set AND every entity (modulo Unity-internal
// auxiliary ones absent from source) has worldLabel.text and primitiveStyle.modelRef.
function alreadyHasV13Fields(contract) {
  if (!contract) return false;
  if (!contract.scene || contract.scene.backgroundColor === undefined) return false;
  var entities = contract.entities || [];
  var stylableCount = 0;
  var coveredCount = 0;
  for (var i = 0; i < entities.length; i++) {
    var e = entities[i];
    var hasLabel = e.worldLabel && typeof e.worldLabel.text === 'string'
      && e.worldLabel.worldOffset && typeof e.worldLabel.worldOffset.y === 'number';
    var hasStyle = e.primitiveStyle && typeof e.primitiveStyle.modelRef === 'string';
    if (hasLabel || hasStyle) stylableCount++;
    if (hasLabel && hasStyle) coveredCount++;
  }
  return stylableCount > 0 && coveredCount >= stylableCount;
}

module.exports = {
  name: 'fidelity-contract-produce',
  canRetry: false,

  canSkip: function(ctx) {
    if (process.env.FIDELITY_CONTRACT_PRODUCE_DISABLE === 'true') {
      ctx.addLog && ctx.addLog('fidelity-contract-produce',
        'SKIPPED via FIDELITY_CONTRACT_PRODUCE_DISABLE=true');
      return true;
    }
    var base = loadBaseContract(ctx);
    if (!base) {
      ctx.addLog && ctx.addLog('fidelity-contract-produce',
        'no base contract resolvable from ctx.blueprint.fidelityContract / fidelityContractPath — skip (helpers.buildVisualAssetsForRequest fail-loud will report)');
      return true;
    }
    // v1.2 anchors AND v1.3 style fields AND v1.4d polymorphic hud all present →
    // fully idempotent, skip execute. Otherwise execute() so the chain steps
    // (v1.1→v1.2 / v1.2→v1.3 / v1.3→v1.4d) each short-circuit internally as needed.
    if (alreadyHasProjectedAnchors(base.contract)
        && alreadyHasV13Fields(base.contract)
        && alreadyHasV14dHudPolymorphic(base.contract)
        && alreadyHasV14eWorldLabels(base.contract)) {
      ctx.addLog && ctx.addLog('fidelity-contract-produce',
        'base contract from ' + base.source + ' already has projectedAnchors + v1.3 style fields + v1.4d hud polymorphic + v1.4e worldLabels — skip (idempotent re-entry)');
      // Materialize in-memory so downstream compile/source-diff sees same object.
      if (!ctx.blueprint) ctx.blueprint = {};
      if (!ctx.blueprint.fidelityContract) ctx.blueprint.fidelityContract = base.contract;
      return true;
    }
    return false;
  },

  execute: function(ctx) {
    var base = loadBaseContract(ctx);
    // Defensive: canSkip already covers null, but guard execute() for direct
    // invocation paths (tests, manual orchestration).
    if (!base) return Promise.resolve();

    if (!ctx.sourceHtmlPath) {
      ctx.addLog && ctx.addLog('fidelity-contract-produce',
        'WARN base contract from ' + base.source + ' lacks projectedAnchors and ctx.sourceHtmlPath is unbound — cannot run anchor-extractor; leaving v1.1 contract for fail-loud downstream');
      if (!ctx.blueprint) ctx.blueprint = {};
      if (!ctx.blueprint.fidelityContract) ctx.blueprint.fidelityContract = base.contract;
      return Promise.resolve();
    }
    if (!fs.existsSync(ctx.sourceHtmlPath)) {
      throw new Error('fidelity-contract-produce: ctx.sourceHtmlPath does not exist: ' + ctx.sourceHtmlPath);
    }

    ctx.addLog && ctx.addLog('fidelity-contract-produce',
      'enriching base contract from ' + base.source + ' (schemaVersion=' + base.contract.schemaVersion + ') with anchor-extractor on ' + path.basename(ctx.sourceHtmlPath));

    // v1.1→v1.2 migrate is idempotent on v1.2 input, but throws on v1.3 input
    // (input contract guard). If the base contract is already v1.3, treat the
    // v1.2 step as a pass-through and proceed directly to the v1.3 chain.
    var v12Promise;
    if (gteVersion(base.contract.schemaVersion, '1.3.0')) {
      ctx.addLog && ctx.addLog('fidelity-contract-produce',
        'v1.2 stage skipped — base contract already at ' + base.contract.schemaVersion);
      v12Promise = Promise.resolve({
        contract: base.contract,
        report: {
          fromVersion: base.contract.schemaVersion,
          toVersion: base.contract.schemaVersion,
          bumpedSchemaVersion: false,
          counts: { extractedCount: 0, anchorOnlyCount: 0, inferredCount: 0, advisoryGapCount: 0 }
        }
      });
    } else {
      v12Promise = migrateLib.migrate(base.contract, {
        sourceHtml: ctx.sourceHtmlPath,
        forceReextract: false
      });
    }
    return v12Promise.then(function(result) {
      var validation = fidelityContract.validateFidelityContract(result.contract);
      if (!validation.valid) {
        var errSummary = validation.errors.slice(0, 5).join('; ');
        throw new Error('fidelity-contract-produce: enriched contract failed validation: ' + errSummary);
      }
      if (!ctx.blueprint) ctx.blueprint = {};
      ctx.blueprint.fidelityContract = result.contract;
      ctx.fidelityContractProduceReport = result.report;
      var c = result.report.counts;
      ctx.addLog && ctx.addLog('fidelity-contract-produce',
        'v1.2 enriched: from=' + result.report.fromVersion +
        ' to=' + result.report.toVersion +
        ' bumped=' + result.report.bumpedSchemaVersion +
        ' extracted=' + c.extractedCount +
        ' anchorOnly=' + c.anchorOnlyCount +
        ' inferred=' + c.inferredCount +
        ' advisoryGaps=' + c.advisoryGapCount);

      // task #45 (v1.3): chain v1.2 → v1.3 reverse-extraction of source HTML
      // style fields (scene.backgroundColor + entity.worldLabel + entity.primitiveStyle).
      // Only runs when the v1.2 stage produced a contract that's at least v1.2
      // (otherwise the v1.3 migrate would refuse on schemaVersion check).
      // No-op when v1.3 fields already present (idempotent re-entry).
      if (!gteVersion(result.contract.schemaVersion, '1.2.0')) {
        ctx.addLog && ctx.addLog('fidelity-contract-produce',
          'v1.3 skipped — upstream contract still at ' + result.contract.schemaVersion + ' (< 1.2.0)');
        return;
      }
      if (alreadyHasV13Fields(result.contract)) {
        ctx.addLog && ctx.addLog('fidelity-contract-produce',
          'v1.3 skipped — scene + worldLabel + primitiveStyle already populated (idempotent re-entry)');
        return;
      }
      var v13 = migrateV13Lib.migrate(result.contract, {
        sourceHtml: ctx.sourceHtmlPath,
        forceReextract: false
      });
      var v13Validation = fidelityContract.validateFidelityContract(v13.contract);
      if (!v13Validation.valid) {
        var v13ErrSummary = v13Validation.errors.slice(0, 5).join('; ');
        throw new Error('fidelity-contract-produce: v1.3 enriched contract failed validation: ' + v13ErrSummary);
      }
      ctx.blueprint.fidelityContract = v13.contract;
      ctx.fidelityContractProduceReportV13 = v13.report;
      var v13c = v13.report.counts;
      ctx.addLog && ctx.addLog('fidelity-contract-produce',
        'v1.3 enriched: from=' + v13.report.fromVersion +
        ' to=' + v13.report.toVersion +
        ' bumped=' + v13.report.bumpedSchemaVersion +
        ' bgExtracted=' + v13c.backgroundColorExtracted +
        ' worldLabelSet=' + v13c.worldLabelPopulated +
        ' primitiveStyleSet=' + v13c.primitiveStylePopulated +
        ' sourceDeclared=' + (v13c.sourceDeclaredEntities || 0) +
        ' auxMissing=' + v13c.entitiesMissingFromSource);

      // task #52 (v1.4d-ε): chain v1.3 → v1.4d hud polymorphic fold.
      // Source HTML PHASES[].guideText folded into {perPhase: {...}} for the
      // 3 phase-dynamic hud slots. No-op if already polymorphic (idempotent).
      if (!gteVersion(v13.contract.schemaVersion, '1.3.0')) {
        ctx.addLog && ctx.addLog('fidelity-contract-produce',
          'v1.4d skipped — upstream contract still at ' + v13.contract.schemaVersion + ' (< 1.3.0)');
        return;
      }
      if (alreadyHasV14dHudPolymorphic(v13.contract)) {
        ctx.addLog && ctx.addLog('fidelity-contract-produce',
          'v1.4d skipped — hud.phase / hud.tip / hud.targethint already polymorphic (idempotent re-entry)');
        return;
      }
      var v14d = migrateV14dLib.migrate(v13.contract, {
        sourceHtml: ctx.sourceHtmlPath,
        forceReextract: false
      });
      var v14dValidation = fidelityContract.validateFidelityContract(v14d.contract);
      if (!v14dValidation.valid) {
        var v14dErrSummary = v14dValidation.errors.slice(0, 5).join('; ');
        throw new Error('fidelity-contract-produce: v1.4d enriched contract failed validation: ' + v14dErrSummary);
      }
      ctx.blueprint.fidelityContract = v14d.contract;
      ctx.fidelityContractProduceReportV14d = v14d.report;
      var v14dc = v14d.report.counts;
      ctx.addLog && ctx.addLog('fidelity-contract-produce',
        'v1.4d enriched: from=' + v14d.report.fromVersion +
        ' to=' + v14d.report.toVersion +
        ' bumped=' + v14d.report.bumpedSchemaVersion +
        ' phasesExtracted=' + v14dc.phasesExtracted +
        ' hudSlotsRewritten=' + v14dc.hudSlotsRewritten +
        ' hudSlotsAlreadyPolymorphic=' + v14dc.hudSlotsAlreadyPolymorphic +
        ' hudSlotsMissingInContract=' + v14dc.hudSlotsMissingInContract);

      // task #57 (v1.4e Axis A): chain v1.4d → v1.4e worldlabel-extractor.
      // Source HTML Sprite labels projected to screen-space rects per phase
      // per entity. Worker (#56 PR #40) consumes as DOM rect-fit target;
      // Stage 5 field-diff promotes to blocking at v1.5+. No-op if already
      // populated (idempotent).
      if (!gteVersion(v14d.contract.schemaVersion, '1.4.0')) {
        ctx.addLog && ctx.addLog('fidelity-contract-produce',
          'v1.4e skipped — upstream contract still at ' + v14d.contract.schemaVersion + ' (< 1.4.0)');
        return;
      }
      if (alreadyHasV14eWorldLabels(v14d.contract)) {
        ctx.addLog && ctx.addLog('fidelity-contract-produce',
          'v1.4e skipped — every phase already has projectedWorldLabels (idempotent re-entry)');
        return;
      }
      return migrateV14eLib.migrate(v14d.contract, {
        sourceHtml: ctx.sourceHtmlPath,
        forceReextract: false
      }).then(function(v14e) {
        var v14eValidation = fidelityContract.validateFidelityContract(v14e.contract);
        if (!v14eValidation.valid) {
          var v14eErrSummary = v14eValidation.errors.slice(0, 5).join('; ');
          throw new Error('fidelity-contract-produce: v1.4e enriched contract failed validation: ' + v14eErrSummary);
        }
        ctx.blueprint.fidelityContract = v14e.contract;
        ctx.fidelityContractProduceReportV14e = v14e.report;
        var v14ec = v14e.report.counts;
        ctx.addLog && ctx.addLog('fidelity-contract-produce',
          'v1.4e enriched: from=' + v14e.report.fromVersion +
          ' to=' + v14e.report.toVersion +
          ' bumped=' + v14e.report.bumpedSchemaVersion +
          ' extracted=' + v14ec.extractedCount +
          ' noLabel=' + v14ec.noLabelCount +
          ' inferred=' + v14ec.inferredCount +
          ' advisoryGaps=' + v14ec.advisoryGapCount);
      });
    });
  },

  _internals: {
    loadBaseContract: loadBaseContract,
    alreadyHasProjectedAnchors: alreadyHasProjectedAnchors,
    alreadyHasV13Fields: alreadyHasV13Fields,
    alreadyHasV14dHudPolymorphic: alreadyHasV14dHudPolymorphic,
    alreadyHasV14eWorldLabels: alreadyHasV14eWorldLabels,
    gteVersion: gteVersion
  }
};
