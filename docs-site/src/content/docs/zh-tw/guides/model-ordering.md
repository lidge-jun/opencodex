---
title: 模型排序
description: opencodex 如何確定 Codex 模型選擇器和 spawn_agent 模型 override 的順序。
---

Codex 模型選擇器不會保留 opencodex 設定中 provider 的宣告順序或模型陣列順序。最終順序由目錄
priority 決定；priority 相同的路由模型則使用確定性的字母順序。

## Codex 應用的規則

Codex 的 models-manager 按 `priority` 升序排列選擇器中可見的目錄條目。目錄陣列本身的順序會被
丟棄，因此在生成的 JSON 陣列中把某個條目前移，並不會讓它在選擇器中前移。該約束直接記錄在
`src/codex/catalog/sync.ts` 中。

因此，opencodex 透過分配更低的 priority 控制置頂位置，而不依賴陣列位置。相關 priority 如下：

以下優先級表與範例適用於未啟用完整選擇器排序的情況。

| 目錄條目 | Priority | 來源 |
| --- | ---: | --- |
| `subagentModels[i]` | `i`（`0` 至 `4`） | `src/codex/catalog/sync.ts` 中的 featured rank map |
| 其他路由模型 | `5` | `src/codex/catalog/sync.ts` 中建立路由條目的邏輯 |
| 預設原生 GPT slug | `9` | `src/codex/catalog/sync.ts` 中建立原生條目的邏輯 |
| 存在 featured 列表時未選中的原生模型 | 至少為 `featured.length + 100` | `src/codex/catalog/sync.ts` 中合併原生目錄的邏輯 |

管理 API 在 `src/server/management/agent-settings-routes.ts` 中使用 `slice(0, 5)`，把
`subagentModels` 限制為最多五項。這與 Codex `spawn_agent` 介面只公佈前五個模型 override 的行為
一致。五項之外的模型仍可繼續顯示在主選擇器中，也可透過精確 id 呼叫。

## Priority 相同時如何排序

所有普通路由模型的 priority 都是 `5`，因此需要處理並列順序。在建立目錄條目之前，
`gatherRoutedModels()` 會先按 provider 名稱、再按模型 id 對路由模型列表進行字母排序
（`src/codex/catalog/provider-fetch.ts`）。

因此，以下設定順序不會影響最終順序：

- `providers` 物件中各 key 的宣告順序；
- 每個 provider 的 `models` 陣列中各 id 的排列順序。

隨後，`orderForSubagents()` 使用穩定排序，把 featured 模型按 `subagentModels` 中的順序移到最前。
非 featured 模型會保持之前確定的 provider/id 字母相對順序
（`src/codex/catalog/sync.ts`）。建立條目時，featured rank 還會轉換為 `0` 至 `4` 的
priority，因此 Codex 的 priority 排序會保留這個開頭序列。

## 可見性與排序彼此獨立

`selectedModels` 和 `disabledModels` 只決定暴露哪些路由模型，不控制排序。
`filterCatalogVisibleModels()` 會把兩類選擇轉換為 `Set` 查詢，並在不把陣列當作 rank 的情況下過濾
已收集的列表（`src/codex/catalog/provider-fetch.ts`）。

因此，調整 `selectedModels` 或 `disabledModels` 的陣列順序不會改變模型在選擇器中的位置，只會
影響模型是否包含在內。

## 最終選擇器順序

featured 列表非空時，最終順序為：

1. 嚴格按照設定的 `subagentModels` 順序排列，priority 為 `0` 至 `4`；
2. 所有剩餘路由模型，先按 provider、再按模型 id 的字母順序排列，priority 為 `5`；
3. 在目錄合併過程中被移到 featured 區塊之後的未選中原生模型。

如果沒有 `subagentModels`，路由模型保持 priority `5`，原生 GPT 條目使用正常 priority
（opencodex 建立的條目通常為 `9`），路由組內部仍按 provider/id 字母排序。

## 示例

假設 `subagentModels` 按以下順序包含五個 id：

```toml
subagentModels = [
  "gpt-5.5",
  "opencode-go/glm-5.2",
  "anthropic/claude-opus-4-6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
]
```

選擇器開頭的實際順序如下：

| 選擇器位置 | 模型 | Priority | 出現在此處的原因 |
| ---: | --- | ---: | --- |
| 1 | `gpt-5.5` | `0` | 第一個 `subagentModels` 選擇 |
| 2 | `opencode-go/glm-5.2` | `1` | 第二個選擇，即使其 provider 在字母順序上位於 `anthropic` 之後 |
| 3 | `anthropic/claude-opus-4-6` | `2` | 第三個選擇 |
| 4 | `gpt-5.6-sol` | `3` | 第四個選擇 |
| 5 | `gpt-5.6-terra` | `4` | 第五個選擇 |
| 6 | `anthropic/claude-fable-5` | `5` | 剩餘路由模型中按 provider/id 字母排序的第一項 |
| 第 7 項起 | 其餘路由模型 | `5` | 先按 provider 字母排序，再按模型 id 字母排序 |
| 路由模型之後 | 其餘原生模型 | `featured.length + 100` 或更高 | 未選中的原生模型移到 featured 區塊之後 |

前五個條目是向 `spawn_agent` 公佈的 override，其餘模型繼續按普通選擇器順序排列。

## 更改順序

要調整 `spawn_agent` 候選模型的順序，請重新排列 `subagentModels`。你可以在儀表板的
**Sub-agents** 頁面或 opencodex 設定中修改它。該列表最多接受五個模型，其陣列順序有實際意義。

`modelPickerOrder` 只控制選擇器的顯示順序。如果列表只有路由 ID `<provider>/<model>`，
其中未置頂的列會按列表順序進入獨立的顯示區間（`1000 + i`）。未列出的路由列保留原有優先級，
因此仍排在該區間之前。同時列在 `subagentModels` 中的列保留置頂優先級，原生列也維持原有位置。
需要控制相對順序的路由列都應列入列表。

要對整個選擇器排序，請加入至少一個不含 `/` 的裸目錄 ID，例如 `gpt-5.6-sol`。
空字串或只有空白的項目不會啟用此模式。

```json
{
  "modelPickerOrder": ["gpt-5.6-sol", "opencode-go/glm-5.3"]
}
```

列出的項目按陣列順序排在最前面，未列出的項目隨後按原有優先級排列。比對使用精確的目錄 ID：
`gpt-5.6-sol` 和 `openai/gpt-5.6-sol` 是不同的列。同一路由 ID 的原始寫法和編碼寫法也可比對，
但精確比對優先於等價比對。空項目和只有空白的項目會被忽略。帳號限定列必須使用包含 selector 的完整 ID。

### 遷移提醒：現有列表中的原生 ID

以前 `modelPickerOrder` 中的裸原生 ID 會被忽略。現在，現有列表只要包含這類 ID，就會啟用
整個選擇器的排序，包括置頂列。要保留以前只調整路由列的行為，請移除裸 ID。
未設定、空列表、只有空白項目的列表以及只有路由 ID 的列表都保留原有行為。

`modelPickerOrder` 保留 OpenCodex 按原有優先級計算最多五個偏好候選項的規則，供子代理指引使用。
每個移動列的原有優先級與原生 `priority` 分開儲存；僅改變選擇器順序不得改變這項計算結果。
它也不會限制以精確模型名稱指定 override 的資格：公佈的列表不是允許清單，既有的驗證、模型、
effort 與後端限制仍然適用。

原生 Codex 按原生 `priority` 排序，從符合條件且在選擇器中可見的模型中取前五個，公佈在
`spawn_agent` 中。這適用於 V1，以及開放模型 override 的 V2。因此，即使 OpenCodex 的偏好候選項
不變，原生公佈的五個模型仍可能隨選擇器順序改變。V1 不接收 OpenCodex 注入的偏好模型列表。
V2 在用戶端目錄狀態允許時，可以額外接收基於原有優先級的 OpenCodex 指引；這些指引不會重排
原生工具公佈的列表。

`disabledModels` 和各供應商的 `selectedModels` 仍是可見性欄位。沒有獨立的 `modelOrder`、
`providerOrder` 或優先級對應表設定。

## 儀表板排序預設

在 **Models** 選擇預設、依模型名稱 A–Z、依供應商或使用量快照，再套用順序。儲存目前可用的路由 ID 和 `modelPickerOrderMode`（`alphabetical`、`provider`、`most-used`）。使用量排序僅在套用時讀取一次保留的全部歷史；重新開啟或模型增減不會重新計算。現有自訂與原生完整順序會保留，直到明確套用替換。即使沒有可用模型，預設也能清除兩個欄位。

`GET/PUT /api/subagent-models` 的 `chosen`、`available` 保留停用或缺少的已存 roster；`pickerAvailable` 僅包含可選路由 ID。Models 只傳送 `pickerOrder`、`pickerOrderMode`，不傳送 `models`。只儲存 roster 不影響排序；無效輸入或儲存失敗會保留原狀態。

預設保留精選與原生優先級區間，套用於 Codex 目錄和 Claude 探索清單的路由群組。Claude 原生前綴、明確的 Desktop 設定及 alias 歸屬不變。OpenCodex 指引排序和 fallback 設定不變，但原生 Codex 工具顯示的前五個候選與建議預設模型可能改變。儲存不會重新啟動用戶端；目錄更新可能尚未完成，舊清單可能需要重新開啟用戶端。
