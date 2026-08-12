
---
title: CLI 參考
description: 命令分派、離開碼，以及每個 ocx 命令家族的連結。
---

opencodex 的命令列工具是 `ocx`。它依第一個命令名稱分派，有記載的別名如
`setup`/`init`、`restore`/`eject`、`models`/`model` 都會到達相同操作。
未知命令與無效的命令形狀都是錯誤。

執行 `ocx help`（或 `ocx --help` / `ocx -h`）檢視頂層用法。對幫助表中註冊的命令，
執行 `ocx help <command>`、`ocx <command> --help` 或 `ocx <command> -h`。幫助與版本
命令均為只讀：它們不會啟動、停止、安裝、解除安裝或改寫 Codex／opencodex 狀態。

## 命令家族

- [生命週期](/zh-tw/reference/cli/lifecycle/) — 設定、代理與服務生命週期、健康狀態、
  診斷、目錄同步、儀表板與更新。
- [Providers、帳號與模型](/zh-tw/reference/cli/providers-accounts/) — provider 設定、
  認證、憑證池、配額、自訂模型、可見性、選定模型與 context 上限。
- [Agents、路由與整合](/zh-tw/reference/cli/agents/) — multi-agent 控制、combos、
  可觀測性、admission key、用戶端整合、執行環境設定與已驗證的設定。

## 無頭（headless）行為

管理命令往返於執行中代理的管理 API，使用記錄的執行環境埠與身分檢查，而非維護第二條
設定路徑。停止或無法連線的代理以 HTTP 503 呈現，並產生非零的 CLI 離開碼。明確記載為
離線設定操作的命令，可以在沒有執行中代理的情況下驗證與編輯設定檔。

沒有歧義時，list 或 status 是預設。使用 `--json` 取得結構化快照，並以
`ocx observe logs --follow --jsonl` 取得串流的請求 log feed。佈景主題、語言、導覽與
其他純視覺的瀏覽器狀態沒有 CLI 對應；Cloudflare Tunnel 設定不在此命令集內。

## 離開碼與確認

成功的命令離開 0。無效用法、未知命令或資源、失敗的 API 操作以及無法使用的必要服務
會以非零離開。`ocx health` 特別只在代理健康時離開 0，否則離開 1，因此可作為服務探針。
腳本應測試離開碼，而不是解析人類可讀的輸出。

宣告需要確認的破壞性移除、匯入、信用消耗與更新操作，在非互動使用時需要 `--yes`。
該旗標是明確的 opt-in；省略它不得靜默確認該動作。

## 版本與內部分派目標

`ocx --version`、`ocx -v` 與 `ocx version` 會列印一行適合腳本使用的版本行並結束。

有兩個分派目標刻意不顯示在一般幫助中：`__refresh-version [preview]` 在分離的
程序中重新整理更新通知快取，`__gui-update-worker <job-id> [latest|preview] [restart]`
執行儀表板更新任務。它們是實作細節，不是穩定的使用者面向命令。儀表板會記錄 worker
PID、恢復 worker 已死但仍在進行中的任務、把超過十分鐘且沒有 PID 的舊 active 記錄
視為過期，並保護執行中的 worker 免受並行更新影響。
