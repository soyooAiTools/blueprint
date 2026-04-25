# auto-b49a65c6

## Diagnosis
`method-check.cjs:execute()` calls `detectContractViolations()` → `assemblyPlanContracts.detectAssemblyContractViolations()`. That function iterates every module instance in the assembly plan, extracts `// [ASSEMBLY SLOT] <id>` markers from `ctx.extraFiles`, and fires `assembly-module-owner-mismatch` for each instance whose marker is missing or in the wrong file. Because the AI was never told this magic-comment convention, it produces 4-5 violations per run. The feedback message only says "scaffold ownership drifted / Observed: (none)" — no marker syntax, no concrete action. `invalidateCodegenCheckpoint` correctly forces a codegen retry, but the regenerated code still lacks the markers, so all 3 outer retries burn identically.

## Root Cause
`engine/assembly-plan-contracts.cjs:436-438` — the `assembly-module-owner-mismatch` violation message omits the exact `// [ASSEMBLY SLOT] <moduleInstanceId>` comment syntax the AI must emit. Additionally, there is no `autoRepair*` handler for this violation class (unlike `autoRepairDuplicateStateFields`, `autoRepairForbiddenGenericApis`, etc.), so even a trivially fixable case (code is correct, marker comment simply absent) forces a full codegen retry.

## Fix

### 1. `engine/assembly-plan-contracts.cjs` — patch violation message (line 436-438)

**Before:**