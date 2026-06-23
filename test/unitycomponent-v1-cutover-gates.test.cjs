#!/usr/bin/env node
'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var cutover = require('../scripts/unitycomponent-v1-cutover-gates.cjs');

var repoRoot = path.join(__dirname, '..');
var corpusRoot = path.join(repoRoot, 'test', 'fixtures', 'unitycomponent-v1-accepted-corpus');

var parsed = cutover.parseArgs(['--no-unity', '--limit', '5', '--min-count', '5']);
assert.strictEqual(parsed.unityMode, 'disabled');
assert.strictEqual(parsed.limit, 5);
assert.strictEqual(parsed.minCount, 5);

var outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitycomponent-v1-cutover-gates-test-'));
var scaffoldReport = cutover.runCutoverGates({
  corpusRoots: [corpusRoot],
  outDir: path.join(outDir, 'scaffold-only'),
  limit: 5,
  minCount: 5,
  unityMode: 'disabled',
  generatedAt: '2026-06-23T00:00:00.000Z'
});

assert.strictEqual(scaffoldReport.status, 'scaffold-only');
assert.strictEqual(scaffoldReport.cutoverReady, false);
assert.strictEqual(scaffoldReport.selectedSampleCount, 5);
assert.strictEqual(scaffoldReport.gates.acceptedCorpus.status, 'passed');
assert.strictEqual(scaffoldReport.gates.emitterHardgate.status, 'passed');
assert.strictEqual(scaffoldReport.gates.unityImportCompile.status, 'not-run');
assert.strictEqual(scaffoldReport.gates.acceptedCorpus.evidence.partialPairs, 0);
assert.ok(scaffoldReport.gates.acceptedCorpus.evidence.completePairs >= 4);
assert.ok(fs.existsSync(scaffoldReport.reportPath), 'cutover summary report should be written');
scaffoldReport.samples.forEach(function(sample) {
  assert.strictEqual(sample.exportPassed, true, sample.name + ' export');
  assert.strictEqual(sample.hardgatePassed, true, sample.name + ' hardgate');
  assert.strictEqual(sample.unitySmokeStatus, 'not-run', sample.name + ' no Unity mode');
  assert.ok(fs.existsSync(sample.projectPath), sample.name + ' generated project');
  assert.ok(fs.existsSync(sample.hardgateReportPath), sample.name + ' hardgate report');
});

var optionalReport = cutover.runCutoverGates({
  corpusRoots: [corpusRoot],
  outDir: path.join(outDir, 'optional-missing-unity'),
  limit: 1,
  minCount: 1,
  unityMode: 'optional',
  unity: path.join(outDir, 'missing-unity'),
  generatedAt: '2026-06-23T00:00:00.000Z'
});

assert.strictEqual(optionalReport.status, 'scaffold-only');
assert.strictEqual(optionalReport.cutoverReady, false);
assert.strictEqual(optionalReport.gates.unityImportCompile.status, 'skipped');
assert.strictEqual(optionalReport.samples[0].unitySmokeStatus, 'skipped');
assert.deepStrictEqual(optionalReport.errors, []);

var requiredReport = cutover.runCutoverGates({
  corpusRoots: [corpusRoot],
  outDir: path.join(outDir, 'required-missing-unity'),
  limit: 1,
  minCount: 1,
  unityMode: 'required',
  unity: path.join(outDir, 'missing-unity'),
  generatedAt: '2026-06-23T00:00:00.000Z'
});

assert.strictEqual(requiredReport.status, 'failed');
assert.strictEqual(requiredReport.cutoverReady, false);
assert.strictEqual(requiredReport.gates.unityImportCompile.status, 'failed');
assert.strictEqual(requiredReport.samples[0].unitySmokeStatus, 'skipped');
assert.ok(fs.existsSync(requiredReport.samples[0].unitySmokeReportPath), 'required missing Unity should still write smoke report');
assert.ok(requiredReport.errors.some(function(error) {
  return error.code === 'unity-smoke-failed' && /Unity executable not found/.test(error.message);
}));

console.log('unitycomponent v1 cutover gates tests passed');
