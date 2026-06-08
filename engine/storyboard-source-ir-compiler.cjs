'use strict';

var sourceSceneIr = require('./source-scene-ir.cjs');
var storyboardIrMod = require('./storyboard-ir.cjs');
var storyboardSpecCompiler = require('./storyboard-spec-compiler.cjs');

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function stringValue(value) {
  return value == null ? '' : String(value).trim();
}

function uniqueStrings(values) {
  var seen = {};
  var out = [];
  safeArray(values).forEach(function(value) {
    var text = stringValue(value);
    if (!text || seen[text]) return;
    seen[text] = true;
    out.push(text);
  });
  return out;
}

function isCtaId(value) {
  return /cta|install|download|下载|安装|按钮/i.test(stringValue(value));
}

function isPlayerId(value, entity) {
  var id = stringValue(value);
  var label = stringValue(entity && (entity.label || entity.chineseName || entity.name));
  var kind = stringValue(entity && (entity.kind || entity.type || entity.template));
  var compactId = id.replace(/[\s_-]+/g, '').toLowerCase();
  var compactKind = kind.replace(/[\s_-]+/g, '').toLowerCase();
  if (/^(player|playerrobot|playerchar|mainplayer|maincharacter|mainchar|protagonist|avatar|hero|mainhero)$/.test(compactId)) return true;
  if (/^(player|playercontroller|playercharacter|hero|mainhero|avatar)$/.test(compactKind)) return true;
  if (/^(玩家|主角|角色|主人公)$/.test(label)) return true;
  if (/(玩家|主角|可控角色)/.test(label) && !/(塔|炮塔|基地|按钮|敌|怪|建筑)/.test(label)) return true;
  return /(^|[\s_-])player($|[\s_-])/i.test(id);
}

function roundCoord(value) {
  return Number((Number(value) || 0).toFixed(2));
}

function layoutPositionForEntity(entity, ordinal, kind) {
  if (isPlayerId(entity && entity.id, entity) || kind === 'player') return [0, 0, 0];
  if (isCtaId(entity && entity.id) || kind === 'cta') return [15, 0, -12];
  var slotsPerRing = 8;
  var ring = Math.floor(Math.max(0, ordinal) / slotsPerRing);
  var slot = Math.max(0, ordinal) % slotsPerRing;
  var angle = (-Math.PI * 0.72) + (slot * Math.PI * 2 / slotsPerRing) + (ring * 0.27);
  var radius = 6.8 + ring * 3.0 + (slot % 2) * 0.65;
  return [roundCoord(Math.cos(angle) * radius), 0, roundCoord(Math.sin(angle) * radius)];
}

function entityLayoutBounds(entities) {
  var bounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0, maxAbs: 0 };
  safeArray(entities).forEach(function(entity) {
    var p = safeArray(entity && entity.position);
    var x = Number(p[0]) || 0;
    var z = Number(p[2]) || 0;
    bounds.minX = Math.min(bounds.minX, x);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.minZ = Math.min(bounds.minZ, z);
    bounds.maxZ = Math.max(bounds.maxZ, z);
    bounds.maxAbs = Math.max(bounds.maxAbs, Math.abs(x), Math.abs(z));
  });
  bounds.width = bounds.maxX - bounds.minX;
  bounds.depth = bounds.maxZ - bounds.minZ;
  return bounds;
}

function sceneLayoutForEntities(entities) {
  var bounds = entityLayoutBounds(entities);
  var needed = Math.max(bounds.width + 10, bounds.depth + 10, (bounds.maxAbs + 6) * 2, 42);
  var mapSize = Math.min(72, Math.ceil(needed / 2) * 2);
  return {
    mapSize: mapSize,
    camera: {
      position: [0, roundCoord(Math.max(16, mapSize * 0.42)), roundCoord(Math.max(24, mapSize * 0.58))],
      lookAt: [0, 0, 0],
      fov: 58,
    },
    bounds: bounds,
  };
}

function normalizeEntityId(value, fallback) {
  var text = stringValue(value || fallback).replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '');
  if (!text) text = fallback || 'Entity';
  if (!/^[A-Za-z_]/.test(text)) text = 'Entity_' + text;
  return text;
}

