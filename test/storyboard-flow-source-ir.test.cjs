#!/usr/bin/env node
'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

var {
  buildSourceSceneIrFromStoryboardFlow,
  FLOW_CONTRACT_PATH,
  computeFlowResourceSnapshots,
  preflightStoryboardFlow,
} = require('../engine/storyboard-flow-source-ir.cjs');
var {
  buildSourceIrPreviewHtml,
} = require('../engine/source-ir-preview-renderer.cjs');
var {
  preflightSourceSceneIrHtml,
} = require('../engine/source-scene-ir.cjs');

function fixtureFlow() {
  return {
    schemaVersion: 'storyboard-flow-prototype.v1',
    kind: 'blueprint.storyboardFlowPrototype',
    projectName: 'MC原创_3D流水线小主厨解锁餐厅',
    storyboardIrCandidate: {
      project: { name: 'MC原创_3D流水线小主厨解锁餐厅', theme: 'restaurant' },
    },
    entities: [
      { id: 'Player', label: '小主厨', kind: 'player' },
      { id: 'DonutOven', label: '甜甜圈烤箱', kind: 'producer' },
      { id: 'DonutTable', label: '木质餐桌', kind: 'table' },
      { id: 'MoneyPile', label: '钞票山', kind: 'resource' },
      { id: 'ChefUpgradeCircle', label: '金色升级圈', kind: 'upgrade_point' },
      { id: 'ChefTray', label: '主厨托盘', kind: 'prop' },
      { id: 'CtaButton', label: '下载按钮', kind: 'cta' },
    ],
    resources: [
      { id: 'Donut', label: '甜甜圈', carrierEntity: 'DonutOven' },
      { id: 'Money', label: '钞票', carrierEntity: 'MoneyPile' },
    ],
    phases: [
      {
        order: 1,
        id: 'phase1',
        title: '甜甜圈取餐与爆钱',
        action: 'deliver',
        target: 'DonutTable',
        resource: 'Donut',
        guideText: '滑动控制小主厨去烤箱取甜甜圈，再送到餐桌赚到 300。',
        requiredInteractions: ['move_to:DonutOven', 'collect:Donut:1', 'deliver:Donut:DonutTable:1', 'collect:Money:300'],
        completeCondition: 'Money >= 300',
        visibleEntities: ['Player', 'DonutOven', 'DonutTable', 'MoneyPile'],
        visualNotes: '这里描述碰撞与卡死，但不应该生成合成食物。',
        position: { x: 80, y: 150 },
      },
      {
        order: 2,
        id: 'phase2',
        title: '主厨容量升级',
        action: 'upgrade',
        target: 'ChefUpgradeCircle',
        resource: 'Money',
        cost: '300',
        guideText: '进入中央金色升级圈，升级速度、托盘容量和吸钱范围。',
        requiredInteractions: ['move_to:ChefUpgradeCircle', 'upgrade:ChefTray:2'],
        completeCondition: 'ChefTray.level == 2',
        visibleEntities: ['Player', 'ChefUpgradeCircle', 'ChefTray', 'MoneyPile'],
        visualNotes: '托盘变大，磁铁碰撞范围扩大。',
        position: { x: 360, y: 80 },
      },
      {
        order: 3,
        id: 'phase3',
        title: '打包订单状态',
        action: 'deliver',
        target: 'TakeawayWindow',
        resource: 'Donut',
        guideText: '把食物交给外卖窗口，订单进入已打包状态。',
        requiredInteractions: ['deliver:Donut:TakeawayWindow:1'],
        completeCondition: 'TakeawayOrders.packed',
        visibleEntities: ['Player', 'TakeawayWindow'],
        position: { x: 520, y: 150 },
      },
      {
        order: 4,
        id: 'phase4',
        title: 'End Card',
        action: 'cta_finish',
        target: 'CtaButton',
        guideText: '点击下载继续体验。',
        requiredInteractions: ['click:CtaButton'],
        completeCondition: 'CtaButton.clicked == true',
        visibleEntities: ['Player', 'CtaButton'],
        position: { x: 640, y: 150 },
      },
    ],
  };
}

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard-flow-source-ir-'));
var htmlPath = path.join(tmp, 'source-ir-preview.html');
var authoringReport = preflightStoryboardFlow(fixtureFlow(), {
  generatedAt: '2026-06-12T00:00:00.000Z',
});
assert.strictEqual(authoringReport.passed, true);
assert.strictEqual(authoringReport.contract, FLOW_CONTRACT_PATH);
assert.ok(authoringReport.issueCounts.info >= 1);
assert.ok(authoringReport.issues.some(function(issue) {
  return issue.code === 'storyboard_flow_visual_merge_cue_ignored';
}));
assert.deepStrictEqual(authoringReport.resourceSnapshots[0].entering, { Donut: 0, Money: 0 });
assert.deepStrictEqual(authoringReport.resourceSnapshots[0].after, { Donut: 0, Money: 300 });
assert.deepStrictEqual(authoringReport.resourceSnapshots[1].cost, {
  resource: 'Money',
  amount: 300,
  before: 300,
  after: 0,
  affordable: true,
});
assert.deepStrictEqual(authoringReport.resourceSnapshots[1].after, { Donut: 0, Money: 0 });
assert.strictEqual(authoringReport.resourceSnapshots.length, fixtureFlow().phases.length);

var contractPath = path.join(__dirname, '..', FLOW_CONTRACT_PATH);
var contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
assert.strictEqual(contract.contractVersion, 'storyboard-flow-prototype.v1');
assert.strictEqual(contract.interactionDsl.explicitCombineOnly, true);

var directSnapshots = computeFlowResourceSnapshots([
  {
    id: 'phaseA',
    order: 1,
    requiredInteractions: ['collect:Money:10', 'deliver:Money:UnlockCircle:3'],
  },
], {
  resources: { Money: { initial: 5 } },
}, {
  resourceIds: { Money: true },
});
assert.deepStrictEqual(directSnapshots[0].entering, { Money: 5 });
assert.deepStrictEqual(directSnapshots[0].after, { Money: 12 });

var sourceIr = buildSourceSceneIrFromStoryboardFlow(fixtureFlow(), {
  sourceHtmlPath: htmlPath,
  generatedAt: '2026-06-12T00:00:00.000Z',
});

assert.strictEqual(sourceIr.schemaVersion, 'source-scene-ir.v1');
assert.strictEqual(sourceIr.project.theme, 'restaurant');
assert.strictEqual(sourceIr.phases.length, 4);
assert.strictEqual(sourceIr.phases[0].guideText, '滑动控制小主厨去烤箱取甜甜圈，再送到餐桌赚到 300。');
assert.ok(sourceIr.entities.some(function(entity) { return entity.id === 'DonutOven' && entity.label === '甜甜圈烤箱'; }));
assert.ok(sourceIr.resources.some(function(resource) { return resource.id === 'Money' && resource.label === '钞票'; }));
assert.strictEqual(sourceIr.resources.some(function(resource) { return resource.id === 'FoodBundle'; }), false);
assert.strictEqual(sourceIr.phases[0].steps.some(function(step) { return step.kind === 'combine'; }), false);
assert.strictEqual(sourceIr.phases[1].steps.some(function(step) { return step.kind === 'combine'; }), false);
assert.ok(sourceIr.phases[1].steps.some(function(step) { return step.kind === 'upgrade' && step.entity === 'ChefTray'; }));
assert.ok(sourceIr.phases[1].steps.some(function(step) {
  return step.kind === 'transfer' && step.resource === 'Money' && step.amount === 300 &&
    step.target === 'ChefUpgradeCircle' && step.purpose === 'cost';
}));
assert.ok(sourceIr.entities.some(function(entity) { return entity.id === 'TakeawayOrders'; }));
assert.ok(sourceIr.entities.some(function(entity) { return entity.id === 'MoneyPile'; }));
assert.ok(sourceIr.phases[0].steps.some(function(step) {
  return step.kind === 'collect' && step.resource === 'Money' && step.from === 'MoneyPile';
}));
assert.deepStrictEqual(sourceIr.phases[0].gate, { kind: 'resource', resource: 'Money', threshold: 300 });
assert.deepStrictEqual(sourceIr.phases[1].gate, { kind: 'entity_state', entity: 'ChefTray', state: 2 });
assert.deepStrictEqual(sourceIr.phases[2].gate, { kind: 'entity_state', entity: 'TakeawayOrders', state: 1 });
assert.strictEqual(sourceIr.phases[3].goalText, '点击下载继续体验。');
assert.notStrictEqual(sourceIr.phases[3].goalText, 'CtaButton.clicked == true');
assert.ok(sourceIr.phases[1].steps.some(function(step) {
  return step.kind === 'upgrade' && step.target === 'ChefUpgradeCircle' && step.entity === 'ChefTray';
}));

