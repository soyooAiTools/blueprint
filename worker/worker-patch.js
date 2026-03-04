// Patch for worker-client.js
// Adds: generateExportAssets, fixLunaJson, detectScenes
// These run before Luna build to ensure .export-assets exists

const fs = require('fs');
const path = require('path');

const MSBUILD_PATH = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\MSBuild\\Current\\Bin\\MSBuild.exe';

/**
 * Recursively find .unity files under Assets/Scenes/
 */
function detectScenes(clientDir) {
  const scenesDir = path.join(clientDir, 'Assets', 'Scenes');
  const scenes = [];
  
  function walk(dir, prefix) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const fullPath = path.join(dir, e.name);
      const assetPath = prefix + '/' + e.name;
      if (e.isDirectory()) {
        walk(fullPath, assetPath);
      } else if (e.name.endsWith('.unity')) {
        scenes.push(assetPath);
      }
    }
  }
  
  walk(scenesDir, 'Assets/Scenes');
  
  // Fallback: search all of Assets for .unity files
  if (scenes.length === 0) {
    function walkAll(dir, prefix) {
      if (!fs.existsSync(dir)) return;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          if (e.name === 'Library' || e.name === 'LunaTemp' || e.name === 'Temp') continue;
          const fullPath = path.join(dir, e.name);
          const assetPath = prefix + '/' + e.name;
          if (e.isDirectory()) {
            walkAll(fullPath, assetPath);
          } else if (e.name.endsWith('.unity')) {
            scenes.push(assetPath);
          }
        }
      } catch(e) {}
    }
    walkAll(path.join(clientDir, 'Assets'), 'Assets');
  }
  
  return scenes;
}

/**
 * Fix luna.json: update MSBuild path, ensure scenes are populated
 */
function fixLunaJson(clientDir, scenes) {
  const lunaJsonPath = path.join(clientDir, 'luna.json');
  if (!fs.existsSync(lunaJsonPath)) return false;
  
  const lunaJson = JSON.parse(fs.readFileSync(lunaJsonPath, 'utf-8'));
  let changed = false;
  
  // Fix MSBuild path
  if (lunaJson.unity && lunaJson.unity.scripts) {
    const current = lunaJson.unity.scripts.msbuildWin64;
    if (!current || !fs.existsSync(current)) {
      lunaJson.unity.scripts.msbuildWin64 = MSBUILD_PATH;
      changed = true;
      console.log('[fixLunaJson] Updated msbuildWin64 to: ' + MSBUILD_PATH);
    }
  }
  
  // Fix scenes
  if (lunaJson.unity && (!lunaJson.unity.scenes || lunaJson.unity.scenes.length === 0)) {
    if (scenes.length > 0) {
      lunaJson.unity.scenes = scenes;
      changed = true;
      console.log('[fixLunaJson] Updated scenes: ' + JSON.stringify(scenes));
    }
  }
  
  if (changed) {
    fs.writeFileSync(lunaJsonPath, JSON.stringify(lunaJson, null, 4), 'utf-8');
  }
  
  return true;
}

/**
 * Generate .export-assets file required by Luna pipeline
 */
