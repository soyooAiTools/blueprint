#!/usr/bin/env node
/**
 * D3 regression: normalizeFingerprint.
 *
 * Anchors: each case corresponds to a distinct fingerprint bucket observed
 * in server-data/auto-fix-state.json on 2026-04-19/20 that SHOULD have
 * collapsed into a single cooldown key but didn't pre-D3. Keep these cases
 * so future regex tweaks don't silently re-fracture the buckets.
 */

var assert = require('assert');
var { normalizeFingerprint } = require('../engine/metrics.cjs');

function eq(actual, expected, label) {
  assert.strictEqual(actual, expected, label + '\n    actual: ' + actual + '\n  expected: ' + expected);
}

// ── Fraction "N/N overlap" — pre-D3 ate the slash as <path> ───────────

var fpA1 = normalizeFingerprint('Spec fingerprint drift (fatal): fresh-extract produced phaseId set with only 2/11 overlap (18%)');
var fpA2 = normalizeFingerprint('Spec fingerprint drift (fatal): fresh-extract produced phaseId set with only 1/11 overlap (9%)');
eq(fpA1, fpA2, '[A.1] all spec-drift overlaps must share one fingerprint');
assert.ok(fpA1.indexOf('N/N overlap') >= 0, '[A.2] should contain "N/N overlap": ' + fpA1);
assert.ok(fpA1.indexOf('(N%)') >= 0, '[A.3] should contain "(N%)": ' + fpA1);

// ── Phase coverage "0/5 (0%)" — same family bug ──────────────────────

// Missing-list intentionally identical — the variability we want to
// collapse is the "0/5" vs "2/5" ratio and the "(0%)" vs "(40%)" percent,
// not the list of unmet phases (which genuinely identifies root cause).
var fpB1 = normalizeFingerprint('Phase coverage too low: 0/5 (0%). Missing: sellShards, gameEnd');
var fpB2 = normalizeFingerprint('Phase coverage too low: 2/5 (40%). Missing: sellShards, gameEnd');
eq(fpB1, fpB2, '[B.1] different coverage ratios but same missing list must share fingerprint');
assert.ok(fpB1.indexOf('N/N') >= 0, '[B.2] coverage ratio collapsed');

// ── JSON schema array indexes ──────────────────────────────────────────

var fpC1 = normalizeFingerprint("Schema validation failed: .entities[0] should have required property 'chineseName'");
var fpC2 = normalizeFingerprint("Schema validation failed: .entities[3] should have required property 'chineseName'");
eq(fpC1, fpC2, '[C.1] entities[0] / entities[3] must collapse');
assert.ok(fpC1.indexOf('.entities[N]') >= 0, '[C.2] should contain .entities[N]');

// ── Exit codes — 143 SIGTERM vs 137 SIGKILL vs 1 ──────────────────────

var fpD1 = normalizeFingerprint('Schema generation failed: Exit code 143');
var fpD2 = normalizeFingerprint('Schema generation failed: Exit code 137');
eq(fpD1, fpD2, '[D.1] all exit codes must collapse');
assert.ok(fpD1.indexOf('Exit code N') >= 0, '[D.2] should contain "Exit code N"');

// ── Critical/issue counts — "1 critical" vs "2 critical" ───────────────

var fpE1 = normalizeFingerprint('aborted: same CODE error repeated 3 rounds, fix-loop not converging: Review blocked: 1 critical issue');
var fpE2 = normalizeFingerprint('aborted: same CODE error repeated 3 rounds, fix-loop not converging: Review blocked: 2 critical issues');
eq(fpE1, fpE2, '[E.1] 1/2 critical issues must collapse');

// ── Stage dimension — generic errors disambiguate by stage ─────────────

var fpF1 = normalizeFingerprint("Cannot read properties of undefined (reading 'length')", { stage: 'codegen' });
var fpF2 = normalizeFingerprint("Cannot read properties of undefined (reading 'length')", { stage: 'review' });
assert.notStrictEqual(fpF1, fpF2, '[F.1] same error in different stages must differ');
assert.ok(fpF1.indexOf('codegen|') === 0, '[F.2] stage prefix present: ' + fpF1);
assert.ok(fpF2.indexOf('review|') === 0, '[F.3] stage prefix present: ' + fpF2);

// Legacy call-site (no stage) must NOT get a prefix — backward compat
var fpF3 = normalizeFingerprint("Cannot read properties of undefined (reading 'length')");
assert.ok(fpF3.indexOf('|') < 0, '[F.4] no stage opts ⇒ no pipe prefix: ' + fpF3);

// ── Path regex hardening: don't eat numeric-first segments ─────────────

var fpG = normalizeFingerprint('Overlap: 5/10 at /tmp/cua-foo/out.log and /7 failures');
assert.ok(fpG.indexOf('/7 failures') >= 0 || fpG.indexOf('N failures') >= 0, '[G.1] lone "/7" must not become <path>: ' + fpG);
assert.ok(fpG.indexOf('<path>') >= 0, '[G.2] real path still matched: ' + fpG);

// ── Stage prefix stripping covers all 11 stages ────────────────────────

var fpH = normalizeFingerprint('spec-extract: some error here');
assert.ok(fpH.indexOf('spec-extract') < 0, '[H.1] spec-extract prefix stripped: ' + fpH);
var fpI = normalizeFingerprint('complexity-gate: score too high');
assert.ok(fpI.indexOf('complexity-gate') < 0, '[I.1] complexity-gate prefix stripped: ' + fpI);

// ── Worker error wrapping "[Linux] Error: [<stage>] " — 2026-05-05 incident ───
// Without this stripper, outer-retry fp dedup never matched across stages
// because each stage's fp had the wrapper as a uniqueness prefix. Real
// proj_1777128165822_6acnqx case: 4 fp entries (review/cua-verify x2/codegen),
// all "fix-loop not converging" root cause but counted as 4 distinct fps.
var fpJ1 = normalizeFingerprint(
  '[Linux] Error: [review] review aborted: same CODE error repeated 3 rounds, fix-loop not converging: Review blocked: 1 critical issues'
);
var fpJ2 = normalizeFingerprint(
  '[Linux] Error: [cua-verify] cua-verify aborted: same CODE error repeated 3 rounds, fix-loop not converging: Review blocked: 1 critical issues'
);
assert.ok(fpJ1.indexOf('[Linux]') < 0, '[J.1] [Linux] wrapper stripped: ' + fpJ1);
assert.ok(fpJ2.indexOf('[Linux]') < 0, '[J.2] [Linux] wrapper stripped: ' + fpJ2);
// Inner stage tag still differs (review/cua-verify in body), so fps stay
// distinct on root cause — but they'd match if same stage with different
// outer wrappers (e.g. a Linux retry then a Worker retry).
var fpJ3 = normalizeFingerprint(
  '[Worker] Error: [review] review aborted: same CODE error repeated 3 rounds, fix-loop not converging: Review blocked: 1 critical issues'
);
eq(fpJ1, fpJ3, '[J.3] same stage with different host wrapper must collapse');

// ── Cap at 100 chars ───────────────────────────────────────────────────

var long = 'x'.repeat(300);
var fpJ = normalizeFingerprint(long);
assert.ok(fpJ.length <= 100, '[J.1] cap at 100: got ' + fpJ.length);
var fpK = normalizeFingerprint(long, { stage: 'codegen' });
assert.ok(fpK.indexOf('codegen|') === 0, '[K.1] stage prefix added after cap');

console.log('OK — all normalizeFingerprint assertions passed');
console.log('  example A: ' + fpA1);
console.log('  example B: ' + fpB1);
console.log('  example C: ' + fpC1);
console.log('  example F: codegen → "' + fpF1 + '"');
console.log('           review  → "' + fpF2 + '"');
