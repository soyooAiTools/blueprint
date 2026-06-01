# Codegen Static Pre-Review Stage — Scoping

**Date**: 2026-05-31
**Owner**: codegen pipeline
**Status**: Proposal (no code changes yet)
**Related**: `engine/static-check.cjs`, `engine/stages/{codegen-schema,method-check,review}.cjs`, today's skeleton HOT-PATH / ASCII-ONLY warning boxes + `sanitizeNonAsciiResourceApiKeys` pre-repair.

---

## 1. Problem Statement — Low SNR of Current Fix-Loop

Today (2026-05-31) two guards were added because the AI (gpt-5.5 in `fillCustomLogic`) keeps re-introducing the same blocking violations:

1. `skeleton-generator.cjs`: 12-line HOT-PATH banner before `TODO_UPDATE_START`, ASCII-ONLY banner before `TODO_CUSTOM_START`.
2. `review.cjs`: `sanitizeNonAsciiResourceApiKeys` pre-repair runs every review round (lines 444–484, applied at 2153 main + 2259 partials).

Both are **post-hoc patches**: AI still writes `AddResource("金币", 5)` and `new Vector3(...)` in Update; review either silently rewrites them (LLM never sees the violation) or — when sanitization can't help (e.g. cross-file scope, semantic shifts the LLM would handle better) — burns a recode round with a vague feedback message.

Concrete SNR pain in current `engine/stages/review.cjs:2598`–`2650`:

- LLM reviewer is invoked even when static-check already proves the code is broken.
- The `static-precheck` synthetic failure (line 2640–2650) **does** force a recode without LLM, but the feedback text is unstructured (`STATIC CHECK VIOLATIONS (must fix, these bypass LLM review):\n` + grep-line dump). No remediation hint. AI fixes one violation, introduces another.
- `MAX_REVIEW_ROUNDS = 3` (fix-loop default). Three blocked rounds → circuit breaker fail.
- Visible in today's 7 tasks: most recode rounds are wasted relitigating non-ASCII keys and hot-path `new Vector3` that the AI **didn't know are blocking** because the feedback was a flat blob.

The two new guards reduce frequency, not severity: when AI ignores the banner, the loop still spins.

---

## 2. Goal: Deterministic Static Pre-Review Stage (Plan B)

Insert a new stage `engine/stages/static-pre-review.cjs` between `method-check` and `review`. Pipeline becomes:

```
codegen → method-check → static-pre-review → review
```

Existing `engine/pipeline.cjs:499–520` `createLunaPipeline` only needs one `require` + one array insert at line 510→511.

### 2.1 Inputs

| Field | Source | Notes |
|-------|--------|-------|
| `ctx.csCode` | `codegen-schema.cjs:223,1141,1274` | main partial after `fillCustomLogic` |
| `ctx.extraFiles` | `codegen-schema.cjs:240–245,273` | `.Flow/.Input/.Resource/.UI/.Scene.cs` |
| `ctx.blueprint` | upstream | only for forwarding to rule custom callbacks |

### 2.2 Algorithm

```
issues = staticCheckProject(ctx.csCode, { extraFiles, blueprint, filename:'GameFlowManagerMain.cs' })
blocking = issues.filter(i => i.blocking)
if (blocking.length === 0) return resolve()
err = new Error('STATIC_PRECHECK: <N> blocking violation(s)')
err.classification = 'CODE'        // recognised by engine/error-classifier.cjs
err.structured = blocking          // list with {file,line,rule,message,text}
invalidateCodegenCheckpoint(ctx)   // reuse method-check helper at L1521
pushFeedbackUnique(ctx, structured) // re-use method-check helper at L2074
return reject(err)
```

The fix-loop in `engine/fix-loop.cjs:114` already routes `classified.type === 'CODE'` errors through recode; circuit breaker (`sameErrorStreak`) is honoured. **No fix-loop changes needed.**

### 2.3 Stage Shape

```js
module.exports = { name: 'static-pre-review', canRetry: true, execute: execute };
```

`canRetry: true` matches `codegenStage` so the existing retry chain
(`codegen → method-check → static-pre-review`) re-runs codegen on failure
exactly like `method-check` does today (lines 2089–2090).

---

## 3. Integration Point

```diff
 // engine/pipeline.cjs:510
   codegenStage,
   methodCheckStage,
+  staticPreReviewStage,
   reviewStage,
```

Plus `var staticPreReviewStage = require('./stages/static-pre-review.cjs');` at line 488.

Blast radius:
- Touches only `pipeline.cjs` (1 line) + 1 new file.
- `review.cjs` static-precheck loop (`engine/stages/review.cjs:2607–2651`) becomes a **belt + suspenders** safety net; first round normally finds 0 blocking.

---

## 4. Fix-Loop Re-Use

| Feature | Already supported? | How |
|---------|---|---|
| `errorType = CODE` | Yes | `error-classifier.cjs` classifies non-FATAL non-INFRA as CODE |
| `canRetry: true` | Yes | declared on stage |
| Checkpoint invalidation | Yes | reuse `invalidateCodegenCheckpoint(ctx)` (method-check L1521) |
| Same-error circuit breaker | Yes | `fix-loop.cjs:114` keyed on error signature |
| Structured feedback push | Yes | reuse `pushFeedbackUnique(ctx, {...})` from method-check |
| AI prompt rendering | Yes | `worker/codex-code-coder.js:1258–1263` reads `blueprint.feedbackHistory` and merges via `buildFeedbackText` (L1355) |

The recode entry (`engine/recode.cjs:77 → worker/codex-code-coder.js:generateWithCodex`) already serialises `feedbackHistory` into the system prompt. **We do not invent a new channel**; we push structured entries that already plumb through.

---

## 5. Structured Feedback Format

Each blocking issue produces one block:

```
[<ruleId>] <file>:<line>
  <rendered code line, trimmed>
  REASON: <rule.message>
  FIX: <remediation hint>
```

