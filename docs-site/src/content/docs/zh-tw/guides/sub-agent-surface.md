---
title: 子代理介面（v1 / base / v2）
description: 全域控制 Codex 在所有模型上生成和管理子代理的方式。
---

opencodex 允許你為目錄中的所有模型選擇多代理協作介面。儀表板和 Models 頁面中的 **Sub-agent** 開關會全域控制這一設定。

:::note
在 v2 介面（`multi_agent_v2`）上，子代理**預設**繼承父會話的模型：`fork_turns` 預設為 `all`，而全量歷史 fork 會拒絕覆蓋。自 v2.7.2 起，opencodex 注入的指引會教模型如何打破繼承 —— 將 `fork_turns` 設為 `"none"`（或如 `"3"` 的部分 fork）的 `spawn_agent` 呼叫可以傳入 `model` / `reasoning_effort` 引數；即使公開的工具 schema 中看不到這些引數，Codex 執行環境也會解析並應用。已知傳輸限制：當**原生**父代理 spawn 一個路由到**非原生** provider 的子代理時，Codex 用戶端可能只以後端加密的 `encrypted_content` 傳送 `NEW_TASK` 載荷（[#92](https://github.com/lidge-jun/opencodex/issues/92)）。opencodex 不會把這種無法讀取的任務轉發給外部 provider：直接路由會返回 HTTP 400 和錯誤碼 `unreadable_encrypted_agent_task`；組合路由則會跳過無法解密的目標，並在存在可用目標時選擇規範的原生 ChatGPT 目標。恢復方法：異構 provider 委派改用 v1、選擇原生 ChatGPT 子代理，或將任務重新作為明文 v2 `agent_message` 內容傳送。
:::

## 模式

| 模式 | 介面 | 行為 |
| --- | --- | --- |
| **v1** | `multi_agent_v1` | 使用經典的名稱空間代理工具，以及 `send_input` / `close_agent` / `resume_agent`。`spawn_agent` 的模型覆蓋可以在其他模型上生成子代理。 |
| **base**（預設） | 上游固定值 | 恢復上游模型的固定值：gpt-5.6-sol 和 gpt-5.6-terra 使用 v2，gpt-5.6-luna 使用 v1；未固定的模型遵循 Codex 的 `multi_agent_v2` 功能開關。生成行為取決於該模型最終使用的介面。 |
| **v2** | `multi_agent_v2` | 使用扁平的 `spawn_agent` 工具、併發會話，以及 `send_message` / `followup_task` / `wait_agent` / `interrupt_agent`。全量歷史 fork 時子代理繼承父模型；`fork_turns: "none"`（或部分 fork）時接受 `model` / `reasoning_effort` 覆蓋。如果原生→路由子代理只收到後端加密的任務內容，外部路由會返回 `unreadable_encrypted_agent_task`；混合組合會優先選擇可解密的原生目標（[#92](https://github.com/lidge-jun/opencodex/issues/92)）。 |

### 加密的 v2 任務傳輸

只有原生 ChatGPT 後端能夠讀取其加密任務載荷。對於無法讀取的 v2 `agent_message`，opencodex 會在呼叫 provider 之前執行以下規則：

- 直接路由到非原生 provider 時，返回 HTTP 400，並設定 `error.code = "unreadable_encrypted_agent_task"`。回應不會回顯加密載荷。
- 組合路由只會為該任務考慮規範的原生 ChatGPT 目標，重試時也遵守同一規則。如果組合中沒有可解密的目標，則返回同樣的 400，而不會把空任務傳送給外部 provider。
- 可讀取的明文任務仍保留正常的組合順序與故障轉移行為。

恢復方法：將子代理切換到原生 ChatGPT 模型、在組合中加入原生目標、異構 provider 委派改用 v1，或者在你能控制呼叫方時將任務重新作為明文 v2 `agent_message` 內容傳送。

## 運作原理

所選模式會設定 Codex 讀取的每個目錄條目中的 `multi_agent_version` 欄位：

- **v1 模式**：強制所有條目使用 `multi_agent_version = "v1"`，覆蓋上游固定值。
- **base 模式**：恢復上游預設值。已固定的模型使用快照值；未固定的模型不寫入該欄位，交由 Codex 功能開關決定。
- **v2 模式**：強制所有條目使用 `multi_agent_version = "v2"`，覆蓋上游固定值。

無論是即時 `/v1/models` 目錄回應，還是磁碟目錄同步，這項覆蓋都會作為最後一步執行。因此，無論條目原本如何生成，新會話都會使用一致的模式。

### 委託模型與推理強度

儀表板中的 **子代理委託** 選擇器會儲存 `injectionModel`，以及可選的 `injectionEffort`。它們用於生成委託指引，並不是由 proxy 執行的子代理路由規則。設定 `injectionPrompt` 可以把內建指引文字整體替換為自定義內容。

`multiAgentGuidanceText` 根據請求中的工具列表判斷目前介面 —— 包括 Codex Desktop 的 WebSocket 路徑（`responses_lite`），此時工具位於 `additional_tools` input 項中而不是請求的 `tools` 陣列。

在 **v2** 請求上（base 模式下的 Sol/Terra，v2 模式下的全部模型），只要設定了有效的注入模型、或有效子代理清單非空，proxy 就會注入一段不超過 700 字元的精簡指引。該指引以條件方式說明 `model` / `reasoning_effort` 覆蓋，不假定它們是否出現在目前 schema 中；它要求使用 `fork_turns: "none"`（或部分 fork），僅命名有效的規範首選模型，並只列出 Codex 中 picker 可見、相容 v2、按 priority 排序後前五項內的已設定模型及其可用 effort 檔位。

在 **v1** 請求上，proxy 僅在最高推理檔位（max / ultra）映象上游的主動委託文字。v1 不會追加模型指定、清單或自定義提示詞。

要替換內建的 v2 指引，請設定 `injectionPrompt`（config 鍵，或 `PUT /api/injection-model` 的 `prompt` 值）。佔位符 `{{model}}`、`{{effort}}`、`{{roster}}` 會被替換為設定的注入模型、推理強度和解析出的清單。觸發條件保持不變：自定義提示詞不會讓本應保持沉默的請求觸發注入。

## 更改模式

### GUI

- **Dashboard** → 第一個狀態單元：選擇 **v1**、**base** 或 **v2**。
- **Models** 頁面 → 使用頂部的分段控制元件。
- 兩個頁面都有 **?** 按鈕，可開啟幫助彈窗並返回本文。
- **Dashboard** → **子代理委託**：選擇首選模型和可選的推理強度。在 v2 上，注入的指引會要求以 `fork_turns: "none"` 生成，使模型覆蓋得以應用。如果原生→路由子代理只收到加密任務內容，請使用原生目標或 v1；僅外部目標的傳輸現在會明確返回 `unreadable_encrypted_agent_task`（[#92](https://github.com/lidge-jun/opencodex/issues/92)）。

### CLI

```bash
ocx v2 mode v1       # 強制所有模型使用 v1
ocx v2 mode default  # 恢復上游固定值
ocx v2 mode v2       # 強制所有模型使用 v2
ocx v2 status        # 顯示目前模式和 Codex 功能開關
```

### API

```bash
# 讀取介面模式、功能開關和執行緒上限
curl http://localhost:10100/api/v2

# 設定介面模式
curl -X PUT http://localhost:10100/api/v2 \
  -H 'Content-Type: application/json' \
  -d '{"multiAgentMode": "v2"}'
```

`/api/v2` 的 PUT 端點還接受 `enabled`（布林值，Codex 功能開關）和 `maxConcurrentThreadsPerSession`（整數）。它會驗證請求、儲存模式、重新同步目錄，並提示模式更改從新會話開始生效。

委託選擇器使用另一個端點：

```bash
# 讀取目前模型/推理強度和可選值
curl http://localhost:10100/api/injection-model

# 同時設定兩個值
curl -X PUT http://localhost:10100/api/injection-model \
  -H 'Content-Type: application/json' \
  -d '{"model": "anthropic/claude-sonnet-5", "effort": "xhigh"}'

# 設定自定義指引提示詞（{{model}}/{{effort}}/{{roster}} 佔位符）
curl -X PUT http://localhost:10100/api/injection-model \
  -H 'Content-Type: application/json' \
  -d '{"model": "anthropic/claude-sonnet-5", "prompt": "委託給 {{model}}。{{roster}}"}'

# 清除兩個值
curl -X PUT http://localhost:10100/api/injection-model \
  -H 'Content-Type: application/json' \
  -d '{"model": null}'
```

`GET /api/injection-model` 返回 `model`、`effort`、`prompt`、全域 `efforts` 階梯，以及由已啟用原生/路由模型組成的 `available` 列表。PUT 請求省略 `effort` 或 `prompt` 時會保留目前值，傳入 `null` 時會清除它；清除 `model` 一定會同時清除推理強度。API 會按全域 Codex 階梯驗證推理強度，Codex 仍會在生成時檢查目標目錄條目是否支援該強度。

## 推理強度

可選的子代理推理強度儲存在 `injectionEffort` 中，只有同時設定注入模型時才有意義。它會向注入的 v2 指引加入 `reasoning_effort` 要求，但不會改變父會話的推理強度。在接受覆蓋的 fork 上，Codex 會直接應用傳給 `spawn_agent` 的 `reasoning_effort`。

在 Codex 目錄中，`ultra` 的級別高於 `max`，並帶有自動委託語義；但 provider 永遠不會線上路上收到字面量 `ultra`。Codex 會在用戶端邊界將 `ultra` 轉成 `max`，隨後 opencodex 再確保 provider 收到有效值：

| 模型 | 線路上的 `max` | 選擇 `ultra` 後的線路值 |
| --- | --- | --- |
| gpt-5.5、gpt-5.4、gpt-5.4-mini | xhigh | xhigh（先轉為 max，再經 `nativeEffortClamp`） |
| gpt-5.6-sol、gpt-5.6-terra | max | max |
| gpt-5.6-luna | max | 其精確上游階梯不提供該選項 |
| 路由模型 | 由適配器對映或限制 | 先轉為 max，再由適配器對映或限制 |

目錄中是否提供某個推理強度與 v1/v2 模式無關。支援推理的生成條目會提供 `max`，使直接指定的子代理強度能夠透過驗證；目前生成的路由條目還會提供 `ultra`。精確的上游模型階梯會原樣保留，因此 gpt-5.6-luna 最高只到 `max`。

## 上下文上限

全域上下文上限值預設為 350k。它只會限制已啟用上限的路由 provider 所廣告的 `context_window`；原生 OpenAI 模型保留其真實上下文視窗。

你可以在 Models 頁面更改上限值或全體 provider 設定，也可以透過各 provider 分組標題旁的開關單獨啟用或停用上限。
