#!/usr/bin/env node

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var cli = require('../scripts/cua-checkpoint-probe.cjs');

var parsed = cli.parseArgs([
  'node',
  'scripts/cua-checkpoint-probe.cjs',
  '/tmp/webgl-build',
  '--phase',
  'phase5',
  '--max-phases',
  '2',
  '--out',
  '/tmp/out',
  '--task-id',
  'local-check',
]);

assert.deepStrictEqual(
  parsed,
  {
    buildDir: '/tmp/webgl-build',
    phase: 'phase5',
    maxPhases: 2,
    outDir: '/tmp/out',
    taskId: 'local-check',
  },
  'checkpoint probe CLI should parse build dir, phase window, out dir, and task id'
);

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-cua-checkpoint-'));
fs.writeFileSync(path.join(tmp, 'index.html'), '<!doctype html><title>ok</title>');
fs.writeFileSync(path.join(tmp, 'blueprint-project.json'), JSON.stringify({
  specs: [{ phaseId: 'phase1' }],
  proofBundle: { schemaVersion: 'stale-inline' }
}));
fs.writeFileSync(path.join(tmp, 'blueprint-proof-bundle.json'), JSON.stringify({
  schemaVersion: 'blueprint-proof-bundle.v1',
  expectedPhasePath: ['phase1', 'phase2'],
  phases: [
    { phaseId: 'phase1', target: 'IceChunk' },
    { phaseId: 'phase2', target: 'Turret' }
  ]
}));

assert.strictEqual(cli.findEntryHtml(tmp), 'index.html', 'checkpoint probe should accept index.html WebGL build dirs');

var blueprint = cli.buildProbeBlueprint(tmp);
assert.strictEqual(
  blueprint.proofBundle.schemaVersion,
  'blueprint-proof-bundle.v1',
  'checkpoint probe should prefer sidecar proof bundle over stale inline bundle'
);
assert.deepStrictEqual(
  blueprint.proofBundle.expectedPhasePath,
  ['phase1', 'phase2'],
  'checkpoint probe should expose proof phase path to worker CUA'
);

var src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'cua-checkpoint-probe.cjs'), 'utf8');
assert.ok(
  src.indexOf('runManualJoystickCheckpointProbe') >= 0 &&
    src.indexOf('debugOnly') >= 0 &&
    src.indexOf('not a replacement for production full-flow CUA hardgate') >= 0,
  'checkpoint probe CLI must call the worker checkpoint flow and label the result as debug-only'
);

console.log('cua checkpoint probe cli tests passed');
