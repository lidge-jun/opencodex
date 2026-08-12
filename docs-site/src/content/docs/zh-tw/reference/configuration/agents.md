---
title: Agent 設定
description: 多代理介面、委派指引、偏好模型、fallback 鏈、原生預設同步與 effort 上限。
---

Agent 設定控制要廣告哪個 Codex 協作介面，以及 opencodex 如何引導、路由並限制委派的工作。

## Agent 欄位

| 欄位 | 型別 | 預設值 | 意義 |
| --- | --- | --- | --- |
| `multiAgentMode?` | `"v1" \| "default" \| "v2"` | `"default"` | `v1` 將每個目錄模型標記為 v1；`v2` 將每個模型標記為 v2。`default` 還原上游 pin（Sol/Terra v2、Luna v1），否則遵循原生的 `multi_agent_v2` 旗標。套用於新 session。 |
| `subagentModels?` | `string[]` | `gpt-5.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.4-mini` | 最多五個原生或路由 id，在子代理 picker 中優先顯示。明確的空清單會被保留。 |
| `injectionModel?` | `string` | — | 在代理撰寫的 v2 委派指引中使用的偏好原生或路由子代理模型。 |
| `injectionEffort?` | `string` | — | 偏好 effort（`low` 到 `ultra`），僅在搭配 `injectionModel` 時有意義。 |
| `injectionPrompt?` | `string` | — | 取代內建指引本文。支援 `{{model}}`、`{{effort}}`、`{{roster}}` 與 `{{fallback}}`。觸發閘門保持不變。 |
| `multiAgentGuidanceEnabled?` | `boolean` | `true` | 僅控制 opencodex 撰寫的 v1/v2 開發者指引；不改變原生 agent 預設值、工具、路由、roster 或 effort 上限。 |
| `syncCodexSubagentDefaults?` | `boolean` | `false` | 選擇在 sync/restart 時將 `injectionModel` 與可選的 `injectionEffort` 寫入 Codex 的原生預設值。需要 `injectionModel`。 |
| `subagentModelFallback?` | `string[]` | `[]` | 為生成的子任務回合排序的全域 fallback 模型。 |
| `subagentModelFallbackPollMs?` | `number` | `60000` | 可用性探測快取間隔。低於 1000 ms 的值會回退到預設值。 |
| `effortCap?` | `string` | — | 合格 v2 主回合與標記的生成子回合的硬性上限。接受 `low` 到 `ultra`。 |
| `subagentEffortCap?` | `string` | — | 僅針對生成子回合的額外上限。當兩個上限都適用時，取較低者。 |

使用儀表板或 `ocx v2 status|on|off|mode <v1|default|v2>|threads <n>` 管理介面。模式變更套用於新 session。`maxConcurrentThreadsPerSession` 是 `PUT /api/v2` 欄位，不是 `config.json` key；`ocx v2 threads <n>` 在啟用 v2 後，將 `max_concurrent_threads_per_session` 寫入 Codex 的 `$CODEX_HOME/config.toml` 中 `[features.multi_agent_v2]` 之下。

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
2. 來自 `$CODEX_HOME/agents/*.toml` 的角色級 `model_fallback`；然後
3. 全域 `subagentModelFallback` 項目。

opencodex 會跳過已停用、不可路由、不健康、冷卻中或達到配額閾值的候選項。可用性快取保存 `subagentModelFallbackPollMs`。加密的子任務可將鏈限制為規範的原生 ChatGPT 目標；若無任何目標可讀取加密 payload，請求會失敗，而不會將無法讀取的密文路由到別處。

```json
{
  "multiAgentMode": "v2",
  "subagentModels": ["gpt-5.5", "anthropic/claude-sonnet-5"],
  "injectionModel": "gpt-5.5",
  "injectionEffort": "high",
  "syncCodexSubagentDefaults": true,
  "subagentModelFallback": ["gpt-5.4-mini"],
  "subagentModelFallbackPollMs": 60000,
  "subagentEffortCap": "high"
}
```

## Effort 上限

上限僅套用於 v2 協作功能：當主回合的工具暴露 v2 時該回合合格，而子回合在 `x-codex-turn-metadata` 中帶有精確的 codex-rs `x-openai-subagent: collab_spawn` 或 `"subagent_kind": "thread_spawn"` 標記時合格，即使葉工具不再暴露協作。V1 主回合、`multiAgentMode: "v1"`、壓縮、審查與記憶整合回合會略過上限。

上限僅會降低 effort。它們吸附到上限或以下的最高宣告級別。若模型沒有 effort 控制或沒有支援的級別符合，opencodex 會移除 effort 並讓供應商預設值套用。`max` 與 `ultra` 被接受，而儀表板提供 `low` 到 `xhigh`。

關於 v1、default 與 v2 行為的入門導向說明，請見[子代理介面](/zh-tw/guides/sub-agent-surface/)。
