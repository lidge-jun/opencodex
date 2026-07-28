---
title: CLI 參考
description: 所有 ocx 命令與引數。
---

opencodex 的命令列工具是 `ocx`。執行 `ocx help`（或 `--help` / `-h`）可檢視頂層用法。
對幫助表中註冊的命令，可執行 `ocx help <command>` 檢視命令專屬幫助。幫助和版本命令均為只讀，
不會啟動、停止、安裝、解除安裝或改寫 Codex/opencodex 狀態。

## 安裝與生命週期

### `ocx init`

互動式設定嚮導。它會依次詢問 provider（預設或自定義）、API key（字面值或 `${ENV}`）、預設模型
和代理埠，儲存 `~/.opencodex/config.json`，並可選擇把代理注入
`$CODEX_HOME/config.toml`（預設 `~/.codex/config.toml`），以及安裝 Codex 自動啟動 shim。

### `ocx start [--port <port>]`

啟動代理伺服器（首選埠 `10100`）。如果該埠已被佔用，opencodex 會選擇並記錄另一個可用
埠。它會寫入 PID/執行環境埠狀態，並拒絕啟動第二個仍存活的例項。啟動時會把各 provider 的
模型同步進 Codex 目錄。關閉時會恢復原生 Codex，除非它以受管服務執行（`OCX_SERVICE=1`）。

```bash
ocx start
ocx start --port 8080
```

### `ocx stop`

按 PID 停止正在執行的代理，刪除 PID 檔案並恢復原生 Codex。如果已安裝受管後臺服務，
`ocx stop` 會先停止服務，以免它重新拉起代理。Web 儀表板的 **Stop** 按鈕
（`POST /api/stop`）執行相同操作。

### `ocx restore` &nbsp;·&nbsp; `ocx eject`

在**不停止**代理的情況下恢復原生 Codex。它會刪除注入的設定行和路由目錄條目，使普通
`codex` 再次按原生方式工作。`eject` 是 `restore` 的別名。

給任一寫法加上 `back`，可在不改變代理生命週期的情況下，讓普通 `codex` 重新指向已經執行的
代理：

```bash
ocx restore back
ocx eject back
```

### `ocx recover-history --legacy-openai`

顯式恢復舊開發建置留下的歷史記錄；這些建置在支援可逆備份前就已重對映 Codex App 歷史。
如果歷史資料庫被鎖定，請先關閉 Codex。

### `ocx restart`

依次執行 `stop` 和 `ensure`：停止代理/服務，恢復原生 Codex，在後臺啟動代理，再把實際埠同步
回 Codex。

### `ocx ensure`

以冪等方式確保後臺代理正在執行，然後同步其即時模型目錄。如果 `codexAutoStart` 為 `false`，
命令只會提示自動啟動已停用，不執行其他操作。

### `ocx status [--json]`

列印只讀診斷摘要：代理 PID、`/healthz` 可達性、儀表板 URL、設定路徑、預設 provider、Codex
自動啟動設定、服務狀態、shim 狀態以及隱藏使用者名稱後的實際 Codex home。僅當命中明確的高置信度
Windows Orca runtime-home 特徵時，才會針對 App home 不一致給出可執行警告，但不會自動修改 `CODEX_HOME`。

使用 `--json` 可獲得機器可讀的只讀診斷契約：

```bash
ocx status --json
```

下面是精簡後的物件形狀：

```json
{
  "schemaVersion": 1,
  "proxy": {
    "running": false,
    "pid": null,
    "health": {
      "ok": false,
      "url": "http://127.0.0.1:10100/healthz",
      "message": "unreachable"
    }
  },
  "dashboard": {
    "url": "http://localhost:10100/"
  },
  "paths": {
    "config": "/Users/example/.opencodex/config.json",
    "pid": "/Users/example/.opencodex/ocx.pid",
    "runtime": "/path/to/bun"
  },
  "runtime": {
    "source": "bundled"
  },
  "codexHome": {
    "effectiveCodexHome": "C:\\Users\\[USER]\\.codex",
    "appCodexHome": "C:\\Users\\[USER]\\.codex",
    "mismatch": false,
    "warning": null,
    "action": null
  },
  "codexAutostart": true,
  "defaultProvider": "openai",
  "service": {
    "summary": "not installed (logs: /Users/example/.opencodex/service.log)"
  },
  "codexShim": {
    "summary": "Codex autostart shim: not installed"
  }
}
```

實際物件還包含 `listen`（埠、hostname、執行環境/設定來源）、設定載入診斷和內建 Codex plugin
診斷。JSON schema 只允許增加欄位：後續版本可能新增欄位，但現有欄位應保持穩定。它會有意排除
API key、OAuth token、authorization header、請求內容、電子郵件和帳號身份資訊。

### `ocx health [--json]`

驗證目前代理的身份。普通輸出報告 PID/埠；`--json` 輸出 `{ok, pid, port}`。只有健康時才以
0 退出，否則以 1 退出，因此適合作為服務探針。

### `ocx uninstall` &nbsp;·&nbsp; `ocx remove`

停止服務和代理，移除服務與 Codex shim，恢復原生 Codex；只有所有恢復步驟成功後，才刪除
opencodex 本機設定。`remove` 是 `uninstall` 的別名。

## 模型與 Codex

### `ocx sync`

從所有已設定 provider 獲取即時模型列表，並把合併後的目錄重新注入 Codex。新增 provider 後或
需要重新整理可用模型時執行。

### `ocx sync-cache`

使 Codex 的本機模型選擇器快取失效，隨後用目前 opencodex 目錄重新建置。

### `ocx v2 [subcommand]`

管理 Codex 的 `multi_agent_v2` feature flag 和三態 multi-agent surface mode。

| Subcommand | Action |
| --- | --- |
| `status`（預設） | 報告目前 v2 flag、multi-agent mode 和 thread concurrency。 |
| `on` | 在 `$CODEX_HOME/config.toml` 中啟用 `multi_agent_v2` feature，並重新同步目錄。 |
| `off` | 停用 `multi_agent_v2` feature，並重新同步目錄。 |
| `mode v1` | 強制所有模型使用 v1、關閉 native v2，並把 thread limit 儲存在 `[agents] max_threads`。 |
| `mode default` | 遵循 upstream model pin（sol/terra=v2，luna=v1，其餘模型跟隨 Codex flag）。這是安裝預設值。 |
| `mode v2` | 強制所有模型使用 v2、開啟 native v2，並把同一個 thread limit 遷移到 v2 key。 |
| `threads <n>` | 設定目前 v1/v2 thread limit（大於等於 1 的整數）。 |

```bash
ocx v2 status
ocx v2 mode v1
ocx v2 mode default
ocx v2 on
ocx v2 threads 16
```

`mode` subcommand 會把 `multiAgentMode` 寫入 opencodex 設定並重新同步 Codex 目錄。
`mode v1`/`mode v2` 與 `on`/`off` 會在有效的 v1/v2 設定 key 之間遷移目前數值，同時用
`codex features enable|disable` 切換 codex-rs feature flag；失敗時恢復原始 `config.toml`。變更從新的 Codex
session 開始生效，正在執行的 session 保持已固定的 surface。

## 無頭儀表板對等

營運用的儀表板功能也可在沒有瀏覽器的情況下使用。這些命令會定位已通過身分檢查、正在執行的
代理（含後備 runtime 埠），並重用與 GUI 相同的管理路由、驗證、即時設定與目錄重新整理副作用。

| 資源 | 命令 |
| --- | --- |
| 路由 | `ocx combo ...` 或 `ocx route combo ...` |
| 代理政策 | `ocx agent injection\|effort\|subagents\|fallback\|sidecar ...` |
| 可觀測性 | `ocx observe logs\|usage\|storage\|memory\|debug ...` |
| API 准入 | `ocx access key\|endpoints\|models\|test ...` |
| Claude Code | `ocx claude config status\|set ...` |
| Grok Build | `ocx grok status\|exclude\|include\|set\|clear\|apply ...` |
| 執行期控制 | `ocx system status\|settings\|startup\|diagnostics\|sync\|update ...` |
| 離線設定 | `ocx config show\|get\|set\|unset\|validate\|export\|import ...` |

在語意明確時，預設是 list/status。使用 `--json` 取得結構化快照，並以
`ocx observe logs --follow --jsonl` 取得串流請求日誌。破壞性的移除／匯入與更新動作需要
`--yes`。即時操作需要代理正在執行；已驗證的設定檢查與匯入／匯出可離線使用。

```bash
ocx provider test ark
ocx models live --provider ark --json
ocx route combo set reliable --targets ark/model-a:2,openai/gpt-5.5
ocx agent subagents set ark/model-a,openai/gpt-5.5
ocx observe usage --range 30d --json
ocx access key create deployment
ocx system settings --stream-mode eager-relay
```

主題、語言、導覽與其他純視覺的瀏覽器狀態刻意沒有 CLI 對等命令。Cloudflare Tunnel 設定不屬於
此命令集。

### `ocx models [subcommand]`

列出已設定供應商中靜態 seed 的模型。`--provider` 篩選單一已設定供應商；`--json` 返回模型
metadata。`live` 讀取執行中的目錄；`add`、`edit`、`remove` 與 `list-custom` 管理手動目錄條目；
`enable`、`disable` 與 `provider` 控制可見性；`selected` 控制供應商 allowlist；`context` 控制
供應商 context 上限；`shadow` 管理背景 shadow-call 攔截。

### `ocx provider <subcommand>`

非互動式供應商管理。登錄檔條目只需名稱即可 seed；自訂名稱必須同時提供 `--adapter` 和
`--base-url`。

| Subcommand | 支援的引數 | 操作 |
| --- | --- | --- |
| `list` | `--json` | 列出已設定供應商與尚未新增的登錄檔條目。 |
| `add <name>` | `--adapter <adapter>`、`--base-url <url>`、`--api-key <key>`、`--default-model <model>`、`--set-default`、`--force`、`--json`、`--sync` | 新增登錄檔或自訂供應商。`--force` 會覆寫；在人類輸出模式下，`--sync` 會重新整理正在執行的代理。 |
| `edit <name>` | provider 欄位旗標、`--json` | 編輯已驗證的即時供應商欄位，而不替換 key pool。 |
| `test <name>` | `--json` | 探測真實的上游模型端點。 |
| `show <name>` | `--json` | 顯示設定並遮蓋 API key。 |
| `remove <name>` | `--json` | 刪除非預設供應商；不能刪除最後一個供應商。 |
| `set-default <name>` | `--json` | 把既有供應商設為預設值。 |
| `selected <name>` | `--set <ids>`、`--clear`、`--json` | 讀取或更新供應商模型 allowlist。 |
| `quota` | `--refresh`、`--json` | 讀取供應商額度報告。 |
| `presets` | `--json` | 列出儀表板供應商預設組合。 |
| `account-mode` | `pool`、`direct`、`--json` | 選擇 pooled 或 direct 的 Codex 帳號路由。 |

```bash
ocx provider list --json
ocx provider add anthropic --api-key sk-ant-... --set-default --sync
ocx provider add local-dev --adapter openai-chat --base-url http://localhost:11434/v1
ocx provider show anthropic --json
ocx models --provider anthropic --json
```

### `ocx account <subcommand>`

透過正在執行的代理列出和切換供應商帳號及 API key pool。已釋出的幫助介面如下：

```text
Usage: ocx account <list|current|use|refresh|auto-switch|remove|add-key> ...

List and switch provider accounts and API-key pools (GUI parity).

list [provider]     Codex account pool, OAuth accounts and API keys (identifiers shown masked as the API returns them).
current <provider>  Show the active account or key.
use <provider> <id> Switch the active credential; 'main' selects the Codex App login.
refresh <provider>  Force-refresh Codex or provider quota reports.
auto-switch <provider> <on|off|status|threshold N>  Control the Codex pool threshold.
remove <provider> <id> --yes  Remove a stored account or key after an existence check.
add-key <provider> [--label <label>]  Add a key read only from piped stdin.
Codex pool switches apply to new sessions; running threads keep their account.
```

所有子命令都要求代理正在執行；CLI 會自動解析已記錄的執行環境埠。成功時退出碼為 0。用法錯誤、
未知供應商或帳號/key id、代理不可達、API 失敗時退出碼為 1。憑證欄位會按照 management API
的返回值顯示（包括 API 應用的脫敏）；不會返回原始 API key 或 OAuth token。顯示便捷值由 CLI
以與儀表板相同的方式合成：`main` 是 `openai` 帳號池中 Codex App 登入的別名，沒有郵箱的
OAuth 帳號顯示為 `Account N`，plan/label 列按 plan → 脫敏郵箱 → label → 脫敏 key 依次回退。

`--json` 的帳號行使用以下通用形狀（沒有值時會省略可選欄位）：

```json
{
  "provider": "openai",
  "type": "codex | oauth | api-key",
  "id": "__main__",
  "label": "plus",
  "email": "m***@example.com",
  "plan": "plus",
  "masked": "sk-ab****wxyz",
  "active": true,
  "needsReauth": false,
  "quota": null
}
```

#### `ocx account list [provider] [--json] [--all]`

不指定 provider 時，會列出 Codex pool、OAuth 帳號和已設定的 API-key pool。除非傳入 `--all`，
否則跳過空 provider；指定 provider 時只讀取對應憑證 family。普通輸出的列為
`PROVIDER TYPE ID PLAN/LABEL STATUS`，手動選擇的 Codex 行標記為 `selected`。當存在已儲存的
Kiro 帳號時，輸出會說明它只有一個登入 slot，再次登入會替換目前帳號。結果為空仍算成功。`--json` 返回：

```text
{ accounts: AccountRow[], notes: string[] }
```

#### `ocx account current <provider> [--json]`

顯示 active 帳號或 key。沒有手動 pin 的 Codex pool 會報告自動選擇用量最低的帳號；其他 family
沒有 active 憑證時也會如實報告並返回退出碼 0。`--json` 返回：

```text
{ provider, type, activeId: string | null, autoSwitchThreshold?: number, account: AccountRow | null }
```

#### `ocx account use <provider> <account-or-key-id|main> [--json]`

選擇已有的 Codex 帳號、OAuth 帳號或 API key。對 `openai` 而言，`main` 選擇 Codex App 登入。
Codex 選擇只對**新 session**生效；已有 thread 保持其帳號。啟用的 auto-switch threshold 之後可能
覆蓋手動 pin。未知 provider 或 id 返回退出碼 1。`--json` 返回：

```text
{ ok: true, provider, type, activeId }
```

#### `ocx account refresh <provider> [--json]`

Codex pool 使用 `ocx account refresh openai [--json]`。它會強制重新整理帳號 quota，並顯示可用的
周/月百分比和 reset 時間；缺少 quota 時報告 unknown，而不是 0%。JSON envelope 為
`{ accounts: AccountRow[] }`，每個 Codex 行都帶有 `quota`。

對於 OAuth 和 API-key provider，該命令會強制重新整理 provider quota-report endpoint；它不是 token
重新登入，也不是簡單重讀帳號列表。`--json` 返回
`{ provider, report: ProviderQuotaReport | null }`。如果 provider 沒有受支援的 quota report，
命令會輸出 `no quota report available for <provider>` 並返回退出碼 0。未知 provider 和
management API 失敗返回退出碼 1；upstream quota probe 失敗或逾時則與儀表板的 quota 條一樣，
降級為 null/過期 report 並返回退出碼 0。

#### `ocx account auto-switch <provider> <on|off|status|threshold <0-100>> [--json]`

只控制 `openai` Codex 帳號 pool。`on` 設定為 80%，`off` 設定為 0%，`status` 讀取目前值，
`threshold <n>` 只接受 0 到 100 的整數。其他 provider 或無效值返回退出碼 1。`--json` 返回：

```text
{ provider, autoSwitchThreshold: number, enabled: boolean }
```

#### `ocx account remove <provider> <id|main> --yes [--json]`

這是受保護的非互動刪除，因此必須提供 `--yes`。刪除前會驗證 id 是否存在；id 不存在時不會傳送
DELETE，並返回退出碼 1。主 Codex App 登入不能刪除，因此 `remove openai main --yes` 會被拒絕。
刪除後會重新讀取對應 family：刪除已 pin 的 Codex 帳號會清除 pin 並恢復自動選擇；OAuth 會提升
第一個剩餘帳號，或報告沒有帳號；API-key pool 會提升第一個剩餘 key，或報告沒有 key。`--json`
成功和失敗的形狀為：

```text
{ ok: true, provider, id, removedActive: boolean, promotedActiveId: string | null }
{ error: string } // stderr, exit 1
```

#### `ocx account add-key <provider> [--label <label>] [--json]`

為 API-key provider 新增並啟用 key。key 只從非 TTY 的 pipe/redirect stdin 讀取；互動式 TTY、
空輸入、OAuth/Codex provider 和 API 失敗都會返回退出碼 1。即使 label 中包含 key，也絕不會回顯
key。請使用 secret manager 或 here-string：

```bash
ocx account add-key openrouter --label personal <<< "$OPENROUTER_API_KEY"
security find-generic-password -w openrouter | ocx account add-key openrouter --json
```

`--json` 返回 `{ ok: true, id: string | null, label?: string }`，且絕不包含 key。

## 認證

### `ocx login <provider>`

啟動 provider 註冊的登入流程。OAuth provider 會開啟瀏覽器，並把可自動重新整理的 credential 存入
`~/.opencodex/`；API-key 登入 provider 會開啟 key 儀表板，提示輸入 key，在條件允許時進行
驗證，再儲存生成的 provider 設定。如果名稱缺失或未知，命令會列印目前接受的 OAuth 和 API-key
provider id。

```bash
ocx login xai
```

### `ocx logout <provider>`

移除 provider 已儲存的 OAuth credential。

## 儀表板

### `ocx gui`

在 `http://localhost:<port>` 開啟 [Web 儀表板](/zh-tw/guides/web-dashboard/)。如果代理
尚未執行，會自動啟動。

## 後臺服務

### `ocx service [subcommand]`

把 opencodex 作為登入管理的後臺服務執行（macOS **launchd**、Linux **systemd user unit**、
Windows **Task Scheduler**），登入時自動啟動，崩潰後自動重啟。服務程序會設定
`OCX_SERVICE=1`，因此重啟不會反覆改動 Codex 設定。

| Subcommand | Action |
| --- | --- |
| 無 | 建立/更新並啟動服務。 |
| `install` | 建立並啟動服務。 |
| `start` | 啟動已安裝的服務。 |
| `stop` | 停止服務並恢復原生 Codex。 |
| `status` | 報告服務是否正在執行。 |
| `uninstall` | 移除服務並恢復原生 Codex。 |
| `remove` | `uninstall` 的別名。 |

```bash
ocx service
ocx service install
ocx service status
ocx service uninstall
```

### `ocx codex-shim <subcommand>`

把 PATH 上基於指令碼的 `codex` launcher 包裝成輕量自動啟動指令碼。真實 `codex.exe` 目標保持不變，
避免破壞精確的可執行檔案呼叫。

如果已完成的外部 Codex 更新覆蓋了已安裝的 shim，下一條普通 `ocx` 命令會在執行前備份已穩定的
新啟動器並恢復 shim。仍在變化的啟動器不會被改動，而會稍後重試。修復失敗只會警告，不會讓請求的
命令失敗；手動備用命令為 `ocx codex-shim install`。若要關閉自動恢復，請將
`codexShimAutoRestore` 設為 `false`，或為程序設定
`OPENCODEX_CODEX_SHIM_AUTO_RESTORE=0`。

| Subcommand | Action |
| --- | --- |
| `install` | 安裝 shim（過期時會修復）。 |
| `uninstall` | 移除 shim 並恢復原始 Codex binary。 |
| `remove` | `uninstall` 的別名。 |
| `status` | 報告 shim 狀態（已安裝 / 過期 / 缺失）。 |

```bash
ocx codex-shim install
ocx codex-shim status
ocx codex-shim uninstall
```

:::tip[Service 與 Shim]
常駐代理請使用 `ocx service`（推薦）。需要無 daemon 的輕量按需啟動時，請使用
`ocx codex-shim`；只有執行 `codex` 時才會啟動代理。
:::

## 診斷

### `ocx doctor`

執行只讀的環境與連線診斷：狀態路徑和檔案系統型別、WSL 雙重安裝、代理環境/設定、ChatGPT
可達性、Codex plugin 與專案設定警告，以及待處理的歷史遷移。Codex app-home targeting 部分還會
窄範圍檢測 Windows Orca runtime-home 不一致，並在需要時說明如何遷移服務。新診斷中的路徑會隱藏
OS 使用者名稱。它會列印修復建議，但不會執行。

### `ocx debug [provider|usage …]`

經正在執行的代理管理 API 讀取或修改執行環境 debug override。

```bash
ocx debug provider on|off|status|reset
ocx debug provider logs [-f|--follow]
ocx debug usage on|off|status|reset
ocx debug usage logs [-f|--follow]
```

不指定範圍時，`ocx debug` 會列印用法；代理停止時，還會顯示下次啟動採用的環境變數預設值。
provider debug 預設讀取 `OCX_DEBUG=1`（舊的 `OCX_DEBUG_FRAMES=1` 仍可用），usage debug 預設讀取
`OPENCODEX_USAGE_DEBUG=1`。

## 更新

### `ocx update`

從 npm 自助更新 opencodex。穩定版安裝使用 `@latest`，preview 安裝繼續使用 `@preview`，除非傳入
`--tag latest|preview`。在原始碼 checkout 中，它會改為提示 `git pull && bun install`；如果已經是
相應 tag 的最新版，則不執行任何操作。替換檔案前會停止正在執行的代理；已安裝的服務會自動重建
並啟動，而前臺安裝會把 `ocx start` 顯示為下一步。

```bash
ocx update
ocx update --tag preview
```

[Release workflow](https://github.com/lidge-jun/opencodex/actions/workflows/release.yml) 釋出到 npm
後，新版本會立即可用。

## 幫助

`ocx help`、`ocx --help`、`ocx -h` —— 列印頂層用法和示例。

`ocx help <command>`、`ocx <command> --help`、`ocx <command> -h` —— 列印
`src/cli/help.ts` 中註冊命令的專屬用法。`provider`、`debug` 和 `v2` 的完整 subcommand 契約已在
上文列出。

即使帶有幫助引數，未知命令仍會報錯，因此指令碼可以依賴退出碼，無需解析文字輸出。

## 版本

`ocx --version`、`ocx -v`、`ocx version` —— 列印一行適合指令碼讀取的版本資訊並退出。

## 內部命令

兩個 dispatch 目標會刻意從普通幫助中隱藏：`__refresh-version [preview]` 在 detached process 中
重新整理更新通知快取；`__gui-update-worker <job-id> [latest|preview] [restart]` 執行儀表板更新任務。
它們屬於實現細節，不是穩定的使用者命令。
