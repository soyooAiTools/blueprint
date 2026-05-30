#!/usr/bin/env node
'use strict';

// task #57 (v1.4e Axis A) schema bump: migrate fidelityContract v1.4.0 → v1.5.0.
// Closes the residual visual gap caught by youth-nick on v1.4d main b8c73da
// (msg=29785d5a, SellCounter label rendered visually high) by adding per-phase
// per-entity world-label screen-rect — populated via headless Three.js Sprite
// billboard projection (engine/stages/lib/worldlabel-extractor.cjs). Parallels
// the v1.2 anchor-extractor pipeline; persistence boundary mirrors v1.2
// (no visibility booleans in contract).
//
// Behavior:
//   1. Accept v1.4.0 OR v1.5.0 input (idempotent — re-running on v1.5.0 is
//      no-op unless --force-reextract).
//   2. For each phase[i]:
//      - projectedWorldLabels absent (or --force-reextract) → run
//        worldlabel-extractor against source HTML.
//        - All entityIds extracted → write each as
//          { x, y, width, height, centerX, centerY, provenance:'extracted'|
//            'no-label', lookupPath, matchedAlias, resolverRule }.
//        - Sprite-less entity → write provenance:'no-label' with zero numerics
//          (Stage 5 field-diff suppresses no-label records).
//        - Extractor failure → leave projectedWorldLabels:{} + append
//          unresolvedFidelityGaps[] advisory.
//   3. CONDITIONAL schemaVersion bump:
//      - Bump 1.4.0 → 1.5.0 IFF every phase has projectedWorldLabels populated
//        AND every record has provenance ∈ {extracted, no-label} (NO
//        inferred-default entries).
//      - Otherwise: stay at 1.4.0. Migration report: partialMigration:true,
//        bumpedSchemaVersion:false, exit code 0.
//   4. Write migration report with { extractedCount, noLabelCount,
//      inferredCount, advisoryGapCount, partialMigration,
//      bumpedSchemaVersion, perPhaseStatus[], nameResolution[],
//      visibilityAudit[] }.
//      - nameResolution[]: per (phase, entity) — {phaseId, contractId,
//        sourceName, resolverRule}.
//      - visibilityAudit[]: per (phase, entity) — {phaseId, contractId,
//        effectiveVisible, viewportIntersection, hasSprite, reason?}.
//      - Both arrays live in the REPORT only; NEVER written into the contract.
//   5. Persistence boundary (v6.1 locked, mirrors v1.2):
//      selfVisible / effectiveVisible / viewportIntersection / visible are
//      NEVER written into projectedWorldLabels[id]. Worker (#56 PR #40) +
//      Stage 5 field-diff derive viewportIntersection at consume time from
//      x/y/width/height against viewport baseline 1280×720.
//
// Usage:
//   node scripts/migrate-v1.4d-to-v1.4e.cjs --in <path/in.json>
//                                            --out <path/out.json>
//                                            [--source-html <path>]
//                                            [--dry-run] [--report <path>]
//                                            [--force-reextract]

var fs = require('fs');
var path = require('path');
var fidelityContract = require('../engine/fidelity-contract.cjs');

function loadWorldLabelExtractor() {
  return require('../engine/stages/lib/worldlabel-extractor.cjs');
}

function usage(exitCode) {
  console.error('Usage: node scripts/migrate-v1.4d-to-v1.4e.cjs --in <path> --out <path> [--source-html <path>] [--dry-run] [--report <path>] [--force-reextract]');
  process.exit(exitCode === undefined ? 2 : exitCode);
}

function parseArgs(argv) {
  var opts = {
    in: null, out: null, sourceHtml: null, dryRun: false,
    reportPath: null, forceReextract: false
  };
  for (var i = 2; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--in') opts.in = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--source-html') opts.sourceHtml = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--report') opts.reportPath = argv[++i];
    else if (a === '--force-reextract') opts.forceReextract = true;
    else if (a === '--help' || a === '-h') usage(0);
    else usage();
  }
  if (!opts.in || !opts.out) usage();
  return opts;
}

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

function writeJson(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function deepClone(v) { return JSON.parse(JSON.stringify(v)); }

// Contract surface keys for projectedWorldLabels[entityId]. Mirrors
// CONTRACT_ANCHOR_* from migrate-v1.1-to-v1.2.cjs but uses DOM-rect names
// per Jonny msg=fd1a7e7a interface lock.
var CONTRACT_WORLDLABEL_REQUIRED = ['x', 'y', 'width', 'height', 'centerX', 'centerY', 'provenance'];
var CONTRACT_WORLDLABEL_OPTIONAL = ['lookupPath', 'matchedAlias', 'resolverRule'];
var CONTRACT_WORLDLABEL_FORBIDDEN = ['selfVisible', 'effectiveVisible', 'viewportIntersection', 'visible'];

function sanitizeWorldLabelForContract(raw) {
  var out = {};
  CONTRACT_WORLDLABEL_REQUIRED.forEach(function(k) { out[k] = raw[k]; });
  CONTRACT_WORLDLABEL_OPTIONAL.forEach(function(k) {
    if (raw[k] !== undefined) out[k] = raw[k];
  });
  CONTRACT_WORLDLABEL_FORBIDDEN.forEach(function(k) {
    if (k in out) delete out[k];
  });
  return out;
}

function emptyInferredRecord() {
  return {
    x: 0, y: 0, width: 0, height: 0, centerX: 0, centerY: 0,
    provenance: 'inferred-default'
  };
}

function needsExtraction(phase) {
  return !phase.projectedWorldLabels || Object.keys(phase.projectedWorldLabels).length === 0;
}

async function migrate(contract, opts) {
  if (!contract || typeof contract !== 'object') {
    throw new Error('input contract must be an object');
  }
  if (contract.schemaVersion !== '1.4.0' && contract.schemaVersion !== '1.5.0') {
    throw new Error('input schemaVersion must be 1.4.0 or 1.5.0, got ' + contract.schemaVersion);
  }

  var out = deepClone(contract);
  var phases = out.phases || [];

  var report = {
    kind: 'blueprint.fidelityContract.migrationReport',
    schemaVersion: '1.5.0',
    fromVersion: contract.schemaVersion,
    toVersion: null,
    generatedAt: new Date().toISOString(),
    counts: {
      phases: phases.length,
      extractedCount: 0,
      noLabelCount: 0,
      inferredCount: 0,
      advisoryGapCount: 0
    },
    partialMigration: false,
    bumpedSchemaVersion: false,
    perPhaseStatus: [],
    nameResolution: [],
    visibilityAudit: [],
    advisoryGaps: []
  };

  var extractorOutput = null;
  if (opts.sourceHtml && (opts.forceReextract || phases.some(needsExtraction))) {
    var extractor = loadWorldLabelExtractor();
    extractorOutput = await extractor.extractFromSourceHtml({
      sourceHtmlPath: opts.sourceHtml,
      phases: phases.map(function(p) { return { id: p.id, showEntities: p.showEntities || [] }; }),
      entitiesCatalog: out.entities || [],
      viewportBaseline: { width: 1280, height: 720 }
    });
  }

  for (var i = 0; i < phases.length; i++) {
    var ph = phases[i];
    var phaseStatus = {
      phaseId: ph.id,
      projectedWorldLabels: 'present',
      labelCounts: { extracted: 0, noLabel: 0, inferred: 0 },
      missingEntityIds: []
    };

    var needsBackfill = !ph.projectedWorldLabels || opts.forceReextract;
    if (needsBackfill) {
      ph.projectedWorldLabels = ph.projectedWorldLabels || {};
      var phaseExtract = extractorOutput && extractorOutput[ph.id];
      var showEntities = ph.showEntities || [];
      if (!phaseExtract) {
        phaseStatus.projectedWorldLabels = 'extractor-failed-all-tiers';
        phaseStatus.missingEntityIds = showEntities.slice();
        // Pre-populate inferred-default so the contract still validates
        // shape-wise at v1.4.0 (no bump). Stage 5 advisory covers severity.
        showEntities.forEach(function(entId) {
          ph.projectedWorldLabels[entId] = emptyInferredRecord();
          phaseStatus.labelCounts.inferred++;
          report.counts.inferredCount++;
        });
        if (showEntities.length > 0) {
          report.counts.advisoryGapCount++;
          report.advisoryGaps.push({
            id: 'projectedWorldLabels:' + ph.id,
            path: 'phases[' + i + '].projectedWorldLabels',
            message: 'worldlabel-extractor produced no result for phase ' + ph.id,
            blocking: false,
            source: 'migrate-v1.4d-to-v1.4e',
            kind: 'projectedWorldLabels'
          });
        }
      } else {
        for (var j = 0; j < showEntities.length; j++) {
          var entId = showEntities[j];
          var raw = phaseExtract.worldLabels && phaseExtract.worldLabels[entId];
          if (!raw) {
            phaseStatus.missingEntityIds.push(entId);
            ph.projectedWorldLabels[entId] = emptyInferredRecord();
            phaseStatus.labelCounts.inferred++;
            report.counts.inferredCount++;
            report.counts.advisoryGapCount++;
            report.advisoryGaps.push({
              id: 'projectedWorldLabel-missing:' + ph.id + ':' + entId,
              path: 'phases[' + i + '].projectedWorldLabels.' + entId,
              message: 'showEntity ' + entId + ' missing from worldlabel-extractor result',
              blocking: false,
              source: 'migrate-v1.4d-to-v1.4e',
              kind: 'projectedWorldLabels'
            });
          } else {
            ph.projectedWorldLabels[entId] = sanitizeWorldLabelForContract(raw);
            if (raw.provenance === 'extracted') {
              phaseStatus.labelCounts.extracted++;
              report.counts.extractedCount++;
            } else if (raw.provenance === 'no-label') {
              phaseStatus.labelCounts.noLabel++;
              report.counts.noLabelCount++;
            } else if (raw.provenance === 'inferred-default') {
              phaseStatus.labelCounts.inferred++;
              report.counts.inferredCount++;
            }
          }
        }
        if (Array.isArray(phaseExtract.nameResolution)) {
          phaseExtract.nameResolution.forEach(function(r) { report.nameResolution.push(r); });
        }
        if (Array.isArray(phaseExtract.visibilityAudit)) {
          phaseExtract.visibilityAudit.forEach(function(r) { report.visibilityAudit.push(r); });
        }
      }
    }

    report.perPhaseStatus.push(phaseStatus);
  }

  // Conditional schemaVersion bump (parallel to v1.1→v1.2). `no-label` is a
  // legitimate terminal provenance (Sprite-less entity); it does NOT block.
  var allClean = (
    phases.length > 0 &&
    report.counts.inferredCount === 0 &&
    report.counts.advisoryGapCount === 0 &&
    report.perPhaseStatus.every(function(s) { return s.missingEntityIds.length === 0; })
  );

  if (allClean) {
    out.schemaVersion = '1.5.0';
    report.toVersion = '1.5.0';
    report.bumpedSchemaVersion = true;
    report.partialMigration = false;
  } else {
    out.schemaVersion = contract.schemaVersion;
    report.toVersion = contract.schemaVersion;
    report.bumpedSchemaVersion = false;
    report.partialMigration = true;
  }

  if (report.advisoryGaps.length) {
    out.unresolvedFidelityGaps = (out.unresolvedFidelityGaps || []).concat(
      report.advisoryGaps.map(function(g) { return deepClone(g); })
    );
  }

  return { contract: out, report: report };
}

async function main() {
  var opts = parseArgs(process.argv);
  var inPath = path.resolve(opts.in);
  var outPath = path.resolve(opts.out);
  if (!fs.existsSync(inPath)) {
    console.error('input not found: ' + inPath);
    process.exit(1);
  }
  if (opts.sourceHtml && !fs.existsSync(path.resolve(opts.sourceHtml))) {
    console.error('source-html not found: ' + opts.sourceHtml);
    process.exit(1);
  }

  var inputContract = readJson(inPath);
  var migrated = await migrate(inputContract, opts);

  var validation = fidelityContract.validateFidelityContract(migrated.contract);
  if (!validation.valid) {
    console.error('migrated contract failed validation:');
    validation.errors.slice(0, 20).forEach(function(e) { console.error('  - ' + e); });
    process.exit(3);
  }

  console.log('=== fidelityContract v1.4.0 → v1.5.0 migration (task #57) ===');
  console.log(' input              : ' + inPath);
  console.log(' output             : ' + outPath + (opts.dryRun ? ' (DRY RUN, not written)' : ''));
  console.log(' phases             : ' + migrated.report.counts.phases);
  console.log(' extracted          : ' + migrated.report.counts.extractedCount);
  console.log(' no-label           : ' + migrated.report.counts.noLabelCount);
  console.log(' inferred-default   : ' + migrated.report.counts.inferredCount);
  console.log(' advisory gaps      : ' + migrated.report.counts.advisoryGapCount);
  console.log(' fromVersion        : ' + migrated.report.fromVersion);
  console.log(' toVersion          : ' + migrated.report.toVersion);
  console.log(' bumped             : ' + (migrated.report.bumpedSchemaVersion ? 'yes' : 'no — partial migration, contract stays at ' + migrated.report.fromVersion));

  if (!opts.dryRun) {
    writeJson(outPath, migrated.contract);
    var reportPath = opts.reportPath || (outPath.replace(/\.json$/, '') + '.migration-report.json');
    writeJson(reportPath, migrated.report);
    console.log(' report             : ' + reportPath);
  }

  process.exit(0);
}

if (require.main === module) {
  main().catch(function(e) {
    console.error(e && e.stack ? e.stack : e);
    process.exit(1);
  });
}

module.exports = {
  migrate: migrate,
  CONTRACT_WORLDLABEL_REQUIRED: CONTRACT_WORLDLABEL_REQUIRED,
  CONTRACT_WORLDLABEL_OPTIONAL: CONTRACT_WORLDLABEL_OPTIONAL,
  CONTRACT_WORLDLABEL_FORBIDDEN: CONTRACT_WORLDLABEL_FORBIDDEN,
  sanitizeWorldLabelForContract: sanitizeWorldLabelForContract,
  emptyInferredRecord: emptyInferredRecord,
  needsExtraction: needsExtraction
};
