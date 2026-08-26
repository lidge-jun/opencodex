# 070 — Cancel unconsumed response bodies on retry/failure

## Files

### NEW: src/lib/dispose-response-body.ts
```ts
export async function disposeResponseBody(
  response: Response,
  reason: unknown,
): Promise<void> {
  try {
    await response.body?.cancel(reason);
  } catch {
    // disposal must not replace the original failure
  }
}
```

### MODIFY: Multiple files with fetch error paths
Audit targets (30+ fetch sites):
- src/oauth/*.ts — 401/403 auth refresh
- src/providers/quota.ts — 429 rotation, balance checks
- src/adapters/mimo-free.ts — 5xx retry
- src/update/job.ts — healthz probe
- src/images/xai-client.ts — image sidecar
- src/cli/debug.ts, src/cli/claude.ts — CLI probes
- src/claude/gateway-cache.ts — model cache

Pattern: after `if (!res.ok)` or catch block, call disposeResponseBody before throw/return.

