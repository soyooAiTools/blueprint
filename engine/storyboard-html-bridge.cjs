'use strict';

var storyboardAi = require('./storyboard-ai.cjs');
var storyboard2htmlContract = require('./storyboard2html-contract.cjs');

var CAMERA_MODES = { perspective: true, orthographic: true };
var GENERIC_TARGETS = {
  target: true,
  resource: true,
  reward: true,
  facility: true,
  tool: true,
  enemy: true,
  base: true,
  ctabutton: false,
};

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

function normalizeCameraMode(value) {
  var mode = stringValue(value).toLowerCase();
  if (mode === 'ortho') mode = 'orthographic';
  return CAMERA_MODES[mode] ? mode : 'perspective';
}

function cameraLabel(mode) {
  return normalizeCameraMode(mode) === 'orthographic'
    ? '正交相机（THREE.OrthographicCamera），保持俯视/等距构图，减少近大远小。'
    : '透视相机（THREE.PerspectiveCamera），保留 3D 景深和近大远小。';
}

function asciiId(value, fallback) {
  var text = stringValue(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!text) text = fallback || 'Entity';
  if (!/^[A-Za-z_]/.test(text)) text = 'Entity_' + text;
  return text.slice(0, 64);
}

function semanticId(value, fallback) {
  var text = stringValue(value)
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!text) text = fallback || 'Entity';
  if (!/^[A-Za-z_]/.test(text)) text = 'Entity_' + text;
  return text.slice(0, 64);
}

function interactionParts(value) {
  return stringValue(value).split(':').map(function(part) { return part.trim(); });
}

function isGenericTarget(value) {
  var key = asciiId(value, '').toLowerCase();
  return !key || GENERIC_TARGETS[key] === true || /^phase\d+target$/i.test(key);
}

function phaseNumber(index) {
  return String(index + 1).padStart(2, '0');
}

function verbKind(verb) {
  if (verb === 'collect') return 'resource';
  if (verb === 'deliver') return 'base';
  if (verb === 'transfer') return 'base';
  if (verb === 'build') return 'facility';
  if (verb === 'unlock') return 'facility';
  if (verb === 'upgrade') return 'tool';
  if (verb === 'attack') return 'enemy';
  if (verb === 'show') return 'beacon';
  if (verb === 'click') return 'cta';
  return 'beacon';
}

function fallbackTargetName(verb, index) {
  var n = phaseNumber(index);
  if (verb === 'collect') return 'Collectible' + n;
  if (verb === 'deliver') return 'DeliveryPoint' + n;
  if (verb === 'build') return 'Facility' + n;
  if (verb === 'upgrade') return 'UpgradeTarget' + n;
  if (verb === 'attack') return 'Enemy' + n;
  return 'Target' + n;
}

function inferTarget(phase, index, total) {
  var explicitTarget = targetFromRequiredInteractions(phase, index, total);
  if (explicitTarget) return explicitTarget;
  var parts = interactionParts(phase.canonicalInteraction);
  var verb = parts[0] || 'move_to';
  if (index === total - 1 || verb === 'click') {
    return { id: 'CtaButton', label: '立即下载', kind: 'cta', verb: 'click', resource: '' };
  }
  var rawTarget = phase.primaryTarget || parts[1] || '';
  var targetId = isGenericTarget(rawTarget) ? fallbackTargetName(verb, index) : asciiId(rawTarget, fallbackTargetName(verb, index));
  var label = stringValue(phase.title || rawTarget || targetId);
  if (label.length > 18) label = label.slice(0, 18);
  var resource = '';
  if (verb === 'collect') {
    resource = isGenericTarget(parts[1]) ? ('Resource' + phaseNumber(index)) : asciiId(parts[1], 'Resource' + phaseNumber(index));
  }
  return {
    id: targetId,
    label: label || targetId,
    kind: verbKind(verb),
    verb: verb,
    resource: resource,
  };
}

function explicitRequiredInteractions(phase) {
  return safeArray(phase && phase.requiredInteractions).map(stringValue).filter(Boolean);
}

function defaultCarrierId(resourceId) {
  var id = semanticId(resourceId, 'Resource');
  var key = id.replace(/[_-]+/g, '').toLowerCase();
  if (/scrap|junk|debris|trash|garbage|metal/.test(key)) return 'ScrapPile';
  if (/cash|coin|gold|money/.test(key)) return 'CashCounter';
  if (/wood/.test(key)) return 'WoodPile';
  if (/corn/.test(key)) return 'CornPatch';
  if (/ice/.test(key)) return 'IceChunk';
  if (/water/.test(key)) return 'WaterDrop';
  return id;
}

function semanticLabelForId(id, fallback) {
  var key = semanticId(id, '').replace(/[_-]+/g, '').toLowerCase();
  var labels = {
    metalscrap: '金属碎片',
    scrap: '碎片',
    garbage: '垃圾',
    cash: '美金',
    coin: '金币',
    gold: '金币',
    money: '钞票',
    scrappile: '太空垃圾堆',
    recyclestation: '回收站',
    cashcounter: '美金计数',
    forgeroom: '锻造间',
    drilltool: '新钻头',
    tool: '采集工具',
    crushervehicle: '粉碎车',
    hydraulicvehicle: '液压车',
    vehicle: '处理车辆',
    cabininmodule: '船舱模块',
    cabinmodule: '船舱模块',
    spacestationmodule: '完整空间站',
    newarea: '新区域',
    asteroidobstacle: '太空障碍',
    obstacle: '障碍',
    homebase: '基地',
    ctabutton: '立即下载',
  };
  return labels[key] || fallback || id;
}

function entityKindForId(id, fallbackKind) {
  var key = semanticId(id, '').replace(/[_-]+/g, '').toLowerCase();
  if (/scrappile|woodpile|cornpatch|icechunk|waterdrop/.test(key)) return 'resource';
  if (/recyclestation|homebase|counter|queue/.test(key)) return 'base';
  if (/forge|room|facility|module|area|station|cabin/.test(key)) return 'facility';
  if (/drill|tool|vehicle|crusher|hydraulic/.test(key)) return 'tool';
  if (/enemy|obstacle|asteroid|rock/.test(key)) return 'enemy';
  if (/cta|button|download|install/.test(key)) return 'cta';
  return fallbackKind || 'prop';
}

function resourceLabelForId(id) {
  return semanticLabelForId(id, id);
}

function targetFromRequiredInteractions(phase, index, total) {
  var interactions = explicitRequiredInteractions(phase);
  if (!interactions.length) return null;
  if (index === total - 1 || interactions.length === 1 && interactions.some(function(item) {
    var parts = interactionParts(item);
    return parts[0] === 'click' && /^cta/i.test(parts[1] || '');
  })) {
    return { id: 'CtaButton', label: '立即下载', kind: 'cta', verb: 'click', resource: '' };
  }
  var target = null;
  function choose(id, verb, resource, kind) {
    if (target || !id) return;
    var entityId = semanticId(id, fallbackTargetName(verb, index));
    target = {
      id: entityId,
      label: semanticLabelForId(entityId, stringValue(phase.title || id || entityId)).slice(0, 18),
      kind: kind || verbKind(verb),
      verb: verb,
      resource: resource ? semanticId(resource, 'Resource') : '',
    };
  }
  ['build', 'upgrade', 'unlock', 'deliver', 'transfer', 'combine', 'attack', 'show', 'select', 'move_to', 'collect'].forEach(function(priorityVerb) {
    if (target) return;
    interactions.forEach(function(item) {
      if (target) return;
      var parts = interactionParts(item);
      var verb = parts[0];
      if (verb !== priorityVerb) return;
      if (verb === 'deliver' || verb === 'transfer' || verb === 'combine') choose(parts[2], verb, parts[1], verbKind(verb));
      else if (verb === 'collect') choose(defaultCarrierId(parts[1]), verb, parts[1], 'resource');
      else choose(parts[1], verb, '', verbKind(verb));
    });
  });
  return target;
}

function interactionForTarget(target, phase, index, total) {
  var parts = interactionParts(phase.canonicalInteraction);
  var verb = target.verb || parts[0] || 'move_to';
  var amount = Number(parts[2] || 1) || 1;
  if (index === total - 1 || target.id === 'CtaButton') return 'click:CtaButton';
  if (verb === 'collect') return 'collect:' + (target.resource || target.id) + ':' + amount;
  if (verb === 'deliver') return 'move_to:' + target.id;
  if (verb === 'build') return 'build:' + target.id;
  if (verb === 'upgrade') return 'upgrade:' + target.id + ':' + Math.max(2, amount);
  if (verb === 'attack') return 'attack:' + target.id;
  if (verb === 'click') return 'move_to:' + target.id;
  return 'move_to:' + target.id;
}

function interactionsForPhase(phase, target, index, total) {
  var explicit = explicitRequiredInteractions(phase);
  if (index === total - 1 || target.id === 'CtaButton') return ['click:CtaButton'];
  if (explicit.length) return uniqueStrings(explicit.map(normalizeInteractionIds));
  return [normalizeInteractionIds(interactionForTarget(target, phase, index, total))];
}

function normalizeInteractionIds(item) {
  var parts = interactionParts(item);
  var verb = parts[0] || '';
  if (!verb) return '';
  if (verb === 'collect' || verb === 'produce' || verb === 'reward') {
    return [verb, semanticId(parts[1], 'Resource'), parts[2] || '1'].join(':');
  }
  if (verb === 'deliver' || verb === 'transfer' || verb === 'combine') {
    return [verb, semanticId(parts[1], 'Resource'), semanticId(parts[2], 'Target'), parts[3] || '1'].join(':');
  }
  if (verb === 'upgrade') return [verb, semanticId(parts[1], 'Target'), parts[2] || '2'].join(':');
  if (verb === 'move_to' || verb === 'click' || verb === 'build' || verb === 'attack' || verb === 'show' || verb === 'select' || verb === 'unlock') {
    return [verb, semanticId(parts[1], verb === 'click' ? 'CtaButton' : 'Target')].join(':');
  }
  if (verb === 'wait') return [verb, parts[1] || '1'].join(':');
  return item;
}

function triggerForInteractions(interactions, target, index, total) {
  if (index === total - 1 || target.id === 'CtaButton') return { type: 'near_entity', entity: 'CtaButton', range: 2 };
  var selected = safeArray(interactions).filter(function(item) {
    var parts = interactionParts(item);
    return !(parts[0] === 'click' && /^cta/i.test(parts[1] || ''));
  }).slice(-1)[0] || interactions[0] || '';
  var parts = interactionParts(selected);
  var verb = parts[0];
  if (verb === 'collect') return { type: 'resource_collected', resource: parts[1], amount: Number(parts[2] || 1) || 1 };
  if (verb === 'produce' || verb === 'reward') return { type: 'resource_collected', resource: parts[1], amount: Number(parts[2] || 1) || 1 };
  if (verb === 'deliver' || verb === 'transfer' || verb === 'combine') return { type: 'near_entity', entity: semanticId(parts[2], target.id), range: 2 };
  if (verb === 'build' || verb === 'unlock') return { type: 'entity_state_reached', entity: semanticId(parts[1], target.id), state: 2 };
  if (verb === 'upgrade') return { type: 'entity_state_reached', entity: semanticId(parts[1], target.id), state: Number(parts[2] || 2) || 2 };
  if (verb === 'attack') return { type: 'entity_state_reached', entity: semanticId(parts[1], target.id), state: 0 };
  return { type: 'near_entity', entity: target.id, range: 2 };
}

