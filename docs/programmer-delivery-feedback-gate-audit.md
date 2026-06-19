# 程序员交付反馈规则与门禁对照

更新时间：2026-06-19

这份文档用于防止“反馈只写进 prompt，但最终交付没有机器验收”的问题。

## 已有硬门禁

- `Core` / `Tool` / `Game` 三层目录：`programmer-delivery-hardgate.cjs`
- `GameObject.Find` / `FindObjectOfType` / `.AddComponent(...)` / `new GameObject(...)`：`programmer-delivery-maintainability-gate.cjs`
- 空壳实体类：`programmer-delivery-maintainability-gate.cjs`
- Core 层硬编码项目实体名分支：`programmer-delivery-maintainability-gate.cjs`
- Missing Mono Script、脚本 GUID、逻辑/表现分离：`programmer-delivery-hydration-report.cjs` + AIBridge/MCP hydration
- `GMP_PhaseStep.mSetState` 使用 enum：`programmer-delivery-hardgate.cjs`

## 本次补齐

- 未调用方法：strict maintainability 阻断 `unused-methods`
- `Vector3.Distance` 门槛：strict maintainability 阻断 `vector3-distance-threshold`
- 静态 `Init/Get/Return/ReturnAfter` 工作流方法：strict maintainability 阻断 `static-workflow-methods`
- 重复状态 owner：strict maintainability 阻断 `duplicate-state-owners`，覆盖 Player 速度、Movement 默认速度、Gold 镜像、目标提示多处写入
- summary 与真实文件不一致：hardgate 阻断“summary 说已删除但脚本仍存在”
- 音频 API 按需生成：无音频调用时不再强制输出 `PlayLoop` / `PlayOneShot`

## 仍需人工判断或后续量化

- `GetComponent` “尽量少用”：目前只能人工评估局部/跨层使用是否合理，后续可按 Game 层和跨对象访问做阈值。
- “一节点一主脚本”：hydration 能发现关键脚本和逻辑/表现问题，但还没有按每个节点脚本数量做通用硬阈值。
- “不要拆一堆只调用一次的小 helper”：未调用方法已阻断；单次调用 helper 是否值得保留仍需要结合方法长度和语义判断。
- 注释是否“大白话”：目前只能阻断旧文档回潮，不能可靠自动判断中文注释质量。

结论：以后新增 prompt/反馈规则，必须同时标注是 hardgate、maintainability、hydration、测试覆盖，还是人工审计项；不能只改 prompt。
