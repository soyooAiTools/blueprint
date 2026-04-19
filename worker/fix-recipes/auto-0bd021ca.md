# auto-0bd021ca

## Diagnosis
When `ctx.blueprint.specs` is pre-populated from the database export, `spec-extract.canSkip` (line 31-37) returns `true` immediately, skipping the entire stage. This bypasses both the 3-layer entity-name correction in `adapters/spec-extractor.cjs` (case-insensitive → substring → word-split, lines 253-355) **and** the case-sensitive reusability check already present in `spec-extract.execute()` (lines 56-64). The stale camelCase entity refs (e.g. `forgeWorkshop` vs blueprint-canonical `ForgeWorkshop`) then hit `spec-validate`, which is set `canRetry: false`, so a single validation failure terminates the pipeline with no recovery path. While `spec-validate` has its own case-insensitive auto-fix (added 2026-04-16), it only covers pure case differences and not abbreviated or otherwise divergent names, leaving the recurring failures unresolved across 12 retries.

## Root Cause
`engine/stages/spec-extract.cjs:31-37` — `canSkip` returns `true` for any non-empty `ctx.blueprint.specs` without checking whether those specs' entity references are consistent with the current `ctx.blueprint.entities`. The reusability check that guards the **file-cache** path (lines 56-64 in `execute`) is never applied to the **DB-loaded** specs path.

## Fix
Promote the entity-reusability check into `canSkip` so stale DB specs force re-extraction (which triggers spec-extractor's full correction pipeline):