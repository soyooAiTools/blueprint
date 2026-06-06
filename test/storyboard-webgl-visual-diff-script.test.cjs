#!/usr/bin/env node
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');

var script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'storyboard-webgl-visual-diff.cjs'), 'utf8');
var demo2specIndex = fs.readFileSync(path.join(__dirname, '..', 'adapters', 'demo2spec', 'index.js'), 'utf8');
var demo2specAdapter = fs.readFileSync(path.join(__dirname, '..', 'adapters', 'demo2spec', 'adapter.cjs'), 'utf8');

[
  'Usage: node scripts/storyboard-webgl-visual-diff.cjs --source <storyboard.html> --webgl <webgl-dir|index.html> --out <dir>',
  'window.__driveToPhase',
  'window.__driveToSourcePhase',
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
  'storyboard-webgl-visual-diff.cjs',
  'storyboardWebglVisualDiff'
].forEach(function(needle) {
  assert.ok(demo2specIndex.indexOf(needle) >= 0, 'missing demo2spec visual diff CLI snippet: ' + needle);
});

assert.ok(demo2specAdapter.indexOf("if (opts.visualDiff) args.push('--visual-diff')") >= 0,
  'adapter should expose visualDiff option');

console.log('storyboard-webgl visual diff script smoke passed');
