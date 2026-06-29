#!/usr/bin/env node
'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var spawnSync = require('child_process').spawnSync;
var AdmZip = require('adm-zip');
var PDFDocument = require('pdfkit');
var sharp = require('sharp');

var staticParser = require('../adapters/storyboard-static-parser.cjs');
var planner = require('../engine/storyboard-ai-planner.cjs');
var packager = require('../scripts/storyboard-pdf-package.cjs');

function writeMinimalDocx(filePath, paragraphs) {
  var zip = new AdmZip();
  zip.addFile('word/document.xml', Buffer.from([
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>',
    paragraphs.map(function(text) {
      return '<w:p><w:r><w:t>' + text + '</w:t></w:r></w:p>';
    }).join(''),
    '</w:body></w:document>',
  ].join('')));
  zip.writeZip(filePath);
}

function writeMinimalXlsx(filePath, rows) {
  var zip = new AdmZip();
  var shared = [];
  rows.forEach(function(row) { row.forEach(function(cell) { shared.push(cell); }); });
  zip.addFile('xl/sharedStrings.xml', Buffer.from([
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    shared.map(function(text) { return '<si><t>' + text + '</t></si>'; }).join(''),
    '</sst>',
  ].join('')));
  var idx = 0;
  var rowXml = rows.map(function(row, rowIndex) {
    var cells = row.map(function() {
      return '<c t="s"><v>' + (idx++) + '</v></c>';
    }).join('');
    return '<row r="' + (rowIndex + 1) + '">' + cells + '</row>';
  }).join('');
  zip.addFile('xl/worksheets/sheet1.xml', Buffer.from('<worksheet><sheetData>' + rowXml + '</sheetData></worksheet>'));
  zip.writeZip(filePath);
}

function writePdf(filePath) {
  return new Promise(function(resolve) {
    var doc = new PDFDocument({ size: 'A4' });
    doc.pipe(fs.createWriteStream(filePath));
    doc.font('Helvetica').fontSize(16).text('Space junk playable');
    doc.fontSize(12).text('Phase1: collect scrap near station');
    doc.text('Phase2: build forge workshop with coins');
    doc.text('Phase3: upgrade drill');
    doc.text('Phase4: CTA finish');
    doc.end();
    doc.on('end', resolve);
  });
}

(async function() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard-pdf-package-'));
  var csv = path.join(dir, 'flow.csv');
  var docx = path.join(dir, 'notes.docx');
  var xlsx = path.join(dir, 'table.xlsx');
  var pdf = path.join(dir, 'story.pdf');
  var png = path.join(dir, 'ref.png');
  var html = path.join(dir, 'ref.html');
  fs.writeFileSync(csv, [
    'Phase,Visual,Action,Feedback',
    '开局目标,太空回收站,引导玩家靠近垃圾,箭头指向垃圾',
    '首次采集,垃圾爆开,采集金属碎片,碎片飞入背包',
    '建造锻造间,地贴出现,投入美金,锻造间建成',
  ].join('\n'));
  writeMinimalDocx(docx, ['Phase4: 升级钻头', '玩家看到钻头变成三头钻，采集效率提升。']);
  writeMinimalXlsx(xlsx, [['Phase5', '升级粉碎车', '把金币投入锻造车间'], ['Phase6', '解锁新船舱', '建成餐厅和宿舍']]);
  await writePdf(pdf);
  await sharp({ create: { width: 160, height: 90, channels: 3, background: '#88aadd' } }).png().toFile(png);
  fs.writeFileSync(html, '<html><body>playable reference</body></html>');

  var evidence = staticParser.parseStaticSources([csv, docx, xlsx, pdf, png, html], { projectName: '静态分镜测试' });
  assert.strictEqual(evidence.kind, 'blueprint.evidenceIr');
  assert.strictEqual(evidence.sources.length, 6);
  assert.ok(evidence.facts.some(function(fact) { return fact.factType === 'visual_reference'; }));
  assert.ok(evidence.diagnostics.some(function(item) { return item.code === 'manual_required_source'; }));
  assert.strictEqual(evidence.sources.filter(function(source) { return source.status === 'manual_required'; }).length, 1);

  var storyboard = planner.planStoryboardAiFromEvidence(evidence);
  assert.ok(storyboard.phases.length >= 10 && storyboard.phases.length <= 13);
  assert.strictEqual(storyboard.phases[storyboard.phases.length - 1].canonicalInteraction, 'click:CtaButton');
  assert.ok(storyboard.phases.some(function(phase) {
    return (phase.requiredInteractions || []).some(function(item) {
      return /^deliver:MetalScrap:RecycleStation:/.test(item);
    });
  }));
  assert.ok(storyboard.phases.some(function(phase) {
    return (phase.requiredInteractions || []).some(function(item) { return /^reward:Cash:/.test(item); });
  }));
  assert.ok(!storyboard.phases.some(function(phase) {
    return /冲突|处理冲突|高潮全景/.test(phase.title || '');
  }));
  assert.ok(storyboard.phases[0].visualBrief);
  assert.strictEqual(planner._internals.titleHintFromFacts([
    { text: 'Phase6:' },
    { text: '升级液压车      （前边有两个大的液压装置，能够快速的' },
  ]), '升级液压车');
  assert.strictEqual(planner._internals.titleHintFromFacts([
    { text: 'Phase1:' },
    { text: '拾取垃圾在太空回收站舱   秒左右一个垃圾爆开，爆出大量的金属碎' },
    { text: '换得美金      块，收集在玩家身后）' },
  ]), '拾取垃圾换得美金');
  var imageOnlyStoryboard = planner.planStoryboardAiFromEvidence(staticParser.parseStaticSources([png], { projectName: '图片参考测试' }));
  assert.ok(/图片参考/.test(imageOnlyStoryboard.phases[0].sceneText));
  assert.ok(imageOnlyStoryboard.phases[0].visualBrief.referenceImages.length >= 1);

  var outDir = path.join(dir, 'pkg');
  var report = await packager.buildPackage([csv, docx, xlsx, pdf, png, html], outDir, { projectName: '静态分镜测试' });
  assert.strictEqual(report.phaseCount, 12);
  assert.strictEqual(report.unsupportedOrManualSources.length, 1);
  assert.strictEqual(report.imageGeneration.schemaVersion, 'storyboard-visual-production.v1');
  assert.strictEqual(report.imageGeneration.mode, 'brief-card');
  [
    'evidence-ir.json',
    'storyboard-ai.json',
    'customer-storyboard.pdf',
    'customer-storyboard.map.json',
    'audit-report.json',
    'assets/phase01.png',
    'assets/phase12.png',
    'visual-prompts/phase01.prompt.txt',
    'visual-prompts/phase12.json',
  ].forEach(function(file) {
    assert.ok(fs.existsSync(path.join(outDir, file)), file + ' should exist');
  });
  var pdfBytes = fs.readFileSync(path.join(outDir, 'customer-storyboard.pdf'));
  assert.strictEqual(pdfBytes.slice(0, 4).toString('utf8'), '%PDF');

  var cliOut = path.join(dir, 'cli-pkg');
  var cli = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'scripts/storyboard-pdf-package.cjs'),
    '--out-dir',
    cliOut,
    '--project-name',
    '静态分镜测试',
    csv,
    docx,
    xlsx,
    pdf,
    png,
    html,
  ], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.strictEqual(cli.status, 0, cli.stderr || cli.stdout);
  assert.ok(/phaseCount=12/.test(cli.stdout));
  assert.ok(fs.existsSync(path.join(cliOut, 'customer-storyboard.pdf')));

  var htmlOnlyOut = path.join(dir, 'html-only');
  var htmlOnly = spawnSync(process.execPath, [
    path.join(__dirname, '..', 'scripts/storyboard-pdf-package.cjs'),
    '--out-dir',
    htmlOnlyOut,
    html,
  ], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.notStrictEqual(htmlOnly.status, 0);
  assert.ok(/No automatable static storyboard evidence/.test(htmlOnly.stderr));
})().catch(function(err) {
  console.error(err && err.stack || err);
  process.exit(1);
});
