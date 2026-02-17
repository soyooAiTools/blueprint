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

module.exports = { detectScenes, fixLunaJson, generateExportAssets, MSBUILD_PATH };
