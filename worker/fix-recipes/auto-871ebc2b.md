# auto-871ebc2b

## Diagnosis
The `source-html-bind` stage's `assertBefore` gate calls `resolveSourceHtmlPath(ctx)`, which probes four candidates in order — `blueprint.sourceHtmlPath`, `blueprint.storyboard.htmlPath`, `blueprint.visualAssets.source`, and `process.env.SOURCE_HTML_PATH`. When tasks are submitted whose `blueprint_json` omits `sourceHtmlPath` (a field that was added shift-left after many tasks were already in flight), all four candidates are empty and the resolver returns `null`. With `SOURCE_HTML_BIND_HARD=true` active in the system environment (confirmed by the `(HARD m…` suffix in the fingerprint), the soft-warn branch is skipped and a hard throw fires immediately, failing the pipeline before any codegen work begins. Additionally, `PipelineContext`'s constructor never inspects top-level task fields (`task.sourceHtmlPath` / `task.source_html_path`), so orchestrators that set the field outside `blueprint_json` are silently ignored. The two retries across one task are worker-level task resubmissions, not stage retries (`canRetry: false`).

## Root Cause
`engine/stages/source-html-bind.cjs:81` — `resolveSourceHtmlPath(ctx)` returns `null`; no blueprint sub-field nor `SOURCE_HTML_PATH` env var is populated, and top-level `ctx.task.sourceHtmlPath` is never consulted. Secondary gap: `engine/pipeline.cjs:70-75` (`PipelineContext` constructor) does not backfill `blueprint.sourceHtmlPath` from top-level task fields before the stage runs.

## Fix

### 1 — `engine/pipeline.cjs` — PipelineContext constructor (lines 70–75)
Backfill `blueprint.sourceHtmlPath` from top-level task fields **before** the existing read, so tasks submitted by orchestrators that set the field outside `blueprint_json` are handled: