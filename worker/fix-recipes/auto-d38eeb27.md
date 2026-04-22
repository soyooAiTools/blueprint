# auto-d38eeb27
## Diagnosis
The schema codegen path (`codegen-schema.cjs`) generates multiple `GameFlowManagerMain*.cs`
partial files (up to 6 in W1b-5partial mode). The skeleton generator or template-fill engine
can emit the same `*State` field declaration in more than one partial (e.g., `int FooState = 0;`
in both `GameFlowManagerMain.cs` and `GameFlowManagerMain.Resource.cs`).
`detectDuplicateStateFields` concatenates all task partials via `buildTaskAggregateCode()`,
counts occurrences, and fires correctly — but unlike `forbidden-generic-api` (which has
`autoRepairForbiddenGenericApis` stripping the offending calls before the contract check),
**no equivalent auto-repair exists for `duplicate-state-fields`**. The stage rejects, the
codegen checkpoint is invalidated, and the next pipeline run re-generates code that often
contains the same duplication — explaining the 2-retry-across-2-tasks hit pattern.

## Root Cause
`engine/stages/method-check.cjs` — `execute()`, lines 662–703:
`detectContractViolations()` is called without a prior deduplication pass for `*State` fields,
even though the identical repair pattern (`autoRepairForbiddenGenericApis`, lines 667–669)
already exists for the `forbidden-generic-api` contract. The missing function is
`autoRepairDuplicateStateFields`.

## Fix

### 1 — Add `autoRepairDuplicateStateFields()` after `autoRepairForbiddenGenericApis` (after line 295)