function triggerForTarget(target, phase, index, total) {
  if (index === total - 1 || target.id === 'CtaButton') return { type: 'near_entity', entity: 'CtaButton', range: 2 };
  var interaction = interactionForTarget(target, phase, index, total);
  var parts = interactionParts(interaction);
  var verb = parts[0];
  if (verb === 'collect') return { type: 'resource_collected', resource: parts[1], amount: Number(parts[2] || 1) || 1 };
  if (verb === 'build') return { type: 'entity_state_reached', entity: target.id, state: 2 };
  if (verb === 'upgrade') return { type: 'entity_state_reached', entity: target.id, state: Number(parts[2] || 2) || 2 };
  if (verb === 'attack') return { type: 'entity_state_reached', entity: target.id, state: 0 };
  return { type: 'near_entity', entity: target.id, range: 2 };
}

function plannedModulesForInteractions(interactions, target, index, total) {
  var modules = ['guide_ui', 'visual_binding', 'highlight_target'];
  if (index !== total - 1) modules.push('player_input_joystick', 'move_to_target', 'proximity_trigger');
  safeArray(interactions).forEach(function(item) {
    var verb = interactionParts(item)[0];
    if (verb === 'collect') modules.push('collect_on_near', 'inventory_wallet', 'floating_text_feedback');
    if (verb === 'produce' || verb === 'reward') modules.push('inventory_wallet', 'floating_text_feedback');
    if (verb === 'deliver' || verb === 'transfer') modules.push('deliver_to_target', 'inventory_wallet', 'floating_text_feedback');
    if (verb === 'combine') modules.push('upgrade_progress', 'inventory_wallet');
    if (verb === 'build' || verb === 'unlock') modules.push('build_progress', 'cost_gate', 'spawn_once');
    if (verb === 'upgrade') modules.push('upgrade_progress', 'cost_gate', 'visual_variant_swap');
    if (verb === 'attack') modules.push('target_acquire', 'damageable', 'apply_damage');
    if (verb === 'click') modules.push('player_input_joystick', 'move_to_target', 'proximity_trigger', 'cta_finish');
    if (verb === 'show') modules.push('spawn_once');
  });
  if (index === total - 1 || target.id === 'CtaButton') modules.push('cta_finish');
  return uniqueStrings(modules);
}

function plannedModules(target, phase, index, total) {
  var modules = ['guide_ui', 'visual_binding', 'highlight_target'];
  if (index !== total - 1) modules.push('player_input_joystick', 'move_to_target', 'proximity_trigger');
  if (target.verb === 'collect') modules.push('collect_on_near', 'inventory_wallet', 'floating_text_feedback');
  if (target.verb === 'deliver') modules.push('deliver_to_target', 'inventory_wallet', 'floating_text_feedback');
  if (target.verb === 'build') modules.push('build_progress', 'cost_gate', 'spawn_once');
  if (target.verb === 'upgrade') modules.push('upgrade_progress', 'cost_gate', 'visual_variant_swap');
  if (target.verb === 'attack') modules.push('target_acquire', 'damageable', 'apply_damage');
  if (index === total - 1 || target.id === 'CtaButton') modules.push('player_input_joystick', 'move_to_target', 'proximity_trigger', 'cta_finish');
  return uniqueStrings(modules);
}

function entityTemplate(kind) {
  if (kind === 'player') return 'PlayerController';
  if (kind === 'resource') return 'Collectible';
  if (kind === 'facility') return 'BuildableFacility';
  if (kind === 'tool') return 'UpgradeTarget';
  if (kind === 'enemy') return 'Enemy';
  if (kind === 'base') return 'Base';
  if (kind === 'cta') return 'CtaButton';
  return 'TargetBeacon';
}

function colorForKind(kind) {
  if (kind === 'player') return '#66ccff';
  if (kind === 'resource') return '#ffd34d';
  if (kind === 'facility') return '#5db7ff';
  if (kind === 'tool') return '#a78bfa';
  if (kind === 'enemy') return '#e85d75';
  if (kind === 'base') return '#34d399';
  if (kind === 'cta') return '#25d67b';
  return '#8deaff';
}

function addEntity(map, entity) {
  if (!entity || !entity.name || map[entity.name]) return;
  map[entity.name] = {
    name: entity.name,
    label: entity.label || entity.name,
    kind: entity.kind || 'prop',
    template: entity.template || entityTemplate(entity.kind),
    visual: {
      kind: entity.kind || 'prop',
      color: entity.color || colorForKind(entity.kind || 'prop'),
    },
    behavior: entity.behavior || null,
  };
}

