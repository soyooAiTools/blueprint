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

// LookAt 改为 lerp,不再原地写 _mainCam.transform.LookAt(...)。
assert.doesNotMatch(code, /_mainCam\.transform\.LookAt\(/);
assert.match(code, /_targetRotation = Quaternion\.LookRotation\(dir\);/);

console.log('camera controller lerp tests passed');
