#!/usr/bin/env node
'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

var parity = require('../lib/unity-native-webgl-parity.cjs');

function sourceIrFixture() {
  return {
    schemaVersion: 'source-scene-ir.v1',
    kind: 'blueprint.sourceSceneIR',
    semanticHash: 'source-semantic-hash-123',
    entities: [
      { id: 'Player', kind: 'player' },
      { id: 'Gem', kind: 'resource' },
      { id: 'CtaButton', kind: 'cta' }
    ],
    resources: [{ id: 'GemCount', label: 'Gems', kind: 'resource' }],
    phases: [
      {
        id: 'phase1',
        guideText: 'Collect the gem',
        showEntities: ['Player', 'Gem'],
        steps: [
          { kind: 'move_to', target: 'Gem', radius: 1.2 },
          { kind: 'collect', resource: 'GemCount', amount: 1, from: 'Gem' }
        ],
        gate: { kind: 'resource', resource: 'GemCount', threshold: 1 }
      },
      {
        id: 'phase2',
        guideText: 'Tap install',
        showEntities: ['Player', 'CtaButton'],
        targetSequence: ['CtaButton'],
        steps: [{ kind: 'cta_finish', entity: 'CtaButton' }],
        gate: { kind: 'cta_arrival', entity: 'CtaButton' }
      }
    ]
  };
}

function matchingSnapshot() {
  return {
    kind: 'blueprint.unityNativeWebglRuntimeParity',
    profile: 'unitycomponent-v1',
    sourceIrSemanticHash: 'source-semantic-hash-123',
    unityDeliverySpecSemanticHash: 'unity-spec-hash-456',
    phaseIndex: 0,
    currentPhaseId: 'phase1',
    currentGuideText: 'Collect the gem',
    phases: [
      {
        id: 'phase1',
        guideText: 'Collect the gem',
        showEntities: ['Player', 'Gem'],
        targetSequence: ['Gem', 'GemCount'],
        gate: { kind: 'resource', resource: 'GemCount', threshold: 1 },
        steps: [
          { kind: 'move_to', target: 'Gem', radius: 1.2 },
          { kind: 'collect', resource: 'GemCount', amount: 1, from: 'Gem' }
        ]
      },
      {
        id: 'phase2',
        guideText: 'Tap install',
        showEntities: ['Player', 'CtaButton'],
        targetSequence: ['CtaButton'],
        gate: { kind: 'cta_arrival', entity: 'CtaButton' },
        steps: [{ kind: 'cta_finish', entity: 'CtaButton' }]
      }
    ],
    entities: ['Player', 'Gem', 'CtaButton'],
    resources: [{ id: 'GemCount', label: 'Gems', kind: 'resource' }]
  };
}

var sourceIr = sourceIrFixture();
var snapshot = matchingSnapshot();
var report = parity.compareSourceToRuntime(sourceIr, snapshot, {
  unityDeliverySpecSemanticHash: 'unity-spec-hash-456'
});
assert.strictEqual(report.passed, true, JSON.stringify(report.diffs, null, 2));
assert.strictEqual(report.diffCount, 0);

var guideDrift = matchingSnapshot();
guideDrift.phases[0].guideText = 'Wrong guide';
var guideReport = parity.compareSourceToRuntime(sourceIr, guideDrift);
assert.strictEqual(guideReport.passed, false);
assert.ok(guideReport.diffs.some(function(diff) { return diff.path === '$.phases[0].guideText'; }));

var gateDrift = matchingSnapshot();
gateDrift.phases[0].gate.threshold = 2;
var gateReport = parity.compareSourceToRuntime(sourceIr, gateDrift);
assert.strictEqual(gateReport.passed, false);
assert.ok(gateReport.diffs.some(function(diff) { return diff.path === '$.phases[0].gate.threshold'; }));

var stepDrift = matchingSnapshot();
stepDrift.phases[0].steps[1].amount = 2;
var stepReport = parity.compareSourceToRuntime(sourceIr, stepDrift);
assert.strictEqual(stepReport.passed, false);
assert.ok(stepReport.diffs.some(function(diff) { return diff.path === '$.phases[0].steps[1].amount'; }));

var resourceDrift = matchingSnapshot();
resourceDrift.resources[0].label = 'Coins';
var resourceReport = parity.compareSourceToRuntime(sourceIr, resourceDrift);
assert.strictEqual(resourceReport.passed, false);
assert.ok(resourceReport.diffs.some(function(diff) { return diff.path === '$.resources[0].label'; }));

var hashDrift = matchingSnapshot();
hashDrift.sourceIrSemanticHash = 'wrong';
var hashReport = parity.compareSourceToRuntime(sourceIr, hashDrift);
assert.strictEqual(hashReport.passed, false);
assert.ok(hashReport.diffs.some(function(diff) { return diff.path === '$.hashChecks.source-ir-semantic-hash'; }));

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unity-native-webgl-parity-'));
var sourcePath = path.join(tmp, 'source-ir.json');
var snapshotPath = path.join(tmp, 'runtime-snapshot.json');
var outPath = path.join(tmp, 'UNITY_NATIVE_WEBGL_PARITY_REPORT.json');
fs.writeFileSync(sourcePath, JSON.stringify(sourceIr, null, 2) + '\n');
fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2) + '\n');
var stdout = childProcess.execFileSync(process.execPath, [
  'scripts/unity-native-webgl-parity.cjs',
  '--source-ir',
  sourcePath,
  '--runtime-snapshot',
  snapshotPath,
  '--unity-delivery-spec-semantic-hash',
  'unity-spec-hash-456',
  '--out',
  outPath
], {
  cwd: path.join(__dirname, '..'),
  encoding: 'utf8'
});
var cli = JSON.parse(stdout);
assert.strictEqual(cli.ok, true);
assert.strictEqual(JSON.parse(fs.readFileSync(outPath, 'utf8')).passed, true);

var webglDir = path.join(tmp, 'webgl');
fs.mkdirSync(webglDir, { recursive: true });
fs.writeFileSync(path.join(webglDir, 'index.html'), [
  '<!doctype html>',
  '<html><head><meta charset="utf-8"><title>Native WebGL Parity Fixture</title></head>',
  '<body><canvas id="unity-canvas"></canvas>',
  '<script>',
  'window.__BLUEPRINT_UNITY_RUNTIME_PARITY__ = ' + JSON.stringify(snapshot) + ';',
  'window.__BLUEPRINT_UNITY_RUNTIME_PARITY_RAW__ = JSON.stringify(window.__BLUEPRINT_UNITY_RUNTIME_PARITY__);',
  '</script>',
  '</body></html>'
].join('\n'));
var browserOutPath = path.join(tmp, 'UNITY_NATIVE_WEBGL_PARITY_REPORT.browser.json');
var browserSnapshotPath = path.join(tmp, 'UNITY_NATIVE_WEBGL_RUNTIME_SNAPSHOT.browser.json');
var browserStdout = childProcess.execFileSync(process.execPath, [
  'scripts/unity-native-webgl-parity.cjs',
  '--source-ir',
  sourcePath,
  '--webgl-dir',
  webglDir,
  '--runtime-snapshot-out',
  browserSnapshotPath,
  '--unity-delivery-spec-semantic-hash',
  'unity-spec-hash-456',
  '--out',
  browserOutPath,
  '--timeout-ms',
  '15000'
], {
  cwd: path.join(__dirname, '..'),
  encoding: 'utf8'
});
var browserCli = JSON.parse(browserStdout);
assert.strictEqual(browserCli.ok, true);
var browserReport = JSON.parse(fs.readFileSync(browserOutPath, 'utf8'));
assert.strictEqual(browserReport.passed, true);
assert.ok(/^http:\/\/127\.0\.0\.1:/.test(browserReport.runtimeUrl), 'webgl-dir parity should read snapshot through a local browser URL');
assert.strictEqual(browserReport.runtimeSnapshotPath, browserSnapshotPath);
assert.deepStrictEqual(JSON.parse(fs.readFileSync(browserSnapshotPath, 'utf8')), snapshot);
assert.strictEqual(browserReport.summary.expected.phaseCount, 2);
assert.strictEqual(browserReport.summary.runtime.entityCount, 3);

console.log('unity native webgl parity tests passed');
