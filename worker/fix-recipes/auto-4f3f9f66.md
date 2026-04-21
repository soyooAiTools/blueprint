# auto-4f3f9f66
## Diagnosis
`spec-validate` auto-corrects entity names in `ctx.blueprint.specs` in-place (e.g. camelCase → canonical) and then fails on *other* blocking errors (missing `triggerNext`, chapter coverage gap, etc.), removing `spec-extract` from `completedStages`. When the pipeline retries `spec-extract` via `tryExecute()` — which bypasses the `canSkip` check — `execute()` sees `bp.specs` that now passes `specsAreReusable()` (entities were auto-corrected), so `beforeFp` is **not nullified** and holds the 11-phase fingerprint. The on-disk cache, saved before `spec-validate` ran, still has the pre-correction entity names and is therefore rejected as stale. With no cache to fall back to, a fresh LLM extraction runs and non-deterministically produces a divergent phaseId set (2/11 overlap), triggering `drift-fatal`. The stage has `maxRetries: 1`, so this fatal fires on every retry cycle, producing 3 consecutive failures per task.

## Root Cause
`engine/stages/spec-extract.cjs:177` — after detecting the cache is stale due to entity mismatch, `beforeFp` is NOT nullified. The stale-cache condition is direct evidence that `bp.specs` was mutated by `spec-validate` since the last extraction, making the `beforeFp` derived from those mutated specs an invalid comparison baseline for a new LLM extraction. The same nullification gap exists at line 180 (cache read exception path).

## Fix
In `engine/stages/spec-extract.cjs`, add `beforeFp = null;` in two places inside the cache-lookup block so that any cache invalidation also invalidates the comparison baseline: