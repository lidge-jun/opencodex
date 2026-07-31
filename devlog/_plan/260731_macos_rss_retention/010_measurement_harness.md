# Phase 1 — reproducible macOS RSS measurement harness

## Decision

Add an offline, two-process Bun harness under `scripts/`, not `tests/`. It is a
repeatable measurement tool with deliberate multi-minute load and retained evidence,
whereas the test suite is for deterministic pass/fail behavior. `scripts/` already
contains the closest isolated-child runtime-smoke convention
(`scripts/openai-provider-option-runtime-smoke.ts:134-230` and
`scripts/openai-provider-option-runtime-child.ts:1-20`). The actual proxy remains
the code under measurement: the child calls the established in-process server entry
point (`src/server/index.ts:253-256`), while the parent owns the fake upstream,
clients, and sampler. This prevents the generator's buffers and JSONL writes from
being attributed to proxy RSS.

The run directory is `.tmp/macos-rss-retention/<UTC-run-id>/`. `.tmp/` is ignored
by the repository (`.gitignore:21-26`), and therefore no machine-specific series,
paths, or transient run output becomes a tracked artifact. Each run is self-contained
and is intentionally retained for comparison until the operator removes it.

## Proposed diff

```text
NEW scripts/macos-rss-retention-harness.ts
NEW scripts/macos-rss-retention-harness-child.ts
```

No production source, test, config-schema, watchdog, or ignore-file change is part of
this phase. The harness writes a temporary `config.json` only below a fresh
`OPENCODEX_HOME`; this follows the existing isolated-home pattern, which sets a temp
OpenCodex home and restores it after use (`tests/claude-messages-endpoint.test.ts:25-40`)
and separately isolates `CODEX_HOME` (`tests/helpers/isolated-codex-home.ts:10-23`).

`streamMode` is written into the child config so subsequent phases can run the same
workload with every currently declared setting: `auto`, `legacy-tee`, and
`eager-relay` (`src/config.ts:696-703`; `src/lib/bun-stream-caps.ts:24-30`). On
macOS, however, all three currently use the legacy tee shape: the eager decision is
only considered under `process.platform === "win32"`
(`src/server/responses/core.ts:1623-1628`) and the management endpoint consequently
reports `eagerRelay: null` outside Windows (`src/server/management/system-routes.ts:66-86`).
The harness must print that fact rather than falsely labelling a macOS config-only run
as an A/B stream-path comparison. Making macOS select an eager/single-reader path is
Phase 3, not Phase 1.

## `scripts/macos-rss-retention-harness-child.ts`

This is the complete child design. It clears inherited OpenCodex/Codex and proxy
environment variables before setting fixture-only values, matching the prior smoke
child's isolation boundary (`scripts/openai-provider-option-runtime-child.ts:8-20`).
It receives the parent upstream URL and writes the fixture provider config before
`startServer(0)` so the request traverses the real HTTP proxy/adaptor path. The
provider form is the established local-upstream pattern: `Bun.serve` plus a provider
with `baseUrl`, `apiKey`, and `allowPrivateNetwork: true`
(`tests/claude-messages-endpoint.test.ts:46-74`).

