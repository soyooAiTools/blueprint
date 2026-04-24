const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const recode = require('../engine/recode.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recode-partials-'));
const managerDir = path.join(root, 'Assets', 'Program', 'Script', 'Manager');
fs.mkdirSync(managerDir, { recursive: true });

try {
  fs.writeFileSync(path.join(managerDir, 'GameFlowManagerMain.cs'), 'public partial class GameFlowManagerMain {}');
  fs.writeFileSync(path.join(managerDir, 'GameFlowManagerMain.Flow.cs'), 'public partial class GameFlowManagerMain { void Flow() {} }');
  fs.writeFileSync(path.join(managerDir, 'GameFlowManagerMain.Resource.cs'), 'public partial class GameFlowManagerMain { void Resource() {} }');
  fs.writeFileSync(path.join(managerDir, 'GameFlowManagerMain.UI.cs'), 'public partial class GameFlowManagerMain { void UI() {} }');
  fs.writeFileSync(path.join(managerDir, 'Other.cs'), 'class Other {}');

  const files = recode._collectManagerPartialOutputs(root);
  assert.deepStrictEqual(Object.keys(files).sort(), [
    'GameFlowManagerMain.Flow.cs',
    'GameFlowManagerMain.Resource.cs',
    'GameFlowManagerMain.UI.cs',
  ]);
  assert.ok(files['GameFlowManagerMain.Flow.cs'].includes('void Flow()'));
  assert.ok(files['GameFlowManagerMain.Resource.cs'].includes('void Resource()'));
  assert.ok(files['GameFlowManagerMain.UI.cs'].includes('void UI()'));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('recode partial collection tests passed');
