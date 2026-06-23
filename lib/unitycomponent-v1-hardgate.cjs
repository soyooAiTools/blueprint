#!/usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var profiles = require('./unitycomponent-profile-registry.cjs');
var projector = require('./unity-delivery-spec-projector.cjs');

var KIND = 'blueprint.unityComponentV1Validation';
var SCHEMA_VERSION = 1;
var FRAMEWORK_MANIFEST_KIND = 'blueprint.unityComponentV1FrameworkTemplateManifest';
var SLG_SCRIPT_ROOT = 'Assets/SLGFrameWork/Scripts';
var GAMEENTRY_PREFAB = SLG_SCRIPT_ROOT + '/Prefab/GameEntry.prefab';
var FRAMEWORK_CORE_FILES = [
  SLG_SCRIPT_ROOT + '/Base/BaseComponent.cs',
  SLG_SCRIPT_ROOT + '/Base/Entity.cs',
  SLG_SCRIPT_ROOT + '/Base/GameEntry.cs',
  SLG_SCRIPT_ROOT + '/Manager/EntityManager.cs',
  SLG_SCRIPT_ROOT + '/Manager/Event/EventManager.cs',
  SLG_SCRIPT_ROOT + '/Manager/Event/EventPool.cs',
  SLG_SCRIPT_ROOT + '/Manager/Event/GameEventArgs.cs',
  SLG_SCRIPT_ROOT + '/Manager/Event/EventArgs/ScreenChangeEvent.cs',
  SLG_SCRIPT_ROOT + '/Component/ObjectPoolComponent/ObjectPoolComponent.cs',
  SLG_SCRIPT_ROOT + '/Manager/BlueprintDelivery/BlueprintPlayableManager.cs'
];
var CORE_COMPONENTS = {
  BaseComponent: true,
  ObjectPoolComponent: true
};

function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

function unityGuidForRel(relPath) {
  return crypto.createHash('sha1').update('unitycomponent-v1-meta:' + relPath.split(path.sep).join('/')).digest('hex').slice(0, 32);
}

function scriptClassName(relPath) {
  return path.basename(String(relPath || ''), '.cs');
}

function readText(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonIfExists(filePath) {
  return fs.existsSync(filePath) ? readJson(filePath) : null;
}

function rel(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

function walkFiles(root) {
  var out = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir).forEach(function(name) {
      var file = path.join(dir, name);
      var stat = fs.statSync(file);
      if (stat.isDirectory()) walk(file);
      else out.push(file);
    });
  }
  walk(root);
  return out;
}

function stripComments(text) {
  return String(text || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n\r]*/g, '');
}

function issue(id, message, details) {
  return { id: id, message: message, details: details || null };
}

function add(errors, id, message, details) {
  errors.push(issue(id, message, details));
}

function collectCs(root) {
  var scripts = path.join(root, 'Assets', 'SLGFrameWork', 'Scripts');
  return walkFiles(scripts).filter(function(file) { return /\.cs$/i.test(file); }).map(function(file) {
    var text = readText(file);
    return { file: file, rel: rel(root, file), text: text, code: stripComments(text) };
  });
}

function layerForRel(file) {
  var match = /^Assets\/SLGFrameWork\/Scripts\/(Base|Component|Entity|Manager|Prefab)\//.exec(file);
  return match ? match[1] : '';
}

function componentName(name) {
  return name === 'PickupComponent' ? 'PickUpComponent' : name;
}

function validateLayerDirs(root, errors) {
  ['Base', 'Component', 'Entity', 'Manager', 'Prefab'].forEach(function(layer) {
    if (!fs.existsSync(path.join(root, 'Assets', 'SLGFrameWork', 'Scripts', layer))) {
      add(errors, 'slgframework-layer-missing', 'unitycomponent-v1 requires ' + SLG_SCRIPT_ROOT + '/' + layer, { layer: layer });
    }
  });
  if (fs.existsSync(path.join(root, 'Assets', 'Scripts', 'Base'))) {
    add(errors, 'old-v1-layout-present', 'unitycomponent-v1 must use Assets/SLGFrameWork/Scripts, not the old Assets/Scripts/Base layout');
  }
  if (fs.existsSync(path.join(root, 'Assets', 'Prefabs', 'GameEntry.prefab'))) {
    add(errors, 'old-gameentry-prefab-path', 'unitycomponent-v1 must use ' + GAMEENTRY_PREFAB + ', not Assets/Prefabs/GameEntry.prefab');
  }
}

