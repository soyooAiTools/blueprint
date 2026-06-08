# auto-fd17c75e
## Diagnosis
`cua-verify` emits `[plan-coverage]` as a legitimate repair issue when CUA only covered part of the plan. The Codex runner then misclassifies that repair text as auth/quota because the fatal regex matches policy wording containing `insufficient`. This aborts the CUA fix loop as `MODEL_FATAL` instead of allowing recode to fix missing plan coverage.
## Root Cause
`worker/codex-code-coder.js:93`; `engine/stages/cua-verify.cjs:269` emits the non-auth `[plan-coverage]` issue.
## Fix
In `worker/codex-code-coder.js`, add a plan-coverage exclusion and narrow `insufficient` matching to quota/billing context only: