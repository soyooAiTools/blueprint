#!/usr/bin/env node
'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var helpers = require('../engine/helpers.cjs');
var visualAssets = require('../adapters/demo2spec/visual-assets.js');

var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-visual-assets-gate-'));
var sourceHtmlPath = path.join(tmpDir, 'source.html');

fs.writeFileSync(sourceHtmlPath, [
  '<!doctype html><html><head><style>',
  '#hud{position:fixed;top:0;left:0;right:0;height:52px;background:rgba(0,0,0,0.6);display:flex}',
  '#goldIcon{width:24px;height:24px;background:radial-gradient(circle,#ffe45c,#f0a000);border-radius:50%}',
  '#goldCount{color:#ffe45c;font-weight:bold;font-size:18px;min-width:40px}',
  '#tip{flex:1;text-align:center;color:#8deaff;font-size:13px}',
  '#phaseLabel{color:#fff;font-size:12px;opacity:0.7}',
  '#targetHint{position:fixed;top:56px;left:50%;transform:translateX(-50%);color:#ffe45c}',
  '</style></head><body>',
  '<div id="hud"><div id="goldIcon"></div><div id="goldCount">50</div><div id="tip">欢迎！用摇杆移动宇航员</div><div id="phaseLabel">Phase 1/1</div></div>',
  '<div id="targetHint"></div>',
  '<script>',
  'var camera = new THREE.PerspectiveCamera(50, innerWidth/innerHeight, 0.1, 200);',
  'camera.position.set(0, 22, 18); camera.lookAt(0, 0, 0);',
  'var gridHelper = new THREE.GridHelper(60, 30, 0x223344, 0x1a2233);',
  'const ENTITY_STYLE = {',
  '  Player: { kind: "astronaut", label: "玩家角色", color: 0x4fc3f7 },',
  '  IceBlock: { kind: "ice", label: "冰晶", color: "#66ccff" }',
  '};',
  'const ENTITY_POSITIONS = {',
  '  Player: { x: 0, y: 0, z: 1 },',
  '  IceBlock: { x: 2, y: 0, z: 3 }',
  '};',
  'const PHASES = [{',
  '  id: "phase1",',
  '  name: "初始需求引导",',
  '  guideText: "靠近冰晶采集",',
  '  goalText: "采集 1 块冰",',
  '  showEntities: ["Player", "IceBlock"],',
  '  steps: [{ target: "IceBlock", label: "采冰" }]',
  '}];',
  '</script></body></html>',
].join('\n'), 'utf8');

var baseCtx = {
  taskId: 'visual-assets-build-gate',
  sourceHtmlPath: sourceHtmlPath,
  blueprint: {
    sourceHtmlPath: sourceHtmlPath,
    entities: [{ name: 'Player' }, { name: 'IceBlock' }],
  },
  addLog: function() {},
};

assert.throws(function() {
  helpers.buildVisualAssetsForRequest(baseCtx);
}, /no fidelityContract is available/, 'source-bound build must fail closed without fidelityContract');

var ctx = JSON.parse(JSON.stringify(baseCtx));
ctx.addLog = function() {};
ctx.blueprint.fidelityContract = {
  schemaVersion: '1.2.0',
  kind: 'blueprint.fidelityContract',
  phases: [
    {
      id: 'phase1',
      projectedAnchors: {
        Player: { x_px: 100, y_px: 120, w_px: 60, h_px: 80 },
        IceBlock: {
          x_px: 0, y_px: 0, w_px: 0, h_px: 0,
          provenance: 'inferred-default',
          lookupPath: 'not-found',
          resolverRule: 'unresolved',
        },
      },
    },
  ],
  entities: [
    { id: 'Player', worldLabel: { text: '玩家角色', worldOffset: { y: 1.5 } } },
    { id: 'IceBlock', worldLabel: { text: '冰晶', worldOffset: { y: 1.5 } } },
  ],
};

var manifest = helpers.buildVisualAssetsForRequest(ctx);
assert.ok(manifest, 'manifest should be synthesized');
assert.strictEqual(manifest.sourceEntityContract.entities.length, 2);
assert.strictEqual(manifest.sourceEntityContract.entityStyles.Player.label, '玩家角色');
assert.deepStrictEqual(manifest.sourceSceneContract.camera.position, [0, 22, 18]);
assert.deepStrictEqual(manifest.sourceSceneContract.camera.lookAt, [0, 0, 0]);
assert.strictEqual(manifest.sourceSceneContract.camera.fov, 50);
assert.strictEqual(manifest.sourceSceneContract.grid.present, true);
assert.strictEqual(manifest.sourceSceneContract.grid.size, 60);
assert.strictEqual(manifest.sourceSceneContract.grid.divisions, 30);
assert.strictEqual(manifest.sourceSceneContract.grid.colorCenterLine, '#223344');
assert.strictEqual(manifest.sourceEntityContract.domHudContract.present, true);
assert.strictEqual(manifest.sourceEntityContract.domHudContract.initialText.goldCount, '50');
assert.strictEqual(manifest.sourceEntityContract.domHudContract.initialText.tip, '欢迎！用摇杆移动宇航员');
assert.ok(manifest.sourceEntityContract.domHudContract.css.hud.indexOf('position:fixed') >= 0);
assert.strictEqual(manifest.sourcePhaseContract.phases.length, 1);
assert.strictEqual(manifest.visualRuntimeContract.kind, visualAssets.VISUAL_RUNTIME_CONTRACT_KIND);
assert.strictEqual(manifest.visualRuntimeContract.phaseDriver.sourceFunction, '__driveToSourcePhase');
assert.strictEqual(manifest.visualRuntimeContract.phaseDriver.webglFunction, '__driveToPhase');
assert.strictEqual(manifest.visualRuntimeContract.summary.phaseCount, 1);
assert.strictEqual(manifest.visualRuntimeContract.summary.entityCount, 2);
assert.deepStrictEqual(manifest.visualRuntimeContract.phases[0].targetAffordances.map(item => item.entity), ['IceBlock']);
assert.deepStrictEqual(
  manifest.visualRuntimeContract.phases[0].expectedEvidence.slice(0, 3),
  ['guide_text_visible', 'player_input_joystick', 'move_to_target']
);
assert.strictEqual(
  visualAssets.validateVisualRuntimeContract(manifest.visualRuntimeContract).passed,
  true,
  'source-bound manifest should emit a gateable visual runtime contract'
);
var runtimeVisibilityContract = visualAssets.parseSourcePhaseContract([
  '<script>',
  'const PHASES = [',
  '  {id:"phase1",showEntities:["TargetA"],steps:[{target:"TargetA"}]},',
  '  {id:"phase2",showEntities:["TargetB"],steps:[{target:"TargetB"}]}',
  '];',
  'function enterPhaseIndex(i){',
  '  setVisible("PlayerCharacter", true);',
  '  setVisible("SpaceStation", true);',
  '  if(i >= 1) setVisible("BuiltMachine", true);',
  '  if(i === 1 && resources.Gold < 250) resources.Gold = 250;',
  '  if(i === 1) resources.Coin = Math.max(resources.Coin, 999);',
  '}',
  '</script>',
].join('\n'));
assert.deepStrictEqual(runtimeVisibilityContract.visibilityRules.always, ['PlayerCharacter', 'SpaceStation']);
assert.deepStrictEqual(runtimeVisibilityContract.visibilityRules.minPhaseIndex, [{ entity: 'BuiltMachine', index: 1 }]);
assert.deepStrictEqual(runtimeVisibilityContract.resourceRules, [
  { index: 1, resource: 'Gold', value: 250 },
  { index: 1, resource: 'Coin', value: 999 },
]);
assert.deepStrictEqual(runtimeVisibilityContract.phases[0].runtimeVisibleEntities, ['TargetA', 'PlayerCharacter', 'SpaceStation']);
assert.deepStrictEqual(runtimeVisibilityContract.phases[1].runtimeVisibleEntities, ['TargetB', 'PlayerCharacter', 'SpaceStation', 'BuiltMachine']);
assert.deepStrictEqual(runtimeVisibilityContract.phases[1].runtimeResources, { Gold: 250, Coin: 999 });
var statefulVisibilityContract = visualAssets.parseSourcePhaseContract([
  '<script>',
  'const PHASES = [',
  '  {id:"phase1",showEntities:["Door"],steps:[{target:"Door",setEntity:"Door"}]},',
  '  {id:"phase2",showEntities:["Machine"],steps:[{target:"Machine",setEntity:"Machine"}]},',
  '  {id:"phase3",showEntities:["Bed"],steps:[{target:"Bed"}]}',
  '];',
  'function phaseEnterCommon(i){',
  '  Object.keys(ENTITY_STYLE).forEach(function(name){setVisible(name,PHASES[i].showEntities.indexOf(name)!==-1||name==="Player"||name==="HomeBase"||entityState[name].state>0);});',
  '}',
  '</script>',
].join('\n'));
assert.strictEqual(statefulVisibilityContract.visibilityRules.statefulSetEntities, true);
assert.deepStrictEqual(statefulVisibilityContract.visibilityRules.always, ['Player', 'HomeBase']);
assert.deepStrictEqual(statefulVisibilityContract.phases[1].runtimeVisibleEntities, ['Machine', 'Player', 'HomeBase', 'Door']);
assert.deepStrictEqual(statefulVisibilityContract.phases[2].runtimeVisibleEntities, ['Bed', 'Player', 'HomeBase', 'Door', 'Machine']);
var loopVisibilityContract = visualAssets.parseSourcePhaseContract([
  '<script>',
  'const PHASES = [',
  '  {id:"phase1",showEntities:["PlayerAstronaut"],steps:[{target:"PlayerAstronaut"}]},',
  '  {id:"phase2",showEntities:["CTAButton"],steps:[{target:"CTAButton"}]}',
  '];',
  'function enterPhase(i){',
  '  Object.keys(ENTITY_STYLE).forEach(function(k){models[k].visible = k === "PlayerAstronaut" || PHASES[i].showEntities.indexOf(k) >= 0 || ["SpaceBase","MechanicalArm"].indexOf(k) >= 0;});',
  '}',
  '</script>',
].join('\n'));
assert.deepStrictEqual(loopVisibilityContract.visibilityRules.always, ['PlayerAstronaut', 'SpaceBase', 'MechanicalArm']);
assert.deepStrictEqual(loopVisibilityContract.phases[1].runtimeVisibleEntities, ['CTAButton', 'PlayerAstronaut', 'SpaceBase', 'MechanicalArm']);
assert.strictEqual(Object.keys(manifest.entityBindings).length, 2);
assert.ok(manifest.fidelityContract, 'fidelityContract should be merged into build manifest');
assert.ok(manifest.fidelityContract.phases[0].projectedAnchors.Player, 'valid anchor should be retained');
assert.strictEqual(
  manifest.fidelityContract.phases[0].projectedAnchors.IceBlock,
  undefined,
  'inferred/default unresolved 0x0 anchor must be stripped before build injection'
);

var sceneConfigCamera = visualAssets.parseSceneConfig([
  'const SCENE_CONFIG = {',
  '  backgroundColor:0x071626,',
  '  ambientLight:{color:0xffffff,intensity:0.68},',
  '  directionalLight:{color:0xffffff,intensity:1.18,position:[-12,22,16]},',
  '  ground:{kind:"box",width:26,height:18,color:0x162b35},',
  '  camera:{fov:50,position:[0,15,16],lookAt:[2,0,-1],near:0.1,far:160}',
  '};',
].join('\n'));
assert.strictEqual(sceneConfigCamera.camera.source, 'SCENE_CONFIG.camera');
assert.deepStrictEqual(sceneConfigCamera.camera.position, [0, 15, 16]);
assert.deepStrictEqual(sceneConfigCamera.camera.lookAt, [2, 0, -1]);
assert.strictEqual(sceneConfigCamera.camera.fov, 50);
assert.strictEqual(sceneConfigCamera.ground.kind, 'box');
var dynamicSceneConfigCamera = visualAssets.parseSceneConfig([
  'const SCENE_CONFIG = {',
  '  backgroundColor:0x071626,',
  '  ambientLight:{color:0xffffff,intensity:0.68},',
  '  directionalLight:{color:0xffffff,intensity:1.18,position:[-12,22,16]},',
  '  camera:{fov:50,position:[0,15,16],lookAt:[2,0,-1],near:0.1,far:160}',
  '};',
  'function animate(){',
  '  camera.position.x += (player.position.x * .22 - camera.position.x + SCENE_CONFIG.camera.position[0]) * dt * 1.2;',
  '  camera.position.z += (player.position.z * .18 - camera.position.z + SCENE_CONFIG.camera.position[2]) * dt * 1.2;',
  '  camera.lookAt(player.position.x*.28,0,player.position.z*.22);',
  '}',
].join('\n'));
assert.strictEqual(dynamicSceneConfigCamera.camera.dynamicLookAtPlayer, true);
assert.deepStrictEqual(dynamicSceneConfigCamera.camera.lookAt, [0, 0, 0]);
assert.deepStrictEqual(dynamicSceneConfigCamera.camera.dynamicPlayerFollow.positionFactor, { x: 0.22, z: 0.18 });
assert.deepStrictEqual(dynamicSceneConfigCamera.camera.dynamicPlayerFollow.lookAtFactor, { x: 0.28, z: 0.22 });
assert.strictEqual(dynamicSceneConfigCamera.camera.dynamicPlayerFollow.smoothing, 1.2);
var noDtCameraContract = visualAssets.parseSceneConfig([
  'const SCENE_CONFIG = {',
  '  backgroundColor:0x071626,',
  '  ambientLight:{color:0xffffff,intensity:0.68},',
  '  directionalLight:{color:0xffffff,intensity:1.18,position:[-12,22,16]},',
  '  camera:{fov:50,position:[0,15,16],lookAt:[0,0,0],near:0.1,far:160}',
  '};',
  'function render(){',
  '  camera.position.x += (player.position.x*0.18 - camera.position.x + SCENE_CONFIG.camera.position[0]) * .025;',
  '  camera.position.z += (player.position.z*0.12 - camera.position.z + SCENE_CONFIG.camera.position[2]) * .025;',
  '  camera.lookAt(player.position.x*.28,0,player.position.z*.22);',
  '}',
].join('\n'));
assert.deepStrictEqual(noDtCameraContract.camera.dynamicPlayerFollow.positionFactor, { x: 0.18, z: 0.12 });
assert.deepStrictEqual(noDtCameraContract.camera.dynamicPlayerFollow.lookAtFactor, { x: 0.28, z: 0.22 });
assert.strictEqual(noDtCameraContract.camera.dynamicPlayerFollow.smoothing, 0.025);
var lerpCameraContract = visualAssets.parseSceneConfig([
  'const SCENE_CONFIG = {',
  '  backgroundColor:0x9bd7ff,',
  '  ambientLight:{color:0xffffff,intensity:0.72},',
  '  directionalLight:{color:0xffffff,intensity:1.18,position:[-12,24,14]},',
  '  camera:{fov:60,position:[0,18,16],lookAt:[0,0,0],near:0.1,far:120}',
  '};',
  'function render(){',
  '  camera.position.lerp(new THREE.Vector3(player.position.x,18,player.position.z+16),.08);',
  '  camera.lookAt(player.position.x,0,player.position.z);',
  '}',
].join('\n'));
assert.strictEqual(lerpCameraContract.camera.dynamicPlayerFollow.positionAbsolute, true);
assert.deepStrictEqual(lerpCameraContract.camera.dynamicPlayerFollow.positionFactor, { x: 1, z: 1 });
assert.deepStrictEqual(lerpCameraContract.camera.dynamicPlayerFollow.positionOffset, { x: 0, z: 16 });
assert.strictEqual(lerpCameraContract.camera.dynamicPlayerFollow.positionY, 18);
assert.deepStrictEqual(lerpCameraContract.camera.dynamicPlayerFollow.lookAtFactor, { x: 1, z: 1 });
assert.strictEqual(lerpCameraContract.camera.dynamicPlayerFollow.smoothing, 0.08);
var guidanceSceneContract = visualAssets.parseSceneConfig([
  'const SCENE_CONFIG = {',
  '  backgroundColor:0x071626,',
  '  ambientLight:{color:0xffffff,intensity:0.68},',
  '  directionalLight:{color:0xffffff,intensity:1.18,position:[-12,22,16]},',
  '  camera:{fov:50,position:[0,15,16],lookAt:[2,0,-1],near:0.1,far:160}',
  '};',
  'var targetRing = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.055, 8, 64), new THREE.MeshBasicMaterial({ color: 0xffe45c }));',
  'var trailLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({color:0x8deaff,transparent:true,opacity:.65}));',
  'var laserLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({color:0xff6858,transparent:true,opacity:0}));',
  'function animate(){',
  '  if(models.SpaceBase){',
  '    trailLine.geometry.setFromPoints([player.position.clone().add(new THREE.Vector3(0,1,0)), models.SpaceBase.position.clone().add(new THREE.Vector3(0,1,0))]);',
  '  }',
  '  targetHint.textContent = targetName() ? "目标：" + ENTITY_STYLE[targetName()].label : "完成";',
  '}',
  'function showToast(){} var toastUntil = 0;',
].join('\n'));
assert.strictEqual(guidanceSceneContract.guidance.trailLine.to, 'SpaceBase');
var orbitalRingSceneConfig = visualAssets.parseSceneConfig([
  'const SCENE_CONFIG = {',
  '  backgroundColor:0x071626,',
  '  ambientLight:{color:0xffffff,intensity:0.68},',
  '  directionalLight:{color:0xffffff,intensity:1.18,position:[-12,22,16]},',
  '  ground:{kind:"cylinder",radius:72,height:0.25,color:0x13233a},',
  '  decor:{stars:100,orbitalRings:4},',
  '  camera:{fov:60,position:[0,18,16],lookAt:[0,0,0],near:0.1,far:220}',
  '};',
  'function createDecor(){',
  '  var ground = new THREE.Mesh(new THREE.CylinderGeometry(SCENE_CONFIG.ground.radius, SCENE_CONFIG.ground.radius, SCENE_CONFIG.ground.height, 96), new THREE.MeshStandardMaterial({color:SCENE_CONFIG.ground.color}));',
  '  ground.position.y = -0.12;',
  '  scene.add(ground);',
  '  for(var j=0;j<SCENE_CONFIG.decor.orbitalRings;j++){',
  '    var ring = new THREE.Mesh(new THREE.TorusGeometry(10 + j*5.5, 0.025, 8, 128), new THREE.MeshBasicMaterial({color:0x234c76,transparent:true,opacity:0.5}));',
  '    ring.rotation.x = Math.PI / 2;',
  '    ring.position.y = 0.04 + j*0.015;',
  '    scene.add(ring);',
  '  }',
  '}',
].join('\n'));
assert.strictEqual(orbitalRingSceneConfig.decor.orbitalRings, 4);
assert.strictEqual(orbitalRingSceneConfig.ground.positionY, -0.12);
assert.deepStrictEqual(orbitalRingSceneConfig.decor.orbitalRingStyle.geometry.argsBase, [10, 0.025, 8, 128]);
assert.deepStrictEqual(orbitalRingSceneConfig.decor.orbitalRingStyle.geometry.argsStep, [5.5, 0, 0, 0]);
assert.strictEqual(orbitalRingSceneConfig.decor.orbitalRingStyle.material.diffuseColor, '#234C76');
assert.strictEqual(orbitalRingSceneConfig.decor.orbitalRingStyle.material.opacity, 0.5);
assert.deepStrictEqual(orbitalRingSceneConfig.decor.orbitalRingStyle.positionY, { base: 0.04, step: 0.015 });
var domWorldLabels = visualAssets.parseSourceWorldLabelContract([
  'var labels = {};',
  'function buildEntity(name, style){',
  '  var div = document.createElement("div");',
  '  div.className = "label";',
  '  div.textContent = style.label;',
  '  labels[name] = div;',
  '}',
].join('\n'));
assert.strictEqual(domWorldLabels.present, true);
assert.strictEqual(domWorldLabels.source, 'source-html-dom-world-labels');
var domCtaContract = visualAssets.parseSourceDomHudContract([
  '<style>',
  '#phaseBadge,#targetHint,.res{background:rgba(5,12,22,.78);border:1px solid rgba(141,234,255,.35)}',
  '#resources{display:flex;gap:8px}',
  '#victory{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(4,10,18,.42)}',
  '#victory h1{margin:0 0 18px;font-size:clamp(28px,6vw,58px)}',
  '#ctaDom{display:none;position:fixed;left:50%;bottom:88px;background:#ffde3b;color:#141820}',
  '</style>',
  '<div id="hud"><div id="phaseBadge">Phase 1/8</div><div id="resources"><div class="res">金币 <span id="goldText">50</span></div><div class="res">建材 <span id="matText">50</span></div></div></div>',
  '<div id="victory"><h1>成功占领敌方基地！</h1></div>',
  '<button id="ctaDom">立即下载体验完整游戏</button>',
].join('\n'));
assert.strictEqual(domCtaContract.ids.phaseBadge, 'phaseBadge');
assert.strictEqual(domCtaContract.ids.resources, 'resources');
assert.strictEqual(domCtaContract.ids.victory, 'victory');
assert.strictEqual(domCtaContract.ids.ctaDom, 'ctaDom');
assert.match(domCtaContract.css.phaseBadge, /rgba\(5,12,22/);
assert.match(domCtaContract.css.resourcePill, /border:1px/);
assert.match(domCtaContract.css.ctaDom, /bottom:88px/);
assert.match(domCtaContract.css.victoryTitle, /clamp\(28px,6vw,58px\)/);
assert.strictEqual(domCtaContract.initialText.phaseBadge, 'Phase 1/8');
assert.strictEqual(domCtaContract.initialText.goldText, '50');
assert.strictEqual(domCtaContract.initialText.matText, '50');
assert.strictEqual(domCtaContract.initialText.victory, '成功占领敌方基地！');
assert.strictEqual(domCtaContract.initialText.ctaDom, '立即下载体验完整游戏');

var meterPillContract = visualAssets.parseSourceDomHudContract([
  '<style>',
  '#hud{position:fixed;left:0;right:0;top:0;display:flex;justify-content:space-between}',
  '#logo{font-weight:800;font-size:18px}',
  '#meters{display:flex;gap:8px}',
  '.pill{background:rgba(5,14,30,.72);border:1px solid rgba(141,234,255,.35);border-radius:8px;padding:7px 10px}',
  '#workerPanel{position:fixed;right:12px;top:156px;display:none}',
  '#joystick{position:fixed;left:28px;bottom:28px;width:116px;height:116px;opacity:.58}',
  '#stickThumb{position:absolute;left:36px;top:36px;width:40px;height:40px}',
  '</style>',
  '<div id="hud"><div id="logo">太空卖氧气</div><div id="meters"><div class="pill" id="phaseText">Phase 1/8</div><div class="pill">氧气 <span id="oxygenText">0</span></div><div class="pill">金币 <span id="goldText">0</span></div><div class="pill">冰块 <span id="iceText">0/3</span></div></div></div>',
  '<div id="workerPanel">工人：待命</div>',
  '<div id="joystick"><div id="stickThumb"></div></div>',
].join('\n'));
assert.strictEqual(meterPillContract.ids.logo, 'logo');
assert.strictEqual(meterPillContract.ids.meters, 'meters');
assert.strictEqual(meterPillContract.ids.phaseBadge, 'phaseText');
assert.strictEqual(meterPillContract.ids.oxygenText, 'oxygenText');
assert.strictEqual(meterPillContract.ids.iceText, 'iceText');
assert.strictEqual(meterPillContract.ids.workerPanel, 'workerPanel');
assert.strictEqual(meterPillContract.ids.joystick, 'joystick');
assert.strictEqual(meterPillContract.ids.stickThumb, 'stickThumb');
assert.match(meterPillContract.css.resourcePill, /border:1px/);
assert.match(meterPillContract.css.joystick, /opacity:\.58/);
assert.match(meterPillContract.css.stickThumb, /width:40px/);
assert.strictEqual(meterPillContract.initialText.logo, '太空卖氧气');
assert.strictEqual(meterPillContract.initialText.phaseBadge, 'Phase 1/8');
assert.strictEqual(meterPillContract.initialText.oxygenText, '0');
assert.strictEqual(meterPillContract.initialText.iceText, '0/3');
assert.strictEqual(meterPillContract.initialText.workerPanel, '工人：待命');
var topbarHudContract = visualAssets.parseSourceDomHudContract([
  '<style>',
  '.hud{position:fixed;z-index:5;color:#fff}',
  '#topbar{top:0;left:0;right:0;height:86px;display:flex;justify-content:space-between}',
  '#leftStats{display:flex;gap:8px}',
  '#tip{max-width:66vw;font-weight:800}',
  '#goldPanel,#phaseLabel{font-weight:800;font-size:14px}',
  '#joystick{position:fixed;left:30px;bottom:34px;width:118px;height:118px}',
  '#stick{position:absolute;left:39px;top:39px;width:40px;height:40px}',
  '#installButton{position:fixed;left:50%;bottom:18px;display:none}',
  '#upgradePanel{position:fixed;left:50%;top:54%;display:none}',
  '</style>',
  '<div id="topbar" class="hud"><div id="tip">加载中</div><div id="leftStats"><div id="goldPanel">金币 0</div><div id="phaseLabel">Phase 1/8</div></div></div>',
  '<div id="upgradePanel">升级舱室<br><b>消耗30金币</b></div><div id="joystick"><div id="stick"></div></div><button id="installButton">安装完整游戏</button>',
].join('\n'));
assert.strictEqual(topbarHudContract.ids.hud, 'topbar');
assert.strictEqual(topbarHudContract.ids.meters, 'leftStats');
assert.strictEqual(topbarHudContract.ids.goldBox, 'goldPanel');
assert.strictEqual(topbarHudContract.ids.upgradePanel, 'upgradePanel');
assert.strictEqual(topbarHudContract.ids.stickThumb, 'stick');
assert.match(topbarHudContract.css.hud, /position:fixed/);
assert.match(topbarHudContract.css.hud, /height:86px/);
assert.strictEqual(topbarHudContract.initialText.goldBox, '金币 0');
assert.strictEqual(topbarHudContract.initialText.upgradePanel, '升级舱室 消耗30金币');
assert.strictEqual(topbarHudContract.initialText.ctaDom, '安装完整游戏');

var ctaOverlayContract = visualAssets.parseSourceDomHudContract([
  '<style>',
  '#ctaOverlay{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:7;display:none;pointer-events:auto}',
  '#ctaOverlay button{border:0;border-radius:8px;background:#29d96f;color:#04210f;font-size:22px;font-weight:900;padding:18px 28px}',
  '#ctaOverlay small{display:block;text-align:center;margin-top:8px;color:#eafff2}',
  '@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(41,217,111,.58)}70%{box-shadow:0 0 0 18px rgba(41,217,111,0)}100%{box-shadow:0 0 0 0 rgba(41,217,111,0)}}',
  '.ctaTitle{font-size:34px;font-weight:900}',
  '.ctaBtn{display:inline-block;margin-top:24px;padding:16px 34px;background:#26d67b}',
  '#goldBox,#phaseBox{height:34px;display:flex;align-items:center;gap:8px;background:rgba(5,12,28,.72)}',
  '#goldIcon{width:18px;height:18px;border-radius:50%;background:linear-gradient(#ffe887,#e3a722)}',
  '</style>',
  '<div id="hud"><div id="goldBox"><span id="goldIcon"></span><span>Gold</span><span id="goldValue">150</span></div><div id="phaseBox">Phase <span id="phaseNow">1</span>/<span id="phaseTotal">8</span></div></div>',
  '<div id="targetHint">目标：太空垃圾</div><div id="tip">靠近下载按钮</div>',
  '<div id="ctaOverlay"><button id="ctaButtonDom">立即下载，建造你的专属太空站</button><small>体验更多玩法</small></div>',
].join('\n'));
assert.strictEqual(ctaOverlayContract.ids.victory, 'ctaOverlay');
assert.strictEqual(ctaOverlayContract.ids.ctaPanel, null);
assert.strictEqual(ctaOverlayContract.ids.ctaDom, 'ctaButtonDom');
assert.strictEqual(ctaOverlayContract.ids.phaseBadge, 'phaseBox');
assert.strictEqual(ctaOverlayContract.ids.goldBox, 'goldBox');
assert.strictEqual(ctaOverlayContract.ids.goldText, 'goldValue');
assert.match(ctaOverlayContract.css.victory, /left:50%/);
assert.match(ctaOverlayContract.css.goldBox, /rgba\(5,12,28/);
assert.match(ctaOverlayContract.css.ctaDom, /background:#29d96f/);
assert.match(ctaOverlayContract.css.ctaSubtitle, /margin-top:8px/);
assert.match(ctaOverlayContract.css.keyframes, /@keyframes pulse/);
assert.match(ctaOverlayContract.css.keyframes, /box-shadow:0 0 0 18px/);
assert.strictEqual(ctaOverlayContract.initialText.ctaDom, '立即下载，建造你的专属太空站');
assert.strictEqual(ctaOverlayContract.initialText.ctaSubtitle, '体验更多玩法');
assert.strictEqual(ctaOverlayContract.initialText.victory, null);
assert.strictEqual(ctaOverlayContract.initialText.phaseBadge, 'Phase 1/8');
assert.strictEqual(ctaOverlayContract.initialText.goldBox, 'Gold 150');
assert.strictEqual(ctaOverlayContract.initialText.goldText, '150');

var walletHudContract = visualAssets.parseSourceDomHudContract([
  '<style>',
  '#hud{position:fixed;left:0;right:0;top:0;display:grid;grid-template-columns:auto 1fr auto}',
  '#wallet,#phaseBadge,#targetHint{background:rgba(7,16,38,.78);border:1px solid rgba(141,234,255,.34)}',
  '#progressWrap{position:fixed;left:14px;right:14px;top:60px;height:8px}',
  '#progressBar{height:100%;width:0;background:linear-gradient(90deg,#8deaff,#ffe45c)}',
  '#ctaPanel{background:rgba(7,16,38,.84);border:1px solid rgba(255,228,92,.55)}',
  '#targetHint{position:fixed;left:14px;bottom:18px}',
  '</style>',
  '<div id="hud"><div id="wallet">金币 10</div><div id="tip">移动到目标</div><div id="phaseBadge">Phase 1/8</div></div>',
  '<div id="progressWrap"><div id="progressBar"></div></div>',
  '<div id="targetHint">目标：主舱门</div>',
  '<div id="ctaOverlay"><div id="ctaPanel"><button id="ctaButton">立即下载</button></div></div>',
].join('\n'));
assert.strictEqual(walletHudContract.ids.goldBox, 'wallet');
assert.strictEqual(walletHudContract.ids.progressWrap, 'progressWrap');
assert.strictEqual(walletHudContract.ids.progressBar, 'progressBar');
assert.strictEqual(walletHudContract.ids.ctaPanel, 'ctaPanel');
assert.match(walletHudContract.css.goldBox, /rgba\(7,16,38/);
assert.match(walletHudContract.css.progressWrap, /top:60px/);
assert.match(walletHudContract.css.progressBar, /linear-gradient/);
assert.match(walletHudContract.css.victoryBox, /rgba\(7,16,38/);
assert.match(walletHudContract.css.targetHint, /bottom:18px/);
assert.strictEqual(walletHudContract.initialText.goldBox, '金币 10');

var ctaClassContract = visualAssets.parseSourceDomHudContract([
  '<style>',
  '#ctaOverlay{position:fixed;inset:0;display:none;place-items:center}',
  '#ctaOverlay.visible{display:grid}',
  '.ctaTitle{font-size:34px;font-weight:900}',
  '.ctaBtn{display:inline-block;margin-top:24px;padding:16px 34px;background:#26d67b}',
  '</style>',
  '<div id="hud"><div id="phaseBadge">Phase 1/8</div><div id="targetHint">目标：熔炼炉</div><div id="tip">提示</div></div>',
  '<div id="ctaOverlay"><div class="ctaBox"><div class="ctaTitle">立即下载，解锁更多舱室玩法！</div><div class="ctaBtn">安装完整游戏</div></div></div>',
].join('\n'));
assert.strictEqual(ctaClassContract.ids.victory, 'ctaOverlay');
assert.strictEqual(ctaClassContract.ids.ctaDom, null);
assert.match(ctaClassContract.css.victoryTitle, /font-size:34px/);
assert.match(ctaClassContract.css.ctaDom, /background:#26d67b/);
assert.strictEqual(ctaClassContract.initialText.victory, '立即下载，解锁更多舱室玩法！');
assert.strictEqual(ctaClassContract.initialText.ctaDom, '安装完整游戏');

var nestedCtaContract = visualAssets.parseSourceDomHudContract([
  '<style>',
  '#ctaOverlay{position:fixed;inset:0;display:none;align-items:center;justify-content:center}',
  '#victory{width:min(430px,calc(100vw - 36px));background:rgba(8,18,30,.86);border:1px solid rgba(255,184,74,.68);border-radius:8px;padding:22px;text-align:center}',
  '#victory h1{font-size:25px;margin:0 0 10px}',
  '#ctaDomButton{display:inline-flex;height:44px;min-width:150px;background:#ff8a1f;color:#fff}',
  '</style>',
  '<div id="hud"><div id="targetHint">目标：下载按钮</div><div id="tip">移动到下载按钮范围内</div></div>',
  '<div id="ctaOverlay"><div id="victory"><h1>恭喜通关试玩！</h1><button id="ctaDomButton">立即下载</button></div></div>',
].join('\n'));
assert.strictEqual(nestedCtaContract.ids.victory, 'ctaOverlay');
assert.strictEqual(nestedCtaContract.ids.ctaDom, 'ctaDomButton');
assert.match(nestedCtaContract.css.victory, /inset:0/);
assert.match(nestedCtaContract.css.victoryBox, /rgba\(8,18,30/);
assert.match(nestedCtaContract.css.ctaDom, /#ff8a1f/);
assert.strictEqual(nestedCtaContract.initialText.victory, '恭喜通关试玩！');
assert.strictEqual(nestedCtaContract.initialText.ctaDom, '立即下载');

var invalidOnlyCtx = JSON.parse(JSON.stringify(baseCtx));
invalidOnlyCtx.addLog = function() {};
invalidOnlyCtx.blueprint.fidelityContract = {
  schemaVersion: '1.2.0',
  kind: 'blueprint.fidelityContract',
  phases: [
    {
      id: 'phase1',
      projectedAnchors: {
        Player: {
          x_px: 0, y_px: 0, w_px: 0, h_px: 0,
          provenance: 'inferred-default',
          lookupPath: 'not-found',
          resolverRule: 'unresolved',
        },
      },
    },
  ],
  entities: [{ id: 'Player' }],
};
var invalidOnlyManifest = helpers.buildVisualAssetsForRequest(invalidOnlyCtx);
assert.deepStrictEqual(
  invalidOnlyManifest.fidelityContract.phases[0].projectedAnchors,
  {},
  'all-invalid projectedAnchors should sanitize to an empty map instead of forcing bogus origin anchors'
);

var playerGroupHtml = [
  '<!doctype html><html><body><script>',
  'const ENTITY_STYLE = {',
  '  OurAstronaut: { kind: "astronaut", label: "我方宇航员", color: 0x60a5fa },',
  '  EnemyShip: { kind: "ship", label: "敌方战舰", color: 0xef4444 }',
  '};',
  'const ENTITY_POSITIONS = {',
  '  OurAstronaut: { x: -5, y: 0, z: 0 },',
  '  EnemyShip: { x: 8, y: 0, z: 0 }',
  '};',
  'var playerGroup = new THREE.Group();',
  'var bodyMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.35,0.35,1,8), new THREE.MeshStandardMaterial({color:0x60a5fa}));',
  'var headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.32,8,8), new THREE.MeshStandardMaterial({color:0xe0f2fe}));',
  'playerGroup.add(bodyMesh); playerGroup.add(headMesh);',
  'playerGroup.position.set(-5,0,0); scene.add(playerGroup);',
  'function buildEntity(name){',
  '  var style = ENTITY_STYLE[name]; var g = new THREE.Group();',
  '  var kind = style.kind;',
  '  if(kind === "ship"){',
  '    var sm = new THREE.Mesh(new THREE.ConeGeometry(2,4,8), new THREE.MeshStandardMaterial({color:style.color}));',
  '    g.add(sm);',
  '  } else {',
  '    var dm = new THREE.Mesh(new THREE.BoxGeometry(1,1,1), new THREE.MeshStandardMaterial({color:style.color}));',
  '    g.add(dm);',
  '  }',
  '  models[name]=g;',
  '}',
  '</script></body></html>',
].join('\n');
var playerEntityNames = visualAssets.collectEntityNamesFromHtml(playerGroupHtml);
var playerManifest = visualAssets.extractVisualAssetManifest(playerGroupHtml, {
  source: path.join(tmpDir, 'player-group.html'),
  project: 'player-group-fixture',
  entityNames: playerEntityNames,
});
assert.strictEqual(
  playerManifest.assets.some(function(asset) { return asset.assetId === 'asset_g'; }),
  false,
  'buildEntity local group g must not be counted as a standalone unbound asset'
);
['asset_bodyMesh', 'asset_headMesh', 'asset_playerGroup'].forEach(function(assetId) {
  var asset = playerManifest.assets.find(function(item) { return item.assetId === assetId; });
  assert.ok(asset, assetId + ' missing');
  assert.strictEqual(asset.entityBinding.entityName, 'OurAstronaut', assetId + ' should bind to semantic player entity');
});
assert.strictEqual(
  visualAssets.validateVisualAssetReadiness(playerManifest, {
    expectedEntities: playerEntityNames,
    minAssetBindingRate: 0.9,
    minEntityBindingRate: 0.7,
    minExpectedEntityCoverageRate: 0.9,
  }).passed,
  true,
  'global playerGroup meshes should not fail asset binding readiness'
);

var addMeshHelperHtml = [
  '<!doctype html><html><body><script>',
  'const ENTITY_STYLE = {',
  '  Player: { kind: "astronaut", label: "工程兵", color: 0x66ccff },',
  '  Console: { kind: "console", label: "操控台", color: 0x48f28b }',
  '};',
  'const ENTITY_POSITIONS = {',
  '  Player: { x: -6, y: 0, z: 4 },',
  '  Console: { x: -5, y: 0, z: 0 }',
  '};',
  'var models = {};',
  'var meshOps = { Player: [], Console: [] };',
  'function mat(color, opacity, emissive) { return new THREE.MeshStandardMaterial({ color: color, opacity: opacity, emissive: emissive }); }',
  'function addMesh(g, name, mesh, op) { g.add(mesh); meshOps[name].push(op); }',
  'function buildEntity(name) {',
  '  var style = ENTITY_STYLE[name]; var kind = style.kind; var p = ENTITY_POSITIONS[name]; var g = new THREE.Group(); g.position.set(p.x, p.y || 0, p.z); models[name] = g;',
  '  var c = style.color;',
  '  if (kind === "astronaut") {',
  '    addMesh(g, name, new THREE.Mesh(new THREE.CylinderGeometry(.35,.45,1.05,16), mat(c,1,0x003344)), { kind: "cylinder", position: [0,.85,0], size: [.35,.45,1.05], color: 0x66ccff });',
  '  } else if (kind === "console") {',
  '    var m1 = new THREE.Mesh(new THREE.BoxGeometry(1.1,.65,1), mat(0x234b4a,1,0));',
  '    addMesh(g, name, m1, { kind: "box", position: [0,.35,0], size: [1.1,.65,1], color: 0x234b4a });',
  '  }',
  '}',
  '</script></body></html>',
].join('\n');
var addMeshEntityNames = visualAssets.collectEntityNamesFromHtml(addMeshHelperHtml);
var addMeshManifest = visualAssets.extractVisualAssetManifest(addMeshHelperHtml, {
  source: path.join(tmpDir, 'add-mesh-helper.html'),
  project: 'add-mesh-helper-fixture',
  entityNames: addMeshEntityNames,
});
assert.strictEqual(addMeshManifest.sourceEntityContract.entities.length, 2);
assert.ok(
  addMeshManifest.assets.some(function(asset) {
    return asset.entityBinding.entityName === 'Player'
      && asset.source.pattern === 'buildEntity:addMesh-inline-mesh';
  }),
  'addMesh inline helper mesh should bind to Player'
);
assert.ok(
  addMeshManifest.assets.some(function(asset) {
    return asset.entityBinding.entityName === 'Console'
      && asset.source.pattern === 'buildEntity:addMesh-local-mesh'
      && asset.transform.position.join(',') === '0,.35,0';
  }),
  'addMesh local helper mesh should bind to Console with op transform'
);
assert.strictEqual(
  visualAssets.validateVisualAssetReadiness(addMeshManifest, {
    expectedEntities: addMeshEntityNames,
    minAssetBindingRate: 0.9,
    minEntityBindingRate: 0.7,
    minExpectedEntityCoverageRate: 0.9,
  }).passed,
  true,
  'addMesh helper-built storyboard entities should pass asset readiness'
);

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('visual-assets build gate tests passed');
