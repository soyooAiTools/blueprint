# auto-751aeb4f
## Diagnosis
In `cua-verify.cjs`, the `visual_freeze` / `codegen_init_failure` escalation block (line 669) used `consecutiveSameIssue < SAME_ISSUE_REGEN_THRESHOLD` to decide whether to attempt a full regen before throwing FATAL. Because `consecutiveSameIssue` is a cross-streak counter—reset only on `isProgressing`, never at the start of a new no-progress streak—it can carry a value ≥ 3 from a prior issue category. When a new `visual_freeze` streak begins and `_noProgressRounds` first reaches 2, the `else` (FATAL) branch fires immediately without ever attempting a full regen in the current streak, producing the error "Visual freeze FATAL: 2 consecutive rounds — surgical and full-regen both failed."

The fix introduces a per-streak boolean `_visualFreezeRegenAttempted` (initialized `false`, reset to `false` on `isProgressing`) that replaces the cross-streak `consecutiveSameIssue` guard. A companion fix (auto-28eae46e) adds a `_noProgressRounds >= 4` minimum guard so the regenerated code gets at least 2 post-regen CUA verification passes before FATAL is allowed.

## Root Cause
`engine/stages/cua-verify.cjs:670` — old guard `if (consecutiveSameIssue < SAME_ISSUE_REGEN_THRESHOLD)` inside the visual_freeze escalation block was evaluated against a cross-streak counter; when that counter was already ≥ 3, the FATAL `else` branch fired at `_noProgressRounds=2` with no full-regen attempted.

## Fix

### 1. Add per-streak tracker variable (after line 302, before the `createFixLoop` call)