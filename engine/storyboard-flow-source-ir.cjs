'use strict';

var fs = require('fs');

var {
  SOURCE_SCENE_IR_SCHEMA_VERSION,
  normalizeSourceSceneIr,
  validateSourceSceneIr,
} = require('./source-scene-ir.cjs');

var FLOW_SCHEMA_VERSION = 'storyboard-flow-prototype.v1';
var FLOW_KIND = 'blueprint.storyboardFlowPrototype';
var FLOW_ALLOWED_VERBS = {
  move: true,
  move_to: true,
  collect: true,
  produce: true,
  reward: true,
  deliver: true,
  transfer: true,
  combine: true,
  unlock: true,
  build: true,
  upgrade: true,
  show: true,
  spawn: true,
  hide: true,
  despawn: true,
  select: true,
  attack: true,
  wait: true,
  click: true,
};
var FLOW_CONTRACT_PATH = 'contracts/storyboard-flow-prototype.v1.json';

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value == null ? null : JSON.parse(JSON.stringify(value));
}

function cleanId(value, fallback) {
  var text = String(value || fallback || '').trim();
  text = text.replace(/[^A-Za-z0-9_:-]+/g, '_').replace(/^_+|_+$/g, '');
  return text || fallback || '';
}

function numberValue(value, fallback) {
  var number = Number(value);
  return Number.isFinite(number) ? number : fallback;
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

function splitConditionParts(condition) {
  return String(condition || '')
    .split(/\s*&&\s*|\s+and\s+/i)
    .map(function(item) { return item.trim(); })
    .filter(Boolean);
}

function parseInteractionDsl(raw) {
  var parts = String(raw || '').split(':').map(function(part) { return part.trim(); });
  var verb = String(parts[0] || '').toLowerCase();
  if (!verb) return null;
  if (verb === 'move') verb = 'move_to';
  if (verb === 'click') {
    return { raw: raw, verb: verb, target: parts[1] || 'CtaButton' };
  }
  if (verb === 'wait') {
    return { raw: raw, verb: verb, amount: numberValue(parts[1], 1) };
  }
  if (verb === 'collect' || verb === 'produce' || verb === 'reward') {
    return {
      raw: raw,
      verb: verb,
      resource: cleanId(parts[1], ''),
      amount: numberValue(parts[2], 1),
    };
  }
  if (verb === 'deliver' || verb === 'transfer' || verb === 'combine') {
    return {
      raw: raw,
      verb: verb,
      resource: cleanId(parts[1], ''),
      target: cleanId(parts[2], ''),
      amount: numberValue(parts[3], 1),
    };
  }
  return {
    raw: raw,
    verb: verb,
    target: cleanId(parts[1], ''),
    amount: numberValue(parts[2], null),
  };
}

function addIssue(issues, severity, code, message, extra) {
  issues.push(Object.assign({
    severity: severity,
    code: code,
    message: message,
  }, extra || {}));
}

function phaseRef(phase, index) {
  return {
    phaseId: phase && phase.id || ('phase' + (index + 1)),
    phaseOrder: phase && phase.order || index + 1,
  };
}

function interactionVerb(raw) {
  return String(raw || '').split(':')[0].trim().toLowerCase();
}

function preflightStoryboardFlow(flow, options) {
  options = options || {};
  var issues = [];
  if (!isObject(flow)) {
    addIssue(issues, 'blocker', 'storyboard_flow_not_object', 'Storyboard flow must be an object.');
    return buildFlowPreflightReport(flow, [], issues, options);
  }
  if (flow.schemaVersion && flow.schemaVersion !== FLOW_SCHEMA_VERSION) {
    addIssue(issues, 'warn', 'storyboard_flow_schema_version_unknown', 'Flow schemaVersion is not the expected prototype version.', {
      expected: FLOW_SCHEMA_VERSION,
      actual: flow.schemaVersion,
    });
  }
  if (flow.kind && flow.kind !== FLOW_KIND) {
    addIssue(issues, 'warn', 'storyboard_flow_kind_unknown', 'Flow kind is not the expected prototype kind.', {
      expected: FLOW_KIND,
      actual: flow.kind,
    });
  }
  var phases = normalizeFlowPhases(flow);
  if (!phases.length) {
    addIssue(issues, 'blocker', 'storyboard_flow_phases_missing', 'Flow must include at least one phase.');
    return buildFlowPreflightReport(flow, phases, issues, options);
  }
  var min = numberValue(options.minPhases, 10);
  var max = numberValue(options.maxPhases, 13);
  if (phases.length < min || phases.length > max) {
    addIssue(issues, 'warn', 'storyboard_flow_runtime_phase_count_out_of_range', 'Runtime phase count should stay within the recommended range.', {
      min: min,
      max: max,
      actual: phases.length,
    });
  }
  var seenIds = {};
  phases.forEach(function(phase, index) {
    var ref = phaseRef(phase, index);
    if (seenIds[phase.id]) {
      addIssue(issues, 'blocker', 'storyboard_flow_duplicate_phase_id', 'Phase id must be unique.', Object.assign(ref, { duplicateId: phase.id }));
    }
    seenIds[phase.id] = true;
    if (!String(phase.title || '').trim()) {
      addIssue(issues, 'blocker', 'storyboard_flow_phase_title_missing', 'Phase must include title.', ref);
    }
    if (!String(phase.guideText || phase.guide || '').trim()) {
      addIssue(issues, 'blocker', 'storyboard_flow_phase_guide_text_missing', 'Phase must include player-facing guideText.', ref);
    }
    if (!phase.requiredInteractions.length) {
      addIssue(issues, 'blocker', 'storyboard_flow_phase_interactions_missing', 'Phase must include requiredInteractions.', ref);
    }
    if (!safeArray(phase.visibleEntities).length) {
      addIssue(issues, 'warn', 'storyboard_flow_phase_visible_entities_missing', 'Phase should list visibleEntities for layout and liveness.', ref);
    }
    if (!String(phase.completeCondition || '').trim() && index < phases.length - 1) {
      addIssue(issues, 'warn', 'storyboard_flow_phase_complete_condition_missing', 'Non-final phase should include completeCondition.', ref);
    }
    phase.requiredInteractions.forEach(function(raw, interactionIndex) {
      var verb = interactionVerb(raw);
      if (!FLOW_ALLOWED_VERBS[verb]) {
        addIssue(issues, 'blocker', 'storyboard_flow_interaction_verb_unknown', 'Interaction verb is not supported.', Object.assign(ref, {
          interactionIndex: interactionIndex,
          interaction: raw,
          verb: verb,
        }));
      }
      var parsed = parseInteractionDsl(raw);
      if (parsed && (parsed.verb === 'collect' || parsed.verb === 'produce' || parsed.verb === 'reward' ||
        parsed.verb === 'deliver' || parsed.verb === 'transfer' || parsed.verb === 'combine') && !parsed.resource) {
        addIssue(issues, 'blocker', 'storyboard_flow_interaction_resource_missing', 'Interaction must name a resource.', Object.assign(ref, {
          interactionIndex: interactionIndex,
          interaction: raw,
        }));
      }
      if (parsed && (parsed.verb === 'deliver' || parsed.verb === 'transfer' || parsed.verb === 'combine' ||
        parsed.verb === 'move_to' || parsed.verb === 'unlock' || parsed.verb === 'upgrade' || parsed.verb === 'show') && !parsed.target) {
        addIssue(issues, 'blocker', 'storyboard_flow_interaction_target_missing', 'Interaction must name a target.', Object.assign(ref, {
          interactionIndex: interactionIndex,
          interaction: raw,
        }));
      }
      if (parsed && parsed.verb === 'click' && index < phases.length - 1) {
        addIssue(issues, 'blocker', 'storyboard_flow_non_final_click_cta', 'click:* interactions are only allowed on the final CTA phase.', Object.assign(ref, {
          interactionIndex: interactionIndex,
          interaction: raw,
        }));
      }
    });
    var hasExplicitCombine = phase.requiredInteractions.some(function(raw) {
      return /^combine:/i.test(String(raw || '').trim());
    });
    if (!hasExplicitCombine && /合成|碰撞|拖拽|拖动|merge|Merge|→|->|升为/.test(String(phase.visualNotes || phase.notes || ''))) {
      addIssue(issues, 'info', 'storyboard_flow_visual_merge_cue_ignored', 'Merge/collision cue appears only in notes; converter will not create combine without explicit requiredInteractions.', ref);
    }
    if (String(phase.completeCondition || '').trim()) {
      var unknownConditionParts = splitConditionParts(phase.completeCondition).filter(function(part) {
        return !parseConditionGate(part, {});
      });
      if (unknownConditionParts.length > 0) {
        addIssue(issues, 'warn', 'storyboard_flow_complete_condition_unparsed', 'Some completeCondition clauses are not parsed directly; converter may fall back to step-derived gate.', Object.assign(ref, {
          clauses: unknownConditionParts,
        }));
      }
    }
  });
  var catalog = collectCatalog(flow);
  var ids = collectSemanticIds(phases, catalog);
  Object.keys(ids.resourceIds).forEach(function(resourceId) {
    var resource = catalog.resources[resourceId] || null;
    if (!resource) {
      addIssue(issues, 'warn', 'storyboard_flow_resource_catalog_missing', 'Resource is referenced but not defined in resources[].', {
        resourceId: resourceId,
      });
      return;
    }
    var carrier = cleanId(resource.carrierEntity || resource.entity, '');
    if (!carrier) {
      addIssue(issues, 'warn', 'storyboard_flow_resource_carrier_missing', 'Resource should declare carrierEntity.', {
        resourceId: resourceId,
      });
    } else if (!ids.entityIds[carrier]) {
      addIssue(issues, 'warn', 'storyboard_flow_resource_carrier_not_visible_or_cataloged', 'Resource carrierEntity is not referenced by phases/entities; converter will materialize it.', {
        resourceId: resourceId,
        carrierEntity: carrier,
      });
    }
  });
  addResourceCostIssues(issues, phases, catalog, ids);
  return buildFlowPreflightReport(flow, phases, issues, options);
}

function buildFlowPreflightReport(flow, phases, issues, options) {
  var counts = issues.reduce(function(out, issue) {
    out[issue.severity] = Number(out[issue.severity] || 0) + 1;
    return out;
  }, {});
  var catalog = isObject(flow) ? collectCatalog(flow) : { entities: {}, resources: {} };
  var ids = isObject(flow) ? collectSemanticIds(safeArray(phases), catalog) : { resourceIds: {} };
  return {
    schemaVersion: 'storyboard-flow-authoring-preflight.v1',
    kind: 'blueprint.storyboardFlowAuthoringPreflight',
    generatedAt: options && options.generatedAt || new Date().toISOString(),
    contract: FLOW_CONTRACT_PATH,
    sourceSchemaVersion: flow && flow.schemaVersion || null,
    sourceKind: flow && flow.kind || null,
    projectName: flow && (flow.projectName || flow.project && flow.project.name) || null,
    phaseCount: safeArray(phases).length,
    passed: !counts.blocker,
    issueCounts: {
      blocker: counts.blocker || 0,
      warn: counts.warn || 0,
      info: counts.info || 0,
    },
    resourceSnapshots: computeFlowResourceSnapshots(safeArray(phases), catalog, ids),
    issues: issues,
  };
}

function defaultInteractionForPhase(phase) {
  phase = isObject(phase) ? phase : {};
  var action = String(phase.action || 'show').trim();
  var target = cleanId(phase.target, 'Target');
  var resource = cleanId(phase.resource, 'Item');
  var amount = phase.amount || phase.cost || 1;
  if (action === 'move_to') return ['move_to:' + target];
  if (action === 'collect') return ['collect:' + resource + ':' + amount];
  if (action === 'produce') return ['produce:' + resource + ':' + amount];
  if (action === 'transfer') return ['transfer:' + resource + ':' + target + ':' + amount];
  if (action === 'deliver') return ['deliver:' + resource + ':' + target + ':' + amount];
  if (action === 'combine') return ['combine:' + resource + ':' + target + ':' + amount];
  if (action === 'upgrade') return ['upgrade:' + target + ':' + (amount || 2)];
  if (action === 'unlock') return ['unlock:' + target];
  if (action === 'show') return ['show:' + target];
  if (action === 'wait') return ['wait:' + (amount || 1)];
  if (action === 'cta_finish') return ['click:CtaButton'];
  return ['wait:1'];
}

function normalizeFlowPhases(flow) {
  return safeArray(flow && flow.phases)
    .map(function(phase, index) {
      phase = isObject(phase) ? clone(phase) : {};
      phase.order = numberValue(phase.order, index + 1);
      phase.id = cleanId(phase.id, 'phase' + (index + 1));
      phase.title = String(phase.title || phase.name || phase.id);
      phase.requiredInteractions = safeArray(phase.requiredInteractions && phase.requiredInteractions.length
        ? phase.requiredInteractions
        : phase.interactions && phase.interactions.length ? phase.interactions : defaultInteractionForPhase(phase))
        .map(String)
        .filter(Boolean);
      phase.visibleEntities = uniqueStrings(phase.visibleEntities || phase.entities);
      return phase;
    })
    .sort(function(a, b) {
      return a.order - b.order;
    });
}

function collectCatalog(flow) {
  var entities = {};
  safeArray(flow && flow.entities).forEach(function(entity) {
    if (!isObject(entity)) return;
    var id = cleanId(entity.id || entity.name, '');
    if (!id) return;
    entities[id] = clone(entity);
    entities[id].id = id;
  });
  var resources = {};
  safeArray(flow && flow.resources).forEach(function(resource) {
    if (!isObject(resource)) return;
    var id = cleanId(resource.id || resource.name, '');
    if (!id) return;
    resources[id] = clone(resource);
    resources[id].id = id;
  });
  return { entities: entities, resources: resources };
}

function collectSemanticIds(phases, catalog) {
  var entityIds = {};
  var resourceIds = {};
  function addEntity(id) {
    id = cleanId(id, '');
    if (id) entityIds[id] = true;
  }
  function addResource(id) {
    id = cleanId(id, '');
    if (id) resourceIds[id] = true;
  }
  Object.keys(catalog.entities).forEach(addEntity);
  Object.keys(catalog.resources).forEach(addResource);
  addEntity('Player');
  phases.forEach(function(phase) {
    safeArray(phase.visibleEntities).forEach(addEntity);
    addEntity(phase.target);
    addResource(phase.resource);
    splitConditionParts(phase.completeCondition).forEach(function(part) {
      var match = String(part || '').match(/^([A-Za-z][A-Za-z0-9_-]*)(?:\.amount)?\s*>=\s*[0-9]+/);
      if (match) {
        addResource(match[1]);
        return;
      }
      match = String(part || '').match(/^([A-Za-z][A-Za-z0-9_-]*)\.(?:unlocked|visible|packed|clicked|level)\b/i);
      if (match) addEntity(match[1]);
    });
    phase.requiredInteractions.map(parseInteractionDsl).filter(Boolean).forEach(function(interaction) {
      if (interaction.target) addEntity(interaction.target);
      if (interaction.resource) addResource(interaction.resource);
    });
  });
  Object.keys(resourceIds).forEach(function(resourceId) {
    var carrier = catalog.resources[resourceId] && (catalog.resources[resourceId].carrierEntity || catalog.resources[resourceId].entity);
    addEntity(carrier || resourceId);
  });
  return { entityIds: entityIds, resourceIds: resourceIds };
}

function resourceInitialValues(catalog, ids) {
  var out = {};
  Object.keys(ids && ids.resourceIds || {}).sort().forEach(function(resourceId) {
    var source = catalog.resources[resourceId] || {};
    out[resourceId] = numberValue(source.initial, 0);
  });
  return out;
}

function applyInteractionToResourceState(state, interaction) {
  if (!interaction || !interaction.resource) return;
  var amount = numberValue(interaction.amount, 1);
  if (interaction.verb === 'collect' || interaction.verb === 'produce' || interaction.verb === 'reward') {
    state[interaction.resource] = numberValue(state[interaction.resource], 0) + amount;
  } else if (interaction.verb === 'deliver' || interaction.verb === 'transfer' || interaction.verb === 'combine') {
    state[interaction.resource] = Math.max(0, numberValue(state[interaction.resource], 0) - amount);
  }
}

function phaseHasExplicitResourceSpend(phase, resourceId) {
  return safeArray(phase && phase.requiredInteractions).map(parseInteractionDsl).filter(Boolean).some(function(interaction) {
    return interaction.resource === resourceId &&
      (interaction.verb === 'deliver' || interaction.verb === 'transfer' || interaction.verb === 'combine');
  });
}

function phaseResourceCost(phase) {
  var resourceId = cleanId(phase && phase.resource, '');
  var cost = numberValue(phase && phase.cost, 0);
  if (!resourceId || cost <= 0) return null;
  if (phaseHasExplicitResourceSpend(phase, resourceId)) return null;
  return {
    resource: resourceId,
    amount: cost,
  };
}

function applyPhaseResourceCost(state, phase) {
  var cost = phaseResourceCost(phase);
  if (!cost) return null;
  var before = numberValue(state[cost.resource], 0);
  state[cost.resource] = Math.max(0, before - cost.amount);
  return {
    resource: cost.resource,
    amount: cost.amount,
    before: before,
    after: state[cost.resource],
    affordable: before >= cost.amount,
  };
}

function computeFlowResourceSnapshots(phases, catalog, ids) {
  var state = resourceInitialValues(catalog || { resources: {} }, ids || { resourceIds: {} });
  return safeArray(phases).map(function(phase, index) {
    var before = clone(state);
    safeArray(phase && phase.requiredInteractions).map(parseInteractionDsl).filter(Boolean).forEach(function(interaction) {
      applyInteractionToResourceState(state, interaction);
    });
    var cost = applyPhaseResourceCost(state, phase);
    return {
      phaseId: phase && phase.id || ('phase' + (index + 1)),
      phaseOrder: phase && phase.order || index + 1,
      entering: before,
      cost: cost,
      after: clone(state),
    };
  });
}

function addResourceCostIssues(issues, phases, catalog, ids) {
  computeFlowResourceSnapshots(phases, catalog, ids).forEach(function(snapshot) {
    if (!snapshot.cost || snapshot.cost.affordable) return;
    addIssue(issues, 'warn', 'storyboard_flow_resource_cost_underfunded', 'Phase cost is higher than the resource amount available in the authoring snapshot.', {
      phaseId: snapshot.phaseId,
      phaseOrder: snapshot.phaseOrder,
      resourceId: snapshot.cost.resource,
      cost: snapshot.cost.amount,
      available: snapshot.cost.before,
    });
  });
}

function pushPhaseCostSpend(steps, phase, fallbackTarget) {
  var cost = phaseResourceCost(phase);
  if (!cost) return false;
  var target = cleanId(fallbackTarget || phase && phase.target, '');
  if (target) pushMoveTo(steps, target, 1.8);
  steps.push({ kind: 'transfer', resource: cost.resource, amount: cost.amount, target: target || cost.resource, to: target || cost.resource, purpose: 'cost' });
  return true;
}

function labelFromId(id) {
  var text = String(id || '');
  if (!text) return '';
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim() || text;
}

function primitiveForEntity(id, kind, resourceIds) {
  var text = String(id || '') + ' ' + String(kind || '');
  if (/player|chef|hero|avatar/i.test(text)) return 'capsule';
  if (/circle|ring|unlock|upgrade|range/i.test(text)) return 'torus';
  if (resourceIds[id] || /money|coin|food|donut|shrimp|resource|reward/i.test(text)) return 'sphere';
  if (/queue|customer|crowd|people|npc/i.test(text)) return 'cylinder';
  if (/road|floor|wall|fog|area/i.test(text)) return 'plane';
  return 'box';
}

function colorForEntity(id, kind, resourceIds) {
  var text = String(id || '') + ' ' + String(kind || '');
  if (/player|chef|hero|avatar/i.test(text)) return '#53a8ff';
  if (/money|coin|reward/i.test(text)) return '#34c759';
  if (/donut|shrimp|food|resource/i.test(text) || resourceIds[id]) return '#f2c94c';
  if (/unlock|circle|upgrade|range/i.test(text)) return '#f59e0b';
  if (/customer|queue|crowd|people|npc/i.test(text)) return '#8b5cf6';
  if (/fog|smoke|effect|question/i.test(text)) return '#94a3b8';
  if (/window|table|oven|grill|station|seat|area/i.test(text)) return '#38bdf8';
  return '#7dd3fc';
}

function entityHaystack(id, kind, label) {
  return [id, kind, label].map(function(value) { return String(value || ''); }).join(' ');
}

function archetypeForEntity(id, kind, label, resourceIds) {
  var text = entityHaystack(id, kind, label);
  if (/speed|速度|\bstat\b/i.test(text)) return 'ring_marker';
  if (/npc_group|queue|customer|crowd|people|顾客|食客|排队|人群/i.test(text)) return 'npc_group';
  if (/unlock|upgrade|circle|range|解锁圈|升级圈|范围/i.test(text)) return 'ring_marker';
  if (/tray|托盘/i.test(text)) return 'tray';
  if (/player|chef|主厨|小主厨|hero|avatar/i.test(text)) return 'chef';
  if (/oven|烤箱|炉/i.test(text)) return /donut|甜甜圈/i.test(text) ? 'donut_oven' : 'oven';
  if (/shrimp|prawn|大虾|虾/i.test(text)) return 'shrimp';
  if (/grill|bbq|铁板|烧烤台|烤台/i.test(text)) return 'grill';
  if (/sofa|seat|chair|沙发|座位|座椅/i.test(text)) return 'sofa_seats';
  if (/table|餐桌|桌/i.test(text)) return 'table';
  if (/takeaway.*window|window|窗口|外卖窗口|station|柜台/i.test(text)) return 'service_window';
  if (/awning|遮阳棚|雨棚/i.test(text)) return 'awning';
  if (/road|street|马路|道路/i.test(text)) return 'road';
  if (/fog|迷雾|雾墙|边界/i.test(text)) return 'fog';
  if (/smoke|烟雾|烟|蒸汽/i.test(text)) return 'smoke';
  if (/donut|甜甜圈/i.test(text)) return 'donut';
  if (/money|cash|coin|钞票|现金|金币/i.test(text) || resourceIds[id] && /money|cash|coin/i.test(id)) return 'money_pile';
  if (/question|问号/i.test(text)) return 'question_marks';
  if (/area|zone|区域/i.test(text)) return 'floor_zone';
  if (/order|订单|打包/i.test(text)) return 'order_stack';
  return '';
}

function op(kind, position, size, color, extra) {
  var out = {
    kind: kind,
    position: position,
    size: size,
    color: color,
    source: 'storyboard-flow-archetype',
  };
  if (extra) Object.keys(extra).forEach(function(key) { out[key] = extra[key]; });
  return out;
}

function withOpacity(opValue, opacity) {
  opValue.opacity = opacity;
  return opValue;
}

function meshOpsForArchetype(archetype, baseColor) {
  var c = baseColor || '#7dd3fc';
  if (archetype === 'chef') return [
    op('cylinder', [0, 0.52, 0], [0.24, 0.3, 0.82], '#2563eb'),
    op('sphere', [0, 1.08, 0], [0.24], '#ffd7a8'),
    op('cylinder', [0, 1.36, 0], [0.18, 0.22, 0.16], '#ffffff'),
    op('box', [0.34, 0.72, -0.08], [0.44, 0.08, 0.32], '#d97706'),
  ];
  if (archetype === 'donut_oven' || archetype === 'oven') return [
    op('box', [0, 0.55, 0], [1.28, 0.96, 0.9], c),
    op('box', [0, 0.58, -0.47], [0.82, 0.48, 0.05], '#0f172a'),
    op('box', [0, 0.25, -0.53], [1.02, 0.08, 0.16], '#94a3b8'),
    op('torus', [0, 0.58, -0.58], [0.22, 0.06], '#f59e0b', { rotation: [1.5708, 0, 0] }),
    op('box', [-0.35, 1.08, 0.1], [0.18, 0.08, 0.36], '#e2e8f0'),
    op('box', [0, 1.08, 0.1], [0.18, 0.08, 0.36], '#e2e8f0'),
    op('box', [0.35, 1.08, 0.1], [0.18, 0.08, 0.36], '#e2e8f0'),
  ];
  if (archetype === 'grill') return [
    op('box', [0, 0.46, 0], [1.5, 0.48, 0.9], '#334155'),
    op('box', [0, 0.75, 0], [1.62, 0.12, 0.98], '#0f172a'),
    op('box', [-0.38, 0.84, 0], [0.08, 0.08, 0.86], '#94a3b8'),
    op('box', [0, 0.84, 0], [0.08, 0.08, 0.86], '#94a3b8'),
    op('box', [0.38, 0.84, 0], [0.08, 0.08, 0.86], '#94a3b8'),
    withOpacity(op('sphere', [-0.25, 1.2, -0.05], [0.16], '#cbd5e1'), 0.65),
    withOpacity(op('sphere', [0.05, 1.42, 0.1], [0.2], '#e2e8f0'), 0.52),
    withOpacity(op('sphere', [0.34, 1.22, 0], [0.15], '#cbd5e1'), 0.6),
  ];
  if (archetype === 'table') return [
    op('box', [0, 0.72, 0], [1.5, 0.16, 0.9], '#8b5a2b'),
    op('box', [-0.55, 0.36, -0.3], [0.12, 0.66, 0.12], '#6b3f1d'),
    op('box', [0.55, 0.36, -0.3], [0.12, 0.66, 0.12], '#6b3f1d'),
    op('box', [-0.55, 0.36, 0.3], [0.12, 0.66, 0.12], '#6b3f1d'),
    op('box', [0.55, 0.36, 0.3], [0.12, 0.66, 0.12], '#6b3f1d'),
  ];
  if (archetype === 'sofa_seats') return [
    op('box', [-0.42, 0.36, 0], [0.76, 0.32, 0.68], '#2563eb'),
    op('box', [0.42, 0.36, 0], [0.76, 0.32, 0.68], '#3b82f6'),
    op('box', [0, 0.72, 0.28], [1.72, 0.7, 0.18], '#1d4ed8'),
    op('box', [-0.94, 0.52, 0], [0.18, 0.54, 0.72], '#1e40af'),
    op('box', [0.94, 0.52, 0], [0.18, 0.54, 0.72], '#1e40af'),
  ];
  if (archetype === 'service_window') return [
    op('box', [0, 0.78, 0], [1.5, 1.2, 0.24], '#ef4444'),
    op('box', [0, 0.9, -0.14], [0.95, 0.48, 0.08], '#0f172a'),
    op('box', [0, 0.38, -0.28], [1.65, 0.18, 0.48], '#f97316'),
    op('box', [-0.66, 1.52, -0.06], [0.28, 0.18, 0.36], '#fde68a'),
    op('box', [-0.22, 1.52, -0.06], [0.28, 0.18, 0.36], '#f87171'),
    op('box', [0.22, 1.52, -0.06], [0.28, 0.18, 0.36], '#fde68a'),
    op('box', [0.66, 1.52, -0.06], [0.28, 0.18, 0.36], '#f87171'),
  ];
  if (archetype === 'awning') return [
    op('box', [-0.42, 1.05, 0], [0.44, 0.14, 1.08], '#ef4444'),
    op('box', [0, 1.05, 0], [0.44, 0.14, 1.08], '#fef3c7'),
    op('box', [0.42, 1.05, 0], [0.44, 0.14, 1.08], '#ef4444'),
  ];
  if (archetype === 'road') return [op('plane', [0, 0.02, 0], [2.4, 1.2], '#475569', { rotation: [-1.5708, 0, 0] })];
  if (archetype === 'fog') return [withOpacity(op('box', [0, 0.55, 0], [1.9, 1.1, 0.18], '#94a3b8'), 0.42)];
  if (archetype === 'smoke') return [
    withOpacity(op('sphere', [-0.2, 0.72, 0], [0.28], '#cbd5e1'), 0.55),
    withOpacity(op('sphere', [0.05, 0.98, 0.06], [0.35], '#e2e8f0'), 0.46),
    withOpacity(op('sphere', [0.35, 0.8, -0.04], [0.24], '#cbd5e1'), 0.52),
  ];
  if (archetype === 'donut') return [
    op('torus', [0, 0.52, 0], [0.36, 0.11], '#f59e0b', { rotation: [1.5708, 0, 0] }),
    op('sphere', [-0.12, 0.64, -0.08], [0.035], '#f472b6'),
    op('sphere', [0.13, 0.64, 0.04], [0.035], '#a78bfa'),
    op('sphere', [0.03, 0.64, 0.14], [0.035], '#fef08a'),
  ];
  if (archetype === 'shrimp') return [
    op('sphere', [-0.24, 0.52, 0], [0.18], '#fb923c'),
    op('sphere', [-0.04, 0.58, 0], [0.2], '#f97316'),
    op('sphere', [0.18, 0.54, 0], [0.17], '#fb923c'),
    op('cone', [0.42, 0.55, 0], [0.16, 0, 0.34], '#fed7aa', { rotation: [0, 0, -1.5708] }),
    op('sphere', [-0.4, 0.68, 0.07], [0.04], '#111827'),
  ];
  if (archetype === 'money_pile') return [
    op('box', [-0.28, 0.2, -0.16], [0.68, 0.08, 0.38], '#16a34a'),
    op('box', [0.24, 0.3, 0.02], [0.68, 0.08, 0.38], '#22c55e'),
    op('box', [-0.04, 0.42, 0.18], [0.72, 0.08, 0.38], '#4ade80'),
    op('box', [0.04, 0.55, -0.02], [0.58, 0.08, 0.34], '#86efac'),
  ];
  if (archetype === 'tray') return [
    op('box', [0, 0.55, 0], [1.15, 0.1, 0.62], '#a16207'),
    op('box', [0, 0.64, 0.28], [1.2, 0.12, 0.08], '#d97706'),
    op('box', [0, 0.64, -0.28], [1.2, 0.12, 0.08], '#d97706'),
  ];
  if (archetype === 'ring_marker') return [op('torus', [0, 0.12, 0], [0.72, 0.08], c, { rotation: [1.5708, 0, 0] })];
  if (archetype === 'question_marks') return [
    op('torus', [-0.22, 0.72, 0], [0.16, 0.04], '#facc15'),
    op('box', [-0.22, 0.42, 0], [0.08, 0.2, 0.08], '#facc15'),
    op('sphere', [-0.22, 0.22, 0], [0.05], '#facc15'),
    op('torus', [0.26, 0.82, 0], [0.18, 0.04], '#fde047'),
    op('box', [0.26, 0.48, 0], [0.08, 0.24, 0.08], '#fde047'),
    op('sphere', [0.26, 0.22, 0], [0.05], '#fde047'),
  ];
  if (archetype === 'floor_zone') return [withOpacity(op('plane', [0, 0.03, 0], [2.2, 1.4], c, { rotation: [-1.5708, 0, 0] }), 0.48)];
  if (archetype === 'order_stack') return [
    op('box', [-0.18, 0.24, 0], [0.46, 0.09, 0.36], '#f8fafc'),
    op('box', [0.08, 0.38, 0.04], [0.46, 0.09, 0.36], '#bae6fd'),
    op('box', [0.25, 0.52, -0.02], [0.42, 0.09, 0.32], '#f8fafc'),
  ];
  return [];
}

function labelYOffsetForArchetype(archetype) {
  if (/oven|grill|service_window|awning/.test(archetype)) return 2.0;
  if (/sofa|chef|question/.test(archetype)) return 1.75;
  if (/road|floor_zone|ring_marker/.test(archetype)) return 0.8;
  if (/donut|shrimp|money_pile|tray|order_stack/.test(archetype)) return 1.15;
  return 1.55;
}

function computePhasePositionBounds(phases) {
  var points = phases.map(function(phase, index) {
    var pos = isObject(phase.position) ? phase.position : {};
    return {
      x: numberValue(pos.x != null ? pos.x : phase.x, index * 280),
      y: numberValue(pos.y != null ? pos.y : phase.y, 0),
    };
  });
  var xs = points.map(function(point) { return point.x; });
  var ys = points.map(function(point) { return point.y; });
  return {
    points: points,
    minX: Math.min.apply(Math, xs),
    maxX: Math.max.apply(Math, xs),
    minY: Math.min.apply(Math, ys),
    maxY: Math.max.apply(Math, ys),
  };
}

function mapFlowPosition(point, bounds, offsetIndex) {
  var rangeX = Math.max(1, bounds.maxX - bounds.minX);
  var rangeY = Math.max(1, bounds.maxY - bounds.minY);
  var baseX = ((point.x - bounds.minX) / rangeX - 0.5) * 34;
  var baseZ = ((point.y - bounds.minY) / rangeY - 0.5) * 22;
  var angle = (offsetIndex % 8) / 8 * Math.PI * 2;
  var ring = offsetIndex === 0 ? 0 : 6.8 + Math.floor(offsetIndex / 8) * 2.2;
  return [
    Number((baseX + Math.cos(angle) * ring).toFixed(2)),
    0,
    Number((baseZ + Math.sin(angle) * ring).toFixed(2)),
  ];
}

function assignEntityPositions(phases, entityIds) {
  var bounds = computePhasePositionBounds(phases);
  var firstSeen = {};
  phases.forEach(function(phase, phaseIndex) {
    uniqueStrings(phase.visibleEntities.concat([phase.target || ''])).forEach(function(id, localIndex) {
      if (!entityIds[id] || firstSeen[id]) return;
      firstSeen[id] = { phaseIndex: phaseIndex, localIndex: localIndex };
    });
  });
  var fallbackIndex = 0;
  Object.keys(entityIds).forEach(function(id) {
    if (!firstSeen[id]) firstSeen[id] = { phaseIndex: fallbackIndex++, localIndex: 0 };
  });
  var positions = {};
  Object.keys(entityIds).forEach(function(id) {
    if (id === 'Player') {
      positions[id] = [0, 0, 0];
      return;
    }
    var seen = firstSeen[id];
    var point = bounds.points[seen.phaseIndex] || { x: seen.phaseIndex * 280, y: 0 };
    positions[id] = mapFlowPosition(point, bounds, seen.localIndex);
  });
  return positions;
}

function isNpcGroupEntity(id, kind, label) {
  var text = [id, kind, label].map(function(value) { return String(value || ''); }).join(' ');
  return /npc_group|queue|customer|crowd|people|顾客|食客|排队|人群/i.test(text);
}

function inferNpcGroupCount(id, kind, label, phases) {
  if (!isNpcGroupEntity(id, kind, label)) return 0;
  var haystacks = [];
  safeArray(phases).forEach(function(phase) {
    if (safeArray(phase.visibleEntities).indexOf(id) < 0 && String(phase.target || '') !== id) return;
    haystacks.push([
      phase.title,
      phase.guideText,
      phase.visualNotes,
      phase.notes,
      safeArray(phase.requiredInteractions).join(' '),
    ].join(' '));
  });
  for (var i = 0; i < haystacks.length; i += 1) {
    var match = String(haystacks[i] || '').match(/(\d+)\s*(?:名|个|位)?\s*(?:新)?(?:顾客|食客|客人|人群|人)/);
    if (match) return Math.max(2, Math.min(10, Number(match[1]) || 4));
  }
  var text = [id, kind, label].join(' ');
  if (/queue|排队|人群|大排长龙/i.test(text)) return 6;
  return 4;
}

function buildEntities(phases, catalog, ids) {
  var positions = assignEntityPositions(phases, ids.entityIds);
  return Object.keys(ids.entityIds).sort(function(a, b) {
    if (a === 'Player') return -1;
    if (b === 'Player') return 1;
    return a.localeCompare(b);
  }).map(function(id) {
    var source = catalog.entities[id] || {};
    var kind = source.kind || source.type || (id === 'Player' ? 'player' : (ids.resourceIds[id] ? 'resource' : 'prop'));
    var label = String(source.label || source.chineseName || source.name || labelFromId(id));
    var groupCount = inferNpcGroupCount(id, kind, label, phases);
    var archetype = archetypeForEntity(id, kind, label, ids.resourceIds);
    var baseColor = colorForEntity(id, kind, ids.resourceIds);
    var visualDefaults = {
      primitive: primitiveForEntity(id, kind, ids.resourceIds),
      color: baseColor,
      archetype: archetype || null,
      meshOps: archetype ? meshOpsForArchetype(archetype, baseColor) : [],
    };
    if (archetype) visualDefaults.labelYOffset = labelYOffsetForArchetype(archetype);
    if (groupCount) {
      visualDefaults.groupCount = groupCount;
      visualDefaults.queueSpacing = 0.84;
    }
    return {
      id: id,
      label: label,
      kind: kind,
      position: source.position || positions[id],
      scale: source.scale || [1, 1, 1],
      visibleFromPhase: source.visibleFromPhase || null,
      visual: Object.assign(visualDefaults, isObject(source.visual) ? source.visual : {}),
      binding: source.binding || null,
    };
  });
}

function carrierForResource(resourceId, phase, catalog, entityIds) {
  var fromCatalog = catalog.resources[resourceId] && (catalog.resources[resourceId].carrierEntity || catalog.resources[resourceId].entity);
  if (fromCatalog) return cleanId(fromCatalog, resourceId);
  var visible = uniqueStrings(phase && phase.visibleEntities || []);
  for (var i = 0; i < visible.length; i += 1) {
    if (visible[i] === resourceId || visible[i].toLowerCase().indexOf(String(resourceId).toLowerCase()) >= 0) return visible[i];
  }
  if (entityIds[resourceId]) return resourceId;
  return resourceId;
}

function buildResources(phases, catalog, ids) {
  return Object.keys(ids.resourceIds).sort().map(function(id) {
    var source = catalog.resources[id] || {};
    return {
      id: id,
      label: String(source.label || source.chineseName || source.name || labelFromId(id)),
      kind: source.kind || source.type || 'resource',
      carrierEntity: cleanId(source.carrierEntity || source.entity || id, id),
      initial: numberValue(source.initial, 0),
    };
  });
}

function lastTargetStep(steps) {
  for (var i = steps.length - 1; i >= 0; i -= 1) {
    var step = steps[i];
    var target = step && (step.target || step.from || step.to || step.entity);
    if (target) return target;
  }
  return '';
}

function pushMoveTo(steps, target, radius) {
  target = cleanId(target, '');
  if (!target) return;
  for (var i = steps.length - 1; i >= 0; i -= 1) {
    if (steps[i] && steps[i].kind === 'move_to') {
      if (steps[i].target === target) return;
      break;
    }
  }
  steps.push({ kind: 'move_to', target: target, radius: radius || 1.8 });
}

function flowStepsForPhase(phase, catalog, entityIds, phaseIndex, phaseCount) {
  var steps = [];
  var costSpent = false;
  var interactions = phase.requiredInteractions.map(parseInteractionDsl).filter(Boolean);
  interactions.forEach(function(interaction) {
    var target = cleanId(interaction.target, '');
    var resource = cleanId(interaction.resource, '');
    if (interaction.verb === 'move_to') {
      pushMoveTo(steps, target, 1.8);
      return;
    }
    if (interaction.verb === 'collect') {
      var from = carrierForResource(resource, phase, catalog, entityIds);
      pushMoveTo(steps, from, 1.6);
      steps.push({ kind: 'collect', resource: resource, amount: interaction.amount || 1, target: from, from: from });
      return;
    }
    if (interaction.verb === 'produce') {
      var produceTarget = carrierForResource(resource, phase, catalog, entityIds);
      steps.push({ kind: 'produce', resource: resource, amount: interaction.amount || 1, target: produceTarget });
      return;
    }
    if (interaction.verb === 'reward') {
      var rewardTarget = carrierForResource(resource, phase, catalog, entityIds);
      steps.push({ kind: 'reward', resource: resource, amount: interaction.amount || 1, target: rewardTarget });
      return;
    }
    if (interaction.verb === 'deliver' || interaction.verb === 'transfer') {
      pushMoveTo(steps, target, 1.8);
      steps.push({ kind: interaction.verb, resource: resource, amount: interaction.amount || 1, target: target, to: target });
      return;
    }
    if (interaction.verb === 'combine') {
      pushMoveTo(steps, target, 1.8);
      steps.push({ kind: 'combine', resource: resource, amount: interaction.amount || 1, target: target, entity: target, state: 2 });
      return;
    }
    if (interaction.verb === 'unlock' || interaction.verb === 'build') {
      var approachTarget = lastTargetStep(steps);
      if (!approachTarget && phase.target) approachTarget = phase.target;
      if (approachTarget) pushMoveTo(steps, approachTarget, 1.8);
      if (!costSpent) costSpent = pushPhaseCostSpend(steps, phase, approachTarget || target);
      steps.push({ kind: interaction.verb, target: approachTarget || target, entity: target, state: interaction.verb === 'build' ? 2 : 1 });
      return;
    }
    if (interaction.verb === 'upgrade') {
      var upgradeApproachTarget = lastTargetStep(steps) || phase.target || target;
      pushMoveTo(steps, upgradeApproachTarget, 1.8);
      if (!costSpent) costSpent = pushPhaseCostSpend(steps, phase, upgradeApproachTarget || target);
      steps.push({ kind: 'upgrade', target: upgradeApproachTarget, entity: target, level: interaction.amount || 2 });
      return;
    }
    if (interaction.verb === 'show' || interaction.verb === 'spawn' || interaction.verb === 'hide' || interaction.verb === 'despawn') {
      steps.push({ kind: interaction.verb, target: target, entity: target, state: interaction.verb === 'hide' || interaction.verb === 'despawn' ? 0 : 1 });
      return;
    }
    if (interaction.verb === 'select') {
      pushMoveTo(steps, target, 1.5);
      steps.push({ kind: 'select', target: target, entity: target, state: 1 });
      return;
    }
    if (interaction.verb === 'attack') {
      pushMoveTo(steps, target, 1.6);
      steps.push({ kind: 'attack', target: target, entity: target, state: 0 });
      return;
    }
    if (interaction.verb === 'wait') {
      steps.push({ kind: 'wait', seconds: interaction.amount || 1 });
      return;
    }
    if (interaction.verb === 'click' && phaseIndex === phaseCount - 1) {
      steps.push({ kind: 'cta_finish', ctaId: target || 'CtaButton' });
      return;
    }
  });
  if (!costSpent) pushPhaseCostSpend(steps, phase, phase.target);
  if (!steps.length) steps.push({ kind: 'wait', seconds: 1 });
  return steps;
}

function parseConditionGate(part, resourceIds) {
  var match = String(part || '').match(/^([A-Za-z][A-Za-z0-9_-]*)(?:\.amount)?\s*>=\s*([0-9]+)/);
  if (match) return { kind: 'resource', resource: cleanId(match[1], ''), threshold: numberValue(match[2], 1) };
  match = String(part || '').match(/^([A-Za-z][A-Za-z0-9_-]*)\.level\s*==\s*([0-9]+)/);
  if (match) return { kind: 'entity_state', entity: cleanId(match[1], ''), state: numberValue(match[2], 1) };
  match = String(part || '').match(/^([A-Za-z][A-Za-z0-9_-]*)\.(unlocked|visible|packed)\s*==\s*true/i);
  if (match) return { kind: 'entity_state', entity: cleanId(match[1], ''), state: 1 };
  match = String(part || '').match(/^([A-Za-z][A-Za-z0-9_-]*)\.(unlocked|visible|packed)\s*$/i);
  if (match) return { kind: 'entity_state', entity: cleanId(match[1], ''), state: 1 };
  match = String(part || '').match(/^([A-Za-z][A-Za-z0-9_-]*)\.clicked\s*==\s*true/i);
  if (match) return { kind: 'cta_arrival', ctaId: cleanId(match[1], 'CtaButton') };
  match = String(part || '').match(/^([A-Za-z][A-Za-z0-9_-]*)\.clicked\s*$/i);
  if (match) return { kind: 'cta_arrival', ctaId: cleanId(match[1], 'CtaButton') };
  match = String(part || '').match(/^([A-Za-z][A-Za-z0-9_-]*)\s*>=\s*([0-9]+)/);
  if (match && resourceIds[cleanId(match[1], '')]) {
    return { kind: 'resource', resource: cleanId(match[1], ''), threshold: numberValue(match[2], 1) };
  }
  return null;
}

function gateFromSteps(phase, steps, resourceIds, index, phaseCount) {
  if (index === phaseCount - 1 || String(phase.action || '') === 'cta_finish') {
    return { kind: 'cta_arrival', ctaId: 'CtaButton', radius: 2 };
  }
  var conditionGates = splitConditionParts(phase.completeCondition).map(function(part) {
    return parseConditionGate(part, resourceIds);
  }).filter(Boolean);
  if (conditionGates.length === 1) return conditionGates[0];
  if (conditionGates.length > 1) return { kind: 'compound_all', gates: conditionGates };
  for (var i = steps.length - 1; i >= 0; i -= 1) {
    var step = steps[i];
    if (!step) continue;
    if ((step.kind === 'collect' || step.kind === 'produce' || step.kind === 'reward') && step.resource) {
      return { kind: 'resource', resource: step.resource, threshold: step.amount || 1 };
    }
    if ((step.kind === 'unlock' || step.kind === 'build' || step.kind === 'upgrade' || step.kind === 'combine' || step.kind === 'show' || step.kind === 'select') && (step.entity || step.target)) {
      return { kind: 'entity_state', entity: step.entity || step.target, state: step.level != null ? step.level : (step.state != null ? step.state : 1) };
    }
    if ((step.kind === 'deliver' || step.kind === 'transfer' || step.kind === 'move_to') && (step.target || step.to)) {
      return { kind: 'near_entity', entity: step.target || step.to, radius: step.radius || 1.8 };
    }
    if (step.kind === 'wait') return { kind: 'timer', seconds: step.seconds || 1 };
  }
  return { kind: 'timer', seconds: 1 };
}

function plannedModulesForSteps(steps) {
  var modules = ['guide_ui', 'visual_binding'];
  function add(id) {
    if (modules.indexOf(id) < 0) modules.push(id);
  }
  safeArray(steps).forEach(function(step) {
    if (!step) return;
    if (step.target || step.from || step.to || step.entity) {
      add('player_input_joystick');
      add('move_to_target');
      add('proximity_trigger');
    }
    if (step.kind === 'select') add('player_input_tap');
    if (step.kind === 'collect') add('collect_on_near');
    if (step.kind === 'collect' || step.kind === 'produce' || step.kind === 'reward' ||
      step.kind === 'deliver' || step.kind === 'transfer' || step.kind === 'combine' || step.kind === 'set_resource') {
      add('inventory_wallet');
    }
    if (step.kind === 'unlock' || step.kind === 'build') add('build_progress');
    if (step.kind === 'upgrade' || step.kind === 'combine') add('upgrade_progress');
    if (step.kind === 'show' || step.kind === 'spawn' || step.kind === 'hide' || step.kind === 'despawn') add('spawn_once');
    if (step.kind === 'cta_finish') add('cta_finish');
  });
  return modules;
}

function stepSatisfiesEntityState(step, entity) {
  if (!step || !entity) return false;
  if ((step.entity || step.target) !== entity) return false;
  return step.kind === 'set_entity_state' || step.kind === 'unlock' || step.kind === 'build' ||
    step.kind === 'upgrade' || step.kind === 'combine' || step.kind === 'show' || step.kind === 'select' ||
    step.kind === 'attack';
}

function stepIncrementsResource(step, resource) {
  return !!(step && resource && step.resource === resource &&
    (step.kind === 'collect' || step.kind === 'produce' || step.kind === 'reward' || step.kind === 'set_resource'));
}

function ensureStepsSatisfyGate(steps, gate) {
  steps = safeArray(steps).map(clone);
  function ensure(child) {
    if (!isObject(child)) return;
    if (child.kind === 'compound_all' || child.kind === 'compound_any') {
      safeArray(child.gates).forEach(ensure);
      return;
    }
    if (child.kind === 'entity_state') {
      var entity = child.entity || child.target;
      if (entity && !steps.some(function(step) { return stepSatisfiesEntityState(step, entity); })) {
        steps.push({ kind: 'set_entity_state', entity: entity, state: child.state == null ? 1 : child.state });
      }
    }
    if (child.kind === 'resource') {
      var resource = child.resource;
      if (resource && !steps.some(function(step) { return stepIncrementsResource(step, resource); })) {
        steps.push({ kind: 'set_resource', resource: resource, amount: child.threshold || child.amount || 1 });
      }
    }
  }
  ensure(gate);
  return steps;
}

function showEntitiesForPhase(phase, steps) {
  var ids = ['Player'].concat(phase.visibleEntities || []);
  safeArray(steps).forEach(function(step) {
    ['target', 'from', 'to', 'entity'].forEach(function(key) {
      if (step && step[key]) ids.push(step[key]);
    });
  });
  return uniqueStrings(ids);
}

function buildPhases(phases, catalog, ids) {
  var count = phases.length;
  return phases.map(function(phase, index) {
    var steps = flowStepsForPhase(phase, catalog, ids.entityIds, index, count);
    var gate = gateFromSteps(phase, steps, ids.resourceIds, index, count);
    steps = ensureStepsSatisfyGate(steps, gate);
    var guideText = String(phase.guideText || phase.guide || phase.title || phase.id);
    return {
      id: 'phase' + (index + 1),
      title: phase.title,
      guideText: guideText,
      goalText: index === count - 1 ? guideText : String(phase.goalText || phase.goal || ''),
      showEntities: showEntitiesForPhase(phase, steps),
      steps: steps,
      gate: gate,
      duration: phase.duration || { min: 8, max: 16 },
      plannedModuleIds: plannedModulesForSteps(steps),
      hudText: null,
      targetSequence: uniqueStrings(steps.map(function(step) {
        return step.target || step.from || step.to || step.entity || '';
      })),
      sourceFlowPhaseId: phase.id,
    };
  });
}

function buildScene(flow) {
  var scene = isObject(flow && flow.scene) ? clone(flow.scene) : {};
  if (!scene.backgroundColor) scene.backgroundColor = '#10231f';
  if (!scene.ground) scene.ground = { kind: 'plane', size: [58, 40], color: '#20433a' };
  if (!scene.camera) scene.camera = { kind: 'perspective', fov: 58, position: [0, 28, 38], lookAt: [0, 0, 0] };
  return scene;
}

function normalizeProject(flow) {
  var storyboardProject = flow && flow.storyboardIrCandidate && flow.storyboardIrCandidate.project || {};
  var project = isObject(flow && flow.project) ? flow.project : {};
  return {
    name: String(project.name || flow && flow.projectName || storyboardProject.name || 'storyboard-flow'),
    theme: project.theme || flow && flow.theme || storyboardProject.theme || 'default',
  };
}

function buildSourceSceneIrFromStoryboardFlow(flow, options) {
  options = options || {};
  if (!isObject(flow)) throw new Error('Storyboard flow must be an object');
  var authoringReport = preflightStoryboardFlow(flow, options);
  if (authoringReport.passed !== true) {
    throw new Error('Storyboard flow authoring preflight failed: ' + authoringReport.issues.filter(function(issue) {
      return issue.severity === 'blocker';
    }).slice(0, 5).map(function(issue) {
      return issue.code + (issue.phaseId ? ' ' + issue.phaseId : '');
    }).join('; '));
  }
  var phases = normalizeFlowPhases(flow);
  if (!phases.length) throw new Error('Storyboard flow requires phases[]');
  var catalog = collectCatalog(flow);
  var ids = collectSemanticIds(phases, catalog);
  var sourceIr = {
    schemaVersion: SOURCE_SCENE_IR_SCHEMA_VERSION,
    kind: 'blueprint.sourceSceneIR',
    generatedAt: options.generatedAt || flow.generatedAt,
    source: {
      htmlPath: options.sourceHtmlPath || null,
      htmlSha256: null,
    },
    project: normalizeProject(flow),
    scene: buildScene(flow),
    entities: buildEntities(phases, catalog, ids),
    resources: buildResources(phases, catalog, ids),
    phases: buildPhases(phases, catalog, ids),
    hud: {
      tip: { source: 'phase.guideText' },
      resourceBar: Object.keys(ids.resourceIds).sort(),
      cta: { ctaId: 'CtaButton', arrivalGated: true },
    },
    runtimeContract: {
      requiresJoystick: true,
      requiresArrivalGate: true,
      forbidAutoplayProgress: true,
      phaseCount: phases.length,
    },
    extraction: {
      carrier: 'storyboard-flow-authoring',
      sourceSchemaVersion: flow.schemaVersion || null,
      sourceKind: flow.kind || null,
      sourcePdf: flow.sourcePdf || null,
      legacyProjectionUsed: false,
    },
    diagnostics: {
      authoring: {
        preflight: {
          passed: authoringReport.passed,
          issueCounts: authoringReport.issueCounts,
        },
        warnings: safeArray(flow.diagnostics),
        issues: authoringReport.issues.concat(phases.reduce(function(all, phase) {
          return all.concat(safeArray(phase.issues).map(function(issue) {
            return { phaseId: phase.id, issue: issue };
          }));
        }, [])),
      },
    },
  };
  var normalized = normalizeSourceSceneIr(sourceIr, {
    sourceHtmlPath: options.sourceHtmlPath,
    sourceHtmlSha256: options.sourceHtmlSha256,
    generatedAt: options.generatedAt,
    html: options.html || '<div id="joystick"></div>',
  });
  validateSourceSceneIr(normalized);
  return normalized;
}

function loadStoryboardFlow(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

module.exports = {
  FLOW_SCHEMA_VERSION: FLOW_SCHEMA_VERSION,
  FLOW_KIND: FLOW_KIND,
  FLOW_CONTRACT_PATH: FLOW_CONTRACT_PATH,
  parseInteractionDsl: parseInteractionDsl,
  preflightStoryboardFlow: preflightStoryboardFlow,
  computeFlowResourceSnapshots: computeFlowResourceSnapshots,
  buildSourceSceneIrFromStoryboardFlow: buildSourceSceneIrFromStoryboardFlow,
  loadStoryboardFlow: loadStoryboardFlow,
};
