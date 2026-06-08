'use strict';

var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var spawnSync = require('child_process').spawnSync;
var contractMod = require('../engine/storyboard2html-contract.cjs');
var promptBuilder = require('../engine/storyboard2html-prompt.cjs');

var blueprint = {
  projectName: 'FarmStoryboard',
  storyboard: {
    frames: [
      { title: 'Collect corn', interaction: 'collect:Corn:1', ui: 'Collect corn', camera: 'follow player' },
      { title: 'Build stand', interaction: 'near:Stand', ui: 'Build the farm stand' },
      { title: 'Sell crops', interaction: 'click:CtaButton', ui: 'Sell crops to customer' },
    ],
  },
  entities: [
    { name: 'Player', label: 'Player', template: 'PlayerController' },
    { name: 'Corn', label: 'Corn', template: 'Collectible' },
    { name: 'Customer', label: 'Customer', template: 'NpcQueue' },
    { name: 'CtaButton', label: 'CtaButton', template: 'CtaButton' },
  ],
  resources: [
    { name: 'Corn', entity: 'Corn' },
    { name: 'Gold', entity: null },
  ],
  specs: [
    {
      phaseId: 'phase1',
      phaseName: 'Collect corn',
      playerInstruction: 'Collect corn near the field',
      requiredInteractions: ['collect:Corn:1'],
      entitiesRequired: [{ name: 'Corn', resource: 'Corn' }],
      plannedModuleIds: ['collect_on_near', 'guide_ui', 'inventory_wallet', 'visual_binding'],
      trigger: { type: 'compound', operator: 'and', triggers: [{ type: 'timer', seconds: 0.6 }, { type: 'resource_collected', resource: 'Corn', amount: 1 }] },
      duration: { min: 8, max: 10 },
    },
    {
      phaseId: 'phase2',
      phaseName: 'Build stand',
      playerInstruction: 'Build the farm stand',
      requiredInteractions: ['near:Stand'],
      entitiesRequired: [{ name: 'Stand' }],
      plannedModuleIds: ['guide_ui', 'spawn_once', 'visual_binding'],
      trigger: { type: 'compound', operator: 'and', triggers: [{ type: 'timer', seconds: 0.8 }, { type: 'near_entity', entity: 'Stand', range: 2 }] },
    },
    {
      phaseId: 'phase3',
      phaseName: 'Sell crops',
      playerInstruction: 'Sell crops to customer',
      requiredInteractions: ['click:CtaButton'],
      entitiesRequired: [{ name: 'CtaButton' }],
      plannedModuleIds: ['guide_ui', 'cta_finish'],
      trigger: { type: 'click_entity', entity: 'CtaButton' },
    },
  ],
};

var bundle = contractMod.buildStoryboard2HtmlInput(blueprint, {
  htmlPath: '/tmp/generated.html',
  outDir: '/tmp/storyboard2html-prompt-test',
  steps: 12,
});

var built = promptBuilder.buildStoryboard2HtmlPrompt(bundle);

assert.ok(built.systemPrompt && typeof built.systemPrompt === 'string');
assert.ok(built.userPrompt && typeof built.userPrompt === 'string');
assert.ok(built.systemPrompt.length > 1500, 'system prompt seems too short: ' + built.systemPrompt.length);
assert.ok(built.userPrompt.length > 200, 'user prompt seems too short: ' + built.userPrompt.length);
assert.strictEqual(built.metadata.phases, 3);
assert.strictEqual(built.metadata.themeHint, 'farming');
assert.strictEqual(built.metadata.projectName, 'FarmStoryboard');

// L1 system prompt clauses
assert.ok(built.systemPrompt.indexOf('PHASES') >= 0, 'system prompt should mention PHASES');
assert.ok(built.systemPrompt.indexOf('SourceSceneIR') >= 0, 'system prompt should mention SourceSceneIR');
assert.ok(built.systemPrompt.indexOf('window.__BP_SOURCE_IR__') >= 0, 'system prompt should require window.__BP_SOURCE_IR__');
assert.ok(built.systemPrompt.indexOf('window.__BP_SOURCE_IR_HASH__') >= 0, 'system prompt should require window.__BP_SOURCE_IR_HASH__');
assert.ok(built.systemPrompt.indexOf('source-ir-preview-renderer.v1') >= 0, 'system prompt should require SourceIR preview renderer version');
assert.ok(built.systemPrompt.indexOf('window.__BP_SOURCE_IR_RENDERER_OWNS_VISUALS__') >= 0,
  'system prompt should require SourceIR renderer visual ownership marker');
assert.ok(built.systemPrompt.indexOf('window.__BP_SOURCE_IR_RENDERER_OWNS_PHASE_DRIVER__') >= 0,
  'system prompt should require SourceIR renderer phase-driver ownership marker');
assert.ok(built.systemPrompt.indexOf('window.__BP_SOURCE_IR_VISUAL_SOURCE__') >= 0,
  'system prompt should require SourceIR visual source marker');
assert.ok(built.systemPrompt.indexOf('window.__driveToSourcePhase') >= 0,
  'system prompt should require source-specific phase driver hook');
assert.ok(built.systemPrompt.indexOf('source-scene-ir.v1') >= 0, 'system prompt should require source-scene-ir.v1 schemaVersion');
assert.ok(built.systemPrompt.indexOf('blueprint.sourceSceneIR') >= 0, 'system prompt should require SourceSceneIR kind');
assert.ok(built.systemPrompt.indexOf('step.kind') >= 0 && built.systemPrompt.indexOf('move_to') >= 0 && built.systemPrompt.indexOf('cta_finish') >= 0,
  'system prompt should include SourceSceneIR step whitelist');
assert.ok(built.systemPrompt.indexOf('gate.kind') >= 0 && built.systemPrompt.indexOf('near_entity') >= 0 && built.systemPrompt.indexOf('cta_arrival') >= 0,
  'system prompt should include SourceSceneIR gate whitelist');
assert.ok(built.systemPrompt.indexOf('PHASES = __BP_SOURCE_IR__.phases') >= 0,
  'system prompt should require legacy PHASES projection from SourceSceneIR');
assert.ok(built.systemPrompt.indexOf('setTip') >= 0);
assert.ok(built.systemPrompt.indexOf('enterPhase') >= 0);
assert.ok(built.systemPrompt.indexOf('completePhase') >= 0);
assert.ok(built.systemPrompt.indexOf('phase{n}') >= 0 || built.systemPrompt.indexOf('phase1') >= 0);
assert.ok(built.systemPrompt.indexOf('conditions:["timer(0.8s)"]') >= 0, 'system prompt should forbid string condition triggers');
assert.ok(built.systemPrompt.indexOf('triggers:[{type:"resource_collected"') >= 0, 'system prompt should require structured trigger arrays');
assert.ok(built.systemPrompt.indexOf('built=2') >= 0, 'system prompt should require integer entity states');

// L2 runtime contract clauses
assert.ok(built.systemPrompt.indexOf('window.__gameState') >= 0);
assert.ok(built.systemPrompt.indexOf('phaseRealTimer') >= 0);
assert.ok(built.systemPrompt.indexOf('entity_states') >= 0);
assert.ok(built.systemPrompt.indexOf('wall-clock') >= 0);

// L3 evidence envelope clauses
assert.ok(built.systemPrompt.indexOf('phaseEvidence') >= 0);
assert.ok(built.systemPrompt.indexOf('schemaVersion') >= 0 && built.systemPrompt.indexOf('1.0.0') >= 0);
assert.ok(built.systemPrompt.indexOf('sourcePlatform') >= 0);
assert.ok(built.systemPrompt.indexOf('"html"') >= 0);
assert.ok(built.systemPrompt.indexOf('guide_text_visible') >= 0);
assert.ok(built.systemPrompt.indexOf('phase_advanced') >= 0);
assert.ok(built.systemPrompt.indexOf('resource_incremented') >= 0);

// L4 — window.__assetMeta license meta clauses (storyboard2html v3 task #6)
assert.ok(built.systemPrompt.indexOf('window.__assetMeta') >= 0, 'system prompt should declare window.__assetMeta carrier');
assert.ok(built.systemPrompt.indexOf('license') >= 0, 'system prompt should require license field');
assert.ok(built.systemPrompt.indexOf('attribution') >= 0, 'system prompt should require attribution field');
assert.ok(built.systemPrompt.indexOf('sourceUrl') >= 0, 'system prompt should require sourceUrl field');
// license enum hints
assert.ok(built.systemPrompt.indexOf('CC0') >= 0, 'system prompt should list CC0 in license enum');
assert.ok(built.systemPrompt.indexOf('CC-BY-4.0') >= 0, 'system prompt should list CC-BY-4.0 in license enum');
assert.ok(built.systemPrompt.indexOf('"unknown"') >= 0, 'system prompt should require explicit "unknown" sentinel for license');
// loader coverage hints (so LLM knows which loaders trigger the requirement)
assert.ok(built.systemPrompt.indexOf('GLTFLoader') >= 0, 'system prompt should call out GLTFLoader as covered by assetMeta');
assert.ok(built.systemPrompt.indexOf('TextureLoader') >= 0, 'system prompt should call out TextureLoader as covered by assetMeta');
// no-omit prohibition rules
assert.ok(built.systemPrompt.indexOf('不允许任何外部加载的资产 URL 在 `window.__assetMeta` 里缺条目') >= 0,
  'system prompt 禁止反规则 should forbid omitting assetMeta entries');
assert.ok(built.systemPrompt.indexOf('不允许把 `window.__assetMeta` 写在函数闭包里') >= 0,
  'system prompt 禁止反规则 should forbid wrapping assetMeta in closure');
// procedural-asset exemption (so we don't burn prompt on entries for primitive prefabs)
assert.ok(built.systemPrompt.indexOf('程序化资产') >= 0, 'system prompt should exempt procedural assets from assetMeta');

// L4 v2 grill follow-ups (case-sensitive enum / null vs ""/ attribution length cap)
// A1: case-sensitive license enum + variant denylist
assert.ok(built.systemPrompt.indexOf('case-sensitive') >= 0, 'system prompt should call license enum case-sensitive');
assert.ok(built.systemPrompt.indexOf('字符级精确') >= 0, 'system prompt should require char-level exact license match');
assert.ok(built.systemPrompt.indexOf('"cc0"') >= 0, 'system prompt should show "cc0" as forbidden variant');
assert.ok(built.systemPrompt.indexOf('"CC BY 4.0"') >= 0, 'system prompt should show "CC BY 4.0" (spaces) as forbidden variant');
assert.ok(built.systemPrompt.indexOf('"cc-by-4.0"') >= 0, 'system prompt should show "cc-by-4.0" (lowercase) as forbidden variant');
assert.ok(built.systemPrompt.indexOf('不允许 license 字段写大小写') >= 0, 'system prompt 禁止反规则 should forbid license variant casing');
// A3: sourceUrl / attribution must be null, not ""
assert.ok(built.systemPrompt.indexOf('禁止* 空串') >= 0 || built.systemPrompt.indexOf('禁止 空串') >= 0,
  'system prompt should forbid empty-string for unknown values');
assert.ok(built.systemPrompt.indexOf('不允许 `attribution` 或 `sourceUrl` 字段写空串') >= 0,
  'system prompt 禁止反规则 should forbid empty-string for attribution/sourceUrl');
// A4: attribution length cap
assert.ok(built.systemPrompt.indexOf('≤ 200 字符') >= 0 || built.systemPrompt.indexOf('<= 200') >= 0,
  'system prompt should cap attribution length at 200 chars');
assert.ok(built.systemPrompt.indexOf('不允许 `attribution` 字符串长度 > 200') >= 0,
  'system prompt 禁止反规则 should forbid attribution > 200 chars');

// L5 — 交互驱动硬约束 (storyboard2html v4 — 禁 phase 自走 + DOM listener 必须)
assert.ok(built.systemPrompt.indexOf('L5 — 交互驱动硬约束') >= 0, 'system prompt should declare L5 interaction-driven section');
assert.ok(built.systemPrompt.indexOf('setTimeout 自走') >= 0, 'system prompt L5 header should forbid setTimeout-driven phase advance');
assert.ok(built.systemPrompt.indexOf('每个 non-final phase 必须有') >= 0, 'system prompt should require DOM listener for non-final phases');
assert.ok(built.systemPrompt.indexOf('document') >= 0 && built.systemPrompt.indexOf('renderer.domElement') >= 0,
  'system prompt should require global/canvas pointer listeners as valid driver');
assert.ok(built.systemPrompt.indexOf('raycaster') >= 0, 'system prompt should mention raycaster as optional feedback');
assert.ok(built.systemPrompt.indexOf('mutate `phaseIndex`') >= 0, 'system prompt should call out phaseIndex mutation as forbidden inside setTimeout');
assert.ok(built.systemPrompt.indexOf('target_consumed') >= 0 && built.systemPrompt.indexOf('必须由 DOM event handler 内部置位') >= 0,
  'system prompt should require click_trigger evidence to be set inside DOM listener');
assert.ok(built.systemPrompt.indexOf('phase_gate_timer') >= 0 && built.systemPrompt.indexOf('某个用户动作之后') >= 0,
  'system prompt should require phase_gate_timer to be post-user-action countdown, not auto-start');
assert.ok(built.systemPrompt.indexOf('不允许 `setTimeout(fn, ms)`') >= 0,
  'system prompt 禁止反规则 should forbid setTimeout phaseIndex/enterPhase mutation');
assert.ok(built.systemPrompt.indexOf('不允许 non-final phase 完全没有') >= 0,
  'system prompt 禁止反规则 should forbid non-final phase without any listener');

// L5 v3 — floating joystick + arrival-gate canonical (storyboard2html v6 — youth-nick 反馈)
assert.ok(built.systemPrompt.indexOf('任意屏幕位置浮动虚拟摇杆') >= 0 || built.systemPrompt.indexOf('全屏任意位置浮动虚拟摇杆') >= 0,
  'system prompt should declare floating any-position joystick as canonical control paradigm');
assert.ok(built.systemPrompt.indexOf('originX') >= 0 && built.systemPrompt.indexOf('originY') >= 0,
  'system prompt should require joystick origin coordinates in game state');
assert.ok(built.systemPrompt.indexOf('arrival-gate') >= 0,
  'system prompt should declare arrival-gate as canonical interaction paradigm');
assert.ok(built.systemPrompt.indexOf('pointermove') >= 0 && built.systemPrompt.indexOf('pointerup') >= 0,
  'system prompt should require full 3-stage pointer events on joystick');
assert.ok(built.systemPrompt.indexOf('__gameState.input.joystick') >= 0,
  'system prompt should require joystick vector to write into __gameState.input.joystick');
assert.ok(built.systemPrompt.indexOf('每帧') >= 0,
  'system prompt should require per-frame player position update from joystick vector');
assert.ok(built.systemPrompt.indexOf('禁止* "点 entity 直接完成 phase"') >= 0 || built.systemPrompt.indexOf('禁止 "点 entity 直接完成 phase"') >= 0,
  'system prompt should forbid direct entity-click as phase advance');
assert.ok(built.systemPrompt.indexOf('禁止* "按键直接完成 phase"') >= 0 || built.systemPrompt.indexOf('禁止 "按键直接完成 phase"') >= 0,
  'system prompt should forbid keydown shortcut as phase advance');
assert.ok(built.systemPrompt.indexOf('非 final phase 写 `click_entity`') >= 0 || built.systemPrompt.indexOf('non-final phase 写 `click_entity`') >= 0,
  'system prompt should forbid non-final click_entity trigger');
assert.ok(built.systemPrompt.indexOf('desktop fallback') >= 0,
  'system prompt should permit keydown only as desktop fallback');
assert.ok(built.systemPrompt.indexOf('arrival-gate 圈') >= 0 || built.systemPrompt.indexOf('arrival-gate 进入之后') >= 0,
  'system prompt should require CtaButton click handler to check arrival-gate');
assert.ok(built.systemPrompt.indexOf('player_input_joystick` 模块必须') >= 0 || built.systemPrompt.indexOf('player_input_joystick 模块必须') >= 0,
  'system prompt should require player_input_joystick evidence per non-final phase');
// new 禁止反规则 lines for joystick paradigm
assert.ok(built.systemPrompt.indexOf('不允许整个 demo 缺失任意位置浮动虚拟摇杆 UI 控件') >= 0,
  'system prompt 禁止反规则 should forbid missing joystick UI widget');
assert.ok(built.systemPrompt.indexOf('不允许 non-final phase 用 `keydown`') >= 0,
  'system prompt 禁止反规则 should forbid keydown as sole non-final phase advance path');
assert.ok(built.systemPrompt.indexOf('不允许 non-final phase 写 `trigger.type === "click_entity"`') >= 0,
  'system prompt 禁止反规则 should forbid non-final click_entity trigger');
assert.ok(built.systemPrompt.indexOf('不允许 `CtaButton` 的 click handler 在 Player 未进入') >= 0,
  'system prompt 禁止反规则 should forbid CtaButton finish without arrival-gate check');
assert.ok(built.systemPrompt.indexOf('不允许 non-final phase 的 `plannedModuleIds`') >= 0,
  'system prompt 禁止反规则 should forbid non-final phase missing player_input_joystick evidence');

// L1 v2 — final phase arrival-gated relaxation (storyboard2html v5 — youth-nick confirmed arrival-only final canonical)
assert.ok(built.systemPrompt.indexOf('最后一个 phase 必须以 `CtaButton` 为目标且 *arrival-gated*') >= 0,
  'system prompt should declare final phase must be CtaButton + arrival-gated (L1 v2)');
assert.ok(built.systemPrompt.indexOf('`trigger.type` 可为 `near_entity`') >= 0,
  'system prompt should allow trigger.type==="near_entity" for final phase');
assert.ok(built.systemPrompt.indexOf('arrival-only:玩家走到 CtaButton 圈内即自动完成') >= 0,
  'system prompt should describe arrival-only path for final phase');
assert.ok(built.systemPrompt.indexOf('*或* `click_entity`') >= 0,
  'system prompt should still allow click_entity as alternate final trigger');
assert.ok(built.systemPrompt.indexOf('对应 phaseEvidence *必须* 写 `cta_finish` 模块 + `final_phase: true`') >= 0,
  'system prompt should still require cta_finish evidence regardless of final trigger type');
// L5 v2 — CtaButton arrival-gated dual-path
assert.ok(built.systemPrompt.indexOf('两种 canonical 路径任选其一') >= 0,
  'system prompt L5 should describe the two canonical CtaButton paths');
// L5 v2 — click_trigger module gating on which final trigger type chosen
assert.ok(built.systemPrompt.indexOf('若最后一 phase 走 `near_entity` arrival-only 路径,则不需要 `click_trigger`') >= 0,
  'system prompt should exempt click_trigger when final trigger is near_entity');
// summarizePhase trigger hint reflects new canonical
assert.ok(built.userPrompt.indexOf('click_entity(CtaButton)') >= 0,
  'userPrompt phase table should still echo concrete click_entity trigger when spec uses it (test fixture)');
// Anti-regression: the old strict requirement string must be gone
assert.ok(built.systemPrompt.indexOf('最后一个 phase 的 `trigger.type` 必须是 `click_entity`') < 0,
  'system prompt MUST NOT contain the old strict final-trigger-must-be-click_entity wording');

// L6 — 视觉模型化硬约束 (storyboard2html v4 — 禁纯平面 2D 示意 + 复合几何体)
assert.ok(built.systemPrompt.indexOf('L6 — 视觉模型化硬约束') >= 0, 'system prompt should declare L6 visual modeling section');
assert.ok(built.systemPrompt.indexOf('禁止 Canvas/DOM 平面示意') >= 0, 'system prompt L6 header should forbid Canvas/DOM flat schematic');
assert.ok(built.systemPrompt.indexOf('真实 WebGL 3D 场景') >= 0,
  'system prompt should require real WebGL 3D rendering');
assert.ok(built.systemPrompt.indexOf('WebGLRenderer') >= 0 && built.systemPrompt.indexOf('THREE.Scene') >= 0,
  'system prompt should require Three.js Scene/WebGLRenderer');
assert.ok(built.systemPrompt.indexOf('禁止用纯 Canvas 2D / isometric 伪 3D') >= 0,
  'system prompt should explicitly reject canvas pseudo-3D as primary rendering');
assert.ok(built.systemPrompt.indexOf('复合几何体') >= 0, 'system prompt should require composite geometry');
assert.ok(built.systemPrompt.indexOf('头 Sphere + 身体 Cylinder') >= 0 || built.systemPrompt.indexOf('头+身+肢') >= 0,
  'system prompt should give explicit composite player geometry guidance');
assert.ok(built.systemPrompt.indexOf('ground/floor') >= 0 || built.systemPrompt.indexOf('地面/底板') >= 0,
  'system prompt should require ground/floor element');
assert.ok(built.systemPrompt.indexOf('PlaneGeometry') >= 0, 'system prompt should hint THREE.PlaneGeometry as ground geometry');
assert.ok(built.systemPrompt.indexOf('不允许 entity 只用单个 `ctx.arc()`') >= 0,
  'system prompt 禁止反规则 should forbid single-arc / single-div entity representation');
assert.ok(built.systemPrompt.indexOf('不允许整个 stage 只是 Canvas 黑底') >= 0,
  'system prompt 禁止反规则 should forbid empty-stage-with-dots schematic');
assert.ok(built.systemPrompt.indexOf('不允许跳过 `Player` 角色复合几何体') >= 0,
  'system prompt 禁止反规则 should forbid skipping composite Player geometry');

// L7 — Entity 视觉契约(extractor 兼容布局,SourceIR 静态解析必须命中)
assert.ok(built.systemPrompt.indexOf('L7 — Entity 视觉契约') >= 0,
  'system prompt should declare L7 entity visual contract section');
assert.ok(built.systemPrompt.indexOf('extractor 兼容布局') >= 0,
  'system prompt L7 header should reference extractor-compatible layout');
assert.ok(built.systemPrompt.indexOf('`const ENTITY_STYLE') >= 0 && built.systemPrompt.indexOf('`const ENTITY_POSITIONS') >= 0,
  'system prompt L7 should require top-level ENTITY_STYLE + ENTITY_POSITIONS const maps');
assert.ok(built.systemPrompt.indexOf('function buildEntity(name)') >= 0,
  'system prompt L7 should require named function buildEntity(name)');
assert.ok(built.systemPrompt.indexOf('kind-switch') >= 0,
  'system prompt L7 should require kind-switch dispatch inside buildEntity');
assert.ok(built.systemPrompt.indexOf('models[name] = g') >= 0 || built.systemPrompt.indexOf('models[<entityName>] = g') >= 0,
  'system prompt L7 should require models[name] = g anchor pattern');
assert.ok(built.systemPrompt.indexOf('Object.keys(ENTITY_STYLE).forEach(buildEntity)') >= 0,
  'system prompt L7 should require Object.keys(ENTITY_STYLE).forEach(buildEntity) driver');
assert.ok(built.systemPrompt.indexOf('`kind` 字段') >= 0,
  'system prompt L7 should require kind field on each ENTITY_STYLE entry');
assert.ok(built.systemPrompt.indexOf('完全一致') >= 0,
  'system prompt L7 should require ENTITY_STYLE keys === ENTITY_POSITIONS keys');

// L7 禁止反规则 — anti-extractor-blind layouts
assert.ok(built.systemPrompt.indexOf('不允许 entity mesh 装配塞进 IIFE') >= 0,
  'system prompt 禁止反规则 should forbid IIFE-wrapped entity assembly');
assert.ok(built.systemPrompt.indexOf('不允许 entity 名只出现在 `getElementById') >= 0,
  'system prompt 禁止反规则 should forbid entity names only in getElementById strings');
assert.ok(built.systemPrompt.indexOf('不允许跳过 `ENTITY_STYLE` 直接 `new THREE.Mesh') >= 0,
  'system prompt 禁止反规则 should forbid scattering new THREE.Mesh without ENTITY_STYLE binding');
assert.ok(built.systemPrompt.indexOf('不允许 `buildEntity` 用 `switch (name)`') >= 0,
  'system prompt 禁止反规则 should forbid switch-on-name (must dispatch on kind)');
assert.ok(built.systemPrompt.indexOf('不允许 `ENTITY_POSITIONS` 的 key 与 `ENTITY_STYLE` 不一致') >= 0,
  'system prompt 禁止反规则 should forbid ENTITY_POSITIONS keys diverging from ENTITY_STYLE');
assert.ok(built.systemPrompt.indexOf('不允许 `ENTITY_STYLE` 任一 entry 缺 `kind`') >= 0,
  'system prompt 禁止反规则 should forbid ENTITY_STYLE entry without kind');
assert.ok(built.systemPrompt.indexOf('不允许 `function buildEntity` 写成箭头函数') >= 0,
  'system prompt 禁止反规则 should forbid arrow / anonymous buildEntity');

// L8 — 场景视觉契约(scene-level params,Luna runtime per-story 适配主门)
assert.ok(built.systemPrompt.indexOf('L8 — 场景视觉契约') >= 0,
  'system prompt should declare L8 scene visual contract section');
assert.ok(built.systemPrompt.indexOf('scene-level params') >= 0,
  'system prompt L8 header should reference scene-level params');
assert.ok(built.systemPrompt.indexOf('`const SCENE_CONFIG') >= 0,
  'system prompt L8 should require top-level SCENE_CONFIG const map');
assert.ok(built.systemPrompt.indexOf('`backgroundColor`') >= 0,
  'system prompt L8 should declare backgroundColor field');
assert.ok(built.systemPrompt.indexOf('`fog`') >= 0,
  'system prompt L8 should declare fog field');
assert.ok(built.systemPrompt.indexOf('`ambientLight`') >= 0,
  'system prompt L8 should declare ambientLight field');
assert.ok(built.systemPrompt.indexOf('`directionalLight`') >= 0,
  'system prompt L8 should declare directionalLight field');
assert.ok(built.systemPrompt.indexOf('`rimLight`') >= 0,
  'system prompt L8 should declare rimLight field (optional)');
assert.ok(built.systemPrompt.indexOf('`ground`') >= 0,
  'system prompt L8 should declare ground field');
assert.ok(built.systemPrompt.indexOf('`decor`') >= 0,
  'system prompt L8 should declare decor field');
assert.ok(built.systemPrompt.indexOf('sourceSceneContract') >= 0,
  'system prompt L8 should reference sourceSceneContract (Luna runtime hook)');
assert.ok(built.systemPrompt.indexOf('按字段而不是按主题') >= 0,
  'system prompt L8 should require per-field config not per-theme hardset');
assert.ok(built.systemPrompt.indexOf('SCENE_CONFIG.backgroundColor') >= 0,
  'system prompt L8 should reference SCENE_CONFIG.backgroundColor in rendering binding');
// L8 禁止反规则
assert.ok(built.systemPrompt.indexOf('不允许 `SCENE_CONFIG` 写在 `function init()') >= 0,
  'system prompt 禁止反规则 should forbid SCENE_CONFIG inside function/IIFE');
assert.ok(built.systemPrompt.indexOf('不允许 `SCENE_CONFIG.backgroundColor` 缺失') >= 0,
  'system prompt 禁止反规则 should forbid missing or string-form backgroundColor');
assert.ok(built.systemPrompt.indexOf('不允许 `SCENE_CONFIG.ambientLight` 或 `SCENE_CONFIG.directionalLight`') >= 0,
  'system prompt 禁止反规则 should forbid missing ambient/directional light');
assert.ok(built.systemPrompt.indexOf('不允许 `SCENE_CONFIG.fog` / `SCENE_CONFIG.rimLight` / `SCENE_CONFIG.ground` / `SCENE_CONFIG.decor` 写成布尔开关') >= 0,
  'system prompt 禁止反规则 should forbid boolean/string form for fog/rimLight/ground/decor');
assert.ok(built.systemPrompt.indexOf('不允许源 HTML 的 `scene.background`') >= 0,
  'system prompt 禁止反规则 should require rendering code to reference SCENE_CONFIG fields (no literal divergence)');

// L5/L6 interaction with existing rules
// The old "玩家不需要真操作:可以 auto-progress" line must be REMOVED (anti-regression)
assert.ok(built.systemPrompt.indexOf('玩家不需要真操作') < 0,
  'system prompt MUST NOT contain the old autoplay permission line (玩家不需要真操作:可以 auto-progress)');
assert.ok(built.systemPrompt.indexOf('可以 auto-progress(setTimeout 推 advancePhase)') < 0,
  'system prompt MUST NOT permit setTimeout auto-progress');

// Module templates
['guide_ui', 'inventory_wallet', 'collect_on_near', 'phase_gate_timer', 'visual_binding', 'spawn_once', 'cta_finish'].forEach(function(moduleId) {
  assert.ok(built.systemPrompt.indexOf(moduleId) >= 0, 'system prompt missing module template: ' + moduleId);
});

// Output format clauses
assert.ok(built.systemPrompt.indexOf('<!doctype html>') >= 0);
assert.ok(built.systemPrompt.indexOf('</html>') >= 0);
assert.ok(built.systemPrompt.indexOf('CtaButton') >= 0);

// Forbid rules
assert.ok(built.systemPrompt.indexOf('禁止') >= 0);

// snake_case MUST language (anti-regression: prompt must not allow camelCase-only writes)
assert.ok(built.systemPrompt.indexOf('snake_case') >= 0, 'system prompt should mention snake_case');
assert.ok(built.systemPrompt.indexOf('硬必填') >= 0, 'system prompt should mark snake_case keys as 硬必填');
assert.ok(built.systemPrompt.indexOf('镜像副本') >= 0, 'system prompt should restrict camelCase to 镜像副本');

// 36-module vocabulary present (anti-regression: prompt must not silently support fewer modules)
[
  'activate_targets', 'apply_damage', 'build_progress', 'camera_focus', 'camera_lift', 'camera_zoom',
  'click_trigger', 'collect_on_near', 'cooldown', 'cost_gate', 'cta_finish', 'damageable',
  'deliver_to_target', 'drag_trigger', 'floating_text_feedback', 'form_switch', 'guide_ui',
  'highlight_target', 'hold_trigger', 'inventory_wallet', 'move_to_target', 'on_death_drop',
  'phase_gate_timer', 'player_input_joystick', 'player_input_tap', 'pop_animation',
  'projectile_emit', 'proximity_trigger', 'score_feedback', 'spawn_interval', 'spawn_once',
  'target_acquire', 'upgrade_progress', 'visual_binding', 'visual_variant_swap', 'world_label',
].forEach(function(moduleId) {
  assert.ok(built.systemPrompt.indexOf(moduleId) >= 0, 'system prompt missing module from 36-vocab: ' + moduleId);
});

// User prompt content checks
assert.ok(built.userPrompt.indexOf('FarmStoryboard') >= 0);
assert.ok(built.userPrompt.indexOf('themeHint: farming') >= 0);
assert.ok(built.userPrompt.indexOf('phase1') >= 0);
assert.ok(built.userPrompt.indexOf('phase2') >= 0);
assert.ok(built.userPrompt.indexOf('phase3') >= 0);
assert.ok(built.userPrompt.indexOf('collect:Corn:1') >= 0);
assert.ok(built.userPrompt.indexOf('click:CtaButton') >= 0);
assert.ok(built.userPrompt.indexOf('Collect corn near the field') >= 0);
assert.ok(built.userPrompt.indexOf('Frame 1') >= 0);
assert.ok(built.userPrompt.indexOf('triggeredPresentFullRate') >= 0);

// Regression: plannedModuleIds must surface in userPrompt phase table
// (Jonny found that normalizeSpec previously dropped plannedModuleIds silently.)
assert.ok(built.userPrompt.indexOf('collect_on_near') >= 0, 'userPrompt should list phase1 module collect_on_near');
assert.ok(built.userPrompt.indexOf('guide_ui') >= 0, 'userPrompt should list guide_ui (phase1+phase2)');
assert.ok(built.userPrompt.indexOf('inventory_wallet') >= 0, 'userPrompt should list phase1 inventory_wallet');
assert.ok(built.userPrompt.indexOf('spawn_once') >= 0, 'userPrompt should list phase2 spawn_once');
assert.ok(built.userPrompt.indexOf('cta_finish') >= 0, 'userPrompt should list phase3 cta_finish');

// extractHtml — accepts well-formed output
var goodHtml = '<!doctype html>\n<html><head></head><body>x</body></html>';
assert.strictEqual(promptBuilder.extractHtml(goodHtml), goodHtml);

// extractHtml — strips leading preamble (LLM chatty prefix)
var preambled = 'Here is the HTML you requested:\n\n<!doctype html>\n<html><body>ok</body></html>\n\nLet me know if you need more.';
var extracted = promptBuilder.extractHtml(preambled);
assert.ok(extracted.indexOf('<!doctype html>') === 0, 'extractHtml should strip preamble: ' + extracted.slice(0, 30));
assert.ok(extracted.indexOf('</html>') === extracted.length - '</html>'.length, 'extractHtml should strip trailing chatter');

// extractHtml — strips ``` fences
var fenced = '```html\n<!doctype html>\n<html><body>ok</body></html>\n```';
var fencedOut = promptBuilder.extractHtml(fenced);
assert.ok(fencedOut.indexOf('<!doctype html>') === 0, 'extractHtml should strip code fence');
assert.ok(fencedOut.indexOf('```') < 0, 'extractHtml output should not contain fence');

// extractHtml — accepts bare <html ...> opening (no doctype)
var noDoctype = '<html lang="en"><body>x</body></html>';
assert.strictEqual(promptBuilder.extractHtml(noDoctype), noDoctype);

// extractHtml — refuses output with no html tags at all
assert.throws(function() { promptBuilder.extractHtml('I am sorry, I cannot generate HTML.'); }, function(err) {
  return err && err.code === 'STORYBOARD2HTML_OUTPUT_NOT_HTML';
}, 'extractHtml should throw STORYBOARD2HTML_OUTPUT_NOT_HTML on prose-only output');

// extractHtml — refuses truncated output missing </html>
assert.throws(function() { promptBuilder.extractHtml('<!doctype html>\n<html><body>truncated...'); }, function(err) {
  return err && err.code === 'STORYBOARD2HTML_OUTPUT_TRUNCATED';
}, 'extractHtml should throw STORYBOARD2HTML_OUTPUT_TRUNCATED when </html> missing');

// resolveModel / resolveTimeoutMs / resolveMinOutputLen — opts win over env, env wins over default
var prevModel = process.env.STORYBOARD2HTML_MODEL;
var prevTimeout = process.env.STORYBOARD2HTML_TIMEOUT_MS;
var prevMinLen = process.env.STORYBOARD2HTML_MIN_OUTPUT_LEN;
try {
  delete process.env.STORYBOARD2HTML_MODEL;
  delete process.env.STORYBOARD2HTML_TIMEOUT_MS;
  delete process.env.STORYBOARD2HTML_MIN_OUTPUT_LEN;
  assert.strictEqual(promptBuilder.resolveModel({}), promptBuilder.DEFAULT_MODEL);
  assert.strictEqual(promptBuilder.resolveTimeoutMs({}), promptBuilder.DEFAULT_TIMEOUT_MS);
  assert.strictEqual(promptBuilder.resolveMinOutputLen({}), promptBuilder.DEFAULT_MIN_OUTPUT_LEN);

  process.env.STORYBOARD2HTML_MODEL = 'claude-opus-from-env';
  process.env.STORYBOARD2HTML_TIMEOUT_MS = '12345';
  process.env.STORYBOARD2HTML_MIN_OUTPUT_LEN = '777';
  assert.strictEqual(promptBuilder.resolveModel({}), 'claude-opus-from-env');
  assert.strictEqual(promptBuilder.resolveTimeoutMs({}), 12345);
  assert.strictEqual(promptBuilder.resolveMinOutputLen({}), 777);
  // opts override env
  assert.strictEqual(promptBuilder.resolveModel({ model: 'opt-wins' }), 'opt-wins');
  assert.strictEqual(promptBuilder.resolveTimeoutMs({ timeoutMs: 999 }), 999);
  assert.strictEqual(promptBuilder.resolveMinOutputLen({ minOutputLen: 4242 }), 4242);
} finally {
  if (prevModel === undefined) delete process.env.STORYBOARD2HTML_MODEL; else process.env.STORYBOARD2HTML_MODEL = prevModel;
  if (prevTimeout === undefined) delete process.env.STORYBOARD2HTML_TIMEOUT_MS; else process.env.STORYBOARD2HTML_TIMEOUT_MS = prevTimeout;
  if (prevMinLen === undefined) delete process.env.STORYBOARD2HTML_MIN_OUTPUT_LEN; else process.env.STORYBOARD2HTML_MIN_OUTPUT_LEN = prevMinLen;
}

// Bundle validation
assert.strictEqual(promptBuilder.validateBundle(bundle), true);
assert.throws(function() { promptBuilder.validateBundle({ kind: 'wrong' }); });
assert.throws(function() { promptBuilder.validateBundle({ specs: [] }); });
assert.throws(function() { promptBuilder.buildStoryboard2HtmlPrompt({ specs: [] }); });

// CLI prompt dumper
var tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storyboard2html-prompt-test-'));
var bundlePath = path.join(tempDir, 'bundle.json');
var outPath = path.join(tempDir, 'prompt.txt');
fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));
var promptCliResult = spawnSync(process.execPath, [
  path.join(__dirname, '..', 'scripts', 'storyboard2html-prompt.cjs'),
  bundlePath,
  '--out',
  outPath,
], { encoding: 'utf8', cwd: path.join(__dirname, '..') });
assert.strictEqual(promptCliResult.status, 0, promptCliResult.stderr || promptCliResult.stdout);
var dumped = fs.readFileSync(outPath, 'utf8');
assert.ok(dumped.indexOf('=== SYSTEM PROMPT ===') >= 0);
assert.ok(dumped.indexOf('=== USER PROMPT ===') >= 0);
assert.ok(dumped.indexOf('FarmStoryboard') >= 0);

// Generate CLI dry-run from raw blueprint (also exercises buildStoryboard2HtmlInput path)
var blueprintPath = path.join(tempDir, 'blueprint.json');
fs.writeFileSync(blueprintPath, JSON.stringify(blueprint, null, 2));
var generateDry = spawnSync(process.execPath, [
  path.join(__dirname, '..', 'scripts', 'storyboard2html-generate.cjs'),
  blueprintPath,
  path.join(tempDir, 'generated.html'),
  '--dry-run',
  '--theme',
  'farming',
  '--steps',
  '12',
], { encoding: 'utf8', cwd: path.join(__dirname, '..') });
assert.strictEqual(generateDry.status, 0, generateDry.stderr || generateDry.stdout);
assert.ok(generateDry.stdout.indexOf('dry-run plan:') >= 0);
assert.ok(generateDry.stdout.indexOf('phases:       3') >= 0);
assert.ok(generateDry.stdout.indexOf('themeHint:    farming') >= 0);

// Generate CLI --prompt-only mode (no LLM call) from an already-built input bundle
var promptOnlyPath = path.join(tempDir, 'generate-prompt-only.txt');
var generatePromptOnly = spawnSync(process.execPath, [
  path.join(__dirname, '..', 'scripts', 'storyboard2html-generate.cjs'),
  bundlePath,
  path.join(tempDir, 'unused.html'),
  '--prompt-only',
  promptOnlyPath,
], { encoding: 'utf8', cwd: path.join(__dirname, '..') });
assert.strictEqual(generatePromptOnly.status, 0, generatePromptOnly.stderr || generatePromptOnly.stdout);
var promptOnly = fs.readFileSync(promptOnlyPath, 'utf8');
assert.ok(promptOnly.indexOf('=== SYSTEM ===') >= 0);
assert.ok(promptOnly.indexOf('=== USER ===') >= 0);
assert.ok(promptOnly.indexOf('FarmStoryboard') >= 0);

console.log('storyboard2html prompt tests passed');
