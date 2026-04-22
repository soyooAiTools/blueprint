# auto-751aeb4f

## Diagnosis
`consecutiveSameIssue` is a cross-streak counter: it resets to `1` only when `isProgressing=true` or the issue category changes, never when `_noProgressRounds` resets to `0` on phase progress. When the game later stalls at a new phase (starting a fresh no-progress streak), `consecutiveSameIssue` already equals `SAME_ISSUE_REGEN_THRESHOLD` (3) from the prior streak's accumulation. The old escalation guard (`consecutiveSameIssue < SAME_ISSUE_REGEN_THRESHOLD`) therefore evaluates to `false` the very first time `_noProgressRounds` reaches `2`, routing directly to the FATAL `throw` with the message "Visual freeze FATAL: 2 consecutive rounds — surgical and full-regen both failed" — even though **no full-regen was attempted in the current no-progress streak**. This wastes all remaining CUA budget on a FATAL abort instead of a recovery attempt.

## Root Cause
`engine/stages/cua-verify.cjs` — the old `visual_freeze` escalation guard at the block starting around line 677: