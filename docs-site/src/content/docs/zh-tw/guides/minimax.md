---
title: MiniMax 用戶端
description: 讓 MiniMax Code 與 MiniMax CLI 的文字指令透過 OpenCodex 路由，無須暴露 MiniMax 憑證。
---

MiniMax 提供兩款不同的命令列產品。OpenCodex 依各自實際提供的協定邊界進行整合：

- **MiniMax Code**（`mcode`）是支援自訂 Anthropic Messages 供應商的程式碼代理。
- **MiniMax CLI**（`mmx`）是多模態平台 CLI。只有其 `text` 資源使用 OpenCodex 可路由的 Anthropic 相容 API。

## MiniMax Code

先依照 MiniMax 的說明安裝並登入 MiniMax Code，接著啟動 OpenCodex，連接可復原的檔案整合：

```bash
ocx start
ocx integration client enable --client mcode
ocx mcode
```

![以隔離範例資料呈現的 MiniMax Code 整合](/screenshots/minimax-code-integration.png)

整合會將一個區塊合併到 `~/.minimax/config.yaml`：

```yaml
custom_provider:
  opencodex:
    name: OpenCodex
    kind: custom
    enabled: true
    api: anthropic-messages
    options:
      apiKey: opencodex-loopback
      baseURL: http://127.0.0.1:10100
      authMode: api-key
    models:
      anthropic/claude-opus-5:
        limit:
          context: 1000000
```

實際產生的模型清單，以及已知的 context window 與 reasoning effort 階梯，來自正在執行的 OpenCodex 目錄。若模型沒有權威的 context window 或 effort 階梯，該欄位就會省略，不會填入猜測值。MCode 會在工作階段中保留目前選擇的 effort，因此 OpenCodex 匯出 `effortOptions` 時不會覆寫該選擇。這個區塊不會寫入真實金鑰、不會取代 `defaultModel`，也不會改變 MiniMax 登入。在 MCode 中，請選取 `custom_provider:opencodex/...` 下的模型。

`ocx mcode` 會先驗證此供應商指向目前執行中的代理，再啟動用戶端。初次啟用後，當連接埠或目錄能力變更時，`ocx sync` 會更新受管理的區塊。自動同步不會建立無主區塊、不會重建你已移除的區塊，也不會覆寫 OpenCodex 寫入後又被修改的檔案；若要刻意重新連接，請使用啟用指令。停用或復原則透過同一套可稽核的整合系統：

```bash
ocx integration client disable --client mcode
ocx integration client history --client mcode
ocx integration client restore --op <opId> [--confirm-drift]
```

`MINIMAX_DATA_DIR` 與舊版 `MAVIS_DATA_DIR` 都受支援。相對路徑覆寫會被拒絕，因為 OpenCodex 與 MCode 可能從不同的工作目錄啟動。

## MiniMax CLI（`mmx`）

另外安裝官方 CLI：

```bash
npm install -g mmx-cli
mmx --version
```

透過包裝器與 OpenCodex 模型 id 路由文字指令：

```bash
ocx mmx text chat \
  --model anthropic/claude-opus-5 \
  --message "Explain this function"

ocx mmx --output json text chat \
  --model openai/gpt-5.6-sol \
  --message "Return a JSON summary"
```

MMX 在其 API base URL 下固定使用 `/anthropic/v1/messages`。包裝器會在子程序存續期間啟動暫時性的 loopback 橋接器。它只接受送往該 Messages 路徑及 `/anthropic/v1/messages/count_tokens` 的 POST 請求，將其對應至 OpenCodex 現有的 `/v1/messages` 與 `/v1/messages/count_tokens` 資料平面，並保留請求主體及查詢資料。OpenCodex 標準的請求轉譯、用量計算及已設定的下游供應商驗證仍然生效；供應商會依其設定收到 `x-api-key` 或 bearer 傳輸。串流會保留 Anthropic 訊息與內容事件。轉送前，橋接器會移除傳入的准入憑證標頭，並固定使用公開的 `opencodex-loopback` 佔位值。其他 Anthropic 資源不會經過代理，橋接器也不會暴露到 loopback 以外。

包裝器還會建立只含該佔位值的暫時 `MMX_CONFIG_DIR`，並在 `mmx` 結束後刪除。你的 `~/.mmx/config.json`、OAuth token 與 MiniMax API key 都不會被載入或複製。

以下限制是刻意設計的：

- 只有 `text chat` 與 `text repl` 會透過 OpenCodex 路由。
- 包裝器會拒絕 `--api-key`、`--base-url` 與 `--region`，避免呼叫端憑證或目的地選擇與隔離橋接器衝突。
- 橋接器僅限 loopback，因為 MMX 無法為遠端繫結送出 OpenCodex 專用的 `x-opencodex-api-key` 准入標頭。
- 若要使用 `image`、`video`、`speech`、`music`、`vision`、`search`、`quota`、`auth`、`config`、`file` 與 `update`，請直接執行 `mmx`；這些操作呼叫 OpenCodex 不會模擬的 MiniMax 專屬 API。

`mmx` 的文字模型預設為 `MiniMax-M3`。若要指定 OpenCodex 路由，請傳入 `--model <provider/model>`；否則由一般 OpenCodex 模型路由規則決定預設 id 是否可用。