Concrete example (matches today's two recurring leaks):

```
STATIC CHECK FAILED — 2 blocking violation(s). Fix all before resubmitting.

[non-ascii-resource-key] GameFlowManagerMain.Resource.cs:495
  AddResource("金币", 5);
  REASON: Resource/entity key string literal contains CJK / punctuation /
          whitespace — must be ASCII identifier.
  FIX: Use GFM_ResourceIds.Gold or AddResource("Gold", 5).
       For phase keys use currentPhaseName / RecordPhaseEvidenceFlag(
       currentPhaseName, key).

[hot-path-new-vector3] GameFlowManagerMain.cs:1438
  player.transform.position = player.transform.position + new Vector3(0f, 0f, dz);
  REASON: Update() body allocates Vector3 each frame → GC pressure.
  FIX: Use the pre-declared class field _hotV3.Set(x,y,z) or struct-copy
       pattern (var p = obj.transform.position; p.z += dz; obj.transform.position = p;).
```

### 5.1 Remediation hint source

Add an optional `remediation` field to entries in `engine/static-check.cjs` `RULES[]`. Hint lives next to the rule (single source of truth), default to a generic "see `rule.message`" line when missing. Touches ~58 blocking rules; rollout incremental (start with the 8–10 rules that account for ≥80% of recodes — `non-ascii-resource-key`, `hot-path-new-vector3` (proposed new rule for current `rewriteHotPathVectorAllocations` pattern), `camera-main`, `setactive`, `instantiate`, `forbidden-runtime-ui-creation`, `force-complete`, `setscale-wrong-params`).

### 5.2 Builder function

`engine/stages/static-pre-review.cjs::formatFeedback(blocking)` returns the
multiline string above. Unit-tested via fixtures in `fixtures/static-check/`
(`clean-code.json`, `forbidden-apis.json`).

---

## 6. Coexistence With Existing `review.cjs` Deterministic Pre-Repair

**Recommendation: retain pre-repair as a safety net** (do NOT delete).

| Layer | Order | Role |
|---|---|---|
| 1. static-pre-review (new) | before review | reject + force LLM recode with structured feedback |
| 2. `review.cjs::repairKnownStructuralDamage` (existing) | review round 1 attempt | last-mile deterministic fix for damage that survived the LLM recode |
| 3. `review.cjs` static-precheck synthetic fail (existing) | review round 1 onwards | belt-and-suspenders if static-pre-review missed anything |

Why keep pre-repair:
1. After static-pre-review forces a recode, the AI may still ship near-misses (a single offending line, scoped wrong). The pre-repair (e.g. `sanitizeNonAsciiResourceApiKeys`, `rewriteHotPathVectorAllocations`, `rewriteCameraMainToMainCam`) is cheap and idempotent — converts "near-correct" into "correct" without burning another recode.
2. Removing pre-repair would expose the regression surface highlighted in `feedback_prune_workarounds_after_root_cause.md`: hacks should be **pruned with the root cause fix**, not removed speculatively.
3. The existing `review.cjs:2607–2651` static-precheck loop is the ultimate guard for any rule not yet covered by static-pre-review. Keep it.

**Alternative (rejected for now): full LLM ownership.** Delete pre-repair, let static-pre-review + AI handle everything. Higher purity, but blast radius too large in one commit; cost = at least one extra recode round per task when LLM gets it 90% right. Reconsider after 4 weeks of telemetry showing static-pre-review converges in ≤2 rounds.

---

## 7. Skeleton Self-Compliance Check (Empirical)

**Hypothesis**: skeleton-generator's own output is lint-clean (else `review.cjs` would have exploded long ago).

**Empirical test** (`/tmp/test_skeleton_static3.js`, 2026-05-31):

```
specs:    [intro, tapOre]              (minimal 2-phase fixture)
out:      main 15844 bytes + 5 partials
verdict:  3 "blocking" reports — all false positives
```

The 3 hits:

| Rule | File:Line | Source line in skeleton | Verdict |
|---|---|---|---|
| `camera-main` | main:239 | `var cam = Camera.main;` — should be exempted by `// 正常` marker | needs skeleton fix OR rule tweak |
| `non-ascii-resource-key` | main:349 | `// ║   ✗  AddResource("金币", 5)` — comment inside today's ASCII-ONLY warning banner | rule `custom:` callback does NOT use `buildCodeMask`, so comment isn't masked |
| `non-ascii-resource-key` | main:351 | `// ║   ✗  RecordPhaseEvidenceFlag("中文", k)` — same banner | same |

**Conclusion**: skeleton has 0 *real* blocking violations; the 3 FPs are caused by 2 separate gaps:
1. The 12-line / ASCII-ONLY banner comments added today contain CJK examples and the `non-ascii-resource-key` custom rule (lines 965–999) skips `buildCodeMask`.
2. Line 1272 `var cam = Camera.main;` lacks the exempt suffix `// 正常`.

Both are pre-existing-but-latent: `review.cjs::sanitizeNonAsciiResourceApiKeys` writes the same input back unchanged for comment-only hits (it uses `replace(/(api...)"([^"]*)"/, ...)` which does match inside comments — but the rewriter normalises an already-correct call back to itself, no diff). So review never sees a blocking failure — but a fresh `static-pre-review` stage WOULD throw on the skeleton, breaking every task.

**Pre-req for shipping static-pre-review**:
- (a) Fix `non-ascii-resource-key` custom callback to use `buildCodeMask` (1 line change in `static-check.cjs:967`), OR
- (b) Mark the banner comments with `// [SKELETON-LINT-IGNORE]` and have the custom callback skip those lines, OR
- (c) Add the `// 正常` suffix to the banner example lines.

Option (a) is the right fix. It also retroactively cures the same FP class for `js-undefined-literal`, `setscale-wrong-params` and any future custom rule that forgets to mask comments.

---

## 8. Risks

### 8.1 LLM may fail to use structured feedback correctly

- **Cross-partial scope**: a `non-ascii-resource-key` hit in `.Resource.cs:495` may originate from a string literal that needs renaming in `.UI.cs` too (cross-file rename). Today's `fillCustomLogic` (codegen-schema.cjs:1084) writes a workspace with all partials and the AI sees them all, so cross-file edits are feasible. Mitigation: structured feedback includes ALL files+lines, not just one.

- **Semantically-aware rewrites**: e.g. `hot-path-new-vector3` flagged on `player.transform.position += new Vector3(0f, 0f, dz);` — the right fix is struct-copy. We tell the AI exactly that pattern in the FIX hint. Without the hint, AI tends to introduce a class field with a non-thread-safe init. Mitigation: pre-bake `_hotV3` reference in skeleton; FIX hint says "use the pre-declared class field `_hotV3`".

### 8.2 Fix-loop still may not converge in 3 rounds

Same model preference issue persists. Static-pre-review does NOT raise the cap. Mitigation: telemetry on per-rule convergence rate; promote rules to `deterministic pre-repair` when conv rate < 60%.

### 8.3 Pipeline blast radius

- `pipeline.cjs` change is 1 line.
- New stage file is self-contained.
- `static-check.cjs:967` mask fix is 1 line.
- Risk = **LOW** (matches `project_cleaner_blast_radius.md` framing — non-cleaner path).

### 8.4 Stage runtime

`staticCheckProject` on full project (main + 5 partials, ≈80kB total) runs ≤30ms locally. No infra cost added.

---

## 9. Effort Estimate

| Step | Owner | Hours |
|---|---|---|
| Fix `non-ascii-resource-key` custom callback to honour `buildCodeMask` (`static-check.cjs:967–999`) | eng | 0.5 |
| Add `remediation` field to top-10 blocking rules in `RULES[]` | eng | 1.5 |
| Add `// 正常` suffix to the 1 skeleton `Camera.main` line (or rule-tweak) | eng | 0.25 |
| Write `engine/stages/static-pre-review.cjs` (~120 lines, mirrors review's static-precheck synth block) | eng | 1.5 |
| Wire into `engine/pipeline.cjs` | eng | 0.25 |
| Unit test: feedback format + retry path + skeleton-clean assertion | eng | 1.5 |
| Replay today's 7-task batch through new pipeline, compare recode counts | eng | 1.0 |
| Telemetry: counters `staticPreReview.rejectCount`, `.byRule[ruleId]` on blueprint | eng | 0.5 |
| **Total** | | **7.0 h** |

---

## 10. Validation Strategy

### 10.1 Baseline comparison

1. Snapshot today's 7 task `ctx.csCode` + `ctx.extraFiles` (saved per task in `tasks/<id>/codegen-output/`).
2. Pre-stage: count `staticCheckProject(...).issues.filter(i=>i.blocking).length` per task → `B_today`.
3. Post-stage: run same snapshots through `static-pre-review.cjs::execute` → expect rejection rate ≥ X%.
4. Compare against current `review.cjs` recode rounds spent (from blueprint `reviewRoundCount`).

**Pass criterion**: ≥50% reduction in review recode rounds across the 7 tasks, no new circuit-breaker terminations.

### 10.2 Unit tests

- `test/static-pre-review.test.cjs` (new) — covers:
  - clean code → resolve with no throw
  - inject 1 `AddResource("金币")` → throws CODE error, structured includes file+line+rule+remediation
  - inject 3 violations → structured has 3 entries, error message lists all
  - retry path: `invalidateCodegenCheckpoint` called once
- Extend `test/static-check.test.cjs` to assert custom callbacks now respect `buildCodeMask`.

### 10.3 Regression net

Re-run full `npm test` (89 files / 279 cases, see `project_test_runner_unification.md`). Expectation = green; the `review-deterministic-repair.test.cjs` may need an extra fixture acknowledging the new stage runs first.

---

## 11. Open Questions

1. Should `static-pre-review` run on **partial** static-check or **full**? Recommend full (`staticCheckProject`), matches review.
2. Where to surface `staticPreReview.byRule` counter? `ctx.blueprint.staticPreReview = { rejectCount, perRule, lastBlockingIds }` — exposes to dashboard for top-recoded-rule visibility.
3. Should non-blocking issues (warnings) be pushed too? **No** — would noise the recode prompt. Warnings stay in `review.cjs` round logging only.
4. Threshold for converting a rule from "review pre-repair" to "static-pre-review feedback-only"? Suggest: ≥3 weeks of telemetry shows AI fixes the rule on round 1 ≥80% of the time → drop pre-repair.

---

## 12. Decision Recommendation (TL;DR)

**Ship static-pre-review (Plan B) + retain pre-repair as safety net.**

- New stage between method-check and review, deterministic, no LLM.
- Structured per-rule feedback with remediation hints.
- Pre-req: 1-line fix to `non-ascii-resource-key` custom callback so skeleton stays lint-clean.
- Expected effect: cuts review recode rounds by ≥50% on today's failure modes (CJK keys + hot-path Vector3); no impact when codegen is already clean.
- Effort: 7 h. Blast radius: low.
