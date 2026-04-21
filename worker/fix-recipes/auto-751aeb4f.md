# auto-751aeb4f
## Diagnosis
The `visual_freeze` fast-escalation block in `cua-verify.cjs` gated the "first attempt → full regen" vs "already tried → FATAL" decision on `consecutiveSameIssue < SAME_ISSUE_REGEN_THRESHOLD`. Because `consecutiveSameIssue` is a **cross-streak** counter that resets to **1** (not 0) when `isProgressing` fires, it only needs two further no-progress rounds to reach `SAME_ISSUE_REGEN_THRESHOLD` (3). This caused FATAL to fire at `_noProgressRounds=2` — the very round a full-regen *should* have been scheduled — producing the log `"Visual freeze FATAL: 2 consecutive rounds — surgical and full-regen both failed"`.

The exact scenario: a prior progress event resets `_noProgressRounds=0` and `consecutiveSameIssue=1`; the next two no-progress rounds of the same category increment `consecutiveSameIssue` to 3, satisfying the old `else { throw }` branch at `_noProgressRounds=2` before `_visualFreezeRegenAttempted` could have been set.

## Root Cause
`engine/stages/cua-verify.cjs` — the `visual_freeze` escalation block inside the `else { _noProgressRounds++ }` branch (pre-fix lines ≈ 650–670):