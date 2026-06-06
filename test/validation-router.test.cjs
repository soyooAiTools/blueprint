#!/usr/bin/env node
'use strict';

const assert = require('assert');

const router = require('../scripts/validation-router.cjs');

function commandIds(plan) {
  return plan.commands.map(function(command) { return command.id; }).sort();
}

function commandById(plan, id) {
  return plan.commands.find(function(command) { return command.id === id; });
}

const parsed = router.parseArgs([
  'node',
  'scripts/validation-router.cjs',
  '--files',
  'worker/worker-playableagent.js,adapters/skeleton-generator.cjs',
  '--checkpoint-build-dir',
  '/tmp/webgl',
  '--checkpoint-phase',
  'phase8',
  '--strict-cua-build-dir',
  '/tmp/webgl',
  '--strict-cua-out',
  '/tmp/strict.json',
  '--strict-cua-task-id',
  'strict-one',
]);
assert.deepStrictEqual(parsed.files, ['worker/worker-playableagent.js', 'adapters/skeleton-generator.cjs']);
assert.strictEqual(parsed.checkpointBuildDir, '/tmp/webgl');
assert.strictEqual(parsed.checkpointPhase, 'phase8');
assert.strictEqual(parsed.strictCuaBuildDir, '/tmp/webgl');

const cuaPlan = router.buildValidationPlan(parsed);
assert.strictEqual(cuaPlan.schemaVersion, 'blueprint-validation-plan.v1');
assert.ok(cuaPlan.riskTags.includes('cua-verifier'), 'worker-playableagent should route to CUA verifier risk');
assert.ok(cuaPlan.riskTags.includes('runtime-phase-gate'), 'skeleton generator should route to runtime phase gate risk');
assert.ok(commandIds(cuaPlan).includes('unit:playableagent-report-normalization'), 'CUA telemetry/report test should be required');
assert.ok(commandIds(cuaPlan).includes('unit:playableagent-manual-joystick'), 'manual joystick test should be required');
assert.ok(commandIds(cuaPlan).includes('unit:demo2spec-proof-bundle'), 'proof bundle test should be required');
assert.ok(commandIds(cuaPlan).includes('unit:skeleton-phase-gate'), 'skeleton phase gate test should be required');

const checkpoint = commandById(cuaPlan, 'checkpoint-cua:affected-phase');
assert.strictEqual(checkpoint.ready, true, 'checkpoint command should be ready when build dir and phase are supplied');
assert.deepStrictEqual(
  checkpoint.command,
  ['node', 'scripts/cua-checkpoint-probe.cjs', '/tmp/webgl', '--phase', 'phase8', '--max-phases', '1']
);

const finalGate = commandById(cuaPlan, 'final:strict-cua-one-project');
assert.strictEqual(finalGate.ready, true, 'final strict CUA command should be ready when build dir is supplied');
assert.deepStrictEqual(
  finalGate.command,
  ['node', 'scripts/strict-cua-runner.cjs', '/tmp/webgl', '--out', '/tmp/strict.json', '--task-id', 'strict-one']
);

const missingInputsPlan = router.buildValidationPlan({
  files: ['adapters/demo2spec/proof-bundle.cjs'],
});
assert.strictEqual(commandById(missingInputsPlan, 'checkpoint-cua:affected-phase').ready, false);
assert.strictEqual(commandById(missingInputsPlan, 'final:strict-cua-one-project').ready, false);
assert.ok(commandById(missingInputsPlan, 'checkpoint-cua:affected-phase').missingInputs.includes('checkpointBuildDir'));
assert.ok(commandById(missingInputsPlan, 'final:strict-cua-one-project').missingInputs.includes('strictCuaBuildDir'));

const storyboardPlan = router.buildValidationPlan({
  files: ['scripts/storyboard2html-smoke.cjs'],
});
assert.ok(storyboardPlan.riskTags.includes('storyboard2html'));
assert.ok(commandIds(storyboardPlan).includes('unit:storyboard2html-contract'));

const unknownPlan = router.buildValidationPlan({
  files: ['docs/notes.md'],
});
assert.ok(unknownPlan.riskTags.includes('unknown-risk'));
assert.ok(commandIds(unknownPlan).includes('unit:run-all'));

console.log('validation-router tests passed');
