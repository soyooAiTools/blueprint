# Codegen Performance Batch 2 — 采集逻辑修正 + IsNear 合并实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复「每帧 `MetalShardCarried++` 无冷却」的**逻辑 bug**（1/6 秒装满 10 个资源）+ 合并同 target 的 IsNear 块，顺带把 Batch 3 T3-3 warn 规则扫到的 scoreText 每帧拼接问题从源头消除。

**Architecture:** 在 skeleton-generator 加一组共享的 cooldown + last-score 基础设施（3 个字段 + 1 处 Update tick-down）。三个采集/显示模板读这些字段包一层 gate。IsNear 合并在 `buildDeliverBlock` 层按 target 分组。schema 加一个可选 `collectCooldown` 字段（default 0.3s）。

**Tech Stack:** Node.js 模板字符串生成 + Jest 白盒正则断言 + Unity C# float timer pattern。

---

## 前置调研结论（2026-04-19 完成）

Batch 2 的 bug 扩散到**两处模板 + 一处显示模板**（见 `docs/superpowers/specs/2026-04-19-perf-batch3-report.md` 附带的 Batch 2 调研章节，或主对话）：

| 文件 | 行 | 问题 |
|------|----|------|
| `adapters/templates/resource-flow.cjs` | L44 | `resourceName + 'Carried++;'` 每帧 +1 无门控 |
| `adapters/templates/resource-flow.cjs` | L45 | `scoreText.text = ... + ...` 每帧拼接 |
| `adapters/templates/resource-flow.cjs` | L78 | 按 phase 平铺 IsNear，同 target 重复 50% |
| `adapters/templates/interactions/collect-interaction.cjs` | L21 | `AddResource(..., 1)` 无门控（Batch 12 新模板继承了 bug） |
| `adapters/templates/interactions/score-display.cjs` | L14-16 | 每帧拼 `display` 并赋值 scoreText.text |

---

## Design — 共享 cooldown 基础设施

避免每个模板各造一个冷却轮子，统一在 skeleton-generator 注入 3 个字段 + Update tick-down：

```csharp
// [SKELETON] Collect cooldown (shared across all collect/deliver templates)
float collectCooldownInterval = 0.3f; // seconds between collect actions (schema-configurable)
float _collectCooldown = 0f;          // current cooldown timer, counts down
string _lastScoreText = "";            // last rendered scoreText — diff-gate UI updates
```

- **Cooldown 策略**：**全局单一 cooldown**。玩家任意采集一次后，`_collectCooldown = collectCooldownInterval`；其他采集点也被门控。理由：匹配「一次拾起一个」的玩家直觉，实现简单，bug 修复足够。**不做 per-source / per-resource 多时钟**——那是 YAGNI。
- **Tick-down 位置**：`Update()` 开头（在 skeleton 内已有的 `phaseTimer += Time.deltaTime;` 附近），`if (_collectCooldown > 0f) _collectCooldown -= Time.deltaTime;`。
- **diff-gate**：`if (_lastScoreText != display) { scoreText.text = display; _lastScoreText = display; }`。

**模板使用方式**：
```csharp
// Before (current, buggy):
if (IsNear(MetalShard, collectRange)) {
    if (MetalShardCarried < 10) {
        MetalShardCarried++;
        scoreText.text = "...";
    }
}

// After:
if (_collectCooldown <= 0f && IsNear(MetalShard, collectRange)) {
    if (MetalShardCarried < 10) {
        MetalShardCarried++;
        _collectCooldown = collectCooldownInterval;
        string _score = "MetalShard: " + MetalShardCarried + "/10";
        if (_lastScoreText != _score) { scoreText.text = _score; _lastScoreText = _score; }
    }
}
```

---

## 文件结构

### 修改文件

| 文件 | 改动 |
|------|------|
| `adapters/skeleton-generator.cjs` | + 3 字段 + 1 行 tick-down（~5 行新增） |
| `adapters/templates/resource-flow.cjs` | buildCollectBlock 改造 + buildDeliverBlock 改造 + 新增 target-merge 辅助函数 |
| `adapters/templates/interactions/collect-interaction.cjs` | 包 cooldown gate |
| `adapters/templates/interactions/score-display.cjs` | 加 `_lastScoreText` diff gate |
| `adapters/schema/game-schema.json` | gameConfig 加 optional `collectCooldown`（default 0.3） |

### 新建测试文件

- `test/batch2-resource-flow.test.cjs` — 3 组 describe：cooldown gate、scoreText diff、IsNear 合并
- `test/batch2-collect-interaction.test.cjs` — collect-interaction cooldown gate
- `test/batch2-score-display.test.cjs` — score-display diff gate

### 不修改

- `engine/static-check.cjs` — Batch 3 已有 T3-3 warn，修完后 HEAD skeleton 应该零命中该 warn，不需要新规则
- `worker/fix-recipes.json` — 纯模板改动，不涉及 recipe
- 已有测试文件（`test/skeleton-generator-perf.test.cjs` 等）— Batch 2 不改动 Batch 1 覆盖的函数，独立测试

---

## Task 1: Skeleton cooldown 基础设施

**Files:**
- Modify: `adapters/skeleton-generator.cjs` — idle game kit 段落附近（L362 附近）+ Update 开头（`phaseTimer += Time.deltaTime;` 附近，用 grep 定位）
- Create: `test/batch2-skeleton-cooldown.test.cjs`

**改动内容**：
1. 在 idle game kit 字段声明段添加 3 个字段
2. 在 Update() 开头加 tick-down 逻辑
3. 读 schema 里的 `collectCooldown` 作为 `collectCooldownInterval` 初值（不存在 → 默认 0.3f）

- [ ] **Step 1-1: 精确定位插入点**

```bash
cd /opt/blueprint-editor && grep -n "_moveBuf = Vector3.zero\|phaseTimer.*Time\.deltaTime" adapters/skeleton-generator.cjs | head
```

记录 `_moveBuf` 行号（字段插入点，紧接其后追加）+ `phaseTimer +=` 行号（tick-down 插入点，紧接其后）。

- [ ] **Step 1-2: 写 failing test（字段存在性 + tick-down 存在性）**

创建 `test/batch2-skeleton-cooldown.test.cjs`：

```javascript
const { generateSkeleton } = require('../adapters/skeleton-generator.cjs');

// Minimal idle-game spec that triggers isIdleGame gate
function makeSpecs(collectCooldown) {
  var specs = [{
    phaseId: 'p1',
    title: 'collect',
    entities: ['Player', 'MetalShard'],
    requiredInteractions: ['move_to:MetalShard', 'collect:MetalShard'],
    endCondition: 'MetalShardCarried >= 3',
  }];
  if (collectCooldown !== undefined) {
    specs.gameConfig = { collectCooldown: collectCooldown };
  }
  return specs;
}

describe('batch2 skeleton cooldown infrastructure', () => {
  test('collectCooldownInterval field emitted with default 0.3f', () => {
    var out = generateSkeleton(makeSpecs());
    var main = typeof out === 'string' ? out : out.main;
    expect(main).toMatch(/float\s+collectCooldownInterval\s*=\s*0\.3f\s*;/);
  });

  test('_collectCooldown field emitted as 0f', () => {
    var out = generateSkeleton(makeSpecs());
    var main = typeof out === 'string' ? out : out.main;
    expect(main).toMatch(/float\s+_collectCooldown\s*=\s*0f\s*;/);
  });

  test('_lastScoreText field emitted as empty string', () => {
    var out = generateSkeleton(makeSpecs());
    var main = typeof out === 'string' ? out : out.main;
    expect(main).toMatch(/string\s+_lastScoreText\s*=\s*""\s*;/);
  });

  test('Update() decrements _collectCooldown when > 0', () => {
    var out = generateSkeleton(makeSpecs());
    var main = typeof out === 'string' ? out : out.main;
    expect(main).toMatch(/if\s*\(\s*_collectCooldown\s*>\s*0f\s*\)\s*_collectCooldown\s*-=\s*Time\.deltaTime\s*;/);
  });
});
```

- [ ] **Step 1-3: 运行 test 确认 fail**

```bash
cd /opt/blueprint-editor && npx jest test/batch2-skeleton-cooldown.test.cjs --no-coverage
```

Expected: 4 FAIL。

- [ ] **Step 1-4: 实现字段声明**

在 skeleton-generator.cjs 的 `_moveBuf` 声明行（step 1-1 记录的行号）之后追加：

```javascript
lines.push('    // [SKELETON] Batch 2 collect cooldown infra — shared across all collect templates');
lines.push('    float collectCooldownInterval = ' + (specs.gameConfig && specs.gameConfig.collectCooldown ? specs.gameConfig.collectCooldown : 0.3) + 'f;');
lines.push('    float _collectCooldown = 0f;');
lines.push('    string _lastScoreText = "";');
```

**关键**：读 `specs.gameConfig.collectCooldown`，缺省 0.3。**必须用 `0.3` 而不是 `0.3f`**——后者是 C# 字面量，JS 字符串拼接后会变成 `0.3ff`。

- [ ] **Step 1-5: 实现 Update tick-down**

找到 `phaseTimer += Time.deltaTime;` 所在函数（`generateUpdate` 或类似），在其后追加：

```javascript
lines.push('        if (_collectCooldown > 0f) _collectCooldown -= Time.deltaTime;');
```

具体插入位置用 step 1-1 的 grep 结果定位。

- [ ] **Step 1-6: 跑 test 确认 4 PASS**

```bash
cd /opt/blueprint-editor && npx jest test/batch2-skeleton-cooldown.test.cjs --no-coverage
```

Expected: 4 PASS。

- [ ] **Step 1-7: 跑 full jest 确保无回归**

```bash
cd /opt/blueprint-editor && npx jest --no-coverage 2>&1 | tail -3
```

Expected: 104 passing（100 + 4）。

- [ ] **Step 1-8: Commit**

```bash
cd /opt/blueprint-editor && git add adapters/skeleton-generator.cjs test/batch2-skeleton-cooldown.test.cjs && git commit -m "$(cat <<'EOF'
perf(skeleton): Batch 2 collect cooldown + lastScoreText 基础设施

新增3个字段+1行Update tick-down，供resource-flow/collect-interaction/
score-display三个模板共享使用。schema gameConfig.collectCooldown
可配置，默认0.3s。下一步模板改造会使用这些字段。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: resource-flow.cjs buildCollectBlock 改造（T2-2a）

**Files:**
- Modify: `adapters/templates/resource-flow.cjs` — `buildCollectBlock` (L37-49)
- Create/extend: `test/batch2-resource-flow.test.cjs`

- [ ] **Step 2-1: 写 failing test**

创建 `test/batch2-resource-flow.test.cjs`：

```javascript
const { generateResourceUpdate } = require('../adapters/templates/resource-flow.cjs');

function makeSchema() {
  return {
    resources: [
      { name: 'MetalShard', entity: 'MetalShard', convertRatio: 0 },
    ],
    phases: [],
    gameConfig: { collectRange: 1.5, maxCarry: 10 },
  };
}

describe('batch2 resource-flow buildCollectBlock', () => {
  test('collect block has _collectCooldown <= 0f gate', () => {
    var out = generateResourceUpdate(makeSchema());
    expect(out).toMatch(/_collectCooldown\s*<=\s*0f/);
  });

  test('collect block sets _collectCooldown = collectCooldownInterval after collecting', () => {
    var out = generateResourceUpdate(makeSchema());
    expect(out).toMatch(/_collectCooldown\s*=\s*collectCooldownInterval/);
  });

  test('scoreText update gated by _lastScoreText diff', () => {
    var out = generateResourceUpdate(makeSchema());
    // Must NOT directly assign scoreText.text from concat; must use diff pattern
    // Look for: if (_lastScoreText != <var>) { scoreText.text = <var>; _lastScoreText = <var>; }
    expect(out).toMatch(/_lastScoreText\s*!=/);
    expect(out).toMatch(/_lastScoreText\s*=\s*\w+\s*;/);
  });

  test('collect block does NOT have direct scoreText.text = concat (anti-regression)', () => {
    var out = generateResourceUpdate(makeSchema());
    // Should not have: scoreText.text = "..." + ... as top-level statement without diff gate
    // Match: scoreText.text = "lit" + at start of statement (not inside if (_lastScoreText != ...) context)
    var directConcat = /\n\s*scoreText\.text\s*=\s*"[^"]*"\s*\+/;
    expect(out).not.toMatch(directConcat);
  });
});
```

- [ ] **Step 2-2: 跑 test 确认 fail**

```bash
cd /opt/blueprint-editor && npx jest test/batch2-resource-flow.test.cjs --no-coverage
```

Expected: 4 FAIL。

- [ ] **Step 2-3: 改造 buildCollectBlock**

替换 `adapters/templates/resource-flow.cjs` L37-49（整个 `buildCollectBlock` 函数）：

```javascript
function buildCollectBlock(resource) {
  var resourceName = resource.name;
  var sourceEntity = toLowerCamel(resource.entity);
  var scoreVar = '_score_' + resourceName;

  return [
    'if (_collectCooldown <= 0f && IsNear(' + sourceEntity + ', collectRange)) {',
    '    if (' + resourceName + 'Carried < maxCarry) {',
    '        ' + resourceName + 'Carried++;',
    '        _collectCooldown = collectCooldownInterval;',
    '        string ' + scoreVar + ' = "' + escapeString(resourceName) + ': " + ' + resourceName + 'Carried + "/" + maxCarry;',
    '        if (_lastScoreText != ' + scoreVar + ') { scoreText.text = ' + scoreVar + '; _lastScoreText = ' + scoreVar + '; }',
    '    }',
    '}'
  ];
}
```

**关键点**：
- 局部变量 `_score_<ResourceName>` 唯一，防多资源并排块内名冲突
- 保留 `maxCarry` 上限检查（原逻辑）
- cooldown 写入在 `++` 之后、scoreText 之前

- [ ] **Step 2-4: 跑 test 确认 4 PASS**

```bash
cd /opt/blueprint-editor && npx jest test/batch2-resource-flow.test.cjs --no-coverage
```

Expected: 4 PASS。

- [ ] **Step 2-5: full jest**

```bash
cd /opt/blueprint-editor && npx jest --no-coverage 2>&1 | tail -3
```

Expected: 108 passing（104 + 4）。

- [ ] **Step 2-6: Commit**

```bash
cd /opt/blueprint-editor && git add adapters/templates/resource-flow.cjs test/batch2-resource-flow.test.cjs && git commit -m "$(cat <<'EOF'
perf(template): T2-2a resource-flow 采集加 cooldown gate + scoreText diff

修复每帧 MetalShardCarried++ 无冷却的逻辑 bug。靠近资源时被
_collectCooldown <= 0f 门控；采集后回填 collectCooldownInterval。
scoreText 通过 _lastScoreText diff 仅在变化时赋值。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: collect-interaction.cjs 改造（T2-2b）

**Files:**
- Modify: `adapters/templates/interactions/collect-interaction.cjs` — `generateCollectUpdate`
- Create: `test/batch2-collect-interaction.test.cjs`

- [ ] **Step 3-1: 写 failing test**

```javascript
const { generateCollectUpdate } = require('../adapters/templates/interactions/collect-interaction.cjs');

function makeSchema() {
  return {
    resources: [
      { name: 'Metal', entity: 'MetalSource', maxStock: 10 },
    ],
    gameConfig: { collectRange: 2, maxCarry: 10 },
  };
}

describe('batch2 collect-interaction cooldown', () => {
  test('collect block has _collectCooldown <= 0f gate', () => {
    var out = generateCollectUpdate(makeSchema());
    expect(out).toMatch(/_collectCooldown\s*<=\s*0f/);
  });

  test('collect block sets _collectCooldown = collectCooldownInterval', () => {
    var out = generateCollectUpdate(makeSchema());
    expect(out).toMatch(/_collectCooldown\s*=\s*collectCooldownInterval/);
  });

  test('Done flag still set (anti-regression for dual-path rule)', () => {
    var out = generateCollectUpdate(makeSchema());
    expect(out).toMatch(/MetalSourceDone\s*=\s*true/);
  });
});
```

- [ ] **Step 3-2: 跑 test 确认 fail**

Expected: 2 FAIL, 1 PASS (Done flag 原本就设)。

- [ ] **Step 3-3: 改造 generateCollectUpdate**

替换 `adapters/templates/interactions/collect-interaction.cjs` L7-28（`generateCollectUpdate` 整个函数）：

```javascript
function generateCollectUpdate(schema) {
  var resources = schema.resources || [];
  var gc = schema.gameConfig || {};
  var collectRange = gc.collectRange || 2;
  var maxCarry = gc.maxCarry || 10;
  if (resources.length === 0) return '';

  var lines = [];
  for (var i = 0; i < resources.length; i++) {
    var r = resources[i];
    var entity = toLowerCamel(r.entity);
    var cap = r.maxStock || maxCarry;
    lines.push('        if (_collectCooldown <= 0f && ' + entity + ' != null && IsNear(' + entity + ', ' + collectRange + 'f)) {');
    lines.push('            if (GetResource("' + escapeString(r.name) + '") < ' + cap + ') {');
    lines.push('                AddResource("' + escapeString(r.name) + '", 1);');
    lines.push('                _collectCooldown = collectCooldownInterval;');
    lines.push('                ' + entity + 'Done = true;');
    lines.push('            }');
    lines.push('        }');
    if (i < resources.length - 1) lines.push('');
  }
  return lines.join('\n');
}
```

- [ ] **Step 3-4: 跑 test 确认 3 PASS**

```bash
cd /opt/blueprint-editor && npx jest test/batch2-collect-interaction.test.cjs --no-coverage
```

Expected: 3 PASS。

- [ ] **Step 3-5: full jest**

Expected: 111 passing（108 + 3）。

- [ ] **Step 3-6: Commit**

```bash
cd /opt/blueprint-editor && git add adapters/templates/interactions/collect-interaction.cjs test/batch2-collect-interaction.test.cjs && git commit -m "$(cat <<'EOF'
perf(template): T2-2b collect-interaction 加 cooldown gate

Batch 12 新增模板继承了无冷却的逻辑 bug。用 _collectCooldown 门控
并保留 xxxDone 双路径标志（dual-path 规则不变）。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: score-display.cjs 加 diff gate（T2-2c）

**Files:**
- Modify: `adapters/templates/interactions/score-display.cjs`
- Create: `test/batch2-score-display.test.cjs`

- [ ] **Step 4-1: 写 failing test**

```javascript
const { generateScoreDisplay } = require('../adapters/templates/interactions/score-display.cjs');

describe('batch2 score-display diff gate', () => {
  test('scoreText.text assignment gated by _lastScoreText diff', () => {
    var schema = { resources: [{ name: 'Metal', entity: 'MetalSource' }] };
    var out = generateScoreDisplay(schema);
    expect(out).toMatch(/_lastScoreText\s*!=\s*display/);
    expect(out).toMatch(/_lastScoreText\s*=\s*display/);
  });

  test('empty resources produces empty output (no regression)', () => {
    var out = generateScoreDisplay({ resources: [] });
    expect(out).toBe('');
  });
});
```

- [ ] **Step 4-2: 跑 test 确认 fail**

Expected: 1 FAIL, 1 PASS。

- [ ] **Step 4-3: 改造 generateScoreDisplay**

在 `adapters/templates/interactions/score-display.cjs`，替换 `scoreText.text = display;` 这一行（就是当前倒数第 2 行，push `scoreText.text = display;`）为：

```javascript
lines.push('            if (_lastScoreText != display) { scoreText.text = display; _lastScoreText = display; }');
```

删除原本的 `lines.push('            scoreText.text = display;');`。

- [ ] **Step 4-4: 跑 test 确认 2 PASS**

```bash
cd /opt/blueprint-editor && npx jest test/batch2-score-display.test.cjs --no-coverage
```

Expected: 2 PASS。

- [ ] **Step 4-5: full jest**

Expected: 113 passing（111 + 2）。

- [ ] **Step 4-6: Commit**

```bash
cd /opt/blueprint-editor && git add adapters/templates/interactions/score-display.cjs test/batch2-score-display.test.cjs && git commit -m "$(cat <<'EOF'
perf(template): T2-2c score-display 加 _lastScoreText diff gate

每帧拼 display 还不能消除，但赋值 scoreText.text 限定在变化时，
避免 Canvas dirty redraw。T3-3 warn 规则 HEAD skeleton 命中预期降到 0。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: resource-flow.cjs buildDeliverBlock IsNear 合并（T2-1）

**Files:**
- Modify: `adapters/templates/resource-flow.cjs` — `buildPhaseBlocks` + `buildDeliverBlock`
- Extend: `test/batch2-resource-flow.test.cjs`

**设计**：buildPhaseBlocks 原本按 resource 逐个 push buildDeliverBlock（每个 resource 一个 IsNear）。改成**先按 target entity 分组 relatedResources**，每个 target 只生成一个 IsNear 外壳，内部依次处理该 target 的所有 relatedResources。

- [ ] **Step 5-1: 追加 failing test 到 test/batch2-resource-flow.test.cjs**

```javascript
describe('batch2 resource-flow IsNear merge by target', () => {
  test('single IsNear(target) for multiple resources pointing to same target', () => {
    var schema = {
      resources: [
        { name: 'MetalShard', entity: 'MetalSource', convertRatio: 2 },
        { name: 'Gold', entity: 'MetalSource', convertRatio: 3 },
      ],
      phases: [
        { trigger: { type: 'entity_state_reached', entity: 'ForgeWorkshop', amount: 5 } },
      ],
    };
    var out = generateResourceUpdate(schema);
    // Count IsNear(forgeWorkshop, ...) calls in delivery blocks
    var matches = out.match(/IsNear\(forgeWorkshop,\s*2f\)/g) || [];
    // Before merge: 2 (one per resource). After merge: 1.
    expect(matches.length).toBe(1);
  });

  test('multiple targets still get separate IsNear blocks', () => {
    var schema = {
      resources: [
        { name: 'A', entity: 'SourceA', convertRatio: 1 },
      ],
      phases: [
        { trigger: { type: 'entity_state_reached', entity: 'TargetA', amount: 1 } },
        { trigger: { type: 'entity_state_reached', entity: 'TargetB', amount: 1 } },
      ],
    };
    var out = generateResourceUpdate(schema);
    expect(out).toMatch(/IsNear\(targetA,\s*2f\)/);
    expect(out).toMatch(/IsNear\(targetB,\s*2f\)/);
  });
});
```

- [ ] **Step 5-2: 跑 test 确认 fail**

Expected: 第一个 test FAIL（当前会 match 2 个 IsNear）。

- [ ] **Step 5-3: 改造 buildPhaseBlocks**

替换 `adapters/templates/resource-flow.cjs` L51-70（`buildPhaseBlocks` 整个函数）：

```javascript
function buildPhaseBlocks(phase, resources) {
  var trigger = phase && phase.trigger;
  if (!trigger) return [];
  if (trigger.type !== 'entity_state_reached') return [];

  var relatedResources = findRelatedResources(trigger.entity, resources);
  var targetEntity = toLowerCamel(trigger.entity);
  var deliverResources = [];
  var i;
  for (i = 0; i < relatedResources.length; i++) {
    if (relatedResources[i].convertRatio > 0) {
      deliverResources.push(relatedResources[i]);
    }
  }
  if (deliverResources.length === 0) return [];

  // Merged IsNear block: single proximity check, multiple resource deliveries inside.
  var lines = ['if (IsNear(' + targetEntity + ', 2f)) {'];
  for (i = 0; i < deliverResources.length; i++) {
    lines = lines.concat(buildDeliverBody(trigger, deliverResources[i], targetEntity));
  }
  lines.push('}');
  lines.push('');
  return lines;
}

function buildDeliverBody(trigger, resource, targetEntity) {
  var resourceName = resource.name;
  var requiredAmount = trigger.amount || resource.convertRatio;

  return [
    '    if (' + resourceName + 'Carried > 0) {',
    '        AddResource("' + escapeString(resourceName) + '", ' + resourceName + 'Carried);',
    '        ' + resourceName + 'Carried = 0;',
    '        if (GetResource("' + escapeString(resourceName) + '") >= ' + requiredAmount + ') {',
    '            ' + targetEntity + 'State++;',
    '        }',
    '    }',
  ];
}
```

**关键点**：
- 保留老 `buildDeliverBlock` 函数声明以兼容任何外部调用（虽然本文件外没人用，grep 确认）；但如果没被调用就删掉
- `buildDeliverBody` 是新内部函数，接收共享 `targetEntity`，**不再**自己生成 IsNear 外壳
- 缩进比原版多 4 空格（因为被外层 if 包裹）

**删除旧 `buildDeliverBlock` 的前提验证**：

```bash
cd /opt/blueprint-editor && grep -rn "buildDeliverBlock" adapters/ test/
```

如果只在 resource-flow.cjs 自己用，可以删；有任何外部引用，保留函数但添加注释标记 deprecated。

- [ ] **Step 5-4: 跑 test 确认 PASS**

```bash
cd /opt/blueprint-editor && npx jest test/batch2-resource-flow.test.cjs --no-coverage
```

Expected: 所有 resource-flow tests PASS（包括 Task 2 的 4 个 + Task 5 的 2 个 = 6 个）。

- [ ] **Step 5-5: full jest**

Expected: 115 passing（113 + 2）。

- [ ] **Step 5-6: Commit**

```bash
cd /opt/blueprint-editor && git add adapters/templates/resource-flow.cjs test/batch2-resource-flow.test.cjs && git commit -m "$(cat <<'EOF'
perf(template): T2-1 resource-flow 按 target 合并 IsNear 块

多 resource 指向同一 target 时，IsNear 从每 resource 1 次合并为
每 target 1 次。实证 urbib0 项目 8 次 IsNear → 4 次。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: schema 加 collectCooldown（T2-3）

**Files:**
- Modify: `adapters/schema/game-schema.json`

- [ ] **Step 6-1: 追加字段到 gameConfig**

编辑 `adapters/schema/game-schema.json`，在 `gameConfig.properties.maxCarry` 后添加：

```json
"collectCooldown": {
  "type": "number",
  "minimum": 0.1,
  "maximum": 2.0,
  "default": 0.3,
  "description": "Seconds between consecutive collect actions (global cooldown). Lower = faster resource accumulation, higher = player must wait between pickups."
}
```

注意：
- **不加到 required 数组** — 可选字段，缺省 0.3
- 范围 0.1-2.0：防 AI 写 0（等于无冷却）或离谱大值

- [ ] **Step 6-2: 验证 schema 合法**

```bash
cd /opt/blueprint-editor && node -e "
var s = require('./adapters/schema/game-schema.json');
console.log('collectCooldown in gameConfig.properties:', !!s.properties.gameConfig.properties.collectCooldown);
console.log('required includes collectCooldown:', s.properties.gameConfig.required.indexOf('collectCooldown') >= 0);
"
```

Expected:
```
collectCooldown in gameConfig.properties: true
required includes collectCooldown: false
```

- [ ] **Step 6-3: 追加 test 到 Task 1 skeleton-cooldown 测试**

在 `test/batch2-skeleton-cooldown.test.cjs` describe 块内追加：

```javascript
  test('collectCooldownInterval respects schema gameConfig.collectCooldown', () => {
    var specs = [{
      phaseId: 'p1', title: 'x', entities: ['Player', 'M'],
      requiredInteractions: ['move_to:M', 'collect:M'],
      endCondition: 'MCarried >= 1',
    }];
    specs.gameConfig = { collectCooldown: 0.5 };
    var out = generateSkeleton(specs);
    var main = typeof out === 'string' ? out : out.main;
    expect(main).toMatch(/float\s+collectCooldownInterval\s*=\s*0\.5f\s*;/);
  });
```

- [ ] **Step 6-4: 跑新 test 确认 PASS**

因为 Task 1 已经实现了读 `specs.gameConfig.collectCooldown`，这里应直接 PASS：

```bash
cd /opt/blueprint-editor && npx jest test/batch2-skeleton-cooldown.test.cjs -t "respects schema" --no-coverage
```

Expected: PASS。如果 FAIL → Task 1 的实现有 bug，回去修（priority 高于 commit）。

- [ ] **Step 6-5: full jest**

Expected: 116 passing（115 + 1）。

- [ ] **Step 6-6: Commit**

```bash
cd /opt/blueprint-editor && git add adapters/schema/game-schema.json test/batch2-skeleton-cooldown.test.cjs && git commit -m "$(cat <<'EOF'
perf(schema): T2-3 gameConfig.collectCooldown 可配字段 (0.1-2.0s, default 0.3)

让不同游戏能调整采集节奏。skeleton 已从 Task 1 读取该字段。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: 集成验证 — HEAD skeleton 静态检查 + T3-3 warn 归零

**Files:**
- Verify only

- [ ] **Step 7-1: 重新生成 skeleton**

```bash
cd /opt/blueprint-editor && node -e "
var g = require('./adapters/skeleton-generator.cjs');
var specs = JSON.parse(require('fs').readFileSync('spec-data/proj_1776297105366_xrbkl1/specs.json','utf8'));
var out = g.generateSkeleton(specs);
require('fs').writeFileSync('/tmp/batch2-skeleton.cs', typeof out === 'string' ? out : out.main);
console.log('Wrote', require('fs').statSync('/tmp/batch2-skeleton.cs').size, 'bytes');
"
```

- [ ] **Step 7-2: 对 HEAD skeleton 跑 static-check，确认 Batch 3 三条 rule 状态**

```bash
cd /opt/blueprint-editor && node -e "
var { staticCheck } = require('./engine/static-check.cjs');
var code = require('fs').readFileSync('/tmp/batch2-skeleton.cs','utf8');
var r = staticCheck(code);
var batch3 = ['update-new-vector-in-hot-path','chained-if-same-var-no-else','string-concat-in-update'];
batch3.forEach(function(id){
  var hits = r.issues.filter(i => i.rule === id);
  var blocking = hits.filter(h => h.blocking).length;
  console.log(id, 'total:', hits.length, 'blocking:', blocking);
  hits.slice(0,3).forEach(h => console.log('  L' + h.line + ': ' + h.text));
});
"
```

Expected:
```
update-new-vector-in-hot-path total: 0 blocking: 0
chained-if-same-var-no-else total: 1 blocking: 0  (pre-codegen stub, unchanged)
string-concat-in-update total: 0 blocking: 0     (Batch 2 修掉了 skeleton 产物里的 concat)
```

**验收关键**：`string-concat-in-update total: 0`。如果还有命中 → 说明某个模板的 string concat 还没修掉，根据命中行号回去补。

- [ ] **Step 7-3: 生成产物看一眼 collect block 形状**

```bash
cd /opt/blueprint-editor && grep -A 6 "IsNear.*collectRange" /tmp/batch2-skeleton.cs | head -30
```

肉眼验证：
- `if (_collectCooldown <= 0f && IsNear(...))` gate 存在
- `_collectCooldown = collectCooldownInterval;` 在 ++ 后
- `if (_lastScoreText != _score_X)` 包住了 scoreText 赋值

- [ ] **Step 7-4: 不 commit，只记录结果到 Task 8 报告**

---

## Task 8: CUA 回归（可选 — 视健康项目可用性）

**Files:**
- Verify only (no code changes)

**前置**：需要一个 specs/blueprint 完整、编译稳定、CUA 历史通过的项目。xrbkl1 和 urbib0 都不适合（urbib0 pipeline 级 semantic 故障，xrbkl1 只有 specs 没 project json）。

- [ ] **Step 8-1: 筛健康项目**

```bash
cd /opt/blueprint-editor && ls server-data/projects/*.json | head -5
# 依次看 status === 'committed' 或 'reviewing' 且 lastFailure === null 的 project
```

如果找不到健康项目，**跳过 Task 8**，在报告里记录「CUA 回归未能做，建议下一个新项目上线时观察采集节奏是否合理」。

- [ ] **Step 8-2: 若有健康项目，reset + resubmit**

用 `POST /api/projects/:id/feedback` 而不是手改 json：

```bash
curl -X POST http://localhost:3901/api/projects/<projectId>/feedback \
  -H "Content-Type: application/json" \
  -d '{"feedback": "Batch 2 regression test — verify collect cadence unchanged by cooldown"}'
```

- [ ] **Step 8-3: 用 foreground 轮询查状态（每 2 分钟）**

```bash
curl -s http://localhost:3901/api/projects/<projectId> | node -e "
var d = '';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
  var p = JSON.parse(d);
  console.log('status:', p.status, 'lastFailure:', p.lastFailure, 'CUA rounds:', p.cuaRounds);
});"
```

期望：CUA 通过轮数**不超过 Batch 1 历史平均值**（即 cooldown 0.3s 没拖慢 CUA）。如果轮数显著增加 → T2-2 的 0.3s 偏大，改成 0.2s 或 0.15s 试试。

- [ ] **Step 8-4: 回写结果到报告**

---

## Task 9: Batch 2 报告

**Files:**
- Create: `docs/superpowers/specs/2026-04-19-perf-batch2-report.md`
- Modify: `docs/superpowers/specs/2026-04-19-codegen-performance-optimization-design.md` (Status 行)

- [ ] **Step 9-1: 更新 design doc status 行**

把 Status 行改为：`✅ Approved — Batch 1 + 2 + 3 已落地 (2026-04-19)`（如果 Task 8 的 CUA 回归做了就加 "CUA 验证通过"；没做就加 "待新项目上线后 observe"）

- [ ] **Step 9-2: 写报告**

`docs/superpowers/specs/2026-04-19-perf-batch2-report.md`，参考 batch1-report 和 batch3-report 格式。内容：
- 6 次 Batch 2 commit hash
- 12 个新 test case（Task 1:4 + Task 2:4 + Task 3:3 + Task 5:2 + Task 6:1 - skeleton-cooldown 是 5 个）
- HEAD skeleton 的 T3-3 warn 从 0 → 仍然 0（skeleton 本来就没命中，但产物里如果有 collect block 之前会有，现在被修掉）
- 采集节奏修复说明：0.3s/次，对应 CUA 5x 倍速下 ~0.06 real-s/次，11 phase 共 ~10 个采集事件 = 0.6 real-s，不影响 phase 总时长
- 下一步：观察 live 项目

- [ ] **Step 9-3: Commit**

```bash
cd /opt/blueprint-editor && git add docs/superpowers/specs/2026-04-19-codegen-performance-optimization-design.md docs/superpowers/specs/2026-04-19-perf-batch2-report.md && git commit -m "$(cat <<'EOF'
docs(perf): Batch 2 实施报告 — 采集 cooldown 逻辑 bug 修复 + IsNear 合并

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## 完成判据

- [ ] Jest 116/116 全绿（100 baseline + 4 + 4 + 3 + 2 + 2 + 1 = 116）
- [ ] HEAD skeleton 上 `string-concat-in-update` 命中从 Batch 3 的 0 保持 0
- [ ] 6 次独立 commit（Task 1-6 各 1 次）+ 1 次报告 commit
- [ ] Task 7 记录 collect block 新形状的 grep 截图
- [ ] Task 8 CUA 回归做了或明确记录跳过原因
- [ ] Design doc + Batch 2 报告写好

---

## 风险 & 回滚

### 高风险项：T2-2 cooldown 改变游戏时序

- **影响**：采集从「瞬时满」变成「0.3s/次」。CUA 5x 倍速下 = 0.06 real-s/次，采集 10 次 = 0.6 real-s 额外耗时。一般一个 phase 12s + 50s 安全网足够容纳。
- **回滚**：单独 `git revert` Task 2/3 的 commit（不 revert Task 1 infra；infra 不做破坏）。
- **调参路径**：Task 8 CUA 如果超时 → 改 schema default 为 0.15 或 0.2，无需改模板。

### 中风险项：T2-1 IsNear 合并

- **影响**：改变 C# 嵌套结构。AI 生成的 TODO_CUSTOM 代码若假设「每 resource 独立 if」可能行为变化。但 TODO_CUSTOM 在 buildPhaseBlocks 外部，不受影响。
- **回滚**：`git revert` Task 5 commit，buildPhaseBlocks 回退到逐 resource push。

### 低风险项：T2-3 schema

- 纯可选字段，不 breaking。缺省 0.3s。
- 回滚：删字段即可。

---

## 执行建议

- **Subagent-driven**：Task 1/2/3/4/5/6 各起一个 subagent（每个 task 独立 commit），Task 7/8/9 主执行
- **分段执行**：Task 1 做完先停一下看 skeleton 输出没变形再继续；之后 Task 2-6 可连做
- **Task 8 CUA 回归** 是 Batch 2 最后的质量门。如果没有健康项目直接跳，在报告里记录决策
