---
title: Grok Build
description: 透過 xAI 的 Grok Build CLI 使用任何由 opencodex 路由的模型——代理程式執行期間會將模型自動註冊到 ~/.grok/config.toml。
---

opencodex 在本機埠提供 OpenAI 相容的 `POST /v1/chat/completions`（以及 `/v1/responses`），而 Grok Build 支援對 OpenAI 相容伺服器使用自訂模型。從此整合開始，opencodex 會自動將其整個可見目錄註冊到 Grok Build——無需手動編輯設定。

## 自動註冊

當 `~/.grok` 存在時，`ocx start`（以及 `ocx ensure` / `ocx restart`）會將一個受管理區塊寫入 `~/.grok/config.toml`：

```toml
# >>> opencodex managed block — do not edit (removed by `ocx stop`) >>>
[model_providers.opencodex]
base_url = "http://127.0.0.1:10100/v1"
api_backend = "responses"
api_key = "opencodex-loopback"
extra_headers = { "x-opencodex-grok" = "1" }

[model.ocx-gpt-5-6-sol]
model = "gpt-5.6-sol"
model_provider = "opencodex"
name = "OCX gpt-5.6-sol"
context_window = 272000
supports_reasoning_effort = true
reasoning_effort = "low"

[[model.ocx-gpt-5-6-sol.reasoning_efforts]]
id = "low"
value = "low"
label = "Low"
description = "Quick, fast implementations"
default = true
# ... remaining rungs for this model, then one [model.ocx-*] table per visible model,
# each referencing model_provider = "opencodex" ...
# <<< opencodex managed block <<<
```

- **累加式：** 圍欄外你自己的設定絕不會被動到。在首次注入既有檔案前，會寫入一次性備份到 `~/.grok/config.toml.bak-opencodex`。
- **冪等：** 每次 `ocx start`（以及啟用 autostart 時的 `ocx ensure`）都會以目前目錄取代圍欄區塊。
- **拆除時移除：** `ocx stop`、`ocx eject`、`ocx uninstall`，以及非服務模式常駐程序的優雅關閉，都會剝除圍欄區塊並逐位元組還原你的檔案。在服務管理員之下，拆除會經由 `ocx stop`/`ocx uninstall` 進行（服務模式程序會刻意在重新產生時保留該區塊）。
- **衝突安全：** 你自己的 `[model.*]` 表格中已定義的別名會被尊重（opencodex 會為自己的項目加上後綴）；若圍欄損壞（有開始標記但無結束標記），會拒絕任何自動變更並要求手動修復。

然後在 Grok Build 內挑選模型：

```bash
grok models          # lists ocx-* entries alongside native grok models
grok -m ocx-anthropic-claude-opus-4-8 -p "hello"
# or in the TUI: /model ocx-anthropic-claude-opus-4-8
```

## 推理 effort

Grok Build 的 `/effort`（以及 `--effort`）只對目錄條目宣告了階梯的模型有效：它的模型清單擷取會讀取
原始的 `GET /v1/models` 回應，而該處的條目必須帶有 `supports_reasoning_effort` 以及
`reasoning_efforts` 選單選項。這組階梯經 Grok 相容投影後會寫入每個受管理的 `[model.*]` 表格，包括
`supports_reasoning_effort`、預設 `reasoning_effort`，以及
`[[model.<alias>.reasoning_efforts]]` 選項列。對已路由的模型條目，opencodex 會映射設定的
供應商階梯（`reasoningEfforts` / `modelReasoningEfforts`，以及
`modelDefaultReasoningEfforts` 的預設值）。這份中繼資料描述 proxy 設定的路由階梯；adapter 可以模擬
reasoning，或把檔位對映到供應商專用欄位。階梯清單為空的模型不會顯示 effort 控制項。原生 GPT-5.6
條目會保留固定於上游的 reasoning 階梯。模型宣告的有效 Grok 檔位（包括 `none` 與 `minimal`）都會
保留。不受支援或重複的檔位（包括 Codex 專用的 `ultra`）會從檔案省略，確保寫出的每個選項都能實際使用。

Grok Build 透過 Responses API 與 opencodex 通訊。當路由宣告推理階梯時，Responses 直通會按
設定轉發 `reasoning.summary`，因此推理軌跡會以 Responses reasoning 項目的形式原生送達 Grok。
需要模型執行推理且不回傳軌跡的用戶端，可以設定 `reasoning.summary: "none"`。明確設定的
`reasoning.summary` 優先於路由預設值。

## 認證注意事項

即使在 loopback 上，Grok Build 也要求自訂模型有非空的 API 金鑰。注入的項目會帶上占位值（`opencodex-loopback`）——opencodex 會忽略 loopback 連線的 admission key，因此不涉及真實金鑰。

**自動註冊僅限 loopback。** 當 opencodex 綁定非 loopback 主機時——包含會暴露所有介面的萬用字元 `0.0.0.0` 與 `::`——請求需要你的真實 admission token，而受管理區塊無法安全地承載它。把字面 token 寫進去會把你的金鑰放進 `~/.grok/config.toml`，並在下一次 `ocx start`/`ensure`/`restart` 時覆寫你在那裡設定的任何內容。因此在這種情況下 opencodex 完全不寫入（並會移除先前 loopback 綁定留下的任何區塊），而你要在受管理標記之外自行設定模型，opencodex 就無法覆寫它們。精確的表格請見[手動配方](#manual-recipe-without-auto-registration)，並同時設定 `base_url`（你執行 `grok` 之處實際可達的主機）與 `api_key`（你的 `OPENCODEX_API_AUTH_TOKEN`）。

此處不要用 `env_key` 取代 `api_key`。無法解析的 `env_key` 不會中止請求——Grok 會回退到你的 xAI 工作階段 token，並把它送到該項目所命名的任何 `base_url`；對 LAN 部署而言，那是一個並非 xAI 的明文 HTTP 端點。

注入在 provider 條目上的 `api_key` 在這些模型的 Grok 憑證鏈中排在第一位，因此對 opencodex 的回合不需要額外的 Grok 登入。請為原生 grok 模型，以及任何直接聯絡 xAI 的 harness 功能，保留你平常的 `grok login` / `XAI_API_KEY` 設定。

## 手動配方（不使用自動註冊） {#manual-recipe-without-auto-registration}

若你自行管理 `~/.grok/config.toml`——或 opencodex 綁定在非 loopback——請在 `# >>> opencodex managed block` 標記之外，新增一個 `[model_providers.opencodex]` 區塊以及引用它的 per-model 表格：

```toml
[model_providers.opencodex]
base_url = "http://127.0.0.1:10100/v1"
api_backend = "responses"
api_key = "opencodex-loopback"

[model.ocx-opus]
model = "anthropic/claude-opus-4-8"
model_provider = "opencodex"
```

對於可經由網路連線的代理程式，將 `base_url` 指向 `grok` 實際可撥號的位址，並使用你的 admission token：

```toml
[model_providers.opencodex]
base_url = "http://192.168.1.10:10100/v1"   # the reachable host, not 127.0.0.1
api_backend = "responses"
api_key = "your-OPENCODEX_API_AUTH_TOKEN"

[model.ocx-opus]
model = "anthropic/claude-opus-4-8"
model_provider = "opencodex"
```

託管區塊現在使用 `[model_providers.<id>]` 繼承，需要 Grok Build 0.2.109 或更高版本（發布於 2026-07-21）。在更早的版本上，繼承的 `base_url` 不會套用到推論路由——請升級，或在每個 `[model.*]` 表上使用逐模型直接欄位（`base_url`/`api_backend`/`api_key`）。

含有點號的別名請加上引號：裸的 `[model.grok-4.5]` 是三段式鍵路徑，而不是 id `grok-4.5`。產生的別名因此完全避免點號。

## 已知限制

- **以服務安裝的 `ocx restart`：** 執行中的代理負責重啟授權與排空協調；舊行程結束後，由已安裝且可用的服務管理員再拉起替換行程。服務監督會維持安裝狀態。在 loopback 自動註冊下，受管理區塊也會在交接期間保留；非 loopback 部署則改用手動管理的 Grok 設定。只有在同一連接埠上確認另一個經過身分驗證且健康的行程後，此命令才會成功。
- **以服務安裝的 `ocx restart`：** 執行中的代理負責重啟授權與排空協調；舊行程結束後，由已安裝且可用的服務管理員再拉起替換行程。服務監督會維持安裝狀態。在 loopback 自動註冊下，受管理區塊也會在交接期間保留；非 loopback 部署則改用手動管理的 Grok 設定。只有在同一連接埠上確認另一個經過身分驗證且健康的行程後，此命令才會成功。
- **設定讀取時機：** 先啟動 opencodex，再啟動 `grok`，結果最可預期。Grok Build 會監看 `~/.grok/config.toml`，並在 `[model]` 表格實際變更時重新載入（約一秒 debounce，依內容比對），因此重新整理後的區塊可在不重啟的情況下到達開啟中的工作階段。若要確認 Grok 解析了什麼，執行 `grok inspect`：它會列出已載入的設定來源，並對任何被拒絕的欄位發出警告。它不會印出解析後的模型清單。目前的 Grok Build 會回報並略過無效的模型欄位，同時保留該模型條目的其餘內容。TOML 語法錯誤仍會阻止檔案載入。opencodex 會以原子方式寫入檔案，因此 Grok 每次重新載入時都會看到完整文件。
- **目錄更新：** 圍欄區塊反映注入當下的目錄。新增供應商或模型後，請執行 `ocx ensure`（或重啟代理程式）以重新整理它。
