'use strict';

const fidelity = require('../../engine/fidelity-contract.cjs');

const HTML_WRITER_CAPABILITIES = [
  'geometry.primitiveHierarchy.v1',
  'geometry.localTransform.v1',
  'geometry.pivotBounds.v1',
  'material.fullSurface.v1',
  'material.precomputedGuid.v1',
  'phase.behaviorGate.v1',
  'ui.labelAnchor.v1',
  'rendererAdapter.driverMap.v1',
  'provenance.fieldLevel.v1',
];

const UNITY_WRITER_CAPABILITIES = HTML_WRITER_CAPABILITIES.concat([
  'runtime.noFixtureBridgeConstants.v1',
]);

function supportedCapabilitiesFor(target) {
  if (target === 'unity') return UNITY_WRITER_CAPABILITIES.slice();
  if (target === 'html') return HTML_WRITER_CAPABILITIES.slice();
  return [];
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function sourceEntityLabel(sourceEntityContract, entityName) {
  if (!entityName) return '';
  const styles = sourceEntityContract && sourceEntityContract.entityStyles || {};
  const composites = sourceEntityContract && sourceEntityContract.entityComposites || {};
  return styles[entityName] && styles[entityName].label
    || composites[entityName] && composites[entityName].label
    || entityName;
}

function phaseHudTextsFromSource(source) {
  const sourcePhaseContract = source && source.sourcePhaseContract || {};
  const sourceEntityContract = source && source.sourceEntityContract || {};
  const phases = safeArray(sourcePhaseContract.phases);
  const phaseCount = Number(sourcePhaseContract.phaseCount || phases.length) || phases.length;
  const perPhase = {
    phase: {},
    targethint: {},
    tip: {},
  };
  phases.forEach((phase, index) => {
    const phaseId = String(phase && phase.id || ('phase' + (index + 1)));
    const hudText = phase && phase.hudText || {};
    const phaseText = hudText.phase || ('Phase ' + (index + 1) + '/' + phaseCount);
    if (phaseText) perPhase.phase[phaseId] = phaseText;

    const firstTargetStep = safeArray(phase && phase.steps).find(step => step && step.target);
    const targetEntity = hudText.targetEntity || firstTargetStep && firstTargetStep.target || '';
    const targetLabel = hudText.targetLabel || sourceEntityLabel(sourceEntityContract, targetEntity);
    const targetHintText = hudText.targethint || (targetLabel ? '目标：' + targetLabel : '');
    if (targetHintText) perPhase.targethint[phaseId] = targetHintText;

    const tipText = hudText.tip || phase && phase.guideText || '';
    if (tipText) perPhase.tip[phaseId] = tipText;
  });
  return perPhase;
}

function findHudEntry(hud, slot) {
  const ids = ['hud.' + slot, slot];
  return safeArray(hud).find(entry => entry && ids.indexOf(entry.id) >= 0)
    || safeArray(hud).find(entry => entry && String(entry.slot || '').toLowerCase() === slot);
}

function applySourceHudPerPhase(contract, source, options) {
  options = options || {};
  const out = clone(contract);
  const perPhase = phaseHudTextsFromSource(source || {});
  const updated = [];
  ['phase', 'targethint', 'tip'].forEach(slot => {
    const entry = findHudEntry(out.hud, slot);
    const slotText = perPhase[slot] || {};
    if (!entry || Object.keys(slotText).length === 0) return;
    entry.text = { perPhase: slotText };
    entry.provenance = Object.assign({}, entry.provenance || {}, {
      source: 'html',
      propertyPath: 'sourcePhaseContract.phases[].hudText.' + slot,
      confidence: 1,
    });
    updated.push({ id: entry.id, slot, phaseCount: Object.keys(slotText).length });
  });
  return options.includeSummary ? { contract: out, summary: { updated, perPhase } } : out;
}

function applySourceUiOverlayContract(contract, source, options) {
  options = options || {};
  const out = clone(contract);
  const sourceEntityContract = source && source.sourceEntityContract || {};
  const uiOverlayContract = sourceEntityContract.uiOverlayContract || { present: false, entities: [] };
  out.sourceEntityContract = Object.assign({}, out.sourceEntityContract || {}, {
    uiOverlayContract: clone(uiOverlayContract),
  });
  const entities = safeArray(uiOverlayContract.entities).map(item => ({
    id: typeof item === 'string' ? item : item && item.id || item && item.name || '',
    role: typeof item === 'string' ? 'ui-overlay' : item && item.role || 'ui-overlay',
  })).filter(item => item.id);
  const summary = {
    present: !!uiOverlayContract.present,
    entityCount: entities.length,
    entities,
  };
  return options.includeSummary ? { contract: out, summary } : out;
}

function assertFidelityWriterReady(contract, options) {
  options = options || {};
  const target = options.target || 'unity';
  return fidelity.assertWriterReady(contract, {
    target,
    allowMissingUnityCoverage: !!options.allowMissingUnityCoverage,
    supportedCapabilities: options.supportedCapabilities || supportedCapabilitiesFor(target),
  });
}

function buildFidelityRoundTripSummary(sourceContract, readbackContract) {
  const diff = fidelity.diffFidelityRoundTrip(sourceContract, readbackContract);
  return {
    schemaVersion: fidelity.SCHEMA_VERSION,
    kind: 'blueprint.fidelityContract.roundTripSummary',
    passed: diff.passed,
    diffCount: diff.diffs.length,
    diffs: diff.diffs,
  };
}

module.exports = {
  HTML_WRITER_CAPABILITIES,
  UNITY_WRITER_CAPABILITIES,
  supportedCapabilitiesFor,
  phaseHudTextsFromSource,
  applySourceHudPerPhase,
  applySourceUiOverlayContract,
  assertFidelityWriterReady,
  buildFidelityRoundTripSummary,
};
