# auto-6d24da7e
## Diagnosis
`fidelity-source-diff` calls `window.__driveToPhase(n)` inside a bare `await page.evaluate(...)` with no try/catch. When the compiled Luna/PlayCanvas target game throws a JavaScript runtime exception during `Phase_openingDistress_Init` (null GameObject `.transform` access), Playwright surfaces it as a rejected `page.evaluate` promise. Because there is no catch at that call site, the rejection propagates uncaught through `drivePageToPhase` → `captureFrame` → `execute`, immediately killing the stage with a hard error **before** the pipeline ever reaches the compile fix-loop, visual-check, or cua-verify stages that carry the null-crash remediation machinery. Since `canRetry: false` on this stage, the entire pipeline is rewound and retried by the outer worker loop, reproducing the exact same crash 7 times.

## Root Cause
`engine/stages/fidelity-source-diff.cjs:442` — `await page.evaluate(window.__driveToPhase(n))` inside `drivePageToPhase()` is completely unguarded; every other Playwright call in the same function already uses try/catch (line 428) or `.catch()` (line 439), but this one was left bare.

## Fix
In `engine/stages/fidelity-source-diff.cjs`, replace the unguarded block at lines 441–452: