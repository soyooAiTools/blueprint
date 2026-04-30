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
    'AddLocalWorldLabel(target, "基地", 1.5f);',
    'uiCanvas = CreateLocalCanvas(1920, 1080);',
    'guideText = CreateLocalText(uiCanvas, "GuideText", "点击", new Vector2(0, 100), 42);',
  ].join('\n'));
  assert.ok(fixed.includes('((Renderer)obj.GetComponent(typeof(Renderer)))'));
  assert.ok(fixed.includes('(Camera)FindObjectOfType(typeof(Camera))'));
  assert.ok(fixed.includes('Resources.Load<Font>("DefaultFont")'));
  assert.ok(!/Resources\.GetBuiltinResource/.test(fixed));
  assert.ok(fixed.includes('GFM_UI.AddWorldLabel(target, "基地", 1.5f);'));
  assert.ok(fixed.includes('uiCanvas = GFM_UI.CreateCanvas(1920, 1080);'));
  assert.ok(fixed.includes('guideText = GFM_UI.CreateText(uiCanvas, "点击", new Vector2(0, 100), 42);'));
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
  assert.ok(main.includes('((Renderer)obj.GetComponent(typeof(Renderer)))'));
  assert.ok(systems.includes('((Rigidbody)other.GetComponent(typeof(Rigidbody)))'));
  assert.ok(flow.includes('(Camera)FindObjectOfType(typeof(Camera))'));
}

{
  const gfmFiles = require('../worker/gfm-files.cjs').loadGfmFiles();
  Object.keys(gfmFiles).forEach(function(name) {
    if (!/^GFM_.*\.cs$/.test(name)) return;
    assert.ok(!/GetComponent\s*</.test(gfmFiles[name]), name + ' should not contain generic GetComponent<T>()');
    assert.ok(!/FindObjectOfType\s*</.test(gfmFiles[name]), name + ' should not contain generic FindObjectOfType<T>()');
    assert.ok(!/Resources\.GetBuiltinResource\s*[<(]/.test(gfmFiles[name]), name + ' should not call Resources.GetBuiltinResource()');
  });
}

{
  const cooldownFile = path.join(os.tmpdir(), 'blueprint-code-cooldown-test-' + process.pid + '.json');
  try { fs.unlinkSync(cooldownFile); } catch (_) {}
  const env = {
    CODEX_CODE_PRIMARY_COOLDOWN_FILE: cooldownFile,
    CODEX_CODE_PRIMARY_COOLDOWN_MS: '90000',
  };
  const now = Date.parse('2026-04-30T00:00:00.000Z');
  assert.strictEqual(coder._internals.resolveCodePrimaryCooldownMs({}), 30 * 60 * 1000);
  assert.strictEqual(coder._internals.resolveCodePrimaryCooldownMs(env), 90000);
  assert.strictEqual(coder._internals.resolveCodePrimaryCooldownMs({ CODEX_CODE_PRIMARY_COOLDOWN_MS: '0' }), 0);
  assert.strictEqual(coder._internals.isCodePrimaryCooldownError('MODEL_FATAL: Codex code runner auth/quota failure'), true);
  assert.strictEqual(coder._internals.isCodePrimaryCooldownError('ZERO_EDITS: no file modified'), false);
  assert.strictEqual(coder._internals.readCodePrimaryCooldown(env, now), null);
  const written = coder._internals.writeCodePrimaryCooldown(
    'MODEL_FATAL: Codex code runner auth/quota failure',
    'proj_code',
    env,
    now
  );
  assert.ok(written);
  assert.strictEqual(written.taskId, 'proj_code');
  assert.strictEqual(written.expiresAtMs, now + 90000);
  assert.strictEqual(coder._internals.readCodePrimaryCooldown(env, now + 1).expiresAtMs, now + 90000);
  assert.strictEqual(coder._internals.readCodePrimaryCooldown(env, now + 91000), null);
  assert.strictEqual(fs.existsSync(cooldownFile), false);
}

console.log('codex-code-coder post-fix tests passed');
