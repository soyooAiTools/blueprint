'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');

var schemaPrompt = require('../engine/stages/build-schema-prompt-v3.cjs');
var promptV4 = require('../worker/prompt-v4.js');
var promptV5 = require('../worker/prompt-v5-basetemplate.js');

var blueprint = {
  projectName: 'PromptContract',
  entities: [
    { name: 'Player', template: 'PlayerController', visual: { position: '(0,0,0)' } },
    { name: 'Crate', template: 'Static', visual: { position: '(1,0,0)' } },
  ],
  specs: [
    {
      phaseId: 'collectCrate',
      phaseName: '收集箱子',
      playerInstruction: '拖动角色靠近箱子',
      requiredInteractions: ['move_to:Crate'],
      entitiesRequired: [{ entity: 'Crate' }],
    },
  ],
};

function assertDeliveryContract(text, label) {
  assert.ok(text.indexOf('AIBridge/MCP') >= 0, label + ' should mention AIBridge/MCP hydration');
  assert.ok(text.indexOf('Inspector') >= 0, label + ' should mention Inspector hydration');
  assert.ok(text.indexOf('mBindings') >= 0, label + ' should mention mBindings as the binding table');
  assert.ok(text.indexOf('逻辑与表现分离') >= 0, label + ' should require logic/visual separation');
  assert.ok(text.indexOf('注释只写关键') >= 0, label + ' should require sparse plain Chinese comments');
}

var schemaText = schemaPrompt.buildSchemaPromptV3({ blueprint: blueprint });
var v5Text = promptV5.parseBlueprintToPromptV5(blueprint);
var v4Text = promptV4.parseBlueprintToPromptV4(blueprint);
var lunaCodexText = fs.readFileSync(path.join(__dirname, '../worker/luna-codex-code.md'), 'utf8');
var behaviorTemplateText = fs.readFileSync(path.join(__dirname, '../worker/behavior-templates.md'), 'utf8');
var workerCoderText = fs.readFileSync(path.join(__dirname, '../worker/worker-coder.js'), 'utf8');

assertDeliveryContract(schemaText, 'schema prompt contract');
assertDeliveryContract(v5Text, 'v5 prompt');
assertDeliveryContract(v4Text, 'v4 prompt');
assertDeliveryContract(lunaCodexText, 'luna codex prompt');
assertDeliveryContract(workerCoderText, 'worker coder prompt');

assert.ok(v5Text.indexOf('GameSceneCtrl.instance.Get') >= 0, 'v5 prompt should show binding-based object access');
assert.ok(v5Text.indexOf('不要在 TODO 区') >= 0 && v5Text.indexOf('GameObject.Find("__Pool_*")') >= 0,
  'v5 prompt should forbid business TODO Find fallback');
assert.ok(v4Text.indexOf('只有 V4 staging 绑定层才可兜底解析 `__Pool_*`') >= 0, 'v4 prompt should fence legacy pool lookup to staging binding');
assert.ok(behaviorTemplateText.indexOf('本文件只给 Luna/WebGL staging 代码参考') >= 0, 'behavior templates should be marked staging-only');

assert.strictEqual(v5Text.indexOf('每个字段声明都必须有详细中文注释'), -1, 'v5 prompt must not require field-by-field boilerplate comments');
assert.strictEqual(v5Text.indexOf('每个方法都必须有详细中文注释'), -1, 'v5 prompt must not require method-by-method boilerplate comments');
assert.strictEqual(v4Text.indexOf('每个字段、每个方法、每个条件分支都必须写详细注释'), -1, 'v4 prompt must not require boilerplate comments everywhere');
assert.strictEqual(lunaCodexText.indexOf('`GameObject.Find("名称")` 获取对象引用'), -1, 'luna codex prompt must not teach direct object Find as the default');

console.log('unity codegen prompt contract tests passed');
