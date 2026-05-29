#!/usr/bin/env node
'use strict';

// task #37 Path B — fidelity-contract-produce stage unit smoke.
// Verifies:
//   1. Module surface (name, execute, canSkip, _internals)
//   2. loadBaseContract precedence (in-memory > ctx.fidelityContractPath > blueprint.fidelityContractPath)
//   3. alreadyHasProjectedAnchors gating (all-phases-populated → true; any empty → false)
//   4. canSkip env disable
//   5. canSkip no-base-contract path (no throw)
//   6. canSkip materializes in-memory contract from file when already enriched
//   7. execute() no-op when sourceHtmlPath unbound (still surfaces base contract)
//
// Full execute() with puppeteer extraction is out of scope for unit test (matches
// fidelity-source-diff-anchor-bucket.test.cjs convention: stage smoke + lib unit
// tests, integration deferred to pipeline runs).

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var os = require('os');

var stage = require('../engine/stages/fidelity-contract-produce.cjs');

// ─── module surface ────────────────────────────────────────────────────────────
assert.strictEqual(stage.name, 'fidelity-contract-produce');
assert.strictEqual(typeof stage.execute, 'function');
assert.strictEqual(typeof stage.canSkip, 'function');
assert.strictEqual(typeof stage._internals.loadBaseContract, 'function');
assert.strictEqual(typeof stage._internals.alreadyHasProjectedAnchors, 'function');

var loadBaseContract = stage._internals.loadBaseContract;
var alreadyHasProjectedAnchors = stage._internals.alreadyHasProjectedAnchors;

function makeCtx() {
  var logs = [];
  return {
    logs: logs,
    addLog: function(stage, msg) { logs.push(stage + ': ' + msg); },
    blueprint: {}
  };
}

// ─── alreadyHasProjectedAnchors gating ────────────────────────────────────────
assert.strictEqual(alreadyHasProjectedAnchors(null), false, 'null contract → false');
assert.strictEqual(alreadyHasProjectedAnchors({}), false, 'no phases → false');
assert.strictEqual(alreadyHasProjectedAnchors({ phases: [] }), false, 'empty phases → false');
assert.strictEqual(alreadyHasProjectedAnchors({ phases: [{ id: 'p1' }] }), false, 'phase without projectedAnchors → false');
assert.strictEqual(alreadyHasProjectedAnchors({ phases: [{ id: 'p1', projectedAnchors: {} }] }), false, 'empty projectedAnchors → false');
assert.strictEqual(alreadyHasProjectedAnchors({
  phases: [
    { id: 'p1', projectedAnchors: { Player: { x_px: 1, y_px: 2, w_px: 3, h_px: 4, provenance: 'extracted' } } },
    { id: 'p2', projectedAnchors: {} }
  ]
}), false, 'any phase empty → false (gate is "every phase populated")');
assert.strictEqual(alreadyHasProjectedAnchors({
  phases: [
    { id: 'p1', projectedAnchors: { Player: { x_px: 1, y_px: 2, w_px: 3, h_px: 4, provenance: 'extracted' } } },
    { id: 'p2', projectedAnchors: { Coin: { x_px: 5, y_px: 6, w_px: 7, h_px: 8, provenance: 'extracted' } } }
  ]
}), true, 'all phases populated → true');

// ─── loadBaseContract precedence ──────────────────────────────────────────────
// Case A: in-memory wins
var ctxA = {
  blueprint: { fidelityContract: { schemaVersion: '1.1.0', phases: [{ id: 'p1' }] } },
  fidelityContractPath: '/tmp/should-not-be-read.json'
};
var loadedA = loadBaseContract(ctxA);
assert.ok(loadedA, 'A: in-memory contract loaded');
assert.strictEqual(loadedA.source, 'ctx.blueprint.fidelityContract');
assert.strictEqual(loadedA.contract.schemaVersion, '1.1.0');

// Case B: ctx.fidelityContractPath fallback (write a temp file)
var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fcp-test-'));
var tmpContract = path.join(tmpDir, 'fidelityContract.json');
var sampleContract = { schemaVersion: '1.1.0', kind: 'blueprint.fidelityContract', phases: [{ id: 'p1', showEntities: ['Player'] }] };
fs.writeFileSync(tmpContract, JSON.stringify(sampleContract, null, 2));

var ctxB = { blueprint: {}, fidelityContractPath: tmpContract };
var loadedB = loadBaseContract(ctxB);
assert.ok(loadedB, 'B: file path contract loaded');
assert.strictEqual(loadedB.source, tmpContract);
assert.strictEqual(loadedB.contract.schemaVersion, '1.1.0');

// Case C: blueprint.fidelityContractPath fallback
var ctxC = { blueprint: { fidelityContractPath: tmpContract } };
var loadedC = loadBaseContract(ctxC);
assert.ok(loadedC, 'C: blueprint-embedded path loaded');
assert.strictEqual(loadedC.source, tmpContract);

// Case D: nothing resolvable
var ctxD = { blueprint: {} };
assert.strictEqual(loadBaseContract(ctxD), null, 'D: no candidates → null');

