---
title: 整合
description: 從儀表板把 opencodex 連接到 OpenCode、Pi、OMP、Hermes、OpenClaw、Kimi Code、Gajae Code、DeepSeek Harness 與 MiniMax Code——每個客戶端一個開關，每次寫入前都會先備份。
---

**整合（Integrations）** 分頁會把 opencodex 的 provider 區塊寫入客戶端自己的設定檔，也會把它移除。共有九個客戶端以這種方式運作，每個都有一個開關：

| 客戶端 | 設定檔 | 格式 | 變更生效時機 | 憑證 |
|---|---|---|---|---|
| OpenCode | `~/.config/opencode/opencode.json` | JSON | 下次直接啟動 | `OPENCODEX_OPENCODE_API_KEY` |
| Pi | `~/.pi/agent/models.json` | JSON | 新 sessions | loopback 佔位符 |
| OMP | `~/.omp/agent/models.yml` | YAML | 重新啟動 OMP 後 | `opencodex-loopback` 佔位符 |
| Hermes | `~/.hermes/config.yaml` | YAML | 新 sessions | `OPENCODEX_HERMES_API_KEY` |
| OpenClaw | `~/.openclaw/openclaw.json` | JSON5 | 立即，在執行中的 gateway 上 | `OPENCODEX_OPENCLAW_API_KEY` |
| Kimi Code | `~/.kimi-code/config.toml` | TOML | 重新啟動時，或 `/reload` | loopback 佔位符 |
| Gajae Code | `~/.gjc/agent/models.yml` | YAML | 新 sessions，或當你開啟 `/model` 時 | `OPENCODEX_GAJAE_API_KEY` |
| DeepSeek Harness (DSH) | `$DSH_HOME/settings.yaml`（預設 `~/.dsh/settings.yaml`） | YAML | 熱重載 | 非秘密的 loopback bearer 佔位符 |
| MiniMax Code | `~/.minimax/config.yaml` | YAML | 新 sessions，或開啟模型選擇器後 | loopback 佔位符 |

受管理 DSH 支援的相容性下限是 **DSH 0.1.0-rc.6**。OpenCodex 只擁有
`llm-pi-ai.providers.opencodex`：Apply 與 Refresh 會取代該片段，Disable 只移除該片段，
Restore 則放回已記錄的快照。DSH 會熱重載 provider 變更。這些操作不會改動使用者的
預設模型，也不會改動原生 `deepseek-official` provider。受管理 DSH 整合目前僅支援
loopback，而且絕不會寫入真實憑證。

MiniMax Code 依序遵循 `MINIMAX_DATA_DIR`、`MAVIS_DATA_DIR`，最後才回退到
`~/.minimax`。其受管理區塊只擁有 `custom_provider.opencodex`，不會變更
`defaultModel`、MiniMax 憑證來源或使用者的 MiniMax 登入。連接後請在 MCode
中選擇 `custom_provider:opencodex/<provider/model>`。重新整理整合也會更新有可靠來源的
逐模型 context window 與 reasoning-effort 選項；未知能力會省略，而 MCode session
目前選取的 effort 不會被覆寫。

路徑遵循客戶端自己的環境覆寫（environment override）。對 OMP 而言，`OMP_PROFILE` 以存在與否優先於 `PI_PROFILE`，即使明確為空也一樣。具名 profile 會把 `PI_CONFIG_DIR` 當作相對於使用者家目錄的目錄名稱，並忽略 `PI_CODING_AGENT_DIR`；沒有具名 profile 時，`PI_CODING_AGENT_DIR` 勝出。OMP 支援 provider 層級的 headers，但這個最初的整合刻意只支援 loopback；遠端 `x-opencodex-api-key` 的連線設定被延後。搬移過的 `HERMES_HOME`、`KIMI_CODE_HOME` 與 `XDG_CONFIG_HOME` 路徑同樣會被遵循，而非猜測。表格列出每個客戶端的預設值。

對原生 OpenAI 模型，產生的 OMP 區塊會選用其模型層級的 Responses API，保留圖片輸入與 reasoning-effort 控制。路由模型則維持 provider 的 Chat Completions 方言，讓它們既有的 adapters 保持相容。

OpenClaw 有數個環境變數，各自負責不同的工作。`OPENCLAW_CONFIG_PATH` 選擇檔案；`OPENCLAW_STATE_DIR`、`OPENCLAW_PROFILE` 與 `OPENCLAW_HOME` 選擇狀態目錄，而偵測看的也是狀態目錄——所以 profile 或搬移過的家目錄仍會被視為已安裝，而 config 路徑覆寫只移動檔案。如果你還在用舊的 `.clawdbot` 配置，那也會被找到：現代目錄存在時勝出，只有舊目錄存在時才使用舊的。

這些必須是**絕對路徑**或以 `~` 開頭。相對路徑會被拒絕而非解析，因為它會指向各程序恰巧啟動時所在的目錄——而該路徑會與備份一起儲存，所以它明天必須指向與今天相同的檔案。

opencodex 從自己的環境讀取這些變數。如果你的 gateway 以 profile 或搬移過的家目錄執行，請以相同的變數啟動 opencodex，否則它會正確地遵循另一個安裝。

## 其他四個介面不是開關

**API Keys** 管理 opencodex 自己的憑證，根本不是客戶端。**Codex CLI** 由 proxy 服務本身連接——啟動 opencodex 即套用，停止即回復原生路由——所以沒有什麼需要逐檔切換。**Claude** 保留自己的啟用旗標與 Desktop 的 Save/Apply 流程，**Grok Build** 保留其先選後套用的模型圍欄（model fence）。那些語意早於這項功能，且維持不變。

## 回復（Rollback）

每次成功的寫入都會*先*為你的檔案拍快照，所以你原本的狀態永遠可以回復：

- **Undo** 會出現在最新操作上，當你的檔案仍與我們寫入的內容相符時。
- **Restore this point…** 會出現在較舊的操作上，或當檔案在那次操作之後有變更時。跨過這樣的變更做回復會再詢問一次，才覆蓋你的較新編輯——並且也會備份它們，所以那次的回復本身也可以復原。
- 每個客戶端保留十份備份。超過之後，最舊的快照檔案會被移除，其歷史列顯示為 **Backup expired**。

停用只移除 opencodex 記錄為自己寫入的條目。如果你的檔案在我們寫入之後有變更，後續行為取決於我們自己的條目是否完好，以及檔案的格式。對於嚴格 JSON 設定檔（OpenCode、Pi），在我們的區塊**旁邊**進行的編輯——例如新增 MCP 伺服器或你自己的 provider——會顯示為**需要更新**：重新整理會在保留你的條目的前提下合併寫入，但格式可能會被正規化。例外情況是 JSON 無法精確重寫的內容——例如 `1e999` 這類非有限數字、重寫會被四捨五入的數字（極大的整數，或小到會塌縮成零的數字）、`-0`、同一個物件裡重複出現的鍵，或巢狀層數超過 1000 層——此時開關會鎖定，確保沒有任何值被悄悄改動或刪除。**OMP** 同樣不受旁邊編輯影響，但原因不同：它的 writer 只逐位元組修補自己的 `providers.opencodex` 範圍，檔案其餘部分從不會被重寫。至於其餘可以包含註解的格式（Hermes、OpenClaw、Kimi Code、Gajae Code、MiniMax Code——以整份文件寫出的 YAML、JSON5 與 TOML），或當我們自己的條目被編輯過時，開關會鎖定，停用會拒絕執行，而不是猜測哪些編輯是你的。

## 誠實的預期

**格式通常不會被保留。** 套用會解析設定並重新寫出，所以 JSON、JSON5 與 TOML 可能被重新格式化，JSON5 或 TOML 中的註解會遺失。OMP 與 DSH 是例外：它們的 YAML writer 分別只修補 `providers.opencodex` 與 `llm-pi-ai.providers.opencodex`，逐位元組保留無關的 provider 註解與格式。如果無法安全地識別那個確切的來源範圍，操作會拒絕執行。對其他客戶端，當你需要先前的檔案位元組時請使用 Restore：快照是逐字的副本。

**如果某個值無法忠實重寫，開關會拒絕執行。** 往返覆蓋這些格式在實務上會用到的值種類；當它做不到時——例如使用 `inf` 或 `nan` 的 TOML 檔案，我們可用的 parser 無法準確讀回——套用會停止並說明，而不是寫入被改動的值然後宣稱成功。你會看到檔案被指名，磁碟上沒有任何東西被移動。手動編輯那個檔案仍然有效；只有我們的自動重寫會拒絕。

**Pi、Kimi Code、Gajae Code、MiniMax Code 與受管理 DSH 整合只能對 loopback bind 運作。** 前四者的設定沒有非 loopback bind 所需的 `x-opencodex-api-key` header 欄位。DSH 雖然提供通用 headers map，但 rc.6 並未把這個專用准入 header 記錄為受支援的整合契約，因此受管理 writer 會選擇安全拒絕，而不自行猜測。請改用 SSH tunnel，或由本機 forwarder 加上該 header 後再以 loopback 存取。

**產生的 OMP 整合也刻意只支援 loopback。** OMP 確實支援 provider 層級的 headers，但這個最初的整合不會發出遠端 `x-opencodex-api-key` 憑證連線。手動的遠端 OMP 設定目前不在受管理的整合範圍內。

**Kimi Code 無法持有環境變數參考，** 所以它的設定攜帶的是 `opencodex-loopback` 佔位符而非金鑰。絕不會有任何真實憑證被寫入任何客戶端設定。

**對 `ocx opencode` 而言，launcher 的 provider 區塊勝出。** 那個 launcher 透過 `OPENCODE_CONFIG_CONTENT` 注入 `provider.opencodex`，比磁碟上相同的條目優先——你其餘的 opencode 設定仍照常套用。當你直接啟動 `opencode` 時，這裡的開關才是關鍵。

## 從終端機

相同的操作可以無頭模式使用：

```bash
ocx integration client status
ocx integration client enable --client hermes
ocx integration client disable --client hermes
ocx integration client history --client hermes
ocx integration client restore --op <opId> [--confirm-drift]
```

`--overwrite-conflict` 是 **Replace** 的終端形式：

```bash
ocx integration client enable --client zcode --overwrite-conflict
```

和 `--confirm-drift` 一樣，它永遠不會被預設：沒有這個旗標，衝突仍然會被拒絕。
它只適用於 `enable`；對衝突強制 *disable* 會刪除我們從未寫入的區塊，因此這個組合會被拒絕。

MiniMax Code 先連接一次 provider，再透過會檢查設定的 launcher 啟動：

```bash
ocx integration client enable --client mcode
ocx mcode
```

完成一次連接後，`ocx sync` 也會以目前的 context window 與 reasoning-effort 階梯更新
OpenCodex 已擁有的 MCode 區塊。若區塊已刪除、遭外部修改、不安全或從未由 OpenCodex
建立，sync 會保持原檔不動；只有在你確定要重新連接時才再次執行 enable。

另一個 MiniMax 平台 CLI（`mmx`）不是檔案開關整合。其文字命令使用 MiniMax 的
Anthropic 相容端點，因此 OpenCodex 提供憑證隔離、僅限 loopback 的 launcher：

```bash
ocx mmx text chat --model anthropic/claude-opus-5 --message "Hello"
ocx mmx text repl --model openai/gpt-5.6-sol
```

只有 `mmx text chat` 與 `mmx text repl` 會經過 proxy。MiniMax 原生的其他指令請直接
執行 `mmx`。wrapper 使用只含非機密 loopback 佔位符的暫存設定，不會讀取 `~/.mmx`
OAuth 或 API key，並拒絕 `--api-key`、`--base-url` 與 `--region` 覆寫。

`--confirm-drift` 永遠不會被擅自假設。如果檔案在你正要回復的操作之後有變更，指令會拒絕並告訴你，因為覆蓋你較新的編輯是你的決定。

客戶端細節是針對各專案自己的設定格式驗證過的；檢查了什麼、何時檢查，請見 `devlog/_fin/260802_client_toggle_api/002_client_toggle_matrix.md` 中的研究筆記。
