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
// 2) 6-manager 架构 (反馈 01 #1):Pool / Audio / NPC / GameFlow / Tips / UI
//    Pool/Audio 走 static utility,Tips/NPC/UI/GameFlow 走 Manager 单例。
// ---------------------------------------------------------------------------
const REQUIRED = [
  'GFM_SingletonBase.cs',
  'GFM_Pool.cs',
  'GFM_Audio.cs',
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
assert.ok(baseIdx >= 0 && tipsIdx > baseIdx, 'GFM_SingletonBase must be registered before its consumers');

// ---------------------------------------------------------------------------
// 3) GFM_TipsManager 必须使用 SingletonBase,而不是再写一份 static Instance。
// ---------------------------------------------------------------------------
const tipsPath = path.join(WORKER_DIR, 'GFM_TipsManager.cs');
const tipsSrc = fs.readFileSync(tipsPath, 'utf-8');
assert.match(
  tipsSrc,
  /class\s+GFM_TipsManager\s*:\s*GFM_SingletonBase<GFM_TipsManager>/,
  'TipsManager must extend GFM_SingletonBase<GFM_TipsManager>'
);
assert.doesNotMatch(
  tipsSrc,
  /private\s+static\s+GFM_TipsManager\s+_instance/,
  'TipsManager must NOT redeclare its own _instance — that defeats the base class'
);
assert.match(tipsSrc, /protected\s+override\s+void\s+OnInit/, 'TipsManager must override OnInit, not Awake');
assert.match(tipsSrc, /public\s+void\s+Show\(/, 'TipsManager must expose Show(message)');
assert.match(tipsSrc, /public\s+void\s+HideImmediate\(/, 'TipsManager must expose HideImmediate()');
assert.doesNotMatch(stripComments(tipsSrc), /\bDestroy\s*\(/, 'TipsManager must NOT Destroy (Luna/WebGL)');

console.log('singleton base contract tests passed');
