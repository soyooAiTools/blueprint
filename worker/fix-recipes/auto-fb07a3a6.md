# auto-fb07a3a6

## Diagnosis
In observe/autoPlay mode the worker hard-blocks on `autoplay-zero-steps` (phases whose `autoPlayStepsThisPhase === 0`) and injects `[silent-pass-block] autoplay-zero-steps — …` into `cuaResult.issues`. The engine enters the recode path correctly, but `_buildStuckDiagnosis` resolves `rootCause = 'autoplay_or_idle'` instead of `'autoplay_zero_steps'` because the generic `allIssueText.indexOf('autoplay') >= 0` branch (line 131) fires before the specific `autoplay-zero-steps` branch — since the signal string is a strict substring match. `autoplay_or_idle` advice instructs Claude to set `playerMustAct=true` and disable autoPlay, which is the exact opposite of the correct fix in an observe-mode game. Every recode round reproduces the same signal, the fingerprint repeats three times, and the circuit breaker throws FATAL. A secondary sync-gap risk exists: if the worker ever returns `passed=true` with `autoplay-zero-steps` in `silentSignals`, the engine-side hard-block filter (lines 547–558) was also missing the entry and would have promoted a false pass.

## Root Cause
`engine/stages/cua-verify.cjs:131` — `autoplay-zero-steps` case placed **after** `autoplay || idle` in `_buildStuckDiagnosis` if-else chain; substring shadowing means the specific case is dead code.  
`engine/stages/cua-verify.cjs:553` — engine-side `hardBlockers` filter missing `|| s.indexOf('autoplay-zero-steps') === 0` (sync gap with `worker-playableagent.js:370`).

## Fix

### Change 1 — `_buildStuckDiagnosis`: insert `autoplay-zero-steps` case before generic `autoplay` branch
**File:** `engine/stages/cua-verify.cjs`