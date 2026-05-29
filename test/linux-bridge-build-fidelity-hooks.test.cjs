#!/usr/bin/env node
'use strict';

// Target-side fidelity hooks must be present in the clean worker source.
// These hooks let fidelity-source-diff drive arbitrary phases instead of
// repeatedly capturing phase1 when visual/pixel gates run against built HTML.

var assert = require('assert');
var fs = require('fs');
var path = require('path');

var workerPath = path.join(__dirname, '..', 'worker', 'linux-bridge-build.js');
var src = fs.readFileSync(workerPath, 'utf8');

[
  'window.__fidelityReady = false',
  'window.__blueprintGameFlowComponent = null',
  'window.__blueprintMarkFidelityReady',
  'window.__blueprintNormalizeGameState = normalizeBlueprintGameState',
  'window.__blueprintWaitForFidelityState = waitForFidelityState',
  'window.__driveToPhase = function(n)',
  'function normalizeBlueprintGameState(state, fallbackPhaseId)',
  'function waitForFidelityState(expectedPhaseId)',
  'function driveLoopComponentToPhase(loopComp, phaseNumber)',
  'function collectLateUpdateComponents(loopComp)',
  'function driveManualLateUpdate(loopComp)',
  'driveManualLateUpdate(loopComp)',
  'if (!window.__fidelityReady && window.__blueprintMarkFidelityReady)'
].forEach(function(needle) {
  assert.ok(src.indexOf(needle) >= 0, 'missing fidelity hook snippet: ' + needle);
});

assert.ok(src.indexOf('va.sourcePhaseContract') >= 0,
  'phase drive helpers should use sourcePhaseContract when available');
assert.ok(src.indexOf('va.fidelityContract') >= 0,
  'phase drive helpers should fall back to fidelityContract phases');
assert.ok(src.indexOf('setTimeout(resolve, 50)') >= 0,
  '__driveToPhase should wait a short settle window after rAF');

// Scope guard: this PR restores target hooks only. It must not reintroduce the
// unrelated dirty source-visual/asset-baking WIP that was excluded from PR #27.
[
  'stableAssetId',
  'bakeSourceVisualAssetsIntoStage4',
  '__stage4PrebakedSourceVisuals',
  'syncStoryboardSourceCamera',
  'SOURCE_VISUAL_ENTITY_SCALE'
].forEach(function(forbidden) {
  assert.strictEqual(src.indexOf(forbidden), -1, 'unexpected unrelated WIP snippet: ' + forbidden);
});

console.log('linux bridge fidelity hook smoke passed');
