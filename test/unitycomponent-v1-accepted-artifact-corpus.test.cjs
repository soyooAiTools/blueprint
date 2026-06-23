#!/usr/bin/env node
'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var emitter = require('../lib/unitycomponent-v1-emitter.cjs');
var hardgate = require('../lib/unitycomponent-v1-hardgate.cjs');

var repoRoot = path.join(__dirname, '..');
var envRoot = process.env.UNITYCOMPONENT_ACCEPTED_CORPUS_ROOT || '';
var candidateRoots = envRoot ? [envRoot] : [
  path.join(repoRoot, 'test', 'fixtures', 'unitycomponent-v1-accepted-corpus'),
  path.join(repoRoot, 'server-data', 'webgl')
];

function hasFile(dir, name) {
  return fs.existsSync(path.join(dir, name));
}

function hasUnityAssetPlan(dir) {
  return hasFile(dir, 'unity-asset-plan.json') || hasFile(dir, 'blueprint-unity-asset-plan.json');
}

function isAcceptedArtifactDir(dir) {
  return hasFile(dir, 'source-ir.json') &&
    hasFile(dir, 'playable-scene-ir.json') &&
    hasFile(dir, 'asset-manifest.json') &&
    hasUnityAssetPlan(dir);
}

function walkDirs(root, out, maxDepth, depth) {
  if (!fs.existsSync(root) || depth > maxDepth) return;
  if (isAcceptedArtifactDir(root)) {
    out.push(root);
    return;
  }
  fs.readdirSync(root).forEach(function(name) {
    var dir = path.join(root, name);
    if (fs.statSync(dir).isDirectory()) walkDirs(dir, out, maxDepth, depth + 1);
  });
}

var acceptedDirs = [];
candidateRoots.forEach(function(root) {
  walkDirs(root, acceptedDirs, 2, 0);
});

if (acceptedDirs.length < 5) {
  if (envRoot) {
    throw new Error('UNITYCOMPONENT_ACCEPTED_CORPUS_ROOT must contain at least 5 accepted artifact directories; found ' + acceptedDirs.length);
  }
  console.log('unitycomponent v1 accepted artifact corpus skipped: no repo-owned accepted artifact corpus found');
  process.exit(0);
}

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unitycomponent-v1-accepted-corpus-'));
acceptedDirs.slice(0, 5).forEach(function(artifactDir, index) {
  var unityDir = path.join(tmp, 'unity-' + index);
  var result = emitter.emitFromArtifacts(artifactDir, unityDir, { generatedAt: '2026-06-23T00:00:00.000Z' });
  assert.strictEqual(result.report.passed, true, artifactDir + ': ' + JSON.stringify(result.report.errors, null, 2));
  assert.strictEqual(hardgate.validateUnityComponentV1(unityDir).passed, true, artifactDir + ' hardgate');
  assert.ok(result.spec.phases.length > 0, artifactDir + ' should project accepted phases');
  assert.strictEqual(result.spec.profile, 'unitycomponent-v1', artifactDir + ' profile');
});

console.log('unitycomponent v1 accepted artifact corpus tests passed: ' + acceptedDirs.slice(0, 5).join(', '));
