#!/usr/bin/env node
'use strict';

// task #?? schema bump: migrate fidelityContract v1.1.0 → v1.2.0.
// Locked design: /root/.slock/agents/131d4ea0-d56a-406e-9cb3-f90999d73977/notes/v1.2-camera-transform-schema-draft.md (v6.1 triple sign-off).
//
// Behavior:
//   1. Accept v1.1.0 OR v1.2.0 input (idempotent — re-running on v1.2.0 is no-op
//      unless --force-reextract).
//   2. For each phase[i]:
//      - cameraTransform absent → emit default template
//        { position:[0,0,0], lookAt:[0,0,0], fov:50, projection:'perspective',
//          provenance:'inferred-default' }
//        (cameraTransform is informative-only; no camera-extractor required.)
//      - projectedAnchors absent (or --force-reextract) → run anchor-extractor
//        against source HTML using Tier order 1→2→3.
//        - All entityIds extracted → write each as { x_px, y_px, w_px, h_px,
//          depth_ndc?, provenance:'extracted'|'anchor-only', lookupPath,
//          matchedAlias, resolverRule }.
//        - Extractor failure (Tier D) → leave projectedAnchors:{} + append
//          unresolvedFidelityGaps[] advisory entry.
//   3. CONDITIONAL schemaVersion bump (Jonny Blocking 2 / Tim msg=02dd762a):
//      - Bump 1.1.0 → 1.2.0 IFF every phase has projectedAnchors populated AND
//        every anchor has provenance ∈ {extracted, anchor-only} (NO
//        inferred-default entries in projectedAnchors).
//      - Otherwise: stay at 1.1.0. Migration report: partialMigration:true,
//        bumpedSchemaVersion:false, exit code 0.
//   4. Write migration report with { extractedCount, anchorOnlyCount,
//      inferredCount, advisoryGapCount, partialMigration, bumpedSchemaVersion,
//      perPhaseStatus[], nameResolution[], visibilityAudit[] }.
//      - nameResolution[]: per (phase, entity) — {phaseId, contractId, sourceName,
//        resolverRule}.
//      - visibilityAudit[]: per (phase, entity) — {phaseId, contractId,
//        effectiveVisible, viewportIntersection, reason?}.
//      - Both arrays live in the REPORT only; NEVER written into the contract.
//   5. Persistence boundary (Jonny msg=0ec2b725 / Tim msg=52fe75ad):
//      effectiveVisible / selfVisible / viewportIntersection are NEVER written
//      into projectedAnchors[id]. Writer + field-diff derive viewportIntersection
//      at consume time from x_px/y_px/w_px/h_px against viewport baseline
//      1280×720.
//
// Usage:
//   node scripts/migrate-v1.1-to-v1.2.cjs --in <path/in.json> --out <path/out.json>
//                                         --source-html <path/source.html>
//                                         [--dry-run] [--report <path>]
//                                         [--force-reextract]

var fs = require('fs');
var path = require('path');
var fidelityContract = require('../engine/fidelity-contract.cjs');

// anchor-extractor is loaded lazily so --dry-run / --help do not pull puppeteer.
function loadAnchorExtractor() {
  return require('../engine/stages/lib/anchor-extractor.cjs');
}

var DEFAULT_CAMERA_TRANSFORM = {
  position: [0, 0, 0],
  lookAt: [0, 0, 0],
  fov: 50,
  projection: 'perspective',
  provenance: 'inferred-default'
};

