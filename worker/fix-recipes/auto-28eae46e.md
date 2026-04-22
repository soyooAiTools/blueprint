# auto-28eae46e
## Diagnosis
The `visual_freeze` escalation ladder in `cua-verify.cjs` triggered full regen at `_noProgressRounds=2` (setting `_visualFreezeRegenAttempted=true`). On the very next no-progress round (`_noProgressRounds=3`), the final `else` branch of the `_visualFreezeRegenAttempted` check had no minimum-rounds guard, so it threw FATAL unconditionally. The regenerated code received exactly one CUA verification pass — far too few for a rendering/animation deficiency, which often needs two passes to confirm it is truly unfixable.

## Root Cause
`engine/stages/cua-verify.cjs` — the `else` branch inside the `visual_freeze / codegen_init_failure / spec_phase_skipped` escalation block, previously at approximately line 722 (pre-fix):