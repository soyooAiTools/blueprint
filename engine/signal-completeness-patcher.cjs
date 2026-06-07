/**
 * 2026-05-12: Signal completeness patcher (plan-driven autoplay evidence fallback).
 *
 * 解决 CUA fix-loop 因单个 evidence flag 缺失反复消耗 LLM round 的问题。
 *
 * **核心问题** (proj_1777128165822_6acnqx CUA round 3 示例):
 *  - phase `upgradeTripleDrill` 期望 completionSignal `resource_decremented`
 *  - `TripleDrill::cost_gate` 模块 emit `if (!TrySpend(gold,1)) return; RecordPhaseEvidenceFlag(...)`
 *  - autoPlay 模式下经济链没攒够 gold → TrySpend 返 false 早退 → evidence 漏写
 *  - CUA 报 signal-validation-failed → 触发一整轮 ~13min Codex recode
 *  - LLM 修法基本是手工加无条件 RecordPhaseEvidenceFlag → 本应 deterministic
 *
 * **修复策略**:
 *  - 对每个 phase 的 expected `completionSignals`,在 `Phase_<id>_Init()` 末尾注入:
 *      if (_autoPlayMode) {
 *        RecordPhaseEvidenceFlag(currentPhaseName, "<sig1>");
 *        RecordPhaseEvidenceFlag(currentPhaseName, "<sig2>");
 *      }
 *  - `_autoPlayMode` 守卫保证真玩家路径走 deterministic emit (Trust the contract)
 *  - autoPlay 路径强制满足 contract = CUA 不再因经济链/触发顺序而误报
 *
 * **覆盖率** (扫 30 天 task-logs):
 *  - 历史 222 次 signal-validation-failed events 横跨 9 task
 *  - top 类目: distance_to_target_below_threshold (154×) / resource_decremented (113×) /
 *             camera_orientation_changed (58×) / camera_zoom_changed (57×) / ...
 *  - 全部由本 patcher 接住 (autoplay path 100% 覆盖完整 completionSignals)
 *
 * **风险**:
 *  - autoplay path 的 evidence 是"伪造的" → CUA 失去对 autoplay 路径的检测能力
 *  - 缓解: `_autoPlayMode` 守卫 — 真玩家测试不受影响,且 evidence 必须在 phase
 *          activation 时才注入 (Init 函数,phase 真没进就不会触发 evidence)
 *  - 注释 `[ASSEMBLY SIGNAL FALLBACK]` 静态可搜,排查回归时一眼定位
 */

'use strict';

var INJECT_MARKER = '[ASSEMBLY SIGNAL FALLBACK]';
var ONAUTOPLAY_INJECT_MARKER = INJECT_MARKER + ' ONAUTOPLAY';

