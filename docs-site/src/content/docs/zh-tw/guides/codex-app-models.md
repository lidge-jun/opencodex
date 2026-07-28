---
title: Codex App 模型選擇器
description: opencodex 模型如何透過共享 Codex 目錄出現在 Codex App、Codex CLI 和 Codex TUI 中。
---

opencodex 不會修改 Codex App。它會寫入 Codex CLI/TUI 已經使用的同一套 Codex 設定和模型目錄。
Codex App 也會讀取這份共享狀態，因此路由模型可以像普通 Codex 目錄條目一樣出現在 App 的模型
選擇器中。

OpenAI 身份固定為兩種：bare native id 是由 `codexAccountMode` 控制 Pool（預設）或 Direct 的
單一 `openai` 組，`openai-apikey/<model>` 是 API key。切換模式不會改變模型 id。API GPT-5.6 使用 1,050,000
context / 922,000 max input；`*-pro` picker id 保持公開身份，線上使用 base 模型加
`reasoning.mode: "pro"`。

## 整合路徑

`ocx init`、`ocx start` 和 `ocx sync` 會保持解析後的 `CODEX_HOME` 目錄下這些檔案一致：

```text
$CODEX_HOME/config.toml
$CODEX_HOME/opencodex.config.toml
$CODEX_HOME/opencodex-catalog.json
$CODEX_HOME/models_cache.json
```

使用預設的 loopback 監聽地址時，Codex 會保留內建的 `openai` provider id。opencodex 透過以下
根級鍵把該 provider 和模型目錄指向代理：

```toml
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"
openai_base_url = "http://127.0.0.1:10100/v1"
```

如果 hostname 不是 loopback，Codex 還需要傳送生成的 API 認證 header。此模式會使用根級
`model_provider = "opencodex"` 和一個獨立的 Responses 相容 provider：

```toml
[model_providers.opencodex]
name = "OpenCodex Proxy"
base_url = "http://your-host:10100/v1"
wire_api = "responses"
requires_openai_auth = true
env_http_headers = { "x-opencodex-api-key" = "OPENCODEX_API_AUTH_TOKEN" }
```

`websockets` 預設關閉。只有設定 `"websockets": true` 時，獨立 provider 和目錄條目才會宣告
`supports_websockets = true`。在 loopback 模式下，Codex 的內建 provider 可能會先嚐試
WebSocket；若代理未啟用該功能，則返回 `426`，讓 Codex 回退到 HTTP/SSE。完整的注入與恢復流程見
[Codex 整合](/zh-cn/guides/codex-integration/)。

## 為什麼路由模型會顯示

Codex 模型選擇器要求條目符合 Codex 目錄結構。opencodex 會克隆一個原生 Codex 模型模板，然後
替換路由模型的身份資訊：

```text
slug = "anthropic/claude-sonnet-..."
display_name = "anthropic/claude-sonnet-..."
visibility = "list"
```

克隆後的條目會保留 reasoning 級別、shell 型別、API 支援標誌和 base instructions 等嚴格解析器
所需欄位。隨後，opencodex 會移除該路由無法兌現的原生專屬能力，例如 OpenAI service-tier 後設資料。

## v2.7.1 模型範圍

原生回退列表包含 `gpt-5.5`、`gpt-5.4`、`gpt-5.4-mini`、
`gpt-5.3-codex-spark` 以及 GPT-5.6 Sol/Terra/Luna。對於 GPT-5.5/5.4 系列，opencodex 會
保留已安裝 Codex 目錄中資訊更完整的即時條目，僅在條目缺失時才合成。內建的上游快照只用於
GPT-5.6，以便提供每個模型真實的身份和後設資料，而不是套用舊模板近似生成。

| 路由 | 選擇器 id 與目錄後設資料 |
| --- | --- |
| Codex 登入（Pool 或 Direct） | `gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`（372,000 token） |
| OpenAI（API key） | `openai-apikey/gpt-5.6-*` 和 `openai-apikey/gpt-5.6-*-pro`（1,050,000；max input 922,000） |
| OpenRouter | `openrouter/openai/gpt-5.6-sol`、`openrouter/openai/gpt-5.6-terra`、`openrouter/openai/gpt-5.6-luna`（1,050,000） |
| Cursor | 靜態回退目錄包含 `cursor/gpt-5.6-sol`、`cursor/gpt-5.6-terra`、`cursor/gpt-5.6-luna`（1,000,000），以及 `cursor/grok-4.5`、`cursor/grok-4.5-fast`（500,000）；帳號的即時發現結果決定最終顯示哪些模型。 |
| xAI | 以即時發現結果為準；回退目錄預設使用 `xai/grok-4.5`，上下文為 500,000，並提供 `low` / `medium` / `high` reasoning 控制。 |

