var fs = require('fs');
var path = require('path');

var { loadAssemblyRegistry, buildPhaseEvidenceSchema } = require('./schema/load-assembly-registry.cjs');
var { validateAssemblyPlans } = require('./schema/validate-assembly-plans.cjs');

var INTERACTION_VERBS_PATH = path.join(__dirname, '..', 'worker', 'interaction-verbs.json');
var _cachedVerbSpec = null;

var TEMPLATE_TO_ARCHETYPE = {
  Buildable: 'buildable_station',
  Collectible: 'collectible_pickup',
  Shooter: 'tap_shooter',
  Upgradeable: 'upgradeable_building'
};

var TEMPLATE_TO_MODULES = {
  Static: ['visual_binding'],
  PlayerController: ['visual_binding', 'player_input_joystick'],
  Mover: ['visual_binding', 'move_to_target'],
  Spawner: ['spawn_interval'],
  Draggable: ['visual_binding', 'drag_trigger'],
  Damageable: ['visual_binding', 'damageable'],
  Projectile: ['visual_binding', 'projectile_emit'],
  UI: ['guide_ui']
};

var TEMPLATE_ALIASES = {
  Clickable: ['click_trigger'],
  Buildable: ['visual_binding'],
  Collectible: ['visual_binding'],
  Shooter: ['visual_binding'],
  Upgradeable: ['visual_binding']
};

var VERB_TO_ATOM = {
  move_to: 'move_to',
  click: 'tap_target',
  drag: 'drag_to_target',
  hold: 'hold_target',
  collect: 'collect_nearby',
  deliver: 'deliver_to',
  spend: 'spend_resource',
  build: 'build_entity',
  upgrade: 'upgrade_entity',
  attack: 'attack_target',
  defeat: 'defeat_target',
  defeat_count: 'defeat_target',
  defend: 'defend_duration',
  appear: 'activate_entity',
  disappear: 'deactivate_entity',
  transform: 'set_state',
  reach: 'move_to',
  unlock: 'activate_entity',
  wait: 'defend_duration'
};

var SYSTEM_MODULES = {
  inventory_wallet: true,
  guide_ui: true,
  floating_text_feedback: true,
  score_feedback: true,
  world_label: true,
  camera_focus: true,
  camera_lift: true,
  camera_zoom: true,
  highlight_target: true,
  phase_gate_timer: true,
  cta_finish: true
};

var STATE_OWNER_PRIORITY = {
  inventory_wallet: 100,
  player_input_joystick: 95,
  player_input_tap: 90,
  move_to_target: 85,
  build_progress: 80,
  upgrade_progress: 80,
  damageable: 75,
  spawn_interval: 70,
  spawn_once: 70,
  guide_ui: 65,
  score_feedback: 65,
  floating_text_feedback: 65,
  world_label: 65,
  highlight_target: 65,
  camera_focus: 60,
  camera_lift: 60,
  camera_zoom: 60,
  form_switch: 55,
  visual_variant_swap: 50,
  visual_binding: 40,
  click_trigger: 35,
  drag_trigger: 35,
  hold_trigger: 35,
  proximity_trigger: 35,
  projectile_emit: 30,
  target_acquire: 30,
  apply_damage: 30,
  activate_targets: 25,
  on_death_drop: 25,
  cost_gate: 20,
  cooldown: 15
};

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function loadInteractionVerbs() {
  if (_cachedVerbSpec) return _cachedVerbSpec;
  _cachedVerbSpec = JSON.parse(fs.readFileSync(INTERACTION_VERBS_PATH, 'utf8'));
  return _cachedVerbSpec;
}

