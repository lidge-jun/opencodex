# 003 — Protocol / transport compare

Helmholtz + Pasteur. senpi SHA `a5eed44536f3024c5740dc3dfff4ffe0bb08b717`.

## Same

Both speak `agent.v1.AgentService/Run` over HTTP/2 Connect (`application/connect+proto`, `connect-protocol-version: 1`, Bearer, `x-ghost-mode: true`, `x-cursor-client-type: cli`). Both write a 5s `clientHeartbeat`. Both rebuild `rootPromptMessagesJson` as the model prompt and treat `turns[]` as display metadata. Both implement blob KV `getBlobArgs`/`setBlobArgs`.

OpenCodex:

```90:92:src/adapters/cursor/live-transport.ts
const CURSOR_RUN_PATH = "/agent.v1.AgentService/Run";
const CURSOR_CLIENT_VERSION = "cli-2026.07.08-0c04a8a";
const HEARTBEAT_MS = 5_000;
```

senpi: [cursor-agent.ts L522-547, L746-747](https://github.com/code-yeongyu/senpi/blob/a5eed44536f3024c5740dc3dfff4ffe0bb08b717/packages/ai/src/api/cursor-agent.ts#L522-L547).

## Different

| Topic | OpenCodex | senpi |
|---|---|---|
| Client version | `cli-2026.07.08-0c04a8a` | `cli-2026.07.23-e383d2b` |
| HTTP/1 | `RunSSE` + `BidiAppend` (`http1-bidi.ts:10-11`) | HTTP/2-only; ALPN strip is fatal |
| Session header | sends `x-session-id` | does not |
| Completion | `turnEnded` finalizes mapper; transport waits for EOF; may synthesize `done` | `turnEnded` closes client HTTP/2 after ≤5s exec drain |
| Mid-turn health | 30s first-frame only; then 300s bridge stall | 30s silence / 90s heartbeat-only inside the adapter |
| Abort owner | `failAndClear` + `createTerminalSettler` | `settleH2` |
| Exec heartbeat | none (types exist) | 3s per-exec heartbeat |
| Blob store | TTL / 4096 / 64MiB | unbounded per-conversation Map |

## Transfer suspicion

High: close HTTP/2 on `turnEnded` (frozen turns until bridge 300s). Medium: heartbeat-only stall fail. Low: bump client version without a live probe. Do not copy senpi's unbounded blob Map. Keep OpenCodex HTTP/1 fallback.

