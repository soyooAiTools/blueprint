/**
 * Stage: compile — Bridge.NET build with auto-fix loop
 *
 * Reads: ctx.csCode, ctx.extraFiles, ctx.blueprint, ctx.workDir
 * Writes: ctx.htmlOutput, ctx.buildTime
 */

var fs = require('fs');
var path = require('path');
var helpers = require('../helpers.cjs');
var { recode } = require('../recode.cjs');
var { createFixLoop } = require('../fix-loop.cjs');
var config = require('../../lib/config.cjs');
var commentLocalizer = require('../../lib/csharp-comment-localizer.cjs');
var { resourceIdExpr } = require('../../adapters/templates/resource-ids.cjs');
var gfmFiles = require('../../worker/gfm-files.cjs');

var MAX_BUILD_FIX_ATTEMPTS = 5;
// Early exit if the build fails with the same error signature 3 rounds in a row —
// the AI is stuck on the same root cause, additional rounds will only burn tokens.
var SAME_BUILD_ERROR_EXIT = 3;

function localizeCompileInputs(csCode, extraFiles) {
  var localCtx = {
    csCode: String(csCode || ''),
    extraFiles: Object.assign({}, extraFiles || {}),
  };
  var stats = commentLocalizer.localizeContextCSharpComments(localCtx);
  return {
    changed: stats.changed,
    stats: stats,
    csCode: localCtx.csCode,
    extraFiles: localCtx.extraFiles,
  };
}

function collectBlueprintEntities(blueprint) {
  return blueprint && Array.isArray(blueprint.entities) ? blueprint.entities : [];
}

function resolvePoolPrefabLiteral(literal, blueprint) {
  var text = String(literal || '').trim();
  if (!text) return '';
  var entities = collectBlueprintEntities(blueprint);
  for (var i = 0; i < entities.length; i++) {
    if (entities[i] && String(entities[i].name || '') === text) return String(entities[i].name);
  }
  var lower = text.toLowerCase();
  for (var j = 0; j < entities.length; j++) {
    var entityName = String(entities[j] && entities[j].name || '');
    if (entityName && entityName.toLowerCase() === lower) return entityName;
  }
  if (lower === 'projectile') {
    for (var k = 0; k < entities.length; k++) {
      var behavior = entities[k] && entities[k].behavior || {};
      var projectile = String(behavior.projectile || '').trim();
      if (!projectile) continue;
      for (var p = 0; p < entities.length; p++) {
        if (entities[p] && String(entities[p].name || '') === projectile) return projectile;
      }
    }
    for (var m = 0; m < entities.length; m++) {
      var candidate = String(entities[m] && entities[m].name || '');
      if (/Bullet|Projectile|Arrow|Missile|Rocket/i.test(candidate)) return candidate;
    }
  }
  return '';
}

function rewriteStringPoolGets(code, blueprint) {
  if (!code || code.indexOf('GFM_Pool.Get("') < 0) {
    return { code: code, changed: false, fixes: 0 };
  }
  var fixes = 0;
  var fixed = String(code).replace(/GFM_Pool\.Get\s*\(\s*"([^"]+)"\s*\)/g, function(match, literal) {
    var resolved = resolvePoolPrefabLiteral(literal, blueprint);
    if (!resolved) return match;
    fixes++;
    return 'GFM_Pool.Get(' + resolved + ')';
  });
  return { code: fixed, changed: fixes > 0, fixes: fixes };
}

function resolveResourceAlias(alias, blueprint) {
  var text = String(alias || '').trim();
  if (!text) return '';
  var lower = text.toLowerCase();
  var resources = blueprint && Array.isArray(blueprint.resources) ? blueprint.resources : [];
  for (var i = 0; i < resources.length; i++) {
    var resourceName = String(resources[i] && resources[i].name || '');
    if (resourceName && resourceName.toLowerCase() === lower) return resourceName;
  }
  var entities = collectBlueprintEntities(blueprint);
  for (var j = 0; j < entities.length; j++) {
    var entityName = String(entities[j] && entities[j].name || '');
    if (entityName && entityName.toLowerCase() === lower) return entityName;
  }
  return '';
}

function rewriteLegacyScoreDisplayAliases(code, blueprint) {
  if (!code || code.indexOf('display += ') < 0) {
    return { code: code, changed: false, fixes: 0 };
  }
  var fixes = 0;
  var fixed = String(code).replace(
    /if\s*\(\s*([a-z][A-Za-z0-9_]*)\s*>\s*0\s*\)\s*display\s*\+=\s*("[^"]*")\s*\+\s*\1\s*;/g,
    function(match, alias, labelLiteral) {
      var canonical = resolveResourceAlias(alias, blueprint);
      if (!canonical || canonical === alias) return match;
      fixes++;
      return 'if (GetResource(' + resourceIdExpr(canonical) + ') > 0) display += ' + labelLiteral + ' + GetResource(' + resourceIdExpr(canonical) + ');';
    }
  );
  return { code: fixed, changed: fixes > 0, fixes: fixes };
}

