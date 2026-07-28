---
title: 快速入門
description: 設定你的第一個 provider,用三條命令讓 OpenAI Codex 透過 opencodex 進行路由。
---

本指南將帶你從全新安裝,一路走到用一個非 OpenAI 模型執行 Codex。

## 1. 執行設定嚮導

```bash
ocx init
```

`ocx init` 會引導你完成:

1. **選擇 provider** —— 從內建 registry 的 50 個預設中選擇一個，或選擇 `custom` 手動輸入
   base URL 和 adapter。
2. **API key** —— 貼上一個 key,或引用一個環境變數,例如 `${ANTHROPIC_API_KEY}`。
3. **預設模型** —— 對於 API key、本機和 custom provider，可接受預設值或輸入模型 id。
4. **代理埠** —— 預設為 `10100`。
5. **注入到 Codex？** —— 在通常的迴環地址設定中，opencodex 會在
   `$CODEX_HOME/config.toml`（預設 `~/.codex/config.toml`）根級新增 `openai_base_url`，讓 Codex
   內建的 `openai` provider 指向代理。監聽遠端或 LAN 地址時，則改用帶 API 認證 header 的專用 provider 條目。
6. **安裝自動啟動 shim？** —— 啟用後，每次啟動 `codex` 都會先執行 `ocx ensure`。

結果會儲存到 `$OPENCODEX_HOME/config.json`（預設 `~/.opencodex/config.json`）。

:::note[GPT-5.6 灰度釋出條目]
穩定版 v2.7.1 會為 ChatGPT 直通、OpenAI API key、OpenRouter 和實驗性 Cursor adapter 預置
GPT-5.6 Sol/Terra/Luna。只有上游帳號具備許可權時才能實際呼叫。OpenAI API key 與 OpenRouter
預設會宣告 372,000 token 的可用 context window；Cursor 則使用自身 adapter 提供的後設資料。
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

如果請求的埠已被佔用，`ocx start` 會選擇一個空閒埠，將其寫入 `runtime-port.json`，並更新
Codex 設定以使用實際監聽埠。

檢查它:

```bash
ocx status
ocx gui       # 在實際監聽埠開啟儀表板
```

## 3. 使用 Codex

Codex 現在會透明地與 opencodex 通訊:

```bash
codex "Refactor this function for readability"
```

若要指定某個已路由的模型,請使用 Codex 模型選擇器所顯示的 `provider/model` 形式:

```bash
codex -m "anthropic/claude-opus-5" "Explain this stack trace"
codex -m "ollama-cloud/glm-5.2"      "Write a SQL migration"
```

如果你擁有 GPT-5.6 許可權，原生 ChatGPT 路徑使用裸模型名，API key 和 OpenRouter 路徑使用顯式
`provider/model` 形式：

```bash
codex -m "gpt-5.6-sol"                    "Plan a risky refactor"
codex -m "openai-apikey/gpt-5.6-terra"    "Review this architecture"
codex -m "openrouter/openai/gpt-5.6-luna" "Summarize this trace"
```

## 選擇 sub-agent 模型（可選）

新設定會在 Codex 的 sub-agent 選擇器中優先顯示 `gpt-5.5`、`gpt-5.6-sol`、
`gpt-5.6-terra`、`gpt-5.6-luna` 和 `gpt-5.4-mini`。透過 `ocx gui`，你可以從原生或已路由模型中
選擇並調整最多五個條目的順序。儀表板還可以設定一個首選 sub-agent 模型及 reasoning effort；
opencodex 會把這項指引加入 v1 協作請求。

## 登入而非貼上 key

部分 provider 支援真正的帳號登入(OAuth,自動重新整理):

```bash
ocx login xai          # 也可使用 anthropic、kimi、kiro、google-antigravity、cursor
ocx logout xai
```

預設 OpenAI 路徑**無需 key** —— 它會直接轉發你現有的 `codex login` 憑證。若要使用 OpenAI
API key，請新增 `openai-apikey` provider。該預設包含 `gpt-5.6-sol`、`gpt-5.6-terra`、
`gpt-5.6-luna`，但你的 API key 必須擁有實際使用許可權
(參見 [Provider](/zh-cn/guides/providers/))。

## 停止與恢復

```bash
ocx stop          # 停止代理並恢復原生 Codex
ocx restore       # 不停止代理，僅恢復原生 Codex（別名：ocx eject）
ocx restore back  # 讓 Codex 再次使用仍在執行的代理
```

## 下一步

- [運作原理](/zh-cn/getting-started/how-it-works/) —— 每個請求都發生了什麼。
- [Provider](/zh-cn/guides/providers/) —— 各種認證方式。
- [設定](/zh-cn/reference/configuration/) —— 完整的 `config.json` 參考。