function generateExportAssets(clientDir, scenes) {
  const lunaJsonPath = path.join(clientDir, 'luna.json');
  if (!fs.existsSync(lunaJsonPath)) return false;
  
  const lunaJson = JSON.parse(fs.readFileSync(lunaJsonPath, 'utf-8'));
  const creativeName = lunaJson.creativeName || path.basename(path.dirname(clientDir)) || 'project';
  
  const excludes = (lunaJson.unity && lunaJson.unity.assets && lunaJson.unity.assets.excludes) || [];
  const includes = (lunaJson.unity && lunaJson.unity.assets && lunaJson.unity.assets.includes) || [];
  const scriptExcludes = (lunaJson.unity && lunaJson.unity.scripts && lunaJson.unity.scripts.excludes) || [];
  
  const allExcludes = [...new Set([...excludes, ...scriptExcludes])];
  
  const exportAssets = {
    targetPlatform: 'playground',
    creativeName: creativeName,
    targetPath: path.join(clientDir, 'LunaTemp', 'stage1'),
    locked: true,
    enableRealtimeShadows: lunaJson.unity ? (lunaJson.unity.enableRealtimeShadows || false) : false,
    enableAutoInstancing: false,
    enableStaticBatching: false,
    enableDynamicBatching: lunaJson.unity ? (lunaJson.unity.enableDynamicBatching || false) : false,
    exportables: [],
    excludes: allExcludes,
    includes: includes,
    scenes: scenes
  };
  
  const exportAssetsPath = path.join(clientDir, 'Assets', '.export-assets');
  
  // Ensure Assets dir exists
  const assetsDir = path.join(clientDir, 'Assets');
  if (!fs.existsSync(assetsDir)) {
    console.error('[generateExportAssets] Assets directory not found: ' + assetsDir);
    return false;
  }
  
  fs.writeFileSync(exportAssetsPath, JSON.stringify(exportAssets), 'utf-8');
  console.log('[generateExportAssets] Written: ' + exportAssetsPath);
  
  // Luna also looks for .export-assets at parent/Assets/.export-assets
  // (when cwd is Client/, Luna resolves ../Assets/ instead of ./Assets/)
  const parentAssetsDir = path.join(clientDir, '..', 'Assets');
  if (!fs.existsSync(parentAssetsDir)) {
    fs.mkdirSync(parentAssetsDir, { recursive: true });
  }
  const parentExportAssetsPath = path.join(parentAssetsDir, '.export-assets');
  fs.writeFileSync(parentExportAssetsPath, JSON.stringify(exportAssets), 'utf-8');
  console.log('[generateExportAssets] Also written to parent: ' + parentExportAssetsPath);
  
  console.log('[generateExportAssets] Scenes: ' + JSON.stringify(scenes));
  return true;
}

// Test
if (require.main === module) {
  const clientDir = process.argv[2] || 'D:\\work\\test-luna\\Client';
  console.log('Testing with clientDir:', clientDir);
  const scenes = detectScenes(clientDir);
  console.log('Detected scenes:', scenes);
  fixLunaJson(clientDir, scenes);
  generateExportAssets(clientDir, scenes);
}

/**
 * Inject a hidden __MaterialSource Cube into a .unity scene file
 * so that runtime code can clone a valid Material from it.
 * Skips if __MaterialSource already exists in the scene.
 */
