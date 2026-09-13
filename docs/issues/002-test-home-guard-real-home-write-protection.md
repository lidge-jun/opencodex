# [待提 GitHub] test-home-guard: 8 fails pre-existing — real-home write protection broken?

## 标签
- `bug` `area:test` `priority:P2` `windows-only` `pre-existing` `user-facing-feature`

## 摘要
`tests/ci-workflows/test-home-guard.test.ts` 在 `77dc660` 上**逐条复现 8/8 失败**。这是**真实-home 写保护**功能测试——不是 pure unit，是面向"用户粘性"（防止测试误写用户 home）的产品功能。

> 哈希 `77dc660` 为 fork 本地提交（`Muki182/opencodex` 分支 `windows-perf-cred-fix`），验证：`git fetch https://github.com/Muki182/opencodex.git windows-perf-cred-fix && git show 77dc660`。

## 实证
- `77dc660` 单独重跑：与快照 tip 失败名 100% 一致
- 失败形态：毫秒级单元断言（31-55ms），不是超时
- 失败测试：
  - `real-home write guard > armed + the protected home: all three writers throw`
  - `real-home write guard > armed + a symlink escaping a temp home into the protected home: refused`
  - `real-home write guard > armed + an unregistered temp home: writers succeed`
  - `real-home write guard > armed + a first write beneath a symlinked PARENT escaping into the protected home: refused`
  - `real-home write guard > disarmed: the protected home is allowed (production stays inert)`
  - `real-home write guard > the protected path comes from OCX_REAL_HOME, not the sandboxed HOME`
  - `real-home write guard > a symlink pointing at the protected home is rejected`
  - `real-home write guard > /var and /private/var spellings of one path agree`

## 建议修复方向
1. 确认 GHA Windows 分片是否同样失败——如果是，是 pre-existing 功能 bug
2. 如果仅本地 Windows：可能与 sandbox AppData/Local 预建（fork 提交 `d881140`）冲突？或 `OCX_REAL_HOME` 在 Windows 解析不一致？
3. 该功能面向"用户粘性"，值得较高优先级

## 复现（聚焦单文件）
```powershell
$env:BUN="$PWD\node_modules\bun\bin\bun.exe"
& $env:BUN scripts/test.ts tests/ci-workflows/test-home-guard.test.ts
```

## 关联
- WINDOWS_BASELINE.md §A
- fork 提交 `d881140`（wrapper 沙箱预建 AppData/Local，fork 分支可查）
