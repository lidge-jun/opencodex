# [决策记录] CI `OCX_TEST_NO_QUEUE=1` 建议 — 已按 dev 现状撤回

## 标签
- `chore` `area:test` `area:ci` `priority:P3` `infra` `resolved-by-upstream-evidence`

## 原始建议（已撤回）
快照时代曾建议：在 CI 给所有 `bun run test` 步骤加 `OCX_TEST_NO_QUEUE=1`，跳过 `scripts/test.ts` 的本机排队器（当时 `waitForExclusiveRun`，93-126 行）——理由是"CI 跑在隔离容器里不存在多 agent 互踩，排队无谓阻塞"。

## 按 dev 现状复查后：不改动

1. **排队器已迁移**：快照时 `scripts/test.ts` 内联的 `waitForExclusiveRun` 现在位于 `scripts/test-run-lock.ts` 的 `acquireTestRunLock`（约 L468），由 `scripts/test.ts`（约 L530）调用；环境变量 opt-out 仍是 `OCX_TEST_NO_QUEUE`。

2. **本地旁路已被上游明确警告**：`scripts/OCX-RUN.md` 写道——
   > "Do not set `OCX_TEST_NO_QUEUE=1` to 'go faster' — that bypass is what let four suites stack locally and turn a 210s run into 13 minutes."

   排队器正是防本地多套件叠加的机制，旁路有害。

3. **CI 侧本就无需设置**：dev 的六分片 GHA 工作流未设置 `OCX_TEST_NO_QUEUE`，且每个分片是独立隔离容器——锁文件永远空闲，`acquireTestRunLock` 在 CI 里是 no-op，不存在"排队阻塞 CI"的问题。

4. **260905 steering**：Windows 验证只走 GHA 六分片（`devlog/_fin/260905_windows_suite_stabilization/000_plan.md`），本机不再跑仓库级全量。

## 结论
- CI：无需任何改动（排队器在隔离容器里不产生等待）
- 本地：维持 `OCX-RUN.md` 的警告——不要旁路
- 本 issue 保留为决策记录，避免后人重复提出同一建议

## 关联
- `scripts/test-run-lock.ts`（`acquireTestRunLock` / `TEST_RUN_NO_QUEUE_ENV`）
- `scripts/OCX-RUN.md`（本地排队警告）
- WINDOWS_BASELINE.md §升级建议 #4（原建议出处，已划掉）