function splitInteraction(value) {
  return stringValue(value).split(':').map(function(part) { return part.trim(); });
}

function collectRequiredEntityRefs(specs) {
  var refs = [];
  safeArray(specs).forEach(function(spec) {
    safeArray(spec && spec.entitiesRequired).forEach(function(entity) {
      refs.push(typeof entity === 'string' ? entity : entity && entity.name);
    });
    safeArray(spec && spec.requiredInteractions).forEach(function(item) {
      var parts = splitInteraction(item);
      var verb = parts[0];
      if (['move_to', 'click', 'build', 'upgrade', 'attack'].indexOf(verb) >= 0) refs.push(parts[1]);
    });
  });
  return uniqueStrings(refs);
}

function resourceAliasWords(resourceId) {
  var text = stringValue(resourceId).toLowerCase();
  var aliases = [text];
  if (/scrap|junk|debris|trash|garbage/.test(text)) aliases = aliases.concat(['scrap', 'junk', 'debris', 'trash', 'garbage', 'metal', 'spacejunk', '垃圾', '金属', '碎块']);
  if (/ice/.test(text)) aliases = aliases.concat(['ice', 'crystal', 'icechunk', '冰晶', '冰']);
  if (/water/.test(text)) aliases = aliases.concat(['water', 'bucket', 'bottle', '水', '水桶', '桶装水']);
  if (/apple/.test(text)) aliases = aliases.concat(['apple', '苹果']);
  if (/corn/.test(text)) aliases = aliases.concat(['corn', 'field', '玉米', '玉米地']);
  if (/coin|gold|money/.test(text)) aliases = aliases.concat(['coin', 'gold', 'money', '金币', '美金']);
  return uniqueStrings(aliases);
}

function inferResourceCarrierEntity(resourceId, entities) {
  var aliases = resourceAliasWords(resourceId);
  var best = null;
  function scoreEntity(entity, index) {
    if (!entity) return 0;
    var id = stringValue(entity.id || entity.name);
    if (!id || isCtaId(id) || isPlayerId(id, entity)) return 0;
    var hay = [
      id,
      entity.label,
      entity.chineseName,
      entity.kind,
      entity.type,
      entity.template,
    ].map(stringValue).join(' ').toLowerCase();
    var score = 100 - index;
    aliases.forEach(function(alias) {
      var key = stringValue(alias).toLowerCase();
      if (!key) return;
      if (hay === key || id.toLowerCase() === key) score += 1000;
      else if (hay.indexOf(key) >= 0 || key.indexOf(id.toLowerCase()) >= 0) score += 500;
    });
    if (/collect|resource|pickup|loot|drop/.test(hay)) score += 250;
    if (/build|upgrade|workshop|room|cabin|station|button|ui/.test(hay)) score -= 180;
    return score;
  }
  safeArray(entities).forEach(function(entity, index) {
    var score = scoreEntity(entity, index);
    if (score <= 0 || best && best.score >= score) return;
    best = { entity: entity, score: score };
  });
  return best && best.score >= 300 ? normalizeEntityId(best.entity.id || best.entity.name, '') : '';
}

function collectResourceSpecs(input, specs) {
  var resources = [];
  safeArray(input.resources).forEach(function(resource) {
    if (typeof resource === 'string') resources.push({ id: resource, label: resource, carrierEntity: inferResourceCarrierEntity(resource, input.entities) || normalizeEntityId(resource, 'Resource') });
    else if (resource) resources.push({
      id: resource.id || resource.name,
      label: resource.label || resource.name || resource.id,
      carrierEntity: resource.carrierEntity || resource.entity || inferResourceCarrierEntity(resource.id || resource.name, input.entities) || normalizeEntityId(resource.id || resource.name, 'Resource'),
      kind: resource.kind || 'resource',
      initial: resource.initial || 0,
    });
  });
  safeArray(specs).forEach(function(spec) {
    safeArray(spec.requiredInteractions).forEach(function(item) {
      var parts = splitInteraction(item);
      if (parts[0] !== 'collect' || !parts[1]) return;
      resources.push({ id: parts[1], label: parts[1], carrierEntity: inferResourceCarrierEntity(parts[1], input.entities) || normalizeEntityId(parts[1], 'Resource'), kind: 'resource', initial: 0 });
    });
    safeArray(spec.entitiesRequired).forEach(function(entity) {
      if (entity && entity.resource) {
        resources.push({ id: entity.resource, label: entity.resource, carrierEntity: entity.name || null, kind: 'resource', initial: 0 });
      }
    });
  });
  var seen = {};
  return resources.filter(function(resource) {
    resource.id = normalizeEntityId(resource.id, 'Resource');
    if (resource.carrierEntity) resource.carrierEntity = normalizeEntityId(resource.carrierEntity, resource.id);
    if (!resource.id || seen[resource.id]) return false;
    seen[resource.id] = true;
    return true;
  });
}

