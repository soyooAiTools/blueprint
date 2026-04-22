# auto-0f4f1f0c
## Diagnosis
`method-check` calls `detectContractViolations` on `buildAggregateCode(ctx.csCode, ctx.extraFiles)` — i.e. the combined text of ALL partial class files. The post-fix block in `generateWithCodex` (worker/codex-code-coder.js ~L1355–1363) applies `.GetComponent<T>()` → non-generic replacement **only to `mainSrc`** (GameFlowManagerMain.cs) and then writes it back. Any `GetComponent<T>` calls emitted by the AI into `Systems.cs`, `Flow.cs`, `Input.cs`, `Resource.cs`, `UI.cs`, or `Scene.cs` are never sanitized, so they survive into `ctx.extraFiles` and trip the `forbidden-generic-api` gate every run.

Separately, the `player-alias-drift` feedback message (`"Generated code must use one consistent skeleton-owned player symbol"`) does not name the canonical form. The AI has no unambiguous instruction to resolve the conflict, so it continues emitting mixed `player`/`Player`/`PlayerAvatar` symbols across the 23 retry iterations.

## Root Cause

**Primary — `forbidden-generic-api`:**
`worker/codex-code-coder.js` lines 1355–1363 — post-fix loop is scoped to `mainSrc` only; no equivalent pass over `GameFlowManagerMain.Systems.cs` or any W1b-5-partial companions (`Flow`, `Input`, `Resource`, `UI`, `Scene`).

Also: the existing regex `/\.GetComponent<(\w+)>\(\)/g` does not match the detector's more permissive `/\.GetComponent\s*<\s*...\s*>\s*\(/g`, so AI-emitted forms with whitespace (e.g. `.GetComponent< Renderer >()`) are caught by the gate but missed by the sanitizer.

**Secondary — `player-alias-drift`:**
`engine/stages/method-check.cjs` line ~352 — the violation message is non-prescriptive; it names the aliases found but not the canonical replacement, so feedback-loop AI repairs fail to converge.

## Fix

### 1. `worker/codex-code-coder.js` — extend post-fix to all partial files (lines 1355–1363)

**Replace** the existing post-fix block: