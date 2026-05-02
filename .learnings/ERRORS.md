# Errors

Searchable catalog of error patterns hit in Blueprint pipeline + their resolution.
Add a new entry whenever a fix lands. Keep it grep-friendly: include exact error
strings, classification, and the fix path.

---

## `Schema generation failed: Timed out after 180000ms; Exit code 143` × 3

**First seen:** 2026-05-02 (`proj_1777128165822_6acnqx`, rerun after Wave D)
**Resolved:** 2026-05-03

**Pattern:**
```
[codegen-schema] [fallback] [codex-text] ⚠️ Timeout 180s, killing
[codegen-schema] [fallback] [codex-text] exit=143 stdout=0c stderr=0c
[codegen] attempt 1/3 failed: Schema generation failed: Timed out after 180000ms; Exit code 143
... repeat ×3 ...
[pipeline] pipeline-end success=false failedAtStage=codegen classification=FATAL
[task] Outer-retry fingerprint FATAL: ... repeated 2x across outer retries
```

**Two-part root cause:**

1. `CODEX_SCHEMA_FALLBACK_TIMEOUT_MS=180000` in `.env` & `worker/.env`
   (introduced by recipe `auto-447aedf6`) is **too aggressive for claude-print
   on a 52KB schema prompt** — memory `project_codex_effort_and_backend_switch`
   notes claude-print stably needs ~10 min for large schema prompts.

2. `engine/pipeline.cjs:378` only short-circuits stage retries on
   `MODEL_FATAL` classification, but the schema timeout pattern is classified
   `FATAL` (`error-classifier.cjs:69`). Without a `FATAL` short-circuit
   branch, `canRetry: true` causes 3× outer retries → 540s wasted per task.

**Fix:**
- Restore safe timeout: `CODEX_SCHEMA_FALLBACK_TIMEOUT_MS=600000` in both `.env`s.
- Add `else if (earlyClassified === 'FATAL')` branch to `pipeline.cjs:378`
  that logs and skips stage retries.
- `pm2 restart linux-worker-1..6 --update-env`.

**How to verify locally:**
```bash
cd /opt/blueprint-editor/worker && node -e "
require('dotenv').config();
console.log('FALLBACK_TIMEOUT:', process.env.CODEX_SCHEMA_FALLBACK_TIMEOUT_MS);"
# expect 600000

node -e "
var c = require('/opt/blueprint-editor/engine/error-classifier.cjs')
  .classify({message:'Schema generation failed: Timed out after 600000ms; Exit code 143'},{stage:'codegen'});
console.log(c.type);"
# expect FATAL
```

**Don't:** lower the timeout to "fail fast" again — outer retries amplify
any fast-fail by 3×, so the math always favors a longer single attempt + a
correct retry short-circuit. The recipe `auto-447aedf6` was a half-measure
and is now superseded.

**Related:** `worker/fix-recipes/auto-8545a535.md`,
`memory/project_codex_effort_and_backend_switch.md`.
