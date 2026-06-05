const assert = require('assert');
const fs = require('fs');

const code = fs.readFileSync('/opt/blueprint-editor/worker/GFM_Player.cs', 'utf8');
const sceneCtrl = fs.readFileSync('/opt/blueprint-editor/worker/GameSceneCtrl.cs', 'utf8');

assert.match(code, /private string _playerPoolName = "_player";/);
assert.match(code, /public string PlayerPoolName/);
assert.doesNotMatch(code, /private static readonly string\[\] _playerFallbackPools/);
assert.doesNotMatch(code, /__Pool_(?:Cylinder|Capsule|Cube)/);
assert.doesNotMatch(code, /GameObject\.CreatePrimitive\(PrimitiveType\.Cylinder\)/);
assert.match(code, /GameObject\.FindWithTag\("Player"\)/);
assert.match(code, /Debug\.LogError\("GFM_Player 找不到场景 Player/);
assert.match(code, /public GameObject Go \{ get \{ if \(_player == null\) EnsurePlayerObject\(\); return _player; \} \}/);
assert.match(code, /rb\.useGravity = false;/);
assert.match(code, /rb\.isKinematic = true;/);
assert.match(code, /ResolveManualMoveDelta\(float dt\)/);
assert.match(code, /Time\.realtimeSinceStartup/);
assert.match(code, /safeDt > 0\.05f/);
assert.match(code, /input \* MoveSpeed \* moveDt/);
assert.doesNotMatch(code, /StabilizePlayerGround/);
assert.match(sceneCtrl, /public static int LegacyPlayerPoolNormalizeCount = 0;/);
assert.match(sceneCtrl, /NormalizeSourcePlayerBinding\(name, poolName, go\)/);
assert.match(sceneCtrl, /LegacyPlayerPoolNormalizeCount\+\+;/);
assert.ok(sceneCtrl.includes('Debug.LogWarning("[k-audit] GFM legacy pool name normalized to _player'));
assert.match(sceneCtrl, /GetLegacyPlayerPoolNormalizeCount\(\)/);
assert.match(sceneCtrl, /go\.name = "_player";/);
assert.match(sceneCtrl, /go\.tag = "Player";/);

console.log('player template fallback tests passed');
