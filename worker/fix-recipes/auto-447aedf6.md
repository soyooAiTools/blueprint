# auto-447aedf6 — SUPERSEDED 2026-05-03

> ⚠️ This recipe is **superseded** by the fix in commit `d392da1`
> (180s → 600s + `pipeline.cjs` FATAL short-circuit). The proposed action
> below — lowering `CODEX_SCHEMA_FALLBACK_TIMEOUT_MS` to 180000 — is now
> known to be **harmful** because claude-print stably needs ~10 min for
> large schema prompts (memory `project_codex_effort_and_backend_switch`).
> The original 30-min waste this recipe targeted is now prevented by the
> pipeline-level FATAL short-circuit instead. This file is kept only as
> historical context; it has been removed from `fix-recipes.json` so the
> auto-fix engine no longer matches it.
> See `docs/INCIDENTS.md` 2026-05-03 entry and `.learnings/ERRORS.md`.

## Diagnosis
`generateSchemaTextWithFallback()` tries a primary `codex-exec` backend first; when that backend returns an infra/model error (`isSchemaInfraError` match), it falls through to `runSchemaFallback()`, which spawns a `claude --print` process with `timeoutMs: resolveSchemaFallbackTimeoutMs()`. That resolver's hardcoded default is **600 000 ms** (10 min). When the claude-print process is idle/stalled, the `setTimeout` fires after 10 min, sends SIGTERM (exit code 143), and `runCodexText` builds the error string `"Timed out after 600000ms; Exit code 143"`. Back in `generateSchemaFromSpecs`, `isSchemaNonRetryableError` correctly suppresses the *inner* two retries, but the pipeline stage carries `canRetry: true`, so the whole codegen stage retries up to 3 times — each burning another 600 s — before ultimately failing with "Schema generation failed: Timed out after 600000ms; Exit code 143".

## Root Cause
`engine/stages/codegen-schema.cjs:376` — hardcoded fallback default of `600000`: