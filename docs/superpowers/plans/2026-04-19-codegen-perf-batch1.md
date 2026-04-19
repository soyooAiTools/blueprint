# Codegen Performance — Batch 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 执行 spec `2026-04-19-codegen-performance-optimization-design.md` 的 Batch 1（纯模板等价改写）：去除 hot path `new Vector3` 泛滥，改 `else if` 链，IsNear 分量计算。验收靠 FPS baseline + 产物 `new Vector3` 计数 + Jest 全绿 + 端到端 CUA 通过。

**Architecture:** 只改 `adapters/skeleton-generator.cjs`、`adapters/templates/autoplay-mirror.cjs`、`adapters/codegen-template-engine.cjs` 三个文件；每个改动先写 Jest 单测断言生成的 C# 字符串包含/不包含特定模式，再改模板让测试通过。FPS harness 单独作为 Task 0，在 Batch 1 第一项代码改动**之前**采集基线，Batch 1 完成后再采一次对比。

**Tech Stack:** Node.js cjs 模板、Jest 单测、Puppeteer-core（FPS harness）、Luna build-api（本机 18860）

**Scope 约束（来自 spec 决策纪要）:**
- 本 Batch = T1-1 / T1-2 / T1-3 / T1-4 / T1-5 五项 + FPS harness
- T2-* 和 T3-* **不在本 Batch**，留给 Batch 2 / 3
- 不改 `resource-flow.cjs`、不改 `static-check.cjs`、不动 GFM 库
- 不自动 commit —— 每步 commit 步骤需手动确认

---

## File Structure

### 要新建的文件
- `scripts/fps-baseline.cjs` — Puppeteer FPS 采集脚本（本 Batch 之后保留作持续资产）
- `server-data/perf-baseline/batch1-before.json` — 改前基线
- `server-data/perf-baseline/batch1-after.json` — 改后对比

### 要修改的文件
- `adapters/templates/autoplay-mirror.cjs` L16 — 裸 if → else if（T1-3）
- `adapters/codegen-template-engine.cjs` L155 — 裸 if → else if（T1-4）
- `adapters/skeleton-generator.cjs` L370-411 MovePlayer block — 引入 `_moveBuf` 字段复用（T1-2）
- `adapters/skeleton-generator.cjs` L415-419 IsNear block — 改分量计算 + range²（T1-5）
- `adapters/skeleton-generator.cjs` L977-994 PlaceObj/HideObj/SetScale — struct copy 模式（T1-1）

### 要新建的测试
- `test/skeleton-generator-perf.test.cjs` — 断言 MovePlayer / IsNear / PlaceObj 生成代码符合优化后形态
- `test/codegen-template-perf.test.cjs` — 断言 TODO_UPDATE 和 TODO_AUTOPLAY 的 if 链带 `else if`

---

### Task 0: FPS Baseline Harness

**Files:**
- Create: `/opt/blueprint-editor/scripts/fps-baseline.cjs`

采用 puppeteer-core + DevTools Protocol 的 `Performance.metrics` 接口录 10 秒，计算平均 FPS。**不用 playwright**（global memory 已禁用）。chromium 路径 `~/.cache/puppeteer`（按 blueprint global memory）。

- [ ] **Step 0.1: 确认 puppeteer-core 和 chromium 存在**

Run:
```bash
node -e "const p=require('puppeteer-core'); console.log('puppeteer-core OK'); const fs=require('fs'); const path=require('path'); const dir=require('os').homedir()+'/.cache/puppeteer'; console.log('chrome cache:', fs.existsSync(dir)?fs.readdirSync(dir).join(','):'MISSING');"
```
Expected: 打印 `puppeteer-core OK` 和 cache dir 内容（非 MISSING）。

- [ ] **Step 0.2: 创建 harness 脚本**

Create `/opt/blueprint-editor/scripts/fps-baseline.cjs`:

