# 2026-04-25 程序员交付版清理与注释补齐归档

## 背景

`proj_1776912973985_5o2lyu` 的完整 Unity 工程进入程序员交付阶段后，不再需要 Blueprint/CUA 自动审核使用的机器契约注释和验证附件。交付工程仍存在两类可读性问题：

- `[ASSEMBLY SLOT]`、`[ASSEMBLY PHASE]`、`phaseEvidenceSchema`、`TODO_*` 等自动验证契约会干扰程序员阅读。
- `Spawn<Entity>(count)` 兼容别名和部分 `GFM_*` 工具方法缺少方法级中文说明。

## 处理

- 新增 `lib/programmer-delivery-cleaner.cjs`，在交付副本内清理机器契约注释、删除 `BlueprintArtifacts/`，并生成 `PROGRAMMER_HANDOFF.md`。
- `/api/projects/:id/svn-commit` 在临时 SVN checkout 内执行程序员交付版清理，不修改审核前源码和公开预览产物。
- `scripts/export-unity-project.sh` 增加 `--programmer-delivery` 参数，手工导出完整 Unity 工程时也可生成同口径交付包。
- 指定导出工程 `server-data/exports/proj_1776912973985_5o2lyu_unity_project_full_20260425_173243` 已直接清理并补齐方法级注释。
- `adapters/skeleton-generator.cjs`、`worker/GFM_*.cs`、`worker/GameSceneCtrl.cs`、`worker/ScriptActivator.cs`、`worker/GFM_Tools.cs` 已补齐源头注释，防止后续导出复发。

## 验证

- 指定导出工程机器契约残留：`0`
- 指定导出工程方法声明前缺注释扫描：`0`
- worker 通用工具源方法声明前缺注释扫描：`0`
- `node -c adapters/skeleton-generator.cjs`
- `node test/skeleton-flow-fallback.test.cjs`
- `node test/csharp-comment-localizer.test.cjs`
- `node test/assembly-emitter.test.cjs`
- `npm test`

## 规则

审核前必须保留机器契约注释；只有点击“提交 SVN”或使用 `--programmer-delivery` 导出交付版时，才清理自动验证契约和验证附件。
