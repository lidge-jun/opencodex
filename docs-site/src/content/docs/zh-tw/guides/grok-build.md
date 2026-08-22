---
title: Grok Build
description: 透過 xAI 的 Grok Build CLI 使用任何由 opencodex 路由的模型——代理程式執行期間會將模型自動註冊到 ~/.grok/config.toml。
---

opencodex 在本機埠提供 OpenAI 相容的 `POST /v1/chat/completions`（以及 `/v1/responses`），而 Grok Build 支援對 OpenAI 相容伺服器使用自訂模型。從此整合開始，opencodex 會自動將其整個可見目錄註冊到 Grok Build——無需手動編輯設定。

## 自動註冊

當 `~/.grok` 存在時，`ocx start`（以及 `ocx ensure` / `ocx restart`）會將一個受管理區塊寫入 `~/.grok/config.toml`：

```toml
# >>> opencodex managed block — do not edit (removed by `ocx stop`) >>>
[model.ocx-gpt-5-6-sol]
model = "gpt-5.6-sol"
base_url = "http://127.0.0.1:10100/v1"
api_backend = "responses"
api_key = "opencodex-loopback"
name = "OCX gpt-5.6-sol"
# ... one [model.ocx-*] table per visible model ...
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
`reasoning_efforts` 選單選項。對已路由的模型條目，opencodex 會把設定的供應商階梯
（`reasoningEfforts` / `modelReasoningEfforts`，以及 `modelDefaultReasoningEfforts` 的預設值）
映象到該回應上。這份中繼資料描述的是 proxy 設定的路由階梯——它不代表原生產品的 reasoning 支援，
而 adapter 可能模擬 reasoning 或把檔位對映到供應商專用欄位。設定了階梯的路由模型在 Grok Build 中
會顯示 effort 控制項，就像在 Codex 中一樣。階梯清單為空的模型不會保留 effort 控制項，這也與
Codex 行為一致。原生 GPT-5.6 條目則分開處理：它們保留並暴露固定於上游的 reasoning 階梯，而不是
供應商設定的路由中繼資料。

## 認證注意事項

即使在 loopback 上，Grok Build 也要求自訂模型有非空的 API 金鑰。注入的項目會帶上占位值（`opencodex-loopback`）——opencodex 會忽略 loopback 連線的 admission key，因此不涉及真實金鑰。

**自動註冊僅限 loopback。** 當 opencodex 綁定非 loopback 主機時——包含會暴露所有介面的萬用字元 `0.0.0.0` 與 `::`——請求需要你的真實 admission token，而受管理區塊無法安全地承載它。把字面 token 寫進去會把你的金鑰放進 `~/.grok/config.toml`，並在下一次 `ocx start`/`ensure`/`restart` 時覆寫你在那裡設定的任何內容。因此在這種情況下 opencodex 完全不寫入（並會移除先前 loopback 綁定留下的任何區塊），而你要在受管理標記之外自行設定模型，opencodex 就無法覆寫它們。精確的表格請見[手動配方](#manual-recipe-without-auto-registration)，並同時設定 `base_url`（你執行 `grok` 之處實際可達的主機）與 `api_key`（你的 `OPENCODEX_API_AUTH_TOKEN`）。

此處不要用 `env_key` 取代 `api_key`。在未設定 `model_provider` 時，無法解析的 `env_key` 不會中止請求——Grok 會回退到你的 xAI 工作階段 token，並把它送到該項目所命名的任何 `base_url`；對 LAN 部署而言，那是一個並非 xAI 的明文 HTTP 端點。

注入的 per-model `api_key` 在這些模型的 Grok 憑證鏈中排在第一位，因此對 opencodex 的回合不需要額外的 Grok 登入。請為原生 grok 模型，以及任何直接聯絡 xAI 的 harness 功能，保留你平常的 `grok login` / `XAI_API_KEY` 設定。

## 手動配方（不使用自動註冊） {#manual-recipe-without-auto-registration}

若你自行管理 `~/.grok/config.toml`——或 opencodex 綁定在非 loopback——請在 `# >>> opencodex managed block` 標記之外，以**直接欄位**新增 per-model 表格：

```toml
[model.ocx-opus]
model = "anthropic/claude-opus-4-8"
base_url = "http://127.0.0.1:10100/v1"
api_backend = "responses"
api_key = "opencodex-loopback"
```

對於可經由網路連線的代理程式，將 `base_url` 指向 `grok` 實際可撥號的位址，並使用你的 admission token：

```toml
[model.ocx-opus]
model = "anthropic/claude-opus-4-8"
base_url = "http://192.168.1.10:10100/v1"   # the reachable host, not 127.0.0.1
api_backend = "responses"
api_key = "your-OPENCODEX_API_AUTH_TOKEN"
```

不要依賴 `[model_providers.<id>]` 繼承端點：截至 Grok Build 0.2.101，繼承的 `base_url` 並不會套用到推論路由（請求會回退到預設 xAI 代理並以 401 失敗）。直接的 per-model 欄位才能正確路由。

含有點號的別名請加上引號：裸的 `[model.grok-4.5]` 是三段式鍵路徑，而不是 id `grok-4.5`。產生的別名因此完全避免點號。

## 已知限制

- **以服務安裝的 `ocx restart`：** 當 opencodex 在服務管理員下執行時，`ocx restart` 目前會停止服務並以非受管程序取代——服務持續性（自動重啟、開機啟動）會遺失，直到下次 `ocx service` 設定；若該非受管程序死亡，受管理區塊可能指向已死的代理程式，直到下一次 `ocx start`/`ocx ensure` 重新整理它。
- **設定讀取時機：** 先啟動 opencodex，再啟動 `grok`，結果最可預期。Grok Build 會監看 `~/.grok/config.toml`，並在 `[model]` 表格實際變更時重新載入（約一秒 debounce，依內容比對），因此重新整理後的區塊可在不重啟的情況下到達開啟中的工作階段。若要確認 Grok 解析了什麼，執行 `grok inspect`：它會列出已載入的設定來源，並對任何被拒絕的欄位發出警告。它不會印出解析後的模型清單。請注意，單一 TOML 錯誤會使*整個*使用者設定層失效，這也是 opencodex 以原子方式寫入檔案的原因——Grok 永遠看不到半寫入的設定。
- **目錄更新：** 圍欄區塊反映注入當下的目錄。新增供應商或模型後，請執行 `ocx ensure`（或重啟代理程式）以重新整理它。
