# 2026-04-25 Module Contract Primary Gate

Date:
- 2026-04-25 Asia/Shanghai

Purpose:
- Record the migration from heavy CUA as the main correctness verifier to deterministic module-contract verification as the primary runtime gate.
- Keep heavy CUA scoped to visual smoke fallback and evidence-gap escalation.

## Source Changes

Blueprint repository:
- `engine/stages/runtime-contract.cjs`
  - Adds `moduleContractReady`.
  - Requires non-empty `signalCoverage` before runtime-contract can pass.
  - Emits `module-contract-incomplete` when a run has phase coverage but no signal contract.
  - Exposes deterministic `visualSmoke` metadata in the stage summary.
- `worker/worker-playableagent.js`
  - Propagates `visual_smoke` from CUA agent reports into runtime-contract input.
- `adapters/schema/load-assembly-registry.cjs`
  - Derives `expectedSignals` and `phaseEvidenceSchema` from each runtime module's `observableFeedback`.
- `adapters/schema/validate-assembly-registry.cjs`
  - Validates module `observableFeedback`, `expectedSignals`, and `phaseEvidenceSchema` against the CUA assertion registry.
- `adapters/schema/validate-assembly-plans.cjs`
  - Validates generated module instances and CUA steps include matching evidence schema.
- `adapters/assembly-plan-pipeline.cjs`
  - Writes module contract fields into `assemblyPlan.moduleInstances`.
  - Writes phase-scoped `phaseEvidenceSchema` into each `cuaPlan.steps[]`.
- `engine/stages/codegen-schema.cjs`
  - Adds module contracts and CUA step evidence schema to the codegen prompt summary.
  - Tells codegen that missing phase-scoped evidence is a runtime-contract failure.
- `adapters/assembly-emitter.cjs`
  - Adds expected signals, observable feedback, and evidence schema to generated assembly slot comments.
- `adapters/schema/assembly-registry-v1/cua-assertions.v1.json`
  - Adds `entity_visible`, `entity_hidden`, and `entity_position_changed`.

CUA agent repository:
- `playable_agent/perception.py`
  - Replaces first-scanline black/white checks with whole-frame sampling.
  - Adds blank, solid-color, and DOM loading detection.
- `playable_agent/agent.py`
  - Aggregates deterministic visual smoke into `verify_report.json`.
  - Fails black/white/solid/loading persistence before relying on VLM wording.
- `playable_agent/signal_assertions.py`
  - Adds module signal support for `entity_visible`, `entity_hidden`, and `entity_position_changed`.
  - When `phaseEvidenceSchema` is present, requires phase-scoped evidence for ambiguous resource, distance, upgrade, HP, source-hidden, and camera signals.

## Runtime Policy

The new gate is:

1. `visual-check`
2. `runtime-contract`
3. `cua-verify` only when runtime-contract needs escalation

`runtime-contract` can pass only when:
- `__gameState` exists
- plan coverage is complete
- signal coverage exists and is complete
- unsupported signals are absent
- hard-blocking silent-pass signals are absent
- deterministic visual smoke has no failure reason

Heavy CUA should now be treated as fallback for:
- black/white/solid/loading or other visual smoke failures
- missing `__gameState`
- missing or unsupported module contracts
- missing phase-scoped evidence for schema-declared signals
- purely visual semantics that cannot yet be represented as structured state

## Verification

Blueprint:
- `node adapters/schema/validate-assembly-registry.cjs`
- `node test/assembly-plan-pipeline.test.cjs`
- `node test/assembly-contracts-and-cua-bridge.test.cjs`
- `node test/assembly-emitter.test.cjs`
- `node test/codegen-schema-trigger-repair.test.cjs`
- `node test/codegen-contract-scrub.test.cjs`
- `node test/playableagent-report-normalization.test.cjs`
- `node test/runtime-contract-module-gate.test.cjs`
- `git diff --check`

CUA agent:
- `python3 -m py_compile playable_agent/perception.py playable_agent/agent.py playable_agent/signal_assertions.py`
- `/usr/bin/python3.8 -m unittest tests/test_signal_assertions.py tests/test_perception_visual_smoke.py`
- `python3 -m unittest tests/test_signal_assertions.py tests/test_perception_visual_smoke.py`
- `git diff --check`

## Deployment Notes

Safe local deployment remains PM2 restart, not PM2 reload:

```bash
pm2 restart blueprint-editor linux-worker-1 linux-worker-2 linux-worker-3 linux-worker-4 linux-worker-5 linux-worker-6
```

After deploy, confirm:
- all PM2 processes are `online`
- new runtime-contract summaries include `moduleContractReady`
- CUA reports include `visual_smoke`
- signal failures mention missing phase evidence instead of vague visual mismatch when schema evidence is required

## Deployment Record

Source commits pushed:
- `/opt/blueprint-editor`: `c7b4f89` `feat: make module contract the runtime gate`
- `/root/cua-agent`: `3e77f0a` `feat: add deterministic visual smoke gates`

Deployment executed on 2026-04-25 00:14-00:18 CST:

```bash
pm2 restart blueprint-editor linux-worker-1 linux-worker-2 linux-worker-3 linux-worker-4 linux-worker-5 linux-worker-6
```

PM2 reported these processes online after restart:
- `blueprint-editor`
- `linux-worker-1`
- `linux-worker-2`
- `linux-worker-3`
- `linux-worker-4`
- `linux-worker-5`
- `linux-worker-6`

## Local-Only Records

The following host-local files were updated alongside this archived record:
- `/root/.codex/skills/blueprint-monitor/SKILL.md`
- `/root/.codex-blueprint/skills/blueprint-monitor/SKILL.md`
- `/root/codex-handoff-latest.md`

These files are not versioned in the source repositories on this host. This archived document is the Git-backed audit trail.
