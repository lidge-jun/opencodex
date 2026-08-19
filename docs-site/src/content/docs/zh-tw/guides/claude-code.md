---
title: Claude Code 指南
description: 在 Claude Code 中使用任意已路由模型——opencodex 在同一埠提供 Anthropic Messages API 和閘道器模型發現功能。
---

opencodex 在 `/v1/responses` 之外還提供 `POST /v1/messages`（以及 `count_tokens`），因此 Claude
Code 可以使用每一個已路由的供應商——包括 OAuth 登入、帳號池、金鑰故障轉移和 sidecar——
而無需進行任何額外的身分驗證設定。

## Claude OAuth 帳號池（實驗性）

你可以透過 Providers 儀表板登入多個 Claude 帳號（`ocx login anthropic` / add-account）。預設
每個請求只使用**作用中**帳號。

**實驗性、opt-in** 的 Claude 帳號池（`anthropicAccountPool.enabled`）會在這些 OAuth 帳號之間加入
sticky session affinity 與 429 冷卻故障轉移。僅對**新**工作階段，`anthropicAccountPool.strategy`
會在合格帳號之間選擇：`quota`（預設）在用量高於 `autoSwitchThreshold` 時挑選已知 5 小時用量最低者；
`round-robin` 平均分散（`stickyLimit`，預設 `1`）；`fill-first` 一直使用作用中帳號直到冷卻、重新認證
或達到閾值，然後前進。它**預設關閉**、會在 GUI 顯示警告，而且尚未經過實戰驗證——Anthropic 可能
限制看起來像自動輪換的帳號；輪換並不能保護你免受供應商執行機制的處置。

啟用時的營運契約：

- 上游 **429** 會讓該帳號冷卻（有 `Retry-After` 時使用它，否則用預設 backoff）、清除其 affinity，
  並可能在同一個請求內輪換到另一個合格帳號（有上限）。
- Affinity 是**程序本機**的（proxy 重啟後就會遺失）。
- **401/403** 憑證失敗會隔離該帳號（`needsReauth`），直到重新認證前都不會參與選擇。
- 如果每個合格帳號都在冷卻，proxy 會回傳 **429**（不是 401），並在已知時附上 `Retry-After`。

