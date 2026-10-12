---
title: 平台支援
description: OpenCodex 在 macOS、Windows 與 Linux 上的能力，以及部分功能受限於特定平台的原因。
---

OpenCodex 可在 macOS、Windows 與 Linux 上執行。大部分功能在三個平台上的行為相同；少數能力依賴作業系統提供的機制，本頁說明其適用範圍與原因。

## 所有平台

| 能力 | 說明 |
| --- | --- |
| 代理、路由、供應商 adapter | 核心執行環境不依賴特定平台。 |
| 背景服務 | 三種原生後端：macOS 的 launchd、Windows 的 Task Scheduler **或** WinSW，以及 Linux 的 systemd 使用者 unit。 |
| 瀏覽器登入 | 透過平台自身的處理程式開啟。 |
| 用戶端偵測 | 依平台尋找 Cursor、Claude Desktop、Kiro 與 Codex 安裝項目。 |

### 作業系統憑證儲存區中的供應商金鑰

三個平台都支援，**前提是有已解鎖的作業系統憑證服務**：macOS 的 Keychain、Windows 的 Credential Manager、Linux 的 libsecret。金鑰環遭鎖定或無介面的工作階段沒有已解鎖的服務，因此儲存區不可用；OpenCodex 會明確告知，而非悄悄回退。儲存規則請見[供應商設定](/zh-tw/reference/configuration/providers/)。

## 僅限 macOS

### Claude Code 自動連接

將 `ANTHROPIC_BASE_URL` 與 Claude Code 的控制變數注入工作階段，是透過 launchd 使用者網域完成的；其他平台沒有單一對等機制。

在 Linux 上，三種可能機制各自只涵蓋不同的程序：`systemctl --user set-environment` 僅影響由 systemd 啟動的 unit，`~/.profile` 僅影響登入 shell，而 `~/.bashrc` 僅影響互動式非登入 shell。沒有單一位置能涵蓋使用者的整個工作階段。

Windows 上的對等機制是 `HKCU\Environment`，但它是真正持久化的設定，而非每次開機重設。問題就在這裡：它會把 bearer token 從重新開機後清空的網域，移到不會清空的登錄區，改變憑證留在磁碟上的時間與可讀取者。這項決策需要安全審查，不能只當成移植工作。

Claude Code 所需的其他功能在所有平台上都可用。你可以自行設定相同變數，或執行 `ocx claude`，讓它直接把變數傳給子程序。

## 匯入與貼上

### Meta Muse Code

在 macOS 上，OpenCodex 會匯入 Muse Code CLI 在執行 `muse login` 後已儲存的 API key，因此不需要再提供第二把金鑰。

其他平台則請你貼上金鑰。Meta 未提供原生 Windows CLI；Linux 雖有 CLI，但其憑證儲存位置尚未驗證，所以 OpenCodex 不會猜測儲存區。同一把金鑰可從 [Meta 開發者主控台](https://dev.meta.ai)取得；貼上的金鑰會接受與匯入金鑰相同的格式檢查及 Model API 即時驗證。

## Windows 注意事項

Windows 服務可透過 Task Scheduler 或原生 WinSW 服務執行，兩者互斥。若 `ocx service repair` 發現兩者的狀態，便會拒絕繼續，因為猜錯使用者的選擇可能讓同一台電腦上的兩個代理爭用連接埠。

非英語 Windows 安裝的主控台輸出使用系統字碼頁，而非 UTF-8。OpenCodex 會據此解碼，讓含非 ASCII 字元的帳號名稱正確解析。

## 功能不可用時

OpenCodex 會說明實際原因，不會默默停用控制項。若你的平台不支援某項能力，錯誤訊息或儀表板會指出缺少哪個機制，以及支援的替代方式。若沒有提供這些資訊，就值得回報為錯誤。
