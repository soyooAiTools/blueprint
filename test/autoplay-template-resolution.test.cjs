const assert = require('assert');
const fs = require('fs');

const code = fs.readFileSync('/opt/blueprint-editor/worker/GFM_AutoPlay.cs', 'utf8');

assert.match(code, /private GameObject ResolveTarget\(string targetName\)/);
assert.match(code, /GameSceneCtrl\.instance != null/);
assert.match(code, /GameSceneCtrl\.instance\.Get\(targetName\)/);
assert.match(code, /target == null \|\| target\.transform\.position\.y < -900f/);

console.log('autoplay template resolution tests passed');
