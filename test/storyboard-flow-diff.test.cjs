#!/usr/bin/env node
'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

var {
  buildSourceSceneIrFromStoryboardFlow,
} = require('../engine/storyboard-flow-source-ir.cjs');
var {
  buildSourceIrPreviewHtml,
} = require('../engine/source-ir-preview-renderer.cjs');
var {
  buildStoryboardFlowDiffReport,
  compareSourceSceneIr,
  writeDiffReport,
} = require('../engine/storyboard-flow-diff.cjs');

function fixtureFlow() {
  return {
    schemaVersion: 'storyboard-flow-prototype.v1',
    kind: 'blueprint.storyboardFlowPrototype',
    projectName: 'Flow Diff Fixture',
    entities: [
      { id: 'Player', label: '玩家', kind: 'player' },
      { id: 'Oven', label: '烤箱', kind: 'station' },
      { id: 'Counter', label: '柜台', kind: 'station' },
      { id: 'CtaButton', label: '下载按钮', kind: 'cta' },
    ],
    resources: [
      { id: 'Food', label: '餐食', carrierEntity: 'Oven', initial: 0 },
      { id: 'Coin', label: '金币', carrierEntity: 'Counter', initial: 0 },
    ],
    phases: [
      {
        id: 'phase1',
        order: 1,
        title: '制作餐食',
        action: 'produce',
        target: 'Oven',
        resource: 'Food',
        guideText: '移动到烤箱制作餐食。',
        requiredInteractions: ['move_to:Oven', 'produce:Food:1'],
        completeCondition: 'Food >= 1',
        visibleEntities: ['Player', 'Oven'],
      },
      {
        id: 'phase2',
        order: 2,
        title: '交付餐食',
        action: 'deliver',
        target: 'Counter',
        resource: 'Food',
        guideText: '把餐食交到柜台获得金币。',
        requiredInteractions: ['deliver:Food:Counter:1', 'reward:Coin:10'],
        completeCondition: 'Coin >= 10',
        visibleEntities: ['Player', 'Counter', 'Oven'],
      },
      {
        id: 'phase3',
        order: 3,
        title: '下载',
        action: 'cta_finish',
        target: 'CtaButton',
        guideText: '点击按钮下载完整游戏。',
        requiredInteractions: ['click:CtaButton'],
        completeCondition: 'CtaButton.clicked',
        visibleEntities: ['Player', 'CtaButton'],
      },
    ],
  };
}

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard-flow-diff-'));
var flow = fixtureFlow();
var sourceIr = buildSourceSceneIrFromStoryboardFlow(flow, {
  generatedAt: '2026-06-12T00:00:00.000Z',
});
var identical = compareSourceSceneIr(sourceIr, sourceIr, {
  generatedAt: '2026-06-12T00:00:00.000Z',
});
assert.strictEqual(identical.passed, true);
assert.deepStrictEqual(identical.diffCounts, { blocker: 0, warn: 0, info: 0 });

var mutatedSourceIr = JSON.parse(JSON.stringify(sourceIr));
mutatedSourceIr.phases[1].guideText = '把餐食交到柜台。';
mutatedSourceIr.phases[1].steps = mutatedSourceIr.phases[1].steps.filter(function(step) {
  return step.kind !== 'reward';
});
var changed = compareSourceSceneIr(sourceIr, mutatedSourceIr, {
  generatedAt: '2026-06-12T00:00:00.000Z',
});
assert.strictEqual(changed.passed, true);
assert.ok(changed.diffs.some(function(diff) { return diff.code === 'phase_guide_text_diff'; }));
assert.ok(changed.diffs.some(function(diff) { return diff.code === 'phase_steps_diff'; }));

var htmlPath = path.join(tmp, 'source-ir-preview.html');
fs.writeFileSync(htmlPath, buildSourceIrPreviewHtml(mutatedSourceIr, {
  includeThree: false,
  generatedAt: '2026-06-12T00:00:00.000Z',
}));
var report = buildStoryboardFlowDiffReport(flow, htmlPath, {
  generatedAt: '2026-06-12T00:00:00.000Z',
});
assert.strictEqual(report.passed, true);
assert.ok(report.diffCounts.warn >= 2);
assert.ok(report.diffs.some(function(diff) { return diff.code === 'phase_steps_diff'; }));

var reportPath = writeDiffReport(report, tmp);
assert.ok(fs.existsSync(reportPath));
assert.strictEqual(JSON.parse(fs.readFileSync(reportPath, 'utf8')).schemaVersion, 'storyboard-flow-diff-report.v1');

var flowPath = path.join(tmp, 'flow.json');
var cliOut = path.join(tmp, 'cli-out');
fs.writeFileSync(flowPath, JSON.stringify(flow, null, 2));
var cli = childProcess.spawnSync(process.execPath, [
  path.join(__dirname, '..', 'scripts', 'storyboard-flow-diff.cjs'),
  flowPath,
  htmlPath,
  cliOut,
  '--generated-at',
  '2026-06-12T00:00:00.000Z',
], { encoding: 'utf8' });
assert.strictEqual(cli.status, 0, cli.stderr || cli.stdout);
assert.ok(fs.existsSync(path.join(cliOut, 'storyboard-flow-diff-report.json')));

console.log('storyboard flow diff tests passed');
