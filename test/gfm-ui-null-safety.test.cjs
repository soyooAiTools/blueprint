const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const ui = fs.readFileSync(path.join(root, 'worker', 'GFM_UI.cs'), 'utf8');
const uiManager = fs.readFileSync(path.join(root, 'worker', 'GFM_UIManager.cs'), 'utf8');

assert.ok(
  ui.includes('if (canvas == null || canvas.transform == null) return null;'),
  'GFM_UI.CreateText/CreateButton should not dereference a null canvas'
);
assert.ok(
  ui.includes('typeof(RectTransform), typeof(Text)'),
  'GFM_UI.CreateText should instantiate Text with RectTransform and Text components together'
);
assert.ok(
  ui.includes('if (obj == null || obj.transform == null) return null;'),
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

console.log('gfm-ui null-safety tests passed');
