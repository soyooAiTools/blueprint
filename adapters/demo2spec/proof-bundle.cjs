'use strict';

const crypto = require('crypto');

const PROOF_SCHEMA_VERSION = 'blueprint-proof-bundle.v1';

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function uniq(values) {
  const out = [];
  const seen = {};
  safeArray(values).forEach(value => {
    if (value === null || value === undefined || value === '') return;
    const key = String(value);
    if (seen[key]) return;
    seen[key] = true;
    out.push(value);
  });
  return out;
}

function norm(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function stableStringify(value) {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
}

function semanticHash(value) {
  return crypto.createHash('sha1').update(stableStringify(value)).digest('hex');
}

function phaseIdForIndex(items, index) {
  const item = safeArray(items)[index] || {};
  return String(item.phaseId || item.id || item.name || ('phase' + (index + 1)));
}

function sourcePhases(assetManifest, gameSchema) {
  const fromSource = safeArray(assetManifest && assetManifest.sourcePhaseContract && assetManifest.sourcePhaseContract.phases);
  const schemaPhases = safeArray(gameSchema && gameSchema.phases);
  const count = Math.max(fromSource.length, schemaPhases.length);
  const out = [];
  for (let i = 0; i < count; i++) {
    const source = fromSource[i] || {};
    const schema = schemaPhases[i] || {};
    out.push({
      index: i,
      phaseId: String(source.id || source.phaseId || schema.phaseId || ('phase' + (i + 1))),
      name: source.name || schema.guideText || schema.phaseName || '',
      guideText: source.guideText || schema.guideText || '',
      goalText: source.goalText || '',
      showEntities: uniq(safeArray(source.showEntities).concat(safeArray(schema.showEntities))),
      steps: safeArray(source.steps).map(step => clone(step)),
      hudText: clone(source.hudText || {}),
      trigger: clone(schema.trigger || null),
    });
  }
  return out;
}

function planStepByPhase(cuaPlan) {
  const out = {};
  safeArray(cuaPlan && cuaPlan.steps).forEach((step, index) => {
    const id = String(step && step.phaseId || ('phase' + (index + 1)));
    out[norm(id)] = step;
  });
  return out;
}

function phaseBindingByPhase(assemblyPlan) {
  const out = {};
  safeArray(assemblyPlan && assemblyPlan.phaseBindings).forEach((binding, index) => {
    const id = String(binding && binding.phaseId || ('phase' + (index + 1)));
    out[norm(id)] = binding;
  });
  return out;
}

function hasAtomOverlap(moduleInstance, binding) {
  const atoms = {};
  safeArray(binding && binding.atomIds).forEach(id => { atoms[String(id)] = true; });
  return safeArray(moduleInstance && moduleInstance.sourceAtomIds).some(id => atoms[String(id)]);
}

function moduleMatchesTarget(moduleInstance, target) {
  if (!target) return false;
  const entity = String(moduleInstance && moduleInstance.entity || '');
  if (norm(entity) === norm(target)) return true;
  return safeArray(moduleInstance && moduleInstance.params && moduleInstance.params.targets)
    .some(name => norm(name) === norm(target));
}

function modulesForPhase(plans, binding, target) {
  const modules = safeArray(plans && plans.assemblyPlan && plans.assemblyPlan.moduleInstances);
  const out = [];
  modules.forEach(moduleInstance => {
    if (!moduleInstance) return;
    const primary = hasAtomOverlap(moduleInstance, binding);
    const targetOwned = moduleMatchesTarget(moduleInstance, target);
    if (!primary && !targetOwned) return;
    out.push(Object.assign({}, clone(moduleInstance), {
      proofRole: primary ? 'source-atom' : 'target-owned',
    }));
  });
  return out;
}

function actionTarget(action) {
  if (!action || typeof action !== 'object') return '';
  return String(action.target || action.to || action.entity || action.button || action.object || '').trim();
}

function actionSortValue(action) {
  const kind = String(action && action.kind || '').toLowerCase();
  const priority = {
    move_to: 10,
    joystick_move: 10,
    approach_collect: 20,
    deliver: 25,
    build: 30,
    upgrade: 30,
    attack: 30,
    tap: 40,
    click: 40,
  };
  return priority[kind] || 100;
}

function mainAction(actions) {
  const sorted = safeArray(actions).filter(actionTarget).slice().sort((a, b) => actionSortValue(a) - actionSortValue(b));
  return sorted[0] || null;
}

function sourceStepTargets(sourcePhase) {
  return uniq(safeArray(sourcePhase && sourcePhase.steps).map(step => step && step.target).filter(Boolean));
}

function sourceTargetForPhase(sourcePhase) {
  const steps = sourceStepTargets(sourcePhase);
  if (steps.length) return steps[0];
  const hudTarget = sourcePhase && sourcePhase.hudText && sourcePhase.hudText.targetEntity;
  if (hudTarget) return hudTarget;
  return '';
}

function triggerTargets(trigger) {
  const out = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'compound') return safeArray(node.triggers).forEach(visit);
    if (node.entity) out.push(node.entity);
    if (node.target) out.push(node.target);
  }
  visit(trigger);
  return uniq(out);
}

