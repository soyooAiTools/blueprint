'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var manifest = require('../engine/playable-flow-manifest.cjs');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playable-flow-manifest-'));
var htmlPath = path.join(tmp, 'index.html');
var reportPath = path.join(tmp, 'unity-verify-report.json');
var summaryPath = path.join(tmp, 'unity-verify-summary.json');
var validationPath = path.join(tmp, 'DELIVERY_VALIDATION.json');
var deliverySummaryPath = path.join(tmp, 'PROGRAMMER_DELIVERY_SUMMARY.json');

fs.writeFileSync(htmlPath, '<!doctype html><html></html>');
fs.writeFileSync(reportPath, JSON.stringify({ phaseCoverage: '2/2', signalCoverage: '3/3' }, null, 2));
fs.writeFileSync(summaryPath, JSON.stringify({
  runner: 'production',
  passed: true,
  telemetry: {
    schemaVersion: 'blueprint-cua-telemetry.v1',
    taskId: 'manifest-test',
    phaseCount: 2,
    observeMs: 100,
    manualProbeMs: 50,
    manualFlowMs: 75,
    totalMs: 250,
  },
  runtimeContractSummary: {
    passed: true,
    contractPassed: true,
    telemetry: {
      schemaVersion: 'blueprint-cua-telemetry.v1',
      taskId: 'manifest-test',
      phaseCount: 2,
      observeMs: 100,
      manualProbeMs: 50,
      manualFlowMs: 75,
      totalMs: 250,
    },
    manualJoystickFlowProbeRequired: true,
    manualJoystickFlowProbePassed: true,
    manualJoystickFlowProbe: {
      passed: true,
      skipped: false,
      completedAfter: 2,
      targetCompleted: 2,
      phasePath: ['phase1', 'phase2'],
      missingPhasePath: [],
      phasePathSource: 'phase-witness',
      driver: 'autonav-joystick',
      dragCount: 2,
      maxPlayerDistance: 1.5,
    },
  },
}, null, 2));

manifest.recordDemo2SpecVerify({
  outDir: tmp,
  reportPath: reportPath,
  summaryPath: summaryPath,
  runner: 'production',
});

var preflightPath = path.join(tmp, 'storyboard2html-preflight.json');
fs.writeFileSync(preflightPath, JSON.stringify({ passed: true, errors: [], details: { hasJoystickControl: true } }, null, 2));
manifest.recordStoryboard2HtmlPreflight({
  outDir: tmp,
  htmlPath: htmlPath,
  preflightPath: preflightPath,
});

manifest.recordStoryboard2HtmlSmoke({
  outDir: tmp,
  htmlPath: htmlPath,
  verifyReportPath: reportPath,
  verifySummaryPath: summaryPath,
  hardgateResult: {
    passed: true,
    gates: [{ id: 'production-runtime-cua-hard-gates', passed: true, errors: [] }],
  },
});

fs.writeFileSync(validationPath, JSON.stringify({ passed: true, errors: [], warnings: [] }, null, 2));
fs.writeFileSync(deliverySummaryPath, JSON.stringify({ taskId: 'task_1' }, null, 2));
manifest.recordExportDelivery({
  outDir: tmp,
  summaryPath: deliverySummaryPath,
  validationPath: validationPath,
  taskId: 'task_1',
});

var doc = JSON.parse(fs.readFileSync(path.join(tmp, 'playable-flow-manifest.json'), 'utf8'));
assert.strictEqual(doc.kind, manifest.KIND);
assert.strictEqual(doc.schemaVersion, manifest.SCHEMA_VERSION);
assert.ok(doc.artifacts.generatedHtml.sha256);
assert.strictEqual(doc.stages.demo2specVerify.runner, 'production');
assert.strictEqual(doc.stages.demo2specVerify.telemetry.totalMs, 250);
assert.strictEqual(doc.stages.storyboard2htmlPreflight.passed, true);
assert.strictEqual(doc.stages.storyboard2htmlSmoke.passed, true);
assert.strictEqual(doc.stages.storyboard2htmlSmoke.runtimeContractSummary.manualJoystickFlowProbe.maxPlayerDistance, 1.5);
assert.strictEqual(doc.stages.storyboard2htmlSmoke.runtimeContractSummary.manualJoystickFlowProbe.driver, 'autonav-joystick');
assert.strictEqual(doc.stages.storyboard2htmlSmoke.runtimeContractSummary.manualJoystickFlowProbe.phasePathSource, 'phase-witness');
assert.strictEqual(doc.stages.storyboard2htmlSmoke.telemetry.manualFlowMs, 75);
assert.strictEqual(doc.stages.programmerDeliveryExport.passed, true);

console.log('playable flow manifest tests passed');
