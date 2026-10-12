---
title: Codex Log Guard 空間回收
description: 透過有界的增量 vacuum，手動回收 Codex 診斷日誌 SQLite 儲存空間中的閒置頁面。
---

空間回收是 Codex Log Guard 的手動空間復原階段。只有資料庫及執行環境通過與 Log Guard 防護相同的安全檢查，才會壓縮正式的 Codex `logs_2.sqlite` 資料庫。

空間回收**絕不自動排程**，也不會只因開啟 Storage 頁面而執行。儀表板須先收到明確的 Compact 操作，再經第二次確認，才會送出變更請求。

## 空間回收的工作內容

OpenCodex 會執行有界的離線維護程序：

1. 透過 Codex 實際使用的 `sqlite_home` 找到正式的 `logs_2.sqlite`；
2. 驗證檔案身分及已知的 Codex 日誌結構；
3. 確認程序列舉成功，且沒有受支援的 Codex 寫入程序正在執行；
4. 取得專用的跨程序 Log Guard 鎖；
5. 持鎖期間再次檢查 Codex 程序；
6. 以讀寫模式開啟既有資料庫，但不允許建立檔案，並確認能立即取得 SQLite 寫入權；
7. 要求 `PRAGMA auto_vacuum` 原本就設定為 `INCREMENTAL`；
8. 維護前執行 `PRAGMA quick_check`；
9. 完整執行 WAL checkpoint，遇到忙碌或未完成的 checkpoint 則拒絕繼續；
10. 分批執行有界的 `PRAGMA incremental_vacuum(N)`，每批後都執行 checkpoint；
11. 維護後再次執行 `PRAGMA quick_check`；
12. 回報維護前後的資料庫、WAL、頁面數、freelist 與可回收位元組指標。

預設每批目標約為 **8 MiB 的 SQLite 頁面**。單次執行最多回收約 **256 MiB 的頁面**，另有有限的迭代次數上限。如果仍有閒置頁面，結果會標示為部分完成；你可以稍後再次執行 Compact。

位元組上限會依資料庫實際的 SQLite 頁面大小換算成頁面數。它們限制的是處理的邏輯 SQLite 頁面，並非 SSD/NAND 寫入量的估計。

## 安全保證

空間回收刻意**不會**：

- 執行完整的 `VACUUM`；
- 變更既有 Codex 資料庫的 `auto_vacuum` 模式；
- 直接刪除、截斷、重新命名或操作 Codex 的 `-wal` / `-shm` 檔案；
- 刪除診斷資料列；
- 修改 Log Guard 防護觸發器或其他使用者觸發器；
- 在偵測到 Codex 執行時操作；
- 在程序列舉結果不確定時繼續；
- 對未知的未來日誌結構繼續操作；或
- 在 SQLite 完整性檢查失敗後繼續。

若 Log Guard 鎖、SQLite 寫入權或初始 checkpoint 忙碌，系統會明確拒絕，不會在背景重試。若只在某批增量 vacuum 已提交後才發生 checkpoint 爭用，OpenCodex 會把已完成的工作回報為成功的部分結果，並標示 `stopReason: "busy"`，不會宣稱資料毫無變動。

## CLI

先檢查可回收空間：

```bash
ocx storage codex-logs status
```

執行一次有界的維護：

```bash
ocx storage codex-logs compact
```

取得機器可讀的前後指標：

```bash
ocx storage codex-logs compact --json
```

若結果顯示仍有可回收空間，除非你明確希望再執行一次有界處理，否則到此為止。OpenCodex 不會無限循環，也不會替你排程下一次處理。

## 管理 API

壓縮僅透過變更端點提供：

```text
POST /api/storage/codex-logs/compact
```

壓縮沒有 GET 別名。成功回應包含 `report` 物件，列出前後測量值、回收的頁面數、主資料庫實體大小變化、迭代次數、完成狀態、停止原因與完整性狀態。

常見的拒絕狀態包括：

- `codex_running`：Codex 仍在執行
- `process_enumeration_failed`：無法可靠地列舉程序
- `busy`：資源忙碌
- `unsupported_schema`：資料庫結構不受支援
- `auto_vacuum_not_incremental`：未啟用增量 vacuum
- `unsafe_path`：路徑不安全
- `integrity_check_failed`：完整性檢查失敗
- `database_error`：資料庫錯誤

完整性失敗會指出發生於維護前或維護後。`busy` 拒絕表示任何 vacuum 批次提交前就偵測到爭用；成功報告中的 `stopReason: "busy"` 則表示至少一批已提交，之後才因 checkpoint 爭用而停止。

## 解讀結果

`pagesReclaimed` 與 `logicalBytesReclaimed` 表示本次移除的 SQLite freelist 頁面。`physicalDatabaseBytesReclaimed` 表示維護 checkpoint 後觀察到的主資料庫檔案縮減量。

這些數字可能不同。SQLite、WAL 與檔案系統的行為意味著回收邏輯頁面不保證實體檔案立即等量縮小；任何指標都不應解讀為 NAND 寫入量、SSD 磨損或已消耗／節省的 TBW。

`complete: true` 表示觀察到的 freelist 已歸零。部分完成時，若單次頁面預算或有限迭代次數用盡，`stopReason: "page_budget"`；若 SQLite 不再縮減 freelist，則為 `stopReason: "no_progress"`；若已提交回收後發生 checkpoint 爭用，則為 `"busy"`。三者都是有界結果，均不會觸發自動重試。
