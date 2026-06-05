#!/usr/bin/env node
'use strict';

// task #43 (v1.3c) — fidelity-source-diff template-source precedence smoke.
// The diff stage was auto-loading the default v1.0 contract on disk and
// ignoring the enriched v1.2 contract Path B producer attached to
// ctx.blueprint.fidelityContract. That kept the anchor bucket silent in
// the official report. This test pins the precedence we expect:
//   1. ctx.fidelityFieldDiffTemplate already present → keep as-is
//   2. ctx.blueprint.fidelityContract has schemaVersion >= 1.2.0 → use it
//   3. ctx.fidelityContractPath (explicit) on disk → use it
//   4. nothing resolvable → null + WARN log; do not fall back to the
//      space-ranger DEFAULT_CONTRACT_PATH for unrelated tasks
//
// Also covers field-diff lib's new makeTemplateFromContract() directly:
// the unwrap-split-pack mirror, the bare-contract path, and the error
// path on bad input.

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var os = require('os');

var stage = require('../engine/stages/fidelity-source-diff.cjs');
var fieldDiff = require('../engine/stages/lib/field-diff.cjs');

// ─── lib: makeTemplateFromContract surface ────────────────────────────────────
assert.strictEqual(typeof fieldDiff.makeTemplateFromContract, 'function',
  'field-diff exposes makeTemplateFromContract');

// Bare-contract path (no wrapper)
var bareContract = {
  schemaVersion: '1.2.0',
  kind: 'blueprint.fidelityContract',
  entities: [
    { id: 'Player', kind: 'character' },
    { id: 'Coin', kind: 'collectible' }
  ],
  phases: [
    { id: 'phase1', showEntities: ['Player'],
      projectedAnchors: { Player: { x_px: 100, y_px: 100, w_px: 50, h_px: 50, provenance: 'extracted' } } }
  ]
};
var bareTpl = fieldDiff.makeTemplateFromContract(bareContract);
assert.ok(bareTpl, 'bare contract → template');
assert.strictEqual(bareTpl.contract.schemaVersion, '1.2.0');
assert.strictEqual(bareTpl.contractPath, null, 'in-memory template has no contractPath');
assert.strictEqual(typeof bareTpl.diffPhase, 'function');
assert.ok(bareTpl.indexed, 'template is indexed');

// Writer-wrapped path: { contract: {...} } where inner has entities[]
var wrappedContract = { contract: bareContract };
var wrappedTpl = fieldDiff.makeTemplateFromContract(wrappedContract);
assert.strictEqual(wrappedTpl.contract.schemaVersion, '1.2.0',
  'split-pack unwrap surfaces the inner contract');
assert.deepStrictEqual(wrappedTpl.contract.entities.map(function(e) { return e.id; }),
  ['Player', 'Coin'], 'unwrapped entities preserved');

// Bad input → throw (fail loud, not silent fallback)
assert.throws(function() { fieldDiff.makeTemplateFromContract(null); },
  /must be an object/, 'null → throws');
assert.throws(function() { fieldDiff.makeTemplateFromContract('not-an-object'); },
  /must be an object/, 'string → throws');

// ─── stage: resolveFieldDiffTemplate precedence ──────────────────────────────
var resolveFieldDiffTemplate = stage._internals.resolveFieldDiffTemplate;
assert.strictEqual(typeof resolveFieldDiffTemplate, 'function',
  'stage exposes _internals.resolveFieldDiffTemplate');

function makeCtx() {
  var logs = [];
  return {
    logs: logs,
    addLog: function(stageName, msg) { logs.push(stageName + ': ' + msg); },
    blueprint: {}
  };
}

// ─── case 1: v1.2 in-memory contract wins, default path NEVER read ───────────
var ctx1 = makeCtx();
ctx1.blueprint.fidelityContract = bareContract;
// Sabotage the default fallback by setting a bad explicit path — the in-memory
// route must succeed without ever touching disk.
ctx1.fidelityContractPath = '/tmp/should-not-be-read-' + Date.now() + '.json';
var tpl1 = resolveFieldDiffTemplate(ctx1);
assert.ok(tpl1, '1: in-memory v1.2 contract → template returned');
assert.strictEqual(tpl1.contractPath, null, '1: in-memory template has null contractPath (proves no disk read)');
assert.strictEqual(tpl1.contract.schemaVersion, '1.2.0');
assert.strictEqual(ctx1.fidelityFieldDiffTemplate, tpl1, '1: template assigned to ctx');
assert.ok(ctx1.logs.some(function(l) { return l.indexOf('in-memory') >= 0 && l.indexOf('1.2.0') >= 0; }),
  '1: log mentions in-memory route + schemaVersion');

