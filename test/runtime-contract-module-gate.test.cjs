#!/usr/bin/env node

var assert = require('assert');
var runtimeContract = require('../engine/stages/runtime-contract.cjs');

function baseResult(overrides) {
  var result = {
    passed: true,
    planCoverage: '2/2',
    signalCoverage: '2/2',
    signalValidationPassed: true,
    missingSignals: [],
    unsupportedSignals: [],
    visualFailReasons: [],
    silentPassSignals: [],
    hardBlockingSilentSignals: [],
    totalActions: 1,
    exitReason: 'completed',
    report: {
      gameState: { currentPhase: 'gameEnd', variables: {} },
      visualSmoke: {
        screenQualityCounts: { normal: 2 },
        maxBadScreenStreak: 0,
        lastBadScreenQuality: ''
      }
    }
  };
  Object.keys(overrides || {}).forEach(function(key) {
    result[key] = overrides[key];
  });
  return result;
}

var passSummary = runtimeContract.summarizeRuntimeContractResult(baseResult());
assert.strictEqual(passSummary.passed, true, '[1.1] complete module contract should pass');
assert.strictEqual(passSummary.needsEscalation, false, '[1.2] complete module contract should skip heavy CUA');
assert.strictEqual(passSummary.moduleContractReady, true, '[1.3] signal contract should mark module contract ready');
assert.deepStrictEqual(
  passSummary.visualSmoke,
  { screenQualityCounts: { normal: 2 }, maxBadScreenStreak: 0, lastBadScreenQuality: '' },
  '[1.4] runtime summary should preserve deterministic visual smoke metadata'
);

var noSignalsSummary = runtimeContract.summarizeRuntimeContractResult(baseResult({
  signalCoverage: null,
  signalValidationPassed: true,
  missingSignals: []
}));
assert.strictEqual(noSignalsSummary.passed, false, '[2.1] phase-only runs must not pass the module contract');
assert.strictEqual(noSignalsSummary.moduleContractReady, false, '[2.2] missing signalCoverage should be explicit');
assert.ok(
  noSignalsSummary.escalationReasons.indexOf('module-contract-incomplete') >= 0,
  '[2.3] missing module contract should explain escalation'
);
assert.ok(
  noSignalsSummary.escalationReasons.indexOf('signal-validation-failed') >= 0,
  '[2.4] missing signal contract should not be silently treated as signal pass'
);

var visualSummary = runtimeContract.summarizeRuntimeContractResult(baseResult({
  visualFailReasons: ['Visual smoke failed: loading screen persisted for 3/4 observed frames.']
}));
assert.strictEqual(visualSummary.passed, false, '[3.1] visual smoke failures should block contract pass');
assert.ok(
  visualSummary.escalationReasons.indexOf('visual-smoke-failed') >= 0,
  '[3.2] visual smoke failure should explain escalation'
);

var defaultInteractionSummary = runtimeContract.summarizeRuntimeContractResult(baseResult({
  defaultInteractionRequired: true,
  defaultInteractionPassed: false,
  defaultInteractionReason: 'raw-actions-did-not-advance-phase',
  defaultInteractionPhaseBefore: 'upgradeOurBase',
  defaultInteractionPhaseAfter: 'upgradeOurBase',
  defaultInteractionCompletedBefore: 2,
  defaultInteractionCompletedAfter: 2,
}));
assert.strictEqual(defaultInteractionSummary.passed, false, '[4.1] raw preview interaction failure should block contract pass');
assert.ok(
  defaultInteractionSummary.escalationReasons.indexOf('default-interaction-failed') >= 0,
  '[4.2] default interaction failure should explain escalation'
);
assert.strictEqual(
  defaultInteractionSummary.defaultInteractionReason,
  'raw-actions-did-not-advance-phase',
  '[4.3] default interaction failure reason should be preserved'
);

var storyboardVideoResult = baseResult({
  passed: false,
  exitReason: 'storyboard_video_audit_failed',
});
storyboardVideoResult.report.storyboardVideoAudit = {
  passed: false,
  skipped: false,
  reason: 'label contradicts visible direction',
  recording: { path: '/tmp/storyboard-video-audit.mp4' },
  volcengineVideoAudit: {
    passed: false,
    summary: 'label drift detected',
    issues: [{ rule: 'direction-mismatch' }],
  },
};
var storyboardVideoSummary = runtimeContract.summarizeRuntimeContractResult(storyboardVideoResult);
assert.strictEqual(storyboardVideoSummary.passed, false, '[5.1] storyboard video audit failure should block contract pass');
assert.ok(
  storyboardVideoSummary.escalationReasons.indexOf('storyboard-video-audit-failed') >= 0,
  '[5.2] storyboard video audit failure should explain escalation'
);
assert.strictEqual(
  storyboardVideoSummary.storyboardVideoAudit.reason,
  'label contradicts visible direction',
  '[5.3] storyboard video audit reason should be preserved'
);
assert.strictEqual(
  storyboardVideoSummary.storyboardVideoAudit.recording,
  '/tmp/storyboard-video-audit.mp4',
  '[5.4] storyboard video audit recording path should be preserved'
);
assert.strictEqual(
  storyboardVideoSummary.storyboardVideoAudit.volcengineVideoAudit.issueCount,
  1,
  '[5.5] nested video model issue count should be summarized'
);

