'use strict';

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function sourceEntitySet(assetManifest) {
  const names = safeArray(assetManifest && assetManifest.sourceEntityContract && assetManifest.sourceEntityContract.entities);
  const out = {};
  names.forEach(name => {
    if (name) out[name] = true;
  });
  return out;
}

function resourceAliases(resourceName) {
  const raw = String(resourceName || '').trim();
  if (!raw) return [];
  const lower = raw.toLowerCase();
  const aliases = [raw, lower];
  if (lower === 'gold' || lower === 'coin') aliases.push('Gold', 'gold', 'Coin', 'coin');
  if (lower === 'ice') aliases.push('Ice', 'ice');
  if (lower === 'scrap' || lower === 'metal') aliases.push('Scrap', 'scrap', 'Metal', 'metal');
  if (lower === 'oxygen') aliases.push('Oxygen', 'oxygen');
  return Array.from(new Set(aliases.filter(Boolean)));
}

function resourceMatches(a, b) {
  if (!a || !b) return false;
  const bSet = {};
  resourceAliases(b).forEach(alias => { bSet[String(alias).toLowerCase()] = true; });
  return resourceAliases(a).some(alias => bSet[String(alias).toLowerCase()]);
}

function buildSourceResourceTargetIndex(assetManifest) {
  const entityNames = sourceEntitySet(assetManifest);
  const phases = safeArray(assetManifest && assetManifest.sourcePhaseContract && assetManifest.sourcePhaseContract.phases);
  const out = {};

  function setTarget(resourceName, target) {
    if (!resourceName || !target || !entityNames[target]) return;
    resourceAliases(resourceName).forEach(alias => {
      if (!out[alias]) out[alias] = target;
    });
  }

  phases.forEach(phase => {
    safeArray(phase && phase.steps).forEach(step => {
      setTarget(step && step.gain, step && step.target);
    });
  });
  return out;
}

function sourceResourceTarget(assetManifest, resourceName) {
  const index = buildSourceResourceTargetIndex(assetManifest);
  const aliases = resourceAliases(resourceName);
  for (let i = 0; i < aliases.length; i++) {
    if (index[aliases[i]]) return index[aliases[i]];
  }
  return '';
}

module.exports = {
  safeArray,
  sourceEntitySet,
  resourceAliases,
  resourceMatches,
  buildSourceResourceTargetIndex,
  sourceResourceTarget,
};
