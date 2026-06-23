# UnityComponent v1 accepted corpus

This directory contains accepted SourceIR/WebGL artifact samples used as
UnityComponent v1 cutover evidence.

Required core artifacts for every sample:

- `source-ir.json`
- `playable-scene-ir.json`
- `asset-manifest.json`
- `unity-asset-plan.json` or `blueprint-unity-asset-plan.json`

Source build evidence metadata follows `optional-pair-validated`:

- `source-ir-report.json` and `source-ir-build-summary.json` are optional for
  historical samples.
- When either evidence file is present, both files must be present.
- Included evidence files must be passing/accepted.
- Missing historical evidence must not be fabricated only to make sample
  directories look uniform.

The cutover CI gate must still run required Unity import/compile smoke on the
generated projects before `unitycomponent-v1` can be considered cutover-ready.