function compileEntities(input, specs, resources) {
  var base = [];
  safeArray(input.entities).forEach(function(entity) {
    if (!entity) return;
    var id = normalizeEntityId(entity.id || entity.name, 'Entity' + (base.length + 1));
    base.push({
      id: id,
      label: entity.label || entity.chineseName || entity.name || id,
      kind: entity.kind || entity.type || null,
      visual: entity.visual || null,
      template: entity.template || '',
    });
  });
  collectRequiredEntityRefs(specs).forEach(function(ref) {
    if (!ref) return;
    var id = normalizeEntityId(ref, 'Entity' + (base.length + 1));
    if (!base.some(function(entity) { return entity.id === id; })) {
      base.push({ id: id, label: ref, kind: null, visual: null, template: '' });
    }
  });
  safeArray(resources).forEach(function(resource) {
    if (!resource || !resource.carrierEntity) return;
    var id = normalizeEntityId(resource.carrierEntity, resource.id || 'Resource');
    if (!base.some(function(entity) { return entity.id === id; })) {
      base.push({
        id: id,
        label: resource.label || resource.id || id,
        kind: 'resource',
        visual: { primitive: 'box', color: '#ffd34d' },
        template: 'Collectible',
      });
    }
  });
  if (!base.some(function(entity) { return isPlayerId(entity.id, entity); })) {
    base.unshift({ id: 'Player', label: 'Player', kind: 'player', visual: { primitive: 'capsule', color: '#66ccff' }, template: 'PlayerController' });
  }
  if (!base.some(function(entity) { return isCtaId(entity.id); })) {
    base.push({ id: 'CtaButton', label: 'Install', kind: 'cta', visual: { primitive: 'box', color: '#25d67b' }, template: 'UI' });
  }
  var resourceCarriers = {};
  safeArray(resources).forEach(function(resource) {
    if (resource.carrierEntity) resourceCarriers[resource.carrierEntity] = true;
  });
  var layoutOrdinal = 0;
  var positioned = base.map(function(entity) {
    var kind = entity.kind;
    if (!kind) {
      if (isPlayerId(entity.id, entity)) kind = 'player';
      else if (isCtaId(entity.id)) kind = 'cta';
      else if (resourceCarriers[entity.id] || /resource|coin|gem|gold|wood|corn|ice|水|金币|木|玉米/.test(entity.id + ' ' + entity.label)) kind = 'resource';
      else if (/enemy|monster|怪|敌/.test(entity.id + ' ' + entity.label)) kind = 'enemy';
      else kind = 'prop';
    }
    var isAnchored = isPlayerId(entity.id, entity) || isCtaId(entity.id);
    var position = layoutPositionForEntity(entity, layoutOrdinal, kind);
    if (!isAnchored) layoutOrdinal += 1;
    var fallbackVisual = { primitive: kind === 'resource' ? 'sphere' : (kind === 'player' ? 'capsule' : 'box'), color: kind === 'enemy' ? '#e85d75' : (kind === 'resource' ? '#ffd34d' : '#5db7ff') };
    return {
      id: entity.id,
      label: entity.label || entity.id,
      kind: kind,
      position: position,
      visual: entity.visual || fallbackVisual,
    };
  });
  return positioned;
}

function interactionSteps(item, resources, isFinal) {
  var parts = splitInteraction(item);
  var verb = parts[0] || '';
  var target = normalizeEntityId(parts[1], '');
  var amount = Number(parts[2] || 1) || 1;
  var resourceSpec = resources.filter(function(r) { return r.id === target; })[0] || null;
  var resource = resourceSpec ? target : '';
  if (verb === 'move_to' && target) return [{ kind: 'move_to', target: target, radius: 1.6 }];
  if (verb === 'click' && target) {
    if (isFinal) return [{ kind: 'cta_finish', ctaId: isCtaId(target) ? target : 'CtaButton' }];
    if (isCtaId(target)) return [{ kind: 'wait', seconds: 1 }];
    return [{ kind: 'move_to', target: target, radius: 1.6 }];
  }
  if (verb === 'collect' && target) {
    var carrier = resourceSpec && resourceSpec.carrierEntity || '';
    return carrier
      ? [{ kind: 'move_to', target: carrier, radius: 1.6 }, { kind: 'collect', resource: target, amount: amount, target: carrier, from: carrier }]
      : [{ kind: 'collect', resource: target, amount: amount }];
  }
  if (verb === 'build' && target) return [{ kind: 'move_to', target: target, radius: 1.8 }, { kind: 'build', entity: target, state: 2 }];
  if (verb === 'upgrade' && target) return [{ kind: 'move_to', target: target, radius: 1.8 }, { kind: 'upgrade', entity: target, level: amount }];
  if (verb === 'attack' && target) return [{ kind: 'move_to', target: target, radius: 2.2 }, { kind: 'attack', target: target, state: 0 }];
  if (verb === 'wait') return [{ kind: 'wait', seconds: amount }];
  return [];
}

function stepRefs(step) {
  if (!step || step.kind === 'cta_finish') return [];
  return [step.target, step.from, step.to, step.entity].filter(Boolean);
}

function gateFromSpec(spec, steps, resources, isFinal) {
  var interactions = safeArray(spec.requiredInteractions);
  var nonCtaInteractions = interactions.filter(function(item) {
    var parts = splitInteraction(item);
    return !(parts[0] === 'click' && isCtaId(parts[1]));
  });
  var lastInteraction = (isFinal ? interactions : nonCtaInteractions).slice(-1)[0] || '';
  var parts = splitInteraction(lastInteraction);
  var verb = parts[0] || '';
  var target = normalizeEntityId(parts[1], '');
  var amount = Number(parts[2] || 1) || 1;
  if (isFinal) return { kind: 'cta_arrival', ctaId: target && isCtaId(target) ? target : 'CtaButton' };
  if (verb === 'collect' && target) return { kind: 'resource', resource: target, threshold: amount };
  if ((verb === 'build' || verb === 'upgrade') && target) return { kind: 'entity_state', entity: target, state: verb === 'upgrade' ? amount : 2 };
  if (verb === 'attack' && target) return { kind: 'entity_state', entity: target, state: 0 };
  var move = safeArray(steps).filter(function(step) { return step.target || step.entity; })[0];
  if (move) return { kind: 'near_entity', entity: move.target || move.entity, radius: move.radius || 1.8 };
  return { kind: 'timer', seconds: 1 };
}

function moduleHintsForSpec(spec, isFinal) {
  var modules = ['guide_ui', 'visual_binding'];
  safeArray(spec.requiredInteractions).forEach(function(item) {
    var verb = splitInteraction(item)[0];
    if (['move_to', 'collect', 'build', 'upgrade', 'attack'].indexOf(verb) >= 0) {
      modules.push('player_input_joystick', 'move_to_target', 'proximity_trigger');
    }
    if (verb === 'collect') modules.push('collect_on_near', 'inventory_wallet');
    if (verb === 'build') modules.push('build_progress');
    if (verb === 'upgrade') modules.push('upgrade_progress');
    if (verb === 'attack') modules.push('target_acquire', 'damageable', 'apply_damage');
    if (verb === 'click') modules.push(isFinal ? 'cta_finish' : 'player_input_tap');
  });
  if (isFinal) modules.push('cta_finish');
  return uniqueStrings(modules);
}

function compilePhases(specs, resources) {
  return safeArray(specs).map(function(spec, index) {
    var isFinal = index === specs.length - 1;
    var steps = [];
    safeArray(spec.requiredInteractions).forEach(function(item) {
      steps = steps.concat(interactionSteps(item, resources, isFinal));
    });
    if (!steps.length) steps = [{ kind: 'wait', seconds: 1 }];
    var refs = ['Player'];
    refs = refs.concat(safeArray(spec.visibleEntities));
    refs = refs.concat(safeArray(spec.phaseEntities));
    steps.forEach(function(step) {
      refs = refs.concat(stepRefs(step));
      if (step.kind === 'collect') {
        var carrier = resources.filter(function(resource) { return resource.id === step.resource; })[0];
        if (carrier && carrier.carrierEntity) {
          step.from = carrier.carrierEntity;
          refs.push(carrier.carrierEntity);
        }
      }
    });
    if (isFinal) refs.push('CtaButton');
    return {
      id: spec.phaseId || ('phase' + (index + 1)),
      title: spec.phaseName || spec.title || ('phase' + (index + 1)),
      guideText: spec.playerInstruction || spec.guideText || spec.autoModeHint || spec.phaseName || '',
      showEntities: uniqueStrings(refs),
      plannedModuleIds: moduleHintsForSpec(spec, isFinal),
      steps: steps,
      gate: gateFromSpec(spec, steps, resources, isFinal),
      duration: spec.duration || { min: 10, max: 15 },
    };
  });
}

function compileSourceSceneIrFromStoryboard(input, options) {
  options = options || {};
  input = input || {};
  var ir = input.storyboardIr && input.storyboardIr.kind === 'blueprint.storyboardIr'
    ? input.storyboardIr
    : storyboardIrMod.normalizeStoryboardIr(input, {
      projectName: input.projectName || options.projectName,
      theme: input.themeHint || options.theme,
      entities: input.entities,
    });
  var specs = safeArray(input.specs);
  if (specs.length === 0) {
    var compiledSpecs = storyboardSpecCompiler.compileSpecsFromStoryboardIr(ir, {
      projectName: input.projectName || options.projectName,
      entities: input.entities,
      minActionCoverage: 0,
    });
    specs = compiledSpecs.specs;
  }
  var resources = collectResourceSpecs(input, specs);
  var entities = compileEntities(input, specs, resources);
  var layout = sceneLayoutForEntities(entities);
  var phases = compilePhases(specs, resources);
  var raw = {
    schemaVersion: sourceSceneIr.SOURCE_SCENE_IR_SCHEMA_VERSION,
    kind: 'blueprint.sourceSceneIR',
    project: { name: input.projectName || options.projectName || ir.project && ir.project.name || 'storyboard2html', theme: input.themeHint || options.theme || ir.project && ir.project.theme || 'default' },
    scene: {
      backgroundColor: input.themeHint === 'farming' ? '#16351f' : '#101820',
      camera: layout.camera,
      ground: { kind: 'plane', size: [layout.mapSize, layout.mapSize], width: layout.mapSize, height: layout.mapSize, color: input.themeHint === 'farming' ? '#315c2d' : '#203040' },
    },
    entities: entities,
    resources: resources,
    phases: phases,
    hud: { tip: { source: 'phase.guideText' }, resourceBar: resources.map(function(resource) { return resource.id; }), cta: { entity: 'CtaButton', arrivalGated: true } },
    runtimeContract: { requiresJoystick: phases.length > 1, requiresArrivalGate: phases.length > 1, forbidAutoplayProgress: true },
  };
  return sourceSceneIr.normalizeSourceSceneIr(raw, {
    generatedAt: options.generatedAt,
    sourceHtmlPath: options.sourceHtmlPath,
    html: '<div id="joystick"></div>',
  });
}

module.exports = {
  compileSourceSceneIrFromStoryboard: compileSourceSceneIrFromStoryboard,
  _internals: {
    compileEntities: compileEntities,
    collectResourceSpecs: collectResourceSpecs,
    compilePhases: compilePhases,
    sceneLayoutForEntities: sceneLayoutForEntities,
  },
};
