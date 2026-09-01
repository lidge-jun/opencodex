---
title: 供應商設定
description: 供應商項目、認證、端點、模型目錄、配額、context 上限與供應商專屬選項。
---

供應商告訴 opencodex 模型在哪裡、它使用哪種 wire adapter，以及請求如何被認證。

## 供應商相關的頂層欄位

| 欄位 | 型別 | 預設值 | 意義 |
| --- | --- | --- | --- |
| `providers` | `Record<string, OcxProviderConfig>` | — | 供應商名稱到供應商設定的映射。 |
| `openaiProviderTierVersion?` | `2` | 由遷移設定 | 標記單一選項感知的 OpenAI projection 已完成。 |
| `disabledModels?` | `string[]` | — | 對 Codex 目錄與 `/v1/models` 隱藏的模型，但不阻擋直接代理呼叫。路由 id 從清單中移除；裸原生 GPT id 取得 `visibility: "hide"`。 |
| `providerContextCaps?` | `Record<string, number>` | `{}` | Per-供應商的 Codex 可見 context 上限。上限只會降低已知的 context window。 |
| `contextCapValue?` | `number` | `350000` | 儀表板 context-cap 控制使用的值；變更它會更新每個啟用的 `providerContextCaps` 項目。 |
| `codexAccounts?` | `CodexAccount[]` | `[]` | 由 Codex Auth 管理的 ChatGPT/Codex 池帳號中繼資料。秘密分別存在 `codex-accounts.json`。 |
| `pausedCodexAccountIds?` | `string[]` | `[]` | 被排除於池選擇直到恢復的帳號，包含暫停時的 main `__main__` 帳號。 |
| `codexAccountNamespaces?` | `Record<string, string>` | — | 公開模型選擇器命名空間到已儲存 Codex 帳號目標。這會驗證並持久化映射，但不會自行新增 picker 列或變更路由。 |
| `activeCodexAccountId?` | `string` | — | 為下一個請求手動選擇的池帳號。選擇清除執行緒親和性；進行中的請求保留擷取的憑證。 |
| `autoSwitchThreshold?` | `number` | `80` | 主動切換的用量閾值。`quota` 可在其下一個請求時重新評估綁定與未綁定任務；`fill-first` 僅將其用作未綁定指派的排空點；一般 `round-robin` 選擇不使用它。分數使用最熱的已知 5h、週或 30d 配額視窗。`0` 僅停用基於用量的主動切換，而非未綁定指派或失敗復原。 |
| `accountPoolStrategy?` | `"quota" \| "round-robin" \| "fill-first"` | `"quota"` | 新／未綁定 Codex 請求的指派策略。當請求沒有即時（父執行緒 id、配額 scope）親和性時即為未綁定；可見的既有任務在代理重啟或親和性重置後可變為未綁定。`quota` 在無現用帳號時選擇最低用量的合格帳號，將合格現用帳號保持在 `autoSwitchThreshold` 以下，且在閾值後可將未綁定請求或主動重新綁定綁定任務到較低用量的合格帳號。`round-robin` 均勻分配未綁定請求；`fill-first` 持續將未綁定請求指派到現用帳號直到冷卻、不可用或設定的排空閾值。 |
| `accountPoolStickyLimit?` | `number` | `1` | 在前進一個 round-robin 選擇前保留的新／未綁定任務指派；計數器在任務綁定時前進，而非在上游成功後。範圍 1–100。 |
| `upstreamFailoverThreshold?` | `number` | `3` | 未來新 session 容錯移轉前的連續暫時性失敗。設 `0` 停用。 |
| `modelCacheTtlMs?` | `number` | `300000` | Per-供應商 `/models` 快取的新鮮度視窗。 |
| `cacheRetention?` | `"none" \| "short" \| "long"` | `"short"` | Anthropic prompt-cache 政策：停用、5 分鐘臨時或 1 小時延長。 |
| `tokenGuardian?` | `OcxTokenGuardianConfig` | off | 可選的主動 OAuth refresh 與 Codex 帳號暖機政策。 |

`codexAccountNamespaces` key 是公開選擇器：1–64 字元，以 ASCII 字母或數字開頭與結尾，中間為字母、數字、`.`、`_` 或 `-`。保留的 JavaScript 物件名稱被拒絕。每個值是有效的池帳號 id（絕非內部 `__main__`）或代表 Codex Desktop 帳號的 `"@main"`。供應商與保留的 `openai` / `combo` 衝突以不區分大小寫方式檢查。保持原始帳號 id 與電子郵件私密；選擇器是公開名稱。

## 保留的 OpenAI 供應商

`openai` 與 `openai-apikey` 是固定的保留 id。`openai.codexAccountMode` 預設為 `"pool"` 並在 main 加上新增帳號之間選擇；`"direct"` 僅使用目前呼叫者／main 登入。API 僅使用其設定的 API 金鑰或金鑰池。使用裸模型或 `openai-apikey/<model>`；無跨路由憑證後備。API GPT-5.6 列帶有 1,050,000 context / 922,000 max input 中繼資料，而 Pro 虛擬 id 以 `reasoning.mode: "pro"` 重寫為基礎 wire 模型。

`openaiProviderTierVersion: 2` 標記目前的單一供應商 projection。在遷移已出貨的 v1 設定前，opencodex 會在不替換不同備份的情況下建立 `config.json.pre-openai-tiers-v2.bak`，並將已知的舊版命名空間 selected id 重寫為裸 id。

## 供應商項目（`OcxProviderConfig`）

| 欄位 | 型別 | 意義 |
| --- | --- | --- |
| `adapter` | `string` | `openai-chat`、`openai-responses`、`anthropic`、`google`、`kiro`、`cursor`、`ollama-native`、`azure-openai`（或別名 `azure`）之一。 |
| `baseUrl` | `string` | 上游 API base URL。多數內建固定端點忽略不符；碰撞安全的金鑰預設保留較舊的同名自訂目的地。 |
| `requestPacing?` | `{ enabled, requestsPerMinute?, minIntervalMs?, models? }` | 選用的用戶端出站請求啟動節流，與上游用量、計費及限流指標彼此獨立。供應商限制適用於所有模型，`models` 依上游模型精確 ID 比對且只能增加延遲。排隊等待不計入回應標頭逾時。涵蓋 HTTP、Responses WebSocket 及明確的適配器 `fetchResponse`/`runTurn` 呼叫。 |
| `responsesPath?` | `string` | Key-auth `openai-responses` 請求的相對資源路徑。必須以 `/` 開頭且不含 scheme、query 或 fragment。 |
| `upstreamWebsocket?` | `boolean` | 為 `openai-responses` 請求選用上游 Responses WebSocket 傳輸（預設 `false`）。當上游支援此協定時，串流 POST 請求會使用設定的 Responses 路徑（預設 `/v1/responses`），透過 HTTPS 基礎 URL 以 WSS 連線，再重新編碼為一般流程使用的 SSE。forward 供應商使用 `{baseUrl}/responses`；key-auth 供應商使用 `responsesPath`，未設定時回退到傳統的 `/v1/responses`。一般 HTTP 仍使用 SSE；非 Responses 路徑與 `openai-chat` 請求仍使用 HTTP。 |
| `disabled?` | `boolean` | 將供應商保留在磁碟上但排除於路由與模型／目錄清單。 |
| `apiKey?` | `string` | API 金鑰，或在請求時解析的 `${ENV_VAR}` / `$ENV_VAR` 參考。 |
| `apiKeyTransport?` | `"x-api-key" \| "bearer"` | Anthropic 金鑰標頭風格。預設為原生 `x-api-key`；僅對 key-auth `anthropic` 供應商有效。 |
| `apiKeyPool?` | `ApiKeyPoolEntry[]` | 多金鑰池。`apiKey` 反映現用項目；每個項目有 `id`、`key`、可選 `label` 與可選數值 `addedAt`。 |
| `defaultModel?` | `string` | 在未指定明確模型時選擇此供應商所使用的模型。 |
| `models?` | `string[]` | 播種／後備模型清單。在 `liveModels: false` 時，這些是唯一探索的模型。 |
| `liveModels?` | `boolean` | 在啟動／同步時擷取即時目錄（預設 `true`）。自訂供應商使用 `${baseUrl}/models`；內建可能使用 registry URL 並過濾。 |
| `selectedModels?` | `string[]` | 探索後的目錄允許清單。非空時僅暴露那些 id；空或省略時暴露所有探索的模型。 |
| `contextWindow?` | `number` | 供應商範圍的 Codex 可見 context 上限。較小的即時中繼資料被保留。 |
| `modelContextWindows?` | `Record<string, number>` | Per-model context 上限。這些覆寫 `contextWindow` 且永不提高較小的即時中繼資料。 |
| `modelInputModalities?` | `Record<string, string[]>` | Per-model 輸入提示，如 `["text"]` 或 `["text", "image"]`。 |
| `modelMaxInputTokens?` | `Record<string, number>` | 用於目錄自動壓縮提示的正數 per-model max input 限制。 |
| `modelAutoCompactTokenLimits?` | `Record<string, number>` | Per-model 正安全整數型 soft 自動壓縮預算。此值只能降低「context 或 max input 的 90%」這個有效上限；沒有已知的權威 context window 時不會輸出。對 canonical `openai` 而言，key 必須是受支援的精確 native model ID，且不得含 provider 或 account-selector 前綴。Provider PATCH 會合併項目；將單一 key 設為 `null` 會刪除該 key，將整個欄位設為 `null` 會清空 map。這些 `null` tombstone 僅供 PATCH 使用。 |
| `defaultMaxOutputTokens?` | `number` | 當客戶端省略 `max_output_tokens` 時的供應商範圍 `openai-chat` 後備。 |
| `modelMaxOutputTokens?` | `Record<string, number>` | 正數 per-model `openai-chat` 後援預算；精確／模式比對勝過供應商預設。 |
| `headers?` | `Record<string, string>` | 額外上游標頭。Authorization、cookie、API-key 標頭、內嵌換行與無效名稱被拒絕。 |
| `openRouterRouting?` | `OpenRouterProviderRouting` | 預設 OpenRouter `order`、`only` 與 `allowFallbacks` 偏好；僅對規範 OpenRouter 搭配 `openai-chat` 有效。 |
| `modelOpenRouterRouting?` | `Record<string, OpenRouterProviderRouting>` | 取代供應商範圍 OpenRouter 偏好的精確 model-id 覆寫。 |
| `vercelGatewayRouting?` | `VercelGatewayRouting` | 預設 Vercel AI Gateway `order`、`only` 與 `sort`（`"cost"` \| `"ttft"` \| `"tps"`）偏好；僅對規範 Vercel AI Gateway 搭配 `openai-chat` 有效。 |
| `authMode?` | `"key" \| "forward" \| "oauth" \| "local"` | 認證模式（預設 `key`）。OAuth／訂閱憑證儲存在 `config.json` 之外；`local` 僅限其 registry 項目允許的供應商。 |
| `codexAccountMode?` | `"pool" \| "direct"` | 僅規範 `openai`；預設為池。Direct 繞過池狀態。 |
| `refreshPolicy?` | `"proactive" \| "lazy-only" \| "disabled"` | 覆寫此 OAuth 供應商的 Token Guardian 政策。 |
| `reasoningEfforts?` | `string[]` | 供應商範圍的 Codex reasoning 標籤，用於廣告與發送。 |
| `modelReasoningEfforts?` | `Record<string, string[]>` | Per-model 標籤。空清單隱藏 effort 控制。 |
| `modelSupportsReasoningSummaries?` | `Record<string, boolean>` | 將模型設為 `false` 以停止廣告摘要並剝離 summary-delivery 欄位。 |
| `modelReasoningSummaryDelivery?` | `Record<string, "sequential" \| "sequential_cutoff" \| "concurrent" \| "concurrent_cutoff">` | Per-model Responses delivery 列舉；重寫既有的 delivery 欄位。 |
| `modelAdapters?` | `Record<string, string>` | 混合 wire 閘道的 Per-model `openai-chat` 或 `openai-responses` wire 覆寫。明確項目勝過 registry 預設；DeepSeek 的預設可為 `deepseek-v4-flash` 選擇原生 Responses。單一 wire 上游 pin 與規範 ChatGPT forward 拒絕覆寫。 |
| xAI Responses 選用（儀表板） | 開關 | 僅用於 `xai`，以原子方式設定或清除 `grok-4.5` 與 `grok-4.6` 的 `modelAdapters` 項目。若只有一個項目，會顯示混合狀態，直到下次開關寫入統一兩者。其他覆寫與層級行為不變。 |
| `annotateEmptyToolOutputs?` | `boolean` | 在工具結果送達模型前，將已存在但為空的結果替換成簡短標記，使空白結果不會被解讀為遺漏的結果。適用於空白字串及僅含文字部分的陣列；影像、檔案及加密部分絕不會被更動。DeepSeek 透過內建登錄檔預設為 `true`，其他情況則不設定。設為 `false` 可讓供應商停用此功能；後續編輯即使省略此欄位，也會保留明確設定的 `false`。`PATCH /api/providers?name=<provider>` 接受 `true`、`false` 或 `null`；`null` 會清除覆寫並恢復使用登錄檔的預設行為。 |
| `xaiResponsesXSearch?` | `boolean` | 預設停用。在 xAI Responses 目的地上，僅當即時 `web_search` 工具通過最終請求正規化後仍保留時，才附加由供應商託管的 `x_search` 宣告。既有宣告不會重複，呼叫端的 `tool_choice`／`allowed_tools` 選擇器絕不會擴大，且此設定與網頁搜尋輔助服務的 `search.xSearch` 選項分開。 |
| `reasoningEffortMap?` | `Record<string, string>` | 供應商範圍的 reasoning 標籤 wire 別名。 |
| `modelReasoningEffortMap?` | `Record<string, Record<string, string>>` | Per-model 的 reasoning 標籤 wire 別名。 |
| `noReasoningModels?` | `string[]` | 拒絕 reasoning/thinking 參數的模型。 |
| `noTemperatureModels?` | `string[]` | 拒絕呼叫者指定 `temperature` 的模型。 |
| `noTopPModels?` | `string[]` | 拒絕呼叫者指定 `top_p` 的模型。 |
| `noPenaltyModels?` | `string[]` | 拒絕 presence/frequency penalty 的模型。 |
| `noStructuredOutputModels?` | `string[]` | 其 `openai-chat` 端點拒絕 `response_format` 的精確模型 ID。僅精確符合的請求模型會省略該欄位；structured-output 轉譯對其他每個 `openai-chat` 模型保持啟用。 |
| `parallelToolCalls?` | `boolean` | 切換平行工具呼叫。OpenAI Chat 預設開啟；非 chat adapter 僅在明確 `true` 時廣告。 |
| `responsesItemIdRepair?` | `{ message?: string[]; reasoning?: string[]; repairMissingTerminalIds?: boolean }` | 預設停用的下游 SSE 修復，用於精確佔位 id 與缺失的終端 id。Function-call id 永不被重寫。 |
| `transientRetryOn5xx?` | `{ enabled?: boolean; attempts?: number }` | 僅限使用金鑰認證的 `openai-chat` 供應商。選擇性重試串流開始前的暫時性上游狀態（500、502、503、504、520、521、522）：未設定時停用；只要有此物件即啟用，除非 `enabled: false`。涵蓋初始 `Responses` 請求、終止防護續接、原生 `/v1/chat/completions`，以及 429／帳號復原的重新擷取。`attempts` 是單一請求允許傳送至上游的總次數，包含第一次（1..10，預設 3）；這是與連線重設復原共用的單一請求範圍預算，因此 `3` 表示最多只有三個實際請求會送達供應商。等待採固定 400 毫秒、上限 5 秒的指數退避，並遵循 `Retry-After`。此機制獨立於處理速率限制的 `retryOn429`；串流中的失敗絕不重播。 |
| `autoToolChoiceOnlyModels?` | `string[]` | 其 `tool_choice` 僅接受 `auto` 或 `none` 的模型；強制選擇被降級。 |
| `preserveReasoningContentModels?` | `string[]` | 需要在 chat 歷史中保留先前 assistant `reasoning_content` 的模型。 |
| `reasoningDetailsModels?` | `string[]` | 以結構化 `reasoning_details` 陣列回傳思考內容的模型（啟用 `reasoning_split` 的 MiniMax M 系列）；串流增量為累積快照，以前綴差分處理，保留的推理以 `reasoning_details` 陣列而非 `reasoning_content` 字串重播。 |
| `thinkingToggleModels?` | `string[]` | 使用 `thinking.enabled` 而非 effort 階梯的 chat 模型。 |
| `thinkingBudgetModels?` | `string[]` | 使用整數 `thinking_budget` 的 chat 模型；effort 映射為預算比例。 |
| `noVisionModels?` | `string[]` | 透過視覺 sidecar 發送的純文字模型；比對容忍 Ollama `:size` 標籤。 |
| `escapeBuiltinToolNames?` | `boolean` | 為 Anthropic 相容閘道轉義內建工具名稱，並在回傳的呼叫中還原它們。 |
| `googleMode?` | `"ai-studio" \| "vertex" \| "cloud-code-assist"` | Google 傳輸／認證模式。預設 `ai-studio`。 |
| `project?` | `string` | Vertex 或 Antigravity Cloud Code Assist 專案 id。 |
| `location?` | `string` | Vertex 位置；環境後備為 `GOOGLE_CLOUD_LOCATION`。 |
| `mcpServers?` | `Record<string, CursorMcpServerConfig>` | 僅 Cursor：stdio 或 Streamable HTTP MCP 伺服器。 |
| `desktopExecutor?` | `DesktopExecutorConfig` | 僅 Cursor：外部 computer-use 與 record-screen 指令。 |
| `unsafeAllowNativeLocalExec?` | `boolean` | Cursor 舊版布林值，僅在較新欄位未設定時等同於 `nativeLocalExec: "on"`。 |
| `nativeLocalExec?` | `"off" \| "codex-sandbox" \| "on"` | Cursor 本機執行政策。`off` 為預設；`codex-sandbox` 目前像 `off` 般 fail closed。 |

