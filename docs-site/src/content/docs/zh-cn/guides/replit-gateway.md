---
title: Replit 网关伴侣
description: 将 opencodex 与您自建的 Replit 部署配对，该部署通过 Replit AI Integrations 中继 OpenAI Chat 与 Anthropic Messages——这是可选的自定义工作流，而非正式注册表预设。
---

**Replit 网关伴侣**是位于
[`integrations/replit-gateway`](https://github.com/lidge-jun/opencodex/tree/dev/integrations/replit-gateway)
的用户自有 Bun 服务，运行在**您的 Replit 部署内**。它从 Repl 环境读取 Replit 托管的 AI Integrations
凭据，并向 opencodex 暴露两个原生协议端点：

```text
opencodex（本地）
  -> HTTPS + 网关密钥
  -> 您的 Replit 部署（integrations/replit-gateway）
  -> Replit AI Integrations 上游（OpenAI Chat / Anthropic Messages）
```

opencodex 永远不会收到 `AI_INTEGRATIONS_*` 密钥。您需单独提供 **网关密钥**
（`REPLIT_GATEWAY_KEY`），由 opencodex 本地保存，并在每次请求中以 `Authorization: Bearer …` 发送。

> **仅限自定义工作流。** `replit` 与 `replit-anthropic` **不是**正式注册表预设。opencodex 不宣称
> 官方 Replit 提供商；在获得 Replit 书面授权之前，注册表推广仍被阻止（见下方[证据门槛](#证据门槛)）。

> **实验性 — 部署未验证。** 代码与 v1 合约为 `experimental-pending-canary`，**尚未完成针对 Replit 实际注入环境的 live 部署验证。**

## 所需条件

- 账户或组织可用的**付费 Replit 计划**及
  [Replit AI Integrations](https://docs.replit.com/features/integrations/replit-ai-integrations)。
- Replit Agent 请求为 Repl 附加 OpenAI 与 Anthropic 托管集成时的**手动批准**。opencodex 不会自动
  执行 Replit 登录、计费或集成对话框。
- 网关包已部署且可通过公开 **HTTPS** 源站访问（通常为 `https://<repl>.replit.app`）。
- 运行中的 opencodex 代理（`ocx start`），用于控制台向导或 CLI 安装。

部署与配置请参阅
[包 README](https://github.com/lidge-jun/opencodex/blob/dev/integrations/replit-gateway/README.md)。

## 部署网关（摘要）

1. 将 `integrations/replit-gateway/` 复制到 Bun Repl（或从仓库运行）。
2. 添加 `server.ts`：调用 `loadGatewayConfigFromEnv()` 与 `createGatewayServer()`，再
   `Bun.serve({ fetch: gateway.fetch, port, hostname: "0.0.0.0" })`。
3. 在 Replit 界面中批准 **OpenAI** 与 **Anthropic** 托管集成。
4. **在不打印值的情况下确认观察到的 `AI_INTEGRATIONS_*` 名称**（见下）。
5. 设置密钥：`REPLIT_GATEWAY_KEY`（**32–512** 可打印 ASCII）、`REPLIT_GATEWAY_PUBLIC_ORIGIN`、模型允许列表及四个精确集成变量名。
6. 确认 `GET /healthz` 与带认证的 `GET /v1/models` 成功。

### Replit 环境变量名（未验证的观察惯例）

必需名称：`AI_INTEGRATIONS_OPENAI_BASE_URL`、`AI_INTEGRATIONS_OPENAI_API_KEY`、`AI_INTEGRATIONS_ANTHROPIC_BASE_URL`、`AI_INTEGRATIONS_ANTHROPIC_API_KEY`。**非 Replit 官方平台外合约**；**canary 验证待定**。

```bash
printenv | grep '^AI_INTEGRATIONS_' | cut -d= -f1 | sort -u
```

网关密钥 **32–512** 可打印 ASCII：

```bash
openssl rand -base64 48 | tr -d '\n'
```

仅存入 Replit Secrets 与 opencodex 配对步骤，切勿提交到 git。

## 与 opencodex 配对

安装会写入由部署源站派生的**两个**自定义提供商：

| 提供商 id | 适配器 | 基础 URL | 说明 |
| --- | --- | --- | --- |
| `replit` | `openai-chat` | `<origin>/v1` | 通过 `GET /v1/models` 实时发现模型 |
| `replit-anthropic` | `anthropic` | `<origin>` | Bearer 传输；`liveModels: false` |

二者共享同一网关密钥。替换配对时，保留您已设置的非派生字段（所选模型、限速、非凭据自定义头）。

### CLI — `ocx provider install-replit`

```bash
export REPLIT_GATEWAY_KEY='your-gateway-key'
ocx provider install-replit --origin https://my-app.replit.app
```

密钥来源（三选一）：`REPLIT_GATEWAY_KEY` 环境变量、`--stdin`、`--gateway-key-file <path>`。**不得**
写在命令行参数中。

常用标志：`--allow-custom-domain`、`--replace`、`--set-default`、`--json`。

写入配置前，opencodex 仅探测**不计费**端点：`GET <origin>/healthz`、`GET <origin>/v1/models`（Bearer）。

### 控制台向导

在 **Providers** 页点击 **Replit gateway…**：

1. 输入 **HTTPS 源站**与**网关密钥**。
2. 若不在 `.replit.app` 上，可启用 **Allow custom domain**。
3. 可选将 **replit** 设为默认提供商。
4. 成功后显示 health 与 models 探测耗时。

若配对已存在，**Replace pair** 前需明确确认。向导注明这**不是**正式注册表预设。

## 自定义域名可选启用

默认仅接受以 `.replit.app` 结尾的 HTTPS 源站。opt-in **不证明**主机名所有权，**不排除**安装后的 DNS 重绑定/TLS **运维责任**。opencodex **会**校验 HTTPS URL 语法、安装前 destination/DNS 评估与 HTTPS 探测，但均为**时点检查**。

## 冷启动

Replit 部署空闲后可能休眠。唤醒后首请求可能较慢或返回 `upstream_error`/`upstream_timeout`。安装
探测超时 8 秒；网关不会自动重试计费上游请求。

## 网关限制（v1）

| 限制 | 默认值 |
| --- | --- |
| 最大请求体 | 32 MiB |
| 最大请求头 | 32 KiB |
| 最大并发 | 10 |
| 上游超时 | 300 秒 |
| 客户端超时 | 310 秒 |

上游 HTTP 重定向被拒绝。允许范围见包 README。

## 错误类别

网关返回稳定的 JSON 错误类别（绝不回显密钥或请求体）：

`auth_failed`, `config_invalid`, `request_too_large`, `headers_too_large`,
`unsupported_content_encoding`, `model_not_allowed`, `concurrency_limited`, `upstream_timeout`,
`client_timeout`, `client_aborted`, `redirect_rejected`, `upstream_error`, `internal`。

常见 HTTP 映射：`401` 认证、`400` 模型不允许、`413` 请求体过大、`415` 编码请求体、`429` 并发限制、`408` 客户端超时、`504` 上游超时、`502` 上游/重定向失败。

## 原生能力（v1）

**支持** — OpenAI Chat 与 Anthropic Messages 字节流中继。SSE `: heartbeat\n\n` 仅在**完整行边界**注入。

**延迟 LF 策略：** CRLF 跨 chunk 分割且 `\n` 延迟时，可能将 `\r` 视为行边界以决定 heartbeat 时机。**负载字节不被修改**；罕见 split-CRLF 下**行结束时机**可能与原生提供方不同。

## v1 不支持

- 正式 Replit 注册表预设或选择器磁贴
- 经此网关的 Google Gemini、OpenRouter 等
- OpenAI Responses、图像、音频、转写
- OpenAI 与 Anthropic 之间的协议转换
- 自动上游重试、缓存或规范化
- 浏览器 CORS
- 非 identity 的 `Content-Encoding`
- `replit-anthropic` 的实时模型发现
- 任何 Replit 账户、批准或部署自动化

## 隐私、额度与条款

- **凭据边界：** 仅网关密钥存入 `~/.opencodex/config.json`。
- **计费：** Replit AI Integrations 按公开 API 价格从 Replit 额度扣费。
- **条款：** 适用您套餐的 **Replit 条款**。[服务条款](https://replit.com/terms-of-service)（**Replit, Inc.**）；ToS 说明 **Pro/Enterprise** 受 [Commercial Agreement](https://replit.com/commercial-agreement) 约束。**平台外路由授权未确立。**
- **日志：** 网关仅记录元数据；管理 API 响应不记录网关密钥。

## 证据门槛

opencodex 仅在具备一手证据时维护提供商预设（见[贡献 — 正式预设所需证据](/contributing/#evidence-required-for-a-canonical-preset)）。
Replit 伴侣**目前不达标**。

| 证据项 | 状态（2026-08-22 核验） |
| --- | --- |
| **平台外** OpenAI Chat + Anthropic Messages | **未确立** |
| `AI_INTEGRATIONS_*` 名称 | **未验证观察惯例**；canary 待定 |
| 条款与法律实体 | 服务条款 — **Replit, Inc.**；Pro/Enterprise：Commercial Agreement |
| 平台外路由授权 | **未获得** |
| 具名维护负责人 | **opencodex：** [@lidge-jun](https://github.com/lidge-jun)、[@Ingwannu](https://github.com/Ingwannu)（[`MAINTAINERS.md`](https://github.com/lidge-jun/opencodex/blob/main/MAINTAINERS.md)）。**Replit：** 未作为此工作流的合作伙伴参与。 |
| 可引用核验日期 | **2026-08-22** |

**注册表推广被阻止。** `replit`/`replit-anthropic` 不在 `src/providers/registry.ts` 中。

## 另见

- [包 README](https://github.com/lidge-jun/opencodex/blob/dev/integrations/replit-gateway/README.md)
- [设计规格](https://github.com/lidge-jun/opencodex/blob/dev/docs/superpowers/specs/2026-08-22-replit-gateway-design.md)
- [提供商](/guides/providers/)
- [Web 控制台](/guides/web-dashboard/)
