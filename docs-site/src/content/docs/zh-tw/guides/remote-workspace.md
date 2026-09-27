---
title: 遠端工作區
description: 將 Codex、Claude Code、Pi 及其登入集中在一台 OCX Hub，並由只安裝 OCX 的電腦提供工作區與建置環境。
---

如需 SSH 機器連結，請參閱[遠端連結](/zh-tw/guides/remote-link/)。

Remote Workspace 讓一台 OpenCodex Hub 執行程式碼代理，另一台電腦則提供專案檔案、指令、測試與建置運算。手機或第三台電腦可透過 Hub 儀表板控制工作階段。

```text
Phone browser -> Computer 1 OCX Hub -> encrypted channel -> Computer 2 OCX Executor
                 Codex / Claude / Pi                       project and commands
                 logins and sessions                      no coding CLI login
```

Executor 只需要 OpenCodex，不需要 Codex、Claude Code、Pi、ChatGPT 登入或供應商 API key。它會主動向 Hub 建立對外 WebSocket 連線，因此 Executor 不需要公開連接埠或路由器連接埠轉送。

:::caution[Experimental foundation]
Remote Workspace 是須自行啟用的實驗基礎功能，尚未用於正式環境。Linux 提供檔案工具與有條件的 bubblewrap 指令執行。Windows 和 macOS 只提供檔案工具：其官方原生 helper 會拒絕探測與指令請求。Windows 指令須待經驗證的生命週期擁有者能在取消期間保有清理權限後才會支援。缺少指令支援時，絕不會回退到 Hub 執行。
:::

## 設定 Hub

電腦 1 擁有所有程式碼代理的登入與模型工作階段。在該電腦安裝並登入要使用的代理，然後以 Hub 角色執行 OpenCodex：

```bash
ocx config set runtimeRole hub
OCX_REMOTE_WORKSPACE_ENABLED=1 ocx start
ocx gui
```

請在 Hub 程序本身設定 `OCX_REMOTE_WORKSPACE_ENABLED=1`；只在儀表板指令上設定，不會啟用已在執行的服務。未明確啟用的 Hub 會回傳停用狀態，不會建立工作區金鑰，也不會探測程式碼代理執行環境。

從手機或其他電腦開啟儀表板時，請使用經驗證的 HTTPS 部署。受支援的管理入口與 Tailscale 模式請見[遠端 Hub 部署](/zh-tw/guides/remote-hub/)。請勿公開未經驗證的本機儀表板連接埠。

Codex Remote Workspace 使用目前的 App Server 權限設定檔。若 Hub 選用的 Codex 設定仍包含舊版 `sandbox_mode` 或 `sandbox_workspace_write`，儀表板會回報 Codex 不可用，而不會用較弱的邊界啟動。使用此功能前，請遷移該 Codex 設定檔；不要同時設定舊版 sandbox 與權限設定檔。

## 配對 Executor

1. 在 Hub 儀表板開啟 **Remote Workspace**。
2. 選擇 **Create pairing code**。
3. 在電腦 2 上，切換至要公開的專案目錄。
4. 複製儀表板為該電腦產生的 **Linux / macOS terminal** 或 **Windows PowerShell** 指令。它會配對目前目錄，並讓 `ocx remote-workspace agent` 在該終端機中保持連線。

等效的手動流程如下：

```bash
cd /path/to/project
printf '%s\n' 'ONE-TIME-CODE' | ocx remote-workspace pair 'https://your-hub.example' \
  --pairing-code-stdin --root "$PWD"
ocx remote-workspace agent
```

在 Windows PowerShell 上，請使用儀表板顯示的指令。等效的手動形式如下：

```powershell
$pairingCode = 'ONE-TIME-CODE'
$pairingCode | ocx remote-workspace pair 'https://your-hub.example' `
  --pairing-code-stdin --root (Get-Location).Path
if ($LASTEXITCODE -eq 0) { ocx remote-workspace agent }
```

目前的 OCX Bun 可執行檔會自動以單一唯讀檔案加入 Linux sandbox。若專案需要位於系統路徑之外、由使用者安裝的工具鏈，可明確配對該路徑，而不用公開 home 目錄其餘部分：

```bash
printf '%s\n' 'ONE-TIME-CODE' | ocx remote-workspace pair 'https://your-hub.example' \
  --pairing-code-stdin --root "$PWD" \
  --toolchain-root "$HOME/.nvm/versions/node/v24/bin"
```

原生 helper 原始碼隨套件提供，供審查使用。建置它不會在本次移植中啟用 Windows 或 macOS 指令。`--executor-helper` 仍是已審查 helper 的選擇器；二進位檔存在或路徑已設定，都不能證明支援指令。

一次性代碼從標準輸入讀取，而非命令列參數。配對會建立本機裝置簽章金鑰及裝置專用 bearer。Hub 只儲存其雜湊值，從不接收 Executor 的真實路徑。按 Ctrl+C 可停止前景代理；再次執行會重新連接相同裝置。

不印出機密資訊即可檢查本機登記狀態：

```bash
ocx remote-workspace status
```

## 啟動遠端程式碼工作階段

在儀表板選擇：

1. 上線的電腦；
2. 一個已在本機核准的工作區資料夾；
3. Hub 上的 Codex、Claude Code 或 Pi；以及
4. 存取模式。

**Read only** 是預設值，只允許列出目錄與讀取檔案。只有 Executor 通過指令 sandbox 探測時，寫入選項才會顯示為 **Edit files and run commands**；否則顯示為 **Edit files only**。儀表板會分別顯示兩個位置，明確區分模型及登入保留在 Hub，而工作區操作在選定的電腦上執行。

你可以從電腦 1、電腦 3 或手機的 Hub 儀表板送出提示。工作階段不會悄悄切換至另一台電腦或資料夾。如果 Executor 中斷連線，工作階段會進入 **Executor offline**，絕不會回退到 Hub 的檔案系統。

提交提示時，系統會立即確認已接受；儀表板會輪詢工作階段的進度與完成狀態。若確認回應遺失，草稿會保留並顯示提交狀態不明的通知。重新送出前請先檢查工作階段進度；儀表板絕不會自動重試提示。

提示執行期間仍可使用 **Stop**。它會中斷 Hub 上程式碼代理的回合、取消進行中的 Executor 指令，並防止較晚到達的回應重新開啟已停止的工作階段。

## 重新啟動與重新連接行為

Hub 會保留有界的工作階段中繼資料及少量近期事件快照。Hub 重新啟動後，未完成的工作階段會等待原 Executor。裝置重新連接後，下一個提示會恢復原 Codex thread、Claude Code session 或 Pi session ID。

Claude Code 在第一個提示完成時才會建立持久歷史記錄。如果 Hub 在新的 Claude 工作階段完成任何提示前停止，就沒有可恢復的對話；請改為啟動新工作階段。

能力清單變更不會悄悄削弱現有工作階段。若 Executor 失去指令隔離能力，或可用工具變更，請啟動新工作階段。撤銷電腦會關閉其 socket，並停止綁定的工作階段。

## 安全邊界

- 供應商憑證與程式碼代理歷史記錄保留在 Hub。
- Executor 私鑰、裝置 bearer 與真實根路徑保留在僅擁有者可存取的 OCX 狀態中。
- 每個監聽器都會依核心觀測到的對等端限制配對代碼失敗次數。十分鐘內十次失敗會回傳一般的 `429` 與 `Retry-After`；Hub 只保留這些來源身分有界且會過期的雜湊值。Tailscale Serve 使用者共用管理監聽器的 loopback 額度，因為直接從本機連線的呼叫端可偽造其身分標頭。
- 每個工作階段使用經 Ed25519 簽章的暫時 P-256 ECDH 握手，以及有序的 AES-256-GCM 訊息。
- 雙方未就目前能力清單達成一致前，socket 不會顯示為上線。
- 當本機 sandbox 不可用時，重新連接可以移除能力，但絕不會新增配對時授權範圍外的能力。
- 每個請求都綁定一個模型 thread、裝置、根目錄、存取模式與能力集合。
- 路徑必須是相對路徑、經過正規化、有界，並拒絕透過符號連結、junction 或父目錄逸出。Windows 裝置名稱、替代資料串流，以及尾端含句點或空白的別名都會被拒絕。
- Executor 操作依序執行，開啟檔案的身分會重新檢查，且在原子替換前會再次驗證寫入雜湊值。替換已核准的根目錄時必須重新配對；每次執行指令前也會重新驗證工具鏈根目錄。
- 檔案讀寫會拒絕硬連結檔案。執行指令前，OCX 最多掃描 250,000 個工作區項目；若任何非目錄項目具有多個連結，就會停用指令路徑，因為路徑 sandbox 無法證明同一 inode 的其他名稱是否位於核准根目錄之外。
- Linux 指令透過 bubblewrap 執行，使用一個可寫入的工作區、清空的環境、私有程序命名空間、單一唯讀檔案形式的目前 OCX Bun 可執行檔、有界輸出與逾時，且預設停用網路。專用隔離測試需要明確設定的託管環境；一般測試套件呈綠色不能證明這些測試已執行。
- macOS 只宣告檔案工具。子程序呼叫 `setsid()` 後，程序群組便無法容納它；只為啟動指令而匯入寬泛的 Apple Seatbelt 系統設定檔，則會暴露無關的主機服務權限。因此，原生 helper 會拒絕探測與直接指令請求，直到 OCX 有狹窄且可撤銷的子程序隔離擁有者。
- Windows 與 macOS 原生指令請求採取失敗關閉。其直接 helper 拒絕測試不能當成指令隔離有效的證據；Windows 指令接受能力仍未完成。
- 固定版本的原生 helper 必須位於所有核准的可寫入工作區之外。OCX 會在宣告指令支援前及每次執行指令前檢查，防止工作區程式碼替換下一次執行 sandbox 的二進位檔。
- 停止工作階段會取消進行中的 Executor 指令，並清理 Hub 模型程序與 loopback 工具橋接器。Windows 會停止受管理的 npm 包裝器程序樹，不留下 Node 子程序；Linux 與 macOS 只有在 CLI 忽略正常停止等待時間時才會強制停止。

Hub 會刻意看到提示與模型輸出，因為程式碼代理就在 Hub 上執行。端對端加密保護 Executor RPC 內容。已配對的 Hub 受信任，會透過經驗證的 WSS 選擇核准的根目錄；它對自己的模型對話並非盲目。

## 目前範圍

Remote Workspace 不會將憑證複製或同步至其他電腦。它與 Remote Hub 供應商路由，以及未來可能推出的託管運算或 Super Sync 產品分開。正式發布仍需要已簽章的 Windows helper 套件、針對精確二進位檔的原生 CI 證據、獨立維護者審查，以及真實的三台電腦驗收測試。

## 提示接受 API

`POST /api/remote-workspace/sessions/:id/prompt` 會回傳 HTTP 202 與已接受的工作階段快照。其 session ID 與單調遞增的事件序號可識別接受快照；202 不表示模型回合已完成。請輪詢 `GET /api/remote-workspace/sessions` 以取得後續事件與終止狀態。該回合執行期間，重新連接與執行環境恢復仍處於忙碌狀態。若確認回應遺失，是否已接受就不確定，因此用戶端必須先輪詢，再決定是否重新提交。
