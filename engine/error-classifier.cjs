/**
 * Error Classifier — unified INFRA / CODE / FATAL classification
 *
 * Stages no longer decide error types themselves. The fix-loop calls
 * classify(err, context) and routes retries accordingly:
 *   INFRA → retryable, exponential backoff, no recode
 *   CODE  → retryable, immediate recode
 *   FATAL → not retryable, pipeline terminates
 */

var INFRA_PATTERNS = [
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /ENOSPC/i,
  /ENOMEM/i,
  /\b401\b/,
  /\b403\b/,
  /\b502\b/,
  /\b503\b/,
  /\b504\b/,
  /git clone/i,
  /API unreachable/i,
  /Build timeout/i,
  /SIGTERM/i,
  /SIGKILL/i,
  /disk full/i,
  /out of memory/i,
  /network/i,
  /socket hang up/i,
];

var FATAL_PATTERNS = [
  /not available/i,
  /no (?:code )?generator/i,
  /no reviewer/i,
  /crashed \d+ consecutive/i,
  /Spec validation failed/i,
  /Quality gate failed/i,
];

/**
 * Classify an error.
 *
 * @param {Error|string} err
 * @param {object} [context] — optional hints
 * @param {string} [context.stage] — which stage threw
 * @param {number} [context.consecutiveInfra] — how many infra errors in a row
 * @returns {{ type: 'INFRA'|'CODE'|'FATAL', retryable: boolean, backoffMs: number, reason: string }}
 */
function classify(err, context) {
  var msg = (err && err.message) ? err.message : String(err);
  var ctx = context || {};

  // Check FATAL first (highest priority)
  for (var i = 0; i < FATAL_PATTERNS.length; i++) {
    if (FATAL_PATTERNS[i].test(msg)) {
      return { type: 'FATAL', retryable: false, backoffMs: 0, reason: msg };
    }
  }

  // Check INFRA
  for (var j = 0; j < INFRA_PATTERNS.length; j++) {
    if (INFRA_PATTERNS[j].test(msg)) {
      // After 5 consecutive infra errors, escalate to FATAL
      var consecutiveInfra = (ctx.consecutiveInfra || 0) + 1;
      if (consecutiveInfra >= 5) {
        return { type: 'FATAL', retryable: false, backoffMs: 0, reason: 'Infra failure persisted after 5 attempts: ' + msg };
      }
      // Exponential backoff: 5s, 10s, 20s, 40s
      var backoff = Math.min(5000 * Math.pow(2, consecutiveInfra - 1), 80000);
      return { type: 'INFRA', retryable: true, backoffMs: backoff, reason: msg };
    }
  }

  // Default: CODE error — retryable via recode, no backoff
  return { type: 'CODE', retryable: true, backoffMs: 0, reason: msg };
}

/**
 * Check if an error message looks like an infrastructure issue
 * (convenience for stages that need a quick check without full classify)
 */
function isInfra(err) {
  return classify(err).type === 'INFRA';
}

module.exports = { classify: classify, isInfra: isInfra };
