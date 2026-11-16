---
title: Video Bridge
description: 透過非 OpenAI 模型使用 Grok Imagine Video 生成影片。
---

## 概觀

Video Bridge 讓你透過 opencodex 路由的任何非 OpenAI 模型，使用 xAI 的 Grok Imagine Video 生成。啟用後，對話中會注入一個合成的 `video_gen` 工具。模型像呼叫一般函式工具一樣呼叫它；opencodex 攔截該呼叫、向 xAI 提交影片生成工作、輪詢直到完成，並下載結果。

## 前置條件

這些前提條件適用於預設的 xAI 目的地。若已設定 `images.videoProvider`，請參閱[選擇影片提供者](#選擇影片提供者)。

- 一個帶有 **API key** 的 `xai` 供應商項目（單靠 `ocx login xai` 不足夠 — video bridge 需要 key 認證，而非 OAuth）
- 一個非 OpenAI 模型作為你的路由供應商（例如 Anthropic Claude、Google Gemini）
- opencodex 設定為透過該非 OpenAI 供應商路由

> **⚠ 需要供應商 key：** Video Bridge 僅在 `xai` 供應商使用
> API key 認證時啟用。將以下加入你的設定：
>
> ```json
> {
>   "providers": {
>     "xai": { "adapter": "openai-chat", "apiKey": "${XAI_API_KEY}", "authMode": "key" }
>   }
> }
> ```
>
> 在代理的啟動環境設定 `XAI_API_KEY`，保留 `${XAI_API_KEY}` 並明確使用 `authMode: "key"`。其他終端的匯出不會變更執行中的代理；請透過所屬 Desktop、服務或前景終端重新啟動。不要將金鑰寫入提交、紀錄或共用報告。

## 設定

將 `videoBridgeEnabled: true` 加入你的 `images` 設定：

```json
{
  "images": {
    "bridgeEnabled": true,
    "videoBridgeEnabled": true,
    "videoBridgeModel": "grok-imagine-video",
    "videoMaxRounds": 2,
    "videoTimeoutMs": 300000
  }
}
```

| 選項 | 預設值 | 說明 |
|--------|---------|-------------|
| `videoBridgeEnabled` | `false` | 總開關。必須明確啟用。 |
| `videoBridgeModel` | `"grok-imagine-video"` | xAI 影片模型 id。 |
| `videoMaxRounds` | `2` | 強制最終回答前的最大 video-gen 回合數。 |
| `videoTimeoutMs` | `300000`（5 分鐘） | 每支影片包含輪詢在內的逾時。 |
| `videoProvider` | 未設定（xAI） | 選用的 API 金鑰提供者，以其自身的 `baseUrl` 與金鑰處理 `video_gen`。請參閱[選擇影片提供者](#選擇影片提供者)。 |

## 選擇影片提供者

預設情況下，橋接會以 `xai` 提供者的 API 金鑰將 `video_gen` 工作送到 xAI。若要送到實作相同非同步 API（先 `POST {baseUrl}/videos/generations`，再 `GET {baseUrl}/videos/{id}`）的其他後端（例如自行架設的媒體橋接），請設定 `images.videoProvider`。

```json
{
  "providers": {
    "my-video-bridge": {
      "adapter": "openai-chat",
      "baseUrl": "http://127.0.0.1:8790/v1",
      "apiKey": "${VIDEO_BRIDGE_KEY}",
      "authMode": "key",
      "allowPrivateNetwork": true
    }
  },
  "images": {
    "videoBridgeEnabled": true,
    "videoProvider": "my-video-bridge",
    "videoBridgeModel": "grok-imagine-video"
  }
}
```

- 僅使用所指定提供者自身的 `baseUrl` 與 API 金鑰作為目的地與憑證。轉接器類型不限，但必須使用 API 金鑰驗證。
- `"videoProvider": "xai"` 一律使用固定的 `https://api.x.ai/v1`，與 `xai` 項目的 `baseUrl` 無關。其他內建提供者 ID 會被拒絕，請改為指定自訂提供者。
- 迴路或私人網路的 `baseUrl` 與其他提供者流量相同，需要在該提供者上設定 `allowPrivateNetwork: true`。
- 可辨識為 xAI 的金鑰（`xai-` 格式的金鑰、任何 `xai` 項目持有的金鑰、指向其他提供者機密的鑰匙圈參照，或以 xAI、Grok 命名的環境變數參照）在 `https://api.x.ai` 以外的所有來源都會遭拒，因此 xAI 金鑰絕不會送往其他後端。已暫停的使用中金鑰同樣會遭拒，`baseUrl` 也不得包含憑證、查詢參數或片段。
- 若提供者不存在、已停用、已暫停、沒有金鑰或遭拒絕，每次 `video_gen` 呼叫都會將該錯誤回傳給模型。不會送出任何內容，也不會改用 xAI。
- 完成的影片仍只會從 base64 `data:` URL 或公開 `https:` URL 下載，因此本機橋接必須以 `video.url` 回傳其中之一。

## 運作方式

1. opencodex 偵測到帶有 `videoBridgeEnabled: true` 的非 OpenAI 路由模型
2. 對話中注入一個合成的 `video_gen` 函式工具
3. 當模型呼叫 `video_gen` 時，opencodex 向 xAI 的 `/videos/generations` 提交工作（若已設定 `images.videoProvider`，則提交到該提供者）
4. Bridge 每 5-15 秒輪詢工作狀態，並發送 heartbeat 訊息以保持串流活躍
5. 影片就緒後，下載到 artifacts 目錄
6. 本機檔案路徑作為工具結果回傳給模型

## 支援的參數

`video_gen` 工具接受：

| 參數 | 型別 | 範圍 | 說明 |
|-----------|------|-------|-------------|
| `prompt` | string | 必填 | 詳細的影片生成 prompt |
| `duration` | integer | 1-15 | 影片長度（秒） |
| `resolution` | string | `"480p"`、`"720p"` | 影片解析度 |
| `aspect_ratio` | string | 7 種比例 | `16:9`、`9:16`、`1:1`、`4:3`、`3:4`、`3:2`、`2:3` |

## 限制

- **預設為 xAI**：未設定 `videoProvider` 時，影片生成使用 xAI 的 Grok Imagine Video API；其他後端必須實作相同的非同步 API
- **非同步**：影片生成需 30-120 秒
- **費用**：影片生成是付費的 xAI 功能（~$0.05/秒 @480p、~$0.07/秒 @720p）
- **每次呼叫一支影片**：每次 `video_gen` 呼叫產生一支影片
- **與 Image Bridge 共存**：兩個 bridge 可同時啟用
- **網頁搜尋優先**：當某回合有網頁搜尋 sidecar 啟用時（非 `runTurn` adapter），video bridge 會被略過 — 兩者無法並行執行。會發出 `console.warn` 讓你可在日誌中偵測到此情況。
- **逾時涵蓋提交與輪詢**：`videoTimeoutMs` 預算在工作提交前就開始計算，因此提交呼叫（60 秒）與後續輪詢共用同一個截止時間。
