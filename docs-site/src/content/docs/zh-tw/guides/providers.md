---
title: 供應商
description: opencodex 進行身分驗證並與 LLM 供應商通訊的所有方式——OAuth、API 金鑰、ChatGPT 轉發以及本機。
---

**供應商（provider）** 是一個上游 LLM 端點，加上存取它的方式：一個 adapter、一個基礎 URL、一種認證模式，以及一個可選的模型列表。供應商設定位於 `~/.opencodex/config.json` 的 `providers` 下。

## OpenAI 帳號模式

| Provider id | 用途 | 憑證/帳號規則 |
| --- | --- | --- |
| `openai` | Codex 登入 | Pool（預設）選擇主帳號和新增帳號；Direct 只使用目前 caller/主登入。 |
| `openai-apikey` | OpenAI API | 只使用設定的 API key/key pool；不讀取 Codex 帳號。 |

bare `gpt-5.6-sol` 遵循 Providers 頁面中的 Pool/Direct 選項，
`openai-apikey/gpt-5.6-sol` 選擇 API。憑證路徑之間不會 fallback。API 後設資料為 1,050,000 context /
922,000 max input；`*-pro` virtual id 保留在公開狀態中，線上改寫為 base 模型加
`reasoning.mode: "pro"`。

若內建 `openai` 供應商缺失或已停用，可在儀表板 Accounts 選擇器或 Codex Auth 頁面恢復：缺失行會從規範預設建立，已停用的規範行會在不替換已儲存模式/模型設定的情況下重新啟用，非規範的 `openai` 行不會提供該恢復路徑。

shipped v1 設定自動遷移到 marker 2 的單一選項行。原設定只保留一次到
`~/.opencodex/config.json.pre-openai-tiers-v2.bak`；恢復命令：
`cp ~/.opencodex/config.json.pre-openai-tiers-v2.bak ~/.opencodex/config.json`。

### Providers 總覽的池容量

對於池模式的 Codex 登入，Providers 總覽顯示池已使用容量的設定權重估計，而非將一個任意的帳號呈現為供應商總量。同一列還顯示目前有效帳號的原始配額百分比，因此你可以區分池估計與新請求會使用的帳號。

當重置資訊可用時，總覽以 `+N% pool capacity` 顯示下一個重置時間與該重置預期恢復的容量。**Incomplete coverage**（不完整覆蓋）表示一個或多個池帳號無法安全貢獻到估計，例如其 plan 或配額未知、讀取過時，或帳號已暫停或需要重新認證。

**Partial window coverage**（部分視窗覆蓋）警告表示某些被包含的帳號回報了一個配額視窗但沒有回報另一個。總覽將這些視窗分開，並將每個受影響的視窗標記為不完整，而非將缺失讀取視為該視窗的用量。

此估計僅供顯示。它不變更帳號選擇、session 親和性、自動切換、冷卻或任何其他路由決策。請使用 [Codex Auth 帳號池](/zh-tw/guides/web-dashboard/#codex-auth-and-account-pools)查看個別帳號狀態與路由控制。

## 認證模式

供應商設定支援三種 `authMode`，預設值為 `key`。內建登入檔還會單獨標記本機預設；這類預設通常會
同時省略 `authMode` 和 `apiKey`。

| `authMode` | 如何進行認證 | 使用方 |
| --- | --- | --- |
| `key` | 傳送你的 API 金鑰（`Authorization: Bearer …`，或按 adapter 使用 `x-api-key` / `api-key`）。金鑰可以是字面值，也可以是 `${ENV_VAR}` 引用。 | 大多數供應商。 |
| `forward` | 將**你傳入的 Codex 認證標頭**原樣轉發給供應商——不儲存任何金鑰。這就是 ChatGPT 登入的透傳方式。 | OpenAI（`openai-responses` adapter）。 |
| `oauth` | 讀取已儲存的 OAuth 存取權杖（過期前自動重新整理），並將其用作 bearer 金鑰。 | xAI、Anthropic、Kimi、Kiro、Google Antigravity、Cursor。 |

## 1. ChatGPT 登入（forward / 透傳）

預設供應商**不需要 API 金鑰**。它將你現有 `codex login` 的憑證直接轉發到 OpenAI Responses 後端：

```json
{
  "openai": {
    "adapter": "openai-responses",
    "baseUrl": "https://chatgpt.com/backend-api/codex",
    "authMode": "forward"
  }
}
```

只有一組精選的標頭會被轉發（`FORWARD_HEADERS`：authorization、ChatGPT account id、OpenAI beta/originator/session——參見 [Adapters](/zh-tw/reference/adapters/)）。這條路徑也為 [web-search 和 vision sidecar](/zh-tw/guides/sidecars/) 提供支援。

ChatGPT 透傳目錄也會加入 GPT-5.6 Sol/Terra/Luna 的裸 slug（`gpt-5.6-sol`、
`gpt-5.6-terra`、`gpt-5.6-luna`）；帳號具備相應權限時才能實際呼叫。

## 2. 帳號登入（OAuth）

有六個供應商預設使用 OAuth 登入。opencodex 會把憑證存入 `~/.opencodex/auth.json` 並自動重新整理。
登入 CLI 也接受 `chatgpt`：它會取得一份 ChatGPT 憑證，並建立一個 `forward` 模式的供應商條目。

```bash
ocx login xai          # xAI Grok
ocx login anthropic    # Anthropic Claude (Pro/Max)
ocx login kimi         # Moonshot Kimi
ocx login kiro         # 匯入 kiro-cli 憑證（支援權杖回退）
ocx login google-antigravity
ocx login cursor       # 獨立的 Cursor PKCE 登入
ocx login chatgpt      # 獨立的 ChatGPT OAuth 登入
ocx logout <provider>
```

| 供應商 | Adapter | 基礎 URL | 備註 |
| --- | --- | --- | --- |
| `xai` | `openai-chat` | `https://api.x.ai/v1` | 優先使用即時 Grok 目錄；回退預設模型為 `grok-4.5`。 |
| `anthropic` | `anthropic` | `https://api.anthropic.com` | Claude 模型；即時模型列表從 `/v1/models` 取得。 |
| `kimi` | `openai-chat` | `https://api.kimi.com/coding/v1` | Kimi K2.7/K2.6/K2.5 程式設計模型。 |
| `kiro` | `kiro` | `https://runtime.us-east-1.kiro.dev` | 優先複用已安裝的 `kiro-cli` 登入。需先安裝 Kiro CLI（`curl -fsSL https://cli.kiro.dev/install | bash`）並執行 `kiro-cli login`。 |
| `google-antigravity` | `google` | `https://daily-cloudcode-pa.googleapis.com` | 透過 Cloud Code Assist 協議使用 Google OAuth。 |
| `cursor` | `cursor` | `https://api2.cursor.sh` | 實驗性 PKCE 登入、HTTP/2 傳輸和按帳號篩選的模型發現。 |

你也可以從 [web 儀表板](/zh-tw/guides/web-dashboard/) 啟動 OAuth。

### 多個 OAuth 帳號

OAuth 憑證中帶有穩定帳號 id 或郵箱的供應商可以儲存多個登入。Providers 頁面會在下拉選單中顯示這些
帳號，允許繼續新增，並在不登出其他帳號的情況下切換目前帳號。沒有身份資訊的 Kimi 和 Kiro 會替換
目前 active slot；`chatgpt` 始終只有一個 slot，因為 Codex 帳號池使用獨立儲存。權杖仍儲存在
`~/.opencodex/auth.json` 中；`/api/oauth/accounts` 只回傳脫敏後的 metadata。

### Cockpit Tools Antigravity 匯入

目前（v1）OpenCodex 僅為 `google-antigravity` 供應商匯入 **Cockpit Tools Antigravity** JSON 匯出。在 Providers 儀表板中，從該供應商的 Accounts 分頁選擇本機 JSON 檔案。儀表板不會顯示檔案內容或憑證值；它僅回報已匯入、已更新、失敗與不支援的計數。其他 Cockpit 供應商在 v1 中被拒絕。

CLI 僅接受檔案或標準輸入的匯出——絕不要把它貼進指令參數：

```bash
ocx account import google-antigravity --format cockpit-tools --file <path> [--json]
cat accounts.json | ocx account import google-antigravity --format cockpit-tools --stdin [--json]
```

內嵌 JSON 與額外的位置參數會被拒絕。請將匯出檔案保持私密，並在匯入後安全地刪除或存放。

### OAuth 可靠度

opencodex 協調 token 重新整理與 Codex 池路由，使並行請求不會競爭憑證存放。這是可靠度與診斷工作——它**不**保證免受供應商強制執行、速率限制或帳號動作的保護。

**重新整理協調。** 在路由呼叫前，過期的 access token 每個 `(provider, account)` 重新整理一次：

1. In-process single-flight——並行呼叫者共享一個重新整理 promise。
2. Per-account 檔案鎖——跨行程寫入器在同一帳號上序列化。
3. Generation CAS——僅在已儲存憑證的 generation 仍相符時持久化；較新的寫入器勝出，較舊的重新整理結果不能覆寫它。

終端重新整理失敗會將帳號標記為需要重新認證，而非無限重試。

**冷卻（Codex 池）。** 上游 `429`／配額回應會從 `Retry-After`、配額 `reset` 標頭（有上限）或短預設 backoff 設定硬性冷卻。處於明確 `Retry-After` 冷卻的帳號不會被提前探測；reset 衍生的冷卻可能收到有節奏的探測租約，以便在不淹沒供應商的情況下偵測復原。Reset 衍生的原生模型冷卻也保留已知的獨立配額群組：`gpt-5.3-codex-spark` 不會阻止同一帳號嘗試共享的 GPT-5.6 Terra/Luna 配額，而該共享群組中的模型仍會互相保護。明確 `Retry-After` 與預設冷卻恆為帳號範圍。

**Session 親和性。** Codex 執行緒→帳號親和性是行程本地的（僅記憶體；不會跨代理重啟持久化）。在憑證失敗（`401`／`403`）時，帳號被隔離等待重新認證，並清除該帳號的親和性。在 `429` 時，帳號進入冷卻、親和性被清除，池選擇可能輪換——執行緒不會被 pin 在速率限制回應上。

**Codex 用戶端中繼資料。** ChatGPT forward 路徑透傳策展的 `FORWARD_HEADERS` 允許清單（authorization、`chatgpt-account-id`、originator、session/thread id 與相關 Codex 標頭——見 [Adapter](/zh-tw/reference/adapters/)）。池模式僅覆寫 auth 與 `chatgpt-account-id` 以符合所選憑證。opencodex 在呼叫者未發送時**不會**偽造官方用戶端身分（例如 `originator`、session 或 thread 標頭）。

### Kiro 憑證匯入

Kiro 登入期待 Kiro CLI：在 Unix 上以 `curl -fsSL https://cli.kiro.dev/install | bash` 安裝；在 Windows PowerShell 上使用 `irm 'https://cli.kiro.dev/install.ps1' | iex`；然後以 `kiro-cli login` 登入。沒有 `kiro-cli` session 時，`ocx login kiro` 後退到貼上的 access token 或 `KIRO_ACCESS_TOKEN` 環境變數。

`ocx login kiro` 匯入路徑搜尋平台 Kiro CLI 存放並以唯讀方式開啟 SQLite 資料庫。兩個環境變數使來源與 token 列選擇明確：

- `KIROCLI_DB_PATH` 選擇非標準的 Kiro CLI SQLite 資料庫。該路徑必須已存在；在此匯入路徑中，opencodex 不會建立或修改資料庫、WAL 或 SHM 檔案。
- `KIROCLI_TOKEN_KEY` 在資料庫包含多個其他方面模糊的 token 列時選擇精確的 `auth_kv` token key。缺失選擇會使登入失敗而非猜測。

在 Windows 上，匯入會尋找 `%LOCALAPPDATA%\Kiro-Cli\data.sqlite3`。強制／新增帳號登入還需要本機 CLI 二進位檔：opencodex 先使用 `PATH`，然後後退到 `%LOCALAPPDATA%\Kiro-Cli\kiro-cli.exe` 與 `C:\Program Files\Kiro-Cli\kiro-cli.exe`。

成功匯入後，opencodex 將匯入的憑證持久化到 `~/.opencodex/auth.json`。

請將這些變數與所選資料庫保持私密。不要將資料庫檔案或原始登入診斷附加到 bug 報告。

**Add account**（新增帳號）是獨立的寫入流程：它快照目前 session、登出 `kiro-cli` 並匯入新的瀏覽器登入。若登入被取消或失敗（包含在 OpenCodex 持久化憑證期間），復原會在發布先前 session 快照前替換 Kiro CLI 資料庫並移除其目前的 WAL、SHM 與 journal sidecar。

由於該復原只能從快照進行，**Add account** 在 session 存放存在但無法被擷取（不可讀檔案、schema 不符或模糊的 token 選擇）、`KIROCLI_DB_PATH`／`KIRO_CLI_DB_FILE` 將匯入讀取重定向離開即時 CLI 存放，或既有主 CLI 資料庫沒有可識別 token 列時，拒絕登出 `kiro-cli`。請在一般 `kiro-cli` 資料路徑下修復或移除不可讀的資料庫、取消設定那些匯入選擇器後重試。從沒有既有 `kiro-cli` session 的機器登入不受影響。

## 3. API 金鑰目錄

opencodex 內建 79 個預設：67 個金鑰預設、8 個 OAuth 預設、3 個本機預設，以及預設的
ChatGPT 轉發預設。儀表板的 **Add provider** 選擇器會開啟金鑰供應商的儀表板，驗證並儲存金鑰。
主要條目包括：

| 供應商 | 基礎 URL |
| --- | --- |
| **OpenAI (API key)** | `https://api.openai.com/v1` |
| **Anthropic (API key)** | `https://api.anthropic.com` |
| **OpenRouter** | `https://openrouter.ai/api/v1` |
| **Ollama Cloud** | `https://ollama.com/v1` |
| Google Gemini · Google Vertex AI | `https://generativelanguage.googleapis.com` · `https://aiplatform.googleapis.com` |
| Azure OpenAI | `https://{resource}.openai.azure.com/openai` |
| Umans AI · Neuralwatt | `https://api.code.umans.ai` · `https://api.neuralwatt.com/v1` |
| Mistral | `https://api.mistral.ai/v1` |
| MiniMax · MiniMax (CN) | `https://api.minimax.io/v1` · `https://api.minimaxi.com/v1` |
| DeepSeek | `https://api.deepseek.com` |
| Cerebras | `https://api.cerebras.ai/v1` |
| Together | `https://api.together.xyz/v1` |
| Fireworks | `https://api.fireworks.ai/inference/v1` |
| Moonshot (Kimi API) · Kimi (coding) | `https://api.moonshot.ai/v1` · `https://api.kimi.com/coding/v1` |
| Hugging Face | `https://router.huggingface.co/v1` |
| NVIDIA NIM | `https://integrate.api.nvidia.com/v1` |
| Z.AI (GLM Coding) | `https://api.z.ai/api/coding/paas/v4` |
| Qwen Cloud | Token plan（預設）: `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` · 按量付費: `https://dashscope.aliyuncs.com/compatible-mode/v1` · 或自訂 |
| 騰訊雲 Coding Plan | `https://api.lkeap.cloud.tencent.com/coding/v3` |
| SiliconFlow | `https://api.siliconflow.cn/v1` |
| Xiaomi MiMo | `https://api.xiaomimimo.com/anthropic` |
| Kilo | `https://api.kilo.ai/api/gateway` |
| GitHub Copilot · GitLab Duo | `https://api.githubcopilot.com` · `https://cloud.gitlab.com/ai/v1/proxy/openai/v1` |
| Cloudflare AI Gateway | `https://gateway.ai.cloudflare.com/v1/{account-id}/{gateway}/anthropic` |
| ……以及更多 | opencode zen、Vercel AI Gateway、Venice、NanoGPT、Synthetic、Qianfan、Alibaba、Parallel、ZenMux、LiteLLM |

大多數使用帶 bearer 金鑰的 `openai-chat` adapter；少數僅暴露 Anthropic 相容端點的供應商（例如 **Xiaomi MiMo**）使用 `anthropic` adapter（`x-api-key`）。

> **騰訊雲 Coding Plan 使用限制：**騰訊將此訂閱限定為互動式程式設計工具使用。禁止通用 API
> 自動化、自訂應用後端和非互動式批次呼叫；違規使用可能導致套餐金鑰被停用。

### A6API 信用額度

使用 `authMode: "key"` 與標準 `https://api.a6api.com` 或 `https://api.a6api.com/v1` base URL 的自訂 `openai-chat` 供應商，會在儀表板與 `ocx account refresh <provider>` 中收到 A6API 信用額度計量表。供應商名稱任意；偵測使用標準 HTTPS 端點。計量表使用帳號的硬性信用上限將 A6API token 單位轉換為 USD，並顯示已消耗百分比與剩餘信用。Token 到期不會顯示為配額重置，因為到期不代表信用會補充。

```json
{
  "providers": {
    "my-a6": {
      "adapter": "openai-chat",
      "authMode": "key",
      "baseUrl": "https://api.a6api.com/v1",
      "apiKey": "${A6API_API_KEY}"
    }
  }
}
```

配額探測僅向標準 A6API 主機發送現用金鑰並拒絕重新導向。格式錯誤、負數或內部不一致的計費總額不產生報告，而非誤導的條。

### 多個 API 金鑰

基於金鑰的供應商也可以儲存多個 key。透過 Providers 頁面新增金鑰時，它會存入
`provider.apiKeyPool`、被設為 active，並同步到 `provider.apiKey`，這樣路由和 adapter 仍讀取原來的
欄位。同一個下拉選單可以切換或移除金鑰；管理 API 是 `/api/providers/keys`，並且只回傳脫敏後的金鑰。

### 從終端切換帳號

無需開啟儀表板，即可使用 `ocx account list`、`ocx account current` 和 `ocx account use` 檢視或
切換同一組 Codex、OAuth 和 API-key pool。完整命令、JSON 輸出和新 session 生效規則請參閱
[CLI 參考](/zh-tw/reference/cli/#ocx-account-subcommand)。

### GPT-5.6 預覽路徑

GPT-5.6 Sol/Terra/Luna 會預置在供應商的回退列表中，因此即使即時模型目錄暫時滯後，`ocx sync`
也能繼續顯示這些模型。

| Codex 路由 | 預置模型 id | Codex 中顯示的上下文 |
| --- | --- | --- |
| Codex 登入（Pool 或 Direct） | `gpt-5.6-*` | 372,000 |
| OpenAI (API key) | `openai-apikey/gpt-5.6-*` 和 `*-pro` | 1,050,000（max input 922,000） |
| OpenRouter | `openrouter/openai/gpt-5.6-sol`、`openrouter/openai/gpt-5.6-terra`、`openrouter/openai/gpt-5.6-luna` | 1,050,000 |
| Cursor | `cursor/gpt-5.6-sol`、`cursor/gpt-5.6-terra`、`cursor/gpt-5.6-luna` | 1,000,000 |

原生 GPT-5.6 條目保留固定的上游 reasoning 檔位，例如 Luna 有 `max`，但沒有 `ultra`。路由條目
則使用各供應商的後設資料和 reasoning 對映。四條路徑最終都受上游帳號權限限制；Cursor 還會根據即時
發現結果，僅保留目前帳號可用的模型。

:::note[gateway 與訂閱 proxy]
是否支援某個供應商，取決於 opencodex 是否有匹配的 wire adapter，而**不取決於**它是否屬於
“agent”產品。目前 adapter id 包括 `openai-chat`、`openai-responses`、`anthropic`、`google`
（AI Studio、Vertex、Antigravity/Cloud Code Assist 模式）、`azure` / `azure-openai`、`kiro` 和
`cursor`。原生 Amazon Bedrock 這類無法匹配上述實作的專有 API 暫不直接支援。**GitHub Copilot** 和
**GitLab Duo** 是多模型 gateway，對映到各自的通用 OpenAI 相容端點。Copilot 支援透過
`ocx login github-copilot` 使用 GitHub 裝置流 OAuth 登入（非官方橋接 — 使用 VS Code 公開用戶端 id
登入後換取短期 Copilot API 權杖，需要有效的 Copilot 訂閱，GitHub 政策收緊時可能失效）；GitLab Duo
使用 Bearer **訂閱權杖**（而非普通 API 金鑰）進行認證。
**Cloudflare AI Gateway** 需要將 account 和 gateway id 填入 URL。

Cursor 作為單獨的實驗性 adapter 進行跟蹤。`adapter: "cursor"` 會作為實驗性本機設定出現在
`ocx init` 和 dashboard Add Provider picker 中，並儲存 Cursor 的靜態回退模型目錄 metadata。設定
Cursor access token 後，opencodex 會使用 Cursor live HTTP/2 transport。回退列表包含上下文為
1M 的 `gpt-5.6-sol` / `terra` / `luna`，以及上下文為 500K 的
`grok-4.5` / `grok-4.5-fast`；最終顯示哪些模型由帳號的即時發現結果決定。Cursor 伺服器直接發起的
native read/write/delete/ls/grep/shell/fetch 執行預設停用，因為它會繞過 Codex 的 approval 和
sandbox 路徑；只有在可信本機實驗中，才應在 `~/.opencodex/config.json` 的 `providers.cursor`
物件上設定 `unsafeAllowNativeLocalExec: true`，也可以在儀表板的 **Providers → Cursor → Edit JSON**
中設定。完整示例參見 [設定參考](/zh-tw/reference/configuration/#cursor-provider-adapter-cursor)。MCP、螢幕錄製和 computer-use
透過 executor hook 暴露；沒有設定本機 executor 時，opencodex 會回傳 typed no-executor 結果。
Cursor OAuth 和 live model discovery 已在這個實驗性 adapter 中啟用；Cursor 仍不會出現在 key-login
列表中。
:::

### Ollama Cloud

Ollama Cloud 是託管（而非本機）的 Ollama，在 `https://ollama.com/v1` 上相容 OpenAI，金鑰來自 [ollama.com/settings/keys](https://ollama.com/settings/keys)。opencodex 按視覺能力對其雲端陣容進行分類，使 [vision sidecar](/zh-tw/guides/sidecars/) 僅對純文字模型生效。純文字模型（例如 `glm-5.2`、`deepseek-v4-pro`、`gpt-oss`、`qwen3-coder`、`minimax-m2.x`、`nemotron-3-*`）列在 `noVisionModels` 中；原生支援視覺的模型（例如 `kimi-k2.6`、`minimax-m3`、`gemma4`、`qwen3.5`、`gemini-3-flash-preview`）則不在其中。匹配能容忍 Ollama 的 `:size` 標籤，因此 `gpt-oss` 涵蓋 `gpt-oss:120b` 和 `gpt-oss:20b`。

## 4. 本機供應商

讓 opencodex 指向本機的 OpenAI 相容伺服器——通常使用空金鑰：

| 供應商 | 基礎 URL |
| --- | --- |
| Ollama (local) | `http://localhost:11434/v1` |
| vLLM | `http://localhost:8000/v1` |
| LM Studio | `http://localhost:1234/v1` |

## 任意 OpenAI 相容端點

如果某個供應商使用 Chat Completions，`openai-chat` adapter 即可處理它——在儀表板中選擇 **Custom**，或在 `ocx init` 中選擇 `custom` 並輸入基礎 URL。每個供應商欄位（`headers`、`noReasoningModels`、`noVisionModels`、`models`……）請參見 [設定參考](/zh-tw/reference/configuration/)。

## Providers 總覽的速率限制

Providers 總覽的 **Rate limits**（速率限制）區段在存在時，顯示從每個供應商自身的使用量／計費端點重新整理的即時使用量條。這些條顯示一個視窗（5 小時、週、月或供應商專屬）中已消耗的量。

具有即時探測的供應商：OpenAI/Codex、Anthropic、xAI、Cursor、Kimi、Google Antigravity、OpenRouter、DeepSeek、ClinePass、Z.AI、MiniMax、Moonshot、Venice、Synthetic、DeepInfra、Neuralwatt，以及任何 a6api 支援的自訂供應商。