function triggerResources(trigger) {
  const out = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'compound') return safeArray(node.triggers).forEach(visit);
    if (node.type === 'resource_collected' && node.resource) {
      out.push({ resource: node.resource, count: Number(node.amount || node.count || 1) || 1 });
    }
  }
  visit(trigger);
  return out;
}

function triggerEvidence(trigger) {
  const evidence = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'compound') return safeArray(node.triggers).forEach(visit);
    if (node.type === 'resource_collected') {
      evidence.push('PhaseResourceProgress(' + (node.resource || 'Resource') + ') >= ' + (Number(node.amount || node.count || 1) || 1));
    } else if (node.type === 'entity_state_reached') {
      evidence.push(String(node.entity || 'Entity') + 'State >= ' + (Number(node.state || 1) || 1));
      evidence.push('EntityAdvanced(' + String(node.entity || 'Entity') + ')');
    } else if (node.type === 'near_entity') {
      evidence.push('PlayerNear(' + String(node.entity || 'Target') + ')');
    } else if (node.type === 'click_entity') {
      evidence.push('TapRegistered(' + String(node.entity || 'CTAButton') + ')');
    } else if (node.type === 'enemy_defeated') {
      evidence.push('TargetDefeated(' + String(node.entity || 'Enemy') + ')');
    } else if (node.type === 'timer') {
      evidence.push('PhaseTimer >= ' + (Number(node.seconds || 1) || 1));
    }
  }
  visit(trigger);
  return uniq(evidence);
}

function userAffordance(actions, trigger) {
  const kinds = safeArray(actions).map(action => String(action && action.kind || '').toLowerCase());
  if (kinds.some(kind => kind === 'tap' || kind === 'click')) return 'tap_target';
  if (kinds.some(kind => kind === 'drag')) return 'drag_target';
  if (kinds.some(kind => /move|collect|deliver|build|upgrade|attack/.test(kind))) return 'joystick_move_near';
  if (trigger && trigger.type === 'click_entity') return 'tap_target';
  if (trigger && trigger.type === 'timer') return 'observe_wait';
  return 'observe_only';
}

function moduleProofContract(moduleInstance, phaseTarget) {
  const moduleId = String(moduleInstance && moduleInstance.moduleId || '');
  const entity = String(moduleInstance && moduleInstance.entity || '');
  const params = moduleInstance && moduleInstance.params || {};
  const target = entity || params.target || phaseTarget || '';
  const base = {
    moduleInstanceId: moduleInstance.id,
    moduleId,
    entity,
    target,
    affordance: 'observe',
    expectedSignals: clone(moduleInstance.expectedSignals || []),
    exitEvidence: [],
    checkpointSeed: {},
  };
  if (moduleId === 'player_input_joystick' || moduleId === 'move_to_target') {
    base.affordance = 'joystick_move_near';
    base.target = phaseTarget || params.target || target;
    base.exitEvidence = ['player_position_changed', 'distance_to_target_below_threshold'];
  } else if (moduleId === 'collect_on_near') {
    const resource = params.resource || params.item || 'Resource';
    const count = Number(params.count || 1) || 1;
    base.affordance = 'joystick_move_near';
    base.exitEvidence = [
      'PhaseResourceProgress(' + resource + ') >= ' + count,
      target ? 'EntityAdvanced(' + target + ')' : 'source_hidden_or_moved',
    ];
    base.checkpointSeed = { resourcesBefore: Object.fromEntries([[resource, 0]]), playerNear: target || phaseTarget || '' };
  } else if (moduleId === 'build_progress') {
    base.affordance = 'joystick_move_near';
    base.exitEvidence = [target + 'State >= 2', 'EntityAdvanced(' + target + ')'];
    base.checkpointSeed = { playerNear: target, entityStateBefore: 1 };
  } else if (moduleId === 'upgrade_progress') {
    base.affordance = 'joystick_move_near';
    base.exitEvidence = [target + 'Level >= ' + (Number(params.level || 1) || 1), 'visual_variant_changed'];
    base.checkpointSeed = { playerNear: target };
  } else if (moduleId === 'activate_targets') {
    const targets = safeArray(params.targets).filter(Boolean);
    base.affordance = 'observe';
    base.target = targets[0] || target;
    base.exitEvidence = targets.map(name => name + '.visible == true');
  } else if (moduleId === 'cost_gate') {
    const resource = params.resource || 'Gold';
    base.affordance = 'observe';
    base.exitEvidence = ['resource_decremented', 'TrySpend(' + resource + ', ' + (Number(params.amount || 1) || 1) + ')'];
  } else if (moduleId === 'click_trigger' || moduleId === 'player_input_tap' || moduleId === 'cta_finish') {
    base.affordance = 'tap_target';
    base.target = params.target || phaseTarget || target;
    base.exitEvidence = ['tap_registered'];
  }
  return base;
}

function actionResources(actions) {
  return safeArray(actions)
    .filter(action => String(action && action.kind || '').toLowerCase() === 'approach_collect')
    .map(action => ({
      resource: action.item || action.resource || '',
      count: Number(action.count || 1) || 1,
      target: action.target || '',
    }));
}

function actionTargets(actions) {
  return uniq(safeArray(actions).map(actionTarget).filter(Boolean));
}

function buildPhaseProof(args) {
  const sourcePhase = args.sourcePhase || {};
  const step = args.step || {};
  const binding = args.binding || {};
  const actions = safeArray(step.actions).map(action => clone(action));
  const primaryAction = mainAction(actions);
  const target = actionTarget(primaryAction) || sourceTargetForPhase(sourcePhase) || triggerTargets(sourcePhase.trigger)[0] || '';
  const modules = modulesForPhase(args.plans, binding, target);
  const moduleProofs = modules.map(module => moduleProofContract(module, target));
  const expectedSignals = uniq(safeArray(step.expectedSignals).concat(safeArray(binding.completionSignals)));
  const sourceContract = {
    phaseId: sourcePhase.phaseId,
    name: sourcePhase.name,
    guideText: sourcePhase.guideText,
    goalText: sourcePhase.goalText,
    showEntities: clone(sourcePhase.showEntities || []),
    stepTargets: sourceStepTargets(sourcePhase),
    targetSequence: sourceStepTargets(sourcePhase),
    steps: clone(sourcePhase.steps || []),
    trigger: clone(sourcePhase.trigger || null),
  };
  const proof = {
    phaseId: step.phaseId || binding.phaseId || sourcePhase.phaseId,
    index: sourcePhase.index,
    storyboardContract: sourceContract,
    userAffordance: userAffordance(actions, sourcePhase.trigger),
    target,
    targetSequence: sourceStepTargets(sourcePhase),
    actions,
    modules: moduleProofs,
    expectedSignals,
    exitEvidence: uniq(triggerEvidence(sourcePhase.trigger).concat(moduleProofs.flatMap(item => item.exitEvidence || []))),
    checkpoint: {
      id: (step.phaseId || binding.phaseId || sourcePhase.phaseId) + '-ready',
      phaseId: step.phaseId || binding.phaseId || sourcePhase.phaseId,
      debugOnly: true,
      seedSummary: {
        completedThroughPreviousPhase: true,
        playerNear: target,
        visibleEntities: clone(sourcePhase.showEntities || []),
      },
    },
  };
  proof.semanticHash = semanticHash({
    phaseId: proof.phaseId,
    storyboardContract: proof.storyboardContract,
    actions: proof.actions,
    modules: proof.modules.map(module => ({
      moduleInstanceId: module.moduleInstanceId,
      moduleId: module.moduleId,
      entity: module.entity,
      target: module.target,
      expectedSignals: module.expectedSignals,
      exitEvidence: module.exitEvidence,
    })),
    expectedSignals: proof.expectedSignals,
    exitEvidence: proof.exitEvidence,
  });
  return proof;
}

