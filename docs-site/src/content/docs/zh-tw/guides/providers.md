---
title: 供應商
description: opencodex 進行身分驗證並與 LLM 供應商通訊的所有方式——OAuth、API 金鑰、ChatGPT 轉送與本機。
---

**供應商（provider）** 是一個上游 LLM 端點，加上存取它的方式：adapter、base URL、認證模式，以及
可選的模型列表。供應商設定放在 `~/.opencodex/config.json` 的 `providers` 下。

## OpenAI 帳號模式

| Provider id | 用途 | 憑證／帳號規則 |
| --- | --- | --- |
| `openai` | Codex 登入 | Pool（預設）選擇主帳號與新增帳號；Direct 只使用目前 caller／主登入。 |
| `openai-apikey` | OpenAI API | 只使用已設定的 API key／key pool；絕不讀取 Codex 帳號。 |

在 Providers 頁面使用裸 `gpt-5.6-sol` 搭配 Pool／Direct 選項，或使用
`openai-apikey/gpt-5.6-sol` 走 API。憑證路徑不會彼此 fallback。API 路徑發布的 metadata 為
922,000 context／922,000 max input；`sol-pro`、`terra-pro` 與 `luna-pro` virtual id 會保留使用者
選到的公開 identity，但 wire 會改用 base model 加上 `reasoning.mode: "pro"`。

若內建 `openai` 供應商缺失或已停用，儀表板 Accounts picker 與 Codex Auth 頁面可以恢復它：缺失的 row
會從 canonical preset 建立；已停用的 canonical row 會重新啟用，但不替換已儲存的 mode 或 model 設定；
非 canonical 的 `openai` row 不會提供這條恢復路徑。

### Providers 總覽的池容量

對 Codex 登入的 Pool 模式，Providers 總覽會顯示依設定權重估算的**池已使用容量**，而不是把任一帳號
當成 provider 總量。同一列也會顯示目前有效帳號的原始配額百分比，讓你能區分 pool estimate 與新請求
實際會使用的帳號。

當 reset 資訊可用時，總覽會顯示下一次重置時間，以及預期可恢復的容量，格式為
`+N% pool capacity`。**Incomplete coverage**（不完整覆蓋）代表至少一個 pool 帳號無法安全納入估算，
例如 plan 或 quota 未知、讀值已過期、帳號暫停，或需要重新認證。

**Partial window coverage**（部分視窗覆蓋）警告表示部分納入的帳號只回報了一個 quota window，卻缺少
另一個。總覽會把這些 window 分開，並將受影響的 window 標示為不完整，而不是把缺少的讀值當成該
window 的用量。

