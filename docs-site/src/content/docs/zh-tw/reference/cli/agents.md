---
title: CLI 代理、路由與整合
description: 多代理、組合、可觀測性、存取、整合、系統與設定指令。
---

這些指令控制代理政策與路由、檢查即時代理，並將支援的客戶端連接至 opencodex。

## 代理政策

### `ocx agent <status|injection|effort|subagents|fallback|sidecar> ...`

管理無頭多代理名冊、effort 上限、prompt 注入、fallback 與 sidecar 設定。使用 `status` 查看目前政策。關於介面模式、委派、effort 與 fallback 行為如何搭配運作，請見[子代理介面](/zh-tw/guides/sub-agent-surface/)。

```bash
ocx agent subagents set ark/model-a,openai/gpt-5.5
```

### `ocx v2 <status|on|off|mode <v1|default|v2>|threads <n>>`

管理 Codex 的 `multi_agent_v2` 功能旗標與三態多代理介面模式。

| 子指令 | 動作 |
| --- | --- |
| `status`（預設） | 回報目前 v2 旗標、多代理模式與執行緒並行數。 |
| `on` | 啟用 `multi_agent_v2` 功能並重新同步目錄。 |
| `off` | 停用 `multi_agent_v2` 功能並重新同步目錄。 |
| `mode v1` | 將所有模型強制為 v1、停用原生 v2，並保留現用執行緒上限。 |
| `mode default` | 遵循上游模型介面 pin。 |
| `mode v2` | 將所有模型強制為 v2、啟用原生 v2，並保留現用執行緒上限。 |
| `threads <n>` | 將現用 v1/v2 執行緒上限設為不小於 1 的整數。 |

```bash
ocx v2 status
ocx v2 mode v1
ocx v2 mode default
ocx v2 on
ocx v2 threads 16
```

`mode` 子指令將 `multiAgentMode` 寫入 opencodex 設定並重新同步 Codex 目錄。模式與旗標轉換會在有效的 v1/v2 Codex key 之間移動目前的數值執行緒上限；失敗的轉換會還原原始的 `config.toml`。變更套用於新的 Codex session，執行中的 session 則保留其 pin 的介面。

## 組合路由

### `ocx combo <list|show|set|remove> ...` · `ocx route combo ...`

管理組合 failover 與 round-robin 虛擬模型。`ocx route combo` 是階層式別名；組合是目前支援的路由資源。目標使用
`provider/model[:weight],provider/model[:weight]`。

```bash
ocx combo list
ocx route combo set reliable --targets ark/model-a:2,openai/gpt-5.5
```

關於路由行為與設定指引，請見[組合](/zh-tw/guides/combos/)。

## 可觀測性與除錯

### `ocx observe <logs|usage|storage|memory|debug|claude-inbound|injection> ...`

檢查代理請求、用量、儲存、記憶體與除錯資料。直接別名如下：

| 別名 | 等效資源 |
| --- | --- |
| `ocx logs [filters] [--follow] [--json|--jsonl]` | `ocx observe logs` |
| `ocx usage [--range <7d|30d|all>] [--surface <all|codex|claude|grok>] [--json]` | `ocx observe usage` |
| `ocx storage [--json]` | `ocx observe storage` |
| `ocx memory [--json]` | `ocx observe memory` |

```bash
ocx observe usage --range 30d --json
```

### `ocx debug <provider|usage|injection|claude> <on|off|status|reset|logs [-f]>`

透過執行中代理的管理 API 讀取或變更執行階段除錯覆寫。

```bash
ocx debug provider on|off|status|reset
ocx debug provider logs [-f|--follow]
ocx debug usage on|off|status|reset
ocx debug usage logs [-f|--follow]
```

無 scope 時，`ocx debug` 印出用量，並在代理停止時印出下次啟動的環境預設值。供應商除錯預設來自 `OCX_DEBUG=1`（舊版 `OCX_DEBUG_FRAMES=1` 亦可）；用量除錯預設來自 `OPENCODEX_USAGE_DEBUG=1`。

## API 存取

### `ocx access <key|endpoints|models|test> ...`

管理 OpenCodex 許可 API 金鑰並檢查外部端點與模型。`ocx api-key
<list|create|remove> ...` 是 `ocx access key` 的別名。

```bash
ocx access key create deployment
```

## 客戶端整合

### `ocx integration <claude|grok> ...`

管理支援的 Claude 與 Grok 整合。下方的直接指令家族暴露其客戶端專屬控制。

### `ocx claude [claude args...]`

確保代理正在執行，然後以 `ANTHROPIC_BASE_URL`、
`ANTHROPIC_AUTH_TOKEN`、`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`，以及來自
`config.claudeCode` 的模型插槽啟動 Claude Code。在 Claude Code 2.1.129 或更新版本中，路由模型會透過穩定的插槽別名出現在原生 `/model` 選擇器中。在舊版本上，請用 `ANTHROPIC_MODEL` 或 `/model <id>` 選擇。使用者匯出的 `ANTHROPIC_*` 變數恆優先。

Claude Desktop 設定檔指令如下：

```text
ocx claude desktop [apply]                         儲存並套用四家族設定檔
ocx claude desktop show [--json]                   顯示路由、家族與預設值
ocx claude desktop move <route> <family> [--default]
ocx claude desktop default <family> <route|none>
ocx claude desktop export <path|->                 匯出版本化 JSON（`-` = stdout）
ocx claude desktop import <path> [--apply]         驗證並匯入 JSON
```

家族為 `opus`、`fable`、`sonnet` 與 `haiku`；新路由從 `opus` 開始。`none` 僅在該家族為空時有效。舊版套用旗標 `--static`、`--hybrid` 與 `--discovery-only` 仍受支援。請用 `ocx claude config <status|set> ...` 管理 Claude Code 設定。

### `ocx opencode [opencode args...]`

確保代理正在執行，然後在 OpenCode 的內嵌執行階段層（`OPENCODE_CONFIG_CONTENT`）中以生成的 `provider.opencodex` 區塊啟動 opencode。既有的內嵌設定會被保留，本次啟動僅替換 `provider.opencodex`。全域或專案的 `opencode.json` 檔案可能被讀取以警告既有的覆寫，但磁碟上的檔案永不修改。路由模型以
`opencodex/<provider>/<model>` 出現。之後啟動普通 `opencode` 的行為與之前完全相同。

### `ocx grok <status|exclude|include|set|clear|apply> ...`

管理並套用 Grok Build 模型圍欄。

## 客戶端設定匯出

### `ocx export --client <opencode|pi>`

印出連接到執行中代理的客戶端設定。opencode 與 [Pi](/zh-tw/guides/pi/) 從其自身的 JSON 設定而非環境變數讀取供應商，因此此指令將 `opencodex` 供應商區塊——base URL、模型清單與客戶端的環境變數參考——序列化，供你合併到該檔案中。

代理必須正在執行；指令解析其即時連接埠、讀取 `/api/models`，並只輸出 Codex 目前可見的模型。

| 旗標 | 動作 |
| --- | --- |
| `--client <opencode\|pi>` | 必填。選擇客戶端方言：opencode 的 keyed `provider` 物件或 Pi 的 `providers` 陣列。 |
| `--json` | 僅在 stdout 印出設定 JSON，使重導向能擷取逐位元組輸出。所有診斷訊息（含 `--out` 寫入提示）皆送至 stderr。 |
| `--out <path>` | 將設定寫入 `<path>`。拒絕覆寫既有檔案。 |
| `--force` | 允許 `--out` 覆寫既有檔案。 |

```bash
ocx export --client opencode                     # 設定加上目的地、合併警告與計數
ocx export --client pi --json > pi-models.json   # 供 pipe 或 diff 用的逐位元組 JSON
ocx export --client opencode --out ~/opencodex-opencode.json
```

未指定 `--json` 時，JSON 在前，接著是標準目的地路徑、合併警告、環境匯出行，以及附帶有多少列省略 context limit 的模型計數（客戶端會對那些套用自身預設值）。

| 客戶端 | 標準目的地 | 下載檔名 | 環境變數 |
| --- | --- | --- | --- |
| `opencode` | `~/.config/opencode/opencode.json`（`XDG_CONFIG_HOME` 設定時優先） | `opencode.json` | `OPENCODEX_OPENCODE_API_KEY` |
| `pi` | `~/.pi/agent/models.json` | `pi-models.json` | `OPENCODEX_API_KEY` |

兩個環境變數名稱不同，且每個客戶端只插值自己的。opencode 讀取
`{env:OPENCODEX_OPENCODE_API_KEY}`；Pi 讀取 `$OPENCODEX_API_KEY`。

:::caution[合併，而非取代]
`ocx export` 永不寫入你的真實客戶端設定。目的地僅印出供你手動合併，而 `--out` 在沒有 `--force` 時拒絕覆寫既有檔案，因為取代設定檔會毀掉其中已有的其他供應商、代理與 MCP 項目。
:::

金鑰永不被序列化。設定只帶有客戶端的環境變數參考，因此秘密留在你的環境中。回送代理（`127.0.0.1`，預設值）完全不需要許可金鑰——該參考只是未被使用。僅在代理綁定超出回送時才設定該變數；關於許可金鑰的簽發方式，請見[遠端存取](/zh-tw/reference/configuration/#remote-access)。上游供應商本身的金鑰是完全不同的事，依[供應商](/zh-tw/guides/providers/)個別設定。

相同的 payload 亦由 `GET /api/client-config` 提供，並在儀表板的 API 分頁渲染，因此 CLI、API 與 GUI 使用相同的位元組。

## 執行階段與設定

### `ocx system <status|settings|startup|diagnostics|sync|update> ...`

管理無頭執行階段設定、啟動、同步、診斷與更新。

```bash
ocx system settings --stream-mode eager-relay
```

### `ocx config <show|get|set|unset|validate|export|import> ...`

檢查並安全地修改已驗證的 OpenCodex 設定。`show` 與 `get` 會遮罩秘密。匯入在寫入前驗證且需要 `--yes`。