function addResource(map, resource) {
  if (!resource || !resource.name || map[resource.name]) return;
  map[resource.name] = {
    name: resource.name,
    label: resource.label || resource.name,
    entity: resource.entity || resource.carrierEntity || resource.name,
    carrierEntity: resource.carrierEntity || resource.entity || resource.name,
    kind: resource.kind || 'resource',
    initial: Number(resource.initial || 0) || 0,
  };
}

function addInteractionCatalogEntries(entityMap, resourceMap, interactions, target) {
  safeArray(interactions).forEach(function(item) {
    var parts = interactionParts(item);
    var verb = parts[0];
    var resourceId = '';
    var entityId = '';
    if (verb === 'collect' || verb === 'produce' || verb === 'reward') resourceId = parts[1];
    if (verb === 'deliver' || verb === 'transfer' || verb === 'combine') {
      resourceId = parts[1];
      entityId = parts[2];
    } else if (['move_to', 'click', 'build', 'upgrade', 'attack', 'show', 'select', 'unlock'].indexOf(verb) >= 0) {
      entityId = parts[1];
    }
    if (resourceId) {
      var resourceName = semanticId(resourceId, 'Resource');
      var carrier = target && target.resource === resourceName && target.kind === 'resource'
        ? target.id
        : defaultCarrierId(resourceName);
      addEntity(entityMap, {
        name: carrier,
        label: semanticLabelForId(carrier, resourceLabelForId(resourceName)),
        kind: entityKindForId(carrier, 'resource'),
      });
      addResource(resourceMap, {
        name: resourceName,
        label: resourceLabelForId(resourceName),
        carrierEntity: carrier,
        entity: carrier,
      });
    }
    if (entityId) {
      var entityName = semanticId(entityId, 'Target');
      addEntity(entityMap, {
        name: entityName,
        label: semanticLabelForId(entityName, entityName),
        kind: entityKindForId(entityName, verbKind(verb)),
      });
    }
  });
}

function inferThemeHint(storyboard) {
  var text = JSON.stringify({
    name: storyboard && storyboard.project && storyboard.project.name,
    loop: storyboard && storyboard.project && storyboard.project.coreLoop,
    phases: safeArray(storyboard && storyboard.phases).map(function(phase) {
      return [phase.title, phase.sceneText, phase.playerAction, phase.feedback].join(' ');
    }),
  });
  if (/太空|宇航|飞船|星球|space|ship|astronaut/i.test(text)) return 'space';
  if (/农场|农田|玉米|小麦|farm|crop|corn|harvest/i.test(text)) return 'farming';
  if (/塔防|炮塔|防守|turret|tower|defense/i.test(text)) return 'tower-defense';
  return 'default';
}

function buildBlueprintFromStoryboardAi(input, options) {
  options = options || {};
  var ai = input && input.kind === storyboardAi.STORYBOARD_AI_KIND
    ? input
    : storyboardAi.normalizeStoryboardAi(input || {}, options);
  storyboardAi.assertStoryboardAi(ai);

  var total = ai.phases.length;
  var cameraMode = normalizeCameraMode(options.cameraMode);
  var entityMap = {};
  var resourceMap = {};

  addEntity(entityMap, { name: 'Player', label: '玩家', kind: 'player', behavior: 'joystick' });
  addEntity(entityMap, { name: 'HomeBase', label: '基地', kind: 'base' });
  addEntity(entityMap, { name: 'CtaButton', label: '立即下载', kind: 'cta' });

  var phasePlans = ai.phases.map(function(phase, index) {
    var target = inferTarget(phase, index, total);
    var interactions = interactionsForPhase(phase, target, index, total);
    if (target.id !== 'CtaButton') {
      addEntity(entityMap, { name: target.id, label: target.label, kind: target.kind });
    }
    if (target.resource && target.kind === 'resource') {
      addResource(resourceMap, { name: target.resource, label: resourceLabelForId(target.resource) || target.label, entity: target.id, carrierEntity: target.id, kind: 'resource', initial: 0 });
    }
    addInteractionCatalogEntries(entityMap, resourceMap, interactions, target);
    return { target: target, interactions: interactions };
  });

  var specs = ai.phases.map(function(phase, index) {
    var plan = phasePlans[index];
    var target = plan.target;
    var interactions = plan.interactions;
    var isFinal = index === total - 1;
    var entitiesRequired = [{ name: 'Player' }, { name: target.id, label: target.label, kind: target.kind }];
    if (!isFinal && target.id !== 'HomeBase') entitiesRequired.push({ name: 'HomeBase', label: '基地', kind: 'base' });
    return {
      phaseId: 'phase' + (index + 1),
      phaseName: phase.title || ('phase' + (index + 1)),
      requiredInteractions: interactions,
      entitiesRequired: entitiesRequired,
      playerInstruction: [
        phase.playerAction || phase.sceneText || phase.title,
        phase.feedback,
      ].filter(Boolean).join(' '),
      guideText: phase.uiText || phase.playerAction || phase.title,
      autoModeHint: phase.sceneText || '',
      plannedModuleIds: plannedModulesForInteractions(interactions, target, index, total),
      trigger: triggerForInteractions(interactions, target, index, total),
      duration: { min: 8, max: 14 },
    };
  });

  var frames = ai.phases.map(function(phase, index) {
    var plan = phasePlans[index];
    return {
      id: 'frame' + (index + 1),
      title: phase.title || ('phase' + (index + 1)),
      interaction: plan.interactions[0] || '',
      ui: phase.uiText || phase.playerAction || '',
      camera: cameraLabel(cameraMode),
      note: [
        phase.sceneText,
        phase.feedback,
        phase.visualPrompt ? ('visualPrompt=' + phase.visualPrompt) : '',
      ].filter(Boolean).join(' '),
      image: phase.image || '',
    };
  });

  return {
    projectName: options.projectName || ai.project && ai.project.name || 'AI试玩HTML',
    themeHint: options.themeHint || inferThemeHint(ai),
    cameraMode: cameraMode,
    storyboard: { frames: frames },
    storyboardFrames: frames,
    specs: specs,
    entities: Object.keys(entityMap).map(function(name) { return entityMap[name]; }),
    resources: Object.keys(resourceMap).map(function(name) { return resourceMap[name]; }),
    sourceStoryboardHash: ai.semanticHash || '',
  };
}

function buildStoryboard2HtmlInputFromStoryboardAi(input, options) {
  options = options || {};
  var blueprint = buildBlueprintFromStoryboardAi(input, options);
  var bundle = storyboard2htmlContract.buildStoryboard2HtmlInput(blueprint, {
    projectName: blueprint.projectName,
    themeHint: blueprint.themeHint,
    steps: options.steps,
    htmlPath: options.htmlPath,
    outDir: options.outDir,
    smokeMode: options.smokeMode,
    requireSourceIrRenderer: options.requireSourceIrRenderer,
    visualDiff: options.visualDiff,
    visualPhases: options.visualPhases,
  });
  bundle.cameraMode = blueprint.cameraMode;
  bundle.sourceStoryboardHash = blueprint.sourceStoryboardHash;
  return bundle;
}

module.exports = {
  normalizeCameraMode: normalizeCameraMode,
  cameraLabel: cameraLabel,
  buildBlueprintFromStoryboardAi: buildBlueprintFromStoryboardAi,
  buildStoryboard2HtmlInputFromStoryboardAi: buildStoryboard2HtmlInputFromStoryboardAi,
  _internals: {
    asciiId: asciiId,
    inferTarget: inferTarget,
    interactionForTarget: interactionForTarget,
    interactionsForPhase: interactionsForPhase,
    triggerForTarget: triggerForTarget,
    triggerForInteractions: triggerForInteractions,
    plannedModules: plannedModules,
    plannedModulesForInteractions: plannedModulesForInteractions,
    inferThemeHint: inferThemeHint,
  },
};
