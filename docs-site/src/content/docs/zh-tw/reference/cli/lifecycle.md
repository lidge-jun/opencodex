---
title: CLI 生命週期
description: 安裝、啟動、停止、服務、診斷、同步與更新指令。
---

這些指令安裝、執行、檢查、修復並更新本機 opencodex 代理及其 Codex 整合。

## 安裝

### `ocx init` · `ocx setup`

互動式設定精靈（`setup` 是 `init` 的別名）。提示選擇供應商（預設或自訂）、API 金鑰（字面值或 `${ENV}`）、預設模型與代理連接埠；儲存 `~/.opencodex/config.json`；可選擇將代理注入 `$CODEX_HOME/config.toml`（預設 `~/.codex/config.toml`）；並可選擇安裝 Codex 自動啟動 shim。

## 代理生命週期

### `ocx start [--port <port>]`

啟動代理伺服器（偏好連接埠 `10100`）。若該連接埠被佔用，opencodex 會選擇並記錄另一個可用連接埠。它寫入 PID/runtime-port 狀態，並拒絕啟動第二個即時實例。啟動時它將每個供應商的模型同步到 Codex 目錄。關閉時它還原原生 Codex——除非它是作為受管服務啟動的（`OCX_SERVICE=1`）。

```bash
ocx start
ocx start --port 8080
```

### `ocx stop`

停止執行中的代理（依 PID）、移除 PID 檔案，並還原原生 Codex。若已安裝受管背景服務，`ocx stop` 也會先停止它，使其無法重新生成代理。相同動作亦可從網頁儀表板的 **Stop** 按鈕執行（`POST /api/stop`）。

### `ocx restart`

執行 `stop` 後接 `ensure`：停止代理／服務、還原原生 Codex、在背景啟動代理，並將即時連接埠同步回 Codex。

### `ocx ensure`

冪等地確保背景代理正在執行，然後同步其即時模型目錄。若
`codexAutoStart` 為 `false`，它會印出自動啟動已停用並不做事。

### `ocx restore [back]` · `ocx eject [back]`

在不停止代理的情況下還原原生 Codex——剝除注入的設定行與路由目錄項目，使普通 `codex` 再次以原生方式運作。`eject` 是 `restore` 的別名。

對任一拼法傳入 `back` 可在不變更代理生命週期的情況下，將普通 `codex` 重新指向已在執行的代理：

```bash
ocx restore back
ocx eject back
```

### `ocx recover-history --legacy-openai`

針對在可逆備份支援存在前、重新對應 Codex App 歷史的舊開發組建進行明確復原。若其歷史資料庫被鎖定，請先關閉 Codex。

### `ocx uninstall` · `ocx remove`

停止服務與代理、移除服務與 Codex shim、還原原生 Codex，然後僅在所有還原步驟成功時移除 opencodex 本機設定。`remove` 是 `uninstall` 的別名。設定清理需要由全新安裝建立的擁有權中繼資料；舊版或共享目錄會被原樣保留。

## 狀態與健康

### `ocx status [--json]`

印出唯讀診斷摘要：代理 PID、`/healthz` 可達性、儀表板 URL、設定路徑、預設供應商、Codex 自動啟動設定、服務狀態、shim 狀態與遮罩後的有效 Codex home。只有明確、高信心的 Windows Orca runtime-home 簽章會加上可採取行動的 App-home 不符警告；它永不自動變更 `CODEX_HOME`。

人類可讀輸出還在 OAuth 登入摘要後包含一個 **OAuth 健康** 區塊：當每個已知帳號都健康時為 `OAuth health:
ok`，或在有任一非健康帳號時為 `OAuth health: warning`，每個非健康帳號一行遮罩資料（供應商、遮罩帳號 id、狀態如需要重新認證、速率或配額限制，或 refresh 衝突），加上可選的 `Action:` 提示。帳號 id 會被遮罩；token 與電子郵件永不印出。`--json` 契約目前不包含此健康區塊。

```bash
ocx status
ocx status --json
```

縮寫範例結構：

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

實際物件還包含 `listen`（連接埠、主機名稱、runtime/config 來源）、設定載入診斷，以及 bundled Codex plugin 診斷。JSON schema 為附加式：未來版本可能新增欄位，但既有欄位應保持穩定。它刻意排除 API 金鑰、OAuth token、授權標頭、請求內容、電子郵件與帳號身分。

### `ocx health [--json]`

對即時代理進行身分檢查。人類可讀輸出回報 PID/連接埠；`--json` 輸出 `{ok, pid, port}`。此指令僅在健康時離開 0，否則離開 1，使其適合服務探測。

### `ocx ready [--json] [--wait [--timeout <seconds>]]`

透過免認證的 `GET /readyz` 端點檢查同步後的就緒狀態。就緒時回傳 `200`，或 `pending` 與終端 `failed` 時回傳附帶 `Retry-After: 1` 的 `503`。其淨化的 HTTP 身分為 `{service, version, uptime, pid, port, status}`。沒有 `/readyz` 的舊代理會以 `unreachable` 方式 fail closed；`/healthz` 是分開的存活檢查，而非就緒檢查。此指令預設執行一次探測；`--wait` 輪詢直到就緒或逾時，但在觀察到終端 `failed` 狀態時立即退出。預設逾時為 45 秒；`--timeout <seconds>` 需要 `--wait`，接受 1–300 的正整數秒。CLI JSON 輸出 `{ready, status, pid, port}`，其中 `status` 為 `ready`、`pending`、`failed` 或 `unreachable`。離開碼為：就緒 0；未就緒、pending、failed、逾時或 unreachable 1；無效引數 64。

### `ocx doctor`

執行唯讀環境與連線診斷：狀態路徑與檔案系統類型、WSL 雙重安裝、代理環境／設定、ChatGPT 可達性、Codex plugin 與專案設定警告，以及待處理的歷史遷移。Codex app-home 定向區段也會偵測窄義的 Windows Orca runtime-home 不符，並在適用時說明服務遷移。此診斷顯示的路徑會遮罩 OS 使用者名稱。Doctor 印出修復提示但不套用它們。

**OAuth 可靠度** 區段回報憑證儲存是否可寫、是否可在 `OPENCODEX_HOME` 下建立 refresh single-flight／lock 檔案、非健康的 OAuth 或 Codex pool 帳號（遮罩 id）及其恢復 `Action:`，以及一個關於 Codex forward path 不偽造官方客戶端中繼資料的靜態 OK。Doctor 永不變更憑證或套用修復。

## 目錄同步

### `ocx sync [--restart-codex]`

從每個已設定的供應商擷取即時模型清單，並將合併後的目錄重新注入 Codex。在新增供應商後或要重新整理可用模型時執行它。

若長壽的 Codex `app-server` 仍在執行，`ocx sync` 會警告它們可能繼續提供先前的記憶體內模型清單，即使 `opencodex-catalog.json` / `models_cache.json` 已更新。傳入 `--restart-codex` 以僅對目前使用者擁有的相符 `codex … app-server` 與 `codex-code-mode-host` 進程發送 `SIGTERM`（執行中的回合可能被中斷）。刻意避免廣泛的 `pkill -f codex` 比對。

### `ocx sync-cache [--restart-codex]`

使 Codex 的本機模型選擇器快取失效，使其從現用的 opencodex 目錄重建。與 `ocx sync` 相同的過時 `app-server` 警告與可選的 `--restart-codex` 行為適用。

## 背景服務

### `ocx service [install|repair|start|stop|status|uninstall|remove]`

將 opencodex 作為登入管理的背景服務執行（macOS **launchd**、Linux **systemd user unit**、Windows **Task Scheduler**），在登入時自動啟動並在崩潰時自動重啟。服務執行時設定 `OCX_SERVICE=1`，使重啟不會折騰 Codex 設定。

| 子指令 | 動作 |
| --- | --- |
| 無 | 建立／更新並啟動服務。 |
| `install` | 建立並啟動服務。註冊它，在 Windows 上需要提高權限。 |
| `repair` | 就地重新整理已安裝的服務並重啟它，而不重新註冊。 |
| `start` | 啟動已安裝的服務。 |
| `stop` | 停止服務並還原原生 Codex。 |
| `status` | 回報服務與代理診斷及日誌路徑。 |
| `uninstall` | 移除服務並還原原生 Codex。 |
| `remove` | `uninstall` 的別名。 |

