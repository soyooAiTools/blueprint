# auto-deb3ed5e
## Diagnosis
`fidelity-source-diff` calls `runFieldLevelDiff()` for each pipeline phase id. If the phase id is missing from the fidelity contract, `expectedVisibleForPhase()` returns `null`, but `diffEntitiesBucket()` immediately iterates it. The stage throws the raw TypeError before `diffPhasesBucket()` can emit its existing structured `phase-missing` blocking diff.
## Root Cause
engine/stages/lib/field-diff.cjs:186
## Fix
In `engine/stages/lib/field-diff.cjs`, add the same missing-phase guard already used by `diffPrimitiveStyleBucket()`.

Change:

  const expectedVisible = expectedVisibleForPhase(indexed, phaseId);
  // (4) canonicalize observed visible set so a probe emitting `_player`,

To:

  const expectedVisible = expectedVisibleForPhase(indexed, phaseId);
  if (!expectedVisible) return entries;
  // (4) canonicalize observed visible set so a probe emitting `_player`,

This lets the entities bucket skip unknown phases while `diffPhasesBucket()` reports `phase-missing`.
## Verification
cd /opt/blueprint-editor && node -e "const fd=require('./engine/stages/lib/field-diff.cjs'); const indexed=fd.indexContract({phases:[{id:'phase1',showEntities:[]}],entities:[]}); const template={indexed,diffPhase:(phaseId,observed)=>({entities:fd.diffEntitiesBucket(indexed,phaseId,observed),phases:fd.diffPhasesBucket(indexed,phaseId,observed),hud:[],worldLabel:[],scene:[],primitiveStyle:[]})}; const out=fd.runFieldLevelDiff(template,'phase2',{}, {visibleEntities:[]}); if(!out.some(d=>d.category==='phase-missing')) process.exit(1); console.log(JSON.stringify(out));"