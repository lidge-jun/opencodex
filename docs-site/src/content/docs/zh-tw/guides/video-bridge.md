---
title: Video Bridge
description: 透過非 OpenAI 模型使用 Grok Imagine Video 生成影片。
---

## 概觀

Video Bridge 讓你透過 opencodex 路由的任何非 OpenAI 模型，使用 xAI 的 Grok Imagine Video 生成。啟用後，對話中會注入一個合成的 `video_gen` 工具。模型像呼叫一般函式工具一樣呼叫它；opencodex 攔截該呼叫、向 xAI 提交影片生成工作、輪詢直到完成，並下載結果。

## 前置條件

- 一個帶有 **API key** 的 `xai` 供應商項目（單靠 `ocx login xai` 不足夠 — video bridge 需要 key 認證，而非 OAuth）
- 一個非 OpenAI 模型作為你的路由供應商（例如 Anthropic Claude、Google Gemini）
- opencodex 設定為透過該非 OpenAI 供應商路由

> **⚠ 需要供應商 key：** Video Bridge 僅在 `xai` 供應商使用
> API key 認證時啟用。將以下加入你的設定：
>
> ```json
> {
>   "providers": {
>     "xai": { "adapter": "openai-chat", "apiKey": "xai-…", "authMode": "key" }
>   }
> }
> ```
>
> 若你是透過 `ocx login xai`（OAuth）接入，供應商會停留在 `authMode: "oauth"`，bridge 不會悄悄啟用。請在環境中設定 `XAI_API_KEY`，**或**如上所示直接寫入 key。

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

## 運作方式

1. opencodex 偵測到帶有 `videoBridgeEnabled: true` 的非 OpenAI 路由模型
2. 對話中注入一個合成的 `video_gen` 函式工具
3. 當模型呼叫 `video_gen` 時，opencodex 向 xAI 的 `/videos/generations` 提交工作
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

- **僅限 xAI**：影片生成僅能透過 xAI 的 Grok Imagine Video API 使用
- **非同步**：影片生成需 30-120 秒
- **費用**：影片生成是付費的 xAI 功能（~$0.05/秒 @480p、~$0.07/秒 @720p）
- **每次呼叫一支影片**：每次 `video_gen` 呼叫產生一支影片
- **與 Image Bridge 共存**：兩個 bridge 可同時啟用
- **網頁搜尋優先**：當某回合有網頁搜尋 sidecar 啟用時（非 `runTurn` adapter），video bridge 會被略過 — 兩者無法並行執行。會發出 `console.warn` 讓你可在日誌中偵測到此情況。
- **逾時涵蓋提交與輪詢**：`videoTimeoutMs` 預算在工作提交前就開始計算，因此提交呼叫（60 秒）與後續輪詢共用同一個截止時間。
