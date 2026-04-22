# auto-0f4f1f0c
## Diagnosis
`method-check.cjs` pushes contract violation feedback with `data: violations[vi].data` (an array of strings, e.g. `["GetComponent<Text>"]`). However `codex-code-coder.js` extracts feedback text by checking `fb.data && fb.data.text` first, then `fb.text`, finally falling back to `JSON.stringify(fb)`. Since neither `.text` property exists on the array, the AI always receives a raw JSON blob instead of a human-readable fix instruction — it cannot act on it reliably. Simultaneously, the generic-API post-fix in `generateWithCodex` (step 6, lines 1355–1363) only rewrites `GameFlowManagerMain.cs`; any `GetComponent<T>()` calls written by the AI into `GameFlowManagerMain.Systems.cs` survive untouched, are detected by `detectForbiddenGenericApis`, and re-trigger the violation every retry cycle. Both bugs together produce a non-converging loop that exhausts the retry budget (28 retries / 5 tasks).

## Root Cause
- **Feedback format mismatch**: `engine/stages/method-check.cjs` line 533 — `data: violations[vi].data` (array) should be `data: { text: violations[vi].message }` (object with `.text`)
- **Partial post-fix coverage**: `worker/codex-code-coder.js` lines 1355–1364 — post-fix only rewrites the main file; `GameFlowManagerMain.Systems.cs` and other partials are not processed

## Fix

### 1. `engine/stages/method-check.cjs` — lines 530–540 (contract violation feedback push)

**Before:**