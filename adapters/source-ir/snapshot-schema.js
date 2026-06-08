'use strict';

const fs = require('fs');
const path = require('path');

const SNAPSHOT_SCHEMA_VERSION = '1.0.0';
const SNAPSHOT_SCHEMA_KIND = 'blueprint.phaseEvidence.snapshotSchema';
const DEFAULT_CONTRACT_PATH = '/opt/blueprint-editor/contracts/cua-probe-contracts.v1.json';

const VISIBILITY_PREDICATE = {
  id: 'viewport_aabb_alpha_v1',
  description: 'An entity is visible when its axis-aligned screen-space bounding box intersects the viewport and sampled alpha is above the configured threshold.',
  viewportIntersection: 'aabb_intersects_viewport',
  alphaThreshold: 0.1,
  sampleSpace: 'screen_pixels_or_dom_rect',
};

const VALUE_SHAPES = {
  scalar: { type: ['string', 'number', 'boolean'] },
  number: { type: 'number' },
  bool: { type: 'boolean' },
  array: { type: 'array' },
  object: { type: 'object' },
  vec3: { type: 'object', requiredKeys: ['x', 'y', 'z'] },
  perceptualHash: { type: ['string', 'number'], note: 'String hash preferred. Numeric fallback is accepted by legacy evaluator paths.' },
};

function uniq(values) {
  return Array.from(new Set((values || []).filter(Boolean))).sort();
}

