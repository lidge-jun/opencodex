<h3 align="center">make codex open!</h3>
<p align="center"><b>面向 OpenAI Codex、Claude Code、Claude Desktop 和 Grok Build 的通用提供商代理</b><br>
两条命令，它们就都能跑你指定的任意 LLM。</p>

<p align="center">
  <a href="https://x.com/claudeebum"><img src="https://img.shields.io/badge/%40claudeebum-000000?logo=x&logoColor=white" alt="在 X 上关注 @claudeebum"></a>
  <a href="https://www.npmjs.com/package/@bitkyc08/opencodex"><img src="https://img.shields.io/npm/v/@bitkyc08/opencodex?color=cb3837&label=npm&logo=npm" alt="npm 版本"></a>
  <a href="https://github.com/lidge-jun/opencodex/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@bitkyc08/opencodex?color=blue" alt="许可证"></a>
  <img src="https://img.shields.io/node/v/@bitkyc08/opencodex?logo=node.js&label=node" alt="Node 版本">
</p>

```bash
npm install -g @bitkyc08/opencodex
ocx start
```

<table>
<tr>
<td width="50%" valign="middle">

### Claude Code，运行任意模型

选择器还是 Claude Code 原装的，换掉的只是背后的大脑。

</td>
<td width="50%">
  <img src="../assets/claude-code-models.gif" alt="Claude Code 通过 opencodex 运行路由模型 —— 状态栏显示 gpt-5.6-luna-medium 为当前模型" width="100%">
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Codex，运行任意模型

选好提供商就能开跑 —— 同样的工作流，换个大脑。

</td>
<td width="50%">
  <img src="../assets/demo.gif" alt="opencodex 演示 —— 在 Codex 应用中用路由的非 OpenAI 模型执行任务" width="100%">
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Claude Desktop，运行任意模型

Opus 作答，然后把任务交给 GPT-5.6 Sol 子代理。

</td>
<td width="50%">
  <img src="../assets/claude-desktop-subagent.gif" alt="Claude Desktop 以 Claude Opus 4.8 作答，然后通过 opencodex 派发 GPT-5.6 Sol 子代理" width="100%">
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Grok Build，运行任意模型

Sol 驱动会话，并调用 Kimi K3 子代理。

</td>
<td width="50%">
  <img src="../assets/grok-build-subagent.gif" alt="Grok Build 通过 opencodex 运行 GPT-5.6 Sol，并调用 Kimi K3 子代理" width="100%">
</td>
</tr>
</table>

<p align="center">
  <a href="../README.md">English</a> · <a href="README.fr.md">Français</a> · <a href="README.ko.md">한국어</a> · <b>简体中文</b> · <a href="README.zh-TW.md">繁體中文</a> · <a href="README.ru.md">Русский</a> · <a href="README.ja.md">日本語</a> · <a href="README.tr.md">Türkçe</a> · 📖 <a href="https://opencodex.me/zh-cn/"><b>完整文档 →</b></a>
</p>

opencodex 是一个轻量级本地代理，把 Codex 的 Responses API 翻译成你的提供商所讲的协议 ——
流式传输、工具调用、推理令牌、图片，双向都通。用 Claude、Gemini、Grok、GLM、DeepSeek、Kimi、
Qwen、Ollama 或任意其他 LLM 搭配 Codex、Claude Code、Claude Desktop 和 Grok Build。它还能为
Codex 认证管理一个 **ChatGPT 账户池**：添加账户，在仪表板中刷新配额，让新会话自动路由到
使用量最低的健康账户，而已有线程则固定在启动它们的账户上。

## 快速开始

### 个人安装

```bash
npm install -g @bitkyc08/opencodex   # Node 18+；Bun 运行时会自动捆绑
ocx start                         # 代理 + 仪表板：localhost:10100
```

使用 `ocx service` 在后台运行。

