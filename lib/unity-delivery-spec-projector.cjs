#!/usr/bin/env node
'use strict';

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var profiles = require('./unitycomponent-profile-registry.cjs');

var KIND = 'blueprint.unityDeliverySpec';
var SCHEMA_VERSION = 'unity-delivery-spec.v1';

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniq(values) {
  var seen = Object.create(null);
  var out = [];
  safeArray(values).forEach(function(value) {
    var text = String(value || '').trim();
    if (!text || seen[text]) return;
    seen[text] = true;
    out.push(text);
  });
  return out;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (isObject(value)) {
    var out = {};
    Object.keys(value).sort().forEach(function(key) {
      out[key] = stable(value[key]);
    });
    return out;
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stable(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function sanitizeId(value, fallback) {
  var text = String(value || fallback || 'item').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!text) text = String(fallback || 'item');
  if (!/^[A-Za-z_]/.test(text)) text = '_' + text;
  return text;
}

function pascal(value, fallback) {
  return sanitizeId(value, fallback)
    .split(/_+/)
    .filter(Boolean)
    .map(function(part) { return part.charAt(0).toUpperCase() + part.slice(1); })
    .join('') || sanitizeId(fallback || 'Item', 'Item');
}

function entityId(entity, index) {
  return sanitizeId(entity && (entity.id || entity.name || entity.entityId), 'Entity' + (index + 1));
}

function lowerText(value) {
  return String(value || '').toLowerCase();
}

function entityKind(entity) {
  return lowerText(entity && (entity.kind || entity.type || entity.role || entity.category));
}

function isPlayerEntity(entity, id) {
  var text = lowerText(id + ' ' + entityKind(entity) + ' ' + (entity && entity.label || ''));
  return /\b(player|hero|avatar|character)\b/.test(text);
}

function isUiEntity(entity, id) {
  var text = lowerText(id + ' ' + entityKind(entity) + ' ' + (entity && entity.label || ''));
  return /\b(ui|hud|button|cta|label|dialog|popup)\b/.test(text);
}

function isPoolEntity(entity, id) {
  var text = lowerText(id + ' ' + entityKind(entity) + ' ' + (entity && entity.label || ''));
  return /\b(bullet|projectile|drop|loot|effect|fx|vfx|floating|toast|minion|wave|pickup|hitmarker|hit_marker)\b/.test(text);
}

function sourceEntityIds(sourceIr) {
  return safeArray(sourceIr && sourceIr.entities).map(entityId);
}

function normalizeStepTarget(step) {
  if (!isObject(step)) return '';
  return sanitizeId(step.target || step.targetEntity || step.entity || step.from || step.to || step.source || '', '');
}

function targetSequenceForPhase(phase) {
  var explicit = phase && (phase.targetSequence || phase.targets);
  if (Array.isArray(explicit)) return uniq(explicit.map(function(item) {
    return sanitizeId(isObject(item) ? (item.id || item.entity || item.target) : item, '');
  }));
  var targets = [];
  safeArray(phase && phase.steps).forEach(function(step) {
    var target = normalizeStepTarget(step);
    if (target) targets.push(target);
  });
  var gate = phase && (phase.gate || phase.trigger) || {};
  ['target', 'targetEntity', 'entity', 'from', 'resource'].forEach(function(key) {
    if (gate[key]) targets.push(sanitizeId(gate[key], ''));
  });
  if (!targets.length) {
    safeArray(phase && phase.showEntities).forEach(function(name) {
      var id = sanitizeId(name, '');
      if (id && !/^player$/i.test(id)) targets.push(id);
    });
  }
  return uniq(targets);
}

function normalizeGate(gate) {
  if (!isObject(gate)) return {};
  var out = {};
  Object.keys(gate).sort().forEach(function(key) {
    if (gate[key] !== undefined) out[key] = gate[key];
  });
  return out;
}

function sourcePhaseProjection(sourceIr) {
  return safeArray(sourceIr && sourceIr.phases).map(function(phase, index) {
    return {
      id: String(phase.id || phase.phaseId || ('phase' + (index + 1))),
      index: index,
      guideText: String(phase.guideText || ''),
      showEntities: uniq(phase.showEntities || phase.entities || []),
      targetSequence: targetSequenceForPhase(phase),
      gate: normalizeGate(phase.gate || phase.trigger || {}),
      steps: safeArray(phase.steps).map(function(step) { return stable(step); })
    };
  });
}

function sourceResourceProjection(sourceIr) {
  return safeArray(sourceIr && sourceIr.resources).map(function(resource, index) {
    return {
      id: sanitizeId(resource.id || resource.name, 'Resource' + (index + 1)),
      label: resource.label || resource.name || resource.id || '',
      kind: resource.kind || resource.type || 'resource'
    };
  });
}

function sourceSemanticProjection(sourceIr) {
  return {
    phases: sourcePhaseProjection(sourceIr),
    entities: sourceEntityIds(sourceIr),
    resources: sourceResourceProjection(sourceIr)
  };
}

function featureEvidence(sourceIr) {
  var evidence = {
    move: [],
    attack: [],
    hp: [],
    pickup: [],
    stack: [],
    resource: [],
    build: [],
    skill: []
  };
  function add(feature, reason) {
    if (evidence[feature] && evidence[feature].indexOf(reason) < 0) evidence[feature].push(reason);
  }
  safeArray(sourceIr && sourceIr.phases).forEach(function(phase) {
    var phaseId = phase.id || phase.phaseId || 'phase';
    safeArray(phase.plannedModuleIds).forEach(function(id) {
      var text = lowerText(id);
      if (/move|joystick|drag|path|nav/.test(text)) add('move', phaseId + ':module:' + id);
      if (/attack|combat|damage|shoot|weapon/.test(text)) add('attack', phaseId + ':module:' + id);
      if (/\bhp\b|health|damage|combat/.test(text)) add('hp', phaseId + ':module:' + id);
      if (/collect|pickup|drop|loot/.test(text)) add('pickup', phaseId + ':module:' + id);
      if (/stack|inventory|carry|wallet/.test(text)) add('stack', phaseId + ':module:' + id);
      if (/resource|wallet|currency|collect/.test(text)) add('resource', phaseId + ':module:' + id);
      if (/build|upgrade|craft|merge/.test(text)) add('build', phaseId + ':module:' + id);
      if (/skill|spell|ability/.test(text)) add('skill', phaseId + ':module:' + id);
    });
    safeArray(phase.steps).forEach(function(step, idx) {
      var text = lowerText(JSON.stringify(step || {}));
      var label = phaseId + ':step' + idx;
      if (/move|near|arriv|joystick|drag/.test(text)) add('move', label);
      if (/attack|combat|damage|shoot|hit/.test(text)) add('attack', label);
      if (/\bhp\b|health|damage/.test(text)) add('hp', label);
      if (/collect|pickup|drop|loot/.test(text)) add('pickup', label);
      if (/stack|inventory|carry/.test(text)) add('stack', label);
      if (/resource|currency|wallet|amount/.test(text)) add('resource', label);
      if (/build|upgrade|craft/.test(text)) add('build', label);
      if (/skill|spell|ability/.test(text)) add('skill', label);
    });
    var gateText = lowerText(JSON.stringify(phase.gate || phase.trigger || {}));
    if (/resource|collect|currency/.test(gateText)) add('resource', phaseId + ':gate');
    if (/attack|damage|hp|combat/.test(gateText)) {
      add('attack', phaseId + ':gate');
      add('hp', phaseId + ':gate');
    }
  });
  return evidence;
}

function buildEntitySpecs(sourceIr, unityAssetPlan) {
  var bindings = unityAssetPlan && unityAssetPlan.entityBindings || {};
  return safeArray(sourceIr && sourceIr.entities).map(function(entity, index) {
    var id = entityId(entity, index);
    var pool = isPoolEntity(entity, id);
    var ui = isUiEntity(entity, id);
    var player = isPlayerEntity(entity, id);
    var binding = bindings[id] || bindings[entity.name] || bindings[entity.id] || {};
    return {
      sourceId: id,
      sourceKind: entity.kind || entity.type || '',
      unityClass: pascal(id, player ? 'Player' : 'Entity') + 'Entity',
      prefabPath: binding.prefabPath || ('Assets/BlueprintDelivery/Prefabs/' + pascal(id, 'Entity') + '.prefab'),
      bindingKind: pool ? 'poolArchetype' : (ui ? 'uiRef' : 'sceneRef'),
      sceneRefId: pool ? null : sanitizeId(id.charAt(0).toLowerCase() + id.slice(1), 'sceneRef'),
      poolArchetypeId: pool ? sanitizeId(id.charAt(0).toLowerCase() + id.slice(1), 'pool') : null,
      assetBindingId: binding.primaryAssetId || null
    };
  });
}

function componentSpecs(sourceIr, entitySpecs) {
  var evidence = featureEvidence(sourceIr);
  var player = entitySpecs.filter(function(entity) { return /player/i.test(entity.unityClass) || entity.sourceId === 'Player'; })[0] || entitySpecs[0];
  var specs = [];
  function add(entity, component, feature) {
    if (!entity || !evidence[feature] || evidence[feature].length === 0) return;
    specs.push({
      entityId: entity.sourceId,
      component: component,
      evidence: evidence[feature].slice()
    });
  }
  add(player, 'MoveComponent', 'move');
  add(player, 'PickUpComponent', 'pickup');
  add(player, 'StackComponent', 'stack');
  add(player, 'ResourceWalletComponent', 'resource');
  add(player, 'AttackComponent', 'attack');
  add(player, 'HpComponent', 'hp');
  add(player, 'BuildComponent', 'build');
  add(player, 'SkillComponent', 'skill');
  return specs;
}

function sceneRefs(entitySpecs) {
  return entitySpecs.filter(function(entity) {
    return entity.bindingKind === 'sceneRef';
  }).map(function(entity) {
    return {
      id: entity.sceneRefId,
      sourceId: entity.sourceId,
      prefabPath: entity.prefabPath,
      required: true
    };
  });
}

function poolArchetypes(entitySpecs) {
  return entitySpecs.filter(function(entity) {
    return entity.bindingKind === 'poolArchetype';
  }).map(function(entity) {
    return {
      id: entity.poolArchetypeId,
      sourceId: entity.sourceId,
      prefabPath: entity.prefabPath,
      preload: 4
    };
  });
}

function uiRefs(entitySpecs, sourceIr) {
  var out = [
    { id: 'uiRoot', role: 'root', required: true },
    { id: 'guideLabel', role: 'guideText', source: 'phase.guideText', required: true }
  ];
  entitySpecs.filter(function(entity) {
    return entity.bindingKind === 'uiRef';
  }).forEach(function(entity) {
    out.push({ id: entity.sceneRefId || entity.sourceId, role: entity.sourceKind || 'ui', sourceId: entity.sourceId, required: true });
  });
  if (sourceIr && sourceIr.hud && sourceIr.hud.cta) {
    out.push({ id: 'ctaButton', role: 'cta', sourceId: sourceIr.hud.cta.entity || '', required: true });
  }
  return out;
}

function assetBindings(assetManifest, unityAssetPlan) {
  var actions = unityAssetPlan && unityAssetPlan.actions || [];
  var byAsset = {};
  actions.forEach(function(action) {
    byAsset[action.assetId] = action;
  });
  return safeArray(assetManifest && assetManifest.assets).map(function(asset) {
    var action = byAsset[asset.assetId] || {};
    return {
      assetId: asset.assetId,
      kind: asset.kind || '',
      source: asset.source || null,
      prefabPath: action.prefabPath || null,
      materialPath: action.material && action.material.materialPath || action.materialPath || null,
      actionId: action.actionId || null,
      status: action.status || null
    };
  });
}

function buildUnityDeliverySpec(input, options) {
  options = options || {};
  var profile = profiles.resolveProfile(options.profile || 'unitycomponent-v1');
  if (profile.id !== 'unitycomponent-v1') {
    throw new Error('UnityDeliverySpec projector requires unitycomponent-v1 profile');
  }
  var sourceIr = input && input.sourceIr;
  if (!sourceIr || !Array.isArray(sourceIr.phases)) {
    throw new Error('UnityDeliverySpec projector requires sourceIr.phases');
  }
  var entitySpecs = buildEntitySpecs(sourceIr, input.unityAssetPlan || {});
  var semantic = sourceSemanticProjection(sourceIr);
  var spec = {
    schemaVersion: SCHEMA_VERSION,
    kind: KIND,
    profile: profile.id,
    targetFramework: profile.targetFramework,
    namespace: profile.namespace,
    generatedAt: options.generatedAt || new Date().toISOString(),
    source: {
      sourceIrSemanticHash: sourceIr.semanticHash || null,
      sourceHtmlSha256: sourceIr.source && sourceIr.source.htmlSha256 || null,
      gameSchemaHash: input.gameSchema ? sha256(input.gameSchema) : null,
      playableSceneIrHash: input.playableSceneIr && input.playableSceneIr.semanticHash || null,
      assetManifestHash: input.assetManifest ? sha256(input.assetManifest) : null,
      unityAssetPlanHash: input.unityAssetPlan ? sha256(input.unityAssetPlan) : null
    },
    semanticProjection: semantic,
    entities: entitySpecs,
    components: componentSpecs(sourceIr, entitySpecs),
    phases: semantic.phases,
    resources: semantic.resources,
    sceneRefs: sceneRefs(entitySpecs),
    poolArchetypes: poolArchetypes(entitySpecs),
    uiRefs: uiRefs(entitySpecs, sourceIr),
    assetBindings: assetBindings(input.assetManifest || {}, input.unityAssetPlan || {}),
    diagnostics: {
      featureEvidence: featureEvidence(sourceIr),
      note: 'UnityDeliverySpec is a downstream projection. Unity runtime must use baked assets/refs, not this JSON.'
    }
  };
  spec.semanticHash = sha256({
    profile: spec.profile,
    targetFramework: spec.targetFramework,
    namespace: spec.namespace,
    semanticProjection: spec.semanticProjection,
    entities: spec.entities,
    components: spec.components,
    sceneRefs: spec.sceneRefs,
    poolArchetypes: spec.poolArchetypes,
    uiRefs: spec.uiRefs,
    assetBindings: spec.assetBindings
  });
  return spec;
}

function minimalUnityVisibleSpec(spec) {
  return {
    schemaVersion: spec.schemaVersion,
    kind: spec.kind,
    profile: spec.profile,
    targetFramework: spec.targetFramework,
    namespace: spec.namespace,
    generatedAt: spec.generatedAt,
    source: spec.source,
    semanticHash: spec.semanticHash,
    entities: spec.entities,
    components: spec.components,
    phases: spec.phases,
    resources: spec.resources,
    sceneRefs: spec.sceneRefs,
    poolArchetypes: spec.poolArchetypes,
    uiRefs: spec.uiRefs,
    assetBindings: spec.assetBindings
  };
}

function diffJson(expected, actual, pathPrefix, out) {
  pathPrefix = pathPrefix || '$';
  out = out || [];
  if (stableStringify(expected) === stableStringify(actual)) return out;
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      out.push({ path: pathPrefix, expected: expected, actual: actual });
      return out;
    }
    var max = Math.max(expected.length, actual.length);
    for (var i = 0; i < max; i++) diffJson(expected[i], actual[i], pathPrefix + '[' + i + ']', out);
    return out;
  }
  if (isObject(expected) || isObject(actual)) {
    if (!isObject(expected) || !isObject(actual)) {
      out.push({ path: pathPrefix, expected: expected, actual: actual });
      return out;
    }
    uniq(Object.keys(expected).concat(Object.keys(actual))).forEach(function(key) {
      diffJson(expected[key], actual[key], pathPrefix + '.' + key, out);
    });
    return out;
  }
  out.push({ path: pathPrefix, expected: expected, actual: actual });
  return out;
}

function assertDeliverySpecSourceParity(spec, sourceIr) {
  var expected = sourceSemanticProjection(sourceIr);
  var actual = {
    phases: spec && spec.phases || [],
    entities: safeArray(spec && spec.entities).map(function(entity) { return entity.sourceId; }),
    resources: spec && spec.resources || []
  };
  var diffs = diffJson(expected, actual);
  if (diffs.length) {
    var err = new Error('UnityDeliverySpec source parity failed');
    err.diffs = diffs;
    throw err;
  }
  return { passed: true, checked: ['phases', 'entities', 'resources'] };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function main(argv) {
  var args = argv || process.argv.slice(2);
  var opts = { out: '', minimalOut: '', inputDir: '' };
  for (var i = 0; i < args.length; i++) {
    var arg = args[i];
    if (arg === '--input-dir') opts.inputDir = args[++i] || '';
    else if (arg === '--out') opts.out = args[++i] || '';
    else if (arg === '--minimal-out') opts.minimalOut = args[++i] || '';
    else throw new Error('Unexpected argument: ' + arg);
  }
  if (!opts.inputDir || !opts.out) {
    throw new Error('Usage: node lib/unity-delivery-spec-projector.cjs --input-dir <source-ir-artifacts> --out <UnityDeliverySpec.internal.json> [--minimal-out Assets/BlueprintDelivery/UnityDeliverySpec.json]');
  }
  var dir = path.resolve(opts.inputDir);
  var input = {
    sourceIr: readJson(path.join(dir, 'source-ir.json')),
    gameSchema: fs.existsSync(path.join(dir, 'gameschema.json')) ? readJson(path.join(dir, 'gameschema.json')) : null,
    playableSceneIr: fs.existsSync(path.join(dir, 'playable-scene-ir.json')) ? readJson(path.join(dir, 'playable-scene-ir.json')) : null,
    assetManifest: fs.existsSync(path.join(dir, 'asset-manifest.json')) ? readJson(path.join(dir, 'asset-manifest.json')) : null,
    unityAssetPlan: fs.existsSync(path.join(dir, 'unity-asset-plan.json')) ? readJson(path.join(dir, 'unity-asset-plan.json')) : null
  };
  var spec = buildUnityDeliverySpec(input);
  assertDeliverySpecSourceParity(spec, input.sourceIr);
  writeJson(path.resolve(opts.out), spec);
  if (opts.minimalOut) writeJson(path.resolve(opts.minimalOut), minimalUnityVisibleSpec(spec));
  process.stdout.write(JSON.stringify({ ok: true, semanticHash: spec.semanticHash, phaseCount: spec.phases.length }, null, 2) + '\n');
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  }
}

module.exports = {
  KIND: KIND,
  SCHEMA_VERSION: SCHEMA_VERSION,
  buildUnityDeliverySpec: buildUnityDeliverySpec,
  minimalUnityVisibleSpec: minimalUnityVisibleSpec,
  sourceSemanticProjection: sourceSemanticProjection,
  assertDeliverySpecSourceParity: assertDeliverySpecSourceParity,
  featureEvidence: featureEvidence
};
