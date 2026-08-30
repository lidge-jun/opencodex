---
title: CLI 供應商、帳號與模型
description: 供應商設定、憑證、配額與模型目錄指令。
---

這些指令設定上游供應商、認證帳號、管理憑證池，並控制暴露給 Codex 的模型目錄。

## 供應商

### `ocx provider <subcommand>`

非互動式供應商管理。Registry 項目依名稱播種；自訂名稱需要同時提供 `--adapter` 與 `--base-url`。

| 子指令 | 支援的旗標 | 動作 |
| --- | --- | --- |
| `list` | `--json` | 列出已設定的供應商與剩餘的 registry 項目。 |
| `add <name>` | `--adapter <adapter>`, `--base-url <url>`, `--api-key <key>`, `--default-model <model>`, `--set-default`, `--force`, `--json`, `--sync` | 新增 registry／自訂供應商。`--force` 覆寫；`--sync` 在人類輸出模式下重新整理執行中的代理。 |
| `edit <name>` | 供應商欄位旗標, `--json` | 編輯已驗證的即時供應商欄位而不替換金鑰池。 |
| `test <name>` | `--json` | 探測真實上游模型端點。 |
| `show <name>` | `--json` | 顯示設定，API 金鑰已遮罩。 |
| `remove <name>` | `--json` | 移除非預設供應商；最後一個供應商無法被移除。 |
| `set-default <name>` | `--json` | 選擇既有供應商作為預設。 |
| `selected <name>` | `--set <ids>`, `--clear`, `--json` | 讀取或更新供應商模型允許清單。 |
| `quota` | `--refresh`, `--json` | 讀取供應商配額報告。 |
| `presets` | `--json` | 列出儀表板供應商預設。 |
| `account-mode` | `pool`, `direct`, `--json` | 選擇池化或直接的 Codex 帳號路由。 |

```bash
ocx provider list --json
ocx provider test ark
ocx provider add anthropic --api-key sk-ant-... --set-default --sync
ocx provider add local-dev --adapter openai-chat --base-url http://localhost:11434/v1
ocx provider show anthropic --json
ocx models --provider anthropic --json
ocx models live --provider ark --json
```

## 認證

### `ocx login <provider>`

啟動供應商已註冊的登入流程。OAuth 供應商會開啟瀏覽器並在 `~/.opencodex/` 下儲存自動重新整理的憑證；API-key 登入供應商會開啟其金鑰儀表板、提示輸入金鑰、在可能時驗證它，並儲存產生的供應商設定。當名稱缺失或未知時，指令會印出目前接受的 OAuth 與 API-key 供應商 id。

在 `ocx status` / `ocx doctor` 回報需要重新認證或終端 refresh 失敗後，請使用相同指令**重新認證**（或在儀表板中使用 Reauthenticate）。Codex pool 帳號不是公開的 `ocx login` 供應商——請改由儀表板 Codex 帳號池（Reauthenticate）或無頭的 `ocx account reauth` 流程重新認證。

```bash
ocx login xai
ocx login anthropic
```

### `ocx logout <provider>`

移除供應商已儲存的 OAuth 憑證。

## 帳號與金鑰池

### `ocx account <subcommand>`

透過執行中的代理列出並切換供應商帳號與 API-key 池。隨附的說明介面如下：

```text
Usage: ocx account <list|current|use|refresh|auto-switch|login|reauth|code|cancel|remove|add-key|reset-credits> ...

list [provider]     Codex 帳號池、OAuth 帳號與 API 金鑰（識別碼依 API 回傳遮罩顯示）。
current <provider>  顯示現用帳號或金鑰。
use <provider> <id> 切換現用憑證；'main' 選擇 Codex App 登入。
refresh <provider>  強制重新整理 Codex 或供應商配額報告。
auto-switch <provider> <on|off|status|threshold N>  控制 Codex 池閾值。
remove <provider> <id> --yes  在存在檢查後移除已儲存的帳號或金鑰。
add-key <provider> [--label <label>]  僅從 piped stdin 讀取並新增金鑰。
login/reauth/code/cancel  從無頭 shell 執行瀏覽器或手動 code 認證。
reset-credits <id|main> [--consume --yes]  檢查或消耗 Codex reset credits。
Codex 池選擇套用於清除既有親和性後的下一個請求；進行中的請求保留其擷取的帳號。
```

所有子指令都需要代理正在執行；CLI 自動解析其記錄的 runtime 連接埠。成功的操作離開 0。無效用法、未知供應商或帳號／金鑰 id、不可達的代理或 API 失敗則離開 1。憑證欄位完全依管理 API 回傳的方式顯示（包含其遮罩）；原始 API 金鑰與 OAuth token 永不回傳。顯示便利性在客戶端合成，與儀表板相同：`main` 是 `openai` 帳號池中 Codex App 登入的 CLI 別名，無電子郵件的 OAuth 帳號顯示為 `Account N`，而 plan／label 欄位在 plan、遮罩電子郵件、label 與遮罩金鑰之間回退。

`--json` 帳號列使用此通用結構（不可用時省略可選欄位）：

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

### `ocx account list [provider] [--json] [--all] [--quota [--refresh]]`

未指定供應商時，列出 Codex 池、OAuth 帳號與已設定的 API-key 池。除非存在 `--all`，否則空的供應商會被跳過。指定供應商時，僅列出該憑證家族。人類輸出使用 `PROVIDER TYPE ID PLAN/LABEL STATUS`；手動選擇的 Codex 列標記為 `selected`。當儲存了兩個以上符合資格的 Kiro 帳號時，預設情況下 429 會自動輪換至另一個帳號，並優先選擇已知剩餘額度最多的帳號；輪換由帳號存在與否驅動，可透過 `oauthAccountFailover.enabled: false` 關閉。`ocx account login kiro` 每次將一個帳號加入池中。空結果仍為成功。`--json` 回傳：

```text
{ accounts: AccountRow[], notes: string[] }
```

### `ocx account current <provider> [--json]`

顯示現用帳號或金鑰。無手動 pin 的 Codex 池回報自動最低用量選擇；另一個無現用憑證的家族回報該狀態並仍離開 0。`--json` 回傳：

```text
{ provider, type, activeId: string | null, autoSwitchThreshold?: number, account: AccountRow | null }
```

### `ocx account use <provider> <account-or-key-id|main> [--json]`

選擇既有的 Codex 帳號、OAuth 帳號或 API 金鑰。對於 `openai`，`main` 選擇 Codex App 登入。Codex 池選擇清除行程本地親和性並套用於下一個請求，包含來自既有可見任務的請求；代理重啟或親和性驅逐也可能使任務未綁定，而進行中的請求保留其擷取的帳號。這僅控制池路由；Direct 模式繼續使用呼叫者擁有／原生的 main 憑證。基於用量的主動切換、401/403 重新認證、429/retry-after 冷卻、排除，以及 pre-output 429/402 失敗復原稍後可能選擇另一個合格的池帳號。當基於用量的切換關閉時，這些復原路徑仍然活躍。OpenCodex 在帳號變更後重播對話，但供應商端的 prompt cache 可能是冷的。未知的供應商或 id 離開 1。
在 **401/403** 時，App 登入清除該帳號的行程本地親和性並要求重新認證。
在 **429** 時，opencodex 遵循 `Retry-After`、啟動帳號冷卻、清除親和性，並可能將請求輪換到另一個合格的池帳號。這些失敗轉換在 `autoSwitchThreshold: 0` 時仍然活躍；該設定僅停用基於用量的主動切換。
`--json` 回傳：

```text
{ ok: true, provider, type, activeId }
```

### `ocx account refresh <provider> [--json]`

對於 Codex 池，請使用 `ocx account refresh openai [--json]`。它強制重新整理帳號配額並印出可用的週／月百分比與重置時間；缺失的配額資料被回報為未知，而非 0%。其 JSON 封裝為 `{ accounts: AccountRow[] }`，每個 Codex 列上有 `quota`。

對於 OAuth 與 API-key 供應商，這會強制重新整理供應商配額報告端點；它不是 token 重新登入或普通的帳號清單重新讀取。`--json` 回傳
`{ provider, report: ProviderQuotaReport | null }`。無支援配額報告的供應商會印出
`no quota report available for <provider>` 並離開 0。未知供應商與管理 API 失敗離開 1；失敗或逾時的上游配額探測會降級為 null 或過時報告（離開 0），與儀表板的配額列一致。

### `ocx account auto-switch <provider> <on|off|status|threshold <0-100>> [--json]`

僅控制 `openai` Codex 帳號池。`on` 設為 80%，`off` 設為 0%，`status` 讀取目前值，而 `threshold <n>` 接受 0 到 100 的整數。其他供應商與無效值離開 1。`--json` 回傳：

```text
{ provider, autoSwitchThreshold: number, enabled: boolean }
```

### `ocx account login|reauth|code|cancel ...`

從無頭 shell 執行基於瀏覽器或手動 code 的帳號認證。請使用 `ocx account --help` 查看供應商專屬的指令形式。

### `ocx account remove <provider> <id|main> --yes [--json]`

此受保護的非互動刪除需要 `--yes`。刪除前，它驗證 id 存在；缺失的 id 離開 1 而不發送 DELETE。主要的 Codex App 登入無法被移除，因此 `remove openai main --yes` 被拒絕。刪除後，家族會再次讀取：移除 pin 的 Codex 帳號會清除 pin 並回到自動選擇；OAuth 提升第一個剩餘帳號或回報無；API-key 池提升第一個剩餘金鑰或回報無。`--json` 成功與失敗結構為：

```text
{ ok: true, provider, id, removedActive: boolean, promotedActiveId: string | null }
{ error: string } // stderr, exit 1
```

### `ocx account add-key <provider> [--label <label>] [--json]`

為 API-key 供應商新增並啟用金鑰。金鑰僅從非 TTY piped／重新導向的 stdin 讀取；互動式 TTY 輸入、空輸入、OAuth／Codex 供應商與 API 失敗離開 1。金鑰永不回顯，即使它出現在 label 中時亦然。偏好使用密碼管理員或 here-string：

```bash
ocx account add-key openrouter --label personal <<< "$OPENROUTER_API_KEY"
security find-generic-password -w openrouter | ocx account add-key openrouter --json
```

`--json` 回傳 `{ ok: true, id: string | null, label?: string }` 且永不包含金鑰。

### `ocx account reset-credits <id|main> [--consume --yes]`

檢查帳號的 Codex reset credits。消耗 credit 是破壞性的，需要同時提供 `--consume` 與 `--yes`。

### `ocx account priority <provider> <account-id|main> [<-100..100|first|earlier|normal|later|last|reset>] [--json]`

讀取或設定某個 Codex pool account 的選擇順序：**數值越高越早使用**，預設為 `0`，範圍是
`-100` 到 `100`。只有 `openai` Codex pool 有順序，其他 provider 會以 exit 1 結束。
`main` 指定 Codex Desktop 登入，它與其他 pool account 一樣有順序——`ocx account priority
openai main last` 就是把它保留為後備的方式。

預設字詞代表小整數：`first` 是 `+2`、`earlier` 是 `+1`、`normal` 是 `0`、`later` 是
`-1`、`last` 是 `-2`。`reset` 把帳號回復到預設並刪除其儲存條目。**省略數值時讀取**
目前順序，而不是寫入一個。

順序決定哪些帳號優先被考慮，而不是哪些可用：選取仍在合格帳號之間進行，取仍有配額
餘裕的最高順序層級，並讓 `accountPoolStrategy` 在該層級內選擇。暫停、冷卻與重新認證
不受影響。變更從**下一個未繫結請求**開始生效，而不只是新啟動的 session：一旦較高的
順序恢復餘裕，preemption 就會優先移動未繫結的請求。已繫結到某個帳號的執行緒通常會
保留到該帳號被耗盡；重新認證失敗、配額冷卻或一連串暫時失敗會提前解除繫結。任何接受的
寫入也都會釋放手動「立即使用此帳號」的 pin——無論 pin 在哪個帳號上——包括寫入一個
帳號已經持有的順序；這是清除 pin 同時保留目前選取帳號的唯一方式。（透過管理 API 清除
active account 也會釋放 pin，但會一併丟掉該選取。）代理無法連線、未知的帳號 id 或超出
接受集合的值會以 exit 1 結束。`--json` 回傳：

```text
{ ok: true, provider, id, priority: number, preset: string | null }
```

### `ocx account main <subcommand>`

管理具名的原生 Codex main-login 設定檔，不變更 OpenCodex account-pool 路由：

```text
ocx account main doctor [--json]
ocx account main list [--json]
ocx account main register <label> [--json]
ocx account main add <label>
ocx account main switch <profile-id-or-label> --yes [--json]
ocx account main recover [--rollback --yes] [--json]
```

每個會變更狀態的命令都會回報執行中代理回傳的 canonical 有效 `CODEX_HOME`。這個路徑可能與
呼叫端的 `CODEX_HOME` 不同；支援 JSON 的命令以 `effectiveCodexHome` 暴露同一個值。

Version 1 支援基於檔案的 Codex 認證，以 AES-256-GCM 加密儲存的設定檔，並把加密金鑰放在
作業系統的憑證儲存中。`add` 在匯入產生的憑證之前先執行正式的 Codex 登入流程。切換設定檔
前請先關閉 Codex；成功的切換會保留本機任務與歷史記錄，然後要求重新啟動 Codex。使用
`doctor` 檢查設定檔狀態，使用 `recover` 完成或復原中斷的轉換。`switch` 接受設定檔 id
或其 label。

v1 復原矩陣涵蓋交易檔已透過 rename 發布後 OpenCodex 程序退出的情況。它不宣稱在 OS 或
kernel 崩潰、突然斷電下仍具持久性：`atomicWriteFileAsync()` 不會 `fsync` 檔案或其父目錄。

加密 vault、切換 journal、復原標記與 journal quarantine 位於 canonical
`<real CODEX_HOME>/.opencodex-native-main-profiles` 目錄，因此共享該 Codex home 的每個
OpenCodex 實例只看到一個 owner 與一個復原狀態。明文登入暫存保持隔離在各個
`<OPENCODEX_HOME>/native-main-profile-staging` 目錄下。

在原生 main 流量或 journal 復原被受理前，lifetime owner 取得獨佔的憑證請求，且只清除
精確的 `auth.json.ocx.<pid>.<sequence>.tmp` crash 殘留。每個候選都必須是未變更 canonical
`CODEX_HOME` 下的單一連結 regular file；它會被截斷、flush 再 unlink。link/reparse 替換、
身分變更與其他歧義會讓原生 main 流量保持關閉，而近似名稱的檔案絕不會被自動移除。這保護
的是合作的 OpenCodex 崩潰，不是已經以相同 OS 使用者身分執行的惡意程序。該使用者與含有
`CODEX_HOME` 的檔案系統仍被視為可信，且截斷不保證從 copy-on-write 儲存、快照或 SSD
殘留中實體抹除。

Preview 建置使用 `<OPENCODEX_HOME>/native-main-profiles`。該配置絕不會被靜默匯入。如果
`doctor` 回報舊版設定檔狀態，請停止共享相同 `CODEX_HOME` 的每個 OpenCodex proxy。然後
把相符的 `*.vault.json`、`*.journal.json`、復原標記與任何被引用的 journal-quarantine
檔案一起備份並移動到 canonical 目錄，同時保留 owner-only 權限；或移除舊 preview 組合並
重新執行 `ocx account main register`。在多個舊 root 之間選擇，或在任何共享 proxy 作用中
時同時執行兩種配置，都不被允許。在 Windows 上，以舊的大小寫摺疊 home 身分為鍵的 preview
狀態必須重設而不是移動，因為其加密 AAD 與 OS keyring 身分刻意不重複使用。

## 模型

### `ocx models [subcommand]` · `ocx model <subcommand>`

`ocx model` 是 `ocx models` 的別名。無子指令時，列出已設定供應商中靜態播種的模型。`--provider` 過濾一個已設定的供應商，而 `--json` 回傳模型中繼資料。`live` 讀取執行中的目錄；`add`、`edit`、`remove` 與 `list-custom` 管理手動目錄項目；`enable`、`disable` 與 `provider` 控制可見性；`selected` 控制供應商允許清單；`context` 控制供應商 context 上限；而 `shadow` 管理背景 shadow-call 攔截。

儀表板提供的每個 per-model 操作在此皆可用，因此無頭安裝永不需要 GUI 來管理目錄。`add`、`remove` 與 `list-custom` 針對設定檔運作並透過目錄同步套用於執行中的代理；其餘與即時管理 API 通訊並需要代理正在執行（`ocx start` 或已安裝的服務）。

| 子指令 | 支援的旗標 | 動作 |
| --- | --- | --- |
| `list`（預設） | `--provider <name>`, `--json` | 列出已設定供應商中播種的模型。 |
| `live` | `--provider <name>`, `--json` | 讀取執行中的目錄，包含 runtime 探索的模型。列標記為 `native`/`routed`、`custom` 與 `enabled`/`disabled`。 |
| `add <provider> <modelId>` | `--display-name <name>`, `--context-window <tokens>`, `--modalities <text,image,audio>` | 註冊供應商目錄未廣告的模型。 |
| `edit <custom-id>` | `--model-id <id>`, `--display-name <name\|->`, `--context-window <tokens\|0>`, `--modalities <text,image,audio\|->`, `--json` | 編輯自訂模型。`-` 清除欄位；`0` 清除 context window。 |
| `remove <custom-id\|provider/modelId>` | `--yes` | 刪除自訂模型。stdin 非互動終端時需要 `--yes`。 |
| `list-custom` | `--json` | 顯示所有自訂模型及其 `custom-id`（其他子指令所採用）。 |
| `enable <provider/model\|native-model>` | `--native`, `--json` | 使一個模型對 Codex 可見。 |
| `disable <provider/model\|native-model>` | `--native`, `--json` | 對 Codex 隱藏一個模型。 |
| `provider <name> <on\|off>` | `--json` | 在單次寫入中啟用或停用一個供應商的所有模型。 |
| `selected <provider>` | `--set <id,id...>`, `--clear`, `--json` | 讀取或替換供應商模型允許清單。`--clear` 移除允許清單，使每個模型都被提供。 |
| `context <status\|value <tokens>\|provider <name> <on\|off>\|all <on\|off>>` | `--json` | 讀取或設定 context-window 上限，全域或 per 供應商。 |
| `shadow <status\|set> [model\|-]` | `--enabled <on\|off>`, `--json` | 讀取或設定 Codex 背景 helper 呼叫的替換模型。`-` 清除模型。`status` 亦回報 `sourceModels`，即代理攔截的 helper slug（預設：`gpt-5.4-mini` 與 `gpt-5.6-luna`）。 |

```bash
ocx models live --json                                  # Codex 目前實際可見的模型
ocx models disable anthropic/claude-haiku-4             # 隱藏一個路由模型
ocx models enable gpt-5.6-sol                           # 無斜線，因此被視為原生
ocx models provider zenmux off                          # 批量隱藏一個吵雜的供應商
ocx models selected anthropic --set claude-opus-5,claude-fable-5
ocx models selected anthropic --clear                   # 再次卸下允許清單
ocx models add deepseek deepseek-v4 --display-name 'DeepSeek V4' --context-window 128000 --modalities text,image
ocx models list-custom --json                           # 讀取用於 edit/remove 的 custom-id
ocx models remove deepseek/deepseek-v4 --yes
```

帶斜線的模型選擇器為路由（`anthropic/claude-opus-5`）；裸 id 被視為原生 OpenAI 模型，因此 `--native` 僅在需要對一個否則看起來是路由的 id 強制該判讀時才需要。

`--modalities` 僅接受 `text`、`image` 與 `audio`。Codex 將該欄位解析為封閉列舉，並拒絕包含任何其他值的整個目錄，因此 `add`、`edit` 與管理 API 都會拒絕錯誤值，而非儲存目錄寫入器稍後必須剝除的內容（#759）。
