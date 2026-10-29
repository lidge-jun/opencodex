---
title: 快速入門
description: "安裝 opencodex、新增第一個供應商，再連接你使用的程式開發工具：Codex、Claude Code、Claude Desktop、Grok Build 或其他支援的工具。"
---

本指南帶你從全新安裝到在現有程式開發工具中送出第一個請求。步驟 1 和 2 適用所有工具；步驟 3 依工具分成簡短分支。[用戶端支援頁面](/zh-tw/reference/client-support/)列出各工具及連接方式。

## 1. 執行設定嚮導

```bash
ocx init
```

`ocx init` 會引導你完成:

1. **選擇 provider** —— 從內建 registry 的 106 個預設中選擇一個，或選擇 `custom` 手動輸入
   base URL 和 adapter。
2. **API key** —— 貼上一個 key,或引用一個環境變數,例如 `${ANTHROPIC_API_KEY}`。
3. **預設模型** —— 對於 API key、本機和 custom provider，可接受預設值或輸入模型 id。
4. **代理埠** —— 預設為 `10100`。
5. **注入到 Codex？** —— 在通常的迴環地址設定中，opencodex 會在
   `$CODEX_HOME/config.toml`（預設 `~/.codex/config.toml`）根級新增 `openai_base_url`，讓 Codex
   內建的 `openai` provider 指向代理。監聽遠端或 LAN 地址時，則改用帶 API 認證 header 的專用 provider 條目。
6. **安裝自動啟動 shim？** —— 啟用後，每次啟動 `codex` 都會先執行 `ocx ensure`。

結果會儲存到 `$OPENCODEX_HOME/config.json`（預設 `~/.opencodex/config.json`）。

:::note[GPT-5.6 釋出條目]
目前的穩定版本會為 ChatGPT 直通、OpenAI API key、OpenRouter 以及實驗性 Cursor adapter
預置 GPT-5.6 Sol/Terra/Luna。只有該上游帳號具備權限時才能實際呼叫。OpenAI API key 與
OpenRouter 預設會宣告 922,000 token 的可用 context window；Cursor 則保留自身 adapter 的
後設資料。
:::

## 2. 啟動代理

```bash
ocx start            # 預設埠 10100
ocx start --port 8080
```

啟動時,opencodex 會:

- 將其 PID 寫入 `~/.opencodex/ocx.pid`(並拒絕重複啟動),
- 在 provider 支援時發現即時模型，並**把原生與已路由條目同步進 Codex 的模型目錄**，以及
- 在 `http://localhost:<port>/v1` 上監聽。

如果請求的埠已被佔用，`ocx start` 會停止並告訴你是什麼佔用了該埠：如果回應的是
opencodex，請先執行 `ocx stop`；也可以使用 `ocx start --port <port>` 在空閒埠上啟動。
它不會自行切換到其他埠；舊行為會讓兩個代理同時執行，並將 Codex 重新指向後啟動的代理。

檢查它:

```bash
ocx status
ocx gui       # 在實際監聽埠開啟儀表板
```

## 3. 連接你的工具

選擇你使用的工具對應的分支。你可以連接多個工具，它們共用供應商與模型。

### Codex

如果你在步驟 1 接受了 Codex 提示，Codex 現在會透明地透過 opencodex 通訊。如果你拒絕了該提示，或設定因已有設定檔而結束，請在執行 Codex 之前開啟儀表板 **Connect** 頁面的 Codex 開關；[Codex 整合](/zh-tw/guides/codex-integration/)說明修改內容與還原方式。

```bash
codex "Refactor this function for readability"
```

若要指定某個已路由的模型,請使用 Codex 模型選擇器所顯示的 `provider/model` 形式:

```bash
codex -m "anthropic/claude-opus-5" "Explain this stack trace"
codex -m "ollama-cloud/glm-5.2"      "Write a SQL migration"
```

### Claude Code

安裝 `claude` CLI 後：

```bash
ocx claude
```

`ocx claude` 會在代理未執行時啟動它，並以指向 opencodex 的環境啟動 Claude Code。額外參數會原樣傳遞。層級預設值、其他啟動器和停用方式請參閱 [Claude Code](/zh-tw/guides/claude-code/)。

### Claude Desktop

```bash
ocx claude desktop
```

全新安裝時會為整個應用程式設定閘道設定檔；已經使用 first-party 模式的安裝會保持原模式，可執行 `ocx claude desktop apply --gateway` 明確切換。first-party 模式讓 Desktop 繼續使用 claude.ai，只路由其 Code 分頁；詳見 [Claude Code](/zh-tw/guides/claude-code/) 的 Claude Desktop 模式一節。

切換模式後，請完全結束並重新開啟 Claude Desktop。

### Grok Build

在本機監聽時，若 `~/.grok` 存在，`ocx start` 會將可見模型註冊至 `~/.grok/config.toml`。在 Grok Build 選擇 `ocx-*` 模型。遠端設定和受管理區塊請參閱 [Grok Build](/zh-tw/guides/grok-build/)。

新增供應商或模型後，執行 `ocx ensure` 或重新啟動代理，Grok Build 才能看到它們。

### 其他工具

具備受管理整合的工具（OpenCode、Pi、Qoder、WorkBuddy、Kilo、Cline、T3 Code 等）可從儀表板的 **Connect** 頁面連接，或使用：

```bash
ocx integration client enable --client <id>
```

各工具的設定檔及生效時間請參閱[整合](/zh-tw/guides/integrations/)。其他接受自訂端點的工具可使用 OpenAI 相容基本 URL `http://localhost:10100/v1` 或 Anthropic 基本 URL `http://localhost:10100`。

## 選擇 sub-agent 模型（可選）

新設定會讓 Codex 的 sub-agent 選擇器包含五個原生模型：`gpt-5.5`、`gpt-5.6-sol`、
`gpt-5.6-terra`、`gpt-5.6-luna` 和 `gpt-6-astra`。開啟 `ocx gui` 即可替換或重新排序最多五個
原生或已路由模型。儀表板也可以設定一個首選 sub-agent 模型及 reasoning effort。參見
[子代理介面](/zh-tw/guides/sub-agent-surface/) 選擇 v1/base/v2，並了解指引、原生預設與回退
何時生效。

## 登入而非貼上 key

部分 provider 支援真正的帳號登入(OAuth,自動重新整理):

```bash
ocx login xai          # 也可使用 anthropic、kimi、kiro、google-antigravity、cursor
ocx logout xai
```

OpenAI 本身**無需 key** —— 預設 provider 會直接轉發你現有的 `codex login` 憑證
（參見 [Providers](/zh-tw/guides/providers/)）。

## 停止與恢復

```bash
ocx stop          # 停止代理並恢復原生 Codex
ocx restore       # 不停止代理，僅恢復原生 Codex（別名：ocx eject）
ocx restore back  # 讓 Codex 再次使用仍在執行的代理
```

## 下一步

- [運作原理](/zh-tw/getting-started/how-it-works/) —— 每個請求都發生了什麼。
- [Provider](/zh-tw/guides/providers/) —— 各種認證方式。
- [設定](/zh-tw/reference/configuration/) —— 完整的 `config.json` 參考。
