'use strict';

var fs = require('fs');
var path = require('path');

var KIND = 'blueprint.programmerDeliveryMaintainability';
var SCHEMA_VERSION = 1;

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

function relative(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function walkFiles(root, options) {
  options = options || {};
  var out = [];
  var skipDirs = {
    '.git': true,
    '.svn': true,
    'Library': true,
    'Temp': true,
    'Obj': true,
    'Build': true,
    'Builds': true,
    'node_modules': true
  };
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    var entries = fs.readdirSync(dir, { withFileTypes: true });
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      if (entry.name === '.DS_Store') continue;
      var full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipDirs[entry.name]) continue;
        walk(full);
      } else if (entry.isFile()) {
        if (options.ext && !options.ext.test(entry.name)) continue;
        out.push(full);
      }
    }
  }
  walk(root);
  return out;
}

function countLines(text) {
  if (!text) return 0;
  var lines = String(text).split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

function addIssue(target, code, message, details) {
  var item = { code: code, message: message };
  if (details) item.details = details;
  target.push(item);
}

function isV14Layout(root) {
  return fs.existsSync(path.join(root, 'Assets', 'Scripts', 'Core'))
    && fs.existsSync(path.join(root, 'Assets', 'Scripts', 'Tool'))
    && fs.existsSync(path.join(root, 'Assets', 'Scripts', 'Game'));
}

function stripComments(text) {
  return String(text || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n\r]*/g, '');
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

var UNITY_OR_EXTERNAL_METHODS = {
  Awake: true,
  Start: true,
  Update: true,
  FixedUpdate: true,
  LateUpdate: true,
  OnEnable: true,
  OnDisable: true,
  OnDestroy: true,
  OnValidate: true,
  Reset: true,
  OnGUI: true,
  OnDrawGizmos: true,
  OnDrawGizmosSelected: true,
  OnApplicationPause: true,
  OnApplicationFocus: true,
  OnApplicationQuit: true,
  OnTriggerEnter: true,
  OnTriggerExit: true,
  OnTriggerStay: true,
  OnCollisionEnter: true,
  OnCollisionExit: true,
  OnCollisionStay: true,
  OnPointerDown: true,
  OnPointerUp: true,
  OnPointerClick: true,
  OnBeginDrag: true,
  OnDrag: true,
  OnEndDrag: true,
  OnDrop: true,
  OnScroll: true,
  OnMove: true,
  OnSubmit: true,
  OnCancel: true,
  OnSelect: true,
  OnDeselect: true,
  OnBeforeSerialize: true,
  OnAfterDeserialize: true,
  Dispose: true,
  ToString: true,
  Equals: true,
  GetHashCode: true,
  CompareTo: true
};

function countSubstringLine(text, index) {
  return String(text || '').slice(0, index).split(/\r?\n/).length;
}

function collectCSharpMethodDefinitions(root) {
  var scriptsRoot = path.join(root, 'Assets', 'Scripts');
  var files = fs.existsSync(scriptsRoot) ? walkFiles(scriptsRoot, { ext: /\.cs$/i }) : [];
  var methodRe = /(^|\n)([ \t]*(?:\[[^\n]*\]\s*)*(?:(?:public|private|protected|internal|static|virtual|override|sealed|new|async|extern)\s+)+(?:[\w.<>,\[\]?]+\s+)+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>{};()]+>)?\s*\([^;{}]*\)\s*(?:where\s+[^{};]+)?\s*(?:\{|=>))/g;
  var defs = [];
  var allCode = [];
  files.forEach(function(file) {
    var rel = relative(root, file);
    var code = stripComments(readTextIfExists(file));
    allCode.push(code);
    var match;
    while ((match = methodRe.exec(code))) {
      var name = match[3];
      if (!name || UNITY_OR_EXTERNAL_METHODS[name]) continue;
      defs.push({
        name: name,
        file: rel,
        line: countSubstringLine(code, match.index + (match[1] || '').length),
        declaration: String(match[2] || '').trim().replace(/\s+/g, ' ').slice(0, 180)
      });
    }
  });
  return { definitions: defs, codeText: allCode.join('\n') };
}

function collectSerializedMethodNames(root) {
  var assetsRoot = path.join(root, 'Assets');
  var files = fs.existsSync(assetsRoot) ? walkFiles(assetsRoot, { ext: /\.(unity|prefab|asset|controller|anim)$/i }) : [];
  var names = Object.create(null);
  files.forEach(function(file) {
    var text = readTextIfExists(file);
    text.replace(/\bm_MethodName:\s*([A-Za-z_][A-Za-z0-9_]*)/g, function(_, name) {
      names[name] = (names[name] || 0) + 1;
      return _;
    });
    text.replace(/\bfunctionName:\s*([A-Za-z_][A-Za-z0-9_]*)/g, function(_, name) {
      names[name] = (names[name] || 0) + 1;
      return _;
    });
  });
  return names;
}

function analyzeUnusedMethods(root, errors, warnings, options) {
  var strict = options && options.strict === true;
  var collected = collectCSharpMethodDefinitions(root);
  var defs = collected.definitions;
  var codeText = collected.codeText;
  var serializedMethodNames = collectSerializedMethodNames(root);
  var definitionCounts = Object.create(null);
  defs.forEach(function(def) {
    definitionCounts[def.name] = (definitionCounts[def.name] || 0) + 1;
  });

  var callCounts = Object.create(null);
  var identifierCounts = Object.create(null);
  Object.keys(definitionCounts).forEach(function(name) {
    var re = new RegExp('(^|[^A-Za-z0-9_])' + escapeRegExp(name) + '\\s*\\(', 'g');
    var count = 0;
    while (re.exec(codeText)) count++;
    callCounts[name] = count;
    var idRe = new RegExp('(^|[^A-Za-z0-9_])' + escapeRegExp(name) + '([^A-Za-z0-9_]|$)', 'g');
    var idCount = 0;
    while (idRe.exec(codeText)) idCount++;
    identifierCounts[name] = idCount;
  });

  var unused = defs.filter(function(def) {
    if (serializedMethodNames[def.name]) return false;
    if ((callCounts[def.name] || 0) > (definitionCounts[def.name] || 0)) return false;
    return (identifierCounts[def.name] || 0) <= (definitionCounts[def.name] || 0);
  });

  if (unused.length > 0) {
    var details = unused.slice(0, 40).map(function(item) {
      return {
        file: item.file,
        line: item.line,
        method: item.name,
        callCount: callCounts[item.name] || 0,
        definitionCount: definitionCounts[item.name] || 0
      };
    });
    var message = 'Delivery scripts contain methods that are defined but not called by code or serialized Unity events: ' + unused.length;
    if (strict) addIssue(errors, 'unused-methods', message, details);
    else addIssue(warnings, 'unused-methods-present', message, details);
  }
  return {
    count: unused.length,
    methodDefinitionCount: defs.length,
    examples: unused.slice(0, 40)
  };
}

function meaningfulEntityLines(text) {
  return stripComments(text).split(/\r?\n/).map(function(line) {
    return line.trim();
  }).filter(function(line) {
    if (!line) return false;
    if (/^using\b/.test(line)) return false;
    if (/^namespace\b/.test(line)) return false;
    if (/^\[.*\]$/.test(line)) return false;
    if (/^[{}]+$/.test(line)) return false;
    if (/^public\s+(?:partial\s+)?class\s+\w+\b/.test(line)) return false;
    if (/^public\s+(?:const|static\s+readonly)\s+string\s+Id\s*=/.test(line)) return false;
    if (/^public\s+(?:const|static\s+readonly)\s+string\s+EntityId\s*=/.test(line)) return false;
    return true;
  });
}

function analyzeEntityClasses(root, errors, warnings) {
  var entityDir = path.join(root, 'Assets', 'Scripts', 'Game', 'Entities');
  var files = fs.existsSync(entityDir) ? walkFiles(entityDir, { ext: /\.cs$/i }) : [];
  var thin = [];
  for (var i = 0; i < files.length; i++) {
    var text = readTextIfExists(files[i]);
    var lines = meaningfulEntityLines(text);
    var rel = relative(root, files[i]);
    if (lines.length <= 1) {
      thin.push({ file: rel, meaningfulLines: lines.length, lineCount: countLines(text) });
    }
  }
  if (files.length === 0) {
    addIssue(warnings, 'game-entities-missing', 'Assets/Scripts/Game/Entities has no concrete entity classes');
  } else if (thin.length > 0) {
    addIssue(errors, 'thin-entity-classes', 'Game/Entities contains empty shell entity classes: ' + thin.length + '/' + files.length, thin.slice(0, 20));
  }
  return { total: files.length, thin: thin.length, examples: thin.slice(0, 20) };
}

function analyzeDynamicSceneBinding(root, errors, warnings, options) {
  var strict = options && options.strict === true;
  var scriptsRoot = path.join(root, 'Assets', 'Scripts');
  var files = fs.existsSync(scriptsRoot) ? walkFiles(scriptsRoot, { ext: /\.cs$/i }) : [];
  var findTotal = 0;
  var findGameTotal = 0;
  var addComponentTotal = 0;
  var addComponentGameTotal = 0;
  var newGameObjectTotal = 0;
  var newGameObjectGameTotal = 0;
  var findDetails = [];
  var findGameDetails = [];
  var addComponentDetails = [];
  var addComponentGameDetails = [];
  var newGameObjectDetails = [];
  var newGameObjectGameDetails = [];
  for (var i = 0; i < files.length; i++) {
    var rel = relative(root, files[i]);
    var text = stripComments(readTextIfExists(files[i]));
    var isGameLayer = /^Assets\/Scripts\/Game\//.test(rel);
    var isRegistry = /Core\/Common\/GMP_SceneObjectRegistry\.cs$/.test(rel);
    var findMatches = text.match(/\b(?:GameObject\.Find(?:WithTag|GameObjectsWithTag)?|(?:UnityEngine\.)?Object\.FindObjectOfType\s*<|FindObjectOfType\s*<|FindObjectsOfType\s*<|Resources\.FindObjectsOfTypeAll\s*<)/g) || [];
    var addComponentMatches = text.match(/\.\s*AddComponent\s*(?:<|\()/g) || [];
    var newGameObjectMatches = text.match(/\bnew\s+GameObject\s*\(/g) || [];

    if (findMatches.length) {
      findTotal += findMatches.length;
      var findItem = { file: rel, count: findMatches.length };
      findDetails.push(findItem);
      if (isGameLayer && !isRegistry) {
        findGameTotal += findMatches.length;
        findGameDetails.push(findItem);
      }
    }
    if (addComponentMatches.length) {
      addComponentTotal += addComponentMatches.length;
      var addItem = { file: rel, count: addComponentMatches.length };
      addComponentDetails.push(addItem);
      if (isGameLayer) {
        addComponentGameTotal += addComponentMatches.length;
        addComponentGameDetails.push(addItem);
      }
    }
    if (newGameObjectMatches.length) {
      newGameObjectTotal += newGameObjectMatches.length;
      var newItem = { file: rel, count: newGameObjectMatches.length };
      newGameObjectDetails.push(newItem);
      if (isGameLayer) {
        newGameObjectGameTotal += newGameObjectMatches.length;
        newGameObjectGameDetails.push(newItem);
      }
    }
  }

  var threshold = strict ? 0 : 48;
  if (strict && findTotal > threshold) {
    addIssue(errors, 'gameobject-find-overuse', 'Delivery scripts contain runtime scene lookup calls; bind references through scene hydration instead: ' + findTotal + ' total, ' + findGameTotal + ' in Game layer', findDetails.slice(0, 20));
  } else if (findTotal > 0) {
    addIssue(warnings, 'gameobject-find-present', 'Delivery scripts still contain scene-wide lookup calls: ' + findTotal + ' total, ' + findGameTotal + ' in Game layer', findDetails.slice(0, 20));
  }
  if (strict && addComponentTotal > 0) {
    addIssue(errors, 'addcomponent-runtime-binding', 'Delivery scripts contain runtime AddComponent calls; scripts should be mounted in the scene before Play: ' + addComponentTotal + ' total, ' + addComponentGameTotal + ' in Game layer', addComponentDetails.slice(0, 20));
  } else if (addComponentTotal > 0) {
    addIssue(warnings, 'addcomponent-present', 'Delivery scripts still contain AddComponent calls: ' + addComponentTotal + ' total, ' + addComponentGameTotal + ' in Game layer', addComponentDetails.slice(0, 20));
  }
  if (strict && newGameObjectTotal > 0) {
    addIssue(errors, 'new-gameobject-runtime-binding', 'Delivery scripts create scene objects at runtime; prefer scene objects hydrated before Play: ' + newGameObjectTotal + ' total, ' + newGameObjectGameTotal + ' in Game layer', newGameObjectDetails.slice(0, 20));
  } else if (newGameObjectTotal > 0) {
    addIssue(warnings, 'new-gameobject-present', 'Delivery scripts still create GameObjects at runtime: ' + newGameObjectTotal + ' total, ' + newGameObjectGameTotal + ' in Game layer', newGameObjectDetails.slice(0, 20));
  }
  return {
    count: findTotal,
    gameCount: findGameTotal,
    files: findDetails.length,
    threshold: threshold,
    examples: findDetails.slice(0, 20),
    addComponentCount: addComponentTotal,
    addComponentGameCount: addComponentGameTotal,
    addComponentFileCount: addComponentDetails.length,
    addComponentExamples: addComponentDetails.slice(0, 20),
    newGameObjectCount: newGameObjectTotal,
    newGameObjectGameCount: newGameObjectGameTotal,
    newGameObjectFileCount: newGameObjectDetails.length,
    newGameObjectExamples: newGameObjectDetails.slice(0, 20)
  };
}

function analyzeDynamicUiCreation(root, errors, warnings, options) {
  var strict = options && options.strict === true;
  var scriptsRoot = path.join(root, 'Assets', 'Scripts');
  var files = fs.existsSync(scriptsRoot) ? walkFiles(scriptsRoot, { ext: /\.cs$/i }) : [];
  var details = [];
  files.forEach(function(file) {
    var rel = relative(root, file);
    if (/^Assets\/Scripts\/Tool\/GMP_UI\.cs$/.test(rel)) return;
    var text = stripComments(readTextIfExists(file));
    var count = 0;
    count += (text.match(/\bGMP_UI\.Create(?:Canvas|Text|Button|ProgressBar)\s*\(/g) || []).length;
    count += (text.match(/\bnew\s+GameObject\s*\(\s*"Canvas"/g) || []).length;
    count += (text.match(/\.\s*AddComponent\s*<\s*(?:Canvas|CanvasScaler|GraphicRaycaster|Text|Button|Image|Slider)\s*>/g) || []).length;
    if (count) details.push({ file: rel, count: count });
  });
  var total = details.reduce(function(sum, item) { return sum + item.count; }, 0);
  if (total > 0) {
    var message = 'Delivery scripts dynamically create Canvas/UI; Canvas and core UI nodes must be pre-created in Game.unity and assigned by Inspector/AIBridge: ' + total;
    if (strict) addIssue(errors, 'dynamic-ui-creation', message, details.slice(0, 20));
    else addIssue(warnings, 'dynamic-ui-creation-present', message, details.slice(0, 20));
  }
  return { count: total, files: details.length, examples: details.slice(0, 20) };
}

function analyzeEntityNameBranches(root, errors, warnings, options) {
  var strict = options && options.strict === true;
  var scriptsRoot = path.join(root, 'Assets', 'Scripts');
  var files = fs.existsSync(scriptsRoot) ? walkFiles(scriptsRoot, { ext: /\.cs$/i }) : [];
  var total = 0;
  var core = 0;
  var details = [];
  for (var i = 0; i < files.length; i++) {
    var text = readTextIfExists(files[i]);
    var rel = relative(root, files[i]);
    var matches = (text.match(/\bif\s*\(\s*entityName\s*==\s*"_/g) || []).length
      + (text.match(/\bcase\s+"_[-A-Za-z0-9]+"/g) || []).length;
    if (!matches) continue;
    total += matches;
    if (/^Assets\/Scripts\/Core\//.test(rel)) core += matches;
    details.push({ file: rel, count: matches });
  }
  if (core > 0) {
    addIssue(errors, 'core-entity-name-branches', 'Core layer contains project-specific entityName branches: ' + core, details.filter(function(item) {
      return /^Assets\/Scripts\/Core\//.test(item.file);
    }).slice(0, 20));
  }
  var threshold = strict ? 16 : 40;
  if (total > threshold) {
    addIssue(errors, 'entity-name-branch-overuse', 'entityName string branch table is too large for maintainable delivery: ' + total + ' branches', details.slice(0, 20));
  } else if (total > 0) {
    addIssue(warnings, 'entity-name-branches-present', 'entityName string branches remain in Game layer: ' + total, details.slice(0, 20));
  }
  return { count: total, coreCount: core, threshold: threshold, examples: details.slice(0, 20) };
}

function analyzeDistanceChecks(root, errors, warnings, options) {
  var strict = options && options.strict === true;
  var scriptsRoot = path.join(root, 'Assets', 'Scripts');
  var files = fs.existsSync(scriptsRoot) ? walkFiles(scriptsRoot, { ext: /\.cs$/i }) : [];
  var details = [];
  files.forEach(function(file) {
    var rel = relative(root, file);
    var text = stripComments(readTextIfExists(file));
    var matches = text.match(/\bVector3\.Distance\s*\(/g) || [];
    if (matches.length) details.push({ file: rel, count: matches.length });
  });
  var count = details.reduce(function(sum, item) { return sum + item.count; }, 0);
  if (count > 0) {
    var message = 'Delivery scripts use Vector3.Distance; distance gates should compare squared distance with sqrMagnitude: ' + count;
    if (strict) addIssue(errors, 'vector3-distance-threshold', message, details.slice(0, 20));
    else addIssue(warnings, 'vector3-distance-present', message, details.slice(0, 20));
  }
  return { count: count, examples: details.slice(0, 20) };
}

function analyzeStaticWorkflowMethods(root, errors, warnings, options) {
  var strict = options && options.strict === true;
  var scriptsRoot = path.join(root, 'Assets', 'Scripts');
  var files = fs.existsSync(scriptsRoot) ? walkFiles(scriptsRoot, { ext: /\.cs$/i }) : [];
  var methodRe = /\bstatic\s+(?:[\w.<>,\[\]?]+\s+)+((?:Init|Get|Return|ReturnAfter))\s*\(/g;
  var details = [];
  files.forEach(function(file) {
    var rel = relative(root, file);
    var text = stripComments(readTextIfExists(file));
    var match;
    while ((match = methodRe.exec(text))) {
      details.push({ file: rel, line: countSubstringLine(text, match.index), method: match[1] });
    }
  });
  if (details.length > 0) {
    var message = 'Delivery scripts contain static Init/Get/Return workflow methods; scene-mounted instances should own workflow APIs: ' + details.length;
    if (strict) addIssue(errors, 'static-workflow-methods', message, details.slice(0, 20));
    else addIssue(warnings, 'static-workflow-methods-present', message, details.slice(0, 20));
  }
  return { count: details.length, examples: details.slice(0, 20) };
}

function firstCSharpClassName(text) {
  var match = /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(String(text || ''));
  return match ? match[1] : '';
}

function analyzeSceneSingletonContracts(root, errors, warnings, options) {
  var strict = options && options.strict === true;
  var scriptsRoot = path.join(root, 'Assets', 'Scripts');
  var files = fs.existsSync(scriptsRoot) ? walkFiles(scriptsRoot, { ext: /\.cs$/i }) : [];
  var details = [];
  files.forEach(function(file) {
    var rel = relative(root, file);
    var text = stripComments(readTextIfExists(file));
    var className = firstCSharpClassName(text);
    if (!className) return;
    var esc = escapeRegExp(className);
    var declaresInstance = new RegExp('\\b(?:public|protected|internal|private|new|static|\\s)+\\s*' + esc + '\\s+instance\\b').test(text);
    if (!declaresInstance) return;

    var publicField = new RegExp('\\bpublic\\s+(?:(?:new|static)\\s+)+' + esc + '\\s+instance\\s*;').test(text);
    var autoProperty = new RegExp('\\bpublic\\s+(?:(?:new|static)\\s+)+' + esc + '\\s+instance\\s*\\{\\s*get\\s*;').test(text);
    var hasMInstance = new RegExp('\\bprivate\\s+static\\s+' + esc + '\\s+mInstance\\s*;').test(text);
    var hasGetter = new RegExp('\\bpublic\\s+(?:(?:new|static)\\s+)+' + esc + '\\s+instance\\s*\\{[\\s\\S]*?get\\s*\\{[\\s\\S]*?return\\s+mInstance\\s*;[\\s\\S]*?\\}').test(text);
    var registersSceneInstance = /\bmInstance\s*=\s*this\s*;/.test(text);
    if (publicField || autoProperty || !hasMInstance || !hasGetter || !registersSceneInstance) {
      details.push({ file: rel, className: className });
    }
  });
  if (details.length > 0) {
    var message = 'Scene singleton instances must use private mInstance, read-only instance getter, and Awake registration: ' + details.length;
    if (strict) addIssue(errors, 'scene-singleton-contract', message, details.slice(0, 20));
    else addIssue(warnings, 'scene-singleton-contract-present', message, details.slice(0, 20));
  }
  return { count: details.length, examples: details.slice(0, 20) };
}

function projectUsesPlayerForms(root, playerFile) {
  var scriptsRoot = path.join(root, 'Assets', 'Scripts');
  var files = fs.existsSync(scriptsRoot) ? walkFiles(scriptsRoot, { ext: /\.cs$/i }) : [];
  for (var i = 0; i < files.length; i++) {
    if (files[i] === playerFile) continue;
    var text = stripComments(readTextIfExists(files[i]));
    if (/\bGMP_Player\.instance\s*\.\s*SwitchForm\s*\(/.test(text)) return true;
    if (/\bGMP_Player\.instance\s*\.\s*Forms\b|\b\.Forms\s*=|\bCurrentFormIndex\b|\bGetCollect(?:Power|Range)\s*\(|\bGetCarryCapacity\s*\(/.test(text)) return true;
  }
  return false;
}

function analyzeDuplicateStateOwners(root, errors, warnings, options) {
  var strict = options && options.strict === true;
  var scriptsRoot = path.join(root, 'Assets', 'Scripts');
  var details = [];
  function push(file, concept, message) {
    details.push({ file: file, concept: concept, message: message });
  }

  var playerFile = path.join(scriptsRoot, 'Game', 'Player', 'GMP_Player.cs');
  var playerText = stripComments(readTextIfExists(playerFile));
  if (playerText) {
    var hasFormState = /\bstruct\s+FormDef\b|\bFormDef\[\]\s+Forms\b|\bmCurrentFormIndex\b|\bmFormObjects\b/.test(playerText);
    if (hasFormState && !projectUsesPlayerForms(root, playerFile)) {
      push(relative(root, playerFile), 'player-speed', 'GMP_Player keeps FormDef/Forms/form-index speed state, but no project code uses player form switching');
    }
  }

  var playerBaseFile = path.join(scriptsRoot, 'Core', 'Base', 'GMP_PlayerBase.cs');
  var playerBaseText = stripComments(readTextIfExists(playerBaseFile));
  if (/\bmMoveSpeed\b|\bMoveByDirection\s*\(/.test(playerBaseText)) {
    push(relative(root, playerBaseFile), 'player-speed', 'GMP_PlayerBase owns player movement speed or movement API; concrete Player should own the single movement tuning value');
  }

  var movementFile = path.join(scriptsRoot, 'Core', 'Components', 'GMP_MovementComponent.cs');
  var movementText = stripComments(readTextIfExists(movementFile));
  if (/\bmDefaultSpeed\b|\bDefaultSpeed\b/.test(movementText)) {
    push(relative(root, movementFile), 'player-speed', 'GMP_MovementComponent owns a default speed; movement helper should use the caller-supplied speed only');
  }

  var economyFile = path.join(scriptsRoot, 'Core', 'Modules', 'GMP_EconomyManager.cs');
  var economyText = stripComments(readTextIfExists(economyFile));
  if (/\bmGold\b/.test(economyText) && /\bmInvVals\b/.test(economyText)) {
    push(relative(root, economyFile), 'resource-gold', 'Gold is mirrored in mGold and inventory arrays; keep one resource store and derive Gold from it');
  }

  var targetHintOwners = [];
  [
    ['Core/Modules/GMP_UIManager.cs', /\bmTargetHintText\b|\bSetTargetHint\s*\(/],
    ['Core/Modules/GMP_HudController.cs', /\bmTargetHintText\b|\bSetTargetHint\s*\(/],
    ['Game/Level/GMP_LevelRuleEngine.cs', /\bmTargetHintText\b|\bSetTargetHintTextDirect\s*\(/]
  ].forEach(function(item) {
    var file = path.join(scriptsRoot, item[0]);
    var text = stripComments(readTextIfExists(file));
    if (item[1].test(text)) targetHintOwners.push('Assets/Scripts/' + item[0]);
  });
  if (targetHintOwners.length > 1 || targetHintOwners.some(function(file) { return /GMP_UIManager|GMP_LevelRuleEngine/.test(file); })) {
    targetHintOwners.forEach(function(file) {
      push(file, 'target-hint', 'Target hint text should have one owner; HudController owns the text, LevelRuleEngine should only pass target data');
    });
  }

  if (details.length > 0) {
    var message = 'Delivery scripts keep multiple owners for the same gameplay state/tuning concept: ' + details.length;
    if (strict) addIssue(errors, 'duplicate-state-owners', message, details.slice(0, 30));
    else addIssue(warnings, 'duplicate-state-owners-present', message, details.slice(0, 30));
  }
  return { count: details.length, examples: details.slice(0, 30) };
}

function collectScriptTextByFile(root) {
  var scriptsRoot = path.join(root, 'Assets', 'Scripts');
  var files = fs.existsSync(scriptsRoot) ? walkFiles(scriptsRoot, { ext: /\.cs$/i }) : [];
  return files.map(function(file) {
    return {
      file: file,
      rel: relative(root, file),
      text: readTextIfExists(file),
      code: stripComments(readTextIfExists(file))
    };
  });
}

function analyzeComponentCohesion(root, errors, warnings, options) {
  var strict = options && options.strict === true;
  var scripts = collectScriptTextByFile(root);
  var allCode = scripts.map(function(item) { return item.code; }).join('\n');
  var componentFiles = [];
  var decorative = [];
  var unused = [];
  var lifecycleNames = {
    OnAwake: true,
    OnEnable: true,
    OnStart: true,
    OnUpdate: true,
    OnDisable: true,
    OnDestroy: true
  };
  var methodRe = /\b(?:public|protected|internal)\s+(?:virtual\s+|override\s+)?(?:[\w.<>,\[\]?]+\s+)+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;

  scripts.forEach(function(item) {
    if (!/\bclass\s+GMP_[A-Za-z0-9_]*Component\s*:\s*GMP_BaseComponent\b/.test(item.code)) return;
    var classMatch = /\bclass\s+(GMP_[A-Za-z0-9_]*Component)\b/.exec(item.code);
    if (!classMatch || classMatch[1] === 'GMP_BaseComponent') return;
    var className = classMatch[1];
    componentFiles.push({ file: item.rel, className: className });

    var semanticMethods = [];
    var match;
    while ((match = methodRe.exec(item.code))) {
      if (!lifecycleNames[match[1]]) semanticMethods.push(match[1]);
    }
    var hasLifecycleOverride = /\boverride\s+void\s+On(?:Awake|Enable|Start|Update|Disable|Destroy)\s*\(/.test(item.code);
    if (semanticMethods.length === 0 && !hasLifecycleOverride) {
      decorative.push({ file: item.rel, className: className });
    }

    var codeOutsideOwnFile = scripts.filter(function(other) {
      return other.rel !== item.rel;
    }).map(function(other) {
      return other.code;
    }).join('\n');
    var typeUse = new RegExp('\\b' + escapeRegExp(className) + '\\b').test(codeOutsideOwnFile);
    var ecsUse = new RegExp('\\b(?:GetEcsComponent|GetFirstEcsComponent|HasEcsComponent)\\s*<\\s*' + escapeRegExp(className) + '\\s*>').test(allCode);
    var variableCall = new RegExp('\\b[A-Za-z_][A-Za-z0-9_]*\\s*\\.\\s*(?:' + semanticMethods.map(escapeRegExp).join('|') + ')\\s*\\(').test(codeOutsideOwnFile);
    if (!typeUse && !ecsUse && !variableCall) {
      unused.push({ file: item.rel, className: className });
    }
  });

  if (decorative.length > 0) {
    var decorativeMessage = 'GMP_BaseComponent subclasses must own real capability behavior or lifecycle work; decorative component shells add framework complexity: ' + decorative.length;
    if (strict) addIssue(errors, 'decorative-component-files', decorativeMessage, decorative.slice(0, 20));
    else addIssue(warnings, 'decorative-component-files-present', decorativeMessage, decorative.slice(0, 20));
  }
  if (unused.length > 0) {
    var unusedMessage = 'Core/Components contains capability files that no current code uses; do not add optional framework components just for appearance: ' + unused.length;
    if (strict) addIssue(errors, 'unused-component-files', unusedMessage, unused.slice(0, 20));
    else addIssue(warnings, 'unused-component-files-present', unusedMessage, unused.slice(0, 20));
  }
  return {
    componentFileCount: componentFiles.length,
    decorativeComponentCount: decorative.length,
    unusedComponentFileCount: unused.length,
    decorativeExamples: decorative.slice(0, 20),
    unusedExamples: unused.slice(0, 20)
  };
}

function analyzeEntityFrameworkBoundaries(root, errors, warnings, options) {
  var strict = options && options.strict === true;
  var scripts = collectScriptTextByFile(root);
  var baseOverreach = [];
  var forbiddenMembers = [
    { name: 'SetVisible', pattern: /\b(?:public|protected)\s+(?:virtual\s+|override\s+)?void\s+SetVisible\s*\(/ },
    { name: 'SetPosition', pattern: /\b(?:public|protected)\s+(?:virtual\s+|override\s+)?void\s+SetPosition\s*\(/ },
    { name: 'MarkInteracted', pattern: /\b(?:public|protected)\s+(?:virtual\s+|override\s+)?void\s+MarkInteracted\s*\(/ },
    { name: 'MarkCompleted', pattern: /\b(?:public|protected)\s+(?:virtual\s+|override\s+)?void\s+MarkCompleted\s*\(/ },
    { name: 'ResetProgress', pattern: /\b(?:public|protected)\s+(?:virtual\s+|override\s+)?void\s+ResetProgress\s*\(/ },
    { name: 'MoveToInitialPosition', pattern: /\b(?:public|protected)\s+(?:virtual\s+|override\s+)?void\s+MoveToInitialPosition\s*\(/ },
    { name: 'MoveToPosition', pattern: /\b(?:public|protected)\s+(?:virtual\s+|override\s+)?void\s+MoveToPosition\s*\(/ },
    { name: 'InteractionCount', pattern: /\b(?:public|protected)\s+int\s+InteractionCount\b/ },
    { name: 'IsCompleted', pattern: /\b(?:public|protected)\s+bool\s+IsCompleted\b/ }
  ];

  scripts.forEach(function(item) {
    if (!/(^|\/)(?:GMP_)?BaseGameFlowEntity\.cs$/.test(item.rel)) return;
    forbiddenMembers.forEach(function(rule) {
      if (rule.pattern.test(item.code)) baseOverreach.push({ file: item.rel, member: rule.name });
    });
  });
  if (baseOverreach.length > 0) {
    var message = 'BaseGameFlowEntity should only own identity, scene binding and ECS lifecycle; movement, visibility and progress state belong to components, SceneEntityRefs or Game/Level rules: ' + baseOverreach.length;
    if (strict) addIssue(errors, 'entity-base-overreach', message, baseOverreach.slice(0, 30));
    else addIssue(warnings, 'entity-base-overreach-present', message, baseOverreach.slice(0, 30));
  }

  var sceneRefs = scripts.filter(function(item) {
    return /(^|\/)GMP_SceneEntityRefs\.cs$/.test(item.rel);
  })[0] || null;
  var spawnMethodCount = 0;
  var fieldCount = 0;
  var transientFieldCount = 0;
  var transientExamples = [];
  if (sceneRefs) {
    spawnMethodCount = (sceneRefs.code.match(/\bpublic\s+void\s+Spawn\s*\(/g) || []).length;
    var fieldRe = /\bpublic\s+GMP_SceneEntityRef\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/g;
    var match;
    while ((match = fieldRe.exec(sceneRefs.code))) {
      fieldCount++;
      if (/(?:Bullet|Projectile|Coin|Gold|Drop|Drops|Loot|Fx|Effect|Vfx|Gem|Collectible)/.test(match[1])) {
        transientFieldCount++;
        if (transientExamples.length < 20) transientExamples.push(match[1]);
      }
    }
  }
  if (spawnMethodCount > 0) {
    var spawnMessage = 'GMP_SceneEntityRefs must not expose Spawn for transient objects; use Show/Hide for baked scene refs and GMP_Pool for bullets, coins, drops and effects';
    if (strict) addIssue(errors, 'scene-entity-refs-spawn-api', spawnMessage, [{ file: sceneRefs.rel, count: spawnMethodCount }]);
    else addIssue(warnings, 'scene-entity-refs-spawn-api-present', spawnMessage, [{ file: sceneRefs.rel, count: spawnMethodCount }]);
  }
  if (fieldCount > 80 && transientFieldCount > 12) {
    addIssue(errors, 'scene-entity-refs-transient-overuse', 'GMP_SceneEntityRefs appears to enumerate many repeated transient gameplay objects; use GMP_Pool prefab/pool APIs instead of one serialized ref per bullet/coin/drop', {
      file: sceneRefs.rel,
      fieldCount: fieldCount,
      transientFieldCount: transientFieldCount,
      examples: transientExamples
    });
  }

  return {
    baseEntityOverreachCount: baseOverreach.length,
    baseEntityOverreachExamples: baseOverreach.slice(0, 30),
    sceneEntityRefsSpawnMethodCount: spawnMethodCount,
    sceneEntityRefsFieldCount: fieldCount,
    sceneEntityRefsTransientFieldCount: transientFieldCount,
    sceneEntityRefsTransientExamples: transientExamples
  };
}

function analyzeDocs(root, errors, warnings, layout) {
  var docs = ['README.md', 'PROGRAMMER_HANDOFF.md', 'CODE_RELATION_GRAPH.md'];
  var stale = [
    { code: 'doc-check-event-rules', pattern: /\bCheckEventRules\b/, label: 'CheckEventRules' },
    { code: 'doc-gfm-player', pattern: /\bGFM_Player\b/, label: 'GFM_Player' },
    { code: 'doc-phase-on-tap', pattern: /\bPhase_(?:[A-Za-z0-9_]+_)?OnTap\b|\bPhase_OnTap\b/, label: 'Phase_*_OnTap' },
    { code: 'doc-generated-slot-runner', pattern: /\bRunGeneratedAssemblySlotRunners\b/, label: 'RunGeneratedAssemblySlotRunners' }
  ];
  var hits = [];
  var v14Hits = [];
  docs.forEach(function(name) {
    var file = path.join(root, name);
    if (!fs.existsSync(file)) return;
    var text = readTextIfExists(file);
    stale.forEach(function(rule) {
      if (rule.pattern.test(text)) hits.push({ file: name, token: rule.label });
    });
    if (/\bv14\b/i.test(text)) v14Hits.push(name);
  });
  if (layout && hits.length) {
    addIssue(errors, 'stale-v14-delivery-docs', 'Blueprint 2.0 delivery docs still describe old runtime names', hits);
  }
  if (layout && v14Hits.length) {
    addIssue(warnings, 'stale-v14-label', 'Delivery docs should say Blueprint 2.0/Core-Tool-Game instead of v14', v14Hits);
  }
  if (layout) {
    var docsText = docs.map(function(name) {
      var file = path.join(root, name);
      return fs.existsSync(file) ? readTextIfExists(file) : '';
    }).join('\n');
    var missingFlowGuide = [];
    [
      { token: '流程增删改指南', label: '流程增删改指南章节' },
      { token: '修改流程', label: '修改流程说明' },
      { token: '删除流程', label: '删除流程说明' },
      { token: '增加流程', label: '增加流程说明' },
      { token: '例子', label: '流程修改例子' }
    ].forEach(function(rule) {
      if (docsText.indexOf(rule.token) < 0) missingFlowGuide.push(rule.label);
    });
    if (missingFlowGuide.length) {
      addIssue(errors, 'flow-edit-guide-missing', 'Delivery docs must explain how to modify, delete, and add flow nodes with an example', missingFlowGuide);
    }
  }
  if (layout) {
    var scriptFiles = fs.existsSync(path.join(root, 'Assets', 'Scripts'))
      ? walkFiles(path.join(root, 'Assets', 'Scripts'), { ext: /\.cs$/i })
      : [];
    var byRel = Object.create(null);
    var byName = Object.create(null);
    scriptFiles.forEach(function(file) {
      var rel = relative(root, file);
      byRel[rel] = true;
      byRel[rel.replace(/^Assets\/Scripts\//, '')] = true;
      byName[path.basename(file)] = true;
    });
    var missingRefs = [];
    docs.forEach(function(name) {
      var file = path.join(root, name);
      if (!fs.existsSync(file)) return;
      var text = readTextIfExists(file);
      var refs = [];
      text.replace(/`([^`\n\r]*?\.cs)`/g, function(_, ref) {
        refs.push(ref);
        return _;
      });
      text.replace(/\b((?:Assets\/Scripts\/)?(?:Core|Tool|Game)\/[A-Za-z0-9_./-]+\.cs)\b/g, function(_, ref) {
        refs.push(ref);
        return _;
      });
      refs.forEach(function(ref) {
        var normalized = String(ref || '').replace(/\\/g, '/').replace(/^\.\//, '');
        if (!normalized || /[*?<>]/.test(normalized)) return;
        var exists = normalized.indexOf('/') >= 0
          ? !!byRel[normalized.replace(/^\/+/, '')]
          : !!byName[normalized];
        if (!exists) missingRefs.push({ file: name, reference: normalized });
      });
    });
    if (missingRefs.length) {
      addIssue(errors, 'doc-script-reference-missing', 'Delivery docs reference C# files that do not exist', missingRefs.slice(0, 30));
    }
  }
  var handoff = path.join(root, 'PROGRAMMER_HANDOFF.md');
  if (layout && fs.existsSync(handoff)) {
    var handoffText = readTextIfExists(handoff);
    var match = /-\s+GMP_MainManager\.cs 行数：([0-9]+)/.exec(handoffText);
    var mainFile = path.join(root, 'Assets', 'Scripts', 'Core', 'Modules', 'GMP_MainManager.cs');
    if (match && !fs.existsSync(mainFile)) {
      addIssue(errors, 'handoff-main-line-count-missing-file', 'PROGRAMMER_HANDOFF.md reports GMP_MainManager.cs line count but the source file is missing');
    } else if (match && fs.existsSync(mainFile)) {
      var expected = countLines(readTextIfExists(mainFile));
      var found = Number(match[1]) || 0;
      if (expected !== found) {
        addIssue(errors, 'handoff-main-line-count-stale', 'PROGRAMMER_HANDOFF.md has stale GMP_MainManager.cs line count: ' + found + ', actual ' + expected);
      }
    }
  }
  return { staleHits: hits, v14LabelFiles: v14Hits };
}

function sourceSnapshotText(root) {
  var files = [
    'source-scene-ir.json',
    'source-ir.json',
    'asset-manifest.json',
    'source-ir-preview.html'
  ];
  var parts = [];
  files.forEach(function(name) {
    var file = path.join(root, name);
    if (!fs.existsSync(file)) return;
    var stat = fs.statSync(file);
    if (stat.size > 6 * 1024 * 1024) return;
    parts.push(readTextIfExists(file));
  });
  return parts.join('\n');
}

function tokenGroupAllowed(sourceText, group) {
  var lower = sourceText.toLowerCase();
  for (var i = 0; i < group.tokens.length; i++) {
    var token = group.tokens[i];
    if (!token) continue;
    if (lower.indexOf(String(token).toLowerCase()) >= 0) return true;
  }
  return false;
}

function analyzeLegacyProjectLeakage(root, errors) {
  var sourceText = sourceSnapshotText(root);
  if (!sourceText) return { checked: false, leakedGroups: [] };
  var groups = [
    { id: 'legacy-oxygen', tokens: ['oxygenShop', 'Oxygen', 'oxygen', '氧气'] },
    { id: 'legacy-spaceship', tokens: ['spaceShip', 'SpaceShip', 'spaceship', '飞船'] },
    { id: 'legacy-space-entities', tokens: ['shipCargo', 'baseOne', 'drillPad', 'gunPad'] }
  ];
  var scanRoots = [
    path.join(root, 'Assets', 'Scripts'),
    path.join(root, 'Assets', 'Scenes')
  ];
  var docFiles = ['README.md', 'PROGRAMMER_HANDOFF.md', 'CODE_RELATION_GRAPH.md'];
  var files = [];
  scanRoots.forEach(function(scanRoot) {
    if (fs.existsSync(scanRoot)) files = files.concat(walkFiles(scanRoot, { ext: /\.(cs|asset|unity)$/i }));
  });
  docFiles.forEach(function(name) {
    var file = path.join(root, name);
    if (fs.existsSync(file)) files.push(file);
  });

  var leakedGroups = [];
  groups.forEach(function(group) {
    if (tokenGroupAllowed(sourceText, group)) return;
    var hits = [];
    for (var i = 0; i < files.length; i++) {
      var text = readTextIfExists(files[i]);
      for (var j = 0; j < group.tokens.length; j++) {
        var token = group.tokens[j];
        if (!token || text.indexOf(token) < 0) continue;
        hits.push({ file: relative(root, files[i]), token: token });
        break;
      }
      if (hits.length >= 20) break;
    }
    if (hits.length) leakedGroups.push({ group: group.id, hits: hits });
  });
  if (leakedGroups.length) {
    addIssue(errors, 'legacy-project-token-leakage', 'Delivery contains legacy project tokens absent from source-scene-ir/source-ir', leakedGroups);
  }
  return { checked: true, leakedGroups: leakedGroups };
}

function validateMaintainability(root, options) {
  options = options || {};
  root = path.resolve(root);
  var errors = [];
  var warnings = [];
  var layout = isV14Layout(root);
  var entitySummary = analyzeEntityClasses(root, errors, warnings);
  var dynamicBindingSummary = analyzeDynamicSceneBinding(root, errors, warnings, options);
  var dynamicUiSummary = analyzeDynamicUiCreation(root, errors, warnings, options);
  var branchSummary = analyzeEntityNameBranches(root, errors, warnings, options);
  var distanceSummary = analyzeDistanceChecks(root, errors, warnings, options);
  var staticWorkflowSummary = analyzeStaticWorkflowMethods(root, errors, warnings, options);
  var sceneSingletonSummary = analyzeSceneSingletonContracts(root, errors, warnings, options);
  var duplicateStateSummary = analyzeDuplicateStateOwners(root, errors, warnings, options);
  var componentCohesionSummary = analyzeComponentCohesion(root, errors, warnings, options);
  var frameworkBoundarySummary = analyzeEntityFrameworkBoundaries(root, errors, warnings, options);
  var docsSummary = analyzeDocs(root, errors, warnings, layout);
  var leakageSummary = analyzeLegacyProjectLeakage(root, errors);
  var unusedMethodSummary = analyzeUnusedMethods(root, errors, warnings, options);

  return {
    kind: KIND,
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    root: root,
    passed: errors.length === 0,
    errors: errors,
    warnings: warnings,
    summary: {
      hasCoreToolGameLayout: layout,
      entityClassCount: entitySummary.total,
      thinEntityClassCount: entitySummary.thin,
      gameObjectFindCount: dynamicBindingSummary.count,
      gameObjectFindGameLayerCount: dynamicBindingSummary.gameCount,
      gameObjectFindFileCount: dynamicBindingSummary.files,
      addComponentCount: dynamicBindingSummary.addComponentCount,
      addComponentGameLayerCount: dynamicBindingSummary.addComponentGameCount,
      addComponentFileCount: dynamicBindingSummary.addComponentFileCount,
      newGameObjectCount: dynamicBindingSummary.newGameObjectCount,
      newGameObjectGameLayerCount: dynamicBindingSummary.newGameObjectGameCount,
      newGameObjectFileCount: dynamicBindingSummary.newGameObjectFileCount,
      dynamicUiCreationCount: dynamicUiSummary.count,
      dynamicUiCreationFileCount: dynamicUiSummary.files,
      entityNameBranchCount: branchSummary.count,
      coreEntityNameBranchCount: branchSummary.coreCount,
      vector3DistanceCount: distanceSummary.count,
      staticWorkflowMethodCount: staticWorkflowSummary.count,
      sceneSingletonContractIssueCount: sceneSingletonSummary.count,
      sceneSingletonContractExamples: sceneSingletonSummary.examples,
      duplicateStateOwnerCount: duplicateStateSummary.count,
      duplicateStateOwnerExamples: duplicateStateSummary.examples,
      componentFileCount: componentCohesionSummary.componentFileCount,
      decorativeComponentCount: componentCohesionSummary.decorativeComponentCount,
      unusedComponentFileCount: componentCohesionSummary.unusedComponentFileCount,
      decorativeComponentExamples: componentCohesionSummary.decorativeExamples,
      unusedComponentFileExamples: componentCohesionSummary.unusedExamples,
      baseEntityOverreachCount: frameworkBoundarySummary.baseEntityOverreachCount,
      baseEntityOverreachExamples: frameworkBoundarySummary.baseEntityOverreachExamples,
      sceneEntityRefsSpawnMethodCount: frameworkBoundarySummary.sceneEntityRefsSpawnMethodCount,
      sceneEntityRefsFieldCount: frameworkBoundarySummary.sceneEntityRefsFieldCount,
      sceneEntityRefsTransientFieldCount: frameworkBoundarySummary.sceneEntityRefsTransientFieldCount,
      sceneEntityRefsTransientExamples: frameworkBoundarySummary.sceneEntityRefsTransientExamples,
      staleDocHitCount: docsSummary.staleHits.length,
      staleV14LabelFileCount: docsSummary.v14LabelFiles.length,
      legacyLeakageChecked: leakageSummary.checked,
      legacyProjectLeakGroupCount: leakageSummary.leakedGroups.length,
      unusedMethodCount: unusedMethodSummary.count,
      methodDefinitionCount: unusedMethodSummary.methodDefinitionCount,
      unusedMethodExamples: unusedMethodSummary.examples.slice(0, 20).map(function(item) {
        return { file: item.file, line: item.line, method: item.name };
      })
    }
  };
}

function writeMaintainabilityReport(root, outPath, options) {
  var report = validateMaintainability(root, options || {});
  var target = outPath || path.join(path.resolve(root), 'PROGRAMMER_MAINTAINABILITY_REPORT.json');
  fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n');
  return report;
}

function usage() {
  console.error('Usage: node lib/programmer-delivery-maintainability-gate.cjs <delivery-root> [--out report.json] [--strict]');
  process.exit(2);
}

if (require.main === module) {
  var root = process.argv[2];
  var outPath = null;
  var strict = false;
  for (var i = 3; i < process.argv.length; i++) {
    if (process.argv[i] === '--out') outPath = process.argv[++i] || null;
    else if (process.argv[i] === '--strict') strict = true;
    else usage();
  }
  if (!root) usage();
  try {
    var result = writeMaintainabilityReport(root, outPath, { strict: strict });
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
  validateMaintainability: validateMaintainability,
  writeMaintainabilityReport: writeMaintainabilityReport
};
