---
title: 遠端連結
description: 透過 SSH 連接 OpenCodex Home 電腦與 Child 電腦。
---

機器連結透過 SSH 連接 OpenCodex **Home** 電腦與 **Child** 電腦。Home 透過 SSH 通道為 Child 提供服務，兩台電腦各自繼續在 `10100` 連接埠執行本機 OpenCodex 服務。儀表板會透過 SSH 傳送 Child 專用的連結金鑰，因此不需要手動輸入權杖。

## 需求

- Home 可以使用 OpenSSH 金鑰登入 Child。
- 對於由 Child 發起的連結，Child 必須能使用 OpenSSH 金鑰登入 Home（不支援密碼登入）。
- Child 已安裝 OpenCodex 2.66.0 或更新版本（由 Child 發起的連結也要求 Home 符合）。
- 兩台電腦可執行 macOS、Linux 或 Windows x64。Windows 需要 OpenSSH Server 和 Windows PowerShell，不需要 Git Bash 或 curl。
- 從 Home 新增 Child 的儀表板需在 Home 上開啟，或使用已配對的 Hub 工作階段。將目前電腦轉換為 Child 需要由操作者配對的儀表板工作階段；未經憑證簽發的本機工作階段不能提交這項路由變更。

不支援密碼 SSH。可從 Home 或 Child 發起連結。Windows 透過相同固定主機金鑰的 OpenSSH 連線執行 PowerShell。

## 從 `#remote` 新增 Child

1. 開啟儀表板的 `#remote`，開啟 Remote Link。
2. 選擇 **Home**，然後按 **Continue**。SSH 主機列表會開啟。
3. 從 SSH 候選主機選擇主機，或輸入 SSH 設定別名。
4. 執行連線測試，並將顯示的主機指紋與目標電腦的指紋比較。比較指紋可在 SSH 信任主機前發現錯誤的電腦或已變更的主機金鑰。
5. 確認指紋，然後連接 Child。

儀表板不會要求輸入權杖。它會先探測主機，只有明確確認指紋後才能套用連結。

新增 Child 視窗會說明 Child 透過 SSH 使用此 Home 的供應商，並列出上述必要條件。別名來自執行 OpenCodex 的 Home 上的 `~/.ssh/config`，不一定是顯示瀏覽器的電腦。如果探索成功但沒有主機，請新增如下 `Host` 項目後重新掃描。也可以手動輸入現有別名；選取或輸入別名後即可啟用連線測試。視窗還提供本指南的連結。

```sshconfig
Host devbox
  HostName devbox.example.com
  User you
  IdentityFile ~/.ssh/id_ed25519
```

如果探索失敗，視窗會顯示載入失敗、可用的請求原因和重試按鈕，而不是聲稱清單為空。連線測試失敗的具體原因與清理後的 SSH 提示只在作用中視窗顯示，不會在背後重複顯示。檢查原因，必要時使用下方 SSH 診斷方法，然後重試。重新掃描會保留輸入的別名，但連線前必須重新檢查指紋。

## 將這台電腦連線為 Child

在要使用 Home 供應商的電腦上：

1. 在儀表板中開啟 `#remote` 並開啟 Remote Link。
2. 選擇 **Child**。SSH 主機清單會開啟。
3. 選擇 Home 的 SSH 主機，執行連線測試，然後比較並確認其主機指紋。
4. 閱讀提示後選擇 **Connect as Child**。

連線會重新啟動這台電腦上的 OpenCodex。已在執行的 Codex 請求會先完成，重新啟動期間新的請求可能在最多一分鐘內失敗。之後儀表板會自動重新載入並顯示 Child 連結。Codex 會繼續使用這台電腦上的 `http://127.0.0.1:<port>/v1`，不需要設定權杖或環境變數：本機 OpenCodex 會把每個請求轉送給 Home，由 Home 以它自己的供應商與帳戶提供服務。

如果 **Child** 提示先配對這台電腦，請在這台電腦上開啟設定的 HTTP 回環 IP 位址儀表板，例如 `http://127.0.0.1:<configured-port>`。只有在缺少配對且儀表板與 API 使用相同的回環來源時，才會顯示本機配對表單。複製表單中的 `ocx gui pair --origin "http://127.0.0.1:<configured-port>"` 命令，在這台電腦的終端機中執行，再將一次性代碼貼到表單中。必須使用表單顯示的確切來源；供應商 API 金鑰或管理員權杖不是配對代碼。缺少配對與設定的連接埠不符是不同的原因。

選擇 **Child** 角色還要求 OpenCodex 以獨立執行模式在其設定的連接埠上執行，因為 Child 會在正好這個連接埠上重新啟動。如果儀表板提示 OpenCodex 未在其設定的連接埠上執行，請先在該連接埠上重新啟動它。

## 連結狀態

- **Connected** 表示 SSH 通道已準備好，Child 可以使用 Home 連結。
- **Reconnecting** 表示正在重試通道。重試期間請求可能暫時回傳帶有 `Retry-After` 的 `503`。在從自己的儀表板連線的 Child 上，請求會先最多等待 15 秒讓通道恢復。
- **Failed** 表示連結需要處理。請檢查 SSH 驗證、已確認的主機金鑰、轉送或逾時原因。建立 SSH 通道的一方會在睡眠、故障或重新啟動後自動重試（Home 新增的 Child 由 Home 重試，從自己的儀表板連線的 Child 由 Child 重試）：逾時或轉送錯誤後先在一分鐘後重試，之後每次重試失敗等待時間加倍，最長五分鐘一次；驗證錯誤後每五分鐘一次。主機金鑰變更時不會重試。要立即重新連線，請在 Home 的儀表板中選擇 **Retry**，或在 Home 上執行 `ocx link reconnect --link-id <id>`。這只會重新啟動該連結的通道，不會重新啟動 OpenCodex。

連結失敗時不會靜默切換到本機供應商。

## 移除 Child

選擇 Child 的 **Disconnect** 並確認別名。Home 會停止通道、撤銷該 Child 的連結金鑰，並刪除已儲存的連結記錄。

如果 Home 無法連到 Child 來執行中斷連線命令，請選擇 **Remove here only**。這只會刪除本機的通道、金鑰與記錄。然後登入 Child 並執行：

```bash
ocx disconnect
```

若要中斷由 Child 發起的連結，請在 Child 上執行 `ocx disconnect`。這個命令會中斷用戶端通道，並透過 SSH 在 Home 上撤銷連結。如果 Home 撤銷失敗，命令會輸出：`Home revoke failed; run ocx link revoke --link-id <linkId> on the home.`

## 安全性

Child 會透過連結使用 Home 電腦上的供應商與供應商憑證。Home 會為每個 Child 建立獨立的連結金鑰；移除連結會撤銷該金鑰。確認前請比較主機指紋，避免誤接受錯誤電腦或已變更的主機金鑰。由 Tailscale 身分簽發的儀表板工作階段無法管理機器連結。 在 Child 上，金鑰只保留在 OpenCodex 內部：Codex 或 Claude Code 在 Child 上傳送的憑證不會轉送給 Home，Child 上任何能存取 `127.0.0.1:<port>` 的程式都可以不用金鑰使用 Home，這與獨立安裝給予本機程式的信任相同。來自其他網站的網頁會被拒絕。

## CLI 參考

```text
ocx link probe <alias> [--json]
ocx link add <alias> [--expect-fingerprint SHA256:…] [--json]
ocx link port [--json]
ocx link issue --alias <alias> --tunnel-port <port> [--json]
ocx link status [--json]
ocx link revoke --link-id <id> [--json]
ocx link reconnect --link-id <id> [--json]
ocx link check (--link-id <id> | --all) [--no-wait] [--json]
ocx link update (--link-id <id> | --all) --yes [--no-wait] [--json]
ocx link sync (--link-id <id> | --all) [--no-wait] [--json]
ocx link sync --link-id <id> (--restart-app-server-only | --restart-codex --yes) [--no-wait] [--json]
ocx link restart-codex --link-id <id> [--scope app-server|codex] --yes [--no-wait] [--json]
```

