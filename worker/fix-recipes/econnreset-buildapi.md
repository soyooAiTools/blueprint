# Recipe: Build failed ... ECONNRESET → LINUX_BUILD_URL points to zombie remote

## Fingerprint signature
Error messages like:
- `Build failed: connect ECONNRESET <ip>:<port>`
- `Build failed: read ECONNRESET`
- Stage: `compile`, often after a few seconds of stall

## Root cause (known)
The Linux build server runs ON THIS MACHINE at `http://127.0.0.1:18860`. If `LINUX_BUILD_URL` is either:
1. Missing from the .env the worker actually reads, OR
2. Set to a stale remote IP (e.g. the old remote build box that no longer responds),

…then the compile stage will try to TCP-connect to a dead endpoint and get `ECONNRESET`.

There are TWO .env files and the worker reads `/opt/blueprint-editor/.env`, NOT `/opt/blueprint-editor/worker/.env`. If the build URL is only set in the worker one, the worker silently falls back to the default hardcoded in `worker-client.js` or `linux-worker-client.js`.

See memory:
- `feedback_build_url_localhost.md` — build-api runs on this machine at 18860
- `feedback_dotenv_path_mismatch.md` — double .env path trap

Commits: `529136b`, `57a9f69`

## Diagnostic steps

1. **Check both .env files**:
   ```bash
   grep -n LINUX_BUILD_URL /opt/blueprint-editor/.env /opt/blueprint-editor/worker/.env
   ```
   Both must contain `LINUX_BUILD_URL=http://127.0.0.1:18860`.

2. **Confirm the build server is actually up on this host**:
   ```bash
   curl -sS -m 3 http://127.0.0.1:18860/health || curl -sS -m 3 http://127.0.0.1:18860/
   pm2 list | grep build
   ```

3. **Confirm the worker process is seeing the right env**:
   ```bash
   pm2 env 0 2>/dev/null | grep LINUX_BUILD_URL
   ```
   (Replace `0` with the actual blueprint-editor pm2 id if different.)

4. **Check the fallback hardcoded defaults in code**:
   - `worker/codex-code-coder.js` — `BUILD_URL = process.env.LINUX_BUILD_URL || 'http://localhost:3080'` ← this 3080 fallback is WRONG on this host; should be `127.0.0.1:18860`
   - `worker/linux-worker-client.js:330` — should fall back to `http://127.0.0.1:18860` ✓
   - `worker/worker-client.js:22` — should fall back to `http://127.0.0.1:18860` ✓

## Expected patch

**A. If `.env` is missing the var** — add it to `/opt/blueprint-editor/.env`:
```
LINUX_BUILD_URL=http://127.0.0.1:18860
```
(And also to `/opt/blueprint-editor/worker/.env` for any process that reads that one.)

**B. If the .env is correct but codex-code-coder.js fallback is wrong** — fix the fallback:
```javascript
// Before:
const BUILD_URL = process.env.LINUX_BUILD_URL || 'http://localhost:3080';
// After:
const BUILD_URL = process.env.LINUX_BUILD_URL || 'http://127.0.0.1:18860';
```

**C. If the build server is actually dead** — that's an infra issue, not a code fix. Start it via pm2 and STOP. Do not keep retrying tasks against a dead server.

## Verification command

```bash
curl -sS -m 3 http://127.0.0.1:18860/health && echo OK
```

And confirm env propagation to the worker:

```bash
pm2 env blueprint-editor 2>/dev/null | grep LINUX_BUILD_URL
```

## DO NOT

- Do NOT `pm2 restart blueprint-editor` as a fix. See memory `feedback_avoid_restart.md`. If env needs to propagate, use `pm2 reload` and only when no task is running.
- Do NOT add retry-with-backoff around ECONNRESET. If the build server is dead, retry just burns Claude quota. Surface the failure.

## Related memory / commits
- `feedback_build_url_localhost.md`
- `feedback_dotenv_path_mismatch.md`
- `feedback_avoid_restart.md`
- Commits `529136b`, `57a9f69`
