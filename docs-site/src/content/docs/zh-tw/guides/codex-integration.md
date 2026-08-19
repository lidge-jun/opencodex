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
history 不需要重新對映。第一次同步時，也會把舊版 opencodex 改過標記的 thread 遷回 `openai`。
non-loopback 專用 provider 模式在啟用期間仍會把歷史映射到 `opencodex` provider，退出時再恢復已備份的
metadata。設定 `syncResumeHistory: false` 可完全不修改歷史。

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

遠端 Codex client 也能透過管理 API 取得相同的產生目錄，使用與其他 `/api/*` route 相同的 admission
token：

```bash
dest="${CODEX_HOME:-$HOME/.codex}/opencodex-catalog.json"
tmp="$(mktemp "${dest}.XXXXXX")"
curl -fsS -H "x-opencodex-api-key: $OPENCODEX_ADMIN_AUTH_TOKEN" \
  "https://proxy.example.com/api/catalog" > "$tmp" \
  && mv "$tmp" "$dest"
ocx sync-cache
```

回應是原始的 `opencodex-catalog.json` 文件，不包含 provider 憑證。若可用，
`x-opencodex-codex-version` 標頭會回報伺服器上的 Codex runtime 版本，讓 client 能辨識版本差異。

也可以透過管理 API（`POST /api/custom-models`、`PUT /api/custom-models/<id>`，搭配 `displayName`
字串）與 web 儀表板設定或編輯。`/` 會被拒絕，因為它會與路由 slug 的分隔符衝突。

顯示名稱**只用於顯示，且在重新產生時保持穩定**。每次 `ocx sync` 與目錄 refresh 都會從
`config.json`（包含 `customModels`）重新推導路由條目，因此會重新套用已設定名稱，而不會漂移回路由
slug。受管服務重啟後，也會在 proxy bind 後盡力同步一次。若這次啟動時的 best-effort 同步失敗，例如
離線登入，會保留先前已持久化的目錄，並在下一次成功的 `ocx sync` 重新套用設定名稱。真正的上游原生
名稱，例如 `gpt-5.6-sol` → "GPT-5.6-Sol"，來自固定的上游 snapshot，絕不會被自訂顯示名稱覆寫。

### 外部 provider 管理器

若 `config.toml` 已選用非 `openai` 或 `opencodex` 的 provider，OpenCodex 會保持檔案不變，並跳過
profile 寫入、目錄／cache refresh，以及立即與背景的 Codex 歷史遷移。管理自訂 provider 的工具常會把
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
3. **`liveModels: false` 且 `models` 為空**：當即時探索關閉，且 `models` 為空或省略時，opencodex
   不會為該 provider 暴露任何路由模型。
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

向 Codex 帳號池新增 ChatGPT 帳號時，opencodex 會先用一個小型 streaming 請求向 Codex Responses
backend 驗證，成功後才持久化。請求使用真正的 Responses item 陣列
（`input: [{ type: "message", ... }]`），等待 `response.completed`，預設模型為 `gpt-5.4-mini`。若該
模型回傳 HTTP 400，則改用 `gpt-5.5` 重試；結構化上游錯誤細節會呈現給使用者，但不暴露原始 response
body。背景重新驗證是獨立功能，預設關閉；只有啟用 Token Guardian、將 `chatgpt` refresh policy 設為
`proactive`，並把 `tokenGuardian.codexWarmupEnabled` 設為 true 時才會執行。

## 恢復原生 Codex

opencodex 絕不會把你困住。**`ocx stop` 是完整恢復原生 Codex 的單一命令**。它會停止 proxy、停止
背景服務（若已安裝），並移除所有注入行與路由目錄條目，讓普通的 `codex` 就像從未安裝 opencodex 一樣
運作：

```bash
ocx stop       # 停止 proxy + service，恢復原生 Codex
ocx restore    # 不停止 proxy，只恢復原生設定（alias: ocx eject）
ocx restore back # 讓普通 Codex 再次指向仍在執行的 proxy
```

當 opencodex 作為受管的 [背景服務](/zh-tw/reference/cli/#ocx-service) 執行時，會設定 `OCX_SERVICE=1`，
因此 service 驅動的 restart **不會**反覆改寫 Codex 設定；只有明確執行 `ocx stop` 或
`ocx service stop` 才會恢復原生 Codex。