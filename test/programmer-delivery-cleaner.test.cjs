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
  fs.writeFileSync(path.join(tmp, 'Scripts', 'GameFlowManagerMain.cs'), [
    'using UnityEngine;',
    '',
    'public partial class GameFlowManagerMain : MonoBehaviour',
    '{',
    '    GameObject Barrack; // 说明：→ __Pool_Cube_Blue_01',
    '    void Start()',
    '    {',
    '        RegisterEntityBindings();',
    '    }',
    '    void RegisterEntityBindings() {}',
    '}',
  ].join('\n'));
  fs.writeFileSync(path.join(tmp, 'Scripts', 'GameFlowManagerMain.Flow.cs'), [
    'using UnityEngine;',
    '',
    'public partial class GameFlowManagerMain',
    '{',
    '    void Phase_intro_Init()',
    '    {',
    '        SetGuideText("开始");',
    '    }',
    '    void SetGuideText(string text) {}',
    '}',
  ].join('\n'));
  const summary = cleaner.cleanProgrammerDelivery(tmp, {
    project: { id: 'proj_test', name: '测试项目' }
  });
  assert.strictEqual(summary.csFiles, 2);
  assert.strictEqual(summary.partialFilesMerged, 1);
  assert.strictEqual(summary.partialFilesRemoved, 1);
  assert.ok(summary.entityClassFiles >= 6);
  assert.strictEqual(summary.entityModelCount, 1);
  assert.strictEqual(summary.removedArtifactDirs, 1);
  assert.strictEqual(summary.removedToolDirs, 1);
  assert.ok(!fs.existsSync(path.join(tmp, 'BlueprintArtifacts')));
  assert.ok(!fs.existsSync(path.join(tmp, 'tools')));
  assert.ok(!fs.existsSync(path.join(tmp, 'Scripts', 'GameFlowManagerMain.Flow.cs')));
  const mergedMain = fs.readFileSync(path.join(tmp, 'Scripts', 'GameFlowManagerMain.cs'), 'utf8');
  // Main 继承指向最低非空层（fixture 中是 PhaseInitBase，跳过 Tap/Auto/Flow 空层）。
  assert.match(mergedMain, /public class GameFlowManagerMain : GameFlowPhaseInitBase/);
  assert.doesNotMatch(mergedMain, /partial class GameFlowManagerMain/);
  assert.match(mergedMain, /BindGameFlowEntityModels\(\);/);
  // 有内容的层必须存在。
  assert.ok(fs.existsSync(path.join(tmp, 'Scripts', 'GameFlowStateBase.cs')));
  assert.ok(fs.existsSync(path.join(tmp, 'Scripts', 'GameFlowPhaseInitBase.cs')));
  assert.ok(fs.existsSync(path.join(tmp, 'Scripts', 'GameFlowPhaseSharedBase.cs')));
  // 空层必须被剔除（不再生成 8 行 `class X : Y { }` 壳子）。
  assert.ok(!fs.existsSync(path.join(tmp, 'Scripts', 'GameFlowPhaseFlowBase.cs')));
  assert.ok(!fs.existsSync(path.join(tmp, 'Scripts', 'GameFlowPhaseContentBase.cs')));
  assert.ok(!fs.existsSync(path.join(tmp, 'Scripts', 'GameFlowRuntimeBase.cs')));
  assert.ok(!fs.existsSync(path.join(tmp, 'Scripts', 'GameFlowPreviewBase.cs')));
  assert.ok(!fs.existsSync(path.join(tmp, 'Scripts', 'GameFlowSceneBase.cs')));
  assert.ok(!fs.existsSync(path.join(tmp, 'Scripts', 'GameFlowInputBase.cs')));
  assert.ok(!fs.existsSync(path.join(tmp, 'Scripts', 'GameFlowUiBase.cs')));
  assert.ok(summary.prunedEmptyLayers && summary.prunedEmptyLayers.length >= 8);
  assert.strictEqual(summary.mainParent, 'GameFlowPhaseInitBase');
  // 重新串接的继承链每一段都不引用被剔除的层。
  const phaseInitText = fs.readFileSync(path.join(tmp, 'Scripts', 'GameFlowPhaseInitBase.cs'), 'utf8');
  assert.match(phaseInitText, /public class GameFlowPhaseInitBase : GameFlowPhaseSharedBase/);
  const phaseSharedText = fs.readFileSync(path.join(tmp, 'Scripts', 'GameFlowPhaseSharedBase.cs'), 'utf8');
  assert.match(phaseSharedText, /public class GameFlowPhaseSharedBase : GameFlowStateBase/);
  const stateBaseText = fs.readFileSync(path.join(tmp, 'Scripts', 'GameFlowStateBase.cs'), 'utf8');
  assert.match(stateBaseText, /public class GameFlowStateBase : MonoBehaviour/);
  assert.match(fs.readFileSync(path.join(tmp, 'Scripts', 'GameFlowStateBase.cs'), 'utf8'), /protected void BindGameFlowEntityModels\(\)/);
  assert.match(fs.readFileSync(path.join(tmp, 'Scripts', 'GameFlowStateBase.cs'), 'utf8'), /protected BarrackEntity _barrackEntityModel;/);
  assert.match(fs.readFileSync(path.join(tmp, 'Scripts', 'GameFlowStateBase.cs'), 'utf8'), /BindGameFlowEntityComponent<BarrackEntity>/);
  assert.match(fs.readFileSync(path.join(tmp, 'Scripts', 'GameFlowPhaseInitBase.cs'), 'utf8'), /void Phase_intro_Init\(\)/);
  const gameFlowFiles = fs.readdirSync(path.join(tmp, 'Scripts')).filter((name) => /^GameFlow.*\.cs$/.test(name));
  gameFlowFiles.forEach((name) => {
    const lineCount = fs.readFileSync(path.join(tmp, 'Scripts', name), 'utf8').split(/\r?\n/).length - 1;
    assert.ok(lineCount < 1000, name + ' should stay below 1000 lines');
    assert.doesNotMatch(fs.readFileSync(path.join(tmp, 'Scripts', name), 'utf8'), /partial\s+class/);
  });
  assert.ok(fs.existsSync(path.join(tmp, 'Scripts', 'Entities', 'BaseBuildElement.cs')));
  assert.ok(fs.existsSync(path.join(tmp, 'Scripts', 'Entities', 'BuildEntity.cs')));
  assert.ok(fs.existsSync(path.join(tmp, 'Scripts', 'Entities', 'BarrackEntity.cs')));
  assert.match(fs.readFileSync(path.join(tmp, 'Scripts', 'Entities', 'BaseBuildElement.cs'), 'utf8'), /public int Health = 100;/);
  assert.match(fs.readFileSync(path.join(tmp, 'Scripts', 'Entities', 'BarrackEntity.cs'), 'utf8'), /public class BarrackEntity : BaseBuildElement/);
  // 反馈 01 #1 架构图:PlayerBase / NPCBase 与 BaseBuildElement 同级,都挂在 BaseGameFlowEntity 下。
  assert.ok(fs.existsSync(path.join(tmp, 'Scripts', 'Entities', 'PlayerBase.cs')));
  assert.ok(fs.existsSync(path.join(tmp, 'Scripts', 'Entities', 'NPCBase.cs')));
  const playerBaseSrc = fs.readFileSync(path.join(tmp, 'Scripts', 'Entities', 'PlayerBase.cs'), 'utf8');
  assert.match(playerBaseSrc, /public class PlayerBase : BaseGameFlowEntity/);
  assert.match(playerBaseSrc, /public float MoveSpeed/);
  assert.match(playerBaseSrc, /void MoveByDirection\(Vector3 direction, float dt\)/);
  const npcBaseSrc = fs.readFileSync(path.join(tmp, 'Scripts', 'Entities', 'NPCBase.cs'), 'utf8');
  assert.match(npcBaseSrc, /public class NPCBase : BaseGameFlowEntity/);
  assert.match(npcBaseSrc, /void SetTarget\(Vector3 target\)/);
  assert.match(npcBaseSrc, /void TickPatrol\(float dt\)/);
  assert.ok(fs.existsSync(path.join(tmp, 'PROGRAMMER_HANDOFF.md')));
  assert.ok(fs.existsSync(path.join(tmp, 'CODE_RELATION_GRAPH.md')));
  assert.ok(fs.existsSync(path.join(tmp, 'CODE_RELATION_GRAPH.html')));
  assert.match(fs.readFileSync(path.join(tmp, 'PROGRAMMER_HANDOFF.md'), 'utf8'), /程序员交付版说明/);
  assert.match(fs.readFileSync(path.join(tmp, 'PROGRAMMER_HANDOFF.md'), 'utf8'), /移除 tools 目录数：1/);
  assert.match(fs.readFileSync(path.join(tmp, 'PROGRAMMER_HANDOFF.md'), 'utf8'), /普通继承基类分层/);
  assert.match(fs.readFileSync(path.join(tmp, 'PROGRAMMER_HANDOFF.md'), 'utf8'), /剔除的空 GameFlow 基类层数：\d+/);
  assert.match(fs.readFileSync(path.join(tmp, 'CODE_RELATION_GRAPH.md'), 'utf8'), /代码关系图/);
  assert.match(fs.readFileSync(path.join(tmp, 'CODE_RELATION_GRAPH.md'), 'utf8'), /Entities\/BaseBuildElement\.cs/);
  assert.doesNotMatch(fs.readFileSync(path.join(tmp, 'README.md'), 'utf8'), /partial 文件/);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('programmer delivery cleaner tests passed');