API-key 供應商可持有字面值金鑰或環境參考。OAuth 供應商使用由 `ocx login` 填入的憑證存放；訂閱支援的 Claude Code 啟動行為在 [`claudeCode.authMode`](/zh-tw/reference/configuration/server/#claude-code) 下設定。

## 供應商診斷對外安全

儀表板連線測試與即時模型探索使用有界的 GET-only 傳輸。在沒有對外代理的情況下，opencodex 解析主機名稱一次並僅連接到該已驗證位址。HTTPS 保留原始 Host、SNI 與憑證驗證；供應商設定無法停用憑證檢查。

當 `HTTP_PROXY`、`HTTPS_PROXY` 或 `ALL_PROXY` 適用時，這些操作保留 Bun 的原生 fetch。URL 與字面位址檢查仍會執行，但代理選擇最終路由、DNS 答案與對等端，因此 opencodex 無法 pin 或驗證該對等端。這是明確的安全限制。

私有／本機目的地需要 `allowPrivateNetwork: true`，且當對外代理活躍時需要相符的 `NO_PROXY` 項目。回送會自動加入；請明確列出每個 LAN 主機，因為 CIDR 項目不被解讀。比對器支援精確主機、網域後綴、可選連接埠、方括號 IPv6 與 `*`；例如，明確列出 `192.168.1.50`。中繼資料與 link-link 目標保持被封鎖。診斷請求拒絕重新導向並回報已剝離憑證的目標。普通供應商請求的重新導向審查與此診斷防護分開。

## Codex 帳號池

在儀表板中使用 **Codex Auth** 新增池帳號並重新整理配額。`config.json` 儲存非秘密中繼資料；access 與 refresh token 使用強化的憑證存放。池路由將新／未綁定指派、基於用量的主動切換與失敗復原分開。綁定任務通常保留親和性，但 `quota` 可在其超過用量閾值後的下一個請求時重新綁定它，而暫停、冷卻、重新認證與失敗處理可獨立清除或移動路由。未綁定請求沒有即時帳號綁定；這可包含代理重啟或親和性重置後的既有可見任務。Pre-stream 的 429 或 402 在同一個請求中於一個合格的備用帳號上重試一次，即使基於用量的主動切換關閉。帳號變更保留並重播對話 context，但跨帳號的供應商端 prompt-cache 重用不保證，cache 可能需要重新暖機。

在 **401/403** 時，App 登入清除該帳號的行程本地親和性並要求重新認證。
在 **429** 時，opencodex 遵循 `Retry-After`、啟動帳號冷卻、清除親和性，並可能將請求輪換到另一個合格的池帳號。這些失敗轉換在 `autoSwitchThreshold: 0` 時仍然活躍；該設定僅停用基於用量的主動切換。

暫停帳號保留其配額中繼資料，但將其排除於切換、容錯移轉、復原探測與手動啟用。它也清除該帳號的執行緒親和性。進行中的請求保留擷取的憑證；後續回合被重新路由。若每個帳號都被暫停，池路由會失敗而非靜默選擇一個。**Pause exhausted** 會用可用憑證重新整理合格帳號，並僅暫停新確認為 100% 的帳號；未知或失敗的重新整理保持不變。

| 策略 | 行為 |
| --- | --- |
| `quota`（預設） | 若無現用帳號，跨 5 小時、週與 30 天視窗選擇最低用量的合格帳號。否則將合格現用帳號保持在 `autoSwitchThreshold` 以下；在超過閾值後，未綁定請求或綁定任務的下一個請求可移至較低用量的合格帳號。`0` 停用此用量驅動的重新評估，而非失敗復原。 |
| `round-robin` | 在合格帳號間均勻指派未綁定請求。`autoSwitchThreshold` 不變更一般 round-robin 選擇。`accountPoolStickyLimit`（1–100）計數一次選擇上的指派，而非成功的上游回應。 |
| `fill-first` | 將未綁定請求指派到現用帳號直到冷卻、重新認證或設定的排空閾值；未知用量不強制切換。健康的綁定任務保留親和性。 |

輪換不保護免於供應商強制執行；多帳號使用可能違反供應商條款。

### `anthropicAccountPool`（實驗性）

此選擇加入功能池化已儲存在 `auth.json` 中的多個 Anthropic OAuth 帳號。預設關閉且未經實戰考驗。同一組織中的帳號可能共享配額，而自動輪換可能觸發供應商限制。

| Key | 型別 | 預設值 | 說明 |
| --- | --- | --- | --- |
| `anthropicAccountPool.enabled?` | `boolean` | `false` | 啟用 sticky 親和性與 429 冷卻容錯移轉。 |
| `anthropicAccountPool.autoSwitchThreshold?` | `number` | `80` | 對於新 session，當目前帳號達到此閾值時，選擇設定視窗中最低的已知快取用量。`0` 停用配額挑選。 |
| `anthropicAccountPool.strategy?` | `"quota" \| "round-robin" \| "fill-first"` | `"quota"` | 新 session 策略；`quota` 依 `quotaWindow` 指定的視窗（預設為 5 小時列）為帳號排序，`fill-first` 也在同一視窗中判定其排空閾值。 |
| `anthropicAccountPool.quotaWindow?` | `"five-hour" \| "weekly" \| "max-utilization"` | `"five-hour"` | 使用量型帳號選擇所採用、由供應商回報並快取的用量列。`five-hour` 保留原有行為。`weekly` 使用每週用量列，並在仍有其他可用帳號時略過 5 小時用量已用盡的帳號；若沒有其他帳號，則退回使用這些帳號。`max-utilization` 使用已知值中的最高值，因此每週用量尚未取得時仍可使用 5 小時用量；兩者都未知時，帳號遵循 unknown 用量排序。已知用量排在 unknown 之前，但若所有可用帳號都是 unknown，仍會依可用順序選出一個。完成前述較低 5 小時用量的同分判定後，完全相同時也保留可用順序。不會主動重新平衡健康且已有 affinity 的 session。在分配新 session 與符合條件的 429 替代後進行路由復原時，`quota` 直接依此視窗排序可用候選帳號；`fill-first` 依此視窗的門檻與用盡規則按穩定順序前進；`round-robin` 忽略此設定。冷卻狀態、容錯移轉上限與重新驗證資格仍是獨立的本機狀態。每個帳號的每週用量只有在 dashboard 的供應商頁面完成查詢後才可得知。 |
| `anthropicAccountPool.stickyLimit?` | `number` | `1` | 在一次 round-robin 選擇上保留的成功新 session 綁定。範圍 1–100。 |

啟用時，429 記錄來自 `Retry-After` 或預設 backoff 的有界冷卻，並可能在請求內輪換。親和性為行程本地且有界。憑證 401/403 將帳號標記為需要重新認證。若所有合格帳號都在冷卻，客戶端收到附帶已知 `Retry-After` 的 429，而非認證錯誤。

:::caution[實驗性]
除非你了解 Anthropic 帳號政策風險，否則保持停用。不確定時偏好手動 `ocx account use anthropic <id>` 切換。
:::

### 受管記錄結構

`apiKeys[]` 項目包含 `id`、`name`、生成的 `key` 與 ISO `createdAt` 字串。
`codexAccounts[]` 項目需要 `id`、`email` 與 `isMain`，可選 `plan`、
`chatgptAccountId` 與隱私安全的 `logLabel`。這些記錄通常由儀表板管理。

### `tokenGuardian`（`OcxTokenGuardianConfig`）

| 欄位 | 型別 | 預設值 | 意義 |
| --- | --- | --- | --- |
| `enabled?` | `boolean` | `false` | 全域主動重新整理開關。 |
| `tickSeconds?` | `number` | `21600` | 掃描間隔（6 小時，最小 60 秒）。 |
| `jitterSeconds?` | `number` | `300` | 掃描前的隨機延遲。 |
| `concurrency?` | `number` | `3` | 最大同時重新整理。 |
| `leadSeconds?` | `number` | `900` | 超過一個 tick 的額外重新整理前置時間。 |
| `failureBackoffBaseSeconds?` | `number` | `300` | 初始暫時性失敗 backoff。 |
| `failureBackoffMaxSeconds?` | `number` | `3600` | Backoff 上限與永久失敗延遲。 |
| `codexWarmupEnabled?` | `boolean` | `false` | 選擇加入合成 Codex 池帳號驗證。 |
| `codexWarmupMaxAgeSeconds?` | `number` | `691200` | 8 天後重新驗證帳號。 |
| `codexWarmupModel?` | `string` | `gpt-5.4-mini` | 用於可選暖機的原生模型。 |

## 固定供應商端點

路由在 adapter 之前解析供應商端點。對於多數內建，registry 端點勝過設定的 `baseUrl`。四種項目類型保留設定的 URL：

- 啟用覆寫的供應商：`ollama`、`vllm`、`lm-studio`、`litellm`、`qwen-cloud` 與
  `alibaba-token-plan-intl`；
- 由使用者填入的 registry 模板，如 `azure-openai` 與 `cloudflare-ai-gateway`；
- 提升的固定 API-key 預設，保留較舊的同名自訂目的地；以及
- 不在 registry 中的供應商。

Adapter 可在之後調整解析的 URL。例如 Kiro 遵循匯入憑證的 API 區域，用於規範 `runtime.{region}.kiro.dev`。請見[Adapter](/zh-tw/reference/adapters/)。

當路由丟棄 `baseUrl` 時，opencodex 記錄 registry 端點與僅設定的來源；設定的路徑本身可能包含憑證。移除未使用的 URL 或選擇符合預期區域的供應商項目。`alibaba-token-plan` 被 pin 到北京，而
`alibaba-token-plan-intl` 涵蓋國際端點。

對於故障的 `openai-responses` 閘道，修復屬於供應商物件：

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

佔位清單為精確比對。對於正常／有狀態的 Responses 供應商，將欄位保持未設定，使 passthrough 保持逐位元組相同。

## Cursor 供應商（`adapter: "cursor"`）

Cursor 橋接為實驗性。在 `ocx login cursor` 後，新增或編輯 `providers.cursor`。
Cursor Router 的最佳化階梯以獨立的 Codex id 暴露，因為 picker 無法渲染 Cursor 專屬的模型參數：

| Codex 模型 | Cursor Router 模式 |
| --- | --- |
| `cursor/auto` | 團隊／帳號預設 |
| `cursor/auto-cost` | 成本 |
| `cursor/auto-balance` | 平衡 |
| `cursor/auto-intelligence` | 智慧 |

明確變體以其 `optimization` 參數發送 Cursor 的 `default` 模型，在每個請求上保留選擇。當即時探索省略 `default` 時，它們仍可用。

Cursor 伺服器驅動的本機工具預設停用。Codex 繼續使用其自身工具如 `apply_patch` 與 `exec_command` 及其自身的核准與沙箱政策：

- `"off"`（預設）拒絕 Cursor 原生的 `read`、`write`、`delete`、`ls`、`grep`、`shell` 與
  `fetch` 執行。
- `"on"` 選擇加入受信任的本機執行並繞過 Codex 核准／沙箱語意。
- `"codex-sandbox"` 為相容性而保留，但像 `"off"` 般 fail closed；請求文字不是可信的沙箱證明。

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

在 `providers.cursor` 上設定該欄位，而非頂層。在儀表板中使用 **Providers → Cursor
→ Edit JSON**，儲存後重啟。舊版 `unsafeAllowNativeLocalExec: true` 僅在 `nativeLocalExec` 未設定時等同於 `nativeLocalExec: "on"`。MCP、螢幕錄製與 computer use 分別由 `mcpServers` 與 `desktopExecutor` 控制。

每個 `mcpServers.<name>` 接受 `command`（stdio）或 `url`（Streamable HTTP）。Stdio 亦接受 `args`、`env` 與 `cwd`；HTTP 接受 `headers`。兩者皆支援 `enabled`（預設 true）與 `toolPrefix`。`desktopExecutor` 接受 `computerUseCommand`、`recordScreenCommand`、`cwd`、`env` 與 `timeoutMs`（預設 `30000`）。指令透過 `sh -c` 執行，從 stdin 讀取一個 JSON 請求，且必須向 stdout 寫入一個 JSON 結果。

:::caution[安全]
預設的回送綁定允許任何本機行程在無認證下存取，包含多使用者主機上的其他使用者。除非每個 data-plane 呼叫者都受信任且你刻意接受繞過 Codex 核可與沙箱語意，否則保持本機執行關閉。
:::

## OpenRouter 供應商路由

OpenRouter 可透過多個推論供應商提供一個模型。`openRouterRouting` 將請求保持在偏好的供應商上；`modelOpenRouterRouting` 為精確 model id 取代它。這對 prompt-cache 親和性很有用，因為 cache 支援、保留、命中率與定價因推論供應商而異。

供應商名稱為 OpenRouter slug。`allowFallbacks: false` 關閉失敗；`true` 在有序清單後允許另一個合格供應商。`only` 恆為允許清單。

```json
{
  "providers": {
    "openrouter": {
      "adapter": "openai-chat",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "${OPENROUTER_API_KEY}",
      "openRouterRouting": {
        "order": ["deepseek"],
        "allowFallbacks": false
      },
      "modelOpenRouterRouting": {
        "anthropic/claude-sonnet-5": {
          "only": ["anthropic"],
          "allowFallbacks": false
        }
      }
    }
  }
}
```

模型 key 為精確的原生 OpenRouter id，不含外層 opencodex 供應商前綴。選擇 `openrouter/anthropic-claude-sonnet-5` 會在套用模型規則前還原原生 `anthropic/claude-sonnet-5`。

## Vercel AI Gateway 供應商路由

Vercel AI Gateway 可在多個底層推論供應商之間路由一個模型。`vercelGatewayRouting` 設定供應商範圍偏好；`modelVercelGatewayRouting` 會針對精確模型 ID 取代它。若兩者皆未設定，`resolveVercelGatewayRouting()` 會回傳 `undefined`，因此 Chat 請求建構器會省略 `provider` 欄位，讓 Vercel AI Gateway 保留其預設的動態路由行為。

- `order`：依優先順序排列的 Vercel AI Gateway 上游供應商 slug。
- `only`：限制合格 Vercel AI Gateway 上游供應商的明確允許清單。
- `sort`：依 `"cost"`（最低成本）、`"ttft"`（首個權杖時間）或 `"tps"`（每秒權杖數）自動排序合格供應商。

```json
{
  "providers": {
    "vercel-ai-gateway": {
      "adapter": "openai-chat",
      "baseUrl": "https://ai-gateway.vercel.sh/v1",
      "apiKey": "${VERCEL_AI_GATEWAY_KEY}",
      "vercelGatewayRouting": {
        "sort": "ttft"
      },
      "modelVercelGatewayRouting": {
        "zai/glm-5.2": {
          "only": ["novita", "deepinfra"],
          "order": ["novita", "deepinfra"]
        }
      }
    }
  }
}
```

模型 key 是不含外層 OpenCodex 供應商前綴的 Vercel 公開模型選擇器。選擇 `vercel-ai-gateway/zai-glm-5.2` 時，會先還原原生 `zai/glm-5.2`，再套用模型規則。相同映射也適用於原生 `vercel/<model-id>` 選擇器：在 OpenCodex 中使用編碼後的 `vercel-ai-gateway/vercel-<model-id>` 選擇器，並保留 `vercel/<model-id>` 作為模型 key。

## 靜態模型允許清單

設定 `liveModels: false` 以僅暴露 `models`。若 `models` 為空或省略，供應商暴露無路由模型。即時探索在快取前拒絕超過 4 MiB 或 2,000 個原始模型列；內建預設可能使用較低限制並過濾到 chat 合格列。過大或格式錯誤的結果遵循過時／設定的後備。有效的零合格結果恆為權威，且不被靜默取代或截斷。

當探索應仍然執行但只有 selected id 應出現在 Codex 與 `/v1/models` 時，請使用 `selectedModels`。儀表板保留完整的探索清單供日後允許清單變更。

預覽 GPT-5.6 後備項目使用相同機制。OpenAI API-key 預設以 context `922000` 與 max input `922000` 播種基礎與 Pro id；OpenRouter 以 context `922000` 播種 `openai/gpt-5.6-sol`、`openai/gpt-5.6-terra` 與 `openai/gpt-5.6-luna`。池／Direct 廣告 `922000`；同步目錄廣告 `max` 同時保持 `xhigh` 獨立。

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

## 完整範例

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