function validateNoOldNamespaceOrAsmdef(root, errors, scripts) {
  var oldNamespace = [];
  scripts.forEach(function(item) {
    if (/namespace\s+Blueprint\.UnityComponent\b/.test(item.code)) oldNamespace.push(item.rel);
  });
  if (oldNamespace.length) {
    add(errors, 'old-v1-namespace-present', 'UnityComponent(3)/SLGFrameWork scripts must not use the old Blueprint.UnityComponent namespace', oldNamespace.slice(0, 30));
  }
  var asmdefs = walkFiles(path.join(root, 'Assets')).filter(function(file) { return /\.asmdef$/i.test(file); }).map(function(file) { return rel(root, file); });
  if (asmdefs.length) {
    add(errors, 'asmdef-present', 'UnityComponent(3) reference package does not require v1 asmdef layering; remove old generated asmdefs', asmdefs.slice(0, 30));
  }
}

function validateFrameworkTemplateManifest(root, errors) {
  var manifestPath = path.join(root, 'Assets', 'BlueprintDelivery', 'FrameworkTemplateManifest.json');
  var manifest = readJsonIfExists(manifestPath);
  if (!manifest) {
    add(errors, 'framework-template-manifest-missing', 'FrameworkTemplateManifest.json is required to prove SLGFrameWork template-owned files');
    return;
  }
  if (manifest.kind !== FRAMEWORK_MANIFEST_KIND || manifest.profile !== 'unitycomponent-v1' || manifest.scriptRoot !== SLG_SCRIPT_ROOT || !Array.isArray(manifest.files)) {
    add(errors, 'framework-template-manifest-invalid', 'FrameworkTemplateManifest.json must identify the unitycomponent-v1 SLGFrameWork template', {
      kind: manifest.kind,
      profile: manifest.profile,
      scriptRoot: manifest.scriptRoot
    });
    return;
  }
  manifest.files.forEach(function(entry) {
    var relPath = entry && entry.path;
    var filePath = relPath ? path.join(root, relPath) : '';
    if (!relPath || !fs.existsSync(filePath)) {
      add(errors, 'framework-template-file-missing', 'Template-owned framework file listed in manifest is missing', entry);
      return;
    }
    var actual = sha256Text(readText(filePath));
    if (actual !== entry.sha256) {
      add(errors, 'framework-template-file-modified', 'Template-owned framework file hash differs from manifest', {
        file: relPath,
        expected: entry.sha256,
        actual: actual
      });
    }
  });
  FRAMEWORK_CORE_FILES.forEach(function(relPath) {
    var found = manifest.files.some(function(entry) { return entry && entry.path === relPath; });
    if (!found) add(errors, 'framework-template-core-file-unlisted', 'Core SLGFrameWork file must be listed as template-owned', { file: relPath });
  });
}

function validateForbiddenIdentifiers(root, errors, profile) {
  var hits = [];
  walkFiles(path.join(root, 'Assets')).forEach(function(file) {
    if (!/\.(cs|json|asset|prefab|unity)$/i.test(file)) return;
    var text = readText(file);
    (profile.forbiddenIdentifiers || []).forEach(function(token) {
      if (text.indexOf(token) >= 0) hits.push({ file: rel(root, file), token: token });
    });
  });
  if (hits.length) {
    add(errors, 'forbidden-identifier', 'unitycomponent-v1 output contains legacy/forbidden identifiers', hits.slice(0, 30));
  }
}

function validateScriptRoots(errors, scripts) {
  var invalidRoot = [];
  scripts.forEach(function(item) {
    if (!layerForRel(item.rel)) invalidRoot.push(item.rel);
  });
  if (invalidRoot.length) {
    add(errors, 'script-outside-slgframework-layer', 'C# files must live under Assets/SLGFrameWork/Scripts/{Base,Component,Entity,Manager,Prefab}', invalidRoot.slice(0, 30));
  }
}

