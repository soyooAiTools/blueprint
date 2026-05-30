#!/usr/bin/env node
'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var fieldDiff = require('../engine/stages/lib/field-diff.cjs');

function writeContract(doc) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'field-diff-ui-overlay-'));
  var filePath = path.join(dir, 'contract.json');
  fs.writeFileSync(filePath, JSON.stringify(doc, null, 2), 'utf8');
  return filePath;
}

function contract(withOverlay) {
  var doc = {
    schemaVersion: '1.1.0',
    kind: 'blueprint.fidelityContract',
    producerVersion: 'test',
    requiredCapabilities: [],
    coordinateSystem: {},
    rendererAdapter: {},
    entities: [{ id: 'Player', name: 'Player', primitives: [] }],
    phases: [{ id: 'phase1', showEntities: ['Player'], trigger: {}, interactionGate: {}, autoPlayGate: {}, manualGate: {} }],
    hud: [],
    unityCoverage: { status: 'missing' },
    unresolvedFidelityGaps: [],
    contractConflicts: [],
  };
  if (withOverlay) {
    doc.sourceEntityContract = {
      uiOverlayContract: {
        present: true,
        entities: [
          { id: 'CtaButton', role: 'cta' },
          { id: 'Canvas', role: 'ui-canvas' },
          { id: 'JoystickBG', role: 'joystick-background' },
          { id: 'JoystickHandle', role: 'joystick-handle' },
        ],
      },
    };
  }
  return doc;
}

var observed = {
  visibleEntities: ['Player', 'CtaButton', 'Canvas', 'JoystickBG', 'JoystickHandle'],
  hud: [],
  entityDetails: {},
};

var withoutOverlay = fieldDiff.makeTemplate(writeContract(contract(false))).diffPhase('phase1', observed);
assert.deepStrictEqual(withoutOverlay.entities.map(function (entry) { return entry.entityFamily; }).sort(), [
  'Canvas',
  'CtaButton',
  'JoystickBG',
  'JoystickHandle',
]);

var withOverlay = fieldDiff.makeTemplate(writeContract(contract(true))).diffPhase('phase1', observed);
assert.deepStrictEqual(withOverlay.entities, []);

var missingExpected = fieldDiff.makeTemplate(writeContract({
  schemaVersion: '1.1.0',
  kind: 'blueprint.fidelityContract',
  producerVersion: 'test',
  requiredCapabilities: [],
  coordinateSystem: {},
  rendererAdapter: {},
  entities: [{ id: 'Player', name: 'Player', primitives: [] }, { id: 'CtaButton', name: 'CtaButton', primitives: [] }],
  phases: [{ id: 'phase8', showEntities: ['Player', 'CtaButton'], trigger: {}, interactionGate: {}, autoPlayGate: {}, manualGate: {} }],
  hud: [],
  unityCoverage: { status: 'missing' },
  unresolvedFidelityGaps: [],
  contractConflicts: [],
  sourceEntityContract: { uiOverlayContract: { present: true, entities: [{ id: 'CtaButton', role: 'cta' }] } },
})).diffPhase('phase8', { visibleEntities: ['Player'], hud: [], entityDetails: {} });
assert.strictEqual(missingExpected.entities.length, 1);
assert.strictEqual(missingExpected.entities[0].entityFamily, 'CtaButton');
assert.strictEqual(missingExpected.entities[0].status, 'missing');

console.log('field-diff UI overlay tests passed');
