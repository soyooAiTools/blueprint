'use strict';

const fs = require('fs');
const path = require('path');
const { validateVisualAssetManifest } = require('./visual-assets.js');

const UNITY_ASSET_PLAN_SCHEMA_VERSION = 'uap.1.0.0';
const UNITY_ASSET_PLAN_KIND = 'demo2spec.unityAssetPlan';

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniq(values) {
  return Array.from(new Set(safeArray(values).filter(Boolean)));
}

function sanitizeId(value, fallback) {
  const text = String(value || fallback || 'asset').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  const base = text || 'asset';
  return /^[A-Za-z]/.test(base) ? base : ('asset_' + base);
}

function normalizePathPart(value, fallback) {
  return sanitizeId(value, fallback).replace(/^asset_/, '');
}

function stripQuery(url) {
  return String(url || '').split(/[?#]/)[0];
}

function extensionForAsset(asset, fallbackExt) {
  const source = asset && asset.source || {};
  const ext = path.extname(stripQuery(source.url || '')).toLowerCase();
  return ext || fallbackExt;
}

function actionIdForAsset(assetId) {
  return 'uap_' + sanitizeId(assetId, 'asset');
}

function assetBaseName(asset) {
  return normalizePathPart(asset && asset.assetId, 'asset');
}

function sourceAssetPath(asset, fallbackExt) {
  return 'Assets/Demo2Spec/SourceAssets/' + assetBaseName(asset) + extensionForAsset(asset, fallbackExt);
}

function prefabPath(asset) {
  return 'Assets/Demo2Spec/Prefabs/' + assetBaseName(asset) + '.prefab';
}

function texturePath(asset) {
  return 'Assets/Demo2Spec/Textures/' + assetBaseName(asset) + extensionForAsset(asset, '.png');
}

function materialPath(asset) {
  return 'Assets/Demo2Spec/Materials/' + assetBaseName(asset) + '.mat';
}

function primitiveForGeometry(geometry) {
  const type = geometry && geometry.type || 'UnknownGeometry';
  const map = {
    BoxGeometry: 'Cube',
    CylinderGeometry: 'Cylinder',
    SphereGeometry: 'Sphere',
    IcosahedronGeometry: 'Sphere',
    OctahedronGeometry: 'Sphere',
    TetrahedronGeometry: 'Sphere',
    PlaneGeometry: 'Plane',
  };
  if (map[type]) return { unityPrimitive: map[type], supported: true, fallback: type !== map[type] ? type : null };
  return { unityPrimitive: 'Cube', supported: false, fallback: type };
}

function materialPlan(asset) {
  const material = asset && asset.material || {};
  return {
    type: material.type || null,
    color: material.diffuseColor || '#FFFFFF',
    emissiveColor: material.emissiveColor || null,
    opacity: material.opacity == null ? null : material.opacity,
    transparent: material.transparent == null ? null : material.transparent,
    roughness: material.roughness == null ? null : material.roughness,
    metalness: material.metalness == null ? null : material.metalness,
    materialPath: materialPath(asset),
  };
}

function commonActionFields(asset) {
  return {
    actionId: actionIdForAsset(asset.assetId),
    assetId: asset.assetId,
    kind: asset.kind,
    source: asset.source || null,
    sourceAsset: asset.sourceAsset || null,
    license: asset.license || 'unknown',
    attribution: asset.attribution || null,
    entityBinding: asset.entityBinding || null,
    fidelityTarget: asset.fidelityTarget || null,
    visualFallback: asset.visualFallback || null,
    unsupported: safeArray(asset.unsupported),
  };
}

function externalSourceStatus(asset, isDataUri) {
  if (isDataUri) return 'requires_data_uri_decode';
  const sourceAsset = asset.sourceAsset || {};
  if (sourceAsset.readyForImport || sourceAsset.localSourceExists) return 'source_asset_local';
  if (sourceAsset.readyForFetch) return 'source_fetch_ready';
  if (sourceAsset.sourceUrl && (asset.license || 'unknown') === 'unknown') return 'requires_license_metadata';
  return 'requires_source_metadata';
}

function sourceFetchPlan(asset, targetPath, status) {
  const source = asset.source || {};
  const sourceAsset = asset.sourceAsset || {};
  return {
    status,
    url: sourceAsset.sourceUrl || (/^https?:\/\//i.test(source.url || '') ? source.url : null),
    originalUrl: source.url || null,
    targetPath,
    localSourcePath: sourceAsset.localSourcePath || null,
    localSourceExists: sourceAsset.localSourceExists === true,
    license: asset.license || 'unknown',
    attribution: asset.attribution || null,
  };
}

function externalWarnings(asset, status) {
  const warnings = [];
  if ((asset.license || 'unknown') === 'unknown') warnings.push('license_unknown');
  if (status === 'requires_source_metadata') warnings.push('source_metadata_missing');
  if (status === 'requires_license_metadata') warnings.push('license_metadata_missing');
  if (status === 'source_fetch_ready') warnings.push('source_fetch_required');
  if (status === 'requires_data_uri_decode') warnings.push('data_uri_decode_required');
  return warnings;
}

function externalModelAction(asset) {
  const source = asset.source || {};
  const isDataUri = source.type === 'data-uri' || /^data:/i.test(source.url || '');
  const targetPath = sourceAssetPath(asset, '.glb');
  const status = externalSourceStatus(asset, isDataUri);
  return Object.assign(commonActionFields(asset), {
    action: 'import_external_model',
    status,
    supported: true,
    sourceAssetPath: targetPath,
    sourceFetch: sourceFetchPlan(asset, targetPath, status),
    prefabPath: prefabPath(asset),
    unityImporter: 'ModelImporter',
    requiresEditor: true,
    warnings: externalWarnings(asset, status),
  });
}

function textureAction(asset) {
  const source = asset.source || {};
  const isDataUri = source.type === 'data-uri' || /^data:/i.test(source.url || '');
  const targetPath = texturePath(asset);
  const status = externalSourceStatus(asset, isDataUri);
  return Object.assign(commonActionFields(asset), {
    action: 'import_texture',
    status,
    supported: true,
    sourceAssetPath: targetPath,
    sourceFetch: sourceFetchPlan(asset, targetPath, status),
    texturePath: targetPath,
    materialPath: materialPath(asset),
    unityImporter: 'TextureImporter',
    requiresEditor: true,
    warnings: externalWarnings(asset, status),
  });
}

function proceduralPrimitiveAction(asset) {
  const primitive = primitiveForGeometry(asset.geometry || {});
  const warnings = [];
  if (!primitive.supported) warnings.push('primitive_shape_fallback:' + primitive.fallback);
  return Object.assign(commonActionFields(asset), {
    action: 'generate_primitive_prefab',
    status: primitive.supported ? 'ready' : 'fallback_required',
    supported: primitive.supported,
    prefabPath: prefabPath(asset),
    unityPrimitive: primitive.unityPrimitive,
    geometry: asset.geometry || null,
    material: materialPlan(asset),
    transform: asset.transform || {},
    requiresEditor: true,
    warnings,
  });
}

function proceduralCompositeAction(asset) {
  return Object.assign(commonActionFields(asset), {
    action: 'compose_prefab',
    status: 'ready',
    supported: true,
    prefabPath: prefabPath(asset),
    childAssetIds: uniq(asset.children || []),
    childActionIds: uniq(asset.children || []).map(actionIdForAsset),
    childVariables: uniq(asset.childVariables || []),
    requiresEditor: true,
    warnings: asset.visualFallback ? ['visual_fallback:' + asset.visualFallback] : [],
  });
}

function unsupportedAction(asset) {
  return Object.assign(commonActionFields(asset), {
    action: 'unsupported_asset',
    status: 'unsupported',
    supported: false,
    prefabPath: null,
    requiresEditor: false,
    warnings: ['unsupported_asset_kind:' + asset.kind],
  });
}

function buildAction(asset) {
  if (asset.kind === 'external_model') return externalModelAction(asset);
  if (asset.kind === 'texture') return textureAction(asset);
  if (asset.kind === 'procedural_primitive') return proceduralPrimitiveAction(asset);
  if (asset.kind === 'procedural_composite') return proceduralCompositeAction(asset);
  return unsupportedAction(asset);
}

function summarizeActions(actions) {
  const importActions = actions.filter(action => action.action === 'import_external_model' || action.action === 'import_texture');
  const summary = {
    actionCount: actions.length,
    externalImportCount: actions.filter(action => action.action === 'import_external_model').length,
    textureImportCount: actions.filter(action => action.action === 'import_texture').length,
    proceduralPrefabCount: actions.filter(action => action.action === 'generate_primitive_prefab').length,
    compositePrefabCount: actions.filter(action => action.action === 'compose_prefab').length,
    unsupportedActionCount: actions.filter(action => action.supported === false).length,
    pendingSourceAssetCount: importActions.filter(action => action.status !== 'source_asset_local').length,
    sourceFetchReadyCount: importActions.filter(action => action.status === 'source_fetch_ready').length,
    sourceAssetLocalCount: importActions.filter(action => action.status === 'source_asset_local').length,
    missingSourceMetadataCount: importActions.filter(action => action.status === 'requires_source_metadata' || action.status === 'requires_license_metadata').length,
    dataUriDecodeCount: importActions.filter(action => action.status === 'requires_data_uri_decode').length,
    unknownLicenseCount: actions.filter(action => action.license === 'unknown').length,
  };
  summary.editorBakeReadyCount = actions.filter(action => action.supported && action.action !== 'import_external_model' && action.action !== 'import_texture').length;
  return summary;
}

function buildEntityActionBindings(manifest, actionsByAssetId) {
  const out = {};
  const entityBindings = manifest && manifest.entityBindings || {};
  Object.keys(entityBindings).forEach(entity => {
    const binding = entityBindings[entity] || {};
    const primary = binding.primaryAssetId ? actionsByAssetId[binding.primaryAssetId] : null;
    out[entity] = {
      entityName: entity,
      actionIds: uniq(binding.assetIds || []).map(assetId => actionsByAssetId[assetId] && actionsByAssetId[assetId].actionId).filter(Boolean),
      primaryAssetId: binding.primaryAssetId || null,
      primaryActionId: primary ? primary.actionId : null,
      prefabPath: primary ? primary.prefabPath : null,
      textureAssetIds: uniq(binding.textureAssetIds || []),
      textureActionIds: uniq(binding.textureAssetIds || []).map(assetId => actionsByAssetId[assetId] && actionsByAssetId[assetId].actionId).filter(Boolean),
      fidelityTarget: binding.fidelityTarget || null,
      visualFallback: binding.visualFallback || null,
      bakingMode: primary ? primary.action : (binding.textureAssetIds && binding.textureAssetIds.length ? 'texture_only' : 'fallback_only'),
    };
  });
  return out;
}

function buildReadiness(summary, actions) {
  const violations = [];
  const warnings = [];
  actions.forEach(action => {
    if (!action.supported) {
      violations.push({ code: 'unity_asset_action_unsupported', assetId: action.assetId, action: action.action });
    }
    if (action.license === 'unknown') {
      warnings.push({ code: 'unity_asset_license_unknown', assetId: action.assetId });
    }
    if (action.status === 'requires_source_metadata') {
      violations.push({ code: 'unity_asset_source_metadata_missing', assetId: action.assetId });
    } else if (action.status === 'requires_license_metadata') {
      violations.push({ code: 'unity_asset_license_metadata_missing', assetId: action.assetId });
    } else if (action.status === 'source_fetch_ready') {
      warnings.push({ code: 'unity_asset_source_fetch_ready', assetId: action.assetId, targetPath: action.sourceAssetPath });
    } else if (/^requires_/.test(action.status || '')) {
      warnings.push({ code: 'unity_asset_source_required', assetId: action.assetId, status: action.status });
    }
  });
  return {
    passed: violations.length === 0,
    violations,
    warnings,
    summary,
  };
}

function buildUnityAssetPlan(assetManifest, options) {
  options = options || {};
  if (!assetManifest) {
    assetManifest = {
      visualAssetsSchemaVersion: null,
      kind: null,
      assets: [],
      entityBindings: {},
      extractionSummary: {},
    };
  } else {
    validateVisualAssetManifest(assetManifest);
  }
  const actions = safeArray(assetManifest.assets).map(buildAction);
  const actionsByAssetId = {};
  actions.forEach(action => { actionsByAssetId[action.assetId] = action; });
  const summary = summarizeActions(actions);
  const readiness = buildReadiness(summary, actions);
  return {
    unityAssetPlanSchemaVersion: UNITY_ASSET_PLAN_SCHEMA_VERSION,
    kind: UNITY_ASSET_PLAN_KIND,
    generatedAt: options.generatedAt || new Date().toISOString(),
    source: options.source || assetManifest.source || null,
    project: options.project || assetManifest.project || null,
    sourceManifest: {
      visualAssetsSchemaVersion: assetManifest.visualAssetsSchemaVersion || null,
      kind: assetManifest.kind || null,
      extractionSummary: assetManifest.extractionSummary || {},
    },
    target: {
      engine: 'unity',
      mode: 'editor-prefab-baking',
      root: 'Assets/Demo2Spec',
      sourceFetchCommand: 'node fetch-source-assets.js <unity-asset-plan.json> <unity-project-root>',
    },
    summary,
    readiness,
    actions,
    entityBindings: buildEntityActionBindings(assetManifest, actionsByAssetId),
  };
}

function validateUnityAssetPlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('unity asset plan must be an object');
  if (plan.unityAssetPlanSchemaVersion !== UNITY_ASSET_PLAN_SCHEMA_VERSION) {
    throw new Error('unsupported unity asset plan version: ' + plan.unityAssetPlanSchemaVersion);
  }
  if (plan.kind !== UNITY_ASSET_PLAN_KIND) throw new Error('invalid unity asset plan kind: ' + plan.kind);
  if (!Array.isArray(plan.actions)) throw new Error('unity asset plan missing actions[]');
  if (!plan.summary || typeof plan.summary !== 'object') throw new Error('unity asset plan missing summary');
  if (!plan.readiness || typeof plan.readiness !== 'object') throw new Error('unity asset plan missing readiness');
  return true;
}

function writeUnityAssetPlan(outPath, plan) {
  validateUnityAssetPlan(plan);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(plan, null, 2));
  return plan;
}

function loadUnityAssetPlan(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  validateUnityAssetPlan(doc);
  return doc;
}

function csharpString(value) {
  return String(value == null ? '' : value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function renderUnityEditorBaker(plan) {
  validateUnityAssetPlan(plan);
  const lines = [];
  lines.push('#if UNITY_EDITOR');
  lines.push('using System.IO;');
  lines.push('using UnityEditor;');
  lines.push('using UnityEngine;');
  lines.push('');
  lines.push('public static class Demo2SpecVisualAssetBaker');
  lines.push('{');
  lines.push('    struct Entry');
  lines.push('    {');
  lines.push('        public string assetId, kind, action, sourceUrl, sourceAssetPath, prefabPath, materialPath, texturePath, unityPrimitive, color, childAssetIds;');
  lines.push('        public bool supported;');
  lines.push('        public Entry(string assetId, string kind, string action, string sourceUrl, string sourceAssetPath, string prefabPath, string materialPath, string texturePath, string unityPrimitive, string color, string childAssetIds, bool supported)');
  lines.push('        {');
  lines.push('            this.assetId = assetId; this.kind = kind; this.action = action; this.sourceUrl = sourceUrl; this.sourceAssetPath = sourceAssetPath; this.prefabPath = prefabPath; this.materialPath = materialPath; this.texturePath = texturePath; this.unityPrimitive = unityPrimitive; this.color = color; this.childAssetIds = childAssetIds; this.supported = supported;');
  lines.push('        }');
  lines.push('    }');
  lines.push('');
  lines.push('    static readonly Entry[] Entries = new Entry[]');
  lines.push('    {');
  plan.actions.forEach(action => {
    const source = action.source || {};
    const sourceFetch = action.sourceFetch || {};
    const material = action.material || {};
    const childAssetIds = safeArray(action.childAssetIds).join('|');
    const args = [
      csharpString(action.assetId),
      csharpString(action.kind),
      csharpString(action.action),
      csharpString(sourceFetch.url || source.url || ''),
      csharpString(action.sourceAssetPath || ''),
      csharpString(action.prefabPath || ''),
      csharpString(action.materialPath || material.materialPath || ''),
      csharpString(action.texturePath || ''),
      csharpString(action.unityPrimitive || ''),
      csharpString(material.color || '#FFFFFF'),
      csharpString(childAssetIds),
    ];
    lines.push('        new Entry("' + args.join('", "') + '", ' + (action.supported ? 'true' : 'false') + '),');
  });
  lines.push('    };');
  lines.push('');
  lines.push('    [MenuItem("Demo2Spec/Rebuild Visual Asset Prefabs")]');
  lines.push('    public static void Rebuild()');
  lines.push('    {');
  lines.push('        EnsureFolder("Assets/Demo2Spec");');
  lines.push('        EnsureFolder("Assets/Demo2Spec/Prefabs");');
  lines.push('        EnsureFolder("Assets/Demo2Spec/Materials");');
  lines.push('        EnsureFolder("Assets/Demo2Spec/Textures");');
  lines.push('        EnsureFolder("Assets/Demo2Spec/SourceAssets");');
  lines.push('        for (int i = 0; i < Entries.Length; i++) if (Entries[i].action == "generate_primitive_prefab") BakePrimitive(Entries[i]);');
  lines.push('        for (int i = 0; i < Entries.Length; i++) if (Entries[i].action == "compose_prefab") BakeComposite(Entries[i]);');
  lines.push('        for (int i = 0; i < Entries.Length; i++) if (Entries[i].action == "import_texture") ImportTexture(Entries[i]);');
  lines.push('        for (int i = 0; i < Entries.Length; i++) if (Entries[i].action == "import_external_model") ImportExternalModel(Entries[i]);');
  lines.push('        AssetDatabase.SaveAssets();');
  lines.push('        AssetDatabase.Refresh();');
  lines.push('    }');
  lines.push('');
  lines.push('    static void BakePrimitive(Entry e)');
  lines.push('    {');
  lines.push('        if (!e.supported || string.IsNullOrEmpty(e.prefabPath)) { Debug.LogWarning("[Demo2SpecVisualAssetBaker] Unsupported primitive " + e.assetId); return; }');
  lines.push('        EnsureParentFolder(e.prefabPath);');
  lines.push('        var go = GameObject.CreatePrimitive(ParsePrimitive(e.unityPrimitive));');
  lines.push('        go.name = e.assetId;');
  lines.push('        ApplyColor(go, e.color, e.materialPath);');
  lines.push('        PrefabUtility.SaveAsPrefabAsset(go, e.prefabPath);');
  lines.push('        Object.DestroyImmediate(go);');
  lines.push('    }');
  lines.push('');
  lines.push('    static void BakeComposite(Entry e)');
  lines.push('    {');
  lines.push('        if (string.IsNullOrEmpty(e.prefabPath)) return;');
  lines.push('        EnsureParentFolder(e.prefabPath);');
  lines.push('        var root = new GameObject(e.assetId);');
  lines.push('        foreach (var childId in SplitChildren(e.childAssetIds))');
  lines.push('        {');
  lines.push('            Entry child;');
  lines.push('            if (!TryFind(childId, out child) || string.IsNullOrEmpty(child.prefabPath)) continue;');
  lines.push('            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(child.prefabPath);');
  lines.push('            if (prefab == null && child.action == "generate_primitive_prefab") { BakePrimitive(child); prefab = AssetDatabase.LoadAssetAtPath<GameObject>(child.prefabPath); }');
  lines.push('            if (prefab == null) continue;');
  lines.push('            var childObj = (GameObject)PrefabUtility.InstantiatePrefab(prefab);');
  lines.push('            childObj.transform.SetParent(root.transform, false);');
  lines.push('        }');
  lines.push('        PrefabUtility.SaveAsPrefabAsset(root, e.prefabPath);');
  lines.push('        Object.DestroyImmediate(root);');
  lines.push('    }');
  lines.push('');
  lines.push('    static void ImportTexture(Entry e)');
  lines.push('    {');
  lines.push('        if (!File.Exists(e.sourceAssetPath)) { Debug.LogWarning("[Demo2SpecVisualAssetBaker] Place texture source at " + e.sourceAssetPath + " for " + e.assetId + " from " + e.sourceUrl); return; }');
  lines.push('        AssetDatabase.ImportAsset(e.sourceAssetPath);');
  lines.push('        var tex = AssetDatabase.LoadAssetAtPath<Texture2D>(e.sourceAssetPath);');
  lines.push('        if (tex == null || string.IsNullOrEmpty(e.materialPath)) return;');
  lines.push('        EnsureParentFolder(e.materialPath);');
  lines.push('        var mat = new Material(Shader.Find("Standard"));');
  lines.push('        mat.mainTexture = tex;');
  lines.push('        AssetDatabase.CreateAsset(mat, e.materialPath);');
  lines.push('    }');
  lines.push('');
  lines.push('    static void ImportExternalModel(Entry e)');
  lines.push('    {');
  lines.push('        if (!File.Exists(e.sourceAssetPath)) { Debug.LogWarning("[Demo2SpecVisualAssetBaker] Place model source at " + e.sourceAssetPath + " for " + e.assetId + " from " + e.sourceUrl); return; }');
  lines.push('        AssetDatabase.ImportAsset(e.sourceAssetPath);');
  lines.push('        var imported = AssetDatabase.LoadAssetAtPath<GameObject>(e.sourceAssetPath);');
  lines.push('        if (imported == null || string.IsNullOrEmpty(e.prefabPath)) return;');
  lines.push('        EnsureParentFolder(e.prefabPath);');
  lines.push('        var instance = (GameObject)PrefabUtility.InstantiatePrefab(imported);');
  lines.push('        PrefabUtility.SaveAsPrefabAsset(instance, e.prefabPath);');
  lines.push('        Object.DestroyImmediate(instance);');
  lines.push('    }');
  lines.push('');
  lines.push('    static PrimitiveType ParsePrimitive(string value)');
  lines.push('    {');
  lines.push('        switch (value) { case "Sphere": return PrimitiveType.Sphere; case "Cylinder": return PrimitiveType.Cylinder; case "Capsule": return PrimitiveType.Capsule; case "Plane": return PrimitiveType.Plane; default: return PrimitiveType.Cube; }');
  lines.push('    }');
  lines.push('');
  lines.push('    static void ApplyColor(GameObject go, string htmlColor, string materialPath)');
  lines.push('    {');
  lines.push('        Color color;');
  lines.push('        if (!ColorUtility.TryParseHtmlString(htmlColor, out color)) color = Color.white;');
  lines.push('        var renderer = go.GetComponent<Renderer>();');
  lines.push('        if (renderer == null) return;');
  lines.push('        Material mat = null;');
  lines.push('        if (!string.IsNullOrEmpty(materialPath)) mat = AssetDatabase.LoadAssetAtPath<Material>(materialPath);');
  lines.push('        if (mat == null)');
  lines.push('        {');
  lines.push('            mat = new Material(renderer.sharedMaterial);');
  lines.push('            if (!string.IsNullOrEmpty(materialPath))');
  lines.push('            {');
  lines.push('                EnsureParentFolder(materialPath);');
  lines.push('                AssetDatabase.CreateAsset(mat, materialPath);');
  lines.push('            }');
  lines.push('        }');
  lines.push('        mat.color = color;');
  lines.push('        EditorUtility.SetDirty(mat);');
  lines.push('        renderer.sharedMaterial = mat;');
  lines.push('    }');
  lines.push('');
  lines.push('    static string[] SplitChildren(string value) { return string.IsNullOrEmpty(value) ? new string[0] : value.Split(\'|\'); }');
  lines.push('    static bool TryFind(string assetId, out Entry entry)');
  lines.push('    {');
  lines.push('        for (int i = 0; i < Entries.Length; i++) if (Entries[i].assetId == assetId) { entry = Entries[i]; return true; }');
  lines.push('        entry = default(Entry); return false;');
  lines.push('    }');
  lines.push('');
  lines.push('    static void EnsureParentFolder(string assetPath)');
  lines.push('    {');
  lines.push('        var folder = Path.GetDirectoryName(assetPath);');
  lines.push('        if (!string.IsNullOrEmpty(folder)) EnsureFolder(folder.Replace("\\\\", "/"));');
  lines.push('    }');
  lines.push('');
  lines.push('    static void EnsureFolder(string folder)');
  lines.push('    {');
  lines.push('        if (string.IsNullOrEmpty(folder) || folder == "Assets" || AssetDatabase.IsValidFolder(folder)) return;');
  lines.push('        var parent = Path.GetDirectoryName(folder);');
  lines.push('        if (!string.IsNullOrEmpty(parent)) EnsureFolder(parent.Replace("\\\\", "/"));');
  lines.push('        AssetDatabase.CreateFolder(string.IsNullOrEmpty(parent) ? "Assets" : parent.Replace("\\\\", "/"), Path.GetFileName(folder));');
  lines.push('    }');
  lines.push('}');
  lines.push('#endif');
  lines.push('');
  return lines.join('\n');
}

function writeUnityEditorBaker(outPath, plan) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, renderUnityEditorBaker(plan));
}

module.exports = {
  UNITY_ASSET_PLAN_SCHEMA_VERSION,
  UNITY_ASSET_PLAN_KIND,
  buildUnityAssetPlan,
  validateUnityAssetPlan,
  writeUnityAssetPlan,
  loadUnityAssetPlan,
  renderUnityEditorBaker,
  writeUnityEditorBaker,
};
