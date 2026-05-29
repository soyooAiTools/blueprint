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
    if (alreadyHasProjectedAnchors(base.contract)) {
      ctx.addLog && ctx.addLog('fidelity-contract-produce',
        'base contract from ' + base.source + ' already has projectedAnchors on every phase — skip (idempotent re-entry)');
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

    return migrateLib.migrate(base.contract, {
      sourceHtml: ctx.sourceHtmlPath,
      forceReextract: false
    }).then(function(result) {
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
    });
  },

  _internals: {
    loadBaseContract: loadBaseContract,
    alreadyHasProjectedAnchors: alreadyHasProjectedAnchors
  }
};
