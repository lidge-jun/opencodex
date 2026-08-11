---
title: 路由設定
description: 預設供應商選擇、模型解析順序、combo 別名、目標排序與 effort 預設值。
---

路由將客戶端送出的模型 id 轉為一個具體的供應商與上游模型。

## 頂層路由欄位

| 欄位 | 型別 | 預設值 | 意義 |
| --- | --- | --- | --- |
| `defaultProvider` | `string` | `"openai"` | 當先前的模型規則皆未符合時使用的最終供應商。必須指涉一個已啟用的已設定供應商。 |
| `combos?` | `Record<string, OcxComboConfig>` | `{}` | 由有序 provider/model 目標建構的虛擬 `combo/<id>` 模型。 |
| `routingProfiles?` | `Record<string, OcxRoutingProfileConfig>` | `{}` | 以硬性能力需求與確定性計分，在明確的候選允許清單中選擇的虛擬 `policy/<id>` 模型。 |

## 模型解析順序

opencodex 依此順序解析請求的模型：

1. 設定中的 `policy/<id>` 或 routing-profile 別名：執行政策評估器並路由所選候選項。無法解析的 `policy/<id>` 會往下落到後續規則。
2. 設定的 `<account-selector>/<native-openai-model>` 命名空間：透過所映射的已儲存 Codex 帳號精確路由。無效或不可用的精確目標會 fail closed。
3. 標準 `combo/<id>` 或設定的 combo 別名。標準 id 先於別名比對。
4. 前綴指名已設定供應商的明確 `<provider>/<model>` 命名空間。
5. 裸的原生 OpenAI 家族 id（如 `gpt-*`、`o1-*`、`o3-*`、`o4-*`）：透過標準啟用的 `openai` 供應商路由。
6. 供應商 `defaultModel` 的精確比對。
7. 已知的供應商家族模型前綴。
8. 供應商設定 `models` 清單中的精確模型。
9. `defaultProvider`，保留請求的模型 id。

已停用的供應商被排除。對已停用供應商的明確命名空間會失敗而非往下落。當規則可符合多個供應商時，供應商項目依其 JSON 插入順序檢查，因此裸模型有歧義時請使用明確命名空間。

## 精確 Codex 帳號選擇器

`codexAccountNamespaces` 將一個公開選擇器（如 `side`）映射到一個已儲存的 Codex 帳號。對 `side/gpt-5.6-sol` 的請求僅使用該帳號——即使在 Direct 模式下標準的 `openai` 供應商亦然——並向上游發送裸的 `gpt-5.6-sol` 模型 id。選擇器之後只有裸的原生 OpenAI 家族 id 有效。

精確選擇繞過池指派策略與一般執行緒親和性。若映射的帳號缺失、暫停、冷卻中、不可用或需要重新認證，請求會 fail closed 而非切換帳號，且不會變更現用的池帳號。當至少設定一個合格選擇器時，Codex 目錄會隱藏裸的原生 picker 列，並為每個選擇器列出獨立的 `<selector>/<native-openai-model>` 列。裸的原生 id 保留一般的池／Direct 路由，且除非明確停用，仍留在原始 `/v1/models` 探索中。映射帳號缺失的選擇器不會被廣告。選擇器驗證、碰撞規則與隱私指引在[供應商設定](/zh-tw/reference/configuration/providers/)中說明。

Codex Auth 頁面將此 picker 行為作為選擇加入功能暴露。停用它會隱藏產生的選擇器限定 picker 列並還原一般 GPT 列，但不會移除映射或變更精確 `<selector>/<model>` 路由。因此重新啟用會還原相同的公開標籤。帳號與設定變更在有界的目錄重新整理前持久化；`ocx sync` 警告僅表示 picker 目錄仍需要收斂，而非路由變更遺失。

## 組合（`config.combos`）

每個 combo key 是符合 `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` 的 id。它恆可直接以 `combo/<id>` 定址，並可暴露一個 `alias`。別名必須唯一、不得佔用 `combo/` 命名空間，且除非 `nativeAlias: true` 明確啟用 Desktop 相容性契約，否則不得使用保留的裸原生家族如 `gpt-*`、`o1-*`、`o3-*`、`o4-*` 或 `codex-*`。

| Key | 型別 | 預設值 | 意義 |
| --- | --- | --- | --- |
| `targets` | `{ provider: string; model: string; weight?: number }[]` | 必填 | 有序的具體路由。`weight` 為 1–10000，預設 `1`。 |
| `strategy?` | `"failover" \| "round-robin"` | `"failover"` | 選擇策略。目標順序為 failover 優先序；權重塑造平滑的加權 round-robin。 |
| `stickyLimit?` | `number` | `1` | 在一個 round-robin 批次中保留的成功請求數。範圍 1–100。 |
| `defaultEffort?` | `"low" \| "medium" \| "high" \| "xhigh" \| "max" \| "ultra" \| null` | 未設定 | 僅在呼叫者省略 effort 且所選目標廣告請求的階層時套用。 |
| `alias?` | `string` | — | 可選的公開模型 id，取代標準 picker slug。 |
| `nativeAlias?` | `boolean` | `false` | 讓目前支援的裸原生 id 僅對該未限定 id 取得優先。裸 `gpt-5.6-*` id 使用 Codex 池／Direct 憑證。帳號限定路由保持獨立。供應商限定路由（如 `openai-apikey/gpt-5.6-*`）使用其設定的 API-key 路由，且永不會落到原生別名。 |
| `displayName?` | `string` | — | 僅顯示的目錄標籤，對原生別名為必填且非空。 |

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

關於策略行為、可重試失敗、冷卻、加密 v2 任務限制與管理指令，請見[組合](/zh-tw/guides/combos/)。

## 路由政策設定檔（`config.routingProfiles`）

路由政策設定檔是 Router Intelligence 的選擇層：明確請求的 `policy/<id>`（或設定的別名）使用硬性能力需求與確定性、可解釋的計分，在固定候選允許清單中選擇。明確的 `policy/<id>` 請求（或設定的別名）會執行評估器並路由所選候選項。既有模型 id **永不**被隱含地透過設定檔路由：`policy/` 命名空間與設定檔別名是唯一的進入點，且兩者皆針對上述模型解析順序驗證。

每個 key 是符合 `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` 的 id，恆可定址為 `policy/<id>`，附一個可選 `alias`。別名必須唯一，且不得與已設定供應商、`<provider>/<model>` 路由命名空間、combos、codex 帳號命名空間、`policy/` 命名空間或保留的裸原生家族（`gpt-*`、`o1-*`、`o3-*`、`o4-*`、`codex-*`）碰撞。

| Key | 型別 | 預設值 | 意義 |
| --- | --- | --- | --- |
| `candidates` | `{ provider: string; model: string }[]` | 必填 | 明確的 `provider/model` 參考允許清單。無隱含擴充。 |
| `alias?` | `string` | — | 可選的公開模型 id，取代 `policy/<id>`。 |
| `require?` | object | `{}` | 計分前評估的硬性能力需求（見下方）。 |
| `optimize?` | object | latency 0.55, health 0.25, cost 0.10, quota 0.10 | 計分權重，確定性正規化。`health`、`quota` 與 `cost` 有計分維度；設定的優先份額為 `1 - health - quota - cost`（預設 0.55），而 `latency` 併入該優先份額而非獨立計分。 |
| `limits?` | object | — | 硬性限制。`maxEstimatedCostUsd` 在候選項估計成本已知且超過上限時將其排除。設定該上限時，`onUnknownCost`（`"allow"` 預設，或 `"exclude"`）控制未知估計：allow 防止上限專屬排除並記錄 `cost.capOutcome: "unknown-allowed"`；exclude 發出 `cost-limit-unknown` 與 `capOutcome: "unknown-excluded"`。僅 `onUnknownCost`（無上限）為無效。與 `unknownEvidence.cost` 分開，後者仍可透過 `unknown-price`／計分排除或懲罰未知價格。 |
| `unknownEvidence?` | object | capability `exclude`, health/quota/cost `penalize` | 每個維度如何處理未知證據：`allow`、`penalize` 或 `exclude`。未知永不變為零。 |

`require` 支援：`minContextWindow`（正整數）、`minQuotaHeadroom`（0..1 比例），以及布林值 `tools`、`imageInput`、`structuredOutput`、`localOnly`、`remoteAllowed`、`encryptedCodexTasks`；另有 `reasoningEffort` 與 `serviceTier` 字串。

對 `unknownEvidence.capability`，`penalize` 目前行為如同 `allow`：計分在能力計分維度推出前（規劃於 RI-06+）只有設定的優先元件，因此 `penalize` 尚未能變更所選候選項。

請求證據會連同設定檔 `require` 區塊對候選能力評估；候選項必須兩者皆滿足才合格。在即時請求路徑上，代理從請求 body 推導工具與圖片輸入證據；context-window 大小與其餘證據維度在路由時保持未知。請使用 dry-run API／CLI 檢查 context 敏感設定檔的完整證據表面。

CLI dry-run 接受請求證據旗標，但尚無法提供候選能力證據；候選證據透過 API（`POST /api/routing-profiles/dry-run`）提供。

```json
{
  "routingProfiles": {
    "fast": {
      "alias": "ocx/fast",
      "candidates": [
        { "provider": "anthropic", "model": "claude-sonnet-5" },
        { "provider": "openai", "model": "gpt-5.6-sol" }
      ],
      "require": { "tools": true, "minContextWindow": 128000 },
      "optimize": { "latency": 0.55, "health": 0.25, "cost": 0.10, "quota": 0.10 },
      "limits": { "maxEstimatedCostUsd": 0.50, "onUnknownCost": "allow" },
      "unknownEvidence": {
        "capability": "exclude",
        "health": "penalize",
        "quota": "penalize",
        "cost": "penalize"
      }
    }
  }
}
```

CLI：`ocx route policy list [--json]`、`ocx route policy show <id> [--json]` 與
`ocx route policy dry-run <id> [--model-context <tokens>] [--tools] [--image] [--structured-output] [--json]`。
Dry-run 評估候選項而不發送任何上游請求。

配額證據（`optimize.quota`、`require.minQuotaHeadroom`、`unknownEvidence.quota`）來自帳號索引的 Codex 與 Anthropic 配額快取。僅當證據已識別帳號時，runtime 候選項才收到快取配額。未綁定的標準 `openai` 與 Anthropic 候選項在政策評估期間保持未知，因為池選擇、Direct 呼叫者身分、供應商輪換與執行緒親和性是在政策選擇 provider/model 之後才解析；不將行程現用帳號當作替代。
配額證據永不變更帳號選擇、session 親和性、冷卻或切換行為——它僅餵養政策計分。要在 API dry-run 中看到配額感知行為，請在發送給 `POST /api/routing-profiles/dry-run` 的候選證據中提供帳號參考：`candidates[].codexAccountId`（Codex 池，provider `openai`）或 `candidates[].accountRef`（Anthropic）會推導相符的快取帳號配額；明確的 `candidates[].quota` 物件依原樣回顯。CLI dry-run 無法提供這些 per-candidate 帳號欄位。

### 組合 vs 政策設定檔

- **combo** 是明確的有序／加權目標路由與 failover：設定的順序（或平滑加權 round-robin）決定，失敗會沿清單前進。
- **政策設定檔** 是在設定候選項中的證據式選擇：硬性能力需求先過濾，再以確定性計分排列倖存者。

兩者皆為附別名與碰撞驗證的虛擬命名空間；差異在所選候選項的**方式**。設定檔計分結合設定優先元件與健康（RI-06）、配額（RI-07）與成本（RI-08）計分維度（有證據時）；`latency` 權重併入優先份額而非獨立計分。成本也透過 `limits.maxEstimatedCostUsd` 上限強制執行：估計成本已知且超過上限的候選項被排除（`cost-limit`）。設定上限且估計未知時，預設 `limits.onUnknownCost: "allow"` 在路由決策軌跡上記錄 `cost.capOutcome: "unknown-allowed"` 而不做上限排除；設定 `onUnknownCost: "exclude"` 以取得 fail-closed 上限（`cost-limit-unknown`）。上限結果不是整體資格——`unknownEvidence.cost: "exclude"` 仍可新增 `unknown-price` 並將候選項標記為不合格。政策設定檔執行時會記錄 per-request 的路由決策軌跡。

### 目錄資格

即使 combo 無法被列出，它仍可直接路由。`ocx sync`、`/v1/models` 與 Codex picker 僅在每個目標暴露可交集的能力時才列出它：

- 正數 `contextWindow`，來自即時中繼資料、registry 提示、供應商 `modelContextWindows`／`contextWindow`、成員列的已知正數 `maxInputTokens`，或——當供應商已知且啟用但每個來源仍省略視窗時——保守的 128,000-token 後備（設定 `providerContextCaps` 時收斂）；以及
- 非空的 `inputModalities` 交集，將省略的成員值視為 `["text"]`。

已停用供應商上的目標（即使有完整探索列）、無探索列的未知供應商目標，或徑向不相容的目標，會將 combo 從目錄移除。Sync 發出摘要警告，儀表板標記為 **Needs attention**。請新增 context 中繼資料、調整整體模態，或目標為具可探索相容能力的模型。

## 請求歷史與路由分析

- `GET /api/request-history` - 從衍生的索引（`routing-history.sqlite`）以 cursor 分頁取得完整歷史，附過濾器（`provider`、`model`、`requestedModel`、`status`、`conversationId`、`surface`、`inboundProtocol`、`apiKeyId`、`profileId`、`fallback`、`from`、`to`）與不透明 `cursor` 分頁。`GET /api/request-history/:requestId` 回傳一個標準列。
- `GET /api/request-history/:requestId/route-decision` - why-this-route 說明：軌跡（候選項、排除、計分元件、設定檔＋修訂）、執行嘗試序列與最終結果。
- `GET /api/routing-analytics` - 成功／失敗／取消／fallback 率、p50/p95/p99 持續時間與 TTFT、不完全串流率、觸發冷卻的失敗、每次成功請求成本、覆蓋、信心度與明確的截斷旗標。
- `GET /api/routing-profiles`、`POST /api/routing-profiles/dry-run` - 設定檔檢視與 dry-run 評估（無上游分派）。

回傳的歷史與路由決策 payload 僅暴露遮罩的請求中繼資料（例如不透明 `apiKeyId` 標籤）。它們不包含憑證、原始 prompt body 或供應商秘密。

CLI：`ocx logs explain <request-id>`、`ocx logs rebuild-index`、`ocx logs index-status`、`ocx route policy list | show | dry-run | evaluate`。

## 遷移

`routingProfiles` 為可選且附加式：既有設定檔載入不變。舊 `usage.jsonl` 列（無 `routeDecision`）解析不變。歷史索引可拋棄——刪除 `routing-history.sqlite` 會在下一次查詢時從 `usage.jsonl` 自動重建；`ocx logs rebuild-index` 強制執行一次。此系統中沒有任何東西會自動調校權重、預算或候選集。
