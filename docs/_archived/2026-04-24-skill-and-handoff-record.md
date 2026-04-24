# 2026-04-24 Skill And Handoff Record

Date:
- 2026-04-24 Asia/Shanghai

Purpose:
- Record which operational docs are versioned in Git and which remain local-only on the host.
- Avoid later confusion between "updated on disk" and "committed to repository".

Versioned in `/opt/blueprint-editor`:
- `docs/_archived/2026-04-24-runtime-contract-recheck-and-evidence-protocol.md`
  - committed in `077a9dd` `feat: harden runtime contract verification loop`
- `docs/_archived/2026-04-24-skill-and-handoff-record.md`
  - this file

Local-only operational files on this host:
- `/root/.codex/skills/blueprint-monitor/SKILL.md`
- `/root/.codex-blueprint/skills/blueprint-monitor/SKILL.md`
- `/root/codex-handoff-latest.md`

Important note:
- The paths above are not inside Git repositories on this machine.
- They can be updated and used by the live environment, but they do not produce Git history by themselves.
- Any long-term audit trail for them must be mirrored into a tracked repository document like this one.

Current associated source commits:
- `/opt/blueprint-editor`
  - `077a9dd` `feat: harden runtime contract verification loop`
  - `d9123b3` `feat: wire runtime contract into pipeline flow`
  - `b703d72` `feat: preserve checkpoints for cancelled task resume`
  - `40da36f` `test: cover reused spec submit and cancelled resume guards`
  - `0399093` `feat: add deterministic repair and infra fallbacks`
  - `bf3885a` `feat: expand assembly-first template coverage`
- `/root/cua-agent`
  - `a888d9b` `feat: support explicit runtime signal evidence`
  - `fd77eb0` `fix: track cua phase id normalization module`

Operator guidance:
- Treat `/root/codex-handoff-latest.md` as the latest local runbook snapshot.
- Treat the versioned files under `docs/_archived/` as the canonical Git history.
- Do not commit `server-data/**` runtime artifacts as documentation.
