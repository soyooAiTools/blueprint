'use strict';

var fs = require('fs');
var path = require('path');

var SUPPORTED_SCHEMA_VERSION = '1.0.0';
var SNAPSHOT_SCHEMA_MIN = '1.0.0';
var DEFAULT_CONTRACT_PATH = path.join(__dirname, '..', 'contracts', 'cua-probe-contracts.v1.json');
var PILLARS = ['schema', 'emitter', 'runtimeEvidence', 'staticCheck', 'cuaProbe'];
var KNOWN_OPS = {
  flag_set: true,
  field_present: true,
  field_eq: true,
  field_neq: true,
  field_gt: true,
  field_lt: true,
  field_gte: true,
  field_lte: true,
  delta_gt: true,
  delta_gte: true,
  delta_lt: true,
  delta_eq_zero: true,
  array_length_gte: true,
  entity_visible: true,
  entity_absent: true,
  visual_hash_delta_gte: true,
  realtime_elapsed_gte: true,
};

function readContract(input) {
  if (input == null || input === '') {
    input = process.env.CUA_PROBE_CONTRACT_FILE || DEFAULT_CONTRACT_PATH;
  }
  if (typeof input === 'string') {
    return JSON.parse(fs.readFileSync(input, 'utf-8'));
  }
  if (!input || typeof input !== 'object') {
    throw new Error('CUA probe contract must be an object or JSON file path');
  }
  return input;
}

function loadProbeContracts(input) {
  var doc = readContract(input);
  validateProbeContracts(doc);
  return doc;
}

function validateProbeContracts(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('CUA probe contract root must be an object');
  }
  if (doc.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw new Error('Unsupported CUA probe schemaVersion: ' + doc.schemaVersion);
  }
  if (typeof doc.contractVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(doc.contractVersion)) {
    throw new Error('CUA probe contractVersion must be semver-like');
  }
  if (!isPlainObject(doc.moduleProbeContracts)) {
    throw new Error('CUA probe contract missing moduleProbeContracts object');
  }
  if (!isPlainObject(doc.gapAttributionSubtypes)) {
    throw new Error('CUA probe contract missing gapAttributionSubtypes object');
  }

  Object.keys(doc.moduleProbeContracts).forEach(function(moduleId) {
    validateModuleProbeContract(moduleId, doc.moduleProbeContracts[moduleId]);
  });
  Object.keys(doc.gapAttributionSubtypes).forEach(function(subtypeId) {
    validateGapAttributionSubtype(subtypeId, doc.gapAttributionSubtypes[subtypeId]);
  });
  return true;
}

function validateModuleProbeContract(moduleId, contract) {
  if (!isPlainObject(contract)) throw new Error(moduleId + ' probe contract must be an object');
  if (contract.moduleId !== moduleId) {
    throw new Error(moduleId + ' moduleId mismatch: ' + contract.moduleId);
  }
  validateCompletenessChecks(moduleId, contract.completenessChecks);
  requireArray(moduleId, contract.expectedSignals, 'expectedSignals');
  requireArray(moduleId, contract.evidenceFields, 'evidenceFields');
  requireRule(moduleId + '.passRule', contract.passRule);
  requireRule(moduleId + '.antiAutoplay', contract.antiAutoplay);
  requireArray(moduleId, contract.failureAttribution, 'failureAttribution');
  requireArray(moduleId, contract.metricFields, 'metricFields');

  var signalSeen = {};
  contract.expectedSignals.forEach(function(signal, idx) {
    if (typeof signal !== 'string' || !signal) {
      throw new Error(moduleId + '.expectedSignals[' + idx + '] must be a non-empty string');
    }
    if (signalSeen[signal]) throw new Error(moduleId + '.expectedSignals duplicate: ' + signal);
    signalSeen[signal] = true;
  });

  contract.failureAttribution.forEach(function(entry, idx) {
    var label = moduleId + '.failureAttribution[' + idx + ']';
    if (!isPlainObject(entry)) throw new Error(label + ' must be an object');
    if (!Number.isInteger(entry.priority) || entry.priority < 0) throw new Error(label + '.priority must be a non-negative integer');
    if (entry.id != null && typeof entry.id !== 'string') throw new Error(label + '.id must be a string');
    if (typeof entry.ledgerSource !== 'string' || !entry.ledgerSource) throw new Error(label + '.ledgerSource missing');
    if (typeof entry.ledgerGapType !== 'string' || !entry.ledgerGapType) throw new Error(label + '.ledgerGapType missing');
    requireRule(label + '.condition', entry.condition);
  });
}

function validateGapAttributionSubtype(subtypeId, subtype) {
  if (!isPlainObject(subtype)) throw new Error(subtypeId + ' attribution subtype must be an object');
  if (subtype.subtype !== subtypeId) throw new Error(subtypeId + ' subtype mismatch: ' + subtype.subtype);
  if (!Number.isInteger(subtype.priority) || subtype.priority < 0) throw new Error(subtypeId + '.priority must be a non-negative integer');
  if (typeof subtype.parentGapType !== 'string' || !subtype.parentGapType) throw new Error(subtypeId + '.parentGapType missing');
  requireArray(subtypeId, subtype.matchInputs, 'matchInputs');
  requireRule(subtypeId + '.requiredEvidence', subtype.requiredEvidence);
  if (typeof subtype.ledgerSubtype !== 'string' || !subtype.ledgerSubtype) throw new Error(subtypeId + '.ledgerSubtype missing');
}

function validateCompletenessChecks(moduleId, checks) {
  if (!isPlainObject(checks)) throw new Error(moduleId + '.completenessChecks must be an object');
  PILLARS.forEach(function(pillar) {
    var check = checks[pillar];
    var label = moduleId + '.completenessChecks.' + pillar;
    if (!isPlainObject(check)) throw new Error(label + ' must be an object');
    if (!/^(present|missing|stale|unverified)$/.test(check.status || '')) throw new Error(label + '.status is invalid: ' + check.status);
    if (typeof check.source !== 'string' || !check.source) throw new Error(label + '.source missing');
    if (typeof check.blocking !== 'boolean') throw new Error(label + '.blocking must be boolean');
  });
}

function requireRule(label, rule) {
  if (!isPlainObject(rule)) throw new Error(label + ' must be an object');
  if (rule.op) {
    if (!KNOWN_OPS[rule.op]) throw new Error(label + ' unknown op: ' + rule.op);
    if (typeof rule.path !== 'string' || !rule.path) throw new Error(label + '.path missing');
    return;
  }
  if (!/^(all-of|any-of|k-of-n|not)$/.test(rule.type || '')) {
    throw new Error(label + '.type/op missing or invalid');
  }
  requireArray(label, rule.clauses, 'clauses');
  if (rule.type === 'k-of-n' && (!Number.isInteger(rule.k) || rule.k < 1)) {
    throw new Error(label + '.k must be a positive integer for k-of-n');
  }
  rule.clauses.forEach(function(child, idx) {
    requireRule(label + '.clauses[' + idx + ']', child);
  });
}

function computeModuleCompleteness(moduleContract) {
  var checks = moduleContract && moduleContract.completenessChecks;
  if (!isPlainObject(checks)) throw new Error('module completeness requires completenessChecks');

  var blockingMissing = [];
  var warnings = [];
  var statusByPillar = {};
  PILLARS.forEach(function(pillar) {
    var check = checks[pillar];
    statusByPillar[pillar] = check.status;
    if (check.status === 'present') return;
    var item = { pillar: pillar, status: check.status, source: check.source };
    if (check.blocking) blockingMissing.push(item);
    else warnings.push(item);
  });

  return {
    moduleId: moduleContract.moduleId,
    completeness: blockingMissing.length === 0 ? 1 : 0,
    blockingMissing: blockingMissing,
    warnings: warnings,
    statusByPillar: statusByPillar,
  };
}

function summarizeProbeContracts(input) {
  var doc = loadProbeContracts(input);
  var moduleIds = Object.keys(doc.moduleProbeContracts).sort();
  var modules = {};
  var completeCount = 0;
  var blockingMissingTotal = 0;
  var warningTotal = 0;

  moduleIds.forEach(function(moduleId) {
    var summary = computeModuleCompleteness(doc.moduleProbeContracts[moduleId]);
    modules[moduleId] = summary;
    if (summary.completeness >= 1) completeCount++;
    blockingMissingTotal += summary.blockingMissing.length;
    warningTotal += summary.warnings.length;
  });

  return {
    schemaVersion: doc.schemaVersion,
    contractVersion: doc.contractVersion,
    moduleCount: moduleIds.length,
    completeCount: completeCount,
    incompleteCount: moduleIds.length - completeCount,
    blockingMissingTotal: blockingMissingTotal,
    warningTotal: warningTotal,
    modules: modules,
  };
}

function readRuntimeRegistry(input) {
  if (typeof input === 'string') {
    return JSON.parse(fs.readFileSync(input, 'utf-8'));
  }
  if (!input || typeof input !== 'object') {
    throw new Error('runtime module registry must be an object or JSON file path');
  }
  return input;
}

function summarizeContractRegistryCoverage(contractInput, registryInput) {
  var doc = loadProbeContracts(contractInput);
  var registry = readRuntimeRegistry(registryInput);
  if (!Array.isArray(registry.items)) {
    throw new Error('runtime module registry missing items array');
  }

  var runtimeItems = registry.items.filter(function(item) {
    return item && item.level === 'L1' && typeof item.id === 'string' && item.id;
  }).sort(function(a, b) {
    return a.id.localeCompare(b.id);
  });
  var contractIds = Object.keys(doc.moduleProbeContracts).sort();
  var contractSet = {};
  var registrySet = {};
  contractIds.forEach(function(id) { contractSet[id] = true; });
  runtimeItems.forEach(function(item) { registrySet[item.id] = true; });

  var coveredModuleIds = [];
  var missingModuleIds = [];
  var completeCoveredModuleIds = [];
  var incompleteCoveredModuleIds = [];
  var modules = {};

  runtimeItems.forEach(function(item) {
    var contract = doc.moduleProbeContracts[item.id] || null;
    var completeness = contract ? computeModuleCompleteness(contract) : null;
    var hasProbeContract = !!contract;
    if (hasProbeContract) {
      coveredModuleIds.push(item.id);
      if (completeness.completeness >= 1) completeCoveredModuleIds.push(item.id);
      else incompleteCoveredModuleIds.push(item.id);
    } else {
      missingModuleIds.push(item.id);
    }
    modules[item.id] = {
      moduleId: item.id,
      registryLevel: item.level,
      hasProbeContract: hasProbeContract,
      completeness: completeness ? completeness.completeness : 0,
      blockingMissing: completeness ? completeness.blockingMissing : [],
      warnings: completeness ? completeness.warnings : [],
      observableFeedback: Array.isArray(item.observableFeedback) ? item.observableFeedback.slice() : [],
      ownerFiles: Array.isArray(item.ownerFiles) ? item.ownerFiles.slice() : [],
    };
  });

  var contractOnlyModuleIds = contractIds.filter(function(id) {
    return !registrySet[id];
  });

  return {
    schemaVersion: doc.schemaVersion,
    contractVersion: doc.contractVersion,
    registryVersion: registry.version || null,
    runtimeL1ModuleCount: runtimeItems.length,
    contractModuleCount: contractIds.length,
    coveredModuleCount: coveredModuleIds.length,
    missingModuleCount: missingModuleIds.length,
    contractOnlyModuleCount: contractOnlyModuleIds.length,
    completeCoveredModuleCount: completeCoveredModuleIds.length,
    incompleteCoveredModuleCount: incompleteCoveredModuleIds.length,
    coverage: runtimeItems.length ? coveredModuleIds.length / runtimeItems.length : 0,
    coveredModuleIds: coveredModuleIds,
    missingModuleIds: missingModuleIds,
    contractOnlyModuleIds: contractOnlyModuleIds,
    completeCoveredModuleIds: completeCoveredModuleIds,
    incompleteCoveredModuleIds: incompleteCoveredModuleIds,
    modules: modules,
  };
}

function extractSnapshotFieldKey(path, moduleId) {
  if (typeof path !== 'string') return null;
  var prefix = 'phaseEvidence.' + moduleId + '.';
  if (path.indexOf(prefix) !== 0) return null;
  var suffix = path.substring(prefix.length);
  if (!suffix) return null;
  if (suffix.indexOf('<before-after>.') === 0) {
    return { kind: 'pair', leaf: suffix.substring('<before-after>.'.length) };
  }
  return { kind: 'single', key: suffix };
}

