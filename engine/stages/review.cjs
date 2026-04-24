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
var { staticCheck, getBlockingIssues } = require('../static-check.cjs');
var { checkConformance } = require('../spec-conformance.cjs');
var { normalizeFingerprint } = require('../metrics.cjs');
var assemblyPlanContracts = require('../assembly-plan-contracts.cjs');

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

function rewriteHotPathVectorAllocations(code) {
  if (!code || code.indexOf('new Vector3') < 0) {
    return { code: code, changed: false, fixes: 0 };
  }
  var fixes = 0;
  var fixed = code;
  function buildStructCopy(varName, anchorExpr, dx, dy, dz, targetExpr) {
    var parts = ['var ' + varName + ' = ' + anchorExpr + ';'];
    if (dx && dx.trim() && dx.trim() !== '0') parts.push(varName + '.x += ' + dx.trim() + ';');
    if (dy && dy.trim() && dy.trim() !== '0') parts.push(varName + '.y += ' + dy.trim() + ';');
    if (dz && dz.trim() && dz.trim() !== '0') parts.push(varName + '.z += ' + dz.trim() + ';');
    parts.push(targetExpr + ' = ' + varName + ';');
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
      return decl + ' ' + varName + ' = ' + anchorObj + '.transform.position; ' +
        (dx && dx.trim() && dx.trim() !== '0' ? varName + '.x += ' + dx.trim() + '; ' : '') +
        (dy && dy.trim() && dy.trim() !== '0' ? varName + '.y += ' + dy.trim() + '; ' : '') +
        (dz && dz.trim() && dz.trim() !== '0' ? varName + '.z += ' + dz.trim() + '; ' : '');
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

  function buildFallbackMoveLines(entityName, ordinal) {
    var varName = '__gateMovePos' + ordinal;
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
      var phaseIdMatch = /\bEnterPhase\s*\(\s*[^,]+,\s*"([^"]+)"/.exec(block);
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

  function buildFallbackMoveLines(entityName, ordinal) {
    var varName = '__gateMovePos' + ordinal;
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

      if (!updateHasPhaseScopedMove(nextMain, def.phaseId, entityName)) {
        mainLines = mainLines.concat(moveLines);
      }

      filesByName = Object.assign({ main: nextMain }, nextExtras);
      if (!handlerHasPhaseMove(filesByName, def.phaseId, 'ONTAP', entityName)) {
        onTapLines = onTapLines.concat(moveLines);
      }

      filesByName = Object.assign({ main: nextMain }, nextExtras);
      if (!handlerHasPhaseMove(filesByName, def.phaseId, 'ONAUTOARRIVE', entityName)) {
        onAutoLines = onAutoLines.concat(moveLines);
      }
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

function repairKnownStructuralDamage(mainCode, extraFiles, blueprint) {
  var changed = false;
  var fixes = [];
  var mainStubFix = collapseLegacyCheckEventRulesStub(mainCode);
  if (mainStubFix.changed) {
    mainCode = mainStubFix.code;
    changed = true;
    fixes.push('main:LegacyCheckEventRulesStub x' + mainStubFix.fixes);
  }
  var mainFix = repairUpdateGameStateBridge(mainCode);
  if (mainFix.changed) {
    mainCode = mainFix.code;
    changed = true;
    fixes.push('main:UpdateGameState x' + mainFix.fixes);
  }
  var mainInitFix = stripInitMaterialFromScene(mainCode);
  if (mainInitFix.changed) {
    mainCode = mainInitFix.code;
    changed = true;
    fixes.push('main:InitMaterialFromScene x' + mainInitFix.fixes);
  }
  var mainShowCTAFix = stripEarlyShowCTA(mainCode);
  if (mainShowCTAFix.changed) {
    mainCode = mainShowCTAFix.code;
    changed = true;
    fixes.push('main:EarlyShowCTA x' + mainShowCTAFix.fixes);
  }
  var mainFinishGameFix = normalizeFinishGameTerminalFlow(mainCode);
  if (mainFinishGameFix.changed) {
    mainCode = mainFinishGameFix.code;
    changed = true;
    fixes.push('main:FinishGameFlow x' + mainFinishGameFix.fixes);
  }
  var mainVectorFix = rewriteHotPathVectorAllocations(mainCode);
  if (mainVectorFix.changed) {
    mainCode = mainVectorFix.code;
    changed = true;
    fixes.push('main:HotVectorAlloc x' + mainVectorFix.fixes);
  }
  var mainSetScaleFix = normalizeSetScaleCalls(mainCode);
  if (mainSetScaleFix.changed) {
    mainCode = mainSetScaleFix.code;
    changed = true;
    fixes.push('main:SetScaleNormalize x' + mainSetScaleFix.fixes);
  }
  var mainPhaseGateFix = repairPhaseGateRuntimeMoves(mainCode);
  if (mainPhaseGateFix.changed) {
    mainCode = mainPhaseGateFix.code;
    changed = true;
    fixes.push('main:PhaseGateRuntimeMove x' + mainPhaseGateFix.fixes);
  }
  var mainGateShortcutFix = stripInteractionFlagShortcutsFromPhaseGates(mainCode, blueprint);
  if (mainGateShortcutFix.changed) {
    mainCode = mainGateShortcutFix.code;
    changed = true;
    fixes.push('main:PhaseGateShortcutStrip x' + mainGateShortcutFix.fixes);
  }
  var mainLongIfFix = rewriteLongIfChainsAsSwitches(mainCode);
  if (mainLongIfFix.changed) {
    mainCode = mainLongIfFix.code;
    changed = true;
    fixes.push('main:LongIfChainSwitch x' + mainLongIfFix.fixes);
  }
  var nextExtras = Object.assign({}, extraFiles || {});
  Object.keys(nextExtras).forEach(function(name) {
    var stubRes = collapseLegacyCheckEventRulesStub(nextExtras[name]);
    if (stubRes.changed) {
      nextExtras[name] = stubRes.code;
      changed = true;
      fixes.push(name + ':LegacyCheckEventRulesStub x' + stubRes.fixes);
    }
    var res = repairUpdateGameStateBridge(nextExtras[name]);
    if (res.changed) {
      nextExtras[name] = res.code;
      changed = true;
      fixes.push(name + ':UpdateGameState x' + res.fixes);
    }
    var initRes = stripInitMaterialFromScene(nextExtras[name]);
    if (initRes.changed) {
      nextExtras[name] = initRes.code;
      changed = true;
      fixes.push(name + ':InitMaterialFromScene x' + initRes.fixes);
    }
    var showCTARes = stripEarlyShowCTA(nextExtras[name]);
    if (showCTARes.changed) {
      nextExtras[name] = showCTARes.code;
      changed = true;
      fixes.push(name + ':EarlyShowCTA x' + showCTARes.fixes);
    }
    var finishGameRes = normalizeFinishGameTerminalFlow(nextExtras[name]);
    if (finishGameRes.changed) {
      nextExtras[name] = finishGameRes.code;
      changed = true;
      fixes.push(name + ':FinishGameFlow x' + finishGameRes.fixes);
    }
    var vectorRes = rewriteHotPathVectorAllocations(nextExtras[name]);
    if (vectorRes.changed) {
      nextExtras[name] = vectorRes.code;
      changed = true;
      fixes.push(name + ':HotVectorAlloc x' + vectorRes.fixes);
    }
    var setScaleRes = normalizeSetScaleCalls(nextExtras[name]);
    if (setScaleRes.changed) {
      nextExtras[name] = setScaleRes.code;
      changed = true;
      fixes.push(name + ':SetScaleNormalize x' + setScaleRes.fixes);
    }
    var phaseGateRes = repairPhaseGateRuntimeMoves(nextExtras[name]);
    if (phaseGateRes.changed) {
      nextExtras[name] = phaseGateRes.code;
      changed = true;
      fixes.push(name + ':PhaseGateRuntimeMove x' + phaseGateRes.fixes);
    }
    var gateShortcutRes = stripInteractionFlagShortcutsFromPhaseGates(nextExtras[name], blueprint);
    if (gateShortcutRes.changed) {
      nextExtras[name] = gateShortcutRes.code;
      changed = true;
      fixes.push(name + ':PhaseGateShortcutStrip x' + gateShortcutRes.fixes);
    }
    var longIfRes = rewriteLongIfChainsAsSwitches(nextExtras[name]);
    if (longIfRes.changed) {
      nextExtras[name] = longIfRes.code;
      changed = true;
      fixes.push(name + ':LongIfChainSwitch x' + longIfRes.fixes);
    }
  });
  var crossPhaseGateFix = repairPhaseGateRuntimeMovesAcrossPartials(mainCode, nextExtras);
  if (crossPhaseGateFix.changed) {
    mainCode = crossPhaseGateFix.code;
    nextExtras = crossPhaseGateFix.extraFiles;
    changed = true;
    fixes.push('partials:PhaseGateRuntimeMove x' + crossPhaseGateFix.fixes);
  }
  var postCrossLongIfFix = rewriteLongIfChainsAsSwitches(mainCode);
  if (postCrossLongIfFix.changed) {
    mainCode = postCrossLongIfFix.code;
    changed = true;
    fixes.push('main:LongIfChainSwitchPostPhaseGate x' + postCrossLongIfFix.fixes);
  }
  Object.keys(nextExtras).forEach(function(name) {
    var res = rewriteLongIfChainsAsSwitches(nextExtras[name]);
    if (res.changed) {
      nextExtras[name] = res.code;
      changed = true;
      fixes.push(name + ':LongIfChainSwitchPostPhaseGate x' + res.fixes);
    }
  });
  return {
    code: mainCode,
    extraFiles: nextExtras,
    changed: changed,
    fixes: fixes,
  };
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

function shouldFallbackToLegacyReviewer(reviewResult, useCodexReview, hasCodexReviewer, hasLegacyReviewer) {
  if (!reviewResult) return false;
  var isDefinitive = reviewResult.error && /MODEL_FATAL|quota|insufficient|\b401\b|\b402\b|\b403\b|invalid.?api.?key|unauthoriz/i.test(reviewResult.error);
  return !reviewResult.passed &&
    (reviewResult.parseError || reviewResult.error) &&
    !isDefinitive &&
    !!useCodexReview &&
    !!hasCodexReviewer &&
    !!hasLegacyReviewer &&
    hasLegacyReviewerApiKey();
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
  repairPhaseGateRuntimeMoves: repairPhaseGateRuntimeMoves,
  repairPhaseGateRuntimeMovesAcrossPartials: repairPhaseGateRuntimeMovesAcrossPartials,
  stripInteractionFlagShortcutsFromPhaseGates: stripInteractionFlagShortcutsFromPhaseGates,
  rewriteLongIfChainsAsSwitches: rewriteLongIfChainsAsSwitches,
  hasLegacyReviewerApiKey: hasLegacyReviewerApiKey,
  shouldFallbackToLegacyReviewer: shouldFallbackToLegacyReviewer,
  repairKnownStructuralDamage: repairKnownStructuralDamage,
  canSkip: function(ctx) {
    return process.env.SKIP_CODE_REVIEW === 'true' || !ctx.csCode;
  },
  assertBefore: function(ctx) {
    if (!ctx.csCode) throw new Error('No code to review');
    var lines = ctx.csCode.split('\n');
    var lineCount = lines.length;
    var findCalls = (ctx.csCode.match(/GameObject\.Find/g) || []).length;
    var gfmCalls = (ctx.csCode.match(/GFM_Create\.Obj/g) || []).length;
    var todoLines = lines.filter(function(l) { return /\/\/ TODO(?!_\w+(?:START|END))/i.test(l); }).length;
    var todoRatio = todoLines / lineCount;
    if (lineCount < 100) throw new Error('Stub code: only ' + lineCount + ' lines');
    if (findCalls === 0 && gfmCalls === 0) throw new Error('No GameObject.Find or GFM_Create calls — likely stub');
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
    var reviewPlanSummary = assemblyPlanContracts.buildReviewPlanGuidance(ctx.blueprint && ctx.blueprint.plans);
    var lastReviewFingerprint = null;
    var sameReviewFingerprintCount = 0;

    // Spec conformance check: verify code semantics match blueprint
    // P1-6: Only inject as feedback if there are genuine critical issues after fuzzy matching
    // This prevents "phaseId naming mismatch" from poisoning the fix loop
    if (ctx.blueprint.specs && ctx.blueprint.specs.length > 0) {
      var conformance = checkConformance(reviewedCode, ctx.blueprint);
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
        var preCheck = staticCheck(reviewedCode, { extraFiles: reviewExtraFiles, blueprint: ctx.blueprint });
        // W1a introduced warning-severity rules (require-member-doc / require-branch-comment /
        // method-too-long). `preCheck.passed` is `issues.length === 0`, so warnings were
        // treating the fix-loop as blocking. Filter to blocking issues for the recode
        // decision; non-blocking issues still get logged as feedback.
        var preCheckBlocking = (preCheck.issues || []).filter(function(i) { return i.blocking; });
        var preCheckWarnings = (preCheck.issues || []).filter(function(i) { return !i.blocking; });
        if (preCheckWarnings.length > 0) {
          ctx.addLog('review', 'Static check (round ' + round + ') warnings (non-blocking): ' + preCheckWarnings.length);
        }
        if (preCheckBlocking.length > 0) {
          var staticIssues = preCheckBlocking.map(function(i) {
            return 'L' + i.line + ': ' + i.message + ' — ' + i.text;
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
              return { severity: 'critical', line: i.line, message: i.message, text: i.text, rule: i.rule };
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
          if (USE_CODEX_REVIEW && codexReviewer) {
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
            return codeReviewer.reviewCode(reviewedCode, {
              taskId: ctx.taskId,
              log: function(msg) { ctx.addLog('review', msg); },
              poolNameMap: reviewPoolNameMap,
              assemblyPlanSummary: reviewPlanSummary,
            });
          }
          return reviewResult;
        }).then(function(reviewResult) {
          var reviewFingerprint = buildReviewFingerprint(reviewResult);
          if (reviewResult.passed) {
            lastReviewFingerprint = null;
            sameReviewFingerprintCount = 0;
            ctx.addLog('review', reviewerName + ' review PASSED' + (round > 1 ? ' (round ' + round + ')' : ''));
            ctx.reportStatus('processing', {
              message: ('[Linux] ' + reviewerName + ' 审核通过' + (round > 1 ? ' (第' + round + '轮)' : '')).slice(0, 100),
              qualityData: { reviewResult: { passed: true, reviewer: reviewerName, round: round } },
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
