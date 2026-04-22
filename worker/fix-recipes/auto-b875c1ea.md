# auto-b875c1ea

## Diagnosis
The `method-check` stage's `detectContractViolations()` fires a `CRITICAL` violation when AI-generated code contains more than one player field alias (`player`, `Player`, `PlayerAvatar`) across the aggregated partial class files. There is no in-place auto-repair: the stage injects feedback into `feedbackHistory`, invalidates the codegen checkpoint, and throws — forcing a full codegen retry (15-25 min, $5-10). The retry also fails (hit count: 1/1), meaning the feedback message alone is insufficient for the AI to reliably self-correct. The `forbidden-generic-api` violation has an identical structure but already has `autoRepairForbiddenGenericApis()` to handle it in-memory; `player-alias-drift` lacks the equivalent.

## Root Cause
`engine/stages/method-check.cjs:504-515` — `detectContractViolations()` calls `detectPlayerAliasDrift()` which returns mixed aliases; the execute() handler at line 683-703 only injects feedback and throws, with no attempt at word-boundary regex rename before escalating. Compare with the `autoRepairForbiddenGenericApis()` pattern wired in at line 667.

## Fix

### 1. Add `autoRepairPlayerAliasDrift()` function (insert after `autoRepairForbiddenGenericApis`, around line 295):