```javascript
#!/usr/bin/env node
/**
 * FPS Baseline Harness — 采集 Luna WebGL 产物的 FPS
 * Usage: node scripts/fps-baseline.cjs <projectId> <label>
 *   label: 'before' / 'after' / 任意字符串
 * Output: server-data/perf-baseline/<projectId>-<label>.json
 */
'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const glob = require('glob');

const PROJECT_ID = process.argv[2];
const LABEL = process.argv[3] || 'before';
const DURATION_MS = 10000;
const OUT_DIR = '/opt/blueprint-editor/server-data/perf-baseline';

if (!PROJECT_ID) { console.error('Usage: node scripts/fps-baseline.cjs <projectId> <label>'); process.exit(1); }

function findChrome() {
  const base = require('os').homedir() + '/.cache/puppeteer';
  const matches = glob.sync(base + '/chrome/*/chrome-linux*/chrome');
  if (!matches.length) throw new Error('chromium not found under ' + base);
  return matches[0];
}

function findWebglIndex() {
  const webglDir = '/opt/blueprint-editor/server-data/webgl/' + PROJECT_ID;
  if (!fs.existsSync(webglDir)) throw new Error('webgl output missing: ' + webglDir);
  const candidate = path.join(webglDir, 'iframe.html');
  if (!fs.existsSync(candidate)) throw new Error('iframe.html missing under ' + webglDir);
  return candidate;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const html = findWebglIndex();
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 720, height: 1280 });
  await page.goto('file://' + html, { waitUntil: 'networkidle2', timeout: 60000 });
  // 等 Unity 启动完成
  await new Promise(r => setTimeout(r, 3000));

  // rAF 采样 FPS
  const samples = await page.evaluate(async (durMs) => {
    return new Promise((resolve) => {
      const times = [];
      let last = performance.now();
      const start = last;
      function tick() {
        const now = performance.now();
        times.push(now - last);
        last = now;
        if (now - start < durMs) requestAnimationFrame(tick);
        else resolve(times);
      }
      requestAnimationFrame(tick);
    });
  }, DURATION_MS);

  await browser.close();

  const frames = samples.length;
  const totalMs = samples.reduce((a,b)=>a+b, 0);
  const avgFps = frames / (totalMs / 1000);
  const p1 = samples.slice().sort((a,b)=>a-b);
  const p50ms = p1[Math.floor(p1.length*0.5)];
  const p95ms = p1[Math.floor(p1.length*0.95)];
  const p99ms = p1[Math.floor(p1.length*0.99)];

  const report = {
    projectId: PROJECT_ID,
    label: LABEL,
    timestamp: new Date().toISOString(),
    durationMs: DURATION_MS,
    frames,
    avgFps: Number(avgFps.toFixed(2)),
    frameMs: {
      p50: Number(p50ms.toFixed(2)),
      p95: Number(p95ms.toFixed(2)),
      p99: Number(p99ms.toFixed(2)),
    },
    samplesPreview: samples.slice(0, 20),
  };

  const outPath = path.join(OUT_DIR, PROJECT_ID + '-' + LABEL + '.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log('FPS baseline written:', outPath);
  console.log('  avgFps=' + report.avgFps + '  p95=' + report.frameMs.p95 + 'ms  p99=' + report.frameMs.p99 + 'ms');
})().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 0.3: 确认 `glob` 包可用（如果不在依赖里则用 fs 代替）**

Run:
```bash
cd /opt/blueprint-editor && node -e "require('glob'); console.log('OK');"
```
Expected: 打印 `OK`。如果报错，把 harness 里的 `glob.sync` 改成手动 `fs.readdirSync` 递归（10 分钟改）。

- [ ] **Step 0.4: 采集改前基线**

Run:
```bash
cd /opt/blueprint-editor && node scripts/fps-baseline.cjs proj_1776391516726_urbib0 before
```
Expected: 输出 `FPS baseline written: server-data/perf-baseline/proj_1776391516726_urbib0-before.json`，avgFps 在 30-60 之间。如果 < 20 说明 Luna 产物异常或 swiftshader 太慢，需用户确认是否换 GPU 或改期望。

- [ ] **Step 0.5: Commit harness（仅 harness，无 baseline 数据）**

```bash
cd /opt/blueprint-editor && git add scripts/fps-baseline.cjs && git status
```
先看 status 给用户，**等用户授权才 commit**（commit 消息 `feat(perf): add FPS baseline harness (Batch 1 prep)`）。baseline JSON 加到 `.gitignore`。

---

### Task 1: T1-3 autoplay-mirror.cjs else if 链

**Files:**
- Modify: `adapters/templates/autoplay-mirror.cjs:13-16`
- Test: `test/codegen-template-perf.test.cjs`

- [ ] **Step 1.1: 写失败的测试**

Create `/opt/blueprint-editor/test/codegen-template-perf.test.cjs`:

```javascript
'use strict';
const { generateAutoPlay } = require('../adapters/templates/autoplay-mirror.cjs');

describe('autoplay-mirror — else if chain (T1-3)', () => {
  const schema = {
    phases: [
      { phaseId: 'phaseA', trigger: { type: 'resource_collected', resource: 'X', amount: 1 }, onComplete: [] },
      { phaseId: 'phaseB', trigger: { type: 'click_entity', entity: 'Target' }, onComplete: [] },
      { phaseId: 'phaseC', trigger: null, onComplete: [] },
    ],
    entities: [],
  };

  test('first phase uses bare `if`, subsequent phases use `else if`', () => {
    const code = generateAutoPlay(schema);
    // 第一个 phase: 裸 if
    expect(code).toMatch(/^\s*if \(currentPhaseName == "phaseA"\)/m);
    // 后续 phase: else if
    expect(code).toMatch(/\}\s*else if \(currentPhaseName == "phaseB"\)/);
    expect(code).toMatch(/\}\s*else if \(currentPhaseName == "phaseC"\)/);
    // 绝不应再出现独立 `if (currentPhaseName == "phaseB"`（无 else 前缀）
    const bareIfCount = (code.match(/^\s+if \(currentPhaseName/gm) || []).length;
    expect(bareIfCount).toBe(1);
  });
});
```

- [ ] **Step 1.2: 跑测试确认失败**

Run: `cd /opt/blueprint-editor && npx jest test/codegen-template-perf.test.cjs --no-coverage`
Expected: FAIL — `else if (currentPhaseName == "phaseB")` 匹配失败，当前模板生成的是裸 if。

- [ ] **Step 1.3: 改模板**

Edit `adapters/templates/autoplay-mirror.cjs` L13-16：

Before:
```javascript
  for (var i = 0; i < phases.length; i++) {
    var phase = phases[i];
    var mirror = triggerToMirror(phase.trigger, schema);
    lines.push('        if (currentPhaseName == "' + phase.phaseId + '") {');
```

After:
```javascript
  for (var i = 0; i < phases.length; i++) {
    var phase = phases[i];
    var mirror = triggerToMirror(phase.trigger, schema);
    var prefix = i === 0 ? 'if' : 'else if';
    lines.push('        ' + prefix + ' (currentPhaseName == "' + phase.phaseId + '") {');
```

- [ ] **Step 1.4: 跑测试确认通过**

Run: `cd /opt/blueprint-editor && npx jest test/codegen-template-perf.test.cjs --no-coverage`
Expected: PASS。

- [ ] **Step 1.5: 跑全量 Jest 确认无回归**

Run: `cd /opt/blueprint-editor && npx jest --no-coverage`
Expected: 原 81 tests + 新 1 test = 82 PASS，0 FAIL。

- [ ] **Step 1.6: 等用户授权后 commit**

```bash
cd /opt/blueprint-editor && git diff adapters/templates/autoplay-mirror.cjs test/codegen-template-perf.test.cjs
```
Show diff, await authorization. Commit message: `perf(codegen): autoplay-mirror uses else-if chain (T1-3)`.

---

### Task 2: T1-4 codegen-template-engine.cjs TODO_UPDATE else if

**Files:**
- Modify: `adapters/codegen-template-engine.cjs:152-157`
- Test: `test/codegen-template-perf.test.cjs`（追加）

- [ ] **Step 2.1: 追加失败测试**

Append to `test/codegen-template-perf.test.cjs`:

```javascript
const { fillSkeleton } = require('../adapters/codegen-template-engine.cjs');

describe('codegen-template-engine TODO_UPDATE — else if chain (T1-4)', () => {
  // 直接测内部函数 generateUpdateBody 需要 export 它。最小侵入：调 fillSkeleton 看产物。
  // 但 fillSkeleton 要完整 skeleton，太重。改为断言模板引擎包含该模式，通过暴露 generateUpdateBody。
  test('first phase click handler uses `if`, rest use `else if`', () => {
    // 读 codegen-template-engine 源代码断言代码形态（白盒）
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../adapters/codegen-template-engine.cjs'), 'utf8');
    // 必须包含 `pi === 0 ? 'if' : 'else if'` 三元表达式
    expect(src).toMatch(/pi === 0 \? ['"]if['"] : ['"]else if['"]/);
  });
});
```

（白盒断言是务实选择：`generateUpdateBody` 目前是文件内私有函数，不想仅为测试而暴露；白盒断言覆盖"代码里确实写了这个模式"，配合下一步的 end-to-end 构建验证即可。）

- [ ] **Step 2.2: 跑测试确认失败**

Run: `cd /opt/blueprint-editor && npx jest test/codegen-template-perf.test.cjs --no-coverage`
Expected: FAIL — 文件里还没有三元表达式。

- [ ] **Step 2.3: 改模板引擎**

Edit `adapters/codegen-template-engine.cjs` L152-157：

Before:
```javascript
  if (phases.length > 0) {
    lines.push('        if (!_autoPlayMode && (Input.GetMouseButtonDown(0) || (Input.touchCount > 0 && Input.GetTouch(0).phase == TouchPhase.Began))) {');
    for (var pi = 0; pi < phases.length; pi++) {
      var pid = phases[pi].phaseId;
      lines.push('            if (currentPhaseName == "' + pid + '") { ' + pid + 'InteractionDone = true; ' + pid + 'PlayerActed = true; }');
    }
    lines.push('        }');
```

After:
```javascript
  if (phases.length > 0) {
    lines.push('        if (!_autoPlayMode && (Input.GetMouseButtonDown(0) || (Input.touchCount > 0 && Input.GetTouch(0).phase == TouchPhase.Began))) {');
    for (var pi = 0; pi < phases.length; pi++) {
      var pid = phases[pi].phaseId;
      var prefix = pi === 0 ? 'if' : 'else if';
      lines.push('            ' + prefix + ' (currentPhaseName == "' + pid + '") { ' + pid + 'InteractionDone = true; ' + pid + 'PlayerActed = true; }');
    }
    lines.push('        }');
```

- [ ] **Step 2.4: 跑测试确认通过**

Run: `cd /opt/blueprint-editor && npx jest test/codegen-template-perf.test.cjs --no-coverage`
Expected: PASS。

- [ ] **Step 2.5: 跑全量 Jest**

Run: `cd /opt/blueprint-editor && npx jest --no-coverage`
Expected: 全 PASS。

- [ ] **Step 2.6: 等授权 commit**

Message: `perf(codegen): template-engine TODO_UPDATE uses else-if chain (T1-4)`.

---

### Task 3: T1-5 IsNear 分量计算（去 sqrt）

**Files:**
- Modify: `adapters/skeleton-generator.cjs:414-419`
- Test: `test/skeleton-generator-perf.test.cjs`

- [ ] **Step 3.1: 写失败测试**

Create `/opt/blueprint-editor/test/skeleton-generator-perf.test.cjs`:

```javascript
'use strict';
const fs = require('fs');
const path = require('path');

// skeleton-generator 的入口函数是 generateSkeleton(spec, options)。跑一次拿到完整字符串再断言。
const { generateSkeleton } = require('../adapters/skeleton-generator.cjs');

function buildMinimalSpec() {
  return {
    phases: [
      { phaseId: 'p1', description: 'phase 1', trigger: { type: 'timer', duration: 5 } },
    ],
    entities: [
      { name: 'Player', type: 'player' },
      { name: 'Target', type: 'object' },
    ],
    globalSettings: {},
    gameConfig: { moveSpeed: 5 },
    resources: [],
    npcs: [],
  };
}

describe('skeleton-generator — IsNear no sqrt (T1-5)', () => {
  const code = generateSkeleton(buildMinimalSpec(), {});
  test('IsNear uses dx*dx + dz*dz < range*range, not Vector3.Distance', () => {
    const m = code.match(/bool IsNear\(GameObject target, float range\)\s*[\s\S]*?\}/);
    expect(m).toBeTruthy();
    const body = m[0];
    expect(body).not.toMatch(/Vector3\.Distance/);
    expect(body).toMatch(/dx\s*\*\s*dx/);
    expect(body).toMatch(/range\s*\*\s*range/);
  });
});
```

注意：`generateSkeleton` 的实际函数名需要从 `skeleton-generator.cjs` 末尾的 `module.exports = ...` 确认。如果不叫这个名，改成正确导出名。

- [ ] **Step 3.2: 确认 skeleton-generator 导出 API**

Run:
```bash
cd /opt/blueprint-editor && tail -5 adapters/skeleton-generator.cjs
```
Expected: 看到 `module.exports = { ... }`。把测试文件里的函数名改正确。

- [ ] **Step 3.3: 跑测试确认失败**

Run: `cd /opt/blueprint-editor && npx jest test/skeleton-generator-perf.test.cjs --no-coverage`
Expected: FAIL — 当前 IsNear 用 Vector3.Distance。

- [ ] **Step 3.4: 改 skeleton**

Edit `adapters/skeleton-generator.cjs` L414-419：

Before:
```javascript
    lines.push('    // [SKELETON] Check if player is near a target (proximity trigger)');
    lines.push('    bool IsNear(GameObject target, float range)');
    lines.push('    {');
    lines.push('        if (player == null || target == null) return false;');
    lines.push('        return Vector3.Distance(player.transform.position, target.transform.position) < range;');
    lines.push('    }');
```

After:
```javascript
    lines.push('    // [SKELETON] Check if player is near a target (proximity trigger) — uses sqr distance to avoid sqrt + Vector3 alloc');
    lines.push('    bool IsNear(GameObject target, float range)');
    lines.push('    {');
    lines.push('        if (player == null || target == null) return false;');
    lines.push('        float dx = player.transform.position.x - target.transform.position.x;');
    lines.push('        float dz = player.transform.position.z - target.transform.position.z;');
    lines.push('        return (dx * dx + dz * dz) < (range * range);');
    lines.push('    }');
```

- [ ] **Step 3.5: 跑测试确认通过**

Run: `cd /opt/blueprint-editor && npx jest test/skeleton-generator-perf.test.cjs --no-coverage`
Expected: PASS。

- [ ] **Step 3.6: 跑全量 Jest**

Run: `cd /opt/blueprint-editor && npx jest --no-coverage`
Expected: 全 PASS。

- [ ] **Step 3.7: 等授权 commit**

Message: `perf(skeleton): IsNear uses sqr distance, no sqrt or Vector3 alloc (T1-5)`.

---

### Task 4: T1-1 PlaceObj/HideObj/SetScale struct copy 模式

**Files:**
- Modify: `adapters/skeleton-generator.cjs:977-994`
- Test: `test/skeleton-generator-perf.test.cjs`（追加）

**⚠️ Bridge.NET 不确定性**：C# 原生下 `var pos = transform.position; pos.x = x; transform.position = pos;` 省 alloc，Bridge.NET → JS 下 `transform.position` getter 仍返回 new 对象，可能无净收益。本 Task 依赖 Task 7 的 FPS 对比判断是否保留。**如果 FPS 无改善或回退，Task 7 里会 revert 这一项**。

- [ ] **Step 4.1: 追加失败测试**

Append to `test/skeleton-generator-perf.test.cjs`:

```javascript
describe('skeleton-generator — PlaceObj/HideObj/SetScale struct copy (T1-1)', () => {
  const { generateSkeleton } = require('../adapters/skeleton-generator.cjs');
  const code = generateSkeleton(buildMinimalSpec(), {});

  test('PlaceObj uses struct-copy pattern, not `new Vector3`', () => {
    const m = code.match(/void PlaceObj\(GameObject obj, float x, float y, float z\)[\s\S]*?^\s*\}/m);
    expect(m).toBeTruthy();
    expect(m[0]).not.toMatch(/new Vector3/);
    expect(m[0]).toMatch(/obj\.transform\.position\s*=\s*[_a-zA-Z]/); // 赋值 non-new 变量
  });

  test('HideObj and SetScale also avoid `new Vector3`', () => {
    const hide = code.match(/void HideObj\(GameObject obj\)[\s\S]*?^\s*\}/m)[0];
    const scaleXYZ = code.match(/void SetScale\(GameObject obj, float x, float y, float z\)[\s\S]*?^\s*\}/m)[0];
    const scaleU = code.match(/void SetScale\(GameObject obj, float uniform\)[\s\S]*?^\s*\}/m)[0];
    expect(hide).not.toMatch(/new Vector3/);
    expect(scaleXYZ).not.toMatch(/new Vector3/);
    expect(scaleU).not.toMatch(/new Vector3/);
  });
});
```

- [ ] **Step 4.2: 跑测试确认失败**

Run: `cd /opt/blueprint-editor && npx jest test/skeleton-generator-perf.test.cjs --no-coverage`
Expected: FAIL — PlaceObj/HideObj/SetScale 里全是 `new Vector3`。

- [ ] **Step 4.3: 改 skeleton helpers**

Edit `adapters/skeleton-generator.cjs` L977-994：

Before:
```javascript
  lines.push('    void PlaceObj(GameObject obj, float x, float y, float z)');
  lines.push('    {');
  lines.push('        if (obj != null) obj.transform.position = new Vector3(x, y, z);');
  lines.push('    }');
  lines.push('');
  lines.push('    void HideObj(GameObject obj)');
  lines.push('    {');
  lines.push('        if (obj != null) obj.transform.position = new Vector3(0f, -999f, 0f);');
  lines.push('    }');
  lines.push('');
  lines.push('    void SetScale(GameObject obj, float x, float y, float z)');
  lines.push('    {');
  lines.push('        if (obj != null) obj.transform.localScale = new Vector3(x, y, z);');
  lines.push('    }');
  lines.push('    void SetScale(GameObject obj, float uniform)');
  lines.push('    {');
  lines.push('        if (obj != null) obj.transform.localScale = new Vector3(uniform, uniform, uniform);');
  lines.push('    }');
```

After:
```javascript
  lines.push('    // [SKELETON] Transform helpers — struct-copy pattern avoids alloc on Bridge.NET hot paths');
  lines.push('    void PlaceObj(GameObject obj, float x, float y, float z)');
  lines.push('    {');
  lines.push('        if (obj == null) return;');
  lines.push('        var pos = obj.transform.position;');
  lines.push('        pos.x = x; pos.y = y; pos.z = z;');
  lines.push('        obj.transform.position = pos;');
  lines.push('    }');
  lines.push('');
  lines.push('    void HideObj(GameObject obj)');
  lines.push('    {');
  lines.push('        if (obj == null) return;');
  lines.push('        var pos = obj.transform.position;');
  lines.push('        pos.x = 0f; pos.y = -999f; pos.z = 0f;');
  lines.push('        obj.transform.position = pos;');
  lines.push('    }');
  lines.push('');
  lines.push('    void SetScale(GameObject obj, float x, float y, float z)');
  lines.push('    {');
  lines.push('        if (obj == null) return;');
  lines.push('        var s = obj.transform.localScale;');
  lines.push('        s.x = x; s.y = y; s.z = z;');
  lines.push('        obj.transform.localScale = s;');
  lines.push('    }');
  lines.push('    void SetScale(GameObject obj, float uniform)');
  lines.push('    {');
  lines.push('        if (obj == null) return;');
  lines.push('        var s = obj.transform.localScale;');
  lines.push('        s.x = uniform; s.y = uniform; s.z = uniform;');
  lines.push('        obj.transform.localScale = s;');
  lines.push('    }');
```

- [ ] **Step 4.4: 跑测试确认通过**

Run: `cd /opt/blueprint-editor && npx jest test/skeleton-generator-perf.test.cjs --no-coverage`
Expected: PASS。

- [ ] **Step 4.5: 跑全量 Jest**

Run: `cd /opt/blueprint-editor && npx jest --no-coverage`
Expected: 全 PASS。注意 `test/static-check.test.cjs` 里如果有 skeleton 断言对 new Vector3 的引用会炸，如果炸要分析是否真问题。

- [ ] **Step 4.6: 等授权 commit**

Message: `perf(skeleton): PlaceObj/HideObj/SetScale use struct-copy pattern (T1-1)`.

---

### Task 5: T1-2 MovePlayer 复用 `_moveBuf` 字段

**Files:**
- Modify: `adapters/skeleton-generator.cjs:360-412`
- Test: `test/skeleton-generator-perf.test.cjs`（追加）

- [ ] **Step 5.1: 追加失败测试**

Append to `test/skeleton-generator-perf.test.cjs`:

```javascript
describe('skeleton-generator — MovePlayer buf reuse (T1-2)', () => {
  const { generateSkeleton } = require('../adapters/skeleton-generator.cjs');
  const code = generateSkeleton(buildMinimalSpec(), {});
  test('MovePlayer body has zero `new Vector3(` inside joystick branch', () => {
    const m = code.match(/void MovePlayer\(\)[\s\S]*?^\s*\}\s*$/m);
    expect(m).toBeTruthy();
    const body = m[0];
    // 允许 Vector3.zero / Vector3.up 这类，禁 `new Vector3(`
    const newVecCount = (body.match(/new\s+Vector3\s*\(/g) || []).length;
    expect(newVecCount).toBe(0);
  });
  test('class declares `Vector3 _moveBuf` field for reuse', () => {
    expect(code).toMatch(/Vector3\s+_moveBuf\s*(=|;)/);
  });
});
```

- [ ] **Step 5.2: 跑测试确认失败**

Run: `cd /opt/blueprint-editor && npx jest test/skeleton-generator-perf.test.cjs --no-coverage`
Expected: FAIL — MovePlayer 里有 2 个 `new Vector3`，且没有 `_moveBuf` 字段。

- [ ] **Step 5.3: 改 skeleton**

Edit `adapters/skeleton-generator.cjs` 两处：

**A. L365-367 附近增加 `_moveBuf` 字段声明**

Before:
```javascript
    lines.push('    // [SKELETON] Tap-to-move target (fallback for joystick)');
    lines.push('    Vector3 tapMoveTarget = Vector3.zero;');
    lines.push('    bool hasTapTarget = false;');
```

After:
```javascript
    lines.push('    // [SKELETON] Tap-to-move target (fallback for joystick)');
    lines.push('    Vector3 tapMoveTarget = Vector3.zero;');
    lines.push('    bool hasTapTarget = false;');
    lines.push('    // [SKELETON] Reusable buffer for per-frame move/look vectors — avoids alloc');
    lines.push('    Vector3 _moveBuf = Vector3.zero;');
```

**B. L378-385 joystick 分支改用 `_moveBuf`**

Before:
```javascript
    lines.push('            if (Mathf.Abs(h) > 0.1f || Mathf.Abs(v) > 0.1f)');
    lines.push('            {');
    lines.push('                Vector3 move = new Vector3(h, 0, v) * moveSpeed * Time.deltaTime;');
    lines.push('                player.transform.position += move;');
    lines.push('                player.transform.rotation = Quaternion.LookRotation(new Vector3(h, 0, v));');
    lines.push('                hasTapTarget = false;');
    lines.push('                return;');
    lines.push('            }');
```

After:
```javascript
    lines.push('            if (Mathf.Abs(h) > 0.1f || Mathf.Abs(v) > 0.1f)');
    lines.push('            {');
    lines.push('                _moveBuf.x = h; _moveBuf.y = 0f; _moveBuf.z = v;');
    lines.push('                float step = moveSpeed * Time.deltaTime;');
    lines.push('                var p = player.transform.position;');
    lines.push('                p.x += _moveBuf.x * step; p.z += _moveBuf.z * step;');
    lines.push('                player.transform.position = p;');
    lines.push('                player.transform.rotation = Quaternion.LookRotation(_moveBuf);');
    lines.push('                hasTapTarget = false;');
    lines.push('                return;');
    lines.push('            }');
```

- [ ] **Step 5.4: 跑测试确认通过**

Run: `cd /opt/blueprint-editor && npx jest test/skeleton-generator-perf.test.cjs --no-coverage`
Expected: PASS。

- [ ] **Step 5.5: 跑全量 Jest**

Run: `cd /opt/blueprint-editor && npx jest --no-coverage`
Expected: 全 PASS。

- [ ] **Step 5.6: 等授权 commit**

Message: `perf(skeleton): MovePlayer reuses _moveBuf field, no per-frame alloc (T1-2)`.

---

### Task 6: 重新生成太空捡垃圾产物并 end-to-end 验证

- [ ] **Step 6.1: 触发 pipeline 重跑**

用 spec 里列出的脚本改 status 为 submitted，让 worker 接单：
```bash
cd /opt/blueprint-editor && node -e "
const fs=require('fs');
const p='server-data/projects/proj_1776391516726_urbib0.json';
const d=JSON.parse(fs.readFileSync(p));
d.status='submitted';
d.autoCodingTaskId=null;
d.lastFailure=null;
fs.writeFileSync(p, JSON.stringify(d,null,2));
console.log('reset to submitted');
"
```

- [ ] **Step 6.2: 观察 pipeline 进展**

Run: `curl -s http://127.0.0.1:3000/api/watchdog | head -50` 每 2 min 查一次任务状态。

Expected: task 进入 processing → building → reviewing，总时长 < 20 min。CUA 一次通过（round ≤ 2）。

如果失败，停下分析；不在本 Batch 里盲改。

- [ ] **Step 6.3: 采集改后 FPS 基线**

Run:
```bash
cd /opt/blueprint-editor && node scripts/fps-baseline.cjs proj_1776391516726_urbib0 after
```
Expected: 输出 `proj_1776391516726_urbib0-after.json`。

- [ ] **Step 6.4: 对比 before/after**

Run:
```bash
cd /opt/blueprint-editor && node -e "
const b=require('./server-data/perf-baseline/proj_1776391516726_urbib0-before.json');
const a=require('./server-data/perf-baseline/proj_1776391516726_urbib0-after.json');
console.log('avgFps: ' + b.avgFps + ' -> ' + a.avgFps + ' (delta ' + (a.avgFps-b.avgFps).toFixed(2) + ')');
console.log('p95 ms: ' + b.frameMs.p95 + ' -> ' + a.frameMs.p95);
console.log('p99 ms: ' + b.frameMs.p99 + ' -> ' + a.frameMs.p99);
"
```

**判据**：
- **avgFps 升 ≥ 2 且 p95 不劣化** → Batch 1 成功，进入 Batch 2 规划
- **avgFps 持平（±1 内）** → 产物 `new Vector3` 计数必须下降 ≥60%，否则 revert T1-1（不划算）
- **avgFps 降 ≥ 2** → 有回退，立即 revert Task 4（T1-1 struct copy），重跑 Step 6.1-6.4 验证是否因 struct copy 在 Bridge.NET 上有额外开销

- [ ] **Step 6.5: 对比产物 `new Vector3` 计数**

Run:
```bash
cd /opt/blueprint-editor && grep -c "new Vector3" server-data/project-sources/proj_1776391516726_urbib0/GameFlowManagerMain.cs
```
Expected: 从 10 降到 ≤ 4（剩下的应全在初始化 Start 里，如 `mainCam.transform.position = new Vector3(0, 12f, -8f)` 之类）。

- [ ] **Step 6.6: 写 Batch 1 总结报告**

Create `/opt/blueprint-editor/docs/superpowers/specs/2026-04-19-perf-batch1-report.md`:

包含：
- 改前/改后 avgFps、p95、p99 数值
- 改前/改后 产物 `new Vector3` 计数
- CUA 轮数、端到端耗时
- 是否 revert 了任何 Task
- Batch 2 建议：T2-1/T2-2/T2-3 哪些继续，哪些放弃

- [ ] **Step 6.7: 等授权 commit 报告 + baseline JSON**

```bash
cd /opt/blueprint-editor && git add docs/superpowers/specs/2026-04-19-perf-batch1-report.md server-data/perf-baseline/
```

Message: `docs(perf): Batch 1 FPS baseline report`.

---

## Batch 1 交付标准（Summary）

- [ ] FPS harness 落地，可重复跑
- [ ] 5 项模板改动全部合入，单测覆盖
- [ ] Jest 全绿（81 + 新增约 5 = 86 tests）
- [ ] 太空捡垃圾项目重跑一次通过 CUA ≤ 2 轮
- [ ] avgFps 同场景同步骤有改善（≥ +2）或产物 `new Vector3` 降 ≥60%，否则回滚风险项
- [ ] 总结报告落盘

## 风险 & 回滚

- 每个 Task 独立 commit，任一 revert 不影响其他
- T1-1（struct copy）Bridge.NET 下收益不确定 —— FPS 验证不通过优先 revert
- FPS harness 在 headless swiftshader 下 FPS 可能偏低（30-40），不代表真实端；**主要看相对变化**，不看绝对值
- 如果 pipeline 重跑失败（Task 6.2），停下排查，**不**盲改继续推进 Batch 2

## 不做的事（Out of scope）

- T2-*（resource-flow 合并、collect cooldown、scoreText 去 concat）
- T3-*（静态规则）
- 动 GFM 库、static-check、worker 编排逻辑
- 清理产物文件（`server-data/project-sources/*` 任其随 pipeline 重生）
