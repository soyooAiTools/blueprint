/**
 * Schema-driven codegen stage.
 * Step 1: Claude Sonnet -> JSON game schema
 * Step 2: Template engine -> fill skeleton TODOs (80%)
 * Step 3: Codex text runner -> fill customLogic TODOs (20%, optional)
 */

var fs = require('fs');
var os = require('os');
var path = require('path');
var { generateSkeleton } = require('../../adapters/skeleton-generator.cjs');
var { resolveEntities } = require('../../adapters/entity-resolver.cjs');
var assemblyEmitter = require('../../adapters/assembly-emitter.cjs');
var templateEngine = require('../../adapters/codegen-template-engine.cjs');
var schemaValidator = require('../../adapters/schema/validate-schema.cjs');

module.exports = {
  name: 'codegen',
  canRetry: true,

  execute: function(ctx) {
    ctx.addLog('codegen-schema', 'Starting schema-driven codegen...');
    if (ctx.blueprint && ctx.blueprint.plans && ctx.blueprint.plans.assemblyPlan) {
      var moduleCount = (ctx.blueprint.plans.assemblyPlan.moduleInstances || []).length;
      var cuaSteps = (ctx.blueprint.plans.cuaPlan && ctx.blueprint.plans.cuaPlan.steps || []).length;
      ctx.addLog('codegen-schema', 'Assembly plan detected: ' + moduleCount + ' module instances, ' + cuaSteps + ' CUA steps');
    }

    // Step 1: Generate JSON schema via Sonnet
    return generateSchemaFromSpecs(ctx)
      .then(function(schema) {
        ctx.blueprint.gameSchema = schema;
        ctx.addLog('codegen-schema', 'Schema generated: ' + schema.phases.length + ' phases, ' +
          schema.entities.length + ' entities, ' + (schema.npcs || []).length + ' NPCs');

        // Step 2: Template fill
        var startMs = Date.now();
        // Guard: only call resolveEntities when specs exist (mirrors codegen-legacy.cjs:43)
        var resolved = (ctx.blueprint.specs && ctx.blueprint.specs.length > 0)
          ? resolveEntities(ctx.blueprint.specs, ctx.blueprint.entities)
          : { entityPoolMap: {}, resolvedSpecs: [], allEntities: {}, poolManifest: null };
        ctx.blueprint.poolManifest = resolved.poolManifest;
        var skeletonResult = generateSkeleton(ctx.blueprint.specs, {
          entityPoolMap: resolved.entityPoolMap,
          entities: schema.entities, // carries chineseName / showLabel for world labels
          w1bSplit: ctx.blueprint.w1bSplit !== false, // default-on: 5-partial skeleton split
        });
        var isW1bSplit = (typeof skeletonResult === 'object' && skeletonResult.mode === 'w1b-5partial');
        if (isW1bSplit && ctx.blueprint && ctx.blueprint.plans && ctx.blueprint.plans.assemblyPlan) {
          var emitted = assemblyEmitter.applyAssemblyPlanToSkeleton(skeletonResult, ctx.blueprint.plans);
          skeletonResult = emitted.files;
          ctx.blueprint.assemblySlotCount = emitted.slotCount;
          ctx.blueprint.assemblyOwnerSummary = emitted.ownerSummary;
          ctx.addLog('codegen-schema', 'Deterministic assembly scaffold emitted: ' + emitted.slotCount + ' owner slot(s)');
        }
        var skeletonStr = typeof skeletonResult === 'string' ? skeletonResult : skeletonResult.main;

        var fillResult = templateEngine.fillSkeleton(schema, skeletonStr, { w1bSplit: isW1bSplit });
        var combinedMissingMarkers = (fillResult.missingMarkers || []).slice();
        var flowFillResult = null;
        if (isW1bSplit && skeletonResult.flow) {
          // W1b split keeps phase-init TODO markers in Flow.cs, so fill that
          // companion before enforcing marker coverage.
          flowFillResult = templateEngine.fillSkeleton(schema, skeletonResult.flow, { w1bSplit: true });
          combinedMissingMarkers = combinedMissingMarkers
            .filter(function(marker) { return !/^TODO_PHASE_\d+_INIT$/.test(marker); })
            .concat(flowFillResult.missingMarkers || []);
        }
        if (combinedMissingMarkers.length > 0) {
          throw new Error('Template marker coverage failed: missing skeleton markers: ' + combinedMissingMarkers.join(', '));
        }
        ctx.csCode = fillResult.code;
        ctx.blueprint.templateCoverage = fillResult.templateCoverage;
        ctx.blueprint.todoSectionsRemaining = fillResult.todoCount + (flowFillResult ? flowFillResult.todoCount : 0);
        ctx.blueprint.templateFillMs = Date.now() - startMs;

        ctx.addLog('codegen-schema', 'Template fill done: coverage=' +
          fillResult.templateCoverage.toFixed(2) + ', remaining TODOs=' + fillResult.todoCount +
          ', took ' + ctx.blueprint.templateFillMs + 'ms');

        // W1b 5-partial split — write Flow/Input/Resource/UI/Scene companions.
        // TODO_PHASE_<id>_ONTAP filling inside Flow is deferred to W1b-2b; for now
        // the stubs ship with default <id>InteractionDone/<id>PlayerActed assignments
        // which keep the code compilable and anti-autoplay-safe.
        if (typeof skeletonResult === 'object' && skeletonResult.mode === 'w1b-5partial') {
          ctx.extraFiles = ctx.extraFiles || {};
          ctx.extraFiles['GameFlowManagerMain.Flow.cs'] = flowFillResult ? flowFillResult.code : skeletonResult.flow;
          ctx.extraFiles['GameFlowManagerMain.Input.cs'] = skeletonResult.input;
          ctx.extraFiles['GameFlowManagerMain.Resource.cs'] = skeletonResult.resource;
          ctx.extraFiles['GameFlowManagerMain.UI.cs'] = skeletonResult.ui;
          ctx.extraFiles['GameFlowManagerMain.Scene.cs'] = skeletonResult.scene;
          ctx.addLog('codegen-schema', 'W1b 5-partial: wrote 5 companion files to extraFiles');
        }
        // Legacy split mode — fill Systems file TODOs too
        else if (typeof skeletonResult === 'object' && skeletonResult.systems) {
          var systemsFill = templateEngine.fillSkeleton(schema, skeletonResult.systems);
          if (systemsFill.missingMarkers && systemsFill.missingMarkers.length > 0) {
            throw new Error('Template marker coverage failed: missing systems skeleton markers: ' + systemsFill.missingMarkers.join(', '));
          }
          ctx.extraFiles = ctx.extraFiles || {};
          ctx.extraFiles['GameFlowManagerMain.Systems.cs'] = systemsFill.code;
        }

        // Step 3: Custom logic fill (only if needed)
        if (schema.customLogic && schema.customLogic.length > 0) {
          ctx.addLog('codegen-schema', 'Custom logic detected (' + schema.customLogic.length +
            ' items), invoking Codex text runner...');
          return fillCustomLogic(ctx, schema);
        }

        ctx.addLog('codegen-schema', 'No custom logic — skipping text runner entirely');
      });
  },
  _internals: {
    buildSchemaPrompt: buildSchemaPrompt,
    summarizePlansForPrompt: summarizePlansForPrompt,
    isSchemaInfraError: isSchemaInfraError,
  }
};

function generateSchemaFromSpecs(ctx) {
  var maxRetries = 2;
  var attempt = 0;
  var runCodexText = require('../../worker/codex-coder.js').runCodexText;

  function tryGenerate() {
    attempt++;
    ctx.addLog('codegen-schema', 'Schema generation attempt ' + attempt + '/' + (maxRetries + 1));

    // Build prompt for Sonnet
    var promptText = buildSchemaPrompt(ctx);

    return generateSchemaTextWithFallback(runCodexText, ctx, promptText).then(function(response) {
      if (!response.ok) {
        throw new Error('Schema generation failed: ' + (response.error || '').slice(0, 300));
      }
      return parseAndValidateSchemaResponse(ctx, response.text || '');
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

function generateSchemaTextWithFallback(runCodexText, ctx, promptText) {
  var primarySystemPrompt = '你是试玩广告游戏配置生成器。只输出 JSON 对象，不要 markdown 包裹，不要解释。';
  return runCodexText({
    userPrompt: promptText,
    systemPrompt: primarySystemPrompt,
    backend: 'codex-exec',
    model: 'gpt-5.4-mini',
    taskId: ctx.taskId,
    log: function(msg) { ctx.addLog('codegen-schema', msg); },
    effort: 'low',
    timeoutMs: 180000,
    noTools: true,
    minOutputLen: 20,
  }).then(function(response) {
    if (response.ok || !isSchemaInfraError(response.error)) return response;
    ctx.addLog('codegen-schema', 'Primary schema backend infra failure — falling back to claude-print');
    return runCodexText({
      userPrompt: promptText,
      systemPrompt: primarySystemPrompt,
      model: 'claude-haiku-4-5-20251001',
      taskId: ctx.taskId,
      log: function(msg) { ctx.addLog('codegen-schema', '[fallback] ' + msg); },
      effort: 'low',
      timeoutMs: 300000,
      noTools: true,
      minOutputLen: 20,
      allowBackendFallback: false,
    }).then(function(fallbackResponse) {
      if (fallbackResponse.ok) ctx.addLog('codegen-schema', 'Schema backend fallback succeeded via claude-print');
      return fallbackResponse;
    });
  });
}

function isSchemaInfraError(error) {
  var text = String(error || '');
  return /ECONNRESET|Request timed out|Unable to connect to API|timed out|socket hang up|ENOTFOUND|EHOSTUNREACH|ECONNREFUSED|Connection error/i.test(text);
}

function parseAndValidateSchemaResponse(ctx, text) {
  // Token tracking not available from CLI text mode — set to 0
  ctx.blueprint.schemaTokensIn = 0;
  ctx.blueprint.schemaTokensOut = 0;

  // Extract JSON from response (object or array)
  text = String(text || '').replace(/```(?:json)?/g, '').trim();
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

  _repairSchema(schema, ctx.blueprint.entities);

  if (Array.isArray(schema.entities)) {
    for (var _ei = 0; _ei < schema.entities.length; _ei++) {
      var _e = schema.entities[_ei];
      if (!_e || typeof _e !== 'object') continue;
      if (!_e.chineseName || typeof _e.chineseName !== 'string' || _e.chineseName.length === 0) {
        ctx.addLog('codegen-schema', 'WARN: entity[' + _ei + '] chineseName 仍为空 after repair, 强制补' + (_e.name || 'entity') + ' — 检查 _repairSchema/ALLOWED_ENTITY_KEYS 是否回归');
        _e.chineseName = _e.name || 'entity';
      }
    }
  }

  var validation = _validateSchema(schema);
  if (validation.allErrors.length > 0) {
    var repairedKnownIssues = _repairSchemaValidationErrors(schema, validation.allErrors, ctx);
    if (repairedKnownIssues > 0) {
      validation = _validateSchema(schema);
      if (validation.allErrors.length === 0) {
        ctx.addLog('codegen-schema', 'Deterministic schema repair fixed ' + repairedKnownIssues + ' validation issue(s) without another LLM retry');
      }
    }
  }
  if (validation.allErrors.length > 0) {
    throw new Error('Schema validation failed: ' + validation.allErrors.join('; '));
  }

  return schema;
}

function buildSchemaPrompt(ctx) {
  var specs = JSON.stringify(ctx.blueprint.specs, null, 2);
  var entities = JSON.stringify(ctx.blueprint.entities || [], null, 2);
  var plansSummary = summarizePlansForPrompt(ctx.blueprint.plans);

  var lines = [];
  lines.push('根据分镜 specs 输出完整 JSON 配置对象。严格遵守以下字段定义,不添加额外字段:');
  lines.push('');
  lines.push('gameConfig (必填): { "cameraBackground": [r,g,b], "groundColor": [r,g,b], "moveSpeed": 5.0, "collectRange": 2.0, "maxCarry": 10 }');
  lines.push('entities[]: { "name": "PascalCaseName", "chineseName": "中文名", "showLabel": true, "pool": "__Pool_Shape_Color_NN", "initPos": [x,y,z], "scale": 1.0 } — name 用于 C#,chineseName 是世界标签显示的中文');
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
  lines.push('- ranged_shooter: projectile, detectRange, fireRange, projectileSpeed, damage, fireInterval, hp');
  lines.push('- boss_multiphase: projectile, detectRange, attackRange, attackDamage, attackInterval, moveSpeed, fireRange, projectileSpeed, projectileDamage, fireInterval, hp');
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
  lines.push('1. entities 必须覆盖 blueprint / assembly plan 里的全部运行时实体；不要因为 specs 里没显式 required 就删掉 spawner 产物、bullet、helper machine 等实体');
  lines.push('2. phase 数量必须与 specs 数量一致');
  lines.push('3. 第一个 phase 的 showEntities >= 3 个');
  lines.push('4. 最后一个 phase 的 trigger 必须包含 click_entity');
  lines.push('5. customLogic 只写模板无法覆盖的逻辑，越少越好');
  lines.push('6. timer 不能单独做 trigger');
  lines.push('7. pool 格式: __Pool_{Shape}_{Color}_{NN}');
  lines.push('8. entities[].initPos: [x,y,z], x范围±6, z范围±4, y>0');
  lines.push('9. entities[].scale >= 0.3');
  lines.push('9a. **每个 entity 必须有 chineseName**(中文显示名),从 specs/blueprint 上下文中推断。例: ForgeWorkshop→"锻造间", SpaceJunk→"太空垃圾", RecyclingStation→"回收站"。不能留空、不能给英文、不能复制 name 字段');
  lines.push('9b. showLabel 默认 true(世界空间头顶标签)。以下三类 entity 必须设 showLabel=false:(a) 玩家载具/飞船/avatar(名字含 Player/Ship/Avatar/Vehicle)(b) 货币飘字/金币/gem(名字含 Gold/Coin/Gem/Currency)(c) UI 按钮(名字含 CTAButton/Button/UI)');
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
  if (plansSummary) {
    lines.push('16. 你必须优先遵守下面的 Assembly Plan；不要重新发明实体模块组合、状态 owner、phase 顺序。');
    lines.push('17. 优先把 module 实现映射为 schema 的 phases/onEnter/resources/npcs；只有 unresolved 项才允许落入 customLogic。');
    lines.push('18. 如果 Assembly Plan 指定了 state owner，不要让多个 phase/onEnter 重复写同一业务状态。');
  }
  lines.push('');
  if (plansSummary) {
    lines.push('## Assembly Plan（必须遵守）');
    lines.push(plansSummary);
    lines.push('');
  }
  lines.push('## 分镜 Specs');
  lines.push(specs);
  lines.push('');
  lines.push('## 实体列表');
  lines.push(entities);
  lines.push('');
  lines.push('只输出 JSON 对象，不要 markdown 包裹，不要解释。');
  return lines.join('\n');
}

function summarizePlansForPrompt(plans) {
  if (!plans || !plans.assemblyPlan) return '';
  var summary = {
    registryVersion: plans.registryVersion || null,
    storyboardAtoms: ((plans.storyboardAtomPlan && plans.storyboardAtomPlan.items) || []).map(function(atom) {
      return {
        id: atom.id,
        atomId: atom.atomId,
        phaseId: atom.phaseId,
        params: atom.params || {}
      };
    }),
    entities: ((plans.entityPlan && plans.entityPlan.entities) || []).map(function(entity) {
      return {
        name: entity.name,
        archetypeId: entity.archetypeId || null,
        modules: (entity.modules || []).map(function(module) { return module.moduleId; })
      };
    }),
    systemModules: ((plans.entityPlan && plans.entityPlan.systemModules) || []).map(function(module) {
      return module.moduleId;
    }),
    phaseBindings: ((plans.assemblyPlan && plans.assemblyPlan.phaseBindings) || []).map(function(binding) {
      return {
        phaseId: binding.phaseId,
        activateEntities: binding.activateEntities || [],
        atomIds: binding.atomIds || [],
        completionSignals: binding.completionSignals || []
      };
    }),
    stateOwners: ((plans.assemblyPlan && plans.assemblyPlan.stateOwners) || []).map(function(owner) {
      return {
        state: owner.state,
        moduleInstanceId: owner.moduleInstanceId
      };
    }),
    fileOwners: ((plans.assemblyPlan && plans.assemblyPlan.fileOwners) || []).map(function(owner) {
      return {
        file: owner.file,
        moduleInstanceIds: owner.moduleInstanceIds || []
      };
    }),
    unresolved: (plans.assemblyPlan && plans.assemblyPlan.unresolved) || []
  };
  return JSON.stringify(summary, null, 2);
}

function fillCustomLogic(ctx, schema) {
  var { createFixLoop } = require('../fix-loop.cjs');
  var runCodexText = require('../../worker/codex-coder.js').runCodexText;

  ctx.blueprint.customLogicRounds = 0;
  ctx.blueprint.customLogicTokensIn = 0;
  var customWorkDir = prepareCustomLogicWorkspace(ctx);

  var loop = createFixLoop({
    name: 'codegen-custom',
    maxRounds: 3,
    attempt: function(loopCtx, round) {
      ctx.blueprint.customLogicRounds = round;
      syncCustomLogicWorkspace(ctx, customWorkDir);
      var promptText = buildCustomLogicPrompt(ctx, schema);
      return runCodexText({
        userPrompt: promptText,
        systemPrompt: '你是 Unity C# 代码填充器。只修改 TODO_CUSTOM 区域。',
        backend: 'codex-exec',
        model: 'gpt-5.4',
        workDir: customWorkDir,
        taskId: ctx.taskId,
        log: function(msg) { ctx.addLog('codegen-schema', '[custom R' + round + '] ' + msg); },
        effort: 'medium',
        timeoutMs: 300000,
        allowBackendFallback: true,
        execSandbox: 'workspace-write',
      }).then(function(response) {
        if (!response.ok) {
          throw new Error('Custom logic fill failed: ' + (response.error || '').slice(0, 200));
        }

        var workspaceApplied = loadCustomLogicWorkspaceIntoContext(ctx, customWorkDir);
        if (workspaceApplied) {
          var scopeFixes = (ctx.blueprint && ctx.blueprint.lastCustomLogicScopeFixes) || [];
          if (scopeFixes.length > 0) {
            ctx.addLog('codegen-schema', '[custom R' + round + '] scope scrub: ' + scopeFixes.join(', '));
          }
          var workspaceScrub = applyGeneratedCodeContractScrub(ctx);
          if (workspaceScrub.changed) {
            ctx.addLog('codegen-schema', '[custom R' + round + '] contract scrub: ' + workspaceScrub.fixes.join(', '));
          }
          return { done: true };
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
        var inlineScrub = applyGeneratedCodeContractScrub(ctx);
        if (inlineScrub.changed) {
          ctx.addLog('codegen-schema', '[custom R' + round + '] contract scrub: ' + inlineScrub.fixes.join(', '));
        }

        return { done: true };
      });
    }
  });

  return loop.run(ctx).then(function(result) {
    cleanupCustomLogicWorkspace(customWorkDir);
    return result;
  }).catch(function(err) {
    cleanupCustomLogicWorkspace(customWorkDir);
    throw err;
  });
}

function getCustomLogicManagerDir(workDir) {
  return path.join(workDir, 'Assets', 'Program', 'Script', 'Manager');
}

function normalizeGeneratedCodeText(text) {
  return String(text || '').replace(/\r\n/g, '\n');
}

function mergeNamedTodoRegion(baselineContent, generatedContent, regionName) {
  var baseline = normalizeGeneratedCodeText(baselineContent);
  var generated = normalizeGeneratedCodeText(generatedContent);
  var escaped = String(regionName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  var re = new RegExp('(^[ \\t]*)\\/\\/ TODO_' + escaped + '_START\\s*\\n([\\s\\S]*?)^\\1\\/\\/ TODO_' + escaped + '_END', 'm');
  var baselineMatch = re.exec(baseline);
  if (!baselineMatch) {
    return {
      content: baseline,
      preservedRegion: false,
      strippedEditCount: generated !== baseline ? 1 : 0,
    };
  }
  var generatedMatch = re.exec(generated);
  if (!generatedMatch) {
    return {
      content: baseline,
      preservedRegion: false,
      strippedEditCount: generated !== baseline ? 1 : 0,
    };
  }

  var body = String(generatedMatch[2] || '');
  if (body && !/\n$/.test(body)) body += '\n';
  var merged = baseline.replace(re, function(_match, indent) {
    return indent + '// TODO_' + regionName + '_START\n' + body + indent + '// TODO_' + regionName + '_END';
  });
  var maskedBaseline = baseline.replace(re, function(_match, indent) {
    return indent + '// TODO_' + regionName + '_START\n' + indent + '// [TODO REGION REDACTED]\n' + indent + '// TODO_' + regionName + '_END';
  });
  var maskedGenerated = generated.replace(re, function(_match, indent) {
    return indent + '// TODO_' + regionName + '_START\n' + indent + '// [TODO REGION REDACTED]\n' + indent + '// TODO_' + regionName + '_END';
  });

  return {
    content: merged,
    preservedRegion: normalizeGeneratedCodeText(generatedMatch[2]) !== normalizeGeneratedCodeText(baselineMatch[2]),
    strippedEditCount: maskedBaseline !== maskedGenerated ? 1 : 0,
  };
}

function shouldEnforceAssemblySlotScope(ctx, fileName, content) {
  var text = String(content || '');
  if (/AssemblySlot_/.test(text) || /\[ASSEMBLY OWNER MANIFEST\]/.test(text)) return true;
  var ownerSummary = ctx && ctx.blueprint && ctx.blueprint.assemblyOwnerSummary;
  return !!(ownerSummary && Object.prototype.hasOwnProperty.call(ownerSummary, fileName));
}

function prepareCustomLogicWorkspace(ctx) {
  var taskId = ctx && ctx.taskId ? ctx.taskId : 'task';
  var workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegen-custom-' + taskId + '-'));
  syncCustomLogicWorkspace(ctx, workDir);
  return workDir;
}

function syncCustomLogicWorkspace(ctx, workDir) {
  var managerDir = getCustomLogicManagerDir(workDir);
  fs.mkdirSync(managerDir, { recursive: true });
  fs.writeFileSync(path.join(managerDir, 'GameFlowManagerMain.cs'), String(ctx.csCode || ''));
  var extras = ctx.extraFiles || {};
  Object.keys(extras).forEach(function(name) {
    if (typeof extras[name] !== 'string') return;
    fs.writeFileSync(path.join(managerDir, path.basename(name)), extras[name]);
  });
}

function loadCustomLogicWorkspaceIntoContext(ctx, workDir) {
  var managerDir = getCustomLogicManagerDir(workDir);
  var mainPath = path.join(managerDir, 'GameFlowManagerMain.cs');
  if (!fs.existsSync(mainPath)) return false;
  ctx.blueprint = ctx.blueprint || {};
  ctx.blueprint.lastCustomLogicScopeFixes = [];

  var workspaceTouched = false;
  var nextMainRaw = fs.readFileSync(mainPath, 'utf8');
  if (nextMainRaw !== String(ctx.csCode || '')) workspaceTouched = true;
  var mainMerge = mergeNamedTodoRegion(String(ctx.csCode || ''), nextMainRaw, 'CUSTOM');
  if (mainMerge.strippedEditCount > 0) {
    ctx.blueprint.lastCustomLogicScopeFixes.push('GameFlowManagerMain.cs:TODO_CUSTOM');
  }
  var nextMain = mainMerge.content;
  var changed = nextMain !== String(ctx.csCode || '');
  var nextExtras = Object.assign({}, ctx.extraFiles || {});
  Object.keys(nextExtras).forEach(function(name) {
    var extraPath = path.join(managerDir, path.basename(name));
    if (!fs.existsSync(extraPath)) return;
    var currentContent = String(nextExtras[name] || '');
    var nextContentRaw = fs.readFileSync(extraPath, 'utf8');
    if (nextContentRaw !== currentContent) workspaceTouched = true;
    var nextContent = nextContentRaw;
    if (shouldEnforceAssemblySlotScope(ctx, name, currentContent)) {
      var slotMerge = assemblyEmitter.mergeAssemblySlotEdits(currentContent, nextContentRaw);
      nextContent = slotMerge.content;
      if (slotMerge.strippedEditCount > 0) {
        ctx.blueprint.lastCustomLogicScopeFixes.push(name + ':AssemblySlot');
      }
    }
    if (nextContent !== currentContent) changed = true;
    nextExtras[name] = nextContent;
  });
  ctx.blueprint.customLogicScopeFixCount = (ctx.blueprint.customLogicScopeFixCount || 0) +
    ctx.blueprint.lastCustomLogicScopeFixes.length;
  if (!changed) return workspaceTouched;
  ctx.csCode = nextMain;
  ctx.extraFiles = nextExtras;
  return true;
}

function cleanupCustomLogicWorkspace(workDir) {
  if (!workDir) return;
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_err) {}
}

function applyGeneratedCodeContractScrub(ctx) {
  if (!ctx || !ctx.csCode) return { changed: false, fixes: [] };
  var methodCheck;
  try {
    methodCheck = require('./method-check.cjs');
  } catch (_err) {
    return { changed: false, fixes: [] };
  }
  var changed = false;
  var fixes = [];
  if (methodCheck.autoRepairForbiddenGenericApis && methodCheck.autoRepairForbiddenGenericApis(ctx)) {
    changed = true;
    fixes.push('ForbiddenGenericApi');
  }
  if (methodCheck.autoRepairMalformedIsNear && methodCheck.autoRepairMalformedIsNear(ctx)) {
    changed = true;
    fixes.push('MalformedIsNear');
  }
  if (methodCheck.autoRepairDuplicateStateFields && methodCheck.autoRepairDuplicateStateFields(ctx)) {
    changed = true;
    fixes.push('DuplicateStateFields');
  }
  if (methodCheck.autoRepairDuplicateObjectFields && methodCheck.autoRepairDuplicateObjectFields(ctx)) {
    changed = true;
    fixes.push('DuplicateObjectFields');
  }
  if (methodCheck.autoRepairPlayerAliasDrift && methodCheck.autoRepairPlayerAliasDrift(ctx)) {
    changed = true;
    fixes.push('PlayerAliasDrift');
  }
  if (methodCheck.autoRepairInvalidPoolLiterals && methodCheck.autoRepairInvalidPoolLiterals(ctx)) {
    changed = true;
    fixes.push('InvalidPoolLiterals');
  }
  return { changed: changed, fixes: fixes };
}

function buildCustomLogicPrompt(ctx, schema) {
  var lines = [];
  lines.push('以下 C# 代码已由模板引擎生成 80%。你只需要实现 TODO_CUSTOM 标记的区域。');
  lines.push('');
  lines.push('## 规则');
  lines.push('1. 只修改 TODO_CUSTOM_START 和 TODO_CUSTOM_END 之间的代码');
  lines.push('2. 不要修改 [SKELETON] 标记的代码');
  lines.push('3. 不要修改模板已生成的代码');
  lines.push('4. 只能使用当前代码里已经存在的方法、字段、实体变量名和 safe API。');
  lines.push('5. 不要发明新的 helper 方法，不要调用代码中不存在的方法。把逻辑直接内联在 TODO_CUSTOM 区域。');
  lines.push('6. 可用 safe API: PlaceObj, HideObj, SetScale, AddResource, TrySpend, IsNear, AddGold, ShowFloatingText 等。');
  lines.push('7. 实体变量名使用 PascalCase，且大小写必须与当前代码完全一致（如 Forge 不是 forge，Player 不是 player）。');
  lines.push('8. 如果你需要“worker/auto/queue/tick”之类行为，不要发明 AutoWorkerTick / UpdateWorkers / SpawnEnemy 这类 helper；');
  lines.push('   只能复用当前代码里已经定义的方法，或直接写最小内联逻辑。');
  lines.push('9. Phase-exit 门使用 EntityAdvanced(X, _snap_XPos) — 读 transform.position > 1.5f。');
  lines.push('   若 phase P 的退出条件是 EntityAdvanced(X)，P 的交互逻辑必须在玩家触发时位移 X：');
  lines.push('   调 PlaceObj(X, x, y, z) / HideObj(X) / X.transform.position = new Vector3(...)。');
  lines.push('   仅写 flag (XDone=true / XState=2 / XPlayerActed=true) **不能**满足 gate，phase 永远不退出。');
  lines.push('10. 禁止使用泛型 Unity API：不要写 GetComponent<T>() / List<T> / Dictionary<K,V>。');
  lines.push('11. 不要新声明或重复声明 *State 字段；必须复用 skeleton 里已有的 XxxState。');
  lines.push('12. Player / player / PlayerAvatar 只能选当前代码里已存在的那一个；绝对不要混用。');
  lines.push('13. 禁止 remap pool 名，也不要写 blueprint/skeleton 里不存在的 __Pool_* 字面量。');
  lines.push('14. 同一个标识符的 phase 分发不要写 4 段以上 if/else-if；改用 switch(identifier)。');
  lines.push('15. 工作区里已经放好了真实的 `Assets/Program/Script/Manager/GameFlowManagerMain*.cs`。优先直接修改这些文件；如果你不能落盘，再输出一个 ```csharp 代码块，只包含 TODO_CUSTOM 区域内容。');
  lines.push('16. 如果文件里存在 `AssemblySlot_*` 或 `[ASSEMBLY SLOT]`，优先在对应 owner file 的 slot 内实现，不要把逻辑写到错误 partial。');
  lines.push('17. Flow/Input/Resource/UI/Scene 的 owner 分工必须遵守 assembly scaffold；不要跨文件挪 state owner。');
  lines.push('18. `GameFlowManagerMain.cs` 里只有 `TODO_CUSTOM` 区域会被保留；assembly owner file 里只有 `TODO_AssemblySlot_*` 区域会被保留，其他改动会被丢弃。');
  if (ctx.blueprint && ctx.blueprint.assemblyOwnerSummary) {
    lines.push('');
    lines.push('## Assembly Owner Scaffold');
    lines.push(JSON.stringify(ctx.blueprint.assemblyOwnerSummary, null, 2));
  }
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

module.exports._prepareCustomLogicWorkspace = prepareCustomLogicWorkspace;
module.exports._syncCustomLogicWorkspace = syncCustomLogicWorkspace;
module.exports._loadCustomLogicWorkspaceIntoContext = loadCustomLogicWorkspaceIntoContext;
module.exports._cleanupCustomLogicWorkspace = cleanupCustomLogicWorkspace;
module.exports._applyGeneratedCodeContractScrub = applyGeneratedCodeContractScrub;
module.exports._mergeNamedTodoRegion = mergeNamedTodoRegion;
module.exports._repairSchema = _repairSchema;
module.exports._validateSchema = _validateSchema;

function _validateSchema(schema) {
  var structErrors = schemaValidator.validateGameSchema(schema);
  var semErrors = schemaValidator.validateSemantics(schema);
  return {
    structErrors: structErrors,
    semErrors: semErrors,
    allErrors: structErrors.concat(semErrors),
  };
}

var ALLOWED_ENTITY_KEYS = { name: 1, chineseName: 1, showLabel: 1, pool: 1, initPos: 1, scale: 1, showInPhase: 1, terminalState: 1 };
var ALLOWED_ACTION_KEYS = { action: 1, entity: 1, state: 1, resource: 1, amount: 1, formIndex: 1, text: 1, color: 1, count: 1 };
var ALLOWED_ACTIONS = ['set_entity_state', 'add_resource', 'switch_form', 'show_floating_text', 'set_guide', 'spawn_enemies'];

function inferEntityShowLabel(name) {
  var text = String(name || '');
  if (/Player|Ship|Avatar|Vehicle/i.test(text)) return false;
  if (/^(Gold|Coin|Gem|Currency)$/i.test(text)) return false;
  if (/CTAButton|Button|UIButton|UI/i.test(text)) return false;
  return true;
}

function clampNumber(value, min, max, fallback) {
  var num = Number(value);
  if (!isFinite(num)) return fallback;
  if (num < min) return min;
  if (num > max) return max;
  return num;
}

function normalizeInitPos(pos) {
  var arr = Array.isArray(pos) ? pos : [];
  var x = clampNumber(arr[0], -6, 6, 0);
  var y = clampNumber(arr[1], 0.5, 6, 1);
  var z = clampNumber(arr[2], -4, 4, 0);
  return [x, y, z];
}

function parseBlueprintInitPos(value) {
  if (Array.isArray(value)) return normalizeInitPos(value);
  var text = String(value || '');
  var nums = text.match(/-?\d+(?:\.\d+)?/g);
  if (!nums || nums.length < 3) return [0, 1, 0];
  return normalizeInitPos([parseFloat(nums[0]), parseFloat(nums[1]), parseFloat(nums[2])]);
}

function parseBlueprintScale(value) {
  if (typeof value === 'number') return clampNumber(value, 0.3, 8, 1);
  var text = String(value || '');
  var nums = text.match(/-?\d+(?:\.\d+)?/g);
  if (!nums || nums.length === 0) return 1;
  return clampNumber(parseFloat(nums[0]), 0.3, 8, 1);
}

function inferDefaultEnemyEntity(schema, blueprintEntities) {
  var seen = {};
  var candidates = [];

  function score(name) {
    var text = String(name || '');
    var total = 0;
    if (/Enemy/i.test(text)) total += 40;
    if (/Astronaut|Soldier|Unit|Troop|Mob|Minion|Bot|Drone|Walker/i.test(text)) total += 30;
    if (/Base|Button|CTA|Recycler|Gold|Tower|Belt|Debris|Bullet/i.test(text)) total -= 80;
    return total;
  }

  function pushName(name) {
    if (!name || seen[name]) return;
    seen[name] = true;
    candidates.push(name);
  }

  (schema && schema.npcs || []).forEach(function(npc) {
    if (npc && npc.entity) pushName(npc.entity);
  });
  (schema && schema.entities || []).forEach(function(entity) {
    if (entity && entity.name) pushName(entity.name);
  });
  (blueprintEntities || []).forEach(function(entity) {
    if (entity && entity.name) pushName(entity.name);
  });

  candidates.sort(function(a, b) { return score(b) - score(a); });
  return candidates.length > 0 && score(candidates[0]) > 0 ? candidates[0] : null;
}

function hasNamedRef(value) {
  return String(value || '').trim().length > 0;
}

function _repairSchema(schema, blueprintEntities) {
  if (!schema || typeof schema !== 'object') return;

  // Build blueprint entity lookup: name -> label (Chinese display name)
  // AJV requires chineseName but Haiku --effort low omits it ~30% of runs;
  // backfill from blueprint.label → entity.name → 'entity' before validation.
  var _bpLabelByName = {};
  (blueprintEntities || []).forEach(function(be) {
    if (be && be.name) _bpLabelByName[be.name] = be.label || be.chineseName || '';
  });

  var _defaultEnemyEntity = inferDefaultEnemyEntity(schema, blueprintEntities);

  function pickDefaultResourceName() {
    var resources = schema.resources || [];
    for (var i = 0; i < resources.length; i++) {
      if (resources[i] && hasNamedRef(resources[i].name)) return String(resources[i].name).trim();
    }
    return '';
  }

  function pickCtaEntityName() {
    var candidates = []
      .concat(schema.entities || [])
      .concat(blueprintEntities || []);
    for (var i = 0; i < candidates.length; i++) {
      var name = String(candidates[i] && candidates[i].name || '').trim();
      if (/CTA|Button/i.test(name)) return name;
    }
    return '';
  }

  function pickPhaseFallbackEntity(phase, phaseIdx, phaseCount) {
    if (phase && Array.isArray(phase.showEntities)) {
      for (var i = 0; i < phase.showEntities.length; i++) {
        if (hasNamedRef(phase.showEntities[i])) return String(phase.showEntities[i]).trim();
      }
    }
    if (phase && Array.isArray(phase.hideEntities)) {
      for (var j = 0; j < phase.hideEntities.length; j++) {
        if (hasNamedRef(phase.hideEntities[j])) return String(phase.hideEntities[j]).trim();
      }
    }
    if (phaseIdx === phaseCount - 1) {
      var ctaEntity = pickCtaEntityName();
      if (ctaEntity) return ctaEntity;
    }
    var entities = schema.entities || [];
    for (var k = 0; k < entities.length; k++) {
      if (entities[k] && hasNamedRef(entities[k].name)) return String(entities[k].name).trim();
    }
    for (var m = 0; m < (blueprintEntities || []).length; m++) {
      if (blueprintEntities[m] && hasNamedRef(blueprintEntities[m].name)) return String(blueprintEntities[m].name).trim();
    }
    return '';
  }

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

  if (!Array.isArray(schema.entities)) schema.entities = [];

  var _schemaEntityByName = {};
  (schema.entities || []).forEach(function(e) {
    if (e && e.name) _schemaEntityByName[e.name] = e;
  });

  (blueprintEntities || []).forEach(function(be) {
    if (!be || !be.name) return;
    var existing = _schemaEntityByName[be.name];
    if (!existing) {
      existing = {
        name: be.name,
        chineseName: _bpLabelByName[be.name] || be.name || 'entity',
        showLabel: inferEntityShowLabel(be.name),
        pool: be.pool || be.poolName || null,
        initPos: parseBlueprintInitPos(be.visual && be.visual.position),
        scale: parseBlueprintScale(be.visual && be.visual.scale),
        terminalState: be.terminalState || 1,
      };
      schema.entities.push(existing);
      _schemaEntityByName[be.name] = existing;
      return;
    }

    if (!existing.chineseName || typeof existing.chineseName !== 'string' || existing.chineseName.length === 0) {
      existing.chineseName = _bpLabelByName[be.name] || be.name || 'entity';
    }
    if (typeof existing.showLabel !== 'boolean') {
      existing.showLabel = inferEntityShowLabel(be.name);
    }
    if (!Array.isArray(existing.initPos) || existing.initPos.length < 3) {
      existing.initPos = parseBlueprintInitPos(be.visual && be.visual.position);
    }
    if (existing.scale == null) {
      existing.scale = parseBlueprintScale(be.visual && be.visual.scale);
    }
    if (!existing.pool && (be.pool || be.poolName)) {
      existing.pool = be.pool || be.poolName;
    }
    if (existing.terminalState == null && be.terminalState != null) {
      existing.terminalState = be.terminalState;
    }
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
    // chineseName fallback: blueprint.label → name → 'entity' (prevents Haiku omission from failing validation)
    if (!e.chineseName || typeof e.chineseName !== 'string' || e.chineseName.length === 0) {
      e.chineseName = _bpLabelByName[e.name] || e.name || 'entity';
    }
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

  // Fix phases: strip extra props from onEnter, normalize action names, default required fields
  (schema.phases || []).forEach(function(p) {
    (p.onEnter || []).forEach(function(a) {
      if (!a.action && a.type) { a.action = a.type; delete a.type; }
      if (a.action && ALLOWED_ACTIONS.indexOf(a.action) === -1) {
        a.action = 'set_entity_state';
      }
      // Default required fields to prevent JS undefined leaking into C# code
      if (a.action === 'switch_form' && a.formIndex == null) a.formIndex = 0;
      if (a.action === 'set_entity_state') {
        if (!a.entity) a.entity = 'Unknown';
        if (a.state == null) a.state = 1;
      }
      if (a.action === 'add_resource') {
        if (!a.resource) a.resource = 'default';
        if (a.amount == null) a.amount = 1;
      }
      if (a.action === 'spawn_enemies') {
        if (!a.entity || /^Enemy$/i.test(String(a.entity)) || /^Unknown$/i.test(String(a.entity))) {
          a.entity = _defaultEnemyEntity || 'Enemy';
        }
        if (a.count == null) a.count = 1;
      }
      Object.keys(a).forEach(function(k) { if (!ALLOWED_ACTION_KEYS[k]) delete a[k]; });
    });
    p.onEnter = (p.onEnter || []).filter(function(a) {
      if (!a || !a.action) return false;
      if (a.action === 'set_entity_state' && (!a.entity || /^Enemy$/i.test(String(a.entity)) || /^Unknown$/i.test(String(a.entity)))) return false;
      if (a.action === 'add_resource' && (!a.resource || /^default$/i.test(String(a.resource)))) return false;
      if (a.action === 'show_floating_text' && (a.text == null || String(a.text) === 'undefined')) return false;
      return true;
    });
    (p.onComplete || []).forEach(function(a) {
      if (!a.action && a.type) { a.action = a.type; delete a.type; }
      if (a.action === 'spawn_enemies') {
        if (!a.entity || /^Enemy$/i.test(String(a.entity)) || /^Unknown$/i.test(String(a.entity))) {
          a.entity = _defaultEnemyEntity || 'Enemy';
        }
        if (a.count == null) a.count = 1;
      }
      Object.keys(a).forEach(function(k) { if (!ALLOWED_ACTION_KEYS[k]) delete a[k]; });
    });
    p.onComplete = (p.onComplete || []).filter(function(a) {
      if (!a || !a.action) return false;
      if (a.action === 'set_entity_state' && (!a.entity || /^Enemy$/i.test(String(a.entity)) || /^Unknown$/i.test(String(a.entity)))) return false;
      if (a.action === 'add_resource' && (!a.resource || /^default$/i.test(String(a.resource)))) return false;
      if (a.action === 'show_floating_text' && (a.text == null || String(a.text) === 'undefined')) return false;
      return true;
    });
  });

  // Fix triggers: infer missing type, normalize common aliases, strip stray
  // fields, and recurse into compound triggers before validation.
  function inferTriggerType(t, phaseIdx, phaseCount) {
    if (!t || typeof t !== 'object') return null;
    if (typeof t.type === 'string' && t.type) return t.type;
    if (typeof t.triggerType === 'string' && t.triggerType) return t.triggerType;
    if (typeof t.condition === 'string' && t.condition) return t.condition;
    if (typeof t.kind === 'string' && t.kind) return t.kind;
    if (Array.isArray(t.triggers)) return 'compound';
    if (t.resource != null || t.amount != null) return 'resource_collected';
    if (t.state != null) return 'entity_state_reached';
    if (t.seconds != null) return 'timer';
    if (t.count != null) return 'enemy_defeated';
    if (t.range != null) return 'near_entity';
    if (t.entity != null) return phaseIdx === (phaseCount - 1) ? 'click_entity' : 'near_entity';
    return 'all_built';
  }
  function wrapStandaloneTimerTrigger(t) {
    if (!t || typeof t !== 'object' || t.type !== 'timer') return false;
    var seconds = Number(t.seconds);
    if (!isFinite(seconds) || seconds < 0) seconds = 1;
    t.type = 'compound';
    t.operator = 'and';
    t.triggers = [
      { type: 'timer', seconds: seconds },
      { type: 'timer', seconds: seconds },
    ];
    delete t.entity;
    delete t.resource;
    delete t.amount;
    delete t.count;
    delete t.state;
    delete t.range;
    delete t.seconds;
    return true;
  }
  function normalizeTrigger(t, phaseIdx, phaseCount, insideCompound) {
    if (!t || typeof t !== 'object') return;
    if (!t.type || typeof t.type !== 'string') {
      t.type = inferTriggerType(t, phaseIdx, phaseCount);
    }
    if (!t.type && t.triggerType) t.type = t.triggerType;
    if (!t.type && t.condition) t.type = t.condition;
    if (!t.type && t.kind) t.type = t.kind;
    delete t.triggerType;
    delete t.condition;
    delete t.kind;
    if (t.state != null && typeof t.state !== 'number') t.state = parseInt(t.state, 10) || 0;
    if (t.amount != null && typeof t.amount !== 'number') t.amount = parseInt(t.amount, 10) || 1;
    if (t.count != null && typeof t.count !== 'number') t.count = parseInt(t.count, 10) || 1;
    if (t.range != null && typeof t.range !== 'number') t.range = parseFloat(t.range) || 2;
    if (t.seconds != null && typeof t.seconds !== 'number') t.seconds = parseFloat(t.seconds) || 1;
    if ((t.type === 'entity_state_reached' || t.type === 'near_entity' || t.type === 'click_entity') && !hasNamedRef(t.entity)) {
      t.entity = pickPhaseFallbackEntity(schema.phases && schema.phases[phaseIdx], phaseIdx, phaseCount);
    }
    if (t.type === 'entity_state_reached' && t.state == null) t.state = 1;
    if (t.type === 'near_entity' && (!isFinite(Number(t.range)) || Number(t.range) <= 0)) t.range = 2;
    if (t.type === 'resource_collected') {
      if (!hasNamedRef(t.resource)) t.resource = pickDefaultResourceName();
      if (t.amount == null || !isFinite(Number(t.amount))) t.amount = 1;
    }
    if (!insideCompound) wrapStandaloneTimerTrigger(t);
    if (t.type === 'compound') {
      if (!Array.isArray(t.triggers)) t.triggers = [];
      t.operator = t.operator === 'or' ? 'or' : 'and';
      t.triggers.forEach(function(child) { normalizeTrigger(child, phaseIdx, phaseCount, true); });
    }
    Object.keys(t).forEach(function(k) {
      if (!{ type: 1, entity: 1, resource: 1, amount: 1, count: 1, state: 1, range: 1, seconds: 1, operator: 1, triggers: 1 }[k]) {
        delete t[k];
      }
    });
  }
  (schema.phases || []).forEach(function(p, idx, arr) { normalizeTrigger(p.trigger, idx, arr.length, false); });

  // Fix customLogic: ensure array of strings
  if (schema.customLogic) {
    schema.customLogic = schema.customLogic.filter(function(x) { return typeof x === 'string'; });
  }
}

function _repairSchemaValidationErrors(schema, errors, ctx) {
  if (!schema || !Array.isArray(errors) || errors.length === 0) return 0;
  var repaired = 0;
  var entities = Array.isArray(schema.entities) ? schema.entities : [];
  var entityNames = {};
  for (var ei = 0; ei < entities.length; ei++) {
    if (entities[ei] && entities[ei].name) entityNames[entities[ei].name] = true;
  }

  function logFix(msg) {
    if (ctx && ctx.addLog) ctx.addLog('codegen-schema', 'repair: ' + msg);
  }

  function clampEntityScale(idx) {
    if (!entities[idx]) return false;
    var cur = Number(entities[idx].scale);
    if (!isFinite(cur) || cur < 0.3) {
      entities[idx].scale = 0.3;
      return true;
    }
    return false;
  }

  function ensureEntityField(idx, field, value) {
    if (!entities[idx]) return false;
    if (entities[idx][field] == null || entities[idx][field] === '') {
      entities[idx][field] = value;
      return true;
    }
    return false;
  }

  for (var i = 0; i < errors.length; i++) {
    var err = String(errors[i] || '');
    var m;

    m = err.match(/^\.entities\[(\d+)\]\.scale should be >= 0\.3$/);
    if (m && clampEntityScale(parseInt(m[1], 10))) {
      repaired++;
      logFix('clamped entities[' + m[1] + '].scale to 0.3');
      continue;
    }

    m = err.match(/^\.entities\[(\d+)\]\.scale should be number$/);
    if (m && clampEntityScale(parseInt(m[1], 10))) {
      repaired++;
      logFix('normalized entities[' + m[1] + '].scale to numeric default 0.3');
      continue;
    }

    m = err.match(/^\.entities\[(\d+)\] should have required property '([^']+)'$/);
    if (m) {
      var entityIdx = parseInt(m[1], 10);
      var field = m[2];
      var fixed = false;
      if (field === 'chineseName') fixed = ensureEntityField(entityIdx, field, (entities[entityIdx] && entities[entityIdx].name) || 'entity');
      else if (field === 'showLabel') fixed = ensureEntityField(entityIdx, field, true);
      else if (field === 'scale') fixed = ensureEntityField(entityIdx, field, 1.0);
      else if (field === 'initPos') fixed = ensureEntityField(entityIdx, field, [0, 1, 0]);
      else if (field === 'pool') fixed = ensureEntityField(entityIdx, field, '__Pool_Cube_White_01');
      if (fixed) {
        repaired++;
        logFix('filled missing entities[' + entityIdx + '].' + field);
        continue;
      }
    }

    m = err.match(/^Phase ([^ ]+) showEntities references non-existent entity: (.+)$/);
    if (m) {
      var phaseIdA = m[1];
      var badShow = m[2];
      var phaseA = (schema.phases || []).find(function(p) { return p && p.phaseId === phaseIdA; });
      if (phaseA && Array.isArray(phaseA.showEntities)) {
        var nextShow = phaseA.showEntities.filter(function(name) { return entityNames[name]; });
        if (nextShow.length !== phaseA.showEntities.length) {
          phaseA.showEntities = nextShow;
          repaired++;
          logFix('removed invalid showEntities reference "' + badShow + '" from phase ' + phaseIdA);
          continue;
        }
      }
    }

    m = err.match(/^Phase ([^ ]+) hideEntities references non-existent entity: (.+)$/);
    if (m) {
      var phaseIdB = m[1];
      var badHide = m[2];
      var phaseB = (schema.phases || []).find(function(p) { return p && p.phaseId === phaseIdB; });
      if (phaseB && Array.isArray(phaseB.hideEntities)) {
        var nextHide = phaseB.hideEntities.filter(function(name) { return entityNames[name]; });
        if (nextHide.length !== phaseB.hideEntities.length) {
          phaseB.hideEntities = nextHide;
          repaired++;
          logFix('removed invalid hideEntities reference "' + badHide + '" from phase ' + phaseIdB);
          continue;
        }
      }
    }

    if (/^Last phase trigger must include click_entity/.test(err)) {
      var lastPhase = schema.phases && schema.phases[schema.phases.length - 1];
      if (lastPhase) {
        lastPhase.trigger = {
          type: 'compound',
          operator: 'and',
          triggers: [
            lastPhase.trigger || { type: 'near_entity', entity: (lastPhase.showEntities && lastPhase.showEntities[0]) || (entities[0] && entities[0].name) || 'CTAButton', range: 2 },
            { type: 'click_entity', entity: (lastPhase.showEntities && lastPhase.showEntities[0]) || (entities[0] && entities[0].name) || 'CTAButton' },
          ],
        };
        repaired++;
        logFix('wrapped last phase trigger with click_entity CTA guard');
        continue;
      }
    }
  }

  // Mechanical post-pass after error-driven repair.
  if (schema.phases && schema.phases.length > 0) {
    var firstPhase = schema.phases[0];
    if (firstPhase && Array.isArray(firstPhase.showEntities) && firstPhase.showEntities.length < 3) {
      var seen = {};
      for (var se = 0; se < firstPhase.showEntities.length; se++) seen[firstPhase.showEntities[se]] = true;
      for (var ae = 0; ae < entities.length && firstPhase.showEntities.length < 3; ae++) {
        if (entities[ae] && entities[ae].name && !seen[entities[ae].name]) {
          firstPhase.showEntities.push(entities[ae].name);
          seen[entities[ae].name] = true;
          repaired++;
        }
      }
      if (firstPhase.showEntities.length >= 3) logFix('expanded first phase showEntities to satisfy >=3 visibility rule');
    }
  }

  return repaired;
}