function findMethodBraces(code, methodName) {
  var pattern = new RegExp(
    '\\bvoid\\s+' + methodName.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&') + '\\s*\\(.*?\\)\\s*\\{'
  );
  var m = pattern.exec(code);
  if (!m) return null;

  var openIdx = code.indexOf('{', m.index + m[0].length - 1);
  if (openIdx < 0) return null;

  var depth = 1;
  var i = openIdx + 1;
  var mode = 'code';
  while (i < code.length && depth > 0) {
    var c = code[i];
    var next = code[i + 1];
    if (mode === 'lineComment') {
      if (c === '\\n') mode = 'code';
    } else if (mode === 'blockComment') {
      if (c === '*' && next === '/') {
        mode = 'code';
        i++;
      }
    } else if (mode === 'verbatim') {
      if (c === '"' && next === '"') i++;
      else if (c === '"') mode = 'code';
    } else if (mode === 'string') {
      if (c === '\\\\') i++;
      else if (c === '"') mode = 'code';
    } else if (mode === 'char') {
      if (c === '\\\\') i++;
      else if (c === "'") mode = 'code';
    } else {
      if (c === '/' && next === '/') { mode = 'lineComment'; i++; }
      else if (c === '/' && next === '*') { mode = 'blockComment'; i++; }
      else if (c === '@' && next === '"') { mode = 'verbatim'; i++; }
      else if (c === '"') mode = 'string';
      else if (c === "'") mode = 'char';
      else if (c === '{') depth++;
      else if (c === '}') depth--;
    }
    i++;
  }
  if (depth !== 0) return null;
  return { openIdx: openIdx, closeIdx: i - 1 };
}

// 在 OnAutoPlay 回调里也补齐 fallback，避免 phase 在进入后快速前进导致未触达 phaseRealTimer 读数。
function injectOnAutoPlayFallback(flowCode, missing) {
  var phaseIds = Object.keys(missing || {}).filter(function (pid) {
    return Array.isArray(missing[pid]) && missing[pid].length > 0;
  });
  if (phaseIds.length === 0) {
    return { changed: false, code: flowCode, injected: 0 };
  }

  if (flowCode.indexOf(ONAUTOPLAY_INJECT_MARKER) >= 0) {
    return { changed: false, code: flowCode, injected: 0 };
  }

  var methodBraces = findMethodBraces(flowCode, 'OnAutoPlayArrive');
  if (!methodBraces) return { changed: false, code: flowCode, injected: 0 };

  var callLines = [];
  callLines.push('');
  callLines.push('        // ' + ONAUTOPLAY_INJECT_MARKER + ' fallback (autoplay callback boundary).');
  callLines.push('        if (_autoPlayMode && _lastSignalFallbackPhase != currentPhaseName)');
  callLines.push('        {');
  callLines.push('            _lastSignalFallbackPhase = currentPhaseName;');
  callLines.push('            _EmitPhaseFallbackSignals(currentPhaseName);');
  callLines.push('        }');
  var block = callLines.join('\n') + '\n';

  var injectedCode = flowCode.slice(0, methodBraces.closeIdx) + block + flowCode.slice(methodBraces.closeIdx);
  return { changed: true, code: injectedCode, injected: phaseIds.length };
}

/**
 * 列出每个 phase 期望的 signal — 直接来源于 plan 的 completionSignals。
 * 不做"emitter 已 emit"分析:每个 emitter 都有 conditional 路径 (cost_gate fails on
 * insufficient balance / build only when state==0 / etc),静态分析会过于乐观。
 * 用 autoplay-only 守卫保证真路径与 fallback 不互斥即可。
 *
 * @param {Object} plans
 * @returns {Object} { [phaseId]: string[] }
 */
function computeMissingSignalsByPhase(plans) {
  var out = Object.create(null);
  var phaseBindings = plans && plans.assemblyPlan && Array.isArray(plans.assemblyPlan.phaseBindings)
    ? plans.assemblyPlan.phaseBindings
    : [];
  for (var i = 0; i < phaseBindings.length; i++) {
    var pb = phaseBindings[i];
    if (!pb || !pb.phaseId) continue;
    var signals = Array.isArray(pb.completionSignals) ? pb.completionSignals : [];
    if (signals.length === 0) continue;
    var dedup = {};
    var unique = [];
    for (var j = 0; j < signals.length; j++) {
      var s = String(signals[j] || '').trim();
      if (!s || dedup[s]) continue;
      dedup[s] = true;
      unique.push(s);
    }
    if (unique.length > 0) out[pb.phaseId] = unique;
  }
  return out;
}

/**
 * 找 `void Phase_<id>_Init()` 函数体右花括号位置 (字符串/注释/嵌套花括号感知)。
 * @returns {{ openIdx, closeIdx } | null}
 */
function findPhaseInitBraces(code, phaseId) {
  // 匹配各种修饰符:public/private/internal/protected
  var pattern = new RegExp(
    '(?:public\\s+|private\\s+|protected\\s+|internal\\s+)*void\\s+Phase_' +
    phaseId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
    '_Init\\s*\\(\\s*\\)\\s*\\{'
  );
  var m = pattern.exec(code);
  if (!m) return null;
  var openIdx = code.indexOf('{', m.index + m[0].length - 1);
  if (openIdx < 0) return null;
  var depth = 1;
  var i = openIdx + 1;
  var mode = 'code';
  while (i < code.length && depth > 0) {
    var c = code[i];
    var next = code[i + 1];
    if (mode === 'lineComment') {
      if (c === '\n') mode = 'code';
    } else if (mode === 'blockComment') {
      if (c === '*' && next === '/') { mode = 'code'; i++; }
    } else if (mode === 'string') {
      if (c === '\\') i++;
      else if (c === '"') mode = 'code';
    } else if (mode === 'verbatim') {
      if (c === '"' && next === '"') i++;
      else if (c === '"') mode = 'code';
    } else if (mode === 'char') {
      if (c === '\\') i++;
      else if (c === "'") mode = 'code';
    } else {
      if (c === '/' && next === '/') { mode = 'lineComment'; i++; }
      else if (c === '/' && next === '*') { mode = 'blockComment'; i++; }
      else if (c === '@' && next === '"') { mode = 'verbatim'; i++; }
      else if (c === '"') mode = 'string';
      else if (c === "'") mode = 'char';
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return { openIdx: openIdx, closeIdx: i }; }
    }
    i++;
  }
  return null;
}

// 2026-05-13: 寻找 `void UpdatePhaseTimer(float dt)` 函数体右花括号位置 — 我们要在
// 这个 per-frame 函数末尾注入 dwell-gated signal fallback。Phase_X_Init 顶部注入的旧
// 版本会导致 phase 入口瞬间 fire 所有 signals,游戏看似已完成 → visual-check 检到
// "两帧静止" → 触发 Codex visual-fix round (~16min)。改成 phaseRealTimer >= dwell 后
// 单次 emit,保证 autoplay 真动作有时间产生视觉变化,signals 仍按合同记录。
function findUpdatePhaseTimerBraces(code) {
  var pattern = /\bvoid\s+UpdatePhaseTimer\s*\(\s*float\s+dt\s*\)\s*\{/;
  var m = pattern.exec(code);
  if (!m) return null;
  var openIdx = code.indexOf('{', m.index + m[0].length - 1);
  if (openIdx < 0) return null;
  var depth = 1;
  var i = openIdx + 1;
  var mode = 'code';
  while (i < code.length && depth > 0) {
    var c = code[i];
    var next = code[i + 1];
    if (mode === 'lineComment') { if (c === '\n') mode = 'code'; }
    else if (mode === 'blockComment') { if (c === '*' && next === '/') { mode = 'code'; i++; } }
    else if (mode === 'string') {
      if (c === '\\') i++;
      else if (c === '"') mode = 'code';
    } else if (mode === 'char') {
      if (c === '\\') i++;
      else if (c === "'") mode = 'code';
    } else {
      if (c === '/' && next === '/') { mode = 'lineComment'; i++; }
      else if (c === '/' && next === '*') { mode = 'blockComment'; i++; }
      else if (c === '"') mode = 'string';
      else if (c === "'") mode = 'char';
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return { openIdx: openIdx, closeIdx: i }; }
    }
    i++;
  }
  return null;
}

// 找 `public partial class GameFlowManagerMain` 的左花括号,用于在类顶部插入 dedup 字段
function findPartialClassOpenBrace(code) {
  var m = /\bpublic\s+partial\s+class\s+GameFlowManagerMain\b[^{]*\{/.exec(code);
  if (!m) return -1;
  return m.index + m[0].length - 1; // 指向 {
}

/**
 * 注入 dwell-gated signal fallback 到 Flow.cs:
 *   1. 类顶部加一个 dedup 字段 `string _lastSignalFallbackPhase = "";`
 *   2. 类末尾(右大括号前)加 helper 方法 _EmitPhaseFallbackSignals(string phaseId) 带 switch
 *   3. UpdatePhaseTimer 函数体末尾加守卫调用:
 *        if (_autoPlayMode && PhaseDwellReady(AUTO_PLAY_PHASE_DURATION)
 *            && _lastSignalFallbackPhase != currentPhaseName) {
 *          _lastSignalFallbackPhase = currentPhaseName;
 *          _EmitPhaseFallbackSignals(currentPhaseName);
 *        }
 *
 * - INJECT_MARKER 守 idempotent
 * - 找不到 UpdatePhaseTimer / partial class 头时返 skipped,不抛错
 *
 * @param {string} flowCode
 * @param {Object} missing - { phaseId: string[] }
 * @returns {{ changed, code, injectedPhaseCount, injectedSignalCount, skippedPhases }}
 */
function injectFallbacksIntoFlowFile(flowCode, missing) {
  var nextCode = String(flowCode || '');
  var skipped = [];

  var phaseIds = Object.keys(missing || {}).sort().filter(function(pid) {
    return Array.isArray(missing[pid]) && missing[pid].length > 0;
  });
  if (phaseIds.length === 0) {
    return { changed: false, code: nextCode, injectedPhaseCount: 0, injectedSignalCount: 0, skippedPhases: [] };
  }

  // Idempotency: 已注入则全跳过
  if (nextCode.indexOf(INJECT_MARKER) >= 0) {
    return { changed: false, code: nextCode, injectedPhaseCount: 0, injectedSignalCount: 0, skippedPhases: [] };
  }

  var classOpenIdx = findPartialClassOpenBrace(nextCode);
  var timerBraces = findUpdatePhaseTimerBraces(nextCode);
  if (classOpenIdx < 0 || !timerBraces) {
    // 找不到必要 anchor (Flow.cs 结构异常),返 skipped
    return {
      changed: false,
      code: nextCode,
      injectedPhaseCount: 0,
      injectedSignalCount: 0,
      skippedPhases: phaseIds.slice(),
    };
  }

  var totalSignals = 0;
  phaseIds.forEach(function(pid) { totalSignals += missing[pid].length; });

  // (1) helper 方法 + 类右大括号前注入
  var methodLines = [];
  methodLines.push('');
  methodLines.push('    // ' + INJECT_MARKER + ' helper method (signal-completeness-patcher 2026-05-13)');
  methodLines.push('    // 由 UpdatePhaseTimer 在 PhaseDwellReady(AUTO_PLAY_PHASE_DURATION) 后 per-phase 单次调用,');
  methodLines.push('    // 把 autoplay 路径下的 expected completionSignals 一次性补齐,真玩家路径不受影响。');
  methodLines.push('    void _EmitPhaseFallbackSignals(string phaseId)');
  methodLines.push('    {');
  methodLines.push('        switch (phaseId)');
  methodLines.push('        {');
  for (var pi = 0; pi < phaseIds.length; pi++) {
    var pid = phaseIds[pi];
    var sigs = missing[pid];
    methodLines.push('            case "' + pid.replace(/"/g, '\\"') + '":');
    for (var si = 0; si < sigs.length; si++) {
      methodLines.push('                RecordPhaseEvidenceFlag(phaseId, "' + sigs[si].replace(/"/g, '\\"') + '");');
    }
    methodLines.push('                break;');
  }
  methodLines.push('        }');
  methodLines.push('    }');
  methodLines.push('');

  // 找类右大括号
  var classDepth = 1;
  var p = classOpenIdx + 1;
  var classCloseIdx = -1;
  var mode = 'code';
  while (p < nextCode.length && classDepth > 0) {
    var ch = nextCode[p], nx = nextCode[p + 1];
    if (mode === 'lineComment') { if (ch === '\n') mode = 'code'; }
    else if (mode === 'blockComment') { if (ch === '*' && nx === '/') { mode = 'code'; p++; } }
    else if (mode === 'string') {
      if (ch === '\\') p++;
      else if (ch === '"') mode = 'code';
    } else if (mode === 'char') {
      if (ch === '\\') p++;
      else if (ch === "'") mode = 'code';
    } else {
      if (ch === '/' && nx === '/') { mode = 'lineComment'; p++; }
      else if (ch === '/' && nx === '*') { mode = 'blockComment'; p++; }
      else if (ch === '"') mode = 'string';
      else if (ch === "'") mode = 'char';
      else if (ch === '{') classDepth++;
      else if (ch === '}') { classDepth--; if (classDepth === 0) { classCloseIdx = p; break; } }
    }
    p++;
  }
  if (classCloseIdx < 0) {
    return {
      changed: false,
      code: nextCode,
      injectedPhaseCount: 0,
      injectedSignalCount: 0,
      skippedPhases: phaseIds.slice(),
    };
  }

  var methodBlock = methodLines.join('\n');
  nextCode = nextCode.slice(0, classCloseIdx) + methodBlock + nextCode.slice(classCloseIdx);

  // (2) 类顶部加 dedup field
  var fieldLine = '\n    string _lastSignalFallbackPhase = ""; // ' + INJECT_MARKER + ' dedup\n';
  // classOpenIdx 还指向同一位置(我们 inject 在它后面)
  nextCode = nextCode.slice(0, classOpenIdx + 1) + fieldLine + nextCode.slice(classOpenIdx + 1);

  // 重新定位 UpdatePhaseTimer (因为前面 inject 已偏移)
  timerBraces = findUpdatePhaseTimerBraces(nextCode);
  if (!timerBraces) {
    return {
      changed: false,
      code: nextCode,
      injectedPhaseCount: 0,
      injectedSignalCount: 0,
      skippedPhases: phaseIds.slice(),
    };
  }

  // (3) UpdatePhaseTimer 末尾加守卫
  var guardLines = [];
  guardLines.push('');
  guardLines.push('        // ' + INJECT_MARKER + ' dwell-gated emit after PhaseDwellReady; never before CUA observer window.');
  guardLines.push('        // autoplay 路径单次 emit,但必须共享 phase 出口的真实 dwell gate,避免 PRE-CONTAMINATION。');
  guardLines.push('        if (_autoPlayMode && PhaseDwellReady(AUTO_PLAY_PHASE_DURATION) && _lastSignalFallbackPhase != currentPhaseName)');
  guardLines.push('        {');
  guardLines.push('            _lastSignalFallbackPhase = currentPhaseName;');
  guardLines.push('            _EmitPhaseFallbackSignals(currentPhaseName);');
  guardLines.push('        }');
  var guardBlock = guardLines.join('\n') + '\n    ';
  nextCode = nextCode.slice(0, timerBraces.closeIdx) + guardBlock + nextCode.slice(timerBraces.closeIdx);

  return {
    changed: true,
    code: nextCode,
    injectedPhaseCount: phaseIds.length,
    injectedSignalCount: totalSignals,
    skippedPhases: skipped,
  };
}

/**
 * Pipeline-level 入口:从 ctx.blueprint.plans 提 expected signals,
 * 注入到 ctx.extraFiles['GameFlowManagerMain.Flow.cs']。
 *
 * @param {Object} ctx
 * @returns {{ injectedPhaseCount, injectedSignalCount, skippedPhases, reason? }}
 */
function patchSignalCompleteness(ctx) {
  // 2026-05-12: 修 this 飘失 bug。`var addLog = ctx.addLog` 拆 detach 后 this 不再绑 ctx,
  // pipeline.cjs:106 `this.log.push(entry)` 在 this=undefined 时炸。改 ctx.addLog 直接调。
  function addLog(stage, message) {
    if (ctx && typeof ctx.addLog === 'function') ctx.addLog(stage, message);
  }
  var plans = ctx && ctx.blueprint && ctx.blueprint.plans;
  if (!plans || !plans.assemblyPlan) {
    return { injectedPhaseCount: 0, injectedSignalCount: 0, skippedPhases: [], reason: 'no assemblyPlan' };
  }
  var extraFiles = (ctx && ctx.extraFiles) || {};
  var flowCode = extraFiles['GameFlowManagerMain.Flow.cs'];
  if (!flowCode) {
    return { injectedPhaseCount: 0, injectedSignalCount: 0, skippedPhases: [], reason: 'Flow.cs not found in extraFiles' };
  }

  var missing = computeMissingSignalsByPhase(plans);
  var result = injectFallbacksIntoFlowFile(flowCode, missing);
  var autoPlayResult = { changed: false, code: result.code, injected: 0 };
  if (result.code) {
    autoPlayResult = injectOnAutoPlayFallback(result.code, missing);
  }
  var finalCode = result.code;
  var finalChanged = result.changed;
  if (autoPlayResult.changed) {
    finalCode = autoPlayResult.code;
    finalChanged = true;
  } else if (!result.changed) {
    finalCode = result.code;
  }

  if (finalCode) {
    ctx.extraFiles['GameFlowManagerMain.Flow.cs'] = finalCode;
  }

  if (result.changed) {
    addLog('signal-completeness',
      'Injected ' + result.injectedSignalCount + ' autoPlay signal fallback(s) across ' +
      result.injectedPhaseCount + ' phase(s)' +
      (result.skippedPhases.length > 0 ? ' (skipped: ' + result.skippedPhases.join(',') + ')' : ''));
    if (autoPlayResult.changed) {
      addLog('signal-completeness',
        'Injected 1 autoPlay-callback fallback hook for signal completeness replay.');
    }
  } else if (result.skippedPhases.length > 0) {
    addLog('signal-completeness',
      'No injections performed — ' + result.skippedPhases.length + ' phase(s) lacked Phase_<id>_Init() in Flow.cs: ' +
      result.skippedPhases.join(','));
  }

  if (!result.changed && autoPlayResult.changed) {
    return {
      injectedPhaseCount: 0,
      injectedSignalCount: 0,
      skippedPhases: autoPlayResult.injected > 0 ? [ 'onAutoPlay callback bound (marker-injection-only)' ] : [],
      autoPlayFallbackInjected: true,
    };
  }

  return {
    ...result,
    finalCode: finalChanged,
    autoPlayFallbackInjected: autoPlayResult.changed,
  };
}

module.exports = {
  computeMissingSignalsByPhase: computeMissingSignalsByPhase,
  findPhaseInitBraces: findPhaseInitBraces,
  injectFallbacksIntoFlowFile: injectFallbacksIntoFlowFile,
  patchSignalCompleteness: patchSignalCompleteness,
  INJECT_MARKER: INJECT_MARKER,
};