```bash
ocx service
ocx service install
ocx service repair
ocx service status
ocx service uninstall
```

`install`、`start` 與 `repair` 會確認代理實際在已安裝服務內建的連接埠上回應，之後才回報成功——在三種平台上皆如此。它們等待最多 20 秒，然後印出伺服連接埠：

```
✅ opencodex service installed and serving on port 10100.
```

若沒有回應，它們會發出警告並**以非零離開**：

```
⚠️  Service installed, but no proxy answered on port 10100 within 20s.
   The manager registered the job; that is not the same as serving.
   Log:       ~/.opencodex/service.log
   Meanwhile: ocx start   (serves in the foreground)
```

在 Windows 上，`ocx service status` 將 Task Scheduler 註冊與身分驗證過的 OpenCodex 代理可達性分開回報。它不印出本地化的 `schtasks` 表格，使摘要在各 Windows code page 中保持可讀。

在 Windows 上，建立 Task Scheduler 項目需要提高權限。可識別的本地化存取拒絕文字保持既有的指引路徑。若該文字不可讀，後備方案需要擁有的指令形式 `/create /tn opencodex-proxy /xml <non-empty-path> /f`、狀態 1，以及確認的非提高 token；儀表板的 Startup Safety 動作隨後可自動請求 UAC。若該後備無法判斷 token 狀態，則保留原始排程器錯誤。外部工作與操作永不發出自動提高標記。請核准儀表板 UAC 提示，或在提高的 PowerShell 視窗中重新執行 `ocx service install`。

### `ocx codex-shim <install|status|uninstall|remove>`

在 PATH 上以輕量自動啟動腳本包裝基於腳本的 `codex` 啟動器。真實的 `codex.exe` 目標保持不動，以避免破壞精確的可執行檔呼叫。

若已完成的外部 Codex 更新覆寫了已安裝的 shim，下一個普通 `ocx` 指令會備份穩定的新啟動器並在分派前還原 shim。仍在變動中的啟動器保持不動並稍後重試。修復失敗會發出警告但不會使請求的指令失敗；手動後備：`ocx codex-shim install`。將 `codexShimAutoRestore` 設為 `false`，或設定 `OPENCODEX_CODEX_SHIM_AUTO_RESTORE=0` 以進行行程層級的退出。

| 子指令 | 動作 |
| --- | --- |
| `install` | 安裝 shim（若過時則修復）。 |
| `uninstall` | 移除 shim 並還原原始 Codex 二進位檔。 |
| `remove` | `uninstall` 的別名。 |
| `status` | 回報 shim 狀態（已安裝、過時或缺失）。 |

```bash
ocx codex-shim install
ocx codex-shim status
ocx codex-shim uninstall
```

:::tip[服務 vs Shim]
使用 `ocx service` 作為常駐背景代理（推薦）。使用 `ocx codex-shim` 作為輕量、按需啟動而無 daemon——代理僅在 `codex` 啟動時才啟動。
:::

### `ocx tray <install|start|stop|status|uninstall|remove> [--json] [--no-start]`

安裝並控制 Windows 狀態列圖示。它在 Windows 登入時啟動並提供一鍵代理控制。`start` 與 `stop` 僅控制圖示；請用其選單控制代理。`--no-start` 適用於 `install`，並在不立即啟動它的情況下安裝 tray。

## 儀表板

### `ocx gui`

在 `http://localhost:<port>` 開啟[網頁儀表板](/zh-tw/guides/web-dashboard/)，若代理未執行則自動啟動它。

## 更新

### `ocx update [--tag latest|preview]`

從 npm 自我更新 opencodex。穩定安裝使用 `@latest`；預覽安裝停留在 `@preview`，除非你傳入 `--tag latest|preview`。它偵測原始碼 checkout 並告訴你改用
`git pull && bun install`，且若你已是該 tag 的最新版本則為 no-op。執行中的代理會在檔案被替換前停止；已安裝的服務會自動重建並啟動，而前景安裝會印出 `ocx start` 作為下一步。

```bash
ocx update
ocx update --tag preview
```

當 [Release workflow](https://github.com/lidge-jun/opencodex/actions/workflows/release.yml) 將新版本發布到 npm 時，新版本即可使用。
