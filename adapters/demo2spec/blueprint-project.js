'use strict';

const fs = require('fs');
const path = require('path');
const { renderUnityEditorBaker } = require('./unity-asset-plan.js');
const {
  buildSourceResourceTargetIndex,
  resourceAliases,
  sourceResourceTarget,
} = require('./source-contract-mapping.js');

const DEFAULT_BLUEPRINT_ROOT = process.env.BLUEPRINT_EDITOR_ROOT || '/opt/blueprint-editor';

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniq(values) {
  return Array.from(new Set(safeArray(values).filter(Boolean)));
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function cloneOrNull(value) {
  return value == null ? null : clone(value);
}

function sanitizeEntityName(raw, fallback) {
  const text = String(raw || fallback || 'Resource').replace(/[^A-Za-z0-9_]/g, '');
  const base = text || 'Resource';
  return /^[A-Za-z_]/.test(base) ? base : ('Resource' + base);
}

function normalizeGameSchemaForBlueprint(gameSchema, options) {
  options = options || {};
  const schema = clone(gameSchema || {});
  schema.entities = safeArray(schema.entities);
  schema.resources = safeArray(schema.resources);
  const assetManifest = options.assetManifest || null;
  const sourceTargets = buildSourceResourceTargetIndex(assetManifest);
  const entityNames = {};
  schema.entities.forEach(entity => {
    if (entity && entity.name) entityNames[entity.name] = true;
  });

  schema.resources.forEach((resource, index) => {
    if (!resource || !resource.name) return;
    const currentEntity = String(resource.entity || '');
    const needsCarrier = !currentEntity || !entityNames[currentEntity] || /cta|button|ui/i.test(currentEntity);
    if (!needsCarrier) return;
    const sourceTarget = sourceResourceTarget(assetManifest, resource.name) || sourceTargets[resource.name] || '';
    if (sourceTarget && entityNames[sourceTarget]) {
      resource.entity = sourceTarget;
      return;
    }

    let carrierName = sanitizeEntityName(resource.name, 'Resource' + (index + 1));
    let suffix = 1;
    while (entityNames[carrierName]) {
      carrierName = sanitizeEntityName(resource.name, 'Resource' + (index + 1)) + suffix;
      suffix++;
    }
    entityNames[carrierName] = true;
    schema.entities.push({
      name: carrierName,
      chineseName: resource.displayName || resource.name,
      showLabel: true,
      pool: '__Pool_Cylinder_Yellow_01',
      initPos: [-4 + index * 1.5, 0, -2],
      scale: 0.7,
      demo2specGeneratedCarrier: true,
    });
    resource.entity = carrierName;
  });
  if (!entityNames.Player) {
    schema.entities.unshift({
      name: 'Player',
      chineseName: '玩家',
      showLabel: true,
      pool: '__Pool_Cube_White_01',
      initPos: [0, 0.5, 0],
      scale: 0.6,
      demo2specGeneratedPlayer: true,
    });
    entityNames.Player = true;
  }
  return schema;
}

function loadBuildProjectPlans(blueprintRoot) {
  const root = blueprintRoot || DEFAULT_BLUEPRINT_ROOT;
  return require(path.join(root, 'adapters/assembly-plan-pipeline.cjs')).buildProjectPlans;
}

function buildResourceEntityIndex(gameSchema, options) {
  options = options || {};
  const index = {};
  const sourceTargets = buildSourceResourceTargetIndex(options.assetManifest || null);
  safeArray(gameSchema && gameSchema.resources).forEach(resource => {
    if (!resource || !resource.name) return;
    index[resource.name] = sourceTargets[resource.name] || resource.entity || '';
  });
  return index;
}

function resourceForEntity(gameSchema, entityName) {
  const found = safeArray(gameSchema && gameSchema.resources)
    .find(resource => resource && resource.entity === entityName);
  return found && found.name ? found.name : '';
}

function triggerToRequiredInteractions(trigger, options) {
  options = options || {};
  if (!trigger || typeof trigger !== 'object') return [];
  if (trigger.type === 'compound') {
    return uniq(safeArray(trigger.triggers).flatMap(child => triggerToRequiredInteractions(child, options)));
  }
  if (trigger.type === 'resource_collected') {
    const resource = trigger.resource || 'Resource';
    const phaseResourceTargets = options.phaseResourceTargets || {};
    const sourceEntity = phaseResourceTargets[resource] || (options.resourceEntities && options.resourceEntities[resource]);
    return uniq([
      sourceEntity ? ('move_to:' + sourceEntity) : '',
      'collect:' + resource + ':' + (trigger.amount || 1),
    ]);
  }
  if (trigger.type === 'click_entity') {
    return ['click:' + (trigger.entity || 'CtaButton')];
  }
  if (trigger.type === 'timer') {
    return ['wait:' + (trigger.seconds || 1)];
  }
  if (trigger.type === 'entity_state_reached') {
    return ['build:' + (trigger.entity || '')];
  }
  if (trigger.type === 'near_entity') {
    return ['move_to:' + (trigger.entity || '')];
  }
  if (trigger.type === 'enemy_defeated') {
    return ['attack:' + (trigger.entity || 'Enemy')];
  }
  return [];
}

function parseScale(scale) {
  const n = Number(scale);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function positionText(initPos) {
  const parts = safeArray(initPos);
  const x = Number(parts[0]) || 0;
  const y = Number(parts[1]) || 0;
  const z = Number(parts[2]) || 0;
  return '(' + [x, y, z].join(',') + ')';
}

function collectTriggerResources(phases) {
  const out = {};
  function visit(trigger) {
    if (!trigger || typeof trigger !== 'object') return;
    if (trigger.type === 'compound') return safeArray(trigger.triggers).forEach(visit);
    if (trigger.type === 'resource_collected' && trigger.resource) out[trigger.resource] = true;
  }
  safeArray(phases).forEach(phase => visit(phase && phase.trigger));
  return out;
}

function phaseResourceTargetIndex(phase, assetManifest) {
  const sourceTargets = buildSourceResourceTargetIndex(assetManifest || null);
  const out = Object.assign({}, sourceTargets);
  const phaseId = phase && phase.phaseId;
  const sourcePhase = safeArray(assetManifest && assetManifest.sourcePhaseContract && assetManifest.sourcePhaseContract.phases)
    .find(item => item && (item.id === phaseId || item.phaseId === phaseId));
  safeArray(sourcePhase && sourcePhase.steps).forEach(step => {
    if (step && step.gain && step.target) {
      resourceAliases(step.gain).forEach(alias => { out[alias] = step.target; });
    }
  });
  return out;
}

function templateForEntity(entity, gameSchema, options) {
  options = options || {};
  const name = String(entity && entity.name || '');
  if (name === 'Player') return 'PlayerController';
  if (/cta|button|ui/i.test(name)) return 'UI';
  if (/alien|enemy|monster|boss/i.test(name)) return 'Damageable|Mover';
  const resourceEntities = {};
  safeArray(gameSchema && gameSchema.resources).forEach(resource => {
    if (resource && resource.entity) resourceEntities[resource.entity] = true;
  });
  if (resourceEntities[name]) {
    const usedTriggerResources = options.usedTriggerResources || {};
    const backingResource = safeArray(gameSchema && gameSchema.resources)
      .find(resource => resource && resource.entity === name);
    return backingResource && usedTriggerResources[backingResource.name] ? 'Collectible' : 'Static';
  }
  if (/hero|player|worker|farmer|customer|npc/i.test(name)) return 'Static';
  return 'Static';
}

function buildBlueprintProject(gameSchema, options) {
  options = options || {};
  const phases = safeArray(gameSchema && gameSchema.phases);
  const projectName = options.projectName || 'Demo2SpecBlueprintSmoke';
  const assetManifest = options.assetManifest || null;
  const unityAssetPlan = options.unityAssetPlan || null;
  const resourceEntities = buildResourceEntityIndex(gameSchema, { assetManifest });
  const usedTriggerResources = collectTriggerResources(phases);
  const entityBindings = assetManifest && assetManifest.entityBindings || {};
  const unityEntityBindings = unityAssetPlan && unityAssetPlan.entityBindings || {};

  const entities = safeArray(gameSchema && gameSchema.entities).map(entity => {
    const scale = parseScale(entity && entity.scale);
    const binding = entityBindings[entity.name] || null;
    const unityBinding = unityEntityBindings[entity.name] || null;
    return {
      name: entity.name,
      label: entity.chineseName || entity.name,
      template: templateForEntity(entity, gameSchema, { usedTriggerResources }),
      visual: {
        position: positionText(entity.initPos),
        scale: [scale, scale, scale].join('x'),
        assetId: binding && binding.primaryAssetId || null,
        assetIds: binding && binding.assetIds || [],
        textureAssetIds: binding && binding.textureAssetIds || [],
        unityAssetActionId: unityBinding && unityBinding.primaryActionId || null,
        unityPrefabPath: unityBinding && unityBinding.prefabPath || null,
        unityBakingMode: unityBinding && unityBinding.bakingMode || null,
        visualFallback: binding && binding.visualFallback || null,
        fidelityTarget: binding && binding.fidelityTarget || null,
      },
      behavior: {},
    };
  });

  const specs = phases.map((phase, index) => {
    const phaseResourceTargets = phaseResourceTargetIndex(phase, assetManifest);
    const requiredInteractions = triggerToRequiredInteractions(phase.trigger, { resourceEntities, phaseResourceTargets })
      .filter(interaction => interaction && interaction.indexOf('wait:') !== 0);
    return {
      phaseId: phase.phaseId || ('phase' + (index + 1)),
      phaseName: phase.guideText || phase.phaseId || ('phase' + (index + 1)),
      requiredInteractions,
      entitiesRequired: safeArray(phase.showEntities).map(name => {
        const resourceName = resourceForEntity(gameSchema, name);
        return resourceName ? { name, resource: resourceName } : { name };
      }),
      duration: { min: 12, max: 15 },
      playerInstruction: phase.guideText || '',
      autoModeHint: phase.guideText || '',
    };
  });

  return {
    name: projectName,
    source: options.source || null,
    storyboardFrames: phases.map(phase => ({
      title: phase.guideText || phase.phaseId || '',
      interaction: triggerToRequiredInteractions(phase.trigger, { resourceEntities, phaseResourceTargets: phaseResourceTargetIndex(phase, assetManifest) }).join(','),
      ui: phase.guideText || '',
    })),
    entities,
    visualAssets: cloneOrNull(assetManifest),
    visualAssetPlan: cloneOrNull(unityAssetPlan),
    phases: phases.map(phase => ({
      id: phase.phaseId,
      name: phase.guideText || phase.phaseId,
      activate: safeArray(phase.showEntities),
      guide: phase.guideText || '',
    })),
    specs,
  };
}

function buildBlueprintContext(gameSchema, options) {
  options = options || {};
  const normalizedGameSchema = normalizeGameSchemaForBlueprint(gameSchema, { assetManifest: options.assetManifest || null });
  const project = buildBlueprintProject(normalizedGameSchema, options);
  const buildProjectPlans = options.buildProjectPlans || loadBuildProjectPlans(options.blueprintRoot);
  const plans = buildProjectPlans(project);
  if (!plans.validation || !plans.validation.ok) {
    throw new Error('Assembly plan validation failed: ' + JSON.stringify(plans.validation && plans.validation.errors || []));
  }
  return {
    project,
    blueprint: {
      projectName: project.name,
      schemaSource: 'demo2spec',
      prebuiltGameSchema: true,
      gameSchema: normalizedGameSchema,
      specs: project.specs,
      entities: safeArray(normalizedGameSchema.entities),
      resources: safeArray(normalizedGameSchema.resources),
      visualAssets: cloneOrNull(options.assetManifest || null),
      visualAssetPlan: cloneOrNull(options.unityAssetPlan || null),
      plans,
      htmlPhaseSlices: options.htmlPhaseSlices || {},
      assemblyDecision: 'assembly_ready',
      assemblyCoverage: 1,
      assemblyUnresolvedCount: 0,
      w1bSplit: true,
    },
  };
}

function writeBlueprintArtifacts(outDir, project, blueprint) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'blueprint-project.json'), JSON.stringify(project, null, 2));
  fs.writeFileSync(path.join(outDir, 'blueprint-gameschema.json'), JSON.stringify(blueprint.gameSchema, null, 2));
  fs.writeFileSync(path.join(outDir, 'blueprint-specs.json'), JSON.stringify(blueprint.specs, null, 2));
  fs.writeFileSync(path.join(outDir, 'blueprint-plans.json'), JSON.stringify(blueprint.plans, null, 2));
  if (blueprint.visualAssets) fs.writeFileSync(path.join(outDir, 'blueprint-visual-assets.json'), JSON.stringify(blueprint.visualAssets, null, 2));
  if (blueprint.visualAssetPlan) {
    fs.writeFileSync(path.join(outDir, 'blueprint-unity-asset-plan.json'), JSON.stringify(blueprint.visualAssetPlan, null, 2));
    fs.writeFileSync(path.join(outDir, 'Demo2SpecVisualAssetBaker.cs'), renderUnityEditorBaker(blueprint.visualAssetPlan));
  }
}

module.exports = {
  DEFAULT_BLUEPRINT_ROOT,
  normalizeGameSchemaForBlueprint,
  triggerToRequiredInteractions,
  buildResourceEntityIndex,
  collectTriggerResources,
  templateForEntity,
  buildBlueprintProject,
  buildBlueprintContext,
  writeBlueprintArtifacts,
  loadJson,
};
