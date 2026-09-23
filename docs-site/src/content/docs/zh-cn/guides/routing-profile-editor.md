---
title: 路由配置文件编辑器
description: 在 OpenCodex 仪表盘中创建、编辑、验证、试运行和删除路由策略配置文件。
---

OpenCodex 仪表盘中的 **Models → Routing** 标签页可以管理 `config.routingProfiles`，无须手动编辑 `config.json`。

## 创建配置文件

1. 在仪表盘中打开 **Routing**。
2. 选择 **Create profile**。
3. 输入 `id`。规范模型 id 为 `policy/<id>`。
4. 添加一个或多个明确指定的提供商/模型候选项。
5. 按需配置要求、评分权重、成本上限（`maxEstimatedCostUsd`，可选 `onUnknownCost`）以及未知证据的处理方式。
6. 保存配置文件。

配置文件 id 创建后不可更改。若要使用其他 id，请创建新配置文件，并在更新调用方后删除旧配置文件。

## 验证与持久化

仪表盘将与 `config.routingProfiles` 相同的配置文件对象发送给管理 API。服务器在写入前验证完整的候选配置：

- id 和别名必须符合路由配置文件的命名与冲突规则；
- 每个候选提供商都必须存在且已启用；
- 不允许重复的候选项；
- 数值限制和要求必须在支持的范围内；
- 至少一个优化权重必须大于零。

保存成功后，配置文件通过常规配置写入器持久化，实时状态得到协调，模型目录也会刷新。验证失败时，原配置保持不变，错误会显示在编辑器中。

配置 `limits.maxEstimatedCostUsd` 后，`limits.onUnknownCost` 默认为 `"allow"`：成本估算未知时，不会因这一上限而排除候选项；试运行和实时路由决策跟踪会标记 `cost.capOutcome: "unknown-allowed"`，让运维人员知道上限未经证实。如果上限必须采用封闭式失败策略，请设为 `"exclude"`（`cost-limit-unknown`，并标记 `cost.capOutcome: "unknown-excluded"`）。单独配置 `onUnknownCost` 不起作用，也不会产生上限结果。这与 `unknownEvidence.cost` 分开处理；后者仍可独立排除未知价格或对其施加惩罚。

## 试运行已保存的配置文件

候选能力取自应用注册表覆盖后的有效提供商配置。因此，本地性要求（`localOnly` 和 `remoteAllowed`）使用有效的上游地址。如果无法判断该地址的性质，则由配置文件的 `unknownEvidence.capability` 设置决定候选项是否合格。无法解析的无效提供商配置始终以 `route-unavailable` 排除，即使允许未知能力也是如此。缺失或禁用的提供商也会在评分前以 `route-unavailable` 排除。

选择一个已保存的配置文件，使用 **Dry-run evaluation** 添加上下文窗口大小、工具使用、图像输入或结构化输出等请求证据。试运行会评估资格与评分，但不会向上游发送模型请求。

试运行不会使用尚未保存的编辑内容。请先保存配置文件，确保显示的修订版本与评估使用同一配置。

## 管理 API

编辑器使用以下端点：

- `GET /api/routing-profiles` 列出规范化的配置文件及其修订版本。
- `PUT /api/routing-profiles` 创建或更新一个配置文件。发送 `mode: "create"` 或 `mode: "update"`；创建模式拒绝覆盖已有 id。
- `DELETE /api/routing-profiles?id=<id>` 删除一个配置文件。
- `POST /api/routing-profiles/dry-run` 评估已保存的配置文件，但不向上游分发请求。

保存请求示例：

```json
{
  "id": "fast",
  "mode": "create",
  "profile": {
    "alias": "ocx/fast",
    "candidates": [
      { "provider": "anthropic", "model": "claude-sonnet-5" },
      { "provider": "openai", "model": "gpt-5.6" }
    ],
    "require": { "tools": true, "minContextWindow": 128000 },
    "optimize": { "latency": 0.55, "health": 0.25, "cost": 0.1, "quota": 0.1 },
    "limits": { "maxEstimatedCostUsd": 0.5, "onUnknownCost": "allow" },
    "unknownEvidence": {
      "capability": "exclude",
      "health": "penalize",
      "quota": "penalize",
      "cost": "penalize"
    }
  }
}
```
