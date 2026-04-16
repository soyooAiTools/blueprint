# auto-31abab6b
## Diagnosis
The `MAX_CUA_TOTAL_MS` (45 min) wall-clock guard in `cua-verify.cjs` is only evaluated at the **top** of `attempt()` (line 208–211), before `runCUAVerification` is called. A complete CUA round (verification ≈ 3–5 min) + Opus recode (≈ 3–5 min) + rebuild can easily add 8–10 min. If a round starts at ~43 min total elapsed, the guard passes, the round runs to completion at ~48 min, and the **next** round's guard fires 2 min past the limit. There is no guard before the expensive `recode()` / `patchRecode()` dispatch, which is the point of no return for the overshoot.

## Root Cause
`engine/stages/cua-verify.cjs:208–211` — time guard placed before CUA verification only; no guard before the subsequent recode call that causes actual budget breach.

## Fix
Add a pre-recode time guard immediately before the `cuaFixPromise` dispatch block (around line 427). If elapsed exceeds `MAX_CUA_TOTAL_MS - 5 * 60 * 1000` (i.e., within the last 5 minutes of budget), skip another expensive recode cycle and throw immediately with the standard error message.

**In `engine/stages/cua-verify.cjs`**, locate the comment `// Surgical vs full regen hint` (line ~414) and insert the guard just before the `var isSurgicalFix = ...` line: