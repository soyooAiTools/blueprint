#!/usr/bin/env node
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');

var editorRoot = path.join(__dirname, '..');
var configuredSkillRoot = process.env.BLUEPRINT_SKILL_ROOT || '';
var siblingSkillRoot = path.resolve(editorRoot, '..', 'blueprint-skill');
var skillRoot = '';

if (configuredSkillRoot && fs.existsSync(path.join(configuredSkillRoot, 'SKILL.md'))) {
  skillRoot = configuredSkillRoot;
} else if (fs.existsSync(path.join(siblingSkillRoot, 'SKILL.md'))) {
  skillRoot = siblingSkillRoot;
}

if (!skillRoot) {
  console.log('blueprint skill unitycomponent profile contract tests skipped: set BLUEPRINT_SKILL_ROOT or place blueprint-skill next to blueprint-editor');
  process.exit(0);
}

function read(rel) {
  return fs.readFileSync(path.join(skillRoot, rel), 'utf8');
}

function assertHas(text, needle, label) {
  assert.ok(text.indexOf(needle) >= 0, label + ' should contain: ' + needle);
}

function assertNotHas(text, needle, label) {
  assert.strictEqual(text.indexOf(needle), -1, label + ' must not contain stale wording: ' + needle);
}

var skill = read('SKILL.md');
var readme = read('README.md');
var architecture = read('references/architecture.md');
var delivery = read('references/delivery.md');
var lunaSpec = read('references/luna-spec.md');
var buildPipeline = read('references/build-pipeline.md');
var all = [skill, readme, architecture, delivery, lunaSpec, buildPipeline].join('\n\n');

assertHas(all, 'gmp-v14', 'skill docs');
assertHas(all, 'unitycomponent-v1', 'skill docs');
assertHas(all, 'UnityDeliverySpec', 'skill docs');
assertHas(all, 'Entity', 'skill docs');
assertHas(all, 'BaseComponent', 'skill docs');
assertHas(all, 'EntityManager', 'skill docs');
assertHas(all, 'GameEntry', 'skill docs');
assertHas(all, 'Assets/SLGFrameWork/Scripts', 'skill docs');
assertHas(all, 'Assets/SLGFrameWork/Scripts/Prefab/GameEntry.prefab', 'skill docs');
assertHas(all, 'BlueprintPlayableManager', 'skill docs');
assertHas(all, 'storyboard2html', 'skill docs');
assertHas(all, 'source HTML', 'skill docs');
assertHas(all, 'WebGL', 'skill docs');

assertHas(skill, '默认 `gmp-v14` 是冻结 legacy 稳定路径', 'SKILL.md');
assertHas(skill, '新框架工作必须显式走 `unitycomponent-v1`', 'SKILL.md');
assertHas(skill, 'synthetic', 'SKILL.md');
assertHas(skill, '默认切换必须另有显式 cutover 决策', 'SKILL.md');
assertHas(readme, 'Unity delivery handoff (gmp-v14 legacy or explicit unitycomponent-v1)', 'README.md');
assertHas(readme, '默认程序员 Unity 交付仍是冻结的 `gmp-v14` legacy', 'README.md');
assertHas(architecture, 'gmp-v14 legacy Core / Tool / Game 口径', 'architecture.md');
assertHas(architecture, 'gmp-v14 legacy Core / Tool / Game 详细约束（仅适用于默认 legacy profile）', 'architecture.md');
assertHas(architecture, 'unitycomponent-v1 原生框架口径', 'architecture.md');
assertHas(architecture, 'Assets/SLGFrameWork/Scripts/Base', 'architecture.md');
assertHas(architecture, 'Component', 'architecture.md');
assertHas(delivery, 'The default `gmp-v14`', 'delivery.md');
assertHas(delivery, 'Do not apply `GMP_*` naming rules to', 'delivery.md');

[
  '程序员 Unity 交付必须严格按 `Assets/Scripts/Core` / `Tool` / `Game` 三层输出',
  '程序员 Unity 交付必须按 `Assets/Scripts/Core` / `Tool` / `Game` 三层整理',
  'Core / Tool / Game Unity delivery handoff',
  '当前权威实现以 `/opt/blueprint-editor/lib/programmer-delivery-cleaner.cjs` 为准',
  '程序员 Unity 交付必须可由人接手：AIBridge/Editor 写入 `GMP_SceneEntityRefs`/serialized refs',
  '> 本文件只给 Luna/WebGL staging 代码参考。程序员 Unity 交付版必须由 AIBridge/MCP 做 Inspector/scene hydration，引用进入 `GMP_SceneEntityRefs`',
  '- 程序员交付版必须由 AIBridge/MCP 把引用写进 Inspector/scene，实体关系收口到 `GMP_SceneEntityRefs`',
  '，程序员交付版使用 AIBridge/Editor Inspector hydration、`GMP_SceneEntityRefs` 或 serialized refs',
  '，程序员交付必须收敛到 `GMP_SceneEntityRefs` / serialized refs',
  '- `GMP_EntityManager` 负责注册实体并统一 Tick',
  '最终程序员交付必须走 `Assets/Scripts/Core` / `Tool` / `Game`',
  '显式 `unitycomponent-v1` profile 不使用 GMP 命名，必须走原生 `Entity` / `BaseComponent` / `EntityManager` / `GameEntry`、`Assets/Scripts/Base` / `Data` / `Tool` / `Game`',
  '显式 unitycomponent-v1 使用 `Assets/Scripts/Base` / `Data` / `Tool` / `Game`',
].forEach(function(needle) {
  assertNotHas(all, needle, 'skill docs');
});

console.log('blueprint skill unitycomponent profile contract tests passed');
