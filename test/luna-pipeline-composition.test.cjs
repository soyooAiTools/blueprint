#!/usr/bin/env node
'use strict';

// Locks the Luna pipeline stage composition so the v1.3 producer chain
// (task #37 source-html-bind + task #45 fidelity-contract-produce) and the
// task #43 fidelity-source-diff cannot silently regress to "stage file
// exists but is never registered in createLunaPipeline" — the exact orphan
// shape that blocked PR #32 first round (Jonny msg=bcf94a1d).
//
// Implementation note: static text analysis of `engine/pipeline.cjs` rather
// than `require()`-loading the module. Loading pipeline.cjs pulls in the
// Ajv-backed schema validator chain (adapters/schema/validate-schema.cjs)
// which fails when `node_modules` is missing — exactly the situation Jonny
// hit reviewing PR #32 commit 4 from a clean worktree
// (msg=3b7e3ac6). Static analysis keeps the test runnable in any worktree
// regardless of dependency install state, and the regex assertions are
// sufficient to catch the "registered file, never referenced" orphan shape.
//
// Asserts:
//   1. `engine/pipeline.cjs` `require`s all three stage modules.
//   2. The `createLunaPipeline()` stage array contains all three stage
//      identifiers in the correct positional order around their anchors
//      (clone / review / compile / visual-check).
//   3. `module.exports.stages.{sourceHtmlBind,fidelityContractProduce,
//      fidelitySourceDiff}` exports are present (rerun harness lookup).

var assert = require('assert');
var fs = require('fs');
var path = require('path');

var src = fs.readFileSync(path.join(__dirname, '..', 'engine', 'pipeline.cjs'), 'utf8');

// ── helper: find first 1-based index of a regex match (line-oriented for nicer errors) ──
function lineOfMatch(re, label) {
  var match = re.exec(src);
  if (!match) {
    throw new Error('pipeline.cjs missing required line for ' + label + ' (regex ' + re + ')');
  }
  // 1-based line index
  return src.slice(0, match.index).split('\n').length;
}

// ── case 1: require lines for all three stage modules ──
lineOfMatch(/require\(\s*['"]\.\/stages\/source-html-bind\.cjs['"]\s*\)/, 'source-html-bind require');
lineOfMatch(/require\(\s*['"]\.\/stages\/fidelity-contract-produce\.cjs['"]\s*\)/, 'fidelity-contract-produce require');
lineOfMatch(/require\(\s*['"]\.\/stages\/fidelity-source-diff\.cjs['"]\s*\)/, 'fidelity-source-diff require');

// ── extract createLunaPipeline body and inspect stage identifier order ──
var lunaBodyMatch = /function\s+createLunaPipeline\s*\([^)]*\)\s*\{([\s\S]*?)\}/m.exec(src);
assert.ok(lunaBodyMatch, 'pipeline.cjs must define function createLunaPipeline');
var lunaBody = lunaBodyMatch[1];

// Pull the new Pipeline([...]) stage array literal out of the body.
var stageArrayMatch = /new\s+Pipeline\s*\(\s*\[([\s\S]*?)\]/.exec(lunaBody);
assert.ok(stageArrayMatch, 'createLunaPipeline must call `new Pipeline([...])` with a stage array literal');
var stageArrayText = stageArrayMatch[1];

// Split on commas / newlines to get a clean list of identifier tokens.
var stageOrder = stageArrayText
  .split(/[\n,]/)
  .map(function(s) { return s.replace(/\/\/.*$/, '').trim(); })
  .filter(function(s) { return s.length > 0; });

function idx(name) {
  var i = stageOrder.indexOf(name);
  if (i < 0) {
    throw new Error('createLunaPipeline stage array missing identifier ' + name + ' (got ' + JSON.stringify(stageOrder) + ')');
  }
  return i;
}

var iSourceBind = idx('sourceHtmlBindStage');
var iClone = idx('cloneStage');
var iReview = idx('reviewStage');
var iProduce = idx('fidelityContractProduceStage');
var iCompile = idx('compileStage');
var iSourceDiff = idx('fidelitySourceDiffStage');
var iVisual = idx('visualCheckStage');

// ── case 2: order constraints ──
assert.ok(iSourceBind < iClone,
  'sourceHtmlBindStage must run BEFORE cloneStage (binds ctx.sourceHtmlPath that downstream stages depend on); got idx ' + iSourceBind + ' vs clone ' + iClone);
assert.ok(iReview < iProduce && iProduce < iCompile,
  'fidelityContractProduceStage must run BETWEEN reviewStage and compileStage (enriches contract before compile/helpers consumes it); got review=' + iReview + ' produce=' + iProduce + ' compile=' + iCompile);
assert.ok(iCompile < iSourceDiff && iSourceDiff < iVisual,
  'fidelitySourceDiffStage must run AFTER compileStage and BEFORE visualCheckStage (consumes enriched contract, emits diff before visual gate); got compile=' + iCompile + ' source-diff=' + iSourceDiff + ' visual=' + iVisual);

// ── case 3: pipeline.stages.* exports exist for rerun/test/helper lookup ──
function assertStageExport(key) {
  var re = new RegExp('\\b' + key + '\\s*:\\s*\\w+Stage');
  assert.ok(re.test(src), 'pipeline.cjs module.exports.stages must include `' + key + '` entry');
}
assertStageExport('sourceHtmlBind');
assertStageExport('fidelityContractProduce');
assertStageExport('fidelitySourceDiff');

console.log('luna-pipeline-composition.test.cjs PASS');
console.log('  stage order locked (positional indices in createLunaPipeline):');
console.log('    sourceHtmlBindStage           @ ' + iSourceBind);
console.log('    cloneStage                    @ ' + iClone);
console.log('    reviewStage                   @ ' + iReview);
console.log('    fidelityContractProduceStage  @ ' + iProduce);
console.log('    compileStage                  @ ' + iCompile);
console.log('    fidelitySourceDiffStage       @ ' + iSourceDiff);
console.log('    visualCheckStage              @ ' + iVisual);
