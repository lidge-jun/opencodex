---
title: Codex 整合
description: opencodex 如何將自身注入 Codex、同步模型目錄、驅動 subagent 選擇器，並乾淨地恢復。
---

opencodex 透過編輯 Codex 讀取的兩樣東西，讓 Codex 經由 proxy 路由：它的設定（`$CODEX_HOME/config.toml`，預設 `~/.codex/config.toml`）和它的模型目錄。每一次編輯都是冪等且可逆的。

OpenAI 提供一條 bare `openai` Codex 登入路徑和 `openai-apikey/<model>` API 路徑。
`openai` 可選 Pool（預設，主帳號加新增帳號）或 Direct（目前 caller/主登入 bearer），模型 id
保持不變。路徑之間不會 fallback。shipped v1 設定遷移到 marker 2，並保留
`config.json.pre-openai-tiers-v2.bak` 供手動恢復。

## 設定注入

`ocx init`、`ocx start` 和 `ocx sync` 都會呼叫注入器。在預設的 loopback 繫結下，它會保留 Codex
內建的 `openai` 供應商 id，並將該供應商指向 opencodex：

```toml
# 位於第一個 table 之前的根級鍵
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"
# Auto-injected by opencodex
openai_base_url = "http://127.0.0.1:10100/v1"

[features]
fast_mode = true
```

proxy 的預設埠為 `10100`，提供 `POST /v1/responses`、`POST /v1/responses/compact`、
`POST /v1/images/generations`、`POST /v1/images/edits`、`GET /v1/models`、`GET /healthz`
以及 `/api/*` 管理 API。

### 內建圖像生成（`image_gen`）

Codex 的內建 `image_gen` 工具不經過 `/v1/responses`——codex-rs 擴充套件直接 POST
`{base_url}/images/generations`（附帶參考圖像時為 `/images/edits`），使用與聊天相同的
ChatGPT bearer 認證。由於注入的 `base_url` 指向 opencodex，proxy 會把這些呼叫中繼到
OpenAI 上游：

- **單一、感知模式的 forward 候選：** Pool 選擇合格的主帳號或新增帳號；Direct 使用 caller
  OAuth bearer。圖像請求遵循同一模式。
- **OpenAI API key：** 僅當 forward 候選沒有擁有認證失敗時使用。不會用單獨計費的 API 呼叫掩蓋
  損壞或過期的 Pool 憑證。
- **兩者都沒有：** proxy 返回明確的錯誤而不是含糊的 404。其他路由供應商（Cursor、Gemini、
  Kiro 等）無法提供圖像生成；如果想完全關閉該工具，可在 Codex 中執行
  `codex features disable image_generation`（即 `config.toml` 的
  `[features] image_generation = false`）。

如果 `hostname` 不是 loopback 地址，Codex 必須傳送自動生成的 API 認證請求頭。此時注入器會改用
專用供應商：

```toml
# 根級鍵
model_provider = "opencodex"
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"

# 追加到檔案末尾
# Auto-injected by opencodex
[model_providers.opencodex]
name = "OpenCodex Proxy"
base_url = "http://your-host:10100/v1"
wire_api = "responses"
requires_openai_auth = true
env_http_headers = { "x-opencodex-api-key" = "OPENCODEX_API_AUTH_TOKEN" }
# supports_websockets = true   # 僅當 config.websockets 為 true
```

當 OpenCodex 管理路由時，兩種模式都會把 `$CODEX_HOME/opencodex.config.toml` 寫成參考/回退設定。
loopback 模式下，其中包含自動注入被移除時可手動合併的根級鍵；non-loopback 模式下，其中包含
專用供應商設定。外部供應商模式不會修改此設定檔。

:::caution
`openai_base_url`、`model_provider`、`model_catalog_json` 等根級鍵**必須**位於第一個 `[table]`
頭之前。注入器會保證這一位置，並清理自己留下的舊值和重複項。使用者自己設定的根級
`openai_base_url` 不會被覆蓋；如果檢測到該值，同步仍會更新模型目錄，但會明確提示路由沒有注入。
:::

## 共享模型目錄

Codex CLI、TUI、App 和 SDK 都讀取同一個 Codex home。opencodex 會從 `CODEX_HOME` 解析該目錄，
未設定時回退到 `~/.codex`，並管理以下檔案：

```text
$CODEX_HOME/config.toml
$CODEX_HOME/opencodex.config.toml
$CODEX_HOME/opencodex-catalog.json
$CODEX_HOME/models_cache.json
```

在 WSL 中，如果未設定 `CODEX_HOME`，且 Linux 側 `~/.codex/config.toml` 不存在，opencodex 還會檢查
`/mnt/c/Users/*/.codex/config.toml` 下的 Windows Codex Desktop home。只有候選項恰好為一個時才會
使用該目錄，讓 WSL app-server mode 和 Windows Codex Desktop 共享同一份 config 與 auth 檔案。要覆蓋
此檢測，請顯式設定 `CODEX_HOME`。

在 Windows 上，Orca shell 可能同時把 `CODEX_HOME` 和 `ORCA_CODEX_HOME` 指向 Orca 的內建
runtime home，而 ChatGPT/Codex App 仍讀取 `%USERPROFILE%\\.codex`。`ocx status` 與
`ocx doctor` 會檢測這一明確的不一致，並以隱藏使用者名稱的形式顯示目標 home。如果後臺服務是在原 Orca
shell 中安裝的，請先在原 shell 中解除安裝服務，再把 `CODEX_HOME` 設為 App home、取消
`ORCA_CODEX_HOME`，重新同步/恢復並安裝服務。

在專用供應商模式下，`requires_openai_auth = true` 會讓 Codex App/TUI 的帳號門控介面與原生
Codex 保持一致。opencodex 也提供 `/v1/responses` WebSocket。專用供應商僅在
`"websockets": true` 時宣告 `supports_websockets = true`；loopback 模式下，Codex 的內建供應商
可能會先嚐試 WebSocket，如果功能未啟用，proxy 會返回 `426`，使 Codex 回退到 HTTP/SSE。

## 執行緒標識與歷史記錄

預設 loopback 方式會讓新執行緒繼續使用 Codex 原生的 `openai` 供應商標識，因此普通的恢復歷史無需
重對映。第一次同步時，它還會把舊版 opencodex 改過標識的執行緒遷回 `openai`。non-loopback 的專用
供應商模式會在運行時間把歷史記錄對映到 `opencodex`，退出時再恢復已備份的後設資料。若希望完全不修改
歷史記錄，請設定 `syncResumeHistory: false`。

## 模型目錄同步

Codex 顯示的模型來自一個磁碟上的目錄（預設為 `$CODEX_HOME/opencodex-catalog.json`）。在啟動時以及執行 `ocx sync` 時，opencodex 會：

1. **備份**一次原始目錄到 `~/.opencodex/catalog-backup.json`（以便置頂操作可逆）。
2. **獲取**符合條件的供應商即時模型目錄（快取約 5 分鐘；失敗時先回退到上一份正常列表，再回退到
   已設定的 `models[]`）。`forward` 認證沒有模型端點；Cursor 使用 `GetUsableModels` RPC，而不是
   `/models`。
3. **合併**路由模型，作為帶名稱空間的條目（`provider/model`），從原生 Codex 目錄模板克隆而來，以便 Codex 嚴格的解析器接受它們。
4. **應用過濾**：`config.disabledModels`，以及每個供應商非空的 `selectedModels` allowlist。
5. **重新排序**，使置頂模型排在最前（見下文），然後將合併後的目錄寫回。

路由目錄條目還會把 GPT-5 身份文案改為真實的上游模型名稱。reasoning 選項會依據供應商和模型後設資料，
使用 Codex 的 `low | medium | high | xhigh | max | ultra` 檔位；上游不支援的值會在傳送請求前完成
對映或下調。

### 自訂模型顯示名稱

自訂模型可以帶一個可讀的**顯示名稱**，只覆寫 Codex 模型選擇器中顯示的標籤，不改變任何路由行為。
顯示名稱只對應目錄條目的 `display_name` 欄位——路由 slug（`<provider>/<model>`）、別名碰撞順序、
供應商，以及原生 OpenAI 行銷名稱都維持不動。

可從 CLI 新增顯示名稱（proxy 在線時會立刻同步目錄）：

```bash
ocx models add deepseek deepseek-v4 --display-name "DeepSeek V4" --context-window 128000
```

也可以透過管理 API（`POST /api/custom-models`、`PUT /api/custom-models/<id>`，搭配 `displayName`
字串）與 web 儀表板設定或編輯。`/` 會被拒絕，因為會與路由 slug 的分隔符衝突。

顯示名稱**只用於顯示，且在重新產生時保持穩定**。每次 `ocx sync` 與目錄重新整理都會從
`config.json`（含 `customModels`）重新推導路由條目，因此會重新套用已設定的名稱，而不會漂移回
路由 slug。受管服務重啟後，也會在 proxy 繫結後盡力同步一次。若這次啟動時的 best-effort 同步失敗
（例如離線登入），會保留先前已寫入的目錄，並在下一次成功的 `ocx sync` 重新套用設定名稱。真正的
上游原生名稱（例如 `gpt-5.6-sol` →「GPT-5.6-Sol」）來自固定的上游快照，絕不會被自訂顯示名稱覆寫。

### 外部供應商管理器

若 `config.toml` 已選用非 `openai` 或 `opencodex` 的供應商，OpenCodex 會保持檔案不變，並跳過
profile 寫入、目錄／快取重新整理，以及立即與背景的 Codex 歷史遷移。管理自訂供應商的工具常會把既有
session 標上該供應商 id；若直接替換作用中的 id，可能讓這些完好 session 從 Codex 的歷史檢視中消失。
由舊版根級 profile 選到的外部供應商也適用同一保護。

請讓單一工具負責 Codex 供應商設定的所有權。若要在既有供應商管理器後方使用 OpenCodex，請把該供應商
指向 `http://127.0.0.1:10100/v1`，並使用 Responses 直通（Codex TOML 中 `wire_api = "responses"`），
而不是 Chat Completions 轉譯。啟用 proxy API 認證時，還需從 `OPENCODEX_API_AUTH_TOKEN` 傳入
`x-opencodex-api-key`，形式與上方 non-loopback 供應商設定一致。若要讓 OpenCodex 直接注入路由，請先把
Codex 切回內建 `openai` 供應商，並移除任何使用者自有的根級 `openai_base_url`，再重新執行
`ocx start`。

### 目錄疑難排解

若模型在 Codex 中缺失，或目錄順序／可見性看起來不對，請依序檢查：

1. **供應商上的 `selectedModels`** —— 非空 allowlist 只會把列出的 id 暴露給 Codex；空或省略則暴露所有
   已發現模型。不在 allowlist 中的 id 永遠不會進入目錄。
2. **`disabledModels`（頂層）** —— 會同時從目錄與 `/v1/models` 隱藏模型，並把裸原生 GPT slug 的
   `visibility` 設為 `"hide"`。
3. **`liveModels: false` 且 `models` 為空** —— 當即時探索關閉，且 `models` 為空或省略時，opencodex
   不會為該供應商暴露任何路由模型。
4. **Cursor `GetUsableModels`** —— Cursor adapter 透過 protobuf `GetUsableModels` RPC 探索模型，而不是
   `/models`，因此 Cursor 端的變更可能獨立於其他供應商改變可見 id。
5. **快取與 `ocx sync`** —— 即時目錄約快取五分鐘（`modelCacheTtlMs`，預設 `300000`）。執行
   `ocx sync` 可強制重新抓取並立刻重寫目錄。

:::caution[其他本機寫入者]
目錄寫入（`opencodex-catalog.json`、`config.toml`）在 opencodex **內部**是原子的，這只避免兩個
opencodex 擁有的寫入者競爭時出現半寫入檔案。它**不會**阻止其他本機行程、檔案監看器或同步代理在
opencodex 寫入後改寫目錄可見性或順序。Codex 另有獨立的 `models_cache.json`，可自行重新整理，
因而可能在不改寫 `opencodex-catalog.json` 的情況下改變可見列表。若 proxy 執行中模型卻意外跳動，
請先停止或重新設定競爭的寫入者，再執行 `ocx sync`——這是外部寫入者風險，不是已確認的 opencodex
缺陷。
:::

## 代理連線錯誤

如果 Codex 重試後報出類似
`stream disconnected before completion: error sending request for url (http://127.0.0.1:10100/v1/responses)`
的錯誤（或 Claude Code 出現類似的連線失敗），說明 opencodex 代理沒有在執行：
設定埠上沒有任何監聽，用戶端只能顯示原始的連線錯誤。請重啟代理：

```bash
ocx start              # 前臺執行
ocx service install    # 常駐：登入時自動啟動，崩潰後自動重啟
```

`ocx status` 可檢視代理是否在執行，未執行環境也會給出同樣的重啟提示；
`ocx doctor` 會報告重啟安全性（service/shim 覆蓋情況）。

## subagent 選擇器

Codex 的 `spawn_agent` 會按優先順序排序，然後展示**前 5 個在選擇器中可見的目錄模型**。
`subagentModels` 最多接受五個 id，可以同時使用裸原生 GPT slug 和帶名稱空間的 `provider/model`
路由；所選模型會按順序獲得 0–4 的優先順序。

```json
{
  "subagentModels": [
    "gpt-5.5",
    "gpt-5.6-sol",
    "anthropic/claude-opus-5",
    "xai/grok-4.5",
    "cursor/gpt-5.6-terra"
  ]
}
```

優先順序排序：置頂（0–4）< 其他路由（5）< 原生（9）。你也可以從 [web 儀表板](/zh-tw/guides/web-dashboard/) 管理這一項。

## Codex 帳號預熱

向 Codex 帳號池新增 ChatGPT 帳號時，opencodex 會在儲存前向 Codex Responses 後端傳送一個小型
streaming 請求來驗證憑證。輸入使用真正的 Responses item 陣列
（`input: [{ type: "message", ... }]`），並等待 `response.completed`。預設模型為
`gpt-5.4-mini`；若該模型返回 HTTP 400，則改用 `gpt-5.5` 重試。結構化的上游錯誤詳情會顯示給使用者，
但不會洩露原始回應正文。後臺重新驗證是獨立功能，預設關閉；只有啟用 Token Guardian、將 `chatgpt`
重新整理策略設為 `proactive`，並把 `tokenGuardian.codexWarmupEnabled` 設為 true 時才會執行。

## 恢復原生 Codex

opencodex 絕不會把你困住。**`ocx stop` 是完全恢復原生 Codex 的單一命令** ——
它會停止 proxy、停止後臺服務（如已安裝），並剝除所有注入的行和路由的目錄條目，使普通的 `codex`
完全像 opencodex 從未存在過一樣工作：

```bash
ocx stop       # 停止 proxy + 服務，恢復原生 Codex
ocx restore    # 不停止 proxy 僅恢復  (別名: ocx eject)
ocx restore back # 讓普通 Codex 重新指向仍在執行的 proxy
```

當 opencodex 作為受管的 [後臺服務](/zh-tw/reference/cli/#ocx-service) 執行環境，它會設定 `OCX_SERVICE=1`，這樣由服務驅動的重啟**不會**反覆改寫 Codex 設定——只有顯式的 `ocx stop` / `ocx service stop` 才會恢復原生 Codex。