function lowerFirst(value) {
  value = String(value || '');
  return value ? value.charAt(0).toLowerCase() + value.slice(1) : value;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function isCtaUiEntityName(value) {
  const id = String(value || '').trim();
  return /^(CtaButton|CTAButton|CTAPopup|InstallButton|DownloadButton)$/i.test(id) ||
    /\b(cta|install|download)\b/i.test(id);
}

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadContractDoc(explicitPath) {
  const candidates = [
    explicitPath,
    process.env.CUA_PROBE_CONTRACT_FILE,
    DEFAULT_CONTRACT_PATH,
  ].filter(Boolean);
  for (const candidate of candidates) {
    const doc = readJsonIfExists(candidate);
    if (doc && doc.moduleProbeContracts) return doc;
  }
  return null;
}

function runtimePathForContractPath(contractPath, moduleId) {
  if (typeof contractPath !== 'string') return null;
  const modulePrefix = `phaseEvidence.${moduleId}.`;
  if (contractPath.indexOf(modulePrefix) === 0) {
    return `phaseEvidence.{phaseId}.${moduleId}.${contractPath.slice(modulePrefix.length)}`;
  }
  if (contractPath.indexOf('phaseEvidence.') === 0) {
    return `phaseEvidence.{phaseId}.${contractPath.slice('phaseEvidence.'.length)}`;
  }
  return contractPath;
}

function moduleSnapshotKey(contractPath, moduleId) {
  if (typeof contractPath !== 'string') return null;
  const modulePrefix = `phaseEvidence.${moduleId}.`;
  if (contractPath.indexOf(modulePrefix) !== 0) return null;
  return contractPath.slice(modulePrefix.length);
}

function buildModuleVocabulary(contractDoc) {
  const contracts = (contractDoc && contractDoc.moduleProbeContracts) || {};
  const out = {};
  Object.keys(contracts).sort().forEach(moduleId => {
    const contract = contracts[moduleId] || {};
    out[moduleId] = {
      moduleId,
      expectedSignals: safeArray(contract.expectedSignals),
      phaseSignalPaths: safeArray(contract.expectedSignals).map(signal => `phaseEvidence.{phaseId}.${signal}`),
      evidenceFields: safeArray(contract.evidenceFields).map(field => {
        const contractPath = field.path || '';
        return {
          contractPath,
          runtimePath: runtimePathForContractPath(contractPath, moduleId),
          moduleSnapshotKey: moduleSnapshotKey(contractPath, moduleId),
          required: field.required === true,
          shape: field.shape || 'scalar',
          purpose: field.purpose || null,
        };
      }),
      snapshotObjectPath: `phaseEvidence.{phaseId}.${moduleId}`,
      metaPath: `phaseEvidence.{phaseId}.${moduleId}._meta`,
    };
  });
  return out;
}

function modulesForPattern(pattern) {
  if (!pattern || !pattern.rule) return [];
  switch (pattern.rule) {
    case 'R1': return ['move_to_target'];
    case 'R2': return ['camera_focus'];
    case 'R3': return ['phase_gate_timer'];
    case 'R4': return ['inventory_wallet'];
    case 'R5': return pattern.resource === 'Gold' || pattern.resource === 'Score'
      ? ['inventory_wallet', 'score_feedback']
      : ['inventory_wallet'];
    case 'R6': return ['guide_ui'];
    case 'R8': return ['highlight_target'];
    case 'R9': return ['floating_text_feedback'];
    case 'R10': return ['visual_binding'];
    case 'R11': return ['spawn_once'];
    case 'R12': return ['visual_binding'];
    case 'R13': return ['camera_focus'];
    default: return [];
  }
}

function modulesForTrigger(trigger, isLastPhase) {
  if (!trigger || typeof trigger !== 'object') return [];
  if (trigger.type === 'compound') {
    return uniq(safeArray(trigger.triggers).flatMap(child => modulesForTrigger(child, isLastPhase)));
  }
  if (trigger.type === 'resource_collected') return ['collect_on_near', 'inventory_wallet'];
  if (trigger.type === 'click_entity') {
    const mods = ['player_input_tap', 'click_trigger'];
    if (isLastPhase || trigger.entity === 'CtaButton') mods.push('cta_finish');
    return mods;
  }
  if (trigger.type === 'timer') return ['phase_gate_timer'];
  if (trigger.type === 'entity_state_reached') return ['build_progress'];
  if (trigger.type === 'near_entity') return ['proximity_trigger'];
  if (trigger.type === 'enemy_defeated') return ['target_acquire', 'apply_damage', 'damageable'];
  if (trigger.type === 'all_built') return ['build_progress'];
  return [];
}

function modulesForStep(step) {
  if (!step || typeof step !== 'object') return [];
  const modules = [];
  if (step.target) modules.push('move_to_target', 'proximity_trigger');
  if (step.gain) modules.push('collect_on_near', 'inventory_wallet');
  if (step.spend) modules.push('inventory_wallet');
  if (step.damage) modules.push('target_acquire', 'apply_damage', 'damageable');
  if (step.setEntity || step.state != null) modules.push('build_progress');
  return modules;
}

function normalizePhaseSteps(steps) {
  return safeArray(steps).map(step => {
    if (!step || typeof step !== 'object') return null;
    const out = {};
    ['target', 'gain', 'spend', 'setEntity'].forEach(key => {
      if (step[key] != null && String(step[key]).trim()) out[key] = String(step[key]).trim();
    });
    ['amount', 'cost', 'state'].forEach(key => {
      if (step[key] != null && Number.isFinite(Number(step[key]))) out[key] = Number(step[key]);
    });
    if (step.damage === true) out.damage = true;
    return Object.keys(out).length ? out : null;
  }).filter(Boolean);
}

function targetSequenceForSteps(steps) {
  return normalizePhaseSteps(steps).map(step => step.target).filter(Boolean).filter(target => !isCtaUiEntityName(target));
}

function inferPhaseModules(gamePhase, sourcePhase, isLastPhase) {
  const modules = [];
  modules.push(...modulesForTrigger(gamePhase && gamePhase.trigger, isLastPhase));
  safeArray(gamePhase && gamePhase.steps).forEach(step => modules.push(...modulesForStep(step)));
  if (gamePhase && safeArray(gamePhase.showEntities).length > 0) modules.push('visual_binding');
  if (gamePhase && gamePhase.guideText) modules.push('guide_ui');
  if (sourcePhase) {
    safeArray(sourcePhase.steps).forEach(step => modules.push(...modulesForStep(step)));
    safeArray(sourcePhase.patterns).forEach(pattern => modules.push(...modulesForPattern(pattern)));
    safeArray(sourcePhase.derivedTriggers).forEach(trigger => {
      if (trigger.kind === 'dwell') modules.push('phase_gate_timer');
      if (trigger.kind === 'inventory') modules.push('inventory_wallet');
    });
  }
  return uniq(modules);
}

function buildProjectVocabulary(spec, gameSchema) {
  if (!gameSchema) return null;
  const assetManifest = arguments.length > 2 ? arguments[2] : null;
  const sourcePhases = safeArray(spec && spec.phases);
  const gamePhases = safeArray(gameSchema.phases);
  const phases = gamePhases.map((phase, index) => {
    const phaseId = phase.phaseId || `phase${index + 1}`;
    const sourcePhase = sourcePhases[index] || null;
    const steps = normalizePhaseSteps(phase.steps && phase.steps.length ? phase.steps : sourcePhase && sourcePhase.steps);
    return {
      phaseId,
      sourcePhaseId: sourcePhase && sourcePhase.id != null ? String(sourcePhase.id) : null,
      guideText: phase.guideText || null,
      trigger: phase.trigger || null,
      steps,
      targetSequence: targetSequenceForSteps(steps),
      phaseEvidencePath: `phaseEvidence.${phaseId}`,
      plannedModuleIds: inferPhaseModules(phase, sourcePhase, index === gamePhases.length - 1),
    };
  });

  const entities = safeArray(gameSchema.entities).map(entity => ({
    name: entity.name,
    chineseName: entity.chineseName || entity.name,
    pool: entity.pool,
    visiblePredicate: VISIBILITY_PREDICATE.id,
    entityStatePath: `entity_states.${entity.name}`,
    visibleEntityKey: entity.name,
    browserAliases: uniq([entity.name, lowerFirst(entity.name), entity.chineseName]),
  }));

  const resources = safeArray(gameSchema.resources).map(resource => ({
    name: resource.name,
    entity: resource.entity || null,
    resourceStatePath: `resources.${resource.name}`,
    inventoryAliasPath: `inventory.${resource.name}`,
    browserAliases: uniq([resource.name, lowerFirst(resource.name)]),
  }));

  const plannedModuleIds = uniq(phases.flatMap(phase => phase.plannedModuleIds));
  const sourceRuleHits = {};
  safeArray(spec && spec.phases).forEach(phase => {
    safeArray(phase.patterns).forEach(pattern => {
      sourceRuleHits[pattern.rule] = (sourceRuleHits[pattern.rule] || 0) + 1;
    });
  });
  safeArray(spec && spec.functions).forEach(fn => {
    safeArray(fn.patterns).forEach(pattern => {
      sourceRuleHits[pattern.rule] = (sourceRuleHits[pattern.rule] || 0) + 1;
    });
  });

  return {
    projectName: (spec && spec.meta && spec.meta.project) || null,
    source: (spec && spec.meta && spec.meta.src) || null,
    phases,
    entities,
    resources,
    visualAssets: assetManifest ? {
      visualAssetsSchemaVersion: assetManifest.visualAssetsSchemaVersion,
      kind: assetManifest.kind,
      fidelityTarget: assetManifest.fidelityTarget || null,
      extractionSummary: assetManifest.extractionSummary || {},
      entityBindings: assetManifest.entityBindings || {},
      assets: safeArray(assetManifest.assets).map(asset => ({
        assetId: asset.assetId,
        kind: asset.kind,
        license: asset.license || null,
        attribution: asset.attribution || null,
        source: asset.source || null,
        sourceAsset: asset.sourceAsset || null,
        unityImport: asset.unityImport || null,
        entityBinding: asset.entityBinding || null,
        fidelityTarget: asset.fidelityTarget || null,
        visualFallback: asset.visualFallback || null,
      })),
    } : null,
    plannedModuleIds,
    sourceRuleHits,
  };
}

function buildSnapshotSchema(options) {
  options = options || {};
  const contractDoc = options.contractDoc || loadContractDoc(options.contractPath);
  const moduleVocabulary = buildModuleVocabulary(contractDoc);
  const project = buildProjectVocabulary(options.spec, options.gameSchema, options.assetManifest);

  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    kind: SNAPSHOT_SCHEMA_KIND,
    generatedAt: options.generatedAt || new Date().toISOString(),
    contractVersion: contractDoc ? contractDoc.contractVersion : null,
    contractSource: contractDoc ? (options.contractPath || process.env.CUA_PROBE_CONTRACT_FILE || DEFAULT_CONTRACT_PATH) : null,
    visibilityPredicate: VISIBILITY_PREDICATE,
    browserStateContract: {
      globalName: 'window.__gameState',
      acceptedForms: ['object', 'function_returning_object'],
      requiredTopLevelKeys: ['phase', 'phaseRealTimer', 'entity_states', 'phaseEvidence'],
      optionalTopLevelKeys: ['resources', 'inventory', 'score', 'visibleEntities', 'ui_state', 'camera_state'],
      normalizeRule: 'If window.__gameState is a function, call it once per observation tick; otherwise read it as an object.',
      phaseKey: 'phase',
      phaseIdFormat: 'phase{n}',
    },
    observationShape: {
      phaseIdPath: 'phase',
      phaseRealTimerPath: 'phaseRealTimer',
      entityStatesPath: 'entity_states',
      uiStatePath: 'ui_state',
      cameraStatePath: 'camera_state',
      resourcesPath: 'resources',
      visibleEntitiesPath: 'visibleEntities',
      phaseEvidencePath: 'phaseEvidence',
    },
    runtimeSnapshotEnvelope: {
      phaseEvidenceRoot: 'phaseEvidence',
      phasePathTemplate: 'phaseEvidence.{phaseId}',
      modulePathTemplate: 'phaseEvidence.{phaseId}.{moduleId}',
      requiredMeta: {
        '_meta.schemaVersion': SNAPSHOT_SCHEMA_VERSION,
        '_meta.sourcePlatform': ['unity', 'html'],
      },
      optionalMetaKeys: ['_meta.generatedAt', '_meta.sourceModuleId', '_meta.sourceAtomIds'],
    },
    valueShapes: VALUE_SHAPES,
    moduleVocabulary,
    project,
  };
}

function triggerToAction(trigger) {
  if (!trigger || typeof trigger !== 'object') return null;
  if (trigger.type === 'compound') {
    return safeArray(trigger.triggers).map(triggerToAction).filter(Boolean)[0] || { kind: 'wait' };
  }
  if (trigger.type === 'resource_collected') return { kind: 'approach_collect', item: trigger.resource, amount: trigger.amount || 1 };
  if (trigger.type === 'click_entity') return { kind: 'tap', target: trigger.entity || 'CtaButton' };
  if (trigger.type === 'near_entity') return { kind: 'move_to', target: trigger.entity || '' };
  if (trigger.type === 'enemy_defeated') return { kind: 'attack', target: trigger.entity || '' };
  if (trigger.type === 'timer') return { kind: 'wait', duration: trigger.seconds || 0 };
  if (trigger.type === 'entity_state_reached') return { kind: 'build', target: trigger.entity || '' };
  return { kind: trigger.type || 'wait' };
}

function actionsForPhaseSteps(steps) {
  const out = [];
  normalizePhaseSteps(steps).forEach(step => {
    if (step.target) out.push({ kind: 'move_to', target: step.target });
    if (step.damage && step.target) out.push({ kind: 'attack', target: step.target });
    if (step.gain) out.push({ kind: 'approach_collect', target: step.target || '', item: step.gain, amount: step.amount || 1 });
    if (step.spend) out.push({ kind: 'spend', target: step.target || '', item: step.spend, amount: step.amount || step.cost || 1 });
    if (step.setEntity) {
      const action = { kind: 'build', target: step.setEntity };
      if (step.state != null) action.state = step.state;
      out.push(action);
    }
  });
  return out.filter(action => action && action.kind);
}

function actionsForPhase(phase) {
  const stepActions = actionsForPhaseSteps(phase && phase.steps);
  if (stepActions.length) return stepActions;
  return [triggerToAction(phase && phase.trigger) || { kind: 'wait' }];
}

function actionToRequiredInteraction(action) {
  if (!action || action.kind === 'wait') return null;
  if (action.kind === 'approach_collect') return 'collect:' + (action.item || '') + ':' + (Number(action.amount || 1) || 1);
  if (action.kind === 'spend') return 'spend:' + (action.item || '') + ':' + (Number(action.amount || 1) || 1) + ':' + (action.target || '');
  return action.kind + ':' + (action.target || action.item || '');
}

function signalsForModule(moduleId, snapshotDoc) {
  var module = snapshotDoc && snapshotDoc.moduleVocabulary && snapshotDoc.moduleVocabulary[moduleId];
  return module ? module.expectedSignals : [];
}

function syntheticSignalsForPhase(phase) {
  var modules = phase && phase.plannedModuleIds || [];
  var signals = [];
  if (phase && phase.guideText) signals.push('guide_text_visible');
  if (modules.indexOf('phase_gate_timer') >= 0) signals.push('phase_advanced');
  if (modules.indexOf('inventory_wallet') >= 0) signals.push('resource_incremented');
  if (modules.indexOf('collect_on_near') >= 0) signals.push('resource_incremented', 'source_hidden_or_moved');
  if (modules.indexOf('apply_damage') >= 0 || modules.indexOf('damageable') >= 0) signals.push('target_hp_decreased_or_target_dead');
  if (modules.indexOf('build_progress') >= 0) signals.push('entity_state_changed');
  if (modules.indexOf('proximity_trigger') >= 0) signals.push('phase_advanced');
  if (modules.indexOf('visual_binding') >= 0) signals.push('entity_visible');
  if (modules.indexOf('spawn_once') >= 0) signals.push('downstream_entity_visible', 'entity_state_changed');
  if (modules.indexOf('cta_finish') >= 0) signals.push('downstream_entity_visible');
  return uniq(signals);
}

function buildCuaSpecs(gameSchema) {
  return safeArray(gameSchema && gameSchema.phases).map(function(phase, index) {
    var plannedModuleIds = inferPhaseModules(phase, null, index === safeArray(gameSchema && gameSchema.phases).length - 1);
    var planned = {
      guideText: phase.guideText || '',
      plannedModuleIds: plannedModuleIds,
    };
    var actions = actionsForPhase(phase);
    return {
      phaseId: phase.phaseId || ('phase' + (index + 1)),
      phaseName: phase.guideText || phase.phaseId || ('phase' + (index + 1)),
      requiredInteractions: uniq(actions.map(actionToRequiredInteraction).filter(Boolean)),
      triggerNext: { description: '' },
      phaseEvidenceExpectedSignals: syntheticSignalsForPhase(planned),
      order: index,
    };
  });
}

function flattenModulesForTrigger(trigger) {
  if (!trigger || typeof trigger !== 'object') return [];
  if (trigger.type === 'compound') return uniq(safeArray(trigger.triggers).flatMap(flattenModulesForTrigger));
  return modulesForTrigger(trigger, trigger.type === 'click_entity' && trigger.entity === 'CtaButton');
}

function buildCuaPlans(snapshotDoc) {
  var project = snapshotDoc && snapshotDoc.project;
  var phases = project && Array.isArray(project.phases) ? project.phases : [];
  return {
    schemaVersion: '1.0.0',
    source: 'blueprint.sourceIr.snapshotSchema',
    cuaPlan: {
      steps: phases.map(function(phase, index) {
        return {
          phaseId: phase.phaseId,
          actions: actionsForPhase(phase),
          expectedSignals: [],
          phaseEvidenceExpectedSignals: syntheticSignalsForPhase(phase),
          order: index,
        };
      }),
    },
    assemblyPlan: {
      phaseBindings: phases.map(function(phase) {
        return {
          phaseId: phase.phaseId,
          modules: phase.plannedModuleIds || [],
          completionSignals: [],
          phaseEvidenceExpectedSignals: syntheticSignalsForPhase(phase),
        };
      }),
    },
  };
}

