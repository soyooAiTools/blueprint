/**
 * Static pre-check — regex-based code quality scan before LLM review
 *
 * Catches forbidden API usage that the LLM reviewers sometimes miss.
 * Returns { passed, issues[] } where each issue has { rule, line, text }.
 */

var fs = require('fs');
var path = require('path');

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

function isPurePhaseDispatcherBody(body) {
  var text = String(body || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return false;
  return /^switch\s*\(\s*(?:currentPhaseName|phaseName|targetName)\s*\)\s*\{(?:\s*case\s+"[^"]+"\s*:\s*[A-Za-z_][A-Za-z0-9_]*\s*\([^{};]*\)\s*;\s*break;\s*)+(?:default\s*:\s*(?:[A-Za-z_][A-Za-z0-9_]*\s*\([^{};]*\)\s*;\s*)?break;\s*)?\}$/.test(text);
}

function isSkeletonUpdateGameStateBody(body) {
  var text = String(body || '');
  if (text.indexOf('string json =') < 0) return false;
  var required = [
    'currentPhase',
    'completedPhases',
    'entityStates',
    'variables',
    'phaseTimestamps',
    'gameObject.name',
  ];
  for (var i = 0; i < required.length; i++) {
    if (text.indexOf(required[i]) < 0) return false;
  }
  return true;
}

function isSkeletonTryReportStuckPhaseBody(methodName, body) {
  if (methodName !== 'TryReportStuckPhase') return false;
  var text = String(body || '');
  var caseCount = (text.match(/case\s+"/g) || []).length;
  var stuckTagCount = (text.match(/__PHASE_STUCK__:/g) || []).length;
  var returnTrueCount = (text.match(/return true;/g) || []).length;
  return text.indexOf('switch (currentPhaseName)') >= 0 &&
    caseCount >= 5 &&
    stuckTagCount >= 5 &&
    returnTrueCount >= 5;
}

function nearestPreviousSwitchIsCurrentPhase(lines, caseLineIndex) {
  var depthLimit = Math.max(0, caseLineIndex - 260);
  for (var i = caseLineIndex - 1; i >= depthLimit; i--) {
    var text = String(lines[i] || '').trim();
    if (/^switch\s*\(\s*currentPhaseName\s*\)/.test(text)) return true;
    if (/^switch\s*\(/.test(text)) return false;
  }
  return false;
}

// `blocking: true` — these rules cause black-screen / invisible render at runtime.
// The codegen stage treats them as blocking (fail the round + inject feedback)
// instead of letting the generation advance to review. Rationale (2026-04-15 bqh33t
// post-mortem): when the LLM reviewer is unavailable/silently passing and visual-check
// is broken, a single GFM_Create.Obj() call ships black-screen code all the way to
// CUA. Catching these in codegen stops the damage 3 stages earlier.
var RULES = [
  { id: 'setactive', pattern: /\.SetActive\s*\(/g, blocking: true, message: 'SetActive() forbidden in Luna — use position=(0,-999,0) to hide' },
  { id: 'camera-main', pattern: /Camera\.main(?!\s*;?\s*\/\/\s*(?:(?:说明：)?ok|正常))/g, blocking: true, message: 'Camera.main forbidden — use skeleton\'s mainCam variable' },
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
  { id: 'builtin-resource', pattern: /Resources\s*\.\s*GetBuiltinResource\s*\(/g, blocking: true, message: 'Resources.GetBuiltinResource() not implemented in Luna — use Resources.Load<Font>("DefaultFont") or GFM_UI.CreateText (font handled internally)' },
  { id: 'chained-addcomponent-text', pattern: /new\s+GameObject\s*\([^)]*\)\s*\.\s*AddComponent\s*<\s*Text\s*>\s*\(\s*\)/g, blocking: true, message: '链式 new GameObject(...).AddComponent<Text>() 会在 Luna 返回 null → 下一行 Text.font/.text 赋值崩溃。改为 new GameObject(name)，先确保 RectTransform，再 AddComponent(typeof(Text)) 并用 object.ReferenceEquals 判空' },
  { id: 'ctor-text-component-list', pattern: /new\s+GameObject\s*\((?:[^;]*?)typeof\s*\(\s*RectTransform\s*\)(?:[^;]*?)typeof\s*\(\s*Text\s*\)(?:[^;]*?)\)/g, blocking: true, message: 'Luna 中 GameObject 构造器组件列表可能不会正确初始化 UI.Text，后续 Text.font 会原生 null 崩溃。改为 new GameObject(name)，先确保 RectTransform，再 AddComponent(typeof(Text)) 并用 object.ReferenceEquals 判空' },
  { id: 'text-style-direct-assignment', pattern: null, blocking: true,
    message: '不要直接写 Text.font/fontSize/alignment/overflow 等样式属性；Luna 的 UI.Text backing element 可能未初始化，会在 ApplyFontDataChanges 中崩溃。使用 GFM_UI.CreateText/CreateButton 或只更新 .text。',
    custom: function(code, ctx) {
      var fileName = (ctx && ctx.filename) || '';
      if (/(?:^|\/)(GFM_UI|GFM_Tools)\.cs$/.test(fileName)) return [];
      var stripped = code
        .replace(/\/\*[\s\S]*?\*\//g, function(m) { return m.replace(/[^\n]/g, ' '); })
        .replace(/\/\/[^\n]*/g, function(m) { return ' '.repeat(m.length); })
        .replace(/"(?:[^"\\]|\\.)*"/g, function(m) { return '"' + ' '.repeat(Math.max(0, m.length - 2)) + '"'; });
      var issues = [];
      var re = /\.(font|fontSize|fontStyle|alignment|horizontalOverflow|verticalOverflow|lineSpacing)\s*=/g;
      var m;
      while ((m = re.exec(stripped)) !== null) {
        var lineNum = code.substring(0, m.index).split('\n').length;
        var lineText = code.split('\n')[lineNum - 1] || '';
        issues.push({ line: lineNum, text: lineText.trim() });
      }
      return issues;
    },
  },
  { id: 'chained-addcomponent-image', pattern: /new\s+GameObject\s*\([^)]*\)\s*\.\s*AddComponent\s*<\s*Image\s*>\s*\(\s*\)/g, blocking: true, message: '链式 new GameObject(...).AddComponent<Image>() 会在 Luna 返回 null。改为 new GameObject(name, typeof(RectTransform), typeof(Image)) 再 GetComponent<Image>()' },
  { id: 'gfm-tools', pattern: /GFM_Tools\./g, message: 'GFM_Tools does not exist — use GFM_Create, GFM_UI, GFM_Utils, etc.' },
  { id: 'coroutine', pattern: /StartCoroutine\s*\(/g, message: 'Coroutines forbidden in Luna — use Update + timer' },
  { id: 'async-await', pattern: /\basync\b|\bawait\b/g, message: 'async/await forbidden in Luna — use Update + timer' },
  { id: 'linq', pattern: /using\s+System\.Linq/g, message: 'System.Linq forbidden in Luna (Bridge.NET)' },
  { id: 'list-generic', pattern: /\bList<[^>]+>/g, message: 'List<T> forbidden in Luna — use arrays' },
  { id: 'dict-generic', pattern: /\bDictionary<[^>]+>/g, message: 'Dictionary<K,V> forbidden in Luna — use arrays' },
  { id: 'set-parent', pattern: /\.SetParent\s*\(/g, message: 'SetParent() forbidden in Luna' },
  { id: 'transform-parent', pattern: /\.parent\s*=/g, message: 'transform.parent assignment forbidden in Luna' },
  { id: 'find-object-of-type', pattern: /\bFindObjectOfType\s*(?:<|\()/g, blocking: true, message: 'FindObjectOfType() forbidden in gameplay code — use skeleton references, never runtime scene scans' },
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
  { id: 'new-material', pattern: /new\s+Material\s*\(/g, blocking: true, message: 'new Material() not supported in Luna — pool objects have pre-baked colors, do NOT create materials' },
  // 2026-04-21: InitMaterialFromScene() calls from user code. The helper lives
  // in GFM_Create.cs but pool objects already ship with pre-baked colors, so
  // calling it is obsolete and was flagged as a hard Codex review violation on
  // w7113b (太空捡垃圾, 2026-04-20 10:41→18:24 critical/warning every round).
  // Blocking at static-check short-circuits the 6-round review burn.
  { id: 'forbidden-init-material-from-scene', pattern: null, blocking: true,
    message: 'GFM_Create.InitMaterialFromScene() is obsolete — pool objects ship with pre-baked colors. Remove the call.',
    custom: function(code, ctx) {
      var fileName = (ctx && ctx.filename) || '';
      // The helper's own declaration site is the only legitimate place — skip
      // it so we don't flag the canonical lib file.
      if (/GFM_Create\.cs$/.test(fileName)) return [];
      var issues = [];
      var stripped = code
        .replace(/\/\*[\s\S]*?\*\//g, function(m) { return m.replace(/[^\n]/g, ' '); })
        .replace(/\/\/[^\n]*/g, function(m) { return ' '.repeat(m.length); })
        .replace(/"(?:[^"\\]|\\.)*"/g, function(m) { return '"' + ' '.repeat(Math.max(0, m.length - 2)) + '"'; });
      var re = /\bGFM_Create\s*\.\s*InitMaterialFromScene\s*\(/g;
      var m;
      while ((m = re.exec(stripped)) !== null) {
        var lineNum = code.substring(0, m.index).split('\n').length;
        issues.push({ line: lineNum, text: 'GFM_Create.InitMaterialFromScene() — pool colors are pre-baked, remove this call' });
      }
      return issues;
    },
  },
  // 2026-04-21: Runtime UI creation via GFM_UI.CreateCanvas / GFM_UI.CreateText
  // in gameplay flow. Skeleton pre-creates uiCanvas / guideText / scoreText
  // etc. — creating MORE at runtime is a Codex critical warning on every recent
  // w7113b round. Allow calls inside InitializeGame / Awake / Start (skeleton
  // bootstrap); block inside CheckEventRules / OnAutoPlayArrive / Update /
  // phase handlers.
  { id: 'forbidden-runtime-ui-creation', pattern: null, blocking: true,
    message: 'GFM_UI.Create{Canvas,Text} in gameplay flow — reuse skeleton-provided uiCanvas / guideText / scoreText refs.',
    custom: function(code, ctx) {
      var fileName = (ctx && ctx.filename) || '';
      // Canonical/Manager lib files are allowed to create UI at init time.
      if (/(?:^|\/)(GFM_UI|GFM_UIManager)\.cs$/.test(fileName)) return [];
      var issues = [];
      var stripped = code
        .replace(/\/\*[\s\S]*?\*\//g, function(m) { return m.replace(/[^\n]/g, ' '); })
        .replace(/\/\/[^\n]*/g, function(m) { return ' '.repeat(m.length); })
        .replace(/"(?:[^"\\]|\\.)*"/g, function(m) { return '"' + ' '.repeat(Math.max(0, m.length - 2)) + '"'; });
      var gameplayMethods = ['CheckEventRules', 'OnAutoPlayArrive', 'Update', 'LateUpdate', 'FixedUpdate', 'ShowFloatingText', 'UpdateGameState'];
      for (var mi = 0; mi < gameplayMethods.length; mi++) {
        var name = gameplayMethods[mi];
        var sigRe = new RegExp('(?:void|\\w+)\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{', 'g');
        var sm;
        while ((sm = sigRe.exec(stripped)) !== null) {
          var start = sm.index + sm[0].length;
          var depth = 1, end = start;
          while (end < stripped.length && depth > 0) {
            var ch = stripped[end];
            if (ch === '{') depth++;
            else if (ch === '}') { depth--; if (depth === 0) break; }
            end++;
          }
          if (depth !== 0) continue;
          var body = stripped.substring(start, end);
          var bodyStartLine = stripped.substring(0, start).split('\n').length;
          var callRe = /\bGFM_UI\s*\.\s*(CreateCanvas|CreateText|CreateImage|AddWorldLabel)\s*\(/g;
          var cm;
          while ((cm = callRe.exec(body)) !== null) {
            var lineInBody = body.substring(0, cm.index).split('\n').length - 1;
            issues.push({ line: bodyStartLine + lineInBody, text: 'GFM_UI.' + cm[1] + '() inside ' + name + '() — reuse skeleton UI refs (uiCanvas/guideText/scoreText), do not create at runtime' });
          }
        }
      }
      return issues;
    },
  },
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
  { id: 'autoplay-gate-removed', pattern: null, message: 'AutoPlay 12s gate block was removed — each shot must wait 12s in autoPlay mode', custom: function(code) {
    // 2026-04-20: unified gate is now `phaseTimer >= (_autoPlayMode ? 12f : Nf)`
    // in CheckEventRules. Earlier form `phaseTimer < 12f` is gone. Detect by checking
    // for the ternary pattern OR the legacy form (both satisfy the "gate exists" intent).
    if (code.indexOf('_autoPlayMode') < 0) return [];
    if (!/\bvoid\s+CheckEventRules\s*\(/.test(code) && code.indexOf('AUTO_PLAY_PHASE_DURATION') < 0) return [];
    var hasUnified = /_autoPlayMode\s*\?\s*12f\b/.test(code);
    var hasLegacy = code.indexOf('phaseTimer < 12f') >= 0;
    if (!hasUnified && !hasLegacy) {
      return [{ line: 1, text: 'Missing autoPlay phaseTimer gate — expected `phaseTimer >= (_autoPlayMode ? 12f : Nf)` in CheckEventRules' }];
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
  // 2026-04-21: review fix-loop burned repeatedly on the same terminal-flow bug
  // across w7113b / s6ae56: ShowCTA() called before GameEnded(), ShowCTA()
  // itself calling GameEnded(), or ShowCTA() invoked early from Update().
  // These are deterministic structure bugs, so block them before LLM review.
  { id: 'showcta-must-not-call-gameended', pattern: null, blocking: true,
    message: 'ShowCTA() must only perform CTA installation. Do not call Luna.Unity.LifeCycle.GameEnded() inside ShowCTA().',
    custom: function(code) {
      var issues = [];
      var stripped = code
        .replace(/\/\*[\s\S]*?\*\//g, function(m) { return m.replace(/[^\n]/g, ' '); })
        .replace(/\/\/[^\n]*/g, function(m) { return ' '.repeat(m.length); })
        .replace(/"(?:[^"\\]|\\.)*"/g, function(m) { return '"' + ' '.repeat(Math.max(0, m.length - 2)) + '"'; });
      var sigMatch = stripped.match(/void\s+ShowCTA\s*\(\s*\)\s*\{/);
      if (!sigMatch) return [];
      var start = sigMatch.index + sigMatch[0].length;
      var depth = 1, end = start;
      while (end < stripped.length && depth > 0) {
        var ch = stripped[end];
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) break; }
        end++;
      }
      if (depth !== 0) return [];
      var body = stripped.substring(start, end);
      var gameEndedIdx = body.indexOf('Luna.Unity.LifeCycle.GameEnded');
      if (gameEndedIdx >= 0) {
        var lineNum = code.substring(0, start + gameEndedIdx).split('\n').length;
        issues.push({ line: lineNum, text: 'ShowCTA() calls Luna.Unity.LifeCycle.GameEnded() — end flow must call GameEnded() before ShowCTA(), not inside it' });
      }
      return issues;
    },
  },
  { id: 'showcta-early-call-forbidden', pattern: null, blocking: true,
    message: 'ShowCTA() must not be called from Update()/OnAutoPlayArrive()/phase click handlers before the dedicated game-end block.',
    custom: function(code) {
      var issues = [];
      var stripped = code
        .replace(/\/\*[\s\S]*?\*\//g, function(m) { return m.replace(/[^\n]/g, ' '); })
        .replace(/\/\/[^\n]*/g, function(m) { return ' '.repeat(m.length); })
        .replace(/"(?:[^"\\]|\\.)*"/g, function(m) { return '"' + ' '.repeat(Math.max(0, m.length - 2)) + '"'; });
      var gameplayMethods = ['Update', 'OnAutoPlayArrive'];
      for (var mi = 0; mi < gameplayMethods.length; mi++) {
        var name = gameplayMethods[mi];
        var sigRe = new RegExp('(?:void|\\w+)\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{', 'g');
        var sm;
        while ((sm = sigRe.exec(stripped)) !== null) {
          var start = sm.index + sm[0].length;
          var depth = 1, end = start;
          while (end < stripped.length && depth > 0) {
            var ch = stripped[end];
            if (ch === '{') depth++;
            else if (ch === '}') { depth--; if (depth === 0) break; }
            end++;
          }
          if (depth !== 0) continue;
          var body = stripped.substring(start, end);
          var callRe = /\bShowCTA\s*\(/g;
          var cm;
          while ((cm = callRe.exec(body)) !== null) {
            var lineInBody = body.substring(0, cm.index).split('\n').length - 1;
            issues.push({ line: stripped.substring(0, start).split('\n').length + lineInBody, text: 'ShowCTA() called inside ' + name + '() — only the final game-end block may invoke CTA installation' });
          }
        }
      }
      return issues;
    },
  },
  { id: 'gameended-before-showcta', pattern: null, blocking: true,
    message: 'Final game-end block must call Luna.Unity.LifeCycle.GameEnded() before ShowCTA(), and must not set gameEnded=true first.',
    custom: function(code) {
      var issues = [];
      var stripped = code
        .replace(/\/\*[\s\S]*?\*\//g, function(m) { return m.replace(/[^\n]/g, ' '); })
        .replace(/\/\/[^\n]*/g, function(m) { return ' '.repeat(m.length); })
        .replace(/"(?:[^"\\]|\\.)*"/g, function(m) { return '"' + ' '.repeat(Math.max(0, m.length - 2)) + '"'; });
      var sigMatch = stripped.match(/void\s+CheckEventRules\s*\([^)]*\)\s*\{/);
      if (!sigMatch) return [];
      var start = sigMatch.index + sigMatch[0].length;
      var depth = 1, end = start;
      while (end < stripped.length && depth > 0) {
        var ch = stripped[end];
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) break; }
        end++;
      }
      if (depth !== 0) return [];
      var body = stripped.substring(start, end);
      var showIdx = body.indexOf('ShowCTA(');
      if (showIdx < 0) return [];
      var endIdx = body.indexOf('Luna.Unity.LifeCycle.GameEnded');
      var gameEndedFlagIdx = body.indexOf('gameEnded = true');
      if (endIdx < 0 || endIdx > showIdx) {
        var badLine = code.substring(0, start + showIdx).split('\n').length;
        issues.push({ line: badLine, text: 'CheckEventRules() calls ShowCTA() before Luna.Unity.LifeCycle.GameEnded() — terminal flow must be GameEnded() then ShowCTA()' });
      }
      if (gameEndedFlagIdx >= 0 && (endIdx < 0 || gameEndedFlagIdx < endIdx || gameEndedFlagIdx < showIdx)) {
        var flagLine = code.substring(0, start + gameEndedFlagIdx).split('\n').length;
        issues.push({ line: flagLine, text: 'gameEnded = true is set before terminal flow finishes — call GameEnded(), then ShowCTA(), then lock gameEnded' });
      }
      return issues;
    },
  },
  { id: 'cta-phase-requires-real-click-gate', pattern: null, blocking: true,
    message: 'Final CTA/gameEnd transition cannot rely on EntityAdvanced(CTAButton, snap) alone — require a real CTA click/input flag in the game-end gate.',
    custom: function(code, ctx) {
      var issues = [];
      var blueprint = ctx && ctx.blueprint;
      var specs = blueprint && Array.isArray(blueprint.specs) ? blueprint.specs : null;
      if (!specs || specs.length === 0) return issues;
      var lastSpec = specs[specs.length - 1] || {};
      var phaseId = String(lastSpec.phaseId || 'phase').replace(/[^a-zA-Z0-9]/g, '');
      var interactions = Array.isArray(lastSpec.requiredInteractions) ? lastSpec.requiredInteractions : [];
      var cond = String(lastSpec.triggerNext && lastSpec.triggerNext.condition || '');
      var isCtaPhase = interactions.some(function(x) { return /^(click|tap):/i.test(String(x || '')); }) ||
        /cta|install|download/i.test(String(lastSpec.phaseId || '') + ' ' + String(lastSpec.phaseName || '') + ' ' + cond);
      if (!isCtaPhase) return issues;

      var stripped = code
        .replace(/\/\*[\s\S]*?\*\//g, function(m) { return m.replace(/[^\n]/g, ' '); })
        .replace(/\/\/[^\n]*/g, function(m) { return ' '.repeat(m.length); })
        .replace(/"(?:[^"\\]|\\.)*"/g, function(m) { return '"' + ' '.repeat(Math.max(0, m.length - 2)) + '"'; });

      var sigMatch = stripped.match(/void\s+CheckEventRules\s*\([^)]*\)\s*\{/);
      if (!sigMatch) return issues;
      var start = sigMatch.index + sigMatch[0].length;
      var depth = 1, end = start;
      while (end < stripped.length && depth > 0) {
        var ch = stripped[end];
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) break; }
        end++;
      }
      if (depth !== 0) return issues;
      var body = stripped.substring(start, end);

      var gateIdx = body.indexOf('AddCompletedPhase("gameEnd")');
      if (gateIdx < 0) gateIdx = body.indexOf('ShowCTA(');
      if (gateIdx < 0) return issues;

      var windowStart = Math.max(0, gateIdx - 500);
      var windowEnd = Math.min(body.length, gateIdx + 300);
      var gateWindow = body.substring(windowStart, windowEnd);

      var usesCtaEntityOnly = /EntityAdvanced\s*\(\s*CTAButton\s*,/.test(gateWindow);
      var hasRealClickFlag = new RegExp(
        '\\b(' + phaseId + 'InteractionDone|' + phaseId + 'PlayerActed|CTAButtonDone)\\b'
      ).test(gateWindow);

      if (usesCtaEntityOnly && !hasRealClickFlag) {
        var lineNum = code.substring(0, start + gateIdx).split('\n').length;
        issues.push({
          line: lineNum,
          text: 'gameEnd gate relies on EntityAdvanced(CTAButton, _snap_CTAButtonPos) without a real CTA click/input flag; require ' + phaseId + 'InteractionDone / ' + phaseId + 'PlayerActed / CTAButtonDone',
        });
      }
      return issues;
    },
  },
  { id: 'phase-gate-shortcircuits-with-interaction-flags', pattern: null, blocking: true,
    message: 'Non-final phase gate must not use InteractionDone/PlayerActed/xxxDone as an OR shortcut — require real world-state progression, not flag-only bypass.',
    custom: function(code, ctx) {
      var issues = [];
      var blueprint = ctx && ctx.blueprint;
      var specs = blueprint && Array.isArray(blueprint.specs) ? blueprint.specs : null;
      if (!specs || specs.length === 0) return issues;
      var stripped = code
        .replace(/\/\*[\s\S]*?\*\//g, function(m) { return m.replace(/[^\n]/g, ' '); })
        .replace(/\/\/[^\n]*/g, function(m) { return ' '.repeat(m.length); })
        .replace(/"(?:[^"\\]|\\.)*"/g, function(m) { return '"' + ' '.repeat(Math.max(0, m.length - 2)) + '"'; });
      var re = /if\s*\(\s*!\s*ruleTriggered\s*\[\s*(\d+)\s*\]/g;
      var m;
      while ((m = re.exec(stripped)) !== null) {
        var ruleIdx = parseInt(m[1], 10);
        // Skip first warmup gate and final gameEnd gate.
        if (!(ruleIdx > 0 && ruleIdx < specs.length)) continue;
        var start = m.index + m[0].length;
        var depth = 1, end = start;
        while (end < stripped.length && depth > 0) {
          var ch = stripped[end];
          if (ch === '(') depth++;
          else if (ch === ')') { depth--; if (depth === 0) break; }
          end++;
        }
        if (depth !== 0) continue;
        var cond = stripped.substring(start, end);
        if (cond.indexOf('||') < 0) continue;
        if (!/\b(\w+(?:InteractionDone|PlayerActed|Done))\b/.test(cond)) continue;
        var lineNum = code.substring(0, m.index).split('\n').length;
        issues.push({
          line: lineNum,
          text: 'ruleTriggered[' + ruleIdx + '] gate uses OR-shortcut with interaction flags (' +
            cond.replace(/\s+/g, ' ').trim().slice(0, 140) + ') — require real EntityAdvanced(...) progression instead',
        });
      }
      return issues;
    },
  },
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
  // 2026-04-20: Phase gate now binds to EntityAdvanced(GameObject, snapshot) which reads
  // real transform.position. Direct variable writes (xxxState=N, xxxDone=true,
  // xxxPlayerActed=true) inside OnAutoPlayArrive previously "faked" phase progression —
  // CUA saw the variable flip and let the round pass, even when nothing moved on screen
  // (82frm7/ju5dfu postmortem). Conditions are now observable-only. Any such assignment
  // inside OnAutoPlayArrive is a block-level violation — AI must use PlaceObj / HideObj /
  // transform.position to produce a real scene change.
  { id: 'autoplay-direct-assign-forbidden', pattern: null, blocking: true,
    message: 'Direct variable assignment in OnAutoPlayArrive — phase gate binds to EntityAdvanced(GameObject). Use PlaceObj/HideObj/transform.position to move the entity instead.',
    custom: function(code) {
      var issues = [];
      // Length-preserving strip — keeps offsets aligned with `code` so line numbers
      // computed from `stripped` are valid in `code` too. Replaces comment/string
      // contents with spaces and preserves newlines.
      var stripped = code
        .replace(/\/\*[\s\S]*?\*\//g, function(m) { return m.replace(/[^\n]/g, ' '); })
        .replace(/\/\/[^\n]*/g, function(m) { return ' '.repeat(m.length); })
        .replace(/"(?:[^"\\]|\\.)*"/g, function(m) { return '"' + ' '.repeat(Math.max(0, m.length - 2)) + '"'; });
      var sigMatch = stripped.match(/void\s+OnAutoPlayArrive\s*\(\s*string\s+\w+\s*\)\s*\{/);
      if (!sigMatch) return [];
      var start = sigMatch.index + sigMatch[0].length;
      var depth = 1, end = start;
      while (end < stripped.length && depth > 0) {
        var ch = stripped[end];
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) break; }
        end++;
      }
      if (depth !== 0) return [];
      var body = stripped.substring(start, end);
      var bodyStartLine = stripped.substring(0, start).split('\n').length;
      var patterns = [
        { re: /\b(\w+State)\s*=\s*\d+/g, label: 'State assignment' },
        { re: /\b(\w*Done)\s*=\s*true\b/g, label: 'Done flag assignment' },
        { re: /\b(\w*PlayerActed)\s*=\s*true\b/g, label: 'PlayerActed assignment' },
      ];
      for (var pi = 0; pi < patterns.length; pi++) {
        var p = patterns[pi];
        var bm;
        p.re.lastIndex = 0;
        while ((bm = p.re.exec(body)) !== null) {
          var flagName = bm[1];
          // Whitelist: gameEnded / autoPlayChecked are not interaction flags
          if (flagName === 'gameEnded' || flagName === 'autoPlayChecked') continue;
          var lineInBody = body.substring(0, bm.index).split('\n').length - 1;
          issues.push({
            line: bodyStartLine + lineInBody,
            text: p.label + ' "' + bm[0] + '" inside OnAutoPlayArrive — replace with PlaceObj/HideObj/transform.position',
          });
        }
      }
      return issues;
    },
  },
  // 2026-04-21: Phase-gate condition literal `false`. AI sometimes degenerates
  // the phase-exit condition to `if (false)` or `&& false &&` — the phase is
  // unreachable and CUA burns its full budget on visual_freeze. Walk every
  // `if (!ruleTriggered[N]` block and reject literal `false` inside the gate.
  { id: 'phase-condition-false-literal', pattern: null, blocking: true,
    message: 'Phase trigger gate contains literal `false` — phase will never fire. Remove `false` and bind to EntityAdvanced(GameObject, snap).',
    custom: function(code) {
      var issues = [];
      var stripped = code
        .replace(/\/\*[\s\S]*?\*\//g, function(m) { return m.replace(/[^\n]/g, ' '); })
        .replace(/\/\/[^\n]*/g, function(m) { return ' '.repeat(m.length); })
        .replace(/"(?:[^"\\]|\\.)*"/g, function(m) { return '"' + ' '.repeat(Math.max(0, m.length - 2)) + '"'; });
      var re = /if\s*\(\s*!\s*ruleTriggered\s*\[\s*(\d+)\s*\]/g;
      var m;
      while ((m = re.exec(stripped)) !== null) {
        var start = m.index + m[0].length;
        var depth = 1, end = start;
        while (end < stripped.length && depth > 0) {
          var ch = stripped[end];
          if (ch === '(') depth++;
          else if (ch === ')') { depth--; if (depth === 0) break; }
          end++;
        }
        if (depth !== 0) continue;
        var cond = stripped.substring(start, end);
        if (/(^|[\s(&|!])false([\s)&|]|$)/.test(cond)) {
          var lineNum = code.substring(0, m.index).split('\n').length;
          issues.push({ line: lineNum, text: 'ruleTriggered[' + m[1] + '] gate contains literal `false` — phase never fires' });
        }
      }
      return issues;
    },
  },
  // 2026-04-21: Phase-gate references an entity that is never placed or moved.
  // AI sometimes writes `EntityAdvanced(FooBar, _snap_FooBarPos)` where FooBar
  // has no PlaceObj/HideObj/transform.position assignment anywhere in the file
  // — the gate can never flip and CUA spins on visual_freeze. Require every
  // entity used in EntityAdvanced() to have at least one write somewhere.
  { id: 'phase-entity-unbound', pattern: null, blocking: true,
    message: 'Phase gate references entity with no PlaceObj/HideObj/transform.position anywhere — gate cannot flip. Move the entity in the preceding phase body.',
    custom: function(code, ctx) {
      var issues = [];
      var stripped = code
        .replace(/\/\*[\s\S]*?\*\//g, function(m) { return m.replace(/[^\n]/g, ' '); })
        .replace(/\/\/[^\n]*/g, function(m) { return ' '.repeat(m.length); })
        .replace(/"(?:[^"\\]|\\.)*"/g, function(m) { return '"' + ' '.repeat(Math.max(0, m.length - 2)) + '"'; });
      var sources = [stripped];
      if (ctx && ctx.extraFiles) {
        var keys = Object.keys(ctx.extraFiles);
        for (var i = 0; i < keys.length; i++) {
          var src = ctx.extraFiles[keys[i]];
          if (typeof src === 'string') sources.push(src);
        }
      }
      var allWrites = {};
      var writeRes = [
        /\bPlaceObj\s*\(\s*([A-Za-z_]\w*)/g,
        /\bHideObj\s*\(\s*([A-Za-z_]\w*)/g,
        /\bSetScale\s*\(\s*([A-Za-z_]\w*)/g,
        /\b([A-Za-z_]\w*)\s*\.\s*transform\s*\.\s*position\s*=/g,
        /\b([A-Za-z_]\w*)\s*=\s*Instantiate\s*\(/g,
        /\b([A-Za-z_]\w*)\s*=\s*GameObject\s*\.\s*Find\s*\(/g,
      ];
      for (var si = 0; si < sources.length; si++) {
        for (var ri = 0; ri < writeRes.length; ri++) {
          var wre = new RegExp(writeRes[ri].source, 'g');
          var wm;
          while ((wm = wre.exec(sources[si])) !== null) {
            allWrites[wm[1]] = true;
          }
        }
      }
      var eaRe = /\bEntityAdvanced\s*\(\s*([A-Za-z_]\w*)\s*,/g;
      var seen = {};
      var em;
      while ((em = eaRe.exec(stripped)) !== null) {
        var name = em[1];
        if (allWrites[name]) continue;
        if (seen[name]) continue;
        seen[name] = true;
        var lineNum = code.substring(0, em.index).split('\n').length;
        issues.push({ line: lineNum, text: 'EntityAdvanced(' + name + ', ...) — `' + name + '` has no PlaceObj/HideObj/transform.position anywhere; gate unreachable' });
      }
      return issues;
    },
  },
  // 2026-04-21: Phase-scoped movement check. `phase-entity-unbound` only ensures
  // X has *some* write anywhere; but if X is only written at phase entry (TODO_PHASE_*_INIT)
  // and nowhere else (no interaction handler, no OnAutoPlayArrive case move), the
  // gate `EntityAdvanced(X, _snap_XPos)` can't flip during gameplay. Codex reviewer
  // reported this 6 rounds straight on s6ae56 / nqw7z3 (2026-04-21) and fix-loop
  // circuit-broke. This rule fires when X's ONLY moves are inside TODO_PHASE_*_INIT
  // comment-bracketed regions (phase-init-only), not runtime interaction code.
  { id: 'phase-entity-init-only', pattern: null, blocking: true,
    message: 'EntityAdvanced(X, _snap_XPos) gate cannot trigger — X is only moved inside TODO_PHASE_*_INIT blocks (phase entry). Add PlaceObj(X)/HideObj(X)/X.transform.position = ... in the matching OnAutoPlayArrive case OR a player-interaction handler.',
    custom: function(code, ctx) {
      var issues = [];
      var stripped = code
        .replace(/\/\*[\s\S]*?\*\//g, function(m) { return m.replace(/[^\n]/g, ' '); })
        .replace(/\/\/[^\n]*/g, function(m) { return ' '.repeat(m.length); })
        .replace(/"(?:[^"\\]|\\.)*"/g, function(m) { return '"' + ' '.repeat(Math.max(0, m.length - 2)) + '"'; });
      // Whitelist: player + anything moved inside MovePlayer() function body.
      var whitelist = { player: 1, Player: 1 };
      var mpMatch = stripped.match(/void\s+MovePlayer\s*\([^)]*\)\s*\{([\s\S]*?)\n\s*\}/);
      if (mpMatch) {
        var idRe = /\b([A-Za-z_]\w*)\s*\.\s*transform\s*\.\s*position/g;
        var idm;
        while ((idm = idRe.exec(mpMatch[1])) !== null) whitelist[idm[1]] = true;
      }
      // Build mask of TODO_PHASE_*_INIT_START .. TODO_PHASE_*_INIT_END regions. Moves
      // inside these regions are considered "phase-entry-only" and don't count
      // as runtime moves. We also mask the skeleton comment preamble before each
      // TODO_PHASE_*_INIT_START (the REMINDER block added to guide AI) — the
      // commentary shouldn't be treated as runtime movement anyway (we stripped
      // comments) but this keeps the intent explicit.
      var initRanges = [];
      var initRe = /\/\/\s*TODO_PHASE_\d+_INIT_START([\s\S]*?)\/\/\s*TODO_PHASE_\d+_INIT_END/g;
      // We stripped comments above — TODO_PHASE markers are still raw in `code`
      // but `stripped` overwrote them with spaces. Scan `code` to find ranges
      // then map offsets (they align: stripping preserves character positions).
      var codeInitRe = new RegExp(initRe.source, 'g');
      var irm;
      while ((irm = codeInitRe.exec(code)) !== null) {
        initRanges.push([irm.index, irm.index + irm[0].length]);
      }
      function inInit(idx) {
        for (var rr = 0; rr < initRanges.length; rr++) {
          if (idx >= initRanges[rr][0] && idx <= initRanges[rr][1]) return true;
        }
        return false;
      }
      // For each EntityAdvanced(X, _snap_XPos), require at least one move of X
      // OUTSIDE any TODO_PHASE_*_INIT block. OnAutoPlayArrive case bodies and
      // Update() hot-path moves both live outside these markers.
      var eaRe = /\bEntityAdvanced\s*\(\s*([A-Za-z_]\w*)\s*,\s*_snap_\1Pos\s*\)/g;
      var seen = {};
      var em;
      while ((em = eaRe.exec(stripped)) !== null) {
        var entName = em[1];
        if (whitelist[entName]) continue;
        if (seen[entName]) continue;
        seen[entName] = true;
        var moveRe = new RegExp(
          '\\bPlaceObj\\s*\\(\\s*' + entName + '\\b' +
          '|\\bHideObj\\s*\\(\\s*' + entName + '\\b' +
          '|\\b' + entName + '\\s*\\.\\s*transform\\s*\\.\\s*position\\s*=',
          'g'
        );
        var hasRuntimeMove = false;
        var mvm;
        while ((mvm = moveRe.exec(stripped)) !== null) {
          if (!inInit(mvm.index)) { hasRuntimeMove = true; break; }
        }
        if (!hasRuntimeMove) {
          var lineNum = code.substring(0, em.index).split('\n').length;
          issues.push({ line: lineNum, text: 'EntityAdvanced(' + entName + ', _snap_' + entName + 'Pos) — `' + entName + '` only moved inside TODO_PHASE_*_INIT (phase-entry); no runtime move in OnAutoPlayArrive / Update / interaction handler. Gate cannot flip during gameplay.' });
        }
      }
      return issues;
    },
  },
  // 2026-04-21: AddCompletedPhase rule-ID consistency. spec_phase_skipped was
  // top-3 CUA root cause (7/61 failures) — AI writes `AddCompletedPhase("X")`
  // where X doesn't match any ReportPhase/currentPhaseName in the file. Catch
  // at static-check so AI can't drift into semantic names mid-phase instead of
  // the exact spec phaseId (which ReportPhase ALWAYS uses since it's IMMUTABLE
  // skeleton boilerplate).
  { id: 'add-completed-phase-id-mismatch', pattern: null, blocking: true,
    message: 'AddCompletedPhase(id) must reference an exact spec phaseId. Use a string that also appears in ReportPhase() or currentPhaseName = "...", or a pre-phase sentinel like "gameStart".',
    custom: function(code, ctx) {
      var issues = [];
      var stripped = code
        .replace(/\/\*[\s\S]*?\*\//g, function(m) { return m.replace(/[^\n]/g, ' '); })
        .replace(/\/\/[^\n]*/g, function(m) { return ' '.repeat(m.length); });
      // Gather legitimate phase IDs from this file AND companion partial files.
      var sources = [stripped];
      if (ctx && ctx.extraFiles) {
        var eks = Object.keys(ctx.extraFiles);
        for (var ii = 0; ii < eks.length; ii++) {
          var src = ctx.extraFiles[eks[ii]];
          if (typeof src === 'string') sources.push(src);
        }
      }
      var validIds = { gameStart: true, gameEnd: true };
      var gatherRes = [
        /\bReportPhase\s*\(\s*"([^"]+)"/g,
        /\bcurrentPhaseName\s*=\s*"([^"]+)"/g,
      ];
      for (var si = 0; si < sources.length; si++) {
        for (var gi = 0; gi < gatherRes.length; gi++) {
          var gre = new RegExp(gatherRes[gi].source, 'g');
          var gm;
          while ((gm = gre.exec(sources[si])) !== null) validIds[gm[1]] = true;
        }
      }
      // Check AddCompletedPhase call sites in this file.
      var acpRe = /\bAddCompletedPhase\s*\(\s*"([^"]+)"\s*\)/g;
      var am;
      while ((am = acpRe.exec(stripped)) !== null) {
        var id = am[1];
        if (!validIds[id]) {
          var lineNum = code.substring(0, am.index).split('\n').length;
          issues.push({ line: lineNum, text: 'AddCompletedPhase("' + id + '") — id not found in any ReportPhase/currentPhaseName; likely semantic name instead of spec phaseId' });
        }
      }
      return issues;
    },
  },
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
      var mask = buildCodeMask(code);
      var calls = findInvocationCalls(code, 'SetScale', mask);
      for (var i = 0; i < calls.length; i++) {
        var call = calls[i];
        var lineNum = code.substring(0, call.index).split('\n').length;
        var lineText = code.split('\n')[lineNum - 1] || '';
        if (lineText.indexOf('void SetScale') >= 0) continue;
        var args = splitTopLevelArgs(call.argsText);
        if (args.length !== 2 && args.length !== 4) {
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
  // --- v8: Performance hot-path rules (Batch 3, 2026-04-19) ---
  // Batch 1 cleaned skeleton's own hot paths; this rule prevents AI-generated code
  // from re-introducing `new Vector3` into Update/MovePlayer/CheckEventRules/AutoPlayUpdate.
  // Each heap alloc × 60fps = measurable GC jitter in Luna's small-memory WebGL env.
  { id: 'update-new-vector-in-hot-path', pattern: null, blocking: true,
    message: 'new Vector3 in Update/MovePlayer/CheckEventRules/AutoPlayUpdate hot path — reuse a field or use struct-copy (var p = obj.transform.position; p.x = ...; obj.transform.position = p;)',
    custom: function(code, ctx) {
      if (ctx && /(?:^|\/)ScriptActivator\.cs$/.test(ctx.filename || '')) return [];
      var issues = [];
      var stripped = code
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/"(?:[^"\\]|\\.)*"/g, '""');
      var hotFns = ['Update', 'MovePlayer', 'CheckEventRules', 'AutoPlayUpdate'];
      for (var f = 0; f < hotFns.length; f++) {
        var fn = hotFns[f];
        var sigRe = new RegExp('\\b(?:void|IEnumerator)\\s+' + fn + '\\s*\\([^)]*\\)\\s*\\{');
        var sig = stripped.match(sigRe);
        if (!sig) continue;
        var start = sig.index + sig[0].length;
        var depth = 1, end = start;
        while (end < stripped.length && depth > 0) {
          var ch = stripped[end];
          if (ch === '{') depth++;
          else if (ch === '}') { depth--; if (depth === 0) break; }
          end++;
        }
        if (depth !== 0) continue;
        var body = stripped.substring(start, end);
        var re = /\bnew\s+Vector3\s*\(\s*([^)]*)\)/g;
        var m;
        while ((m = re.exec(body)) !== null) {
          var args = m[1].replace(/\s/g, '');
          // Allow new Vector3(0,0,0) — zero-alloc concept (rarely used, but legal)
          if (args === '0,0,0' || args === '' || args === '0') continue;
          var absIdx = start + m.index;
          var lineNum = code.substring(0, absIdx).split('\n').length;
          issues.push({ line: lineNum, text: 'new Vector3(' + m[1].trim() + ') inside ' + fn + '()' });
        }
      }
      return issues;
    },
  },
  { id: 'chained-if-same-var-no-else', pattern: null,
    message: 'Chained if (X == "...") on same variable without else — use else-if chain or switch for performance and readability',
    custom: function(code) {
      var issues = [];
      var stripped = code
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/"(?:[^"\\]|\\.)*"/g, '""');
      // Scan for bare "if (X == Y)" patterns with preceding non-else context
      // Strategy: match all "if (ident == ...)" and group by same-ident consecutive runs
      // where "consecutive" means no `else` token between them.
      var re = /(\belse\s+)?\bif\s*\(\s*(\w+)\s*==\s*""/g;
      var m, runs = [], cur = null;
      while ((m = re.exec(stripped)) !== null) {
        var hasElse = !!m[1];
        var ident = m[2];
        if (hasElse) { cur = null; continue; }
        if (cur && cur.ident === ident) {
          cur.count++;
          cur.lastIdx = m.index;
        } else {
          cur = { ident: ident, count: 1, firstIdx: m.index, lastIdx: m.index };
          runs.push(cur);
        }
      }
      for (var i = 0; i < runs.length; i++) {
        if (runs[i].count >= 3) {
          var lineNum = code.substring(0, runs[i].firstIdx).split('\n').length;
          issues.push({ line: lineNum, text: runs[i].count + ' consecutive bare "if (' + runs[i].ident + ' == ...)" — use else-if' });
        }
      }
      return issues;
    },
  },
  { id: 'string-concat-in-update', pattern: null,
    message: '.text string concatenation in Update hot path — assign only when value changes (if (_last != n) { text = "Score: " + n; _last = n; })',
    custom: function(code) {
      var issues = [];
      var stripped = code
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/"(?:[^"\\]|\\.)*"/g, '""');
      var hotFns = ['Update', 'MovePlayer', 'CheckEventRules', 'AutoPlayUpdate'];
      for (var f = 0; f < hotFns.length; f++) {
        var fn = hotFns[f];
        var sigRe = new RegExp('\\b(?:void|IEnumerator)\\s+' + fn + '\\s*\\([^)]*\\)\\s*\\{');
        var sig = stripped.match(sigRe);
        if (!sig) continue;
        var start = sig.index + sig[0].length;
        var depth = 1, end = start;
        while (end < stripped.length && depth > 0) {
          var ch = stripped[end];
          if (ch === '{') depth++;
          else if (ch === '}') { depth--; if (depth === 0) break; }
          end++;
        }
        if (depth !== 0) continue;
        var body = stripped.substring(start, end);
        // Match: .text = "..." + OR .text = var + OR .text = X + Y
        var re = /\.text\s*=\s*(?:""|\w+)\s*\+/g;
        var m;
        while ((m = re.exec(body)) !== null) {
          var absIdx = start + m.index;
          var lineNum = code.substring(0, absIdx).split('\n').length;
          var lineText = code.split('\n')[lineNum - 1] || '';
          issues.push({ line: lineNum, text: lineText.trim().slice(0, 120) });
        }
      }
      return issues;
    },
  },
  // partial class 一致性:extraFiles 里若有 partial class GameFlowManagerMain,
  // 主文件也必须带 partial 关键字,否则 CS0260。(2026-04-19: 打包工具+AI fix-loop 都可能引入)
  {
    id: 'partial-class-mismatch',
    pattern: null,
    blocking: true,
    message: 'partial class mismatch (CS0260): a companion file declares `partial class GameFlowManagerMain` but the main file declares it non-partial — add `partial` keyword to main class',
    custom: function(code, ctx) {
      if (!ctx || !ctx.extraFiles) return [];
      var companionHasPartial = false;
      for (var efKey in ctx.extraFiles) {
        if (!ctx.extraFiles.hasOwnProperty(efKey)) continue;
        if (efKey.indexOf('GameFlowManagerMain') < 0) continue;
        if (/\bpartial\s+class\s+GameFlowManagerMain\b/.test(ctx.extraFiles[efKey])) {
          companionHasPartial = true;
          break;
        }
      }
      if (!companionHasPartial) return [];
      // Main file must also declare `partial class GameFlowManagerMain`
      var mainDecl = /\b(public\s+)?(partial\s+)?class\s+GameFlowManagerMain\b/.exec(code);
      if (!mainDecl) return [];
      if (mainDecl[2]) return []; // already partial
      var lineNum = code.substring(0, mainDecl.index).split('\n').length;
      return [{ line: lineNum, text: (mainDecl[0] || '').trim().slice(0, 120) }];
    },
  },
  // --- v9: Codegen quality rules (2026-04-19) — spec 2026-04-19-codegen-quality-systematic ---
  // 3 blocking (structural, day 1) + 3 warning (thresholds need real-data calibration).
  //
  // Blocking 6a: enforce 5-partial split when skeleton generates companions.
  // Dormant pre-W1b: if no companion files exist yet, rule returns []. Once W1b
  // ships the 5-partial skeleton, companions appear and the rule enforces completeness.
  { id: 'partial-split-enforce', pattern: null, blocking: true,
    message: 'Partial-split incomplete — GameFlowManagerMain must have 5 companions: Flow / Input / Resource / UI / Scene',
    custom: function(code, ctx) {
      if (!ctx || !ctx.extraFiles) return [];
      var fileName = ctx && ctx.filename ? String(ctx.filename).split(/[\\/]/).pop() : '';
      if (fileName && fileName !== 'GameFlowManagerMain.cs') return [];
      var needed = ['Flow', 'Input', 'Resource', 'UI', 'Scene'];
      // Only count expected-name companions. Legacy `.Systems.cs` (pre-W1b placeholder)
      // is ignored so urbib0-style baselines don't trip the rule before W1b ships.
      var companions = Object.keys(ctx.extraFiles).filter(function(k) {
        return /GameFlowManagerMain\.(Flow|Input|Resource|UI|Scene)\.cs$/.test(k);
      });
      if (companions.length === 0) return []; // pre-W1b: rule dormant
      var missing = [];
      for (var i = 0; i < needed.length; i++) {
        var found = false;
        for (var j = 0; j < companions.length; j++) {
          if (companions[j].indexOf('.' + needed[i] + '.') >= 0) { found = true; break; }
        }
        if (!found) missing.push(needed[i]);
      }
      if (missing.length === 0) return [];
      return [{ line: 1, text: 'Missing partial companion(s): ' + missing.join(', ') }];
    },
  },
  { id: 'main-file-reintroduced-phase-logic', pattern: null, blocking: true,
    message: 'GameFlowManagerMain.cs reintroduced phase-specific logic — keep phase init / tap / autoplay / snapshot helpers in Flow.cs, not in the main file.',
    custom: function(code, ctx) {
      if (!ctx || !ctx.extraFiles) return [];
      var fileName = ctx && ctx.filename ? String(ctx.filename).split(/[\\/]/).pop() : '';
      if (fileName && fileName !== 'GameFlowManagerMain.cs') return [];
      var companions = Object.keys(ctx.extraFiles).filter(function(k) {
        return /GameFlowManagerMain\.(Flow|Input|Resource|UI|Scene)\.cs$/.test(k);
      });
      if (companions.length === 0) return [];
      var stripped = code
        .replace(/\/\*[\s\S]*?\*\//g, function(m) { return m.replace(/[^\n]/g, ' '); })
        .replace(/\/\/[^\n]*/g, function(m) { return ' '.repeat(m.length); })
        .replace(/"(?:[^"\\]|\\.)*"/g, function(m) { return '"' + ' '.repeat(Math.max(0, m.length - 2)) + '"'; });
      var patterns = [
        { re: /\bvoid\s+OnAutoPlayArrive\s*\(\s*string\s+\w+\s*\)/g, label: 'OnAutoPlayArrive() belongs in Flow.cs' },
        { re: /\bvoid\s+Phase_OnTap\s*\(\s*\)/g, label: 'Phase_OnTap() belongs in Flow.cs' },
        { re: /\bvoid\s+Phase_[A-Za-z0-9_]+_(?:Init|OnTap|OnAutoPlayArrive)\s*\(/g, label: 'Phase-specific handler belongs in Flow.cs' },
        { re: /\bvoid\s+Snapshot_[A-Za-z0-9_]+_GateEntities\s*\(/g, label: 'Phase snapshot helper belongs in Flow.cs' },
        { re: /\bvoid\s+(?:EnterPhase|FinishGame|CompletePhaseProgress|TryReportStuckPhase|SyncAutoPlayState|UpdatePhaseTimer)\s*\(/g, label: 'Shared flow helper belongs in Flow.cs' },
        { re: /TODO_PHASE_(?:\d+|[A-Za-z0-9_]+)_(?:INIT|ONTAP|ONAUTOARRIVE)_(?:START|END)/g, label: 'Phase TODO scaffold belongs in Flow.cs' },
      ];
      var issues = [];
      patterns.forEach(function(p) {
        var m;
        while ((m = p.re.exec(stripped)) !== null) {
          var lineNum = stripped.substring(0, m.index).split('\n').length;
          issues.push({ line: lineNum, text: p.label + ': ' + m[0] });
        }
      });
      return issues;
    },
  },
  { id: 'invalid-pool-find-name', pattern: null, blocking: true,
    message: 'GameObject.Find() uses a pool object name outside the approved entity→pool mapping — bind only the exact blueprint-approved pool objects.',
    custom: function(code, ctx) {
      var blueprint = ctx && ctx.blueprint;
      var entityPoolMap = blueprint && blueprint.entityPoolMap ? blueprint.entityPoolMap : null;
      if (!entityPoolMap) return [];
      var allowed = {};
      Object.keys(entityPoolMap).forEach(function(k) {
        if (entityPoolMap[k]) allowed[String(entityPoolMap[k])] = true;
      });
      if (Object.keys(allowed).length === 0) return [];
      var stripped = code
        .replace(/\/\*[\s\S]*?\*\//g, function(m) { return m.replace(/[^\n]/g, ' '); })
        .replace(/\/\/[^\n]*/g, function(m) { return ' '.repeat(m.length); });
      var issues = [];
      var re = /\bGameObject\.Find\s*\(\s*"([^"\n]+)"\s*\)/g;
      var m;
      while ((m = re.exec(stripped)) !== null) {
        var poolName = String(m[1] || '');
        if (!/^__Pool_/.test(poolName)) continue;
        if (allowed[poolName]) continue;
        var lineNum = code.substring(0, m.index).split('\n').length;
        issues.push({
          line: lineNum,
          text: 'GameObject.Find("' + poolName + '") is outside approved entityPoolMap (' + Object.keys(allowed).slice(0, 4).map(function(name) { return name; }).join(', ') + (Object.keys(allowed).length > 4 ? ', ...' : '') + ')',
        });
      }
      return issues;
    },
  },
  { id: 'canonical-entity-find-forbidden', pattern: null, blocking: true,
    message: 'GameObject.Find("__Pool_*") is forbidden in GameFlowManagerMain when entity bindings are canonical — use RegisterEntityBindings()/GameSceneCtrl once, then reuse fields.',
    custom: function(code, ctx) {
      var fileName = ctx && ctx.filename ? String(ctx.filename).split(/[\\/]/).pop() : '';
      if (!/^GameFlowManagerMain(?:\.[A-Za-z]+)?\.cs$/.test(fileName)) return [];
      var hasBindingTable = code.indexOf('_entityBindingIds') >= 0 || code.indexOf('RegisterEntityBindings()') >= 0;
      if (!hasBindingTable && ctx && ctx.extraFiles) {
        Object.keys(ctx.extraFiles).forEach(function(key) {
          var src = ctx.extraFiles[key] || '';
          if (src.indexOf('_entityBindingIds') >= 0 || src.indexOf('RegisterEntityBindings()') >= 0) hasBindingTable = true;
        });
      }
      if (!hasBindingTable) return [];
      var stripped = code
        .replace(/\/\*[\s\S]*?\*\//g, function(m) { return m.replace(/[^\n]/g, ' '); })
        .replace(/\/\/[^\n]*/g, function(m) { return ' '.repeat(m.length); });
      var issues = [];
      var re = /\bGameObject\.Find\s*\(\s*"(__Pool_[^"\n]+)"\s*\)/g;
      var m;
      while ((m = re.exec(stripped)) !== null) {
        issues.push({
          line: code.substring(0, m.index).split('\n').length,
          text: 'Direct pool lookup ' + m[0] + ' splits entity ownership; add it to _entityBindingIds/_entityBindingPools instead.',
        });
      }
      return issues;
    },
  },
  { id: 'autoplay-fallback-in-ontap', pattern: null, blocking: true,
    message: 'AutoPlay fallback leaked into Phase_*_OnTap(); fallback belongs only in Phase_*_OnAutoPlayArrive().',
    custom: function(code, ctx) {
      var fileName = ctx && ctx.filename ? String(ctx.filename).split(/[\\/]/).pop() : '';
      if (fileName && fileName.indexOf('GameFlowManagerMain') !== 0) return [];
      var stripped = code
        .replace(/\/\*[\s\S]*?\*\//g, function(m) { return m.replace(/[^\n]/g, ' '); })
        .replace(/\/\/[^\n]*/g, function(m) { return ' '.repeat(m.length); })
        .replace(/"(?:[^"\\]|\\.)*"/g, function(m) { return '"' + ' '.repeat(Math.max(0, m.length - 2)) + '"'; });
      var issues = [];
      var sigRe = /\bvoid\s+(Phase_[A-Za-z0-9_]+_OnTap)\s*\(\s*\)\s*\{/g;
      var m;
      while ((m = sigRe.exec(stripped)) !== null) {
        var start = m.index + m[0].length;
        var depth = 1;
        var end = start;
        while (end < stripped.length && depth > 0) {
          var ch = stripped[end];
          if (ch === '{') depth++;
          else if (ch === '}') { depth--; if (depth === 0) break; }
          end++;
        }
        if (depth !== 0) continue;
        var body = stripped.substring(start, end);
        if (/\bShouldRunAutoPlayFallback\s*\(/.test(body) || /\bAUTO_PLAY_PHASE_DURATION\b/.test(body)) {
          issues.push({
            line: stripped.substring(0, m.index).split('\n').length,
            text: m[1] + ' contains AutoPlay fallback logic; keep real tap handling explicit.',
          });
        }
      }
      return issues;
    },
  },
  { id: 'raw-resource-string-call', pattern: null, blocking: true,
    message: 'Resource API calls must use GFM_ResourceIds constants/Normalize(), not raw string ids.',
    custom: function(code, ctx) {
      var fileName = ctx && ctx.filename ? String(ctx.filename).split(/[\\/]/).pop() : '';
      if (fileName && !/^GameFlowManagerMain(?:\.[A-Za-z]+)?\.cs$/.test(fileName)) return [];
      var hasResourceIds = code.indexOf('GFM_ResourceIds') >= 0;
      if (!hasResourceIds && ctx && ctx.extraFiles) {
        Object.keys(ctx.extraFiles).forEach(function(key) {
          if ((ctx.extraFiles[key] || '').indexOf('GFM_ResourceIds') >= 0) hasResourceIds = true;
        });
      }
      if (!hasResourceIds) return [];
      var stripped = code
        .replace(/\/\*[\s\S]*?\*\//g, function(m) { return m.replace(/[^\n]/g, ' '); })
        .replace(/\/\/[^\n]*/g, function(m) { return ' '.repeat(m.length); });
      var issues = [];
      var callRe = /\b(AddResource|GetResource|TrySpend|TryConvert)\s*\(\s*"([^"\n]+)"/g;
      var m;
      while ((m = callRe.exec(stripped)) !== null) {
        issues.push({
          line: code.substring(0, m.index).split('\n').length,
          text: m[1] + '("' + m[2] + '", ...) should use GFM_ResourceIds.' + (/^gold$/i.test(m[2]) ? 'Gold' : 'Normalize("' + m[2] + '")'),
        });
      }
      var invRe = /\b_inventory\s*\[\s*"([^"\n]+)"\s*\]/g;
      while ((m = invRe.exec(stripped)) !== null) {
        issues.push({
          line: code.substring(0, m.index).split('\n').length,
          text: '_inventory["' + m[1] + '"] should use _inventory[GFM_ResourceIds.Normalize("' + m[1] + '")]',
        });
      }
      return issues;
    },
  },
  { id: 'updategamestate-skeleton-preserve', pattern: null, blocking: true,
    message: 'UpdateGameState() was structurally damaged — preserve the skeleton JSON bridge keys and final gameObject.name assignment.',
    custom: function(code, ctx) {
      var candidates = [{ file: (ctx && ctx.filename) || 'GameFlowManagerMain.cs', src: code }];
      if (ctx && ctx.extraFiles) {
        Object.keys(ctx.extraFiles).forEach(function(key) {
          candidates.push({ file: key, src: ctx.extraFiles[key] });
        });
      }
      var issues = [];
      var required = [
        '\\"currentPhase\\":',
        '\\"completedPhases\\":',
      ];
      for (var ci = 0; ci < candidates.length; ci++) {
        var src = candidates[ci].src || '';
        var fileName = candidates[ci].file;
        var sigMatch = /\bvoid\s+UpdateGameState\s*\(\s*\)\s*\{/.exec(src);
        if (!sigMatch) continue;
        var start = sigMatch.index + sigMatch[0].length;
        var depth = 1, end = start;
        while (end < src.length && depth > 0) {
          var ch = src[end];
          if (ch === '{') depth++;
          else if (ch === '}') { depth--; if (depth === 0) break; }
          end++;
        }
        if (depth !== 0) {
          issues.push({ line: src.substring(0, sigMatch.index).split('\n').length, text: fileName + ': UpdateGameState() braces are unbalanced' });
          continue;
        }
        var body = src.substring(start, end);
        var missing = [];
        for (var ri = 0; ri < required.length; ri++) {
          if (body.indexOf(required[ri]) < 0) missing.push(required[ri]);
        }
        var bridgeChecks = [
          {
            label: '\\"entityStates\\":{ | BuildEntityStatesJson()',
            ok: body.indexOf('\\"entityStates\\":{') >= 0 ||
              (body.indexOf('\\"entityStates\\":') >= 0 && /BuildEntityStatesJson\s*\(/.test(body)),
          },
          {
            label: '\\"variables\\":{ | BuildVariablesJson()',
            ok: body.indexOf('\\"variables\\":{') >= 0 ||
              (body.indexOf('\\"variables\\":') >= 0 && /BuildVariablesJson\s*\(/.test(body)),
          },
          {
            label: '\\"phaseTimestamps\\":{ | BuildPhaseTimestampsJson()',
            ok: body.indexOf('\\"phaseTimestamps\\":{') >= 0 ||
              (body.indexOf('\\"phaseTimestamps\\":') >= 0 && /BuildPhaseTimestampsJson\s*\(/.test(body)),
          },
          {
            label: '\\"uiState\\":{ | BuildUiStateJson()',
            ok: body.indexOf('\\"uiState\\":{') >= 0 ||
              (body.indexOf('\\"uiState\\":') >= 0 && /BuildUiStateJson\s*\(/.test(body)),
          },
          {
            label: '\\"cameraState\\":{ | BuildCameraStateJson()',
            ok: body.indexOf('\\"cameraState\\":{') >= 0 ||
              (body.indexOf('\\"cameraState\\":') >= 0 && /BuildCameraStateJson\s*\(/.test(body)),
          }
        ];
        for (var bi = 0; bi < bridgeChecks.length; bi++) {
          if (!bridgeChecks[bi].ok) missing.push(bridgeChecks[bi].label);
        }
        if (!/gameObject\.name\s*=\s*(?:"[^"\n]*"\s*\+\s*)?json\s*;/.test(body)) {
          missing.push('gameObject.name = json;');
        }
        if (missing.length > 0) {
          issues.push({
            line: src.substring(0, sigMatch.index).split('\n').length,
            text: fileName + ': UpdateGameState() missing required bridge markers: ' + missing.slice(0, 3).join(', ') + (missing.length > 3 ? ' ...' : ''),
          });
        }
      }
      return issues;
    },
  },
  // Blocking 6c (2026-04-21): duplicate method across partial-class files (CS0111).
  // nqw7z3 (守护家园) burned its entire 6-round budget on AI re-declaring UpdateWorker,
  // UpdateEnemyLittle, etc. in Systems.cs when the same names already existed in
  // main. The compile error IS discovered by the build stage, but each round costs
  // a ~3-4min Opus recode. Surface it at static-check so fix-loop sees a targeted
  // fingerprint ("method X duplicated in Y.cs") and Claude can delete or rename
  // the duplicate without going through a full compile cycle. Only fires when the
  // main file is actually partial (partial-class-mismatch owns the other branch).
  {
    id: 'partial-method-duplicate',
    pattern: null,
    blocking: true,
    message: 'Method already defined in a partial-class companion file (CS0111) — delete the duplicate declaration from the main file or rename one of them',
    custom: function(code, ctx) {
      if (!ctx || !ctx.extraFiles) return [];
      if (!/\bpartial\s+class\s+GameFlowManagerMain\b/.test(code)) return [];
      var extractSigs = function(src) {
        var out = [];
        if (!src) return out;
        var stripped = src
          .replace(/\/\*[\s\S]*?\*\//g, function(m) { return m.replace(/[^\n]/g, ' '); })
          .replace(/\/\/[^\n]*/g, function(m) { return ' '.repeat(m.length); })
          .replace(/"(?:[^"\\]|\\.)*"/g, function(m) { return '"' + ' '.repeat(Math.max(0, m.length - 2)) + '"'; });
        var srcLines = stripped.split('\n');
        var CTRL = { if:1,for:1,foreach:1,while:1,switch:1,using:1,lock:1,catch:1,fixed:1,return:1,throw:1,'new':1,'do':1,'else':1 };
        var isTypeLikeToken = function(token) {
          return /^[A-Za-z_][A-Za-z0-9_<>,\[\].?]*$/.test(String(token || ''));
        };
        for (var li = 0; li < srcLines.length; li++) {
          var raw = srcLines[li];
          var cIdx = raw.indexOf('//');
          var line = cIdx >= 0 ? raw.slice(0, cIdx) : raw;
          var t = line.replace(/^\s+|\s+$/g, '');
          if (!t) continue;
          var op = t.indexOf('(');
          if (op < 0) continue;
          var cp = t.lastIndexOf(')');
          if (cp <= op) continue;
          var tail = t.slice(cp + 1).replace(/\s/g, '');
          // Method signature tails: empty (brace next line), `{` (brace same line),
          // `{...}` (same-line body like `void Foo() { }`), or `;` (abstract/interface/partial).
          var tailOk = (tail === '' || tail === ';' || tail.charAt(0) === '{');
          if (!tailOk) continue;
          if (t.indexOf('=>') >= 0) continue;
          var before = t.slice(0, op);
          if (before.indexOf('=') >= 0 && before.indexOf('==') < 0) continue;
          // Strip trailing generic params so `Foo<T>(...)` keeps `Foo` as the name.
          var beforeNoGeneric = before.replace(/<[^<>]*>\s*$/, '');
          var nameMatch = /([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(beforeNoGeneric);
          if (!nameMatch) continue;
          var methodName = nameMatch[1];
          if (CTRL[methodName]) continue;
          // Require ≥2 tokens before the name (return type + name) to skip
          // constructors/control-flow. Constructors match the class name alone.
          var preTokens = beforeNoGeneric.replace(/\s+$/, '').split(/\s+/);
          if (preTokens.length < 2) continue;
          // Reject expression-statement false positives like `return foo.Bar();`.
          // The first token must be a modifier or a type keyword, not a control-flow
          // or call expression root.
          if (CTRL[preTokens[0]]) continue;
          if (!isTypeLikeToken(preTokens[0])) continue;
          // If the token just before the name contains `.`, it's a member-call
          // expression (e.g. `x = foo.Bar(...)`), not a method declaration.
          if (preTokens[preTokens.length - 2] && preTokens[preTokens.length - 2].indexOf('.') >= 0) continue;
          if (preTokens[preTokens.length - 2] && !isTypeLikeToken(preTokens[preTokens.length - 2])) continue;
          // Arity: count top-level commas+1 in params (0 if empty). Simple split
          // is imprecise with generics in params, but good enough — CS0111 is
          // about signature-level match, and Claude's regenerated duplicates are
          // almost always exact copies.
          var params = t.slice(op + 1, cp).replace(/^\s+|\s+$/g, '');
          var arity = params === '' ? 0 : params.split(',').filter(function(p) { return p.replace(/\s/g, '') !== ''; }).length;
          out.push({ name: methodName, arity: arity, line: li + 1 });
        }
        return out;
      };
      var companionIndex = {};
      var currentFile = ctx && ctx.filename ? String(ctx.filename).split(/[\\/]/).pop() : '';
      for (var efKey in ctx.extraFiles) {
        if (!ctx.extraFiles.hasOwnProperty(efKey)) continue;
        if (!/GameFlowManagerMain/.test(efKey)) continue;
        if (currentFile && efKey === currentFile) continue;
        var efCode = ctx.extraFiles[efKey];
        if (!/\bpartial\s+class\s+GameFlowManagerMain\b/.test(efCode)) continue;
        var efSigs = extractSigs(efCode);
        for (var si = 0; si < efSigs.length; si++) {
          var k = efSigs[si].name + '/' + efSigs[si].arity;
          if (!companionIndex[k]) companionIndex[k] = efKey;
        }
      }
      if (Object.keys(companionIndex).length === 0) return [];
      var mainSigs = extractSigs(code);
      var issues = [];
      for (var mi = 0; mi < mainSigs.length; mi++) {
        var ms = mainSigs[mi];
        var mk = ms.name + '/' + ms.arity;
        if (companionIndex[mk]) {
          issues.push({
            line: ms.line,
            text: ms.name + '(' + ms.arity + ' param' + (ms.arity === 1 ? '' : 's') + ') duplicated in ' + companionIndex[mk],
          });
        }
      }
      return issues;
    },
  },
  // Blocking 6b: ≥4 consecutive `if (X == "literal")` on the same identifier =
  // phase-dispatch anti-pattern. Switch/case should replace it. Deliberately
  // narrower than v8's chained-if-same-var-no-else (threshold 3, warning): this
  // rule targets the 12-phase dispatch pattern user rejected in urbib0.
  { id: 'long-if-chain', pattern: null, blocking: true,
    message: 'Long if-chain (≥4) on same identifier — replace with switch(var) { case "x": ...; break; }',
    custom: function(code, ctx) {
      if (ctx && /(?:^|\/)ScriptActivator\.cs$/.test(ctx.filename || '')) return [];
      var issues = [];
      var stripped = code
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/"(?:[^"\\]|\\.)*"/g, '""');
      var re = /(\belse\s+)?\bif\s*\(\s*(\w+)\s*==\s*""/g;
      var runs = [], cur = null, m;
      while ((m = re.exec(stripped)) !== null) {
        var ident = m[2];
        if (cur && cur.ident === ident) {
          cur.count++;
        } else {
          cur = { ident: ident, count: 1, firstIdx: m.index };
          runs.push(cur);
        }
      }
      for (var i = 0; i < runs.length; i++) {
        if (runs[i].ident === 'currentPhaseName') continue;
        if (runs[i].count >= 4) {
          var lineNum = code.substring(0, runs[i].firstIdx).split('\n').length;
          issues.push({ line: lineNum, text: runs[i].count + ' chained "if (' + runs[i].ident + ' == ...)" — convert to switch' });
        }
      }
      return issues;
    },
  },
  // Blocking 6c: UnityEvent/event Action/AddListener = indirect event dispatch.
  // User requirement #7: direct method calls only. Currently zero violations in
  // pipeline output — rule is anti-regression.
  { id: 'no-unityevent-in-flow', pattern: null, blocking: true,
    message: 'UnityEvent / event Action / AddListener forbidden — use direct method call',
    custom: function(code) {
      var issues = [];
      var stripped = code
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      var patterns = [
        { re: /\bUnityEvent\b/g, why: 'UnityEvent' },
        { re: /\bpublic\s+event\s+(?:Action|Func)\b/g, why: 'public event Action/Func' },
        { re: /\b(?:SendMessage|BroadcastMessage)\s*\(/g, why: 'SendMessage/BroadcastMessage' },
        { re: /\bGFM_Event\b/g, why: 'GFM_Event' },
        { re: /\.AddListener\s*\(/g, why: '.AddListener(' },
        { re: /\.RemoveListener\s*\(/g, why: '.RemoveListener(' },
      ];
      for (var p = 0; p < patterns.length; p++) {
        var pr = patterns[p];
        pr.re.lastIndex = 0;
        var m;
        while ((m = pr.re.exec(stripped)) !== null) {
          var lineNum = code.substring(0, m.index).split('\n').length;
          issues.push({ line: lineNum, text: pr.why + ' at line ' + lineNum });
        }
      }
      return issues;
    },
  },
  // Blocking 6d: method body > 60 lines. Exempt list covers legitimately-long
  // skeleton scaffolding (CheckEventRules, phase dispatchers, UpdateGameState,
  // TryReportStuckPhase).
  // Threshold to be calibrated at W2 end against real urbib0/successor distribution.
  { id: 'method-too-long', pattern: null, blocking: true,
    message: 'Method body too long — split into smaller named methods and keep coordinator methods thin',
    custom: function(code) {
      var issues = [];
      var stripped = code
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      var exempt = ['Update', 'Start', 'Awake', 'CheckEventRules'];
      var sigRe = /\b(?:public|private|protected|internal)?\s*(?:static\s+)?(?:void|IEnumerator|bool|int|float|string|GameObject|Vector[23]|Color|Transform)\s+(\w+)\s*\([^)]*\)\s*\{/g;
      var m;
      while ((m = sigRe.exec(stripped)) !== null) {
        var name = m[1];
        if (exempt.indexOf(name) >= 0) continue;
        if (/^AssemblyRun[A-Za-z]+Slots$/.test(name)) continue;
        if (/^AssemblySlot_[A-Za-z0-9_]+$/.test(name)) continue;
        if (/^Phase_[A-Za-z0-9]+_(?:OnTap|OnAutoPlayArrive)$/.test(name)) continue;
        var start = m.index + m[0].length;
        var depth = 1, end = start;
        while (end < stripped.length && depth > 0) {
          var ch = stripped[end];
          if (ch === '{') depth++;
          else if (ch === '}') { depth--; if (depth === 0) break; }
          end++;
        }
        if (depth !== 0) continue;
        var body = stripped.substring(start, end);
        if (isPurePhaseDispatcherBody(body)) continue;
        if (name === 'UpdateGameState' && isSkeletonUpdateGameStateBody(body)) continue;
        if (isSkeletonTryReportStuckPhaseBody(name, body)) continue;
        var lineCount = body.split('\n').length;
        if (lineCount > 45) {
          var lineNum = code.substring(0, m.index).split('\n').length;
          issues.push({ line: lineNum, text: name + '() body ' + lineCount + ' lines' });
        }
      }
      return issues;
    },
  },
  // Blocking 6e: every GameFlowManagerMain field/method needs nearby docs.
  // Scoped via class-name sniff to GameFlowManagerMain (skip canonical GFM_* lib).
  { id: 'require-member-doc', pattern: null, blocking: true,
    message: 'Every field/method in GameFlowManagerMain partials must carry a descriptive comment',
    custom: function(code) {
      if (code.indexOf('GameFlowManagerMain') < 0) return [];
      var issues = [];
      var lines = code.split('\n');
      var sanitized = code
        .replace(/\/\*[\s\S]*?\*\//g, function(m) { return m.replace(/[^\n]/g, ' '); })
        .replace(/\/\/[^\n]*/g, function(m) { return ' '.repeat(m.length); })
        .replace(/"(?:[^"\\]|\\.)*"/g, function(m) { return '"' + ' '.repeat(Math.max(0, m.length - 2)) + '"'; });
	      var sanitizedLines = sanitized.split('\n');
      function skeletonGroupDocPattern(sTrimmed) {
        if (/^int\s+\w+State\s*=/.test(sTrimmed)) return /Entity states|实体状态/;
        if (/^bool\s+\w+(?:InteractionDone|PlayerActed|Done)\s*=/.test(sTrimmed)) return /Interaction flags|交互标记|Anti-autoplay/;
        if (/^(?:GFM_Joystick\s+joystick|float\s+moveSpeed\b)/.test(sTrimmed)) return /玩家移动|Player Movement/;
        if (/^GameObject\s+player\s*;/.test(sTrimmed)) return /玩家移动|Player Movement|Object references|对象引用/;
        if (/^GameObject\s+\w+\s*;/.test(sTrimmed)) return /Object references|对象引用/;
        if (/^void\s+Spawn\w+\s*\(/.test(sTrimmed)) return /Spawn compatibility|Spawn 兼容/;
        if (/^(?:Vector3\s+tapMoveTarget|bool\s+hasTapTarget)\b/.test(sTrimmed)) return /点击移动目标|Tap-to-move/;
        if (/^void\s+UpdateCarryVisuals\s*\(/.test(sTrimmed)) return /背包堆叠|carry stack/;
        if (/^int\s+gold\s*=/.test(sTrimmed)) return /金币 UI|Gold UI|Idle 分数/;
        if (/^Vector3\s+_snap_\w+Pos\s*;/.test(sTrimmed)) return /Phase snapshots|快照/;
        if (/^(?:FormDef\[\]\s+_forms|int\s+_currentFormIndex\b)/.test(sTrimmed)) return /形态|Form|玩家形态/;
        if (/^(?:float\s+phaseTimer|string\s+lastPhaseForTimer|float\[\]\s+phaseEnterTimes)\b/.test(sTrimmed)) return /Phase timing|Phase 计时|计时/;
        if (/^(?:Camera|Canvas|Text|float|string)\s+(?:mainCam|uiCanvas|guideText|scoreText|floatingText|floatingTextTimer|_currentGuideText|cameraFocusTarget)\b/.test(sTrimmed)) return /Camera\/UI|Camera reference|UI references|相机引用|UI 引用/;
        if (/^(?:const\s+int\s+RULE_COUNT|bool\[\]\s+ruleTriggered|string\s+currentPhaseName|string\[\]\s+completedPhases|int\s+completedPhaseCount|float\s+gameTimer|bool\s+gameEnded)\b/.test(sTrimmed)) return /Phase tracking|阶段跟踪/;
        if (/^(?:bool\s+_autoPlayMode|int\s+_autoPlaySteps|int\s+_autoPlayStepsAtPhaseStart|const\s+float\s+AUTO_PLAY_PHASE_DURATION)\b/.test(sTrimmed)) return /AutoPlay/;
        if (/^(?:string\[\]\s+_phaseEvidenceKeys|string\[\]\s+_phaseEvidenceValues|int\s+_phaseEvidenceCount)\b/.test(sTrimmed)) return /Phase evidence|evidence|运行时证据/;
        return null;
      }
      function hasRecentSkeletonGroupDoc(lineIndex, sTrimmed) {
	        var pattern = skeletonGroupDocPattern(sTrimmed);
	        if (!pattern) return false;
	        for (var k = lineIndex - 1; k >= 0; k--) {
	          var prev = (lines[k] || '').trim();
	          if (!prev) break;
	          if (/^(?:public\s+)?partial\s+class\b/.test(prev) || prev === '{') break;
	          if (prev.indexOf('//') === 0 && pattern.test(prev)) return true;
	        }
	        return false;
	      }
      var depth = 0;
      for (var i = 0; i < lines.length; i++) {
        var raw = lines[i];
        var sline = sanitizedLines[i] || '';
        var trimmed = raw.trim();
        var sTrimmed = sline.trim();
        if (depth === 1) {
          var isDecl = false;
          if (!/^(if|for|foreach|while|switch|catch|using|return|throw|else|do)\b/.test(sTrimmed)) {
            if (/^(?:public|private|protected|internal)?\s*(?:static\s+)?(?:readonly\s+)?(?:const\s+)?(?:override\s+)?(?:virtual\s+)?(?:partial\s+)?(?:void|IEnumerator|bool|int|float|string|GameObject|Vector2|Vector3|Vector4|Color|Transform|Text|Canvas|Quaternion|Ray|Material|Image|Sprite|RectTransform|[\w<>]+\[\]?|[A-Z]\w*)\s+\w+\s*\([^;]*\)\s*\{?\s*$/.test(sTrimmed)) {
              isDecl = true;
            } else if (/^(?:public|private|protected|internal)?\s*(?:static\s+)?(?:readonly\s+)?(?:const\s+)?(?:bool|int|float|string|GameObject|Vector2|Vector3|Vector4|Color|Transform|Text|Canvas|Quaternion|Ray|Material|Image|Sprite|RectTransform|[\w<>]+\[\]?|[A-Z]\w*)\s+\w+\s*(?:=\s*[^;]+)?;\s*$/.test(sTrimmed)) {
              isDecl = true;
            } else if (/^(?:public|private|protected|internal)?\s*(?:static\s+)?(?:bool|int|float|string|GameObject|Vector2|Vector3|Vector4|Color|Transform|Text|Canvas|Quaternion|Ray|Material|Image|Sprite|RectTransform|[\w<>]+\[\]?|[A-Z]\w*)\s+\w+\s*\{\s*get\b/.test(sTrimmed)) {
              isDecl = true;
            }
          }
          if (isDecl) {
            if (/\b(class|struct|enum|interface)\b/.test(sTrimmed)) isDecl = false;
            if (/^\[/.test(trimmed)) isDecl = false;
          }
          if (isDecl) {
            if (/^bool\s+__assemblyDone_/.test(sTrimmed)) isDecl = false;
            if (/\bvoid\s+AssemblyRun[A-Za-z]+Slots\s*\(/.test(sTrimmed)) isDecl = false;
            if (/^void\s+Spawn\w+\s*\(/.test(sTrimmed)) isDecl = false;
            if (/^(?:float\s+_collectCooldown|string\s+_lastScoreText)\b/.test(sTrimmed)) isDecl = false;
            if (/\bvoid\s+(?:AddGold|ShowFloatingText)\s*\(/.test(sTrimmed)) isDecl = false;
            if (!isDecl) continue;
            if (hasRecentSkeletonGroupDoc(i, sTrimmed)) continue;
            var nameMatch = trimmed.match(/\b(\w+)\s*\(/);
            if (!nameMatch) nameMatch = trimmed.match(/\b(\w+)\s*(?:=|;|\{)/);
            // Inline trailing comments count as valid docs for skeleton fields
            // and helpers, e.g. `int gold = 0; // current balance`.
            var inlineCode = raw;
            var inlineCommentAt = -1;
            var inString = false;
            for (var ii = 0; ii < raw.length - 1; ii++) {
              if (raw[ii] === '"' && raw[ii - 1] !== '\\') inString = !inString;
              if (!inString && raw[ii] === '/' && raw[ii + 1] === '/') {
                inlineCommentAt = ii;
                break;
              }
            }
            if (inlineCommentAt >= 0) {
              inlineCode = raw.slice(0, inlineCommentAt).trim();
              if (inlineCode) continue;
            }
            var j = i - 1;
            while (j >= 0 && lines[j].trim() === '') j--;
            if (j < 0) {
              issues.push({ line: i + 1, text: trimmed.slice(0, 120) });
            } else {
              var prev = lines[j].trim();
              var hasDoc = prev.indexOf('///') === 0 ||
                           prev.indexOf('//') === 0 ||
                           prev.slice(-2) === '*/' ||
                           /^\[[\w,\s"=]+\]$/.test(prev);
              if (!hasDoc) issues.push({ line: i + 1, text: trimmed.slice(0, 120) });
            }
          }
        }
        var opens = (sline.match(/\{/g) || []).length;
        var closes = (sline.match(/\}/g) || []).length;
        depth += opens - closes;
      }
      return issues;
    },
  },
  // Blocking 6f: if-branches with magic numbers (>=3 digit) or string literals
  // should have trailing // comment explaining the condition. Exempts ruleTriggered[]
  // skeleton patterns and autoPlay gates which carry [SKELETON] banners elsewhere.
  { id: 'require-branch-comment', pattern: null, blocking: true,
    message: 'Each non-trivial condition branch must carry a nearby comment explaining the intent',
    custom: function(code, ctx) {
      if (ctx && /(?:^|\/)ScriptActivator\.cs$/.test(ctx.filename || '')) return [];
      var issues = [];
      var lines = code.split('\n');
      var ifRe = /\bif\s*\(([^)]*)\)/;
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var m = line.match(ifRe);
        if (!m) continue;
        var cond = m[1];
        // Only require branch commentary for truly complex conditions.
        var comparisonOps = (cond.match(/(?:==|!=|<=|>=|<|>)/g) || []).length;
        var isComplex = cond.indexOf('&&') >= 0 ||
                        cond.indexOf('||') >= 0 ||
                        cond.indexOf('?') >= 0 ||
                        cond.indexOf('"') >= 0 ||
                        /\b\d{3,}\b/.test(cond) ||
                        comparisonOps >= 2;
        if (!isComplex) continue;
        // Exempt skeleton-generated patterns
        if (/ruleTriggered\[|_autoPlayMode|phaseTimer\s*[<>]=?|currentPhaseName\s*==|GFM_CameraController\.Instance|TrySpend\s*\(|GetResource\s*\(|transform\.position\.y\s*<\s*-900|(?:guideText|scoreText|floatingText)\.text\s*!=|==\s*null\s*\|\||\|\|\s*\w+\s*==\s*null/.test(cond)) continue;
        var sameLine = line.replace(/"[^"]*"/g, '""');
        if (sameLine.indexOf('//') >= 0) continue;
        var prev1 = i > 0 ? lines[i - 1].trim() : '';
        var prev2 = i > 1 ? lines[i - 2].trim() : '';
        var next1 = i + 1 < lines.length ? lines[i + 1].trim() : '';
        if (prev1.indexOf('//') === 0 || prev1.indexOf('///') === 0 || prev2.indexOf('//') === 0 || prev2.indexOf('///') === 0 || next1.indexOf('//') === 0 || next1.indexOf('///') === 0) continue;
        issues.push({ line: i + 1, text: line.trim().slice(0, 120) });
      }
      return issues;
    },
  },
  { id: 'multiline-condition-comment-required', pattern: null, blocking: true,
    message: 'Each multi-line or chained condition block must carry a nearby comment explaining the gating intent',
    custom: function(code) {
      var issues = [];
      var lines = code.split('\n');
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line.indexOf('if') < 0) continue;
        if (!/\bif\s*\(/.test(line)) continue;
        var start = i;
        var block = line;
        var depth = (line.match(/\(/g) || []).length - (line.match(/\)/g) || []).length;
        var end = i;
        while (depth > 0 && end + 1 < lines.length) {
          end++;
          block += '\n' + lines[end];
          depth += (lines[end].match(/\(/g) || []).length - (lines[end].match(/\)/g) || []).length;
        }
        var condText = block.replace(/^[\s\S]*?\bif\s*\(/, '').replace(/\)\s*\{?[\s\S]*$/, '');
        var isMultiline = end > start;
        var hasChain = /\&\&|\|\|/.test(condText);
        if (!isMultiline && !hasChain) continue;
        if (/ruleTriggered\[|_autoPlayMode|phaseTimer\s*[<>]=?|currentPhaseName\s*==|GFM_CameraController\.Instance|==\s*null\s*\|\||\|\|\s*\w+\s*==\s*null/.test(condText)) { i = end; continue; }
        var inlineComment = false;
        for (var li = start; li <= end; li++) {
          if (lines[li].indexOf('//') >= 0 || lines[li].indexOf('/*') >= 0) { inlineComment = true; break; }
        }
        if (inlineComment) { i = end; continue; }
        var prev1 = start > 0 ? lines[start - 1].trim() : '';
        var prev2 = start > 1 ? lines[start - 2].trim() : '';
        var next1 = end + 1 < lines.length ? lines[end + 1].trim() : '';
        var hasNearby = prev1.indexOf('//') === 0 || prev1.indexOf('///') === 0 ||
                        prev2.indexOf('//') === 0 || prev2.indexOf('///') === 0 ||
                        next1.indexOf('//') === 0 || next1.indexOf('///') === 0;
        if (!hasNearby) issues.push({ line: start + 1, text: lines[start].trim().slice(0, 120) });
        i = end;
      }
      return issues;
    },
  },
  { id: 'switch-case-comment-required', pattern: null, blocking: true,
    message: 'Each switch/case branch in GameFlowManagerMain partials must carry a nearby comment explaining why that branch exists',
    custom: function(code) {
      if (code.indexOf('GameFlowManagerMain') < 0) return [];
      var issues = [];
      var lines = code.split('\n');
      for (var i = 0; i < lines.length; i++) {
        var t = lines[i].trim();
        if (!(t.indexOf('switch ') === 0 || t.indexOf('switch(') === 0 || t.indexOf('case ') === 0 || t.indexOf('default:') === 0)) continue;
        if (/^switch\s*\(\s*currentPhaseName\s*\)/.test(t)) continue;
        if ((t.indexOf('case ') === 0 || t.indexOf('default:') === 0) && nearestPreviousSwitchIsCurrentPhase(lines, i)) continue;
        if (t.indexOf('//') >= 0) continue;
        var prev = i > 0 ? lines[i - 1].trim() : '';
        if (prev.indexOf('//') === 0 || prev.indexOf('///') === 0) continue;
        issues.push({ line: i + 1, text: t.slice(0, 120) });
      }
      return issues;
    },
  },
  { id: 'thin-input-coordinator', pattern: null, blocking: true,
    message: 'Input coordinator methods must stay thin — split condition analysis into named helper methods',
    custom: function(code, ctx) {
      var fileName = (ctx && ctx.filename) || '';
      if (code.indexOf('GameFlowManagerMain') < 0) return [];
      var issues = [];
      var stripped = code
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      var methodNames = ['HandlePlayerInteractions', 'OnAutoPlayArrive', 'Phase_OnTap', 'UpdateInput', 'HandleInput'];
      for (var mi = 0; mi < methodNames.length; mi++) {
        var name = methodNames[mi];
        var sigRe = new RegExp('\\b(?:public|private|protected|internal)?\\s*(?:static\\s+)?(?:void|bool|int|float|string)\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{', 'g');
        var m;
        while ((m = sigRe.exec(stripped)) !== null) {
          var start = m.index + m[0].length;
          var depth = 1, end = start;
          while (end < stripped.length && depth > 0) {
            var ch = stripped[end];
            if (ch === '{') depth++;
            else if (ch === '}') { depth--; if (depth === 0) break; }
            end++;
          }
          if (depth !== 0) continue;
          var body = stripped.substring(start, end);
          if (isPurePhaseDispatcherBody(body)) continue;
          var lineCount = body.split('\n').length;
          var branchCount = (body.match(/\bif\s*\(|\bswitch\s*\(|\bcase\s+/g) || []).length;
          if (lineCount > 25 || branchCount > 4) {
            var lineNum = code.substring(0, m.index).split('\n').length;
            issues.push({ line: lineNum, text: name + '() in ' + (fileName || 'GameFlowManagerMain') + ' is too large (' + lineCount + ' lines, ' + branchCount + ' branches)' });
          }
        }
      }
      return issues;
    },
  },
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

function isCanonicalToolkitFile(fileName) {
  var base = String(fileName || '').split(/[\\/]/).pop();
  return base === 'GFM_Tools.cs' || /^GFM_.*\.cs$/.test(base);
}

/**
 * Run static checks across the generated GameFlowManagerMain partial set.
 * The main scan receives extraFiles so cross-file rules can run once; companion
 * scans are file-scoped to avoid duplicating rules that already inspect extras.
 */
function staticCheckProject(code, ctx) {
  ctx = ctx || {};
  var extraFiles = ctx.extraFiles || {};
  var issues = [];
  var mainCtx = Object.assign({}, ctx, {
    filename: ctx.filename || 'GameFlowManagerMain.cs',
    extraFiles: extraFiles,
  });
  var mainResult = staticCheck(code || '', mainCtx);
  (mainResult.issues || []).forEach(function(issue) {
    issues.push(Object.assign({ file: mainCtx.filename }, issue));
  });

  Object.keys(extraFiles).sort().forEach(function(fileName) {
    if (isCanonicalToolkitFile(fileName)) return;
    var fileCtx = Object.assign({}, ctx, {
      filename: fileName,
      extraFiles: {},
    });
    var fileResult = staticCheck(extraFiles[fileName] || '', fileCtx);
    (fileResult.issues || []).forEach(function(issue) {
      issues.push(Object.assign({ file: fileName }, issue));
    });
  });

  return {
    passed: issues.length === 0,
    issues: issues,
  };
}

function getProjectBlockingIssues(code, ctx) {
  var result = staticCheckProject(code, ctx);
  return result.issues.filter(function(i) { return i.blocking; });
}

module.exports = {
  staticCheck: staticCheck,
  staticCheckProject: staticCheckProject,
  getBlockingIssues: getBlockingIssues,
  getProjectBlockingIssues: getProjectBlockingIssues,
  RULES: RULES,
};
