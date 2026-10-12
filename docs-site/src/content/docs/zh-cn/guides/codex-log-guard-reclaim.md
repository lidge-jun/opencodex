---
title: Codex Log Guard 空间回收
description: 通过有界的增量清理，手动回收 Codex 诊断日志 SQLite 存储中的空闲页面。
---

回收是 Codex Log Guard 手动释放空间的阶段。只有数据库和运行环境通过与 Log Guard 保护功能相同的安全检查时，它才会压缩 Codex 的规范数据库 `logs_2.sqlite`。

回收**绝不会自动定时运行**，打开 Storage 页面也不会触发。仪表盘要求用户明确点击 Compact 并再次确认，才会发送修改请求。

## 回收会做什么

OpenCodex 会执行一套有界的离线维护步骤：

1. 通过 Codex 生效的 `sqlite_home` 定位规范的 `logs_2.sqlite`；
2. 验证文件身份及已知的 Codex 日志结构；
3. 确认进程枚举成功，且没有受支持的 Codex 写入进程正在运行；
4. 获取专用的跨进程 Log Guard 锁；
5. 持锁期间再次检查 Codex 进程；
6. 以不创建文件的读写方式打开现有数据库，并确认能够立即取得 SQLite 写入锁；
7. 要求现有的 `PRAGMA auto_vacuum` 模式为 `INCREMENTAL`；
8. 维护前运行 `PRAGMA quick_check`；
9. 执行完整的 WAL checkpoint，并拒绝忙碌或未完成的 checkpoint；
10. 分批执行有界的 `PRAGMA incremental_vacuum(N)`，每批之后运行 checkpoint；
11. 维护后再次运行 `PRAGMA quick_check`；
12. 报告维护前后的数据库、WAL、页面数、空闲列表和可回收字节数。

默认每批目标约为 **8 MiB 的 SQLite 页面**。单次调用最多回收约 **256 MiB 的页面**，同时还受有限迭代次数约束。如果仍有空闲页面，结果会标为部分完成，你可以稍后再次点击 Compact。

字节限制会依据数据库实际的 SQLite 页面大小换算成页面数。它们限制的是处理的逻辑 SQLite 页面，并不代表 SSD/NAND 写入量。

## 安全保证

回收明确**不会**：

- 运行完整的 `VACUUM`；
- 修改现有 Codex 数据库的 `auto_vacuum` 模式；
- 直接删除、截断、重命名或以其他方式操作 Codex 的 `-wal` / `-shm` 文件；
- 删除诊断日志行；
- 修改 Log Guard 保护触发器或其他无关的用户触发器；
- 在检测到 Codex 活跃时运行；
- 在进程枚举结果不确定时继续；
- 在遇到未知的未来日志结构时继续；
- 在 SQLite 完整性检查失败后继续。

如果 Log Guard 锁、SQLite 写入锁或初始 checkpoint 忙碌，操作会明确拒绝，不会在后台重试。如果争用只在某个增量清理批次提交后才出现，OpenCodex 会将已完成的工作报告为成功的部分结果，并标注 `stopReason: "busy"`，不会声称完全没有变化。

## CLI

先检查可回收空间：

```bash
ocx storage codex-logs status
```

运行一轮有界维护：

```bash
ocx storage codex-logs compact
```

获取机器可读的前后指标：

```bash
ocx storage codex-logs compact --json
```

如果结果显示仍有可回收空间，除非你明确希望再执行一轮有界维护，否则到此为止。OpenCodex 不会无限循环，也不会替你安排后续运行。

## 管理 API

压缩只通过修改端点提供：

```text
POST /api/storage/codex-logs/compact
```

压缩没有 GET 别名。成功响应包含 `report` 对象，记录前后测量值、回收页面数、主数据库文件物理大小的变化、迭代次数、完成状态、停止原因和完整性状态。

典型的拒绝状态包括：

- `codex_running`：Codex 正在运行
- `process_enumeration_failed`：进程枚举失败
- `busy`：资源忙碌
- `unsupported_schema`：数据库结构不受支持
- `auto_vacuum_not_incremental`：未启用增量清理模式
- `unsafe_path`：路径不安全
- `integrity_check_failed`：完整性检查失败
- `database_error`：数据库错误

完整性失败会注明发生在维护前还是维护后。拒绝状态 `busy` 表示在任何清理批次提交前就检测到了争用；成功报告中的 `stopReason: "busy"` 则表示至少一个批次已提交，后来才因 checkpoint 争用而停止。

## 理解结果

`pagesReclaimed` 和 `logicalBytesReclaimed` 表示本轮从 SQLite 空闲列表中移除的页面。`physicalDatabaseBytesReclaimed` 表示维护 checkpoint 后观察到的主数据库文件缩减量。

这些数值可能不同。SQLite、WAL 和文件系统的行为意味着回收逻辑页面不保证物理文件立即等量缩小；这些指标也都不能解释为 NAND 写入量、SSD 磨损，或已消耗／节省的 TBW。

`complete: true` 表示观察到的空闲列表已归零。部分结果在单次页面预算或有限迭代上限用尽时使用 `stopReason: "page_budget"`；SQLite 不再缩小空闲列表时使用 `stopReason: "no_progress"`；已提交回收后出现 checkpoint 争用时使用 `stopReason: "busy"`。三者都是有界结果，不会触发自动重试。
