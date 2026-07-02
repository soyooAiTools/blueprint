# Unity Native WebGL Source Parity Drift - 2026-07-02

## Impact

`space-junk` showed large differences between storyboard2html source HTML and
the Unity/WebGL delivery: labels did not follow objects, the target ring was
missing, HUD/phase text sizes and positions drifted, camera framing differed,
and browser validation initially made FPS look worse than the isolated Unity
runtime.

## Root Cause

The pipeline treated source HTML semantic parity as mandatory, but the Unity
delivery path did not yet have the same hard visual/runtime contract. Several
approximate Unity defaults escaped together:

- HUD and label layout used legacy fixed constants instead of source DOM
  positions, sizes, and label text sizing.
- Entity labels were throttled and projected with a different height offset,
  so moving objects and labels diverged.
- Target guidance did not publish or validate Unity-side targetRing screen
  bounds, so a missing ring was not a blocking failure.
- Camera position/FOV were not locked to the source camera projection.
- Runtime reports and preview files were not strict enough to prove the final
  artifact came from Unity Editor native WebGL build output.
- FPS diagnosis mixed dual-page source+Unity validation overhead with isolated
  Unity runtime performance.

## Fix

- Require Unity Editor native `BuildTarget.WebGL` for Unity WebGL delivery.
- Publish Unity runtime parity and visual snapshots into browser-visible
  window state for source-vs-Unity gates.
- Align `GFM_UI` and generated GMP UI with source HUD constants and dynamic
  label sizing.
- Sync visible labels every frame and use the source label height offset.
- Materialize target ring from source phase target guidance and validate its
  screen bounds.
- Preserve source camera projection for the initial scene.
- Add a native WebGL parity script and tests so SourceIR phases, guide text,
  target sequence, entities, resources, gates, and steps are checked against
  the Unity runtime snapshot.
- Cap WebGL template DPR for stable delivery FPS and distinguish isolated
  Unity FPS from dual-page validation FPS.

## Verification

The `space-junk` delivery was rebuilt by Unity Editor native WebGL with Unity
2022.3.14f1c1 and passed with zero errors. SourceIR semantic hash matched the
Unity runtime snapshot. Strict source-vs-Unity visual fidelity passed for HUD,
labels, target ring bounds, camera, and canvas sizing. Isolated Unity runtime
reported about 60 FPS; the conservative dual-page validation reported about
31 FPS.

Relevant regression gates:

```bash
node test/programmer-delivery-cleaner.test.cjs
node test/unity-native-webgl-build.test.cjs
node test/unity-native-webgl-parity.test.cjs
node test/unitycomponent-v1-emitter.test.cjs
node test/unity-codegen-prompt-contract.test.cjs
```

## Lesson

Unity delivery cannot be certified by compile success, CUA, or file presence
alone. For source-driven playable ads, the final Unity WebGL artifact must be
native Unity Editor build output and must prove runtime/visual parity against
storyboard2html/source HTML for HUD, labels, camera, target guidance, and
phase semantics.
