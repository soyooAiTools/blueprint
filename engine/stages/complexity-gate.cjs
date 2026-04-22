// Source: engine/stages/complexity-gate.cjs
/**
 * Stage: complexity-gate — Score spec complexity before codegen
 *
 * Scoring formula:
 *   (codePhases*10) + (controlModes*40) + (econLayers*20) + (statefulEntities*5) + (formSwitches*15)
 *
 * Thresholds:
 *   <=200  : safe   — pass through
 *   201-250: warn   — log warning, continue
 *   >250   : auto-simplify via LLM, fail if simplified score still >250
 *
 * Reads:  ctx.blueprint.specs, ctx.blueprint.entities
 * Writes: ctx.blueprint.specs (possibly simplified)
 */

var path = require('path');

// ============ Control Mode Detection ============

/**
 * Count distinct locomotion/control modes across all specs.
 * move_to / drag  → "walk/drag" mode
 * drive / steer   → "vehicle" mode (separate mode from walk)
 * click / build / upgrade / spend / collect / deliver are NOT control modes.
 * Minimum result: 1.
 *
 * @param {Array} specs
 * @returns {number}
 */
function countControlModes(specs) {
  var hasWalk = false;
  var hasVehicle = false;

  for (var i = 0; i < specs.length; i++) {
    var interactions = specs[i].requiredInteractions || [];
    for (var j = 0; j < interactions.length; j++) {
      var verb = String(interactions[j]).split(':')[0];
      if (verb === 'move_to' || verb === 'drag') {
        hasWalk = true;
      } else if (verb === 'drive' || verb === 'steer') {
        hasVehicle = true;
      }
    }
  }

  var modes = 0;
  if (hasWalk) modes++;
  if (hasVehicle) modes++;
  return Math.max(1, modes);
}

// ============ Economy Layer Detection ============

/**
 * Count resource conversion steps (econ layers).
 * If collect + deliver + spend are all present: layers = min(deliver_count, 4)
 * If just collect + spend (no deliver): 1 layer
 * Otherwise: 0 layers
 *
 * @param {Array} specs
 * @returns {number}
 */
function countEconLayers(specs) {
  var hasCollect = false;
  var hasDeliver = false;
  var hasSpend = false;
  var deliverCount = 0;

  for (var i = 0; i < specs.length; i++) {
    var interactions = specs[i].requiredInteractions || [];
    for (var j = 0; j < interactions.length; j++) {
      var verb = String(interactions[j]).split(':')[0];
      if (verb === 'collect') {
        hasCollect = true;
      } else if (verb === 'deliver') {
        hasDeliver = true;
        deliverCount++;
      } else if (verb === 'spend') {
        hasSpend = true;
      }
    }
  }

  if (hasCollect && hasDeliver && hasSpend) {
    return Math.min(deliverCount, 4);
  } else if (hasCollect && hasSpend) {
    return 1;
  }
  return 0;
}

// ============ Form Switch Detection ============

/**
 * Count specs where formSwitch is truthy.
 *
 * @param {Array} specs
 * @returns {number}
 */
function countFormSwitches(specs) {
  var count = 0;
  for (var i = 0; i < specs.length; i++) {
    if (specs[i].formSwitch) {
      count++;
    }
  }
  return count;
}

// ============ Stateful Entity Detection ============

/**
 * Count entities where terminalState > 0.
 *
 * @param {Array} entities
 * @returns {number}
 */
function countStatefulEntities(entities) {
  var count = 0;
  for (var i = 0; i < entities.length; i++) {
    if (entities[i].terminalState && entities[i].terminalState > 0) {
      count++;
    }
  }
  return count;
}

// ============ Score Computation ============

/**
 * Compute complexity score for a given specs + entities pair.
 *
 * @param {Array} specs
 * @param {Array} entities
 * @returns {{ total: number, breakdown: object }}
 */
function computeScore(specs, entities) {
  specs = specs || [];
  entities = entities || [];

  var codePhases = specs.length;
  var controlModes = countControlModes(specs);
  var econLayers = countEconLayers(specs);
  var statefulEntities = countStatefulEntities(entities);
  var formSwitches = countFormSwitches(specs);

  var total = (codePhases * 10) + (controlModes * 40) + (econLayers * 20) +
              (statefulEntities * 5) + (formSwitches * 15);

  return {
    total: total,
    breakdown: {
      codePhases: codePhases,
      controlModes: controlModes,
      econLayers: econLayers,
      statefulEntities: statefulEntities,
      formSwitches: formSwitches,
      phaseScore: codePhases * 10,
      controlScore: controlModes * 40,
      econScore: econLayers * 20,
      entityScore: statefulEntities * 5,
      formScore: formSwitches * 15
    }
  };
}

// ============ LLM Auto-Simplification ============

/**
 * Build Chinese-language simplification prompt for LLM.
 *
 * @param {Array} specs
 * @param {Array} entities
 * @param {object} scoreResult
 * @returns {string}
 */
