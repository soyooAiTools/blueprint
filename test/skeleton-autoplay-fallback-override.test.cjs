/**
 * 2026-05-13: deterministic autoplay phase-exit override.
 *
 * 历史问题: phase gate 条件
 *   EntityAdvanced(X, snap) || (_autoPlayMode && _autoPlaySteps > _autoPlayStepsAtPhaseStart && XState >= 2)
 * 两条 path 都依赖外部系统:
 *   - Path 1: gate entity GameObject 真存在 + 真位移 > 1.5 单位
 *   - Path 2: GFM_AutoPlay.Tick() 在持续 ++Steps
 * 任一外部依赖 stall(entity null / autoplay 不 tick),autoplay 模式下 phase 卡死,
 * runtime-contract NO_PROGRESS_TIMEOUT (30s) 触发 → 3/11 plan 失败 → heavy CUA fix-loop。
 *
 * 修复: 加 phase-level OR 子句 `(_autoPlayMode && _autoplayFallbackFired_<pid>)`,
 * _pushAutoplayFallback 在 OnAutoPlayArrive 内置 flag = true。
 * autoplay 模式下 phase 必能在 fallback 触发 + PhaseDwellReady 满足后推进,
 * 跟外部依赖完全解耦。
 *
 * 测试通过 generateSkeleton 端到端检查生成代码包含必要字段/赋值/gate 子句。
 */

var assert = require('assert');
var fs = require('fs');
var path = require('path');

// 验证 skeleton-generator 源文件有三处关键注入
var src = fs.readFileSync(path.join(__dirname, '..', 'adapters', 'skeleton-generator.cjs'), 'utf8');

(function testFieldDeclarationInjection() {
  // (1) 字段声明: _autoplayFallbackFired_<pid>
  assert.ok(
    /_autoplayFallbackFired_[\w]*['+`]/.test(src) || /_autoplayFallbackFired_/.test(src),
    'skeleton-generator 必须有 _autoplayFallbackFired_<pid> 字段声明'
  );
  // 必须在 specs.forEach 内部生成
  var idx = src.indexOf("specs.forEach(function(spec) {");
  assert.ok(idx > 0, 'specs.forEach loop 存在');
  var slice = src.substr(idx, 400);
  assert.ok(/_autoplayFallbackFired_/.test(slice), '字段在 specs.forEach 内 per-phase 生成');
  console.log('  ✓ (1) per-phase 字段声明: bool _autoplayFallbackFired_<pid>');
})();

(function testPushAutoplayFallbackSetsFlag() {
  // (2) _pushAutoplayFallback 必须 set _autoplayFallbackFired_<pid> = true
  var fnIdx = src.indexOf('function _pushAutoplayFallback');
  assert.ok(fnIdx > 0, '_pushAutoplayFallback 函数存在');
  var fnEnd = src.indexOf('\n}\n', fnIdx);
  var fnSrc = src.substring(fnIdx, fnEnd);
  assert.ok(
    /_autoplayFallbackFired_['+]/.test(fnSrc) || /_autoplayFallbackFired_/.test(fnSrc),
    '_pushAutoplayFallback 内必须包含 _autoplayFallbackFired_<pid> = true'
  );
  assert.ok(/= true/.test(fnSrc.substr(fnSrc.indexOf('_autoplayFallbackFired_'), 200)),
    'flag 设为 true');
  console.log('  ✓ (2) _pushAutoplayFallback 设 _autoplayFallbackFired_<pid> = true');
})();

(function testBuildRealConditionAddsOrClause() {
  // (3) buildRealCondition 必须加 OR (_autoPlayMode && _autoplayFallbackFired_<pid>) 子句
  var fnIdx = src.indexOf('function buildRealCondition');
  assert.ok(fnIdx > 0, 'buildRealCondition 函数存在');
  var fnEnd = src.indexOf('\n  }\n', fnIdx);
  var fnSrc = src.substring(fnIdx, fnEnd);
  assert.ok(/_autoplayFallbackFired_/.test(fnSrc),
    'buildRealCondition 必须引用 _autoplayFallbackFired_<pid>');
  assert.ok(/_autoPlayMode && _autoplayFallbackFired_/.test(fnSrc),
    '必须是 (_autoPlayMode && _autoplayFallbackFired_<pid>) 形式');
  console.log('  ✓ (3) buildRealCondition 加 OR (_autoPlayMode && _autoplayFallbackFired_<pid>)');
})();

// end-to-end skeleton 生成验证
(function testE2EGeneratedSkeleton() {
  var skeleton = require('../adapters/skeleton-generator.cjs');
  var specs = [
    {
      phaseId: 'phase1',
      phaseName: 'Phase 1',
      duration: { min: 10, max: 15 },
      requiredInteractions: ['move_to:Player'],
      entitiesRequired: [{ name: 'Player' }],
      playerMustAct: true,
    },
    {
      phaseId: 'phase2',
      phaseName: 'Phase 2',
      duration: { min: 10, max: 15 },
      requiredInteractions: ['build:Workshop'],
      entitiesRequired: [{ name: 'Workshop' }],
      playerMustAct: true,
    },
  ];
  var result = skeleton.generateSkeleton(specs, {
    entityPoolMap: { Player: '__Pool_Cube_White_01', Workshop: '__Pool_Cube_Red_02' },
    entities: [
      { name: 'Player', chineseName: '玩家' },
      { name: 'Workshop', chineseName: '工坊' },
    ],
    w1bSplit: true,
  });
  var allFiles = [result.main, result.flow, result.input, result.resource, result.ui, result.scene].join('\n');
  // 字段声明 per phase
  assert.ok(/bool _autoplayFallbackFired_phase1\s*=\s*false/.test(allFiles),
    'phase1 字段生成');
  assert.ok(/bool _autoplayFallbackFired_phase2\s*=\s*false/.test(allFiles),
    'phase2 字段生成');
  // _pushAutoplayFallback 在 OnAutoPlayArrive 内设 flag
  assert.ok(/_autoplayFallbackFired_phase1\s*=\s*true/.test(allFiles),
    'phase1 fallback 设 flag');
  assert.ok(/_autoplayFallbackFired_phase2\s*=\s*true/.test(allFiles),
    'phase2 fallback 设 flag');
  // gate condition 含 OR 子句
  assert.ok(/_autoPlayMode\s*&&\s*_autoplayFallbackFired_phase1/.test(allFiles),
    'phase1 gate 含 OR 子句');
  console.log('  ✓ E2E: generateSkeleton 输出包含 fields + assignments + OR clause');
})();

console.log('\nskeleton autoplay-fallback override: 4 cases passed');
