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
  if (verb === 'build') return 'facility';
  if (verb === 'upgrade') return 'tool';
  if (verb === 'attack') return 'enemy';
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
  var resources = [];

  addEntity(entityMap, { name: 'Player', label: '玩家', kind: 'player', behavior: 'joystick' });
  addEntity(entityMap, { name: 'HomeBase', label: '基地', kind: 'base' });
  addEntity(entityMap, { name: 'CtaButton', label: '立即下载', kind: 'cta' });

  var targets = ai.phases.map(function(phase, index) {
    var target = inferTarget(phase, index, total);
    if (target.id !== 'CtaButton') {
      addEntity(entityMap, { name: target.id, label: target.label, kind: target.kind });
    }
    if (target.resource) {
      resources.push({ name: target.resource, label: target.label, entity: target.id, kind: 'resource', initial: 0 });
    }
    return target;
  });

  var specs = ai.phases.map(function(phase, index) {
    var target = targets[index];
    var isFinal = index === total - 1;
    var interaction = interactionForTarget(target, phase, index, total);
    var entitiesRequired = [{ name: 'Player' }, { name: target.id, label: target.label, kind: target.kind }];
    if (!isFinal && target.id !== 'HomeBase') entitiesRequired.push({ name: 'HomeBase', label: '基地', kind: 'base' });
    return {
      phaseId: 'phase' + (index + 1),
      phaseName: phase.title || ('phase' + (index + 1)),
      requiredInteractions: [interaction],
      entitiesRequired: entitiesRequired,
      playerInstruction: [
        phase.playerAction || phase.sceneText || phase.title,
        phase.feedback,
      ].filter(Boolean).join(' '),
      guideText: phase.uiText || phase.playerAction || phase.title,
      autoModeHint: phase.sceneText || '',
      plannedModuleIds: plannedModules(target, phase, index, total),
      trigger: triggerForTarget(target, phase, index, total),
      duration: { min: 8, max: 14 },
    };
  });

  var frames = ai.phases.map(function(phase, index) {
    var target = targets[index];
    return {
      id: 'frame' + (index + 1),
      title: phase.title || ('phase' + (index + 1)),
      interaction: interactionForTarget(target, phase, index, total),
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
    resources: resources,
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
    triggerForTarget: triggerForTarget,
    plannedModules: plannedModules,
    inferThemeHint: inferThemeHint,
  },
};
