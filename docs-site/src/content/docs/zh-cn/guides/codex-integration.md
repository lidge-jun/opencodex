---
title: Codex 集成
description: opencodex 如何将自身注入 Codex、同步模型目录、安装 shim，并干净地恢复。
---

opencodex 通过修改 Codex 读取的两样东西，让 Codex 经由 proxy 路由：它的 config
（`$CODEX_HOME/config.toml`，默认 `~/.codex/config.toml`）和它的 model catalog。每一次修改都
是幂等且可逆的。

proxy 提供一条裸 `openai` Codex 登录路由，支持 Pool（默认）和 Direct 账号模式，另有
`openai-apikey/<model>` 对应已配置的 API key。Pool 包含主账户加已添加账户；Direct 只使用调用方/
主 bearer。这些路由之间不会互相 fallback。已发布的 v1 config 会迁移到 marker 2，并保留
`config.json.pre-openai-tiers-v2.bak` 供手动恢复。

## Config 注入

`ocx init`、`ocx start` 和 `ocx sync` 都会调用注入器。在默认的 loopback 绑定下，它会保留
Codex 内置的 `openai` provider id，并将该 provider 指向 opencodex：

```toml
# root keys, before the first table
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"
# Auto-injected by opencodex
openai_base_url = "http://127.0.0.1:10100/v1"

# 仅在设置了 fastMode 时写入；未设置则不会创建 [features] 表
[features]
fast_mode = true
```

注入的 `fast_mode` 遵循三态 `fastMode` 配置：`true` 写入 `fast_mode = true`，`false` 写入
`fast_mode = false`，未设置时保留用户已有的 `fast_mode` 且不添加 `[features]` 表。

proxy 默认监听 `10100` 端口，并提供 `POST /v1/responses`、`POST /v1/responses/compact`、
`POST /v1/images/generations`、`POST /v1/images/edits`、`GET /v1/models`、`GET /healthz`，
以及 `/api/*` 管理面。

### 内置图像生成（`image_gen`）

Codex 内置的 `image_gen` 工具不会经过 `/v1/responses` —— codex-rs 扩展会直接 POST
`{base_url}/images/generations`（附带参考图像时则为 `/images/edits`），并使用它在聊天时相同的
ChatGPT bearer auth。由于注入的 `base_url` 指向 opencodex，proxy 会把这些调用中继到 OpenAI
上游。

这与 [Image Bridge](/guides/image-bridge/) 是分开的；后者只会在某个 **Responses** 回合列出
托管的 `image_generation` 工具、且当前选中了非 OpenAI 模型时才会激活。单独的
`/images/generations` 调用不会进入这个 bridge。

- **单一、感知模式的 forward 候选：** Pool 会选择一个符合条件的主账户/已添加账户；Direct 使用
  调用方 OAuth bearer。所配置的模式会一致地作用于图像请求。
- **OpenAI API-key provider：** 只有在没有 forward 候选持有认证失败时才会使用它。损坏或过期的
  Pool 凭据不会被单独计费的 API 用量遮盖。
- **显式自定义 provider：** 将 `images.provider` 设为一个自定义 API-key
  `openai-responses` provider 的 id，该 endpoint 必须实现 OpenAI Images API。显式选择会失败即关闭，
  不会 fallback 到其他付费上游。这里不接受 registry 管理的 provider id；省略 `images.provider`
  即可使用内置的 OpenAI tiers。
- **Google Antigravity（CCA）fallback：** 当既没有 OpenAI forward 候选，也没有已配置的 keyed
  provider 时，`/v1/images/generations`（不是 `/images/edits`）会 fallback 到 Antigravity
  **Cloud Code Assist** endpoint，并使用 `gemini-3.1-flash-image` 模型。该 fallback 也会在
  OpenAI auth 解析失败后触发（例如 ChatGPT 凭据过期或缺失），而不只是没有配置任何 OpenAI 候选时才触发。
  这需要 `ocx login google-antigravity`；OAuth token 只会发送到固定的 CCA registry host，
  不会发送到配置级别的 `baseUrl` override。响应会以 Codex 期望的同一
  `{created, data:[{b64_json}]}` 形状返回。
- **两者都不是：** proxy 会返回清晰的错误，而不是泛化的 404。路由型 provider（Cursor、Gemini、
  Kiro 等）无法提供 `image_generation` 工具中继；如果你根本不想让这个工具被提供出来，可以在 Codex 中
  用 `codex features disable image_generation` 关闭它（即 `config.toml` 中
  `[features] image_generation = false`）。

