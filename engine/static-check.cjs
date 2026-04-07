/**
 * Static pre-check — regex-based code quality scan before LLM review
 *
 * Catches forbidden API usage that the LLM reviewers sometimes miss.
 * Returns { passed, issues[] } where each issue has { rule, line, text }.
 */

var fs = require('fs');
var path = require('path');

var RULES = [
  { id: 'setactive', pattern: /\.SetActive\s*\(/g, message: 'SetActive() forbidden in Luna — use position=(0,-999,0) to hide' },
  { id: 'camera-main', pattern: /Camera\.main(?!\s*;?\s*\/\/\s*ok)/g, message: 'Camera.main forbidden — use skeleton\'s mainCam variable' },
  { id: 'create-obj', pattern: /GFM_Create\.Obj\s*\(/g, message: 'GFM_Create.Obj() forbidden — use GameObject.Find() from pool' },
  { id: 'create-ground', pattern: /GFM_Create\.Ground\s*\(/g, message: 'GFM_Create.Ground() forbidden — __Ground already exists' },
  { id: 'set-color', pattern: /GFM_Create\.SetColor\s*\(/g, message: 'GFM_Create.SetColor() forbidden — pool objects have baked colors' },
  { id: 'create-canvas', pattern: /GFM_UI\.CreateCanvas\s*\(/g, message: 'GFM_UI.CreateCanvas() forbidden — use skeleton\'s uiCanvas' },
  { id: 'create-primitive', pattern: /CreatePrimitive\s*\(/g, message: 'CreatePrimitive() forbidden in Luna — invisible at runtime' },
  { id: 'gfm-tools', pattern: /GFM_Tools\./g, message: 'GFM_Tools does not exist — use GFM_Create, GFM_UI, GFM_Utils, etc.' },
  { id: 'coroutine', pattern: /StartCoroutine\s*\(/g, message: 'Coroutines forbidden in Luna — use Update + timer' },
  { id: 'async-await', pattern: /\basync\b|\bawait\b/g, message: 'async/await forbidden in Luna — use Update + timer' },
  { id: 'linq', pattern: /using\s+System\.Linq/g, message: 'System.Linq forbidden in Luna (Bridge.NET)' },
  { id: 'list-generic', pattern: /\bList<[^>]+>/g, message: 'List<T> forbidden in Luna — use arrays' },
  { id: 'dict-generic', pattern: /\bDictionary<[^>]+>/g, message: 'Dictionary<K,V> forbidden in Luna — use arrays' },
  { id: 'set-parent', pattern: /\.SetParent\s*\(/g, message: 'SetParent() forbidden in Luna' },
  { id: 'transform-parent', pattern: /\.parent\s*=/g, message: 'transform.parent assignment forbidden in Luna' },
  { id: 'find-object-of-type', pattern: /FindObjectOfType\s*</g, message: 'FindObjectOfType<T>() forbidden — use (T)FindObjectOfType(typeof(T))' },
  { id: 'get-component-generic', pattern: /GetComponent\s*</g, message: 'GetComponent<T>() forbidden — use (T)GetComponent(typeof(T))' },
  { id: 'force-complete', pattern: /ForceCompleteAllPhases/g, message: 'ForceCompleteAllPhases forbidden — phases must require player interaction' },
  { id: 'external-eval', pattern: /Application\.ExternalEval/g, message: 'Application.ExternalEval() not supported in Luna' },
  { id: 'newtonsoft', pattern: /Newtonsoft\.Json/g, message: 'Newtonsoft.Json not supported in Luna' },
  { id: 'class-eventpool', pattern: /class\s+EventPool\b/g, message: 'class EventPool conflicts with template — do not define' },
  { id: 'missing-using', pattern: null, message: 'Missing "using UnityEngine;" declaration', custom: function(code) {
    if (code.indexOf('using UnityEngine;') === -1) return [{ line: 1, text: 'File start' }];
    return [];
  }},
  // --- v2: Additional rules ---
  { id: 'new-list', pattern: /new\s+List\s*</g, message: 'new List<T>() forbidden in Luna — use plain arrays' },
  { id: 'new-dict', pattern: /new\s+Dictionary\s*</g, message: 'new Dictionary<K,V>() forbidden in Luna — use parallel arrays' },
  { id: 'linq-methods', pattern: /\.(Where|Select|FirstOrDefault|Any|All|OrderBy|GroupBy|ToList|ToArray|Aggregate)\s*\(/g,
    message: 'LINQ extension method forbidden in Luna — use manual for loop' },
  { id: 'while-true', pattern: /while\s*\(\s*true\s*\)/g, message: 'while(true) forbidden — use Update() + timer to avoid freezing the game' },
  { id: 'pool-name-typo', pattern: /__Pol_|__Pool(?!_)|__pool_/g, message: 'Possible pool object name typo — correct prefix is __Pool_' },
  { id: 'destroy-call', pattern: /\bDestroy\s*\(/g, message: 'Destroy() forbidden in Luna — hide objects by moving to (0,-999,0)' },
  { id: 'invoke-call', pattern: /\bInvoke\s*\(\s*"/g, message: 'Invoke("method") forbidden in Luna — use Update() + timer' },
  { id: 'invoke-repeating', pattern: /\bInvokeRepeating\s*\(/g, message: 'InvokeRepeating() forbidden in Luna — use Update() + timer' },
];

/**
 * Build a boolean mask where 1 = real code, 0 = inside string or comment
 * Handles: line comments, block comments, regular strings, verbatim strings, char literals
 */
function buildCodeMask(code) {
  var mask = new Uint8Array(code.length); // 0 = skip, 1 = code
  var i = 0;
  while (i < code.length) {
    // Line comment
    if (code[i] === '/' && code[i + 1] === '/') {
      while (i < code.length && code[i] !== '\n') i++;
      continue;
    }
    // Block comment
    if (code[i] === '/' && code[i + 1] === '*') {
      i += 2;
      while (i < code.length - 1 && !(code[i] === '*' && code[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // Verbatim string @"..."
    if (code[i] === '@' && code[i + 1] === '"') {
      i += 2;
      while (i < code.length) {
        if (code[i] === '"' && code[i + 1] === '"') { i += 2; continue; }
        if (code[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }
    // Regular string "..."
    if (code[i] === '"') {
      i++;
      while (i < code.length && code[i] !== '"' && code[i] !== '\n') {
        if (code[i] === '\\') i++; // skip escaped char
        i++;
      }
      if (i < code.length) i++; // closing quote
      continue;
    }
    // Char literal '.'
    if (code[i] === '\'') {
      i++;
      if (i < code.length && code[i] === '\\') i++;
      i++;
      if (i < code.length && code[i] === '\'') i++;
      continue;
    }
    // Real code
    mask[i] = 1;
    i++;
  }
  return mask;
}

// Load external custom rules (extends/overrides built-in RULES)
var CUSTOM_RULES_PATH = path.join(__dirname, '..', 'data', 'static-rules.json');
try {
  var customData = JSON.parse(fs.readFileSync(CUSTOM_RULES_PATH, 'utf8'));
  var customRules = customData.rules || [];
  for (var cri = 0; cri < customRules.length; cri++) {
    var cr = customRules[cri];
    if (!cr.id || !cr.pattern || !cr.message) continue;
    // Check if override of existing rule
    var existingIdx = -1;
    for (var eri = 0; eri < RULES.length; eri++) {
      if (RULES[eri].id === cr.id) { existingIdx = eri; break; }
    }
    var entry = { id: cr.id, pattern: new RegExp(cr.pattern, cr.flags || 'g'), message: cr.message };
    if (cr.disabled) {
      // Remove rule if disabled
      if (existingIdx >= 0) RULES.splice(existingIdx, 1);
    } else if (existingIdx >= 0) {
      RULES[existingIdx] = entry;
    } else {
      RULES.push(entry);
    }
  }
} catch(e) {
  // No custom rules file — use built-in rules only
}

/**
 * Run static checks on C# code
 * @param {string} code - The C# source code
 * @returns {{ passed: boolean, issues: Array<{rule: string, line: number, text: string, message: string}> }}
 */
function staticCheck(code, ctx) {
  var lines = code.split('\n');
  var mask = buildCodeMask(code);
  var issues = [];

  for (var r = 0; r < RULES.length; r++) {
    var rule = RULES[r];

    if (rule.custom) {
      var customHits = rule.custom(code, ctx);
      for (var c = 0; c < customHits.length; c++) {
        issues.push({
          rule: rule.id,
          line: customHits[c].line,
          text: customHits[c].text,
          message: rule.message,
        });
      }
      continue;
    }

    // Reset regex
    rule.pattern.lastIndex = 0;
    var match;
    while ((match = rule.pattern.exec(code)) !== null) {
      // Skip if match starts inside a string or comment
      if (!mask[match.index]) continue;

      // Find line number
      var pos = match.index;
      var lineNum = 1;
      for (var i = 0; i < pos; i++) {
        if (code[i] === '\n') lineNum++;
      }
      var lineText = lines[lineNum - 1] || '';

      issues.push({
        rule: rule.id,
        line: lineNum,
        text: lineText.trim().slice(0, 120),
        message: rule.message,
      });
    }
  }

  return {
    passed: issues.length === 0,
    issues: issues,
  };
}

module.exports = { staticCheck: staticCheck, RULES: RULES };
