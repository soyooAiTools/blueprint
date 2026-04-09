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
  /EPIPE/i,
  /EAI_AGAIN/i,
  /ENOTFOUND/i,
  /\b401\b/,
  /\b403\b/,
  /\b429\b/,
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
  /DNS resolution/i,
  /getaddrinfo/i,
  /SSL routines/i,
  /certificate/i,
  /CERT_/i,
  /TLS handshake/i,
  /rate limit/i,
  /too many requests/i,
  /EHOSTUNREACH/i,
  /ENETUNREACH/i,
];

var FATAL_PATTERNS = [
  /(?:generator|reviewer|coder).*not available/i,
  /no (?:code )?generator/i,
  /no reviewer/i,
  /Spec validation failed/i,
  /Quality gate failed/i,
];

// CUA and visual-check crashes are infrastructure instability, not fatal config errors.
// Moved out of FATAL so they get exponential backoff + retry.
// CUA time limit is a definitive failure, not a retryable infra issue.
// Moved to FATAL to prevent fix-loop from retrying (which wastes time and
// triggers the pipeline error-propagation bug when combined with canRetry stages).
var CUA_FATAL_PATTERNS = [
  /CUA total time limit/i,
];

var CUA_INFRA_PATTERNS = [
  /CUA crashed \d+ consecutive/i,
  /CUA API unreachable/i,
  /CUA.*timeout/i,
  /CUA infra skip/i,
  /playableagent-infra/i,
  /Xvfb.*could not be started/i,
  /Xvfb.*unavailable/i,
  /VERIFY_SCRIPT missing/i,
  /blueprint_verify\.py not found/i,
  /Local HTTP server failed/i,
  /playwright.*crash/i,
  /playwright.*timeout/i,
  /browser.*closed/i,
  /browser.*disconnected/i,
  /Target closed/i,
  /Page closed/i,
  /Protocol error/i,
  /Navigation failed/i,
  /net::ERR_/i,
  /VLM.*unreachable/i,
  /VLM.*timeout/i,
  /Gemini.*error/i,
  /screenshot.*failed/i,
  /visual.check.*crash/i,
  /headless.*error/i,
  /CDP.*error/i,
  /CDP.*disconnect/i,
  /SiliconFlow.*error/i,
  /SiliconFlow.*timeout/i,
  /Qwen.*API.*error/i,
];

/**
 * Unwrap nested "Pipeline failed at X:" / "[stage] " prefixes to extract root cause.
 * Also handles PipelineError objects.
 */
function unwrapMessage(err) {
  // Handle PipelineError objects
  if (err && err.name === 'PipelineError' && err.rootCause) return err.rootCause;
  var msg = (err && err.message) ? err.message : String(err);
  var prefix = /^(?:Pipeline failed at \w[\w-]*:\s*|\[\w[\w-]*\]\s*)/;
  while (prefix.test(msg)) {
    msg = msg.replace(prefix, '');
  }
  return msg;
}

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
  // Always unwrap nested error prefixes before classification
  var msg = unwrapMessage(err);
  var ctx = context || {};

  // CUA definitive failures — always FATAL, no retry
  for (var cf = 0; cf < CUA_FATAL_PATTERNS.length; cf++) {
    if (CUA_FATAL_PATTERNS[cf].test(msg)) {
      return { type: 'FATAL', retryable: false, backoffMs: 0, reason: msg };
    }
  }

  // CUA-specific infra patterns — check before FATAL since CUA crashes are retryable
  for (var ci = 0; ci < CUA_INFRA_PATTERNS.length; ci++) {
    if (CUA_INFRA_PATTERNS[ci].test(msg)) {
      var cuaConsecutive = (ctx.consecutiveInfra || 0) + 1;
      if (cuaConsecutive >= 5) {
        return { type: 'FATAL', retryable: false, backoffMs: 0, reason: 'CUA infra failure persisted after 5 attempts: ' + msg };
      }
      var cuaBackoff = Math.min(10000 * Math.pow(2, cuaConsecutive - 1), 80000);
      return { type: 'INFRA', retryable: true, backoffMs: cuaBackoff, reason: msg };
    }
  }

  // Check FATAL (highest priority for non-CUA errors)
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

module.exports = { classify: classify, isInfra: isInfra, unwrapMessage: unwrapMessage };
