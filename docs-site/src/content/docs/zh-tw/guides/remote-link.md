---
title: 遠端連結
description: 透過 SSH 連接 OpenCodex Home 電腦與 Child 電腦。
---

機器連結透過 SSH 連接 OpenCodex **Home** 電腦與 **Child** 電腦。Home 透過 SSH 通道為 Child 提供服務，兩台電腦各自繼續在 `10100` 連接埠執行本機 OpenCodex 服務。儀表板會透過 SSH 傳送 Child 專用的連結金鑰，因此不需要手動輸入權杖。

## 需求

- Home 可以使用 OpenSSH 金鑰登入 Child。
- Child 已安裝 OpenCodex。
- 兩台電腦執行 macOS 或 Linux。
- Home 儀表板擁有完整的已配對工作階段。

密碼 SSH、Windows，以及由 Child 發起的連結不在目前流程中。Child 發起的流程**即將推出**。

## 從 `#remote` 新增 Child

1. 開啟儀表板的 `#remote`，開啟 Remote Link。
2. 選擇 **Home**。
3. 選擇 **Add child**。
4. 從 SSH 候選主機選擇主機，或輸入 SSH 設定別名。
5. 執行連線測試，並將顯示的主機指紋與目標電腦的指紋比較。比較指紋可在 SSH 信任主機前發現錯誤的電腦或已變更的主機金鑰。
6. 確認指紋，然後連接 Child。

儀表板不會要求輸入權杖。它會先探測主機，只有明確確認指紋後才能套用連結。

## 連結狀態

- **Connected** 表示 SSH 通道已準備好，Child 可以使用 Home 連結。
- **Reconnecting** 表示正在重試通道。重試期間請求可能暫時回傳帶有 `Retry-After` 的 `503`。
- **Failed** 表示連結需要處理。請檢查 SSH 驗證、已確認的主機金鑰、轉送或逾時原因。

連結失敗時不會靜默切換到本機供應商。

## 移除 Child

選擇 Child 的 **Disconnect** 並確認別名。Home 會停止通道、撤銷該 Child 的連結金鑰，並刪除已儲存的連結記錄。

如果 Home 無法連到 Child 來執行中斷連線命令，請選擇 **Remove here only**。這只會刪除本機的通道、金鑰與記錄。然後登入 Child 並執行：

```bash
ocx disconnect
```

## 安全性

Child 會透過連結使用 Home 電腦上的供應商與供應商憑證。Home 會為每個 Child 建立獨立的連結金鑰；移除連結會撤銷該金鑰。確認前請比較主機指紋，避免誤接受錯誤電腦或已變更的主機金鑰。由 Tailscale 身分簽發的儀表板工作階段無法管理機器連結。

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
