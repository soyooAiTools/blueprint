'use strict';

var assert = require('assert');
var snapshotSchema = require('../contracts/snapshot-schema.v1.json');
var probeContracts = require('../engine/cua-probe-contracts.cjs');

probeContracts.loadProbeContracts();

assert.strictEqual(snapshotSchema.schemaVersion, '1.0.0');
assert.strictEqual(snapshotSchema.kind, 'blueprint.phaseEvidence.snapshotSchema');
assert.strictEqual(snapshotSchema.visibilityPredicate.id, 'viewport_aabb_alpha_v1');
assert.strictEqual(snapshotSchema.visibilityPredicate.alphaThreshold, 0.1);
assert.strictEqual(snapshotSchema.browserStateContract.globalName, 'window.__gameState');
assert.deepStrictEqual(snapshotSchema.browserStateContract.requiredTopLevelKeys, [
  'phase',
  'phaseRealTimer',
  'entity_states',
  'phaseEvidence',
]);
assert.strictEqual(snapshotSchema.runtimeSnapshotEnvelope.requiredMeta['_meta.schemaVersion'], '1.0.0');
assert.deepStrictEqual(snapshotSchema.runtimeSnapshotEnvelope.requiredMeta['_meta.sourcePlatform'], ['unity', 'html']);
assert.strictEqual(snapshotSchema.runtimeSnapshotEnvelope.modulePathTemplate, 'phaseEvidence.{phaseId}.{moduleId}');
assert.strictEqual(snapshotSchema.project, null);

var contract = probeContracts.loadProbeContracts();
var moduleIds = Object.keys(contract.moduleProbeContracts).sort();
assert.deepStrictEqual(Object.keys(snapshotSchema.moduleVocabulary).sort(), moduleIds);

var inventory = snapshotSchema.moduleVocabulary.inventory_wallet;
assert.ok(inventory);
assert.strictEqual(inventory.snapshotObjectPath, 'phaseEvidence.{phaseId}.inventory_wallet');
assert.strictEqual(inventory.metaPath, 'phaseEvidence.{phaseId}.inventory_wallet._meta');
assert.ok(inventory.phaseSignalPaths.indexOf('phaseEvidence.{phaseId}.resource_incremented') >= 0);
assert.ok(inventory.evidenceFields.some(function(field) {
  return field.contractPath === 'phaseEvidence.inventory_wallet.operation' &&
    field.runtimePath === 'phaseEvidence.{phaseId}.inventory_wallet.operation' &&
    field.moduleSnapshotKey === 'operation' &&
    field.required === true;
}));

var cta = snapshotSchema.moduleVocabulary.cta_finish;
assert.ok(cta.evidenceFields.some(function(field) {
  return field.runtimePath.indexOf('phaseEvidence.{phaseId}.cta_finish.') === 0;
}));
