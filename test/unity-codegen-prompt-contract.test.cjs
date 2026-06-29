'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');

var schemaPrompt = require('../engine/stages/build-schema-prompt-v3.cjs');
var promptV4 = require('../worker/prompt-v4.js');
var promptV5 = require('../worker/prompt-v5-basetemplate.js');
var codeReviewer = require('../worker/code-reviewer.js');

var blueprint = {
  projectName: 'PromptContract',
  entities: [
    { name: 'Player', template: 'PlayerController', visual: { position: '(0,0,0)' } },
    { name: 'Crate', template: 'Static', visual: { position: '(1,0,0)' } },
  ],
  specs: [
    {
      phaseId: 'collectCrate',
      phaseName: '收集箱子',
      playerInstruction: '拖动角色靠近箱子',
      requiredInteractions: ['move_to:Crate'],
      entitiesRequired: [{ entity: 'Crate' }],
    },
  ],
};

function assertDeliveryContract(text, label) {
  assert.ok(text.indexOf('gmp-v14') >= 0, label + ' should scope the default prompt to gmp-v14 legacy');
  assert.ok(text.indexOf('unitycomponent-v1') >= 0, label + ' should mention the explicit unitycomponent-v1 profile');
  assert.ok(text.indexOf('不使用 GMP 命名') >= 0, label + ' should state that unitycomponent-v1 does not use GMP naming');
  assert.ok(text.indexOf('Assets/SLGFrameWork/Scripts') >= 0, label + ' should route unitycomponent-v1 to the SLGFrameWork script root');
  assert.ok(text.indexOf('Blueprint.UnityComponent') >= 0 && text.indexOf('namespace/asmdef') >= 0, label + ' should explicitly reject the old generated namespace/asmdef v1 shape');
  assert.ok(text.indexOf('UnityDeliverySpec') >= 0, label + ' should route unitycomponent-v1 through UnityDeliverySpec');
  assert.ok(text.indexOf('v1 hardgate') >= 0, label + ' should require the unitycomponent-v1 hardgate before cutover');
  assert.ok(text.indexOf('N=10 cold-export corpus') >= 0, label + ' should mention the v1 cold-export corpus gate');
  assert.ok(text.indexOf('已作为文件级 gate 通过') >= 0, label + ' should state the current N=10 file-level gate status');
  assert.ok(text.indexOf('默认切换仍需显式 cutover 决策') >= 0, label + ' should keep default cutover as an explicit decision');
  assert.ok(
    text.indexOf('当前默认 `gmp-v14` legacy 落地到本工程必须使用 GMP 命名') >= 0 ||
    text.indexOf('当前默认 gmp-v14 legacy 落地到本工程必须使用 GMP 命名') >= 0,
    label + ' should scope GMP naming to the current default gmp-v14 legacy prompt'
  );
  assert.strictEqual(text.indexOf('2.2 落地到本工程必须使用 GMP 命名'), -1, label + ' must not restore unscoped GMP naming as the global framework rule');
  assert.strictEqual(text.indexOf('`Assets/Scripts/Base` / `Data` / `Tool` / `Game`'), -1, label + ' must not restore the old abstract v1 layer layout');
  assert.strictEqual(text.indexOf('Assets/Scripts/Base / Data / Tool / Game'), -1, label + ' must not restore the old abstract v1 layer layout');
  assert.ok(text.indexOf('AIBridge/MCP') >= 0, label + ' should mention AIBridge/MCP hydration');
  assert.ok(text.indexOf('UnityComponent(3)') >= 0, label + ' should mention the UnityComponent(3) framework authority');
  assert.ok(text.indexOf('/nickTemp/UnityComponent(3).rar') >= 0, label + ' should cite the UnityComponent(3) reference archive');
  assert.ok(text.indexOf('GMP_BaseComponent') >= 0, label + ' should require the pure-logic base component');
  assert.ok(text.indexOf('GMP_EntityManager') >= 0, label + ' should require the EntityManager module');
  assert.ok(text.indexOf('组件必须是真能力') >= 0, label + ' should reject decorative component-only framework additions');
  assert.ok(text.indexOf('不要把所有组件默认塞进 Player') >= 0, label + ' should forbid adding every optional component to Player by default');
  assert.ok(text.indexOf('GMP_BaseGameFlowEntity') >= 0 && text.indexOf('只负责身份绑定') >= 0, label + ' should keep the base Entity lean');
  assert.ok(text.indexOf('可见性、位移、交互计数、完成状态') >= 0, label + ' should keep gameplay convenience APIs out of the base Entity');
  assert.ok(text.indexOf('短生命周期') >= 0 && text.indexOf('GMP_Pool') >= 0, label + ' should route transient repeated objects through Pool');
  assert.ok(text.indexOf('1000 个 serialized refs') >= 0, label + ' should forbid expanding repeated transient objects into SceneEntityRefs');
  assert.ok(text.indexOf('跨脚本调用') >= 0 && text.indexOf('GMP_EventModule.Subscribe/Publish/Unsubscribe') >= 0, label + ' should require an explicit cross-script communication channel');
  assert.ok(text.indexOf('AddEcsComponent') >= 0, label + ' should require Entity component registration API');
  assert.ok(text.indexOf('GetEcsComponent<T>') >= 0, label + ' should require typed Entity component lookup API');
  assert.ok(text.indexOf('GetFirstEcsComponent<T>') >= 0, label + ' should require assignable Entity component lookup API');
  assert.ok(text.indexOf('HasEcsComponent<T>') >= 0, label + ' should require Entity component existence API');
  assert.ok(text.indexOf('OnAwake -> OnEnable -> OnStart -> OnUpdate -> OnDisable -> OnDestroy') >= 0, label + ' should require the UnityComponent lifecycle order');
  assert.ok(text.indexOf('GameEntry') >= 0, label + ' should map GMP_MainManager to the reference GameEntry role');
  assert.ok(text.indexOf('Storyboard2HTML') >= 0 || text.indexOf('storyboard2html') >= 0, label + ' should protect storyboard2html/source HTML consistency');
  assert.ok(text.indexOf('Inspector') >= 0, label + ' should mention Inspector hydration');
  assert.ok(text.indexOf('GMP_SceneEntityRefs') >= 0, label + ' should mention GMP_SceneEntityRefs as the explicit scene refs entry');
  assert.ok(text.indexOf('serialized refs') >= 0, label + ' should mention serialized refs');
  assert.ok(text.indexOf('通用 object binding 表') >= 0, label + ' should forbid generic object binding tables in programmer delivery');
  assert.ok(text.indexOf('隐藏运行时对象表') >= 0, label + ' should forbid hidden runtime object registries in programmer delivery');
  assert.ok(text.indexOf('逻辑与表现分离') >= 0, label + ' should require logic/visual separation');
  assert.ok(text.indexOf('注释只写关键') >= 0, label + ' should require sparse plain Chinese comments');
  assert.ok(text.indexOf('复杂脚本参数说明') >= 0, label + ' should explain parameters for complex scripts');
  assert.ok(text.indexOf('有意义的空行分块') >= 0, label + ' should require meaningful blank-line grouping');
  assert.ok(text.indexOf('程序员可交付反馈规则') >= 0, label + ' should carry consolidated programmer-delivery feedback rules');
  assert.ok(text.indexOf('一节点一主脚本') >= 0, label + ' should require one primary script per node');
  assert.ok(text.indexOf('无生命周期能力') >= 0, label + ' should keep lifecycle-free abilities as plain classes');
  assert.ok(text.indexOf('只保留会被调用的方法') >= 0, label + ' should forbid dead unused methods');
  assert.ok(text.indexOf('必要兜底') >= 0, label + ' should forbid excessive fallback code');
  assert.ok(text.indexOf('Missing Mono Script') >= 0, label + ' should route missing script cleanup through scene/editor hydration');
  assert.ok(text.indexOf('静态 Init/Get/Return') >= 0, label + ' should forbid static workflow methods in singleton managers');
  assert.ok(text.indexOf('sqrMagnitude') >= 0, label + ' should require squared-distance threshold checks');
  assert.ok(text.indexOf('MoveSpeed 归 MovementComponent') >= 0, label + ' should keep tunable data on the owning component');
  assert.ok(text.indexOf('Init/Configure/Setup 未被调用就删除') >= 0, label + ' should remove unused setup entrypoints');
  assert.ok(text.indexOf('Awake/Start') >= 0, label + ' should avoid parallel Init when Mono lifecycle owns setup');
  assert.ok(text.indexOf('固定 Player 引用') >= 0, label + ' should require fixed player references');
  assert.ok(text.indexOf('Debug.LogError') >= 0, label + ' should fail missing references loudly without fallback complexity');
  assert.ok(text.indexOf('连续试玩流程') >= 0, label + ' should define phase as one continuous playable flow');
  assert.ok(text.indexOf('Flow01_<业务语义>') >= 0, label + ' should require semantic flow asset naming');
  assert.ok(text.indexOf('flow01_<业务语义>') >= 0, label + ' should require semantic flow preset ids');
  assert.ok(text.indexOf('重置全场') >= 0, label + ' should forbid phase-as-level-reset behavior');
  assert.ok(text.indexOf('AIBridge 预水合') >= 0, label + ' should require editor-side hydration before runtime');
  assert.ok(text.indexOf('临时脚本') >= 0, label + ' should remove one-off temporary generation scripts from delivery');
  assert.ok(
    text.indexOf('实际运行 AIBridgeCLI') >= 0 ||
    text.indexOf('actually running AIBridgeCLI') >= 0 ||
    text.indexOf('actually run AIBridgeCLI') >= 0,
    label + ' should require a real AIBridgeCLI run, not static guessing'
  );
  assert.ok(text.indexOf('AIBRIDGE_CLI') >= 0, label + ' should require explicit AIBRIDGE_CLI path evidence');
  assert.ok(text.indexOf('command -v AIBridgeCLI') >= 0, label + ' should require PATH-based CLI discovery evidence');
  assert.ok(text.indexOf('harness status') >= 0, label + ' should require AIBridge harness status probe');
  assert.ok(text.indexOf('editor get_state') >= 0, label + ' should require live Editor state probe');
  assert.ok(text.indexOf('stdout/stderr/exit code') >= 0, label + ' should require recording AIBridge probe stdout/stderr/exit code');
  assert.ok(text.indexOf('editor-timeout') >= 0, label + ' should distinguish Editor timeout from CLI discovery failure');
  assert.ok(text.indexOf('CLI not found') >= 0, label + ' should forbid misreporting Editor timeout as CLI not found');
  assert.ok(text.indexOf('Editor hydration 未完成时不能把 Unity 包标记为最终交付认证通过') >= 0, label + ' should block final Unity certification without live Editor hydration');
  assert.ok(text.indexOf('MonoSingleton<T>') >= 0, label + ' should explicitly forbid MonoSingleton manager inheritance');
  assert.ok(text.indexOf('mInstance') >= 0 && text.indexOf('只读 `instance`') >= 0, label + ' should require scene-mounted mInstance/instance managers');
  assert.ok(text.indexOf('MainGame') >= 0, label + ' should require code/manager hierarchy grouping under MainGame');
  assert.ok(text.indexOf('CanvasScaler') >= 0, label + ' should include the CanvasScaler delivery standard');
  assert.ok(text.indexOf('1080x1920') >= 0, label + ' should require the 1080x1920 Canvas reference resolution');
  assert.ok(text.indexOf('Match = 0.5') >= 0 || text.indexOf('Match 0.5') >= 0, label + ' should require Canvas match 0.5');
  assert.ok(text.indexOf('GMP_EventModule') >= 0, label + ' should mention the delivery EventModule contract');
  assert.ok(text.indexOf('Subscribe') >= 0 && text.indexOf('UnSubScribe') >= 0, label + ' should require explicit event subscribe/unsubscribe APIs');
  assert.ok(text.indexOf('mLoopSources') >= 0 && text.indexOf('mOneShotSources') >= 0, label + ' should require centralized multi-source audio fields');
  assert.ok(text.indexOf('流程如何修改、删除、增加') >= 0 || text.indexOf('流程修改、删除、增加') >= 0, label + ' should require flow edit/delete/add handoff guidance');
  assert.strictEqual(text.indexOf('GMP_EntityBindingManager'), -1, label + ' must not restore the legacy binding manager as the positive entry');
  assert.strictEqual(text.indexOf('mBindings'), -1, label + ' must not restore mBindings as the positive entry');
}

var schemaText = schemaPrompt.buildSchemaPromptV3({ blueprint: blueprint });
var v5Text = promptV5.parseBlueprintToPromptV5(blueprint);
var v4Text = promptV4.parseBlueprintToPromptV4(blueprint);
var lunaCodexText = fs.readFileSync(path.join(__dirname, '../worker/luna-codex-code.md'), 'utf8');
var behaviorTemplateText = fs.readFileSync(path.join(__dirname, '../worker/behavior-templates.md'), 'utf8');
var promptSummaryText = fs.readFileSync(path.join(__dirname, '../docs/unity-codegen-prompts-current.md'), 'utf8');
var workerCoderText = fs.readFileSync(path.join(__dirname, '../worker/worker-coder.js'), 'utf8');
var codexCodeCoderText = fs.readFileSync(path.join(__dirname, '../worker/codex-code-coder.js'), 'utf8');
var codexReviewerText = fs.readFileSync(path.join(__dirname, '../worker/codex-reviewer.js'), 'utf8');
var staticCheckText = fs.readFileSync(path.join(__dirname, '../engine/static-check.cjs'), 'utf8');
var reviewStageText = fs.readFileSync(path.join(__dirname, '../engine/stages/review.cjs'), 'utf8');
var codegenLegacyText = fs.readFileSync(path.join(__dirname, '../engine/stages/codegen-legacy.cjs'), 'utf8');
var codeReviewerText = fs.readFileSync(path.join(__dirname, '../worker/code-reviewer.js'), 'utf8');
var commentLocalizerText = fs.readFileSync(path.join(__dirname, '../lib/csharp-comment-localizer.cjs'), 'utf8');
var handoffDocGeneratorText = fs.readFileSync(path.join(__dirname, '../lib/handoff-doc-generator.cjs'), 'utf8');
var promotedRulesText = fs.readFileSync(path.join(__dirname, '../worker/promoted-rules.json'), 'utf8');
var pendingRulesText = fs.readFileSync(path.join(__dirname, '../worker/pending-rules.json'), 'utf8');
var lessonExtractorText = fs.readFileSync(path.join(__dirname, '../engine/lesson-extractor.cjs'), 'utf8');
var pendingRuleCandidatesText = fs.readFileSync(path.join(__dirname, '../engine/pending-rule-candidates.cjs'), 'utf8');
var exportUnityProjectText = fs.readFileSync(path.join(__dirname, '../scripts/export-unity-project.sh'), 'utf8');
var codeRelationGraphText = fs.readFileSync(path.join(__dirname, '../lib/code-relation-graph-writer.cjs'), 'utf8');
var engineHelpersText = fs.readFileSync(path.join(__dirname, '../engine/helpers.cjs'), 'utf8');

var sanitizedLearningRule = codeReviewer.sanitizeLearningRuleText(
  'Use GameObject.Find("__Pool_Cube_Red_01") to get a red cube. Available shapes: Cube, Sphere, Cylinder, Plane. Available colors: Red, Blue, Green, Yellow, Orange, Purple, White, Brown, Cyan, Pink.'
);
assert.strictEqual(sanitizedLearningRule.indexOf('Use GameObject.Find("__Pool_Cube_Red_01")'), -1, 'learned-rule sanitizer must rewrite direct pool Find advice');
assert.ok(sanitizedLearningRule.indexOf('entity-to-pool binding map') >= 0, 'learned-rule sanitizer should redirect to entity-to-pool bindings');

assertDeliveryContract(schemaText, 'schema prompt contract');
assertDeliveryContract(v5Text, 'v5 prompt');
assertDeliveryContract(v4Text, 'v4 prompt');
assertDeliveryContract(lunaCodexText, 'luna codex prompt');
assertDeliveryContract(workerCoderText, 'worker coder prompt');

assert.ok(promptSummaryText.indexOf('gmp-v14 legacy') >= 0, 'prompt summary should describe the default gmp-v14 legacy profile');
assert.ok(promptSummaryText.indexOf('unitycomponent-v1') >= 0, 'prompt summary should describe the explicit unitycomponent-v1 profile');
assert.ok(promptSummaryText.indexOf('不使用 GMP 命名') >= 0, 'prompt summary should state that unitycomponent-v1 does not use GMP naming');
assert.ok(promptSummaryText.indexOf('Assets/SLGFrameWork/Scripts') >= 0, 'prompt summary should route unitycomponent-v1 to SLGFrameWork');
assert.ok(promptSummaryText.indexOf('UnityDeliverySpec') >= 0, 'prompt summary should route unitycomponent-v1 through UnityDeliverySpec');
assert.ok(promptSummaryText.indexOf('N=10 cold-export corpus') >= 0, 'prompt summary should mention the N=10 cold-export corpus gate');
assert.ok(promptSummaryText.indexOf('已作为文件级 gate 通过') >= 0, 'prompt summary should state the current N=10 file-level gate status');
assert.ok(promptSummaryText.indexOf('默认切换仍需显式 cutover 决策') >= 0, 'prompt summary should keep default cutover as an explicit decision');
assert.ok(promptSummaryText.indexOf('storyboard2html/source HTML/WebGL') >= 0, 'prompt summary should preserve the source HTML/WebGL redline');
assert.strictEqual(promptSummaryText.indexOf('2026-06-22 之后，程序员 Unity 交付框架冲突'), -1, 'prompt summary must not retain the stale unprofiled 2026-06-22 framing');

assert.ok(v5Text.indexOf('GameSceneCtrl.instance.Get') >= 0, 'v5 prompt should show binding-based object access');
assert.ok(v5Text.indexOf('不要在 TODO 区') >= 0 && v5Text.indexOf('GameObject.Find("__Pool_*")') >= 0,
  'v5 prompt should forbid business TODO Find fallback');
assert.ok(v4Text.indexOf('只有 V4 staging 绑定层才可兜底解析 `__Pool_*`') >= 0, 'v4 prompt should fence legacy pool lookup to staging binding');
assert.ok(behaviorTemplateText.indexOf('本文件只给 Luna/WebGL staging 代码参考') >= 0, 'behavior templates should be marked staging-only');
assert.ok(behaviorTemplateText.indexOf('gmp-v14') >= 0, 'behavior templates should scope the default prompt to gmp-v14 legacy');
assert.ok(behaviorTemplateText.indexOf('unitycomponent-v1') >= 0, 'behavior templates should mention the explicit unitycomponent-v1 profile');
assert.ok(behaviorTemplateText.indexOf('不使用 GMP 命名') >= 0, 'behavior templates should state that unitycomponent-v1 does not use GMP naming');
assert.ok(behaviorTemplateText.indexOf('Assets/SLGFrameWork/Scripts') >= 0, 'behavior templates should route unitycomponent-v1 to SLGFrameWork');
assert.ok(behaviorTemplateText.indexOf('UnityDeliverySpec') >= 0, 'behavior templates should route unitycomponent-v1 through UnityDeliverySpec');
assert.ok(behaviorTemplateText.indexOf('N=10 cold-export corpus') >= 0, 'behavior templates should mention the cold-export corpus gate');
assert.ok(behaviorTemplateText.indexOf('UnityComponent(3)') >= 0, 'behavior templates should cite the UnityComponent(3) framework authority');
assert.ok(behaviorTemplateText.indexOf('GMP_BaseComponent') >= 0 && behaviorTemplateText.indexOf('GMP_EntityManager') >= 0, 'behavior templates should carry the UnityComponent-derived GMP framework names');
assert.ok(behaviorTemplateText.indexOf('AddEcsComponent') >= 0 && behaviorTemplateText.indexOf('GetEcsComponent<T>') >= 0, 'behavior templates should carry the Entity component API');
assert.ok(behaviorTemplateText.indexOf('OnAwake -> OnEnable -> OnStart -> OnUpdate -> OnDisable -> OnDestroy') >= 0, 'behavior templates should carry the UnityComponent lifecycle order');
assert.ok(behaviorTemplateText.indexOf('程序员可交付反馈规则') >= 0, 'behavior templates should carry programmer-delivery feedback warnings');
assert.ok(behaviorTemplateText.indexOf('复杂脚本参数说明') >= 0, 'behavior templates should carry complex-script parameter guidance');
assert.ok(behaviorTemplateText.indexOf('有意义的空行分块') >= 0, 'behavior templates should carry meaningful blank-line grouping guidance');
assert.ok(behaviorTemplateText.indexOf('MoveSpeed 归 MovementComponent') >= 0, 'behavior templates should keep tunable data on components');
assert.ok(behaviorTemplateText.indexOf('固定 Player 引用') >= 0, 'behavior templates should require fixed player references');
assert.ok(behaviorTemplateText.indexOf('连续试玩流程') >= 0, 'behavior templates should define phase as continuous flow');
assert.ok(behaviorTemplateText.indexOf('AIBridge 预水合') >= 0, 'behavior templates should require editor-side hydration cleanup');
assert.ok(behaviorTemplateText.indexOf('MainGame') >= 0, 'behavior templates should require code objects under MainGame');
assert.ok(behaviorTemplateText.indexOf('1080x1920') >= 0 && behaviorTemplateText.indexOf('Match 0.5') >= 0, 'behavior templates should carry the Canvas standard');
assert.ok(behaviorTemplateText.indexOf('UnSubScribe') >= 0, 'behavior templates should carry the event unsubscribe alias');
assert.ok(behaviorTemplateText.indexOf('mLoopSources') >= 0 && behaviorTemplateText.indexOf('mOneShotSources') >= 0, 'behavior templates should carry the multi-source audio contract');
assert.ok(behaviorTemplateText.indexOf('流程修改、删除、增加') >= 0, 'behavior templates should require flow edit guidance');
assert.ok(behaviorTemplateText.indexOf('隐藏运行时对象表') >= 0, 'behavior templates should forbid hidden runtime object registries in programmer delivery');
assert.ok(behaviorTemplateText.indexOf('GMP_SceneEntityRefs') >= 0, 'behavior templates should point final delivery to explicit scene refs');
assert.ok(behaviorTemplateText.indexOf('通用 object binding 表') >= 0, 'behavior templates should forbid generic object binding tables');
assert.ok(behaviorTemplateText.indexOf('组件必须是真能力') >= 0, 'behavior templates should reject decorative component-only framework additions');
assert.ok(behaviorTemplateText.indexOf('1000 个 serialized refs') >= 0, 'behavior templates should route repeated transient objects to GMP_Pool');
assert.ok(behaviorTemplateText.indexOf('EventModule') >= 0 && behaviorTemplateText.indexOf('instance.') >= 0, 'behavior templates should describe explicit communication boundaries');
assert.ok(behaviorTemplateText.indexOf('Editor hydration 未完成时不能把 Unity 包标记为最终交付认证通过') >= 0, 'behavior templates should block final certification without live Editor hydration');
assert.strictEqual(behaviorTemplateText.indexOf('> 本文件只给 Luna/WebGL staging 代码参考。程序员 Unity 交付版必须由 AIBridge/MCP 做 Inspector/scene hydration，引用进入 `GMP_SceneEntityRefs`'), -1, 'behavior templates must not scope all programmer delivery to GMP refs');
assert.ok(codexCodeCoderText.indexOf('程序员可交付反馈规则') >= 0, 'codex fix prompt should carry programmer-delivery feedback warnings');
assert.ok(codexCodeCoderText.indexOf('gmp-v14') >= 0, 'codex fix prompt should scope the default prompt to gmp-v14 legacy');
assert.ok(codexCodeCoderText.indexOf('unitycomponent-v1') >= 0, 'codex fix prompt should mention the explicit unitycomponent-v1 profile');
assert.ok(codexCodeCoderText.indexOf('不使用 GMP 命名') >= 0, 'codex fix prompt should state that unitycomponent-v1 does not use GMP naming');
assert.ok(codexCodeCoderText.indexOf('Assets/SLGFrameWork/Scripts') >= 0, 'codex fix prompt should route unitycomponent-v1 to SLGFrameWork');
assert.ok(codexCodeCoderText.indexOf('UnityDeliverySpec') >= 0, 'codex fix prompt should route unitycomponent-v1 through UnityDeliverySpec');
assert.ok(codexCodeCoderText.indexOf('N=10 cold-export corpus') >= 0, 'codex fix prompt should mention the cold-export corpus gate');
assert.ok(codexCodeCoderText.indexOf('UnityComponent(3)') >= 0, 'codex fix prompt should cite the UnityComponent(3) framework authority');
assert.ok(codexCodeCoderText.indexOf('/nickTemp/UnityComponent(3).rar') >= 0, 'codex fix prompt should cite the UnityComponent(3) reference archive');
assert.ok(codexCodeCoderText.indexOf('GMP_BaseComponent') >= 0 && codexCodeCoderText.indexOf('GMP_EntityManager') >= 0, 'codex fix prompt should carry the UnityComponent-derived GMP framework names');
assert.ok(codexCodeCoderText.indexOf('AddEcsComponent') >= 0 && codexCodeCoderText.indexOf('GetEcsComponent<T>') >= 0, 'codex fix prompt should carry the Entity component API');
assert.ok(codexCodeCoderText.indexOf('OnAwake -> OnEnable -> OnStart -> OnUpdate -> OnDisable -> OnDestroy') >= 0, 'codex fix prompt should carry the UnityComponent lifecycle order');
assert.ok(codexCodeCoderText.indexOf('复杂脚本参数说明') >= 0, 'codex fix prompt should carry complex-script parameter guidance');
assert.ok(codexCodeCoderText.indexOf('有意义的空行分块') >= 0, 'codex fix prompt should carry meaningful blank-line grouping guidance');
assert.ok(codexCodeCoderText.indexOf('MoveSpeed 归 MovementComponent') >= 0, 'codex fix prompt should keep tunable data on components');
assert.ok(codexCodeCoderText.indexOf('固定 Player 引用') >= 0, 'codex fix prompt should require fixed player references');
assert.ok(codexCodeCoderText.indexOf('连续试玩流程') >= 0, 'codex fix prompt should define phase as continuous flow');
assert.ok(codexCodeCoderText.indexOf('AIBridge 预水合') >= 0, 'codex fix prompt should require editor-side hydration cleanup');
assert.ok(codexCodeCoderText.indexOf('MainGame') >= 0, 'codex fix prompt should require code objects under MainGame');
assert.ok(codexCodeCoderText.indexOf('1080x1920') >= 0 && codexCodeCoderText.indexOf('Match 0.5') >= 0, 'codex fix prompt should carry the Canvas standard');
assert.ok(codexCodeCoderText.indexOf('UnSubScribe') >= 0, 'codex fix prompt should carry the event unsubscribe alias');
assert.ok(codexCodeCoderText.indexOf('mLoopSources') >= 0 && codexCodeCoderText.indexOf('mOneShotSources') >= 0, 'codex fix prompt should carry the multi-source audio contract');
assert.ok(codexCodeCoderText.indexOf('流程修改、删除、增加') >= 0, 'codex fix prompt should require flow edit guidance');
assert.ok(codexCodeCoderText.indexOf('隐藏运行时对象表') >= 0, 'codex fix prompt should forbid hidden runtime object registries in programmer delivery');
assert.ok(codexCodeCoderText.indexOf('GMP_SceneEntityRefs') >= 0, 'codex fix prompt should point final delivery to explicit scene refs');
assert.ok(codexCodeCoderText.indexOf('通用 object binding 表') >= 0, 'codex fix prompt should forbid generic object binding tables');
assert.ok(codexCodeCoderText.indexOf('组件必须是真能力') >= 0, 'codex fix prompt should reject decorative component-only framework additions');
assert.ok(codexCodeCoderText.indexOf('1000 个 serialized refs') >= 0, 'codex fix prompt should route repeated transient objects to GMP_Pool');
assert.ok(codexCodeCoderText.indexOf('GMP_EventModule.Subscribe/Publish/Unsubscribe') >= 0, 'codex fix prompt should describe explicit communication boundaries');
assert.ok(codexCodeCoderText.indexOf('Editor hydration 未完成时不能把 Unity 包标记为最终交付认证通过') >= 0, 'codex fix prompt should block final certification without live Editor hydration');
assert.strictEqual(codexCodeCoderText.indexOf("  '程序员可交付反馈规则：最终 Unity 交付必须包含 AIBridge/MCP、Inspector hydration、GMP_SceneEntityRefs"), -1, 'codex fix prompt must not scope all final Unity delivery to GMP refs');
assert.strictEqual(codexCodeCoderText.indexOf('程序员 Unity 交付必须由 AIBridge 写入 `GMP_SceneEntityRefs`/serialized refs'), -1, 'codex fix prompt must scope GMP refs to gmp-v14 legacy');
assert.strictEqual(v4Text.indexOf('V4 staging 可用平行数组管理实体状态: eGo[], eActive[], eState[], eTimer[], eHP[]；程序员交付版必须收口到 `GMP_SceneEntityRefs`/serialized refs'), -1, 'v4 prompt must not scope all programmer delivery to GMP refs');

assert.strictEqual(v5Text.indexOf('每个字段声明都必须有详细中文注释'), -1, 'v5 prompt must not require field-by-field boilerplate comments');
assert.strictEqual(v5Text.indexOf('每个方法都必须有详细中文注释'), -1, 'v5 prompt must not require method-by-method boilerplate comments');
assert.strictEqual(v5Text.indexOf('Instantiate 溢出时可用'), -1, 'v5 prompt must not describe Instantiate as a reserve-pool fallback');
assert.strictEqual(v5Text.indexOf('可以 Instantiate'), -1, 'v5 prompt must not suggest Instantiate as allowed');
assert.ok(v5Text.indexOf('sqrMagnitude') >= 0, 'v5 prompt should teach squared-distance gate checks');
assert.strictEqual(v5Text.indexOf('Vector3.Distance(a.position, b.position) < radius'), -1, 'v5 prompt must not teach Vector3.Distance threshold checks');
assert.strictEqual(v5Text.indexOf('正确代码模式参考（直接照抄'), -1, 'v5 prompt must not tell coders to copy placeholder entity names directly');
assert.strictEqual(v4Text.indexOf('每个字段、每个方法、每个条件分支都必须写详细注释'), -1, 'v4 prompt must not require boilerplate comments everywhere');
assert.strictEqual(lunaCodexText.indexOf('`GameObject.Find("名称")` 获取对象引用'), -1, 'luna codex prompt must not teach direct object Find as the default');
assert.strictEqual(lunaCodexText.indexOf('guideText.text ='), -1, 'luna codex prompt must route guide text through SetGuideText');
assert.strictEqual(lunaCodexText.indexOf('碰撞检测: `Vector3.Distance'), -1, 'luna codex prompt must not teach Vector3.Distance threshold checks');
assert.strictEqual(workerCoderText.indexOf('MUST create visible game objects (GFM_Create.Obj, UI elements)'), -1, 'worker prompt must not require GFM_Create-created objects');
assert.strictEqual(workerCoderText.indexOf('Create ALL Scene Objects from Blueprint'), -1, 'worker prompt must use bind/represent wording instead of runtime creation wording');
assert.strictEqual(workerCoderText.indexOf('If a fix requires new visible objects, use GFM_Create.Obj'), -1, 'fix prompt must not recommend GFM_Create for new visible objects');
assert.strictEqual(workerCoderText.indexOf('create initially with SetActive(false)'), -1, 'worker prompt must not suggest SetActive-based later-shot setup');
assert.strictEqual(workerCoderText.indexOf('No GFM_Create.Obj() calls found'), -1, 'verification must not warn when GFM_Create is absent');
assert.strictEqual(workerCoderText.indexOf('No binding refs or legacy GameObject.Find() calls'), -1, 'verification must not treat legacy Find as an acceptable positive signal');
assert.strictEqual(workerCoderText.indexOf('Collision detection: Vector3.Distance'), -1, 'worker prompt must not teach Vector3.Distance threshold checks');
assert.strictEqual(workerCoderText.indexOf('3D objects already exist through AIBridge/MCP Inspector hydration; access them through bound fields or GameSceneCtrl'), -1, 'worker prompt must not conflate AIBridge hydration with GameSceneCtrl access');
assert.strictEqual(workerCoderText.indexOf('Scene entities are pre-bound by AIBridge/MCP hydration'), -1, 'worker prompt must not describe GameSceneCtrl staging bindings as AIBridge hydration');
assert.strictEqual(workerCoderText.indexOf('should use existing bindings / GameSceneCtrl instead'), -1, 'worker logs must not name GameSceneCtrl as the generic current-delivery replacement');
assert.ok(workerCoderText.indexOf('Luna/WebGL staging accesses them through bound fields or GameSceneCtrl') >= 0, 'worker prompt should fence GameSceneCtrl to Luna/WebGL staging');
assert.ok(workerCoderText.indexOf('programmer delivery accesses them through AIBridge/MCP Inspector-hydrated serialized refs') >= 0, 'worker prompt should point programmer delivery to Inspector-hydrated serialized refs');
assert.strictEqual(workerCoderText.indexOf('FindObjectOfType(typeof($1))'), -1, 'worker post-fix must not rewrite FindObjectOfType into another scene scan');
assert.strictEqual(codexCodeCoderText.indexOf('FindObjectOfType(typeof($1))'), -1, 'codex post-fix must not rewrite FindObjectOfType into another scene scan');
assert.strictEqual(codexCodeCoderText.indexOf('should use existing bindings / GameSceneCtrl instead'), -1, 'codex logs must not name GameSceneCtrl as the generic current-delivery replacement');
assert.ok(codexCodeCoderText.indexOf('programmer delivery should use Inspector-hydrated refs') >= 0, 'codex logs should separate staging bindings from programmer delivery refs');
assert.strictEqual(staticCheckText.indexOf('use GameObject.Find() from pool'), -1, 'static-check feedback must not ask the model to use GameObject.Find');
assert.ok(staticCheckText.indexOf('programmer delivery uses Inspector-hydrated GMP_SceneEntityRefs/serialized refs') >= 0, 'static-check feedback should route final programmer delivery away from GameSceneCtrl/pool lookups');
assert.strictEqual(engineHelpersText.indexOf('show/hide objects via SetActive'), -1, 'runtime fix hints must not recommend SetActive for visual changes');
assert.strictEqual(engineHelpersText.indexOf('GetComponent<Renderer>().material.color'), -1, 'runtime fix hints must not recommend runtime material color fixes');
assert.ok(engineHelpersText.indexOf('GMP_SceneEntityRefs/serialized refs') >= 0, 'runtime fix hints should preserve final programmer delivery ref guidance');
assert.strictEqual(reviewStageText.indexOf('No GameObject.Find or GFM_Create calls'), -1, 'review stage must not require legacy Find/GFM_Create as positive stub evidence');
assert.strictEqual(reviewStageText.indexOf('GMP_EntityBindingManager'), -1, 'review stage must not count legacy EntityBindingManager as a positive binding signal');
assert.strictEqual(reviewStageText.indexOf('mBindings|'), -1, 'review stage must not count legacy mBindings as a positive binding signal');
assert.strictEqual(codeReviewerText.indexOf('use GameObject.Find() to locate pre-existing pool objects'), -1, 'code reviewer must not suggest GameObject.Find as the replacement for GFM_Create.Obj');
assert.strictEqual(codeReviewerText.indexOf('All GameObject.Find() calls MUST use pool names'), -1, 'code reviewer must not treat direct pool Find as the positive object access model');
assert.strictEqual(codeReviewerText.indexOf('Use explicit string literals.'), -1, 'code reviewer must not recommend raw pool literals as the fix for dynamic pool names');
assert.ok(codeReviewerText.indexOf('final programmer delivery uses AIBridge/Inspector hydrated GMP_SceneEntityRefs or serialized refs') >= 0, 'code reviewer feedback should fence GameSceneCtrl to Luna/WebGL staging');
assert.ok(codeReviewerText.indexOf('sanitizeLearningRuleText') >= 0, 'code reviewer must sanitize learned rules before injection');
assert.ok(codegenLegacyText.indexOf('sanitizeLearningRuleText') >= 0, 'codegen promoted-rule injection must sanitize learned rule text');
assert.ok(codexReviewerText.indexOf('sanitizeLearningRuleText') >= 0, 'codex reviewer dynamic-rule injection must sanitize learned rule text');
assert.ok(lessonExtractorText.indexOf('sanitizeLearningRuleText') >= 0, 'lesson extractor must sanitize learned rule text before writing pending-rules');
assert.ok(pendingRuleCandidatesText.indexOf('sanitizeLearningRuleText') >= 0, 'pending-rule export candidates must sanitize learned rule text before mirroring');
assert.strictEqual(commentLocalizerText.indexOf('请使用 GameObject.Find()'), -1, 'comment localizer must not translate legacy advice into GameObject.Find guidance');
assert.strictEqual(commentLocalizerText.indexOf('回退：CreatePrimitive（Luna 中不会渲染，但可编译）'), -1, 'comment localizer must not preserve legacy CreatePrimitive fallback wording');
assert.strictEqual(commentLocalizerText.indexOf('GameSceneCtrl.cs：场景实体管理单例'), -1, 'comment localizer must not describe GameSceneCtrl as the final scene-management singleton');
assert.ok(commentLocalizerText.indexOf('程序员交付用 GMP_SceneEntityRefs/serialized refs') >= 0, 'comment localizer must fence legacy GameSceneCtrl comments to staging');
assert.strictEqual(handoffDocGeneratorText.indexOf('GameSceneCtrl.cs` 的实体绑定表里把 `__Pool_Cube_NN` 换成你的 prefab'), -1, 'handoff generator must not tell programmers to replace art through GameSceneCtrl');
assert.ok(handoffDocGeneratorText.indexOf('Luna/WebGL staging') >= 0 && handoffDocGeneratorText.indexOf('GMP_SceneEntityRefs') >= 0, 'handoff generator must distinguish staging from final programmer delivery');
assert.strictEqual(exportUnityProjectText.indexOf('实体引用只来自 RegisterEntityBindings()/GameSceneCtrl'), -1, 'export script handoff must not point programmer delivery entity refs to GameSceneCtrl');
assert.ok(exportUnityProjectText.indexOf('程序员交付实体引用只来自 GMP_SceneEntityRefs 或 serialized refs') >= 0, 'export script handoff should route programmer refs to SceneEntityRefs/serialized refs');
assert.strictEqual(codeRelationGraphText.indexOf('GameSceneCtrl.cs` 的实体绑定表'), -1, 'code relation graph must not point maintenance to GameSceneCtrl binding tables');
assert.ok(codeRelationGraphText.indexOf('serialized refs 或 `GMP_SceneEntityRefs`') >= 0, 'code relation graph should point maintenance to explicit refs');

[promotedRulesText, pendingRulesText].forEach(function(text, index) {
  var label = index === 0 ? 'promoted-rules' : 'pending-rules';
  assert.strictEqual(text.indexOf('Use GameObject.Find("__Pool_Cube_Red_01")'), -1, label + ' must not recommend direct GameObject.Find as a fix');
  assert.strictEqual(text.indexOf('pool objects found by explicit literal names'), -1, label + ' must not recommend raw pool literal lookup');
  assert.strictEqual(text.indexOf('located via GameObject.Find()'), -1, label + ' must not preserve legacy GameObject.Find pool guidance');
  assert.strictEqual(text.indexOf('Only use the exact approved pool names from the project mapping'), -1, label + ' must prefer entity-to-pool bindings over raw pool names');
  assert.strictEqual(text.indexOf('Replace with explicit string literals for each pooled object'), -1, label + ' must not recommend explicit raw pool literals');
  assert.strictEqual(text.indexOf('referenced by exact pool names'), -1, label + ' must not recommend exact raw pool names');
  assert.strictEqual(text.indexOf('exact provided pool-name literals'), -1, label + ' must not recommend exact raw pool-name literals');
});

console.log('unity codegen prompt contract tests passed');
