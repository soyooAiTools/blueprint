const assert = require('assert');
const fs = require('fs');

// 反馈 01 #3：相机锁高度 + lerp 平移。这个测试把模板里关键合同点位钉住,
// 防止后续重构把 LerpRate / LockedY / LateUpdate 拿掉退化成瞬移。
const code = fs.readFileSync('/opt/blueprint-editor/worker/GFM_CameraController.cs', 'utf8');

// Y 锁定字段必须暴露,LateUpdate 必须把超出阈值的 Y 强行拉回。
assert.match(code, /public float LockedY/);
assert.match(code, /private void LateUpdate\(\)/);
assert.match(code, /Mathf\.Approximately\(t\.position\.y, LockedY\)/);
assert.match(code, /new Vector3\(t\.position\.x, LockedY, t\.position\.z\)/);

// 平移 / 旋转必须走 lerp,不再瞬时 SetPosition / 直接 LookAt。
assert.match(code, /public float PanLerpRate/);
assert.match(code, /Vector3\.Lerp\(t\.position, _targetPosition/);
assert.match(code, /Quaternion\.Slerp\(t\.rotation, _targetRotation/);

// MoveTo API 必须存在(给 phase 流程未来调用)。
assert.match(code, /public void MoveTo\(Vector3 worldPosition\)/);
assert.match(code, /public void FramePoint\(Vector3 worldPosition, float orthoSize\)/);

// LookAt 改为 lerp,不再原地写 _mainCam.transform.LookAt(...)。
assert.doesNotMatch(code, /_mainCam\.transform\.LookAt\(/);
// 2026-05-04: 锁等距视角,LookAt 不再覆盖 _targetRotation,Init 设的 50° pitch 永久保留。
// 原断言 `_targetRotation = Quaternion.LookRotation(dir);` 已失效,改为禁止该写法。
assert.doesNotMatch(code, /_targetRotation\s*=\s*Quaternion\.LookRotation/);
assert.match(code, /Quaternion\.Euler\(50f, 0f, 0f\)/);

// zoom 必须有限幅，避免镜头过近/过远导致程序员看不懂主体。
assert.match(code, /public float MinOrthoSize = 4\.5f/);
assert.match(code, /public float MaxOrthoSize = 12f/);
assert.match(code, /Mathf\.Clamp\(size, MinOrthoSize, MaxOrthoSize\)/);
assert.match(code, /worldPosition\.z \+ FollowZOffset/);

console.log('camera controller lerp tests passed');
