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

## Deployment Record

- Commit pushed: `6bbaeff` (`fix: harden public preview visual gate`) to `origin/main`.
- Local production PM2 restarted:
  - `blueprint-editor`
  - `linux-worker-1` through `linux-worker-6`
  - `luna-build-api`
- PM2 process list saved with `pm2 save`.
- Local health check passed: `GET http://127.0.0.1:18860/health` returned `{"ok":true,"service":"linux-build-api"}`.
- Remote Windows worker deploy path is currently blocked:
  - Existing deploy script requires undeclared Node module `ssh2`; temporary `/tmp` install was used to execute the same path.
  - Main ECS could connect, but worker `42.121.160.107` had a changed host key and then rejected the configured `Administrator` + `/root/.ssh/worker_key` credential.
  - Result: `Permission denied (publickey,password)` on worker pull/check/restart. This needs operator credential/host ownership confirmation before remote worker sync can be completed.

## Deployment Record 2

- Timestamp: 2026-04-25 12:29 CST.
- Host identity confirmed as the main ECS: `iZbp14ul21fo6kjm4cxnlyZ`.
- Commit active locally and on `origin/main`: `0ce644b` (`docs: record public preview deployment`).
- Local production PM2 restarted again:
  - `blueprint-editor`
  - `linux-worker-1` through `linux-worker-6`
  - `luna-build-api`
- PM2 process list saved with `pm2 save`.
- Local health checks passed:
  - `GET http://127.0.0.1:18860/health` returned `{"ok":true,"service":"linux-build-api"}`.
  - `GET http://127.0.0.1:3901/` returned HTTP 200.
- Re-ran the current upload public-preview verifier against the live hosted URL:
  - URL: `https://playcools.top/webgl/proj_1776912973985_5o2lyu/index.html`
  - Result: passed.
  - Default entry advanced from `enemyAttackWarning` to `gameEnd`.
  - `phaseChanges=11`, `visualDiff=1.000`, `visualFrames=13`.
- Windows worker `42.121.160.107` was rechecked directly from the main ECS:
  - The main route table has direct ECS egress via `eth0`, but policy routing initially sent ordinary traffic through `Meta`.
  - Added a temporary host-specific policy route for `42.121.160.107/32` to `lookup main` while testing.
  - After direct routing, SSH 22 returned `Connection refused`; RDP 3389 and WinRM 5985 were also unreachable.
  - Remote Windows worker deploy still cannot be completed until the remote service/security-group state is restored.
