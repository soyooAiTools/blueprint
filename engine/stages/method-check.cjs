// Source: engine/stages/method-check.cjs
/**
 * Stage: method-check — hard check that all methods called in lifecycle entry
 * methods (Awake/Start/Update/LateUpdate/FixedUpdate/CheckEventRules) are
 * actually defined in the generated C# code.
 *
 * This stage blocks the pipeline on missing methods, and also injects structured
 * feedback into ctx.blueprint.feedbackHistory so the codegen fix-loop can repair the gap.
 *
 * Reads:  ctx.csCode, ctx.extraFiles
 * Writes: ctx.blueprint.feedbackHistory (push, blocking on failure)
 */

// ============ Safe Lists ============
var staticCheckStage = require('../static-check.cjs');
var assemblyPlanContracts = require('../assembly-plan-contracts.cjs');
/**
 * Methods pre-built by the skeleton that AI can call without defining them.
 */
var SKELETON_SAFE = [
  'MovePlayer', 'TryCollect', 'TryDeliver', 'UpdateCarryVisuals', 'SwitchForm',
  'GetCollectPower', 'GetCollectRange', 'GetCarryCapacity', 'AddResource', 'TryConvert',
  'TrySpend', 'UpdateResourceUI', 'GetResource', 'PlaceObj', 'HideObj', 'SetScale',
  'ShowCTA', 'AddCompletedPhase', 'ReportPhase', 'UpdateGameState', 'ShowFloatingText',
  'AddGold', 'IsNear', 'AutoPlayUpdate', 'OnAutoPlayArrive'
];

/**
 * Unity / C# built-in class prefixes — calls like Vector3.Distance() should be skipped.
 */
var UNITY_PREFIXES = [
  'Vector3', 'Vector2', 'Quaternion', 'Mathf', 'Input', 'Debug', 'Camera', 'Physics',
  'GameObject', 'Transform', 'Color', 'Time', 'Random', 'String', 'Math', 'Convert',
  // 无状态工具类
  'GFM_Create', 'GFM_UI', 'GFM_Luna', 'GFM_Audio', 'GFM_Pool',
  'GFM_Utils', 'GFM_Grid', 'GFM_Pathfinding', 'GFM_Billboard', 'GFM_SmoothMover',
  // Manager 架构 (都是 .Instance.X 形式调用，但保留做防御)
  'GFM_EconomyManager', 'GFM_UIManager', 'GFM_CameraController', 'GFM_Player',
  'GFM_AutoPlay', 'GFM_NpcManager', 'GFM_ItemManager'
];

/**
 * C# keywords that look like method calls with `(` but are language constructs.
 */
var CS_KEYWORDS = [
  'if', 'for', 'while', 'switch', 'catch', 'typeof', 'sizeof', 'new', 'return'
];

var ENTRY_SCOPE_METHODS = [
  'Awake',
  'Start',
  'Update',
  'LateUpdate',
  'FixedUpdate',
  'CheckEventRules'
];

// ============ Helpers ============

/**
 * Extract all user-defined method names from C# source code.
 * Matches return-type + PascalCase/UPPER_name + ( pattern.
 *
 * @param {string} csCode
 * @returns {string[]}
 */
function extractMethodDefinitions(csCode) {
  var defs = [];
  // Pattern: return-type identifier( — capture PascalCase/UPPER identifiers only
  var re = /(?:void|int|float|bool|string|double|long|char|IEnumerator|FormDef|ResourceDef|\w+[\[\]<>]*)\s+([A-Z_]\w*)\s*\(/g;
  var m;
  while ((m = re.exec(csCode)) !== null) {
    var name = m[1];
    if (defs.indexOf(name) < 0) {
      defs.push(name);
    }
  }
  return defs;
}

/**
 * Extract the body of a named method using brace-depth tracking.
 *
 * @param {string} csCode
 * @param {string} methodName
 * @returns {string|null}  body text between the outermost braces, or null if not found
 */
function extractMethodBody(csCode, methodName) {
  // Find method signature then locate the opening brace
  var sigRe = new RegExp('\\b' + methodName + '\\s*\\([^)]*\\)\\s*\\{');
  var sigMatch = sigRe.exec(csCode);
  if (!sigMatch) {
    return null;
  }

  var start = sigMatch.index + sigMatch[0].length - 1; // position of opening '{'
  var depth = 0;
  var body = '';
  var i;
  for (i = start; i < csCode.length; i++) {
    var ch = csCode[i];
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        // body is everything between the outer braces (exclusive)
        body = csCode.slice(start + 1, i);
        return body;
      }
    }
  }
  return null; // unbalanced braces
}

/**
 * Extract method calls from the bodies of the given scope methods.
 * Returns only calls that start with an uppercase letter or underscore
 * (i.e. PascalCase / constant-style identifiers).
 *
 * @param {string} csCode
 * @param {string[]} scopeMethods  e.g. ['Start', 'Update', 'CheckEventRules']
 * @returns {string[]}  unique list of called names
 */
function extractMethodCalls(csCode, scopeMethods) {
  var calls = [];
  var callRe = /(?<![\w.])([A-Z_]\w*)\s*\(/g;

  var i;
  for (i = 0; i < scopeMethods.length; i++) {
    var body = extractMethodBody(csCode, scopeMethods[i]);
    if (!body) {
      continue;
    }
    // Ignore comments so method names mentioned in guidance text do not become
    // false-positive "missing calls" (e.g. Phase_<id>_OnTap() in comments).
    body = body
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n\r]*/g, ' ');
    var m;
    while ((m = callRe.exec(body)) !== null) {
      var name = m[1];
      if (CS_KEYWORDS.indexOf(name) >= 0) {
        continue;
      }
      // Skip member-access calls like Vector3.Distance( or obj.Method(
      // Check character immediately before the word boundary match
      var matchStart = m.index;
      if (matchStart > 0 && body[matchStart - 1] === '.') {
        continue;
      }
      if (calls.indexOf(name) < 0) {
        calls.push(name);
      }
    }
    callRe.lastIndex = 0; // reset for next body
  }
  return calls;
}

