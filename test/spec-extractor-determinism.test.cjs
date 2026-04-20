#!/usr/bin/env node
/**
 * D1 regression: spec-extractor determinism seed derivation.
 *
 * Guarantees:
 *   1. Same (frames, entities) inputs ⇒ same seed.
 *   2. Reordering entities ⇒ same seed (prompt sorts them).
 *   3. Perturbing frame interaction text ⇒ different seed.
 *   4. Adding/removing an entity ⇒ different seed.
 *
 * The LLM itself is not exercised here — this validates only the
 * deterministic-seed precondition. Downstream drift fatalities traced
 * to non-deterministic phaseId sets rely on this being stable.
 */

var assert = require('assert');
var { _internals } = require('../adapters/spec-extractor.cjs');
var computeSeed = _internals.computeDeterministicSeed;

var baseFrames = [
  { chapter: 1, chapterTitle: 'Intro', interaction: 'move to conveyor', timing: '3s' },
  { chapter: 2, chapterTitle: 'Build', interaction: 'build conveyor', timing: '5s' },
];
var baseEntities = [{ name: 'Conveyor' }, { name: 'Worker' }];

var s1 = computeSeed(baseFrames, baseEntities);
var s2 = computeSeed(baseFrames, baseEntities);
assert.strictEqual(s1, s2, '[1] same input must produce same seed');

var reorderedEntities = [{ name: 'Worker' }, { name: 'Conveyor' }];
var s3 = computeSeed(baseFrames, reorderedEntities);
assert.strictEqual(s1, s3, '[2] entity reorder must not change seed');

var perturbedFrames = [
  { chapter: 1, chapterTitle: 'Intro', interaction: 'move to CONVEYOR', timing: '3s' },
  { chapter: 2, chapterTitle: 'Build', interaction: 'build conveyor', timing: '5s' },
];
var s4 = computeSeed(perturbedFrames, baseEntities);
assert.notStrictEqual(s1, s4, '[3] changed interaction text must change seed');

var extraEntities = [{ name: 'Conveyor' }, { name: 'Worker' }, { name: 'MainBase' }];
var s5 = computeSeed(baseFrames, extraEntities);
assert.notStrictEqual(s1, s5, '[4] adding an entity must change seed');

assert.ok(Number.isInteger(s1), '[5] seed must be an integer');
assert.ok(s1 >= 0 && s1 <= 0x7fffffff, '[6] seed must fit in 31-bit positive int');

console.log('OK — all 6 determinism assertions passed');
console.log('  baseline seed = ' + s1);
