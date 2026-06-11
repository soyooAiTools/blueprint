#!/usr/bin/env node
'use strict';

var assert = require('assert');

var pdfSamples = require('../scripts/process-storyboard-pdf-samples.cjs');

var internals = pdfSamples._internals;

assert.strictEqual(typeof internals.buildGuardVisualFallbackFrames, 'undefined');
assert.strictEqual(typeof internals.buildVisualOnlyFrames, 'undefined');
assert.strictEqual(typeof internals.GUARD_HOME_VISUAL_FALLBACK_VERSION, 'undefined');

['generic', 'guard', 'space', 'water', 'burger_merge', 'forest_defense', 'shelter_warmth'].forEach(function(kind) {
  assert.strictEqual(internals.themeForKind(kind), 'default');
  assert.deepStrictEqual(internals.entitiesForKind(kind).map(function(entity) { return entity.name; }), [
    'Player',
    'Source',
    'Item',
    'Target',
    'Container',
    'Consumer',
    'Producer',
    'UpgradePoint',
    'Reward',
    'CtaButton',
  ]);
  assert.deepStrictEqual(internals.resourcesForKind(kind).map(function(resource) {
    return resource.id + ':' + resource.carrierEntity;
  }), [
    'Item:Item',
    'Reward:Reward',
  ]);
});

var built = pdfSamples.buildIrForSample({
  name: 'legacy profile request must be ignored',
  kind: 'burger_merge',
  allowLegacyProfile: true,
  profile: { parser: 'generic' },
  plainText: '玩家拖拽两个对象进行合成，随后点击结束页面。',
  layoutText: '玩家拖拽两个对象进行合成，随后点击结束页面。',
}, '/tmp/legacy-profile-disabled-test');

assert.strictEqual(built.ir.project.theme, 'default');
assert.ok(built.entities.every(function(entity) {
  return ['Player', 'Source', 'Item', 'Target', 'Container', 'Consumer', 'Producer', 'UpgradePoint', 'Reward', 'CtaButton'].indexOf(entity.name) >= 0;
}));
assert.ok(built.ir.diagnostics.some(function(item) {
  return item.code === 'storyboard_pdf_topic_profile_disabled' &&
    item.requestedKind === 'burger_merge' &&
    item.effectiveKind === 'generic';
}));

console.log('legacy visual fallback disabled tests passed');