function injectMaterialSource(sceneFilePath) {
  if (!fs.existsSync(sceneFilePath)) return false;
  const content = fs.readFileSync(sceneFilePath, 'utf-8');
  if (content.includes('__MaterialSource')) {
    console.log('[injectMaterialSource] Already exists in: ' + sceneFilePath);
    return false;
  }

  const cubeYaml = `
--- !u!1 &8880000
GameObject:
  m_ObjectHideFlags: 0
  m_CorrespondingSourceObject: {fileID: 0}
  m_PrefabInstance: {fileID: 0}
  m_PrefabAsset: {fileID: 0}
  serializedVersion: 6
  m_Component:
  - component: {fileID: 8880001}
  - component: {fileID: 8880002}
  - component: {fileID: 8880003}
  - component: {fileID: 8880004}
  m_Layer: 0
  m_Name: __MaterialSource
  m_TagString: Untagged
  m_Icon: {fileID: 0}
  m_NavMeshLayer: 0
  m_StaticEditorFlags: 0
  m_IsActive: 0
--- !u!4 &8880001
Transform:
  m_ObjectHideFlags: 0
  m_CorrespondingSourceObject: {fileID: 0}
  m_PrefabInstance: {fileID: 0}
  m_PrefabAsset: {fileID: 0}
  m_GameObject: {fileID: 8880000}
  serializedVersion: 2
  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}
  m_LocalPosition: {x: 0, y: -9999, z: 0}
  m_LocalScale: {x: 1, y: 1, z: 1}
  m_ConstrainProportionsScale: 0
  m_Children: []
  m_Father: {fileID: 0}
  m_LocalEulerAnglesHint: {x: 0, y: 0, z: 0}
--- !u!33 &8880002
MeshFilter:
  m_ObjectHideFlags: 0
  m_CorrespondingSourceObject: {fileID: 0}
  m_PrefabInstance: {fileID: 0}
  m_PrefabAsset: {fileID: 0}
  m_GameObject: {fileID: 8880000}
  m_Mesh: {fileID: 10202, guid: 0000000000000000e000000000000000, type: 0}
--- !u!65 &8880003
BoxCollider:
  m_ObjectHideFlags: 0
  m_CorrespondingSourceObject: {fileID: 0}
  m_PrefabInstance: {fileID: 0}
  m_PrefabAsset: {fileID: 0}
  m_GameObject: {fileID: 8880000}
  m_Material: {fileID: 0}
  m_IncludeLayers:
    serializedVersion: 2
    m_Bits: 0
  m_ExcludeLayers:
    serializedVersion: 2
    m_Bits: 0
  m_IsTrigger: 0
  m_Enabled: 1
  serializedVersion: 3
  m_Size: {x: 1, y: 1, z: 1}
  m_Center: {x: 0, y: 0, z: 0}
--- !u!23 &8880004
MeshRenderer:
  m_ObjectHideFlags: 0
  m_CorrespondingSourceObject: {fileID: 0}
  m_PrefabInstance: {fileID: 0}
  m_PrefabAsset: {fileID: 0}
  m_GameObject: {fileID: 8880000}
  m_Enabled: 1
  m_CastShadows: 1
  m_ReceiveShadows: 1
  m_DynamicOccludee: 1
  m_StaticShadowCaster: 0
  m_MotionVectors: 1
  m_LightProbeUsage: 1
  m_ReflectionProbeUsage: 1
  m_RayTracingMode: 2
  m_RayTraceProcedural: 0
  m_RenderingLayerMask: 1
  m_RendererPriority: 0
  m_Materials:
  - {fileID: 10303, guid: 0000000000000000f000000000000000, type: 0}
  m_StaticBatchInfo:
    firstSubMesh: 0
    subMeshCount: 0
  m_StaticBatchRoot: {fileID: 0}
  m_ProbeAnchor: {fileID: 0}
  m_LightProbeVolumeOverride: {fileID: 0}
  m_SceneOffsetInLightmap: {x: 0, y: 0}
  m_ScaleInLightmap: 1
  m_ReceiveGI: 1
  m_PreserveUVs: 0
  m_IgnoreNormalsForChartDetection: 0
  m_ImportantGI: 0
  m_StitchLightmapSeams: 1
  m_SelectedEditorRenderState: 3
  m_MinimumChartSize: 4
  m_AutoUVMaxDistance: 0.5
  m_AutoUVMaxAngle: 89
  m_LightmapParameters: {fileID: 0}
  m_SortingLayerID: 0
  m_SortingLayer: 0
  m_SortingOrder: 0
  m_AdditionalVertexStreams: {fileID: 0}
`;

  fs.writeFileSync(sceneFilePath, content.trimEnd() + '\n' + cubeYaml.trim() + '\n', 'utf-8');
  console.log('[injectMaterialSource] Injected into: ' + sceneFilePath);
  return true;
}

/**
 * Inject __MaterialSource into all detected scene files
 */
function injectMaterialSourceAll(clientDir, scenes) {
  let count = 0;
  for (const scenePath of scenes) {
    const fullPath = path.join(clientDir, scenePath);
    if (injectMaterialSource(fullPath)) count++;
  }
  console.log('[injectMaterialSourceAll] Injected into ' + count + ' scene(s)');
  return count;
}

module.exports = { detectScenes, fixLunaJson, generateExportAssets, injectMaterialSource, injectMaterialSourceAll, MSBUILD_PATH };
