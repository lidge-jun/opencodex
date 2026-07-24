---
title: 贡献指南
description: opencodex 的开发环境、结构、约定，以及添加 provider 或 adapter 的方法。
---

## 环境搭建

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun install
bun run dev:proxy    # 开发模式代理 API
bun run dev:gui      # 仪表盘 dev 服务器（另一个终端）
bun run typecheck    # bun x tsc --noEmit
bun run test         # bun test ./tests/
```

`bun run dev` 继续作为 `bun run dev:proxy` 的别名。仪表盘 dev 服务器使用 `bun run dev:gui`；
`GET /` 提供的打包仪表盘由 `bun run build:gui` 构建到 `gui/dist`。

## 构建与测试命令

根 package 是 Bun-native TypeScript，没有单独的 server compile 步骤。请使用仓库内的 script，
确保本地命令与 CI 一致：

```bash
bun run typecheck                 # 严格 TypeScript 检查
bun run test                      # 完整 tests/ suite
bun test tests/router.test.ts     # 聚焦单个测试文件
bun run build:gui                 # Vite GUI 构建 + package 准备
bun run privacy:scan              # CI 使用的 credential/privacy 扫描
bun run prepare:package           # 刷新 package launcher/asset
```

大多数测试是平铺在 `tests/*.test.ts` 下的 Bun test。`tests/helpers/` 存放共享 fixture，
`tests/e2e-style/` 存放范围更广的原生一致性场景。请在对应 subsystem 的现有测试附近加入聚焦的
回归测试；若改动涉及共享 routing、adapter、config 或 server 行为，还应运行完整 suite。

你正在阅读的文档站点位于 `docs-site/`（Astro + Starlight）：

```bash
cd docs-site && bun install && bun dev
```

## 文档发布

公开文档发布到 GitHub Pages：<https://opencodex.me/zh-cn/>。
`.github/workflows/deploy-docs.yml` 会在 `main` push 中 `docs-site/**` 或 workflow 本身发生变化时
运行，构建 `docs-site` 并部署生成的网站。推送文档变更前请运行：

```bash
cd docs-site
bun install --frozen-lockfile
bun run build
```

## CI 与发布

GitHub Actions 有意只保留必要步骤：

- **Cross-platform CI**（`.github/workflows/ci.yml`）会在改动 runtime、test、package、script、
  TypeScript 或 workflow 文件的 pull request 与 `main` push 上运行。Bun matrix 覆盖 Linux、
  Windows 和 macOS，执行 install、typecheck、test、privacy scan、release-helper build smoke、GUI
  build 和 `ocx help`。另一个三系统 lane 使用 package 内置 runtime，验证无需单独安装 Bun 也能
  完成 npm global install。
- **Release**（`.github/workflows/release.yml`）只能手动运行。它不是第二套完整 CI；dry-run 或
  publish 前，精确的 release commit（`GITHUB_SHA`）必须已有成功的 Cross-platform CI run。

发布请使用 helper：

```bash
bun run release <version>           # commit/push 版本 bump；publish workflow 默认 dry-run
bun run release <version> --publish # 确认 CI-gated dry-run 后真正 publish
bun run release:watch               # 观察最新的 Release workflow run
```

## 约定

- **仅使用 ES Modules**（`import`/`export`）、TypeScript 和 `strict` mode。保持
  `bun x tsc --noEmit` 无报错。
- **每个文件最多约 500 行** —— 按职责拆分。`web-search/` 和 `vision/` sidecar 是很好的例子：
  小而专注的 module 位于单一 `index.ts` 之后。
- **在边界处理异步错误** —— sidecar 不会把异常抛进请求路径，而会降级成合适的 marker。
- **Structure SOT** —— 当前维护者不变量放在 `structure/`；公开用户流程放在 `docs-site/`；
  历史调查/诊断记录放在 `docs/`。
- **保留 export** —— 其他 module 可能依赖它们。

## 向目录中添加 provider

所有 provider picker 与 seed 都来自 canonical registry（`src/providers/registry.ts`）：

```ts
{
  id: "my-provider",
  label: "My Provider",
  baseUrl: "https://api.example.com/v1",
  adapter: "openai-chat",
  authKind: "key",
  dashboardUrl: "https://example.com/keys",
  models: ["model-a", "model-b"],
  defaultModel: "model-a",
  noVisionModels: ["model-a"],   // text-only models → vision sidecar describes images
},
```

`src/providers/derive.ts` 会把该条目提供给 `ocx init`、`ocx provider`、仪表盘 preset、API-key
登录和 OAuth config seed。`enrichProviderFromCatalog()` 会把模型 metadata 与 capability 分类复制到
保存的 provider 配置。OAuth protocol 实现仍位于 `src/oauth/`；只有 registry metadata 并不会
自动形成 OAuth flow。

## 添加 adapter

在 `src/adapters/` 中实现 `ProviderAdapter`（参见
[Adapters](/zh-cn/reference/adapters/)），在 `src/server/adapter-resolve.ts` 注册其名称，
并把输出桥接成内部 `AdapterEvent`。图像处理请复用 `image.ts`；普通 streaming/tool call 以
`openai-chat.ts` 为参考。只有 adapter 自己负责 transport retry 时才使用 `fetchResponse`；Cursor
这类真正的双向 transport 应使用 `runTurn`。在 `tests/` 中添加聚焦测试；如果 factory 属于 public
package API，还要从 `src/index.ts` export。

## 在声称完成前先验证

先运行能证明改动的最小命令：类型检查用 `bun run typecheck`，行为检查用聚焦的
`bun test tests/<name>.test.ts` 或 runtime probe，然后再执行适合影响范围的更宽 gate。
opencodex 倾向于小而可验证的 commit，而不是大批量改动。
