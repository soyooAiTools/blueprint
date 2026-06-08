#!/usr/bin/env node
'use strict';

var assert = require('assert');
var storyboardIr = require('../engine/storyboard-ir.cjs');

var input = {
  projectName: 'PA守护家园',
  themeHint: 'tower-defense',
  characterSheet: {
    Player: { label: '守护者' },
    Enemy: { label: '怪物' },
  },
  sceneSheet: {
    HomeBase: { label: '家园基地' },
  },
  entities: [
    { name: 'Player', label: '守护者' },
    { name: 'Corn', label: '玉米' },
    { name: 'Enemy', label: '怪物' },
    { name: 'HomeBase', label: '家园基地' },
    { name: 'CtaButton', label: '下载按钮' },
  ],
  storyboardFrames: [
    {
      id: 'cover',
      chapter: 1,
      title: '收集玉米',
      scene: '守护者在家园基地附近看到玉米',
      interaction: 'collect:Corn:3',
      ui: '收集 3 个玉米',
    },
    {
      id: 'move',
      chapter: 1,
      title: '拖摇杆靠近怪物',
      guide: '拖动摇杆移动到怪物旁边',
      scene: '怪物靠近家园基地',
    },
    {
      id: 'cta',
      chapter: 2,
      title: '点击下载按钮',
      action: '点击下载按钮',
    },
  ],
};

var ir = storyboardIr.normalizeStoryboardIr(input);
assert.strictEqual(ir.schemaVersion, 'storyboard-ir.v1');
assert.strictEqual(ir.kind, 'blueprint.storyboardIr');
assert.strictEqual(ir.project.name, 'PA守护家园');
assert.strictEqual(ir.project.theme, 'tower-defense');
assert.strictEqual(ir.frames.length, 3);
assert.strictEqual(ir.chapters.length, 2);
assert.ok(ir.semanticHash);
assert.deepStrictEqual(ir.characterSheet.Player, { label: '守护者' });
assert.deepStrictEqual(ir.sceneSheet.HomeBase, { label: '家园基地' });
assert.strictEqual(ir.frames[0].interaction.verb, 'collect');
assert.strictEqual(ir.frames[0].interaction.target, 'Corn');
assert.strictEqual(ir.frames[0].interaction.resource, 'Corn');
assert.strictEqual(ir.frames[0].interaction.amount, 3);
assert.strictEqual(ir.frames[1].interaction.verb, 'drag');
assert.strictEqual(ir.frames[1].interaction.target, '怪物');
assert.deepStrictEqual(ir.frames[1].interaction.riskHints, ['drag']);
assert.strictEqual(ir.frames[2].interaction.verb, 'click');
assert.strictEqual(ir.frames[2].interaction.target, '下载按钮');
assert.strictEqual(storyboardIr.assertStoryboardIr(ir), true);

var irAgain = storyboardIr.normalizeStoryboardIr(input);
assert.strictEqual(irAgain.semanticHash, ir.semanticHash);

var joystickIr = storyboardIr.normalizeStoryboardIr({
  projectName: 'MoveFixture',
  entities: [{ name: 'WoodPile', chineseName: '木堆' }],
  frames: [{ title: '移动到木堆', guide: '摇杆移动到木堆附近' }],
});
assert.strictEqual(joystickIr.frames[0].interaction.verb, 'joystick');
assert.strictEqual(joystickIr.frames[0].interaction.target, '木堆');
assert.deepStrictEqual(joystickIr.frames[0].interaction.riskHints, ['joystick']);

assert.throws(function() {
  storyboardIr.assertStoryboardIr({ schemaVersion: 'bad', kind: 'blueprint.storyboardIr', frames: [] });
}, /unsupported storyboard IR schemaVersion/);

assert.throws(function() {
  storyboardIr.assertStoryboardIr({ schemaVersion: 'storyboard-ir.v1', kind: 'blueprint.storyboardIr', frames: [{}] });
}, /missing id/);

console.log('storyboard IR tests passed');
