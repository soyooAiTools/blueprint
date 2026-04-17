/**
 * Schema-driven codegen stage.
 * Step 1: Claude Sonnet -> JSON game schema
 * Step 2: Template engine -> fill skeleton TODOs (80%)
 * Step 3: Claude Code -> fill customLogic TODOs (20%, optional)
 */

var fs = require('fs');
var path = require('path');
var { generateSkeleton } = require('../../adapters/skeleton-generator.cjs');
var { resolveEntities } = require('../../adapters/entity-resolver.cjs');
var templateEngine = require('../../adapters/codegen-template-engine.cjs');
var schemaValidator = require('../../adapters/schema/validate-schema.cjs');

module.exports = {
  name: 'codegen',
  canRetry: true,

  execute: function(ctx) {
    ctx.addLog('codegen-schema', 'Starting schema-driven codegen...');

    // Step 1: Generate JSON schema via Sonnet
    return generateSchemaFromSpecs(ctx)
      .then(function(schema) {
        ctx.blueprint.gameSchema = schema;
        ctx.addLog('codegen-schema', 'Schema generated: ' + schema.phases.length + ' phases, ' +
          schema.entities.length + ' entities, ' + (schema.npcs || []).length + ' NPCs');

        // Step 2: Template fill
        var startMs = Date.now();
        var resolved = resolveEntities(ctx.blueprint.specs, ctx.blueprint.entities);
        var skeletonResult = generateSkeleton(ctx.blueprint.specs, {
          entityPoolMap: resolved.entityPoolMap,
        });
        var skeletonStr = typeof skeletonResult === 'string' ? skeletonResult : skeletonResult.main;

        var fillResult = templateEngine.fillSkeleton(schema, skeletonStr);
        ctx.csCode = fillResult.code;
        ctx.blueprint.templateCoverage = fillResult.templateCoverage;
        ctx.blueprint.todoSectionsRemaining = fillResult.todoCount;
        ctx.blueprint.templateFillMs = Date.now() - startMs;

        ctx.addLog('codegen-schema', 'Template fill done: coverage=' +
          fillResult.templateCoverage.toFixed(2) + ', remaining TODOs=' + fillResult.todoCount +
          ', took ' + ctx.blueprint.templateFillMs + 'ms');

        // Handle split mode — fill Systems file TODOs too
        if (typeof skeletonResult === 'object' && skeletonResult.systems) {
          var systemsFill = templateEngine.fillSkeleton(schema, skeletonResult.systems);
          ctx.extraFiles = ctx.extraFiles || {};
          ctx.extraFiles['GameFlowManagerMain.Systems.cs'] = systemsFill.code;
        }

        // Step 3: Custom logic fill (only if needed)
        if (schema.customLogic && schema.customLogic.length > 0) {
          ctx.addLog('codegen-schema', 'Custom logic detected (' + schema.customLogic.length +
            ' items), invoking Claude Code...');
          return fillCustomLogic(ctx, schema);
        }

        ctx.addLog('codegen-schema', 'No custom logic — skipping Claude Code entirely');
      });
  }
};

function generateSchemaFromSpecs(ctx) {
  var maxRetries = 2;
  var attempt = 0;

  function tryGenerate() {
    attempt++;
    ctx.addLog('codegen-schema', 'Schema generation attempt ' + attempt + '/' + (maxRetries + 1));

    // Build prompt for Sonnet
    var promptText = buildSchemaPrompt(ctx);

    // Call LLM (Haiku via Claude Code CLI text mode)
    // Haiku is used because Sonnet consistently hangs (0 bytes output, >300s timeout)
    // on schema prompts >3K chars with Chinese game spec content. Haiku generates
    // correct schema JSON in <60s for the same 22K-char prompts.
    var runClaudeCodeText = require('../../worker/claude-code-coder.js').runClaudeCodeText;
    return runClaudeCodeText({
      userPrompt: promptText,
      systemPrompt: '你是试玩广告游戏配置生成器。只输出 JSON 对象，不要 markdown 包裹，不要解释。',
      model: 'claude-haiku-4-5-20251001',
      taskId: ctx.taskId,
      log: function(msg) { ctx.addLog('codegen-schema', msg); },
      effort: 'low',
      timeoutMs: 300000,
      noTools: true,
      minOutputLen: 20,
    }).then(function(response) {
      if (!response.ok) {
        throw new Error('Schema generation failed: ' + (response.error || '').slice(0, 300));
      }

      // Token tracking not available from CLI text mode — set to 0
      ctx.blueprint.schemaTokensIn = 0;
      ctx.blueprint.schemaTokensOut = 0;

      // Extract JSON from response (object or array)
      var text = response.text || '';
      // Strip markdown fences
      text = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '');
      var schema;
      try {
        var parsed = JSON.parse(text.trim());
        if (Array.isArray(parsed)) {
          schema = { gameConfig: { gameName: ctx.blueprint.projectName || 'game', maxPlayers: 1, gravity: -9.8 }, entities: (ctx.blueprint.entities || []).map(function(e) { return { name: e.name || e.poolName, pool: e.poolName || '', initPos: [0, 1, 0], scale: 1.0 }; }), resources: [], phases: parsed, npcs: [], customLogic: [] };
          ctx.addLog('codegen-schema', 'LLM returned phases array — auto-wrapped into full schema');
        } else {
          schema = parsed;
        }
      } catch(e1) {
        var jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          throw new Error('Schema generation returned no JSON object');
        }
        try { schema = JSON.parse(jsonMatch[0]); } catch(e2) {
          throw new Error('Invalid JSON from schema generation: ' + e2.message);
        }
      }

      // Auto-repair common LLM output issues before validation
      _repairSchema(schema);

      // Validate
      var structErrors = schemaValidator.validateGameSchema(schema);
      var semErrors = schemaValidator.validateSemantics(schema);
      var allErrors = structErrors.concat(semErrors);
      if (allErrors.length > 0) {
        throw new Error('Schema validation failed: ' + allErrors.join('; '));
      }

      return schema;
    }).catch(function(err) {
      if (attempt <= maxRetries) {
        ctx.addLog('codegen-schema', 'Retry (' + attempt + '): ' + err.message);
        return tryGenerate();
      }
      throw err;
    });
  }

  return tryGenerate();
}

function buildSchemaPrompt(ctx) {
  var specs = JSON.stringify(ctx.blueprint.specs, null, 2);
  var entities = JSON.stringify(ctx.blueprint.entities || [], null, 2);

  var lines = [];
  lines.push('根据分镜 specs 输出完整 JSON 配置对象。严格遵守以下字段定义,不添加额外字段:');
  lines.push('');
  lines.push('gameConfig (必填): { "cameraBackground": [r,g,b], "groundColor": [r,g,b], "moveSpeed": 5.0, "collectRange": 2.0, "maxCarry": 10 }');
  lines.push('entities[]: { "name": "实体名", "pool": "__Pool_Shape_Color_NN", "initPos": [x,y,z], "scale": 1.0 } — 只有这4个字段,不加其他');
  lines.push('resources[]: { "name": "资源名", "entity": "关联实体名", "convertRatio": 1 }');
  lines.push('phases[]: { "phaseId": "阶段ID", "showEntities": ["实体名"], "hideEntities": [], "guideText": "引导文字", "trigger": {...}, "onEnter": [{...}] }');
  lines.push('phases[].onEnter[].action 只能是: "set_entity_state" | "add_resource" | "switch_form" | "show_floating_text" | "set_guide" | "spawn_enemies"');
  lines.push('trigger.state 必须是整数(不是字符串)');
  lines.push('npcs[]: { "entity": "实体名", "template": "patrol|chase_attack|...", "params": {...} }');
  lines.push('customLogic[]: 字符串数组,每项是自然语言描述,越少越好');
  lines.push('');
  lines.push('## NPC 行为模板');
  lines.push('- patrol: patrolRadius(float), moveSpeed(float)');
  lines.push('- chase_attack: detectRange, attackRange, attackDamage, attackInterval, moveSpeed, hp');
  lines.push('- static_target: hp, interactionVerb');
  lines.push('- ranged_shooter: detectRange, fireRange, projectileSpeed, damage, fireInterval, hp');
  lines.push('- spawner: spawnEntity, spawnInterval, maxAlive, spawnRadius');
  lines.push('');
  lines.push('## Trigger 类型');
  lines.push('- resource_collected: {resource, amount}');
  lines.push('- entity_state_reached: {entity, state}');
  lines.push('- near_entity: {entity, range}');
  lines.push('- click_entity: {entity}');
  lines.push('- all_built: {}');
  lines.push('- enemy_defeated: {count}');
  lines.push('- timer: {seconds} — 必须与其他 trigger 组合(compound)');
  lines.push('- compound: {triggers[], operator: "and"|"or"}');
  lines.push('');
  lines.push('## 规则');
  lines.push('1. entities 中每个 name 必须在 specs 的 entitiesRequired 中存在');
  lines.push('2. phase 数量必须与 specs 数量一致');
  lines.push('3. 第一个 phase 的 showEntities >= 3 个');
  lines.push('4. 最后一个 phase 的 trigger 必须包含 click_entity');
  lines.push('5. customLogic 只写模板无法覆盖的逻辑，越少越好');
  lines.push('6. timer 不能单独做 trigger');
  lines.push('7. pool 格式: __Pool_{Shape}_{Color}_{NN}');
  lines.push('8. entities[].initPos: [x,y,z], x范围±6, z范围±4, y>0');
  lines.push('9. entities[].scale >= 0.3');
  lines.push('');
  // 2026-04-17: Visual change rules — CUA rejects "visual freeze" when phases
  // transition without observable screen changes. Each phase must produce
  // visible object movement/appearance/disappearance so CUA screenshots differ.
  lines.push('## 视觉变化规则（CUA 验证必须）');
  lines.push('10. 每个 phase 必须有至少 2 个 showEntities 或 hideEntities，确保 phase 切换时画面有明显变化');
  lines.push('11. 相邻 phase 的 showEntities 不能完全相同——必须有新出现或消失的实体');
  lines.push('12. 每个 phase 必须有 guideText（中文引导文字），且相邻 phase 的 guideText 不同');
  lines.push('13. showEntities 的 initPos 在不同 phase 间至少相差 2 个单位（避免物体位置不动导致截图无变化）');
  lines.push('14. 每个 phase 至少一个 onEnter action（如 add_resource, set_entity_state），让游戏状态随 phase 推进而变化');
  lines.push('15. 禁止所有 phase 只用 timer trigger——至少 50% 的 phase 必须用 entity_state_reached 或 resource_collected trigger');
  lines.push('');
  lines.push('## 分镜 Specs');
  lines.push(specs);
  lines.push('');
  lines.push('## 实体列表');
  lines.push(entities);
  lines.push('');
  lines.push('只输出 JSON 对象，不要 markdown 包裹，不要解释。');
  return lines.join('\n');
}

