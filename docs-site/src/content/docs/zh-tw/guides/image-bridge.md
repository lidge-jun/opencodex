---
title: Image Bridge
description: 在使用非 OpenAI 供應商時，將 image_generation hosted-tool 呼叫路由到 xAI Grok Imagine。
---

## 概觀

當你透過非 OpenAI 模型（Claude、Gemini、Grok 等）路由 Codex 時，`image_generation` **hosted tool** 通常無法運作 — 它需要 OpenAI 的伺服器端執行環境。Image Bridge 偵測這些呼叫並透明地將它們重新路由到 xAI Grok Imagine，讓你實際對話的模型仍能生成圖片。

## 前置條件

- 在設定中設定 `images.bridgeEnabled: true` 以**啟用 bridge**（預設關閉以避免非預期的 xAI 費用 — 見下方[設定](#設定)）。
- 一個帶有 **API key** 的 `xai` 供應商項目。Bridge 將履行釘選到 registry 的 xAI Images 端點（`https://api.x.ai/v1`）；任何已設定的 `baseUrl` 覆寫在圖片呼叫時會被忽略。單靠 OAuth / `ocx login xai` **不會**啟用 bridge（Grok CLI 的 OAuth transport 是聊天導向的，不用於 `/images/*`）。

  ```json
  {
    "providers": {
      "xai": { "adapter": "openai-chat", "apiKey": "xai-…", "authMode": "key" }
    }
  }
  ```

- 一個非 OpenAI 模型被選為你的活躍供應商。（當活躍供應商為 OpenAI 時，會直接使用原生 hosted tool，bridge 被略過。）

## 設定

Image Bridge 選項位於 `~/.opencodex/config.json` 的 `images` 之下。Bridging 為**選擇加入** — 你必須設定 `bridgeEnabled: true` 才能啟用付費的 xAI Grok Imagine 生成：

```json
{
  "images": {
    "bridgeEnabled": true,
    "bridgeModel": "grok-imagine-image-quality",
    "maxRounds": 3,
    "timeoutMs": 60000
  }
}
```

| 選項 | 預設值 | 說明 |
| --- | --- | --- |
| `bridgeEnabled` | `false` | 總開關。設 `true` 啟用 bridging。預設關閉以避免非預期的 xAI 費用。 |
| `bridgeModel` | `grok-imagine-image-quality` | 要將 prompt 送往的 xAI 圖片模型 id。 |
| `maxRounds` | `3` | 每回合的最大圖片生成迴圈迭代數。向下取整為整數並限制在 `[0, 10]`；非有限值回退到 `3`。 |
| `timeoutMs` | `60000` | 每次呼叫的 xAI 期限（毫秒）。有限正值會向下取整並傳給 xAI 請求。 |
| `artifactsKeepCount` | `200` | `artifacts/` 下保留的最大檔案數。超過時，每次履行呼叫後刪除最舊的檔案。設為 `0` 或負值可停用修剪。 |

## Artifact 保留

生成的圖片寫入 `~/.opencodex/artifacts/`。為防止長時間執行的 session 無限制增長磁碟用量，目錄會在每次履行的圖片呼叫後自動修剪（該呼叫的完整批次上磁碟後）— 當數量超過設定的最大值（預設 200，可透過 `images.artifactsKeepCount` 設定）時，刪除最舊的檔案（依修改時間）。只有通過修剪的路徑會回傳給模型。

## 運作方式

Image Bridge 僅在選取了**非 OpenAI** 模型、且 **Responses** 回合的 `/v1/responses` tools 陣列中包含 hosted `image_generation` 工具時啟用。它**不會**攔截 Codex 內建的 `image_gen` 工具，該工具直接 POST 到 `/v1/images/generations`（或 `/images/edits`）— 該路徑另見 [Codex 整合](/zh-tw/guides/codex-integration/#built-in-image-generation-image_gen)。

1. 當 Responses 請求在 `tools` 中列出 `image_generation` 時，OpenCodex 在請求前處理期間偵測到它。
2. Hosted tool 被替換為一個路由模型可正常呼叫的**合成函式工具** — 模型看到的是一個可呼叫的工具，而非一個它無法執行的不透明 hosted tool。
3. 當模型呼叫該工具時，OpenCodex 攔截呼叫並將 prompt 送往 xAI 的圖片生成 API。
4. 生成的圖片儲存到 `~/.opencodex/artifacts/`，**本機檔案路徑**作為工具結果回傳給模型。
5. 模型帶著對生成圖片及其位置的認知繼續對話。

從模型角度什麼都沒變 — 它呼叫了一個工具並得到結果。從使用者角度，圖片生成可用於任何路由供應商，而非悄悄失敗。

## 限制

- **僅支援 xAI Grok Imagine。** DALL-E 與其他圖片供應商日後可能加入。
- **網頁搜尋優先**，於支援網頁搜尋 sidecar 迴圈的 adapter 上。若同一回合同時請求網頁搜尋與圖片生成，會執行網頁搜尋並略過圖片生成。Cursor/`runTurn` adapter 目前無法使用該 sidecar，因此 image bridge 對那些雙工具回合仍可能執行。
- **適用 xAI 費用。** 透過 xAI 的圖片生成需要有效的 xAI 訂閱或 API 額度。
- **僅限串流。** Bridge 透過攔截 SSE 回應串流運作；帶有 `stream: false` 的請求會以 400 錯誤拒絕。
