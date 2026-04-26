const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const ui = fs.readFileSync(path.join(root, 'worker', 'GFM_UI.cs'), 'utf8');
const uiManager = fs.readFileSync(path.join(root, 'worker', 'GFM_UIManager.cs'), 'utf8');
const linuxBuild = fs.readFileSync(path.join(root, 'worker', 'linux-bridge-build.js'), 'utf8');
const staticCheck = require('../engine/static-check.cjs');

assert.ok(
  ui.includes('if (IsMissing(canvas) || IsMissing(canvas.transform)) return null;'),
  'GFM_UI.CreateText/CreateButton should not dereference a null canvas'
);
assert.ok(
  ui.includes('object.ReferenceEquals(value, null)'),
  'GFM_UI should use raw ReferenceEquals null checks for Luna/Bridge native nulls'
);
assert.ok(
  ui.includes('txt = (Text)obj.AddComponent(typeof(Text))'),
  'GFM_UI should add Text via AddComponent(typeof(Text)) after ensuring RectTransform'
);
assert.ok(
  ui.includes('try { txt.text = content; } catch {}') && ui.includes('catch {}'),
  'GFM_UI should silently guard Text style writes because Luna may not initialize element._text before ApplyFontDataChanges'
);
assert.ok(
  !ui.includes('new GameObject("Text", typeof(RectTransform), typeof(Text))'),
  'GFM_UI should not rely on constructor component lists for Text creation'
);
assert.ok(
  ui.includes('if (IsMissing(obj) || IsMissing(obj.transform)) return null;'),
  'GFM_UI.CreateText should guard failed object construction before transform access'
);
assert.ok(
  uiManager.includes('private bool EnsureInit()'),
  'GFM_UIManager should expose an internal lazy init guard'
);
assert.ok(
  uiManager.includes('if (!EnsureInit()) return;'),
  'GFM_UIManager.ShowFloatingText should not create text when canvas init failed'
);
assert.ok(
  linuxBuild.includes('__blueprintTextGuardV1') &&
    linuxBuild.includes('proto.ApplyFontDataChanges = function()') &&
    linuxBuild.includes('if (!element || !element._text) return;'),
  'linux bridge build should patch UI.Text.ApplyFontDataChanges before generated Start() runs'
);

{
  const result = staticCheck.staticCheck([
    'using UnityEngine;',
    'using UnityEngine.UI;',
    'public class GameFlowManagerMain : MonoBehaviour {',
    '  Text label;',
    '  void Start() { label.fontSize = 32; label.alignment = TextAnchor.MiddleCenter; label.text = "ok"; }',
    '}',
  ].join('\n'), { filename: 'GameFlowManagerMain.cs' });
  assert.ok(
    result.issues.some(function(issue) { return issue.rule === 'text-style-direct-assignment' && issue.blocking; }),
    'static-check should block direct Text style assignments outside canonical toolkit files'
  );
}

console.log('gfm-ui null-safety tests passed');
