# auto-a89f0b63
## Diagnosis
When the CUA stage observes a game that never starts (0 phases completed), the `_buildStuckDiagnosis` function was relying on a narrow `VISUAL_FREEZE_PHRASES` keyword list that missed common VLM synonym phrasings like "virtually identical", "no phase progression", and "essentially unchanged". This kept `rootCause` at `'unknown'` so the `visual_freeze` fast-fail path never triggered, and the old execute-level threshold of `_noProgressRounds >= 3` allowed 3 expensive recode+rebuild cycles (~$15, ~45 min) before finally throwing. A secondary residual bug in the `isProgressing` guard (`&& lastPhaseCompleted > 0`) silently discards the first real phase completion (0 → 1), causing `_noProgressRounds` to falsely increment even on rounds where the fix is working.

## Root Cause
`engine/stages/cua-verify.cjs:300` — `isProgressing` condition uses `lastPhaseCompleted > 0` instead of `>= 0`: