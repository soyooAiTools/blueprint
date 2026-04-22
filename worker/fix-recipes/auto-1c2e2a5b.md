# auto-1c2e2a5b
## Diagnosis
When `method-check` detects the three contract violations (`duplicate-state-fields`, `forbidden-generic-api`, `player-alias-drift`) it correctly pushes them to `ctx.blueprint.feedbackHistory` and rejects — but it never removes `codegen` from `ctx.completedStages`. On every subsequent pipeline retry the checkpoint causes `codegen` to be skipped entirely, so the AI never sees the feedback, the same bad code is fed straight back to `method-check`, and the stage rejects with the identical error. This creates a permanent spin loop, explaining 14 retries across 4 tasks with zero forward progress. The fix is the exact pattern already used in `spec-validate.cjs` (lines 447–453) for `spec-extract`: invalidate the upstream stage's checkpoint before rejecting, forcing a fresh codegen run on the next attempt.

## Root Cause
`engine/stages/method-check.cjs` — three `Promise.reject()` sites:
- **line 527** (contract violations — the primary fingerprint path)
- **line 559** (phase-gate contract violations)
- **line 579** (missing methods)

None of these remove `codegen` from `ctx.completedStages` before rejecting, whereas `spec-validate.cjs:447–453` does the analogous invalidation of `spec-extract`.

## Fix
In `engine/stages/method-check.cjs`, add a shared checkpoint-invalidation helper and call it at all three rejection sites.

### 1. Add helper function (place after `injectMissingHelpers`, before `buildAggregateCode`, around line 239)