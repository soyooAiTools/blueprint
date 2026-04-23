function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === '') return [];
  return [value];
}

function uniq(list) {
  var seen = {};
  var out = [];
  for (var i = 0; i < (list || []).length; i++) {
    var value = list[i];
    if (value == null || value === '') continue;
    var key = String(value);
    if (seen[key]) continue;
    seen[key] = true;
    out.push(value);
  }
  return out;
}

function sanitizeId(value) {
  var text = String(value || '').replace(/[^A-Za-z0-9_]/g, '_');
  if (!text) return 'Slot';
  if (/^\d/.test(text)) text = '_' + text;
  return text;
}

function ownerTag(fileName) {
  var match = /GameFlowManagerMain\.([A-Za-z]+)\.cs$/.exec(String(fileName || ''));
  return match ? match[1] : 'File';
}

function prettyJson(value) {
  var json = JSON.stringify(value || {}, null, 2);
  return json === '{}' ? '{}' : json;
}

function indentBlock(text, prefix) {
  return String(text || '').split('\n').map(function(line) {
    return prefix + line;
  }).join('\n');
}

function indexModuleInstances(plans) {
  var items = plans && plans.assemblyPlan && Array.isArray(plans.assemblyPlan.moduleInstances)
    ? plans.assemblyPlan.moduleInstances
    : [];
  var index = {};
  for (var i = 0; i < items.length; i++) {
    index[items[i].id] = items[i];
  }
  return index;
}

function moduleInstancesForFile(plans, fileName) {
  var moduleIndex = indexModuleInstances(plans);
  var fileOwners = plans && plans.assemblyPlan && Array.isArray(plans.assemblyPlan.fileOwners)
    ? plans.assemblyPlan.fileOwners
    : [];
  for (var i = 0; i < fileOwners.length; i++) {
    if (fileOwners[i].file !== fileName) continue;
    return toArray(fileOwners[i].moduleInstanceIds).map(function(id) {
      return moduleIndex[id];
    }).filter(Boolean);
  }
  return [];
}

function buildPhaseBindingIndex(plans) {
  var bindings = plans && plans.assemblyPlan && Array.isArray(plans.assemblyPlan.phaseBindings)
    ? plans.assemblyPlan.phaseBindings
    : [];
  var index = {};
  for (var i = 0; i < bindings.length; i++) {
    index[bindings[i].phaseId] = bindings[i];
  }
  return index;
}

function moduleRelevantToPhase(moduleInstance, phaseBinding) {
  if (!moduleInstance || !phaseBinding) return false;
  var entity = String(moduleInstance.entity || '');
  if (entity && toArray(phaseBinding.activateEntities).indexOf(entity) >= 0) return true;

  var sourceAtomIds = toArray(moduleInstance.sourceAtomIds);
  var phaseAtomIds = toArray(phaseBinding.atomIds);
  for (var i = 0; i < sourceAtomIds.length; i++) {
    if (phaseAtomIds.indexOf(sourceAtomIds[i]) >= 0) return true;
  }
  return false;
}

function injectIntoMarkerBlock(content, startMarker, endMarker, blockText) {
  var text = String(content || '');
  var startIdx = text.indexOf(startMarker);
  var endIdx = text.indexOf(endMarker);
  if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) return text;
  var before = text.substring(0, startIdx + startMarker.length);
  var after = text.substring(endIdx);
  return before + '\n' + blockText + '\n    ' + after;
}

function appendBeforeFinalBrace(content, blockText) {
  var text = String(content || '');
  var endIdx = text.lastIndexOf('}');
  if (endIdx < 0) return text;
  return text.slice(0, endIdx) + '\n' + blockText + '\n' + text.slice(endIdx);
}

function injectMethodManifest(content, methodName, lines) {
  var text = String(content || '');
  var re = new RegExp('(void\\s+' + methodName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\([^)]*\\)\\s*\\{\\n)');
  var match = re.exec(text);
  if (!match) return text;
  var insertion = lines.join('\n') + '\n';
  return text.slice(0, match.index + match[1].length) + insertion + text.slice(match.index + match[1].length);
}

