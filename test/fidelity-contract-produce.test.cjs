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

// ─── canSkip: v1.2-anchors-only in-memory → NOT skipped (v1.3 chain runs) ─────
// task #45: canSkip gate now requires BOTH v1.2 anchors AND v1.3 fields. A
// contract that's only v1.2-anchor-enriched must fall through to execute() so
// the v1.3 chain has a chance to populate scene + worldLabel + primitiveStyle.
var v12OnlyContract = {
  schemaVersion: '1.2.0',
  phases: [
    { id: 'p1', projectedAnchors: { Player: { x_px: 100, y_px: 100, w_px: 50, h_px: 50, provenance: 'extracted' } } }
  ]
};
var ctxV12Only = makeCtx();
ctxV12Only.blueprint.fidelityContract = v12OnlyContract;
assert.strictEqual(stage.canSkip(ctxV12Only), false,
  'v1.2 anchors only (no v1.3 fields) → not skipped (execute will run v1.3 chain)');

// ─── canSkip: fully-enriched (v1.2 anchors + v1.3 fields) in-memory → skip ────
var fullyEnrichedContract = {
  schemaVersion: '1.3.0',
  scene: { backgroundColor: [0.0275, 0.0627, 0.149] },
  phases: [
    { id: 'p1', projectedAnchors: { Player: { x_px: 100, y_px: 100, w_px: 50, h_px: 50, provenance: 'extracted' } } }
  ],
  entities: [{
    id: 'Player',
    worldLabel: { text: '玩家', worldOffset: { x: 0, y: 3.1, z: 0 } },
    primitiveStyle: { modelRef: 'astronaut', baseColor: [0.9, 0.4, 0.2] }
  }]
};
var ctxEnriched = makeCtx();
ctxEnriched.blueprint.fidelityContract = fullyEnrichedContract;
assert.strictEqual(stage.canSkip(ctxEnriched), true,
  'fully enriched (v1.2 anchors + v1.3 fields) → skip (idempotent re-entry)');
assert.strictEqual(ctxEnriched.blueprint.fidelityContract, fullyEnrichedContract,
  'in-memory preserved unchanged');

// ─── canSkip: enriched file-loaded → skip + materializes into ctx.blueprint ───
var enrichedPath = path.join(tmpDir, 'enriched.json');
fs.writeFileSync(enrichedPath, JSON.stringify(fullyEnrichedContract));
var ctxFileEnriched = makeCtx();
ctxFileEnriched.fidelityContractPath = enrichedPath;
assert.strictEqual(stage.canSkip(ctxFileEnriched), true, 'enriched-from-file → skip');
assert.ok(ctxFileEnriched.blueprint.fidelityContract, 'in-memory materialized from file');
assert.strictEqual(ctxFileEnriched.blueprint.fidelityContract.schemaVersion, '1.3.0');

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
  // ─── execute: v1.2 (anchors present) + sourceHtml → v1.3 chain runs end-to-end ─
  // task #45: lock the v1.2 → v1.3 in-stage chain at unit/smoke layer (not just
  // Path B harness). v1.1→v1.2 migrate is a no-op when phases already have
  // projectedAnchors (needsExtraction() returns false → no puppeteer), so we can
  // exercise execute() in CI without a headless browser.
  var v12ChainContract = {
    schemaVersion: '1.2.0',
    kind: 'blueprint.fidelityContract',
    producerVersion: 'chain-test',
    requiredCapabilities: ['c1'],
    coordinateSystem: { source: 'three-rh', target: 'unity-lh', handedness: 'h', zFlip: true, unitScale: 1 },
    rendererAdapter: {
      three: { shader: { m: 1 }, animator: { m: 1 }, physics: { m: 1 }, audio: { m: 1 }, ui: { m: 1 } },
      unity: { shader: { m: 1 }, animator: { m: 1 }, physics: { m: 1 }, audio: { m: 1 }, ui: { m: 1 } }
    },
    entities: [{
      id: 'Player', name: 'Player', parentPath: '/Root',
      transform: { localPosition: { x: 0, y: 0, z: 0 }, localRotation: { x: 0, y: 0, z: 0 }, localScale: { x: 1, y: 1, z: 1 } },
      pivot: { x: 0, y: 0, z: 0 },
      bounds: { center: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } },
      primitives: [{
        id: 'Player.Body', name: 'Player.Body', parentPath: '/Root/Player',
        transform: { localPosition: { x: 0, y: 0, z: 0 }, localRotation: { x: 0, y: 0, z: 0 }, localScale: { x: 1, y: 1, z: 1 } },
        pivot: { x: 0, y: 0, z: 0 },
        bounds: { center: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } },
        mesh: { type: 'BoxGeometry', args: [1, 1, 1] },
        material: {
          id: 'm', shader: 'URP/Lit',
          colors: { _Color: [1, 1, 1, 1], _ColorTint: [1, 1, 1, 1], _EmissionColor: [0, 0, 0, 1] },
          alpha: 1, blendMode: 'opaque',
          guid: 'mat-guid', guidSeed: 's', guidAlgorithm: 'md5-lower-hex-32', contentHash: 'sha256:x'
        },
        provenance: { source: 'unity', assetPath: 'a.unity', guid: 'g', fileID: '1', propertyPath: 'x', confidence: 1 }
      }],
      provenance: { source: 'unity', assetPath: 'a.unity', guid: 'g', fileID: '1', propertyPath: 'x', confidence: 1 }
    }],
    phases: [{
      id: 'phase1', showEntities: ['Player'],
      trigger: { type: 't' }, interactionGate: { type: 'g' },
      autoPlayGate: { type: 'g' }, manualGate: { type: 'g' },
      cameraTransform: { position: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: 0 } },
      projectedAnchors: {
        Player: {
          x_px: 100, y_px: 100, w_px: 50, h_px: 50, provenance: 'extracted',
          lookupPath: 'Scene/Player', matchedAlias: 'Player', resolverRule: 'direct'
        }
      }
    }],
    hud: [],
    unityCoverage: { status: 'complete' },
    unresolvedFidelityGaps: [], contractConflicts: []
  };
  var chainHtmlPath = path.join(tmpDir, 'chain-source.html');
  fs.writeFileSync(chainHtmlPath,
    '<html><body><script>\n' +
    'const SCENE_CONFIG = {\n  backgroundColor: 0x071026,\n  ambient: 0x444444,\n};\n' +
    'const ENTITY_STYLE = {\n  Player: { label: "玩家", color: 0xe8fbff, kind: "astronaut" }\n};\n' +
    '</script></body></html>\n');

  var ctxChain = makeCtx();
  ctxChain.blueprint.fidelityContract = v12ChainContract;
  ctxChain.sourceHtmlPath = chainHtmlPath;
  return Promise.resolve(stage.execute(ctxChain)).then(function() {
    var out = ctxChain.blueprint.fidelityContract;
    assert.strictEqual(out.schemaVersion, '1.3.0',
      'v1.2 chain test: stage.execute() must bump schemaVersion to 1.3.0');
    assert.ok(out.scene && Array.isArray(out.scene.backgroundColor),
      'v1.2 chain test: scene.backgroundColor populated');
    assert.deepStrictEqual(out.scene.backgroundColor, [0.0275, 0.0627, 0.149],
      'v1.2 chain test: backgroundColor matches 0x071026 linear-RGB');
    assert.strictEqual(out.entities[0].worldLabel.text, '玩家',
      'v1.2 chain test: worldLabel.text reverse-extracted from ENTITY_STYLE');
    assert.strictEqual(out.entities[0].primitiveStyle.modelRef, 'astronaut',
      'v1.2 chain test: primitiveStyle.modelRef reverse-extracted');
    assert.deepStrictEqual(out.entities[0].primitiveStyle.baseColor, [0.9098, 0.9843, 1],
      'v1.2 chain test: primitiveStyle.baseColor matches 0xe8fbff linear-RGB');
    assert.ok(ctxChain.fidelityContractProduceReportV13,
      'v1.2 chain test: v1.3 report attached to ctx');
    assert.strictEqual(ctxChain.fidelityContractProduceReportV13.bumpedSchemaVersion, true,
      'v1.2 chain test: v1.3 report flags bumpedSchemaVersion=true');
    assert.ok(ctxChain.logs.some(function(l) { return l.indexOf('v1.3 enriched: from=1.2.0 to=1.3.0') >= 0; }),
      'v1.2 chain test: v1.3-enriched log emitted');

    // ─── execute: v1.3 already-enriched re-entry → idempotent (no double-bump) ──
    var ctxReentry = makeCtx();
    ctxReentry.blueprint.fidelityContract = out; // pass enriched contract back in
    ctxReentry.sourceHtmlPath = chainHtmlPath;
    return Promise.resolve(stage.execute(ctxReentry)).then(function() {
      assert.strictEqual(ctxReentry.blueprint.fidelityContract.schemaVersion, '1.3.0',
        'idempotent re-entry: stays at 1.3.0');
      assert.ok(ctxReentry.logs.some(function(l) { return l.indexOf('v1.2 stage skipped') >= 0; }),
        'idempotent re-entry: v1.2 stage skipped (base already at v1.3)');
      assert.ok(ctxReentry.logs.some(function(l) { return l.indexOf('v1.3 skipped') >= 0 && l.indexOf('idempotent re-entry') >= 0; }),
        'idempotent re-entry: v1.3 stage skipped (fields already populated)');
    });
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
