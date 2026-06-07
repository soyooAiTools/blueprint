'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var spawnSync = require('child_process').spawnSync;
var storyboard2html = require('../engine/storyboard2html-contract.cjs');
var hardgate = require('../engine/storyboard2html-hardgate.cjs');
var sourceSceneIr = require('../engine/source-scene-ir.cjs');
var sourceIrCompiler = require('../adapters/source-ir/index.js');

var contract = storyboard2html.loadContract();
assert.strictEqual(storyboard2html.validateContract(contract), true);
assert.strictEqual(contract.schemaVersion, '1.0.0');
assert.strictEqual(contract.kind, 'blueprint.storyboard2html.htmlContract');
assert.strictEqual(contract.sourceOfTruth.sourceSceneIr, 'contracts/source-scene-ir.v1.json');
assert.ok(contract.htmlStaticEntry.requiredGlobals.some(function(entry) { return entry.name === 'window.__BP_SOURCE_IR__'; }));
assert.ok(contract.htmlStaticEntry.requiredGlobals.some(function(entry) { return entry.name === 'window.__BP_SOURCE_IR_HASH__'; }));
assert.ok(contract.htmlStaticEntry.requiredGlobals.some(function(entry) { return entry.name === 'PHASES'; }));
assert.ok(contract.htmlStaticEntry.requiredGlobals.some(function(entry) { return entry.name === 'setTip'; }));
assert.strictEqual(contract.runtimeStateContract.globalName, 'window.__gameState');
assert.ok(contract.runtimeStateContract.requiredTopLevelKeys.indexOf('phaseEvidence') >= 0);
assert.strictEqual(contract.phaseEvidenceEnvelope.requiredModuleMeta['_meta.schemaVersion'], '1.0.0');
assert.strictEqual(contract.phaseEvidenceEnvelope.requiredModuleMeta['_meta.sourcePlatform'], 'html');
assert.ok(contract.versionPolicy.schemaVersion);
assert.ok(contract.versionPolicy.contractVersion);
assert.strictEqual(contract.runtimeStateContract.aliases.policy.indexOf('snake_case keys are hard-required') >= 0, true);
assert.ok(contract.phaseEvidenceEnvelope.flatSignals.indexOf('guide_text_visible') >= 0);

var blueprint = {
  projectName: 'FarmStoryboard',
  storyboard: {
    frames: [
      { title: 'Collect corn', interaction: 'collect:Corn:1', ui: 'Collect corn', camera: 'follow player' },
      { title: 'Sell', interaction: 'click:CtaButton', ui: 'Sell crop' },
    ],
  },
  entities: [
    { name: 'Player', label: 'Player', template: 'PlayerController' },
    { name: 'Corn', label: 'Corn', template: 'Collectible' },
  ],
  resources: [
    { name: 'Corn', entity: 'Corn' },
  ],
  specs: [
    {
      phaseId: 'phase1',
      phaseName: 'Collect corn',
      requiredInteractions: ['collect:Corn:1'],
      playerInstruction: 'Collect corn',
      plannedModuleIds: ['guide_ui', 'collect_on_near', 'inventory_wallet'],
      trigger: { type: 'resource_collected', resource: 'Corn', amount: 1 },
      entitiesRequired: [{ name: 'Corn', resource: 'Corn' }],
      duration: { min: 10, max: 12 },
    },
    {
      phaseId: 'phase2',
      phaseName: 'Sell',
      requiredInteractions: ['click:CtaButton'],
      playerInstruction: 'Sell crop',
      plannedModuleIds: ['guide_ui', 'click_trigger', 'player_input_tap', 'cta_finish'],
      trigger: { type: 'click_entity', entity: 'CtaButton' },
      entitiesRequired: [],
    },
  ],
};

