# auto-a436c2e7

## Diagnosis
The pipeline repeatedly hits `phase-entity-init-only` because entities are snapped before a phase starts, then only moved inside `Phase_<id>_Init()`. Later checks wait for `EntityAdvanced(...)` during gameplay, but no runtime movement ever happens, so the same static-check fingerprint repeats until the circuit breaker aborts.

## Root Cause
- `engine/stages/review.cjs` and `engine/stages/method-check.cjs` can strip some shortcut gates, but they cannot invent missing runtime interactions when the generated phase handlers are empty.
- Prompt guidance still allows the coder to satisfy a phase visually during init instead of through `OnTap` / `OnAutoPlayArrive` / runtime state change.

## Fix
1. Keep `phase-entity-init-only` as a hard blocker in `method-check`.
2. Strengthen the repair prompt so every blocking entity in a phase must be moved or hidden from a runtime handler, not only from `Phase_<id>_Init()`.
3. Include a per-phase reminder in reviewer/coder prompts: if a gate uses `EntityAdvanced(X, _snap_XPos)`, then `X` must move after the snapshot in player/autoplay/runtime code.

## Verify
- Re-run a task that previously failed with `phase-entity-init-only`.
- Confirm the generated fix edits `Phase_<id>_OnTap()` / `OnAutoPlayArrive()` / runtime logic, not only the init block.
- Confirm the next static check no longer reports `phase-entity-init-only`.

## Do Not
- Do not downgrade `phase-entity-init-only` to warning-only.
- Do not “fix” the symptom by removing the gate check while leaving the phase interaction empty.
