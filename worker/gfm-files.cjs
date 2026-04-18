// gfm-files.cjs — GFM toolkit file registry (split from monolithic GFM_Tools.cs)
const fs = require('fs');
const path = require('path');

const GFM_DIR = __dirname;
const GFM_DEST_SUBDIR = 'Commons';
const GFM_FILES = [
  'GFM_Audio.cs',
  'GFM_Pool.cs',
  'GFM_Event.cs',
  'GFM_Utils.cs',
  'GFM_Joystick.cs',
  'GFM_Luna.cs',
  'GFM_UI.cs',
  'GFM_Create.cs',
  'GFM_Grid.cs',
  'GFM_Pathfinding.cs',
  'GFM_Billboard.cs',
  'ScriptActivator.cs',
  'GameSceneCtrl.cs',
];

function loadGfmFiles() {
  var map = {};
  for (var i = 0; i < GFM_FILES.length; i++) {
    var f = GFM_FILES[i];
    var p = path.join(GFM_DIR, f);
    if (fs.existsSync(p)) map[f] = fs.readFileSync(p, 'utf-8');
  }
  return map;
}

function copyGfmToProject(destDir) {
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  var copied = [];
  for (var i = 0; i < GFM_FILES.length; i++) {
    var f = GFM_FILES[i];
    var src = path.join(GFM_DIR, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(destDir, f));
      copied.push(f);
    }
  }
  return copied;
}

function isGfmFile(name) {
  return GFM_FILES.indexOf(name) >= 0;
}

function removeOldGfmTools(destDir) {
  var old = path.join(destDir, 'GFM_Tools.cs');
  if (fs.existsSync(old)) { fs.unlinkSync(old); return true; }
  return false;
}

function copyGfmToProjectDir(projectRoot) {
  var dest = path.join(projectRoot, 'Assets', 'Program', 'Script', GFM_DEST_SUBDIR);
  return copyGfmToProject(dest);
}

function cleanupLegacyGfm(projectRoot) {
  var managerDir = path.join(projectRoot, 'Assets', 'Program', 'Script', 'Manager');
  removeOldGfmTools(managerDir);
  for (var i = 0; i < GFM_FILES.length; i++) {
    var old = path.join(managerDir, GFM_FILES[i]);
    try { if (fs.existsSync(old)) fs.unlinkSync(old); } catch(e) {}
  }
  removeOldGfmTools(path.join(projectRoot, 'Assets', 'Program', 'Script'));
}

module.exports = { GFM_FILES, GFM_DEST_SUBDIR, loadGfmFiles, copyGfmToProject, copyGfmToProjectDir, isGfmFile, removeOldGfmTools, cleanupLegacyGfm };
