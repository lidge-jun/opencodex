---
title: 子代理介面（v1 / base / v2）
description: 全域控制 Codex 在所有模型上生成和管理子代理的方式。
---

opencodex 允許你為目錄中的所有模型選擇多代理協作介面。儀表板和 Models 頁面中的 **Sub-agent** 開關會全域控制這一設定。

:::note
在 v2 介面（`multi_agent_v2`）上，子代理**預設**繼承父會話的模型：`fork_turns` 預設為 `all`，而全量歷史 fork 會拒絕覆蓋。自 v2.7.2 起，opencodex 注入的指引會教模型如何打破繼承 —— 將 `fork_turns` 設為 `"none"`（或如 `"3"` 的部分 fork）的 `spawn_agent` 呼叫可以傳入 `model` / `reasoning_effort` 引數；即使公開的工具 schema 中看不到這些引數，Codex 執行環境也會解析並應用。已知傳輸限制：當**原生**父代理 spawn 一個路由到**非原生** provider 的子代理時，Codex 用戶端可能只以後端加密的 `encrypted_content` 傳送 `NEW_TASK` 載荷（[#92](https://github.com/lidge-jun/opencodex/issues/92)）。opencodex 不會把這種無法讀取的任務轉發給外部 provider：直接路由會回傳 HTTP 400 和錯誤碼 `unreadable_encrypted_agent_task`；組合路由則會跳過無法解密的目標，並在存在可用目標時選擇規範的原生 ChatGPT 目標。恢復方法：異構 provider 委派改用 v1、選擇原生 ChatGPT 子代理，或將任務重新作為明文 v2 `agent_message` 內容傳送。另有預設停用的實驗性 `agentTaskRecovery`；它會增加 ChatGPT 配額用量與延遲，且依賴非公開後端行為。
:::

## What sub-agents are

子代理是主代理為了專注任務而建立的一個獨立 Codex worker。它有自己的 context 與工具，因此多個
獨立任務可以平行執行。opencodex 控制哪些 Codex 協作介面會暴露這些 worker、Codex 為它們提供哪些
模型，以及失敗的模型如何回退。它不會決定你的主代理何時必須委派。

## 模式

| 模式 | 介面 | 行為 |
| --- | --- | --- |
| **v1** | `multi_agent_v1` | 使用經典的名稱空間代理工具，以及 `send_input` / `close_agent` / `resume_agent`。`spawn_agent` 的模型覆蓋可以在其他模型上生成子代理。 |
| **base**（預設） | 上游固定值 | 恢復上游模型的固定值：gpt-5.6-sol 和 gpt-5.6-terra 使用 v2，gpt-5.6-luna 使用 v1；未固定的模型遵循 Codex 的 `multi_agent_v2` 功能開關。生成行為取決於該模型最終使用的介面。 |
| **v2** | `multi_agent_v2` | 使用扁平的 `spawn_agent` 工具、併發會話，以及 `send_message` / `followup_task` / `wait_agent` / `interrupt_agent`。全量歷史 fork 時子代理繼承父模型；`fork_turns: "none"`（或部分 fork）時接受 `model` / `reasoning_effort` 覆蓋。如果原生→路由子代理只收到後端加密的任務內容，外部路由會回傳 `unreadable_encrypted_agent_task`；混合組合會優先選擇可解密的原生目標（[#92](https://github.com/lidge-jun/opencodex/issues/92)）。 |

## 運作原理

所選模式會設定 Codex 讀取的每個目錄條目中的 `multi_agent_version` 欄位：

- **v1 模式**：強制所有條目使用 `multi_agent_version = "v1"`，覆蓋上游固定值。
- **base 模式**：恢復上游預設值。已固定的模型使用快照值；未固定的模型不寫入該欄位，交由 Codex 功能開關決定。
- **v2 模式**：強制所有條目使用 `multi_agent_version = "v2"`，覆蓋上游固定值；但啟用 **讓 ChatGPT 保持 v1** 時例外：ChatGPT 原生條目維持 `"v1"`，路由/組合條目仍為 `"v2"`。

無論是即時 `/v1/models` 目錄回應，還是磁碟目錄同步，這項覆蓋都會作為最後一步執行。因此，無論條目原本如何生成，新會話都會使用一致的模式。

## 委託模型與推理強度

儀表板的 **子代理委託** 控制三個相關設定：

- `injectionModel` 是 opencodex 指引中點名的偏好 worker 模型。
- `injectionEffort` 是為該模型要求選用的 `reasoning_effort`。
- `injectionPrompt` 取代內建的 v2 指引文字。

`multiAgentGuidanceEnabled` 預設開啟，是 opencodex 撰寫的指引在兩個介面上的主開關。關閉它會同時
抑制 v2 指定區塊與 v1 主動文字。

這些是給主代理的指示，不是 proxy 端的 spawn 路由器。在 v2 上，全量歷史 fork 會繼承父模型並拒絕
模型或 effort 覆蓋。因此指引會告訴 Codex 在傳遞 `model` 或 `reasoning_effort` 時使用
`fork_turns: "none"`（或正數的部分回合數，例如 `"3"`），並讓任務訊息自足。

自訂 `injectionPrompt` 文字可以使用全部四個佔位符：

| 佔位符 | 取代為 |
| --- | --- |
| `{{model}}` | 本次請求的有效偏好模型。裸的原生 `injectionModel` 只有在請求本身指向明確的帳號選擇器時才以帳號限定。無法解析或歧義的裸值會變成空字串；無法解析的明確帳號限定或路由 id 保持不變 |
| `{{effort}}` | 設定的 `injectionEffort`，或空字串 |
| `{{roster}}` | 解析出的 picker 可見、介面相容名冊 |
| `{{fallback}}` | 設定的全域 fallback 指引 |

內建 v2 指引有 700 字元的預算。若會超過預算，opencodex 會先丟掉名冊而不是截斷核心 spawn 指示。
內建指引只在偏好模型、合格名冊或 fallback 鏈解析成功時觸發。設定了 `injectionModel` 就足以渲染
自訂提示詞；若裸值無法唯一解析，`{{model}}` 會展開為空字串。

在 v1 上，opencodex 只在 `max` / `ultra` effort 注入上游風格的主動委派指引。v1 不會附加偏好模型、
名冊、fallback 清單或自訂提示詞。

預設關閉的 `syncCodexSubagentDefaults` 選項與指引無關。當 opencodex 擁有作用中的 Codex 路由時，
sync 或 restart 可以把選定值寫成帶 marker 的 `[agents] default_subagent_model` 和
`default_subagent_reasoning_effort` 項目，放進 Codex TOML。opencodex 只更新或移除帶有自己 marker 的
欄位。若任一目標欄位為使用者所有，整對會保持不變而不部分寫入；有歧義的 TOML 會被拒絕而不寫入。
外部供應商管理器與使用者擁有的根路由仍然保持權威。

## Fallback chains

對生成的 worker，opencodex 建立這個優先順序：

1. 請求的主要模型。
2. opencodex 設定中 `subagentModelFallbackByModel` 的 per-model 鏈，以請求的主要模型為鍵。
3. opencodex 設定中的全域 `subagentModelFallback` 清單。

Per-role fallback 鏈屬於 opencodex 設定，而不是 `$CODEX_HOME/agents/*.toml`。Codex 0.146+ 嚴格
反序列化 agent role 檔案，並把 `model_fallback` 當作未知欄位拒絕，導致整個 role 定義被跳過（#1190）。
opencodex 仍可為了向後相容從 TOML 讀取舊版 `model_fallback` 列，但 `ocx doctor` 會對此發出警告，
而 Codex 本身會忽略受影響的 role。

重複的模型 id 會被移除，同時保留第一次出現者。選擇期間，opencodex 會跳過已停用、無法路由、由已
停用 provider 支撐、標記為不健康、在冷卻中、缺少可用 Pool 化 Codex 帳號，或超過設定配額閾值的
候選。可用性探測會快取 `subagentModelFallbackPollMs`（預設 60 秒）。

Fallback 不能讓不相容的加密任務變成可讀。當子任務是為 ChatGPT 加密時，即使外部模型在鏈中出現得
更早，選擇也會限制在規範的原生 ChatGPT 目標。

## 加密的 v2 任務傳輸

Codex 可能只以後端加密的 `encrypted_content` 傳送 v2 原生→路由子任務。該載荷可以被原生 ChatGPT
後端讀取，但外部 provider 無法讀取。這是已知的
[#92 限制](https://github.com/lidge-jun/opencodex/issues/92)。

opencodex 會安全失敗，而不是轉發空或無法讀取的任務：

- 直接的非原生路由回傳 HTTP 400，帶有 `error.code = "unreadable_encrypted_agent_task"`，且不會回顯
  密文。
- 組合只會為該任務考慮規範的原生 ChatGPT 目標，包括重試。若沒有可用目標，回傳相同的 400。
- 可讀取的明文任務保持正常的路由與 fallback 行為。

恢復方法：選擇原生 ChatGPT 子代理、在組合中加入原生 ChatGPT 目標、異構 provider 委派改用 v1，
或在你能控制呼叫方時將任務重新作為明文 v2 `agent_message` 內容傳送。

實驗性的 `agentTaskRecovery` 預設停用。明確啟用後，它可透過固定 ChatGPT 端點的額外已驗證請求
恢復此格式，但會消耗配額、增加延遲，並依賴非公開後端行為。任何失敗都保留原本的
`unreadable_encrypted_agent_task` 錯誤。詳見[英文設定參考](/reference/configuration/agents/#encrypted-v2-task-recovery)。

## 更改模式

### GUI

- **Dashboard** → 第一個狀態單元：選擇 **v1**、**base** 或 **v2**。
- **Models** 頁面 → 使用頂部的分段控制元件。
- 兩個頁面都有 **?** 按鈕，可開啟幫助彈窗並返回本文。
- **Dashboard** → **子代理委託**：選擇首選模型和可選的推理強度。在 v2 上，注入的指引會要求以 `fork_turns: "none"` 生成，使模型覆蓋得以應用。如果原生→路由子代理只收到加密任務內容，請使用原生目標或 v1；僅外部目標的傳輸現在會明確回傳 `unreadable_encrypted_agent_task`（[#92](https://github.com/lidge-jun/opencodex/issues/92)）。

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

# 設定自訂指引提示詞（{{model}}/{{effort}}/{{roster}} 佔位符）
curl -X PUT http://localhost:10100/api/injection-model \
  -H 'Content-Type: application/json' \
  -d '{"model": "anthropic/claude-sonnet-5", "prompt": "委託給 {{model}}。{{roster}}"}'

# 清除兩個值
curl -X PUT http://localhost:10100/api/injection-model \
  -H 'Content-Type: application/json' \
  -d '{"model": null}'
```

`GET /api/injection-model` 回傳 `model`、`effort`、`prompt`、全域 `efforts` 階梯，以及由已啟用原生/路由模型組成的 `available` 列表。PUT 請求省略 `effort` 或 `prompt` 時會保留目前值，傳入 `null` 時會清除它；清除 `model` 一定會同時清除推理強度。API 會按全域 Codex 階梯驗證推理強度，Codex 仍會在生成時檢查目標目錄條目是否支援該強度。

## FAQ

### 選擇委託模型會強制 Codex 生成它嗎？

不會。指引可以推薦模型，原生預設同步可以提供 Codex 預設值，但主代理仍然決定是否委派。

### 為什麼我的 v2 子代理使用了父模型？

全量歷史 v2 fork 會繼承父模型。請在傳遞模型或 effort 覆蓋之前，使用把 `fork_turns` 設為 `"none"`
或正數部分計數的 spawn。

### 為什麼設定的模型沒有出現在 v2 名冊中？

它可能是 picker 隱藏、超出五個模型的顯示上限、不在目錄中，或固定為 v1。值為 `"v2"`、`null` 或缺
少介面值的項目合格；真正的 `"v1"` 固定值不合格。

### 模式變更會影響執行中的工作階段嗎？

不會。變更模式後請開啟新的 Codex 工作階段。若長時間執行的 App host 仍顯示過時的目錄狀態，請執行
`ocx sync` 並重新啟動該 Codex 介面。

### 當 opencodex 無法信任目錄時會發生什麼？

opencodex 會將磁碟上的模型目錄與目前使用者擁有的每個 Codex app-server 啟動時間比較，產生四種狀態之一：

| 狀態 | 意義 | v2 指引 |
|---|---|---|
| `fresh` | 每個 app-server 都在目錄寫入之後啟動 | 完整指引：偏好模型、roster、fallback |
| `not_running` | 未偵測到 app-server | 完整指引 |
| `stale` | 至少一個 app-server 早於目錄 | **不新增或覆寫 opencodex 撰寫的模型指引** |
| `unknown` | 無法進行比較 | **不新增或覆寫 opencodex 撰寫的模型指引** |

對 `stale` 與 `unknown`，opencodex 會保留其自身的磁碟衍生宣稱——偏好模型、roster、fallback 與自訂指引——因為執行中的 Codex 可能無法生成磁碟目錄所廣告的內容。

它**不會**指示模型停止設定 `model` 或 `reasoning_effort`。該觀察對使用者擁有的每個 app-server 都是全域的，而入站請求不帶傳送者身分，因此無法將過時的 process 歸因於眼前的請求。基於此禁止覆寫會封鎖現用 `spawn_agent` 工具合法廣告的選項——而該 session 可能其實是新的。現用工具 schema 保持權威。

`unknown` 不是 `stale` 的同義詞。它表示比較本身失敗——目錄時間戳不可讀、process 啟動時間不可讀或 process 列舉失敗——並由 `ocx doctor` 分開回報。`stale` 僅在每個偵測到的 Codex app-server 都在最後一次目錄寫入後啟動時才清除；它不一定會清除 `unknown`。

### 推理強度

可選的子代理推理強度儲存在 `injectionEffort` 中，只有同時設定注入模型時才有意義。它會向注入的 v2 指引加入 `reasoning_effort` 要求，但不會改變父會話的推理強度。在接受覆蓋的 fork 上，Codex 會直接應用傳給 `spawn_agent` 的 `reasoning_effort`。

在 Codex 目錄中，`ultra` 的級別高於 `max`，並帶有自動委託語義；但 provider 永遠不會線上路上收到字面量 `ultra`。Codex 會在用戶端邊界將 `ultra` 轉成 `max`，隨後 opencodex 再確保 provider 收到有效值：

| 模型 | 線路上的 `max` | 選擇 `ultra` 後的線路值 |
| --- | --- | --- |
| gpt-5.5、gpt-5.4、gpt-5.4-mini | xhigh | xhigh（先轉為 max，再經 `nativeEffortClamp`） |
| gpt-5.6-sol、gpt-5.6-terra | max | max |
| gpt-5.6-luna | max | 其精確上游階梯不提供該選項 |
| 路由模型 | 由適配器對映或限制 | 先轉為 max，再由適配器對映或限制 |

目錄中是否提供某個推理強度與 v1/v2 模式無關。支援推理的生成條目會提供 `max`，使直接指定的子代理強度能夠透過驗證；目前生成的路由條目還會提供 `ultra`。精確的上游模型階梯會原樣保留，因此 gpt-5.6-luna 最高只到 `max`。

### 上下文上限

全域上下文上限值預設為 350k。它只會限制已啟用上限的路由 provider 所廣告的 `context_window`；原生 OpenAI 模型保留其真實上下文視窗。

你可以在 Models 頁面更改上限值或全體 provider 設定，也可以透過各 provider 分組標題旁的開關單獨啟用或停用上限。
