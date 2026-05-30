#!/usr/bin/env node
'use strict';

var assert = require('assert');
var report = require('../engine/fidelity-report.cjs');
var auditGate = require('../engine/fidelity-audit-gate.cjs');

function vec(x, y, z) { return { x: x, y: y, z: z }; }
function transform(x, y, z) {
  return { localPosition: vec(x, y, z), localRotation: vec(0, 0, 0), localScale: vec(1, 1, 1) };
}
function provenance(source, propertyPath) {
  return {
    source: source || 'unity',
    assetPath: 'Assets/Scenes/Game.unity',
    guid: 'scene-guid',
    fileID: '123',
    propertyPath: propertyPath || 'm_LocalPosition',
    confidence: 1
  };
}
function rendererAdapter() {
  return {
    three: { shader: {}, animator: {}, physics: {}, audio: {}, ui: {} },
    unity: { shader: {}, animator: {}, physics: {}, audio: {}, ui: {} }
  };
}
function sampleContract(overrides) {
  var doc = {
    schemaVersion: '1.0.0',
    kind: 'blueprint.fidelityContract',
    producerVersion: 'report-test.1',
    requiredCapabilities: [
      'geometry.primitiveHierarchy.v1',
      'geometry.localTransform.v1',
      'geometry.pivotBounds.v1',
      'material.fullSurface.v1',
      'material.precomputedGuid.v1',
      'rendererAdapter.driverMap.v1',
      'provenance.fieldLevel.v1'
    ],
    coordinateSystem: { source: 'three-rh', target: 'unity-lh', handedness: 'source-rh-target-lh', zFlip: true, unitScale: 1 },
    rendererAdapter: rendererAdapter(),
    entities: [
      {
        id: 'Player',
        name: 'Player',
        parentPath: '/SceneRoot',
        transform: transform(0, 0, 0),
        pivot: vec(0, 0.5, 0),
        bounds: { center: vec(0, 0.5, 0), size: vec(1, 1, 1) },
        provenance: provenance('unity', 'GameObject.Player'),
        primitives: [
          {
            id: 'Player.Body',
            name: 'SourcePrimitive_Player_00',
            parentPath: '/SceneRoot/Player',
            transform: transform(0, 0.5, 0),
            pivot: vec(0, 0.5, 0),
            bounds: { center: vec(0, 0.5, 0), size: vec(1, 1, 1) },
            mesh: { type: 'BoxGeometry', args: [1, 1, 1] },
            material: {
              id: 'mat.Player.Body',
              shader: 'URP/Lit',
              colors: { _Color: [0.91, 0.98, 1, 1], _ColorTint: [0.91, 0.98, 1, 1], _EmissionColor: [0.32, 0.34, 0.35, 1] },
              alpha: 1,
              blendMode: 'opaque',
              guid: '0d9c0a0a3f444962b10e6f41e06ef001',
              guidSeed: 'SourcePrimitive_Player_00.mat',
              guidAlgorithm: 'md5-lower-hex-32',
              contentHash: 'sha256:player-body'
            },
            provenance: provenance('unity', 'SourcePrimitive_Player_00')
          }
        ]
      }
    ],
    phases: [
      {
        id: 'phase1',
        showEntities: ['Player'],
        trigger: { type: 'steps_complete' },
        interactionGate: { type: 'arrival' },
        autoPlayGate: { type: 'arrival' },
        manualGate: { type: 'arrival' }
      }
    ],
    hud: [
      {
        id: 'targetHint',
        text: 'Target',
        anchor: { canvas: 'top-left', x: 24, y: 24 },
        consumer: ['html', 'unity'],
        provenance: provenance('html', 'Text_TargetHint')
      }
    ],
    unityCoverage: { status: 'complete', source: 'space-ranger-v15.6.15.22' },
    unresolvedFidelityGaps: [],
    contractConflicts: []
  };
  return Object.assign(doc, overrides || {});
}