function buildOwnerManifestLines(fileName, moduleInstances, plans) {
  var phaseBindings = plans && plans.assemblyPlan && Array.isArray(plans.assemblyPlan.phaseBindings)
    ? plans.assemblyPlan.phaseBindings
    : [];
  var phaseIds = [];
  for (var i = 0; i < phaseBindings.length; i++) {
    for (var j = 0; j < moduleInstances.length; j++) {
      if (moduleRelevantToPhase(moduleInstances[j], phaseBindings[i])) {
        phaseIds.push(phaseBindings[i].phaseId);
        break;
      }
    }
  }
  return [
    '    // [ASSEMBLY OWNER MANIFEST] Deterministic scaffold generated from AssemblyPlan.',
    '    // ownerFile: ' + fileName,
    '    // moduleInstances: ' + (moduleInstances.length > 0 ? moduleInstances.map(function(item) { return item.id; }).join(', ') : '(none)'),
    '    // relevantPhases: ' + (phaseIds.length > 0 ? uniq(phaseIds).join(', ') : '(none)'),
  ];
}

function buildSlotMethod(fileName, moduleInstance) {
  var tag = ownerTag(fileName);
  var methodName = 'AssemblySlot_' + tag + '_' + sanitizeId(moduleInstance.id);
  var lines = [];
  lines.push('    // [ASSEMBLY SLOT] ' + moduleInstance.id);
  lines.push('    // moduleId: ' + moduleInstance.moduleId);
  lines.push('    // entity: ' + (moduleInstance.entity || 'system'));
  lines.push('    // ownerFile: ' + fileName);
  lines.push('    // statesWritten: ' + (toArray(moduleInstance.statesWritten).length > 0 ? toArray(moduleInstance.statesWritten).join(', ') : '(none)'));
  lines.push('    // sourceAtoms: ' + (toArray(moduleInstance.sourceAtomIds).length > 0 ? toArray(moduleInstance.sourceAtomIds).join(', ') : '(none)'));
  lines.push('    // params: ' + prettyJson(moduleInstance.params));
  lines.push('    void ' + methodName + '()');
  lines.push('    {');
  lines.push('        // TODO_' + methodName + '_START');
  lines.push('        // Implement only `' + moduleInstance.moduleId + '` for `' + (moduleInstance.entity || 'system') + '` in this owner file.');
  lines.push('        // This slot is generated deterministically from AssemblyPlan; keep logic local to this module.');
  lines.push('        // TODO_' + methodName + '_END');
  lines.push('    }');
  return lines.join('\n');
}

function buildOwnerSlotSection(fileName, moduleInstances, plans) {
  var lines = buildOwnerManifestLines(fileName, moduleInstances, plans);
  if (moduleInstances.length === 0) {
    lines.push('    // No module instances currently owned by this file.');
    return lines.join('\n');
  }

  lines.push('');
  lines.push('    // ========== Deterministic Assembly Slots ==========');
  for (var i = 0; i < moduleInstances.length; i++) {
    if (i > 0) lines.push('');
    lines.push(buildSlotMethod(fileName, moduleInstances[i]));
  }
  return lines.join('\n');
}

function buildPhaseCommentLines(fileName, phaseBinding, plans) {
  var fileModules = moduleInstancesForFile(plans, fileName).filter(function(moduleInstance) {
    return moduleRelevantToPhase(moduleInstance, phaseBinding);
  });
  var lines = [];
  lines.push('        // [ASSEMBLY PHASE] phaseId=' + phaseBinding.phaseId);
  lines.push('        // activateEntities: ' + (toArray(phaseBinding.activateEntities).length > 0 ? toArray(phaseBinding.activateEntities).join(', ') : '(none)'));
  lines.push('        // completionSignals: ' + (toArray(phaseBinding.completionSignals).length > 0 ? toArray(phaseBinding.completionSignals).join(', ') : '(none)'));
  if (fileModules.length > 0) {
    lines.push('        // ownerSlots(' + ownerTag(fileName) + '): ' + fileModules.map(function(item) { return item.id; }).join(', '));
  }
  return lines;
}

function annotateFlowPhaseMethods(flowCode, plans) {
  var content = String(flowCode || '');
  var phaseIndex = buildPhaseBindingIndex(plans);
  Object.keys(phaseIndex).forEach(function(phaseId) {
    var suffix = sanitizeId(String(phaseId || '').replace(/[^A-Za-z0-9]/g, ''));
    content = injectMethodManifest(
      content,
      'Phase_' + suffix + '_Init',
      buildPhaseCommentLines('GameFlowManagerMain.Flow.cs', phaseIndex[phaseId], plans)
    );
    content = injectMethodManifest(
      content,
      'Phase_' + suffix + '_OnTap',
      buildPhaseCommentLines('GameFlowManagerMain.Flow.cs', phaseIndex[phaseId], plans).concat([
        '        // cuaActions: ' + summarizePhaseActions(plans, phaseId),
      ])
    );
    content = injectMethodManifest(
      content,
      'Phase_' + suffix + '_OnAutoPlayArrive',
      buildPhaseCommentLines('GameFlowManagerMain.Flow.cs', phaseIndex[phaseId], plans).concat([
        '        // cuaActions: ' + summarizePhaseActions(plans, phaseId),
      ])
    );
  });
  return content;
}

function summarizePhaseActions(plans, phaseId) {
  var steps = plans && plans.cuaPlan && Array.isArray(plans.cuaPlan.steps) ? plans.cuaPlan.steps : [];
  for (var i = 0; i < steps.length; i++) {
    if (steps[i].phaseId !== phaseId) continue;
    var labels = [];
    var actions = toArray(steps[i].actions);
    for (var j = 0; j < actions.length; j++) {
      var action = actions[j] || {};
      var kind = String(action.kind || action.type || '').trim();
      var target = action.target || action.to || action.item || '';
      labels.push(target ? kind + ':' + target : kind);
    }
    return labels.length > 0 ? labels.join(', ') : '(none)';
  }
  return '(none)';
}

function normalizeNewlines(text) {
  return String(text || '').replace(/\r\n/g, '\n');
}

function slotRegionRegex(slotId) {
  var escaped = String(slotId || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^[ \\t]*)\\/\\/ TODO_' + escaped + '_START\\s*\\n([\\s\\S]*?)^\\1\\/\\/ TODO_' + escaped + '_END', 'm');
}

function extractAssemblySlotRegions(content) {
  var text = normalizeNewlines(content);
  var re = /(^[ \t]*)\/\/ TODO_(AssemblySlot_[A-Za-z0-9_]+)_START\s*\n([\s\S]*?)^\1\/\/ TODO_\2_END/gm;
  var regions = {};
  var ids = [];
  var match;
  while ((match = re.exec(text))) {
    ids.push(match[2]);
    regions[match[2]] = {
      id: match[2],
      indent: match[1] || '',
      body: match[3] || '',
    };
  }
  return {
    ids: ids,
    regions: regions,
  };
}

function maskAssemblySlotBodies(content) {
  return normalizeNewlines(content).replace(
    /(^[ \t]*)\/\/ TODO_(AssemblySlot_[A-Za-z0-9_]+)_START\s*\n([\s\S]*?)^\1\/\/ TODO_\2_END/gm,
    function(_match, indent, slotId) {
      return indent + '// TODO_' + slotId + '_START\n' +
        indent + '// [ASSEMBLY SLOT BODY REDACTED]\n' +
        indent + '// TODO_' + slotId + '_END';
    }
  );
}

function replaceAssemblySlotRegion(content, slotId, nextBody) {
  var text = normalizeNewlines(content);
  var re = slotRegionRegex(slotId);
  return text.replace(re, function(_match, indent) {
    var body = String(nextBody || '');
    if (body && !/\n$/.test(body)) body += '\n';
    return indent + '// TODO_' + slotId + '_START\n' + body + indent + '// TODO_' + slotId + '_END';
  });
}

function mergeAssemblySlotEdits(baselineContent, generatedContent) {
  var baseline = normalizeNewlines(baselineContent);
  var generated = normalizeNewlines(generatedContent);
  var baselineRegions = extractAssemblySlotRegions(baseline);
  var generatedRegions = extractAssemblySlotRegions(generated);
  var merged = baseline;
  var preservedSlotCount = 0;
  var strippedEditCount = 0;
  var droppedSlotIds = [];

  if (baselineRegions.ids.length === 0) {
    if (generated !== baseline) strippedEditCount = 1;
    return {
      content: baseline,
      preservedSlotCount: 0,
      strippedEditCount: strippedEditCount,
      droppedSlotIds: droppedSlotIds,
    };
  }

  var maskedBaseline = maskAssemblySlotBodies(baseline);
  var maskedGenerated = maskAssemblySlotBodies(generated);
  if (maskedBaseline !== maskedGenerated) {
    strippedEditCount++;
  }

  for (var i = 0; i < baselineRegions.ids.length; i++) {
    var slotId = baselineRegions.ids[i];
    var nextRegion = generatedRegions.regions[slotId];
    if (!nextRegion) continue;
    if (normalizeNewlines(nextRegion.body) !== normalizeNewlines(baselineRegions.regions[slotId].body)) {
      preservedSlotCount++;
    }
    merged = replaceAssemblySlotRegion(merged, slotId, nextRegion.body);
  }

  for (var j = 0; j < generatedRegions.ids.length; j++) {
    var extraSlotId = generatedRegions.ids[j];
    if (baselineRegions.regions[extraSlotId]) continue;
    droppedSlotIds.push(extraSlotId);
  }
  if (droppedSlotIds.length > 0) strippedEditCount += droppedSlotIds.length;

  return {
    content: merged,
    preservedSlotCount: preservedSlotCount,
    strippedEditCount: strippedEditCount,
    droppedSlotIds: droppedSlotIds,
  };
}

