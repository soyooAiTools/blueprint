#!/usr/bin/env node
'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var crypto = require('crypto');

var pipelineMod = require('../engine/pipeline.cjs');
var sourceSceneIr = require('../engine/source-scene-ir.cjs');

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function readLineCount(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).length;
}

function withEnv(updates, fn) {
  var previous = {};
  Object.keys(updates).forEach(function(key) {
    previous[key] = process.env[key];
    process.env[key] = updates[key];
  });
  return Promise.resolve().then(fn).finally(function() {
    Object.keys(updates).forEach(function(key) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    });
  });
}

function makeSourceIrHtml(taskId, htmlPath) {
  var rawIr = {
    schemaVersion: 'source-scene-ir.v1',
    kind: 'blueprint.sourceSceneIR',
    project: { name: taskId, theme: 'smoke' },
    scene: {
      backgroundColor: '#101820',
      camera: { position: [0, 8, 12], lookAt: [0, 0, 0], fov: 55 },
      ground: { kind: 'plane', size: [20, 20], color: '#203040' },
    },
    entities: [
      { id: 'Player', label: 'Player', kind: 'player', position: [0, 0, 0], visual: { primitive: 'capsule', color: '#66ccff' } },
      { id: 'Gem', label: 'Gem', kind: 'resource', position: [3, 0, 0], visual: { primitive: 'sphere', color: '#33aaff' } },
      { id: 'CtaButton', label: 'Install', kind: 'cta', position: [6, 0, 0], visual: { primitive: 'box', color: '#22cc88' } },
    ],
    resources: [{ id: 'GemCount', label: 'Gems', carrierEntity: 'Gem', kind: 'resource', initial: 0 }],
    phases: [
      {
        id: 'phase1',
        title: 'Collect gems',
        guideText: 'Drag the joystick to collect the gem',
        showEntities: ['Player', 'Gem'],
        plannedModuleIds: ['player_input_joystick', 'move_to_target', 'collect_on_near', 'inventory_wallet'],
        steps: [
          { kind: 'move_to', target: 'Gem', radius: 1.2 },
          { kind: 'collect', resource: 'GemCount', amount: 1, from: 'Gem' },
        ],
        gate: { kind: 'resource', resource: 'GemCount', threshold: 1 },
      },
      {
        id: 'phase2',
        title: 'Install',
        guideText: 'Reach the button to install',
        showEntities: ['Player', 'CtaButton'],
        plannedModuleIds: ['player_input_joystick', 'move_to_target', 'cta_finish'],
        steps: [{ kind: 'cta_finish', entity: 'CtaButton' }],
        gate: { kind: 'cta_arrival', entity: 'CtaButton' },
      },
    ],
    hud: { tip: { source: 'phase.guideText' }, resourceBar: ['GemCount'], cta: { entity: 'CtaButton', arrivalGated: true } },
    runtimeContract: { requiresJoystick: true, requiresArrivalGate: true, forbidAutoplayProgress: true },
  };
  var ir = sourceSceneIr.normalizeSourceSceneIr(rawIr, {
    sourceHtmlPath: htmlPath,
    html: '',
    generatedAt: '2026-06-08T00:00:00.000Z',
  });
  return [
    '<!doctype html><html><head><meta charset="utf-8"><title>SourceIR no LLM</title></head><body>',
    '<script>',
    'window.__BP_SOURCE_IR__ = ' + JSON.stringify(ir) + ';',
    'window.__BP_SOURCE_IR_HASH__ = "' + ir.semanticHash + '";',
    '</script>',
    '</body></html>',
  ].join('\n');
}

