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
  fixed = fixed.replace(/([A-Za-z_][A-Za-z0-9_]*)\.transform\.position\s*=\s*\1\.transform\.position\s*\+\s*new\s+Vector3\s*\(\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^)]+)\s*\)\s*;/g,
    function(_m, obj, dx, dy, dz) {
      fixes++;
      return 'var __hpPos = ' + obj + '.transform.position; __hpPos.x += ' + dx.trim() + '; __hpPos.y += ' + dy.trim() + '; __hpPos.z += ' + dz.trim() + '; ' + obj + '.transform.position = __hpPos;';
    });
  fixed = fixed.replace(/([A-Za-z_][A-Za-z0-9_]*)\.transform\.position\s*=\s*new\s+Vector3\s*\(\s*\1\.transform\.position\.x\s*,\s*\1\.transform\.position\.y\s*\+\s*([^,]+)\s*,\s*\1\.transform\.position\.z\s*\)\s*;/g,
    function(_m, obj, dy) {
      fixes++;
      return 'var __hpPos = ' + obj + '.transform.position; __hpPos.y += ' + dy.trim() + '; ' + obj + '.transform.position = __hpPos;';
    });
  fixed = fixed.replace(/([A-Za-z_][A-Za-z0-9_]*)\.transform\.position\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\.transform\.position\s*\+\s*new\s+Vector3\s*\(\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^)]+)\s*\)\s*;/g,
    function(_m, targetObj, anchorObj, dx, dy, dz) {
      fixes++;
      var varName = '__hpPos' + fixes;
      return 'var ' + varName + ' = ' + anchorObj + '.transform.position; ' +
        varName + '.x += ' + dx.trim() + '; ' +
        varName + '.y += ' + dy.trim() + '; ' +
        varName + '.z += ' + dz.trim() + '; ' +
        targetObj + '.transform.position = ' + varName + ';';
    });
  return { code: fixed, changed: fixes > 0, fixes: fixes };
}

function repairPhaseGateRuntimeMoves(code) {
  if (!code || code.indexOf('Snapshot_') < 0 || code.indexOf('Phase_') < 0) {
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

  var snapshotEntities = extractSnapshotEntities(code);
  var phaseIds = Object.keys(snapshotEntities);
  if (phaseIds.length === 0) {
    return { code: code, changed: false, fixes: 0 };
  }

  var initRanges = collectInitRanges(code, phaseIds);
  var fixed = code;
  var fixes = 0;
  var fallbackOrdinal = 0;

  for (var pi = 0; pi < phaseIds.length; pi++) {
    var pid = phaseIds[pi];
    var entities = snapshotEntities[pid];
    if (!entities || entities.length === 0) continue;
    var initMethod = extractMethodRange(fixed, 'Phase_' + pid + '_Init');
    if (!initMethod) continue;
    for (var ei = 0; ei < entities.length; ei++) {
      var entityName = entities[ei];
      if (hasRuntimeMove(fixed, entityName, initRanges)) continue;
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

function repairKnownStructuralDamage(mainCode, extraFiles) {
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
  var mainPhaseGateFix = repairPhaseGateRuntimeMoves(mainCode);
  if (mainPhaseGateFix.changed) {
    mainCode = mainPhaseGateFix.code;
    changed = true;
    fixes.push('main:PhaseGateRuntimeMove x' + mainPhaseGateFix.fixes);
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
    var phaseGateRes = repairPhaseGateRuntimeMoves(nextExtras[name]);
    if (phaseGateRes.changed) {
      nextExtras[name] = phaseGateRes.code;
      changed = true;
      fixes.push(name + ':PhaseGateRuntimeMove x' + phaseGateRes.fixes);
    }
  });
  return {
    code: mainCode,
    extraFiles: nextExtras,
    changed: changed,
    fixes: fixes,
  };
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
        var repaired = repairKnownStructuralDamage(reviewedCode, reviewExtraFiles);
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
          var specPhases = ctx.blueprint.specs || [];
          if (specPhases.length > 0) {
            // Build allCode including extra files (partial classes)
            var preCheckAllCode = reviewedCode;
            if (reviewExtraFiles) {
              for (var pefk in reviewExtraFiles) {
                if (reviewExtraFiles.hasOwnProperty(pefk)) preCheckAllCode += '\n' + reviewExtraFiles[pefk];
              }
            }
            var preCheckCodeLower = preCheckAllCode.toLowerCase();

            // Extract all phaseId strings from AddCompletedPhase/ReportPhase calls
            var phaseCallMatches = preCheckAllCode.match(/(?:AddCompletedPhase|ReportPhase)\s*\(\s*"([^"]+)"/g) || [];
            var preCheckPhaseIds = [];
            for (var pcm = 0; pcm < phaseCallMatches.length; pcm++) {
              var pcmMatch = phaseCallMatches[pcm].match(/"([^"]+)"/);
              if (pcmMatch) preCheckPhaseIds.push(pcmMatch[1]);
            }
            var preCheckPhaseIdsLower = preCheckPhaseIds.map(function(id) { return id.toLowerCase().replace(/[_\s-]/g, ''); });

            var preCheckImplemented = 0;
            for (var psi = 0; psi < specPhases.length; psi++) {
              var ppid = specPhases[psi].phaseId;
              // Level 1: exact match
              if (preCheckCodeLower.indexOf('"' + ppid.toLowerCase() + '"') >= 0) {
                preCheckImplemented++;
                continue;
              }
              // Level 2: normalized match (strip underscores/spaces/dashes, case-insensitive)
              var ppidNorm = ppid.toLowerCase().replace(/[_\s-]/g, '');
              var ppidFound = false;
              for (var pci = 0; pci < preCheckPhaseIdsLower.length; pci++) {
                if (preCheckPhaseIdsLower[pci] === ppidNorm ||
                    preCheckPhaseIdsLower[pci].indexOf(ppidNorm) >= 0 ||
                    ppidNorm.indexOf(preCheckPhaseIdsLower[pci]) >= 0) {
                  ppidFound = true;
                  break;
                }
              }
              if (ppidFound) {
                preCheckImplemented++;
                continue;
              }
              // Level 3: keyword overlap — split camelCase into words and check overlap
              var ppidWords = ppid.replace(/([A-Z])/g, ' $1').toLowerCase().trim().split(/\s+/);
              for (var pcwi = 0; pcwi < preCheckPhaseIds.length; pcwi++) {
                var pcodeWords = preCheckPhaseIds[pcwi].replace(/([A-Z])/g, ' $1').toLowerCase().trim().split(/\s+/);
                var pcOverlap = 0;
                for (var pswi = 0; pswi < ppidWords.length; pswi++) {
                  if (ppidWords[pswi].length >= 3 && pcodeWords.indexOf(ppidWords[pswi]) >= 0) pcOverlap++;
                }
                if (pcOverlap >= Math.max(2, Math.floor(ppidWords.length * 0.5))) {
                  preCheckImplemented++;
                  ppidFound = true;
                  break;
                }
              }
            }

            var preCheckCoverage = preCheckImplemented / specPhases.length;
            if (preCheckCoverage < 0.8) {
              // Build missing phase list using same fuzzy logic
              var missingPhaseIds = [];
              for (var mpi = 0; mpi < specPhases.length; mpi++) {
                var mppid = specPhases[mpi].phaseId;
                var mppidNorm = mppid.toLowerCase().replace(/[_\s-]/g, '');
                var mppidFound = preCheckCodeLower.indexOf('"' + mppid.toLowerCase() + '"') >= 0;
                if (!mppidFound) {
                  for (var mpci = 0; mpci < preCheckPhaseIdsLower.length; mpci++) {
                    if (preCheckPhaseIdsLower[mpci] === mppidNorm ||
                        preCheckPhaseIdsLower[mpci].indexOf(mppidNorm) >= 0 ||
                        mppidNorm.indexOf(preCheckPhaseIdsLower[mpci]) >= 0) {
                      mppidFound = true;
                      break;
                    }
                  }
                }
                if (!mppidFound) {
                  // Also check level-3 keyword overlap before marking missing
                  var mppidWords = mppid.replace(/([A-Z])/g, ' $1').toLowerCase().trim().split(/\s+/);
                  for (var mpcwi = 0; mpcwi < preCheckPhaseIds.length && !mppidFound; mpcwi++) {
                    var mpcodeWords = preCheckPhaseIds[mpcwi].replace(/([A-Z])/g, ' $1').toLowerCase().trim().split(/\s+/);
                    var mpcOverlap = 0;
                    for (var mpswi = 0; mpswi < mppidWords.length; mpswi++) {
                      if (mppidWords[mpswi].length >= 3 && mpcodeWords.indexOf(mppidWords[mpswi]) >= 0) mpcOverlap++;
                    }
                    if (mpcOverlap >= Math.max(2, Math.floor(mppidWords.length * 0.5))) {
                      mppidFound = true;
                    }
                  }
                }
                if (!mppidFound) missingPhaseIds.push(mppid);
              }
              ctx.addLog('review', 'Phase coverage pre-check (round ' + round + '): ' + preCheckImplemented + '/' + specPhases.length +
                ' (' + Math.round(preCheckCoverage * 100) + '%) — forcing recode without LLM review');
              reviewPromise = Promise.resolve({
                passed: false,
                feedback: 'PHASE COVERAGE FAILURE: Only ' + preCheckImplemented + '/' + specPhases.length +
                  ' spec phases have matching AddCompletedPhase() calls (' + Math.round(preCheckCoverage * 100) + '%).\n' +
                  'You MUST call AddCompletedPhase("phaseId") using the EXACT phaseId strings from the spec ' +
                  'for EACH phase when that phase\'s objective is completed by the player.\n' +
                  'Missing phases:\n' +
                  missingPhaseIds.map(function(pid) { return '  - ' + pid; }).join('\n') + '\n\n' +
                  'Every phase listed in the blueprint spec MUST have a corresponding ' +
                  'AddCompletedPhase("phaseId") call somewhere in the game logic. ' +
                  'Do NOT omit any phase. Do NOT use placeholder comments. ' +
                  'Do NOT use generic names like "phase1" or "phase2" — use the exact phaseId string from the spec.',
                issues: missingPhaseIds.map(function(pid) {
                  return {
                    severity: 'critical',
                    message: 'Missing AddCompletedPhase("' + pid + '")',
                    rule: 'phase-coverage',
                  };
                }),
                criticalCount: missingPhaseIds.length,
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
            });
          } else if (codeReviewer) {
            reviewPromise = codeReviewer.reviewCode(reviewedCode, {
              taskId: ctx.taskId,
              log: function(msg) { ctx.addLog('review', msg); },
              poolNameMap: reviewPoolNameMap,
            });
          } else {
            // Unreachable: the top-of-execute guard already throws MODEL_FATAL
            // if neither reviewer is loaded. Retained as defense-in-depth —
            // any future code path that lands here aborts rather than pretending
            // the review passed.
            throw new Error('MODEL_FATAL: no reviewer invocation path matched');
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
          var isDefinitive = reviewResult.error && /MODEL_FATAL|quota|insufficient|\b401\b|\b402\b|\b403\b|invalid.?api.?key|unauthoriz/i.test(reviewResult.error);
          if (!reviewResult.passed && (reviewResult.parseError || reviewResult.error) && !isDefinitive && USE_CODEX_REVIEW && codexReviewer && codeReviewer) {
            ctx.addLog('review', 'Codex had transient env/parse error, falling back to GPT-5.4');
            return codeReviewer.reviewCode(reviewedCode, {
              taskId: ctx.taskId,
              log: function(msg) { ctx.addLog('review', msg); },
              poolNameMap: reviewPoolNameMap,
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
          var issuesWithLine = (reviewResult.issues || []).filter(function(i) { return i.line > 0; });
          var usePatch = reviewResult.issues && reviewResult.issues.length <= 3
            && issuesWithLine.length >= 1;
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
      var specs = ctx.blueprint.specs || [];
      if (specs.length > 0) {
        var code = ctx.csCode || '';
        // Also check extra files (partial classes)
        var allCode = code;
        if (ctx.extraFiles) {
          for (var efk in ctx.extraFiles) {
            allCode += '\n' + ctx.extraFiles[efk];
          }
        }
        var codeLower = allCode.toLowerCase();

        // Extract all phaseId strings from AddCompletedPhase/ReportPhase calls in actual code
        var codePhaseIds = [];
        var phaseIdMatches = allCode.match(/(?:AddCompletedPhase|ReportPhase)\s*\(\s*"([^"]+)"/g) || [];
        for (var pmi = 0; pmi < phaseIdMatches.length; pmi++) {
          var idMatch = phaseIdMatches[pmi].match(/"([^"]+)"/);
          if (idMatch) codePhaseIds.push(idMatch[1]);
        }
        var codePhaseIdsLower = codePhaseIds.map(function(id) { return id.toLowerCase().replace(/[_\s-]/g, ''); });

        var implementedCount = 0;
        for (var si = 0; si < specs.length; si++) {
          var pid = specs[si].phaseId;
          // Level 1: exact match
          if (codeLower.indexOf('"' + pid.toLowerCase() + '"') >= 0) {
            implementedCount++;
            continue;
          }
          // Level 2: normalized match (strip underscores, case-insensitive)
          var pidNorm = pid.toLowerCase().replace(/[_\s-]/g, '');
          var foundNorm = false;
          for (var cpi = 0; cpi < codePhaseIdsLower.length; cpi++) {
            if (codePhaseIdsLower[cpi] === pidNorm ||
                codePhaseIdsLower[cpi].indexOf(pidNorm) >= 0 ||
                pidNorm.indexOf(codePhaseIdsLower[cpi]) >= 0) {
              foundNorm = true;
              break;
            }
          }
          if (foundNorm) {
            implementedCount++;
            continue;
          }
          // Level 3: keyword overlap — split camelCase into words and check overlap
          var specWords = pid.replace(/([A-Z])/g, ' $1').toLowerCase().trim().split(/\s+/);
          for (var cwi = 0; cwi < codePhaseIds.length; cwi++) {
            var codeWords = codePhaseIds[cwi].replace(/([A-Z])/g, ' $1').toLowerCase().trim().split(/\s+/);
            var overlap = 0;
            for (var swi = 0; swi < specWords.length; swi++) {
              if (specWords[swi].length >= 3 && codeWords.indexOf(specWords[swi]) >= 0) overlap++;
            }
            if (overlap >= Math.max(2, Math.floor(specWords.length * 0.5))) {
              implementedCount++;
              foundNorm = true;
              break;
            }
          }
        }
        var coverage = implementedCount / specs.length;
        ctx.addLog('review', 'Phase coverage (fuzzy): ' + implementedCount + '/' + specs.length + ' (' + Math.round(coverage * 100) + '%)');
        if (coverage < 0.8) {
          var missingPhases = [];
          for (var mi = 0; mi < specs.length; mi++) {
            var mpid = specs[mi].phaseId;
            var mpidNorm = mpid.toLowerCase().replace(/[_\s-]/g, '');
            var found = codeLower.indexOf('"' + mpid.toLowerCase() + '"') >= 0;
            if (!found) {
              for (var mci = 0; mci < codePhaseIdsLower.length; mci++) {
                if (codePhaseIdsLower[mci] === mpidNorm ||
                    codePhaseIdsLower[mci].indexOf(mpidNorm) >= 0 ||
                    mpidNorm.indexOf(codePhaseIdsLower[mci]) >= 0) {
                  found = true;
                  break;
                }
              }
            }
            if (!found) missingPhases.push(mpid);
          }
          throw new Error('Phase coverage too low: ' + implementedCount + '/' + specs.length +
            ' (' + Math.round(coverage * 100) + '%). Missing: ' + missingPhases.join(', '));
        }
      }

      return result;
    });
  },
};
