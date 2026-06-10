#!/usr/bin/env node
'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var spawnSync = require('child_process').spawnSync;

var storyboardAi = require('../engine/storyboard-ai.cjs');
var customerPdf = require('../adapters/customer-storyboard-pdf.cjs');

var template = customerPdf.buildTemplateStoryboardAi({ projectName: 'AI试玩广告分镜模板' });
assert.strictEqual(template.kind, 'blueprint.storyboardAi');
assert.strictEqual(template.schemaVersion, 'storyboard-ai.v1');
assert.strictEqual(template.phases.length, 12);
assert.strictEqual(template.project.customerPdfTemplate, 'customer-storyboard-pdf.v1');
assert.strictEqual(template.diagnostics.length, 0);
assert.ok(template.semanticHash);

var rows = customerPdf.buildCustomerStoryboardRows(template);
assert.strictEqual(rows.length, 12);
assert.deepStrictEqual(Object.keys(rows[0]), ['rowNo', 'phaseId', 'phaseTitle', 'description', 'image', 'imageLabel', 'sourceEvidence']);
assert.strictEqual(rows[0].rowNo, 1);
assert.strictEqual(rows[0].phaseId, 'phase1');
assert.ok(rows[0].description.indexOf('玩家看到什么') >= 0);

var map = customerPdf.buildPdfMap(template);
assert.strictEqual(map.template, 'customer-storyboard-pdf.v1');
assert.strictEqual(map.rows.length, 12);
assert.strictEqual(map.rows[11].phaseId, 'phase12');
assert.strictEqual(map.rows[11].canonicalInteraction, 'click:CtaButton');

var normalized = storyboardAi.normalizeStoryboardAi({
  projectName: '太空捡垃圾PA',
  coreLoop: '拾取垃圾换得美金 -> 建造锻造间 -> CTA',
  phases: [
    { title: '拾取垃圾', sceneText: '太空舱外有垃圾。', playerAction: '采集垃圾。', feedback: '碎片飞入背包。', visualPrompt: '采集反馈' },
    { title: '结束收口', sceneText: '展示空间站全景。', playerAction: '点击下载。', visualPrompt: 'CTA按钮' },
  ],
});
assert.strictEqual(normalized.phases[0].canonicalInteraction, 'collect:Resource:1');
assert.strictEqual(normalized.phases[1].canonicalInteraction, 'click:CtaButton');
assert.strictEqual(normalized.diagnostics.some(function(item) {
  return item.code === 'storyboard_ai_phase_count_out_of_bounds';
}), true);

(async function() {
  var buffer = await customerPdf.generateCustomerStoryboardPDF(template);
  assert.ok(Buffer.isBuffer(buffer));
  assert.strictEqual(buffer.slice(0, 4).toString('utf8'), '%PDF');

  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'customer-storyboard-pdf-'));
  var outPath = path.join(dir, 'template.pdf');
  var mapPath = path.join(dir, 'template.map.json');
  var result = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'scripts/customer-storyboard-pdf.cjs'),
    '--template',
    outPath,
    '--map',
    mapPath,
  ], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  assert.ok(fs.existsSync(outPath));
  assert.ok(fs.statSync(outPath).size > 10000);
  var writtenMap = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  assert.strictEqual(writtenMap.rows.length, 12);
  assert.strictEqual(writtenMap.rows[0].phaseId, 'phase1');
})().catch(function(err) {
  console.error(err && err.stack || err);
  process.exit(1);
});