var doc = sampleContract();
var passReport = report.buildFidelityReport({
  contract: doc,
  auditOptions: { target: 'unity', supportedCapabilities: doc.requiredCapabilities },
  generatedAt: '2026-05-28T16:00:00Z',
  fixture: 'space-ranger'
});
assert.strictEqual(passReport.json.kind, 'blueprint.fidelityContract.report');
assert.strictEqual(passReport.json.fixture, 'space-ranger');
assert.strictEqual(passReport.json.summary.passed, true);
assert.strictEqual(passReport.json.summary.auditPassed, true);
assert.strictEqual(passReport.json.summary.roundTripPassed, null);
assert.strictEqual(passReport.json.summary.blockingGapCount, 0);
assert.strictEqual(passReport.json.summary.unresolvedConflictCount, 0);
assert.strictEqual(passReport.json.summary.missingCapabilityCount, 0);
assert.ok(passReport.html.indexOf('no blocking gaps') >= 0);
assert.ok(passReport.html.indexOf('all required capabilities supported') >= 0);
assert.ok(passReport.html.indexOf('Waiting for Unity writer readback') >= 0);
assert.ok(passReport.html.indexOf('space-ranger') >= 0);
assert.ok(passReport.html.indexOf('PASS') >= 0);

var failContract = sampleContract({
  unresolvedFidelityGaps: [
    { id: 'missing-emission', path: 'entities.Player.primitives[0].material.colors._EmissionColor', blocking: true, reason: 'demo2spec did not extract _EmissionColor before #24' }
  ],
  contractConflicts: [
    { id: 'player-position', path: 'entities.Player.transform.localPosition', html: [0, 0, 0], unity: [-1.5, 0, -2] }
  ]
});
var failReport = report.buildFidelityReport({
  contract: failContract,
  auditOptions: { target: 'unity', supportedCapabilities: failContract.requiredCapabilities },
  generatedAt: '2026-05-28T16:00:00Z',
  fixture: 'space-ranger'
});
assert.strictEqual(failReport.json.summary.passed, false);
assert.strictEqual(failReport.json.summary.auditPassed, false);
assert.strictEqual(failReport.json.summary.blockingGapCount, 1);
assert.strictEqual(failReport.json.summary.unresolvedConflictCount, 1);
assert.ok(failReport.html.indexOf('missing-emission') >= 0);
assert.ok(failReport.html.indexOf('player-position') >= 0);
assert.ok(failReport.html.indexOf('FAIL') >= 0);

var roundTripReport = report.buildFidelityReport({
  contract: doc,
  auditOptions: { target: 'unity', supportedCapabilities: doc.requiredCapabilities },
  roundTrip: { passed: true, diffCount: 0, diffs: [] },
  fixture: 'space-ranger'
});
assert.strictEqual(roundTripReport.json.summary.passed, true);
assert.strictEqual(roundTripReport.json.summary.roundTripPassed, true);
assert.ok(roundTripReport.html.indexOf('readback diff = 0') >= 0);

var visualRequiredMissingReport = report.buildFidelityReport({
  contract: doc,
  auditOptions: { target: 'unity', supportedCapabilities: doc.requiredCapabilities },
  roundTrip: { passed: true, diffCount: 0, diffs: [] },
  evidencePolicy: { visual: 'required' },
  fixture: 'space-ranger'
});
assert.strictEqual(visualRequiredMissingReport.json.summary.passed, false);
assert.strictEqual(visualRequiredMissingReport.json.summary.visualRequired, true);
assert.strictEqual(visualRequiredMissingReport.json.summary.visualMissing, true);
assert.ok(visualRequiredMissingReport.html.indexOf('required missing') >= 0);

var visualPassReport = report.buildFidelityReport({
  contract: doc,
  auditOptions: { target: 'unity', supportedCapabilities: doc.requiredCapabilities },
  roundTrip: { passed: true, diffCount: 0, diffs: [] },
  visual: { passed: true, maxPercent: 1.2, phases: [{ id: 'phase1', diffPercent: 1.2, verdict: 'pass' }] },
  evidencePolicy: { visual: 'required' },
  fixture: 'space-ranger'
});
assert.strictEqual(visualPassReport.json.summary.passed, true);
assert.strictEqual(visualPassReport.json.summary.visualPassed, true);
assert.ok(visualPassReport.html.indexOf('visual=✓') >= 0);

var visualFailReport = report.buildFidelityReport({
  contract: doc,
  auditOptions: { target: 'unity', supportedCapabilities: doc.requiredCapabilities },
  roundTrip: { passed: true, diffCount: 0, diffs: [] },
  visual: { passed: false, maxPercent: 72.4, reason: 'source first frame differs from deployed WebGL', phases: [{ id: 'phase1', diffPercent: 72.4, verdict: 'fail' }] },
  evidencePolicy: { visual: 'required' },
  fixture: 'space-ranger'
});
assert.strictEqual(visualFailReport.json.summary.passed, false);
assert.strictEqual(visualFailReport.json.summary.visualPassed, false);
assert.ok(visualFailReport.html.indexOf('source first frame differs') >= 0);

