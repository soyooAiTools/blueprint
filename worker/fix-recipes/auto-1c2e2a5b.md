# auto-1c2e2a5b
## Diagnosis
`detectContractViolations()` in `method-check.cjs` scans the full aggregate of `ctx.csCode` **plus all `ctx.extraFiles`** (including `GameFlowManagerMain.Systems.cs` and any other partial-class files). However, the generic-API post-fix in `generateWithCodex()` only rewrites `mainFilePath` (`GameFlowManagerMain.cs`); any `.GetComponent<T>()` calls written by the LLM into the Systems or other partial files are never touched. Every pipeline retry therefore re-encounters `forbidden-generic-api`, and because the violation is never automatically cleared, the task burns all 21 retries without making progress.

The two accompanying violations (`duplicate-state-fields`, `player-alias-drift`) do not have automated post-fixes either, but they worsen with each retry because `method-check` **appends** a new identical feedback entry to `feedbackHistory` without checking whether the same rule was already reported — drowning the LLM in repeated noise and further reducing fix quality.

## Root Cause
`worker/codex-code-coder.js` lines **1355–1364** — post-fix applied only to `mainFilePath`: