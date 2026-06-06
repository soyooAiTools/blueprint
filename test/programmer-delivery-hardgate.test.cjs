'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var hardgate = require('../lib/programmer-delivery-hardgate.cjs');

function makeRoot() {
  var root = fs.mkdtempSync(path.join(os.tmpdir(), 'programmer-delivery-hardgate-'));
  fs.mkdirSync(path.join(root, 'Assets', 'Scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Assets', 'Scenes'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Packages'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Assets', 'Scenes', 'Game.unity'), '%YAML 1.1\n');
  fs.writeFileSync(path.join(root, 'Packages', 'manifest.json'), JSON.stringify({ dependencies: {} }, null, 2));
  return root;
}

var summary = {
  errors: [],
  initialPhaseEntitiesMissing: 0,
  joystickObjectsPresent: true,
  hudTextObjectsPresent: true,
  fallbackMaterialMissingGuidCount: 0,
  fallbackMaterialShaderMissing: false,
  sourcePrimitiveEntityCount: 1,
};

var passingRoot = makeRoot();
var passing = hardgate.validateProgrammerDelivery(passingRoot, summary);
assert.strictEqual(passing.passed, true);

var failingRoot = makeRoot();
fs.mkdirSync(path.join(failingRoot, 'Assets', 'Program'), { recursive: true });
fs.writeFileSync(path.join(failingRoot, 'Packages', 'manifest.json'), JSON.stringify({
  dependencies: { 'com.unity.playworks.upp': 'file:/opt/blueprint-editor/7.1.0/scripts' },
}, null, 2));
var failing = hardgate.validateProgrammerDelivery(failingRoot, Object.assign({}, summary, {
  joystickObjectsPresent: false,
  initialPhaseEntitiesMissing: 2,
}));
assert.strictEqual(failing.passed, false);
assert.ok(failing.errors.some(function(error) { return error.indexOf('joystickObjectsPresent') >= 0; }));
assert.ok(failing.errors.some(function(error) { return error.indexOf('Assets/Program') >= 0; }));
assert.ok(failing.errors.some(function(error) { return error.indexOf('Playworks') >= 0; }));

var summaryPath = path.join(passingRoot, 'PROGRAMMER_DELIVERY_SUMMARY.json');
var validationPath = path.join(passingRoot, 'DELIVERY_VALIDATION.json');
fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
var written = hardgate.writeDeliveryValidation(passingRoot, summaryPath, validationPath);
assert.strictEqual(written.passed, true);
assert.ok(fs.existsSync(validationPath));

console.log('programmer delivery hardgate tests passed');
