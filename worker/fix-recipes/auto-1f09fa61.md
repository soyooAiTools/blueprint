# auto-b4e82f17
## Diagnosis
The `source-html-bind` gate fires because `resolveSourceHtmlPath()` probes only four candidates: `blueprint.sourceHtmlPath`, `blueprint.storyboard.htmlPath`, `blueprint.visualAssets.source`, and `env.SOURCE_HTML_PATH`. When a task carries the path at the **task level** (`task.sourceHtmlPath` / `task.source_html_path`) it is silently skipped, all four candidates come up empty, and `assertBefore` throws (hard-fail) or warns but leaves `ctx.sourceHtmlPath` null for every downstream fidelity check.
The error message already says `"blueprint/task/env"` and names `task.sourceHtmlPath` as a valid field — the code never actually probes it, so the message is both misleading for operators and wrong in the v2 file header comment.

## Root Cause
`engine/stages/source-html-bind.cjs:46` — `resolveSourceHtmlPath()` candidate list omits `ctx.task.sourceHtmlPath` and `ctx.task.source_html_path`; error message at line 83 references them as valid inputs but the code never checks them.

## Fix

### 1. Add task-level probes to `resolveSourceHtmlPath()` (after `visualAssets.source`, before `env`)