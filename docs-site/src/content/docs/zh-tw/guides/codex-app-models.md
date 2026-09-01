---
title: Codex App 模型選擇器
description: opencodex 模型如何透過共享 Codex 目錄出現在 Codex App、Codex CLI 和 Codex TUI 中。
---

opencodex 不會修改 Codex App。它會寫入 Codex CLI/TUI 所使用的同一套 Codex 設定和模型目錄。
Codex 的 app-server 會讀取這份共享狀態，但部分 Codex Desktop 版本會在 renderer 套用第二層
遠端模型 allowlist，仍可能把已路由的列從選擇器中移除。

OpenAI 條目使用兩條憑證路線：原生 Codex 登入，以及帶名稱空間的 `openai-apikey/<model>`
API key 傳輸。僅在 Pool 與 Direct 之間切換 `codexAccountMode` 本身不會改變選擇器 id。不過，
當 `codexAccountPickerEnabled` 啟用帳號限定選擇器列，且 `codexAccountNamespaces` 中仍有對應
帳號存在的合格選擇器時，opencodex 會為這些對應帳號新增獨立的 `<selector>/<native-openai-model>`
列，並從 Codex 選擇器中隱藏裸的原生列。選擇器標籤是使用者自訂的公開名稱，本身沒有帳號角色
的語意。選擇限定列只會使用其對應的帳號，不會改變目前 Pool 帳號；當目標不可用時會失敗關閉
（fails closed），而不是切換帳號。參見
[精確 Codex 帳號選擇器](/zh-tw/reference/configuration/routing/#精確-codex-帳號選擇器)。

當 `codexAccountNamespaces` 對應表為空時，帳號限定選擇器列是關閉的。若省略
`codexAccountPickerEnabled` 但對應表非空，基於向後相容會被視為啟用。將其設為 `false` 可以
隱藏生成的限定列並恢復選擇器中的裸原生列，同時不必刪除對應或停用精確的
`<selector>/<native-openai-model>` 路由。

API GPT-5.6 條目使用 1,050,000 context / 922,000 max input；`*-pro` 選擇器 id 會解析為帶
`reasoning.mode: "pro"` 的 base wire 模型，而日誌、用量與選擇器狀態仍保留虛擬 id。API 目錄
固定為恰好八個 id：`gpt-5.5`、`gpt-5.6`、Sol/Terra/Luna，以及它們的三個 Pro 虛擬 id；沒有
通用的 `gpt-5.6-pro` 別名。Compact 請求保留所選 tier，但會在不帶 reasoning 物件的情況下傳送
base 模型。

選擇選擇器 id 所代表的憑證路線。在 Providers 頁面切換 Pool/Direct；下面的 `<selector>` 是
使用者自訂的公開標籤，透過 `codexAccountNamespaces` 對應：

```text
gpt-5.6-sol                         # 經由 Pool 或 Direct 的裸 Codex 登入路線
<selector>/gpt-5.6-sol              # 由該選擇器對應的已儲存 Codex 帳號
openai-apikey/gpt-5.6-sol           # API key
```

全新安裝以及未儲存模式的設定檔預設為 Pool。目前設定檔使用 marker 2，並在
`~/.opencodex/config.json.pre-openai-tiers-v2.bak` 保留出廠的 v1 原始檔；用以下指令恢復：

```sh
cp ~/.opencodex/config.json.pre-openai-tiers-v2.bak ~/.opencodex/config.json
```

較早的 v1 三 provider 設定會自動遷移為單一的 option-aware 列。

## Desktop 遠端 allowlist 限制

如果 `codex debug models` 和 app-server 的 `model/list` 都包含某個路由模型，但 Desktop 沒有
顯示它，請查看上游的 [Codex issue #19694](https://github.com/openai/codex/issues/19694)。當
遠端 `use_hidden_models` 政策啟用時，Desktop 只能保留其原生 `available_models` 清單中的 id，
而且也可能顯示目錄可見性為 `hide` 的原生列。單靠重新整理目錄或重啟代理無法改變這個 renderer
政策。

對於等效的路由模型，opencodex 提供一個明確、預設關閉的 native-alias combo 模式。它會發布
一個通過 allowlist 的裸 slug（帶誠實的自訂顯示標籤），並在進行正式 OpenAI 路由之前，先把該
精確 slug 經由已設定的 combo 路由。只要相容別名存在，它也把已停用的裸原生列從有效目錄中
省略，因此 Desktop 無法藉由忽略 `visibility` 讓它們復活。指令、停用 key 語意與安全性限制請見
[Codex Desktop native-allowlist 相容性](/zh-tw/guides/combos/)。

## 整合路徑

`ocx init`、`ocx start` 和 `ocx sync` 會把共享的 Codex 設定與目錄接入代理；設定注入、目錄同步、
shim、WebSocket 回退與恢復機制請見 [Codex 整合](/zh-tw/guides/codex-integration/)。

## 為什麼路由模型會顯示

Codex 模型選擇器要求條目符合 Codex 目錄結構。opencodex 會克隆一個原生 Codex 模型模板，然後
替換路由模型的身份資訊：

```text
slug = "anthropic/claude-sonnet-..."
display_name = "anthropic/claude-sonnet-..."
visibility = "list"
```

克隆後的條目會保留 reasoning 級別、shell 型別、API 支援標誌和 base instructions 等嚴格解析器
所需欄位。隨後，opencodex 會移除該路由無法兌現的原生專屬能力，例如 OpenAI service-tier 後設資料。

## 目前穩定模型涵蓋範圍

原生回退列表包含 `gpt-5.5`、`gpt-5.4`、`gpt-5.4-mini`、
`gpt-5.3-codex-spark` 以及 GPT-5.6 Sol/Terra/Luna。對於 GPT-5.5/5.4 系列，opencodex 會
保留已安裝 Codex 目錄中資訊更完整的即時條目，僅在條目缺失時才合成。內建的上游快照只用於
GPT-5.6，以便提供每個模型真實的身份和後設資料，而不是套用舊模板近似生成。

| 路由 | 選擇器 id 與目錄後設資料 |
| --- | --- |
| Codex 登入（停用帳號限定列） | 裸原生 id，例如 `gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`；透過 `codexAccountMode` 選擇 Pool 或 Direct。GPT-5.6 列使用 922,000 token 的目錄視窗。 |
| Codex 登入（啟用帳號限定列且有合格選擇器） | 每個合格選擇器與受支援的原生模型各有一列 `<selector>/<native-openai-model>`；每列只使用其對應帳號，且裸原生列會從選擇器中隱藏。原生後設資料與 context 視窗保持不變。 |
| OpenAI（API key） | 恰好八個帶名稱空間的列：`gpt-5.5`、`gpt-5.6`、Sol/Terra/Luna 與三個 `*-pro` 虛擬 id（全部八個都是 1,050,000 context；922,000 max input） |
| OpenRouter | `openrouter/openai/gpt-5.6-sol`、`openrouter/openai/gpt-5.6-terra`、`openrouter/openai/gpt-5.6-luna`（922,000） |
| Cursor | 靜態回退目錄包含 `cursor/gpt-5.6-sol`、`cursor/gpt-5.6-terra`、`cursor/gpt-5.6-luna`（1,000,000），以及 Grok 4.5/4.6 的一般與 Fast 項目（500,000）。4.6 還提供 `xhigh`；帳號的即時發現結果決定最終顯示哪些模型。 |
| xAI | 以即時發現結果為準。回退目錄包含 `xai/grok-4.6`，預設模型仍為 `xai/grok-4.5`；兩者的 context window 均為 500,000。Grok 4.6 提供 `low` / `medium` / `high` / `xhigh`（上游預設值為 `high`），Grok 4.5 最高為 `high`。 |

固定的 GPT-5.6 條目會保留精確的上游 reasoning 階梯。Sol 和 Terra 從 `low` 到 `ultra`，Luna
最高到 `max`。Sol 預設使用 `low`，Terra 和 Luna 預設使用 `medium`。`ultra` 是用戶端側的
“最大 reasoning + 主動委派”選項，到達後端時會轉換為 `max`。模型出現在選擇器中只表示目錄已經
準備好；關聯的帳號或 API key 仍需具備該模型的實際權限。

## 原生與路由模型開關

儀表板的 Models 頁面為裸原生 id 與路由的 `provider/model` id 提供 `disabledModels` 開關。
帳號限定的 `<selector>/<native-openai-model>` id 也受 `disabledModels` 支援，但儀表板不會列出
或切換這些精確的選擇器列；請手動加入設定檔：

- 路由 id 使用 `provider/model` 名稱空間。停用後，該模型會從同步目錄和 `/v1/models` 中排除。
- 帳號限定的原生 id 使用 `<selector>/<native-openai-model>`。把它加入 `disabledModels` 只會
  隱藏該選擇器列。
- 原生 GPT id 是裸 slug。停用時不會刪除目錄條目，而是將 `visibility` 改為 `hide`，以便稍後
  重新啟用時能精確恢復原條目；它會從自動探索中隱藏該裸列以及該模型的每個選擇器限定複製條目。
- 只要設定至少一個 native-alias combo，已停用的裸原生列就會被省略而非保留為 hidden，因為
  受影響的 Desktop 版本會忽略 hidden 旗標。被 native alias 遮蔽的裸原生 slug 也會從 Models
  頁面省略，因此它在那裡沒有原生開關；只有未被遮蔽的原生列可供切換。重新同步會在重新啟用
  未遮蔽的停用列時恢復原始的原生後設資料。
- 未遮蔽的原生列來自受支援的靜態集合，因此已停用的未遮蔽模型仍會留在儀表板中，可以重新開啟。

可見性處理位於快照升級之後。每次切換模型後，管理 API 都會重新整理目錄，並強制把 Codex 模型快取
標記為過期。

## Multi-agent surface 模式

Models 頁面的 v1/base/v2 控制會改變每個選擇器條目使用的 Codex 協作介面；模式、委派、繼承、
回退與加密任務行為的權威說明請見 [子代理介面](/zh-tw/guides/sub-agent-surface/)。

## 頂級 reasoning 檔位

目錄中顯示哪些 reasoning 檔位與 v1/base/v2 介面模式無關。生成的、支援 reasoning 的條目會提供
`max`，以便直接指定的子代理強度透過校驗；目前生成的路由條目和舊一代原生 GPT 條目還會提供
`ultra`。精確的上游 GPT-5.6 階梯會原樣保留，因此 Luna 只有 `max`，沒有 `ultra`。

在實際請求中，路由 adapter 會對映或限制不受支援的檔位。對於真實最高檔位為 `xhigh` 的舊原生
模型，`nativeEffortClamp` 會把直接指定的 `max` 或 `ultra` 選擇轉換為 `xhigh`，例如 GPT-5.5。
Sol、Terra 和 Luna 都有真實的 `max` 檔位。

## Fast tier 規則

Codex 在設定檔中這樣儲存 fast 模式：

```toml
service_tier = "fast"

[features]
fast_mode = true
```

模型目錄和執行環境請求使用的 tier id 則是 `priority`。opencodex 會保留這一差異。原生 OpenAI
透傳模型繼續支援 fast；路由 provider 則依能力閘控 —— 只有當 provider 宣告
`supportsServiceTier: false` 時才會移除 `service_tier`（registry 將正規 OpenAI 歸類為 `true`，
DeepSeek 與 Volcengine Ark 歸類為 `false`），而未分類的自訂 gateway 會原封不動保留呼叫端提供
的值，絕不注入。無法兌現的地方絕不會宣傳 fast 選項；自訂 gateway 也可以明確以 `true` 選擇加入。

## 子代理選擇

Codex 會按 `priority` 升序排列選擇器中可見的目錄條目，並將前五個顯示為 `spawn_agent` 模型
override。儀表板的 Subagents 頁面可以選擇並儲存最多五個裸原生 id 或路由的 `provider/model`
id。手動設定的 `subagentModels` 也接受帳號限定的 `<selector>/<native-openai-model>` id，但
儀表板不提供這些精確 id；儲存頁面時會把列表替換為儀表板可見的選擇。opencodex 會按所選順序
賦予較低的目錄 priority；啟用帳號限定選擇器列時，裸原生選擇會展開為選擇器限定群組。其他模型
仍可透過精確 id 直接呼叫。

置頂模型列表與 Dashboard 的 **Sub-agent delegation** 選擇相互獨立。它只控制 Codex 優先提供
哪些 override；本身不會選定模型或觸發委派。

## Desktop remote 伺服器

Codex Desktop 的 remote-server 模式會以用戶端自己的 `available_models` allowlist 過濾選擇器
（當遠端 `use_hidden_models` 設定開啟時生效）。路由目錄條目仍會被載入與提供 —— `model/list`
會回傳它們，內建 CLI 也會讀取 —— 但 Desktop 的 renderer 在渲染前會丟棄任何不在該僅原生
allowlist 上的項目。opencodex 無法介入該清單；上游錯誤追蹤於
[openai/codex#19694](https://github.com/openai/codex/issues/19694)。

在 Desktop 公開 allowlist 控制選項之前：

- 直接在遠端機器的 `~/.codex/config.toml` 設定模型，例如 `model = "input/grok-4.5"`。選擇器
  可能顯示 `Custom`，但請求仍會使用已設定的路由模型。
- 改用 Codex CLI 或 TUI 而不是 Desktop 選擇器；它們不會套用 allowlist，會正常列出路由模型。

## 重新整理模型狀態
## 原生配額回退限制

Codex 應用程式用完原生的五小時配額後，可能切換到預備回退模型，並把選擇器裡其他列變灰。如 [#2813](https://github.com/lidge-jun/opencodex/issues/2813) 所報告，這個限制同樣會隱藏 opencodex 路由的列，而那些列使用的是無關的供應商憑證，不消耗任何 ChatGPT 配額。

這個限制由用戶端在請求抵達代理之前施加，因此 opencodex 無法解除。路由列寫入時帶 `visibility: "list"`，目錄過濾只讀取 `disabledModels` 與各供應商的 `selectedModels`，任何配額值都不參與路由列的可見性。

明確選擇路由模型不會經過選擇器。在 `config.toml` 中設定模型：

```toml
model = "anthropic/claude-sonnet-5"
```

或直接送出：

```bash
ocx access test anthropic/claude-sonnet-5 --protocol responses
```

**請求抵達代理之後**，兩條路徑都能正確路由，這點有測試覆蓋。但預備模式生效時，Codex 桌面應用程式不會送出已設定的模型：它依自己的 `wham/usage` 輪詢（`luna_reserve` 升級提示加上仍被允許的 `gpt-reserve` 附加限額）判定預備狀態，並在請求送出前把模型設定強制改為 `gpt-reserve`，所以 `config.toml` 這條路會在應用程式內被覆寫。在視窗重設之前，請使用 `ocx access test`、經代理的 Claude Code（`ocx claude`）或任何直連 `/v1` 的用戶端。參見[Codex 預備模式下的路由模型](/guides/codex-integration/#routed-models-during-codex-reserve-mode)。


如果選擇器仍顯示舊條目，請重新整理目錄並重新開啟目標 Codex 介面：

```bash
ocx sync
```

當目錄的可見性、priority 或後設資料發生變化時，opencodex 會用一個刻意標記為過期的快取 wrapper
重寫 `models_cache.json`，使 Codex 下次重新整理模型時讀取新目錄。
