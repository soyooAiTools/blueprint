# Codegen Performance Batch 3 — 静态规则防回归实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Batch 1 已经清理干净的性能 anti-pattern 锁进 `engine/static-check.cjs`，防止后续 AI 改动或新模板再次污染 Update hot path。

**Architecture:** 在 `engine/static-check.cjs` 的 `RULES` 数组里追加 3 条规则，全部走现有 `custom` 函数接口（需要精确定位 Update 方法体，单纯正则做不到）。T3-1 blocking（codegen 阶段返工），T3-2/T3-3 non-blocking warn（注入 fix-loop feedback）。测试补到 `test/static-check.test.cjs`。

**Tech Stack:** Node.js, 现成 regex + `buildCodeMask`（注释/字符串排除）+ brace-depth walker（定位函数体，参考已有 `autoplay-interact-empty` 规则 L105）。

---

## 前置：Batch 1 清理验证

Batch 3 的 T3-1 blocking 规则依赖 Batch 1 已经移除 skeleton 自己的 `new Vector3`。开始前必须在 HEAD 跑一次 skeleton 生成，确认 Update/MovePlayer hot path 零 `new Vector3`。

- [ ] **Step 0-1: 用真实 specs 生成 skeleton，grep Update 方法体**

用已验证的 xrbkl1 specs（和 Batch 1 最终验证相同）：

```bash
cd /opt/blueprint-editor && node -e "
var g = require('./adapters/skeleton-generator.cjs');
var specs = JSON.parse(require('fs').readFileSync('spec-data/proj_1776297105366_xrbkl1/specs.json','utf8'));
var blueprint = JSON.parse(require('fs').readFileSync('server-data/projects/proj_1776297105366_xrbkl1.json','utf8')).blueprint;
var out = g.generateSkeleton(specs, blueprint);
require('fs').writeFileSync('/tmp/batch3-skeleton.cs', out.main);
"
```

Expected: 文件写入成功，无异常。

- [ ] **Step 0-2: 统计 skeleton 产物的 new Vector 热点命中**

```bash
cd /opt/blueprint-editor && node -e "
var fs = require('fs');
var src = fs.readFileSync('/tmp/batch3-skeleton.cs','utf8');
// 定位 Update()、MovePlayer()、CheckEventRules() 的方法体
['Update','MovePlayer','CheckEventRules','AutoPlayUpdate'].forEach(function(fn){
  var re = new RegExp('void\\\\s+' + fn + '\\\\s*\\\\([^)]*\\\\)\\\\s*\\\\{','');
  var m = src.match(re);
  if (!m) { console.log(fn, 'NOT_FOUND'); return; }
  var start = m.index + m[0].length, depth = 1, end = start;
  while (end < src.length && depth > 0) {
    if (src[end] === '{') depth++;
    else if (src[end] === '}') { depth--; if (depth === 0) break; }
    end++;
  }
  var body = src.substring(start, end);
  var hits = (body.match(/new\\s+Vector3\\s*\\(/g) || []).length;
  console.log(fn, 'new Vector3 count:', hits);
});
"
```

Expected 输出（如果不是，Batch 3 不能开始，回到 Batch 1 补漏）：
```
Update new Vector3 count: 0
MovePlayer new Vector3 count: 0
CheckEventRules new Vector3 count: 0
AutoPlayUpdate (可能 NOT_FOUND 或 0)
```

如果任一 > 0：停止 Batch 3，把泄漏的 `new Vector3` 拉回 Batch 1 整治。

---

## 文件结构

### 修改文件

- `engine/static-check.cjs` — 在 `RULES` 数组追加 3 条规则（insert 点：v7 段末尾 L344 之后，保持版本注释序号延续为 v8）
- `test/static-check.test.cjs` — 追加对应 3 组测试（至少 6 个 test case：positive + negative）
- `docs/superpowers/specs/2026-04-19-codegen-performance-optimization-design.md` — Batch 3 完成后更新 Status 行

### 不修改

- `worker/fix-recipes.json` — T3-2/T3-3 是 warn 级，通过 fix-loop feedback 注入，不需要 recipe
- `engine/stages/*.cjs` — 现有 static-check 在 `codegen.cjs` 和 `review.cjs` 都已接入，blocking 自动返工

---

## Task 1: T3-1 blocking 规则 `update-new-vector-in-hot-path`

**Files:**
- Modify: `engine/static-check.cjs` (追加到 RULES 数组，L344 之后)
- Test: `test/static-check.test.cjs`

**规则设计：**
- 扫描范围：`Update()` / `MovePlayer()` / `CheckEventRules()` / `AutoPlayUpdate()` 4 个方法体
- 定位方式：复用 `autoplay-interact-empty` 规则（L105）的 brace-depth walker
- 命中模式：`/\bnew\s+Vector3\s*\(/g`
- 豁免：仅豁免 `new Vector3(0` 开头的零向量初始化（罕见，非热点），**不**豁免任何正常坐标构造
- blocking=true（codegen 返工）

- [ ] **Step 1-1: 写 failing test（positive：Update 里 new Vector3 被捕获）**

在 `test/static-check.test.cjs` 文件尾（`});` 结束行之前）追加：

```javascript
  // --- v8: Performance hot-path rules (Batch 3) ---

  test('new Vector3 in Update() detected as blocking', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void Update() {
    transform.position = new Vector3(1, 2, 3);
  }
}`;
    const result = staticCheck(code);
    const hit = result.issues.find(i => i.rule === 'update-new-vector-in-hot-path');
    expect(hit).toBeDefined();
    expect(hit.blocking).toBe(true);
    expect(hit.line).toBe(4);
  });
```

- [ ] **Step 1-2: 运行 test 确认 fail**

```bash
cd /opt/blueprint-editor && npx jest test/static-check.test.cjs -t "new Vector3 in Update" --no-coverage
```

Expected: FAIL — `hit` 是 `undefined`（规则还没实现）。

- [ ] **Step 1-3: 实现规则**

在 `engine/static-check.cjs` L344（`{ id: 'scene-buildindex', ... },` 之后、`];` 之前）追加：

```javascript
  // --- v8: Performance hot-path rules (Batch 3, 2026-04-19) ---
  // Batch 1 cleaned skeleton's own hot paths; this rule prevents AI-generated code
  // from re-introducing `new Vector3` into Update/MovePlayer/CheckEventRules/AutoPlayUpdate.
  // Each heap alloc × 60fps = measurable GC jitter in Luna's small-memory WebGL env.
  { id: 'update-new-vector-in-hot-path', pattern: null, blocking: true,
    message: 'new Vector3 in Update/MovePlayer/CheckEventRules/AutoPlayUpdate hot path — reuse a field or use struct-copy (var p = obj.transform.position; p.x = ...; obj.transform.position = p;)',
    custom: function(code) {
      var issues = [];
      var stripped = code
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/"(?:[^"\\]|\\.)*"/g, '""');
      var hotFns = ['Update', 'MovePlayer', 'CheckEventRules', 'AutoPlayUpdate'];
      for (var f = 0; f < hotFns.length; f++) {
        var fn = hotFns[f];
        var sigRe = new RegExp('\\b(?:void|IEnumerator)\\s+' + fn + '\\s*\\([^)]*\\)\\s*\\{');
        var sig = stripped.match(sigRe);
        if (!sig) continue;
        var start = sig.index + sig[0].length;
        var depth = 1, end = start;
        while (end < stripped.length && depth > 0) {
          var ch = stripped[end];
          if (ch === '{') depth++;
          else if (ch === '}') { depth--; if (depth === 0) break; }
          end++;
        }
        if (depth !== 0) continue;
        var body = stripped.substring(start, end);
        var re = /\bnew\s+Vector3\s*\(\s*([^)]*)\)/g;
        var m;
        while ((m = re.exec(body)) !== null) {
          var args = m[1].replace(/\s/g, '');
          // Allow new Vector3(0,0,0) — zero-alloc concept (rarely used, but legal)
          if (args === '0,0,0' || args === '' || args === '0') continue;
          var absIdx = start + m.index;
          var lineNum = code.substring(0, absIdx).split('\n').length;
          issues.push({ line: lineNum, text: 'new Vector3(' + m[1].trim() + ') inside ' + fn + '()' });
        }
      }
      return issues;
    },
  },
```

- [ ] **Step 1-4: 跑 positive test 确认 PASS**

```bash
cd /opt/blueprint-editor && npx jest test/static-check.test.cjs -t "new Vector3 in Update" --no-coverage
```

Expected: PASS.

- [ ] **Step 1-5: 追加 negative tests（Start 里合法、豁免零向量、字符串里忽略）**

在刚加的 test 之后追加：

```javascript
  test('new Vector3 in Start() is allowed (not a hot path)', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void Start() {
    transform.position = new Vector3(1, 2, 3);
  }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'update-new-vector-in-hot-path');
    expect(hit).toBeUndefined();
  });

  test('new Vector3(0,0,0) in Update is allowed (zero vector)', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void Update() {
    var zero = new Vector3(0,0,0);
  }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'update-new-vector-in-hot-path');
    expect(hit).toBeUndefined();
  });

  test('new Vector3 in string literal inside Update is ignored', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void Update() {
    Debug.Log("example: new Vector3(1,2,3)");
  }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'update-new-vector-in-hot-path');
    expect(hit).toBeUndefined();
  });

  test('new Vector3 in MovePlayer detected as blocking', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void MovePlayer() {
    player.transform.position = new Vector3(1, 0, 2);
  }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'update-new-vector-in-hot-path');
    expect(hit).toBeDefined();
    expect(hit.blocking).toBe(true);
  });
```

- [ ] **Step 1-6: 跑完整 jest，全绿**

```bash
cd /opt/blueprint-editor && npx jest --no-coverage
```

Expected: 88 + 4 = 92 tests passing (含 Batch 1 已有的 88 + 本 task 4 个新 case)。

- [ ] **Step 1-7: 对 Batch 1 的 HEAD skeleton 运行 staticCheck 确认零误报**

```bash
cd /opt/blueprint-editor && node -e "
var { staticCheck } = require('./engine/static-check.cjs');
var code = require('fs').readFileSync('/tmp/batch3-skeleton.cs','utf8');
var r = staticCheck(code);
var hits = r.issues.filter(i => i.rule === 'update-new-vector-in-hot-path');
console.log('Hits:', hits.length);
if (hits.length) console.log(JSON.stringify(hits, null, 2));
"
```

Expected: `Hits: 0`。如果有误报 → 规则豁免不够，先改规则再继续。

- [ ] **Step 1-8: Commit**

```bash
cd /opt/blueprint-editor && git add engine/static-check.cjs test/static-check.test.cjs && git commit -m "$(cat <<'EOF'
perf(static): T3-1 blocking — new Vector3 in Update hot path (Batch 3)

扫描 Update/MovePlayer/CheckEventRules/AutoPlayUpdate 方法体，
禁止 new Vector3(非零坐标)。豁免 Vector3(0,0,0) 零向量。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: T3-2 warn 规则 `chained-if-same-var-no-else`

**Files:**
- Modify: `engine/static-check.cjs`
- Test: `test/static-check.test.cjs`

**规则设计：**
- 检测 ≥3 个连续 `if (X == "...")`，且 X 是同一标识符，且彼此之间没有 `else` 衔接
- 匹配方式：扫 `if\s*\(\s*(\w+)\s*==\s*"[^"]*"\s*\)`，按连续出现 + 相同标识符分组
- **non-blocking**，仅 warn
- 用意：防 AI 生成长裸 if 链（phase 判定模式），鼓励 else-if

- [ ] **Step 2-1: 写 failing test**

```javascript
  test('3+ chained if (X == "...") without else detected as warn', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void Foo() {
    if (phase == "p1") { }
    if (phase == "p2") { }
    if (phase == "p3") { }
  }
}`;
    const result = staticCheck(code);
    const hit = result.issues.find(i => i.rule === 'chained-if-same-var-no-else');
    expect(hit).toBeDefined();
    expect(hit.blocking).toBeFalsy();
  });

  test('2 chained if on same var does NOT trigger (threshold is 3)', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void Foo() {
    if (phase == "p1") { }
    if (phase == "p2") { }
  }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'chained-if-same-var-no-else');
    expect(hit).toBeUndefined();
  });

  test('3 chained if but on different vars does NOT trigger', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void Foo() {
    if (a == "p1") { }
    if (b == "p2") { }
    if (c == "p3") { }
  }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'chained-if-same-var-no-else');
    expect(hit).toBeUndefined();
  });

  test('else if chain does NOT trigger', () => {
    const code = `using UnityEngine;
public class Main : MonoBehaviour {
  void Foo() {
    if (phase == "p1") { }
    else if (phase == "p2") { }
    else if (phase == "p3") { }
  }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'chained-if-same-var-no-else');
    expect(hit).toBeUndefined();
  });
```

- [ ] **Step 2-2: 确认 fail**

```bash
cd /opt/blueprint-editor && npx jest test/static-check.test.cjs -t "chained if" --no-coverage
```

Expected: 第一个 test FAIL（规则未实现）。

- [ ] **Step 2-3: 实现规则**

在 T3-1 规则后追加：

```javascript
  { id: 'chained-if-same-var-no-else', pattern: null,
    message: 'Chained if (X == "...") on same variable without else — use else-if chain or switch for performance and readability',
    custom: function(code) {
      var issues = [];
      var stripped = code
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/"(?:[^"\\]|\\.)*"/g, '""');
      // Scan for bare "if (X == Y)" patterns with preceding non-else context
      // Strategy: match all "if (ident == ...)" and group by same-ident consecutive runs
      // where "consecutive" means no `else` token between them.
      var re = /(\belse\s+)?\bif\s*\(\s*(\w+)\s*==\s*""/g;
      var m, runs = [], cur = null;
      while ((m = re.exec(stripped)) !== null) {
        var hasElse = !!m[1];
        var ident = m[2];
        if (hasElse) { cur = null; continue; }
        if (cur && cur.ident === ident) {
          cur.count++;
          cur.lastIdx = m.index;
        } else {
          cur = { ident: ident, count: 1, firstIdx: m.index, lastIdx: m.index };
          runs.push(cur);
        }
      }
      for (var i = 0; i < runs.length; i++) {
        if (runs[i].count >= 3) {
          var lineNum = code.substring(0, runs[i].firstIdx).split('\n').length;
          issues.push({ line: lineNum, text: runs[i].count + ' consecutive bare "if (' + runs[i].ident + ' == ...)" — use else-if' });
        }
      }
      return issues;
    },
  },
```

- [ ] **Step 2-4: 跑 4 个 test 全绿**

```bash
cd /opt/blueprint-editor && npx jest test/static-check.test.cjs -t "chained if\|else if chain" --no-coverage
```

Expected: 4 PASS.

- [ ] **Step 2-5: 对 HEAD skeleton 确认零误报**

```bash
cd /opt/blueprint-editor && node -e "
var { staticCheck } = require('./engine/static-check.cjs');
var code = require('fs').readFileSync('/tmp/batch3-skeleton.cs','utf8');
var hits = staticCheck(code).issues.filter(i => i.rule === 'chained-if-same-var-no-else');
console.log('Hits:', hits.length);
hits.slice(0,3).forEach(h => console.log('  L' + h.line + ': ' + h.text));
"
```

Expected: `Hits: 0`。

**重要**：skeleton L591 的 pre-codegen TODO_AUTOPLAY_INTERACT stub 包含 bare if 链（Batch 1 final validation 已确认），会被 autoplay-mirror 的 else-if 版本覆盖。但 staticCheck 跑在**最终产物**上（经过 codegen），不跑在 skeleton 输出上。上面这个命令跑在 skeleton 直出的 `/tmp/batch3-skeleton.cs`，**如果 stub 触发规则，证明规则只看当前上下文**——这是期望的，因为 stub 本来就是要被 codegen 覆盖掉。

如果命中 >0，且命中行号落在 `TODO_AUTOPLAY_INTERACT_START/END` 区间：属于预期（skeleton 直出不代表实际产物），记录但不改规则。可以加注释说明检测范围为"最终产物（codegen 之后）"。

- [ ] **Step 2-6: Commit**

```bash
cd /opt/blueprint-editor && git add engine/static-check.cjs test/static-check.test.cjs && git commit -m "$(cat <<'EOF'
perf(static): T3-2 warn — chained if on same var without else (Batch 3)

≥3 连 if (X == "...") 同标识符无 else 衔接 → warn。
防 AI 学坏样板写长裸 if 链,引导 else-if/switch。
non-blocking: 注入 fix-loop feedback, 不返工。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: T3-3 warn 规则 `string-concat-in-update`

**Files:**
- Modify: `engine/static-check.cjs`
- Test: `test/static-check.test.cjs`

**规则设计：**
- 扫 Update 方法体（复用 T3-1 的 walker）
- 匹配 `\.text\s*=\s*(?:"[^"]*"|\w+)\s*\+` 模式（`.text = "xxx" +` 或 `.text = var +`）
- **non-blocking** warn
- 用意：score/counter 之类的 UI 文本在每帧拼接 → Luna/Bridge 下产生临时 string 对象。引导"仅数值变化时赋值"。

- [ ] **Step 3-1: 写 failing test**

```javascript
  test('string concat with .text= in Update detected as warn', () => {
    const code = `using UnityEngine;
using UnityEngine.UI;
public class Main : MonoBehaviour {
  public Text scoreText;
  int score;
  void Update() {
    scoreText.text = "Score: " + score;
  }
}`;
    const result = staticCheck(code);
    const hit = result.issues.find(i => i.rule === 'string-concat-in-update');
    expect(hit).toBeDefined();
    expect(hit.blocking).toBeFalsy();
  });

  test('.text= literal only (no concat) in Update is allowed', () => {
    const code = `using UnityEngine;
using UnityEngine.UI;
public class Main : MonoBehaviour {
  public Text scoreText;
  void Update() {
    scoreText.text = "Hello";
  }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'string-concat-in-update');
    expect(hit).toBeUndefined();
  });

  test('.text= concat in Start is allowed (not a hot path)', () => {
    const code = `using UnityEngine;
using UnityEngine.UI;
public class Main : MonoBehaviour {
  public Text scoreText;
  void Start() {
    scoreText.text = "Score: " + 0;
  }
}`;
    const hit = staticCheck(code).issues.find(i => i.rule === 'string-concat-in-update');
    expect(hit).toBeUndefined();
  });
```

- [ ] **Step 3-2: 确认 fail**

```bash
cd /opt/blueprint-editor && npx jest test/static-check.test.cjs -t "string concat" --no-coverage
```

Expected: 第一个 FAIL.

- [ ] **Step 3-3: 实现规则**

在 T3-2 之后追加：

```javascript
  { id: 'string-concat-in-update', pattern: null,
    message: '.text string concatenation in Update hot path — assign only when value changes (if (_last != n) { text = "Score: " + n; _last = n; })',
    custom: function(code) {
      var issues = [];
      var stripped = code
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/"(?:[^"\\]|\\.)*"/g, '""');
      var hotFns = ['Update', 'MovePlayer', 'CheckEventRules', 'AutoPlayUpdate'];
      for (var f = 0; f < hotFns.length; f++) {
        var fn = hotFns[f];
        var sigRe = new RegExp('\\b(?:void|IEnumerator)\\s+' + fn + '\\s*\\([^)]*\\)\\s*\\{');
        var sig = stripped.match(sigRe);
        if (!sig) continue;
        var start = sig.index + sig[0].length;
        var depth = 1, end = start;
        while (end < stripped.length && depth > 0) {
          var ch = stripped[end];
          if (ch === '{') depth++;
          else if (ch === '}') { depth--; if (depth === 0) break; }
          end++;
        }
        if (depth !== 0) continue;
        var body = stripped.substring(start, end);
        // Match: .text = "..." + OR .text = var + OR .text = X + Y
        var re = /\.text\s*=\s*(?:""|\w+)\s*\+/g;
        var m;
        while ((m = re.exec(body)) !== null) {
          var absIdx = start + m.index;
          var lineNum = code.substring(0, absIdx).split('\n').length;
          var lineText = code.split('\n')[lineNum - 1] || '';
          issues.push({ line: lineNum, text: lineText.trim().slice(0, 120) });
        }
      }
      return issues;
    },
  },
```

- [ ] **Step 3-4: 跑 3 个 test 全绿**

```bash
cd /opt/blueprint-editor && npx jest test/static-check.test.cjs -t "string concat\|\\.text= literal\|\\.text= concat in Start" --no-coverage
```

Expected: 3 PASS.

- [ ] **Step 3-5: 对 HEAD skeleton 确认零误报**

```bash
cd /opt/blueprint-editor && node -e "
var { staticCheck } = require('./engine/static-check.cjs');
var code = require('fs').readFileSync('/tmp/batch3-skeleton.cs','utf8');
var hits = staticCheck(code).issues.filter(i => i.rule === 'string-concat-in-update');
console.log('Hits:', hits.length);
hits.forEach(h => console.log('  L' + h.line + ': ' + h.text));
"
```

Expected: `Hits: 0`。如果命中 > 0 → skeleton 的 scoreText 更新逻辑自己有这个问题（Batch 2 T2-2 要解决的），**当前不 block**，记录 warn 但继续。因为是 non-blocking。

- [ ] **Step 3-6: Commit**

```bash
cd /opt/blueprint-editor && git add engine/static-check.cjs test/static-check.test.cjs && git commit -m "$(cat <<'EOF'
perf(static): T3-3 warn — string concat on .text in Update (Batch 3)

Update/MovePlayer/CheckEventRules 方法体内检测 .text = ... + ... 模式,
warn 级提示"仅数值变化时赋值"。Luna/Bridge.NET 下临时 string 对象
会加剧 GC。non-blocking: 注入 fix-loop feedback 引导。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: 全量回归 + 总计数验证

**Files:**
- Verify only, no edits

- [ ] **Step 4-1: 全量 jest**

```bash
cd /opt/blueprint-editor && npx jest --no-coverage 2>&1 | tail -5
```

Expected: `Tests: 99 passed, 99 total`（Batch 1 的 88 + Task1 的 4 + Task2 的 4 + Task3 的 3 = 99）

- [ ] **Step 4-2: 确认 RULES 数量**

```bash
cd /opt/blueprint-editor && node -e "console.log('RULES:', require('./engine/static-check.cjs').RULES.length)"
```

Expected: `RULES: 62`（原 59 + 3）。

- [ ] **Step 4-3: 更新 test 里的最小数量 assertion**

test/static-check.test.cjs L4 `toBeGreaterThanOrEqual(59)` 改为 `toBeGreaterThanOrEqual(62)`：

```bash
cd /opt/blueprint-editor && node -e "
var fs = require('fs');
var f = 'test/static-check.test.cjs';
var c = fs.readFileSync(f, 'utf8');
c = c.replace('toBeGreaterThanOrEqual(59)', 'toBeGreaterThanOrEqual(62)');
fs.writeFileSync(f, c);
"
cd /opt/blueprint-editor && npx jest test/static-check.test.cjs -t "RULES array" --no-coverage
```

Expected: PASS.

- [ ] **Step 4-4: 跑 HEAD skeleton 总命中报告**

```bash
cd /opt/blueprint-editor && node -e "
var { staticCheck } = require('./engine/static-check.cjs');
var code = require('fs').readFileSync('/tmp/batch3-skeleton.cs','utf8');
var r = staticCheck(code);
var batch3 = ['update-new-vector-in-hot-path','chained-if-same-var-no-else','string-concat-in-update'];
batch3.forEach(function(id){
  var hits = r.issues.filter(i => i.rule === id);
  var blocking = hits.filter(h => h.blocking).length;
  console.log(id, 'total:', hits.length, 'blocking:', blocking);
});
"
```

Expected:
- `update-new-vector-in-hot-path total: 0 blocking: 0` （Batch 1 已清）
- `chained-if-same-var-no-else total: ?` （stub 可能命中，但不 block）
- `string-concat-in-update total: ?` （skeleton 的 scoreText 逻辑可能命中，warn）

**验收关键**：`update-new-vector-in-hot-path blocking: 0`。其余两条 warn 可以 > 0，因为 non-blocking 只是给 fix-loop 注 feedback，不会让 codegen 返工。

- [ ] **Step 4-5: Commit 最终的 assertion 修正**

```bash
cd /opt/blueprint-editor && git add test/static-check.test.cjs && git commit -m "$(cat <<'EOF'
test(static): RULES count assertion 59 → 62 (Batch 3 收尾)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: 更新 design doc + 写 Batch 3 报告

**Files:**
- Modify: `docs/superpowers/specs/2026-04-19-codegen-performance-optimization-design.md` (Status 行)
- Create: `docs/superpowers/specs/2026-04-19-perf-batch3-report.md`

- [ ] **Step 5-1: 更新 design doc status 行**

把 L4 `**Status**: ✅ Approved (2026-04-19) — 执行 Batch 1` 改为：
`**Status**: ✅ Approved — Batch 1 + Batch 3 已落地 (2026-04-19)，Batch 2 待健康项目做 CUA 对照`

- [ ] **Step 5-2: 写 Batch 3 报告**

`docs/superpowers/specs/2026-04-19-perf-batch3-report.md`，模板参考 `2026-04-19-perf-batch1-report.md`。内容：
- 3 个 commit hash
- 4+4+3+1=12 个新 test case 全通过
- RULES 数量 59 → 62
- 对 HEAD skeleton staticCheck 的命中报告（T3-1 blocking=0 证明 Batch 1 清理到位）
- 下一步建议：进 Batch 2 或维持现状

- [ ] **Step 5-3: Commit**

```bash
cd /opt/blueprint-editor && git add docs/superpowers/specs/2026-04-19-codegen-performance-optimization-design.md docs/superpowers/specs/2026-04-19-perf-batch3-report.md && git commit -m "$(cat <<'EOF'
docs(perf): Batch 3 实施报告 — 3条静态规则落地锁住 Batch 1 收益

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## 完成判据

- [ ] Jest 99/99 全绿
- [ ] RULES 数量 62
- [ ] HEAD skeleton 上 `update-new-vector-in-hot-path` 命中 0（blocking，必须 0）
- [ ] 5 次独立 commit（T3-1 / T3-2 / T3-3 / assertion 修正 / 报告）
- [ ] Design doc + Batch 3 报告写好

## 风险 & 回滚

- T3-1 blocking 在 skeleton 已清的前提下零误报，但如果有我们没覆盖的模板分支偷偷 new Vector3 → 会让新项目 codegen 返工。回滚：把 T3-1 的 `blocking: true` 改成 `blocking: false` 即可（git revert 也行）。
- T3-2/T3-3 warn 级不会阻断 pipeline，只进 fix-loop feedback。出问题概率低。
- 每个 task 独立 commit，可单独 revert。
