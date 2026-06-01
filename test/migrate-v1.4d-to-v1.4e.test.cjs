#!/usr/bin/env node
'use strict';

// task #57 (v1.4e Axis A) — scripts/migrate-v1.4d-to-v1.4e.cjs unit coverage.
// Stubs the worldlabel-extractor (puppeteer-driven) via require.cache so the
// migrate codepath runs synchronously without Chromium. Also covers
// validateProjectedWorldLabel (engine/fidelity-contract.cjs) and Stage 5
// field-diff runWorldLabelPositionDiff (engine/stages/lib/field-diff.cjs).
//
// Covers:
//   1. needsExtraction — phase w/ no projectedWorldLabels → true
//   2. sanitizeWorldLabelForContract — strips forbidden, keeps required +
//      audit, never leaks visibility booleans
//   3. emptyInferredRecord — zero-numeric + provenance:'inferred-default'
//   4. migrate: rejects schemaVersion not in {1.4.0, 1.5.0}
//   5. migrate: no sourceHtml + missing projectedWorldLabels → partial,
//      stays at 1.4.0, inferred placeholders + advisory gaps
//   6. migrate: mock extractor returns all extracted → bumps 1.4.0 → 1.5.0,
//      record shape matches Jonny interface lock
//   7. migrate: mock extractor returns no-label for an entity → still bumps
//      (no-label is legitimate terminal provenance)
//   8. migrate: extractor result missing one showEntity → stays at 1.4.0,
//      inferredCount > 0, advisory gap emitted
//   9. migrate: input already v1.5.0 with populated worldLabels → idempotent
//      no-op (no overwrite, schemaVersion stays 1.5.0)
//  10. migrate: --force-reextract overwrites existing v1.5.0 records
//  11. migrate: forbidden keys in raw extractor output are stripped from
//      written contract (selfVisible/effectiveVisible/viewportIntersection)
//  12. validateProjectedWorldLabel: missing required key → error
//  13. validateProjectedWorldLabel: forbidden key present → error
//  14. validateProjectedWorldLabel: extracted w/o audit fields → error
//  15. validateProjectedWorldLabel: no-label without audit fields → OK
//  16. runWorldLabelPositionDiff: provenance=no-label → skipped
//  17. runWorldLabelPositionDiff: on-viewport mismatch +
//      enforceBlocking=true → blocking=true, category='worldLabel-position-mismatch'
//  18. runWorldLabelPositionDiff: on-viewport mismatch +
//      enforceBlocking=false → blocking=false (advisory pre-v1.5)
//  19. runWorldLabelPositionDiff: off-viewport mismatch + enforceBlocking=true
//      → blocking=false, category='worldLabel-position-mismatch-off-viewport'
//  20. runWorldLabelPositionDiff: deltas within ±7 tol → no entries
//  21. runWorldLabelPositionDiff: missing actual → emits one entry with key='*'
//  22. computePhaseWorldLabelEntries (stage layer): no expected → []
//  23. computePhaseWorldLabelEntries: bridge missing (rawTargetLabels null)
//      + enforce → category='worldLabel-bridge-missing', blocking=true
//  24. computePhaseWorldLabelEntries: target empty for phase + enforce
//      → category='worldLabel-target-empty', blocking=true
//  25. computePhaseWorldLabelEntries: bridge missing + enforce=false
//      → advisory (blocking=false)

var assert = require('assert');
var path = require('path');

// ─── Stub the worldlabel-extractor BEFORE requiring migrate ───────────────────
// migrate-v1.4d-to-v1.4e.cjs lazy-loads the extractor via
// require('../engine/stages/lib/worldlabel-extractor.cjs'); we replace the
// cache entry so puppeteer is never loaded under test.
var EXTRACTOR_PATH = require.resolve('../engine/stages/lib/worldlabel-extractor.cjs');
var stubResult = null;
require.cache[EXTRACTOR_PATH] = {
  id: EXTRACTOR_PATH,
  filename: EXTRACTOR_PATH,
  loaded: true,
  exports: {
    extractFromSourceHtml: async function(_opts) {
      if (typeof stubResult === 'function') return stubResult(_opts);
      return stubResult;
    }
  }
};
function setExtractorStub(value) { stubResult = value; }

var migrateLib = require('../scripts/migrate-v1.4d-to-v1.4e.cjs');
var fieldDiff = require('../engine/stages/lib/field-diff.cjs');
var fidelityContract = require('../engine/fidelity-contract.cjs');
// Stage-layer helper `computePhaseWorldLabelEntries` lands in the v1.4e wiring
// PR (Stage 5), not this Stage 1 PR. Test cases 22-25 below are skipped here
// and live in test/fidelity-source-diff-worldlabel-bucket.test.cjs (PR B).
var sourceDiffStage = require('../engine/stages/fidelity-source-diff.cjs');
var sourceDiffInternals = sourceDiffStage && sourceDiffStage._internals;
var STAGE_LAYER_WIRED = !!(sourceDiffInternals && typeof sourceDiffInternals.computePhaseWorldLabelEntries === 'function');

function deepClone(v) { return JSON.parse(JSON.stringify(v)); }

function baseV14dContract(opts) {
  opts = opts || {};
  return {
    schemaVersion: opts.schemaVersion || '1.4.0',
    kind: 'blueprint.fidelityContract',
    producerVersion: 't', requiredCapabilities: [],
    coordinateSystem: { source: 'three-rh', target: 'unity-lh', handedness: 'h', zFlip: true, unitScale: 1 },
    rendererAdapter: {
      three: { shader: {}, animator: {}, physics: {}, audio: {}, ui: {} },
      unity: { shader: {}, animator: {}, physics: {}, audio: {}, ui: {} }
    },
    entities: opts.entities || [],
    phases: opts.phases || [
      { id: 'phase1', showEntities: ['EntityA', 'EntityB'] },
      { id: 'phase2', showEntities: ['EntityA'] }
    ],
    hud: opts.hud || [],
    unityCoverage: { status: 'complete' },
    unresolvedFidelityGaps: [],
    contractConflicts: []
  };
}

function mkExtractedRecord(opts) {
  opts = opts || {};
  return {
    x: opts.x || 100, y: opts.y || 200,
    width: opts.width || 80, height: opts.height || 24,
    centerX: opts.centerX || 140, centerY: opts.centerY || 212,
    provenance: 'extracted',
    lookupPath: opts.lookupPath || 'probe.meshes.Get(EntityA)/sprite',
    matchedAlias: opts.matchedAlias || 'EntityA',
    resolverRule: opts.resolverRule || 'exact'
  };
}

function mkExtractorOutput(phasesData) {
  var out = {};
  Object.keys(phasesData).forEach(function(phaseId) {
    var labels = {};
    var entries = phasesData[phaseId];
    Object.keys(entries).forEach(function(entId) {
      labels[entId] = entries[entId];
    });
    out[phaseId] = {
      worldLabels: labels,
      nameResolution: Object.keys(entries).map(function(entId) {
        return { phaseId: phaseId, contractId: entId, sourceName: entId, resolverRule: 'exact' };
      }),
      visibilityAudit: Object.keys(entries).map(function(entId) {
        return {
          phaseId: phaseId, contractId: entId,
          effectiveVisible: true, viewportIntersection: true,
          hasSprite: entries[entId].provenance !== 'no-label'
        };
      })
    };
  });
  return out;
}

// ─── case 1: needsExtraction ──────────────────────────────────────────────────
assert.strictEqual(migrateLib.needsExtraction({}), true);
assert.strictEqual(migrateLib.needsExtraction({ projectedWorldLabels: {} }), true);
assert.strictEqual(migrateLib.needsExtraction({ projectedWorldLabels: { e: {} } }), false);

// ─── case 2: sanitizeWorldLabelForContract ────────────────────────────────────
var dirtyRaw = {
  x: 1, y: 2, width: 3, height: 4, centerX: 5, centerY: 6,
  provenance: 'extracted',
  lookupPath: '/lp', matchedAlias: 'a', resolverRule: 'exact',
  // forbidden
  selfVisible: true, effectiveVisible: true, viewportIntersection: true, visible: true
};
var cleaned = migrateLib.sanitizeWorldLabelForContract(dirtyRaw);
assert.deepStrictEqual(Object.keys(cleaned).sort(), [
  'centerX', 'centerY', 'height', 'lookupPath', 'matchedAlias',
  'provenance', 'resolverRule', 'width', 'x', 'y'
]);
assert.ok(!('selfVisible' in cleaned), 'forbidden selfVisible must be stripped');
assert.ok(!('effectiveVisible' in cleaned));
assert.ok(!('viewportIntersection' in cleaned));
assert.ok(!('visible' in cleaned));

// ─── case 3: emptyInferredRecord ──────────────────────────────────────────────
var empty = migrateLib.emptyInferredRecord();
assert.strictEqual(empty.x, 0);
assert.strictEqual(empty.width, 0);
assert.strictEqual(empty.provenance, 'inferred-default');

(async function runAsyncCases() {
  // ─── case 4: input schemaVersion not 1.4/1.5 → throws ────────────────────────
  await assert.rejects(
    migrateLib.migrate(baseV14dContract({ schemaVersion: '1.3.0' }), {}),
    /input schemaVersion must be 1.4.0 or 1.5.0/
  );

  // ─── case 5: no sourceHtml → partial, stays at 1.4.0 ─────────────────────────
  setExtractorStub(null);
  var r5 = await migrateLib.migrate(baseV14dContract(), {});
  assert.strictEqual(r5.report.bumpedSchemaVersion, false,
    'no sourceHtml must not bump');
  assert.strictEqual(r5.contract.schemaVersion, '1.4.0');
  assert.strictEqual(r5.report.partialMigration, true);
  assert.ok(r5.report.counts.inferredCount > 0, 'inferred placeholders written');

  // ─── case 6: all extracted → bumps to 1.5.0 ──────────────────────────────────
  setExtractorStub(mkExtractorOutput({
    phase1: {
      EntityA: mkExtractedRecord({ matchedAlias: 'EntityA' }),
      EntityB: mkExtractedRecord({ x: 500, matchedAlias: 'EntityB' })
    },
    phase2: { EntityA: mkExtractedRecord({ matchedAlias: 'EntityA' }) }
  }));
  var r6 = await migrateLib.migrate(baseV14dContract(), { sourceHtml: '/dev/null' });
  assert.strictEqual(r6.report.bumpedSchemaVersion, true,
    'all extracted must bump');
  assert.strictEqual(r6.contract.schemaVersion, '1.5.0');
  assert.strictEqual(r6.report.counts.extractedCount, 3);
  assert.strictEqual(r6.report.counts.inferredCount, 0);
  // Jonny interface lock
  var pwl = r6.contract.phases[0].projectedWorldLabels.EntityA;
  ['x', 'y', 'width', 'height', 'centerX', 'centerY', 'provenance'].forEach(function(k) {
    assert.ok(k in pwl, 'record must include ' + k);
  });
  assert.strictEqual(pwl.provenance, 'extracted');
  assert.strictEqual(typeof pwl.lookupPath, 'string');

  // ─── case 7: extractor returns no-label for an entity → still bumps ──────────
  setExtractorStub(mkExtractorOutput({
    phase1: {
      EntityA: mkExtractedRecord({ matchedAlias: 'EntityA' }),
      EntityB: { x: 0, y: 0, width: 0, height: 0, centerX: 0, centerY: 0, provenance: 'no-label' }
    },
    phase2: { EntityA: mkExtractedRecord({ matchedAlias: 'EntityA' }) }
  }));
  var r7 = await migrateLib.migrate(baseV14dContract(), { sourceHtml: '/dev/null' });
  assert.strictEqual(r7.report.bumpedSchemaVersion, true,
    'no-label provenance must not block bump (Sprite-less terminal state)');
  assert.strictEqual(r7.contract.schemaVersion, '1.5.0');
  assert.strictEqual(r7.report.counts.noLabelCount, 1);
  assert.strictEqual(r7.report.counts.extractedCount, 2);

  // ─── case 8: missing showEntity → stays at 1.4.0 + advisory ──────────────────
  setExtractorStub(mkExtractorOutput({
    phase1: { EntityA: mkExtractedRecord({ matchedAlias: 'EntityA' }) },  // EntityB missing
    phase2: { EntityA: mkExtractedRecord({ matchedAlias: 'EntityA' }) }
  }));
  var r8 = await migrateLib.migrate(baseV14dContract(), { sourceHtml: '/dev/null' });
  assert.strictEqual(r8.report.bumpedSchemaVersion, false,
    'missing extractor coverage must NOT bump');
  assert.strictEqual(r8.contract.schemaVersion, '1.4.0');
  assert.ok(r8.report.counts.inferredCount > 0);
  assert.ok(r8.report.advisoryGaps.some(function(g) {
    return g.id === 'projectedWorldLabel-missing:phase1:EntityB';
  }), 'expected missing-entity advisory gap');

  // ─── case 9: input already v1.5.0 with populated → idempotent ────────────────
  var prepop = baseV14dContract({ schemaVersion: '1.5.0' });
  prepop.phases.forEach(function(p) {
    p.projectedWorldLabels = {};
    p.showEntities.forEach(function(e) {
      p.projectedWorldLabels[e] = mkExtractedRecord({ matchedAlias: e });
    });
  });
  var prepopFrozen = deepClone(prepop);
  setExtractorStub(null);
  var r9 = await migrateLib.migrate(prepop, {});  // no sourceHtml, no forceReextract
  assert.strictEqual(r9.contract.schemaVersion, '1.5.0');
  assert.deepStrictEqual(
    r9.contract.phases[0].projectedWorldLabels,
    prepopFrozen.phases[0].projectedWorldLabels,
    'idempotent re-run must NOT mutate existing v1.5.0 records'
  );
  assert.strictEqual(r9.report.counts.inferredCount, 0);

  // ─── case 10: --force-reextract overwrites ───────────────────────────────────
  setExtractorStub(mkExtractorOutput({
    phase1: {
      EntityA: mkExtractedRecord({ x: 999, matchedAlias: 'EntityA' }),
      EntityB: mkExtractedRecord({ x: 999, matchedAlias: 'EntityB' })
    },
    phase2: { EntityA: mkExtractedRecord({ x: 999, matchedAlias: 'EntityA' }) }
  }));
  var prepop2 = deepClone(prepopFrozen);
  var r10 = await migrateLib.migrate(prepop2, { sourceHtml: '/dev/null', forceReextract: true });
  assert.strictEqual(r10.contract.phases[0].projectedWorldLabels.EntityA.x, 999,
    'forceReextract must overwrite existing records');

  // ─── case 11: forbidden keys in raw extractor output are stripped ────────────
  var leaky = mkExtractedRecord({ matchedAlias: 'EntityA' });
  leaky.selfVisible = true; leaky.effectiveVisible = true; leaky.viewportIntersection = true;
  setExtractorStub(mkExtractorOutput({
    phase1: { EntityA: leaky, EntityB: mkExtractedRecord({ matchedAlias: 'EntityB' }) },
    phase2: { EntityA: mkExtractedRecord({ matchedAlias: 'EntityA' }) }
  }));
  var r11 = await migrateLib.migrate(baseV14dContract(), { sourceHtml: '/dev/null' });
  var written = r11.contract.phases[0].projectedWorldLabels.EntityA;
  assert.ok(!('selfVisible' in written), 'sanitize must strip selfVisible in pipeline');
  assert.ok(!('effectiveVisible' in written));
  assert.ok(!('viewportIntersection' in written));

  // ─── case 12: validator — missing required key ───────────────────────────────
  var errs12 = [];
  fidelityContract.validateProjectedWorldLabel({
    x: 1, y: 2, width: 3, height: 4, centerX: 5
    // centerY missing, provenance missing
  }, errs12, 'P.test');
  assert.ok(errs12.some(function(e) { return /centerY/.test(e); }), 'centerY required');
  assert.ok(errs12.some(function(e) { return /provenance/.test(e); }), 'provenance required');

  // ─── case 13: validator — forbidden key present ──────────────────────────────
  var errs13 = [];
  fidelityContract.validateProjectedWorldLabel({
    x: 1, y: 2, width: 3, height: 4, centerX: 5, centerY: 6,
    provenance: 'extracted',
    lookupPath: 'p', matchedAlias: 'a', resolverRule: 'r',
    selfVisible: true
  }, errs13, 'P.test');
  assert.ok(errs13.some(function(e) { return /selfVisible/.test(e); }),
    'selfVisible must trigger error');

  // ─── case 14: validator — extracted requires audit fields ────────────────────
  var errs14 = [];
  fidelityContract.validateProjectedWorldLabel({
    x: 1, y: 2, width: 3, height: 4, centerX: 5, centerY: 6,
    provenance: 'extracted'
    // missing lookupPath/matchedAlias/resolverRule
  }, errs14, 'P.test');
  assert.ok(errs14.some(function(e) { return /lookupPath/.test(e); }));
  assert.ok(errs14.some(function(e) { return /matchedAlias/.test(e); }));
  assert.ok(errs14.some(function(e) { return /resolverRule/.test(e); }));

  // ─── case 15: validator — no-label without audit fields → OK ─────────────────
  var errs15 = [];
  fidelityContract.validateProjectedWorldLabel({
    x: 0, y: 0, width: 0, height: 0, centerX: 0, centerY: 0,
    provenance: 'no-label'
  }, errs15, 'P.test');
  assert.strictEqual(errs15.length, 0,
    'no-label without audit fields must validate');

  // ─── case 16: runWorldLabelPositionDiff — no-label skipped ──────────────────
  var entries16 = fieldDiff.runWorldLabelPositionDiff('phase1', {
    EntityA: { x: 0, y: 0, width: 0, height: 0, provenance: 'no-label' }
  }, { EntityA: { x: 999, y: 999, width: 999, height: 999 } }, null, 7, true);
  assert.strictEqual(entries16.length, 0, 'no-label provenance must be skipped');

  // ─── case 17: on-viewport mismatch + enforceBlocking=true → blocking=true ────
  var entries17 = fieldDiff.runWorldLabelPositionDiff('phase1', {
    EntityA: { x: 100, y: 100, width: 80, height: 24, provenance: 'extracted' }
  }, { EntityA: { x: 200, y: 100, width: 80, height: 24 } },
     { width: 1280, height: 720 }, 7, true);
  assert.strictEqual(entries17.length, 1);
  assert.strictEqual(entries17[0].blocking, true);
  assert.strictEqual(entries17[0].category, 'worldLabel-position-mismatch');
  assert.strictEqual(entries17[0].key, 'x');
  assert.strictEqual(entries17[0].deltaPx, 100);

  // ─── case 18: on-viewport mismatch + enforceBlocking=false → advisory ────────
  var entries18 = fieldDiff.runWorldLabelPositionDiff('phase1', {
    EntityA: { x: 100, y: 100, width: 80, height: 24, provenance: 'extracted' }
  }, { EntityA: { x: 200, y: 100, width: 80, height: 24 } },
     { width: 1280, height: 720 }, 7, false);
  assert.strictEqual(entries18.length, 1);
  assert.strictEqual(entries18[0].blocking, false,
    'pre-v1.5 enforceBlocking=false must downgrade to advisory');

  // ─── case 19: off-viewport mismatch + enforceBlocking=true → advisory ────────
  var entries19 = fieldDiff.runWorldLabelPositionDiff('phase1', {
    EntityA: { x: -500, y: -500, width: 80, height: 24, provenance: 'extracted' }
  }, { EntityA: { x: -600, y: -500, width: 80, height: 24 } },
     { width: 1280, height: 720 }, 7, true);
  assert.strictEqual(entries19.length, 1);
  assert.strictEqual(entries19[0].category, 'worldLabel-position-mismatch-off-viewport');
  assert.strictEqual(entries19[0].blocking, false,
    'off-viewport always downgrades to advisory even with enforceBlocking');

  // ─── case 20: deltas within ±7 tol → no entries ──────────────────────────────
  var entries20 = fieldDiff.runWorldLabelPositionDiff('phase1', {
    EntityA: { x: 100, y: 100, width: 80, height: 24, provenance: 'extracted' }
  }, { EntityA: { x: 105, y: 102, width: 81, height: 25 } },
     { width: 1280, height: 720 }, 7, true);
  assert.strictEqual(entries20.length, 0,
    'within tolerance must yield no diff entries');

  // ─── case 21: missing actual → one entry, key='*' ────────────────────────────
  var entries21 = fieldDiff.runWorldLabelPositionDiff('phase1', {
    EntityA: { x: 100, y: 100, width: 80, height: 24, provenance: 'extracted' }
  }, {}, { width: 1280, height: 720 }, 7, true);
  assert.strictEqual(entries21.length, 1);
  assert.strictEqual(entries21[0].key, '*');
  assert.strictEqual(entries21[0].actual, 'missing');
  assert.strictEqual(entries21[0].blocking, true);

  // ─── cases 22-25: stage-layer helper (only when Stage 5 wiring landed) ───────
  // These exercise sourceDiffInternals.computePhaseWorldLabelEntries which
  // ships in the Stage 5 wiring PR (PR B), not Stage 1. Skip cleanly here.
  if (STAGE_LAYER_WIRED) {
    // case 22a: no expected → []
    var stage22 = sourceDiffInternals.computePhaseWorldLabelEntries('phase1', null, {},
      { width: 1280, height: 720 }, 7, true);
    assert.deepStrictEqual(stage22, []);
    // case 22b: only no-label expected → []
    var stage22b = sourceDiffInternals.computePhaseWorldLabelEntries('phase1', {
      EntityA: { x: 0, y: 0, width: 0, height: 0, provenance: 'no-label' }
    }, {}, { width: 1280, height: 720 }, 7, true);
    assert.deepStrictEqual(stage22b, []);

    // case 23: bridge missing + enforce → blocking=true
    var stage23 = sourceDiffInternals.computePhaseWorldLabelEntries('phase1', {
      EntityA: { x: 100, y: 100, width: 80, height: 24, provenance: 'extracted' }
    }, null, { width: 1280, height: 720 }, 7, true);
    assert.strictEqual(stage23.length, 1);
    assert.strictEqual(stage23[0].category, 'worldLabel-bridge-missing');
    assert.strictEqual(stage23[0].blocking, true);

    // case 24: target empty for phase + enforce → blocking=true
    var stage24 = sourceDiffInternals.computePhaseWorldLabelEntries('phase1', {
      EntityA: { x: 100, y: 100, width: 80, height: 24, provenance: 'extracted' }
    }, { phase1: {} }, { width: 1280, height: 720 }, 7, true);
    assert.strictEqual(stage24.length, 1);
    assert.strictEqual(stage24[0].category, 'worldLabel-target-empty');
    assert.strictEqual(stage24[0].blocking, true);

    // case 25: bridge missing + enforce=false → advisory
    var stage25 = sourceDiffInternals.computePhaseWorldLabelEntries('phase1', {
      EntityA: { x: 100, y: 100, width: 80, height: 24, provenance: 'extracted' }
    }, null, { width: 1280, height: 720 }, 7, false);
    assert.strictEqual(stage25.length, 1);
    assert.strictEqual(stage25[0].blocking, false,
      'bridge-missing must downgrade to advisory when enforceBlocking=false (pre-v1.5)');

    console.log('migrate-v1.4d-to-v1.4e.test.cjs PASS — 25 cases (stage-layer wired)');
  } else {
    console.log('migrate-v1.4d-to-v1.4e.test.cjs PASS — 21 cases (stage 5 wiring not in tree; cases 22-25 deferred to PR B)');
  }
})().catch(function(err) {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
