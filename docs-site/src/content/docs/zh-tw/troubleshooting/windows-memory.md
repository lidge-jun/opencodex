---
title: Windows 記憶體成長
description: 為何 Windows 上的 bun 程序可能成長到數 GB 的 RAM、opencodex 目前如何處理，以及上游 Bun 修復釋出前你有哪些選項。
---

部分 Windows 使用者會看到 opencodex 背後的 `bun` 程序，在長時間串流工作階段中成長到數 GB 的 RSS（回報為 issue [#314](https://github.com/lidge-jun/opencodex/issues/314)）。本頁誠實說明實際發生的狀況，以及你可以怎麼做。

## 根本原因：上游 Bun runtime 問題

opencodex 內嵌 Bun runtime（目前為 **1.3.14**）。記憶體成長由已知的上游 Bun 問題驅動，而非代理程式中 JavaScript 層級的洩漏：

| Bun issue | 狀態（於 2026-07-23 查核） |
|---|---|
| [#28035](https://github.com/oven-sh/bun/issues/28035) — `fetch()` 接收 backpressure 未與 JS 消費耦合 | 已由 [PR #29831](https://github.com/oven-sh/bun/pull/29831) 修復；**承載該修復的版本尚未驗證**——我們假設內嵌的 1.3.14 尚未包含 |
| [#32111](https://github.com/oven-sh/bun/issues/32111) — 用戶端中止 async-pull 串流時當機 | 修復 [PR #32120](https://github.com/oven-sh/bun/pull/32120) 於 2026-06-21 合併；不假設已存在於 1.3.14。注意：此當機**並非 Windows 特有**（在 macOS/Linux 亦可重現） |
| [PR #31654](https://github.com/oven-sh/bun/pull/31654) — `node:net` socket handle 洩漏 | 上游仍**開放中** |

在 Windows 上，opencodex 必須讓串流回應維持在保守的程式路徑，以避免 #32111 當機，而該路徑最容易暴露於 backpressure 問題：緩慢或停滯的用戶端可能讓 runtime 在原生記憶體中緩衝上游資料，而 JavaScript 無法加以限制。

## opencodex 目前的作法

有界的緩解與可見性——**並非修復**。在內嵌的 1.3.14 runtime 上，洩漏本身仍是上游問題：

- **Memory watchdog** — 代理程式每分鐘取樣自身記憶體，並在觀察到的記憶體超過 4 GiB 時以速率限制記錄警告。觀察到的記憶體是 RSS、`external` 與 `arrayBuffers` 的最大值（非總和），因為 Windows working-set/RSS 計數器可能低估已提交的外部保留。
- **`ocx doctor`** — 「Memory / runtime」區段會顯示*服務*程序的 Bun 版本、RSS、JS-heap 占比與 stream-mode 決策，並告訴你成長看起來是原生端（上游問題）還是 JS 端（你應回報的 opencodex 錯誤）。
- **`GET /api/system/memory`** — 透過已驗證的管理 API 提供相同資料，供儀表板或腳本使用。除了 RSS/heap 數字外，它也會回報純量 `responseState` 區塊（項目數、總計/最大序列化位元組、最舊項目年齡），對應代理程式記憶體內的 `previous_response_id` 延續存放區。這可進一步歸因 *JS-heap* 成長：在 heap 上升時 `responseState.totalBytes` 也上升，指向對話保留（長 `store:false` 鏈在每回合重新展開）；而 `responseState` 持平但 RSS 上升，則指回原生 runtime。這些值僅為純量——沒有請求本體、token、路徑或帳號識別碼——且讀取無副作用（永不修剪或淘汰）。儀表板唯讀的 **Memory observability** 卡片會渲染相同欄位。
- **受閘控的替代串流路徑** — 有界的 single-reader relay，徹底移除無界緩衝形態。一旦內嵌的 Bun 發行版可驗證承載 #32111 修復，它會自動成為預設；目前僅可選擇加入（見下方）。

這些變更在真實環境的 RSS 改善**仍待 Windows 使用者驗證**——我們不聲稱洩漏已修復。

基於閾值的自動重啟刻意**未**出貨。若程序當機，服務管理員（Task Scheduler/WinSW、launchd、systemd）本就會重啟它。

## 你的選項

1. **等待內嵌 runtime 更新。** 一旦某個 Bun 發行版可驗證承載這些修復，opencodex 會升級內嵌 runtime，並自動啟用較安全的串流路徑。

2. **以 `OPENCODEX_BUN_PATH` 執行你信任的 Bun runtime。** 這是未驗證領域——你是在我們尚未測試的 runtime 上執行 opencodex；風險自負。對服務安裝很重要：覆寫是在**服務產物產生時**讀取，而非服務啟動時。請設定環境變數，然後從同一個 shell 重新執行 `ocx service repair`，讓路徑寫入持久的服務定義。僅設定環境變數對已安裝的服務無效。

3. **以 `streamMode: "eager-relay"` 選擇加入有界 relay。** 兩種方式：編輯 `config.json`（加入 `"streamMode": "eager-relay"`），或呼叫管理 API——`PUT /api/settings` 搭配 `{"streamMode":"eager-relay"}` 會套用到新回合且無需重啟。**當機風險警告：** 在 Bun 1.3.14 上，這會使用受 #32111 影響的串流形態，可能在串流中途讓程序當機（任何 OS，不限 Windows）。服務管理員會重啟它，但進行中的請求會失敗。`"legacy-tee"` 會釘住目前預設；`"auto"`（預設）讓 runtime 閘門決定。

若你在真實 Windows 工作負載上嘗試上述任一作法，請在 [#314](https://github.com/lidge-jun/opencodex/issues/314) 回報前後的 `ocx doctor` 記憶體區段——這正是此緩解等待的驗證。
