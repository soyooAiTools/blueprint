# auto-4eef18d9
## Diagnosis
The LLM spec extractor intermittently lowercases the first letter of entity names in `spec.entitiesRequired[].name` (e.g. `forgeWorkshop` instead of the blueprint-canonical `ForgeWorkshop`). The original spec-validate entity check used a case-sensitive `Set.has()` with no fallback, so every such mismatch became a hard blocking error. Because `spec-validate` has `canRetry: false` and the outer worker re-parses `task.blueprint_json` from scratch on each retry, the camelCase names re-appeared on every run, causing 4 consecutive failures before a human intervened.

## Root Cause
`engine/stages/spec-validate.cjs` — original entity reference check (pre-fix, was at line ~89):