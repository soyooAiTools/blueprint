// gfm-files.cjs — GFM toolkit file registry (split from monolithic GFM_Tools.cs)
const fs = require('fs');
const path = require('path');

const GFM_DIR = __dirname;
const GFM_DEST_SUBDIR = 'Commons';
const GFM_FILES = [
  // 单例基类 (反馈 01 #1 架构图：所有 Manager 走统一懒加载)
  'GFM_SingletonBase.cs',
  // 基础工具层 (static class / 无状态)
  'GFM_Audio.cs',
  'GFM_Pool.cs',
  // Manager 命名 alias (反馈 01 #8 架构图：图中叫 PoolManager / AudioManager,
  // 这里转发到 GFM_Pool / GFM_Audio,新生成代码优先用这两个名字)
  'PoolManager.cs',
  'AudioManager.cs',
  'GFM_Event.cs',
  'GFM_Utils.cs',
  'GFM_Joystick.cs',
  'GFM_Luna.cs',
  'GFM_UI.cs',
  'GFM_Create.cs',
  'GFM_Grid.cs',
  'GFM_Pathfinding.cs',
  'GFM_Billboard.cs',
  'GFM_ResourceIds.cs',
  'GFM_VisualGuide.cs',      // 玩家锚点 + 当前目标高亮 (L1 可读性)
  // Manager 架构层 (MonoBehaviour 单例 / 有状态)
  'GFM_EconomyManager.cs',   // 资源/金币/兑换
  'GFM_UIManager.cs',        // Canvas/guide/score/floatingText
  'GFM_TipsManager.cs',      // 即时提示 toast (反馈 01 #1 架构图)
  'GFM_CameraController.cs', // 相机缓存 + 正交视角
  'GFM_Player.cs',           // 玩家载具 + 形态系统 + 采集/递送
  'GFM_AutoPlay.cs',         // CUA 自动播放控制器
  'GFM_NpcManager.cs',       // NPC 管理器 (占位)
  'GFM_ItemManager.cs',      // 物品管理器 (占位)
  // 场景初始化层
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
