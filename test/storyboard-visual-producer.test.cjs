#!/usr/bin/env node
'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var customerPdf = require('../adapters/customer-storyboard-pdf.cjs');
var visualProducer = require('../lib/storyboard-visual-producer.cjs');

(async function() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard-visual-producer-'));
  var storyboard = customerPdf.buildTemplateStoryboardAi({ projectName: '视觉生产测试' });

  var report = await visualProducer.produceStoryboardVisuals(storyboard, path.join(dir, 'assets'), {
    baseDir: dir,
    visualMode: 'brief-card',
  });
  assert.strictEqual(report.schemaVersion, 'storyboard-visual-production.v1');
  assert.strictEqual(report.mode, 'brief-card');
  assert.strictEqual(report.phases.length, storyboard.phases.length);
  assert.ok(fs.existsSync(path.join(dir, 'assets', 'phase01.png')));
  assert.ok(fs.existsSync(path.join(dir, 'visual-prompts', 'phase01.prompt.txt')));
  assert.ok(fs.existsSync(path.join(dir, 'visual-prompts', 'phase01.json')));
  assert.ok(/试玩广告客户确认分镜/.test(fs.readFileSync(path.join(dir, 'visual-prompts', 'phase01.prompt.txt'), 'utf8')));

  var pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lGMCngAAAABJRU5ErkJggg==';
  var writer = path.join(dir, 'write-image.cjs');
  fs.writeFileSync(writer, [
    "'use strict';",
    "var fs = require('fs');",
    "fs.writeFileSync(process.env.STORYBOARD_PHASE_OUTPUT, Buffer.from('" + pixel + "', 'base64'));",
  ].join('\n'));
  var externalStoryboard = customerPdf.buildTemplateStoryboardAi({ projectName: '外部视觉测试' });
  var externalReport = await visualProducer.produceStoryboardVisuals(externalStoryboard, path.join(dir, 'external-assets'), {
    baseDir: dir,
    visualMode: 'external',
    visualCommand: process.execPath + ' ' + writer,
  });
  assert.strictEqual(externalReport.mode, 'external');
  assert.strictEqual(externalReport.status, 'ok');
  assert.strictEqual(externalReport.phases[0].status, 'external_ok');
  assert.ok(fs.existsSync(path.join(dir, 'external-assets', 'phase12.png')));
})().catch(function(err) {
  console.error(err && err.stack || err);
  process.exit(1);
});
