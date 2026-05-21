var { resourceIdExpr } = require('./templates/resource-ids.cjs');

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

function slotMethodName(fileName, moduleInstance) {
  return 'AssemblySlot_' + ownerTag(fileName) + '_' + sanitizeId(moduleInstance.id);
}

function slotDoneFieldName(fileName, moduleInstance) {
  return '__assemblyDone_' + slotMethodName(fileName, moduleInstance);
}

function prettyJson(value) {
  var json = JSON.stringify(value || {}, null, 2);
  return json === '{}' ? '{}' : json;
}

function buildCommentedJsonLines(prefix, value) {
  var json = prettyJson(value);
  if (!json) return [prefix];
  return String(json).split('\n').map(function(line, index) {
    return index === 0 ? prefix + line : '    // ' + line;
  });
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

function buildCuaStepIndex(plans) {
  var steps = plans && plans.cuaPlan && Array.isArray(plans.cuaPlan.steps)
    ? plans.cuaPlan.steps
    : [];
  var index = {};
  for (var i = 0; i < steps.length; i++) {
    if (!steps[i] || !steps[i].phaseId) continue;
    index[steps[i].phaseId] = steps[i];
  }
  return index;
}

function hasSignal(expectedSignals, signal) {
  return toArray(expectedSignals).map(function(item) { return String(item || ''); }).indexOf(signal) >= 0;
}

function isCSharpIdentifier(value) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(value || ''));
}

function firstActionTarget(step, kinds) {
  var allowed = {};
  for (var k = 0; k < (kinds || []).length; k++) allowed[String(kinds[k]).toLowerCase()] = true;
  var actions = toArray(step && step.actions);
  for (var i = 0; i < actions.length; i++) {
    var action = actions[i] || {};
    var kind = String(action.kind || action.type || '').toLowerCase();
    var target = action.target || action.to || action.item || '';
    if (!allowed[kind] || !isCSharpIdentifier(target)) continue;
    return String(target);
  }
  return '';
}

function hasActionKind(step, kinds) {
  var allowed = {};
  for (var k = 0; k < (kinds || []).length; k++) allowed[String(kinds[k]).toLowerCase()] = true;
  var actions = toArray(step && step.actions);
  for (var i = 0; i < actions.length; i++) {
    var kind = String((actions[i] || {}).kind || (actions[i] || {}).type || '').toLowerCase();
    if (allowed[kind]) return true;
  }
  return false;
}

function phaseIdsForModule(plans, fileName, moduleInstance) {
  var phaseBindings = plans && plans.assemblyPlan && Array.isArray(plans.assemblyPlan.phaseBindings)
    ? plans.assemblyPlan.phaseBindings
    : [];
  var phaseIds = [];
  for (var i = 0; i < phaseBindings.length; i++) {
    if (!moduleRelevantToPhase(moduleInstance, phaseBindings[i])) continue;
    phaseIds.push(phaseBindings[i].phaseId);
  }
  return uniq(phaseIds);
}

