#!/usr/bin/env node
'use strict';

// Locks the engine validator (`engine/fidelity-contract.cjs`) and the
// authoritative descriptor (`contracts/fidelity-contract.v1.json`) to the
// same schemaVersion + accepted-versions universe.
//
// Drift was the PR #32 second blocker (Jonny msg=d4945c58): the engine
// SCHEMA_VERSION stayed '1.2.0' while migration produced '1.3.0' instances,
// and the descriptor still claimed acceptedInstanceSchemaVersions = ["1.0.0",
// "1.1.0", "1.2.0"] — so writers/auditors/doc consumers and the engine
// validator saw contradictory surfaces. Sam self-bind #12 promoted this
// check to a PR-checklist permanent lock.
//
// Asserts:
//   1. engine SCHEMA_VERSION === descriptor.schemaVersion
//      (the engine's idea of "what version we ship" matches the descriptor)
//   2. engine SCHEMA_VERSION === descriptor.contractVersion
//      (instance contract surface tracks schema doc — Sam preference)
//   3. engine.ACCEPTED_INSTANCE_SCHEMA_VERSIONS ⊇ descriptor.acceptedInstanceSchemaVersions
//      (engine never refuses a version the descriptor advertises as accepted)
//   4. descriptor.schemaVersion appears in engine.ACCEPTED_INSTANCE_SCHEMA_VERSIONS
//      (a contract instance with the current schema version is always loadable)
//   5. descriptor.acceptedInstanceSchemaVersions contains the current
//      schemaVersion (the descriptor admits its own active version)

var assert = require('assert');
var fs = require('fs');
var path = require('path');

var engine = require('../engine/fidelity-contract.cjs');
var descriptorPath = path.join(__dirname, '..', 'contracts', 'fidelity-contract.v1.json');
var descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));

// ── case 1: engine SCHEMA_VERSION === descriptor.schemaVersion ──
assert.strictEqual(engine.SCHEMA_VERSION, descriptor.schemaVersion,
  'engine SCHEMA_VERSION (' + engine.SCHEMA_VERSION + ') must equal ' +
  'contracts/fidelity-contract.v1.json schemaVersion (' + descriptor.schemaVersion + ')');

// ── case 2: engine SCHEMA_VERSION === descriptor.contractVersion ──
assert.strictEqual(engine.SCHEMA_VERSION, descriptor.contractVersion,
  'engine SCHEMA_VERSION (' + engine.SCHEMA_VERSION + ') must equal ' +
  'contracts/fidelity-contract.v1.json contractVersion (' + descriptor.contractVersion + ')');

// ── case 3: engine accepted ⊇ descriptor accepted ──
var engineAccepted = engine.ACCEPTED_INSTANCE_SCHEMA_VERSIONS;
var descriptorAccepted = descriptor.acceptedInstanceSchemaVersions;
assert.ok(Array.isArray(descriptorAccepted) && descriptorAccepted.length > 0,
  'descriptor.acceptedInstanceSchemaVersions must be a non-empty array');
descriptorAccepted.forEach(function(v) {
  assert.ok(engineAccepted[v] === true,
    'engine must accept descriptor-advertised version ' + v + ' — currently engine.ACCEPTED_INSTANCE_SCHEMA_VERSIONS = ' + JSON.stringify(Object.keys(engineAccepted)));
});

// ── case 4: descriptor schemaVersion is in engine accepted set ──
assert.ok(engineAccepted[descriptor.schemaVersion] === true,
  'engine must accept its own current schemaVersion ' + descriptor.schemaVersion);

// ── case 5: descriptor accepts its own schemaVersion ──
assert.ok(descriptorAccepted.indexOf(descriptor.schemaVersion) >= 0,
  'descriptor.acceptedInstanceSchemaVersions must include the current schemaVersion ' + descriptor.schemaVersion + ' (got ' + JSON.stringify(descriptorAccepted) + ')');

console.log('fidelity-contract-descriptor-consistency.test.cjs PASS');
console.log('  engine SCHEMA_VERSION = ' + engine.SCHEMA_VERSION);
console.log('  descriptor schemaVersion = ' + descriptor.schemaVersion);
console.log('  descriptor contractVersion = ' + descriptor.contractVersion);
console.log('  engine accepted = ' + JSON.stringify(Object.keys(engineAccepted)));
console.log('  descriptor accepted = ' + JSON.stringify(descriptorAccepted));
