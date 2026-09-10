# 030 — 工单拆分与语言约定

日期：2026-09-09（本轮会话续记）
状态：tickets 已发布；语言约定已确认
前置：`docs/adr/0010-ocx-go-native-runtime-line.md`、
`devlog/_plan/260909_ocx_go_native_line/000_grill_record.md`、
`010_migration_ledger_spec.md`、`020_core_preview_spec.md`

## 本轮做了什么

把 `020_core_preview_spec.md` 的实施切片拆成可独立验收的垂直工单，按依赖顺序
发布到 fork `waxiangzi/opencodex` 的 GitHub Issues。

- **父 tracker**：#59 — Track the ocx-go native runtime line。
- **子工单**：#60–#75，共 16 条，全部用 GitHub 原生 sub-issue 形式挂在 #59 下，
  并带 `ready-for-agent` 标签。
- **阻塞关系**：用 GitHub 原生 issue dependencies（`blocked_by`）表达，共 23 条边，
  已逐条核对与设计一致。
- **当前 frontier（无未完成阻塞、可立刻开工）**：#60。

## 工单与依赖

| # | 标题 | 阻塞于 |
|---|---|---|
| 60 | ocx-go binary identity and artifact naming | — |
| 61 | Migration ledger and native-unsupported spine | 60 |
| 62 | Independent state root, owner-tagged runtime records, and admission token | 60 |
| 63 | Strict key-auth provider configuration and legacy import | 62 |
| 64 | Atomic configuration snapshot and validation-failure semantics | 63 |
| 65 | Public data plane: admission, /v1/responses, /v1/models | 62, 63 |
| 66 | Native responses-family relay (openai-responses, azure, azure-openai) | 65 |
| 67 | Native openai-chat conversion (strict Codex field set) | 65 |
| 68 | Multi-key runtime scheduler with 429-only failover | 66, 67 |
| 69 | Native Codex loopback Design-B sync, injection, and restore | 62, 63 |
| 70 | Codex handoff protocol with preview and revalidation | 69 |
| 71 | Native launchers and launcher-internal capability routes | 65, 69 |
| 72 | Zero-JS dashboard foundation and migration-ledger capability page | 63, 64, 71 |
| 73 | Zero-JS dashboard management pages (core preview) | 72 |
| 74 | Release: Go-only CI lane, artifact, provenance, and platform disclosure | 71, 73 |
| 75 | Opt-in real-provider probe runner (summarized) | 67, 74 |

每个工单的正文含：`## Parent`、`## What to build`、`## Acceptance criteria`、
`## Blocked by`。这个形状与既有 #45–#58 一致，也是 `Enforce issue quality`
不会把工单判为“无模板”而关闭的原因（校验脚本要求 feature 表单的核心小节
至少命中两个）。

## 一处操作失误与修复（必须留档）

修正两条 `## Blocked by` 引用时，一次带 `--repo` 的读取被外层包装丢弃了仓库限定，
取回的是 **upstream**（`lidge-jun/opencodex`）的 issue 正文；随后的写回把 upstream
正文覆盖到了 fork 的 **#70** 与 **#75** 上。

- 发现方式：正文长度与内容明显不符（#70 变成 codex diagnostics、#75 变成韩文 bug
  报告），立即用 REST API 枚举 #59–#75 复查。
- 修复方式：从本地原始 heredoc 恢复两篇正文，并同时修正阻塞引用
  （#70 → 阻塞于 #69；#75 → 阻塞于 #67、#74），经 `gh api --method PATCH` 写回。
- 复核结果：17 篇正文与本地源逐字节一致；upstream #70/#75 的作者与更新时间未变
  （分别为 Wibias 2026-07-13、seotk0319 2026-07-09），确认 **未改动 upstream**。
- 根因与对策：不再信任带 `--repo` 的读取输出；权威读取一律用
  `gh api repos/<owner>/<repo>/...` 显式指向仓库。

## 语言约定（用户 2026-09-10 确认）

- **交流**：中文。
- **新记录**：中文。本目录下新写的 devlog/plan 记录用中文。
- **既有产物保持英文**：fork #59–#75、`docs/adr/*`（含 ADR-0010）、`CONTEXT.md`
  维持英文，不重写。
- 提交信息、代码、标识符一律英文。

补充事实：仓库 `Enforce issue quality` 工作流含“非英文 issue 自动补英文译文”步骤；
若后续以中文新建 issue，机器人会在正文内追加英文翻译块（中英对照），这属于预期行为。

## 下一步

从 frontier 开始：**#60**。其实施细节与验收矩阵见 `020_core_preview_spec.md`。
