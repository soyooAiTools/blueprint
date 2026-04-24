# auto-3f0aaa8b
## Diagnosis
When the Python CUA agent reports `pre_contamination.fatal = true` (≥50 % of blueprint spec phases completed before the observe window opened), `detectObservationProtocolFailure()` returns a non-null object and the handler at lines 560–564 of `cua-verify.cjs` immediately throws the error as a hard FATAL. No recode is ever attempted. Because `cua-verify` has `canRetry: false`, each subsequent task-level retry re-runs the exact same compiled code, immediately hits the same condition, and throws FATAL again — producing the observed 2-retry-across-1-task burn pattern with zero net fixes applied.

The underlying defect is a codegen one (phases batch-fire because the generated C# lacks `phaseTimer >= 20` minimum-duration gates), which is fully recoverable with a targeted recode. The observation-protocol check should allow one recode attempt before escalating to FATAL.

## Root Cause
`engine/stages/cua-verify.cjs:560–564` — unconditional `throw` inside the `observationProtocolFailure` guard, with no counter-gating or recode fallthrough.

## Fix

### Step 1 — add a per-loop counter (insert after `var _visualFreezeRegenAttempted = false;`, ~line 355)