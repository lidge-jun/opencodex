---
title: opencode
description: 在 opencode 中使用任意路由模型 - opencodex 会注入一个运行时 provider 块，并且不会改动你自己的 opencode 配置。
---

opencode 从合并后的 JSON 配置层读取 provider，而不是从环境变量读取，所以没有类似 `ANTHROPIC_BASE_URL` 这样的注入位置。`ocx opencode` 正是为此补桥：它会确保代理正在运行，根据可见目录构建 provider 块，并通过 OpenCode 的内联运行时层（`OPENCODE_CONFIG_CONTENT`）注入进去。

## 快速开始

```bash
ocx opencode
```

这会确保代理正在运行，并只为该进程注入生成的 `provider.opencodex` block 来启动 opencode。额外参数会原样透传：`ocx opencode run "hello"`。

路由模型会在选择器里作为 `opencodex` provider 出现：

```text
opencodex/kiro/glm-5
opencodex/gpt-5.6-sol      # native slugs stay unprefixed
```

## 你的配置绝不会被修改

启动器不会复制或重写 `~/.config/opencode/opencode.json`、项目中的 `opencode.json` / `opencode.jsonc`，也不会处理任何其他磁盘上的配置层。它可能会读取全局或项目配置，以检测是否存在 `provider.opencodex` 覆盖；而你现有的 providers、agents、keybinds、MCP 条目以及相对路径的 `{file:…}` 引用，都会继续从它们原本的文件中解析。

仅在这次启动中，opencodex 会通过 OpenCode 的内联运行时层添加生成的 `provider.opencodex` block。该层会在全局/自定义/项目配置之后合并，并且只会对这个子进程覆盖冲突的键。

| Layer | `ocx opencode` 下的行为 |
| --- | --- |
| Global / custom / project config | 原样保留在磁盘上，不做任何改动 |
| Inline runtime (`OPENCODE_CONFIG_CONTENT`) | 只接收生成的 `provider.opencodex` block |
| Relative `{file:…}` paths | 仍然按最初定义它们的配置文件来解析 |

如果全局或项目配置里也定义了 `provider.opencodex`，启动器会打印一条提示信息：`ocx opencode` 的运行时层会在这次启动中覆盖它。

## 把这个 block 放进你自己的配置里

`ocx opencode` 只会在单次启动中注入 provider block，这意味着普通的 `opencode` 仍然不知道代理的存在。若你希望在普通 `opencode` 中也能使用路由模型，或者希望编辑器扩展不经过启动器也能使用它们，`ocx export` 会打印同样的 provider block，供你合并到自己的配置中：

```bash
ocx export --client opencode
```

代理必须正在运行。该命令会打印配置、规范目标路径（`~/.config/opencode/opencode.json`，如果设置了 `XDG_CONFIG_HOME` 则位于其下）、合并警告，以及环境变量导出行。它绝不会修改那个文件 - 上面的说明依然成立，而把这个 block 挪进你的配置是你明确做出的动作。

:::caution[合并，不要替换]
请把 `provider.opencodex` block 合并进你现有的配置。用导出的文件直接替换整个配置会破坏你其他的 providers、agents、keybinds 和 MCP 条目。`ocx export --out` 会明确拒绝覆盖已存在的文件，原因正是如此，因此请把 `--out` 指向一个临时路径，然后把 block 复制过去：

```bash
ocx export --client opencode --out ~/opencodex-opencode.json
```
:::

与启动器的运行时 block 不同，合并后的 block 是一个静态快照：它不会跟随你的目录变化。每当你新增 provider 或调整 model 可见性后，都要重新运行 `ocx export`。

合并完成后，在启动 opencode 之前导出 admission key - 除非代理绑定在 loopback 上，那种情况下不需要：

```bash
export OPENCODEX_OPENCODE_API_KEY=<your key>
```

## admission key 不会写入磁盘

当代理需要 API key 时，内联运行时配置携带的是 opencode 的 `{env:…}` 引用，而不是 secret。loopback 绑定会把这个引用作为 `apiKey` 使用；非 loopback 绑定只会通过 `x-opencodex-api-key` 发送它，从而让代理的 admission 与任何上游 `Authorization` header 保持分离。

loopback 示例：

```json
"options": {
  "baseURL": "http://127.0.0.1:10100/v1",
  "apiKey": "{env:OPENCODEX_OPENCODE_API_KEY}"
}
```

非 loopback 示例：

```json
"options": {
  "baseURL": "http://192.168.1.10:10100/v1",
  "headers": {
    "x-opencodex-api-key": "{env:OPENCODEX_OPENCODE_API_KEY}"
  }
}
```

真实值只会通过子进程环境传递。`OPENCODEX_API_AUTH_TOKEN` 优先，然后是加固后的服务 token 文件，最后才是配置的 API key - 而非 loopback 绑定正是需要这个 API key。

loopback 绑定（`127.0.0.1`，默认值）不会进行任何认证，所以 `{env:…}` 引用是惰性的，你可以不设置该变量。它只在 `hostname` 超出 loopback 范围时才有意义；参见 [Remote access](/reference/configuration/#remote-access)。这个 admission key 是 opencodex 自己的，与在 [Providers](/guides/providers/) 下配置的上游 provider keys 无关。

## 回滚

无需撤销 - `~/.opencodex` 下不会写入任何生成的配置文件。直接运行普通的 `opencode` 即可，它会像之前一样读取你自己的配置。

## 模型限制

只有当目录报告了权威的 context window 时，才会写入 `limit.context`；如果没有报告，整个 `limit` block 会被省略，opencode 则继续使用自己的默认值。

opencode 的 schema 会拒绝一个包含 `context` 但不包含 `output` 的 `limit` block，而目录没有按模型粒度提供权威的 output 字段，因此会同时写入一个 `32000` 的 `output` budget，并将其钳制到 context window 以内，确保不会给小 context 模型分配 `output > context`。这个数值只是为了满足 schema - 它并不是对任何具体模型真实上限的声明。

`opencodex` provider block 会在每次启动时重新生成，所以在其中做的逐模型调整不会保留。若要自定义条目，请把它们放到你自己的 provider key 下。

## 要求

opencode 必须已安装并在 `PATH` 中：

```bash
npm install -g opencode-ai
```