function buildSimplifyPrompt(specs, entities, scoreResult) {
  var bd = scoreResult.breakdown;
  var lines = [];
  lines.push('你是试玩广告体验规格简化专家。');
  lines.push('');
  lines.push('当前规格复杂度评分: ' + scoreResult.total + ' (超出上限 250)，请对规格进行简化，使评分降至 250 以内。');
  lines.push('');
  lines.push('评分明细:');
  lines.push('- 阶段数: ' + bd.codePhases + ' × 10 = ' + bd.phaseScore);
  lines.push('- 操控模式数: ' + bd.controlModes + ' × 40 = ' + bd.controlScore);
  lines.push('- 经济层数: ' + bd.econLayers + ' × 20 = ' + bd.econScore);
  lines.push('- 有状态实体数: ' + bd.statefulEntities + ' × 5 = ' + bd.entityScore);
  lines.push('- 形态切换数: ' + bd.formSwitches + ' × 15 = ' + bd.formScore);
  lines.push('');
  lines.push('简化原则（按优先级排序）:');
  lines.push('1. 合并重复阶段（如多个"收集资源"阶段合为一个）');
  lines.push('2. 删除非关键形态切换（保留最重要的一个）');
  lines.push('3. 减少操控模式（优先保留 move_to/click，删减 drive/steer）');
  lines.push('4. 简化经济链（若有多个 deliver 步骤，合并为一个）');
  lines.push('5. 实体合并（把功能相近的实体合并）');
  lines.push('');
  lines.push('当前 specs (JSON):');
  lines.push(JSON.stringify(specs, null, 2));
  lines.push('');
  lines.push('当前 entities (JSON):');
  lines.push(JSON.stringify(entities, null, 2));
  lines.push('');
  lines.push('请输出简化后的 specs 和 entities，严格遵守以下格式，只输出 JSON，不要解释:');
  lines.push('```json');
  lines.push('{');
  lines.push('  "specs": [...],');
  lines.push('  "entities": [...]');
  lines.push('}');
  lines.push('```');
  return lines.join('\n');
}

/**
 * Parse LLM simplification response, extracting JSON from markdown code block or raw.
 * Handles truncated responses where the closing ``` fence may be absent.
 *
 * @param {string} text
 * @returns {{ specs: Array, entities: Array }}
 */
function parseSimplifyResponse(text) {
  var raw;
  // Try to extract from ```json ... ``` block (both opening and closing fences present)
  var match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) {
    raw = match[1];
  } else {
    // Fallback: strip ALL code fence markers (truncated response — closing fence missing)
    raw = text.replace(/```(?:json)?/g, '').trim();
    if (!raw) raw = text;
  }

  // Repair trailing commas (common LLM artifact)
  raw = raw.replace(/,\s*([}\]])/g, '$1');

  // Final safety: strip any leading non-JSON characters (LLM preamble text)
  raw = raw.replace(/^[^[{]*/, '');
  raw = extractFirstBalancedJsonObject(raw) || raw;

  var parsed;
  try {
    parsed = JSON.parse(raw.trim());
  } catch (err) {
    // Second pass: common truncated-output repair.
    var repaired = raw
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/[\u0000-\u001F]+/g, ' ')
      .trim();
    repaired = extractFirstBalancedJsonObject(repaired) || repaired;
    parsed = JSON.parse(repaired);
  }
  if (!Array.isArray(parsed.specs)) throw new Error('LLM response missing "specs" array');
  if (!Array.isArray(parsed.entities)) throw new Error('LLM response missing "entities" array');
  return parsed;
}

function extractFirstBalancedJsonObject(text) {
  text = String(text || '');
  var start = text.indexOf('{');
  if (start < 0) return null;
  var depth = 0;
  var inString = false;
  var escaped = false;
  for (var i = start; i < text.length; i++) {
    var ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Call LLM to simplify specs+entities, returning simplified versions.
 * Tries ctx.callLLM first, then ctx.blueprint._callLLM, then falls back to model-provider.
 *
 * @param {object} ctx
 * @param {Array} specs
 * @param {Array} entities
 * @param {object} scoreResult
 * @returns {Promise<{ specs: Array, entities: Array }>}
 */
function callLLMOnce(ctx, prompt) {
  if (ctx.callLLM) {
    return ctx.callLLM(prompt, { model: 'spec' }).then(function(result) {
      return parseSimplifyResponse(result.text || result);
    });
  }
  if (ctx.blueprint && ctx.blueprint._callLLM) {
    return ctx.blueprint._callLLM(prompt, { model: 'spec' }).then(function(result) {
      return parseSimplifyResponse(result.text || result);
    });
  }
  var modelProvider = require('../../lib/model-provider.cjs');
  var provider = modelProvider.createProvider('doubao', {});
  return provider.generateWithRetry(prompt, { maxTokens: 4000 }, 2).then(function(result) {
    return parseSimplifyResponse(result.text || '');
  });
}

var MAX_SIMPLIFY_ATTEMPTS = 3;

function callLLMSimplify(ctx, specs, entities, scoreResult) {
  var attempt = 0;
  var lastErr = null;

  function tryOnce() {
    attempt++;
    var prompt = buildSimplifyPrompt(specs, entities, scoreResult);
    if (attempt >= 2) {
      prompt += '\n\n⚠️ 重要：直接输出原始 JSON，不要用 ```json 包裹，不要加任何解释文字。只输出 { "specs": [...], "entities": [...] }';
    }
    if (attempt >= 3) {
      prompt += '\n\n强制简化策略：直接删除最后2个阶段，合并所有 formSwitch 阶段为1个。输出精简后的 JSON。';
    }
    ctx.addLog('complexity-gate', 'Simplification attempt ' + attempt + '/' + MAX_SIMPLIFY_ATTEMPTS);

    return callLLMOnce(ctx, prompt).catch(function(err) {
      lastErr = err;
      ctx.addLog('complexity-gate', 'Simplification attempt ' + attempt + ' failed: ' + err.message);
      if (attempt < MAX_SIMPLIFY_ATTEMPTS) return tryOnce();
      throw new Error('complexity-gate: all ' + MAX_SIMPLIFY_ATTEMPTS + ' simplification attempts failed. Last error: ' + lastErr.message);
    });
  }

  return tryOnce();
}

