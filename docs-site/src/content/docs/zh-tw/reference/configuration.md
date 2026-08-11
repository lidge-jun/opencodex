
---
title: 設定參考
description: opencodex 存放設定檔的位置、編輯方式的套用規則，以及每個設定領域的連結。
---

opencodex 把持久化設定存放在 `$OPENCODEX_HOME/config.json`，通常是
`~/.opencodex/config.json`。在 Windows 上預設為
`%USERPROFILE%\.opencodex\config.json`。

## 編輯設定的方式

依任務選擇合適的編輯管道：

- **儀表板：** 使用 Web UI 進行引導式的 provider、模型、agent、存取與儲存設定。
- **CLI：** `ocx init` 建立初始檔案，`ocx provider`、`ocx models`、`ocx combo`、
  `ocx agent`、`ocx config` 等命令會更新或檢查各自擁有的設定。
- **檔案：** 對沒有專用 UI 或 CLI 命令的欄位，直接編輯 `config.json`。檔案必須維持
  有效的 JSON。

儀表板、管理 API 與會變更狀態的 CLI 命令都會持久化到同一個檔案。優先使用這些管道，或在
手動編輯前先停止代理。執行中的程序會把設定存放在記憶體中，之後的即時儲存可能用其快照
覆寫手動編輯的內容。對於 `claudeCode` 與 listener 繫結欄位，即時儲存會合併外部編輯——這些
路徑有明確的衝突保護，但該保護並非涵蓋每個子樹。

如果檔案無法解析，opencodex 會把它備份為 `config.json.invalid-<timestamp>`、在 console
警告，並以預設值啟動。檔案缺失時也使用全新安裝的預設：一個 `openai` forward provider。

## 優先順序與預設值

`config.json` 中的有效值會覆寫內建預設。缺失的選用欄位使用各領域頁面記載的預設值。
`OPENCODEX_HOME` 優先於預設的設定目錄。接受環境變數引用的欄位（例如
`apiKey: "${PROVIDER_API_KEY}"`）會在請求時解析該變數。對出站代理，已設定的 `HTTP_PROXY`
或 `HTTPS_PROXY` 優先於頂層 `proxy` 欄位。

路由有自己有序的解析規則；見[路由](/zh-tw/reference/configuration/routing/)。

## 設定領域

- [Providers](/zh-tw/reference/configuration/providers/) — provider 條目、認證、端點、
  目錄、allowlist、context 限制、配額與 provider 專屬選項。
- [路由](/zh-tw/reference/configuration/routing/) — `defaultProvider`、模型解析順序、
  combos、別名與 combo effort 預設值。
- [Agents](/zh-tw/reference/configuration/agents/) — multi-agent 模式、委派指南、
  fallback 模型、原生預設同步與 effort 上限。
- [伺服器與執行環境](/zh-tw/reference/configuration/server/) — listener 與遠端存取、
  admission key、逾時、儲存、sidecars、啟動行為與 shadow calls。

## 不要把 secret 放進檔案

API key 優先使用 `${ENV_VAR}` 引用。字面 `apiKey`、`apiKeyPool[].key` 與
`apiKeys[].key` 值都是 secret；不要 commit、貼進 log 或分享。OAuth 與 forward provider 的
token 存放在個別的憑證儲存中，而非 `config.json`。帳號 id 與信箱也應保持私密；在支援的
地方使用公開的 selector 別名。

:::note[原子寫入]
opencodex 透過臨時檔加上重新命名（`atomicWriteFile`）寫入受管的 `config.toml` 與
`opencodex-catalog.json`。當 `ocx stop` 與代理的 shutdown handler 這類同時寫入者
一起恢復 Codex 時，這可避免只寫了一半的檔案。
:::
