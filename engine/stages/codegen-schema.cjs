/**
 * Schema-driven codegen stage.
 * Step 1: Codex -> JSON game schema
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
var llmHotPath = require('../../lib/llm-hot-path.cjs');
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

var ASCII_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function makeAsciiPhaseId(raw, index, used) {
  used = used || {};
  var original = String(raw || '').trim();
  var base = original;
  if (!ASCII_IDENTIFIER_RE.test(base)) {
    base = original
      .replace(/[^A-Za-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/_+/g, '_');
    if (!base || /^[0-9]/.test(base) || !ASCII_IDENTIFIER_RE.test(base)) {
      base = 'phase' + (index + 1);
    }
  }
  if (!base) base = 'phase' + (index + 1);

  var candidate = base;
  var suffix = 2;
  while (used[candidate]) {
    candidate = base + '_' + suffix;
    suffix++;
  }
  used[candidate] = true;
  return candidate;
}

function rewritePhaseRefsDeep(value, phaseIdMap, seen) {
  if (!value || !phaseIdMap) return;
  seen = seen || [];
  if (seen.indexOf(value) >= 0) return;
  if (Array.isArray(value)) {
    seen.push(value);
    for (var i = 0; i < value.length; i++) rewritePhaseRefsDeep(value[i], phaseIdMap, seen);
    return;
  }
  if (typeof value !== 'object') return;
  seen.push(value);
  Object.keys(value).forEach(function(key) {
    if (key === 'phaseId' && typeof value[key] === 'string' && phaseIdMap[value[key]]) {
      value[key] = phaseIdMap[value[key]];
      return;
    }
    rewritePhaseRefsDeep(value[key], phaseIdMap, seen);
  });
}

function normalizeSchemaPhaseIdsForCodegen(ctx, schema) {
  if (!schema || !Array.isArray(schema.phases)) {
    return { changed: false, map: {}, count: 0 };
  }

  var used = {};
  var map = {};
  var changes = [];
  for (var i = 0; i < schema.phases.length; i++) {
    var phase = schema.phases[i] || {};
    var oldId = String(phase.phaseId || '').trim();
    var nextId = makeAsciiPhaseId(oldId, i, used);
    if (oldId !== nextId) {
      map[oldId] = nextId;
      changes.push(oldId + '→' + nextId);
      phase.phaseId = nextId;
    } else {
      map[oldId] = nextId;
    }
  }

  if (changes.length === 0) {
    return { changed: false, map: {}, count: 0 };
  }

  var remap = {};
  Object.keys(map).forEach(function(oldId) {
    if (oldId && oldId !== map[oldId]) remap[oldId] = map[oldId];
  });

  if (ctx && ctx.blueprint) {
    rewritePhaseRefsDeep(ctx.blueprint.specs, remap);
    rewritePhaseRefsDeep(ctx.blueprint.plans, remap);
    ctx.blueprint.phaseIdNormalization = Object.assign({}, ctx.blueprint.phaseIdNormalization || {}, remap);
    if (typeof ctx.addLog === 'function') {
      ctx.addLog('codegen-schema', 'Normalized non-ASCII/unsafe phaseId(s): ' + changes.join(', '));
    }
  }

  return { changed: true, map: remap, count: changes.length, changes: changes };
}

function triggerToRequiredInteractions(trigger) {
  var out = [];
  function walk(t) {
    if (!t || typeof t !== 'object') return;
    if (t.type === 'compound' && Array.isArray(t.triggers)) {
      for (var i = 0; i < t.triggers.length; i++) walk(t.triggers[i]);
      return;
    }
    if (t.type === 'cta_arrival') return;
    if (t.type === 'click_entity' && t.entity) out.push('click:' + t.entity);
    else if (t.type === 'near_entity' && t.entity) out.push('move_to:' + t.entity);
    else if (t.type === 'resource_collected' && t.resource) out.push('collect:' + t.resource + ':' + (t.amount || 1));
    else if (t.type === 'entity_state_reached' && t.entity) out.push('state:' + t.entity + ':' + (t.state || 1));
    else if (t.type === 'form_switched') out.push('switch_form:' + (t.formIndex || 0));
    else if (t.type === 'timer') out.push('wait:' + (t.seconds || 2));
  }
  walk(trigger);
  return out.filter(Boolean);
}

function buildSkeletonSpecsForSchema(blueprint, schema) {
  blueprint = blueprint || {};
  schema = schema || {};
  var sourceSpecs = Array.isArray(blueprint.specs) ? blueprint.specs : [];
  var schemaPhases = Array.isArray(schema.phases) ? schema.phases : [];
  if (schemaPhases.length === 0) return sourceSpecs;

  var sourceById = {};
  for (var si = 0; si < sourceSpecs.length; si++) {
    var sid = sourceSpecs[si] && sourceSpecs[si].phaseId;
    if (sid) sourceById[sid] = sourceSpecs[si];
  }

  return schemaPhases.map(function(phase, index) {
    phase = phase || {};
    var phaseId = phase.phaseId || ('phase' + (index + 1));
    var matched = sourceById[phaseId] || null;
    var fallback = matched || sourceSpecs[Math.min(index, Math.max(0, sourceSpecs.length - 1))] || {};
    var triggerInteractions = triggerToRequiredInteractions(phase.trigger);
    var requiredInteractions = matched && Array.isArray(matched.requiredInteractions) && matched.requiredInteractions.length > 0
      ? matched.requiredInteractions.slice()
      : (triggerInteractions.length > 0 ? triggerInteractions : (Array.isArray(fallback.requiredInteractions) ? fallback.requiredInteractions.slice() : []));
    var showEntities = Array.isArray(phase.showEntities) ? phase.showEntities.slice() : [];
    var entitiesRequired = matched && Array.isArray(matched.entitiesRequired) && matched.entitiesRequired.length > 0
      ? matched.entitiesRequired.slice()
      : showEntities.map(function(name) {
        return { name: name, terminalState: 1, description: 'Visible in schema phase ' + phaseId };
      });

    return Object.assign({}, fallback, {
      phaseId: phaseId,
      phaseName: phase.phaseName || phase.name || phase.title || fallback.phaseName || fallback.title || phase.guideText || phaseId,
      duration: fallback.duration || { min: 10, max: 15 },
      requiredInteractions: requiredInteractions,
      entitiesRequired: entitiesRequired,
      showEntities: showEntities.length > 0 ? showEntities : (fallback.showEntities || []),
      hideEntities: Array.isArray(phase.hideEntities) ? phase.hideEntities.slice() : (fallback.hideEntities || []),
      triggerNext: fallback.triggerNext || {
        condition: phaseId + '_complete',
        description: 'Schema phase trigger: ' + (phase.trigger ? JSON.stringify(phase.trigger) : 'none'),
      },
      playerInstruction: phase.guideText || fallback.playerInstruction || fallback.autoModeHint || '',
      playerMustAct: fallback.playerMustAct !== undefined ? fallback.playerMustAct : requiredInteractions.length > 0,
      autoAllowed: fallback.autoAllowed !== undefined ? fallback.autoAllowed : false,
    });
  });
}

function isCtaEntityName(value) {
  return /^(?:CTAButton|CtaButton|CTABtn|CtaBtn|InstallButton|DownloadButton)$/i.test(String(value || '').trim());
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

    return resolveCodegenSchema(ctx)
      .then(function(schema) {
        ctx.blueprint.gameSchema = schema;
        normalizeSchemaPhaseIdsForCodegen(ctx, schema);
        var postNormalizeValidation = _validateSchema(schema);
        if (postNormalizeValidation.allErrors.length > 0) {
          var postNormalizeRepaired = _repairSchemaValidationErrors(schema, postNormalizeValidation.allErrors, ctx);
          if (postNormalizeRepaired > 0) {
            postNormalizeValidation = _validateSchema(schema);
            if (postNormalizeValidation.allErrors.length === 0) {
              ctx.addLog('codegen-schema', 'Deterministic post-normalize schema repair fixed ' +
                postNormalizeRepaired + ' validation issue(s) before template fill');
            }
          }
        }
        if (postNormalizeValidation.allErrors.length > 0) {
          throw new Error('Schema validation failed after normalize: ' + postNormalizeValidation.allErrors.join('; '));
        }
        var customSuppress = suppressCustomLogicWhenAssemblyCovered(ctx, schema);
        ctx.addLog('codegen-schema', 'Schema generated: ' + schema.phases.length + ' phases, ' +
          schema.entities.length + ' entities, ' + (schema.npcs || []).length + ' NPCs');
        if (customSuppress.suppressedCount > 0) {
          ctx.addLog('codegen-schema', 'Suppressed ' + customSuppress.suppressedCount +
            ' customLogic item(s): assembly implementation coverage=' +
            customSuppress.implementationCoverage.toFixed(3) + ', unresolved=0');
        }

        var startMs = Date.now();
        var resolutionEntities = mergeSchemaEntitiesForResolution(ctx.blueprint.entities, schema.entities);
        var skeletonSpecs = buildSkeletonSpecsForSchema(ctx.blueprint, schema);
        if (skeletonSpecs.length !== ((ctx.blueprint.specs || []).length)) {
          ctx.addLog('codegen-schema', 'Skeleton specs expanded from ' + ((ctx.blueprint.specs || []).length) +
            ' extracted spec phase(s) to ' + skeletonSpecs.length + ' schema phase(s)');
          ctx.blueprint.originalSpecs = ctx.blueprint.specs || [];
          ctx.blueprint.specsForCodegen = skeletonSpecs;
          ctx.blueprint.specs = skeletonSpecs;
        }
        var resolved = (skeletonSpecs && skeletonSpecs.length > 0)
          ? resolveEntities(skeletonSpecs, resolutionEntities)
          : { entityPoolMap: {}, resolvedSpecs: [], allEntities: {}, poolManifest: null };
        ctx.blueprint.entityPoolMap = resolved.entityPoolMap;
        ctx.blueprint.poolManifest = resolved.poolManifest;
        var skeletonResult = generateSkeleton(skeletonSpecs, {
          entityPoolMap: resolved.entityPoolMap,
          entities: schema.entities,
          visualAssets: ctx.blueprint.visualAssets || null,
          sourceMeshOps: ctx.blueprint.sourceMeshOps || null,
          plans: ctx.blueprint.plans || null,
          w1bSplit: ctx.blueprint.w1bSplit !== false,
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
        }
        var skeletonStr = typeof skeletonResult === 'string' ? skeletonResult : skeletonResult.main;

        var fillResult = templateEngine.fillSkeleton(schema, skeletonStr, {
          w1bSplit: isW1bSplit,
          suppressMissingMarkerWarning: isW1bSplit,
        });
        var combinedMissingMarkers = (fillResult.missingMarkers || []).slice();
        var flowFillResult = null;
        if (isW1bSplit && skeletonResult.flow) {
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

        if (typeof skeletonResult === 'object' && skeletonResult.mode === 'w1b-5partial') {
          ctx.extraFiles = ctx.extraFiles || {};
          ctx.extraFiles['GameFlowManagerMain.Flow.cs'] = flowFillResult ? flowFillResult.code : skeletonResult.flow;
          ctx.extraFiles['GameFlowManagerMain.Input.cs'] = skeletonResult.input;
          ctx.extraFiles['GameFlowManagerMain.Resource.cs'] = skeletonResult.resource;
          ctx.extraFiles['GameFlowManagerMain.UI.cs'] = skeletonResult.ui;
          ctx.extraFiles['GameFlowManagerMain.Scene.cs'] = skeletonResult.scene;
          ctx.addLog('codegen-schema', 'W1b 5-partial: wrote 5 companion files to extraFiles');
        }

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
        try {
          var validation = templateOutputValidator.validateFromContext(ctx);
          ctx.blueprint.templateValidation = {
            passed: validation.passed,
            criticalCount: validation.summary.criticalCount,
            summary: validation.summary,
            issues: validation.issues.slice(0, 20),
          };
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

function generateSchemaFromSpecs(ctx) {
  llmHotPath.guard(ctx, 'codegen-schema.generate-schema', {
    stage: 'codegen-schema',
    purpose: 'fresh gameSchema generation',
    reason: 'no prebuilt gameSchema available',
    metadata: {
      specCount: ctx && ctx.blueprint && Array.isArray(ctx.blueprint.specs) ? ctx.blueprint.specs.length : 0,
      entityCount: ctx && ctx.blueprint && Array.isArray(ctx.blueprint.entities) ? ctx.blueprint.entities.length : 0,
    },
  });
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
    blueprint.schemaSource === 'source-scene-ir'
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
    ctx.addLog('codegen-schema', 'Primary schema backend infra/model failure — falling back to Codex schema secondary');
    return runSchemaFallback(runCodexText, ctx, promptText, primarySystemPrompt, runnerConfig);
  });
}

function runSchemaFallback(runCodexText, ctx, promptText, primarySystemPrompt, runnerConfig) {
  return runCodexText({
    userPrompt: promptText,
    systemPrompt: primarySystemPrompt,
    backend: 'codex-exec',
    model: runnerConfig.codexFallbackModel,
    taskId: ctx.taskId,
    log: function(msg) { ctx.addLog('codegen-schema', '[fallback] ' + msg); },
    effort: process.env.CODEX_SCHEMA_FALLBACK_EFFORT || process.env.CODEX_REASONING_EFFORT || 'high',
    timeoutMs: resolveSchemaFallbackTimeoutMs(),
    noTools: true,
    minOutputLen: 20,
    allowBackendFallback: false,
  }).then(function(fallbackResponse) {
    if (fallbackResponse.ok) ctx.addLog('codegen-schema', 'Schema backend fallback succeeded via codex-exec');
    return fallbackResponse;
  });
}

function resolveSchemaRunnerConfig(env) {
  env = env || process.env;
  var config = {
    codexModel: env.CODEX_SCHEMA_MODEL || env.CODEX_TEXT_MODEL || env.CODEX_CODE_MODEL || 'gpt-5.5',
    claudeModel: env.CLAUDE_SCHEMA_MODEL || env.CLAUDE_TEXT_MODEL || env.CLAUDE_CODE_MODEL || 'claude-opus-4-8',
  };
  Object.defineProperty(config, 'codexFallbackModel', {
    value: env.CODEX_SCHEMA_FALLBACK_MODEL || env.CODEX_TEXT_FALLBACK_MODEL ||
      env.CODEX_SCHEMA_MODEL || env.CODEX_TEXT_MODEL || env.CODEX_CODE_MODEL || 'gpt-5.5',
    enumerable: false,
  });
  return config;
}

function resolveSchemaTimeoutMs(env) {
  env = env || process.env;
  var timeout = parseInt(env.CODEX_SCHEMA_TIMEOUT_MS || env.CODEX_TEXT_TIMEOUT_MS || '', 10);
  return isFinite(timeout) && timeout > 0 ? timeout : 360000;
}

function resolveSchemaFallbackTimeoutMs(env) {
  env = env || process.env;
  var timeout = parseInt(env.CODEX_SCHEMA_FALLBACK_TIMEOUT_MS || env.CLAUDE_SCHEMA_TIMEOUT_MS || env.CODEX_SCHEMA_TIMEOUT_MS || env.CODEX_TEXT_TIMEOUT_MS || '', 10);
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
  return /Reading prompt from stdin|OpenAI Codex v[0-9]|MODEL_FATAL|quota|usage limit|hit your usage limit|purchase more credits|insufficient|billing|ECONNRESET|Request timed out|Unable to connect to API|timed out|socket hang up|ENOTFOUND|EHOSTUNREACH|ECONNREFUSED|Connection error|selected model|may not exist|not have access|model.?not.?found|unknown model|unsupported model/i.test(text);
}

function isSchemaNonRetryableError(error) {
  var text = String(error || '');
  return /Timed out after \d+ms; Exit code 143|MODEL_FATAL: Codex text runner auth\/quota|Unable to connect to API|UND_ERR_SOCKET/i.test(text);
}

function parseAndValidateSchemaResponse(ctx, text) {
  if (ctx && ctx.blueprint) {
    if (ctx.blueprint.schemaTokensIn == null) ctx.blueprint.schemaTokensIn = 0;
    if (ctx.blueprint.schemaTokensOut == null) ctx.blueprint.schemaTokensOut = 0;
  }

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

  try {
    var trigResult = triggerNormalizer.maybeNormalize(schema, ctx.blueprint && ctx.blueprint.specs);
    if (trigResult.mode !== 'off') {
      ctx.blueprint.triggerNormalizer = {
        mode: trigResult.mode,
        applied: trigResult.applied,
        disagreeCount: trigResult.diagnostics.filter(function(d) { return d.status === 'disagree'; }).length,
        noDerivCount: trigResult.diagnostics.filter(function(d) { return d.status === 'no-derivation'; }).length,
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
  lines.push('gameConfig (必填): { "cameraBackground": [r,g,b], "groundColor": [0.3,0.6,0.2], "moveSpeed": 5.0, "collectRange": 2.0, "maxCarry": 10 }');
  lines.push('entities[]: { "name": "PascalCaseName", "chineseName": "中文名", "showLabel": true, "pool": "__Pool_Shape_Color_NN", "initPos": [x,y,z], "scale": 1.0 } — name 用于 C#,chineseName 是世界标签显示的中文');
  lines.push('resources[]: { "name": "资源名", "entity": "关联实体名", "convertRatio": 1 }');
  lines.push('phases[]: { "phaseId": "阶段ID", "showEntities": ["实体名"], "hideEntities": [], "guideText": "引导文字", "trigger": {...}", "onEnter": [{...}] }');
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
  lines.push('- cta_arrival: {ctaId, range} — 最终 CTA/HUD 到达门禁，不是 3D entity');
  lines.push('- all_built: {}');
  lines.push('- enemy_defeated: {count}');
  lines.push('- timer: {seconds} — 必须与其他 trigger 组合(compound)');
  lines.push('- compound: {triggers[], operator: "and"|"or"}');
  lines.push('');
  lines.push('## 规则');
  lines.push('1. entities 必须覆盖 blueprint / assembly plan 里的全部运行时实体；不要因为 specs 里没显式 required 就删掉 spawner 产物、bullet、helper machine 等实体');
  lines.push('2. phase 数量必须与 specs 数量一致');
  lines.push('3. 第一个 phase 的 showEntities >= 3 个');
  lines.push('4. 最后一个 phase 的 trigger 必须包含 cta_arrival 或 legacy click_entity');
  lines.push('5. customLogic 只写模板无法覆盖的逻辑，越少越好');
  lines.push('6. timer 不能单独做 trigger');
  lines.push('7. pool 格式: __Pool_{Shape}_{Color}_{NN}');
  lines.push('8. entities[].initPos: [x,y,z], x范围±6, z范围±4, y>0');
  lines.push('9. entities[].scale >= 0.3');
  if (plansSummary) {
    lines.push('');
    lines.push('## Assembly Plan（必须遵守）');
    lines.push(plansSummary);
  }
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
      ctaId: 1,
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
        allowBackendFallback: false,
        execSandbox: 'workspace-write',
      }).then(function(response) {
        if (!response.ok) {
          throw new Error('Custom logic fill failed: ' + (response.error || '').slice(0, 200));
        }

        var workspaceApplied = loadCustomLogicWorkspaceIntoContext(ctx, customWorkDir);
        if (workspaceApplied) {
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

  return {
    content: merged,
    preservedRegion: normalizeGeneratedCodeText(generatedMatch[2]) !== normalizeGeneratedCodeText(baselineMatch[2]),
    strippedEditCount: 0,
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
  var nextMain = mainMerge.content;
  if (mainMerge.preservedRegion) {
    ctx.blueprint.lastCustomLogicScopeFixes.push('GameFlowManagerMain.cs:TODO_CUSTOM');
  }
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
module.exports._repairSchemaValidationErrors = _repairSchemaValidationErrors;
module.exports._buildSkeletonSpecsForSchema = buildSkeletonSpecsForSchema;
module.exports._normalizeSchemaPhaseIdsForCodegen = normalizeSchemaPhaseIdsForCodegen;

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

  var bpLabelByName = {};
  (blueprintEntities || []).forEach(function(be) {
    if (be && be.name) bpLabelByName[be.name] = be.label || be.chineseName || '';
  });

  var bpGuideByPhase = {};
  (blueprintSpecs || []).forEach(function(spec) {
    var atoms = (spec && spec.atoms) || (spec && spec.plan && spec.plan.atoms) || [];
    atoms.forEach(function(atom) {
      if (!atom || atom.atomId !== 'show_guide') return;
      var pid = atom.phaseId;
      var text = atom.params && atom.params.text;
      if (pid && text && typeof text === 'string' && !bpGuideByPhase[pid]) {
        bpGuideByPhase[pid] = text;
      }
    });
  });

  var defaultEnemyEntity = inferDefaultEnemyEntity(schema, blueprintEntities);

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

  function isFinalCtaTrigger(trigger) {
    if (!trigger || typeof trigger !== 'object') return false;
    if (trigger.type === 'cta_arrival') return true;
    if (trigger.type === 'click_entity') return true;
    if (trigger.type === 'near_entity' && isCtaEntityName(trigger.entity)) return true;
    if (trigger.type === 'compound' && Array.isArray(trigger.triggers)) {
      for (var i = 0; i < trigger.triggers.length; i++) {
        if (isFinalCtaTrigger(trigger.triggers[i])) return true;
      }
    }
    return false;
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
      if (blueprintEntities[m] && hasNamedRef(blueprintEntities[m].name)) {
        return String(blueprintEntities[m].name).trim();
      }
    }
    return '';
  }

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
  var schemaEntityByName = {};
  (schema.entities || []).forEach(function(e) {
    if (e && e.name) schemaEntityByName[e.name] = e;
  });

  (blueprintEntities || []).forEach(function(be) {
    if (!be || !be.name) return;
    var existing = schemaEntityByName[be.name];
    if (!existing) {
      var visual = be.visual || {};
      existing = {
        name: be.name,
        chineseName: bpLabelByName[be.name] || be.name || 'entity',
        showLabel: inferEntityShowLabel(be.name),
        pool: be.pool || be.poolName || be.template || '__Pool_Cube_White_01',
        initPos: parseBlueprintInitPos(visual.position || be.initPos),
        scale: parseBlueprintScale(visual.scale || be.scale),
      };
      schema.entities.push(existing);
      schemaEntityByName[be.name] = existing;
      return;
    }
    if (!existing.chineseName || typeof existing.chineseName !== 'string' || existing.chineseName.length === 0) {
      existing.chineseName = bpLabelByName[be.name] || be.name || 'entity';
    }
    if (typeof existing.showLabel !== 'boolean') {
      existing.showLabel = inferEntityShowLabel(be.name);
    }
    if (!Array.isArray(existing.initPos) || existing.initPos.length < 3) {
      existing.initPos = parseBlueprintInitPos((be.visual && be.visual.position) || be.initPos);
    }
    if (existing.scale == null) {
      existing.scale = parseBlueprintScale((be.visual && be.visual.scale) || be.scale);
    }
    if (!existing.pool && (be.pool || be.poolName || be.template)) {
      existing.pool = be.pool || be.poolName || be.template;
    }
  });

  (schema.entities || []).forEach(function(e) {
    Object.keys(e).forEach(function(k) { if (!ALLOWED_ENTITY_KEYS[k]) delete e[k]; });
    if (!e.chineseName || typeof e.chineseName !== 'string' || e.chineseName.length === 0) {
      e.chineseName = bpLabelByName[e.name] || e.name || 'entity';
    }
    if (typeof e.showLabel !== 'boolean') {
      e.showLabel = inferEntityShowLabel(e.name);
    }
    if (!Array.isArray(e.initPos) || e.initPos.length < 3) {
      e.initPos = [0, 1, 0];
    } else {
      e.initPos = normalizeInitPos(e.initPos);
    }
    e.scale = parseBlueprintScale(e.scale);
    if (!/^__Pool_[A-Z][a-z]+_[A-Z][a-z]+_\d{2}$/.test(String(e.pool || ''))) {
      e.pool = '__Pool_Cube_White_01';
    }
  });

  if (!Array.isArray(schema.resources)) schema.resources = [];
  (schema.resources || []).forEach(function(r) {
    if (!r.entity) r.entity = (schema.entities && schema.entities[0]) ? schema.entities[0].name : 'Unknown';
    if (r.convertRatio == null) r.convertRatio = 1;
    Object.keys(r).forEach(function(k) {
      if (!{ name: 1, entity: 1, convertRatio: 1, maxStock: 1 }[k]) delete r[k];
    });
  });

  function normalizePhaseAction(action) {
    if (!action || typeof action !== 'object') return null;
    if (!action.action && action.type) { action.action = action.type; delete action.type; }
    if (action.action && ALLOWED_ACTIONS.indexOf(action.action) === -1) {
      action.action = 'set_entity_state';
    }
    if (action.action === 'switch_form' && action.formIndex == null) action.formIndex = 0;
    if (action.action === 'set_entity_state') {
      if (!action.entity) action.entity = 'Unknown';
      if (action.state == null) action.state = 1;
    }
    if (action.action === 'add_resource') {
      if (!action.resource) action.resource = 'default';
      if (action.amount == null) action.amount = 1;
    }
    if (action.action === 'spawn_enemies') {
      if (!action.entity || /^Enemy$/i.test(String(action.entity)) || /^Unknown$/i.test(String(action.entity))) {
        action.entity = defaultEnemyEntity || 'Enemy';
      }
      if (action.count == null) action.count = 1;
    }
    Object.keys(action).forEach(function(k) { if (!ALLOWED_ACTION_KEYS[k]) delete action[k]; });
    if (!action.action) return null;
    if (action.action === 'set_entity_state' && (!action.entity || /^Enemy$/i.test(String(action.entity)) || /^Unknown$/i.test(String(action.entity)))) return null;
    if (action.action === 'add_resource' && (!action.resource || /^default$/i.test(String(action.resource)))) return null;
    if (action.action === 'show_floating_text' && (action.text == null || String(action.text) === 'undefined')) return null;
    return action;
  }

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
    if (t.type === 'cta_arrival') {
      t.ctaId = t.ctaId || t.entity || t.target || pickCtaEntityName() || 'CtaButton';
      delete t.entity;
      delete t.target;
    }
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
      if (!{ type: 1, entity: 1, ctaId: 1, resource: 1, amount: 1, count: 1, state: 1, range: 1, seconds: 1, operator: 1, triggers: 1 }[k]) {
        delete t[k];
      }
    });
  }

  (schema.phases || []).forEach(function(p, phaseIdx, allPhases) {
    if (!p || typeof p !== 'object') return;
    Object.keys(p).forEach(function(k) { if (!ALLOWED_PHASE_KEYS[k]) delete p[k]; });
    if (!p.guideText || typeof p.guideText !== 'string' || p.guideText.trim().length === 0) {
      p.guideText = (p.phaseId && bpGuideByPhase[p.phaseId]) || p.phaseId || ('Phase ' + (phaseIdx + 1));
    }
    normalizeTrigger(p.trigger, phaseIdx, allPhases.length, false);
    p.onEnter = (p.onEnter || []).map(normalizePhaseAction).filter(Boolean);
    p.onComplete = (p.onComplete || []).map(normalizePhaseAction).filter(Boolean);
  });

  if (Array.isArray(schema.phases) && Array.isArray(blueprintSpecs) && schema.phases.length < blueprintSpecs.length) {
    var padStart = schema.phases.length;
    var totalSpecs = blueprintSpecs.length;
    var schemaEntList = schema.entities || [];
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
        var fallbackEnt = pickPhaseFallbackEntity(null, pi, totalSpecs);
        if (pi === totalSpecs - 1) {
          derivedTrigger = { type: 'click_entity', entity: pickCtaEntityName() || 'CTAButton' };
        } else {
          derivedTrigger = { type: 'near_entity', entity: fallbackEnt || 'Player', range: 2 };
        }
      }
      schema.phases.push({
        phaseId: spec.phaseId || ('phase_' + (pi + 1)),
        showEntities: showEntsArr,
        hideEntities: [],
        guideText: bpGuideByPhase[spec.phaseId] || spec.shortDescription || spec.title || ('Phase ' + (pi + 1)),
        trigger: derivedTrigger,
        onEnter: [],
      });
    }
    schema.phases.forEach(function(p, idx, arr) { normalizeTrigger(p && p.trigger, idx, arr.length, false); });
  }

  if (schema.phases && schema.phases.length > 0) {
    var lastIdx = schema.phases.length - 1;
    var lastPhase = schema.phases[lastIdx];
    if (lastPhase && !isFinalCtaTrigger(lastPhase.trigger)) {
      var cta = pickCtaEntityName() || 'CTAButton';
      lastPhase.trigger = {
        type: 'compound',
        operator: 'and',
        triggers: [
          lastPhase.trigger || { type: 'near_entity', entity: cta, range: 2 },
          { type: 'near_entity', entity: cta, range: 2 },
        ],
      };
    }
  }

  if (schema.customLogic) {
    schema.customLogic = schema.customLogic.filter(function(x) { return typeof x === 'string'; });
  }
}

function _repairSchemaValidationErrors(schema, errors, ctx) {
  if (!schema || !Array.isArray(errors) || errors.length === 0) return 0;
  var repaired = 0;
  var entities = Array.isArray(schema.entities) ? schema.entities : [];
  var entityByName = {};
  for (var e = 0; e < entities.length; e++) {
    if (entities[e] && entities[e].name) entityByName[String(entities[e].name)] = entities[e];
  }
  var blueprintEntityByName = {};
  var blueprintEntities = ctx && ctx.blueprint && Array.isArray(ctx.blueprint.entities) ? ctx.blueprint.entities : [];
  for (var be = 0; be < blueprintEntities.length; be++) {
    if (blueprintEntities[be] && blueprintEntities[be].name) blueprintEntityByName[String(blueprintEntities[be].name)] = blueprintEntities[be];
  }
  if (!Array.isArray(schema.resources)) schema.resources = [];
  var resourceByName = {};
  for (var r = 0; r < schema.resources.length; r++) {
    if (schema.resources[r] && schema.resources[r].name) resourceByName[String(schema.resources[r].name)] = schema.resources[r];
  }

  function logFix(msg) {
    if (ctx && ctx.addLog) ctx.addLog('codegen-schema', 'repair: ' + msg);
  }

  function rewriteResourceTrigger(trigger, fromName, toName) {
    if (!trigger || typeof trigger !== 'object') return;
    if (trigger.type === 'compound' && Array.isArray(trigger.triggers)) {
      for (var t = 0; t < trigger.triggers.length; t++) {
        rewriteResourceTrigger(trigger.triggers[t], fromName, toName);
      }
      return;
    }
    if (trigger.type === 'resource_collected') {
      var resource = String(trigger.resource || '');
      if (resource === fromName || resource.trim() === toName) {
        trigger.resource = toName;
      }
    }
  }

  function isValidPoolName(pool) {
    return /^__Pool_[A-Z][a-z]+_[A-Z][a-z]+_\d{2}$/.test(String(pool || ''));
  }

  function ensureSchemaEntityFromBlueprint(name) {
    if (entityByName[name]) return entityByName[name];
    var source = blueprintEntityByName[name];
    if (!source) return null;
    var visual = source.visual || {};
    var pool = source.pool || source.poolName || source.template || '';
    if (!isValidPoolName(pool)) pool = '__Pool_Cube_White_01';
    var entity = {
      name: name,
      chineseName: source.chineseName || source.label || name,
      showLabel: inferEntityShowLabel(name),
      pool: pool,
      initPos: parseBlueprintInitPos(visual.position || source.initPos),
      scale: parseBlueprintScale(visual.scale || source.scale),
    };
    schema.entities.push(entity);
    entities = schema.entities;
    entityByName[name] = entity;
    return entity;
  }

  function ensureFallbackSchemaEntity(name) {
    if (entityByName[name]) return entityByName[name];
    var fromBlueprint = ensureSchemaEntityFromBlueprint(name);
    if (fromBlueprint) return fromBlueprint;
    var entity = {
      name: name,
      chineseName: name,
      showLabel: inferEntityShowLabel(name),
      pool: '__Pool_Cube_White_01',
      initPos: [0, 1, 0],
      scale: 0.5,
    };
    schema.entities.push(entity);
    entities = schema.entities;
    entityByName[name] = entity;
    return entity;
  }

  for (var i = 0; i < errors.length; i++) {
    var err = String(errors[i] || '');
    var m;

    m = err.match(/^\.entities\[(\d+)\]\.scale should be >= 0\.3$/);
    if (m && entities[parseInt(m[1], 10)]) {
      entities[parseInt(m[1], 10)].scale = 0.3;
      repaired++;
      logFix('clamped entities[' + m[1] + '].scale to 0.3');
      continue;
    }

    m = err.match(/^Phase (.+?) trigger resource_collected references non-existent resource: (.+)$/);
    if (m) {
      var phaseId = m[1];
      var rawName = String(m[2] || '');
      var resourceName = rawName.trim();
      if (resourceName) {
        if (!entityByName[resourceName]) {
          var beforeEntity = !!blueprintEntityByName[resourceName];
          ensureFallbackSchemaEntity(resourceName);
          logFix('added missing schema entity ' + resourceName + (beforeEntity ? ' from blueprint' : ' as fallback') + ' for resource trigger');
        }
        for (var p = 0; p < (schema.phases || []).length; p++) {
          rewriteResourceTrigger(schema.phases[p] && schema.phases[p].trigger, rawName, resourceName);
        }
        if (!resourceByName[resourceName]) {
          schema.resources.push({
            name: resourceName,
            entity: resourceName,
            convertRatio: 1,
          });
          resourceByName[resourceName] = schema.resources[schema.resources.length - 1];
        }
        repaired++;
        logFix('added resource ' + resourceName + ' bound to entity ' + resourceName + ' for phase ' + phaseId);
        continue;
      }
    }
  }

  return repaired;
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
