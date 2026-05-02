# Learnings

Generalizable lessons from Blueprint pipeline debugging that go beyond a single
error pattern. Read this before designing new pipeline / retry / classifier
behavior — past mistakes are documented here so they don't get re-introduced.

---

## Outer retries multiply timeouts; "fail-fast via short timeout" is a trap

**Date:** 2026-05-03
**From:** schema timeout 180s → 600s + pipeline FATAL short-circuit fix.

When a pipeline stage has `canRetry: true` and the underlying error path is
deterministic (timeout, parse failure, classifier-tagged FATAL), shortening
the per-attempt timeout does NOT reduce wasted compute — the outer retry loop
multiplies it. e.g. `180s × 3 retries = 9 min` worse than `600s × 1` with a
proper FATAL short-circuit.

**Rule:** before touching a stage's per-attempt timeout, audit whether the
outer retry loop respects the error's classification. If a single attempt
already wastes ≤ N minutes on a deterministic failure, retrying without a
behavior change is pure waste.

**Concrete check:** `error-classifier.cjs` already returns `retryable: false`
for many failure types. Any place in the codebase that invokes
`stage.canRetry` must first call `classify()` and short-circuit on
`MODEL_FATAL` AND `FATAL` (not only the former).

---

## `MODEL_FATAL` and `FATAL` are both non-retryable, but only one is honored

**Date:** 2026-05-03

`engine/error-classifier.cjs` returns four types:
`MODEL_FATAL` / `INFRA` / `CODE` / `FATAL`. Both `MODEL_FATAL` and `FATAL`
have `retryable: false` by design (header comment, line 8).

But `engine/pipeline.cjs:378` historically only short-circuited
`MODEL_FATAL`. The `FATAL` bucket (schema timeout, spec validation failure,
quality gate failure, missing generator/reviewer) silently fell through to
`else if (attempt < maxAttempts) return tryExecute()` and got 3× retried.

**Rule:** any new short-circuit / "skip retries" / "terminate" branch must
treat `MODEL_FATAL` and `FATAL` symmetrically unless there's an explicit
written reason otherwise.

---

## Auto-generated recipes can be parallel to a human fix (and disagree)

**Date:** 2026-05-03

`engine/auto-fix.cjs` watches failure fingerprints and, on a previously
unseen pattern, calls an LLM to generate a recipe MD + JSON entry. This is
**asynchronous to whatever a human is doing**: I manually patched the schema
timeout to 600s while the auto-fix system independently produced
`auto-8545a535.md` recommending 480s. Both addressed the same root cause but
landed different values.

**Rule:** when investigating a fresh failure, before editing,
`ls -lt worker/fix-recipes/ | head` to check if auto-fix already produced a
recipe for the same fingerprint. If yes, reconcile — don't ignore.

---

## `.learnings/` is the cross-session continuity layer; populate it eagerly

**Date:** 2026-05-03

`systematic-debugging` skill expects `.learnings/LEARNINGS.md` and
`.learnings/ERRORS.md` to exist as the first checkpoint of any debugging
session. Until 2026-05-03 the directory **didn't exist** in this project —
which means every Claude session started cold and re-investigated patterns
that had already been resolved.

**Rule:** any time a non-trivial fix lands, append to ERRORS.md (the exact
error string + fix) and, when a generalizable lesson exists, to LEARNINGS.md.
This file is grep-able by future sessions and is far cheaper than re-running
Phase 1.