// ============ Stage Export ============

module.exports = {
  name: 'complexity-gate',
  canRetry: true,

  canSkip: function(ctx) {
    return !ctx.blueprint.specs || ctx.blueprint.specs.length === 0;
  },

  execute: function(ctx) {
    var specs = ctx.blueprint.specs || [];
    var entities = ctx.blueprint.entities || [];

    ctx.addLog('complexity-gate', 'Computing spec complexity score...');

    var result = computeScore(specs, entities);
    var score = result.total;
    var bd = result.breakdown;

    ctx.addLog('complexity-gate',
      'Score: ' + score +
      ' (phases=' + bd.codePhases +
      ' controlModes=' + bd.controlModes +
      ' econLayers=' + bd.econLayers +
      ' statefulEntities=' + bd.statefulEntities +
      ' formSwitches=' + bd.formSwitches + ')'
    );

    // <=200: safe, pass through
    if (score <= 200) {
      ctx.addLog('complexity-gate', 'Score ' + score + ' <=200: SAFE — proceeding to codegen');
      if (ctx.reportStatus) {
        ctx.reportStatus('processing', { message: '[complexity-gate] Score ' + score + ' safe' });
      }
      return Promise.resolve();
    }

    // 201-250: warn, continue
    if (score <= 250) {
      ctx.addLog('complexity-gate', 'WARN: Score ' + score + ' is 201-250 — complex but within auto-simplify threshold. Proceeding with caution.');
      if (ctx.reportStatus) {
        ctx.reportStatus('processing', { message: '[complexity-gate] Score ' + score + ' warn — complex but proceeding' });
      }
      return Promise.resolve();
    }

    // >250: auto-simplify
    ctx.addLog('complexity-gate', 'Score ' + score + ' >250 — triggering LLM auto-simplification');
    if (ctx.reportStatus) {
      ctx.reportStatus('processing', { message: '[complexity-gate] Score ' + score + ' >250, auto-simplifying...' });
    }

    return callLLMSimplify(ctx, specs, entities, result).then(function(simplified) {
      ctx.addLog('complexity-gate', 'LLM returned simplified specs (' + simplified.specs.length + ' phases) and entities (' + simplified.entities.length + ')');

      var newResult = computeScore(simplified.specs, simplified.entities);
      var newScore = newResult.total;
      ctx.addLog('complexity-gate', 'Re-score after simplification: ' + newScore);

      if (newScore > 250) {
        throw new Error(
          'complexity-gate: LLM simplification did not reduce score to <=250 (got ' + newScore + '). ' +
          'Please manually reduce phase count, form switches, or control modes.'
        );
      }

      // Apply simplified specs and entities
      ctx.blueprint.specs = simplified.specs;
      ctx.blueprint.entities = simplified.entities;

      ctx.addLog('complexity-gate', 'Auto-simplification succeeded: score ' + score + ' → ' + newScore);
      if (ctx.reportStatus) {
        ctx.reportStatus('processing', { message: '[complexity-gate] Simplified: ' + score + ' → ' + newScore });
      }
    });
  },

  // Exported for unit testing
  computeScore: computeScore,
  countControlModes: countControlModes,
  countEconLayers: countEconLayers,
  countFormSwitches: countFormSwitches,
  countStatefulEntities: countStatefulEntities,
  parseSimplifyResponse: parseSimplifyResponse
};
