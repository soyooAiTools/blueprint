# auto-a3298ef4
## Diagnosis
When the complexity score exceeds 250, `callLLMSimplify()` calls the Doubao provider and passes the raw response text to `parseSimplifyResponse()`. The parser uses a regex that requires **both** an opening and a closing ` ``` ` fence. If the LLM response is truncated or the model emits only an opening ` ```json ` fence, `match` is `null`, the fallback assigns `raw = text` (still containing the fence), and `JSON.parse` immediately throws `Unexpected token '`'`. The stage has `canRetry: false`, so the single failure surfaces to the pipeline as a hard error.

## Root Cause
`engine/stages/complexity-gate.cjs:223-229` — `parseSimplifyResponse()` regex `/```(?:json)?\s*([\s\S]*?)```/` returns `null` when the closing ` ``` ` is absent, leaving the backtick-prefixed text passed directly to `JSON.parse`.

## Fix
Replace lines 221–229 in `engine/stages/complexity-gate.cjs`: