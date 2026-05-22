'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');

var assemblyStage = require('../engine/stages/assembly-plan.cjs');
var codegenSchemaStage = require('../engine/stages/codegen-schema.cjs');
var promptV3 = require('../engine/stages/build-schema-prompt-v3.cjs');

function withEnv(name, value, fn) {
  var prev = process.env[name];
  if (value == null) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (prev == null) delete process.env[name];
    else process.env[name] = prev;
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

var fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../fixtures/schema-codegen-with-html.json'),
  'utf8'
));

withEnv('SCHEMA_PROMPT_VERSION', null, function() {
  var ctx = clone(fixture);
  assert.strictEqual(codegenSchemaStage._internals.shouldUseSchemaPromptV3(ctx), true);
  var prompt = codegenSchemaStage._internals.buildSchemaPrompt(ctx);
  assert.strictEqual(ctx.blueprint.schemaPromptVersion, 'v3');
  assert.strictEqual(ctx.blueprint.schemaPromptHtmlSliceCount, 2);
  assert.ok(prompt.indexOf('## HTML 参考切片') >= 0, 'v3 prompt should include HTML slices');
  assert.ok(prompt.indexOf('spawnShockwave') >= 0, 'v3 prompt should preserve source HTML phase logic');
  assert.ok(prompt.indexOf('GFM_VisualGuide.Shockwave') >= 0, 'v3 prompt should include translation cheatsheet');
  assert.ok(prompt.indexOf('只输出 JSON 对象') >= 0, 'v3 prompt should keep JSON-only instruction');
});

withEnv('SCHEMA_PROMPT_VERSION', 'legacy', function() {
  var ctx = clone(fixture);
  var prompt = codegenSchemaStage._internals.buildSchemaPrompt(ctx);
  assert.strictEqual(ctx.blueprint.schemaPromptVersion, 'legacy');
  assert.ok(prompt.indexOf('## HTML 参考切片') < 0, 'legacy override should suppress HTML slice section');
});

withEnv('SCHEMA_PROMPT_VERSION', 'v3', function() {
  var ctx = {
    taskId: 'schema_prompt_v3_assembly',
    blueprint: {
      projectName: 'SchemaPromptV3Assembly',
      storyboard: {
        frames: [
          { title: 'Intro', interaction: 'move_to:ConveyorBelt', ui: '高亮传送带' },
          { title: 'Build', interaction: 'build:ConveyorBelt', ui: '金币+1飘字' },
        ],
      },
      entities: [
        {
          name: 'Player',
          label: '玩家',
          template: 'PlayerController',
          visual: { position: '(0,0,0)', scale: '1x1x1' },
        },
        {
          name: 'ConveyorBelt',
          label: '传送带',
          template: 'Buildable',
          visual: { position: '(1,0,1)', scale: '1x1x1' },
        },
      ],
      phases: [
        { id: 1, name: 'intro', activate: ['Player', 'ConveyorBelt'], guide: '靠近传送带' },
        { id: 2, name: 'build', activate: ['ConveyorBelt'], guide: '建造传送带' },
      ],
      specs: [
        { phaseId: 'intro', requiredInteractions: ['move_to:ConveyorBelt'] },
        { phaseId: 'build', requiredInteractions: ['build:ConveyorBelt'] },
      ],
    },
    addLog: function() {},
  };
  assemblyStage.execute(ctx);
  var prompt = codegenSchemaStage._internals.buildSchemaPrompt(ctx);
  assert.strictEqual(ctx.blueprint.schemaPromptVersion, 'v3');
  assert.ok(prompt.indexOf('## Assembly Plan（必须遵守）') >= 0, 'v3 prompt should keep assembly plan section');
  assert.ok(prompt.indexOf('"phaseBindings"') >= 0, 'v3 prompt should keep compact phase bindings');
  assert.ok(prompt.indexOf('"stateOwners"') >= 0, 'v3 prompt should keep state owners');
});

var longSlice = 'x'.repeat(promptV3.DEFAULT_SLICE_MAX_CHARS + 50);
withEnv('SCHEMA_PROMPT_VERSION', 'v3', function() {
  var ctx = {
    blueprint: {
      specs: [],
      entities: [],
      htmlPhaseSlices: { phase1: longSlice },
    },
  };
  var prompt = codegenSchemaStage._internals.buildSchemaPrompt(ctx);
  assert.ok(prompt.indexOf('truncated by schema prompt v3 slice budget') >= 0,
    'v3 prompt should cap oversized HTML phase slices');
});

console.log('codegen-schema prompt v3 tests passed');