var bundle = storyboard2html.buildStoryboard2HtmlInput(blueprint, {
  htmlPath: '/tmp/generated.html',
  outDir: '/tmp/storyboard2html-out',
  steps: 12,
});
assert.strictEqual(bundle.kind, 'blueprint.storyboard2html.input');
assert.strictEqual(bundle.projectName, 'FarmStoryboard');
assert.strictEqual(bundle.themeHint, 'farming');
assert.strictEqual(bundle.specs.length, 2);
assert.strictEqual(bundle.storyboardFrames.length, 2);
assert.strictEqual(bundle.specs[0].phaseId, 'phase1');
assert.strictEqual(bundle.specs[0].requiredInteractions[0], 'collect:Corn:1');
assert.deepStrictEqual(bundle.specs[0].plannedModuleIds, ['guide_ui', 'collect_on_near', 'inventory_wallet']);
assert.strictEqual(bundle.specs[0].trigger.type, 'resource_collected');
assert.strictEqual(bundle.storyboardFrames[0].title, 'Collect corn');
assert.strictEqual(bundle.htmlContract.kind, contract.kind);
assert.ok(bundle.acceptancePlan.command.join(' ').indexOf('/root/.claude/skills/demo2spec/index.js') >= 0);
assert.ok(bundle.acceptancePlan.command.indexOf('--blueprint-smoke') >= 0);
assert.ok(bundle.acceptancePlan.command.indexOf('--verify') >= 0);
assert.strictEqual(bundle.acceptancePlan.verifyRunner, 'production');
assert.ok(bundle.acceptancePlan.command.indexOf('--verify-runner') >= 0);
assert.ok(bundle.acceptancePlan.command.indexOf('production') >= 0);
assert.ok(bundle.acceptancePlan.hardgateCommand.indexOf('--summary') >= 0);
assert.strictEqual(bundle.acceptancePlan.artifacts.verifySummary, '/tmp/storyboard2html-out/blueprint-smoke/unity-verify-summary.json');
assert.strictEqual(bundle.acceptancePlan.artifacts.flowManifest, '/tmp/storyboard2html-out/playable-flow-manifest.json');
assert.strictEqual(bundle.acceptancePlan.artifacts.preflightReport, '/tmp/storyboard2html-out/storyboard2html-preflight.json');
assert.strictEqual(bundle.acceptancePlan.artifacts.sourceSceneIrPreflightReport, '/tmp/storyboard2html-out/source-ir-report.json');
assert.strictEqual(bundle.acceptancePlan.artifacts.playableSceneIr, '/tmp/storyboard2html-out/playable-scene-ir.json');
assert.ok(bundle.acceptancePlan.sourceIrPreflightCommand.join(' ').indexOf('source-scene-ir-preflight.cjs') >= 0);
assert.ok(bundle.acceptancePlan.hardGates.some(function(gate) {
  return gate.indexOf('manual joystick flow') >= 0;
}));
assert.ok(bundle.acceptancePlan.hardGates.some(function(gate) {
  return gate.indexOf('source-scene-ir preflight') >= 0;
}));
assert.strictEqual(storyboard2html.buildAcceptancePlan({ verifyRunner: 'direct' }).verifyRunner, 'direct');
assert.throws(function() {
  storyboard2html.buildAcceptancePlan({ verifyRunner: 'bogus' });
}, /expected direct\|production/);

assert.throws(function() {
  storyboard2html.buildStoryboard2HtmlInput({ projectName: 'NoSpecs' });
}, /requires ctx\.blueprint\.specs/);

var normalizedPhaseBundle = storyboard2html.buildStoryboard2HtmlInput({
  projectName: 'NormalizedPdfBlueprint',
  storyboardFrames: [{ title: 'Collect', guide: 'Collect resources' }],
  entities: [{ name: 'Player' }, { name: 'ResourcePile' }, { name: 'CTAButton' }],
  phases: [
    { id: 1, name: '收集资源', activate: ['Player', 'ResourcePile'], endCondition: 'global:gold>=50', guide: '拖摇杆收集资源' },
    { id: 2, name: '下载引导', activate: ['CTAButton'], endCondition: 'none', guide: '点击下载' },
  ],
}, {
  htmlPath: '/tmp/generated.html',
  outDir: '/tmp/storyboard2html-out',
});
assert.strictEqual(normalizedPhaseBundle.specs.length, 2);
assert.strictEqual(normalizedPhaseBundle.specs[0].phaseId, 'phase1');
assert.ok(normalizedPhaseBundle.specs[0].plannedModuleIds.indexOf('player_input_joystick') >= 0);
assert.ok(normalizedPhaseBundle.specs[0].plannedModuleIds.indexOf('move_to_target') >= 0);
assert.ok(normalizedPhaseBundle.specs[0].plannedModuleIds.indexOf('proximity_trigger') >= 0);
assert.strictEqual(normalizedPhaseBundle.specs[1].trigger.type, 'click_entity');
assert.strictEqual(normalizedPhaseBundle.resources[0].name, 'Gold');

var tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard2html-contract-'));
var blueprintPath = path.join(tempDir, 'blueprint.json');
var bundlePath = path.join(tempDir, 'storyboard2html-input.json');
fs.writeFileSync(blueprintPath, JSON.stringify(blueprint, null, 2));
var inputResult = spawnSync(process.execPath, [
  path.join(__dirname, '..', 'scripts', 'storyboard2html-input.cjs'),
  blueprintPath,
  bundlePath,
  '--theme',
  'tower-defense',
  '--steps',
  '9',
], { encoding: 'utf8', cwd: path.join(__dirname, '..') });
assert.strictEqual(inputResult.status, 0, inputResult.stderr || inputResult.stdout);
var cliBundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
assert.strictEqual(cliBundle.themeHint, 'tower-defense');
assert.strictEqual(cliBundle.acceptancePlan.command[cliBundle.acceptancePlan.command.length - 1], '9');

var smokeResult = spawnSync(process.execPath, [
  path.join(__dirname, '..', 'scripts', 'storyboard2html-smoke.cjs'),
  '/tmp/generated.html',
  '/tmp/storyboard2html-out',
  '--theme',
  'farming',
  '--steps',
  '7',
  '--dry-run',
], { encoding: 'utf8', cwd: path.join(__dirname, '..') });
assert.strictEqual(smokeResult.status, 0, smokeResult.stderr || smokeResult.stdout);
assert.ok(smokeResult.stdout.indexOf('source-scene-ir-preflight.cjs') >= 0);
assert.ok(smokeResult.stdout.indexOf('/root/.claude/skills/demo2spec/index.js') >= 0);
assert.ok(smokeResult.stdout.indexOf('--blueprint-smoke') >= 0);
assert.ok(smokeResult.stdout.indexOf('--verify-runner') >= 0);
assert.ok(smokeResult.stdout.indexOf('production') >= 0);
assert.ok(smokeResult.stdout.indexOf('storyboard2html-hardgate.cjs') >= 0);
assert.ok(smokeResult.stdout.indexOf('hardGates=') >= 0);

var badHtmlPath = path.join(tempDir, 'bad-generated.html');
var badSmokeOut = path.join(tempDir, 'bad-smoke');
fs.writeFileSync(badHtmlPath, [
  '<!doctype html><html><body><script>',
  'const PHASES=[{id:"phase1",showEntities:["Player","Corn"]},{id:"phase2",showEntities:["Player","CtaButton"]}];',
  'setTimeout(function(){ window.phaseIndex=1; }, 800);',
  'window.__gameState=function(){return{phase:"phase1",phaseRealTimer:1,entity_states:{},phaseEvidence:{}}};',
  '</script></body></html>',
].join('\n'));
var badSmokeResult = spawnSync(process.execPath, [
  path.join(__dirname, '..', 'scripts', 'storyboard2html-smoke.cjs'),
  badHtmlPath,
  badSmokeOut,
  '--theme',
  'farming',
], { encoding: 'utf8', cwd: path.join(__dirname, '..') });
assert.strictEqual(badSmokeResult.status, 1, badSmokeResult.stderr || badSmokeResult.stdout);
assert.ok(badSmokeResult.stderr.indexOf('preflight failed before CUA') >= 0);
assert.ok(fs.existsSync(path.join(badSmokeOut, 'source-ir-report.json')));
assert.ok(fs.existsSync(path.join(badSmokeOut, 'playable-flow-manifest.json')));
var badSourceIrPreflight = JSON.parse(fs.readFileSync(path.join(badSmokeOut, 'source-ir-report.json'), 'utf8'));
assert.strictEqual(badSourceIrPreflight.passed, false);
assert.strictEqual(badSourceIrPreflight.summary.legacyProjectionUsed, true);
assert.ok(badSourceIrPreflight.violations.some(function(violation) { return violation.code === 'source_ir_embedded_missing'; }));

function buildHardgateSourceIr() {
  return sourceSceneIr.normalizeSourceSceneIr({
    schemaVersion: sourceSceneIr.SOURCE_SCENE_IR_SCHEMA_VERSION,
    project: { name: 'storyboard2html-contract-fixture', theme: 'farming' },
    scene: {
      backgroundColor: '#101820',
      camera: { position: [0, 8, 12], lookAt: [0, 0, 0], fov: 55 },
      ground: { kind: 'plane', size: [20, 20], color: '#203040' },
    },
    entities: [
      { id: 'Player', label: 'Player', kind: 'player', position: [0, 0, 0], visual: { color: '#66ccff' } },
      { id: 'Corn', label: 'Corn', kind: 'resource', position: [1, 0, 0], visual: { color: '#ffcc33' } },
      { id: 'CtaButton', label: 'Install', kind: 'cta', position: [3, 0, 0], visual: { color: '#22cc88' } },
    ],
    resources: [{ id: 'Corn', label: 'Corn', carrierEntity: 'Corn', kind: 'resource', initial: 0 }],
    phases: [
      {
        id: 'phase1',
        title: 'Collect corn',
        guideText: 'Collect corn',
        showEntities: ['Player', 'Corn'],
        plannedModuleIds: ['player_input_joystick', 'move_to_target', 'proximity_trigger'],
        steps: [{ kind: 'move_to', target: 'Corn', radius: 1.8 }],
        gate: { kind: 'near_entity', entity: 'Corn', radius: 1.8 },
      },
      {
        id: 'phase2',
        title: 'Install',
        guideText: 'Install',
        showEntities: ['Player', 'CtaButton'],
        plannedModuleIds: ['player_input_joystick', 'move_to_target', 'proximity_trigger', 'cta_finish'],
        steps: [{ kind: 'cta_finish', entity: 'CtaButton' }],
        gate: { kind: 'cta_arrival', entity: 'CtaButton', radius: 1.8 },
      },
    ],
    hud: { tip: { source: 'phase.guideText' }, resourceBar: ['Corn'], cta: { entity: 'CtaButton', arrivalGated: true } },
    runtimeContract: { requiresJoystick: true, requiresArrivalGate: true, forbidAutoplayProgress: true },
  }, {
    html: '<div id="joystick"></div>',
    generatedAt: '2026-06-07T00:00:00.000Z',
  });
}

function buildHardgateHtml(ir) {
  var projection = sourceSceneIr.projectSourceSceneIrToLegacy(ir);
  return [
    '<!doctype html><html><head><style>#joystick{position:fixed;left:0;top:0}</style></head><body><canvas id="stage"></canvas><div id="joystick"><div id="joystick-knob"></div></div><script>',
    'window.__BP_SOURCE_IR__=' + JSON.stringify(ir) + ';',
    'window.__BP_SOURCE_IR_HASH__="' + ir.semanticHash + '";',
    'const PHASES=' + JSON.stringify(projection.PHASES) + ';',
    'const ENTITY_STYLE=' + JSON.stringify(projection.ENTITY_STYLE) + ';',
    'const ENTITY_POSITIONS=' + JSON.stringify(projection.ENTITY_POSITIONS) + ';',
    'const SCENE_CONFIG=' + JSON.stringify(projection.SCENE_CONFIG) + ';',
    'var scene = new THREE.Scene(), renderer = new THREE.WebGLRenderer({canvas:document.getElementById("stage")});',
    'var sceneModels={Player:new THREE.BoxGeometry(1,1,1),Corn:new THREE.SphereGeometry(1),Stand:new THREE.CylinderGeometry(1,1,1)};',
    'var joystick=document.getElementById("joystick"), player={position:{x:0,y:0,z:0}}, target={position:{x:1,y:0,z:0}};',
    'function showJoystickAt(ev){ joystick.style.left=ev.clientX+"px"; joystick.style.top=ev.clientY+"px"; }',
    'document.addEventListener("pointerdown",function(ev){ showJoystickAt(ev); player.position.x += 1; });',
    'document.addEventListener("pointermove",function(){ player.position.x += 1; });',
    'document.addEventListener("pointerup",function(){ var recordedDistance = 0.5; var phaseEvidence = { player_input_joystick:{registered:true}, move_to_target:{target:"Corn",arrived:true}, proximity_trigger:{target:"Corn",recordedDistance:recordedDistance} }; });',
    'document.addEventListener("pointercancel",function(){ player.position.x = player.position.x; });',
    'function maybeArrive(){ var recordedDistance = Math.abs(player.position.x-target.position.x); if(recordedDistance < 1.8){ window.phase="phase2"; } }',
    'window.__gameState=function(){return{phase:"phase1",phaseRealTimer:1,entity_states:{},phaseEvidence:{}}};',
    '</script></body></html>',
  ].join('\n');
}

var snapshotDoc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'contracts', 'snapshot-schema.v1.json'), 'utf8'));
snapshotDoc = JSON.parse(JSON.stringify(snapshotDoc));
snapshotDoc.project = { phases: [{ phaseId: 'phase1' }, { phaseId: 'phase2' }] };
var verifyReport = {
  phaseCoverage: '2/2',
  phaseEvidenceSummary: {
    enabled: true,
    aggregate: {
      triggeredPresentFullRate: 1,
      triggeredAntiAutoplayHeldRate: 1,
    },
    validation: { passed: true, violations: [] },
  },
};
var snapshotPath = path.join(tempDir, 'snapshot-schema.json');
var reportPath = path.join(tempDir, 'verify-report.json');
var summaryPath = path.join(tempDir, 'verify-summary.json');
var htmlPath = path.join(tempDir, 'generated.html');
var hardgateSourceIr = buildHardgateSourceIr();
var hardgateHtml = buildHardgateHtml(hardgateSourceIr);
fs.writeFileSync(htmlPath, hardgateHtml);
var sourceIrArtifacts = sourceIrCompiler.buildSourceIrArtifacts(htmlPath, tempDir, {
  projectName: 'storyboard2html-contract-fixture',
  noBlueprint: true,
  generatedAt: '2026-06-07T00:00:00.000Z',
});
var sourceIrReport = sourceSceneIr.preflightSourceSceneIrHtml(hardgateHtml, { sourceHtmlPath: htmlPath });
assert.strictEqual(sourceIrReport.passed, true);
fs.writeFileSync(path.join(tempDir, 'source-ir-report.json'), JSON.stringify(sourceIrReport, null, 2));
fs.writeFileSync(path.join(tempDir, 'semantic-source.json'), JSON.stringify({
  semanticSource: 'source-scene-ir',
  legacyJsInferenceUsed: false,
  sourceIrPresent: true,
  sourceIrPreflightPassed: true,
  sourceSceneIrHash: sourceIrArtifacts.sourceIr.semanticHash,
  playableSceneIrHash: sourceIrArtifacts.playableSceneIr.semanticHash,
}, null, 2));
fs.writeFileSync(path.join(tempDir, 'build-result.json'), JSON.stringify({
  ok: true,
  sourceBinding: {
    sourceHtmlPath: sourceIrArtifacts.sourceIr.source.htmlPath,
    sourceHtmlSha256: sourceIrArtifacts.sourceIr.source.htmlSha256,
    playableSceneIrHash: sourceIrArtifacts.playableSceneIr.semanticHash,
  },
}, null, 2));
snapshotDoc = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
fs.writeFileSync(reportPath, JSON.stringify(verifyReport, null, 2));
fs.writeFileSync(summaryPath, JSON.stringify({
  runner: 'production',
  passed: true,
  telemetry: {
    schemaVersion: 'blueprint-cua-telemetry.v1',
    taskId: 'storyboard2html-contract-fixture',
    runner: 'playableagent',
    phaseCount: 2,
    observeMs: 1200,
    manualProbeMs: 300,
    manualFlowMs: 450,
    totalMs: 2100,
  },
  runtimeContractSummary: {
    passed: true,
    contractPassed: true,
    telemetry: {
      schemaVersion: 'blueprint-cua-telemetry.v1',
      taskId: 'storyboard2html-contract-fixture',
      runner: 'playableagent',
      phaseCount: 2,
      observeMs: 1200,
      manualProbeMs: 300,
      manualFlowMs: 450,
      totalMs: 2100,
    },
    manualJoystickProbeRequired: true,
    manualJoystickFlowProbeRequired: true,
    manualJoystickProbePassed: true,
    manualJoystickFlowProbePassed: true,
    manualJoystickFlowProbe: {
      passed: true,
      skipped: false,
      completedAfter: 2,
      targetCompleted: 2,
      phasePath: ['phase1', 'phase2'],
      missingPhasePath: [],
      phasePathSource: 'phase-witness',
      driver: 'autonav-joystick',
      maxPlayerDistance: 1.25,
    },
  },
}, null, 2));
var hardgateResult = hardgate.evaluateHardGates({
  snapshotSchemaPath: snapshotPath,
  verifyReportPath: reportPath,
  verifySummaryPath: summaryPath,
  htmlPath: htmlPath,
});
assert.strictEqual(hardgateResult.passed, true);
assert.ok(hardgateResult.gates.some(function(gate) { return gate.id === 'html-interaction-hard-gates'; }));
assert.ok(hardgateResult.gates.some(function(gate) { return gate.id === 'production-runtime-cua-hard-gates' && gate.passed === true; }));
var htmlHardgate = hardgateResult.gates.find(function(gate) { return gate.id === 'html-interaction-hard-gates'; });
assert.strictEqual(htmlHardgate.details.hasJoystickControl, true);
assert.strictEqual(htmlHardgate.details.nonFinalClickEntityCount, 0);
assert.strictEqual(htmlHardgate.details.nonFinalMissingJoystickEvidenceCount, 0);
assert.deepStrictEqual(hardgate.parseCoveragePair('10/10'), { covered: 10, total: 10 });

var noProjectSnapshotPath = path.join(tempDir, 'snapshot-schema-no-project.json');
var noProjectSnapshotDoc = JSON.parse(JSON.stringify(snapshotDoc));
delete noProjectSnapshotDoc.project;
fs.writeFileSync(noProjectSnapshotPath, JSON.stringify(noProjectSnapshotDoc, null, 2));
var reportBackfilledHardgate = hardgate.evaluateHardGates({
  snapshotSchemaPath: noProjectSnapshotPath,
  verifyReportPath: reportPath,
  verifySummaryPath: summaryPath,
  htmlPath: htmlPath,
});
assert.strictEqual(reportBackfilledHardgate.passed, true);

var directSummaryPath = path.join(tempDir, 'direct-summary.json');
fs.writeFileSync(directSummaryPath, JSON.stringify({
  passed: true,
  phaseCoverage: '2/2',
  phaseEvidenceSummary: verifyReport.phaseEvidenceSummary,
}, null, 2));
var directSummaryGate = hardgate.evaluateHardGates({
  snapshotSchemaPath: snapshotPath,
  verifyReportPath: reportPath,
  verifySummaryPath: directSummaryPath,
  htmlPath: htmlPath,
});
assert.strictEqual(directSummaryGate.passed, false);
assert.ok(directSummaryGate.gates.some(function(gate) {
  return gate.id === 'production-runtime-cua-hard-gates' &&
    gate.errors.some(function(error) { return error.indexOf('runner must be production') >= 0; });
}));

var autoplayHtml = [
  '<!doctype html><html><body><script>',
  'const PHASES=[{id:"phase1",showEntities:["Player","Corn"]},{id:"phase2",showEntities:["Player","CtaButton"]}];',
  'function enterPhase1(){ setTimeout(function(){ enterPhase(1); }, 800); }',
  'function enterPhase(i){ window.phaseIndex=i; }',
  'window.__gameState=function(){return{phase:"phase1",phaseRealTimer:1,entity_states:{},phaseEvidence:{}}};',
  '</script></body></html>',
].join('\n');
var htmlGate = hardgate.validateHtmlInteractionContract(autoplayHtml, { expectedPhaseCount: 2 });
assert.strictEqual(htmlGate.passed, false);
assert.ok(htmlGate.errors.some(function(error) { return error.indexOf('setTimeout') >= 0 || error.indexOf('input listener') >= 0; }));

