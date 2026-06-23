#!/usr/bin/env node
'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var corpus = require('../lib/unitycomponent-v1-accepted-corpus.cjs');
var emitter = require('../lib/unitycomponent-v1-emitter.cjs');
var hardgate = require('../lib/unitycomponent-v1-hardgate.cjs');

var repoRoot = path.join(__dirname, '..');
var envRoot = process.env.UNITYCOMPONENT_ACCEPTED_CORPUS_ROOT || '';
var candidateRoots = [envRoot || corpus.defaultCorpusRoot(repoRoot)];

var acceptedDirs = corpus.discoverAcceptedArtifactDirs(candidateRoots, { maxDepth: 2 });

if (acceptedDirs.length < 5) {
  throw new Error((envRoot ? 'UNITYCOMPONENT_ACCEPTED_CORPUS_ROOT' : 'test/fixtures/unitycomponent-v1-accepted-corpus') + ' must contain at least 5 accepted artifact directories; found ' + acceptedDirs.length);
}

var corpusSummary = corpus.summarizeAcceptedArtifacts(acceptedDirs.slice(0, 5));
assert.strictEqual(corpusSummary.sourceEvidencePolicy, 'optional-pair-validated');
assert.strictEqual(corpusSummary.evidence.partialPairs, 0, 'accepted corpus source evidence must not contain partial report/summary pairs');
assert.strictEqual(corpusSummary.evidence.failedPairs, 0, 'included source evidence metadata must be passing');
assert.ok(corpusSummary.evidence.completePairs >= 4, 'repo corpus should preserve available source report/build summary evidence');
assert.strictEqual(
  corpusSummary.evidence.completePairs + corpusSummary.evidence.absentPairs,
  corpusSummary.sampleCount,
  'source evidence metadata is optional as a pair; core artifact evidence remains mandatory'
);

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unitycomponent-v1-accepted-corpus-'));
acceptedDirs.slice(0, 5).forEach(function(artifactDir, index) {
  corpus.assertAcceptedArtifactEvidence(artifactDir);
  var unityDir = path.join(tmp, 'unity-' + index);
  var result = emitter.emitFromArtifacts(artifactDir, unityDir, { generatedAt: '2026-06-23T00:00:00.000Z' });
  assert.strictEqual(result.report.passed, true, artifactDir + ': ' + JSON.stringify(result.report.errors, null, 2));
  assert.strictEqual(hardgate.validateUnityComponentV1(unityDir).passed, true, artifactDir + ' hardgate');
  assert.ok(result.spec.phases.length > 0, artifactDir + ' should project accepted phases');
  assert.strictEqual(result.spec.profile, 'unitycomponent-v1', artifactDir + ' profile');
});

console.log('unitycomponent v1 accepted artifact corpus tests passed: ' + acceptedDirs.slice(0, 5).join(', '));
