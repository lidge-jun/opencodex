---
title: 服务器与运行时配置
description: 监听、远程访问、准入密钥、超时、存储、侧车、影子调用，以及启动行为。
---

服务器设置控制本地代理如何监听、如何保护远程流量、如何管理资源，以及
如何在提供方请求周围运行辅助功能。

## 服务器字段

| 字段 | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `port` | `number` | `10100` | 代理监听端口。 |
| `hostname?` | `string` | `"127.0.0.1"` | 绑定地址。非回环绑定需要 `OPENCODEX_API_AUTH_TOKEN`。 |
| `proxy?` | `string` | — | 出站 HTTP(S) 或 SOCKS5 代理 URL（`socks5://host:port`），或 `${ENV_VAR}`。HTTP URL 仅在未设置时写入 `HTTP_PROXY` / `HTTPS_PROXY`。SOCKS5 URL 使用内置的真实 SOCKS5 隧道，也会写入 `ALL_PROXY`（`ocx start --socks5`）；并清除本进程继承的 `HTTP(S)_PROXY`。回环地址始终保留在 `NO_PROXY` 中。 |
| `emptyCompletionRetry?` | `boolean` | `false` | 显式启用：当 Responses turn 既无文本也无工具调用时，使用相同请求重试一次，包括流在终止事件之前结束的情况。重试可能产生费用。`OCX_EMPTY_COMPLETION_RETRY=0` 可在不修改配置的情况下禁用；combo 与 routed-compaction turn 不参与。 |
| `stallTimeoutSec?` | `number` | `300` | 在上游没有数据之前可等待的秒数，超过后返回 `response.incomplete`。最小值为 1。 |
| `connectTimeoutMs?` | `number` | `200000` | 每次尝试的 DNS/TCP/TLS/最终响应头截止时间；它在正文生成之前结束。 |
| `shutdownTimeoutMs?` | `number` | `5000` | 优雅停机截止时间，超过后会中止仍在进行中的请求。 |
| `websockets?` | `boolean` | `false` | 声明并允许面向客户端的 Responses WebSocket 路径。设为 false 时客户端使用 HTTP/SSE；它不会禁用符合条件的 canonical ChatGPT 上游 WS 优化。 |
| `corsAllowOrigins?` | `string[]` | `[]` | CORS 额外允许的精确 origin。loopback origin 始终允许；支持 `chrome-extension://<扩展 ID>` 等基于 authority 的浏览器扩展 origin，`*` 不是通配符。Firefox 和 Safari 会（每次安装/启动浏览器时）重新生成扩展 UUID，origin 变化后请更新该条目。 |
| `apiKeys?` | `OcxApiKey[]` | `[]` | 管理平面和非回环绑定上的数据平面身份验证可接受的已生成 `ocx_…` 凭据。由仪表板管理。 |
| `storageCleanupPolicy?` | `StorageCleanupPolicy` | disabled | 可选启用的归档会话清理策略。不会被隐式启用。 |
| `appOwnedMemoryBudgetMb?` | `number` | `256` | 可逐出应用自有日志、缓存、blob 和续传载荷的内存上限，单位 MiB。范围 64–4096；不是 RSS 上限。 |
| `codexAutoStart?` | `boolean` | `true` | 允许 Codex shim 在启动 Codex 之前运行 `ocx ensure`。设为 false 会让 ensure 变成无操作。 |
| `codexShimAutoRestore?` | `boolean` | `true` | 在完成外部 Codex 更新并覆盖安装的 shim 之后恢复该 shim。环境退出开关：`OPENCODEX_CODEX_SHIM_AUTO_RESTORE=0`。 |
| `syncResumeHistory?` | `boolean` | `true` | 可逆的 Codex App 历史兼容性。原始元数据会被备份，并由 `ocx stop` / `ocx restore` 恢复。 |
| `shadowCallIntercept?` | `{ enabled?: boolean; model?: string; sourceModels?: string[] }` | off | 将识别出的 Codex 辅助/影子调用重定向到选定模型，并保留为请求配置的推理强度。默认源前缀为 `gpt-5.6-luna`；0.144.x 及更早客户端使用 `gpt-5.4-mini`，可通过 `sourceModels` 恢复。 |
| `webSearchSidecar?` | `OcxWebSearchSidecarConfig` | 在可用时启用 | Web 搜索侧车选项。 |
| `visionSidecar?` | `OcxVisionSidecarConfig` | 在可用时启用 | 图像描述侧车选项。 |
| `images?` | `OcxImagesConfig` | 自动选择 OpenAI | 用于 Codex `image_gen` 的独立 Images 转发选项。 |

如果较旧的开发版本在尚未提供备份支持之前修改过了 resume-history 元数据，请运行
`ocx recover-history --legacy-openai --yes` 强制使用原生提供方恢复。
此命令会重标所有包含用户消息的 `opencodex` 行，其中包括正常的专用提供方历史记录；执行前请查看生命周期参考中的完整范围警告。

## 远程访问

默认的 `127.0.0.1` 绑定仅限回环地址。像 `0.0.0.0` 这样的非回环地址需要
在 `/api/*` 和数据平面上都启用令牌认证。启动前先导出令牌：

```bash
export OPENCODEX_API_AUTH_TOKEN="your-secret-token"
ocx start
```

如果没有这个变量，代理会拒绝远程绑定。对于后台服务，请在运行
`ocx service install` 之前导出它，这样 launchd、systemd 或 Task Scheduler 都能接收到。客户端应发送：

```text
x-opencodex-api-key: your-secret-token
```

| 端点 | `Authorization: Bearer` | `x-opencodex-api-key` | `x-api-key` |
| --- | --- | --- | --- |
| `/v1/responses` | 不接受 | **必需** | 不接受 |
| `/v1/chat/completions` | 不接受 | **必需** | 不接受 |
| `/v1/messages` | 接受 | 接受 | 接受 |
| `/v1/messages/count_tokens` | 接受 | 接受 | 接受 |
| `/v1/models` | 接受 | 接受 | 接受 |

Responses 和 Chat Completions 会保留 `Authorization`，以便将来可能支持 Codex Direct 透传，因此这里只接受专用的准入头。仪表板生成的 `apiKeys` 可以在启动后替换
环境令牌；候选项按常量时间比较。

Messages 和 `count_tokens` 为兼容路由客户端仍接受三种准入形式。但在非回环绑定上，原生 Anthropic 透传只通过
`x-opencodex-api-key` 接受代理准入，并把 `Authorization` 和 `x-api-key` 保留给 Anthropic
凭据。放入这些提供方请求头的代理准入密钥会在转发前被移除。

:::caution[LAN 暴露]
绑定到 `0.0.0.0` 会将代理及其配置的提供方访问暴露给局域网。仅应在受信任
的网络中配合强令牌使用。
:::

### SSH 端口转发

远程使用并不要求远程绑定。保持回环绑定并将其转发即可：

```bash
ssh -L 20100:localhost:10100 you@remote
```

任意本地端口都可以。Host 解析为 `localhost`、`127.0.0.1` 或 `::1` 的请求无论端口是多少都仍然算回环，因此 `http://localhost:20100/v1` 可以正常工作。在客户端中把这个 base URL 设为目标地址；
`ocx` 只会把默认的本地 `127.0.0.1` 地址写入已管理的客户端配置。

提供方 OAuth 回调监听在固定的远程端口上。请在远程机器上登录，或者也把那个端口转发出来：

```bash
ssh -L 20100:localhost:10100 -L 1455:localhost:1455 you@remote
```

:::caution[转发的回环地址未认证]
普通 `ssh -L` 会监听在你本地的回环地址上，适用于默认的未认证绑定。不要使用 `ssh -g -L`、宽泛的容器端口发布，或会把客户端侧暴露到 `0.0.0.0` 的转发模式。在不确定时，请显式绑定为 `ssh -L 127.0.0.1:20100:localhost:10100`。
:::

## 存储清理

`storageCleanupPolicy` 默认禁用。启用后，它会在 `startup`、`daily`、`weekly` 或
`manual` 时运行，前提是归档字节数超过 `trigger.archivedBytesOver`。它会从最旧的归档开始，直到达到
`target.reduceToBytes` 或 `target.removeOldestPercent`。`mode` 默认为 `quarantine`；只有在明确选择破坏性操作时才使用
`permanent`。该策略会持久化 `lastRun` 和 `nextRun`。可在 Storage 页面配置，或通过 `GET`/`PUT /api/storage/cleanup-policy` 配置；使用
`POST /api/storage/cleanup-policy/run` 触发手动运行。

## Claude Code (`claudeCode`)

这些设置控制 `/v1/messages`、`/v1/messages/count_tokens`、`ocx claude` 启动器，以及 Claude 仪表板页面。

| 键 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `claudeCode.bodyStallSec?` | `number` | `90` | 在读取挂起期间，原生透传正文的不活动预算，单位秒，而不是总时长。最小值为 1；精确的 `0` 会禁用。 |
| `claudeCode.bodyMaxBytes?` | `number` | `67108864` | 流式和缓冲响应的原生透传正文累计上限。精确的 `0` 会禁用。 |
| `claudeCode.authMode?` | `"proxy" \| "subscription"` | auto | 启动流程如何处理 `ANTHROPIC_AUTH_TOKEN`。auto 会在每次启动时自动检测认证；显式值不会被覆盖。 |
| `claudeCode.authModeMigratedAt?` | `string` | unset | 内部的一次性升级标记。不要手动设置。 |
| `claudeCode.subagentEffort?` | `"low" \| "medium" \| "high" \| "xhigh" \| "max"` | inherit | 写入生成的 `~/.claude/agents/ocx-*.md` 的努力级别；与 Codex 指引和代理上限相互独立。需通过 `ocx claude` 重新启动以重新生成。 |

自动认证会在找到已保存的 Claude 认证时选择 subscription，在未找到时选择 proxy；如果检测结果不明确，则会选择 subscription 并给出警告。参见
[Claude Code 认证模式](/guides/claude-code/#auth-mode)。

## 影子调用

Codex 会为标题、提交信息等任务使用较小的辅助模型。启用
`shadowCallIntercept` 后，可将识别出的源模型前缀重定向到另一个已配置模型。替换后仍会保留为请求配置的推理强度。只有当客户端使用不同的辅助 ID 时，才设置 `sourceModels`。

```json
{
  "shadowCallIntercept": {
    "enabled": true,
    "model": "gpt-5.5",
    "sourceModels": ["gpt-5.6-luna"]
  }
}
```

## 侧车

### `images` (`OcxImagesConfig`)

| 字段 | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `provider?` | `string` | 自动选择 OpenAI | 用于 `/v1/images/generations` 和 `/v1/images/edits` 的显式自定义 API key `openai-responses` 提供方。注册表管理的 id 会被拒绝。 |
| `timeoutMs?` | `number` | `300000` | 单次独立 Images 请求的整请求超时。 |

如果提供方缺失、被禁用、不兼容，或者没有可用密钥，显式选择就会失败并关闭；它绝不会回退到另一个付费上游。该端点必须实现 Codex 期望的 OpenAI Images API 路径和响应形状。

### `webSearchSidecar` (`OcxWebSearchSidecarConfig`)

| 字段 | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | 在可用时启用 | 总开关。 |
| `backend?` | `"openai" \| "anthropic" \| "xai" \| "gemini" \| "exa"` | `openai` | 显式配置优先；省略时始终使用 `openai`。`anthropic` 和 `xai` 仅在显式配置时运行；`gemini` 和 `exa` 在 executor 发布前仍为保留值。 |
| `model?` | `string` | 依后端而定 | OpenAI 使用 `gpt-5.6-luna`，Anthropic 使用 `claude-sonnet-5`，xAI 使用 `grok-4.6`。旧的显式 `gpt-5.4-mini` 会在启动时迁移。 |
| `exaApiKey?` | `string` | 无 | `exa` 后端的操作员密钥。仅可写入：管理读取绝不会返回已存储的值。 |
| `xSearch?` | `object` | 省略 | xAI 专用的托管 `x_search` opt-in：`enabled`、互斥的 `allowedXHandles` / `excludedXHandles` 数组（最多 20 项），以及 ISO `fromDate` / `toDate`（`YYYY-MM-DD`）。 |
| `reasoning?` | `string` | `low` | 侧车努力级别。`minimal` 与 web search 不兼容，会被拒绝。 |
| `maxSearchesPerTurn?` | `number` | `3` | 每个主模型轮次允许的实际搜索次数。 |
| `routedModelStallTimeoutMs?` | `number` | `200000` | 仅限配置文件的 routed-model 原始正文不活动截止时间。整数范围 1–2147483647；每个非空数据块都会重置它。 |
| `timeoutMs?` | `number` | `60000` | 单次托管搜索的截止时间。 |

OpenAI 后端要求已登录 ChatGPT，并启用了 ChatGPT `forward` 提供方。来自 Claude 的入站
routed 重放会把主 ChatGPT 认证注入内部请求。Anthropic 后端使用的是来自已启用 Anthropic OAuth 提供方的当前保存凭据。如果显式选择了 Anthropic 后端但没有可用账户，则会失败并关闭，而不会回退。Anthropic 执行器使用其原生的 `web_search_20250305` 工具。xAI 后端要求有可用的已存储 Grok OAuth 账户，使用托管 `web_search`，并在 `xSearch.enabled` 为 true 时添加托管 `x_search`。格式错误的 `xSearch` 管理输入会返回 `400`；格式错误的持久化块会在规划期间失败并关闭。`gemini` 和 `exa` 通道绝不会因凭据发现或回退而激活；操作员必须显式选择它们。`exaApiKey` 可在写入时接受，但会从管理响应中省略。

搜索由四个时钟共同约束：基础 `stallTimeoutSec`、`connectTimeoutMs`、routed-model 不活动超时，以及
托管搜索超时。有效的桥接看门狗是最大值再加 30 秒。routed stall 是不活动保护，而不是总生成截止时间。

### `visionSidecar` (`OcxVisionSidecarConfig`)

| 字段 | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | 在可用时启用 | 图像描述总开关。 |
| `backend?` | `"openai" \| "anthropic"` | auto | 显式值优先；未设置时优先使用可用的已保存 Anthropic OAuth 凭据，否则使用 `openai`。 |
| `model?` | `string` | 依后端而定 | OpenAI 使用 `gpt-5.4-mini`，Anthropic 使用 `claude-sonnet-5`。 |
| `reasoning?` | `"low" \| "medium" \| "high" \| "xhigh" \| "max"` | `"low"` | OpenAI Responses 推理强度；Anthropic 会忽略该项。 |
| `maxDescriptionsPerTurn?` | `number` | `8` | 每个主轮次允许的新增描述缓存未命中次数。`0` 会禁用调用；无效值会使用默认值。 |
| `timeoutMs?` | `number` | `45000` | 侧车获取超时。整数 1–2147483647。 |

支持的等级受上游提供方能力与所选模型公布的推理阶梯限制。Vision 只会对发送给其提供方 `noVisionModels` 中模型的图像生效。OpenAI 具有与 search 相同的登录/forward 要求；显式选择的 Anthropic 在没有可用凭据时会失败并关闭。成功的 `data:` 描述会使用一个受限缓存，其键由后端、模型、detail、图像字节以及规范化消息上下文组成；OpenAI 的键还会额外包含推理强度（Anthropic 键不含）。命中和同轮重复不会消耗限额。远程 `https:` 图像以及失败或空的描述不会被缓存。

Anthropic OAuth 侧车会复用 opencodex 现有的 Claude Code OAuth 指纹。请对目标账户和负载进行 soak 测试。

## Remote Hub 密钥与默认值

`runtimeRole` 默认为 `standalone`。Hub 使用 `hub.managementPublicOrigin`、仅回环的 `hub.managementIngress`（缺省为 `enabled:false`）和准确的 `remoteGui.allowedTailscaleUsers`（缺省为空）。客户端密钥保存在 `service-api-token` 而不是 `config.json`；轮换期间可能暂时存在 `service-api-token.prev`。使用记录不会镜像。

`remoteGui.allowInsecureHttp` 是已弃用的 no-op，仅为让旧的严格 schema 配置继续加载而保留。请从配置中删除它：pairing grant 只接受 loopback 或已认证的 HTTPS；设为 `true` 也不会重新开放明文 HTTP pairing。
