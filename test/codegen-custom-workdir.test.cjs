const assert = require('assert');
const fs = require('fs');
const path = require('path');

const codegenSchema = require('../engine/stages/codegen-schema.cjs');

const ctx = {
  taskId: 'test-custom-workdir',
  csCode: [
    'using UnityEngine;',
    'public partial class GameFlowManagerMain : MonoBehaviour',
    '{',
    '    void Update()',
    '    {',
    '        // TODO_CUSTOM_START',
    '        // TODO_CUSTOM_END',
    '    }',
    '}',
  ].join('\n'),
  extraFiles: {
    'GameFlowManagerMain.Flow.cs': [
      'public partial class GameFlowManagerMain',
      '{',
      '    void Tick() {}',
      '}',
    ].join('\n'),
  },
  blueprint: {},
};

const workDir = codegenSchema._prepareCustomLogicWorkspace(ctx);
const managerDir = path.join(workDir, 'Assets', 'Program', 'Script', 'Manager');

assert.ok(fs.existsSync(path.join(managerDir, 'GameFlowManagerMain.cs')));
assert.ok(fs.existsSync(path.join(managerDir, 'GameFlowManagerMain.Flow.cs')));

fs.writeFileSync(path.join(managerDir, 'GameFlowManagerMain.cs'), ctx.csCode.replace('// TODO_CUSTOM_END', '        PlaceObj(Box, 1f, 2f, 3f);\n        // TODO_CUSTOM_END'));
fs.writeFileSync(path.join(managerDir, 'GameFlowManagerMain.Flow.cs'), [
  'public partial class GameFlowManagerMain',
  '{',
  '    void Tick() { currentPhaseName = "patched"; }',
  '}',
].join('\n'));

const changed = codegenSchema._loadCustomLogicWorkspaceIntoContext(ctx, workDir);
assert.strictEqual(changed, true);
assert.match(ctx.csCode, /PlaceObj\(Box, 1f, 2f, 3f\);/);
assert.match(ctx.extraFiles['GameFlowManagerMain.Flow.cs'], /patched/);

codegenSchema._cleanupCustomLogicWorkspace(workDir);
assert.ok(!fs.existsSync(workDir));

const scopedCtx = {
  taskId: 'test-custom-workdir-slot-scope',
  csCode: [
    'using UnityEngine;',
    'public partial class GameFlowManagerMain : MonoBehaviour',
    '{',
    '    int MainState = 0;',
    '    void Update()',
    '    {',
    '        // TODO_CUSTOM_START',
    '        // TODO_CUSTOM_END',
    '    }',
    '}',
  ].join('\n'),
  extraFiles: {
    'GameFlowManagerMain.Flow.cs': [
      'public partial class GameFlowManagerMain',
      '{',
      '    // [ASSEMBLY OWNER MANIFEST] Deterministic scaffold generated from AssemblyPlan.',
      '    // ownerFile: GameFlowManagerMain.Flow.cs',
      '',
      '    void AssemblySlot_Flow_Player__move_to_target()',
      '    {',
      '        // TODO_AssemblySlot_Flow_Player__move_to_target_START',
      '        // Keep baseline',
      '        // TODO_AssemblySlot_Flow_Player__move_to_target_END',
      '    }',
      '}',
    ].join('\n'),
  },
  blueprint: {
    assemblyOwnerSummary: {
      'GameFlowManagerMain.Flow.cs': ['Player::move_to_target'],
    },
  },
};

const scopedWorkDir = codegenSchema._prepareCustomLogicWorkspace(scopedCtx);
const scopedManagerDir = path.join(scopedWorkDir, 'Assets', 'Program', 'Script', 'Manager');
fs.writeFileSync(path.join(scopedManagerDir, 'GameFlowManagerMain.cs'), [
  'using UnityEngine;',
  'public partial class GameFlowManagerMain : MonoBehaviour',
  '{',
  '    int MainState = 999;',
  '    void Update()',
  '    {',
  '        // TODO_CUSTOM_START',
  '        PlaceObj(Box, 9f, 9f, 9f);',
  '        // TODO_CUSTOM_END',
  '    }',
  '}',
].join('\n'));
fs.writeFileSync(path.join(scopedManagerDir, 'GameFlowManagerMain.Flow.cs'), [
  'public partial class GameFlowManagerMain',
  '{',
  '    // [ASSEMBLY OWNER MANIFEST] Deterministic scaffold generated from AssemblyPlan.',
  '    // ownerFile: HACKED',
  '',
  '    void AssemblySlot_Flow_Player__move_to_target()',
  '    {',
  '        // TODO_AssemblySlot_Flow_Player__move_to_target_START',
  '        PlaceObj(Player, 1f, 2f, 3f);',
  '        // TODO_AssemblySlot_Flow_Player__move_to_target_END',
  '    }',
  '}',
].join('\n'));

const scopedChanged = codegenSchema._loadCustomLogicWorkspaceIntoContext(scopedCtx, scopedWorkDir);
assert.strictEqual(scopedChanged, true);
assert.match(scopedCtx.csCode, /PlaceObj\(Box, 9f, 9f, 9f\);/);
assert.ok(!scopedCtx.csCode.includes('int MainState = 999;'));
assert.match(scopedCtx.extraFiles['GameFlowManagerMain.Flow.cs'], /PlaceObj\(Player, 1f, 2f, 3f\);/);
assert.ok(!scopedCtx.extraFiles['GameFlowManagerMain.Flow.cs'].includes('// ownerFile: HACKED'));
assert.deepStrictEqual(scopedCtx.blueprint.lastCustomLogicScopeFixes, [
  'GameFlowManagerMain.cs:TODO_CUSTOM',
  'GameFlowManagerMain.Flow.cs:AssemblySlot',
]);

codegenSchema._cleanupCustomLogicWorkspace(scopedWorkDir);
assert.ok(!fs.existsSync(scopedWorkDir));

console.log('codegen custom workdir tests passed');
