# Windows pre-existing 失败的 Issue 草稿

> 这四份草稿源自 [WINDOWS_BASELINE.md](../../WINDOWS_BASELINE.md) 的实证归因（98 fail 全部 pre-existing）。
> 每份草稿按 dev 当前布局标注了测试路径，并注明与 260905 稳定化工作的关系；可直接贴进 GitHub issue，
> 或作为后续修复工作的需求底稿。

## 待提清单

| # | 文件 | 摘要 | 状态 |
|---|---|---|---|
| 001 | [server-rate-limit-retry-e2e-pre-existing.md](001-server-rate-limit-retry-e2e-pre-existing.md) | 429 retry 链路 6 fails（pre-existing，`tests/server/`） | 待提 |
| 002 | [test-home-guard-real-home-write-protection.md](002-test-home-guard-real-home-write-protection.md) | 真实-home 写保护 8 fails（pre-existing，用户可见功能，`tests/ci-workflows/`） | 待提 |
| 003 | [windows-icacls-fails-on-sandbox-temp.md](003-windows-icacls-fails-on-sandbox-temp.md) | EICACLS — icacls 在 sandbox temp 拒绝操作（`tests/codex-integration/` native 系列） | 待提（若 GHA 分片已不复现则降级为本地环境记录） |
| 004 | [ci-ocx-test-no-queue-default.md](004-ci-ocx-test-no-queue-default.md) | CI `OCX_TEST_NO_QUEUE=1` 建议 — **已按 dev 现状撤回**，保留为决策记录 | 关闭（决策记录） |

## 来源
这些失败均已在 [WINDOWS_BASELINE.md](../../WINDOWS_BASELINE.md) 中实证为 **pre-existing**（在 fork 提交 `77dc660` 上逐条对照复现），与本轮 `cf2754a` / `8a68be5` / `d881140` 三笔 fork 改动**无因果**。

> 哈希均为 fork 本地提交（`Muki182/opencodex`，分支 `windows-perf-cred-fix`）：
> `git fetch https://github.com/Muki182/opencodex.git windows-perf-cred-fix && git show <hash>`