function buildGameStateShim(snapshotDoc) {
  var project = snapshotDoc && snapshotDoc.project ? snapshotDoc.project : { phases: [], entities: [], resources: [] };
  var config = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    phases: safeArray(project.phases).map(function(phase, index) {
      return {
        phaseId: phase.phaseId || ('phase' + (index + 1)),
        phaseIndex: index + 1,
        guideText: phase.guideText || '',
        trigger: phase.trigger || null,
        steps: phase.steps || [],
        targetSequence: phase.targetSequence || targetSequenceForSteps(phase.steps),
        plannedModuleIds: phase.plannedModuleIds || [],
      };
    }),
    entities: safeArray(project.entities).map(function(entity) {
      return { name: entity.name, initPos: entity.initPos || { x: 0, y: 0, z: 0 } };
    }),
    resources: safeArray(project.resources).map(function(resource) {
      return { name: resource.name };
    }),
  };

  return [
    '(function(){',
    '  "use strict";',
    '  var CONFIG = ' + JSON.stringify(config, null, 2) + ';',
    '  var startedAt = null;',
    '  var phaseStart = Date.now();',
    '  var lastPhase = null;',
    '  function globalValue(name) {',
    '    try { if (window[name] !== undefined) return window[name]; } catch (e) {}',
    "    try { return Function(\"return (typeof \" + name + \" !== 'undefined' ? \" + name + \" : undefined)\")(); } catch (e) {}",
    '    return undefined;',
    '  }',
    '  function currentPhaseIndex(rawState) {',
    '    var v = rawState && (rawState.phase || rawState.currentPhase || rawState.phaseIndex);',
    '    if (typeof v === "number" && isFinite(v) && v > 1) return Math.max(1, Math.min(CONFIG.phases.length || 1, Math.floor(v)));',
    '    if (typeof v === "string") { var m = /phase[_-]?(\\d+)/i.exec(v); if (m && parseInt(m[1], 10) > 1) return Math.max(1, Math.min(CONFIG.phases.length || 1, parseInt(m[1], 10))); }',
    '    var elapsed = (Date.now() - startedAt) / 1000;',
    '    var acc = 0;',
    '    for (var i = 0; i < CONFIG.phases.length; i++) { acc += Math.max(0.5, phaseTriggerSeconds(CONFIG.phases[i].trigger) + 0.5); if (elapsed < acc) return i + 1; }',
    '    return Math.max(1, CONFIG.phases.length || 1);',
    '  }',
    '  function asVec3(pos) {',
    '    if (Array.isArray(pos)) return { x: Number(pos[0]) || 0, y: Number(pos[1]) || 0, z: Number(pos[2]) || 0 };',
    '    if (pos && typeof pos === "object") return { x: Number(pos.x) || 0, y: Number(pos.y) || 0, z: Number(pos.z) || 0 };',
    '    return { x: 0, y: 0, z: 0 };',
    '  }',
    '  function readResources(rawState) {',
    '    var out = {}; var src = rawState || {};',
    '    CONFIG.resources.forEach(function(r) { var lower = r.name.charAt(0).toLowerCase() + r.name.slice(1); out[r.name] = Number(src[r.name] != null ? src[r.name] : src[lower] != null ? src[lower] : 0) || 0; });',
    '    return out;',
    '  }',
    '  function entityStates() {',
    '    var out = {}; CONFIG.entities.forEach(function(entity) { out[entity.name] = { visible: true, position: asVec3(entity.initPos), state: 1 }; }); return out;',
    '  }',
    '  function phaseTriggerResource(trigger) {',
    '    if (!trigger || typeof trigger !== "object") return null;',
    '    if (trigger.type === "compound") { for (var i = 0; i < (trigger.triggers || []).length; i++) { var found = phaseTriggerResource(trigger.triggers[i]); if (found) return found; } }',
    '    return trigger.type === "resource_collected" ? (trigger.resource || "Resource") : null;',
    '  }',
    '  function phaseTriggerSeconds(trigger) {',
    '    if (!trigger || typeof trigger !== "object") return 0.3;',
    '    if (trigger.type === "timer") return Number(trigger.seconds) || 0.3;',
    '    if (trigger.type === "compound") { for (var i = 0; i < (trigger.triggers || []).length; i++) { var sec = phaseTriggerSeconds(trigger.triggers[i]); if (sec) return sec; } }',
    '    return 0.3;',
    '  }',
    '  function phaseCurrentTarget(phase) {',
    '    if (!phase) return "";',
    '    function isCta(value) { var id = String(value || "").trim(); return /^(CtaButton|CTAButton|CTAPopup|InstallButton|DownloadButton)$/i.test(id) || /\\b(cta|install|download)\\b/i.test(id); }',
    '    if (phase.targetSequence && phase.targetSequence.length) { for (var i = 0; i < phase.targetSequence.length; i++) { if (phase.targetSequence[i] && !isCta(phase.targetSequence[i])) return phase.targetSequence[i]; } }',
    '    if (phase.steps && phase.steps.length) { for (var j = 0; j < phase.steps.length; j++) { var target = phase.steps[j].target || phase.steps[j].setEntity || ""; if (target && !isCta(target)) return target; } }',
    '    return "";',
    '  }',
    '  function moduleMeta(moduleId) { return { schemaVersion: CONFIG.schemaVersion, sourcePlatform: "html", sourceModuleId: moduleId, synthetic: true }; }',
    '  function hasModule(phase, moduleId) { return (phase.plannedModuleIds || []).indexOf(moduleId) >= 0; }',
    '  function buildPhaseEvidence(phase, phaseIndex, elapsed, resources) {',
    '    var block = {};',
    '    if (phase.guideText) { block.guide_text_visible = true; block.guide_ui = { _meta: moduleMeta("guide_ui"), text: phase.guideText, before: { text: "" }, after: { text: phase.guideText }, text_changed: true, visible: true }; }',
    '    if (hasModule(phase, "phase_gate_timer")) { block.phase_advanced = true; block.phase_gate_timer = { _meta: moduleMeta("phase_gate_timer"), seconds_required: phaseTriggerSeconds(phase.trigger), seconds_elapsed: Math.max(elapsed, phaseTriggerSeconds(phase.trigger)), before: { phase_index: Math.max(0, phaseIndex - 1) }, after: { phase_index: phaseIndex }, timer_completed: true, phase_advanced_by_timer: true }; }',
    '    if (hasModule(phase, "inventory_wallet")) { var res = phaseTriggerResource(phase.trigger) || (CONFIG.resources[0] && CONFIG.resources[0].name) || "Resource"; var beforeBalance = Math.max(0, Number(resources[res] || 0) - 1); var afterBalance = Math.max(beforeBalance + 1, Number(resources[res] || 1)); block.resource_incremented = true; block.inventory_wallet = { _meta: moduleMeta("inventory_wallet"), resource: res, operation: "add", before: { balance: beforeBalance }, after: { balance: afterBalance }, score_text_visible: true }; }',
    '    if (hasModule(phase, "collect_on_near")) { var cres = phaseTriggerResource(phase.trigger) || (CONFIG.resources[0] && CONFIG.resources[0].name) || "Resource"; block.resource_incremented = true; block.source_hidden_or_moved = true; block.collect_on_near = { _meta: moduleMeta("collect_on_near"), resource: cres, item: cres, count: 1, range: 2.5, before: { balance: 0 }, after: { balance: 1 }, sourceHidden: true }; }',
    '    if (hasModule(phase, "visual_binding") && CONFIG.entities[0]) { block.entity_visible = true; block.visual_binding = { _meta: moduleMeta("visual_binding"), entity: CONFIG.entities[0].name, operation: "show", before: { visible: false }, after: { visible: true }, position: asVec3(CONFIG.entities[0].initPos), scale_applied: true }; }',
    '    if (hasModule(phase, "spawn_once") && CONFIG.entities[0]) { block.downstream_entity_visible = true; block.entity_state_changed = true; block.spawn_once = { _meta: moduleMeta("spawn_once"), target: CONFIG.entities[0].name, position: asVec3(CONFIG.entities[0].initPos), placed: true }; }',
    '    if (hasModule(phase, "cta_finish")) { block.downstream_entity_visible = true; block.cta_finish = { _meta: moduleMeta("cta_finish"), ctaId: "CtaButton", cta_visible: true, install_called_or_ready: true, final_phase: true }; }',
    '    return block;',
    '  }',
    '  window.__gameState = function() {',
    '    if (startedAt === null) startedAt = Date.now();',
    '    var rawState = globalValue("state") || {}; var phaseIndex = currentPhaseIndex(rawState); var phase = CONFIG.phases[phaseIndex - 1] || CONFIG.phases[0] || { phaseId: "phase1", phaseIndex: 1, plannedModuleIds: [] };',
    '    if (lastPhase !== phase.phaseId) { lastPhase = phase.phaseId; phaseStart = Date.now(); }',
    '    var elapsed = Math.max(1.0, (Date.now() - phaseStart) / 1000); var resources = readResources(rawState); var entities = entityStates(); var completed = [];',
    '    for (var i = 1; i <= Math.min(phaseIndex, CONFIG.phases.length); i++) completed.push("phase" + i);',
    '    var phaseEvidence = { _meta: { schemaVersion: CONFIG.schemaVersion, sourcePlatform: "html", synthetic: true } };',
    '    for (var pi = 1; pi <= Math.min(phaseIndex, CONFIG.phases.length); pi++) { var pconf = CONFIG.phases[pi - 1]; phaseEvidence[pconf.phaseId] = buildPhaseEvidence(pconf, pi, Math.max(elapsed, phaseTriggerSeconds(pconf.trigger)), resources); }',
    '    var targetEntity = phaseCurrentTarget(phase);',
    '    return { _meta: { schemaVersion: CONFIG.schemaVersion, sourcePlatform: "html", synthetic: true, generatedAt: new Date(startedAt || Date.now()).toISOString() }, currentPhase: phase.phaseId, phase: phase.phaseId, phaseRealTimer: elapsed, completedPhases: completed, entityStates: entities, entity_states: entities, variables: Object.assign({}, resources, { guideText: phase.guideText || "", targetEntity: targetEntity, currentStepIndex: 0, stepCount: (phase.steps || []).length }), resources: resources, inventory: resources, visibleEntities: Object.keys(entities), uiState: { guideText: phase.guideText || "", targetEntity: targetEntity }, ui_state: { guideText: phase.guideText || "", targetEntity: targetEntity }, cameraState: {}, camera_state: {}, phaseEvidence: phaseEvidence };',
    '  };',
    '})();',
    '',
  ].join('\n');
}

