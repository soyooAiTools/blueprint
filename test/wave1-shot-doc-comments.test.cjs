// Wave 1 / C1+C5 单元测试：
// 1) generateSkeleton 在每个 Phase_*_Init 前注入 Shot 注释块（标题/时长/操作/入画/退出条件）
// 2) Phase_*_OnTap / Phase_*_OnAutoPlayArrive 前有交叉引用一行
// 3) programmer-delivery-cleaner 不会把这些注释 drop 掉

const assert = require('assert');

const { generateSkeleton } = require('../adapters/skeleton-generator.cjs');
const cleaner = require('../lib/programmer-delivery-cleaner.cjs');

const specs = [
  {
    phaseId: 'collectScrap',
    phaseName: '收集太空垃圾',
    entitiesRequired: [{ name: 'Player' }, { name: 'SpaceJunk' }],
    requiredInteractions: ['tap:SpaceJunk'],
    triggerNext: { condition: 'MetalShard >= 1' },
    duration: { min: 10, max: 12 },
    playerMustAct: true,
  },
  {
    phaseId: 'sellAtStation',
    phaseName: '卖给回收站',
    entitiesRequired: [{ name: 'Player' }, { name: 'RecyclingStation' }],
    requiredInteractions: ['tap:RecyclingStation', 'spend:MetalShard'],
    triggerNext: { condition: 'gold >= 1' },
    duration: { min: 10, max: 15 },
    playerMustAct: true,
  },
];

const out = generateSkeleton(specs, {
  entityPoolMap: {
    Player: '__Pool_Cube_01',
    SpaceJunk: '__Pool_Sphere_01',
    RecyclingStation: '__Pool_Cube_02',
  },
  entities: [{ name: 'Player' }, { name: 'SpaceJunk' }, { name: 'RecyclingStation' }],
});

const flow = out.flow || '';

// === C1.1: Phase_collectScrap_Init 前必须有完整 Shot 注释块 ===
const initBlock = flow.match(
  /\/\/ ─{5,}[\s\S]*?Shot 1[\s\S]*?Phase_collectScrap_Init/
);
assert.ok(initBlock, 'Phase_collectScrap_Init 之前缺少 Shot 注释块');
const block1 = initBlock[0];
assert.ok(/Shot 1 \/ Phase: collectScrap/.test(block1), 'Shot 头缺失');
assert.ok(/标题: 收集太空垃圾/.test(block1), '标题字段缺失');
assert.ok(/时长: 10-12s/.test(block1), '时长字段缺失');
assert.ok(/操作: tap:SpaceJunk/.test(block1), '操作字段缺失');
assert.ok(/入画物体: Player, SpaceJunk/.test(block1), '入画字段缺失');
assert.ok(/退出条件: MetalShard >= 1/.test(block1), '退出条件字段缺失');

// === C1.2: 第二个 phase 也要有完整注释块 ===
const initBlock2 = flow.match(
  /Shot 2[\s\S]*?标题: 卖给回收站[\s\S]*?Phase_sellAtStation_Init/
);
assert.ok(initBlock2, 'Phase_sellAtStation_Init 之前缺少 Shot 注释块');
assert.ok(/操作: tap:RecyclingStation \/ spend:MetalShard/.test(initBlock2[0]), '多个 interactions 应用 / 连接');

// === C1.3: OnTap / OnAutoPlayArrive 上方应有交叉引用注释 ===
const tapRef = flow.match(
  /\/\/ Shot 1 \/ Phase: collectScrap — 详见上方 Phase_collectScrap_Init 分镜注释。\s*\n\s*\/\/ \[SKELETON\] Phase "collectScrap" 点击 handler/
);
assert.ok(tapRef, 'Phase_collectScrap_OnTap 缺少 Shot 交叉引用');

const autoRef = flow.match(
  /\/\/ Shot 1 \/ Phase: collectScrap — 详见上方 Phase_collectScrap_Init 分镜注释。\s*\n\s*\/\/ \[SKELETON\] Phase "collectScrap" autoPlay handler/
);
assert.ok(autoRef, 'Phase_collectScrap_OnAutoPlayArrive 缺少 Shot 交叉引用');

// === C5: programmer-delivery-cleaner 不能把这些注释 drop 掉 ===
const sample = [
  'public partial class GameFlowManagerMain',
  '{',
  '    // ─────────────────────────────────────────────────────────',
  '    // Shot 1 / Phase: collectScrap',
  '    // 标题: 收集太空垃圾',
  '    // 时长: 10-12s',
  '    // 操作: tap:SpaceJunk',
  '    // 入画物体: Player, SpaceJunk',
  '    // 退出条件: MetalShard >= 1',
  '    // ─────────────────────────────────────────────────────────',
  '    // TODO_PHASE_1_INIT_START',  // 这条仍要被 drop
  '    void Phase_collectScrap_Init() {}',
  '    // TODO_PHASE_1_INIT_END',     // 这条仍要被 drop
  '}',
].join('\n');

const cleaned = cleaner.cleanCSharpForProgrammerDelivery(sample);
// Shot 注释块全部应保留
assert.ok(/Shot 1 \/ Phase: collectScrap/.test(cleaned.code), 'Shot 头被误删');
assert.ok(/标题: 收集太空垃圾/.test(cleaned.code), '标题被误删');
assert.ok(/时长: 10-12s/.test(cleaned.code), '时长被误删');
assert.ok(/操作: tap:SpaceJunk/.test(cleaned.code), '操作被误删');
assert.ok(/入画物体: Player, SpaceJunk/.test(cleaned.code), '入画被误删');
assert.ok(/退出条件: MetalShard >= 1/.test(cleaned.code), '退出条件被误删');
assert.ok(/─────/.test(cleaned.code), '分隔符被误删');
// TODO_PHASE_*_INIT_START/END 仍应被 drop
assert.doesNotMatch(cleaned.code, /TODO_PHASE_1_INIT_START/, 'TODO_PHASE_*_INIT_START 应继续被 drop');
assert.doesNotMatch(cleaned.code, /TODO_PHASE_1_INIT_END/, 'TODO_PHASE_*_INIT_END 应继续被 drop');

console.log('Wave 1 shot doc comments: all assertions passed.');
