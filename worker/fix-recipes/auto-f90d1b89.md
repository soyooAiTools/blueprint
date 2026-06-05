# auto-f90d1b89

## Diagnosis
The error reports ~99.26 % pixel divergence across **all 4 phases** plus 29 blocking field-level diffs
in phase1. Each phase opens a fresh browser context, so the near-100 % divergence is not a
one-off timing blip — every capture independently timed out and captured a black / uninitialized
WebGL frame. This eliminates the "entities visible" snapshot, producing N entity-missing blocking
diffs; the synthesised fidelity contract then adds N more blocking worldLabel-missing diffs per
phase because `buildEntityRecord` always emits a v1.3-rich `worldLabel` object (the `worldOffset`
field makes `isV13RichWorldLabel()` return `true` → `blocking: true`), for a combined 29+ blocking
hits even before the pixel gate fires.

## Root Cause

**Primary — `engine/stages/fidelity-source-diff.cjs:570` / `:599`**

`drivePageToPhase`'s `waitForFunction` tests only the **canvas center-pixel RGB** for non-black
values. Games with a dark or space/night background (the failing task is consistent with a
space-themed game given the `space-ranger` references throughout the codebase) never produce
`px[0] > 0 || px[1] > 0 || px[2] > 0` at the centre even when fully rendered. Both the 60 s
primary timeout (`FIDELITY_READY_TIMEOUT_MS`) and the 20 s secondary canvas-black guard
(`FIDELITY_CANVAS_BLACK_GUARD_MS`) exhaust, then `settleFrame` (~33 ms, 2 rAFs) fires on an
uninitialized WebGL surface → black PNG → ~99 % pixel divergence, repeated independently for
every one of the 4 phases.

**Secondary — `engine/stages/fidelity-contract-synthesize.cjs:143-148`**

`buildEntityRecord` emits a v1.3-rich `worldLabel` `{ text, worldOffset:{x,y,z}, color, fontSize }`
for every entity. `isV13RichWorldLabel()` returns `true` for this shape, marking all synthesised
worldLabel entries as `blocking: true`. Generated Luna/PlayCanvas builds have no
`#bp-storyboard-worldlabels` DOM overlay → N entity × worldLabel-missing = N extra blocking diffs
stacked on top of the entity-missing diffs from the black frame.

## Fix

### Fix 1 — add `__gameState.entity_states` as dark-background readiness signal
**File:** `engine/stages/fidelity-source-diff.cjs`
**Location:** inside the `waitForFunction` callback, immediately before `return false;` at line 604.
