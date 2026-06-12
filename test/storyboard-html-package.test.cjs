'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');
var packager = require('../scripts/storyboard-html-package.cjs');
var {
  extractSourceSceneIrFromHtml,
} = require('../engine/source-scene-ir.cjs');

function writeFixtureCsv(dir) {
  var csvPath = path.join(dir, 'space-junk.csv');
  fs.writeFileSync(csvPath, [
    '序号,文字描述',
    '1,拾取垃圾换得美金，玩家靠近垃圾堆，碎片飞入背包',
    '2,建造锻造间，玩家回到基地建造新房间',
    '3,使用新钻头采集垃圾，升级工具后采集效率提升',
    '4,处理太空障碍，玩家攻击挡路陨石',
    '5,组成完整空间站并展示立即下载按钮',
  ].join('\n'));
  return csvPath;
}

(async function run() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard-html-package-test-'));
  var input = writeFixtureCsv(dir);
  var outDir = path.join(dir, 'package');
  var report = await packager.buildPackage([input], outDir, {
    projectName: '太空捡垃圾HTML',
    generationMode: 'deterministic',
  });

  assert.strictEqual(report.schemaVersion, 'storyboard-html-package-report.v1');
  assert.strictEqual(report.phaseCount, 12);
  assert.strictEqual(report.generation.mode, 'deterministic');
  assert.strictEqual(report.generation.status, 'done');
  assert.strictEqual(report.unsupportedOrManualSources.length, 0);
  assert.ok(fs.existsSync(report.artifacts.generatedHtml));
  assert.ok(fs.readFileSync(report.artifacts.generatedHtml, 'utf8').indexOf('window.__BP_SOURCE_IR__') >= 0);
  assert.ok(fs.existsSync(report.artifacts.storyboard2htmlInput));
  assert.ok(fs.existsSync(report.artifacts.sourceIrPreflight));
  assert.strictEqual(JSON.parse(fs.readFileSync(report.artifacts.sourceIrPreflight, 'utf8')).passed, true);
  var storyboardAi = JSON.parse(fs.readFileSync(report.artifacts.storyboardAi, 'utf8'));
  assert.ok(storyboardAi.phases.some(function(phase) {
    return (phase.requiredInteractions || []).indexOf('deliver:MetalScrap:RecycleStation:1') >= 0;
  }));
  assert.ok(!storyboardAi.phases.some(function(phase) {
    return /冲突|障碍出现|处理冲突|高潮全景/.test(phase.title || '');
  }));
  var inputBundle = JSON.parse(fs.readFileSync(report.artifacts.storyboard2htmlInput, 'utf8'));
  assert.ok(inputBundle.resources.some(function(resource) {
    return resource.name === 'MetalScrap' && resource.carrierEntity === 'ScrapPile';
  }));
  assert.ok(inputBundle.resources.some(function(resource) {
    return resource.name === 'Cash' && resource.carrierEntity === 'CashCounter';
  }));
  assert.ok(inputBundle.specs.some(function(spec) {
    return spec.requiredInteractions.indexOf('reward:Cash:5') >= 0 || spec.requiredInteractions.indexOf('reward:Cash:10') >= 0;
  }));
  assert.ok(inputBundle.specs.some(function(spec) {
    return spec.requiredInteractions.indexOf('transfer:Cash:ForgeRoom:5') >= 0;
  }));
  assert.ok(inputBundle.entities.some(function(entity) {
    return entity.name === 'SpaceStationModule' && entity.label === '完整空间站';
  }));
  var generatedSourceIr = extractSourceSceneIrFromHtml(
    fs.readFileSync(report.artifacts.generatedHtml, 'utf8'),
    report.artifacts.generatedHtml,
    { requireSourceIrRenderer: true }
  );
  assert.ok(generatedSourceIr.resources.some(function(resource) {
    return resource.id === 'MetalScrap' && resource.carrierEntity === 'ScrapPile';
  }));
  assert.ok(generatedSourceIr.resources.some(function(resource) {
    return resource.id === 'Cash' && resource.carrierEntity === 'CashCounter';
  }));
  assert.ok(generatedSourceIr.phases.some(function(phase) {
    return (phase.steps || []).some(function(step) { return step.kind === 'deliver' && step.resource === 'MetalScrap'; });
  }));
  assert.ok(generatedSourceIr.phases.some(function(phase) {
    return (phase.steps || []).some(function(step) { return step.kind === 'reward' && step.resource === 'Cash'; });
  }));
  assert.ok(generatedSourceIr.phases.some(function(phase) {
    return (phase.steps || []).some(function(step) { return step.kind === 'transfer' && step.resource === 'Cash'; });
  }));
  assert.ok(generatedSourceIr.entities.some(function(entity) {
    return entity.id === 'SpaceStationModule' && entity.label === '完整空间站';
  }));
  assert.ok(generatedSourceIr.phases.some(function(phase) {
    return phase.guideText === '查看完整空间站，准备进入下载收口。';
  }));

  var cliOut = path.join(dir, 'cli-package');
  var cli = childProcess.spawnSync(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'storyboard-html-package.cjs'),
    '--out-dir',
    cliOut,
    '--project-name',
    'CLI HTML',
    '--generation-mode',
    'deterministic',
    input,
  ], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    timeout: 120000,
  });
  assert.strictEqual(cli.status, 0, cli.stderr || cli.stdout);
  assert.ok(fs.existsSync(path.join(cliOut, 'generated.html')));
  assert.ok(cli.stdout.indexOf('phaseCount=12') >= 0);

  console.log('storyboard html package tests passed');
})().catch(function(err) {
  console.error(err && err.stack || err);
  process.exit(1);
});
