'use strict';

var assert = require('assert');
var fs = require('fs');
var probeContracts = require('../engine/cua-probe-contracts.cjs');
var fixtureBatch = require('./cua-probe-fixtures.cjs');
var probeFixtureHarness = require('./cua-probe-fixture-harness.cjs');
var snapshotFixtureBatch = require('./cua-probe-snapshot-fixtures.cjs');

function fixture() {
  return {
    schemaVersion: '1.0.0',
    contractVersion: '1.0.0',
    moduleProbeContracts: {
      spawn_interval: {
        moduleId: 'spawn_interval',
        completenessChecks: {
          schema: { status: 'present', source: 'registry.spawn_interval.schema', blocking: true },
          emitter: { status: 'present', source: 'assembly-emitter.spawn_interval', blocking: true },
          runtimeEvidence: { status: 'missing', source: 'phaseEvidence.spawn_interval', blocking: true },
          staticCheck: { status: 'missing', source: 'static-check.spawn_interval', blocking: false },
          cuaProbe: { status: 'missing', source: 'cua-probe.spawn_interval', blocking: true },
        },
        expectedSignals: ['downstream_entity_visible'],
        evidenceFields: [
          { path: 'phaseEvidence.spawn_interval.spawnedEntities', required: true, shape: 'array' },
        ],
        passRule: {
          type: 'all-of',
          clauses: [
            { op: 'flag_set', path: 'phaseEvidence.downstream_entity_visible' },
            { op: 'array_length_gte', path: 'phaseEvidence.spawn_interval.spawnedEntities', value: 1 },
          ],
        },
        antiAutoplay: {
          type: 'all-of',
          clauses: [
            { op: 'realtime_elapsed_gte', path: 'phaseRealTimer', value: 0.5, scope: 'phase' },
          ],
        },
        failureAttribution: [
          {
            priority: 20,
            id: 'spawn_interval.fallback_emitter',
            condition: { op: 'field_present', path: 'phaseEvidence.spawn_interval.spawnedEntities', value: false },
            ledgerSource: 'implementation_coverage',
            ledgerGapType: 'missing_emitter',
          },
          {
            priority: 10,
            id: 'spawn_interval.flag_only_no_spawn',
            condition: {
              type: 'all-of',
              clauses: [
                { op: 'flag_set', path: 'phaseEvidence.downstream_entity_visible' },
                { op: 'field_lt', path: 'phaseEvidence.spawn_interval.spawnedEntities.length', value: 1 },
              ],
            },
            ledgerSource: 'cua_repair',
            ledgerGapType: 'missing_semantic_assertion',
            ledgerSubtype: 'silent_pass_flag_only',
          },
        ],
        metricFields: [
          { recordPath: 'phaseEvidence.spawn_interval.spawnCount', source: 'phaseEvidence.spawn_interval.spawnedEntities', aggregate: 'count' },
        ],
      },
      guide_text: {
        moduleId: 'guide_text',
        completenessChecks: {
          schema: { status: 'present', source: 'registry.guide_text.schema', blocking: true },
          emitter: { status: 'present', source: 'assembly-emitter.guide_text', blocking: true },
          runtimeEvidence: { status: 'present', source: 'phaseEvidence.guide_text', blocking: true },
          staticCheck: { status: 'missing', source: 'static-check.guide_text', blocking: false },
          cuaProbe: { status: 'present', source: 'cua-probe.guide_text', blocking: true },
        },
        expectedSignals: ['guide_text_visible'],
        evidenceFields: [
          { path: 'ui_state.guide_text.visible', required: true, shape: 'bool' },
        ],
        passRule: { op: 'flag_set', path: 'phaseEvidence.guide_text_visible' },
        antiAutoplay: { op: 'realtime_elapsed_gte', path: 'phaseRealTimer', value: 0.2 },
        failureAttribution: [
          {
            priority: 10,
            id: 'guide_text.flag_only',
            condition: { op: 'flag_set', path: 'phaseEvidence.guide_text_visible' },
            ledgerSource: 'cua_repair',
            ledgerGapType: 'missing_semantic_assertion',
          },
        ],
        metricFields: [],
      },
    },
    gapAttributionSubtypes: {
      silent_pass_flag_only: {
        subtype: 'silent_pass_flag_only',
        priority: 20,
        parentGapType: 'missing_semantic_assertion',
        matchInputs: [{ path: 'phaseEvidence.<anyFlag>', from: 'phaseEvidence' }],
        requiredEvidence: {
          type: 'all-of',
          clauses: [
            { op: 'flag_set', path: 'phaseEvidence.<anyFlag>' },
            { type: 'not', clauses: [{ op: 'field_present', path: 'entity_states.<target>' }] },
          ],
        },
        ledgerSubtype: 'silent_pass_flag_only',
        dashboardLabel: 'Flag-only pass',
      },
    },
  };
}

var doc = fixture();
assert.strictEqual(probeContracts.validateProbeContracts(doc), true);

var summary = probeContracts.summarizeProbeContracts(doc);
assert.strictEqual(summary.moduleCount, 2);
assert.strictEqual(summary.completeCount, 1);
assert.strictEqual(summary.incompleteCount, 1);
assert.strictEqual(summary.blockingMissingTotal, 2);
assert.strictEqual(summary.warningTotal, 2);
assert.strictEqual(summary.modules.spawn_interval.completeness, 0);
assert.strictEqual(summary.modules.guide_text.completeness, 1);
assert.deepStrictEqual(summary.modules.spawn_interval.blockingMissing.map(function(item) { return item.pillar; }), ['runtimeEvidence', 'cuaProbe']);

var ordered = probeContracts.orderedFailureAttribution(doc.moduleProbeContracts.spawn_interval);
assert.deepStrictEqual(ordered.map(function(entry) { return entry.id; }), [
  'spawn_interval.flag_only_no_spawn',
  'spawn_interval.fallback_emitter',
]);

var bad = fixture();
bad.moduleProbeContracts.spawn_interval.passRule.clauses[0].op = 'mystery_op';
assert.throws(function() {
  probeContracts.validateProbeContracts(bad);
}, /unknown op: mystery_op/);

var badVersion = fixture();
badVersion.schemaVersion = '2.0.0';
assert.throws(function() {
  probeContracts.loadProbeContracts(badVersion);
}, /Unsupported CUA probe schemaVersion/);

var miniRegistry = {
  version: 'runtime-modules-test',
  items: [
    { id: 'spawn_interval', level: 'L1', observableFeedback: ['downstream_entity_visible'], ownerFiles: ['Flow.cs'] },
    { id: 'build_progress', level: 'L1', observableFeedback: ['entity_state_equals_built'], ownerFiles: ['Flow.cs'] },
    { id: 'guide_text', level: 'L2', observableFeedback: ['guide_text_visible'], ownerFiles: ['UI.cs'] },
  ],
};
var registryCoverage = probeContracts.summarizeContractRegistryCoverage(doc, miniRegistry);
assert.strictEqual(registryCoverage.registryVersion, 'runtime-modules-test');
assert.strictEqual(registryCoverage.runtimeL1ModuleCount, 2);
assert.strictEqual(registryCoverage.contractModuleCount, 2);
assert.strictEqual(registryCoverage.coveredModuleCount, 1);
assert.strictEqual(registryCoverage.missingModuleCount, 1);
assert.strictEqual(registryCoverage.contractOnlyModuleCount, 1);
assert.strictEqual(registryCoverage.coverage, 0.5);
assert.deepStrictEqual(registryCoverage.coveredModuleIds, ['spawn_interval']);
assert.deepStrictEqual(registryCoverage.missingModuleIds, ['build_progress']);
assert.deepStrictEqual(registryCoverage.contractOnlyModuleIds, ['guide_text']);
assert.strictEqual(registryCoverage.modules.spawn_interval.hasProbeContract, true);
assert.strictEqual(registryCoverage.modules.build_progress.hasProbeContract, false);

var timContractPath = process.env.CUA_PROBE_CONTRACT_FILE || probeContracts.DEFAULT_CONTRACT_PATH;
if (fs.existsSync(timContractPath)) {
  var realContract = probeContracts.loadProbeContracts(timContractPath);
  assert.deepStrictEqual(probeContracts.loadProbeContracts(), realContract, 'default contract path should load the canonical v1 contract');
  var batchResult = probeFixtureHarness.assertProbeFixtureBatch(probeContracts, realContract, fixtureBatch);
  assert.strictEqual(batchResult.moduleFixtures.length, 72);
  assert.strictEqual(batchResult.subtypeFixtures.length, 6);

  var runtimeRegistryPath = __dirname + '/../adapters/schema/assembly-registry-v1/runtime-modules.v1.json';
  var realRegistryCoverage = probeContracts.summarizeContractRegistryCoverage(realContract, runtimeRegistryPath);
  assert.strictEqual(realRegistryCoverage.runtimeL1ModuleCount, 36);
  assert.strictEqual(realRegistryCoverage.contractModuleCount, 36);
  assert.strictEqual(realRegistryCoverage.coveredModuleCount, 36);
  assert.strictEqual(realRegistryCoverage.missingModuleCount, 0);
  assert.strictEqual(realRegistryCoverage.contractOnlyModuleCount, 0);
  assert.strictEqual(realRegistryCoverage.completeCoveredModuleCount, 0);
  assert.deepStrictEqual(realRegistryCoverage.coveredModuleIds, [
    'activate_targets',
    'apply_damage',
    'build_progress',
    'camera_focus',
    'camera_lift',
    'camera_zoom',
    'click_trigger',
    'collect_on_near',
    'cooldown',
    'cost_gate',
    'cta_finish',
    'damageable',
    'deliver_to_target',
    'drag_trigger',
    'floating_text_feedback',
    'form_switch',
    'guide_ui',
    'highlight_target',
    'hold_trigger',
    'inventory_wallet',
    'move_to_target',
    'on_death_drop',
    'phase_gate_timer',
    'player_input_joystick',
    'player_input_tap',
    'pop_animation',
    'projectile_emit',
    'proximity_trigger',
    'score_feedback',
    'spawn_interval',
    'spawn_once',
    'target_acquire',
    'upgrade_progress',
    'visual_binding',
    'visual_variant_swap',
    'world_label',
  ]);
  assert.strictEqual(realRegistryCoverage.missingModuleIds.indexOf('visual_binding'), -1);
  assert.strictEqual(realRegistryCoverage.missingModuleIds.indexOf('on_death_drop'), -1);
  assert.strictEqual(realRegistryCoverage.missingModuleIds.indexOf('apply_damage'), -1);
  assert.strictEqual(realRegistryCoverage.missingModuleIds.indexOf('drag_trigger'), -1);
  assert.strictEqual(realRegistryCoverage.missingModuleIds.indexOf('hold_trigger'), -1);
  assert.strictEqual(realRegistryCoverage.missingModuleIds.indexOf('floating_text_feedback'), -1);
  assert.strictEqual(realRegistryCoverage.missingModuleIds.indexOf('world_label'), -1);
  assert.strictEqual(realRegistryCoverage.missingModuleIds.indexOf('pop_animation'), -1);
  assert.strictEqual(realRegistryCoverage.missingModuleIds.indexOf('highlight_target'), -1);
  assert.strictEqual(realRegistryCoverage.missingModuleIds.indexOf('guide_ui'), -1);
  assert.strictEqual(realRegistryCoverage.missingModuleIds.indexOf('camera_focus'), -1);
  assert.strictEqual(realRegistryCoverage.missingModuleIds.indexOf('camera_lift'), -1);
  assert.strictEqual(realRegistryCoverage.missingModuleIds.indexOf('camera_zoom'), -1);
  assert.strictEqual(realRegistryCoverage.missingModuleIds.indexOf('phase_gate_timer'), -1);
  assert.strictEqual(realRegistryCoverage.missingModuleIds.indexOf('activate_targets'), -1);
  assert.strictEqual(realRegistryCoverage.missingModuleIds.indexOf('score_feedback'), -1);
  assert.strictEqual(realRegistryCoverage.missingModuleIds.indexOf('visual_variant_swap'), -1);
  assert.strictEqual(realRegistryCoverage.missingModuleIds.indexOf('form_switch'), -1);
  assert.strictEqual(realRegistryCoverage.missingModuleIds.indexOf('click_trigger'), -1);
  assert.strictEqual(realRegistryCoverage.missingModuleIds.indexOf('player_input_tap'), -1);
  assert.strictEqual(realRegistryCoverage.missingModuleIds.indexOf('move_to_target'), -1);
  assert.strictEqual(realRegistryCoverage.missingModuleIds.indexOf('player_input_joystick'), -1);
  assert.strictEqual(realRegistryCoverage.missingModuleIds.indexOf('projectile_emit'), -1);
  assert.strictEqual(realRegistryCoverage.missingModuleIds.indexOf('target_acquire'), -1);
  assert.strictEqual(realRegistryCoverage.missingModuleIds.indexOf('cooldown'), -1);
  assert.strictEqual(realRegistryCoverage.missingModuleIds.indexOf('cta_finish'), -1);
  assert.deepStrictEqual(realRegistryCoverage.missingModuleIds, []);

  assert.strictEqual(snapshotFixtureBatch.fixtures.length, 9);
  snapshotFixtureBatch.fixtures.forEach(function(fixtureItem) {
    var moduleContract = realContract.moduleProbeContracts[fixtureItem.moduleId];
    assert.ok(moduleContract, 'missing module contract for ' + fixtureItem.moduleId);
    var snapshot = probeContracts.readSnapshotForModule(
      fixtureItem.multiPhaseObservation,
      fixtureItem.phaseId,
      fixtureItem.moduleId
    );
    var coverage = probeContracts.classifySnapshotCoverage(moduleContract, snapshot);
    assert.strictEqual(coverage.outcome, fixtureItem.expect.coverageOutcome, fixtureItem.id + ' coverage');

    var probeResult = probeContracts.evaluateModuleProbe(moduleContract, fixtureItem.observation);
    assert.strictEqual(probeResult.passRuleHeld, fixtureItem.expect.passRuleHeld, fixtureItem.id + ' passRule');
    var actualAttributionId = probeResult.attribution && probeResult.attribution.attributionRuleId;
    assert.strictEqual(actualAttributionId || null, fixtureItem.expect.attributionId, fixtureItem.id + ' attribution');

    var summaryForFixture = probeContracts.summarizePhaseEvidenceSnapshotCoverage(
      realContract,
      fixtureItem.multiPhaseObservation,
      { phaseIds: [fixtureItem.phaseId] }
    );
    assert.strictEqual(summaryForFixture.totalModulePhasePairs, 36, fixtureItem.id + ' total pairs');
    assert.ok(
      summaryForFixture.byPhase[fixtureItem.phaseId][fixtureItem.expect.coverageOutcome].indexOf(fixtureItem.moduleId) >= 0,
      fixtureItem.id + ' byPhase classification'
    );
  });
}
