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

assert.deepStrictEqual(
  runtimeContract.getInteractivePhaseIds({
    specs: [
      { phaseId: 'intro', requiredInteractions: ['wait:1'], playerMustAct: false, autoAllowed: true },
      { phaseId: 'upgrade', requiredInteractions: ['click:Base'], playerMustAct: true, autoAllowed: false },
    ],
  }),
  ['upgrade'],
  '[5.1] default interaction probe should target real player phases only'
);

console.log('runtime-contract-module-gate tests passed');
