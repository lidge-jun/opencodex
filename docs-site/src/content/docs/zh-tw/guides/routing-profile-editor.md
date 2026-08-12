---
title: 路由設定檔編輯器
description: 從 OpenCodex 儀表板建立、編輯、驗證、試跑（dry-run）與移除路由原則設定檔。
---

OpenCodex 儀表板中的 **Models → Routing** 分頁可以直接管理 `config.routingProfiles`，不必手動編輯 `config.json`。

## 建立設定檔

1. 在儀表板中開啟 **Routing**。
2. 選取 **Create profile**。
3. 輸入 `id`。標準模型 id 是 `policy/<id>`。
4. 新增一個或多個明確的 provider/model 候選。
5. 設定選用的需求、評分權重、成本上限（`maxEstimatedCostUsd`、選用的 `onUnknownCost`）與未知證據（unknown-evidence）行為。
6. 儲存設定檔。

設定檔 id 在建立後不可變。要使用不同的 id，請建立新設定檔，並在更新 callers 之後移除舊的。

## 驗證與持久化

儀表板會把與 `config.routingProfiles` 相同的設定檔物件送給 management API。伺服器會在寫入之前驗證完整的候選：

- id 與 aliases 必須遵循路由設定檔的命名與衝突規則；
- 每個候選 provider 都必須存在且已啟用；
- 重複的候選會被拒絕；
- 數值上限與需求必須維持在其支援的範圍內；且
- 至少一個最佳化權重必須為正值。

成功的儲存會透過一般的 config writer 持久化設定檔、協調即時狀態，並重新整理模型目錄。驗證失敗會保留先前的設定不變，並顯示在編輯器中。

當 `limits.maxEstimatedCostUsd` 被設定時，`limits.onUnknownCost` 預設為 `"allow"`：未知成本估算不會被排除於上限之外，dry-run / 即時路由決策 trace 會標記 `cost.capOutcome: "unknown-allowed"`，讓操作者知道上限未被證實。需要上限必須失敗閉合（fail closed，`cost-limit-unknown`，帶 `cost.capOutcome: "unknown-excluded"`）時，請設定 `"exclude"`。單獨設定 `onUnknownCost` 是無效的，不會產生 cap outcome。這與 `unknownEvidence.cost` 是分開的，後者仍可獨立於 cap outcome 之外排除或懲罰未知價格。

## 試跑已儲存的設定檔

選取一個已儲存的設定檔，使用 **Dry-run evaluation** 加入請求證據，例如 context-window 大小、工具使用、圖片輸入或結構化輸出。試跑會評估資格與評分，但永遠不會送出上游模型請求。

未儲存的編輯不會被試跑使用。請先儲存設定檔，讓顯示的 revision 與評估參照同一份設定。

## Management API

編輯器使用這些端點：

- `GET /api/routing-profiles` 列出正規化的設定檔與 revisions。
- `PUT /api/routing-profiles` 建立或更新一個設定檔。傳送 `mode: "create"` 或 `mode: "update"`；create mode 拒絕覆寫已存在的 id。
- `DELETE /api/routing-profiles?id=<id>` 移除一個設定檔。
- `POST /api/routing-profiles/dry-run` 在不送出上游請求的情況下評估已儲存的設定檔。

儲存 payload 範例：

```json
{
  "id": "fast",
  "mode": "create",
  "profile": {
    "alias": "ocx/fast",
    "candidates": [
      { "provider": "anthropic", "model": "claude-sonnet-5" },
      { "provider": "openai", "model": "gpt-5.6" }
    ],
    "require": { "tools": true, "minContextWindow": 128000 },
    "optimize": { "latency": 0.55, "health": 0.25, "cost": 0.1, "quota": 0.1 },
    "limits": { "maxEstimatedCostUsd": 0.5, "onUnknownCost": "allow" },
    "unknownEvidence": {
      "capability": "exclude",
      "health": "penalize",
      "quota": "penalize",
      "cost": "penalize"
    }
  }
}
```
