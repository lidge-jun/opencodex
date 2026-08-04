# 030 — WP3: RSS watchdog (warn-only) + authed /api/system/memory endpoint

Depends: WP1 (reports gate decision + streamMode). No core.ts dependency.

WP3-P stale-check (tree e0c7caba): management route chain at
management-api.ts:125-131 (`handleConfigRoutes(ctx) ?? ...`) — new
`handleSystemRoutes(ctx)` joins the chain; ManagementContext shape at
management/context.ts:15-22 (req/url/config/deps + best-effort helpers);
server startup surface: startServer at index.ts:156, Bun.serve at :201 —
watchdog start hooks in startServer after config load, stop rides
process-level lifecycle (watchdog timer is unref'd so no explicit stop wiring
is strictly required for process exit; expose stop() for tests).
decideEagerRelay + config.streamMode available from WP1/WP2 for the endpoint
payload. /healthz at index.ts:239 stays untouched.

## NEW src/server/memory-watchdog.ts

```ts
export type MemorySample = {
  at: number;             // epoch ms
  rss: number;            // bytes
  heapUsed: number;       // bytes (process.memoryUsage)
  heapTotal: number;
};

export type MemoryWatchdogState = {
  samples: MemorySample[];          // bounded ring, default 360 (≈6h at 60s)
  warnThresholdBytes: number;       // default 4 GiB
  lastWarnAt: number | null;
};

export function startMemoryWatchdog(opts?: {
  intervalMs?: number;              // default 60_000
  warnThresholdBytes?: number;      // default 4 * 1024**3
  ringSize?: number;                // default 360
  now?: () => number;               // injectable
  sample?: () => MemorySample;      // injectable for tests
  warn?: (msg: string) => void;     // default console.warn
}): { stop(): void; snapshot(): MemoryWatchdogState };
```

- Warn-only: crossing threshold logs ONE rate-limited line (min 30 min between
  warns) naming rss, threshold, and the docs-site troubleshooting URL. NO
  restart (F4 deferral — stated in 050 docs). The warn line NEVER interpolates
  paths, hostnames, or tokens (audit advisory).
- timer.unref() so it never holds the process open.
- Sampling is scalar-only (numbers) — privacy:scan safe by construction.
- Audit blocker 1 (plumbing): memory-watchdog.ts exports a module-level
  singleton accessor `getActiveMemoryWatchdog(): { snapshot(): ... } | null` —
  startMemoryWatchdog registers the active instance; system-routes reads it
  through the accessor (no ManagementContext change needed).
- Audit blocker 2 (lifecycle): startMemoryWatchdog is IDEMPOTENT — if an
  active instance exists it is stopped and replaced (repeated startServer(0)
  in tests never accumulates intervals). Stop contract: process-level only
  (unref'd timer); drainAndShutdown is NOT modified. The returned handle's
  stop() clears the singleton (tests use it).

Wire-up: startMemoryWatchdog() called in startServer (index.ts:156 block,
before Bun.serve) — service path included. No drainAndShutdown hook (see
blocker-2 disposition above).

## NEW route in management API: GET /api/system/memory

NEW src/server/management/system-routes.ts, registered in management-api.ts
next to handleConfigRoutes (:60). Auth: rides the existing /api/* gate
(requireApiAuth "management", index.ts:245) — handler itself does no extra auth,
same as sibling routes. NEVER on /healthz.

Response JSON:
```json
{
  "pid": 123, "bunVersion": "1.3.14", "bunRevision": "…", "platform": "darwin",
  "uptimeMs": 1234, "rss": 123, "heapUsed": 1, "heapTotal": 2,
  "jscHeap": { "heapSize": 1, "heapCapacity": 2, "objectCount": 3 },
  "streamMode": "auto", "eagerRelay": { "useEagerRelay": false, "reason": "auto-known-bad" },
  "watchdog": { "warnThresholdBytes": 4294967296, "lastWarnAt": null, "samples": [] }
}
```
Samples contract (audit blocker 3): the endpoint returns `samples.slice(-60)`;
the full 360-ring stays in-process (snapshot() for tests). jscHeap via dynamic
`await import("bun:jsc")` inside try/catch (audit advisory: matches the
management-api lazy-import pattern; static import is Bun-builtin-safe but
dynamic keeps the graph loadable by non-Bun tooling). Scalar fields only.

## Activation scenarios

- GET /api/system/memory with valid token → 200 with rss>0, bunVersion match.
- Without token on non-loopback → same 401/403 as sibling /api routes.
- Watchdog: injected sampler exceeding threshold → exactly one warn per window;
  below threshold → zero warns; ring never exceeds ringSize.
- /healthz response shape UNCHANGED (regression assert).

## TESTS

- NEW tests/memory-watchdog.test.ts: ring bound, threshold warn rate-limit,
  stop() clears timer (fake timers/injected now).
- NEW/EXTEND management-route test (near existing tests/*management* or
  tests/*config-routes*): endpoint 200 shape + auth parity + /healthz unchanged.

## Verification (C)

- bun x tsc --noEmit; bun test tests/memory-watchdog.test.ts + route test;
  bun run test; bun run privacy:scan (endpoint emits scalars only).
