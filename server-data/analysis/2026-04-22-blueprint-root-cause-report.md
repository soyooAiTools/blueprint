# Blueprint Root Cause Report

Date: 2026-04-22
Scope: active blueprint sample set on `/opt/blueprint-editor`
Sample size: 6 active tasks

## Executive Summary

The current failure pattern is not best described as "individual tasks need more manual polishing".
It is a system problem with three dominant buckets:

1. Generation-layer compile drift
   Custom/generated code keeps inventing undefined symbols, duplicate fields, wrong player variables, invalid pool names, and forbidden generic APIs.

2. Phase-architecture drift
   Generated gameplay logic still produces unreachable gates, timer/script-driven progression, or gate entities that never receive a real runtime move.

3. Retry/review inefficiency
   Once a task falls into one of the two buckets above, review loops often repeat the same fingerprint for 3-4 rounds and burn worker/slot time without adding new information.

The right strategy is:

- Use a small sample to classify failure families.
- Move the top families into deterministic template/static/method repair.
- Reduce or skip fix-loop retries when the fingerprint is already known to be non-convergent.

## Sample Classification

### Task-by-task first useful diagnosis

| Task | Current/Recent fatal path | Earliest useful root-cause layer | Notes |
| --- | --- | --- | --- |
| `proj_1776680853909_w7113b` | review loop repeats `phase-entity-init-only` | `skeleton/codegen` -> phase gate composition | `goldObj` and similar entities are still entering phase gates without guaranteed real movement. |
| `proj_1776680895524_s6ae56` | review compile blockers + unreachable phases | `codegen/custom logic` | Duplicate fields, undefined symbols, invalid pool names, forbidden generic APIs. |
| `proj_1776832003298_8u6x0n` | review compile blockers + impossible progression | `codegen/custom logic` | Early static blockers improved, but generated flow still leaves non-implemented flags/gates. |
| `proj_1776832015099_axudno` | review compile blockers + broken player wiring | `codegen/custom logic` | Null/unassigned player reference plus missing handlers and invalid pool usage. |
| `proj_1776832034125_ll9a4d` | review compile blockers + impossible first transition | `template/custom logic` | Started with forbidden runtime UI/add-component, then converged to compile + scripted progression problems. |
| `proj_1776832054666_vtpwu5` | review `phase-entity-init-only`, previously `method-check` on `AutoWorkerTick` | `custom logic` + `phase gate generation` | `AutoWorkerTick` was a generated helper hallucination; phase gate issue still remains after that. |

## Main Failure Families

### 1. Compile drift from generated/custom logic

Observed repeatedly across `s6ae56`, `8u6x0n`, `axudno`, `ll9a4d`, `vtpwu5`.

Typical symptoms:

- undefined symbols
- duplicate state fields
- `Player` / `player` / `PlayerAvatar` naming drift
- invalid pool object literals
- forbidden generic APIs such as `GetComponent<T>()`
- helper hallucinations such as `AutoWorkerTick(...)`

Interpretation:
The generator is still allowed to write code that is too free-form relative to the skeleton contract.
Review can catch these errors, but it is being asked to repair structural generation mistakes after the fact.

### 2. Phase gate composition still injects unreachable conditions

Observed repeatedly across `w7113b`, `vtpwu5`, `8u6x0n`, `axudno`, `ll9a4d`.

Typical symptoms:

- `phase-entity-init-only`
- `phase-gate-shortcircuits-with-interaction-flags`
- "impossible first transition"
- "timer/scripted progression instead of real player-driven completion"
- gate entities included in snapshots but never moved by the real interaction path

Interpretation:
The system is improving at static review-time repair, but phase progression is still often malformed before review starts.
This means the next leverage point is not more monitoring; it is stricter phase gate generation and stronger gate/entity alignment checks earlier in the chain.

### 3. Review loop repeats known non-convergent fingerprints

Observed on nearly every sampled task.

Typical symptoms:

- `Review fingerprint repeated 3 rounds`
- `Circuit breaker: same CODE error repeated 3 rounds`
- 4 review rounds with nearly identical blocker sets

Interpretation:
The retry policy still treats several structural classes as if they were patchable review noise.
In practice, many of these are upstream generation faults and should trigger earlier class-specific repair or branch to full regeneration with tighter constraints.

### 4. Complexity simplification is unstable on large specs

Observed at least on `w7113b`.

Typical symptoms:

- `complexity-gate` simplification retries fail with malformed JSON

Interpretation:
For high-complexity blueprints, the simplification stage itself becomes another instability source.
This is a separate reliability issue from gameplay correctness.

### 5. Throughput bottleneck amplifies bad retries

Observed across logs:

- repeated `All 3 slots busy, waiting...`

Interpretation:
Slot contention is not the root cause, but it magnifies the cost of non-convergent review loops.

## What This Means

The system is no longer primarily blocked by "we did not detect the error".
It is blocked by "we still generate the same families of wrong code, then pay too much to rediscover that they are wrong".

So the main opportunity is to shift from:

- monitor -> review -> retry -> retry -> retry

to:

- constrain generation
- detect family early
- repair deterministically or abort early

## Recommended Backlog

### Priority A

1. Harden custom-logic generation contract
   Do not allow new helpers, new entity aliases, or undeclared field families.
   Treat helper invention, player alias drift, and pool remapping as generation failures, not reviewer cleanup work.

2. Add a codegen-time symbol contract check
   Before review, scan for:
   - unknown method calls
   - duplicate state declarations
   - forbidden generic APIs
   - mixed player aliases (`player`, `Player`, `PlayerAvatar`)
   - invalid pool name literals

3. Add phase gate/entity alignment validation before review
   For every `EntityAdvanced(X, _snap_XPos)` gate, verify that phase interaction paths can actually move `X`.
   If not, either remove `X` from the gate or inject deterministic runtime movement before review starts.

### Priority B

4. Split review retry policy by fingerprint family
   For structural families such as:
   - `phase-entity-init-only`
   - repeated compile undefined-symbol sets
   - invalid pool-object mappings

   stop doing 3-4 similar review rounds.
   Route directly to a deterministic repair path or to regeneration with a stricter prompt.

5. Add "first bad stage" telemetry
   Persist, per task:
   - first failing stage
   - first stable fingerprint family
   - whether later failures are secondary fallout

   This will make future triage much faster and stop over-attributing everything to review.

### Priority C

6. Stabilize complexity-gate simplification for high-score tasks
   Prefer a stricter JSON-only schema prompt or deterministic simplification rules for spec families that repeatedly break JSON output.

7. Reduce slot waste from repeated non-convergent reviews
   If the same fingerprint repeats after deterministic repair has already fired, fail fast or regenerate instead of occupying codex slots.

## Immediate Next Steps

1. Continue current `method-check` helper guard
   This already removed one recurring direct-fail class (`AutoWorkerTick`).

2. Move next to phase gate composition
   Specifically target:
   - gate entities that never move
   - interaction-flag shortcut leakage
   - scripted/timer-only transitions in player-action phases

3. Then add a codegen-time symbol/pool/API contract check
   This should remove a large share of compile failures before review even starts.

## Conclusion

There is a better plan than "keep polishing tasks until they pass".
The evidence from the current sample says the right approach is a bounded root-cause program:

- sample a few representative failures
- cluster them into system families
- promote those families into deterministic generation checks and repairs
- aggressively cut retry spend on families that are already known to be non-convergent

That is the highest-leverage path to raising success rate from the current state.
