# 2026-05-05: spawner 模板命名漂移把 fix-loop 烧光 ChatGPT 周配额 40%

## 时间线

| 时刻 | 事件 |
|---|---|
| 2026-04-16 | commit `3ac4033` "add 5 NPC behavior templates"，spawner.cjs 引入 `Update<entity>Spawner` 命名约定（其他 4 个模板都是 `Update<entity>`），无 spawner 测试用例 |
| 2026-05-03 ~ 2026-05-05 | task `proj_1777128165822_6acnqx`（GarbageSpawner entity）跑 4 次都报 `npc-method-missing-def: NPC GarbageSpawner has no \`void UpdateGarbageSpawner(...)\` definition` |
| 2026-05-05 08:50 | linux-worker-1 重启，从 stale checkpoint 恢复 6acnqx，进入 fix-loop |
| 2026-05-05 08:54 | codex sqlite 日志 spike 110 条/5min（其他时段 23-29），用户开始感知配额异常 |
| 2026-05-05 09:08 | 用户报"不到 20 分钟把周 40% 额度跑没了" |
| 2026-05-05 09:09 ~ 09:34 | 调研 + 止血（pm2 stop worker-3 + monitor-loop） |
| 2026-05-05 09:34 | commit `c9110cf` push（spawner 命名修复 + Case 18） |
| 2026-05-05 09:34 | worker-3 isolated 重新 pull 6acnqx，走 codegen-schema/claude-print 路径 |
| 2026-05-05 09:42 | commit `7881be2` push（normalizeFingerprint 剥 [Linux] Error wrapper） |

## 根因 4 层

### L1 模板命名漂移（spawner.cjs）

```js
// before:
function generateUpdate(npc) {
  return '        Update' + npc.entity + 'Spawner(Time.deltaTime);';
}
function generateSystem(npc) {
  // ...
  lines.push('    void Update' + npc.entity + 'Spawner(float dt) {');
  // ...
}

// after:
function generateUpdate(npc) {
  return '        Update' + npc.entity + '(Time.deltaTime);';
}
function generateSystem(npc) {
  // ...
  lines.push('    void Update' + npc.entity + '(float dt) {');
  // ...
}
```

11 个 NPC 模板里 spawner 是唯一一个用 `Update<entity>Spawner` 命名的。对 entity=`GarbageSpawner`，模板生成 `void UpdateGarbageSpawnerSpawner(float dt)`，validator 找的是 `void UpdateGarbageSpawner(float dt)`。

### L2 validator regex 对齐失败（template-output-validator.cjs:85）

```js
var defRe = new RegExp('void\\s+Update' + entity + '\\s*\\(');
```

正则是 `/void\s+UpdateGarbageSpawner\s*\(/`。在 `void UpdateGarbageSpawnerSpawner(` 中 `\s*\(` 必须匹配 `Spawner(`，但 `\s*` 只匹配空白，匹配失败。

### L3 method-check AUTO-REPAIR 误判 PASS

method-check 看到 critical 后调 AUTO-REPAIR 注入空 `// [ASSEMBLY SLOT]` marker → `PASS — all called methods are defined or safe` → codex code agent 来填 SLOT 但不知道命名约定 → 填错 → 编译/CUA 仍失败 → fix-loop 内 3 轮 abort。

### L4 outer-retry fp dedup 失效（metrics.cjs:normalizeFingerprint）

```js
// 6acnqx 真实 outerFpHistory（before fix）:
[
  '[Linux] Error: [review] review aborted: same CODE error repeated N rounds, fix-loop not converging: ',
  '[Linux] Error: [cua-verify] cua-verify aborted: same CODE error repeated N rounds, fix-loop not conv',
  '[Linux] Error: [cua-verify] cua-verify aborted: same CODE error repeated N rounds, fix-loop not conv',
  '[Linux] Error: [codegen] Schema generation failed: Timed out after 900000ms; Exit code N',
]
```

`normalizeFingerprint` 的 stage prefix strip（line 278）只剥裸前缀如 `^review`，不剥 `[Linux] Error: [review] `。结果 4 条 fp 各自 unique，`task-queue.cjs:276-279` 的 `_repeatCount = 0; for (i hist.length-1 → 0) { if (hist[i] === current) ++; else break; }` 从尾往前数连续匹配数永远 = 1，`OUTER_RETRY_FP_FATAL_AT=2` 永不 fire。

每个 outer retry 烧 ~3 inner × 405 s codex call = 20 min；5 outer = 100 min codex 时间 = 周配额 40%。

## 修复

| commit | 文件 | 改动 |
|---|---|---|
| `c9110cf` | `adapters/templates/npc-behaviors/spawner.cjs` | 第 17/25 行去 `Spawner` 后缀 |
| `c9110cf` | `test/template-output-validator.test.cjs` | 加 Case 18，喂真实 GarbageSpawner spec 锁命名契约 |
| `7881be2` | `engine/metrics.cjs` | `normalizeFingerprint` 顶部加 `s.replace(/^\[(?:Linux|Windows|MacOS|Worker)\]\s*Error\s*:\s*\[[a-z0-9-]+\]\s*/i, '')` |
| `7881be2` | `test/normalize-fingerprint.test.cjs` | 加 Case J 覆盖 wrapper strip + 跨 host collapse |

止血操作（无 commit）：

```bash
pm2 stop linux-worker-2 linux-worker-3 blueprint-monitor-loop
pm2 stop linux-worker-1 linux-worker-4 linux-worker-5 linux-worker-6  # 隔离观察
mv /opt/blueprint-editor/server-data/checkpoints/proj_1777128165822_6acnqx \
   /opt/blueprint-editor/server-data/checkpoints/_archived_proj_1777128165822_6acnqx_20260505
sqlite3 /opt/blueprint-editor/server-data/blueprint.db \
  "UPDATE tasks SET status='pending', assigned_to=NULL, code_retry_count=0, infra_retry_count=0, fail_count=0, retry_after=NULL WHERE id='proj_1777128165822_6acnqx';"
pm2 start linux-worker-3
```

跑通后再 `pm2 start linux-worker-1 linux-worker-2 linux-worker-4 linux-worker-5 linux-worker-6 blueprint-monitor-loop`。

## 验证

- `npm test` `pass=285 fail=1`，1 个 fail 是 pre-existing `codegen-schema-trigger-repair` 与本次无关。
- spawner 模板独立调用对 `{entity:'GarbageSpawner', template:'spawner', params:{spawnEntity:'SpaceGarbage', spawnInterval:2, maxAlive:20, spawnRadius:4}}` 输出 `void UpdateGarbageSpawner(float dt)`（单 Spawner）。
- normalizeFingerprint 对真实 outerFpHistory 4 条 verify [1]==[2]（cua-verify×2 collapse），[0] 与 [1] 仍区分（review vs cua-verify 根因不同，合理）。
- worker-3 isolated pull 6acnqx → codegen-schema 走 claude-print backend（无 codex burn）。

## 教训

1. **模板命名约定属于 contract** — 加新 NPC 模板必须配 validator-driven 测试用例（喂原始 npc spec 进 validator），否则命名漂移沉默到生产以 fix-loop 形式爆发。spawner bug 自 `3ac4033` 引入 20 天零测试覆盖。
2. **fingerprint dedup 必须对 message wrapper 不变** — worker → server 上报错误会包 `[Linux] Error: [<stage>]`，normalize 漏剥这层就让所有同根因变不同 fp。动 normalize 必须配套 wrapper 变体测试。
3. **fix-loop 不收敛事件下次先查 normalize 漏洞** — 现有 cap 已多层（fix-loop `sameErrorThreshold=3` + outer fp dedup at 2 + `MAX_CODE_RETRIES=5`），任一层 normalize 漏洞就让所有 cap 失效。配额是关键资源。
4. **checkpoint 是缓存不是 source of truth** — task 从 codegen 之后的 checkpoint 恢复时不会用新模板代码。修 template/skeleton/template-engine 后强制清相关 task checkpoint 才能验证根因。

## 关联记忆

- `project_codex_effort_and_backend_switch.md` — 5/2 把 caller effort 全降 high + codegen-schema primary 切 claude-print 的部分前修
- `project_spawner_naming_quota_burn_2026-05-05.md` — 本次根因 + 修复 memory
- `feedback_commit_push_after_root_cause_fix.md` — 根因修完当轮 commit + push 的 feedback
- `project_deploy_ecs_restart_gap.md` — adapters/lib *.cjs 改动需要手动 `pm2 restart` 让 require cache 失效
