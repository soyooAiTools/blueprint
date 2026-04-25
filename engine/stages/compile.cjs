/**
 * Stage: compile — Bridge.NET build with auto-fix loop
 *
 * Reads: ctx.csCode, ctx.extraFiles, ctx.blueprint, ctx.workDir
 * Writes: ctx.htmlOutput, ctx.buildTime
 */

var fs = require('fs');
var path = require('path');
var helpers = require('../helpers.cjs');
var { recode } = require('../recode.cjs');
var { createFixLoop } = require('../fix-loop.cjs');
var config = require('../../lib/config.cjs');
var commentLocalizer = require('../../lib/csharp-comment-localizer.cjs');

var MAX_BUILD_FIX_ATTEMPTS = 5;
// Early exit if the build fails with the same error signature 3 rounds in a row —
// the AI is stuck on the same root cause, additional rounds will only burn tokens.
var SAME_BUILD_ERROR_EXIT = 3;

function localizeCompileInputs(csCode, extraFiles) {
  var localCtx = {
    csCode: String(csCode || ''),
    extraFiles: Object.assign({}, extraFiles || {}),
  };
  var stats = commentLocalizer.localizeContextCSharpComments(localCtx);
  return {
    changed: stats.changed,
    stats: stats,
    csCode: localCtx.csCode,
    extraFiles: localCtx.extraFiles,
  };
}

function collectBlueprintEntities(blueprint) {
  return blueprint && Array.isArray(blueprint.entities) ? blueprint.entities : [];
}

function resolvePoolPrefabLiteral(literal, blueprint) {
  var text = String(literal || '').trim();
  if (!text) return '';
  var entities = collectBlueprintEntities(blueprint);
  for (var i = 0; i < entities.length; i++) {
    if (entities[i] && String(entities[i].name || '') === text) return String(entities[i].name);
  }
  var lower = text.toLowerCase();
  for (var j = 0; j < entities.length; j++) {
    var entityName = String(entities[j] && entities[j].name || '');
    if (entityName && entityName.toLowerCase() === lower) return entityName;
  }
  if (lower === 'projectile') {
    for (var k = 0; k < entities.length; k++) {
      var behavior = entities[k] && entities[k].behavior || {};
      var projectile = String(behavior.projectile || '').trim();
      if (!projectile) continue;
      for (var p = 0; p < entities.length; p++) {
        if (entities[p] && String(entities[p].name || '') === projectile) return projectile;
      }
    }
    for (var m = 0; m < entities.length; m++) {
      var candidate = String(entities[m] && entities[m].name || '');
      if (/Bullet|Projectile|Arrow|Missile|Rocket/i.test(candidate)) return candidate;
    }
  }
  return '';
}

function rewriteStringPoolGets(code, blueprint) {
  if (!code || code.indexOf('GFM_Pool.Get("') < 0) {
    return { code: code, changed: false, fixes: 0 };
  }
  var fixes = 0;
  var fixed = String(code).replace(/GFM_Pool\.Get\s*\(\s*"([^"]+)"\s*\)/g, function(match, literal) {
    var resolved = resolvePoolPrefabLiteral(literal, blueprint);
    if (!resolved) return match;
    fixes++;
    return 'GFM_Pool.Get(' + resolved + ')';
  });
  return { code: fixed, changed: fixes > 0, fixes: fixes };
}

function resolveResourceAlias(alias, blueprint) {
  var text = String(alias || '').trim();
  if (!text) return '';
  var lower = text.toLowerCase();
  var resources = blueprint && Array.isArray(blueprint.resources) ? blueprint.resources : [];
  for (var i = 0; i < resources.length; i++) {
    var resourceName = String(resources[i] && resources[i].name || '');
    if (resourceName && resourceName.toLowerCase() === lower) return resourceName;
  }
  var entities = collectBlueprintEntities(blueprint);
  for (var j = 0; j < entities.length; j++) {
    var entityName = String(entities[j] && entities[j].name || '');
    if (entityName && entityName.toLowerCase() === lower) return entityName;
  }
  return '';
}