function usage(exitCode) {
  console.error('Usage: node scripts/migrate-v1.1-to-v1.2.cjs --in <path/in.json> --out <path/out.json> [--source-html <path>] [--dry-run] [--report <path>] [--force-reextract]');
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

// PoC empirical: anchor record has these required keys at consume time.
// effectiveVisible / selfVisible / viewportIntersection MUST NOT be written
// into contract (v6.1 persistence boundary).
var CONTRACT_ANCHOR_REQUIRED = ['x_px', 'y_px', 'w_px', 'h_px', 'provenance'];
var CONTRACT_ANCHOR_OPTIONAL = ['depth_ndc', 'lookupPath', 'matchedAlias', 'resolverRule'];
var CONTRACT_ANCHOR_FORBIDDEN = ['selfVisible', 'effectiveVisible', 'viewportIntersection'];

function sanitizeAnchorForContract(rawAnchor) {
  var out = {};
  CONTRACT_ANCHOR_REQUIRED.forEach(function(k) { out[k] = rawAnchor[k]; });
  CONTRACT_ANCHOR_OPTIONAL.forEach(function(k) {
    if (rawAnchor[k] !== undefined) out[k] = rawAnchor[k];
  });
  // Defense in depth — never let forbidden keys slip into contract surface.
  CONTRACT_ANCHOR_FORBIDDEN.forEach(function(k) {
    if (k in out) delete out[k];
  });
  return out;
}

async function migrate(contract, opts) {
  if (!contract || typeof contract !== 'object') {
    throw new Error('input contract must be an object');
  }
  if (contract.schemaVersion !== '1.1.0' && contract.schemaVersion !== '1.2.0') {
    throw new Error('input schemaVersion must be 1.1.0 or 1.2.0, got ' + contract.schemaVersion);
  }

  var out = deepClone(contract);
  var phases = out.phases || [];

  var report = {
    kind: 'blueprint.fidelityContract.migrationReport',
    schemaVersion: '1.2.0',
    fromVersion: contract.schemaVersion,
    toVersion: null, // filled at end based on conditional bump
    generatedAt: new Date().toISOString(),
    counts: {
      phases: phases.length,
      extractedCount: 0,
      anchorOnlyCount: 0,
      inferredCount: 0,
      advisoryGapCount: 0,
      cameraTransformDefaulted: 0
    },
    partialMigration: false,
    bumpedSchemaVersion: false,
    perPhaseStatus: [],
    nameResolution: [],
    visibilityAudit: [],
    advisoryGaps: []
  };

  // Extractor is invoked once per source-html for all phases — it owns the
  // puppeteer lifecycle, drives __driveToPhase(n) for each phase, returns a
  // map { phaseId → { anchors: { entityId → rawAnchorRecord }, nameResolution[], visibilityAudit[] } }.
  var extractorOutput = null;
  if (opts.sourceHtml && (opts.forceReextract || phases.some(needsExtraction))) {
    var extractor = loadAnchorExtractor();
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
      cameraTransform: 'present',
      projectedAnchors: 'present',
      anchorCounts: { extracted: 0, anchorOnly: 0, inferred: 0 },
      missingEntityIds: []
    };

    // 1) cameraTransform default
    if (!ph.cameraTransform) {
      ph.cameraTransform = deepClone(DEFAULT_CAMERA_TRANSFORM);
      phaseStatus.cameraTransform = 'defaulted';
      report.counts.cameraTransformDefaulted++;
    }

    // 2) projectedAnchors backfill
    var needsBackfill = !ph.projectedAnchors || opts.forceReextract;
    if (needsBackfill) {
      ph.projectedAnchors = ph.projectedAnchors || {};
      var phaseExtract = extractorOutput && extractorOutput[ph.id];
      var showEntities = ph.showEntities || [];
      if (!phaseExtract) {
        phaseStatus.projectedAnchors = 'extractor-failed-all-tiers';
        phaseStatus.missingEntityIds = showEntities.slice();
        report.counts.advisoryGapCount++;
        report.advisoryGaps.push({
          id: 'projectedAnchors:' + ph.id,
          path: 'phases[' + i + '].projectedAnchors',
          message: 'anchor-extractor produced no result for phase ' + ph.id,
          blocking: false,
          source: 'migrate-v1.1-to-v1.2',
          kind: 'projectedAnchors'
        });
      } else {
        for (var j = 0; j < showEntities.length; j++) {
          var entId = showEntities[j];
          var raw = phaseExtract.anchors && phaseExtract.anchors[entId];
          if (!raw) {
            // entity expected but extractor returned nothing for it
            phaseStatus.missingEntityIds.push(entId);
            ph.projectedAnchors[entId] = {
              x_px: 0, y_px: 0, w_px: 0, h_px: 0,
              provenance: 'inferred-default'
            };
            phaseStatus.anchorCounts.inferred++;
            report.counts.inferredCount++;
            report.counts.advisoryGapCount++;
            report.advisoryGaps.push({
              id: 'projectedAnchor-missing:' + ph.id + ':' + entId,
              path: 'phases[' + i + '].projectedAnchors.' + entId,
              message: 'showEntity ' + entId + ' missing from extractor result',
              blocking: false,
              source: 'migrate-v1.1-to-v1.2',
              kind: 'projectedAnchors'
            });
          } else {
            // Persistence boundary: strip derived booleans before writing
            // into contract. Audit fields (lookupPath/matchedAlias/resolverRule)
            // are optional contract fields and may be retained.
            ph.projectedAnchors[entId] = sanitizeAnchorForContract(raw);
            if (raw.provenance === 'extracted') {
              phaseStatus.anchorCounts.extracted++;
              report.counts.extractedCount++;
            } else if (raw.provenance === 'anchor-only') {
              phaseStatus.anchorCounts.anchorOnly++;
              report.counts.anchorOnlyCount++;
            } else if (raw.provenance === 'inferred-default') {
              phaseStatus.anchorCounts.inferred++;
              report.counts.inferredCount++;
            }
          }
        }
        // Merge extractor's nameResolution + visibilityAudit (report-only).
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

  // 3) Conditional schemaVersion bump
  var allClean = (
    phases.length > 0 &&
    report.counts.inferredCount === 0 &&
    report.counts.advisoryGapCount === 0 &&
    report.perPhaseStatus.every(function(s) { return s.missingEntityIds.length === 0; })
  );

  if (allClean) {
    out.schemaVersion = '1.2.0';
    report.toVersion = '1.2.0';
    report.bumpedSchemaVersion = true;
    report.partialMigration = false;
  } else {
    // Stay at input schemaVersion (no bump).
    out.schemaVersion = contract.schemaVersion;
    report.toVersion = contract.schemaVersion;
    report.bumpedSchemaVersion = false;
    report.partialMigration = true;
  }

  // Append advisory gaps to contract for transparency at runtime.
  if (report.advisoryGaps.length) {
    out.unresolvedFidelityGaps = (out.unresolvedFidelityGaps || []).concat(
      report.advisoryGaps.map(function(g) { return deepClone(g); })
    );
  }

  return { contract: out, report: report };
}

function needsExtraction(phase) {
  return !phase.projectedAnchors || Object.keys(phase.projectedAnchors).length === 0;
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

  // Validate the migrated contract under the canonical validator so we never
  // ship an invalid contract (works for both 1.1.0 stay-at and 1.2.0 bump).
  var validation = fidelityContract.validateFidelityContract(migrated.contract);
  if (!validation.valid) {
    console.error('migrated contract failed validation:');
    validation.errors.slice(0, 20).forEach(function(e) { console.error('  - ' + e); });
    process.exit(3);
  }

  console.log('=== fidelityContract v1.1.0 → v1.2.0 migration ===');
  console.log(' input              : ' + inPath);
  console.log(' output             : ' + outPath + (opts.dryRun ? ' (DRY RUN, not written)' : ''));
  console.log(' phases             : ' + migrated.report.counts.phases);
  console.log(' extracted          : ' + migrated.report.counts.extractedCount);
  console.log(' anchor-only        : ' + migrated.report.counts.anchorOnlyCount);
  console.log(' inferred-default   : ' + migrated.report.counts.inferredCount);
  console.log(' camera defaulted   : ' + migrated.report.counts.cameraTransformDefaulted);
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
  DEFAULT_CAMERA_TRANSFORM: DEFAULT_CAMERA_TRANSFORM,
  CONTRACT_ANCHOR_REQUIRED: CONTRACT_ANCHOR_REQUIRED,
  CONTRACT_ANCHOR_OPTIONAL: CONTRACT_ANCHOR_OPTIONAL,
  CONTRACT_ANCHOR_FORBIDDEN: CONTRACT_ANCHOR_FORBIDDEN,
  sanitizeAnchorForContract: sanitizeAnchorForContract
};
