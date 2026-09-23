---
title: 原生脈絡相容性
description: Codex 歷史與筆記轉送功能的使用資格、需驗證身分的試用設定及限制。
---

OpenCodex 已能轉送 Codex 原生歷史與筆記。這不是供路由 provider 使用的通用記憶服務；公開 HTTP 端點也不代表特定 Codex 版本、帳號或模型能使用它們。轉送功能的所有權、取消與憑證邊界請參閱 [Codex 整合](/zh-tw/guides/codex-integration/)。

## 兩項獨立要求

Codex 必須啟用擴充功能，OpenCodex 也必須辨識呼叫者。單獨變更後端 URL 無法滿足任一要求。

經檢查的上游 Codex 契約要求：模型的原生目錄條目宣告 `supports_experimental_context`、使用符合資格的 ChatGPT 登入，以及使用名稱恰為 `OpenAI`、base URL 以 `/backend-api/codex` 結尾的 provider。自動啟用機制會拒絕使用 `env_key`、`experimental_bearer_token`、命令式 `auth` 或 AWS auth 的 provider。經檢查的資格判定接受 ChatGPT Plus、Pro 與 ProLite；這不表示這些方案的每個帳號都能正常使用後端歷史端點。

OpenCodex 另外要求成功的模型請求及後續脈絡請求都帶有有效的**資料平面 API 金鑰**。預設的內建 loopback 注入不會送出該金鑰，因此可能正常提供模型，但脈絡呼叫卻以 `context_principal_required` (403) 失敗。單靠需驗證身分的遠端 provider 表形式也無法使用原生脈絡：其 `env_key` 與 provider 名稱不符合上述 Codex 啟用契約。不要為掩蓋任何一項問題而移除主體或帳號所有權檢查。

## 明確選擇啟用的語法

OpenCodex 接受 Codex `FeatureToml` 支援的兩種持久化根層功能形式：

```toml
[features]
context_management = true
```

等效的表格形式也可使用，且對尚未辨識布林形式的舊版 OpenCodex 而言是相容寫法：

```toml
[features.context_management]
experimental_mode = true
```

兩種形式擇一使用。false、缺失或格式錯誤的值都維持關閉。代理會讀取自己的 Codex home 設定；只在 CLI 覆寫或 Codex profile 中啟用，不會開啟其執行階段閘門。這項變更不會根據模型 metadata 推定已選擇啟用。

## 需驗證身分的原生試用 profile

這是**經原始碼核對的試用設定，並非真實帳號的端對端認證**。測試前請備份 Codex 設定並保存持久的任務檢查點。使用新的拋棄式 thread；不要變更既有正常 thread 的 provider 身分。

在 Codex 程序的環境中，將一把既有且有效的 OpenCodex 資料平面金鑰提供給 `OCX_CONTEXT_API_KEY`。不要使用管理／admin token，也不要將金鑰存入 TOML。獨立啟動的桌面應用程式不會自動繼承服務環境。保留一般 Codex 原生 ChatGPT 登入；額外標頭不會取代 OAuth。

在已啟用上述根層功能、OpenCodex 已設定正式的 ChatGPT forward provider，且原生模型目錄為目前版本的前提下，把以下**額外**的 provider 與 profile 合併至同一份 Codex 設定。連接埠應調整為實際本機代理所用的值。根層 `model_provider` 與既有 provider 表均維持不變。

```toml
[model_providers.ocx-native-context]
name = "OpenAI"
base_url = "http://127.0.0.1:10100/backend-api/codex"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
env_http_headers = { "x-opencodex-api-key" = "OCX_CONTEXT_API_KEY" }

[profiles.ocx-native-context]
model_provider = "ocx-native-context"
model = "gpt-6-astra"
```

以 `codex --profile ocx-native-context` 啟動新的 CLI thread。範例使用 HTTP/SSE，讓初次試用維持在模型到轉送功能的所有權路徑；它不會變更其他 profile 的傳輸方式，也不保證 WebSocket／回合中途引導功能等效。只有帳號的原生目錄確實宣告模型具備脈絡能力時才使用該模型；絕不要強行替 Devin、Gemini 或其他路由條目設定此標記。

自訂 provider ID 是刻意選擇的。上游 Codex 通常不會透過 `model_providers.openai` 覆寫內建 provider；在該處加入額外標頭可能悄悄失效。自訂 ID 保留一般 provider，而精確的 `OpenAI` 名稱符合原生後端的判定條件。不要在此 profile 加入 `env_key`：`env_http_headers` 另外承載本機准入資訊，`Authorization` 則繼續承載原生 ChatGPT 登入。OpenCodex 會消耗本機金鑰，不會將它轉送給 ChatGPT。

根層選擇啟用也會影響其他符合資格的原生 profile。**試用期間，請勿繼續使用缺少額外金鑰的一般內建 loopback thread。** 返回那些 thread 前，請關閉根層功能並執行 `ocx sync`。這不是自動或預設的整合變更；此 CLI profile 也不代表桌面版支援選擇 profile。

## 重設脈絡前先驗證

首先在新 thread 中取得成功的原生模型回應，再驗證筆記寫入、讀回同一筆記，並查詢該 thread 的歷史。只有這些操作都成功後，才讓拋棄式測試使用 `new_context` 並確認已儲存狀態可復原。即使試用成功，也要保留外部檢查點。

- **403 `context_principal_required`：**有效的本機資料平面金鑰未抵達代理。
- **409 `context_account_unavailable`：**所有權缺失或不一致；不要改用目前啟用的帳號，也不要盲目重試寫入。
- **404：**區分代理因功能停用／未知端點所回傳的回應與上游 404。後者無法證明 OpenCodex 有路由缺陷或整個帳號服務中斷。

模型呼叫成功或 `ocx ready` 不代表筆記、歷史或狀態復原可用。模型路由、帳號變更、代理重新啟動與上游端點可用性都是獨立事項。本機標記無法賦予缺失的後端使用資格，失敗的脈絡操作也不能回報為重設成功。完成後移除試用表格並取消設定試用金鑰；除非使用已確認可行、需驗證身分的路徑，否則保持此功能關閉。

## 已檢查的上游契約

以下連結固定上述設定所依據的原始碼契約，並非部署保證：

- [FeatureToml 布林／表格形式](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/features/src/lib.rs)
- [原生脈絡使用資格](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/core/src/session/token_budget.rs)
- [Provider 身分與內建合併規則](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/model-provider-info/src/lib.rs)
- [歷史／筆記使用 provider 的請求標頭與身分驗證](https://github.com/openai/codex/blob/78245b47af2a7aafcabe025828ceecca69db4df1/codex-rs/ext/history-notes/src/backend.rs)