function hasName(names, target) {
  const key = norm(target);
  return !!key && safeArray(names).some(name => norm(name) === key);
}

function matchingResource(rows, expected) {
  const key = norm(expected.resource);
  return safeArray(rows).find(row => norm(row.resource) === key && Number(row.count || 0) >= Number(expected.count || 1));
}

function validatePhaseProof(phaseProof) {
  const blocking = [];
  const warnings = [];
  const source = phaseProof.storyboardContract || {};
  const target = phaseProof.target || '';
  const sourceTargets = uniq(safeArray(source.stepTargets).concat(safeArray(source.showEntities)));
  if (target && !hasName(sourceTargets, target)) {
    blocking.push({
      code: 'target_not_in_storyboard_phase',
      phaseId: phaseProof.phaseId,
      target,
      sourceTargets,
    });
  }

  const triggerResourcesList = triggerResources(source.trigger);
  const actionResourceRows = actionResources(phaseProof.actions);
  const actionTargetRows = actionTargets(phaseProof.actions);
  safeArray(source.stepTargets).forEach(stepTarget => {
    if (!hasName(actionTargetRows, stepTarget)) {
      blocking.push({
        code: 'source_step_target_not_in_cua_actions',
        phaseId: phaseProof.phaseId,
        target: stepTarget,
        actionTargets: actionTargetRows,
      });
    }
  });
  const collectModules = phaseProof.modules
    .filter(item => item.moduleId === 'collect_on_near')
    .map(item => {
      const match = String((item.exitEvidence || []).join(' ')).match(/(?:PhaseResourceProgress|GetCollectedResource)\(([^)]+)\)\s*>=\s*(\d+)/);
      return { resource: match && match[1] || '', count: match ? Number(match[2]) : 1, target: item.target };
    });
  triggerResourcesList.forEach(expected => {
    if (!matchingResource(actionResourceRows, expected)) {
      blocking.push({
        code: 'resource_action_contract_missing',
        phaseId: phaseProof.phaseId,
        resource: expected.resource,
        count: expected.count,
        actions: actionResourceRows,
      });
    }
    if (!matchingResource(collectModules, expected)) {
      blocking.push({
        code: 'resource_module_contract_missing',
        phaseId: phaseProof.phaseId,
        resource: expected.resource,
        count: expected.count,
        modules: collectModules,
      });
    }
  });

  if (source.trigger && source.trigger.type === 'entity_state_reached') {
    const entity = source.trigger.entity || '';
    const hasBuildAction = safeArray(phaseProof.actions).some(action => /build|upgrade/i.test(action.kind || '') && norm(actionTarget(action)) === norm(entity));
    const hasBuildModule = safeArray(phaseProof.modules).some(module => /build_progress|upgrade_progress/.test(module.moduleId || '') && norm(module.entity) === norm(entity));
    if (!hasBuildAction && !hasBuildModule) {
      blocking.push({ code: 'entity_state_contract_missing', phaseId: phaseProof.phaseId, entity });
    }
  }

  if (source.trigger && source.trigger.type === 'click_entity') {
    const entity = source.trigger.entity || '';
    const hasTapAction = safeArray(phaseProof.actions).some(action => /tap|click/i.test(action.kind || '') && norm(actionTarget(action)) === norm(entity));
    const hasTapModule = safeArray(phaseProof.modules).some(module => /click_trigger|player_input_tap|cta_finish/.test(module.moduleId || '') && norm(module.target || module.entity) === norm(entity));
    if (!hasTapAction && !hasTapModule) {
      blocking.push({ code: 'click_contract_missing', phaseId: phaseProof.phaseId, entity });
    }
  }

  if (!phaseProof.actions.length && phaseProof.userAffordance !== 'observe_only') {
    warnings.push({ code: 'phase_has_no_cua_actions', phaseId: phaseProof.phaseId });
  }

  return { blocking, warnings };
}

function buildContractDiff(bundle) {
  const blocking = [];
  const warnings = [];
  const expectedCount = Number(bundle.sourcePhaseCount || 0);
  const actualCount = safeArray(bundle.phases).length;
  if (expectedCount && expectedCount !== actualCount) {
    blocking.push({ code: 'phase_count_mismatch', sourcePhaseCount: expectedCount, proofPhaseCount: actualCount });
  }
  safeArray(bundle.phases).forEach(phase => {
    const result = validatePhaseProof(phase);
    blocking.push.apply(blocking, result.blocking);
    warnings.push.apply(warnings, result.warnings);
  });
  return {
    passed: blocking.length === 0,
    blocking,
    warnings,
    summary: {
      blocking: blocking.length,
      warnings: warnings.length,
      phaseCount: actualCount,
      sourcePhaseCount: expectedCount,
    },
  };
}

function buildProofBundle(input) {
  input = input || {};
  const gameSchema = input.gameSchema || input.blueprint && input.blueprint.gameSchema || {};
  const assetManifest = input.assetManifest || input.blueprint && input.blueprint.visualAssets || null;
  const visualRuntimeContract = assetManifest && assetManifest.visualRuntimeContract || null;
  const plans = input.plans || input.blueprint && input.blueprint.plans || {};
  const specs = safeArray(input.specs || input.blueprint && input.blueprint.specs);
  const sources = sourcePhases(assetManifest, gameSchema);
  const stepIndex = planStepByPhase(plans.cuaPlan || {});
  const bindingIndex = phaseBindingByPhase(plans.assemblyPlan || {});
  const phaseCount = Math.max(sources.length, safeArray(plans.cuaPlan && plans.cuaPlan.steps).length, specs.length);
  const phases = [];
  for (let i = 0; i < phaseCount; i++) {
    const phaseId = sources[i] && sources[i].phaseId || phaseIdForIndex(specs, i);
    const key = norm(phaseId);
    phases.push(buildPhaseProof({
      sourcePhase: sources[i] || { index: i, phaseId, showEntities: [], steps: [], trigger: null },
      step: stepIndex[key] || safeArray(plans.cuaPlan && plans.cuaPlan.steps)[i] || { phaseId, actions: [] },
      binding: bindingIndex[key] || safeArray(plans.assemblyPlan && plans.assemblyPlan.phaseBindings)[i] || { phaseId, atomIds: [] },
      plans,
    }));
  }

  const bundle = {
    schemaVersion: PROOF_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    source: assetManifest && assetManifest.source || input.source || null,
    visualRuntimeContract: visualRuntimeContract ? {
      schemaVersion: visualRuntimeContract.schemaVersion || null,
      kind: visualRuntimeContract.kind || null,
      phaseDriver: clone(visualRuntimeContract.phaseDriver || null),
      summary: clone(visualRuntimeContract.summary || null),
    } : null,
    sourcePhaseCount: sources.length,
    phaseCount: phases.length,
    expectedPhasePath: phases.map(phase => phase.phaseId),
    phases,
  };
  bundle.semanticHash = semanticHash({
    source: bundle.source,
    expectedPhasePath: bundle.expectedPhasePath,
    phases: bundle.phases.map(phase => ({
      phaseId: phase.phaseId,
      semanticHash: phase.semanticHash,
    })),
  });
  bundle.contractDiff = buildContractDiff(bundle);
  return bundle;
}

module.exports = {
  PROOF_SCHEMA_VERSION,
  buildProofBundle,
  buildContractDiff,
  validatePhaseProof,
  moduleProofContract,
  semanticHash,
};
