#!/usr/bin/env node
'use strict';

var assert = require('assert');

var smoke = require('../scripts/runtime-binding-smoke.cjs');

var parsed = smoke.parseArgs([
  'node',
  'scripts/runtime-binding-smoke.cjs',
  '/tmp/webgl',
  '--out',
  '/tmp/report.json',
  '--settle-ms',
  '2500',
  '--load-timeout-ms',
  '30000',
]);

assert.strictEqual(parsed.buildDir, '/tmp/webgl');
assert.strictEqual(parsed.outPath, '/tmp/report.json');
assert.strictEqual(parsed.settleMs, 2500);
assert.strictEqual(parsed.loadTimeoutMs, 30000);
assert.strictEqual(parsed.requirePlayer, true);

assert.notStrictEqual(
  smoke.safeRunId('p1-制作子弹'),
  smoke.safeRunId('p1-太空捡垃圾'),
  'runtime binding smoke IDs with different non-ASCII names must not collide'
);

var pass = smoke.analyzeRuntimeBindingSnapshot({
  runtime: {
    hasGameState: true,
    hasGfmPlayer: true,
    player: {
      hasInstance: true,
      hasGo: true,
      position: { x: 0, y: 0, z: 0 },
    },
    playerState: { visible: true },
  },
  logs: [],
});
assert.strictEqual(pass.passed, true);
assert.strictEqual(pass.summary.hasPlayerGo, true);

var missingPlayer = smoke.analyzeRuntimeBindingSnapshot({
  runtime: {
    hasGameState: true,
    hasGfmPlayer: true,
    player: {
      hasInstance: true,
      hasGo: false,
    },
  },
  logs: [
    { type: 'warning', text: '[EntityBinding] Missing pool object for Player: _player' },
  ],
});
assert.strictEqual(missingPlayer.passed, false);
assert.ok(missingPlayer.violations.some(function(item) {
  return item.code === 'runtime_player_binding_log';
}));
assert.ok(missingPlayer.violations.some(function(item) {
  return item.code === 'runtime_gfm_player_go_missing';
}));

var hiddenPlayer = smoke.analyzeRuntimeBindingSnapshot({
  runtime: {
    hasGameState: true,
    hasGfmPlayer: true,
    player: {
      hasInstance: true,
      hasGo: true,
      position: { x: 0, y: -999, z: 0 },
    },
    playerState: { visible: false },
  },
  logs: [],
});
assert.strictEqual(hiddenPlayer.passed, false);
assert.ok(hiddenPlayer.violations.some(function(item) {
  return item.code === 'runtime_player_hidden_below_world';
}));
assert.ok(hiddenPlayer.violations.some(function(item) {
  return item.code === 'runtime_player_state_not_visible';
}));

console.log('runtime binding smoke tests passed');
