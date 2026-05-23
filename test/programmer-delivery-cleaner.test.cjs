const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cleaner = require('../lib/programmer-delivery-cleaner.cjs');

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
  assert.ok(summary.entityClassFiles >= 6);
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
  assert.ok(fs.existsSync(path.join(tmp, 'Scripts', 'Entities', 'BaseBuildElement.cs')));
  assert.ok(fs.existsSync(path.join(tmp, 'Scripts', 'Entities', 'BuildEntity.cs')));
  assert.ok(fs.existsSync(path.join(tmp, 'Scripts', 'Entities', 'BarrackEntity.cs')));
  assert.match(fs.readFileSync(path.join(tmp, 'Scripts', 'Entities', 'BaseGameFlowEntity.cs'), 'utf8'), /EntityId = ""; \/\/ 蓝图实体 ID/);
  assert.match(fs.readFileSync(path.join(tmp, 'Scripts', 'Entities', 'BaseGameFlowEntity.cs'), 'utf8'), /绑定场景对象和蓝图标识/);
  assert.match(fs.readFileSync(path.join(tmp, 'Scripts', 'Entities', 'BaseBuildElement.cs'), 'utf8'), /public int Health = 100; \/\/ 建筑耐久值/);
  // Wave C: 实体绑定块落到 Main 文件而非继承链 StateBase。
  assert.match(mainText, /领域模型缓存/);
  assert.match(fs.readFileSync(path.join(tmp, 'Scripts', 'Entities', 'BarrackEntity.cs'), 'utf8'), /public class BarrackEntity : BaseBuildElement/);
  // 反馈 01 #1 架构图:PlayerBase / NPCBase 与 BaseBuildElement 同级,都挂在 BaseGameFlowEntity 下。
  assert.ok(fs.existsSync(path.join(tmp, 'Scripts', 'Entities', 'PlayerBase.cs')));
  assert.ok(fs.existsSync(path.join(tmp, 'Scripts', 'Entities', 'NPCBase.cs')));
  const playerBaseSrc = fs.readFileSync(path.join(tmp, 'Scripts', 'Entities', 'PlayerBase.cs'), 'utf8');
  assert.match(playerBaseSrc, /public class PlayerBase : BaseGameFlowEntity/);
  assert.match(playerBaseSrc, /public float MoveSpeed/);
  assert.match(playerBaseSrc, /void MoveByDirection\(Vector3 direction, float dt\)/);
  // 反馈 01 #8 架构图:Player 走单例语义。
  assert.match(playerBaseSrc, /public\s+static\s+PlayerBase\s+Instance/);
  assert.match(playerBaseSrc, /Instance\s*=\s*this/);
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
  assert.match(fs.readFileSync(path.join(tmp, 'CODE_RELATION_GRAPH.md'), 'utf8'), /Entities\/BaseBuildElement\.cs/);
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

    const summary = cleaner.cleanProgrammerDelivery(tmpRef, {
      project: { id: 'proj_ref', name: '参考布局项目' }
    });

    assert.strictEqual(summary.managerDir, managerDir);
    assert.strictEqual(summary.entityDir, path.join(tmpRef, 'Assets', 'Scripts', 'Entities'));
    assert.strictEqual(summary.referenceMainManager, true);
    assert.ok(fs.existsSync(path.join(tmpRef, 'Assets', 'Scripts', 'Entities', 'BaseGameFlowEntity.cs')));
    assert.ok(fs.existsSync(path.join(tmpRef, 'Assets', 'Scripts', 'Entities', 'BarrackEntity.cs')));
    assert.ok(!fs.existsSync(path.join(managerDir, 'Entities')), 'Entities should be sibling to Manager in reference layout');
    assert.ok(fs.existsSync(path.join(managerDir, 'MainManager.cs')));
    assert.ok(fs.existsSync(path.join(managerDir, 'MonoSingleton.cs')));
    assert.ok(!fs.existsSync(path.join(managerDir, 'GameFlowManagerMain.cs')), 'reference layout should merge away GameFlowManagerMain.cs');

    const mainManager = fs.readFileSync(path.join(managerDir, 'MainManager.cs'), 'utf8');
    assert.match(mainManager, /public class MainManager : MonoSingleton<MainManager>/);
    assert.match(mainManager, /public GameObject mBarrack;/);
    assert.match(mainManager, /public GameObject mGold;/);
    assert.match(mainManager, /GFM_ResourceIds\.Gold/);
    assert.doesNotMatch(mainManager, /GFM_ResourceIds\.mGold/);
    assert.doesNotMatch(mainManager, /GFM_Luna\.Init/);
    assert.doesNotMatch(mainManager, /AssemblyRunFlowSlots/);
    assert.doesNotMatch(mainManager, /\bpartial\b/);
    assert.doesNotMatch(mainManager, /\[SKELETON\]/);

    const refReadme = fs.readFileSync(path.join(tmpRef, 'README.md'), 'utf8');
    assert.match(refReadme, /Assets\/Scripts\/Manager/);
    assert.match(refReadme, /Assets\/Scripts\/Entities/);
    assert.match(refReadme, /MainManager\.cs/);
    assert.match(refReadme, /参考工程式脚本布局/);

    const refHandoff = fs.readFileSync(path.join(tmpRef, 'PROGRAMMER_HANDOFF.md'), 'utf8');
    assert.match(refHandoff, /Assets\/Scripts\/Manager/);
    assert.match(refHandoff, /Assets\/Scripts\/Entities/);
    assert.match(refHandoff, /MainManager\.cs/);
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
    fs.writeFileSync(path.join(audio, 'GFM_Audio.cs'), [
      'using UnityEngine;',
      'public class GFM_Audio : MonoBehaviour',
      '{',
      '    private static GFM_Audio _instance;',
      '    public static GFM_Audio Instance { get { return _instance; } }',
      '    public static GFM_Audio Init(GameObject parent)',
      '    {',
      '        var obj = new GameObject("GFM_Audio");',
      '        _instance = obj.AddComponent<GFM_Audio>();',
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
    assert.ok(sa.sceneObjectsInjected >= 2, 'should inject MainManager and GFM_Audio');
    assert.ok(sb.sceneObjectsInjected >= 2, 'should inject MainManager and GFM_Audio');
    const sceneA = fs.readFileSync(path.join(a, 'Assets', 'Scenes', 'Game.unity'), 'utf8');
    const sceneB = fs.readFileSync(path.join(b, 'Assets', 'Scenes', 'Game.unity'), 'utf8');
    assert.strictEqual(sceneA, sceneB, 'scene injection should be deterministic across export roots');
    assert.match(sceneA, /m_Name: MainManager/);
    assert.match(sceneA, /m_Name: GFM_Audio/);
    const audioText = fs.readFileSync(path.join(a, 'Assets', 'Scripts', 'Audio', 'GFM_Audio.cs'), 'utf8');
    assert.doesNotMatch(audioText, /new GameObject/);
    assert.doesNotMatch(audioText, /\bInstance\b/);
    assert.doesNotMatch(audioText, /_instance/);
    assert.match(audioText, /mInstance/);
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
}

console.log('programmer delivery cleaner tests passed');