```ts
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const [opencodexHome, codexHome, upstreamUrl, streamMode] = Bun.argv.slice(2);
if (!opencodexHome || !codexHome || !upstreamUrl || !streamMode) {
  throw new Error("child requires OPENCODEX_HOME, CODEX_HOME, upstream URL, and stream mode");
}
if (!(["auto", "legacy-tee", "eager-relay"] as const).includes(streamMode as "auto" | "legacy-tee" | "eager-relay")) {
  throw new Error("child stream mode is invalid");
}
const selectedStreamMode = streamMode as "auto" | "legacy-tee" | "eager-relay";

for (const key of Object.keys(process.env)) {
  if (/^(?:OPENAI_|CODEX_|OPENCODEX_)/.test(key) || /^(?:http|https|all)_proxy$/i.test(key)) {
    delete process.env[key];
  }
}
process.env.OPENCODEX_HOME = opencodexHome;
process.env.CODEX_HOME = codexHome;
process.env.OPENCODEX_API_AUTH_TOKEN = "fixture-admission";
process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "fixture-admin";
process.env.NO_PROXY = "127.0.0.1,localhost,::1";
process.env.no_proxy = "127.0.0.1,localhost,::1";
mkdirSync(opencodexHome, { recursive: true, mode: 0o700 });
mkdirSync(codexHome, { recursive: true, mode: 0o700 });

const { saveConfig } = await import("../src/config");
const { startServer } = await import("../src/server");
saveConfig({
  port: 0,
  hostname: "127.0.0.1",
  defaultProvider: "fixture",
  streamMode: selectedStreamMode,
  providers: {
    fixture: {
      adapter: "openai-responses",
      baseUrl: upstreamUrl,
      authMode: "key",
      apiKey: "fixture-upstream-key",
      allowPrivateNetwork: true,
      liveModels: false,
      models: ["fixture-model"],
    },
  },
});

const server = startServer(0);
const port = Number(server.url.port);
process.stdout.write(JSON.stringify({
  type: "ready", pid: process.pid, port, streamMode: selectedStreamMode, bunVersion: Bun.version,
}) + "\n");

await new Promise<void>(resolve => {
  const stop = async () => { await server.stop(true); resolve(); };
  process.once("SIGTERM", () => { void stop(); });
  process.once("SIGINT", () => { void stop(); });
});
```

The fixture uses `openai-responses`: when `responsesPath` is absent, that adapter
posts to `/v1/responses` below the configured base URL
(`src/adapters/openai-responses.ts:908-915`).

## `scripts/macos-rss-retention-harness.ts`

The following is the complete operational structure. Small helpers are deliberately
included rather than left as TODOs, because exact pacing and record shape affect the
result. It uses only Bun and `node:` APIs already used by scripts; no Node server,
external load tool, or live provider is involved.

