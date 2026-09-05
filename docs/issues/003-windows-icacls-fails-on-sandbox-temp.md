# [待提 GitHub] EICACLS — icacls 在 sandbox temp 目录拒绝操作

## 标签
- `bug` `area:windows` `area:test` `priority:P2` `windows-only` `infrastructure`

## 摘要
`tests/codex-integration/native-main-owner-lifetime.test.ts` 5 fails、`tests/codex-integration/native-profile-crash-boundaries.test.ts` 3 fails、`native-profile-stage-lifecycle` / `native-profile-store` 等大量 native 测试，在 `77dc660` 上复现 `ACL hardening failed (EICACLS) — icacls command error; filesystem may not support per-user NTFS ACLs`。

> 哈希 `77dc660` 为 fork 本地提交（`Muki182/opencodex` 分支 `windows-perf-cred-fix`），验证：`git fetch https://github.com/Muki182/opencodex.git windows-perf-cred-fix && git show 77dc660`。

## 根因
`hardenEntryAsync`（`src/lib/windows-secret-acl.ts`，dev 当前约 L857）在 `sandbox` temp 目录（`%TEMP%\ocx-native-owner-*`）上调用 `icacls` 试图给一个 user SID 装 NTFS ACL，但 icacls 在这台机器上反复返回错误。

快照时代栈（符号不变，行号是快照 `d881140` 时代的；dev 上 `sanitizedAclError` 现约 L697、`hardenEntryAsync` 约 L857）：
```
at sanitizedAclError (src/lib/windows-secret-acl.ts:575:21)   # dev ≈ L697
at hardenEntryAsync (src/lib/windows-secret-acl.ts:778:28)    # dev ≈ L857
at async <anonymous> (src/config.ts:300:15)
at async atomicWriteFileAsync (src/config.ts:314:21)
at async writeVault (src/codex/native-profile-manager.ts:420:16)
```

注意：**这台机器无 User Shell Folders 注册表覆盖**——fork 提交 `d881140` 已经修了主路径（wrapper 预建 sandbox AppData/Local），但**写 vault 的 harden 路径**没接到同一修复。

## 建议修复方向
1. `hardenEntryAsync` 探测路径所在 volume 是否支持 NTFS ACL，不支持时**跳过 harden**（与 production home 行为不同，但 sandbox 在 %TEMP% 永远 ephemeral）
2. 或者：把 `%TEMP%` 下的目录识别为"测试 sandbox"——OCX_TEST_HOME env 或 path 包含 `ocx-native-` 前缀就 skip
3. 也可以在 icacls 失败时**仅 warn 不抛**——sandbox 内文件立即删除，攻击窗口短

## 与 dev 相关工作的关系
dev 的 `devlog/_fin/260905_windows_native_final/` 与 `260905_windows_suite_stabilization/` 大规模重构了 Windows native 测试夹具与预算；若 GHA 六分片上 EICACLS 已不复现，本 issue 降级为"本地环境差异记录"。

## 优先级
虽然 sandbox 不影响生产用户，但阻塞了所有 server 级 native profile 测试的可信度，**值得 P2**（若 GHA 已不复现则降级）。

## 关联
- WINDOWS_BASELINE.md §失败根因模式
- fork 提交 `d881140`（wrapper sandbox AppData/Local 预建，是同根问题的另一支）
- fork 提交 `8a68be5`（共享 identity bundle）——即使 SID 喂对，icacls 仍可能失败
