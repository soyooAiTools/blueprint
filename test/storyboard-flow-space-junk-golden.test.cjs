#!/usr/bin/env node
'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

var {
  buildSourceSceneIrFromStoryboardFlow,
  preflightStoryboardFlow,
} = require('../engine/storyboard-flow-source-ir.cjs');
var {
  buildSourceIrPreviewHtml,
} = require('../engine/source-ir-preview-renderer.cjs');
var {
  preflightSourceSceneIrHtml,
} = require('../engine/source-scene-ir.cjs');
var {
  analyzeSourceIrPhaseLiveness,
} = require('../engine/source-ir-phase-liveness.cjs');

var flowPath = path.join(__dirname, '..', 'fixtures', 'storyboard-flow-space-junk-golden.json');
var flow = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard-flow-space-junk-'));
var htmlPath = path.join(tmp, 'source-ir-preview.html');

var authoringReport = preflightStoryboardFlow(flow, {
  generatedAt: '2026-06-12T00:00:00.000Z',
});
assert.strictEqual(authoringReport.passed, true, JSON.stringify(authoringReport.issues, null, 2));
assert.strictEqual(authoringReport.resourceSnapshots.length, 12);
assert.deepStrictEqual(authoringReport.resourceSnapshots[0].after, { Cash: 5, MetalScrap: 0 });
assert.deepStrictEqual(authoringReport.resourceSnapshots[1].after, { Cash: 0, MetalScrap: 0 });
assert.deepStrictEqual(authoringReport.resourceSnapshots[9].after, { Cash: 10, MetalScrap: 0 });
assert.ok(!authoringReport.issues.some(function(issue) {
  return issue.severity === 'blocker';
}));

var sourceIr = buildSourceSceneIrFromStoryboardFlow(flow, {
  sourceHtmlPath: htmlPath,
  generatedAt: '2026-06-12T00:00:00.000Z',
});
assert.strictEqual(sourceIr.project.theme, 'space');
assert.strictEqual(sourceIr.phases.length, 12);
assert.ok(sourceIr.resources.some(function(resource) {
  return resource.id === 'MetalScrap' && resource.label === '金属碎片' && resource.carrierEntity === 'ScrapPile';
}));
assert.ok(sourceIr.resources.some(function(resource) {
  return resource.id === 'Cash' && resource.label === '美金' && resource.carrierEntity === 'CashCounter';
}));
assert.ok(sourceIr.phases[0].steps.some(function(step) {
  return step.kind === 'collect' && step.resource === 'MetalScrap' && step.from === 'ScrapPile';
}));
assert.ok(sourceIr.phases[0].steps.some(function(step) {
  return step.kind === 'deliver' && step.resource === 'MetalScrap' && step.target === 'RecycleStation';
}));
assert.ok(sourceIr.phases[0].steps.some(function(step) {
  return step.kind === 'reward' && step.resource === 'Cash' && step.amount === 5;
}));
assert.ok(sourceIr.phases[1].steps.some(function(step) {
  return step.kind === 'transfer' && step.resource === 'Cash' && step.target === 'ForgeRoom' && step.amount === 5;
}));
assert.ok(sourceIr.phases[1].steps.some(function(step) {
  return step.kind === 'build' && step.entity === 'ForgeRoom';
}));
assert.deepStrictEqual(sourceIr.phases[3].gate, { kind: 'entity_state', entity: 'AsteroidObstacle', state: 0 });
assert.ok(sourceIr.phases[9].steps.some(function(step) {
  return step.kind === 'unlock' && step.entity === 'CabinModule';
}));
assert.deepStrictEqual(sourceIr.phases[11].gate, { kind: 'cta_arrival', ctaId: 'CtaButton', radius: 2 });

var queueFlow = JSON.parse(JSON.stringify(flow));
queueFlow.entities.push({ id: 'CustomerQueue', label: '排队顾客', kind: 'npc_group' });
queueFlow.phases[0].visibleEntities.push('CustomerQueue');
queueFlow.phases[0].visualNotes = '回收站门口有 5 名顾客排队等待。';
var queueIr = buildSourceSceneIrFromStoryboardFlow(queueFlow, {
  sourceHtmlPath: path.join(tmp, 'queue-source-ir-preview.html'),
  generatedAt: '2026-06-12T00:00:00.000Z',
});
var queueEntity = queueIr.entities.filter(function(entity) { return entity.id === 'CustomerQueue'; })[0];
assert.ok(queueEntity, 'CustomerQueue entity should exist');
assert.strictEqual(queueEntity.visual.groupCount, 5);
assert.strictEqual(queueEntity.visual.queueSpacing >= 0.8, true);
assert.strictEqual(queueEntity.visual.primitive, 'cylinder');
var archetypeFlow = JSON.parse(JSON.stringify(flow));
archetypeFlow.entities.push({ id: 'DonutOven', label: '甜甜圈烤箱', kind: 'producer' });
archetypeFlow.entities.push({ id: 'Donut', label: '甜甜圈', kind: 'resource' });
archetypeFlow.entities.push({ id: 'GrilledShrimp', label: '烤大虾', kind: 'resource' });
archetypeFlow.entities.push({ id: 'PlayerSpeed', label: '主厨速度', kind: 'stat' });
archetypeFlow.entities.push({ id: 'ChefTray', label: '主厨托盘', kind: 'prop' });
archetypeFlow.entities.push({ id: 'ChefUpgradeCircle', label: '主厨升级圈', kind: 'upgrade_point' });
archetypeFlow.entities.push({ id: 'MoneyMagnetRange', label: '吸钱范围', kind: 'effect' });
archetypeFlow.entities.push({ id: 'TakeawayWindow', label: '外卖窗口', kind: 'station' });
archetypeFlow.phases[0].visibleEntities.push('DonutOven');
archetypeFlow.phases[0].visibleEntities.push('Donut');
archetypeFlow.phases[0].visibleEntities.push('GrilledShrimp');
archetypeFlow.phases[0].visibleEntities.push('PlayerSpeed');
archetypeFlow.phases[0].visibleEntities.push('ChefTray');
archetypeFlow.phases[0].visibleEntities.push('ChefUpgradeCircle');
archetypeFlow.phases[0].visibleEntities.push('MoneyMagnetRange');
archetypeFlow.phases[0].visibleEntities.push('TakeawayWindow');
var archetypeIr = buildSourceSceneIrFromStoryboardFlow(archetypeFlow, {
  sourceHtmlPath: path.join(tmp, 'archetype-source-ir-preview.html'),
  generatedAt: '2026-06-12T00:00:00.000Z',
});
var donutOvenEntity = archetypeIr.entities.filter(function(entity) { return entity.id === 'DonutOven'; })[0];
var donutEntity = archetypeIr.entities.filter(function(entity) { return entity.id === 'Donut'; })[0];
var shrimpEntity = archetypeIr.entities.filter(function(entity) { return entity.id === 'GrilledShrimp'; })[0];
var speedEntity = archetypeIr.entities.filter(function(entity) { return entity.id === 'PlayerSpeed'; })[0];
var trayEntity = archetypeIr.entities.filter(function(entity) { return entity.id === 'ChefTray'; })[0];
var upgradeEntity = archetypeIr.entities.filter(function(entity) { return entity.id === 'ChefUpgradeCircle'; })[0];
var magnetEntity = archetypeIr.entities.filter(function(entity) { return entity.id === 'MoneyMagnetRange'; })[0];
var takeawayWindowEntity = archetypeIr.entities.filter(function(entity) { return entity.id === 'TakeawayWindow'; })[0];
assert.strictEqual(donutOvenEntity.visual.archetype, 'donut_oven');
assert.strictEqual(donutOvenEntity.visual.meshOps.length >= 4, true);
assert.strictEqual(donutEntity.visual.archetype, 'donut');
assert.ok(donutEntity.visual.meshOps.some(function(op) { return op.kind === 'torus'; }));
assert.strictEqual(shrimpEntity.visual.archetype, 'shrimp');
assert.ok(shrimpEntity.visual.meshOps.some(function(op) { return op.kind === 'cone'; }));
assert.strictEqual(speedEntity.visual.archetype, 'ring_marker');
assert.strictEqual(trayEntity.visual.archetype, 'tray');
assert.strictEqual(upgradeEntity.visual.archetype, 'ring_marker');
assert.strictEqual(magnetEntity.visual.archetype, 'ring_marker');
assert.strictEqual(takeawayWindowEntity.visual.archetype, 'service_window');
assert.strictEqual(takeawayWindowEntity.visual.meshOps.length >= 4, true);
var queueHtml = buildSourceIrPreviewHtml(queueIr, {
  includeThree: false,
  sourceHtmlPath: path.join(tmp, 'queue-source-ir-preview.html'),
  generatedAt: '2026-06-12T00:00:00.000Z',
});
assert.ok(queueHtml.indexOf('isNpcGroupEntity') >= 0);
assert.ok(queueHtml.indexOf('makeNpcPerson') >= 0);
assert.ok(queueHtml.indexOf('if (!count) return 0') >= 0);
assert.ok(queueHtml.indexOf('buildMeshOpsGroup') >= 0);
assert.ok(queueHtml.indexOf('phaseTargetBaseId') >= 0);
assert.ok(queueHtml.indexOf('visualModelForTarget') >= 0);
assert.ok(queueHtml.indexOf('playerMovementBounds') >= 0);

var liveness = analyzeSourceIrPhaseLiveness(sourceIr, {});
assert.strictEqual(liveness.passed, true, JSON.stringify(liveness.violations, null, 2));

var html = buildSourceIrPreviewHtml(sourceIr, {
  includeThree: false,
  sourceHtmlPath: htmlPath,
  generatedAt: '2026-06-12T00:00:00.000Z',
});
var preflight = preflightSourceSceneIrHtml(html, {
  sourceHtmlPath: htmlPath,
  requireSourceIrRenderer: true,
});
assert.strictEqual(preflight.passed, true);

var csvPath = path.join(tmp, 'space-junk.csv');
var packageOut = path.join(tmp, 'storyboard-html-package');
var diffOut = path.join(tmp, 'storyboard-flow-diff');
fs.writeFileSync(csvPath, [
  '序号,文字描述',
  '1,拾取垃圾换得美金，玩家靠近垃圾堆，碎片飞入背包',
  '2,建造锻造间，玩家回到基地建造新房间',
  '3,使用新钻头采集垃圾，升级工具后采集效率提升',
  '4,处理太空障碍，玩家攻击挡路陨石',
  '5,组成完整空间站并展示立即下载按钮',
].join('\n'));
var packageCli = childProcess.spawnSync(process.execPath, [
  path.join(__dirname, '..', 'scripts', 'storyboard-html-package.cjs'),
  '--out-dir',
  packageOut,
  '--project-name',
  '太空捡垃圾HTML',
  '--generation-mode',
  'deterministic',
  csvPath,
], {
  cwd: path.join(__dirname, '..'),
  encoding: 'utf8',
  timeout: 120000,
});
assert.strictEqual(packageCli.status, 0, packageCli.stderr || packageCli.stdout);
var diffCli = childProcess.spawnSync(process.execPath, [
  path.join(__dirname, '..', 'scripts', 'storyboard-flow-diff.cjs'),
  flowPath,
  path.join(packageOut, 'generated.html'),
  diffOut,
  '--generated-at',
  '2026-06-12T00:00:00.000Z',
], {
  cwd: path.join(__dirname, '..'),
  encoding: 'utf8',
  timeout: 120000,
});
assert.strictEqual(diffCli.status, 0, diffCli.stderr || diffCli.stdout);
var diffReport = JSON.parse(fs.readFileSync(path.join(diffOut, 'storyboard-flow-diff-report.json'), 'utf8'));
assert.deepStrictEqual(diffReport.diffCounts, { blocker: 0, warn: 0, info: 0 });

console.log('storyboard flow space junk golden tests passed');