var missingManualSummary = runtimeContract.summarizeRuntimeContractResult(baseResult({
  manualJoystickProbeRequired: true,
}));
assert.strictEqual(missingManualSummary.passed, false, '[6.1] required manual joystick probe must block contract pass when missing');
assert.ok(
  missingManualSummary.escalationReasons.indexOf('manual-joystick-probe-missing') >= 0,
  '[6.2] missing required manual joystick probe should explain escalation'
);

var skippedManualSummary = runtimeContract.summarizeRuntimeContractResult(baseResult({
  manualJoystickProbeRequired: true,
  manualJoystickProbe: {
    passed: true,
    skipped: true,
    reason: 'skipped by env',
  },
}));
assert.strictEqual(skippedManualSummary.passed, false, '[6.3] skipped required manual joystick probe must not pass contract');
assert.ok(
  skippedManualSummary.escalationReasons.indexOf('manual-joystick-probe-missing') >= 0,
  '[6.4] skipped required manual joystick probe should be reported as missing evidence'
);
assert.strictEqual(skippedManualSummary.manualJoystickProbeRequired, true, '[6.5] manual joystick requirement should be preserved');

var missingManualFlowSummary = runtimeContract.summarizeRuntimeContractResult(baseResult({
  manualJoystickProbeRequired: true,
  manualJoystickProbe: {
    passed: true,
    skipped: false,
    reason: 'manual joystick probe passed',
  },
}));
assert.strictEqual(missingManualFlowSummary.passed, false, '[6.6] required manual joystick flow probe must block contract pass when missing');
assert.ok(
  missingManualFlowSummary.escalationReasons.indexOf('manual-joystick-flow-probe-missing') >= 0,
  '[6.7] missing required manual joystick flow probe should explain escalation'
);

var failedManualFlowSummary = runtimeContract.summarizeRuntimeContractResult(baseResult({
  manualJoystickProbeRequired: true,
  manualJoystickFlowProbeRequired: true,
  manualJoystickProbe: {
    passed: true,
    skipped: false,
    reason: 'manual joystick probe passed',
  },
  manualJoystickFlowProbe: {
    passed: false,
    skipped: false,
    reason: 'manual joystick flow incomplete: completed 2/4',
    completedAfter: 2,
    targetCompleted: 4,
    phasePath: ['phase1', 'phase2'],
    missingPhasePath: ['phase3', 'phase4'],
    phasePathSource: 'samples',
    driver: 'autonav-joystick',
    dragCount: 3,
  },
  telemetry: {
    schemaVersion: 'blueprint-cua-telemetry.v1',
    taskId: 'runtime-contract-test',
    observeMs: 100,
    manualProbeMs: 25,
    manualFlowMs: 75,
    totalMs: 220,
  },
}));
assert.strictEqual(failedManualFlowSummary.passed, false, '[6.8] failed manual joystick flow probe must block contract pass');
assert.ok(
  failedManualFlowSummary.escalationReasons.indexOf('manual-joystick-flow-probe-failed') >= 0,
  '[6.9] failed manual joystick flow probe should explain escalation'
);
assert.strictEqual(failedManualFlowSummary.manualJoystickFlowProbe.completedAfter, 2, '[6.10] flow completion count should be preserved');
assert.deepStrictEqual(failedManualFlowSummary.manualJoystickFlowProbe.missingPhasePath, ['phase3', 'phase4'], '[6.11] missing phase path should be preserved');
assert.strictEqual(failedManualFlowSummary.manualJoystickFlowProbe.phasePathSource, 'samples', '[6.12] phase path source should be preserved');
assert.strictEqual(failedManualFlowSummary.manualJoystickFlowProbe.driver, 'autonav-joystick', '[6.13] flow driver should be preserved');
assert.strictEqual(failedManualFlowSummary.telemetry.manualFlowMs, 75, '[6.14] CUA telemetry should be preserved');

assert.deepStrictEqual(
  runtimeContract.getInteractivePhaseIds({
    specs: [
      { phaseId: 'intro', requiredInteractions: ['wait:1'], playerMustAct: false, autoAllowed: true },
      { phaseId: 'upgrade', requiredInteractions: ['click:Base'], playerMustAct: true, autoAllowed: false },
    ],
  }),
  ['upgrade'],
  '[7.1] default interaction probe should target real player phases only'
);

console.log('runtime-contract-module-gate tests passed');
