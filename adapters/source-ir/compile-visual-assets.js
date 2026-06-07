'use strict';

var visualAssets = require('../demo2spec/visual-assets.js');
var {
  normalizeSourceSceneIr,
  projectSourceSceneIrToLegacy,
  validateSourceSceneIr,
} = require('../../engine/source-scene-ir.cjs');

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function clone(value) {
  return value == null ? null : JSON.parse(JSON.stringify(value));
}

function sourcePositionObject(entity) {
  var position = safeArray(entity && entity.position);
  return {
    x: Number(position[0]) || 0,
    y: Number(position[1]) || 0,
    z: Number(position[2]) || 0,
  };
}

function compileEntityStyles(ir) {
  var out = {};
  safeArray(ir.entities).forEach(function(entity) {
    out[entity.id] = {
      label: entity.label || entity.id,
      kind: entity.kind || null,
      color: entity.visual && entity.visual.color || null,
      position: sourcePositionObject(entity),
      styleSource: 'SourceSceneIR.entities[].visual',
      positionSource: 'SourceSceneIR.entities[].position',
    };
  });
  return out;
}

function sourceSceneContract(ir) {
  var scene = clone(ir.scene || {});
  scene.present = true;
  scene.carrier = 'window.__BP_SOURCE_IR__.scene';
  scene.camera = Object.assign({
    present: true,
    source: 'window.__BP_SOURCE_IR__.scene.camera',
  }, scene.camera || {});
  return scene;
}

function compileSourcePhaseContract(ir) {
  var projection = projectSourceSceneIrToLegacy(ir);
  var phases = safeArray(ir.phases).map(function(phase, index) {
    var projected = projection.PHASES[index] || {};
    return {
      index: index,
      id: phase.id,
      name: phase.title || phase.id,
      guideText: phase.guideText || '',
      goalText: phase.goalText || '',
      showEntities: safeArray(phase.showEntities),
      plannedModuleIds: safeArray(phase.plannedModuleIds),
      trigger: projected.trigger || null,
      steps: safeArray(projected.steps),
      stepSource: 'SourceSceneIR.phases[].steps',
      targetSequence: safeArray(phase.targetSequence),
      runtimeTargetSequence: safeArray(phase.targetSequence),
      runtimeVisibleEntities: safeArray(phase.showEntities),
      runtimeResources: {},
      hudText: phase.hudText || null,
      diagnostics: [],
    };
  });
  return {
    present: true,
    carrier: 'window.__BP_SOURCE_IR__.phases',
    phaseCount: phases.length,
    phases: phases,
    visibilityRules: {},
    resourceRules: [],
    diagnostics: [],
  };
}

function compileVisualAssetManifest(sourceIr, options) {
  options = options || {};
  var ir = normalizeSourceSceneIr(sourceIr, options);
  validateSourceSceneIr(ir);
  var entityStyles = compileEntityStyles(ir);
  var entityNames = safeArray(ir.entities).map(function(entity) { return entity.id; });
  var manifest = {
    visualAssetsSchemaVersion: visualAssets.VISUAL_ASSET_SCHEMA_VERSION,
    kind: visualAssets.VISUAL_ASSET_KIND,
    assetLicenseContractVersion: visualAssets.ASSET_LICENSE_CONTRACT_VERSION,
    generatedAt: options.generatedAt || ir.generatedAt || new Date().toISOString(),
    source: ir.source && ir.source.htmlPath || options.sourceHtmlPath || null,
    sourceHtmlPath: ir.source && ir.source.htmlPath || options.sourceHtmlPath || null,
    sourceHtmlSha256: ir.source && ir.source.htmlSha256 || options.sourceHtmlSha256 || null,
    playableSceneIrHash: options.playableSceneIrHash || null,
    project: options.project || ir.project && ir.project.name || null,
    fidelityTarget: 'geometry_color_material',
    assetMetadata: {
      contractVersion: visualAssets.ASSET_LICENSE_CONTRACT_VERSION,
      carrier: 'source-scene-ir',
      entryCount: 0,
      diagnostics: [],
    },
    sourceEntityContract: {
      styleEntityCount: entityNames.length,
      sourceEntityCount: entityNames.length,
      entities: entityNames,
      entityStyles: entityStyles,
      entityComposites: {},
      domHudContract: ir.hud && ir.hud.domHudContract || null,
      uiOverlayContract: ir.hud && ir.hud.uiOverlayContract || null,
      worldLabelContract: null,
    },
    sourceSceneContract: sourceSceneContract(ir),
    sourcePhaseContract: compileSourcePhaseContract(ir),
    fidelityContract: null,
    extractionSummary: {
      source: 'source-scene-ir',
      assetCount: 0,
      entityCount: entityNames.length,
      unsupportedCount: 0,
    },
    assets: [],
    entityBindings: {},
    unsupported: [],
  };
  entityNames.forEach(function(name) {
    manifest.entityBindings[name] = {
      primaryAssetId: null,
      assetIds: [],
      fidelityTarget: null,
      visualFallback: 'source-scene-ir-procedural',
    };
  });
  manifest.visualRuntimeContract = visualAssets.buildVisualRuntimeContract(manifest, {
    generatedAt: manifest.generatedAt,
  });
  visualAssets.validateVisualAssetManifest(manifest);
  return manifest;
}

module.exports = {
  compileVisualAssetManifest: compileVisualAssetManifest,
};
