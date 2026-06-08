# 2026-05-24 storyboard2html Reference Unity Closeout

## 背景

`#storyboard2html` task #6 要把 space-ranger 的 source-ir/Blueprint 产物对标 3 个 Unity 参考工程，输出给程序员可直接打开的 Unity 工程。用户后续明确边界：

- 最终交付给程序员的是干净 Unity 工程文件。
- 不需要把 CUA / Blueprint / Luna 生成过程放进交付包。
- 不再需要 cube 占位，实体模型以后来自 storyboard2html 的模型链路。
- 脚本命名、属性命名、目录归类、场景挂载和方法注释必须系统性修复。

## 系统层提交

| commit | 作用 |
|---|---|
| `34d3233` | `scripts/export-unity-project.sh` 支持参考 Unity 程序员交付版；剥离 Luna/Playworks/本机 package 路径；生成 `Assets/Scripts` 结构。 |
| `a8e1e53` | 程序员交付版脚本归类、`GFM_` 迁移、场景脚本对象注入、移除 runtime script bootstrap、补中文方法注释。 |
| `52e7e40` | 删除 4134 行 root god class，生成 6 个独立 Manager、`PhasePreset.cs`、8 个 `Phase*.asset`，并挂入 scene Inspector list。 |
| `34a3e3a` | 恢复数据驱动 phase gate：`PhaseGate.IsReady()` 支持 `timer/resource/entity/entity_count`，`PhaseController.Tick()` 使用 `minSeconds + gate` 双条件。 |

所有提交都只改导出/清洗器/测试等系统层，没有把 v12.1 产物文件 patch 入仓。

## 最终产物

- 包：`work/storyboard2html/d40fe89e/space-ranger-reference-unity-v12.1.tar.gz`
- Slock attachment：`2d4e359c-c33e-48f6-9a58-e9017d9119e3`
- Unity 版本：2022.3.14f1c1 batchmode 验证
- 程序员打开路径：Unity Hub Add 解压目录，打开 `Assets/Scenes/Game.unity`

## 最终结构红线

- `partial class = 0`
- `.Part*.cs = 0`
- `*Runtime.cs / *Facade.cs = 0`
- root `MainManager.cs` god class 删除，`MainManager.cs` 仅 46 行
- `Assets/Scripts/Manager/` 下 6 个独立 Manager：
  - `MainManager`
  - `PhaseController`
  - `EntityBindingManager`
  - `AutoPlayDriver`
  - `HudController`
  - `EventRuleEngine`
- `Assets/Scripts/Common/PhasePreset.cs`
- `Assets/Phases/Phase1.asset` 到 `Phase8.asset`
- `PhaseController.phases` Inspector List 引用 8 个 Phase asset
- 最大 C# 文件 293 行，全部小于 500 行
- `GFM_` 残留为 0，脚本统一 `GMP_`，业务字段统一 `_camelCase`
- 业务脚本对象场景挂载，不通过 runtime bootstrap 创建
- CUA / Blueprint / Luna 过程资产不进入程序员交付包

## Phase Gate 数据

v12 首版把 phase 推进退化成 timer-only。v12.1 按用户选择的路线 B 恢复数据驱动 gate，并从原 `Phase_*_GateReady()` / `EndGame_GateReady()` 反推出每个 asset 的 gate：

| phase | gate.kind | gate.target | threshold |
|---|---|---|---:|
| Phase1 | entity | `_gold` | 2 |
| Phase2 | entity | `_ice` | 2 |
| Phase3 | entity | `_baseOne` | 2 |
| Phase4 | entity | `_drillPad` | 2 |
| Phase5 | entity | `_scrap` | 2 |
| Phase6 | entity | `_gunPad` | 2 |
| Phase7 | entity | `_scrap` | 2 |
| Phase8 | entity | `_ctaButton` | 2 |

`PhaseController.Tick()` 必须同时满足：

1. `dwellReady`：普通模式至少 `preset.minSeconds`，AutoPlay 强制 12 秒。
2. `gateReady`：`preset.gate.IsReady(...)` 返回 true。

## 验证记录

代码测试：

```bash
node --check lib/programmer-delivery-cleaner.cjs
node test/programmer-delivery-cleaner.test.cjs
node test/phase-gate-logic.test.cjs
node test/export-unity-project-bootstrap.test.cjs
git diff --check -- lib/programmer-delivery-cleaner.cjs test/programmer-delivery-cleaner.test.cjs test/phase-gate-logic.test.cjs
```

Unity 验证：

```text
Unity 2022.3.14 batchmode
error CS: 0
warning CS: 0
Batchmode quit successfully invoked: 1
Exiting batchmode successfully: 1
```

确定性：

```bash
diff -q /tmp/space-ranger-v12_1-check/Assets/Scenes/Game.unity /tmp/space-ranger-v12_1b-check/Assets/Scenes/Game.unity
diff -qr /tmp/space-ranger-v12_1-check/Assets/Phases /tmp/space-ranger-v12_1b-check/Assets/Phases
```

两条 diff 均无输出。

CUA 边界：

- 内部 Luna/WebGL baseline CUA：phase `8/8`，signal `43/43`，exit=`game_ended`，visual changed `13/18`，`max_frozen_streak=2`。
- 该结果只作为内部信心证据，不进入程序员 Unity 交付包，也不要求程序员了解 CUA。

## 部署

2026-05-24 已重启：

- `blueprint-editor`
- `linux-worker-1` 到 `linux-worker-6`

健康检查：

- `http://127.0.0.1:3901/api/dashboard/api-health` 返回 server ok，Claude/Doubao/GPT preflight ok。
- `http://127.0.0.1:18860/health` 返回 `{"ok":true,"service":"linux-build-api"}`。

## 回归 Playbook

未来如果程序员 Unity 交付包回潮，先在导出结果上跑这些 grep：

```bash
rg -n "partial class|\\.Part|Runtime|Facade" Assets/Scripts -g '*.cs'
rg -n "\\bGFM_" Assets/Scripts -g '*.cs'
rg -n "void\\s+Spawn[A-Z][A-Za-z]+\\s*\\(" Assets/Scripts -g '*.cs'
rg -n "switch \\(kind\\)|preset\\.gate\\.IsReady|GetActiveCount" Assets/Scripts -g '*.cs'
rg -n "kind: \"\"" Assets/Phases/Phase*.asset
```

期望：

- 前三条无业务回潮命中。
- 第四条能看到 `PhaseGate` / `PhaseController` / `EntityBindingManager`。
- 第五条不能在所有 Phase asset 上全空；space-ranger v12.1 为 8/8 非空 entity gate。
