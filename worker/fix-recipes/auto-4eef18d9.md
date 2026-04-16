# auto-4eef18d9
## Diagnosis
The LLM spec extractor consistently camelCases entity names in `spec.entitiesRequired[].name`
(e.g. `forgeWorkshop`) even though `blueprint.entities` registers them in PascalCase
(e.g. `ForgeWorkshop`). The validation at line 91 of `spec-validate.cjs` uses a strict
`Set.has()` lookup — case-sensitive — so the check always fails for these entries and a
blocking error is pushed. Because the stage declares `canRetry: false`, the pipeline cannot
self-recover; the worker re-queues the full task, the LLM produces the same camelCase name,
and the cycle repeats (observed: 4 re-extractions before manual intervention).

## Root Cause
`engine/stages/spec-validate.cjs:91` — `entityNames.has(ent.name)` performs a strict
case-sensitive Set lookup. Before the case-insensitive fallback (lines 92–97, committed
2026-04-16) was present, any camelCase entity reference fell through directly to
`errors.push(...)` with no recovery path.

## Fix
Insert a case-insensitive lookup + in-place name normalisation immediately after the
exact-match check. The `entityLowerToCanonical` index (already built at lines 56–65)
maps `lowercase(e.name) → canonicalName`.