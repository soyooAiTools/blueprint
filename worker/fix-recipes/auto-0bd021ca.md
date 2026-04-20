# auto-0bd021ca
## Diagnosis
When the LLM spec-extractor hallucinates entity names (e.g. `"DiningHall"`) that do not exist in `blueprint.entities`, `spec-validate` throws at line 446 with no recovery. Because `spec-extract` is already recorded in `ctx.completedStages`, every subsequent worker retry resumes from checkpoint, skips spec-extract entirely, and re-runs spec-validate against the **same** bad specs — looping until the task is abandoned. The spec-extract stage already has the correct guard (`specsAreReusable` cache-invalidation at spec-extract.cjs:172-177) that would trigger a fresh LLM extraction, but it is never reached because the checkpoint prevents re-entry.

## Root Cause
`engine/stages/spec-validate.cjs:34` — `canRetry: false` combined with the blocking `throw` at line 446 that leaves `'spec-extract'` in `ctx.completedStages`. The internal comment at line 169 even names this exact problem (`"canRetry:false + no recovery path"`), but the canRetry flag and the checkpoint invalidation were never corrected to close the loop.

## Fix
In `engine/stages/spec-validate.cjs`, replace the blocking error block (lines 439–447) with a version that strips `spec-extract` from `ctx.completedStages` before throwing. This causes the next worker retry to re-run spec-extract, which finds the cached specs stale via `specsAreReusable` and triggers a fresh LLM extraction.