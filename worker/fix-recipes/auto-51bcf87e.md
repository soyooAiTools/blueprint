# auto-51bcf87e
## Diagnosis
`fidelity-contract-synthesize` was updated on 2026-05-31 to emit `schemaVersion: '1.1.0'`; before that change it emitted `'1.0.0'`. Tasks that were checkpointed before the update have `fidelity-contract-synthesize` recorded in `completedStages` together with a `v1.0.0` contract stored in `checkpoint.blueprint.fidelityContract`. On pipeline resume, `pipeline.run()` skips the synthesize stage entirely via the checkpoint fast-path (neither `canSkip` nor `execute` is invoked), so the stale `1.0.0` contract is never upgraded. `fidelity-contract-produce.execute()` then calls `migrateLib.migrate(base.contract, …)` (line 175) and `migrate-v1.1-to-v1.2.cjs:123` throws because its input guard only accepts `'1.1.0'` or `'1.2.0'`.

## Root Cause
`engine/stages/fidelity-contract-produce.cjs:175` — `migrateLib.migrate(base.contract, …)` is called without first coercing a `v1.0.0` base contract to `v1.1.0`. The throwing guard lives at `scripts/migrate-v1.1-to-v1.2.cjs:123`.

## Fix
In `engine/stages/fidelity-contract-produce.cjs`, replace the bare `migrateLib.migrate` call in the `else` branch (lines 174-179) with a version-coercion shim. `v1.0.0` and `v1.1.0` are structurally identical for this migration; the only behavioural difference (polymorphic-text on `hud[].text`) is irrelevant to the v1.1→v1.2 anchor-extraction step.

**Before (lines 174-179):**