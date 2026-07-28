---
title: Web 儀表板
description: 用於管理代理健康狀態、provider、模型、委派指引、認證池、usage 和日誌的 opencodex GUI。
---

opencodex 內建了一個由代理提供服務的本機 web 儀表板（`gui/` 下的 Vite/React 應用）。你可以在
這裡快速管理 provider、Codex/ChatGPT 帳號、目錄模型、sidecar、子代理設定和請求流量。

## 開啟儀表板

```bash
ocx gui
```

該命令會在瀏覽器中開啟 `http://localhost:<port>`；如果代理尚未執行，會先自動啟動。開發時也可
讓 GUI dev server 單獨連線到正在執行的代理：

```bash
ocx start
bun run dev:gui
```

## 可以完成哪些操作

| 區域 | 作用 |
| --- | --- |
| **Dashboard 摘要** | 顯示 multi-agent 模式、線上狀態、版本、運行時間、provider 數量、30 天 token 總量、活動 provider 和可用的原生/路由模型。 |
| **Sub-agent delegation** | 為 v1 委派 prompt 選擇原生或路由模型，並可指定 reasoning 強度。它不是逐次生成的路由器，詳見下文。 |
| **Sidecar** | 選擇 web-search 模型及強度，以及圖像描述模型；更改從下一次請求開始生效。 |
| **Maintenance** | 重新同步 Codex 模型目錄，檢視專案級設定繞過警告，檢查 latest/preview 版本，並可在更新後重啟代理。 |
| **啟動安全** | 顯示注入的 Codex 路由能否在重啟後繼續工作，並分別顯示服務、launcher shim 狀態和準確的修復命令。 |
| **Windows 托盤** | 安裝使用者登入托盤，一鍵控制代理啟動、停止、重啟、面板和狀態。托盤不是代理重啟服務。 |
| **Codex 自動啟動** | 允許已安裝的 Codex launcher shim 執行 `ocx ensure`。此開關不會安裝 shim 或後臺服務。 |
| **Providers** | 新增、編輯、啟用/停用、刪除 provider，並在支援時管理 OAuth 帳號池和 API key 池。 |
| **Add provider** | 搜尋 registry preset，選擇帳號登入、API key 服務、本機伺服器或自定義 endpoint。 |
| **Codex Auth** | 新增 ChatGPT/Codex 池帳號，選擇下一 session 的帳號，重新整理 5h / 每週 / 30d 配額，啟用或停用配額自動切換，設定其 1–100% 閾值和臨時故障 failover。 |
| **Subagents** | 在 `spawn_agent` override 列表中置頂最多五個原生或路由模型。 |
| **Models** | 開關原生 GPT 與路由模型，設定 provider allowlist、上下文上限、v1/base/v2 以及 v2 thread 數量。 |
| **Logs** | 自動重新整理近期請求，顯示 token、請求強度、實際模型、provider、狀態、request id、耗時和錯誤詳情。 |
| **Usage / Debug** | 檢視 token usage 覆蓋率與趨勢，或啟用可選的 provider transport 和 usage 提取診斷。 |
| **Stop** | 優雅地停止代理和已安裝的後臺服務，恢復原生 Codex 並退出（`POST /api/stop`）。 |

### 連結到某個部分

佈局只有一種，無需切換。Dashboard 的各個部分都有自己的地址：`#dashboard` 開啟 Overview，`#dashboard/providers` 與 `#dashboard/models` 開啟另外兩個。重新整理、收藏和後退都會保留目前所在的部分。**Logs** 同理，使用 `#logs` 與 `#logs/debug`。舊的 `#providers/workspace` 書籤現在會跳轉到 `#providers`。

**Logs** 和 **Usage** 中的費用是根據已報告 token 計算的 API 標價折算值，不是帳單，也不能證明
實際發生了扣費；實際可能計入訂閱用量或消耗服務商額度。

## 模型可見性

**Models** 開關表示 Codex 中的最終可見狀態。路由模型只有在 provider allowlist 中（或未設定 allowlist）且未被停用時才會開啟。開啟模型會原子地協調兩個過濾條件；**全部開啟** 會清除 allowlist，因此以後新發現的模型也會開啟。

## 委派選擇器與生成路由的區別

Dashboard 的 **Sub-agent delegation** 選擇器會儲存 `injectionModel`，以及可選的
`injectionEffort`。在 v1 turn 中，opencodex 會注入一段指引，告訴父代理呼叫 `spawn_agent` 時應
傳入哪個精確模型和 reasoning 強度。只要選定模型，無論父代理目前使用何種 reasoning 強度，都會
啟用這段指引；清除模型時也會清除已儲存的強度。

:::caution
該選擇器是面向 v1 相容介面的委派指引。在 `multi_agent_v2` 中，目前代理不會附加 v1 注入訊息，
而且所有生成的子代理都會繼承父 session 的模型。它不是代理側的跨模型路由器。v1/base/v2 的
權威說明見 [子代理介面](/zh-cn/guides/sub-agent-surface/)。
:::

選擇器會列出已啟用的原生與路由模型，以及全域 Codex reasoning 階梯。API 會先驗證所選強度是否
屬於全域階梯；Codex 仍會根據目標目錄條目再次校驗該 spawn 強度。

## Codex Auth 與帳號池

**Codex Auth** 頁面用於管理原生 ChatGPT/Codex 路由：

- 手動選擇帳號會影響下一次新建的 Codex session；已經繫結帳號的 thread 不會因為這次手動切換而
  在中途轉移。
- Thread affinity 可避免每個請求都來回切換帳號。啟用配額自動切換後，長時間執行的 thread 會被
  定期重新評估；當相關 usage 達到閾值，並且存在使用率確實更低的可用帳號時，該 thread 可能會
  重新繫結。
- 新 session 可以選擇 usage 最低的可用帳號。付費計劃按已知 5h、每週、30d 視窗中的最高使用率
  評分；Go/Free 計劃只使用 30d 視窗。
- **Refresh quotas** 會立即重新讀取帳號 usage，使路由邏輯與頁面上的帳號卡片使用同一份資料。
- 池帳號的請求日誌使用 `p3fa91c` 這類不透明標籤，不會記錄帳號郵箱。

## 儀表板如何與代理通訊

GUI 是代理 JSON 管理 API 之上的輕量用戶端。常用 endpoint 包括：

| Endpoint | 用途 |
| --- | --- |
| `GET` / `PUT /api/settings` | 讀取設定或切換 Codex 自動啟動。 |
| `GET /api/startup-health` | 讀取不含秘密資訊的路由、服務、shim 和重啟安全診斷。 |
| `GET` / `POST /api/windows-tray` | 讀取或更改 Windows 托盤安裝和顯示狀態；POST 支援 `install`、`start`、`stop`、`uninstall`。 |
| `POST /api/sync` | 重建共享模型目錄，並把 Codex 模型快取標記為過期。 |
| `GET /api/update/check` · `POST /api/update/run` · `GET /api/update/status` | 檢查、執行和監控自更新任務。 |
| `GET` / `PUT /api/sidecar-settings` | 讀取或設定 search/vision sidecar 模型。 |
| `GET` / `PUT /api/injection-model` | 讀取或設定 v1 委派指引模型及可選強度。 |
| `GET` / `PUT /api/v2` | 讀取或設定介面模式、Codex feature flag 和 v2 thread 上限。 |
| `GET /api/providers` · `POST /api/providers` · `PATCH /api/providers?name=...` · `DELETE /api/providers?name=...` | 列出、新增/替換、啟用/停用或刪除 provider。 |
| `GET /api/models` · `PUT /api/disabled-models` | 列出原生/路由模型，並更新共享的 disabled-model 集合。 |
| `GET /api/selected-models` · `PUT /api/model-visibility` | 讀取 provider allowlist，並原子地更改單個模型或 provider 分組的最終可見狀態。 |
| `GET /api/key-providers` · `GET /api/oauth/providers` | 讀取 API key 和 OAuth provider 目錄。 |
| `POST /api/oauth/login` · `GET /api/oauth/status` | 啟動 provider OAuth 流程並輪詢完成狀態。 |
| `GET /api/codex-auth/accounts?refresh=1` | 列出主帳號與池帳號、強制重新整理配額，並返回主帳號的 `hasCredential` / terminal `needsReauth` 狀態。 |
| `PUT /api/codex-auth/active` · `PUT /api/codex-auth/auto-switch` · `PUT /api/codex-auth/failover` | 選擇下一次請求使用的帳號並設定帳號池路由。 |
| `POST /api/codex-auth/login` · `GET /api/codex-auth/login-status` | 透過瀏覽器登入新增池帳號。 |
| `GET /api/logs?tail=50&provider=...&status=5xx` | 使用 tail、provider、精確狀態碼或狀態類別篩選近期請求後設資料。 |
| `GET` / `PUT /api/subagent-models` | 讀取或設定五個置頂的 `spawn_agent` override 模型。 |
| `POST /api/stop` | 停止代理/服務，恢復原生 Codex 並退出。 |

:::tip
從儀表板新增 **Ollama Cloud** 或其他目錄型 provider 時，其文字/視覺模型分類會寫入儲存的
provider 設定。因此無需手動分類，[vision sidecar](/zh-cn/guides/sidecars/) 也能在正確
條件下啟用。
:::
