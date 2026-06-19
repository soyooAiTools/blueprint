const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cleaner = require('../lib/programmer-delivery-cleaner.cjs');
const cleanerInternals = cleaner._internals;
const cleanerSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'programmer-delivery-cleaner.cjs'), 'utf8');

assert.match(
  cleanerSource,
  /sourcePhaseContract && Array\.isArray\(data\.visualAssets\.sourcePhaseContract\.phases\)/,
  'programmer delivery cleaner should read source phases from visual manifest sourcePhaseContract'
);
assert.match(
  cleanerSource,
  /delivery-root\.asset-manifest\.json/,
  'programmer delivery cleaner should consider the Unity export root asset-manifest.json'
);
assert.match(
  cleanerSource,
  /rootSourceIr = readJsonIfExists\(path\.join\(root, 'source-scene-ir\.json'\)\) \|\| readJsonIfExists\(path\.join\(root, 'source-ir\.json'\)\)/,
  'programmer delivery cleaner should read source phases from export root SourceIR json'
);

assert.strictEqual(cleanerInternals.canonicalEntityName('Item__phase01_target'), 'ItemPhase01Target');
assert.strictEqual(cleanerInternals.unityEntityName('Item__phase01_target'), '_itemPhase01Target');
assert.strictEqual(cleanerInternals.normalizeDeliveryEntityName('Item__phase01_target', []), '_itemPhase01Target');
assert.strictEqual(cleanerInternals.normalizeDeliveryEntityName('_item__phase01_target', []), '_itemPhase01Target');
assert.strictEqual(cleanerInternals.normalizeDeliveryEntityName('Item__phase01_target', ['_itemPhase01Target']), '_itemPhase01Target');

const workerUiSource = fs.readFileSync(path.join(__dirname, '..', 'worker', 'GFM_UI.cs'), 'utf8');
const workerJoystickSource = fs.readFileSync(path.join(__dirname, '..', 'worker', 'GFM_Joystick.cs'), 'utf8');
const workerPlayerSource = fs.readFileSync(path.join(__dirname, '..', 'worker', 'GFM_Player.cs'), 'utf8');
assert.match(workerUiSource, /public static void ConfigureCanvasForCamera\(Canvas canvas\)/, 'UI helper should expose delivery canvas normalization');
assert.match(workerUiSource, /canvas\.renderMode = RenderMode\.ScreenSpaceOverlay/, 'UI helper should keep Canvas out of the camera render plane');
assert.match(workerUiSource, /canvas\.worldCamera = cam/, 'UI helper should bind Canvas to the main camera');
assert.match(workerUiSource, /ConfigureSourceHudLayout\(canvas\)/, 'UI helper should still normalize landscape HUD layout');
assert.match(workerUiSource, /ConfigureSourceHudLayout\(Canvas canvas, bool includeJoystick\)/, 'UI helper should support text-only relayout without resetting joystick during drag');
assert.match(workerUiSource, /if \(includeJoystick && !IsJoystickDragging\(\)\) LayoutJoystick/, 'UI helper must not reset joystick origin while dragging');
assert.match(workerUiSource, /using UnityEngine\.EventSystems;/, 'UI helper should compile EventSystem input support');
assert.match(workerUiSource, /private static void EnsureEventSystem\(\)/, 'UI helper should ensure EventSystem exists for IPointerHandler delivery');
assert.match(workerUiSource, /typeof\(RectTransform\), typeof\(Canvas\), typeof\(CanvasScaler\), typeof\(GraphicRaycaster\)/, 'Canvas should include a GraphicRaycaster for joystick UI input');
assert.match(workerUiSource, /private static GraphicRaycaster EnsureGraphicRaycaster\(GameObject obj\)/, 'Canvas should repair a missing GraphicRaycaster at runtime');
assert.match(workerUiSource, /EnsureGraphicRaycaster\(canvas\.gameObject\)/, 'Canvas normalization should preserve UI raycast delivery after binding an existing scene Canvas');
assert.match(workerJoystickSource, /bgImg\.raycastTarget = true;/, 'joystick background image must receive UI raycasts');
assert.match(workerJoystickSource, /bgImg\.color = new Color\(0f, 0f, 0f, 0f\);/, 'Unity joystick background should be transparent; DOM overlay owns visible joystick styling');
assert.match(workerJoystickSource, /if \(_bgImage != null\) _bgImage\.color = new Color\(0f, 0f, 0f, 0f\);/, 'Unity joystick visibility toggles must not render a second joystick background');
assert.match(workerUiSource, /if \(!IsMissing\(bgImage\)\) bgImage\.color = new Color\(0f, 0f, 0f, 0f\);/, 'source HUD relayout must not restore the legacy cyan joystick background');
assert.match(workerJoystickSource, /public void PollInput\(\)/, 'joystick widget should expose an explicit Luna scheduler tick');
assert.match(workerPlayerSource, /_joystick\.PollInput\(\);/, 'Player movement should read input from joystick widget state after the widget is ticked');
assert.match(workerPlayerSource, /stick 向量 \* 6u\/s/, 'Player movement speed should document the source HTML 6u/s contract');
assert.match(workerPlayerSource, /moveSpeed=6f/, 'Player fallback speed should match source HTML 6u/s');
assert.match(workerPlayerSource, /GFM_Joystick\.Create\(GFM_UIManager\.Instance\.Canvas, 88f\)/, 'Player joystick size should match source HTML maxR=44');
assert.match(workerPlayerSource, /private float _lastManualMoveRealtime = -1f;/, 'Player manual movement should track real time to resist CUA Update speed patching');
assert.match(workerPlayerSource, /MovePlayer\(dt\);/, 'Player Tick should pass the scheduler dt into manual movement');
assert.match(workerPlayerSource, /float now = Time\.realtimeSinceStartup;/, 'manual joystick movement should derive elapsed time from real time');
assert.match(workerPlayerSource, /if \(safeDt > 0\.025f\) safeDt = 0\.025f;/, 'manual joystick movement should clamp large dt spikes tightly enough for audit playback');
assert.match(workerPlayerSource, /new Vector3\(-h, 0, -v\)/, 'manual joystick axes should map to screen-space movement under the storyboard camera');
assert.doesNotMatch(workerPlayerSource, /new Vector3\(h, 0, -v\)/, 'manual joystick horizontal axis must not use the pre-storyboard camera mapping');
const overlayCanvasSceneRe = /--- !u!223 &[0-9]+\nCanvas:[\s\S]*?m_RenderMode: 0[\s\S]*?m_PlaneDistance: 8[\s\S]*?m_SortingOrder: 100/;

const duplicateEventSystemRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eventsystem-dedupe-'));
fs.mkdirSync(path.join(duplicateEventSystemRoot, 'Assets', 'Scenes'), { recursive: true });
fs.writeFileSync(path.join(duplicateEventSystemRoot, 'Assets', 'Scenes', 'Game.unity'), [
  '--- !u!1 &100',
  'GameObject:',
  '  m_Component:',
  '  - component: {fileID: 101}',
  '  - component: {fileID: 102}',
  '  - component: {fileID: 103}',
  '  - component: {fileID: 104}',
  '  m_Name: EventSystem',
  '--- !u!4 &101',
  'Transform:',
  '  m_GameObject: {fileID: 100}',
  '--- !u!114 &102',
  'MonoBehaviour:',
  '  m_GameObject: {fileID: 100}',
  '  m_Script: {fileID: 11500000, guid: 76c392e42b5098c458856cdf6ecaaaa1, type: 3}',
  '--- !u!114 &103',
  'MonoBehaviour:',
  '  m_GameObject: {fileID: 100}',
  '  m_Script: {fileID: 11500000, guid: 4f231c4fb786f3946a6b90b886c48677, type: 3}',
  '--- !u!114 &104',
  'MonoBehaviour:',
  '  m_GameObject: {fileID: 100}',
  '  m_Script: {fileID: 11500000, guid: 76c392e42b5098c458856cdf6ecaaaa1, type: 3}',
  ''
].join('\n'));
const dedupedEventSystem = cleaner.dedupeSceneMonoBehavioursByScriptGuid(duplicateEventSystemRoot, ['76c392e42b5098c458856cdf6ecaaaa1']);
const dedupedEventSystemScene = fs.readFileSync(path.join(duplicateEventSystemRoot, 'Assets', 'Scenes', 'Game.unity'), 'utf8');
assert.strictEqual(dedupedEventSystem.removed, 1, 'delivery scene should remove duplicate EventSystem components on the same GameObject');
assert.strictEqual((dedupedEventSystemScene.match(/76c392e42b5098c458856cdf6ecaaaa1/g) || []).length, 1, 'only one EventSystem component should remain');
assert.doesNotMatch(dedupedEventSystemScene, /fileID:\s*104/, 'duplicate EventSystem component reference should be removed from m_Component');

const input = [
  'public partial class GameFlowManagerMain',
  '{',
  '    // TODO_PHASE_1_INIT_START',
  '    // [ASSEMBLY PHASE] phaseId=intro',
  '    // phaseEvidenceSchema: [{"signal":"guide_text_visible"}]',
  '    //     "signal": "guide_text_visible",',
  '    // 普通中文说明应保留。',
  '    void Phase_intro_Init()',
  '    {',
  '        SetGuideText("开始");',
  '    }',
  '    // TODO_PHASE_1_INIT_END',
  '',
  '    // [ASSEMBLY SLOT] Player::move_to_target',
  '    void AssemblySlot_Flow_Player__move_to_target()',
  '    {',
  '        PlaceObj(Player, 1f, 0f, 0f);',
  '    }',
  '}',
].join('\n');

const cleaned = cleaner.cleanCSharpForProgrammerDelivery(input);
assert.strictEqual(cleaned.changed, true);
assert.strictEqual(cleaned.removedContractComments, 6);
assert.doesNotMatch(cleaned.code, /TODO_PHASE_1_INIT_START/);
assert.doesNotMatch(cleaned.code, /\[ASSEMBLY PHASE\]/);
assert.doesNotMatch(cleaned.code, /phaseEvidenceSchema/);
assert.doesNotMatch(cleaned.code, /\[ASSEMBLY SLOT\]/);
assert.match(cleaned.code, /普通中文说明应保留/);
assert.match(cleaned.code, /void AssemblySlot_Flow_Player__move_to_target/);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'programmer-delivery-'));
try {
  fs.mkdirSync(path.join(tmp, 'Scripts'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'BlueprintArtifacts'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'BlueprintArtifacts', 'specs.json'), '{}');
  fs.writeFileSync(path.join(tmp, 'tools', 'build-unitypackage.sh'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(tmp, 'README.md'), [
    '# Unity 工程导出',
    '',
    '## 目录',
    '- Assets/Program/Script/Manager/  — GameFlowManagerMain.cs 及 partial 文件',
    '',
    '## 程序员交付边界',
    '- GameFlowManagerMain.cs 负责启动、实体绑定、主 Update 调度和通用 helper；phase 逻辑在 GameFlowManagerMain.Flow.cs。',
    '- Flow/Input/Resource/UI/Scene partial 按 owner 分工维护，不要把 phase、资源、UI、场景逻辑混到同一个文件。',
    ''
  ].join('\n'));
  // Wave C 起 cleaner 不再合并 partial,fixture 模拟 5-partial 输入(Main + Flow/Input/Resource/UI/Scene)。
  fs.writeFileSync(path.join(tmp, 'Scripts', 'GameFlowManagerMain.cs'), [
    'using UnityEngine;',
    '',
    'public partial class GameFlowManagerMain : MonoBehaviour',
    '{',
    '    GameObject Barrack; // 说明：→ __Pool_Cube_Blue_01',
    '    // Unity 生命周期入口:第一帧前完成实体注册,主流程从这里启动。',
    '    void Start()',
    '    {',
    '        RegisterEntityBindings();',
    '    }',
    '    // 由具体项目重写,把 Pool 节点上的实体绑回脚本字段。',
    '    void RegisterEntityBindings() {}',
    '}',
  ].join('\n'));
  fs.writeFileSync(path.join(tmp, 'Scripts', 'GameFlowManagerMain.Flow.cs'), [
    'using UnityEngine;',
    '',
    'public partial class GameFlowManagerMain',
    '{',
    '    // Phase 1 init 钩子:进入引导阶段时设置文案,等待玩家点击开始。',
    '    void Phase_intro_Init()',
    '    {',
    '        SetGuideText("开始");',
    '    }',
    '}',
  ].join('\n'));
  fs.writeFileSync(path.join(tmp, 'Scripts', 'GameFlowManagerMain.Input.cs'), [
    'using UnityEngine;',
    '',
    'public partial class GameFlowManagerMain',
    '{',
    '    // 输入 partial 占位:本次 fixture 没有真实输入逻辑,但仍要保留 partial 以验证 cleaner 不会误删。',
    '    void HandleInput() {}',
    '}',
  ].join('\n'));
  fs.writeFileSync(path.join(tmp, 'Scripts', 'GameFlowManagerMain.Resource.cs'), [
    'using UnityEngine;',
    '',
    'public partial class GameFlowManagerMain',
    '{',
    '    // 资源 partial 占位:留作真实项目里的 AddResource / Spend 逻辑。',
    '    void TickResources() {}',
    '}',
  ].join('\n'));
  fs.writeFileSync(path.join(tmp, 'Scripts', 'GameFlowManagerMain.UI.cs'), [
    'using UnityEngine;',
    '',
    'public partial class GameFlowManagerMain',
    '{',
    '    // UIManager 接管前的临时 helper:把引导栏文字写到 guide UI。',
    '    void SetGuideText(string text) {}',
    '}',
  ].join('\n'));
  fs.writeFileSync(path.join(tmp, 'Scripts', 'GameFlowManagerMain.Scene.cs'), [
    'using UnityEngine;',
    '',
    'public partial class GameFlowManagerMain',
    '{',
    '    // 场景 partial 占位:把对象池实体摆放/隐藏的 helper 写在这里。',
    '    void PlaceEntityAt(GameObject obj, Vector3 pos) { if (obj != null) obj.transform.position = pos; }',
    '}',
  ].join('\n'));
  // 模拟上一轮残留的 GameFlow*Base.cs,验证 Wave C 会清理掉。
  fs.writeFileSync(path.join(tmp, 'Scripts', 'GameFlowStateBase.cs'),
    '// 上一轮 cleaner 输出的继承链残留\npublic class GameFlowStateBase : MonoBehaviour {}\n');
  const summary = cleaner.cleanProgrammerDelivery(tmp, {
    project: { id: 'proj_test', name: '测试项目' }
  });
  // 输入 6 个 GameFlow .cs + 1 个残留 Base = 7
  assert.strictEqual(summary.csFiles, 7);
  // Wave C: 6 个 partial 全部保留,1 个残留 Base 被清理。
  assert.strictEqual(summary.partialFilesKept, 6);
  assert.deepStrictEqual(summary.partialFilesByName.slice().sort(), [
    'GameFlowManagerMain.Flow.cs',
    'GameFlowManagerMain.Input.cs',
    'GameFlowManagerMain.Resource.cs',
    'GameFlowManagerMain.Scene.cs',
    'GameFlowManagerMain.UI.cs',
    'GameFlowManagerMain.cs'
  ]);
  assert.strictEqual(summary.staleBaseLayersRemoved, 1);
  // v14 交付取消 Build/Resource/Combat 中间继承层，实体模型最小集合为
  // BaseGameFlowEntity + PlayerBase + NPCBase + 具体业务实体。
  assert.ok(summary.entityClassFiles >= 4);
  assert.strictEqual(summary.entityModelCount, 1);
  assert.strictEqual(summary.removedArtifactDirs, 1);
  assert.strictEqual(summary.removedToolDirs, 1);
  assert.ok(!fs.existsSync(path.join(tmp, 'BlueprintArtifacts')));
  assert.ok(!fs.existsSync(path.join(tmp, 'tools')));
  // 6 个 partial 全部保留。
  ['GameFlowManagerMain.cs', 'GameFlowManagerMain.Flow.cs', 'GameFlowManagerMain.Input.cs',
   'GameFlowManagerMain.Resource.cs', 'GameFlowManagerMain.UI.cs', 'GameFlowManagerMain.Scene.cs'].forEach((name) => {
    assert.ok(fs.existsSync(path.join(tmp, 'Scripts', name)), name + ' should be kept');
    const text = fs.readFileSync(path.join(tmp, 'Scripts', name), 'utf8');
    assert.match(text, /partial\s+class\s+GameFlowManagerMain/, name + ' should remain partial');
  });
  // GameFlow*Base 残留必须被清理掉。
  assert.ok(!fs.existsSync(path.join(tmp, 'Scripts', 'GameFlowStateBase.cs')));
  assert.ok(!fs.existsSync(path.join(tmp, 'Scripts', 'GameFlowPhaseInitBase.cs')));
  assert.ok(!fs.existsSync(path.join(tmp, 'Scripts', 'GameFlowPhaseSharedBase.cs')));
  assert.ok(!fs.existsSync(path.join(tmp, 'Scripts', 'GameFlowUiBase.cs')));
  // Main 文件应保留 partial 关键字、保留 Start/RegisterEntityBindings、注入 BindGameFlowEntityModels 调用 + 实体模型代码区。
  const mainText = fs.readFileSync(path.join(tmp, 'Scripts', 'GameFlowManagerMain.cs'), 'utf8');
  assert.match(mainText, /public partial class GameFlowManagerMain : MonoBehaviour/);
  assert.match(mainText, /void Start\(\)/);
  assert.match(mainText, /BindGameFlowEntityModels\(\);/);
  assert.match(mainText, /void BindGameFlowEntityModels\(\)/);
  assert.match(mainText, /BarrackEntity mBarrackEntityModel;/);
  assert.match(mainText, /BindGameFlowEntityComponent<BarrackEntity>/);
  // Phase_intro_Init 留在 Flow.cs 里,不再被搬到继承链里。
  const flowText = fs.readFileSync(path.join(tmp, 'Scripts', 'GameFlowManagerMain.Flow.cs'), 'utf8');
  assert.match(flowText, /void Phase_intro_Init\(\)/);
  // 所有 partial 应控制在 1000 行以内。
  const gameFlowFiles = fs.readdirSync(path.join(tmp, 'Scripts')).filter((name) => /^GameFlowManagerMain.*\.cs$/.test(name));
  gameFlowFiles.forEach((name) => {
    const lineCount = fs.readFileSync(path.join(tmp, 'Scripts', name), 'utf8').split(/\r?\n/).length - 1;
    assert.ok(lineCount < 1000, name + ' should stay below 1000 lines');
  });
  assert.ok(fs.existsSync(path.join(tmp, 'Scripts', 'Entities', 'BarrackEntity.cs')));
  assert.match(fs.readFileSync(path.join(tmp, 'Scripts', 'Entities', 'BaseGameFlowEntity.cs'), 'utf8'), /public string EntityId = "";/);
  assert.match(fs.readFileSync(path.join(tmp, 'Scripts', 'Entities', 'BaseGameFlowEntity.cs'), 'utf8'), /public virtual void Bind\(GameObject source, string entityId, string displayName\)/);
  // Wave C: 实体绑定块落到 Main 文件而非继承链 StateBase。
  assert.match(mainText, /领域模型缓存/);
  assert.match(fs.readFileSync(path.join(tmp, 'Scripts', 'Entities', 'BarrackEntity.cs'), 'utf8'), /public class BarrackEntity : BaseGameFlowEntity/);
  // 反馈 01 #1 架构图:PlayerBase / NPCBase 与 BaseBuildElement 同级,都挂在 BaseGameFlowEntity 下。
  assert.ok(fs.existsSync(path.join(tmp, 'Scripts', 'Entities', 'PlayerBase.cs')));
  assert.ok(fs.existsSync(path.join(tmp, 'Scripts', 'Entities', 'NPCBase.cs')));
  const playerBaseSrc = fs.readFileSync(path.join(tmp, 'Scripts', 'Entities', 'PlayerBase.cs'), 'utf8');
  assert.match(playerBaseSrc, /public class PlayerBase : BaseGameFlowEntity/);
  assert.match(playerBaseSrc, /public float mMoveSpeed/);
  assert.match(playerBaseSrc, /void MoveByDirection\(Vector3 direction, float dt\)/);
  // 反馈 01 #8 架构图:Player 走单例语义。
  assert.match(playerBaseSrc, /public\s+static\s+PlayerBase\s+instance/);
  assert.match(playerBaseSrc, /instance\s*=\s*this/);
  const npcBaseSrc = fs.readFileSync(path.join(tmp, 'Scripts', 'Entities', 'NPCBase.cs'), 'utf8');
  assert.match(npcBaseSrc, /public class NPCBase : BaseGameFlowEntity/);
  assert.match(npcBaseSrc, /void SetTarget\(Vector3 target\)/);
  assert.match(npcBaseSrc, /void TickPatrol\(float dt\)/);
  // 反馈 01 #8 架构图:NPC 必须含名字 / 血条 UI / 攻击信息(名字在 BaseGameFlowEntity)。
  assert.match(npcBaseSrc, /using\s+UnityEngine\.UI;/);
  assert.match(npcBaseSrc, /public\s+Slider\s+HealthBar/);
  assert.match(npcBaseSrc, /public\s+int\s+Health/);
  assert.match(npcBaseSrc, /public\s+int\s+MaxHealth/);
  assert.match(npcBaseSrc, /public\s+int\s+AttackDamage/);
  assert.match(npcBaseSrc, /public\s+float\s+AttackRange/);
  assert.match(npcBaseSrc, /public\s+float\s+AttackCooldown/);
  assert.match(npcBaseSrc, /void\s+RefreshHealthBar\(\)/);
  assert.match(npcBaseSrc, /void\s+ApplyDamage\(int\s+amount\)/);
  assert.match(npcBaseSrc, /bool\s+TryAttack\(Vector3\s+targetPos\)/);
  assert.match(fs.readFileSync(path.join(tmp, 'Scripts', 'Entities', 'BarrackEntity.cs'), 'utf8'), /蓝图实体 ID/);
  // 反馈 01: Bind 必须把 Unity primitive 默认名替换为领域名,运行时 Hierarchy 不留未命名物体。
  const baseEntityCode = fs.readFileSync(path.join(tmp, 'Scripts', 'Entities', 'BaseGameFlowEntity.cs'), 'utf8');
  assert.match(baseEntityCode, /PrimitiveDefaultNames/);
  assert.match(baseEntityCode, /void ApplyDomainName\(GameObject obj\)/);
  assert.match(baseEntityCode, /string FallbackEntityId\(\)/);
  assert.match(baseEntityCode, /ApplyDomainName\(SourceObject\);/);
  assert.match(baseEntityCode, /current\.StartsWith\("__Pool_"\)/);
  // 反馈 01 #5: BaseGameFlowEntity 必须提供 MoveToPosition lerp tween,运行中位移不瞬移。
  assert.match(baseEntityCode, /using System\.Collections;/);
  assert.match(baseEntityCode, /public virtual void MoveToPosition\(Vector3 target, float duration = 0\.4f\)/);
  assert.match(baseEntityCode, /private IEnumerator MoveToPositionCoroutine/);
  assert.match(baseEntityCode, /Vector3\.LerpUnclamped\(startPos, target, t\)/);
  assert.match(baseEntityCode, /StartCoroutine\(MoveToPositionCoroutine/);
  assert.ok(fs.existsSync(path.join(tmp, 'PROGRAMMER_HANDOFF.md')));
  assert.ok(fs.existsSync(path.join(tmp, 'CODE_RELATION_GRAPH.md')));
  assert.ok(fs.existsSync(path.join(tmp, 'CODE_RELATION_GRAPH.html')));
  const handoff = fs.readFileSync(path.join(tmp, 'PROGRAMMER_HANDOFF.md'), 'utf8');
  assert.match(handoff, /程序员交付版说明/);
  assert.match(handoff, /移除 tools 目录数：1/);
  // Wave C: HANDOFF 必须用"保留 5 partial"语,绝不能再出现"普通继承基类分层"。
  assert.match(handoff, /保留.*5 个 partial 拆分/);
  assert.match(handoff, /保留的 GameFlowManagerMain partial 文件数：6/);
  assert.match(handoff, /清理的 GameFlow\*Base 残留文件数：1/);
  assert.doesNotMatch(handoff, /普通继承基类分层/);
  assert.doesNotMatch(handoff, /GameFlow\*Base\.cs 通过普通继承链/);
  assert.match(fs.readFileSync(path.join(tmp, 'CODE_RELATION_GRAPH.md'), 'utf8'), /代码关系图/);
  assert.match(fs.readFileSync(path.join(tmp, 'CODE_RELATION_GRAPH.md'), 'utf8'), /Entities\/BaseGameFlowEntity\.cs/);
  // Wave C: README 现在保留 partial 提及。
  const readmeText = fs.readFileSync(path.join(tmp, 'README.md'), 'utf8');
  assert.match(readmeText, /Flow\/Input\/Resource\/UI\/Scene partial/);
  assert.match(readmeText, /5 个 partial/);

  // 反馈 01 (2026-04-26) Phase B.1: validator 集成 — 干净的小 fixture 不应触发 warning
  assert.ok(Array.isArray(summary.warnings), 'summary.warnings should be array');
  assert.strictEqual(summary.warnings.length, 0, 'clean fixture should produce no warnings, got: ' + JSON.stringify(summary.warnings));
  // Wave D 反馈 6 (2026-05-02): summary.errors 必须存在 (即使为空),让上层能稳定取
  assert.ok(Array.isArray(summary.errors), 'summary.errors should be array');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// 2026-05-23 reference Unity project layout: exporter writes programmer delivery
// scripts under Assets/Scripts/Manager + sibling Assets/Scripts/Entities.
{
  const tmpRef = fs.mkdtempSync(path.join(os.tmpdir(), 'programmer-ref-layout-'));
  try {
    const managerDir = path.join(tmpRef, 'Assets', 'Scripts', 'Manager');
    fs.mkdirSync(managerDir, { recursive: true });
    fs.writeFileSync(path.join(tmpRef, 'README.md'), [
      '# Unity 工程导出',
      '',
      '## 目录',
      '- Assets/Scripts/Manager/  — GameFlowManagerMain.cs 及 partial 文件',
      '',
      '## 程序员交付边界',
      '- old boundary',
      ''
    ].join('\n'));
    fs.writeFileSync(path.join(managerDir, 'GameFlowManagerMain.cs'), [
      'using UnityEngine;',
      '',
      'public partial class GameFlowManagerMain : MonoBehaviour',
      '{',
      '    GameObject Barrack; // 说明：→ __Pool_Cube_Blue_01',
      '    GameObject Gold; // 说明：→ __Pool_Cube_Yellow_01',
      '    // Unity 生命周期入口:第一帧前完成实体注册,主流程从这里启动。',
      '    void Start()',
      '    {',
      '        GFM_Luna.Init(gameObject);',
      '        string resourceId = GFM_ResourceIds.Gold;',
      '        RegisterEntityBindings();',
      '    }',
      '    void Update()',
      '    {',
      '        AssemblyRunFlowSlots();',
      '    }',
      '    void AssemblyRunFlowSlots() {}',
      '    // 由具体项目重写,把 Pool 节点上的实体绑回脚本字段。',
      '    void RegisterEntityBindings() {}',
      '}',
    ].join('\n'));
    fs.writeFileSync(path.join(managerDir, 'GMP_Pool.cs'), [
      'using UnityEngine;',
      'public class GMP_Pool : MonoBehaviour',
      '{',
      '    public void ReturnLater(GameObject obj) { obj.AddComponent<GMP_ReturnTimer>(); }',
      '}',
      'public class GMP_ReturnTimer : MonoBehaviour',
      '{',
      '    public void StartTimer(float delay) {}',
      '}',
    ].join('\n'));
    fs.writeFileSync(path.join(managerDir, 'GMP_EntityBindingManager.cs'), [
      'using System.Collections.Generic;',
      'using UnityEngine;',
      '[System.Serializable]',
      'public class GMP_EntityBinding',
      '{',
      '    public string mEntityName;',
      '    public GameObject mSceneObject;',
      '}',
      'public class GMP_EntityBindingManager : MonoSingleton<GMP_EntityBindingManager>',
      '{',
      '    public List<GMP_EntityBinding> mBindings = new List<GMP_EntityBinding>();',
      '}',
    ].join('\n'));

    const summary = cleaner.cleanProgrammerDelivery(tmpRef, {
      project: { id: 'proj_ref', name: '参考布局项目' }
    });

    assert.strictEqual(summary.managerDir, managerDir);
    assert.strictEqual(summary.referenceMainManager, true);
    const coreBase = path.join(tmpRef, 'Assets', 'Scripts', 'Core', 'Base');
    const coreModules = path.join(tmpRef, 'Assets', 'Scripts', 'Core', 'Modules');
    const gameEntities = path.join(tmpRef, 'Assets', 'Scripts', 'Game', 'Entities');
    assert.ok(fs.existsSync(path.join(coreBase, 'GMP_BaseGameFlowEntity.cs')));
    assert.ok(fs.existsSync(path.join(gameEntities, 'GMP_RestaurantEntity.cs')));
    assert.ok(!fs.existsSync(path.join(gameEntities, 'GMP_BarrackEntity.cs')));
    assert.ok(!fs.existsSync(path.join(managerDir, 'Entities')), 'Entities should be sibling to Manager in reference layout');
    assert.ok(fs.existsSync(path.join(coreModules, 'GMP_MainManager.cs')));
    assert.ok(fs.existsSync(path.join(coreBase, 'MonoSingleton.cs')));
    assert.ok(!fs.existsSync(path.join(managerDir, 'GameFlowManagerMain.cs')), 'reference layout should merge away GameFlowManagerMain.cs');

    const mainManager = fs.readFileSync(path.join(coreModules, 'GMP_MainManager.cs'), 'utf8');
    assert.match(mainManager, /public class GMP_MainManager : MonoSingleton<GMP_MainManager>/);
    assert.match(mainManager, /public GameObject mBarrack;/);
    assert.match(mainManager, /public GameObject mGold;/);
    assert.match(mainManager, /GMP_ResourceIds\.Gold/);
    assert.doesNotMatch(mainManager, /GMP_ResourceIds\._gold/);
    assert.doesNotMatch(mainManager, /GMP_Luna\.Init/);
    assert.doesNotMatch(mainManager, /AssemblyRunFlowSlots/);
    assert.doesNotMatch(mainManager, /\bpartial\b/);
    assert.doesNotMatch(mainManager, /\[SKELETON\]/);

    const refReadme = fs.readFileSync(path.join(tmpRef, 'README.md'), 'utf8');
    assert.match(refReadme, /Core \/ Tool \/ Game/);
    assert.match(refReadme, /Assets\/Scripts\/Game\/Entities/);
    assert.match(refReadme, /GMP_MainManager\.cs/);
    assert.match(refReadme, /Core 不写具体关卡事件名/);

    const refHandoff = fs.readFileSync(path.join(tmpRef, 'PROGRAMMER_HANDOFF.md'), 'utf8');
    assert.match(refHandoff, /Assets\/Scripts\/Core\/Modules/);
    assert.match(refHandoff, /Assets\/Scripts\/Game\/Entities/);
    assert.match(refHandoff, /GMP_MainManager\.cs/);
    assert.match(refHandoff, /二开推荐路径/);
    assert.match(refHandoff, /Assets\/Scripts\/Game\/Level\/` 新增 `GMP_<FeatureName>Feature\.cs`/);
    assert.match(refHandoff, /PROGRAMMER_MAINTAINABILITY_REPORT\.json/);

    assert.ok(fs.existsSync(path.join(coreModules, 'GMP_ReturnTimer.cs')));
    assert.ok(fs.existsSync(path.join(tmpRef, 'Assets', 'Scripts', 'Game', 'Level', 'GMP_EntityBinding.cs')));
    const multiClassFiles = [];
    (function walk(dir) {
      fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); return; }
        if (!/\.cs$/.test(entry.name)) return;
        const classCount = (fs.readFileSync(full, 'utf8').match(/^public\s+(?:abstract\s+)?class\s+/gm) || []).length;
        if (classCount > 1) multiClassFiles.push(path.relative(tmpRef, full));
      });
    })(path.join(tmpRef, 'Assets', 'Scripts'));
    assert.deepStrictEqual(multiClassFiles, [], 'v14 delivery should keep one public class per .cs file');
  } finally {
    fs.rmSync(tmpRef, { recursive: true, force: true });
  }
}

// Wave D 反馈 7 (2026-05-02) — 交付包必须删除 GFM_Event.cs
{
  const fs2 = require('fs');
  const path2 = require('path');
  const os2 = require('os');
  const cleaner2 = require('../lib/programmer-delivery-cleaner.cjs');
  const tmp2 = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'gfm-event-cleanup-'));
  try {
    const commonsDir = path2.join(tmp2, 'Assets', 'Program', 'Script', 'Commons');
    fs2.mkdirSync(commonsDir, { recursive: true });
    const gfmEventPath = path2.join(commonsDir, 'GFM_Event.cs');
    fs2.writeFileSync(gfmEventPath, 'public class GFM_Event {}\n');
    fs2.writeFileSync(gfmEventPath + '.meta', 'fileFormatVersion: 2\n');
    const refCommonDir = path2.join(tmp2, 'Assets', 'Scripts', 'Common');
    fs2.mkdirSync(refCommonDir, { recursive: true });
    const refGfmEventPath = path2.join(refCommonDir, 'GFM_Event.cs');
    fs2.writeFileSync(refGfmEventPath, 'public class GFM_Event {}\n');
    fs2.writeFileSync(refGfmEventPath + '.meta', 'fileFormatVersion: 2\n');
    cleaner2.cleanProgrammerDelivery(tmp2, { project: { id: 'p_evt', name: 'evt' } });
    assert.ok(!fs2.existsSync(gfmEventPath), 'GFM_Event.cs should be removed');
    assert.ok(!fs2.existsSync(gfmEventPath + '.meta'), 'GFM_Event.cs.meta should be removed');
    assert.ok(!fs2.existsSync(refGfmEventPath), 'reference-layout GFM_Event.cs should be removed');
    assert.ok(!fs2.existsSync(refGfmEventPath + '.meta'), 'reference-layout GFM_Event.cs.meta should be removed');
    console.log('  ✓ GFM_Event removal: file + meta deleted from delivery');
  } finally {
    fs2.rmSync(tmp2, { recursive: true, force: true });
  }
}

// 2026-05-24: 程序员交付版脚本物体挂场景，且 scene fileID / script guid 稳定。
{
  function buildFixture(root) {
    const scripts = path.join(root, 'Assets', 'Scripts');
    const audio = path.join(scripts, 'Audio');
    const scenes = path.join(root, 'Assets', 'Scenes');
    fs.mkdirSync(audio, { recursive: true });
    fs.mkdirSync(scenes, { recursive: true });
    fs.writeFileSync(path.join(root, 'README.md'), '# Unity 工程导出\n\n## 程序员交付边界\n- old\n');
    fs.writeFileSync(path.join(scenes, 'Game.unity'), [
      '%YAML 1.1',
      '%TAG !u! tag:unity3d.com,2011:',
      '--- !u!29 &1',
      'OcclusionCullingSettings:',
      '  m_ObjectHideFlags: 0',
      '--- !u!1 &500',
      'GameObject:',
      '  m_ObjectHideFlags: 0',
      '  m_CorrespondingSourceObject: {fileID: 0}',
      '  m_PrefabInstance: {fileID: 0}',
      '  m_PrefabAsset: {fileID: 0}',
      '  serializedVersion: 6',
      '  m_Component:',
      '  - component: {fileID: 501}',
      '  - component: {fileID: 502}',
      '  m_Layer: 0',
      '  m_Name: Canvas',
      '  m_TagString: Untagged',
      '  m_Icon: {fileID: 0}',
      '  m_NavMeshLayer: 0',
      '  m_StaticEditorFlags: 0',
      '  m_IsActive: 1',
      '--- !u!4 &501',
      'Transform:',
      '  m_ObjectHideFlags: 0',
      '  m_CorrespondingSourceObject: {fileID: 0}',
      '  m_PrefabInstance: {fileID: 0}',
      '  m_PrefabAsset: {fileID: 0}',
      '  m_GameObject: {fileID: 500}',
      '  serializedVersion: 2',
      '  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}',
      '  m_LocalPosition: {x: 0, y: 0, z: 0}',
      '  m_LocalScale: {x: 1, y: 1, z: 1}',
      '  m_ConstrainProportionsScale: 0',
      '  m_Children: []',
      '  m_Father: {fileID: 0}',
      '  m_LocalEulerAnglesHint: {x: 0, y: 0, z: 0}',
      '--- !u!223 &502',
      'Canvas:',
      '  m_ObjectHideFlags: 0',
      '  m_CorrespondingSourceObject: {fileID: 0}',
      '  m_PrefabInstance: {fileID: 0}',
      '  m_PrefabAsset: {fileID: 0}',
      '  m_GameObject: {fileID: 500}',
      '  m_Enabled: 1',
      '  serializedVersion: 3',
      '  m_RenderMode: 1',
      '  m_Camera: {fileID: 0}',
      '  m_PlaneDistance: 100',
      '  m_PixelPerfect: 0',
      '  m_ReceivesEvents: 1',
      '  m_OverrideSorting: 0',
      '  m_OverridePixelPerfect: 0',
      '  m_SortingBucketNormalizedSize: 0',
      '  m_AdditionalShaderChannelsFlag: 25',
      '  m_SortingLayerID: 0',
      '  m_SortingOrder: 0',
      '  m_TargetDisplay: 0',
      ''
    ].join('\n'));
    fs.writeFileSync(path.join(scripts, 'GameFlowManagerMain.cs'), [
      'using UnityEngine;',
      'public partial class GameFlowManagerMain : MonoBehaviour',
      '{',
      '    GameObject Player; // 说明：→ __Pool_Cube_Blue_01',
      '    void Start() { RegisterEntityBindings(); }',
      '    void RegisterEntityBindings() {}',
      '}',
    ].join('\n'));
    fs.writeFileSync(path.join(audio, 'GMP_Audio.cs'), [
      'using UnityEngine;',
      'public class GMP_Audio : MonoBehaviour',
      '{',
      '    private static GMP_Audio _instance;',
      '    public static GMP_Audio Instance { get { return _instance; } }',
      '    public static GMP_Audio Init(GameObject parent)',
      '    {',
      '        var obj = new GameObject("GMP_Audio");',
      '        _instance = obj.AddComponent<GMP_Audio>();',
      '        return _instance;',
      '    }',
      '}',
    ].join('\n'));
  }

  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-inject-a-'));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-inject-b-'));
  try {
    buildFixture(a);
    buildFixture(b);
    const sa = cleaner.cleanProgrammerDelivery(a, { project: { id: 'scene_a', name: 'scene_a' } });
    const sb = cleaner.cleanProgrammerDelivery(b, { project: { id: 'scene_b', name: 'scene_b' } });
    assert.ok(sa.sceneObjectsInjected >= 2, 'should inject MainManager and GMP_Audio');
    assert.ok(sb.sceneObjectsInjected >= 2, 'should inject MainManager and GMP_Audio');
    const sceneA = fs.readFileSync(path.join(a, 'Assets', 'Scenes', 'Game.unity'), 'utf8');
    const sceneB = fs.readFileSync(path.join(b, 'Assets', 'Scenes', 'Game.unity'), 'utf8');
    assert.strictEqual(sceneA, sceneB, 'scene injection should be deterministic across export roots');
    assert.match(sceneA, /m_Name: GMP_MainManager/);
    assert.match(sceneA, /m_Name: GMP_Audio/);
    assert.strictEqual((sceneA.match(/AudioSource:/g) || []).length, 8, 'GMP_Audio should mount loop and one-shot AudioSource pools');
    assert.match(sceneA, /mBgmList: \[\]/);
    assert.match(sceneA, /mSfxList: \[\]/);
    assert.match(sceneA, /mLoopSources: \[\]/);
    assert.match(sceneA, /mOneShotSources: \[\]/);
    assert.match(sceneA, /mRuntimeLoopSourceCount: 2/);
    assert.match(sceneA, /mRuntimeOneShotSourceCount: 6/);
    const audioText = fs.readFileSync(path.join(a, 'Assets', 'Scripts', 'Core', 'Modules', 'GMP_Audio.cs'), 'utf8');
    assert.doesNotMatch(audioText, /new GameObject/);
    assert.doesNotMatch(audioText, /\bInstance\b/);
    assert.match(audioText, /mInstance/);
    assert.match(audioText, /using System\.Collections\.Generic;/);
    assert.match(audioText, /public AudioClip\[\] mBgmList/);
    assert.match(audioText, /public AudioClip\[\] mSfxList/);
    assert.match(audioText, /public AudioSource\[\] mLoopSources/);
    assert.match(audioText, /public AudioSource\[\] mOneShotSources/);
    assert.match(audioText, /public int mRuntimeOneShotSourceCount = 6/);
    assert.match(audioText, /Dictionary<string, AudioSource> mLoopSourceByKey/);
    assert.match(audioText, /GetComponents<AudioSource>\(\)/);
    assert.match(audioText, /void PlayBGM\(int index\)/);
    assert.match(audioText, /void PlaySFX\(int index\)/);
    assert.match(audioText, /void PlayLoop\(string key, AudioClip clip\)/);
    assert.match(audioText, /void PlayOneShot\(AudioClip clip\)/);
    assert.match(audioText, /NextOneShotSource\(\)/);
    assert.doesNotMatch(audioText, /private AudioSource mSfxSource/);
    assert.doesNotMatch(audioText, /private AudioSource mBgmSource/);
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
}

// 2026-05-24 v12：参考 Unity 交付必须真拆成独立 Manager 类，禁止 partial/runtime 马甲回潮。
{
  const tmpV12 = fs.mkdtempSync(path.join(os.tmpdir(), 'programmer-v12-'));
  try {
    const scripts = path.join(tmpV12, 'Assets', 'Scripts');
    const scenes = path.join(tmpV12, 'Assets', 'Scenes');
    fs.mkdirSync(scripts, { recursive: true });
    fs.mkdirSync(scenes, { recursive: true });
    fs.writeFileSync(path.join(tmpV12, 'README.md'), '# Unity 工程导出\n');
    function minimalSceneObject(id, transformId, name, position) {
      return [
        '--- !u!1 &' + id,
        'GameObject:',
        '  m_ObjectHideFlags: 0',
        '  m_CorrespondingSourceObject: {fileID: 0}',
        '  m_PrefabInstance: {fileID: 0}',
        '  m_PrefabAsset: {fileID: 0}',
        '  serializedVersion: 6',
        '  m_Component:',
        '  - component: {fileID: ' + transformId + '}',
        '  m_Layer: 0',
        '  m_Name: ' + name,
        '  m_TagString: Untagged',
        '  m_Icon: {fileID: 0}',
        '  m_NavMeshLayer: 0',
        '  m_StaticEditorFlags: 0',
        '  m_IsActive: 1',
        '--- !u!4 &' + transformId,
        'Transform:',
        '  m_ObjectHideFlags: 0',
        '  m_CorrespondingSourceObject: {fileID: 0}',
        '  m_PrefabInstance: {fileID: 0}',
        '  m_PrefabAsset: {fileID: 0}',
        '  m_GameObject: {fileID: ' + id + '}',
        '  serializedVersion: 2',
        '  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}',
        '  m_LocalPosition: {x: ' + position.x + ', y: ' + position.y + ', z: ' + position.z + '}',
        '  m_LocalScale: {x: 1, y: 1, z: 1}',
        '  m_ConstrainProportionsScale: 0',
        '  m_Children: []',
        '  m_Father: {fileID: 0}',
        '  m_LocalEulerAnglesHint: {x: 0, y: 0, z: 0}',
        ''
      ].join('\n');
    }
    function legacyMonoBehaviourBlock(id, goId, guid) {
      return [
        '--- !u!114 &' + id,
        'MonoBehaviour:',
        '  m_ObjectHideFlags: 0',
        '  m_CorrespondingSourceObject: {fileID: 0}',
        '  m_PrefabInstance: {fileID: 0}',
        '  m_PrefabAsset: {fileID: 0}',
        '  m_GameObject: {fileID: ' + goId + '}',
        '  m_Enabled: 1',
        '  m_EditorHideFlags: 0',
        '  m_Script: {fileID: 11500000, guid: ' + guid + ', type: 3}',
        '  m_Name: ',
        '  m_EditorClassIdentifier: ',
        ''
      ].join('\n');
    }
    function legacyCameraSpaceCanvasBlock(id, goId) {
      return [
        '--- !u!223 &' + id,
        'Canvas:',
        '  m_ObjectHideFlags: 0',
        '  m_CorrespondingSourceObject: {fileID: 0}',
        '  m_PrefabInstance: {fileID: 0}',
        '  m_PrefabAsset: {fileID: 0}',
        '  m_GameObject: {fileID: ' + goId + '}',
        '  m_Enabled: 1',
        '  serializedVersion: 3',
        '  m_RenderMode: 1',
        '  m_Camera: {fileID: 0}',
        '  m_PlaneDistance: 100',
        '  m_PixelPerfect: 0',
        '  m_ReceivesEvents: 1',
        '  m_OverrideSorting: 0',
        '  m_OverridePixelPerfect: 0',
        '  m_SortingBucketNormalizedSize: 0',
        '  m_AdditionalShaderChannelsFlag: 25',
        '  m_SortingLayerID: 0',
        '  m_SortingOrder: 0',
        '  m_TargetDisplay: 0',
        ''
      ].join('\n');
    }
    const legacyActivatorGuid = 'c91b2d4d49b7caa428b32e2e342d0a17';
    const generatedActivatorGuid = '11111111111111111111111111111111';
    const legacyPlaceholderGuid = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
    const templateAdditionalLightGuid = '474bcb49853aa07438625e644c072ee6';
    const templateAdditionalCameraGuid = 'a79441f348de89743a2939f4d699eac1';
    const oldGraphicRaycasterGuid = 'dc42784cf5571cd4e96f405ef68ec111';
    const newGraphicRaycasterGuid = 'dc42784cf147c0c48a680349fa168899';
    const oldEventSystemGuid = '76c392e42b5d8814fa735d0bde908bd4';
    const newEventSystemGuid = '76c392e42b5098c458856cdf6ecaaaa1';
    const nonWhitelistedPackageGuid = '99999999999999999999999999999999';
    fs.writeFileSync(path.join(scenes, 'Game.unity'), [
      '%YAML 1.1',
      '%TAG !u! tag:unity3d.com,2011:',
      '--- !u!29 &1',
      'OcclusionCullingSettings:',
      '  m_ObjectHideFlags: 0',
      minimalSceneObject(100, 101, 'Main Camera', { x: 0, y: 8, z: -12 }).replace('  - component: {fileID: 101}', '  - component: {fileID: 101}\n  - component: {fileID: 102}'),
      legacyMonoBehaviourBlock(102, 100, templateAdditionalCameraGuid),
      minimalSceneObject(200, 201, '_player', { x: 0, y: -9999, z: 0 }).replace('  - component: {fileID: 201}', '  - component: {fileID: 201}\n  - component: {fileID: 202}'),
      legacyMonoBehaviourBlock(202, 200, legacyActivatorGuid),
      minimalSceneObject(300, 301, '_gold', { x: 0, y: -9999, z: 0 }),
      minimalSceneObject(400, 401, '_ctaButton', { x: 0, y: -9999, z: 0 }),
      minimalSceneObject(500, 501, 'Canvas', { x: 0, y: 0, z: 0 }).replace('  - component: {fileID: 501}', '  - component: {fileID: 501}\n  - component: {fileID: 502}\n  - component: {fileID: 503}'),
      legacyCameraSpaceCanvasBlock(502, 500),
      legacyMonoBehaviourBlock(503, 500, oldGraphicRaycasterGuid),
      minimalSceneObject(600, 601, 'GameManager', { x: 0, y: 0, z: 0 }).replace('  - component: {fileID: 601}', '  - component: {fileID: 601}\n  - component: {fileID: 602}'),
      legacyMonoBehaviourBlock(602, 600, legacyPlaceholderGuid),
      minimalSceneObject(700, 701, '__MainLight', { x: 0, y: 12, z: 0 }).replace('  - component: {fileID: 701}', '  - component: {fileID: 701}\n  - component: {fileID: 702}'),
      legacyMonoBehaviourBlock(702, 700, templateAdditionalLightGuid),
      minimalSceneObject(800, 801, 'EventSystem', { x: 0, y: 0, z: 0 }).replace('  - component: {fileID: 801}', '  - component: {fileID: 801}\n  - component: {fileID: 802}\n  - component: {fileID: 803}'),
      legacyMonoBehaviourBlock(802, 800, oldEventSystemGuid),
      legacyMonoBehaviourBlock(803, 800, nonWhitelistedPackageGuid),
      ''
    ].join('\n'));
    fs.writeFileSync(path.join(scripts, 'MainManager.cs'), [
      'using UnityEngine;',
      'public class MainManager : MonoSingleton<MainManager>',
      '{',
      '    string[] _entityBindingIds = new string[] { "_player", "_gold", "_ctaButton" };',
      '    public GameObject _player;',
      '    public GameObject _gold;',
      '    public GameObject _ctaButton;',
      '    void Start() {}',
      '    void Update() {}',
      '    void SpawnGold(int count) { SpawnBoundEntity(_gold, ref _goldState, count); }',
      '    int _goldState;',
      '    void SpawnBoundEntity(GameObject entity, ref int state, int count) {}',
      '    // Shot 1 / Phase: phase1',
      '    // 标题: 采集金币',
      '    // 入画物体: _player, _gold',
      '    void Phase_phase1_Init() { GMP_VisualGuide.HighlightTarget(_gold); }',
      '    // Shot 2 / Phase: phase2',
      '    // 标题: 点击下载',
      '    // 入画物体: _player, _ctaButton',
      '    void Phase_phase2_Init() { GMP_VisualGuide.HighlightTarget(_ctaButton); }',
      '    bool Phase_phase2_GateReady() { return EntityAdvanced(_gold, mSnap_GoldPos) && PhaseDwellReady(12f); }',
      '    bool EndGame_GateReady() { return EntityAdvanced(_ctaButton, mSnap_CtaButtonPos) && PhaseDwellReady(12f); }',
      '}',
    ].join('\n'));
    fs.writeFileSync(path.join(scripts, 'MonoSingleton.cs'), [
      'using UnityEngine;',
      'public abstract class MonoSingleton<T> : MonoBehaviour where T : MonoBehaviour {}',
    ].join('\n'));
    fs.writeFileSync(path.join(scripts, 'ScriptActivator.cs'), [
      'using UnityEngine;',
      'public class ScriptActivator : MonoBehaviour',
      '{',
      '    public string role;',
      '    public string behavior;',
      '}',
    ].join('\n'));
    fs.writeFileSync(path.join(scripts, 'ScriptActivator.cs.meta'), [
      'fileFormatVersion: 2',
      'guid: ' + generatedActivatorGuid,
      'MonoImporter:',
      '  externalObjects: {}',
      '  serializedVersion: 2',
      '  defaultReferences: []',
      '  executionOrder: 0',
      '  icon: {instanceID: 0}',
      '  userData: ',
      '  assetBundleName: ',
      '  assetBundleVariant: ',
    ].join('\n'));

    fs.writeFileSync(path.join(scripts, 'GFM_CameraController.cs'), [
      'using UnityEngine;',
      'public class GFM_CameraController : MonoBehaviour',
      '{',
      '    public void Init()',
      '    {',
      '        var cam = Camera.main;',
      '        if (cam != null)',
      '        {',
      '            cam.orthographic = true;',
      '            cam.orthographicSize = 8f;',
      '            cam.transform.position = new Vector3(0, 12f, -8f);',
      '            cam.transform.rotation = Quaternion.Euler(50f, 0f, 0f);',
      '        }',
      '    }',
      '}',
    ].join('\n'));
    fs.writeFileSync(path.join(scripts, 'GFM_Player.cs'), fs.readFileSync(path.join(__dirname, '..', 'worker', 'GFM_Player.cs'), 'utf8'));

    const summary = cleaner.cleanProgrammerDelivery(tmpV12, {
      project: {
        id: 'v12',
        name: 'v12',
        entities: [
          { name: '_player', visual: { position: '(-8, 0, 2)' } },
          { name: 'SpaceShip', visual: { position: '(-10, 0, 4)' } },
          { name: '_gold', visual: { position: '(-4, 0, -2)' } },
          { name: '_ctaButton', visual: { position: '(6, 0, 3)' } }
        ]
      }
    });
    const coreModules = path.join(scripts, 'Core', 'Modules');
    const gameLevel = path.join(scripts, 'Game', 'Level');
    const gameAutoPlay = path.join(scripts, 'Game', 'AutoPlay');
    const phaseDir = path.join(scripts, 'Game', 'Phases');
    [
      [coreModules, 'GMP_MainManager'],
      [coreModules, 'GMP_PhaseController'],
      [gameLevel, 'GMP_EntityBindingManager'],
      [gameAutoPlay, 'GMP_AutoPlayDriver'],
      [coreModules, 'GMP_HudController'],
      [coreModules, 'GMP_EventModule'],
      [gameLevel, 'GMP_LevelRuleEngine']
    ].forEach(([dir, name]) => {
      const file = path.join(dir, name + '.cs');
      assert.ok(fs.existsSync(file), name + '.cs should be generated in v14 layout');
      const text = fs.readFileSync(file, 'utf8');
      assert.doesNotMatch(text, /\bpartial\s+class\b/, name + ' must not be partial');
      assert.match(text, new RegExp('class\\s+' + name + '\\b'), name + ' should own its class');
    });
    assert.ok(fs.existsSync(path.join(coreModules, 'GMP_PhasePreset.cs')));
    assert.ok(fs.existsSync(path.join(coreModules, 'GMP_PhaseGate.cs')));
    const phasePresetCode = fs.readFileSync(path.join(coreModules, 'GMP_PhasePreset.cs'), 'utf8');
    assert.match(phasePresetCode, /public class GMP_PhasePreset : ScriptableObject/);
    assert.doesNotMatch(phasePresetCode, /class PhasePreset\b/);
    const phaseGateCode = fs.readFileSync(path.join(coreModules, 'GMP_PhaseGate.cs'), 'utf8');
    assert.match(phaseGateCode, /public class GMP_PhaseGate/);
    assert.match(phaseGateCode, /switch \(mKind\)/, 'PhaseGate should use an explicit enum switch');
    assert.match(phaseGateCode, /case GMP_PhaseGateKind\.Resource/, 'resource gate branch should be generated');
    assert.match(phaseGateCode, /case GMP_PhaseGateKind\.Entity/, 'entity gate branch should be generated');
    assert.match(phaseGateCode, /GMP_EconomyManager\.instance\.GetCollectedResource\(mTarget\)/, 'resource gates should read cumulative collected resources');
    const phaseControllerCode = fs.readFileSync(path.join(coreModules, 'GMP_PhaseController.cs'), 'utf8');
    assert.match(phaseControllerCode, /preset\.mGate\.IsReady/, 'PhaseController should use PhasePreset gate data');
    const entityBindingCode = fs.readFileSync(path.join(gameLevel, 'GMP_EntityBindingManager.cs'), 'utf8');
    assert.match(entityBindingCode, /int GetActiveCount\(string entityName\)/, 'EntityBindingManager should expose active-count gate helper');
    assert.match(fs.readFileSync(path.join(gameLevel, 'GMP_EntityBinding.cs'), 'utf8'), /public Vector3 mOriginalPosition/, 'EntityBinding item should cache source scene position');
    assert.match(entityBindingCode, /private void PrepareBinding\(GMP_EntityBinding binding\)/, 'EntityBindingManager should cache original transforms during Init');
    assert.match(entityBindingCode, /pos\.y < -100f && binding != null/, 'Phase changes should preserve runtime transforms instead of resetting visible source entities');
    assert.match(entityBindingCode, /ship\.transform\.position = Vector3\.Lerp\(ship\.transform\.position, desired, Mathf\.Clamp01\(dt \* 1\.35f\)\)/, 'SpaceShip should follow the player using the source runtime offset');
    assert.match(entityBindingCode, /SetVisible\(target, false\)/, 'Hide should toggle renderers instead of moving entities off board');
    assert.doesNotMatch(entityBindingCode, /target\.transform\.position = new Vector3\(0f, -999f, 0f\)/, 'Hide must not destroy source positions');
    assert.ok(!fs.existsSync(path.join(scripts, 'MainManager.cs')), 'root MainManager god class should be removed');
    assert.ok(!fs.existsSync(path.join(gameLevel, 'GMP_EventRuleEngine.cs')), 'specific rules should be named LevelRuleEngine');
    assert.strictEqual(walkLocal(scripts).filter((file) => /\.Part\d*\.cs$/.test(file)).length, 0);
    assert.strictEqual(walkLocal(scripts).filter((file) => /(Runtime|Facade)\.cs$/.test(file)).length, 0);
    assert.strictEqual(walkLocal(scripts).filter((file) => /void\s+Spawn[A-Z][A-Za-z]+\s*\(/.test(fs.readFileSync(file, 'utf8'))).length, 0);
    const generatedCsText = walkLocal(scripts)
      .filter((file) => path.extname(file).toLowerCase() === '.cs')
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('\n');
    assert.doesNotMatch(generatedCsText, /\/\/\s*方法说明：执行/, 'delivery scripts should not contain empty generated method comments');
    assert.doesNotMatch(generatedCsText, /\/\/\s*(初始化当前模块|按帧推进当前模块|Unity 生命周期入口：|Unity 每帧更新入口：|Unity LateUpdate 入口：|更新玩家引导文案)/, 'delivery scripts should not contain obvious boilerplate comments');
    assert.doesNotMatch(generatedCsText, /GameObject\.Find|FindObjectOfType|Resources\.FindObjectsOfTypeAll|\.AddComponent\s*(?:<|\()|new\s+GameObject\s*\(/, 'delivery scripts should not mention runtime lookup or object creation APIs');
    assert.strictEqual(fs.readdirSync(phaseDir).filter((name) => /^Phase\d+\.asset$/.test(name)).length, 2);
    const phase1Asset = fs.readFileSync(path.join(phaseDir, 'Phase1.asset'), 'utf8');
    const phase2Asset = fs.readFileSync(path.join(phaseDir, 'Phase2.asset'), 'utf8');
    assert.match(phase1Asset, /mTargetEntity: "_gold"/, 'phase1 target should follow the original gate entity');
    assert.match(phase1Asset, /  - _gold/, 'gate entity should be visible/interactable in the phase asset');
    assert.match(phase1Asset, /mKind: 3/, 'phase1 gate should be data-driven enum value');
    assert.match(phase1Asset, /mTarget: "_gold"/, 'phase1 gate should keep the original gate target');
    assert.match(phase1Asset, /mThreshold: 2/, 'entity gates should use built-state threshold');
    assert.match(phase2Asset, /mTarget: "_ctaButton"/, 'last phase should use EndGame gate target');
    const scene = fs.readFileSync(path.join(scenes, 'Game.unity'), 'utf8');
    ['GMP_MainManager', 'GMP_PhaseController', 'GMP_EntityBindingManager', 'GMP_AutoPlayDriver', 'GMP_HudController', 'GMP_EventModule', 'GMP_LevelRuleEngine'].forEach((name) => {
      assert.strictEqual((scene.match(new RegExp('m_Name: ' + name, 'g')) || []).length, 1, name + ' should be scene-mounted once');
    });
    assert.match(scene, /m_Name: "Text_Tip"/, 'HUD guide text placeholder should be scene-mounted');
    assert.match(scene, /mCanvas: \{fileID: [1-9][0-9]*/, 'scene should bind HUD/UI Canvas references through serialized fields');
    assert.match(scene, /mGuideText: \{fileID: [1-9][0-9]*/, 'scene should bind guide Text references through serialized fields');
    assert.match(scene, /mToastText: \{fileID: [1-9][0-9]*/, 'scene should bind toast Text references through serialized fields');
    assert.match(scene, /mTargetHintText: \{fileID: [1-9][0-9]*/, 'scene should bind target hint Text references through serialized fields');
    assert.match(scene, /mPlayerObject: \{fileID: [1-9][0-9]*/, 'scene should bind Player object references through serialized fields');
    assert.match(scene, /mPlayerTransform: \{fileID: [1-9][0-9]*/, 'scene should bind camera Player transform references through serialized fields');
    assert.match(scene, /mBindings:\n\s+- mEntityName: "_player"\n\s+mSceneObject: \{fileID: [1-9][0-9]*\}\n\s+mLabelText: \{fileID: [1-9][0-9]*/, 'entity binding table should serialize scene object and label refs');
    const unassignedAddressable = scene.match(/\b(?:mCanvas|mGuideText|mToastText|mTargetHintText|mPlayerObject|mPlayerTransform|mSceneObject|mLabelText): \{fileID: 0\}/);
    assert.strictEqual(unassignedAddressable && unassignedAddressable[0], null, 'addressable delivery references must not be left unassigned');
    assert.doesNotMatch(scene, /m_Name: "Text_Score: 0"/, 'source-aligned HUD should not create a duplicate Score text');
    assert.doesNotMatch(scene, /m_Name: "Text_PhaseProgress"/, 'source-aligned HUD should not create overlapping phase progress text');
    assert.match(scene, /guid: 5f7201a12d95ffc409449d95f23cf332/, 'scene text placeholders should carry Unity UI Text components');
    assert.doesNotMatch(scene, new RegExp(legacyActivatorGuid), 'legacy ScriptActivator scene refs must be remapped to the generated GMP script guid');
    assert.match(scene, new RegExp(generatedActivatorGuid), 'GMP_ScriptActivator scene refs should resolve to the generated script meta');
    assert.doesNotMatch(scene, new RegExp(legacyPlaceholderGuid), 'template placeholder GameManager script refs must be stripped');
    assert.match(scene, new RegExp(templateAdditionalLightGuid), 'URP light data should stay attached for render fidelity');
    assert.match(scene, new RegExp(templateAdditionalCameraGuid), 'URP camera data should stay attached for render fidelity');
    assert.match(scene, overlayCanvasSceneRe, 'delivery Canvas should render as Overlay, not a camera-space plane over 3D');
    assert.doesNotMatch(scene, new RegExp(oldGraphicRaycasterGuid), 'stale GraphicRaycaster GUID should be remapped');
    assert.match(scene, new RegExp(newGraphicRaycasterGuid), 'GraphicRaycaster should resolve to the Unity 2022.3 package GUID');
    assert.doesNotMatch(scene, new RegExp(oldEventSystemGuid), 'stale EventSystem GUID should be remapped');
    assert.match(scene, new RegExp(newEventSystemGuid), 'EventSystem should resolve to the Unity 2022.3 package GUID');
    assert.match(scene, new RegExp(nonWhitelistedPackageGuid), 'package GUID repair must stay whitelist-only and preserve unrelated package MonoBehaviours');
    assert.strictEqual(summary.knownPackageSceneScriptRefsRemapped, 2);
    assert.strictEqual((scene.match(/guid:/g) || []).length >= 8, true, 'scene should contain script refs plus phase asset refs');
    assert.match(scene, /m_Name: Main Camera[\s\S]*m_LocalPosition: \{x: 6, y: 18, z: 28\}/, 'Phase1 camera should use the source HTML player-follow framing');
    assert.match(scene, /m_LocalEulerAnglesHint: \{x: 34\.7, y: 202\.6, z: 0\}/, 'Phase1 camera should use the source-like oblique angle');
    assert.match(scene, /m_Name: _player[\s\S]*m_TagString: Player/, 'Player entity should be tagged for camera follow lookup');
    const deliveryCamera = fs.readFileSync(path.join(scripts, 'Tool', 'GMP_CameraController.cs'), 'utf8');
    assert.doesNotMatch(deliveryCamera, /orthographic\s*=\s*true/, 'delivery camera must not override the scene-authored projection');
    assert.doesNotMatch(deliveryCamera, /new Vector3\(0,\s*12f,\s*-8f\)/, 'delivery camera must not override the scene-authored first-frame pose');
    assert.match(deliveryCamera, /public Transform mPlayerTransform;/, 'delivery camera should expose an Inspector/MCP-assigned Player transform');
    assert.match(deliveryCamera, /if \(mPlayerTransform != null\) return mPlayerTransform;/, 'delivery camera should prefer the assigned Player transform');
    assert.match(deliveryCamera, /GMP_Player\.instance/, 'delivery camera may fall back to the scene-mounted Player script singleton');
    assert.doesNotMatch(deliveryCamera, /GameObject\.Find|FindObjectOfType|Resources\.FindObjectsOfTypeAll|AddComponent|new\s+GameObject/, 'delivery camera must not use runtime scene lookup or component creation');
    assert.match(deliveryCamera, /Vector3 target = SourceFollowTarget\(player\.position\);/);
    assert.match(deliveryCamera, /Vector3 pos = SourceFollowPosition\(target\);/);
    assert.match(deliveryCamera, /return playerPosition \+ new Vector3\(4f, 0f, 2f\);/);
    assert.match(deliveryCamera, /return target \+ new Vector3\(10f, 18f, 24f\);/);
    assert.match(deliveryCamera, /Time\.deltaTime \* 2\.2f/);
    assert.match(deliveryCamera, /FramePhaseEntities\(GMP_PhasePreset preset\)/, 'delivery camera should expose runtime source-follow phase framing');
    assert.match(deliveryCamera, /Vector3 lookAt = SourceFollowTarget\(player\.position\);/, 'phase framing should use the source runtime camera target');
    assert.match(deliveryCamera, /Vector3 cameraPos = SourceFollowPosition\(lookAt\);/, 'phase framing should use the source runtime camera offset');
    assert.doesNotMatch(deliveryCamera, /Mathf\.Clamp\(span \//, 'later phase framing must not invent AABB zoom over the source camera contract');
    assert.match(deliveryCamera, /mMainCam\.fieldOfView = 46f;/, 'phase framing should keep the source HTML PerspectiveCamera FOV');
    assert.match(deliveryCamera, /mPhaseFrameHoldUntilFrame = Time\.frameCount \+ 120/, 'phase framing should hold through screenshot probes');
    assert.match(deliveryCamera, /SetEndStateCamera\(\)/, 'delivery camera should expose the source end-state overview pose');
    assert.match(deliveryCamera, /Vector3 lookAt = new Vector3\(36f, 0f, 2f\)/, 'source end-state target should be preserved for non-flipped sources');
    assert.match(deliveryCamera, /if \(IsPhaseFrameHoldActive\) return/, 'source follow must not overwrite phase entry screenshot framing');
    assert.match(deliveryCamera, /GMP_UIManager\.instance\.SyncSceneEntityLabels\(\)/, 'camera LateUpdate should refresh labels after camera movement');
    const deliveryPlayer = fs.readFileSync(path.join(scripts, 'Game', 'Player', 'GMP_Player.cs'), 'utf8');
    assert.match(deliveryPlayer, /public class GMP_Player : GMP_PlayerBase/, 'project Player should inherit the reusable Core Player base');
    assert.match(deliveryPlayer, /protected override void Awake\(\)/, 'project Player should override the Core PlayerBase Awake hook');
    assert.match(deliveryPlayer, /base\.Awake\(\);/, 'project Player should register the Core PlayerBase singleton state');
    assert.match(deliveryPlayer, /Bind\(Go, PlayerPoolName, "Player"\);/, 'project Player should bind its source scene object to GMP_PlayerBase');
    assert.doesNotMatch(deliveryPlayer, /mPlayer\.transform\.position = new Vector3\(0f, 0\.5f, 0f\)/, 'Player runtime init must not overwrite the source scene position');
    assert.match(deliveryPlayer, /public GameObject mPlayerObject;/, 'Player should expose an Inspector/MCP-assigned scene object');
    assert.match(deliveryPlayer, /return mPlayerObject;/, 'Player runtime init should bind the assigned scene object');
    assert.match(deliveryPlayer, /Debug\.LogError\("GMP_Player [^"]*Player/, 'Player runtime init should fail loudly when source Player is missing');
    assert.doesNotMatch(deliveryPlayer, /CreatePrimitive\(PrimitiveType\.Cylinder\)/, 'Player runtime init must not create primitive fallback players');
    assert.doesNotMatch(deliveryPlayer, /__Pool_(?:Cylinder|Capsule|Cube)/, 'Player runtime init must not scan old Luna primitive pools');
    assert.match(deliveryPlayer, /moveSpeed=6f/, 'Player fallback speed should match source HTML 6u/s');
    assert.match(deliveryPlayer, /private void EnsureRuntimeComponents\(\)/, 'Player controller should resolve required components from YAML-mounted scene objects');
    assert.match(deliveryPlayer, /mMovementComponent = GetComponent<GMP_MovementComponent>\(\);/, 'Player movement component should be scene-mounted instead of added at runtime');
    assert.doesNotMatch(deliveryPlayer, /GameObject\.Find|FindObjectOfType|Resources\.FindObjectsOfTypeAll|AddComponent|new\s+GameObject/, 'Player must not use runtime scene lookup or component creation');
    assert.match(deliveryPlayer, /mJoystick\.PollInput\(\);/, 'GMP Player path should also tick the joystick widget before reading movement axes');
    assert.match(deliveryPlayer, /Vector3 input = new Vector3\(-h, 0, -v\)/, 'Joystick axes should map to screen-space movement under the storyboard camera with real-time movement dt');
    assert.match(deliveryPlayer, /Vector3 move = input \* MoveSpeed \* moveDt/, 'Joystick movement should still use the real-time movement dt');
    assert.doesNotMatch(deliveryPlayer, /new Vector3\(h, 0, -v\)/, 'Joystick horizontal axis must not use the pre-storyboard camera mapping');
    const deliveryMovement = fs.readFileSync(path.join(scripts, 'Core', 'Components', 'GMP_MovementComponent.cs'), 'utf8');
    assert.match(deliveryMovement, /public void Move\(Transform target, Vector3 direction, float speed, float dt\)/, 'movement component should accept caller-supplied real-time dt');
    assert.match(deliveryMovement, /Vector3 delta = direction\.normalized \* \(finalSpeed \* safeDt\);/, 'movement component should not force Time.deltaTime when caller supplies dt');
    assert.strictEqual(summary.playerTaggedForCameraFollow, true);
    assert.strictEqual(summary.deliveryCameraControllerFollowRepaired, true);
    assert.strictEqual(summary.initialPhaseCameraFramed, true);
    assert.strictEqual(summary.runtimeSplitFiles, 0);
    assert.strictEqual(summary.phasePresetAssets, 2);
  } finally {
    fs.rmSync(tmpV12, { recursive: true, force: true });
  }
}

// 2026-05-24 v13.1：程序员 Unity 交付必须同步 storyboard2html 的 scene-level 背景/雾/地面色。
{
  const tmpScene = fs.mkdtempSync(path.join(os.tmpdir(), 'programmer-scene-contract-'));
  try {
    const scripts = path.join(tmpScene, 'Assets', 'Scripts');
    const scenes = path.join(tmpScene, 'Assets', 'Scenes');
    const shaderDir = path.join(tmpScene, 'Assets', 'Shader');
    fs.mkdirSync(scripts, { recursive: true });
    fs.mkdirSync(scenes, { recursive: true });
    fs.mkdirSync(shaderDir, { recursive: true });
    fs.writeFileSync(path.join(scripts, 'MonoSingleton.cs'), 'using UnityEngine;\npublic abstract class MonoSingleton<T> : MonoBehaviour where T : MonoBehaviour {}\n');
    fs.writeFileSync(path.join(shaderDir, 'SimpleLit.shader'), 'Shader "URP/SimpleLit" {}\n');
    fs.writeFileSync(path.join(shaderDir, 'SimpleLit.shader.meta'), 'fileFormatVersion: 2\nguid: 69c1b8dc91f9ab449b8f3f249d4d62bf\n');
    const sourceHtml = path.join(tmpScene, 'source.html');
    fs.writeFileSync(sourceHtml, [
      '<script>',
      'const SCENE_CONFIG = {',
      '  backgroundColor: 0x071026,',
      '  fog: { color: 0x071026, near: 55, far: 145 },',
      '  ground: { color: 0x13233a },',
      '  ambientLight: { color: 0xffffff, intensity: 0.62 },',
      '  directionalLight: { color: 0xffffff, intensity: 1.25 }',
      '};',
      '</script>'
    ].join('\n'));
    const groundGuid = '179fb0b77823b6345a0e6843ab9398d1';
    fs.writeFileSync(path.join(scenes, 'Game.unity'), [
      '%YAML 1.1',
      '%TAG !u! tag:unity3d.com,2011:',
      '--- !u!104 &2',
      'RenderSettings:',
      '  m_ObjectHideFlags: 0',
      '  serializedVersion: 9',
      '  m_Fog: 0',
      '  m_FogColor: {r: 0.5, g: 0.5, b: 0.5, a: 1}',
      '  m_FogMode: 3',
      '  m_FogDensity: 0.01',
      '  m_LinearFogStart: 0',
      '  m_LinearFogEnd: 300',
      '  m_AmbientSkyColor: {r: 0.2, g: 0.2, b: 0.2, a: 1}',
      '  m_AmbientEquatorColor: {r: 0.2, g: 0.2, b: 0.2, a: 1}',
      '  m_AmbientGroundColor: {r: 0.2, g: 0.2, b: 0.2, a: 1}',
      '  m_SkyboxMaterial: {fileID: 10304, guid: 0000000000000000f000000000000000, type: 0}',
      '--- !u!1 &100',
      'GameObject:',
      '  m_Component:',
      '  - component: {fileID: 101}',
      '  - component: {fileID: 102}',
      '  m_Name: Main Camera',
      '  m_TagString: MainCamera',
      '  m_IsActive: 1',
      '--- !u!4 &101',
      'Transform:',
      '  m_GameObject: {fileID: 100}',
      '  serializedVersion: 2',
      '  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}',
      '  m_LocalPosition: {x: 0, y: 8, z: -12}',
      '  m_LocalScale: {x: 1, y: 1, z: 1}',
      '  m_Children: []',
      '  m_Father: {fileID: 0}',
      '  m_LocalEulerAnglesHint: {x: 0, y: 0, z: 0}',
      '--- !u!20 &102',
      'Camera:',
      '  m_GameObject: {fileID: 100}',
      '  m_ClearFlags: 2',
      '  m_BackGroundColor: {r: 0.45, g: 0.54, b: 0.62, a: 1}',
      '  far clip plane: 1000',
      '  field of view: 60',
      '--- !u!1 &200',
      'GameObject:',
      '  m_Component:',
      '  - component: {fileID: 201}',
      '  - component: {fileID: 202}',
      '  m_Name: __Ground',
      '  m_IsActive: 1',
      '--- !u!4 &201',
      'Transform:',
      '  m_GameObject: {fileID: 200}',
      '  serializedVersion: 2',
      '  m_LocalPosition: {x: 0, y: 0, z: 0}',
      '--- !u!23 &202',
      'MeshRenderer:',
      '  m_GameObject: {fileID: 200}',
      '  m_Materials:',
      '  - {fileID: 2100000, guid: ' + groundGuid + ', type: 2}',
      ''
    ].join('\n'));

    const summary = cleaner.cleanProgrammerDelivery(tmpScene, {
      project: { id: 'scene-contract', name: 'scene-contract', visualAssets: { source: sourceHtml } }
    });
    assert.strictEqual(summary.sceneContractApplied, true);
    assert.strictEqual(summary.sceneContractGroundColor, true);
    assert.strictEqual(summary.sceneContractFog, true);
    const scene = fs.readFileSync(path.join(scenes, 'Game.unity'), 'utf8');
    assert.match(scene, /m_Fog: 1/);
    assert.match(scene, /m_FogColor: \{r: 0\.0275, g: 0\.0627, b: 0\.1490, a: 1\.0000\}/);
    assert.match(scene, /m_FogMode: 1/);
    assert.match(scene, /m_LinearFogStart: 55/);
    assert.match(scene, /m_LinearFogEnd: 145/);
    assert.match(scene, /m_SkyboxMaterial: \{fileID: 0\}/);
    assert.match(scene, /m_BackGroundColor: \{r: 0\.0275, g: 0\.0627, b: 0\.1490, a: 1\.0000\}/);
    const generatedMaterials = path.join(tmpScene, 'Assets', 'Materials', 'Generated');
    const groundMat = fs.readdirSync(generatedMaterials)
      .filter((name) => /Ground.*\.mat$/.test(name))
      .map((name) => path.join(generatedMaterials, name))[0];
    assert.ok(groundMat, 'ground fallback material should be generated');
    const groundText = fs.readFileSync(groundMat, 'utf8');
    assert.match(groundText, /_Color: \{r: 0\.0745, g: 0\.1373, b: 0\.2275, a: 1\.0000\}/);
    assert.match(groundText, /_ColorTint: \{r: 0\.0065, g: 0\.0168, b: 0\.0423, a: 1\.0000\}/);
    assert.match(groundText, /_EmissionColor: \{r: 0\.0000, g: 0\.0000, b: 0\.0000, a: 1\.0000\}/);
    assert.match(fs.readFileSync(groundMat + '.meta', 'utf8'), new RegExp('guid: ' + groundGuid));
  } finally {
    fs.rmSync(tmpScene, { recursive: true, force: true });
  }
}

// 2026-05-24 v15.5：资源实体不能继续交付内置 Cube，占位资源要兜底成 SourcePrimitive。
{
  const tmpFallback = fs.mkdtempSync(path.join(os.tmpdir(), 'programmer-fallback-primitive-'));
  try {
    const scripts = path.join(tmpFallback, 'Assets', 'Scripts');
    const scenes = path.join(tmpFallback, 'Assets', 'Scenes');
    const shaderDir = path.join(tmpFallback, 'Assets', 'Shader');
    fs.mkdirSync(scripts, { recursive: true });
    fs.mkdirSync(scenes, { recursive: true });
    fs.mkdirSync(shaderDir, { recursive: true });
    fs.writeFileSync(path.join(shaderDir, 'SimpleLit.shader'), 'Shader "URP/SimpleLit" {}\n');
    fs.writeFileSync(path.join(shaderDir, 'SimpleLit.shader.meta'), 'fileFormatVersion: 2\nguid: 69c1b8dc91f9ab449b8f3f249d4d62bf\n');
    fs.writeFileSync(path.join(tmpFallback, 'README.md'), '# Unity 工程导出\n');
    fs.writeFileSync(path.join(scenes, 'Game.unity'), [
      '%YAML 1.1',
      '%TAG !u! tag:unity3d.com,2011:',
      '--- !u!1 &100',
      'GameObject:',
      '  m_ObjectHideFlags: 0',
      '  m_CorrespondingSourceObject: {fileID: 0}',
      '  m_PrefabInstance: {fileID: 0}',
      '  m_PrefabAsset: {fileID: 0}',
      '  serializedVersion: 6',
      '  m_Component:',
      '  - component: {fileID: 101}',
      '  - component: {fileID: 102}',
      '  - component: {fileID: 103}',
      '  m_Layer: 0',
      '  m_Name: _gold',
      '  m_TagString: Untagged',
      '  m_Icon: {fileID: 0}',
      '  m_NavMeshLayer: 0',
      '  m_StaticEditorFlags: 0',
      '  m_IsActive: 1',
      '--- !u!4 &101',
      'Transform:',
      '  m_ObjectHideFlags: 0',
      '  m_CorrespondingSourceObject: {fileID: 0}',
      '  m_PrefabInstance: {fileID: 0}',
      '  m_PrefabAsset: {fileID: 0}',
      '  m_GameObject: {fileID: 100}',
      '  serializedVersion: 2',
      '  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}',
      '  m_LocalPosition: {x: -4, y: 0, z: -2}',
      '  m_LocalScale: {x: 1, y: 1, z: 1}',
      '  m_ConstrainProportionsScale: 0',
      '  m_Children: []',
      '  m_Father: {fileID: 0}',
      '  m_LocalEulerAnglesHint: {x: 0, y: 0, z: 0}',
      '--- !u!33 &102',
      'MeshFilter:',
      '  m_ObjectHideFlags: 0',
      '  m_CorrespondingSourceObject: {fileID: 0}',
      '  m_PrefabInstance: {fileID: 0}',
      '  m_PrefabAsset: {fileID: 0}',
      '  m_GameObject: {fileID: 100}',
      '  m_Mesh: {fileID: 10202, guid: 0000000000000000e000000000000000, type: 0}',
      '--- !u!23 &103',
      'MeshRenderer:',
      '  m_ObjectHideFlags: 0',
      '  m_CorrespondingSourceObject: {fileID: 0}',
      '  m_PrefabInstance: {fileID: 0}',
      '  m_PrefabAsset: {fileID: 0}',
      '  m_GameObject: {fileID: 100}',
      '  m_Enabled: 1',
      '  m_Materials:',
      '  - {fileID: 2100000, guid: 11111111111111111111111111111111, type: 2}',
      ''
    ].join('\n'));

    const summary = cleaner.cleanProgrammerDelivery(tmpFallback, {
      project: { id: 'fallback-resource-primitive', name: 'Fallback Resource Primitive' },
      validatorOpts: { maxLines: 10000 }
    });
    const scene = fs.readFileSync(path.join(scenes, 'Game.unity'), 'utf8');
    assert.strictEqual(summary.fallbackSourcePrimitiveEntityCount, 1);
    assert.strictEqual(summary.fallbackSourcePrimitiveRendererCount, 1);
    assert.deepStrictEqual(summary.fallbackSourcePrimitiveNames, ['_gold']);
    assert.deepStrictEqual(summary.extractorMissingPrimitiveEntities, ['_gold']);
    assert.match(scene, /m_Name: SourcePrimitive_Gold_Fallback_00/);
    assert.match(scene, /mGeometryType: "CylinderGeometry"/);
    assert.match(scene, /mArgs:\n  - 0\.42\n  - 0\.42\n  - 0\.18\n  - 32/);
    assert.doesNotMatch(scene, /m_Mesh: \{fileID: 10202, guid: 0000000000000000e000000000000000, type: 0\}/);
    assert.match(scene, /m_Children:\n  - \{fileID:/);
  } finally {
    fs.rmSync(tmpFallback, { recursive: true, force: true });
  }
}

// 2026-05-24 v15.6：程序员 Unity 首帧必须以 storyboard2html 源 HTML 的 PHASES[].showEntities 为准，
// gate target 仍保留在 PhaseGate,但不能强行塞进首帧入画列表。
{
  const tmpSourcePhases = fs.mkdtempSync(path.join(os.tmpdir(), 'programmer-source-phases-'));
  try {
    const scripts = path.join(tmpSourcePhases, 'Assets', 'Scripts');
    const scenes = path.join(tmpSourcePhases, 'Assets', 'Scenes');
    fs.mkdirSync(scripts, { recursive: true });
    fs.mkdirSync(scenes, { recursive: true });
    fs.writeFileSync(path.join(tmpSourcePhases, 'source.html'), [
      '<script>',
      'const ENTITY_POSITIONS = {',
      '  Player: {x:-8,y:0,z:2},',
      '  OxygenShop: {x:-12,y:0,z:-4},',
      '  CtaButton: {x:4,y:0,z:8}',
      '};',
      'const PHASES = [',
      '  {id:"phase1",name:"买氧气",guideText:"先到氧气购买台",showEntities:["Player","OxygenShop"],trigger:{type:"resource_collected",resource:"Coin",amount:6},steps:[{target:"OxygenShop",label:"购买氧气",gain:"Coin",amount:6}]},',
      '  {id:"phase2",name:"结束",guideText:"到终点",showEntities:["Player","CtaButton"],steps:[{target:"CtaButton",label:"结束"}]}',
      '];',
      '</script>'
    ].join('\n'));
    fs.writeFileSync(path.join(scenes, 'Game.unity'), [
      '%YAML 1.1',
      '%TAG !u! tag:unity3d.com,2011:',
      '--- !u!29 &1',
      'OcclusionCullingSettings:',
      '  m_ObjectHideFlags: 0',
      minimalSceneObject(9100, 9101, '_gold', { x: 1, y: 0, z: 1 }),
      minimalSceneObject(9200, 9201, '_ice', { x: 2, y: 0, z: 2 }),
      minimalSceneObject(9300, 9301, '_scrap', { x: 3, y: 0, z: 3 }),
      ''
    ].join('\n'));
    fs.writeFileSync(path.join(scripts, 'MonoSingleton.cs'), 'using UnityEngine;\npublic abstract class MonoSingleton<T> : MonoBehaviour where T : MonoBehaviour {}\n');
    fs.writeFileSync(path.join(scripts, 'GFM_CameraController.cs'), [
      'using UnityEngine;',
      'public class GFM_CameraController : MonoBehaviour',
      '{',
      '    void LateUpdate() {}',
      '}',
    ].join('\n'));
    fs.writeFileSync(path.join(scripts, 'MainManager.cs'), [
      'using UnityEngine;',
      'public class MainManager : MonoSingleton<MainManager>',
      '{',
      '    string[] _entityBindingIds = new string[] { "_player", "_oxygenShop", "_gold", "_ice", "_scrap", "_ctaButton" };',
      '    public GameObject _player;',
      '    public GameObject _oxygenShop;',
      '    public GameObject _gold;',
      '    public GameObject _ice;',
      '    public GameObject _scrap;',
      '    public GameObject _ctaButton;',
      '    void Phase_phase1_Init() { GMP_VisualGuide.HighlightTarget(_oxygenShop); }',
      '    void Phase_phase2_Init() { GMP_VisualGuide.HighlightTarget(_ctaButton); }',
      '    bool Phase_phase2_GateReady() { return EntityAdvanced(_gold, _snapGoldPos) && PhaseDwellReady(12f); }',
      '    bool EndGame_GateReady() { return EntityAdvanced(_ctaButton, _snapCtaPos) && PhaseDwellReady(12f); }',
      '}',
    ].join('\n'));

    const summary = cleaner.cleanProgrammerDelivery(tmpSourcePhases, {
      project: {
        id: 'source-phases',
        name: 'source-phases',
        visualAssets: {
          source: path.join(tmpSourcePhases, 'source.html'),
          sourceSceneContract: { present: true, guidance: { present: true } }
        }
      },
      validatorOpts: { maxLines: 10000 }
    });
    const phase1Asset = fs.readFileSync(path.join(scripts, 'Game', 'Phases', 'Phase1.asset'), 'utf8');
    assert.match(phase1Asset, /mGuideText: "先到氧气购买台"/);
    assert.match(phase1Asset, /mTargetEntity: "_oxygenShop"/);
    assert.match(phase1Asset, /mGainResource: "Coin"/);
    assert.match(phase1Asset, /mGainAmount: 6/);
    assert.match(phase1Asset, /IsRuntimeUsesStepGate: 1/);
    assert.match(phase1Asset, /mGate:\n    mKind: 2\n    mTarget: "Coin"\n    mThreshold: 6/);
    assert.match(phase1Asset, /  - _player/);
    assert.match(phase1Asset, /  - _oxygenShop/);
    assert.doesNotMatch(phase1Asset, /  - _(gold|ice|scrap)/);
    assert.ok((summary.phaseSourceTraceLines || []).some((line) => line.includes('src.gate=resource_collected Coin=6 -> unity.gate=resource Coin=6')));
    const hudController = fs.readFileSync(path.join(scripts, 'Core', 'Modules', 'GMP_HudController.cs'), 'utf8');
    assert.match(hudController, /public Text mToastText;/);
    assert.match(hudController, /mToastText\.text = text == null \? "" : text/);
    assert.match(hudController, /mToastTimer = mToastText\.enabled \? 1f : 0f/);
    assert.match(hudController, /if \(mToastText != null && mToastTimer > 0f\)/);
    assert.match(hudController, /mToastText\.enabled = false/);
    assert.match(hudController, /public Text mTargetHintText;/);
    assert.doesNotMatch(hudController, /FindText\(/, 'HUD text references should be assigned by scene/Inspector/MCP');
    assert.match(hudController, /public void SetTargetHint\(string targetEntity\)/);
    assert.match(hudController, /public void SetTargetHint\(string targetEntity, string displayName\)/);
    assert.match(hudController, /mTargetHintText\.text = "目标：" \+ label/);
    assert.doesNotMatch(hudController, /if \(entityName == "_/, 'Core HUD must not hardcode project entity display names');
    const uiManagerPath = path.join(scripts, 'Core', 'Modules', 'GMP_UIManager.cs');
    if (fs.existsSync(uiManagerPath)) {
      const uiManager = fs.readFileSync(uiManagerPath, 'utf8');
      assert.doesNotMatch(uiManager, /DisplayNameForEntity/, 'Core UIManager should use a generic fallback label helper, not a Game display-name mapper');
      assert.match(uiManager, /FallbackEntityLabel\(targetEntity\)/);
    }
    assert.doesNotMatch(hudController, /mScoreText = FindText\("Text_Coin"\)/);
    assert.match(hudController, /GMP_UI\.ConfigureCanvasForCamera\(mCanvas\)/);
    const levelRuleEngine = fs.readFileSync(path.join(scripts, 'Game', 'Level', 'GMP_LevelRuleEngine.cs'), 'utf8');
    assert.match(levelRuleEngine, /using UnityEngine\.UI;/);
    assert.match(levelRuleEngine, /RefreshTargetHint\(\)/);
    assert.match(levelRuleEngine, /GMP_HudController\.instance\.SetTargetHint\(target, DisplayNameForEntity\(target\)\)/);
    assert.match(levelRuleEngine, /SetTargetHintTextDirect\(target\)/);
    assert.match(levelRuleEngine, /UpdateGuidanceVisuals\(target\)/);
    assert.match(levelRuleEngine, /public GameObject mTargetRing;/);
    assert.match(levelRuleEngine, /public GameObject mTrailLine;/);
    assert.match(levelRuleEngine, /public GameObject mLaserLine;/);
    assert.match(levelRuleEngine, /GameObject ring = mTargetRing;/);
    assert.doesNotMatch(levelRuleEngine, /GameObject\.Find/, 'guidance visuals should be scene-assigned, not found at runtime');
    assert.match(levelRuleEngine, /trail\.transform\.rotation = Quaternion\.LookRotation\(delta\)/);
    assert.match(levelRuleEngine, /public Text mTargetHintText;/);
    assert.match(levelRuleEngine, /SetState\(step\.mSetEntity, step\.mSetState\)/);
    const phasePresetCodeStrict = fs.readFileSync(path.join(scripts, 'Core', 'Modules', 'GMP_PhasePreset.cs'), 'utf8');
    assert.match(phasePresetCodeStrict, /public GMP_EntityState mSetState = GMP_EntityState\.Hidden/);
    const phaseController = fs.readFileSync(path.join(scripts, 'Core', 'Modules', 'GMP_PhaseController.cs'), 'utf8');
    assert.match(phaseController, /GMP_CameraController\.instance\.FramePhaseEntities\(preset\)/);
    const entityBinding = fs.readFileSync(path.join(scripts, 'Game', 'Level', 'GMP_EntityBindingManager.cs'), 'utf8');
    assert.doesNotMatch(entityBinding, /"_gold"|" _ice"|" _scrap"|"_ice"|"_scrap"/, 'resource names Gold/Ice/Scrap must not become source-scene entities');
    assert.deepStrictEqual((summary.sourceResourcePhantomSceneObjectNamesRemoved || []).sort(), ['_gold', '_ice', '_scrap']);
    assert.match(entityBinding, /target\.SetActive\((?:visible|isVisible|IsVisibleValue\d*)\)/);
    assert.match(entityBinding, /!target\.activeInHierarchy/);
    assert.doesNotMatch(entityBinding, /\bmEntityLabelNames\b/);
    assert.match(entityBinding, /SetEntityLabelVisible\(binding, true\)/);
    assert.match(entityBinding, /SetEntityLabelVisible\(binding, false\)/);
    const entityBindingItem = fs.readFileSync(path.join(scripts, 'Game', 'Level', 'GMP_EntityBinding.cs'), 'utf8');
    assert.match(entityBinding, /public List<GMP_EntityBinding> mBindings = new List<GMP_EntityBinding>\(\)/);
    assert.match(entityBindingItem, /public Text mLabelText;/);
    assert.match(entityBindingItem, /public float mDefaultScale = 0\.7f;/);
    assert.match(entityBindingItem, /public float mLabelHeightOffset = 2\.2f;/);
    assert.doesNotMatch(entityBinding, /Text labelText = BindingLabel\(index\)/);
    assert.doesNotMatch(entityBinding, /GameObject labelObject = GameObject\.Find/, 'entity labels should be assigned by binding table, not found at runtime');
    assert.match(entityBinding, /binding\.mLabelText\.enabled = (?:isVisible|IsVisibleValue\d*)/);
    assert.match(entityBinding, /GMP_UI\.PositionTextOverEntity\(HudCanvas\(\), binding\.mLabelText, binding\.mSceneObject, LabelHeightOffset\(binding\)\)/);
    assert.match(entityBinding, /private void SyncVisibleEntityLabels\(\)/);
    assert.match(entityBinding, /SyncVisibleEntityLabels\(\)/);
    assert.doesNotMatch(entityBinding, /ArrangeWidePhaseEntitiesForCamera\(preset\)/);
    assert.doesNotMatch(entityBinding, /private bool ShouldArrangeWidePhase\(GMP_PhasePreset preset\)/);
    assert.doesNotMatch(entityBinding, /target\.transform\.position = new Vector3\(anchor\.x \+ x, target\.transform\.position\.y, anchor\.z \+ z\)/);
    assert.doesNotMatch(entityBinding, /\bmDefaultPositions\b/, 'EntityBindingManager should not keep hidden source-position arrays');
    const cameraController = fs.readFileSync(path.join(scripts, 'Tool', 'GMP_CameraController.cs'), 'utf8');
    assert.match(cameraController, /return playerPosition \+ new Vector3\(4f, 0f, -2f\);/, 'HTML camera follow target Z offset should be flipped for Unity');
    assert.match(cameraController, /return target \+ new Vector3\(10f, 18f, -24f\);/, 'HTML camera follow position Z offset should be flipped for Unity');
    assert.match(cameraController, /Vector3 lookAt = SourceFollowTarget\(player\.position\);/, 'Phase-frame target should use the source runtime follow formula');
    assert.match(cameraController, /Vector3 cameraPos = SourceFollowPosition\(lookAt\);/, 'Phase-frame position should use the source runtime follow formula');
    assert.match(cameraController, /Vector3 lookAt = new Vector3\(36f, 0f, -2f\);/, 'End-state target Z should be flipped into Unity');
    assert.match(cameraController, /Vector3 cameraPos = lookAt \+ new Vector3\(0f, 34f, -36f\);/, 'End-state camera offset Z should be flipped into Unity');
    assert.match(cameraController, /GMP_UIManager\.instance\.SyncSceneEntityLabels\(\)/, 'label projection should be refreshed after camera LateUpdate');
    assert.doesNotMatch(cameraController, /Mathf\.Clamp\(span \//, 'Later phases should not use probe-driven active AABB zoom');
    const sceneText = fs.readFileSync(path.join(scenes, 'Game.unity'), 'utf8');
    assert.doesNotMatch(sceneText, /m_Name: _(gold|ice|scrap)\b/, 'phantom resource GameObjects should be removed from scene YAML');
    assert.match(sceneText, /m_Name: __TargetRing/);
    assert.match(sceneText, /m_Name: __TrailLine/);
    assert.match(sceneText, /m_Name: __LaserLine/);
    assert.match(sceneText, /mTargetRing: \{fileID: [1-9][0-9]*/, 'source-guidance scene should bind target-ring visuals through serialized fields');
    assert.match(sceneText, /mTrailLine: \{fileID: [1-9][0-9]*/, 'source-guidance scene should bind trail visuals through serialized fields');
    assert.match(sceneText, /mLaserLine: \{fileID: [1-9][0-9]*/, 'source-guidance scene should bind laser visuals through serialized fields');
    assert.doesNotMatch(sceneText, /\b(?:mTargetRing|mTrailLine|mLaserLine): \{fileID: 0\}/, 'source-guidance visual references must not be left unassigned');
  } finally {
    fs.rmSync(tmpSourcePhases, { recursive: true, force: true });
  }
}

console.log('programmer delivery cleaner tests passed');

function walkLocal(root, out) {
  out = out || [];
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walkLocal(full, out);
    else if (entry.isFile() && /\.cs$/.test(entry.name)) out.push(full);
  }
  return out;
}
