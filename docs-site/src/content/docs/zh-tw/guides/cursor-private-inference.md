---
title: Cursor Private Inference
description: 在 macOS、Windows 或 Linux 上，透過 Cursor 的本機代理版本使用 opencodex 路由模型，無須公開 tunnel。
---

一般版 Cursor 無法連線至你電腦上的代理。設定「Override OpenAI Base URL」時，Cursor 後端會組裝提示詞，並從 Cursor 伺服器呼叫該 URL；其伺服器會拒絕 loopback、LAN 與私有位址。因此，社群提供的 Cursor 加本機模型方案最後都需要 ngrok、Cloudflare Tunnel 或 VPS。

Cursor 也提供第二種桌面版本：**Cursor Private Inference**。它的代理循環在本機執行，並呼叫你設定的 OpenAI 相容 gateway。指向 opencodex 後，便能使用你的路由模型，無須 tunnel、修補應用程式或 TLS。本頁介紹的就是此版本。

## 開始前

請先閱讀這節；這是最容易忽略的部分。

- **opencodex 不提供此版本。** Cursor 也未提供相關文件。cursor.com 沒有連結到它，版本可能無預警變更，也可能停止提供。如果你尚未取得，此指南不適用；請改用社群的 [`ocx-cursor`](https://www.npmjs.com/package/ocx-cursor) 橋接及公開 HTTPS 端點。
- **仍須登入 Cursor。** 登入畫面會先於 gateway 設定視窗出現。
- **Cursor 自家的模型無法使用。** 在本機模式中，選擇器只列出 gateway 回傳的模型。Tab completion、Cursor 目錄（Composer、Auto）與 Cloud Agents 均會停用。若已設定 Cursor provider，仍可透過 opencodex 自身的 `cursor/*` 路由使用 Cursor provider 模型。
- **每個回合都會帶上 Cursor 的本機 system prompt**；從第二回合起約為 23k token。選擇模型時請預留容量。
- **它與一般版 Cursor 共用身分。** bundle id、`~/.cursor`、`Application Support/Cursor` (macOS)、`%APPDATA%\Cursor` (Windows) 或 `~/.config/Cursor` (Linux) 都相同。使用 `--user-data-dir <dir>` 啟動以隔離兩者；除非想複製設定，首次執行時請勿勾選「Import data from existing Cursor installation」。

## 辨識已安裝版本

兩個版本在 Dock 中都叫「Cursor」，並共用 bundle id，因此請檢查 `product.json`：

| 平台 | product.json |
|---|---|
| macOS | `/Applications/Cursor Private Inference.app/Contents/Resources/app/product.json` |
| Windows | `%LOCALAPPDATA%\\Programs\\cursor-private-inference\\resources\\app\\product.json` |
| Linux | `<install root>/resources/app/product.json`（須先解開 AppImage） |

本機代理版本的 `nameLong` 為 `"Cursor Private Inference"`，一般版則為 `"Cursor"`；`version` 是建置版本（撰寫時為 3.18.25）。儀表板的 Integrations > Cursor 卡片會執行同樣的檢查並列出結果。本機模式是在 workbench bundle 中切換，不在 `product.json`，因此沒有可切換的旗標：如果 `nameLong` 顯示一般版 Cursor，該安裝就無法連線至 loopback gateway。

與 gateway 通訊的代理循環位於相同安裝根目錄下的單一檔案 `extensions/cursor-agent-exec/dist/main.js`。opencodex 以有界的唯讀方式讀取它，取得 Cursor 的推理強度表；請參閱「模型與推理強度」。

## 設定 gateway

opencodex 必須正在執行（`ocx service status`）。以下兩種方式都可行，最後會得到相同設定。

**在應用程式中。** Settings → Models → Gateway → Configure gateway：

| 欄位 | 值 |
|---|---|
| Base URL | `http://127.0.0.1:10100/v1`（須包含 `/v1`；允許純 `http://` loopback） |
| API Key | 若服務使用 API auth，填入 `OPENCODEX_API_AUTH_TOKEN` 的值；否則填入任何佔位值，例如 `opencodex-loopback` |

點擊 **Refresh model list**。選擇器會載入 opencodex 的 `/v1/models`；開啟你要使用的資料列。

**使用環境變數。** 應用程式會在啟動時讀取：

```text
CURSOR_LOCAL_AGENT_BASE_URL=http://127.0.0.1:10100/v1
CURSOR_LOCAL_AGENT_API_KEY=opencodex-loopback
CURSOR_LOCAL_AGENT_HEADERS=            # optional, newline-separated "Header-Name: value" lines
```

`CURSOR_LOCAL_AGENT_HEADERS` 會拒絕 `User-Agent` 與未解析的 `{...}` 佔位符；`{gitOrgRepo}` 和 `{gitBranch}` 則會展開。

優先順序由高到低：各模型的憑證 → Settings 中儲存的 gateway → `CURSOR_LOCAL_AGENT_*` → `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`（相容性備援）。環境變數不會覆寫已儲存的 gateway；若想透過環境變數切換，請先在 Settings 清除該設定。

Cursor Private Inference 是 GUI 應用程式，因此只設定互動式 shell profile 並不足夠；變數必須存在於啟動應用程式的程序環境中。

| OS | 設定位置 |
|---|---|
| macOS | 在目前登入工作階段執行 `launchctl setenv CURSOR_LOCAL_AGENT_BASE_URL http://127.0.0.1:10100/v1`，或以含 `EnvironmentVariables` 的 LaunchAgent 永久設定。從終端機啟動應用程式也可行。 |
| Windows | 執行 `setx CURSOR_LOCAL_AGENT_BASE_URL http://127.0.0.1:10100/v1`（使用者範圍；影響新程序），或使用 System Properties → Environment Variables。之後重新啟動應用程式。 |
| Linux | 顯示管理器工作階段可用 `~/.profile` 或 `~/.pam_environment`；桌面在使用者 systemd 工作階段執行時，可用 `systemctl --user set-environment CURSOR_LOCAL_AGENT_BASE_URL=http://127.0.0.1:10100/v1`。從終端機啟動的 AppImage 會繼承該 shell 的環境。 |

此版本提供 macOS（arm64、x64、universal）、Windows（x64、arm64）與 Linux（x64、arm64）版本；設定方式相同。

## 從儀表板查看

opencodex 儀表板在 Integrations 下有 **Cursor** 分頁（`/#integrations/cursor`）。它對 Cursor 只有唯讀存取：絕不寫入 Cursor 的設定資料庫、keychain 項目或應用程式 bundle，所以也沒有能直接切換的開關。它會提供設定值，並顯示是否生效。

- **已安裝版本。** 顯示是否存在 Cursor Private Inference（含路徑與版本）及一般版 Cursor（僅路徑）。如果只找到一般版 Cursor，分頁會向 Cursor 自己的更新通道（`api2.cursor.sh` 上的 `cursor-local` 通道）查詢它為目前平台與 CPU 提供的 local-mode 安裝程式，顯示該版本及指向 `downloads.cursor.com/local-mode/` 安裝程式的連結，並連回此處。opencodex 只顯示連結，從不下載、啟動或安裝任何東西。結果會快取 30 分鐘（失敗後為 5 分鐘）。若通道無法連線、回傳無法使用的內容，或 Cursor 沒有為這台電腦提供版本（僅 Windows、macOS 與 Linux 的 x64 和 arm64 有），分頁會說明無法確定安裝程式；無論哪種情況，下方的閘道值都仍然有效。一般版 Cursor 本身仍透過 Cursor 伺服器路由自訂端點，因此無法連線到 loopback 代理。
- **Gateway 值。** 提供代理自身監聽連接埠的 Base URL（從執行環境記錄取得，因此即使儀表板經 reverse proxy，仍顯示本機 Cursor 可連到的連接埠），並附 Copy 按鈕。API Key 資料列依繫結方式而定：無須憑證時顯示 `opencodex-loopback` 和 Copy；啟用 API auth 或已設定任何 opencodex API 金鑰時，則提示使用自己的金鑰，並連到 API Keys 分頁。任何已設定的金鑰都可使用，不限於 `OPENCODEX_API_AUTH_TOKEN`。
- **連線狀態。** 顯示最近一次 User-Agent 恰為 `Cursor/<version>` 的 `/v1/models` 請求（Cursor 本機代理執行環境送出的標頭），包含時間與版本。Cursor 尚未呼叫代理時會顯示「never seen」；在 Cursor 按 **Refresh model list** 後就會更新。分頁開啟時，卡片每 15 秒重新整理一次。
- **Cursor 將顯示的內容。** 依照下一節規則，為 opencodex 公開的模型顯示 Model / Reasoning / Context 表格（停用模型與 provider allowlist 的規則和原始清單一致）。這是預測值：Cursor 會從自身的表格選擇 Reasoning 階梯。

## 模型與推理強度

選擇器使用 opencodex 原始的 `/v1/models` 清單。模型資料列是否出現 **Reasoning** 控制項，由兩項條件決定：

1. opencodex 必須在資料列宣告能力（`api_types` 加上一個 `capabilities` 物件）。從 v2.41 起它會這麼做；較舊代理會顯示模型，但不提供強度控制。
2. 模型 ID 去掉最後一個 `/` 之前的內容及任何 `@…` 後綴後，必須符合 Cursor 自身的強度表。該表編入應用程式（`extensions/cursor-agent-exec/dist/main.js`）；opencodex 從偵測到的安裝讀取它，讓儀表板預測隨 Cursor 更新，卡片也會顯示讀取的版本；未找到安裝時顯示「static mirror」。階梯由 Cursor 而非 opencodex 決定，任何 `/v1/models` 欄位都不能把模型新增至該表。下表是靜態鏡像所含的 3.18.25 快照：

| 模型 ID（最後一個 `/` 之後） | Cursor 顯示的階梯 | 傳輸欄位 |
|---|---|---|
| `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` | Low（低）、Medium（中）、High（高）、Extra High（極高） | `reasoning.effort` |
| `gpt-5`, `gpt-5.x` | Low（低）、Medium（中）、High（高）、Extra High（極高） | `reasoning.effort` |
| `claude-opus-5`, `claude-sonnet-5`, `claude-opus-4.7`, `claude-opus-4.8` | Low（低）、Medium（中）、High（高）、Extra High（極高）、Max（最高） | `output_config.effort` |
| `claude-opus-4.6`, `claude-opus-4.5`, `claude-sonnet-4.6` | Low（低）、Medium（中）、High（高）、Max（最高） | `output_config.effort` |
| `grok-4.3`, `grok-4.5`, `grok-4.6`, `grok-build-latest` | Minimal（最低）、Low（低）、Medium（中）、High（高）、Extra High（極高） | `reasoning_effort` |
| `gemini-*`（需要 `supports_reasoning`） | Minimal, Low, Medium, High | `reasoning_effort` |
| 其他模型，包括 `claude-fable-5-1`、`kimi-k3` | 無控制項 | — |

因此 `anthropic/claude-opus-5` 可以使用，但 opencodex 為 GPT-5.6 提供的 `max`／`ultra` 檔位無法從此選擇器選取。

### 沒有控制項的模型

`anthropic/claude-fable-5-1`、`cursor/kimi-k3` 及表格以外的模型都沒有 Reasoning 控制項。當 gateway 宣告 `supports_reasoning` 時，Cursor 會為每個這類 ID 記錄一行：「Local provider advertises reasoning support for a model with no hardcoded Bottlerocket effort family」。仍可透過兩種方式選擇強度：

- **強度資料列**（opencodex 設定中的 `cursorEffortRows: true`，預設關閉）：gateway 會為表格未列出的模型，按強度公開一個選擇器項目，例如 `anthropic/claude-fable-5-1--high` 或 `cursor/kimi-k3--max`，並將它們路由至套用相應強度的基礎模型。Cursor 已提供控制項的模型不會增加資料列，而精確相符的已知模型 ID 一律優先於 `--<effort>` 後綴。開啟後請按 Refresh model list。儀表板卡片會統計各模型公開的資料列數。選取資料列屬明確選擇，因此其強度也會優先於請求中的 `ocx-effort` 指令。
- **固定預設值**（provider 上的 `modelDefaultReasoningEfforts`）：Cursor 未送出強度時套用。

### 「Max」有兩種含義

一般版 Cursor 會在部分模型旁顯示 **Max** 開關。那是 Max Mode，表示較大的脈絡視窗，並非推理強度檔位。本機代理版本在模型選單中以 **Context** 項目呈現相同概念；opencodex 對原生 GPT-5.6 系列提供 **272K**（預設）或 **922K**（1M 選擇啟用，標示費用較高）。所選值限制該回合的脈絡容量。路由模型只顯示單一視窗，沒有 Context 項目；若 provider 脈絡上限低於 922K，原生資料列也不會顯示此項目。

推理強度 **Max**（opencodex 的 `max`／`ultra`）是另一層含義，而且無法在此選擇：Cursor 從自身的表格而非 gateway 取得強度階梯，GPT-5.6 條目只到 Extra High。

由於 opencodex 在 `api_types` 宣告 `responses`，此版本會將代理回合連同 `reasoning.effort` 送至 `/v1/responses`，而非 `/v1/chat/completions`。

這個傳輸選擇對 Claude 資料列有副作用：Cursor 只在 Anthropic Messages 傳輸中，以 `output_config.effort` 送出 Claude 強度。因此 Base URL 為 `/v1` 時，即使 Claude 資料列顯示控制項，仍會使用 provider 預設強度。Base URL 以 `/messages` 結尾時情況相反：Claude 強度會送出，但 OpenAI 系列的強度會遺失。單一 gateway 項目無法同時服務兩個系列；前述強度資料列可繞過此限制，因為強度由 opencodex 自行套用。

## 驗證

`ocx observe logs` 會顯示回合具有 `inboundProtocol: responses` 與 `admissionKind: loopback`。

| 症狀 | 檢查項目 |
|---|---|
| gateway 回傳 401 | API Key 與 `OPENCODEX_API_AUTH_TOKEN` 不相符；未啟用 API auth 的 loopback 繫結可使用任何值 |
| 選擇器為空 | opencodex 未執行，或 Base URL 缺少 `/v1`；修正後按 Refresh model list |
| 列出模型卻沒有 Reasoning 控制項 | opencodex 早於 v2.41，或該 ID 不在 Cursor 表格中（儀表板標示為 —）；開啟 `cursorEffortRows` 或設定 provider 預設值 |
| 結構變更未生效 | Cursor 會依 Base URL 字串快取 `/models`，且不會過期；Refresh model list 會重新讀取，否則請重新啟動應用程式，或暫時儲存 URL 的另一種寫法（`localhost` 與 `127.0.0.1`） |
| 第一回合約有 23k token | 預期行為；這是 Cursor 的本機 system prompt |
