const assert = require('assert');
const fs = require('fs');

const code = fs.readFileSync('/opt/blueprint-editor/worker/GFM_Player.cs', 'utf8');

assert.match(code, /private static readonly string\[\] _playerFallbackPools/);
assert.match(code, /__Pool_Cylinder_01/);
assert.match(code, /__Pool_Cube_Blue_01/);
assert.match(code, /GameObject\.CreatePrimitive\(PrimitiveType\.Cylinder\)/);
assert.match(code, /public GameObject Go \{ get \{ if \(_player == null\) EnsurePlayerObject\(\); return _player; \} \}/);

console.log('player template fallback tests passed');
