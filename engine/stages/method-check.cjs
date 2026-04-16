// Source: engine/stages/method-check.cjs
/**
 * Stage: method-check — Advisory check that all methods called in Update()/CheckEventRules()
 * are actually defined in the generated C# code.
 *
 * This stage does NOT block the pipeline. On failure it injects structured feedback
 * into ctx.blueprint.feedbackHistory so the codegen fix-loop can repair the gap.
 *
 * Reads:  ctx.csCode
 * Writes: ctx.blueprint.feedbackHistory (push, advisory only)
 */

// ============ Safe Lists ============

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
  'GFM_Create', 'GFM_UI', 'GFM_Luna'
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
  var callRe = /\b([A-Z_]\w*)\s*\(/g;

  var i;
  for (i = 0; i < scopeMethods.length; i++) {
    var body = extractMethodBody(csCode, scopeMethods[i]);
    if (!body) {
      continue;
    }
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
 * @returns {string[]}  list of missing method names (empty = all good)
 */
function checkCompleteness(csCode) {
  var defined = extractMethodDefinitions(csCode);
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

// ============ Pipeline Stage ============

/**
 * Execute the method-completeness advisory check.
 *
 * Never rejects — failures are recorded as feedbackHistory entries.
 *
 * @param {object} ctx  pipeline context
 * @returns {Promise<void>}
 */
function execute(ctx) {
  if (!ctx || !ctx.csCode) {
    return Promise.resolve();
  }

  var missing;
  try {
    missing = checkCompleteness(ctx.csCode);
  } catch (err) {
    console.warn('[method-check] checkCompleteness threw:', err && err.message);
    return Promise.resolve();
  }

  if (!missing || missing.length === 0) {
    console.log('[method-check] PASS — all called methods are defined or safe');
    return Promise.resolve();
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

  return Promise.resolve();
}

// ============ Exports ============

module.exports = {
  name: 'method-check',
  canRetry: false,
  execute: execute,
  checkCompleteness: checkCompleteness,
  extractMethodDefinitions: extractMethodDefinitions,
  extractMethodCalls: extractMethodCalls,
  SKELETON_SAFE: SKELETON_SAFE
};
