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

function readTextIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf8');
}

function countGmpAudioSceneSources(root) {
  var sceneFile = path.join(root, 'Assets', 'Scenes', 'Game.unity');
  if (!fs.existsSync(sceneFile)) return -1;
  var text = readTextIfExists(sceneFile);
  var blocks = text.split(/(?=^--- !u!)/m);
  var byId = {};
  var audioGameObject = null;

  for (var i = 0; i < blocks.length; i++) {
    var header = /^--- !u!(\d+) &(\d+)/m.exec(blocks[i]);
    if (!header) continue;
    var typeMatch = /^([A-Za-z0-9_]+):/m.exec(blocks[i]);
    var block = {
      id: header[2],
      type: typeMatch ? typeMatch[1] : header[1],
      text: blocks[i]
    };
    byId[block.id] = block;

    if (block.type === 'GameObject' && /\bm_Name:\s*"?GMP_Audio"?\s*(?:\n|$)/.test(block.text)) {
      audioGameObject = block;
    }
  }

  if (!audioGameObject) return -1;

  var componentIds = [];
  var componentPattern = /component:\s*\{fileID:\s*(\d+)\}/g;
  var componentMatch;
  while ((componentMatch = componentPattern.exec(audioGameObject.text))) {
    componentIds.push(componentMatch[1]);
  }

  var count = 0;
  componentIds.forEach(function(componentId) {
    if (byId[componentId] && byId[componentId].type === 'AudioSource') count++;
  });
  return count;
}

function validateV14AudioModule(root, scriptsRoot, errors) {
  var audioFile = path.join(scriptsRoot, 'Core', 'Modules', 'GMP_Audio.cs');
  if (!fs.existsSync(audioFile)) {
    errors.push('Assets/Scripts/Core/Modules/GMP_Audio.cs missing');
    return;
  }

  var audio = readTextIfExists(audioFile);
  if (!/\bpublic\s+AudioSource\[\]\s+mLoopSources\b/.test(audio)) {
    errors.push('GMP_Audio must expose multiple loop AudioSource slots via mLoopSources');
  }
  if (!/\bpublic\s+AudioSource\[\]\s+mOneShotSources\b/.test(audio)) {
    errors.push('GMP_Audio must expose multiple one-shot AudioSource slots via mOneShotSources');
  }
  if (!/\bpublic\s+void\s+PlayLoop\s*\(/.test(audio)) {
    errors.push('GMP_Audio must support loop playback with PlayLoop');
  }
  if (!/\bpublic\s+void\s+PlayOneShot\s*\(/.test(audio)) {
    errors.push('GMP_Audio must support one-shot playback with PlayOneShot');
  }
  if (/\bprivate\s+AudioSource\s+mSfxSource\b/.test(audio) || /\bprivate\s+AudioSource\s+mBgmSource\b/.test(audio)) {
    errors.push('GMP_Audio must not regress to one fixed BGM/SFX AudioSource field');
  }

  var sceneSourceCount = countGmpAudioSceneSources(root);
  if (sceneSourceCount < 0) {
    errors.push('GMP_Audio scene object missing from Assets/Scenes/Game.unity');
  } else if (sceneSourceCount < 4) {
    errors.push('GMP_Audio scene object must mount multiple AudioSource components, found ' + sceneSourceCount);
  }
}

function validateV14ScriptLayout(root, errors) {
  var scriptsRoot = path.join(root, 'Assets', 'Scripts');
  if (!fs.existsSync(scriptsRoot)) return;

  var allowed = { Core: true, Tool: true, Game: true };
  fs.readdirSync(scriptsRoot, { withFileTypes: true }).forEach(function(entry) {
    if (/\.meta$/i.test(entry.name)) return;
    if (entry.isDirectory()) {
      if (!allowed[entry.name]) errors.push('Assets/Scripts top-level directory must be Core/Tool/Game only, found ' + entry.name);
      return;
    }
    if (entry.isFile() && /\.cs$/i.test(entry.name)) {
      errors.push('C# scripts must live under Assets/Scripts/Core, Tool, or Game, found Assets/Scripts/' + entry.name);
    }
  });

  ['Core', 'Tool', 'Game'].forEach(function(dir) {
    if (!fs.existsSync(path.join(scriptsRoot, dir))) errors.push('Assets/Scripts/' + dir + ' missing');
  });

  validateV14AudioModule(root, scriptsRoot, errors);

  var playerFile = path.join(scriptsRoot, 'Game', 'Player', 'GMP_Player.cs');
  if (fs.existsSync(playerFile)) {
    var player = readTextIfExists(playerFile);
    if (!/\bpublic\s+class\s+GMP_Player\s*:\s*GMP_PlayerBase\b/.test(player)) {
      errors.push('GMP_Player must inherit GMP_PlayerBase in Assets/Scripts/Game/Player');
    }
  }

  var phasePresetFile = path.join(scriptsRoot, 'Core', 'Modules', 'GMP_PhasePreset.cs');
  if (fs.existsSync(phasePresetFile)) {
    var phasePreset = readTextIfExists(phasePresetFile);
    if (!/\bpublic\s+GMP_EntityState\s+mSetState\b/.test(phasePreset)) {
      errors.push('GMP_PhaseStep.mSetState must use GMP_EntityState enum');
    }
  }

  var coreRoot = path.join(scriptsRoot, 'Core');
  listFiles(coreRoot).forEach(function(file) {
    if (!/\.cs$/i.test(file)) return;
    var rel = path.relative(root, file).split(path.sep).join('/');
    var text = readTextIfExists(file);
    if (/\bDisplayNameForEntity\b/.test(text)) {
      errors.push(rel + ' contains DisplayNameForEntity; entity display names belong in Assets/Scripts/Game');
    }
    if (/\b(?:if|case)\s*\(?\s*entityName\s*(?:==|:)\s*"_/.test(text)) {
      errors.push(rel + ' contains project-specific entity label mapping; move it to Assets/Scripts/Game');
    }
  });
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
  validateV14ScriptLayout(root, errors);

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