function resolveSnapshotField(snapshotFields, key) {
  if (!isPlainObject(snapshotFields)) return { present: false, value: undefined };
  var dotIdx = key.indexOf('.');
  if (dotIdx < 0) {
    var has = Object.prototype.hasOwnProperty.call(snapshotFields, key);
    return { present: has, value: has ? snapshotFields[key] : undefined };
  }
  var parent = key.substring(0, dotIdx);
  var leaf = key.substring(dotIdx + 1);
  var nested = snapshotFields[parent];
  if (!isPlainObject(nested)) return { present: false, value: undefined };
  var hasNested = Object.prototype.hasOwnProperty.call(nested, leaf);
  return { present: hasNested, value: hasNested ? nested[leaf] : undefined };
}

function readSnapshotForModule(observation, phaseId, moduleId) {
  if (!isPlainObject(observation)) return null;
  var phaseEvidence = observation.phaseEvidence;
  if (!isPlainObject(phaseEvidence)) return null;
  var phaseBlock = phaseEvidence[phaseId];
  if (!isPlainObject(phaseBlock)) return null;
  var snapshot = phaseBlock[moduleId];
  if (!isPlainObject(snapshot)) return null;
  return snapshot;
}

function snapshotSchemaCompatible(snapshotVersion) {
  if (typeof snapshotVersion !== 'string' || !snapshotVersion) return false;
  function versionParts(value) {
    return value.split('.').map(function(part) { return parseInt(part, 10) || 0; });
  }
  var actual = versionParts(snapshotVersion);
  var min = versionParts(SNAPSHOT_SCHEMA_MIN);
  var len = Math.max(actual.length, min.length);
  for (var i = 0; i < len; i++) {
    var a = actual[i] || 0;
    var b = min[i] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

function stripSnapshotMeta(snapshot) {
  var fields = {};
  if (!isPlainObject(snapshot)) return fields;
  Object.keys(snapshot).forEach(function(key) {
    if (key !== '_meta') fields[key] = snapshot[key];
  });
  return fields;
}

function classifySnapshotCoverage(moduleContract, snapshot) {
  if (!snapshot) {
    return { outcome: 'absent', missingRequired: [], missingOptional: [], snapshotPresent: false };
  }
  var meta = snapshot._meta;
  if (!isPlainObject(meta) || !snapshotSchemaCompatible(meta.schemaVersion)) {
    return { outcome: 'absent', missingRequired: [], missingOptional: [], snapshotPresent: false };
  }
  var fields = stripSnapshotMeta(snapshot);
  var missingRequired = [];
  var missingOptional = [];
  (moduleContract.evidenceFields || []).forEach(function(evidenceField) {
    var extracted = extractSnapshotFieldKey(evidenceField.path, moduleContract.moduleId);
    if (!extracted) return;
    var keysToCheck = [];
    if (extracted.kind === 'pair') {
      keysToCheck.push('before.' + extracted.leaf);
      keysToCheck.push('after.' + extracted.leaf);
    } else {
      keysToCheck.push(extracted.key);
    }
    keysToCheck.forEach(function(key) {
      var resolved = resolveSnapshotField(fields, key);
      if (!resolved.present) {
        if (evidenceField.required) missingRequired.push(key);
        else missingOptional.push(key);
      }
    });
  });
  if (missingRequired.length > 0) {
    return {
      outcome: 'incomplete',
      missingRequired: missingRequired,
      missingOptional: missingOptional,
      snapshotPresent: true,
    };
  }
  if (missingOptional.length > 0) {
    return {
      outcome: 'present_partial',
      missingRequired: [],
      missingOptional: missingOptional,
      snapshotPresent: true,
    };
  }
  return {
    outcome: 'present_full',
    missingRequired: [],
    missingOptional: [],
    snapshotPresent: true,
  };
}

function inferPhaseIdsFromObservation(observation) {
  var phaseEvidence = observation && observation.phaseEvidence;
  if (!isPlainObject(phaseEvidence)) return [];
  return Object.keys(phaseEvidence).filter(function(phaseId) {
    return phaseId !== '_meta' && isPlainObject(phaseEvidence[phaseId]);
  }).sort();
}

function summarizePhaseEvidenceSnapshotCoverage(contractInput, observation, opts) {
  var doc = loadProbeContracts(contractInput);
  var moduleIds = Object.keys(doc.moduleProbeContracts).sort();
  var phaseIds = opts && Array.isArray(opts.phaseIds) && opts.phaseIds.length
    ? opts.phaseIds.slice()
    : inferPhaseIdsFromObservation(observation);
  var byModule = {};
  var byPhase = {};
  var totalPairs = 0;
  var fullCount = 0;
  var anyPresentCount = 0;
  var sample = [];

  moduleIds.forEach(function(moduleId) {
    byModule[moduleId] = { absent: 0, incomplete: 0, present_partial: 0, present_full: 0 };
  });
  phaseIds.forEach(function(phaseId) {
    byPhase[phaseId] = { absent: [], incomplete: [], present_partial: [], present_full: [] };
  });

  phaseIds.forEach(function(phaseId) {
    moduleIds.forEach(function(moduleId) {
      var contract = doc.moduleProbeContracts[moduleId];
      var snapshot = readSnapshotForModule(observation, phaseId, moduleId);
      var classified = classifySnapshotCoverage(contract, snapshot);
      byModule[moduleId][classified.outcome]++;
      byPhase[phaseId][classified.outcome].push(moduleId);
      totalPairs++;
      if (classified.outcome === 'present_full') fullCount++;
      if (classified.outcome === 'present_full' || classified.outcome === 'present_partial') anyPresentCount++;
      if (classified.outcome !== 'absent' && sample.length < 8) {
        sample.push({
          phaseId: phaseId,
          moduleId: moduleId,
          outcome: classified.outcome,
          missingRequired: classified.missingRequired,
          missingOptional: classified.missingOptional,
        });
      }
    });
  });

  return {
    schemaVersion: doc.schemaVersion,
    contractVersion: doc.contractVersion,
    minSnapshotSchemaVersion: SNAPSHOT_SCHEMA_MIN,
    phaseIds: phaseIds,
    moduleIds: moduleIds,
    totalModulePhasePairs: totalPairs,
    coveragePresentFullRate: totalPairs ? fullCount / totalPairs : 0,
    coverageAnyPresentRate: totalPairs ? anyPresentCount / totalPairs : 0,
    byModule: byModule,
    byPhase: byPhase,
    sample: sample,
  };
}

function orderedFailureAttribution(moduleContract) {
  requireArray(moduleContract.moduleId || 'module', moduleContract.failureAttribution, 'failureAttribution');
  return moduleContract.failureAttribution.slice().sort(function(a, b) {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
}

function buildEvaluationContext(observation, refs) {
  if (observation && observation.observation && observation.refs !== undefined) {
    return observation;
  }
  var obs = observation || {};
  var normalized = Object.assign({ game_state: obs }, obs);
  if (normalized.entity_states == null && obs.entityStates != null) normalized.entity_states = obs.entityStates;
  if (normalized.camera_state == null && obs.cameraState != null) normalized.camera_state = obs.cameraState;
  if (normalized.ui_state == null && obs.uiState != null) normalized.ui_state = obs.uiState;
  return {
    observation: normalized,
    refs: refs || {},
  };
}

function walkPath(obs, pathStr, refs) {
  if (!pathStr) return [];
  if (pathStr.indexOf('<before-after>') >= 0) {
    throw new Error('walkPath paths with <before-after> must use getBeforeAfterPair');
  }
  return enumerateSegs(obs, pathStr.split('.'), 0, refs || {});
}

function enumerateSegs(obj, segs, i, refs) {
  if (i >= segs.length) return [obj];
  if (obj == null) return [];
  var seg = segs[i];
  if (seg === 'length') {
    if (Array.isArray(obj)) return [obj.length];
    if (obj && typeof obj.length === 'number') return [obj.length];
    return [];
  }
  var m = /^<([^>]+)>$/.exec(seg);
  if (m) {
    var key = m[1];
    if (refs && refs[key] != null) {
      if (typeof obj !== 'object') return [];
      return enumerateSegs(obj[refs[key]], segs, i + 1, refs);
    }
    if (typeof obj !== 'object' || Array.isArray(obj)) return [];
    var out = [];
    Object.keys(obj).forEach(function(childKey) {
      out = out.concat(enumerateSegs(obj[childKey], segs, i + 1, refs));
    });
    return out;
  }
  if (typeof obj !== 'object') return [];
  return enumerateSegs(obj[seg], segs, i + 1, refs);
}

function getBeforeAfterPair(obs, pathStr, refs) {
  return [
    walkPath(obs, pathStr.replace('<before-after>', 'before'), refs)[0],
    walkPath(obs, pathStr.replace('<before-after>', 'after'), refs)[0],
  ];
}

function evaluateClause(clause, ctx) {
  var op = clause.op;
  var refs = ctx.refs || {};
  var obs = ctx.observation || {};
  var pathStr = clause.path || '';
  function valuesOf() { return walkPath(obs, pathStr, refs); }

  if (op === 'flag_set') return valuesOf().some(function(v) { return v === true; });
  if (op === 'field_present') {
    var presentValues = valuesOf();
    var anyPresent = presentValues.some(function(v) { return v !== undefined && v !== null; });
    return anyPresent === (clause.value !== false);
  }
  if (op === 'field_eq') return valuesOf().some(function(v) { return v === clause.value; });
  if (op === 'field_neq') return valuesOf().some(function(v) { return v !== clause.value; });
  if (op === 'field_gt') return valuesOf().some(function(v) { return Number(v) > Number(clause.value); });
  if (op === 'field_lt') return valuesOf().some(function(v) { return Number(v) < Number(clause.value); });
  if (op === 'field_gte') return valuesOf().some(function(v) { return Number(v) >= Number(clause.value); });
  if (op === 'field_lte') return valuesOf().some(function(v) { return Number(v) <= Number(clause.value); });
  if (op === 'array_length_gte') return valuesOf().some(function(v) { return Array.isArray(v) && v.length >= Number(clause.value); });
  if (op === 'entity_visible') return valuesOf().some(function(v) { return v != null && v !== false; });
  if (op === 'entity_absent') {
    var absentValues = valuesOf();
    if (absentValues.length === 0) return true;
    return absentValues.every(function(v) { return v == null || v === false; });
  }
  if (op === 'visual_hash_delta_gte') {
    var pair = getBeforeAfterPair(obs, pathStr, refs);
    return Math.abs((Number(pair[1]) || 0) - (Number(pair[0]) || 0)) >= Number(clause.value);
  }
  if (op === 'realtime_elapsed_gte') {
    var elapsed = Number(walkPath(obs, pathStr || 'phaseRealTimer', refs)[0] || 0);
    return elapsed >= Number(clause.value);
  }
  if (op === 'delta_gt' || op === 'delta_gte' || op === 'delta_lt' || op === 'delta_eq_zero') {
    var before;
    var after;
    if (pathStr.indexOf('<before-after>') >= 0) {
      var beforeAfter = getBeforeAfterPair(obs, pathStr, refs);
      before = beforeAfter[0];
      after = beforeAfter[1];
    } else {
      var hints = obs.phaseStartHints || {};
      var cur = walkPath(obs, pathStr, refs)[0];
      before = hints[pathStr] == null ? 0 : hints[pathStr];
      after = Array.isArray(cur) ? cur.length : Number(cur || 0);
    }
    var delta = vec3OrNumber(after) - vec3OrNumber(before);
    if (op === 'delta_gt') return delta > Number(clause.value);
    if (op === 'delta_gte') return delta >= Number(clause.value);
    if (op === 'delta_lt') return delta < Number(clause.value);
    return Math.abs(delta) < (clause.epsilon || 1e-6);
  }
  throw new Error('Unknown probe op: ' + op);
}

function evaluateRule(rule, ctx) {
  if (rule && rule.op) return evaluateClause(rule, ctx);
  if (!rule || !Array.isArray(rule.clauses)) throw new Error('Invalid probe rule node');
  if (rule.type === 'all-of') return rule.clauses.every(function(child) { return evaluateRule(child, ctx); });
  if (rule.type === 'any-of') return rule.clauses.some(function(child) { return evaluateRule(child, ctx); });
  if (rule.type === 'not') return !rule.clauses.some(function(child) { return evaluateRule(child, ctx); });
  if (rule.type === 'k-of-n') {
    var hits = rule.clauses.filter(function(child) { return evaluateRule(child, ctx); }).length;
    return hits >= Number(rule.k);
  }
  throw new Error('Unknown probe rule node type: ' + rule.type);
}

function attributeModuleFailure(moduleContract, ctx) {
  var sorted = orderedFailureAttribution(moduleContract);
  for (var i = 0; i < sorted.length; i++) {
    var entry = sorted[i];
    if (evaluateRule(entry.condition, ctx)) {
      return {
        ledgerSource: entry.ledgerSource,
        ledgerGapType: entry.ledgerGapType,
        ledgerSubtype: entry.ledgerSubtype == null ? null : entry.ledgerSubtype,
        attributionRuleId: entry.id || null,
        priority: entry.priority,
        note: entry.note || null,
      };
    }
  }
  return null;
}

function evaluateModuleProbe(moduleContract, observation, refs) {
  var ctx = buildEvaluationContext(observation, refs);
  var passRuleHeld = evaluateRule(moduleContract.passRule, ctx);
  var antiAutoplayHeld = evaluateRule(moduleContract.antiAutoplay, ctx);
  var passed = passRuleHeld && antiAutoplayHeld;
  return {
    moduleId: moduleContract.moduleId,
    passed: passed,
    passRuleHeld: passRuleHeld,
    antiAutoplayHeld: antiAutoplayHeld,
    attribution: passed ? null : attributeModuleFailure(moduleContract, ctx),
  };
}

function evaluateGapSubtype(subtypeContract, observation, refs) {
  var ctx = buildEvaluationContext(observation, refs);
  return {
    subtype: subtypeContract.subtype,
    parentGapType: subtypeContract.parentGapType,
    priority: subtypeContract.priority,
    ledgerSubtype: subtypeContract.ledgerSubtype,
    fires: evaluateRule(subtypeContract.requiredEvidence, ctx),
  };
}

function vec3OrNumber(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (Array.isArray(v) && v.length >= 1) return Number(v[0]) || 0;
  if (typeof v === 'object' && v) {
    if ('x' in v) return Math.max(Math.abs(v.x || 0), Math.abs(v.y || 0), Math.abs(v.z || 0));
  }
  return 0;
}

function requireArray(owner, value, field) {
  if (!Array.isArray(value)) throw new Error(owner + '.' + field + ' must be an array');
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

module.exports = {
  SUPPORTED_SCHEMA_VERSION: SUPPORTED_SCHEMA_VERSION,
  SNAPSHOT_SCHEMA_MIN: SNAPSHOT_SCHEMA_MIN,
  DEFAULT_CONTRACT_PATH: DEFAULT_CONTRACT_PATH,
  PILLARS: PILLARS,
  KNOWN_OPS: KNOWN_OPS,
  loadProbeContracts: loadProbeContracts,
  validateProbeContracts: validateProbeContracts,
  computeModuleCompleteness: computeModuleCompleteness,
  summarizeProbeContracts: summarizeProbeContracts,
  summarizeContractRegistryCoverage: summarizeContractRegistryCoverage,
  extractSnapshotFieldKey: extractSnapshotFieldKey,
  resolveSnapshotField: resolveSnapshotField,
  readSnapshotForModule: readSnapshotForModule,
  snapshotSchemaCompatible: snapshotSchemaCompatible,
  classifySnapshotCoverage: classifySnapshotCoverage,
  summarizePhaseEvidenceSnapshotCoverage: summarizePhaseEvidenceSnapshotCoverage,
  orderedFailureAttribution: orderedFailureAttribution,
  buildEvaluationContext: buildEvaluationContext,
  walkPath: walkPath,
  getBeforeAfterPair: getBeforeAfterPair,
  evaluateClause: evaluateClause,
  evaluateRule: evaluateRule,
  attributeModuleFailure: attributeModuleFailure,
  evaluateModuleProbe: evaluateModuleProbe,
  evaluateGapSubtype: evaluateGapSubtype,
};
