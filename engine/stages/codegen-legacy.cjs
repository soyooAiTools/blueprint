/**
 * Stage: codegen — AI code generation via the unified Codex worker entry.
 *
 * Reads: ctx.blueprint, ctx.workDir
 * Writes: ctx.csCode
 */

var fs = require('fs');
var path = require('path');
var helpers = require('../helpers.cjs');
var { createFixLoop } = require('../fix-loop.cjs');
var { getProjectBlockingIssues } = require('../static-check.cjs');
var loadInjectablePromotedRules = require('../../worker/code-reviewer.js').loadInjectablePromotedRules;

module.exports = {
  name: 'codegen',
  canRetry: false,
  execute: function(ctx) {
    ctx.addLog('codegen', 'Generating code...');
    if (ctx.reportStatus) {
      ctx.reportStatus('processing', { message: '[Linux] AI coding...' });
    }

    var codexCoder;
    try { codexCoder = require('../../worker/codex-coder.js'); } catch(e) { ctx.addLog('codegen', 'codex-coder.js not loaded: ' + e.message); }

    var generator = codexCoder && codexCoder.generateWithCodex;
    if (!generator) {
      return Promise.reject(new Error('No code generator available (worker/codex-coder.js)'));
    }
    ctx.addLog('codegen', 'Using Codex worker entry');

    var logFn = function(msg) { ctx.addLog('codegen', msg); };

    // Resolve entity names to pool objects before codegen
    if (ctx.blueprint.specs && ctx.blueprint.specs.length > 0) {
      try {
        var entityResolver = require('../../adapters/entity-resolver.cjs');
        var resolution = entityResolver.resolveEntities(ctx.blueprint.specs, ctx.blueprint.entities || []);
        ctx.blueprint.specs = resolution.resolvedSpecs;
        if (!ctx.blueprint.entityPoolMap) ctx.blueprint.entityPoolMap = {};
        for (var ek in resolution.entityPoolMap) {
          ctx.blueprint.entityPoolMap[ek] = resolution.entityPoolMap[ek];
        }
        ctx.addLog('codegen', 'Entity resolution: ' + Object.keys(resolution.entityPoolMap).length + ' entities mapped to pool objects');
      } catch(resolveErr) {
        ctx.addLog('codegen', 'Entity resolution skipped: ' + resolveErr.message);
      }
    }

    // Resolve gameplay mechanics for each spec's interactions
    if (ctx.blueprint.specs && ctx.blueprint.specs.length > 0) {
      try {
        var mechanicsResolver = require('../../adapters/mechanics-resolver.cjs');
        ctx.blueprint.specs = mechanicsResolver.resolveMechanics(ctx.blueprint.specs);
        var mechanicsDoc = mechanicsResolver.buildMechanicsDoc(ctx.blueprint.specs);
        ctx.blueprint.mechanicsText = mechanicsDoc;
        ctx.addLog('codegen', 'Mechanics resolution: generated implementation hints for all interactions');
      } catch(mechErr) {
        ctx.addLog('codegen', 'Mechanics resolution skipped: ' + mechErr.message);
      }
    }

    // Inject structured specs into blueprint so AI has explicit phase graph
    if (ctx.blueprint.specs && ctx.blueprint.specs.length > 0) {
      ctx.addLog('codegen', 'Injecting ' + ctx.blueprint.specs.length + ' phase specs as structured state machine');
      // Build explicit state machine definition from specs
      var phaseGraph = ctx.blueprint.specs.map(function(spec, i) {
        var nextPhaseId = (i + 1 < ctx.blueprint.specs.length) ? ctx.blueprint.specs[i + 1].phaseId : 'CTA';
        return {
          phaseId: spec.phaseId,
          phaseName: spec.phaseName,
          order: i + 1,
          duration: spec.duration,
          requiredInteractions: spec.requiredInteractions || [],
          triggerCondition: spec.triggerNext ? spec.triggerNext.condition : '',
          triggerDescription: spec.triggerNext ? spec.triggerNext.description : '',
          entities: spec.entitiesRequired || [],
          nextPhase: nextPhaseId,
          playerMustAct: spec.playerMustAct !== false,
          autoAllowed: spec.autoAllowed === true,
        };
      });
      // Inject as explicit state machine — this overrides the empty nodes/edges
      ctx.blueprint.phaseStateMachine = phaseGraph;
      // Also add as plaintext instruction so all generators can understand it
      var smInstructions = '\n\n=== PHASE STATE MACHINE (MUST IMPLEMENT EXACTLY) ===\n';
      smInstructions += 'Total phases: ' + phaseGraph.length + '\n\n';
      for (var si = 0; si < phaseGraph.length; si++) {
        var pg = phaseGraph[si];
        smInstructions += 'Phase ' + pg.order + ': ' + pg.phaseId + ' (' + pg.phaseName + ')\n';
        smInstructions += '  Duration: ' + pg.duration.min + '-' + pg.duration.max + 's\n';
        if (pg.requiredInteractions.length > 0) {
          smInstructions += '  Required: ' + pg.requiredInteractions.join(', ') + '\n';
        }
        if (pg.triggerCondition) {
          smInstructions += '  Trigger next: ' + pg.triggerCondition + ' (' + pg.triggerDescription + ')\n';
        }
        if (pg.entities.length > 0) {
          smInstructions += '  Entities: ' + pg.entities.map(function(e) { return e.name + ' → state ' + e.terminalState; }).join(', ') + '\n';
        }
        smInstructions += '  Next → ' + pg.nextPhase + '\n\n';
      }
      smInstructions += 'IMPORTANT: Every phase must be implemented. Phase transitions must use the exact trigger conditions above.\n';
      smInstructions += 'The final phase must call Luna.Unity.Playable.InstallFullGame() for CTA.\n';

      // Append to description or create dedicated field
      if (!ctx.blueprint.phaseStateMachineText) {
        ctx.blueprint.phaseStateMachineText = smInstructions;
      }
    } else {
      ctx.addLog('codegen', 'No specs found — AI will generate phases from storyboard narrative');
    }

    // Task #16: Inject promoted rules into codegen — tiered by severity
    // critical = all injected, warning = top 10 by frequency, info = skipped
    try {
      var promotedRules = loadInjectablePromotedRules();
      if (promotedRules.length > 0) {
        var criticalRules = promotedRules.filter(function(r) { return r.severity === 'critical'; });
        var warningRules = promotedRules.filter(function(r) { return r.severity === 'warning' || !r.severity; });
        // Sort warnings by frequency (totalOccurrences desc)
        warningRules.sort(function(a, b) { return (b.totalOccurrences || 0) - (a.totalOccurrences || 0); });
        var topWarnings = warningRules.slice(0, 10);

        var rulesText = '';
        if (criticalRules.length > 0) {
          rulesText += '\n\n=== CRITICAL PITFALLS (all injected, must avoid) ===\n';
          for (var cri = 0; cri < criticalRules.length; cri++) {
            rulesText += '- ' + criticalRules[cri].description + ' — FIX: ' + (criticalRules[cri].fix || 'see rule') + '\n';
          }
        }
        if (topWarnings.length > 0) {
          rulesText += '\n=== WARNING PITFALLS (top ' + topWarnings.length + ' by frequency) ===\n';
          for (var wri = 0; wri < topWarnings.length; wri++) {
            rulesText += '- ' + topWarnings[wri].description + ' — FIX: ' + (topWarnings[wri].fix || 'see rule') + '\n';
          }
        }
        if (rulesText && !ctx.blueprint.promotedRulesText) {
          ctx.blueprint.promotedRulesText = rulesText;
          ctx.addLog('codegen', 'Injected promoted rules: ' + criticalRules.length + ' critical (all), ' + topWarnings.length + '/' + warningRules.length + ' warnings (top by freq)');
        }
      }
    } catch(e) {
      // No promoted rules file — that's fine
    }

    var loop = createFixLoop({
      name: 'codegen',
      maxRounds: 4,
      onExhausted: 'throw',
      beforeRound: function(ctx, round, maxRounds) {
        if (round > 1) {
          ctx.reportStatus('processing', { message: '[Linux] AI coding retry (' + round + '/' + maxRounds + ')...' });
        }
      },
      attempt: function(ctx, round) {
        return generator(ctx.blueprint, ctx.workDir, logFn, ctx.taskId, 'unity').then(function(result) {
          if (!result.ok) {
            throw new Error('AI coding failed: ' + (result.error || '').slice(0, 200));
          }

          ctx.addLog('codegen', 'AI coding done: ' + result.filesWritten + ' files');

          // Find generated GameFlowManagerMain.cs
          var allCs = helpers.findFiles(ctx.workDir, '.cs');
          var mainCsPath = null;
          for (var i = 0; i < allCs.length; i++) {
            if (allCs[i].indexOf('GameFlowManagerMain.cs') !== -1) {
              mainCsPath = allCs[i];
              break;
            }
          }

          if (!mainCsPath) {
            throw new Error('No GameFlowManagerMain.cs generated. Found: ' + allCs.join(', '));
          }

          ctx.csCode = fs.readFileSync(mainCsPath, 'utf-8');
          // Also collect partial class files (multi-file support)
          var partialFiles = ['GameFlowManagerMain.Systems.cs'];
          for (var pfi = 0; pfi < partialFiles.length; pfi++) {
            for (var pci = 0; pci < allCs.length; pci++) {
              if (allCs[pci].indexOf(partialFiles[pfi]) !== -1) {
                if (!ctx.extraFiles) ctx.extraFiles = {};
                ctx.extraFiles[partialFiles[pfi]] = fs.readFileSync(allCs[pci], 'utf-8');
                ctx.addLog('codegen', 'Collected partial class: ' + partialFiles[pfi]);
              }
            }
          }
          ctx.addLog('codegen', 'Main CS: ' + mainCsPath + ' (' + ctx.csCode.length + ' chars)');

          // Blocking static-check gate: reject rounds with black-screen-causing API usage
          // BEFORE advancing to compile. Covers create-obj, create-ground, set-color,
          // instantiate, destroy, new-material, setactive, etc. Adding this check here
          // (in addition to review stage) gives us a cheap early-out and feeds specific
          // lines back to the generator on the next round (2026-04-15 bqh33t fix).
          var allBlocking = getProjectBlockingIssues(ctx.csCode, { extraFiles: ctx.extraFiles, blueprint: ctx.blueprint });
          if (allBlocking.length > 0) {
            var blockSummary = allBlocking.slice(0, 10).map(function(i) {
              return (i.file ? i.file + ' ' : '') + 'L' + i.line + ': ' + i.message + ' — ' + i.text;
            }).join('\n');
            ctx.addLog('codegen', 'Blocking static violations (' + allBlocking.length + ') — failing round to force retry:\n' + blockSummary);
            // Inject as feedback so the next round's AI prompt knows what to fix
            if (!ctx.blueprint.feedbackHistory) ctx.blueprint.feedbackHistory = [];
            ctx.blueprint.feedbackHistory.push({
              data: { text: 'BLOCKING STATIC VIOLATIONS (fix all before retry — these produce dead/invisible playables: black screen, visual freeze, or non-interactive game):\n' + blockSummary },
              source: 'codegen-static-block',
              status: 'pending',
              timestamp: Date.now(),
            });
            throw new Error('Blocking static violations: ' + allBlocking.length + ' (first: ' + allBlocking[0].message + ')');
          }

          if (ctx.reportStatus) {
            ctx.reportStatus('processing', { message: '[Linux] AI coding done (' + result.filesWritten + ' files), building...' });
          }

          // Phase completion detection: verify generated code covers all blueprint phases
          var phaseDetection = { expectedPhases: 0, implementedPhases: 0, missing: [] };
          if (ctx.blueprint.specs && ctx.blueprint.specs.length > 0) {
            phaseDetection.expectedPhases = ctx.blueprint.specs.length;
            for (var pi = 0; pi < ctx.blueprint.specs.length; pi++) {
              var phaseId = ctx.blueprint.specs[pi].phaseId;
              if (ctx.csCode.indexOf('"' + phaseId + '"') >= 0 || ctx.csCode.indexOf("'" + phaseId + "'") >= 0) {
                phaseDetection.implementedPhases++;
              } else {
                phaseDetection.missing.push(phaseId);
              }
            }
            if (phaseDetection.missing.length > 0) {
              ctx.addLog('codegen', 'WARNING: ' + phaseDetection.missing.length + '/' + phaseDetection.expectedPhases +
                ' phases not found in code: ' + phaseDetection.missing.join(', '));
              if (!ctx.blueprint.feedbackHistory) ctx.blueprint.feedbackHistory = [];
              ctx.blueprint.feedbackHistory.push({
                data: { text: 'PHASE COVERAGE GAP: Code is missing implementation for phases: ' + phaseDetection.missing.join(', ') +
                  '. Expected ' + phaseDetection.expectedPhases + ' phases but only found ' + phaseDetection.implementedPhases + ' in code.' },
                source: 'codegen-phase-check',
                status: 'pending',
                timestamp: Date.now(),
              });
            } else {
              ctx.addLog('codegen', 'Phase coverage: ' + phaseDetection.implementedPhases + '/' + phaseDetection.expectedPhases + ' phases found in code');
            }
          }

          var ruleCount = (ctx.csCode.match(/ruleTriggered\[/g) || []).length;
          var addPhaseCount = (ctx.csCode.match(/AddCompletedPhase/g) || []).length;
          ctx.addLog('codegen', 'Code metrics: ' + ruleCount + ' rule references, ' + addPhaseCount + ' AddCompletedPhase calls');

          // P0-3: Sync spec-data back to ctx.blueprint.specs if they diverged
          // This ensures review/conformance checks use the same phaseIds as the generated code
          try {
            var specDataPath = path.join(__dirname, '..', '..', 'spec-data', ctx.taskId, 'specs.json');
            if (fs.existsSync(specDataPath)) {
              var specDataSpecs = JSON.parse(fs.readFileSync(specDataPath, 'utf8'));
              if (specDataSpecs && specDataSpecs.length > 0) {
                // Check if spec-data phaseIds match blueprint.specs phaseIds
                var dbIds = (ctx.blueprint.specs || []).map(function(s) { return s.phaseId; }).sort().join(',');
                var dataIds = specDataSpecs.map(function(s) { return s.phaseId; }).sort().join(',');
                if (dbIds !== dataIds) {
                  ctx.addLog('codegen', 'Spec sync: spec-data phaseIds differ from blueprint.specs — updating blueprint to match code');
                  ctx.blueprint.specs = specDataSpecs;
                }
              }
            }
          } catch(syncErr) {
            ctx.addLog('codegen', 'Spec sync check failed (non-fatal): ' + syncErr.message);
          }

          return { done: true, result: { filesWritten: result.filesWritten, csLength: ctx.csCode.length, phaseDetection: phaseDetection } };
        });
      },
    });

    return loop.run(ctx);
  },
};