function fillCustomLogic(ctx, schema) {
  var { createFixLoop } = require('../fix-loop.cjs');
  var { runClaudeCodeText } = require('../../worker/claude-code-coder.js');

  ctx.blueprint.customLogicRounds = 0;
  ctx.blueprint.customLogicTokensIn = 0;

  var loop = createFixLoop({
    name: 'codegen-custom',
    maxRounds: 3,
    attempt: function(loopCtx, round) {
      ctx.blueprint.customLogicRounds = round;
      var promptText = buildCustomLogicPrompt(ctx, schema);
      return runClaudeCodeText({
        userPrompt: promptText,
        systemPrompt: '你是 Unity C# 代码填充器。只修改 TODO_CUSTOM 区域。',
        model: 'opus',
        taskId: ctx.taskId,
        log: function(msg) { ctx.addLog('codegen-schema', '[custom R' + round + '] ' + msg); },
        effort: 'medium',
        timeoutMs: 300000,
      }).then(function(response) {
        if (!response.ok) {
          throw new Error('Custom logic fill failed: ' + (response.error || '').slice(0, 200));
        }

        var text = response.text || '';
        var codeMatch = text.match(/```(?:csharp|cs)?\n([\s\S]*?)```/);
        if (!codeMatch) {
          throw new Error('Custom logic fill returned no ```csharp code block (response: ' + text.slice(0, 100) + '...)');
        }
        var startM = '// TODO_CUSTOM_START';
        var endM = '// TODO_CUSTOM_END';
        var si = ctx.csCode.indexOf(startM);
        var ei = ctx.csCode.indexOf(endM);
        if (si !== -1 && ei !== -1) {
          ctx.csCode = ctx.csCode.substring(0, si + startM.length) + '\n' +
            codeMatch[1] + '\n        ' + ctx.csCode.substring(ei);
        }

        return { done: true };
      });
    }
  });

  return loop.run(ctx);
}

function buildCustomLogicPrompt(ctx, schema) {
  var lines = [];
  lines.push('以下 C# 代码已由模板引擎生成 80%。你只需要实现 TODO_CUSTOM 标记的区域。');
  lines.push('');
  lines.push('## 规则');
  lines.push('1. 只修改 TODO_CUSTOM_START 和 TODO_CUSTOM_END 之间的代码');
  lines.push('2. 不要修改 [SKELETON] 标记的代码');
  lines.push('3. 不要修改模板已生成的代码');
  lines.push('4. 可用 API: PlaceObj, HideObj, SetScale, AddResource, TrySpend, IsNear 等');
  lines.push('5. 实体变量名使用 PascalCase（与 skeleton 声明一致，如 Forge 不是 forge）');
  lines.push('');
  lines.push('## 需要实现的自定义逻辑');
  for (var i = 0; i < schema.customLogic.length; i++) {
    lines.push((i + 1) + '. ' + schema.customLogic[i]);
  }
  lines.push('');
  lines.push('## 当前代码');
  lines.push('```csharp');
  lines.push(ctx.csCode);
  lines.push('```');
  return lines.join('\n');
}

var ALLOWED_ENTITY_KEYS = { name: 1, pool: 1, initPos: 1, scale: 1, showInPhase: 1, terminalState: 1 };
var ALLOWED_ACTION_KEYS = { action: 1, entity: 1, state: 1, resource: 1, amount: 1, formIndex: 1, text: 1, color: 1, count: 1 };
var ALLOWED_ACTIONS = ['set_entity_state', 'add_resource', 'switch_form', 'show_floating_text', 'set_guide', 'spawn_enemies'];

