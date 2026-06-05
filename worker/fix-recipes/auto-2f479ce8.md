# auto-2f479ce8
## Diagnosis
When the LLM omits a CTA gate on the last schema phase, `_repairSchemaValidationErrors` in `codegen-schema.cjs` correctly detects the semantic error and injects a `near_entity` trigger. However it calls `pickCtaEntityNameForRepair()` which matches any `/CTA|Button/i` entity (e.g. "PlayButton", "NextButton"). The post-repair re-validation then calls `hasFinalCtaTrigger` → `isCtaEntityName()` which requires an exact `/^CTAButton$/i` match, so any non-canonical entity name causes the same error to survive repair and throws `Schema validation failed: Last phase trigger must include click_entity or CtaButton near_entity` across all LLM retries.

## Root Cause
`engine/stages/codegen-schema.cjs:1897–1913` — `_repairSchemaValidationErrors` CTA-gate repair block uses `pickCtaEntityNameForRepair()` (regex `/CTA|Button/i`, broad) while the validator `isCtaEntityName()` in `adapters/schema/validate-schema.cjs:40` requires exactly `/^CTAButton$/i`. Mismatch causes the post-repair `_validateSchema` call (line 632) to still report the same semantic error.

## Fix
Replace lines **1897–1913** in `engine/stages/codegen-schema.cjs` with the following. The fix:
1. Scans `entities` for an exact `/^CTAButton$/i` match first.
2. If none exists, **injects** a minimal `CTAButton` entity into `schema.entities` (and updates the local `entityNames` lookup so `validateTriggerRefs` also passes).
3. Uses the canonical name in the `near_entity` trigger so `hasFinalCtaTrigger` → `isCtaEntityName` succeeds on re-validation.