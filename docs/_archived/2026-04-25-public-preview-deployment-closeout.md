# 2026-04-25 Public Preview Deployment Closeout

## Scope

- Project: `proj_1776912973985_5o2lyu`
- Public preview: `https://playcools.top/webgl/proj_1776912973985_5o2lyu/index.html`
- Production repo before this docs-only closeout: `0ce644b` (`origin/main`)
- Main deployed fix: `6bbaeff` (`fix: harden public preview visual gate`)

## Deployment State

- Local production PM2 services are online:
  - `blueprint-editor`
  - `linux-worker-1` through `linux-worker-6`
  - `blueprint-monitor-loop`
  - `luna-build-api`
- `luna-build-api` health check passed:
  - `GET http://127.0.0.1:18860/health`
  - `{"ok":true,"service":"linux-build-api"}`
- Runtime bridge sync was verified:
  - `/opt/luna-poc/linux-bridge-build.js`
  - `/opt/blueprint-editor/worker/linux-bridge-build.js`

## Live Verification

Blueprint monitor snapshot:

- `projects=1`
- `processing=0`
- `failed=0`
- `done-or-reviewing=1`
- top blocking rules: none

Task table snapshot:

- `cua_passed=1`
- `done=2`
- no `pending`, `queued`, `processing`, `failed`, `stuck`, or `reviewing` tasks

Bare public preview probe:

- Result: `passed=true`
- Reason: `public-preview-progressed`
- Progression: `enemyAttackWarning -> dispatchAstronautAttack`
- Completed phases: `3/3`
- Phase changes: `3`
- Visual max diff: `0.031`

Post-restart public preview probe:

- Result: `passed=true`
- Progression: `enemyAttackWarning -> dispatchAstronautAttack`
- Completed phases: `3/3`
- Visual max diff: `0.029`

## Checks

- `node -c engine/stages/upload.cjs`
- `node -c worker/linux-bridge-build.js`
- `node test/linux-bridge-start-fallback.test.cjs`
- `node test/upload-public-preview.test.cjs`
- `node -c /root/.codex-blueprint/skills/blueprint-monitor/scripts/blueprint-monitor.cjs`
- `node -c /root/.codex/skills/blueprint-monitor/scripts/blueprint-monitor.cjs`

## Skill Sync

Updated the local Blueprint monitor skill copies with the release closeout runbook:

- `/root/.codex/skills/blueprint-monitor/SKILL.md`
- `/root/.codex-blueprint/skills/blueprint-monitor/SKILL.md`

The skill now explicitly calls out:

- Compare bare `index.html` with `iframe.html?autoplay=1` when CUA passes but the public preview freezes.
- Wait for `window.app`, `window.__gameState`, or `window.__getGameState()` before starting upload progress timing.
- Require both phase progression and screenshot pixel diff in the public preview probe.
- Wait for `window.startGame` to be parsed before dispatching `luna:start`.
- Treat `done` / `cua_passed` mapped to `reviewing` as the normal manual-review state.
- During release closeout, record monitor status, PM2 status, live public probe result, and runtime bridge sync.

## Notes

- Runtime files under `server-data/**` are intentionally not part of the release commit.
- The remote Windows worker deploy path remains blocked by host-key / credential confirmation and should not be treated as completed until operator access is confirmed.
