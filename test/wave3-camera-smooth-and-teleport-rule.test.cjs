// Wave 3 单元测试：
// 1) GFM_CameraController.cs 含 SetOrthographicSize / SetCameraHeight + 3s lerp 速率
// 2) assembly-emitter 的 camera_zoom / camera_lift 不再直接写 mainCam.orthographicSize / position，
//    而是优先调 GFM_CameraController.Instance.SetOrthographicSize(...) / SetCameraHeight(...)
// 3) static-check.cjs 含 player-teleport-in-update 规则，能识别 Update 内的瞬移

const assert = require('assert');
const fs = require('fs');

// ============================================================================
// T1: GFM_CameraController 暴露平滑过渡 API + lerp 速率降到 1.0
// ============================================================================
const camCode = fs.readFileSync('/opt/blueprint-editor/worker/GFM_CameraController.cs', 'utf8');

assert.match(camCode, /public void SetOrthographicSize\(float size\)/, 'SetOrthographicSize API 缺失');
assert.match(camCode, /public void SetCameraHeight\(float height, float zOffset\)/, 'SetCameraHeight API 缺失');
assert.match(camCode, /public float ZoomLerpRate = 1\.0f/, 'ZoomLerpRate 必须 1.0f（≈3s 平滑）');
assert.match(camCode, /public float PanLerpRate = 1\.0f/, 'PanLerpRate 必须降到 1.0f（≈3s 平滑）');
assert.match(camCode, /public float RotateLerpRate = 1\.0f/, 'RotateLerpRate 必须降到 1.0f');
// LateUpdate 必须对 orthographicSize 走 lerp 而不是直接赋值
assert.match(camCode, /Mathf\.Lerp\(\s*curSize\s*,\s*_targetOrthoSize/, 'orthographicSize 必须 lerp');
assert.match(camCode, /_targetOrthoSize/, '_targetOrthoSize 字段缺失');
// SetCameraHeight 必须更新 LockedY，否则锁 Y 机制会把镜头拉回旧高度
assert.match(camCode, /LockedY\s*=\s*height;/, 'SetCameraHeight 必须更新 LockedY');

// ============================================================================
// T2: assembly-emitter zoom/lift 改为调 GFM_CameraController 平滑 API
// ============================================================================
const emitter = require('../adapters/assembly-emitter.cjs');
const path = require('path');

// emitter 内部函数没直接 export；通过加载 source 字符串校验
const emitterSrc = fs.readFileSync('/opt/blueprint-editor/adapters/assembly-emitter.cjs', 'utf8');

// zoom 模板必须先尝试走 SetOrthographicSize，fallback 才允许直接 mainCam.orthographicSize
assert.match(emitterSrc, /SetOrthographicSize\(/, 'zoom 模板缺少 SetOrthographicSize 调用');
const zoomFnSrc = emitterSrc.match(/function buildDeterministicCameraZoomLines[\s\S]*?\n\}/);
assert.ok(zoomFnSrc, 'buildDeterministicCameraZoomLines 函数定位失败');
assert.ok(/GFM_CameraController\.Instance\.SetOrthographicSize/.test(zoomFnSrc[0]), 'zoom 模板必须优先调 SetOrthographicSize');
// 必须有 IsReady 守卫（fallback 路径）
assert.ok(/GFM_CameraController\.Instance\.IsReady/.test(zoomFnSrc[0]), 'zoom 模板必须有 IsReady 守卫');

// lift 模板必须优先走 SetCameraHeight，原始的 mainCam.transform.position 写法只能在 fallback 分支
const liftFnSrc = emitterSrc.match(/function buildDeterministicCameraLiftLines[\s\S]*?\n\}/);
assert.ok(liftFnSrc, 'buildDeterministicCameraLiftLines 函数定位失败');
assert.ok(/GFM_CameraController\.Instance\.SetCameraHeight/.test(liftFnSrc[0]), 'lift 模板必须优先调 SetCameraHeight');
assert.ok(/GFM_CameraController\.Instance\.IsReady/.test(liftFnSrc[0]), 'lift 模板必须有 IsReady 守卫');

// ============================================================================
// T3: static-check player-teleport-in-update 规则
// ============================================================================
const staticCheck = require('../engine/static-check.cjs');

// 反例：Update 内瞬移玩家（应触发规则）
const teleportSample = `
public class Demo {
  GameObject playerObj;
  void Update() {
    playerObj.transform.position = new Vector3(1, 0, 1);
  }
}
`.trim();
const r1 = staticCheck.staticCheck(teleportSample, { filename: 'GameFlowManagerMain.cs' });
const teleHit = r1.issues.filter(function(i) { return i.rule === 'player-teleport-in-update'; });
assert.ok(teleHit.length >= 1, 'Update 内 player.transform.position = X 必须被识别为瞬移');

// 正例：Update 内 MoveTowards（应放行）
const okMoveTowards = `
public class Demo {
  GameObject playerObj;
  void Update() {
    playerObj.transform.position = Vector3.MoveTowards(playerObj.transform.position, target, 4f * Time.deltaTime);
  }
}
`.trim();
const r2 = staticCheck.staticCheck(okMoveTowards, { filename: 'GameFlowManagerMain.cs' });
const teleHit2 = r2.issues.filter(function(i) { return i.rule === 'player-teleport-in-update'; });
assert.strictEqual(teleHit2.length, 0, 'Vector3.MoveTowards 必须放行');

// 正例：Init 内一次性摆位（应放行 — 不在 gameplay 方法内）
const okInit = `
public class Demo {
  GameObject playerObj;
  void InitializeGame() {
    playerObj.transform.position = new Vector3(0, 0, 0);
  }
}
`.trim();
const r3 = staticCheck.staticCheck(okInit, { filename: 'GameFlowManagerMain.cs' });
const teleHit3 = r3.issues.filter(function(i) { return i.rule === 'player-teleport-in-update'; });
assert.strictEqual(teleHit3.length, 0, 'Init 内摆位必须放行');

// 正例：+= 增量（应放行）
const okIncr = `
public class Demo {
  GameObject playerObj;
  void Update() {
    playerObj.transform.position += new Vector3(0.1f, 0, 0);
  }
}
`.trim();
const r4 = staticCheck.staticCheck(okIncr, { filename: 'GameFlowManagerMain.cs' });
const teleHit4 = r4.issues.filter(function(i) { return i.rule === 'player-teleport-in-update'; });
assert.strictEqual(teleHit4.length, 0, '+= 增量必须放行');

// 反例：CheckEventRules 内瞬移（应触发）
const teleportInRules = `
public class Demo {
  GameObject playerObj;
  void CheckEventRules() {
    playerObj.transform.position = new Vector3(5, 0, 5);
  }
}
`.trim();
const r5 = staticCheck.staticCheck(teleportInRules, { filename: 'GameFlowManagerMain.cs' });
const teleHit5 = r5.issues.filter(function(i) { return i.rule === 'player-teleport-in-update'; });
assert.ok(teleHit5.length >= 1, 'CheckEventRules 内 player 瞬移也必须识别');

// 跳过：GFM_*.cs 不参与玩家移动逻辑（应放行 — 文件名豁免）
const teleportInGfm = teleportSample;
const r6 = staticCheck.staticCheck(teleportInGfm, { filename: 'GFM_Player.cs' });
const teleHit6 = r6.issues.filter(function(i) { return i.rule === 'player-teleport-in-update'; });
assert.strictEqual(teleHit6.length, 0, 'GFM_*.cs 文件应豁免该规则');

// 非 player 实体（如 enemy）不应被规则误伤
const enemyTeleport = `
public class Demo {
  GameObject enemyObj;
  void Update() {
    enemyObj.transform.position = new Vector3(1, 0, 1);
  }
}
`.trim();
const r7 = staticCheck.staticCheck(enemyTeleport, { filename: 'GameFlowManagerMain.cs' });
const teleHit7 = r7.issues.filter(function(i) { return i.rule === 'player-teleport-in-update'; });
assert.strictEqual(teleHit7.length, 0, '非 player 实体瞬移不触发规则（避免误伤 NPC）');

// 规则必须 non-blocking（Wave 3 风险控制）
const blockingTele = teleHit.filter(function(i) { return i.blocking; });
assert.strictEqual(blockingTele.length, 0, 'player-teleport-in-update 必须 non-blocking');

console.log('Wave 3 camera smooth + teleport rule: all assertions passed.');
