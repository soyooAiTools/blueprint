#!/usr/bin/env node
'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var build = require('../scripts/unity-native-webgl-build.cjs');

function fixtureArtifacts() {
  return path.join(__dirname, 'fixtures', 'unitycomponent-v1-accepted-corpus', 'firstbatch-action-01');
}

function writeFakeUnity(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/bin/sh\nset -eu\n' + body);
  fs.chmodSync(file, 0o755);
}

var parsed = build.parseArgs([
  '--artifacts-dir',
  fixtureArtifacts(),
  '--unity-out',
  '/tmp/native-unity',
  '--webgl-out',
  '/tmp/native-webgl',
  '--unity',
  '/tmp/Unity',
  '--required'
]);
assert.strictEqual(parsed.required, true);
assert.strictEqual(parsed.artifactsDir, fixtureArtifacts());

var editorScript = build.editorBuildScriptText();
assert.ok(/BuildTarget\.WebGL/.test(editorScript), 'native build method must target BuildTarget.WebGL');
assert.ok(/BuildPipeline\.BuildPlayer/.test(editorScript), 'native build method must use Unity BuildPipeline');
assert.ok(/public static class BlueprintNativeWebGLBuild/.test(editorScript), 'executeMethod class should be stable');
assert.ok(/public static void Build\(\)/.test(editorScript), 'executeMethod method should be stable');
var templateHtml = build.webglTemplateIndexHtmlText();
assert.ok(/devicePixelRatio:\s*Math\.min\(0\.45, Math\.max\(0\.35, 480 \//.test(templateHtml), 'native WebGL template must use the stable native-WebGL DPR budget');
assert.ok(/createUnityInstance/.test(templateHtml), 'native WebGL template must still use Unity loader output');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unity-native-webgl-build-'));
var missingUnity = path.join(tmp, 'missing', 'Editor', 'Unity');
var missingSupport = build.webglSupportStatus(missingUnity);
assert.strictEqual(missingSupport.present, false);
assert.ok(/PlaybackEngines\/WebGLSupport$/.test(missingSupport.webglSupportPath));

var dryRunDir = path.join(tmp, 'dry-unity');
var dryRunWebgl = path.join(tmp, 'dry-webgl');
var dryRunReportPath = path.join(tmp, 'dry-report.json');
var dryRun = build.runNativeWebglBuild({
  artifactsDir: fixtureArtifacts(),
  unityOut: dryRunDir,
  webglOut: dryRunWebgl,
  unity: missingUnity,
  report: dryRunReportPath,
  dryRun: true,
  generatedAt: '2026-06-30T00:00:00.000Z'
});
assert.strictEqual(dryRun.status, 'dry-run');
assert.ok(fs.existsSync(path.join(dryRunDir, 'Assets', 'Editor', 'BlueprintNativeWebGLBuild.cs')));
assert.ok(fs.existsSync(path.join(dryRunDir, 'Assets', 'Plugins', 'WebGL', 'BlueprintNativeWebGLBridge.jslib')));
assert.ok(fs.existsSync(path.join(dryRunDir, 'Assets', 'WebGLTemplates', 'BlueprintPlayable', 'index.html')));
assert.strictEqual(dryRun.webglTemplate.id, 'PROJECT:BlueprintPlayable');
assert.strictEqual(dryRun.webglTemplate.devicePixelRatio, 0.45);
assert.strictEqual(dryRun.webglTemplate.minDevicePixelRatio, 0.35);
assert.strictEqual(dryRun.webglTemplate.targetRenderWidth, 480);

var fakeNoSupport = path.join(tmp, 'fake-no-support', 'Editor', 'Unity');
writeFakeUnity(fakeNoSupport, 'exit 99\n');
var blockedReportPath = path.join(tmp, 'blocked-report.json');
var blocked = build.runNativeWebglBuild({
  artifactsDir: fixtureArtifacts(),
  unityOut: path.join(tmp, 'blocked-unity'),
  webglOut: path.join(tmp, 'blocked-webgl'),
  unity: fakeNoSupport,
  report: blockedReportPath,
  required: false
});
assert.strictEqual(blocked.status, 'blocked');
assert.strictEqual(blocked.reason, 'unity-webgl-support-missing');
assert.strictEqual(JSON.parse(fs.readFileSync(blockedReportPath, 'utf8')).status, 'blocked');

assert.throws(function() {
  build.runNativeWebglBuild({
    artifactsDir: fixtureArtifacts(),
    unityOut: path.join(tmp, 'blocked-required-unity'),
    webglOut: path.join(tmp, 'blocked-required-webgl'),
    unity: fakeNoSupport,
    report: path.join(tmp, 'blocked-required-report.json'),
    required: true
  });
}, /WebGL Build Support is missing/);

var fakeUnity = path.join(tmp, 'fake-with-support', 'Editor', 'Unity');
var repoRoot = path.join(__dirname, '..');
fs.mkdirSync(path.join(tmp, 'fake-with-support', 'Editor', 'Data', 'PlaybackEngines', 'WebGLSupport'), { recursive: true });
writeFakeUnity(fakeUnity, [
  'log=""',
  'project=""',
  'while [ "$#" -gt 0 ]; do',
  '  case "$1" in',
  '    -logFile) log="$2"; shift 2 ;;',
  '    -projectPath) project="$2"; shift 2 ;;',
  '    *) shift ;;',
  '  esac',
  'done',
  'mkdir -p "$BLUEPRINT_NATIVE_WEBGL_OUT/Build"',
  'node - "$project" "$BLUEPRINT_NATIVE_WEBGL_OUT" "$BLUEPRINT_SOURCE_IR_SEMANTIC_HASH" "$BLUEPRINT_UNITY_DELIVERY_SPEC_SEMANTIC_HASH" ' + JSON.stringify(repoRoot) + ' <<\'NODE\'',
  'const fs = require("fs");',
  'const path = require("path");',
  'const project = process.argv[2];',
  'const webglOut = process.argv[3];',
  'const sourceHash = process.argv[4];',
  'const specHash = process.argv[5];',
  'const repoRoot = process.argv[6];',
  'const projector = require(path.join(repoRoot, "lib", "unity-delivery-spec-projector.cjs"));',
  'const sourceIr = JSON.parse(fs.readFileSync(path.join(project, "source-ir.json"), "utf8"));',
  'const semantic = projector.sourceSemanticProjection(sourceIr);',
  'const snapshot = {',
  '  kind: "blueprint.unityNativeWebglRuntimeParity",',
  '  profile: "unitycomponent-v1",',
  '  sourceIrSemanticHash: sourceHash,',
  '  unityDeliverySpecSemanticHash: specHash,',
  '  phaseIndex: 0,',
  '  currentPhaseId: semantic.phases[0] && semantic.phases[0].id || "",',
  '  currentGuideText: semantic.phases[0] && semantic.phases[0].guideText || "",',
  '  phases: semantic.phases,',
  '  entities: semantic.entities,',
  '  resources: semantic.resources',
  '};',
  'fs.writeFileSync(path.join(webglOut, "index.html"), [',
  '  "<!doctype html>",',
  '  "<html><head><meta charset=\\"utf-8\\"><title>Unity WebGL</title></head><body>",',
  '  "<canvas id=\\"unity-canvas\\"></canvas>",',
  '  "<script>window.__BLUEPRINT_UNITY_RUNTIME_PARITY__ = " + JSON.stringify(snapshot) + "; window.__BLUEPRINT_UNITY_RUNTIME_PARITY_RAW__ = JSON.stringify(window.__BLUEPRINT_UNITY_RUNTIME_PARITY__);</script>",',
  '  "</body></html>"',
  '].join("\\n"));',
  'NODE',
  'cat > "$BLUEPRINT_NATIVE_WEBGL_EDITOR_REPORT" <<EOF',
  '{',
  '  "kind": "blueprint.unityNativeWebglEditorBuildReport",',
  '  "schemaVersion": 1,',
  '  "status": "passed",',
  '  "target": "WebGL",',
  '  "outputPath": "${BLUEPRINT_NATIVE_WEBGL_OUT}",',
  '  "sourceIrSemanticHash": "${BLUEPRINT_SOURCE_IR_SEMANTIC_HASH}",',
  '  "unityDeliverySpecSemanticHash": "${BLUEPRINT_UNITY_DELIVERY_SPEC_SEMANTIC_HASH}",',
  '  "result": "Succeeded",',
  '  "totalErrors": 0,',
  '  "totalWarnings": 0',
  '}',
  'EOF',
  'cat > "$log" <<EOF',
  'BatchMode: 1',
  'COMMAND LINE ARGUMENTS:',
  'Unity',
  '-batchmode',
  '-quit',
  '-nographics',
  '-projectPath',
  '$project',
  '-executeMethod',
  'BlueprintNativeWebGLBuild.Build',
  'EOF',
  'exit 0'
].join('\n'));
var passed = build.runNativeWebglBuild({
  artifactsDir: fixtureArtifacts(),
  unityOut: path.join(tmp, 'passed-unity'),
  webglOut: path.join(tmp, 'passed-webgl'),
  unity: fakeUnity,
  report: path.join(tmp, 'passed-report.json'),
  log: path.join(tmp, 'passed-unity.log'),
  required: true
});
assert.strictEqual(passed.status, 'passed', JSON.stringify(passed, null, 2));
assert.strictEqual(passed.outputChecks.indexHtml, true);
assert.strictEqual(passed.outputChecks.buildDir, true);
assert.strictEqual(passed.outputChecks.parityReport, true);
assert.strictEqual(passed.outputChecks.runtimeSnapshot, true);
assert.ok(passed.parityReportPath && fs.existsSync(passed.parityReportPath), 'native build must write a WebGL parity report');
assert.ok(passed.paritySnapshotPath && fs.existsSync(passed.paritySnapshotPath), 'native build must write the Unity runtime parity snapshot');
assert.strictEqual(passed.parityGate.report.passed, true);
assert.strictEqual(passed.parityGate.report.runtimeSnapshotPath, passed.paritySnapshotPath);
assert.strictEqual(passed.parityGate.report.summary.expected.phaseCount, passed.parityGate.report.summary.runtime.phaseCount);
assert.strictEqual(passed.logAudit.projectPathReferenced, true);
assert.strictEqual(passed.editorReport.target, 'WebGL');

var fakeUnityDrift = path.join(tmp, 'fake-with-support-drift', 'Editor', 'Unity');
fs.mkdirSync(path.join(tmp, 'fake-with-support-drift', 'Editor', 'Data', 'PlaybackEngines', 'WebGLSupport'), { recursive: true });
var driftScript = fs.readFileSync(fakeUnity, 'utf8').replace(
  'fs.writeFileSync(path.join(webglOut, "index.html"), [',
  'snapshot.phases[0].guideText = "Drifted guide";\nfs.writeFileSync(path.join(webglOut, "index.html"), ['
);
fs.writeFileSync(fakeUnityDrift, driftScript);
fs.chmodSync(fakeUnityDrift, 0o755);
var driftReportPath = path.join(tmp, 'drift-report.json');
assert.throws(function() {
  build.runNativeWebglBuild({
    artifactsDir: fixtureArtifacts(),
    unityOut: path.join(tmp, 'drift-unity'),
    webglOut: path.join(tmp, 'drift-webgl'),
    unity: fakeUnityDrift,
    report: driftReportPath,
    log: path.join(tmp, 'drift-unity.log'),
    required: true,
    parityTimeoutMs: 15000
  });
}, /Unity native WebGL build failed/);
var driftReport = JSON.parse(fs.readFileSync(driftReportPath, 'utf8'));
assert.strictEqual(driftReport.status, 'failed');
assert.strictEqual(driftReport.reason, 'unity-native-webgl-parity-failed');
assert.strictEqual(driftReport.parityGate.report.passed, false);
assert.ok(driftReport.parityGate.report.diffs.some(function(diff) {
  return diff.path === '$.phases[0].guideText';
}), 'parity failure should identify guideText drift');

console.log('unity native webgl build tests passed');
