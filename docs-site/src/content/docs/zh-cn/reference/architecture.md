---
title: 架构
description: opencodex 内部机制 —— 模块图、请求解析器、AdapterEvent 桥接与缓存。
---

opencodex 运行在单个 Bun 进程中。请求以 OpenAI Responses 格式进入，规范化为内部模型后完成
路由，再由 adapter 发送到 provider，最后桥接回 Responses SSE。端到端流程参见
[工作原理](/opencodex/zh-cn/getting-started/how-it-works/)。

## 模块图

```
src/
├── cli/                # ocx command dispatch, init, status, provider commands
├── server/             # Bun.serve, /v1/* proxy, /api/* management API, WS bridge
├── codex/              # Codex config injection, catalog sync, auth/account integration
├── providers/          # provider metadata, API-key pool, quota and labels
├── adapters/           # seven wire adapters, shared guards/utilities, Cursor protobuf transport
├── oauth/              # OAuth providers, API-key catalog, token store/refresh
├── usage/              # request usage extraction, JSONL logs, summaries, totals
├── lib/                # runtime, process, retry, privacy, token estimate helpers
├── web-search/         # web-search sidecar (synthetic tool, loop, executor, parser)
├── vision/             # vision sidecar (describe + plan)
├── config.ts           # ~/.opencodex/config.json, defaults, PID, env resolution
├── router.ts           # model id → provider + adapter
├── bridge.ts           # AdapterEvent stream → Responses SSE / JSON
├── reasoning-effort.ts # reasoning-effort translation, clamping, and catalog levels
├── responses/
│   ├── parser.ts       # Responses request → OcxParsedRequest
│   ├── schema.ts       # Zod validation
│   └── compaction.ts   # remote compaction prompts, envelopes, compact history
├── service.ts          # launchd / systemd / Task Scheduler background service
├── types.ts            # core interfaces + helpers (modelInList, namespacedToolName)
└── index.ts            # public entry
```

## 请求流程

`server/index.ts` 负责 HTTP 边界，并把 Responses data plane 交给 `server/responses.ts`：

1. `server/index.ts` 应用 CORS 和 API 认证，在 drain 期间拒绝新请求，并记录请求生命周期
   metadata。它提供 `GET /v1/models`、`POST /v1/responses`、
   `POST /v1/responses/compact`、`POST /v1/images/generations` / `POST /v1/images/edits`
   （供 Codex 内置 `image_gen` 工具使用——由 `server/images.ts` 中继到 OpenAI 系上游），
   以及 `/v1/responses` 上可选的 WebSocket upgrade。
2. `server/responses.ts` 解压并解析 JSON；如果本地记住了对应输入，则展开
   `previous_response_id`，随后调用 `responses/parser.ts`。
3. `router.ts` 解析 bare id 或 `provider/model` id。server 随后确定 Codex account affinity，
   必要时刷新 provider OAuth，并把选中的 credential 应用到 route。
4. 主请求发出前，`vision/` 会为 `noVisionModels` 中的模型描述图像。如果没有安全的 sidecar
   路径，则移除图像，而不是把它发送给纯文本上游。
5. `server/adapter-resolve.ts` 应用模型级 wire override，并构造七个 adapter 之一。Responses
   passthrough 直接转发原始 body；Cursor 运行双向 `runTurn` transport；其余转换型 adapter
   则构建、获取并解析上游请求。
6. 路由模型请求托管的 `web_search` 工具时，`web-search/` 会暴露一个合成函数，经 ChatGPT
   sidecar 执行真实搜索，把结果送回路由模型，并在配置的循环上限内重复。
7. `bridge.ts` 生成 Responses SSE 或 JSON。`server/request-log.ts` 与 `usage/` 在不改变响应的
   前提下收集终止状态、延迟、provider/model 标签和尽力估算的 token usage。

## 解析器

`responses/parser.ts` 使用 `responses/schema.ts`（Zod）校验传入请求，然后构建
`OcxParsedRequest`：

- **消息（Messages）** —— `input` 条目会变成规范化的 `OcxMessage[]`：user / developer /
  assistant / toolResult。`reasoning` 条目变成 thinking block；`function_call`、
  `custom_tool_call`、`tool_search_call` 条目变成工具调用；对应的 `*_output` 条目变成工具结果。
- **工具（Tools）** —— function 工具直接透传；**带命名空间的（MCP）工具会被扁平化**为
  `namespace__name`，并在返回时还原；**自由格式（freeform）**工具（如 `apply_patch`）和
  **tool_search** 发现工具会被标记；**托管工具（hosted tools）**（`web_search`、图像生成等）
  会被移除，只有 sidecar 确定会处理时才重新注入。
- **图像（Images）** —— 作为真实 content part（data URL 或远程 https）保留，绝不会内联成
  文本。
- **功能标志（Feature flags）** —— `_webSearch`（请求了托管网络搜索）、
  `_structuredOutput`（`text.format` 为 json_schema / json_object）和
  `_compactionRequest`（remote compaction v2）。

## 桥接器

`bridge.ts` 把 adapter 的内部 `AdapterEvent` 流转换回 Codex 能理解的 Responses SSE：