請見 [Configuration](/zh-tw/reference/configuration/#anthropicaccountpool-experimental)。

## 快速入門

```bash
ocx claude
```

`ocx claude` 會確保代理正在執行，然後在接好環境變數的情況下啟動 Claude Code：

| 變數 | 值 |
| --- | --- |
| `ANTHROPIC_BASE_URL` | `http://127.0.0.1:<port>` |
| `ANTHROPIC_AUTH_TOKEN` | 僅在代理要求 API 金鑰時設定——否則不會設定，因此你的 claude.ai 登入（訂閱 + 聯結器）會保持有效 |
| `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` | `1`（原生 `/model` 選擇器發現） |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | 自動上下文壓縮閾值（預設 `829800`）；僅在啟用自動上下文時注入 |
| `ANTHROPIC_MODEL` | `claudeCode.model`（可選） |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `claudeCode.tierModels.haiku ?? claudeCode.smallFastModel`（可選，也包括舊版 `ANTHROPIC_SMALL_FAST_MODEL`） |
| `ANTHROPIC_DEFAULT_{OPUS,SONNET,FABLE}_MODEL` | `claudeCode.tierModels.*`（可選） |
| `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT` | 啟用 `alwaysEnableEffort` 時設為 `1`（條件注入） |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` / `DISABLE_COMPACT` | 設定 `maxContextTokens` 時使用的舊版上下文覆蓋項（條件注入） |
你自行匯出的變數始終優先。額外引數會直接透傳：`ocx claude -p "hello"`。

## 認證模式

Claude Code 需要在 `ANTHROPIC_AUTH_TOKEN` 中有 token 才能與閘道器通訊，但設定該變數也會停用
你的 claude.ai 登入及其聯結器。你要哪一種，取決於 opencodex 可以查到的狀態，因此預設會自動判斷。

在 **Claude → Claude Code** 中把 **認證模式** 保持為 **自動**（預設值），opencodex 會在每次
啟動時決定：

| 偵測結果 | 行為 |
| --- | --- |
| 有 Claude 登入（`~/.claude.json` 的 OAuth 帳號、`.credentials.json`、macOS keychain，或已匯出的 `ANTHROPIC_API_KEY`） | 不設定 token，讓你的訂閱與聯結器繼續運作 |
| 完全沒有 Claude 認證 | 注入佔位 token，讓 Claude Code 不再要求登入，並經由代理路由 |
| 無法判斷（keychain 無法讀取、檔案損毀） | 假設為訂閱並印出警告——讀取失敗時絕不會把付費訂閱者改成走代理 |

此判斷會在每次啟動時重新計算，不會被記住，因此登入或登出會在下一次 `ocx claude` 時自動生效，
無需重新設定。

若要固定行為，請明確選擇 **Subscription** 或 **Proxy**。明確選擇會寫入 `claudeCode.authMode`，
之後即使登入狀態改變，偵測也不會覆寫——包括你稍後登入或登出。切回自動即可把決定權交回。

在 macOS 上，自動連線（`claudeCode.systemEnv`）也遵循相同解析邏輯，因此在 `ocx` 之外直接啟動的
`claude` 行為一致。該檔案是代理啟動或你儲存設定時重新整理的快照，而 `ocx claude` 則一律即時解析。

## Claude Desktop 設定檔

Claude Desktop 使用與 Claude Code 分開的設定檔。在儀表板開啟 **Claude → Desktop**，可把每條
可用路由放到四個系列之一：Opus、Fable、Sonnet 或 Haiku。新設定檔中所有路由一開始都在 Opus。
第一個 Opus 路由會成為整體初始預設，且每個非空系列都一定會有一個系列預設。

若要改系列，可以把列拖到另一個系列。拖曳是可選的：每一列也都有可用滑鼠、觸控或鍵盤操作的
移動控制項。使用 **設為預設** 選擇系列預設，再選 **儲存並套用到 Desktop**。允許空系列。若已
儲存的預設暫時不可用，會改用該系列中第一個可用路由，直到原預設回來。

你也可以用命令列管理同一份設定檔：

```bash
ocx claude desktop [apply]
ocx claude desktop show [--json]
ocx claude desktop move <route> <opus|fable|sonnet|haiku> [--default]
ocx claude desktop default <opus|fable|sonnet|haiku> <route|none>
ocx claude desktop export <path|->
ocx claude desktop import <path> [--apply]
```

`ocx claude desktop` 與 `apply` 都會把目前設定檔寫入 Claude Desktop。`show` 提供可讀摘要；加上
`--json` 方便腳本使用。`export -` 會把帶版本的 JSON 寫到標準輸出。Import 會在儲存前驗證完整
檔案，因此無效檔案不會改動目前設定檔。加上 `--apply` 可在匯入有效設定檔後立即寫入 Desktop。
`none` 僅適用於空系列；每個非空系列都必須保留一個預設。

非 Anthropic 路由會得到穩定別名，例如 `claude-opus-4-8-2026MMDD`。看起來像日期的部分是合成的
路由槽位，不是模型釋出日期。真正的 Anthropic Claude 路由保留真實 id。新路由預設落在 Opus
系列，但移動路由不會改變它所呼叫的供應商或模型。舊版 apply 旗標 `--static`、`--hybrid` 與
`--discovery-only` 仍可供既有腳本使用。

## 系統環境整合

當 `claudeCode.systemEnv` 設定為 `true`（預設：**關閉**）時，`ocx start` 會使用 `launchctl setenv`
在系統範圍內注入 `ANTHROPIC_BASE_URL` 和相關的 Claude Code 環境變數。因此，新開啟的終端視窗和
標籤頁可以直接透過代理路由普通的 `claude` 命令，無需使用 `ocx claude` 包裝器。已經開啟的
shell 不受影響，必須重新開啟。

`ocx stop` 和代理關閉操作會**取消設定已注入的鍵**（不會恢復之前的值——只會移除 opencodex
注入的鍵）。代理還會寫入 `~/.opencodex/claude-env.sh`；`ocx start` 會安裝一個 `.zshrc`
source hook，以自動載入該檔案，但僅限 `PATH` 中存在可執行的 Claude Code CLI。Claude Code
不存在或系統環境整合未啟用時，啟動程序和 `ocx ensure` 會移除 OpenCodex 自己寫入的 hook。
Claude Desktop 使用獨立 profile，不會觸發 shell hook 安裝。

可以在設定中設定 `claudeCode.systemEnv: false`，或使用 GUI 開關來停用。此功能僅適用於
macOS；在其他平臺上，請使用 `ocx claude`。

## 原生 Claude 透傳（訂閱直通）

未設定身分驗證覆蓋時，Claude Code 會保留其 claude.ai OAuth 登入，並將其傳送給代理。
對於未被任何別名或模型對映佔用的真正 `claude*`/`anthropic*` 模型，請求會連同你的憑證
**原樣**轉發到 `api.anthropic.com`——beta、思考簽名、提示快取和計費身份都保持完全原生，
而已路由模型仍可在同一會話中透過選擇器別名使用。

**標頭處理：**轉發前一律移除逐跳標頭以及 `host`、`content-length`、
`accept-encoding`、`x-opencodex-api-key` 和 `origin`。在非回環綁定上，原生透傳還要求透過
`x-opencodex-api-key` 提供有效的代理許可憑證；此時 `Authorization` 與 `x-api-key` 僅屬於
Anthropic。若任一供應商標頭含有代理許可密鑰，該密鑰會被移除，而另一標頭中的真正供應商
憑證會保留。以逗號合併的模糊憑證標頭不會被轉發。

只有同時滿足以下所有條件時才會觸發透傳：`nativePassthrough` 不為 `false`；模型以
`claude` 或 `anthropic` 開頭；bearer token 或 `x-api-key` 以 `sk-ant-` 開頭；並且別名/模型對映
解析後回傳的模型保持不變；且在非回環綁定上，專用代理許可標頭有效。這也意味著使用 `ocx claude` 時不再出現
“claude.ai connectors are disabled”警告。

可以設定 `claudeCode.nativePassthrough: false` 來停用；也可以透過
`claudeCode.anthropicBaseUrl` 指向其他位置。

## /model 選擇器（“From gateway”）

Claude Code 2.1.129+ 透過 `GET /v1/models?limit=1000` 發現閘道器模型，並在原生 `/model`
選擇器中以“From gateway”標籤列出。由於選擇器只接受以 `claude` 或 `anthropic` 開頭的 ID，
opencodex 會將已路由模型公開為穩定且可逆的別名：

| 介面 | 格式 | 示例 |
| --- | --- | --- |
| Claude Code CLI | `claude-ocx-<provider>--<model>` | `claude-ocx-native--gpt-5.6-sol` |
| Claude Desktop 3P | `claude-opus-4-8-<code>`（3 字元 base36 雜湊） | `claude-opus-4-8-ncb` |

代理會按請求選擇別名族：`?ids=cli` 或 `?ids=desktop` 優先；否則，`claude-code/*`
user-agent 會獲得易讀的 CLI 形式，其他用戶端會獲得 Desktop 雜湊形式。兩種別名族都會永久
保持可解碼——以任一形式儲存在 `settings.json` 中的模型都能繼續工作。
每個條目帶有誠實的顯示名（如 `gemini-3-pro (gemini)`），並以官方 ModelInfo 形態附帶完整模型
能力（推理強度階梯、thinking 型別），使 Claude Desktop 的第三方閘道器模式能夠提供其推理強度
選擇器。真實 Anthropic 模型保留其規範 id。合成的 2026 日期是內部槽位，不是釋出日期。舊版雜湊
別名與較舊設定中的 `claude-ocx-<provider>--<model>` id 仍可解析。
擁有權威 1M 上下文視窗的模型會多出一個 `…[1m]` 選擇器列：選中後 Claude Code 會按完整 1M 上下文
計算該模型（自動壓縮仍開啟）——代理在路由前會去掉該標記。
選中後會儲存到 Claude Code 的 `settings.json` `model` 欄位；入站請求會將別名解析回路由
模型。在較舊的 Claude Code 版本中，選擇器保持原生——可透過 `ANTHROPIC_MODEL` 設定槽位，或在
`/model` 中輸入任意已路由 id（Claude Code 會原樣傳遞字串）。

**別名語法規則：**provider 不得包含 `/` 或 `--`，也不得等於 `native`；model 不得包含
`/`。易讀形式無法表達的路由會回退到雜湊別名。模型 ID **可以**包含 `--`（解析時只按第一個
`--` 拆分）；包含 `--` 的原生 slug 會回退到雜湊形式。

**模型解析順序：**移除 `[1m]` 標記 → 解碼易讀別名 → 解碼 Desktop 雜湊別名 →
`modelMap` 精確匹配 → 移除日期後的匹配（移除 `-20250514`）→ 透傳。

每個條目都帶有類似 `gemini-3-pro (gemini)` 的顯示名稱，以及官方 `ModelInfo` 結構中的完整
模型能力（推理強度階梯、思考型別）。真正的 Anthropic 模型在兩個介面上都保留其規範 ID。

### 上下文變體 `[1m]` 標記

權威上下文視窗為 1M 的模型（或者啟用自動上下文時，視窗大於 200k 且至少達到壓縮閾值的模型）
會多出一個帶 `…[1m]` 的選擇器條目。選擇它後，Claude Code 會按完整的 1M 上下文計算。
代理會在進行別名解析和路由之前移除不區分大小寫的 `[1m]` 字尾。

## 自動上下文（突破 200k 上限的大上下文模型）

對於任何無法識別的模型，Claude Code 都會按 200k token 計算。預設開啟的**自動上下文**可解決
這一問題：

1. 實際視窗大於 200k **且**至少達到自動壓縮閾值的模型，其選擇器條目和環境變數槽位會帶有
   `[1m]` 標記。
2. 系統會注入 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`（預設 `829800`，範圍 `100000`–`1000000`），
   使對話在該位置自動進行摘要。

設定有三種狀態：

- **缺省 / `true`：**啟用（預設）
- **`false`：**停用——不新增標記，也不注入壓縮視窗
- **設定了舊版 `maxContextTokens`：**隱式停用自動上下文

可以在 Claude 頁面調整壓縮值。**警告：**如果將其提高到超過模型的實際視窗，該模型將無法正常
工作——聊天會在觸發摘要之前報錯。

低於 1M 的原生 Anthropic 模型絕不會被自動標記。你自行匯出的值始終優先（代理會使用**你的**
值來判斷哪些模型可以安全標記）。手動編輯設定時填入的無效值會回退到 829,800。

### 有效模型環境變數

`effectiveModelEnv` 會計算由 `ocx claude` / 系統環境 / shell 檔案注入的六個槽位：
`ANTHROPIC_MODEL`、四個 `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL`，以及舊版
`ANTHROPIC_SMALL_FAST_MODEL`。有效 Haiku 值為 `tierModels.haiku ?? smallFastModel`，並會
提供給兩個 Haiku 變數。

當 `tierModels.haiku` 和 `smallFastModel` 均未設定時，OpenCodex 會讓兩個輔助模型變數保持未設定；隨後 Claude Code 會選擇其原生輔助模型（目前為 Sonnet），並可能產生原生供應商費用。

## 名冊代理（injectAgents）

`ocx claude`（以及系統環境 daemon）會把你的精選子代理名冊（Subagents 標籤頁，最多 5 個模型）
和 `ocx-self` 同步到 `~/.claude/agents/ocx-*.md`。

- **`ocx-self`** 固定你在 `/model` 選擇器中的預設模型（回退到 `claudeCode.model`）；兩者均
  不存在時省略。它**不**使用模型繼承。
- 每個代理正文都包含一條 `<!-- ocx-route: <model> -->` 指令——代理使用該指令固定實際路由。
  因此 Agent 工具的 `model` 引數不起作用；請傳入 `"haiku"` 作為佔位符。
- Frontmatter 攜帶別名；路由由指令驅動。
- 只有包含 `generated-by: opencodex` 且透過標記驗證的 `ocx-*.md` 檔案才會被覆蓋或清理；
  你自己的代理絕不會被改動。
- 檔案按單個檔案進行原子同步（寫入 + 重新命名）。
- `enabled: false` 或 `injectAgents: false` 會清理所有經驗證歸屬的定義。
- GUI PUT 和名冊變更會立即重新同步；啟動器/系統環境會在啟動時同步。

派發方式：`subagent_type: "ocx-gpt-5-6-sol"`。支援 1M 的目標會自動攜帶 `[1m]`。

## 內建技能省略（blockedSkills）

Claude Code 內建的 `claude-api` 技能會注入約 840KB（約 136k token）的 Anthropic 文件內容，
並在提及 Claude 模型時自動觸發。已路由模型並未針對該文件包進行訓練，因此預設情況下，
opencodex 會在**已路由**請求中將該技能內容替換為一個短佔位說明。原生 Anthropic 透傳不受影響。

**會處理兩種載體：**

1. **工具結果載體：**assistant 的 `Skill(...)` 呼叫——當轉為小寫的 JSON 輸入包含被遮蔽名稱時，
   與之配對的 `tool_result` 正文會被替換為佔位說明。
2. **文字塊載體：**以 `Base directory for this skill: ` 開頭且不少於 10,000 字元的使用者
   文字塊——當目錄 basename 等於被遮蔽名稱時匹配（不區分大小寫）。

透過 `claudeCode.blockedSkills` 設定（預設 `["claude-api"]`；`[]` 會完全停用省略）。
佔位說明會保持工具呼叫/結果的配對關係不變。

## 模型對映（攔截）

`claudeCode.modelMap` 會在路由前重寫傳入的 Anthropic 模型 ID：

```json
{
  "claudeCode": {
    "modelMap": {
      "claude-sonnet-4-5": "gemini/gemini-3-pro",
      "claude-haiku-4-5": "gemini/gemini-3-flash"
    }
  }
}
```

查詢順序：發現別名 → 精確 ID → 移除日期字尾的 ID（`-20250514`）→ 透傳。

## Sidecar 矩陣：Web Search 與圖像理解

不同路由模型擁有的託管工具和圖像能力並不相同。opencodex 會在主模型回答前補齊這些能力：

- **Web-search sidecar** 執行真實的託管搜尋，再把答案和來源作為工具結果交給路由模型。
- **Vision sidecar** 在呼叫 `noVisionModels` 中的模型前描述附件圖像，並用文字描述替換圖像。

兩個 sidecar 都可使用以下任一後端：

| 後端 | 執行方式 | 所需條件 |
| --- | --- | --- |
| `openai` | 透過 ChatGPT `forward` provider 呼叫小型 GPT 模型 | ChatGPT 登入，以及已啟用的 `authMode: "forward"` provider |
| `anthropic` | 透過已儲存的 Anthropic OAuth 呼叫 Claude；Web Search 使用 `web_search_20250305`，Vision 讓 Claude 描述圖像 | 已啟用的 `adapter: "anthropic"`、`authMode: "oauth"` provider，且其活動帳號未標記 `needsReauth` |

顯式設定的 `backend` 始終優先。省略時，如果存在可用的 Anthropic OAuth 活動帳號，則選擇
`anthropic`；否則選擇 `openai`。顯式選擇 `anthropic` 卻沒有可用憑證時會**關閉失敗
（fail closed）**：不會借用 ChatGPT 憑證，也不會靜默切換後端。同樣，OpenAI 後端缺少 ChatGPT
登入或 forward provider 時不會啟用。

Claude 入站的路由重放會把主 ChatGPT 登入附加到內部請求，因此即使 Claude Code 的 bearer 僅用於
代理認證，OpenAI sidecar 仍可存取。該 ChatGPT bearer 不會傳送給主路由 provider。

```json
{
  "webSearchSidecar": {
    "backend": "anthropic",
    "model": "claude-sonnet-5",
    "maxSearchesPerTurn": 3
  },
  "visionSidecar": {
    "backend": "anthropic",
    "model": "claude-sonnet-5",
    "maxDescriptionsPerTurn": 8
  }
}
```

`maxDescriptionsPerTurn` 限制一個主模型 turn 中新增的圖像描述次數。快取命中和同一 turn 內重複的
進行中描述不會消耗配額。成功的 `data:` 圖像描述會按後端、模型、detail、圖像位元組和請求上下文
快取，避免每次重放都重複描述同一圖像與上下文。內容可能變化的遠端 `https:` 圖像不會快取。

全部設定項見[設定參考](/zh-tw/reference/configuration/#sidecars)。Anthropic OAuth Web
Search 和圖像描述沿用儲存庫已有的 Claude Code OAuth fingerprint 先例，但在用於長時間無人值守任務前，
仍應使用你的帳號和實際負載進行充分 soak test。

<!-- TODO(WP5 GUI): GUI 控制元件完成後補充 sidecar 設定頁面操作說明。 -->

## 推理強度

Claude Code 的 `/effort` 設定會完整保留並傳遞給適配器：

| 傳輸格式 | 對映 |
| --- | --- |
| `thinking.type: "adaptive"` + `output_config.effort` | 直接傳遞強度（`minimal`\|`low`\|`medium`\|`high`\|`xhigh`\|`max`\|`ultra`） |
| `thinking.type: "enabled"` + `budget_tokens` | ≤4096→`low`，≤16384→`medium`，更高→`high` |
| `thinking.type: "disabled"` | `reasoning: { effort: "none" }`；省略摘要 |

解析後的值會顯示在請求日誌的 **Reasoning effort** 列中。

## 入站轉換（Messages → Responses）

代理會將每個 Anthropic Messages API 請求轉換為 Codex Responses API 格式：

| Messages 輸入 | Responses 輸出 |
| --- | --- |
| 頂層 `system` | `instructions`（文字塊以 `\n\n` 連線） |
| `messages[].role: "system"` | 同樣合併到 `instructions` |
| 使用者文字 / 圖像 | `input_text` / `input_image`（base64 → data URL） |
| Assistant 文字 | `output_text` |
| Assistant `tool_use` | `function_call`（`input` → JSON 字串化的 `arguments`） |
| 使用者 `tool_result` | `function_call_output`（`is_error` → `[tool error]` 字首） |
| 重放 `thinking` / `redacted_thinking` | 丟棄 |
| Function 工具 | `{type: "function"}`（`web_search*` → `{type: "web_search"}`） |
| `tool_choice` | `auto`→`auto`，`none`→`none`，`any`→`required`，指定名稱 function→`{type:"function",name}`，hosted WebSearch/web_search→`{type:"web_search"}` |
| `max_tokens` | `max_output_tokens` |
| `stop_sequences` | `stop` |

**錯誤情況（400）：**JSON 格式錯誤；缺少/空的 `model`；缺少/空的 `messages`；不支援的
role；`tool_result` 缺少 `tool_use_id`；`tool_use` 缺少 id/name；指定名稱的 `tool_choice`
缺少 name。

## 出站轉換（Responses → Messages SSE）

| Responses 事件 | Messages SSE |
| --- | --- |
| `response.created` | `message_start` + `ping` |
| 心跳 | `ping` |
| 文字增量 | `content_block_start` → `content_block_delta`（文字）→ `content_block_stop` |
| 推理摘要/文字 | 帶合成簽名的 `thinking` 塊 |
| Function-call 幀 | 帶 `input_json_delta` 的 `tool_use` 塊 |
| 終止事件 | `message_delta` → `message_stop` |
| 在終止事件前 EOF | 502 風格的 `api_error` |

**停止原因對映：**`completed` → `tool_use`（如果有工具呼叫）或 `end_turn`；
`incomplete/max_output_tokens` → `max_tokens`；`incomplete/content_filter` → `refusal`。

**錯誤分類：**400 `invalid_request_error`、401 `authentication_error`、
402 `billing_error`、403 `permission_error`、404 `not_found_error`、409 `conflict_error`、
413 `request_too_large`、429 `rate_limit_error`、504 `timeout_error`、529 `overloaded_error`，
其他 5xx 為 `api_error`。`Retry-After` 會保留。

## 提示快取與 token 用量

**Anthropic 路由請求：**適配器會管理工具、系統內容和倒數第二條使用者訊息的快取斷點，以及頂層
自動 `cache_control`。穩定輪次通常能達到約 99.9% 的快取命中率。

**原生 OpenAI/ChatGPT 路由：**派生會話範圍的 `prompt_cache_key`（存在時取自
`metadata.user_id`，否則回退到系統內容雜湊）和用於快取親和性的 `session_id` 標頭。
快取鍵包含模型和完整的工具 schema。

**Token 計算：**Anthropic 輸出會從 `input_tokens` 中減去 `cached_tokens` 和
`cache_write_tokens`，並將它們分別公開為 `cache_read_input_tokens` 和
`cache_creation_input_tokens`。請求日誌會將其對映回包含這些值的 `inputTokens`，讀取量同時
記錄在 `cachedInputTokens` 和 `cacheReadInputTokens` 中，寫入量記錄在
`cacheCreationInputTokens` 中。Usage 頁面會分別報告快取命中和快取建立。

**count_tokens：**已路由模型使用近似值（序列化後的 system + messages + tools）。使用
`sk-ant-` 憑證的原生 Anthropic 模型會將請求透傳到真實的 Anthropic
`/v1/messages/count_tokens` 端點。

## 除錯捕獲

`ocx debug claude on|off|status|reset`、`OCX_CLAUDE_DEBUG=1` 或
`PUT /api/debug {"claude": true}` 控制入站捕獲。`GET /api/claude/inbound-debug` 回傳
`{enabled, entries}`（最新條目在前，環形緩衝區大小為 20）。

每個條目記錄：`at`、`endpoint`、`model`、`resolvedModel`、`stream`、`maxTokens`、
`thinkingType`、`thinkingBudgetTokens`、`outputConfigEffort`、`metadataKeys`、
`hasMetadataUserId`、`hasSystem`、原始 `anthropicBeta`，以及 user id / system 的八字元
HMAC 等值標籤。**不會儲存提示文字、原始物件或跨執行穩定的雜湊。**停用 Claude 除錯會立即
清空環形緩衝區。

## GUI（Claude 頁面）

儀表板側邊欄有一個專用的 **Claude** 頁面（位於 API 下方）和 **Claude ON** 開關
（標籤特意在所有語言中保持一致）。該頁面顯示：

- 入站總開關（啟用開關）
- 快速入門（`ocx claude`）和手動環境變數塊
- Fast Mode 選擇器（Auto / ON / OFF）
- 自動上下文開關和壓縮閾值下拉選單
- 子代理自動註冊開關
- 模型攔截（modelMap）編輯器
- 選擇器別名即時預覽

`GET /api/claude-code` 回傳有效預設值、設定、上下文視窗登錄表、有效環境變數、可用路由 ID、
別名和埠。`PUT /api/claude-code` 接受部分更新並保留省略的欄位；`null` 會重置
context/blocklist/compact-window 值。

## 疑難排解

**Claude Code 顯示“Did 0 searches”**——目前版本會把已完成的 Responses
`web_search_call` 轉換成配對的 Anthropic `server_tool_use` 和 `web_search_tool_result` block，
並寫入 `usage.server_tool_use.web_search_requests`。如果舊版本已經完成搜尋卻仍計為 0，請更新
opencodex。

**Sidecar 未啟用**——使用 `backend: "openai"` 時，請確認已登入 ChatGPT，並存在已啟用的
`authMode: "forward"` provider。使用 `backend: "anthropic"` 時，請確認已儲存的 Anthropic
OAuth 活動帳號未標記 `needsReauth`。顯式選擇 Anthropic 卻沒有可用憑證時會按設計關閉失敗。

**“claude.ai connectors are disabled”**——你的 shell 中設定了 `ANTHROPIC_API_KEY` 或
`ANTHROPIC_AUTH_TOKEN`。`ocx claude` 特意**不會**設定 `ANTHROPIC_API_KEY`；如果你已將其
匯出，請取消設定。`ocx claude` 會注入 `ANTHROPIC_BASE_URL`、發現相關變數、自動上下文和已設定的模型槽位，但絕不會注入 `ANTHROPIC_API_KEY`。

**模型未顯示在 /model 選擇器中**——確認已設定
`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`（使用 `ocx claude` 時會自動設定）。執行
`ocx claude` 以重新整理 `~/.claude/cache/gateway-models.json` 中的閘道器模型快取。檢查
`claudeCode.enabled` 不為 `false`。

**埠更改後環境變數過時**——如果代理埠發生變化，舊 shell 中的
`ANTHROPIC_BASE_URL` 可能已經過時。請開啟一個新終端，或重新執行 `ocx claude`。

**大模型仍受 200k 上下文上限限制**——在選擇器中選擇 `[1m]` 變體，或啟用自動上下文
（預設開啟）。如果選擇器中沒有 `[1m]` 條目，該模型的權威上下文視窗可能低於自動壓縮閾值。

**技能載入導致 token 數量過高**——內建的 `claude-api` 技能（約 136k token）會在提及
Claude 模型時自動載入。對於原生透傳，這是正常現象；對於已路由模型，opencodex 預設會將其
替換為佔位說明（`blockedSkills: ["claude-api"]`）。

**子代理派發到錯誤模型**——名冊代理（`ocx-*`）使用 `<!-- ocx-route: ... -->` 指令，
而不是 Agent 工具的 `model` 引數。請確保指令與預期路由一致。傳入 `"haiku"` 作為模型佔位符。