// ─── case 2: v1.1 in-memory contract → falls through to disk path ────────────
var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsd-tpl-'));
var v11Path = path.join(tmpDir, 'v11contract.json');
var v11Contract = {
  schemaVersion: '1.1.0',
  kind: 'blueprint.fidelityContract',
  entities: [{ id: 'Player', kind: 'character' }],
  phases: [{ id: 'phase1', showEntities: ['Player'] }]
};
fs.writeFileSync(v11Path, JSON.stringify(v11Contract));

var ctx2 = makeCtx();
ctx2.blueprint.fidelityContract = v11Contract;
ctx2.fidelityContractPath = v11Path;
var tpl2 = resolveFieldDiffTemplate(ctx2);
assert.ok(tpl2, '2: v1.1 in-memory → falls through, disk path used');
assert.strictEqual(tpl2.contractPath, v11Path,
  '2: contractPath set to explicit ctx.fidelityContractPath (proves disk-load path)');
assert.ok(ctx2.logs.some(function(l) { return l.indexOf(v11Path) >= 0; }),
  '2: log identifies the disk path');

// ─── case 3: no in-memory + explicit ctx.fidelityContractPath → disk wins ────
var v12OnDiskPath = path.join(tmpDir, 'v12contract.json');
fs.writeFileSync(v12OnDiskPath, JSON.stringify(bareContract));

var ctx3 = makeCtx();
ctx3.fidelityContractPath = v12OnDiskPath;
var tpl3 = resolveFieldDiffTemplate(ctx3);
assert.ok(tpl3, '3: explicit path → template');
assert.strictEqual(tpl3.contractPath, v12OnDiskPath);

// ─── case 4: no in-memory + no explicit path → no-template marker ───────────
var DEFAULT_CONTRACT_PATH = stage._internals.DEFAULT_CONTRACT_PATH;
assert.strictEqual(typeof DEFAULT_CONTRACT_PATH, 'string', 'DEFAULT_CONTRACT_PATH exposed');
var ctx4 = makeCtx();
var tpl4 = resolveFieldDiffTemplate(ctx4);
assert.strictEqual(tpl4, null, '4: no task-specific contract → null');
assert.ok(ctx4.logs.some(function(l) { return l.indexOf('WARN') >= 0 && l.indexOf('NOT falling back') >= 0; }),
  '4: WARN log emitted and default fallback is explicitly rejected');

// ─── case 5: in-memory contract missing schemaVersion → treated as < 1.2.0 ───
var ctx5 = makeCtx();
ctx5.blueprint.fidelityContract = { phases: [{ id: 'phase1' }] };  // no schemaVersion
ctx5.fidelityContractPath = v12OnDiskPath;
var tpl5 = resolveFieldDiffTemplate(ctx5);
assert.ok(tpl5, '5: no schemaVersion → falls through to disk');
assert.strictEqual(tpl5.contractPath, v12OnDiskPath,
  '5: missing schemaVersion is NOT v1.2-eligible, must fall through');

// ─── case 6: v1.3.0 schemaVersion (future) → still wins via >= 1.2.0 gate ───
var v13Contract = Object.assign({}, bareContract, { schemaVersion: '1.3.0' });
var ctx6 = makeCtx();
ctx6.blueprint.fidelityContract = v13Contract;
var tpl6 = resolveFieldDiffTemplate(ctx6);
assert.ok(tpl6, '6: v1.3 in-memory → wins (gate is >= 1.2.0)');
assert.strictEqual(tpl6.contractPath, null);
assert.strictEqual(tpl6.contract.schemaVersion, '1.3.0');

// ─── cleanup ─────────────────────────────────────────────────────────────────
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log('v1.3c fidelity-source-diff template-source precedence tests passed');