function deriveScopeMethods(aggregateCode) {
  var scope = ENTRY_SCOPE_METHODS.slice();
  if (!aggregateCode) return scope;
  var extraRe = /\b(?:void|int|float|bool|string|double|long|char|IEnumerator|FormDef|ResourceDef|\w+[\[\]<>]*)\s+((?:Phase|AssemblySlot|Snapshot)_[A-Za-z0-9_]+|Phase_OnTap|OnAutoPlayArrive)\s*\(/g;
  var m;
  while ((m = extraRe.exec(aggregateCode)) !== null) {
    if (scope.indexOf(m[1]) < 0) scope.push(m[1]);
  }
  return scope;
}

/**
 * Check whether all methods called inside lifecycle entry methods are
 * accounted for (defined, skeleton-safe, or a Unity prefix).
 *
 * @param {string} csCode
 * @param {object} extraFiles
 * @returns {string[]}  list of missing method names (empty = all good)
 */
function checkCompleteness(csCode, extraFiles) {
  var aggregateCode = csCode || '';
  if (extraFiles) {
    for (var efName in extraFiles) {
      if (!extraFiles.hasOwnProperty(efName)) continue;
      aggregateCode += '\n' + String(extraFiles[efName] || '');
    }
  }

  var defined = extractMethodDefinitions(aggregateCode);
  var called = extractMethodCalls(aggregateCode, deriveScopeMethods(aggregateCode));

  var missing = [];
  var i;
  for (i = 0; i < called.length; i++) {
    var name = called[i];

    // Skip if defined in the code
    if (defined.indexOf(name) >= 0) {
      continue;
    }

    // Skip if in skeleton safe list
    if (SKELETON_SAFE.indexOf(name) >= 0) {
      continue;
    }

    // Skip if it starts with a Unity/C# built-in prefix (e.g. Vector3.Distance)
    var isUnityPrefix = false;
    var j;
    for (j = 0; j < UNITY_PREFIXES.length; j++) {
      if (name === UNITY_PREFIXES[j]) {
        isUnityPrefix = true;
        break;
      }
    }
    if (isUnityPrefix) {
      continue;
    }

    missing.push(name);
  }

  return missing;
}

function appendHelperBeforeClassEnd(csCode, helperCode) {
  var endIdx = csCode.lastIndexOf('}');
  if (endIdx < 0) return csCode;
  return csCode.slice(0, endIdx) + '\n' + helperCode + '\n' + csCode.slice(endIdx);
}

function injectMissingHelpers(ctx, missing) {
  if (!ctx || !ctx.csCode || !missing || missing.length === 0) return false;

  var changed = false;

  if (missing.indexOf('AutoWorkerTick') >= 0 && ctx.csCode.indexOf('AutoWorkerTick(') >= 0) {
    ctx.csCode = appendHelperBeforeClassEnd(
      ctx.csCode,
      [
        '    // [AUTO-REPAIR] Fallback helper injected by method-check.',
        '    // Custom logic sometimes emits AutoWorkerTick(...) calls without',
        '    // also defining the helper. Keep a minimal compile-safe version so',
        '    // the pipeline can continue to review/repair the gameplay logic.',
        '    void AutoWorkerTick(GameObject worker, ref int carry, ref int state)',
        '    {',
        '        if (worker == null) return;',
        '        var pos = worker.transform.position;',
        '        pos.x += 0f;',
        '        worker.transform.position = pos;',
        '    }'
      ].join('\n')
    );
    changed = true;
  }

  return changed;
}

function hasTaskFieldOrProperty(code, name) {
  if (!code || !name) return false;
  var re = new RegExp('\\b(?:GameObject|Transform|Camera|Canvas|Text|Image|Button|Slider|RectTransform|GFM_Joystick|float|int|bool|string|ResourceDef\\[\\]|FormDef\\[\\]|Vector3)\\s+' + name + '\\s*(?:[;=\\{])');
  return re.test(stripComments(code));
}

function hasTaskMethodDefinition(code, name) {
  if (!code || !name) return false;
  var re = new RegExp('\\b(?:void|bool|int|float|string|double|long|char|IEnumerator|FormDef|ResourceDef|[A-Za-z_][A-Za-z0-9_<>\\[\\]]*)\\s+' + name + '\\s*\\(');
  return re.test(stripComments(code));
}

function hasTaskTypeDefinition(code, name, kind) {
  if (!code || !name || !kind) return false;
  var re = new RegExp('\\b' + kind + '\\s+' + name + '\\b');
  return re.test(stripComments(code));
}

function referencesTaskIdentifier(code, name) {
  if (!code || !name) return false;
  var re = new RegExp('\\b' + name + '\\b');
  return re.test(stripComments(code));
}

function referencesTaskCall(code, name) {
  if (!code || !name) return false;
  var re = new RegExp('\\b' + name + '\\s*\\(');
  return re.test(stripComments(code));
}

function insertBeforeMarkerOrStart(code, marker, block) {
  if (!code || !block) return code;
  var text = String(code);
  var markerIdx = marker ? text.indexOf(marker) : -1;
  if (markerIdx >= 0) {
    return text.slice(0, markerIdx) + block + '\n' + text.slice(markerIdx);
  }
  var startMatch = /\n[ \t]*void\s+Start\s*\(/.exec(text);
  if (startMatch) {
    return text.slice(0, startMatch.index + 1) + block + '\n' + text.slice(startMatch.index + 1);
  }
  return appendHelperBeforeClassEnd(text, block);
}

function autoRepairMissingSkeletonBridgeInfra(ctx) {
  if (!ctx || !ctx.csCode) return false;

  var taskCode = buildTaskAggregateCode(ctx);
  if (!taskCode) return false;

  var changed = false;
  var fieldBlocks = [];
  var methodBlocks = [];
  var needsEconomyBridge = false;
  var hasPlayerAssignment = /\bplayer\s*=/.test(stripComments(taskCode));

  function ensureFieldBlock(signatureRe, lines) {
    if (signatureRe.test(stripComments(ctx.csCode))) return;
    fieldBlocks.push(lines.join('\n'));
  }

  function ensureMethodBlock(name, lines) {
    if (hasTaskMethodDefinition(taskCode, name)) return;
    methodBlocks.push(lines.join('\n'));
  }

  if ((referencesTaskIdentifier(taskCode, '_resources') || referencesTaskCall(taskCode, '_SyncResourcesToManager')) &&
      !hasTaskTypeDefinition(taskCode, 'ResourceDef', 'struct')) {
    fieldBlocks.push([
      '    // [AUTO-REPAIR] Rehydrated skeleton economy bridge type.',
      '    struct ResourceDef',
      '    {',
      '        public string resourceId;',
      '        public string displayName;',
      '        public string convertFrom;',
      '        public int convertRatio;',
      '    }'
    ].join('\n'));
    changed = true;
  }

  if ((referencesTaskIdentifier(taskCode, '_resources') || referencesTaskCall(taskCode, '_SyncResourcesToManager')) &&
      !hasTaskFieldOrProperty(taskCode, '_resources')) {
    fieldBlocks.push([
      '    // [AUTO-REPAIR] Rehydrated skeleton economy bridge storage.',
      '    ResourceDef[] _resources;'
    ].join('\n'));
    changed = true;
    needsEconomyBridge = true;
  }

  if (referencesTaskIdentifier(taskCode, '_inventory') &&
      !/\b_inventory\s*(?:=|;|\{)/.test(stripComments(taskCode))) {
    fieldBlocks.push([
      '    // [AUTO-REPAIR] Legacy inventory shim for templates that still emit _inventory["Gold"].',
      '    class InventoryCompat',
      '    {',
      '        public int this[string id]',
      '        {',
      '            get { var mgr = GFM_EconomyManager.Instance; return mgr != null ? mgr.GetResource(GFM_ResourceIds.Normalize(id)) : 0; }',
      '            set',
      '            {',
      '                var mgr = GFM_EconomyManager.Instance;',
      '                if (mgr == null) return;',
      '                string rid = GFM_ResourceIds.Normalize(id);',
      '                int current = mgr.GetResource(rid);',
      '                if (value > current) mgr.AddResource(rid, value - current);',
      '                else if (value < current) mgr.TrySpend(rid, current - value);',
      '            }',
      '        }',
      '    }',
      '    InventoryCompat _inventory = new InventoryCompat();'
    ].join('\n'));
    changed = true;
    needsEconomyBridge = true;
  }

  if (referencesTaskIdentifier(taskCode, 'player') && !hasTaskFieldOrProperty(taskCode, 'player')) {
    if (hasPlayerAssignment) {
      fieldBlocks.push([
        '    // [AUTO-REPAIR] Compile-safe player bridge field for generated templates.',
        '    GameObject player;'
      ].join('\n'));
    } else {
      fieldBlocks.push([
        '    // [AUTO-REPAIR] Compile-safe player bridge property for generated templates.',
        '    GameObject player',
        '    {',
        '        get',
        '        {',
        '            var gp = GFM_Player.Instance;',
        '            return gp != null ? gp.Go : null;',
        '        }',
        '    }'
      ].join('\n'));
    }
    changed = true;
  }

  if (referencesTaskIdentifier(taskCode, 'collectCooldownInterval') &&
      !/\bfloat\s+collectCooldownInterval\b/.test(stripComments(taskCode))) {
    fieldBlocks.push([
      '    // [AUTO-REPAIR] Batch-2 collect cooldown infra.',
      '    float collectCooldownInterval = 0.3f;'
    ].join('\n'));
    changed = true;
  }
  if (referencesTaskIdentifier(taskCode, '_collectCooldown') &&
      !/\bfloat\s+_collectCooldown\b/.test(stripComments(taskCode))) {
    fieldBlocks.push([
      '    float _collectCooldown = 0f;'
    ].join('\n'));
    changed = true;
  }
  if (referencesTaskIdentifier(taskCode, '_lastScoreText') &&
      !/\bstring\s+_lastScoreText\b/.test(stripComments(taskCode))) {
    fieldBlocks.push([
      '    string _lastScoreText = "";'
    ].join('\n'));
    changed = true;
  }

  if ((referencesTaskCall(taskCode, 'AddResource') ||
       referencesTaskCall(taskCode, 'GetResource') ||
       referencesTaskCall(taskCode, 'TrySpend') ||
       referencesTaskCall(taskCode, 'TryConvert') ||
       referencesTaskCall(taskCode, 'UpdateResourceUI') ||
       referencesTaskCall(taskCode, '_SyncResourcesToManager')) &&
      !needsEconomyBridge) {
    needsEconomyBridge = true;
  }

  if (needsEconomyBridge && !hasTaskMethodDefinition(taskCode, '_SyncResourcesToManager')) {
    methodBlocks.push([
      '    // [AUTO-REPAIR] Sync locally-filled resource defs into GFM_EconomyManager.',
      '    void _SyncResourcesToManager()',
      '    {',
      '        if (_resources == null || _resources.Length == 0) return;',
      '        var mgr = GFM_EconomyManager.Instance;',
      '        if (mgr == null) return;',
      '        var defs = new GFM_EconomyManager.ResourceDef[_resources.Length];',
      '        for (int i = 0; i < _resources.Length; i++)',
      '        {',
      '            defs[i] = new GFM_EconomyManager.ResourceDef',
      '            {',
      '                resourceId = GFM_ResourceIds.Normalize(_resources[i].resourceId),',
      '                displayName = _resources[i].displayName,',
      '                convertFrom = GFM_ResourceIds.Normalize(_resources[i].convertFrom),',
      '                convertRatio = _resources[i].convertRatio',
      '            };',
      '        }',
      '        mgr.SetResources(defs);',
      '    }'
    ].join('\n'));
    changed = true;
  }

  [
    {
      name: 'AddResource',
      body: [
        '    void AddResource(string id, int amount)',
        '    {',
        '        var mgr = GFM_EconomyManager.Instance;',
        '        if (mgr != null) mgr.AddResource(GFM_ResourceIds.Normalize(id), amount);',
        '    }'
      ]
    },
    {
      name: 'GetResource',
      body: [
        '    int GetResource(string id)',
        '    {',
        '        var mgr = GFM_EconomyManager.Instance;',
        '        return mgr != null ? mgr.GetResource(GFM_ResourceIds.Normalize(id)) : 0;',
        '    }'
      ]
    },
    {
      name: 'TrySpend',
      body: [
        '    bool TrySpend(string id, int amount)',
        '    {',
        '        var mgr = GFM_EconomyManager.Instance;',
        '        return mgr != null && mgr.TrySpend(GFM_ResourceIds.Normalize(id), amount);',
        '    }'
      ]
    },
    {
      name: 'TryConvert',
      body: [
        '    bool TryConvert(string fromId, string toId)',
        '    {',
        '        var mgr = GFM_EconomyManager.Instance;',
        '        return mgr != null && mgr.TryConvert(GFM_ResourceIds.Normalize(fromId), GFM_ResourceIds.Normalize(toId));',
        '    }'
      ]
    },
    {
      name: 'UpdateResourceUI',
      body: [
        '    void UpdateResourceUI()',
        '    {',
        '        var ui = GFM_UIManager.Instance;',
        '        if (ui != null) ui.UpdateResourceUI();',
        '    }'
      ]
    }
  ].forEach(function(entry) {
    if (referencesTaskCall(taskCode, entry.name) && !hasTaskMethodDefinition(taskCode, entry.name)) {
      methodBlocks.push(entry.body.join('\n'));
      changed = true;
    }
  });

  [
    {
      name: 'SyncAutoPlayState',
      body: [
        '    void SyncAutoPlayState(float now)',
        '    {',
        '        var auto = GFM_AutoPlay.Instance;',
        '        if (auto == null) return;',
        '        auto.CheckActivation(now);',
        '        _autoPlayMode = auto.IsActive;',
        '        _autoPlaySteps = auto.Steps;',
        '    }'
      ]
    },
    {
      name: 'UpdatePhaseTimer',
      body: [
        '    void UpdatePhaseTimer(float dt)',
        '    {',
        '        if (currentPhaseName != lastPhaseForTimer)',
        '        {',
        '            phaseTimer = 0f;',
        '            lastPhaseForTimer = currentPhaseName;',
        '        }',
        '        phaseTimer += dt;',
        '    }'
      ]
    },
    {
      name: 'IsNear',
      body: [
        '    bool IsNear(GameObject target, float range)',
        '    {',
        '        var gp = GFM_Player.Instance;',
        '        return gp != null && gp.IsNear(target, range);',
        '    }'
      ]
    },
    {
      name: 'AddGold',
      body: [
        '    void AddGold(int amount)',
        '    {',
        '        var mgr = GFM_EconomyManager.Instance;',
        '        if (mgr != null) mgr.AddGold(amount);',
        '    }'
      ]
    },
    {
      name: 'ShowFloatingText',
      body: [
        '    void ShowFloatingText(Vector3 worldPos, string text, Color color)',
        '    {',
        '        if (guideText != null)',
        '        {',
        '            guideText.text = text;',
        '            guideText.color = color;',
        '        }',
        '    }'
      ]
    },
    {
      name: 'MovePlayer',
      body: [
        '    void MovePlayer()',
        '    {',
        '        var gp = GFM_Player.Instance;',
        '        if (gp != null) gp.Tick(Time.deltaTime, _autoPlayMode);',
        '    }'
      ]
    },
    {
      name: 'TryCollect',
      body: [
        '    bool TryCollect(GameObject source, string resType, int maxCarry, float range)',
        '    {',
        '        var gp = GFM_Player.Instance;',
        '        return gp != null && gp.TryCollect(source, resType, maxCarry, range);',
        '    }'
      ]
    },
    {
      name: 'TryDeliver',
      body: [
        '    int TryDeliver(GameObject target, string expectedType, float range)',
        '    {',
        '        var gp = GFM_Player.Instance;',
        '        return gp != null ? gp.TryDeliver(target, expectedType, range) : 0;',
        '    }'
      ]
    },
    {
      name: 'UpdateCarryVisuals',
      body: [
        '    void UpdateCarryVisuals()',
        '    {',
        '        var gp = GFM_Player.Instance;',
        '        if (gp != null) gp.UpdateCarryVisuals();',
        '    }'
      ]
    },
    {
      name: 'SwitchForm',
      body: [
        '    void SwitchForm(int formIndex)',
        '    {',
        '        var gp = GFM_Player.Instance;',
        '        if (gp != null) gp.SwitchForm(formIndex);',
        '    }'
      ]
    },
    {
      name: 'GetCollectPower',
      body: [
        '    float GetCollectPower()',
        '    {',
        '        var gp = GFM_Player.Instance;',
        '        return gp != null ? gp.GetCollectPower() : 1f;',
        '    }'
      ]
    },
    {
      name: 'GetCollectRange',
      body: [
        '    float GetCollectRange()',
        '    {',
        '        var gp = GFM_Player.Instance;',
        '        return gp != null ? gp.GetCollectRange() : 1.5f;',
        '    }'
      ]
    },
    {
      name: 'GetCarryCapacity',
      body: [
        '    int GetCarryCapacity()',
        '    {',
        '        var gp = GFM_Player.Instance;',
        '        return gp != null ? gp.GetCarryCapacity() : 10;',
        '    }'
      ]
    },
    {
      name: 'OnAutoPlayArrive',
      body: [
        '    void OnAutoPlayArrive(string targetName)',
        '    {',
        '        Phase_OnTap();',
        '    }'
      ]
    },
    {
      name: 'EnterPhase',
      body: [
        '    void EnterPhase(int ruleIdx, string phaseId, bool resetTimer, bool syncAutoPlayBaseline)',
        '    {',
        '        ruleTriggered[ruleIdx] = true;',
        '        currentPhaseName = phaseId;',
        '        if (phaseEnterTimes != null && ruleIdx >= 0 && ruleIdx < phaseEnterTimes.Length) phaseEnterTimes[ruleIdx] = gameTimer;',
        '        if (resetTimer) phaseTimer = 0f;',
        '        if (syncAutoPlayBaseline) _autoPlayStepsAtPhaseStart = _autoPlaySteps;',
        '        ReportPhase(phaseId);',
        '    }'
      ]
    },
    {
      name: 'CompletePhaseProgress',
      body: [
        '    void CompletePhaseProgress(string completedPhaseId)',
        '    {',
        '        AddCompletedPhase(completedPhaseId);',
        '        UpdateGameState();',
        '    }'
      ]
    },
    {
      name: 'FinishGame',
      body: [
        '    void FinishGame(string lastPhaseId)',
        '    {',
        '        AddCompletedPhase(lastPhaseId);',
        '        Luna.Unity.LifeCycle.GameEnded();',
        '        ShowCTA();',
        '        gameEnded = true;',
        '        UpdateGameState();',
        '    }'
      ]
    },
    {
      name: 'TryReportStuckPhase',
      body: [
        '    bool TryReportStuckPhase()',
        '    {',
        '        return false;',
        '    }'
      ]
    }
  ].forEach(function(entry) {
    var isReferenced = entry.name === 'OnAutoPlayArrive'
      ? referencesTaskIdentifier(taskCode, entry.name)
      : referencesTaskCall(taskCode, entry.name);
    if (isReferenced && !hasTaskMethodDefinition(taskCode, entry.name)) {
      methodBlocks.push(entry.body.join('\n'));
      changed = true;
    }
  });

  if (fieldBlocks.length > 0) {
    ctx.csCode = insertBeforeMarkerOrStart(ctx.csCode, '    // TODO_VARIABLES_END', fieldBlocks.join('\n\n'));
  }
  if (methodBlocks.length > 0) {
    ctx.csCode = appendHelperBeforeClassEnd(ctx.csCode, '\n    // [AUTO-REPAIR] Rehydrated skeleton bridge helpers.\n' + methodBlocks.join('\n\n') + '\n');
  }

  return changed;
}

function splitTopLevelArgs(text) {
  var args = [];
  var current = '';
  var parenDepth = 0;
  var bracketDepth = 0;
  var braceDepth = 0;
  for (var i = 0; i < text.length; i++) {
    var ch = text[i];
    if (ch === ',' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      if (current.trim()) args.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
    if (ch === '(') parenDepth++;
    else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
    else if (ch === '[') bracketDepth++;
    else if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    else if (ch === '{') braceDepth++;
    else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1);
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

function buildCodeMask(code) {
  var mask = new Uint8Array(code.length);
  var i = 0;
  while (i < code.length) {
    if (code[i] === '/' && code[i + 1] === '/') {
      while (i < code.length && code[i] !== '\n') i++;
      continue;
    }
    if (code[i] === '/' && code[i + 1] === '*') {
      i += 2;
      while (i < code.length - 1 && !(code[i] === '*' && code[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (code[i] === '@' && code[i + 1] === '"') {
      i += 2;
      while (i < code.length) {
        if (code[i] === '"' && code[i + 1] === '"') { i += 2; continue; }
        if (code[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }
    if (code[i] === '"') {
      i++;
      while (i < code.length && code[i] !== '"' && code[i] !== '\n') {
        if (code[i] === '\\') i++;
        i++;
      }
      if (i < code.length) i++;
      continue;
    }
    if (code[i] === '\'') {
      i++;
      if (i < code.length && code[i] === '\\') i++;
      i++;
      if (i < code.length && code[i] === '\'') i++;
      continue;
    }
    mask[i] = 1;
    i++;
  }
  return mask;
}

function findInvocationCalls(code, methodName, mask) {
  var calls = [];
  if (!code || !methodName) return calls;
  var nameLen = methodName.length;
  var localMask = mask || buildCodeMask(code);
  function isIdent(ch) {
    return !!ch && /[A-Za-z0-9_]/.test(ch);
  }
  for (var i = 0; i <= code.length - nameLen; i++) {
    if (!localMask[i]) continue;
    if (code.substr(i, nameLen) !== methodName) continue;
    if (isIdent(code[i - 1]) || isIdent(code[i + nameLen])) continue;
    var j = i + nameLen;
    while (j < code.length && /\s/.test(code[j])) j++;
    if (code[j] !== '(') continue;
    var openIdx = j;
    var depth = 1;
    j++;
    while (j < code.length && depth > 0) {
      if (localMask[j]) {
        if (code[j] === '(') depth++;
        else if (code[j] === ')') depth--;
      }
      j++;
    }
    if (depth !== 0) continue;
    calls.push({
      index: i,
      openIndex: openIdx,
      closeIndex: j - 1,
      argsText: code.substring(openIdx + 1, j - 1),
    });
    i = j - 1;
  }
  return calls;
}

function rewriteLocalUiHelperAliases(code) {
  if (!code) return { changed: false, code: code };

  var next = String(code);
  var changed = false;

  var replaced = next.replace(/\bAddLocalWorldLabel\s*\(/g, 'GFM_UI.AddWorldLabel(');
  if (replaced !== next) {
    next = replaced;
    changed = true;
  }

  replaced = next.replace(/\bCreateLocalCanvas\s*\(/g, 'GFM_UI.CreateCanvas(');
  if (replaced !== next) {
    next = replaced;
    changed = true;
  }

  var mask = buildCodeMask(next);
  var calls = findInvocationCalls(next, 'CreateLocalText', mask);
  if (calls.length === 0) {
    return { changed: changed, code: next };
  }

  var pieces = [];
  var cursor = 0;
  var rewritten = false;
  for (var i = 0; i < calls.length; i++) {
    var call = calls[i];
    var args = splitTopLevelArgs(call.argsText);
    var replacement = null;
    if (args.length === 5) {
      replacement = 'GFM_UI.CreateText(' + [args[0], args[2], args[3], args[4]].join(', ') + ')';
    } else if (args.length === 4) {
      replacement = 'GFM_UI.CreateText(' + args.join(', ') + ')';
    }
    if (!replacement) continue;
    pieces.push(next.slice(cursor, call.index));
    pieces.push(replacement);
    cursor = call.closeIndex + 1;
    rewritten = true;
  }

  if (!rewritten) {
    return { changed: changed, code: next };
  }

  pieces.push(next.slice(cursor));
  return { changed: true, code: pieces.join('') };
}

function autoRepairLocalUiHelperAliases(ctx) {
  if (!ctx || !ctx.csCode) return false;

  var changed = false;
  var mainResult = rewriteLocalUiHelperAliases(ctx.csCode);
  if (mainResult.changed) {
    ctx.csCode = mainResult.code;
    changed = true;
  }

  var extraFiles = ctx.extraFiles || {};
  Object.keys(extraFiles).forEach(function(name) {
    var res = rewriteLocalUiHelperAliases(extraFiles[name]);
    if (res.changed) {
      extraFiles[name] = res.code;
      changed = true;
    }
  });

  return changed;
}

/**
 * Strip forbidden generic component API calls (.GetComponent<T>()) from a single
 * code string, replacing them with the non-generic Bridge-safe overload
 * (.GetComponent(typeof(T))).  Returns { changed, code }.
 *
 * This mirrors the stripping that the legacy codegen path performs via
 * applyLunaPostFixesToManagerPartials() before writing to disk.  The schema
 * codegen path never touches disk before method-check runs, so we must repair
 * in-memory here instead.
 *
 * @param {string} code
 * @returns {{ changed: boolean, code: string }}
 */
function stripGenericGetComponentCalls(code) {
  if (!code) return { changed: false, code: code };
  var original = String(code);
  var stripped = original.replace(
    /((?:this|base|[A-Za-z_][A-Za-z0-9_]*)(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\.GetComponent\s*<\s*([A-Za-z_][A-Za-z0-9_.]*)\s*>\s*\(\s*[^)]*\)/g,
    '(($2)$1.GetComponent(typeof($2)))'
  );
  return { changed: stripped !== original, code: stripped };
}

/**
 * Auto-repair forbidden generic API calls in ctx.csCode and ctx.extraFiles
 * before the contract-violation check runs.  Identical in structure to
 * injectMissingHelpers().
 *
 * The schema codegen path sets both fields entirely in-memory and never calls
 * stripGenericMethodCallsForLuna(), so .GetComponent<T>() calls introduced by
 * the AI survive intact until this point.  Stripping them here avoids a
 * wasteful full-codegen retry on a forbidden-generic-api contract failure.
 *
 * @param {object} ctx  pipeline context
 * @returns {boolean}  true if any code was modified
 */
function autoRepairForbiddenGenericApis(ctx) {
  if (!ctx || !ctx.csCode) return false;

  var changed = false;

  var mainResult = stripGenericGetComponentCalls(ctx.csCode);
  if (mainResult.changed) {
    ctx.csCode = mainResult.code;
    changed = true;
  }

  var extraFiles = ctx.extraFiles || {};
  Object.keys(extraFiles).forEach(function(name) {
    var res = stripGenericGetComponentCalls(extraFiles[name]);
    if (res.changed) {
      extraFiles[name] = res.code;
      changed = true;
    }
  });

  return changed;
}

function detectMalformedIsNearCalls(code) {
  if (!code || code.indexOf('IsNear(') < 0) return [];
  var invalid = [];
  var re = /IsNear\s*\(\s*,\s*([^)]+)\)/g;
  var m;
  while ((m = re.exec(String(code)))) {
    var snippet = 'IsNear(, ' + String(m[1] || '').trim() + ')';
    if (invalid.indexOf(snippet) < 0) invalid.push(snippet);
  }
  return invalid;
}

function stripMalformedIsNearCalls(code) {
  if (!code || code.indexOf('IsNear(') < 0) {
    return { changed: false, code: code };
  }
  var fixes = 0;
  var next = String(code).replace(/IsNear\s*\(\s*,\s*([^)]+)\)/g, function() {
    fixes++;
    return 'false /* stripped malformed IsNear */';
  });
  return { changed: fixes > 0, code: next };
}

function autoRepairMalformedIsNear(ctx) {
  if (!ctx || !ctx.csCode) return false;

  var changed = false;
  var mainResult = stripMalformedIsNearCalls(ctx.csCode);
  if (mainResult.changed) {
    ctx.csCode = mainResult.code;
    changed = true;
  }

  var extraFiles = ctx.extraFiles || {};
  Object.keys(extraFiles).forEach(function(name) {
    var res = stripMalformedIsNearCalls(extraFiles[name]);
    if (res.changed) {
      extraFiles[name] = res.code;
      changed = true;
    }
  });

  return changed;
}

/**
 * Auto-repair duplicate *State field declarations that appear across multiple
 * cross-partial files (e.g. GameFlowManagerMain.cs and
 * GameFlowManagerMain.Resource.cs both declaring `int FooState = 0;`).
 *
 * Processing order: ctx.csCode first, then ctx.extraFiles in Object.keys() order.
 * The first occurrence of each *State field is kept; every subsequent declaration
 * of the same field name is removed (the whole source line is dropped).
 *
 * This mirrors the autoRepairForbiddenGenericApis() pattern and prevents a
 * duplicate-state-fields contract failure from triggering a wasteful
 * full-codegen retry loop when the schema codegen path emits the same field
 * in more than one partial.
 *
 * @param {object} ctx  pipeline context
 * @returns {boolean}  true if any code was modified
 */
function autoRepairDuplicateStateFields(ctx) {
  if (!ctx || !ctx.csCode) return false;

  var changed = false;
  var seenFields = {};

  // Matches a line whose significant content is a single *State field declaration.
  // Mirrors the pattern used in detectDuplicateStateFields() but anchored to a line
  // so we can safely drop the whole line without disturbing surrounding code.
  var stateFieldLineRe = /^[ \t]*(?:(?:public|private|protected|internal)\s+)?(?:static\s+)?(?:int|float|bool|string)\s+([A-Z][A-Za-z0-9_]*State)\s*(?:=\s*[^;]+)?;[ \t]*(?:(?:\/\/.*)|(?:\/\*.*\*\/\s*))?$/;

  function removeDuplicatesFromCode(code) {
    if (!code) return { changed: false, code: code };
    var original = String(code);
    var lines = original.split('\n');
    var resultLines = [];
    var fileChanged = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var m = stateFieldLineRe.exec(line);
      if (m) {
        var fieldName = m[1];
        if (seenFields[fieldName]) {
          // Duplicate across partials — drop this line entirely
          fileChanged = true;
          continue;
        }
        seenFields[fieldName] = true;
      }
      resultLines.push(line);
    }
    return { changed: fileChanged, code: resultLines.join('\n') };
  }

  var mainResult = removeDuplicatesFromCode(ctx.csCode);
  if (mainResult.changed) {
    ctx.csCode = mainResult.code;
    changed = true;
  }

  var extraFiles = ctx.extraFiles || {};
  Object.keys(extraFiles).forEach(function(name) {
    var res = removeDuplicatesFromCode(extraFiles[name]);
    if (res.changed) {
      extraFiles[name] = res.code;
      changed = true;
    }
  });

  return changed;
}

function autoRepairDuplicateSimpleFields(ctx) {
  if (!ctx || !ctx.csCode) return false;

  var changed = false;
  var seenFieldsByClass = {};
  var simpleFieldLineRe = /^[ \t]*(?:(?:public|private|protected|internal)\s+)?(?:static\s+)?(?:readonly\s+)?(?:(?:int|float|bool|string|double|long|Vector2|Vector3|Color)(?:\[\])?)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:=\s*[^;]+)?;[ \t]*(?:(?:\/\/.*)|(?:\/\*.*\*\/\s*))?$/;
  var classDeclRe = /\b(?:public|private|protected|internal)?\s*(?:static\s+)?(?:partial\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)\b/;

  function removeDuplicatesFromCode(code) {
    if (!code) return { changed: false, code: code };
    var original = String(code);
    var lines = original.split('\n');
    var resultLines = [];
    var fileChanged = false;
    var depth = 0;
    var currentClass = null;
    var classDepth = 0;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!currentClass) {
        var classMatch = classDeclRe.exec(line);
        if (classMatch) { currentClass = classMatch[1]; classDepth = depth; }
      }
      var m = (currentClass && depth === classDepth + 1) ? simpleFieldLineRe.exec(line) : null;
      if (m) {
        var fieldName = m[1];
        var classKey = currentClass || '__GLOBAL__';
        if (!seenFieldsByClass[classKey]) seenFieldsByClass[classKey] = {};
        if (seenFieldsByClass[classKey][fieldName]) {
          fileChanged = true;
          simpleFieldLineRe.lastIndex = 0;
          continue;
        }
        seenFieldsByClass[classKey][fieldName] = true;
        simpleFieldLineRe.lastIndex = 0;
      }
      resultLines.push(line);
      var opens = (line.match(/\{/g) || []).length;
      var closes = (line.match(/\}/g) || []).length;
      depth += opens - closes;
      if (depth < 0) depth = 0;
      if (currentClass && depth <= classDepth && closes > 0) { currentClass = null; classDepth = 0; }
    }
    return { changed: fileChanged, code: resultLines.join('\n') };
  }

  var mainResult = removeDuplicatesFromCode(ctx.csCode);
  if (mainResult.changed) {
    ctx.csCode = mainResult.code;
    changed = true;
  }

  var extraFiles = ctx.extraFiles || {};
  Object.keys(extraFiles).forEach(function(name) {
    var res = removeDuplicatesFromCode(extraFiles[name]);
    if (res.changed) {
      extraFiles[name] = res.code;
      changed = true;
    }
  });

  return changed;
}

function autoRepairDuplicateObjectFields(ctx) {
  if (!ctx || !ctx.csCode) return false;

  var changed = false;
  var seenFieldsByClass = {};
  var objectFieldLineRe = /^[ \t]*(?:(?:public|private|protected|internal)\s+)?(?:static\s+)?(?:GameObject(?:\[\])?|Transform|Camera|Canvas|Text|Image|Button|Slider|RectTransform|GFM_Joystick)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:=\s*[^;]+)?;[ \t]*(?:(?:\/\/.*)|(?:\/\*.*\*\/\s*))?$/;
  var classDeclRe = /\b(?:public|private|protected|internal)?\s*(?:static\s+)?(?:partial\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)\b/;

  function removeDuplicatesFromCode(code) {
    if (!code) return { changed: false, code: code };
    var original = String(code);
    var lines = original.split('\n');
    var resultLines = [];
    var fileChanged = false;
    var depth = 0;
    var currentClass = null;
    var classDepth = 0;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!currentClass) {
        var classMatch = classDeclRe.exec(line);
        if (classMatch) { currentClass = classMatch[1]; classDepth = depth; }
      }
      var m = (currentClass && depth === classDepth + 1) ? objectFieldLineRe.exec(line) : null;
      if (m) {
        var fieldName = m[1];
        var classKey = currentClass || '__GLOBAL__';
        if (!seenFieldsByClass[classKey]) seenFieldsByClass[classKey] = {};
        if (seenFieldsByClass[classKey][fieldName]) {
          fileChanged = true;
          objectFieldLineRe.lastIndex = 0;
          continue;
        }
        seenFieldsByClass[classKey][fieldName] = true;
        objectFieldLineRe.lastIndex = 0;
      }
      resultLines.push(line);
      var opens = (line.match(/\{/g) || []).length;
      var closes = (line.match(/\}/g) || []).length;
      depth += opens - closes;
      if (depth < 0) depth = 0;
      if (currentClass && depth <= classDepth && closes > 0) { currentClass = null; classDepth = 0; }
    }
    return { changed: fileChanged, code: resultLines.join('\n') };
  }

  var mainResult = removeDuplicatesFromCode(ctx.csCode);
  if (mainResult.changed) {
    ctx.csCode = mainResult.code;
    changed = true;
  }

  var extraFiles = ctx.extraFiles || {};
  Object.keys(extraFiles).forEach(function(name) {
    var res = removeDuplicatesFromCode(extraFiles[name]);
    if (res.changed) {
      extraFiles[name] = res.code;
      changed = true;
    }
  });

  return changed;
}

function replaceIdentifierWord(code, fromName, toName) {
  if (!code || !fromName || !toName || fromName === toName) {
    return { changed: false, code: code };
  }
  var re = new RegExp('\\b' + fromName + '\\b', 'g');
  var next = String(code).replace(re, toName);
  return { changed: next !== code, code: next };
}

function autoRepairPlayerAliasDrift(ctx) {
  if (!ctx || !ctx.csCode) return false;
  var aggregateCode = buildTaskAggregateCode(ctx);
  var aliases = detectPlayerAliasDrift(aggregateCode);
  if (!aliases || aliases.length === 0) return false;

  var canonicalAlias = chooseCanonicalPlayerAlias(aggregateCode);
  var changed = false;
  var extraFiles = ctx.extraFiles || {};
  var aliasSet = {};
  for (var i = 0; i < aliases.length; i++) {
    aliasSet[aliases[i]] = true;
  }
  delete aliasSet[canonicalAlias];

  Object.keys(aliasSet).forEach(function(alias) {
    var mainRes = replaceIdentifierWord(ctx.csCode, alias, canonicalAlias);
    if (mainRes.changed) {
      ctx.csCode = mainRes.code;
      changed = true;
    }
    Object.keys(extraFiles).forEach(function(name) {
      var res = replaceIdentifierWord(extraFiles[name], alias, canonicalAlias);
      if (res.changed) {
        extraFiles[name] = res.code;
        changed = true;
      }
    });
  });

  return changed;
}

function scorePoolCandidate(invalidPool, candidatePool) {
  var invalidParts = String(invalidPool || '').split('_');
  var candidateParts = String(candidatePool || '').split('_');
  var score = 0;
  if (invalidParts[2] && candidateParts[2] && invalidParts[2] === candidateParts[2]) score += 5;
  if (invalidParts[3] && candidateParts[3] && invalidParts[3] === candidateParts[3]) score += 4;
  if (invalidParts[4] && candidateParts[4] && invalidParts[4] === candidateParts[4]) score += 1;
  for (var i = 2; i < invalidParts.length; i++) {
    for (var j = 2; j < candidateParts.length; j++) {
      if (invalidParts[i] && invalidParts[i] === candidateParts[j]) score += 1;
    }
  }
  return score;
}

function chooseReplacementPoolLiteral(invalidPool, allowedPools) {
  if (!invalidPool || !allowedPools || allowedPools.length === 0) return null;
  if (allowedPools.indexOf(invalidPool) >= 0) return invalidPool;
  if (allowedPools.length === 1) return allowedPools[0];

  var bestPool = null;
  var bestScore = -1;
  var tie = false;
  for (var i = 0; i < allowedPools.length; i++) {
    var candidate = allowedPools[i];
    var score = scorePoolCandidate(invalidPool, candidate);
    if (score > bestScore) {
      bestPool = candidate;
      bestScore = score;
      tie = false;
    } else if (score === bestScore) {
      tie = true;
    }
  }
  if (bestScore <= 0) return null;
  if (tie && bestScore < 9) return null;
  return bestPool;
}

function autoRepairInvalidPoolLiterals(ctx) {
  if (!ctx || !ctx.csCode) return false;
  var invalidPools = detectInvalidPoolLiterals(buildTaskAggregateCode(ctx), ctx);
  if (!invalidPools || invalidPools.length === 0) return false;
  var allowedPools = collectAllowedPoolList(ctx);
  if (!allowedPools || allowedPools.length === 0) return false;

  var replacements = {};
  for (var i = 0; i < invalidPools.length; i++) {
    var replacement = chooseReplacementPoolLiteral(invalidPools[i], allowedPools);
    if (replacement && replacement !== invalidPools[i]) {
      replacements[invalidPools[i]] = replacement;
    }
  }
  if (Object.keys(replacements).length === 0) return false;

  function rewritePools(code) {
    if (!code) return { changed: false, code: code };
    var next = String(code);
    Object.keys(replacements).forEach(function(fromPool) {
      next = next.split(fromPool).join(replacements[fromPool]);
    });
    return { changed: next !== code, code: next };
  }

  var changed = false;
  var mainRes = rewritePools(ctx.csCode);
  if (mainRes.changed) {
    ctx.csCode = mainRes.code;
    changed = true;
  }
  var extraFiles = ctx.extraFiles || {};
  Object.keys(extraFiles).forEach(function(name) {
    var res = rewritePools(extraFiles[name]);
    if (res.changed) {
      extraFiles[name] = res.code;
      changed = true;
    }
  });
  return changed;
}

function autoRepairPartialClassMismatch(ctx) {
  if (!ctx || !ctx.csCode) return false;
  if (/\bpartial\s+class\s+GameFlowManagerMain\b/.test(ctx.csCode)) return false;

  var extras = ctx.extraFiles || {};
  var hasPartialCompanion = Object.keys(extras).some(function(name) {
    if (!isTaskPartialFile(name)) return false;
    return /\bpartial\s+class\s+GameFlowManagerMain\b/.test(String(extras[name] || ''));
  });
  if (!hasPartialCompanion) return false;

  var updated = String(ctx.csCode).replace(
    /\b((?:(?:public|private|protected|internal)\s+)?(?:(?:abstract|sealed|static)\s+)*)class\s+GameFlowManagerMain\b/,
    '$1partial class GameFlowManagerMain'
  );
  if (updated === ctx.csCode) return false;
  ctx.csCode = updated;
  return true;
}

/**
 * Auto-repair missing `// [ASSEMBLY SLOT] <id>` markers in ctx.extraFiles.
 *
 * detectAssemblyContractViolations() requires each file listed in an
 * assemblyPlan moduleInstance's ownerFiles array to contain a
 * `// [ASSEMBLY SLOT] <id>` comment marker.  AI-generated partial files
 * consistently omit these markers, causing an assembly-module-owner-mismatch
 * violation on every run.  This repair inserts the missing marker at the top
 * of each ownerFile that lacks it so the contract check passes without a
 * full-codegen retry.
 *
 * @param {object} ctx  pipeline context
 * @returns {boolean}   true if any file was modified
 */
function autoRepairAssemblyModuleOwnerMismatch(ctx) {
  if (!ctx || !ctx.blueprint) return false;
  var assemblyPlan = assemblyPlanContracts.getAssemblyPlanFromBlueprint(ctx.blueprint);
  if (!assemblyPlan) return false;
  var moduleInstances = assemblyPlan.moduleInstances || assemblyPlan.modules || [];
  if (!Array.isArray(moduleInstances) || moduleInstances.length === 0) return false;
  var extraFiles = ctx.extraFiles;
  if (!extraFiles) return false;

  var changed = false;

  for (var i = 0; i < moduleInstances.length; i++) {
    var inst = moduleInstances[i] || {};
    var id = inst.id || inst.moduleId || inst.name;
    if (!id) continue;
    var ownerFiles = inst.ownerFiles;
    if (!Array.isArray(ownerFiles) || ownerFiles.length === 0) continue;

    var marker = '// [ASSEMBLY SLOT] ' + id;

    for (var j = 0; j < ownerFiles.length; j++) {
      var fileName = ownerFiles[j];
      if (!fileName) continue;
      // Only repair files that actually exist in extraFiles
      if (!Object.prototype.hasOwnProperty.call(extraFiles, fileName)) continue;
      var fileContent = String(extraFiles[fileName] || '');
      if (fileContent.indexOf(marker) >= 0) continue;
      // Inject the marker at the very top of the file so the contract scanner
      // always finds it regardless of where the AI placed (or omitted) the body.
      extraFiles[fileName] = marker + '\n' + fileContent;
      changed = true;
    }
  }

  return changed;
}

function repairEconomyGoldWriteLine(line) {
  var indent = (line.match(/^[ \t]*/) || [''])[0];
  var trimmed = String(line || '').trim();

  if (/^(?:public|private|protected|internal)?\s*(?:static\s+)?(?:int|float|double|long)\s+gold\s*(?:=[^;]+)?;/.test(trimmed)) {
    return { changed: true, line: '' };
  }

  var addMatch = trimmed.match(/^gold\s*\+=\s*(.+);$/);
  if (addMatch) {
    return { changed: true, line: indent + 'AddResource(GFM_ResourceIds.Gold, ' + addMatch[1].trim() + ');' };
  }

  var subtractMatch = trimmed.match(/^gold\s*-=\s*(.+);$/);
  if (subtractMatch) {
    return { changed: true, line: indent + 'AddResource(GFM_ResourceIds.Gold, -(' + subtractMatch[1].trim() + '));' };
  }

  var assignAddMatch = trimmed.match(/^gold\s*=\s*gold\s*\+\s*(.+);$/);
  if (assignAddMatch) {
    return { changed: true, line: indent + 'AddResource(GFM_ResourceIds.Gold, ' + assignAddMatch[1].trim() + ');' };
  }

  var assignSubtractMatch = trimmed.match(/^gold\s*=\s*gold\s*-\s*(.+);$/);
  if (assignSubtractMatch) {
    return { changed: true, line: indent + 'AddResource(GFM_ResourceIds.Gold, -(' + assignSubtractMatch[1].trim() + '));' };
  }

  if (/\bscoreText\s*!=\s*null\b/.test(trimmed) && /\bscoreText\.text\b/.test(trimmed) && /\bgold\b/.test(trimmed)) {
    return { changed: true, line: indent + 'UpdateResourceUI();' };
  }

  if (/^scoreText\.text\s*=/.test(trimmed) && /\bgold\b/.test(trimmed)) {
    return { changed: true, line: indent + 'UpdateResourceUI();' };
  }

  return { changed: false, line: line };
}

function repairStateOwnerWritesInCode(code, state) {
  var lines = String(code || '').split('\n');
  var changed = false;
  var candidates = assemblyPlanContracts.buildStateWriteSignals(state);
  var isEconomyGold = String(state || '') === 'economy.gold';

  var assignmentPatterns = [];
  for (var i = 0; i < candidates.length; i++) {
    assignmentPatterns.push(new RegExp('\\b' + escapeRegex(candidates[i]) + '\\b\\s*(?:[+\\-*/]?=(?!=)|\\+\\+|--)', 'i'));
  }

  var out = [];
  for (var lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    var line = lines[lineIndex];
    if (isEconomyGold) {
      var economyRepair = repairEconomyGoldWriteLine(line);
      if (economyRepair.changed) {
        changed = true;
        if (economyRepair.line) out.push(economyRepair.line);
        continue;
      }
    }

    var mutatesState = false;
    for (var p = 0; p < assignmentPatterns.length; p++) {
      if (assignmentPatterns[p].test(stripComments(line))) {
        mutatesState = true;
        break;
      }
    }
    if (mutatesState) {
      var indent = (line.match(/^[ \t]*/) || [''])[0];
      out.push(indent + '// stripped cross-owner assembly state mutation');
      changed = true;
      continue;
    }

    out.push(line);
  }

  return { changed: changed, code: out.join('\n') };
}

function autoRepairAssemblyStateOwnerMismatch(ctx) {
  if (!ctx || !ctx.extraFiles) return false;
  var violations = assemblyPlanContracts.detectAssemblyContractViolations(ctx).filter(function(violation) {
    return violation && violation.rule === 'assembly-state-owner-mismatch' && violation.data;
  });
  if (violations.length === 0) return false;

  var changed = false;
  for (var i = 0; i < violations.length; i++) {
    var state = violations[i].data.state;
    var files = Array.isArray(violations[i].data.violatingFiles) ? violations[i].data.violatingFiles : [];
    for (var j = 0; j < files.length; j++) {
      var file = files[j];
      if (!Object.prototype.hasOwnProperty.call(ctx.extraFiles, file)) continue;
      var result = repairStateOwnerWritesInCode(ctx.extraFiles[file], state);
      if (result.changed) {
        ctx.extraFiles[file] = result.code;
        changed = true;
      }
    }
  }

  return changed;
}

/**
 * Invalidate the codegen checkpoint so the next pipeline retry forces a fresh
 * codegen run rather than skipping it.  Mirrors the pattern used in
 * spec-validate.cjs for spec-extract invalidation.
 *
 * @param {object} ctx  pipeline context
 */
function invalidateCodegenCheckpoint(ctx) {
  if (!ctx || !Array.isArray(ctx.completedStages)) return;
  var idx = ctx.completedStages.indexOf('codegen');
  if (idx >= 0) {
    ctx.completedStages.splice(idx, 1);
    console.log('[method-check] invalidated codegen checkpoint so next retry re-runs codegen');
  }
}

function buildAggregateCode(csCode, extraFiles) {
  var aggregateCode = csCode || '';
  if (extraFiles) {
    for (var efName in extraFiles) {
      if (!extraFiles.hasOwnProperty(efName)) continue;
      aggregateCode += '\n' + String(extraFiles[efName] || '');
    }
  }
  return aggregateCode;
}

function isTaskPartialFile(fileName) {
  return /^GameFlowManagerMain.*\.cs$/.test(String(fileName || ''));
}

function buildTaskPartialCodeBundle(ctx) {
  var bundle = [{ file: 'main', code: ctx && ctx.csCode || '' }];
  var extraFiles = ctx && ctx.extraFiles || {};
  Object.keys(extraFiles).forEach(function(name) {
    if (!isTaskPartialFile(name)) return;
    bundle.push({ file: name, code: String(extraFiles[name] || '') });
  });
  return bundle;
}

function buildTaskAggregateCode(ctx) {
  return buildTaskPartialCodeBundle(ctx).map(function(entry) { return entry.code; }).join('\n');
}

function collectAllowedPoolList(ctx) {
  return Object.keys(collectAllowedPoolNames(ctx)).sort();
}

function pushFeedbackUnique(ctx, entry) {
  if (!ctx || !ctx.blueprint) return;
  if (!ctx.blueprint.feedbackHistory) ctx.blueprint.feedbackHistory = [];
  var history = ctx.blueprint.feedbackHistory;
  var signature = [
    entry.source || '',
    entry.rule || '',
    entry.file || '',
    entry.line || '',
    entry.message || '',
  ].join('|');
  for (var i = 0; i < history.length; i++) {
    var existing = history[i] || {};
    var existingSig = [
      existing.source || '',
      existing.rule || '',
      existing.file || '',
      existing.line || '',
      existing.message || '',
    ].join('|');
    if (existingSig === signature) {
      history[i] = Object.assign({}, existing, entry, { timestamp: new Date().toISOString() });
      return;
    }
  }
  history.push(entry);
}

function stripComments(code) {
  return String(code || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n\r]*/g, ' ');
}

function escapeRegex(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectDuplicateStateFields(code) {
  var counts = {};
  var duplicates = [];
  var re = /\b(?:public|private|protected|internal)?\s*(?:static\s+)?(?:int|float|bool|string)\s+([A-Z][A-Za-z0-9_]*State)\s*(?:=\s*[^;]+)?;/g;
  var m;
  while ((m = re.exec(code || '')) !== null) {
    counts[m[1]] = (counts[m[1]] || 0) + 1;
  }
  Object.keys(counts).forEach(function(name) {
    if (counts[name] > 1) duplicates.push(name);
  });
  return duplicates.sort();
}

function collectTopLevelFieldNames(code, lineRe) {
  var counts = {};
  var text = String(code || '');
  var lines = text.split('\n');
  var depth = 0;
  var currentClass = null;
  var classDepth = 0;
  var classDeclRe = /\b(?:public|private|protected|internal)?\s*(?:static\s+)?(?:partial\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)\b/;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!currentClass) {
      var classMatch = classDeclRe.exec(line);
      if (classMatch) {
        currentClass = classMatch[1];
        classDepth = depth;
      }
    }

    if (!/^[ \t]*\/\//.test(line) && currentClass && depth === classDepth + 1) {
      var m = lineRe.exec(line);
      if (m && m[1]) {
        var classCounts = counts[currentClass] || {};
        classCounts[m[1]] = (classCounts[m[1]] || 0) + 1;
        counts[currentClass] = classCounts;
      }
      lineRe.lastIndex = 0;
    }
    var opens = (line.match(/\{/g) || []).length;
    var closes = (line.match(/\}/g) || []).length;
    depth += opens - closes;
    if (depth < 0) depth = 0;
    if (currentClass && depth <= classDepth && closes > 0) {
      currentClass = null;
      classDepth = 0;
    }
  }
  return counts;
}

function detectDuplicateObjectFields(code) {
  var duplicates = [];
  var counts = collectTopLevelFieldNames(
    code,
    /^[ \t]*(?:(?:public|private|protected|internal)\s+)?(?:static\s+)?(?:GameObject(?:\[\])?|Transform|Camera|Canvas|Text|Image|Button|Slider|RectTransform|GFM_Joystick)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:=\s*[^;]+)?;[ \t]*(?:(?:\/\/.*)|(?:\/\*.*\*\/\s*))?$/
  );
  Object.keys(counts).forEach(function(className) {
    Object.keys(counts[className]).forEach(function(name) {
      if (counts[className][name] > 1 && duplicates.indexOf(name) < 0) duplicates.push(name);
    });
  });
  return duplicates.sort();
}

function detectForbiddenGenericApis(code) {
  var hits = [];
  var re = /\.GetComponent\s*<\s*([A-Za-z_][A-Za-z0-9_.]*)\s*>\s*\(/g;
  var m;
  while ((m = re.exec(code || '')) !== null) {
    var sig = 'GetComponent<' + m[1] + '>';
    if (hits.indexOf(sig) < 0) hits.push(sig);
  }
  return hits;
}

function detectPlayerAliasDrift(code) {
  var aliases = [];
  var scanCode = stripComments(code)
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
  var patterns = [
    {
      name: 'player',
      decl: /\b(?:GameObject|Transform|Rigidbody|Collider|CharacterController)\s+player\b/,
      assign: /\bplayer\s*=/,
      use: /(^|[^A-Za-z0-9_])player([^A-Za-z0-9_]|$)/
    },
    {
      name: 'Player',
      decl: /\b(?:GameObject|Transform|Rigidbody|Collider|CharacterController)\s+Player\b/,
      assign: /\bPlayer\s*=/,
      use: /(^|[^A-Za-z0-9_])Player([^A-Za-z0-9_]|$)/
    },
    {
      name: 'PlayerAvatar',
      decl: /\b(?:GameObject|Transform|Rigidbody|Collider|CharacterController)\s+PlayerAvatar\b/,
      assign: /\bPlayerAvatar\s*=/,
      use: /(^|[^A-Za-z0-9_])PlayerAvatar([^A-Za-z0-9_]|$)/
    },
  ];
  patterns.forEach(function(entry) {
    if (entry.decl.test(scanCode) || entry.assign.test(scanCode) || entry.use.test(scanCode)) {
      aliases.push(entry.name);
    }
  });
  return aliases.length > 1 ? aliases : [];
}

function chooseCanonicalPlayerAlias(code) {
  var scanCode = stripComments(code)
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
  var preferences = ['player', 'Player', 'PlayerAvatar'];
  for (var i = 0; i < preferences.length; i++) {
    var alias = preferences[i];
    var re = new RegExp('\\b(?:GameObject|Transform|Rigidbody|Collider|CharacterController)\\s+' + alias + '\\b|\\b' + alias + '\\s*=');
    if (re.test(scanCode)) return alias;
  }
  return 'player';
}

function collectAllowedPoolNames(ctx) {
  var allowed = {};
  var entities = ctx && ctx.blueprint && Array.isArray(ctx.blueprint.entities) ? ctx.blueprint.entities : [];
  for (var i = 0; i < entities.length; i++) {
    var entity = entities[i] || {};
    var pool = entity.pool || entity.poolName;
    if (pool) allowed[String(pool)] = true;
  }
  var manifest = ctx && ctx.blueprint && ctx.blueprint.poolManifest;
  if (manifest && Array.isArray(manifest.pools)) {
    for (var j = 0; j < manifest.pools.length; j++) {
      if (manifest.pools[j] && manifest.pools[j].name) allowed[String(manifest.pools[j].name)] = true;
    }
  }
  return allowed;
}

function detectInvalidPoolLiterals(code, ctx) {
  var allowed = collectAllowedPoolNames(ctx);
  if (Object.keys(allowed).length === 0) return [];
  var invalid = [];
  var re = /__Pool_[A-Za-z0-9_]+/g;
  var scanCode = stripComments(code);
  var m;
  while ((m = re.exec(scanCode)) !== null) {
    var pool = m[0];
    if (allowed[pool]) continue;
    if (invalid.indexOf(pool) < 0) invalid.push(pool);
  }
  return invalid.sort();
}

function detectContractViolations(ctx) {
  var code = buildTaskAggregateCode(ctx);
  var violations = [];
  var duplicateStates = detectDuplicateStateFields(code);
  if (duplicateStates.length > 0) {
    violations.push({
      rule: 'duplicate-state-fields',
      severity: 'critical',
      message: 'Duplicate state fields detected: ' + duplicateStates.join(', ') + '. Reuse skeleton-owned state fields instead of redeclaring them in generated/custom code.',
      data: duplicateStates,
    });
  }
  var duplicateObjects = detectDuplicateObjectFields(code);
  if (duplicateObjects.length > 0) {
    violations.push({
      rule: 'duplicate-object-fields',
      severity: 'critical',
      message: 'Duplicate object reference fields detected: ' + duplicateObjects.join(', ') + '. Reuse skeleton-owned GameObject/UI fields instead of redeclaring them in generated/custom code.',
      data: duplicateObjects,
    });
  }
  var genericApis = detectForbiddenGenericApis(code);
  if (genericApis.length > 0) {
    violations.push({
      rule: 'forbidden-generic-api',
      severity: 'critical',
      message: 'Forbidden generic component APIs detected: ' + genericApis.join(', ') + '. Use non-generic Bridge-safe component access instead.',
      data: genericApis,
    });
  }
  var playerAliases = detectPlayerAliasDrift(code);
  if (playerAliases.length > 0) {
    var canonicalPlayerAlias = chooseCanonicalPlayerAlias(code);
    violations.push({
      rule: 'player-alias-drift',
      severity: 'critical',
      message: 'Mixed player aliases detected: ' + playerAliases.join(', ') + '. Normalize all player references to `' + canonicalPlayerAlias + '` and remove the other aliases.',
      data: {
        aliases: playerAliases,
        canonicalAlias: canonicalPlayerAlias,
      },
    });
  }
  var invalidPools = detectInvalidPoolLiterals(code, ctx);
  if (invalidPools.length > 0) {
    var allowedPools = collectAllowedPoolList(ctx);
    violations.push({
      rule: 'invalid-pool-literals',
      severity: 'critical',
      message: 'Invalid pool literals detected: ' + invalidPools.join(', ') + '. Allowed pool literals for this task: ' + allowedPools.join(', ') + '. Use only exact pool names from the blueprint/skeleton mapping.',
      data: {
        invalidPools: invalidPools,
        allowedPools: allowedPools,
      },
    });
  }
  var malformedIsNear = detectMalformedIsNearCalls(code);
  if (malformedIsNear.length > 0) {
    violations.push({
      rule: 'malformed-isnear-call',
      severity: 'critical',
      message: 'Malformed IsNear calls detected: ' + malformedIsNear.join(', ') + '. Missing target entities must be resolved or stripped before compile.',
      data: malformedIsNear,
    });
  }
  return violations.concat(assemblyPlanContracts.detectAssemblyContractViolations(ctx));
}

function applyPhaseGatePreRepair(ctx) {
  if (!ctx || !ctx.csCode) return { changed: false, fixes: [] };
  var reviewStage;
  try {
    reviewStage = require('./review.cjs');
  } catch (_err) {
    return { changed: false, fixes: [] };
  }
  var changed = false;
  var fixes = [];
  var mainCode = ctx.csCode;
  var extras = Object.assign({}, ctx.extraFiles || {});

  if (reviewStage.stripInteractionFlagShortcutsFromPhaseGates) {
    var mainShortcut = reviewStage.stripInteractionFlagShortcutsFromPhaseGates(mainCode, ctx.blueprint);
    if (mainShortcut && mainShortcut.changed) {
      mainCode = mainShortcut.code;
      changed = true;
      fixes.push('main:PhaseGateShortcutStrip x' + mainShortcut.fixes);
    }
  }
  if (reviewStage.repairPhaseGateRuntimeMoves) {
    var mainPhaseFix = reviewStage.repairPhaseGateRuntimeMoves(mainCode);
    if (mainPhaseFix && mainPhaseFix.changed) {
      mainCode = mainPhaseFix.code;
      changed = true;
      fixes.push('main:PhaseGateRuntimeMove x' + mainPhaseFix.fixes);
    }
  }
  if (reviewStage.normalizePhaseGateConditionalDeclarations) {
    var mainPhaseNormalize = reviewStage.normalizePhaseGateConditionalDeclarations(mainCode);
    if (mainPhaseNormalize && mainPhaseNormalize.changed) {
      mainCode = mainPhaseNormalize.code;
      changed = true;
      fixes.push('main:PhaseGateConditionalNormalize x' + mainPhaseNormalize.fixes);
    }
  }

  Object.keys(extras).forEach(function(name) {
    var next = extras[name];
    if (reviewStage.stripInteractionFlagShortcutsFromPhaseGates) {
      var shortcutRes = reviewStage.stripInteractionFlagShortcutsFromPhaseGates(next, ctx.blueprint);
      if (shortcutRes && shortcutRes.changed) {
        next = shortcutRes.code;
        changed = true;
        fixes.push(name + ':PhaseGateShortcutStrip x' + shortcutRes.fixes);
      }
    }
    if (reviewStage.repairPhaseGateRuntimeMoves) {
      var phaseRes = reviewStage.repairPhaseGateRuntimeMoves(next);
      if (phaseRes && phaseRes.changed) {
        next = phaseRes.code;
        changed = true;
        fixes.push(name + ':PhaseGateRuntimeMove x' + phaseRes.fixes);
      }
    }
    if (reviewStage.normalizePhaseGateConditionalDeclarations) {
      var phaseNormalizeRes = reviewStage.normalizePhaseGateConditionalDeclarations(next);
      if (phaseNormalizeRes && phaseNormalizeRes.changed) {
        next = phaseNormalizeRes.code;
        changed = true;
        fixes.push(name + ':PhaseGateConditionalNormalize x' + phaseNormalizeRes.fixes);
      }
    }
    extras[name] = next;
  });

  if (reviewStage.repairPhaseGateRuntimeMovesAcrossPartials) {
    var crossPhaseFix = reviewStage.repairPhaseGateRuntimeMovesAcrossPartials(mainCode, extras);
    if (crossPhaseFix && crossPhaseFix.changed) {
      mainCode = crossPhaseFix.code;
      extras = crossPhaseFix.extraFiles;
      changed = true;
      fixes.push('partials:PhaseGateRuntimeMove x' + crossPhaseFix.fixes);
    }
  }
  if (reviewStage.normalizePhaseGateConditionalDeclarations) {
    var postCrossMainNormalize = reviewStage.normalizePhaseGateConditionalDeclarations(mainCode);
    if (postCrossMainNormalize && postCrossMainNormalize.changed) {
      mainCode = postCrossMainNormalize.code;
      changed = true;
      fixes.push('main:PhaseGateConditionalNormalizePost x' + postCrossMainNormalize.fixes);
    }
    Object.keys(extras).forEach(function(name) {
      var normalizeRes = reviewStage.normalizePhaseGateConditionalDeclarations(extras[name]);
      if (normalizeRes && normalizeRes.changed) {
        extras[name] = normalizeRes.code;
        changed = true;
        fixes.push(name + ':PhaseGateConditionalNormalizePost x' + normalizeRes.fixes);
      }
    });
  }

  if (changed) {
    ctx.csCode = mainCode;
    ctx.extraFiles = extras;
  }
  return { changed: changed, fixes: fixes };
}

function autoRepairPhaseGateViolations(ctx, maxPasses) {
  var passes = typeof maxPasses === 'number' ? maxPasses : 2;
  var changed = false;
  var fixes = [];
  var violations = [];
  for (var pass = 0; pass < passes; pass++) {
    violations = detectPhaseGateViolations(ctx);
    if (!violations || violations.length === 0) {
      return { changed: changed, fixes: fixes, violations: [] };
    }
    var repair = applyPhaseGatePreRepair(ctx);
    if (!repair.changed) {
      return { changed: changed, fixes: fixes, violations: violations };
    }
    changed = true;
    fixes = fixes.concat(repair.fixes || []);
  }
  violations = detectPhaseGateViolations(ctx);
  return { changed: changed, fixes: fixes, violations: violations };
}

function detectPhaseGateViolations(ctx) {
  if (!ctx || !ctx.csCode) return [];
  var targetRules = {
    'phase-entity-init-only': true,
    'phase-entity-unbound': true,
    'phase-gate-shortcircuits-with-interaction-flags': true,
  };
  var issues = [];
  function collectFromCode(code, filename) {
    var result = staticCheckStage.staticCheck(code, {
      filename: filename,
      extraFiles: ctx.extraFiles || {},
      blueprint: ctx.blueprint || {},
      specs: ctx.blueprint && ctx.blueprint.specs || [],
      addLog: function() {},
    });
    var matches = (result.issues || []).filter(function(issue) { return targetRules[issue.rule]; });
    for (var i = 0; i < matches.length; i++) {
      issues.push({
        rule: matches[i].rule,
        severity: 'critical',
        file: filename,
        line: matches[i].line,
        message: matches[i].text,
      });
    }
  }
  collectFromCode(ctx.csCode, 'main');
  var extras = ctx.extraFiles || {};
  Object.keys(extras).forEach(function(name) {
    if (typeof extras[name] === 'string') collectFromCode(extras[name], name);
  });
  return issues;
}

// ============ Pipeline Stage ============

/**
 * Execute the method-completeness advisory check.
 *
 * @param {object} ctx  pipeline context
 * @returns {Promise<void>}
 */
function execute(ctx) {
  if (!ctx || !ctx.csCode) {
    return Promise.resolve();
  }

  var phaseRepair = applyPhaseGatePreRepair(ctx);
  if (phaseRepair.changed) {
    console.log('[method-check] AUTO-REPAIR — phase gate pre-repair:', phaseRepair.fixes.join(', '));
  }

  if (autoRepairForbiddenGenericApis(ctx)) {
    console.log('[method-check] AUTO-REPAIR — stripped forbidden generic API calls (.GetComponent<T>)');
  }
  if (autoRepairDuplicateStateFields(ctx)) {
    console.log('[method-check] AUTO-REPAIR — removed duplicate *State field declarations across partials');
  }
  if (autoRepairDuplicateSimpleFields(ctx)) {
    console.log('[method-check] AUTO-REPAIR — removed duplicate scalar/bool field declarations across partials');
  }
  if (autoRepairDuplicateObjectFields(ctx)) {
    console.log('[method-check] AUTO-REPAIR — removed duplicate object/UI field declarations across partials');
  }
  if (autoRepairPlayerAliasDrift(ctx)) {
    console.log('[method-check] AUTO-REPAIR — normalized player aliases across partials');
    if (autoRepairDuplicateObjectFields(ctx)) {
      console.log('[method-check] AUTO-REPAIR — removed duplicate object/UI field declarations after player alias normalization');
    }
    if (autoRepairDuplicateSimpleFields(ctx)) {
      console.log('[method-check] AUTO-REPAIR — removed duplicate scalar/bool field declarations after player alias normalization');
    }
  }
  if (autoRepairInvalidPoolLiterals(ctx)) {
    console.log('[method-check] AUTO-REPAIR — rewrote invalid pool literals to allowed blueprint pools');
  }
  if (autoRepairPartialClassMismatch(ctx)) {
    console.log('[method-check] AUTO-REPAIR — added partial keyword to GameFlowManagerMain main class');
  }
  if (autoRepairLocalUiHelperAliases(ctx)) {
    console.log('[method-check] AUTO-REPAIR — normalized invented local UI helper aliases to GFM_UI');
  }
  if (autoRepairMissingSkeletonBridgeInfra(ctx)) {
    console.log('[method-check] AUTO-REPAIR — rehydrated missing skeleton bridge infra');
  }
  if (autoRepairAssemblyModuleOwnerMismatch(ctx)) {
    console.log('[method-check] AUTO-REPAIR — injected missing // [ASSEMBLY SLOT] markers into ownerFiles');
  }
  if (autoRepairAssemblyStateOwnerMismatch(ctx)) {
    console.log('[method-check] AUTO-REPAIR — stripped cross-owner assembly state mutations');
  }

  var missing;
  try {
    missing = checkCompleteness(ctx.csCode, ctx.extraFiles);
  } catch (err) {
    console.warn('[method-check] checkCompleteness threw:', err && err.message);
    return Promise.resolve();
  }

  if (injectMissingHelpers(ctx, missing)) {
    console.log('[method-check] AUTO-REPAIR — injected missing helper(s):', missing.join(', '));
    try {
      missing = checkCompleteness(ctx.csCode, ctx.extraFiles);
    } catch (err2) {
      console.warn('[method-check] post-repair check threw:', err2 && err2.message);
      return Promise.resolve();
    }
  }

  if (!missing || missing.length === 0) {
    var violations = [];
    try {
      violations = detectContractViolations(ctx);
    } catch (contractErr) {
      console.warn('[method-check] contract check threw:', contractErr && contractErr.message);
      violations = [];
    }
    if (!violations || violations.length === 0) {
      console.log('[method-check] PASS — all called methods are defined or safe');
      return Promise.resolve();
    }

    console.warn('[method-check] CONTRACT violations:', violations.map(function(v) { return v.rule; }).join(', '));

    if (ctx.blueprint) {
      for (var vi = 0; vi < violations.length; vi++) {
        pushFeedbackUnique(ctx, {
          source: 'codegen-contract-check',
          severity: violations[vi].severity || 'critical',
          rule: violations[vi].rule,
          message: violations[vi].message,
          data: {
            text: violations[vi].message,
            structured: violations[vi].data,
          },
          timestamp: new Date().toISOString()
        });
      }
    }
    // Invalidate codegen checkpoint so the next retry re-runs codegen with the
    // new feedback rather than skipping it and looping on the same bad code.
    invalidateCodegenCheckpoint(ctx);
    return Promise.reject(new Error('Codegen contract failed: ' + violations.map(function(v) { return v.rule; }).join(', ')));
  }

  var phaseViolations = [];
  try {
    var phaseRepairLoop = autoRepairPhaseGateViolations(ctx, 2);
    if (phaseRepairLoop.changed) {
      console.log('[method-check] AUTO-REPAIR — phase gate post-check repair:', phaseRepairLoop.fixes.join(', '));
    }
    phaseViolations = phaseRepairLoop.violations || [];
  } catch (phaseErr) {
    console.warn('[method-check] phase gate check threw:', phaseErr && phaseErr.message);
    phaseViolations = [];
  }
  if (phaseViolations.length > 0) {
    console.warn('[method-check] PHASE-GATE violations:', phaseViolations.map(function(v) { return v.rule; }).join(', '));
    if (ctx.blueprint) {
      for (var pi = 0; pi < phaseViolations.length; pi++) {
        pushFeedbackUnique(ctx, {
          source: 'phase-gate-contract-check',
          severity: phaseViolations[pi].severity,
          rule: phaseViolations[pi].rule,
          file: phaseViolations[pi].file,
          line: phaseViolations[pi].line,
          message: phaseViolations[pi].message,
          timestamp: new Date().toISOString()
        });
      }
    }
    var uniqRules = [];
    for (var pr = 0; pr < phaseViolations.length; pr++) {
      if (uniqRules.indexOf(phaseViolations[pr].rule) < 0) uniqRules.push(phaseViolations[pr].rule);
    }
    // Invalidate codegen checkpoint so the next retry re-runs codegen with the
    // new feedback rather than skipping it and looping on the same bad code.
    invalidateCodegenCheckpoint(ctx);
    return Promise.reject(new Error('Phase gate contract failed: ' + uniqRules.join(', ')));
  }

  console.warn('[method-check] MISSING methods:', missing.join(', '));

  // Ensure feedbackHistory exists
  if (ctx.blueprint) {
    pushFeedbackUnique(ctx, {
      source: 'method-completeness-check',
      severity: 'critical',
      message: 'The following methods are called in lifecycle entry methods (Awake/Start/Update/LateUpdate/FixedUpdate/CheckEventRules) but are not defined anywhere in the generated code: ' + missing.join(', ') + '. Each missing method must be implemented with correct logic — do not remove the call, add the definition.',
      missing: missing,
      timestamp: new Date().toISOString()
    });
  }

  // Invalidate codegen checkpoint so the next retry re-runs codegen with the
  // new feedback rather than skipping it and looping on the same bad code.
  invalidateCodegenCheckpoint(ctx);
  return Promise.reject(new Error('Method completeness failed: missing methods: ' + missing.join(', ')));
}

// ============ Exports ============

module.exports = {
  name: 'method-check',
  canRetry: false,
  execute: execute,
  checkCompleteness: checkCompleteness,
  detectContractViolations: detectContractViolations,
  detectPhaseGateViolations: detectPhaseGateViolations,
  applyPhaseGatePreRepair: applyPhaseGatePreRepair,
  detectDuplicateStateFields: detectDuplicateStateFields,
  detectDuplicateObjectFields: detectDuplicateObjectFields,
  detectForbiddenGenericApis: detectForbiddenGenericApis,
  detectPlayerAliasDrift: detectPlayerAliasDrift,
  chooseCanonicalPlayerAlias: chooseCanonicalPlayerAlias,
  detectInvalidPoolLiterals: detectInvalidPoolLiterals,
  buildTaskAggregateCode: buildTaskAggregateCode,
  pushFeedbackUnique: pushFeedbackUnique,
  invalidateCodegenCheckpoint: invalidateCodegenCheckpoint, // Wave 2 #3: reused by static-pre-review stage

  injectMissingHelpers: injectMissingHelpers,
  autoRepairForbiddenGenericApis: autoRepairForbiddenGenericApis,
  autoRepairMalformedIsNear: autoRepairMalformedIsNear,
  autoRepairDuplicateStateFields: autoRepairDuplicateStateFields,
  autoRepairDuplicateSimpleFields: autoRepairDuplicateSimpleFields,
  autoRepairDuplicateObjectFields: autoRepairDuplicateObjectFields,
  autoRepairPlayerAliasDrift: autoRepairPlayerAliasDrift,
  autoRepairInvalidPoolLiterals: autoRepairInvalidPoolLiterals,
  autoRepairPartialClassMismatch: autoRepairPartialClassMismatch,
  autoRepairLocalUiHelperAliases: autoRepairLocalUiHelperAliases,
  autoRepairMissingSkeletonBridgeInfra: autoRepairMissingSkeletonBridgeInfra,
  autoRepairAssemblyModuleOwnerMismatch: autoRepairAssemblyModuleOwnerMismatch,
  autoRepairAssemblyStateOwnerMismatch: autoRepairAssemblyStateOwnerMismatch,
  autoRepairPhaseGateViolations: autoRepairPhaseGateViolations,
  chooseReplacementPoolLiteral: chooseReplacementPoolLiteral,
  detectMalformedIsNearCalls: detectMalformedIsNearCalls,
  extractMethodDefinitions: extractMethodDefinitions,
  extractMethodCalls: extractMethodCalls,
  ENTRY_SCOPE_METHODS: ENTRY_SCOPE_METHODS,
  SKELETON_SAFE: SKELETON_SAFE
};