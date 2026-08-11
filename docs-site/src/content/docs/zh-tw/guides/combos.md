---
title: "組合：failover 與負載平衡"
description: 將一個虛擬模型路由到多個供應商，以進行 failover 或加權負載平衡。
---

**combo** 是一個虛擬模型，背後代表一個有序的真實供應商/模型目標清單。你的客戶端請求 `combo/<id>`；opencodex 選擇一個目標，將請求改寫為該具體的 `provider/model`，並可在第一個目標發生可重試失敗時嘗試另一個目標。

這在你想要以下任一情況時有用：

- **Failover：** 偏好一個模型，但隨時備有後備。
- **負載平衡：** 以加權批次將成功請求分散到多個模型或供應商。

Combo 位於一般供應商路由之前。若 `provider/model` 選擇器對你而言是新的，請先閱讀[模型路由](/zh-tw/guides/model-routing/)。

## 60 秒快速入門

此範例建立 `combo/main`，Anthropic 在前、OpenAI 在後。兩個供應商必須已存在且已啟用。

```bash
ocx combo set main --targets anthropic/claude-opus-4-8,openai/gpt-5.6-sol
```

預設策略為 failover，因此正常請求會送往 `anthropic/claude-opus-4-8`。若該次嘗試發生可重試失敗，opencodex 可跳到 `openai/gpt-5.6-sol`。

在你平常會提供模型 id 的任何地方使用該虛擬模型：

```json
{
  "model": "combo/main",
  "input": "Explain why the sky looks blue."
}
```

確認已儲存的定義：

```bash
ocx combo show main
```

:::tip
從 failover 與等權重開始。只有在你刻意要分散流量時才切換到 round-robin，且只有在等量分配不適當時才加入權重。
:::

## Combo 名稱如何運作

`ocx combo set <id>` 中的 combo id 必須以字母或數字開頭。其後可含字母、數字、`.`、`_` 或 `-`，總長最多 64 字元。其規範模型 id 始終為 `combo/<id>`；例如 id `main` 變成 `combo/main`。

設定 combo 時，`combo/` 命名空間會被保留。名為 `combo` 的供應商無法佔用它，且 combo id 不能與已設定的供應商名稱重複。

可選的別名給 combo 一個不同的公開模型名稱。別名：

- 使用與 id 相同的字元；
- 可為裸名（例如 `daily-fast`），或含一個 `/`（例如 `team/daily-fast`）；
- 不能是 `combo` 或以 `combo/` 開頭；
- 不能與另一個 combo 別名重複；且
- 不能是以 `gpt-`、`o1-`、`o3-`、`o4-` 或 `codex-` 開頭的裸原生 OpenAI 系列名稱。

即使設定了別名，規範的 `combo/<id>` 形式仍可解析。規範查詢在別名匹配之前執行，因此別名無法接管另一個 combo 的規範 id。

:::note
別名改變客戶端請求的公開名稱；不改變 combo 儲存的 id 或其背後的具體供應商/模型選擇器。
:::

## Codex Desktop 原生 allowlist 相容性

某些 Codex Desktop 版本會在 app-server 已載入 `model_catalog_json` 之後，套用只允許原生的遠端
`available_models` allowlist。因此 `Nova1/codex-gpt-5.6-sol` 這類正常路由 id 在 CLI 可用，卻不會
出現在 Desktop 的選擇器中。這是上游的 [Codex Desktop bug](https://github.com/openai/codex/issues/19694)，
由 [opencodex #241](https://github.com/lidge-jun/opencodex/issues/241) 追蹤。

當你控制一個等效的路由目標時，combo 可以明確接管一個原生 slug：

```bash
ocx combo set nova-sol \
  --targets Nova1/codex/gpt-5.6-sol \
  --alias gpt-5.6-sol \
  --native-alias \
  --display-name 'Nova1 - codex-gpt-5.6-sol'
```

此模式刻意採 opt-in，而且必須同時具備 `--native-alias` 與非空的顯示標籤。別名必須是這個
opencodex 版本支援的原生模型 id 之一；僅有原生系列前綴不會被接受，因為移除時必須能恢復具權威性的
中繼資料。當路由目標的 discovery 回應只提供模型 id 時，相容性列會從它所取代的原生 id 補上缺少的
context、modality 與 reasoning 中繼資料。明確的目標限制仍然優先，因此這個 fallback 永遠不會提高
context 上限或覆寫已宣告的能力。它會改變精確路由的優先順序：`gpt-5.6-sol` 的請求會先解析到
`combo/nova-sol`，然後才是規範的 OpenAI 原生系列路由。目錄只包含一個帶所設定顯示標籤的裸列，
而不是重複的原生列與 combo 列。只會捕捉裸的 `gpt-5.6-sol` slug。帳號限定列（如
`main/gpt-5.6-sol`）與供應商限定列（如 `openai-apikey/gpt-5.6-sol`）仍是不同的 OpenAI 路由；
供應商限定的 API-key 路由永遠不會落到原生別名上。

可見性鍵依然明確：

- `combo/nova-sol` 把相容性 combo 從 discovery 中隱藏。
- `disabledModels` 中的裸 `gpt-5.6-sol` 項目仍然指休眠的原生 OpenAI 列；它不會隱藏目前擁有該
  公開 slug 的 combo。
- 只要仍設定至少一個原生別名，被停用的裸原生列就會從有效 Codex 目錄中省略，而不是保留為
  `visibility: "hide"`。這可以防止 Desktop 的 allowlist 復活不該顯示的列。Models 頁面仍會列出
  未被遮蔽的原生開關，重新啟用其中一個會恢復其保留或目前的原生中繼資料。

:::caution
原生別名刻意接管一個看起來像第一方模型的 id。只有在目標營運上等效、且誠實標示選擇器列時才使用它。
移除 combo 會在下次 sync 時恢復正常原生路由與目錄身份。
:::

## 選擇策略

### Failover：有序的主與後備

`failover` 依設定順序選擇第一個合格目標。當目標的供應商存在、已啟用、未冷卻中、且能處理任何特殊請求限制時即為合格。權重與 `stickyLimit` 不影響此策略。

給定此順序：

1. `anthropic/claude-opus-4-8`
2. `openai/gpt-5.6-sol`
3. `google/gemini-3-pro`

每個請求從 Anthropic 開始。Anthropic 的可重試失敗會將該請求移到 OpenAI；OpenAI 的可重試失敗可將它移到 Google。終端錯誤會立即停止，而不嘗試剩餘目標。

### Round-robin：平滑加權批次

`round-robin` 使用平滑加權輪詢。較大的目標權重讓該目標隨時間獲得較大份額，而不會將其所有份額一次送出為一長區塊。`stickyLimit` 控制在下次加權選擇前有多少成功請求留在所選目標上。

建立一個 2:1 combo，每兩個成功請求為一批：

```bash
ocx combo set balanced \
  --targets anthropic/claude-opus-4-8:2,openai/gpt-5.6-sol:1 \
  --strategy round-robin \
  --sticky 2
```

稱目標 **A**（權重 2）與 **B**（權重 1），前六次加權選擇為
`A, B, A, A, B, A`。因為 `stickyLimit` 為 2，每次選擇維持活躍兩個成功請求：

| 成功請求 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 目標 | A | A | B | B | A | A | A | A | B | B | A | A |

長期份額仍為 2:1。可重試失敗會結束目前 sticky 批次、冷卻該目標，並為同一請求選擇另一個合格目標。

:::caution
權重是相對的，不是百分比。權重 `2,1` 與 `200,100` 表達同一比例。偏好能傳達意圖的小數值。
:::

## 目標失敗時會發生什麼

Combo 失敗分為**跳轉**失敗與**終端**失敗。

| 結果 | 行為 |
| --- | --- |
| HTTP 401、403、404、408、429 或任何 5xx | 冷卻目標並跳到下一個合格目標。 |
| 分類為認證、訂閱、配額、限流、過載或上游伺服器錯誤 | 冷卻目標並跳轉，即使單靠狀態碼不足。 |
| 客戶端取消（499）、`origin_rejected`、cyber-policy 拒絕、上下文溢出或無效請求 | 停止並回傳錯誤；另一個目標不會讓請求變為有效。 |
| 任何其他未分類錯誤 | 停止並回傳錯誤。 |

跳轉的目標預設進入 60 秒冷卻。若上游回應包含有效的 `Retry-After` 值，opencodex 改用它。接受數字秒與 HTTP-date 值，且每次冷卻上限為 10 分鐘。

目前請求永不重試同一已嘗試目標。後續請求會略過它直到冷卻到期。若無合格目標剩餘，代理回傳 HTTP 503 並帶 `error.code = "combo_unavailable"`。

:::note
Failover 是刻意受限的。它有助於目標特定的可用性、認證、配額與過載失敗；不會隱藏呼叫者錯誤或策略拒絕。
:::

## 預設推理 effort

`defaultEffort` 僅在以下全為真時提供 `reasoning.effort`：

1. combo 有非 null 預設值；
2. 呼叫者未設定 effort；且
3. 所選目標的目錄宣告該精確 effort。

若請求沒有 `reasoning` 物件，opencodex 建立一個。若 `reasoning` 存在但無 `effort` 屬性，它保留其他欄位並加入預設值。呼叫者提供的 effort 永不被覆寫。

當目標能力未知或不包含設定的 effort 時，opencodex 省略預設值並保持目標自身行為不變。支援的值為 `low`、`medium`、`high`、`xhigh`、`max` 與 `ultra`；省略欄位或設為 `null` 可將 effort 完全交給呼叫者與目標。

## 加密的 v2 子代理任務

Codex v2 子代理有一個重要限制（[issue #92](https://github.com/lidge-jun/opencodex/issues/92)）。原生父代只能將新生成 worker 的任務以為原生 ChatGPT 後端鑄造的密文發送。外部供應商無法讀取該 payload。

對於此類請求，combo 將其合格目標過濾為規範的原生 ChatGPT 路由，包括可重試失敗之後。若 combo 無可解密目標，opencodex 在分派前停止並回傳 HTTP 400：

```json
{
  "error": {
    "type": "invalid_request_error",
    "code": "unreadable_encrypted_agent_task"
  }
}
```

這保護任務不被送往一個會收到無法讀取指令的供應商。可讀的明文任務使用正常 combo 策略。

你有四個恢復選項：

1. 為子任務選擇原生 ChatGPT 模型。
2. 在 combo 中新增規範的原生 ChatGPT 目標。
3. 對跨不同供應商的委派使用 v1 介面。
4. 若你控制呼叫者，將任務以明文 v2 `agent_message` 內容重送。

關於 v1/base/v2 模式與完整的加密任務工作流程，請見[子代理介面](/zh-tw/guides/sub-agent-surface/)。

## 管理 combo

### 儀表板

開啟本機儀表板並選擇 **Combos**。該工作區可建立、編輯、重新命名與移除 combo，且其目標 picker 會排除已停用的模型與巢狀 combo。

### CLI

主要指令為：

```bash
ocx combo list
ocx combo show <id>
ocx combo set <id> --targets provider/model[:weight],...
ocx combo remove <id> --yes
```

`set` 也接受 `--strategy`、`--sticky`、`--effort`、`--alias` 與 `--rename-from`。用 `-` 作為 `--effort` 或 `--alias` 的值可清除該欄位。`create` 與 `update` 為 `set` 的別名；`delete` 為 `remove` 的別名；且相同子指令在 `ocx route combo` 下也可用。

### 管理 API

無頭客戶端在 `/api/combos` 上使用 `GET`、`PUT` 與 `DELETE`。`GET` 列出規範化的 combo 定義，`PUT` 建立或取代一個（且可重新命名一個），`DELETE` 接受 id 查詢參數。認證與請求/回應細節請見
[管理 API 參考](/zh-tw/reference/management-api/)。

完整的持久化設定請見[設定](/zh-tw/reference/configuration/)。

## 設定參考

Combo 儲存於頂層 `combos` 物件中，以 combo id 為 key：

```json
{
  "combos": {
    "balanced": {
      "targets": [
        { "provider": "anthropic", "model": "claude-opus-4-8", "weight": 2 },
        { "provider": "openai", "model": "gpt-5.6-sol", "weight": 1 }
      ],
      "strategy": "round-robin",
      "stickyLimit": 2,
      "defaultEffort": "high",
      "alias": "team/balanced"
    }
  }
}
```

| 欄位 | 必填 | 預設值 | 規則 |
| --- | --- | --- | --- |
| `targets` | 是 | — | 已設定 `{ provider, model, weight? }` 目標的非空有序陣列。重複的供應商/模型對會被拒絕。 |
| `targets[].weight` | 否 | `1` | 1 到 10,000 的整數。由 round-robin 使用；failover 忽略。 |
| `strategy` | 否 | `"failover"` | `"failover"` 或 `"round-robin"`。 |
| `stickyLimit` | 否 | `1` | 每次 round-robin 選擇的成功請求數，1 到 100 的整數。 |
| `defaultEffort` | 否 | `null` | `low`、`medium`、`high`、`xhigh`、`max` 或 `ultra`；僅在呼叫者省略 effort 且目標宣告支援時套用。 |
| `alias` | 否 | 無 | 可選的修剪後公開模型 id；使用上述別名規則。空值儲存為無別名。 |

## 疑難排解

### 為什麼 `combo/<id>` 回傳 404？

Combo id 未知。回應為 HTTP 404 並帶 type `invalid_request_error`。執行 `ocx combo list`、檢查拼字與大小寫，並確認你的管理指令寫入的是同一個接收模型請求的執行中 opencodex 實例。

### 為什麼我得到 `combo_unavailable`？

每個目標目前都不合格：例如其供應商已停用、冷卻中、已為此請求嘗試過，或加密 v2 任務排除它。檢查目標供應商狀態與近期上游錯誤。對於冷卻，等待 60 秒預設或上游 `Retry-After` 期間（絕不超過 10 分鐘），然後重試。

### 為什麼我的別名被拒絕？

先檢查別名文法與保留名稱。重複別名或無效形狀以 HTTP 400 拒絕；第一段為已設定 Codex 帳號命名空間的斜線別名以 HTTP 409 拒絕；請選擇不同的別名命名空間。CLI 與儀表板會顯示伺服器的精確驗證訊息。

### 為什麼 failover 在第一個錯誤後就停止了？

該錯誤是終端的而非目標特定的。修正無效輸入、縮減過大的上下文、處理策略拒絕，或更正被拒的請求來源。Combo 對那些情況不會跳轉。
