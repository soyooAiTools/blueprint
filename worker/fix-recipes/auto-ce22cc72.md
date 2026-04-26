# auto-ce22cc72

## Diagnosis
`detectObservationProtocolFailure()` treated two different cases as fatal:

- true pre-contamination, where many spec phases complete before the observe window opens
- screenshot-timing / batch-completion, where phases complete too quickly within the observe window and share screenshots

The caller threw on any non-null detector result, so screenshot-timing bypassed the CUA recode loop and the `_noProgressRounds` full-regen path.

## Root Cause
`engine/stages/cua-verify.cjs` returned the same fatal-shaped object for both branches, while `isFingerprintCircuitBreakerExempt()` already declared screenshot-sharing fingerprints should be handled by no-progress escalation before any generic FATAL breaker.

## Fix
Return `isFatal: true` only for `report.preContamination.fatal`.

For screenshot-sharing plus batch-completion, return `isFatal: false` and log an observation warning. The caller should only throw when `isFatal` is true, allowing the normal no-progress / full-regen path to run.

## Verification
- `node -c engine/stages/cua-verify.cjs`
- `node test/cua-fingerprint-circuit-breaker.test.cjs`
