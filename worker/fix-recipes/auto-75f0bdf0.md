# auto-75f0bdf0
## Diagnosis
The schema stage is failing before JSON generation because a Claude CLI text backend is being invoked and the organization policy rejects Claude Code subscription access. This is an infrastructure/auth routing failure, not bad schema content. Retrying repeats the same stdout message and burns the codegen retry budget.

## Root Cause
engine/stages/codegen-schema.cjs:534 and worker/codex-code-coder.js:883 — schema text generation can route to `claude-print`; the Claude CLI then prints `Your organization has disabled Claude subscription access for Claude Code` to stdout. worker/codex-code-coder.js:89 also does not classify this exact policy message as MODEL_FATAL, so legacy paths may retry it.

## Fix
Force schema generation and fallback to Codex-only, disable Claude fallback, and classify the Claude policy rejection as fatal if any legacy path reaches it.

In `engine/stages/codegen-schema.cjs`:
- In `generateSchemaTextWithFallback`, ignore `SCHEMA_PRIMARY_BACKEND=claude-print`.
- Call `runCodexText` with:
  - `backend: 'codex-exec'`
  - `model: runnerConfig.codexModel`
  - `noTools: true`
  - `allowBackendFallback: false`
- In `runSchemaFallback`, use:
  - `backend: 'codex-exec'`
  - `model: runnerConfig.codexFallbackModel`
  - `allowBackendFallback: false`
- Add the Claude policy message to fatal retry suppression:
  `Your organization has disabled Claude subscription access|disabled Claude subscription access`

In `worker/codex-code-coder.js`:
- Update `isModelFatalStream()` from:
  `/quota|usage limit|hit your usage limit|purchase more credits|insufficient|\b401\b|\b402\b|\b403\b|invalid.?api.?key|unauthoriz|authentication.?fail|access.?denied|billing/i`
- To:
  `/quota|usage limit|hit your usage limit|purchase more credits|insufficient|\b401\b|\b402\b|\b403\b|invalid.?api.?key|unauthoriz|authentication.?fail|access.?denied|disabled Claude subscription access|Your organization has disabled Claude subscription access|billing/i`
- Ensure codex-exec text fallback only runs Claude when explicitly enabled:
  `var allowFallback = opts.allowBackendFallback === true && !isClaudeDisabled();`

In `.env` and `worker/.env`, pin:
`BLUEPRINT_DISABLE_CLAUDE=1`
`BLUEPRINT_TEXT_RUNNER=codex-exec`
`CODEX_CODE_BACKEND=codex-exec`
`CODEX_SCHEMA_PRIMARY_COOLDOWN_MS=off`

## Verification
node -c /opt/blueprint-editor/engine/stages/codegen-schema.cjs && node -c /opt/blueprint-editor/worker/codex-code-coder.js