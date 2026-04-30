#!/usr/bin/env node
/**
 * 2026-04-27: fix-loop circuit breaker must classify as FATAL, not CODE.
 *
 * Background: engine/fix-loop.cjs throws Error with code='FIX_LOOP_CIRCUIT_BREAKER'
 * when the same CODE error repeats N rounds — by definition the inner retries
 * already exhausted, so the outer worker re-running the whole task is wasted work.
 *
 * Pre-fix behavior: the wrapper message ("aborted: same CODE error repeated 3
 * rounds, fix-loop not converging: ...") matched no FATAL/MODEL_FATAL pattern,
 * fell through to default → CODE retryable → outer worker re-ran whole task →
 * re-aborted → 5o2lyu burned 13 abort cycles before watchdog cancelled it.
 *
 * Contract: tagged err.code OR matching message → FATAL retryable=false.
 */

var assert = require('assert');
var { classify } = require('../engine/error-classifier.cjs');

function check(label, err, expectedType) {
  var result = classify(err);
  assert.strictEqual(result.type, expectedType,
    label + ': expected ' + expectedType + ', got ' + result.type + ' (reason: ' + result.reason + ')');
  if (expectedType === 'FATAL') {
    assert.strictEqual(result.retryable, false, label + ': FATAL must not be retryable');
  }
}

// Case 1: tagged code field — primary mechanism
var taggedErr = new Error('cua-verify aborted: same CODE error repeated 3 rounds, fix-loop not converging: phase:progress');
taggedErr.code = 'FIX_LOOP_CIRCUIT_BREAKER';
check('tagged code field', taggedErr, 'FATAL');

// Case 2: tagged code field with unrelated message — code wins (terminal regardless)
var taggedWeirdMsg = new Error('something else entirely');
taggedWeirdMsg.code = 'FIX_LOOP_CIRCUIT_BREAKER';
check('tagged code, unrelated msg', taggedWeirdMsg, 'FATAL');

// Case 3: defense-in-depth — message pattern alone (no code field, e.g. after JSON round-trip)
var msgOnly = new Error('codegen aborted: same CODE error repeated 3 rounds, fix-loop not converging: Blocking static violations: 35');
check('message pattern only (codegen)', msgOnly, 'FATAL');

var msgOnlyReview = new Error('review aborted: same CODE error repeated 3 rounds, fix-loop not converging: Review blocked: 1 critical issues remain after 4 rounds');
check('message pattern only (review)', msgOnlyReview, 'FATAL');

var msgOnlyCua = new Error('cua-verify aborted: same CODE error repeated 10 rounds, fix-loop not converging: phase:progress');
check('message pattern only (cua-verify, N>3)', msgOnlyCua, 'FATAL');

// Case 4: nested wrap — outer breaker wrapping inner breaker (the recursive nesting
// observed in pending-rules.json line 1095 where multiple "aborted: ... aborted: ..."
// chained from successive worker re-tries).
var nested = new Error('cua-verify aborted: same CODE error repeated 3 rounds, fix-loop not converging: cua-verify aborted: same CODE error repeated N rounds, fix-loop not converging: cua-verify failed after N rounds');
check('nested wrap', nested, 'FATAL');

// Case 5: similar-looking but NOT a circuit-breaker message — must NOT misclassify
var similarButNotBreaker = new Error('cua-verify failed after N rounds');
var similarResult = classify(similarButNotBreaker);
assert.notStrictEqual(similarResult.type, 'FATAL',
  'plain "failed after N rounds" without "fix-loop not converging" must not match circuit-breaker FATAL');

// Case 6: prefixed by "Pipeline failed at <stage>:" (unwrapped before classification)
var prefixed = new Error('Pipeline failed at cua-verify: cua-verify aborted: same CODE error repeated 3 rounds, fix-loop not converging: phase:progress');
check('Pipeline-prefix wrapped breaker', prefixed, 'FATAL');

// Case 7: bracketed stage prefix — same unwrap path
var bracketed = new Error('[cua-verify] cua-verify aborted: same CODE error repeated 3 rounds, fix-loop not converging: phase:progress');
check('bracketed stage prefix', bracketed, 'FATAL');

// Case 8: schema fallback timeout already consumed the expensive backend window.
// The codegen stage must not retry the same 50K+ schema prompt at pipeline level.
var schemaFallbackTimeout = new Error('Schema generation failed: Timed out after 600000ms; Exit code 143');
check('schema fallback timeout', schemaFallbackTimeout, 'FATAL');

console.log('error-classifier fix-loop circuit breaker: 8 cases passed');