工具声明仍会随模型的 Responses 请求一同发送。对于 API-key Responses provider，opencodex 会把
Codex 私有的 `image_gen` namespace 降级为上游安全的 `image_gen__<inner-name>` alias（例如
`image_gen__imagegen`）。当这个可用 alias 取代客户端声明时，opencodex 会移除重复的 hosted
`image_generation` 声明。它会在 Codex 看到之前把函数调用映射回显式的 `image_gen` namespace，
并在之后将历史记录重放到上游时再次编码原生调用。这样即可让客户端侧图像生成在那些保留该 namespace，
或拒绝带点号函数名的公有兼容上游上继续可调用。ChatGPT forward 模式保持不变，并维持其原生
Responses Lite 形状。

对于 OpenAI-compatible 的自定义 gateway，请配置一个专用 provider，并只在独立的 Images 请求中选用它：

```json
{
  "providers": {
    "custom-images": {
      "adapter": "openai-responses",
      "baseUrl": "https://gateway.example.com/v1",
      "authMode": "key",
      "apiKey": "${IMAGE_GATEWAY_API_KEY}"
    }
  },
  "images": {
    "provider": "custom-images",
    "timeoutMs": 300000
  }
}
```

该自定义 endpoint 必须接受 `POST /v1/images/generations` 和 `/v1/images/edits`，并返回 Codex 期望的
OpenAI Images 响应形状。provider 配置的 key 会在上游请求前替换任何调用方 bearer。

> **Note:** 这里仅指 Codex 的 `image_generation` 工具（`/images/generations` relay）。
> 具备图像能力的 Gemini 模型会通过 `google` adapter（使用 `responseModalities: ["TEXT", "IMAGE"]`）
> 原生生成内联图像，与这个 relay 无关 —— 参见 [Adapters](/reference/adapters/#google)。

对于非 loopback 的 `hostname`，Codex 必须发送生成出来的 API auth header。因此注入器会改用一个
专用 provider：

```toml
# root keys
model_provider = "opencodex"
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"

# appended at the end of the file
# Auto-injected by opencodex
[model_providers.opencodex]
name = "OpenCodex Proxy"
base_url = "http://your-host:10100/v1"
wire_api = "responses"
requires_openai_auth = true
env_key = "OPENCODEX_API_AUTH_TOKEN"
# supports_websockets = true   # only when config.websockets is true
```

当 OpenCodex 负责路由时，两种模式都会把 `$CODEX_HOME/opencodex.config.toml` 写成参考/回退配置。
在 loopback 情况下，它包含可在自动注入被移除后手动合并的 root keys；在非 loopback 情况下，
它包含专用 provider 形式。外部 provider 模式会保持这个 profile 不变。

:::caution
像 `openai_base_url`、`model_provider` 和 `model_catalog_json` 这样的 root keys **必须** 位于第一个
`[table]` 头之前。注入器会保证这一点，移除自己留下的陈旧/重复副本，并且绝不会覆盖用户拥有的 root
`openai_base_url`；如果已经存在一个这样的值，sync 仍会更新 catalog，但会报告路由没有被注入。
:::

## 共享模型目录

Codex CLI、TUI、App 和 SDK 都读取同一个 Codex home。opencodex 会从 `CODEX_HOME` 解析该目录，
回退到 `~/.codex`，并管理：

```text
$CODEX_HOME/config.toml
$CODEX_HOME/opencodex.config.toml
$CODEX_HOME/opencodex-catalog.json
$CODEX_HOME/models_cache.json
```

在 WSL 中，如果未设置 `CODEX_HOME`，且 Linux 侧的 `~/.codex/config.toml` 不存在，opencodex 还会检查
`/mnt/c/Users/*/.codex/config.toml` 下是否存在单一的 Windows Codex Desktop home。只要候选项恰好只有一个，
它就会使用那个目录，让 WSL app-server mode 和 Windows Codex Desktop 共享同一份 config 与 auth 文件。
如需覆盖这一检测，请显式设置 `CODEX_HOME`。

在 Windows 上，Orca shell 可能会把 `CODEX_HOME` 和 `ORCA_CODEX_HOME` 都设置为 Orca 打包的 runtime home，
而 ChatGPT/Codex app 仍然读取 `%USERPROFILE%\\.codex`。`ocx status` 和 `ocx doctor` 会提示这个确切的不一致，
并打印经过脱敏的目标路径。如果某个后台服务是在那个 Orca shell 中安装的，请先在原始 shell 中卸载它，
然后把 `CODEX_HOME` 设为 app home，取消 `ORCA_CODEX_HOME`，重新运行 sync/restore，再安装一次服务。

在专用 provider 模式下，`requires_openai_auth = true` 会让 Codex App/TUI 中受账号门控的界面与原生 Codex 保持一致。
opencodex 也会通过 WebSocket 提供 `/v1/responses`。专用 provider 只有在 `"websockets": true` 时才会声明
`supports_websockets = true`；在 loopback 情况下，Codex 的内置 provider 可能会先尝试 WebSocket，而关闭的 proxy
会返回 `426`，从而让 Codex fallback 到 HTTP/SSE。

## 线程标识与历史记录

默认的 loopback 形式会让新线程继续标记为 Codex 原生的 `openai` provider，因此正常的 resume history 不需要
重映射。sync 和 restore 只应用与当前状态数据库匹配的备份 manifest，并精确恢复每个线程原来的 provider、
source 和 event marker。没有 manifest 的 `opencodex` 行会保持不变；只有明确要强制执行旧式重标记时，才使用
`ocx recover-history --legacy-openai --yes`。此命令的作用范围有意设置得很广：它会把所有包含用户消息且当前标记为
`opencodex` 的线程改标为 `openai`，将 `exec` 规范化为 `cli`，并设置事件标记；正常的专用提供方历史记录也在
范围内。请先备份状态，并且仅在确实需要这一完整范围时使用。非 loopback 的专用 provider 模式在运行期间仍会把历史记录镜像到
`opencodex` provider 名下，并在退出时恢复已备份的 metadata。如需保持历史记录完全不变，请设置
`syncResumeHistory: false`。

## 模型目录同步

Codex 显示的模型来自一个磁盘上的 catalog（默认是 `$CODEX_HOME/opencodex-catalog.json`）。在启动时以及执行
`ocx sync` 时，opencodex 会：

1. **备份**一次干净的 catalog 到 `~/.opencodex/catalog-backup.json`（这样 featuring 是可逆的）。
2. **抓取**符合条件的 provider 的实时模型 catalog（缓存约 5 分钟；失败时先回退到上一个正常列表，再回退到
   已配置的 `models[]`）。forward auth 没有模型 endpoint，而 Cursor 使用它自己的 `GetUsableModels` RPC，
   不是 `/models`。
3. **合并**路由模型，把它们作为带命名空间的条目（`provider/model`）加入，且从原生 Codex catalog 模板克隆，
   以便 Codex 的严格 parser 能接受它们。
4. **过滤** `config.disabledModels` 和每个 provider 的非空 `selectedModels` allowlist。
5. **重新排序**，让 featured models 排在最前（见下文），然后把合并后的 catalog 写回去。

路由目录条目还会把 GPT-5 身份文案改为真实的上游模型名称。reasoning 选项会依据提供商和模型元数据，
使用 Codex 的 `low | medium | high | xhigh | max | ultra` 档位；上游不支持的值会在发送请求前完成
映射或下调。

### 路由模型的本地工具

非原生的路由 catalog 条目使用 `tool_mode: "code_mode_only"`。这样 Codex 可以公开其官方 `exec` 入口以及
嵌套的 MCP 工具，包括 Browser 和 Computer Use；opencodex 只负责路由模型发起的普通 function call。
工具执行、权限和确认仍由 Codex 在本地处理；opencodex 不会实现另一套浏览器或桌面控制 executor。

对于不接受 Codex `exec` custom-tool grammar 的 key-auth Responses provider，opencodex 会把该工具声明及其
历史记录编码成上游 function tool，再在 Codex 收到结果前，把流式 function-call lifecycle 还原成
`custom_tool_call`。原生 OpenAI forward routing 和已支持的 `apply_patch` custom tool 保持不变。

所选 provider 必须支持 function/tool calling。不支持 tool call 的 text-only provider 无法使用 `exec`、
Browser 或 Computer Use。原生 OpenAI 条目会保持其上游 tool mode 不变。

`ocx sync` 修改这些 metadata 后，请重启 Codex App 并打开一个新任务。现有 app-server process 和任务可能仍会
保留它们在启动时加载的 catalog 和 tool plan。

### 自定义模型显示名

一个自定义模型可以带一个人类可读的 **display name**，覆盖 Codex 在模型选择器里显示的标签，而不会改变模型
的路由方式。display name 只会映射到 catalog 条目的 `display_name` 字段——routing slug
（`<provider>/<model>`）、alias 冲突顺序、provider，以及原生 OpenAI marketing names 都保持不变。

可以通过 CLI 添加 display name（proxy 在线时会立即同步 catalog）：

```bash
ocx models add deepseek deepseek-v4 --display-name "DeepSeek V4" --context-window 128000
```

远程 Codex 客户端可以使用普通的数据面密钥（与 `/v1/responses` 所用凭据相同，而非管理员令牌）拉取同一个生成好的 catalog：

```bash
dest="${CODEX_HOME:-$HOME/.codex}/opencodex-catalog.json"
tmp="$(mktemp "${dest}.XXXXXX")"
curl -fsS -H "x-opencodex-api-key: $OPENCODEX_API_AUTH_TOKEN" \
  "https://proxy.example.com/v1/catalog" > "$tmp" \
  && mv "$tmp" "$dest"
ocx sync-cache
```

响应就是原始的 `opencodex-catalog.json` 文档（不含 provider 凭据）。当可用时，
`x-opencodex-codex-version` header 会报告服务器上的 Codex runtime 版本，方便客户端发现版本偏移。

你也可以通过管理 API（`POST /api/custom-models`、带 `displayName` 字符串的 `PUT /api/custom-models/<id>`）
以及 web dashboard 来设置或编辑它。因为会与路由 slug 分隔符冲突，所以 `/` 会被拒绝。

`GET /v1/catalog` 的存在是为了让读取模型列表不再需要管理员令牌。该路由为只读（`GET` 与 `HEAD`），接受 `x-opencodex-api-key`、bearer 令牌或 `x-api-key`，并返回与管理路由完全相同的字节。响应携带强 `ETag`——通过 `If-None-Match` 回传即可重新验证并获得 `304` 而非完整文档——同时设置 `Cache-Control: private, no-cache`。在此被接纳的数据面密钥在管理面上**不会**获得任何权限：`/api/catalog` 以及所有 `/api/*` 路由仍然要求管理员令牌或仪表板会话。

display name 是 **仅用于显示且在重新生成时保持稳定的**。每一次 `ocx sync` 和 catalog refresh 都会从
`config.json`（包括 `customModels`）重新派生路由条目，因此配置过的名称会重新应用，而不是漂回路由 slug。
受管服务重启后也会在 proxy 绑定完成后不久尝试做这次 sync。如果这个尽力而为的启动 sync 失败了，比如在离线登录时，
之前持久化下来的 catalog 会保留，而下一次成功的 `ocx sync` 会重新应用已配置的名称。真实的上游原生名称
（例如 `gpt-5.6-sol` → "GPT-5.6-Sol"）来自固定的上游快照，绝不会被自定义 display name 覆盖。

### 外部 provider 管理器

如果 `config.toml` 已经选择了 `openai` 或 `opencodex` 之外的 provider，OpenCodex 会保持文件不变，
并跳过 profile 写入、catalog/cache 刷新，以及立即和后台两种 Codex 历史元数据恢复。管理自定义 provider 的工具
通常会把现有会话标记为那个 provider id；如果替换活动 id，Codex 历史视图里那些完整会话可能会消失。
同样的保护也适用于由旧版 root profile 选择的外部 provider。

只保留一个工具作为 Codex provider 配置的 owner。若要在现有 provider 管理器之后使用 OpenCodex，
请把那个 provider 指向 `http://127.0.0.1:10100/v1`，并使用 Responses passthrough（Codex TOML 中的
`wire_api = "responses"`），而不是 Chat Completions translation。当启用 proxy API auth 时，也要像上面的非 loopback
provider 形式一样，从 `OPENCODEX_API_AUTH_TOKEN` 传入 `x-opencodex-api-key`。如果要让 OpenCodex 直接注入路由，
请先把 Codex 切回其内置的 `openai` provider，并移除任何用户拥有的 root `openai_base_url`，然后重新运行 `ocx start`。

### 目录排障

如果 Codex 里缺少某个模型，或者目录顺序/可见性看起来不对，请按下面顺序检查：

1. **`selectedModels`** 在 provider 上的设置 - 非空 allowlist 只会把这些 id 暴露给 Codex；空或省略则会暴露
   所有发现到的模型。一个不在 allowlist 里的 id 永远不会进入 catalog。
2. **`disabledModels`**（顶层） - 会同时隐藏 catalog 和 `/v1/models` 中的模型，并把裸原生 GPT slug
   切成 `visibility: "hide"`。
3. **`liveModels: false` 且 `models` 为空** - 当 live discovery 关闭而 `models` 为空或省略时，opencodex
   不会为那个 provider 暴露任何路由模型。
4. **Cursor `GetUsableModels`** - Cursor adapter 通过它的 protobuf `GetUsableModels` RPC 发现模型，而不是
   `/models`，所以 Cursor 侧的变动会独立于其他 provider 改变哪些 id 可见。
5. **缓存和 `ocx sync`** - live catalog 的缓存时间大约是五分钟（`modelCacheTtlMs`，默认 `300000`）。
   运行 `ocx sync` 可以强制立即重新抓取并重写 catalog。
6. **正在运行的 Codex `app-server`** - 当长生命周期的 Codex `app-server`（Desktop / CLI 后台宿主）还在
   内存中保留旧列表时，只重写磁盘上的 catalog 还不够。`ocx sync` 和 `ocx sync-cache` 会在检测到这些进程时给出
   警告。请用 `ocx sync --restart-codex` 重新启动它们（或者你自己停掉匹配的 `app-server` 进程），然后让 Codex
   重新创建它们，这样新列表才会出现。

:::caution[其他本地写入者]
在 opencodex 内部，catalog 写入（`opencodex-catalog.json`、`config.toml`）是原子的，这只能防止两个
opencodex 所有的 writer 竞争时写出半截文件。它**不能**阻止其他本地进程、文件 watcher 或同步 agent 在
opencodex 写入之后再次改写 catalog 的可见性或顺序。Codex 还有自己独立的 `models_cache.json`，并且可以独立刷新它，
从而在不重写 `opencodex-catalog.json` 的情况下改变可见列表。如果 proxy 正在运行时模型突然翻转，请停掉或重新配置
竞争中的写入者，然后运行 `ocx sync` —— 这是外部写入者风险，不是已确认的 opencodex 缺陷。
:::

## Proxy 连接错误

如果 Codex 重试后报出类似
`stream disconnected before completion: error sending request for url (http://127.0.0.1:10100/v1/responses)`
的错误——或者 Claude Code 报告类似的连接失败——说明 opencodex proxy 没有在运行：
配置端口上没有任何监听，所以客户端只能自己渲染出那条原始连接错误。重启 proxy：

```bash
ocx start              # foreground
ocx service install    # persistent: auto-starts on login and respawns on crash
```

`ocx status` 会显示 proxy 是否在运行，并在未运行时打印相同的重启提示；`ocx doctor` 会报告
重启安全性（service/shim 覆盖情况）。

## sub-agent 选择器

catalog sync 会让选中的 sub-agent 模型对 Codex 可用；关于 picker 排序，参见
[Codex App 模型选择器](/guides/codex-app-models/#subagent-selection)；关于 v1/base/v2 的委派和
fallback 行为，参见 [Sub-agent Surface](/guides/sub-agent-surface/)。

## Codex 账号预热

当把一个 ChatGPT 账号加入 Codex 账号池时，opencodex 会在持久化前向 Codex Responses backend
发送一个小型 streaming 请求来验证它。该请求使用真正的 Responses item 数组
（`input: [{ type: "message", ... }]`），等待 `response.completed`，并默认使用 `gpt-5.4-mini`。
如果该模型返回 HTTP 400，则会改用 `gpt-5.5` 重试；结构化的上游错误详情会被展示给用户，但不会暴露
原始响应正文。后台重新验证是独立功能，默认关闭；只有在启用 Token Guardian、将 `chatgpt` 刷新策略设为
`proactive`，并且 `tokenGuardian.codexWarmupEnabled` 为 true 时才会运行。

## 恢复原生 Codex

opencodex 绝不会把你困住。**`ocx stop` 是完全恢复原生 Codex 的单一命令** —— 它会停止 proxy、
停止后台服务（如已安装），并剥除所有注入的行和路由的目录条目，使普通的 `codex` 完全像 opencodex
从未存在过一样工作：

```bash
ocx stop       # stop the proxy + service, restore native Codex
ocx restore    # restore without stopping  (alias: ocx eject)
ocx restore back # point plain Codex at the running proxy again
```

当 opencodex 作为受管的 [background service](/reference/cli/#ocx-service) 运行时，它会设置
`OCX_SERVICE=1`，这样由服务驱动的重启**不会**反复改写 Codex config——只有显式的
`ocx stop` / `ocx service stop` 才会恢复原生 Codex。
