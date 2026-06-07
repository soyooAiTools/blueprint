const assert = require('assert');
const fs = require('fs');

const code = fs.readFileSync('/opt/blueprint-editor/worker/GFM_AutoPlay.cs', 'utf8');

assert.match(code, /private GameObject ResolveTarget\(string targetName\)/);
assert.match(code, /private void DetectAutoPlayRequestFromUrl\(\)/);
assert.match(code, /Application\.absoluteURL/);
assert.match(code, /public bool ManualPreviewReady/);
assert.match(code, /_requestChecked && !_autoPlayRequested && _detectRealTime < 0f/);
assert.match(code, /_autoPlayRequested && !_isActive/);
assert.match(code, /_autoPlayRequested \|\| GameObject\.Find\("__AUTOPLAY_ON__"\) != null/);
assert.match(code, /GameSceneCtrl\.instance != null/);
assert.match(code, /GameSceneCtrl\.instance\.Get\(targetName\)/);
assert.match(code, /target == null \|\| target\.transform\.position\.y < -900f/);
assert.match(code, /private void FollowPlayerCamera\(\)/);
assert.match(code, /GFM_CameraController\.Instance\.FramePoint\(GFM_Player\.Instance\.Trans\.position, size\)/);

console.log('autoplay template resolution tests passed');
