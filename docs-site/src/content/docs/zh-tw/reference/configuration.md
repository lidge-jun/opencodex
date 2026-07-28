---
title: 設定參考
description: ~/.opencodex/config.json 的所有欄位 —— 頂層選項、provider 與 sidecar。
---

opencodex 使用 `~/.opencodex/config.json` 設定。`ocx init` 和儀表板會寫入該檔案，你也可以直接
編輯；代理會在啟動時重新載入。**服務執行期間請優先停止代理，或改用儀表板／管理 API 再手動修改**：
執行中的程序會把設定放在記憶體中，中途儲存可能用該快照覆寫磁碟。自 v2.7.41 起，手動修改的
`claudeCode` 子樹在這類儲存中會被保留；其他鍵（例如 `providers`）仍可能被覆寫。如果檔案無法解析
（例如被截斷或不是有效 JSON），opencodex 會將其備份為 `config.json.invalid-<timestamp>`，在
console 中警告，再以預設值啟動。檔案缺失時也會回退到預設設定（單個 `openai` forward provider）。

## 保留的 OpenAI providers

`openai` 和 `openai-apikey` 是固定保留 id。`openai.codexAccountMode` 預設為 `"pool"`，會在主帳號和
新增帳號中選擇；`"direct"` 只使用目前 Codex caller/主登入。API 只使用設定的 API key/key pool。
透過 bare 模型或 `openai-apikey/<model>` 選擇，憑證路徑間沒有 fallback。API GPT-5.6 後設資料為
1,050,000 context / 922,000 max input，Pro virtual id 線上上
改寫為 base 模型加 `reasoning.mode: "pro"`。

`openaiProviderTierVersion: 2` 標記目前單一 provider projection。遷移 shipped v1 設定之前，會以
no-replace 方式建立 `config.json.pre-openai-tiers-v2.bak`，並把已知舊 namespaced selected id 改為 bare id。

## 頂層（`OcxConfig`）

| Field | Type | Default | 含義 |
| --- | --- | --- | --- |
| `port` | `number` | `10100` | 代理監聽埠。 |
| `hostname?` | `string` | `"127.0.0.1"` | 繫結地址。設為 `"0.0.0.0"` 可暴露到 LAN（需要 `OPENCODEX_API_AUTH_TOKEN`；見下文 [遠端存取](#遠端存取)）。 |
| `proxy?` | `string` | — | 出站 HTTP(S) proxy URL 或 `${ENV_VAR}` 引用。對應 env 未設定時應用到 `HTTP_PROXY` / `HTTPS_PROXY`；loopback 會保留在 `NO_PROXY` 中。 |
| `providers` | `Record<string, OcxProviderConfig>` | — | provider 名稱 → 設定的對映。 |
| `openaiProviderTierVersion?` | `2` | migration 設定 | 單一選項式 OpenAI projection 完成標記。 |
| `defaultProvider` | `string` | `"openai"` | 路由找不到更優匹配時使用的 provider。 |
| `subagentModels?` | `string[]` | `gpt-5.5`、三款 GPT-5.6、`gpt-5.4-mini` | 最多 5 個原生 slug 或 `provider/model` id，優先顯示在 Codex subagent picker 中。v2 指引清單是已設定模型與 Codex 中 picker 可見、相容 v2、按 priority 排序後前五項的交集，並使用規範目錄 slug 與可用 effort 檔位；被排除的條目仍保留在設定中。顯式空陣列會被保留。 |
| `injectionModel?` | `string` | — | 注入 multi-agent 指南（v2 介面）的首選原生或路由模型；委派指南會要求把該模型連同 `fork_turns: "none"` 一起傳給 `spawn_agent`。 |
| `injectionEffort?` | `string` | — | 首選 `spawn_agent` reasoning effort（`low` 到 `ultra`）。只有與 `injectionModel` 一起使用才有意義。 |
| `effortCap?` | `string` | — | reasoning effort 的逐請求硬上限。這是多代理 V2 專屬功能：適用於工具列表帶有 V2 協作表面的主輪次，以及標記精確匹配 `x-openai-subagent: collab_spawn` 或 `x-codex-turn-metadata` 中 `"subagent_kind": "thread_spawn"` 的派生子輪次（帶標記的子輪次無論自身工具表面如何都會被覆蓋）。普通主輪次與 V1 表面主輪次不受影響，壓縮（compaction）輪次始終繞過上限，`multiAgentMode: "v1"` 會完全停用上限功能（儀表板同時隱藏該面板）。接受 `low` 到 `ultra`；只會降低 effort，絕不會提高。會降至不高於上限的最高受支援檔位。若模型不提供 effort 控制，或上限之下沒有可用檔位，則移除 effort 欄位並採用 provider 預設值。`max` 和 `ultra` 均可使用，但不會形成更低的等級上限（用戶端會將 `ultra` 轉換為 `max`，因此請求以 `low` 到 `max` 的範圍到達）；不過，已知的模型 effort 階梯仍可能觸發降檔或移除欄位。儀表板選擇器提供 `low` 到 `xhigh`。透過 `GET /api/effort-caps` 和 `PUT /api/effort-caps` 管理。 |
| `subagentEffortCap?` | `string` | — | 同樣的硬上限，但只用於 codex-rs 標記精確匹配的派生子輪次：`x-openai-subagent: collab_spawn`，或 `x-codex-turn-metadata` 中的 `"subagent_kind": "thread_spawn"`。其他內部子代理類別（評審、壓縮、記憶整理）不會觸發此上限，`multiAgentMode: "v1"` 會完全停用該功能。接受 `low` 到 `ultra`；兩個上限同時設定時取較低者，且只會降低 effort，絕不會提高。會降至不高於上限的最高受支援檔位。若模型不提供 effort 控制，或上限之下沒有可用檔位，則移除 effort 欄位並採用 provider 預設值。`max` 和 `ultra` 均可使用，但不會形成更低的等級上限（用戶端會將 `ultra` 轉換為 `max`，因此請求以 `low` 到 `max` 的範圍到達）；不過，已知的模型 effort 階梯仍可能觸發降檔或移除欄位。儀表板選擇器提供 `low` 到 `xhigh`。透過 `GET /api/effort-caps` 和 `PUT /api/effort-caps` 管理。 |
| `injectionPrompt?` | `string` | — | 整體替換注入的 v2 指南正文的自定義文字。`{{model}}`、`{{effort}}`、`{{roster}}` 佔位符會被替換，觸發條件保持不變。也可透過 `PUT /api/injection-model` 的 `prompt` 鍵設定。 |
| `multiAgentGuidanceEnabled?` | `boolean` | `true` | 僅控制由 OpenCodex 新增的 multi-agent developer 指引。未設定/`true` 保持 v1/v2 指引；`false` 會同時禁止兩者，但不改變協作介面、`subagentModels`、路由或 effort 上限。`GET/PUT /api/injection-model` 返回有效值，PUT 為部分更新。 |
| `disabledModels?` | `string[]` | — | 從 Codex 隱藏的模型。路由 `provider/model` id 會從目錄和 `/v1/models` 排除；bare 原生 GPT slug（如 `gpt-5.4`）的目錄條目會改成 `visibility: "hide"`，並從 bare `/v1/models` 列表移除。可在儀表板 Models 頁面按模型切換。 |
| `multiAgentMode?` | `"v1" \| "default" \| "v2"` | `"default"` | 三態 multi-agent surface override。`"v1"` 覆蓋 upstream pin，強制全部模型使用 v1；`"default"` 遵循 upstream model pin（sol/terra=v2，luna=v1）；`"v2"` 強制全部模型使用 v2。可在儀表板 Models 頁面或 `ocx v2 mode` 中設定。 |
| `providerContextCaps?` | `Record<string,number>` | `{}` | provider 級 Codex 可見 context cap。只會降低已知 context window。 |
| `contextCapValue?` | `number` | `350000` | 儀表板 context-cap 控制元件使用的值；修改後會更新 `providerContextCaps` 中所有已啟用條目。 |
| `stallTimeoutSec?` | `number` | `300` | 上游無資料後 bridge 中止併發出 `response.incomplete` 前等待的秒數。最小值 1。 |
| `connectTimeoutMs?` | `number` | `200000` | 每次嘗試僅等待 DNS/TCP/TLS 和最終回應 header 的 deadline；在回應 body 生成前結束。 |
| `shutdownTimeoutMs?` | `number` | `5000` | 中止活躍 turn 前的 graceful drain deadline。 |
| `websockets?` | `boolean` | `false` | 公佈 `supports_websockets`，讓 Codex 使用 Responses WebSocket 路徑。省略或設為 `false` 會保持 HTTP/SSE。 |
| `apiKeys?` | `OcxApiKey[]` | `[]` | 非 loopback 繫結下，management 和 data-plane 認證額外接受的生成式 `ocx_…` credential。由儀表板管理；條目欄位見下文。 |
| `codexAutoStart?` | `boolean` | `true` | 允許 Codex shim 在啟動 Codex 前執行 `ocx ensure`。`false` 會讓 `ocx ensure` 不執行任何操作。 |
| `codexShimAutoRestore?` | `boolean` | `true` | 已完成的外部 Codex 更新替換此前安裝的 shim 時自動恢復。若要關閉，請設為 `false`，或為程序設定 `OPENCODEX_CODEX_SHIM_AUTO_RESTORE=0`。 |
| `syncResumeHistory?` | `boolean` | `true` | 可逆的 Codex App 歷史相容模式。opencodex 會備份原始 Codex thread metadata，把舊 OpenAI interactive row 重對映到 `opencodex`，並暫時把 opencodex 建立的 `exec` row 提升成 App 可見 source。`ocx stop` / `ocx restore` 會恢復已備份的 OpenAI row，並把剩餘 opencodex user thread 轉回 OpenAI，使原生 Codex 在從 `config.toml` 移除代理後仍能繼續這些 thread。設為 `false` 可退出該模式。 |
| `codexAccounts?` | `CodexAccount[]` | `[]` | Codex Auth 儀表板管理的 ChatGPT/Codex pool account metadata。secret 單獨存放在 `codex-accounts.json`。 |
| `activeCodexAccountId?` | `string` | — | 手動選擇的 pool account。選擇時清除已有 thread affinity，並從下一次請求開始生效；進行中的請求保留原帳號。 |
| `autoSwitchThreshold?` | `number` | `80` | 新 session 自動切換的 usage 百分比 threshold。分數取已知 5 小時、周或 30 天 quota window 中最高的一項。設為 `0` 可停用 quota 自動切換。 |
| `upstreamFailoverThreshold?` | `number` | `3` | 連續發生多少次臨時上游失敗後，讓後續新 session failover 到其他合格 pool account。設為 `0` 可停用失敗切換。 |
| `modelCacheTtlMs?` | `number` | `300000` | 每個 provider 的 `/models` 快取新鮮度視窗（5 分鐘）。 |
| `cacheRetention?` | `"none" \| "short" \| "long"` | `"short"` | Anthropic prompt-cache 策略：停用、5 分鐘 ephemeral 或 1 小時 extended。 |
| `webSearchSidecar?` | `OcxWebSearchSidecarConfig` | 開啟 | 網路搜尋 sidecar 選項（見下文）。 |
| `visionSidecar?` | `OcxVisionSidecarConfig` | 開啟 | 視覺 sidecar 選項（見下文）。 |
| `tokenGuardian?` | `OcxTokenGuardianConfig` | 關閉 | 可選的 proactive OAuth 重新整理和 Codex account warmup 策略；欄位見下文。 |
| `corsAllowOrigins?` | `string[]` | `[]` | CORS 額外允許的精確 origin。loopback origin 始終允許。 |

`maxConcurrentThreadsPerSession` 是 `PUT /api/v2` 使用的 camel-case 欄位，不是 `config.json` key。
`ocx v2 threads <n>` 會把對應的 `max_concurrent_threads_per_session` 值寫入 Codex
`$CODEX_HOME/config.toml` 的 `[features.multi_agent_v2]` 下；請先啟用 v2，確保該 table 存在。

如果舊開發建置在支援備份前已執行 `syncResumeHistory`，也可用
`ocx recover-history --legacy-openai` 強制執行相同的 native-provider 恢復。

:::note[Codex 帳號池]
請在儀表板 **Codex Auth** 頁面新增 pool account 並重新整理 quota。設定只儲存非 secret account
metadata；access/refresh token 存放在加固的 Codex account credential store 中。已有 thread id 會
保留 account affinity，新 session 可按 quota、cooldown 和 health 自動路由。
:::

### claudeCode（OcxClaudeCodeConfig）

Claude Code 入站設定，供 `/v1/messages` 介面、`ocx claude` 啟動器與 GUI 的 Claude 頁面使用。
原生透傳 body 上限（隨 body-occupancy 防護一併加入）：

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `claudeCode.bodyStallSec?` | `number` | `90` | 原生透傳 body 閒置預算（秒）——讀取等待中上游原始位元組的靜默時間，而非總時長。最小值 1。剛好為 `0` 時停用。 |
| `claudeCode.bodyMaxBytes?` | `number` | `67108864` | 原生透傳 body 累計位元組上限（串流 SSE 與緩衝的非串流回應）。剛好為 `0` 時停用。 |
| `claudeCode.authMode?` | `"proxy" \| "subscription"` | 未設定（auto） | 啟動時如何處理 `ANTHROPIC_AUTH_TOKEN`。未設定即 auto：opencodex 每次啟動都會偵測 Claude 認證，有則選 subscription、無則選 proxy；無法判斷時選 subscription 並警告。明確設定的值絕不會被偵測覆寫。見 [Claude Code](/zh-tw/guides/claude-code/#auth-mode)。 |
| `claudeCode.authModeMigratedAt?` | `string` | 未設定 | 內部一次性標記。升級時若把 pre-`auto` 設定釘選為 `subscription` 會寫入一次，避免刻意使用訂閱的使用者被靜默改到 proxy。請勿手動設定。 |

### 受管 record 形狀

`apiKeys[]` 條目包含 `id: string`、`name: string`、生成的 `key: string` 和 ISO 格式的
`createdAt: string`。`codexAccounts[]` 條目包含必需的 `id`、`email`、`isMain`，以及可選的
`plan`、`chatgptAccountId` 和不含隱私的 `logLabel` 字串。這些 record 通常由儀表板管理。

### `tokenGuardian`（`OcxTokenGuardianConfig`）

| Field | Type | Default | 含義 |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | `false` | proactive refresh 總開關。 |
| `tickSeconds?` | `number` | `21600` | sweep 間隔（6 小時，最少 60 秒）。 |
| `jitterSeconds?` | `number` | `300` | sweep 前增加的隨機延遲。 |
| `concurrency?` | `number` | `3` | 每次 sweep 最多同時重新整理多少項。 |
| `leadSeconds?` | `number` | `900` | 在一個 tick 之外額外預留的重新整理提前量。 |
| `failureBackoffBaseSeconds?` | `number` | `300` | 首次臨時失敗 backoff。 |
| `failureBackoffMaxSeconds?` | `number` | `3600` | backoff 上限和永久失敗延遲。 |
| `codexWarmupEnabled?` | `boolean` | `false` | 選擇啟用合成 Codex pool-account 驗證。 |
| `codexWarmupMaxAgeSeconds?` | `number` | `691200` | 帳號在 8 天后重新驗證。 |
| `codexWarmupModel?` | `string` | `gpt-5.4-mini` | 可選 warmup 使用的原生模型。 |

## 遠端存取

opencodex 預設只繫結到 `127.0.0.1`（loopback）。當 `hostname` 設定為 `0.0.0.0` 等非 loopback
地址時，management API（`/api/*`）和 data plane（`/v1/responses`）都會強制 token 認證。

啟動前設定 `OPENCODEX_API_AUTH_TOKEN`：

```bash
export OPENCODEX_API_AUTH_TOKEN="your-secret-token"
ocx start
```

非 loopback 繫結缺少該變數時，代理會拒絕啟動。若要為 LAN 存取安裝後臺服務，也應先 export
同一變數，再執行 `ocx service install`，讓 launchd、systemd 或 Task Scheduler 收到 token。
用戶端必須在每個請求的 `x-opencodex-api-key` header 中提供 token：

```
x-opencodex-api-key: your-secret-token
```

也可以使用 `Authorization: Bearer …` header。啟動後，儀表板生成的 `apiKeys` 可代替環境 token。
所有候選值均用常量時間（`timingSafeEqual`）比較，避免 timing side-channel。

:::caution[LAN 暴露]
繫結到 `0.0.0.0` 會把代理和所有已設定 provider credential 暴露到本機網路。只應在可信網路中
使用，並始終設定強 `OPENCODEX_API_AUTH_TOKEN`。
:::

## Providers（`OcxProviderConfig`）

| Field | Type | 含義 |
| --- | --- | --- |
| `adapter` | `string` | `openai-chat`、`openai-responses`、`anthropic`、`google`、`kiro`、`cursor`、`azure-openai`（或別名 `azure`）之一。 |
| `baseUrl` | `string` | 上游 API base URL。端點固定的內建 provider 會忽略它 —— 見[固定的 provider 端點](#固定的-provider-端點)。 |
| `responsesPath?` | `string` | `key` 認證的 `openai-responses` 請求可選相對 resource path。必須以 `/` 開頭，且不得包含 URL scheme、query 或 fragment。省略時保留原有的 `/v1/responses` URL 構造。 |
| `disabled?` | `boolean` | 設定保留在磁碟上，但從路由和模型/目錄列表排除。 |
| `apiKey?` | `string` | API key，或在請求時解析的 `${ENV_VAR}` / `$ENV_VAR` 引用。 |
| `apiKeyPool?` | `ApiKeyPoolEntry[]` | 多 key pool。`apiKey` 對映目前活動條目；每項包含 `id`、`key`、可選 `label` 和可選數字 `addedAt`。 |
| `defaultModel?` | `string` | 選中該 provider 但未指定明確模型時使用的模型。 |
| `models?` | `string[]` | seed/fallback 模型列表。`liveModels` 為 `false` 時，只會發現這些模型。 |
| `liveModels?` | `boolean` | 啟動/同步時獲取 provider 的即時 `/models` 目錄（預設 `true`）。設為 `false` 時只使用設定的 `models`。 |
| `selectedModels?` | `string[]` | 模型發現後應用的目錄 allowlist。非空時只向 Codex 暴露這些 id；為空或省略時暴露所有發現的模型。 |
| `contextWindow?` | `number` | 路由目錄條目的 provider 級 Codex 可見 context-window cap。即時 metadata 更小時保留即時值。 |
| `modelContextWindows?` | `Record<string,number>` | 模型級 context-window cap。匹配模型時優先於 `contextWindow`，且不會抬高更小的即時 metadata。 |
| `modelInputModalities?` | `Record<string,string[]>` | 模型級目錄 input hint，如 `["text"]` 或 `["text", "image"]`。 |
| `modelMaxInputTokens?` | `Record<string,number>` | 模型級最大 input token 上限，供目錄自動壓縮提示使用。值必須為正整數。 |
| `defaultMaxOutputTokens?` | `number` | 當用戶端省略 `max_output_tokens` 時，`openai-chat` 在 provider 層級的 `max_tokens` 後備值。明確請求仍優先。 |
| `modelMaxOutputTokens?` | `Record<string,number>` | 模型級 `openai-chat` 後備輸出預算。精確／模型 pattern 匹配優先於 `defaultMaxOutputTokens`；所有值必須為正整數。 |
| `headers?` | `Record<string,string>` | 額外上游 header。Authorization、cookie、API-key header、包含換行的值和無效 header 名稱會被拒絕。 |
| `openRouterRouting?` | `OpenRouterProviderRouting` | 預設 OpenRouter provider 路由設定。支援 `order`、`only` 和 `allowFallbacks`；僅適用於 canonical OpenRouter URL 和 `openai-chat` adapter。 |
| `modelOpenRouterRouting?` | `Record<string,OpenRouterProviderRouting>` | 按精確模型 id 覆蓋 `openRouterRouting`。 |
| `authMode?` | `"key" \| "forward" \| "oauth"` | 認證方式（預設 `key`）。參見 [Providers](/zh-tw/guides/providers/#認證模式)。 |
| `codexAccountMode?` | `"pool" \| "direct"` | 僅用於 canonical `openai`。省略時預設 Pool；Direct 會繞過池狀態。 |
| `refreshPolicy?` | `"proactive" \| "lazy-only" \| "disabled"` | 覆蓋該 OAuth provider 的 Token Guardian 策略。 |
| `reasoningEfforts?` | `string[]` | provider 級需要公佈和傳送的 Codex reasoning label（`low`、`medium`、`high`、`xhigh`、`max`、`ultra`）。 |
| `modelReasoningEfforts?` | `Record<string,string[]>` | 模型級 reasoning label。空陣列會隱藏該模型的 effort 控制元件。 |
| `modelSupportsReasoningSummaries?` | `Record<string,boolean>` | 模型級 reasoning summary 能力。設為 `false` 時不再宣告 summary 支援，並在 `openai-responses` 請求前移除 summary-delivery 欄位。 |
| `modelAdapters?` | `Record<string,string>` | 同一 gateway 前方承載不同 wire 模型時的逐模型 wire 覆寫。鍵為上游原生模型 id；值必須是 `openai-chat` 或 `openai-responses`。適用於某個模型需要 Responses API 才能使用 `web_search` 等託管工具、而其兄弟模型仍可用 chat completions 的情況。上游釘死單一 wire 的模型，以及 canonical ChatGPT forward provider，會拒絕覆寫。 |
| `reasoningEffortMap?` | `Record<string,string>` | provider 級 reasoning label wire alias。只在上游需要不同值時使用。 |
| `modelReasoningEffortMap?` | `Record<string,Record<string,string>>` | 模型級 reasoning label wire alias。 |
| `noReasoningModels?` | `string[]` | 拒絕 reasoning/thinking 引數的模型；adapter 會為它們移除 `reasoning_effort`。 |
| `noTemperatureModels?` | `string[]` | 拒絕呼叫方指定 `temperature` 的模型。 |
| `noTopPModels?` | `string[]` | 拒絕呼叫方指定 `top_p` 的模型。 |
| `noPenaltyModels?` | `string[]` | 拒絕 presence/frequency penalty 的模型。 |
| `parallelToolCalls?` | `boolean` | 啟用或停用並行工具呼叫。OpenAI Chat 預設開啟；非 chat adapter 只有顯式為 `true` 時才公佈支援。 |
| `responsesItemIdRepair?` | `{ message?: string[]; reasoning?: string[]; repairMissingTerminalIds?: boolean }` | provider 本機、預設停用的 passthrough SSE 修復：針對精確的 `message`／`reasoning` 佔位 id 與缺失的 terminal id。僅下游生效；function-call id 與 `call_id` 絕不會被改寫。 |
| `autoToolChoiceOnlyModels?` | `string[]` | `tool_choice` 只接受 `auto` 或 `none` 的模型；forced/named 選擇會降級。 |
| `preserveReasoningContentModels?` | `string[]` | 要求在 chat history 中保留先前 assistant `reasoning_content` 的模型。 |
| `thinkingToggleModels?` | `string[]` | 使用 vendor `thinking.enabled` toggle，而不是 effort ladder 的 chat 模型。 |
| `thinkingBudgetModels?` | `string[]` | 使用整數 `thinking_budget` 的 chat 模型；effort 會對映成 budget 比例。 |
| `noVisionModels?` | `string[]` | 純文字模型；[視覺 sidecar](/zh-tw/guides/sidecars/) 會為它們描述圖像。匹配時容忍 Ollama `:size` 標籤。 |
| `escapeBuiltinToolNames?` | `boolean` | Umans 等 Anthropic 相容 gateway 可能要求在 wire 上轉義工具名；opencodex 會在把 tool call 返回 Codex 前移除 prefix。 |
| `googleMode?` | `"ai-studio" \| "vertex" \| "cloud-code-assist"` | Google transport/auth mode。預設 `ai-studio`。 |
| `project?` | `string` | Vertex project id 或 Antigravity Cloud Code Assist project id。 |
| `location?` | `string` | Vertex location；env fallback 為 `GOOGLE_CLOUD_LOCATION`。 |
| `mcpServers?` | `Record<string,CursorMcpServerConfig>` | **僅 Cursor。** 透過 stdio 啟動或 Streamable HTTP 連線的 MCP server；欄位見下文。 |
| `desktopExecutor?` | `DesktopExecutorConfig` | **僅 Cursor。** 外部 computer-use/record-screen 命令；欄位見下文。 |
| `unsafeAllowNativeLocalExec?` | `boolean` | **僅 Cursor adapter。** Cursor server 驅動本機 `read` / `write` / `delete` / `ls` / `grep` / `shell` / `fetch` 執行器的舊版相容布林值。當 `nativeLocalExec` 未設定時，等同 `nativeLocalExec: "on"`；若已顯式設定 `nativeLocalExec`，以後者為準。預設 `false`。新設定請優先使用 `nativeLocalExec`。見下文 [Cursor provider](#cursor-provideradapter-cursor)。 |
| `nativeLocalExec?` | `"off" \| "codex-sandbox" \| "on"` | **僅 Cursor adapter。** Cursor server 驅動執行器的原生本機執行政策。`"off"`（預設）拒絕執行；`"on"` 為可信本機 opt-in；`"codex-sandbox"` 為向後相容而接受，但目前與 `"off"` 一樣 fail-closed。見下文 [Cursor provider](#cursor-provideradapter-cursor)。 |

### 固定的 provider 端點

路由會在任何 adapter 介入之前解析 provider 的端點；對大多數內建 provider 而言，registry 自帶的端點
優先於你在設定裡寫的 `baseUrl`。在這一步保留設定 URL 的只有三類：

- 顯式開啟覆蓋的 provider —— `ollama`、`vllm`、`lm-studio`、`litellm`、`qwen-cloud` 和
  `alibaba-token-plan-intl`；
- registry 端點本身是待填模板的 provider，例如 `azure-openai` 和 `cloudflare-ai-gateway`；
- 你自己定義的 provider，它們根本不在 registry 中。

之後 adapter 仍可能調整已解析的 URL。例如 `kiro` adapter 在 host 為標準
`runtime.{region}.kiro.dev` 時，會改用匯入憑證所屬的 API region。逐個 adapter 的規則見
[Adapters](/zh-tw/reference/adapters/)。

當路由丟棄設定的 `baseUrl` 時，opencodex 會列印一條警告：registry 端點會完整列出，而你設定的那個
只列出 origin —— 原本帶路徑時顯示為 `https://host/…`。設定的路徑本身可能就是憑證，因此一段都不會記錄。
此時要麼刪掉 `baseUrl`（路由本來就只會使用 registry 端點），要麼改用端點與目標 URL 相符的 provider。
當同一產品分割槽域運營時，選對條目尤其重要：`alibaba-token-plan` 固定指向北京，而
`alibaba-token-plan-intl` 覆蓋國際端點，為其中一個簽發的 key 在另一個上會被拒絕。

對於有問題的 `openai-responses` 相容 gateway，`responsesItemIdRepair` 應直接寫在 provider 物件上，例如：

```json
{
  "providers": {
    "custom-gateway": {
      "adapter": "openai-responses",
      "baseUrl": "https://gateway.example/v1",
      "apiKey": "${GATEWAY_KEY}",
      "responsesItemIdRepair": {
        "reasoning": ["rs_0"],
        "message": ["msg_0"],
        "repairMissingTerminalIds": true
      }
    }
  }
}
```

佔位列表僅做精確字串匹配。一般／有狀態的 Responses 供應商請保持該欄位未設定，讓
passthrough 與上游保持位元組級一致。

## Cursor provider（`adapter: "cursor"`）

Cursor bridge 仍屬實驗功能。執行 `ocx login cursor` 後，在
`~/.opencodex/config.json`（Windows：`%USERPROFILE%\.opencodex\config.json`）的 `providers` 下
新增或編輯 `cursor` 條目。

Cursor Router 的完整優化階梯會以獨立的 Codex 模型 id 暴露，因為 Codex 的模型選擇器無法渲染
Cursor 專屬的模型參數：

| Codex 模型 | Cursor Router 模式 |
| --- | --- |
| `cursor/auto` | 團隊／帳號預設（向後相容） |
| `cursor/auto-cost` | Cost |
| `cursor/auto-balance` | Balance |
| `cursor/auto-intelligence` | Intelligence |

這些明確變體都會以 Cursor 的 `default` 模型搭配其 `optimization` 模型參數送出，因此每次請求都會
保留該選擇。即使即時模型探索省略 `default`，它們仍會像原本的 `cursor/auto` 一樣可用。

Cursor server 驅動的原生本機工具預設保持**停用**。Codex 繼續按自身審批和 sandbox policy 使用
`apply_patch`、`exec_command` 等工具。使用 `nativeLocalExec` 欄位選擇政策：

- **`"off"`（預設，最安全）** — 拒絕所有 Cursor server 驅動的本機 `read`、`write`、`delete`、
  `ls`、`grep`、`shell` 與 `fetch` 執行。除非你刻意選擇加入，否則請使用此值。
- **`"on"`（可信本機 opt-in）** — 一律允許此供應商的 Cursor 原生本機執行。
  僅在資料平面的每個呼叫端都可信的本機實驗主機上使用。
- **`"codex-sandbox"`（接受，但 fail-closed）** — 為向後相容而辨識，但目前行為與 `"off"` 相同。
  Responses 的 `instructions` / `system` / `developer` 文字是呼叫端可控的散文，opencodex 沒有
  可信的逐請求證明能反映真實的 Codex sandbox 狀態，因此它永遠不會授權原生本機執行。

```json
{
  "providers": {
    "cursor": {
      "adapter": "cursor",
      "baseUrl": "https://api2.cursor.sh",
      "authMode": "oauth",
      "defaultModel": "auto",
      "nativeLocalExec": "off"
    }
  }
}
```

該欄位應放在 **provider 物件**（`providers.cursor`）上，而不是 `config.json` 頂層。

也可在 [Web 儀表板](/zh-tw/guides/web-dashboard/) 中設定：進入 **Providers → Cursor →
Edit JSON**，將 `"nativeLocalExec"` 設為 `"off"`、`"on"` 或 `"codex-sandbox"`，儲存後重啟代理
（`ocx restart` 或 `ocx stop` + `ocx start`）。

舊版布林值 `unsafeAllowNativeLocalExec: true` 仍被接受；當 `nativeLocalExec` 未設定時，等同
`nativeLocalExec: "on"`。若已顯式設定 `nativeLocalExec`，以後者為準。新設定請優先使用
`nativeLocalExec`。

MCP、螢幕錄製和 computer-use 使用獨立的 `mcpServers` / `desktopExecutor` 設定，不受該欄位控制。

### Cursor 整合 record

每個 `mcpServers.<name>` 值接受 `command`（stdio）或 `url`（Streamable HTTP）之一。stdio 條目還
接受 `args?: string[]`、`env?: Record<string,string>`、`cwd?: string`；HTTP 條目接受
`headers?: Record<string,string>`。兩種形式都支援 `enabled?: boolean`（預設 true）和
`toolPrefix?: string`。

`desktopExecutor` 接受 `computerUseCommand?`、`recordScreenCommand?`、`cwd?`、
`env?: Record<string,string>` 和 `timeoutMs?`（預設 `30000`）。命令經 `sh -c` 執行，從 stdin
讀取一個 JSON 請求，並必須向 stdout 寫出一個 JSON 結果。

:::caution[安全]
`"off"` 是最安全的預設。預設 loopback bind 會在**沒有驗證**的情況下接納**任何**本機程序
（在多使用者機器上也包括其他本機使用者），且像 Codex sandbox 標記這類請求文字永遠不會授權
原生本機執行。除非你明確需要繞過 Codex 審批與 sandbox 語義的 Cursor 原生本機執行，否則請
省略 `nativeLocalExec` 或將其設為 `"off"`。
:::

## OpenRouter provider 路由

同一模型的不同 OpenRouter endpoint 在 prompt cache 支援、命中率、保留時間和價格方面可能存在顯著差異。
使用 `openRouterRouting` 指定預設 provider，使用 `modelOpenRouterRouting` 為精確模型 id 覆蓋設定。
這些設定會轉換為 OpenRouter 請求中的 `order`、`only` 和 `allow_fallbacks` 欄位。
當 `allowFallbacks: false` 時，指定 provider 不可用會使請求失敗，而不會切換到其他 endpoint。

```json
{
  "openRouterRouting": { "order": ["deepseek"], "allowFallbacks": false },
  "modelOpenRouterRouting": {
    "anthropic/claude-sonnet-5": { "only": ["anthropic"], "allowFallbacks": false }
  }
}
```

## 靜態模型 allowlist

部分 provider 的即時模型目錄非常大或很慢。若只想讓 Codex 看到 `models` 中固定的模型，請把
`liveModels` 設為 `false`。

當 `liveModels` 為 `false` 且 `models` 為空或省略時，opencodex 不會為該 provider 暴露任何
路由模型。

`selectedModels` 的用途不同：模型發現仍會執行，但只有選中的 id 會發佈到 Codex 目錄和
`/v1/models`。儀表板仍保留完整模型列表，因此之後可以修改 allowlist。

Preview GPT-5.6 fallback 條目採用相同機制。OpenAI API-key preset 會以 context `1050000`、
max input `922000` seed base 和 Pro id；OpenRouter preset 會以 context `1050000` seed
`openai/gpt-5.6-sol`、`terra`、`luna`。Pool/Direct 的 Codex 目錄契約為 `372000`；同步後的
Codex 目錄會公佈 `max` reasoning，同時與 `xhigh` 保持
區分。保持 `liveModels` 開啟可把即時 provider 結果與這些顯式條目合併；設為 `false` 則只暴露
`models`。

```json
{
  "providers": {
    "openrouter": {
      "adapter": "openai-chat",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "${OPENROUTER_API_KEY}",
      "liveModels": false,
      "models": ["deepseek/deepseek-v4-flash", "qwen/qwen3-coder-plus"]
    }
  }
}
```

## Sidecars

### `webSearchSidecar`（`OcxWebSearchSidecarConfig`）

| Field | Type | Default | 含義 |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | 所選後端可用時開啟 | 總開關。設為 `false` 可停用 Web Search sidecar。 |
| `backend?` | `"openai" \| "anthropic"` | 自動 | 執行後端。顯式設定優先；省略時，有可用的 Anthropic OAuth 活動帳號則選 `anthropic`，否則選 `openai`。 |
| `model?` | `string` | 因後端而異 | 搜尋模型：`openai` 預設 `gpt-5.6-luna`，`anthropic` 預設 `claude-sonnet-5`。顯式保留的舊 `gpt-5.4-mini` 值會在啟動時遷移。 |
| `reasoning?` | `string` | `low` | sidecar reasoning effort（網路搜尋會拒絕 `minimal`）。 |
| `maxSearchesPerTurn?` | `number` | `3` | 每個主模型 turn 的真實搜尋總次數（loop guard）。 |
| `routedModelStallTimeoutMs?` | `number` | `200000` | 僅可在設定檔中設定的路由模型迭代原始回應 byte 連續無活動 deadline。必須是 `1` 到 `2147483647` 的整數；每個非空回應 body chunk 都會重置該計時器。 |
| `timeoutMs?` | `number` | `60000` | 單次託管 web-search 請求的獨立 deadline。已從 200000 下調，使不可用/額度耗盡的搜尋後端在約 1 分鐘內降級為無結果回答，而不會拖住整輪請求（#398）。 |

`openai` 後端透過已啟用的 ChatGPT `forward` provider 執行託管搜尋，因此同時需要 ChatGPT 登入
和該 provider。Claude 入站的路由重放會把主 ChatGPT 認證注入內部 sidecar 請求，使該路徑仍可
存取。`anthropic` 後端使用已啟用 Anthropic OAuth provider 的活動儲存憑證，並執行 Claude 的
`web_search_20250305` 工具。若顯式設定 `backend: "anthropic"`，但沒有可用活動帳號（包括
`needsReauth` 狀態），sidecar 會關閉失敗，而不會回退到 OpenAI。

Web-search 路徑有四個時鐘：基礎 bridge event-stall 預算（`stallTimeoutSec`）、DNS/TCP/TLS/最終
header 預算（`connectTimeoutMs`）、路由模型原始 byte 無活動期限
（`routedModelStallTimeoutMs`），以及單次託管搜尋期限（`timeoutMs`）。實際 bridge watchdog 為
`max(基礎 stall, connect timeout, 路由模型 stall, sidecar timeout) + 30 秒`。路由模型 stall 是
無活動保護，並非總生成 timeout。

### `visionSidecar`（`OcxVisionSidecarConfig`）

| Field | Type | Default | 含義 |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | 所選後端可用時開啟 | 總開關。設為 `false` 可停用圖像描述。 |
| `backend?` | `"openai" \| "anthropic"` | 自動 | 執行後端。使用與 Web Search 相同的顯式優先、Anthropic 憑證感知解析規則。 |
| `model?` | `string` | 因後端而異 | 圖像描述模型：`openai` 預設 `gpt-5.4-mini`，`anthropic` 預設 `claude-sonnet-5`。 |
| `maxDescriptionsPerTurn?` | `number` | `8` | 一個主模型 turn 中允許新增的描述快取 miss 數。`0` 停用描述呼叫；無效值使用預設值。 |
| `timeoutMs?` | `number` | `45000` | sidecar fetch timeout。 |

Vision sidecar 僅在圖像傳送給 provider 的 `noVisionModels` 列表所匹配模型時啟用。OpenAI 後端與
Web Search 一樣，需要 ChatGPT 登入和 forward provider；Anthropic 後端使用已儲存 OAuth，顯式
選擇但沒有可用憑證時會關閉失敗。成功的 `data:` 圖像描述會存入有界程序級快取，快取鍵包含後端、
模型、detail、圖像位元組和規範化訊息上下文。快取命中和同一 turn 的重複請求不會消耗
`maxDescriptionsPerTurn`。遠端 `https:` 圖像以及失敗或空的描述不會快取。

Anthropic OAuth 搜尋和圖像描述請求沿用 opencodex 已有的 Claude Code OAuth fingerprint。它處於
儲存庫既有 OAuth 先例範圍內，但仍應使用目標帳號和實際負載進行充分 soak test。

<!-- TODO(WP5 GUI): GUI 控制元件完成後補充 sidecar 設定頁面操作說明。 -->

## 完整示例

```json
{
  "port": 10100,
  "defaultProvider": "openai",
  "providers": {
    "openai": {
      "adapter": "openai-responses",
      "baseUrl": "https://chatgpt.com/backend-api/codex",
      "authMode": "forward"
    },
    "anthropic": {
      "adapter": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      "authMode": "oauth",
      "defaultModel": "claude-sonnet-4-6"
    },
    "ollama-cloud": {
      "adapter": "openai-chat",
      "baseUrl": "https://ollama.com/v1",
      "apiKey": "${OLLAMA_API_KEY}",
      "defaultModel": "glm-5.2",
      "noVisionModels": ["glm-5.2", "gpt-oss", "qwen3-coder", "deepseek-v4-pro"]
    }
  },
  "subagentModels": ["anthropic/claude-opus-5", "ollama-cloud/glm-5.2"],
  "disabledModels": [],
  "websockets": false,
  "webSearchSidecar": {
    "maxSearchesPerTurn": 3,
    "routedModelStallTimeoutMs": 200000,
    "timeoutMs": 60000
  },
  "visionSidecar": { "enabled": true }
}
```

:::tip[金鑰]
建議為 key 使用 `${ENV_VAR}` 引用，避免 `config.json` 包含 secret。OAuth 和 forward provider
完全不儲存 key。
:::

:::note[原子寫入]
所有設定和目錄檔案（`config.toml`、`opencodex-catalog.json`）都會經 `atomicWriteFile`（臨時檔案 +
重新命名）原子寫入。這樣即使多個 writer（例如 `ocx stop` 與代理自身的 shutdown handler）同時
恢復 Codex，也不會留下只寫了一半的檔案。
:::
