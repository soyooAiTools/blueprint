#!/usr/bin/env node

var assert = require('assert');
var worker = require('../worker/worker-playableagent.js');

function makeReport(overrides) {
  return Object.assign({
    passed: true,
    observe_mode: true,
    specPhases: ['phase_a', 'phase_b'],
    coveredPhases: ['phase_a', 'phase_b'],
    completedPhases: ['phase_a', 'phase_b'],
    missingPhases: [],
    planCoverage: '2/2',
    signalCoverage: '4/4',
    signalValidationPassed: true,
    coveredSignals: ['phase_a:phase_advanced', 'phase_a:visual_variant_changed', 'phase_b:phase_advanced', 'phase_b:visual_variant_changed'],
    missingSignals: [],
    unsupportedSignals: [],
    phaseStepsSnapshot: { phase_a: 0, phase_b: 0 },
    visual_quality: {
      total_frames: 6,
      changed_frames: 5,
      frozen_frames: 1,
      max_frozen_streak: 1,
      frozen_ratio: 0.167,
    },
    visual_smoke: {
      screenQualityCounts: { normal: 6 },
      maxBadScreenStreak: 0,
      lastBadScreenQuality: '',
    },
    finalState: {
      currentPhase: 'gameEnd',
      completedPhases: ['phase_a', 'phase_b'],
      phaseTimestamps: { phase_a: 12, phase_b: 24 },
      variables: {
        autoPlayMode: true,
        autoPlaySteps: 4,
        autoPlayStepsThisPhase: 0,
        gameTimer: 36,
        gold: 1,
      },
      entityStates: {},
    },
    actions: [],
    exitReason: 'game_ended',
  }, overrides || {});
}

var logs = [];
var soft = worker.summarizePlayableAgentReport(makeReport(), 'task_soft', function(message) {
  logs.push(message);
});

assert.strictEqual(soft.passed, true, 'full plan/signal coverage plus healthy observe visuals should pass');
assert.ok(
  soft.silentPassSignals.some(function(signal) { return signal.indexOf('autoplay-zero-steps') === 0; }),
  'autoplay-zero-steps remains visible as a soft warning'
);
assert.deepStrictEqual(soft.hardBlockingSilentSignals, [], 'autoplay-zero-steps should not hard-block a fully covered healthy observe pass');
assert.ok(
  logs.some(function(message) { return message.indexOf('downgraded to soft warn') >= 0; }),
  'soft downgrade should be logged for operators'
);

var hard = worker.summarizePlayableAgentReport(makeReport({
  visual_quality: {
    total_frames: 6,
    changed_frames: 1,
    frozen_frames: 5,
    max_frozen_streak: 4,
    frozen_ratio: 0.833,
  },
  visual_fail_reasons: ['Visual frozen: 5/6 frames had <0.5% pixel change.'],
}), 'task_hard', function() {});

assert.strictEqual(hard.passed, false, 'autoplay-zero-steps should still hard-block when observe visuals are unhealthy');
assert.ok(
  hard.hardBlockingSilentSignals.some(function(signal) { return signal.indexOf('autoplay-zero-steps') === 0; }),
  'unhealthy observe pass must keep autoplay-zero-steps hard-blocking'
);

console.log('playableagent autoplay-zero-steps softwarn tests passed');
