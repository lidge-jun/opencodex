---
title: 配置参考
description: opencodex 配置的存放位置、如何应用编辑，以及各配置域的链接。
---

opencodex 会把持久化配置存放在 `$OPENCODEX_HOME/config.json`，通常是
`~/.opencodex/config.json`。在 Windows 上，默认路径是
`%USERPROFILE%\.opencodex\config.json`。

## 配置编辑方式

按任务选择合适的编辑渠道：

- **仪表盘：** 使用 Web UI 进行有引导的 provider、model、agent、access 和 storage 设置。
- **CLI：** `ocx init` 会创建初始文件，而 `ocx provider`、`ocx models`、
  `ocx combo`、`ocx agent` 和 `ocx config` 等命令会更新或检查它们所负责的设置。
- **文件：** 对没有专门 UI 或 CLI 命令的字段，直接编辑 `config.json`。该文件必须保持为有效 JSON。

仪表盘、管理 API 和所有会修改配置的 CLI 命令都会把内容写回同一个文件。优先使用这些
渠道，或者在手工编辑前先停止代理。运行中的进程会把配置保存在内存中，因此后续的在线保存
可能会用快照覆盖你在磁盘上的手工修改。在线保存会在这些路径有明确冲突保护时，合并外部修改过的
`claudeCode` 和监听绑定字段，但这种保护并不覆盖所有子树。

如果文件无法解析，opencodex 会将其备份为
`config.json.invalid-<timestamp>`，在控制台警告，并以默认值启动。文件缺失时也会使用新安装默认值：
一个 `openai` forward provider。

## 优先级与默认值

`config.json` 中的有效值会覆盖内置默认值。缺失的可选字段使用各 domain 页面文档中说明的默认值。
`OPENCODEX_HOME` 的优先级高于默认配置目录。支持环境引用的字段，例如
`apiKey: "${PROVIDER_API_KEY}"`，会在请求时解析该变量。对于出站代理，
已经设置的 `HTTP_PROXY` 或 `HTTPS_PROXY` 会优先于顶层 `proxy` 字段。

路由有自己独立的顺序化解析规则；见 [Routing](/reference/configuration/routing/)。

## 配置域

- [Providers](/reference/configuration/providers/) — provider 条目、认证、端点、目录、allowlist、上下文限制、配额和 provider 特定选项。
- [Routing](/reference/configuration/routing/) — `defaultProvider`、模型解析顺序、combos、别名，以及 combo effort 默认值。
- [Agents](/reference/configuration/agents/) — multi-agent 模式、委派指引、fallback models、native-default 同步和 effort 上限。
- [Server and runtime](/reference/configuration/server/) — 监听与远程访问、admission keys、超时、存储、sidecar、启动行为和 shadow calls。

## 让密钥远离文件

API key 请优先使用 `${ENV_VAR}` 引用。字面量 `apiKey`、`apiKeyPool[].key` 和 `apiKeys[].key`
值都属于 secret；不要提交、粘贴到日志里，或与他人共享。OAuth 和 forward-provider token
会存放在单独的 credential store 中，而不是 `config.json`。account id 和邮箱也应保持私密；
在支持的地方请使用公开的 selector alias。

:::note[原子写入]
opencodex 会通过临时文件再重命名（`atomicWriteFile`）的方式写入托管的 `config.toml` 和 `opencodex-catalog.json` 文件。
这可以避免在并发写入时留下半写入文件，例如 `ocx stop` 和代理 shutdown handler 同时恢复 Codex 的情况。
:::