```ts
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";

type Options = {
  clients: number; eventCount: number; eventBytes: number; eventDelayMs: number;
  clientReadDelayMs: number; sampleMs: number; streamMode: "auto" | "legacy-tee" | "eager-relay";
  settleMs: number; outputDir: string | null;
};
type MemoryPayload = {
  pid: number; bunVersion: string; bunRevision: string; platform: string; uptimeSeconds: number;
  rss: number; heapUsed: number; heapTotal: number; external: number; arrayBuffers: number;
  observedBytes: number; observedMetric: string; jscHeap: { heapSize: number; heapCapacity: number; objectCount: number } | null;
  responseState: { count: number; totalBytes: number; largestBytes: number; oldestAgeMs: number }; streamMode: string;
  eagerRelay: { useEagerRelay: boolean; reason: string } | null; activeTurnCount: number; isDraining: boolean;
};
type Sample = { type: "sample"; at: string; elapsedMs: number; requestMs: number; memory: MemoryPayload };
type RunEvent = { type: "run" | "client"; at: string; elapsedMs: number; [key: string]: unknown };

function integer(name: string, fallback: number, min: number): number {
  const raw = value(name); if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min) throw new Error(`${name} must be an integer >= ${min}`);
  return parsed;
}
function value(name: string): string | undefined {
  const index = Bun.argv.indexOf(name); return index < 0 ? undefined : Bun.argv[index + 1];
}
function options(): Options {
  const streamMode = (value("--stream-mode") ?? "auto") as Options["streamMode"];
  if (!(["auto", "legacy-tee", "eager-relay"] as const).includes(streamMode)) throw new Error("--stream-mode must be auto, legacy-tee, or eager-relay");
  return {
    clients: integer("--clients", 8, 1), eventCount: integer("--events", 1200, 1),
    eventBytes: integer("--event-bytes", 65_536, 128), eventDelayMs: integer("--event-delay-ms", 0, 0),
    clientReadDelayMs: integer("--client-read-delay-ms", 25, 0), sampleMs: integer("--sample-ms", 200, 50),
    streamMode, settleMs: integer("--settle-ms", 30_000, 0), outputDir: value("--output-dir") ?? null,
  };
}
function writeJsonl(path: string, row: Sample | RunEvent): void {
  appendFileSync(path, JSON.stringify(row) + "\n", { mode: 0o600 });
}
function outputRoot(requested: string | null): string {
  const allowed = resolve(import.meta.dir, "..", ".tmp", "macos-rss-retention");
  mkdirSync(allowed, { recursive: true, mode: 0o700 });
  if (!requested) return mkdtempSync(join(allowed, `${new Date().toISOString().replace(/[:.]/g, "-")}-`));
  const resolved = resolve(requested);
  if (resolved !== allowed && !resolved.startsWith(`${allowed}/`)) throw new Error("--output-dir must be below .tmp/macos-rss-retention");
  return resolved;
}
function frame(type: string, payload: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
}
function payloadText(bytes: number, client: string, index: number): string {
  // Padding keeps events large while the event remains a real Responses delta parsed by the inspector.
  return `${client}:${index}:` + "x".repeat(Math.max(0, bytes - client.length - String(index).length - 1));
}
function responseFrames(client: string, count: number, bytes: number): Uint8Array[] {
  const item = { id: `msg_${client}`, type: "message", status: "completed", role: "assistant", content: [] };
  const frames = [frame("response.created", { type: "response.created", response: { id: `resp_${client}`, status: "in_progress", output: [] } })];
  for (let index = 0; index < count; index++) frames.push(frame("response.output_text.delta", {
    type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id,
    delta: payloadText(bytes, client, index),
  }));
  frames.push(frame("response.output_item.done", { type: "response.output_item.done", output_index: 0, item }));
  frames.push(frame("response.completed", { type: "response.completed", response: { id: `resp_${client}`, status: "completed", output: [item] } }));
  frames.push(new TextEncoder().encode("data: [DONE]\n\n"));
  return frames;
}
function startUpstream(config: Options) {
  let serial = 0;
  return Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/responses") return new Response("not found", { status: 404 });
    const frames = responseFrames(String(++serial), config.eventCount, config.eventBytes);
    let index = 0;
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (index === frames.length) { controller.close(); return; }
        controller.enqueue(frames[index++]!);
        if (config.eventDelayMs) await Bun.sleep(config.eventDelayMs);
      },
    }), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  }});
}
async function startProxy(home: string, codexHome: string, upstream: URL, streamMode: string) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "macos-rss-retention-harness-child.ts"), home, codexHome, upstream.toString(), streamMode], { stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader(); let text = "";
  const ready = await Promise.race([ (async () => { for (;;) {
    const chunk = await reader.read(); if (chunk.done) throw new Error("proxy exited before ready");
    text += new TextDecoder().decode(chunk.value, { stream: true }); const lines = text.split("\n"); text = lines.pop() ?? "";
    for (const line of lines) { try { const row = JSON.parse(line); if (row.type === "ready") return row as { port: number }; } catch {} }
  } })(), Bun.sleep(15_000).then(() => { throw new Error("proxy readiness timed out"); }) ]);
  reader.releaseLock(); return { child, port: ready.port };
}
async function sampleOnce(base: string, started: number, path: string): Promise<void> {
  const began = performance.now();
  const response = await fetch(`${base}/api/system/memory`, { headers: { "x-opencodex-api-key": "fixture-admin" } });
  if (!response.ok) throw new Error(`memory sample failed: ${response.status}`);
  writeJsonl(path, { type: "sample", at: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started), requestMs: Math.round(performance.now() - began), memory: await response.json() as MemoryPayload });
}
async function sampleLoop(base: string, started: number, path: string, intervalMs: number, stop: Promise<void>): Promise<void> {
  let done = false; void stop.then(() => { done = true; });
  while (!done) {
    const began = performance.now();
    await sampleOnce(base, started, path);
    await Bun.sleep(Math.max(0, intervalMs - (performance.now() - began)));
  }
}
async function runClient(base: string, index: number, delayMs: number, started: number, path: string): Promise<void> {
  const response = await fetch(`${base}/v1/responses`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture-admission" }, body: JSON.stringify({ model: "fixture/fixture-model", input: `fixture-${index}`, stream: true }) });
  if (!response.ok || !response.body) throw new Error(`client ${index}: ${response.status}`);
  const reader = response.body.getReader(); let bytes = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (delayMs) await Bun.sleep(delayMs); }
  writeJsonl(path, { type: "client", at: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started), client: index, bytes, readDelayMs: delayMs, outcome: "completed" });
}
async function main(): Promise<void> {
  const config = options(); const started = performance.now();
  const root = outputRoot(config.outputDir);
  mkdirSync(root, { recursive: true, mode: 0o700 }); const series = join(root, "series.jsonl");
  const upstream = startUpstream(config); const proxy = await startProxy(join(root, "opencodex"), join(root, "codex"), upstream.url, config.streamMode);
  const base = `http://127.0.0.1:${proxy.port}`; let resolveStop!: () => void; const stop = new Promise<void>(resolve => { resolveStop = resolve; });
  writeJsonl(series, { type: "run", at: new Date().toISOString(), elapsedMs: 0, phase: "started", config, proxyPort: proxy.port, upstreamPort: upstream.port });
  await sampleOnce(base, started, series);
  const sampler = sampleLoop(base, started, series, config.sampleMs, stop);
  try { await Promise.all(Array.from({ length: config.clients }, (_, i) => runClient(base, i + 1, config.clientReadDelayMs, started, series))); await Bun.sleep(config.settleMs); }
  finally { resolveStop(); await sampler; upstream.stop(true); if (proxy.child.exitCode === null) proxy.child.kill("SIGTERM"); await proxy.child.exited; }
  console.log(JSON.stringify({ verdict: "PASS", series, streamMode: config.streamMode, clients: config.clients, expectedPayloadBytes: config.clients * config.eventCount * config.eventBytes }));
}
await main();
```

### Why these frames and pacing are required

The fake upstream emits the actual Responses SSE lifecycle: `response.created`, many
`response.output_text.delta` frames, `response.output_item.done`,
`response.completed`, then `[DONE]`. It therefore makes the inspector parse
`response.output_text.delta` through JSON (`src/server/relay.ts:115-125`), parse each
payload again when completed-response capture is active (`src/server/relay.ts:468-499`),
and exercise the output-item reconstruction path (`src/server/relay.ts:476-497`). It
does not use a one-shot text response or an artificial non-JSON stream.

`--event-bytes` changes the delta's JSON string size, `--events` changes the number
of parsed frames, and `--event-delay-ms` controls upstream production pacing. The
default `8 × 1200 × 65536` supplies roughly 600 MiB of payload before SSE/JSON
overhead, enough to expose a material queue without requiring a multi-GiB default.

Slow mode is not a fake upstream pause: every client reads one `ReadableStream` chunk,
then awaits `Bun.sleep(--client-read-delay-ms)` before the next read. This holds back
the proxy's client-facing consumer while the tee's inspection consumer continues to
pull. That is the meaningful rate mismatch for the current topology, which calls
`upstreamResponse.body.tee()` (`src/server/responses/core.ts:1686`) and consumes the
other branch in the background (`src/server/responses/core.ts:1715-1733`). `0` is the
fast-client control.

The sampler polls the management endpoint every 200 ms by default—300 times finer
than the production watchdog's 60,000 ms interval and independent of its 360-entry
ring (`src/server/memory-watchdog.ts:53-56`). The endpoint reports scalar
`rss`, heap, `external`, `arrayBuffers`, `observedBytes`, JSC heap, response-state
metrics, selected stream mode, and active turns (`src/server/management/system-routes.ts:67-86`).
Each sampling request sends the documented management token header; the child sets an
environment token, which is the first token source in `configuredAdminToken`
(`src/lib/admin-secrets.ts:23-24`).

Every JSONL `sample` record has this exact schema:

```json
{"type":"sample","at":"2026-07-31T00:00:00.000Z","elapsedMs":200,"requestMs":3,"memory":{"pid":123,"bunVersion":"1.3.14","bunRevision":"...","platform":"darwin","uptimeSeconds":1.2,"rss":0,"heapUsed":0,"heapTotal":0,"external":0,"arrayBuffers":0,"observedBytes":0,"observedMetric":"rss","jscHeap":{"heapSize":0,"heapCapacity":0,"objectCount":0},"responseState":{"count":0,"totalBytes":0,"largestBytes":0,"oldestAgeMs":0},"streamMode":"auto","eagerRelay":null,"activeTurnCount":8,"isDraining":false}}
```

`requestMs` makes polling overhead visible; samples with an implausibly high request
time are not silently treated as fine-grained evidence. `run` records persist the
effective input config and ports, and `client` records persist per-client completion,
bytes, and delay. None contains request text, provider credentials, account IDs, or
paths outside the operator-selected output directory.

## Invocation and output contract

Run from repository root after implementation:

```bash
bun scripts/macos-rss-retention-harness.ts \
  --stream-mode legacy-tee \
  --clients 8 \
  --events 1200 \
  --event-bytes 65536 \
  --event-delay-ms 0 \
  --client-read-delay-ms 25 \
  --sample-ms 200 \
  --settle-ms 30000
