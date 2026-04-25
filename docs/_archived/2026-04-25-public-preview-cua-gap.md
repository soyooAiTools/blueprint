# 2026-04-25 Public Preview / CUA Surface Gap

## Task

- Project: `proj_1776912973985_5o2lyu`
- Title: `测试`
- Public preview: `https://playcools.top/webgl/proj_1776912973985_5o2lyu/index.html`

## Symptom

The task had reached the CUA/review path, but the public preview opened by reviewers stayed on the first SHOT and did not advance.

## Root Cause

The verification surface did not match the user-facing surface:

- CUA observed local `iframe.html?autoplay=1` with observer-ready and PlayableAgent speed patches.
- Public review opens the naked hosted `index.html`.
- The old public fallback directly called `window.startGame()`, bypassing Luna startup dependencies and triggering `$ctor1` / `b2Vec2` null errors.
- Upload retry reused stale checkpoint output after a public preview failure.
- The first narrative `move_to` phase had no action-backed fallback evidence when the guide-text anchor was absent.

## Fixes

- `engine/stages/runtime-contract.cjs`
  - Added default preview probing against raw `index.html`.
  - Prevents runtime-contract from skipping heavy CUA when the default preview cannot progress.

- `engine/stages/upload.cjs`
  - Verifies the actual HTTPS public preview after writing artifacts.
  - Waits for Unity `window.app` or `window.__gameState` / `window.__getGameState()` before starting the progress deadline.
  - Requires the public default preview to complete the first three spec phases or reach terminal state.
  - Adds screenshot pixel-diff verification so state-only progression cannot hide a frozen camera/first-shot screen.

- `worker/linux-bridge-build.js`
  - Public fallback now dispatches Luna lifecycle events instead of direct `window.startGame()`.

- `/opt/luna-poc/linux-bridge-build.js`
  - Same fallback patch applied to the build API source actually used by `/opt/luna-poc/build-api.js`.

- `worker/linux-worker-client.js`
  - `public-preview-*` upload failures invalidate checkpoint state from `compile` onward.

- `adapters/assembly-emitter.cjs`
  - `move_to` autoplay fallback evidence is inserted even when no guide-text evidence anchor exists.

- `test/assembly-emitter.test.cjs`
  - Added coverage for narrative `move_to` fallback evidence.

- `test/upload-public-preview.test.cjs`
  - Added coverage for upload visual diff and spec completion helpers.

## Validation

- `node -c engine/stages/upload.cjs`
- `node -c worker/linux-worker-client.js`
- `node -c worker/linux-bridge-build.js`
- `node -c adapters/assembly-emitter.cjs`
- `node test/assembly-emitter.test.cjs`
- `node test/build-html-bridge.test.cjs`
- `node test/linux-bridge-start-fallback.test.cjs`
- `node test/upload-public-preview.test.cjs`
- Public preview probe:
  - completed `3/3`
  - advanced to `dispatchAstronautAttack`
  - visual diff `0.031`, above threshold `0.005`

## Operational Notes

- Build API is supervised by PM2 as `luna-build-api`.
- Health endpoint: `http://127.0.0.1:18860/health`.
- Project status remains `reviewing` after CUA/done because worker reports `done` / `cua_passed` are mapped to review state by `api/worker.cjs`.
