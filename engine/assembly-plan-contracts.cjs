function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === '') return [];
  return [value];
}

function uniq(list) {
  var seen = {};
  var out = [];
  for (var i = 0; i < (list || []).length; i++) {
    var value = list[i];
    if (value == null || value === '') continue;
    var key = String(value);
    if (seen[key]) continue;
    seen[key] = true;
    out.push(value);
  }
  return out;
}

function buildAggregateCodeFromContext(ctx) {
  var code = ctx && ctx.csCode ? String(ctx.csCode) : '';
  var extraFiles = ctx && ctx.extraFiles || {};
  Object.keys(extraFiles).forEach(function(name) {
    if (typeof extraFiles[name] !== 'string') return;
    code += '\n' + extraFiles[name];
  });
  return code;
}

function stripComments(text) {
  return String(text || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

function indexAssemblyModuleInstances(assemblyPlan) {
  var moduleInstances = assemblyPlan && Array.isArray(assemblyPlan.moduleInstances)
    ? assemblyPlan.moduleInstances
    : [];
  var index = {};
  for (var i = 0; i < moduleInstances.length; i++) {
    index[moduleInstances[i].id] = moduleInstances[i];
  }
  return index;
}

function getAssemblyPlanFromBlueprint(blueprint) {
  if (!blueprint) return {};
  if (blueprint.plans && blueprint.plans.assemblyPlan) return blueprint.plans.assemblyPlan;
  if (blueprint.assemblyPlan) return blueprint.assemblyPlan;
  return {};
}

function collectAssemblyOwnerFiles(assemblyPlan) {
  var files = {};
  var fileOwners = Array.isArray(assemblyPlan && assemblyPlan.fileOwners) ? assemblyPlan.fileOwners : [];
  for (var i = 0; i < fileOwners.length; i++) {
    if (fileOwners[i] && fileOwners[i].file) files[fileOwners[i].file] = true;
  }

  var moduleInstances = Array.isArray(assemblyPlan && assemblyPlan.moduleInstances) ? assemblyPlan.moduleInstances : [];
  for (var j = 0; j < moduleInstances.length; j++) {
    var ownerFiles = toArray(moduleInstances[j] && moduleInstances[j].ownerFiles);
    for (var k = 0; k < ownerFiles.length; k++) {
      if (ownerFiles[k]) files[ownerFiles[k]] = true;
    }
  }

  return files;
}

function extractAssemblySlotOwnership(extraFiles) {
  var ownership = {};
  Object.keys(extraFiles || {}).forEach(function(file) {
    var text = String(extraFiles[file] || '');
    var re = /\/\/\s*\[ASSEMBLY SLOT\]\s*([^\r\n]+)/g;
    var match;
    while ((match = re.exec(text)) !== null) {
      var moduleInstanceId = normalizeAssemblySlotId(match[1]);
      if (!moduleInstanceId) continue;
      if (!ownership[moduleInstanceId]) ownership[moduleInstanceId] = [];
      if (ownership[moduleInstanceId].indexOf(file) < 0) ownership[moduleInstanceId].push(file);
    }
  });
  return ownership;
}

function normalizeAssemblySlotId(value) {
  return String(value || '')
    .trim()
    .replace(/^(?:装配槽|Assembly\s+slot|slot)\s+/i, '')
    .replace(/\s+\/\/.*$/, '')
    .trim();
}

function escapeRegex(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toCamelLikeToken(text) {
  var parts = String(text || '').split(/[._:\s-]+/).filter(Boolean);
  if (parts.length === 0) return '';
  var out = '';
  for (var i = 0; i < parts.length; i++) {
    var word = parts[i];
    if (i === 0) out += word.charAt(0).toLowerCase() + word.slice(1);
    else out += word.charAt(0).toUpperCase() + word.slice(1);
  }
  return out;
}

function addCandidateToken(tokens, token) {
  var text = String(token || '').trim();
  if (!text || text.length < 3) return;
  if (tokens.indexOf(text) >= 0) return;
  tokens.push(text);
}

function toPascalLikeToken(text) {
  var camel = toCamelLikeToken(text);
  if (!camel) return '';
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

function buildStateWriteSignals(state) {
  var text = String(state || '').trim();
  var tokens = [];
  if (!text) return tokens;

  var dotParts = text.split('.');
  var owner = dotParts.length > 1 ? dotParts[0] : '';
  var leaf = dotParts[dotParts.length - 1];
  var leafPascal = toPascalLikeToken(leaf);

  function addEntityOwnerSignals() {
    if (!owner || !leafPascal) return;
    addCandidateToken(tokens, owner + leafPascal);
    if (leaf === 'buildState' || leaf === 'upgradeLevel') addCandidateToken(tokens, owner + 'State');
    if (leaf === 'buildTimer') addCandidateToken(tokens, owner + 'BuildTimer');
    if (leaf === 'clicked') addCandidateToken(tokens, owner + 'Clicked');
    if (leaf === 'triggered') addCandidateToken(tokens, owner + 'Triggered');
    if (leaf === 'currentTarget') {
      addCandidateToken(tokens, owner + 'CurrentTarget');
      addCandidateToken(tokens, owner + 'Target');
    }
    if (leaf === 'cooldownTimer') {
      addCandidateToken(tokens, owner + 'CooldownTimer');
      addCandidateToken(tokens, owner + 'FireTimer');
      addCandidateToken(tokens, owner + 'SpawnTimer');
      addCandidateToken(tokens, owner + 'AttackTimer');
    }
    if (leaf === 'hp') addCandidateToken(tokens, owner + 'HP');
    if (leaf === 'deathState') addCandidateToken(tokens, owner + 'DeathState');
    if (leaf === 'dragState') addCandidateToken(tokens, owner + 'DragState');
    if (leaf === 'holdState') addCandidateToken(tokens, owner + 'HoldState');
  }

  if (dotParts.length === 2 && owner !== 'ui' && owner !== 'camera' && owner !== 'economy') {
    addEntityOwnerSignals();
    return tokens;
  }

  addCandidateToken(tokens, leaf);
  addCandidateToken(tokens, toCamelLikeToken(text));
  addCandidateToken(tokens, text.replace(/[^\w]/g, ''));

  if (dotParts.length === 2 && dotParts[0] === 'ui') {
    addCandidateToken(tokens, toCamelLikeToken(dotParts[1]));
  }
  if (dotParts.length === 2 && dotParts[0] === 'camera') {
    addCandidateToken(tokens, toCamelLikeToken(dotParts[1]));
  }
  if (dotParts.length === 2 && dotParts[0] === 'economy') {
    addCandidateToken(tokens, toCamelLikeToken(dotParts[1]));
    if (dotParts[1] === 'resources') addCandidateToken(tokens, 'resource');
  }

  return tokens;
}

function isStrictAssemblyOwnerState(state) {
  var text = String(state || '').trim();
  if (!text) return false;
  if (/[<>]/.test(text)) return false;

  if (text === 'economy.gold' || text === 'economy.resources') return true;
  if (text === 'input.tapState' || text === 'phase.timerState' || text === 'game.endState' || text === 'player.formId') return true;

  if (/^(camera|ui|spawn|projectile|system)\./.test(text)) return false;
  if (text === 'player.position') return false;

  var dotParts = text.split('.');
  var leaf = dotParts[dotParts.length - 1];
  if (!leaf) return false;

  if (leaf === 'position' ||
      leaf === 'visibleState' ||
      leaf === 'spawnState' ||
      leaf === 'visualVariant' ||
      leaf === 'animationState') {
    return false;
  }

  return [
    'buildState',
    'buildTimer',
    'upgradeLevel',
    'triggered',
    'clicked',
    'dragState',
    'holdState',
    'currentTarget',
    'cooldownTimer',
    'hp',
    'deathState'
  ].indexOf(leaf) >= 0;
}

function fileMayWriteState(fileContent, state) {
  var code = stripComments(fileContent);
  var candidates = buildStateWriteSignals(state);
  if (candidates.length === 0) return false;
  for (var i = 0; i < candidates.length; i++) {
    var assignmentRe = new RegExp('\\b' + escapeRegex(candidates[i]) + '\\b\\s*(?:[+\\-*/]?=(?!=)|\\+\\+|--)', 'i');
    if (assignmentRe.test(code)) return true;
  }
  return false;
}

function normalizePhaseId(value) {
  return String(value || '').toLowerCase().replace(/[_\s-]/g, '');
}

function splitPhaseWords(value) {
  return String(value || '')
    .replace(/([A-Z])/g, ' $1')
    .toLowerCase()
    .replace(/[_-]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(function(word) { return word && word.length >= 3; });
}

function extractReportedPhaseIds(code) {
  var text = String(code || '');
  var re = /(?:AddCompletedPhase|ReportPhase)\s*\(\s*"([^"]+)"/g;
  var ids = [];
  var match;
  while ((match = re.exec(text)) !== null) {
    ids.push(match[1]);
  }
  return uniq(ids);
}

function phaseIdMatches(expectedId, codeLower, extractedPhaseIds, extractedPhaseIdsLower) {
  var expected = String(expectedId || '');
  if (!expected) return true;

  if (codeLower.indexOf('"' + expected.toLowerCase() + '"') >= 0) {
    return true;
  }

  var expectedNorm = normalizePhaseId(expected);
  for (var i = 0; i < extractedPhaseIdsLower.length; i++) {
    if (extractedPhaseIdsLower[i] === expectedNorm ||
        extractedPhaseIdsLower[i].indexOf(expectedNorm) >= 0 ||
        expectedNorm.indexOf(extractedPhaseIdsLower[i]) >= 0) {
      return true;
    }
  }

  var expectedWords = splitPhaseWords(expected);
  for (var j = 0; j < extractedPhaseIds.length; j++) {
    var observedWords = splitPhaseWords(extractedPhaseIds[j]);
    var overlap = 0;
    for (var w = 0; w < expectedWords.length; w++) {
      if (observedWords.indexOf(expectedWords[w]) >= 0) overlap++;
    }
    if (overlap >= Math.max(2, Math.floor(expectedWords.length * 0.5))) {
      return true;
    }
  }

  return false;
}

function computePhaseCoverage(code, expectedPhaseIds) {
  var normalizedExpected = uniq((expectedPhaseIds || []).map(function(id) { return String(id || '').trim(); }).filter(Boolean));
  if (normalizedExpected.length === 0) {
    return {
      expectedPhaseIds: [],
      extractedPhaseIds: [],
      implementedCount: 0,
      missingPhaseIds: [],
      coverage: 1,
    };
  }

  var allCode = String(code || '');
  var codeLower = allCode.toLowerCase();
  var extractedPhaseIds = extractReportedPhaseIds(allCode);
  var extractedPhaseIdsLower = extractedPhaseIds.map(function(id) { return normalizePhaseId(id); });
  var implementedCount = 0;
  var missingPhaseIds = [];

  for (var i = 0; i < normalizedExpected.length; i++) {
    if (phaseIdMatches(normalizedExpected[i], codeLower, extractedPhaseIds, extractedPhaseIdsLower)) {
      implementedCount++;
    } else {
      missingPhaseIds.push(normalizedExpected[i]);
    }
  }

  return {
    expectedPhaseIds: normalizedExpected,
    extractedPhaseIds: extractedPhaseIds,
    implementedCount: implementedCount,
    missingPhaseIds: missingPhaseIds,
    coverage: normalizedExpected.length > 0 ? (implementedCount / normalizedExpected.length) : 1,
  };
}

function collectExpectedPhaseIds(blueprint) {
  var specs = blueprint && Array.isArray(blueprint.specs) ? blueprint.specs : [];
  if (specs.length > 0) {
    return uniq(specs.map(function(spec) { return spec && spec.phaseId; }).filter(Boolean));
  }

  var cuaSteps = blueprint && blueprint.plans && blueprint.plans.cuaPlan && Array.isArray(blueprint.plans.cuaPlan.steps)
    ? blueprint.plans.cuaPlan.steps
    : [];
  if (cuaSteps.length > 0) {
    return uniq(cuaSteps.map(function(step) { return step && step.phaseId; }).filter(Boolean));
  }

  var phaseBindings = blueprint && blueprint.plans && blueprint.plans.assemblyPlan && Array.isArray(blueprint.plans.assemblyPlan.phaseBindings)
    ? blueprint.plans.assemblyPlan.phaseBindings
    : [];
  if (phaseBindings.length > 0) {
    return uniq(phaseBindings.map(function(binding) { return binding && binding.phaseId; }).filter(Boolean));
  }

  return [];
}

function getExpectedPhaseSource(blueprint) {
  var specs = blueprint && Array.isArray(blueprint.specs) ? blueprint.specs : [];
  if (specs.length > 0) return 'spec';
  var cuaSteps = blueprint && blueprint.plans && blueprint.plans.cuaPlan && Array.isArray(blueprint.plans.cuaPlan.steps)
    ? blueprint.plans.cuaPlan.steps
    : [];
  if (cuaSteps.length > 0) return 'cua-plan';
  var phaseBindings = blueprint && blueprint.plans && blueprint.plans.assemblyPlan && Array.isArray(blueprint.plans.assemblyPlan.phaseBindings)
    ? blueprint.plans.assemblyPlan.phaseBindings
    : [];
  if (phaseBindings.length > 0) return 'assembly-plan';
  return 'none';
}

function summarizeAction(action) {
  if (!action || typeof action !== 'object') return '';
  var kind = String(action.kind || action.type || '').trim();
  if (!kind) return '';
  if (action.target) return kind + ':' + action.target;
  if (action.actor && action.target) return kind + ':' + action.actor + '->' + action.target;
  if (action.from || action.to) return kind + ':' + (action.from || '') + '->' + (action.to || '');
  return kind;
}

function buildReviewPlanGuidance(plans) {
  if (!plans || !plans.assemblyPlan) return '';
  var summary = {
    registryVersion: plans.registryVersion || null,
    phaseBindings: ((plans.assemblyPlan && plans.assemblyPlan.phaseBindings) || []).map(function(binding) {
      return {
        phaseId: binding.phaseId,
        activateEntities: toArray(binding.activateEntities),
        completionSignals: toArray(binding.completionSignals),
      };
    }),
    fileOwners: ((plans.assemblyPlan && plans.assemblyPlan.fileOwners) || []).map(function(owner) {
      return {
        file: owner.file,
        moduleInstanceIds: toArray(owner.moduleInstanceIds),
      };
    }),
    stateOwners: ((plans.assemblyPlan && plans.assemblyPlan.stateOwners) || []).map(function(owner) {
      return {
        state: owner.state,
        moduleInstanceId: owner.moduleInstanceId,
      };
    }),
    cuaSteps: ((plans.cuaPlan && plans.cuaPlan.steps) || []).map(function(step) {
      return {
        phaseId: step.phaseId,
        actions: toArray(step.actions).map(summarizeAction).filter(Boolean),
        expectedSignals: toArray(step.expectedSignals),
        phaseEvidenceSchema: toArray(step.phaseEvidenceSchema),
      };
    }),
    unresolved: toArray(plans.assemblyPlan && plans.assemblyPlan.unresolved),
  };
  return JSON.stringify(summary, null, 2);
}

function detectAssemblyContractViolations(ctx) {
  var violations = [];
  var blueprint = ctx && ctx.blueprint || {};
  var plans = blueprint.plans || {};
  var assemblyPlan = getAssemblyPlanFromBlueprint(blueprint);
  var extraFiles = ctx && ctx.extraFiles || {};

  if (blueprint.planValidation && blueprint.planValidation.ok === false) {
    violations.push({
      rule: 'assembly-plan-validation',
      severity: 'critical',
      message: 'Assembly plan validation failed: ' + toArray(blueprint.planValidation.errors).slice(0, 8).join('; '),
      data: blueprint.planValidation,
    });
  }

  var expectedFiles = uniq(toArray(assemblyPlan.fileOwners).map(function(owner) { return owner && owner.file; }).filter(Boolean)).sort();
  if (expectedFiles.length > 0) {
    var missingFiles = expectedFiles.filter(function(file) {
      return typeof extraFiles[file] !== 'string' || extraFiles[file].trim().length === 0;
    });
    if (missingFiles.length > 0) {
      violations.push({
        rule: 'assembly-owner-file-missing',
        severity: 'critical',
        message: 'Assembly owner files are missing or empty: ' + missingFiles.join(', ') +
          '. The generated output must keep module code in the plan-owned partial files.',
        data: {
          missingFiles: missingFiles,
          expectedFiles: expectedFiles,
        },
      });
    }
  }

  var moduleIndex = indexAssemblyModuleInstances(assemblyPlan);
  var slotOwnership = extractAssemblySlotOwnership(extraFiles);
  Object.keys(moduleIndex).forEach(function(moduleInstanceId) {
    var instance = moduleIndex[moduleInstanceId] || {};
    var expectedOwnerFiles = uniq(toArray(instance.ownerFiles).filter(Boolean)).sort();
    if (expectedOwnerFiles.length === 0) return;

    var observedFiles = uniq(toArray(slotOwnership[moduleInstanceId]).filter(Boolean)).sort();
    var missingOwnerScaffolds = expectedOwnerFiles.filter(function(file) {
      return observedFiles.indexOf(file) < 0;
    });
    var unexpectedOwnerFiles = observedFiles.filter(function(file) {
      return expectedOwnerFiles.indexOf(file) < 0;
    });

    if (missingOwnerScaffolds.length > 0 || unexpectedOwnerFiles.length > 0) {
      violations.push({
        rule: 'assembly-module-owner-mismatch',
        severity: 'critical',
        message: 'Module `' + moduleInstanceId + '` scaffold ownership drifted. Expected owner files: ' +
          expectedOwnerFiles.join(', ') + '. Observed: ' + (observedFiles.join(', ') || '(none)') + '.',
        data: {
          moduleInstanceId: moduleInstanceId,
          expectedOwnerFiles: expectedOwnerFiles,
          observedFiles: observedFiles,
          missingOwnerScaffolds: missingOwnerScaffolds,
          unexpectedOwnerFiles: unexpectedOwnerFiles,
        },
      });
    }
  });

  var stateOwners = Array.isArray(assemblyPlan.stateOwners) ? assemblyPlan.stateOwners : [];
  var assemblyOwnerFiles = collectAssemblyOwnerFiles(assemblyPlan);
  for (var s = 0; s < stateOwners.length; s++) {
    var owner = stateOwners[s] || {};
    var moduleInstance = moduleIndex[owner.moduleInstanceId] || {};
    var allowedFiles = uniq(toArray(moduleInstance.ownerFiles).filter(Boolean));
    if (!owner.state || allowedFiles.length === 0) continue;
    if (!isStrictAssemblyOwnerState(owner.state)) continue;

    var violatingFiles = [];
    Object.keys(extraFiles).forEach(function(file) {
      if (!assemblyOwnerFiles[file]) return;
      if (allowedFiles.indexOf(file) >= 0) return;
      if (typeof extraFiles[file] !== 'string') return;
      if (fileMayWriteState(extraFiles[file], owner.state)) violatingFiles.push(file);
    });

    if (violatingFiles.length > 0) {
      violations.push({
        rule: 'assembly-state-owner-mismatch',
        severity: 'critical',
        message: 'State `' + owner.state + '` is owned by `' + owner.moduleInstanceId + '` in ' +
          allowedFiles.join(', ') + ' but appears to be mutated from: ' + violatingFiles.join(', ') + '.',
        data: {
          state: owner.state,
          moduleInstanceId: owner.moduleInstanceId,
          allowedFiles: allowedFiles,
          violatingFiles: violatingFiles,
        },
      });
    }
  }

  var expectedPhaseIds = collectExpectedPhaseIds(blueprint);
  if (expectedPhaseIds.length > 0) {
    var coverage = computePhaseCoverage(buildAggregateCodeFromContext(ctx), expectedPhaseIds);
    if (coverage.coverage < 0.8) {
      violations.push({
        rule: 'assembly-phase-coverage',
        severity: 'critical',
        message: 'Assembly phase coverage too low: ' + coverage.implementedCount + '/' + coverage.expectedPhaseIds.length +
          ' (' + Math.round(coverage.coverage * 100) + '%). Missing: ' + coverage.missingPhaseIds.join(', ') +
          '. Use exact phase IDs from the ' + getExpectedPhaseSource(blueprint) + ' contract.',
        data: coverage,
      });
    }
  }

  return violations;
}

module.exports = {
  buildAggregateCodeFromContext: buildAggregateCodeFromContext,
  extractAssemblySlotOwnership: extractAssemblySlotOwnership,
  getAssemblyPlanFromBlueprint: getAssemblyPlanFromBlueprint,
  collectAssemblyOwnerFiles: collectAssemblyOwnerFiles,
  buildStateWriteSignals: buildStateWriteSignals,
  isStrictAssemblyOwnerState: isStrictAssemblyOwnerState,
  fileMayWriteState: fileMayWriteState,
  extractReportedPhaseIds: extractReportedPhaseIds,
  computePhaseCoverage: computePhaseCoverage,
  collectExpectedPhaseIds: collectExpectedPhaseIds,
  getExpectedPhaseSource: getExpectedPhaseSource,
  buildReviewPlanGuidance: buildReviewPlanGuidance,
  detectAssemblyContractViolations: detectAssemblyContractViolations,
};
