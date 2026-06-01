#!/usr/bin/env node
'use strict';

// task #29 schema bump: migrate fidelityContract v1.0.0 → v1.1.0.
//
// Behavior:
//   1. Scan hud[] for entries matching id ^="label." (v1.0.0 world-label shape).
//   2. For each match, find entities[entityId] (lookup by id, falling back to
//      hud entry's `entity` field).
//   3. If found: move text → entities[entityId].worldLabel (preserves polymorphic
//      shape if already there); drop the hud entry; record { moved }.
//   4. If not found (orphan): keep the hud entry in place; append
//      `unresolvedFidelityGaps[]` entry with blocking:false advisory; record
//      { orphan }.
//   5. hud[].text v1.0.0 single-string entries stay unchanged (forward-compat:
//      lib resolver treats string as default). Polymorphic upgrades are content
//      work, not migration concern — operator can hand-edit per-phase text or
//      regenerate from a phase-aware reverse extractor in a follow-up.
//   6. Bump schemaVersion to '1.1.0'.
//
// Usage:
//   node scripts/migrate-v1.0-to-v1.1.cjs --in <path/in.json> --out <path/out.json>
//   node scripts/migrate-v1.0-to-v1.1.cjs --in <path> --out <path> --dry-run

var fs = require('fs');
var path = require('path');
var fidelityContract = require('../engine/fidelity-contract.cjs');

var WORLD_LABEL_HUD_ID_RE = /^label\./;

function usage(exitCode) {
  console.error('Usage: node scripts/migrate-v1.0-to-v1.1.cjs --in <path/in.json> --out <path/out.json> [--dry-run] [--report <path>]');
  process.exit(exitCode === undefined ? 2 : exitCode);
}

function parseArgs(argv) {
  var opts = { in: null, out: null, dryRun: false, reportPath: null };
  for (var i = 2; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--in') opts.in = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--report') opts.reportPath = argv[++i];
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

function migrate(contract) {
  if (!contract || typeof contract !== 'object') {
    throw new Error('input contract must be an object');
  }
  if (contract.schemaVersion !== '1.0.0' && contract.schemaVersion !== '1.1.0') {
    throw new Error('input schemaVersion must be 1.0.0 or 1.1.0, got ' + contract.schemaVersion);
  }

  var out = JSON.parse(JSON.stringify(contract));

  var entitiesById = {};
  (out.entities || []).forEach(function(e) {
    if (e && e.id) entitiesById[e.id] = e;
  });

  var kept = [];
  var movedReport = [];
  var orphanReport = [];

  (out.hud || []).forEach(function(h) {
    if (!h || typeof h.id !== 'string' || !WORLD_LABEL_HUD_ID_RE.test(h.id)) {
      kept.push(h);
      return;
    }
    var entityId = (typeof h.entity === 'string' && h.entity) || h.id.replace(WORLD_LABEL_HUD_ID_RE, '');
    var entity = entitiesById[entityId];
    if (!entity) {
      kept.push(h);
      orphanReport.push({
        hudId: h.id,
        attemptedEntityId: entityId,
        text: h.text,
        reason: 'no matching entities[] entry'
      });
      return;
    }
    if (entity.worldLabel !== undefined) {
      kept.push(h);
      orphanReport.push({
        hudId: h.id,
        attemptedEntityId: entityId,
        text: h.text,
        reason: 'entity already has worldLabel — manual merge required'
      });
      return;
    }
    entity.worldLabel = h.text;
    movedReport.push({
      hudId: h.id,
      entityId: entityId,
      text: h.text,
      provenance: h.provenance || null
    });
  });

  out.hud = kept;

  if (orphanReport.length) {
    out.unresolvedFidelityGaps = (out.unresolvedFidelityGaps || []).concat(
      orphanReport.map(function(o) {
        return {
          id: 'worldLabel-migration-orphan:' + o.hudId,
          path: 'hud.' + o.hudId,
          message: 'world-label hud entry has no matching entity (' + o.reason + ')',
          blocking: false,
          source: 'migrate-v1.0-to-v1.1',
          context: { hudId: o.hudId, attemptedEntityId: o.attemptedEntityId, text: o.text }
        };
      })
    );
  }

  out.schemaVersion = '1.1.0';

  return {
    contract: out,
    report: {
      kind: 'blueprint.fidelityContract.migrationReport',
      schemaVersion: '1.0.0',
      fromVersion: contract.schemaVersion,
      toVersion: '1.1.0',
      generatedAt: new Date().toISOString(),
      counts: {
        movedToEntityWorldLabel: movedReport.length,
        orphanKeptInHud: orphanReport.length,
        hudBefore: (contract.hud || []).length,
        hudAfter: out.hud.length
      },
      moved: movedReport,
      orphan: orphanReport
    }
  };
}

function main() {
  var opts = parseArgs(process.argv);
  var inPath = path.resolve(opts.in);
  var outPath = path.resolve(opts.out);
  if (!fs.existsSync(inPath)) {
    console.error('input not found: ' + inPath);
    process.exit(1);
  }
  var inputContract = readJson(inPath);
  var migrated = migrate(inputContract);

  // Validate the migrated contract under the canonical validator so we never
  // ship an invalid v1.1 contract.
  var validation = fidelityContract.validateFidelityContract(migrated.contract);
  if (!validation.valid) {
    console.error('migrated contract failed validation:');
    validation.errors.slice(0, 20).forEach(function(e) { console.error('  - ' + e); });
    process.exit(3);
  }

  console.log('=== fidelityContract v1.0.0 → v1.1.0 migration ===');
  console.log(' input              : ' + inPath);
  console.log(' output             : ' + outPath + (opts.dryRun ? ' (DRY RUN, not written)' : ''));
  console.log(' moved to worldLabel: ' + migrated.report.counts.movedToEntityWorldLabel);
  console.log(' orphan kept in hud : ' + migrated.report.counts.orphanKeptInHud);
  console.log(' hud entries        : ' + migrated.report.counts.hudBefore + ' → ' + migrated.report.counts.hudAfter);

  if (migrated.report.counts.orphanKeptInHud > 0) {
    console.log('');
    console.log(' ORPHAN entries (kept in hud[] + unresolvedFidelityGaps[]):');
    migrated.report.orphan.forEach(function(o) {
      console.log('   - ' + o.hudId + ' attemptedEntityId=' + o.attemptedEntityId + ' reason=' + o.reason);
    });
  }

  if (!opts.dryRun) {
    writeJson(outPath, migrated.contract);
    var reportPath = opts.reportPath || (outPath.replace(/\.json$/, '') + '.migration-report.json');
    writeJson(reportPath, migrated.report);
    console.log(' report             : ' + reportPath);
  }

  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { migrate: migrate, WORLD_LABEL_HUD_ID_RE: WORLD_LABEL_HUD_ID_RE };
