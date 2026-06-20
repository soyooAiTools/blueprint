/**
 * Stage: review — Code review (Codex or GPT-5.4 fallback) with fix loop
 *
 * Reads: ctx.csCode, ctx.blueprint, ctx.workDir
 * Writes: ctx.csCode (updated with reviewed code)
 */

var fs = require('fs');
var path = require('path');
var helpers = require('../helpers.cjs');
var { recode, patchRecode } = require('../recode.cjs');
var { createFixLoop } = require('../fix-loop.cjs');
var { staticCheckProject, getBlockingIssues } = require('../static-check.cjs');
var { checkConformance } = require('../spec-conformance.cjs');
var { normalizeFingerprint } = require('../metrics.cjs');
var assemblyPlanContracts = require('../assembly-plan-contracts.cjs');
var llmHotPath = require('../../lib/llm-hot-path.cjs');
// 2026-05-31 Wave 1.b: shared whitelist source-of-truth with static-check.cjs.
var staticRuleRegistry = require('../lib/static-rule-registry.cjs');

var MAX_REVIEW_ROUNDS = 4;
var REVIEW_REPEAT_BLOCK_AT = 3;

function summarizeRules(issues, limit) {
  var counts = {};
  (issues || []).forEach(function(issue) {
    var key = issue.rule || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  });
  return Object.keys(counts)
    .sort(function(a, b) { return counts[b] - counts[a]; })
    .slice(0, limit || 5)
    .map(function(key) { return key + ' x' + counts[key]; })
    .join(', ');
}

function isAssemblyReadyForDeterministicReview(ctx, staticWarnings, specCriticalCount) {
  if (process.env.DISABLE_ASSEMBLY_REVIEW_SKIP === 'true') return false;
  var blueprint = ctx && ctx.blueprint || {};
  if (specCriticalCount > 0) return false;
  if (!Array.isArray(staticWarnings)) return false;

  var plans = blueprint.plans || {};
  var assemblyPlan = plans.assemblyPlan || {};
  var unresolvedCount = Array.isArray(assemblyPlan.unresolved)
    ? assemblyPlan.unresolved.length
    : (blueprint.assemblyUnresolvedCount || 0);
  var implementationCoverage = Number(blueprint.assemblyImplementationCoverage);
  if (!isFinite(implementationCoverage)) implementationCoverage = 0;
  var missingImpl = Number(blueprint.assemblyImplementationMissingCount || 0);
  var assemblyCoverage = Number(blueprint.assemblyCoverage);
  if (!isFinite(assemblyCoverage)) assemblyCoverage = 0;

  var assemblyReady =
    blueprint.assemblyDecision === 'assembly_ready' &&
    !blueprint.assemblyFallbackRequired &&
    assemblyCoverage >= 0.999 &&
    implementationCoverage >= 0.999 &&
    missingImpl === 0 &&
    unresolvedCount === 0;
  if (assemblyReady) return true;

  // 2026-04-27: Alternate template-output gate. When the schema-driven template
  // engine produces structurally complete code (validator passes + no residual
  // TODOs + high template coverage), there is nothing for the LLM reviewer to
  // catch that static-check + method-check + compile won't already enforce.
  // Skipping LLM here saves ~15K Codex tokens and ~30s wall time per task.
  var templateValidation = blueprint.templateValidation;
  var templateCoverage = Number(blueprint.templateCoverage);
  if (!isFinite(templateCoverage)) templateCoverage = 0;
  var todoSectionsRemaining = Number(blueprint.todoSectionsRemaining);
  if (!isFinite(todoSectionsRemaining)) todoSectionsRemaining = -1;

  var templateGate =
    templateValidation && templateValidation.passed === true &&
    templateCoverage >= 0.95 &&
    todoSectionsRemaining === 0;
  if (templateGate) return true;

  return false;
}

function repairUpdateGameStateBridge(code) {
  if (!code || code.indexOf('void UpdateGameState()') < 0) {
    return { code: code, changed: false, fixes: 0 };
  }
  var fixed = code;
  var fixes = 0;
  var pairs = [
    ['+ "\\\"entityStates\\\":{\n', '+ "\\\"entityStates\\\":{"\n'],
    ['+ "\\\"variables\\\":{\n', '+ "\\\"variables\\\":{"\n'],
    ['+ ",\\\"phaseEvidence\\\":{\n', '+ ",\\\"phaseEvidence\\\":{"\n'],
    ['+ ",\\\"phaseTimestamps\\\":{\n', '+ ",\\\"phaseTimestamps\\\":{"\n'],
  ];
  for (var i = 0; i < pairs.length; i++) {
    if (fixed.indexOf(pairs[i][0]) >= 0) {
      fixed = fixed.split(pairs[i][0]).join(pairs[i][1]);
      fixes++;
    }
  }
  return { code: fixed, changed: fixes > 0, fixes: fixes };
}

function stripInitMaterialFromScene(code) {
  if (!code || code.indexOf('InitMaterialFromScene') < 0) {
    return { code: code, changed: false, fixes: 0 };
  }
  var lines = code.split('\n');
  var kept = [];
  var fixes = 0;
  for (var i = 0; i < lines.length; i++) {
    if (/\bGFM_Create\s*\.\s*InitMaterialFromScene\s*\(/.test(lines[i])) {
      fixes++;
      continue;
    }
    kept.push(lines[i]);
  }
  return { code: fixes > 0 ? kept.join('\n') : code, changed: fixes > 0, fixes: fixes };
}

function stripEarlyShowCTA(code) {
  if (!code || code.indexOf('ShowCTA(') < 0) {
    return { code: code, changed: false, fixes: 0 };
  }
  var lines = code.split('\n');
  var kept = [];
  var currentMethod = '';
  var braceDepth = 0;
  var fixes = 0;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var methodMatch = /\b(?:public|private|protected|internal)?\s*(?:static\s+)?(?:void|bool|int|float|string)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)/.exec(line);
    if (methodMatch) {
      currentMethod = methodMatch[1];
      braceDepth = 0;
    }
    braceDepth += (line.match(/\{/g) || []).length;
    braceDepth -= (line.match(/\}/g) || []).length;
    if (/\bShowCTA\s*\(\s*\)\s*;/.test(line) && currentMethod !== 'ShowCTA' && currentMethod !== 'FinishGame') {
      fixes++;
      if (line.indexOf('//') >= 0) kept.push(line.replace(/ShowCTA\s*\(\s*\)\s*;/, '// stripped deterministic early ShowCTA()'));
      continue;
    }
    if (braceDepth <= 0) {
      currentMethod = '';
    }
    kept.push(line);
  }
  return { code: fixes > 0 ? kept.join('\n') : code, changed: fixes > 0, fixes: fixes };
}

function normalizeFinishGameTerminalFlow(code) {
  if (!code || code.indexOf('void FinishGame(') < 0) {
    return { code: code, changed: false, fixes: 0 };
  }
  var fixed = code;
  var fixes = 0;
  fixed = fixed.replace(/^\s*AddCompletedPhase\s*\(\s*"gameEnd"\s*\)\s*;\s*$/gm, function() {
    fixes++;
    return '';
  });
  var sigRe = /\bvoid\s+FinishGame\s*\([^)]*\)\s*\{/;
  var m = sigRe.exec(fixed);
  if (!m) return { code: fixed, changed: fixes > 0, fixes: fixes };
  var start = m.index + m[0].length;
  var depth = 1;
  var end = start;
  while (end < fixed.length && depth > 0) {
    var ch = fixed[end];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) break; }
    end++;
  }
  if (depth !== 0) return { code: fixed, changed: fixes > 0, fixes: fixes };
  var body = fixed.substring(start, end);
  var hasEnd = body.indexOf('Luna.Unity.LifeCycle.GameEnded();') >= 0;
  var hasCTA = body.indexOf('ShowCTA();') >= 0;
  if (hasEnd && !hasCTA) {
    body = body.replace('Luna.Unity.LifeCycle.GameEnded();', 'Luna.Unity.LifeCycle.GameEnded();\n        ShowCTA();');
    fixes++;
  }
  var endIdx = body.indexOf('Luna.Unity.LifeCycle.GameEnded();');
  var ctaIdx = body.indexOf('ShowCTA();');
  if (endIdx >= 0 && ctaIdx >= 0 && ctaIdx < endIdx) {
    body = body.replace(/\s*ShowCTA\(\);\s*/g, '\n');
    body = body.replace('Luna.Unity.LifeCycle.GameEnded();', 'Luna.Unity.LifeCycle.GameEnded();\n        ShowCTA();');
    fixes++;
  }
  if (fixes > 0) {
    fixed = fixed.slice(0, start) + body + fixed.slice(end);
  }
  return { code: fixed, changed: fixes > 0, fixes: fixes };
}

function getExpectedPhaseCount(blueprint) {
  if (blueprint && Array.isArray(blueprint.specs) && blueprint.specs.length > 0) {
    return blueprint.specs.length;
  }
  var ids = assemblyPlanContracts.collectExpectedPhaseIds(blueprint || {});
  return ids.length;
}

function normalizeRuntimePhaseContract(code, blueprint) {
  if (!code) return { code: code, changed: false, fixes: 0 };
  var fixed = code;
  var fixes = 0;
  var expectedCount = getExpectedPhaseCount(blueprint);

  if (expectedCount > 0) {
    fixed = fixed.replace(/\bconst\s+int\s+RULE_COUNT\s*=\s*\d+\s*;/g, function(match) {
      var replacement = 'const int RULE_COUNT = ' + expectedCount + ';';
      if (match === replacement) return match;
      fixes++;
      return replacement;
    });
    var finalRuleRe = new RegExp('!ruleTriggered\\s*\\[\\s*' + expectedCount + '\\s*\\]', 'g');
    fixed = fixed.replace(finalRuleRe, function() {
      fixes++;
      return '!gameEnded';
    });
  }

  fixed = fixed.replace(/^\s*(?:CompletePhaseProgress|AddCompletedPhase|ReportPhase)\s*\(\s*"(?:gameStart|gameEnd)"\s*\)\s*;\s*$/gm, function() {
    fixes++;
    return '';
  });
  fixed = fixed.replace(/^(\s*)EnterPhase\s*\(\s*\d+\s*,\s*"gameEnd"\s*,\s*false\s*,\s*false\s*\)\s*;\s*$/gm, function(_match, indent) {
    fixes++;
    return indent + 'currentPhaseName = "gameEnd";\n' + indent + 'cameraFocusTarget = "gameEnd";';
  });

  return { code: fixed, changed: fixes > 0, fixes: fixes };
}

function ensureAssemblySlotRunnerCalls(code) {
  if (!code || code.indexOf('AssemblyRun') < 0) {
    return { code: code, changed: false, fixes: 0 };
  }
  var runnerNames = ['Flow', 'Input', 'Resource', 'UI', 'Scene'];
  var missingCalls = [];
  for (var i = 0; i < runnerNames.length; i++) {
    var call = 'AssemblyRun' + runnerNames[i] + 'Slots();';
    var declRe = new RegExp('\\bvoid\\s+AssemblyRun' + runnerNames[i] + 'Slots\\s*\\(');
    if (declRe.test(code) && code.indexOf(call) < 0) missingCalls.push(call);
  }
  if (missingCalls.length === 0) return { code: code, changed: false, fixes: 0 };

  var block = missingCalls.map(function(call) { return '        ' + call; }).join('\n');
  var marker = '// TODO_CUSTOM_START';
  var markerIdx = code.indexOf(marker);
  if (markerIdx >= 0) {
    var insertAt = markerIdx + marker.length;
    return {
      code: code.slice(0, insertAt) + '\n' + block + code.slice(insertAt),
      changed: true,
      fixes: missingCalls.length,
    };
  }

  var updateMatch = /\bvoid\s+Update\s*\(\s*\)\s*\{/.exec(code);
  if (!updateMatch) return { code: code, changed: false, fixes: 0 };
  var start = updateMatch.index + updateMatch[0].length;
  var depth = 1;
  var end = start;
  while (end < code.length && depth > 0) {
    var ch = code[end];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    }
    end++;
  }
  if (depth !== 0) return { code: code, changed: false, fixes: 0 };
  var body = code.substring(start, end);
  var anchor = body.lastIndexOf('UpdateGameState();');
  var insert = anchor >= 0 ? start + anchor : end;
  return {
    code: code.slice(0, insert) + block + '\n' + code.slice(insert),
    changed: true,
    fixes: missingCalls.length,
  };
}

function findMethodBodyRange(code, methodName) {
  var re = new RegExp('\\bvoid\\s+' + methodName + '\\s*\\([^)]*\\)\\s*\\{');
  var m = re.exec(code || '');
  if (!m) return null;
  var start = m.index;
  var bodyStart = m.index + m[0].length;
  var depth = 1;
  var end = bodyStart;
  while (end < code.length && depth > 0) {
    var ch = code[end];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) break;
    }
    end++;
  }
  if (depth !== 0) return null;
  return {
    start: start,
    bodyStart: bodyStart,
    end: end,
    body: code.substring(bodyStart, end),
  };
}

function ensureAssemblySlotRunnerCallsAcrossPartials(mainCode, extraFiles) {
  if (!mainCode || mainCode.indexOf('Update') < 0) {
    return { code: mainCode, changed: false, fixes: 0 };
  }
  var runnerNames = ['Flow', 'Input', 'Resource', 'UI', 'Scene'];
  var allCode = String(mainCode);
  var extras = extraFiles || {};
  Object.keys(extras).forEach(function(name) { allCode += '\n' + String(extras[name] || ''); });
  if (allCode.indexOf('AssemblyRun') < 0) return { code: mainCode, changed: false, fixes: 0 };

  var updateRange = findMethodBodyRange(mainCode, 'Update');
  if (!updateRange) return { code: mainCode, changed: false, fixes: 0 };
  var missingCalls = [];
  for (var i = 0; i < runnerNames.length; i++) {
    var call = 'AssemblyRun' + runnerNames[i] + 'Slots();';
    var declRe = new RegExp('\\bvoid\\s+AssemblyRun' + runnerNames[i] + 'Slots\\s*\\(');
    if (declRe.test(allCode) && updateRange.body.indexOf(call) < 0) missingCalls.push(call);
  }
  if (missingCalls.length === 0) return { code: mainCode, changed: false, fixes: 0 };

  var block = missingCalls.map(function(call) { return '        ' + call; }).join('\n') + '\n';
  var anchor = updateRange.body.lastIndexOf('UpdateGameState();');
  var insertAt = anchor >= 0 ? updateRange.bodyStart + anchor : updateRange.end;
  return {
    code: mainCode.slice(0, insertAt) + block + mainCode.slice(insertAt),
    changed: true,
    fixes: missingCalls.length,
  };
}

// 2026-05-12: deterministic `Camera.main` → `mainCam` rewrite.
// 静态规则 `camera-main` (engine/static-check.cjs:130) blocking — skeleton 提供 `mainCam`
// 缓存字段以避免每帧 `Camera.main` 查找。AI 偶尔写 `Camera.main` 触发 review 派 Codex
// 走 ~7min round 仅为字符串替换。本 patcher 在 deterministic pre-repair 直接全文替换。
//
// 🔒 关键安全约束 (2026-05-12 v0.5.7 regression fix): 必须先确认该文件声明了
// `Camera mainCam` 字段才能替换。GFM_Utils.cs / GFM_Billboard.cs / GFM_CameraController.cs
// 等独立工具类没有 mainCam 字段,它们使用 Camera.main 是合法的;替换会导致 CS0103。
// 注释行/字符串里出现 Camera.main 不替换 (保持 grep/log message 完整)。
function rewriteCameraMainToMainCam(code) {
  if (!code || code.indexOf('Camera.main') < 0) {
    return { code: code, changed: false, fixes: 0 };
  }
  // 必须确认该文件声明了 mainCam 字段(skeleton 模式)。否则替换会破坏独立工具类。
  // 接受形态: `Camera mainCam;` / `Camera mainCam =` / `private Camera mainCam;` 等。
  if (!/\b(?:private|protected|internal|public|static)?\s*Camera\s+mainCam\s*[;=]/.test(code)) {
    return { code: code, changed: false, fixes: 0 };
  }
  // 屏蔽字符串/注释,只在 code mask 内替换
  var mask = new Array(code.length).fill(true);
  var i = 0;
  while (i < code.length) {
    if (code[i] === '/' && code[i+1] === '/') {
      while (i < code.length && code[i] !== '\n') { mask[i] = false; i++; }
    } else if (code[i] === '/' && code[i+1] === '*') {
      mask[i] = false; mask[i+1] = false; i += 2;
      while (i < code.length - 1 && !(code[i] === '*' && code[i+1] === '/')) { mask[i] = false; i++; }
      if (i < code.length - 1) { mask[i] = false; mask[i+1] = false; i += 2; }
    } else if (code[i] === '"') {
      mask[i] = false; i++;
      while (i < code.length && code[i] !== '"' && code[i] !== '\n') {
        if (code[i] === '\\') { mask[i] = false; i++; }
        if (i < code.length) { mask[i] = false; i++; }
      }
      if (i < code.length) { mask[i] = false; i++; }
    } else {
      i++;
    }
  }
  var fixes = 0;
  var out = '';
  var j = 0;
  while (j < code.length) {
    // 命中 Camera.main 且不在 string/comment + 前后非 identifier char
    if (mask[j] && code.substr(j, 11) === 'Camera.main' &&
        !/[A-Za-z0-9_]/.test(code[j - 1] || '') &&
        !/[A-Za-z0-9_]/.test(code[j + 11] || '')) {
      var lineEnd = code.indexOf('\n', j);
      if (lineEnd < 0) lineEnd = code.length;
      var suffix = code.slice(j + 11, lineEnd);
      if (/^\s*;?\s*\/\/\s*(?:(?:说明：)?ok\b|正常)/.test(suffix)) {
        out += 'Camera.main';
        j += 11;
        continue;
      }
      out += 'mainCam';
      j += 11;
      fixes++;
    } else {
      out += code[j];
      j++;
    }
  }
  return { code: fixes > 0 ? out : code, changed: fixes > 0, fixes: fixes };
}

function repairMainCamSelfAssignment(code) {
  if (!code || code.indexOf('mainCam') < 0 || code.indexOf('= mainCam') < 0) {
    return { code: code, changed: false, fixes: 0 };
  }
  var lines = code.split('\n');
  var fixes = 0;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var commentIdx = line.indexOf('//');
    var codePart = commentIdx >= 0 ? line.slice(0, commentIdx) : line;
    if (!/\bmainCam\s*=\s*mainCam\s*;/.test(codePart)) continue;
    var fixedCodePart = codePart.replace(/\bmainCam\s*=\s*mainCam\s*;/g, 'mainCam = Camera.main;');
    lines[i] = fixedCodePart.replace(/\s+$/, '') + ' // 正常';
    fixes++;
  }
  return { code: fixes > 0 ? lines.join('\n') : code, changed: fixes > 0, fixes: fixes };
}

// 2026-05-12: deterministic strip of duplicate Camera.backgroundColor assignments.
// 静态规则 `camera-background-override` (engine/static-check.cjs:1332) 强制要求只保留
// skeleton 在 Start() 中的预设;AI 在 OnTap/Update/phase-init 等位置重写 backgroundColor
// 会触发 blocking,review fix-loop 派 Codex 走一整轮 (~8min) 仅为删几行。
//
// 修复:文件内 source order 首次出现保留(skeleton 预设),后续全部 strip。
// 注释模式跟同文件其他 strip 函数 (stripEarlyShowCTA) 对齐:整行替换为带 //
// 占位注释,便于人工排查 commit diff。
function stripExcessCameraBackgroundAssignments(code) {
  if (!code) return { code: code, changed: false, fixes: 0 };
  // 字符串/注释屏蔽,避免误删字面量中的 backgroundColor
  var stripped = code
    .replace(/\/\*[\s\S]*?\*\//g, function(m) { return m.replace(/[^\n]/g, ' '); })
    .replace(/\/\/[^\n]*/g, function(m) { return ' '.repeat(m.length); })
    .replace(/"(?:[^"\\]|\\.)*"/g, function(m) { return '"' + ' '.repeat(Math.max(0, m.length - 2)) + '"'; });
  var re = /(?:Camera|mainCam)\s*\.\s*backgroundColor\s*=/g;
  var hits = [];
  var m;
  while ((m = re.exec(stripped)) !== null) hits.push(m.index);
  if (hits.length <= 1) return { code: code, changed: false, fixes: 0 };

  // hits[0] 是 skeleton 预设保留;hits[1..] strip。倒序处理避免后续 index 漂移。
  var fixes = 0;
  var nextCode = code;
  for (var i = hits.length - 1; i >= 1; i--) {
    var stmtStart = hits[i];
    // 找语句结束 `;` (源串里相同 offset)
    var semiIdx = nextCode.indexOf(';', stmtStart);
    if (semiIdx < 0) continue;
    // 向前找语句起点(行首,或上一个 `{`/`;`)
    var lineStart = nextCode.lastIndexOf('\n', stmtStart);
    if (lineStart < 0) lineStart = 0; else lineStart++;
    var indent = '';
    for (var k = lineStart; k < nextCode.length && /[ \t]/.test(nextCode[k]); k++) indent += nextCode[k];
    // 替换整条语句为占位注释 (保留缩进)
    nextCode = nextCode.slice(0, lineStart) +
      indent + '// [REVIEW REPAIR] stripped duplicate Camera.backgroundColor assignment — skeleton Start() preset is the only source of truth.\n' +
      nextCode.slice(semiIdx + 1).replace(/^[ \t]*\n/, '');
    fixes++;
  }
  return { code: nextCode, changed: fixes > 0, fixes: fixes };
}

// 2026-05-31 Option C: deterministic strip of non-ASCII chars from string literals
// passed to APIs scanned by static rule `non-ascii-resource-key`. LLM (gpt-5.5)
// in codegen-custom occasionally writes Chinese / fullwidth / whitespace keys
// despite the skeleton comment block; this fix is applied during review
// pre-repair so the fix-loop converges instead of spinning 3 rounds.
function sanitizeNonAsciiResourceApiKeys(code) {
  if (!code) return { code: code, changed: false, fixes: 0 };
  // Wave 1.b: 白名单 + charset 迁到 registry, 与 static-check.cjs non-ascii-resource-key
  // 同源。registry 存 canonical 形式 (未转义点号), build regex 时自己转义。
  var apis = staticRuleRegistry.RESOURCE_API_KEY_APIS;
  var nonAsciiRe = staticRuleRegistry.RESOURCE_API_KEY_NON_ASCII_RE;
  var fixes = 0;
  var fixed = code;
  apis.forEach(function(api) {
    var apiRe = api.replace(/\./g, '\\.');
    var re = new RegExp('(' + apiRe + '\\s*\\(\\s*)"([^"]*)"', 'g');
    fixed = fixed.replace(re, function(match, prefix, literal) {
      if (literal === '') return match;
      if (!nonAsciiRe.test(literal)) return match;
      // Sanitize: keep only [A-Za-z0-9_], collapse remaining to underscores
      var ascii = literal.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
      // Cap length to prevent absurd identifiers
      if (ascii.length > 32) ascii = ascii.slice(0, 32);
      // API-specific fallbacks when sanitization yields empty
      if (!ascii) {
        // registry APIs already canonical (unescaped) — api IS cleanApi.
        var cleanApi = api;
        if (cleanApi === 'EnterPhase' || cleanApi === 'CompletePhaseProgress' || cleanApi === 'NotifyPhaseProgress') {
          ascii = 'phase';
        } else if (cleanApi === 'RecordPhaseEvidenceFlag') {
          ascii = 'evidence';
        } else if (/ResourceIds|AddResource|TrySpend|GetResource|TryConvert/.test(cleanApi)) {
          ascii = 'Resource';
        } else if (cleanApi === 'GameObject.Find') {
          ascii = 'Entity';
        } else {
          ascii = 'key';
        }
      }
      fixes++;
      return prefix + '"' + ascii + '"';
    });
  });
  return { code: fixed, changed: fixes > 0, fixes: fixes };
}

function rewriteHotPathVectorAllocations(code) {
  if (!code || code.indexOf('new Vector3') < 0) {
    return { code: code, changed: false, fixes: 0 };
  }
  var fixes = 0;
  var fixed = code;
  function isZeroDelta(raw) {
    var text = String(raw || '').replace(/\s/g, '');
    return /^[-+]?0(?:\.0+)?(?:f|d|m)?$/i.test(text);
  }
  function buildStructCopy(varName, anchorExpr, dx, dy, dz, targetExpr) {
    var parts = ['var ' + varName + ' = ' + anchorExpr + ';'];
    if (dx && dx.trim() && !isZeroDelta(dx)) parts.push(varName + '.x += ' + dx.trim() + ';');
    if (dy && dy.trim() && !isZeroDelta(dy)) parts.push(varName + '.y += ' + dy.trim() + ';');
    if (dz && dz.trim() && !isZeroDelta(dz)) parts.push(varName + '.z += ' + dz.trim() + ';');
    parts.push(targetExpr + ' = ' + varName + ';');
    return parts.join(' ');
  }
  function buildVectorCopy(varName, anchorExpr, dx, dy, dz, declarationKeyword) {
    var parts = [(declarationKeyword ? declarationKeyword + ' ' : '') + varName + ' = ' + anchorExpr + ';'];
    if (dx && dx.trim() && !isZeroDelta(dx)) parts.push(varName + '.x += ' + dx.trim() + ';');
    if (dy && dy.trim() && !isZeroDelta(dy)) parts.push(varName + '.y += ' + dy.trim() + ';');
    if (dz && dz.trim() && !isZeroDelta(dz)) parts.push(varName + '.z += ' + dz.trim() + ';');
    return parts.join(' ');
  }
  function normalizeDelta(raw) {
    var text = String(raw || '').trim();
    if (!text) return '';
    return text.replace(/^\+\s*/, '').trim();
  }
  fixed = fixed.replace(/([A-Za-z_][A-Za-z0-9_]*)\.transform\.position\s*=\s*\1\.transform\.position\s*\+\s*new\s+Vector3\s*\(\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^)]+)\s*\)\s*;/g,
    function(_m, obj, dx, dy, dz) {
      fixes++;
      return buildStructCopy('__hpPos' + fixes, obj + '.transform.position', dx, dy, dz, obj + '.transform.position');
    });
  fixed = fixed.replace(/([A-Za-z_][A-Za-z0-9_]*)\.transform\.position\s*=\s*new\s+Vector3\s*\(\s*\1\.transform\.position\.x\s*,\s*\1\.transform\.position\.y\s*\+\s*([^,]+)\s*,\s*\1\.transform\.position\.z\s*\)\s*;/g,
    function(_m, obj, dy) {
      fixes++;
      return buildStructCopy('__hpPos' + fixes, obj + '.transform.position', '', dy, '', obj + '.transform.position');
    });
  fixed = fixed.replace(/([A-Za-z_][A-Za-z0-9_]*)\.transform\.position\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\.transform\.position\s*\+\s*new\s+Vector3\s*\(\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^)]+)\s*\)\s*;/g,
    function(_m, targetObj, anchorObj, dx, dy, dz) {
      fixes++;
      return buildStructCopy('__hpPos' + fixes, anchorObj + '.transform.position', dx, dy, dz, targetObj + '.transform.position');
    });
  fixed = fixed.replace(/([A-Za-z_][A-Za-z0-9_]*)\.transform\.position\s*\+=\s*new\s+Vector3\s*\(\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^)]+)\s*\)\s*;/g,
    function(_m, obj, dx, dy, dz) {
      fixes++;
      return buildStructCopy('__hpPos' + fixes, obj + '.transform.position', dx, dy, dz, obj + '.transform.position');
    });
  fixed = fixed.replace(/\b(var|Vector3)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\.transform\.position\s*\+\s*new\s+Vector3\s*\(\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^)]+)\s*\)\s*;/g,
    function(_m, decl, varName, anchorObj, dx, dy, dz) {
      fixes++;
      return buildVectorCopy(varName, anchorObj + '.transform.position', dx, dy, dz, decl);
    });
  fixed = fixed.replace(/(^|[;\s{}])([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\.transform\.position\s*\+\s*new\s+Vector3\s*\(\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^)]+)\s*\)\s*;/gm,
    function(_m, prefix, varName, anchorObj, dx, dy, dz) {
      fixes++;
      return prefix + buildVectorCopy(varName, anchorObj + '.transform.position', dx, dy, dz, '');
    });
  fixed = fixed.replace(/([A-Za-z_][A-Za-z0-9_]*)\.transform\.position\s*=\s*new\s+Vector3\s*\(\s*\1\.transform\.position\.x\s*([+-]\s*[^,()]+)?\s*,\s*\1\.transform\.position\.y\s*([+-]\s*[^,()]+)?\s*,\s*\1\.transform\.position\.z\s*([+-]\s*[^,)]+)?\s*\)\s*;/g,
    function(_m, obj, dx, dy, dz) {
      var ndx = normalizeDelta(dx);
      var ndy = normalizeDelta(dy);
      var ndz = normalizeDelta(dz);
      if (!ndx && !ndy && !ndz) return _m;
      fixes++;
      return buildStructCopy('__hpPos' + fixes, obj + '.transform.position', ndx, ndy, ndz, obj + '.transform.position');
    });
  return { code: fixed, changed: fixes > 0, fixes: fixes };
}

function guardFloatingTextTransformPosition(code) {
  if (!code || code.indexOf('ShowFloatingText') < 0 || code.indexOf('.transform.position') < 0) {
    return { code: code, changed: false, fixes: 0 };
  }
  var fixes = 0;
  var fixed = code;
  fixed = fixed.replace(
    /\bShowFloatingText\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*transform\s*\.\s*position\s*\+\s*new\s+Vector3\s*\(([^)]*)\)\s*,/g,
    function(_m, obj, vectorArgs) {
      fixes++;
      return 'ShowFloatingText(' + obj + ' != null ? ' + obj + '.transform.position + new Vector3(' + vectorArgs + ') : Vector3.zero,';
    }
  );
  fixed = fixed.replace(
    /\bShowFloatingText\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*transform\s*\.\s*position\s*,/g,
    function(_m, obj) {
      fixes++;
      return 'ShowFloatingText(' + obj + ' != null ? ' + obj + '.transform.position : Vector3.zero,';
    }
  );
  return { code: fixed, changed: fixes > 0, fixes: fixes };
}

function guardPlayerTransformDistanceReads(code) {
  if (!code || code.indexOf('player.transform.position') < 0 || code.indexOf('Vector3.Distance') < 0) {
    return { code: code, changed: false, fixes: 0 };
  }
  var lines = String(code || '').split('\n');
  var out = [];
  var fixes = 0;
  function isInsideVoidMethod(lineIndex) {
    for (var k = lineIndex; k >= 0 && k >= lineIndex - 40; k--) {
      var line = lines[k] || '';
      if (/^\s*(?:public|private|protected|internal|static|virtual|override|sealed|new|async|\s)*void\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(line)) return true;
      if (/^\s*(?:public|private|protected|internal|static|virtual|override|sealed|new|async|\s)*(?:bool|int|float|string|Vector[234]|GameObject|Color|Transform)\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(line)) return false;
    }
    return false;
  }
  function hasNearbySafePlayer(lineIndex) {
    var start = Math.max(0, lineIndex - 5);
    for (var k = start; k < lineIndex; k++) {
      if (/\b__safePlayer\s*=\s*player\b/.test(lines[k] || '')) return true;
    }
    return false;
  }
  var safePlayerActiveFor = 0;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var m = /Vector3\.Distance\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\.transform\.position\s*,\s*player\.transform\.position\s*\)/.exec(line);
    if (!m) {
      m = /Vector3\.Distance\s*\(\s*player\.transform\.position\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\.transform\.position\s*\)/.exec(line);
    }
    if (m && isInsideVoidMethod(i) && !hasNearbySafePlayer(i)) {
      var indent = (/^(\s*)/.exec(line) || ['', ''])[1];
      out.push(indent + 'var __safePlayer = player;');
      out.push(indent + 'if (__safePlayer == null || ' + m[1] + ' == null) return;');
      fixes++;
      safePlayerActiveFor = 12;
    }
    if (safePlayerActiveFor > 0) {
      line = line.replace(/\bplayer\.transform\.position\b/g, '__safePlayer.transform.position');
      safePlayerActiveFor--;
    }
    out.push(line);
  }
  return { code: fixes > 0 ? out.join('\n') : code, changed: fixes > 0, fixes: fixes };
}

function normalizeSetScaleCalls(code) {
  if (!code || code.indexOf('SetScale(') < 0) {
    return { code: code, changed: false, fixes: 0 };
  }
  var fixes = 0;
  var fixed = code;
  fixed = fixed.replace(/\bSetScale\s*\(\s*([^,\n()]+?)\s*,\s*([^,\n()]+?)\s*,\s*\2\s*,\s*\2\s*\)\s*;/g, function(_m, obj, uniform) {
    fixes++;
    return 'SetScale(' + obj.trim() + ', ' + uniform.trim() + ');';
  });
  fixed = fixed.replace(/\bSetScale\s*\(\s*([^,\n()]+?)\s*,\s*([^,\n()]+?)\s*,\s*([^,\n()]+?)\s*,\s*([^,\n()]+?)\s*,\s*([^,\n()]+?)\s*\)\s*;/g, function(_m, obj, x, y, z, extra) {
    var extraNorm = String(extra || '').trim();
    if (extraNorm === '0' || extraNorm === '0f' || extraNorm === '1' || extraNorm === '1f') {
      fixes++;
      return 'SetScale(' + obj.trim() + ', ' + x.trim() + ', ' + y.trim() + ', ' + z.trim() + ');';
    }
    return _m;
  });
  return { code: fixed, changed: fixes > 0, fixes: fixes };
}

function stripInteractionFlagShortcutsFromPhaseGates(code, blueprint) {
  if (!code || code.indexOf('ruleTriggered[') < 0 || code.indexOf('||') < 0) {
    return { code: code, changed: false, fixes: 0 };
  }
  var specCount = blueprint && Array.isArray(blueprint.specs) ? blueprint.specs.length : 0;
  if (specCount <= 1) return { code: code, changed: false, fixes: 0 };
  var fixed = code;
  var fixes = 0;
  function splitTopLevelOr(text) {
    var parts = [];
    var start = 0;
    var depth = 0;
    for (var i = 0; i < text.length - 1; i++) {
      var ch = text[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      if (depth === 0 && text[i] === '|' && text[i + 1] === '|') {
        parts.push(text.substring(start, i));
        start = i + 2;
        i++;
      }
    }
    parts.push(text.substring(start));
    return parts;
  }
  function isFlagOnlyTerm(text) {
    var normalized = String(text || '').trim()
      .replace(/^\(+\s*/, '')
      .replace(/\s*\)+$/, '')
      .trim();
    return /^[A-Za-z_][A-Za-z0-9_]*(?:InteractionDone|PlayerActed|Done)$/.test(normalized);
  }
  function stripGroups(text) {
    var out = '';
    var changedLocal = 0;
    for (var i = 0; i < text.length; i++) {
      if (text[i] !== '(') {
        out += text[i];
        continue;
      }
      var start = i;
      var depth = 1;
      var end = i + 1;
      while (end < text.length && depth > 0) {
        if (text[end] === '(') depth++;
        else if (text[end] === ')') depth--;
        end++;
      }
      if (depth !== 0) {
        out += text.slice(start);
        break;
      }
      var inner = text.substring(start + 1, end - 1);
      var rewrittenInner = stripGroups(inner);
      var pieces = splitTopLevelOr(rewrittenInner);
      if (pieces.length > 1) {
        var kept = pieces.filter(function(piece) { return !isFlagOnlyTerm(piece); });
        if (kept.length > 0 && kept.length < pieces.length) {
          rewrittenInner = kept.join(' || ').trim();
          changedLocal++;
        } else {
          rewrittenInner = rewrittenInner.trim();
        }
      }
      out += '(' + rewrittenInner + ')';
      i = end - 1;
    }
    return changedLocal > 0 ? out : text;
  }
  var re = /if\s*\(\s*!\s*ruleTriggered\[\s*(\d+)\s*\]/g;
  var m;
  while ((m = re.exec(fixed)) !== null) {
    var ruleIdx = parseInt(m[1], 10);
    if (!(ruleIdx > 0 && ruleIdx < specCount)) continue;
    var condStart = m.index + m[0].length;
    var depth = 1;
    var condEnd = condStart;
    while (condEnd < fixed.length && depth > 0) {
      var ch = fixed[condEnd];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) break;
      }
      condEnd++;
    }
    if (depth !== 0) continue;
    var cond = fixed.substring(condStart, condEnd);
    if (cond.indexOf('||') < 0) continue;
    var nextCond = stripGroups(cond).replace(/\s{2,}/g, ' ');
    if (nextCond === cond) continue;
    if (/\(\s*\)/.test(nextCond) || /\|\|\s*\)|\(\s*\|\||&&\s*&&|\|\|\s*\|\||&&\s*\)/.test(nextCond)) continue;
    fixed = fixed.slice(0, condStart) + nextCond + fixed.slice(condEnd);
    fixes++;
    re.lastIndex = 0;
  }
  return { code: fixed, changed: fixes > 0, fixes: fixes };
}

function repairPhaseGateRuntimeMoves(code) {
  if (!code || code.indexOf('EntityAdvanced(') < 0) {
    return { code: code, changed: false, fixes: 0 };
  }

  function extractMethodRange(src, methodName) {
    var sigRe = new RegExp('\\bvoid\\s+' + methodName + '\\s*\\([^)]*\\)\\s*\\{');
    var m = sigRe.exec(src);
    if (!m) return null;
    var start = m.index;
    var bodyStart = m.index + m[0].length;
    var depth = 1;
    var end = bodyStart;
    while (end < src.length && depth > 0) {
      var ch = src[end];
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) break; }
      end++;
    }
    if (depth !== 0) return null;
    return {
      start: start,
      bodyStart: bodyStart,
      end: end,
      body: src.substring(bodyStart, end),
    };
  }

  function isInsideRanges(idx, ranges) {
    for (var i = 0; i < ranges.length; i++) {
      if (idx >= ranges[i].start && idx <= ranges[i].end) return true;
    }
    return false;
  }

  function extractSnapshotEntities(src) {
    var byPhase = {};
    var snapRe = /void\s+Snapshot_([A-Za-z0-9_]+)_GateEntities\s*\(\)\s*\{([\s\S]*?)\n\s*\}/g;
    var sm;
    while ((sm = snapRe.exec(src)) !== null) {
      var pid = sm[1];
      var body = sm[2];
      var entities = [];
      var seen = {};
      var entRe = /_snap_([A-Za-z_][A-Za-z0-9_]*)Pos\b/g;
      var em;
      while ((em = entRe.exec(body)) !== null) {
        if (seen[em[1]]) continue;
        seen[em[1]] = true;
        entities.push(em[1]);
      }
      if (entities.length > 0) byPhase[pid] = entities;
    }
    return byPhase;
  }

  function collectInitRanges(src, phaseIds) {
    var ranges = [];
    for (var i = 0; i < phaseIds.length; i++) {
      var mr = extractMethodRange(src, 'Phase_' + phaseIds[i] + '_Init');
      if (mr) ranges.push({ start: mr.start, end: mr.end });
    }
    return ranges;
  }

  function collectTodoInitRanges(src) {
    var ranges = [];
    var re = /\/\/\s*TODO_PHASE_(\d+)_INIT_START[\s\S]*?\/\/\s*TODO_PHASE_\1_INIT_END/g;
    var m;
    while ((m = re.exec(src)) !== null) {
      ranges.push({ start: m.index, end: m.index + m[0].length });
    }
    return ranges;
  }

  function hasRuntimeMove(src, entityName, initRanges) {
    var moveRe = new RegExp(
      '\\bPlaceObj\\s*\\(\\s*' + entityName + '\\b' +
      '|\\bHideObj\\s*\\(\\s*' + entityName + '\\b' +
      '|\\b' + entityName + '\\s*\\.\\s*transform\\s*\\.\\s*position\\s*=',
      'g'
    );
    var mm;
    while ((mm = moveRe.exec(src)) !== null) {
      if (!isInsideRanges(mm.index, initRanges)) return true;
    }
    return false;
  }

  function getInitMoveLines(initBody, entityName) {
    var lines = initBody.split('\n');
    var matches = [];
    for (var i = 0; i < lines.length; i++) {
      var trimmed = lines[i].trim();
      if (!trimmed) continue;
      if (!new RegExp('^(PlaceObj|HideObj)\\s*\\(\\s*' + entityName + '\\b').test(trimmed) &&
          !new RegExp('^' + entityName + '\\s*\\.\\s*transform\\s*\\.\\s*position\\s*=').test(trimmed)) {
        continue;
      }
      matches.push('        ' + trimmed);
    }
    return matches;
  }

  function indentLines(lines, prefix) {
    return (lines || []).map(function(line) {
      return prefix + String(line || '').trim();
    });
  }

  function buildFallbackMoveLines(entityName, ordinal, phaseId) {
    var safePhase = phaseId ? String(phaseId).replace(/[^A-Za-z0-9_]/g, '_') : '';
    var varName = safePhase ? ('__gateMovePos_' + safePhase + '_' + entityName + '_' + ordinal) : ('__gateMovePos' + ordinal);
    return [
      '        if (' + entityName + ' != null)',
      '        {',
      '            var ' + varName + ' = ' + entityName + '.transform.position;',
      '            ' + varName + '.y += 2f;',
      '            ' + entityName + '.transform.position = ' + varName + ';',
      '        }',
    ];
  }

  function insertLinesIntoHandler(src, pid, handlerSuffix, linesToInsert) {
    if (!linesToInsert || linesToInsert.length === 0) return { code: src, changed: false };
    var startMarker = '// TODO_PHASE_' + pid + '_' + handlerSuffix + '_START';
    var endMarker = '// TODO_PHASE_' + pid + '_' + handlerSuffix + '_END';
    var startIdx = src.indexOf(startMarker);
    var endIdx = src.indexOf(endMarker);
    if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) return { code: src, changed: false };
    var block = src.substring(startIdx, endIdx);
    var needsAny = false;
    for (var i = 0; i < linesToInsert.length; i++) {
      if (block.indexOf(linesToInsert[i].trim()) < 0) {
        needsAny = true;
        break;
      }
    }
    if (!needsAny) return { code: src, changed: false };
    var insertAt = endIdx;
    var prefix = src.substring(0, insertAt);
    if (!/\n\s*$/.test(prefix)) prefix += '\n';
    var insertion = linesToInsert.join('\n') + '\n';
    return {
      code: prefix + insertion + src.substring(insertAt),
      changed: true,
    };
  }

  function extractInlinePhaseDefs(src) {
    var defs = [];
    var startRe = /if\s*\(\s*!ruleTriggered\[(\d+)\][\s\S]*?\)\s*\{/g;
    var sm;
    while ((sm = startRe.exec(src)) !== null) {
      var phaseOrdinal = sm[1];
      var bodyStart = sm.index + sm[0].length;
      var depth = 1;
      var end = bodyStart;
      while (end < src.length && depth > 0) {
        var ch = src[end];
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) break; }
        end++;
      }
      if (depth !== 0) continue;
      var body = src.substring(bodyStart, end);
      var phaseIdMatch = /currentPhaseName\s*=\s*"([^"]+)"/.exec(body);
      if (!phaseIdMatch) continue;
      var phaseId = phaseIdMatch[1];
      var entities = [];
      var seen = {};
      var entRe = /_snap_([A-Za-z_][A-Za-z0-9_]*)Pos\b/g;
      var em;
      while ((em = entRe.exec(body)) !== null) {
        if (seen[em[1]]) continue;
        seen[em[1]] = true;
        entities.push(em[1]);
      }
      var initRe = new RegExp('//\\s*TODO_PHASE_' + phaseOrdinal + '_INIT_START([\\s\\S]*?)//\\s*TODO_PHASE_' + phaseOrdinal + '_INIT_END');
      var initMatch = initRe.exec(body);
      defs.push({
        phaseId: phaseId,
        phaseOrdinal: phaseOrdinal,
        entities: entities,
        initBody: initMatch ? initMatch[1] : '',
      });
    }
    return defs;
  }

  function insertLinesIntoSwitchCase(src, methodName, phaseId, linesToInsert) {
    if (!linesToInsert || linesToInsert.length === 0) return { code: src, changed: false };
    var methodRange = extractMethodRange(src, methodName);
    if (!methodRange) return { code: src, changed: false };
    var methodBody = src.substring(methodRange.bodyStart, methodRange.end);
    var caseToken = 'case "' + phaseId + '":';
    var caseIdx = methodBody.indexOf(caseToken);
    if (caseIdx < 0) return { code: src, changed: false };
    var absCaseIdx = methodRange.bodyStart + caseIdx;
    var nextCaseIdx = src.indexOf('\n    case "', absCaseIdx + caseToken.length);
    var nextDefaultIdx = src.indexOf('\n    default:', absCaseIdx + caseToken.length);
    var blockEnd = methodRange.end;
    if (nextCaseIdx >= 0 && nextCaseIdx < blockEnd) blockEnd = nextCaseIdx;
    if (nextDefaultIdx >= 0 && nextDefaultIdx < blockEnd) blockEnd = nextDefaultIdx;
    var block = src.substring(absCaseIdx, blockEnd);
    var needed = false;
    for (var i = 0; i < linesToInsert.length; i++) {
      if (block.indexOf(String(linesToInsert[i]).trim()) < 0) {
        needed = true;
        break;
      }
    }
    if (!needed) return { code: src, changed: false };
    var breakIdx = block.lastIndexOf('\n        break;');
    var insertAt = breakIdx >= 0 ? absCaseIdx + breakIdx + 1 : blockEnd;
    var prefix = src.substring(0, insertAt);
    if (!/\n\s*$/.test(prefix)) prefix += '\n';
    return {
      code: prefix + linesToInsert.join('\n') + '\n' + src.substring(insertAt),
      changed: true,
    };
  }

  function insertLinesIntoCurrentPhaseBranch(src, methodName, phaseId, linesToInsert) {
    if (!linesToInsert || linesToInsert.length === 0) return { code: src, changed: false };
    var methodRange = extractMethodRange(src, methodName);
    if (!methodRange) return { code: src, changed: false };
    var methodBody = src.substring(methodRange.bodyStart, methodRange.end);
    var branchRe = new RegExp('if\\s*\\(\\s*currentPhaseName\\s*==\\s*"' + phaseId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"\\s*\\)\\s*\\{', 'g');
    var branchMatch = branchRe.exec(methodBody);
    if (!branchMatch) return { code: src, changed: false };
    var blockStart = methodRange.bodyStart + branchMatch.index;
    var bodyStart = blockStart + branchMatch[0].length;
    var depth = 1;
    var end = bodyStart;
    while (end < src.length && depth > 0) {
      var ch = src[end];
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) break; }
      end++;
    }
    if (depth !== 0) return { code: src, changed: false };
    var block = src.substring(blockStart, end);
    var needed = false;
    for (var i = 0; i < linesToInsert.length; i++) {
      if (block.indexOf(String(linesToInsert[i]).trim()) < 0) {
        needed = true;
        break;
      }
    }
    if (!needed) return { code: src, changed: false };
    var insertAt = end;
    var prefix = src.substring(0, insertAt);
    if (!/\n\s*$/.test(prefix)) prefix += '\n';
    return {
      code: prefix + linesToInsert.join('\n') + '\n' + src.substring(insertAt),
      changed: true,
    };
  }

  var snapshotEntities = extractSnapshotEntities(code);
  var phaseIds = Object.keys(snapshotEntities);
  var fixed = code;
  var fixes = 0;
  var fallbackOrdinal = 0;
  var legacyInitRanges = collectInitRanges(fixed, phaseIds);
  for (var pi = 0; pi < phaseIds.length; pi++) {
    var pid = phaseIds[pi];
    var entities = snapshotEntities[pid];
    if (!entities || entities.length === 0) continue;
    var initMethod = extractMethodRange(fixed, 'Phase_' + pid + '_Init');
    if (!initMethod) continue;
    for (var ei = 0; ei < entities.length; ei++) {
      var entityName = entities[ei];
      if (hasRuntimeMove(fixed, entityName, legacyInitRanges)) continue;
      var moveLines = getInitMoveLines(initMethod.body, entityName);
      if (moveLines.length === 0) {
        fallbackOrdinal++;
        moveLines = buildFallbackMoveLines(entityName, fallbackOrdinal);
      }
      var onTapRes = insertLinesIntoHandler(fixed, pid, 'ONTAP', moveLines);
      if (onTapRes.changed) {
        fixed = onTapRes.code;
        fixes++;
      }
      var onAutoRes = insertLinesIntoHandler(fixed, pid, 'ONAUTOARRIVE', moveLines);
      if (onAutoRes.changed) {
        fixed = onAutoRes.code;
        fixes++;
      }
    }
  }

  var inlineDefs = extractInlinePhaseDefs(fixed);
  if (inlineDefs.length === 0) {
    return { code: fixed, changed: fixes > 0, fixes: fixes };
  }
  var inlineInitRanges = collectTodoInitRanges(fixed);
  for (var ii = 0; ii < inlineDefs.length; ii++) {
    var def = inlineDefs[ii];
    if (!def.entities || def.entities.length === 0) continue;
    for (var ij = 0; ij < def.entities.length; ij++) {
      var inlineEntity = def.entities[ij];
      if (hasRuntimeMove(fixed, inlineEntity, inlineInitRanges)) continue;
      var inlineMoves = indentLines(getInitMoveLines(def.initBody, inlineEntity), '            ');
      if (inlineMoves.length === 0) {
        fallbackOrdinal++;
        inlineMoves = indentLines(buildFallbackMoveLines(inlineEntity, fallbackOrdinal), '            ');
      }
      var updateRes = insertLinesIntoSwitchCase(fixed, 'Update', def.phaseId, inlineMoves);
      if (!updateRes.changed) {
        updateRes = insertLinesIntoCurrentPhaseBranch(fixed, 'Update', def.phaseId, inlineMoves);
      }
      if (updateRes.changed) {
        fixed = updateRes.code;
        fixes++;
      }
      var autoRes = insertLinesIntoSwitchCase(fixed, 'OnAutoPlayArrive', def.phaseId, inlineMoves);
      if (!autoRes.changed) {
        autoRes = insertLinesIntoCurrentPhaseBranch(fixed, 'OnAutoPlayArrive', def.phaseId, inlineMoves);
      }
      if (autoRes.changed) {
        fixed = autoRes.code;
        fixes++;
      }
    }
  }

  return { code: fixed, changed: fixes > 0, fixes: fixes };
}

function repairPhaseGateRuntimeMovesAcrossPartials(mainCode, extraFiles) {
  var nextMain = String(mainCode || '');
  var nextExtras = Object.assign({}, extraFiles || {});
  if (!nextMain || nextMain.indexOf('EntityAdvanced(') < 0) {
    return { code: nextMain, extraFiles: nextExtras, changed: false, fixes: 0 };
  }

  function extractMethodRange(src, methodName) {
    var sigRe = new RegExp('\\bvoid\\s+' + methodName + '\\s*\\([^)]*\\)\\s*\\{');
    var m = sigRe.exec(src);
    if (!m) return null;
    var start = m.index;
    var bodyStart = m.index + m[0].length;
    var depth = 1;
    var end = bodyStart;
    while (end < src.length && depth > 0) {
      var ch = src[end];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) break;
      }
      end++;
    }
    if (depth !== 0) return null;
    return {
      start: start,
      bodyStart: bodyStart,
      end: end,
      body: src.substring(bodyStart, end),
    };
  }

  function hasMoveInText(src, entityName) {
    if (!src || !entityName) return false;
    var moveRe = new RegExp(
      '\\bPlaceObj\\s*\\(\\s*' + entityName + '\\b' +
      '|\\bHideObj\\s*\\(\\s*' + entityName + '\\b' +
      '|\\b' + entityName + '\\s*\\.\\s*transform\\s*\\.\\s*position\\s*=',
      'g'
    );
    return moveRe.test(src);
  }

  function extractPhaseDefsFromMain(src) {
    var defsById = {};
    var startRe = /if\s*\(\s*!ruleTriggered\[(\d+)\][\s\S]*?\)\s*\{/g;
    var sm;
    while ((sm = startRe.exec(src)) !== null) {
      var bodyStart = sm.index + sm[0].length;
      var depth = 1;
      var end = bodyStart;
      while (end < src.length && depth > 0) {
        var ch = src[end];
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) break;
        }
        end++;
      }
      if (depth !== 0) continue;
      var block = src.substring(sm.index, end + 1);
      var phaseIdMatch = /\bcurrentPhaseName\s*==\s*"([^"]+)"/.exec(block);
      if (!phaseIdMatch) phaseIdMatch = /\bEnterPhase\s*\(\s*[^,]+,\s*"([^"]+)"/.exec(block);
      if (!phaseIdMatch) phaseIdMatch = /\bcurrentPhaseName\s*=\s*"([^"]+)"/.exec(block);
      if (!phaseIdMatch) continue;
      var phaseId = phaseIdMatch[1];
      if (!defsById[phaseId]) defsById[phaseId] = { phaseId: phaseId, entities: [] };
      var seen = {};
      for (var si = 0; si < defsById[phaseId].entities.length; si++) seen[defsById[phaseId].entities[si]] = true;
      var entRe = /_snap_([A-Za-z_][A-Za-z0-9_]*)Pos\b/g;
      var em;
      while ((em = entRe.exec(block)) !== null) {
        if (seen[em[1]]) continue;
        seen[em[1]] = true;
        defsById[phaseId].entities.push(em[1]);
      }
    }
    return Object.keys(defsById).map(function(key) { return defsById[key]; });
  }

  function collectInitBodies(filesByName) {
    var byPhase = {};
    Object.keys(filesByName).forEach(function(name) {
      var src = String(filesByName[name] || '');
      var initRe = /void\s+Phase_([A-Za-z0-9_]+)_Init\s*\(\)\s*\{([\s\S]*?)\n\s*\}/g;
      var m;
      while ((m = initRe.exec(src)) !== null) {
        if (!byPhase[m[1]]) byPhase[m[1]] = m[2];
      }
    });
    return byPhase;
  }

  function getInitMoveLines(initBody, entityName) {
    var lines = String(initBody || '').split('\n');
    var matches = [];
    for (var i = 0; i < lines.length; i++) {
      var trimmed = lines[i].trim();
      if (!trimmed) continue;
      if (!new RegExp('^(PlaceObj|HideObj)\\s*\\(\\s*' + entityName + '\\b').test(trimmed) &&
          !new RegExp('^' + entityName + '\\s*\\.\\s*transform\\s*\\.\\s*position\\s*=').test(trimmed)) {
        continue;
      }
      matches.push('        ' + trimmed);
    }
    return matches;
  }

  function buildFallbackMoveLines(entityName, ordinal, phaseId) {
    var safePhase = phaseId ? String(phaseId).replace(/[^A-Za-z0-9_]/g, '_') : '';
    var varName = safePhase ? ('__gateMovePos_' + safePhase + '_' + entityName + '_' + ordinal) : ('__gateMovePos' + ordinal);
    return [
      '        if (' + entityName + ' != null)',
      '        {',
      '            var ' + varName + ' = ' + entityName + '.transform.position;',
      '            ' + varName + '.y += 2f;',
      '            ' + entityName + '.transform.position = ' + varName + ';',
      '        }',
    ];
  }

  function dedupeLines(lines) {
    var out = [];
    var seen = {};
    for (var i = 0; i < lines.length; i++) {
      var normalized = String(lines[i] || '').trim();
      if (!normalized || seen[normalized]) continue;
      seen[normalized] = true;
      out.push(lines[i]);
    }
    return out;
  }

  function updateHasPhaseScopedMove(src, phaseId, entityName) {
    var update = extractMethodRange(src, 'Update');
    if (!update) return false;
    var body = update.body;
    var branchRe = new RegExp('currentPhaseName\\s*==\\s*"' + phaseId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"([\\s\\S]{0,1200})', 'g');
    var bm;
    while ((bm = branchRe.exec(body)) !== null) {
      if (hasMoveInText(bm[0], entityName)) return true;
    }
    return false;
  }

  function methodHasPhaseMove(src, methodName, entityName) {
    var range = extractMethodRange(src, methodName);
    if (!range) return false;
    return hasMoveInText(range.body, entityName);
  }

  function handlerHasPhaseMove(filesByName, phaseId, suffix, entityName) {
    var methodName = suffix === 'ONTAP' ? ('Phase_' + phaseId + '_OnTap') : ('Phase_' + phaseId + '_OnAutoPlayArrive');
    var names = Object.keys(filesByName);
    for (var i = 0; i < names.length; i++) {
      if (methodHasPhaseMove(filesByName[names[i]], methodName, entityName)) return true;
    }
    return false;
  }

  function insertLinesIntoHandler(src, pid, handlerSuffix, linesToInsert) {
    if (!linesToInsert || linesToInsert.length === 0) return { code: src, changed: false };
    var startMarker = '// TODO_PHASE_' + pid + '_' + handlerSuffix + '_START';
    var endMarker = '// TODO_PHASE_' + pid + '_' + handlerSuffix + '_END';
    var startIdx = src.indexOf(startMarker);
    var endIdx = src.indexOf(endMarker);
    if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) return { code: src, changed: false };
    var block = src.substring(startIdx, endIdx);
    var needsAny = false;
    for (var i = 0; i < linesToInsert.length; i++) {
      if (block.indexOf(String(linesToInsert[i]).trim()) < 0) {
        needsAny = true;
        break;
      }
    }
    if (!needsAny) return { code: src, changed: false };
    var insertAt = endIdx;
    var prefix = src.substring(0, insertAt);
    if (!/\n\s*$/.test(prefix)) prefix += '\n';
    var insertion = linesToInsert.join('\n') + '\n';
    return {
      code: prefix + insertion + src.substring(insertAt),
      changed: true,
    };
  }

  function insertLinesIntoPreferredHandler(mainSrc, extrasMap, phaseId, suffix, linesToInsert) {
    var preferred = ['GameFlowManagerMain.Flow.cs'];
    var keys = Object.keys(extrasMap || {});
    for (var i = 0; i < keys.length; i++) {
      if (preferred.indexOf(keys[i]) < 0) preferred.push(keys[i]);
    }
    preferred.push('main');
    var localMain = mainSrc;
    var localExtras = Object.assign({}, extrasMap || {});
    for (var pi = 0; pi < preferred.length; pi++) {
      var name = preferred[pi];
      var src = name === 'main' ? localMain : localExtras[name];
      if (typeof src !== 'string') continue;
      var res = insertLinesIntoHandler(src, phaseId, suffix, linesToInsert);
      if (!res.changed) continue;
      if (name === 'main') localMain = res.code;
      else localExtras[name] = res.code;
      return { changed: true, code: localMain, extraFiles: localExtras };
    }
    return { changed: false, code: localMain, extraFiles: localExtras };
  }

  function buildUpdateBranchBlock(phaseId, linesToInsert, nestedInTapBlock) {
    var headIndent = nestedInTapBlock ? '            ' : '        ';
    var bodyIndent = nestedInTapBlock ? '                ' : '            ';
    var out = [
      headIndent + 'if (currentPhaseName == "' + phaseId + '")',
      headIndent + '{',
    ];
    for (var i = 0; i < linesToInsert.length; i++) {
      out.push(bodyIndent + String(linesToInsert[i] || '').trim());
    }
    out.push(headIndent + '}');
    return out.join('\n');
  }

  function insertLinesIntoMainUpdate(mainSrc, phaseId, linesToInsert) {
    if (!linesToInsert || linesToInsert.length === 0) return { code: mainSrc, changed: false };
    var update = extractMethodRange(mainSrc, 'Update');
    if (!update) return { code: mainSrc, changed: false };
    var phaseToken = 'currentPhaseName == "' + phaseId + '"';
    var existingUpdate = mainSrc.substring(update.bodyStart, update.end);
    var needed = false;
    for (var i = 0; i < linesToInsert.length; i++) {
      if (existingUpdate.indexOf(phaseToken) < 0 || existingUpdate.indexOf(String(linesToInsert[i]).trim()) < 0) {
        needed = true;
        break;
      }
    }
    if (!needed) return { code: mainSrc, changed: false };

    var tapIdx = existingUpdate.indexOf('Phase_OnTap();');
    if (tapIdx >= 0) {
      var anchorAbs = update.bodyStart + tapIdx;
      var lineEnd = mainSrc.indexOf('\n', anchorAbs);
      if (lineEnd < 0) lineEnd = mainSrc.length;
      var block = '\n' + buildUpdateBranchBlock(phaseId, linesToInsert, true);
      return {
        code: mainSrc.slice(0, lineEnd + 1) + block + '\n' + mainSrc.slice(lineEnd + 1),
        changed: true,
      };
    }

    var todoEndIdx = existingUpdate.indexOf('// TODO_UPDATE_END');
    if (todoEndIdx >= 0) {
      var insertAt = update.bodyStart + todoEndIdx;
      var prefix = mainSrc.substring(0, insertAt);
      if (!/\n\s*$/.test(prefix)) prefix += '\n';
      return {
        code: prefix + buildUpdateBranchBlock(phaseId, linesToInsert, false) + '\n' + mainSrc.substring(insertAt),
        changed: true,
      };
    }

    var beforeClose = mainSrc.substring(0, update.end);
    if (!/\n\s*$/.test(beforeClose)) beforeClose += '\n';
    return {
      code: beforeClose + buildUpdateBranchBlock(phaseId, linesToInsert, false) + '\n' + mainSrc.substring(update.end),
      changed: true,
    };
  }

  var phaseDefs = extractPhaseDefsFromMain(nextMain);
  if (phaseDefs.length === 0) {
    return { code: nextMain, extraFiles: nextExtras, changed: false, fixes: 0 };
  }

  var filesByName = Object.assign({ main: nextMain }, nextExtras);
  var initBodies = collectInitBodies(filesByName);
  var changed = false;
  var fixes = 0;
  var fallbackOrdinal = 0;

  for (var di = 0; di < phaseDefs.length; di++) {
    var def = phaseDefs[di];
    if (!def.entities || def.entities.length === 0) continue;
    var initBody = initBodies[def.phaseId] || '';
    var mainLines = [];
    var onTapLines = [];
    var onAutoLines = [];

    for (var ei = 0; ei < def.entities.length; ei++) {
      var entityName = def.entities[ei];
      var moveLines = getInitMoveLines(initBody, entityName);
      if (moveLines.length === 0) {
        fallbackOrdinal++;
        moveLines = buildFallbackMoveLines(entityName, fallbackOrdinal);
      }
      fallbackOrdinal++;
      var forceMoveLines = buildFallbackMoveLines(entityName, fallbackOrdinal, def.phaseId);

      if (!updateHasPhaseScopedMove(nextMain, def.phaseId, entityName)) {
        mainLines = mainLines.concat(moveLines);
      }

      filesByName = Object.assign({ main: nextMain }, nextExtras);
      if (!handlerHasPhaseMove(filesByName, def.phaseId, 'ONTAP', entityName)) {
        onTapLines = onTapLines.concat(moveLines);
      }
      onTapLines = onTapLines.concat(forceMoveLines);

      filesByName = Object.assign({ main: nextMain }, nextExtras);
      if (!handlerHasPhaseMove(filesByName, def.phaseId, 'ONAUTOARRIVE', entityName)) {
        onAutoLines = onAutoLines.concat(moveLines);
      }
      onAutoLines = onAutoLines.concat(forceMoveLines);
    }

    mainLines = dedupeLines(mainLines);
    onTapLines = dedupeLines(onTapLines);
    onAutoLines = dedupeLines(onAutoLines);

    if (mainLines.length > 0) {
      var updateRes = insertLinesIntoMainUpdate(nextMain, def.phaseId, mainLines);
      if (updateRes.changed) {
        nextMain = updateRes.code;
        changed = true;
        fixes++;
      }
    }

    if (onTapLines.length > 0) {
      var tapRes = insertLinesIntoPreferredHandler(nextMain, nextExtras, def.phaseId, 'ONTAP', onTapLines);
      if (tapRes.changed) {
        nextMain = tapRes.code;
        nextExtras = tapRes.extraFiles;
        changed = true;
        fixes++;
      }
    }

    if (onAutoLines.length > 0) {
      var autoRes = insertLinesIntoPreferredHandler(nextMain, nextExtras, def.phaseId, 'ONAUTOARRIVE', onAutoLines);
      if (autoRes.changed) {
        nextMain = autoRes.code;
        nextExtras = autoRes.extraFiles;
        changed = true;
        fixes++;
      }
    }
  }

  return { code: nextMain, extraFiles: nextExtras, changed: changed, fixes: fixes };
}

