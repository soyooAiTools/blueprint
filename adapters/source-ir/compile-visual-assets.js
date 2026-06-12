'use strict';

var visualAssets = require('./visual-assets.js');
var {
  normalizeSourceSceneIr,
  projectSourceSceneIrToLegacy,
  validateSourceSceneIr,
} = require('../../engine/source-scene-ir.cjs');
var {
  buildSourceVisualIrFromSourceSceneIr,
} = require('../../engine/source-visual-ir.cjs');

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function clone(value) {
  return value == null ? null : JSON.parse(JSON.stringify(value));
}

function computeSourceRuntimeResources(resources, phases, phaseIndex) {
  var out = {};
  safeArray(resources).forEach(function(resource) {
    if (!resource || !resource.id) return;
    out[resource.id] = Number(resource.initial) || 0;
  });
  safeArray(phases).slice(0, Math.max(0, phaseIndex)).forEach(function(phase) {
    safeArray(phase && phase.steps).forEach(function(step) {
      var kind = String(step && step.kind || '');
      var id = step && step.resource;
      if (!id) return;
      if (kind === 'collect' || kind === 'produce' || kind === 'reward') {
        out[id] = Number(out[id] || 0) + (Number(step.amount) || 1);
      } else if (kind === 'deliver' || kind === 'transfer' || kind === 'combine') {
        out[id] = Math.max(0, Number(out[id] || 0) - (Number(step.amount || step.cost) || 1));
      } else if (kind === 'set_resource') {
        out[id] = Number(step.amount || step.value) || 0;
      }
    });
  });
  return out;
}

function sourcePositionObject(entity) {
  var position = safeArray(entity && entity.position);
  return {
    x: Number(position[0]) || 0,
    y: Number(position[1]) || 0,
    z: Number(position[2]) || 0,
  };
}

