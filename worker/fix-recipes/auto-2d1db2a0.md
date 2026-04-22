# auto-2d1db2a0

## Diagnosis
`method-check` is correctly catching invalid `__Pool_*` literals, but the repair loop still talks about “invalid pool names” at a high level. The coder often regenerates another set of non-spec literals because it is not shown the exact allowed pool-name set for the current blueprint at the moment of repair.

## Root Cause
- `engine/stages/method-check.cjs` detects invalid literals after generation, but only feeds back the failing names, not the approved replacement set.
- `worker/prompt-v5-basetemplate.js` / `worker/codex-code-coder.js` do not consistently restate the exact pool literals that are allowed for the active task during incremental repair.

## Fix
1. In `method-check`, keep emitting the invalid literal list and add the approved pool-name set to structured feedback when available.
2. In the incremental repair prompt, inject a short “Allowed pool literals for this task” block sourced from `blueprint.entities` / `poolManifest`.
3. In reviewer prompts, explicitly forbid dynamic `__Pool_` construction and skeleton remapping unless the literal exists in the allowed set.

## Verify
- Re-run a failed task with `invalid-pool-literals` and confirm the next coder round receives both the invalid list and the approved replacement set.
- Confirm retries stop inventing `__Pool_Cube_Gray_*` / `__Pool_Capsule_*` style names.

## Do Not
- Do not disable the `invalid-pool-literals` contract check.
- Do not silently auto-rewrite pool names without knowing the blueprint-approved mapping.