var html = buildSourceIrPreviewHtml(sourceIr, {
  includeThree: false,
  generatedAt: '2026-06-12T00:00:00.000Z',
});
var preflight = preflightSourceSceneIrHtml(html, {
  sourceHtmlPath: htmlPath,
  requireSourceIrRenderer: true,
});
assert.strictEqual(preflight.passed, true);

var inputPath = path.join(tmp, 'flow.json');
var outDir = path.join(tmp, 'out');
fs.writeFileSync(inputPath, JSON.stringify(fixtureFlow(), null, 2));
var cli = childProcess.spawnSync(process.execPath, [
  path.join(__dirname, '..', 'scripts', 'storyboard-flow-source-ir.cjs'),
  inputPath,
  outDir,
  '--no-three',
  '--generated-at',
  '2026-06-12T00:00:00.000Z',
], { encoding: 'utf8' });
assert.strictEqual(cli.status, 0, cli.stderr || cli.stdout);
var authoringCliReport = JSON.parse(fs.readFileSync(path.join(outDir, 'storyboard-flow-authoring-report.json'), 'utf8'));
assert.strictEqual(authoringCliReport.passed, true);
assert.strictEqual(authoringCliReport.contract, FLOW_CONTRACT_PATH);
assert.deepStrictEqual(authoringCliReport.resourceSnapshots[0].after, { Donut: 0, Money: 300 });
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(outDir, 'source-ir-preflight.json'), 'utf8')).passed, true);
assert.strictEqual(JSON.parse(fs.readFileSync(path.join(outDir, 'source-scene-ir.json'), 'utf8')).phases.length, 4);
var cliReport = JSON.parse(fs.readFileSync(path.join(outDir, 'storyboard-flow-source-ir-report.json'), 'utf8'));
assert.strictEqual(cliReport.contract, FLOW_CONTRACT_PATH);
assert.strictEqual(cliReport.resourceSnapshots.length, 4);

var validateOutDir = path.join(tmp, 'validate-out');
var validateCli = childProcess.spawnSync(process.execPath, [
  path.join(__dirname, '..', 'scripts', 'storyboard-flow-source-ir.cjs'),
  inputPath,
  validateOutDir,
  '--validate-only',
  '--generated-at',
  '2026-06-12T00:00:00.000Z',
], { encoding: 'utf8' });
assert.strictEqual(validateCli.status, 0, validateCli.stderr || validateCli.stdout);
assert.strictEqual(fs.existsSync(path.join(validateOutDir, 'source-scene-ir.json')), false);
var validateReport = JSON.parse(fs.readFileSync(path.join(validateOutDir, 'storyboard-flow-source-ir-report.json'), 'utf8'));
assert.strictEqual(validateReport.mode, 'validate-only');
assert.strictEqual(validateReport.passed, true);
assert.strictEqual(validateReport.resourceSnapshots.length, 4);

var badFlow = fixtureFlow();
badFlow.phases[0].requiredInteractions = ['teleport:DonutOven'];
var badInputPath = path.join(tmp, 'bad-flow.json');
var badOutDir = path.join(tmp, 'bad-out');
fs.writeFileSync(badInputPath, JSON.stringify(badFlow, null, 2));
var badCli = childProcess.spawnSync(process.execPath, [
  path.join(__dirname, '..', 'scripts', 'storyboard-flow-source-ir.cjs'),
  badInputPath,
  badOutDir,
  '--no-three',
], { encoding: 'utf8' });
assert.notStrictEqual(badCli.status, 0);
var badReport = JSON.parse(fs.readFileSync(path.join(badOutDir, 'storyboard-flow-authoring-report.json'), 'utf8'));
assert.strictEqual(badReport.passed, false);
assert.ok(badReport.issues.some(function(issue) {
  return issue.code === 'storyboard_flow_interaction_verb_unknown';
}));
var badSourceReport = JSON.parse(fs.readFileSync(path.join(badOutDir, 'storyboard-flow-source-ir-report.json'), 'utf8'));
assert.strictEqual(badSourceReport.passed, false);
assert.strictEqual(badSourceReport.contract, FLOW_CONTRACT_PATH);

console.log('storyboard flow SourceIR tests passed');
