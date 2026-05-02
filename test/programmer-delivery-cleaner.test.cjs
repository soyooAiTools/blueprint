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
  assert.match(mainText, /BarrackEntity _barrackEntityModel;/);
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
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('programmer delivery cleaner tests passed');
