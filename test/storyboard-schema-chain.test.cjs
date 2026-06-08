#!/usr/bin/env node
'use strict';

var assert = require('assert');
var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

var storyboardIrMod = require('../engine/storyboard-ir.cjs');
var storyboardSpecCompiler = require('../engine/storyboard-spec-compiler.cjs');
var storyboardSourceIrCompiler = require('../engine/storyboard-source-ir-compiler.cjs');
var specExtractStage = require('../engine/stages/spec-extract.cjs');
var sourceSceneIr = require('../engine/source-scene-ir.cjs');

function withEnv(updates, fn) {
  var previous = {};
  Object.keys(updates).forEach(function(key) {
    previous[key] = process.env[key];
    process.env[key] = updates[key];
  });
  return Promise.resolve().then(fn).finally(function() {
    Object.keys(updates).forEach(function(key) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    });
  });
}

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard-schema-chain-'));
var storyboardIr = storyboardIrMod.normalizeStoryboardIr({
  projectName: 'SchemaChain',
  themeHint: 'farming',
  entities: [
    { name: 'Player', label: 'Player', template: 'PlayerController' },
    { name: 'CornPatch', label: '玉米地', template: 'Collectible' },
    { name: 'StorageBin', label: '仓库', template: 'Static' },
    { name: 'CtaButton', label: '下载按钮', template: 'UI' },
  ],
  storyboardFrames: [
    {
      chapter: 1,
      title: '收集玉米',
      interaction: 'collect:Corn:3',
      scene: '玩家站在玉米地旁边，玉米资源高亮。',
      ui: '拖摇杆靠近玉米地收集 3 个玉米',
      visibleEntities: ['Player', 'CornPatch', 'StorageBin'],
    },
    {
      chapter: 2,
      title: '点击下载',
      interaction: 'click:CtaButton',
      scene: '下载按钮出现在画面右下角。',
      ui: '点击下载按钮完成试玩。',
    },
  ],
}, {
  projectName: 'SchemaChain',
  theme: 'farming',
  entities: [
    { name: 'Player', label: 'Player' },
    { name: 'CornPatch', label: '玉米地' },
    { name: 'StorageBin', label: '仓库' },
    { name: 'CtaButton', label: '下载按钮' },
  ],
});

var compiled = storyboardSpecCompiler.compileSpecsFromStoryboardIr(storyboardIr, {
  entities: [
    { name: 'Player', label: 'Player' },
    { name: 'CornPatch', label: '玉米地' },
    { name: 'StorageBin', label: '仓库' },
    { name: 'CtaButton', label: '下载按钮' },
  ],
});
assert.strictEqual(compiled.ok, true);
assert.strictEqual(compiled.specs.length, 2);
assert.strictEqual(compiled.specs[0].phaseId, 'phase1');
assert.deepStrictEqual(compiled.specs[0].requiredInteractions, ['collect:Corn:3']);
assert.deepStrictEqual(compiled.specs[0].goal, { kind: 'amount', target: 3, displayResource: 'Corn' });
assert.deepStrictEqual(compiled.specs[0].visibleEntities, ['Player', 'CornPatch', 'StorageBin']);
assert.ok(compiled.specs[0].entitiesRequired.some(function(entity) { return entity.name === 'StorageBin'; }));
assert.strictEqual(compiled.specs[1].requiredInteractions[0], 'click:CtaButton');

var sourceIr = storyboardSourceIrCompiler.compileSourceSceneIrFromStoryboard({
  projectName: 'SchemaChain',
  themeHint: 'farming',
  entities: [
    { name: 'Player', label: 'Player', template: 'PlayerController' },
    { name: 'CornPatch', label: '玉米地', template: 'Collectible' },
    { name: 'StorageBin', label: '仓库', template: 'Static' },
    { name: 'CtaButton', label: '下载按钮', template: 'UI' },
  ],
  specs: compiled.specs,
  storyboardIr: storyboardIr,
}, {
  sourceHtmlPath: path.join(tmp, 'deterministic.html'),
});
assert.strictEqual(sourceIr.schemaVersion, 'source-scene-ir.v1');
assert.strictEqual(sourceIr.phases.length, 2);
assert.strictEqual(sourceIr.phases[0].gate.kind, 'resource');
assert.ok(sourceIr.phases[0].showEntities.indexOf('CornPatch') >= 0, 'collect resource carrier should be visible in the phase');
assert.ok(sourceIr.phases[0].showEntities.indexOf('StorageBin') >= 0, 'frame visible entities should survive into SourceIR showEntities');
assert.strictEqual(sourceIr.phases[0].steps[0].target, 'CornPatch');
assert.strictEqual(sourceIr.resources[0].carrierEntity, 'CornPatch');
assert.strictEqual(sourceIr.phases[1].gate.kind, 'cta_arrival');
assert.ok(sourceIr.semanticHash);

var repairedMisplacedCtaSourceIr = storyboardSourceIrCompiler.compileSourceSceneIrFromStoryboard({
  projectName: 'MisplacedCta',
  entities: [
    { name: 'Player', label: 'Player' },
    { name: 'CtaButton', label: '下载按钮' },
  ],
  specs: [
    {
      phaseId: 'phase1',
      phaseName: '中间阶段误带 CTA 文案',
      requiredInteractions: ['collect:Corn:1', 'click:CtaButton'],
    },
    {
      phaseId: 'phase2',
      phaseName: '最终下载',
      requiredInteractions: ['click:CtaButton'],
    },
  ],
}, {
  sourceHtmlPath: path.join(tmp, 'misplaced-cta.html'),
});
assert.strictEqual(repairedMisplacedCtaSourceIr.phases[0].gate.kind, 'resource');
assert.ok(!repairedMisplacedCtaSourceIr.phases[0].steps.some(function(step) {
  return step.kind === 'cta_finish';
}), 'non-final click:CtaButton must not compile to cta_finish');
assert.strictEqual(repairedMisplacedCtaSourceIr.phases[1].steps[0].kind, 'cta_finish');

(function() {
  var logs = [];
  return withEnv({
    NO_LLM_HOT_PATH: 'enforce',
    SPECS_DATA_DIR: path.join(tmp, 'spec-data'),
  }, function() {
    return specExtractStage.execute({
      taskId: 'storyboard-schema-chain',
      blueprint: {
        projectName: 'SchemaChain',
        storyboardIr: storyboardIr,
        entities: [
          { name: 'Player', label: 'Player' },
          { name: 'CornPatch', label: '玉米地' },
          { name: 'StorageBin', label: '仓库' },
          { name: 'CtaButton', label: '下载按钮' },
        ],
      },
      addLog: function(stage, message) {
        logs.push(stage + ': ' + message);
      },
    });
  }).then(function() {
    assert.ok(logs.some(function(line) { return line.indexOf('storyboard-ir: 2 phases') >= 0; }), 'spec-extract should use storyboard-ir source');
    var bundlePath = path.join(tmp, 'bundle.json');
    var htmlPath = path.join(tmp, 'out.html');
    fs.writeFileSync(bundlePath, JSON.stringify({
      kind: 'blueprint.storyboard2html.input',
      projectName: 'SchemaChain',
      themeHint: 'farming',
      entities: [
        { name: 'Player', label: 'Player', template: 'PlayerController' },
        { name: 'CornPatch', label: '玉米地', template: 'Collectible' },
        { name: 'StorageBin', label: '仓库', template: 'Static' },
        { name: 'CtaButton', label: '下载按钮', template: 'UI' },
      ],
      resources: [{ name: 'Corn', entity: 'CornPatch' }],
      specs: compiled.specs,
      storyboardFrames: [],
      storyboardIr: storyboardIr,
    }, null, 2));
    var cli = childProcess.spawnSync(process.execPath, [
      path.join(__dirname, '..', 'scripts', 'storyboard2html-generate.cjs'),
      bundlePath,
      htmlPath,
      '--deterministic-source-ir',
    ], { encoding: 'utf8', cwd: path.join(__dirname, '..') });
    assert.strictEqual(cli.status, 0, cli.stderr || cli.stdout);
    var html = fs.readFileSync(htmlPath, 'utf8');
    assert.ok(html.indexOf('window.__BP_SOURCE_IR__') >= 0);
    assert.ok(html.indexOf('window.__BP_SOURCE_IR_RENDERER_OWNS_VISUALS__ = true') >= 0);
    var extracted = sourceSceneIr.extractSourceSceneIrFromHtml(html, htmlPath);
    assert.strictEqual(extracted.schemaVersion, 'source-scene-ir.v1');
    assert.strictEqual(extracted.phases.length, 2);
    console.log('storyboard schema chain tests passed');
  });
})().catch(function(err) {
  console.error(err && err.stack || err);
  process.exit(1);
});