function _repairSchema(schema) {
  if (!schema || typeof schema !== 'object') return;

  // Fix gameConfig defaults
  if (!schema.gameConfig) schema.gameConfig = {};
  var gc = schema.gameConfig;
  if (!gc.cameraBackground) gc.cameraBackground = [0.5, 0.7, 1.0];
  if (!gc.groundColor) gc.groundColor = [0.3, 0.6, 0.2];
  if (gc.moveSpeed == null) gc.moveSpeed = 5.0;
  if (gc.collectRange == null) gc.collectRange = 2.0;
  if (gc.maxCarry == null) gc.maxCarry = 10;
  Object.keys(gc).forEach(function(k) {
    if (!{ cameraBackground: 1, groundColor: 1, moveSpeed: 1, collectRange: 1, maxCarry: 1 }[k]) delete gc[k];
  });

  // Fix entities: strip extra props, pad pool digits, prevent pool collisions.
  // Two-pass: (1) validate & register valid pools, (2) assign unique fallbacks.
  var _FALLBACK_POOLS = [
    '__Pool_Cube_White_01', '__Pool_Cube_Red_02', '__Pool_Sphere_Blue_03',
    '__Pool_Cube_Green_04', '__Pool_Cube_Yellow_05', '__Pool_Sphere_White_06',
    '__Pool_Cube_Brown_07', '__Pool_Capsule_Red_08', '__Pool_Cylinder_Blue_09',
    '__Pool_Cube_White_10', '__Pool_Sphere_Green_11', '__Pool_Cube_Red_12',
    '__Pool_Capsule_Yellow_13', '__Pool_Cylinder_White_14', '__Pool_Cube_Blue_15',
  ];
  var _usedPools = {};
  // Pass 1: validate format, register valid unique pools
  (schema.entities || []).forEach(function(e) {
    Object.keys(e).forEach(function(k) { if (!ALLOWED_ENTITY_KEYS[k]) delete e[k]; });
    if (e.pool && !/\d{2}$/.test(e.pool)) {
      e.pool = e.pool.replace(/_(\d)$/, '_0$1');
    }
    if (e.pool && !/^__Pool_[A-Z][a-z]+_[A-Z][a-z]+_\d{2}$/.test(e.pool)) {
      e.pool = null;
    }
    if (e.pool && !_usedPools[e.pool]) {
      _usedPools[e.pool] = true;
    } else if (e.pool) {
      e.pool = null; // duplicate — clear for pass 2
    }
  });
  // Pass 2: assign unique fallback pools for invalid/duplicate entries
  var _fallbackIdx = 0;
  (schema.entities || []).forEach(function(e) {
    if (e.pool) return; // already valid + unique
    for (; _fallbackIdx < _FALLBACK_POOLS.length; _fallbackIdx++) {
      if (!_usedPools[_FALLBACK_POOLS[_fallbackIdx]]) {
        e.pool = _FALLBACK_POOLS[_fallbackIdx];
        _usedPools[e.pool] = true;
        _fallbackIdx++;
        return;
      }
    }
    e.pool = '__Pool_Cube_White_' + String(_fallbackIdx + 16).slice(-2);
    _usedPools[e.pool] = true;
    _fallbackIdx++;
  });

  // Fix resources: ensure required fields
  (schema.resources || []).forEach(function(r) {
    if (!r.entity) r.entity = (schema.entities && schema.entities[0]) ? schema.entities[0].name : 'Unknown';
    if (r.convertRatio == null) r.convertRatio = 1;
    Object.keys(r).forEach(function(k) {
      if (!{ name: 1, entity: 1, convertRatio: 1, maxStock: 1 }[k]) delete r[k];
    });
  });

  // Fix phases: strip extra props from onEnter, normalize action names
  (schema.phases || []).forEach(function(p) {
    (p.onEnter || []).forEach(function(a) {
      if (!a.action && a.type) { a.action = a.type; delete a.type; }
      if (a.action && ALLOWED_ACTIONS.indexOf(a.action) === -1) {
        a.action = 'set_entity_state';
      }
      Object.keys(a).forEach(function(k) { if (!ALLOWED_ACTION_KEYS[k]) delete a[k]; });
    });
    (p.onComplete || []).forEach(function(a) {
      if (!a.action && a.type) { a.action = a.type; delete a.type; }
      Object.keys(a).forEach(function(k) { if (!ALLOWED_ACTION_KEYS[k]) delete a[k]; });
    });
  });

  // Fix triggers: state must be integer
  function fixTrigger(t) {
    if (!t) return;
    if (t.state != null && typeof t.state !== 'number') t.state = parseInt(t.state, 10) || 0;
    if (Array.isArray(t.triggers)) t.triggers.forEach(fixTrigger);
  }
  (schema.phases || []).forEach(function(p) { fixTrigger(p.trigger); });

  // Fix customLogic: ensure array of strings
  if (schema.customLogic) {
    schema.customLogic = schema.customLogic.filter(function(x) { return typeof x === 'string'; });
  }
}