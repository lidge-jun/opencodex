---
title: Pi
description: 使用 Pi 的任何路由模型 — ocx export 會為 Pi 的 models.json 寫入自訂供應商區塊，連接到執行中的代理。
---

Pi 從單一全域 JSON 檔案讀取供應商。opencodex 不會啟動 Pi；`ocx export` 輸出 `opencodex` 供應商區塊，包含基底 URL、模型清單及非機密的本機金鑰預留位置。請將此區塊合併到現有設定。

## 快速入門

啟動代理，然後印出設定：

```bash
ocx start
```

讓此程序繼續執行。在另一個終端機中輸出設定：

```bash
ocx export --client pi
```

JSON 之後會顯示目的地路徑、合併警告、回環使用提示，以及具有已確認內容視窗限制的模型數量。此匯出僅支援不需驗證的回環代理，不會設定遠端存取驗證。

```json
{
  "providers": {
    "opencodex": {
      "baseUrl": "http://127.0.0.1:10100/v1",
      "api": "openai-completions",
      "apiKey": "opencodex-loopback",
      "compat": {
        "sendSessionAffinityHeaders": true,
        "supportsDeveloperRole": false
      },
      "models": [
        {
          "id": "anthropic/claude-opus-5",
          "name": "Claude Opus 5 (anthropic)",
          "input": ["text"],
          "contextWindow": 200000,
          "maxTokens": 128000
        }
      ]
    }
  }
}
```

產生的 Pi 供應商設定會啟用 `compat.sendSessionAffinityHeaders`。合併或手動編輯供應商時請保留此設定：Pi 提供穩定的工作階段識別碼，OpenCodex 據此為標準 OpenCode Go 目標產生工作階段親和識別碼。當 `cacheRetention` 為 `none` 時，Pi 可能不傳送識別碼。

產生的 Pi 供應商設定也會把 `compat.supportsDeveloperRole` 設為 `false`，讓 Pi 以 `system` 而非 `developer` 角色傳送系統提示詞。OpenCodex 會照原樣轉送 Chat Completions 角色，而部分 OpenAI 相容上游會以 400 拒絕 `developer`；所有上游都接受 `system`。

模型 id 是代理的規範選擇器，因此路由模型顯示為 `provider/model`（`anthropic/claude-opus-5`），而原生 OpenAI slug 保持無前綴（`gpt-5.6-sol`）。`name` 後綴 — `(anthropic)`、`(native)`、`(routed)` — 正是讓來自不同上游的兩個同名模型在 Pi 的 picker 中可區分的關鍵。

## 放置位置

Pi 的全域模型設定為：

```text
~/.pi/agent/models.json
```

:::caution[合併，絕不替換]
`ocx export` 永不寫入該檔案。將 `providers.opencodex` 區塊合併進去 — 替換該檔案會毀掉你在那裡設定的所有其他供應商。`--out` 用於暫存路徑，且在沒有 `--force` 時拒絕覆寫既有檔案：

```bash
ocx export --client pi --out ~/opencodex-pi-models.json
ocx export --client pi --json > ~/opencodex-pi-models.json   # 或重導逐字元的 JSON
```

:::

匯出的區塊是靜態快照，非即時檢視。在新增供應商或改變模型可見性後，重新執行 `ocx export`，並將新區塊合併到舊區塊上。

## 認證金鑰

匯出的 `apiKey` 是非機密預留值 `opencodex-loopback`，不需要匯出金鑰環境變數。匯出器只允許不需驗證的回環代理，會拒絕遠端代理或受權杖保護的代理。供應商憑證保留在 opencodex 設定中，請參閱[供應商](/zh-tw/guides/providers/)；不要把上游供應商金鑰放入此 Pi 區塊。遠端存取應使用支援代理存取憑證的整合。修改預留值不會啟用 Pi 遠端匯出。

## 模型後設資料

`contextWindow` 與 `maxTokens` 僅在目錄回報權威上下文窗口時發出。若未回報，該模型的兩個欄位都會省略，Pi 會套用自身預設值；`ocx export` 會印出有多少列屬於該情況。

輸出上限使用目錄或產生的中繼資料中已知的模型上限，僅在未知時回退到 `32000`。輸出上限始終不超過 context window；已知低於 `32000` 的上限也會保留。

有兩個欄位刻意省略。`cost` 需要全部四個價格欄位，而 opencodex 對路由模型沒有價格資料 — 發出零值會斷言每個模型都是免費的。`reasoning` 在 Pi 中是 boolean，而目錄帶有 effort 階梯，將兩者互相映射會是猜測。

## Schema 狀態

:::note[未對真實安裝驗證]
上述形狀遵循 Pi 公開的自訂供應商文件。它**尚未**在裝有 Pi 的機器上對真實的 `~/.pi/agent/models.json` 驗證。若 Pi 拒絕匯出的區塊，不符出在我們這邊 — 請
[開一個 issue](https://github.com/lidge-jun/opencodex/issues) 並附上 Pi 回報的內容。
:::

## 需求

一個執行中的 opencodex 代理（`ocx start`）與已安裝的 Pi。`ocx export` 透過代理的管理 API 讀取即時目錄，因此設定永遠不會以空模型清單發出。
