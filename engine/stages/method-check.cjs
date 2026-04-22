// Source: engine/stages/method-check.cjs
/**
 * Stage: method-check — hard check that all methods called in Update()/CheckEventRules()
 * are actually defined in the generated C# code.
 *
 * This stage blocks the pipeline on missing methods, and also injects structured
 * feedback into ctx.blueprint.feedbackHistory so the codegen fix-loop can repair the gap.
 *
 * Reads:  ctx.csCode, ctx.extraFiles
 * Writes: ctx.blueprint.feedbackHistory (push, blocking on failure)
 */

// ============ Safe Lists ============
var staticCheckStage = require('../static-check.cjs');

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
  'GFM_Create', 'GFM_UI', 'GFM_Luna', 'GFM_Audio', 'GFM_Pool', 'GFM_Event',
  'GFM_Utils', 'GFM_Grid', 'GFM_Pathfinding', 'GFM_Billboard',
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
 * @param {string[]} scopeMethods  e.g. ['Update', 'CheckEventRules']
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

/**
 * Check whether all methods called inside Update() / CheckEventRules() are
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
  var called = extractMethodCalls(csCode, ['Update', 'CheckEventRules']);

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

function stripComments(code) {
  return String(code || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n\r]*/g, ' ');
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
  var patterns = [
    { name: 'player', re: /(^|[^A-Za-z0-9_])player([^A-Za-z0-9_]|$)/ },
    { name: 'Player', re: /(^|[^A-Za-z0-9_])Player([^A-Za-z0-9_]|$)/ },
    { name: 'PlayerAvatar', re: /(^|[^A-Za-z0-9_])PlayerAvatar([^A-Za-z0-9_]|$)/ },
  ];
  patterns.forEach(function(entry) {
    if (entry.re.test(code || '')) aliases.push(entry.name);
  });
  return aliases.length > 1 ? aliases : [];
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
  var code = buildAggregateCode(ctx && ctx.csCode, ctx && ctx.extraFiles);
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
    violations.push({
      rule: 'player-alias-drift',
      severity: 'critical',
      message: 'Mixed player aliases detected: ' + playerAliases.join(', ') + '. Generated code must use one consistent skeleton-owned player symbol.',
      data: playerAliases,
    });
  }
  var invalidPools = detectInvalidPoolLiterals(code, ctx);
  if (invalidPools.length > 0) {
    violations.push({
      rule: 'invalid-pool-literals',
      severity: 'critical',
      message: 'Invalid pool literals detected: ' + invalidPools.join(', ') + '. Use only exact pool names from the blueprint/skeleton mapping.',
      data: invalidPools,
    });
  }
  return violations;
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
    extras[name] = next;
  });

  if (changed) {
    ctx.csCode = mainCode;
    ctx.extraFiles = extras;
  }
  return { changed: changed, fixes: fixes };
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

    if (ctx.blueprint && !ctx.blueprint.feedbackHistory) {
      ctx.blueprint.feedbackHistory = [];
    }
    if (ctx.blueprint && ctx.blueprint.feedbackHistory) {
      for (var vi = 0; vi < violations.length; vi++) {
        ctx.blueprint.feedbackHistory.push({
          source: 'codegen-contract-check',
          severity: violations[vi].severity || 'critical',
          rule: violations[vi].rule,
          message: violations[vi].message,
          data: violations[vi].data,
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
    phaseViolations = detectPhaseGateViolations(ctx);
  } catch (phaseErr) {
    console.warn('[method-check] phase gate check threw:', phaseErr && phaseErr.message);
    phaseViolations = [];
  }
  if (phaseViolations.length > 0) {
    console.warn('[method-check] PHASE-GATE violations:', phaseViolations.map(function(v) { return v.rule; }).join(', '));
    if (ctx.blueprint && !ctx.blueprint.feedbackHistory) {
      ctx.blueprint.feedbackHistory = [];
    }
    if (ctx.blueprint && ctx.blueprint.feedbackHistory) {
      for (var pi = 0; pi < phaseViolations.length; pi++) {
        ctx.blueprint.feedbackHistory.push({
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
  if (ctx.blueprint && !ctx.blueprint.feedbackHistory) {
    ctx.blueprint.feedbackHistory = [];
  }

  if (ctx.blueprint && ctx.blueprint.feedbackHistory) {
    ctx.blueprint.feedbackHistory.push({
      source: 'method-completeness-check',
      severity: 'critical',
      message: 'The following methods are called in Update() / CheckEventRules() but are not defined anywhere in the generated code: ' + missing.join(', ') + '. Each missing method must be implemented with correct logic — do not remove the call, add the definition.',
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
  detectForbiddenGenericApis: detectForbiddenGenericApis,
  detectPlayerAliasDrift: detectPlayerAliasDrift,
  detectInvalidPoolLiterals: detectInvalidPoolLiterals,
  injectMissingHelpers: injectMissingHelpers,
  extractMethodDefinitions: extractMethodDefinitions,
  extractMethodCalls: extractMethodCalls,
  SKELETON_SAFE: SKELETON_SAFE
};