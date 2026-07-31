# 040 — WP4: ocx doctor memory/runtime section

Depends: WP3 (/api/system/memory exists). Consumes 001 §5.

WP4-P stale-check (tree aff83eb4): doctor is console.log-sectioned runDoctor()
at doctor.ts:322 (sections: Paths, restart safety, proxy env, WHAM, history
migration, project configs, WSL, Hints) — memory section slots after "Running
proxy process proxy env". Port discovery: readRuntimePort() (config.ts:919)
returns the live {pid,port} state or null. Token: OPENCODEX_API_AUTH_TOKEN env
or loadServiceTokenFromFile(process.env) (lib/service-secrets.ts:15 — the same
source handleStart uses at cli/index.ts:134). Endpoint responds with
uptimeSeconds (not uptimeMs) and eagerRelay null off-win32 (WP3 landed shape).

## MODIFY src/cli/doctor.ts

NEW exported helper (testable, IO-injected):

Audit round dispositions (5 blockers folded):

```ts
export type ServiceMemoryReport =
  | { status: "ok"; data: {
      pid: number; bunVersion: string; platform: string; rss: number;
      heapUsed: number; jscHeap: { heapSize: number } | null;          // wire sends explicit null (B3)
      streamMode: string;
      eagerRelay: { useEagerRelay: boolean; reason: string } | null;   // null off-win32 (B3)
      watchdog: { warnThresholdBytes: number; lastWarnAt: number | null; samples?: unknown[] } | null; // B3
    } }
  | { status: "unauthorized" }    // HTTP 401 — reachable but rejected (B5)
  | { status: "unreachable"; error: string }; // fetch threw / refused

export async function fetchServiceMemory(
  host: string, port: number, token: string | null,   // host via gracefulStopHost(runtime.hostname) (B2)
  fetchImpl: typeof fetch = fetch,
): Promise<ServiceMemoryReport>;
// AbortSignal.timeout(2000) on the fetch (B4, stopProxyGracefully precedent).
```

Port/pid discovery (B1): `readPid()` FIRST (liveness: kill(pid,0) +
isLikelyOcxStartProcess, config.ts:899), then `readRuntimePort(pid)` pid-scoped
(status.ts:119 precedent) — readRuntimePort alone does NO liveness check and
can serve a stale record. Token: env OPENCODEX_API_AUTH_TOKEN then
loadServiceTokenFromFile (superset of the stopProxyGracefully precedent,
process-control.ts:63; tokenless succeeds on loopback binds).

runDoctor() (doctor.ts:322) gains a "Memory / runtime" section:

- Doctor-process identity line: `doctor Bun: <Bun.version> (this is NOT the
  service process)` — F8/A5: never present doctor's own runtime as the
  service's.
- Service identity via fetchServiceMemory (reuses the same port/token
  resolution the CLI already performs — cli/index.ts:133 loads the service
  token): prints service pid, Bun version, platform, RSS (MB), heapUsed (MB),
  jscHeap size, streamMode + eagerRelay decision/reason, watchdog threshold +
  last warn.
- Interpretation lines — crisp rule (audit Q5): threshold =
  watchdog?.warnThresholdBytes ?? 4GiB; jsShare = max(heapUsed,
  jscHeap?.heapSize ?? 0) / rss. rss < threshold → "memory usage looks normal";
  rss >= threshold && jsShare < 0.25 → native-side line (Bun runtime
  buffers/handles, docs link); jsShare >= 0.5 → JS-side line (report an
  opencodex bug); else indeterminate line (capture two samples over time).
- OPENCODEX_BUN_PATH guidance gating (B5): platform === "win32" AND
  eagerRelay?.reason === "auto-known-bad" (server-computed, survives bundle
  bumps; no hardcoded "1.3.14" in doctor). Wording is VERSION-claiming, never
  binary-claiming — the endpoint cannot distinguish bundled vs override
  binaries of the same version: "service is running Bun <v> on Windows — a
  version affected by the upstream memory issue…".
- Error split (B5): status "unauthorized" → "proxy reachable but rejected the
  request (set OPENCODEX_BUN_PATH? no — set OPENCODEX_API_AUTH_TOKEN)";
  status "unreachable" → "proxy not reachable (not running?)". No fake data.
- Testability: exported formatServiceMemoryLines(report): string[] renders the
  section; runDoctor prints those lines (audit Q4 advisory — no console
  capture needed).

## Activation scenarios

- Injected fetchImpl returning fixture JSON → section renders all fields.
- fetchImpl rejecting → unreachable line, exit code unchanged (doctor stays
  observe-only, never fails the command on memory section errors).
- win32+1.3.14 fixture → override guidance printed; darwin fixture → not printed.

## TESTS

- EXTEND tests/doctor.test.ts (probeWham fetchImpl-injection precedent,
  doctor.test.ts:259): fetchServiceMemory ok/401/unreachable/malformed JSON
  (each with AbortSignal-tolerant fake fetch); formatServiceMemoryLines cases:
  identity labels, normal/native/JS/indeterminate interpretation branches,
  guidance gating (win32+auto-known-bad prints, darwin or fixed runtime does
  not), unauthorized/unreachable lines.

## Verification (C)

- bun x tsc --noEmit; bun test tests/doctor.test.ts; bun run test;
  bun run privacy:scan (no tokens/account ids printed — RSS numbers only).
