# [待提 GitHub] server-rate-limit-retry-e2e: 6 fails pre-existing

## 标签
- `bug` `area:test` `priority:P2` `windows-only` `pre-existing` `regression-risk`

## 摘要
`tests/server/server-rate-limit-retry-e2e.test.ts` 在 `77dc660`（cf2754a/8a68be5/d881140 三笔改动之前）上**全 6 测全败**，与本轮三笔改动**无因果**。但产品面上这是用户可见的 429 重试链路——pre-existing 不等于"产品体验上可接受"。

> 哈希 `77dc660` 等为 fork 本地提交（`Muki182/opencodex` 分支 `windows-perf-cred-fix`），验证：`git fetch https://github.com/Muki182/opencodex.git windows-perf-cred-fix && git show 77dc660`。

## 实证（基线文档 WINDOWS_BASELINE.md 详表）

- `77dc660` 单独重跑：`0 pass / 6 fail / 24 expect() calls / 53.04s`
- 快照 tip（`d881140`）全量跑：6 fail，8-10s 超时
- 失败形态：429 retry 链路 server 级超时

## 失败测试名
- `single-key provider replays the identical request until upstream succeeds`
- `without retryOn429 the 429 surfaces immediately with Retry-After`
- `exhausted attempts surface the 429`
- `same-key retries run before multi-key failover, which still works after they exhaust`
- `key-auth openai-responses passthrough replays 429 on the same key`
- `retry budget stays per request across multi-key failover (never re-arms)`

## 与 dev 相关工作的关系
dev 的 `devlog/_fin/260905_always_on_429_failover/` 是**另一层**的 429 工作：多凭证 failover 默认值（"429 时换下一个凭证"），不是本文件的 retry-E2E 超时。如果该单元的改动触及 `retryOn429` 链路，这 6 个测体是现成的验收面。

## 建议修复方向
1. 先确认 GHA Windows 分片是否也复现——如果是 → 真实回归
2. 如果分片绿、本地红 → 走 spawnSync 雪球分析（spawnSync 12.9s + icacls 4.3s + 4s identity lookup 链路），看 retry 测试的 setup 是不是卡在 identity 解析上
3. 短期缓解：把 server-rate-limit-retry-e2e 的全局 setup 改用共享 identity（如果还没走的话）

## 复现命令（聚焦单文件，不做全量——见基线文档顶部 steering）
```powershell
$env:BUN="$PWD\node_modules\bun\bin\bun.exe"
& $env:BUN scripts/test.ts tests/server/server-rate-limit-retry-e2e.test.ts
```

## 关联
- WINDOWS_BASELINE.md §A 类（逐条对照过旧 commit）
- fork 提交 `1d87999`（基线文档第一版，fork 分支可查）
