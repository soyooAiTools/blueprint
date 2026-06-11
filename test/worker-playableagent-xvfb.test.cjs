#!/usr/bin/env node
'use strict';

const assert = require('assert');

const playableAgent = require('../worker/worker-playableagent.js');

assert.deepStrictEqual(
  playableAgent.parseXvfbPidsFromPs([
    ' 123 Xvfb :99 -screen 0 1280x1024x24 -ac',
    ' 456 /bin/bash -lc pgrep -f "Xvfb :99"',
    ' 789 rg Xvfb',
  ].join('\n'), ':99'),
  [123],
  'Xvfb process detection should ignore shell/search helper commands'
);

assert.deepStrictEqual(
  playableAgent.parseXvfbPidsFromPs(' 123 Xvfb :100 -screen 0 1280x1024x24 -ac\n', ':99'),
  [],
  'Xvfb process detection should be display-specific'
);

assert.strictEqual(playableAgent.xvfbLockPath(':99'), '/tmp/.X99-lock');
assert.strictEqual(playableAgent.xvfbSocketPath(':99'), '/tmp/.X11-unix/X99');

console.log('worker playableagent xvfb tests passed');
