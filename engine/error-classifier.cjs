/**
 * Error Classifier — unified INFRA / CODE / FATAL classification
 *
 * Stages no longer decide error types themselves. The fix-loop calls
 * classify(err, context) and routes retries accordingly:
 *   INFRA → retryable, exponential backoff, no recode
 *   CODE  → retryable, immediate recode
 *   FATAL → not retryable, pipeline terminates
 */

// Definitive model failures — immediately terminate the task (MODEL_FATAL).
// These are NOT transient network blips; they mean the model backend is
// unusable and retrying will burn tokens for no progress. Checked with the
// highest priority in classify() so they win over both CUA and INFRA buckets.
var MODEL_FATAL_PATTERNS = [
  /MODEL_FATAL/i,                 // our explicit marker (thrown by reviewers)
  /quota.?exceeded/i,             // GPT / Codex / Doubao quota
  /insufficient.?quota/i,         // OpenAI standard
  /insufficient.?balance/i,       // Doubao / SiliconFlow
  /\b402\b/,                      // HTTP 402 Payment Required
  /invalid.?api.?key/i,           // OpenAI / Doubao standard
  /authentication.?failed/i,      // Generic auth fail
  /\bunauthoriz(ed|ation)\b/i,    // 401 body text
  /API key not valid/i,           // Google/Doubao standard
  /no.?API.?key/i,                // our own "key missing" sentinel
  /codex.*preflight.*fail/i,      // codex-reviewer preflight explicit
];

var INFRA_PATTERNS = [
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /ENOSPC/i,
  /ENOMEM/i,
  /EPIPE/i,
  /EAI_AGAIN/i,
  /ENOTFOUND/i,
  // Note: 401/403 removed — they're definitive auth failures, not transient.
  // MODEL_FATAL_PATTERNS picks them up via /unauthorized/ and similar.
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
// Codegen init failure is a CODE error (full regen needed), not FATAL.
// Checked before CUA_FATAL so "no phases completed" routes to regen, not termination.
var CUA_CODE_PATTERNS = [
  /Codegen init failure/i,
];

var CUA_FATAL_PATTERNS = [
  /CUA total time limit/i,
  /Visual freeze FATAL/i,
  /Fingerprint repeat FATAL/i,
  /Observation protocol FATAL/i,
  /Pre-contamination FATAL/i,
  /Screenshot sharing FATAL/i,
  /Batch completion FATAL/i,
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
  /Doubao.*error/i,
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
 * @returns {{ type: 'MODEL_FATAL'|'INFRA'|'CODE'|'FATAL', retryable: boolean, backoffMs: number, reason: string }}
 */
function classify(err, context) {
  // Always unwrap nested error prefixes before classification
  var msg = unwrapMessage(err);
  var ctx = context || {};

  // 2026-04-27: fix-loop circuit breaker is terminal by definition. Tagged via
  // err.code = 'FIX_LOOP_CIRCUIT_BREAKER' from engine/fix-loop.cjs. Without this
  // check the wrapper message ("aborted: same CODE error repeated N rounds, fix-loop
  // not converging: ...") matches no FATAL pattern and falls through to default
  // CODE → outer worker re-runs whole task → re-aborts → 5o2lyu burned 13 abort
  // cycles before the watchdog finally cancelled it (regressions.json count=21
  // since 2026-04-23 mostly came from this single task).
  if (err && err.code === 'FIX_LOOP_CIRCUIT_BREAKER') {
    return { type: 'FATAL', retryable: false, backoffMs: 0, reason: msg };
  }
  // Defense-in-depth: also pattern-match the message in case the error is reconstructed
  // (unwrapping, JSON round-trips, IPC) and loses the .code field.
  if (/aborted: same CODE error repeated \d+ rounds, fix-loop not converging/i.test(msg)) {
    return { type: 'FATAL', retryable: false, backoffMs: 0, reason: msg };
  }

  // Highest priority: definitive model failures (quota / auth / invalid-key / preflight).
  // Route these to MODEL_FATAL so the worker can cancel the task outright instead of
  // burning retries or silently passing review. See project_pipeline_fixes_20260415.md.
  for (var mf = 0; mf < MODEL_FATAL_PATTERNS.length; mf++) {
    if (MODEL_FATAL_PATTERNS[mf].test(msg)) {
      return { type: 'MODEL_FATAL', retryable: false, backoffMs: 0, reason: msg };
    }
  }

  // CUA codegen-level failures — regen needed, not terminal
  for (var cc = 0; cc < CUA_CODE_PATTERNS.length; cc++) {
    if (CUA_CODE_PATTERNS[cc].test(msg)) {
      return { type: 'CODE', retryable: true, backoffMs: 0, reason: msg };
    }
  }

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
