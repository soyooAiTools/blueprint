'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var vm = require('vm');

var visualAssets = require('../adapters/demo2spec/visual-assets.js');

var SOURCE_SCENE_IR_SCHEMA_VERSION = 'source-scene-ir.v1';
var SOURCE_SCENE_IR_KIND = 'blueprint.sourceSceneIR';
var SOURCE_SCENE_IR_PREFLIGHT_KIND = 'blueprint.sourceSceneIR.preflightReport';

var STEP_KINDS = {
  move_to: true,
  collect: true,
  deliver: true,
  build: true,
  upgrade: true,
  attack: true,
  spawn: true,
  despawn: true,
  show: true,
  hide: true,
  set_tip: true,
  set_resource: true,
  set_entity_state: true,
  wait: true,
  cta_finish: true,
};

var GATE_KINDS = {
  near_entity: true,
  resource: true,
  entity_state: true,
  entity_count: true,
  timer: true,
  compound_all: true,
  compound_any: true,
  cta_arrival: true,
};

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

function sha256OfFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function stripComments(source) {
  return String(source || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractBalancedLiteral(source, openIndex, openChar, closeChar) {
  var depth = 0;
  var quote = null;
  var escaped = false;
  for (var i = openIndex; i < source.length; i += 1) {
    var ch = source[i];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === openChar) depth += 1;
    if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex, i + 1);
    }
  }
  return null;
}

function parseTopLevelLiteral(source, name, openChar, closeChar) {
  var html = stripComments(source);
  var escaped = escapeRegExp(name);
  var re = new RegExp('(?:\\b(?:const|let|var)\\s+' + escaped + '\\s*=|\\bwindow\\.' + escaped + '\\s*=|\\bglobalThis\\.' + escaped + '\\s*=)', 'g');
  var match;
  while ((match = re.exec(html))) {
    var openIndex = html.indexOf(openChar, re.lastIndex);
    if (openIndex < 0) return { value: null, literal: null, errors: [name + ' literal missing opening ' + openChar] };
    var literal = extractBalancedLiteral(html, openIndex, openChar, closeChar);
    if (!literal) return { value: null, literal: null, errors: [name + ' literal could not be balanced'] };
    try {
      return {
        value: vm.runInNewContext('(' + literal + ')', Object.create(null), { timeout: 100 }),
        literal: literal,
        errors: [],
      };
    } catch (err) {
      return { value: null, literal: literal, errors: [name + ' literal parse failed: ' + err.message] };
    }
  }
  return { value: null, literal: null, errors: [name + ' literal not found'] };
}

function parseQuotedStringAt(text, start) {
  var quote = text[start];
  if (quote !== '"' && quote !== "'" && quote !== '`') return null;
  var escaped = false;
  var value = '';
  for (var i = start + 1; i < text.length; i += 1) {
    var ch = text[i];
    if (escaped) {
      value += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === quote) return { value: value, end: i + 1 };
    value += ch;
  }
  return null;
}

function parseStringAssignment(source, name) {
  var html = stripComments(source);
  var escaped = escapeRegExp(name);
  var re = new RegExp('(?:\\b(?:const|let|var)\\s+' + escaped + '\\s*=|\\bwindow\\.' + escaped + '\\s*=|\\bglobalThis\\.' + escaped + '\\s*=)', 'g');
  var match;
  while ((match = re.exec(html))) {
    var i = re.lastIndex;
    while (/\s/.test(html[i] || '')) i += 1;
    var parsed = parseQuotedStringAt(html, i);
    if (parsed) return { value: parsed.value, errors: [] };
    return { value: null, errors: [name + ' assignment is not a quoted string'] };
  }
  return { value: null, errors: [name + ' assignment not found'] };
}

function parseOptionalAssignedLiteral(source, name, openChar, closeChar) {
  var html = stripComments(source);
  var escaped = escapeRegExp(name);
  var re = new RegExp('(?:\\b(?:const|let|var)\\s+' + escaped + '\\s*=|\\bwindow\\.' + escaped + '\\s*=|\\bglobalThis\\.' + escaped + '\\s*=)', 'g');
  var match = re.exec(html);
  if (!match) return { present: false, value: null, literal: null, derivedFromSourceIr: false, errors: [] };
  var i = re.lastIndex;
  while (/\s/.test(html[i] || '')) i += 1;
  if (html[i] !== openChar) {
    var semi = html.indexOf(';', i);
    var expression = html.slice(i, semi >= 0 ? semi : Math.min(html.length, i + 240)).trim();
    return {
      present: true,
      value: null,
      literal: null,
      expression: expression,
      derivedFromSourceIr: /\b__BP_SOURCE_IR__\b/.test(expression),
      errors: [],
    };
  }
  var literal = extractBalancedLiteral(html, i, openChar, closeChar);
  if (!literal) {
    return { present: true, value: null, literal: null, derivedFromSourceIr: false, errors: [name + ' literal could not be balanced'] };
  }
  try {
    return {
      present: true,
      value: vm.runInNewContext('(' + literal + ')', Object.create(null), { timeout: 100 }),
      literal: literal,
      derivedFromSourceIr: false,
      errors: [],
    };
  } catch (err) {
    return { present: true, value: null, literal: literal, derivedFromSourceIr: false, errors: [name + ' literal parse failed: ' + err.message] };
  }
}

function normalizeHash(value) {
  var text = String(value || '').trim().toLowerCase();
  return text || null;
}

function comparablePath(value) {
  if (!value) return null;
  return path.resolve(String(value));
}

function toNumber(value, fallback) {
  var number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeVector(value, fallback, size) {
  var out;
  if (Array.isArray(value)) {
    out = value.slice(0, size).map(function(item) { return toNumber(item, 0); });
  } else if (isObject(value)) {
    out = [
      toNumber(value.x != null ? value.x : value[0], 0),
      toNumber(value.y != null ? value.y : value[1], 0),
      toNumber(value.z != null ? value.z : value[2], 0),
    ].slice(0, size);
  } else if (Number.isFinite(Number(value)) && size === 3) {
    var n = Number(value);
    out = [n, n, n];
  } else {
    out = safeArray(fallback).slice(0, size);
  }
  while (out.length < size) out.push(0);
  return out;
}

function normalizeScale(value) {
  if (value == null) return [1, 1, 1];
  return normalizeVector(value, [1, 1, 1], 3).map(function(item) {
    return Number.isFinite(item) && item !== 0 ? item : 1;
  });
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

function normalizeId(value, fallback) {
  var text = String(value || fallback || '').trim();
  return text;
}

function normalizeProject(project) {
  if (typeof project === 'string') {
    return { name: project, theme: null };
  }
  project = isObject(project) ? project : {};
  return {
    name: String(project.name || project.projectName || project.id || 'storyboard2html'),
    theme: project.theme || project.themeHint || null,
  };
}

function normalizeLight(light) {
  if (!isObject(light)) return null;
  return {
    kind: light.kind || light.type || 'directional',
    color: light.color || '#ffffff',
    intensity: toNumber(light.intensity, 1),
    position: light.position ? normalizeVector(light.position, [0, 0, 0], 3) : null,
  };
}

function normalizeLights(scene) {
  var lights = safeArray(scene && scene.lights).map(normalizeLight).filter(Boolean);
  if (lights.length) return lights;
  ['ambientLight', 'directionalLight', 'rimLight'].forEach(function(key) {
    var light = scene && scene[key];
    if (!isObject(light)) return;
    lights.push(normalizeLight({
      kind: key === 'ambientLight' ? 'ambient' : 'directional',
      color: light.color || '#ffffff',
      intensity: light.intensity,
      position: light.position,
    }));
  });
  return lights.filter(Boolean);
}

function normalizeCamera(camera) {
  camera = isObject(camera) ? camera : {};
  var follow = isObject(camera.follow) ? {
    entity: camera.follow.entity || camera.follow.target || null,
    positionOffset: camera.follow.positionOffset ? normalizeVector(camera.follow.positionOffset, [0, 8, 12], 3) : null,
    lookAtOffset: camera.follow.lookAtOffset ? normalizeVector(camera.follow.lookAtOffset, [0, 0, 0], 3) : null,
    lerp: camera.follow.lerp != null ? toNumber(camera.follow.lerp, 0.12) : null,
    lookAtFactor: camera.follow.lookAtFactor != null ? toNumber(camera.follow.lookAtFactor, null) : null,
  } : null;
  return {
    kind: camera.kind || camera.type || 'perspective',
    fov: toNumber(camera.fov, 55),
    near: camera.near != null ? toNumber(camera.near, 0.1) : 0.1,
    far: camera.far != null ? toNumber(camera.far, 1000) : 1000,
    position: normalizeVector(camera.position, [0, 8, 12], 3),
    lookAt: normalizeVector(camera.lookAt, [0, 0, 0], 3),
    follow: follow,
    source: camera.source || null,
  };
}

function normalizeGround(ground) {
  ground = isObject(ground) ? ground : {};
  var size = ground.size || [
    ground.width != null ? ground.width : (ground.radius != null ? Number(ground.radius) * 2 : 24),
    ground.depth != null ? ground.depth : (ground.height != null && ground.kind !== 'box' ? ground.height : 24),
  ];
  return {
    kind: ground.kind || 'plane',
    size: normalizeVector(size, [24, 24], 2),
    color: ground.color || '#13233a',
    positionY: ground.positionY != null ? toNumber(ground.positionY, 0) : null,
  };
}

function normalizeScene(scene) {
  scene = isObject(scene) ? scene : {};
  return {
    coordinateSystem: scene.coordinateSystem || 'three-xz-y-up',
    backgroundColor: scene.backgroundColor || '#071026',
    camera: normalizeCamera(scene.camera),
    ground: normalizeGround(scene.ground),
    lights: normalizeLights(scene),
    grid: scene.grid || null,
    guidance: scene.guidance || null,
  };
}

function normalizeVisual(entity) {
  var visual = isObject(entity.visual) ? clone(entity.visual) : {};
  var style = isObject(entity.style) ? entity.style : entity;
  if (!visual.primitive) visual.primitive = entity.primitive || style.primitive || style.geometry || null;
  if (!visual.color) visual.color = entity.color || style.color || null;
  if (!Array.isArray(visual.meshOps)) visual.meshOps = safeArray(visual.meshOps);
  return visual;
}

function normalizeEntity(entity, index) {
  entity = isObject(entity) ? entity : {};
  var id = normalizeId(entity.id || entity.name, 'Entity' + (index + 1));
  return {
    id: id,
    label: String(entity.label || entity.chineseName || id),
    kind: entity.kind || entity.type || null,
    position: normalizeVector(entity.position || entity.initPos, [0, 0, 0], 3),
    scale: normalizeScale(entity.scale),
    visibleFromPhase: entity.visibleFromPhase || null,
    visual: normalizeVisual(entity),
    binding: entity.binding || (entity.assetIds || entity.primaryAssetId ? {
      assetIds: safeArray(entity.assetIds),
      primaryAssetId: entity.primaryAssetId || null,
    } : null),
  };
}

function normalizeResource(resource, index) {
  resource = isObject(resource) ? resource : { id: String(resource || '') };
  var id = normalizeId(resource.id || resource.name, 'Resource' + (index + 1));
  return {
    id: id,
    label: String(resource.label || resource.chineseName || id),
    kind: resource.kind || resource.type || 'resource',
    carrierEntity: resource.carrierEntity || resource.entity || null,
    initial: toNumber(resource.initial, 0),
  };
}

function normalizeDuration(duration) {
  if (!isObject(duration)) return { min: 10, max: 15 };
  return {
    min: toNumber(duration.min != null ? duration.min : duration.minSec, 10),
    max: toNumber(duration.max != null ? duration.max : duration.maxSec, 15),
  };
}

function normalizeGate(gate, phase, index, phaseCount) {
  gate = gate || phase && phase.trigger || null;
  if (!isObject(gate)) return null;
  var kind = gate.kind || gate.type || '';
  if (kind === 'resource_collected') {
    return {
      kind: 'resource',
      resource: gate.resource || null,
      threshold: toNumber(gate.threshold != null ? gate.threshold : gate.amount, 1),
    };
  }
  if (kind === 'near_entity') {
    return {
      kind: 'near_entity',
      entity: gate.entity || gate.target || null,
      radius: toNumber(gate.radius != null ? gate.radius : (gate.range != null ? gate.range : gate.distance), 2),
    };
  }
  if (kind === 'entity_state_reached') {
    return {
      kind: 'entity_state',
      entity: gate.entity || gate.target || null,
      state: gate.state != null ? gate.state : 1,
    };
  }
  if (kind === 'click_entity') {
    return {
      kind: 'cta_arrival',
      entity: gate.entity || gate.target || 'CtaButton',
    };
  }
  if (kind === 'compound') {
    return {
      kind: String(gate.operator || 'and').toLowerCase() === 'or' ? 'compound_any' : 'compound_all',
      gates: safeArray(gate.triggers || gate.gates).map(function(child) {
        return normalizeGate(child, phase, index, phaseCount);
      }).filter(Boolean),
    };
  }
  if (kind === 'timer') {
    return { kind: 'timer', seconds: toNumber(gate.seconds, 1) };
  }
  var out = clone(gate);
  out.kind = kind;
  delete out.type;
  return out;
}

function normalizeStep(step, index) {
  step = isObject(step) ? step : {};
  if (step.kind) {
    var direct = clone(step);
    direct.kind = String(step.kind);
    if (direct.index == null) direct.index = index;
    return direct;
  }
  if (step.damage) {
    return {
      index: index,
      kind: 'attack',
      target: step.target || step.entity || null,
      amount: step.amount != null ? toNumber(step.amount, 1) : null,
    };
  }
  if (step.gain) {
    return {
      index: index,
      kind: 'collect',
      resource: step.gain,
      amount: toNumber(step.amount, 1),
      from: step.target || step.from || null,
    };
  }
  if (step.spend) {
    return {
      index: index,
      kind: 'deliver',
      resource: step.spend,
      amount: toNumber(step.amount, 1),
      to: step.target || step.to || null,
    };
  }
  if (step.setEntity) {
    return {
      index: index,
      kind: 'set_entity_state',
      entity: step.setEntity,
      state: step.state != null ? step.state : 1,
    };
  }
  if (step.target) {
    return {
      index: index,
      kind: 'move_to',
      target: step.target,
      radius: toNumber(step.radius != null ? step.radius : step.range, 1.2),
    };
  }
  return {
    index: index,
    kind: 'wait',
    seconds: toNumber(step.seconds, 1),
  };
}

function deriveStepsFromGate(gate) {
  if (!isObject(gate)) return [];
  if (gate.kind === 'near_entity' && gate.entity) {
    return [{ index: 0, kind: 'move_to', target: gate.entity, radius: gate.radius || 1.2 }];
  }
  if (gate.kind === 'entity_state' && gate.entity) {
    return [{ index: 0, kind: 'set_entity_state', entity: gate.entity, state: gate.state != null ? gate.state : 1 }];
  }
  if (gate.kind === 'cta_arrival') {
    return [{ index: 0, kind: 'cta_finish', entity: gate.entity || 'CtaButton' }];
  }
  if (gate.kind === 'timer') {
    return [{ index: 0, kind: 'wait', seconds: gate.seconds || 1 }];
  }
  return [];
}

function normalizePhase(phase, index, phaseCount) {
  phase = isObject(phase) ? phase : {};
  var id = normalizeId(phase.id || phase.phaseId, 'phase' + (index + 1));
  var gate = normalizeGate(phase.gate || phase.trigger, phase, index, phaseCount);
  var steps = safeArray(phase.steps).map(normalizeStep);
  if (!steps.length) steps = deriveStepsFromGate(gate);
  return {
    index: index,
    id: id,
    title: String(phase.title || phase.name || phase.phaseName || id),
    guideText: String(phase.guideText || phase.playerInstruction || phase.tip || ''),
    goalText: String(phase.goalText || phase.goal || ''),
    showEntities: uniqueStrings(phase.showEntities || phase.entities || phase.entitiesRequired),
    steps: steps,
    gate: gate,
    duration: normalizeDuration(phase.duration),
    plannedModuleIds: uniqueStrings(phase.plannedModuleIds || phase.plannedModules),
    hudText: phase.hudText || null,
    targetSequence: uniqueStrings(phase.targetSequence || safeArray(steps).map(function(step) {
      return step.target || step.from || step.to || step.entity || '';
    })),
  };
}

function isHudOnlySourceEntity(entity) {
  var kind = String(entity && entity.kind || '');
  var id = String(entity && entity.id || '');
  return /\b(ui_marker|hud|hud_marker|ui_overlay|screen_ui)\b/i.test(kind + ' ' + id) ||
    /(?:^|_)(?:GoldUI|JoystickUI|HUD|Hud|GuideText|PhaseLabel)$/i.test(id);
}

function findSourcePlayerId(entities) {
  var exact = safeArray(entities).filter(function(entity) {
    return String(entity && entity.id || '').toLowerCase() === 'player' ||
      String(entity && entity.kind || '').toLowerCase() === 'player';
  })[0];
  var fuzzy = exact || safeArray(entities).filter(function(entity) {
    return /player|hero|主角|角色/i.test(String(entity && entity.id || '') + ' ' + String(entity && entity.label || '') + ' ' + String(entity && entity.kind || ''));
  })[0];
  return fuzzy && fuzzy.id || null;
}

function collectGateEntityTargets(gate, out) {
  out = out || [];
  if (!isObject(gate)) return out;
  if (gate.kind === 'compound_all' || gate.kind === 'compound_any') {
    safeArray(gate.gates).forEach(function(child) {
      collectGateEntityTargets(child, out);
    });
    return out;
  }
  var target = gate.entity || gate.target || (gate.kind === 'cta_arrival' ? 'CtaButton' : '');
  if (target && out.indexOf(target) < 0) out.push(target);
  return out;
}

function collectGateEntityStateRequirements(gate, out) {
  out = out || {};
  if (!isObject(gate)) return out;
  if (gate.kind === 'compound_all' || gate.kind === 'compound_any') {
    safeArray(gate.gates).forEach(function(child) {
      collectGateEntityStateRequirements(child, out);
    });
    return out;
  }
  if (gate.kind === 'entity_state' && (gate.entity || gate.target)) {
    var entity = gate.entity || gate.target;
    var required = Number(gate.state == null ? 1 : gate.state);
    out[entity] = Math.max(Number(out[entity] || 0), isFinite(required) ? required : 1);
  }
  return out;
}

function sourceStepEntityTarget(step) {
  return step && (step.target || step.from || step.to || step.entity) || '';
}

function repairSourcePhaseLiveness(phases, entities, runtimeContract, options) {
  options = options || {};
  if (options.repairPhaseLiveness === false) return { phases: phases, repairs: [] };
  var entityById = indexById(entities);
  var playerId = findSourcePlayerId(entities);
  var repairs = [];
  var repairedPhases = safeArray(phases).map(function(phase) {
    var next = clone(phase);
    next.showEntities = uniqueStrings(next.showEntities);
    if (runtimeContract && runtimeContract.requiresJoystick && playerId && entityById[playerId] && !isHudOnlySourceEntity(entityById[playerId]) && next.showEntities.indexOf(playerId) < 0) {
      next.showEntities.unshift(playerId);
      repairs.push({ code: 'source_ir_phase_player_visibility_repaired', phaseId: next.id, entity: playerId });
    }
    var targets = [];
    safeArray(next.steps).forEach(function(step) {
      var target = sourceStepEntityTarget(step);
      if (target && targets.indexOf(target) < 0) targets.push(target);
    });
    collectGateEntityTargets(next.gate, targets);
    targets.forEach(function(target) {
      var entity = entityById[target];
      if (!entity || isHudOnlySourceEntity(entity) || next.showEntities.indexOf(target) >= 0) return;
      next.showEntities.push(target);
      repairs.push({ code: 'source_ir_phase_target_visibility_repaired', phaseId: next.id, entity: target });
    });
    var stateRequirements = collectGateEntityStateRequirements(next.gate, {});
    Object.keys(stateRequirements).forEach(function(entityId) {
      var required = Number(stateRequirements[entityId] || 0);
      safeArray(next.steps).forEach(function(step) {
        if (['set_entity_state', 'build', 'upgrade'].indexOf(String(step && step.kind || '')) < 0) return;
        if ((step.entity || step.target) !== entityId) return;
        var current = Number(step.state != null ? step.state : (step.level != null ? step.level : 1));
        if (current >= required) return;
        step.state = required;
        repairs.push({ code: 'source_ir_phase_entity_state_step_repaired', phaseId: next.id, entity: entityId, before: current, after: required });
      });
    });
    next.showEntities = uniqueStrings(next.showEntities);
    next.targetSequence = uniqueStrings(next.targetSequence.concat(targets));
    return next;
  });
  return { phases: repairedPhases, repairs: repairs };
}

function resourceIdForStep(step) {
  return step && (step.resource || step.gain || step.spend) || null;
}

function inferResources(phases, existing) {
  var resources = safeArray(existing).map(normalizeResource);
  var seen = {};
  resources.forEach(function(resource) { seen[resource.id] = true; });
  safeArray(phases).forEach(function(phase) {
    safeArray(phase.steps).forEach(function(step) {
      var id = resourceIdForStep(step);
      if (!id || seen[id]) return;
      seen[id] = true;
      resources.push(normalizeResource({ id: id, label: id, kind: 'resource' }, resources.length));
    });
    if (phase.gate && phase.gate.resource && !seen[phase.gate.resource]) {
      seen[phase.gate.resource] = true;
      resources.push(normalizeResource({ id: phase.gate.resource, label: phase.gate.resource, kind: 'resource' }, resources.length));
    }
  });
  return resources;
}

function buildLegacyEntitiesFromManifest(manifest) {
  var contract = manifest && manifest.sourceEntityContract || {};
  var styles = contract.entityStyles || {};
  var composites = contract.entityComposites || {};
  var bindings = manifest && manifest.entityBindings || {};
  var phaseNames = [];
  safeArray(manifest && manifest.sourcePhaseContract && manifest.sourcePhaseContract.phases).forEach(function(phase) {
    phaseNames = phaseNames.concat(safeArray(phase && phase.showEntities));
    safeArray(phase && phase.steps).forEach(function(step) {
      phaseNames.push(step && (step.target || step.from || step.to || step.entity));
    });
    if (phase && phase.trigger) phaseNames.push(phase.trigger.entity || phase.trigger.target);
  });
  var names = uniqueStrings(safeArray(contract.entities)
    .concat(Object.keys(styles))
    .concat(Object.keys(composites))
    .concat(Object.keys(bindings))
    .concat(phaseNames))
    .sort();
  return names.map(function(name, index) {
    var style = styles[name] || {};
    var composite = composites[name] || {};
    var binding = bindings[name] || {};
    return normalizeEntity({
      id: name,
      label: composite.label || style.label || name,
      kind: composite.kind || style.kind || null,
      position: composite.position || style.position || null,
      scale: composite.scale || style.scale || null,
      visual: {
        primitive: composite.primitive || style.primitive || null,
        color: composite.color || style.color || null,
        meshOps: composite.meshOps || style.meshOps || [],
        styleSource: style.styleSource || null,
        positionSource: style.positionSource || null,
      },
      binding: {
        assetIds: safeArray(binding.assetIds),
        primaryAssetId: binding.primaryAssetId || null,
      },
    }, index);
  });
}

function buildSourceFromLegacyManifest(manifest, options) {
  options = options || {};
  var phases = safeArray(manifest && manifest.sourcePhaseContract && manifest.sourcePhaseContract.phases)
    .map(function(phase, index, all) { return normalizePhase(phase, index, all.length); });
  var entities = buildLegacyEntitiesFromManifest(manifest);
  var resources = inferResources(phases, []);
  var runtimeContract = buildRuntimeContract({
    phases: phases,
    visualRuntimeContract: manifest && manifest.visualRuntimeContract,
    html: options.html,
  });
  return {
    schemaVersion: SOURCE_SCENE_IR_SCHEMA_VERSION,
    kind: SOURCE_SCENE_IR_KIND,
    generatedAt: options.generatedAt || new Date().toISOString(),
    project: normalizeProject(options.project || manifest && manifest.project || 'storyboard2html'),
    scene: normalizeScene(manifest && manifest.sourceSceneContract),
    entities: entities,
    resources: resources,
    phases: phases,
    hud: buildHudContract(phases, resources, manifest),
    runtimeContract: runtimeContract,
    extraction: {
      carrier: 'legacy-html-contract',
      embeddedSourceIrPresent: false,
      legacyProjectionUsed: true,
    },
    diagnostics: {
      sourcePhaseContract: manifest && manifest.sourcePhaseContract && manifest.sourcePhaseContract.diagnostics || [],
      sourceSceneContract: manifest && manifest.sourceSceneContract && manifest.sourceSceneContract.diagnostics || [],
    },
  };
}

function buildSourceFromPlayableSceneIr(playable, options) {
  options = options || {};
  var phases = safeArray(playable && playable.phases).map(function(phase, index, all) {
    return normalizePhase(phase, index, all.length);
  });
  var entities = safeArray(playable && playable.entities).map(function(entity, index) {
    return normalizeEntity({
      id: entity && (entity.id || entity.name),
      label: entity && entity.label,
      kind: entity && entity.kind,
      position: entity && entity.position,
      visual: entity && (entity.visual || entity.style || entity.composite || {
        color: entity.color,
      }),
      binding: entity && {
        assetIds: safeArray(entity.assetIds),
        primaryAssetId: entity.primaryAssetId || null,
      },
    }, index);
  });
  return {
    schemaVersion: SOURCE_SCENE_IR_SCHEMA_VERSION,
    kind: SOURCE_SCENE_IR_KIND,
    generatedAt: options.generatedAt || new Date().toISOString(),
    project: normalizeProject(playable && playable.project || options.project || 'storyboard2html'),
    scene: normalizeScene(playable && playable.scene),
    entities: entities,
    resources: inferResources(phases, playable && playable.resources),
    phases: phases,
    hud: buildHudContract(phases, [], null),
    runtimeContract: buildRuntimeContract({
      phases: phases,
      html: options.html,
    }),
    extraction: {
      carrier: 'window.__BLUEPRINT_PLAYABLE_SCENE_IR__',
      embeddedSourceIrPresent: false,
      legacyProjectionUsed: true,
    },
  };
}

function hasJoystickRuntimeEvidence(html) {
  return /\b(player_input_joystick|joystick|JoyStick|VirtualJoystick|joypad)\b/i.test(String(html || ''));
}

function buildRuntimeContract(options) {
  options = options || {};
  var phases = safeArray(options.phases);
  var visualRuntimeContract = options.visualRuntimeContract || {};
  var planned = phases.reduce(function(all, phase) {
    return all.concat(safeArray(phase && phase.plannedModuleIds));
  }, []);
  var finalPhase = phases[phases.length - 1] || {};
  var requiresArrivalGate = !!(finalPhase.gate && finalPhase.gate.kind === 'cta_arrival');
  var requiresJoystick = planned.indexOf('player_input_joystick') >= 0 || hasJoystickRuntimeEvidence(options.html);
  return {
    requiresJoystick: !!requiresJoystick,
    requiresArrivalGate: !!requiresArrivalGate,
    forbidAutoplayProgress: true,
    phaseCount: phases.length,
    visualRuntimeContractHash: visualRuntimeContract.semanticHash || null,
    joystickEvidence: {
      present: hasJoystickRuntimeEvidence(options.html),
      source: hasJoystickRuntimeEvidence(options.html) ? 'source-html' : null,
    },
  };
}

function buildHudContract(phases, resources, manifest) {
  var sourceEntityContract = manifest && manifest.sourceEntityContract || {};
  var ctaEntity = 'CtaButton';
  var entityIds = {};
  if (sourceEntityContract.entityStyles) {
    Object.keys(sourceEntityContract.entityStyles).forEach(function(name) { entityIds[name] = true; });
  }
  if (!entityIds[ctaEntity]) {
    safeArray(phases).forEach(function(phase) {
      safeArray(phase.showEntities).forEach(function(name) {
        if (/cta|button|install|download/i.test(name)) ctaEntity = name;
      });
    });
  }
  return {
    tip: { source: 'phase.guideText' },
    resourceBar: safeArray(resources).map(function(resource) { return resource.id; }),
    cta: { entity: ctaEntity, arrivalGated: true },
    domHudContract: sourceEntityContract.domHudContract || null,
    uiOverlayContract: sourceEntityContract.uiOverlayContract || null,
  };
}

function normalizeSourceSceneIr(ir, options) {
  options = options || {};
  if (!isObject(ir)) throw new Error('SourceSceneIR must be an object');
  if (ir.kind === 'blueprint.playableSceneIR' || ir.schemaVersion === '1.0.0' && Array.isArray(ir.assets) && Array.isArray(ir.phases)) {
    return normalizeSourceSceneIr(buildSourceFromPlayableSceneIr(ir, options), options);
  }
  var phaseCount = safeArray(ir.phases).length;
  var phases = safeArray(ir.phases).map(function(phase, index) {
    return normalizePhase(phase, index, phaseCount);
  });
  var entities = safeArray(ir.entities).map(normalizeEntity);
  var resources = options.inferResources === true
    ? inferResources(phases, ir.resources)
    : safeArray(ir.resources).map(normalizeResource);
  var runtimeContract = Object.assign(buildRuntimeContract({
    phases: phases,
    html: options.html,
  }), isObject(ir.runtimeContract) ? clone(ir.runtimeContract) : {});
  if (!runtimeContract.joystickEvidence) {
    runtimeContract.joystickEvidence = {
      present: hasJoystickRuntimeEvidence(options.html),
      source: hasJoystickRuntimeEvidence(options.html) ? 'source-html' : null,
    };
  }
  var phaseRepair = repairSourcePhaseLiveness(phases, entities, runtimeContract, options);
  phases = phaseRepair.phases;
  var diagnostics = ir.diagnostics ? clone(ir.diagnostics) : null;
  if (phaseRepair.repairs.length > 0) {
    diagnostics = isObject(diagnostics) ? diagnostics : {};
    diagnostics.normalizationRepairs = safeArray(diagnostics.normalizationRepairs).concat(phaseRepair.repairs);
  }
  var normalized = {
    schemaVersion: SOURCE_SCENE_IR_SCHEMA_VERSION,
    kind: SOURCE_SCENE_IR_KIND,
    generatedAt: ir.generatedAt || options.generatedAt || new Date().toISOString(),
    source: {
      htmlPath: options.sourceHtmlPath ? comparablePath(options.sourceHtmlPath) : (ir.source && ir.source.htmlPath || null),
      htmlSha256: normalizeHash(options.sourceHtmlSha256 || ir.source && ir.source.htmlSha256),
    },
    project: normalizeProject(ir.project),
    scene: normalizeScene(ir.scene),
    entities: entities,
    resources: resources,
    phases: phases,
    hud: isObject(ir.hud) ? clone(ir.hud) : buildHudContract(phases, resources, null),
    runtimeContract: runtimeContract,
    extraction: ir.extraction || null,
    diagnostics: diagnostics,
  };
  normalized.semanticHash = computeSourceSceneIrHash(normalized);
  return normalized;
}

function semanticRuntimeContract(runtimeContract) {
  var out = clone(runtimeContract || {});
  if (out) {
    delete out.joystickEvidence;
    delete out.visualRuntimeContractHash;
  }
  return out;
}

function semanticPayload(ir) {
  return {
    schemaVersion: ir && ir.schemaVersion,
    kind: ir && ir.kind,
    project: ir && ir.project || null,
    scene: ir && ir.scene || null,
    entities: ir && ir.entities || [],
    resources: ir && ir.resources || [],
    phases: ir && ir.phases || [],
    hud: ir && ir.hud || null,
    runtimeContract: semanticRuntimeContract(ir && ir.runtimeContract),
  };
}

function computeSourceSceneIrHash(ir) {
  return sha256OfString(stableStringify(semanticPayload(ir)));
}

function indexById(items) {
  var out = {};
  safeArray(items).forEach(function(item) {
    if (item && item.id) out[item.id] = item;
  });
  return out;
}

function addError(errors, code, message, extra) {
  errors.push(Object.assign({ code: code, message: message }, extra || {}));
}

function validateGate(gate, index, phaseCount, entityIds, resourceIds, errors, pathPrefix) {
  if (gate == null) return;
  if (!isObject(gate)) {
    addError(errors, 'source_ir_gate_invalid', pathPrefix + ' must be an object');
    return;
  }
  if (!GATE_KINDS[gate.kind]) {
    addError(errors, 'source_ir_gate_kind_invalid', pathPrefix + '.kind is not allowed: ' + gate.kind);
  }
  if (gate.entity && !entityIds[gate.entity]) {
    addError(errors, 'source_ir_gate_entity_missing', pathPrefix + '.entity not found: ' + gate.entity);
  }
  if (gate.target && !entityIds[gate.target]) {
    addError(errors, 'source_ir_gate_target_missing', pathPrefix + '.target not found: ' + gate.target);
  }
  if (gate.resource && !resourceIds[gate.resource]) {
    addError(errors, 'source_ir_gate_resource_missing', pathPrefix + '.resource not found: ' + gate.resource);
  }
  if ((gate.kind === 'cta_arrival' || gate.kind === 'click_entity') && index !== phaseCount - 1) {
    addError(errors, 'source_ir_non_final_cta_gate', pathPrefix + ' uses CTA/click semantics before the final phase');
  }
  if (gate.kind === 'compound_all' || gate.kind === 'compound_any') {
    safeArray(gate.gates).forEach(function(child, childIndex) {
      validateGate(child, index, phaseCount, entityIds, resourceIds, errors, pathPrefix + '.gates[' + childIndex + ']');
    });
  }
}

function validateStep(step, index, phaseCount, entityIds, resourceIds, errors, pathPrefix) {
  if (!isObject(step)) {
    addError(errors, 'source_ir_step_invalid', pathPrefix + ' must be an object');
    return;
  }
  if (!STEP_KINDS[step.kind]) {
    addError(errors, 'source_ir_step_kind_invalid', pathPrefix + '.kind is not allowed: ' + step.kind);
  }
  ['target', 'from', 'to', 'entity'].forEach(function(key) {
    if (step[key] && !entityIds[step[key]]) {
      addError(errors, 'source_ir_step_entity_missing', pathPrefix + '.' + key + ' not found: ' + step[key]);
    }
  });
  if (step.resource && !resourceIds[step.resource]) {
    addError(errors, 'source_ir_step_resource_missing', pathPrefix + '.resource not found: ' + step.resource);
  }
  if ((step.kind === 'cta_finish' || step.kind === 'click_entity') && index !== phaseCount - 1) {
    addError(errors, 'source_ir_non_final_cta_step', pathPrefix + ' uses CTA/click semantics before the final phase');
  }
}

function collectSourceSceneIrViolations(ir) {
  var errors = [];
  if (!isObject(ir)) {
    addError(errors, 'source_ir_not_object', 'SourceSceneIR must be an object');
    return errors;
  }
  if (ir.schemaVersion !== SOURCE_SCENE_IR_SCHEMA_VERSION) {
    addError(errors, 'source_ir_schema_version_invalid', 'unsupported SourceSceneIR schemaVersion: ' + ir.schemaVersion);
  }
  if (ir.kind !== SOURCE_SCENE_IR_KIND) {
    addError(errors, 'source_ir_kind_invalid', 'invalid SourceSceneIR kind: ' + ir.kind);
  }
  if (ir.source && ir.source.htmlSha256 && !/^[0-9a-f]{64}$/i.test(String(ir.source.htmlSha256))) {
    addError(errors, 'source_ir_source_hash_invalid', 'source.htmlSha256 must be a sha256 hex string');
  }
  if (!Array.isArray(ir.entities) || ir.entities.length === 0) {
    addError(errors, 'source_ir_entities_missing', 'entities[] must not be empty');
  }
  if (!Array.isArray(ir.phases) || ir.phases.length === 0) {
    addError(errors, 'source_ir_phases_missing', 'phases[] must not be empty');
  }
  var entityIds = indexById(ir.entities);
  var resourceIds = indexById(ir.resources);
  var seenEntities = {};
  safeArray(ir.entities).forEach(function(entity, index) {
    if (!entity || !entity.id) addError(errors, 'source_ir_entity_id_missing', 'entities[' + index + '].id is required');
    if (entity && entity.id && seenEntities[entity.id]) addError(errors, 'source_ir_entity_id_duplicate', 'duplicate entity id: ' + entity.id);
    if (entity && entity.id) seenEntities[entity.id] = true;
  });
  var seenResources = {};
  safeArray(ir.resources).forEach(function(resource, index) {
    if (!resource || !resource.id) addError(errors, 'source_ir_resource_id_missing', 'resources[' + index + '].id is required');
    if (resource && resource.id && seenResources[resource.id]) addError(errors, 'source_ir_resource_id_duplicate', 'duplicate resource id: ' + resource.id);
    if (resource && resource.id) seenResources[resource.id] = true;
    if (resource && resource.carrierEntity && !entityIds[resource.carrierEntity]) {
      addError(errors, 'source_ir_resource_carrier_missing', 'resources[' + index + '].carrierEntity not found: ' + resource.carrierEntity);
    }
  });
  var seenPhases = {};
  var phaseCount = safeArray(ir.phases).length;
  safeArray(ir.phases).forEach(function(phase, index) {
    var expectedId = 'phase' + (index + 1);
    if (!phase || !phase.id) {
      addError(errors, 'source_ir_phase_id_missing', 'phases[' + index + '].id is required');
    } else {
      if (seenPhases[phase.id]) addError(errors, 'source_ir_phase_id_duplicate', 'duplicate phase id: ' + phase.id);
      seenPhases[phase.id] = true;
      if (phase.id !== expectedId) {
        addError(errors, 'source_ir_phase_id_not_sequential', 'phases[' + index + '].id must be ' + expectedId + ', got ' + phase.id);
      }
    }
    safeArray(phase && phase.showEntities).forEach(function(entityId) {
      if (!entityIds[entityId]) {
        addError(errors, 'source_ir_phase_show_entity_missing', 'phases[' + index + '].showEntities references missing entity: ' + entityId);
      }
    });
    safeArray(phase && phase.steps).forEach(function(step, stepIndex) {
      validateStep(step, index, phaseCount, entityIds, resourceIds, errors, 'phases[' + index + '].steps[' + stepIndex + ']');
    });
    validateGate(phase && phase.gate, index, phaseCount, entityIds, resourceIds, errors, 'phases[' + index + '].gate');
  });
  if (ir.semanticHash) {
    var expected = computeSourceSceneIrHash(ir);
    if (normalizeHash(ir.semanticHash) !== expected) {
      addError(errors, 'source_ir_semantic_hash_mismatch', 'semanticHash mismatch: expected=' + expected + ' actual=' + ir.semanticHash);
    }
  }
  return errors;
}

function validateSourceSceneIr(ir) {
  var errors = collectSourceSceneIrViolations(ir);
  if (errors.length > 0) {
    throw new Error('SourceSceneIR validation failed: ' + errors.map(function(error) {
      return error.code + ': ' + error.message;
    }).join('; '));
  }
  return true;
}

function parseEmbeddedSourceIr(html) {
  return parseTopLevelLiteral(html, '__BP_SOURCE_IR__', '{', '}');
}

function parseEmbeddedPlayableSceneIr(html) {
  return parseTopLevelLiteral(html, '__BLUEPRINT_PLAYABLE_SCENE_IR__', '{', '}');
}

function parseEmbeddedSourceIrHash(html) {
  return parseStringAssignment(html, '__BP_SOURCE_IR_HASH__');
}

function detectSourceIrPreviewRenderer(html) {
  var text = String(html || '');
  var versionMatch = text.match(/__BP_SOURCE_IR_PREVIEW_RENDERER_VERSION__\s*=\s*["']([^"']+)["']/);
  return {
    version: versionMatch ? versionMatch[1] : null,
    present: !!versionMatch,
    ownsVisuals: /__BP_SOURCE_IR_RENDERER_OWNS_VISUALS__\s*=\s*true/.test(text),
    ownsPhaseDriver: /__BP_SOURCE_IR_RENDERER_OWNS_PHASE_DRIVER__\s*=\s*true/.test(text),
    visualSourceIsSourceIr: /__BP_SOURCE_IR_VISUAL_SOURCE__\s*=\s*["']source-scene-ir["']/.test(text),
    hasDriveToSourcePhase: /__driveToSourcePhase\s*=/.test(text),
    hasDriveToPhase: /__driveToPhase\s*=/.test(text),
    hasGameState: /__gameState\s*=/.test(text),
    hasSetTip: /(?:function\s+setTip\s*\(|(?:window\.)?setTip\s*=)/.test(text),
    initializesFidelityReadyFalse: /__fidelityReady\s*=\s*false/.test(text),
  };
}

function extractSourceSceneIrFromHtml(html, sourceHtmlPath, options) {
  options = options || {};
  var sourceHash = sha256OfString(html);
  var sourcePath = sourceHtmlPath ? comparablePath(sourceHtmlPath) : null;
  var embedded = parseEmbeddedSourceIr(html);
  var declaredHash = parseEmbeddedSourceIrHash(html);
  var ir;
  if (embedded.value) {
    ir = normalizeSourceSceneIr(embedded.value, {
      sourceHtmlPath: sourcePath,
      sourceHtmlSha256: sourceHash,
      html: html,
      generatedAt: options.generatedAt,
      repairPhaseLiveness: options.repairPhaseLiveness,
    });
    ir.extraction = {
      carrier: 'window.__BP_SOURCE_IR__',
      embeddedSourceIrPresent: true,
      legacyProjectionUsed: false,
      declaredHash: declaredHash.value || null,
    };
    if (declaredHash.value && normalizeHash(declaredHash.value) !== ir.semanticHash) {
      throw new Error('SourceSceneIR hash mismatch: expected=' + ir.semanticHash + ' actual=' + declaredHash.value);
    }
    validateSourceSceneIr(ir);
    return ir;
  }

  var playable = parseEmbeddedPlayableSceneIr(html);
  if (playable.value) {
    ir = normalizeSourceSceneIr(buildSourceFromPlayableSceneIr(playable.value, {
      sourceHtmlPath: sourcePath,
      sourceHtmlSha256: sourceHash,
      html: html,
      generatedAt: options.generatedAt,
      repairPhaseLiveness: options.repairPhaseLiveness,
    }), {
      sourceHtmlPath: sourcePath,
      sourceHtmlSha256: sourceHash,
      html: html,
      generatedAt: options.generatedAt,
      repairPhaseLiveness: options.repairPhaseLiveness,
    });
    validateSourceSceneIr(ir);
    return ir;
  }

  var manifest = visualAssets.extractVisualAssetManifest(String(html || ''), {
    source: sourcePath,
    project: options.project || null,
    entityNames: visualAssets.collectEntityNamesFromHtml(html),
    generatedAt: options.generatedAt,
  });
  ir = normalizeSourceSceneIr(buildSourceFromLegacyManifest(manifest, {
    sourceHtmlPath: sourcePath,
    sourceHtmlSha256: sourceHash,
    html: html,
    project: options.project || null,
    generatedAt: options.generatedAt,
    repairPhaseLiveness: options.repairPhaseLiveness,
  }), {
    sourceHtmlPath: sourcePath,
    sourceHtmlSha256: sourceHash,
    html: html,
    generatedAt: options.generatedAt,
    repairPhaseLiveness: options.repairPhaseLiveness,
  });
  validateSourceSceneIr(ir);
  return ir;
}

function triggerProjectionFromGate(gate) {
  if (!isObject(gate)) return null;
  if (gate.kind === 'resource') {
    return { type: 'resource_collected', resource: gate.resource || null, amount: gate.threshold || 1 };
  }
  if (gate.kind === 'near_entity') {
    return { type: 'near_entity', entity: gate.entity || null, range: gate.radius || 2 };
  }
  if (gate.kind === 'entity_state') {
    return { type: 'entity_state_reached', entity: gate.entity || null, state: gate.state == null ? 1 : gate.state };
  }
  if (gate.kind === 'timer') {
    return { type: 'timer', seconds: gate.seconds || 1 };
  }
  if (gate.kind === 'cta_arrival') {
    return { type: 'near_entity', entity: gate.entity || 'CtaButton', range: gate.radius || gate.range || 2 };
  }
  if (gate.kind === 'compound_all' || gate.kind === 'compound_any') {
    return {
      type: 'compound',
      operator: gate.kind === 'compound_any' ? 'or' : 'and',
      triggers: safeArray(gate.gates).map(triggerProjectionFromGate).filter(Boolean),
    };
  }
  return clone(gate);
}

function legacyStepProjection(step, index) {
  step = step || {};
  var out = {
    index: index,
    target: step.target || step.from || step.to || step.entity || '',
    label: step.label || step.target || step.from || step.to || step.entity || '',
  };
  if (step.kind === 'collect') out.gain = step.resource || '';
  if (step.kind === 'deliver') out.spend = step.resource || '';
  if (step.kind === 'set_entity_state') out.setEntity = step.entity || '';
  if (step.kind === 'attack') out.damage = true;
  if (step.amount != null) out.amount = step.amount;
  return out;
}

function projectSourceSceneIrToLegacy(ir) {
  validateSourceSceneIr(ir);
  var entityStyle = {};
  var entityPositions = {};
  safeArray(ir.entities).forEach(function(entity) {
    entityStyle[entity.id] = {
      label: entity.label || entity.id,
      kind: entity.kind || null,
      color: entity.visual && entity.visual.color || null,
    };
    entityPositions[entity.id] = {
      x: entity.position && entity.position[0] || 0,
      y: entity.position && entity.position[1] || 0,
      z: entity.position && entity.position[2] || 0,
    };
  });
  var phases = safeArray(ir.phases).map(function(phase) {
    return {
      id: phase.id,
      name: phase.title || phase.id,
      guideText: phase.guideText || '',
      goalText: phase.goalText || '',
      showEntities: safeArray(phase.showEntities),
      trigger: triggerProjectionFromGate(phase.gate),
      steps: safeArray(phase.steps).map(legacyStepProjection),
      plannedModuleIds: safeArray(phase.plannedModuleIds),
    };
  });
  return {
    PHASES: phases,
    ENTITY_STYLE: entityStyle,
    ENTITY_POSITIONS: entityPositions,
    SCENE_CONFIG: clone(ir.scene),
  };
}

function legacyPhaseComparable(phase) {
  phase = phase || {};
  return {
    id: phase.id || '',
    name: phase.name || phase.title || phase.id || '',
    guideText: phase.guideText || '',
    goalText: phase.goalText || '',
    showEntities: safeArray(phase.showEntities).map(String),
    trigger: legacyTriggerComparable(phase.trigger || null),
    steps: safeArray(phase.steps).map(function(step, index) {
      step = step || {};
      var out = {
        index: step.index != null ? Number(step.index) : index,
        target: step.target || step.from || step.to || step.entity || '',
      };
      if (step.gain != null) out.gain = step.gain;
      if (step.spend != null) out.spend = step.spend;
      if (step.setEntity != null) out.setEntity = step.setEntity;
      if (step.damage != null) out.damage = !!step.damage;
      if (step.amount != null) out.amount = Number(step.amount);
      return out;
    }),
    plannedModuleIds: safeArray(phase.plannedModuleIds || phase.plannedModules).map(String),
  };
}

function legacyTriggerComparable(trigger) {
  if (!isObject(trigger)) return null;
  if (trigger.type === 'near_entity') {
    return {
      type: 'near_entity',
      entity: trigger.entity || trigger.target || '',
      range: toNumber(trigger.range != null ? trigger.range : trigger.distance, 2),
    };
  }
  if (trigger.type === 'resource_collected') {
    return {
      type: 'resource_collected',
      resource: trigger.resource || '',
      amount: toNumber(trigger.amount != null ? trigger.amount : trigger.threshold, 1),
    };
  }
  if (trigger.type === 'entity_state_reached') {
    return {
      type: 'entity_state_reached',
      entity: trigger.entity || '',
      state: trigger.state == null ? 1 : trigger.state,
    };
  }
  if (trigger.type === 'timer') {
    return { type: 'timer', seconds: toNumber(trigger.seconds, 1) };
  }
  if (trigger.type === 'compound') {
    return {
      type: 'compound',
      operator: trigger.operator || 'and',
      triggers: safeArray(trigger.triggers).map(legacyTriggerComparable),
    };
  }
  return stableValue(trigger);
}

function colorComparable(color) {
  if (typeof color === 'number' && Number.isFinite(color)) {
    var hex = Math.max(0, Math.min(0xffffff, Math.round(color))).toString(16).padStart(6, '0');
    return '#' + hex.toUpperCase();
  }
  var text = String(color == null ? '' : color).trim();
  return text.charAt(0) === '#' ? text.toUpperCase() : text;
}

function legacyStyleComparable(style) {
  style = style || {};
  return {
    label: style.label || null,
    kind: style.kind || null,
    color: colorComparable(style.color || null),
  };
}

function legacyPositionComparable(position) {
  position = position || {};
  return {
    x: Number(position.x != null ? position.x : position[0]) || 0,
    y: Number(position.y != null ? position.y : position[1]) || 0,
    z: Number(position.z != null ? position.z : position[2]) || 0,
  };
}

function legacyProjectionComparable(name, value, expected) {
  if (name === 'PHASES') return safeArray(value).map(legacyPhaseComparable);
  if (name === 'ENTITY_STYLE') {
    var styles = {};
    Object.keys(expected || value || {}).sort().forEach(function(key) {
      styles[key] = legacyStyleComparable(value && value[key]);
    });
    return styles;
  }
  if (name === 'ENTITY_POSITIONS') {
    var positions = {};
    Object.keys(expected || value || {}).sort().forEach(function(key) {
      positions[key] = legacyPositionComparable(value && value[key]);
    });
    return positions;
  }
  if (name === 'SCENE_CONFIG') return stableValue(normalizeScene(value));
  return stableValue(value);
}

function collectLegacyProjectionParityViolations(html, projection) {
  var checks = [
    { name: 'PHASES', open: '[', close: ']' },
    { name: 'ENTITY_STYLE', open: '{', close: '}' },
    { name: 'ENTITY_POSITIONS', open: '{', close: '}' },
    { name: 'SCENE_CONFIG', open: '{', close: '}' },
  ];
  var violations = [];
  var summary = {};
  checks.forEach(function(check) {
    var parsed = parseOptionalAssignedLiteral(html, check.name, check.open, check.close);
    summary[check.name] = {
      present: parsed.present,
      parseable: parsed.present && parsed.value != null,
      derivedFromSourceIr: parsed.derivedFromSourceIr === true,
    };
    if (!parsed.present) return;
    if (parsed.errors && parsed.errors.length) {
      violations.push({ code: 'source_ir_projection_parse_failed', carrier: check.name, message: parsed.errors.join('; ') });
      return;
    }
    if (parsed.value == null) {
      if (!parsed.derivedFromSourceIr) {
        violations.push({ code: 'source_ir_projection_not_derived', carrier: check.name, expression: parsed.expression || null });
      }
      return;
    }
    var expected = projection[check.name];
    var actualComparable = legacyProjectionComparable(check.name, parsed.value, expected);
    var expectedComparable = legacyProjectionComparable(check.name, expected, expected);
    if (stableStringify(actualComparable) !== stableStringify(expectedComparable)) {
      violations.push({
        code: 'source_ir_projection_mismatch',
        carrier: check.name,
        expectedHash: sha256OfString(stableStringify(expectedComparable)),
        actualHash: sha256OfString(stableStringify(actualComparable)),
      });
    }
  });
  return {
    passed: violations.length === 0,
    summary: summary,
    violations: violations,
  };
}

function assertSourceSceneIrBinding(ir, options) {
  options = options || {};
  validateSourceSceneIr(ir);
  var errors = [];
  var irPath = ir.source && comparablePath(ir.source.htmlPath);
  var irSha = normalizeHash(ir.source && ir.source.htmlSha256);
  if (options.sourceHtmlPath && irPath && comparablePath(options.sourceHtmlPath) !== irPath) {
    errors.push('sourceHtmlPath mismatch: expected ' + irPath + ' got ' + comparablePath(options.sourceHtmlPath));
  }
  if (options.sourceHtmlSha256 && irSha && normalizeHash(options.sourceHtmlSha256) !== irSha) {
    errors.push('sourceHtmlSha256 mismatch: expected ' + irSha + ' got ' + normalizeHash(options.sourceHtmlSha256));
  }
  if (errors.length > 0) {
    throw new Error('SourceSceneIR binding failed: ' + errors.join('; '));
  }
  return {
    sourceHtmlPath: irPath || null,
    sourceHtmlSha256: irSha || null,
    sourceSceneIrHash: ir.semanticHash,
  };
}

function writeSourceSceneIr(outPath, ir) {
  validateSourceSceneIr(ir);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(stableValue(ir), null, 2) + '\n');
  return ir;
}

function loadSourceSceneIr(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  var ir = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  validateSourceSceneIr(ir);
  return ir;
}

function preflightSourceSceneIrHtml(html, options) {
  options = options || {};
  var requireEmbeddedSourceIr = options.requireEmbeddedSourceIr !== false;
  var requireDeclaredHash = options.requireDeclaredHash !== false;
  var requireSourceIrRenderer = options.requireSourceIrRenderer === true;
  var forbidLegacyProjection = options.forbidLegacyProjection !== false;
  var sourcePath = options.sourceHtmlPath ? comparablePath(options.sourceHtmlPath) : null;
  var sourceHash = sha256OfString(html);
  var rendererDetection = detectSourceIrPreviewRenderer(html);
  var report = {
    schemaVersion: '1.0.0',
    kind: SOURCE_SCENE_IR_PREFLIGHT_KIND,
    generatedAt: options.generatedAt || new Date().toISOString(),
    sourceHtmlPath: sourcePath,
    sourceHtmlSha256: sourceHash,
    passed: false,
    summary: {
      embeddedSourceIrPresent: false,
      legacyProjectionUsed: false,
      sourceSceneIrHash: null,
      declaredHash: null,
      hashMatches: null,
      phaseCount: 0,
      entityCount: 0,
      resourceCount: 0,
      requiresJoystick: false,
      joystickEvidencePresent: false,
      sourceIrRenderer: rendererDetection,
      legacyProjection: null,
      projectionParity: null,
    },
    warnings: [],
    violations: [],
  };
  try {
    var embedded = parseEmbeddedSourceIr(html);
    var declared = parseEmbeddedSourceIrHash(html);
    report.summary.embeddedSourceIrPresent = !!embedded.value;
    report.summary.declaredHash = declared.value || null;
    var ir = extractSourceSceneIrFromHtml(html, sourcePath, options);
    var projection = projectSourceSceneIrToLegacy(ir);
    var validationErrors = collectSourceSceneIrViolations(ir);
    report.summary.legacyProjectionUsed = !!(ir.extraction && ir.extraction.legacyProjectionUsed);
    report.summary.sourceSceneIrHash = ir.semanticHash;
    report.summary.hashMatches = declared.value ? normalizeHash(declared.value) === ir.semanticHash : null;
    report.summary.phaseCount = ir.phases.length;
    report.summary.entityCount = ir.entities.length;
    report.summary.resourceCount = ir.resources.length;
    report.summary.requiresJoystick = !!(ir.runtimeContract && ir.runtimeContract.requiresJoystick);
    report.summary.joystickEvidencePresent = hasJoystickRuntimeEvidence(html);
    report.summary.legacyProjection = {
      phases: projection.PHASES.length,
      entityStyles: Object.keys(projection.ENTITY_STYLE).length,
      entityPositions: Object.keys(projection.ENTITY_POSITIONS).length,
      sceneConfig: !!projection.SCENE_CONFIG,
    };
    if (embedded.value) {
      var parity = collectLegacyProjectionParityViolations(html, projection);
      report.summary.projectionParity = parity.summary;
      parity.violations.forEach(function(violation) { report.violations.push(violation); });
    }
    if (!embedded.value) {
      var missingEmbedded = { code: 'source_ir_embedded_missing', message: 'window.__BP_SOURCE_IR__ is missing' };
      if (requireEmbeddedSourceIr) report.violations.push(missingEmbedded);
      else report.warnings.push(Object.assign({}, missingEmbedded, { message: missingEmbedded.message + '; normalized legacy HTML contracts instead' }));
    }
    if (requireDeclaredHash && !declared.value) {
      report.violations.push({ code: 'source_ir_declared_hash_missing', message: 'window.__BP_SOURCE_IR_HASH__ is missing' });
    }
    if (forbidLegacyProjection && report.summary.legacyProjectionUsed) {
      report.violations.push({ code: 'source_ir_legacy_projection_forbidden', message: 'legacy HTML projection cannot be used as SourceSceneIR in strict mode' });
    }
    if (declared.value && !report.summary.hashMatches) {
      report.violations.push({ code: 'source_ir_declared_hash_mismatch', expected: ir.semanticHash, actual: declared.value });
    }
    if (ir.runtimeContract && ir.runtimeContract.requiresJoystick && !hasJoystickRuntimeEvidence(html)) {
      report.violations.push({ code: 'source_ir_joystick_runtime_evidence_missing', message: 'requiresJoystick=true but no source HTML joystick runtime evidence was found' });
    }
    if (requireSourceIrRenderer) {
      if (!rendererDetection.present) {
        report.violations.push({ code: 'source_ir_renderer_missing', message: 'SourceIR preview renderer version marker is missing' });
      }
      if (!rendererDetection.ownsVisuals) {
        report.violations.push({ code: 'source_ir_renderer_visual_ownership_missing', message: 'SourceIR preview renderer must declare visual ownership' });
      }
      if (!rendererDetection.ownsPhaseDriver) {
        report.violations.push({ code: 'source_ir_renderer_phase_driver_ownership_missing', message: 'SourceIR preview renderer must declare phase-driver ownership' });
      }
      if (!rendererDetection.visualSourceIsSourceIr) {
        report.violations.push({ code: 'source_ir_renderer_visual_source_missing', message: 'SourceIR preview renderer must declare visual source as source-scene-ir' });
      }
      if (!rendererDetection.hasDriveToSourcePhase || !rendererDetection.hasDriveToPhase) {
        report.violations.push({ code: 'source_ir_renderer_phase_hook_missing', message: 'SourceIR preview renderer must expose __driveToSourcePhase and __driveToPhase' });
      }
      if (!rendererDetection.hasGameState || !rendererDetection.hasSetTip || !rendererDetection.initializesFidelityReadyFalse) {
        report.violations.push({ code: 'source_ir_renderer_runtime_hook_missing', message: 'SourceIR preview renderer must expose __gameState, setTip, and initialize __fidelityReady=false' });
      }
    }
    validationErrors.forEach(function(error) { report.violations.push(error); });
  } catch (err) {
    report.violations.push({ code: 'source_ir_preflight_failed', message: err.message });
  }
  report.passed = report.violations.length === 0;
  return report;
}

module.exports = {
  SOURCE_SCENE_IR_SCHEMA_VERSION: SOURCE_SCENE_IR_SCHEMA_VERSION,
  SOURCE_SCENE_IR_KIND: SOURCE_SCENE_IR_KIND,
  SOURCE_SCENE_IR_PREFLIGHT_KIND: SOURCE_SCENE_IR_PREFLIGHT_KIND,
  STEP_KINDS: STEP_KINDS,
  GATE_KINDS: GATE_KINDS,
  stableStringify: stableStringify,
  sha256OfString: sha256OfString,
  sha256OfFile: sha256OfFile,
  normalizeSourceSceneIr: normalizeSourceSceneIr,
  validateSourceSceneIr: validateSourceSceneIr,
  computeSourceSceneIrHash: computeSourceSceneIrHash,
  extractSourceSceneIrFromHtml: extractSourceSceneIrFromHtml,
  writeSourceSceneIr: writeSourceSceneIr,
  loadSourceSceneIr: loadSourceSceneIr,
  assertSourceSceneIrBinding: assertSourceSceneIrBinding,
  projectSourceSceneIrToLegacy: projectSourceSceneIrToLegacy,
  detectSourceIrPreviewRenderer: detectSourceIrPreviewRenderer,
  preflightSourceSceneIrHtml: preflightSourceSceneIrHtml,
};
