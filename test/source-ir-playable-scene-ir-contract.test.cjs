#!/usr/bin/env node
'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');

var {
  extractVisualAssetManifest,
} = require('../adapters/source-ir/visual-assets.js');
var {
  buildBlueprintContext,
  writeBlueprintArtifacts,
} = require('../adapters/source-ir/blueprint-project.js');
var {
  buildPlayableSceneIrFromHtml,
} = require('../engine/playable-scene-ir.cjs');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-ir-contract-'));
var htmlPath = path.join(tmp, 'source.html');
var html = [
  '<!doctype html><html><body><script>',
  'const SCENE_CONFIG = { backgroundColor:"#101820", ground:{kind:"box", width:10, height:0.2, color:"#203040"} };',
  'const ENTITY_STYLE = { Player:{label:"Player",kind:"hero",color:"#66ccff"}, WaterDrop:{label:"Water",kind:"resource",color:"#33aaff"}, CtaButton:{label:"Install",kind:"cta",color:"#22cc88"} };',
  'const ENTITY_POSITIONS = { Player:{x:0,y:0,z:0}, WaterDrop:{x:2,y:0,z:0}, CtaButton:{x:5,y:0,z:0} };',
  'const PHASES = [',
  '  { id:"phase1", guideText:"Collect water", showEntities:["Player","WaterDrop"], trigger:{type:"resource_collected",resource:"Water",amount:1} },',
  '  { id:"phase2", guideText:"Install", showEntities:["Player","CtaButton"], trigger:{type:"click_entity",entity:"CtaButton"} }',
  '];',
  '</script></body></html>',
].join('\n');
fs.writeFileSync(htmlPath, html);

var entityNames = ['Player', 'WaterDrop', 'CtaButton'];
var assetManifest = extractVisualAssetManifest(html, {
  source: htmlPath,
  project: 'source-ir-contract',
  entityNames: entityNames,
});
var playableSceneIr = buildPlayableSceneIrFromHtml(htmlPath, {
  html: html,
  project: 'source-ir-contract',
  entityNames: entityNames,
  assetManifest: assetManifest,
});
assetManifest.source = playableSceneIr.source.htmlPath;
assetManifest.sourceHtmlPath = playableSceneIr.source.htmlPath;
assetManifest.sourceHtmlSha256 = playableSceneIr.source.htmlSha256;
assetManifest.playableSceneIrHash = playableSceneIr.semanticHash;

var gameSchema = {
  gameConfig: { cameraBackground: [0, 0, 0], groundColor: [0, 0, 0], moveSpeed: 5, collectRange: 2, maxCarry: 10 },
  entities: [
    { name: 'Player', chineseName: 'Player', pool: '__Pool_Cube_White_01', initPos: [0, 0, 0], scale: 1 },
    { name: 'WaterDrop', chineseName: 'Water', pool: '__Pool_Cube_Cyan_01', initPos: [2, 0, 0], scale: 1 },
    { name: 'CtaButton', chineseName: 'Install', pool: '__Pool_Cube_Green_01', initPos: [5, 0, 0], scale: 1 },
  ],
  resources: [{ name: 'Water', entity: 'WaterDrop', convertRatio: 1 }],
  phases: [
    { phaseId: 'phase1', showEntities: ['Player', 'WaterDrop'], guideText: 'Collect water', steps: [{ index: 0, target: 'WaterDrop', label: 'Water', gain: 'Water', amount: 1 }], trigger: { type: 'resource_collected', resource: 'Water', amount: 1 } },
    { phaseId: 'phase2', showEntities: ['Player', 'CtaButton'], guideText: 'Install', steps: [{ index: 0, target: 'CtaButton', label: 'Install' }], trigger: { type: 'click_entity', entity: 'CtaButton' } },
  ],
};

function fixturePlans() {
  return {
    validation: { ok: true, errors: [] },
    assemblyPlan: { phaseBindings: [], moduleInstances: [] },
    cuaPlan: { steps: [] },
  };
}

var built = buildBlueprintContext(gameSchema, {
  projectName: 'source-ir-contract',
  source: path.join(tmp, 'gameschema.json'),
  assetManifest: assetManifest,
  playableSceneIr: playableSceneIr,
  requireAssetManifestHash: true,
  buildProjectPlans: fixturePlans,
});

assert.strictEqual(built.project.sourceHtmlPath, htmlPath);
assert.strictEqual(built.project.sourceHtmlSha256, playableSceneIr.source.htmlSha256);
assert.strictEqual(built.project.playableSceneIrHash, playableSceneIr.semanticHash);
assert.strictEqual(built.blueprint.sourceHtmlPath, htmlPath);
assert.strictEqual(built.blueprint.visualAssets.sourceHtmlSha256, playableSceneIr.source.htmlSha256);
assert.strictEqual(built.blueprint.playableSceneIr.semanticHash, playableSceneIr.semanticHash);

var oldProofGate = process.env.BLUEPRINT_PROOF_CONTRACT_GATE;
process.env.BLUEPRINT_PROOF_CONTRACT_GATE = '0';
var outDir = path.join(tmp, 'blueprint-smoke');
writeBlueprintArtifacts(outDir, built.project, built.blueprint);
if (oldProofGate == null) delete process.env.BLUEPRINT_PROOF_CONTRACT_GATE;
else process.env.BLUEPRINT_PROOF_CONTRACT_GATE = oldProofGate;

assert.strictEqual(
  JSON.parse(fs.readFileSync(path.join(outDir, 'playable-scene-ir.json'), 'utf8')).semanticHash,
  playableSceneIr.semanticHash
);
assert.strictEqual(
  JSON.parse(fs.readFileSync(path.join(outDir, 'blueprint-project.json'), 'utf8')).playableSceneIrHash,
  playableSceneIr.semanticHash
);

var badManifest = clone(assetManifest);
badManifest.sourceHtmlSha256 = '0'.repeat(64);
assert.throws(function() {
  buildBlueprintContext(gameSchema, {
    projectName: 'source-ir-contract-bad',
    assetManifest: badManifest,
    playableSceneIr: playableSceneIr,
    requireAssetManifestHash: true,
    buildProjectPlans: fixturePlans,
  });
}, /playableSceneIR binding failed/);

console.log('source-ir playable scene IR contract tests passed');
