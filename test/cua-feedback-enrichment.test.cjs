#!/usr/bin/env node
/**
 * A (2026-04-20): cua-verify feedback enrichment + extractPhaseDurations.
 *
 * Anchors the contract that 6 previously-dropped cuaResult fields now flow
 * into feedback.text, and that phase dwell reconstruction produces the
 * expected flags that Claude can act on.
 */

var assert = require('assert');
var helpers = require('../engine/helpers.cjs');
var { buildStructuredFeedback, extractPhaseDurations } = helpers;

function makeCuaResult(overrides) {
  var base = {
    issues: ['[phase-coverage] 2/5 phases completed. Missing: play (trigger: score>=10); end (trigger: timer>60)'],
    report: {
      gameState: {
        currentPhase: 'tutorial',
        completedPhases: ['intro', 'tutorial'],
        entityStates: {},
        variables: { gold: 0, score: 0 },
        phaseTimestamps: { intro: 0.2, tutorial: 14.5 },
      },
      diagnostics: { consoleErrors: [] },
    },
  };
  return Object.assign(base, overrides || {});
}

function makeBlueprint(specIds) {
  return { specs: (specIds || []).map(function(p) { return { phaseId: p }; }) };
}

// ── Case 1: visual_fail_reasons flow through ──────────────────────────

var r1 = makeCuaResult();
r1.report.visual_fail_reasons = [
  'Frame 12: PlayButton not visible',
  'Frame 18: Score text clipped',
];
var fb1 = buildStructuredFeedback(3, r1, makeBlueprint(['intro', 'tutorial', 'play']), [], '');
assert.ok(fb1.text.indexOf('Visual fails (VLM):') >= 0, '[1.1] visual fails header: ' + fb1.text.slice(-500));
assert.ok(fb1.text.indexOf('PlayButton not visible') >= 0, '[1.2] first reason');
assert.ok(fb1.text.indexOf('Score text clipped') >= 0, '[1.3] second reason');

// ── Case 2: scriptCoverage with uncovered steps ───────────────────────

var r2 = makeCuaResult();
r2.report.scriptCoverage = [
  { step: 's1', covered: false, evidence: 'no click observed' },
  { step: 's2', covered: true, evidence: 'click ok' },
  { step: 's3', covered: false, evidence: 'entity state=0' },
];
var fb2 = buildStructuredFeedback(1, r2, makeBlueprint(['intro']), [], '');
assert.ok(fb2.text.indexOf('Script coverage: 1/3 (33%)') >= 0, '[2.1] coverage ratio: ' + fb2.text.match(/Script coverage[^\n]*/));
assert.ok(fb2.text.indexOf('- s1:') >= 0, '[2.2] uncovered step s1 listed');
assert.ok(fb2.text.indexOf('- s3:') >= 0, '[2.3] uncovered step s3 listed');
assert.ok(fb2.text.indexOf('- s2:') < 0, '[2.4] covered step s2 NOT listed');

// ── Case 3: exitReason + autoplay_detected ────────────────────────────

var r3 = makeCuaResult();
r3.report.exitReason = 'timeout';
r3.report.autoplay_detected = true;
r3.report.autoplay_reason = 'timer-based advance';
var fb3 = buildStructuredFeedback(2, r3, makeBlueprint(['intro']), [], '');
assert.ok(fb3.text.indexOf('Exit: timeout') >= 0, '[3.1] exit reason');
assert.ok(fb3.text.indexOf('Autoplay: detected') >= 0, '[3.2] autoplay header');
assert.ok(fb3.text.indexOf('timer-based advance') >= 0, '[3.3] autoplay reason');

// autoplay_detected=false must NOT emit Autoplay line
var r3b = makeCuaResult();
r3b.report.autoplay_detected = false;
var fb3b = buildStructuredFeedback(2, r3b, makeBlueprint(['intro']), [], '');
assert.ok(fb3b.text.indexOf('Autoplay:') < 0, '[3.4] autoplay=false suppresses line');

// ── Case 4: phase timing from phaseTimestamps ─────────────────────────

var r4 = makeCuaResult();
r4.report.gameState.phaseTimestamps = { a: 0.1, b: 14.3, c: undefined, d: undefined };
var fb4 = buildStructuredFeedback(1, r4, makeBlueprint(['a', 'b', 'c', 'd']), [], '');
assert.ok(fb4.text.indexOf('Phase timing:') >= 0, '[4.1] phase timing header');
assert.ok(fb4.text.indexOf('batch-fired') >= 0, '[4.2] a starts at 0.1s → batch-fired');
assert.ok(fb4.text.indexOf('never-completed') >= 0, '[4.3] c missing after b → never-completed');
assert.ok(fb4.text.indexOf('never-reached') >= 0, '[4.4] d missing after c → never-reached');

// ── Case 5: text cap at 8KB ───────────────────────────────────────────

