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
  assert.ok(text.indexOf('隐藏运行时对象表') >= 0, label + ' should forbid hidden runtime object registries in programmer delivery');
  assert.ok(text.indexOf('逻辑与表现分离') >= 0, label + ' should require logic/visual separation');
  assert.ok(text.indexOf('注释只写关键') >= 0, label + ' should require sparse plain Chinese comments');
  assert.ok(text.indexOf('复杂脚本参数说明') >= 0, label + ' should explain parameters for complex scripts');
  assert.ok(text.indexOf('有意义的空行分块') >= 0, label + ' should require meaningful blank-line grouping');
  assert.ok(text.indexOf('程序员可交付反馈规则') >= 0, label + ' should carry consolidated programmer-delivery feedback rules');
  assert.ok(text.indexOf('一节点一主脚本') >= 0, label + ' should require one primary script per node');
  assert.ok(text.indexOf('无生命周期能力') >= 0, label + ' should keep lifecycle-free abilities as plain classes');
  assert.ok(text.indexOf('只保留会被调用的方法') >= 0, label + ' should forbid dead unused methods');
  assert.ok(text.indexOf('必要兜底') >= 0, label + ' should forbid excessive fallback code');
  assert.ok(text.indexOf('Missing Mono Script') >= 0, label + ' should route missing script cleanup through scene/editor hydration');
  assert.ok(text.indexOf('静态 Init/Get/Return') >= 0, label + ' should forbid static workflow methods in singleton managers');
  assert.ok(text.indexOf('sqrMagnitude') >= 0, label + ' should require squared-distance threshold checks');
  assert.ok(text.indexOf('MoveSpeed 归 MovementComponent') >= 0, label + ' should keep tunable data on the owning component');
  assert.ok(text.indexOf('Init/Configure/Setup 未被调用就删除') >= 0, label + ' should remove unused setup entrypoints');
  assert.ok(text.indexOf('Awake/Start') >= 0, label + ' should avoid parallel Init when Mono lifecycle owns setup');
  assert.ok(text.indexOf('固定 Player 引用') >= 0, label + ' should require fixed player references');
  assert.ok(text.indexOf('Debug.LogError') >= 0, label + ' should fail missing references loudly without fallback complexity');
  assert.ok(text.indexOf('连续试玩流程') >= 0, label + ' should define phase as one continuous playable flow');
  assert.ok(text.indexOf('重置全场') >= 0, label + ' should forbid phase-as-level-reset behavior');
  assert.ok(text.indexOf('AIBridge 预水合') >= 0, label + ' should require editor-side hydration before runtime');
  assert.ok(text.indexOf('临时脚本') >= 0, label + ' should remove one-off temporary generation scripts from delivery');
}

var schemaText = schemaPrompt.buildSchemaPromptV3({ blueprint: blueprint });
var v5Text = promptV5.parseBlueprintToPromptV5(blueprint);
var v4Text = promptV4.parseBlueprintToPromptV4(blueprint);
var lunaCodexText = fs.readFileSync(path.join(__dirname, '../worker/luna-codex-code.md'), 'utf8');
var behaviorTemplateText = fs.readFileSync(path.join(__dirname, '../worker/behavior-templates.md'), 'utf8');
var workerCoderText = fs.readFileSync(path.join(__dirname, '../worker/worker-coder.js'), 'utf8');
var codexCodeCoderText = fs.readFileSync(path.join(__dirname, '../worker/codex-code-coder.js'), 'utf8');
var staticCheckText = fs.readFileSync(path.join(__dirname, '../engine/static-check.cjs'), 'utf8');
var reviewStageText = fs.readFileSync(path.join(__dirname, '../engine/stages/review.cjs'), 'utf8');
var codeReviewerText = fs.readFileSync(path.join(__dirname, '../worker/code-reviewer.js'), 'utf8');
var commentLocalizerText = fs.readFileSync(path.join(__dirname, '../lib/csharp-comment-localizer.cjs'), 'utf8');

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
assert.ok(behaviorTemplateText.indexOf('程序员可交付反馈规则') >= 0, 'behavior templates should carry programmer-delivery feedback warnings');
assert.ok(behaviorTemplateText.indexOf('复杂脚本参数说明') >= 0, 'behavior templates should carry complex-script parameter guidance');
assert.ok(behaviorTemplateText.indexOf('有意义的空行分块') >= 0, 'behavior templates should carry meaningful blank-line grouping guidance');
assert.ok(behaviorTemplateText.indexOf('MoveSpeed 归 MovementComponent') >= 0, 'behavior templates should keep tunable data on components');
assert.ok(behaviorTemplateText.indexOf('固定 Player 引用') >= 0, 'behavior templates should require fixed player references');
assert.ok(behaviorTemplateText.indexOf('连续试玩流程') >= 0, 'behavior templates should define phase as continuous flow');
assert.ok(behaviorTemplateText.indexOf('AIBridge 预水合') >= 0, 'behavior templates should require editor-side hydration cleanup');
assert.ok(behaviorTemplateText.indexOf('隐藏运行时对象表') >= 0, 'behavior templates should forbid hidden runtime object registries in programmer delivery');
assert.ok(codexCodeCoderText.indexOf('程序员可交付反馈规则') >= 0, 'codex fix prompt should carry programmer-delivery feedback warnings');
assert.ok(codexCodeCoderText.indexOf('复杂脚本参数说明') >= 0, 'codex fix prompt should carry complex-script parameter guidance');
assert.ok(codexCodeCoderText.indexOf('有意义的空行分块') >= 0, 'codex fix prompt should carry meaningful blank-line grouping guidance');
assert.ok(codexCodeCoderText.indexOf('MoveSpeed 归 MovementComponent') >= 0, 'codex fix prompt should keep tunable data on components');
assert.ok(codexCodeCoderText.indexOf('固定 Player 引用') >= 0, 'codex fix prompt should require fixed player references');
assert.ok(codexCodeCoderText.indexOf('连续试玩流程') >= 0, 'codex fix prompt should define phase as continuous flow');
assert.ok(codexCodeCoderText.indexOf('AIBridge 预水合') >= 0, 'codex fix prompt should require editor-side hydration cleanup');
assert.ok(codexCodeCoderText.indexOf('隐藏运行时对象表') >= 0, 'codex fix prompt should forbid hidden runtime object registries in programmer delivery');

assert.strictEqual(v5Text.indexOf('每个字段声明都必须有详细中文注释'), -1, 'v5 prompt must not require field-by-field boilerplate comments');
assert.strictEqual(v5Text.indexOf('每个方法都必须有详细中文注释'), -1, 'v5 prompt must not require method-by-method boilerplate comments');
assert.strictEqual(v5Text.indexOf('Instantiate 溢出时可用'), -1, 'v5 prompt must not describe Instantiate as a reserve-pool fallback');
assert.strictEqual(v5Text.indexOf('可以 Instantiate'), -1, 'v5 prompt must not suggest Instantiate as allowed');
assert.ok(v5Text.indexOf('sqrMagnitude') >= 0, 'v5 prompt should teach squared-distance gate checks');
assert.strictEqual(v5Text.indexOf('Vector3.Distance(a.position, b.position) < radius'), -1, 'v5 prompt must not teach Vector3.Distance threshold checks');
assert.strictEqual(v5Text.indexOf('正确代码模式参考（直接照抄'), -1, 'v5 prompt must not tell coders to copy placeholder entity names directly');
assert.strictEqual(v4Text.indexOf('每个字段、每个方法、每个条件分支都必须写详细注释'), -1, 'v4 prompt must not require boilerplate comments everywhere');
assert.strictEqual(lunaCodexText.indexOf('`GameObject.Find("名称")` 获取对象引用'), -1, 'luna codex prompt must not teach direct object Find as the default');
assert.strictEqual(lunaCodexText.indexOf('guideText.text ='), -1, 'luna codex prompt must route guide text through SetGuideText');
assert.strictEqual(lunaCodexText.indexOf('碰撞检测: `Vector3.Distance'), -1, 'luna codex prompt must not teach Vector3.Distance threshold checks');
assert.strictEqual(workerCoderText.indexOf('MUST create visible game objects (GFM_Create.Obj, UI elements)'), -1, 'worker prompt must not require GFM_Create-created objects');
assert.strictEqual(workerCoderText.indexOf('Create ALL Scene Objects from Blueprint'), -1, 'worker prompt must use bind/represent wording instead of runtime creation wording');
assert.strictEqual(workerCoderText.indexOf('If a fix requires new visible objects, use GFM_Create.Obj'), -1, 'fix prompt must not recommend GFM_Create for new visible objects');
assert.strictEqual(workerCoderText.indexOf('create initially with SetActive(false)'), -1, 'worker prompt must not suggest SetActive-based later-shot setup');
assert.strictEqual(workerCoderText.indexOf('No GFM_Create.Obj() calls found'), -1, 'verification must not warn when GFM_Create is absent');
assert.strictEqual(workerCoderText.indexOf('No binding refs or legacy GameObject.Find() calls'), -1, 'verification must not treat legacy Find as an acceptable positive signal');
assert.strictEqual(workerCoderText.indexOf('Collision detection: Vector3.Distance'), -1, 'worker prompt must not teach Vector3.Distance threshold checks');
assert.strictEqual(workerCoderText.indexOf('FindObjectOfType(typeof($1))'), -1, 'worker post-fix must not rewrite FindObjectOfType into another scene scan');
assert.strictEqual(codexCodeCoderText.indexOf('FindObjectOfType(typeof($1))'), -1, 'codex post-fix must not rewrite FindObjectOfType into another scene scan');
assert.strictEqual(staticCheckText.indexOf('use GameObject.Find() from pool'), -1, 'static-check feedback must not ask the model to use GameObject.Find');
assert.strictEqual(reviewStageText.indexOf('No GameObject.Find or GFM_Create calls'), -1, 'review stage must not require legacy Find/GFM_Create as positive stub evidence');
assert.strictEqual(codeReviewerText.indexOf('use GameObject.Find() to locate pre-existing pool objects'), -1, 'code reviewer must not suggest GameObject.Find as the replacement for GFM_Create.Obj');
assert.strictEqual(commentLocalizerText.indexOf('请使用 GameObject.Find()'), -1, 'comment localizer must not translate legacy advice into GameObject.Find guidance');
assert.strictEqual(commentLocalizerText.indexOf('回退：CreatePrimitive（Luna 中不会渲染，但可编译）'), -1, 'comment localizer must not preserve legacy CreatePrimitive fallback wording');

console.log('unity codegen prompt contract tests passed');
