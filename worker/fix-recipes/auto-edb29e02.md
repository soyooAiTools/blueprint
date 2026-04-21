# auto-edb29e02
## Diagnosis
When CUA emits `[spec-phase-skipped] Phases not completed (N/N): …`, `_buildStuckDiagnosis`
had no matching keyword branch for the token `spec-phase-skipped`, so `rootCause` stayed
`'unknown'`. Because `'unknown'` was absent from the fast-escalation guard condition
(`visual_freeze | codegen_init_failure`), the loop continued for the full
`NO_PROGRESS_EXIT_ROUNDS + 3 = 7` rounds before FATAL — wasting 5–6 extra recode cycles
per task. Simultaneously, the fingerprint circuit breaker (originally hard-FATAL at
`_fpRepeatCount ≥ 2`, no `isPhaseSkippedFp` exemption) fired prematurely at round 2,
cutting off recode before `_noProgressRounds` could drive a proper full-regen escalation.
The fix adds three coordinated changes: (1) a `spec_phase_skipped` rootCause branch,
(2) inclusion of that root cause in the fast-escalation guard, and (3) an `isPhaseSkippedFp`
exemption in the FP circuit breaker so `_noProgressRounds` owns escalation for this class.

## Root Cause
`engine/stages/cua-verify.cjs:99` — `_buildStuckDiagnosis` keyword chain falls through
`interaction_dead` with no branch for `spec-phase-skipped`, leaving `rootCause = 'unknown'`.
Secondary: `engine/stages/cua-verify.cjs:667` — fast-escalation guard missing `spec_phase_skipped`.
Tertiary: `engine/stages/cua-verify.cjs:512` — FP circuit breaker had no `isPhaseSkippedFp` guard.

## Fix

### Change 1 — `_buildStuckDiagnosis`: add `spec_phase_skipped` branch
In `_buildStuckDiagnosis`, after the `interaction_dead` else-if block (line 99) and
**before** the `phase_transition_broken` else-if block (line 108), insert: