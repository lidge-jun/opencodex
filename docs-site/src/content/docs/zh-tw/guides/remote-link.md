---
title: 遠端連結
description: 透過 SSH 連接 OpenCodex Home 電腦與 Child 電腦。
---

機器連結透過 SSH 連接 OpenCodex **Home** 電腦與 **Child** 電腦。Home 透過 SSH 通道為 Child 提供服務，兩台電腦各自繼續在 `10100` 連接埠執行本機 OpenCodex 服務。儀表板會透過 SSH 傳送 Child 專用的連結金鑰，因此不需要手動輸入權杖。

## 需求

- Home 可以使用 OpenSSH 金鑰登入 Child。
- 對於由 Child 發起的連結，Child 必須能使用 OpenSSH 金鑰登入 Home（不支援密碼登入）。
- Child 已安裝 OpenCodex 2.66.0 或更新版本（由 Child 發起的連結也要求 Home 符合）。
- 兩台電腦執行 macOS 或 Linux。
- 發起連結的儀表板需在那台電腦本機開啟（獨立安裝的瀏覽器或桌面應用程式），或透過已配對的 Hub 工作階段開啟。

密碼 SSH 和 Windows 不在目前流程中。連結可以從任一端發起：依下文從 Home 發起，或依「將這台電腦連線為 Child」一節從 Child 發起。

## 從 `#remote` 新增 Child

1. 開啟儀表板的 `#remote`，開啟 Remote Link。
2. 選擇 **Home**，然後按 **Continue**。SSH 主機列表會開啟。
3. 從 SSH 候選主機選擇主機，或輸入 SSH 設定別名。
4. 執行連線測試，並將顯示的主機指紋與目標電腦的指紋比較。比較指紋可在 SSH 信任主機前發現錯誤的電腦或已變更的主機金鑰。
5. 確認指紋，然後連接 Child。

儀表板不會要求輸入權杖。它會先探測主機，只有明確確認指紋後才能套用連結。

## 將這台電腦連線為 Child

在要使用 Home 供應商的電腦上：

1. 在儀表板中開啟 `#remote` 並開啟 Remote Link。
2. 選擇 **Child**。SSH 主機清單會開啟。
3. 選擇 Home 的 SSH 主機，執行連線測試，然後比較並確認其主機指紋。
4. 閱讀提示後選擇 **Connect as Child**。

連線會重新啟動這台電腦上的 OpenCodex。已在執行的 Codex 請求會先完成，重新啟動期間新的請求可能在最多一分鐘內失敗。之後儀表板會自動重新載入並顯示 Child 連結。Codex 會繼續使用這台電腦上的 `http://127.0.0.1:<port>/v1`，不需要設定權杖或環境變數：本機 OpenCodex 會把每個請求轉送給 Home，由 Home 以它自己的供應商與帳戶提供服務。

只有當 OpenCodex 在其設定的連接埠上執行時，才能選擇 **Child** 角色，因為 Child 會在正好這個連接埠上重新啟動。如果儀表板提示 OpenCodex 未在其設定的連接埠上執行，請先在該連接埠上重新啟動它。

## 連結狀態

- **Connected** 表示 SSH 通道已準備好，Child 可以使用 Home 連結。
- **Reconnecting** 表示正在重試通道。重試期間請求可能暫時回傳帶有 `Retry-After` 的 `503`。在從自己的儀表板連線的 Child 上，請求會先最多等待 15 秒讓通道恢復。
- **Failed** 表示連結需要處理。請檢查 SSH 驗證、已確認的主機金鑰、轉送或逾時原因。從自己的儀表板連線的 Child 會在睡眠、故障或重新啟動後自動重試：逾時或轉送錯誤後大約每分鐘一次，驗證錯誤後每五分鐘一次。主機金鑰變更時不會重試。

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
ocx link port [--json]
ocx link issue --alias <alias> --tunnel-port <port> [--json]
ocx link status [--json]
ocx link revoke --link-id <id> [--json]
```

## 相關指南

- [Remote Hub 部署](/zh-tw/guides/remote-hub/)
- [遠端工作區](/zh-tw/guides/remote-workspace/)
