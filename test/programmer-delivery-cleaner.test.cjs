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
  fs.writeFileSync(path.join(tmp, 'BlueprintArtifacts', 'specs.json'), '{}');
  fs.writeFileSync(path.join(tmp, 'Scripts', 'GameFlowManagerMain.cs'), input);
  const summary = cleaner.cleanProgrammerDelivery(tmp, {
    project: { id: 'proj_test', name: '测试项目' }
  });
  assert.strictEqual(summary.csFiles, 1);
  assert.strictEqual(summary.changedFiles, 1);
  assert.strictEqual(summary.removedArtifactDirs, 1);
  assert.ok(!fs.existsSync(path.join(tmp, 'BlueprintArtifacts')));
  assert.ok(fs.existsSync(path.join(tmp, 'PROGRAMMER_HANDOFF.md')));
  assert.ok(fs.existsSync(path.join(tmp, 'CODE_RELATION_GRAPH.md')));
  assert.ok(fs.existsSync(path.join(tmp, 'CODE_RELATION_GRAPH.html')));
  assert.match(fs.readFileSync(path.join(tmp, 'PROGRAMMER_HANDOFF.md'), 'utf8'), /程序员交付版说明/);
  assert.match(fs.readFileSync(path.join(tmp, 'CODE_RELATION_GRAPH.md'), 'utf8'), /代码关系图/);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('programmer delivery cleaner tests passed');
