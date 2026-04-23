#!/usr/bin/env node

var assert = require('assert');
var worker = require('../worker/worker-playableagent.js');

var logs = [];
function log(message) {
  logs.push(message);
}

var report = {
  passed: true,
  observe_mode: true,
  specPhases: ['intro', 'build', 'end'],
  coveredPhases: ['intro', 'build'],
  missingPhases: ['end'],
  planCoverage: '2/3',
  signalCoverage: '1/3',
  signalValidationPassed: false,
  coveredSignals: ['intro:guide_text_visible'],
  missingSignals: ['build:entity_state_equals_built', 'build:downstream_entity_visible'],
  unsupportedSignals: ['intro:camera_orientation_changed'],
  finalState: {
    currentPhase: 'build',
    completedPhases: ['intro', 'build'],
    variables: { autoPlayMode: true, gold: 1, score: 0, phaseTimer: 2 },
    entityStates: { conveyor: 2 }
  },
  actions: [],
  exitReason: 'signal_validation_failed',
};

var normalized = worker.summarizePlayableAgentReport(report, 'task_signal', log);

assert.strictEqual(normalized.passed, false, '[1.1] missing signals must force FAIL');
assert.strictEqual(normalized.signalCoverage, '1/3', '[1.2] signal coverage propagated');
assert.strictEqual(normalized.planCoverage, '2/3', '[1.3] plan coverage propagated');
assert.deepStrictEqual(normalized.missingSignals, report.missingSignals, '[1.4] missing signals preserved');
assert.deepStrictEqual(normalized.unsupportedSignals, report.unsupportedSignals, '[1.5] unsupported signals preserved');
assert.ok(
  normalized.issues.some(function(issue) { return issue.indexOf('[signal-coverage]') === 0; }),
  '[1.6] signal coverage issue emitted'
);
assert.ok(
  normalized.issues.some(function(issue) { return issue.indexOf('[spec-phase-skipped]') === 0; }),
  '[1.7] phase coverage issue still emitted'
);
assert.strictEqual(normalized.report.signalCoverage, '1/3', '[1.8] normalized report exposes signal coverage');
assert.strictEqual(normalized.report.planCoverage, '2/3', '[1.9] normalized report exposes plan coverage');
assert.strictEqual(normalized.report.signalValidationPassed, false, '[1.10] normalized report exposes validation flag');
assert.ok(
  logs.some(function(message) { return message.indexOf('Unsupported signal assertions') >= 0; }),
  '[1.11] unsupported signals should be logged as non-blocking'
);

console.log('playableagent-report-normalization tests passed');
