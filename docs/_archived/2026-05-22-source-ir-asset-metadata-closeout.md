# 2026-05-22 source-ir asset metadata closeout

## Scope

This closes #source-ir task #5/#6 v3: storyboard2html now has a strict external asset metadata carrier, and source-ir can carry that metadata into Unity asset import planning.

## Commits

- `soyooAiTools/blueprint@1bac43f` — storyboard2html prompt L4 `window.__assetMeta` carrier with strict license enum, null rules, and attribution length cap.
- `soyooAiTools/source-ir@3946dc4` — extractor `metadataStatus/sourceAsset`, Unity `source_fetch_ready`, and `fetch-source-assets.js`.
- `soyooAiTools/source-ir@5a87e5a` — source-ir skill/HANDOFF documentation for the L4 contract.
- `soyooAiTools/blueprint-skill@318ad1f` — Blueprint skill/build-pipeline documentation for the L4 contract.

## Contract

storyboard2html-generated HTML must expose external asset metadata as a top-level literal:

```js
window.__assetMeta = {
  "./models/HeroShip.glb": {
    license: "CC-BY-4.0",
    attribution: "source or author",
    sourceUrl: "https://example.com/HeroShip.glb"
  }
};
```

Rules:

- `window.__assetMeta` must be top-level. DOMContentLoaded/IIFE/function-scope assignment is rejected by source-ir as `asset_meta_not_top_level`.
- `license` is case-sensitive and must be one of `CC0`, `CC-BY-4.0`, `CC-BY-SA-4.0`, `CC-NC-<suffix>`, `proprietary`, or `unknown`.
- Unknown `attribution` and `sourceUrl` must be `null`, not `""`.
- `attribution` must be at most 200 characters.
- source-ir does not silently normalize invalid metadata. Invalid entries become `metadataStatus:"invalid"` and do not unlock fetch readiness.

## Verification

source-ir:

```bash
node --check visual-assets.js unity-asset-plan.js fetch-source-assets.js test/snapshot-schema.test.cjs
git diff --check
node test/snapshot-schema.test.cjs
node index.js test/fixtures/model-assets.html /tmp/source-ir-model-assets-smoke-v3 --theme tower-defense --blueprint-smoke
node fetch-source-assets.js /tmp/source-ir-model-assets-smoke-v3/unity-asset-plan.json /tmp/source-ir-model-assets-smoke-v3/unity-project --dry-run
```

Smoke result:

- `assetMetadata.diagnostics.length=0`
- metadata matched `2/2`
- `sourceFetchReady=2/2`
- `missingSourceMetadata=0`
- fetch dry-run `readyTaskCount=2`
- Luna HTML build passed

Blueprint deployment:

- Restarted PM2 `blueprint-editor`.
- Restarted `linux-worker-1` through `linux-worker-6`.
- `http://127.0.0.1:3901/api/dashboard/api-health` returned `server.status="ok"`.
- `http://127.0.0.1:18860/health` returned `ok=true`.
- PM2 shows `blueprint-editor` and all six linux workers online.

## Residual

This closes the metadata/readiness chain and provides a fetch helper. A future task should wire source fetching and Unity Editor baking into the full Unity export/CI flow instead of only running it as a source-ir CLI step plus Editor menu entry.
