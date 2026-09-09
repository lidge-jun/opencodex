<h3 align="center">make codex open!</h3>
<p align="center"><b>適用於 OpenAI Codex、Claude Code、Claude Desktop 與 Grok Build 的通用供應商代理</b><br>
兩條命令，這四個就都能跑你指定的任何 LLM。</p>

<p align="center">
  <a href="https://x.com/claudeebum"><img src="https://img.shields.io/badge/%40claudeebum-000000?logo=x&logoColor=white" alt="在 X 上關注 @claudeebum"></a>
  <a href="https://www.npmjs.com/package/@bitkyc08/opencodex"><img src="https://img.shields.io/npm/v/@bitkyc08/opencodex?color=cb3837&label=npm&logo=npm" alt="npm 版本"></a>
  <a href="https://github.com/lidge-jun/opencodex/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@bitkyc08/opencodex?color=blue" alt="授權"></a>
  <img src="https://img.shields.io/node/v/@bitkyc08/opencodex?logo=node.js&label=node" alt="Node 版本">
</p>

```bash
npm install -g @bitkyc08/opencodex
ocx start
```

<table>
<tr>
<td width="50%" valign="middle">

### Claude Code，執行任意模型

選擇器還是 Claude Code 原本的，換掉的只是背後的大腦。

</td>
<td width="50%">
  <img src="../assets/claude-code-models.gif" alt="透過 opencodex 執行路由模型的 Claude Code——狀態列顯示 gpt-5.6-luna-medium 為目前模型" width="100%">
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Codex，執行任意模型

選好供應商就能開始——同樣的工作流程，換顆大腦。

</td>
<td width="50%">
  <img src="../assets/demo.gif" alt="opencodex 示範——在 Codex 應用中用路由的非 OpenAI 模型執行任務" width="100%">
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Claude Desktop，執行任意模型

Opus 先回答，再把任務交給 GPT-5.6 Sol 子代理。

</td>
<td width="50%">
  <img src="../assets/claude-desktop-subagent.gif" alt="Claude Desktop 以 Claude Opus 4.8 回答，再透過 opencodex 派發 GPT-5.6 Sol 子代理" width="100%">
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Grok Build，執行任意模型

Sol 主導會話，並呼叫 Kimi K3 子代理。

</td>
<td width="50%">
  <img src="../assets/grok-build-subagent.gif" alt="Grok Build 透過 opencodex 執行 GPT-5.6 Sol，並呼叫 Kimi K3 子代理" width="100%">
</td>
</tr>
</table>

<p align="center">
  <a href="../README.md">English</a> · <a href="README.fr.md">Français</a> · <a href="README.ko.md">한국어</a> · <a href="README.zh-CN.md">简体中文</a> · <b>繁體中文</b> · <a href="README.ru.md">Русский</a> · <a href="README.ja.md">日本語</a> · <a href="README.tr.md">Türkçe</a> · 📖 <a href="https://opencodex.me/zh-tw/"><b>完整文件 →</b></a>
</p>

opencodex 是輕量級本機代理，把 Codex 的 Responses API 翻譯成你的供應商所用的協議——串流、工具呼叫、
reasoning token、圖片，雙向皆可。在 Codex、Claude Code、Claude Desktop 與 Grok Build 上使用 Claude、
Gemini、Grok、GLM、DeepSeek、Kimi、Qwen、Ollama 或任何其他 LLM。它也能為 Codex 認證管理
**ChatGPT 帳號池**：新增帳號、在儀表板重新整理配額，讓新會話自動路由到使用量最低的健康帳號，既有執行緒則固定在啟動它的帳號上。

## 快速開始

### 個人安裝

```bash
npm install -g @bitkyc08/opencodex   # Node 18+；Bun 執行環境會自動打包
ocx start                         # 代理 + 儀表板位於 localhost:10100
```

用 `ocx service` 在背景執行。

開啟 **http://localhost:10100**，在網頁儀表板完成所有設定——新增供應商
（40+ 內建，或任何 OpenAI 相容端點）、挑選模型、管理帳號。隨時可用 `ocx gui`
重新開啟儀表板。
它也能為 Codex 認證管理 **ChatGPT 帳號池**。新增多個 ChatGPT / Codex 帳號，
在儀表板重新整理 5 小時／每週／30 天配額。在配額路由下，新會話可使用
使用量最低的健康帳號；round-robin 與 fill-first 則各自套用自己的策略。既有 Codex
執行緒通常會維持對啟動帳號的親和性，因此長時間的 SSH、tmux 或
行動裝置連線的會話不會在對話中途跳帳號——但配額重新評估、failover、
帳號排除、親和性到期，或 401/403 與 429 復原，仍可能重新綁定。當其中一個帳號——通常是你的 Codex Desktop 登入——只應在其他帳號用盡後才被用到時，請為帳號設定選取順序。

### 贊助

贊助讓 opencodex 能跟上每一次上游協議變更。有興趣？
見 [SPONSORS.md](../SPONSORS.md)。

<!-- sponsors:main — one banner, model developers only; empty until a Main sponsor signs -->

<!-- sponsors:standard — one row per sponsor, in order of signing -->
<table>
<tbody>
<tr>
<td width="180"><a href="https://www.orcarouter.ai/?utm_source=opencodex&utm_medium=readme"><img src="../assets/sponsors/orcarouter.png" alt="OrcaRouter" width="150"></a></td>
<td>感謝 <a href="https://www.orcarouter.ai/?utm_source=opencodex&utm_medium=readme">OrcaRouter</a> 贊助本專案！OrcaRouter 是面向正式環境的 OpenAI 相容 AI 閘道：自適應路由會為每則提示評分，送到達到你門檻的模型；自動 failover；路由規則即程式碼；供應商原價零加價並含 prompt 快取；每次呼叫都有 guardrail、agent 防火牆與請求日誌，涵蓋 200+ 模型。在「新增供應商」選擇器選 <code>OrcaRouter</code>，或執行 <code>ocx provider add orcarouter</code>；<code>orcarouter/auto</code> 就是自適應路由器。</td>
</tr>
<tr>
<td width="180"><a href="https://www.packyapi.com/register?aff=k5KT"><img src="../assets/sponsors/packycode.png" alt="PackyCode" width="150"></a></td>
<td>感謝 <a href="https://www.packyapi.com/register?aff=k5KT">PackyCode</a> 贊助本專案！PackyCode 是穩定、高效能的 API 轉送供應商，提供 Claude Code、Codex、Gemini 等轉送服務。具備自動 failover、智慧路由與無限並行，讓 AI 成為真正的生產力工具。<a href="https://www.packyapi.com/register?aff=k5KT">透過此連結註冊</a>即可開始！在「新增供應商」選擇器選 <code>PackyCode</code>，或執行 <code>ocx provider add packycode</code>。<br><sub>PackyCode 是一家稳定、高效的 API 中转服务商，提供 Claude Code、Codex、Gemini 等多种中转服务。具备自动故障转移、智能路由和无限并发等多种功能，让 AI 编程成为真正的生产力工具。<a href="https://www.packyapi.com/register?aff=k5KT">点此链接注册</a>，立即开始使用！</sub></td>
</tr>
</tbody>
</table>

---

<details>
<summary>Docker Compose</summary>

