var { loadAssemblyRegistry } = require('./load-assembly-registry.cjs');

function _isArray(value) {
  return Array.isArray(value);
}

function _indexById(items, kind, errors) {
  var index = {};
  for (var i = 0; i < items.length; i++) {
    var item = items[i] || {};
    if (!item.id) {
      errors.push(kind + '[' + i + '] missing id');
      continue;
    }
    if (index[item.id]) {
      errors.push('Duplicate ' + kind + ' id: ' + item.id);
      continue;
    }
    index[item.id] = item;
  }
  return index;
}

function _indexByField(items, field, kind, errors) {
  var index = {};
  for (var i = 0; i < items.length; i++) {
    var item = items[i] || {};
    var value = item[field];
    if (!value) {
      errors.push(kind + '[' + i + '] missing ' + field);
      continue;
    }
    if (index[value]) {
      errors.push('Duplicate ' + kind + ' ' + field + ': ' + value);
      continue;
    }
    index[value] = item;
  }
  return index;
}

function _ensureArray(value, label, errors) {
  if (!_isArray(value)) {
    errors.push(label + ' must be an array');
    return [];
  }
  return value;
}

function validateAssemblyPlans(plans, registry) {
  registry = registry || loadAssemblyRegistry();

  var errors = [];
  var warnings = [];

  if (!plans || typeof plans !== 'object') {
    return { ok: false, errors: ['plans must be an object'], warnings: warnings };
  }

  var atomRegistryItems = (registry.storyboardAtoms && registry.storyboardAtoms.items) || [];
  var moduleRegistryItems = (registry.runtimeModules && registry.runtimeModules.items) || [];
  var assertionRegistryItems = (registry.cuaAssertions && registry.cuaAssertions.items) || [];

  var atomRegistry = _indexById(atomRegistryItems, 'registryAtom', errors);
  var moduleRegistry = _indexById(moduleRegistryItems, 'registryModule', errors);
  var assertionRegistry = _indexById(assertionRegistryItems, 'registryAssertion', errors);

  var storyboardAtomPlan = plans.storyboardAtomPlan || {};
  var entityPlan = plans.entityPlan || {};
  var assemblyPlan = plans.assemblyPlan || {};
  var cuaPlan = plans.cuaPlan || {};

  var atomItems = _ensureArray(storyboardAtomPlan.items || [], 'storyboardAtomPlan.items', errors);
  var entityItems = _ensureArray(entityPlan.entities || [], 'entityPlan.entities', errors);
  var systemModules = _ensureArray(entityPlan.systemModules || [], 'entityPlan.systemModules', errors);
  var moduleInstances = _ensureArray(assemblyPlan.moduleInstances || [], 'assemblyPlan.moduleInstances', errors);
  var stateOwners = _ensureArray(assemblyPlan.stateOwners || [], 'assemblyPlan.stateOwners', errors);
  var phaseBindings = _ensureArray(assemblyPlan.phaseBindings || [], 'assemblyPlan.phaseBindings', errors);
  var fileOwners = _ensureArray(assemblyPlan.fileOwners || [], 'assemblyPlan.fileOwners', errors);
  var cuaSteps = _ensureArray(cuaPlan.steps || [], 'cuaPlan.steps', errors);

  var atomIndex = _indexById(atomItems, 'storyboardAtomPlan.item', errors);
  var entityIndex = _indexByField(entityItems, 'name', 'entityPlan.entity', errors);
  var moduleInstanceIndex = _indexById(moduleInstances, 'assemblyPlan.moduleInstance', errors);
  var phaseBindingIndex = _indexByField(phaseBindings, 'phaseId', 'assemblyPlan.phaseBinding', errors);

  for (var ai = 0; ai < atomItems.length; ai++) {
    var atom = atomItems[ai] || {};
    var atomLabel = 'storyboardAtomPlan.items[' + atom.id + ']';
    if (!atom.atomId) {
      errors.push(atomLabel + '.atomId missing');
      continue;
    }
    if (!atomRegistry[atom.atomId]) {
      errors.push(atomLabel + ' references unknown registry atom: ' + atom.atomId);
    }
    if (atom.phaseId && !phaseBindingIndex[atom.phaseId]) {
      warnings.push(atomLabel + ' phaseId has no phaseBinding: ' + atom.phaseId);
    }
  }

  for (var ei = 0; ei < entityItems.length; ei++) {
    var entity = entityItems[ei] || {};
    var entityLabel = 'entityPlan.entities[' + entity.name + ']';
    var entityModules = _ensureArray(entity.modules || [], entityLabel + '.modules', errors);
    for (var em = 0; em < entityModules.length; em++) {
      var entityModule = entityModules[em] || {};
      if (!entityModule.moduleId) {
        errors.push(entityLabel + '.modules[' + em + '] missing moduleId');
        continue;
      }
      if (!moduleRegistry[entityModule.moduleId]) {
        errors.push(entityLabel + ' references unknown runtime module: ' + entityModule.moduleId);
      }
    }
  }

  for (var sm = 0; sm < systemModules.length; sm++) {
    var sysModule = systemModules[sm] || {};
    var sysLabel = 'entityPlan.systemModules[' + sm + ']';
    if (!sysModule.moduleId) {
      errors.push(sysLabel + ' missing moduleId');
      continue;
    }
    if (!moduleRegistry[sysModule.moduleId]) {
      errors.push(sysLabel + ' references unknown runtime module: ' + sysModule.moduleId);
    }
  }

  for (var mi = 0; mi < moduleInstances.length; mi++) {
    var moduleInstance = moduleInstances[mi] || {};
    var moduleLabel = 'assemblyPlan.moduleInstances[' + moduleInstance.id + ']';
    if (!moduleInstance.moduleId) {
      errors.push(moduleLabel + ' missing moduleId');
      continue;
    }
    if (!moduleRegistry[moduleInstance.moduleId]) {
      errors.push(moduleLabel + ' references unknown runtime module: ' + moduleInstance.moduleId);
    }
    if (moduleInstance.entity && !entityIndex[moduleInstance.entity]) {
      errors.push(moduleLabel + ' references unknown entity: ' + moduleInstance.entity);
    }
  }

  var seenState = {};
  for (var so = 0; so < stateOwners.length; so++) {
    var stateOwner = stateOwners[so] || {};
    var ownerLabel = 'assemblyPlan.stateOwners[' + so + ']';
    if (!stateOwner.state) {
      errors.push(ownerLabel + ' missing state');
      continue;
    }
    if (!stateOwner.moduleInstanceId || !moduleInstanceIndex[stateOwner.moduleInstanceId]) {
      errors.push(ownerLabel + ' references unknown moduleInstanceId: ' + (stateOwner.moduleInstanceId || ''));
    }
    if (seenState[stateOwner.state]) {
      errors.push('Duplicate assemblyPlan.stateOwners state: ' + stateOwner.state);
    }
    seenState[stateOwner.state] = true;
  }

  for (var pb = 0; pb < phaseBindings.length; pb++) {
    var binding = phaseBindings[pb] || {};
    var bindingLabel = 'assemblyPlan.phaseBindings[' + binding.phaseId + ']';
    var atomIds = _ensureArray(binding.atomIds || [], bindingLabel + '.atomIds', errors);
    var activateEntities = _ensureArray(binding.activateEntities || [], bindingLabel + '.activateEntities', errors);
    var completionSignals = _ensureArray(binding.completionSignals || [], bindingLabel + '.completionSignals', errors);
    for (var pa = 0; pa < atomIds.length; pa++) {
      if (!atomIndex[atomIds[pa]]) {
        errors.push(bindingLabel + ' references unknown atomId: ' + atomIds[pa]);
      }
    }
    for (var pe = 0; pe < activateEntities.length; pe++) {
      if (!entityIndex[activateEntities[pe]]) {
        warnings.push(bindingLabel + ' activateEntities references unknown entity: ' + activateEntities[pe]);
      }
    }
    for (var ps = 0; ps < completionSignals.length; ps++) {
      if (!assertionRegistry[completionSignals[ps]]) {
        errors.push(bindingLabel + ' references unknown completion signal: ' + completionSignals[ps]);
      }
    }
  }

  for (var fo = 0; fo < fileOwners.length; fo++) {
    var fileOwner = fileOwners[fo] || {};
    var fileLabel = 'assemblyPlan.fileOwners[' + fo + ']';
    if (!fileOwner.file) errors.push(fileLabel + ' missing file');
    var ownerModuleIds = _ensureArray(fileOwner.moduleInstanceIds || [], fileLabel + '.moduleInstanceIds', errors);
    for (var fm = 0; fm < ownerModuleIds.length; fm++) {
      if (!moduleInstanceIndex[ownerModuleIds[fm]]) {
        errors.push(fileLabel + ' references unknown moduleInstanceId: ' + ownerModuleIds[fm]);
      }
    }
  }

  for (var cs = 0; cs < cuaSteps.length; cs++) {
    var step = cuaSteps[cs] || {};
    var stepLabel = 'cuaPlan.steps[' + cs + ']';
    if (!step.phaseId) {
      errors.push(stepLabel + ' missing phaseId');
      continue;
    }
    if (!phaseBindingIndex[step.phaseId]) {
      errors.push(stepLabel + ' references unknown phaseId: ' + step.phaseId);
    }
    var expectedSignals = _ensureArray(step.expectedSignals || [], stepLabel + '.expectedSignals', errors);
    var actionAtoms = _ensureArray(step.atomIds || [], stepLabel + '.atomIds', errors);
    for (var ca = 0; ca < actionAtoms.length; ca++) {
      if (!atomIndex[actionAtoms[ca]]) {
        errors.push(stepLabel + ' references unknown atomId: ' + actionAtoms[ca]);
      }
    }
    for (var ce = 0; ce < expectedSignals.length; ce++) {
      if (!assertionRegistry[expectedSignals[ce]]) {
        errors.push(stepLabel + ' references unknown assertion: ' + expectedSignals[ce]);
      }
    }
  }

  var unresolved = _ensureArray(assemblyPlan.unresolved || [], 'assemblyPlan.unresolved', errors);
  if (unresolved.length > 0) {
    warnings.push('assemblyPlan.unresolved has ' + unresolved.length + ' item(s)');
  }

  return {
    ok: errors.length === 0,
    errors: errors,
    warnings: warnings
  };
}

module.exports = {
  validateAssemblyPlans: validateAssemblyPlans
};
