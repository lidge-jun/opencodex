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

## 認證模式

供應商設定支援三種 `authMode`，預設值為 `key`。內建登入檔還會單獨標記本機預設；這類預設通常會
同時省略 `authMode` 和 `apiKey`。

| `authMode` | 如何進行認證 | 使用方 |
| --- | --- | --- |
| `key` | 傳送你的 API 金鑰（`Authorization: Bearer …`，或按 adapter 使用 `x-api-key` / `api-key`）。金鑰可以是字面值，也可以是 `${ENV_VAR}` 引用。 | 大多數供應商。 |
| `forward` | 將**你傳入的 Codex 認證請求頭**原樣轉發給供應商——不儲存任何金鑰。這就是 ChatGPT 登入的透傳方式。 | OpenAI（`openai-responses` adapter）。 |
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

只有一組精選的請求頭會被轉發（`FORWARD_HEADERS`：authorization、ChatGPT account id、OpenAI beta/originator/session——參見 [Adapters](/zh-tw/reference/adapters/)）。這條路徑也為 [web-search 和 vision sidecar](/zh-tw/guides/sidecars/) 提供支援。

ChatGPT 透傳目錄也會加入 GPT-5.6 Sol/Terra/Luna 的裸 slug（`gpt-5.6-sol`、
`gpt-5.6-terra`、`gpt-5.6-luna`）；帳號具備相應許可權時才能實際呼叫。

## 2. 帳號登入（OAuth）

有六個供應商預設使用 OAuth 登入。opencodex 會把憑證存入 `~/.opencodex/auth.json` 並自動重新整理。
登入 CLI 也接受 `chatgpt`：它會獲取一份 ChatGPT 憑證，並建立一個 `forward` 模式的供應商條目。

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
| `anthropic` | `anthropic` | `https://api.anthropic.com` | Claude 模型；即時模型列表從 `/v1/models` 獲取。 |
| `kimi` | `openai-chat` | `https://api.kimi.com/coding/v1` | Kimi K2.7/K2.6/K2.5 程式設計模型。 |
| `kiro` | `kiro` | `https://runtime.us-east-1.kiro.dev` | 優先複用已安裝的 `kiro-cli` 登入。需先安裝 Kiro CLI（`curl -fsSL https://cli.kiro.dev/install | bash`）並執行 `kiro-cli login`。 |
| `google-antigravity` | `google` | `https://daily-cloudcode-pa.googleapis.com` | 透過 Cloud Code Assist 協議使用 Google OAuth。 |
| `cursor` | `cursor` | `https://api2.cursor.sh` | 實驗性 PKCE 登入、HTTP/2 傳輸和按帳號篩選的模型發現。 |

你也可以從 [web 儀表板](/zh-tw/guides/web-dashboard/) 啟動 OAuth。

### 多個 OAuth 帳號

OAuth 憑證中帶有穩定帳號 id 或郵箱的供應商可以儲存多個登入。Providers 頁面會在下拉選單中顯示這些
帳號，允許繼續新增，並在不登出其他帳號的情況下切換目前帳號。沒有身份資訊的 Kimi 和 Kiro 會替換
目前 active slot；`chatgpt` 始終只有一個 slot，因為 Codex 帳號池使用獨立儲存。權杖仍儲存在
`~/.opencodex/auth.json` 中；`/api/oauth/accounts` 只返回脫敏後的 metadata。

## 3. API 金鑰目錄

opencodex v2.7.1 內建 50 個預設：40 個金鑰預設、6 個 OAuth 預設、3 個本機預設，以及預設的
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
| Qwen Cloud | Token plan（預設）: `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` · 按量付費: `https://dashscope.aliyuncs.com/compatible-mode/v1` · 或自定義 |
| 騰訊雲 Coding Plan | `https://api.lkeap.cloud.tencent.com/coding/v3` |
| SiliconFlow | `https://api.siliconflow.cn/v1` |
| Xiaomi MiMo | `https://api.xiaomimimo.com/anthropic` |
| Kilo | `https://api.kilo.ai/api/gateway` |
| GitHub Copilot · GitLab Duo | `https://api.githubcopilot.com` · `https://cloud.gitlab.com/ai/v1/proxy/openai/v1` |
| Cloudflare AI Gateway | `https://gateway.ai.cloudflare.com/v1/{account-id}/{gateway}/anthropic` |
| ……以及更多 | opencode zen、Vercel AI Gateway、Venice、NanoGPT、Synthetic、Qianfan、Alibaba、Parallel、ZenMux、LiteLLM |

大多數使用帶 bearer 金鑰的 `openai-chat` adapter；少數僅暴露 Anthropic 相容端點的供應商（例如 **Xiaomi MiMo**）使用 `anthropic` adapter（`x-api-key`）。

> **騰訊雲 Coding Plan 使用限制：**騰訊將此訂閱限定為互動式程式設計工具使用。禁止通用 API
> 自動化、自定義應用後端和非互動式批次呼叫；違規使用可能導致套餐金鑰被停用。

### 多個 API 金鑰

基於金鑰的供應商也可以儲存多個 key。透過 Providers 頁面新增金鑰時，它會存入
`provider.apiKeyPool`、被設為 active，並同步到 `provider.apiKey`，這樣路由和 adapter 仍讀取原來的
欄位。同一個下拉選單可以切換或移除金鑰；管理 API 是 `/api/providers/keys`，並且只返回脫敏後的金鑰。

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
則使用各供應商的後設資料和 reasoning 對映。四條路徑最終都受上游帳號許可權限制；Cursor 還會根據即時
發現結果，僅保留目前帳號可用的模型。

:::note[gateway 與訂閱 proxy]
是否支援某個供應商，取決於 opencodex 是否有匹配的 wire adapter，而**不取決於**它是否屬於
“agent”產品。目前 adapter id 包括 `openai-chat`、`openai-responses`、`anthropic`、`google`
（AI Studio、Vertex、Antigravity/Cloud Code Assist 模式）、`azure` / `azure-openai`、`kiro` 和
`cursor`。原生 Amazon Bedrock 這類無法匹配上述實現的專有 API 暫不直接支援。**GitHub Copilot** 和
**GitLab Duo** 是多模型 gateway，對映到各自的通用 OpenAI 相容端點。Copilot 支援透過
`ocx login github-copilot` 使用 GitHub 裝置流 OAuth 登入（非官方橋接 — 使用 VS Code 公開用戶端 id
登入後換取短期 Copilot API 權杖，需要有效的 Copilot 訂閱，GitHub 政策收緊時可能失效）；GitLab Duo
使用 Bearer **訂閱權杖**（而非普通 API 金鑰）進行認證。
**Cloudflare AI Gateway** 需要將 account 和 gateway id 填入 URL。

Cursor 作為單獨的實驗性 adapter 進行跟蹤。`adapter: "cursor"` 會作為實驗性本機設定出現在
`ocx init` 和 dashboard Add Provider picker 中，並儲存 Cursor 的靜態回退模型目錄 metadata。設定
Cursor access token 後，opencodex 會使用 Cursor live HTTP/2 transport。v2.7.1 回退列表包含上下文為
1M 的 `gpt-5.6-sol` / `terra` / `luna`，以及上下文為 500K 的
`grok-4.5` / `grok-4.5-fast`；最終顯示哪些模型由帳號的即時發現結果決定。Cursor 伺服器直接發起的
native read/write/delete/ls/grep/shell/fetch 執行預設停用，因為它會繞過 Codex 的 approval 和
sandbox 路徑；只有在可信本機實驗中，才應在 `~/.opencodex/config.json` 的 `providers.cursor`
物件上設定 `unsafeAllowNativeLocalExec: true`，也可以在儀表板的 **Providers → Cursor → Edit JSON**
中設定。完整示例參見 [設定參考](/zh-tw/reference/configuration/#cursor-provider-adapter-cursor)。MCP、螢幕錄製和 computer-use
透過 executor hook 暴露；沒有設定本機 executor 時，opencodex 會返回 typed no-executor 結果。
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
