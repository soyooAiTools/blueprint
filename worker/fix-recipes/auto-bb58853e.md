# auto-bb58853e

## Diagnosis
When the pipeline routes through the schema codegen path (`codegen-schema.cjs`), it calls `resolveEntities(ctx.blueprint.specs, ctx.blueprint.entities)` unconditionally at line 31. If the incoming blueprint has no `specs` field (e.g., tasks that skipped spec-extraction, or legacy blueprints), `ctx.blueprint.specs` is `undefined`. Inside `resolveEntities`, the very first loop at line 21 evaluates `specs.length` with no null/undefined guard, throwing `TypeError: Cannot read properties of undefined (reading 'length')`. This crash retries the codegen stage up to `maxRetries` times and then fails the task. The legacy codegen path (`codegen-legacy.cjs:43`) is already safe because it wraps the same call in `if (ctx.blueprint.specs && ctx.blueprint.specs.length > 0)`.

## Root Cause
`adapters/entity-resolver.cjs:21` — `for (var i = 0; i < specs.length; i++)` with no guard when `specs` is `undefined`.

Triggered by: `engine/stages/codegen-schema.cjs:31` — `resolveEntities(ctx.blueprint.specs, ctx.blueprint.entities)` called without checking `ctx.blueprint.specs`.

## Fix

### Fix 1 — Primary: guard at function entry in `adapters/entity-resolver.cjs`