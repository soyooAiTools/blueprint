const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const coder = require('../worker/codex-code-coder.js');

{
  const text = coder.buildFeedbackText({
    rule: 'player-alias-drift',
    message: 'Normalize all player references to `player`.',
    data: {
      text: 'Normalize all player references to `player`.',
    },
  });
  assert.strictEqual(text, 'Normalize all player references to `player`.');
}

{
  const text = coder.buildFeedbackText({
    rule: 'duplicate-state-fields',
    message: 'Reuse skeleton-owned state fields instead of redeclaring them.',
    data: ['LaserTurretState'],
  });
  assert.strictEqual(text, 'Reuse skeleton-owned state fields instead of redeclaring them.');
}

{
  const fixed = coder.stripGenericMethodCallsForLuna([
    'var a = obj.GetComponent<Renderer>();',
    'var b = obj.GetComponent< Renderer >();',
    'var c = FindObjectOfType<Camera>();',
    'var d = Resources.GetBuiltinResource<Font>("Arial.ttf");',
  ].join('\n'));
  assert.ok(fixed.includes('obj.GetComponent(typeof(Renderer)) as Renderer'));
  assert.ok(fixed.includes('(Camera)FindObjectOfType(typeof(Camera))'));
  assert.ok(fixed.includes('(Font)Resources.GetBuiltinResource(typeof(Font), "Arial.ttf")'));
  assert.ok(!/GetComponent\s*</.test(fixed));
}

{
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-postfix-'));
  const managerDir = path.join(tmpRoot, 'Assets', 'Program', 'Script', 'Manager');
  fs.mkdirSync(managerDir, { recursive: true });
  fs.writeFileSync(path.join(managerDir, 'GameFlowManagerMain.cs'), 'var a = obj.GetComponent<Renderer>();\n');
  fs.writeFileSync(path.join(managerDir, 'GameFlowManagerMain.Systems.cs'), 'var b = other.GetComponent< Rigidbody >();\n');
  fs.writeFileSync(path.join(managerDir, 'GameFlowManagerMain.Flow.cs'), 'var c = FindObjectOfType<Camera>();\n');

  const changed = coder.applyLunaPostFixesToManagerPartials(tmpRoot, function() {}, 'test-task');
  assert.deepStrictEqual(changed, [
    'GameFlowManagerMain.Flow.cs',
    'GameFlowManagerMain.Systems.cs',
    'GameFlowManagerMain.cs',
  ]);

  const main = fs.readFileSync(path.join(managerDir, 'GameFlowManagerMain.cs'), 'utf-8');
  const systems = fs.readFileSync(path.join(managerDir, 'GameFlowManagerMain.Systems.cs'), 'utf-8');
  const flow = fs.readFileSync(path.join(managerDir, 'GameFlowManagerMain.Flow.cs'), 'utf-8');
  assert.ok(main.includes('GetComponent(typeof(Renderer)) as Renderer'));
  assert.ok(systems.includes('GetComponent(typeof(Rigidbody)) as Rigidbody'));
  assert.ok(flow.includes('(Camera)FindObjectOfType(typeof(Camera))'));
}

console.log('codex-code-coder post-fix tests passed');
