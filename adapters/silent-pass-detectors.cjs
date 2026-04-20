// Source: adapters/silent-pass-detectors.cjs
/**
 * Pure detectors for silent-pass signals L8+. Extracted so worker
 * (worker-playableagent.js) and engine (engine/stages/cua-verify.cjs)
 * share the same logic and so the rules are unit-testable.
 *
 * Each detector takes minimal primitives (never the live report) and
 * returns either a signal string (to push into silentPassSignals) or null.
 *
 * Earlier layers (L1-L7) still live at their original sites because their
 * detection is tightly coupled to the surrounding data-shape — this module
 * is only for new rules added from D2 onward.
 */

var BATCH_COMPLETION_MAX_SPAN_SEC = 2;
var BATCH_COMPLETION_MIN_PHASES = 3;
var NO_TIMESTAMPS_MIN_DECLARED = 2;

/**
 * L8: phaseTimestamps span ≤ BATCH_COMPLETION_MAX_SPAN_SEC seconds across
 * ≥BATCH_COMPLETION_MIN_PHASES phases means every AddCompletedPhase fired
 * in essentially one tick — pathological vs real autoPlay whose phaseTimer
 * spaces transitions ≥12s apart. Distinct from L2 (uniform-timing), which
 * catches evenly-spaced intervals regardless of span.
 *
 * @param {number[]} tsValuesSortedSeconds — phase completion timestamps in seconds, ascending
 * @returns {string|null}
 */
function detectBatchCompletion(tsValuesSortedSeconds) {
  if (!Array.isArray(tsValuesSortedSeconds) || tsValuesSortedSeconds.length < BATCH_COMPLETION_MIN_PHASES) return null;
  var first = tsValuesSortedSeconds[0];
  var last = tsValuesSortedSeconds[tsValuesSortedSeconds.length - 1];
  var span = last - first;
  if (!(span >= 0)) return null; // NaN or unsorted → skip
  if (span <= BATCH_COMPLETION_MAX_SPAN_SEC) {
    return 'batch-completion:span=' + span.toFixed(1) + 's,phases=' + tsValuesSortedSeconds.length;
  }
  return null;
}

/**
 * L9: passed=true with zero phase timestamps despite the spec declaring
 * phases — phase tracking is completely inert but VLM passed the run.
 *
 * @param {boolean} passed — VLM-reported pass flag
 * @param {number} declaredPhases — specPhases.length from the blueprint
 * @param {number} tsCount — count of recorded phase timestamps
 * @returns {string|null}
 */
function detectNoPhaseTimestamps(passed, declaredPhases, tsCount) {
  if (!passed) return null;
  if (!Number.isFinite(declaredPhases) || declaredPhases < NO_TIMESTAMPS_MIN_DECLARED) return null;
  if (tsCount !== 0) return null;
  return 'no-phase-timestamps:declared=' + declaredPhases;
}

/**
 * Prefixes the outer filter must treat as hard-block. Mirror list — keep
 * both worker filter and engine filter in sync by importing from here.
 */
var L8_L9_HARD_BLOCK_PREFIXES = ['batch-completion', 'no-phase-timestamps'];

module.exports = {
  detectBatchCompletion: detectBatchCompletion,
  detectNoPhaseTimestamps: detectNoPhaseTimestamps,
  L8_L9_HARD_BLOCK_PREFIXES: L8_L9_HARD_BLOCK_PREFIXES,
  _constants: {
    BATCH_COMPLETION_MAX_SPAN_SEC: BATCH_COMPLETION_MAX_SPAN_SEC,
    BATCH_COMPLETION_MIN_PHASES: BATCH_COMPLETION_MIN_PHASES,
    NO_TIMESTAMPS_MIN_DECLARED: NO_TIMESTAMPS_MIN_DECLARED,
  }
};