function normalizePhaseGateConditionalDeclarations(code) {
  if (!code || code.indexOf('__gateMovePos') < 0) {
    return { code: code, changed: false, fixes: 0 };
  }

  var fixes = 0;
  var next = String(code || '');
  var re = /^([ \t]*)if\s*\(([^)\n]+)\)\s*\n[ \t]*var\s+(__gateMovePos[A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\.transform\.position;\s*\n[ \t]*\3\.y\s*\+=\s*2f;\s*\n[ \t]*\4\.transform\.position\s*=\s*\3;/gm;
  next = next.replace(re, function(_, indent, condition, varName, entityName) {
    fixes++;
    return [
      indent + 'if (' + condition + ')',
      indent + '{',
      indent + '    var ' + varName + ' = ' + entityName + '.transform.position;',
      indent + '    ' + varName + '.y += 2f;',
      indent + '    ' + entityName + '.transform.position = ' + varName + ';',
      indent + '}'
    ].join('\n');
  });

  return { code: next, changed: fixes > 0, fixes: fixes };
}

function renameDuplicatePhaseGateMoveVars(code) {
  if (!code || code.indexOf('__gateMovePos') < 0) {
    return { code: code, changed: false, fixes: 0 };
  }

  var seen = {};
  var fixes = 0;
  var next = String(code || '').replace(
    /^([ \t]*)var\s+(__gateMovePos[A-Za-z0-9_]*)\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\.transform\.position;\s*\r?\n([ \t]*)\2\.y\s*\+=\s*2f;\s*\r?\n([ \t]*)\3\.transform\.position\s*=\s*\2;/gm,
    function(match, declIndent, varName, entityName, yIndent, assignIndent) {
      seen[varName] = (seen[varName] || 0) + 1;
      if (seen[varName] === 1) return match;
      var nextVarName = varName + '_' + seen[varName];
      fixes++;
      return [
        declIndent + 'var ' + nextVarName + ' = ' + entityName + '.transform.position;',
        yIndent + nextVarName + '.y += 2f;',
        assignIndent + entityName + '.transform.position = ' + nextVarName + ';',
      ].join('\n');
    }
  );
  return { code: next, changed: fixes > 0, fixes: fixes };
}

function ensurePlayerFieldAssignment(mainCode, extraFiles) {
  var files = Object.assign({}, extraFiles || {});
  function stripComments(src) {
    return String(src || '')
      .replace(/\/\*[\s\S]*?\*\//g, function(m) { return m.replace(/[^\n]/g, ' '); })
      .replace(/\/\/[^\n]*/g, function(m) { return ' '.repeat(m.length); });
  }
  var allSources = [stripComments(mainCode)];
  Object.keys(files).forEach(function(name) {
    allSources.push(stripComments(files[name] || ''));
  });
  var declared = false;
  var readsPlayer = false;
  var assigned = false;
  function hasPlayerFieldAssignment(src) {
    var text = String(src || '');
    var lines = text.split(/\r?\n/);
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li].replace(/\b(?:var|GameObject)\s+player\s*=/g, ' ');
      if (/^\s*(?:this\.)?player\s*=\s*[^=>]/.test(line)) return true;
      if (/(?:^|[^A-Za-z0-9_.])(?:this\.)?player\s*=\s*[^=>]/.test(line)) return true;
    }
    return false;
  }
  for (var i = 0; i < allSources.length; i++) {
    var src = allSources[i];
    if (/\bGameObject\s+player\s*[;=]/.test(src)) declared = true;
    if (/\bplayer\s*\.\s*\w/.test(src)) readsPlayer = true;
    if (hasPlayerFieldAssignment(src)) assigned = true;
  }
  if (!declared || !readsPlayer || assigned) {
    return { code: mainCode, extraFiles: files, changed: false, fixes: 0 };
  }

  var re = /^([ \t]*)void\s+Start\s*\(\s*\)\s*\r?\n[ \t]*\{\r?\n/m;
  var match = re.exec(mainCode);
  if (!match) return { code: mainCode, extraFiles: files, changed: false, fixes: 0 };
  var insertAt = match.index + match[0].length;
  var indent = match[1] + '    ';
  var insert = indent + '// [SKELETON] 绑定玩家字段，避免 partial 里的 player.transform 空引用。\n' +
    indent + 'player = GFM_Player.Instance.Go;\n';
  return {
    code: mainCode.slice(0, insertAt) + insert + mainCode.slice(insertAt),
    extraFiles: files,
    changed: true,
    fixes: 1
  };
}

function repairPlayerBridgePropertyFallback(mainCode, extraFiles) {
  var files = Object.assign({}, extraFiles || {});
  var sourceBundle = [String(mainCode || '')];
  Object.keys(files).forEach(function(name) { sourceBundle.push(String(files[name] || '')); });
  var allCode = sourceBundle.join('\n');
  var candidate = '';
  var fieldRe = /\bGameObject\s+([A-Za-z_][A-Za-z0-9_]*)\s*[;=]/g;
  var preferred = /^(?:PlayerCharacter|Hero|HeroCharacter|OurAstronaut|Astronaut|Avatar|MainPlayer|PlayerObj|PlayerAvatar|Rescuer|Worker)$/;
  var loose = /(?:Player|Hero|Astronaut|Character|Avatar|Rescuer|Worker)/;
  var m;
  while ((m = fieldRe.exec(allCode)) !== null) {
    if (m[1] === 'player') continue;
    if (preferred.test(m[1])) { candidate = m[1]; break; }
    if (!candidate && loose.test(m[1])) candidate = m[1];
  }
  if (!candidate) return { code: mainCode, extraFiles: files, changed: false, fixes: 0 };

  var fixes = 0;
  var next = String(mainCode || '').replace(
    /(GameObject\s+player\s*\{\s*get\s*\{\s*var\s+gp\s*=\s*GFM_Player\.Instance\s*;\s*)return\s+gp\s*!=\s*null\s*\?\s*gp\.Go\s*:\s*null\s*;/m,
    function(match, prefix) {
      fixes++;
      return prefix + 'if (gp != null && gp.Go != null) return gp.Go;\n            return ' + candidate + ';';
    }
  );
  return { code: next, extraFiles: files, changed: fixes > 0, fixes: fixes };
}

function repairPlayerAliasMemberAccess(mainCode, extraFiles) {
  var files = Object.assign({}, extraFiles || {});
  // Only rewrite when the skeleton's lowercase `player` field is actually declared
  // somewhere in the project AND no `class Player` exists. This guards against
  // stomping on a legitimate `Player` type if any future template introduces one.
  var declaresLowercase = false;
  var hasPlayerType = false;
  function noteSrc(src) {
    var s = String(src || '');
    if (/\bGameObject\s+player\s*[;=]/.test(s)) declaresLowercase = true;
    if (/\b(?:class|struct|interface|enum)\s+Player\b/.test(s)) hasPlayerType = true;
  }
  noteSrc(mainCode);
  Object.keys(files).forEach(function(name) { noteSrc(files[name]); });
  if (!declaresLowercase || hasPlayerType) {
    return { code: mainCode, extraFiles: files, changed: false, fixes: 0 };
  }

  // Token-level rewrite: replace any standalone `Player` identifier (PascalCase)
  // with `player`, but skip occurrences inside `// ...` and `/* ... */` comments,
  // string literals, and verbatim/interpolated strings, so user-facing copy and
  // identifiers like `GFM_Player` / `PlayerCharacter` are untouched.
  function fixCode(src) {
    var input = String(src || '');
    var out = '';
    var i = 0;
    var n = input.length;
    var fixes = 0;
    function isWord(ch) { return /[A-Za-z0-9_]/.test(ch); }
    while (i < n) {
      var ch = input[i];
      var next = input[i + 1];
      // line comment
      if (ch === '/' && next === '/') {
        var nlIdx = input.indexOf('\n', i);
        if (nlIdx < 0) { out += input.slice(i); break; }
        out += input.slice(i, nlIdx + 1);
        i = nlIdx + 1;
        continue;
      }
      // block comment
      if (ch === '/' && next === '*') {
        var endIdx = input.indexOf('*/', i + 2);
        if (endIdx < 0) { out += input.slice(i); break; }
        out += input.slice(i, endIdx + 2);
        i = endIdx + 2;
        continue;
      }
      // verbatim string @"..."
      if (ch === '@' && next === '"') {
        var j = i + 2;
        while (j < n) {
          if (input[j] === '"') {
            if (input[j + 1] === '"') { j += 2; continue; }
            j++;
            break;
          }
          j++;
        }
        out += input.slice(i, j);
        i = j;
        continue;
      }
      // interpolated string $"..." (we treat it like a regular string;
      // expressions inside will be rewritten on subsequent passes if needed,
      // but skipping conservatively keeps copy untouched).
      if (ch === '$' && next === '"') {
        var k = i + 2;
        while (k < n) {
          if (input[k] === '\\') { k += 2; continue; }
          if (input[k] === '"') { k++; break; }
          k++;
        }
        out += input.slice(i, k);
        i = k;
        continue;
      }
      // regular string
      if (ch === '"') {
        var s = i + 1;
        while (s < n) {
          if (input[s] === '\\') { s += 2; continue; }
          if (input[s] === '"') { s++; break; }
          s++;
        }
        out += input.slice(i, s);
        i = s;
        continue;
      }
      // char literal
      if (ch === "'") {
        var c = i + 1;
        while (c < n) {
          if (input[c] === '\\') { c += 2; continue; }
          if (input[c] === "'") { c++; break; }
          c++;
        }
        out += input.slice(i, c);
        i = c;
        continue;
      }
      // identifier — boundary check: previous char must not be word char
      if (ch === 'P' && input.slice(i, i + 6) === 'Player' && !isWord(input[i + 6] || '')) {
        var prev = i > 0 ? input[i - 1] : '';
        if (!isWord(prev) && prev !== '@') {
          out += 'player';
          i += 6;
          fixes++;
          continue;
        }
      }
      out += ch;
      i++;
    }
    return { code: out, fixes: fixes };
  }

  var changed = false;
  var fixes = 0;
  var mainRes = fixCode(mainCode);
  if (mainRes.fixes > 0) {
    mainCode = mainRes.code;
    changed = true;
    fixes += mainRes.fixes;
  }
  Object.keys(files).forEach(function(name) {
    var res = fixCode(files[name]);
    if (res.fixes > 0) {
      files[name] = res.code;
      changed = true;
      fixes += res.fixes;
    }
  });
  return { code: mainCode, extraFiles: files, changed: changed, fixes: fixes };
}

function rewriteLongIfChainsAsSwitches(code) {
  if (!code || code.indexOf('if') < 0 || code.indexOf('== "') < 0) {
    return { code: code, changed: false, fixes: 0 };
  }

  function isSpace(ch) {
    return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
  }

  function skipSpace(src, idx) {
    var i = idx;
    while (i < src.length && isSpace(src[i])) i++;
    return i;
  }

  function findMatchingBrace(src, openIdx) {
    var depth = 1;
    var i = openIdx + 1;
    while (i < src.length && depth > 0) {
      var ch = src[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    return depth === 0 ? i - 1 : -1;
  }

  function lineIndent(src, idx) {
    var lineStart = src.lastIndexOf('\n', idx);
    lineStart = lineStart < 0 ? 0 : lineStart + 1;
    var i = lineStart;
    while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++;
    return src.substring(lineStart, i);
  }

  function stripSharedIndent(body) {
    var lines = String(body || '').split('\n');
    while (lines.length > 0 && !lines[0].trim()) lines.shift();
    while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();
    if (lines.length === 0) return [];
    var minIndent = null;
    for (var i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      var m = /^(\s*)/.exec(lines[i]);
      var indent = m ? m[1].length : 0;
      if (minIndent === null || indent < minIndent) minIndent = indent;
    }
    minIndent = minIndent || 0;
    return lines.map(function(line) {
      if (!line.trim()) return '';
      return line.slice(minIndent);
    });
  }

  function parseIfBranch(src, idx, expectedIdent) {
    var header = /^if\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*==\s*"([^"]*)"\s*\)\s*\{/.exec(src.substring(idx));
    if (!header) return null;
    var ident = header[1];
    if (expectedIdent && ident !== expectedIdent) return null;
    var openIdx = idx + header[0].length - 1;
    var closeIdx = findMatchingBrace(src, openIdx);
    if (closeIdx < 0) return null;
    return {
      ident: ident,
      literal: header[2],
      end: closeIdx + 1,
      body: src.substring(openIdx + 1, closeIdx),
    };
  }

  function parseElseBlock(src, idx) {
    var header = /^else\s*\{/.exec(src.substring(idx));
    if (!header) return null;
    var openIdx = idx + header[0].length - 1;
    var closeIdx = findMatchingBrace(src, openIdx);
    if (closeIdx < 0) return null;
    return {
      end: closeIdx + 1,
      body: src.substring(openIdx + 1, closeIdx),
    };
  }

  function buildSwitchCode(indent, ident, branches) {
    var caseIndent = indent + '    ';
    var bodyIndent = indent + '        ';
    var lines = [];
    lines.push(indent + 'switch (' + ident + ')');
    lines.push(indent + '{');
    for (var i = 0; i < branches.length; i++) {
      var branch = branches[i];
      if (branch.type === 'default') lines.push(caseIndent + 'default:');
      else lines.push(caseIndent + 'case "' + branch.literal + '":');
      lines.push(caseIndent + '{');
      var bodyLines = stripSharedIndent(branch.body);
      for (var j = 0; j < bodyLines.length; j++) {
        lines.push(bodyLines[j] ? bodyIndent + bodyLines[j] : '');
      }
      lines.push(bodyIndent + 'break;');
      lines.push(caseIndent + '}');
    }
    lines.push(indent + '}');
    return lines.join('\n');
  }

  var fixed = String(code);
  var idx = 0;
  var fixes = 0;
  while (idx < fixed.length) {
    var nextIf = fixed.indexOf('if', idx);
    if (nextIf < 0) break;
    var before = fixed.substring(Math.max(0, nextIf - 6), nextIf);
    if (/else\s*$/.test(before)) {
      idx = nextIf + 2;
      continue;
    }
    var first = parseIfBranch(fixed, nextIf, null);
    if (!first) {
      idx = nextIf + 2;
      continue;
    }
    var branches = [{
      type: 'case',
      literal: first.literal,
      body: first.body,
    }];
    var chainEnd = first.end;
    var ident = first.ident;
    var caseCount = 1;
    while (true) {
      var probe = skipSpace(fixed, chainEnd);
      if (fixed.substring(probe, probe + 4) !== 'else') break;
      var afterElse = skipSpace(fixed, probe + 4);
      if (fixed.substring(afterElse, afterElse + 2) === 'if') {
        var branch = parseIfBranch(fixed, afterElse, ident);
        if (!branch) break;
        branches.push({
          type: 'case',
          literal: branch.literal,
          body: branch.body,
        });
        chainEnd = branch.end;
        caseCount++;
        continue;
      }
      var elseBlock = parseElseBlock(fixed, probe);
      if (!elseBlock) break;
      branches.push({
        type: 'default',
        body: elseBlock.body,
      });
      chainEnd = elseBlock.end;
      break;
    }
    while (true) {
      var nextProbe = skipSpace(fixed, chainEnd);
      if (fixed.substring(nextProbe, nextProbe + 2) !== 'if') break;
      var nextBranch = parseIfBranch(fixed, nextProbe, ident);
      if (!nextBranch) break;
      branches.push({
        type: 'case',
        literal: nextBranch.literal,
        body: nextBranch.body,
      });
      chainEnd = nextBranch.end;
      caseCount++;
    }
    if (caseCount < 4) {
      idx = chainEnd;
      continue;
    }
    var replacement = buildSwitchCode(lineIndent(fixed, nextIf), ident, branches);
    fixed = fixed.slice(0, nextIf) + replacement + fixed.slice(chainEnd);
    fixes++;
    idx = nextIf + replacement.length;
  }

  return { code: fixed, changed: fixes > 0, fixes: fixes };
}

function collapseLegacyCheckEventRulesStub(code) {
  if (!code || code.indexOf('CheckEventRules_OLD_UNUSED_STUB') < 0) {
    return { code: code, changed: false, fixes: 0 };
  }
  var sigRe = /\bvoid\s+CheckEventRules_OLD_UNUSED_STUB\s*\(\s*\)\s*\{/;
  var m = sigRe.exec(code);
  if (!m) return { code: code, changed: false, fixes: 0 };
  var start = m.index + m[0].length;
  var depth = 1;
  var end = start;
  while (end < code.length && depth > 0) {
    var ch = code[end];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) break; }
    end++;
  }
  if (depth !== 0) return { code: code, changed: false, fixes: 0 };
  var replacement = m[0] + '\n' +
    '        // Legacy flow stub collapsed by deterministic pre-repair.\n' +
    '        // Real flow lives in GameFlowManagerMain.Flow.cs.\n' +
    '    }';
  var fixed = code.slice(0, m.index) + replacement + code.slice(end + 1);
  return { code: fixed, changed: true, fixes: 1 };
}

function removePostTapPhaseResetBlocks(code) {
  var next = String(code || '');
  if (next.indexOf('Phase_OnTap();') < 0 || next.indexOf('switch (currentPhaseName)') < 0) {
    return { code: code, changed: false, fixes: 0 };
  }

  function findBalancedBlockEnd(src, openBraceIdx) {
    var depth = 1;
    var i = openBraceIdx + 1;
    while (i < src.length && depth > 0) {
      var ch = src[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return i;
      }
      i++;
    }
    return -1;
  }

  function isResetOnlySwitch(block) {
    if (block.indexOf('case "') < 0) return false;
    var lines = block.split('\n');
    var hasReset = false;
    for (var i = 0; i < lines.length; i++) {
      var line = String(lines[i] || '').trim();
      if (!line || line.indexOf('//') === 0) continue;
      if (/^switch\s*\(\s*currentPhaseName\s*\)\s*\{?$/.test(line)) continue;
      if (/^case\s+"[^"]+"\s*:\s*\{?$/.test(line)) continue;
      if (line === '{' || line === '}' || line === 'break;' || line === '};') continue;
      if (/^PlaceObj\s*\(/.test(line) || /^HideObj\s*\(/.test(line)) {
        hasReset = true;
        continue;
      }
      return false;
    }
    return hasReset;
  }

  var fixes = 0;
  var searchFrom = 0;
  while (searchFrom < next.length) {
    var tapIdx = next.indexOf('Phase_OnTap();', searchFrom);
    if (tapIdx < 0) break;
    var lineEnd = next.indexOf('\n', tapIdx);
    if (lineEnd < 0) break;
    var cursor = lineEnd + 1;
    var removedNearTap = false;
    while (cursor < next.length) {
      var ws = /^\s*/.exec(next.slice(cursor))[0] || '';
      var switchStart = cursor + ws.length;
      var sw = /^switch\s*\(\s*currentPhaseName\s*\)\s*(?:\{|\r?\n\s*\{)/.exec(next.slice(switchStart));
      if (!sw) break;
      var openBrace = switchStart + sw[0].lastIndexOf('{');
      var blockEnd = findBalancedBlockEnd(next, openBrace);
      if (blockEnd < 0) break;
      var blockText = next.slice(switchStart, blockEnd + 1);
      if (!isResetOnlySwitch(blockText)) break;
      var removeStart = cursor;
      var removeEnd = blockEnd + 1;
      if (next[removeEnd] === '\n') removeEnd++;
      next = next.slice(0, removeStart) + next.slice(removeEnd);
      fixes++;
      removedNearTap = true;
      cursor = removeStart;
    }
    searchFrom = removedNearTap ? cursor : lineEnd + 1;
  }

  return { code: next, changed: fixes > 0, fixes: fixes };
}

function isBranchCommentExemptCondition(condText) {
  return /ruleTriggered\[|_autoPlayMode|phaseTimer\s*[<>]=?|currentPhaseName\s*==|GFM_CameraController\.Instance|TrySpend\s*\(|GetResource\s*\(|transform\.position\.y\s*<\s*-900|(?:guideText|scoreText|floatingText)\.text\s*!=|==\s*null\s*\|\||\|\|\s*\w+\s*==\s*null/.test(condText);
}

function isComplexBranchCondition(condText) {
  var cond = String(condText || '');
  var comparisonOps = (cond.match(/(?:==|!=|<=|>=|<|>)/g) || []).length;
  return cond.indexOf('&&') >= 0 ||
    cond.indexOf('||') >= 0 ||
    cond.indexOf('?') >= 0 ||
    cond.indexOf('"') >= 0 ||
    /\b\d{3,}\b/.test(cond) ||
    comparisonOps >= 2;
}

function hasNearbyBranchComment(lines, start, end) {
  var prev1 = start > 0 ? String(lines[start - 1] || '').trim() : '';
  var prev2 = start > 1 ? String(lines[start - 2] || '').trim() : '';
  var next1 = end + 1 < lines.length ? String(lines[end + 1] || '').trim() : '';
  if (prev1.indexOf('//') === 0 || prev1.indexOf('///') === 0) return true;
  if (prev2.indexOf('//') === 0 || prev2.indexOf('///') === 0) return true;
  if (next1.indexOf('//') === 0 || next1.indexOf('///') === 0) return true;
  for (var i = start; i <= end; i++) {
    var line = String(lines[i] || '');
    var scrubbed = line.replace(/"[^"]*"/g, '""');
    if (scrubbed.indexOf('//') >= 0 || scrubbed.indexOf('/*') >= 0) return true;
  }
  return false;
}

function addMissingComplexBranchComments(code) {
  if (!code || code.indexOf('if') < 0 || code.indexOf('GameFlowManagerMain') < 0) {
    return { code: code, changed: false, fixes: 0 };
  }
  var lines = String(code).split('\n');
  var out = [];
  var fixes = 0;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (/\bif\s*\(/.test(line)) {
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
      if (isComplexBranchCondition(condText) &&
          !isBranchCommentExemptCondition(condText) &&
          !hasNearbyBranchComment(lines, start, end)) {
        var indent = (/^\s*/.exec(line) || [''])[0];
        out.push(indent + '// Branch gate: documents the generated multi-part condition before review.');
        fixes++;
      }
      for (var copy = start; copy <= end; copy++) out.push(lines[copy]);
      i = end;
      continue;
    }
    out.push(line);
  }
  return { code: fixes > 0 ? out.join('\n') : code, changed: fixes > 0, fixes: fixes };
}

function addMissingSkeletonMemberComments(code) {
  if (!code || code.indexOf('GameFlowManagerMain') < 0) {
    return { code: code, changed: false, fixes: 0 };
  }
  var lines = String(code).split('\n');
  var sanitized = String(code)
    .replace(/\/\*[\s\S]*?\*\//g, function(m) { return m.replace(/[^\n]/g, ' '); })
    .replace(/\/\/[^\n]*/g, function(m) { return ' '.repeat(m.length); })
    .replace(/"(?:[^"\\]|\\.)*"/g, function(m) { return '"' + ' '.repeat(Math.max(0, m.length - 2)) + '"'; });
  var sanitizedLines = sanitized.split('\n');
  var out = [];
  var fixes = 0;
  var depth = 0;

  function docForMember(sTrimmed) {
    if (/^int\s+\w+State\s*=/.test(sTrimmed)) return '实体状态：记录对象在当前 phase 中的可观察进度。';
    if (/^bool\s+\w+(?:InteractionDone|PlayerActed|Done)\s*=/.test(sTrimmed)) return '交互标记：记录玩家或自动流程已经完成对应阶段动作。';
    if (/^(?:GFM_Joystick\s+joystick|float\s+moveSpeed\b)/.test(sTrimmed)) return '玩家移动：控制输入与移动速度配置。';
    if (/^GameObject\s+player\s*;/.test(sTrimmed)) return '玩家移动：主角对象引用，供交互、距离判断与相机跟随使用。';
    if (/^GameObject\s+\w+\s*;/.test(sTrimmed)) return '对象引用：绑定场景实体，供阶段 gate、交互和展示逻辑使用。';
    if (/^void\s+Spawn\w+\s*\(/.test(sTrimmed)) return 'Spawn 兼容：保留旧生成入口，转接到当前实体创建流程。';
    if (/^(?:Vector3\s+tapMoveTarget|bool\s+hasTapTarget)\b/.test(sTrimmed)) return '点击移动目标：保存本帧输入转换出的移动目的地。';
    if (/^void\s+UpdateCarryVisuals\s*\(/.test(sTrimmed)) return '背包堆叠：根据资源数量刷新玩家携带物表现。';
    if (/^int\s+gold\s*=/.test(sTrimmed)) return '金币 UI：记录当前展示和经济流程共用的金币数。';
    if (/^Vector3\s+_snap_\w+Pos\s*;/.test(sTrimmed)) return 'Phase 快照：进入阶段时记录 gate 实体位置，用于判断真实推进。';
    if (/^(?:FormDef\[\]\s+_forms|int\s+_currentFormIndex\b)/.test(sTrimmed)) return '玩家形态：记录可切换形态配置和当前形态索引。';
    if (/^(?:float\s+phaseTimer|string\s+lastPhaseForTimer|float\[\]\s+phaseEnterTimes)\b/.test(sTrimmed)) return 'Phase 计时：跟踪阶段停留时间和进入时间。';
    if (/^(?:Camera|Canvas|Text|float|string)\s+(?:mainCam|uiCanvas|guideText|scoreText|floatingText|floatingTextTimer|_currentGuideText|cameraFocusTarget)\b/.test(sTrimmed)) return 'Camera/UI：缓存相机与界面状态，驱动引导文字和视角。';
    if (/^(?:const\s+int\s+RULE_COUNT|bool\[\]\s+ruleTriggered|string\s+currentPhaseName|string\[\]\s+completedPhases|int\s+completedPhaseCount|float\s+gameTimer|bool\s+gameEnded)\b/.test(sTrimmed)) return '阶段跟踪：维护当前 phase、完成列表和终局锁。';
    if (/^(?:bool\s+_autoPlayMode|int\s+_autoPlaySteps|int\s+_autoPlayStepsAtPhaseStart|const\s+float\s+AUTO_PLAY_PHASE_DURATION)\b/.test(sTrimmed)) return 'AutoPlay：记录自动试玩模式的推进节奏。';
    if (/^(?:string\[\]\s+_phaseEvidenceKeys|string\[\]\s+_phaseEvidenceValues|int\s+_phaseEvidenceCount)\b/.test(sTrimmed)) return '运行时证据：导出 phase-scoped evidence，供 runtime-contract 判定。';
    if (/^(?:public|private|protected|internal)?\s*(?:static\s+)?(?:readonly\s+)?(?:const\s+)?(?:bool|int|float|string|GameObject|Vector2|Vector3|Vector4|Color|Transform|Text|Canvas|Quaternion|Ray|Material|Image|Sprite|RectTransform|[\w<>]+\[\]?|[A-Z]\w*)\s+\w+\s*(?:=\s*[^;]+)?;\s*$/.test(sTrimmed)) {
      return '运行时字段：保存生成玩法流程需要跨帧读取的状态。';
    }
    return '运行时成员：封装阶段流程、交互或可观察状态更新逻辑。';
  }

  function isMemberDeclaration(sTrimmed, rawTrimmed) {
    if (/^(if|for|foreach|while|switch|catch|using|return|throw|else|do)\b/.test(sTrimmed)) return false;
    var isDecl = false;
    if (/^(?:public|private|protected|internal)?\s*(?:static\s+)?(?:readonly\s+)?(?:const\s+)?(?:override\s+)?(?:virtual\s+)?(?:partial\s+)?(?:void|IEnumerator|bool|int|float|string|GameObject|Vector2|Vector3|Vector4|Color|Transform|Text|Canvas|Quaternion|Ray|Material|Image|Sprite|RectTransform|[\w<>]+\[\]?|[A-Z]\w*)\s+\w+\s*\([^;]*\)\s*\{?\s*$/.test(sTrimmed)) {
      isDecl = true;
    } else if (/^(?:public|private|protected|internal)?\s*(?:static\s+)?(?:readonly\s+)?(?:const\s+)?(?:bool|int|float|string|GameObject|Vector2|Vector3|Vector4|Color|Transform|Text|Canvas|Quaternion|Ray|Material|Image|Sprite|RectTransform|[\w<>]+\[\]?|[A-Z]\w*)\s+\w+\s*(?:=\s*[^;]+)?;\s*$/.test(sTrimmed)) {
      isDecl = true;
    } else if (/^(?:public|private|protected|internal)?\s*(?:static\s+)?(?:bool|int|float|string|GameObject|Vector2|Vector3|Vector4|Color|Transform|Text|Canvas|Quaternion|Ray|Material|Image|Sprite|RectTransform|[\w<>]+\[\]?|[A-Z]\w*)\s+\w+\s*\{\s*get\b/.test(sTrimmed)) {
      isDecl = true;
    }
    if (!isDecl) return false;
    if (/\b(class|struct|enum|interface)\b/.test(sTrimmed)) return false;
    if (/^\[/.test(rawTrimmed)) return false;
    if (/^bool\s+__assemblyDone_/.test(sTrimmed)) return false;
    if (/\bvoid\s+AssemblyRun[A-Za-z]+Slots\s*\(/.test(sTrimmed)) return false;
    if (/^void\s+Spawn\w+\s*\(/.test(sTrimmed)) return false;
    if (/^(?:float\s+_collectCooldown|string\s+_lastScoreText)\b/.test(sTrimmed)) return false;
    if (/\bvoid\s+(?:AddGold|ShowFloatingText)\s*\(/.test(sTrimmed)) return false;
    return true;
  }

  function hasInlineComment(raw) {
    var inString = false;
    for (var i = 0; i < raw.length - 1; i++) {
      if (raw[i] === '"' && raw[i - 1] !== '\\') inString = !inString;
      if (!inString && raw[i] === '/' && raw[i + 1] === '/') return raw.slice(0, i).trim().length > 0;
    }
    return false;
  }

  function hasPreviousDoc(lineIndex) {
    var j = lineIndex - 1;
    while (j >= 0 && String(lines[j] || '').trim() === '') j--;
    if (j < 0) return false;
    var prev = String(lines[j] || '').trim();
    return prev.indexOf('///') === 0 ||
      prev.indexOf('//') === 0 ||
      prev.slice(-2) === '*/' ||
      /^\[[\w,\s"=]+\]$/.test(prev);
  }

  for (var i = 0; i < lines.length; i++) {
    var raw = lines[i];
    var sline = sanitizedLines[i] || '';
    var rawTrimmed = String(raw || '').trim();
    var sTrimmed = String(sline || '').trim();
    if (depth === 1 && isMemberDeclaration(sTrimmed, rawTrimmed) && !hasInlineComment(raw) && !hasPreviousDoc(i)) {
      var indent = (raw.match(/^\s*/) || [''])[0];
      out.push(indent + '// ' + docForMember(sTrimmed));
      fixes++;
    }
    out.push(raw);
    var opens = (sline.match(/\{/g) || []).length;
    var closes = (sline.match(/\}/g) || []).length;
    depth += opens - closes;
    if (depth < 0) depth = 0;
  }
  return { code: fixes > 0 ? out.join('\n') : code, changed: fixes > 0, fixes: fixes };
}

function declareMissingInteractionFlags(mainCode, extraFiles) {
  if (!mainCode || mainCode.indexOf('GameFlowManagerMain') < 0) {
    return { code: mainCode, extraFiles: extraFiles || {}, changed: false, fixes: 0 };
  }
  var files = Object.assign({}, extraFiles || {});
  var allCode = [String(mainCode)].concat(Object.keys(files).map(function(name) { return String(files[name] || ''); })).join('\n');
  var scanCode = allCode
    .replace(/\/\*[\s\S]*?\*\//g, function(m) { return m.replace(/[^\n]/g, ' '); })
    .replace(/\/\/[^\n]*/g, function(m) { return ' '.repeat(m.length); })
    .replace(/"(?:[^"\\]|\\.)*"/g, function(m) { return '"' + ' '.repeat(Math.max(0, m.length - 2)) + '"'; });
  var declared = {};
  var refs = {};
  var declRe = /\bbool\s+([A-Za-z_][A-Za-z0-9_]*(?:InteractionDone|PlayerActed|Done))\b/g;
  var m;
  while ((m = declRe.exec(allCode)) !== null) declared[m[1]] = true;
  var refRe = /\b([A-Za-z_][A-Za-z0-9_]*(?:InteractionDone|PlayerActed|Done))\b/g;
  while ((m = refRe.exec(scanCode)) !== null) {
    var name = m[1];
    if (name.indexOf('__assemblyDone_') === 0) continue;
    refs[name] = true;
  }
  var missing = Object.keys(refs).filter(function(name) { return !declared[name]; }).sort();
  if (missing.length === 0) {
    return { code: mainCode, extraFiles: files, changed: false, fixes: 0 };
  }
  var lines = String(mainCode).split('\n');
  var insertAt = -1;
  var depth = 0;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var opens = (line.match(/\{/g) || []).length;
    var closes = (line.match(/\}/g) || []).length;
    depth += opens - closes;
    if (insertAt < 0 && depth === 1 && /\bGameFlowManagerMain\b/.test(lines[Math.max(0, i - 1)] || line)) {
      insertAt = i + 1;
      break;
    }
  }
  if (insertAt < 0) {
    for (var j = 0; j < lines.length; j++) {
      if (lines[j].indexOf('{') >= 0) {
        insertAt = j + 1;
        break;
      }
    }
  }
  if (insertAt < 0) return { code: mainCode, extraFiles: files, changed: false, fixes: 0 };
  var indent = '    ';
  var insertLines = missing.map(function(name) {
    return indent + 'bool ' + name + ' = false; // 交互标记：补齐被阶段逻辑引用的完成状态。';
  });
  lines.splice.apply(lines, [insertAt, 0].concat(insertLines));
  return { code: lines.join('\n'), extraFiles: files, changed: true, fixes: missing.length };
}

// Wave 2 (2026-05-31): the 25 deterministic pre-repair fns keyed by name, injected
// into the lib orchestrator. Bodies still live in this file (Step 2 migration tactic).
var PREREPAIR_FNS = {
  declareMissingInteractionFlags: declareMissingInteractionFlags,
  repairPlayerAliasMemberAccess: repairPlayerAliasMemberAccess,
  ensurePlayerFieldAssignment: ensurePlayerFieldAssignment,
  repairPlayerBridgePropertyFallback: repairPlayerBridgePropertyFallback,
  collapseLegacyCheckEventRulesStub: collapseLegacyCheckEventRulesStub,
  repairUpdateGameStateBridge: repairUpdateGameStateBridge,
  normalizeRuntimePhaseContract: normalizeRuntimePhaseContract,
  ensureAssemblySlotRunnerCalls: ensureAssemblySlotRunnerCalls,
  stripInitMaterialFromScene: stripInitMaterialFromScene,
  stripEarlyShowCTA: stripEarlyShowCTA,
  normalizeFinishGameTerminalFlow: normalizeFinishGameTerminalFlow,
  rewriteHotPathVectorAllocations: rewriteHotPathVectorAllocations,
  guardFloatingTextTransformPosition: guardFloatingTextTransformPosition,
  guardPlayerTransformDistanceReads: guardPlayerTransformDistanceReads,
  sanitizeNonAsciiResourceApiKeys: sanitizeNonAsciiResourceApiKeys,
  stripExcessCameraBackgroundAssignments: stripExcessCameraBackgroundAssignments,
  repairMainCamSelfAssignment: repairMainCamSelfAssignment,
  rewriteCameraMainToMainCam: rewriteCameraMainToMainCam,
  normalizeSetScaleCalls: normalizeSetScaleCalls,
  repairPhaseGateRuntimeMoves: repairPhaseGateRuntimeMoves,
  normalizePhaseGateConditionalDeclarations: normalizePhaseGateConditionalDeclarations,
  renameDuplicatePhaseGateMoveVars: renameDuplicatePhaseGateMoveVars,
  stripInteractionFlagShortcutsFromPhaseGates: stripInteractionFlagShortcutsFromPhaseGates,
  rewriteLongIfChainsAsSwitches: rewriteLongIfChainsAsSwitches,
  repairPhaseGateRuntimeMovesAcrossPartials: repairPhaseGateRuntimeMovesAcrossPartials,
  ensureAssemblySlotRunnerCallsAcrossPartials: ensureAssemblySlotRunnerCallsAcrossPartials,
  removePostTapPhaseResetBlocks: removePostTapPhaseResetBlocks,
  addMissingComplexBranchComments: addMissingComplexBranchComments,
  addMissingSkeletonMemberComments: addMissingSkeletonMemberComments,
};

// Wave 2: pre-repair orchestration lives in engine/lib/static-rule-prerepair.cjs
// (runAllPreRepairs). The 25 pre-repair fn bodies still live in this file and are
// injected via PREREPAIR_FNS. The original ~350-line inline main/partial mirror was
// removed after the equivalence gate proved the lib byte-identical — see
// test/static-rule-prerepair-equivalence.test.cjs and git commit f1d7375 (which kept
// the inline pass behind USE_PRE_REPAIR_LIB=false purely to run that proof).
function repairKnownStructuralDamage(mainCode, extraFiles, blueprint) {
  return require('../lib/static-rule-prerepair.cjs')
    .runAllPreRepairs(mainCode, extraFiles, blueprint, PREREPAIR_FNS);
}

function shouldUsePatchRecode(reviewResult) {
  var issues = reviewResult && reviewResult.issues || [];
  var issuesWithLine = issues.filter(function(i) { return i.line > 0; });
  if (!(issues.length <= 3 && issuesWithLine.length >= 1)) return false;
  if (!reviewResult || reviewResult.source === 'static-precheck' || reviewResult.source === 'phase-precheck') return false;
  var blockedRules = {
    'phase-entity-unbound': true,
    'phase-entity-init-only': true,
    'phase-gate-shortcircuits-with-interaction-flags': true,
    'update-new-vector-in-hot-path': true,
    'phase-coverage': true,
  };
  for (var i = 0; i < issues.length; i++) {
    if (blockedRules[issues[i].rule]) return false;
  }
  return true;
}

function hasLegacyReviewerApiKey() {
  return !!(typeof process !== 'undefined' && process && process.env && process.env.OPENAI_API_KEY);
}

function isDefinitiveReviewerFailure(text) {
  return /MODEL_FATAL|quota|insufficient|\b401\b|\b402\b|\b403\b|invalid.?api.?key|unauthoriz/i.test(String(text || ''));
}

function shouldFallbackToLegacyReviewer(reviewResult, useCodexReview, hasCodexReviewer, hasLegacyReviewer) {
  if (!reviewResult) return false;
  var isDefinitive = reviewResult.error && isDefinitiveReviewerFailure(reviewResult.error);
  return !reviewResult.passed &&
    (reviewResult.parseError || reviewResult.error) &&
    !isDefinitive &&
    !!useCodexReview &&
    !!hasCodexReviewer &&
    !!hasLegacyReviewer &&
    hasLegacyReviewerApiKey();
}

function shouldUseDeterministicReviewFallback(reviewFailure, useCodexReview, hasCodexReviewer, hasLegacyReviewer) {
  if (!reviewFailure) return false;

  var text = '';
  if (typeof reviewFailure === 'string') text = reviewFailure;
  else text = String(reviewFailure.error || reviewFailure.message || '');

  if (isDefinitiveReviewerFailure(text)) return false;

  var looksTransient = !!(reviewFailure.parseError || reviewFailure.timedOut) ||
    /timeout|parse error|empty output|unparseable output|socket hang up|econnreset|econnrefused|enotfound|eai_again|enetunreach|ehostunreach|\b502\b|\b503\b|\b504\b/i.test(text);
  if (!looksTransient) return false;

  return (!!useCodexReview && !!hasCodexReviewer) || !!hasLegacyReviewer;
}

function buildReviewFingerprint(reviewResult) {
  if (!reviewResult) return 'review|unknown';
  var issues = (reviewResult.issues || []).slice(0, 6).map(function(issue) {
    var sev = issue.severity || '';
    var rule = issue.rule || '';
    var msg = issue.message || issue.text || '';
    return sev + '|' + rule + '|' + msg;
  }).join('\n');
  var source = reviewResult.source || '';
  var crit = reviewResult.criticalCount || 0;
  var body = [
    'source=' + source,
    'critical=' + crit,
    issues || (reviewResult.feedback || '') || 'no-feedback',
  ].join('\n');
  return normalizeFingerprint(body, { stage: 'review' });
}

module.exports = {
  name: 'review',
  canRetry: false,
  normalizeSetScaleCalls: normalizeSetScaleCalls,
  sanitizeNonAsciiResourceApiKeys: sanitizeNonAsciiResourceApiKeys,
  repairPhaseGateRuntimeMoves: repairPhaseGateRuntimeMoves,
  repairPhaseGateRuntimeMovesAcrossPartials: repairPhaseGateRuntimeMovesAcrossPartials,
  removePostTapPhaseResetBlocks: removePostTapPhaseResetBlocks,
  normalizePhaseGateConditionalDeclarations: normalizePhaseGateConditionalDeclarations,
  renameDuplicatePhaseGateMoveVars: renameDuplicatePhaseGateMoveVars,
  stripInteractionFlagShortcutsFromPhaseGates: stripInteractionFlagShortcutsFromPhaseGates,
  rewriteLongIfChainsAsSwitches: rewriteLongIfChainsAsSwitches,
  normalizeRuntimePhaseContract: normalizeRuntimePhaseContract,
  ensureAssemblySlotRunnerCalls: ensureAssemblySlotRunnerCalls,
  ensureAssemblySlotRunnerCallsAcrossPartials: ensureAssemblySlotRunnerCallsAcrossPartials,
  declareMissingInteractionFlags: declareMissingInteractionFlags,
  repairPlayerAliasMemberAccess: repairPlayerAliasMemberAccess,
  ensurePlayerFieldAssignment: ensurePlayerFieldAssignment,
  repairPlayerBridgePropertyFallback: repairPlayerBridgePropertyFallback,
  guardFloatingTextTransformPosition: guardFloatingTextTransformPosition,
  guardPlayerTransformDistanceReads: guardPlayerTransformDistanceReads,
  repairMainCamSelfAssignment: repairMainCamSelfAssignment,
  addMissingComplexBranchComments: addMissingComplexBranchComments,
  addMissingSkeletonMemberComments: addMissingSkeletonMemberComments,
  hasLegacyReviewerApiKey: hasLegacyReviewerApiKey,
  shouldFallbackToLegacyReviewer: shouldFallbackToLegacyReviewer,
  shouldUseDeterministicReviewFallback: shouldUseDeterministicReviewFallback,
  isAssemblyReadyForDeterministicReview: isAssemblyReadyForDeterministicReview,
  repairKnownStructuralDamage: repairKnownStructuralDamage,
  canSkip: function(ctx) {
    return process.env.SKIP_CODE_REVIEW === 'true' || !ctx.csCode;
  },
  assertBefore: function(ctx) {
    if (!ctx.csCode) throw new Error('No code to review');
    var lines = ctx.csCode.split('\n');
    var lineCount = lines.length;
    var bindingSignals = (ctx.csCode.match(/RegisterEntityBindings|GameSceneCtrl|mBindings|SetGuideText|Phase_|StartPhase|UpdatePhase|currentPhase|phaseTimer|CheckEventRules|GMP_EntityBindingManager/g) || []).length;
    var todoLines = lines.filter(function(l) { return /\/\/ TODO(?!_\w+(?:START|END))/i.test(l); }).length;
    var todoRatio = todoLines / lineCount;
    if (lineCount < 100) throw new Error('Stub code: only ' + lineCount + ' lines');
    if (bindingSignals === 0) throw new Error('No phase/entity binding signals found — likely stub');
    if (todoRatio > 0.2) throw new Error('Too many unfilled TODOs: ' + Math.round(todoRatio * 100) + '%');
  },
  execute: function(ctx) {
    ctx.addLog('review', 'Starting code review...');

    var codeReviewer, codexReviewer;
    try { codeReviewer = require('../../worker/code-reviewer.js'); } catch(e) {}
    try { codexReviewer = require('../../worker/codex-reviewer.js'); } catch(e) {}
    var USE_CODEX_REVIEW = process.env.USE_CODEX_REVIEW !== 'false';

    if (!USE_CODEX_REVIEW && !codexReviewer && !codeReviewer) {
      ctx.addLog('review', 'No reviewer module available — aborting (no silent skip)');
      throw new Error('MODEL_FATAL: no reviewer available (neither codex-reviewer nor code-reviewer loaded)');
    }

    var reviewPoolNameMap = null;
    try {
      var promptV5 = require('../../worker/prompt-v5-basetemplate.js');
      if (ctx.blueprint.entities && ctx.blueprint.entities.length > 0) {
        reviewPoolNameMap = promptV5.matchPrefabs(ctx.blueprint.entities);
      }
    } catch(e) { ctx.addLog('review', 'promptV5.matchPrefabs skipped: ' + e.message); }

    var reviewerName = (USE_CODEX_REVIEW && codexReviewer) ? 'Codex' : 'GPT-5.4';
    ctx.reportStatus('processing', { message: '[Linux] ' + reviewerName + ' 代码审核中...' });

    var reviewedCode = ctx.csCode;
    var reviewExtraFiles = Object.assign({}, ctx.extraFiles);
    var reviewPlanSummary = assemblyPlanContracts.buildReviewPlanGuidance(ctx.blueprint && ctx.blueprint.plans, ctx.blueprint);
    var lastReviewFingerprint = null;
    var sameReviewFingerprintCount = 0;
    var specCriticalCount = 0;

    // Spec conformance check: verify code semantics match blueprint
    // P1-6: Only inject as feedback if there are genuine critical issues after fuzzy matching
    // This prevents "phaseId naming mismatch" from poisoning the fix loop
    if (ctx.blueprint.specs && ctx.blueprint.specs.length > 0) {
      var conformance = checkConformance(reviewedCode, ctx.blueprint);
      specCriticalCount = conformance.criticalCount || 0;
      ctx.addLog('review', 'Spec conformance: ' + conformance.criticalCount + ' critical, ' + conformance.warningCount + ' warnings');
      if (!conformance.passed && conformance.criticalCount > 0) {
        // Only inject critical issues (not warnings) into feedback to avoid noise
        var criticalIssues = conformance.issues.filter(function(i) { return i.severity === 'critical'; });
        var confIssues = criticalIssues.map(function(i) {
          return '[critical] ' + i.phase + ': ' + i.message;
        }).join('\n');
        if (!ctx.blueprint.feedbackHistory) ctx.blueprint.feedbackHistory = [];
        ctx.blueprint.feedbackHistory.push({
          data: { text: 'SPEC CONFORMANCE VIOLATIONS (critical only):\n' + confIssues },
          source: 'spec-conformance',
          status: 'pending',
          timestamp: Date.now(),
        });
      } else if (conformance.passed) {
        ctx.addLog('review', 'Spec conformance: all phases verified');
      } else {
        ctx.addLog('review', 'Spec conformance: only warnings (not injecting as feedback to avoid fix loop poisoning)');
      }
    }

    var loop = createFixLoop({
      name: 'review',
      maxRounds: MAX_REVIEW_ROUNDS,
      onExhausted: 'throw',
      beforeRound: function(ctx, round, maxRounds) {
        if (round > 1) {
          ctx.reportStatus('processing', { message: '[Linux] ' + reviewerName + ' 审核 (' + round + '/' + maxRounds + ')...' });
        }
      },
      attempt: function(ctx, round, maxRounds) {
        var repaired = repairKnownStructuralDamage(reviewedCode, reviewExtraFiles, ctx.blueprint);
        if (repaired.changed) {
          reviewedCode = repaired.code;
          reviewExtraFiles = repaired.extraFiles;
          ctx.addLog('review', 'Deterministic pre-repair applied: ' + repaired.fixes.join(', '));
        }
        // Static pre-check: catch forbidden APIs every round. Runs BEFORE the
        // LLM reviewer so static violations trigger a recode pass even when:
        //  - codex preflight fails silently and returns passed:true
        //  - LLM reviewer misses blocking APIs
        //  - Network to reviewer is flaky
        // Before bqh33t 2026-04-15 this check only ran once at the top of
        // execute() and only injected feedback, which was ignored on clean
        // reviewer pass — leading to known-broken GFM_Create.Obj() code
        // advancing to visual-check → cua-verify with black screen.
        var reviewPromise;
        var preCheck = staticCheckProject(reviewedCode, { extraFiles: reviewExtraFiles, blueprint: ctx.blueprint });
        // Scan every GameFlowManagerMain partial, not only the main file. Feedback
        // rules for comments, file ownership, thin coordinators, and direct calls are
        // now blocking; remaining non-blocking rules are still logged as warnings.
        var preCheckBlocking = (preCheck.issues || []).filter(function(i) { return i.blocking; });
        var preCheckWarnings = (preCheck.issues || []).filter(function(i) { return !i.blocking; });
        if (preCheckWarnings.length > 0) {
          ctx.addLog('review', 'Static check (round ' + round + ') warnings (non-blocking): ' + preCheckWarnings.length);
        }
        if (preCheckBlocking.length > 0) {
          var staticIssues = preCheckBlocking.map(function(i) {
            return (i.file ? i.file + ' ' : '') + 'L' + i.line + ': ' + i.message + ' — ' + i.text;
          }).join('\n');
          ctx.addLog('review', 'Static check (round ' + round + ') found ' + preCheckBlocking.length + ' blocking violations — forcing recode without LLM review');
          ctx.addLog('review', 'Static check (round ' + round + ') top blocking rules: ' + summarizeRules(preCheckBlocking, 6));
          // Synthesize a failed review result so the existing recode path runs.
          // Uses source='static-precheck' (no parseError/error) so the codex→GPT fallback
          // branch doesn't trigger — we want a direct recode, not another LLM pass.
          reviewPromise = Promise.resolve({
            passed: false,
            feedback: 'STATIC CHECK VIOLATIONS (must fix, these bypass LLM review):\n' + staticIssues,
            issues: preCheckBlocking.map(function(i) {
              return { severity: 'critical', file: i.file, line: i.line, message: i.message, text: i.text, rule: i.rule };
            }),
            criticalCount: preCheckBlocking.length,
            source: 'static-precheck',
          });
        }

        // Phase coverage pre-check: runs after static check passes but BEFORE the LLM
        // reviewer. The LLM reviewer does not validate AddCompletedPhase() phaseId strings
        // against the spec, so code that calls AddCompletedPhase("phase1") instead of
        // AddCompletedPhase("initialCollectSpaceJunk") receives passed:true and exits the
        // loop immediately, causing the post-loop phase coverage gate to throw with no
        // retries remaining.
        // Fix (auto-09618e16): use the same 3-level fuzzy coverage logic as the post-loop
        // gate so that any coverage < 80% triggers a recode while retries remain, not just
        // the total-absence (length === 0) case.
        if (!reviewPromise) {
          var expectedPhaseIds = assemblyPlanContracts.collectExpectedPhaseIds(ctx.blueprint);
          var expectedPhaseSource = assemblyPlanContracts.getExpectedPhaseSource(ctx.blueprint);
          if (expectedPhaseIds.length > 0) {
            // Build allCode including extra files (partial classes)
            var preCheckAllCode = reviewedCode;
            if (reviewExtraFiles) {
              for (var pefk in reviewExtraFiles) {
                if (reviewExtraFiles.hasOwnProperty(pefk)) preCheckAllCode += '\n' + reviewExtraFiles[pefk];
              }
            }
            var preCoverageInfo = assemblyPlanContracts.computePhaseCoverage(preCheckAllCode, expectedPhaseIds);
            var preCheckImplemented = preCoverageInfo.implementedCount;
            var preCheckCoverage = preCoverageInfo.coverage;
            if (preCheckCoverage < 0.8) {
              ctx.addLog('review', 'Phase coverage pre-check (round ' + round + '): ' + preCheckImplemented + '/' + expectedPhaseIds.length +
                ' (' + Math.round(preCheckCoverage * 100) + '%) — forcing recode without LLM review');
              reviewPromise = Promise.resolve({
                passed: false,
                feedback: 'PHASE COVERAGE FAILURE: Only ' + preCheckImplemented + '/' + expectedPhaseIds.length +
                  ' expected phases from the ' + expectedPhaseSource + ' contract have matching AddCompletedPhase() calls (' + Math.round(preCheckCoverage * 100) + '%).\n' +
                  'You MUST call AddCompletedPhase("phaseId") using the EXACT phaseId strings from the active ' + expectedPhaseSource +
                  ' contract for EACH phase when that phase\'s objective is completed by the player.\n' +
                  'Missing phases:\n' +
                  preCoverageInfo.missingPhaseIds.map(function(pid) { return '  - ' + pid; }).join('\n') + '\n\n' +
                  'Every phase listed in the active phase contract MUST have a corresponding ' +
                  'AddCompletedPhase("phaseId") call somewhere in the game logic. ' +
                  'Do NOT omit any phase. Do NOT use placeholder comments. ' +
                  'Do NOT use generic names like "phase1" or "phase2" — use the exact phaseId string from the active contract.',
                issues: preCoverageInfo.missingPhaseIds.map(function(pid) {
                  return {
                    severity: 'critical',
                    message: 'Missing AddCompletedPhase("' + pid + '")',
                    rule: 'phase-coverage',
                  };
                }),
                criticalCount: preCoverageInfo.missingPhaseIds.length,
                source: 'phase-precheck',
              });
            }
          }
        }

        // LLM reviewer — only reached when both static check and phase coverage
        // pre-check pass (i.e. reviewPromise is still unset).
        if (!reviewPromise) {
          // Round-limit gate: when REVIEW_LLM_ROUNDS_LIMIT is set, rounds past
          // the limit short-circuit to "pass" if static-check is clean — relying
          // on deterministic checks instead of repeating expensive LLM passes.
          var llmRoundLimit = parseInt(process.env.REVIEW_LLM_ROUNDS_LIMIT || '0', 10);
          if (llmRoundLimit > 0 && round > llmRoundLimit && preCheckBlocking.length === 0) {
            reviewerName = 'StaticCheckOnly';
            ctx.addLog('review', 'Round ' + round + ' exceeds REVIEW_LLM_ROUNDS_LIMIT=' + llmRoundLimit +
              ' and static-check is clean — skipping LLM review (warnings=' + preCheckWarnings.length + ')');
            reviewPromise = Promise.resolve({
              passed: true,
              source: 'round-limit-static-only',
              issues: preCheckWarnings,
              warningCount: preCheckWarnings.length,
              reviewerName: 'StaticCheckOnly',
            });
          } else if (isAssemblyReadyForDeterministicReview(ctx, preCheckWarnings, specCriticalCount)) {
            reviewerName = 'Deterministic';
            var bp = ctx.blueprint || {};
            var gate = (bp.assemblyDecision === 'assembly_ready') ? 'assembly-ready' : 'template-output';
            var tv = bp.templateValidation || {};
            ctx.addLog('review', 'Deterministic review gate passed (' + gate + ') — skipping Codex reviewer ' +
              '(static warnings=' + preCheckWarnings.length +
              (gate === 'template-output' ? ', templateCoverage=' + Number(bp.templateCoverage || 0).toFixed(2) +
                ', residueCount=' + ((tv.summary && tv.summary.markerResidueCount) || 0) : '') + ')');
            reviewPromise = Promise.resolve({
              passed: true,
              source: 'deterministic-review-' + gate,
              issues: preCheckWarnings,
              warningCount: preCheckWarnings.length,
              reviewerName: 'Deterministic',
            });
          } else if (USE_CODEX_REVIEW && codexReviewer) {
            llmHotPath.guard(ctx, 'review.codex-reviewer', {
              stage: 'review',
              purpose: 'adversarial code review',
              reason: 'deterministic review gate did not pass',
              estimatedTokens: Math.ceil(String(reviewedCode || '').length / 4),
              metadata: {
                round: round,
                staticWarningCount: preCheckWarnings.length,
                specCriticalCount: specCriticalCount,
                assemblyDecision: ctx.blueprint && ctx.blueprint.assemblyDecision || '',
                templateCoverage: ctx.blueprint && ctx.blueprint.templateCoverage || 0,
              },
            });
            reviewPromise = codexReviewer.reviewCodeWithCodex(reviewedCode, {
              taskId: ctx.taskId,
              log: function(msg) { ctx.addLog('review', msg); },
              extraFiles: reviewExtraFiles,
              assemblyPlanSummary: reviewPlanSummary,
            });
          } else if (codeReviewer && hasLegacyReviewerApiKey()) {
            // Guard: only invoke the legacy GPT-5.4 reviewer when OPENAI_API_KEY is
            // present. If the key was intentionally removed (Codex ChatGPT auth mode),
            // code-reviewer.js:594 would immediately throw MODEL_FATAL — crashing every
            // task in the process run. Skipping to the else-branch produces a clear,
            // actionable fatal instead.
            llmHotPath.guard(ctx, 'review.legacy-gpt-reviewer', {
              stage: 'review',
              purpose: 'legacy adversarial code review',
              reason: 'Codex reviewer unavailable or disabled',
              estimatedTokens: Math.ceil(String(reviewedCode || '').length / 4),
              metadata: {
                round: round,
                staticWarningCount: preCheckWarnings.length,
                specCriticalCount: specCriticalCount,
                assemblyDecision: ctx.blueprint && ctx.blueprint.assemblyDecision || '',
              },
            });
            reviewPromise = codeReviewer.reviewCode(reviewedCode, {
              taskId: ctx.taskId,
              log: function(msg) { ctx.addLog('review', msg); },
              poolNameMap: reviewPoolNameMap,
              assemblyPlanSummary: reviewPlanSummary,
            });
          } else {
            // Reached when:
            //   (a) codexReviewer failed to load AND codeReviewer is absent, OR
            //   (b) codexReviewer failed to load AND OPENAI_API_KEY is not set
            //       (key intentionally removed for Codex ChatGPT auth mode).
            // In both cases there is no viable reviewer path — abort with an
            // actionable message rather than cascading into a key-less GPT call.
            throw new Error('MODEL_FATAL: no reviewer available ' +
              '(USE_CODEX_REVIEW=' + USE_CODEX_REVIEW +
              ', codexReviewer=' + !!codexReviewer +
              ', codeReviewer=' + !!codeReviewer +
              ', hasLegacyKey=' + hasLegacyReviewerApiKey() + ')' +
              ' — set USE_CODEX_REVIEW=true or provide OPENAI_API_KEY');
          }
        }

        return reviewPromise.then(function(reviewResult) {
          // Codex → GPT-5.4 fallback, ONLY for transient parse/env errors.
          // Definitive model failures (quota/auth/402) are now thrown from
          // codex-reviewer as MODEL_FATAL and reject this promise directly,
          // so they never reach this .then. This guard is defense-in-depth:
          // if any future code path returns a fake {error: "quota..."} result,
          // we refuse to cascade into GPT-5.4 (which shares the same OPENAI_API_KEY
          // and would hit the same quota wall — doubling the wasted attempt).
          var wantsLegacyFallback = !reviewResult.passed && (reviewResult.parseError || reviewResult.error) && USE_CODEX_REVIEW && codexReviewer && codeReviewer;
          if (wantsLegacyFallback && !hasLegacyReviewerApiKey()) {
            ctx.addLog('review', 'Codex had transient env/parse error, but GPT-5.4 fallback is unavailable (no OPENAI_API_KEY)');
          }
          if (shouldFallbackToLegacyReviewer(reviewResult, USE_CODEX_REVIEW, codexReviewer, codeReviewer)) {
            ctx.addLog('review', 'Codex had transient env/parse error, falling back to GPT-5.4');
            llmHotPath.guard(ctx, 'review.legacy-gpt-fallback', {
              stage: 'review',
              purpose: 'legacy reviewer fallback',
              reason: 'Codex reviewer returned transient env/parse error',
              estimatedTokens: Math.ceil(String(reviewedCode || '').length / 4),
              metadata: {
                round: round,
                source: reviewResult.source || '',
                error: reviewResult.error || '',
              },
            });
            return codeReviewer.reviewCode(reviewedCode, {
              taskId: ctx.taskId,
              log: function(msg) { ctx.addLog('review', msg); },
              poolNameMap: reviewPoolNameMap,
              assemblyPlanSummary: reviewPlanSummary,
            });
          }
          return reviewResult;
        }).then(function(reviewResult) {
          if (shouldUseDeterministicReviewFallback(reviewResult, USE_CODEX_REVIEW, codexReviewer, codeReviewer)) {
            var fallbackWarning = {
              severity: 'warning',
              rule: 'reviewer-infra-fallback',
              message: 'Reviewer infrastructure degraded after deterministic prechecks: ' + String(reviewResult.error || 'transient reviewer failure'),
              source: reviewResult.source || 'reviewer',
            };
            ctx.addLog('review', 'Reviewer degraded after deterministic prechecks — continuing with warning: ' + fallbackWarning.message);
            ctx.reviewWarnings = (ctx.reviewWarnings || []).concat([fallbackWarning]);
            ctx.reportStatus('processing', { message: '[Linux] Reviewer 降级，继续后续验证...' });
            return { done: true, result: { passed: false, rounds: round, criticalCount: 0, warningOnly: true, warnings: ctx.reviewWarnings, degradedReview: true } };
          }

          var reviewFingerprint = buildReviewFingerprint(reviewResult);
          if (reviewResult.passed) {
            lastReviewFingerprint = null;
            sameReviewFingerprintCount = 0;
            var passedReviewerName = reviewResult.reviewerName || reviewerName;
            ctx.addLog('review', passedReviewerName + ' review PASSED' + (round > 1 ? ' (round ' + round + ')' : ''));
            ctx.reportStatus('processing', {
              message: ('[Linux] ' + passedReviewerName + ' 审核通过' + (round > 1 ? ' (第' + round + '轮)' : '')).slice(0, 100),
              qualityData: { reviewResult: { passed: true, reviewer: passedReviewerName, round: round } },
            });
            // Do NOT read from ctx.workDir here — recode() writes to a fresh temp dir,
            // leaving ctx.workDir untouched. The authoritative source is the closure
            // variable reviewedCode, which is synced after every recode pass.
            return { done: true, result: { passed: true, rounds: round } };
          }

          if (reviewFingerprint === lastReviewFingerprint) sameReviewFingerprintCount++;
          else {
            lastReviewFingerprint = reviewFingerprint;
            sameReviewFingerprintCount = 1;
          }

          if (sameReviewFingerprintCount >= REVIEW_REPEAT_BLOCK_AT) {
            var repeatCritCount = reviewResult.criticalCount || 0;
            ctx.addLog('review', 'Review fingerprint repeated ' + sameReviewFingerprintCount + ' rounds — early stop: ' + reviewFingerprint);
            throw new Error('Review stalled: same blocking issues repeated ' + sameReviewFingerprintCount + ' rounds' +
              (repeatCritCount > 0 ? ' (' + repeatCritCount + ' critical remain)' : ''));
          }

          if (round >= maxRounds) {
            var critCount = reviewResult.criticalCount || 0;
            if (critCount > 0) {
              ctx.addLog('review', reviewerName + ' review still has ' + critCount + ' critical issues after ' + maxRounds + ' rounds — BLOCKING');
              throw new Error('Review blocked: ' + critCount + ' critical issues remain after ' + maxRounds + ' rounds');
            }
            // Classify remaining warnings — block high-risk types
            var remainingIssues = reviewResult.issues || [];
            var highRiskWarnings = remainingIssues.filter(function(i) {
              var msg = (i.message || i.text || '').toLowerCase();
              return msg.indexOf('infinite loop') >= 0 ||
                     msg.indexOf('null reference') >= 0 ||
                     msg.indexOf('pool object') >= 0 ||
                     msg.indexOf('phase missing') >= 0 ||
                     msg.indexOf('phase will never complete') >= 0 ||
                     msg.indexOf('autoplay') >= 0 ||
                     msg.indexOf('instantiate') >= 0 ||
                     msg.indexOf('forbidden') >= 0 ||
                     msg.indexOf('setactive') >= 0 ||
                     msg.indexOf('destroy(') >= 0 ||
                     msg.indexOf('coroutine') >= 0 ||
                     msg.indexOf('startcoroutine') >= 0 ||
                     msg.indexOf('addcomponent') >= 0;
            });
            if (highRiskWarnings.length > 0) {
              ctx.addLog('review', 'High-risk warnings after ' + maxRounds + ' rounds — BLOCKING: ' +
                highRiskWarnings.map(function(w) { return w.message || w.text; }).join('; '));
              throw new Error('Review blocked: ' + highRiskWarnings.length + ' high-risk warnings remain');
            }
            ctx.addLog('review', remainingIssues.length + ' low-risk warnings after ' + maxRounds + ' rounds, passing with context');
            ctx.reviewWarnings = remainingIssues;
            return { done: true, result: { passed: false, rounds: round, criticalCount: 0, warningOnly: true, warnings: remainingIssues } };
          }

          var failRules = (reviewResult.issues || []).map(function(fri) { return fri.rule; }).filter(Boolean);
          var uniqFailRules = failRules.filter(function(r, idx) { return failRules.indexOf(r) === idx; });
          var failRulesTag = uniqFailRules.length > 0 ? ' [' + uniqFailRules.slice(0, 3).join(',') + (uniqFailRules.length > 3 ? ',…' : '') + ']' : '';
          ctx.addLog('review', reviewerName + ' review FAIL (' + round + '/' + maxRounds + ')' + failRulesTag + ', fixing...');
          ctx.reportStatus('processing', { message: '[Linux] ' + reviewerName + ' 审核失败 (' + round + '/' + maxRounds + ')，AI修复中...' });

          // Attach line numbers for issues found in review
          var reviewFeedbackText = reviewResult.feedback || '';
          if (reviewResult.issues && reviewResult.issues.length > 0) {
            var codeLines = reviewedCode.split('\n');
            var codeSnippets = [];
            for (var ri = 0; ri < Math.min(reviewResult.issues.length, 5); ri++) {
              var issue = reviewResult.issues[ri];
              var issueLine = issue.line || 0;
              if (issueLine > 0 && issueLine <= codeLines.length) {
                var snippetStart = Math.max(0, issueLine - 3);
                var snippetEnd = Math.min(codeLines.length, issueLine + 5);
                var snippet = [];
                for (var si = snippetStart; si < snippetEnd; si++) {
                  snippet.push('L' + (si + 1) + ': ' + codeLines[si]);
                }
                codeSnippets.push('Issue: ' + (issue.message || issue.text || '') + '\n' + snippet.join('\n'));
              }
            }
            if (codeSnippets.length > 0) {
              reviewFeedbackText += '\n\n=== CODE CONTEXT (fix these specific lines) ===\n' + codeSnippets.join('\n\n');
            }
          }

          var fixBlueprint = Object.assign({}, ctx.blueprint, {
            feedbackHistory: (ctx.blueprint.feedbackHistory || []).concat([
              { text: reviewFeedbackText, source: 'code-review' },
            ]),
          });

          // patchRecode 走 Sonnet 直出，不经过 CC CLI / 完整 prompt — 比 full recode 省 ~150KB token。
          // 旧条件要求所有 issue 都有 line>0，命中率太低（codex 输出经常缺 line）；
          // 改为只要 ≤3 issue 且至少 1 个有 line 就尝试 patch，patchRecode 自身失败时再回落到 full recode。
          var usePatch = shouldUsePatchRecode(reviewResult);
          var fixLog = function(msg) { ctx.addLog('review', msg); };

          var fixPromise;
          if (usePatch) {
            fixPromise = patchRecode({
              taskId: ctx.taskId,
              currentCode: reviewedCode,
              extraFiles: reviewExtraFiles,
              issues: reviewResult.issues,
              blueprint: fixBlueprint,
              label: 'reviewfix',
              round: round,
              log: fixLog,
            }).then(function(patchResult) {
              if (patchResult.ok) return patchResult;
              fixLog('patchRecode failed, falling back to full recode');
              return recode({
                taskId: ctx.taskId,
                currentCode: reviewedCode,
                extraFiles: reviewExtraFiles,
                blueprint: fixBlueprint,
                label: 'reviewfix',
                round: round,
                log: fixLog,
              });
            });
          } else {
            fixPromise = recode({
              taskId: ctx.taskId,
              currentCode: reviewedCode,
              extraFiles: reviewExtraFiles,
              blueprint: fixBlueprint,
              label: 'reviewfix',
              round: round,
              log: fixLog,
            });
          }

          return fixPromise.then(function(recodeResult) {
            if (recodeResult.ok) {
              // P2-8: Save pre-fix state for rollback if fix makes things worse
              var preFixCode = reviewedCode;
              var preFixExtras = {};
              for (var pfk in reviewExtraFiles) {
                if (reviewExtraFiles.hasOwnProperty(pfk)) preFixExtras[pfk] = reviewExtraFiles[pfk];
              }
              var preFixIssueCount = (reviewResult.criticalCount || 0) + (reviewResult.issues ? reviewResult.issues.length : 0);

              reviewedCode = recodeResult.code;
              if (recodeResult.extraFiles) {
                for (var efn in recodeResult.extraFiles) {
                  if (recodeResult.extraFiles.hasOwnProperty(efn)) {
                    reviewExtraFiles[efn] = recodeResult.extraFiles[efn];
                  }
                }
              }

              // Quick static check: if fix introduced significantly more issues, rollback
              var postFixConformance = checkConformance(reviewedCode, ctx.blueprint);
              var postFixIssueEstimate = postFixConformance.criticalCount + postFixConformance.warningCount;
              var preFixConformance = checkConformance(preFixCode, ctx.blueprint);
              var preFixIssueEstimate = preFixConformance.criticalCount + preFixConformance.warningCount;
              if (postFixIssueEstimate > preFixIssueEstimate + 2) {
                ctx.addLog('review', 'Fix rollback: conformance issues increased (' + preFixIssueEstimate + ' → ' + postFixIssueEstimate + '), reverting to pre-fix code');
                reviewedCode = preFixCode;
                reviewExtraFiles = preFixExtras;
              } else {
                ctx.addLog('review', 'Review fix applied (' + reviewedCode.length + ' chars' + (recodeResult.patchApplied ? ', patch mode' : '') + ')');
              }
              }
            return { done: false };
          });
        }).catch(function(reviewErr) {
          if (shouldUseDeterministicReviewFallback(reviewErr, USE_CODEX_REVIEW, codexReviewer, codeReviewer)) {
            var fallbackText = String(reviewErr && reviewErr.message || reviewErr || 'transient reviewer failure');
            var fallbackWarning = {
              severity: 'warning',
              rule: 'reviewer-infra-fallback',
              message: 'Reviewer infrastructure degraded after deterministic prechecks: ' + fallbackText,
              source: 'reviewer',
            };
            ctx.addLog('review', 'Reviewer degraded after deterministic prechecks — continuing with warning: ' + fallbackWarning.message);
            ctx.reviewWarnings = (ctx.reviewWarnings || []).concat([fallbackWarning]);
            ctx.reportStatus('processing', { message: '[Linux] Reviewer 降级，继续后续验证...' });
            return { done: true, result: { passed: false, rounds: round, criticalCount: 0, warningOnly: true, warnings: ctx.reviewWarnings, degradedReview: true } };
          }
          throw reviewErr;
        });
      },
    });

    return loop.run(ctx).then(function(result) {
      // Sync ctx.csCode from the authoritative in-memory reviewedCode.
      // Do NOT read from ctx.workDir — recode() writes to a fresh temp dir
      // (/tmp/linux-reviewfix-<id>-<round>/), leaving ctx.workDir untouched.
      // Reading from disk would clobber ctx.csCode with the stale pre-recode
      // codegen file, causing the coverage gate below to see 0 phase IDs.
      ctx.csCode = reviewedCode;
      if (reviewExtraFiles) {
        ctx.extraFiles = Object.assign({}, reviewExtraFiles);
      }

      // Phase coverage gate: block if < 80% of spec phases are implemented
      // P1: Use normalized fuzzy matching to avoid false negatives from phaseId naming differences
      var expectedPhaseIds = assemblyPlanContracts.collectExpectedPhaseIds(ctx.blueprint);
      if (expectedPhaseIds.length > 0) {
        var coverageInfo = assemblyPlanContracts.computePhaseCoverage(assemblyPlanContracts.buildAggregateCodeFromContext(ctx), expectedPhaseIds);
        ctx.addLog('review', 'Phase coverage (fuzzy): ' + coverageInfo.implementedCount + '/' + coverageInfo.expectedPhaseIds.length + ' (' + Math.round(coverageInfo.coverage * 100) + '%)');
        if (coverageInfo.coverage < 0.8) {
          throw new Error('Phase coverage too low: ' + coverageInfo.implementedCount + '/' + coverageInfo.expectedPhaseIds.length +
            ' (' + Math.round(coverageInfo.coverage * 100) + '%). Missing: ' + coverageInfo.missingPhaseIds.join(', '));
        }
      }

      return result;
    });
  },
};
