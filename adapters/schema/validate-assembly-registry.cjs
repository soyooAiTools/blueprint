var { loadAssemblyRegistry } = require('./load-assembly-registry.cjs');

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

function _pushArrayFieldErrors(item, field, label, errors) {
  var value = item[field];
  if (!Array.isArray(value)) {
    errors.push(label + '.' + field + ' must be an array');
    return;
  }
  if (value.length === 0) {
    errors.push(label + '.' + field + ' must not be empty');
  }
}

function validateAssemblyRegistry(registry) {
  registry = registry || loadAssemblyRegistry();

  var errors = [];
  var warnings = [];

  var atomItems = (registry.storyboardAtoms && registry.storyboardAtoms.items) || [];
  var moduleItems = (registry.runtimeModules && registry.runtimeModules.items) || [];
  var archetypeItems = (registry.runtimeModules && registry.runtimeModules.archetypes) || [];
  var assertionItems = (registry.cuaAssertions && registry.cuaAssertions.items) || [];
  var mappingItems = (registry.mappings && registry.mappings.items) || [];

  var atomIndex = _indexById(atomItems, 'storyboardAtom', errors);
  var moduleIndex = _indexById(moduleItems, 'runtimeModule', errors);
  var assertionIndex = _indexById(assertionItems, 'cuaAssertion', errors);
  var archetypeIndex = _indexById(archetypeItems, 'archetype', errors);

  for (var i = 0; i < atomItems.length; i++) {
    var atom = atomItems[i];
    var atomLabel = 'storyboardAtom[' + atom.id + ']';
    if (!atom.category) errors.push(atomLabel + '.category missing');
    if (!atom.description) errors.push(atomLabel + '.description missing');
    _pushArrayFieldErrors(atom, 'params', atomLabel, errors);
    _pushArrayFieldErrors(atom, 'mapsToModules', atomLabel, errors);
    _pushArrayFieldErrors(atom, 'cuaAssertions', atomLabel, errors);
    for (var ai = 0; ai < (atom.mapsToModules || []).length; ai++) {
      var mappedModule = atom.mapsToModules[ai];
      if (!moduleIndex[mappedModule]) {
        errors.push(atomLabel + ' references unknown runtime module: ' + mappedModule);
      }
    }
    for (var aa = 0; aa < (atom.cuaAssertions || []).length; aa++) {
      var atomAssertion = atom.cuaAssertions[aa];
      if (!assertionIndex[atomAssertion]) {
        errors.push(atomLabel + ' references unknown CUA assertion: ' + atomAssertion);
      }
    }
  }

  for (var j = 0; j < moduleItems.length; j++) {
    var moduleItem = moduleItems[j];
    var moduleLabel = 'runtimeModule[' + moduleItem.id + ']';
    if (!moduleItem.level) errors.push(moduleLabel + '.level missing');
    if (!moduleItem.description) errors.push(moduleLabel + '.description missing');
    _pushArrayFieldErrors(moduleItem, 'params', moduleLabel, errors);
    _pushArrayFieldErrors(moduleItem, 'ownerFiles', moduleLabel, errors);
    _pushArrayFieldErrors(moduleItem, 'statesWritten', moduleLabel, errors);
    _pushArrayFieldErrors(moduleItem, 'observableFeedback', moduleLabel, errors);
    if (!moduleItem.autoplayMirror) warnings.push(moduleLabel + '.autoplayMirror missing');
  }

  for (var k = 0; k < archetypeItems.length; k++) {
    var archetype = archetypeItems[k];
    var archetypeLabel = 'archetype[' + archetype.id + ']';
    _pushArrayFieldErrors(archetype, 'modules', archetypeLabel, errors);
    for (var am = 0; am < (archetype.modules || []).length; am++) {
      var archetypeModule = archetype.modules[am];
      if (!moduleIndex[archetypeModule]) {
        errors.push(archetypeLabel + ' references unknown runtime module: ' + archetypeModule);
      }
    }
  }

  for (var m = 0; m < mappingItems.length; m++) {
    var mapping = mappingItems[m];
    var mappingLabel = 'mapping[' + m + ']';
    if (!mapping.atomId) {
      errors.push(mappingLabel + '.atomId missing');
      continue;
    }
    if (!atomIndex[mapping.atomId]) {
      errors.push(mappingLabel + ' references unknown atom: ' + mapping.atomId);
    }
    _pushArrayFieldErrors(mapping, 'moduleCombo', mappingLabel, errors);
    _pushArrayFieldErrors(mapping, 'requiredSignals', mappingLabel, errors);
    _pushArrayFieldErrors(mapping, 'cuaAssertions', mappingLabel, errors);
    for (var mm = 0; mm < (mapping.moduleCombo || []).length; mm++) {
      var comboModule = mapping.moduleCombo[mm];
      if (!moduleIndex[comboModule]) {
        errors.push(mappingLabel + ' references unknown runtime module: ' + comboModule);
      }
    }
    for (var ms = 0; ms < (mapping.requiredSignals || []).length; ms++) {
      var signal = mapping.requiredSignals[ms];
      if (!assertionIndex[signal]) {
        errors.push(mappingLabel + ' references unknown required signal: ' + signal);
      }
    }
    for (var mc = 0; mc < (mapping.cuaAssertions || []).length; mc++) {
      var mappingAssertion = mapping.cuaAssertions[mc];
      if (!assertionIndex[mappingAssertion]) {
        errors.push(mappingLabel + ' references unknown CUA assertion: ' + mappingAssertion);
      }
    }
  }

  for (var atomId in atomIndex) {
    if (!atomIndex.hasOwnProperty(atomId)) continue;
    var hasMapping = false;
    for (var mi = 0; mi < mappingItems.length; mi++) {
      if (mappingItems[mi] && mappingItems[mi].atomId === atomId) {
        hasMapping = true;
        break;
      }
    }
    if (!hasMapping) {
      warnings.push('Atom has no mapping entry: ' + atomId);
    }
  }

  return {
    ok: errors.length === 0,
    errors: errors,
    warnings: warnings
  };
}

if (require.main === module) {
  var result = validateAssemblyRegistry();
  if (result.errors.length > 0) {
    console.error('Assembly registry invalid:');
    for (var i = 0; i < result.errors.length; i++) {
      console.error('- ' + result.errors[i]);
    }
    if (result.warnings.length > 0) {
      console.error('Warnings:');
      for (var j = 0; j < result.warnings.length; j++) {
        console.error('- ' + result.warnings[j]);
      }
    }
    process.exit(1);
  }
  console.log('Assembly registry OK');
  if (result.warnings.length > 0) {
    console.log('Warnings:');
    for (var k = 0; k < result.warnings.length; k++) {
      console.log('- ' + result.warnings[k]);
    }
  }
}

module.exports = {
  validateAssemblyRegistry: validateAssemblyRegistry
};
