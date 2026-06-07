#!/usr/bin/env node
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');

var script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'storyboard-webgl-visual-diff.cjs'), 'utf8');
var demo2specIndex = fs.readFileSync(path.join(__dirname, '..', 'adapters', 'demo2spec', 'index.js'), 'utf8');
var demo2specAdapter = fs.readFileSync(path.join(__dirname, '..', 'adapters', 'demo2spec', 'adapter.cjs'), 'utf8');
var visualDiffScript = require('../scripts/storyboard-webgl-visual-diff.cjs');

[
  'Usage: node scripts/storyboard-webgl-visual-diff.cjs --source <storyboard.html> --webgl <webgl-dir|index.html> --out <dir>',
  'window.__driveToPhase',
  'window.__driveToSourcePhase',
  'parsePhaseSelector',
  'selectedPhases',
  'animation:none!important;transition:none!important',
  '?sourceOverlay=1&sourceRuntime=1&observerReady=1&cuaObserverReady=1',
  'meanAbs',
  'over50Pct',
  'blueprint.storyboardWebglVisualDiff',
  'report.json'
].forEach(function(needle) {
  assert.ok(script.indexOf(needle) >= 0, 'missing visual diff script snippet: ' + needle);
});

[
  '--visual-diff',
  '--visual-phases',
  'storyboard-webgl-visual-diff.cjs',
  'storyboardWebglVisualDiff'
].forEach(function(needle) {
  assert.ok(demo2specIndex.indexOf(needle) >= 0, 'missing demo2spec visual diff CLI snippet: ' + needle);
});

assert.ok(demo2specAdapter.indexOf("if (opts.visualDiff) args.push('--visual-diff')") >= 0,
  'adapter should expose visualDiff option');
assert.ok(demo2specAdapter.indexOf("if (opts.visualPhases) args.push('--visual-phases', String(opts.visualPhases))") >= 0,
  'adapter should expose visualPhases option');

assert.deepStrictEqual(visualDiffScript.parsePhaseSelector(null, 4), [1, 2, 3, 4]);
assert.deepStrictEqual(visualDiffScript.parsePhaseSelector('phase8', 8), [8]);
assert.deepStrictEqual(visualDiffScript.parsePhaseSelector('6-8', 8), [6, 7, 8]);
assert.deepStrictEqual(visualDiffScript.parsePhaseSelector('phase6,phase8', 8), [6, 8]);
assert.deepStrictEqual(visualDiffScript.parsePhaseSelector('8,6-7,phase8', 8), [8, 6, 7]);
assert.throws(function() {
  visualDiffScript.parsePhaseSelector('phas8', 8);
}, /Invalid visual phase selector token/);
assert.throws(function() {
  visualDiffScript.parsePhaseSelector('phase9', 8);
}, /Invalid visual phase selector token/);

var tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'storyboard-webgl-visual-diff-'));
var objectLiteralPhases = path.join(tmpDir, 'object-literal.html');
fs.writeFileSync(objectLiteralPhases, '<script>const PHASES = [{id:"phase1"},{id:"phase2"}];</script>');
assert.strictEqual(visualDiffScript.phaseCountFromSource(objectLiteralPhases), 2);
var sourceIrRendererPhases = path.join(tmpDir, 'source-ir-renderer.html');
fs.writeFileSync(sourceIrRendererPhases, '<script>const PHASES = [{"id":"phase1"},{"id":"phase2"},{"id":"phase3"},{"id":"phase4"},{"id":"phase5"},{"id":"phase6"},{"id":"phase7"},{"id":"phase8"}];</script>');
assert.strictEqual(visualDiffScript.phaseCountFromSource(sourceIrRendererPhases), 8);

console.log('storyboard-webgl visual diff script smoke passed');
