# auto-265daa80
## Diagnosis
The LLM spec extractor frequently writes abbreviated entity references such as `"drill"` instead
of the blueprint-canonical `"BasicDrill"`. The entity validation in `spec-validate.cjs` only
checked exact-match (line 97) and case-insensitive-exact-match (line 106); neither catches a
partial/abbreviated name. Because `canRetry: false` is set on the stage, every such mismatch
kills the entire pipeline run and the outer retry loop exhausts 6 full cycles before a human
intervenes — roughly 4–6 extra LLM codegen invocations wasted per task.

## Root Cause
`engine/stages/spec-validate.cjs:148-152` — after the two-tier match the code falls through
unconditionally to `errors.push(...)`, with no substring or edit-distance fallback to handle
unambiguous abbreviations.