function isHudOnlySourceEntity(entity) {
  var kind = String(entity && entity.kind || '');
  var id = String(entity && entity.id || '');
  return /\b(ui_marker|hud|hud_marker|ui_overlay|screen_ui|cta|install|download)\b/i.test(kind + ' ' + id) ||
    /^(CtaButton|CTAButton|CTAPopup|InstallButton|DownloadButton)$/i.test(id) ||
    /(?:^|_)(?:GoldUI|JoystickUI|HUD|Hud|GuideText|PhaseLabel)$/i.test(id);
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

function compileWorldLabelContract(ir) {
  var labels = safeArray(ir.entities).filter(function(entity) {
    return !isHudOnlySourceEntity(entity);
  }).map(function(entity) {
    return {
      id: entity.id,
      label: entity.label || entity.id,
      kind: entity.kind || null,
      position: sourcePositionObject(entity),
      yOffset: Number(entity.visual && entity.visual.labelYOffset || 1.85),
      source: 'SourceSceneIR.entities[].label',
    };
  });
  return {
    present: labels.length > 0,
    source: 'source-scene-ir',
    carrier: 'window.__BP_SOURCE_IR__.entities[].label',
    labelCount: labels.length,
    labels: labels,
  };
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

function sanitizeId(value, fallback) {
  var text = String(value || fallback || 'asset').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!text) text = 'asset';
  return /^[A-Za-z]/.test(text) ? text : 'asset_' + text;
}

function hexToNumber(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return value & 0xffffff;
  var text = String(value || '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{6}$/i.test(text)) return parseInt(text, 16);
  return fallback == null ? 0xffffff : fallback;
}

function colorString(value, fallback) {
  var n = hexToNumber(value, hexToNumber(fallback || '#ffffff'));
  return '#' + n.toString(16).padStart(6, '0').toUpperCase();
}

function inferredPrimitive(entity, op) {
  var primitive = String(op && (op.primitive || op.kind) || '').toLowerCase();
  if (primitive === 'primitive') primitive = String(op && op.primitive || '').toLowerCase();
  if (!primitive || primitive === 'box') {
    var text = String(entity && entity.kind || '') + ' ' + String(entity && entity.id || '');
    if (/player|hero|npc|astronaut|queue|person/i.test(text)) return 'cylinder';
    if (/water|apple|gold|ice|resource|coin|gem|drop|bottle/i.test(text)) return 'sphere';
    return 'box';
  }
  if (primitive === 'capsule') return 'cylinder';
  return primitive;
}

function primitiveDefaults(kind) {
  if (kind === 'sphere' || kind === 'icosahedron') {
    return {
      geometryType: kind === 'icosahedron' ? 'IcosahedronGeometry' : 'SphereGeometry',
      geometryArgs: kind === 'icosahedron' ? [0.52, 0] : [0.52, 20, 14],
      meshSize: [0.52],
      localPosition: [0, 0.56, 0],
      scale: [1, 1, 1],
    };
  }
  if (kind === 'cylinder' || kind === 'cone') {
    return {
      geometryType: kind === 'cone' ? 'ConeGeometry' : 'CylinderGeometry',
      geometryArgs: kind === 'cone' ? [0.46, 1.1, 20] : [0.38, 0.44, 1.15, 20],
      meshSize: kind === 'cone' ? [0.46, 0, 1.1] : [0.38, 0.44, 1.15],
      localPosition: [0, 0.62, 0],
      scale: [1, 1, 1],
    };
  }
  if (kind === 'plane') {
    return {
      geometryType: 'PlaneGeometry',
      geometryArgs: [1, 1],
      meshSize: [1, 1],
      localPosition: [0, 0.04, 0],
      scale: [1, 1, 1],
    };
  }
  if (kind === 'torus') {
    return {
      geometryType: 'TorusGeometry',
      geometryArgs: [0.62, 0.08, 8, 48],
      meshSize: [0.62, 0.08],
      localPosition: [0, 0.12, 0],
      scale: [1, 1, 1],
    };
  }
  return {
    geometryType: 'BoxGeometry',
    geometryArgs: [1, 0.9, 1],
    meshSize: [1, 0.9, 1],
    localPosition: [0, 0.48, 0],
    scale: [1, 1, 1],
  };
}

function sourceMeshOpFor(entity, op) {
  var kind = inferredPrimitive(entity, op);
  var defaults = primitiveDefaults(kind);
  var material = entity && entity.material || {};
  var color = colorString(op && op.color || material.color, '#ffffff');
  return {
    kind: kind,
    position: safeArray(op && op.position).length ? clone(op.position) : defaults.localPosition,
    rotation: safeArray(op && op.rotation).length ? clone(op.rotation) : [0, 0, 0],
    size: safeArray(op && op.size).length ? clone(op.size) : defaults.meshSize,
    scale: safeArray(op && op.scale).length ? clone(op.scale) : defaults.scale,
    color: hexToNumber(color, 0xffffff),
    opacity: op && op.opacity != null ? Number(op.opacity) : (material.opacity != null ? Number(material.opacity) : 1),
    roughness: op && op.roughness != null ? Number(op.roughness) : 0.65,
    metalness: op && op.metalness != null ? Number(op.metalness) : 0.05,
    emissive: op && op.emissive != null ? hexToNumber(op.emissive, 0) : 0,
    emissiveIntensity: op && op.emissiveIntensity != null ? Number(op.emissiveIntensity) : 0,
    source: op && op.source || 'SourceVisualIR.visual.entities[].meshOps',
    geometryType: defaults.geometryType,
    geometryArgs: defaults.geometryArgs,
  };
}

function positionObjectFromArray(position) {
  var p = safeArray(position);
  return {
    x: Number(p[0]) || 0,
    y: Number(p[1]) || 0,
    z: Number(p[2]) || 0,
  };
}

function visualPrimitiveAsset(entity, op, opIndex) {
  var entityId = entity.id;
  var assetId = 'asset_source_ir_' + sanitizeId(entityId) + '_' + opIndex;
  return {
    assetId: assetId,
    kind: 'procedural_primitive',
    license: 'unknown',
    attribution: null,
    source: {
      type: 'source-scene-ir',
      variable: 'SourceVisualIR.visual.entities[' + JSON.stringify(entityId) + '].meshOps[' + opIndex + ']',
      pattern: 'source-visual-ir:entity-primitive',
    },
    geometry: {
      type: op.geometryType,
      argsRaw: safeArray(op.geometryArgs).join(','),
      args: clone(op.geometryArgs),
      source: op.source,
    },
    material: {
      type: 'MeshStandardMaterial',
      diffuseColor: colorString(op.color, '#ffffff'),
      emissiveColor: op.emissive ? colorString(op.emissive, '#000000') : null,
      opacity: Number.isFinite(Number(op.opacity)) ? Number(op.opacity) : 1,
      transparent: Number(op.opacity) < 1,
      roughness: Number.isFinite(Number(op.roughness)) ? Number(op.roughness) : 0.65,
      metalness: Number.isFinite(Number(op.metalness)) ? Number(op.metalness) : 0.05,
    },
    transform: {
      position: clone(op.position),
      rotation: clone(op.rotation),
      scale: clone(op.scale),
    },
    unityImport: {
      mode: 'procedural-primitive',
      supported: true,
    },
    entityBinding: {
      entityName: entityId,
      confidence: 1,
      evidence: 'source-visual-ir',
    },
    fidelityTarget: 'geometry_color_only',
    visualFallback: 'source-scene-ir-procedural',
    unsupported: [],
  };
}

function compileVisualGeometry(ir, options) {
  var sourceVisualIr = buildSourceVisualIrFromSourceSceneIr(ir, options || {});
  var assets = [];
  var entityBindings = {};
  var entityComposites = {};
  var sourceMeshOps = {};
  safeArray(sourceVisualIr.visual && sourceVisualIr.visual.entities).forEach(function(entity) {
    if (isHudOnlySourceEntity(entity)) return;
    var ops = safeArray(entity.meshOps).map(function(op) { return sourceMeshOpFor(entity, op); });
    if (!ops.length) ops = [sourceMeshOpFor(entity, null)];
    var assetIds = [];
    ops.forEach(function(op, index) {
      var asset = visualPrimitiveAsset(entity, op, index);
      assets.push(asset);
      assetIds.push(asset.assetId);
    });
    sourceMeshOps[entity.id] = ops.map(function(op) {
      return {
        kind: op.kind,
        position: clone(op.position),
        rotation: clone(op.rotation),
        size: clone(op.size),
        scale: clone(op.scale),
        color: op.color,
        opacity: op.opacity,
        roughness: op.roughness,
        metalness: op.metalness,
        emissive: op.emissive,
        emissiveIntensity: op.emissiveIntensity,
        source: op.source,
      };
    });
    entityBindings[entity.id] = {
      entityName: entity.id,
      assetIds: assetIds,
      textureAssetIds: [],
      primaryAssetId: assetIds[0] || null,
      visualFallback: 'source-scene-ir-procedural',
      visualFallbacks: ['source-scene-ir-procedural'],
      fidelityTarget: 'geometry_color_only',
    };
    entityComposites[entity.id] = {
      entityName: entity.id,
      kind: entity.kind || null,
      label: entity.label || entity.id,
      color: colorString(entity.material && entity.material.color, '#ffffff'),
      position: positionObjectFromArray(entity.position),
      primaryAssetId: assetIds[0] || null,
      compositeAssetId: null,
      compositeSource: 'source-visual-ir',
      primitiveCount: assetIds.length,
      primitives: assets.filter(function(asset) {
        return asset.entityBinding && asset.entityBinding.entityName === entity.id;
      }).map(function(asset) {
        return {
          assetId: asset.assetId,
          sourceVariable: asset.source && asset.source.variable || null,
          sourcePattern: asset.source && asset.source.pattern || null,
          geometry: clone(asset.geometry),
          material: clone(asset.material),
          transform: clone(asset.transform),
          fidelityTarget: asset.fidelityTarget,
          visualFallback: asset.visualFallback,
        };
      }),
      fidelityTarget: 'geometry_color_only',
      visualFallback: 'source-scene-ir-procedural',
    };
  });
  return {
    sourceVisualIr: sourceVisualIr,
    assets: assets,
    entityBindings: entityBindings,
    entityComposites: entityComposites,
    sourceMeshOps: sourceMeshOps,
  };
}

function compileSourcePhaseContract(ir) {
  var projection = projectSourceSceneIrToLegacy(ir);
  var resources = safeArray(ir.resources).map(function(resource) {
    return {
      id: resource.id,
      label: resource.label || resource.id,
      kind: resource.kind || resource.type || 'resource',
      carrierEntity: resource.carrierEntity || resource.entity || null,
      initial: Number(resource.initial) || 0,
    };
  });
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
      runtimeResources: computeSourceRuntimeResources(resources, ir.phases, index),
      hudText: phase.hudText || null,
      diagnostics: [],
    };
  });
  return {
    present: true,
    carrier: 'window.__BP_SOURCE_IR__.phases',
    phaseCount: phases.length,
    phases: phases,
    resources: resources,
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
  var renderableEntityNames = safeArray(ir.entities).filter(function(entity) {
    return !isHudOnlySourceEntity(entity);
  }).map(function(entity) { return entity.id; });
  var visualGeometry = compileVisualGeometry(ir, {
    generatedAt: options.generatedAt,
    sourceHtmlPath: options.sourceHtmlPath,
    sourceHtmlSha256: options.sourceHtmlSha256,
  });
  var manifest = {
    visualAssetsSchemaVersion: visualAssets.VISUAL_ASSET_SCHEMA_VERSION,
    kind: visualAssets.VISUAL_ASSET_KIND,
    assetLicenseContractVersion: visualAssets.ASSET_LICENSE_CONTRACT_VERSION,
    generatedAt: options.generatedAt || ir.generatedAt || new Date().toISOString(),
    source: ir.source && ir.source.htmlPath || options.sourceHtmlPath || null,
    sourceHtmlPath: ir.source && ir.source.htmlPath || options.sourceHtmlPath || null,
    sourceHtmlSha256: ir.source && ir.source.htmlSha256 || options.sourceHtmlSha256 || null,
    playableSceneIrHash: options.playableSceneIrHash || null,
    sourceVisualIrHash: options.sourceVisualIrHash || null,
    project: options.project || ir.project && ir.project.name || null,
    fidelityTarget: 'geometry_color_material',
    assetMetadata: {
      contractVersion: visualAssets.ASSET_LICENSE_CONTRACT_VERSION,
      carrier: 'source-scene-ir',
      entryCount: visualGeometry.assets.length,
      diagnostics: [],
    },
    sourceEntityContract: {
      styleEntityCount: entityNames.length,
      sourceEntityCount: entityNames.length,
      renderableEntityCount: renderableEntityNames.length,
      entities: renderableEntityNames,
      hudOnlyEntities: entityNames.filter(function(name) { return renderableEntityNames.indexOf(name) < 0; }),
      entityStyles: entityStyles,
      entityComposites: visualGeometry.entityComposites,
      domHudContract: ir.hud && ir.hud.domHudContract || null,
      uiOverlayContract: ir.hud && ir.hud.uiOverlayContract || null,
      worldLabelContract: compileWorldLabelContract(ir),
    },
    sourceMeshOps: visualGeometry.sourceMeshOps,
    sourceSceneContract: sourceSceneContract(ir),
    sourcePhaseContract: compileSourcePhaseContract(ir),
    fidelityContract: null,
    extractionSummary: {
      source: 'source-scene-ir',
      assetCount: visualGeometry.assets.length,
      proceduralAssetCount: visualGeometry.assets.length,
      externalAssetCount: 0,
      entityCount: entityNames.length,
      renderableEntityCount: renderableEntityNames.length,
      entityBindingRate: entityNames.length ? 1 : 0,
      assetBindingRate: visualGeometry.assets.length ? 1 : 0,
      unsupportedCount: 0,
    },
    assets: visualGeometry.assets,
    entityBindings: visualGeometry.entityBindings,
    unsupported: [],
  };
  renderableEntityNames.forEach(function(name) {
    if (!manifest.entityBindings[name]) {
      manifest.entityBindings[name] = {
        primaryAssetId: null,
        assetIds: [],
        textureAssetIds: [],
        fidelityTarget: null,
        visualFallback: 'source-scene-ir-procedural',
        visualFallbacks: ['source-scene-ir-procedural'],
      };
    }
  });
  manifest.visualRuntimeContract = visualAssets.buildVisualRuntimeContract(manifest, {
    generatedAt: manifest.generatedAt,
  });
  visualAssets.validateVisualAssetManifest(manifest);
  return manifest;
}

module.exports = {
  compileVisualAssetManifest: compileVisualAssetManifest,
  isHudOnlySourceEntity: isHudOnlySourceEntity,
};
