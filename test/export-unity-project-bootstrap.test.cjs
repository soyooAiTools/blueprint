#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const scriptPath = path.join(repoRoot, 'scripts', 'export-unity-project.sh');
const src = fs.readFileSync(scriptPath, 'utf8');

assert(
  src.includes('GameFlowBootstrap.cs'),
  'non-programmer Unity export must keep a bootstrap script for direct Editor Play'
);
assert(
  src.includes('RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)'),
  'bootstrap must run after the exported scene loads'
);
assert(
  src.includes('go.AddComponent<GameFlowManagerMain>()'),
  'non-programmer export bootstrap must attach GameFlowManagerMain when the scene has no manager object'
);
assert(
  !src.includes('go.AddComponent<MainManager>()'),
  'programmer delivery export must not create MainManager through runtime bootstrap'
);
assert(
  src.includes('SCRIPT_DIR="$WORK/Assets/Scripts"'),
  'programmer delivery export should use reference-project style Assets/Scripts layout'
);
assert(
  src.includes('MANAGER_DIR="$SCRIPT_DIR"'),
  'programmer delivery export should put flow entry scripts directly under Assets/Scripts like the reference majority'
);
assert(
  src.includes('COMMON_DIR="$SCRIPT_DIR/Common"') && src.includes('delivery_script_dir()') && src.includes('$SCRIPT_DIR/Manager') && src.includes('$SCRIPT_DIR/Player') && src.includes('$SCRIPT_DIR/Audio') && src.includes('$SCRIPT_DIR/UI'),
  'programmer delivery export should classify helper scripts into Manager/Player/Audio/UI/Common folders'
);
assert(
  src.includes('rm -rf "$WORK/Assets/Program"'),
  'programmer delivery export should remove stale Luna Program scripts from the programmer package'
);
assert(
  src.includes('$BP_ROOT"/worker/*.cs') && src.includes('GFM_Luna.cs|GFM_Event.cs|GFM_Tools.cs'),
  'programmer delivery export should copy canonical split GFM helper scripts and skip Luna/event/monolithic files'
);
assert(
  src.includes('PLAYWORKS_PACKAGE_PATH') && src.includes('/opt/blueprint-editor/7.1.0/scripts'),
  'export should normalize the Windows Playworks file dependency before Unity open validation'
);
assert(
  src.includes('if [ "$PROGRAMMER_DELIVERY" -eq 1 ]; then') && src.includes('STRIP_LUNA=1'),
  'programmer delivery export should strip Luna package dependencies by default'
);
assert(
  src.includes('$WORK/Assets/__LunaMaterials') && src.includes('$WORK/Assets/Program') && src.includes('$WORK/Assets/Editor') && src.includes('$WORK/luna.json'),
  'programmer delivery export should remove Luna-only template artifacts'
);
assert(
  src.includes('Assets/Scenes/Game.unity'),
  'programmer delivery export should rewrite the default scene path to Assets/Scenes/Game.unity'
);
assert(
  src.includes('不再依赖运行时创建脚本物体'),
  'export README should document scene-mounted script object behavior'
);
assert(
  src.includes('PROGRAMMER_DELIVERY_SUMMARY.json') && src.includes('programmer-delivery-hardgate.cjs') && src.includes('DELIVERY_VALIDATION.json'),
  'programmer delivery export should write cleaner summary and run delivery hardgate before packaging'
);
assert(
  src.includes('playable-flow-manifest.cjs') && src.includes('record-export') && src.includes('playable-flow-manifest.json'),
  'programmer delivery export should record delivery validation in playable-flow-manifest.json'
);

const syntax = spawnSync('bash', ['-n', scriptPath], { cwd: repoRoot, encoding: 'utf8' });
assert.strictEqual(syntax.status, 0, syntax.stderr || syntax.stdout);

console.log('export unity project bootstrap guards passed');