var aliasedJoystickHtml = htmlPath + '.alias.html';
fs.writeFileSync(aliasedJoystickHtml, [
  '<!doctype html><html><head><style>#joystick{position:fixed;left:0;top:0}</style></head><body><canvas id="stage"></canvas><div id="joystick"><div></div></div><script>',
  'const PHASES=[{id:"phase1",showEntities:["Player","Corn"],trigger:{type:"near_entity",entity:"Corn",range:1.8},plannedModuleIds:["player_input_joystick","move_to_target","proximity_trigger"]},{id:"phase2",showEntities:["Player","CtaButton"],trigger:{type:"near_entity",entity:"CtaButton",range:1.8},plannedModuleIds:["player_input_joystick","move_to_target","proximity_trigger","cta_finish"]}];',
  'var scene = new THREE.Scene(), renderer = new THREE.WebGLRenderer({canvas:document.getElementById("stage")});',
  'var sceneModels={Player:new THREE.BoxGeometry(1,1,1),Corn:new THREE.SphereGeometry(1),Stand:new THREE.CylinderGeometry(1,1,1)};',
  'var joy=document.getElementById("joystick"), player={position:{x:0,y:0,z:0}}, target={position:{x:1,y:0,z:0}};',
  'document.addEventListener("pointerdown",function(ev){ joy.style.left=ev.clientX+"px"; joy.style.top=ev.clientY+"px"; });',
  'document.addEventListener("pointermove",function(){ player.position.x += 1; });',
  'document.addEventListener("pointerup",function(){ var recordedDistance = 0.5; var phaseEvidence = { player_input_joystick:{registered:true}, move_to_target:{target:"Corn",arrived:true}, proximity_trigger:{target:"Corn",recordedDistance:recordedDistance} }; });',
  'document.addEventListener("pointercancel",function(){ player.position.x = player.position.x; });',
  'function maybeArrive(){ var recordedDistance = Math.abs(player.position.x-target.position.x); if(recordedDistance < 1.8){ window.phase="phase2"; } }',
  'window.__gameState=function(){return{phase:"phase1",phaseRealTimer:1,entity_states:{},phaseEvidence:{}}};',
  '</script></body></html>',
].join('\n'));
var aliasedJoystickGate = hardgate.validateHtmlInteractionContract(fs.readFileSync(aliasedJoystickHtml, 'utf8'), { expectedPhaseCount: 2 });
assert.strictEqual(aliasedJoystickGate.hasJoystickControl, true);

var namedJoystickHtml = [
  '<!doctype html><html><head><style>#joystick{position:fixed;left:0;top:0}</style></head><body><canvas id="stage"></canvas><div id="joystick"><div></div></div><script>',
  'const PHASES=[{id:"phase1",showEntities:["Player","Corn"],trigger:{type:"near_entity",entity:"Corn",range:1.8},plannedModuleIds:["player_input_joystick","move_to_target","proximity_trigger"]},{id:"phase2",showEntities:["Player","CtaButton"],trigger:{type:"near_entity",entity:"CtaButton",range:1.8},plannedModuleIds:["player_input_joystick","move_to_target","proximity_trigger","cta_finish"]}];',
  'var scene = new THREE.Scene(), renderer = new THREE.WebGLRenderer({canvas:document.getElementById("stage")});',
  'var sceneModels={Player:new THREE.BoxGeometry(1,1,1),Corn:new THREE.SphereGeometry(1),Stand:new THREE.CylinderGeometry(1,1,1)};',
  'var joy=document.getElementById("joystick"), player={position:{x:0,y:0,z:0}}, target={position:{x:1,y:0,z:0}};',
  'function onPointerDown(ev){ joy.style.left=ev.clientX+"px"; joy.style.top=ev.clientY+"px"; }',
  'document.addEventListener("pointerdown", onPointerDown);',
  'document.addEventListener("pointermove",function(){ player.position.x += 1; });',
  'document.addEventListener("pointerup",function(){ var recordedDistance = 0.5; var phaseEvidence = { player_input_joystick:{registered:true}, move_to_target:{target:"Corn",arrived:true}, proximity_trigger:{target:"Corn",recordedDistance:recordedDistance} }; });',
  'document.addEventListener("pointercancel",function(){ player.position.x = player.position.x; });',
  'function advancePhase(){ window.phase="phase2"; }',
  'function maybeArrive(){ var recordedDistance = Math.abs(player.position.x-target.position.x); if(recordedDistance < 1.8){ advancePhase(); } }',
  'window.__gameState=function(){return{phase:"phase1",phaseRealTimer:1,entity_states:{},phaseEvidence:{}}};',
  '</script></body></html>',
].join('\n');
var namedJoystickGate = hardgate.validateHtmlInteractionContract(namedJoystickHtml, { expectedPhaseCount: 2 });
assert.strictEqual(namedJoystickGate.passed, true);

var gatedCtaJoystickHtml = namedJoystickHtml.replace(
  '</script></body></html>',
  [
    '<button id="ctaDomButton">下载</button>',
    '<script>',
    'function distTo(){ return 1.2; }',
    'document.getElementById("ctaDomButton").addEventListener("click",function(ev){ if(distTo("CtaButton")>=2.2)return; var pe={}; pe.cta_finish={target:"CtaButton",final_phase:true}; completePhase2(); });',
    'function completePhase2(){ window.phase="gameEnd"; }',
    '</script></body></html>',
  ].join('')
);
var gatedCtaJoystickGate = hardgate.validateHtmlInteractionContract(gatedCtaJoystickHtml, { expectedPhaseCount: 2 });
assert.strictEqual(gatedCtaJoystickGate.passed, true);

var ungatedCtaHtml = namedJoystickHtml.replace(
  '</script></body></html>',
  [
    '<button id="ctaDomButton">下载</button>',
    '<script>',
    'document.getElementById("ctaDomButton").addEventListener("click",function(){ var pe={}; pe.cta_finish={target:"CtaButton",final_phase:true}; completePhase2(); });',
    'function completePhase2(){ window.phase="gameEnd"; }',
    '</script></body></html>',
  ].join('')
);
var ungatedCtaGate = hardgate.validateHtmlInteractionContract(ungatedCtaHtml, { expectedPhaseCount: 2 });
assert.strictEqual(ungatedCtaGate.passed, false);
assert.ok(ungatedCtaGate.errors.some(function(error) { return error.indexOf('CtaButton click handlers') >= 0; }));

var directClickHtml = [
  '<!doctype html><html><head><style>#joystick{position:fixed}</style></head><body><canvas id="stage"></canvas><button id="actionBtn">执行当前操作</button><div id="joystick"></div><script>',
  'const PHASES=[{id:"phase1",showEntities:["Player","Corn"],trigger:{type:"click_entity",entity:"Corn"},plannedModuleIds:["player_input_tap"]},{id:"phase2",showEntities:["Player","CtaButton"],trigger:{type:"click_entity",entity:"CtaButton"},plannedModuleIds:["cta_finish"]}];',
  'var sceneModels={Player:new THREE.BoxGeometry(1,1,1),Corn:new THREE.SphereGeometry(1),Stand:new THREE.CylinderGeometry(1,1,1)};',
  'document.getElementById("stage").addEventListener("pointerdown",function(){ completePhase1(); });',
  'function completePhase1(){ window.phase="phase2"; }',
  'window.__gameState=function(){return{phase:"phase1",phaseRealTimer:1,entity_states:{},phaseEvidence:{}}};',
  '</script></body></html>',
].join('\n');
var directClickGate = hardgate.validateHtmlInteractionContract(directClickHtml, { expectedPhaseCount: 2 });
assert.strictEqual(directClickGate.passed, false);
assert.ok(directClickGate.errors.some(function(error) {
  return error.indexOf('floating/global joystick') >= 0 || error.indexOf('direct click') >= 0 || error.indexOf('actionBtn') >= 0;
}));
assert.ok(directClickGate.errors.some(function(error) { return error.indexOf('click_entity') >= 0; }));
assert.ok(directClickGate.errors.some(function(error) { return error.indexOf('player_input_joystick') >= 0; }));

verifyReport.phaseEvidenceSummary.aggregate.triggeredPresentFullRate = 0.5;
fs.writeFileSync(reportPath, JSON.stringify(verifyReport, null, 2));
var failedHardgate = hardgate.evaluateHardGates({
  snapshotSchemaPath: snapshotPath,
  verifyReportPath: reportPath,
  verifySummaryPath: summaryPath,
});
assert.strictEqual(failedHardgate.passed, false);

var manifestPath = path.join(tempDir, 'playable-flow-manifest.json');
var hardgateCliResult = spawnSync(process.execPath, [
  path.join(__dirname, '..', 'scripts', 'storyboard2html-hardgate.cjs'),
  '--snapshot',
  snapshotPath,
  '--report',
  reportPath,
  '--summary',
  summaryPath,
  '--html',
  htmlPath,
  '--manifest',
  manifestPath,
], { encoding: 'utf8', cwd: path.join(__dirname, '..') });
assert.strictEqual(hardgateCliResult.status, 1, hardgateCliResult.stderr || hardgateCliResult.stdout);
assert.ok(fs.existsSync(manifestPath), 'hardgate CLI should record playable flow manifest even on failed gates');
var smokeManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
assert.strictEqual(smokeManifest.kind, 'blueprint.playableFlowManifest');
assert.strictEqual(smokeManifest.stages.storyboard2htmlSmoke.passed, false);
assert.ok(smokeManifest.artifacts.generatedHtml.sha256);
assert.ok(failedHardgate.gates[1].errors.some(function(error) {
  return error.indexOf('triggeredPresentFullRate') >= 0;
}));

console.log('storyboard2html contract tests passed');