此估算僅供顯示，不會改變帳號選擇、session affinity、自動切換、cooldown 或其他路由決策。個別帳號
狀態與路由控制請使用 [Codex Auth 帳號池](/zh-tw/guides/web-dashboard/#codex-auth-and-account-pools)。

shipped v1 設定會自動遷移到 marker 2 的 option-aware row。原始設定只會備份一次到
`~/.opencodex/config.json.pre-openai-tiers-v2.bak`；可用下列命令恢復：
`cp ~/.opencodex/config.json.pre-openai-tiers-v2.bak ~/.opencodex/config.json`。

## 認證模式

provider 設定接受三種 `authMode`，其中 `key` 是預設值。內建 registry 也會另外標示 local preset；這些
preset 通常同時省略 `authMode` 與 `apiKey`。

| `authMode` | 認證方式 | 使用方 |
| --- | --- | --- |
| `key` | 傳送 API 金鑰（`Authorization: Bearer …`，或依 adapter 使用 `x-api-key` / `api-key`）。金鑰可以是字面值，也可以是 `${ENV_VAR}` 引用。 | 大多數供應商。 |
| `forward` | 只轉送允許清單中的 incoming Codex 認證標頭，不儲存任何金鑰。這是 ChatGPT 登入的 passthrough。 | OpenAI（`openai-responses` adapter）。 |
| `oauth` | 讀取已儲存的 OAuth access token（到期前自動 refresh），並把它當成 bearer key 使用。 | xAI、Anthropic、Kimi、Kiro、Google Antigravity、Cursor、Command Code、GitHub Copilot、Nous Portal。 |

[`retryOn429`](/zh-tw/reference/configuration/) 的 same-key 429 replay 只適用於 API-key provider
（`authMode: "key"`）。OAuth、forward 與 local preset 都被排除：它們的 credential 絕不能在同一 token
上重播，而 local runtime 也沒有 remote key 可保留。此功能為 opt-in；未設定時關閉，物件存在時預設
啟用，除非明確設為 `enabled: false`。

## 1. ChatGPT 登入（forward / passthrough）

`openai` provider **不需要 API 金鑰**。Direct 直接轉送既有 `codex login` 的 credential；Pool 則先解析
主帳號或新增的 Codex 帳號，再使用相同 backend：

```json
{
  "openai": {
    "adapter": "openai-responses",
    "baseUrl": "https://chatgpt.com/backend-api/codex",
    "authMode": "forward"
  }
}
```

只會轉送經過篩選的標頭集合（`FORWARD_HEADERS`：authorization、ChatGPT account id、OpenAI
beta/originator/session，詳見 [轉接器](/zh-tw/reference/adapters/)）。這條路徑也支援
[web-search 與 vision sidecar](/zh-tw/guides/sidecars/)。

ChatGPT passthrough catalog 也會加入 GPT-5.6 Sol/Terra/Luna 的裸 slug：`gpt-5.6-sol`、
`gpt-5.6-terra`、`gpt-5.6-luna`；帳號具備權限時才能實際使用。

## 2. 帳號登入（OAuth）

有八個 provider preset 使用 OAuth 登入，另加透過實驗性非官方 device-flow bridge 的 GitHub Copilot。
opencodex 會把 credential 存在 `~/.opencodex/auth.json` 並自動 refresh。登入 CLI 也接受 `chatgpt`；
它會取得 ChatGPT credential，同時建立 `forward` 模式的 provider 條目。

```bash
ocx login xai          # xAI Grok
ocx login anthropic    # Anthropic Claude (Pro/Max)
ocx login kimi         # Moonshot Kimi
ocx login nous         # Nous Portal（device grant；免費 + 付費模型）
ocx login kiro         # 匯入 kiro-cli credential（或 token fallback）
ocx login google-antigravity
ocx login cursor       # 獨立 Cursor PKCE 登入
ocx login command-code # Command Code browser OAuth（或匯入 ~/.commandcode/auth.json）
ocx login github-copilot  # GitHub device flow → Copilot token（Copilot Pro/Business）
ocx login chatgpt      # 獨立 ChatGPT OAuth 登入
ocx logout <provider>
```

| 供應商 | Adapter | Base URL | 備註 |
| --- | --- | --- | --- |
| `xai` | `openai-chat` | `https://cli-chat-proxy.grok.com/v1` | OAuth 使用獨立的 Grok CLI 訂閱 gateway。API key 覆寫使用 `https://api.x.ai/v1`，並可能注入 Priority Processing。優先使用即時 Grok catalog；fallback 預設為 `grok-4.5`。 |
| `anthropic` | `anthropic` | `https://api.anthropic.com` | Claude 模型；即時模型列表從 `/v1/models` 取得。 |
| `kimi` | `openai-chat` | `https://api.kimi.com/coding/v1` | Kimi K2.7/K2.6/K2.5 coding 模型。 |
| `nous` | `openai-chat` | `https://inference-api.nousresearch.com/v1` | Nous Research 訂閱 gateway（Hermes Agent 使用相同 backend）。透過 `portal.nousresearch.com` 做 device-grant 登入；access token 是每次請求使用的 inference JWT。混合付費與 `:free` 模型 catalog（`tencent/hy3:free`、`stepfun/step-3.7-flash:free` 等）會從已登入帳號即時探索。Refresh token 為單次使用，每次 refresh 都會輪換。 |
| `kiro` | `kiro` | `https://runtime.us-east-1.kiro.dev` | 初次登入會匯入已安裝且已登入的 `kiro-cli` session。Unix 可用 `curl -fsSL https://cli.kiro.dev/install` &#124; `bash` 安裝；Windows PowerShell 使用 `irm 'https://cli.kiro.dev/install.ps1'` &#124; `iex`，再執行 `kiro-cli login`。**Add account** 會先登出 `kiro-cli`、啟動新的 browser login，切換 `kiro-cli` 所使用的帳號並保存 account-scoped profile metadata。既有 OpenCodex 帳號會保留；取消或失敗時會恢復先前的 `kiro-cli` session。 |
| `google-antigravity` | `google` | `https://daily-cloudcode-pa.googleapis.com` | 透過 Cloud Code Assist wire 使用 Google OAuth。即時探索使用 CCA 經認證的 `v1internal:fetchAvailableModels` 端點，發布目前登入帳號可用的 agent 模型；維護中的 catalog 作為 fallback。 |
| `cursor` | `cursor` | `https://api2.cursor.sh` | 實驗性 PKCE 登入、即時 HTTP/2 transport 與按帳號篩選的模型探索。 |
| `github-copilot` | `openai-chat` | `https://api.githubcopilot.com` | 實驗性。GitHub device flow + `copilot_internal` exchange（VS Code OAuth client）。需要有效 Copilot 訂閱；不是官方第三方 API。 |

終端 Nous refresh 失敗後，執行 `ocx login nous` 重新認證。

對 canonical Kimi Coding Plan preset（`kimi` 帳號登入與 `kimi-code` API key），opencodex 只會把 caller
提供且穩定的 `prompt_cache_key` 轉送到 Chat Completions 請求，絕不自行產生。Kimi 文件指出，穩定的
session／task key 有助提升 Code Plan cache hit rate；沒有 key 的請求仍保持 keyless。若已 opt-in 的上游
拒絕此欄位，opencodex 不會移除欄位後重試，也不會修改已儲存設定。其他 provider 預設 deny-by-default。

也可以從 [web 儀表板](/zh-tw/guides/web-dashboard/) 啟動 OAuth。

### 多個 OAuth 帳號

credential 內含穩定 account id 或 email 的 OAuth provider 可以保存多個登入。Providers 頁面會在下拉
選單顯示這些帳號、允許新增帳號，並在不登出其他帳號的情況下切換目前帳號。一般登入時，沒有 identity 的
Kimi credential 會取代 active slot；明確的 **新增帳號** 會保留原有 slot 並啟用另一個新 slot。Kiro 帳號以
profile ARN 作為 key。`chatgpt` 始終是 single-slot，因為
Codex pool 帳號使用獨立 ledger。Token 仍存放在 `~/.opencodex/auth.json`；`/api/oauth/accounts` 只回傳
遮蔽後的 metadata。

### Cockpit Tools Antigravity 匯入

目前 v1 只會為 `google-antigravity` provider 匯入 **Cockpit Tools Antigravity** JSON export。在 Providers
儀表板中，從該 provider 的 Accounts 分頁選擇本機 JSON 檔案。儀表板不會顯示檔案內容或 credential
值，只會回報 imported、updated、failed 與 unsupported 數量。其他 Cockpit provider 在 v1 會被拒絕。

CLI 只接受來自檔案或標準輸入的 export，絕不要直接貼進 command argument：

```bash
ocx account import google-antigravity --format cockpit-tools --file <path> [--json]
cat accounts.json | ocx account import google-antigravity --format cockpit-tools --stdin [--json]
```

inline JSON 與額外 positional argument 都會被拒絕。請將 export 檔案保持私密，匯入後安全刪除或妥善
保存。

### OAuth 可靠度

opencodex 協調 token refresh 與 Codex pool 路由，避免並行請求競爭 credential store。這是可靠度與診斷
工作，**不**代表能繞過 provider enforcement、rate limit 或帳號動作。

**Refresh 協調。** 路由呼叫前，過期的 access token 每個 `(provider, account)` 只 refresh 一次：

1. In-process single-flight：並行 caller 共用同一個 refresh promise。
2. Per-account file lock：跨 process writer 在同一帳號上序列化。
3. Generation CAS：只有已儲存 credential generation 仍相符時才持久化；較新的 writer 勝出，舊的
   refresh result 不能覆寫它。

終端 refresh 失敗會把帳號標示為需要重新認證，而不是無限重試。

**Cooldown（Codex pool）。** 上游 `429`／quota response 會依 `Retry-After`、quota `reset` header
（有上限）或短預設 backoff 設定 hard cooldown。明確 `Retry-After` cooldown 中的帳號不會被提前 probe；
reset 衍生 cooldown 可能取得節流後的 probe lease，在不淹沒 provider 的情況下偵測恢復。由 reset 衍生的
native-model cooldown 也會保留已知獨立 quota group：`gpt-5.3-codex-spark` 不會阻止同一帳號嘗試共享的
GPT-5.6 Terra/Luna quota，而共享群組內的模型仍會互相保護。明確 `Retry-After` 與預設 cooldown 始終為
account-wide。

**Session affinity。** Codex thread→account affinity 只存在目前 process 記憶體，不會跨 proxy restart
持久化。credential 失敗（`401`／`403`）時，帳號會被 quarantine 等待 reauth，並清除該帳號的 affinity。
收到 `429` 時，帳號進入 cooldown、affinity 被清除，pool selection 可以輪換；thread 不會在 rate-limit
response 後仍被固定在同一帳號。

**Codex client metadata。** ChatGPT forward 路徑會轉送經篩選的 `FORWARD_HEADERS` allowlist
（authorization、`chatgpt-account-id`、originator、session/thread id 與其他相關 Codex header，詳見
[轉接器](/zh-tw/reference/adapters/)）。Pool 模式只覆寫 auth 與 `chatgpt-account-id`，讓它們符合選中的
credential。caller 沒有送出時，opencodex **不會**捏造官方 client identity，例如 `originator`、session
或 thread header。

**診斷與重新認證。** 一般 `ocx status` 會印出 OAuth health 區塊，只顯示遮蔽後 account id，不含 token。
`ocx doctor` 會新增 OAuth reliability 區段，包含 writable-store／single-flight check，以及帶 recovery
Action 的 WARN row。OAuth provider 帳號需要重新認證時，執行 `ocx login <provider>`，或在儀表板使用
Reauthenticate。Codex pool 帳號不是 `ocx login` provider，請透過儀表板 Codex account pool 重新認證。
相關命令請參見 CLI 參考的 [`ocx status` / `ocx doctor`](/zh-tw/reference/cli/)。

### Kiro credential 匯入

Kiro 登入預期存在 Kiro CLI。Unix 可用 `curl -fsSL https://cli.kiro.dev/install | bash` 安裝；Windows
PowerShell 使用 `irm 'https://cli.kiro.dev/install.ps1' | iex`；接著以 `kiro-cli login` 登入。若沒有
`kiro-cli` session，`ocx login kiro` 會 fallback 到貼上的 access token 或 `KIRO_ACCESS_TOKEN` 環境變數。

`ocx login kiro` 匯入流程會搜尋各平台的 Kiro CLI store，並以唯讀模式開啟 SQLite database。兩個環境
變數可明確指定來源與 token row：

- `KIROCLI_DB_PATH` 指定非標準 Kiro CLI SQLite database。路徑必須已存在；此匯入流程不會建立或修改
  database、WAL 或 SHM 檔案。
- `KIROCLI_TOKEN_KEY` 在 database 有多個 otherwise ambiguous token row 時，指定精確的 `auth_kv`
  token key。未指定時會讓登入失敗，而不是猜測。

Windows 匯入會尋找 `%LOCALAPPDATA%\Kiro-Cli\data.sqlite3`。forced／add-account login 也需要本機 CLI
binary：opencodex 先使用 `PATH`，再 fallback 到 `%LOCALAPPDATA%\Kiro-Cli\kiro-cli.exe` 與
`C:\Program Files\Kiro-Cli\kiro-cli.exe`。

成功匯入後，opencodex 會把 credential 寫入 `~/.opencodex/auth.json`。

請將這些變數與所選 database 保持私密。不要把 database 檔案或原始登入診斷附在 bug report。

**Add account** 是獨立的寫入流程：它會 snapshot 目前 session、登出 `kiro-cli`，再匯入新的 browser
login。若登入取消或失敗，包括 OpenCodex 持久化 credential 期間失敗，rollback 會先替換 Kiro CLI
database 並移除目前的 WAL、SHM 與 journal sidecar，再發布先前的 session snapshot。

由於 rollback 只能依賴 snapshot，若 session store 存在卻無法擷取，例如檔案不可讀、schema 不符或 token
選擇有歧義，**Add account** 會拒絕登出 `kiro-cli`。當 `KIROCLI_DB_PATH`／`KIRO_CLI_DB_FILE` 將匯入
讀取重導到 live CLI store 之外，或既有主 CLI database 沒有可識別 token row 時，也會拒絕。請在一般
`kiro-cli` data path 修復或移除不可讀 database、取消這些 import selector 後重試。沒有既有
`kiro-cli` session 的新機器登入不受影響。

## 3. API 金鑰目錄

opencodex 內建 79 個 preset：67 個 key-based、8 個 OAuth、3 個 local，以及 1 個預設 ChatGPT-forward
preset。儀表板的 **Add provider** picker 會開啟 key provider 的 dashboard、驗證金鑰並儲存；驗證方式
依 provider 而異。主要條目如下。

**ClinePass** 使用 Cline API key，搭配[官方訂閱 catalog](https://docs.cline.bot/getting-started/clinepass)
與 [Chat Completions endpoint](https://docs.cline.bot/api/chat-completions)，由 Cline Bot Inc. 依
[Cline terms](https://cline.bot/tos) 提供。像 `cline-pass/cline-pass/kimi-k3` 這類 routed id 是刻意設計：
第一段選擇 opencodex provider，後面的 `cline-pass/kimi-k3` 才是送往上游的完整 model slug。ClinePass
quota 由帳號共用，包含 rolling 5-hour、weekly 與 monthly limit。2026-08-13 的 live probe 已確認所有
靜態 ClinePass model 在 gateway input 都接受 `low`、`medium`、`high`、`xhigh` 與 `max`。符合 registry
transport 的 canonical ClinePass 設定會保留 requested tier；同名 custom provider 則保留明確設定的
reasoning configuration。backend-specific normalization 由 ClinePass 負責。

**Cline** 使用相同 API key 與 endpoint，但採 pay-as-you-go 用量計費，可使用 100+ 模型，包括
OpenRouter 風格 id，例如 `anthropic/claude-sonnet-4-6`。Cline 的 promotional free model 只提供給 Cline
IDE／CLI，不透過 API；`minimax/minimax-m2.5` 是文件列出的 API 免費實驗模型。

| 供應商 | Base URL |
| --- | --- |
| **OpenAI (API key)** | `https://api.openai.com/v1` |
| **Anthropic (API key)** | `https://api.anthropic.com` |
| **OpenRouter** | `https://openrouter.ai/api/v1` |
| **Cline** | `https://api.cline.bot/api/v1` |
| **ClinePass** | `https://api.cline.bot/api/v1` |
| **Ollama Cloud** | `https://ollama.com/v1` |
| Google Gemini · Google Vertex AI | `https://generativelanguage.googleapis.com` · `https://aiplatform.googleapis.com` |
| Azure OpenAI | `https://{resource}.openai.azure.com/openai` |
| Umans AI · Neuralwatt | `https://api.code.umans.ai` · `https://api.neuralwatt.com/v1` |
| Mistral | `https://api.mistral.ai/v1` |
| MiniMax · MiniMax (CN) | `https://api.minimax.io/v1` · `https://api.minimaxi.com/v1` |
| DeepSeek | `https://api.deepseek.com` |
| Cerebras | `https://api.cerebras.ai/v1` |
| Chutes | `https://llm.chutes.ai/v1` |
| DeepInfra | `https://api.deepinfra.com/v1/openai` |
| Hyperbolic | `https://api.hyperbolic.xyz/v1` |
| Nscale Serverless Inference | `https://inference.api.nscale.com/v1` |
| Vultr Serverless Inference | `https://api.vultrinference.com/v1` |
| Baseten Model APIs | `https://inference.baseten.co/v1` |
| Command Code | `https://api.commandcode.ai/provider/v1` |
| SambaNova Cloud | `https://api.sambanova.ai/v1` |
| Nebius Token Factory | `https://api.tokenfactory.nebius.com/v1` |
| DigitalOcean Serverless Inference | `https://inference.do-ai.run/v1` |
| Scaleway Generative APIs | `https://api.scaleway.ai/v1` |
| Featherless AI | `https://api.featherless.ai/v1` |
| Novita AI | `https://api.novita.ai/openai/v1` |
| Together | `https://api.together.xyz/v1` |
| Fireworks | `https://api.fireworks.ai/inference/v1` |
| Moonshot (Kimi API) · Kimi (coding) | `https://api.moonshot.ai/v1` · `https://api.kimi.com/coding/v1` |
| Hugging Face | `https://router.huggingface.co/v1` |
| NVIDIA NIM | `https://integrate.api.nvidia.com/v1` |
| Z.AI (GLM Coding) | `https://api.z.ai/api/coding/paas/v4` |
| Zhipu AI (BigModel) | `https://open.bigmodel.cn/api/paas/v4` |
| Qwen Cloud | Token plan（預設）：`https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` · pay as you go：`https://dashscope.aliyuncs.com/compatible-mode/v1` · 或 Custom |
| Tencent Cloud Coding Plan | `https://api.lkeap.cloud.tencent.com/coding/v3` |
| SiliconFlow | `https://api.siliconflow.cn/v1` |
| Volcengine Ark · Coding Plan · Agent Plan | `https://ark.cn-beijing.volces.com/api/v3` · `https://ark.cn-beijing.volces.com/api/coding/v3` · `https://ark.cn-beijing.volces.com/api/plan/v3` |
| Xiaomi MiMo | `https://api.xiaomimimo.com/anthropic` |
| Xiaomi MiMo (OpenAI Chat) | `https://api.xiaomimimo.com/v1` |
| Kilo | `https://api.kilo.ai/api/gateway` |
| GitLab Duo | `https://cloud.gitlab.com/ai/v1/proxy/openai/v1` |
| Cloudflare AI Gateway | `https://gateway.ai.cloudflare.com/v1/{account-id}/{gateway}/anthropic` |
| …以及更多 | opencode zen、Vercel AI Gateway、Venice、NanoGPT、Synthetic、Qianfan、Alibaba、Parallel、ZenMux、LiteLLM |

**OpenCode Zen**（`opencode-zen`）與無 key 的 **OpenCode Free** preset 共用
`https://opencode.ai/zen/v1`。該 gateway 的免費模型常遇到短時間 burst limit，約 15–20 requests/minute
（社群實測；OpenCode 未公布 RPM）。Zen 可能回傳 generic rate-limit 429，而沒有 `Retry-After`／
`X-RateLimit-*` header。這與 OpenCode 宣告的 keyless desktop quota 是不同限制：`opencode-free` 約每 5
小時 200 次 Big Pickle／free-model request。Zen 在這類 429 省略 `Retry-After` 時，opencodex 會在 client
error 加入 provider guidance 與 synthetic `Retry-After`；若上游有 `Retry-After`，仍以上游值為準。
same-key wait-and-retry 仍需透過 [`retryOn429`](/zh-tw/reference/configuration/) 明確 opt-in。

大多數 provider 使用帶 bearer key 的 `openai-chat` adapter；少數只提供 Anthropic-compatible endpoint 的
provider，例如 **Xiaomi MiMo**，使用 `anthropic` adapter（`x-api-key`）。Volcengine Agent Plan 透過
`openai-responses` 使用原生 Responses endpoint。內建 DeepSeek preset 也會把 `deepseek-v4-flash` 路由到
原生 Responses endpoint，並保持上游 SSE streaming。若該模型完成所有 output item 卻省略最後的
Responses event，opencodex 會套用 5 秒、model-scoped 的 grace repair；malformed 或 partial stream 會以
incomplete 關閉，不會被誤報為成功。

> **三條 Volcengine 計費路徑：** `volcengine` 是 pay-as-you-go Ark API，
> `volcengine-coding-plan` 消耗 Coding Plan quota，`volcengine-agent-plan` 消耗 Agent Plan quota。請使用
> 同一產品發出的 key 與 endpoint；即使已有 Plan 訂閱，普通 `/api/v3` endpoint 仍可能產生
> pay-as-you-go 費用。preset 使用 curated static model catalog，因為 Ark `/models` 也包含 embedding、
> image、video 與 3D resource，Coding gateway 會回傳相同 broad catalog，而 Agent Plan gateway 沒有
> `/models` resource。Pay-as-you-go 預設 `doubao-seed-2-1-pro-260628`，curated catalog 也包含目前的
> DeepSeek 與 GLM text model。Coding Plan 預設 `ark-code-latest`；Agent Plan 預設 `deepseek-v4-pro`。

> **Volcengine Plan 使用限制：** Volcengine 文件指出 Coding Plan 與 Agent Plan quota 只能在受支援的
> AI coding tool 內使用，並警告把 plan key 用於一般 API call 可能導致訂閱停權或帳號封鎖。透過
> opencodex 路由 Codex 或 Claude Code 屬於文件所述用途；不要把 plan key 指向其他 automation。
> pay-as-you-go 的 `volcengine` 路徑沒有此限制。

**Chutes 探索。** `chutes` preset 使用 Chutes 固定、共用的 OpenAI-compatible LLM gateway。它讀取公開的
`/v1/models` catalog，只保留 `supported_features` 宣告 `tools` 的 row，保留含 `/` 的 model id 與安全
live metadata，並把 discovery 限制在 256 KiB／128 個 raw row。因 catalog 是公開的，不能用成功讀取來
證明提供的 key 有效；chat request 仍使用設定的 Bearer key。使用者自行部署的 custom Chute host 與
Chutes 非 LLM API 仍屬於 custom-provider 範圍。可從 [Chutes dashboard](https://chutes.ai/auth/start) 建立
key。

**DeepInfra 探索。** key-based `deepinfra` OpenAI Chat Completions provider 使用 `openai-chat` adapter 與
Bearer API key。registry 管理的 model-list URL 只保留標為 `chat` 的 row，保留含 `/` 的原生 model id，
並把 live discovery 限制在 512 KiB／512 個 raw row。可在
[DeepInfra dashboard](https://deepinfra.com/dash/api_keys) 建立 key。

**Hyperbolic 探索。** preset 會用設定的 bearer key 讀取 `/v1/models`，保留含 `/` 的原生 model id，
並把 discovery 限制在 256 KiB／256 個 raw row。範圍只涵蓋 serverless text 與 vision-language chat；
Hyperbolic 另外的 image、audio 與 GPU endpoint 不在範圍內。可在
[Hyperbolic](https://app.hyperbolic.ai) 建立 key。

**Nscale 與 Vultr 探索。** 兩個 preset 都讀取 provider 經認證的 `/v1/models` catalog、保留原生 id，並
把 discovery 限制在 256 KiB／256 個 raw row。Nscale catalog 混合 chat、image 與 embedding model，卻
沒有 modality 欄位，因此 preset 只允許 `meta-llama/Llama-3.1-8B-Instruct`，也就是 Nscale 官方
工具呼叫 API 範例使用的模型。Vultr 目前只為 `kimi-k2-instruct` 文件化 tool calling，因此 preset 只
暴露該模型。其他 row 在 provider 發布同等 agent-tool evidence 前保持隱藏。Nscale service token 可在
[Nscale Console](https://console.nscale.com) 建立；Vultr inference key 可從
[Vultr Console](https://my.vultr.com) 的 subscription overview 複製。

**Command Code 探索。** preset 從固定 Provider API host 讀取 Command Code 的 `/provider/v1/models`
列表，保留 provider-native id，並把 discovery 限制在 256 KiB／256 個 raw row。
`ocx login command-code` 支援 browser sign-in OAuth；既有 Command Code CLI 使用者也可選擇從
`~/.commandcode/auth.json` 匯入本機 CLI credential。模型 catalog 依帳號而定，登入後從經認證的 discovery
endpoint 取得。Chat request 使用設定的 Bearer key。可在
[Command Code Studio](https://commandcode.ai/studio/) 建立 key。

**Command Code 配額。** 儀表板與 `ocx account refresh` 會在正規主機 `https://api.commandcode.ai` 探測 `/alpha/billing/credits` 視窗（5 小時與每週）。OAuth preset (`command-code`) 使用已儲存的帳號 bearer；Provider-API key preset (`commandcode`) 使用目前設定的有效 key。使用者改寫過的仿冒 base URL 不會被探測。當 Command Code 同時回報週期消耗時，剩餘的 monthly / purchased / free credits 會顯示為 USD 視窗。

**SambaNova Cloud 探索。** preset 從固定 API host 讀取 SambaNova Cloud 公開的 `/v1/models` 列表，保留
provider-native id，並把 discovery 限制在 128 KiB／128 個 raw row。因 catalog 不需要認證，CLI login
流程會把 key 回報為 unverifiable，而不會把公開 response 當成有效 key 的證明。Chat request 仍使用
設定的 Bearer key，並停用 parallel function call，因 SambaNova 尚未支援。Private SambaStudio deployment
endpoint 不在範圍內。可在 [SambaNova Cloud](https://cloud.sambanova.ai/apis) 建立 key。

**Nebius Token Factory 探索。** preset 請求經認證的 verbose model catalog，只保留 architecture 會輸出
text 的 row，排除 embedding 與 image-generation model。它保留含 `/` 的原生 id，以及回報的 context／
input-modality metadata，並把 discovery 限制在 512 KiB／512 個 raw row。Dedicated deployment host 不在
範圍內。可在 [Nebius Token Factory](https://tokenfactory.nebius.com) 建立 key。

**DigitalOcean 探索。** preset 以 model access key 存取固定的 shared Serverless Inference host，並把經
認證的 `/v1/models` response 與 DigitalOcean 文件支持的 Chat Completions allowlist 取交集。未知、
Responses-only、embedding 與 media-generation id 都 fail closed。discovery 限制在 256 KiB／256 個 raw
row；agent-specific 與 dedicated host 不在範圍內。可在
[DigitalOcean Control Panel](https://cloud.digitalocean.com/model-studio/manage-keys) 建立 key。

**Scaleway 探索。** preset 把經認證的模型列表與 Scaleway 文件化的 Serverless Chat Completions
allowlist 取交集。未知、Responses-only、embedding、transcription 與其他 media model id 都 fail
closed；discovery 限制在 128 KiB／128 個 raw row。它使用 default Project 的 shared endpoint；
project-qualified URL 與 dedicated deployment 需要 custom provider。可在
[Scaleway console](https://console.scaleway.com/generative-api) 建立 API key。

**Featherless 探索。** preset 對固定 OpenAI-compatible host 認證，並讓上游只回傳前 100 個 popular、
已篩選為 chat 且符合目前 plan 的模型。registry 規則再進一步 fail closed，要求每一 row 都獨立回報 plan
availability、沒有 Hugging Face gate，且 `features.tool_use: true`。discovery 限制在 128 KiB／100 個 raw
row，因此不會下載或快取完整的數萬模型 catalog。因 `/v1/models` 文件指出可帶或不帶認證呼叫，成功
讀取不能證明提供的 key 有效；chat request 仍使用設定的 Bearer key。Featherless terms 將 individual
plan 限定於 interactive／prototyping 使用；任意 application 需要 Scale plan。可在
[Featherless dashboard](https://featherless.ai/account/api-keys) 建立 key。

**Novita 探索。** key-based preset 使用 `openai-chat` adapter，只把 Bearer key 傳到 Novita 固定的
OpenAI-compatible host。公開 model list 會篩選為同時回報 `model_type: chat` 與 `chat/completions`
endpoint 的 row，discovery 限制在 512 KiB／256 個 raw row。model id 必須完整保留 Novita 回傳的形式，
包括含 `/` 的 id；路由前不得 normalize 或 rewrite。因 catalog 是公開的，login 會把 key 回報為
unverifiable，而不會把成功取得列表視為有效 key 的證明。模型能力不同，因此 preset 不會宣告
provider-wide parallel tool call 或 OpenAI `reasoning_effort`。可在
[Novita key manager](https://novita.ai/settings/key-management) 建立 key。

> **Baseten 範圍：** preset 只涵蓋 Baseten 共用的
> [Model APIs](https://docs.baseten.co/inference/model-apis/overview)。本機使用請採 personal
> [API key](https://docs.baseten.co/organization/api-keys)；共用／production 使用則採具備 **Call Model
> APIs** 權限的 team key。Dedicated Truss `predict` endpoint 使用不同 host 與 schema，不會被此 preset
> 路由。此 preset 的 live discovery 上限為 1 MiB response／256 個 raw model row。

### A6API 信用額度

使用 `authMode: "key"`，且 base URL 為 canonical `https://api.a6api.com` 或
`https://api.a6api.com/v1` 的 custom `openai-chat` provider，會在 dashboard 與
`ocx account refresh <provider>` 顯示 A6API credit meter。provider 名稱可自訂；偵測依據 canonical HTTPS
endpoint。meter 會使用帳號的 hard credit limit，把 A6API token unit 換算成 USD，並顯示已使用百分比與
剩餘 credit。Token 到期不會顯示為 quota reset，因為到期不代表 credit 會補充。

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

quota probe 只會把 active key 傳送到 canonical A6API host，並拒絕 redirect。格式錯誤、負數或內部不一致
的 billing total 不會產生 report，也不會顯示誤導性的 quota bar。

> **Tencent Cloud Coding Plan 使用限制：** Tencent 文件將此訂閱限定為互動式 coding tool。一般 API
> automation、自訂 application backend 與非互動 batch 使用都被禁止，並可能造成 plan key 被停用。

> **兩條 GLM 路徑：** `zai` 是 Z.AI 國際 Coding Plan 訂閱；`zhipu-bigmodel` 是智譜國內 BigModel
> pay-as-you-go endpoint。兩者 host、key 與 billing 都不同；其中一邊發出的 key 無法在另一邊通過認證。

### 多個 API 金鑰

key-based provider 也能保存多個 key。透過 Providers 頁面新增 key 時，會存到 `provider.apiKeyPool`、
設為 active，並同步到 `provider.apiKey`，讓路由與 adapter 繼續讀取原本欄位。同一個下拉選單可切換或
移除 key；管理 API 為 `/api/providers/keys`，而且只回傳遮蔽後的 key。

### 從終端切換帳號

不必開啟儀表板，即可用 `ocx account list`、`ocx account current` 與 `ocx account use` 檢視或切換
同一組 Codex、OAuth 與 API-key pool。完整 command、JSON output 與新 session 生效規則請參見
[CLI 參考](/zh-tw/reference/cli/#ocx-account-subcommand)。

### GPT-5.6 預覽路徑

GPT-5.6 Sol/Terra/Luna 會預置在 provider fallback list 中，因此即使即時 catalog 暫時落後，
`ocx sync` 仍可維持模型可見。

| Codex 路由 | 預置 model id | Codex 可見 context |
| --- | --- | --- |
| Codex 登入（Pool 或 Direct） | `gpt-5.6-*` | 922,000 |
| OpenAI (API key) | `openai-apikey/gpt-5.6-*` 加 `*-pro` | 922,000（922,000 max input） |
| OpenRouter | `openrouter/openai/gpt-5.6-sol`、`openrouter/openai/gpt-5.6-terra`、`openrouter/openai/gpt-5.6-luna` | 922,000 |
| Cursor | `cursor/gpt-5.6-sol`、`cursor/gpt-5.6-terra`、`cursor/gpt-5.6-luna` | 1,000,000 |

原生 GPT-5.6 條目保留固定的上游 reasoning ladder，例如 Luna 有 `max` 但沒有 `ultra`。路由條目使用各
provider metadata 與 reasoning mapping。四條路徑最終都受上游權限限制；Cursor 即時探索還會把 static
seed 篩到目前帳號真正能使用的模型。

:::note[Gateway 與訂閱 proxy]
是否納入某個 provider，取決於 opencodex 是否有匹配的 wire adapter，**不**取決於它是否是「agent」
產品。目前 adapter id 為 `openai-chat`、`openai-responses`、`anthropic`、`google`（AI Studio、Vertex、
Antigravity／Cloud Code Assist 模式）、`azure` / `azure-openai`、`kiro`、`cursor`。像原生 Amazon Bedrock
這類沒有對應實作的 proprietary API，不會被直接支援。

**GitHub Copilot** 是 OAuth provider（`ocx login github-copilot`），會把 GitHub device-flow login 換成
短效 Copilot API token，不是貼上 API key。**GitLab Duo** 仍是使用 OpenAI-compatible endpoint 的
key／subscription-token gateway。**Cloudflare AI Gateway** 需要在 URL 填入 account 與 gateway id。

Copilot 的 catalog 混合多種 wire：GPT-5 family（`gpt-5.3-codex`、`gpt-5.4`、`gpt-5.4-mini`、
`gpt-5.5`、`gpt-5.6-luna`、`gpt-5.6-sol`、`gpt-5.6-terra`）會拒絕 agent traffic 的
`/chat/completions`，因此 opencodex 會依內建預設把這些模型路由到 Responses API；其他 Copilot 模型
仍使用 chat completions。優先順序為：hard wire pin → 你明確設定的
[`modelAdapters`](/zh-tw/reference/configuration/providers/) → registry default → provider-wide adapter。
若要讓沒有內建 default 的模型，例如 `gpt-5.4-nano`，改走 Responses，可設定
`"modelAdapters": { "gpt-5.4-nano": "openai-responses" }`。

Cursor 另以實驗性 adapter 追蹤。`adapter: "cursor"` 會在 `ocx init` 與 dashboard Add Provider picker
出現為實驗性 local config，並帶 Cursor static fallback model catalog metadata。設定 Cursor access token
後，opencodex 使用 Cursor 即時 HTTP/2 transport。bundled fallback seed 包含 1M context 的
`gpt-5.6-sol`／`terra`／`luna`、500K 的 Grok 4.5/4.6 一般與 Fast 項目，以及 262K 的 `kimi-k3`；即時探索
決定哪些模型對帳號保持可見。Grok 4.6 的兩種形式都提供 `low`／`medium`／`high`／`xhigh`，4.5 則最高到
`high`。Fast 請求會傳送對應的 Grok 基礎模型，並使用獨立的 `effort` 與 `fast=true` `requested_model`
參數；扁平化的 `cursor-grok-{version}-{effort}-fast` id 僅作為探索與 picker 識別。Cursor 的 Kimi K3
只以帶 effort suffix 的 wire id 提供，因此
`cursor/kimi-k3` 暴露 `low`／`high`／`max` ladder，預設為 `max`，符合該模型文件化的 API default。
Cursor server-driven native read/write/delete/ls/grep/shell/fetch execution 預設停用，因為它會繞過 Codex
approval 與 sandbox 路徑；只有可信本機實驗才應在 `~/.opencodex/config.json` 的 `providers.cursor`
物件設定 `unsafeAllowNativeLocalExec: true`，也可以透過儀表板 **Providers → Cursor → Edit JSON** 設定。
完整範例參見[設定參考](/zh-tw/reference/configuration/#cursor-provider-adapter-cursor)。MCP、螢幕錄製與
computer-use 可透過 executor hook 使用；未設定本機 executor 時，opencodex 會回傳 typed no-executor
result，而不是用 policy block request。Cursor OAuth 與即時 model discovery 已為此實驗性 adapter 啟用；
Cursor 仍不會出現在 key-login list。
:::

### Ollama Cloud

Ollama Cloud 是 hosted、不是 local 的 Ollama，在 `https://ollama.com/v1` 提供 OpenAI-compatible API，
key 來自 [ollama.com/settings/keys](https://ollama.com/settings/keys)。opencodex 依 vision capability 分類其
cloud lineup，讓 [vision sidecar](/zh-tw/guides/sidecars/) 只對純文字模型生效。純文字模型，例如
`glm-5.2`、`deepseek-v4-pro`、`gpt-oss`、`qwen3-coder`、`minimax-m2.x`、`nemotron-3-*`，會列在
`noVisionModels`；原生 vision 模型，例如 `kimi-k2.6`、`minimax-m3`、`gemma4`、`qwen3.5`、
`gemini-3-flash-preview`，不會列入。matching 可容忍 Ollama 的 `:size` tag，因此 `gpt-oss` 同時涵蓋
`gpt-oss:120b` 與 `gpt-oss:20b`。

## 4. 本機供應商

讓 opencodex 指向本機 OpenAI-compatible server，通常使用空 key：

| 供應商 | Base URL |
| --- | --- |
| Ollama (local) | `http://localhost:11434/v1` |
| vLLM | `http://localhost:8000/v1` |
| LM Studio | `http://localhost:1234/v1` |

## 任意 OpenAI-compatible endpoint

若 provider 使用 Chat Completions，`openai-chat` adapter 就能處理。可在儀表板選 **Custom**，或在
`ocx init` 選 `custom` 並輸入 base URL。所有 provider 欄位（`headers`、`noReasoningModels`、
`noVisionModels`、`models` 等）請參見[設定參考](/zh-tw/reference/configuration/)。

## Providers 總覽的速率限制

Providers 總覽的 **Rate limits** 區段會在 provider 有使用量／billing endpoint 時，顯示從該 endpoint
refresh 的即時 utilization bar。bar 代表特定 window（5 小時、weekly、monthly 或 provider-specific）
已消耗的比例。

具有 live probe 的 provider：OpenAI/Codex、Anthropic、xAI、Cursor、Kimi、Google Antigravity、
OpenRouter、DeepSeek、ClinePass、Z.AI、MiniMax、Moonshot、Venice、Synthetic、DeepInfra、Neuralwatt，
以及任何由 a6api 支援的 custom provider。
