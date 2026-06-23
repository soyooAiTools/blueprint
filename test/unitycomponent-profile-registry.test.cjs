#!/usr/bin/env node
'use strict';

var assert = require('assert');
var profiles = require('../lib/unitycomponent-profile-registry.cjs');

var all = profiles.listProfiles();
assert.ok(all.some(function(profile) { return profile.id === 'gmp-v14'; }), 'gmp-v14 legacy profile must exist');
assert.ok(all.some(function(profile) { return profile.id === 'unitycomponent-v1'; }), 'unitycomponent-v1 profile must exist');

var legacy = profiles.resolveProfile();
assert.strictEqual(legacy.id, 'gmp-v14', 'default profile remains legacy until explicit cutover');
assert.strictEqual(legacy.status, 'legacy-frozen');

var v1 = profiles.resolveProfile('unitycomponent-v1');
assert.strictEqual(v1.id, 'unitycomponent-v1');
assert.strictEqual(v1.namespace, '');
assert.strictEqual(v1.scriptRoot, 'Assets/SLGFrameWork/Scripts');
assert.strictEqual(v1.gameEntryPrefab, 'Assets/SLGFrameWork/Scripts/Prefab/GameEntry.prefab');
assert.deepStrictEqual(v1.sourceBoundary, {
  mutatesStoryboard2Html: false,
  mutatesSourceIrSchema: false,
  mutatesPlayableSceneIrSchema: false,
  mutatesWebglRuntime: false
});
assert.ok(v1.forbiddenIdentifiers.indexOf('GMP_') >= 0);
assert.deepStrictEqual(v1.asmdefs, []);
assert.ok(v1.layers.component.indexOf('PickUpComponent') >= 0);
assert.ok(v1.componentLifecycle.indexOf('OnEnable') >= 0);
assert.ok(v1.entityLifecycle.indexOf('OnOpen') >= 0);
assert.strictEqual(v1.cutoverGate.promptCutoverCorpus, 10);

assert.throws(function() {
  profiles.resolveProfile('unknown-profile');
}, /Unknown Unity delivery profile/);

console.log('unitycomponent profile registry tests passed');
