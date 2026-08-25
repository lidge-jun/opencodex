---
title: 托管中转站
description: 在不暴露 OpenCodex 管理面的前提下运行 hubapi 用户登录、卡密、额度账本和公开 API 准入。
---

托管 hub 是显式启用的公开准入与记账边缘层，OpenCodex 仍是唯一提供方路由器。边缘层验证
`hub_live_` 用户密钥、预留整数额度、把公开凭据替换为内部准入密钥，再把请求流式转发到
loopback OpenCodex。

:::caution
一期只支持**单节点 SQLite**，不声明多副本或高可用。支付通道、钱包、订单和订阅不在一期范围。
:::

## 安全边界

- 普通 `ocx start` 不导入或激活托管模块；
- 公网只开放 `/hub/*` 账户路由及固定 allowlist 的四个 `/v1/*` 数据路由；
- OpenCodex `/api/*`、GUI Session、提供方凭据和管理 Token 始终留在私有监听器；
- 密码使用 Argon2id；浏览器使用不透明 HttpOnly Cookie、同源 Origin 和 CSRF；
- 用户 Key 与卡密只显示一次；不透明 Session Token 不进入页面内容；三者在数据库中都只保存分域 HMAC 摘要；
- 额度使用整数追加式账本，兑换、预留、结算和释放均在事务内幂等执行。

## 配置与启动

必须配置 `HUB_DATABASE_PATH`、`HUB_DIGEST_SECRET`、`HUB_PUBLIC_ORIGIN`、`HUB_HOSTNAME`、
`HUB_PORT`、`HUB_OPENCODEX_ORIGIN`、`HUB_INTERNAL_ADMISSION_TOKEN`、
`HUB_REQUEST_COST_UNITS` 和 `HUB_PRICING_VERSION`。内部准入密钥必须与私有 OpenCodex 的
`OPENCODEX_API_AUTH_TOKEN` 相同，并且至少包含 32 字节随机材料。

自助注册默认关闭，只有显式设置 `HUB_ALLOW_REGISTRATION=1` 才开放。可选配置还包括：

- `HUB_SESSION_TTL_SECONDS`：300–2,592,000 秒，默认 7 天；
- `HUB_UPSTREAM_TIMEOUT_MS`：1,000–600,000 毫秒，默认 120,000 毫秒。

生产环境必须设置 `HUB_HOSTNAME=127.0.0.1` 与 `HUB_TRUST_LOOPBACK_PROXY=1`，通过 TLS 反向代理公开服务；
Bun 监听器本身不终止 TLS，因此会拒绝生产公网直绑。此模式只信任
loopback 直连代理写入的单个合法 `X-Hubapi-Client-IP`；非 loopback 对端、缺失 Header、IP 链或畸形 IP
都会在路由前被拒绝。仅限 loopback 的开发直连模式完全忽略该转发 Header。

摘要密钥与内部准入密钥必须不同；占位值、带账号密码或路径的 Origin、非安全生产绑定都会让启动失败。

系统没有默认管理员。停止托管服务后，通过标准输入完成一次性引导：

```bash
printf '%s' "$HUB_ADMIN_PASSWORD" | bun run hub:bootstrap-admin -- --email admin@example.com
bun run hub:start
```

引导命令会在整个操作期间持有与托管服务相同的数据库独占租约；服务仍占有租约或已存在管理员时都会拒绝执行。

打开 `HUB_PUBLIC_ORIGIN/hub/`。管理员生成卡密批次时，完整卡密只在本次响应显示；用户兑换后
创建 `hub_live_` Key，并以公网 Origin 作为兼容 Base URL。当前按私有 OpenCodex 返回 2xx 接受请求的时点
固定扣除整数额度；接受前失败会释放预留，接受后的取消、流错误或进程恢复采用保守结算。
`Idempotency-Key` 可阻止重试重复转发和重复扣费。

### 按任务路由模型

hubapi 不建立第二套路由器。先在私有路由核心中把 `coding`、`vision`、`fast`、`private` 等任务契约
配置为别名，再由客户端在 `model` 字段传入。托管边缘只记录并原样转发别名，不读取、持久化或分类提示词正文
来猜任务；能力门槛、基于证据的候选评分、故障切换与最终提供方/模型决策仍由私有路由核心完成。

代理页使用内部准入凭据读取经过认证的私有 `/v1/models` 数据面端点。响应经过大小限制与字段校验，页面只显示
模型 ID、观测时间和上游 HTTP 状态，并明确区分空目录与不可用状态；它不读取管理 API，也不把示例别名伪装成
实际配置。