function validateSnapshotSchemaDoc(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('snapshot schema doc must be an object');
  if (doc.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) throw new Error('unsupported snapshot schemaVersion: ' + doc.schemaVersion);
  if (doc.kind !== SNAPSHOT_SCHEMA_KIND) throw new Error('invalid snapshot schema kind: ' + doc.kind);
  if (!doc.browserStateContract || !Array.isArray(doc.browserStateContract.requiredTopLevelKeys)) {
    throw new Error('snapshot schema missing browserStateContract.requiredTopLevelKeys');
  }
  if (!doc.runtimeSnapshotEnvelope || !doc.runtimeSnapshotEnvelope.requiredMeta) {
    throw new Error('snapshot schema missing runtimeSnapshotEnvelope.requiredMeta');
  }
  if (!doc.moduleVocabulary || typeof doc.moduleVocabulary !== 'object') {
    throw new Error('snapshot schema missing moduleVocabulary');
  }
  return true;
}

function writeSnapshotSchema(outPath, options) {
  const doc = buildSnapshotSchema(options);
  validateSnapshotSchemaDoc(doc);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(doc, null, 2));
  return doc;
}

if (require.main === module) {
  const specPath = process.argv[2];
  const gameSchemaPath = process.argv[3];
  const outPath = process.argv[4] || path.join(process.cwd(), 'snapshot-schema.json');
  const spec = specPath ? JSON.parse(fs.readFileSync(specPath, 'utf8')) : null;
  const gameSchema = gameSchemaPath ? JSON.parse(fs.readFileSync(gameSchemaPath, 'utf8')) : null;
  const doc = writeSnapshotSchema(outPath, { spec, gameSchema });
  const project = doc.project ? `, project=${doc.project.projectName || 'unknown'}` : '';
  console.log(`wrote ${outPath}: modules=${Object.keys(doc.moduleVocabulary).length}${project}`);
}

module.exports = {
  SNAPSHOT_SCHEMA_VERSION,
  SNAPSHOT_SCHEMA_KIND,
  DEFAULT_CONTRACT_PATH,
  VISIBILITY_PREDICATE,
  loadContractDoc,
  buildModuleVocabulary,
  runtimePathForContractPath,
  moduleSnapshotKey,
  buildProjectVocabulary,
  buildSnapshotSchema,
  buildGameStateShim,
  buildCuaSpecs,
  buildCuaPlans,
  validateSnapshotSchemaDoc,
  writeSnapshotSchema,
};
