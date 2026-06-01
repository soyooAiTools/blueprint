// Pure-data registry: API whitelists, charset definitions, and method lists
// that must stay in sync between static-check rules (engine/static-check.cjs)
// and the deterministic pre-repair functions (engine/stages/review.cjs).
//
// Do NOT add runtime logic here. Adding a new entry here is the single signal
// that "this list is consumed by two places." Before this registry existed the
// non-ascii-resource-key API whitelist was maintained independently in
// static-check.cjs:965 (rule body) AND review.cjs:444 (sanitizeNonAsciiResourceApiKeys);
// drift between the two silently broke fix-loop convergence.
//
// Migration tracking: docs/incidents/deterministic-prerepair-lib-2026-05-31.md
// Step 1 (this commit / Wave 1.b) migrates ONLY the non-ascii-resource-key pair.
// Steps 2-3 will add HOT_PATH_METHODS / CAMERA_* / SETSCALE_* etc. as their
// rule/pre-repair pairs are extracted into engine/lib/static-rule-prerepair.cjs.
//
// API names are stored in CANONICAL form (unescaped dots, e.g.
// 'GFM_ResourceIds.Normalize'). Consumers that build a RegExp from these must
// escape the dots themselves (api.replace(/\./g, '\\.')) — static-check.cjs
// already did this; review.cjs previously stored pre-escaped strings and is
// updated to escape-on-read so both sides share one canonical source.

module.exports = {
  // Resource-API key sanitizer.
  // Consumed by:
  //   - static-check.cjs rule `non-ascii-resource-key` (RESOURCE_API_KEY_APIS)
  //   - review.cjs `sanitizeNonAsciiResourceApiKeys` (both keys below)
  // These APIs take a string-literal arg that becomes a stable runtime identifier
  // (resource id / phase id / entity name); CJK / punctuation / whitespace in that
  // literal leaks prose into the player-visible HUD and must be blocked + repaired.
  RESOURCE_API_KEY_APIS: [
    'AddResource', 'TrySpend', 'GetResource', 'TryConvert',
    'GFM_ResourceIds.Normalize', 'GFM_ResourceIds.Resolve',
    'GameObject.Find', 'CompletePhaseProgress', 'EnterPhase',
    'RecordPhaseEvidenceFlag', 'NotifyPhaseProgress',
  ],
  // Single combined charset used by review.cjs's sanitizer to decide whether a
  // literal needs repair. static-check.cjs keeps its own three per-category
  // regexes (CJK / punct / whitespace) for richer issue messages — intentionally
  // NOT consolidated here, to preserve that rule's message detail (see §6.2 of
  // the incident doc).
  RESOURCE_API_KEY_NON_ASCII_RE: /[一-鿿，。：；！？、,.:;!?\s]/,
};