独立门户采用紧凑的 2D 像素控制台风格。`/hub/#dashboard` 只展示当前用户自己的公开路由、任务模型别名、
上游状态、扣费终态与非敏感终止原因。`/hub/#proxy` 展示真实公开端点 allowlist、计价版本、
诚实的边缘/上游状态，并提供 OpenAI 兼容客户端、Codex CLI 与 Claude Code 的可复制接入配置；配置只含密钥占位符，不读取或保留真实 API Key。`/hub/#admin` 仅管理员可见，集中呈现用户状态、整数额度聚合指标、脱敏请求活动、批次到期时间、掩码用户 Key、掩码卡密库存、用户账本、Key 撤销、代理安全与审计记录；完整 Key 与卡密不会由支持视图返回。管理员列表使用非邮箱操作代号，固定管理动作 URL 不在浏览器地址中携带可复用用户标识。
`/hub/#security` 展示只读账户资料和不含 Session Token 的活跃会话，可在验证当前密码后修改密码，也可一次撤销全部浏览器会话。

登录、注册、修改密码与卡密兑换使用持久化且经过 HMAC 的账户/网络限流；敏感管理员写操作和详情查询使用独立限流，并审计被拒绝的操作。
进程重启后会在接收流量前释放尚未被上游接受的 pending 预留，并保守结算已被上游接受的 pending 请求。
公开请求只接受未压缩 JSON；正文只在受限临时内存中用于指纹与转发，不写日志或数据库，响应保持流式而不整段缓冲。
私有 OpenCodex 调用也受超时约束。

## 反向代理与防火墙

`hub/deploy/Caddyfile.example` 只代理 `/hub`、`/hub/*` 和四个公开推理端点，其他路径默认返回 `404`；
它会覆盖客户端自带的 IP Header。`hub/deploy/hubapi-guard.nft` 先允许 loopback，再丢弃从其他网卡访问默认
OpenCodex/hub 私有端口 `10100`、`10400` 的流量，不会 flush 或替换整机现有防火墙。生产主机需要先核对自定义
端口，再执行 `nft --check --file`，维护窗口内加载指定表，并用 `nft list table inet hubapi_guard` 回读确认；
Caddy 配置另用 `caddy validate` 校验。云安全组或 VPS 防火墙只开放管理端口和 HTTPS，两个内部端口保持私有。

## 运维手册

### 备份与恢复

复制 SQLite 前先停止 `hub:start` 并确认运行租约已释放。把数据库复制到仅所有者可读的存储，记录校验和，
并定期在独立路径完成恢复演练。恢复时保持服务停止，保留故障库用于调查，把校验通过的备份放回
`HUB_DATABASE_PATH`，检查权限后启动，再核验 `/hub/health`、登录、余额和账本。不要单独恢复 `-wal` 或
`-shm` 文件。

### 密钥轮换

- `HUB_INTERNAL_ADMISSION_TOKEN` 必须和私有 OpenCodex 的 `OPENCODEX_API_AUTH_TOKEN` 在停机窗口内同步轮换，
  启动后用一笔公开请求验证；
- `HUB_DIGEST_SECRET` 保护 Session、公开 API Key、卡密与限流摘要。目前没有双密钥迁移。更换它会主动使
  现有 Session、公开 Key 和未使用卡密失效。轮换前导出必要账务证据并通知用户，停机轮换后重新签发凭据；
- 摘要密钥与内部准入密钥不得复用。

### 审计保留与事件证据

审计事件和额度账本只追加，系统不会自动清理。公网部署前应在应用外定义保留周期、加密备份和访问规则。
安全事件中保留数据库及反向代理的必要请求元数据，但不得开启 Prompt、正文、邮箱、完整 Key、Session 或卡密日志。
一期没有应用内审计删除或多节点归档导出器。

## 威胁模型与剩余限制

一期针对凭据盗用、CSRF、Session fixation、暴力登录、跨用户对象访问、重复兑换/结算、超大正文、上游阻塞和
误暴露管理路由进行防护。它无法让已被攻陷的主机、同时泄漏数据库与摘要密钥的环境、TLS 终止层或私有
OpenCodex 进程重新可信。单节点 SQLite、按上游接受请求固定扣费、人工备份和人工密钥轮换仍是明确限制。

SimpleCard 只作为 MIT 领域参考，其 Next/Spring 应用和依赖树未合并。公网部署前必须完成 hub
安全测试、严格 typecheck、全量测试、隐私扫描、高危依赖审计、TLS 加固以及实际备份恢复演练。