```

Defaults are exactly those values, except `--stream-mode auto`. `--output-dir <path>`
is optional for an explicit ignored destination; if provided, it must be an existing
or newly created directory under `.tmp/` (the implementation must reject a path
outside `.tmp/` before writing). The process prints one final JSON line with `verdict`,
the absolute `series` path, selected mode, client count, and expected payload bytes.
It exits non-zero for invalid flags, readiness timeout, non-200 memory endpoint, a
client failure, or a child exit before cleanup.

For Phase 2/3 A/B use, repeat the same flags and change only `--stream-mode` (and
record the reported `memory.streamMode`/`memory.eagerRelay`). On current macOS,
`auto`, `legacy-tee`, and `eager-relay` are configuration coverage only—not distinct
runtime shapes—so the baseline comparison is **slow (`25`) versus fast (`0`) client
rate**. Once Phase 3 makes a macOS path selectable, the same command becomes the
stream-path A/B harness without a workload rewrite.

## Phase-1 acceptance criteria

1. A default slow run completes all eight clients, creates one JSONL series below
   `.tmp/macos-rss-retention/`, and has samples spanning at least 30 seconds after
   all clients finish; `activeTurnCount` reaches at least 8 during the run and returns
   to 0 before the final sample.
2. On macOS arm64 with Bun 1.3.14, three independent default slow runs show both a
   transient `external` or `arrayBuffers` peak of at least **128 MiB above the first
   pre-load sample** and an RSS peak of at least **256 MiB above it**. The run report
   must retain the full time series, not merely a peak.
3. In at least two of those three runs, final RSS after the 30-second settle remains
   at least **128 MiB above baseline** while `external` has fallen below 25% of its
   run peak. This is the observable allocator-retention signature required before a
   later phase can claim improvement.
4. A fast-client control with identical options except
   `--client-read-delay-ms 0` produces a lower peak `external`/`arrayBuffers` than
   the median slow peak. If host variation prevents that relationship, increase only
   `--events` (first to 2400) and retain both series; do not change production code or
   retrospectively discard contrary runs.

These are reproduction gates, not a benchmark score or a claim that tee is the only
cause. They make both the spike and the post-spike RSS residual measurable at a cadence
that can distinguish them.

## Non-goals

- Changing watchdog interval, ring size, thresholds, production memory accounting, or
  management API behavior.
- Modifying `tee()`, the inspector, eager relay, item-ID repair, image alias rewriting,
  failed-tail behavior, or any provider adapter.
- Selecting an eager relay on macOS; that is explicitly Phase 3.
- Treating a process restart, forced GC, or an allocator workaround as a fix.
- Adding this long-running workload to `bun run test`, CI, or a release gate.
