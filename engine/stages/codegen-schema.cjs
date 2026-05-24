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
var templateOutputValidator = require('../../adapters/template-output-validator.cjs');
var triggerNormalizer = require('../../adapters/deterministic-trigger-normalizer.cjs');
var schemaValidator = require('../../adapters/schema/validate-schema.cjs');
var commentLocalizer = require('../../lib/csharp-comment-localizer.cjs');
var signalCompletenessPatcher = require('../signal-completeness-patcher.cjs');
var schemaPromptV3 = require('./build-schema-prompt-v3.cjs');

function estimateTextTokens(text) {
  // CLI runners do not expose usage. Char/4 keeps the trend observable.
  text = String(text || '');
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function addBlueprintTokenEstimate(ctx, field, text) {
  if (!ctx || !ctx.blueprint) return;
  ctx.blueprint[field] = (Number(ctx.blueprint[field] || 0) || 0) + estimateTextTokens(text);
  ctx.blueprint.tokenAccountingSource = 'char_estimate';
}

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

    // Step 1: Generate JSON schema via Sonnet, or consume an explicit
    // prebuilt gameSchema when a deterministic upstream adapter supplied one.
    return resolveCodegenSchema(ctx)
      .then(function(schema) {
        ctx.blueprint.gameSchema = schema;
        var customSuppress = suppressCustomLogicWhenAssemblyCovered(ctx, schema);
        ctx.addLog('codegen-schema', 'Schema generated: ' + schema.phases.length + ' phases, ' +
          schema.entities.length + ' entities, ' + (schema.npcs || []).length + ' NPCs');
        if (customSuppress.suppressedCount > 0) {
          ctx.addLog('codegen-schema', 'Suppressed ' + customSuppress.suppressedCount +
            ' customLogic item(s): assembly implementation coverage=' +
            customSuppress.implementationCoverage.toFixed(3) + ', unresolved=0');
        }

        // Step 2: Template fill
        var startMs = Date.now();
        // Guard: only call resolveEntities when specs exist (mirrors codegen-legacy.cjs:43)
        var resolutionEntities = mergeSchemaEntitiesForResolution(ctx.blueprint.entities, schema.entities);
        var resolved = (ctx.blueprint.specs && ctx.blueprint.specs.length > 0)
          ? resolveEntities(ctx.blueprint.specs, resolutionEntities)
          : { entityPoolMap: {}, resolvedSpecs: [], allEntities: {}, poolManifest: null };
        ctx.blueprint.entityPoolMap = resolved.entityPoolMap;
        ctx.blueprint.poolManifest = resolved.poolManifest;
        var skeletonResult = generateSkeleton(ctx.blueprint.specs, {
          entityPoolMap: resolved.entityPoolMap,
          entities: schema.entities, // carries chineseName / showLabel for world labels
          visualAssets: ctx.blueprint.visualAssets || null,
          w1bSplit: ctx.blueprint.w1bSplit !== false, // default-on: 5-partial skeleton split
        });
        var isW1bSplit = (typeof skeletonResult === 'object' && skeletonResult.mode === 'w1b-5partial');
        if (isW1bSplit && ctx.blueprint && ctx.blueprint.plans && ctx.blueprint.plans.assemblyPlan) {
          var emitted = assemblyEmitter.applyAssemblyPlanToSkeleton(skeletonResult, ctx.blueprint.plans);
          skeletonResult = emitted.files;
          ctx.blueprint.assemblySlotCount = emitted.slotCount;
          ctx.blueprint.assemblyOwnerSummary = emitted.ownerSummary;
          if (emitted.implementationCoverage) {
            ctx.blueprint.assemblyImplementationCoverage = emitted.implementationCoverage.coverage;
            ctx.blueprint.assemblyImplementationMissingCount = emitted.implementationCoverage.missing.length;
            ctx.blueprint.assemblyImplementationMissingModuleIds = emitted.implementationCoverage.missingModuleIds;
          }
          ctx.addLog('codegen-schema', 'Deterministic assembly scaffold emitted: ' + emitted.slotCount + ' owner slot(s)' +
            (emitted.implementationCoverage ? ', implementation=' + emitted.implementationCoverage.coverage.toFixed(3) +
              ', missingImpl=' + emitted.implementationCoverage.missing.length +
              (emitted.implementationCoverage.missingModuleIds && emitted.implementationCoverage.missingModuleIds.length > 0
                ? ' missingModuleIds=[' + emitted.implementationCoverage.missingModuleIds.join(',') + ']'
                : '') : ''));
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
        if (isW1bSplit && ctx.blueprint && ctx.blueprint.plans && ctx.blueprint.plans.assemblyPlan) {
          ctx.csCode = assemblyEmitter.injectAssemblyTickIntoMain(ctx.csCode);
        }
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

          // 2026-05-12: signal completeness patcher — autoplay path 上确保
          // CUA expected signals 都有 evidence,避免单 signal 缺失触发 ~13min Codex recode。
          // 见 engine/signal-completeness-patcher.cjs 头部注释。
          // 包 try/catch 是为了任何 patcher bug 都不让 codegen 整段挂掉(此 patch 仅是优化,非必需)。
          try {
            var sigPatch = signalCompletenessPatcher.patchSignalCompleteness(ctx);
            if (sigPatch && sigPatch.injectedSignalCount > 0) {
              ctx.blueprint.signalCompletenessFallback = {
                phaseCount: sigPatch.injectedPhaseCount,
                signalCount: sigPatch.injectedSignalCount,
                skippedPhases: sigPatch.skippedPhases || [],
              };
            }
          } catch (_sigPatchErr) {
            ctx.addLog('codegen-schema',
              'signal-completeness patcher failed (non-fatal): ' + (_sigPatchErr && _sigPatchErr.message) +
              ' stack=' + (_sigPatchErr && _sigPatchErr.stack || '').split('\n').slice(0, 3).join(' | '));
          }
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
      })
      .then(function(result) {
        var commentStats = localizeGeneratedCSharpComments(ctx);
        if (commentStats.changed) {
          ctx.addLog('codegen-schema', 'Localized generated C# comments to Chinese: ' +
            commentStats.localizedComments + ' comment(s) in ' + commentStats.changedFiles + '/' + commentStats.files + ' file(s)');
        }
        // Deterministic post-fill validation. Records on blueprint so review's
        // skip-LLM gate can use it; never throws — review still runs to fix.
        try {
          var validation = templateOutputValidator.validateFromContext(ctx);
          ctx.blueprint.templateValidation = {
            passed: validation.passed,
            criticalCount: validation.summary.criticalCount,
            summary: validation.summary,
            issues: validation.issues.slice(0, 20),
          };
          var s = validation.summary;
          ctx.addLog('codegen-schema', 'Template validation: ' + (validation.passed ? 'PASS' : 'FAIL') +
            ' — phases ' + s.phaseImplemented + '/' + s.phaseExpected +
            ', npc def/call ' + s.npcDefined + '/' + s.npcChecked + '·' + s.npcCalled + '/' + s.npcChecked +
            ', residue=' + s.markerResidueCount +
            (validation.passed ? '' : ', critical=' + s.criticalCount));
          if (!validation.passed) {
            var top = validation.issues.slice(0, 3).map(function(i) { return i.rule + ': ' + i.message; }).join(' | ');
            ctx.addLog('codegen-schema', 'Template validation issues (top 3): ' + top);
          }
        } catch (e) {
          ctx.addLog('codegen-schema', 'Template validator threw (non-fatal): ' + e.message);
          ctx.blueprint.templateValidation = { passed: false, error: e.message };
        }
        return result;
      });
  },
  _internals: {
    buildSchemaPrompt: buildSchemaPrompt,
    buildSchemaPromptLegacy: buildSchemaPromptLegacy,
    shouldUseSchemaPromptV3: schemaPromptV3.shouldUseSchemaPromptV3,
    shouldUsePrebuiltGameSchema: shouldUsePrebuiltGameSchema,
    validatePrebuiltGameSchema: validatePrebuiltGameSchema,
    resolveCodegenSchema: resolveCodegenSchema,
    summarizePlansForPrompt: summarizePlansForPrompt,
    resolveSchemaRunnerConfig: resolveSchemaRunnerConfig,
    resolveSchemaTimeoutMs: resolveSchemaTimeoutMs,
    resolveSchemaFallbackTimeoutMs: resolveSchemaFallbackTimeoutMs,
    isSchemaInfraError: isSchemaInfraError,
    isSchemaNonRetryableError: isSchemaNonRetryableError,
    resolveSchemaPrimaryCooldownMs: resolveSchemaPrimaryCooldownMs,
    resolveSchemaPrimaryCooldownFile: resolveSchemaPrimaryCooldownFile,
    isSchemaPrimaryCooldownError: isSchemaPrimaryCooldownError,
    readSchemaPrimaryCooldown: readSchemaPrimaryCooldown,
    writeSchemaPrimaryCooldown: writeSchemaPrimaryCooldown,
    localizeGeneratedCSharpComments: localizeGeneratedCSharpComments,
    suppressCustomLogicWhenAssemblyCovered: suppressCustomLogicWhenAssemblyCovered,
    mergeSchemaEntitiesForResolution: mergeSchemaEntitiesForResolution,
  }
};

function localizeGeneratedCSharpComments(ctx) {
  return commentLocalizer.localizeContextCSharpComments(ctx);
}

function mergeSchemaEntitiesForResolution(blueprintEntities, schemaEntities) {
  var merged = [];
  var seen = {};
  var indexByName = {};
  function mergeMissing(target, source) {
    if (!target || !source) return target;
    var keys = ['pool', 'poolName', 'initPos', 'scale', 'chineseName', 'showLabel', 'terminalState'];
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if ((target[key] === undefined || target[key] === null || target[key] === '') && source[key] !== undefined && source[key] !== null && source[key] !== '') {
        target[key] = source[key];
      }
    }
    return target;
  }
  function addEntity(ent) {
    if (!ent || !ent.name) return;
    if (seen[ent.name]) {
      mergeMissing(indexByName[ent.name], ent);
      return;
    }
    seen[ent.name] = true;
    var cloned = Object.assign({}, ent);
    indexByName[ent.name] = cloned;
    merged.push(cloned);
  }
  (Array.isArray(blueprintEntities) ? blueprintEntities : []).forEach(addEntity);
  (Array.isArray(schemaEntities) ? schemaEntities : []).forEach(addEntity);
  return merged;
}

function suppressCustomLogicWhenAssemblyCovered(ctx, schema) {
  var items = schema && Array.isArray(schema.customLogic) ? schema.customLogic.slice() : [];
  if (items.length === 0) {
    if (ctx && ctx.blueprint) {
      ctx.blueprint.customLogicRoute = 'none';
      ctx.blueprint.customLogicRouteReason = 'schema_empty';
    }
    return {
      suppressedCount: 0,
      implementationCoverage: 1,
      route: 'none',
    };
  }

  var blueprint = ctx && ctx.blueprint ? ctx.blueprint : {};
  var plans = blueprint.plans;
  var assemblyPlan = plans && plans.assemblyPlan;
  if (!assemblyPlan) {
    blueprint.customLogicRoute = 'runner_no_assembly_plan';
    blueprint.customLogicRouteReason = 'assemblyPlan missing';
    return {
      suppressedCount: 0,
      implementationCoverage: 0,
      route: blueprint.customLogicRoute,
    };
  }

  var implementation = assemblyEmitter.computeImplementationCoverage(plans);
  var unresolvedCount = Array.isArray(assemblyPlan.unresolved)
    ? assemblyPlan.unresolved.length
    : (blueprint.assemblyUnresolvedCount || 0);
  var assemblyCoverage = Number(blueprint.assemblyCoverage);
  if (!isFinite(assemblyCoverage)) assemblyCoverage = 1;

  blueprint.assemblyImplementationCoverage = implementation.coverage;
  blueprint.assemblyImplementationMissingCount = implementation.missing.length;
  blueprint.assemblyImplementationMissingModuleIds = implementation.missingModuleIds;
  blueprint.assemblyImplementationTotal = implementation.total;
  blueprint.assemblyImplementationImplemented = implementation.implemented;

  var fullyCovered = implementation.total > 0 &&
    implementation.missing.length === 0 &&
    implementation.coverage >= 0.999 &&
    unresolvedCount === 0 &&
    assemblyCoverage >= 0.999 &&
    blueprint.assemblyDecision === 'assembly_ready';

  if (!fullyCovered) {
    var reason = [];
    if (implementation.total <= 0) reason.push('no implementation slots');
    if (implementation.missing.length > 0) reason.push('missing implementation: ' + implementation.missingModuleIds.join(','));
    if (implementation.coverage < 0.999) reason.push('implementation coverage ' + implementation.coverage.toFixed(3));
    if (unresolvedCount !== 0) reason.push('unresolved ' + unresolvedCount);
    if (assemblyCoverage < 0.999) reason.push('assembly coverage ' + assemblyCoverage.toFixed(3));
    if (blueprint.assemblyDecision !== 'assembly_ready') reason.push('decision ' + (blueprint.assemblyDecision || 'n/a'));
    blueprint.customLogicRoute = unresolvedCount > 0
      ? 'runner_unresolved'
      : (implementation.missing.length > 0 ? 'runner_implementation_gap' : 'runner_coverage_gap');
    blueprint.customLogicRouteReason = reason.join('; ');
    return {
      suppressedCount: 0,
      implementationCoverage: implementation.coverage,
      route: blueprint.customLogicRoute,
    };
  }

  schema.customLogic = [];
  blueprint.customLogicSuppressedCount = (blueprint.customLogicSuppressedCount || 0) + items.length;
  blueprint.customLogicSuppressedItems = (blueprint.customLogicSuppressedItems || []).concat(items);
  blueprint.customLogicRoute = 'deterministic_suppressed';
  blueprint.customLogicRouteReason = 'full assembly implementation coverage';
  return {
    suppressedCount: items.length,
    implementationCoverage: implementation.coverage,
    route: blueprint.customLogicRoute,
  };
}

function generateSchemaFromSpecs(ctx) {
  var maxRetries = 2;
  var attempt = 0;
  var runCodexText = require('../../worker/codex-coder.js').runCodexText;
  if (ctx && ctx.blueprint) {
    ctx.blueprint.schemaTokensIn = 0;
    ctx.blueprint.schemaTokensOut = 0;
  }

  function tryGenerate() {
    attempt++;
    ctx.addLog('codegen-schema', 'Schema generation attempt ' + attempt + '/' + (maxRetries + 1));

    // Build prompt for Sonnet
    var promptText = buildSchemaPrompt(ctx);
    addBlueprintTokenEstimate(ctx, 'schemaTokensIn', promptText);

    return generateSchemaTextWithFallback(runCodexText, ctx, promptText).then(function(response) {
      if (!response.ok) {
        throw new Error('Schema generation failed: ' + (response.error || '').slice(0, 300));
      }
      addBlueprintTokenEstimate(ctx, 'schemaTokensOut', response.text || '');
      return parseAndValidateSchemaResponse(ctx, response.text || '');
    }).catch(function(err) {
      if (attempt <= maxRetries && !isSchemaNonRetryableError(err.message)) {
        ctx.addLog('codegen-schema', 'Retry (' + attempt + '): ' + err.message);
        return tryGenerate();
      }
      throw err;
    });
  }

  return tryGenerate();
}

function shouldUsePrebuiltGameSchema(ctx) {
  var blueprint = ctx && ctx.blueprint ? ctx.blueprint : {};
  return !!(blueprint.gameSchema && (
    blueprint.prebuiltGameSchema === true ||
    blueprint.skipSchemaGeneration === true ||
    blueprint.schemaSource === 'demo2spec'
  ));
}

function resolveCodegenSchema(ctx) {
  if (shouldUsePrebuiltGameSchema(ctx)) {
    ctx.addLog('codegen-schema', 'Using prebuilt gameSchema from blueprint context; skipping schema LLM');
    return Promise.resolve(validatePrebuiltGameSchema(ctx, ctx.blueprint.gameSchema));
  }
  return generateSchemaFromSpecs(ctx);
}

function validatePrebuiltGameSchema(ctx, schemaInput) {
  var schema = JSON.parse(JSON.stringify(schemaInput || {}));
  _repairSchema(schema, ctx.blueprint && ctx.blueprint.entities, ctx.blueprint && ctx.blueprint.specs);

  var validation = _validateSchema(schema);
  if (validation.allErrors.length > 0) {
    var repairedKnownIssues = _repairSchemaValidationErrors(schema, validation.allErrors, ctx);
    if (repairedKnownIssues > 0) {
      validation = _validateSchema(schema);
      if (validation.allErrors.length === 0) {
        ctx.addLog('codegen-schema', 'Deterministic prebuilt schema repair fixed ' +
          repairedKnownIssues + ' validation issue(s)');
      }
    }
  }
  if (validation.allErrors.length > 0) {
    throw new Error('Prebuilt gameSchema validation failed: ' + validation.allErrors.join('; '));
  }

  ctx.blueprint.prebuiltGameSchemaUsed = true;
  ctx.blueprint.schemaTokensIn = 0;
  ctx.blueprint.schemaTokensOut = 0;
  return schema;
}

function generateSchemaTextWithFallback(runCodexText, ctx, promptText) {
  var primarySystemPrompt = '你是试玩广告游戏配置生成器。只输出 JSON 对象，不要 markdown 包裹，不要解释。';
  var runnerConfig = resolveSchemaRunnerConfig();
  if (process.env.SCHEMA_PRIMARY_BACKEND === 'claude-print') {
    ctx.addLog('codegen-schema', 'Schema primary backend overridden to claude-print via SCHEMA_PRIMARY_BACKEND env');
    return runSchemaFallback(runCodexText, ctx, promptText, primarySystemPrompt, runnerConfig);
  }
  var activeCooldown = readSchemaPrimaryCooldown();
  if (activeCooldown) {
    ctx.addLog('codegen-schema', 'Skipping Codex schema primary due to active quota/model cooldown until ' +
      new Date(activeCooldown.expiresAtMs).toISOString() + ' — using claude-print');
    return runSchemaFallback(runCodexText, ctx, promptText, primarySystemPrompt, runnerConfig);
  }
  return runCodexText({
    userPrompt: promptText,
    systemPrompt: primarySystemPrompt,
    backend: 'codex-exec',
    model: runnerConfig.codexModel,
    taskId: ctx.taskId,
    log: function(msg) { ctx.addLog('codegen-schema', msg); },
    effort: process.env.CODEX_REASONING_EFFORT || 'high',
    timeoutMs: resolveSchemaTimeoutMs(),
    noTools: true,
    minOutputLen: 20,
    allowBackendFallback: false,
  }).then(function(response) {
    if (response.ok || !isSchemaInfraError(response.error)) return response;
    var cooldown = writeSchemaPrimaryCooldown(response.error, ctx);
    if (cooldown) {
      ctx.addLog('codegen-schema', 'Schema primary cooldown activated until ' +
        new Date(cooldown.expiresAtMs).toISOString() + ' after Codex quota/model failure');
    }
    ctx.addLog('codegen-schema', 'Primary schema backend infra/model failure — falling back to claude-print');
    return runSchemaFallback(runCodexText, ctx, promptText, primarySystemPrompt, runnerConfig);
  });
}

