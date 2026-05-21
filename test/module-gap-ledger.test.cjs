#!/usr/bin/env node

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var ledger = require('../engine/module-gap-ledger.cjs');

var baseRecord = {
  taskId: 'proj_gap_test',
  timestamp: '2026-05-20T10:00:00.000Z',
  codegenMode: 'schema',
  schemaTokensIn: 12000,
  schemaTokensOut: 2200,
  customLogicUsed: true,
  customLogicTokensIn: 34000,
  customLogicRounds: 2,
  customLogicRoute: 'runner_implementation_gap',
  customLogicRouteReason: 'missing implementation: collect_resource,deliver_resource',
  assemblyImplementationMissingCount: 2,
  assemblyImplementationMissingModuleIds: ['collect_resource', 'deliver_resource'],
  assemblyImplementationCoverage: 0.82,
  assemblyUnresolvedCount: 0,
  assemblyCoverage: 1,
  stages: {
    compile: { rounds: 2 },
    review: { rounds: 1 },
    'cua-verify': { rounds: 1 },
  },
};

var entries = ledger.createGapEntriesFromRecord(baseRecord);
assert.ok(entries.length >= 3, 'custom logic + implementation gap + compile repair should emit entries');
assert.ok(entries.some(function(e) {
  return e.source === 'custom_logic' &&
    e.gapType === 'missing_emitter' &&
    e.moduleIds.indexOf('collect_resource') >= 0 &&
    e.codeTokenIn === 34000 &&
    e.planTokenIn === 12000;
}), 'custom logic implementation gap should preserve route, modules, and token split');
assert.ok(entries.some(function(e) {
  return e.source === 'implementation_coverage' &&
    e.gapType === 'missing_emitter' &&
    e.confidence === 'high';
}), 'missing implementation coverage should emit high-confidence missing_emitter');
assert.ok(entries.some(function(e) {
  return e.source === 'coder_repair' &&
    e.gapType === 'compile_recode_or_repair';
}), 'compile rounds > 1 should emit coder_repair candidate');

var unresolved = ledger.createGapEntriesFromRecord({
  taskId: 'proj_unresolved',
  timestamp: '2026-05-20T10:01:00.000Z',
  customLogicUsed: true,
  customLogicRoute: 'runner_unresolved',
  customLogicRouteReason: 'unresolved 3',
  assemblyUnresolvedCount: 3,
  schemaTokensIn: 1000,
});
assert.ok(unresolved.some(function(e) {
  return e.gapType === 'missing_atom_or_registry_mapping';
}), 'unresolved route should map to missing atom/registry mapping');

var cua = ledger.createGapEntriesFromRecord({
  taskId: 'proj_cua',
  timestamp: '2026-05-20T10:02:00.000Z',
  failedAtStage: 'cua-verify',
  cuaRounds: 3,
  cuaRootCause: 'autoplay-zero-steps',
});
assert.ok(cua.some(function(e) {
  return e.source === 'cua_repair' &&
    e.gapType === 'missing_cua_probe_or_autoplay_mapping' &&
    e.confidence === 'high';
}), 'CUA autoplay-zero-steps should map to CUA probe/autoplay gap');

var silentPass = ledger.createGapEntriesFromRecord({
  taskId: 'proj_silent_pass',
  timestamp: '2026-05-20T10:03:00.000Z',
  cuaRounds: 1,
  cuaReason: 'runtime-contract-passed',
  cuaSilentPass: true,
  cuaSilentPassSignals: ['all-vars-zero'],
});
assert.ok(silentPass.some(function(e) {
  return e.source === 'cua_repair' &&
    e.gapType === 'missing_semantic_assertion' &&
    e.reason.indexOf('silent-pass signals') === 0;
}), 'CUA silent-pass should map to semantic assertion gap instead of passing reason');

var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'module-gap-ledger-'));
var tmpFile = path.join(tmpDir, 'ledger.jsonl');
var written = ledger.recordModuleGapsFromPipelineRecord(baseRecord, { file: tmpFile });
assert.strictEqual(written.length, entries.length, 'recordModuleGapsFromPipelineRecord should return written entries');
var loaded = ledger.loadGapEntries({ file: tmpFile });
assert.strictEqual(loaded.length, entries.length, 'loadGapEntries should read JSONL records back');

var summary = ledger.summarizeModuleGaps(entries.concat(unresolved).concat(cua));
assert.ok(summary.totalGaps >= entries.length + unresolved.length + cua.length, 'summary should count all gaps');
assert.ok(summary.byGapType.some(function(row) { return row.key === 'missing_emitter'; }), 'summary should include missing_emitter');
assert.ok(summary.codeTokenIn >= 34000, 'summary should aggregate code tokens');
assert.ok(summary.planTokenIn >= 12000, 'summary should aggregate plan tokens');

console.log('module-gap-ledger tests passed');