function run() {
  return withEnv({
    NO_LLM_HOT_PATH: 'enforce',
    BLUEPRINT_SOURCE_IR_AUTOPREBUILD: '1',
    SOURCE_HTML_BIND_HARD: '1',
  }, function() {
    var taskId = 'source-ir-pipeline-no-llm-test';
    var tmp = fs.mkdtempSync(path.join(os.tmpdir(), taskId + '-'));
    var htmlPath = path.join(tmp, 'source-ir.html');
    var html = makeSourceIrHtml(taskId, htmlPath);
    fs.writeFileSync(htmlPath, html);
    var htmlSha = sha256(html);
    var metricsFile = path.join(__dirname, '..', 'server-data', 'metrics', 'pipeline-metrics.jsonl');
    var metricLinesBefore = readLineCount(metricsFile);

    var ctx = new pipelineMod.PipelineContext({
      id: taskId,
      taskId: taskId,
      adapter: 'storyboard2html',
      sourceHtmlPath: htmlPath,
      sourceHtmlSha256: htmlSha,
      blueprint: {
        projectName: taskId,
        storyboard2html: true,
        sourcePipeline: 'storyboard2html-source-ir',
        sourceHtmlPath: htmlPath,
        sourceHtmlSha256: htmlSha,
      },
    }, {}, {
      workerId: 'local-test',
      baseUrl: 'http://127.0.0.1:9',
      buildUrl: 'http://127.0.0.1:9',
    });

    var logs = [];
    ctx.addLog = function(stage, message) {
      logs.push(stage + ': ' + message);
    };
    ctx.reportStatus = function() {};

    var p = new pipelineMod.Pipeline([
      pipelineMod.stages.sourceHtmlBind,
      pipelineMod.stages.specExtract,
      pipelineMod.stages.specValidate,
      pipelineMod.stages.complexityGate,
      pipelineMod.stages.assemblyPlan,
      pipelineMod.stages.assemblyComplexityGate,
      pipelineMod.stages.codegen,
      pipelineMod.stages.methodCheck,
      pipelineMod.stages.review,
    ], { maxRetries: 1, recordMetrics: false });

    return p.run(ctx).then(function() {
      assert.deepStrictEqual(ctx.completedStages, [
        'source-html-bind',
        'spec-validate',
        'complexity-gate',
        'assembly-plan',
        'assembly-complexity-gate',
        'codegen',
        'method-check',
        'review',
      ]);
      assert.ok((ctx._skippedStages || []).some(function(stage) {
        return stage.name === 'spec-extract';
      }), 'spec-extract should skip because SourceIR prebuilt specs are reusable');
      assert.strictEqual(ctx.blueprint.sourceIrAutoPrebuilt, true);
      assert.strictEqual(ctx.blueprint.schemaSource, 'source-scene-ir');
      assert.strictEqual(ctx.blueprint.prebuiltGameSchema, true);
      assert.strictEqual(ctx.blueprint.prebuiltGameSchemaUsed, true);
      assert.strictEqual(ctx.blueprint.schemaTokensIn, 0);
      assert.strictEqual(ctx.blueprint.schemaTokensOut, 0);
      assert.strictEqual(ctx.blueprint.customLogicRounds || 0, 0);
      assert.strictEqual(ctx.blueprint.customLogicTokensIn || 0, 0);
      assert.strictEqual(ctx.blueprint.assemblyDecision, 'assembly_ready');
      assert.strictEqual(ctx.blueprint.assemblyCoverage, 1);
      assert.strictEqual(ctx.blueprint.assemblyImplementationCoverage, 1);
      assert.strictEqual(ctx.blueprint.todoSectionsRemaining, 0);
      assert.strictEqual(ctx.blueprint.noLlmHotPath, undefined);
      assert.ok(logs.some(function(line) {
        return /Using prebuilt gameSchema/.test(line);
      }), 'codegen should log that schema LLM was skipped');
      assert.ok(logs.some(function(line) {
        return /Deterministic review gate passed/.test(line);
      }), 'review should skip the Codex reviewer through the deterministic gate');
      assert.strictEqual(readLineCount(metricsFile), metricLinesBefore, 'recordMetrics:false must not append pipeline metrics');
    });
  });
}

run().then(function() {
  console.log('source-ir pipeline no-LLM test passed');
}).catch(function(err) {
  console.error(err && err.stack || err);
  process.exit(1);
});
