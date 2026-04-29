// Wave 2 / C2-C4：程序员交付包文档自动生成
//
// 输入：project（含 storyboardFrames / phases / entities / globalSettings）
// 输出：{ handoffMd, storyboardMd, imageFiles: [{src, dst}] }
//
// 设计原则：
//   - 纯函数，不做磁盘 IO；调用方负责写文件
//   - 全部中文（用户偏好）
//   - 没有 storyboardFrames 时仍能产出最小可用文档
//   - imageFiles 用相对路径列出 storyboard 截图，调用方按 src→dst 拷贝

'use strict';

var path = require('path');

// ────────────────────────────────────────────────────────────
// 已知 GFM_* / GameFlowManagerMain* 文件清单 + 程序员视角的职责说明
// 改这里时同步 worker/gfm-files.cjs
// ────────────────────────────────────────────────────────────
var GFM_FILE_GUIDE = [
  { file: 'GameFlowManagerMain.cs',         role: '主流程 + Phase 状态机 + 玩家交互入口',           edit: '重点阅读，搜 `Phase_<id>_Init` 找分镜对应代码' },
  { file: 'GameFlowManagerMain.Systems.cs', role: 'NPC AI / 系统级 Update（partial 类）',            edit: '调 NPC 行为时改这里' },
  { file: 'GameSceneCtrl.cs',               role: '实体注册表 + Pool 物体绑定',                       edit: '替换美术资产时把池物体名映射到实模型' },
  { file: 'GFM_CameraController.cs',        role: '主相机缓存 + 正交等距视角 + LookAt',              edit: '镜头规则在这里，shot 切换走 LookAt() / orthographicSize' },
  { file: 'GFM_Player.cs',                  role: '玩家载具 + 形态系统 + 采集/递送',                  edit: '调玩家移动速度（moveSpeed=4）/ 操控方式来这' },
  { file: 'GFM_EconomyManager.cs',          role: '金币 / 资源库存 / 兑换规则',                       edit: '调资源数值在这' },
  { file: 'GFM_UIManager.cs',               role: 'Canvas / guideText / scoreText / FloatingText',    edit: '改 UI 排版或加新 UI 元素来这' },
  { file: 'GFM_UI.cs',                      role: 'UI 创建/查找的低层 helper（static）',              edit: '一般不动' },
  { file: 'GFM_AutoPlay.cs',                role: 'CUA 自动播放控制器（不影响真人玩家）',             edit: '不要改，CUA 验证依赖' },
  { file: 'GFM_Pool.cs',                    role: '通用对象池 + 自动归还计时器（static）',           edit: '一般不动' },
  { file: 'GFM_Create.cs',                  role: '基本几何体快捷创建（Cube/Sphere/...）',           edit: '替换为美术资产后这里调用次数会下降' },
  { file: 'GFM_NpcManager.cs',              role: 'NPC 注册和回收',                                   edit: '加新 NPC 类型时来这' },
  { file: 'GFM_Pathfinding.cs',             role: '简易寻路（Luna 不支持 NavMesh）',                  edit: '一般不动' },
  { file: 'GFM_Joystick.cs',                role: '虚拟摇杆 UI + 输入',                               edit: '改摇杆样式/灵敏度来这' },
  { file: 'GFM_Grid.cs',                    role: '网格摆放工具（建造类游戏用）',                     edit: '一般不动' },
  { file: 'GFM_Audio.cs',                   role: '音效播放（static）',                               edit: '替换音效资源时改这' },
  { file: 'GFM_Billboard.cs',               role: '世界空间标签（实体上方文字）',                     edit: '一般不动' },
  { file: 'GFM_Event.cs',                   role: 'legacy 事件系统（生成代码不应再用）',              edit: '不要调用' },
  { file: 'GFM_Utils.cs',                   role: '通用工具函数',                                     edit: '一般不动' },
  { file: 'GFM_Luna.cs',                    role: 'Luna 平台适配（CTA/install）',                     edit: '不要动，渠道集成依赖' },
  { file: 'GFM_ItemManager.cs',             role: '道具管理（占位/扩展点）',                           edit: '通常不用' },
  { file: 'GFM_TipsManager.cs',             role: '即时提示 toast',                                    edit: '改提示样式来这' },
  { file: 'GFM_SingletonBase.cs',           role: '所有 Manager 的单例基类',                           edit: '不要动' },
  { file: 'GFM_ResourceIds.cs',             role: '资源 ID 常量（编译期生成）',                       edit: '不要手改，由 codegen 维护' },
  { file: 'ScriptActivator.cs',             role: 'Bridge.NET 启动入口（Luna 用）',                   edit: '不要动' },
];

function escapeMd(text) {
  return String(text == null ? '' : text)
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');
}

function pickShots(project) {
  var frames = project && project.storyboardFrames ? project.storyboardFrames : [];
  var phases = project && project.phases ? project.phases : [];
  // 用 frame.id 与 phase.id 作为对齐键；不存在时按位置补齐。
  var maxLen = Math.max(frames.length, phases.length);
  var shots = [];
  for (var i = 0; i < maxLen; i++) {
    var frame = frames[i] || {};
    var phase = phases[i] || {};
    shots.push({
      index: i + 1,
      frameId: frame.id != null ? frame.id : (i + 1),
      phaseId: phase.id != null ? phase.id : null,
      title: frame.title || phase.name || ('Shot ' + (i + 1)),
      scene: frame.scene || '',
      interaction: frame.interaction || phase.guide || '',
      camera: frame.camera || (phase.camera && phase.camera.lookAt ? '镜头看向 ' + phase.camera.lookAt : ''),
      timing: frame.timing || '',
      ui: frame.ui || '',
      animation: frame.animation || '',
      activate: phase.activate || [],
      endCondition: phase.endCondition || '',
      guide: phase.guide || '',
      imageUrl: frame.imageUrl || '',
    });
  }
  return shots;
}

function buildHandoffMd(project, shots) {
  var name = project && project.name ? project.name : (project && project.id ? project.id : 'Unknown');
  var pid = project && project.id ? project.id : '';
  var totalShots = shots.length;
  var entityCount = project && project.entities ? project.entities.length : 0;
  // 总时长估算：取每个 shot 的 timing 解析出秒数累加，没解析到的按 12s 兜底
  var totalSec = 0;
  shots.forEach(function(s) {
    var match = String(s.timing || '').match(/(\d+(?:\.\d+)?)/);
    var sec = match ? Number(match[1]) : 12;
    if (!isFinite(sec)) sec = 12;
    totalSec += sec;
  });

  var lines = [];
  lines.push('# 程序员交付说明 — ' + name);
  lines.push('');
  lines.push('> 项目 ID：`' + pid + '`  ');
  lines.push('> 自动生成于：' + new Date().toISOString());
  lines.push('');
  lines.push('## 1. 这是什么');
  lines.push('');
  lines.push('一个试玩广告 Demo 工程，包含 **' + totalShots + ' 个分镜（shot/phase）**，预计总时长约 **' + Math.round(totalSec) + ' 秒**，涉及 **' + entityCount + ' 个游戏实体**。');
  lines.push('');
  lines.push('当前画面用基本几何体（Cube/Sphere/Cylinder）+ 预染色 `__Pool_*` 物体表达，**不是最终美术**。每个色块对应一个游戏实体，二期接美术时把池物体替换为模型即可。');
  lines.push('');
  lines.push('## 2. 文件清单与阅读顺序');
  lines.push('');
  lines.push('| 序号 | 文件 | 看什么 |');
  lines.push('|---|---|---|');
  lines.push('| 1 | HANDOFF_README.md | 本文，从这里开始 |');
  lines.push('| 2 | STORYBOARD.md | ' + totalShots + ' 个分镜的画面 + 操作 + 退出条件 |');
  lines.push('| 3 | storyboard-images/ | 分镜线稿/参考图（按 frame ID 命名） |');
  lines.push('| 4 | GameFlowManagerMain.cs | 主流程，搜 `// Shot N` 跳转分镜 |');
  lines.push('| 5 | GameFlowManagerMain.Systems.cs | NPC AI 与系统 Update（partial） |');
  lines.push('| 6 | GameSceneCtrl.cs | 实体注册表 → 替换美术资产时改这 |');
  lines.push('| 其余 | GFM_*.cs | 工具/Manager 库，详见 §5 |');
  lines.push('');
  lines.push('## 3. 分镜与代码对应表');
  lines.push('');
  lines.push('| Shot | 标题 | 操作 | 退出条件 | 代码入口 |');
  lines.push('|---|---|---|---|---|');
  shots.forEach(function(s) {
    var phaseId = s.phaseId || '';
    var entry = phaseId ? ('GameFlowManagerMain.cs `Phase_' + phaseId + '_Init`') : '—';
    lines.push('| ' + s.index + ' | ' + escapeMd(s.title) + ' | ' + escapeMd(s.interaction || '(自动播放)') + ' | ' + escapeMd(s.endCondition || '(自动)') + ' | ' + entry + ' |');
  });
  lines.push('');
  lines.push('## 4. 关键规则（必读）');
  lines.push('');
  lines.push('### 4.1 镜头');
  lines.push('- 主相机由 `GFM_CameraController` 单例管理，**禁止直接 `Camera.main.transform.position = ...`**');
  lines.push('- 每个 shot 切换镜头走 `GFM_CameraController.Instance.LookAt(target)` + `mainCam.orthographicSize`');
  lines.push('- 镜头平滑过渡时长（Wave 3 后启用）：约 3 秒');
  lines.push('- 入画保证：每个 shot 的 `phase.activate` 列出的实体都应在画面内');
  lines.push('');
  lines.push('### 4.2 物体移动');
  lines.push('- 玩家匀速移动：`moveSpeed * Time.deltaTime`，默认 `moveSpeed = 4`');
  lines.push('- **禁止** 在 Update 中给玩家/关键单位 `transform.position = X` 赋值瞬移');
  lines.push('- 隐藏物体：`HideObj(obj)`（移到 (0,-999,0)），不要 `Destroy()`');
  lines.push('');
  lines.push('### 4.3 Shot 时长');
  lines.push('- 每 shot 强制 10–15 秒（autoPlay 12s 硬下限），目的是让玩家看清楚');
  lines.push('- 不要把多个动作压缩在同一 shot 里，宁可拆成两个');
  lines.push('');
  lines.push('### 4.4 Luna 兼容');
  lines.push('- 不支持：泛型、coroutine、C# 7.0+ 语法糖、LINQ、JsonUtility、NavMesh、新 InputSystem、`System.Math`');
  lines.push('- 用 `Mathf` 不用 `System.Math`；用 `Newtonsoft.Json` 不用 `JsonUtility`；用 legacy `Input` 不用 `InputSystem`');
  lines.push('');
  lines.push('## 5. GFM 工具库索引');
  lines.push('');
  lines.push('| 文件 | 职责 | 修改建议 |');
  lines.push('|---|---|---|');
  GFM_FILE_GUIDE.forEach(function(g) {
    lines.push('| `' + g.file + '` | ' + escapeMd(g.role) + ' | ' + escapeMd(g.edit) + ' |');
  });
  lines.push('');
  lines.push('## 6. 二期接入清单');
  lines.push('');
  lines.push('1. **替换美术资产**：在 `GameSceneCtrl.cs` 的实体绑定表里把 `__Pool_Cube_NN` 换成你的 prefab');
  lines.push('2. **接入音效**：在 `GFM_Audio.cs` 注册音频资源，关键 phase 切换处调 `GFM_Audio.Play("xxx")`');
  lines.push('3. **优化镜头**：检查每个 shot 的 `phase.camera.lookAt` 是否指向当前主体物，必要时新增 `phase.camera.zoom`');
  lines.push('4. **CTA 接入**：最后一个 shot 已经调 `Luna.Unity.Playable.InstallFullGame()`，渠道侧只需提供安装链接');
  lines.push('');
  lines.push('## 7. 反馈与迭代');
  lines.push('');
  lines.push('- 提交问题：通过 Blueprint Editor 前端的"反馈"按钮，会自动重跑流水线');
  lines.push('- 紧急修改：直接改本目录的 C# 源码，但每次自动重跑会覆盖（自动覆盖前会备份到 `.bak`）');
  lines.push('');
  return lines.join('\n');
}

function buildStoryboardMd(project, shots) {
  var name = project && project.name ? project.name : (project && project.id ? project.id : 'Unknown');
  var lines = [];
  lines.push('# 分镜板 — ' + name);
  lines.push('');
  lines.push('> 共 ' + shots.length + ' 个分镜。每个分镜对应 GameFlowManagerMain.cs 中一个 `Phase_<id>_Init` 方法。');
  lines.push('');

  shots.forEach(function(s) {
    lines.push('## Shot ' + s.index + (s.title ? ' — ' + s.title : ''));
    lines.push('');
    if (s.phaseId) {
      lines.push('**代码入口**：`Phase_' + s.phaseId + '_Init` / `Phase_' + s.phaseId + '_OnTap` / `Phase_' + s.phaseId + '_OnAutoPlayArrive`');
      lines.push('');
    }
    if (s.imageUrl) {
      // 图片在 SVN 中位于同级 storyboard-images/ 子目录下
      var imgName = path.basename(s.imageUrl);
      lines.push('![Shot ' + s.index + '](storyboard-images/' + imgName + ')');
      lines.push('');
    }
    if (s.scene) { lines.push('**画面**：' + s.scene); lines.push(''); }
    if (s.interaction) { lines.push('**操作**：' + s.interaction); lines.push(''); }
    if (s.guide) { lines.push('**引导文案**：' + s.guide); lines.push(''); }
    if (s.camera) { lines.push('**镜头**：' + s.camera); lines.push(''); }
    if (s.timing) { lines.push('**时长**：' + s.timing); lines.push(''); }
    if (s.ui) { lines.push('**UI**：' + s.ui); lines.push(''); }
    if (s.animation) { lines.push('**动画**：' + s.animation); lines.push(''); }
    if (s.activate && s.activate.length) {
      lines.push('**入画实体**：' + s.activate.join(', '));
      lines.push('');
    }
    if (s.endCondition) { lines.push('**退出条件**：`' + s.endCondition + '`'); lines.push(''); }
    lines.push('---');
    lines.push('');
  });
  return lines.join('\n');
}

function pickImageFiles(project, opts) {
  // 把 storyboardFrames[i].imageUrl 映射到 src（DATA_DIR/images/<projectId>/<filename>）
  // 与 dst（SVN/Scripts/storyboard-images/<filename>）
  var dataDir = opts && opts.dataDir;
  var projectId = project && project.id;
  if (!dataDir || !projectId) return [];
  var frames = project && project.storyboardFrames ? project.storyboardFrames : [];
  var out = [];
  frames.forEach(function(f) {
    if (!f || !f.imageUrl) return;
    var fname = path.basename(String(f.imageUrl));
    out.push({
      src: path.join(dataDir, 'images', projectId, fname),
      dstRel: path.join('storyboard-images', fname),
    });
  });
  return out;
}

function generateHandoffDocs(project, opts) {
  if (!project) {
    return {
      handoffMd: '# 程序员交付说明\n\n> 项目数据缺失，无法生成详细说明。\n',
      storyboardMd: '# 分镜板\n\n> 项目数据缺失。\n',
      imageFiles: [],
    };
  }
  var shots = pickShots(project);
  return {
    handoffMd: buildHandoffMd(project, shots),
    storyboardMd: buildStoryboardMd(project, shots),
    imageFiles: pickImageFiles(project, opts || {}),
  };
}

module.exports = {
  generateHandoffDocs: generateHandoffDocs,
  // 暴露内部函数供测试用
  _internal: {
    pickShots: pickShots,
    buildHandoffMd: buildHandoffMd,
    buildStoryboardMd: buildStoryboardMd,
    pickImageFiles: pickImageFiles,
    GFM_FILE_GUIDE: GFM_FILE_GUIDE,
  },
};
