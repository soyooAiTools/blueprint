# auto-68c0fa1a
## Diagnosis
This is a field-diff-only `fidelity-source-diff` block: there are blocking phase1 field diffs but no `pixel gate FAIL`. That means the rendered target is visually acceptable enough for the pixel gate, and the blocker is coming from verifier extraction noise. The WebGL extractor can miss Luna's authoritative runtime visibility when `__gameState` is wrapped or uses camelCase `entityStates`, then falls back to phase-insensitive PlayCanvas tree walking and reports phantom entity diffs.
## Root Cause
engine/stages/lib/field-diff.cjs:856
## Fix
In `WEBGL_PAGE_EXTRACTOR`, normalize `window.__gameState` before visibility extraction, accept both `entityStates` and `entity_states`, and skip PlayCanvas tree/storyboard fallback whenever authoritative entity state exists.

Add helpers after `gs` is read: