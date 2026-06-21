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

function hydrationEditorConnected(hydrationFile) {
  if (!hydrationFile || !isObject(hydrationFile)) return false;
  if (hydrationFile.editorConnected === true) return true;
  if (hydrationFile.summary && hydrationFile.summary.editorConnected === true) return true;
  if (hydrationFile.aibridge && hydrationFile.aibridge.editorConnected === true) return true;
  if (hydrationFile.editor && hydrationFile.editor.connected === true) return true;
  return false;
}

function hydrationUsesStaticFallback(hydrationFile) {
  if (!hydrationFile || !isObject(hydrationFile)) return true;
  return /static/i.test(String(hydrationFile.mode || '')) ||
    /static/i.test(String(hydrationFile.toolLayer || ''));
}

function validateFinalEditorHydration(hydrationFile, errors) {
  if (!hydrationFile) return;
  if (hydrationUsesStaticFallback(hydrationFile)) {
    errors.push('final Unity delivery requires live Editor hydration; MCP_HYDRATION_REPORT.json is static/fallback evidence');
  }
  if (!hydrationEditorConnected(hydrationFile)) {
    errors.push('final Unity delivery requires AIBridge editor get_state/editor hydration success; current report does not prove an active Unity Editor/AIBridge session');
  }
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

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripCSharpComments(code) {
  return String(code || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n\r]*/g, '');
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

function collectSceneHierarchy(root) {
  var sceneFile = path.join(root, 'Assets', 'Scenes', 'Game.unity');
  var result = {
    missing: true,
    byId: Object.create(null),
    goByName: Object.create(null),
    goComponents: Object.create(null),
    transformByGo: Object.create(null),
    fatherByTransform: Object.create(null)
  };
  if (!fs.existsSync(sceneFile)) return result;
  result.missing = false;
  var blocks = parseUnitySceneBlocks(readTextIfExists(sceneFile));
  blocks.forEach(function(block) {
    result.byId[block.id] = block;
    if (block.type === '1') {
      var nameMatch = /\n  m_Name:\s*([^\n\r]*)/.exec(block.text);
      var name = nameMatch ? nameMatch[1].trim().replace(/^"|"$/g, '') : '';
      if (name) result.goByName[name] = block.id;
      var ids = [];
      block.text.replace(/component:\s*\{fileID:\s*(-?\d+)\}/g, function(_, id) {
        ids.push(id);
        return _;
      });
      result.goComponents[block.id] = ids;
    } else if (block.type === '4' || block.type === '224') {
      var goMatch = /\n  m_GameObject:\s*\{fileID:\s*(-?\d+)\}/.exec(block.text);
      var fatherMatch = /\n  m_Father:\s*\{fileID:\s*(-?\d+)\}/.exec(block.text);
      if (goMatch) result.transformByGo[goMatch[1]] = block.id;
      if (fatherMatch) result.fatherByTransform[block.id] = fatherMatch[1];
    }
  });
  return result;
}

function sceneTransformIdByName(hierarchy, name) {
  var goId = hierarchy.goByName[name];
  if (!goId) return '';
  return hierarchy.transformByGo[goId] || '';
}

function validateNoMonoSingleton(scriptsRoot, errors) {
  if (!fs.existsSync(scriptsRoot)) return;
  var hits = [];
  listFiles(scriptsRoot).forEach(function(file) {
    if (!/\.cs$/i.test(file)) return;
    var text = readTextIfExists(file);
    if (/\bMonoSingleton\s*<|\bclass\s+MonoSingleton\b|\bGMP_SingletonBase\b/.test(text)) {
      hits.push(relative(scriptsRoot, file));
    }
  });
  if (hits.length) errors.push('MonoSingleton/GMP_SingletonBase is forbidden in programmer delivery; use scene-mounted mInstance/instance managers: ' + hits.slice(0, 20).join(', '));
}

function firstCSharpClassName(text) {
  var match = /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(String(text || ''));
  return match ? match[1] : '';
}

function validateSceneSingletonContracts(scriptsRoot, errors) {
  if (!fs.existsSync(scriptsRoot)) return;
  var invalidPublic = [];
  var invalidContract = [];
  listFiles(scriptsRoot).forEach(function(file) {
    if (!/\.cs$/i.test(file)) return;
    var text = stripCSharpComments(readTextIfExists(file));
    var className = firstCSharpClassName(text);
    if (!className) return;
    var escaped = escapeRegExp(className);
    var declaresInstance = new RegExp('\\b(?:public|protected|internal|private|new|static|\\s)+\\s*' + escaped + '\\s+instance\\b').test(text);
    if (!declaresInstance) return;

    var publicField = new RegExp('\\bpublic\\s+(?:(?:new|static)\\s+)+' + escaped + '\\s+instance\\s*;').test(text);
    var autoProperty = new RegExp('\\bpublic\\s+(?:(?:new|static)\\s+)+' + escaped + '\\s+instance\\s*\\{\\s*get\\s*;').test(text);
    if (publicField || autoProperty) invalidPublic.push(relative(scriptsRoot, file));

    var hasMInstance = new RegExp('\\bprivate\\s+static\\s+' + escaped + '\\s+mInstance\\s*;').test(text);
    var hasGetter = new RegExp('\\bpublic\\s+(?:(?:new|static)\\s+)+' + escaped + '\\s+instance\\s*\\{[\\s\\S]*?get\\s*\\{[\\s\\S]*?return\\s+mInstance\\s*;[\\s\\S]*?\\}').test(text);
    var registersSceneInstance = /\bmInstance\s*=\s*this\s*;/.test(text);
    if (!hasMInstance || !hasGetter || !registersSceneInstance) invalidContract.push(relative(scriptsRoot, file));
  });
  if (invalidPublic.length) {
    errors.push('Scene singleton instance must not be a public static field or auto-property; use private mInstance plus read-only instance getter: ' + invalidPublic.slice(0, 20).join(', '));
  }
  if (invalidContract.length) {
    errors.push('Scene singleton instance contract incomplete; require private static <Type> mInstance, read-only instance getter returning mInstance, and Awake registration: ' + invalidContract.slice(0, 20).join(', '));
  }
}

function validateEventModuleApi(scriptsRoot, errors) {
  var file = path.join(scriptsRoot, 'Core', 'Modules', 'GMP_EventModule.cs');
  if (!fs.existsSync(file)) return;
  var text = readTextIfExists(file);
  if (!/\bvoid\s+Subscribe\s*\(\s*string\s+eventName\s*,\s*Action\s*<\s*object\s*>\s+callback\s*\)/.test(text)) {
    errors.push('GMP_EventModule must expose Subscribe(string eventName, Action<object> callback)');
  }
  if (!/\bvoid\s+Unsubscribe\s*\(\s*string\s+eventName\s*,\s*Action\s*<\s*object\s*>\s+callback\s*\)/.test(text)) {
    errors.push('GMP_EventModule must expose Unsubscribe(string eventName, Action<object> callback)');
  }
  if (!/\bvoid\s+UnSubScribe\s*\(\s*string\s+eventName\s*,\s*Action\s*<\s*object\s*>\s+callback\s*\)/.test(text)) {
    errors.push('GMP_EventModule must expose UnSubScribe alias for feedback-compatible event unregistration');
  }
}

function validateCanvasStandard(root, errors) {
  var hierarchy = collectSceneHierarchy(root);
  if (hierarchy.missing || !hierarchy.goByName.Canvas) return;
  var canvasGo = hierarchy.goByName.Canvas;
  var componentIds = hierarchy.goComponents[canvasGo] || [];
  var canvasBlock = null;
  var scalerBlock = null;
  componentIds.forEach(function(id) {
    var block = hierarchy.byId[id];
    if (!block) return;
    if (block.type === '223') canvasBlock = block;
    if (block.type === '114' && /m_ReferenceResolution:/.test(block.text)) scalerBlock = block;
  });
  if (!canvasBlock) errors.push('Canvas object must include a Canvas component');
  else {
    if (!/\n  m_RenderMode:\s*0\b/.test(canvasBlock.text)) errors.push('Canvas must use Screen Space - Overlay');
    if (!/\n  m_SortingOrder:\s*100\b/.test(canvasBlock.text)) errors.push('Canvas sort order must be 100');
  }
  if (!scalerBlock) errors.push('Canvas object must include CanvasScaler configured before runtime');
  else {
    if (!/\n  m_ReferenceResolution:\s*\{x:\s*1080(?:\.0+)?,\s*y:\s*1920(?:\.0+)?\}/.test(scalerBlock.text)) {
      errors.push('CanvasScaler reference resolution must be 1080x1920');
    }
    if (!/\n  m_MatchWidthOrHeight:\s*0\.5\b/.test(scalerBlock.text)) {
      errors.push('CanvasScaler matchWidthOrHeight must be 0.5');
    }
  }
}

function validateSceneCodeHierarchy(root, errors) {
  var hierarchy = collectSceneHierarchy(root);
  if (hierarchy.missing) return;
  var codeNames = [
    'GMP_MainManager', 'GMP_PhaseController', 'GMP_SceneEntityRefs', 'GMP_AutoPlayDriver',
    'GMP_HudController', 'GMP_EventModule', 'GMP_LevelRuleEngine', 'GMP_Audio',
    'GMP_AutoPlay', 'GMP_CameraController', 'GMP_EconomyManager', 'GMP_ItemManager',
    'GMP_NpcManager', 'GMP_Player', 'GMP_Pool', 'GMP_TipsManager', 'GMP_UIManager'
  ].filter(function(name) { return !!hierarchy.goByName[name]; });
  if (!codeNames.length) return;
  var mainTransform = sceneTransformIdByName(hierarchy, 'MainGame');
  if (!mainTransform) {
    errors.push('Scene code objects must be grouped under a MainGame hierarchy node');
    return;
  }
  var ungrouped = [];
  codeNames.forEach(function(name) {
    var transformId = sceneTransformIdByName(hierarchy, name);
    if (!transformId || hierarchy.fatherByTransform[transformId] !== mainTransform) ungrouped.push(name);
  });
  if (ungrouped.length) errors.push('Scene code objects must be children of MainGame, ungrouped: ' + ungrouped.join(', '));
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

function gmpAudioSceneArrayHasRefs(root, fieldName) {
  var hierarchy = collectSceneHierarchy(root);
  if (hierarchy.missing || !hierarchy.goByName.GMP_Audio) return false;
  var componentIds = hierarchy.goComponents[hierarchy.goByName.GMP_Audio] || [];
  for (var i = 0; i < componentIds.length; i++) {
    var block = hierarchy.byId[componentIds[i]];
    if (!block || block.type !== '114') continue;
    var re = new RegExp('\\n  ' + escapeRegExp(fieldName) + ':\\s*\\n([\\s\\S]*?)(?=\\n  [A-Za-z_][A-Za-z0-9_]*:|\\n--- !u!|$)');
    var match = re.exec(block.text);
    if (match && /fileID:\s*(?!0\b)-?\d+/.test(match[1])) return true;
    var inline = new RegExp('\\n  ' + escapeRegExp(fieldName) + ':\\s*\\[(.*?)\\]').exec(block.text);
    if (inline && /fileID:\s*(?!0\b)-?\d+/.test(inline[1])) return true;
  }
  return false;
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

  var usesSceneSources = /\bGetComponents\s*<\s*AudioSource\s*>\s*\(\s*\)/.test(audio);
  if (!usesSceneSources && (!gmpAudioSceneArrayHasRefs(root, 'mLoopSources') || !gmpAudioSceneArrayHasRefs(root, 'mOneShotSources'))) {
    errors.push('GMP_Audio must bind scene-mounted AudioSource components into mLoopSources/mOneShotSources via Inspector serialization or GetComponents<AudioSource>()');
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

function validateV14PhaseAssets(root, scriptsRoot, errors) {
  var phaseDir = path.join(scriptsRoot, 'Game', 'Phases');
  if (!fs.existsSync(phaseDir)) return;

  listFiles(phaseDir).forEach(function(file) {
    if (!/\.asset$/i.test(file)) return;
    var name = path.basename(file);
    var rel = relative(root, file);
    var text = readTextIfExists(file);
    if (/^Phase\d+\.asset$/i.test(name)) {
      errors.push(rel + ' uses bare numbered Phase asset naming; use Flow01_<业务语义>.asset');
    }
    if (/\n\s*mPhaseId:\s*"?phase\d+"?\s*(?:\n|$)/i.test(text)) {
      errors.push(rel + ' uses bare numbered mPhaseId; use flow01_<业务语义>');
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
  validateNoMonoSingleton(scriptsRoot, errors);
  validateSceneSingletonContracts(scriptsRoot, errors);
  validateEventModuleApi(scriptsRoot, errors);
  validateRequiredV14Entrypoints(root, scriptsRoot, errors);
  validateV14PhaseAssets(root, scriptsRoot, errors);
  validateCanvasStandard(root, errors);
  validateSceneCodeHierarchy(root, errors);

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
    validateFinalEditorHydration(hydrationFile, errors);
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
      hydrationEditorConnected: hydrationEditorConnected(hydrationFile),
      hydrationUsesStaticFallback: hydrationUsesStaticFallback(hydrationFile),
      finalEditorHydrationPassed: hydrationFile ? hydrationEditorConnected(hydrationFile) && !hydrationUsesStaticFallback(hydrationFile) : false,
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