function runSchemaFallback(runCodexText, ctx, promptText, primarySystemPrompt, runnerConfig) {
  return runCodexText({
    userPrompt: promptText,
    systemPrompt: primarySystemPrompt,
    backend: 'claude-print',
    model: runnerConfig.claudeModel,
    taskId: ctx.taskId,
    log: function(msg) { ctx.addLog('codegen-schema', '[fallback] ' + msg); },
    // 2026-05-03: 默认从 high 降到 medium。Schema 是结构化 JSON 输出,不需要
    // extended thinking。high → medium 把单 turn 时间从 ~6min 砍到 ~1-2min,
    // 配合 --bare/--tools "" 禁掉 agent loop,15min timeout 不再吃满。
    effort: process.env.CLAUDE_SCHEMA_EFFORT || 'medium',
    timeoutMs: resolveSchemaFallbackTimeoutMs(),
    noTools: true,
    minOutputLen: 20,
    allowBackendFallback: false,
  }).then(function(fallbackResponse) {
    if (fallbackResponse.ok) ctx.addLog('codegen-schema', 'Schema backend fallback succeeded via claude-print');
    return fallbackResponse;
  });
}

function resolveSchemaRunnerConfig(env) {
  env = env || process.env;
  return {
    codexModel: env.CODEX_SCHEMA_MODEL || env.CODEX_TEXT_MODEL || env.CODEX_CODE_MODEL || 'gpt-5.5',
    claudeModel: env.CLAUDE_SCHEMA_MODEL || env.CLAUDE_TEXT_MODEL || env.CLAUDE_CODE_MODEL || 'claude-sonnet-4-6',
  };
}

function resolveSchemaTimeoutMs(env) {
  env = env || process.env;
  var timeout = parseInt(env.CODEX_SCHEMA_TIMEOUT_MS || env.CODEX_TEXT_TIMEOUT_MS || '', 10);
  return isFinite(timeout) && timeout > 0 ? timeout : 360000;
}

function resolveSchemaFallbackTimeoutMs(env) {
  env = env || process.env;
  var timeout = parseInt(env.CLAUDE_SCHEMA_TIMEOUT_MS || env.CODEX_SCHEMA_FALLBACK_TIMEOUT_MS || '', 10);
  return isFinite(timeout) && timeout > 0 ? timeout : 900000;
}

function resolveSchemaPrimaryCooldownMs(env) {
  env = env || process.env;
  var raw = env.CODEX_SCHEMA_PRIMARY_COOLDOWN_MS;
  if (String(raw || '').toLowerCase() === 'off') return 0;
  var timeout = parseInt(raw || '', 10);
  return isFinite(timeout) && timeout >= 0 ? timeout : 30 * 60 * 1000;
}

function resolveSchemaPrimaryCooldownFile(env) {
  env = env || process.env;
  return env.CODEX_SCHEMA_PRIMARY_COOLDOWN_FILE ||
    path.join(os.tmpdir(), 'blueprint-codex-schema-primary-cooldown.json');
}

function isSchemaPrimaryCooldownError(error) {
  var text = String(error || '');
  return /MODEL_FATAL|quota|usage limit|hit your usage limit|purchase more credits|insufficient|billing|\b401\b|\b402\b|\b403\b|selected model|may not exist|not have access|model.?not.?found|unknown model|unsupported model/i.test(text);
}

function readSchemaPrimaryCooldown(env, nowMs) {
  env = env || process.env;
  nowMs = isFinite(nowMs) ? nowMs : Date.now();
  var file = resolveSchemaPrimaryCooldownFile(env);
  try {
    if (!fs.existsSync(file)) return null;
    var record = JSON.parse(fs.readFileSync(file, 'utf8'));
    var expiresAtMs = Number(record.expiresAtMs || Date.parse(record.expiresAt || ''));
    if (isFinite(expiresAtMs) && expiresAtMs > nowMs) {
      record.expiresAtMs = expiresAtMs;
      return record;
    }
    try { fs.unlinkSync(file); } catch (_) {}
    return null;
  } catch (_) {
    try { fs.unlinkSync(file); } catch (__) {}
    return null;
  }
}

function writeSchemaPrimaryCooldown(error, ctx, env, nowMs) {
  if (!isSchemaPrimaryCooldownError(error)) return null;
  env = env || process.env;
  var cooldownMs = resolveSchemaPrimaryCooldownMs(env);
  if (!isFinite(cooldownMs) || cooldownMs <= 0) return null;
  nowMs = isFinite(nowMs) ? nowMs : Date.now();
  var file = resolveSchemaPrimaryCooldownFile(env);
  var record = {
    taskId: ctx && ctx.taskId || null,
    reason: String(error || '').slice(0, 180),
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + cooldownMs).toISOString(),
    expiresAtMs: nowMs + cooldownMs,
    cooldownMs: cooldownMs,
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    var tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
    fs.renameSync(tmp, file);
    return record;
  } catch (_) {
    return null;
  }
}

function isSchemaInfraError(error) {
  var text = String(error || '');
  return /MODEL_FATAL|quota|usage limit|hit your usage limit|purchase more credits|insufficient|billing|ECONNRESET|Request timed out|Unable to connect to API|timed out|socket hang up|ENOTFOUND|EHOSTUNREACH|ECONNREFUSED|Connection error|selected model|may not exist|not have access|model.?not.?found|unknown model|unsupported model/i.test(text);
}

function isSchemaNonRetryableError(error) {
  var text = String(error || '');
  // 2026-05-12: 加入上游连接死透时的 fail-fast 关键字。claude --print SDK 内部已经 retry
  // 11 次每次 ~70s = ~13min 才 give up;外层 codegen 再 retry 3 次 = ~39min 烧光。当
  // SDK 拿到 "Unable to connect to API" / "UND_ERR_SOCKET" 时,这个 round 上游真的 down,
  // 外层立即 throw 让任务尽快 FATAL,不要叠加双层指数浪费。
  return /Timed out after \d+ms; Exit code 143|MODEL_FATAL: Codex text runner auth\/quota|Unable to connect to API|UND_ERR_SOCKET/i.test(text);
}

