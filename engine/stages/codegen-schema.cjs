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

    // Call LLM (Sonnet via Claude Code CLI text mode)
    var runClaudeCodeText = require('../../worker/claude-code-coder.js').runClaudeCodeText;
    return runClaudeCodeText({
      userPrompt: promptText,
      systemPrompt: '你是试玩广告游戏配置生成器。只输出 JSON 对象，不要 markdown 包裹，不要解释。',
      model: 'claude-sonnet-4-6',
      taskId: ctx.taskId,
      log: function(msg) { ctx.addLog('codegen-schema', msg); },
      effort: 'medium',
      timeoutMs: 120000,
      minOutputLen: 20,
    }).then(function(response) {
      if (!response.ok) {
        throw new Error('Schema generation failed: ' + (response.error || '').slice(0, 300));
      }

      // Token tracking not available from CLI text mode — set to 0
      ctx.blueprint.schemaTokensIn = 0;
      ctx.blueprint.schemaTokensOut = 0;

      // Extract JSON from response
      var text = response.text || '';
      var jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Schema generation returned no JSON object');
      }
      var schema;
      try { schema = JSON.parse(jsonMatch[0]); } catch(e) {
        throw new Error('Invalid JSON from schema generation: ' + e.message);
      }

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
  lines.push('根据分镜 specs 输出 JSON 配置。');
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
        model: 'claude-sonnet-4-6',
        taskId: ctx.taskId,
        log: function(msg) { ctx.addLog('codegen-schema', '[custom R' + round + '] ' + msg); },
        effort: 'medium',
        timeoutMs: 180000,
      }).then(function(response) {
        if (!response.ok) {
          throw new Error('Custom logic fill failed: ' + (response.error || '').slice(0, 200));
        }

        var text = response.text || '';
        // Extract code from response and apply to csCode
        var codeMatch = text.match(/```(?:csharp|cs)?\n([\s\S]*?)```/);
        if (codeMatch) {
          // Replace TODO_CUSTOM section in csCode
          var startM = '// TODO_CUSTOM_START';
          var endM = '// TODO_CUSTOM_END';
          var si = ctx.csCode.indexOf(startM);
          var ei = ctx.csCode.indexOf(endM);
          if (si !== -1 && ei !== -1) {
            ctx.csCode = ctx.csCode.substring(0, si + startM.length) + '\n' +
              codeMatch[1] + '\n        ' + ctx.csCode.substring(ei);
          }
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
