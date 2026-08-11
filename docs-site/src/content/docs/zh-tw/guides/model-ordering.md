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

自訂開頭模型順序的唯一受支援方式是重新排列 `subagentModels`。你可以在儀表板的
**Sub-agents** 頁面或 opencodex 設定中修改它。該列表最多接受五個模型，其陣列順序有實際意義。

目前 `OcxConfig` 中沒有通用的 `modelOrder`、`providerOrder` 或 priority map 設定。受支援的排序
欄位是 `subagentModels`（`src/types.ts:238-246`）；`disabledModels` 和各 provider 的
`selectedModels` 都是可見性欄位（`src/types.ts:276-282`、`src/types.ts:439-446`）。因此，要更改
選擇器其餘部分的順序，需要修改程式碼行為，而不是調整設定。
