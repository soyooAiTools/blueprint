# auto-b49a65c6

## Diagnosis
`method-check` repeatedly failed with `assembly-module-owner-mismatch` because generated partial files omitted the machine-readable `// [ASSEMBLY SLOT] <moduleInstanceId>` marker expected by the assembly contract scanner.

The generated method bodies were often usable, but the missing marker caused a full codegen retry instead of a deterministic in-place repair.

## Root Cause
`engine/stages/method-check.cjs` had deterministic repairs for several contract failures, but no repair for missing assembly slot ownership markers.

## Fix
Add `autoRepairAssemblyModuleOwnerMismatch(ctx)`:

- read `assemblyPlan.moduleInstances`
- for each declared `ownerFiles[]`, check whether the file exists in `ctx.extraFiles`
- insert `// [ASSEMBLY SLOT] <id>` at the top when the marker is missing
- run it before contract violation detection rejects the build

## Verification
- `node test/method-check-auto-repair.test.cjs`
- `npm test`
