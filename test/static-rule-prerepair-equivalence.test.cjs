/**
 * 2026-05-31 Wave 2 — runAllPreRepairs golden-snapshot regression gate.
 *
 * engine/lib/static-rule-prerepair.cjs `runAllPreRepairs` is the sole pre-repair
 * orchestration after the inline main/partial mirror was deleted from review.cjs.
 * It was proven byte-identical to the original inline implementation by the
 * inline-vs-lib equivalence gate at commit f1d7375 (USE_PRE_REPAIR_LIB toggle);
 * that proof is preserved in git history. With the inline path now removed, this
 * test locks behavior against a committed golden snapshot
 * (test/fixtures/prerepair-snapshot.json) that was captured from the verified output.
 *
 * If a pre-repair fn legitimately changes behavior on these corpus inputs, regenerate
 * the snapshot deliberately (see scripts note in fixtures/prerepair-corpus.cjs) — a
 * silent diff here would otherwise cost a full fix-loop round per affected project
 * (review.cjs is the 2nd-most-fragile stage).
 */

var review = require('../engine/stages/review.cjs');
var lib = require('../engine/lib/static-rule-prerepair.cjs');
var CORPUS = require('./fixtures/prerepair-corpus.cjs');
var SNAPSHOT = require('./fixtures/prerepair-snapshot.json');

function clone(o) { return JSON.parse(JSON.stringify(o)); }

describe('runAllPreRepairs golden snapshot (Wave 2)', function() {
  it('lib exports runAllPreRepairs + a 17-entry SHARED_BUNDLE', function() {
    expect(typeof lib.runAllPreRepairs).toBe('function');
    expect(Array.isArray(lib.SHARED_BUNDLE)).toBe(true);
    expect(lib.SHARED_BUNDLE.length).toBe(17);
  });

  it('review.cjs still exports repairKnownStructuralDamage (delegates to lib)', function() {
    expect(typeof review.repairKnownStructuralDamage).toBe('function');
  });

  it('corpus and snapshot are aligned', function() {
    expect(SNAPSHOT.length).toBe(CORPUS.length);
  });

  CORPUS.forEach(function(input, i) {
    it('output matches frozen snapshot: ' + input.name, function() {
      var out = review.repairKnownStructuralDamage(input.main, clone(input.extras), input.blueprint);
      var snap = SNAPSHOT[i];
      expect(snap.name).toBe(input.name);
      expect(out.changed).toBe(snap.changed);
      expect(out.fixes).toEqual(snap.fixes);
      expect(out.code).toBe(snap.code);
      expect(out.extraFiles).toEqual(snap.extraFiles);
    });
  });
});
