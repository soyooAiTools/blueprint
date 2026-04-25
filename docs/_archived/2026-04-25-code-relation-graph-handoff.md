# 2026-04-25 交付工程代码关系图系统化

## 背景

程序员接手 Blueprint 生成的 Unity 工程时，需要先理解 `GameFlowManagerMain` 主文件、多个 partial 文件、`Commons/GFM_*` 通用库、阶段流和 AutoPlay/CUA 路径之间的关系。只在某一个任务目录手工添加说明会很快失效，因此需要把关系图纳入导出与交付链路。

## 改造

- 新增 `lib/code-relation-graph-writer.cjs`，自动扫描交付根目录中的 `GameFlowManagerMain*.cs`，生成：
  - `CODE_RELATION_GRAPH.md`：Markdown + Mermaid，可随代码一起 diff。
  - `CODE_RELATION_GRAPH.html`：静态 HTML 图表页，浏览器直接打开，无需 Mermaid/npm/网络。
- `scripts/export-unity-project.sh` 在每次完整 Unity 工程导出时写入关系图，并在 `README.md` 目录区加入入口。
- `lib/programmer-delivery-cleaner.cjs` 在 SVN 程序员交付清理后也调用同一生成器，保证点击“提交 SVN”的交付目录同样带关系图。
- `test/programmer-delivery-cleaner.test.cjs` 覆盖交付清理后生成 `.md` / `.html` 的行为。

## 交付边界

- 关系图是程序员可读交付物，不参与 Blueprint/CUA 自动审核。
- 它可以存在于审核前完整工程导出，也可以存在于程序员交付版。
- 程序员交付版仍会清理 `BlueprintArtifacts/` 和机器契约注释；关系图保留。
- 程序员交付版会移除根目录 `tools/`，避免把构建/转换辅助脚本提交给程序员交付仓库；审核前完整工程导出仍保留 `tools/`。
- 生成器只读 C# 文件名、阶段 switch 和 `Phase_*_Init` 方法名，不修改业务源码。

## 验证

- `node -c lib/code-relation-graph-writer.cjs`
- `node -c lib/programmer-delivery-cleaner.cjs`
- `bash -n scripts/export-unity-project.sh`
- `node test/programmer-delivery-cleaner.test.cjs`
- 实际导出验证：
  - `scripts/export-unity-project.sh proj_1776912973985_5o2lyu --programmer-delivery --out /tmp/proj_1776912973985_5o2lyu-systemic-graph.tar.gz`
  - tar 包包含 `CODE_RELATION_GRAPH.md`、`CODE_RELATION_GRAPH.html`、`README.md`、`PROGRAMMER_HANDOFF.md`。

## 后续建议

如果以后需要函数级调用图，可在 `docs/` 中另行接 Doxygen + Graphviz 或 DocFX，但默认交付仍保持轻量关系图，避免把 `Assets/Plugins` 和 generated assembly slot 噪声暴露为第一入口。
