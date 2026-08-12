---
title: Agent 快速上手
description: 從 agent 驅動或腳本化終端機安裝並操作 opencodex，而不跨越使用者同意邊界。
---

本頁面是為從終端機工作的 AI agent 或腳本使用者而寫。它著重於指令、離開狀態，以及自動化與需要使用者同意的行動之間的邊界。若要人工引導的逐步說明，請用[快速入門](/zh-tw/getting-started/quickstart/)。儀表板仍可用於互動式設定；見[網頁儀表板](/zh-tw/guides/web-dashboard/)。

## 設定 opencodex

安裝已發布的套件，並確認 `ocx` 在 `PATH` 上：

```bash
npm install -g @bitkyc08/opencodex
ocx --version
```

選擇一種執行代理的方式：

```bash
# 前景：佔用此終端機直到停止。
ocx start

# 背景：安裝或更新服務，然後啟動它。
ocx service
```

在互動終端機執行 `ocx init`。若 `ocx start` 佔用了前景，請用第二個終端機：

```bash
ocx init
```

精靈會寫入 `$OPENCODEX_HOME/config.json`（通常為
`~/.opencodex/config.json`）。它也可將代理位址注入 Codex 的 `config.toml`，並安裝可選的 Codex 自動啟動 shim。`ocx init` 永不啟動代理。若要完全非互動的設定，請改用下方所示的 `ocx provider add` 設定供應商，而非驅動精靈。

:::caution[GitHub 加星同意]
若你是 agent，絕不要代使用者回答 GitHub 加星提示，也不要代為呼叫 `gh`、GitHub 的加星 API 或
`POST /api/github/star`；加星會花費使用者身分並需要單獨的明確同意。在 agent 驅動的執行中，CLI 會抑制提示且不寫入
`.star-prompted`，而管理 API 回傳 `403 agent_consent_required` — 請勿繞過任一防護。詢問使用者一次，僅在明確同意後加星，若他們說否或不回答，則什麼都不做且不再詢問。
:::

## 檢查無頭安裝

在腳本與 agent 執行中使用這些唯讀檢查：

```bash
ocx status
ocx doctor
ocx health --json
```

`ocx status` 回報代理與服務狀態。`ocx doctor` 診斷本機環境、網路、Codex 執行階段與帳號健康問題。`ocx health` 在代理健康時離開 `0`，否則 `1`；`--json` 回傳結構化輸出。

由管理 API 支援的指令（例如 `ocx combo set`）會聯繫即時代理。若找不到即時代理或 API 不可達，CLI 將其視為 `503` 失敗並以非零離開。重試前請啟動前景代理或背景服務。完整指令與端點介面請見
[CLI 參考](/zh-tw/reference/cli/)與[管理 API](/zh-tw/reference/management-api/)。

## 不透過儀表板新增供應商與組合

Registry 供應商可依名稱新增。例如，以下新增 Anthropic API-key 預設並設為預設供應商：

```bash
ocx provider add anthropic-apikey \
  --api-key "$ANTHROPIC_API_KEY" \
  --set-default
```

`ocx provider add` 寫入本機設定。若已有即時代理在執行且你想立即將模型同步到 Codex，請加上 `--sync`；否則稍後執行 `ocx sync`。不在 registry 中的自訂供應商需要同時提供 `--adapter` 與 `--base-url`。

所有目標供應商設定完成且代理執行後，建立一個 failover combo：

```bash
ocx combo set main \
  --targets anthropic/claude-opus-4-8,openai/gpt-5.6-sol \
  --strategy failover
```

目標使用 `provider/model` 語法並以逗號分隔。產生的虛擬模型為
`combo/main`。關於策略、權重、sticky 路由與失敗行為，請見[組合](/zh-tw/guides/combos/)。

## 遠端與 LAN 綁定

預設的回送綁定不需要 API token。非回送綁定（例如 `0.0.0.0`）需要
`OPENCODEX_API_AUTH_TOKEN`；代理在沒有它時拒絕啟動。請在 `ocx start` 前，或在 `ocx service install` 前設定該變數，以便服務接收它：

```bash
export OPENCODEX_API_AUTH_TOKEN="your-secret-token"
ocx service install
```

客戶端隨後必須認證其管理與模型請求。在將 opencodex 暴露到本機以外之前，請閱讀[設定](/zh-tw/reference/configuration/)中的遠端存取規則。