function stableStringify(value) {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  var keys = Object.keys(value).sort();
  var parts = [];
  for (var i = 0; i < keys.length; i++) {
    parts.push(JSON.stringify(keys[i]) + ':' + stableStringify(value[keys[i]]));
  }
  return '{' + parts.join(',') + '}';
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniq(items) {
  var out = [];
  var seen = {};
  for (var i = 0; i < items.length; i++) {
    var value = items[i];
    if (value === null || value === undefined || value === '') continue;
    var key = String(value);
    if (seen[key]) continue;
    seen[key] = true;
    out.push(value);
  }
  return out;
}

function pushUnique(arr, value) {
  if (value === null || value === undefined || value === '') return;
  if (arr.indexOf(value) >= 0) return;
  arr.push(value);
}

function normalizePhaseId(raw, fallbackIndex) {
  var text = String(raw || '').trim();
  if (!text) return 'phase_' + (fallbackIndex + 1);
  return text
    .replace(/[^\w\u4e00-\u9fa5]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
}

function asNumber(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  var num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function parseColorVariant(text) {
  var raw = String(text || '');
  if (/红/.test(raw) || /red/i.test(raw)) return 'red';
  if (/绿/.test(raw) || /green/i.test(raw)) return 'green';
  if (/蓝/.test(raw) || /blue/i.test(raw)) return 'blue';
  if (/金/.test(raw) || /gold/i.test(raw)) return 'gold';
  if (/发光|高亮|亮/.test(raw)) return 'highlight';
  return 'changed';
}

function getProjectAssemblyContext(project) {
  var bp = (project && project.blueprint) || {};
  var storyboardFrames = toArray(project.storyboardFrames).length > 0
    ? toArray(project.storyboardFrames)
    : (toArray(bp.storyboardFrames).length > 0 ? toArray(bp.storyboardFrames) : toArray(project.storyboard));
  var entities = toArray(bp.entities).length > 0 ? toArray(bp.entities) : toArray(project.entities);
  var phases = toArray(project.phases).length > 0 ? toArray(project.phases) : toArray(bp.phases);
  var specs = toArray(project.specs);

  return {
    projectName: project.name || bp.projectName || '',
    storyboardFrames: storyboardFrames,
    characterSheet: project.characterSheet || {},
    sceneSheet: project.sceneSheet || {},
    entities: entities,
    phases: phases,
    specs: specs,
    globalSettings: bp.globalSettings || project.globalSettings || {},
    blueprint: bp
  };
}

function buildRegistryIndex(registry) {
  var atomIndex = {};
  var moduleIndex = {};
  var assertionIndex = {};
  var archetypeIndex = {};
  var mappingIndex = {};
  var atomItems = (registry.storyboardAtoms && registry.storyboardAtoms.items) || [];
  var moduleItems = (registry.runtimeModules && registry.runtimeModules.items) || [];
  var assertionItems = (registry.cuaAssertions && registry.cuaAssertions.items) || [];
  var archetypes = (registry.runtimeModules && registry.runtimeModules.archetypes) || [];
  var mappings = (registry.mappings && registry.mappings.items) || [];

  for (var i = 0; i < atomItems.length; i++) atomIndex[atomItems[i].id] = atomItems[i];
  for (var j = 0; j < moduleItems.length; j++) moduleIndex[moduleItems[j].id] = moduleItems[j];
  for (var k = 0; k < assertionItems.length; k++) assertionIndex[assertionItems[k].id] = assertionItems[k];
  for (var a = 0; a < archetypes.length; a++) archetypeIndex[archetypes[a].id] = archetypes[a];
  for (var m = 0; m < mappings.length; m++) mappingIndex[mappings[m].atomId] = mappings[m];

  return {
    atomIndex: atomIndex,
    moduleIndex: moduleIndex,
    assertionIndex: assertionIndex,
    archetypeIndex: archetypeIndex,
    mappingIndex: mappingIndex
  };
}

function buildEntityLookup(entities) {
  var exact = {};
  var candidates = [];
  for (var i = 0; i < entities.length; i++) {
    var entity = entities[i] || {};
    if (!entity.name) continue;
    candidates.push(entity);
    exact[String(entity.name).toLowerCase()] = entity.name;
    if (entity.label) exact[String(entity.label).toLowerCase()] = entity.name;
    if (entity.showLabel) exact[String(entity.showLabel).toLowerCase()] = entity.name;
    if (entity.chineseName) exact[String(entity.chineseName).toLowerCase()] = entity.name;
  }
  return { exact: exact, candidates: candidates };
}

function resolveEntityName(raw, lookup) {
  var text = String(raw || '').trim();
  if (!text) return '';
  var key = text.toLowerCase();
  if (lookup.exact[key]) return lookup.exact[key];

  var matches = [];
  for (var i = 0; i < lookup.candidates.length; i++) {
    var entity = lookup.candidates[i];
    var names = [
      String(entity.name || '').toLowerCase(),
      String(entity.label || '').toLowerCase(),
      String(entity.showLabel || '').toLowerCase(),
      String(entity.chineseName || '').toLowerCase()
    ];
    for (var j = 0; j < names.length; j++) {
      var name = names[j];
      if (!name) continue;
      if (name.indexOf(key) >= 0 || key.indexOf(name) >= 0) {
        matches.push(entity.name);
        break;
      }
    }
  }
  matches = uniq(matches);
  return matches.length === 1 ? matches[0] : text;
}

function findPlayerEntityName(entities) {
  for (var i = 0; i < entities.length; i++) {
    var template = String(entities[i].template || '');
    if (template.indexOf('PlayerController') >= 0) return entities[i].name;
  }
  for (var j = 0; j < entities.length; j++) {
    if (/player/i.test(String(entities[j].name || ''))) return entities[j].name;
  }
  return 'Player';
}

function findPhaseIdForIndex(ctx, index) {
  if (ctx.specs[index]) return normalizePhaseId(ctx.specs[index].phaseId || ctx.specs[index].name, index);
  if (ctx.phases[index]) return normalizePhaseId(ctx.phases[index].name || ctx.phases[index].id, index);
  if (ctx.storyboardFrames[index]) {
    var frame = ctx.storyboardFrames[index];
    return normalizePhaseId(frame.phaseId || frame.title || frame.chapterTitle || frame.chapter, index);
  }
  return normalizePhaseId('', index);
}

function parseInteraction(rawInteraction, entityLookup, defaultActor) {
  var raw = String(rawInteraction || '').trim();
  if (!raw) return null;

  var parts = raw.split(':').map(function(part) { return String(part || '').trim(); });
  var verb = String(parts[0] || '').toLowerCase();
  var atomId = VERB_TO_ATOM[verb];
  if (!atomId) return { unresolved: true, raw: raw, verb: verb };

  var params = { actor: defaultActor };
  if (verb === 'move_to' || verb === 'reach') {
    params.target = resolveEntityName(parts[1], entityLookup);
    params.range = 1.5;
  } else if (verb === 'click') {
    params.target = resolveEntityName(parts[1], entityLookup);
  } else if (verb === 'drag') {
    params.from = resolveEntityName(parts[1], entityLookup);
    params.to = resolveEntityName(parts[2], entityLookup);
    params.dropRadius = asNumber(parts[3], 2);
  } else if (verb === 'hold') {
    params.target = resolveEntityName(parts[1], entityLookup);
    params.duration = asNumber(parts[2], 1);
  } else if (verb === 'collect') {
    params.target = resolveEntityName(parts[1], entityLookup);
    params.item = resolveEntityName(parts[1], entityLookup);
    params.count = asNumber(parts[2], 1);
  } else if (verb === 'deliver') {
    params.item = resolveEntityName(parts[1], entityLookup);
    params.target = resolveEntityName(parts[2], entityLookup);
  } else if (verb === 'spend') {
    params.resource = parts[1] || 'resource';
    params.amount = asNumber(parts[2], 1);
    params.target = resolveEntityName(parts[3], entityLookup);
  } else if (verb === 'build') {
    params.target = resolveEntityName(parts[1], entityLookup);
  } else if (verb === 'upgrade') {
    params.target = resolveEntityName(parts[1], entityLookup);
    params.level = asNumber(parts[2], 2);
  } else if (verb === 'attack') {
    params.target = resolveEntityName(parts[1], entityLookup);
    params.mode = 'tap';
  } else if (verb === 'defeat' || verb === 'defeat_count') {
    params.target = resolveEntityName(parts[1], entityLookup);
    params.count = asNumber(parts[1], 1);
  } else if (verb === 'defend' || verb === 'wait') {
    params.duration = asNumber(parts[1], 3);
  } else if (verb === 'appear') {
    params.entity = resolveEntityName(parts[1], entityLookup);
  } else if (verb === 'disappear') {
    params.entity = resolveEntityName(parts[1], entityLookup);
  } else if (verb === 'transform') {
    params.entity = resolveEntityName(parts[1], entityLookup);
    params.field = 'state';
    params.value = parts[2] || 'changed';
  } else if (verb === 'unlock') {
    params.entity = resolveEntityName(parts[1], entityLookup);
  }

  return {
    atomId: atomId,
    params: params,
    raw: raw,
    verb: verb
  };
}

function createAtomCollector(registryIndex) {
  var items = [];
  var unresolved = [];
  var seen = {};
  var nextId = 1;

  function add(atomId, phaseId, params, source) {
    if (!registryIndex.atomIndex[atomId]) {
      unresolved.push({
        kind: 'unknown_atom',
        atomId: atomId,
        phaseId: phaseId || '',
        source: source || {}
      });
      return null;
    }
    var mapping = registryIndex.mappingIndex[atomId] || {};
    var key = [atomId, phaseId || '', stableStringify(params || {}), stableStringify(source || {})].join('|');
    if (seen[key]) return seen[key];

    var item = {
      id: 'atom_' + String(nextId++).padStart(3, '0'),
      atomId: atomId,
      phaseId: phaseId || '',
      params: params || {},
      source: source || {},
      mappedModules: uniq((mapping.moduleCombo || []).slice()),
      cuaAssertions: uniq((mapping.cuaAssertions || registryIndex.atomIndex[atomId].cuaAssertions || []).slice())
    };
    items.push(item);
    seen[key] = item;
    return item;
  }

  return {
    items: items,
    unresolved: unresolved,
    add: add
  };
}

function inferTextAtoms(frame, frameIndex, phaseId, entityLookup, defaultActor, collector) {
  var textBlocks = [
    { field: 'interaction', text: frame.interaction },
    { field: 'camera', text: frame.camera },
    { field: 'ui', text: frame.ui },
    { field: 'animation', text: frame.animation },
    { field: 'note', text: frame.note },
    { field: 'prompt', text: frame.prompt },
    { field: 'scriptExcerpt', text: frame.scriptExcerpt }
  ];

  for (var i = 0; i < textBlocks.length; i++) {
    var entry = textBlocks[i];
    var text = String(entry.text || '').trim();
    if (!text) continue;

    var target = resolveEntityName(text, entityLookup);
    if (/移动|走向|前往|靠近|move|walk/i.test(text)) {
      collector.add('move_to', phaseId, { actor: defaultActor, target: target, range: 1.5 }, { kind: 'frame_text', frameIndex: frameIndex, field: entry.field, raw: text });
    }
    if (/收集|拾取|捡|collect/i.test(text)) {
      collector.add('collect_nearby', phaseId, { actor: defaultActor, target: target, item: target, count: 1 }, { kind: 'frame_text', frameIndex: frameIndex, field: entry.field, raw: text });
    }
    if (/攻击|射击|开火|attack|shoot/i.test(text)) {
      collector.add('attack_target', phaseId, { actor: defaultActor, target: target || 'enemy', mode: 'auto' }, { kind: 'frame_text', frameIndex: frameIndex, field: entry.field, raw: text });
    }
    if (/变色|变红|变绿|变蓝|发光|染色|color/i.test(text)) {
      collector.add('change_color', phaseId, { entity: target, variant: parseColorVariant(text) }, { kind: 'frame_text', frameIndex: frameIndex, field: entry.field, raw: text });
    }
    if (/镜头拉高|拉高镜头|抬高镜头|拉远|俯视|全景|camera lift|pull back/i.test(text)) {
      collector.add('camera_lift', phaseId, { amount: 1, duration: 0.5 }, { kind: 'frame_text', frameIndex: frameIndex, field: entry.field, raw: text });
    }
    if (/镜头聚焦|看向|对准|focus|look at/i.test(text)) {
      collector.add('camera_focus', phaseId, { target: target }, { kind: 'frame_text', frameIndex: frameIndex, field: entry.field, raw: text });
    }
    if (/高亮|圈出|提示圈|highlight/i.test(text)) {
      collector.add('highlight_target', phaseId, { target: target, style: 'ring' }, { kind: 'frame_text', frameIndex: frameIndex, field: entry.field, raw: text });
    }
    if (/飘字|浮字|\+\d+|奖励字|floating/i.test(text)) {
      collector.add('show_floating_text', phaseId, { text: text.length > 24 ? text.slice(0, 24) : text }, { kind: 'frame_text', frameIndex: frameIndex, field: entry.field, raw: text });
    }
  }
}

function buildStoryboardAtomPlan(ctx, registry, registryIndex) {
  var collector = createAtomCollector(registryIndex);
  var defaultActor = findPlayerEntityName(ctx.entities);
  var entityLookup = buildEntityLookup(ctx.entities);

  for (var si = 0; si < ctx.specs.length; si++) {
    var spec = ctx.specs[si] || {};
    var phaseId = normalizePhaseId(spec.phaseId || findPhaseIdForIndex(ctx, si), si);
    var interactions = toArray(spec.requiredInteractions);
    for (var ri = 0; ri < interactions.length; ri++) {
      var parsed = parseInteraction(interactions[ri], entityLookup, defaultActor);
      if (!parsed) continue;
      if (parsed.unresolved) {
        collector.unresolved.push({
          kind: 'unknown_interaction_verb',
          raw: parsed.raw,
          verb: parsed.verb,
          phaseId: phaseId
        });
        continue;
      }
      collector.add(parsed.atomId, phaseId, parsed.params, {
        kind: 'spec_interaction',
        specIndex: si,
        raw: parsed.raw
      });
    }
  }

  for (var pi = 0; pi < ctx.phases.length; pi++) {
    var phase = ctx.phases[pi] || {};
    var phaseId2 = findPhaseIdForIndex(ctx, pi);
    if (phase.guide) {
      collector.add('show_guide', phaseId2, { text: String(phase.guide) }, {
        kind: 'phase_guide',
        phaseIndex: pi
      });
    }
    if (phase.camera && phase.camera.lookAt) {
      collector.add('camera_focus', phaseId2, { target: resolveEntityName(phase.camera.lookAt, entityLookup) }, {
        kind: 'phase_camera',
        phaseIndex: pi,
        field: 'lookAt'
      });
    }
    if (phase.camera && phase.camera.zoom !== undefined && phase.camera.zoom !== null) {
      collector.add('camera_zoom', phaseId2, { value: asNumber(phase.camera.zoom, phase.camera.zoom), duration: 0.5 }, {
        kind: 'phase_camera',
        phaseIndex: pi,
        field: 'zoom'
      });
    }
  }

  for (var fi = 0; fi < ctx.storyboardFrames.length; fi++) {
    var frame = ctx.storyboardFrames[fi] || {};
    var phaseId3 = findPhaseIdForIndex(ctx, fi);
    inferTextAtoms(frame, fi, phaseId3, entityLookup, defaultActor, collector);
  }

  return {
    version: 'storyboard-atom-plan-v1',
    registryVersion: registry.storyboardAtoms.version,
    projectName: ctx.projectName,
    items: collector.items,
    unresolved: collector.unresolved,
    sourceSummary: {
      frames: ctx.storyboardFrames.length,
      phases: ctx.phases.length,
      specs: ctx.specs.length
    }
  };
}

function addModuleEntry(record, moduleId, source, params, sourceAtomId) {
  if (!record._moduleMap[moduleId]) {
    record._moduleMap[moduleId] = {
      moduleId: moduleId,
      params: {},
      sources: [],
      sourceAtomIds: []
    };
  }
  var entry = record._moduleMap[moduleId];
  if (params && typeof params === 'object') {
    var keys = Object.keys(params);
    for (var i = 0; i < keys.length; i++) {
      if (params[keys[i]] !== undefined && params[keys[i]] !== '') {
        entry.params[keys[i]] = params[keys[i]];
      }
    }
  }
  if (source) pushUnique(entry.sources, source);
  if (sourceAtomId) pushUnique(entry.sourceAtomIds, sourceAtomId);
}

function deriveEntityModuleParams(moduleId, entity) {
  var trigger = entity.trigger || {};
  var behavior = entity.behavior || {};
  var visual = entity.visual || {};
  var params = {};

  if (moduleId === 'visual_binding') {
    params.pool = entity.poolName || entity.pool || entity.name;
    params.position = visual.position || '';
    params.scale = visual.scale || '';
    params.spawnStyle = (entity.spawn && entity.spawn.style) || 'instant';
  } else if (moduleId === 'player_input_joystick') {
    params.speed = behavior.moveSpeed || 5;
  } else if (moduleId === 'click_trigger') {
    params.target = entity.name;
  } else if (moduleId === 'drag_trigger') {
    params.from = entity.name;
    params.to = (trigger.params && trigger.params.dropTarget) || '';
    params.dropRadius = (trigger.params && trigger.params.dropRadius) || 2;
  } else if (moduleId === 'proximity_trigger') {
    params.target = entity.name;
    params.radius = (trigger.params && trigger.params.radius) || 2;
  } else if (moduleId === 'cost_gate') {
    if (trigger.params && trigger.params.cost) {
      var resourceKeys = Object.keys(trigger.params.cost);
      params.resource = resourceKeys[0] || 'resource';
      params.amount = trigger.params.cost[params.resource] || 1;
    }
  } else if (moduleId === 'build_progress') {
    params.buildTime = behavior.buildTime || 1;
  } else if (moduleId === 'upgrade_progress') {
    params.levels = behavior.upgradeLevels || [];
    params.costs = behavior.upgradeCosts || [];
  } else if (moduleId === 'move_to_target') {
    params.target = behavior.moveTarget || '';
    params.speed = behavior.moveSpeed || 3;
    params.stopRange = behavior.stopRange || 1.5;
  } else if (moduleId === 'damageable') {
    params.hp = behavior.hp || behavior.maxHp || 1;
    params.maxHp = behavior.maxHp || behavior.hp || 1;
  } else if (moduleId === 'target_acquire') {
    params.targetTag = behavior.targetTag || 'enemy';
    params.range = behavior.range || 8;
  } else if (moduleId === 'projectile_emit') {
    params.projectile = behavior.projectile || '';
    params.speed = behavior.speed || 12;
    params.damage = behavior.damage || 1;
    params.cooldown = behavior.fireRate || behavior.cooldown || 1;
  } else if (moduleId === 'spawn_interval') {
    params.entity = behavior.spawnEntity || '';
    params.interval = behavior.spawnInterval || (trigger.params && trigger.params.interval) || 2;
    params.maxAlive = behavior.maxAlive || 1;
    params.position = behavior.spawnPosition || '';
  } else if (moduleId === 'activate_targets') {
    var targets = [];
    var onBuilt = toArray(behavior.onBuilt);
    for (var i = 0; i < onBuilt.length; i++) {
      var act = onBuilt[i] || {};
      if (act.type === 'activate' && act.params && act.params.target) pushUnique(targets, act.params.target);
    }
    params.targets = targets;
  } else if (moduleId === 'on_death_drop') {
    var actions = toArray(entity.actions);
    for (var j = 0; j < actions.length; j++) {
      var action = actions[j] || {};
      if ((action.type === 'onDeath' || action.type === 'drop') && action.params) {
        params.item = action.params.drop || action.params.item || '';
        params.count = action.params.count || 1;
        break;
      }
    }
  } else if (moduleId === 'world_label') {
    params.text = entity.label || entity.showLabel || entity.name;
    params.target = entity.name;
  }

  return params;
}

function deriveAtomModuleParams(moduleId, atom) {
  var params = atom.params || {};
  var out = {};
  if (moduleId === 'move_to_target') {
    out.target = params.target || '';
    out.speed = params.speed || 5;
    out.stopRange = params.range || 1.5;
  } else if (moduleId === 'click_trigger') {
    out.target = params.target || params.entity || '';
  } else if (moduleId === 'drag_trigger') {
    out.from = params.from || '';
    out.to = params.to || params.target || '';
    out.dropRadius = params.dropRadius || 2;
  } else if (moduleId === 'proximity_trigger') {
    out.target = params.target || params.entity || '';
    out.radius = params.range || 2;
  } else if (moduleId === 'collect_on_near') {
    out.resource = params.resource || params.item || '';
    out.item = params.item || params.target || '';
    out.count = params.count || 1;
    out.range = params.range || 1.5;
  } else if (moduleId === 'deliver_to_target') {
    out.resource = params.item || params.resource || '';
    out.target = params.target || params.to || '';
    if (params.reward !== undefined && params.reward !== null && params.reward !== '') out.reward = params.reward;
    if (params.rewardResource) out.rewardResource = params.rewardResource;
  } else if (moduleId === 'cost_gate') {
    out.resource = params.resource || 'resource';
    out.amount = params.amount || 1;
  } else if (moduleId === 'build_progress') {
    out.buildTime = params.buildTime || 1;
  } else if (moduleId === 'upgrade_progress') {
    out.levels = params.level ? [params.level] : [];
  } else if (moduleId === 'target_acquire') {
    out.targetTag = params.targetTag || 'enemy';
    out.range = params.range || 8;
  } else if (moduleId === 'projectile_emit') {
    out.projectile = params.projectile || '';
    out.damage = params.damage || 1;
    out.cooldown = params.cooldown || 1;
  } else if (moduleId === 'apply_damage') {
    out.amount = params.amount || params.damage || 1;
    out.source = params.actor || '';
  } else if (moduleId === 'activate_targets') {
    out.targets = params.target ? [params.target] : [];
  } else if (moduleId === 'guide_ui') {
    out.text = params.text || '';
  } else if (moduleId === 'camera_focus') {
    out.target = params.target || '';
  } else if (moduleId === 'camera_lift') {
    out.amount = params.amount || 1;
    out.duration = params.duration || 0.5;
  } else if (moduleId === 'camera_zoom') {
    out.value = params.value || 1;
    out.duration = params.duration || 0.5;
  } else if (moduleId === 'highlight_target') {
    out.target = params.target || '';
    out.style = params.style || 'ring';
  } else if (moduleId === 'floating_text_feedback') {
    out.text = params.text || '';
  } else if (moduleId === 'visual_variant_swap') {
    out.entity = params.entity || params.target || '';
    out.variantId = params.variant || params.value || 'changed';
  } else if (moduleId === 'score_feedback') {
    out.label = params.label || params.item || params.resource || 'score';
  } else if (moduleId === 'spawn_once') {
    out.entity = params.entity || params.item || '';
  } else if (moduleId === 'phase_gate_timer') {
    out.seconds = params.duration || 3;
  }
  return out;
}

function buildEntityPlan(ctx, storyboardAtomPlan, registry, registryIndex) {
  var entities = [];
  var entityMap = {};
  var systemModuleMap = {};
  var defaultPlayer = findPlayerEntityName(ctx.entities);

  function ensureEntityRecord(entity) {
    if (entityMap[entity.name]) return entityMap[entity.name];
    var record = {
      name: entity.name,
      label: entity.label || entity.showLabel || entity.chineseName || '',
      template: entity.template || '',
      archetypeId: null,
      spawn: clone(entity.spawn || {}),
      phaseRefs: [],
      modules: [],
      unresolved: [],
      _moduleMap: {}
    };
    entityMap[entity.name] = record;
    entities.push(record);
    return record;
  }

  function ensureSystemModule(moduleId, source, params, sourceAtomId) {
    if (!systemModuleMap[moduleId]) {
      systemModuleMap[moduleId] = {
        moduleId: moduleId,
        params: {},
        sources: [],
        sourceAtomIds: []
      };
    }
    var entry = systemModuleMap[moduleId];
    var keys = Object.keys(params || {});
    for (var i = 0; i < keys.length; i++) {
      if (params[keys[i]] !== undefined && params[keys[i]] !== '') {
        entry.params[keys[i]] = params[keys[i]];
      }
    }
    if (source) pushUnique(entry.sources, source);
    if (sourceAtomId) pushUnique(entry.sourceAtomIds, sourceAtomId);
  }

  for (var i = 0; i < ctx.entities.length; i++) {
    var entity = ctx.entities[i] || {};
    if (!entity.name) continue;
    var record = ensureEntityRecord(entity);

    var templateParts = String(entity.template || 'Static').split('+').map(function(part) { return String(part || '').trim(); }).filter(Boolean);
    for (var tp = 0; tp < templateParts.length; tp++) {
      var part = templateParts[tp];
      if (TEMPLATE_TO_ARCHETYPE[part] && !record.archetypeId) {
        record.archetypeId = TEMPLATE_TO_ARCHETYPE[part];
        var archetype = registryIndex.archetypeIndex[record.archetypeId];
        for (var am = 0; archetype && am < archetype.modules.length; am++) {
          addModuleEntry(record, archetype.modules[am], 'template:' + part, deriveEntityModuleParams(archetype.modules[am], entity));
        }
      }
      var directModules = TEMPLATE_TO_MODULES[part] || [];
      for (var dm = 0; dm < directModules.length; dm++) {
        addModuleEntry(record, directModules[dm], 'template:' + part, deriveEntityModuleParams(directModules[dm], entity));
      }
      var aliasModules = TEMPLATE_ALIASES[part] || [];
      for (var al = 0; al < aliasModules.length; al++) {
        addModuleEntry(record, aliasModules[al], 'template:' + part, deriveEntityModuleParams(aliasModules[al], entity));
      }
      if (!TEMPLATE_TO_ARCHETYPE[part] && !TEMPLATE_TO_MODULES[part] && !TEMPLATE_ALIASES[part]) {
        record.unresolved.push({ kind: 'unknown_template_part', templatePart: part });
      }
    }

    var trigger = entity.trigger || {};
    if (trigger.type === 'proximity') addModuleEntry(record, 'proximity_trigger', 'trigger:proximity', deriveEntityModuleParams('proximity_trigger', entity));
    if (trigger.type === 'click') addModuleEntry(record, 'click_trigger', 'trigger:click', deriveEntityModuleParams('click_trigger', entity));
    if (trigger.type === 'drag') addModuleEntry(record, 'drag_trigger', 'trigger:drag', deriveEntityModuleParams('drag_trigger', entity));
    if (trigger.type === 'timer') addModuleEntry(record, 'cooldown', 'trigger:timer', { seconds: (trigger.params && trigger.params.interval) || 1 });

    var behavior = entity.behavior || {};
    if (behavior.moveTarget || behavior.moveSpeed) addModuleEntry(record, 'move_to_target', 'behavior:move', deriveEntityModuleParams('move_to_target', entity));
    if (behavior.hp || behavior.maxHp) addModuleEntry(record, 'damageable', 'behavior:hp', deriveEntityModuleParams('damageable', entity));
    if (behavior.projectile || behavior.fireRate || behavior.targetTag || behavior.range) {
      addModuleEntry(record, 'target_acquire', 'behavior:combat', deriveEntityModuleParams('target_acquire', entity));
      addModuleEntry(record, 'projectile_emit', 'behavior:combat', deriveEntityModuleParams('projectile_emit', entity));
      addModuleEntry(record, 'cooldown', 'behavior:combat', { seconds: behavior.fireRate || 1 });
      if (behavior.damage) addModuleEntry(record, 'apply_damage', 'behavior:combat', { amount: behavior.damage, source: entity.name });
    }
    if (behavior.spawnEntity || behavior.spawnInterval || behavior.maxAlive) addModuleEntry(record, 'spawn_interval', 'behavior:spawn', deriveEntityModuleParams('spawn_interval', entity));
    if (behavior.buildTime) addModuleEntry(record, 'build_progress', 'behavior:build', deriveEntityModuleParams('build_progress', entity));
    if (behavior.upgradeLevels) addModuleEntry(record, 'upgrade_progress', 'behavior:upgrade', deriveEntityModuleParams('upgrade_progress', entity));
    if (behavior.onBuilt) addModuleEntry(record, 'activate_targets', 'behavior:onBuilt', deriveEntityModuleParams('activate_targets', entity));

    var actions = toArray(entity.actions);
    for (var ac = 0; ac < actions.length; ac++) {
      var action = actions[ac] || {};
      if (action.type === 'addResource') ensureSystemModule('inventory_wallet', 'action:addResource', { resourceKinds: uniq([Object.keys(action.params || {})[0] || 'resource']) });
      if (action.type === 'cameraLookAt') ensureSystemModule('camera_focus', 'action:cameraLookAt', { target: action.params && action.params.target });
      if (action.type === 'showUI') ensureSystemModule('guide_ui', 'action:showUI', { text: action.params && action.params.text });
      if (action.type === 'gameEnd') ensureSystemModule('cta_finish', 'action:gameEnd', { target: entity.name });
      if (action.type === 'onDeath' || action.type === 'drop') addModuleEntry(record, 'on_death_drop', 'action:onDeath', deriveEntityModuleParams('on_death_drop', entity));
      if (action.type === 'activate') addModuleEntry(record, 'activate_targets', 'action:activate', { targets: [action.params && action.params.target] });
    }

    if (entity.label || entity.showLabel || entity.chineseName) {
      ensureSystemModule('world_label', 'entity:label', { text: entity.label || entity.showLabel || entity.chineseName || entity.name, target: entity.name });
    }
  }

  for (var p = 0; p < ctx.phases.length; p++) {
    var phase = ctx.phases[p] || {};
    var phaseId = findPhaseIdForIndex(ctx, p);
    var activate = toArray(phase.activate);
    for (var ap = 0; ap < activate.length; ap++) {
      if (entityMap[activate[ap]]) pushUnique(entityMap[activate[ap]].phaseRefs, phaseId);
    }
  }

  for (var ai = 0; ai < storyboardAtomPlan.items.length; ai++) {
    var atom = storyboardAtomPlan.items[ai];
    var mapping = registryIndex.mappingIndex[atom.atomId] || {};
    var moduleCombo = uniq((mapping.moduleCombo || atom.mappedModules || []).slice());
    var targetEntityName = atom.params && (atom.params.entity || atom.params.target || atom.params.from || atom.params.item || atom.params.actor);
    var actorEntityName = atom.params && atom.params.actor ? atom.params.actor : defaultPlayer;
    for (var mm = 0; mm < moduleCombo.length; mm++) {
      var moduleId = moduleCombo[mm];
      var moduleParams = deriveAtomModuleParams(moduleId, atom);
      if (SYSTEM_MODULES[moduleId]) {
        ensureSystemModule(moduleId, 'atom:' + atom.atomId, moduleParams, atom.id);
        continue;
      }
      if ((moduleId === 'player_input_joystick' || moduleId === 'player_input_tap') && entityMap[actorEntityName]) {
        addModuleEntry(entityMap[actorEntityName], moduleId, 'atom:' + atom.atomId, moduleParams, atom.id);
        continue;
      }
      var ownerName = targetEntityName && entityMap[targetEntityName] ? targetEntityName : null;
      if (!ownerName && atom.params && atom.params.target && entityMap[atom.params.target]) ownerName = atom.params.target;
      if (!ownerName && atom.params && atom.params.from && entityMap[atom.params.from]) ownerName = atom.params.from;
      if (!ownerName && atom.params && atom.params.entity && entityMap[atom.params.entity]) ownerName = atom.params.entity;
      if (!ownerName && entityMap[actorEntityName] && moduleId === 'move_to_target') ownerName = actorEntityName;
      if (ownerName && entityMap[ownerName]) {
        addModuleEntry(entityMap[ownerName], moduleId, 'atom:' + atom.atomId, moduleParams, atom.id);
      } else {
        ensureSystemModule(moduleId, 'atom:' + atom.atomId, moduleParams, atom.id);
      }
    }
  }

  for (var en = 0; en < entities.length; en++) {
    var entityRecord = entities[en];
    var moduleIds = Object.keys(entityRecord._moduleMap).sort();
    for (var mi = 0; mi < moduleIds.length; mi++) {
      entityRecord.modules.push(entityRecord._moduleMap[moduleIds[mi]]);
    }
    delete entityRecord._moduleMap;
  }

  var systemModules = Object.keys(systemModuleMap).sort().map(function(moduleId) {
    return systemModuleMap[moduleId];
  });

  return {
    version: 'entity-plan-v1',
    registryVersion: registry.runtimeModules.version,
    entities: entities,
    systemModules: systemModules
  };
}

function substituteStateToken(state, entityName) {
  return String(state || '').replace(/<entity>/g, entityName || 'system');
}

function chooseStateOwner(existing, candidate) {
  if (!existing) return candidate;
  var existingScore = STATE_OWNER_PRIORITY[existing.moduleId] || 0;
  var candidateScore = STATE_OWNER_PRIORITY[candidate.moduleId] || 0;
  return candidateScore > existingScore ? candidate : existing;
}

function extractSpawnDependency(condition) {
  var text = String(condition || '').trim();
  if (!text) return null;
  var phaseMatch = text.match(/^phase:(.+)$/i);
  if (phaseMatch) return { kind: 'phase', value: normalizePhaseId(phaseMatch[1], 0) };
  var entityMatch = text.match(/^entity:([^\.]+)\./i);
  if (entityMatch) return { kind: 'entity', value: String(entityMatch[1]).trim() };
  return null;
}

function buildAssemblyPlan(ctx, storyboardAtomPlan, entityPlan, registry, registryIndex) {
  var moduleInstances = [];
  var fileOwnersMap = {};
  var eventGraph = [];
  var unresolved = storyboardAtomPlan.unresolved.slice();
  var moduleInstanceIndex = {};
  var stateOwnerMap = {};

  function registerModuleInstance(moduleId, entityName, params, sources, sourceAtomIds) {
    var moduleDef = registryIndex.moduleIndex[moduleId];
    if (!moduleDef) {
      unresolved.push({ kind: 'unknown_module_instance', moduleId: moduleId, entity: entityName || '' });
      return null;
    }
    var instanceId = (entityName ? entityName : 'system') + '::' + moduleId;
    if (moduleInstanceIndex[instanceId]) {
      var existing = moduleInstanceIndex[instanceId];
      existing.sourceAtomIds = uniq(existing.sourceAtomIds.concat(sourceAtomIds || []));
      existing.sources = uniq(existing.sources.concat(sources || []));
      var paramKeys = Object.keys(params || {});
      for (var i = 0; i < paramKeys.length; i++) {
        if (params[paramKeys[i]] !== undefined && params[paramKeys[i]] !== '') {
          existing.params[paramKeys[i]] = params[paramKeys[i]];
        }
      }
      return existing;
    }

    var instance = {
      id: instanceId,
      moduleId: moduleId,
      entity: entityName || '',
      params: clone(params || {}),
      ownerFiles: clone(moduleDef.ownerFiles || []),
      statesWritten: [],
      observableFeedback: clone(moduleDef.observableFeedback || []),
      expectedSignals: clone(moduleDef.expectedSignals || moduleDef.observableFeedback || []),
      phaseEvidenceSchema: clone(moduleDef.phaseEvidenceSchema || []),
      sources: uniq((sources || []).slice()),
      sourceAtomIds: uniq((sourceAtomIds || []).slice())
    };

    var statesWritten = toArray(moduleDef.statesWritten);
    for (var s = 0; s < statesWritten.length; s++) {
      instance.statesWritten.push(substituteStateToken(statesWritten[s], entityName));
    }

    moduleInstances.push(instance);
    moduleInstanceIndex[instanceId] = instance;

    for (var fo = 0; fo < instance.ownerFiles.length; fo++) {
      var file = instance.ownerFiles[fo];
      if (!fileOwnersMap[file]) fileOwnersMap[file] = [];
      pushUnique(fileOwnersMap[file], instanceId);
    }

    for (var st = 0; st < instance.statesWritten.length; st++) {
      var state = instance.statesWritten[st];
      if (!state) continue;
      var candidate = { state: state, moduleInstanceId: instanceId, moduleId: moduleId, entity: entityName || '' };
      var chosen = chooseStateOwner(stateOwnerMap[state], candidate);
      if (stateOwnerMap[state] && chosen.moduleInstanceId !== stateOwnerMap[state].moduleInstanceId) {
        unresolved.push({
          kind: 'state_owner_conflict',
          state: state,
          preferred: chosen.moduleInstanceId,
          rejected: stateOwnerMap[state].moduleInstanceId
        });
      }
      stateOwnerMap[state] = chosen;
    }

    return instance;
  }

  for (var ei = 0; ei < entityPlan.entities.length; ei++) {
    var entity = entityPlan.entities[ei];
    for (var em = 0; em < entity.modules.length; em++) {
      registerModuleInstance(entity.modules[em].moduleId, entity.name, entity.modules[em].params, entity.modules[em].sources, entity.modules[em].sourceAtomIds);
    }

    var dependency = extractSpawnDependency(entity.spawn && entity.spawn.condition);
    if (dependency) {
      if (dependency.kind === 'phase') {
        eventGraph.push({
          from: dependency.value,
          to: entity.name + '::visual_binding',
          reason: 'spawn_condition_phase'
        });
      } else if (dependency.kind === 'entity') {
        eventGraph.push({
          from: dependency.value + '::build_progress',
          to: entity.name + '::visual_binding',
          reason: 'spawn_condition_entity_state'
        });
      }
    }
  }

  for (var sm = 0; sm < entityPlan.systemModules.length; sm++) {
    var sysModule = entityPlan.systemModules[sm];
    registerModuleInstance(sysModule.moduleId, '', sysModule.params, sysModule.sources, sysModule.sourceAtomIds);
  }

  for (var ai = 0; ai < storyboardAtomPlan.items.length; ai++) {
    var atom = storyboardAtomPlan.items[ai];
    var mapping = registryIndex.mappingIndex[atom.atomId] || {};
    var combo = uniq((mapping.moduleCombo || []).slice());
    for (var cm = 0; cm < combo.length - 1; cm++) {
      var fromId = combo[cm];
      var toId = combo[cm + 1];
      var ownerEntity = atom.params && (atom.params.target || atom.params.entity || atom.params.from || atom.params.actor) || '';
      eventGraph.push({
        from: (ownerEntity && moduleInstanceIndex[ownerEntity + '::' + fromId]) ? ownerEntity + '::' + fromId : 'system::' + fromId,
        to: (ownerEntity && moduleInstanceIndex[ownerEntity + '::' + toId]) ? ownerEntity + '::' + toId : 'system::' + toId,
        reason: 'atom_flow',
        atomId: atom.id
      });
    }
  }

  for (var ej = 0; ej < entityPlan.entities.length; ej++) {
    var modules = entityPlan.entities[ej].modules;
    for (var mj = 0; mj < modules.length; mj++) {
      if (modules[mj].moduleId !== 'activate_targets') continue;
      var targets = toArray(modules[mj].params.targets);
      for (var tg = 0; tg < targets.length; tg++) {
        eventGraph.push({
          from: entityPlan.entities[ej].name + '::activate_targets',
          to: targets[tg] + '::visual_binding',
          reason: 'activate_targets'
        });
      }
    }
  }

  var phaseBindings = [];
  var seenPhase = {};
  var phaseCount = Math.max(ctx.phases.length, ctx.specs.length, ctx.storyboardFrames.length, 1);
  for (var p = 0; p < phaseCount; p++) {
    var phase = ctx.phases[p] || {};
    var spec = ctx.specs[p] || {};
    var phaseId = findPhaseIdForIndex(ctx, p);
    if (seenPhase[phaseId]) continue;
    seenPhase[phaseId] = true;

    var activateEntities = uniq(toArray(phase.activate).concat(toArray(spec.entitiesRequired).map(function(ent) {
      return ent && ent.name ? ent.name : '';
    })));
    var atomIds = [];
    var completionSignals = [];
    for (var at = 0; at < storyboardAtomPlan.items.length; at++) {
      var atomItem = storyboardAtomPlan.items[at];
      if (atomItem.phaseId && atomItem.phaseId !== phaseId) continue;
      if (!atomItem.phaseId && p > 0) continue;
      atomIds.push(atomItem.id);
      completionSignals = uniq(completionSignals.concat(atomItem.cuaAssertions || []));
    }
    if (spec.triggerNext || (spec.duration && spec.duration.max)) pushUnique(completionSignals, 'phase_advanced');

    phaseBindings.push({
      phaseId: phaseId,
      index: p,
      activateEntities: activateEntities,
      guide: phase.guide || '',
      camera: clone(phase.camera || {}),
      endCondition: phase.endCondition || (spec.triggerNext && spec.triggerNext.condition) || '',
      atomIds: atomIds,
      completionSignals: completionSignals
    });
  }

  var fileOwners = Object.keys(fileOwnersMap).sort().map(function(file) {
    return { file: file, moduleInstanceIds: fileOwnersMap[file] };
  });

  var stateOwners = Object.keys(stateOwnerMap).sort().map(function(state) {
    return {
      state: state,
      moduleInstanceId: stateOwnerMap[state].moduleInstanceId,
      entity: stateOwnerMap[state].entity
    };
  });

  return {
    version: 'assembly-plan-v1',
    registryVersion: registry.manifest.version,
    moduleInstances: moduleInstances,
    stateOwners: stateOwners,
    eventGraph: eventGraph,
    phaseBindings: phaseBindings,
    fileOwners: fileOwners,
    unresolved: unresolved.concat(entityPlan.entities.reduce(function(list, entity) {
      return list.concat(entity.unresolved || []);
    }, []))
  };
}

function buildCUAAction(atom) {
  var params = atom.params || {};
  if (atom.atomId === 'move_to') return { kind: 'move_to', actor: params.actor || '', target: params.target || '', range: params.range || 1.5 };
  if (atom.atomId === 'tap_target') return { kind: 'tap', target: params.target || '' };
  if (atom.atomId === 'drag_to_target') return { kind: 'drag', from: params.from || '', to: params.to || '', dropRadius: params.dropRadius || 2 };
  if (atom.atomId === 'hold_target') return { kind: 'hold', target: params.target || '', duration: params.duration || 1 };
  if (atom.atomId === 'collect_nearby') return { kind: 'approach_collect', target: params.target || '', item: params.item || '', count: params.count || 1 };
  if (atom.atomId === 'deliver_to') return { kind: 'deliver', item: params.item || '', target: params.target || '' };
  if (atom.atomId === 'build_entity') return { kind: 'build', target: params.target || '' };
  if (atom.atomId === 'upgrade_entity') return { kind: 'upgrade', target: params.target || '', level: params.level || 1 };
  if (atom.atomId === 'attack_target') return { kind: 'attack', target: params.target || '', mode: params.mode || 'auto' };
  if (atom.atomId === 'defeat_target') return { kind: 'observe_defeat', target: params.target || '', count: params.count || 1 };
  if (atom.atomId === 'defend_duration') return { kind: 'defend', duration: params.duration || 3 };
  return null;
}

function buildCUAStepEvidenceSchema(phaseId, expectedSignals, registryIndex) {
  return buildPhaseEvidenceSchema(expectedSignals, registryIndex.assertionIndex || {}, phaseId);
}

function buildCUAPlan(storyboardAtomPlan, assemblyPlan, registryIndex) {
  var steps = [];
  for (var i = 0; i < assemblyPlan.phaseBindings.length; i++) {
    var binding = assemblyPlan.phaseBindings[i];
    var actions = [];
    var expectedSignals = uniq((binding.completionSignals || []).slice());
    var atomIds = [];
    for (var j = 0; j < binding.atomIds.length; j++) {
      var atomId = binding.atomIds[j];
      var atom = null;
      for (var k = 0; k < storyboardAtomPlan.items.length; k++) {
        if (storyboardAtomPlan.items[k].id === atomId) {
          atom = storyboardAtomPlan.items[k];
          break;
        }
      }
      if (!atom) continue;
      atomIds.push(atom.id);
      expectedSignals = uniq(expectedSignals.concat(atom.cuaAssertions || []));
      var action = buildCUAAction(atom);
      if (action) actions.push(action);
    }

    var categorized = { input: [], state: [], visual: [], ui: [], camera: [], phase: [] };
    for (var e = 0; e < expectedSignals.length; e++) {
      var assertion = registryIndex.assertionIndex[expectedSignals[e]];
      if (!assertion) continue;
      if (!categorized[assertion.kind]) categorized[assertion.kind] = [];
      pushUnique(categorized[assertion.kind], assertion.id);
    }

    steps.push({
      id: 'cua_step_' + String(i + 1).padStart(3, '0'),
      phaseId: binding.phaseId,
      atomIds: atomIds,
      actions: actions,
      mode: actions.length > 0 ? 'act_and_assert' : 'observe_only',
      expectedSignals: expectedSignals,
      phaseEvidenceSchema: buildCUAStepEvidenceSchema(binding.phaseId, expectedSignals, registryIndex),
      assertionsByKind: categorized
    });
  }

  return {
    version: 'cua-plan-v1',
    registryVersion: 'cua-assertions-v1',
    steps: steps
  };
}

function buildProjectPlans(project, opts) {
  var registry = (opts && opts.registry) || loadAssemblyRegistry();
  var ctx = getProjectAssemblyContext(project || {});
  var registryIndex = buildRegistryIndex(registry);
  loadInteractionVerbs();

  var storyboardAtomPlan = buildStoryboardAtomPlan(ctx, registry, registryIndex);
  var entityPlan = buildEntityPlan(ctx, storyboardAtomPlan, registry, registryIndex);
  var assemblyPlan = buildAssemblyPlan(ctx, storyboardAtomPlan, entityPlan, registry, registryIndex);
  var cuaPlan = buildCUAPlan(storyboardAtomPlan, assemblyPlan, registryIndex);
  var plans = {
    version: 'assembly-first-plan-pack-v1',
    generatedAt: new Date().toISOString(),
    registryVersion: registry.manifest.version,
    storyboardAtomPlan: storyboardAtomPlan,
    entityPlan: entityPlan,
    assemblyPlan: assemblyPlan,
    cuaPlan: cuaPlan
  };

  plans.validation = validateAssemblyPlans(plans, registry);
  return plans;
}

function ensureProjectPlans(project, opts) {
  if (!project || typeof project !== 'object') return null;
  var plans = buildProjectPlans(project, opts);
  project.plans = plans;
  project.planValidation = plans.validation;
  return plans;
}

function writePlansArtifact(dirPath, plans) {
  if (!dirPath || !plans) return null;
  fs.mkdirSync(dirPath, { recursive: true });
  var filePath = path.join(dirPath, 'plans.json');
  fs.writeFileSync(filePath, JSON.stringify(plans, null, 2), 'utf8');
  return filePath;
}

module.exports = {
  getProjectAssemblyContext: getProjectAssemblyContext,
  buildProjectPlans: buildProjectPlans,
  ensureProjectPlans: ensureProjectPlans,
  writePlansArtifact: writePlansArtifact
};