固定的 GPT-5.6 條目會保留精確的上游 reasoning 階梯。Sol 和 Terra 從 `low` 到 `ultra`，Luna
最高到 `max`。Sol 預設使用 `low`，Terra 和 Luna 預設使用 `medium`。`ultra` 是用戶端側的
“最大 reasoning + 主動委派”選項，到達後端時會轉換為 `max`。模型出現在選擇器中只表示目錄已經
準備好；關聯的帳號或 API key 仍需具備該模型的實際許可權。

## 原生與路由模型開關

儀表板的 Models 頁面透過同一個 `disabledModels` 管理兩類模型：

- 路由 id 使用 `provider/model` 名稱空間。停用後，該模型會從同步目錄和 `/v1/models` 中移除。
- 原生 GPT id 是不含 `/` 的 slug。停用時不會刪除目錄條目，而是將 `visibility` 改為 `hide`，
  以便重新啟用時精確恢復原條目；停用期間，OpenAI 列表格式也會省略它。
- 原生模型行來自受支援的靜態集合，因此即使模型已停用，仍會留在儀表板中供你重新啟用。

可見性處理位於快照升級之後。每次切換模型後，管理 API 都會重新整理目錄，並強制把 Codex 模型快取
標記為過期。

## Multi-agent surface 模式

opencodex 為每個目錄條目的 `multi_agent_version` 提供三態 override：

| 模式 | 效果 |
| --- | --- |
| **v1** | 強制所有模型使用 v1 multi-agent surface，並覆蓋上游固定值（包括 Sol/Terra）。 |
| **base**（安裝預設值） | 恢復上游固定值：Sol/Terra 使用 v2，Luna 使用 v1；未固定的模型遵循 Codex 的 `multi_agent_v2` 功能開關。 |
| **v2** | 強制所有模型使用 v2 multi-agent surface，並覆蓋上游固定值（包括 Luna）。 |

可從 Dashboard 或 Models 頁面、`ocx v2 mode v1|default|v2`，或透過帶
`{ "multiAgentMode": "v1" }` 的 `PUT /api/v2` 設定該模式。變更從新的 Codex session 開始生效。

:::caution
在 v2（`multi_agent_v2`）介面中，生成的子代理會繼承父 session 的模型。儀表板中的委派模型/
reasoning 選擇器只是 v1 prompt 指引，並不是由代理在每次生成時執行跨模型路由。權威說明見
[子代理介面](/zh-cn/guides/sub-agent-surface/)。
:::

## 頂級 reasoning 檔位

目錄中顯示哪些 reasoning 檔位與 v1/base/v2 介面模式無關。生成的、支援 reasoning 的條目會提供
`max`，以便直接指定的子代理強度透過校驗；目前生成的路由條目和舊一代原生 GPT 條目還會提供
`ultra`。精確的上游 GPT-5.6 階梯會原樣保留，因此 Luna 只有 `max`，沒有 `ultra`。

在實際請求中，路由 adapter 會對映或限制不受支援的檔位。對於真實最高檔位為 `xhigh` 的舊原生
模型，`nativeEffortClamp` 會把直接指定的 `max` 或 `ultra` 選擇轉換為 `xhigh`，例如 GPT-5.5。
Sol、Terra 和 Luna 都有真實的 `max` 檔位。

## Fast tier 規則

Codex 在設定檔中這樣儲存 fast 模式：

```toml
service_tier = "fast"

[features]
fast_mode = true
```

模型目錄和執行環境請求使用的 tier id 則是 `priority`。opencodex 會保留這一差異。原生 OpenAI
透傳模型繼續支援 fast；路由到非 OpenAI provider 的模型會移除 service-tier 後設資料，避免顯示
無法兌現的 fast 選項。

## 子代理選擇

Codex 會按 `priority` 升序排列選擇器中可見的目錄條目，並將前五個顯示為 `spawn_agent` 模型
override。你可以透過 `subagentModels` 或儀表板的 Subagents 頁面選擇最多五個原生 id 或
`provider/model` id；opencodex 會按所選順序賦予它們 0-4 的 priority。其他模型仍可透過精確 id
直接呼叫。

置頂模型列表與 Dashboard 的 **Sub-agent delegation** 指引相互獨立。尤其需要注意，置頂模型
override 不能繞過 v2 的父模型繼承規則。

## 重新整理模型狀態

如果選擇器仍顯示舊條目，請重新整理目錄並重新開啟目標 Codex 介面：

```bash
ocx sync
```

當目錄的可見性、priority 或後設資料發生變化時，opencodex 會用一個刻意標記為過期的快取 wrapper
重寫 `models_cache.json`，使 Codex 下次重新整理模型時讀取新目錄。
