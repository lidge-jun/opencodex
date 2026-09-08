---
title: Remote Hub 部署
description: 使用仅回环管理入口、Tailscale Serve 和无头 OAuth 运行 opencodex hub。
---

Remote Hub 将提供商凭据、模型目录和使用记录保存在一台主机上，经过身份验证的客户端直接访问其数据平面。管理平面相互独立：可选管理监听器只绑定 `127.0.0.1`，仅提供控制台和 `/api/*`。它不提供 `/v1/*`、`/healthz`、`/readyz` 或 WebSocket。不要直接发布 `10101`，也不要使用 Tailscale Funnel。

## 角色与信任边界

`standalone` 在一台机器上运行全部功能；`hub` 保存提供商密钥和使用记录；`client` 只保存连接状态和专属数据密钥。

```bash
ocx connect https://hub-name.tailnet-name.ts.net --pairing-code-stdin
ocx connect status
ocx sync
```

客户端密钥写入仅所有者可读的 `service-api-token`，绝不会写入 `config.json`。连接期间，使用记录来自 hub 并按稳定的 `apiKeyId` 过滤；断开后显示本地记录。两者不会镜像。

Admin token 只能执行普通管理，永远不能创建用户同意会话。用户同意操作必须使用服务器签发的 `gui-session`、匹配的 Origin 和 CSRF。`Tailscale-User-Login` 只在独立管理入口可信；请在 `remoteGui.allowedTailscaleUsers` 中填写准确登录名。

## systemd/launchd 与 Tailscale Serve

```bash
ocx config set runtimeRole hub
ocx config set hostname 100.64.0.10
ocx config set hub.managementPublicOrigin '"https://hub-name.tailnet-name.ts.net"'
ocx config set corsAllowOrigins '["http://localhost:10100"]'
ocx config set hub.managementIngress '{"enabled":true,"port":10101}'
ocx config set remoteGui.allowedTailscaleUsers '["operator@example.com"]'
export OPENCODEX_API_AUTH_TOKEN="$(openssl rand -hex 32)"
ocx service install
```

systemd/launchd 从受保护的 `service-api-token` 读取密钥，plist 和 unit 不包含明文密钥。

```bash
curl --fail --silent http://100.64.0.10:10100/healthz
curl --fail --silent http://100.64.0.10:10100/readyz
tailscale serve --bg --https=443 http://127.0.0.1:10101
tailscale serve status
```

`/healthz` 只证明进程存活。还必须验证 `/readyz`、经过身份验证的 `GET /v1/catalog` 和一次真实模型响应。管理端口只能监听 `127.0.0.1`。自建 TLS 代理应使用 `tailscale cert hub-name.tailnet-name.ts.net`，并仅代理到 `127.0.0.1:10101`。不要伪造 `Tailscale-User-*`；没有可信身份时请使用一次性配对。

## OAuth、密钥轮换与断开

```bash
ocx config set oauthOpenBrowser false
ocx connect rotate --pairing-code-stdin
# 仅限 HTTPS：
ocx connect rotate --admin-token-stdin
```

通过 `POST /api/oauth/login` 启动 OAuth。如果回调无法到达 hub，将最终 URL 或授权码作为 `{provider,input}` 发送到 `POST /api/oauth/login/code`。不要把 OAuth 码放入 argv 或日志。

轮换期间，旧密钥和新密钥在同一个 `apiKeyId` 下最多同时有效十分钟。旧密钥备份到 `service-api-token.prev`，新密钥以原子方式安装，并通过 `/v1/catalog` 验证后提交。如果提交结果不确定，请使用临时权限重新运行命令；在验证两个候选密钥前不要删除任何文件。

`ocx disconnect` 即使 hub 离线也能恢复本地状态，但不会吊销 hub 密钥。断开后，唯一的吊销入口是 hub 的 **Integrations → API Keys**。`ocx connect revoke --admin-token-stdin` 只能在仍连接时使用。

## Docker、回滚与排障