var rLong = makeCuaResult();
rLong.report.visual_fail_reasons = [];
for (var li = 0; li < 200; li++) rLong.report.visual_fail_reasons.push('x'.repeat(200));
var fbLong = buildStructuredFeedback(1, rLong, makeBlueprint(['a']), [], '');
assert.ok(fbLong.text.length <= 8000, '[5.1] text capped: got ' + fbLong.text.length);

// ── Case 6: backward compat — empty report fields ─────────────────────

var r6 = { issues: ['[phase-coverage] 0/1 phases completed'], report: {} };
var fb6 = buildStructuredFeedback(1, r6, makeBlueprint(['a']), [], '');
assert.ok(typeof fb6.text === 'string', '[6.1] no report still returns string');
assert.ok(fb6.text.indexOf('Visual fails') < 0, '[6.2] absent fields not mentioned');
assert.ok(fb6.text.indexOf('Script coverage') < 0, '[6.3] absent coverage not mentioned');

// ── Case 7: missing phases — only shown when NOT in issue text ────────

var r7a = makeCuaResult();
r7a.report.missingPhases = ['play', 'end'];
// issue text already contains "Missing:" → should be suppressed to avoid dup
var fb7a = buildStructuredFeedback(1, r7a, makeBlueprint(['intro', 'tutorial', 'play', 'end']), [], '');
assert.ok(fb7a.text.indexOf('Missing phases: play, end') < 0, '[7.1] dedup when issue already says Missing');

var r7b = makeCuaResult();
r7b.issues = ['[visual_freeze] screen static'];
r7b.report.missingPhases = ['play', 'end'];
var fb7b = buildStructuredFeedback(1, r7b, makeBlueprint(['intro', 'tutorial', 'play', 'end']), [], '');
assert.ok(fb7b.text.indexOf('Missing phases: play, end') >= 0, '[7.2] emitted when issue silent');

// ── Case 8: plan/signal coverage diagnostics ─────────────────────────

var r8 = makeCuaResult();
r8.report.planCoverage = '2/3';
r8.report.signalCoverage = '1/3';
r8.report.signalValidationPassed = false;
r8.report.missingSignals = ['build:entity_state_equals_built', 'intro:guide_text_visible'];
r8.report.unsupportedSignals = ['intro:camera_orientation_changed'];
var fb8 = buildStructuredFeedback(2, r8, makeBlueprint(['intro', 'build', 'end']), [], '');
assert.ok(fb8.text.indexOf('Plan coverage: 2/3') >= 0, '[8.1] plan coverage emitted');
assert.ok(fb8.text.indexOf('Signal coverage: 1/3 (FAILED)') >= 0, '[8.2] signal coverage emitted');
assert.ok(fb8.text.indexOf('Missing signals:') >= 0, '[8.3] missing signals header');
assert.ok(fb8.text.indexOf('build:entity_state_equals_built') >= 0, '[8.4] first missing signal listed');
assert.ok(fb8.text.indexOf('Unsupported signals (non-blocking): intro:camera_orientation_changed') >= 0, '[8.5] unsupported signals listed');

// ── Case 8: extractPhaseDurations unit cases ──────────────────────────

var d1 = extractPhaseDurations({ a: 0.1, b: 0.2, c: 0.3 }, ['a', 'b', 'c']);
assert.strictEqual(d1.length, 3, '[9.1] three entries');
assert.strictEqual(d1[0].flag, 'batch-fired', '[9.2] a starts < 1s');
assert.strictEqual(d1[1].flag, 'batch-fired', '[9.3] b-a < 1s');
assert.strictEqual(d1[2].flag, 'batch-fired', '[9.4] c-b < 1s');

var d2 = extractPhaseDurations({ a: 12, b: 50 }, ['a', 'b', 'c']);
assert.strictEqual(d2[0].flag, 'ok',            '[9.5] a=12 is ok');
assert.strictEqual(d2[1].flag, 'slow',          '[9.6] b-a=38 is slow');
assert.strictEqual(d2[2].flag, 'never-completed','[9.7] c missing after b completed');

var d3 = extractPhaseDurations({}, ['a', 'b']);
assert.strictEqual(d3[0].flag, 'never-completed', '[9.8] a missing, start reached → never-completed');
assert.strictEqual(d3[1].flag, 'never-reached',   '[9.9] b missing, a also missing → never-reached');

var d4 = extractPhaseDurations(null, ['a']);
assert.deepStrictEqual(d4, [], '[9.10] null phaseTimestamps → []');

var d5 = extractPhaseDurations({ a: 5 }, []);
assert.deepStrictEqual(d5, [], '[9.11] empty specPhases → []');

console.log('OK — all CUA feedback enrichment assertions passed');
console.log('  sample visual block:');
console.log(fb1.text.slice(fb1.text.indexOf('=== CUA DIAGNOSTICS')));
