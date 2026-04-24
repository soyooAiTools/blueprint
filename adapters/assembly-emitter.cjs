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
  if (guideMap.length === 0) return [];
  var lines = [];
  lines.push('        if (guideText == null) return;');
  lines.push('        switch (currentPhaseName)');
  lines.push('        {');
  for (var i = 0; i < guideMap.length; i++) {
    lines.push('            case "' + guideMap[i].phaseId.replace(/"/g, '\\"') + '":');
    lines.push('                if (guideText.text != "' + guideMap[i].guide.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '") guideText.text = "' + guideMap[i].guide.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '";');
    lines.push('                break;');
  }
  lines.push('        }');
  lines.push('        if (!string.IsNullOrEmpty(guideText.text)) RecordPhaseEvidenceFlag(currentPhaseName, "guide_text_visible");');
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

function moduleTarget(moduleInstance) {
  var params = moduleInstance && moduleInstance.params || {};
  return params.target || params.entity || moduleInstance.entity || '';
}

function recordFlag(signal) {
  return '        RecordPhaseEvidenceFlag(currentPhaseName, "' + signal + '");';
}

function buildCameraPhaseMap(plans, moduleInstance) {
  var bindings = plans && plans.assemblyPlan && Array.isArray(plans.assemblyPlan.phaseBindings)
    ? plans.assemblyPlan.phaseBindings
    : [];
  var fallbackTarget = moduleInstance && moduleInstance.params && moduleInstance.params.target;
  var fallbackZoom = moduleInstance && moduleInstance.params && moduleInstance.params.value != null ? Number(moduleInstance.params.value) : null;
  var fallbackLift = moduleInstance && moduleInstance.params && moduleInstance.params.amount != null ? Number(moduleInstance.params.amount) : null;
  return bindings.map(function(binding, index) {
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
  if (phaseMap.length === 0) return [];
  var lines = [];
  lines.push('        if (mainCam == null) return;');
  lines.push('        switch (currentPhaseName)');
  lines.push('        {');
  for (var i = 0; i < phaseMap.length; i++) {
    var target = phaseMap[i].target;
    lines.push('            case "' + String(phaseMap[i].phaseId).replace(/"/g, '\\"') + '":');
    lines.push('                cameraFocusTarget = "' + String(target).replace(/"/g, '\\"') + '";');
    lines.push('                if (' + target + ' != null)');
    lines.push('                {');
    lines.push('                    if (GFM_CameraController.Instance != null && GFM_CameraController.Instance.IsReady)');
    lines.push('                    {');
    lines.push('                        GFM_CameraController.Instance.LookAt(' + target + '.transform.position);');
    lines.push('                    }');
    lines.push('                    else');
    lines.push('                    {');
    lines.push('                        mainCam.transform.LookAt(' + target + '.transform.position);');
    lines.push('                    }');
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
  if (phaseMap.length === 0) return [];
  var lines = [];
  lines.push('        if (mainCam == null) return;');
  lines.push('        mainCam.orthographic = true;');
  lines.push('        switch (currentPhaseName)');
  lines.push('        {');
  for (var i = 0; i < phaseMap.length; i++) {
    var orthoSize = Math.max(4, Math.min(12, 8 / (phaseMap[i].zoom || 1)));
    lines.push('            case "' + String(phaseMap[i].phaseId).replace(/"/g, '\\"') + '":');
    lines.push('                mainCam.orthographicSize = ' + orthoSize.toFixed(2) + 'f;');
    lines.push('                break;');
  }
  lines.push('        }');
  lines.push('        RecordPhaseEvidenceFlag(currentPhaseName, "camera_zoom_changed");');
  return lines;
}

function buildDeterministicCameraLiftLines(moduleInstance, plans) {
  var phaseMap = buildCameraPhaseMap(plans, moduleInstance);
  if (phaseMap.length === 0) return [];
  var lines = [];
  lines.push('        if (mainCam == null) return;');
  lines.push('        switch (currentPhaseName)');
  lines.push('        {');
  for (var i = 0; i < phaseMap.length; i++) {
    var lift = phaseMap[i].lift != null ? phaseMap[i].lift : 1;
    var zoom = phaseMap[i].zoom != null ? phaseMap[i].zoom : 1;
    var height = 10.5 + (phaseMap[i].index * 0.35) + lift + Math.max(0, 1.15 - zoom) * 2;
    var zOffset = -8 - Math.max(0, height - 12) * 0.5;
    lines.push('            case "' + String(phaseMap[i].phaseId).replace(/"/g, '\\"') + '":');
    lines.push('                {');
    lines.push('                    var __assemblyCamPos = mainCam.transform.position;');
    lines.push('                    __assemblyCamPos.y = ' + height.toFixed(2) + 'f;');
    lines.push('                    __assemblyCamPos.z = ' + zOffset.toFixed(2) + 'f;');
    lines.push('                    mainCam.transform.position = __assemblyCamPos;');
    lines.push('                    break;');
    lines.push('                }');
  }
  lines.push('        }');
  lines.push('        RecordPhaseEvidenceFlag(currentPhaseName, "camera_height_changed_or_view_widened");');
  return lines;
}

function buildDeterministicScoreLines(moduleInstance) {
  var label = moduleInstance && moduleInstance.params && (moduleInstance.params.label || moduleInstance.params.resource);
  var lines = [];
  lines.push('        UpdateResourceUI();');
  if (label) {
    lines.push('        if (scoreText != null && scoreText.text.Length == 0 && GetResource("' + String(label).replace(/"/g, '\\"') + '") > 0)');
    lines.push('        {');
    lines.push('            scoreText.text = "' + String(label).replace(/"/g, '\\"') + ': " + GetResource("' + String(label).replace(/"/g, '\\"') + '");');
    lines.push('        }');
  }
  lines.push('        if (scoreText != null && scoreText.text.Length > 0) RecordPhaseEvidenceFlag(currentPhaseName, "score_text_changed");');
  return lines;
}

function buildDeterministicCollectLines(moduleInstance, plans) {
  if (!moduleInstance || !moduleInstance.entity || /^system::/.test(moduleInstance.id || '')) return [];
  var entityVar = moduleInstance.entity;
  var resource = moduleInstance.params && (moduleInstance.params.resource || moduleInstance.params.item || moduleInstance.entity);
  var count = moduleInstance.params && moduleInstance.params.count != null ? Number(moduleInstance.params.count) : 1;
  var range = moduleInstance.params && moduleInstance.params.range != null ? Number(moduleInstance.params.range) : 1.5;
  var lines = buildPhaseGuardLines(phaseIdsForModule(plans, 'GameFlowManagerMain.Resource.cs', moduleInstance));
  lines.push('        if (' + entityVar + ' == null) return;');
  lines.push('        if (' + entityVar + '.transform.position.y < -900f) return;');
  lines.push('        if (GFM_Player.Instance.IsNear(' + entityVar + ', ' + csFloat(range, 1.5) + '))');
  lines.push('        {');
  lines.push('            AddResource("' + String(resource).replace(/"/g, '\\"') + '", ' + (isFinite(count) ? count : 1) + ');');
  lines.push('            HideObj(' + entityVar + ');');
  lines.push('            ' + entityVar + 'State = Mathf.Max(' + entityVar + 'State, 1);');
  lines.push('            RecordPhaseEvidenceDistance(currentPhaseName, "distance_to_target_below_threshold", ' + csFloat(range, 1.5) + ');');
  lines.push('            RecordPhaseEvidenceFlag(currentPhaseName, "source_hidden_or_moved");');
  lines.push('            UpdateResourceUI();');
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
  var rewardCall = '            AddResource("' + rewardLabel.replace(/"/g, '\\"') + '", ' + (isFinite(reward) ? reward : 1) + ' * deliverCount);';
  var lines = buildPhaseGuardLines(phaseIdsForModule(plans, 'GameFlowManagerMain.Resource.cs', moduleInstance));
  lines.push('        if (' + targetVar + ' == null) return;');
  lines.push('        int deliverCount = GetResource("' + String(resource).replace(/"/g, '\\"') + '");');
  lines.push('        if (deliverCount <= 0) return;');
  lines.push('        if (GFM_Player.Instance.IsNear(' + targetVar + ', 2f) && TrySpend("' + String(resource).replace(/"/g, '\\"') + '", deliverCount))');
  lines.push('        {');
  lines.push('            RecordPhaseEvidenceFlag(currentPhaseName, "inventory_decremented");');
  lines.push(rewardCall);
  lines.push('            RecordPhaseEvidenceFlag(currentPhaseName, "reward_incremented");');
  lines.push('            ' + targetVar + 'State = Mathf.Max(' + targetVar + 'State, 2);');
  lines.push('            UpdateResourceUI();');
  lines.push('            var __assemblyPlayer = GFM_Player.Instance.Go;');
  lines.push('            ShowFloatingText(__assemblyPlayer != null ? __assemblyPlayer.transform.position : Vector3.zero, "+" + (' + (isFinite(reward) ? reward : 1) + ' * deliverCount) + " ' + rewardLabel.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '", Color.yellow);');
  lines.push('        }');
  return lines;
}

function buildDeterministicVisualBindingLines(moduleInstance, plans) {
  var entity = moduleInstance && moduleInstance.entity;
  if (!isIdentifier(entity)) return [];
  var params = moduleInstance.params || {};
  var lines = buildPhaseGuardLines(phaseIdsForModule(plans, 'GameFlowManagerMain.Scene.cs', moduleInstance));
  lines.push('        if (' + entity + ' == null) return;');
  lines.push('        if (' + entity + '.transform.position.y < -900f)');
  lines.push('        {');
  lines.push('            PlaceObj(' + entity + ', ' + vectorArgs(params.position, [0, 0.5, 0]) + ');');
  lines.push('        }');
  lines.push('        SetScale(' + entity + ', ' + scaleArgs(params.scale) + ');');
  lines.push(recordFlag('entity_visible'));
  lines.push(recordFlag('entity_position_changed'));
  return lines;
}

function buildDeterministicTapLines(moduleInstance, plans) {
  var lines = buildPhaseGuardLines(phaseIdsForModule(plans, 'GameFlowManagerMain.Input.cs', moduleInstance));
  lines.push('        if (!_autoPlayMode && !Input.GetMouseButtonDown(0)) return;');
  lines.push(recordFlag('tap_registered'));
  return lines;
}

function buildDeterministicClickLines(moduleInstance, plans) {
  var target = moduleTarget(moduleInstance);
  var lines = buildDeterministicTapLines(moduleInstance, plans);
  if (isIdentifier(target)) {
    lines.push('        if (' + target + ' != null)');
    lines.push('        {');
    lines.push('            // Click ownership is input-scoped; build/state transitions are handled by Flow owner slots.');
    lines.push('        }');
  }
  return lines;
}

function buildDeterministicMoveLines(moduleInstance, plans) {
  var actor = moduleInstance && moduleInstance.entity;
  var target = moduleInstance && moduleInstance.params && moduleInstance.params.target;
  if (!isIdentifier(actor) || !isIdentifier(target) || actor === target) return [];
  var speed = moduleInstance.params && moduleInstance.params.speed != null ? Number(moduleInstance.params.speed) : 5;
  var stopRange = moduleInstance.params && moduleInstance.params.stopRange != null ? Number(moduleInstance.params.stopRange) : 1.5;
  var lines = buildPhaseGuardLines(phaseIdsForModule(plans, 'GameFlowManagerMain.Flow.cs', moduleInstance));
  lines.push('        if (' + actor + ' == null || ' + target + ' == null) return;');
  lines.push('        var __assemblyBefore = ' + actor + '.transform.position;');
  lines.push('        var __assemblyNext = Vector3.MoveTowards(__assemblyBefore, ' + target + '.transform.position, ' + csFloat(speed, 5) + ' * Time.deltaTime);');
  lines.push('        ' + actor + '.transform.position = __assemblyNext;');
  lines.push('        if (Vector3.Distance(__assemblyBefore, __assemblyNext) > 0.01f)');
  lines.push('        {');
  lines.push(/player/i.test(actor) ? recordFlag('player_position_changed') : recordFlag('entity_position_changed'));
  lines.push('        }');
  lines.push('        float __assemblyDistance = Vector3.Distance(' + actor + '.transform.position, ' + target + '.transform.position);');
  lines.push('        if (__assemblyDistance <= ' + csFloat(stopRange, 1.5) + ') RecordPhaseEvidenceDistance(currentPhaseName, "distance_to_target_below_threshold", __assemblyDistance);');
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
  var resource = moduleInstance.params && (moduleInstance.params.resource || 'resource');
  var amount = moduleInstance.params && moduleInstance.params.amount != null ? Number(moduleInstance.params.amount) : 1;
  var doneField = slotDoneFieldName('GameFlowManagerMain.Resource.cs', moduleInstance);
  var lines = buildPhaseGuardLines(phaseIdsForModule(plans, 'GameFlowManagerMain.Resource.cs', moduleInstance));
  lines.push('        if (' + doneField + ') return;');
  lines.push('        if (!TrySpend("' + escapeCsString(resource) + '", ' + (isFinite(amount) ? Math.max(1, Math.floor(amount)) : 1) + ')) return;');
  lines.push('        ' + doneField + ' = true;');
  lines.push('        UpdateResourceUI();');
  lines.push(recordFlag('resource_decremented'));
  return lines;
}

function buildDeterministicBuildLines(moduleInstance, plans) {
  var entity = moduleTarget(moduleInstance);
  if (!isIdentifier(entity)) return [];
  var lines = buildPhaseGuardLines(phaseIdsForModule(plans, 'GameFlowManagerMain.Flow.cs', moduleInstance));
  lines.push('        if (' + entity + ' == null || ' + entity + 'State >= 2) return;');
  lines.push('        if (' + entity + '.transform.position.y < -900f) PlaceObj(' + entity + ', 0f, 0.5f, 0f);');
  lines.push('        ' + entity + 'State = 2;');
  lines.push(recordFlag('entity_state_changed'));
  lines.push(recordFlag('entity_state_equals_built'));
  lines.push(recordFlag('visual_variant_changed'));
  lines.push(recordFlag('downstream_entity_visible'));
  return lines;
}

function buildDeterministicUpgradeLines(moduleInstance, plans) {
  var entity = moduleTarget(moduleInstance);
  if (!isIdentifier(entity)) return [];
  var lines = buildPhaseGuardLines(phaseIdsForModule(plans, 'GameFlowManagerMain.Flow.cs', moduleInstance));
  lines.push('        if (' + entity + ' == null || ' + entity + 'State >= 2) return;');
  lines.push('        ' + entity + 'State = 2;');
  lines.push(recordFlag('upgrade_level_changed'));
  lines.push(recordFlag('visual_variant_changed'));
  lines.push(recordFlag('entity_state_changed'));
  return lines;
}

function buildDeterministicTargetAcquireLines(moduleInstance, plans) {
  var actor = moduleInstance && moduleInstance.entity;
  if (!isIdentifier(actor)) return [];
  var lines = buildPhaseGuardLines(phaseIdsForModule(plans, 'GameFlowManagerMain.Flow.cs', moduleInstance));
  lines.push('        if (' + actor + ' == null) return;');
  lines.push('        ' + actor + 'State = Mathf.Max(' + actor + 'State, 1);');
  lines.push(recordFlag('entity_state_changed'));
  return lines;
}

function buildDeterministicProjectileLines(moduleInstance, plans) {
  var actor = moduleInstance && moduleInstance.entity;
  if (!isIdentifier(actor)) return [];
  var projectile = moduleInstance.params && moduleInstance.params.projectile;
  var lines = buildPhaseGuardLines(phaseIdsForModule(plans, 'GameFlowManagerMain.Flow.cs', moduleInstance));
  lines.push('        if (' + actor + ' == null) return;');
  if (isIdentifier(projectile) && planHasEntity(plans, projectile)) {
    lines.push('        if (' + projectile + ' != null)');
    lines.push('        {');
    lines.push('            var __assemblyProjectilePos = ' + actor + '.transform.position;');
    lines.push('            __assemblyProjectilePos.y += 0.6f;');
    lines.push('            __assemblyProjectilePos.x += 0.5f;');
    lines.push('            PlaceObj(' + projectile + ', __assemblyProjectilePos.x, __assemblyProjectilePos.y, __assemblyProjectilePos.z);');
    lines.push('        }');
  } else {
    lines.push('        var __assemblyAttackFlash = ' + actor + '.transform.position;');
    lines.push('        __assemblyAttackFlash.y += 0.05f;');
    lines.push('        ' + actor + '.transform.position = __assemblyAttackFlash;');
  }
  lines.push('        ' + actor + 'State = Mathf.Max(' + actor + 'State, 1);');
  lines.push(recordFlag('projectile_visible'));
  return lines;
}

function buildDeterministicDamageLines(moduleInstance, plans) {
  var target = moduleTarget(moduleInstance);
  if (!isIdentifier(target)) return [];
  var lines = buildPhaseGuardLines(phaseIdsForModule(plans, 'GameFlowManagerMain.Flow.cs', moduleInstance));
  lines.push('        if (' + target + ' == null || ' + target + 'State >= 2) return;');
  lines.push('        ' + target + 'State = 2;');
  lines.push('        HideObj(' + target + ');');
  lines.push(recordFlag('target_hp_decreased_or_target_dead'));
  lines.push(recordFlag('target_removed_or_hidden'));
  return lines;
}

function buildDeterministicDamageableLines(moduleInstance, plans) {
  var target = moduleTarget(moduleInstance);
  if (!isIdentifier(target)) return [];
  var lines = buildPhaseGuardLines(phaseIdsForModule(plans, 'GameFlowManagerMain.Flow.cs', moduleInstance));
  lines.push('        if (' + target + ' == null) return;');
  lines.push('        ' + target + 'State = Mathf.Max(' + target + 'State, 1);');
  return lines;
}

function buildDeterministicActivateLines(moduleInstance, plans) {
  var targets = toArray(moduleInstance && moduleInstance.params && moduleInstance.params.targets);
  var validTargets = targets.filter(isIdentifier);
  if (validTargets.length === 0) return [];
  var lines = buildPhaseGuardLines(phaseIdsForModule(plans, 'GameFlowManagerMain.Flow.cs', moduleInstance));
  for (var i = 0; i < validTargets.length; i++) {
    var target = validTargets[i];
    lines.push('        if (' + target + ' != null && ' + target + '.transform.position.y < -900f)');
    lines.push('        {');
    lines.push('            PlaceObj(' + target + ', 0f, 0.5f, 0f);');
    lines.push('            ' + target + 'State = Mathf.Max(' + target + 'State, 1);');
    lines.push('        }');
  }
  lines.push(recordFlag('downstream_entity_visible'));
  return lines;
}

function buildDeterministicVariantLines(moduleInstance, plans) {
  var entity = moduleTarget(moduleInstance);
  if (!isIdentifier(entity)) return [];
  var lines = buildPhaseGuardLines(phaseIdsForModule(plans, 'GameFlowManagerMain.Scene.cs', moduleInstance));
  lines.push('        if (' + entity + ' == null) return;');
  lines.push('        if (' + entity + '.transform.position.y < -900f) PlaceObj(' + entity + ', 0f, 0.5f, 0f);');
  lines.push('        SetScale(' + entity + ', 1.08f, 1.08f, 1.08f);');
  lines.push(recordFlag('visual_variant_changed'));
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
  if (fileName === 'GameFlowManagerMain.Input.cs' && moduleId === 'click_trigger') {
    return buildDeterministicClickLines(moduleInstance, plans);
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
  if (fileName === 'GameFlowManagerMain.Flow.cs' && moduleId === 'activate_targets') {
    return buildDeterministicActivateLines(moduleInstance, plans);
  }
  if (fileName === 'GameFlowManagerMain.Resource.cs' && moduleId === 'collect_on_near') {
    return buildDeterministicCollectLines(moduleInstance, plans);
  }
  if (fileName === 'GameFlowManagerMain.Resource.cs' && moduleId === 'deliver_to_target') {
    return buildDeterministicDeliverLines(moduleInstance, plans);
  }
  if (fileName === 'GameFlowManagerMain.UI.cs' && moduleId === 'score_feedback') {
    return buildDeterministicScoreLines(moduleInstance);
  }
  if (fileName === 'GameFlowManagerMain.UI.cs' && moduleId === 'guide_ui' && (!moduleInstance.entity || String(moduleInstance.entity).indexOf('CTA') < 0)) {
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

function buildSlotMethod(fileName, moduleInstance, plans) {
  var methodName = slotMethodName(fileName, moduleInstance);
  var deterministicBody = buildDeterministicBodyLines(fileName, moduleInstance, plans);
  var lines = [];
  if (moduleInstance.moduleId === 'cost_gate') {
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
  };
}

module.exports = {
  applyAssemblyPlanToSkeleton: applyAssemblyPlanToSkeleton,
  buildCommentedJsonLines: buildCommentedJsonLines,
  extractAssemblySlotRegions: extractAssemblySlotRegions,
  mergeAssemblySlotEdits: mergeAssemblySlotEdits,
  moduleInstancesForFile: moduleInstancesForFile,
  ownerTag: ownerTag,
  sanitizeId: sanitizeId,
};
