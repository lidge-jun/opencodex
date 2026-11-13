---
title: Agent 設定
description: 多代理介面、委派指引、偏好模型、fallback 鏈、原生預設同步與 effort 上限。
---

Agent 設定控制要廣告哪個 Codex 協作介面，以及 opencodex 如何引導、路由並限制委派的工作。

## Agent 欄位

| 欄位 | 型別 | 預設值 | 意義 |
| --- | --- | --- | --- |
| `multiAgentMode?` | `"v1" \| "default" \| "v2" \| "v2-plaintext"` | `"default"` | `v1` 將每個目錄模型標記為 v1；`v2` 將每個模型標記為 v2。`default` 還原上游 pin（Sol/Terra v2、Luna v1），否則遵循原生的 `multi_agent_v2` 旗標。目錄 pin 適用於新 session。`v2-plaintext` 選擇 V2、關閉全域強制並啟用實驗性明文任務傳遞；編譯器也影響既有 V2 工作階段的後續合格請求。 |
| `subagentModels?` | `string[]` | `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-luna` | 最多五個原生 id、帳號限定的 `<selector>/<native-openai-model>` id 或路由 `provider/model` id，優先顯示在子代理選擇器中。新增選項只提供原生和路由 id；儲存時會保留已設定的精確帳號限定 id，包括目前目錄中無法使用的 id。如需新增精確帳號限定 id，請使用 `ocx agent subagents set` 或編輯設定。[Astra 一次性升級](/reference/configuration/agents/#astra-roster-upgrade)後，明確的空清單會被保留。 |
| `injectionModel?` | `string` | — | 在代理撰寫的 v2 委派指引中使用的偏好原生或路由子代理模型。 |
| `injectionEffort?` | `string` | — | 偏好 effort（`low` 到 `ultra`），僅在搭配 `injectionModel` 時有意義。 |
| `injectionPrompt?` | `string` | — | 取代內建指引本文。支援 `{{model}}`、`{{effort}}`、`{{roster}}` 與 `{{fallback}}`。觸發閘門保持不變。 |
| `multiAgentGuidanceEnabled?` | `boolean` | `true` | 僅控制 opencodex 撰寫的 v1/v2 開發者指引；不改變原生 agent 預設值、工具、路由、roster 或 effort 上限。 |
| `syncCodexSubagentDefaults?` | `boolean` | `false` | 選擇在 sync/restart 時將 `injectionModel` 與可選的 `injectionEffort` 寫入 Codex 的原生預設值。需要 `injectionModel`。 |
| `subagentModelFallback?` | `string[]` | `[]` | 為生成的子任務回合排序的全域 fallback 模型。 |
| `subagentModelFallbackPollMs?` | `number` | `60000` | 可用性探測快取間隔。低於 1000 ms 的值會回退到預設值。 |
| `effortCap?` | `string` | — | 合格 v2 主回合與標記的生成子回合的硬性上限。接受 `low` 到 `ultra`。 |
| `plaintextV2AgentMessages?` | `boolean` | —（未設定） | 實驗性選項。明確設為 `true` 或選擇 `multiAgentMode: "v2-plaintext"` 會要求合格的原生 ChatGPT v2 父代理以明文產生 `spawn_agent`、`send_message`、`followup_task` 的訊息引數。詳見[明文 v2 代理訊息](#plaintext-v2-agent-messages)。 |
| `subagentEffortCap?` | `string` | — | 僅針對生成子回合的額外上限。當兩個上限都適用時，取較低者。 |

使用儀表板或 `ocx v2 status|on|off|mode <v1|default|v2|v2-plaintext>|threads <n>` 管理介面。目錄 pin 變更適用於新工作階段；明文編譯器依目前設定處理合格請求，包括既有 V2 工作階段的後續請求。`maxConcurrentThreadsPerSession` 是 `PUT /api/v2` 欄位，不是 `config.json` key；`ocx v2 threads <n>` 在啟用 v2 後，將 `max_concurrent_threads_per_session` 寫入 Codex 的 `$CODEX_HOME/config.toml` 中 `[features.multi_agent_v2]` 之下。

## Plaintext v2 agent messages

`plaintextV2AgentMessages` 在新設定中未設定；明確設為 `true` 或選擇 `multiAgentMode: "v2-plaintext"` 均會啟用此實驗路徑。模式不會覆寫獨立布林值，因此離開模式後仍遵循其原值。透過儀表板確認，或執行 `ocx v2 mode v2-plaintext --live --acknowledge-plaintext-agent-messages` 進入。管理 API 的 `PUT /api/v2` 首次進入時須提供 `plaintextAgentMessagesAcknowledged: true`。

呼叫方必須使用 Responses，最終目的地必須是標準 ChatGPT Codex forward 傳輸：`adapter: "openai-responses"`、`authMode: "forward"`，以及確切網址 `https://chatgpt.com/backend-api/codex`。API 金鑰 provider、自訂相容閘道、其他最終 provider 及非 Responses 呼叫不會被改寫。啟用編譯也影響既有 V2 工作階段後續的合格請求；既有密文不會被解密，已儲存歷史不會改寫，停用也不會刪除歷史、provider 請求或本機回應／除錯狀態中已保留的副本。HTTPS 與驗證仍啟用。

啟用任一設定時，本機重放需要相同獲准的 opencodex 呼叫方身分及請求自身非空白的 `thread-id`；否則須省略 `previous_response_id` 並重送完整對話。啟用期間保留的狀態停用後仍維持綁定。預設 `v1` 對未綁定狀態保留原有父執行緒範圍續接行為。

管理 API 暴露 `GET`/`PUT /api/v2`、`/api/injection-model`、`/api/effort-caps`、`/api/subagent-models` 與 `/api/subagent-model-fallback`。注入模型更新為部分更新；自訂 prompt 是該 API 的 `prompt` 欄位。

## Roster 與指引

有效的 v2 roster 是已設定、picker 可見、優先序排序的前五個與 v2 相容且存在於注入目錄中的模型。v2 資格將明確的 `"v2"`、`null` 或省略的上游 pin 視為合格；真正的 `"v1"` pin 則排除。被排除的項目仍保留在設定中，以便日後變為合格。

介面偵測使用工具形狀。帶有 `send_input`、`resume_agent` 或 `close_agent` 的命名空間 `spawn_agent` 為 v1。帶有 `send_message`、`followup_task`、`interrupt_agent` 或 `list_agents` 的扁平 `spawn_agent` 為 v2。

V1 指引僅在 `max` 或 `ultra` 時為主動文字。V2 僅在存在偏好模型、合格 roster 或 fallback 鏈時，收到代理撰寫的開發者訊息。內建 v2 指引有 700 字元預算，必要時先丟棄 roster。指引會跨 replay 前綴去重，並插入在結尾的 `compaction_trigger` 之前。

`injectionModel` 與 `injectionEffort` 在未啟用原生預設同步前僅為建議。內建 v2 文字要求 Codex 將支援的 model/effort 覆寫連同 `fork_turns: "none"` 傳給 `spawn_agent`。自訂 `injectionPrompt` 會用空字串替換缺失值。

## 原生 Codex 預設同步

啟用時，`syncCodexSubagentDefaults` 寫入標記擁有的 `[agents] default_subagent_model` 與 `default_subagent_reasoning_effort` 欄位。既有的未標記使用者擁有目標欄位視為衝突並保持權威性；部分或歧義的 TOML 寫入會 fail closed。清除 `injectionModel` 也會清除此選項。這些預設值影響新建的 Codex 任務，本身不會觸發委派。

## Fallback 鏈

生成子任務的 fallback 順序為：

1. 請求的主模型；
2. 以請求的主模型為索引的 `subagentModelFallbackByModel` 每模型項目；
3. 全域 `subagentModelFallback` 項目；然後
4. 為向後相容而讀取的 `$CODEX_HOME/agents/*.toml` 舊版角色級 `model_fallback`。

Codex 0.146+ 會將角色檔案中的 `model_fallback` 視為未知欄位並略過整個角色；`ocx doctor` 也會對此發出警告。因此新的角色級 fallback 應設定在 opencodex，而不是角色 TOML 中。

opencodex 會跳過已停用、不可路由、不健康、冷卻中或達到配額閾值的候選項。可用性快取保存 `subagentModelFallbackPollMs`。對於加密的子任務，候選鏈僅包含規範的原生 ChatGPT 目標，以及透過 `allowEncryptedV2AgentTasks: true` 明確信任的直接金鑰驗證 Responses 路由。若無目標可處理加密 payload，且選用的恢復功能無法支援路由傳送，請求會失敗，不會轉送無法讀取的密文。組合會先嘗試可用的規範原生目標；若沒有可選擇的原生目標或原生嘗試已耗盡，且已啟用 `agentTaskRecovery`，會在路由到組合目標前對加密的 `NEW_TASK` 恢復一次。組合恢復僅在 spawn 出的子回合生效；直接路由路徑也會恢復對話中途的模型切換。

```json
{
  "multiAgentMode": "v2",
  "subagentModels": ["gpt-6.1-sol", "anthropic/claude-sonnet-5"],
  "injectionModel": "gpt-6.1-sol",
  "injectionEffort": "high",
  "syncCodexSubagentDefaults": true,
  "subagentModelFallback": ["gpt-6-luna"],
  "subagentModelFallbackPollMs": 60000,
  "subagentEffortCap": "high"
}
```

## Effort 上限

上限僅套用於 v2 協作功能：當主回合的工具暴露 v2 時該回合合格，而子回合在 `x-codex-turn-metadata` 中帶有精確的 codex-rs `x-openai-subagent: collab_spawn` 或 `"subagent_kind": "thread_spawn"` 標記時合格，即使葉工具不再暴露協作。V1 主回合、`multiAgentMode: "v1"`、壓縮、審查與記憶整合回合會略過上限。

上限僅會降低 effort。它們吸附到上限或以下的最高宣告級別。若模型沒有 effort 控制或沒有支援的級別符合，opencodex 會移除 effort 並讓供應商預設值套用。`max` 與 `ultra` 被接受，而儀表板提供 `low` 到 `xhigh`。

即使沒有設定模型 effort pin，符合條件的原生 Chat Completions 回合也會套用設定的上限。套用 pin 或上限改變值時才會對應為供應商的傳輸值；兩者皆未發生時，原生呼叫端值保留原始寫法。

關於 v1、default 與 v2 行為的入門導向說明，請見[子代理介面](/zh-tw/guides/sub-agent-surface/)。