function rewriteLegacyScoreDisplayAliases(code, blueprint) {
  if (!code || code.indexOf('display += ') < 0) {
    return { code: code, changed: false, fixes: 0 };
  }
  var fixes = 0;
  var fixed = String(code).replace(
    /if\s*\(\s*([a-z][A-Za-z0-9_]*)\s*>\s*0\s*\)\s*display\s*\+=\s*("[^"]*")\s*\+\s*\1\s*;/g,
    function(match, alias, labelLiteral) {
      var canonical = resolveResourceAlias(alias, blueprint);
      if (!canonical || canonical === alias) return match;
      fixes++;
      return 'if (GetResource("' + canonical + '") > 0) display += ' + labelLiteral + ' + GetResource("' + canonical + '");';
    }
  );
  return { code: fixed, changed: fixes > 0, fixes: fixes };
}

function rewriteTypedComponentMemberAccess(code) {
  if (!code || code.indexOf('GetComponent(typeof(') < 0) {
    return { code: code, changed: false, fixes: 0 };
  }
  var fixes = 0;
  var fixed = String(code);
  fixed = fixed.replace(
    /((?:this|base|[A-Za-z_][A-Za-z0-9_]*)(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\.GetComponent\s*\(\s*typeof\(\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\)\s*\)\s+as\s+([A-Za-z_][A-Za-z0-9_.]*)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/g,
    function(_m, target, _typeExpr, castType, member) {
      fixes++;
      return '((' + castType + ')' + target + '.GetComponent(typeof(' + castType + '))).' + member;
    }
  );
  fixed = fixed.replace(
    /((?:this|base|[A-Za-z_][A-Za-z0-9_]*)(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\.GetComponent\s*\(\s*typeof\(\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\)\s*\)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/g,
    function(_m, target, typeName, member) {
      fixes++;
      return '((' + typeName + ')' + target + '.GetComponent(typeof(' + typeName + '))).' + member;
    }
  );
  return { code: fixed, changed: fixes > 0, fixes: fixes };
}

function stripUnresolvedPhaseInitArtifacts(code) {
  if (!code) {
    return { code: code, changed: false, fixes: 0 };
  }
  var fixes = 0;
  var fixed = String(code);
  fixed = fixed.replace(/^[ \t]*UnknownState\s*=\s*\d+\s*;\s*$/gm, function() {
    fixes++;
    return '        // stripped unresolved UnknownState write';
  });
  fixed = fixed.replace(/^[ \t]*AddResource\s*\(\s*"default"\s*,\s*[^;]+\);\s*$/gm, function() {
    fixes++;
    return '        // stripped unresolved default resource write';
  });
  fixed = fixed.replace(/ShowFloatingText\s*\(\s*player\.transform\.position\s*,\s*"undefined"\s*,/g, function() {
    fixes++;
    return 'ShowFloatingText(player.transform.position, "",';
  });
  return { code: fixed, changed: fixes > 0, fixes: fixes };
}

function applyDeterministicBuildRepairs(code, extraFiles, blueprint) {
  var methodCheck;
  try {
    methodCheck = require('./method-check.cjs');
  } catch (_err) {
    return { changed: false, code: code, extraFiles: extraFiles || {}, fixes: [] };
  }
  var repairCtx = {
    csCode: code,
    extraFiles: Object.assign({}, extraFiles || {}),
    blueprint: blueprint || {},
  };
  var fixes = [];
  if (methodCheck.autoRepairDuplicateStateFields && methodCheck.autoRepairDuplicateStateFields(repairCtx)) {
    fixes.push('DuplicateStateFields');
  }
  if (methodCheck.autoRepairDuplicateSimpleFields && methodCheck.autoRepairDuplicateSimpleFields(repairCtx)) {
    fixes.push('DuplicateSimpleFields');
  }
  if (methodCheck.autoRepairDuplicateObjectFields && methodCheck.autoRepairDuplicateObjectFields(repairCtx)) {
    fixes.push('DuplicateObjectFields');
  }
  if (methodCheck.autoRepairMissingSkeletonBridgeInfra && methodCheck.autoRepairMissingSkeletonBridgeInfra(repairCtx)) {
    fixes.push('MissingSkeletonBridgeInfra');
  }
  if (methodCheck.autoRepairMalformedIsNear && methodCheck.autoRepairMalformedIsNear(repairCtx)) {
    fixes.push('MalformedIsNear');
  }
  var mainPoolRepair = rewriteStringPoolGets(repairCtx.csCode, blueprint);
  if (mainPoolRepair.changed) {
    repairCtx.csCode = mainPoolRepair.code;
    fixes.push('StringPoolPrefabLiterals x' + mainPoolRepair.fixes);
  }
  var mainScoreRepair = rewriteLegacyScoreDisplayAliases(repairCtx.csCode, blueprint);
  if (mainScoreRepair.changed) {
    repairCtx.csCode = mainScoreRepair.code;
    fixes.push('LegacyScoreDisplayAlias x' + mainScoreRepair.fixes);
  }
  var mainComponentRepair = rewriteTypedComponentMemberAccess(repairCtx.csCode);
  if (mainComponentRepair.changed) {
    repairCtx.csCode = mainComponentRepair.code;
    fixes.push('TypedComponentMemberAccess x' + mainComponentRepair.fixes);
  }
  var mainPhaseArtifactRepair = stripUnresolvedPhaseInitArtifacts(repairCtx.csCode);
  if (mainPhaseArtifactRepair.changed) {
    repairCtx.csCode = mainPhaseArtifactRepair.code;
    fixes.push('UnresolvedPhaseInitArtifacts x' + mainPhaseArtifactRepair.fixes);
  }
  Object.keys(repairCtx.extraFiles || {}).forEach(function(name) {
    var next = repairCtx.extraFiles[name];
    var poolRepair = rewriteStringPoolGets(next, blueprint);
    if (poolRepair.changed) {
      next = poolRepair.code;
      fixes.push(name + ':StringPoolPrefabLiterals x' + poolRepair.fixes);
    }
    var scoreRepair = rewriteLegacyScoreDisplayAliases(next, blueprint);
    if (scoreRepair.changed) {
      next = scoreRepair.code;
      fixes.push(name + ':LegacyScoreDisplayAlias x' + scoreRepair.fixes);
    }
    var componentRepair = rewriteTypedComponentMemberAccess(next);
    if (componentRepair.changed) {
      next = componentRepair.code;
      fixes.push(name + ':TypedComponentMemberAccess x' + componentRepair.fixes);
    }
    var phaseArtifactRepair = stripUnresolvedPhaseInitArtifacts(next);
    if (phaseArtifactRepair.changed) {
      next = phaseArtifactRepair.code;
      fixes.push(name + ':UnresolvedPhaseInitArtifacts x' + phaseArtifactRepair.fixes);
    }
    repairCtx.extraFiles[name] = next;
  });
  return {
    changed: fixes.length > 0,
    code: repairCtx.csCode,
    extraFiles: repairCtx.extraFiles,
    fixes: fixes,
  };
}

module.exports = {
  name: 'compile',
  canRetry: false,
  assertBefore: function(ctx) {
    if (!ctx.csCode || ctx.csCode.length === 0) throw new Error('No C# code to compile');
  },
  execute: function(ctx) {
    ctx.addLog('compile', 'Starting Bridge.NET compilation...');
    var buildUrl = ctx.workerConfig.buildUrl;
    var lastCsCode = ctx.csCode;
    var lastExtraFiles = Object.assign({}, ctx.extraFiles);
    // Count by signature (not consecutive): catches A->B->A->B oscillation that the
    // old consecutive-match logic kept resetting on every flip. (P2-新2, 2026-04-15)
    var errSigCounts = {};

    var loop = createFixLoop({
      name: 'compile',
      maxRounds: MAX_BUILD_FIX_ATTEMPTS,
      onExhausted: 'throw',
      beforeRound: function(ctx, round, maxRounds) {
        var label = round === 1 ? '' : ' (fix attempt ' + (round - 1) + '/' + maxRounds + ')';
        ctx.reportStatus('building', { message: '[Linux] Bridge.NET compiling...' + label });
      },
      attempt: function(ctx, round, maxRounds) {
        var deterministicRepair = applyDeterministicBuildRepairs(lastCsCode, lastExtraFiles, ctx.blueprint);
        if (deterministicRepair.changed) {
          lastCsCode = deterministicRepair.code;
          lastExtraFiles = deterministicRepair.extraFiles;
          ctx.addLog('compile', 'Deterministic pre-build repair applied: ' + deterministicRepair.fixes.join(', '));
        }
        var localized = localizeCompileInputs(lastCsCode, lastExtraFiles);
        if (localized.changed) {
          lastCsCode = localized.csCode;
          lastExtraFiles = localized.extraFiles;
          ctx.addLog('compile', 'Localized C# comments before build: ' +
            localized.stats.localizedComments + ' comment(s) in ' +
            localized.stats.changedFiles + '/' + localized.stats.files + ' file(s)');
        }
        return helpers.buildRequest(buildUrl, '/build', lastCsCode, lastExtraFiles)
          .catch(function(e) { return { ok: false, error: e.message }; })
          .then(function(buildResult) {
            if (buildResult.ok) {
              ctx.addLog('compile', 'Build OK in ' + buildResult.buildTime + 's');
              ctx.csCode = lastCsCode;
              ctx.extraFiles = lastExtraFiles;
              ctx.buildTime = buildResult.buildTime;

              return helpers.buildRequest(buildUrl, '/build-html', lastCsCode, lastExtraFiles)
                .then(function(htmlData) {
                  if (!htmlData || htmlData.length < 10240) {
                    throw new Error('HTML output too small (' + (htmlData ? htmlData.length : 0) + ' bytes) — likely empty build');
                  }
                  ctx.htmlOutput = htmlData;
                  ctx.addLog('compile', 'HTML: ' + (htmlData.length / 1048576).toFixed(1) + 'MB');

                  // Persist C# source for SVN/git archival
                  try {
                    var sourcesDir = path.join(config.SOURCES_DIR, ctx.taskId);
                    fs.mkdirSync(sourcesDir, { recursive: true });
                    fs.writeFileSync(path.join(sourcesDir, 'GameFlowManagerMain.cs'), lastCsCode, 'utf-8');
                    var efKeys = Object.keys(lastExtraFiles);
                    for (var ei = 0; ei < efKeys.length; ei++) {
                      fs.writeFileSync(path.join(sourcesDir, efKeys[ei]), lastExtraFiles[efKeys[ei]], 'utf-8');
                    }
                    ctx.addLog('compile', 'C# source saved to project-sources/' + ctx.taskId);
                  } catch(saveErr) {
                    ctx.addLog('compile', 'WARN: Failed to save C# source: ' + saveErr.message);
                  }

                  return { done: true, result: { ok: true, buildTime: buildResult.buildTime, htmlSize: htmlData.length } };
                });
            }

            var buildError = buildResult.error || '';
            ctx.addLog('compile', 'Build failed: ' + buildError.slice(0, 1000));

            // Same-error early exit: signature on first ~200 chars of error.
            // CS error codes (e.g. "CS0117") plus the offending identifier are typically captured here.
            // We count occurrences across ALL rounds (not just consecutive), so an A->B->A->B
            // oscillation also trips the gate once either signature reaches the threshold.
            var errSig = buildError.slice(0, 200);
            if (errSig) {
              errSigCounts[errSig] = (errSigCounts[errSig] || 0) + 1;
              if (errSigCounts[errSig] >= SAME_BUILD_ERROR_EXIT) {
                throw new Error('Build failed with same error ' + errSigCounts[errSig] + ' times across rounds — stopping (saves token budget): ' + errSig.slice(0, 160));
              }
            }

            if (round >= maxRounds) {
              throw new Error('Build failed after ' + maxRounds + ' fix attempts: ' + buildError.slice(0, 200));
            }

            ctx.addLog('compile', 'AI fixing build error (' + round + '/' + maxRounds + ')...');
            ctx.reportStatus('processing', { message: '[Linux] Build failed, AI fixing... (' + round + '/' + maxRounds + ')' });

            if (!ctx.blueprint.feedbackHistory) ctx.blueprint.feedbackHistory = [];
            ctx.blueprint.feedbackHistory.push({
              data: { text: 'Build compilation failed:\n' + buildError.slice(0, 1500) + '\nPlease fix the C# compilation errors.' },
              source: 'build-fix-attempt-' + round,
              status: 'pending',
              timestamp: Date.now(),
            });

            return recode({
              taskId: ctx.taskId,
              currentCode: lastCsCode,
              extraFiles: lastExtraFiles,
              blueprint: ctx.blueprint,
              label: 'buildfix',
              round: round,
              log: function(msg) { ctx.addLog('compile', msg); },
            }).then(function(result) {
              if (result.ok) {
                lastCsCode = result.code;
                // Pick up partial class files (e.g. Systems.cs) from recode
                if (result.extraFiles) {
                  for (var efn in result.extraFiles) {
                    if (result.extraFiles.hasOwnProperty(efn)) {
                      lastExtraFiles[efn] = result.extraFiles[efn];
                    }
                  }
                }
                ctx.addLog('compile', 'Build fix ' + round + ': got fixed code (' + lastCsCode.length + ' chars)');
              } else {
                ctx.addLog('compile', 'Build fix re-code failed: ' + result.error);
              }
              return { done: false };
            });
          });
      },
    });

    return loop.run(ctx);
  },
  _applyDeterministicBuildRepairs: applyDeterministicBuildRepairs,
};