打开 **http://localhost:10100**，在 Web 仪表板中完成所有配置 —— 添加提供商
（40 多个内置，或任意 OpenAI 兼容端点）、选择模型、管理账户。随时运行 `ocx gui`
可重新打开仪表板。
它还能为 Codex 认证管理一个 **ChatGPT 账户池**。添加多个 ChatGPT / Codex 账户，
在仪表板中刷新它们的 5 小时 / 每周 / 30 天配额。在配额路由下，新会话可以使用
使用量最低的健康账户；round-robin 和 fill-first 则各自使用自己的策略。现有 Codex
线程通常会保持对启动它的账户的亲和性，因此长时间的 SSH、tmux 或移动端连接的会话
不会在对话中途跳账户 —— 但配额重新评估、故障转移、账户排除、亲和性过期，或
401/403 与 429 恢复，仍可能重新绑定。给账户设定选择顺序，以便其中某个账户 ——
通常是你的 Codex Desktop 登录 —— 只在其他账户耗尽后才被选中。

### 赞助商

赞助商支撑 opencodex 跟上每一次上游协议变更。有兴趣？
见 [SPONSORS.md](../SPONSORS.md)。

<!-- sponsors:main — one banner, model developers only; empty until a Main sponsor signs -->

<!-- sponsors:standard — one row per sponsor, in order of signing -->
<table>
<tbody>
<tr>
<td width="180"><a href="https://www.orcarouter.ai/?utm_source=opencodex&utm_medium=readme"><img src="../assets/sponsors/orcarouter.png" alt="OrcaRouter" width="150"></a></td>
<td>感谢 <a href="https://www.orcarouter.ai/?utm_source=opencodex&utm_medium=readme">OrcaRouter</a> 赞助本项目！OrcaRouter 是面向生产环境的 OpenAI 兼容 AI 网关：自适应路由会给每条提示打分，并把它送到达到你门槛的模型，自动故障转移，路由规则即代码，零加价的提供商定价并支持提示缓存，以及护栏、代理防火墙和每次调用的请求日志，覆盖 200+ 模型。在添加提供商选择器中选择 <code>OrcaRouter</code>，或运行 <code>ocx provider add orcarouter</code>；<code>orcarouter/auto</code> 是自适应路由器。</td>
</tr>
<tr>
<td width="180"><a href="https://www.packyapi.com/register?aff=k5KT"><img src="../assets/sponsors/packycode.png" alt="PackyCode" width="150"></a></td>
<td>感谢 <a href="https://www.packyapi.com/register?aff=k5KT">PackyCode</a> 赞助本项目！PackyCode 是一家稳定、高性能的 API 中转提供商，为 Claude Code、Codex、Gemini 等提供中转服务。凭借自动故障转移、智能路由和无限并发，它让 AI 成为真正的生产力工具。<a href="https://www.packyapi.com/register?aff=k5KT">通过此链接注册</a>并开始使用！在添加提供商选择器中选择 <code>PackyCode</code>，或运行 <code>ocx provider add packycode</code>。<br><sub>PackyCode 是一家稳定、高效的 API 中转服务商，提供 Claude Code、Codex、Gemini 等多种中转服务。具备自动故障转移、智能路由和无限并发等多种功能，让 AI 编程成为真正的生产力工具。<a href="https://www.packyapi.com/register?aff=k5KT">点此链接注册</a>，立即开始使用！</sub></td>
</tr>
</tbody>
</table>

---

<details>
<summary>Docker Compose</summary>

本仓库提供摘要固定、非 root 的 Compose 构建。在宿主机安装 Git 和 Bun 后，每次构建镜像前
先生成规范兼容性清单，然后通过 stdin 初始化一次数据面令牌，再启动 hub：

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

默认主机绑定是 `127.0.0.1:10100`。远程暴露需要显式
`OPENCODEX_BIND_ADDRESS=<LAN-or-Tailscale-IP> docker compose up -d`；`0.0.0.0` 会选择加入
全部主机接口。用防火墙和经过认证的 TLS/tailnet 前端限制访问。
生成的 JSON 保持未跟踪；它会被复制进镜像，且不包含 `.git`。
源码变更后请重新生成，并且在生成与构建之间不要改动源码。
构建会拒绝过期清单、缺失或不匹配的文件、额外源文件以及符号链接。
它会核对构建上下文和复制进运行时的每个已记录 SHA-256，包括
`package.json`、`bun.lock`，以及被明确纳入的 `scripts/model-metadata.source.json`。