function rewriteTypedComponentMemberAccess(code) {
  if (!code || code.indexOf('GetComponent(typeof(') < 0) {
    return { code: code, changed: false, fixes: 0 };
  }
  var fixes = 0;
  var fixed = String(code);
  fixed = fixed.replace(
    /((?:this|base|[A-Za-z_][A-Za-z0-9_]*)(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\.GetComponent\s*\(\s*typeof\(\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\)\s*\)\s+as\s+([A-Za-z_][A-Za-z0-9_.]*)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/g,
    function(_m, target, _typeExpr, castType, member) {
      fixes++;
      return '((' + castType + ')' + target + '.GetComponent(typeof(' + castType + '))).' + member;
    }
  );
  fixed = fixed.replace(
    /((?:this|base|[A-Za-z_][A-Za-z0-9_]*)(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\.GetComponent\s*\(\s*typeof\(\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\)\s*\)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/g,
    function(_m, target, typeName, member) {
      fixes++;
      return '((' + typeName + ')' + target + '.GetComponent(typeof(' + typeName + '))).' + member;
    }
  );
  return { code: fixed, changed: fixes > 0, fixes: fixes };
}

function stripUnresolvedPhaseInitArtifacts(code) {
  if (!code) {
    return { code: code, changed: false, fixes: 0 };
  }
  var fixes = 0;
  var fixed = String(code);
  fixed = fixed.replace(/^[ \t]*UnknownState\s*=\s*\d+\s*;\s*$/gm, function() {
    fixes++;
    return '        // stripped unresolved UnknownState write';
  });
  fixed = fixed.replace(/^[ \t]*AddResource\s*\(\s*"default"\s*,\s*[^;]+\);\s*$/gm, function() {
    fixes++;
    return '        // stripped unresolved default resource write';
  });
  fixed = fixed.replace(/ShowFloatingText\s*\(\s*player\.transform\.position\s*,\s*"undefined"\s*,/g, function() {
    fixes++;
    return 'ShowFloatingText(player.transform.position, "",';
  });
  return { code: fixed, changed: fixes > 0, fixes: fixes };
}

function collectDeclaredSymbols(code, extraFiles) {
  var declared = {};
  function scan(src) {
    var text = String(src || '');
    var re = /\b(?:bool|int|float|string|GameObject|Vector2|Vector3|Vector4|Color|Transform|Text|Canvas|Rigidbody|Material|Image|Sprite|RectTransform|InventoryCompat|var|GFM_[A-Za-z0-9_]+)(?:\s*\[\])?\s+([A-Za-z_][A-Za-z0-9_]*)\b/g;
    var m;
    while ((m = re.exec(text)) !== null) declared[m[1]] = true;
  }
  scan(code);
  Object.keys(extraFiles || {}).forEach(function(name) { scan(extraFiles[name]); });
  return declared;
}

function escapeRegexLiteral(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasDeclaredSymbol(declaredSymbols, declaredSourceText, name) {
  if (declaredSymbols && declaredSymbols[name]) return true;
  var re = new RegExp('\\b(?:bool|int|float|string|GameObject|Vector2|Vector3|Vector4|Color|Transform|Text|Canvas|Rigidbody|Material|Image|Sprite|RectTransform|InventoryCompat|var|GFM_[A-Za-z0-9_]+)(?:\\s*\\[\\])?\\s+' + escapeRegexLiteral(name) + '\\b');
  return re.test(String(declaredSourceText || ''));
}

function stripUndeclaredObjectUtilityCalls(code, declaredSymbols, declaredSourceText) {
  if (!code || !/(?:PlaceObj|HideObj|SetScale)\s*\(/.test(code)) {
    return { code: code, changed: false, fixes: 0 };
  }
  var fixes = 0;
  var lines = String(code).split('\n');
  for (var i = 0; i < lines.length; i++) {
    var m = /^(\s*)(PlaceObj|HideObj|SetScale)\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\b[^;]*;\s*$/.exec(lines[i]);
    if (!m) continue;
    if (hasDeclaredSymbol(declaredSymbols, declaredSourceText, m[3])) continue;
    lines[i] = m[1] + '// stripped unresolved object reference: ' + m[3];
    fixes++;
  }
  return { code: fixes > 0 ? lines.join('\n') : code, changed: fixes > 0, fixes: fixes };
}

function stripUndeclaredBareMutations(code, declaredSymbols, declaredSourceText) {
  if (!code || !/(?:\+\+|--|=)/.test(code)) {
    return { code: code, changed: false, fixes: 0 };
  }
  var fixes = 0;
  var lines = String(code).split('\n');
  var mutationRe = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*(?:(\+\+|--)\s*|([+\-*/]?=)\s*[^;]+);\s*$/;
  for (var i = 0; i < lines.length; i++) {
    var trimmed = lines[i].trim();
    if (!trimmed || trimmed.indexOf('//') === 0) continue;
    if (/^(?:if|for|foreach|while|switch|return|throw|case|else)\b/.test(trimmed)) continue;
    var m = mutationRe.exec(lines[i]);
    if (!m) continue;
    var name = m[2];
    if (hasDeclaredSymbol(declaredSymbols, declaredSourceText, name)) continue;
    lines[i] = m[1] + '// stripped unresolved mutation: ' + name;
    fixes++;
  }
  return { code: fixes > 0 ? lines.join('\n') : code, changed: fixes > 0, fixes: fixes };
}

function stripDuplicateMoveSpeedMembers(code, extraFiles) {
  var allSources = [String(code || '')].concat(Object.keys(extraFiles || {}).map(function(name) {
    return String(extraFiles[name] || '');
  }));
  var hasFormBackedProperty = allSources.some(function(src) {
    return /\bfloat\s+moveSpeed\s*\{\s*get\s*\{\s*return\s*\(_forms\s*!=\s*null\s*&&\s*_forms\.Length\s*>\s*0\)/.test(src);
  });
  if (!hasFormBackedProperty) return { changed: false, code: code, extraFiles: extraFiles || {}, fixes: 0 };

  function stripPlainMoveSpeedField(src) {
    var fixes = 0;
    var next = String(src || '').replace(/^\s*float\s+moveSpeed\s*=\s*[^;]+;\s*(?:\/\/[^\n\r]*)?$/gm, function() {
      fixes++;
      return '';
    }).replace(/\n{3,}/g, '\n\n');
    return { code: next, fixes: fixes };
  }

  var main = stripPlainMoveSpeedField(code);
  var nextExtras = Object.assign({}, extraFiles || {});
  var fixes = main.fixes;
  Object.keys(nextExtras).forEach(function(name) {
    var res = stripPlainMoveSpeedField(nextExtras[name]);
    if (res.fixes > 0) {
      nextExtras[name] = res.code;
      fixes += res.fixes;
    }
  });

  return { changed: fixes > 0, code: main.code, extraFiles: nextExtras, fixes: fixes };
}

function refreshCanonicalGfmUi(code, extraFiles) {
  var nextExtras = Object.assign({}, extraFiles || {});
  var sources = [String(code || '')].concat(Object.keys(nextExtras).map(function(name) {
    return String(nextExtras[name] || '');
  })).join('\n');
  var shouldHaveGfmUi = /\bGFM_UI\./.test(sources) || Object.prototype.hasOwnProperty.call(nextExtras, 'GFM_UI.cs');
  if (!shouldHaveGfmUi) return { changed: false, extraFiles: nextExtras, fixes: 0 };

  var canonical;
  try {
    canonical = gfmFiles.loadGfmFiles()['GFM_UI.cs'];
  } catch (_err) {
    canonical = null;
  }
  if (!canonical) return { changed: false, extraFiles: nextExtras, fixes: 0 };

  var fixes = 0;
  if (String(nextExtras['GFM_UI.cs'] || '') !== canonical) {
    nextExtras['GFM_UI.cs'] = canonical;
    fixes++;
  }
  if (Object.prototype.hasOwnProperty.call(nextExtras, 'GFM_Tools.cs')) {
    delete nextExtras['GFM_Tools.cs'];
    fixes++;
  }
  return { changed: fixes > 0, extraFiles: nextExtras, fixes: fixes };
}

function repairAddResourceNegativeEvidence(code) {
  var text = String(code || '');
  if (text.indexOf('void AddResource') < 0 || text.indexOf('amount < 0 && after < before') >= 0) {
    return { code: code, changed: false, fixes: 0 };
  }
  var re = /(if\s*\(\s*amount\s*>\s*0\s*&&\s*after\s*>\s*before\s*\)\s*\{\n\s*RecordPhaseEvidenceDelta\s*\(\s*currentPhaseName\s*,\s*"resource_incremented"\s*,\s*before\s*,\s*after\s*\);\n\s*RecordPhaseEvidenceFlag\s*\(\s*currentPhaseName\s*,\s*"score_text_changed"\s*\);\n\s*\})/;
  if (!re.test(text)) return { code: code, changed: false, fixes: 0 };
  var fixed = text.replace(re, '$1\n        else if (amount < 0 && after < before) {\n            RecordPhaseEvidenceDelta(currentPhaseName, "resource_decremented", before, after);\n            RecordPhaseEvidenceFlag(currentPhaseName, "score_text_changed");\n        }');
  return { code: fixed, changed: fixed !== text, fixes: fixed !== text ? 1 : 0 };
}

function maskCommentsAndStrings(src) {
  return String(src || '')
    .replace(/\/\*[\s\S]*?\*\//g, function(m) { return m.replace(/[^\n]/g, ' '); })
    .replace(/\/\/[^\n]*/g, function(m) { return ' '.repeat(m.length); })
    .replace(/"(?:[^"\\]|\\.)*"/g, function(m) { return '"' + ' '.repeat(Math.max(0, m.length - 2)) + '"'; });
}

function splitTopLevelParams(params) {
  var text = String(params || '').trim();
  if (!text) return [];
  var parts = [];
  var depth = 0;
  var start = 0;
  for (var i = 0; i < text.length; i++) {
    var ch = text[i];
    if (ch === '<' || ch === '(' || ch === '[') depth++;
    else if (ch === '>' || ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map(function(part) { return part.trim(); }).filter(Boolean);
}

function normalizeMethodParamTypes(params) {
  return splitTopLevelParams(params).map(function(part) {
    var clean = part
      .replace(/=.*/g, '')
      .replace(/\b(?:ref|out|in|params)\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!clean) return '';
    var tokens = clean.split(/\s+/);
    if (tokens.length > 1) tokens.pop();
    return tokens.join(' ');
  }).join(',');
}

function findMatchingBrace(masked, openIdx) {
  var depth = 0;
  for (var i = openIdx; i < masked.length; i++) {
    var ch = masked[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function collectMethodRanges(src) {
  var text = String(src || '');
  var masked = maskCommentsAndStrings(text);
  var ranges = [];
  var ctrl = { if: 1, for: 1, foreach: 1, while: 1, switch: 1, using: 1, lock: 1, catch: 1 };
  var sigRe = /\b(?:(?:public|private|protected|internal|static|virtual|override|sealed|async|partial|extern)\s+)*(?:void|bool|int|float|string|GameObject|Vector[234]?|Color|Transform|Text|Canvas|Rigidbody|Material|Image|Sprite|RectTransform|InventoryCompat|[A-Za-z_][A-Za-z0-9_<>,\[\].?]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{/g;
  var m;
  while ((m = sigRe.exec(masked)) !== null) {
    var name = m[1];
    if (ctrl[name]) continue;
    var openIdx = masked.indexOf('{', sigRe.lastIndex - 1);
    if (openIdx < 0) continue;
    var closeIdx = findMatchingBrace(masked, openIdx);
    if (closeIdx < 0) continue;
    ranges.push({
      name: name,
      key: name + '/' + normalizeMethodParamTypes(m[2]),
      start: m.index,
      end: closeIdx + 1,
    });
    sigRe.lastIndex = closeIdx + 1;
  }
  return ranges;
}

function stripDuplicateMethodsInSource(code) {
  var text = String(code || '');
  var ranges = collectMethodRanges(text);
  if (ranges.length < 2) return { code: code, changed: false, fixes: 0, names: [] };
  var seen = {};
  var duplicates = [];
  for (var i = 0; i < ranges.length; i++) {
    var range = ranges[i];
    if (seen[range.key]) duplicates.push(range);
    else seen[range.key] = range;
  }
  if (duplicates.length === 0) return { code: code, changed: false, fixes: 0, names: [] };
  duplicates.sort(function(a, b) { return b.start - a.start; });
  var fixed = text;
  var names = [];
  for (var d = 0; d < duplicates.length; d++) {
    var dup = duplicates[d];
    var lineStart = fixed.lastIndexOf('\n', dup.start - 1) + 1;
    var indentMatch = /^\s*/.exec(fixed.slice(lineStart, dup.start));
    var indent = indentMatch ? indentMatch[0] : '';
    var replacement = indent + '// stripped duplicate method definition: ' + dup.name;
    var end = dup.end;
    if (fixed[end] === '\r' && fixed[end + 1] === '\n') end += 2;
    else if (fixed[end] === '\n') end += 1;
    fixed = fixed.slice(0, dup.start) + replacement + '\n' + fixed.slice(end);
    names.push(dup.name);
  }
  return { code: fixed, changed: true, fixes: duplicates.length, names: names };
}

function applyDeterministicBuildRepairs(code, extraFiles, blueprint) {
  var methodCheck;
  var reviewStage;
  try {
    methodCheck = require('./method-check.cjs');
    reviewStage = require('./review.cjs');
  } catch (_err) {
    return { changed: false, code: code, extraFiles: extraFiles || {}, fixes: [] };
  }
  var repairCtx = {
    csCode: code,
    extraFiles: Object.assign({}, extraFiles || {}),
    blueprint: blueprint || {},
  };
  var fixes = [];
  var gfmUiRepair = refreshCanonicalGfmUi(repairCtx.csCode, repairCtx.extraFiles);
  if (gfmUiRepair.changed) {
    repairCtx.extraFiles = gfmUiRepair.extraFiles;
    fixes.push('CanonicalGfmUi x' + gfmUiRepair.fixes);
  }
  var duplicateMainMethods = stripDuplicateMethodsInSource(repairCtx.csCode);
  if (duplicateMainMethods.changed) {
    repairCtx.csCode = duplicateMainMethods.code;
    fixes.push('DuplicateMethods x' + duplicateMainMethods.fixes);
  }
  Object.keys(repairCtx.extraFiles || {}).forEach(function(name) {
    if (!/^GameFlowManagerMain(?:\.|$)/.test(name)) return;
    var methodRepair = stripDuplicateMethodsInSource(repairCtx.extraFiles[name]);
    if (methodRepair.changed) {
      repairCtx.extraFiles[name] = methodRepair.code;
      fixes.push(name + ':DuplicateMethods x' + methodRepair.fixes);
    }
  });
  var mainNegativeResourceRepair = repairAddResourceNegativeEvidence(repairCtx.csCode);
  if (mainNegativeResourceRepair.changed) {
    repairCtx.csCode = mainNegativeResourceRepair.code;
    fixes.push('NegativeResourceEvidence x' + mainNegativeResourceRepair.fixes);
  }
  Object.keys(repairCtx.extraFiles || {}).forEach(function(name) {
    if (!/^GameFlowManagerMain(?:\.|$)/.test(name)) return;
    var negativeResourceRepair = repairAddResourceNegativeEvidence(repairCtx.extraFiles[name]);
    if (negativeResourceRepair.changed) {
      repairCtx.extraFiles[name] = negativeResourceRepair.code;
      fixes.push(name + ':NegativeResourceEvidence x' + negativeResourceRepair.fixes);
    }
  });
  if (methodCheck.autoRepairDuplicateStateFields && methodCheck.autoRepairDuplicateStateFields(repairCtx)) {
    fixes.push('DuplicateStateFields');
  }
  if (methodCheck.autoRepairDuplicateSimpleFields && methodCheck.autoRepairDuplicateSimpleFields(repairCtx)) {
    fixes.push('DuplicateSimpleFields');
  }
  if (methodCheck.autoRepairDuplicateObjectFields && methodCheck.autoRepairDuplicateObjectFields(repairCtx)) {
    fixes.push('DuplicateObjectFields');
  }
  if (methodCheck.autoRepairMissingSkeletonBridgeInfra && methodCheck.autoRepairMissingSkeletonBridgeInfra(repairCtx)) {
    fixes.push('MissingSkeletonBridgeInfra');
  }
  var moveSpeedRepair = stripDuplicateMoveSpeedMembers(repairCtx.csCode, repairCtx.extraFiles);
  if (moveSpeedRepair.changed) {
    repairCtx.csCode = moveSpeedRepair.code;
    repairCtx.extraFiles = moveSpeedRepair.extraFiles;
    fixes.push('DuplicateMoveSpeedMembers x' + moveSpeedRepair.fixes);
  }
  if (reviewStage && reviewStage.repairKnownStructuralDamage) {
    var structuralRepair = reviewStage.repairKnownStructuralDamage(repairCtx.csCode, repairCtx.extraFiles, blueprint || {});
    if (structuralRepair.changed) {
      repairCtx.csCode = structuralRepair.code;
      repairCtx.extraFiles = structuralRepair.extraFiles;
      fixes.push('ReviewStructuralDamage x' + structuralRepair.fixes.length + ' [' + structuralRepair.fixes.slice(0, 5).join(', ') + ']');
    }
  }
  if (reviewStage && reviewStage.repairPlayerAliasMemberAccess) {
    var playerAliasRepair = reviewStage.repairPlayerAliasMemberAccess(repairCtx.csCode, repairCtx.extraFiles);
    if (playerAliasRepair.changed) {
      repairCtx.csCode = playerAliasRepair.code;
      repairCtx.extraFiles = playerAliasRepair.extraFiles;
      fixes.push('PlayerAliasMemberAccess x' + playerAliasRepair.fixes);
    }
  }
  if (methodCheck.autoRepairMalformedIsNear && methodCheck.autoRepairMalformedIsNear(repairCtx)) {
    fixes.push('MalformedIsNear');
  }
  var mainPoolRepair = rewriteStringPoolGets(repairCtx.csCode, blueprint);
  if (mainPoolRepair.changed) {
    repairCtx.csCode = mainPoolRepair.code;
    fixes.push('StringPoolPrefabLiterals x' + mainPoolRepair.fixes);
  }
  var mainScoreRepair = rewriteLegacyScoreDisplayAliases(repairCtx.csCode, blueprint);
  if (mainScoreRepair.changed) {
    repairCtx.csCode = mainScoreRepair.code;
    fixes.push('LegacyScoreDisplayAlias x' + mainScoreRepair.fixes);
  }
  var mainComponentRepair = rewriteTypedComponentMemberAccess(repairCtx.csCode);
  if (mainComponentRepair.changed) {
    repairCtx.csCode = mainComponentRepair.code;
    fixes.push('TypedComponentMemberAccess x' + mainComponentRepair.fixes);
  }
  var mainPhaseArtifactRepair = stripUnresolvedPhaseInitArtifacts(repairCtx.csCode);
  if (mainPhaseArtifactRepair.changed) {
    repairCtx.csCode = mainPhaseArtifactRepair.code;
    fixes.push('UnresolvedPhaseInitArtifacts x' + mainPhaseArtifactRepair.fixes);
  }
  Object.keys(repairCtx.extraFiles || {}).forEach(function(name) {
    var next = repairCtx.extraFiles[name];
    var poolRepair = rewriteStringPoolGets(next, blueprint);
    if (poolRepair.changed) {
      next = poolRepair.code;
      fixes.push(name + ':StringPoolPrefabLiterals x' + poolRepair.fixes);
    }
    var scoreRepair = rewriteLegacyScoreDisplayAliases(next, blueprint);
    if (scoreRepair.changed) {
      next = scoreRepair.code;
      fixes.push(name + ':LegacyScoreDisplayAlias x' + scoreRepair.fixes);
    }
    var componentRepair = rewriteTypedComponentMemberAccess(next);
    if (componentRepair.changed) {
      next = componentRepair.code;
      fixes.push(name + ':TypedComponentMemberAccess x' + componentRepair.fixes);
    }
    var phaseArtifactRepair = stripUnresolvedPhaseInitArtifacts(next);
    if (phaseArtifactRepair.changed) {
      next = phaseArtifactRepair.code;
      fixes.push(name + ':UnresolvedPhaseInitArtifacts x' + phaseArtifactRepair.fixes);
    }
    repairCtx.extraFiles[name] = next;
  });
  var declaredSymbols = collectDeclaredSymbols(repairCtx.csCode, repairCtx.extraFiles);
  var declaredSourceText = [repairCtx.csCode].concat(Object.keys(repairCtx.extraFiles || {}).map(function(name) {
    return repairCtx.extraFiles[name];
  })).join('\n');
  var mainObjectRepair = stripUndeclaredObjectUtilityCalls(repairCtx.csCode, declaredSymbols, declaredSourceText);
  if (mainObjectRepair.changed) {
    repairCtx.csCode = mainObjectRepair.code;
    fixes.push('UnresolvedObjectUtilityCalls x' + mainObjectRepair.fixes);
  }
  var mainMutationRepair = stripUndeclaredBareMutations(repairCtx.csCode, declaredSymbols, declaredSourceText);
  if (mainMutationRepair.changed) {
    repairCtx.csCode = mainMutationRepair.code;
    fixes.push('UnresolvedBareMutations x' + mainMutationRepair.fixes);
  }
  Object.keys(repairCtx.extraFiles || {}).forEach(function(name) {
    if (!/^GameFlowManagerMain(?:\.|$)/.test(name)) return;
    var next = repairCtx.extraFiles[name];
    var objectRepair = stripUndeclaredObjectUtilityCalls(next, declaredSymbols, declaredSourceText);
    if (objectRepair.changed) {
      next = objectRepair.code;
      fixes.push(name + ':UnresolvedObjectUtilityCalls x' + objectRepair.fixes);
    }
    var mutationRepair = stripUndeclaredBareMutations(next, declaredSymbols, declaredSourceText);
    if (mutationRepair.changed) {
      next = mutationRepair.code;
      fixes.push(name + ':UnresolvedBareMutations x' + mutationRepair.fixes);
    }
    repairCtx.extraFiles[name] = next;
  });
  // 2026-05-05: Color(R,G,B) 0-255 → 0-1 兜底。LLM 频繁写 new Color(10f, 15f, 30f),
  // Unity Color 是 0-1 就被 clamp 成纯白闪一帧。所有 main + extra 都过一遍。
  try {
    var colorSanitizer = require('../../lib/cs-color-sanitizer.cjs');
    var mainColorRepair = colorSanitizer.sanitizeColors(repairCtx.csCode);
    if (mainColorRepair.changed) {
      repairCtx.csCode = mainColorRepair.code;
      fixes.push('Color255To01 x' + mainColorRepair.fixes);
    }
    Object.keys(repairCtx.extraFiles || {}).forEach(function(name) {
      var extraColorRepair = colorSanitizer.sanitizeColors(repairCtx.extraFiles[name]);
      if (extraColorRepair.changed) {
        repairCtx.extraFiles[name] = extraColorRepair.code;
        fixes.push(name + ':Color255To01 x' + extraColorRepair.fixes);
      }
    });
  } catch (_e) { /* sanitizer optional */ }
  return {
    changed: fixes.length > 0,
    code: repairCtx.csCode,
    extraFiles: repairCtx.extraFiles,
    fixes: fixes,
  };
}

module.exports = {
  name: 'compile',
  canRetry: false,
  assertBefore: function(ctx) {
    if (!ctx.csCode || ctx.csCode.length === 0) throw new Error('No C# code to compile');
  },
  execute: function(ctx) {
    ctx.addLog('compile', 'Starting Bridge.NET compilation...');
    var buildUrl = ctx.workerConfig.buildUrl;
    var lastCsCode = ctx.csCode;
    var lastExtraFiles = Object.assign({}, ctx.extraFiles);
    // Count by signature (not consecutive): catches A->B->A->B oscillation that the
    // old consecutive-match logic kept resetting on every flip. (P2-新2, 2026-04-15)
    var errSigCounts = {};

    var loop = createFixLoop({
      name: 'compile',
      maxRounds: MAX_BUILD_FIX_ATTEMPTS,
      onExhausted: 'throw',
      beforeRound: function(ctx, round, maxRounds) {
        var label = round === 1 ? '' : ' (fix attempt ' + (round - 1) + '/' + maxRounds + ')';
        ctx.reportStatus('building', { message: '[Linux] Bridge.NET compiling...' + label });
      },
      attempt: function(ctx, round, maxRounds) {
        var deterministicRepair = applyDeterministicBuildRepairs(lastCsCode, lastExtraFiles, ctx.blueprint);
        if (deterministicRepair.changed) {
          lastCsCode = deterministicRepair.code;
          lastExtraFiles = deterministicRepair.extraFiles;
          ctx.addLog('compile', 'Deterministic pre-build repair applied: ' + deterministicRepair.fixes.join(', '));
        }
        var localized = localizeCompileInputs(lastCsCode, lastExtraFiles);
        if (localized.changed) {
          lastCsCode = localized.csCode;
          lastExtraFiles = localized.extraFiles;
          ctx.addLog('compile', 'Localized C# comments before build: ' +
            localized.stats.localizedComments + ' comment(s) in ' +
            localized.stats.changedFiles + '/' + localized.stats.files + ' file(s)');
        }
        var buildOptions = { visualAssets: ctx.blueprint && ctx.blueprint.visualAssets || null };
        return helpers.buildRequest(buildUrl, '/build', lastCsCode, lastExtraFiles, buildOptions)
          .catch(function(e) { return { ok: false, error: e.message }; })
          .then(function(buildResult) {
            if (buildResult.ok) {
              ctx.addLog('compile', 'Build OK in ' + buildResult.buildTime + 's');
              ctx.csCode = lastCsCode;
              ctx.extraFiles = lastExtraFiles;
              ctx.buildTime = buildResult.buildTime;

              return helpers.buildRequest(buildUrl, '/build-html', lastCsCode, lastExtraFiles, buildOptions)
                .then(function(htmlData) {
                  if (!htmlData || htmlData.length < 10240) {
                    throw new Error('HTML output too small (' + (htmlData ? htmlData.length : 0) + ' bytes) — likely empty build');
                  }
                  ctx.htmlOutput = htmlData;
                  ctx.addLog('compile', 'HTML: ' + (htmlData.length / 1048576).toFixed(1) + 'MB');

                  // Persist C# source for SVN/git archival
                  try {
                    var sourcesDir = path.join(config.SOURCES_DIR, ctx.taskId);
                    fs.mkdirSync(sourcesDir, { recursive: true });
                    fs.writeFileSync(path.join(sourcesDir, 'GameFlowManagerMain.cs'), lastCsCode, 'utf-8');
                    var efKeys = Object.keys(lastExtraFiles);
                    for (var ei = 0; ei < efKeys.length; ei++) {
                      fs.writeFileSync(path.join(sourcesDir, efKeys[ei]), lastExtraFiles[efKeys[ei]], 'utf-8');
                    }
                    ctx.addLog('compile', 'C# source saved to project-sources/' + ctx.taskId);
                  } catch(saveErr) {
                    ctx.addLog('compile', 'WARN: Failed to save C# source: ' + saveErr.message);
                  }

                  // Wave 2 / C2-C3: write handoff docs + storyboard images alongside C# source
                  try {
                    var handoffGen = require('../../lib/handoff-doc-generator.cjs');
                    var sourcesDirHd = path.join(config.SOURCES_DIR, ctx.taskId);
                    var projectJsonPath = path.join(config.PROJECTS_DIR, ctx.taskId + '.json');
                    if (fs.existsSync(projectJsonPath)) {
                      var project = JSON.parse(fs.readFileSync(projectJsonPath, 'utf-8'));
                      var docs = handoffGen.generateHandoffDocs(project, { dataDir: config.DATA_DIR });
                      fs.writeFileSync(path.join(sourcesDirHd, 'HANDOFF_README.md'), docs.handoffMd, 'utf-8');
                      fs.writeFileSync(path.join(sourcesDirHd, 'STORYBOARD.md'), docs.storyboardMd, 'utf-8');
                      var copiedImages = 0;
                      if (docs.imageFiles && docs.imageFiles.length) {
                        var imgDstDir = path.join(sourcesDirHd, 'storyboard-images');
                        fs.mkdirSync(imgDstDir, { recursive: true });
                        docs.imageFiles.forEach(function(im) {
                          try {
                            if (fs.existsSync(im.src)) {
                              fs.copyFileSync(im.src, path.join(sourcesDirHd, im.dstRel));
                              copiedImages++;
                            }
                          } catch(_) {}
                        });
                      }
                      ctx.addLog('compile', 'Handoff docs saved (HANDOFF_README.md + STORYBOARD.md + ' + copiedImages + ' images)');
                    } else {
                      ctx.addLog('compile', 'WARN: project JSON not found at ' + projectJsonPath + ' — handoff docs skipped');
                    }
                  } catch(handoffErr) {
                    ctx.addLog('compile', 'WARN: Handoff doc generation failed (non-blocking): ' + handoffErr.message);
                  }

                  return { done: true, result: { ok: true, buildTime: buildResult.buildTime, htmlSize: htmlData.length } };
                });
            }

            var buildError = buildResult.error || '';
            ctx.addLog('compile', 'Build failed: ' + buildError.slice(0, 1000));

            // 2026-04-27: deterministic CS0103 hallucination patcher (opt-in).
            // PATCH_ANALYZER_AUTO_STUB=safe injects null-guarded stubs for
            // hallucinated helpers (e.g. SafeSetText, top compile failure
            // at 60 occ/week). Default 'off' — analysis-only. Saves 1+ Sonnet
            // recode round per affected build.
            try {
              var patchAnalyzer = require('../patch-analyzer.cjs');
              var patched = patchAnalyzer.maybePatch(lastCsCode, buildError);
              if (patched.analysis && patched.analysis.totalCS0103 > 0) {
                var topNames = Object.keys(patched.analysis.undeclaredNames)
                  .map(function(n) { return n + '×' + patched.analysis.undeclaredNames[n]; })
                  .slice(0, 5).join(', ');
                ctx.addLog('compile', 'CS0103 analysis (' + patched.mode + '): ' +
                  patched.analysis.totalCS0103 + ' undeclared, top: ' + topNames);
              }
              if (patched.changed) {
                lastCsCode = patched.code;
                ctx.addLog('compile', 'Patch analyzer injected stubs: ' + patched.injected.join(', ') +
                  ' — retrying build before LLM recode');
                return { done: false }; // skip recode, let next loop iteration rebuild
              }
            } catch (e) {
              ctx.addLog('compile', 'Patch analyzer failed (non-blocking): ' + e.message);
            }

            // Same-error early exit: signature on first ~200 chars of error.
            // CS error codes (e.g. "CS0117") plus the offending identifier are typically captured here.
            // We count occurrences across ALL rounds (not just consecutive), so an A->B->A->B
            // oscillation also trips the gate once either signature reaches the threshold.
            var errSig = buildError.slice(0, 200);
            if (errSig) {
              errSigCounts[errSig] = (errSigCounts[errSig] || 0) + 1;
              if (errSigCounts[errSig] >= SAME_BUILD_ERROR_EXIT) {
                throw new Error('Build failed with same error ' + errSigCounts[errSig] + ' times across rounds — stopping (saves token budget): ' + errSig.slice(0, 160));
              }
            }

            if (round >= maxRounds) {
              throw new Error('Build failed after ' + maxRounds + ' fix attempts: ' + buildError.slice(0, 200));
            }

            ctx.addLog('compile', 'AI fixing build error (' + round + '/' + maxRounds + ')...');
            ctx.reportStatus('processing', { message: '[Linux] Build failed, AI fixing... (' + round + '/' + maxRounds + ')' });

            if (!ctx.blueprint.feedbackHistory) ctx.blueprint.feedbackHistory = [];
            ctx.blueprint.feedbackHistory.push({
              data: { text: 'Build compilation failed:\n' + buildError.slice(0, 1500) + '\nPlease fix the C# compilation errors.' },
              source: 'build-fix-attempt-' + round,
              status: 'pending',
              timestamp: Date.now(),
            });

            return recode({
              taskId: ctx.taskId,
              currentCode: lastCsCode,
              extraFiles: lastExtraFiles,
              blueprint: ctx.blueprint,
              label: 'buildfix',
              round: round,
              log: function(msg) { ctx.addLog('compile', msg); },
            }).then(function(result) {
              if (result.ok) {
                lastCsCode = result.code;
                // Pick up partial class files (e.g. Systems.cs) from recode
                if (result.extraFiles) {
                  for (var efn in result.extraFiles) {
                    if (result.extraFiles.hasOwnProperty(efn)) {
                      lastExtraFiles[efn] = result.extraFiles[efn];
                    }
                  }
                }
                ctx.addLog('compile', 'Build fix ' + round + ': got fixed code (' + lastCsCode.length + ' chars)');
              } else {
                ctx.addLog('compile', 'Build fix re-code failed: ' + result.error);
              }
              return { done: false };
            });
          });
      },
    });

    return loop.run(ctx);
  },
  _applyDeterministicBuildRepairs: applyDeterministicBuildRepairs,
  _stripDuplicateMoveSpeedMembers: stripDuplicateMoveSpeedMembers,
  _stripDuplicateMethodsInSource: stripDuplicateMethodsInSource,
  _repairAddResourceNegativeEvidence: repairAddResourceNegativeEvidence,
  _refreshCanonicalGfmUi: refreshCanonicalGfmUi,
};
