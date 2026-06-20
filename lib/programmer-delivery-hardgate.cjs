'use strict';

var fs = require('fs');
var path = require('path');
var hydrationReport = require('./programmer-delivery-hydration-report.cjs');
var maintainabilityGate = require('./programmer-delivery-maintainability-gate.cjs');
var sceneBakePlan = require('./programmer-delivery-scene-bake-plan.cjs');
var tempCodeAudit = require('./programmer-delivery-temp-code-audit.cjs');

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

function relative(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

function readUnityMetaGuid(csFile) {
  var meta = csFile + '.meta';
  if (!fs.existsSync(meta)) return '';
  var match = /^guid:\s*([0-9a-fA-F]+)/m.exec(readTextIfExists(meta));
  return match ? match[1].toLowerCase() : '';
}

function collectCsMetaGuids(root) {
  var scriptsRoot = path.join(root, 'Assets', 'Scripts');
  var out = Object.create(null);
  if (!fs.existsSync(scriptsRoot)) return out;
  listFiles(scriptsRoot).forEach(function(file) {
    if (!/\.cs\.meta$/i.test(file)) return;
    var match = /^guid:\s*([0-9a-fA-F]+)/m.exec(readTextIfExists(file));
    if (match) out[match[1].toLowerCase()] = relative(root, file);
  });
  return out;
}

function parseUnitySceneBlocks(text) {
  var blocks = [];
  var re = /--- !u!(\d+) &(-?\d+)\n[\s\S]*?(?=\n--- !u!\d+ &-?\d+|$)/g;
  var match;
  while ((match = re.exec(String(text || '')))) {
    blocks.push({ type: match[1], id: match[2], text: match[0] });
  }
  return blocks;
}

function collectSceneScriptRefs(root) {
  var sceneFile = path.join(root, 'Assets', 'Scenes', 'Game.unity');
  var result = { byObject: Object.create(null), missing: true };
  if (!fs.existsSync(sceneFile)) return result;
  result.missing = false;
  var blocks = parseUnitySceneBlocks(readTextIfExists(sceneFile));
  var byId = Object.create(null);
  var goByName = Object.create(null);
  var goComponents = Object.create(null);
  blocks.forEach(function(block) {
    byId[block.id] = block;
    if (block.type !== '1') return;
    var nameMatch = /\n  m_Name:\s*([^\n\r]*)/.exec(block.text);
    var name = nameMatch ? nameMatch[1].trim() : '';
    if (name) goByName[name] = block.id;
    var ids = [];
    block.text.replace(/component:\s*\{fileID:\s*(-?\d+)\}/g, function(_, id) {
      ids.push(id);
      return _;
    });
    goComponents[block.id] = ids;
  });
  Object.keys(goByName).forEach(function(name) {
    var goId = goByName[name];
    var guids = [];
    (goComponents[goId] || []).forEach(function(componentId) {
      var block = byId[componentId];
      if (!block || block.type !== '114') return;
      var match = /m_Script:\s*\{fileID:\s*11500000,\s*guid:\s*([0-9a-fA-F]+),\s*type:\s*3\}/.exec(block.text);
      if (match) guids.push(match[1].toLowerCase());
    });
    result.byObject[name] = guids;
  });
  return result;
}

function countGmpAudioSceneSources(root) {
  var sceneFile = path.join(root, 'Assets', 'Scenes', 'Game.unity');
  if (!fs.existsSync(sceneFile)) return -1;
  var blocks = parseUnitySceneBlocks(readTextIfExists(sceneFile));
  var byId = Object.create(null);
  var audioComponentIds = null;
  blocks.forEach(function(block) {
    byId[block.id] = block;
    if (block.type !== '1') return;
    var nameMatch = /\n  m_Name:\s*([^\n\r]*)/.exec(block.text);
    var name = nameMatch ? nameMatch[1].trim().replace(/^"|"$/g, '') : '';
    if (name !== 'GMP_Audio') return;
    audioComponentIds = [];
    block.text.replace(/component:\s*\{fileID:\s*(-?\d+)\}/g, function(_, id) {
      audioComponentIds.push(id);
      return _;
    });
  });
  if (!audioComponentIds) return -1;
  var count = 0;
  audioComponentIds.forEach(function(componentId) {
    var block = byId[componentId];
    if (block && block.type === '82' && /\nAudioSource:\s*\n/.test(block.text)) count++;
  });
  return count;
}

function projectCallsAudioPlayback(scriptsRoot) {
  if (!fs.existsSync(scriptsRoot)) return false;
  var files = listFiles(scriptsRoot).filter(function(file) {
    return /\.cs$/i.test(file) && !/Core\/Modules\/GMP_Audio\.cs$/i.test(relative(scriptsRoot, file));
  });
  for (var i = 0; i < files.length; i++) {
    var text = readTextIfExists(files[i]);
    if (/\bGMP_Audio\.instance\b[\s\S]{0,160}\b(?:PlayBGM|PlaySFX|PlayLoop|PlayOneShot|PlayPitch|Play|StopBGM|StopLoop|StopAllLoops|SetMute)\s*\(/.test(text)) return true;
  }
  return false;
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
  if (projectCallsAudioPlayback(scriptsRoot)) {
    if (!/\bpublic\s+void\s+PlayLoop\s*\(/.test(audio)) {
      errors.push('GMP_Audio must support loop playback with PlayLoop when gameplay calls audio playback');
    }
    if (!/\bpublic\s+void\s+PlayOneShot\s*\(/.test(audio)) {
      errors.push('GMP_Audio must support one-shot playback with PlayOneShot when gameplay calls audio playback');
    }
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

function validateRequiredV14Entrypoints(root, scriptsRoot, errors) {
  var required = [
    { rel: 'Assets/Scripts/Core/Modules/GMP_MainManager.cs', objectName: 'GMP_MainManager' },
    { rel: 'Assets/Scripts/Core/Modules/GMP_PhaseController.cs', objectName: 'GMP_PhaseController' },
    { rel: 'Assets/Scripts/Core/Modules/GMP_Audio.cs', objectName: 'GMP_Audio' },
    { rel: 'Assets/Scripts/Core/Modules/GMP_HudController.cs', objectName: 'GMP_HudController' },
    { rel: 'Assets/Scripts/Core/Modules/GMP_EventModule.cs', objectName: 'GMP_EventModule' },
    { rel: 'Assets/Scripts/Game/Level/GMP_SceneEntityRefs.cs', objectName: 'GMP_SceneEntityRefs' },
    { rel: 'Assets/Scripts/Game/Level/GMP_LevelRuleEngine.cs', objectName: 'GMP_LevelRuleEngine' },
    { rel: 'Assets/Scripts/Game/AutoPlay/GMP_AutoPlayDriver.cs', objectName: 'GMP_AutoPlayDriver' }
  ];
  var sceneRefs = collectSceneScriptRefs(root);
  var metaGuids = collectCsMetaGuids(root);
  required.forEach(function(item) {
    if (item.alternatives) {
      validateRequiredEntrypointAlternative(root, item.alternatives, sceneRefs, metaGuids, errors);
      return;
    }
    validateRequiredEntrypoint(root, item, sceneRefs, metaGuids, errors);
  });
}

function validateRequiredEntrypointAlternative(root, alternatives, sceneRefs, metaGuids, errors) {
  var localErrors = [];
  for (var i = 0; i < alternatives.length; i++) {
    var before = localErrors.length;
    validateRequiredEntrypoint(root, alternatives[i], sceneRefs, metaGuids, localErrors);
    if (localErrors.length === before) return;
  }
  errors.push(alternatives.map(function(item) { return item.rel; }).join(' or ') + ' missing or not mounted correctly');
}

function validateRequiredEntrypoint(root, item, sceneRefs, metaGuids, errors) {
    var file = path.join(root, item.rel);
    if (!fs.existsSync(file)) {
      errors.push(item.rel + ' missing');
      return;
    }
    var guid = readUnityMetaGuid(file);
    if (!guid) {
      errors.push(item.rel + '.meta missing or missing guid');
      return;
    }
    var objectGuids = sceneRefs.byObject[item.objectName] || [];
    if (!objectGuids.length) {
      errors.push('Assets/Scenes/Game.unity missing mounted script object ' + item.objectName);
      return;
    }
    if (objectGuids.indexOf(guid) < 0) {
      errors.push('Assets/Scenes/Game.unity ' + item.objectName + ' m_Script guid does not match ' + item.rel + '.meta');
    }
    objectGuids.forEach(function(sceneGuid) {
      if (!metaGuids[sceneGuid]) {
        errors.push('Assets/Scenes/Game.unity ' + item.objectName + ' references unresolved script guid ' + sceneGuid);
      }
    });
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
  validateRequiredV14Entrypoints(root, scriptsRoot, errors);

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

function validateSummaryFileConsistency(root, summary, errors) {
  if (!isObject(summary)) return;
  var removedNames = Array.isArray(summary.unusedScriptNamesRemoved) ? summary.unusedScriptNamesRemoved : [];
  if (!removedNames.length) return;
  var scriptsRoot = path.join(root, 'Assets', 'Scripts');
  if (!fs.existsSync(scriptsRoot)) return;
  var existingByName = Object.create(null);
  listFiles(scriptsRoot).forEach(function(file) {
    if (/\.cs$/i.test(file)) existingByName[path.basename(file)] = relative(root, file);
  });
  var stale = [];
  removedNames.forEach(function(name) {
    if (existingByName[name]) stale.push({ file: existingByName[name], summaryField: 'unusedScriptNamesRemoved' });
  });
  if (stale.length) {
    errors.push('PROGRAMMER_DELIVERY_SUMMARY.json says removed scripts still exist: ' + stale.map(function(item) {
      return item.file;
    }).join(', '));
  }
}

function validateProgrammerDelivery(root, summary) {
  root = path.resolve(root);
  summary = summary || {};
  var errors = [];
  var warnings = [];
  var sceneHydration = hydrationReport.validateHydration(root, { mode: 'hardgate-static-check' });
  var hydrationPath = path.join(root, 'MCP_HYDRATION_REPORT.json');
  var hydrationFile = readJsonIfExists(hydrationPath);
  var maintainability = maintainabilityGate.validateMaintainability(root, { strict: true });
  var temporaryCodeAudit = tempCodeAudit.auditProgrammerDeliveryTempCode(root, {
    summary: summary,
    hydrationReport: hydrationFile,
    sceneBakePlanPath: path.join(root, 'SCENE_BAKE_PLAN.json'),
    strictAibridge: process.env.BLUEPRINT_REQUIRE_AIBRIDGE === '1'
  });

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
  validateSummaryFileConsistency(root, summary, errors);
  validateV14ScriptLayout(root, errors);

  if (!hydrationFile) {
    errors.push('MCP_HYDRATION_REPORT.json missing; run AIBridgeCLI hydration before delivery hardgate');
  } else {
    if (hydrationFile.kind !== hydrationReport.KIND) {
      errors.push('MCP_HYDRATION_REPORT.json kind invalid: ' + hydrationFile.kind);
    }
    if (Number(hydrationFile.schemaVersion || 0) !== hydrationReport.SCHEMA_VERSION) {
      errors.push('MCP_HYDRATION_REPORT.json schemaVersion invalid: ' + hydrationFile.schemaVersion);
    }
    if (hydrationFile.aibridge && hydrationFile.aibridge.ran === false && hydrationFile.aibridge.required === true) {
      errors.push('MCP_HYDRATION_REPORT.json says AIBridgeCLI was required but did not run');
    }
  }
  if (!sceneHydration.passed) {
    sceneHydration.errors.forEach(function(error) {
      errors.push('hydration: ' + error);
    });
  }
  sceneHydration.warnings.forEach(function(warning) {
    warnings.push('hydration: ' + warning);
  });

  if (!maintainability.passed) {
    maintainability.errors.forEach(function(issue) {
      errors.push('maintainability: ' + issue.message);
    });
  }
  maintainability.warnings.forEach(function(issue) {
    warnings.push('maintainability: ' + issue.message);
  });
  if (!temporaryCodeAudit.passed) {
    temporaryCodeAudit.errors.forEach(function(issue) {
      errors.push('temporary-code: ' + issue.message);
    });
  }
  temporaryCodeAudit.warnings.forEach(function(issue) {
    warnings.push('temporary-code: ' + issue.message);
  });

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
    hydration: sceneHydration,
    hydrationReport: hydrationFile,
    maintainability: maintainability,
    temporaryCodeAudit: temporaryCodeAudit,
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
      hydrationReportPresent: !!hydrationFile,
      hydrationPassed: sceneHydration.passed,
      hydrationErrorCount: sceneHydration.errors.length,
      hydrationWarningCount: sceneHydration.warnings.length,
      hydrationAIBridgeRan: !!(hydrationFile && hydrationFile.aibridge && hydrationFile.aibridge.ran),
      maintainabilityPassed: maintainability.passed,
      maintainabilityErrorCount: maintainability.errors.length,
      maintainabilityWarningCount: maintainability.warnings.length,
      maintainabilityThinEntityClassCount: maintainability.summary.thinEntityClassCount,
      maintainabilityGameObjectFindCount: maintainability.summary.gameObjectFindCount,
      maintainabilityGameObjectFindGameLayerCount: maintainability.summary.gameObjectFindGameLayerCount,
      maintainabilityAddComponentCount: maintainability.summary.addComponentCount,
      maintainabilityAddComponentGameLayerCount: maintainability.summary.addComponentGameLayerCount,
      maintainabilityNewGameObjectCount: maintainability.summary.newGameObjectCount,
      maintainabilityNewGameObjectGameLayerCount: maintainability.summary.newGameObjectGameLayerCount,
      maintainabilityEntityNameBranchCount: maintainability.summary.entityNameBranchCount,
      maintainabilityVector3DistanceCount: maintainability.summary.vector3DistanceCount || 0,
      maintainabilityStaticWorkflowMethodCount: maintainability.summary.staticWorkflowMethodCount || 0,
      maintainabilityDuplicateStateOwnerCount: maintainability.summary.duplicateStateOwnerCount || 0,
      maintainabilityUnusedMethodCount: maintainability.summary.unusedMethodCount || 0,
      maintainabilityMethodDefinitionCount: maintainability.summary.methodDefinitionCount || 0,
      temporaryRuntimeScriptCount: temporaryCodeAudit.summary.temporaryRuntimeScriptCount || 0,
      temporaryPrimitiveSpecSerializedFieldCount: temporaryCodeAudit.summary.primitiveSpecSerializedFieldCount || 0,
      sceneBakeReportPresent: temporaryCodeAudit.summary.sceneBakeReportPresent === true,
      sceneBakePlanPresent: temporaryCodeAudit.summary.sceneBakePlanPresent === true,
    },
  };
}

function writeDeliveryValidation(root, summaryPath, outPath) {
  var summary = readJsonIfExists(summaryPath);
  var hydrationPath = path.join(path.resolve(root), 'MCP_HYDRATION_REPORT.json');
  if (!fs.existsSync(hydrationPath)) {
    hydrationReport.writeHydrationReport(root, hydrationPath, { mode: 'hardgate-static-fallback' });
  }
  var sceneBakePlanPath = path.join(path.resolve(root), 'SCENE_BAKE_PLAN.json');
  if (!fs.existsSync(sceneBakePlanPath)) {
    sceneBakePlan.writeSceneBakePlan(root, sceneBakePlanPath, { summaryPath: summaryPath });
  }
  var validation = validateProgrammerDelivery(root, summary || {});
  var target = outPath || path.join(path.resolve(root), 'DELIVERY_VALIDATION.json');
  maintainabilityGate.writeMaintainabilityReport(root, path.join(path.resolve(root), 'PROGRAMMER_MAINTAINABILITY_REPORT.json'), { strict: true });
  tempCodeAudit.writeTempCodeAudit(root, path.join(path.resolve(root), 'PROGRAMMER_TEMP_CODE_AUDIT.json'), {
    summary: summary || {},
    hydrationPath: hydrationPath,
    sceneBakePlanPath: sceneBakePlanPath,
    strictAibridge: process.env.BLUEPRINT_REQUIRE_AIBRIDGE === '1'
  });
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