回滚时也要保留两个卷及其挂载路径。已有卷的所有权和权限不会自动修复。有关不使用 Compose 时的命名卷挂载及单独的状态路径，请参阅[英文基准指南](/guides/remote-hub/#docker-compose)。

部署使用两个独立持久卷：`ocx-state` 对应
`OPENCODEX_HOME=/home/bun/.opencodex`，`codex-state` 对应
`CODEX_HOME=/home/bun/.codex`。两个产品的 `auth.json` 格式不同，不能合并到同一个
主目录。即使根文件系统只读，这两个目录也可通过各自的卷写入。

此设置不会自动生成模型目录。在检查认证后的 `/v1/catalog` 前，必须生成或导入有效的
`/home/bun/.codex/opencodex-catalog.json`；空目录返回 `catalog_not_found` 404 属于正常行为。
升级会保留现有 `ocx-state` 并新增 `codex-state`，但不会自动迁移文件。若之前的临时方案
将模型目录放在 `.opencodex` 下，请先备份，再仅迁移模型目录文件，并保留仅所有者可访问的权限。
不要用一个产品的 `auth.json` 覆盖另一个。自定义 `CODEX_HOME` 时，必须将该确切目录挂载为
可写持久卷，并在 `${CODEX_HOME}/opencodex-catalog.json` 准备默认目录文件。
若 `model_catalog_json` 指向其他文件，也必须持久保存其解析后的路径。
在明确完成迁移前，请保留已有的环境变量与卷路径映射。
`docker compose down` 保留两个卷；`docker compose down --volumes` 则会删除
`ocx-state` 和 `codex-state`，包括配置、凭据、用量记录、数据密钥及 Codex 状态和模型目录。
这是破坏性操作，不能当作升级或重启命令使用。

opencodex 不发布官方 Docker 镜像，但仓库提供维护的 `Dockerfile` 和 `compose.yaml`，用于在本地构建按 digest 固定的 Bun 镜像。首次启动前，通过 stdin 初始化一次数据密钥；密钥不会输出，并以仅所有者可读的权限保存在 `ocx-state` 卷中。

宿主机需要安装 Git 和 Bun。每次构建镜像前，都应从 Git 跟踪的源码生成规范兼容性清单，生成后到构建完成前不要修改源码。生成的 JSON 不加入 Git；`.git` 不进入 Docker 构建上下文。宿主机端口默认绑定 `127.0.0.1`。远程访问须显式使用 `OPENCODEX_BIND_ADDRESS=<LAN或Tailscale-IP> docker compose up -d`；`0.0.0.0` 会公开所有接口。请使用防火墙和经过身份验证的 TLS/tailnet 前端保护访问。

构建会拒绝过期清单，并将每个 SHA-256 分别与构建上下文及复制后的文件进行核对。缺失或不匹配的文件、清单之外的源码和符号链接都会导致失败。必须包含 `package.json`、`bun.lock`，以及 `scripts/` 中唯一纳入的 `scripts/model-metadata.source.json`。

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun scripts/generate-compatibility-version.ts
docker compose build
openssl rand -hex 32 | docker compose run --rm -T hub bun run docker/bootstrap-token.ts
docker compose up -d
```

容器以非 root 的 `bun` 用户运行，根文件系统只读，并且只发布 `10100`。不要发布 `10101`，也不要把密钥放入 `ARG`、`ENV`、`COPY`、Compose、镜像历史或 argv。healthcheck 后仍需单独验证 readiness、认证目录和真实请求。`docker compose down` 会保留卷；`docker compose down --volumes` 还会删除配置、凭据和数据密钥。

- hub 宕机：可以离线断开，但远程密钥仍待吊销。
- 目录过期：仅在临时故障时保留已验证的 LKG；认证、架构、大小或协议错误不会回退到本地提供商。
- `.prev` 恢复：保留两个文件，使用临时权限重新运行轮换。
- `hub-too-new`/`hub-too-old` 会指出需要升级的一端，并在本地写入前失败。
- 配对码一次性使用，失败次数会触发 429；丢失后请重新创建。
- 非回环 HTTP 配对必须显式使用 `--allow-insecure-http`；Admin token 绝不通过 HTTP 发送。
- 浏览器 logout/expiry 只影响会话，不会吊销数据密钥。
- `tailscale serve reset` 会删除节点上的所有映射，请先查看 `tailscale serve status`。
