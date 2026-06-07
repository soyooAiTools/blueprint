'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var {
  normalizeSourceSceneIr,
  validateSourceSceneIr,
} = require('./source-scene-ir.cjs');

var SOURCE_VISUAL_IR_SCHEMA_VERSION = 'source-visual-ir.v1';
var SOURCE_VISUAL_IR_KIND = 'blueprint.sourceVisualIR';

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value == null ? null : JSON.parse(JSON.stringify(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  var out = {};
  Object.keys(value).sort().forEach(function(key) {
    if (value[key] !== undefined) out[key] = stableValue(value[key]);
  });
  return out;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function sha256OfString(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function toNumber(value, fallback) {
  var n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function vector(value, fallback, size) {
  var source = Array.isArray(value) ? value : fallback;
  var out = safeArray(source).slice(0, size).map(function(item, index) {
    return toNumber(item, safeArray(fallback)[index] || 0);
  });
  while (out.length < size) out.push(safeArray(fallback)[out.length] || 0);
  return out;
}

function uniqueStrings(values) {
  var seen = {};
  var out = [];
  safeArray(values).forEach(function(value) {
    var text = String(value || '').trim();
    if (!text || seen[text]) return;
    seen[text] = true;
    out.push(text);
  });
  return out;
}

function isHudOnlyEntity(entity) {
  var kind = String(entity && entity.kind || '');
  var id = String(entity && entity.id || '');
  return /\b(ui_marker|hud|hud_marker|ui_overlay|screen_ui)\b/i.test(kind + ' ' + id) ||
    /(?:^|_)(?:GoldUI|JoystickUI|HUD|Hud|GuideText|PhaseLabel)$/i.test(id);
}

function normalizeMeshOps(entity) {
  var visual = entity && entity.visual || {};
  var ops = safeArray(visual.meshOps).map(clone);
  if (ops.length === 0) {
    ops.push({
      kind: 'primitive',
      primitive: visual.primitive || 'box',
      color: visual.color || '#ffffff',
      source: 'SourceSceneIR.entities[].visual',
    });
  }
  return ops;
}

function entityMaterial(entity) {
  var visual = entity && entity.visual || {};
  return {
    color: visual.color || '#ffffff',
    opacity: visual.opacity != null ? toNumber(visual.opacity, 1) : 1,
    emissive: visual.emissive || visual.emission || null,
    texture: visual.texture || null,
  };
}

function visualEntities(sourceIr) {
  return safeArray(sourceIr.entities).filter(function(entity) {
    return !isHudOnlyEntity(entity);
  }).map(function(entity) {
    return {
      id: entity.id,
      label: entity.label || entity.id,
      kind: entity.kind || null,
      position: vector(entity.position, [0, 0, 0], 3),
      scale: vector(entity.scale, [1, 1, 1], 3),
      visibleFromPhase: entity.visibleFromPhase || null,
      material: entityMaterial(entity),
      meshOps: normalizeMeshOps(entity),
      binding: clone(entity.binding || null),
    };
  });
}

function visualScene(sourceIr) {
  var scene = sourceIr.scene || {};
  return {
    coordinateSystem: scene.coordinateSystem || 'three-xz-y-up',
    backgroundColor: scene.backgroundColor || '#071026',
    camera: clone(scene.camera || null),
    ground: clone(scene.ground || null),
    lights: clone(safeArray(scene.lights)),
    grid: clone(scene.grid || null),
  };
}

function phasePrimaryTarget(phase, renderableMap) {
  var sequence = safeArray(phase && phase.targetSequence);
  sequence = sequence.filter(function(id) { return renderableMap[id]; });
  if (sequence.length) return sequence[0];
  var step = safeArray(phase && phase.steps).find(function(item) {
    var id = item && (item.target || item.from || item.to || item.entity);
    return id && renderableMap[id];
  });
  if (step) return step.target || step.from || step.to || step.entity;
  return safeArray(phase && phase.showEntities).filter(function(name) {
    return renderableMap[name] && !/^(Player|GuideText|HUD|Camera)$/i.test(name);
  })[0] || null;
}

function phaseHudState(sourceIr, phase) {
  return {
    tip: phase.guideText || '',
    goal: phase.goalText || '',
    hudText: clone(phase.hudText || null),
    resources: safeArray(sourceIr.hud && sourceIr.hud.resourceBar),
  };
}

function visualPhaseStates(sourceIr) {
  var renderableMap = {};
  var entityIds = safeArray(sourceIr.entities).filter(function(entity) {
    return !isHudOnlyEntity(entity);
  }).map(function(entity) {
    renderableMap[entity.id] = true;
    return entity.id;
  });
  return safeArray(sourceIr.phases).map(function(phase, index) {
    var visible = uniqueStrings(phase.showEntities).filter(function(id) { return renderableMap[id]; });
    var visibleMap = {};
    visible.forEach(function(id) { visibleMap[id] = true; });
    var hidden = entityIds.filter(function(id) { return !visibleMap[id]; });
    var primaryTarget = phasePrimaryTarget(phase, renderableMap);
    return {
      index: index,
      id: phase.id,
      title: phase.title || phase.id,
      guideText: phase.guideText || '',
      goalText: phase.goalText || '',
      visibleEntities: visible,
      hiddenEntities: hidden,
      hud: phaseHudState(sourceIr, phase),
      resourceStates: safeArray(sourceIr.resources).map(function(resource) {
        return {
          id: resource.id,
          label: resource.label || resource.id,
          carrierEntity: resource.carrierEntity || null,
          initial: Number(resource.initial) || 0,
        };
      }),
      targetSequence: uniqueStrings(phase.targetSequence || (primaryTarget ? [primaryTarget] : [])).filter(function(id) { return renderableMap[id]; }),
      guidance: {
        primaryTarget: primaryTarget,
        targetRingVisible: !!primaryTarget,
      },
      ctaVisible: index === safeArray(sourceIr.phases).length - 1 && !!(sourceIr.hud && sourceIr.hud.cta),
    };
  });
}

function visualHud(sourceIr) {
  var hud = sourceIr.hud || {};
  return {
    tip: clone(hud.tip || { source: 'phase.guideText' }),
    resourceBar: safeArray(hud.resourceBar),
    domHudContract: clone(hud.domHudContract || null),
    uiOverlayContract: clone(hud.uiOverlayContract || null),
  };
}

function visualGuidance(sourceIr, phaseStates) {
  var guidance = isObject(sourceIr.scene && sourceIr.scene.guidance)
    ? clone(sourceIr.scene.guidance)
    : {};
  if (!guidance.targetRing) guidance.targetRing = { enabled: true, source: 'SourceSceneIR.phases[].targetSequence' };
  if (!guidance.trailLine) guidance.trailLine = { enabled: false };
  if (!guidance.laserLine) guidance.laserLine = { enabled: false };
  guidance.phaseTargets = safeArray(phaseStates).map(function(phase) {
    return {
      phaseId: phase.id,
      primaryTarget: phase.guidance && phase.guidance.primaryTarget || null,
      targetSequence: safeArray(phase.targetSequence),
    };
  });
  return guidance;
}

function visualCta(sourceIr) {
  var cta = isObject(sourceIr.hud && sourceIr.hud.cta) ? sourceIr.hud.cta : {};
  var dom = sourceIr.hud && sourceIr.hud.domHudContract || {};
  var initialText = isObject(dom.initialText) ? dom.initialText : {};
  var phases = safeArray(sourceIr.phases);
  return {
    entity: cta.entity || 'CtaButton',
    arrivalGated: cta.arrivalGated !== false,
    finalPhase: phases.length ? phases[phases.length - 1].id : null,
    title: cta.title || initialText.ctaTitle || initialText.title || '立即下载',
    buttonText: cta.buttonText || initialText.ctaButton || initialText.buttonText || '安装完整游戏',
    subtitle: cta.subtitle || initialText.ctaSubtitle || initialText.subtitle || '',
  };
}

function semanticPayload(ir) {
  return {
    schemaVersion: ir && ir.schemaVersion,
    kind: ir && ir.kind,
    project: ir && ir.project || null,
    source: {
      sourceSceneIrHash: ir && ir.source && ir.source.sourceSceneIrHash || null,
    },
    visual: ir && ir.visual || null,
  };
}

function computeSourceVisualIrHash(ir) {
  return sha256OfString(stableStringify(semanticPayload(ir)));
}

function buildSourceVisualIrFromSourceSceneIr(sourceIr, options) {
  options = options || {};
  var ir = normalizeSourceSceneIr(sourceIr, options);
  validateSourceSceneIr(ir);
  var phaseStates = visualPhaseStates(ir);
  var visualIr = {
    schemaVersion: SOURCE_VISUAL_IR_SCHEMA_VERSION,
    kind: SOURCE_VISUAL_IR_KIND,
    generatedAt: options.generatedAt || ir.generatedAt || new Date().toISOString(),
    project: clone(ir.project),
    source: {
      sourceSceneIrHash: ir.semanticHash,
      htmlPath: ir.source && ir.source.htmlPath || options.sourceHtmlPath || null,
      htmlSha256: ir.source && ir.source.htmlSha256 || options.sourceHtmlSha256 || null,
    },
    visual: {
      scene: visualScene(ir),
      entities: visualEntities(ir),
      hud: visualHud(ir),
      phaseStates: phaseStates,
      guidance: visualGuidance(ir, phaseStates),
      cta: visualCta(ir),
    },
    diagnostics: {
      semanticSource: 'source-scene-ir',
      legacyJsInferenceUsed: false,
    },
  };
  visualIr.semanticHash = computeSourceVisualIrHash(visualIr);
  validateSourceVisualIr(visualIr, { sourceSceneIr: ir });
  return visualIr;
}

function normalizeSourceVisualIr(doc, options) {
  options = options || {};
  if (!isObject(doc)) throw new Error('SourceVisualIR must be an object');
  var out = {
    schemaVersion: doc.schemaVersion || SOURCE_VISUAL_IR_SCHEMA_VERSION,
    kind: doc.kind || SOURCE_VISUAL_IR_KIND,
    generatedAt: doc.generatedAt || options.generatedAt || new Date().toISOString(),
    project: clone(doc.project || {}),
    source: clone(doc.source || {}),
    visual: {
      scene: clone(doc.visual && doc.visual.scene || {}),
      entities: safeArray(doc.visual && doc.visual.entities).map(function(entity) {
        return Object.assign({}, clone(entity || {}), {
          id: String(entity && entity.id || ''),
          meshOps: safeArray(entity && entity.meshOps).map(clone),
        });
      }),
      hud: clone(doc.visual && doc.visual.hud || {}),
      phaseStates: safeArray(doc.visual && doc.visual.phaseStates).map(clone),
      guidance: clone(doc.visual && doc.visual.guidance || {}),
      cta: clone(doc.visual && doc.visual.cta || {}),
    },
    diagnostics: clone(doc.diagnostics || null),
  };
  out.semanticHash = computeSourceVisualIrHash(out);
  return out;
}

function indexById(items) {
  var out = {};
  safeArray(items).forEach(function(item) {
    if (item && item.id) out[item.id] = item;
  });
  return out;
}

function addViolation(out, code, message, extra) {
  out.push(Object.assign({ code: code, message: message }, extra || {}));
}

function collectSourceVisualIrViolations(doc, options) {
  options = options || {};
  var out = [];
  if (!isObject(doc)) {
    addViolation(out, 'source_visual_ir_not_object', 'SourceVisualIR must be an object');
    return out;
  }
  if (doc.schemaVersion !== SOURCE_VISUAL_IR_SCHEMA_VERSION) {
    addViolation(out, 'source_visual_ir_schema_version_invalid', 'unsupported SourceVisualIR schemaVersion: ' + doc.schemaVersion);
  }
  if (doc.kind !== SOURCE_VISUAL_IR_KIND) {
    addViolation(out, 'source_visual_ir_kind_invalid', 'invalid SourceVisualIR kind: ' + doc.kind);
  }
  if (!isObject(doc.visual)) {
    addViolation(out, 'source_visual_ir_visual_missing', 'visual object is required');
    return out;
  }
  if (!isObject(doc.visual.scene)) addViolation(out, 'source_visual_ir_scene_missing', 'visual.scene is required');
  if (!Array.isArray(doc.visual.entities) || doc.visual.entities.length === 0) {
    addViolation(out, 'source_visual_ir_entities_missing', 'visual.entities[] must not be empty');
  }
  if (!Array.isArray(doc.visual.phaseStates) || doc.visual.phaseStates.length === 0) {
    addViolation(out, 'source_visual_ir_phase_states_missing', 'visual.phaseStates[] must not be empty');
  }
  var entityIds = indexById(doc.visual.entities);
  var seenEntities = {};
  safeArray(doc.visual.entities).forEach(function(entity, index) {
    if (!entity || !entity.id) addViolation(out, 'source_visual_ir_entity_id_missing', 'visual.entities[' + index + '].id is required');
    if (entity && entity.id && seenEntities[entity.id]) addViolation(out, 'source_visual_ir_entity_id_duplicate', 'duplicate visual entity id: ' + entity.id);
    if (entity && entity.id) seenEntities[entity.id] = true;
    if (!Array.isArray(entity && entity.meshOps)) addViolation(out, 'source_visual_ir_entity_mesh_ops_invalid', 'visual.entities[' + index + '].meshOps must be an array');
  });
  var seenPhases = {};
  safeArray(doc.visual.phaseStates).forEach(function(phase, index) {
    var expected = 'phase' + (index + 1);
    if (!phase || !phase.id) {
      addViolation(out, 'source_visual_ir_phase_id_missing', 'visual.phaseStates[' + index + '].id is required');
    } else {
      if (seenPhases[phase.id]) addViolation(out, 'source_visual_ir_phase_id_duplicate', 'duplicate visual phase id: ' + phase.id);
      seenPhases[phase.id] = true;
      if (phase.id !== expected) addViolation(out, 'source_visual_ir_phase_id_not_sequential', 'visual.phaseStates[' + index + '].id must be ' + expected);
    }
    safeArray(phase && phase.visibleEntities).forEach(function(id) {
      if (!entityIds[id]) addViolation(out, 'source_visual_ir_visible_entity_missing', 'visual.phaseStates[' + index + '].visibleEntities missing entity: ' + id);
    });
    safeArray(phase && phase.targetSequence).forEach(function(id) {
      if (!entityIds[id]) addViolation(out, 'source_visual_ir_target_entity_missing', 'visual.phaseStates[' + index + '].targetSequence missing entity: ' + id);
    });
    var primaryTarget = phase && phase.guidance && phase.guidance.primaryTarget;
    if (primaryTarget && !entityIds[primaryTarget]) {
      addViolation(out, 'source_visual_ir_guidance_target_missing', 'visual.phaseStates[' + index + '].guidance.primaryTarget missing entity: ' + primaryTarget);
    }
  });
  var ctaEntity = doc.visual.cta && doc.visual.cta.entity;
  if (ctaEntity && !entityIds[ctaEntity]) {
    addViolation(out, 'source_visual_ir_cta_entity_missing', 'visual.cta.entity missing entity: ' + ctaEntity);
  }
  if (options.sourceSceneIr && options.sourceSceneIr.semanticHash && doc.source && doc.source.sourceSceneIrHash !== options.sourceSceneIr.semanticHash) {
    addViolation(out, 'source_visual_ir_source_hash_mismatch', 'source.sourceSceneIrHash does not match SourceSceneIR semanticHash');
  }
  if (doc.semanticHash) {
    var expectedHash = computeSourceVisualIrHash(doc);
    if (doc.semanticHash !== expectedHash) {
      addViolation(out, 'source_visual_ir_semantic_hash_mismatch', 'semanticHash mismatch: expected=' + expectedHash + ' actual=' + doc.semanticHash);
    }
  }
  return out;
}

function validateSourceVisualIr(doc, options) {
  var violations = collectSourceVisualIrViolations(doc, options);
  if (violations.length > 0) {
    throw new Error('SourceVisualIR validation failed: ' + violations.map(function(item) {
      return item.code + ': ' + item.message;
    }).join('; '));
  }
  return true;
}

function writeSourceVisualIr(filePath, doc) {
  validateSourceVisualIr(doc);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(doc, null, 2) + '\n');
}

module.exports = {
  SOURCE_VISUAL_IR_SCHEMA_VERSION: SOURCE_VISUAL_IR_SCHEMA_VERSION,
  SOURCE_VISUAL_IR_KIND: SOURCE_VISUAL_IR_KIND,
  buildSourceVisualIrFromSourceSceneIr: buildSourceVisualIrFromSourceSceneIr,
  normalizeSourceVisualIr: normalizeSourceVisualIr,
  validateSourceVisualIr: validateSourceVisualIr,
  collectSourceVisualIrViolations: collectSourceVisualIrViolations,
  computeSourceVisualIrHash: computeSourceVisualIrHash,
  writeSourceVisualIr: writeSourceVisualIr,
  isHudOnlyEntity: isHudOnlyEntity,
};
