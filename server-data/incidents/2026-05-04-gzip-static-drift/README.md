# 2026-05-04 — optimize-webgl 过期 .gz 把流水线成功伪装成 phase stuck

## 症状
`proj_1777128165822_6acnqx` 流水线报 `done`，磁盘 `index.html` 含新 phase ID（`deliverFragmentForGold` 单数 / `highEfficiencyCollectWithTripleDrill`），但 playwright 探针公开 URL 跑出来 `__PHASE__:deliverFragmentsForGold`（旧带 s）然后卡 1/11。

## 根因
`lib/optimize-webgl.cjs` 把 `.html` 写和 `.gz` 写一起门控在 `if (saved>0)`。当流水线产出新 .html 但 optimize 这一轮没找到额外可削字节 → saved=0 → `.gz` 完全不更新。`/etc/nginx/conf.d/blueprint.conf` 的 `/webgl/` location 开了 `gzip_static on`，浏览器拿到的是上一轮残留 `.gz`，跑的是旧代码。

## 修复
- 主仓库 commit [`21d822c`](https://github.com/soyooAiTools/blueprint/commit/21d822c) — `.gz` 写无条件化 + `mode 0o644`
- nginx `/webgl/` 加 `location ~* \.wasm$ { default_type application/wasm; }`（optimize 会把 inline WASM 抽成 `physics_*.wasm`）
- skill 仓库 commit [`50087ce`](https://github.com/soyooAiTools/blueprint-skill/commit/50087ce) — INCIDENTS + infra 文档
- `pm2 restart blueprint-editor` 加载新 lib

## 探针脚本（已归档）
- `probe-stall.cjs` — 第一版定位探针，autoplay 注入 + 9 个采样点
- `probe-text.cjs` — 中间版本（按需复现）
- `probe-verify.cjs` — 验证根因：cache-buster `?v=Date.now()` + `fetch(no-store)` 自检 HTML，确认 oldDeliver=false / newDeliver=true / 三个采样点 phase 0→1→2→3

## 诊断指纹（写进 skill 了）
1. `ls -la server-data/webgl/{id}/index.html*` 比 mtime
2. 探针 URL 加 `?v=Date.now()` + `fetch(location.href, {cache:'no-store'})`
3. 磁盘 grep 不到的字符串出现在 console = 立刻怀疑过期 .gz/.br
