# auto-7e49ed02
## Diagnosis
The `cua-verify` stage enforces a wall-clock budget via `MAX_CUA_TOTAL_MS` (line 164 of `cua-verify.cjs`), which reads `process.env.CUA_TOTAL_TIMEOUT_MS` when present. A prior code change raised the **default** from 45 min to 75 min (to accommodate 8-10 min Opus recode+rebuild cycles), but an **ambient system environment variable** left over from the old configuration was still set to `2700000` ms (45 min). Because Node.js reads the process environment at module load time and the ternary is truthy on any non-empty string, the stale 45-min system value overrode the new code default. A CUA run lasting 47 min — within the intended 75-min budget — was therefore killed two retries in a row.

## Root Cause
`engine/stages/cua-verify.cjs:164-166` — `process.env.CUA_TOTAL_TIMEOUT_MS` truthy check picks up stale ambient system value `2700000` (45 min) instead of falling through to the updated 75-min code default: