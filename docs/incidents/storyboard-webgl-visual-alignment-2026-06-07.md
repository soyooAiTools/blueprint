# Storyboard2HTML to WebGL Visual Alignment Incident - 2026-06-07

## Summary

`strict CUA` passed for the 回收子弹 flow, but the generated WebGL output still looked different from the storyboard2html source HTML. The missing gate was visual: CUA verified joystick flow and phase completion, but did not compare the rendered WebGL frames against the source storyboard2html frames.

The fix adds a source-to-WebGL phase screenshot diff gate and makes WebGL reuse more of the source HTML scene contract.

## Root Causes

- `demo2spec --blueprint-smoke` validated flow, build, and runtime evidence, but had no mandatory screenshot diff between storyboard2html HTML and the final WebGL.
- Source camera and grid were not preserved. WebGL often used its own fallback view, so phase flow could pass while framing drifted.
- Source DOM HUD and bridge HUD could both be present. This created duplicate or mismatched labels even when the underlying phase state was correct.
- Phase driving existed in both outputs, but there was no single tool that drove both outputs phase by phase and compared pixels.

## Fix

- Added `scripts/storyboard-webgl-visual-diff.cjs`.
  - Serves source HTML and WebGL output locally.
  - Drives each phase with `__driveToPhase` / `__driveToSourcePhase`.
  - Captures source, WebGL, and diff screenshots.
  - Writes `storyboard-webgl-visual-diff/report.json`.
  - Fails when `meanAbs` or `over50Pct` exceed thresholds.
- Added `adapters/demo2spec/index.js --visual-diff`.
  - Implies `--blueprint-smoke`.
  - Runs the source/WebGL visual diff after smoke output is produced.
- Extended visual asset extraction.
  - Extracts `sourceSceneContract.camera` from source `THREE.PerspectiveCamera`.
  - Extracts `sourceSceneContract.grid` from source `THREE.GridHelper`.
  - Extracts `sourceEntityContract.domHudContract` from source DOM HUD CSS and initial text.
- Updated WebGL overlay behavior.
  - Reuses source camera and grid where available.
  - Reuses source DOM HUD and hides bridge HUD/tone/target when source HUD owns the UI.
  - Keeps source phase driver hooks available for strict phase screenshot diffing.

## Verification

Targeted unit and syntax checks:

```bash
node -c adapters/demo2spec/visual-assets.js
node -c adapters/demo2spec/visual-overlay.js
node -c worker/linux-bridge-build.js
node -c adapters/demo2spec/index.js
node -c adapters/demo2spec/adapter.cjs
node -c scripts/storyboard-webgl-visual-diff.cjs

node test/storyboard-webgl-visual-diff-script.test.cjs
node test/visual-assets-build-gate.test.cjs
node test/demo2spec-visual-overlay.test.cjs
node test/linux-bridge-build-fidelity-hooks.test.cjs
```

回收子弹 source/WebGL visual diff:

```bash
node adapters/demo2spec/index.js \
  '/nickTemp/分镜目录/_blueprint_outputs/recycle-bullet-run-20260607-v1/回收子弹-storyboard2html.html' \
  '/nickTemp/分镜目录/_blueprint_outputs/recycle-bullet-visual-align-20260607-v2' \
  --blueprint-smoke --visual-diff
```

Result:

| Phase | `meanAbs` | `over50Pct` |
|---|---:|---:|
| phase1 | 4.5417 | 1.7562 |
| phase2 | 6.9001 | 3.6233 |
| phase3 | 5.5794 | 2.6528 |

Report: `/nickTemp/分镜目录/_blueprint_outputs/recycle-bullet-visual-align-20260607-v2/storyboard-webgl-visual-diff/report.json`

Strict CUA:

```bash
node scripts/strict-cua-runner.cjs \
  '/nickTemp/分镜目录/_blueprint_outputs/recycle-bullet-visual-align-20260607-v2/blueprint-smoke' \
  --out '/nickTemp/分镜目录/_blueprint_outputs/recycle-bullet-visual-align-20260607-v2/strict-cua' \
  --task-id recycle-bullet-visual-align-v2-strict
```

Result: PASS. Plan `3/3`, signals `29/29`, manual joystick probe PASS, manual joystick flow probe PASS, phase path `phase1 -> phase2 -> phase3 -> gameEnd`.

## Operational Rule

For storyboard2html to WebGL alignment work, do not accept CUA alone. Required final evidence:

- `strict CUA` or production CUA pass for full joystick flow.
- `storyboard-webgl-visual-diff/report.json` pass.
- Source/WebGL/diff screenshots for every phase.
- Confirmation that phase count and phase copy match between storyboard2html and WebGL.
