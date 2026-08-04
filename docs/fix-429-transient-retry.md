# 修复 routed 模型路径 429 限流重试缺失

## 问题描述

在 Codex Desktop 中使用 `tencent/deepseek-v4-pro` 模型时，频繁报错：

```
exceeded retry limit, last status: 429 Too Many Requests
```

但同一个 API Key 在 Claude CLI 中使用完全正常，不会触发 429 报错。

## 根因分析

### 架构差异

Codex Desktop 和 Claude CLI 使用了**两个不同的本地代理**：

```
Codex Desktop → opencodex (127.0.0.1:10100) → DeepSeek API  ← 429！
Claude CLI    → cc-switch  (127.0.0.1:15721) → DeepSeek API  ← 正常
```

- **Claude CLI** 使用 `cc-switch`（`/Applications/CC Switch.app`），对 429 有成熟的反压和退避机制
- **Codex Desktop** 使用 `opencodex`（`@bitkyc08/opencodex`），对 429 的处理存在漏洞

### opencodex 的 429 处理缺陷

opencodex 中，请求路径分为两类：

| 路径 | 使用的重试函数 | 重试范围 |
|------|---------------|---------|
| **passthrough**（ChatGPT 后端） | `fetchWithTransientRetry` | TCP 连接错误 + 500/502/503/504/520/521/522 |
| **routed**（DeepSeek 等非 OpenAI 模型） | `fetchWithResetRetry` | **仅 TCP 连接错误**（ECONNRESET/EPIPE） |

`fetchWithResetRetry` 只重试 TCP 层面的连接断开，**不重试 HTTP 层面的错误状态码**。当上游返回 429 时，它直接透传给 Codex Desktop。

虽然请求返回后有一段 recovery loop 尝试处理 429：

```typescript
// core.ts 原有逻辑
while (upstreamResponse.status === 429 && hasKeyPoolFailover(route.provider)) {
  const rotated = rotateProviderTransportOn429(config, route.providerName, { ... });
  if (!rotated) break;  // 单 Key 配置直接退出
  // ...
}
```

但 `hasKeyPoolFailover` 依赖多 Key 池配置，**单 Key 场景下直接返回 false**，429 原样返回给 Codex Desktop。Codex Desktop 收到 429 后自行重试，多次失败后报 `exceeded retry limit`。

### 为什么 passthrough 路径没问题

passthrough 路径（ChatGPT 后端）使用的是 `fetchWithTransientRetry`，在收到 transient 状态码时会自动退避重试：

```typescript
// core.ts passthrough 路径（已有正确实现）
upstreamResponse = await fetchWithTransientRetry(
  recovery => {
    noteAttemptSend(logCtx.activeAttempt, passthroughEstimate, recovery);
    return fetchWithHeaderTimeout(request.url, ...);
  },
  { abortSignal: upstream.signal, label: safeHostLabel(request.url) },
);
```

## 修复方案

将 routed 模型路径的请求也纳入 `fetchWithTransientRetry` 保护，同时把 429 加入 transient 状态码列表。

### 修改 1：`src/lib/upstream-retry.ts`

在 `isTransientUpstreamStatus` 中增加 429：

```diff
 export function isTransientUpstreamStatus(status: number): boolean {
-  return status === 500 || status === 502 || status === 503 || status === 504
+  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504
     || status === 520 || status === 521 || status === 522;
 }
```

### 修改 2：`src/server/responses/core.ts`

将 routed 路径（主请求 + continuation/web-search 请求）的 `fetchWithResetRetry` 替换为 `fetchWithTransientRetry`：

```diff
- upstreamResponse = await fetchWithResetRetry(
+ upstreamResponse = await fetchWithTransientRetry(
     recovery => {
       noteAttemptSend(logCtx.activeAttempt, inputTokenEstimate, recovery);
       return fetchWithHeaderTimeout(request.url, ...);
     },
     { abortSignal: upstream.signal, label: safeHostLabel(request.url) },
   );
```

共两处调用点（主请求 + web-search continuation 请求）。

### 重试参数

| 参数 | 值 | 说明 |
|------|-----|------|
| 最大重试次数 | 3（1 次初始 + 2 次重试） | `TRANSIENT_RETRY_MAX_ATTEMPTS` |
| 基础退避延迟 | 400ms | `TRANSIENT_RETRY_BASE_DELAY_MS` |
| 最大退避延迟 | 5,000ms | `TRANSIENT_RETRY_MAX_DELAY_MS` |
| 慢请求预算 | 15,000ms | `TRANSIENT_RETRY_SLOW_ATTEMPT_MS` |
| Retry-After | 自动读取响应头 | 尊重上游返回的等待时间 |

## 影响范围

- **passthrough 路径**（ChatGPT 后端）：增加 429 重试，行为更健壮
- **routed 路径**（DeepSeek / 所有非 OpenAI 模型）：从"不重试 HTTP 错误"变为"重试 transient 错误（含 429）"
- **其他 429 处理**：`hasKeyPoolFailover` 的多 Key 轮转逻辑保持不变，作为 `fetchWithTransientRetry` 耗尽后的第二层防护

## 验证方法

1. 在 Codex Desktop 中使用 `deepseek-v4-pro` 进行正常对话
2. 观察是否还会出现 `exceeded retry limit, last status: 429` 错误
3. 在 opencodex 日志中，如果发生 429 重试，会看到类似日志：
   ```
   [upstream-retry] transient 429 (api.deepseek.com) — retrying (2/3)
   ```