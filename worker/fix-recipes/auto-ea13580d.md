# auto-ea13580d
## Diagnosis
The report is field-diff-only: pixel gate is clean, but the target snapshot for phase2 still shows `Phase 1/5`, phase1 guide text, and phase1 visible entities. That means the render is alive, but the fidelity harness is not actually driving the built Luna target into later source phases. The first hard block appears as 8 phase2 diffs because phase2 source entities/guide text are compared against target phase1 state.

## Root Cause
`worker/linux-bridge-build.js:3986` — `driveLoopComponentToPhase()` calls `Phase_<id>_Init()` and then `UpdateGameState()`, but failing builds do not call `ApplyFidelityPhaseVisibility(targetIdx)` or `Snapshot_<id>_GateEntities()` before the next `__gameState()` extraction, so the extractor keeps reading phase1 runtime visibility.

## Fix
In `worker/linux-bridge-build.js`, inside `driveLoopComponentToPhase(loopComp, phaseNumber)`, insert this immediately after the `Phase_*_Init` call and before `UpdateGameState()`: