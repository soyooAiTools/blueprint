'use strict';

var fs = require('fs');
var path = require('path');

var KIND = 'blueprint.programmerDeliverySceneHydration';
var SCHEMA_VERSION = 1;

var REQUIRED_SCENE_SCRIPTS = [
  { rel: 'Assets/Scripts/Core/Modules/GMP_MainManager.cs', objectName: 'GMP_MainManager' },
  { rel: 'Assets/Scripts/Core/Modules/GMP_PhaseController.cs', objectName: 'GMP_PhaseController' },
  { rel: 'Assets/Scripts/Core/Modules/GMP_Audio.cs', objectName: 'GMP_Audio' },
  { rel: 'Assets/Scripts/Core/Modules/GMP_UIManager.cs', objectName: 'GMP_UIManager' },
  { rel: 'Assets/Scripts/Core/Modules/GMP_HudController.cs', objectName: 'GMP_HudController' },
  { rel: 'Assets/Scripts/Core/Modules/GMP_EventModule.cs', objectName: 'GMP_EventModule' },
  { rel: 'Assets/Scripts/Tool/GMP_CameraController.cs', objectName: 'GMP_CameraController' },
  { rel: 'Assets/Scripts/Game/Level/GMP_EntityBindingManager.cs', objectName: 'GMP_EntityBindingManager' },
  { rel: 'Assets/Scripts/Game/Level/GMP_LevelRuleEngine.cs', objectName: 'GMP_LevelRuleEngine' },
  { rel: 'Assets/Scripts/Game/Player/GMP_Player.cs', objectName: 'GMP_Player' },
  { rel: 'Assets/Scripts/Game/AutoPlay/GMP_AutoPlayDriver.cs', objectName: 'GMP_AutoPlayDriver' }
];

function readTextIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf8');
}

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

function relative(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

function listFiles(root) {
  var out = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function(entry) {
      var full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.git' || entry.name === '.svn' || entry.name === 'Library' || entry.name === 'Temp' || entry.name === 'Obj') return;
        walk(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    });
  }
  walk(root);
  return out;
}

function readUnityMetaGuid(csFile) {
  var meta = csFile + '.meta';
  var match = /^guid:\s*([0-9a-fA-F]+)/m.exec(readTextIfExists(meta));
  return match ? match[1].toLowerCase() : '';
}

function collectScriptGuidMap(root) {
  var scriptsRoot = path.join(root, 'Assets', 'Scripts');
  var byGuid = Object.create(null);
  var byRel = Object.create(null);
  if (!fs.existsSync(scriptsRoot)) return { byGuid: byGuid, byRel: byRel };
  listFiles(scriptsRoot).forEach(function(file) {
    if (!/\.cs$/i.test(file)) return;
    var rel = relative(root, file);
    var guid = readUnityMetaGuid(file);
    if (!guid) return;
    byGuid[guid] = rel;
    byRel[rel] = guid;
  });
  return { byGuid: byGuid, byRel: byRel };
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

function collectScene(root) {
  var sceneFile = path.join(root, 'Assets', 'Scenes', 'Game.unity');
  var sceneText = readTextIfExists(sceneFile);
  var blocks = parseUnitySceneBlocks(sceneText);
  var byId = Object.create(null);
  var goByName = Object.create(null);
  var goNameById = Object.create(null);
  var goComponents = Object.create(null);
  var componentGo = Object.create(null);
  var componentType = Object.create(null);
  var componentScriptGuid = Object.create(null);

  blocks.forEach(function(block) {
    byId[block.id] = block;
    if (block.type === '1') {
      var nameMatch = /\n  m_Name:\s*([^\n\r]*)/.exec(block.text);
      var name = nameMatch ? nameMatch[1].trim().replace(/^"|"$/g, '') : '';
      if (name) {
        goByName[name] = block.id;
        goNameById[block.id] = name;
      }
      var ids = [];
      block.text.replace(/component:\s*\{fileID:\s*(-?\d+)\}/g, function(_, id) {
        ids.push(id);
        return _;
      });
      goComponents[block.id] = ids;
    } else {
      var goMatch = /\n  m_GameObject:\s*\{fileID:\s*(-?\d+)\}/.exec(block.text);
      if (goMatch) componentGo[block.id] = goMatch[1];
      componentType[block.id] = block.type;
      if (block.type === '114') {
        var scriptMatch = /m_Script:\s*\{fileID:\s*11500000,\s*guid:\s*([0-9a-fA-F]+),\s*type:\s*3\}/.exec(block.text);
        if (scriptMatch) componentScriptGuid[block.id] = scriptMatch[1].toLowerCase();
      }
    }
  });

  return {
    path: sceneFile,
    exists: !!sceneText,
    blocks: blocks,
    byId: byId,
    goByName: goByName,
    goNameById: goNameById,
    goComponents: goComponents,
    componentGo: componentGo,
    componentType: componentType,
    componentScriptGuid: componentScriptGuid
  };
}

function mountedScriptGuids(scene, objectName) {
  var goId = scene.goByName[objectName];
  var out = [];
  if (!goId) return out;
  (scene.goComponents[goId] || []).forEach(function(componentId) {
    if (scene.componentType[componentId] !== '114') return;
    var guid = scene.componentScriptGuid[componentId];
    if (guid) out.push(guid);
  });
  return out;
}

function validateRequiredSceneScripts(root, scene, scripts, errors) {
  var details = [];
  REQUIRED_SCENE_SCRIPTS.forEach(function(item) {
    var expectedGuid = scripts.byRel[item.rel] || readUnityMetaGuid(path.join(root, item.rel));
    var actualGuids = mountedScriptGuids(scene, item.objectName);
    var status = 'ok';
    if (!fs.existsSync(path.join(root, item.rel))) {
      status = 'script_missing';
      errors.push(item.rel + ' missing for scene hydration');
    } else if (!expectedGuid) {
      status = 'meta_missing';
      errors.push(item.rel + '.meta missing or missing guid for scene hydration');
    } else if (!scene.goByName[item.objectName]) {
      status = 'object_missing';
      errors.push('Game.unity missing scene object ' + item.objectName + ' for ' + item.rel);
    } else if (actualGuids.indexOf(expectedGuid) < 0) {
      status = 'guid_mismatch';
      errors.push('Game.unity ' + item.objectName + ' is not bound to ' + item.rel);
    }
    actualGuids.forEach(function(guid) {
      if (!scripts.byGuid[guid]) {
        status = 'unresolved_guid';
        errors.push('Game.unity ' + item.objectName + ' references unresolved script guid ' + guid);
      }
    });
    details.push({
      objectName: item.objectName,
      script: item.rel,
      expectedGuid: expectedGuid || '',
      actualGuids: actualGuids,
      status: status
    });
  });
  return details;
}

function isLogicScript(rel) {
  return /^Assets\/Scripts\/(?:Core|Game)\//.test(rel || '');
}

function collectLogicVisualViolations(scene, scripts) {
  var violations = [];
  Object.keys(scene.goComponents).forEach(function(goId) {
    var components = scene.goComponents[goId] || [];
    var hasVisualRig = false;
    var logicScripts = [];
    components.forEach(function(componentId) {
      var type = scene.componentType[componentId];
      if (type === '95' || type === '137') hasVisualRig = true;
      if (type === '114') {
        var rel = scripts.byGuid[scene.componentScriptGuid[componentId]];
        if (isLogicScript(rel)) logicScripts.push(rel);
      }
    });
    if (hasVisualRig && logicScripts.length) {
      violations.push({
        objectName: scene.goNameById[goId] || goId,
        scripts: logicScripts
      });
    }
  });
  return violations;
}

function validateHydration(root, options) {
  options = options || {};
  root = path.resolve(root);
  var errors = [];
  var warnings = [];
  var scene = collectScene(root);
  var scripts = collectScriptGuidMap(root);

  if (!scene.exists) {
    errors.push('Assets/Scenes/Game.unity missing for scene hydration');
  }

  var requiredScripts = validateRequiredSceneScripts(root, scene, scripts, errors);
  var logicVisualViolations = collectLogicVisualViolations(scene, scripts);
  logicVisualViolations.forEach(function(item) {
    errors.push('logic script mounted on visual rig object: ' + item.objectName);
  });

  var sourceSnapshot = readJsonIfExists(path.join(root, 'source-scene-ir.json')) ||
    readJsonIfExists(path.join(root, 'source-ir.json'));
  if (!sourceSnapshot) {
    warnings.push('source-scene-ir/source-ir snapshot missing; hydration can still validate scene wiring');
  }

  var missingRequired = requiredScripts.filter(function(item) { return item.status !== 'ok'; });
  return {
    kind: KIND,
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    root: root,
    mode: options.mode || 'static-unity-yaml',
    toolLayer: 'aibridge-compatible',
    mcpBoundary: 'programmer-delivery-only',
    passed: errors.length === 0,
    errors: errors,
    warnings: warnings,
    requiredSceneScripts: requiredScripts,
    logicVisualSeparation: {
      passed: logicVisualViolations.length === 0,
      violations: logicVisualViolations
    },
    summary: {
      sceneExists: scene.exists,
      requiredSceneScriptCount: REQUIRED_SCENE_SCRIPTS.length,
      requiredSceneScriptIssueCount: missingRequired.length,
      logicVisualViolationCount: logicVisualViolations.length,
      scriptGuidCount: Object.keys(scripts.byGuid).length
    }
  };
}

function writeHydrationReport(root, outPath, options) {
  var report = validateHydration(root, options || {});
  var target = outPath || path.join(path.resolve(root), 'MCP_HYDRATION_REPORT.json');
  fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n');
  return report;
}

function usage() {
  console.error('Usage: node lib/programmer-delivery-hydration-report.cjs <delivery-root> [--out MCP_HYDRATION_REPORT.json]');
  process.exit(2);
}

if (require.main === module) {
  var root = process.argv[2];
  var outPath = null;
  for (var i = 3; i < process.argv.length; i++) {
    if (process.argv[i] === '--out') outPath = process.argv[++i] || null;
    else usage();
  }
  if (!root) usage();
  try {
    var result = writeHydrationReport(root, outPath);
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
  REQUIRED_SCENE_SCRIPTS: REQUIRED_SCENE_SCRIPTS,
  validateHydration: validateHydration,
  writeHydrationReport: writeHydrationReport
};
