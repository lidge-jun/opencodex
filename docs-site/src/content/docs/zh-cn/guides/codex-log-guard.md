---
title: Codex Log Guard
description: 检查并明确控制 Codex 诊断日志的持久化，同时不暴露日志正文。
---

OpenCodex 可以检查 Codex 的持久化诊断日志数据库；在你主动启用后，还能减少 Codex 持久保存的诊断日志行。检查始终只读。保护是明确的修改操作；除非数据库具备已知的 Codex 日志结构且 Codex 已停止，否则会拒绝执行。

## 检查结果包含什么

OpenCodex 按 Codex 原有的优先级解析生效的 `sqlite_home`，检查其中规范的 `logs_2.sqlite` 数据库。编号更高或旧版的 `logs_N.sqlite` 文件绝不会被替代为可修改的目标。

Storage 视图报告：

- 主数据库、WAL 和 SHM 文件大小；
- 日志行总数，以及以 `TRACE` 级别保存的比例；
- 按行数排序的主要日志目标分组，以排名标签代替目标名称；
- 将来可能回收的 SQLite 空闲列表空间；
- 观察到的结构是否兼容当前已知的 Codex 日志结构。

如果 `sqlite_home` 位于 `CODEX_HOME` 之外，诊断数据库会单独显示；其字节数不会被悄悄计入现有的 `CODEX_HOME` 存储总量。

生成这些诊断信息时，OpenCodex 不会选取或暴露 `feedback_log_body`。日志级别会归入固定的已知级别集合及 `OTHER`，目标名称不会被序列化。

## 保护模式

保护功能**默认关闭**。启用后，会在 Codex 规范的 `logs_2.sqlite` 数据库中安装一个由 OpenCodex 拥有的 `BEFORE INSERT` 触发器。OpenCodex 绝不会替换使用其保留名称的未知触发器，也只会移除 SQL 与其自有版本匹配的触发器。

提供两种模式：

- **Compatibility**（`compat`）是推荐模式。它将当前 Log Guard v1 规则固定于高流量目标，这些目标已被当前 Codex 的持久化 SQLite 日志接收端过滤或降低级别。其他 `TRACE` 行仍会保留。
- **Quiet**（`quiet`）会抑制所有新的 `TRACE` 行，同时保留 `DEBUG`、`INFO`、`WARN` 和 `ERROR` 行。

保护功能会减少进入持久化 SQLite 存储的行数，但**不会**消除 Codex 更早阶段的追踪工作：事件仍可能被格式化、排队、组成事务，并由 Codex 自身的清理逻辑处理，然后才被触发器忽略。应将 Protect 视为减少持久写入活动的屏障，而不是关闭 Codex 内部诊断生成的开关。

Log Guard 只过滤本地 SQLite 中持久化的日志行。它不会改变 Codex 诊断处理、[adapter 传输](/zh-cn/reference/adapters/)、provider 载荷、流式语义、认证、路由、配额或账户状态。

### 安全检查

在 Protect、Disable 或 Repair 修改外部数据库之前，OpenCodex 会：

1. 精确解析规范的 `logs_2.sqlite` 路径；
2. 验证路径指向普通文件而非符号链接，且已知结构完全匹配；
3. 确认进程枚举成功，且没有受支持的 Codex 写入进程正在运行；
4. 获取专用的跨进程 Log Guard 锁；
5. 持锁后再次检查 Codex 进程；
6. 以**不创建文件**的读写方式打开数据库，并在不等待忙锁的情况下取得 SQLite `BEGIN IMMEDIATE`；
7. 只修改 OpenCodex 自有的 Log Guard 触发器，并在提交前读回结果；
8. 仍持有 Log Guard 锁时，将请求的模式保存到 OpenCodex 配置。

如果进程枚举不确定、数据库忙碌、结构未知，或保留的触发器名称对应不同的 SQL，修改会安全拒绝。OpenCodex 不会自动终止 Codex。

## 偏移与修复

请求的保护模式保存在 OpenCodex 配置中，与 Codex 日志数据库分开。这一点很重要，因为 Codex 迁移可能重建 `logs` 表，而 SQLite 会删除附着在被替换表上的触发器。

当保存的模式为 `compat` 或 `quiet`，但未观察到相应的自有触发器时，Log Guard 会报告 **drifted**。`ocx doctor` 会报告偏移，但绝不会自动修复。

修复需要明确执行：

```bash
ocx storage codex-logs repair
```

OpenCodex 特意不会在每次启动时重建保护。只有获得足够的实际使用证据，证明跨 Codex 迁移这样做是安全的，后续版本才可能重新考虑自动修复。

## CLI

读取状态：

```bash
ocx storage codex-logs status
ocx storage codex-logs status --json
ocx doctor
```

启用推荐的兼容策略：

```bash
ocx storage codex-logs protect
```

明确选择安静模式：

```bash
ocx storage codex-logs protect --mode quiet
```

关闭 OpenCodex 保护或修复偏移：

```bash
ocx storage codex-logs unprotect
ocx storage codex-logs repair
```

在 Log Guard 命令后加上 `--json` 可获得机器可读的输出。规范的命令语法和 JSON 行为请参阅 [CLI 参考](/zh-cn/reference/cli/)。

现有命令保持不变：

```bash
ocx storage --json
```

其响应包含与 Storage 页面相同的 Codex 日志状态。

## 管理 API

状态查询端点：

```text
GET /api/storage/codex-logs
```

明确修改操作使用：

```text
POST /api/storage/codex-logs/protect
POST /api/storage/codex-logs/unprotect
POST /api/storage/codex-logs/repair
```

Protect 请求体为 `{"mode":"compat"}` 或 `{"mode":"quiet"}`。`GET /api/storage` 也会将报告包含在 `codexLogs` 中，让仪表盘通过一次快照请求同时刷新常规存储细分和 Codex 日志诊断信息。

## 只读快照语义

状态检查使用 SQLite `immutable=1` 以只读方式打开数据库，避免诊断读取创建或更新 `-wal`、`-shm` 附属文件。

这一做法有取舍：SQL 聚合结果与观察到的触发器元数据反映的是最近一次 checkpoint 的数据库快照。如果 Codex 正在写入，实时 WAL 中可能有比不可变快照更新的行或结构页面。成功的修改响应使用 OpenCodex 在写事务内验证的触发器状态；之后的只读状态请求可能暂时落后，直到 SQLite 对这些结构页面执行 checkpoint。

OpenCodex 单独报告 WAL 文件大小，**不会**将结果标为 SSD 写入速率、NAND 写入量或硬盘磨损／TBW 消耗。

## 兼容性状态

已知结构会报告检查与保护均受支持。缺失、无法读取或未知的未来结构仍可检查元数据，但会报告为不支持可修改操作。

不会猜测未知结构是否兼容。这样既能观察较新版本的 Codex，又不会让 Log Guard 将未经审查的数据库布局当作可安全修改。

## 空间回收仍是独立操作

Protect 不会对 SQLite 执行清理或压缩。[**Reclaim**](/zh-cn/guides/codex-log-guard-reclaim/) 已提供带 checkpoint 和完整性检查的明确、离线、有界增量清理流程。

Protect 从不运行 `VACUUM`，从不直接截断或删除 Codex 的 WAL，也不会定时回收空间。