非互動式終端（非 TTY）必須提供 `--expect-fingerprint`。互動式終端中可省略此參數，但必須明確確認提供的指紋。

在 Home 上，`ocx link check (--link-id <id> | --all)` 會讀取每個由 Home 新增的 Child 的已安裝版本、安裝類型和更新途徑：它透過連結的 SSH 連線在 Child 上執行 `ocx update --plan`（每台 Child 60 秒，同時最多三台），該命令只計算更新計畫，不會做任何修改。早於 2.97.0 的 Child 會顯示為 `owner-action`（`legacy-ocx`），其版本在 macOS 和 Linux 上透過再一次唯讀 SSH 呼叫取得，在 Windows 上則取自 Child 透過連結回報的版本。由 Child 發起的連結和 `ocx-child` Child 不經 SSH 直接回報。`ocx link status --json` 會為每一列加上 `child` 區塊（版本、版本差異、目錄是否最新、活動狀態、最近一次操作）。詳情與結束代碼請見 [Child install, catalog and activity](/guides/remote-link/#child-install-catalog-and-activity)（英文）。

### 從 Home 操作 Child

`ocx link sync`、`ocx link restart-codex` 和 `ocx link update` 會透過連結的 SSH 連線在由 Home 新增的 Child 上執行，並以 JSON 輸出工作。`sync` 執行固定的 `ocx sync --expect-link`（Child 需為 2.93.0 或更新版本）。`restart-codex` 會先同步，再重新啟動 Child 上的 Codex app-server，讓執行中的 Codex 載入目前的目錄；`--scope codex` 也會重新啟動桌面應用程式。重新啟動只能指定一個連結；`restart-codex` 和 `--restart-codex` 需要 `--yes`，而 `ocx link sync --link-id <id> --restart-app-server-only` 不需確認即可重新啟動 app-server。當 Home 正在為該 Child 中繼模型請求時，會略過重新啟動（`restart-skipped:link-active`）。對於早於 2.69 的 Child，非串流請求要到回應開始後才看得到。`update --yes` 會使用 Child 自己的更新程式，把 Child 的 OpenCodex 更新到這個 Home 的版本，絕不會更新到其他版本（Child 需為 2.97.0 或更新版本；npm 和 pnpm 安裝透過其 Node 啟動器套用更新，因此 `ocx link check` 也會在那裡以唯讀方式執行 `node --version`）。一次更新一台 Child，套用成功、失敗或回復後會再次同步；結果未知的套用不會重試也不會同步，請用 `ocx link check` 檢查。正在為該 Child 中繼的請求會中斷。Windows Child 只支援 `sync`，`ocx-child` Child 會將重新啟動和更新回報為不支援。CLI 需要繫結到 loopback 的 Home；在其他 Home 上無法執行這些操作，儀表板也不提供這些操作。詳情與結束代碼請見 [Operating Children from the Home](/guides/remote-link/#operating-children-from-the-home)（英文）。 此保護僅為盡力而為：在檢查與重新啟動之間開始的請求仍可能被結束，因此需要保留回合時，請先暫停該 Child 上的新請求。 `ocx sync --restart-children`（或 `--restart-children=codex --yes`）在 Home 同步向外傳播時，對所有 Child 或以 `--child <linkId>` 指定的 Child 套用同一規則：每台 Child 都會同步，只有在有中繼請求進行時才略過其重新啟動（`restart-skipped:link-active`）。

### 目錄自動分發與 Child 政策

目錄分發預設為開啟。當 Home 的目錄變更時（目錄自動重新整理回報變更，或每 5 分鐘一次的檢查發現在儀表板或管理 API 中所做的編輯），Home 會等待 60 秒讓編輯穩定下來（距第一次變更最多 5 分鐘）。之後不需要你做任何操作，它會在背景為每台符合條件的 Child 開啟一個 SSH 工作階段，執行與 `ocx link sync` 相同的固定 `ocx sync --expect-link`；除非你啟用（見下文 `childCodexRestart`），否則不會重新啟動 Codex。符合條件的 Child 是：由 Home 發起的連結、通道已連線、沒有其他操作在執行，而且此 Home 在那裡最後一次執行的同步早於這次變更；只下載過目錄的 Child 仍視為落後。正在中繼模型請求的 Child，只有在其 Codex 設定已經與 Home 一致、且套用這些設定後其 OpenCodex 用戶端執行環境已經重新啟動過時才會同步，否則同步會重新啟動該執行環境；否則會在它閒置後再同步。同步失敗會在 5 分鐘後重試，間隔逐次加倍，最長 6 小時；低於 2.93.0 的 Child 在回報其他版本之前不會重試。這些工作與其他工作顯示方式相同，帶有 `trigger: "auto"`。沒有連結的 Home 不會執行其中任何部分。

分發修正的是 Child 的目錄檔案。Child 上已經在執行的 Codex app-server 會繼續使用已載入的清單，直到重新啟動：請使用 `ocx link restart-codex --link-id <id> --yes` 或 `ocx sync --restart-children`，或以 `ocx link policy --child-codex-restart app-server-when-idle` 讓 Home 重新啟動 app-server；Home 只會在同步執行時仍然閒置的 Child 上這麼做。該設定從下一次自動同步起生效；目錄已是最新的 Child 不會被同步，因此也不會被重新啟動，請手動重新啟動它。

政策儲存在 Home 的 `<configDir>/link/child-policy.json` 中，不會寫入 `config.json`：

| 設定 | 預設值 | 可用值 |
|---|---|---|
| `catalogFanout` | `auto` | `auto`, `manual` |
| `childCodexRestart` | `never` | `never`, `app-server-when-idle` |
| `updates` | `auto-when-idle` | `off`, `notify`, `auto-when-idle` |
| `idleAfterMs` | `600000` (10 分鐘) | 1 到 60 分鐘 |

`updates` 預設會自動讓閒置的 Child 維持與 Home 相同的版本。本版本中自動更新尚未生效；該設定現在就會儲存，因此以 `ocx link policy --updates notify` 或 `--updates off` 做出的退出選擇，在自動更新推出時依然有效。`idleAfterMs` 表示 Child 在沒有被中繼的模型請求的情況下持續多久才算閒置；它也決定 `ocx link status` 中的 `activity.idle`。

```text
ocx link policy                                    # 讀取政策
ocx link policy --catalog-fanout manual            # 關閉目錄自動分發
ocx link policy --child-codex-restart app-server-when-idle
ocx link policy --updates off --idle-after-minutes 20 --json
```

`GET` 和 `PUT /api/link/children/policy` 讀取和變更相同的設定（迴路介面上的管理權杖，或儀表板工作階段）；`PUT` 只傳送要變更的設定。如果檔案損毀或包含未知的值，目錄自動分發和更新都會關閉，而且 `ocx link policy` 會提示這一點。儲存會清除警告，但未指定的設定仍保持關閉，請明確開啟，例如 `ocx link policy --catalog-fanout auto --updates auto-when-idle`。Home 從不自行改寫該檔案。

不要連結不屬於你的機器：Home 會用你的 SSH 金鑰在那裡執行指令。

## 相關指南

- [Remote Hub 部署](/zh-tw/guides/remote-hub/)
- [遠端工作區](/zh-tw/guides/remote-workspace/)


`ocx link probe <alias> --json` · `ocx link add <alias> --expect-fingerprint SHA256:… --json` — [CLI, restart, relay verification and recovery](/guides/remote-link/#add-a-child-from-the-terminal).
