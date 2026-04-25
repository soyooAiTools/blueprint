# 2026-04-25 P0 Module Emitter And Evidence Tightening

## Context

After moving runtime verification to module-contract gating, the remaining instability was in the execution layer:

- assembly planning had high coverage, but many runtime module slots were still TODO placeholders
- `phaseEvidence` could be synthesized by the skeleton for active/completed phases, which made signal coverage too easy to satisfy
- owner boundaries still allowed conflicts such as cost gates and damage application appearing to own resource or hp state

## Changes

- Tightened `BuildPhaseEvidenceJson()` so it only serializes recorded module evidence. It no longer blanket-fills inferred `covered:true` signals for active phases.
- Added per-frame `UpdateGameState()` export after assembly/custom update work so runtime contract can observe fresh module evidence.
- Moved P0 state ownership toward request/owner boundaries:
  - `inventory_wallet` owns economy resource state
  - `damageable` owns hp/death state
  - `cost_gate` writes a spend request signal, not economy resources
  - `apply_damage` writes a damage request signal, not hp
- Added deterministic emitter bodies for common P0 modules:
  - `visual_binding`
  - `player_input_tap`
  - `click_trigger`
  - `move_to_target`
  - `proximity_trigger`
  - `cost_gate`
  - `build_progress`
  - `upgrade_progress`
  - `target_acquire`
  - `projectile_emit`
  - `apply_damage`
  - `activate_targets`
  - `visual_variant_swap`
  - guide, score, and camera evidence slots
- Fixed `move_to` ownership so `move_to_target` attaches to the actor/player and preserves the target parameter.
- Updated CUA signal assertions so module-owned phase evidence is accepted for inventory, reward, entity visibility/position, built state, downstream visibility, projectile visibility, and score text.
- Routed repeated `screenshot sharing` / `screenshot-timing` fingerprints away from the generic CUA fingerprint FATAL breaker so batch-firing visual-collapse cases can reach the no-progress/full-regen escalation path.
- Added deterministic review repair for post-tap reset-only phase switches that re-place or hide entities immediately after `Phase_OnTap()`, which can make autoplay appear to advance while the visible shot keeps snapping back.

## Guardrails

- Do not reintroduce blanket phase evidence. A signal should be written by the module/action path that actually performed the behavior.
- Runtime-contract success should come from module-owned evidence plus visual smoke, not from CUA guessing.
- Heavy CUA remains a fallback for visual smoke failure, missing game state, unsupported signals, incomplete contracts, or evidence gaps.

## Verification

- `node adapters/schema/validate-assembly-registry.cjs`
- `node test/assembly-plan-pipeline.test.cjs`
- `node test/assembly-emitter.test.cjs`
- `node test/assembly-contracts-and-cua-bridge.test.cjs`
- `node test/codegen-schema-trigger-repair.test.cjs`
- `node test/codegen-contract-scrub.test.cjs`
- `node test/runtime-contract-module-gate.test.cjs`
- `node test/playableagent-report-normalization.test.cjs`
- `node -c engine/stages/cua-verify.cjs`
- `node -c engine/stages/review.cjs`
- `node test/cua-fingerprint-circuit-breaker.test.cjs`
- `node test/cua-feedback-enrichment.test.cjs`
- `node test/cua-verify-timeout.test.cjs`
- `node test/build-html-bridge.test.cjs`
- `node test/method-check-contract.test.cjs`
- `npx jest test/phase-gate-entities.test.cjs --runInBand`
- `node test/review-deterministic-repair.test.cjs`
- `node test/skeleton-flow-fallback.test.cjs`
- `node test/skeleton-updategamestate-json.test.cjs`
- `node test/gfm-ui-null-safety.test.cjs`
- `python3 -m unittest tests/test_signal_assertions.py tests/test_perception_visual_smoke.py`
- `/usr/bin/python3.8 -m unittest tests/test_signal_assertions.py tests/test_perception_visual_smoke.py`
