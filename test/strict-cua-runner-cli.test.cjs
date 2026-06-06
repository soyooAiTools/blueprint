#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const strictRunner = require('../scripts/strict-cua-runner.cjs');

const parsed = strictRunner.parseArgs([
  'node',
  'scripts/strict-cua-runner.cjs',
  '/tmp/webgl-build',
  '--out',
  '/tmp/strict-cua.json',
  '--task-id',
  'strict-local',
]);

assert.deepStrictEqual(parsed, {
  buildDir: '/tmp/webgl-build',
  outPath: '/tmp/strict-cua.json',
  taskId: 'strict-local',
  help: false,
});

assert.ok(
  strictRunner.usage().indexOf('production strict CUA path') >= 0 &&
    strictRunner.usage().indexOf('full manual joystick flow') >= 0,
  'strict CUA runner usage should state that it is the final full-flow hardgate'
);

const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'strict-cua-runner.cjs'), 'utf8');
assert.ok(src.indexOf('runCUAVerification') >= 0, 'strict CUA runner must call production runCUAVerification');
assert.ok(src.indexOf('buildProbeBlueprint') >= 0, 'strict CUA runner must load WebGL sidecar blueprint/proof data');
assert.ok(src.indexOf('not a substitute') >= 0, 'strict CUA runner must distinguish checkpoint probes from final hardgate');

console.log('strict-cua-runner cli tests passed');