function hasNonEmptyMethod(code, methodPattern) {
  var re = new RegExp(methodPattern + '\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\}', 'g');
  var match;
  while ((match = re.exec(code))) {
    var body = String(match[1] || '').trim();
    if (body && body !== ';') return true;
  }
  return false;
}

function componentHasCapability(code, className) {
  var hasState = /\b(?:public|private|protected)\s+(?:readonly\s+)?(?:float|int|bool|string|Vector2|Vector3|Dictionary\s*<|List\s*<|HashSet\s*<|Queue\s*<|Action\s*<|Action\b)[^;=]*[;=]/.test(code) ||
    /\b(?:public|private|protected)\s+[A-Za-z_][A-Za-z0-9_<>,\s]*\s+[A-Za-z_][A-Za-z0-9_]*\s*\{\s*get\s*;/.test(code);
  var hasSemanticApi = hasNonEmptyMethod(code, '\\bpublic\\s+(?!override\\b)(?:void|bool|int|float|string|Vector2|Vector3|GameObject|Entity)\\s+(?!On(?:Awake|Enable|Start|Update|Disable|Destroy)\\b)[A-Za-z_][A-Za-z0-9_]*');
  var hasLifecycleWork = hasNonEmptyMethod(code, '\\bpublic\\s+override\\s+void\\s+On(?:Awake|Enable|Start|Update|Disable|Destroy)');
  if (!hasState || (!hasSemanticApi && !hasLifecycleWork)) {
    return {
      className: className,
      hasState: hasState,
      hasSemanticApi: hasSemanticApi,
      hasLifecycleWork: hasLifecycleWork
    };
  }
  return null;
}

function validateEntitiesAndComponents(errors, scripts, spec) {
  var entityScripts = [];
  var invalidComponents = [];
  var defaultComponentLeaks = [];
  var componentWithoutEvidence = [];
  var decorativeComponents = [];
  var selectedComponents = {};
  var componentsByEntity = {};
  ((spec && spec.components) || []).forEach(function(item) {
    var name = componentName(item.component);
    selectedComponents[name] = true;
    if (!componentsByEntity[item.entityId]) componentsByEntity[item.entityId] = [];
    componentsByEntity[item.entityId].push(name);
  });
  var entityClasses = {};
  var componentClasses = {};
  scripts.forEach(function(item) {
    var layer = layerForRel(item.rel);
    var code = item.code;
    var entityMatch = /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*Entity\b/.exec(code);
    if (layer === 'Entity' && entityMatch) {
      entityScripts.push(item.rel);
      entityClasses[entityMatch[1]] = item;
    }
    var componentMatch = /\bclass\s+([A-Za-z_][A-Za-z0-9_]*Component)\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\b/.exec(code);
    if (componentMatch) {
      componentClasses[componentMatch[1]] = item;
      if (layer === 'Component') {
        if (componentMatch[1] !== 'ObjectPoolComponent' && componentMatch[2] !== 'BaseComponent') {
          invalidComponents.push({ file: item.rel, className: componentMatch[1], baseClass: componentMatch[2] });
        }
        if (/\bclass\s+[A-Za-z_][A-Za-z0-9_]*Component\s*:\s*MonoBehaviour\b/.test(code)) {
          invalidComponents.push({ file: item.rel, className: componentMatch[1], baseClass: 'MonoBehaviour' });
        }
        if (!/\[Serializable\]|\[System\.Serializable\]/.test(item.text)) {
          invalidComponents.push({ file: item.rel, className: componentMatch[1], missingSerializable: true });
        }
        if (/^(SkillComponent|InventoryComponent|BuildComponent)$/.test(componentMatch[1]) && !selectedComponents[componentMatch[1]]) {
          defaultComponentLeaks.push({ file: item.rel, className: componentMatch[1] });
        }
        if (!CORE_COMPONENTS[componentMatch[1]] && !selectedComponents[componentMatch[1]]) {
          componentWithoutEvidence.push({ file: item.rel, className: componentMatch[1] });
        }
        if (!CORE_COMPONENTS[componentMatch[1]]) {
          var decorative = componentHasCapability(code, componentMatch[1]);
          if (decorative) {
            decorative.file = item.rel;
            decorativeComponents.push(decorative);
          }
        }
      }
    }
  });
  if (entityScripts.length === 0) add(errors, 'entity-class-missing', 'SLGFrameWork output must contain generated Entity subclasses under Scripts/Entity');
  Object.keys(selectedComponents).forEach(function(name) {
    if (!componentClasses[name]) {
      add(errors, 'selected-component-class-missing', 'Every UnityDeliverySpec-selected component must have a matching Scripts/Component class', { component: name });
    }
  });
  ((spec && spec.entities) || []).forEach(function(entity) {
    var script = entityClasses[entity.unityClass];
    if (!script) {
      add(errors, 'entity-class-missing', 'Every UnityDeliverySpec entity must have a Scripts/Entity class inheriting Entity', { entityId: entity.sourceId, unityClass: entity.unityClass });
      return;
    }
    var required = componentsByEntity[entity.sourceId] || [];
    if (required.length && !/\bpublic\s+override\s+void\s+OnAwake\s*\(/.test(script.code)) {
      add(errors, 'component-registration-missing', 'Generated SLGFrameWork entities must register components in public override OnAwake()', {
        entityId: entity.sourceId,
        unityClass: entity.unityClass,
        file: script.rel
      });
    }
    required.forEach(function(component) {
      var fieldPattern = component.replace(/Component$/, '');
      if (script.code.indexOf('AddEcsComponent') < 0 || script.code.indexOf(component) < 0 || script.code.indexOf(fieldPattern) < 0) {
        add(errors, 'component-registration-missing', 'Generated entity must register each component selected by UnityDeliverySpec evidence', {
          entityId: entity.sourceId,
          unityClass: entity.unityClass,
          component: component,
          file: script.rel
        });
      }
    });
  });
  if (invalidComponents.length) {
    add(errors, 'component-contract-invalid', 'Generated capability components must be [Serializable] pure BaseComponent classes and must not inherit MonoBehaviour', invalidComponents.slice(0, 30));
  }
  if (defaultComponentLeaks.length) {
    add(errors, 'default-optional-component-without-evidence', 'Optional components such as Skill/Inventory/Build must not appear without UnityDeliverySpec feature evidence', defaultComponentLeaks);
  }
  if (componentWithoutEvidence.length) {
    add(errors, 'component-without-feature-evidence', 'Generated components must be selected by UnityDeliverySpec feature evidence', componentWithoutEvidence.slice(0, 30));
  }
  if (decorativeComponents.length) {
    add(errors, 'decorative-component-shell', 'Generated capability components must own state plus a non-empty semantic API or lifecycle method', decorativeComponents.slice(0, 30));
  }
}

function validateGameEntry(root, errors, scripts) {
  var prefab = path.join(root, GAMEENTRY_PREFAB);
  if (!fs.existsSync(prefab)) {
    add(errors, 'gameentry-prefab-missing', 'unitycomponent-v1 requires ' + GAMEENTRY_PREFAB + ' as the composition root');
  } else {
    var prefabText = readText(prefab);
    if (!/\nTransform:\n/.test(prefabText) || prefabText.indexOf('component: {fileID: 400000}') < 0) {
      add(errors, 'gameentry-prefab-transform-missing', 'GameEntry.prefab must include a Transform component so Unity can import it as a valid prefab');
    }
    [
      SLG_SCRIPT_ROOT + '/Base/GameEntry.cs',
      SLG_SCRIPT_ROOT + '/Manager/EntityManager.cs',
      SLG_SCRIPT_ROOT + '/Manager/Event/EventManager.cs',
      SLG_SCRIPT_ROOT + '/Manager/BlueprintDelivery/BlueprintPlayableManager.cs'
    ].forEach(function(scriptRel) {
      var guid = unityGuidForRel(scriptRel);
      if (prefabText.indexOf(guid) < 0) {
        add(errors, 'gameentry-prefab-composition-incomplete', 'GameEntry.prefab must compose the SLGFrameWork entry and required managers', { script: scriptRel });
      }
    });
    if ((prefabText.match(/MonoBehaviour:/g) || []).length < 4) {
      add(errors, 'gameentry-prefab-composition-incomplete', 'GameEntry.prefab must include GameEntry, EntityManager, EventManager, and BlueprintPlayableManager components');
    }
    var scriptsByGuid = {};
    scripts.forEach(function(item) {
      scriptsByGuid[unityGuidForRel(item.rel)] = item;
    });
    var scriptGuidMatches = prefabText.match(/m_Script:\s*\{fileID:\s*11500000,\s*guid:\s*([0-9a-f]{32}),\s*type:\s*3\}/g) || [];
    scriptGuidMatches.forEach(function(match) {
      var guidMatch = /guid:\s*([0-9a-f]{32})/.exec(match);
      var guid = guidMatch && guidMatch[1];
      var script = guid && scriptsByGuid[guid];
      if (!script) {
        add(errors, 'gameentry-prefab-script-missing', 'GameEntry.prefab references a script GUID that is not present in the generated project', { guid: guid });
        return;
      }
      var className = scriptClassName(script.rel);
      var monoPattern = new RegExp('\\bclass\\s+' + className + '\\s*:\\s*MonoBehaviour\\b');
      if (!monoPattern.test(script.code)) {
        add(errors, 'gameentry-prefab-script-invalid', 'GameEntry.prefab may only attach scripts whose file name has a matching MonoBehaviour class', { script: script.rel, expectedClass: className });
      }
    });
  }
  var gameEntryScripts = scripts.filter(function(item) { return item.rel === SLG_SCRIPT_ROOT + '/Base/GameEntry.cs'; });
  if (gameEntryScripts.length === 0) {
    add(errors, 'gameentry-script-missing', 'unitycomponent-v1 requires Base/GameEntry.cs from SLGFrameWork');
    return;
  }
  gameEntryScripts.forEach(function(item) {
    if (!/\bstatic\s+GameEntry\s+Instance\b/.test(item.code) || !/\bstatic\s+EntityManager\s+EntityManager\b/.test(item.code)) {
      add(errors, 'gameentry-contract-invalid', 'GameEntry must preserve UnityComponent(3) static Instance/EntityManager contract', { file: item.rel });
    }
    if (!/\bGetComponentInChildren\s*<\s*EntityManager\s*>/.test(item.code)) {
      add(errors, 'gameentry-contract-invalid', 'GameEntry must hydrate managers from the prefab hierarchy with GetComponentInChildren', { file: item.rel });
    }
    if (/\bFindObjectOfType\s*(?:<|\()|\bGameObject\s*\.\s*Find/.test(item.code)) {
      add(errors, 'gameentry-fallback-find', 'GameEntry must use prefab hierarchy refs, not scene-wide Find fallbacks', { file: item.rel });
    }
  });
}

function validateRuntimePatching(errors, scripts) {
  var hits = [];
  scripts.forEach(function(item) {
    var layer = layerForRel(item.rel);
    if (!/^(Entity|Component|Manager|Base)$/.test(layer)) return;
    var code = item.code;
    [
      { token: 'GameObject.Find', re: /\bGameObject\s*\.\s*Find(?:WithTag|GameObjectsWithTag)?\s*\(/g },
      { token: 'FindObjectOfType', re: /\bFindObjectOfType\s*(?:<|\()/g },
      { token: 'FindWithTag', re: /\bFindWithTag\s*\(/g },
      { token: 'AddComponent', re: /\.\s*AddComponent\s*(?:<|\()/g },
      { token: 'new GameObject', re: /\bnew\s+GameObject\s*\(/g }
    ].forEach(function(rule) {
      var matches = code.match(rule.re) || [];
      if (matches.length) hits.push({ file: item.rel, token: rule.token, count: matches.length });
    });
  });
  if (hits.length) {
    add(errors, 'runtime-scene-patching', 'SLGFrameWork output must not patch core gameplay structure with runtime scene scans/AddComponent/new GameObject', hits.slice(0, 30));
  }
}

function validateRuntimeDoesNotReadSpec(errors, scripts) {
  var hits = [];
  scripts.forEach(function(item) {
    var code = item.code;
    if (/UnityDeliverySpec\.json|File\s*\.\s*ReadAllText|JsonUtility\s*\.\s*FromJson|Resources\s*\.\s*Load\s*(?:<|\()/.test(code)) {
      hits.push(item.rel);
    }
  });
  if (hits.length) {
    add(errors, 'unity-delivery-spec-runtime-read', 'Unity runtime must use baked data/assets, not read UnityDeliverySpec JSON at runtime', hits.slice(0, 30));
  }
}

function hasQuotedValue(text, value) {
  return text.indexOf(JSON.stringify(String(value == null ? '' : value))) >= 0;
}

function escapedRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function projectSpecificNeedles(spec) {
  var seen = {};
  var out = [];
  function addNeedle(value) {
    var text = String(value || '').trim();
    if (!text || text.length < 3 || seen[text]) return;
    seen[text] = true;
    out.push(text);
  }
  (spec.phases || []).forEach(function(phase) {
    addNeedle(phase.id);
    addNeedle(phase.guideText);
  });
  (spec.entities || []).forEach(function(entity) {
    addNeedle(entity.sourceId);
    addNeedle(entity.label);
  });
  (spec.resources || []).forEach(function(resource) {
    addNeedle(resource.sourceId || resource.id);
    addNeedle(resource.label);
  });
  return out;
}

function validateGeneratedDeliveryData(root, errors, spec) {
  if (!spec) return;
  var dataPath = path.join(root, SLG_SCRIPT_ROOT, 'Manager', 'BlueprintDelivery', 'GeneratedDeliveryData.cs');
  var text = readText(dataPath);
  if (!text) {
    add(errors, 'generated-delivery-data-missing', 'GeneratedDeliveryData.cs is required under Manager/BlueprintDelivery as the baked UnityDeliverySpec projection');
    return;
  }
  [
    'Phases',
    'Entities',
    'SceneRefs',
    'PoolArchetypes',
    'UiRefs',
    'AssetBindings'
  ].forEach(function(name) {
    if (text.indexOf(' ' + name + ' = new ') < 0) {
      add(errors, 'generated-delivery-data-array-missing', 'GeneratedDeliveryData must include baked ' + name + ' array', { array: name });
    }
  });
  (spec.phases || []).forEach(function(phase) {
    if (!hasQuotedValue(text, phase.id) || !hasQuotedValue(text, phase.guideText)) {
      add(errors, 'generated-phase-data-mismatch', 'GeneratedDeliveryData.Phases must include every spec phase id and guide text', { phaseId: phase.id });
    }
  });
  (spec.entities || []).forEach(function(entity) {
    ['sourceId', 'unityClass', 'bindingKind', 'prefabPath'].forEach(function(key) {
      if (!hasQuotedValue(text, entity[key] || '')) {
        add(errors, 'generated-entity-data-mismatch', 'GeneratedDeliveryData.Entities must include every spec entity binding field', { entity: entity.sourceId, key: key });
      }
    });
  });
  (spec.sceneRefs || []).forEach(function(item) {
    ['id', 'sourceId', 'prefabPath'].forEach(function(key) {
      if (!hasQuotedValue(text, item[key] || '')) {
        add(errors, 'generated-scene-ref-data-mismatch', 'GeneratedDeliveryData.SceneRefs must include every spec scene ref', { sceneRef: item.id, key: key });
      }
    });
  });
  (spec.poolArchetypes || []).forEach(function(item) {
    ['id', 'sourceId', 'prefabPath'].forEach(function(key) {
      if (!hasQuotedValue(text, item[key] || '')) {
        add(errors, 'generated-pool-archetype-data-mismatch', 'GeneratedDeliveryData.PoolArchetypes must include every spec pool archetype', { pool: item.id, key: key });
      }
    });
  });
  (spec.uiRefs || []).forEach(function(item) {
    ['id', 'role'].forEach(function(key) {
      if (!hasQuotedValue(text, item[key] || '')) {
        add(errors, 'generated-ui-ref-data-mismatch', 'GeneratedDeliveryData.UiRefs must include every spec UI ref', { uiRef: item.id, key: key });
      }
    });
  });
  (spec.assetBindings || []).forEach(function(item) {
    ['assetId', 'kind'].forEach(function(key) {
      if (!hasQuotedValue(text, item[key] || '')) {
        add(errors, 'generated-asset-binding-data-mismatch', 'GeneratedDeliveryData.AssetBindings must include every spec asset binding', { assetId: item.assetId, key: key });
      }
    });
  });
}

function validateLogicalBoundaries(errors, scripts, spec) {
  if (!spec) return;
  var generatedDataRel = SLG_SCRIPT_ROOT + '/Manager/BlueprintDelivery/GeneratedDeliveryData.cs';
  var dataScript = scripts.filter(function(item) { return item.rel === generatedDataRel; })[0];
  if (dataScript) {
    if (/\b(Update|Start|Awake|OnEnable|OnDisable)\s*\(/.test(dataScript.code) || /\b(EntityManager|GameEntry|GetComponent|GameObject|Instantiate)\b/.test(dataScript.code)) {
      add(errors, 'logical-data-boundary-violation', 'GeneratedDeliveryData is the logical Data layer and must only contain baked records, not runtime behavior or manager calls', { file: generatedDataRel });
    }
  }

  var needles = projectSpecificNeedles(spec);
  scripts.forEach(function(item) {
    if (item.rel === generatedDataRel) return;
    if (item.rel.indexOf(SLG_SCRIPT_ROOT + '/Entity/') === 0) return;
    if (item.rel.indexOf(SLG_SCRIPT_ROOT + '/Base/') === 0) return;
    if (item.rel.indexOf(SLG_SCRIPT_ROOT + '/Manager/') !== 0 && item.rel.indexOf(SLG_SCRIPT_ROOT + '/Component/') !== 0) return;
    for (var i = 0; i < needles.length; i++) {
      var quotedNeedle = new RegExp('["\\\']' + escapedRegExp(needles[i]) + '["\\\']');
      if (quotedNeedle.test(item.code)) {
        add(errors, 'logical-tool-boundary-violation', 'Reusable Manager/Component files must not hardcode project-specific phase, guide, entity, or resource values; keep those in GeneratedDeliveryData or Entity composition', { file: item.rel, value: needles[i] });
        break;
      }
    }
  });
}

function validateSpecConsistency(root, errors) {
  var specPath = path.join(root, 'Assets', 'BlueprintDelivery', 'UnityDeliverySpec.json');
  var spec = readJsonIfExists(specPath);
  if (!spec) {
    add(errors, 'unity-delivery-spec-missing', 'Assets/BlueprintDelivery/UnityDeliverySpec.json is required');
    return null;
  }
  if (spec.kind !== projector.KIND || spec.schemaVersion !== projector.SCHEMA_VERSION || spec.profile !== 'unitycomponent-v1') {
    add(errors, 'unity-delivery-spec-invalid-header', 'UnityDeliverySpec must be a unitycomponent-v1 spec', {
      kind: spec.kind,
      schemaVersion: spec.schemaVersion,
      profile: spec.profile
    });
  }
  ['entities', 'components', 'phases', 'sceneRefs', 'poolArchetypes', 'uiRefs', 'assetBindings'].forEach(function(key) {
    if (!Array.isArray(spec[key])) add(errors, 'unity-delivery-spec-array-missing', 'UnityDeliverySpec.' + key + '[] is required', { key: key });
  });
  var sourceIr = readJsonIfExists(path.join(root, 'source-ir.json')) ||
    readJsonIfExists(path.join(root, 'Assets', 'BlueprintDelivery', 'source-ir.json'));
  if (!sourceIr) {
    add(errors, 'source-ir-missing', 'unitycomponent-v1 hardgate requires source-ir.json so UnityDeliverySpec parity can be verified');
  } else {
    try {
      projector.assertDeliverySpecSourceParity(spec, sourceIr);
    } catch (err) {
      add(errors, 'unity-delivery-spec-source-drift', 'UnityDeliverySpec must preserve SourceIR phase/entity/resource semantics', err.diffs || String(err && err.message || err));
    }
  }
  var sceneRefIds = {};
  (spec.sceneRefs || []).forEach(function(item) { sceneRefIds[item.sourceId] = true; });
  var poolIds = {};
  (spec.poolArchetypes || []).forEach(function(item) { poolIds[item.sourceId] = true; });
  (spec.entities || []).forEach(function(entity) {
    if (entity.bindingKind === 'sceneRef' && !sceneRefIds[entity.sourceId]) {
      add(errors, 'scene-ref-spec-missing', 'SceneRef entity missing from sceneRefs[]', entity);
    }
    if (entity.bindingKind === 'poolArchetype' && !poolIds[entity.sourceId]) {
      add(errors, 'pool-archetype-spec-missing', 'Pool entity missing from poolArchetypes[]', entity);
    }
  });
  return spec;
}

function validateUnityComponentV1(root, options) {
  root = path.resolve(root);
  options = options || {};
  var profile = profiles.resolveProfile(options.profile || 'unitycomponent-v1');
  if (profile.id !== 'unitycomponent-v1') throw new Error('unitycomponent-v1 hardgate received non-v1 profile: ' + profile.id);
  var errors = [];
  var warnings = [];
  validateLayerDirs(root, errors);
  validateFrameworkTemplateManifest(root, errors);
  var spec = validateSpecConsistency(root, errors);
  validateForbiddenIdentifiers(root, errors, profile);
  var scripts = collectCs(root);
  validateNoOldNamespaceOrAsmdef(root, errors, scripts);
  validateScriptRoots(errors, scripts);
  validateGeneratedDeliveryData(root, errors, spec);
  validateLogicalBoundaries(errors, scripts, spec);
  validateEntitiesAndComponents(errors, scripts, spec);
  validateGameEntry(root, errors, scripts);
  validateRuntimePatching(errors, scripts);
  validateRuntimeDoesNotReadSpec(errors, scripts);
  return {
    kind: KIND,
    schemaVersion: SCHEMA_VERSION,
    profile: profile.id,
    framework: 'UnityComponent(3)/SLGFrameWork',
    root: root,
    passed: errors.length === 0,
    errors: errors,
    warnings: warnings,
    summary: {
      scriptCount: scripts.length,
      errorCount: errors.length,
      warningCount: warnings.length,
      phaseCount: spec && Array.isArray(spec.phases) ? spec.phases.length : 0,
      entityCount: spec && Array.isArray(spec.entities) ? spec.entities.length : 0,
      componentCount: spec && Array.isArray(spec.components) ? spec.components.length : 0,
      sceneRefCount: spec && Array.isArray(spec.sceneRefs) ? spec.sceneRefs.length : 0,
      poolArchetypeCount: spec && Array.isArray(spec.poolArchetypes) ? spec.poolArchetypes.length : 0
    }
  };
}

function writeReport(root, outPath, options) {
  var report = validateUnityComponentV1(root, options);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
  return report;
}

function parseCli(argv) {
  var args = argv || process.argv.slice(2);
  var parsed = { root: '', out: '' };
  for (var i = 0; i < args.length; i++) {
    var arg = args[i];
    if (arg === '--out') parsed.out = args[++i] || '';
    else if (!parsed.root) parsed.root = arg;
    else throw new Error('Unexpected argument: ' + arg);
  }
  if (!parsed.root) throw new Error('Usage: node lib/unitycomponent-v1-hardgate.cjs <unity-project-root> [--out report.json]');
  return parsed;
}

if (require.main === module) {
  try {
    var parsed = parseCli();
    var report = parsed.out ? writeReport(parsed.root, path.resolve(parsed.out)) : validateUnityComponentV1(parsed.root);
    process.stdout.write(JSON.stringify({ passed: report.passed, summary: report.summary }, null, 2) + '\n');
    if (!report.passed) process.exit(1);
  } catch (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  }
}

module.exports = {
  KIND: KIND,
  SCHEMA_VERSION: SCHEMA_VERSION,
  SLG_SCRIPT_ROOT: SLG_SCRIPT_ROOT,
  GAMEENTRY_PREFAB: GAMEENTRY_PREFAB,
  validateUnityComponentV1: validateUnityComponentV1,
  writeReport: writeReport
};
