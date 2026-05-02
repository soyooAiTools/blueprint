// singleton-base-contract.test.cjs
// 反馈 01 #1 架构图:验证 GFM_SingletonBase + 6-manager 注册到位。
// PR-18a 引入了 generic 单例基类,解决"每个 Manager 各自维护 static Instance"的散乱问题。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const WORKER_DIR = path.join(__dirname, '..', 'worker');
const { GFM_FILES } = require(path.join(WORKER_DIR, 'gfm-files.cjs'));

// ---------------------------------------------------------------------------
// 1) GFM_SingletonBase.cs 必须存在且签名正确
// ---------------------------------------------------------------------------
const basePath = path.join(WORKER_DIR, 'GFM_SingletonBase.cs');
assert.ok(fs.existsSync(basePath), 'GFM_SingletonBase.cs should exist');
const baseSrc = fs.readFileSync(basePath, 'utf-8');

assert.match(
  baseSrc,
  /public\s+abstract\s+class\s+GFM_SingletonBase<T>\s*:\s*MonoBehaviour\s+where\s+T\s*:\s*GFM_SingletonBase<T>/,
  'SingletonBase must be abstract generic constrained on itself'
);
assert.match(baseSrc, /public\s+static\s+T\s+Instance/, 'must expose static Instance property');
assert.match(baseSrc, /AddComponent<T>\(\)/, 'lazy-create must AddComponent<T>');
assert.match(baseSrc, /private\s+static\s+bool\s+_quitting/, '_quitting guard required to avoid leak on app quit');
assert.match(baseSrc, /OnApplicationQuit/, 'must hook OnApplicationQuit to flip _quitting');
assert.match(baseSrc, /enabled\s*=\s*false/, 'duplicate instance should disable, not Destroy (Luna/WebGL)');
const baseCodeOnly = stripComments(baseSrc);
assert.doesNotMatch(baseCodeOnly, /\bDestroy\s*\(/, 'SingletonBase must NOT call Destroy() (Luna/WebGL constraint)');
assert.match(baseSrc, /protected\s+virtual\s+void\s+OnInit/, 'must expose virtual OnInit hook for subclasses');

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

// ---------------------------------------------------------------------------
// 2) 6-manager 架构 (反馈 01 #1 / #8 架构图):
//    Pool / Audio / NPC / GameFlow / Tips / UI
//    - 反馈 01 #8 图里把 Pool/Audio 也叫做 Manager:走 alias 类
//      (PoolManager.cs / AudioManager.cs) 转发到 GFM_Pool / GFM_Audio 静态工具。
//    - Tips / NPC / UI 走 GFM_SingletonBase。
// ---------------------------------------------------------------------------
const REQUIRED = [
  'GFM_SingletonBase.cs',
  'GFM_Pool.cs',
  'GFM_Audio.cs',
  'PoolManager.cs',     // 反馈 01 #8 alias
  'AudioManager.cs',    // 反馈 01 #8 alias
  'GFM_NpcManager.cs',
  'GFM_TipsManager.cs',
  'GFM_UIManager.cs',
];
for (const f of REQUIRED) {
  assert.ok(GFM_FILES.indexOf(f) >= 0, f + ' must be registered in GFM_FILES');
  assert.ok(fs.existsSync(path.join(WORKER_DIR, f)), f + ' must exist on disk');
}

// SingletonBase 必须排在使用方之前,copyGfmToProject 才能保证编译顺序。
const baseIdx = GFM_FILES.indexOf('GFM_SingletonBase.cs');
const tipsIdx = GFM_FILES.indexOf('GFM_TipsManager.cs');
const uiIdx = GFM_FILES.indexOf('GFM_UIManager.cs');
const npcIdx = GFM_FILES.indexOf('GFM_NpcManager.cs');
assert.ok(baseIdx >= 0 && tipsIdx > baseIdx, 'GFM_SingletonBase must be registered before TipsManager');
assert.ok(uiIdx > baseIdx, 'GFM_SingletonBase must be registered before UIManager');
assert.ok(npcIdx > baseIdx, 'GFM_SingletonBase must be registered before NpcManager');

// PoolManager / AudioManager alias 必须排在 GFM_Pool / GFM_Audio 之后,
// 编译时 alias 转发的 GFM_Pool.Get(...) 才能解析。
const poolIdx = GFM_FILES.indexOf('GFM_Pool.cs');
const poolMgrIdx = GFM_FILES.indexOf('PoolManager.cs');
const audioIdx = GFM_FILES.indexOf('GFM_Audio.cs');
const audioMgrIdx = GFM_FILES.indexOf('AudioManager.cs');
assert.ok(poolMgrIdx > poolIdx, 'PoolManager alias must come after GFM_Pool');
assert.ok(audioMgrIdx > audioIdx, 'AudioManager alias must come after GFM_Audio');

// ---------------------------------------------------------------------------
// 3) GFM_TipsManager / GFM_UIManager / GFM_NpcManager 必须用 SingletonBase。
// ---------------------------------------------------------------------------
function assertManagerExtendsSingleton(fileName, className) {
  const src = fs.readFileSync(path.join(WORKER_DIR, fileName), 'utf-8');
  const extendsRe = new RegExp(
    'class\\s+' + className + '\\s*:\\s*GFM_SingletonBase<' + className + '>'
  );
  assert.match(src, extendsRe, fileName + ' must extend GFM_SingletonBase<' + className + '>');
  const dupInstance = new RegExp(
    'private\\s+static\\s+' + className + '\\s+_instance'
  );
  assert.doesNotMatch(
    src,
    dupInstance,
    fileName + ' must NOT redeclare its own _instance — that defeats the base class'
  );
  assert.match(
    src,
    /protected\s+override\s+void\s+OnInit/,
    fileName + ' must override OnInit, not Awake'
  );
  assert.doesNotMatch(
    stripComments(src),
    /\bDestroy\s*\(/,
    fileName + ' must NOT Destroy (Luna/WebGL)'
  );
}

assertManagerExtendsSingleton('GFM_TipsManager.cs', 'GFM_TipsManager');
assertManagerExtendsSingleton('GFM_UIManager.cs', 'GFM_UIManager');
assertManagerExtendsSingleton('GFM_NpcManager.cs', 'GFM_NpcManager');

// 个别 Manager 的接口断言保留(避免被静默移除):
const tipsSrc = fs.readFileSync(path.join(WORKER_DIR, 'GFM_TipsManager.cs'), 'utf-8');
assert.match(tipsSrc, /public\s+void\s+Show\(/, 'TipsManager must expose Show(message)');
assert.match(tipsSrc, /public\s+void\s+HideImmediate\(/, 'TipsManager must expose HideImmediate()');

// ---------------------------------------------------------------------------
// 4) PoolManager / AudioManager alias 必须有 Instance + 转发到 GFM_Pool / GFM_Audio。
// ---------------------------------------------------------------------------
const poolMgrSrc = fs.readFileSync(path.join(WORKER_DIR, 'PoolManager.cs'), 'utf-8');
assert.match(poolMgrSrc, /public\s+static\s+PoolManager\s+Instance/, 'PoolManager must expose static Instance');
assert.match(poolMgrSrc, /GFM_Pool\.Get\(/, 'PoolManager.Get must forward to GFM_Pool.Get');
assert.match(poolMgrSrc, /GFM_Pool\.Return\(/, 'PoolManager.Return must forward to GFM_Pool.Return');

const audioMgrSrc = fs.readFileSync(path.join(WORKER_DIR, 'AudioManager.cs'), 'utf-8');
assert.match(audioMgrSrc, /public\s+static\s+AudioManager\s+Instance/, 'AudioManager must expose static Instance');
assert.match(audioMgrSrc, /GFM_Audio\.instance\.PlayBGM/, 'AudioManager.PlayBGM must forward to GFM_Audio');
assert.match(audioMgrSrc, /GFM_Audio\.instance\.PlaySFX/, 'AudioManager.PlaySFX must forward to GFM_Audio');

// ---------------------------------------------------------------------------
// 5) 反馈 01 #8 场景节点:GFM_Pool 根节点必须命名 __LunaPool。
// ---------------------------------------------------------------------------
const poolSrc = fs.readFileSync(path.join(WORKER_DIR, 'GFM_Pool.cs'), 'utf-8');
assert.match(
  poolSrc,
  /new\s+GameObject\(\s*"__LunaPool"\s*\)/,
  'GFM_Pool.Init must name the pool root "__LunaPool" (反馈 01 #8 hierarchy)'
);

console.log('singleton base contract tests passed');
