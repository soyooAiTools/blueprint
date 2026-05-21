'use strict';

function wrapMultiPhase(phaseId, singlePhaseObservation) {
  var phaseEvidence = singlePhaseObservation.phaseEvidence || {};
  var multiPhase = {};
  multiPhase[phaseId] = phaseEvidence;
  return Object.assign({}, singlePhaseObservation, { phaseEvidence: multiPhase });
}

function fx(moduleId, phaseId, observation, expect) {
  return {
    id: moduleId + '.' + expect.tag,
    moduleId: moduleId,
    phaseId: phaseId,
    observation: observation,
    multiPhaseObservation: wrapMultiPhase(phaseId, observation),
    expect: {
      coverageOutcome: expect.coverageOutcome,
      passRuleHeld: expect.passRuleHeld,
      attributionId: expect.attributionId,
    },
  };
}

var fixtures = [
  fx('inventory_wallet', 'phase_3_spend_gold', {
    phaseRealTimer: 1.2,
    phaseEvidence: {
      resource_decremented: true,
      score_text_changed: true,
      inventory_wallet: {
        _meta: {
          moduleId: 'inventory_wallet',
          phaseId: 'phase_3_spend_gold',
          sourceSignalIds: ['resource_decremented', 'score_text_changed'],
          schemaVersion: '1.0.0',
        },
        resource: 'gold',
        operation: 'spend',
        before: { balance: 12 },
        after: { balance: 8 },
        score_text_visible: true,
      },
    },
  }, { tag: 'pass', coverageOutcome: 'present_full', passRuleHeld: true, attributionId: null }),
  fx('inventory_wallet', 'phase_3_spend_gold', {
    phaseRealTimer: 1.0,
    phaseEvidence: {
      inventory_wallet: {
        _meta: {
          moduleId: 'inventory_wallet',
          phaseId: 'phase_3_spend_gold',
          sourceSignalIds: ['resource_decremented'],
          schemaVersion: '1.0.0',
        },
        resource: 'gold',
        before: { balance: 12 },
        score_text_visible: true,
      },
    },
  }, { tag: 'incomplete', coverageOutcome: 'incomplete', passRuleHeld: false, attributionId: null }),
  fx('inventory_wallet', 'phase_3_spend_gold', {
    phaseRealTimer: 0.5,
    phaseEvidence: {
      inventory_wallet: {
        _meta: {
          moduleId: 'inventory_wallet',
          phaseId: 'phase_3_spend_gold',
          sourceSignalIds: [],
          schemaVersion: '1.0.0',
        },
        resource: 'gold',
        operation: 'noop',
        before: { balance: 5 },
        after: { balance: 5 },
        score_text_visible: false,
      },
    },
  }, { tag: 'fail_passRule', coverageOutcome: 'present_full', passRuleHeld: false, attributionId: 'inventory_wallet.operation_noop' }),

  fx('score_feedback', 'phase_4_score_bump', {
    phaseRealTimer: 0.8,
    phaseEvidence: {
      score_text_changed: true,
      score_feedback: {
        _meta: {
          moduleId: 'score_feedback',
          phaseId: 'phase_4_score_bump',
          sourceSignalIds: ['score_text_changed'],
          schemaVersion: '1.0.0',
        },
        resource: 'gold',
        label: 'Coins:',
        before: { score: 100 },
        after: { score: 130 },
        delta: 30,
        text_changed: true,
      },
    },
  }, { tag: 'pass', coverageOutcome: 'present_full', passRuleHeld: true, attributionId: null }),
  fx('score_feedback', 'phase_4_score_bump', {
    phaseRealTimer: 0.8,
    phaseEvidence: {
      score_text_changed: true,
      score_feedback: {
        _meta: {
          moduleId: 'score_feedback',
          phaseId: 'phase_4_score_bump',
          sourceSignalIds: ['score_text_changed'],
          schemaVersion: '1.0.0',
        },
        resource: 'gold',
        before: { score: 100 },
        after: { score: 130 },
      },
    },
  }, { tag: 'incomplete', coverageOutcome: 'incomplete', passRuleHeld: false, attributionId: null }),
  fx('score_feedback', 'phase_4_score_bump', {
    phaseRealTimer: 0.8,
    phaseEvidence: {
      score_text_changed: true,
      score_feedback: {
        _meta: {
          moduleId: 'score_feedback',
          phaseId: 'phase_4_score_bump',
          sourceSignalIds: ['score_text_changed'],
          schemaVersion: '1.0.0',
        },
        resource: 'gold',
        label: 'Coins:',
        before: { score: 100 },
        after: { score: 100 },
        delta: 0,
        text_changed: true,
      },
    },
  }, { tag: 'fail_passRule', coverageOutcome: 'present_full', passRuleHeld: false, attributionId: 'score_feedback.flag_with_no_score_delta' }),

  fx('cta_finish', 'phase_final_install', {
    phaseRealTimer: 0.9,
    phaseEvidence: {
      downstream_entity_visible: true,
      cta_finish: {
        _meta: {
          moduleId: 'cta_finish',
          phaseId: 'phase_final_install',
          sourceSignalIds: ['downstream_entity_visible'],
          schemaVersion: '1.0.0',
        },
        target: 'CTAButton',
        cta_visible: true,
        install_called_or_ready: true,
        final_phase: true,
      },
    },
  }, { tag: 'pass', coverageOutcome: 'present_full', passRuleHeld: true, attributionId: null }),
  fx('cta_finish', 'phase_final_install', {
    phaseRealTimer: 0.9,
    phaseEvidence: {
      downstream_entity_visible: true,
      cta_finish: {
        _meta: {
          moduleId: 'cta_finish',
          phaseId: 'phase_final_install',
          sourceSignalIds: ['downstream_entity_visible'],
          schemaVersion: '1.0.0',
        },
        target: 'CTAButton',
        cta_visible: true,
      },
    },
  }, { tag: 'incomplete', coverageOutcome: 'incomplete', passRuleHeld: false, attributionId: null }),
  fx('cta_finish', 'phase_mid_show_cta', {
    phaseRealTimer: 0.9,
    phaseEvidence: {
      downstream_entity_visible: true,
      cta_finish: {
        _meta: {
          moduleId: 'cta_finish',
          phaseId: 'phase_mid_show_cta',
          sourceSignalIds: ['downstream_entity_visible'],
          schemaVersion: '1.0.0',
        },
        target: 'CTAButton',
        cta_visible: true,
        install_called_or_ready: true,
        final_phase: false,
      },
    },
  }, { tag: 'fail_passRule', coverageOutcome: 'present_full', passRuleHeld: false, attributionId: 'cta_finish.flag_on_non_final_phase' }),
];

module.exports = {
  fixtures: fixtures,
};
