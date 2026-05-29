#!/usr/bin/env node
'use strict';

// Locks the Luna pipeline stage composition so the v1.3 producer chain
// (task #37 source-html-bind + task #45 fidelity-contract-produce) and the
// task #43 fidelity-source-diff cannot silently regress to "stage file
// exists but is never registered in createLunaPipeline" — the exact orphan
// shape that blocked PR #32 first round (Jonny msg=bcf94a1d).
//
// Asserts:
//   1. createLunaPipeline returns a Pipeline whose stage array contains
//      sourceHtmlBindStage, fidelityContractProduceStage, fidelitySourceDiffStage.
//   2. Order constraints:
//        sourceHtmlBindStage           BEFORE cloneStage
//        fidelityContractProduceStage  BETWEEN reviewStage and compileStage
//        fidelitySourceDiffStage       AFTER  compileStage and BEFORE visualCheckStage
//   3. pipeline.stages.* exports include the three names so external callers
//      (rerun harness, tests, helpers) can look them up by name.

var assert = require('assert');
var pipeline = require('../engine/pipeline.cjs');

// ── exposed Pipeline class has stages list accessible? ──
function stagesOf(p) {
  // Pipeline ctor stores its stages on `.stages`. Fall back to internal
  // names if the field is private.
  if (Array.isArray(p.stages)) return p.stages;
  if (Array.isArray(p._stages)) return p._stages;
  throw new Error('Pipeline instance does not expose stages array via .stages or ._stages');
}

var luna = pipeline.createLunaPipeline({});
var stages = stagesOf(luna);
assert.ok(stages.length > 0, 'createLunaPipeline must return non-empty stage array');

function indexByName(name) {
  for (var i = 0; i < stages.length; i++) {
    if (stages[i] && stages[i].name === name) return i;
  }
  return -1;
}

var iSourceBind = indexByName('source-html-bind');
var iClone = indexByName('clone');
var iReview = indexByName('review');
var iProduce = indexByName('fidelity-contract-produce');
var iCompile = indexByName('compile');
var iSourceDiff = indexByName('fidelity-source-diff');
var iVisual = indexByName('visual-check');

// ── case 1: all three v1.3 chain stages present ──
assert.notStrictEqual(iSourceBind, -1, 'source-html-bind must be registered in createLunaPipeline');
assert.notStrictEqual(iProduce, -1, 'fidelity-contract-produce must be registered in createLunaPipeline');
assert.notStrictEqual(iSourceDiff, -1, 'fidelity-source-diff must be registered in createLunaPipeline');

// Sanity: surrounding anchors must also be present (we depend on them for ordering).
assert.notStrictEqual(iClone, -1, 'clone stage anchor missing — pipeline shape changed unexpectedly');
assert.notStrictEqual(iReview, -1, 'review stage anchor missing — pipeline shape changed unexpectedly');
assert.notStrictEqual(iCompile, -1, 'compile stage anchor missing — pipeline shape changed unexpectedly');
assert.notStrictEqual(iVisual, -1, 'visual-check anchor missing — pipeline shape changed unexpectedly');

// ── case 2: order constraints ──
assert.ok(iSourceBind < iClone,
  'source-html-bind must run BEFORE clone (binds ctx.sourceHtmlPath that downstream stages depend on); got idx ' + iSourceBind + ' vs clone ' + iClone);
assert.ok(iReview < iProduce && iProduce < iCompile,
  'fidelity-contract-produce must run BETWEEN review and compile (enriches contract before compile/helpers consumes it); got review=' + iReview + ' produce=' + iProduce + ' compile=' + iCompile);
assert.ok(iCompile < iSourceDiff && iSourceDiff < iVisual,
  'fidelity-source-diff must run AFTER compile and BEFORE visual-check (consumes enriched contract, emits diff before visual gate); got compile=' + iCompile + ' source-diff=' + iSourceDiff + ' visual=' + iVisual);

// ── case 3: pipeline.stages.* exports look up the same stage instances ──
assert.ok(pipeline.stages.sourceHtmlBind === stages[iSourceBind],
  'pipeline.stages.sourceHtmlBind export must reference the same stage instance registered in createLunaPipeline');
assert.ok(pipeline.stages.fidelityContractProduce === stages[iProduce],
  'pipeline.stages.fidelityContractProduce export must reference the same stage instance registered in createLunaPipeline');
assert.ok(pipeline.stages.fidelitySourceDiff === stages[iSourceDiff],
  'pipeline.stages.fidelitySourceDiff export must reference the same stage instance registered in createLunaPipeline');

console.log('luna-pipeline-composition.test.cjs PASS');
console.log('  stage order locked: source-html-bind@' + iSourceBind +
  ' < clone@' + iClone +
  ' < review@' + iReview +
  ' < fidelity-contract-produce@' + iProduce +
  ' < compile@' + iCompile +
  ' < fidelity-source-diff@' + iSourceDiff +
  ' < visual-check@' + iVisual);
