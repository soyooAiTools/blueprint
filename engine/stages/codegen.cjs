/**
 * Stage: codegen — AI code generation (Claude Code or generateCodeV5)
 *
 * Reads: ctx.blueprint, ctx.workDir
 * Writes: ctx.csCode
 */

var fs = require('fs');
var path = require('path');
var helpers = require('../helpers.cjs');

module.exports = {
  name: 'codegen',
  canRetry: true,
  maxRetries: 4,
  execute: function(ctx) {
    ctx.addLog('codegen', 'Generating code...');
    if (ctx.reportStatus) {
      ctx.reportStatus('processing', { message: '[Linux] AI coding...' });
    }

    var USE_CLAUDE_CODE = process.env.USE_CLAUDE_CODE !== 'false';
    var coder, claudeCoder;
    try { coder = require('../../worker/worker-coder.js'); } catch(e) {}
    try { claudeCoder = require('../../worker/claude-code-coder.js'); } catch(e) {}

    var generator;
    if (USE_CLAUDE_CODE && claudeCoder && claudeCoder.generateWithClaudeCode) {
      generator = claudeCoder.generateWithClaudeCode;
      ctx.addLog('codegen', 'Using Claude Code mode');
    } else if (coder && coder.generateCodeV5) {
      generator = coder.generateCodeV5;
      ctx.addLog('codegen', 'Using generateCodeV5 mode');
    } else {
      return Promise.reject(new Error('No code generator available (worker-coder.js / claude-code-coder.js)'));
    }

    var logFn = function(msg) { ctx.addLog('codegen', msg); };

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
      ctx.addLog('codegen', 'Main CS: ' + mainCsPath + ' (' + ctx.csCode.length + ' chars)');

      if (ctx.reportStatus) {
        ctx.reportStatus('processing', { message: '[Linux] AI coding done (' + result.filesWritten + ' files), building...' });
      }

      return { filesWritten: result.filesWritten, csLength: ctx.csCode.length };
    });
  },
};
