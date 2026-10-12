---
title: Codex Log Guard
description: 在不暴露日誌內容的前提下，檢查並明確減少 Codex 診斷日誌的持久化資料。
---

OpenCodex 可以檢查 Codex 的持久化診斷日誌資料庫；在你選擇啟用時，也能減少 Codex 寫入的診斷資料列。檢查一律唯讀；防護需要明確變更，且只有辨識出已知的 Codex 日誌結構並確認 Codex 已停止後才能執行。

## Inspect 回報的資訊

OpenCodex 遵循 Codex 原有的優先順序解析實際使用的 `sqlite_home`，並檢查其中正式的 `logs_2.sqlite` 資料庫。不會把編號較高或舊版的 `logs_N.sqlite` 檔案替代為可變更的目標。

Storage 檢視會顯示：

- 主資料庫、WAL 與 SHM 檔案的大小；
- 日誌資料列總數及其中 `TRACE` 等級所占比例；
- 依資料列數量排列的最大日誌目標類別，以排名標籤代替目標名稱；
- SQLite freelist 中日後可能回收的空間；以及
- 觀察到的結構是否與目前已知的 Codex 日誌結構相容。

如果 `sqlite_home` 位於 `CODEX_HOME` 之外，診斷資料庫會另外顯示，其位元組數不會悄悄併入現有的 `CODEX_HOME` 儲存總量。

產生這些診斷資訊時，OpenCodex 不會選取或公開 `feedback_log_body`。日誌等級只歸入固定的已知等級集合及 `OTHER`，目標名稱也不會序列化。

## Protect 模式

防護**預設關閉**。啟用後，會在 Codex 正式的 `logs_2.sqlite` 資料庫安裝一個 OpenCodex 擁有的 `BEFORE INSERT` 觸發器。OpenCodex 絕不覆寫占用保留名稱的未知觸發器，也只移除 SQL 與 OpenCodex 所擁有版本相符的觸發器。

可選兩種模式：

- **Compatibility** (`compat`) 是建議模式。它將目前 Log Guard v1 規則集固定於現行 Codex 已在持久化 SQLite 日誌接收端過濾或降低等級的高流量目標。其他 `TRACE` 資料列會保留。
- **Quiet** (`quiet`) 會抑制所有新產生的 `TRACE` 資料列，但保留 `DEBUG`、`INFO`、`WARN` 與 `ERROR` 資料列。

防護減少進入持久化 SQLite 儲存空間的資料列，但**不會**消除 Codex 先前的追蹤作業：觸發器忽略資料列之前，事件仍可能被格式化、排入佇列、分組成交易，並經過 Codex 自身的清理邏輯。請把 Protect 視為降低持久化寫入負擔的防護，而非停用 Codex 內部診斷產生的開關。

Log Guard 只過濾持久化的本機 SQLite 日誌資料列，不會改變 Codex 診斷處理、[adapter 傳輸](/zh-tw/reference/adapters/)、provider payload、串流語意、驗證、路由、配額或帳號狀態。

### 安全檢查

在 Protect、Disable 或 Repair 變更外部資料庫之前，OpenCodex 會：

1. 精確解析正式的 `logs_2.sqlite` 路徑；
2. 驗證路徑是一般檔案而非符號連結，且已知結構完全相符；
3. 確認程序列舉成功，且沒有受支援的 Codex 寫入程序正在執行；
4. 取得專用的跨程序 Log Guard 鎖；
5. 取得鎖後再次檢查 Codex 程序；
6. 以讀寫模式開啟資料庫，**不允許**建立檔案，且不等待忙碌狀態便取得 SQLite `BEGIN IMMEDIATE`；
7. 只變更 OpenCodex 擁有的 Log Guard 觸發器，提交前重新讀取結果；以及
8. 在仍持有 Log Guard 鎖時，將要求的模式儲存於 OpenCodex 設定。

如果程序列舉結果不確定、資料庫忙碌、結構未知，或保留的觸發器名稱對應到不同 SQL，變更會安全拒絕。OpenCodex 不會自動終止 Codex。

## 偏移與修復

要求的防護模式與 Codex 日誌資料庫分開儲存在 OpenCodex 設定中。這很重要，因為 Codex 遷移可能重建 `logs` 表，而 SQLite 會移除附著於被取代表格上的觸發器。

當儲存的模式是 `compat` 或 `quiet`，卻觀察不到對應的自有觸發器時，Log Guard 會回報**偏移**。`ocx doctor` 會報告偏移，但絕不自動修復。

修復必須明確執行：

```bash
ocx storage codex-logs repair
```

OpenCodex 刻意不在每次啟動時重新建立防護。只有累積足夠的實際證據，確認跨 Codex 遷移自動修復是安全的，未來版本才可能重新考慮。

## CLI

讀取狀態：

```bash
ocx storage codex-logs status
ocx storage codex-logs status --json
ocx doctor
```

啟用建議的相容性策略：

```bash
ocx storage codex-logs protect
```

明確選擇 quiet 模式：

```bash
ocx storage codex-logs protect --mode quiet
```

停用 OpenCodex 防護或修復偏移：

```bash
ocx storage codex-logs unprotect
ocx storage codex-logs repair
```

在 Log Guard 命令加上 `--json` 可取得機器可讀的輸出。標準命令語法與 JSON 行為請參閱 [CLI 參考文件](/zh-tw/reference/cli/)。

現有命令維持不變：

```bash
ocx storage --json
```

它的回應包含 Storage 頁面使用的相同 Codex 日誌狀態。

## 管理 API

狀態可透過以下端點取得：

```text
GET /api/storage/codex-logs
```

明確變更使用：

```text
POST /api/storage/codex-logs/protect
POST /api/storage/codex-logs/unprotect
POST /api/storage/codex-logs/repair
```

Protect 請求主體為 `{"mode":"compat"}` 或 `{"mode":"quiet"}`。`GET /api/storage` 也會將報告放在 `codexLogs`，讓儀表板透過一次快照請求更新一般儲存細項與 Codex 日誌診斷資訊。

## 唯讀快照語意

狀態檢查以 SQLite `immutable=1` 唯讀開啟資料庫，避免診斷讀取建立或更新 `-wal` 或 `-shm` 附屬檔案。

這項取捨很重要：SQL 彙總及觀察到的觸發器 metadata 描述的是最近一次 checkpoint 後的資料庫快照。如果 Codex 正在寫入，即時 WAL 可能包含比該不可變快照更新的資料列或結構頁面。成功變更的回應使用 OpenCodex 在寫入交易內驗證的觸發器狀態；隨後的唯讀狀態請求可能暫時落後，直到 SQLite 對那些結構頁面執行 checkpoint。

OpenCodex 會分別回報 WAL 檔案大小，**不會**把結果標示為 SSD 寫入速率、NAND 寫入量或磁碟磨損／TBW 消耗。

## 相容性狀態

已知結構會回報支援檢查與防護。若結構缺失、無法讀取或屬於未知的未來版本，仍可檢查 metadata，但會回報不支援可變更操作。

未知結構不會被臆測為相容。如此一來，即使新版 Codex 的資料庫仍可觀察，Log Guard 也不會把未經檢查的結構當作安全的變更目標。

## 空間回收仍是獨立階段

Protect 不會對 SQLite 執行 vacuum 或壓縮。[**Reclaim**](/zh-tw/guides/codex-log-guard-reclaim/) 已提供明確、離線、有界且包含 checkpoint 與完整性檢查的增量 vacuum 流程。

Protect 絕不執行 `VACUUM`、直接截斷或刪除 Codex 的 WAL，也絕不排程空間回收。