var roundTripFailReport = report.buildFidelityReport({
  contract: doc,
  auditOptions: { target: 'unity', supportedCapabilities: doc.requiredCapabilities },
  roundTrip: {
    passed: false,
    diffCount: 1,
    diffs: [{ path: 'entities.Player.primitives.Player.Body.material', expected: { colors: { _EmissionColor: [0.32, 0.34, 0.35, 1] } }, actual: { colors: { _EmissionColor: [1, 0, 0, 1] } } }]
  },
  fixture: 'space-ranger'
});
assert.strictEqual(roundTripFailReport.json.summary.passed, false);
assert.strictEqual(roundTripFailReport.json.summary.roundTripPassed, false);
assert.ok(roundTripFailReport.html.indexOf('entities.Player.primitives.Player.Body.material') >= 0);

var precomputedAudit = auditGate.runAuditGate(doc, { target: 'unity', supportedCapabilities: ['geometry.primitiveHierarchy.v1'] });
var capReport = report.buildFidelityReport({
  contract: doc,
  auditResult: precomputedAudit,
  fixture: 'space-ranger'
});
assert.strictEqual(capReport.json.summary.auditPassed, false);
assert.strictEqual(capReport.json.summary.missingCapabilityCount, 6);
assert.ok(capReport.html.indexOf('material.fullSurface.v1') >= 0);

var coverageMissing = sampleContract({ unityCoverage: { status: 'missing', reason: 'pure HTML fixture migration' } });
var coverageReport = report.buildFidelityReport({
  contract: coverageMissing,
  auditOptions: { target: 'unity', supportedCapabilities: coverageMissing.requiredCapabilities },
  fixture: 'maishui'
});
assert.strictEqual(coverageReport.json.summary.passed, false);
assert.strictEqual(coverageReport.json.summary.unityCoverageFailure, true);
assert.ok(coverageReport.html.indexOf('blocks unity writer') >= 0);

var injectionAttempt = sampleContract({
  unresolvedFidelityGaps: [{ id: '<script>alert(1)</script>', path: 'a.b', blocking: true }]
});
var safeReport = report.buildFidelityReport({
  contract: injectionAttempt,
  auditOptions: { target: 'unity', supportedCapabilities: injectionAttempt.requiredCapabilities },
  fixture: 'space-ranger'
});
assert.ok(safeReport.html.indexOf('<script>alert(1)</script>') < 0);
assert.ok(safeReport.html.indexOf('&lt;script&gt;alert(1)&lt;/script&gt;') >= 0);

var advisoryReport = report.buildFidelityReport({
  contract: doc,
  auditOptions: { target: 'unity', supportedCapabilities: doc.requiredCapabilities },
  advisoryNotes: ['Tim space-ranger extractor in progress', 'Jonny Unity writer skeleton in progress']
});
assert.ok(advisoryReport.html.indexOf('Tim space-ranger extractor in progress') >= 0);
assert.strictEqual(advisoryReport.json.advisoryNotes.length, 2);

// Regression: P2 — buildFidelityReport must require explicit capabilities, not silently default to []
assert.throws(function() {
  report.buildFidelityReport({ contract: doc });
}, /supportedCapabilities is required/, 'must throw when contract supplied without auditOptions');
assert.throws(function() {
  report.buildFidelityReport({ contract: doc, auditOptions: { target: 'unity' } });
}, /supportedCapabilities is required/, 'must throw when auditOptions provided without supportedCapabilities');
assert.throws(function() {
  report.buildFidelityReport({});
}, /requires either contract.*or precomputed auditResult/, 'must throw when neither contract nor auditResult provided');

// Precomputed auditResult path must still work without auditOptions (gate-keeper observability mode)
var precomputed = auditGate.runAuditGate(doc, { target: 'unity', supportedCapabilities: doc.requiredCapabilities });
var precomputedReport = report.buildFidelityReport({ contract: doc, auditResult: precomputed, fixture: 'space-ranger' });
assert.strictEqual(precomputedReport.json.summary.auditPassed, true);

console.log('fidelity report tests passed');
