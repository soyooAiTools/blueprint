# 2026-06-08 SourceIR schema hot path closeout

## Scope

This closeout records the PDF/storyboard -> StoryboardIR -> SourceSceneIR -> GameSchema/WebGL path that removes LLM work from the hot path, plus the Guard Home target-ring regression fix.

## Main Changes

- Added a canonical StoryboardIR contract and deterministic compilers:
  - `contracts/storyboard-ir.v1.json`
  - `engine/storyboard-ir.cjs`
  - `engine/storyboard-spec-compiler.cjs`
  - `engine/storyboard-source-ir-compiler.cjs`
  - `scripts/process-storyboard-pdf-samples.cjs`
- Added no-LLM hot-path guard and SourceIR auto-prebuild:
  - `lib/llm-hot-path.cjs`
  - `engine/stages/source-html-bind.cjs`
  - `engine/stages/spec-extract.cjs`
  - `engine/stages/codegen-schema.cjs`
- Added fast SourceIR build diagnostics:
  - `scripts/source-ir-build.cjs --debug-fast --runtime-binding-smoke`
  - `scripts/runtime-binding-smoke.cjs`
  - `pipeline-timing.json`
- Hardened Guard Home SourceIR projection:
  - keep phase-visible entities from the storyboard, not just one target
  - classify `HeroTower` as a world entity, not player
  - spread generated world entities across a wider map
  - derive camera and ground size from generated layout bounds
- Fixed target guidance:
  - SourceIR preview target ring is now a Three.js world `TorusGeometry`, not a fixed CSS ring at screen center
  - DOM fallback projects the ring to the target entity screen position
  - WebGL/PlayCanvas marker uses the current phase primary step target and source coordinate adapter
  - target-ring state is exposed as `window.__sourceIrTargetRingState` for probes

## Guard Home Evidence

Input:

- `/nickTemp/分镜目录/PA-守护家园-分镜(3).pdf`

Regenerated SourceIR preview:

- `/tmp/guard-home-spacing-pdf-20260608/守护家园/source-ir-preview.html`
- `/tmp/guard-home-spacing-pdf-20260608/守护家园/source-scene-ir.json`

Final debug-fast chain:

- `/tmp/guard-home-ring-fix-chain-20260608`
- `/tmp/guard-home-ring-fix-chain-20260608/blueprint-smoke/index.html`
- `/tmp/guard-home-ring-fix-chain-20260608/runtime-binding-smoke-report.json`
- `/tmp/guard-home-ring-fix-chain-20260608/pipeline-timing.json`

Timing from `pipeline-timing.json`:

- total: `32102ms`
- source preflight: `37ms`
- source phase liveness: `11925ms`
- SourceIR artifacts: `47ms`
- blueprint smoke/build: `12480ms`
- runtime binding smoke: `7612ms`

Browser probe results:

- SourceIR preview phases `1,3,6,15,22` target ring mode was `three`; `ringWorld` matched the current target model world position.
- WebGL phases `1,3,6,15,22` marker targets were `IceChunk`, `WaterTank`, `PopcornStand`, `Enemy`, `Enemy`; marker X/Z matched the target entity root X/Z.

## Validation

- `node test/source-ir-preview-renderer.test.cjs`
- `npm test` -> `pass=394 fail=0 files=176 elapsed=11296ms`
- `git diff --check -- engine/source-ir-preview-renderer.cjs test/source-ir-preview-renderer.test.cjs`
- `node scripts/source-ir-build.cjs /tmp/guard-home-spacing-pdf-20260608/守护家园/source-ir-preview.html /tmp/guard-home-ring-fix-chain-20260608 --blueprint-smoke --runtime-binding-smoke --debug-fast`

## Operational Rules

- For schema-first SourceIR tasks, prefer `--debug-fast --runtime-binding-smoke` before running expensive visual/CUA gates.
- `NO_LLM_HOT_PATH=enforce` should block unexpected hot-path LLM calls after SourceIR auto-prebuild is available.
- Target guidance must be tied to the current unresolved phase step target. Do not derive it from phase number or a fixed screen coordinate.
- SourceIR preview target rings must be world-space Three.js rings when Three.js is available; DOM rings are fallback only and must project to the target entity.
- Live build API uses `/opt/luna-poc/linux-bridge-build.js` as a mirror of `worker/linux-bridge-build.js`; overlay/camera/marker changes must be mirrored and `luna-build-api` restarted on deploy.
