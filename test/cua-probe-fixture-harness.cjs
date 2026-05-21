'use strict';

var assert = require('assert');

function evaluateProbeFixtureBatch(probeContracts, contractDoc, batch) {
  var moduleFixtures = batch && Array.isArray(batch.moduleFixtures) ? batch.moduleFixtures : [];
  var subtypeFixtures = batch && Array.isArray(batch.subtypeFixtures) ? batch.subtypeFixtures : [];
  var results = {
    moduleFixtures: [],
    subtypeFixtures: [],
    allPass: true,
  };

  moduleFixtures.forEach(function(fx) {
    var contract = contractDoc.moduleProbeContracts[fx.module];
    if (!contract) {
      results.allPass = false;
      results.moduleFixtures.push({ name: fx.name, module: fx.module, matchedExpected: false, error: 'module not in contract: ' + fx.module });
      return;
    }
    var result = probeContracts.evaluateModuleProbe(contract, fx.observation, fx.refs || {});
    var matchedExpected = result.passed === fx.expectedPass && attributionMatches(result.attribution, fx.expectedAttribution);
    if (!matchedExpected) results.allPass = false;
    results.moduleFixtures.push({
      name: fx.name,
      module: fx.module,
      passed: result.passed,
      passRuleHeld: result.passRuleHeld,
      antiAutoplayHeld: result.antiAutoplayHeld,
      attribution: result.attribution,
      expectedPass: fx.expectedPass,
      expectedAttribution: fx.expectedAttribution,
      matchedExpected: matchedExpected,
    });
  });

  subtypeFixtures.forEach(function(fx) {
    var subtype = contractDoc.gapAttributionSubtypes[fx.subtype];
    if (!subtype) {
      results.allPass = false;
      results.subtypeFixtures.push({ name: fx.name, subtype: fx.subtype, matchedExpected: false, error: 'subtype not in contract: ' + fx.subtype });
      return;
    }
    var result = probeContracts.evaluateGapSubtype(subtype, fx.observation, fx.refs || {});
    var matchedExpected = result.fires === fx.expectedFires;
    if (!matchedExpected) results.allPass = false;
    results.subtypeFixtures.push({
      name: fx.name,
      subtype: fx.subtype,
      parentGapType: result.parentGapType,
      priority: result.priority,
      ledgerSubtype: result.ledgerSubtype,
      fires: result.fires,
      expectedFires: fx.expectedFires,
      matchedExpected: matchedExpected,
    });
  });

  return results;
}

function assertProbeFixtureBatch(probeContracts, contractDoc, batch) {
  var results = evaluateProbeFixtureBatch(probeContracts, contractDoc, batch);
  var failures = []
    .concat(results.moduleFixtures)
    .concat(results.subtypeFixtures)
    .filter(function(item) { return !item.matchedExpected; });
  assert.strictEqual(failures.length, 0, failures.map(describeFailure).join('\n'));
  return results;
}

function attributionMatches(actual, expected) {
  if (expected == null) return actual == null;
  if (actual == null) return false;
  return Object.keys(expected).every(function(key) {
    return actual[key] === expected[key];
  });
}

function describeFailure(item) {
  if (item.error) return item.name + ': ' + item.error;
  return item.name + ': expected ' + JSON.stringify({
    expectedPass: item.expectedPass,
    expectedFires: item.expectedFires,
    expectedAttribution: item.expectedAttribution,
  }) + ' got ' + JSON.stringify({
    passed: item.passed,
    fires: item.fires,
    attribution: item.attribution,
  });
}

module.exports = {
  evaluateProbeFixtureBatch: evaluateProbeFixtureBatch,
  assertProbeFixtureBatch: assertProbeFixtureBatch,
};
