---
title: Codex 整合
description: opencodex 如何將自身注入 Codex、同步模型目錄、安裝 shim，並乾淨地恢復。
---

opencodex 透過修改 Codex 會讀取的兩項內容，讓 Codex 經由 proxy 路由：其設定
（`$CODEX_HOME/config.toml`，預設為 `~/.codex/config.toml`）與模型目錄。每項修改都是冪等且可逆的。

proxy 提供一條裸 `openai` Codex 登入路徑，可使用 Pool（預設）與 Direct 帳號模式，另提供
`openai-apikey/<model>` 給已設定的 API 金鑰。Pool 包含主帳號與新增帳號；Direct 只使用 caller／主登入
bearer。這些路徑不會彼此 fallback。shipped v1 設定會遷移到 marker 2，並保留
`config.json.pre-openai-tiers-v2.bak` 供手動恢復。

## 設定注入

`ocx init`、`ocx start` 與 `ocx sync` 都會呼叫注入器。在預設 loopback 繫結下，它會保留 Codex
內建的 `openai` provider id，並將該 provider 指向 opencodex：

```toml
# 根級鍵，必須位於第一個 table 之前
model_catalog_json = "/absolute/path/to/opencodex-catalog.json"
# Auto-injected by opencodex
openai_base_url = "http://127.0.0.1:10100/v1"

# 僅在設定 fastMode 時寫入；未設定時不新增 [features] table
[features]
fast_mode = true
```

注入的 `fast_mode` 會遵循 `fastMode` 三態設定：`true` 寫入 `fast_mode = true`，`false` 寫入
`fast_mode = false`；未設定時會保留既有 `fast_mode`，且不新增 `[features]` table。

proxy 預設監聽 `10100` 埠，提供 `POST /v1/responses`、`POST /v1/responses/compact`、
`POST /v1/images/generations`、`POST /v1/images/edits`、`GET /v1/models`、`GET /healthz`
以及 `/api/*` 管理介面。

### 內建圖像生成（`image_gen`）

Codex 的內建 `image_gen` 工具不會經過 `/v1/responses`。codex-rs 擴充套件會直接 POST 到
`{base_url}/images/generations`；附帶參考圖時則使用 `/images/edits`，並沿用聊天使用的 ChatGPT bearer
認證。由於注入的 `base_url` 指向 opencodex，proxy 會把這些呼叫中繼到 OpenAI 上游。

這與 [Image Bridge](/zh-tw/guides/image-bridge/) 是不同路徑。Image Bridge 只有在 **Responses** turn
列出 hosted `image_generation` 工具、且目前選的是非 OpenAI 模型時才會啟動。獨立的
`/images/generations` 呼叫不會進入該 bridge。

- **單一、感知模式的 forward 候選：** Pool 會選擇合格的主帳號或新增帳號；Direct 使用 caller OAuth
  bearer。圖像請求會一致遵循目前設定的模式。
- **OpenAI API-key provider：** 只有在沒有 forward 候選擁有認證失敗時才會使用。損壞或過期的 Pool
  憑證不會被另一條額外計費的 API 路徑掩蓋。
- **明確指定的自訂 provider：** 將 `images.provider` 設為某個自訂 API-key `openai-responses`
  provider id，而且其端點必須實作 OpenAI Images API。明確選擇時採 fail-closed，不會 fallback 到其他
  付費上游。此處不接受 registry 管理的 provider id；若要使用內建 OpenAI tiers，請省略
  `images.provider`。
- **Google Antigravity（CCA）fallback：** 若既沒有 OpenAI forward 候選，也沒有設定 keyed provider，
  `/v1/images/generations`（不包含 `/images/edits`）會 fallback 到 Antigravity **Cloud Code Assist**
  端點，使用 `gemini-3.1-flash-image` 模型。OpenAI 認證解析失敗後也會觸發此 fallback，例如 ChatGPT
  憑證過期或缺失，而不限於完全沒有設定 OpenAI 候選的情況。這需要先執行
  `ocx login google-antigravity`；OAuth token 只會傳送到固定的 CCA registry host，絕不會傳到設定層級
  的 `baseUrl` override。回應會轉成 Codex 預期的 `{created, data:[{b64_json}]}` 形狀。
- **都沒有：** proxy 會回傳明確錯誤，而不是模糊的 404。路由 provider（Cursor、Gemini、Kiro 等）
  無法提供 `image_generation` 工具 relay；若完全不想提供此工具，可在 Codex 執行
  `codex features disable image_generation`，等同於在 `config.toml` 設定
  `[features] image_generation = false`。

工具宣告仍會跟著模型的 Responses 請求傳送。對 API-key Responses provider，opencodex 會把 Codex
私有的 `image_gen` namespace 降為上游安全的 `image_gen__<inner-name>` alias，例如
`image_gen__imagegen`。當可用 alias 取代 client 宣告時，opencodex 會移除重複的 hosted
`image_generation` 宣告；在 Codex 看見 function call 前，再將其對映回明確的 `image_gen` namespace，
之後歷史重播到上游時則重新編碼成原生呼叫。這讓保留 namespace 或拒絕 dotted function name 的公開相容
上游仍能呼叫 client-side 圖像生成。ChatGPT forward 模式保持不變，繼續使用原生 Responses Lite
形狀。

若要使用 OpenAI 相容的自訂 gateway，可設定專用 provider，並只讓獨立 Images 請求使用它：

```json
{
  "providers": {
    "custom-images": {
      "adapter": "openai-responses",
      "baseUrl": "https://gateway.example.com/v1",
      "authMode": "key",
      "apiKey": "${IMAGE_GATEWAY_API_KEY}"
    }
  },
  "images": {
    "provider": "custom-images",
    "timeoutMs": 300000
  }
}
```

自訂端點必須接受 `POST /v1/images/generations` 與 `/v1/images/edits`，並回傳 Codex 預期的 OpenAI
Images response 形狀。上游請求會使用該 provider 設定的 key 取代任何 caller bearer。

> **注意：** 這裡只指 Codex 的 `image_generation` 工具（`/images/generations` relay）。支援圖像的
> Gemini 模型會透過 `google` adapter 原生產生 inline image（使用
> `responseModalities: ["TEXT", "IMAGE"]`），與此 relay 無關。參見
> [轉接器](/zh-tw/reference/adapters/#google)。

若 `hostname` 不是 loopback 地址，Codex 必須傳送產生的 API 認證標頭，因此注入器會改用專用
provider：

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
env_key = "OPENCODEX_API_AUTH_TOKEN"
# supports_websockets = true   # 僅當 config.websockets 為 true
```

當 OpenCodex 擁有路由時，兩種模式都會把 `$CODEX_HOME/opencodex.config.toml` 寫成參考／fallback
設定。loopback 模式下，其中包含自動注入被移除時可手動合併的根級鍵；non-loopback 模式下，其中包含
專用 provider 形式。外部 provider 模式不會修改此 profile。

:::caution
`openai_base_url`、`model_provider`、`model_catalog_json` 等根級鍵**必須**位於第一個 `[table]`
標頭之前。注入器會保證此位置、移除自己留下的舊值或重複項，而且絕不覆寫使用者自有的根級
`openai_base_url`；若該值存在，同步仍會更新模型目錄，但會回報路由未注入。
:::

## 共享模型目錄

Codex CLI、TUI、App 與 SDK 都讀取同一個 Codex home。opencodex 會從 `CODEX_HOME` 解析該目錄，
未設定時 fallback 到 `~/.codex`，並管理：

```text
$CODEX_HOME/config.toml
$CODEX_HOME/opencodex.config.toml
$CODEX_HOME/opencodex-catalog.json
$CODEX_HOME/models_cache.json
```

在 WSL 中，如果未設定 `CODEX_HOME`，且 Linux 的 `~/.codex/config.toml` 不存在，opencodex 也會檢查
`/mnt/c/Users/*/.codex/config.toml` 下是否只有一個 Windows Codex Desktop home。候選項恰好只有一個時，
會使用該目錄，讓 WSL app-server mode 與 Windows Codex Desktop 共用相同的 config 與 auth 檔案。
若要覆蓋此偵測，請明確設定 `CODEX_HOME`。

Codex 可將 SQLite 支援的 thread state 放在另一個目錄。OpenCodex 的歷史操作採用與 Codex 相同的
優先順序：先讀 `config.toml` 根級的 `sqlite_home`，再讀 `CODEX_SQLITE_HOME`，最後使用實際的
`CODEX_HOME`。相對 SQLite home 會從目前工作目錄解析。若安裝或修復服務時明確設定了
`CODEX_SQLITE_HOME`，持久化 launcher 會保存安裝當下解析出的絕對路徑，讓背景 proxy 持續操作同一個
資料庫。若 `config.toml` 或其根級 `sqlite_home` 不存在，OpenCodex 會繼續使用環境變數／home fallback。
若檔案無法讀取或解析，或該鍵存在但為空白或非字串，SQLite-home 解析會停止，以免歷史操作誤用另一個
資料庫。

在 Windows 上，Orca shell 可能同時把 `CODEX_HOME` 與 `ORCA_CODEX_HOME` 指向 Orca 內建的 runtime
home，而 ChatGPT/Codex App 仍讀取 `%USERPROFILE%\\.codex`。`ocx status` 與 `ocx doctor` 會警告這個
明確的不一致，並輸出經過遮蔽的目標路徑。若背景服務是在原 Orca shell 中安裝，請先在原 shell 中解除
安裝，再將 `CODEX_HOME` 設為 App home、取消 `ORCA_CODEX_HOME`，重新同步／恢復後再安裝服務。

在專用 provider 模式下，`requires_openai_auth = true` 會讓 Codex App/TUI 的帳號門控介面與原生
Codex 保持一致。opencodex 也透過 WebSocket 提供 `/v1/responses`。專用 provider 只會在
`"websockets": true` 時宣告 `supports_websockets = true`；loopback 模式下，Codex 的內建 provider
可能先嘗試 WebSocket，若 proxy 未啟用此功能則回傳 `426`，讓 Codex fallback 到 HTTP/SSE。

## Thread identity 與歷史記錄

預設 loopback 形式會讓新 thread 保持使用 Codex 原生的 `openai` provider 標記，因此一般 resume
history 不需要重新對映。sync 與 restore 只套用和目前狀態資料庫相符的備份 manifest，並精確恢復每個
thread 原本的 provider、source 與 event marker。沒有 manifest 的 `opencodex` row 會保持不變；只有在明確
要強制執行舊式重新標記時才使用 `ocx recover-history --legacy-openai --yes`。此命令的作用範圍刻意很廣：它會把所有
含有使用者訊息且目前標記為 `opencodex` 的 thread 改標為 `openai`，將 `exec` 正規化為 `cli`，並設定 event
marker；正常的專用 provider 歷史也包含在內。請先備份狀態，而且只有在確實需要這個完整範圍時才使用。non-loopback 專用 provider 模式在
啟用期間仍會把歷史映射到 `opencodex` provider，退出時再恢復已備份的 metadata。設定
`syncResumeHistory: false` 可完全不修改歷史。

## 模型目錄同步

Codex 從磁碟上的目錄顯示模型，預設為 `$CODEX_HOME/opencodex-catalog.json`。啟動時與執行
`ocx sync` 時，opencodex 會：

1. **備份**一次原始目錄到 `~/.opencodex/catalog-backup.json`，讓置頂操作可逆。
2. **取得**符合條件的 provider 即時模型目錄，快取約 5 分鐘；失敗時先 fallback 到上一份正常列表，
   再 fallback 到已設定的 `models[]`。`forward` 認證沒有模型端點；Cursor 使用
   `GetUsableModels` RPC，而不是 `/models`。
3. **合併**路由模型為帶 namespace 的條目（`provider/model`），從原生 Codex 目錄 template 複製，
   讓 Codex 嚴格的 parser 能接受它們。
4. **過濾** `config.disabledModels` 與各 provider 非空的 `selectedModels` allowlist。
5. **重新排序**，讓置頂模型排在前面，然後把合併後的目錄寫回。

路由目錄條目也會把 GPT-5 identity 改寫成真正的上游模型名稱。reasoning 控制來自 provider／model
metadata，使用 Codex 的 `low | medium | high | xhigh | max | ultra` 檔位；不支援的值會在送往上游前
完成對映或下調。

### 路由的本機工具

非原生路由目錄列使用 `tool_mode: "code_mode_only"`。這讓 Codex 能暴露官方 `exec` 入口點與巢狀 MCP
工具，包括 Browser 與 Computer Use，同時 opencodex 只路由模型的一般 function call。工具執行、權限
與確認仍留在 Codex 本機；opencodex 不會實作第二套瀏覽器或桌面控制 executor。

對不接受 Codex `exec` custom-tool grammar 的 key-auth Responses provider，opencodex 會把該宣告與其
歷史編碼成上游 function tool，再於 Codex 看見前將串流 function-call lifecycle 還原成
`custom_tool_call`。原生 OpenAI forward 路由與受支援的 `apply_patch` custom tool 維持不變。

路由的 code-mode 回合也會在首次呼叫前收到主機對巢狀輔助工具的規則：`tools.apply_patch`
接收一個字串，開頭與結尾必須是沒有額外包裝的獨立補丁標記行；isolate 中沒有 `import`，長時間執行的
命令透過 `write_stdin` 輪詢。如果原生路由 Responses、Kiro 或 Cursor 路徑上的 code-mode exec
結果仍包含主機的某則失敗訊息，opencodex 會附加一行提示，指出對應規則。這項變更不會重寫模型的
程式碼或補丁文字。

所選 provider 必須支援 function/tool calling。不支援 tool call 的純文字 provider 無法使用 `exec`、
Browser 或 Computer Use。原生 OpenAI 列保留上游 tool mode 不變。

`ocx sync` 變更這份 metadata 後，請重新啟動 Codex App 並開啟新任務。既有 app-server process 與任務
可能仍保留啟動時載入的目錄與 tool plan。

### 自訂模型顯示名稱

自訂模型可以帶一個可讀的**顯示名稱**，只覆寫 Codex 模型選擇器顯示的標籤，不改變任何路由行為。
顯示名稱只對應目錄條目的 `display_name` 欄位；路由 slug（`<provider>/<model>`）、alias collision 順序、
provider 與原生 OpenAI 行銷名稱都維持不動。

可從 CLI 新增顯示名稱；proxy 在線時會立即同步目錄：

```bash
ocx models add deepseek deepseek-v4 --display-name "DeepSeek V4" --context-window 128000
```

遠端 Codex client 可以使用一般的資料平面金鑰取得相同的產生目錄——與 `/v1/responses` 所用的憑證相同，而非管理或管理員權杖：

```bash
dest="${CODEX_HOME:-$HOME/.codex}/opencodex-catalog.json"
tmp="$(mktemp "${dest}.XXXXXX")"
curl -fsS -H "x-opencodex-api-key: $OPENCODEX_API_AUTH_TOKEN" \
  "https://proxy.example.com/v1/catalog" > "$tmp" \
  && mv "$tmp" "$dest"
ocx sync-cache
```

回應是原始的 `opencodex-catalog.json` 文件，不包含 provider 憑證。若可用，
`x-opencodex-codex-version` 標頭會回報伺服器上的 Codex runtime 版本，讓 client 能辨識版本差異。

也可以透過管理 API（`POST /api/custom-models`、`PUT /api/custom-models/<id>`，搭配 `displayName`
字串）與 web 儀表板設定或編輯。`/` 會被拒絕，因為它會與路由 slug 的分隔符衝突。

`GET /v1/catalog` 的存在是為了讓讀取模型清單不再需要管理員權杖。該路由為唯讀（`GET` 與 `HEAD`），接受 `x-opencodex-api-key`、bearer 權杖或 `x-api-key`，並回傳與管理路由完全相同的位元組。回應帶有強 `ETag`——以 `If-None-Match` 回傳即可重新驗證並取得 `304` 而非完整文件——同時設定 `Cache-Control: private, no-cache`。在此被接納的資料平面金鑰在管理平面上**不會**取得任何權限：`/api/catalog` 以及所有 `/api/*` 路由仍要求管理員權杖或儀表板工作階段。

顯示名稱**只用於顯示，且在重新產生時保持穩定**。每次 `ocx sync` 與目錄 refresh 都會從
`config.json`（包含 `customModels`）重新推導路由條目，因此會重新套用已設定名稱，而不會漂移回路由
slug。受管服務重啟後，也會在 proxy bind 後盡力同步一次。若這次啟動時的 best-effort 同步失敗，例如
離線登入，會保留先前已持久化的目錄，並在下一次成功的 `ocx sync` 重新套用設定名稱。真正的上游原生
名稱，例如 `gpt-5.6-sol` → "GPT-5.6-Sol"，來自固定的上游 snapshot，絕不會被自訂顯示名稱覆寫。

### 外部 provider 管理器

若 `config.toml` 已選用非 `openai` 或 `opencodex` 的 provider，OpenCodex 會保持檔案不變，並跳過
profile 寫入、目錄／cache refresh，以及立即與背景的 Codex 歷史中繼資料還原。管理自訂 provider 的工具常會把
既有 session 標上該 provider id；直接替換 active id 可能讓這些完好的 session 從 Codex 歷史檢視消失。
由舊版根級 profile 選到的外部 provider 也有同樣保護。

請讓單一工具負責 Codex provider 設定。若要在既有 provider manager 後方使用 OpenCodex，請把該
provider 指向 `http://127.0.0.1:10100/v1`，並使用 Responses passthrough（Codex TOML 中
`wire_api = "responses"`），不要做 Chat Completions translation。啟用 proxy API auth 時，也需從
`OPENCODEX_API_AUTH_TOKEN` 傳入 `x-opencodex-api-key`，形式與上方 non-loopback provider 相同。若要讓
OpenCodex 直接注入路由，請先將 Codex 切回內建 `openai` provider，移除任何使用者自有的根級
`openai_base_url`，再重新執行 `ocx start`。

### 目錄疑難排解

若模型在 Codex 中缺失，或目錄順序／可見性看起來不正確，請依序檢查：

1. **provider 上的 `selectedModels`**：非空 allowlist 只會向 Codex 暴露列出的 id；空或省略則暴露所有
   已發現模型。不在 allowlist 中的 id 永遠不會進入目錄。
2. **`disabledModels`（頂層）**：會同時從目錄與 `/v1/models` 隱藏模型，並把裸原生 GPT slug 設為
   `visibility: "hide"`。
3. **`liveModels: false`** — `liveModels: false` 時，若 `models` 為空或省略，初始列表先加入已設定的 `defaultModel`，
   再加入 `retainModels`，重複 ID 僅保留首次出現的位置。若明確設定了非空 `models`，則按
   `models`、`retainModels` 順序建立，不會自動加入另一個 `defaultModel`；仍可將該模型明確寫入
   `models` 或 `retainModels`。這些欄位均未提供 ID 時，初始列表為空。此順序不保證最終選擇器的顯示順序。
   `selectedModels`、`disabledModels` 與供應商停用規則仍然適用。`authMode: "forward"` 保留原有獨立分支，
   不使用此靜態路由列表。這些規則不改變即時探索失敗時的後備行為。
4. **Cursor `GetUsableModels`**：Cursor adapter 透過 protobuf `GetUsableModels` RPC 探索模型，而不是
   `/models`，所以 Cursor 端變更可獨立改變可見 id。
5. **cache 與 `ocx sync`**：即時目錄約快取五分鐘（`modelCacheTtlMs`，預設 `300000`）。執行
   `ocx sync` 可強制重新抓取並立即重寫目錄。
6. **正在執行的 Codex `app-server`**：長時間執行的 Codex `app-server`（Desktop／CLI 背景 host）可能
   仍在記憶體保留舊列表，因此只重寫磁碟目錄還不夠。`ocx sync` 與 `ocx sync-cache` 偵測到這些
   process 時會警告。可執行 `ocx sync --restart-codex` 重新啟動，或自行停止對應的 `app-server`
   process，再讓 Codex 重新建立它們，讓新列表出現。

:::caution[其他本機寫入者]
目錄寫入（`opencodex-catalog.json`、`config.toml`）在 opencodex **內部**是原子的；這只避免兩個
opencodex 擁有的寫入者競爭時出現半寫入檔案。它**不會**阻止其他本機 process、file watcher 或 sync
agent 在 opencodex 寫入後改寫目錄可見性或順序。Codex 另有自己的 `models_cache.json`，可獨立 refresh，
因此可能在不重寫 `opencodex-catalog.json` 的情況下改變可見列表。若 proxy 執行中模型卻意外跳動，請
先停止或重新設定競爭的寫入者，再執行 `ocx sync`。這是外部寫入者風險，不是已確認的 opencodex
缺陷。
:::

## Proxy 連線錯誤

若 Codex 重試後報出類似
`stream disconnected before completion: error sending request for url (http://127.0.0.1:10100/v1/responses)`
的錯誤，或 Claude Code 出現類似連線失敗，代表 opencodex proxy 沒有執行：設定埠上沒有任何監聽，
client 只能顯示原始連線錯誤。請重新啟動 proxy：

```bash
ocx start              # 前景執行
ocx service install    # 常駐：登入時自動啟動，崩潰後自動重新啟動
```

`ocx status` 可檢視 proxy 是否執行，未執行時也會給出相同的重啟提示；`ocx doctor` 會回報重啟安全性
（service／shim 覆蓋情況）。

## Subagent 選擇器

目錄同步會讓選定的 sub-agent 模型可供 Codex 使用；picker 排序請參見
[Codex App 模型選擇器](/zh-tw/guides/codex-app-models/#subagent-selection)，v1/base/v2 委派與 fallback
行為則參見 [Sub-agent Surface](/zh-tw/guides/sub-agent-surface/)。

## Codex 帳號預熱

新增或重新驗證帳號時，通常會在儲存前傳送小型模型請求並等待 `response.completed`。預設使用 `gpt-5.6-luna`，HTTP 400 或 HTTP 404 時改用 `gpt-5.5` 重試。公開錯誤僅包含固定分類，不包含原始回應本文。

若新 OAuth 憑證的已驗證用量查詢確認5小時、每週或每月額度耗盡，則不呼叫模型而直接儲存帳號，顯示**等待驗證**。重新啟動或更新權杖也不會使其可用。額度恢復後重新整理額度：只有完整的最新用量顯示有餘額，才會傳送小型驗證請求；請求完成後帳號才可用於路由。查詢或驗證失敗將保留等待狀態。一般狀態輪詢不會傳送該請求。首次註冊時用量未知仍需一般預熱驗證。

`ocx account refresh openai` 和 `ocx account list openai --quota --refresh` 僅查詢用量。模型驗證會消耗配額，因此需要使用者的儀表板工作階段：配額恢復後，開啟 `ocx gui` 並點選 **Refresh quotas**。無介面主機也需要透過瀏覽器存取其儀表板；僅憑管理員權杖無法授權驗證。暫停的帳號可以完成驗證，但不會因此恢復或被選取。模型授權錯誤會持續顯示，直到驗證或重新登入成功。

背景重新驗證是獨立功能，預設關閉。它需要 Token Guardian、`openai` 的 `proactive` 更新政策及 `tokenGuardian.codexWarmupEnabled`，並略過等待註冊驗證的帳號。

### 帳號停止處理請求的原因

帳號退出帳號池選擇時，原因會隨判定一起傳遞，而不是為了顯示重新計算，因此介面不會在路由已排除該帳號時仍顯示正常。`GET /api/codex-auth/accounts` 會在每個帳號的 `needsReauth` 旁回傳 `reauthReason`：從未儲存憑證為 `missing_credential`，更新持續失敗為 `refresh_failed`，用量查詢本身遭拒為 `quota_unauthorized`。

主帳號更新未完成時仍回傳帶 `Retry-After` 的 `503`，因為重試仍可能成功。訊息現在補充說明：若持續失敗，代表主帳號需要重新認證，而不只是再試一次。

### 讓降級的帳號退出輪換

`codexPool.excludedPlans` 列出自動帳號池選擇要略過的方案鍵，與每個帳號上儲存的方案不分大小寫比對。預設不存在，因此既有安裝的輪換完全不變。

```bash
ocx config set codexPool '{"excludedPlans":["free"]}'
```

這是選擇策略，不是封鎖。被排除的帳號保留憑證、用量紀錄與執行緒親和性，仍顯示在帳號清單中，也仍可透過 `work/gpt-5.5` 這類明確選擇使用。改變的只是自動輪換不再挑它，包括它已經是使用中帳號或已綁定執行緒的情況——訂閱到期後留下的正是這種狀態。

有兩處刻意的限制。主 Codex 帳號不會因方案被排除：僅選擇模式的路由不讀取受保護的原生憑證而隱去其方案，涵蓋主帳號的規則會自相矛盾。此外，當沒有未被排除的帳號時，被排除的帳號仍會回應而不是失敗；要完全停止服務，仍然是暫停所有帳號。沒有對應的 `minimumPlan`，因為為 ChatGPT 方案排序需要一個這裡並不存在的全序。

## 恢復原生 Codex

`ocx stop` 會停止 proxy 與已安裝的背景服務，然後嘗試恢復原生 Codex。OpenCodex 只移除能確認歸屬的路由設定；若無法安全恢復設定檔，會回報恢復未完成。

若目前的 config 或 profile 與儲存的原始內容不同，且日誌缺少該檔案注入狀態的雜湊值，自動快照恢復會保留兩個檔案及日誌，不做修改。已與原始內容相同的檔案不會重新寫入。對已路由設定再次注入時，也會拒絕使用這種未確認的基準；原生設定可以建立新的快照。詳見[恢復規則](/guides/codex-integration/#recovery-without-injection-hashes)。

```bash
ocx stop       # 停止 proxy + service，恢復原生 Codex
ocx restore    # 不停止 proxy，只恢復原生設定（alias: ocx eject）
ocx restore back # 讓普通 Codex 再次指向仍在執行的 proxy
```

當 opencodex 作為受管的 [背景服務](/zh-tw/reference/cli/#ocx-service) 執行時，會設定 `OCX_SERVICE=1`，
因此 service 驅動的 restart **不會**反覆改寫 Codex 設定；只有明確執行 `ocx stop` 或
`ocx service stop` 才會恢復原生 Codex。

## 分頁歷史記錄安全拒絕

如果受影響的歷史儲存區支援分頁，提供者切換可能傳回 `history_paginated_requires_native_writer`。OpenCodex 會保留目前設定、設定檔、模型目錄、歷史檔案及復原依據，而不在 Codex 之外分配序號；可遷移儲存區中的 legacy 記錄也受保護。不執行切換、僅保留外部提供者的路徑仍可使用。

請勿刪除對話仍參照的提供者定義、反覆執行 `ocx sync` 或舊版復原，也不要改寫使用中的歷史檔案來繞過拒絕。保留檔案，復原前關閉相關對話，只回報確切錯誤與版本，不要公開私人歷史。需要與原生寫入器協調的已驗證修正。備份或指令碼成功不能證明顯示已復原；重新開啟 Codex 後確認對話。