令牌和可变状态留在 `ocx-state` 命名卷中；镜像、Compose 文件、环境或 shell 参数里
都不会放入任何凭证。提供商配置、经认证的验收检查、远程管理和回滚，见
[Remote Hub 部署指南](https://opencodex.me/zh-cn/guides/remote-hub/)。

</details>

<details>
<summary>从源码安装（最新 dev）</summary>

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

源码安装运行最新的 `dev` 分支。内存所有权补丁、运行时 GC 改进以及尚未发布的修复
会先在这里出现，再进入 npm 包。

</details>

<details>
<summary>面向 agent</summary>

```bash
npm install -g @bitkyc08/opencodex
ocx start     # 或 `ocx service`
ocx init      # 交互式设置：写入 ~/.opencodex/config.json 并接入 Codex
```

`ocx init` 从不启动代理；先启动也可以，后启动也可以 —— 两种顺序都可行，但
`ocx provider add`、`ocx combo set` 这类无头命令会连接**正在运行的**代理，无法访问时
以非零状态退出。`ocx status` / `ocx doctor` / `ocx health` 报告运行状态。

> **正在安装或运行 opencodex 的代理：** 请阅读
> [`AGENTS_INSTALL.md`](../AGENTS_INSTALL.md)。交互式 `ocx start` 可能会询问一次是否为
> 本仓库加星 —— 那是用户的决定，绝不是代理的决定。CLI 会在代理驱动的运行中抑制该提示，
> API 则以 `403 agent_consent_required` 拒绝它们。

</details>

## 支持平台

| 操作系统 | 状态 | 服务管理器 |
|---|---|---|
| macOS (arm64 / x64) | 完整支持 | launchd |
| Linux (x64 / arm64) | 完整支持 | systemd（用户单元） |
| Windows (x64) | 完整支持 | 任务计划程序（隐藏） / 可选原生服务 (`--native`，WinSW) |

需要 [Node](https://nodejs.org) 18+。Bun 运行时在 `npm install` 时捆绑 —— 无需单独安装
Bun，Windows 也不需要 WSL。如果 npm 拦截了捆绑运行时的安装脚本，见
[安装文档](https://opencodex.me/zh-cn/getting-started/installation/)。

## 亮点

- **在 Codex、Claude Code、Claude Desktop 和 Grok Build 中使用任意 LLM** —— 开箱即用
  40 多个提供商，各自保留自己的原生界面。
- **池化 ChatGPT 账户** —— 线程亲和性、感知配额的自动切换、冷却以及
  fail-closed 认证处理。

  > **提供商政策说明：** 账户池仅用于路由和运行韧性；它不保证能避开提供商的速率限制、
  > 执法、停用或其他账户处置。OpenCodex 不支持用额外账户规避提供商限制，也不支持
  > 在人与人之间共享账户凭证。你有责任遵守各提供商的现行条款。见
  > [Codex Auth 账户池指南](https://opencodex.me/zh-cn/guides/web-dashboard/)
  > 以及 [OpenAI 现行使用条款](https://openai.com/policies/terms-of-use/)。
- **Combos** —— 一个虚拟模型 id，跨提供商做故障转移或加权 round-robin。见
  [combo 指南](https://opencodex.me/zh-cn/guides/combos/)。
- **任意模型上的子代理** —— 把路由模型放进 Codex 的子代理选择器，带 v1/v2
  表面控制和回退链。见
  [子代理指南](https://opencodex.me/zh-cn/guides/sub-agent-surface/)。
<!-- sponsors:main-first-mention -->
- **登录一次，跳过 API 密钥** —— xAI、Anthropic 和 Kimi 支持 OAuth；或转发
  `codex login`、粘贴密钥，或使用 `${ENV_VAR}` 引用。
- **网页搜索与视觉边车** —— 非 OpenAI 模型通过你的 ChatGPT 登录上的边车，获得真正的
  网页搜索和图片理解。
- **看清正在发生什么** —— 仪表板展示提供商、OAuth 状态、模型选择，以及带缓存令牌计数的
  实时请求日志。
- **干净退出，零残留** —— `ocx stop` 把 Codex 恢复为原始配置。
- **有界内存所有权** —— 每一个长期缓存、环形缓冲区和协议翻译存储都有有限上限、
  字节预算或主动对账。配置重载后不会留下无界的 `Map` 或 `Set`。

<details>
<summary>内存所有权详情</summary>

OpenCodex 跟踪 36 类进程保留状态。每一类都有文档化的边界：

- **12 个保留存储**（请求日志、调试环、图片缓存、模型缓存、视觉
  描述、光标 blob、responses 续写等）按字节记账，并由应用自有的内存预算
  （默认 256 MiB）逐出。
- **4 个观测缓冲区**（翻译累加器、图片/OAuth/Grok 尾部）会监测飞行中的字节压力，
  但不做逐出。
- **24 个状态存储注册** 负责过期扫描（60 秒间隔）和配置世代对账，从而移除过期的
  提供商/账户键。
- **路径与指纹备忘**（工作区元数据、加固身份、安装盐、模式提示能力）使用按插入顺序的
  LRU 上限（8–128 条）。
- **模型缓存世代墓碑** 在对账后删除；全局世代递增阻止过期的飞行中发现重新填入已移除的
  提供商。
- **Lab 事件 id 去重** 在磁盘账本锁下运行，没有进程级 RAM 索引。

运行 `GET /api/system/memory`（带管理令牌）可检查实时保留字节、
逐出计数器和看门狗采样。

</details>

## 模型路由

用 `provider/model` 语法指向任意已配置的提供商和模型：

```bash
codex -m "anthropic/claude-opus-5" "解释这个 stack trace"
codex -m "google/gemini-3-pro" "为 auth.ts 写单元测试"
codex -m "ollama/llama3" "重构这个 function"
```

省略 `provider/` 前缀则使用默认提供商，或按模型名模式自动匹配。
包含 `/` 的提供商模型 id 会把内部斜杠别名为 `-` 再对外暴露；带全部斜杠的原始形式
仍然可用。详情：[模型路由文档](https://opencodex.me/zh-cn/guides/model-routing/)。

## 提供商与适配器

<!-- sponsors:main-first-mention -->
OpenAI（ChatGPT 登录或 API 密钥）、Anthropic、Google Gemini、xAI、Kimi、Azure OpenAI、Ollama
（本地 + Cloud）、Cursor（实验性），以及每一个 OpenAI 兼容端点 —— 再加上 DeepSeek、
Groq、OpenRouter、Together、Fireworks、Cerebras、Mistral、Hugging Face、NVIDIA NIM、MiniMax、
Qwen Cloud、Qoder Global 和 CN（官方 PAT + CLI）、SiliconFlow，以及更多。完整列表：`ocx init` 或
[提供商文档](https://opencodex.me/zh-cn/guides/providers/)。

## CLI

```bash
ocx init                       # 交互式设置（写入配置、接入 Codex、提供 shim）
ocx start [--port 10100]       # 在前台启动代理
ocx stop                       # 停止并恢复原生 Codex
ocx service [install|repair|restart|start|stop|status|uninstall|remove]  # 后台服务
ocx codex-shim install         # 每当启动 `codex` 时按需启动代理
ocx health [--json]            # 检查代理即时存活
ocx ready [--json] [--wait [--timeout <seconds>]]  # 检查同步后就绪
ocx status                     # 代理是否在运行？
ocx gui                        # 打开 Web 仪表板
ocx provider <...>             # 管理提供商（list/add/edit/test/remove）
ocx account <...>              # 管理 ChatGPT 账户与 API-key 池
ocx combo <...>                # 管理故障转移 / round-robin combo
ocx v2 <...>                   # 多智能体 v1/v2 表面控制
ocx update [--tag preview]     # 更新 opencodex
```

未固定端口的启动在首选端口被占用时可能改选其他空闲端口；显式 `--port`
绝不会换端口。完整参考：[CLI 文档](https://opencodex.me/zh-cn/reference/cli/)。

### 健康与就绪

`GET /healthz` 报告代理即时存活。未经认证的 `GET /readyz` 端点以经过净化的 JSON 身份
`{service, version, uptime, pid, port, status}` 报告同步后就绪。
`status` 为 `ready` 时返回 `200`；`pending` 和终态 `failed` 返回 `503`，并带
`Retry-After: 1`。

`ocx ready [--json] [--wait [--timeout <seconds>]]` 默认只探测一次。`--wait` 默认最多轮询
45 秒，但一旦观察到终态 `failed` 立即退出；
`--timeout <seconds>` 设定 1–300 秒上限，必须配合 `--wait`，且只接受正整数。CLI `--json` 输出为
`{ready, status, pid, port}`，其中 `status` 为 `ready`、`pending`、`failed` 或 `unreachable`。

| 退出码 | 结果 |
| --- | --- |
| `0` | 就绪 |
| `1` | 未就绪：pending、failed、超时或不可达 |
| `64` | 参数无效 |

没有 `/readyz` 的旧代理会 fail-closed 为 `unreachable` 并以退出码 1 结束，而 `ocx health`
保持兼容。

### 自动启动：service 与 shim

使用 **service**（`ocx service`）得到崩溃后会重启的常驻代理。使用
**shim**（`ocx codex-shim install`）做轻量按需启动，无需后台守护进程。
用 `ocx service uninstall` / `ocx codex-shim uninstall` 移除它们。

### 卸载

```bash
ocx uninstall                  # 停止、移除 service/shim、恢复原生 Codex、清理状态
npm uninstall -g @bitkyc08/opencodex
```

## 远程访问

默认情况下 opencodex 绑定到 `127.0.0.1`，无需额外认证。绑定超出
回环（`"hostname": "0.0.0.0"`）**必须**提供 bearer 令牌 —— 没有
`OPENCODEX_API_AUTH_TOKEN` 时代理会拒绝启动，并且每个客户端请求都必须把它放在
`x-opencodex-api-key` 中。详情：[配置参考](https://opencodex.me/zh-cn/reference/configuration/)。

## 文档

公开文档 —— 安装、提供商、路由、combo、子代理、边车、集成，以及
CLI/配置/管理 API 参考 —— 由 [`docs-site/`](../docs-site) 构建，并发布到
**[opencodex.me](https://opencodex.me/zh-cn/)**。

维护者 source-of-truth 笔记位于 [`structure/`](../structure)，贡献者设置见
[`CONTRIBUTING.md`](../CONTRIBUTING.md)，安全报告见 [`SECURITY.md`](../SECURITY.md)。
未公开的漏洞请通过
[GitHub 私有漏洞报告](https://github.com/lidge-jun/opencodex/security/advisories/new)
私下报告，不要开公开 issue。
这个表单是唯一的技术渠道，没有安全邮箱。后续沟通都留在这份私有报告里；公开 issue 只能用来协调，不能放
漏洞细节。确认收到报告不等于已经分诊，也不承诺首次响应的时限。

## 开发

源码开发需要 `PATH` 上的 `bun` CLI。它与已发布 npm 包捆绑的 Bun 运行时是分开的，
后者只给已安装的 `ocx` 命令使用。

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun install
bun run typecheck
bun run test
```

见 **[贡献指南](../CONTRIBUTING.md)**。

经由维护者转写或重实现落地、且提交未点名原作者的贡献者工作，记录在
**[CREDITS.md](../CREDITS.md)**。

## 免责声明

opencodex 是一个独立的社区维护项目，**与 OpenAI、Anthropic 或任何其他提供商无关，也未获得其认可。**

某些提供商 —— 尤其是 Anthropic (Claude) —— 可能会暂停或限制通过第三方代理路由 API 流量的账户。**使用风险自负 (UAYOR)。** 在连接提供商之前，请查阅其服务条款以确认是否允许基于代理的访问。opencodex 维护者不对上游提供商采取的任何账户操作承担责任。

## 许可证

MIT