function parseAndValidateSchemaResponse(ctx, text) {
  if (ctx && ctx.blueprint) {
    if (ctx.blueprint.schemaTokensIn == null) ctx.blueprint.schemaTokensIn = 0;
    if (ctx.blueprint.schemaTokensOut == null) ctx.blueprint.schemaTokensOut = 0;
  }

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

  _repairSchema(schema, ctx.blueprint.entities, ctx.blueprint.specs);

  // 2026-05-12 P1b: 如果 _repairSchema 在尾部 pad 过 phase,记录到 ctx.blueprint 便于事后审计。
  if (schema.__paddedPhases) {
    var pad = schema.__paddedPhases;
    delete schema.__paddedPhases;
    ctx.blueprint.schemaPaddedPhases = pad;
    ctx.addLog('codegen-schema',
      'Deterministic phase pad: schema 缺 ' + pad.count + ' phase(s) (idx ' + pad.from + '..' + pad.to +
      '),已从 specs 反推补齐 (DSL 反推 trigger + entitiesRequired 反推 showEntities)');
  }

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

  // 2026-04-27: deterministic trigger normalizer (opt-in via env var).
  // Mode 'shadow' logs LLM↔derivation mismatches without mutating; 'apply'
  // rewrites mismatched triggers from the spec's requiredInteractions DSL.
  // Default 'off' so this ships dark — wire it on by setting
  // DETERMINISTIC_TRIGGER_NORMALIZE=shadow in worker .env once we're ready
  // to gather production data.
  try {
    var trigResult = triggerNormalizer.maybeNormalize(schema, ctx.blueprint && ctx.blueprint.specs);
    if (trigResult.mode !== 'off') {
      var disagree = trigResult.diagnostics.filter(function(d) { return d.status === 'disagree'; });
      var noDeriv = trigResult.diagnostics.filter(function(d) { return d.status === 'no-derivation'; }).length;
      ctx.addLog('codegen-schema',
        'Trigger normalizer (' + trigResult.mode + '): ' + disagree.length +
        ' disagree, ' + noDeriv + ' no-derivation, ' + trigResult.applied + ' applied');
      if (disagree.length > 0) {
        var sample = disagree.slice(0, 3).map(function(d) {
          return d.phaseId + ' [llm=' + JSON.stringify(d.llmTrigger) +
            ' derived=' + JSON.stringify(d.derivedTrigger) + ']';
        }).join('; ');
        ctx.addLog('codegen-schema', 'Trigger normalizer disagreements (first 3): ' + sample);
      }
      ctx.blueprint.triggerNormalizer = {
        mode: trigResult.mode,
        applied: trigResult.applied,
        disagreeCount: disagree.length,
        noDerivCount: noDeriv,
        agreeCount: trigResult.diagnostics.filter(function(d) { return d.status === 'agree'; }).length,
      };
    }
  } catch (e) {
    ctx.addLog('codegen-schema', 'Trigger normalizer failed (non-blocking): ' + e.message);
  }

  return schema;
}

function buildSchemaPrompt(ctx) {
  var useV3 = schemaPromptV3.shouldUseSchemaPromptV3(ctx);
  if (ctx && ctx.blueprint) {
    ctx.blueprint.schemaPromptVersion = useV3 ? 'v3' : 'legacy';
    ctx.blueprint.schemaPromptHtmlSliceCount = schemaPromptV3.countHtmlPhaseSlices(ctx);
  }
  if (useV3) {
    if (ctx && ctx.blueprint) {
      ctx.blueprint.schemaPromptStaticChars = schemaPromptV3.MAPPING_CHEATSHEET.length;
      ctx.blueprint.schemaPromptSliceMaxChars = schemaPromptV3.DEFAULT_SLICE_MAX_CHARS;
    }
    return schemaPromptV3.buildSchemaPromptV3(ctx, {
      plansSummary: summarizePlansForPrompt(ctx.blueprint && ctx.blueprint.plans),
    });
  }
  return buildSchemaPromptLegacy(ctx);
}

function buildSchemaPromptLegacy(ctx) {
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
  lines.push('9b. showLabel 默认 true(世界空间头顶标签)。以下三类 entity 必须设 showLabel=false:(a) 载具/飞船/avatar(名字含 Ship/Avatar/Vehicle)(b) 货币飘字/金币/gem(名字含 Gold/Coin/Gem/Currency)(c) UI 按钮(名字含 CTAButton/Button/UI)。注意: Player 实体必须 showLabel=true 且 chineseName="玩家" — 玩家必须能在场景里一眼认出自己。');
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
  lines.push('15a. **绝对不要在任何 phase 的 showEntities 里列出 Player**——Player 在 Start() 已摆好且由摇杆/输入持续驱动，phase 重入时若 PlaceObj(Player, initPos) 会把玩家拽回出生点，体感如瞬移。');
  lines.push('15b. 已经在前序 phase 出现且玩家会移动它的实体（载具、可拖动单位、NPC）也尽量不要再次列入 showEntities，避免位置被 phase-init 重置。需要可见但不重置位置的，可以在前序 phase 的 showEntities 里列一次后保持沉默。');
  if (plansSummary) {
    lines.push('16. 你必须优先遵守下面的 Assembly Plan；不要重新发明实体模块组合、状态 owner、phase 顺序。');
    lines.push('17. 优先把 module 实现映射为 schema 的 phases/onEnter/resources/npcs；只有 unresolved 项才允许落入 customLogic。');
    lines.push('18. 如果 Assembly Plan 指定了 state owner，不要让多个 phase/onEnter 重复写同一业务状态。');
    lines.push('19. 对每个 moduleContracts/cuaSteps 的 phaseEvidenceSignals 声明的 signal，必须在对应 phase 写入 phaseEvidence 或 variables["evidence.<phase>.<signal>..."]；缺失会被 runtime contract 判失败。');
    lines.push('20. 只有 assemblyDecision=assembly_ready、assemblyCoverage=1、unresolved=0、implementationCoverage.coverage=1 且 missingModuleIds 为空时，customLogic 才必须为空数组；否则 unresolved/缺口必须保留在 customLogic 或 fallback 路径中。');
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
  var implementation = assemblyEmitter.computeImplementationCoverage(plans);

  function uniqStrings(values, max) {
    var out = [];
    var seen = {};
    (values || []).forEach(function(value) {
      if (value == null) return;
      var text = String(value).trim();
      if (!text || seen[text]) return;
      seen[text] = true;
      out.push(text);
    });
    if (max && out.length > max) return out.slice(0, max).concat(['...+' + (out.length - max)]);
    return out;
  }

  function compactParams(params) {
    var allowed = {
      actor: 1, target: 1, entity: 1, resource: 1, item: 1, source: 1,
      amount: 1, count: 1, state: 1, level: 1, range: 1, speed: 1,
      stopRange: 1, cooldown: 1, damage: 1, targetTag: 1
    };
    var out = {};
    Object.keys(params || {}).forEach(function(key) {
      if (!allowed[key]) return;
      var value = params[key];
      if (typeof value === 'string') {
        out[key] = value.length > 80 ? value.slice(0, 77) + '...' : value;
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        out[key] = value;
      }
    });
    return out;
  }

  function signalNames(values, max) {
    return uniqStrings((values || []).map(function(value) {
      if (typeof value === 'string') return value;
      if (value && typeof value === 'object') return value.signal || value.name || value.id || value.kind;
      return '';
    }), max);
  }

  function moduleIds(modules, max) {
    return uniqStrings((modules || []).map(function(module) {
      return typeof module === 'string' ? module : (module && module.moduleId);
    }), max);
  }

  function compactStateName(value) {
    var text = String(value || '').trim();
    return text.length > 64 ? text.slice(0, 61) + '...' : text;
  }

  function compactRef(value) {
    var text = String(value || '').trim();
    if (!text || text.length > 48) return '';
    return text;
  }

  function refNames(values, max) {
    return uniqStrings((values || []).map(compactRef).filter(Boolean), max);
  }

  var atomsByPhase = {};
  ((plans.storyboardAtomPlan && plans.storyboardAtomPlan.items) || []).forEach(function(atom) {
    var phaseId = atom.phaseId || 'unknown';
    if (!atomsByPhase[phaseId]) {
      atomsByPhase[phaseId] = { phaseId: phaseId, atomIds: [], atomTypes: [], modules: [], signals: [] };
    }
    atomsByPhase[phaseId].atomIds.push(atom.id);
    atomsByPhase[phaseId].atomTypes.push(atom.atomId);
    atomsByPhase[phaseId].modules = atomsByPhase[phaseId].modules.concat(atom.mappedModules || []);
    atomsByPhase[phaseId].signals = atomsByPhase[phaseId].signals.concat(atom.cuaAssertions || []);
    var params = compactParams(atom.params || {});
    ['actor', 'target', 'entity', 'resource', 'item'].forEach(function(key) {
      if (params[key]) atomsByPhase[phaseId][key + 's'] = (atomsByPhase[phaseId][key + 's'] || []).concat([params[key]]);
    });
  });

  var moduleContractsByType = {};
  ((plans.assemblyPlan && plans.assemblyPlan.moduleInstances) || []).forEach(function(module) {
    var key = module.moduleId || 'unknown_module';
    if (!moduleContractsByType[key]) {
      moduleContractsByType[key] = {
        moduleId: key,
        count: 0,
        entities: [],
        expectedSignals: [],
        phaseEvidenceSignals: []
      };
    }
    moduleContractsByType[key].count++;
    moduleContractsByType[key].entities.push(module.entity || '');
    moduleContractsByType[key].expectedSignals = moduleContractsByType[key].expectedSignals.concat(module.expectedSignals || []);
    moduleContractsByType[key].phaseEvidenceSignals = moduleContractsByType[key].phaseEvidenceSignals.concat(module.phaseEvidenceSchema || []);
  });

  var stateOwnersByModule = {};
  ((plans.assemblyPlan && plans.assemblyPlan.stateOwners) || []).forEach(function(owner) {
    var moduleId = String(owner.moduleInstanceId || 'unknown_owner').split('::').pop();
    if (!stateOwnersByModule[moduleId]) {
      stateOwnersByModule[moduleId] = { moduleId: moduleId, count: 0, states: [] };
    }
    stateOwnersByModule[moduleId].count++;
    stateOwnersByModule[moduleId].states.push(compactStateName(owner.state));
  });

  var summary = {
    registryVersion: plans.registryVersion || null,
    implementationCoverage: {
      total: implementation.total,
      implemented: implementation.implemented,
      coverage: implementation.coverage,
      missingModuleIds: implementation.missingModuleIds,
    },
    storyboardAtomSummary: Object.keys(atomsByPhase).map(function(phaseId) {
      var group = atomsByPhase[phaseId];
      return {
        phaseId: phaseId,
        atomIds: uniqStrings(group.atomIds, 8),
        atomTypes: uniqStrings(group.atomTypes, 8),
        modules: uniqStrings(group.modules, 8),
        signals: signalNames(group.signals, 8),
        actors: refNames(group.actors || [], 4),
        targets: refNames(group.targets || [], 5),
        resources: refNames((group.resources || []).concat(group.items || []), 5)
      };
    }),
    entities: ((plans.entityPlan && plans.entityPlan.entities) || []).map(function(entity) {
      return {
        name: entity.name,
        label: entity.label || null,
        archetypeId: entity.archetypeId || null,
        modules: moduleIds(entity.modules || [], 12)
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
        completionSignals: signalNames(binding.completionSignals || [], 12)
      };
    }),
    moduleContracts: Object.keys(moduleContractsByType).sort().map(function(moduleId) {
      var module = moduleContractsByType[moduleId];
      return {
        moduleId: module.moduleId,
        count: module.count,
        entities: uniqStrings(module.entities, 12),
        expectedSignals: signalNames(module.expectedSignals || [], 6),
        phaseEvidenceSignals: signalNames(module.phaseEvidenceSignals || [], 6)
      };
    }),
    cuaSteps: ((plans.cuaPlan && plans.cuaPlan.steps) || []).map(function(step) {
      return {
        phaseId: step.phaseId,
        expectedSignals: signalNames(step.expectedSignals || [], 10),
        phaseEvidenceSignals: signalNames(step.phaseEvidenceSchema || [], 10)
      };
    }),
    stateOwners: Object.keys(stateOwnersByModule).sort().map(function(moduleId) {
      var owner = stateOwnersByModule[moduleId];
      return {
        moduleId: owner.moduleId,
        count: owner.count,
        states: uniqStrings(owner.states, 4)
      };
    }),
    fileOwners: ((plans.assemblyPlan && plans.assemblyPlan.fileOwners) || []).map(function(owner) {
      return {
        file: owner.file,
        moduleInstanceIds: uniqStrings(owner.moduleInstanceIds || [], 12)
      };
    }),
    unresolved: (plans.assemblyPlan && plans.assemblyPlan.unresolved) || []
  };
  return stringifyCompactPromptJson(summary);
}

function stringifyCompactPromptJson(value) {
  // Keep minified JSON token cost, but add cheap legal whitespace so the
  // runner/log pipeline never sees the whole Assembly Plan as one line.
  return JSON.stringify(value).replace(/,/g, ',\n');
}

function fillCustomLogic(ctx, schema) {
  var { createFixLoop } = require('../fix-loop.cjs');
  var runCodexText = require('../../worker/codex-coder.js').runCodexText;

  ctx.blueprint.customLogicRounds = 0;
  ctx.blueprint.customLogicTokensIn = 0;
  var customWorkDir = prepareCustomLogicWorkspace(ctx);
  var customSystemPrompt = '你是 Unity C# 代码填充器。只修改 TODO_CUSTOM 区域。';

  var loop = createFixLoop({
    name: 'codegen-custom',
    maxRounds: 3,
    attempt: function(loopCtx, round) {
      ctx.blueprint.customLogicRounds = round;
      syncCustomLogicWorkspace(ctx, customWorkDir);
      var promptText = buildCustomLogicPrompt(ctx, schema);
      addBlueprintTokenEstimate(ctx, 'customLogicTokensIn', customSystemPrompt + '\n' + promptText);
      return runCodexText({
        userPrompt: promptText,
        systemPrompt: customSystemPrompt,
        backend: 'codex-exec',
        model: process.env.CODEX_CUSTOM_MODEL || process.env.CODEX_SCHEMA_MODEL || process.env.CODEX_CODE_MODEL || 'gpt-5.5',
        workDir: customWorkDir,
        taskId: ctx.taskId,
        log: function(msg) { ctx.addLog('codegen-schema', '[custom R' + round + '] ' + msg); },
        effort: process.env.CODEX_REASONING_EFFORT || 'high',
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
  lines.push('8. 如果你需要"worker/auto/queue/tick"之类行为，不要发明 AutoWorkerTick / UpdateWorkers / SpawnEnemy 这类 helper；');
  lines.push('   只能复用当前代码里已经定义的方法，或直接写最小内联逻辑。');
  lines.push('9. Phase-exit 门使用 EntityAdvanced(X, _snap_XPos) — 读 transform.position > 1.5f。');
  lines.push('   若 phase P 的退出条件是 EntityAdvanced(X)，P 的交互逻辑必须在玩家触发时位移 X：');
  lines.push('   调 PlaceObj(X, x, y, z) / HideObj(X) / X.transform.position = new Vector3(...)。');
  lines.push('   仅写 flag (XDone=true / XState=2 / XPlayerActed=true) **不能**满足 gate，phase 永远不退出。');
  lines.push('10. 禁止使用泛型 Unity API：不要写 GetComponent<T>() / List<T> / Dictionary<K,V>。');
  lines.push('11. 不要新声明或重复声明 *State 字段；必须复用 skeleton 里已有的 XxxState。');
  lines.push('12. Player / player / PlayerAvatar 只能选当前代码里已存在的那一个；绝对不要混用。');
  lines.push('13. 禁止 remap pool 名，也不要写 blueprint/skeleton 里不存在的 __Pool_* 字面量。');
  lines.push('14. 不要直接写 `GameObject.Find("__Pool_*")`；实体引用已经由 `RegisterEntityBindings()/GameSceneCtrl` 统一绑定。');
  lines.push('15. 资源 API 必须使用 `GFM_ResourceIds.Gold` / `GFM_ResourceIds.Normalize("...")`，不要写 `AddResource("Gold", ...)` 这种裸字符串。');
  lines.push('16. guide 文案统一调用 `SetGuideText("...")`，不要直接写 `guideText.text = ...`。');
  lines.push('17. AutoPlay fallback 只能留在 `Phase_*_OnAutoPlayArrive()`；真实点击 `Phase_*_OnTap()` 必须写显式玩家交互逻辑。');
  lines.push('18. 同一个标识符的 phase 分发不要写 4 段以上 if/else-if；改用 switch(identifier)。');
  lines.push('19. 工作区里已经放好了真实的 `Assets/Program/Script/Manager/GameFlowManagerMain*.cs`。优先直接修改这些文件；如果你不能落盘，再输出一个 ```csharp 代码块，只包含 TODO_CUSTOM 区域内容。');
  lines.push('20. 如果文件里存在 `AssemblySlot_*` 或 `[ASSEMBLY SLOT]`，优先在对应 owner file 的 slot 内实现，不要把逻辑写到错误 partial。');
  lines.push('21. Flow/Input/Resource/UI/Scene 的 owner 分工必须遵守 assembly scaffold；不要跨文件挪 state owner。');
  lines.push('22. `GameFlowManagerMain.cs` 里只有 `TODO_CUSTOM` 区域会被保留；assembly owner file 里只有 `TODO_AssemblySlot_*` 区域会被保留，其他改动会被丢弃。');
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
var ALLOWED_PHASE_KEYS = { phaseId: 1, showEntities: 1, hideEntities: 1, guideText: 1, trigger: 1, onEnter: 1, onComplete: 1 };
var ALLOWED_ACTIONS = ['set_entity_state', 'add_resource', 'switch_form', 'show_floating_text', 'set_guide', 'spawn_enemies'];

function inferEntityShowLabel(name) {
  var text = String(name || '');
  // 2026-05-03: 之前 Player/Ship/Avatar/Vehicle 全 false → 玩家在场景里没标签,
  // 多 capsule 场景下根本分辨不出哪个是"我"。现在改为只关 Ship/Avatar/Vehicle (载具),
  // Player 必须有标签,chineseName 用 "玩家" (skeleton 端兜底,见 spec_extractor / repair).
  if (/Ship|Avatar|Vehicle/i.test(text)) return false;
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
  // 2026-05-05 round 1: 上限 8 → 1.0。
  // 2026-05-05 round 2: 反馈"实体比例还是过大",再次收紧到 0.3-0.7,默认 0.5。
  // 正交相机 orthoSize=8 下,1m 的 Cube 占屏 ~12.5%,scale 0.7 是 ~8.75% (单个实体),
  // scale 0.5 是 ~6%。一屏摆 5 个实体不互相挡。
  if (typeof value === 'number') return clampNumber(value, 0.3, 0.7, 0.5);
  var text = String(value || '');
  var nums = text.match(/-?\d+(?:\.\d+)?/g);
  if (!nums || nums.length === 0) return 0.5;
  return clampNumber(parseFloat(nums[0]), 0.3, 0.7, 0.5);
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

function _repairSchema(schema, blueprintEntities, blueprintSpecs) {
  if (!schema || typeof schema !== 'object') return;

  // Build blueprint entity lookup: name -> label (Chinese display name)
  // AJV requires chineseName but Haiku --effort low omits it ~30% of runs;
  // backfill from blueprint.label → entity.name → 'entity' before validation.
  var _bpLabelByName = {};
  (blueprintEntities || []).forEach(function(be) {
    if (be && be.name) _bpLabelByName[be.name] = be.label || be.chineseName || '';
  });

  // Build phaseId -> guideText lookup from spec show_guide atoms (Chinese friendly text).
  // Used to backfill missing phase.guideText so SetGuideText() always has content
  // (phase-init template skips emit when guideText is empty → silent UX gap).
  var _bpGuideByPhase = {};
  (blueprintSpecs || []).forEach(function(spec) {
    var atoms = (spec && spec.atoms) || (spec && spec.plan && spec.plan.atoms) || [];
    atoms.forEach(function(atom) {
      if (!atom || atom.atomId !== 'show_guide') return;
      var pid = atom.phaseId;
      var text = atom.params && atom.params.text;
      if (pid && text && typeof text === 'string' && !_bpGuideByPhase[pid]) {
        _bpGuideByPhase[pid] = text;
      }
    });
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
    // 2026-05-03: Player 必须有 "玩家" 标签 (或 blueprint 给的 label 优先)，强制覆盖
    if (/^Player$/i.test(be.name)) {
      existing.showLabel = true;
      if (!existing.chineseName || existing.chineseName === 'entity' || existing.chineseName === be.name) {
        existing.chineseName = _bpLabelByName[be.name] || '玩家';
      }
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
    // 2026-05-05: 常见英文名 → 中文,避免世界标签出现"Gold"这种英文(玩家看不懂)。
    var _commonZh = { Gold: '金币', Coin: '金币', Gem: '宝石', Currency: '货币', Score: '分数', Energy: '能量', Health: '生命' };
    if (_commonZh[e.chineseName]) e.chineseName = _commonZh[e.chineseName];
    // 2026-05-05: 终极 scale 兜底 — LLM/blueprint 给出的 scale 也按 0.3-0.7 cap。
    // 单独走 parseBlueprintScale 不够,因为 LLM 经常直接在 schema JSON 里塞 scale: 1.5,
    // 而 existing.scale 已被赋值,后续 parse 走不到。这里在最终 entities 序列化前再 clamp 一次。
    if (typeof e.scale === 'number') {
      if (!isFinite(e.scale) || e.scale <= 0) e.scale = 0.5;
      else if (e.scale > 0.7) e.scale = 0.7;
      else if (e.scale < 0.3) e.scale = 0.3;
    } else {
      e.scale = 0.5;
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

  // Fix phases: strip extra props from phase/onEnter, normalize action names, default required fields
  (schema.phases || []).forEach(function(p, _phaseIdx) {
    if (!p || typeof p !== 'object') return;
    Object.keys(p).forEach(function(k) { if (!ALLOWED_PHASE_KEYS[k]) delete p[k]; });

    // Backfill guideText: phase-init template only emits SetGuideText when guideText is non-empty,
    // so missing field = silent on-screen guidance gap. Source order:
    //   1) spec show_guide atom for this phaseId (Chinese friendly text)
    //   2) phaseId itself as a fallback label (always non-empty)
    if (!p.guideText || typeof p.guideText !== 'string' || p.guideText.trim().length === 0) {
      var _gt = (p.phaseId && _bpGuideByPhase[p.phaseId]) || p.phaseId || ('Phase ' + (_phaseIdx + 1));
      p.guideText = String(_gt).trim();
    }

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

  // 2026-05-12 P1b: 当 LLM 输出的 phase 数量少于 specs.length (Sonnet 偶发截断输出 / 漏拷贝),
  // 不走重新生成,直接按 specs 模板补齐尾部 phase。只补 tail,中间断号交给 LLM round 处理。
  // 补齐策略:phaseId 从 spec 取;showEntities 用 spec.entitiesRequired;trigger 用
  // triggerNormalizer.deriveTriggerFromInteractions 从 DSL 反推。
  if (Array.isArray(schema.phases) && Array.isArray(blueprintSpecs) && schema.phases.length < blueprintSpecs.length) {
    var padStart = schema.phases.length;
    var totalSpecs = blueprintSpecs.length;
    var schemaEntList = schema.entities || [];
    schema.__paddedPhases = { from: padStart, to: totalSpecs - 1, count: totalSpecs - padStart };
    for (var pi = padStart; pi < totalSpecs; pi++) {
      var spec = blueprintSpecs[pi];
      if (!spec) continue;
      var showEntsArr = [];
      var entReq = Array.isArray(spec.entitiesRequired) ? spec.entitiesRequired : [];
      for (var ei = 0; ei < entReq.length; ei++) {
        var entObj = entReq[ei];
        var entName = entObj && (entObj.name || (typeof entObj === 'string' ? entObj : null));
        if (entName && hasNamedRef(entName)) showEntsArr.push(String(entName).trim());
      }
      var derivedTrigger = null;
      try {
        derivedTrigger = triggerNormalizer.deriveTriggerFromInteractions(
          spec.requiredInteractions, schemaEntList);
      } catch (_e) { derivedTrigger = null; }
      if (!derivedTrigger) {
        // 末位 phase 必须有 CTA gate；中间补位走 near_entity 兜底。
        var fallbackEnt = pickPhaseFallbackEntity(null, pi, totalSpecs);
        if (pi === totalSpecs - 1) {
          derivedTrigger = { type: 'click_entity', entity: fallbackEnt || 'CTAButton' };
        } else {
          derivedTrigger = { type: 'near_entity', entity: fallbackEnt || 'Player', range: 2 };
        }
      }
      var paddedPhase = {
        phaseId: spec.phaseId || ('phase_' + (pi + 1)),
        showEntities: showEntsArr,
        hideEntities: [],
        guideText: _bpGuideByPhase[spec.phaseId] || spec.shortDescription || spec.title || ('阶段 ' + (pi + 1)),
        trigger: derivedTrigger,
        onEnter: [],
      };
      schema.phases.push(paddedPhase);
    }
    // 末位 trigger 必须包含 CTA gate (near_entity or click_entity)。
    var lastIdx = schema.phases.length - 1;
    var lastTrig = schema.phases[lastIdx] && schema.phases[lastIdx].trigger;
    if (lastTrig && lastTrig.type !== 'click_entity' && lastTrig.type !== 'near_entity' && lastTrig.type !== 'compound') {
      var cta = pickCtaEntityName() || (lastTrig.entity || 'CTAButton');
      schema.phases[lastIdx].trigger = {
        type: 'compound',
        operator: 'and',
        triggers: [lastTrig, { type: 'near_entity', entity: cta, range: 2 }],
      };
    }
  }

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

  function pickCtaEntityNameForRepair() {
    for (var ce = 0; ce < entities.length; ce++) {
      var name = String(entities[ce] && entities[ce].name || '').trim();
      if (/CTA|Button/i.test(name)) return name;
    }
    return entityNames.CtaButton ? 'CtaButton' : 'CTAButton';
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

  function stripPhaseExtraProperties(idx) {
    var phase = schema.phases && schema.phases[idx];
    if (!phase || typeof phase !== 'object') return false;
    var changed = false;
    Object.keys(phase).forEach(function(k) {
      if (!ALLOWED_PHASE_KEYS[k]) {
        delete phase[k];
        changed = true;
      }
    });
    return changed;
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

    m = err.match(/^\.phases\[(\d+)\] should NOT have additional properties$/);
    if (m && stripPhaseExtraProperties(parseInt(m[1], 10))) {
      repaired++;
      logFix('stripped additional properties from phases[' + m[1] + ']');
      continue;
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

    if (/^Last phase trigger must include (?:click_entity|CtaButton)/.test(err)) {
      var lastPhase = schema.phases && schema.phases[schema.phases.length - 1];
      if (lastPhase) {
        var ctaEntity = pickCtaEntityNameForRepair();
        lastPhase.trigger = {
          type: 'compound',
          operator: 'and',
          triggers: [
            lastPhase.trigger || { type: 'near_entity', entity: ctaEntity, range: 2 },
            { type: 'near_entity', entity: ctaEntity, range: 2 },
          ],
        };
        repaired++;
        logFix('wrapped last phase trigger with CtaButton arrival gate');
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