本儲存庫提供 digest 釘選、非 root 的 Compose 建置。主機已安裝 Git 與 Bun 時，
每次建置映像前先產生權威相容性清單，再透過 stdin 初始化一次資料平面權杖並啟動 hub：

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun scripts/generate-compatibility-version.ts
docker compose build
openssl rand -hex 32 | docker compose run --rm -T hub bun run docker/bootstrap-token.ts
docker compose up -d
curl --fail --silent http://127.0.0.1:10100/healthz
curl --fail --silent http://127.0.0.1:10100/readyz
```

預設主機綁定為 `127.0.0.1:10100`。遠端公開必須明確指定
`OPENCODEX_BIND_ADDRESS=<LAN-or-Tailscale-IP> docker compose up -d`；`0.0.0.0` 會加入
所有主機介面。請用防火牆與已認證的 TLS／tailnet 前端限制存取。
產生的 JSON 不會被追蹤；它會複製進映像，且不含 `.git`。
原始碼變更後請重新產生，產生與建置之間不要改原始碼。
建置會拒絕過期清單、缺少或不相符的檔案、多餘原始碼檔案，以及符號連結。
它會核對建置上下文與複製進去的執行檔案上每一筆記錄的 SHA-256，包括
`package.json`、`bun.lock`，以及特別納入的 `scripts/model-metadata.source.json`。

權杖與可變狀態留在名為 `ocx-state` 的 volume；映像、Compose 檔、環境變數或 shell 引數都不會放入憑證。見
[Remote Hub 部署指南](https://opencodex.me/zh-tw/guides/remote-hub/) 以了解供應商
設定、已認證的驗收檢查、遠端管理與還原。

</details>

<details>
<summary>從原始碼安裝（最新 dev）</summary>

**macOS / Linux：**

```bash
curl -fsSL https://bun.sh/install | bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex && ~/.bun/bin/bun install
~/.bun/bin/bun run src/cli/index.ts start
```

**Windows (PowerShell)：**

```powershell
irm bun.sh/install.ps1 | iex
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex; bun install
bun run src/cli/index.ts start
```

從原始碼安裝會跑最新的 `dev` 分支。記憶體所有權
修補、執行環境 GC 改善，以及尚未發布的修正，都會比 npm 套件更早在這裡出現。

</details>

<details>
<summary>給 agent 使用</summary>

```bash
npm install -g @bitkyc08/opencodex
ocx start     # 或 `ocx service`
ocx init      # 互動式設定：寫入 ~/.opencodex/config.json 並接上 Codex
```

`ocx init` 永遠不會啟動代理；請先啟動（或之後再啟動——順序都可以，但像
`ocx provider add` 與 `ocx combo set` 這類無介面命令會跟**正在執行**的代理通訊，連不上就以非零結束碼結束）。`ocx status` / `ocx doctor` / `ocx health` 回報執行狀態。

> **正在安裝或執行 opencodex 的 agent：** 請讀
> [`AGENTS_INSTALL.md`](../AGENTS_INSTALL.md)。互動式 `ocx start` 可能會問一次要不要
> 為此儲存庫按星——那是使用者的決定，絕不是 agent 的。CLI 會在 agent 驅動的執行中隱藏該
> 提示，API 則以 `403 agent_consent_required` 拒絕。

</details>

## 支援平台

| 作業系統 | 狀態 | 服務管理員 |
|---|---|---|
| macOS (arm64 / x64) | 完整支援 | launchd |
| Linux (x64 / arm64) | 完整支援 | systemd（使用者單元） |
| Windows (x64) | 完整支援 | Task Scheduler（隱藏）／可選原生服務（`--native`、WinSW） |

需要 [Node](https://nodejs.org) 18+。Bun 執行環境在 `npm install` 時一併打包——不必另外安裝
Bun，Windows 也不需要 WSL。若 npm 攔截了打包執行環境的安裝腳本，
見[安裝文件](https://opencodex.me/zh-tw/getting-started/installation/)。

## 亮點

- **在 Codex、Claude Code、Claude Desktop 與 Grok Build 使用任何 LLM** — 開箱即用 40+ 供應商，
  各自保留原生 UI。
- **池化 ChatGPT 帳號** — 執行緒親和性、依配額自動切換、冷卻與
  fail-closed 認證處理。

  > **供應商政策說明：** 帳號池只用來做路由與營運韌性；它不保證
  > 能避開供應商的速率限制、執法、停權或其他帳號
  > 處置。OpenCodex 不贊成用額外帳號規避供應商限制，也不贊成
  > 在人與人之間共用帳號憑證。你有責任遵守各
  > 供應商的現行條款。見
  > [Codex Auth 帳號池指南](https://opencodex.me/zh-tw/guides/web-dashboard/)
  > 與 [OpenAI 現行使用條款](https://openai.com/policies/terms-of-use/)。
- **Combo** — 一個虛擬模型 id，可在供應商之間 failover 或加權 round-robin。見
  [combo 指南](https://opencodex.me/zh-tw/guides/combos/)。
- **任何模型上的子代理** — 讓路由模型出現在 Codex 的子代理選擇器，含 v1/v2
  介面控制與 fallback 鏈。見
  [子代理指南](https://opencodex.me/zh-tw/guides/sub-agent-surface/)。
<!-- sponsors:main-first-mention -->
- **登入一次，不必填 API key** — xAI、Anthropic、Kimi 支援 OAuth；也可轉發
  `codex login`、貼上金鑰，或使用 `${ENV_VAR}` 引用。
- **網頁搜尋與視覺 sidecar** — 非 OpenAI 模型可透過掛在你 ChatGPT 登入上的 sidecar，獲得真正的網頁搜尋與圖片理解。
- **看清正在發生什麼** — 儀表板顯示供應商、OAuth 狀態、模型選擇，以及含快取 token 計數的即時請求日誌。
- **乾淨退出，零殘留** — `ocx stop` 把 Codex 還原成原始設定。
- **有界記憶體所有權** — 每個長生命週期的快取、環形緩衝區與協議翻譯
  儲存都有有限上限、位元組預算或主動調和。設定重新載入後，不會留下無界的 `Map` 或 `Set`。

<details>
<summary>記憶體所有權細節</summary>

OpenCodex 追蹤 36 類行程保留狀態。每一類都有文件化的上限：

- **12 個保留儲存**（請求日誌、除錯環形緩衝、圖片快取、模型快取、視覺
  描述、cursor blob、responses 延續等）以位元組計帳，並由
  應用程式自己的記憶體預算淘汰（預設 256 MiB）。
- **4 個觀測緩衝區**（翻譯累加器、image/OAuth/Grok 尾端）會
  監控進行中的位元組壓力，但不淘汰。
- **24 個狀態儲存註冊**負責到期清掃（間隔 60 秒）與
  設定世代調和，以移除過期的供應商／帳號鍵。
- **路徑與指紋 memo**（工作區中繼資料、強化身分、安裝
  salt、mode-hint 能力）使用插入順序 LRU 上限（8–128 筆）。
- **模型快取世代 tombstone** 在調和後刪除；全域
  世代遞增可避免過期、進行中的探索把已移除的供應商填回來。
- **Lab event-id 去重**在磁碟帳本鎖下執行，行程層級沒有
  RAM 索引。

執行 `GET /api/system/memory`（帶管理權杖）可檢視目前保留的位元組、
淘汰計數與 watchdog 樣本。

</details>

## 模型路由

用 `provider/model` 語法指定任何已設定的供應商與模型：

```bash
codex -m "anthropic/claude-opus-5" "解釋這個 stack trace"
codex -m "google/gemini-3-pro" "為 auth.ts 寫單元測試"
codex -m "ollama/llama3" "重構這個 function"
```

省略 `provider/` 字首時，會使用預設供應商，或依模型名模式自動匹配。
供應商模型 id 若含 `/`，對外會把內部斜線別名成 `-`；原始
全斜線形式同樣可用。細節：[模型路由文件](https://opencodex.me/zh-tw/guides/model-routing/)。

## 供應商與 adapter

<!-- sponsors:main-first-mention -->
OpenAI（ChatGPT 登入或 API key）、Anthropic、Google Gemini、xAI、Kimi、Azure OpenAI、Ollama
（本機 + Cloud）、Cursor（實驗性），以及所有 OpenAI 相容端點——再加上 DeepSeek、
Groq、OpenRouter、Together、Fireworks、Cerebras、Mistral、Hugging Face、NVIDIA NIM、MiniMax、
Qwen Cloud、Qoder Global 與 CN（官方 PAT + CLI）、SiliconFlow 等等。完整清單：`ocx init` 或
[供應商文件](https://opencodex.me/zh-tw/guides/providers/)。

## CLI

```bash
ocx init                       # 互動式設定（寫入設定、接上 Codex、提供 shim）
ocx start [--port 10100]       # 在前景啟動代理
ocx stop                       # 停止並還原原生 Codex
ocx service [install|repair|restart|start|stop|status|uninstall|remove]  # 背景服務
ocx codex-shim install         # 每次啟動 `codex` 時按需啟動代理
ocx health [--json]            # 檢查代理當下是否存活
ocx ready [--json] [--wait [--timeout <seconds>]]  # 檢查同步後是否就緒
ocx status                     # 代理是否在執行？
ocx gui                        # 開啟網頁儀表板
ocx provider <...>             # 管理供應商（list/add/edit/test/remove）
ocx account <...>              # 管理 ChatGPT 帳號與 API-key 池
ocx combo <...>                # 管理 failover／round-robin combo
ocx v2 <...>                   # 多代理 v1/v2 介面控制
ocx update [--tag preview]     # 更新 opencodex
```

未釘選連接埠的啟動，在偏好連接埠被占用時可能改選其他空閒連接埠；明確的 `--port`
絕不會跳號。完整參考：[CLI 文件](https://opencodex.me/zh-tw/reference/cli/)。

### 健康狀態與就緒

`GET /healthz` 回報代理當下是否存活。未認證的 `GET /readyz` 端點回報
同步後就緒狀態，並附上淨化後的 JSON 身分 `{service, version, uptime, pid, port, status}`。
當 `status` 為 `ready` 時回傳 `200`；`pending` 與終態 `failed` 回傳 `503`，並帶
`Retry-After: 1`。

`ocx ready [--json] [--wait [--timeout <seconds>]]` 預設只探測一次。`--wait` 預設最多輪詢
45 秒，但一看到終態 `failed` 就立刻結束；
`--timeout <seconds>` 設定 1–300 秒上限，必須搭配 `--wait`，且只接受正整數。CLI `--json` 輸出為
`{ready, status, pid, port}`，其中 `status` 為 `ready`、`pending`、`failed` 或 `unreachable`。

| 結束碼 | 結果 |
| --- | --- |
| `0` | 就緒 |
| `1` | 未就緒：pending、failed、timeout 或 unreachable |
| `64` | 無效引數 |

沒有 `/readyz` 的舊代理會 fail-closed 成 `unreachable`，結束碼為 1；`ocx health`
仍保持相容。

### 自動啟動：service 與 shim

用 **service**（`ocx service`）做常駐代理，當機後會重啟。用
**shim**（`ocx codex-shim install`）做輕量、按需啟動，不必背景常駐程式。用 `ocx service uninstall` / `ocx codex-shim uninstall` 移除。

### 解除安裝

```bash
ocx uninstall                  # 停止、移除 service／shim、還原原生 Codex、清掉狀態
npm uninstall -g @bitkyc08/opencodex
```

## 遠端存取

預設 opencodex 綁定 `127.0.0.1`，不必額外認證。綁定超出
迴環（`"hostname": "0.0.0.0"`）**必須**有 bearer 權杖——沒有
`OPENCODEX_API_AUTH_TOKEN` 代理會拒絕啟動，每個用戶端請求都必須以
`x-opencodex-api-key` 帶上它。細節：[設定參考](https://opencodex.me/zh-tw/reference/configuration/)。

## 文件

公開文件——安裝、供應商、路由、combo、子代理、sidecar、整合，以及
CLI／設定／管理 API 參考——由 [`docs-site/`](../docs-site) 建置，
發布於 **[opencodex.me](https://opencodex.me/zh-tw/)**。

維護者的權威筆記在 [`structure/`](../structure)，貢獻者設定在
[`CONTRIBUTING.md`](../CONTRIBUTING.md)，安全性回報在 [`SECURITY.md`](../SECURITY.md)。
未公開的漏洞請透過
[GitHub 私人漏洞回報](https://github.com/lidge-jun/opencodex/security/advisories/new)
私下回報，不要開公開 issue。
這份表單是唯一的技術管道，沒有安全信箱。後續往來都留在這份私人回報裡；公開 issue 只能用來協調，不能放
漏洞細節。確認收到回報不等於已經分診，也不承諾首次回應的時限。

## 開發

從原始碼開發需要 `PATH` 上有 `bun` CLI。這與已發布 npm
套件打包的 Bun 執行環境不同，後者只給已安裝的 `ocx` 命令使用。

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun install
bun run typecheck
bun run test
```

見 **[貢獻指南](../CONTRIBUTING.md)**。

經維護者代為帶入或重寫而落地的貢獻者工作，
若 commit 沒有寫出原作者，會記錄在
**[CREDITS.md](../CREDITS.md)**。

## 免責聲明

opencodex 是獨立的社群維護專案，**與 OpenAI、Anthropic 或其他任何供應商無關，也未獲其背書。**

部分供應商——尤其是 Anthropic（Claude）——可能會暫停或限制經第三方代理路由 API 流量的帳號。**使用風險自負（UAYOR）。** 連線供應商前，請先查其服務條款，確認是否允許代理式存取。上游供應商對帳號採取的任何處置，opencodex 維護者概不負責。

## 授權

MIT
