#!/usr/bin/env node
'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var {
  assertPlayableSceneIrExecutionAlignment,
  buildPlayableSceneIrFromHtml,
  assertPlayableSceneIrBinding,
  loadPlayableSceneIr,
  sha256OfString,
  writePlayableSceneIr,
} = require('../engine/playable-scene-ir.cjs');
var {
  injectPlayableSceneIr,
} = require('../adapters/source-ir/visual-overlay.js');

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playable-scene-ir-'));
var htmlPath = path.join(tmp, 'source.html');
var html = [
  '<!doctype html><html><head><title>IR fixture</title></head><body>',
  '<script>',
  'const SCENE_CONFIG = { backgroundColor:"#112233", ground:{kind:"box", width:12, height:0.2, color:"#445566"} };',
  'const ENTITY_STYLE = {',
  '  Player: { label:"Player", kind:"hero", color:"#66ccff" },',
  '  WaterDrop: { label:"Water", kind:"resource", color:"#33aaff" },',
  '  CtaButton: { label:"Install", kind:"cta", color:"#22cc88" }',
  '};',
  'const ENTITY_POSITIONS = { Player:{x:1,y:0,z:2}, WaterDrop:{x:4,y:0,z:2}, CtaButton:{x:7,y:0,z:2} };',
  'const PHASES = [',
  '  { id:"phase1", guideText:"Collect water", showEntities:["Player","WaterDrop"], plannedModuleIds:["player_input_joystick"], trigger:{type:"resource_collected",resource:"Water",amount:3} },',
  '  { id:"phase2", guideText:"Install", showEntities:["Player","CtaButton"], trigger:{type:"click_entity",entity:"CtaButton"} }',
  '];',
  '</script>',
  '</body></html>',
].join('\n');
fs.writeFileSync(htmlPath, html);

var ir = buildPlayableSceneIrFromHtml(htmlPath, {
  html: html,
  project: 'ir-fixture',
  generatedAt: '2026-06-06T00:00:00.000Z',
});
assert.strictEqual(ir.kind, 'blueprint.playableSceneIR');
assert.strictEqual(ir.source.htmlPath, htmlPath);
assert.strictEqual(ir.source.htmlSha256, sha256OfString(html));
assert.strictEqual(ir.scene.backgroundColor, '#112233');
assert.strictEqual(ir.phases.length, 2);
assert.strictEqual(ir.phases[0].trigger.type, 'resource_collected');
assert.strictEqual(ir.phases[0].trigger.resource, 'Water');
assert.ok(ir.entities.some(function(entity) {
  return entity.name === 'Player' && entity.position && entity.position.x === 1;
}));
assert.ok(/^[0-9a-f]{64}$/.test(ir.semanticHash));

var irAgain = buildPlayableSceneIrFromHtml(htmlPath, {
  html: html,
  project: 'ir-fixture',
  generatedAt: '2026-06-06T01:00:00.000Z',
});
assert.strictEqual(irAgain.semanticHash, ir.semanticHash, 'semantic hash must ignore generatedAt');

assert.deepStrictEqual(assertPlayableSceneIrBinding(ir, {
  assetManifest: {
    source: htmlPath,
    sourceHtmlSha256: ir.source.htmlSha256,
    playableSceneIrHash: ir.semanticHash,
  },
}), {
  sourceHtmlPath: htmlPath,
  sourceHtmlSha256: ir.source.htmlSha256,
  playableSceneIrHash: ir.semanticHash,
});

assert.throws(function() {
  assertPlayableSceneIrBinding(ir, {
    assetManifest: {
      source: htmlPath,
      sourceHtmlSha256: '0'.repeat(64),
      playableSceneIrHash: ir.semanticHash,
    },
  });
}, /sourceHtmlSha256 mismatch/);

assert.deepStrictEqual(assertPlayableSceneIrExecutionAlignment(ir, {
  gameSchema: {
    phases: [
      {
        phaseId: 'phase1',
        guideText: 'Collect water',
        showEntities: ['Player', 'WaterDrop'],
        steps: [{ index: 0, target: 'WaterDrop', label: 'Water', gain: 'Water', amount: 3 }],
        trigger: { type: 'resource_collected', resource: 'Water', amount: 3 },
      },
      {
        phaseId: 'phase2',
        guideText: 'Install',
        showEntities: ['Player', 'CtaButton'],
        steps: [{ index: 0, target: 'CtaButton', label: 'Install' }],
        trigger: { type: 'click_entity', entity: 'CtaButton' },
      },
    ],
  },
}).passed, true);

assert.throws(function() {
  assertPlayableSceneIrExecutionAlignment(ir, {
    gameSchema: {
      phases: [
        {
          phaseId: 'phase1',
          guideText: 'Drifted text',
          showEntities: ['Player', 'WaterDrop'],
          steps: [{ index: 0, target: 'WaterDrop', label: 'Water', gain: 'Water', amount: 3 }],
          trigger: { type: 'resource_collected', resource: 'Water', amount: 3 },
        },
        {
          phaseId: 'phase2',
          guideText: 'Install',
          showEntities: ['Player', 'CtaButton'],
          steps: [{ index: 0, target: 'CtaButton', label: 'Install' }],
          trigger: { type: 'click_entity', entity: 'CtaButton' },
        },
      ],
    },
  });
}, /execution alignment failed/);

var irPath = path.join(tmp, 'playable-scene-ir.json');
writePlayableSceneIr(irPath, ir);
assert.strictEqual(loadPlayableSceneIr(irPath).semanticHash, ir.semanticHash);

var injected = injectPlayableSceneIr('<html><head></head><body></body></html>', ir);
assert.ok(injected.indexOf('window.__BLUEPRINT_PLAYABLE_SCENE_IR__') >= 0);
assert.ok(injected.indexOf('</head>') > injected.indexOf('__BLUEPRINT_PLAYABLE_SCENE_IR__'));

console.log('playable scene IR tests passed');
