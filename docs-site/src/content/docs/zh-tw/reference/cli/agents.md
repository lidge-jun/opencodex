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
ocx agent sidecar web --enabled off
```

`--enabled off` 與儀表板中的 **關閉 (Off)** 列是同一個開關：OpenCodex 不再執行該 sidecar，
Codex 整合會把 `web_search = "disabled"` 寫入 `~/.codex/config.toml`，這正是讓 MCP
搜尋伺服器成為唯一搜尋路徑的前提。`--enabled on` 會再次移除該行。當儲存確實改變開關狀態時，
指令會回報由此觸發的 Codex 端寫入（`--json` 中的 `codexWebSearch`，否則為結尾的
`Codex config:` 行），並在無法寫入時提示 `ocx sync`。該旗標對 `vision` 同樣有效。

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
| `ocx usage [--range <today|1d|7d|30d|all>] [--surface <all|codex|claude|grok>] [--provider <name>] [--model <id>] [--json]` | `ocx observe usage` |
| `ocx storage [--json]` | `ocx observe storage` |
| `ocx memory [--json]` | `ocx observe memory` |

```bash
ocx observe usage --range 30d --json
```

部分用量記錄無法納入時，人類可讀輸出會顯示警告，即使沒有可讀取的記錄也是如此。顯示的總數僅反映可讀取的記錄。如果篩選條件沒有符合的可讀取記錄，輸出將顯示警告和提示，而不顯示總數列；被略過的記錄可能包含符合項目。`--json` 原樣保留回應中的 `usageIncomplete` 診斷及原因。

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

檢視 OpenCodex 存取用 API 金鑰清單、外部端點與模型。`ocx api-key` 是 `ocx access key` 指令群組的別名。

建立金鑰與開始輪替時，無論使用文字或 JSON 輸出，都會傳回僅顯示一次的明文憑證。代理應將這些步驟交由人在代理工作階段之外直接操作的終端機完成。不要索取金鑰本身，也不要請使用者貼到聊天中；只接收設定與連線驗證的確認，以及非機密的金鑰 ID 和輪替 ID。

```bash
ocx access key list --json
```

確認新金鑰已設定並通過連線驗證，不等於核准撤銷舊金鑰。確認輪替或刪除舊金鑰前，必須另行取得撤銷該金鑰的明確授權。執行獲准的操作後，請再次檢視清單。不要透過直接呼叫 API 繞過此流程。

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

### `ocx codex [codex args...]`

只有設定及其命名空間受到保護、其他主體無法修改時才提供金鑰；目前使用者和特權 OS 主體受到信任。同一使用者的程序受到信任：具有該使用者寫入權限的主體已能讀取該使用者的 OpenCodex 金鑰檔案。驗證與原生啟動之間由同一使用者替換設定不在此威脅模型內，啟動器不會在交接時凍結設定。

一般 Windows 安裝的預設 ProgramData 權限允許其他使用者建立目錄。因此即使 `ProgramData\OpenAI\Codex` 不存在，也會暫緩自動憑證。ProgramData 下的系統 Codex 設定資料夾必須存在，且僅 Administrators/SYSTEM 可寫入；其祖先目錄也必須防止其他使用者替換。請管理員檢查目錄原則。opencodex 絕不自行修改 ACL，也不提供設定目錄的命令。

您也可以自行提供金鑰，例如匯出 `OPENCODEX_API_AUTH_TOKEN` 環境變數；`ocx codex` 會保留其值不變。既有系統設定檔仍會阻止自動憑證，需另行檢查。每種暫緩原因都會輸出一行簡短明確的 stderr 診斷，不含金鑰值、金鑰檔案內容或路徑。

單字提示前請加 `--`，以免選取未知的 Codex 子命令。

即使系統設定檔不存在，也必須阻止其他使用者建立這些檔案。無法驗證 Windows ProgramData/OpenAI/Codex 路徑保護時不自動注入權杖，也不建立目錄。macOS 接受僅拒絕的 ACL 與唯讀允許項。任何允許寫入、附加、刪除、修改屬性、安全或擁有者的項目都會被拒絕，即使前面已有拒絕項。未知標籤與檢查錯誤也會被拒絕。

只有 argv 位於下方允許清單內、環境中沒有非空 HTTP(S)/ALL proxy 或 `CODEX_*`/`OPENAI_*`/`AZURE_OPENAI_*` 覆寫（允許標準的 `CODEX_HOME`），且主目錄、設定與系統命名空間通過擁有權檢查時，才讀取新服務權杖。設定必須只包含已稽核鍵與準確的受管 loopback provider，沒有額外憑證消費者或設定層。`-c`/`--config`、`-p`/`--profile`、未知旗標和 `resume`/`fork` 等清單外引數都會暫緩權杖，並輸出不含值的診斷；明確提供的使用者憑證與原始引數保持不變。

標準主目錄與 `config.toml` 必須屬於目前使用者。POSIX 拒絕 group/other 寫入權限；Windows 驗證擁有者 SID，並拒絕目前使用者、SYSTEM、Administrators 以外的 DACL 寫入授權。也會檢查祖先路徑替換權限。macOS 還要求不存在強制 Codex 設定 preference。這些檢查無法隔離相同使用者或管理員執行的惡意程序。

| Allowlist | Flags |
| --- | --- |
| Switches | `--no-daemon`, `--json`, `--ephemeral`, `--skip-git-repo-check`, `--no-alt-screen`, `--full-auto`, `--dangerously-bypass-approvals-and-sandbox`, `--search` |
| One value | `--model`/`-m`, `--sandbox`/`-s`, `--ask-for-approval`/`-a`, `--image`/`-i` |



自動憑證讀取會將 `CODEX_HOME` 中的 `~` 與空白視為字面路徑，驗證後將同一個正規絕對路徑傳給子程序。無法讀取主目錄時不讀取權杖。只要存在非空的 `HTTP_PROXY`、`HTTPS_PROXY` 或 `ALL_PROXY`（不分大小寫），就會略過自動讀取，不受 `NO_PROXY` 影響；拒絕的啟動和使用者匯出的憑證保持不變。傳遞新權杖時，子程序的 `NO_PROXY` 與 `no_proxy` 會保留既有排除項目並加入 `127.0.0.1` 和 `::1`。啟用 `features.respect_system_proxy` 或傳入 `--enable`/`--disable` 會略過自動讀取。

使用原始引數啟動 Codex 前嘗試啟動代理。路由仍由 Codex 設定擁有，啟動器不會改寫。原生及其他閘道路由略過代理啟動；未知路由會警告並嘗試啟動，失敗後仍警告並繼續。說明、版本及 `login`、`doctor`、`help` 等內部命令略過代理啟動和自動權杖讀取。

只有所選 provider 的完整傳輸設定與本次安裝的回環監聽器或已儲存的本機用戶端連線對應的管理區塊一致時，才從本次安裝的 `service-api-token` 讀取缺少的 `OPENCODEX_API_AUTH_TOKEN`。名稱或注入註解本身不構成授權。未知或遠端目的地、預設 profile、專案設定、`OPENAI_BASE_URL` 及傳入的 `-c`/`--config`、`-p`/`--profile`、`-C`/`--cd`、`--remote` 都會略過自動讀取。保留使用者匯出的憑證與引數，拒絕權杖檔案覆寫和管理權杖衝突。

只有比對成功（`matched`）的 autostart wrapper 才直接啟動背後的 Codex。未知狀態（包括檢查例外）必須通過 bypass 驗證；受管 Windows CMD wrapper 必須與目前產生的範本完整一致，才以 `OCX_SHIM_BYPASS=1` 執行。一般 npm 啟動器仍受支援。無法驗證或過時的 wrapper 以結束代碼 1 拒絕，且不啟動 Codex；請用 `ocx codex-shim install` 更新。本次啟動不修復 shim；內容檢查不證明 Windows backing 檔案來源，也不防止並行路徑替換。

啟動器說明為 `ocx help codex`，Codex 說明為 `ocx codex --help`。之後直接執行一般 `codex` 的行為保持不變。

### `ocx opencode [opencode args...]`

確保代理正在執行，然後在 OpenCode 的內嵌執行階段層（`OPENCODE_CONFIG_CONTENT`）中以生成的 `provider.opencodex` 與 `providers.opencodex` 區塊啟動 opencode。既有的內嵌設定會被保留，本次啟動僅替換這兩個鍵。全域或專案的 `opencode.json` 檔案可能被讀取以警告既有的覆寫，但磁碟上的檔案永不修改。路由模型以
`opencodex/<provider>/<model>` 出現。之後啟動普通 `opencode` 的行為與之前完全相同。

### `ocx grok <status|exclude|include|set|clear|apply> ...`

管理並套用 Grok Build 模型圍欄。

## 客戶端設定匯出

### `ocx export --client <opencode|pi|omp|hermes|openclaw|kimi|gajae|dsh|mcode|zcode|prime|aside|raycast|omo|cline|kilo|commandcode|droid>`

印出連接到執行中代理的客戶端設定。此指令會用所選客戶端的原生格式，序列化含有 base URL、模型清單，以及適用的環境變數參考或 loopback 佔位符的 `opencodex` provider 區塊。

代理必須正在執行；指令解析其即時連接埠、讀取 `/api/models`，並只輸出 Codex 目前可見的模型。

| 旗標 | 動作 |
| --- | --- |
| `--client <opencode\|pi\|omp\|hermes\|openclaw\|kimi\|gajae\|dsh\|mcode\|zcode\|prime\|aside\|raycast\|omo\|cline\|kilo\|commandcode\|droid>` | 必填。選擇客戶端設定格式。 |
| `--json` | 僅在 stdout 印出設定 JSON，使重導向能擷取逐位元組輸出。所有診斷訊息（含 `--out` 寫入提示）皆送至 stderr。 |
| `--out <path>` | 將設定寫入 `<path>`。拒絕覆寫既有檔案。 |
| `--force` | 允許 `--out` 覆寫既有檔案。 |

```bash
ocx export --client opencode                     # 設定加上目的地、合併警告與計數
ocx export --client pi --json > pi-models.json   # 供 pipe 或 diff 用的逐位元組 JSON
ocx export --client omp --out ./omp-models.yml    # 原生 OMP YAML
ocx export --client opencode --out ~/opencodex-opencode.json
```

未指定 `--json` 時，會先輸出客戶端的原生設定格式，接著是標準目的地路徑、合併警告、客戶端專屬提示，以及附帶有多少列省略 context limit 的模型計數（客戶端會對那些套用自身預設值）。

| 客戶端 | 標準目的地 | 下載檔名 | 環境變數 |
| --- | --- | --- | --- |
| `opencode` | `~/.config/opencode/opencode.json`（`XDG_CONFIG_HOME` 設定時優先） | `opencode.json` | `OPENCODEX_OPENCODE_API_KEY` |
| `pi` | `~/.pi/agent/models.json` (設定後 `PI_CODING_AGENT_DIR` 優先；相對路徑會被拒絕) | `pi-models.json` | 無——區塊帶有字面值 `opencodex-loopback` |
| `omp` | `~/.omp/agent/models.yml`（即使是空值，`OMP_PROFILE` 仍優先於 `PI_PROFILE`） | `omp-models.yaml` | 無——loopback 佔位符 |
| `hermes` | `~/.hermes/config.yaml` | `hermes-config.yaml` | `OPENCODEX_HERMES_API_KEY` |
| `openclaw` | `~/.openclaw/openclaw.json` | `openclaw.json5` | `OPENCODEX_OPENCLAW_API_KEY` |
| `kimi` | `~/.kimi-code/config.toml` | `kimi-config.toml` | 無——loopback 佔位符 |
| `gajae` | `~/.gjc/agent/models.yml` | `gajae-models.yaml` | 非機密的回送佔位值 |
| `dsh` | `$DSH_HOME/settings.yaml`（預設 `~/.dsh/settings.yaml`） | `settings.yaml` | 無——非秘密的 loopback bearer 佔位符 |
| `mcode` | `~/.minimax/config.yaml` (設定後 `MINIMAX_DATA_DIR` 優先，其次為舊的 `MAVIS_DATA_DIR`；相對路徑會被拒絕) | `mcode-config.yaml` | 無——loopback 佔位符 |
| `zcode` | `~/.zcode/v2/config.json` (設定後 `ZCODE_DATA_DIR` 優先；相對路徑會被拒絕) | `config.json` | 無——loopback 佔位符 |
| `prime` | `~/.prime/agent/models.json` (設定後 `PRIME_AGENT_CODING_AGENT_DIR` 優先；相對路徑會被拒絕) | `prime-models.json` | 無——loopback 佔位符 |
| `aside` | `~/.aside/u/<account>/models.json`，對應 Aside 自己的 `accounts.json` 指定的目前帳戶；資訊清單無法讀取時會被拒絕，而不是退回任一帳戶 | `aside-models.json` | 無——loopback 佔位符 |
| `raycast` | `~/.config/raycast/ai/providers.yaml`（macOS 與 Windows 相同；Raycast 不遵循 `XDG_CONFIG_HOME`） | `raycast-providers.yaml` | 無——僅限 loopback，不會寫入 `api_keys` 項目 |
| `omo` | `~/.omo/agent/models.json`（設定後依序由 `OMO_CODING_AGENT_DIR`、`SENPI_CODING_AGENT_DIR`、`PI_CODING_AGENT_DIR` 優先；相對路徑會被拒絕） | `omo-models.json` | 無——loopback 佔位符 |
| `kilo` | `~/.config/kilo` 下最先存在的 `kilo.jsonc`、`kilo.json`、`opencode.jsonc`、`opencode.json` 或 `config.json`（`XDG_CONFIG_HOME` 可變更該目錄）；皆不存在時使用 `kilo.jsonc` | `kilo.jsonc` | `OPENCODEX_KILO_API_KEY` |
| `commandcode` | `~/.commandcode/providers.json` (Windows 使用預設家目錄時：僅當 `HOME ?? USERPROFILE` 的值非空、非純空白且為 Windows 絕對路徑時使用，否則使用 `homedir()`；另行傳入的家目錄保持不變；檔案位於其下的 `.commandcode\providers.json`) | `providers.json` | 僅限迴環；`apiKey: false`；不需環境變數 |
| `droid` | `~/.factory/settings.json` (`%USERPROFILE%\.factory\settings.json` on Windows) | `factory-settings.json` | 僅限迴環；不需環境變數 |

以上路徑為預設值。在預設家目錄的 `~/.zcode/v2/setting.json` 設定絕對路徑 `dataBaseDir` 後，儲存路徑改為 `<dataBaseDir>/.zcode/v2/provider_config.json`。`ZCODE_DATA_DIR` 直接指定 `.zcode` 根目錄且優先於設定；`ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` 優先指定供應商檔案。設定格式錯誤、無法讀取或使用相對路徑時，新套用與更新會被拒絕。既有所有權及復原記錄會保留。參閱[路徑與復原規則的英文原文](https://opencodex.me/guides/integrations/#zcode-314-and-later)。

Raycast 匯出是一份獨立的 `providers.yaml` 文件，在 `providers` 序列中只有一個 `id: opencodex` 元素：`name: OpenCodex`、proxy 的 `/v1` base URL，以及每個路由模型及其 `abilities`（`tools` 與 `system_message` 一律支援，`vision` 依目錄的輸入模態而定，`reasoning_effort` 在模型有 effort 階梯時設定，`temperature` 對推理模型關閉）。Custom Providers 是 Raycast Pro 功能，且 Raycast 會監看該檔案，因此儲存後的變更不需重新啟動即可生效。格式說明見 [manual.raycast.com/ai/custom-providers](https://manual.raycast.com/ai/custom-providers)。不會寫入任何 `api_keys` 項目，所以此匯出僅限 loopback，非 loopback 的 bind 會被拒絕。

opencode 會插值 `{env:OPENCODEX_OPENCODE_API_KEY}`。Pi 與 OMP 的匯出不需要環境變數，
而是帶有字面值 `opencodex-loopback`。DSH 匯出需要 DSH 0.1.0-rc.6 或更新版本，且只擁有
`llm-pi-ai.providers.opencodex`。DSH 會熱重載該 provider；使用者的預設模型與
`deepseek-official` 維持不變。這項匯出僅支援 loopback，且不含真實憑證。

:::caution[合併，而非取代]
`ocx export` 永不寫入你的真實客戶端設定。目的地僅印出供你手動合併，而 `--out` 在沒有 `--force` 時拒絕覆寫既有檔案，因為取代設定檔會毀掉其中已有的其他供應商、代理與 MCP 項目。
:::

金鑰永不被序列化。設定只帶有文件化的環境變數參考，或非秘密的 loopback 佔位符。僅憑 loopback 位址（`127.0.0.1`）不能認定不需金鑰；應確認目標的驗證政策與端點。使用所選金鑰的模型及音訊 CLI 即使在 loopback 上也需要明確提供金鑰。只有客戶端 schema 支援、且代理綁定超出 loopback 時，才設定被引用的變數；關於准入金鑰的簽發方式，請見[遠端存取](/zh-tw/reference/configuration/server/#遠端存取)。上游 provider 本身的金鑰是完全不同的事，依[供應商](/zh-tw/guides/providers/)個別設定。

產生的 gjc 整合使用非機密的本機回環佔位值，不需要環境變數。此整合僅支援本機回環，不設定遠端存取憑證。

相同的 payload 亦由 `GET /api/client-config` 提供，並在儀表板的 API 分頁渲染，因此 CLI、API 與 GUI 使用相同的位元組。

## 執行階段與設定

### `ocx system <status|settings|startup|diagnostics|sync|codex-app-server|codex-restart|update|codex-cli-update> ...`

管理無頭執行階段設定、啟動、同步、診斷與更新。

`ocx system codex-restart --yes` 透過與 `ocx sync --restart-codex` 相同的模組重啟 Codex app-server。模型選擇器在應用程式啟動時建立，因此當桌面應用程式於目前模型目錄寫入之前啟動，或本次請求變更了 `model_catalog_json` 綁定時，會完全結束再重新啟動它。否則應用程式保持開啟，自行重啟其 app-server，並保留未送出的草稿與待處理的核准。若無法讀取應用程式或目錄狀態，則執行完整重啟。若代理本身在 Codex 應用程式內部執行，桌面重啟會給出可執行提示並拒絕，而不是承諾無法完成的移交。

如果本次請求變更了 `model_catalog_json` 綁定，即使桌面程序在目錄檔案寫入後才啟動，也會觸發桌面重新啟動。

```bash
ocx system settings --stream-mode eager-relay
```

`ocx system update` 更新 OpenCodex 本身。Codex CLI 使用以下獨立唯讀檢查指令：

```bash
ocx system codex-cli-update check --json
```

`check` 不查詢註冊表，也不執行 Codex。在 POSIX 上，當已發布啟動器擷取的環境候選項與執行階段解析器選擇的正規路徑相同時，`selectionAttested` 可以為 `true`；若關聯的 npm-global 套件資訊清單證明了所有權，且在回報候選版本時該版本與資訊清單版本一致，`managed` 可以為 `true`。持久化候選項仍不獲認證。Windows x64 也支援經證明繫結的絕對路徑標準 npm `codex.cmd`，以及由持有控制代碼繫結的 Node/npm 工具鏈（存在時為前綴本機，確認不存在時為錨定到啟動器架構的已擷取 PATH 配對）和已驗證的前綴內平台支援元件，並使用拒絕重新剖析的持有控制代碼。其他 Windows 配置仍然延後或不受管理。Windows 的 `managed` 結果僅對觀測到的安裝配置進行分類：繫結的 Node/npm 是更新器的唯讀中繼資料工具鏈，並不保證後續 `codex.cmd` 呼叫將解析到哪個直譯器。直接透過 Bun 或原始碼執行時沒有啟動器證明。`plan` 使用隔離的暫存 npm 設定、快取和日誌查詢官方註冊表，並拒絕活動工作階段或不完整的程序觀測。它不安裝軟體，也不向程序傳送訊號。Windows x64 的 apply 需要具備經過驗證的私人寫入權限的受限 npm 前綴，並保留無關的套件和 shim；不受支援的已觀測配置回傳 `applicable: false` 且 `refusal: windows_apply_disabled`；僅 PATH 選取、OpenCodex 自動啟動包裝器和 global/vendor 後援仍然延後。請參閱[完整命令與拒絕原因（英文）](/reference/cli/agents/#read-only-codex-cli-update-plan)。

在 Windows 上，如果擷取到 `CODEX_CLI_PATH=codex` 這類單純命令名稱、遠端路徑或裝置路徑，則回報 `candidate_path_unavailable`。這些情況已有擷取的候選項，但其路徑不適用於此檢查。

#### 明確觀測 Windows x64 安裝

```text
ocx system codex-cli-update attest [--json]
ocx system codex-cli-update attest --candidate <absolute-path> --npm-prefix <absolute-path> --npm-cli <absolute-path> --node <absolute-path> [--json]
```

`attest` 是選用的唯讀操作，用於觀測所選或明確指定的 Windows x64 npm 安裝。不帶任何選項時，指令會觀測由可信 launcher 快照識別的所選候選項（已設定的 `CODEX_CLI_PATH` 或所擷取 PATH 中的第一個 `codex`），其中 opencodex 包裝腳本會解析到其重新命名的 `codex.opencodex-real.cmd` npm 備份。提供全部四個絕對路徑可覆寫自動識別；自動識別僅提出路徑，持有控制代碼的觀測才是最終依據。`--candidate` 必須是標準 npm `<prefix>/codex.cmd` 或 `<prefix>/node_modules/@openai/codex/bin/codex.js`。`--npm-cli` 必須以 `node_modules/npm/bin/npm-cli.js` 結尾，`--node` 明確指定 `node.exe`。應用程式封裝、已識別的版本管理工具配置、缺少 npm 備份的 opencodex 自有 shim 與自訂包裝腳本皆會被拒絕。

在有限讀取期間，原生控制代碼保持上層目錄與檔案開啟。未支援的平台、重新剖析點/junction、衝突的寫入者、不安全的路徑及超過大小限制的檔案皆會被拒絕。固定格式報告不含路徑：`status` 為 `observed` 或 `refused`，並提供 `installationIdentityObserved`；`selectionAttested`、`managed` 與 `applyAllowed` 一律為 `false`。回報拒絕時也可能回傳結束代碼 0，因此應檢查 `status`。

識別值或摘要僅描述觀測當下的檔案，不是持續有效的更新許可，也不證明選用的執行階段、過去的安裝程式、實際 npm 設定或工具真實性。明確指定的 Node 也只是被觀測，不能證明啟動器會選用它。命令不會執行目標、請求套件 registry、安裝、寫入設定或控制程序。現有 Windows `check` 仍不執行候選項或設定的檔案系統 I/O。

### `ocx config [show|get|set|unset|validate|export|import] ...`

`ocx config [show] [--json] [--source]` 無需執行代理即可顯示本機設定。省略 `show` 時，可使用任一旗標或依任意順序組合使用。`--source` 包含診斷來源、錯誤和警告，僅適用於顯示操作。`--json` 可放在明確指定的操作之前，不會改變執行的操作。重複的 `--json` 或 `--source` 旗標及未知引數會遭到拒絕。

檢查並安全地修改已驗證的 OpenCodex 設定。`show` 與 `get` 會遮罩秘密。匯入在寫入前驗證且需要 `--yes`。

### Forced Claude Code subagent model

The Subagents page offers **Force all subagents onto one model**, off by default. Select an exposed roster-style id, such as `combo/tev-auto`, then enable the switch. The roster is offered first; unavailable saved roster entries cannot be force targets.

`ocx agent subagents force combo/tev-auto` sets `claudeCode.subagentModelForce`; `ocx agent subagents force -` clears it. `ocx agent status` reports the setting. `GET /api/subagent-models` returns `force`, `forceAvailable`, and `forceStatus`; `PUT` accepts `{ "force": "combo/tev-auto" }` or `{ "force": null }` without changing the roster. Omitting `force` leaves it unchanged. Invalid or unexposed targets are rejected on write; stale targets are reported and skipped at launch.

This takes effect on the **next routed `ocx claude` launch**, injecting `CLAUDE_CODE_SUBAGENT_MODEL` as an explicit proxy alias (with `[1m]` only for an authoritative million-token window; native Claude targets use a reversible native alias) and `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`. Each nonempty shell-exported variable independently wins. Native launches inject neither variable; plain `claude` is not affected. No plugin files or `settings.json` are modified by this setting.

Claude Code **2.1.257 or newer** is required for FORCE. Plugin and built-in agents (including Explore/Plan) and per-call model arguments are overridden. Forks and subagent skills with `model: inherit` keep the main conversation model. The main loop and Haiku/small-fast sidecars are unaffected. Existing roster files remain available.

The dashboard warns about old or unknown CLI versions, unavailable targets, and either variable already present in `settings.json` → `env` (which overrides launch env). Detection is read-only and server-local: it cannot inspect another launch shell, another machine, or project-local settings. An unknown result is not proof of force support.

## Hermes / Command Code: model names

Hermes and Command Code support `--model-names alias|routed` (API: `modelNames`).
The default is `routed`, independent of `preferModelAliasIds`. A connection
stores its mode; later Apply without the option preserves it. Alias mode uses
only provider-qualified aliases that the router proves equivalent; missing,
unsafe or colliding aliases fall back to routed keys. Combos keep their keys.
Removed/renamed aliases migrate on the next successful managed refresh, with
foreign-edit refusal. Named Hermes profiles need explicit Apply.

`ocx export --client hermes --model-names alias --json` previews a current
already loaded catalog without writing client files or managed state; a cold or
stale catalog returns unavailable. Explicit `--out` writes an export artifact.
See the [English integration guide](/guides/integrations/#opt-in-alias-model-names)
for the canonical workflow.
