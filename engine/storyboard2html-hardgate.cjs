'use strict';

var fs = require('fs');
var path = require('path');

var DEFAULT_SNAPSHOT_SCHEMA_CONTRACT_PATH = path.join(__dirname, '..', 'contracts', 'snapshot-schema.v1.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function numberCloseToOne(value) {
  return typeof value === 'number' && Math.abs(value - 1) < 1e-9;
}

function parseCoveragePair(value) {
  if (typeof value === 'string') {
    var match = value.match(/(\d+)\s*\/\s*(\d+)/);
    if (match) return { covered: Number(match[1]), total: Number(match[2]) };
  }
  if (isObject(value)) {
    var covered = value.covered != null ? value.covered
      : value.completed != null ? value.completed
      : value.completedCount != null ? value.completedCount
      : value.coveredCount;
    var total = value.total != null ? value.total
      : value.expected != null ? value.expected
      : value.expectedCount;
    if (Number.isFinite(Number(covered)) && Number.isFinite(Number(total))) {
      return { covered: Number(covered), total: Number(total) };
    }
  }
  return null;
}

function expectedPhaseCount(snapshotDoc, opts) {
  if (opts && Number.isFinite(Number(opts.expectedPhaseCount))) {
    return Number(opts.expectedPhaseCount);
  }
  var phases = snapshotDoc && snapshotDoc.project && snapshotDoc.project.phases;
  if (Array.isArray(phases)) return phases.length;
  return null;
}

function validateSnapshotSchemaDoc(doc, contractDoc) {
  var errors = [];
  if (!isObject(doc)) {
    return { passed: false, errors: ['snapshot schema must be an object'] };
  }
  if (doc.schemaVersion !== '1.0.0') errors.push('schemaVersion must be 1.0.0');
  if (doc.kind !== 'blueprint.phaseEvidence.snapshotSchema') errors.push('kind must be blueprint.phaseEvidence.snapshotSchema');
  if (!doc.browserStateContract || doc.browserStateContract.globalName !== 'window.__gameState') {
    errors.push('browserStateContract.globalName must be window.__gameState');
  }
  var requiredTopLevel = (doc.browserStateContract && doc.browserStateContract.requiredTopLevelKeys) || [];
  ['phase', 'phaseRealTimer', 'entity_states', 'phaseEvidence'].forEach(function(key) {
    if (requiredTopLevel.indexOf(key) < 0) errors.push('browserStateContract.requiredTopLevelKeys missing ' + key);
  });
  if (!doc.runtimeSnapshotEnvelope || !doc.runtimeSnapshotEnvelope.requiredMeta) {
    errors.push('runtimeSnapshotEnvelope.requiredMeta missing');
  } else {
    if (doc.runtimeSnapshotEnvelope.requiredMeta['_meta.schemaVersion'] !== '1.0.0') {
      errors.push('runtimeSnapshotEnvelope must require _meta.schemaVersion=1.0.0');
    }
    var platforms = doc.runtimeSnapshotEnvelope.requiredMeta['_meta.sourcePlatform'];
    if (!Array.isArray(platforms) || platforms.indexOf('html') < 0 || platforms.indexOf('unity') < 0) {
      errors.push('runtimeSnapshotEnvelope must allow html and unity sourcePlatform');
    }
  }
  if (!isObject(doc.moduleVocabulary) || Object.keys(doc.moduleVocabulary).length === 0) {
    errors.push('moduleVocabulary missing/empty');
  }
  if (contractDoc && isObject(contractDoc.moduleVocabulary)) {
    var expectedKeys = Object.keys(contractDoc.moduleVocabulary).sort();
    var actualKeys = Object.keys(doc.moduleVocabulary || {}).sort();
    if (expectedKeys.join('|') !== actualKeys.join('|')) {
      errors.push('moduleVocabulary keys differ from canonical snapshot contract');
    }
  }
  return { passed: errors.length === 0, errors: errors };
}

function evaluateVerifyReport(report, snapshotDoc, opts) {
  opts = opts || {};
  var errors = [];
  if (!isObject(report)) {
    return { passed: false, errors: ['verify report must be an object'] };
  }
  var summary = report.phaseEvidenceSummary || {};
  var aggregate = summary.aggregate || {};
  var validation = summary.validation || {};
  if (summary.enabled !== true) errors.push('phaseEvidenceSummary.enabled must be true');
  if (validation.passed !== true) errors.push('phaseEvidenceSummary.validation.passed must be true');
  if (!numberCloseToOne(aggregate.triggeredPresentFullRate)) {
    errors.push('triggeredPresentFullRate must be 1');
  }
  if (!numberCloseToOne(aggregate.triggeredAntiAutoplayHeldRate)) {
    errors.push('triggeredAntiAutoplayHeldRate must be 1');
  }
  var expected = expectedPhaseCount(snapshotDoc, opts);
  var coverage = parseCoveragePair(report.phaseCoverage);
  if (expected != null) {
    if (!coverage) {
      var completed = safeArray(report.completedPhases || report.coveredPlanSteps);
      if (completed.length !== expected) {
        errors.push('phaseCoverage missing/unparseable and completed phase count ' + completed.length + ' != expected ' + expected);
      }
    } else {
      if (coverage.covered !== expected || coverage.total !== expected) {
        errors.push('phaseCoverage must be ' + expected + '/' + expected + ', got ' + coverage.covered + '/' + coverage.total);
      }
    }
  }
  return { passed: errors.length === 0, errors: errors };
}

function evaluateHardGates(options) {
  options = options || {};
  var snapshotPath = options.snapshotSchemaPath;
  var verifyPath = options.verifyReportPath;
  if (!snapshotPath) throw new Error('snapshotSchemaPath is required');
  if (!verifyPath) throw new Error('verifyReportPath is required');
  var snapshotDoc = readJson(snapshotPath);
  var verifyReport = readJson(verifyPath);
  var contractPath = options.snapshotSchemaContractPath || DEFAULT_SNAPSHOT_SCHEMA_CONTRACT_PATH;
  var contractDoc = fs.existsSync(contractPath) ? readJson(contractPath) : null;
  var gates = [];

  var snapshotGate = validateSnapshotSchemaDoc(snapshotDoc, contractDoc);
  gates.push({
    id: 'snapshot-schema-validates',
    passed: snapshotGate.passed,
    errors: snapshotGate.errors,
  });

  var verifyGate = evaluateVerifyReport(verifyReport, snapshotDoc, options);
  gates.push({
    id: 'phase-evidence-hard-gates',
    passed: verifyGate.passed,
    errors: verifyGate.errors,
  });

  return {
    passed: gates.every(function(gate) { return gate.passed; }),
    gates: gates,
    snapshotSchemaPath: snapshotPath,
    verifyReportPath: verifyPath,
  };
}

module.exports = {
  DEFAULT_SNAPSHOT_SCHEMA_CONTRACT_PATH: DEFAULT_SNAPSHOT_SCHEMA_CONTRACT_PATH,
  parseCoveragePair: parseCoveragePair,
  validateSnapshotSchemaDoc: validateSnapshotSchemaDoc,
  evaluateVerifyReport: evaluateVerifyReport,
  evaluateHardGates: evaluateHardGates,
};
