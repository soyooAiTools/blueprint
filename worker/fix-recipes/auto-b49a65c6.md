# auto-b49a65c6

## Diagnosis

`method-check` reports `assembly-module-owner-mismatch` when planned module instances cannot be matched to the owner partials that contain their machine-readable slot comments.

In the observed failure, the generated partial content was present, but C# comment localization changed comments such as:

```csharp
// [ASSEMBLY SLOT] OurBase::visual_binding
```

into a localized form that the contract parser treated as a different module id:

```csharp
// [ASSEMBLY SLOT] 装配槽 OurBase::visual_binding
```

This produced a large number of owner mismatch violations even though the deterministic scaffold had emitted the expected slot bodies.

## Root Cause

- `lib/csharp-comment-localizer.cjs` localized machine-readable assembly comments.
- `engine/assembly-plan-contracts.cjs` expected the exact slot id after `[ASSEMBLY SLOT]` and did not tolerate historical localized prefixes.

## Fix

1. Preserve machine-readable assembly comments during C# comment localization:
   - `[ASSEMBLY SLOT]`
   - `[ASSEMBLY PHASE]`
   - owner manifest / machine contract comments
2. Make slot ownership parsing backward-compatible with existing localized `装配槽` prefixes.
3. Re-run method-check against the failed checkpoint before requeueing from `codegen` or `review`.

## Verification

- `node -c lib/csharp-comment-localizer.cjs`
- `node -c engine/assembly-plan-contracts.cjs`
- `node test/csharp-comment-localizer.test.cjs`
- `node test/assembly-contracts-and-cua-bridge.test.cjs`
- Direct `detectAssemblyContractViolations(ctx)` against the failed checkpoint returns no owner mismatch violations.
