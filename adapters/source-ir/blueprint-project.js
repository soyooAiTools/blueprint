'use strict';

const fs = require('fs');
const path = require('path');
const { renderUnityEditorBaker } = require('./unity-asset-plan.js');
const { buildProofBundle } = require('./proof-bundle.cjs');
const {
  assertPlayableSceneIrBinding,
  validatePlayableSceneIr,
  writePlayableSceneIr,
} = require('../../engine/playable-scene-ir.cjs');
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

function enrichAssetManifestBinding(assetManifest, binding) {
  if (!assetManifest) return null;
  const out = clone(assetManifest);
  if (binding && binding.sourceHtmlPath) {
    out.source = binding.sourceHtmlPath;
    out.sourceHtmlPath = binding.sourceHtmlPath;
    out.sourceHtmlSha256 = binding.sourceHtmlSha256 || out.sourceHtmlSha256 || null;
    out.playableSceneIrHash = binding.playableSceneIrHash || out.playableSceneIrHash || null;
  }
  return out;
}

function fallbackSourceBinding(assetManifest) {
  if (!assetManifest) {
    return { sourceHtmlPath: null, sourceHtmlSha256: null, playableSceneIrHash: null };
  }
  const source = assetManifest.sourceHtmlPath || assetManifest.source || null;
  return {
    sourceHtmlPath: source ? path.resolve(source) : null,
    sourceHtmlSha256: assetManifest.sourceHtmlSha256 || assetManifest.sourceSha256 || null,
    playableSceneIrHash: assetManifest.playableSceneIrHash || null,
  };
}

function preparePlayableSceneBinding(options) {
  options = options || {};
  const rawManifest = options.assetManifest || null;
  const playableSceneIr = options.playableSceneIr || null;
  if (!playableSceneIr) {
    const fallback = fallbackSourceBinding(rawManifest);
    return {
      assetManifest: rawManifest,
      playableSceneIr: null,
      sourceHtmlPath: fallback.sourceHtmlPath,
      sourceHtmlSha256: fallback.sourceHtmlSha256,
      playableSceneIrHash: fallback.playableSceneIrHash,
    };
  }
  validatePlayableSceneIr(playableSceneIr);
  const binding = assertPlayableSceneIrBinding(playableSceneIr, {
    assetManifest: rawManifest,
    sourceHtmlPath: options.sourceHtmlPath || null,
    sourceHtmlSha256: options.sourceHtmlSha256 || null,
    requireAssetManifestHash: options.requireAssetManifestHash === true,
  });
  return {
    assetManifest: enrichAssetManifestBinding(rawManifest, binding),
    playableSceneIr: clone(playableSceneIr),
    sourceHtmlPath: binding.sourceHtmlPath,
    sourceHtmlSha256: binding.sourceHtmlSha256,
    playableSceneIrHash: binding.playableSceneIrHash,
  };
}

function sanitizeEntityName(raw, fallback) {
  const text = String(raw || fallback || 'Resource').replace(/[^A-Za-z0-9_]/g, '');
  const base = text || 'Resource';
  return /^[A-Za-z_]/.test(base) ? base : ('Resource' + base);
}

function normName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isPassivePhaseEntityName(name) {
  return /^(player|hero|protagonist)$/i.test(name || '') ||
    /guide|text|label|canvas|hud|score|ui|cta|button/i.test(name || '');
}

function triggerResourceNames(trigger) {
  const out = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'compound') return safeArray(node.triggers).forEach(visit);
    if (node.type === 'resource_collected' && node.resource) out.push(node.resource);
  }
  visit(trigger);
  return uniq(out);
}

function phaseNavigationTargetForResource(phase, resource) {
  const names = safeArray(phase && phase.showEntities)
    .map(name => String(name || '').trim())
    .filter(name => name && !isPassivePhaseEntityName(name));
  if (!names.length) return '';
  const aliases = resourceAliases(resource).map(normName).filter(Boolean);
  const resourceKey = normName(resource);
  const genericResource = /^(gold|coin|money|cash|currency|resource)$/i.test(resource || '');
  function score(name, index) {
    const key = normName(name);
    let value = 100 - index;
    if (aliases.indexOf(key) >= 0 || key.indexOf(resourceKey) >= 0 || resourceKey.indexOf(key) >= 0) value += 1000;
    if (genericResource && /resource|drop|loot|pickup|collect|coin|gold|gem/.test(key)) value += 700;
    if (genericResource && /barrier|wall|gate|block|lock|basecore|base/.test(key)) value -= 300;
    if (/enemy|alien|monster|boss/.test(key) && /count|kill|enemy|alien|monster|boss/.test(resourceKey)) value += 600;
    if (!/spawner|spawn|generator|field|machine|unlock|button/.test(key)) value += 120;
    return value;
  }
  return names.slice().sort((a, b) => score(b, names.indexOf(b)) - score(a, names.indexOf(a)))[0] || '';
}

function phaseResourceFallbackTargetIndex(phases) {
  const out = {};
  safeArray(phases).forEach(phase => {
    triggerResourceNames(phase && phase.trigger).forEach(resource => {
      const target = phaseNavigationTargetForResource(phase, resource);
      if (!target) return;
      resourceAliases(resource).forEach(alias => {
        if (!out[alias]) out[alias] = target;
      });
    });
  });
  return out;
}

function normalizeGameSchemaForBlueprint(gameSchema, options) {
  options = options || {};
  const schema = clone(gameSchema || {});
  schema.entities = safeArray(schema.entities);
  schema.resources = safeArray(schema.resources);
  const assetManifest = options.assetManifest || null;
  const sourceTargets = buildSourceResourceTargetIndex(assetManifest);
  const phaseTargets = phaseResourceFallbackTargetIndex(schema.phases);
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
    const phaseTarget = phaseTargets[resource.name] || '';
    if (phaseTarget && entityNames[phaseTarget]) {
      resource.entity = phaseTarget;
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
      sourceIrGeneratedCarrier: true,
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
      sourceIrGeneratedPlayer: true,
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

function resourceForEntityInPhase(gameSchema, phase, entityName, options) {
  options = options || {};
  const phaseResourceTargets = options.phaseResourceTargets || {};
  const resourceEntities = options.resourceEntities || {};
  const phaseResources = triggerResourceNames(phase && phase.trigger);
  for (let i = 0; i < phaseResources.length; i++) {
    const resource = phaseResources[i];
    const target = phaseResourceTargets[resource] || resourceEntities[resource] || '';
    if (target === entityName) return resource;
  }
  return resourceForEntity(gameSchema, entityName);
}

function isCtaEntityName(name) {
  return /^(CtaButton|CTAButton|CTAPopup|InstallButton|DownloadButton)$/i.test(String(name || '').trim());
}

function isFinalCtaTrigger(trigger) {
  if (!trigger || typeof trigger !== 'object') return false;
  if (trigger.type === 'compound') {
    return safeArray(trigger.triggers).some(isFinalCtaTrigger);
  }
  return trigger.type === 'cta_arrival'
    || ((trigger.type === 'near_entity' || trigger.type === 'click_entity') && isCtaEntityName(trigger.entity));
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
    if (options.isFinalPhase && isCtaEntityName(trigger.entity)) return [];
    return ['click:' + (trigger.entity || 'CtaButton')];
  }
  if (trigger.type === 'cta_arrival') {
    return [];
  }
  if (trigger.type === 'timer') {
    return ['wait:' + (trigger.seconds || 1)];
  }
  if (trigger.type === 'entity_state_reached') {
    return ['build:' + (trigger.entity || '')];
  }
  if (trigger.type === 'near_entity') {
    if (options.isFinalPhase && isCtaEntityName(trigger.entity)) return [];
    return ['move_to:' + (trigger.entity || '')];
  }
  if (trigger.type === 'enemy_defeated') {
    return ['attack:' + (trigger.entity || 'Enemy')];
  }
  return [];
}

function conditionIdentifier(value, fallback) {
  var text = String(value || fallback || 'phase').trim()
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
  if (!text || /^[0-9]/.test(text)) text = String(fallback || 'phase');
  return text || 'phase';
}

function triggerToCondition(trigger, options) {
  options = options || {};
  if (!trigger || typeof trigger !== 'object') return conditionIdentifier(options.phaseId, 'phase') + 'Complete';
  if (trigger.type === 'compound') {
    var operator = trigger.operator === 'or' ? ' || ' : ' && ';
    var parts = safeArray(trigger.triggers).map(function(child) {
      return triggerToCondition(child, options);
    }).filter(Boolean);
    return parts.length > 0 ? parts.join(operator) : conditionIdentifier(options.phaseId, 'phase') + 'Complete';
  }
  if (trigger.type === 'resource_collected') {
    var resource = trigger.resource || 'Resource';
    var phaseResourceTargets = options.phaseResourceTargets || {};
    var target = phaseResourceTargets[resource] || options.resourceEntities && options.resourceEntities[resource] || resource;
    return conditionIdentifier(target || resource, 'Resource') + 'Collected >= ' +
      Math.max(1, Math.round(Number(trigger.amount || 1) || 1));
  }
  if (trigger.type === 'click_entity') {
    return conditionIdentifier(trigger.entity || 'Target', 'Target') + 'Clicked';
  }
  if (trigger.type === 'cta_arrival') {
    return conditionIdentifier(trigger.ctaId || trigger.entity || 'CtaButton', 'CtaButton') + 'Reached';
  }
  if (trigger.type === 'timer') {
    return 'phaseDwellSeconds >= ' + Math.max(1, Number(trigger.seconds || 1) || 1);
  }
  if (trigger.type === 'entity_state_reached') {
    return conditionIdentifier(trigger.entity || 'Target', 'Target') + 'State >= ' +
      Math.max(1, Math.round(Number(trigger.state || 1) || 1));
  }
  if (trigger.type === 'near_entity') {
    return conditionIdentifier(trigger.entity || 'Target', 'Target') + 'Reached';
  }
  if (trigger.type === 'enemy_defeated') {
    return conditionIdentifier(trigger.entity || 'Enemy', 'Enemy') + 'Defeated >= ' +
      Math.max(1, Math.round(Number(trigger.count || 1) || 1));
  }
  return conditionIdentifier(options.phaseId, 'phase') + 'Complete';
}

function triggerDescription(trigger) {
  if (!trigger || typeof trigger !== 'object') return 'SourceIR phase gate complete';
  if (trigger.type === 'compound') {
    return 'SourceIR compound gate: ' + safeArray(trigger.triggers).map(triggerDescription).join(trigger.operator === 'or' ? ' OR ' : ' AND ');
  }
  if (trigger.type === 'resource_collected') return 'Collect ' + (trigger.amount || 1) + ' ' + (trigger.resource || 'resource');
  if (trigger.type === 'click_entity') return 'Click ' + (trigger.entity || 'target');
  if (trigger.type === 'cta_arrival') return 'Reach CTA ' + (trigger.ctaId || trigger.entity || 'CtaButton');
  if (trigger.type === 'timer') return 'Wait ' + (trigger.seconds || 1) + 's';
  if (trigger.type === 'entity_state_reached') return 'Reach state ' + (trigger.state || 1) + ' on ' + (trigger.entity || 'target');
  if (trigger.type === 'near_entity') return 'Move near ' + (trigger.entity || 'target');
  if (trigger.type === 'enemy_defeated') return 'Defeat ' + (trigger.count || 1) + ' ' + (trigger.entity || 'enemy');
  return 'SourceIR phase gate complete';
}

function sourcePhaseForGamePhase(phase, assetManifest) {
  const phaseId = String(phase && phase.phaseId || phase && phase.id || '').trim();
  if (!phaseId) return null;
  return safeArray(assetManifest && assetManifest.sourcePhaseContract && assetManifest.sourcePhaseContract.phases)
    .find(item => item && String(item.id || item.phaseId || '').trim() === phaseId) || null;
}

function sourcePhaseStepInteractions(sourcePhase) {
  const out = [];
  safeArray(sourcePhase && sourcePhase.steps).forEach(step => {
    if (!step || typeof step !== 'object') return;
    const target = String(step.target || '').trim();
    if (target && !isCtaEntityName(target)) out.push('move_to:' + target);
    if (step.damage && target && !isCtaEntityName(target)) out.push('attack:' + target);
    if (step.setEntity && !isCtaEntityName(step.setEntity)) out.push('build:' + String(step.setEntity).trim());
    if (step.gain) out.push('collect:' + String(step.gain).trim() + ':' + (Number(step.amount || 1) || 1));
    if (step.spend && target) out.push('spend:' + String(step.spend).trim() + ':' + (Number(step.amount || step.cost || 1) || 1) + ':' + target);
  });
  return uniq(out);
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
  const sourceVisible = {};
  safeArray(sourcePhase && sourcePhase.showEntities).forEach(name => { if (name) sourceVisible[name] = true; });
  function sourcePhasePrimaryTarget() {
    const stepTarget = safeArray(sourcePhase && sourcePhase.steps)
      .map(step => step && step.target)
      .find(target => target && sourceVisible[target] && !isPassivePhaseEntityName(target));
    if (stepTarget) return stepTarget;
    const hudTarget = sourcePhase && sourcePhase.hudText && sourcePhase.hudText.targetEntity;
    if (hudTarget && sourceVisible[hudTarget] && !isPassivePhaseEntityName(hudTarget)) return hudTarget;
    return '';
  }
  safeArray(sourcePhase && sourcePhase.steps).forEach(step => {
    if (step && step.gain && step.target) {
      resourceAliases(step.gain).forEach(alias => { out[alias] = step.target; });
    }
  });
  triggerResourceNames(phase && phase.trigger).forEach(resource => {
    const target = sourcePhasePrimaryTarget() || phaseNavigationTargetForResource(phase, resource);
    if (!target) return;
    resourceAliases(resource).forEach(alias => {
      if (!out[alias]) out[alias] = target;
    });
  });
  return out;
}

function templateForEntity(entity, gameSchema, options) {
  options = options || {};
  const name = String(entity && entity.name || '');
  if (name === 'Player') return 'PlayerController';
  if (/cta|button|ui/i.test(name)) return 'UI';
  const resourceEntities = {};
  safeArray(gameSchema && gameSchema.resources).forEach(resource => {
    if (resource && resource.entity) resourceEntities[resource.entity] = true;
  });
  if (resourceEntities[name]) {
    const usedTriggerResources = options.usedTriggerResources || {};
    const backingResource = safeArray(gameSchema && gameSchema.resources)
      .find(resource => resource && resource.entity === name);
    if (backingResource && usedTriggerResources[backingResource.name]) {
      return /alien|enemy|monster|boss/i.test(name) ? 'Collectible|Damageable' : 'Collectible';
    }
    return 'Static';
  }
  if (/alien|enemy|monster|boss/i.test(name)) return 'Damageable';
  if (/hero|player|worker|farmer|customer|npc/i.test(name)) return 'Static';
  return 'Static';
}

function buildBlueprintProject(gameSchema, options) {
  options = options || {};
  const phases = safeArray(gameSchema && gameSchema.phases);
  const projectName = options.projectName || 'SourceIrBlueprintSmoke';
  const sceneBinding = preparePlayableSceneBinding(options);
  const assetManifest = sceneBinding.assetManifest || null;
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
    const sourcePhase = sourcePhaseForGamePhase(phase, assetManifest);
    const isFinalPhase = index === phases.length - 1;
    const finalCta = isFinalPhase && isFinalCtaTrigger(phase.trigger);
    const requiredInteractions = uniq(sourcePhaseStepInteractions(sourcePhase)
      .concat(triggerToRequiredInteractions(phase.trigger, { resourceEntities, phaseResourceTargets, isFinalPhase }))
      .filter(interaction => interaction && interaction.indexOf('wait:') !== 0));
    const spec = {
      phaseId: phase.phaseId || ('phase' + (index + 1)),
      phaseName: phase.guideText || phase.phaseId || ('phase' + (index + 1)),
      requiredInteractions,
      entitiesRequired: safeArray(phase.showEntities).map(name => {
        const resourceName = resourceForEntityInPhase(gameSchema, phase, name, {
          phaseResourceTargets,
          resourceEntities,
        });
        return resourceName ? { name, resource: resourceName } : { name };
      }),
      duration: { min: 12, max: 15 },
      playerInstruction: phase.guideText || '',
      autoModeHint: phase.guideText || '',
    };
    if (!isFinalPhase) {
      spec.triggerNext = {
        condition: triggerToCondition(phase.trigger, {
          phaseId: spec.phaseId,
          resourceEntities,
          phaseResourceTargets,
        }),
        description: triggerDescription(phase.trigger),
      };
      spec.nextPhase = phases[index + 1] && phases[index + 1].phaseId || ('phase' + (index + 2));
    }
    if (finalCta) spec.playerMustAct = false;
    return spec;
  });

  return {
    name: projectName,
    schemaSource: 'source-scene-ir',
    prebuiltGameSchema: true,
    source: options.source || null,
    sourceHtmlPath: sceneBinding.sourceHtmlPath || null,
    sourceHtmlSha256: sceneBinding.sourceHtmlSha256 || null,
    playableSceneIrHash: sceneBinding.playableSceneIrHash || null,
    playableSceneIr: cloneOrNull(sceneBinding.playableSceneIr),
    storyboardFrames: phases.map((phase, index) => ({
      title: phase.guideText || phase.phaseId || '',
      interaction: triggerToRequiredInteractions(phase.trigger, {
        resourceEntities,
        phaseResourceTargets: phaseResourceTargetIndex(phase, assetManifest),
        isFinalPhase: index === phases.length - 1,
      }).join(','),
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
      schemaSource: 'source-scene-ir',
      prebuiltGameSchema: true,
      gameSchema: normalizedGameSchema,
      specs: project.specs,
      entities: safeArray(normalizedGameSchema.entities),
      resources: safeArray(normalizedGameSchema.resources),
      sourceHtmlPath: project.sourceHtmlPath || null,
      sourceHtmlSha256: project.sourceHtmlSha256 || null,
      playableSceneIrHash: project.playableSceneIrHash || null,
      playableSceneIr: cloneOrNull(project.playableSceneIr || null),
      visualAssets: cloneOrNull(project.visualAssets || options.assetManifest || null),
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
  const proofBundle = buildProofBundle({
    project,
    blueprint,
    gameSchema: blueprint.gameSchema,
    assetManifest: blueprint.visualAssets,
    plans: blueprint.plans,
    specs: blueprint.specs,
  });
  fs.writeFileSync(path.join(outDir, 'blueprint-proof-bundle.json'), JSON.stringify(proofBundle, null, 2));
  fs.writeFileSync(path.join(outDir, 'blueprint-proof-diff.json'), JSON.stringify(proofBundle.contractDiff || {}, null, 2));
  const proofGateEnabled = process.env.BLUEPRINT_PROOF_CONTRACT_GATE !== '0';
  if (proofGateEnabled && proofBundle.contractDiff && proofBundle.contractDiff.blocking && proofBundle.contractDiff.blocking.length > 0) {
    throw new Error('Blueprint proof contract diff failed: ' + JSON.stringify(proofBundle.contractDiff.blocking.slice(0, 8)));
  }
  if (blueprint.playableSceneIr || project.playableSceneIr) {
    writePlayableSceneIr(path.join(outDir, 'playable-scene-ir.json'), blueprint.playableSceneIr || project.playableSceneIr);
  }
  if (blueprint.visualAssets) fs.writeFileSync(path.join(outDir, 'blueprint-visual-assets.json'), JSON.stringify(blueprint.visualAssets, null, 2));
  if (blueprint.visualAssetPlan) {
    fs.writeFileSync(path.join(outDir, 'blueprint-unity-asset-plan.json'), JSON.stringify(blueprint.visualAssetPlan, null, 2));
    fs.writeFileSync(path.join(outDir, 'SourceIrVisualAssetBaker.cs'), renderUnityEditorBaker(blueprint.visualAssetPlan));
  }
}

module.exports = {
  DEFAULT_BLUEPRINT_ROOT,
  normalizeGameSchemaForBlueprint,
  triggerToRequiredInteractions,
  triggerToCondition,
  buildResourceEntityIndex,
  collectTriggerResources,
  templateForEntity,
  buildBlueprintProject,
  buildBlueprintContext,
  writeBlueprintArtifacts,
  loadJson,
};
