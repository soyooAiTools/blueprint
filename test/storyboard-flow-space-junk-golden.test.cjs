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
