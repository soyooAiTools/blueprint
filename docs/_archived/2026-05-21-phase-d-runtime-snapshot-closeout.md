# Phase D runtime structured snapshot closeout（2026-05-21）

## 结论

Phase D Step 1/2/3 已把 Blueprint deterministic assembly 的 runtime evidence surface 从布尔/零散 signal 收敛为结构化 `phaseEvidence.<moduleId>` snapshot，并覆盖 CUA L1 registry 36/36 模块。

本次收口拆成两条仓库边界：

- `soyooAiTools/blueprint`：probe contract、Node reader/evaluator、metrics、C# skeleton helper、assembly emitter runtime snapshots、Node 回归测试、归档文档。
- `soyooAiTools/cua-agent`：Python `module_probe_evaluator.py`、`phase_evidence_reporter.py`、`agent.py` report wiring、README 记录。CUA 侧已由 @Tim-cc push `077143f`。

## 关键文件

Blueprint 主仓：

- `contracts/cua-probe-contracts.v1.json`：canonical 36-module CUA probe contract。
- `engine/cua-probe-contracts.cjs`：contract loader、registry coverage、snapshot coverage、failure attribution。
- `engine/module-gap-ledger.cjs`：module gap ledger 与缺口归因。
- `engine/metrics.cjs`：记录 `moduleProbeRegistry*` 和 `phaseEvidenceSnapshot*` 指标。
- `adapters/skeleton-generator.cjs`：生成 `RecordPhaseEvidenceObject/Field`、resource/score baseline、`phaseRealTimer`。
- `adapters/assembly-emitter.cjs`：为 36-module runtime surface 写真实执行路径 snapshot。
- `test/cua-probe-*.cjs`、`test/module-gap-ledger.test.cjs`、`test/assembly-emitter.test.cjs`：contract/fixture/emitter 回归。

CUA 仓：

- `/root/cua-agent/playable_agent/module_probe_evaluator.py`
- `/root/cua-agent/playable_agent/phase_evidence_reporter.py`
- `/root/cua-agent/playable_agent/agent.py`

## Runtime snapshot 规则

- Snapshot 必须来自模块/action 的真实执行路径，不允许 skeleton 对 active/completed phase blanket fill。
- 每条 snapshot 必须带 `_meta.moduleId`、`_meta.phaseId`、`_meta.sourceSignalIds`、`_meta.schemaVersion`。
- 后续 noop tick 不能覆盖首次 meaningful pass evidence；视觉、click、damage、cooldown、camera 等模板都需要 first meaningful guard。
- phase scoping 优先使用 `sourceAtomIds` 对应的 phase binding；不能因 active entity overlap 把 snapshot 写到其他 phase。
- `phaseRealTimer` 使用真实墙钟，供 anti-autoplay 判定；不要回退到可被 CUA speed patch 压缩的 `phaseTimer`。
- camera contract 目前要求 literal dotted keys，例如 `before["framing.look_at"]` / `after["framing.look_at"]`。

## 验证记录

Node regression：

```bash
node test/run-all.cjs --only assembly-emitter
node test/run-all.cjs --only w1b-5partial
node test/run-all.cjs --only skeleton-generator
node test/run-all.cjs --only cua-probe-contracts
node test/run-all.cjs --only module-gap-ledger
```

CUA/Python regression：

```bash
python3.8 /root/.slock/agents/bde4a3a7-6d7e-4b79-ba3e-1c209ab7db0c/notes/phase-d-step1-impl/test_phase_evidence_reporter.py
python3.8 /root/.slock/agents/bde4a3a7-6d7e-4b79-ba3e-1c209ab7db0c/notes/phase-d-step1-impl/test_module_probe_evaluator.py
python3.8 /root/.slock/agents/bde4a3a7-6d7e-4b79-ba3e-1c209ab7db0c/notes/phase-d-step1-impl/test_synthetic_report_regression.py
python3.8 /root/.slock/agents/bde4a3a7-6d7e-4b79-ba3e-1c209ab7db0c/notes/phase-d-step3-impl/test_c1_visual_presentation_fixtures.py
python3.8 /root/.slock/agents/bde4a3a7-6d7e-4b79-ba3e-1c209ab7db0c/notes/phase-d-step3-impl/test_c2_camera_fixtures.py
python3.8 /root/.slock/agents/bde4a3a7-6d7e-4b79-ba3e-1c209ab7db0c/notes/phase-d-step3-impl/test_c3_combat_attack_fixtures.py
python3.8 /root/.slock/agents/bde4a3a7-6d7e-4b79-ba3e-1c209ab7db0c/notes/phase-d-step3-impl/test_c4_niche_control_fixtures.py
```

Final Luna/CUA smoke：

- Build artifact: `/root/.slock/agents/97b5fa1a-8a12-4d82-a8a4-36b5a60df991/work/phase-evidence-ctier-luna-smoke/`
- CUA observe report: `/root/cua-agent/runs/verify_1779372055/verify_report.json`
- Manual reporter summary: `/root/.slock/agents/97b5fa1a-8a12-4d82-a8a4-36b5a60df991/work/phase-evidence-ctier-luna-smoke/ctier-phase-evidence-summary.json`

Final summary:

- `phaseCoverage=4/4`
- `passed=true`
- `triggeredPilotPairs=23`
- `triggeredPresentFullRate=1.0`
- `triggeredAntiAutoplayHeldRate=1.0`
- validation passed, no violations
- all 20 C-tier modules triggered at least once
- non-passed triggered modules: `0`

## 发布边界

不要把以下运行态/临时文件混入发布提交：

- `server-data/tasks.db-shm`
- `server-data/tasks.db-wal`
- `server-data/**` runtime output
- root-level `snap-*.cjs` probe scripts
- local Luna/CUA smoke HTML artifacts

需要长期保留的 smoke 证据放在 Slock workspace `work/phase-evidence-*` 目录和本归档页中；repo 只保存源码、测试和文档。
