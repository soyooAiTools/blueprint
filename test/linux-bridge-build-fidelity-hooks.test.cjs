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
  'if (typeof window.__gameState !== "function") window.__gameState = gs',
  "nextState=window.__blueprintNormalizeGameState(nextState,nextState.currentPhase||nextState.phase||null)||nextState",
  "gs = normalizeBlueprintGameState(gs, null)",
  'function waitForFidelityState(expectedPhaseId)',
  'function driveLoopComponentToPhase(loopComp, phaseNumber)',
  'if (typeof loopComp.ApplyFidelityPhaseVisibility === "function") loopComp.ApplyFidelityPhaseVisibility(targetIdx)',
  'var snapshotName = "Snapshot_" + suffix + "_GateEntities"',
  'if (typeof loopComp[snapshotName] === "function") loopComp[snapshotName]()',
  'function collectLateUpdateComponents(loopComp)',
  'function driveManualLateUpdate(loopComp)',
  'driveManualLateUpdate(loopComp)',
  'window.__bpHeadlessWallSeconds = 0',
  'function syncHeadlessUnityClock(now)',
  "Object.defineProperty(UnityEngine.Time, 'realtimeSinceStartup'",
  'syncHeadlessUnityClock(now)',
  'const headlessRealtimeExpr',
  'UnityEngine\\.Time\\.realtimeSinceStartup(?!\\s*=)',
  'if (!window.__fidelityReady && window.__blueprintMarkFidelityReady)'
].forEach(function(needle) {
  assert.ok(src.indexOf(needle) >= 0, 'missing fidelity hook snippet: ' + needle);
});

[
  'function sourceDomHudOwnsStoryboardDom()',
  'function applyStoryboardDomHudVisibility()',
  'var contract = va.sourceEntityContract && va.sourceEntityContract.domHudContract',
  "['bp-storyboard-scene-tone', 'bp-storyboard-hud', 'bp-storyboard-target']",
  'if (applyStoryboardDomHudVisibility()) return'
].forEach(function(needle) {
  assert.ok(src.indexOf(needle) >= 0, 'missing source HUD bridge suppression snippet: ' + needle);
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
  '__stage4PrebakedSourceVisuals'
].forEach(function(forbidden) {
  assert.strictEqual(src.indexOf(forbidden), -1, 'unexpected unrelated WIP snippet: ' + forbidden);
});

console.log('linux bridge fidelity hook smoke passed');
