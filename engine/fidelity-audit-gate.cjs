'use strict';

var fidelity = require('./fidelity-contract.cjs');

var GATE_KIND = 'blueprint.fidelityContract.auditGate';
var GATE_VERSION = '1.0.0';

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function gapLabel(gap) {
  return (gap && (gap.id || gap.path)) || '<unknown>';
}

function conflictLabel(conflict) {
  return (conflict && (conflict.id || conflict.path)) || '<unknown>';
}

function unityCoverageBlocked(doc, options) {
  if (options.target !== 'unity') return false;
  if (options.allowMissingUnityCoverage) return false;
  return !!(doc && doc.unityCoverage && doc.unityCoverage.status === 'missing');
}

function runAuditGate(contract, options) {
  options = options || {};
  var target = options.target || 'unity';
  var supportedCapabilities = options.supportedCapabilities || [];
  var validation = fidelity.validateFidelityContract(contract);
  var schemaErrors = validation.valid ? [] : validation.errors.slice();
  var gaps = fidelity._internals.blockingGaps(contract);
  var conflicts = fidelity._internals.unresolvedConflicts(contract);
  var missingCaps = fidelity._internals.missingCapabilities(contract, supportedCapabilities);
  var unityCoverageFailure = unityCoverageBlocked(contract, { target: target, allowMissingUnityCoverage: options.allowMissingUnityCoverage });
  var errors = schemaErrors.slice();
  if (gaps.length) errors.push('unresolved fidelity gaps block writer: ' + gaps.map(gapLabel).join(', '));
  if (conflicts.length) errors.push('unresolved contract conflicts block writer: ' + conflicts.map(conflictLabel).join(', '));
  if (missingCaps.length) errors.push('writer missing required capabilities: ' + missingCaps.join(', '));
  if (unityCoverageFailure) errors.push('unity writer requires unityCoverage.status !== missing');
  return {
    schemaVersion: GATE_VERSION,
    kind: GATE_KIND,
    target: target,
    passed: errors.length === 0,
    errors: errors,
    schemaErrors: schemaErrors,
    blockingGaps: gaps,
    unresolvedConflicts: conflicts,
    missingCapabilities: missingCaps,
    unityCoverageFailure: !!unityCoverageFailure,
    supportedCapabilities: supportedCapabilities.slice(),
    unityCoverageStatus: contract && contract.unityCoverage && contract.unityCoverage.status || null
  };
}

function assertAuditGate(contract, options) {
  var result = runAuditGate(contract, options);
  if (!result.passed) {
    var err = new Error('fidelity audit gate failed: ' + result.errors.join('; '));
    err.auditResult = result;
    throw err;
  }
  return result;
}

module.exports = {
  GATE_KIND: GATE_KIND,
  GATE_VERSION: GATE_VERSION,
  runAuditGate: runAuditGate,
  assertAuditGate: assertAuditGate
};
