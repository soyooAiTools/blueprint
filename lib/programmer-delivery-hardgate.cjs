'use strict';

var fs = require('fs');
var path = require('path');

var KIND = 'blueprint.programmerDeliveryValidation';
var SCHEMA_VERSION = 1;

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function exists(root, rel) {
  return fs.existsSync(path.join(root, rel));
}

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return readJson(filePath);
}

function listFiles(root) {
  var out = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    var entries = fs.readdirSync(dir);
    for (var i = 0; i < entries.length; i++) {
      var file = path.join(dir, entries[i]);
      var stat = fs.statSync(file);
      if (stat.isDirectory()) walk(file);
      else out.push(file);
    }
  }
  walk(root);
  return out;
}

function validateManifest(root, errors) {
  var manifestPath = path.join(root, 'Packages', 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    errors.push('Packages/manifest.json missing');
    return;
  }
  var manifest = readJson(manifestPath);
  var deps = manifest && manifest.dependencies || {};
  if (deps['com.unity.playworks.upp']) {
    errors.push('Luna Playworks package dependency must be stripped from Packages/manifest.json');
  }
  var text = fs.readFileSync(manifestPath, 'utf8');
  if (/file:C:\/|file:\/opt\/blueprint-editor|file:\/root\//.test(text)) {
    errors.push('Packages/manifest.json must not contain local absolute package paths');
  }
}

function validateProgrammerDelivery(root, summary) {
  root = path.resolve(root);
  summary = summary || {};
  var errors = [];
  var warnings = [];

  if (!isObject(summary)) {
    errors.push('programmer delivery summary must be an object');
    summary = {};
  }

  if (Array.isArray(summary.errors) && summary.errors.length > 0) {
    errors.push('delivery-class-validator blocking errors: ' + summary.errors.length);
  }
  if (Number(summary.initialPhaseEntitiesMissing || 0) !== 0) {
    errors.push('initialPhaseEntitiesMissing must be 0, got ' + summary.initialPhaseEntitiesMissing);
  }
  if (summary.joystickObjectsPresent !== true) {
    errors.push('joystickObjectsPresent must be true');
  }
  if (summary.hudTextObjectsPresent !== true) {
    errors.push('hudTextObjectsPresent must be true');
  }
  if (Number(summary.fallbackMaterialMissingGuidCount || 0) !== 0) {
    errors.push('fallbackMaterialMissingGuidCount must be 0, got ' + summary.fallbackMaterialMissingGuidCount);
  }
  if (summary.fallbackMaterialShaderMissing === true) {
    errors.push('fallbackMaterialShaderMissing must be false');
  }

  if (!exists(root, 'Assets/Scripts')) errors.push('Assets/Scripts missing');
  if (!exists(root, 'Assets/Scenes/Game.unity')) errors.push('Assets/Scenes/Game.unity missing');
  if (exists(root, 'Assets/Program')) errors.push('Assets/Program must be removed from programmer delivery');
  if (exists(root, 'BlueprintArtifacts')) errors.push('BlueprintArtifacts must be removed from programmer delivery');
  if (exists(root, 'tools')) errors.push('tools must be removed from programmer delivery');
  if (exists(root, 'luna.json')) errors.push('luna.json must be removed from programmer delivery');
  if (exists(root, 'Assets/Scenes/templeteScene.unity')) {
    errors.push('template scene must be removed from programmer delivery');
  }

  validateManifest(root, errors);

  var files = listFiles(root);
  for (var i = 0; i < files.length; i++) {
    var rel = path.relative(root, files[i]).split(path.sep).join('/');
    if (/\/?GFM_Event\.cs$/.test(rel)) errors.push('GFM_Event.cs must be removed from programmer delivery');
    if (/\/?BlueprintArtifacts\//.test(rel)) errors.push('BlueprintArtifacts file leaked: ' + rel);
    if (/\/?tools\//.test(rel)) errors.push('tools file leaked: ' + rel);
  }

  if (Number(summary.sourcePrimitiveEntityCount || 0) === 0 &&
      Number(summary.fallbackSourcePrimitiveEntityCount || 0) === 0) {
    warnings.push('no source or fallback primitive entities were materialized');
  }

  return {
    kind: KIND,
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    root: root,
    passed: errors.length === 0,
    errors: errors,
    warnings: warnings,
    summary: {
      initialPhaseEntities: summary.initialPhaseEntities || 0,
      initialPhaseEntitiesPositioned: summary.initialPhaseEntitiesPositioned || 0,
      initialPhaseEntitiesMissing: summary.initialPhaseEntitiesMissing || 0,
      joystickObjectsPresent: summary.joystickObjectsPresent === true,
      hudTextObjectsPresent: summary.hudTextObjectsPresent === true,
      fallbackMaterialMissingGuidCount: summary.fallbackMaterialMissingGuidCount || 0,
      fallbackMaterialShaderMissing: summary.fallbackMaterialShaderMissing === true,
      sourcePrimitiveEntityCount: summary.sourcePrimitiveEntityCount || 0,
      fallbackSourcePrimitiveEntityCount: summary.fallbackSourcePrimitiveEntityCount || 0,
      deliveryClassValidatorErrorCount: Array.isArray(summary.errors) ? summary.errors.length : 0,
    },
  };
}

function writeDeliveryValidation(root, summaryPath, outPath) {
  var summary = readJsonIfExists(summaryPath);
  var validation = validateProgrammerDelivery(root, summary || {});
  var target = outPath || path.join(path.resolve(root), 'DELIVERY_VALIDATION.json');
  fs.writeFileSync(target, JSON.stringify(validation, null, 2) + '\n');
  return validation;
}

function usage() {
  console.error('Usage: node lib/programmer-delivery-hardgate.cjs <delivery-root> <summary-json> [--out DELIVERY_VALIDATION.json]');
  process.exit(2);
}

if (require.main === module) {
  var root = process.argv[2];
  var summaryPath = process.argv[3];
  var outPath = null;
  for (var i = 4; i < process.argv.length; i++) {
    if (process.argv[i] === '--out') outPath = process.argv[++i] || null;
    else usage();
  }
  if (!root || !summaryPath) usage();
  try {
    var result = writeDeliveryValidation(root, summaryPath, outPath);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.passed ? 0 : 1);
  } catch (error) {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
  }
}

module.exports = {
  KIND: KIND,
  SCHEMA_VERSION: SCHEMA_VERSION,
  validateProgrammerDelivery: validateProgrammerDelivery,
  writeDeliveryValidation: writeDeliveryValidation,
};