// Case E: path candidate that does not exist
var ctxE = { blueprint: {}, fidelityContractPath: '/tmp/definitely-does-not-exist-' + Date.now() + '.json' };
assert.strictEqual(loadBaseContract(ctxE), null, 'E: nonexistent path → null');

// Case F: malformed JSON falls through (no throw)
var malformedPath = path.join(tmpDir, 'malformed.json');
fs.writeFileSync(malformedPath, '{ this is not json');
var ctxF = { blueprint: {}, fidelityContractPath: malformedPath };
assert.strictEqual(loadBaseContract(ctxF), null, 'F: malformed JSON does not crash → null');

// ─── canSkip: env disable ─────────────────────────────────────────────────────
var origDisable = process.env.FIDELITY_CONTRACT_PRODUCE_DISABLE;
process.env.FIDELITY_CONTRACT_PRODUCE_DISABLE = 'true';
assert.strictEqual(stage.canSkip(makeCtx()), true, 'env disable → skip true');
if (origDisable === undefined) delete process.env.FIDELITY_CONTRACT_PRODUCE_DISABLE;
else process.env.FIDELITY_CONTRACT_PRODUCE_DISABLE = origDisable;

// ─── canSkip: no base contract → skip (no throw) ──────────────────────────────
var ctxNoBase = makeCtx();
assert.strictEqual(stage.canSkip(ctxNoBase), true, 'no base contract → skip');
assert.ok(ctxNoBase.logs.some(function(l) { return l.indexOf('no base contract resolvable') >= 0; }),
  'logs explain why we skipped');

// ─── canSkip: already-enriched in-memory → skip ──────────────────────────────
var enrichedContract = {
  schemaVersion: '1.2.0',
  phases: [
    { id: 'p1', projectedAnchors: { Player: { x_px: 100, y_px: 100, w_px: 50, h_px: 50, provenance: 'extracted' } } }
  ]
};
var ctxEnriched = makeCtx();
ctxEnriched.blueprint.fidelityContract = enrichedContract;
assert.strictEqual(stage.canSkip(ctxEnriched), true, 'already-enriched in-memory → skip (idempotent re-entry)');
assert.strictEqual(ctxEnriched.blueprint.fidelityContract, enrichedContract,
  'in-memory preserved unchanged');

// ─── canSkip: enriched file-loaded → skip + materializes into ctx.blueprint ───
var enrichedPath = path.join(tmpDir, 'enriched.json');
fs.writeFileSync(enrichedPath, JSON.stringify(enrichedContract));
var ctxFileEnriched = makeCtx();
ctxFileEnriched.fidelityContractPath = enrichedPath;
assert.strictEqual(stage.canSkip(ctxFileEnriched), true, 'enriched-from-file → skip');
assert.ok(ctxFileEnriched.blueprint.fidelityContract, 'in-memory materialized from file');
assert.strictEqual(ctxFileEnriched.blueprint.fidelityContract.schemaVersion, '1.2.0');

// ─── canSkip: v1.1 in-memory contract with no anchors → NOT skipped ───────────
var v11Contract = {
  schemaVersion: '1.1.0',
  phases: [{ id: 'p1', showEntities: ['Player'] }]
};
var ctxV11 = makeCtx();
ctxV11.blueprint.fidelityContract = v11Contract;
assert.strictEqual(stage.canSkip(ctxV11), false, 'v1.1 contract without projectedAnchors → not skipped (execute will enrich)');

// ─── execute: no sourceHtmlPath → no-op + WARN log, base contract preserved ──
var ctxNoHtml = makeCtx();
ctxNoHtml.blueprint.fidelityContract = v11Contract;
return Promise.resolve(stage.execute(ctxNoHtml)).then(function() {
  assert.strictEqual(ctxNoHtml.blueprint.fidelityContract, v11Contract,
    'no sourceHtmlPath: base contract preserved in-place (no enrichment, no destruction)');
  assert.ok(ctxNoHtml.logs.some(function(l) { return l.indexOf('WARN') >= 0 && l.indexOf('sourceHtmlPath is unbound') >= 0; }),
    'WARN log emitted explaining inability to enrich');

  // ─── execute: bad sourceHtmlPath → throws ───────────────────────────────────
  var ctxBadHtml = makeCtx();
  ctxBadHtml.blueprint.fidelityContract = v11Contract;
  ctxBadHtml.sourceHtmlPath = '/tmp/no-such-html-' + Date.now() + '.html';
  return Promise.resolve()
    .then(function() { return stage.execute(ctxBadHtml); })
    .then(function() { throw new Error('expected execute() to throw for nonexistent sourceHtmlPath'); },
          function(err) {
            assert.ok(/sourceHtmlPath does not exist/.test(err.message),
              'expected sourceHtmlPath-missing error, got: ' + err.message);
          });
}).then(function() {
  // ─── cleanup ───────────────────────────────────────────────────────────────
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('v1.2 fidelity-contract-produce stage tests passed');
}).catch(function(err) {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  console.error(err && err.stack || err);
  process.exit(1);
});
