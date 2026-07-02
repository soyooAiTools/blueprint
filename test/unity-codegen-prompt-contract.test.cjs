#!/usr/bin/env node
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function assertHas(text, needle, label) {
  assert.ok(text.indexOf(needle) >= 0, label + ' should contain: ' + needle);
}

function assertNotHas(text, needle, label) {
  assert.strictEqual(text.indexOf(needle), -1, label + ' must not contain stale wording: ' + needle);
}

var promptFiles = [
  'engine/stages/build-schema-prompt-v3.cjs',
  'worker/prompt-v5-basetemplate.js',
  'worker/prompt-v4.js',
  'worker/luna-codex-code.md',
  'worker/worker-coder.js',
  'worker/codex-code-coder.js',
  'worker/behavior-templates.md',
];

var all = promptFiles.map(function(rel) {
  return '\n\n--- ' + rel + ' ---\n' + read(rel);
}).join('');

[
  'Luna/WebGL staging',
  'storyboard2html/source HTML/WebGL parity',
  'unitycomponent-v1',
  'UnityDeliverySpec',
  'Assets/SLGFrameWork/Scripts',
  'gmp-v14',
  'Unity Editor 原生 `BuildTarget.WebGL`',
  'targetRing / marker',
  '视觉合同',
].forEach(function(needle) {
  assertHas(all, needle, 'prompt contract');
});

[
  '每个字段声明都必须有详细中文注释',
  '每个方法都必须有详细中文注释',
  '每个字段、每个方法、每个条件分支都必须写详细注释',
  '交付校验规则 `delivery-comment-coverage-field`',
  '可以 Instantiate 复制',
  'Instantiate(obj) if you need more copies of an object',
  '`Instantiate(obj)` 复制池对象',
  'float dist = Vector3.Distance',
  'Collision detection: Vector3.Distance(a.position, b.position) < radius',
  '碰撞检测: `Vector3.Distance(a.position, b.position) < radius`',
  'FindObjectOfType<T>()` → 用 `(T)FindObjectOfType(typeof(T))',
  'FindObjectOfType(typeof($1))',
  'No GFM_Create.Obj() calls found — AI may have used wrong API',
  'No GameObject.Find() calls — AI may not be using base template objects',
  'should use Find() instead',
].forEach(function(needle) {
  assertNotHas(all, needle, 'prompt contract');
});

[
  'worker/prompt-v5-basetemplate.js',
  'worker/luna-codex-code.md',
  'worker/worker-coder.js',
  'worker/behavior-templates.md',
].forEach(function(rel) {
  assertHas(read(rel), 'sqrMagnitude', rel);
});

console.log('unity codegen prompt contract tests passed');
