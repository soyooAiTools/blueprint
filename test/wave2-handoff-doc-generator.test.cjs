// Wave 2 / C2-C3 单元测试：
// 1) generateHandoffDocs 在缺数据时仍返回最小 fallback 文档
// 2) handoffMd 包含 7 个章节，含 GFM 文件清单 + 分镜代码对应表
// 3) storyboardMd 每个 shot 一段，引用 storyboard-images/<file>
// 4) imageFiles 拼接 src=DATA_DIR/images/<projectId>/<filename>，dst=storyboard-images/<filename>

const assert = require('assert');
const path = require('path');

const handoffGen = require('../lib/handoff-doc-generator.cjs');

// === Fixture: minimal but realistic project ===
const project = {
  id: 'demo-proj-1',
  name: '太空垃圾回收 Demo',
  storyboardFrames: [
    {
      id: 'f1',
      title: '收集太空垃圾',
      scene: '玩家在太空站附近捡垃圾',
      interaction: '点击 SpaceJunk 收集',
      camera: '跟随玩家',
      timing: '12s',
      ui: 'guideText: 点击垃圾',
      animation: '采集动画',
      imageUrl: '/data/images/demo-proj-1/frame_1.jpg',
    },
    {
      id: 'f2',
      title: '卖给回收站',
      scene: '玩家把碎片送到回收站',
      interaction: '点击 RecyclingStation',
      camera: '切到回收站特写',
      timing: '10-15s',
      ui: 'guideText: 卖掉换金币',
      animation: '兑换动画',
      imageUrl: '/data/images/demo-proj-1/frame_2.jpg',
    },
  ],
  phases: [
    {
      id: 'collectScrap',
      name: '收集太空垃圾',
      activate: ['Player', 'SpaceJunk'],
      endCondition: 'MetalShard >= 1',
      guide: '点击垃圾收集',
      camera: { lookAt: 'SpaceJunk', zoom: 5 },
    },
    {
      id: 'sellAtStation',
      name: '卖给回收站',
      activate: ['Player', 'RecyclingStation'],
      endCondition: 'gold >= 1',
      guide: '送到回收站',
      camera: { lookAt: 'RecyclingStation' },
    },
  ],
  entities: [
    { name: 'Player' },
    { name: 'SpaceJunk' },
    { name: 'RecyclingStation' },
  ],
};

// === T1: 缺数据 fallback ===
const empty = handoffGen.generateHandoffDocs(null);
assert.ok(/项目数据缺失/.test(empty.handoffMd), 'fallback handoffMd 应包含「项目数据缺失」');
assert.ok(/项目数据缺失/.test(empty.storyboardMd), 'fallback storyboardMd 应包含「项目数据缺失」');
assert.deepStrictEqual(empty.imageFiles, [], 'fallback imageFiles 应为空数组');

// === T2: 正常 project，handoffMd 7 章节齐全 ===
const docs = handoffGen.generateHandoffDocs(project, { dataDir: '/var/data' });

assert.ok(/^# 程序员交付说明 — 太空垃圾回收 Demo/m.test(docs.handoffMd), 'handoff 标题');
assert.ok(/## 1\. 这是什么/.test(docs.handoffMd), 'handoff §1');
assert.ok(/## 2\. 文件清单与阅读顺序/.test(docs.handoffMd), 'handoff §2');
assert.ok(/## 3\. 分镜与代码对应表/.test(docs.handoffMd), 'handoff §3');
assert.ok(/## 4\. 关键规则/.test(docs.handoffMd), 'handoff §4');
assert.ok(/## 5\. Luna staging 工具库索引/.test(docs.handoffMd), 'handoff §5');
assert.ok(/## 6\. 二期接入清单/.test(docs.handoffMd), 'handoff §6');
assert.ok(/## 6\.1 流程增删改指南/.test(docs.handoffMd), 'handoff §6.1 flow edit guide');
assert.ok(/## 7\. 反馈与迭代/.test(docs.handoffMd), 'handoff §7');

// 估算总时长（12 + 10 = 22s，带兜底）
assert.ok(/2 个分镜/.test(docs.handoffMd), '分镜数应正确');
assert.ok(/3 个游戏实体/.test(docs.handoffMd), '实体数应正确');

// 分镜对应表里要有两个 phase 入口
assert.ok(/Phase_collectScrap_Init/.test(docs.handoffMd), '应包含 Phase_collectScrap_Init 入口');
assert.ok(/Phase_sellAtStation_Init/.test(docs.handoffMd), '应包含 Phase_sellAtStation_Init 入口');

// 关键规则必须保留三条核心约束
assert.ok(/moveSpeed = 4/.test(docs.handoffMd), '玩家 moveSpeed 应为 4');
assert.ok(/10–15 秒/.test(docs.handoffMd), 'shot 时长规则应在文档里');
assert.ok(/约 3 秒/.test(docs.handoffMd), '镜头平滑过渡时长（3秒）应在文档里');
assert.ok(/FramePoint/.test(docs.handoffMd), '镜头规则应指向 FramePoint');
assert.ok(/offscreenEntities/.test(docs.handoffMd), '运行态出画检查应写入文档');
assert.ok(/Phase_<id>_Init.*Phase_<id>_OnTap.*Phase_<id>_OnAutoPlayArrive.*CheckEventRules/.test(docs.handoffMd), '阅读路径应说明每个 shot 的代码顺序');
assert.ok(/Luna/.test(docs.handoffMd), 'Luna 兼容章节应存在');
assert.ok(/Luna\/WebGL staging 层/.test(docs.handoffMd), 'handoff 应说明当前源码属于 staging 层');
assert.ok(/UnityComponent\(3\)/.test(docs.handoffMd), 'handoff 应指向最终 UnityComponent(3) 框架');
assert.ok(/GMP_SceneEntityRefs/.test(docs.handoffMd), 'handoff 应指向最终场景引用入口');
assert.doesNotMatch(docs.handoffMd, /GameSceneCtrl\.cs` 的实体绑定表里把 `__Pool_Cube_NN` 换成你的 prefab/, 'handoff 不应再把 GameSceneCtrl 当美术替换入口');
assert.ok(/修改流程/.test(docs.handoffMd), '流程指南应说明修改流程');
assert.ok(/删除流程/.test(docs.handoffMd), '流程指南应说明删除流程');
assert.ok(/增加流程/.test(docs.handoffMd), '流程指南应说明增加流程');
assert.ok(/例子/.test(docs.handoffMd), '流程指南应包含例子');

// GFM 索引必须包含核心 Manager 文件
assert.ok(/GameFlowManagerMain\.cs/.test(docs.handoffMd), 'GFM 索引：主流程文件');
assert.ok(/GFM_CameraController\.cs/.test(docs.handoffMd), 'GFM 索引：相机');
assert.ok(/GFM_Player\.cs/.test(docs.handoffMd), 'GFM 索引：玩家');
assert.ok(/GFM_EconomyManager\.cs/.test(docs.handoffMd), 'GFM 索引：经济');

// === T3: storyboardMd 每个 shot 一段，引用图 ===
assert.ok(/## Shot 1 — 收集太空垃圾/.test(docs.storyboardMd), 'Shot 1 标题');
assert.ok(/## Shot 2 — 卖给回收站/.test(docs.storyboardMd), 'Shot 2 标题');

// 代码入口提示三个方法
assert.ok(/Phase_collectScrap_Init/.test(docs.storyboardMd), '代码入口：Init');
assert.ok(/Phase_collectScrap_OnTap/.test(docs.storyboardMd), '代码入口：OnTap');
assert.ok(/Phase_collectScrap_OnAutoPlayArrive/.test(docs.storyboardMd), '代码入口：OnAutoPlayArrive');
assert.ok(/Phase_collectScrap_Init` → `Phase_collectScrap_OnTap` → `Phase_collectScrap_OnAutoPlayArrive` → `CheckEventRules/.test(docs.storyboardMd), 'storyboard 应包含代码阅读顺序');

// 图片引用走 storyboard-images/ 子目录
assert.ok(/!\[Shot 1\]\(storyboard-images\/frame_1\.jpg\)/.test(docs.storyboardMd), 'Shot 1 图片引用');
assert.ok(/!\[Shot 2\]\(storyboard-images\/frame_2\.jpg\)/.test(docs.storyboardMd), 'Shot 2 图片引用');

// 关键字段都要落地
assert.ok(/\*\*画面\*\*：玩家在太空站附近捡垃圾/.test(docs.storyboardMd), 'Shot 1 画面');
assert.ok(/\*\*操作\*\*：点击 SpaceJunk 收集/.test(docs.storyboardMd), 'Shot 1 操作');
assert.ok(/\*\*入画实体\*\*：Player, SpaceJunk/.test(docs.storyboardMd), 'Shot 1 入画');
assert.ok(/\*\*退出条件\*\*：`MetalShard >= 1`/.test(docs.storyboardMd), 'Shot 1 退出条件');

// === T4: imageFiles 路径拼接 ===
assert.strictEqual(docs.imageFiles.length, 2, 'imageFiles 应有 2 项');
assert.strictEqual(
  docs.imageFiles[0].src,
  path.join('/var/data', 'images', 'demo-proj-1', 'frame_1.jpg'),
  'src 路径应拼接 dataDir + projectId + 文件名'
);
assert.strictEqual(
  docs.imageFiles[0].dstRel,
  path.join('storyboard-images', 'frame_1.jpg'),
  'dstRel 应为 storyboard-images/<filename>'
);

// === T5: 没有 dataDir 时 imageFiles 为空（防止误用） ===
const docsNoDir = handoffGen.generateHandoffDocs(project);
assert.deepStrictEqual(docsNoDir.imageFiles, [], '没有 dataDir 选项时 imageFiles 应为空');

// === T6: phase / frame 数量不一致时按 max 对齐 ===
const projAsymm = {
  id: 'p2',
  name: '不对齐',
  storyboardFrames: [{ id: 'a', title: 'A', imageUrl: 'a.jpg' }],
  phases: [
    { id: 'phaseA', name: 'A 阶段', activate: ['Player'] },
    { id: 'phaseB', name: 'B 阶段', activate: ['Player'] },
  ],
  entities: [{ name: 'Player' }],
};
const docsAsymm = handoffGen.generateHandoffDocs(projAsymm, { dataDir: '/d' });
assert.ok(/2 个分镜/.test(docsAsymm.handoffMd), '不对齐时按 max(frames, phases) 对齐');
assert.ok(/Phase_phaseB_Init/.test(docsAsymm.handoffMd), '第二个 phase 也要进对应表');

// === T7: GFM_FILE_GUIDE 数据完整性（白名单防回归） ===
const guide = handoffGen._internal.GFM_FILE_GUIDE;
assert.ok(guide.length >= 20, 'GFM 文件清单条目数应 ≥ 20（防有人不小心删了）');
guide.forEach(function(g) {
  assert.ok(g.file && g.role && g.edit, 'GFM_FILE_GUIDE 每条都应有 file/role/edit');
  assert.ok(/\.cs$/.test(g.file), 'GFM_FILE_GUIDE 文件名应以 .cs 结尾');
});

console.log('Wave 2 handoff doc generator: all assertions passed.');
