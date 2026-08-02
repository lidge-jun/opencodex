---
title: 路由設定
description: 預設供應商選擇、模型解析順序、組合別名、目標排序與 effort 預設值。
---

路由會將客戶端送出的模型 id 轉換為一個具體供應商與上游模型。

## 頂層路由欄位

| 欄位 | 型別 | 預設值 | 意義 |
| --- | --- | --- | --- |
| `defaultProvider` | `string` | `"openai"` | 當沒有更早的模型規則匹配時，最終使用的供應商。必須指向一個已啟用且已設定的供應商。 |
| `combos?` | `Record<string, OcxComboConfig>` | `{}` | 由有序供應商/模型目標組成的虛擬 `combo/<id>` 模型。 |

## 模型解析順序

opencodex 依以下順序解析請求的模型：

1. 規範的 `combo/<id>` 或已設定的 combo 別名。規範 id 優先於別名匹配。
2. 明確的 `<provider>/<model>` 命名空間，其前綴指向一個已設定的供應商。
3. 裸的原生 OpenAI 系列 id，例如 `gpt-*`、`o1-*`、`o3-*` 或 `o4-*`，透過規範的已啟用 `openai` 供應商路由。
4. 與供應商 `defaultModel` 完全匹配。
5. 已知的供應商系列模型前綴。
6. 供應商已設定 `models` 清單中的完全匹配模型。
7. `defaultProvider`，保留請求的模型 id。

已停用的供應商會被排除。指向已停用供應商的明確命名空間會直接失敗，而不會 fall through。可能匹配多個供應商的規則會以 JSON 插入順序檢查供應商項目，因此當裸模型可能有歧義時，請使用明確命名空間。

## 組合（`config.combos`）

每個 combo key 是一個匹配 `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` 的 id。它始終可直接以 `combo/<id>` 定址，也可另外暴露一個 `alias`。別名必須唯一、不能佔用 `combo/` 命名空間，也不能使用保留的裸原生系列如 `gpt-*`、`o1-*`、`o3-*`、`o4-*` 或 `codex-*`。

| Key | 型別 | 預設值 | 意義 |
| --- | --- | --- | --- |
| `targets` | `{ provider: string; model: string; weight?: number }[]` | 必填 | 有序的具體路由。`weight` 為 1–10000，預設 `1`。 |
| `strategy?` | `"failover" \| "round-robin"` | `"failover"` | 選擇策略。目標順序為 failover 優先序；權重塑造平滑加權輪詢。 |
| `stickyLimit?` | `number` | `1` | 在一個輪詢批次中保留的成功請求數。範圍 1–100。 |
| `defaultEffort?` | `"low" \| "medium" \| "high" \| "xhigh" \| "max" \| "ultra" \| null` | 未設定 | 僅在呼叫者省略 effort 且所選目標宣告了請求的級別時套用。 |
| `alias?` | `string` | — | 用來取代規範 picker slug 的可選公開模型 id。 |

```json
{
  "defaultProvider": "openai",
  "combos": {
    "coding": {
      "targets": [
        { "provider": "anthropic", "model": "claude-sonnet-5" },
        { "provider": "openrouter", "model": "qwen/qwen3-coder-plus" }
      ],
      "strategy": "failover",
      "defaultEffort": "high",
      "alias": "coding-primary"
    }
  }
}
```

關於策略行為、可重試失敗、冷卻、加密 v2 任務限制與管理命令，請見[組合](/zh-tw/guides/combos/)。

### 目錄資格

即使 combo 無法被列出，它仍可直接路由。`ocx sync`、`/v1/models` 與 Codex picker 僅在每個目標都暴露可交集的能力時才列出它：

- 正向的 `contextWindow`，來自即時後設資料、registry 提示或供應商的
  `modelContextWindows` / `contextWindow`；且
- 非空的 `inputModalities` 交集，省略的成員值視為 `["text"]`。

沒有上下文後設資料的裸 relay id，或模態互斥的目標，會將 combo 從目錄移除。Sync 會發出摘要警告，儀表板會標記為**需要注意**。請新增上下文後設資料、對齊模態，或指向具有可探索相容能力的模型。
