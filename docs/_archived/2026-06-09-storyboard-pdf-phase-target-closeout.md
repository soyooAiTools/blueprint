# 2026-06-09 Storyboard PDF Phase Target Closeout

## 背景

用户连续反馈三类问题：

- runtime phase 数量必须强制落在 10-13 个，不能出现 34 个，也不能只有 6 个。
- phase 内实体数量应由分镜决定，但连续 phase 不能共享同一个主 gameplay target；不连续 phase 是否复用要看分镜语义。
- `搜屋取暖` 被我误判已经修好，但用户复测仍看到连续 phase 目标语义重复。

本次重点样本：`取木射箭`、`搜屋取暖`、第三个 PDF 样本的 HTML/WebGL 批处理产物。

## 根因

1. PDF layout 文本顺序不是可靠 phase 顺序。`搜屋取暖` 的 phase marker 和正文在抽取文本中交错，generic `phase-marker + runtime phase expand` 把相邻行的 `攻击/丧尸/火堆/电塔` 等词泄漏进同一段，推断出错误 interaction。
2. 之前的修复只把连续重复目标改成 `Campfire__phase01_target`、`PowerTower__phase06_target` 这类技术 anchor。它让 SourceIR/WebGL 目标 id 不再相同，但没有修正上游 frame/spec 语义，所以属于假通过。
3. SourceIR liveness 原本只检查 gate 可达性，没有阻止连续 phase 共享同一个 primary gameplay target。视觉上看就是 phase 5/6 或 phase 7/8 在追同一个目标。
4. `取木射箭` 的 phase 跳跃不是同一根因。它来自 SourceIR preview 里拖拽移动时 `pointermove` 被当作新输入，进入下一 phase 后仍满足同一个到达条件，于是 phase 5 直接过到 7、7 直接过到 9。

## 修复

- `scripts/process-storyboard-pdf-samples.cjs`
  - 强制 PDF runtime phase cap 为 10-13。过多分镜会合并，过少会按可观察动作扩展。
  - 新增 profile rules，并对 `shelter_warmth` 走 profile parser，不再依赖 generic phase marker。
  - `搜屋取暖` 重建 10 个语义 phase：`Campfire -> WoodPile -> ShelterRoom -> Enemy -> WoodPile -> PowerTower -> KeyItem -> Battery -> PowerTower -> CtaButton`。
  - `shelter_warmth` 资源补 `Key` 和 `Battery`，避免 key/battery 被压回同一个旧目标。
- `engine/source-ir-phase-liveness.cjs`
  - 新增 `source_ir_consecutive_phase_target_shared` violation，阻止连续 phase 共享同一个主 gameplay target。
- `engine/source-scene-ir.cjs`
  - 对 generic 场景保留 phase target anchor materialization 作为兜底，但只能用于语义已确认的目标分拆，不能替代 parser 修复。
- `engine/source-ir-preview-renderer.cjs`
  - 只把 `pointerdown` 计作 fresh input。进入新 phase 后重置 input baseline，拖拽中的 `pointermove` 不再自动完成下一 phase。

## 验证

```bash
node test/storyboard-pdf-generic-parser.test.cjs
node test/source-scene-ir.test.cjs
node test/source-ir-phase-liveness.test.cjs
node test/source-ir-compiler.test.cjs
node test/source-ir-preview-renderer.test.cjs
node test/guard-visual-fallback.test.cjs
node test/storyboard-webgl-visual-diff-script.test.cjs
node test/source-ir-proof-bundle.test.cjs
node test/skeleton-phase-gate-strictness.test.cjs
git diff --check
```

三项目重新输出 HTML 和 WebGL，并打包：

- `/nickTemp/three-projects-html-webgl-20260609-155814-semantic-targets.zip`
- SHA256: `6cf7731c99f130a0173538cce45b49d177b49b6eb61d943f744fd2ecbcf95a05`

`搜屋取暖` 的 delivery 与 webgl-build 中不再出现旧的 `Campfire__phase*` / `PowerTower__phase*` 假 anchor；目标序列由 frame/spec 语义直接产出。

## 教训

- 判断“连续 phase 目标已修复”不能只看 id 是否唯一，必须同时审 `storyboard-ir.json`、`specs.json`、`source-scene-ir.json`、HTML runtime target 和 WebGL target。
- PDF 分镜遇到版式交错时，generic phase marker 是风险入口。能识别 profile 的样本优先写 deterministic parser/rules，并把新规则补进 profile rules。
- 连续 phase 共享主目标默认是 hard fail；不连续复用可以成立，但必须能从分镜动作语义解释。
- phase 数量和 phase 目标是两个不同约束：10-13 控制 runtime phase 数量，phase 内实体数量和目标实体选择必须来自分镜。
