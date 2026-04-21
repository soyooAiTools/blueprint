# auto-28eae46e
## Diagnosis
When `visual_freeze` is diagnosed and `_noProgressRounds` reaches 2, the escalation block triggers a full regen and sets `_visualFreezeRegenAttempted = true`. On the very next no-progress round (`_noProgressRounds = 3`) the `else` branch fires, but the original code had a bare `throw` with no minimum-round guard — terminating the pipeline after only one CUA verification pass on the regenerated code. A single post-regen verification is insufficient for `visual_freeze` because rendering/animation deficiencies often need 2 CUA cycles to show measurable improvement.

## Root Cause
`engine/stages/cua-verify.cjs:678` — the `else` branch of the `visual_freeze` fast-escalation block (inside `_noProgressRounds >= 2` guard, after `_visualFreezeRegenAttempted = true`) was an unconditional `throw`, firing the FATAL at `_noProgressRounds = 3` before regenerated code had a second verification window.

## Fix
**In `engine/stages/cua-verify.cjs`, replace the bare else-throw** (the old `else` branch following the `spec_phase_skipped` arm inside the `visual_freeze || codegen_init_failure || spec_phase_skipped` block):