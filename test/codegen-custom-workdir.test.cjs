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

console.log('codegen custom workdir tests passed');
