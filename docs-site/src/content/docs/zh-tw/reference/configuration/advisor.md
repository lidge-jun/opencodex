---
title: 顧問
description: 獨立專家諮詢，支援 manual、preflight 與依據證據的 adaptive 策略。
---

顧問是一個獨立的專家模型，審閱 Worker 的任務並返回建議。OpenCodex 端到端地擁有整個諮詢過程：代理向 Worker 的回合注入合成的 `advisor` 工具，自己透過正常路由權威執行諮詢，並回注建議使原 Worker 繼續。Worker 無需委託、無需 spawn 任何東西、也不攜帶 provider 憑證。

這與子代理面（見[代理設定](/zh-tw/reference/configuration/agents/)）不同：子代理是透過 Codex 協作工具由 Worker 發起的委託。顧問是客户端完全不可見的代理側 sidecar —— 即使從不 spawn 的 Worker 也能獲得建議。

## 設定

在儀表板 **Advisor** 頁面從目錄選擇專家模型。選擇器原樣儲存原生、供應商、指定帳戶、自訂和組合模型的識別碼。已停用和等待初始選擇的模型不會作為新選項。已儲存但不在可選目錄中的識別碼會保留並顯示警告，直到您選擇其他模型或清除。目錄載入失敗時保留目前選擇並提供重試。請選擇能回傳文字建議的模型；目錄不保證諮詢相容性。CLI 和 API 仍接受路由器支援的模型字串。

```json
{
  "advisor": {
    "enabled": true,
    "model": "gpt-6-astra",
    "effort": "max",
    "policy": "preflight",
    "contextSharingConsent": "v1"
  }
}
```

| 欄位 | 類型 | 預設值 | 意義 |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | `false` | 總開關。關閉時請求路徑上沒有任何 advisor 行為。 |
| `model?` | `string` | — | 專家模型。任何路由權威接受的模型字串：裸原生模型（`gpt-6-astra`）、明確 `provider/model`（`anthropic/claude-sonnet-4-6`、`xai/grok-...`）或帳戶限定的原生模型。完整支援跨 provider：Worker 與 Advisor 無需同屬一個 provider。 |
| `effort?` | `string` | `"max"` | Advisor 呼叫的推理強度（`low` 至 `ultra`）。 |
| `policy?` | `"manual" \| "preflight" \| "adaptive"` | `"manual"` | 何時諮詢顧問。 |
| `maxConsultationsPerTask?` | `integer` | `3` | 自適應任務諮詢上限（1–3 次嘗試），包含手動呼叫。 |
| `timeoutMs?` | `number` | `120000` | 回環諮詢逾時。 |
| `contextSharingConsent?` | `"v1"` | 缺省 | 操作者同意把任務上下文傳送給所設定的顧問 provider。只有 `"v1"` 是目前版本。缺省、過期或其他值都表示不傳送任務內容。`enabled: true` 本身不是同意。 |

透過儀表板的 **Advisor** 頁面或 `ocx advisor status|on|off|set --model <model> --effort <effort> --policy <manual|preflight|adaptive>` 管理。

沒有目前同意時，`ocx advisor on` 不會開啟跨 provider 傳送：它會印出揭露並停止。`ocx advisor on --ack-context-sharing` 與 `ocx advisor consent` 記錄 `v1`。`ocx advisor consent --revoke` 會移除同意並立即停止傳送。`ocx advisor set` 不授予同意。儀表板上的同意核取方塊預設不勾選。

## 策略

- **`manual`** — 僅當 Worker 明確呼叫合成的 `advisor` 工具時諮詢。該呼叫由代理攔截，客户端不可見，也不會作為本地工具執行。
- **`preflight`** — OpenCodex 會在每個任務自動嘗試一次額外諮詢。失敗的諮詢不會被當作建議：任務會在失敗帳本條目過期後重試。當 Worker 產出第一份方向性證據（最新使用者訊息之後的助手工具呼叫或工具結果）時，代理會諮詢顧問並在 Worker 下一回合之前注入建議 —— 即使 Worker 從不呼叫該工具。觸發條件是確定性的、有文件記載的近似規則，不是語義級「模型卡住了」偵測器。

## 同意

在操作者記錄上下文共享同意 `v1` 之前，不會傳送任務上下文。此欄位有版本，以便日後揭露範圍擴大時改用 `v2`，而不是沿用這次授權。執行期會強制執行。缺少或過期時顧問不可執行（`advisor_context_sharing_consent_required`），編碼請求本身繼續。Worker、顧問模型，以及任務文字裡的字串都不能授予同意。

## Advisor 能看到什麼

一次諮詢可能傳送：

- 最新的使用者任務
- 已解析會話中可見的使用者、助理和開發者文字
- 工具呼叫與工具參數
- 工具結果
- Worker 的工具目錄和描述
- Worker 身分與所設定的顧問模型
- Worker 呼叫 `advisor()` 時的選用焦點問題

所設定的顧問 provider 可能與 Worker 的 provider 不同。

諮詢同時遵守呼叫者擷取的 API key 模型範圍、付費 combo 同意與裝置 fallback 限制，以及 Advisor 自身准入金鑰的主機限制：設定時為 `OPENCODEX_API_AUTH_TOKEN` 或本代理接受的服務 token 檔案，否則為第一個設定的 API key。只有在最後這種情況下金鑰順序才有影響：請把能存取 Advisor 模型的金鑰放在第一位，否則每次諮詢都無法使用。設定了環境或服務 token 時，由該 token 決定諮詢。這些規則同樣適用於 combo 選擇、巢狀決策模型與重試。無法滿足這些規則的諮詢會向 worker 回傳不可用通知。

例如，`allowMeteredComboTargets: false` 的 `laptop` 金鑰無法透過 Advisor 在計費 combo 目標上花費，`fallback.devices.laptop.provider: false` 也會阻擋 Advisor 的 provider fallback 跳轉。沒有金鑰的 loopback 呼叫者仍需要 combo 的 `allowMeteredTargets: true` 選擇加入。當兩個金鑰都設定 `allowMeteredComboTargets: true` 且 combo 設定 `allowMeteredTargets: true` 時，即使經由公開綁定的 loopback 監聽器，Advisor 也能使用計費目標。伺服器在驗證請求時擷取呼叫者政策，早於等待本文容量或讀取本文；之後的金鑰或 fallback 編輯無法擴大該次諮詢。這也涵蓋路由的視覺輔助、compact 請求及其決策模型，以及 WebSocket 回合內的每次候選重試。每個新的 WebSocket 回合會擷取自己的政策。

OpenCodex 不會把 provider API key、Authorization 標頭、OAuth token、僅後端使用的設定密鑰、行程環境或隱藏的思維鏈寫進該提示，也不會解密或轉送加密的 provider 私有推理。**任務內容不做通用脫敏。** 貼進任務的金鑰、工具讀到的檔案裡的秘密、工具或日誌印出的 token 都可能被傳送。OpenCodex 不執行通用 DLP。

## 權威

手動建議是 Worker 自己發出的 `advisor` 呼叫所對應的工具結果。結果是一個 JSON 物件。`advice` 是顧問模型的文字。`status` 由執行期寫入。

自動建議的 JSON 內容放在獨立的 user-role 建議訊息中。developer 訊息只保留固定的執行期傳輸說明，顧問產生的文字不會進入 developer/system 內容；OpenAI Chat 與 Anthropic 都能傳遞它，不需偽造工具呼叫。JSON 跳脫能防止結構突破與欄位偽造，但不能保證模型忽略自然語言中的惡意指令。專門的諮詢結果協定可進一步區分建議與使用者請求。每個請求最多進行 3 次諮詢與 4 次 Advisor worker 續寫。諮詢額度耗盡後移除 advisor 工具，重複呼叫只允許一次攜帶上限結果的最終續寫；再次呼叫會以 502 advisor_continuation_limit 結束，不再傳送隱藏的 worker 請求。空完成重試共用此上限。

抑制不讀取顧問字串。自動去重只看伺服器端帳本。複製了傳輸文字的 developer 訊息也不能抑制 preflight。

## 成本與記帳

每次諮詢都是真實的額外模型呼叫。它以 **advisor 模型**計入用量 —— 絕不併入 Worker 的 token 計數 —— 並且每次諮詢會寫一條帶觸發方式、時長、狀態和用量的 `[advisor]` 日誌行，因此 advisor 呼叫永遠可以從日誌中證明。

## 失敗行為

Advisor 失敗是 fail-open 的：已經發出的諮詢若失敗（模型不可用、設定錯誤、逾時），Worker 會收到簡短、無誤導性的「advisor 不可用」通知（preflight 為 `<opencodex_advisor_unavailable>` 訊息，manual 為錯誤工具結果）並繼續任務；只有諮詢被取消時才什麼都不注入，而計畫根本未發起諮詢（未啟用、未設定模型、或缺少目前上下文共享同意）時也不會送出 preflight 通知。沒有目前同意時，手動 `advisor()` 呼叫回傳 consent-required 工具結果，且不外送。Advisor 失敗不會讓編碼請求失敗，諮詢也不會切換會話的主模型。

## PR1 限制

- 原生 OpenAI passthrough 回合（ChatGPT 池 Worker）不會獲得合成工具；advisor 支援覆蓋路由（translated）provider。preflight 諮詢適用於 run-turn 介面卡；工具不適用。
- 不提供語義卡住偵測、任務完成複核、升級分層、多專家或投票；自適應觸發只使用已觀察到的工具證據。
- preflight 去重帳本是行程內的；代理重啟後，進行中的任務可能再收到一次 preflight 諮詢。

## 依據證據的自適應諮詢與活動記錄

`adaptive` 在初始諮詢之外，只有同一工作目錄中的同一驗證命令失敗、後續檔案編輯成功、重新執行驗證仍失敗時才諮詢。成功驗證會清除對應失敗；編輯前已啟動的驗證不算修復後重試。初始與失敗階段分別去重，自動諮詢需要穩定的對話識別碼。工具須提供明確退出碼及配對的呼叫/結果；複雜腳本、批次呼叫、shell 修改及模糊輸出不觸發。

以 `ocx advisor set --policy adaptive --max-consultations 2` 設定預算。自適應模式中，手動與自動嘗試共用每項任務 1–3 次預算，服務端在發出呼叫前寫入 `OPENCODEX_HOME/advisor-budget.sqlite`，重啟或切換 Worker 不會歸零。僅儲存任務摘要、次數及到期時間，首次呼叫後 24 小時到期；最多保留 512 項任務。預算無法使用或耗盡時 Worker 繼續執行。已發出的失敗或取消呼叫仍可能計費，因此不退還額度。缺少穩定識別碼時僅保留請求級手動呼叫。

Advisor 頁面與 `ocx advisor activity --json`（`GET /api/advisor/activity`）顯示目前程序最近 24 小時內最多 100 筆呼叫中繼資料，可見時每 5 秒更新。包括原因、狀態、模型、耗時、已回報的輸入/輸出 Token、要求及介接器映射的推理等級；不存任務內文、命令、建議或對話識別碼，重啟即清空。映射僅代表介接器發出的參數；未回報保持未知，不推測精確費用或建議採納情況。