function applyAssemblyPlanToSkeleton(skeletonResult, plans) {
  if (!skeletonResult || typeof skeletonResult !== 'object' || !plans || !plans.assemblyPlan) {
    return {
      files: skeletonResult,
      slotCount: 0,
      ownerSummary: {},
    };
  }

  var files = Object.assign({}, skeletonResult);
  var ownerFiles = [
    'GameFlowManagerMain.Flow.cs',
    'GameFlowManagerMain.Input.cs',
    'GameFlowManagerMain.Resource.cs',
    'GameFlowManagerMain.UI.cs',
    'GameFlowManagerMain.Scene.cs',
  ];
  var contentByFile = {
    'GameFlowManagerMain.Flow.cs': files.flow,
    'GameFlowManagerMain.Input.cs': files.input,
    'GameFlowManagerMain.Resource.cs': files.resource,
    'GameFlowManagerMain.UI.cs': files.ui,
    'GameFlowManagerMain.Scene.cs': files.scene,
  };
  var ownerSummary = {};
  var slotCount = 0;

  for (var i = 0; i < ownerFiles.length; i++) {
    var fileName = ownerFiles[i];
    var moduleInstances = moduleInstancesForFile(plans, fileName);
    ownerSummary[fileName] = moduleInstances.map(function(item) { return item.id; });
    slotCount += moduleInstances.length;
    var section = buildOwnerSlotSection(fileName, moduleInstances, plans);

    if (fileName === 'GameFlowManagerMain.Flow.cs') {
      contentByFile[fileName] = appendBeforeFinalBrace(annotateFlowPhaseMethods(contentByFile[fileName], plans), section);
    } else if (fileName === 'GameFlowManagerMain.Input.cs') {
      contentByFile[fileName] = injectIntoMarkerBlock(contentByFile[fileName], '// TODO_INPUT_METHODS_START', '// TODO_INPUT_METHODS_END', section);
    } else if (fileName === 'GameFlowManagerMain.Resource.cs') {
      contentByFile[fileName] = injectIntoMarkerBlock(contentByFile[fileName], '// TODO_RESOURCE_METHODS_START', '// TODO_RESOURCE_METHODS_END', section);
    } else if (fileName === 'GameFlowManagerMain.UI.cs') {
      contentByFile[fileName] = injectIntoMarkerBlock(contentByFile[fileName], '// TODO_UI_START', '// TODO_UI_END', section);
    } else if (fileName === 'GameFlowManagerMain.Scene.cs') {
      contentByFile[fileName] = appendBeforeFinalBrace(contentByFile[fileName], section);
    }
  }

  files.flow = contentByFile['GameFlowManagerMain.Flow.cs'];
  files.input = contentByFile['GameFlowManagerMain.Input.cs'];
  files.resource = contentByFile['GameFlowManagerMain.Resource.cs'];
  files.ui = contentByFile['GameFlowManagerMain.UI.cs'];
  files.scene = contentByFile['GameFlowManagerMain.Scene.cs'];

  return {
    files: files,
    slotCount: slotCount,
    ownerSummary: ownerSummary,
  };
}

module.exports = {
  applyAssemblyPlanToSkeleton: applyAssemblyPlanToSkeleton,
  extractAssemblySlotRegions: extractAssemblySlotRegions,
  mergeAssemblySlotEdits: mergeAssemblySlotEdits,
  moduleInstancesForFile: moduleInstancesForFile,
  ownerTag: ownerTag,
  sanitizeId: sanitizeId,
};
