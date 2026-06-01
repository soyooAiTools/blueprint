'use strict';

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function keyOf(value) {
  return value && (value.id || value.name || value.slot || value.entity);
}

function mapBy(values, fn) {
  var out = {};
  safeArray(values).forEach(function(value) {
    var key = fn(value);
    if (key) out[key] = value;
  });
  return out;
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function pushDiff(out, path, source, target, category, severity) {
  if (!sameJson(source, target)) {
    out.push({
      path: path,
      source: source === undefined ? null : source,
      target: target === undefined ? null : target,
      category: category || 'value-divergence',
      severity: severity || 'blocking'
    });
  }
}

function simplifyMaterial(material) {
  if (!material) return null;
  return {
    id: material.id || null,
    guid: material.guid || null,
    shader: material.shader || null,
    colors: material.colors || null
  };
}

function simplifyPrimitive(primitive) {
  return {
    id: primitive.id || primitive.name || null,
    name: primitive.name || primitive.id || null,
    mesh: primitive.mesh || null,
    transform: primitive.transform || null,
    bounds: primitive.bounds || null,
    material: simplifyMaterial(primitive.material)
  };
}

function simplifyEntity(entity) {
  var primitives = safeArray(entity && entity.primitives).map(simplifyPrimitive);
  return {
    id: entity && (entity.id || entity.name) || null,
    name: entity && (entity.name || entity.id) || null,
    parentPath: entity && entity.parentPath || null,
    transform: entity && entity.transform || null,
    pivot: entity && entity.pivot || null,
    bounds: entity && entity.bounds || null,
    primitiveCount: primitives.length,
    primitives: primitives
  };
}

function hudKey(hud) {
  return hud && (hud.slot || hud.id || hud.entity);
}

function simplifyHud(hud) {
  return {
    id: hud && hud.id || null,
    slot: hud && hud.slot || null,
    role: hud && hud.role || null,
    entity: hud && hud.entity || null,
    text: hud && hud.text || null,
    anchor: hud && hud.anchor || null,
    style: hud && hud.style || null
  };
}

function phaseKey(phase) {
  return phase && (phase.id || phase.phase);
}

function simplifyPhase(phase) {
  return {
    id: phase && (phase.id || phase.phase) || null,
    showEntities: safeArray(phase && phase.showEntities).slice(),
    hideEntities: safeArray(phase && phase.hideEntities).slice(),
    trigger: phase && phase.trigger || null,
    interactionGate: phase && phase.interactionGate || null,
    autoPlayGate: phase && phase.autoPlayGate || null,
    manualGate: phase && phase.manualGate || null
  };
}

function summarizeContract(contract, phaseId) {
  contract = contract || {};
  var phase = phaseId
    ? safeArray(contract.phases).filter(function(item) { return item && item.id === phaseId; })[0] || null
    : safeArray(contract.phases)[0] || null;
  var visibleSet = {};
  safeArray(phase && phase.showEntities).forEach(function(id) { if (id) visibleSet[id] = true; });
  var visibleEntities = safeArray(contract.entities).filter(function(entity) {
    var id = entity && (entity.id || entity.name);
    return !phase || !safeArray(phase.showEntities).length || !!visibleSet[id];
  }).map(simplifyEntity);
  return {
    phase: phase && phase.id || phaseId || null,
    phaseContract: simplifyPhase(phase),
    hudSlots: safeArray(contract.hud).map(simplifyHud),
    entitiesVisible: visibleEntities.map(function(entity) { return entity.id; }).filter(Boolean),
    compositionRoots: mapBy(visibleEntities, keyOf)
  };
}

function compareEntity(sourceEntity, targetEntity, pathBase, diffs) {
  if (!targetEntity) {
    diffs.push({
      path: pathBase,
      source: sourceEntity,
      target: null,
      category: 'missing-entity',
      severity: 'blocking'
    });
    return;
  }
  pushDiff(diffs, pathBase + '.name', sourceEntity.name, targetEntity.name, 'naming-divergence');
  pushDiff(diffs, pathBase + '.primitiveCount', sourceEntity.primitiveCount, targetEntity.primitiveCount, 'composition-divergence');
  pushDiff(diffs, pathBase + '.transform', sourceEntity.transform, targetEntity.transform, 'transform-divergence');
  pushDiff(diffs, pathBase + '.bounds', sourceEntity.bounds, targetEntity.bounds, 'bounds-divergence');
  var targetPrimitives = mapBy(targetEntity.primitives, keyOf);
  safeArray(sourceEntity.primitives).forEach(function(sourcePrimitive) {
    var primitiveId = keyOf(sourcePrimitive);
    var targetPrimitive = targetPrimitives[primitiveId];
    var primitivePath = pathBase + '.primitives.' + primitiveId;
    if (!targetPrimitive) {
      diffs.push({
        path: primitivePath,
        source: sourcePrimitive,
        target: null,
        category: 'missing-primitive',
        severity: 'blocking'
      });
      return;
    }
    pushDiff(diffs, primitivePath + '.mesh', sourcePrimitive.mesh, targetPrimitive.mesh, 'mesh-divergence');
    pushDiff(diffs, primitivePath + '.transform', sourcePrimitive.transform, targetPrimitive.transform, 'transform-divergence');
    pushDiff(diffs, primitivePath + '.bounds', sourcePrimitive.bounds, targetPrimitive.bounds, 'bounds-divergence');
    pushDiff(diffs, primitivePath + '.material', sourcePrimitive.material, targetPrimitive.material, 'material-divergence');
  });
}

function compareVisualSummaries(source, target) {
  var diffs = [];
  pushDiff(diffs, 'phaseContract', source.phaseContract, target.phaseContract, 'phase-divergence');
  pushDiff(diffs, 'entitiesVisible', source.entitiesVisible, target.entitiesVisible, 'phase-visibility-divergence');
  var targetHud = mapBy(target.hudSlots, hudKey);
  safeArray(source.hudSlots).forEach(function(sourceHud) {
    var key = hudKey(sourceHud);
    var targetEntry = targetHud[key];
    if (!targetEntry) {
      diffs.push({ path: 'hudSlots.' + key, source: sourceHud, target: null, category: 'missing-hud', severity: 'blocking' });
      return;
    }
    pushDiff(diffs, 'hudSlots.' + key + '.text', sourceHud.text, targetEntry.text, 'text-divergence');
    pushDiff(diffs, 'hudSlots.' + key + '.anchor', sourceHud.anchor, targetEntry.anchor, 'layout-divergence');
    pushDiff(diffs, 'hudSlots.' + key + '.style', sourceHud.style, targetEntry.style, 'style-divergence');
  });
  var targetEntities = target.compositionRoots || {};
  Object.keys(source.compositionRoots || {}).sort().forEach(function(id) {
    compareEntity(source.compositionRoots[id], targetEntities[id], 'compositionRoots.' + id, diffs);
  });
  return diffs;
}

function buildVisualShiftLeftDiff(sourceContract, targetContractOrSummary, options) {
  options = options || {};
  var phaseId = options.phase || options.phaseId || null;
  var sourceSummary = summarizeContract(sourceContract, phaseId);
  var targetSummary = targetContractOrSummary && targetContractOrSummary.kind === 'blueprint.visualShiftLeft.summary'
    ? targetContractOrSummary.summary
    : summarizeContract(targetContractOrSummary, phaseId);
  var diffs = compareVisualSummaries(sourceSummary, targetSummary);
  return {
    schemaVersion: '1.0.0',
    kind: 'blueprint.visualShiftLeft.diff',
    phase: sourceSummary.phase || targetSummary.phase || phaseId,
    source: sourceSummary,
    target: targetSummary,
    diffs: diffs,
    summary: {
      passed: diffs.length === 0,
      diffCount: diffs.length,
      blockingDiffCount: diffs.filter(function(diff) { return diff.severity !== 'advisory'; }).length
    }
  };
}

module.exports = {
  summarizeContract: summarizeContract,
  buildVisualShiftLeftDiff: buildVisualShiftLeftDiff,
  _internals: {
    compareVisualSummaries: compareVisualSummaries,
    simplifyEntity: simplifyEntity,
    simplifyHud: simplifyHud,
    simplifyPhase: simplifyPhase
  }
};
