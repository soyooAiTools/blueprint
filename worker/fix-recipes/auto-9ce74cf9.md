# auto-9ce74cf9
## Diagnosis
`commitSpecs()` assigns `ctx.blueprint.specs = specs` at line 137 — **before** the drift-fatal guard at lines 141-152. When the first attempt's drift check throws, `ctx.blueprint.specs` has already been overwritten with the freshly-extracted, entity-valid specs. On the `canRetry` second attempt, `execute()` re-enters and computes `beforeFp` from those already-mutated specs; because they are entity-valid `specsAreReusable()` returns `true`, so the nullification guard at line 127-129 does **not** clear `beforeFp`. The second LLM call (non-deterministic) then produces a different phaseId set, and the drift check compares it against attempt-1's output rather than the true canonical baseline — triggering a false `drift-fatal` every retry until `maxRetries` is exhausted.

## Root Cause
`engine/stages/spec-extract.cjs:137` — `ctx.blueprint.specs = specs;` placed before the drift-fatal `throw err` at line 152, leaving corrupt context state on error and poisoning the `beforeFp` baseline on every subsequent retry.

## Fix
Move the `ctx.blueprint.specs = specs;` assignment from line 137 to **after** the full `if (beforeFp && afterFp)` block (after line 160), so that a drift-fatal throw leaves `ctx.blueprint.specs` in its original pre-attempt state and the retry's nullification guard works correctly.

**In `engine/stages/spec-extract.cjs`, replace the `commitSpecs` function body (lines 136-163):**