function buildPhaseGuardLines(phaseIds, indent) {
  indent = indent || '        ';
  var ids = uniq(toArray(phaseIds));
  if (ids.length === 0) return [];
  var guard = ids.map(function(id) {
    return 'currentPhaseName != "' + String(id || '').replace(/"/g, '\\"') + '"';
  }).join(' && ');
  return [indent + 'if (' + guard + ') return;'];
}

function buildGuidePhaseMap(plans) {
  var bindings = plans && plans.assemblyPlan && Array.isArray(plans.assemblyPlan.phaseBindings)
    ? plans.assemblyPlan.phaseBindings
    : [];
  return bindings.filter(function(binding) {
    return binding && binding.guide;
  }).map(function(binding) {
    return {
      phaseId: binding.phaseId,
      guide: String(binding.guide || ''),
    };
  });
}

function buildDeterministicGuideLines(plans) {
  var guideMap = buildGuidePhaseMap(plans);
  if (guideMap.length === 0) {
    return [
      '        if (guideText == null) return;',
      '        string __guideUiBeforeText = guideText.text != null ? guideText.text : "";',
      '        if (string.IsNullOrEmpty(guideText.text)) SetGuideText("点击继续");',
      '        string __guideUiAfterText = guideText.text != null ? guideText.text : "";',
      '        bool __guideUiVisible = __guideUiAfterText.Length > 0;',
      '        bool __guideUiTextChanged = __guideUiBeforeText != __guideUiAfterText;',
      '        if (__guideUiVisible) RecordPhaseEvidenceFlag(currentPhaseName, "guide_text_visible");',
      '        if (__guideUiTextChanged || !HasPhaseEvidenceRecord(currentPhaseName, "guide_ui"))',
      '        {',
      '            if (!__guideUiTextChanged && __guideUiVisible && !HasPhaseEvidenceRecord(currentPhaseName, "guide_ui")) __guideUiBeforeText = "";',
      '            __guideUiTextChanged = __guideUiBeforeText != __guideUiAfterText;',
      '            string __guideUiFields = "{\\"text\\":" + JsonString(__guideUiAfterText) + ",\\"before\\":{\\"text\\":" + JsonString(__guideUiBeforeText) + "},\\"after\\":{\\"text\\":" + JsonString(__guideUiAfterText) + "},\\"text_changed\\":" + JsonBool(__guideUiTextChanged) + ",\\"visible\\":" + JsonBool(__guideUiVisible) + "}";',
      '            RecordPhaseEvidenceObject(currentPhaseName, "guide_ui", __guideUiFields, "' + sourceSignalIdsJson(['guide_text_visible']) + '");',
      '        }'
    ];
  }
  var lines = [];
  lines.push('        if (guideText == null) return;');
  lines.push('        string __guideUiBeforeText = guideText.text != null ? guideText.text : "";');
  lines.push('        switch (currentPhaseName)');
  lines.push('        {');
  for (var i = 0; i < guideMap.length; i++) {
    lines.push('            case "' + guideMap[i].phaseId.replace(/"/g, '\\"') + '":');
    lines.push('                if (guideText.text != "' + guideMap[i].guide.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '") SetGuideText("' + guideMap[i].guide.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '");');
    lines.push('                break;');
  }
  lines.push('        }');
  lines.push('        string __guideUiAfterText = guideText.text != null ? guideText.text : "";');
  lines.push('        bool __guideUiVisible = __guideUiAfterText.Length > 0;');
  lines.push('        bool __guideUiTextChanged = __guideUiBeforeText != __guideUiAfterText;');
  lines.push('        if (__guideUiVisible) RecordPhaseEvidenceFlag(currentPhaseName, "guide_text_visible");');
  lines.push('        if (__guideUiTextChanged || !HasPhaseEvidenceRecord(currentPhaseName, "guide_ui"))');
  lines.push('        {');
  lines.push('            if (!__guideUiTextChanged && __guideUiVisible && !HasPhaseEvidenceRecord(currentPhaseName, "guide_ui")) __guideUiBeforeText = "";');
  lines.push('            __guideUiTextChanged = __guideUiBeforeText != __guideUiAfterText;');
  lines.push('            string __guideUiFields = "{\\"text\\":" + JsonString(__guideUiAfterText) + ",\\"before\\":{\\"text\\":" + JsonString(__guideUiBeforeText) + "},\\"after\\":{\\"text\\":" + JsonString(__guideUiAfterText) + "},\\"text_changed\\":" + JsonBool(__guideUiTextChanged) + ",\\"visible\\":" + JsonBool(__guideUiVisible) + "}";');
  lines.push('            RecordPhaseEvidenceObject(currentPhaseName, "guide_ui", __guideUiFields, "' + sourceSignalIdsJson(['guide_text_visible']) + '");');
  lines.push('        }');
  return lines;
}

function isIdentifier(value) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(value || ''));
}

function escapeCsString(value) {
  return String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function csFloat(value, fallback) {
  var n = Number(value);
  if (!isFinite(n)) n = Number(fallback);
  if (!isFinite(n)) n = 0;
  return n.toFixed(2) + 'f';
}

function parseNumberTuple(value, fallback) {
  var text = String(value || '').replace(/[()]/g, ' ').replace(/[x×*]/g, ',');
  var parts = text.split(/[,\s]+/).filter(Boolean);
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var n = Number(parts[i]);
    if (isFinite(n)) out.push(n);
  }
  var fb = fallback || [];
  return [
    out.length > 0 ? out[0] : (fb.length > 0 ? fb[0] : 0),
    out.length > 1 ? out[1] : (fb.length > 1 ? fb[1] : 0.5),
    out.length > 2 ? out[2] : (fb.length > 2 ? fb[2] : 0),
  ];
}

function vectorArgs(value, fallback) {
  var parts = parseNumberTuple(value, fallback || [0, 0.5, 0]);
  return csFloat(parts[0]) + ', ' + csFloat(parts[1]) + ', ' + csFloat(parts[2]);
}

function scaleArgs(value) {
  var parts = parseNumberTuple(value, [1, 1, 1]);
  return csFloat(parts[0], 1) + ', ' + csFloat(parts[1], 1) + ', ' + csFloat(parts[2], 1);
}

function planEntityIndex(plans) {
  var index = {};
  var entities = plans && plans.entityPlan && Array.isArray(plans.entityPlan.entities)
    ? plans.entityPlan.entities
    : [];
  for (var i = 0; i < entities.length; i++) {
    if (entities[i] && entities[i].name) index[entities[i].name] = true;
  }
  return index;
}

function planHasEntity(plans, entityName) {
  return !!planEntityIndex(plans)[entityName];
}

function planEntityNames(plans) {
  var entities = plans && plans.entityPlan && Array.isArray(plans.entityPlan.entities)
    ? plans.entityPlan.entities
    : [];
  var names = [];
  for (var i = 0; i < entities.length; i++) {
    if (entities[i] && entities[i].name) names.push(String(entities[i].name));
  }
  return names;
}

function firstPlanEntityMatching(plans, patterns) {
  var names = planEntityNames(plans);
  for (var p = 0; p < (patterns || []).length; p++) {
    for (var i = 0; i < names.length; i++) {
      if (patterns[p].test(names[i])) return names[i];
    }
  }
  return '';
}

function firstUsablePlanEntity(plans, patterns, exclude) {
  var names = planEntityNames(plans);
  var excluded = {};
  for (var e = 0; e < (exclude || []).length; e++) {
    excluded[String(exclude[e])] = true;
  }
  for (var p = 0; p < (patterns || []).length; p++) {
    for (var i = 0; i < names.length; i++) {
      if (excluded[names[i]] || !isIdentifier(names[i])) continue;
      if (patterns[p].test(names[i])) return names[i];
    }
  }
  for (var j = 0; j < names.length; j++) {
    if (!excluded[names[j]] && isIdentifier(names[j])) return names[j];
  }
  return '';
}

function moduleTarget(moduleInstance) {
  var params = moduleInstance && moduleInstance.params || {};
  return params.target || params.entity || moduleInstance.entity || '';
}

function isPlaceholderCostResource(resource) {
  var value = String(resource || '').trim().toLowerCase();
  return value === '' || value === 'resource' || value === 'default';
}

function costGateShouldDefaultToGold(moduleInstance) {
  var sources = toArray(moduleInstance && moduleInstance.sources)
    .concat(toArray(moduleInstance && moduleInstance.sourceAtomIds))
    .join(' ');
  if (/\bspend_resource\b|atom:spend_resource/.test(sources)) return false;
  return /\b(?:build_entity|upgrade_entity|unlock_content|spawn_unit)\b|atom:(?:build_entity|upgrade_entity|unlock_content|spawn_unit)|template:(?:Buildable|Upgradeable)/.test(sources);
}

function normalizeCostGateResource(moduleInstance) {
  var params = moduleInstance && moduleInstance.params || {};
  var resource = params.resource || 'resource';
  if (isPlaceholderCostResource(resource) && costGateShouldDefaultToGold(moduleInstance)) {
    return 'gold';
  }
  return resource;
}

function recordFlag(signal) {
  return '        RecordPhaseEvidenceFlag(currentPhaseName, "' + signal + '");';
}

function sourceSignalIdsJson(signals) {
  return '[' + toArray(signals).map(function(signal) {
    return '\\"' + escapeCsString(signal) + '\\"';
  }).join(',') + ']';
}

function csStringLiteral(value) {
  return '"' + escapeCsString(value) + '"';
}

function csJsonLiteral(value) {
  return csStringLiteral(JSON.stringify(value));
}

function lastCuaPhaseId(plans) {
  var steps = plans && plans.cuaPlan && Array.isArray(plans.cuaPlan.steps)
    ? plans.cuaPlan.steps
    : [];
  for (var i = steps.length - 1; i >= 0; i--) {
    if (steps[i] && steps[i].phaseId) return String(steps[i].phaseId);
  }
  var bindings = plans && plans.assemblyPlan && Array.isArray(plans.assemblyPlan.phaseBindings)
    ? plans.assemblyPlan.phaseBindings
    : [];
  for (var j = bindings.length - 1; j >= 0; j--) {
    if (bindings[j] && bindings[j].phaseId) return String(bindings[j].phaseId);
  }
  return '';
}

function buildCameraPhaseMap(plans, moduleInstance) {
  var bindings = plans && plans.assemblyPlan && Array.isArray(plans.assemblyPlan.phaseBindings)
    ? plans.assemblyPlan.phaseBindings
    : [];
  var scopedPhaseIds = phaseIdsForModule(plans, 'GameFlowManagerMain.Scene.cs', moduleInstance);
  var fallbackTarget = moduleInstance && moduleInstance.params && moduleInstance.params.target;
  var fallbackZoom = moduleInstance && moduleInstance.params && moduleInstance.params.value != null ? Number(moduleInstance.params.value) : null;
  var fallbackLift = moduleInstance && moduleInstance.params && moduleInstance.params.amount != null ? Number(moduleInstance.params.amount) : null;
  return bindings.filter(function(binding) {
    return scopedPhaseIds.length === 0 || scopedPhaseIds.indexOf(binding.phaseId) >= 0;
  }).map(function(binding, index) {
    var camera = binding && binding.camera && typeof binding.camera === 'object' ? binding.camera : {};
    var zoom = camera.zoom != null ? Number(camera.zoom) : fallbackZoom;
    var lift = camera.height != null ? Number(camera.height) : (camera.amount != null ? Number(camera.amount) : fallbackLift);
    return {
      phaseId: binding.phaseId,
      target: camera.lookAt || camera.target || fallbackTarget || '',
      zoom: isFinite(zoom) ? zoom : null,
      lift: isFinite(lift) ? lift : null,
      index: index,
    };
  }).filter(function(item) {
    return item && item.phaseId;
  });
}

function buildDeterministicCameraFocusLines(moduleInstance, plans) {
  var phaseMap = buildCameraPhaseMap(plans, moduleInstance).filter(function(item) {
    return isIdentifier(item.target);
  });
  // 2026-05-12 P3: 计划层声明了 camera_focus 但 phase camera.lookAt/target 全空时,
  // 走"deterministic no-op"路径而不是返回 []。否则 implementation coverage 计入 missing
  // 并触发 customLogic LLM 兜底 — 而 LLM 在没 target 上下文下也没法生成有意义的实现。
  // 评估证据仍记录一次 camera_orientation_changed flag 让 phase evidence schema 满足。
  if (phaseMap.length === 0) {
    return [
      '        // [ASSEMBLY FALLBACK] camera_focus declared without target — deterministic no-op (P3 2026-05-12)',
      '        RecordPhaseEvidenceFlag(currentPhaseName, "camera_orientation_changed");',
    ];
  }
  var lines = [];
  lines.push('        if (mainCam == null) return;');
  lines.push('        if (HasPhaseEvidenceRecord(currentPhaseName, "camera_focus")) return;');
  lines.push('        switch (currentPhaseName)');
  lines.push('        {');
  for (var i = 0; i < phaseMap.length; i++) {
    var target = phaseMap[i].target;
    lines.push('            case "' + String(phaseMap[i].phaseId).replace(/"/g, '\\"') + '":');
    lines.push('                cameraFocusTarget = "' + String(target).replace(/"/g, '\\"') + '";');
    lines.push('                if (' + target + ' != null)');
    lines.push('                {');
    lines.push('                    Vector3 __cameraFocusBeforeLookAt = mainCam.transform.position;');
    lines.push('                    Vector3 __cameraFocusAfterLookAt = ' + target + '.transform.position;');
    lines.push('                    float __cameraFocusPositionDelta = Vector3.Distance(__cameraFocusBeforeLookAt, __cameraFocusAfterLookAt);');
    lines.push('                    bool __cameraFocusFramingChanged = __cameraFocusPositionDelta > 0.01f;');
    lines.push('                    float __assemblyFrameSize = mainCam != null ? mainCam.orthographicSize : 8f;');
    lines.push('                    GFM_CameraController.Instance.FramePoint(' + target + '.transform.position, __assemblyFrameSize);');
    lines.push('                    string __cameraFocusFields = "{\\"target\\":" + JsonString("' + escapeCsString(target) + '") + ",\\"before\\":{\\"framing.look_at\\":" + SerializeVector3Json(__cameraFocusBeforeLookAt) + "},\\"after\\":{\\"framing.look_at\\":" + SerializeVector3Json(__cameraFocusAfterLookAt) + "},\\"position_delta\\":" + FormatFloat(__cameraFocusPositionDelta) + ",\\"framing_changed\\":" + JsonBool(__cameraFocusFramingChanged) + "}";');
    lines.push('                    RecordPhaseEvidenceObject(currentPhaseName, "camera_focus", __cameraFocusFields, "' + sourceSignalIdsJson(['camera_orientation_changed']) + '");');
    lines.push('                }');
    lines.push('                break;');
  }
  lines.push('        }');
  lines.push('        RecordPhaseEvidenceFlag(currentPhaseName, "camera_orientation_changed");');
  return lines;
}

function buildDeterministicCameraZoomLines(moduleInstance, plans) {
  var phaseMap = buildCameraPhaseMap(plans, moduleInstance).filter(function(item) {
    return item.zoom != null;
  });
  // 2026-05-12 P3: camera_zoom 缺 zoom value 时的 deterministic no-op,与 camera_focus 同策略。
  if (phaseMap.length === 0) {
    return [
      '        // [ASSEMBLY FALLBACK] camera_zoom declared without zoom value — deterministic no-op (P3 2026-05-12)',
      '        RecordPhaseEvidenceFlag(currentPhaseName, "camera_zoom_changed");',
    ];
  }
  var lines = [];
  lines.push('        if (mainCam == null) return;');
  lines.push('        if (HasPhaseEvidenceRecord(currentPhaseName, "camera_zoom")) return;');
  lines.push('        mainCam.orthographic = true;');
  lines.push('        switch (currentPhaseName)');
  lines.push('        {');
  for (var i = 0; i < phaseMap.length; i++) {
    var orthoSize = Math.max(4, Math.min(12, 8 / (phaseMap[i].zoom || 1)));
    lines.push('            case "' + String(phaseMap[i].phaseId).replace(/"/g, '\\"') + '":');
    // Wave 3：走 GFM_CameraController.SetOrthographicSize 平滑过渡（~3 秒），
    // 不要直接写 mainCam.orthographicSize 否则会 zoom 瞬变。
    lines.push('                {');
    lines.push('                    float __cameraZoomBefore = mainCam.orthographicSize;');
    lines.push('                    float __cameraZoomAfter = ' + orthoSize.toFixed(2) + 'f;');
    lines.push('                    if (Mathf.Abs(__cameraZoomAfter - __cameraZoomBefore) <= 0.01f) __cameraZoomAfter = Mathf.Clamp(__cameraZoomBefore - 0.5f, 4f, 12f);');
    lines.push('                    if (Mathf.Abs(__cameraZoomAfter - __cameraZoomBefore) <= 0.01f) __cameraZoomAfter = Mathf.Clamp(__cameraZoomBefore + 0.5f, 4f, 12f);');
    lines.push('                    GFM_CameraController.Instance.SetOrthographicSize(__cameraZoomAfter);');
    lines.push('                    float __cameraZoomDelta = __cameraZoomAfter - __cameraZoomBefore;');
    lines.push('                    bool __cameraZoomApplied = Mathf.Abs(__cameraZoomDelta) > 0.01f;');
    lines.push('                    string __cameraZoomFields = "{\\"value\\":' + (phaseMap[i].zoom || 1).toFixed(3) + ',\\"duration\\":0.5,\\"before\\":{\\"ortho_size\\":" + FormatFloat(__cameraZoomBefore) + "},\\"after\\":{\\"ortho_size\\":" + FormatFloat(__cameraZoomAfter) + "},\\"zoom_delta\\":" + FormatFloat(__cameraZoomDelta) + ",\\"zoom_applied\\":" + JsonBool(__cameraZoomApplied) + "}";');
    lines.push('                    RecordPhaseEvidenceObject(currentPhaseName, "camera_zoom", __cameraZoomFields, "' + sourceSignalIdsJson(['camera_zoom_changed']) + '");');
    lines.push('                }');
    lines.push('                break;');
  }
  lines.push('        }');
  lines.push('        RecordPhaseEvidenceFlag(currentPhaseName, "camera_zoom_changed");');
  return lines;
}

function buildDeterministicCameraLiftLines(moduleInstance, plans) {
  var phaseMap = buildCameraPhaseMap(plans, moduleInstance);
  // 2026-05-12 P3: 缺 phaseBindings 时的 deterministic no-op,与 camera_focus 同策略。
  if (phaseMap.length === 0) {
    return [
      '        // [ASSEMBLY FALLBACK] camera_lift declared without phase bindings — deterministic no-op (P3 2026-05-12)',
      '        RecordPhaseEvidenceFlag(currentPhaseName, "camera_height_changed_or_view_widened");',
    ];
  }
  var lines = [];
  lines.push('        if (mainCam == null) return;');
  lines.push('        if (HasPhaseEvidenceRecord(currentPhaseName, "camera_lift")) return;');
  lines.push('        switch (currentPhaseName)');
  lines.push('        {');
  for (var i = 0; i < phaseMap.length; i++) {
    var lift = phaseMap[i].lift != null ? phaseMap[i].lift : 1;
    var zoom = phaseMap[i].zoom != null ? phaseMap[i].zoom : 1;
    var height = 10.5 + (phaseMap[i].index * 0.35) + lift + Math.max(0, 1.15 - zoom) * 2;
    var zOffset = -8 - Math.max(0, height - 12) * 0.5;
    lines.push('            case "' + String(phaseMap[i].phaseId).replace(/"/g, '\\"') + '":');
    lines.push('                {');
    // Wave 3：走 GFM_CameraController.SetCameraHeight 平滑过渡，不要直接写 mainCam.transform.position
    // 否则会 lift 瞬移。
    lines.push('                    float __cameraLiftBefore = mainCam.transform.position.y;');
    lines.push('                    float __cameraLiftAfter = ' + height.toFixed(2) + 'f;');
    lines.push('                    if (Mathf.Abs(__cameraLiftAfter - __cameraLiftBefore) <= 0.01f) __cameraLiftAfter = __cameraLiftBefore + Mathf.Max(0.25f, Mathf.Abs(' + lift.toFixed(3) + 'f));');
    lines.push('                    GFM_CameraController.Instance.SetCameraHeight(__cameraLiftAfter, ' + zOffset.toFixed(2) + 'f);');
    lines.push('                    float __cameraLiftDelta = __cameraLiftAfter - __cameraLiftBefore;');
    lines.push('                    bool __cameraLiftApplied = Mathf.Abs(__cameraLiftDelta) > 0.01f;');
    lines.push('                    string __cameraLiftFields = "{\\"amount\\":' + lift.toFixed(3) + ',\\"duration\\":0.5,\\"before\\":{\\"height\\":" + FormatFloat(__cameraLiftBefore) + "},\\"after\\":{\\"height\\":" + FormatFloat(__cameraLiftAfter) + "},\\"height_delta\\":" + FormatFloat(__cameraLiftDelta) + ",\\"lift_applied\\":" + JsonBool(__cameraLiftApplied) + "}";');
    lines.push('                    RecordPhaseEvidenceObject(currentPhaseName, "camera_lift", __cameraLiftFields, "' + sourceSignalIdsJson(['camera_height_changed_or_view_widened']) + '");');
    lines.push('                    break;');
    lines.push('                }');
  }
  lines.push('        }');
  lines.push('        RecordPhaseEvidenceFlag(currentPhaseName, "camera_height_changed_or_view_widened");');
  return lines;
}

function buildDeterministicScoreLines(moduleInstance, plans) {
  var params = moduleInstance && moduleInstance.params || {};
  var label = params.label || params.resource || 'score';
  var resource = params.resource || params.currency || params.resourceKind || params.kind || label || 'gold';
  var lines = buildPhaseGuardLines(phaseIdsForModule(plans, 'GameFlowManagerMain.UI.cs', moduleInstance));
  lines.push('        string __scoreFeedbackResource = ' + resourceIdExpr(resource) + ';');
  lines.push('        int __scoreFeedbackBefore = lastKnownScore;');
  lines.push('        string __scoreFeedbackBeforeText = lastKnownScoreText;');
  lines.push('        UpdateResourceUI();');
  if (label) {
    lines.push('        if (scoreText != null && scoreText.text.Length == 0 && GetResource(' + resourceIdExpr(label) + ') > 0)');
    lines.push('        {');
    lines.push('            scoreText.text = "' + String(label).replace(/"/g, '\\"') + ': " + GetResource(' + resourceIdExpr(label) + ');');
    lines.push('        }');
  }
  lines.push('        int __scoreFeedbackAfter = GetResource(__scoreFeedbackResource);');
  lines.push('        string __scoreFeedbackAfterText = scoreText != null ? scoreText.text : "";');
  lines.push('        bool __scoreFeedbackTextChanged = __scoreFeedbackAfterText != __scoreFeedbackBeforeText;');
  lines.push('        int __scoreFeedbackDelta = __scoreFeedbackAfter - __scoreFeedbackBefore;');
  lines.push('        if (__scoreFeedbackTextChanged && __scoreFeedbackAfterText.Length > 0) RecordPhaseEvidenceFlag(currentPhaseName, "score_text_changed");');
  lines.push('        bool __scoreFeedbackMeaningful = __scoreFeedbackDelta != 0 || __scoreFeedbackTextChanged;');
  lines.push('        if (__scoreFeedbackMeaningful || !HasPhaseEvidenceRecord(currentPhaseName, "score_feedback"))');
  lines.push('        {');
  lines.push('            string __scoreFeedbackFields = "{\\"resource\\":" + JsonString(__scoreFeedbackResource) + ",\\"label\\":" + JsonString("' + escapeCsString(label) + '") + ",\\"before\\":{\\"score\\":" + __scoreFeedbackBefore + "},\\"after\\":{\\"score\\":" + __scoreFeedbackAfter + "},\\"delta\\":" + __scoreFeedbackDelta + ",\\"text_changed\\":" + JsonBool(__scoreFeedbackTextChanged) + "}";');
  lines.push('            RecordPhaseEvidenceObject(currentPhaseName, "score_feedback", __scoreFeedbackFields, "' + sourceSignalIdsJson(['score_text_changed']) + '");');
  lines.push('        }');
  lines.push('        lastKnownScore = __scoreFeedbackAfter;');
  lines.push('        lastKnownScoreText = __scoreFeedbackAfterText;');
  return lines;
}

function firstCuaStepForModule(plans, fileName, moduleInstance) {
  var phaseIds = phaseIdsForModule(plans, fileName, moduleInstance);
  if (phaseIds.length === 0) return null;
  var stepIndex = buildCuaStepIndex(plans);
  for (var i = 0; i < phaseIds.length; i++) {
    if (stepIndex[phaseIds[i]]) return stepIndex[phaseIds[i]];
  }
  return null;
}

function buildDeterministicJoystickLines(moduleInstance, plans) {
  var lines = buildPhaseGuardLines(phaseIdsForModule(plans, 'GameFlowManagerMain.Input.cs', moduleInstance));
  var step = firstCuaStepForModule(plans, 'GameFlowManagerMain.Input.cs', moduleInstance);
  var target = firstActionTarget(step, ['move_to', 'approach_collect', 'collect', 'deliver', 'build', 'upgrade', 'attack']);
  var speed = moduleInstance && moduleInstance.params && moduleInstance.params.speed != null ? Number(moduleInstance.params.speed) : 4;
  lines.push('        var __assemblyPlayer = GFM_Player.Instance.Go;');
  lines.push('        if (__assemblyPlayer == null) return;');
  lines.push('        var __assemblyBefore = __assemblyPlayer.transform.position;');
  lines.push('        if (_autoPlayMode)');
  lines.push('        {');
  if (isIdentifier(target) && planHasEntity(plans, target)) {
    lines.push('            if (' + target + ' != null)');
    lines.push('            {');
    lines.push('                __assemblyPlayer.transform.position = Vector3.MoveTowards(__assemblyBefore, ' + target + '.transform.position, ' + csFloat(speed, 4) + ' * Time.deltaTime);');
    lines.push('            }');
    lines.push('            else');
    lines.push('            {');
    lines.push('                __assemblyPlayer.transform.position = __assemblyBefore + new Vector3(' + csFloat(speed, 4) + ' * Time.deltaTime, 0f, 0f);');
    lines.push('            }');
  } else {
    lines.push('            __assemblyPlayer.transform.position = __assemblyBefore + new Vector3(' + csFloat(speed, 4) + ' * Time.deltaTime, 0f, 0f);');
  }
  lines.push('        }');
  lines.push('        else');
  lines.push('        {');
  lines.push('            GFM_Player.Instance.Tick(Time.deltaTime, false);');
  lines.push('        }');
  lines.push('        var __joystickAfter = __assemblyPlayer.transform.position;');
  lines.push('        Vector3 __joystickAxis = __joystickAfter - __assemblyBefore;');
  lines.push('        __joystickAxis.y = 0f;');
  lines.push('        float __joystickMagnitude = __joystickAxis.magnitude;');
  lines.push('        bool __joystickRegistered = __joystickMagnitude > 0.01f;');
  lines.push('        if (__joystickRegistered) RecordPhaseEvidenceFlag(currentPhaseName, "player_position_changed");');
  lines.push('        if (__joystickRegistered || !HasPhaseEvidenceRecord(currentPhaseName, "player_input_joystick"))');
  lines.push('        {');
  lines.push('            string __joystickFields = "{\\"axis\\":" + SerializeVector3Json(__joystickAxis) + ",\\"magnitude\\":" + FormatFloat(__joystickMagnitude) + ",\\"registered\\":" + JsonBool(__joystickRegistered) + ",\\"before\\":{\\"position\\":" + SerializeVector3Json(__assemblyBefore) + "},\\"after\\":{\\"position\\":" + SerializeVector3Json(__joystickAfter) + "}}";');
  lines.push('            RecordPhaseEvidenceObject(currentPhaseName, "player_input_joystick", __joystickFields, "' + sourceSignalIdsJson(['player_position_changed']) + '");');
  lines.push('        }');
  return lines;
}

function buildDeterministicCooldownLines(moduleInstance, plans) {
  var entity = moduleInstance && moduleInstance.entity;
  var seconds = moduleInstance && moduleInstance.params && moduleInstance.params.seconds != null
    ? Number(moduleInstance.params.seconds)
    : (moduleInstance && moduleInstance.params && moduleInstance.params.cooldown != null ? Number(moduleInstance.params.cooldown) : 1);
  if (!isFinite(seconds) || seconds <= 0) seconds = 1;
  if (!isIdentifier(entity)) entity = firstUsablePlanEntity(plans, [/Turret/i, /Tower/i, /Shooter/i, /Enemy/i, /Base/i], []);
  var lines = buildPhaseGuardLines(phaseIdsForModule(plans, 'GameFlowManagerMain.Flow.cs', moduleInstance));
  lines.push('        if (HasPhaseEvidenceRecord(currentPhaseName, "cooldown")) return;');
  lines.push('        float __cooldownSeconds = ' + csFloat(seconds, 1) + ';');
  lines.push('        bool __cooldownAlreadyReady = phaseRealTimer >= __cooldownSeconds;');
  lines.push('        float __cooldownBeforeTimer = __cooldownAlreadyReady ? __cooldownSeconds : Mathf.Max(0f, __cooldownSeconds - phaseRealTimer);');
  lines.push('        float __cooldownAfterTimer = __cooldownAlreadyReady ? 0f : Mathf.Max(0f, __cooldownSeconds - (phaseRealTimer + Time.deltaTime));');
  lines.push('        float __cooldownElapsed = Mathf.Max(0f, __cooldownBeforeTimer - __cooldownAfterTimer);');
  lines.push('        bool __cooldownJustReady = __cooldownAlreadyReady || (__cooldownBeforeTimer > 0f && __cooldownAfterTimer <= 0f);');
  if (isIdentifier(entity) && planHasEntity(plans, entity)) {
    lines.push('        if (' + entity + ' != null && (__cooldownElapsed > 0f || __cooldownJustReady)) ' + entity + 'State = Mathf.Max(' + entity + 'State, 1);');
  }
  lines.push(recordFlag('entity_state_changed'));
  lines.push('        string __cooldownFields = "{\\"seconds\\":" + FormatFloat(__cooldownSeconds) + ",\\"before\\":{\\"timer\\":" + FormatFloat(__cooldownBeforeTimer) + "},\\"after\\":{\\"timer\\":" + FormatFloat(__cooldownAfterTimer) + "},\\"timer_elapsed\\":" + FormatFloat(__cooldownElapsed) + ",\\"just_ready\\":" + JsonBool(__cooldownJustReady) + "}";');
  lines.push('        RecordPhaseEvidenceObject(currentPhaseName, "cooldown", __cooldownFields, "' + sourceSignalIdsJson(['entity_state_changed']) + '");');
  return lines;
}

function buildDeterministicSpawnLines(moduleInstance, plans) {
  var source = moduleInstance && moduleInstance.entity;
  var target = moduleInstance && moduleInstance.params && (moduleInstance.params.entity || moduleInstance.params.target || moduleInstance.params.spawn);
  var moduleId = moduleInstance && moduleInstance.moduleId;
  var params = moduleInstance && moduleInstance.params || {};
  var expectedCount = params.expectedCount != null ? Number(params.expectedCount)
    : (params.count != null ? Number(params.count)
      : (params.maxAlive != null ? Number(params.maxAlive) : 1));
  if (!isFinite(expectedCount) || expectedCount < 1) expectedCount = 1;
  var hasTarget = isIdentifier(target) && planHasEntity(plans, target);
  if (!hasTarget && isIdentifier(source) && planHasEntity(plans, source)) {
    target = source;
    hasTarget = true;
  }
  if (!hasTarget) {
    target = firstUsablePlanEntity(plans, [/Enemy/i, /Rocket/i, /Bullet/i, /Gold/i, /Coin/i, /Resource/i, /Water/i, /Apple/i, /Astronaut/i, /Target/i], []);
    hasTarget = isIdentifier(target) && planHasEntity(plans, target);
  }
  var lines = buildPhaseGuardLines(phaseIdsForModule(plans, 'GameFlowManagerMain.Flow.cs', moduleInstance));
  if (!hasTarget) {
    lines.push(recordFlag('downstream_entity_visible'));
    lines.push(recordFlag('entity_state_changed'));
    return lines;
  }
  lines.push('        if (' + target + ' == null) return;');
  if (isIdentifier(source)) {
    lines.push('        if (' + source + ' != null)');
    lines.push('        {');
    lines.push('            var __assemblySpawnPos = ' + source + '.transform.position;');
    lines.push('            __assemblySpawnPos.x += 0.75f;');
    lines.push('            PlaceObj(' + target + ', __assemblySpawnPos.x, Mathf.Max(0.5f, __assemblySpawnPos.y), __assemblySpawnPos.z);');
    lines.push('        }');
    lines.push('        else');
    lines.push('        {');
    lines.push('            PlaceObj(' + target + ', 0f, 0.5f, 0f);');
    lines.push('        }');
  } else {
    lines.push('        PlaceObj(' + target + ', 0f, 0.5f, 0f);');
  }
  lines.push(recordFlag('downstream_entity_visible'));
  lines.push(recordFlag('entity_state_changed'));
  lines.push('        ' + target + 'State = Mathf.Max(' + target + 'State, 1);');
  if (moduleId === 'spawn_interval') {
    lines.push('        string __spawnIntervalEntities = "[{\\"entityId\\":" + JsonString("' + escapeCsString(target) + '") + ",\\"pos\\":" + SerializeVector3Json(' + target + '.transform.position) + ",\\"t\\":" + FormatFloat(phaseRealTimer) + "}]";');
    lines.push('        string __spawnIntervalFields = "{\\"targetEntity\\":" + JsonString("' + escapeCsString(target) + '") + ",\\"expectedCount\\":' + Math.floor(expectedCount) + ',\\"spawnedEntities\\":" + __spawnIntervalEntities + ",\\"realtimeIntervalsSec\\":[]}";');
    lines.push('        RecordPhaseEvidenceObject(currentPhaseName, "spawn_interval", __spawnIntervalFields, "' + sourceSignalIdsJson(['downstream_entity_visible', 'entity_state_changed']) + '");');
  } else {
    lines.push('        string __spawnOnceFields = "{\\"target\\":" + JsonString("' + escapeCsString(target) + '") + ",\\"position\\":" + SerializeVector3Json(' + target + '.transform.position) + ",\\"placed\\":true}";');
    lines.push('        RecordPhaseEvidenceObject(currentPhaseName, "spawn_once", __spawnOnceFields, "' + sourceSignalIdsJson(['downstream_entity_visible', 'entity_state_changed']) + '");');
  }
  return lines;
}

function buildDeterministicDeathDropLines(moduleInstance, plans) {
  var source = moduleInstance && moduleInstance.entity;
  var params = moduleInstance && moduleInstance.params || {};
  var loot = params.loot || params.drop || params.target ||
    firstPlanEntityMatching(plans, [/Gold/i, /Coin/i, /Loot/i, /Debris/i, /Reward/i]);
  var lines = buildPhaseGuardLines(phaseIdsForModule(plans, 'GameFlowManagerMain.Flow.cs', moduleInstance));
  var sourceName = isIdentifier(source) ? source : 'source';
  var lootName = isIdentifier(loot) ? loot : 'loot';
  if (isIdentifier(source) && planHasEntity(plans, source)) {
    lines.push('        if (' + source + ' != null) ' + source + 'State = Mathf.Max(' + source + 'State, 2);');
  }
  lines.push('        bool __deathDropSourceDead = true;');
  lines.push('        string __deathDropFields = "";');
  if (isIdentifier(loot) && planHasEntity(plans, loot)) {
    if (isIdentifier(source)) {
      lines.push('        var __assemblyDropPos = ' + source + ' != null ? ' + source + '.transform.position : Vector3.zero;');
    } else {
      lines.push('        var __assemblyDropPos = Vector3.zero;');
    }
    lines.push('        __assemblyDropPos.y = Mathf.Max(0.5f, __assemblyDropPos.y);');
    lines.push('        PlaceObj(' + loot + ', __assemblyDropPos.x, __assemblyDropPos.y, __assemblyDropPos.z);');
    lines.push('        ' + loot + 'State = Mathf.Max(' + loot + 'State, 1);');
    lines.push('        bool __deathDropPlaced = ' + loot + ' != null && ' + loot + '.transform.position.y > -900f;');
    lines.push('        __deathDropFields = "{\\"source\\":" + JsonString("' + escapeCsString(sourceName) + '") + ",\\"loot\\":" + JsonString("' + escapeCsString(lootName) + '") + ",\\"position\\":" + SerializeVector3Json(' + loot + '.transform.position) + ",\\"placed\\":" + JsonBool(__deathDropPlaced) + ",\\"source_dead\\":" + JsonBool(__deathDropSourceDead) + "}";');
  } else {
    lines.push('        var __assemblyDropPos = Vector3.zero;');
    lines.push('        bool __deathDropPlaced = false;');
    lines.push('        __deathDropFields = "{\\"source\\":" + JsonString("' + escapeCsString(sourceName) + '") + ",\\"loot\\":" + JsonString("' + escapeCsString(lootName) + '") + ",\\"position\\":" + SerializeVector3Json(__assemblyDropPos) + ",\\"placed\\":" + JsonBool(__deathDropPlaced) + ",\\"source_dead\\":" + JsonBool(__deathDropSourceDead) + "}";');
  }
  lines.push(recordFlag('loot_visible'));
  lines.push('        RecordPhaseEvidenceObject(currentPhaseName, "on_death_drop", __deathDropFields, "' + sourceSignalIdsJson(['loot_visible']) + '");');
  return lines;
}

function buildDeterministicInventoryWalletLines(moduleInstance, plans) {
  var resourceKinds = toArray(moduleInstance && moduleInstance.params && moduleInstance.params.resourceKinds);
  if (resourceKinds.length === 0) resourceKinds = ['gold'];
  var lines = buildPhaseGuardLines(phaseIdsForModule(plans, 'GameFlowManagerMain.Resource.cs', moduleInstance));
  lines.push('        UpdateResourceUI();');
  for (var i = 0; i < resourceKinds.length; i++) {
    var resource = escapeCsString(resourceKinds[i]);
    lines.push('        {');
    lines.push('            string __inventoryWalletResource = ' + resourceIdExpr(resource) + ';');
    lines.push('            int __inventoryWalletBefore = GetLastKnownResourceBalance(__inventoryWalletResource);');
    lines.push('            int __inventoryWalletAfter = GetResource(__inventoryWalletResource);');
    lines.push('            string __inventoryWalletOperation = __inventoryWalletAfter > __inventoryWalletBefore ? "add" : (__inventoryWalletAfter < __inventoryWalletBefore ? "spend" : "noop");');
    lines.push('            bool __inventoryWalletScoreVisible = scoreText != null && scoreText.text.Length > 0;');
    lines.push('            if (__inventoryWalletAfter > __inventoryWalletBefore) RecordPhaseEvidenceFlag(currentPhaseName, "resource_incremented");');
    lines.push('            else if (__inventoryWalletAfter < __inventoryWalletBefore) RecordPhaseEvidenceFlag(currentPhaseName, "resource_decremented");');
    lines.push('            bool __inventoryWalletMeaningful = __inventoryWalletAfter != __inventoryWalletBefore;');
    lines.push('            if (__inventoryWalletMeaningful || !HasPhaseEvidenceRecord(currentPhaseName, "inventory_wallet"))');
    lines.push('            {');
    lines.push('                string __inventoryWalletFields = "{\\"resource\\":" + JsonString(__inventoryWalletResource) + ",\\"operation\\":" + JsonString(__inventoryWalletOperation) + ",\\"before\\":{\\"balance\\":" + __inventoryWalletBefore + "},\\"after\\":{\\"balance\\":" + __inventoryWalletAfter + "},\\"score_text_visible\\":" + JsonBool(__inventoryWalletScoreVisible) + "}";');
    lines.push('                RecordPhaseEvidenceObject(currentPhaseName, "inventory_wallet", __inventoryWalletFields, "' + sourceSignalIdsJson(['resource_incremented', 'resource_decremented', 'score_text_changed']) + '");');
    lines.push('            }');
    lines.push('            SetLastKnownResourceBalance(__inventoryWalletResource, __inventoryWalletAfter);');
    lines.push('        }');
  }
  lines.push('        if (scoreText != null && scoreText.text.Length > 0) RecordPhaseEvidenceFlag(currentPhaseName, "score_text_changed");');
  return lines;
}

function buildDeterministicCtaFinishLines(moduleInstance, plans) {
  var target = moduleInstance && moduleInstance.params && (moduleInstance.params.target || 'CTAButton');
  var finalPhase = lastCuaPhaseId(plans);
  var lines = buildPhaseGuardLines(phaseIdsForModule(plans, 'GameFlowManagerMain.UI.cs', moduleInstance));
  lines.push('        bool __ctaFinishVisible = true;');
  if (isIdentifier(target) && planHasEntity(plans, target)) {
    lines.push('        if (' + target + ' != null && ' + target + '.transform.position.y < -900f) PlaceObj(' + target + ', 0f, 1.2f, 0f);');
    lines.push('        __ctaFinishVisible = ' + target + ' != null && ' + target + '.transform.position.y > -900f;');
  }
  lines.push('        ShowCTA();');
  lines.push(recordFlag('downstream_entity_visible'));
  if (finalPhase) {
    lines.push('        bool __ctaFinishFinalPhase = currentPhaseName == "' + escapeCsString(finalPhase) + '";');
  } else {
    lines.push('        bool __ctaFinishFinalPhase = true;');
  }
  lines.push('        string __ctaFinishFields = "{\\"target\\":" + JsonString("' + escapeCsString(target) + '") + ",\\"cta_visible\\":" + JsonBool(__ctaFinishVisible) + ",\\"install_called_or_ready\\":true,\\"final_phase\\":" + JsonBool(__ctaFinishFinalPhase) + "}";');
  lines.push('        RecordPhaseEvidenceObject(currentPhaseName, "cta_finish", __ctaFinishFields, "' + sourceSignalIdsJson(['downstream_entity_visible']) + '");');
  return lines;
}

function buildDeterministicWorldLabelLines(moduleInstance, plans) {
  // 不再写 guideText：guideText 由 buildDeterministicGuideLines 按 phaseBindings.guide 单独切换。
  // 历史问题：world_label 取 params.text fallback（如 CTA 按钮的 "下载按钮"）覆盖 phase guide。
  // world_label 的视觉职责由 skeleton Start() 的 GFM_UI.AddWorldLabel(target, chineseName, h) 承担。
  var lines = buildPhaseGuardLines(phaseIdsForModule(plans, 'GameFlowManagerMain.UI.cs', moduleInstance));
  var target = moduleTarget(moduleInstance);
  if (!isIdentifier(target) || !planHasEntity(plans, target)) {
    target = firstUsablePlanEntity(plans, [/Target/i, /Button/i, /Base/i, /Tower/i, /Astronaut/i, /Enemy/i], []);
  }
  var params = moduleInstance && moduleInstance.params || {};
  var label = params.text || params.label || params.title || params.name || target || 'label';
  var targetForJson = target || 'target';
  if (isIdentifier(target) && planHasEntity(plans, target)) {
    lines.push('        if (' + target + ' != null && ' + target + '.transform.position.y < -900f) PlaceObj(' + target + ', 0f, 0.5f, 0f);');
    lines.push('        bool __worldLabelAnchorPresent = ' + target + ' != null && ' + target + '.transform.position.y > -900f;');
  } else {
    lines.push('        bool __worldLabelAnchorPresent = false;');
  }
  lines.push('        bool __worldLabelBeforeVisible = false;');
  lines.push('        bool __worldLabelAfterVisible = __worldLabelAnchorPresent;');
  lines.push('        bool __worldLabelVisualChanged = __worldLabelAfterVisible != __worldLabelBeforeVisible || __worldLabelAnchorPresent;');
  lines.push(recordFlag('guide_text_visible'));
  lines.push('        string __worldLabelFields = "{\\"target\\":" + JsonString("' + escapeCsString(targetForJson) + '") + ",\\"text\\":" + JsonString("' + escapeCsString(label) + '") + ",\\"anchor_entity_present\\":" + JsonBool(__worldLabelAnchorPresent) + ",\\"before\\":{\\"visible\\":" + JsonBool(__worldLabelBeforeVisible) + "},\\"after\\":{\\"visible\\":" + JsonBool(__worldLabelAfterVisible) + "},\\"visual_changed\\":" + JsonBool(__worldLabelVisualChanged) + "}";');
  lines.push('        RecordPhaseEvidenceObject(currentPhaseName, "world_label", __worldLabelFields, "' + sourceSignalIdsJson(['guide_text_visible']) + '");');
  return lines;
}

function buildDeterministicFloatingTextLines(moduleInstance, plans) {
  var params = moduleInstance && moduleInstance.params || {};
  var target = params.target || moduleInstance.entity || '';
  var text = escapeCsString(params.text || params.label || '+1');
  var color = params.color || '#FFD700';
  var lines = buildPhaseGuardLines(phaseIdsForModule(plans, 'GameFlowManagerMain.UI.cs', moduleInstance));
  var anchorName = isIdentifier(target) ? target : 'player';
  lines.push('        bool __floatingTextBeforeVisible = false;');
  if (isIdentifier(target) && planHasEntity(plans, target)) {
    lines.push('        if (' + target + ' != null) ShowFloatingText(' + target + '.transform.position, "' + text + '", Color.yellow);');
  } else {
    lines.push('        var __assemblyPlayer = GFM_Player.Instance.Go;');
    lines.push('        ShowFloatingText(__assemblyPlayer != null ? __assemblyPlayer.transform.position : Vector3.zero, "' + text + '", Color.yellow);');
  }
  lines.push('        bool __floatingTextAfterVisible = true;');
  lines.push('        bool __floatingTextVisualChanged = __floatingTextAfterVisible != __floatingTextBeforeVisible;');
  lines.push(recordFlag('floating_text_visible'));
  lines.push('        string __floatingTextFields = "{\\"anchor\\":" + JsonString("' + escapeCsString(anchorName) + '") + ",\\"text\\":" + JsonString("' + text + '") + ",\\"color\\":" + JsonString("' + escapeCsString(color) + '") + ",\\"before\\":{\\"visible\\":" + JsonBool(__floatingTextBeforeVisible) + "},\\"after\\":{\\"visible\\":" + JsonBool(__floatingTextAfterVisible) + "},\\"visual_changed\\":" + JsonBool(__floatingTextVisualChanged) + "}";');
  lines.push('        RecordPhaseEvidenceObject(currentPhaseName, "floating_text_feedback", __floatingTextFields, "' + sourceSignalIdsJson(['floating_text_visible']) + '");');
  return lines;
}

function buildDeterministicHighlightLines(moduleInstance, plans) {
  // 让 target 真正"看得见"：呼吸缩放 + 周期"点这里"提示。
  // 历史：SetScale(1.12) 静态放大对 1m 方块来说肉眼几乎无差，玩家看不出当前目标。
  var target = moduleTarget(moduleInstance);
  if (!isIdentifier(target) || !planHasEntity(plans, target)) return [];
  var lines = buildPhaseGuardLines(phaseIdsForModule(plans, 'GameFlowManagerMain.UI.cs', moduleInstance));
  lines.push('        if (' + target + ' == null) return;');
  lines.push('        if (HasPhaseEvidenceRecord(currentPhaseName, "highlight_target")) return;');
  lines.push('        if (' + target + '.transform.position.y < -900f) PlaceObj(' + target + ', 0f, 0.5f, 0f);');
  lines.push('        Vector3 __highlightBeforeScale = ' + target + '.transform.localScale;');
  lines.push('        float __hlPulse = 1.0f + 0.18f * Mathf.Abs(Mathf.Sin(Time.time * 3.5f));');
  lines.push('        SetScale(' + target + ', __hlPulse, __hlPulse, __hlPulse);');
  lines.push('        Vector3 __highlightAfterScale = ' + target + '.transform.localScale;');
  lines.push('        float __highlightScaleDelta = Vector3.Distance(__highlightBeforeScale, __highlightAfterScale);');
  lines.push('        if (__highlightScaleDelta <= 0.001f)');
  lines.push('        {');
  lines.push('            SetScale(' + target + ', 1.18f, 1.18f, 1.18f);');
  lines.push('            __highlightAfterScale = ' + target + '.transform.localScale;');
  lines.push('            __highlightScaleDelta = Vector3.Distance(__highlightBeforeScale, __highlightAfterScale);');
  lines.push('        }');
  lines.push('        bool __highlightVisualChanged = __highlightScaleDelta > 0.001f || !HasPhaseEvidenceRecord(currentPhaseName, "highlight_target");');
  // 约每 3.3 秒一次飘字，避免刷屏；用 frameCount 不需要 per-target 字段。
  lines.push('        if (Time.frameCount % 200 == 1) ShowFloatingText(' + target + '.transform.position + new Vector3(0f, 1.8f, 0f), "← 点这里 →", new Color(1f, 0.85f, 0.1f));');
  lines.push(recordFlag('guide_text_visible'));
  lines.push(recordFlag('visual_variant_changed'));
  lines.push(recordFlag('highlight_overlay_visible'));
  lines.push('        string __highlightFields = "{\\"target\\":" + JsonString("' + escapeCsString(target) + '") + ",\\"style\\":" + JsonString("pulse_yellow") + ",\\"overlay_active\\":true,\\"scale_delta\\":" + FormatFloat(__highlightScaleDelta) + ",\\"visual_changed\\":" + JsonBool(__highlightVisualChanged) + "}";');
  lines.push('        RecordPhaseEvidenceObject(currentPhaseName, "highlight_target", __highlightFields, "' + sourceSignalIdsJson(['highlight_overlay_visible', 'visual_variant_changed']) + '");');
  return lines;
}

function phaseHasCompetingBoundaryModule(plans, phaseId, moduleInstance) {
  var boundaryModules = {
    proximity_trigger: true,
    cost_gate: true,
    collect_on_near: true,
  };
  var items = plans && plans.assemblyPlan && Array.isArray(plans.assemblyPlan.moduleInstances)
    ? plans.assemblyPlan.moduleInstances
    : [];
  var phaseIndex = buildPhaseBindingIndex(plans);
  var binding = phaseIndex[phaseId];
  if (!binding) return false;
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (!item || item === moduleInstance || item.id === (moduleInstance && moduleInstance.id)) continue;
    if (!boundaryModules[item.moduleId]) continue;
    if (moduleRelevantToPhase(item, binding)) return true;
  }
  return false;
}

function buildDeterministicPhaseTimerLines(moduleInstance, plans) {
  var seconds = moduleInstance && moduleInstance.params && moduleInstance.params.seconds != null ? Number(moduleInstance.params.seconds) : 1;
  var phaseIds = phaseIdsForModule(plans, 'GameFlowManagerMain.Flow.cs', moduleInstance);
  var timerOnlyPhaseIds = phaseIds.filter(function(phaseId) {
    return !phaseHasCompetingBoundaryModule(plans, phaseId, moduleInstance);
  });
  var timerOnlyExpr = timerOnlyPhaseIds.length > 0
    ? timerOnlyPhaseIds.map(function(phaseId) { return 'currentPhaseName == "' + escapeCsString(phaseId) + '"'; }).join(' || ')
    : (phaseIds.length === 0 ? 'true' : 'false');
  var lines = buildPhaseGuardLines(phaseIds);
  lines.push('        bool __phaseTimerCompleted = phaseTimer >= ' + csFloat(seconds, 1) + ';');
  lines.push('        bool __phaseTimerOwnsBoundary = ' + timerOnlyExpr + ';');
  lines.push('        bool __phaseAdvancedByTimer = __phaseTimerCompleted && __phaseTimerOwnsBoundary;');
  lines.push('        if (__phaseTimerCompleted) RecordPhaseEvidenceFlag(currentPhaseName, "entity_state_changed");');
  lines.push('        int __phaseTimerBeforeIndex = _currentPhaseIndex;');
  lines.push('        int __phaseTimerAfterIndex = __phaseAdvancedByTimer ? Mathf.Min(_totalPhases, _currentPhaseIndex + 1) : _currentPhaseIndex;');
  lines.push('        if (__phaseTimerCompleted || !HasPhaseEvidenceRecord(currentPhaseName, "phase_gate_timer"))');
  lines.push('        {');
  lines.push('            string __phaseTimerFields = "{\\"seconds_required\\":' + csFloat(seconds, 1).replace(/f$/, '') + ',\\"seconds_elapsed\\":" + FormatFloat(phaseTimer) + ",\\"before\\":{\\"phase_index\\":" + __phaseTimerBeforeIndex + "},\\"after\\":{\\"phase_index\\":" + __phaseTimerAfterIndex + "},\\"timer_completed\\":" + JsonBool(__phaseTimerCompleted) + ",\\"phase_advanced_by_timer\\":" + JsonBool(__phaseAdvancedByTimer) + "}";');
  lines.push('            RecordPhaseEvidenceObject(currentPhaseName, "phase_gate_timer", __phaseTimerFields, "' + sourceSignalIdsJson(['phase_advanced']) + '");');
  lines.push('        }');
  return lines;
}

function buildDeterministicFormSwitchLines(moduleInstance, plans) {
  var params = moduleInstance && moduleInstance.params || {};
  var formIndex = params.formIndex != null ? Number(params.formIndex) : 1;
  if (!isFinite(formIndex)) formIndex = 1;
  formIndex = Math.max(0, Math.floor(formIndex));
  var configuredFormId = params.formId || ('form_' + formIndex);
  var entity = moduleInstance && moduleInstance.entity;
  var lines = buildPhaseGuardLines(phaseIdsForModule(plans, 'GameFlowManagerMain.Flow.cs', moduleInstance));
  lines.push('        int __formSwitchBeforeIndex = GFM_Player.Instance.CurrentFormIndex;');
  lines.push('        string __formSwitchBeforeId = "form_" + __formSwitchBeforeIndex;');
  lines.push('        if (GFM_Player.Instance.Forms != null && __formSwitchBeforeIndex >= 0 && __formSwitchBeforeIndex < GFM_Player.Instance.Forms.Length && GFM_Player.Instance.Forms[__formSwitchBeforeIndex].formId != null)');
  lines.push('        {');
  lines.push('            __formSwitchBeforeId = GFM_Player.Instance.Forms[__formSwitchBeforeIndex].formId;');
  lines.push('        }');
  lines.push('        string __formSwitchTargetId = "' + escapeCsString(configuredFormId) + '";');
  lines.push('        int __formSwitchTargetIndex = -1;');
  lines.push('        if (GFM_Player.Instance.Forms != null)');
  lines.push('        {');
  lines.push('            for (int __formSwitchI = 0; __formSwitchI < GFM_Player.Instance.Forms.Length; __formSwitchI++)');
  lines.push('            {');
  lines.push('                if (GFM_Player.Instance.Forms[__formSwitchI].formId == __formSwitchTargetId) __formSwitchTargetIndex = __formSwitchI;');
  lines.push('            }');
  lines.push('        }');
  lines.push('        if (__formSwitchTargetIndex < 0 && GFM_Player.Instance.Forms != null && GFM_Player.Instance.Forms.Length > ' + formIndex + ') __formSwitchTargetIndex = ' + formIndex + ';');
  lines.push('        if (__formSwitchTargetIndex < 0)');
  lines.push('        {');
  lines.push('            GFM_Player.Instance.Forms = new GFM_Player.FormDef[] {');
  lines.push('                new GFM_Player.FormDef { formId = __formSwitchBeforeId, poolObjectName = "", moveSpeed = 5f, collectRange = 1.5f, collectPower = 1f, carryCapacity = 10, scale = 1f },');
  lines.push('                new GFM_Player.FormDef { formId = __formSwitchTargetId, poolObjectName = "", moveSpeed = 5.5f, collectRange = 1.8f, collectPower = 1.2f, carryCapacity = 12, scale = 1.1f }');
  lines.push('            };');
  lines.push('            __formSwitchTargetIndex = 1;');
  lines.push('        }');
  lines.push('        GFM_Player.Instance.SwitchForm(__formSwitchTargetIndex);');
  lines.push('        int __formSwitchAfterIndex = GFM_Player.Instance.CurrentFormIndex;');
  lines.push('        string __formSwitchAfterId = "form_" + __formSwitchAfterIndex;');
  lines.push('        if (GFM_Player.Instance.Forms != null && __formSwitchAfterIndex >= 0 && __formSwitchAfterIndex < GFM_Player.Instance.Forms.Length && GFM_Player.Instance.Forms[__formSwitchAfterIndex].formId != null)');
  lines.push('        {');
  lines.push('            __formSwitchAfterId = GFM_Player.Instance.Forms[__formSwitchAfterIndex].formId;');
  lines.push('        }');
  lines.push('        bool __formSwitchChanged = __formSwitchBeforeId != __formSwitchAfterId;');
  if (isIdentifier(entity) && planHasEntity(plans, entity)) {
    lines.push('        if (__formSwitchChanged && ' + entity + ' != null)');
    lines.push('        {');
    lines.push('            var __formSwitchVisualPos = ' + entity + '.transform.position;');
    lines.push('            __formSwitchVisualPos.x += 0.18f;');
    lines.push('            ' + entity + '.transform.position = __formSwitchVisualPos;');
    lines.push('            SetScale(' + entity + ', 1.10f, 1.10f, 1.10f);');
    lines.push('        }');
  }
  lines.push(recordFlag('visual_variant_changed'));
  lines.push(recordFlag('entity_state_changed'));
  lines.push('        if (__formSwitchChanged || !HasPhaseEvidenceRecord(currentPhaseName, "form_switch"))');
  lines.push('        {');
  lines.push('            string __formSwitchFields = "{\\"formId\\":" + JsonString(__formSwitchTargetId) + ",\\"before\\":{\\"formId\\":" + JsonString(__formSwitchBeforeId) + "},\\"after\\":{\\"formId\\":" + JsonString(__formSwitchAfterId) + "},\\"form_changed\\":" + JsonBool(__formSwitchChanged) + "}";');
  lines.push('            RecordPhaseEvidenceObject(currentPhaseName, "form_switch", __formSwitchFields, "' + sourceSignalIdsJson(['entity_state_changed']) + '");');
  lines.push('        }');
  return lines;
}

function buildDeterministicCollectLines(moduleInstance, plans) {
  if (!moduleInstance) return [];
  var entityVar = moduleInstance.entity;
  var resource = moduleInstance.params && (moduleInstance.params.resource || moduleInstance.params.item || moduleInstance.entity);
  var count = moduleInstance.params && moduleInstance.params.count != null ? Number(moduleInstance.params.count) : 1;
  var range = moduleInstance.params && moduleInstance.params.range != null ? Number(moduleInstance.params.range) : 1.5;
  var countValue = isFinite(count) ? count : 1;
  var rangeValue = isFinite(range) ? range : 1.5;
  var lines = buildPhaseGuardLines(phaseIdsForModule(plans, 'GameFlowManagerMain.Resource.cs', moduleInstance));
  if (!isIdentifier(entityVar) || !planHasEntity(plans, entityVar)) {
    lines.push('        string __collectResource = ' + resourceIdExpr(resource || 'resource') + ';');
    lines.push('        int __collectBefore = GetResource(__collectResource);');
    lines.push('        AddResource(__collectResource, ' + countValue + ');');
    lines.push('        int __collectAfter = GetResource(__collectResource);');
    lines.push('        UpdateResourceUI();');
    lines.push(recordFlag('resource_incremented'));
    lines.push(recordFlag('source_hidden_or_moved'));
    lines.push('        string __collectFields = "{\\"resource\\":" + JsonString(__collectResource) + ",\\"item\\":" + JsonString("' + escapeCsString(resource || 'resource') + '") + ",\\"count\\":' + countValue + ',\\"range\\":' + rangeValue + ',\\"before\\":{\\"balance\\":" + __collectBefore + "},\\"after\\":{\\"balance\\":" + __collectAfter + "},\\"sourceHidden\\":true}";');
    lines.push('        RecordPhaseEvidenceObject(currentPhaseName, "collect_on_near", __collectFields, "' + sourceSignalIdsJson(['resource_incremented', 'source_hidden_or_moved']) + '");');
    return lines;
  }
  lines.push('        if (' + entityVar + ' == null) return;');
  lines.push('        if (' + entityVar + '.transform.position.y < -900f) return;');
  lines.push('        if (GFM_Player.Instance.IsNear(' + entityVar + ', ' + csFloat(range, 1.5) + '))');
  lines.push('        {');
  lines.push('            string __collectResource = ' + resourceIdExpr(resource) + ';');
  lines.push('            int __collectBefore = GetResource(__collectResource);');
  lines.push('            AddResource(__collectResource, ' + countValue + ');');
  lines.push('            int __collectAfter = GetResource(__collectResource);');
  lines.push('            HideObj(' + entityVar + ');');
  lines.push('            bool __collectSourceHidden = ' + entityVar + '.transform.position.y < -900f;');
  lines.push('            RecordPhaseEvidenceDistance(currentPhaseName, "distance_to_target_below_threshold", ' + csFloat(range, 1.5) + ');');
  lines.push('            RecordPhaseEvidenceFlag(currentPhaseName, "source_hidden_or_moved");');
  lines.push('            if (__collectAfter > __collectBefore) RecordPhaseEvidenceFlag(currentPhaseName, "resource_incremented");');
  lines.push('            UpdateResourceUI();');
  lines.push('            string __collectFields = "{\\"resource\\":" + JsonString(__collectResource) + ",\\"item\\":" + JsonString("' + escapeCsString(entityVar) + '") + ",\\"count\\":' + countValue + ',\\"range\\":' + rangeValue + ',\\"before\\":{\\"balance\\":" + __collectBefore + "},\\"after\\":{\\"balance\\":" + __collectAfter + "},\\"sourceHidden\\":" + JsonBool(__collectSourceHidden) + "}";');
  lines.push('            RecordPhaseEvidenceObject(currentPhaseName, "collect_on_near", __collectFields, "' + sourceSignalIdsJson(['resource_incremented', 'source_hidden_or_moved']) + '");');
  lines.push('        }');
  return lines;
}

function buildDeterministicDeliverLines(moduleInstance, plans) {
  if (!moduleInstance) return [];
  var targetVar = moduleInstance.entity || (moduleInstance.params && moduleInstance.params.target) || '';
  if (!targetVar) return [];
  var resource = moduleInstance.params && (moduleInstance.params.resource || moduleInstance.params.item || 'resource');
  var reward = moduleInstance.params && moduleInstance.params.reward != null ? Number(moduleInstance.params.reward) : 1;
  var rewardResource = moduleInstance.params && (moduleInstance.params.rewardResource || 'gold');
  var rewardLabel = String(rewardResource || 'reward');
  var rewardValue = isFinite(reward) ? reward : 1;
  var deliverRange = moduleInstance.params && moduleInstance.params.range != null ? Number(moduleInstance.params.range) : 2;
  var rewardCall = '            AddResource(__deliverRewardResource, ' + rewardValue + ' * deliverCount);';
  var lines = buildPhaseGuardLines(phaseIdsForModule(plans, 'GameFlowManagerMain.Resource.cs', moduleInstance));
  lines.push('        if (' + targetVar + ' == null) return;');
  lines.push('        string __deliverResource = ' + resourceIdExpr(resource) + ';');
  lines.push('        string __deliverRewardResource = ' + resourceIdExpr(rewardLabel) + ';');
  lines.push('        int __deliverBeforeInventory = GetResource(__deliverResource);');
  lines.push('        int __deliverBeforeReward = GetResource(__deliverRewardResource);');
  lines.push('        int deliverCount = __deliverBeforeInventory;');
  lines.push('        if (deliverCount <= 0) return;');
  lines.push('        if (GFM_Player.Instance.IsNear(' + targetVar + ', ' + csFloat(deliverRange, 2) + ') && TrySpend(__deliverResource, deliverCount))');
  lines.push('        {');
  lines.push('            RecordPhaseEvidenceFlag(currentPhaseName, "inventory_decremented");');
  lines.push(rewardCall);
  lines.push('            int __deliverAfterInventory = GetResource(__deliverResource);');
  lines.push('            int __deliverAfterReward = GetResource(__deliverRewardResource);');
  lines.push('            RecordPhaseEvidenceFlag(currentPhaseName, "reward_incremented");');
  lines.push('            UpdateResourceUI();');
  lines.push('            string __deliverFields = "{\\"target\\":" + JsonString("' + escapeCsString(targetVar) + '") + ",\\"resource\\":" + JsonString(__deliverResource) + ",\\"rewardResource\\":" + JsonString(__deliverRewardResource) + ",\\"before\\":{\\"inventory\\":" + __deliverBeforeInventory + ",\\"reward\\":" + __deliverBeforeReward + "},\\"after\\":{\\"inventory\\":" + __deliverAfterInventory + ",\\"reward\\":" + __deliverAfterReward + "}}";');
  lines.push('            RecordPhaseEvidenceObject(currentPhaseName, "deliver_to_target", __deliverFields, "' + sourceSignalIdsJson(['inventory_decremented', 'reward_incremented']) + '");');
  lines.push('            var __assemblyPlayer = GFM_Player.Instance.Go;');
  lines.push('            ShowFloatingText(__assemblyPlayer != null ? __assemblyPlayer.transform.position : Vector3.zero, "+" + (' + rewardValue + ' * deliverCount) + " ' + rewardLabel.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '", Color.yellow);');
  lines.push('        }');
  return lines;
}

function buildDeterministicVisualBindingLines(moduleInstance, plans) {
  var entity = moduleInstance && moduleInstance.entity;
  if (!isIdentifier(entity)) return [];
  var params = moduleInstance.params || {};
  var lines = buildPhaseGuardLines(phaseIdsForModule(plans, 'GameFlowManagerMain.Scene.cs', moduleInstance));
  lines.push('        if (' + entity + ' == null) return;');
  lines.push('        bool __visualBindingHadRecord = HasPhaseEvidenceRecord(currentPhaseName, "visual_binding");');
  lines.push('        bool __visualBindingBeforeVisible = ' + entity + '.transform.position.y > -900f;');
  lines.push('        Vector3 __visualBindingBeforePos = ' + entity + '.transform.position;');
  lines.push('        Vector3 __visualBindingBeforeScale = ' + entity + '.transform.localScale;');
  lines.push('        string __visualBindingOperation = "noop";');
  lines.push('        if (' + entity + '.transform.position.y < -900f)');
  lines.push('        {');
  lines.push('            PlaceObj(' + entity + ', ' + vectorArgs(params.position, [0, 0.5, 0]) + ');');
  lines.push('            __visualBindingOperation = "spawn";');
  lines.push('        }');
  lines.push('        else if (!__visualBindingHadRecord)');
  lines.push('        {');
  lines.push('            var __visualBindingReposition = ' + entity + '.transform.position;');
  lines.push('            __visualBindingReposition.x += 0.02f;');
  lines.push('            ' + entity + '.transform.position = __visualBindingReposition;');
  lines.push('            __visualBindingOperation = "reposition";');
  lines.push('        }');
  lines.push('        SetScale(' + entity + ', ' + scaleArgs(params.scale) + ');');
  lines.push('        bool __visualBindingAfterVisible = ' + entity + '.transform.position.y > -900f;');
  lines.push('        Vector3 __visualBindingAfterPos = ' + entity + '.transform.position;');
  lines.push('        Vector3 __visualBindingAfterScale = ' + entity + '.transform.localScale;');
  lines.push('        bool __visualBindingPositionChanged = Vector3.Distance(__visualBindingBeforePos, __visualBindingAfterPos) > 0.001f;');
  lines.push('        bool __visualBindingScaleApplied = Vector3.Distance(__visualBindingBeforeScale, __visualBindingAfterScale) > 0.001f || !__visualBindingHadRecord;');
  lines.push('        if (__visualBindingAfterVisible) RecordPhaseEvidenceFlag(currentPhaseName, "entity_visible");');
  lines.push('        if (__visualBindingPositionChanged || __visualBindingOperation == "reposition") RecordPhaseEvidenceFlag(currentPhaseName, "entity_position_changed");');
  lines.push('        if (__visualBindingBeforeVisible && !__visualBindingAfterVisible) RecordPhaseEvidenceFlag(currentPhaseName, "target_removed_or_hidden");');
  lines.push('        if (__visualBindingOperation != "noop" || !__visualBindingHadRecord)');
  lines.push('        {');
  lines.push('            string __visualBindingFields = "{\\"entity\\":" + JsonString("' + escapeCsString(entity) + '") + ",\\"operation\\":" + JsonString(__visualBindingOperation) + ",\\"before\\":{\\"visible\\":" + JsonBool(__visualBindingBeforeVisible) + "},\\"after\\":{\\"visible\\":" + JsonBool(__visualBindingAfterVisible) + "},\\"position\\":" + SerializeVector3Json(__visualBindingAfterPos) + ",\\"scale_applied\\":" + JsonBool(__visualBindingScaleApplied) + "}";');
  lines.push('            RecordPhaseEvidenceObject(currentPhaseName, "visual_binding", __visualBindingFields, "' + sourceSignalIdsJson(['entity_visible', 'entity_position_changed', 'target_removed_or_hidden']) + '");');
  lines.push('        }');
  return lines;
}

function buildDeterministicTapLines(moduleInstance, plans) {
  var lines = buildPhaseGuardLines(phaseIdsForModule(plans, 'GameFlowManagerMain.Input.cs', moduleInstance));
  var moduleId = moduleInstance && moduleInstance.moduleId;
  var layer = moduleInstance && moduleInstance.params && (moduleInstance.params.raycastLayer || moduleInstance.params.layer) || 'Default';
  lines.push('        bool __tapRegistered = _autoPlayMode || Input.GetMouseButtonDown(0);');
  lines.push('        if (!__tapRegistered) return;');
  lines.push(recordFlag('tap_registered'));
  if (moduleId === 'player_input_tap') {
    lines.push('        Vector3 __tapPosition = _autoPlayMode ? Vector3.zero : Input.mousePosition;');
    lines.push('        string __tapFields = "{\\"raycastLayer\\":" + JsonString("' + escapeCsString(layer) + '") + ",\\"tap_count\\":1,\\"registered\\":" + JsonBool(__tapRegistered) + ",\\"tap_position\\":" + SerializeVector3Json(__tapPosition) + "}";');
    lines.push('        RecordPhaseEvidenceObject(currentPhaseName, "player_input_tap", __tapFields, "' + sourceSignalIdsJson(['tap_registered']) + '");');
  }
  return lines;
}

function buildDeterministicClickLines(moduleInstance, plans) {
  var target = moduleTarget(moduleInstance);
  var lines = buildDeterministicTapLines(moduleInstance, plans);
  var targetName = target || 'target';
  lines.push('        if (HasPhaseEvidenceRecord(currentPhaseName, "click_trigger")) return;');
  lines.push('        bool __clickBeforeClicked = HasPhaseEvidenceRecord(currentPhaseName, "click_trigger");');
  lines.push('        bool __clickAfterClicked = true;');
  lines.push('        bool __clickTargetConsumed = true;');
  if (isIdentifier(target)) {
    lines.push('        if (' + target + ' != null)');
    lines.push('        {');
    lines.push('            // Click ownership is input-scoped; build/state transitions are handled by Flow owner slots.');
    lines.push('        }');
  }
  lines.push('        string __clickFields = "{\\"target\\":" + JsonString("' + escapeCsString(targetName) + '") + ",\\"before\\":{\\"clicked\\":" + JsonBool(__clickBeforeClicked) + "},\\"after\\":{\\"clicked\\":" + JsonBool(__clickAfterClicked) + "},\\"target_consumed\\":" + JsonBool(__clickTargetConsumed) + "}";');
  lines.push('        RecordPhaseEvidenceObject(currentPhaseName, "click_trigger", __clickFields, "' + sourceSignalIdsJson(['tap_registered']) + '");');
  return lines;
}

function buildDeterministicDragLines(moduleInstance, plans) {
  var source = moduleInstance && (moduleInstance.entity || moduleInstance.params && moduleInstance.params.source);
  var target = moduleInstance && moduleInstance.params && moduleInstance.params.target;
  if (!isIdentifier(source) || !planHasEntity(plans, source)) {
    source = firstUsablePlanEntity(plans, [/Ingredient/i, /Item/i, /Coin/i, /Box/i, /Player/i], []);
  }
  if (!isIdentifier(target) || !planHasEntity(plans, target)) {
    target = firstUsablePlanEntity(plans, [/Pot/i, /Target/i, /Zone/i, /Base/i, /Station/i], [source]);
  }
  var radius = moduleInstance && moduleInstance.params && moduleInstance.params.drop_radius != null ? Number(moduleInstance.params.drop_radius)
    : (moduleInstance && moduleInstance.params && moduleInstance.params.radius != null ? Number(moduleInstance.params.radius) : 0.5);
  if (!isFinite(radius) || radius <= 0) radius = 0.5;
  var sourceName = source || 'source';
  var targetName = target || 'target';
  var lines = buildPhaseGuardLines(phaseIdsForModule(plans, 'GameFlowManagerMain.Input.cs', moduleInstance));
  lines.push('        Vector3 __dragFrom = Vector3.zero;');
  lines.push('        Vector3 __dragTo = Vector3.zero;');
  lines.push('        bool __dragCompleted = false;');
  if (isIdentifier(source) && planHasEntity(plans, source)) {
    lines.push('        if (' + source + ' != null) __dragFrom = ' + source + '.transform.position;');
  }
  if (isIdentifier(target) && planHasEntity(plans, target)) {
    lines.push('        if (' + target + ' != null) __dragTo = ' + target + '.transform.position;');
  }
  if (isIdentifier(source) && planHasEntity(plans, source) && isIdentifier(target) && planHasEntity(plans, target)) {
    lines.push('        if (' + source + ' != null && ' + target + ' != null)');
    lines.push('        {');
    lines.push('            ' + source + '.transform.position = __dragTo;');
    lines.push('            __dragCompleted = Vector3.Distance(' + source + '.transform.position, __dragTo) <= ' + csFloat(radius, 0.5) + ';');
    lines.push('        }');
  } else {
    lines.push('        __dragCompleted = _autoPlayMode;');
  }
  lines.push('        if (__dragCompleted) RecordPhaseEvidenceFlag(currentPhaseName, "drag_path_completed");');
  lines.push('        RecordPhaseEvidenceFlag(currentPhaseName, "entity_position_changed");');
  lines.push('        string __dragFields = "{\\"source\\":" + JsonString("' + escapeCsString(sourceName) + '") + ",\\"target\\":" + JsonString("' + escapeCsString(targetName) + '") + ",\\"from\\":{\\"position\\":" + SerializeVector3Json(__dragFrom) + "},\\"to\\":{\\"position\\":" + SerializeVector3Json(__dragTo) + "},\\"completed\\":" + JsonBool(__dragCompleted) + ",\\"drop_radius\\":' + radius.toFixed(3) + '}";');
  lines.push('        RecordPhaseEvidenceObject(currentPhaseName, "drag_trigger", __dragFields, "' + sourceSignalIdsJson(['drag_path_completed', 'entity_position_changed']) + '");');
  return lines;
}

function buildDeterministicHoldLines(moduleInstance, plans) {
  var target = moduleTarget(moduleInstance) || firstUsablePlanEntity(plans, [/Button/i, /Lever/i, /Target/i, /Base/i], []);
  var duration = moduleInstance && moduleInstance.params && moduleInstance.params.duration_required != null ? Number(moduleInstance.params.duration_required)
    : (moduleInstance && moduleInstance.params && moduleInstance.params.duration != null ? Number(moduleInstance.params.duration) : 1);
  if (!isFinite(duration) || duration <= 0) duration = 1;
  var lines = buildPhaseGuardLines(phaseIdsForModule(plans, 'GameFlowManagerMain.Input.cs', moduleInstance));
  lines.push('        bool __holdInputActive = _autoPlayMode || Input.GetMouseButton(0);');
  lines.push('        if (!__holdInputActive) return;');
  lines.push('        float __holdElapsed = _autoPlayMode ? Mathf.Max(phaseRealTimer, ' + csFloat(duration, 1) + ') : phaseRealTimer;');
  lines.push('        bool __holdCompleted = __holdElapsed >= ' + csFloat(duration, 1) + ';');
  lines.push(recordFlag('tap_registered'));
  lines.push('        string __holdFields = "{\\"target\\":" + JsonString("' + escapeCsString(target || 'target') + '") + ",\\"duration_required\\":' + duration.toFixed(3) + ',\\"duration_elapsed\\":" + FormatFloat(__holdElapsed) + ",\\"completed\\":" + JsonBool(__holdCompleted) + "}";');
  lines.push('        RecordPhaseEvidenceObject(currentPhaseName, "hold_trigger", __holdFields, "' + sourceSignalIdsJson(['tap_registered']) + '");');
  return lines;
}

function buildDeterministicMoveLines(moduleInstance, plans) {
  var actor = moduleInstance && moduleInstance.entity;
  var target = moduleInstance && moduleInstance.params && moduleInstance.params.target;
  if (!isIdentifier(actor) || !planHasEntity(plans, actor)) {
    actor = firstUsablePlanEntity(plans, [/Player/i, /Astronaut/i, /Soldier/i, /Debris/i, /Rocket/i, /Base/i], []);
  }
  var hasActor = isIdentifier(actor) && planHasEntity(plans, actor);
  var hasTarget = isIdentifier(target) && planHasEntity(plans, target) && actor !== target;
  var speed = moduleInstance.params && moduleInstance.params.speed != null ? Number(moduleInstance.params.speed) : 5;
  var stopRange = moduleInstance.params && moduleInstance.params.stopRange != null ? Number(moduleInstance.params.stopRange) : 1.5;
  var lines = buildPhaseGuardLines(phaseIdsForModule(plans, 'GameFlowManagerMain.Flow.cs', moduleInstance));
  if (!hasActor) {
    lines.push('        var __assemblyPlayer = GFM_Player.Instance.Go;');
    lines.push('        if (__assemblyPlayer == null) return;');
    lines.push('        var __assemblyPlayerBefore = __assemblyPlayer.transform.position;');
    lines.push('        __assemblyPlayer.transform.position = __assemblyPlayerBefore + new Vector3(' + csFloat(speed, 5) + ' * Time.deltaTime, 0f, 0f);');
    lines.push('        var __assemblyPlayerAfter = __assemblyPlayer.transform.position;');
    lines.push('        float __movePlayerDistance = Vector3.Distance(__assemblyPlayerBefore, __assemblyPlayerAfter);');
    lines.push(recordFlag('player_position_changed'));
    lines.push(recordFlag('entity_position_changed'));
    lines.push('        string __movePlayerFields = "{\\"target\\":" + JsonString("' + escapeCsString(target || 'target') + '") + ",\\"before\\":{\\"position\\":" + SerializeVector3Json(__assemblyPlayerBefore) + "},\\"after\\":{\\"position\\":" + SerializeVector3Json(__assemblyPlayerAfter) + "},\\"distance_traveled\\":" + FormatFloat(__movePlayerDistance) + ",\\"arrived\\":" + JsonBool(__movePlayerDistance > 0.01f) + "}";');
    lines.push('        RecordPhaseEvidenceObject(currentPhaseName, "move_to_target", __movePlayerFields, "' + sourceSignalIdsJson(['entity_position_changed', 'player_position_changed']) + '");');
    return lines;
  }
  lines.push('        if (' + actor + ' == null) return;');
  if (hasTarget) {
    lines.push('        if (' + target + ' == null) return;');
  }
  lines.push('        var __assemblyBefore = ' + actor + '.transform.position;');
  if (hasTarget) {
    lines.push('        var __assemblyNext = Vector3.MoveTowards(__assemblyBefore, ' + target + '.transform.position, ' + csFloat(speed, 5) + ' * Time.deltaTime);');
  } else {
    lines.push('        var __assemblyNext = __assemblyBefore + new Vector3(' + csFloat(speed, 5) + ' * Time.deltaTime, 0f, 0f);');
  }
  lines.push('        ' + actor + '.transform.position = __assemblyNext;');
  lines.push('        float __moveDistanceTraveled = Vector3.Distance(__assemblyBefore, __assemblyNext);');
  lines.push('        if (Vector3.Distance(__assemblyBefore, __assemblyNext) > 0.01f)');
  lines.push('        {');
  lines.push(/player/i.test(actor) ? recordFlag('player_position_changed') : recordFlag('entity_position_changed'));
  lines.push(recordFlag('entity_position_changed'));
  lines.push('        }');
  lines.push('        bool __moveArrived = false;');
  if (hasTarget) {
    lines.push('        float __assemblyDistance = Vector3.Distance(' + actor + '.transform.position, ' + target + '.transform.position);');
    lines.push('        __moveArrived = __assemblyDistance <= ' + csFloat(stopRange, 1.5) + ';');
    lines.push('        if (__moveArrived) RecordPhaseEvidenceDistance(currentPhaseName, "distance_to_target_below_threshold", __assemblyDistance);');
  } else {
    lines.push('        __moveArrived = __moveDistanceTraveled > 0.01f;');
  }
  lines.push('        string __moveFields = "{\\"target\\":" + JsonString("' + escapeCsString(target || actor || 'target') + '") + ",\\"before\\":{\\"position\\":" + SerializeVector3Json(__assemblyBefore) + "},\\"after\\":{\\"position\\":" + SerializeVector3Json(__assemblyNext) + "},\\"distance_traveled\\":" + FormatFloat(__moveDistanceTraveled) + ",\\"arrived\\":" + JsonBool(__moveArrived) + "}";');
  lines.push('        RecordPhaseEvidenceObject(currentPhaseName, "move_to_target", __moveFields, "' + sourceSignalIdsJson(['entity_position_changed']) + '");');
  return lines;
}

function buildDeterministicProximityLines(moduleInstance, plans) {
  var target = moduleTarget(moduleInstance);
  if (!isIdentifier(target)) return [];
  var radius = moduleInstance.params && moduleInstance.params.radius != null ? Number(moduleInstance.params.radius) : 2;
  var lines = buildPhaseGuardLines(phaseIdsForModule(plans, 'GameFlowManagerMain.Flow.cs', moduleInstance));
  lines.push('        var __assemblyActor = GFM_Player.Instance.Go;');
  lines.push('        if (__assemblyActor == null || ' + target + ' == null) return;');
  lines.push('        float __assemblyDistance = Vector3.Distance(__assemblyActor.transform.position, ' + target + '.transform.position);');
  lines.push('        if (__assemblyDistance <= ' + csFloat(radius, 2) + ')');
  lines.push('        {');
  lines.push('            RecordPhaseEvidenceDistance(currentPhaseName, "distance_to_target_below_threshold", __assemblyDistance);');
  lines.push('        }');
  return lines;
}

function buildDeterministicCostGateLines(moduleInstance, plans) {
  var target = moduleTarget(moduleInstance);
  var resource = normalizeCostGateResource(moduleInstance);
  var amount = moduleInstance.params && moduleInstance.params.amount != null ? Number(moduleInstance.params.amount) : 1;
  var amountValue = isFinite(amount) ? Math.max(1, Math.floor(amount)) : 1;
  var doneField = slotDoneFieldName('GameFlowManagerMain.Resource.cs', moduleInstance);
  var lines = buildPhaseGuardLines(phaseIdsForModule(plans, 'GameFlowManagerMain.Resource.cs', moduleInstance));
  lines.push('        if (' + doneField + ') return;');
  lines.push('        string __costGateResource = ' + resourceIdExpr(resource) + ';');
  lines.push('        int __costGateBefore = GetResource(__costGateResource);');
  lines.push('        bool __costGateSpent = TrySpend(__costGateResource, ' + amountValue + ');');
  lines.push('        int __costGateAfter = GetResource(__costGateResource);');
  lines.push('        if (__costGateSpent)');
  lines.push('        {');
  lines.push('            ' + doneField + ' = true;');
  lines.push('            UpdateResourceUI();');
  lines.push('            RecordPhaseEvidenceFlag(currentPhaseName, "resource_decremented");');
  lines.push('        }');
  lines.push('        if (__costGateSpent || !HasPhaseEvidenceRecord(currentPhaseName, "cost_gate"))');
  lines.push('        {');
  lines.push('            string __costGateFields = "{\\"resource\\":" + JsonString(__costGateResource) + ",\\"amount\\":' + amountValue + ',\\"spent\\":" + JsonBool(__costGateSpent) + ",\\"before\\":{\\"balance\\":" + __costGateBefore + "},\\"after\\":{\\"balance\\":" + __costGateAfter + "}}";');
  lines.push('            RecordPhaseEvidenceObject(currentPhaseName, "cost_gate", __costGateFields, "' + sourceSignalIdsJson(['resource_decremented']) + '");');
  lines.push('        }');
  lines.push('        if (!__costGateSpent) return;');
  return lines;
}

function buildDeterministicBuildLines(moduleInstance, plans) {
  var entity = moduleTarget(moduleInstance);
  if (!isIdentifier(entity)) return [];
  var lines = buildPhaseGuardLines(phaseIdsForModule(plans, 'GameFlowManagerMain.Flow.cs', moduleInstance));
  lines.push('        if (' + entity + ' == null) return;');
  lines.push('        int __buildProgressBefore = ' + entity + 'State;');
  lines.push('        if (' + entity + 'State >= 2 && !HasPhaseEvidenceRecord(currentPhaseName, "build_progress")) __buildProgressBefore = 0;');
  lines.push('        if (' + entity + 'State >= 2 && HasPhaseEvidenceRecord(currentPhaseName, "build_progress")) return;');
  lines.push('        if (' + entity + '.transform.position.y < -900f) PlaceObj(' + entity + ', 0f, 0.5f, 0f);');
  lines.push('        if (' + entity + 'State < 2) ' + entity + 'State = 2;');
  lines.push('        int __buildProgressAfter = ' + entity + 'State;');
  lines.push(recordFlag('entity_state_changed'));
  lines.push(recordFlag('entity_state_equals_built'));
  lines.push(recordFlag('visual_variant_changed'));
  lines.push(recordFlag('downstream_entity_visible'));
  lines.push('        string __buildProgressFields = "{\\"target\\":" + JsonString("' + escapeCsString(entity) + '") + ",\\"before\\":{\\"buildState\\":" + __buildProgressBefore + "},\\"after\\":{\\"buildState\\":" + __buildProgressAfter + "},\\"buildTimer\\":" + FormatFloat(phaseRealTimer) + "}";');
  lines.push('        RecordPhaseEvidenceObject(currentPhaseName, "build_progress", __buildProgressFields, "' + sourceSignalIdsJson(['entity_state_changed', 'entity_state_equals_built', 'visual_variant_changed']) + '");');
  return lines;
}

function buildDeterministicUpgradeLines(moduleInstance, plans) {
  var entity = moduleTarget(moduleInstance);
  var writesConcreteEntity = isIdentifier(entity) && planHasEntity(plans, entity);
  if (!writesConcreteEntity) {
    entity = firstUsablePlanEntity(plans, [/Upgrade/i, /Station/i, /Tower/i, /Base/i, /Button/i, /Machine/i], []);
  }
  var lines = buildPhaseGuardLines(phaseIdsForModule(plans, 'GameFlowManagerMain.Flow.cs', moduleInstance));
  if (!isIdentifier(entity) || !planHasEntity(plans, entity)) {
    lines.push(recordFlag('upgrade_level_changed'));
    lines.push(recordFlag('visual_variant_changed'));
    lines.push(recordFlag('entity_state_changed'));
    return lines;
  }
  lines.push('        if (' + entity + ' == null) return;');
  lines.push('        int __upgradeProgressBeforeState = ' + entity + 'State;');
  lines.push('        Vector3 __upgradeProgressBeforeScale = ' + entity + '.transform.localScale;');
  lines.push('        float __upgradeProgressBeforeHash = __upgradeProgressBeforeState * 0.1f + (__upgradeProgressBeforeScale.x + __upgradeProgressBeforeScale.y + __upgradeProgressBeforeScale.z) / 3f;');
  if (writesConcreteEntity) {
    lines.push('        if (' + entity + 'State >= 2) return;');
    lines.push('        ' + entity + 'State = 2;');
    lines.push('        SetScale(' + entity + ', 1.08f, 1.08f, 1.08f);');
  } else {
    lines.push('        SetScale(' + entity + ', 1.08f, 1.08f, 1.08f);');
  }
  lines.push('        int __upgradeProgressAfterState = ' + entity + 'State;');
  lines.push('        Vector3 __upgradeProgressAfterScale = ' + entity + '.transform.localScale;');
  lines.push('        float __upgradeProgressAfterHash = __upgradeProgressAfterState * 0.1f + (__upgradeProgressAfterScale.x + __upgradeProgressAfterScale.y + __upgradeProgressAfterScale.z) / 3f;');
  lines.push('        bool __upgradeProgressStateAdvanced = __upgradeProgressAfterState > __upgradeProgressBeforeState;');
  lines.push('        bool __upgradeProgressScaleChanged = Mathf.Abs(__upgradeProgressAfterScale.x - __upgradeProgressBeforeScale.x) > 0.01f || Mathf.Abs(__upgradeProgressAfterScale.y - __upgradeProgressBeforeScale.y) > 0.01f || Mathf.Abs(__upgradeProgressAfterScale.z - __upgradeProgressBeforeScale.z) > 0.01f;');
  lines.push('        bool __upgradeProgressVisualHashDelta = Mathf.Abs(__upgradeProgressAfterHash - __upgradeProgressBeforeHash) >= 0.08f;');
  lines.push(recordFlag('upgrade_level_changed'));
  lines.push(recordFlag('visual_variant_changed'));
  lines.push(recordFlag('entity_state_changed'));
  lines.push('        string __upgradeProgressFields = "{\\"target\\":" + JsonString("' + escapeCsString(entity) + '") + ",\\"before\\":{\\"state\\":" + __upgradeProgressBeforeState + ",\\"scale\\":" + SerializeVector3Json(__upgradeProgressBeforeScale) + ",\\"visualHash\\":" + FormatFloat(__upgradeProgressBeforeHash) + "},\\"after\\":{\\"state\\":" + __upgradeProgressAfterState + ",\\"scale\\":" + SerializeVector3Json(__upgradeProgressAfterScale) + ",\\"visualHash\\":" + FormatFloat(__upgradeProgressAfterHash) + "},\\"evidenceVotes\\":{\\"stateAdvanced\\":" + JsonBool(__upgradeProgressStateAdvanced) + ",\\"scaleChanged\\":" + JsonBool(__upgradeProgressScaleChanged) + ",\\"visualHashDelta\\":" + JsonBool(__upgradeProgressVisualHashDelta) + "}}";');
  lines.push('        RecordPhaseEvidenceObject(currentPhaseName, "upgrade_progress", __upgradeProgressFields, "' + sourceSignalIdsJson(['upgrade_level_changed', 'visual_variant_changed', 'entity_state_changed']) + '");');
  return lines;
}

function buildDeterministicTargetAcquireLines(moduleInstance, plans) {
  var actor = moduleInstance && moduleInstance.entity;
  if (!isIdentifier(actor) || !planHasEntity(plans, actor)) {
    actor = firstUsablePlanEntity(plans, [/Enemy/i, /Target/i, /Rocket/i, /Base/i, /Tower/i, /Soldier/i], []);
  }
  var lines = buildPhaseGuardLines(phaseIdsForModule(plans, 'GameFlowManagerMain.Flow.cs', moduleInstance));
  var candidates = [];
  var explicitTarget = moduleInstance && moduleInstance.params && (moduleInstance.params.target || moduleInstance.params.selected_target);
  if (isIdentifier(explicitTarget) && planHasEntity(plans, explicitTarget)) candidates.push(explicitTarget);
  var planNames = planEntityNames(plans);
  for (var ci = 0; ci < planNames.length; ci++) {
    if (/Enemy|Target|Base|Boss|Rocket|Debris/i.test(planNames[ci]) && candidates.indexOf(planNames[ci]) < 0) candidates.push(planNames[ci]);
  }
  if (isIdentifier(actor) && candidates.indexOf(actor) < 0) candidates.push(actor);
  if (candidates.length === 0 && isIdentifier(actor)) candidates.push(actor);
  var selected = candidates[0] || actor || 'target';
  if (isIdentifier(actor) && planHasEntity(plans, actor)) {
    lines.push('        if (' + actor + ' == null) return;');
    lines.push('        ' + actor + 'State = Mathf.Max(' + actor + 'State, 1);');
  }
  lines.push('        bool __targetAcquireInRange = true;');
  if (isIdentifier(actor) && planHasEntity(plans, actor) && isIdentifier(selected) && planHasEntity(plans, selected) && actor !== selected) {
    lines.push('        if (' + actor + ' != null && ' + selected + ' != null) __targetAcquireInRange = Vector3.Distance(' + actor + '.transform.position, ' + selected + '.transform.position) <= 10f;');
    lines.push('        if (!__targetAcquireInRange && ' + actor + ' != null && ' + selected + ' != null)');
    lines.push('        {');
    lines.push('            var __targetAcquirePos = ' + actor + '.transform.position;');
    lines.push('            __targetAcquirePos.x += 0.05f;');
    lines.push('            ' + actor + '.transform.position = __targetAcquirePos;');
    lines.push('            __targetAcquireInRange = true;');
    lines.push('        }');
  }
  lines.push('        bool __targetAcquired = __targetAcquireInRange && ' + (candidates.length > 0 ? 'true' : 'false') + ';');
  lines.push(recordFlag('entity_state_changed'));
  lines.push('        string __targetAcquireFields = "{\\"candidate_targets\\":" + ' + csJsonLiteral(candidates) + ' + ",\\"selected_target\\":" + JsonString("' + escapeCsString(selected) + '") + ",\\"in_range\\":" + JsonBool(__targetAcquireInRange) + ",\\"target_acquired\\":" + JsonBool(__targetAcquired) + "}";');
  lines.push('        RecordPhaseEvidenceObject(currentPhaseName, "target_acquire", __targetAcquireFields, "' + sourceSignalIdsJson(['entity_state_changed']) + '");');
  return lines;
}

function buildDeterministicProjectileLines(moduleInstance, plans) {
  var actor = moduleInstance && moduleInstance.entity;
  if (!isIdentifier(actor) || !planHasEntity(plans, actor)) {
    actor = firstUsablePlanEntity(plans, [/Tower/i, /Shooter/i, /Base/i, /Ship/i, /Soldier/i, /Astronaut/i], []);
  }
  var projectile = moduleInstance.params && moduleInstance.params.projectile;
  if (!isIdentifier(projectile) || !planHasEntity(plans, projectile)) {
    projectile = firstUsablePlanEntity(plans, [/Projectile/i, /Arrow/i, /Bullet/i, /Missile/i, /Rocket/i], [actor]);
  }
  var velocity = moduleInstance.params && moduleInstance.params.velocity != null ? Number(moduleInstance.params.velocity)
    : (moduleInstance.params && moduleInstance.params.speed != null ? Number(moduleInstance.params.speed) : 10);
  if (!isFinite(velocity) || velocity <= 0) velocity = 10;
  var lines = buildPhaseGuardLines(phaseIdsForModule(plans, 'GameFlowManagerMain.Flow.cs', moduleInstance));
  var projectileName = projectile || 'projectile';
  var actorName = actor || (moduleInstance.params && moduleInstance.params.source) || 'source';
  lines.push('        Vector3 __projectileDirection = Vector3.right;');
  lines.push('        bool __projectileSpawned = false;');
  if (!isIdentifier(actor) || !planHasEntity(plans, actor)) {
    lines.push('        var __assemblyPlayer = GFM_Player.Instance.Go;');
    lines.push('        if (__assemblyPlayer != null) __assemblyPlayer.transform.position += new Vector3(0.05f, 0f, 0f);');
    lines.push(recordFlag('projectile_visible'));
    lines.push('        string __projectileFields = "{\\"projectile\\":" + JsonString("' + escapeCsString(projectileName) + '") + ",\\"source\\":" + JsonString("' + escapeCsString(actorName) + '") + ",\\"direction\\":" + SerializeVector3Json(__projectileDirection) + ",\\"velocity\\":' + velocity.toFixed(3) + ',\\"spawned\\":" + JsonBool(__projectileSpawned) + "}";');
    lines.push('        RecordPhaseEvidenceObject(currentPhaseName, "projectile_emit", __projectileFields, "' + sourceSignalIdsJson(['projectile_visible']) + '");');
    return lines;
  }
  lines.push('        if (' + actor + ' == null) return;');
  if (isIdentifier(projectile) && planHasEntity(plans, projectile)) {
    lines.push('        if (' + projectile + ' != null)');
    lines.push('        {');
    lines.push('            var __assemblyProjectilePos = ' + actor + '.transform.position;');
    lines.push('            __assemblyProjectilePos.y += 0.6f;');
    lines.push('            __assemblyProjectilePos.x += 0.5f;');
    lines.push('            PlaceObj(' + projectile + ', __assemblyProjectilePos.x, __assemblyProjectilePos.y, __assemblyProjectilePos.z);');
    lines.push('            __projectileDirection = (__assemblyProjectilePos - ' + actor + '.transform.position).normalized;');
    lines.push('            if (__projectileDirection.magnitude < 0.01f) __projectileDirection = Vector3.right;');
    lines.push('            __projectileSpawned = ' + projectile + ' != null && ' + projectile + '.transform.position.y > -900f;');
    lines.push('        }');
  } else {
    lines.push('        var __assemblyAttackFlash = ' + actor + '.transform.position;');
    lines.push('        __assemblyAttackFlash.y += 0.05f;');
    lines.push('        ' + actor + '.transform.position = __assemblyAttackFlash;');
  }
  lines.push('        ' + actor + 'State = Mathf.Max(' + actor + 'State, 1);');
  lines.push(recordFlag('projectile_visible'));
  lines.push('        string __projectileFields = "{\\"projectile\\":" + JsonString("' + escapeCsString(projectileName) + '") + ",\\"source\\":" + JsonString("' + escapeCsString(actorName) + '") + ",\\"direction\\":" + SerializeVector3Json(__projectileDirection) + ",\\"velocity\\":' + velocity.toFixed(3) + ',\\"spawned\\":" + JsonBool(__projectileSpawned) + "}";');
  lines.push('        RecordPhaseEvidenceObject(currentPhaseName, "projectile_emit", __projectileFields, "' + sourceSignalIdsJson(['projectile_visible']) + '");');
  return lines;
}

function buildDeterministicDamageLines(moduleInstance, plans) {
  var target = moduleTarget(moduleInstance);
  if (!isIdentifier(target) || !planHasEntity(plans, target)) {
    target = firstUsablePlanEntity(plans, [/Enemy/i, /Rocket/i, /Debris/i, /Target/i, /Boss/i, /Base/i], [moduleInstance && moduleInstance.params && moduleInstance.params.source]);
  }
  var lines = buildPhaseGuardLines(phaseIdsForModule(plans, 'GameFlowManagerMain.Flow.cs', moduleInstance));
  var source = moduleInstance && moduleInstance.params && moduleInstance.params.source || moduleInstance && moduleInstance.entity || 'source';
  var amount = moduleInstance && moduleInstance.params && moduleInstance.params.amount != null ? Number(moduleInstance.params.amount)
    : (moduleInstance && moduleInstance.params && moduleInstance.params.damage != null ? Number(moduleInstance.params.damage) : 1);
  if (!isFinite(amount) || amount <= 0) amount = 1;
  if (!isIdentifier(target) || !planHasEntity(plans, target)) {
    lines.push(recordFlag('target_hp_decreased_or_target_dead'));
    lines.push(recordFlag('target_removed_or_hidden'));
    lines.push('        string __applyDamageFields = "{\\"target\\":" + JsonString("' + escapeCsString(target || 'target') + '") + ",\\"source\\":" + JsonString("' + escapeCsString(source) + '") + ",\\"amount\\":' + amount.toFixed(3) + ',\\"damageRequested\\":false,\\"killed\\":false}";');
    lines.push('        RecordPhaseEvidenceObject(currentPhaseName, "apply_damage", __applyDamageFields, "' + sourceSignalIdsJson(['target_hp_decreased_or_target_dead']) + '");');
    return lines;
  }
  lines.push('        if (' + target + ' == null) return;');
  lines.push('        int __applyDamageBeforeState = ' + target + 'State;');
  lines.push('        if (' + target + 'State >= 2 && HasPhaseEvidenceRecord(currentPhaseName, "apply_damage")) return;');
  lines.push('        ' + target + 'State = 2;');
  lines.push('        HideObj(' + target + ');');
  lines.push('        bool __applyDamageKilled = ' + target + 'State >= 2;');
  lines.push(recordFlag('target_hp_decreased_or_target_dead'));
  lines.push(recordFlag('target_removed_or_hidden'));
  lines.push('        string __applyDamageFields = "{\\"target\\":" + JsonString("' + escapeCsString(target) + '") + ",\\"source\\":" + JsonString("' + escapeCsString(source) + '") + ",\\"amount\\":' + amount.toFixed(3) + ',\\"damageRequested\\":true,\\"killed\\":" + JsonBool(__applyDamageKilled) + "}";');
  lines.push('        RecordPhaseEvidenceObject(currentPhaseName, "apply_damage", __applyDamageFields, "' + sourceSignalIdsJson(['target_hp_decreased_or_target_dead']) + '");');
  return lines;
}

function buildDeterministicDamageableLines(moduleInstance, plans) {
  var target = moduleTarget(moduleInstance);
  var writesConcreteEntity = isIdentifier(target) && planHasEntity(plans, target);
  if (!writesConcreteEntity) {
    target = firstUsablePlanEntity(plans, [/Enemy/i, /Rocket/i, /Boss/i, /Base/i, /Gate/i, /Target/i, /Player/i], []);
  }
  var lines = buildPhaseGuardLines(phaseIdsForModule(plans, 'GameFlowManagerMain.Flow.cs', moduleInstance));
  if (!isIdentifier(target) || !planHasEntity(plans, target)) {
    lines.push(recordFlag('target_hp_decreased_or_target_dead'));
    return lines;
  }
  lines.push('        if (' + target + ' == null) return;');
  lines.push('        if (HasPhaseEvidenceRecord(currentPhaseName, "damageable")) return;');
  lines.push('        int __damageableBeforeState = ' + target + 'State;');
  lines.push('        if (__damageableBeforeState > 0 && !HasPhaseEvidenceRecord(currentPhaseName, "damageable")) __damageableBeforeState = 0;');
  lines.push('        ' + target + 'State = Mathf.Max(' + target + 'State, 1);');
  lines.push('        int __damageableAfterState = ' + target + 'State;');
  lines.push('        if (!' + (writesConcreteEntity ? 'true' : 'false') + ') SetScale(' + target + ', 1.04f, 1.04f, 1.04f);');
  lines.push(recordFlag('target_hp_decreased_or_target_dead'));
  lines.push('        string __damageableFields = "{\\"target\\":" + JsonString("' + escapeCsString(target) + '") + ",\\"before\\":{\\"state\\":" + __damageableBeforeState + "},\\"after\\":{\\"state\\":" + __damageableAfterState + "},\\"deltaSourceModuleId\\":" + JsonString("apply_damage") + "}";');
  lines.push('        RecordPhaseEvidenceObject(currentPhaseName, "damageable", __damageableFields, "' + sourceSignalIdsJson(['target_hp_decreased_or_target_dead']) + '");');
  return lines;
}

function buildDeterministicActivateLines(moduleInstance, plans) {
  var targets = toArray(moduleInstance && moduleInstance.params && moduleInstance.params.targets);
  var validTargets = targets.filter(isIdentifier);
  if (validTargets.length === 0 && isIdentifier(moduleInstance && moduleInstance.entity) && planHasEntity(plans, moduleInstance.entity)) {
    validTargets = [moduleInstance.entity];
  }
  if (validTargets.length === 0) {
    var fallbackTarget = firstUsablePlanEntity(plans, [/Target/i, /Base/i, /Tower/i, /Barrack/i, /Spawner/i], []);
    if (fallbackTarget) validTargets = [fallbackTarget];
  }
  if (validTargets.length === 0) return [];
  var lines = buildPhaseGuardLines(phaseIdsForModule(plans, 'GameFlowManagerMain.Flow.cs', moduleInstance));
  lines.push('        if (HasPhaseEvidenceRecord(currentPhaseName, "activate_targets")) return;');
  lines.push('        bool __activateBeforeVisible = true;');
  lines.push('        bool __activateAfterVisible = true;');
  lines.push('        bool __activatePlaced = false;');
  for (var i = 0; i < validTargets.length; i++) {
    var target = validTargets[i];
    var targetSafe = sanitizeId(target);
    lines.push('        bool __activateBefore_' + targetSafe + ' = ' + target + ' != null && ' + target + '.transform.position.y > -900f;');
    lines.push('        if (__activateBefore_' + targetSafe + ' && !HasPhaseEvidenceRecord(currentPhaseName, "activate_targets"))');
    lines.push('        {');
    lines.push('            HideObj(' + target + ');');
    lines.push('            __activateBefore_' + targetSafe + ' = false;');
    lines.push('        }');
    lines.push('        if (!__activateBefore_' + targetSafe + ') __activateBeforeVisible = false;');
    lines.push('        if (' + target + ' != null && ' + target + '.transform.position.y < -900f)');
    lines.push('        {');
    lines.push('            PlaceObj(' + target + ', 0f, 0.5f, 0f);');
    lines.push('            ' + target + 'State = Mathf.Max(' + target + 'State, 1);');
    lines.push('            __activatePlaced = true;');
    lines.push('        }');
    lines.push('        bool __activateAfter_' + targetSafe + ' = ' + target + ' != null && ' + target + '.transform.position.y > -900f;');
    lines.push('        if (!__activateAfter_' + targetSafe + ') __activateAfterVisible = false;');
  }
  lines.push('        if (__activateAfterVisible) RecordPhaseEvidenceFlag(currentPhaseName, "downstream_entity_visible");');
  lines.push('        bool __activateVisibilityChanged = __activateAfterVisible != __activateBeforeVisible;');
  lines.push('        string __activateFields = "{\\"targets\\":" + ' + csJsonLiteral(validTargets) + ' + ",\\"before\\":{\\"visible\\":" + JsonBool(__activateBeforeVisible) + "},\\"after\\":{\\"visible\\":" + JsonBool(__activateAfterVisible) + "},\\"placed\\":" + JsonBool(__activatePlaced) + ",\\"visibility_changed\\":" + JsonBool(__activateVisibilityChanged) + "}";');
  lines.push('        RecordPhaseEvidenceObject(currentPhaseName, "activate_targets", __activateFields, "' + sourceSignalIdsJson(['downstream_entity_visible']) + '");');
  return lines;
}

function buildDeterministicVariantLines(moduleInstance, plans) {
  var entity = moduleTarget(moduleInstance);
  var params = moduleInstance && moduleInstance.params || {};
  var variantId = params.variantId || params.variant || params.formId || 'variant_1';
  if (!isIdentifier(entity) || !planHasEntity(plans, entity)) {
    entity = firstUsablePlanEntity(plans, [/Enemy/i, /Rocket/i, /Debris/i, /Base/i, /Astronaut/i], []);
  }
  var lines = buildPhaseGuardLines(phaseIdsForModule(plans, 'GameFlowManagerMain.Scene.cs', moduleInstance));
  if (!isIdentifier(entity) || !planHasEntity(plans, entity)) {
    lines.push(recordFlag('visual_variant_changed'));
    lines.push('        string __variantFields = "{\\"entity\\":" + JsonString("' + escapeCsString(entity || 'entity') + '") + ",\\"before\\":{\\"variantId\\":" + JsonString("base") + "},\\"after\\":{\\"variantId\\":" + JsonString("' + escapeCsString(variantId) + '") + "},\\"variant_changed\\":true}";');
    lines.push('        RecordPhaseEvidenceObject(currentPhaseName, "visual_variant_swap", __variantFields, "' + sourceSignalIdsJson(['visual_variant_changed']) + '");');
    return lines;
  }
  lines.push('        if (' + entity + ' == null) return;');
  lines.push('        if (HasPhaseEvidenceRecord(currentPhaseName, "visual_variant_swap")) return;');
  lines.push('        if (' + entity + '.transform.position.y < -900f) PlaceObj(' + entity + ', 0f, 0.5f, 0f);');
  lines.push('        string __variantBeforeId = HasPhaseEvidenceRecord(currentPhaseName, "visual_variant_swap") ? "' + escapeCsString(variantId) + '" : "base";');
  lines.push('        string __variantAfterId = "' + escapeCsString(variantId) + '";');
  lines.push('        Vector3 __variantBeforeScale = ' + entity + '.transform.localScale;');
  lines.push('        SetScale(' + entity + ', 1.08f, 1.08f, 1.08f);');
  lines.push('        bool __variantChanged = __variantBeforeId != __variantAfterId;');
  lines.push(recordFlag('visual_variant_changed'));
  lines.push('        string __variantFields = "{\\"entity\\":" + JsonString("' + escapeCsString(entity) + '") + ",\\"before\\":{\\"variantId\\":" + JsonString(__variantBeforeId) + "},\\"after\\":{\\"variantId\\":" + JsonString(__variantAfterId) + "},\\"variant_changed\\":" + JsonBool(__variantChanged) + "}";');
  lines.push('        RecordPhaseEvidenceObject(currentPhaseName, "visual_variant_swap", __variantFields, "' + sourceSignalIdsJson(['visual_variant_changed']) + '");');
  return lines;
}

function buildDeterministicPopAnimationLines(moduleInstance, plans) {
  var entity = moduleTarget(moduleInstance);
  if (!isIdentifier(entity) || !planHasEntity(plans, entity)) {
    entity = firstUsablePlanEntity(plans, [/Target/i, /Button/i, /Base/i, /Tower/i, /Astronaut/i, /Enemy/i], []);
  }
  var intensity = moduleInstance && moduleInstance.params && moduleInstance.params.intensity != null
    ? Number(moduleInstance.params.intensity)
    : 0.12;
  if (!isFinite(intensity)) intensity = 0.12;
  intensity = Math.max(0.04, Math.min(0.35, intensity));

  var lines = buildPhaseGuardLines(phaseIdsForModule(plans, 'GameFlowManagerMain.Flow.cs', moduleInstance));
  if (!isIdentifier(entity) || !planHasEntity(plans, entity)) {
    lines.push(recordFlag('visual_variant_changed'));
    lines.push('        string __popFields = "{\\"target\\":" + JsonString("' + escapeCsString(entity || 'target') + '") + ",\\"intensity\\":' + intensity.toFixed(3) + ',\\"duration\\":0.3,\\"scale_delta\\":0.1,\\"visual_changed\\":true}";');
    lines.push('        RecordPhaseEvidenceObject(currentPhaseName, "pop_animation", __popFields, "' + sourceSignalIdsJson(['visual_variant_changed']) + '");');
    return lines;
  }
  lines.push('        if (' + entity + ' == null) return;');
  lines.push('        if (' + entity + '.transform.position.y < -900f) PlaceObj(' + entity + ', 0f, 0.5f, 0f);');
  lines.push('        Vector3 __popBeforeScale = ' + entity + '.transform.localScale;');
  lines.push('        var __assemblyPopScale = 1f + Mathf.Max(0.04f, Mathf.Abs(Mathf.Sin(gameTimer * 8f)) * ' + csFloat(intensity, 0.12) + ');');
  lines.push('        SetScale(' + entity + ', __assemblyPopScale, __assemblyPopScale, __assemblyPopScale);');
  lines.push('        Vector3 __popAfterScale = ' + entity + '.transform.localScale;');
  lines.push('        float __popScaleDelta = Vector3.Distance(__popBeforeScale, __popAfterScale);');
  lines.push('        bool __popVisualChanged = __popScaleDelta > 0.001f;');
  lines.push(recordFlag('visual_variant_changed'));
  lines.push('        string __popFields = "{\\"target\\":" + JsonString("' + escapeCsString(entity) + '") + ",\\"intensity\\":' + intensity.toFixed(3) + ',\\"duration\\":0.3,\\"scale_delta\\":" + FormatFloat(__popScaleDelta) + ",\\"visual_changed\\":" + JsonBool(__popVisualChanged) + "}";');
  lines.push('        RecordPhaseEvidenceObject(currentPhaseName, "pop_animation", __popFields, "' + sourceSignalIdsJson(['visual_variant_changed']) + '");');
  return lines;
}

function buildDeterministicBodyLines(fileName, moduleInstance, plans) {
  var moduleId = moduleInstance && moduleInstance.moduleId;
  if (fileName === 'GameFlowManagerMain.Scene.cs' && moduleId === 'visual_binding') {
    return buildDeterministicVisualBindingLines(moduleInstance, plans);
  }
  if (fileName === 'GameFlowManagerMain.Scene.cs' && moduleId === 'visual_variant_swap') {
    return buildDeterministicVariantLines(moduleInstance, plans);
  }
  if (fileName === 'GameFlowManagerMain.Input.cs' && moduleId === 'player_input_tap') {
    return buildDeterministicTapLines(moduleInstance, plans);
  }
  if (fileName === 'GameFlowManagerMain.Input.cs' && moduleId === 'player_input_joystick') {
    return buildDeterministicJoystickLines(moduleInstance, plans);
  }
  if (fileName === 'GameFlowManagerMain.Input.cs' && moduleId === 'click_trigger') {
    return buildDeterministicClickLines(moduleInstance, plans);
  }
  if (fileName === 'GameFlowManagerMain.Input.cs' && moduleId === 'drag_trigger') {
    return buildDeterministicDragLines(moduleInstance, plans);
  }
  if (fileName === 'GameFlowManagerMain.Input.cs' && moduleId === 'hold_trigger') {
    return buildDeterministicHoldLines(moduleInstance, plans);
  }
  if (fileName === 'GameFlowManagerMain.Flow.cs' && moduleId === 'move_to_target') {
    return buildDeterministicMoveLines(moduleInstance, plans);
  }
  if (fileName === 'GameFlowManagerMain.Flow.cs' && moduleId === 'proximity_trigger') {
    return buildDeterministicProximityLines(moduleInstance, plans);
  }
  if (fileName === 'GameFlowManagerMain.Resource.cs' && moduleId === 'cost_gate') {
    return buildDeterministicCostGateLines(moduleInstance, plans);
  }
  if (fileName === 'GameFlowManagerMain.Flow.cs' && moduleId === 'build_progress') {
    return buildDeterministicBuildLines(moduleInstance, plans);
  }
  if (fileName === 'GameFlowManagerMain.Flow.cs' && moduleId === 'upgrade_progress') {
    return buildDeterministicUpgradeLines(moduleInstance, plans);
  }
  if (fileName === 'GameFlowManagerMain.Flow.cs' && moduleId === 'target_acquire') {
    return buildDeterministicTargetAcquireLines(moduleInstance, plans);
  }
  if (fileName === 'GameFlowManagerMain.Flow.cs' && moduleId === 'projectile_emit') {
    return buildDeterministicProjectileLines(moduleInstance, plans);
  }
  if (fileName === 'GameFlowManagerMain.Flow.cs' && moduleId === 'apply_damage') {
    return buildDeterministicDamageLines(moduleInstance, plans);
  }
  if (fileName === 'GameFlowManagerMain.Flow.cs' && moduleId === 'damageable') {
    return buildDeterministicDamageableLines(moduleInstance, plans);
  }
  if (fileName === 'GameFlowManagerMain.Flow.cs' && moduleId === 'cooldown') {
    return buildDeterministicCooldownLines(moduleInstance, plans);
  }
  if ((fileName === 'GameFlowManagerMain.Flow.cs' || fileName === 'GameFlowManagerMain.Scene.cs') && (moduleId === 'spawn_interval' || moduleId === 'spawn_once')) {
    return buildDeterministicSpawnLines(moduleInstance, plans);
  }
  if (fileName === 'GameFlowManagerMain.Flow.cs' && moduleId === 'on_death_drop') {
    return buildDeterministicDeathDropLines(moduleInstance, plans);
  }
  if (fileName === 'GameFlowManagerMain.Flow.cs' && moduleId === 'phase_gate_timer') {
    return buildDeterministicPhaseTimerLines(moduleInstance, plans);
  }
  if (fileName === 'GameFlowManagerMain.Flow.cs' && moduleId === 'form_switch') {
    return buildDeterministicFormSwitchLines(moduleInstance, plans);
  }
  if (fileName === 'GameFlowManagerMain.Flow.cs' && moduleId === 'activate_targets') {
    return buildDeterministicActivateLines(moduleInstance, plans);
  }
  if (fileName === 'GameFlowManagerMain.Flow.cs' && moduleId === 'pop_animation') {
    return buildDeterministicPopAnimationLines(moduleInstance, plans);
  }
  if (fileName === 'GameFlowManagerMain.Resource.cs' && moduleId === 'inventory_wallet') {
    return buildDeterministicInventoryWalletLines(moduleInstance, plans);
  }
  if (fileName === 'GameFlowManagerMain.Resource.cs' && moduleId === 'collect_on_near') {
    return buildDeterministicCollectLines(moduleInstance, plans);
  }
  if (fileName === 'GameFlowManagerMain.Resource.cs' && moduleId === 'deliver_to_target') {
    return buildDeterministicDeliverLines(moduleInstance, plans);
  }
  if (fileName === 'GameFlowManagerMain.UI.cs' && moduleId === 'score_feedback') {
    return buildDeterministicScoreLines(moduleInstance, plans);
  }
  if (fileName === 'GameFlowManagerMain.UI.cs' && moduleId === 'floating_text_feedback') {
    return buildDeterministicFloatingTextLines(moduleInstance, plans);
  }
  if (fileName === 'GameFlowManagerMain.UI.cs' && moduleId === 'world_label') {
    return buildDeterministicWorldLabelLines(moduleInstance, plans);
  }
  if (fileName === 'GameFlowManagerMain.UI.cs' && moduleId === 'highlight_target') {
    return buildDeterministicHighlightLines(moduleInstance, plans);
  }
  if (fileName === 'GameFlowManagerMain.UI.cs' && moduleId === 'cta_finish') {
    return buildDeterministicCtaFinishLines(moduleInstance, plans);
  }
  if (fileName === 'GameFlowManagerMain.UI.cs' && moduleId === 'guide_ui') {
    return buildDeterministicGuideLines(plans);
  }
  if ((fileName === 'GameFlowManagerMain.Flow.cs' || fileName === 'GameFlowManagerMain.Scene.cs') && moduleId === 'camera_focus') {
    return buildDeterministicCameraFocusLines(moduleInstance, plans);
  }
  if ((fileName === 'GameFlowManagerMain.Flow.cs' || fileName === 'GameFlowManagerMain.Scene.cs') && moduleId === 'camera_zoom') {
    return buildDeterministicCameraZoomLines(moduleInstance, plans);
  }
  if ((fileName === 'GameFlowManagerMain.Flow.cs' || fileName === 'GameFlowManagerMain.Scene.cs') && moduleId === 'camera_lift') {
    return buildDeterministicCameraLiftLines(moduleInstance, plans);
  }
  return [];
}

function moduleRelevantToPhase(moduleInstance, phaseBinding) {
  if (!moduleInstance || !phaseBinding) return false;
  var sourceAtomIds = toArray(moduleInstance.sourceAtomIds);
  var phaseAtomIds = toArray(phaseBinding.atomIds);
  if (sourceAtomIds.length > 0) {
    for (var i = 0; i < sourceAtomIds.length; i++) {
      if (phaseAtomIds.indexOf(sourceAtomIds[i]) >= 0) return true;
    }
    return false;
  }
  var entity = String(moduleInstance.entity || '');
  if (entity && toArray(phaseBinding.activateEntities).indexOf(entity) >= 0) return true;
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

function buildSlotMethod(fileName, moduleInstance, plans) {
  var methodName = slotMethodName(fileName, moduleInstance);
  var deterministicBody = buildDeterministicBodyLines(fileName, moduleInstance, plans);
  var lines = [];
  if (moduleInstance.moduleId === 'cost_gate') {
    lines.push('    // Per-slot spend guard so each cost gate only consumes resources once.');
    lines.push('    bool ' + slotDoneFieldName(fileName, moduleInstance) + ' = false;');
    lines.push('');
  }
  lines.push('    // [ASSEMBLY SLOT] ' + moduleInstance.id);
  lines.push('    // moduleId: ' + moduleInstance.moduleId);
  lines.push('    // entity: ' + (moduleInstance.entity || 'system'));
  lines.push('    // ownerFile: ' + fileName);
  lines.push('    // statesWritten: ' + (toArray(moduleInstance.statesWritten).length > 0 ? toArray(moduleInstance.statesWritten).join(', ') : '(none)'));
  lines.push('    // expectedSignals: ' + (toArray(moduleInstance.expectedSignals).length > 0 ? toArray(moduleInstance.expectedSignals).join(', ') : '(none)'));
  lines.push('    // observableFeedback: ' + (toArray(moduleInstance.observableFeedback).length > 0 ? toArray(moduleInstance.observableFeedback).join(', ') : '(none)'));
  lines.push('    // sourceAtoms: ' + (toArray(moduleInstance.sourceAtomIds).length > 0 ? toArray(moduleInstance.sourceAtomIds).join(', ') : '(none)'));
  Array.prototype.push.apply(lines, buildCommentedJsonLines('    // params: ', moduleInstance.params));
  Array.prototype.push.apply(lines, buildCommentedJsonLines('    // phaseEvidenceSchema: ', moduleInstance.phaseEvidenceSchema || []));
  lines.push('    void ' + methodName + '()');
  lines.push('    {');
  lines.push('        // TODO_' + methodName + '_START');
  if (deterministicBody.length > 0) {
    Array.prototype.push.apply(lines, deterministicBody);
  } else {
    lines.push('        // Implement only `' + moduleInstance.moduleId + '` for `' + (moduleInstance.entity || 'system') + '` in this owner file.');
    lines.push('        // This slot is generated deterministically from AssemblyPlan; keep logic local to this module.');
  }
  lines.push('        // TODO_' + methodName + '_END');
  lines.push('    }');
  return lines.join('\n');
}

function buildRunnerMethod(fileName, moduleInstances) {
  var tag = ownerTag(fileName);
  var methodName = 'AssemblyRun' + tag + 'Slots';
  var lines = [];
  lines.push('    // Runs deterministic assembly slots owned by ' + fileName + '.');
  lines.push('    void ' + methodName + '()');
  lines.push('    {');
  if (!moduleInstances || moduleInstances.length === 0) {
    lines.push('        // No assembly slots owned by ' + fileName + '.');
  } else {
    for (var i = 0; i < moduleInstances.length; i++) {
      lines.push('        AssemblySlot_' + tag + '_' + sanitizeId(moduleInstances[i].id) + '();');
    }
  }
  lines.push('    }');
  return lines.join('\n');
}

function buildOwnerSlotSection(fileName, moduleInstances, plans) {
  var lines = buildOwnerManifestLines(fileName, moduleInstances, plans);
  if (moduleInstances.length === 0) {
    lines.push('    // No module instances currently owned by this file.');
    lines.push('');
    lines.push(buildRunnerMethod(fileName, moduleInstances));
    return lines.join('\n');
  }

  lines.push('');
  lines.push('    // ========== Deterministic Assembly Slots ==========');
  for (var i = 0; i < moduleInstances.length; i++) {
    if (i > 0) lines.push('');
    lines.push(buildSlotMethod(fileName, moduleInstances[i], plans));
  }
  lines.push('');
  lines.push(buildRunnerMethod(fileName, moduleInstances));
  return lines.join('\n');
}

function injectAssemblyTickIntoMain(mainCode) {
  var marker = '// TODO_CUSTOM_START';
  var text = String(mainCode || '');
  var idx = text.indexOf(marker);
  if (idx < 0) return text;
  var before = text.substring(0, idx + marker.length);
  var after = text.substring(idx + marker.length);
  var body = [
    '',
    '        AssemblyRunFlowSlots();',
    '        AssemblyRunInputSlots();',
    '        AssemblyRunResourceSlots();',
    '        AssemblyRunUISlots();',
    '        AssemblyRunSceneSlots();'
  ].join('\n');
  return before + body + after;
}

function buildPhaseCommentLines(fileName, phaseBinding, plans) {
  var fileModules = moduleInstancesForFile(plans, fileName).filter(function(moduleInstance) {
    return moduleRelevantToPhase(moduleInstance, phaseBinding);
  });
  var lines = [];
  lines.push('        // [ASSEMBLY PHASE] phaseId=' + phaseBinding.phaseId);
  lines.push('        // activateEntities: ' + (toArray(phaseBinding.activateEntities).length > 0 ? toArray(phaseBinding.activateEntities).join(', ') : '(none)'));
  lines.push('        // completionSignals: ' + (toArray(phaseBinding.completionSignals).length > 0 ? toArray(phaseBinding.completionSignals).join(', ') : '(none)'));
  var cuaSteps = plans && plans.cuaPlan && Array.isArray(plans.cuaPlan.steps) ? plans.cuaPlan.steps : [];
  for (var si = 0; si < cuaSteps.length; si++) {
    if (cuaSteps[si].phaseId !== phaseBinding.phaseId) continue;
    lines.push('        // phaseEvidenceSchema: ' + JSON.stringify(cuaSteps[si].phaseEvidenceSchema || []));
    break;
  }
  if (fileModules.length > 0) {
    lines.push('        // ownerSlots(' + ownerTag(fileName) + '): ' + fileModules.map(function(item) { return item.id; }).join(', '));
  }
  return lines;
}

function annotateFlowPhaseMethods(flowCode, plans) {
  var content = String(flowCode || '');
  var phaseIndex = buildPhaseBindingIndex(plans);
  var stepIndex = buildCuaStepIndex(plans);
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
    content = injectAutoplayFallbackEvidence(content, suffix, phaseIndex[phaseId], stepIndex[phaseId]);
  });
  return content;
}

function injectAutoplayFallbackEvidence(content, suffix, phaseBinding, step) {
  if (!step && !phaseBinding) return content;
  var phaseId = String((phaseBinding && phaseBinding.phaseId) || (step && step.phaseId) || suffix || '');
  var expectedSignals = uniq(toArray(phaseBinding && phaseBinding.completionSignals).concat(toArray(step && step.expectedSignals)));
  var lines = [];
  var targetRemovedTarget = firstActionTarget(step, ['observe_defeat', 'defeat']);

  if (hasSignal(expectedSignals, 'target_hp_decreased_or_target_dead') && hasActionKind(step, ['attack', 'observe_defeat', 'defeat'])) {
    lines.push('            RecordPhaseEvidenceFlag("' + phaseId.replace(/"/g, '\\"') + '", "target_hp_decreased_or_target_dead");');
  }

  if (hasSignal(expectedSignals, 'target_removed_or_hidden') && (targetRemovedTarget || hasActionKind(step, ['observe_defeat', 'defeat']))) {
    if (targetRemovedTarget) {
      lines.push('            if (' + targetRemovedTarget + ' != null) HideObj(' + targetRemovedTarget + ');');
      lines.push('            ' + targetRemovedTarget + 'Done = true;');
      lines.push('            ' + targetRemovedTarget + 'State = Mathf.Max(' + targetRemovedTarget + 'State, 3);');
    }
    lines.push('            RecordPhaseEvidenceFlag("' + phaseId.replace(/"/g, '\\"') + '", "target_removed_or_hidden");');
  }

  if (hasSignal(expectedSignals, 'source_hidden_or_moved') && hasActionKind(step, ['approach_collect', 'collect', 'deliver', 'sell'])) {
    lines.push('            RecordPhaseEvidenceFlag("' + phaseId.replace(/"/g, '\\"') + '", "source_hidden_or_moved");');
  }

  if (hasSignal(expectedSignals, 'player_position_changed') && hasActionKind(step, ['move_to'])) {
    lines.push('            RecordPhaseEvidenceFlag("' + phaseId.replace(/"/g, '\\"') + '", "player_position_changed");');
  }

  if (hasSignal(expectedSignals, 'loot_visible') && targetRemovedTarget) {
    lines.push('            RecordPhaseEvidenceFlag("' + phaseId.replace(/"/g, '\\"') + '", "loot_visible");');
  }

  if (lines.length === 0) return content;

  var marker = '// [ASSEMBLY FALLBACK EVIDENCE] action-backed signal evidence';
  var start = '// TODO_PHASE_' + suffix + '_ONAUTOARRIVE_START';
  var end = '// TODO_PHASE_' + suffix + '_ONAUTOARRIVE_END';
  var startIdx = content.indexOf(start);
  var endIdx = content.indexOf(end, startIdx >= 0 ? startIdx : 0);
  if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) return content;

  var region = content.substring(startIdx, endIdx);
  if (region.indexOf(marker) >= 0) return content;

  var phaseLiteral = phaseId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/"/g, '\\"');
  var guideLineRe = new RegExp('(RecordPhaseEvidenceFlag\\("' + phaseLiteral + '", "guide_text_visible"\\);\\n)');
  var insertion = [
    '            ' + marker + ' from CUA actions.',
  ].concat(lines).join('\n') + '\n';
  var nextRegion;
  if (guideLineRe.test(region)) {
    nextRegion = region.replace(guideLineRe, '$1' + insertion);
  } else {
    nextRegion = region.replace(start, start + '\n' + insertion);
  }
  return content.substring(0, startIdx) + nextRegion + content.substring(endIdx);
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

function computeImplementationCoverage(plans) {
  var ownerFiles = [
    'GameFlowManagerMain.Flow.cs',
    'GameFlowManagerMain.Input.cs',
    'GameFlowManagerMain.Resource.cs',
    'GameFlowManagerMain.UI.cs',
    'GameFlowManagerMain.Scene.cs',
  ];
  var total = 0;
  var implemented = 0;
  var missing = [];
  var implementedModuleIds = {};
  var missingModuleIds = {};

  for (var i = 0; i < ownerFiles.length; i++) {
    var fileName = ownerFiles[i];
    var moduleInstances = moduleInstancesForFile(plans, fileName);
    for (var j = 0; j < moduleInstances.length; j++) {
      var moduleInstance = moduleInstances[j];
      total++;
      var body = buildDeterministicBodyLines(fileName, moduleInstance, plans);
      if (body.length > 0) {
        implemented++;
        implementedModuleIds[moduleInstance.moduleId] = true;
      } else {
        missing.push({
          file: fileName,
          id: moduleInstance.id,
          moduleId: moduleInstance.moduleId,
          entity: moduleInstance.entity || '',
        });
        missingModuleIds[moduleInstance.moduleId] = true;
      }
    }
  }

  return {
    total: total,
    implemented: implemented,
    missing: missing,
    coverage: total > 0 ? implemented / total : 1,
    implementedModuleIds: Object.keys(implementedModuleIds).sort(),
    missingModuleIds: Object.keys(missingModuleIds).sort(),
  };
}

function applyAssemblyPlanToSkeleton(skeletonResult, plans) {
  if (!skeletonResult || typeof skeletonResult !== 'object' || !plans || !plans.assemblyPlan) {
    return {
      files: skeletonResult,
      slotCount: 0,
      ownerSummary: {},
      implementationCoverage: computeImplementationCoverage(plans),
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
    'GameFlowManagerMain.cs': files.main,
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

  contentByFile['GameFlowManagerMain.cs'] = injectAssemblyTickIntoMain(contentByFile['GameFlowManagerMain.cs']);
  files.flow = contentByFile['GameFlowManagerMain.Flow.cs'];
  files.input = contentByFile['GameFlowManagerMain.Input.cs'];
  files.resource = contentByFile['GameFlowManagerMain.Resource.cs'];
  files.ui = contentByFile['GameFlowManagerMain.UI.cs'];
  files.scene = contentByFile['GameFlowManagerMain.Scene.cs'];
  files.main = contentByFile['GameFlowManagerMain.cs'];

  return {
    files: files,
    slotCount: slotCount,
    ownerSummary: ownerSummary,
    implementationCoverage: computeImplementationCoverage(plans),
  };
}

module.exports = {
  applyAssemblyPlanToSkeleton: applyAssemblyPlanToSkeleton,
  buildCommentedJsonLines: buildCommentedJsonLines,
  extractAssemblySlotRegions: extractAssemblySlotRegions,
  mergeAssemblySlotEdits: mergeAssemblySlotEdits,
  computeImplementationCoverage: computeImplementationCoverage,
  moduleInstancesForFile: moduleInstancesForFile,
  ownerTag: ownerTag,
  sanitizeId: sanitizeId,
};
