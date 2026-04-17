/**
 * Static pre-check — regex-based code quality scan before LLM review
 *
 * Catches forbidden API usage that the LLM reviewers sometimes miss.
 * Returns { passed, issues[] } where each issue has { rule, line, text }.
 */

var fs = require('fs');
var path = require('path');

// `blocking: true` — these rules cause black-screen / invisible render at runtime.
// The codegen stage treats them as blocking (fail the round + inject feedback)
// instead of letting the generation advance to review. Rationale (2026-04-15 bqh33t
// post-mortem): when the LLM reviewer is unavailable/silently passing and visual-check
// is broken, a single GFM_Create.Obj() call ships black-screen code all the way to
// CUA. Catching these in codegen stops the damage 3 stages earlier.
var RULES = [
  { id: 'setactive', pattern: /\.SetActive\s*\(/g, blocking: true, message: 'SetActive() forbidden in Luna — use position=(0,-999,0) to hide' },
  { id: 'camera-main', pattern: /Camera\.main(?!\s*;?\s*\/\/\s*ok)/g, message: 'Camera.main forbidden — use skeleton\'s mainCam variable' },
  { id: 'create-obj', pattern: /GFM_Create\.Obj\s*\(/g, blocking: true, message: 'GFM_Create.Obj() forbidden — use GameObject.Find() from pool' },
  { id: 'create-ground', pattern: /GFM_Create\.Ground\s*\(/g, blocking: true, message: 'GFM_Create.Ground() forbidden — __Ground already exists' },
  { id: 'set-color', pattern: /GFM_Create\.SetColor\s*\(/g, blocking: true, message: 'GFM_Create.SetColor() forbidden — pool objects have baked colors' },
  { id: 'create-canvas', pattern: null, blocking: true,
    message: 'GFM_UI.CreateCanvas() forbidden — use skeleton\'s uiCanvas',
    custom: function(code) {
      var matches = [];
      var re = /GFM_UI\.CreateCanvas\s*\(/g;
      var m;
      while ((m = re.exec(code)) !== null) matches.push(m.index);
      if (matches.length <= 1) return [];
      var issues = [];
      for (var i = 1; i < matches.length; i++) {
        var lineNum = code.substring(0, matches[i]).split('\n').length;
        var lineText = code.split('\n')[lineNum - 1] || '';
        issues.push({ line: lineNum, text: lineText.trim() });
      }
      return issues;
    },
  },
  { id: 'create-primitive', pattern: /CreatePrimitive\s*\(/g, blocking: true, message: 'CreatePrimitive() forbidden in Luna — invisible at runtime' },
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
  { id: 'json-utility', pattern: /JsonUtility\./g, message: 'UnityEngine.JsonUtility unsupported in Luna — use Newtonsoft.Json instead' },
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
  { id: 'destroy-call', pattern: /\bDestroy\s*\(/g, blocking: true, message: 'Destroy() forbidden in Luna — hide objects by moving to (0,-999,0)' },
  { id: 'invoke-call', pattern: /\bInvoke\s*\(\s*"/g, message: 'Invoke("method") forbidden in Luna — use Update() + timer' },
  { id: 'invoke-repeating', pattern: /\bInvokeRepeating\s*\(/g, message: 'InvokeRepeating() forbidden in Luna — use Update() + timer' },
  { id: 'instantiate', pattern: /\bInstantiate\s*\(/g, blocking: true, message: 'Instantiate() forbidden in Luna — use GameObject.Find() from pool' },
  { id: 'add-component', pattern: /\bAddComponent\s*[<(]/g, blocking: true, message: 'AddComponent() forbidden in Luna — components must be pre-baked on pool objects' },
  { id: 'resources-load', pattern: /Resources\.Load/g, message: 'Resources.Load() not supported in Luna — use pool objects' },
  // --- v3: Rendering & anti-solid-color rules ---
  { id: 'safe-color-recursion', pattern: /Color\s+SafeColor|SafeColor\s*\(/g, message: 'SafeColor pattern causes infinite recursion in Luna — remove and use literal Color values' },
  { id: 'renderer-material-color', pattern: /\.material\.color\s*=/g, blocking: true, message: 'Renderer.material.color causes GL_INVALID_OPERATION in Luna — pool objects have pre-baked colors' },
  { id: 'new-material', pattern: /new\s+Material\s*\(/g, blocking: true, message: 'new Material() not supported in Luna — use GFM_Create.InitMaterialFromScene()' },
  { id: 'render-no-objects', pattern: null, message: 'Phase 1 must place at least 3 pool objects on screen (anti-solid-color)', custom: function(code) {
    // Check that first phase (ruleTriggered[0] block) has at least 3 PlaceObj or transform.position calls
    var phase1Match = code.match(/ruleTriggered\[0\][^}]*\{([\s\S]*?)(?:ruleTriggered\[1\]|$)/);
    if (!phase1Match) return []; // No phase structure found — skip check
    var phase1Code = phase1Match[1];
    var placeCount = (phase1Code.match(/PlaceObj\s*\(|\.transform\.position\s*=/g) || []).length;
    if (placeCount < 3) return [{ line: 1, text: 'Only ' + placeCount + ' objects placed in phase 1 (need ≥3)' }];
    return [];
  }},
  // --- v4: AutoPlay duration protection ---
  { id: 'autoplay-duration-tamper', pattern: null, message: 'AUTO_PLAY_PHASE_DURATION must be >= 10 — AI must NOT reduce shot duration', custom: function(code) {
    var m = code.match(/AUTO_PLAY_PHASE_DURATION\s*=\s*(\d+)/);
    if (!m) return [];
    var val = parseInt(m[1], 10);
    if (val < 10) {
      var lineNum = code.substring(0, m.index).split('\n').length;
      return [{ line: lineNum, text: 'AUTO_PLAY_PHASE_DURATION = ' + val + ' (must be >= 10, skeleton sets 12)' }];
    }
    return [];
  }},
  { id: 'autoplay-gate-removed', pattern: null, message: 'AutoPlay 20s gate block was removed — each shot must wait 20s in autoPlay mode', custom: function(code) {
    // The skeleton generates: if (_autoPlayMode && !ruleTriggered[N] && phaseTimer < 20f) {}
    // If AI removes this gate, phases will advance instantly
    if (code.indexOf('_autoPlayMode') >= 0 && code.indexOf('phaseTimer < 20f') < 0) {
      return [{ line: 1, text: 'Missing "phaseTimer < 20f" gate — skeleton autoPlay gate was deleted by AI' }];
    }
    return [];
  }},
  { id: 'autoplay-interact-empty', pattern: null, message: 'OnAutoPlayArrive is empty — must simulate interactions for CUA variable checking', custom: function(code) {
    // Check if OnAutoPlayArrive exists and has real content (not just TODO comments).
    // 2026-04-16: old regex `\{([^}]*)\}` stopped at the first `}` in the body — skeleton
    // example comments (and real nested blocks) have `}`, which truncated the capture and
    // made the rule永久误判 2p50o1 为 empty. Fix: strip comments/strings first, then walk
    // brace depth to find the real matching `}`. Handles arbitrary nesting.
    var stripped = code
      .replace(/\/\*[\s\S]*?\*\//g, '')      // block comments
      .replace(/\/\/[^\n]*/g, '')             // line comments
      .replace(/"(?:[^"\\]|\\.)*"/g, '""');   // string literals (keep quotes so `""` isn't a token)
    var sigMatch = stripped.match(/void\s+OnAutoPlayArrive\s*\(\s*string\s+\w+\s*\)\s*\{/);
    if (!sigMatch) return [];
    var start = sigMatch.index + sigMatch[0].length;
    var depth = 1;
    var end = start;
    while (end < stripped.length && depth > 0) {
      var ch = stripped[end];
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) break; }
      end++;
    }
    if (depth !== 0) return [];
    var body = stripped.substring(start, end).trim();
    if (body.length < 10) {
      var sigIdx = code.indexOf('OnAutoPlayArrive');
      var lineNum = sigIdx >= 0 ? code.substring(0, sigIdx).split('\n').length : 1;
      return [{ line: lineNum, text: 'OnAutoPlayArrive body is empty — must update game variables (gold, score, etc.) when autoPlay player reaches a target' }];
    }
    return [];
  }},
  { id: 'autoplay-phase-too-fast', pattern: null, message: 'AutoPlay phase uses phaseTimer threshold < 15s — shots must be >= 20s', custom: function(code) {
    var issues = [];
    var re = /_autoPlayMode\s*\?\s*phaseTimer\s*>=\s*(\d+)f?\b/g;
    var m2;
    while ((m2 = re.exec(code)) !== null) {
      var threshold = parseInt(m2[1], 10);
      if (threshold < 15) {
        var lineNum = code.substring(0, m2.index).split('\n').length;
        issues.push({ line: lineNum, text: 'autoPlay phaseTimer >= ' + threshold + 'f (must be >= 20f)' });
      }
    }
    return issues;
  }},
  // --- v5: Anti-gate-bypass rules ---
  { id: 'force-advance-func', pattern: /ForceAdvance|ForceProgress|SkipGate|BypassGate/g, message: 'ForceAdvance/SkipGate functions forbidden — autoPlay 20s gates must NOT be bypassed' },
  { id: 'autoplay-interact-timer-too-fast', pattern: null, message: 'AutoPlay _autoInteractTimer interval must be >= 2f (skeleton sets 3f)', custom: function(code) {
    var issues = [];
    var re = /_autoInteractTimer\s*>=\s*(\d+\.?\d*)f?\b/g;
    var m;
    while ((m = re.exec(code)) !== null) {
      var val = parseFloat(m[1]);
      if (val < 2.0) {
        var lineNum = code.substring(0, m.index).split('\n').length;
        issues.push({ line: lineNum, text: '_autoInteractTimer >= ' + val + 'f (must be >= 2f, skeleton sets 3f)' });
      }
    }
    return issues;
  }},
  { id: 'safety-net-threshold-tamper', pattern: null, message: 'AutoPlay safety net threshold must be >= 40f (skeleton sets 50f)', custom: function(code) {
    // Check for safety net with low phaseTimer threshold
    var issues = [];
    // Match: _autoPlayMode && !gameEnded && phaseTimer >= Xf  (the safety net pattern)
    var re = /_autoPlayMode\s*&&\s*!gameEnded\s*&&\s*(?:this\.)?phaseTimer\s*>=\s*(\d+\.?\d*)f?\b/g;
    var m;
    while ((m = re.exec(code)) !== null) {
      var val = parseFloat(m[1]);
      if (val < 40) {
        var lineNum = code.substring(0, m.index).split('\n').length;
        issues.push({ line: lineNum, text: 'Safety net phaseTimer >= ' + val + 'f (must be >= 40f, skeleton sets 50f)' });
      }
    }
    return issues;
  }},
  // 2026-04-16 (proj_xrbkl1 postmortem): anti-autoplay flags like `spaceJunkDone` were
  // ONLY flipped inside OnAutoPlayArrive. In CUA autoPlay mode the skeleton bypasses
  // these flags via the 20s timer; but in interactive mode (visual pre-check + real
  // users) the flag never flips, so Phase 2 never triggers, game visually freezes, CUA
  // burns 45min trying to fix the impossible. Rule: every xxxDone flag read as
  // `xxxDone == true` in a non-autoplay branch MUST have at least one `xxxDone = true`
  // assignment OUTSIDE OnAutoPlayArrive (e.g. in a proximity check, raycast handler,
  // or collision callback). Blocking: dead playable otherwise.
  { id: 'interactive-done-flag-dead', pattern: null, blocking: true,
    message: 'Anti-autoplay xxxDone flag has no interactive-mode assignment — game will freeze when autoPlay is disabled',
    custom: function(code) {
      var issues = [];
      // Strip comments/strings so we don't match inside them
      var stripped = code
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/"(?:[^"\\]|\\.)*"/g, '""');
      // Locate OnAutoPlayArrive body via brace-depth walker
      var sigMatch = stripped.match(/void\s+OnAutoPlayArrive\s*\(\s*string\s+\w+\s*\)\s*\{/);
      var autoPlayStart = -1, autoPlayEnd = -1;
      if (sigMatch) {
        autoPlayStart = sigMatch.index + sigMatch[0].length;
        var d = 1, p = autoPlayStart;
        while (p < stripped.length && d > 0) {
          var ch = stripped[p];
          if (ch === '{') d++;
          else if (ch === '}') { d--; if (d === 0) { autoPlayEnd = p; break; } }
          p++;
        }
      }
      // Collect all Done-flag identifiers referenced in interactive-branch reads
      // (pattern: "xxxDone == true", "!xxxDone", "xxxDone &&", etc.). These are flags
      // the phase gate depends on in non-autoplay mode.
      var flagNames = {};
      var readRe = /\b(\w+(?:Done|Acted))\b/g;
      var rm;
      while ((rm = readRe.exec(stripped)) !== null) {
        flagNames[rm[1]] = true;
      }
      // For each flag: find all `xxxDone = true` assignments, check if any fall outside OnAutoPlayArrive body
      Object.keys(flagNames).forEach(function(flag) {
        if (!/(Done|Acted)$/.test(flag)) return;
        if (flag === 'gameEnded' || flag === 'autoPlayChecked') return; // non-interaction flags
        var assignRe = new RegExp('\\b' + flag + '\\s*=\\s*true\\b', 'g');
        var hasOutside = false, hasAny = false, am;
        while ((am = assignRe.exec(stripped)) !== null) {
          hasAny = true;
          if (autoPlayStart < 0 || am.index < autoPlayStart || am.index > autoPlayEnd) {
            hasOutside = true;
            break;
          }
        }
        if (hasAny && !hasOutside) {
          // Flag only set inside OnAutoPlayArrive — interactive mode will never flip it
          var firstAssign = code.match(new RegExp('\\b' + flag + '\\s*=\\s*true\\b'));
          var lineNum = firstAssign ? code.substring(0, firstAssign.index).split('\n').length : 1;
          issues.push({
            line: lineNum,
            text: flag + ' is only set in OnAutoPlayArrive — add a non-autoplay assignment (proximity check, raycast, collision)',
          });
        }
      });
      return issues;
    },
  },
  { id: 'direct-ruletriggered-set', pattern: null, message: 'ruleTriggered[] must only be set inside skeleton phase gates — do not set outside CheckEventRules', custom: function(code) {
    var issues = [];
    var funcRe = /void\s+(AutoPlayForceAdvance|ForceAdvance|AdvancePhase|SkipPhase)\s*\([^)]*\)\s*\{([\s\S]*?)\n    \}/g;
    var m;
    while ((m = funcRe.exec(code)) !== null) {
      if (m[2].indexOf('ruleTriggered') >= 0) {
        var lineNum = code.substring(0, m.index).split('\n').length;
        issues.push({ line: lineNum, text: 'Function ' + m[1] + '() sets ruleTriggered — only CheckEventRules may do this' });
      }
    }
    return issues;
  }},
  // --- v6: Codegen syntax safety rules ---
  { id: 'invalid-identifier', pattern: null, blocking: true,
    message: 'C# identifier starts with digit — invalid syntax (e.g. "bool 5Done")',
    custom: function(code) {
      var issues = [];
      var stripped = code
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/"(?:[^"\\]|\\.)*"/g, '""');
      var re = /\b(bool|int|float|string|double|GameObject|Vector[23]|Color|Transform)\s+(\d\w*)\b/g;
      var m;
      while ((m = re.exec(stripped)) !== null) {
        var lineNum = code.substring(0, m.index).split('\n').length;
        issues.push({ line: lineNum, text: m[1] + ' ' + m[2] + ' — variable name cannot start with a digit' });
      }
      return issues;
    },
  },
  { id: 'js-undefined-literal', pattern: null, blocking: true,
    message: 'JS "undefined" leaked into C# code — missing field in schema action or template',
    custom: function(code) {
      var issues = [];
      var stripped = code
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/"(?:[^"\\]|\\.)*"/g, '""');
      var re = /\bundefined\b/g;
      var m;
      while ((m = re.exec(stripped)) !== null) {
        var lineNum = code.substring(0, m.index).split('\n').length;
        var lineText = code.split('\n')[lineNum - 1] || '';
        issues.push({ line: lineNum, text: lineText.trim() });
      }
      return issues;
    },
  },
  { id: 'setscale-wrong-params', pattern: null, blocking: true,
    message: 'SetScale() called with wrong number of parameters — use SetScale(obj, x, y, z) or SetScale(obj, uniform)',
    custom: function(code) {
      var issues = [];
      var stripped = code
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/"(?:[^"\\]|\\.)*"/g, '""');
      var re = /\bSetScale\s*\(([^)]*)\)/g;
      var m;
      while ((m = re.exec(stripped)) !== null) {
        if (m[0].indexOf('void SetScale') >= 0) continue;
        var lineText = code.split('\n')[(code.substring(0, m.index).split('\n').length) - 1] || '';
        if (lineText.indexOf('void SetScale') >= 0) continue;
        var args = m[1].split(',');
        if (args.length !== 2 && args.length !== 4) {
          var lineNum = code.substring(0, m.index).split('\n').length;
          issues.push({ line: lineNum, text: 'SetScale has ' + args.length + ' args, expected 2 (obj,uniform) or 4 (obj,x,y,z): ' + lineText.trim() });
        }
      }
      return issues;
    },
  },
  // --- v7: Luna official docs distilled rules (2026-04-18) ---
  { id: 'sbyte-type', pattern: /\bSByte\b|\bsbyte\b/g, blocking: true, message: 'SByte causes SystemInvalidCastException in Luna — use int instead' },
  { id: 'navmesh-usage', pattern: /\bNavMesh\b|\bNavMeshAgent\b|\bNavMeshPath\b/g, blocking: true, message: 'NavMesh unsupported in Luna — use manual movement or node-based pathfinding' },
  { id: 'js-class-name-conflict', pattern: null, blocking: true,
    message: 'Class name conflicts with JavaScript global — will override browser built-in and crash at runtime',
    custom: function(code) {
      var issues = [];
      var conflicts = ['Number', 'JSON', 'Math', 'Object', 'Array', 'String', 'Symbol',
        'Function', 'console', 'window', 'navigator', 'Event', 'Worker', 'Crypto'];
      var stripped = code
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/"(?:[^"\\]|\\.)*"/g, '""');
      for (var i = 0; i < conflicts.length; i++) {
        var re = new RegExp('\\bclass\\s+' + conflicts[i] + '\\b', 'g');
        var m;
        while ((m = re.exec(stripped)) !== null) {
          var lineNum = code.substring(0, m.index).split('\n').length;
          issues.push({ line: lineNum, text: 'class ' + conflicts[i] + ' overrides JavaScript global ' + conflicts[i] });
        }
      }
      return issues;
    },
  },
  { id: 'input-getkey-mouse', pattern: /Input\.GetKey\s*\(\s*KeyCode\.Mouse/g, message: 'Input.GetKey(KeyCode.Mouse0) unsupported in Luna — use Input.GetMouseButton(0)' },
  { id: 'physics2d-simulate', pattern: /Physics2D\.Simulate\s*\(/g, message: 'Physics2D.Simulate() unsupported in Luna — use Project Settings simulation mode' },
  { id: 'new-input-system', pattern: /using\s+UnityEngine\.InputSystem/g, blocking: true, message: 'New Input System unsupported in Luna — use legacy Input (Standalone Input Module)' },
  { id: 'ongui-method', pattern: /void\s+OnGUI\s*\(/g, message: 'OnGUI() unsupported in Luna — use Update loop + UI system' },
  { id: 'destructor-syntax', pattern: /~[A-Z]\w+\s*\(\s*\)/g, message: 'Destructors unsupported in Bridge.NET — remove ~TypeName()' },
  { id: 'system-math-lib', pattern: /\bSystem\.Math\b|\bUnity\.Mathematics\b/g, message: 'System.Math / Unity.Mathematics unsupported in Luna — use Mathf or MathF' },
  { id: 'scene-buildindex', pattern: /GetActiveScene\s*\(\s*\)\.buildIndex/g, message: 'SceneManager.GetActiveScene().buildIndex unsupported in Luna' },
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
          blocking: !!rule.blocking,
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
        blocking: !!rule.blocking,
      });
    }
  }

  return {
    passed: issues.length === 0,
    issues: issues,
  };
}

/**
 * Filter staticCheck issues to only blocking ones (black-screen / invisible-render rules).
 * Used by codegen stage to fail a round early when the generated code would produce
 * a dead playable. Non-blocking issues are still surfaced by review stage static-check.
 */
function getBlockingIssues(code, ctx) {
  var result = staticCheck(code, ctx);
  return result.issues.filter(function(i) { return i.blocking; });
}

module.exports = { staticCheck: staticCheck, getBlockingIssues: getBlockingIssues, RULES: RULES };
