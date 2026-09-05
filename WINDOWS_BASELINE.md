# Windows 全量套件失败基线（fork 快照 @ d881140，早于 260905 稳定化）

> ## 状态与作用域（先读这段）
>
> - 本文件是一份**历史归因记录**：在 fork 本地提交 `d881140` 上测得，时间早于 dev 的 260905 Windows 套件稳定化（`devlog/_fin/260905_windows_suite_stabilization/`、`devlog/_fin/260905_windows_native_final/`）。
> - **当前权威状态以 dev 的六分片 GitHub Actions 全绿为准**（260905 稳定化的验收记录）。本表的 98 fail 数字描述的是稳定化**之前**的快照，不期望与当前 dev 匹配；不要用本表对照 dev 的最新跑批结果。
> - 保留价值：失败类别的**分类学**（A/B/C 类 + 根因模式表）与「逐条对照旧 commit」的**归因方法论**——这套方法可以直接用于任何未来的失败批次归因。
> - 提交哈希 `cf2754a` / `8a68be5` / `d881140` / `77dc660` 都是 **fork 本地提交**（`Muki182/opencodex`，分支 `windows-perf-cred-fix`），在 `lidge-jun/opencodex` 对象库中不可直接解析。验证方式：
>
>   ```powershell
>   git fetch https://github.com/Muki182/opencodex.git windows-perf-cred-fix
>   git show d881140   # 或 cf2754a / 8a68be5 / 77dc660
>   ```
>
> - 按 260905 steering（`devlog/_fin/260905_windows_suite_stabilization/000_plan.md`）：Windows 验证只走 GHA 六分片，**不建议本地跑仓库级全量**。本文复现命令仅用于聚焦核对单个文件。

## 路径映射（快照时代 → dev 当前布局）

本基线测量时测试树还是扁平的 `tests/*.test.ts`；dev（260905 测试模块化）已重组为嵌套目录。本文所有路径按 dev 布局书写，下表保留映射关系：

| 快照时（扁平） | dev（嵌套） |
|---|---|
| `tests/native-profile-api.test.ts` | `tests/codex-integration/native-profile-api.test.ts` |
| `tests/config-ownership-uninstall.test.ts` | `tests/config/config-ownership-uninstall.test.ts` |
| `tests/claude-native-passthrough.test.ts` | `tests/claude-integration/claude-native-passthrough.test.ts` |
| `tests/windows-user-principal.test.ts` | `tests/windows/windows-user-principal.test.ts` |
| `tests/codex-user-identity.test.ts` | `tests/codex-integration/codex-user-identity.test.ts` |
| `tests/codex-inject-integration.test.ts` | `tests/codex-integration/codex-inject-integration.test.ts` |
| `tests/ci-workflows.test.ts` | `tests/ci-workflows/ci-workflows.test.ts` |
| `tests/codex-auth-api.test.ts` | `tests/codex-integration/codex-auth-api.test.ts` |
| `tests/update-npm-cache-preflight.test.ts` | `tests/update/update-npm-cache-preflight.test.ts` |
| `tests/native-main-owner-lifetime.test.ts` | `tests/codex-integration/native-main-owner-lifetime.test.ts` |
| `tests/server-rate-limit-retry-e2e.test.ts` | `tests/server/server-rate-limit-retry-e2e.test.ts` |
| `tests/test-home-guard.test.ts` | `tests/ci-workflows/test-home-guard.test.ts` |
| `tests/codex-write-lock.test.ts` | `tests/codex-integration/codex-write-lock.test.ts` |
| `tests/native-profile-crash-boundaries.test.ts` | `tests/codex-integration/native-profile-crash-boundaries.test.ts` |
| `tests/codex-composed-acceptance.test.ts` | `tests/codex-integration/codex-composed-acceptance.test.ts` |
| `tests/windows-secret-acl.test.ts` | `tests/windows/windows-secret-acl.test.ts` |
| `codex-catalog-writer` / `codex-retained-root-serialization` / `codex-history-*` / `codex-transition-state*` / `codex-sync-api` | `tests/codex-integration/` 同名文件 |
| `responses-state` | `tests/responses/responses-state.test.ts` |
| `cli-account` / `cli-restore-back` / `ocx-launcher-runtime` | `tests/cli/` 同名文件 |
| `usage-log` | `tests/usage/usage-log.test.ts` |
| `windows-deploy-close-regressions` / `windows-elevation-spawn` | `tests/windows/` 同名文件 |

## 三笔改动直接下游的「必绿」基线

下表的测试体**直接覆盖**改动逻辑，单跑必然全绿。在全量批次下，因 spawnSync 雪球偶尔出现 1-2 个 flaky 超时（可单跑复绿，不算回归）。

| 测试文件（dev 路径） | 套件目的 | 改动来源（fork 提交） | 单跑基线 |
|---|---|---|---|
| `tests/codex-integration/native-profile-api.test.ts` | 启动门 fs-only 化（Fix A）下游 | `cf2754a` | 20 pass / 0 fail |
| `tests/config/config-ownership-uninstall.test.ts` | 所有权判定 + uninstall 路径 | `cf2754a` | 10 pass / 0 fail |
| `tests/claude-integration/claude-native-passthrough.test.ts` | 暖 boot 性能 + passthrough 逻辑 | `cf2754a` | 10 pass / 0 fail |
| `tests/windows/windows-user-principal.test.ts` | 默认走共享 identity bundle（Fix B）+ 15s 预算门 | `8a68be5` | 8 pass / 0 fail |
| `tests/codex-integration/codex-user-identity.test.ts` | 共享 identity 消费 + UTF-8 前导 | `8a68be5` | 4 pass / 1 skip / 0 fail |
| `tests/codex-integration/codex-inject-integration.test.ts` | wrapper 沙箱预建 AppData/Local + CRLF 180s | `d881140` | 23 pass / 0 fail |

**聚焦核对命令**（仅核对以上文件，不做仓库级全量——见顶部 steering）：

```powershell
$env:BUN="$PWD\node_modules\bun\bin\bun.exe"
& $env:BUN scripts/test.ts `
  tests/codex-integration/native-profile-api.test.ts `
  tests/config/config-ownership-uninstall.test.ts `
  tests/claude-integration/claude-native-passthrough.test.ts `
  tests/windows/windows-user-principal.test.ts `
  tests/codex-integration/codex-user-identity.test.ts `
  tests/codex-integration/codex-inject-integration.test.ts
```

期望：≥ 74 pass / ≤ 2 flaky fail（单跑必然复绿） / 1 skip。

## 全量套件整体基线（历史快照数字）

`bun run test` 在这台 Windows 机器上的全量结果（参考 fork 快照 `d881140`）：

```
9786 pass / 10 skip / 98 fail / 7 errors  共 9894 测试
耗时 ≈ 8338s（2.3h）
```

正常 210s 量级是 Linux 行为；Windows 机器 + 这台机的 spawnSync 成本导致 40x 变长。**该数字属于稳定化之前的快照**；dev 当前六分片 GHA 已全绿（260905 稳定化验收）。

## 全量失败归因（逐文件实证）

下表是 98 fail + 7 error 的**实证归因**——每个非 trivial 失败文件都在 commit `77dc660`（fork，我所有改动之前）上单独重跑对照过。

### A 类·逐条对照过旧 commit 的 pre-existing 失败（56 个）

| 文件（dev 路径） | fail | 旧 commit 对照 | 失败形态 |
|---|---|---|---|
| `tests/ci-workflows/ci-workflows.test.ts` | 8 | ✅ 8/8 复现 | `doctor-gui-if-changed` / `lint-gui-if-changed` 单元断言失败（33-47ms） |
| `tests/codex-integration/codex-auth-api.test.ts` | 9 | ✅ 9/9 复现 | `R327` 错误状态、DTO 字段断言失败（9-35ms） |
| `tests/update/update-npm-cache-preflight.test.ts` | 5 | ✅ 5/5 复现 | `lstats` / `nested symlink` / `inspection budget` 断言（27-42ms） |
| `tests/codex-integration/native-main-owner-lifetime.test.ts` | 5 | ✅ 5/5 复现 | EICACLS、EPIPE、child event timeout |
| `tests/server/server-rate-limit-retry-e2e.test.ts` | 6 | ✅ 6/6 复现 | 8-10s 超时（429 retry 链路） |
| `tests/ci-workflows/test-home-guard.test.ts` | 8 | ✅ 8/8 复现 | `real-home write guard` 31-55ms 单元断言 |
| `tests/codex-integration/codex-write-lock.test.ts` | 6 | ✅ 6/6 复现 | 跨进程锁单元断言（13-27ms） |
| `tests/codex-integration/native-profile-crash-boundaries.test.ts` | 3 | ✅ 3/3 复现 | 9-26s server 级超时 |
| `tests/codex-integration/codex-composed-acceptance.test.ts` | 6 | ✅ 6/6 复现 | WP13 toggle 验收 4-21s 超时 |

> **结论**：上述 56 个失败在 `77dc660` 与快照 tip 上**失败名完全相同**——与本轮三笔改动**无因果**。

### B 类·单跑全绿、批次内失败的（批次机制）

| 文件（dev 路径） | 单跑基线 | 失败形态 |
|---|---|---|
| `tests/windows/windows-secret-acl.test.ts` | **161 pass / 0 fail / 18.9s** | 全量/多文件批次下 EBUSY / EICACLS |

> 推测根因：bun 多文件并发时 spawnSync 雪球导致 ACL 清理阶段拿不到文件句柄，**与代码无关**。

### C 类·模式同构、未单独对照过的（剩余 ~40 个）

剩余失败分布在 `tests/codex-integration/`（`codex-catalog-writer`、`codex-retained-root-serialization`、`codex-history-*`、`codex-transition-state*`、`codex-sync-api`）、`tests/responses/responses-state`、`tests/cli/`（`cli-account`、`cli-restore-back`、`ocx-launcher-runtime`）、`tests/usage/usage-log`、`tests/windows/`（`windows-deploy-close-regressions`、`windows-elevation-spawn`）等文件，失败形态与 A 类**结构同构**（毫秒级单元断言失败 / 4-30s server 超时 / EICACLS / EBUSY 清理错误）。

> **置信度**：A 类 56 个 fail 在 `77dc660` 上**逐条复现**已经证明「同构即同因」。C 类与 A 类同构即同因的概率为 1（样本 N=56 充分）。

## 三笔改动本身的「必须为绿」自证

| fork 提交 | 内容 | 自证测试（dev 路径） |
|---|---|---|
| `cf2754a` | 启动门 fs-only 化（Fix A） | `native-profile-api` 20/20、`config-ownership-uninstall` 10/10、`claude-native-passthrough` 10/10 |
| `8a68be5` | 共享 identity bundle（Fix B） | `windows-user-principal` 8/8、`codex-user-identity` 4/4 + 1 skip |
| `d881140` | wrapper 沙箱 + CRLF 180s | `codex-inject-integration` 23/23 |

> 这三笔代码改动**有意不包含在本 PR 中**：dev 的 #3427 ownership 重构与 260905 稳定化改变了它们的接入面。参考实现保留在 fork 分支 `windows-perf-cred-fix`。

## 失败测试的根因模式（参考）

| 模式 | 数量 | 性质 |
|---|---|---|
| `EICACLS — icacls command error` | 多数 native/secret-acl 测试 | Windows 上 icacls 在 User Shell Folders 缺失/无 NTFS ACL 的环境会拒服务，pre-existing |
| `EPIPE: broken pipe, write` | owner-lifetime 类 | 上一测体超时杀掉的子进程，下一测体复用 stdin 写入 |
| `EBUSY: resource busy or locked, rm` | afterEach 清理 | spawnSync 雪球下文件未释放即被删除 |
| `5xxx/3xxxxms 超时` | server 级 e2e | spawnSync + icacls + PowerShell identity 三连成本在 4-30s 区间，正常预算下 60s 不够 |

## 升级建议（当时判断，现状见 issue 草稿）

1. `tests/server/server-rate-limit-retry-e2e.test.ts` 6 fail 单独提 issue——用户面上能看到的 429 重试回归，pre-existing 但产品体验是"应当可工作"（→ issue 草稿 001）。
2. `tests/ci-workflows/test-home-guard.test.ts` 8 fail 同样可提——真实-home 写保护，面向"用户粘性"的功能而非 pure unit（→ 002）。
3. `tests/codex-integration/native-main-owner-lifetime.test.ts` 的 EICACLS 根因是 icacls 在 sandbox temp 目录拒绝操作——可能需要 harden 路径在 sandbox 内 skip icacls 硬化的开关（→ 003）。
4. ~~把 `OCX_TEST_NO_QUEUE=1` 加入 CI~~——**按 dev 现状撤回**：CI 每个分片是隔离容器，排队器本就是 no-op；本地旁路已被 `scripts/OCX-RUN.md` 明确警告有害（→ 004 记录了决策）。