| AdapterEvent | 发出的 Responses SSE |
| --- | --- |
| `text_delta` | `response.output_text.delta` → `…done`、`response.content_part.done`、`response.output_item.done` |
| `thinking_delta` | `response.reasoning_summary_text.delta` → `…done`、item close |
| `reasoning_raw_delta` | 原始 `reasoning_text` item（或隐藏的往返 envelope） |
| `thinking_signature` / `redacted_thinking` | 保存在 `encrypted_content` reasoning envelope 中 |
| `tool_call_start` | `response.output_item.added`（type：`function_call` / `custom_tool_call` / `tool_search_call`） |
| `tool_call_delta` | `response.function_call_arguments.delta`（freeform / tool_search 会跳过） |
| `tool_call_end` | `response.function_call_arguments.done` → `response.output_item.done` |
| `web_search_call_begin` / `web_search_call_end` | 一个实时 `web_search_call` item，加上 URL citation |
| `heartbeat` | 标记上游仍在活动；不产生用户可见的输出 item |
| `done` | `response.completed`（带 usage） |
| `error` | `response.failed`（带 `last_error`） |

桥接器还会运行**心跳保活**（RC3）：上游没有数据时，每 2 秒发送一次解析器会忽略的
`response.heartbeat` SSE event，以重新启动 Codex 的空闲计时器。默认**停滞截止时间**为 300 秒
（`stallTimeoutSec`）；达到该时限后会中止上游，并发出 reason 为
`upstream_stall_timeout` 的 `response.incomplete`，避免挂起的连接无限期阻塞 Codex。

解析器捕获的命名空间映射、freeform 集合与 tool-search 集合会把工具调用区分为三种 Responses
item，因此 MCP 命名空间、`apply_patch` 风格的 freeform 工具和客户端执行的 `tool_search` 都能
完整往返。`buildResponseJSON()` 变体会用同一批 event 生成单个非流式响应对象。

## 管理 API、OAuth 与用量

`server/management-api.ts` 为仪表盘提供后端。其 `/api/*` route 涵盖安全的配置/设置、provider
CRUD 与 key pool、模型选择/context cap/v2 控制、catalog sync、诊断与 debug log、usage 与
quota、sidecar 设置、更新、生成客户端 API key、OAuth 登录/状态/登出与账号选择、Codex 账号
管理，以及 graceful stop。proxy 绑定到 loopback 之外时，`server/auth-cors.ts` 会要求
`/api/*` 和 `/v1/*` 都提供 `OPENCODEX_API_AUTH_TOKEN`；配置的 `corsAllowOrigins` 会扩展本地
origin allowlist。

OAuth 实现在 `oauth/` 中；每次路由调用前都会即时加载或刷新 access token，而
`oauth/token-guardian.ts` 只会主动刷新策略允许的 provider。Codex/ChatGPT pool credential 与
thread affinity 位于 `codex/` 下，不会出现在管理 API 响应中。请求用量会规范化为 `OcxUsage`，
显示在 Responses 终止 event 中，并由 `usage/` 汇总，供仪表盘和可选的 JSONL 诊断使用。

## 传输与 compaction

`server/index.ts` 默认在 `/v1/responses` 上提供 HTTP/SSE。当 `websockets` 为 `false` 而 Codex
尝试 Responses WebSocket upgrade 时，opencodex 会返回 `426 upgrade_required`，Codex 随后在该
session 中回退到 HTTP。设置 `"websockets": true` 后，同一 endpoint 会接受 upgrade 并使用
WebSocket bridge。

Codex context compaction 同样适用于路由模型。`server/responses.ts` 处理
`POST /v1/responses/compact`，运行一次内部路由 summarization turn 并返回压缩后的历史；
`responses/parser.ts` 与 `bridge.ts` 则处理 remote compaction v2 的 `compaction_trigger` turn，
准确发出一个合成的 `compaction` 输出 item。

## 缓存与目录

- `codex/model-cache.ts` 为每个 provider 维护实时 `/models` 结果的内存 TTL 缓存（默认 5 分钟，
  与 Codex 自身缓存一致），获取失败时会回退到旧数据。
- `codex/catalog.ts` 把路由模型作为带命名空间的条目合并进 Codex 目录，优先排列精选的
  [subagent 模型](/opencodex/zh-cn/guides/codex-integration/#subagent-选择器)，过滤
  `disabledModels`，并可从一次性备份中完整恢复原始目录。

## Reasoning effort

`reasoning-effort.ts` 把 Codex 的 reasoning 标签转换为各 provider 的 wire 值。Codex 目录会
公布 Codex 接受的标签（`low` / `medium` / `high` / `xhigh` / `max`），但上游 provider 可能只
支持更小的子集，或要求真实 alias。该模块会：

- 定义标准的 `CODEX_REASONING_LEVELS` 及其排序。
- 精确级别不可用时，把请求的 effort 限制到最接近的支持层级。
- 解析模型级和 provider 级 `reasoningEffortMap` override，用于自定义 wire 映射。
- 对 `noReasoningModels` 中的模型完全移除 effort。

## 核心类型

内部模型位于 `types.ts`：`OcxParsedRequest`、`OcxContext`、`OcxMessage` 联合类型、
`OcxContentPart`（text / image）、`OcxToolCall`、`OcxTool`、`AdapterEvent`，以及配置类型
（`OcxConfig`、`OcxProviderConfig`）。两个常用 helper 是 `namespacedToolName()` 和
`modelInList()`；后者会在匹配 `noVisionModels` / `noReasoningModels` 时容忍 `:size` 标签。
