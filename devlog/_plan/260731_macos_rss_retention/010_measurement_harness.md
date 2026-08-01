# Phase 1 — calibrated macOS RSS-retention harness

## Decision

This is an offline Bun-native instrument under `scripts/`, never a test or CI job.
It changes no production source, test, schema, watchdog, or ignore file. Restart and
forced GC are not fixes.

The two script controls are **HTTP/inspection topology baselines**. They deliberately
do not reproduce the real proxy's continuation expansion/persistence, so Phases 1–3
must not call their delta “tee alone.” A tee-only claim requires a later
continuation-equivalent control or production-path A/B. The combined-noise calculation
below remains mandatory but cannot override that prohibition. On macOS all three
`streamMode` values currently collapse to tee (`core.ts:1617-1628,1686`).

Implementation creates exactly:

```text
scripts/macos-rss-retention-harness.ts
scripts/macos-rss-retention-harness-child.ts
scripts/macos-rss-retention-single-reader-child.ts
scripts/macos-rss-retention-sampler.ts
```

Harness-owned artifacts are `manifest.jsonl`, `summary.json`, and per-run
`child.jsonl` (sampler-on), `child-events.jsonl` (relay controls), and
`child.stderr.log` below a fresh `.tmp/macos-rss-retention/<run-id>/`. The manifest
owns parent/OS/cadence evidence, the summary owns the verdict, child telemetry remains
isolated, hook receipts prove real inspection, and stderr explains child failures.
The real runtime may additionally create its normal config/state files, but only
inside each listed `runs/<run-id>/opencodex/` and `codex/` isolated home; those
runtime-owned filenames are version-dependent and the manifest records both home
roots rather than pretending they do not exist.

## Locked execution

- `--mode calibration`: six fresh real-proxy runs, exactly
  `off/on/on/off/on/off`; each has 60 s warmup then 600 s observation.
- `--mode parent-pressure`: after passing calibration, THREE equally instrumented
  60+600 s no-load runs for each topology; client cadence is emitted with zero counts.
  Three per topology, not one: each condition's envelope is built only from its OWN
  no-load runs, so borrowing real-proxy calibration samples cannot inflate a control
  envelope and mask a genuine topology delta.
- `--mode workload`: calibration, controls, then nine serial runs in the Latin square
  `tee/single/direct`, `single/direct/tee`, `direct/tee/single`.
- Every workload run warms for 60 s. Three persistent client states each execute one
  turn at offsets 0..1080 s in 120 s steps: 30 turns total. Each turn has 400 64-KiB
  deltas. `getReader()` records each received chunk and sleeps 25 ms after each chunk.
  A bounded one-frame parser extracts only `response.completed.response.id`.
- Sampling continues through settle checkpoints 0/30/60/120/300/600 s. The coarse
  session floor is about 5.5 h (nine roughly 20+10-minute runs plus 66-minute
  calibration), excluding retries; warmups make the base about 5 h 45 m, and the
  nine no-load controls (three per topology, 11 min each) add about 1 h 39 m — so a
  full `--mode workload` session is roughly **7 h 24 m** before any retry.

The following complete listings are normative.

## `scripts/macos-rss-retention-sampler.ts`

```ts
import { getActiveTurnCount } from "../src/server/lifecycle";
import { responseStateMetrics } from "../src/responses/state";
export type SampleMode = "real-proxy-legacy-tee" | "single-reader-inspection" | "direct-http-baseline";
type Heap = { heapSize: number; heapCapacity: number; objectCount: number };
export async function startSelfSampler(o: {
  enabled: boolean; path: string; mode: SampleMode; activeCount?: () => number;
}) {
  if (!o.enabled) return { async stop() { return 0; } };
  const writer = Bun.file(o.path).writer();
  let heapStats: (() => Heap) | null = null;
  try { heapStats = (await import("bun:jsc")).heapStats; } catch { heapStats = null; }
  const origin = performance.now(); let n = 0; let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = (): void => {
    if (stopped) return;
    const scheduled = origin + n * 200; const actual = performance.now();
    const m = process.memoryUsage(); let jscHeap: Heap | null = null;
    try { jscHeap = heapStats ? heapStats() : null; } catch { jscHeap = null; }
    writer.write(JSON.stringify({
      type: "self-sample", wallMs: Date.now(), n, scheduled, actual,
      latenessMs: actual - scheduled, rss: m.rss, heapUsed: m.heapUsed,
      heapTotal: m.heapTotal, external: m.external, arrayBuffers: m.arrayBuffers,
      jscHeap, responseState: responseStateMetrics(),
      activeTurnCount: (o.activeCount ?? getActiveTurnCount)(), mode: o.mode,
    }) + "\n");
    n++; timer = setTimeout(tick, Math.max(0, origin + n * 200 - performance.now()));
  };
  tick();
  return { async stop() {
    stopped = true; if (timer) clearTimeout(timer);
    await writer.flush(); writer.end(); return n;
  } };
}
```

## `scripts/macos-rss-retention-harness-child.ts`

```ts
import { startSelfSampler } from "./macos-rss-retention-sampler";
const [home, codexHome, upstream, series, enabled] = Bun.argv.slice(2);
if (!home || !codexHome || !upstream || !series || !["on","off"].includes(enabled ?? "")) {
  throw new Error("invalid real-child arguments");
}
for (const key of Object.keys(process.env)) {
  if (/^(?:OPENAI_|CODEX_|OPENCODEX_)/.test(key) || /^(?:http|https|all)_proxy$/i.test(key)) {
    delete process.env[key];
  }
}
Object.assign(process.env, {
  OPENCODEX_HOME: home, CODEX_HOME: codexHome,
  OPENCODEX_API_AUTH_TOKEN: "fixture-admission",
  NO_PROXY: "127.0.0.1,localhost,::1", no_proxy: "127.0.0.1,localhost,::1",
});
const [{ saveConfig }, { startServer }] = await Promise.all([
  import("../src/config"), import("../src/server"),
]);
saveConfig({
  port: 0, hostname: "127.0.0.1", defaultProvider: "fixture", streamMode: "legacy-tee",
  providers: { fixture: {
    adapter: "openai-responses", baseUrl: upstream, authMode: "key",
    apiKey: "fixture-key", allowPrivateNetwork: true, liveModels: false,
    models: ["fixture-model"],
  } },
});
const server = startServer(0);
const sampler = await startSelfSampler({
  enabled: enabled === "on", path: series, mode: "real-proxy-legacy-tee",
});
process.stdout.write(JSON.stringify({
  type: "ready", pid: process.pid, port: server.port, watchdogIncluded: true,
}) + "\n");
await new Promise<void>((resolve) => {
  let closing = false;
  const stop = async () => {
    if (closing) return; closing = true;
    await sampler.stop().catch(() => 0); await server.stop(true).catch(() => {});
    resolve();
  };
  process.once("SIGINT", () => void stop()); process.once("SIGTERM", () => void stop());
});
```

## `scripts/macos-rss-retention-single-reader-child.ts`

```ts
import { createSseInspector } from "../src/server/relay";
import type { RequestLogContext } from "../src/server/request-log";
import { startSelfSampler, type SampleMode } from "./macos-rss-retention-sampler";
const [upstream, series, eventsPath, rawMode, enabled] = Bun.argv.slice(2);
if (!upstream || !series || !eventsPath
  || !["single-reader-inspection","direct-http-baseline"].includes(rawMode ?? "")
  || !["on","off"].includes(enabled ?? "")) throw new Error("invalid relay arguments");
const mode = rawMode as SampleMode; const events = Bun.file(eventsPath).writer();
let active = 0;
const record = (row: Record<string, unknown>) =>
  events.write(JSON.stringify({ wallMs: Date.now(), ...row }) + "\n");
const sampler = await startSelfSampler({
  enabled: enabled === "on", path: series, mode, activeCount: () => active,
});
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/responses") {
    return new Response("not found", { status: 404 });
  }
  if (request.headers.get("x-opencodex-api-key") !== "fixture-admission") {
    return new Response("unauthorized", { status: 401 });
  }
  const response = await fetch(upstream + "/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: await request.arrayBuffer(),
  });
  if (!response.body) return new Response("body missing", { status: 502 });
  const reader = response.body.getReader();
  const logCtx: RequestLogContext = { model: "fixture/fixture-model", provider: "fixture" };
  const inspector = mode === "single-reader-inspection" ? createSseInspector({
    logCtx,
    onFirstOutput: () => record({ type: "first-output" }),
    onTerminal: (status, override) => record({ type: "terminal", status, override }),
    onCompletedResponse: (r) => record({
      type: "completed", id: typeof r.id === "string" ? r.id : null,
      outputs: Array.isArray(r.output) ? r.output.length : null, status: r.status ?? null,
    }),
  }) : null;
  active++; let finished = false;
  const finish = () => { if (!finished) { finished = true; active--; } };
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const part = await reader.read();
        if (part.done) { inspector?.finish(); finish(); controller.close(); return; }
        inspector?.feed(part.value); controller.enqueue(part.value);
      } catch (error) { finish(); controller.error(error); }
    },
    async cancel(reason) { finish(); await reader.cancel(reason).catch(() => {}); },
  }), { status: response.status, headers: { "content-type": "text/event-stream" } });
} });
process.stdout.write(JSON.stringify({ type: "ready", pid: process.pid, port: server.port }) + "\n");
await new Promise<void>((resolve) => {
  let closing = false;
  const stop = async () => {
    if (closing) return; closing = true; await sampler.stop().catch(() => 0);
    await events.flush(); events.end(); server.stop(true); resolve();
  };
  process.once("SIGINT", () => void stop()); process.once("SIGTERM", () => void stop());
});
```

## `scripts/macos-rss-retention-harness.ts`

```ts
import {
  existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { arch, cpus, freemem, loadavg, platform, release, totalmem, uptime } from "node:os";
type Condition = "real-proxy-legacy-tee" | "single-reader-inspection" | "direct-http-baseline";
type Kind = "calibration" | "parent-pressure" | "workload";
type Row = Record<string, unknown> & { type: string; wallMs: number };
type Run = { id: string; condition: Condition; kind: Kind; sampler: boolean; series: string };
const MiB = 1024 ** 2, WARM = 60_000, OBSERVE = 600_000, WAVES = 10;
const EVENTS = 400, EVENT_BYTES = 65_536, WAVE_MS = 120_000, READ_MS = 25;
// Pre-registered wave-start tolerance. A wave is allowed to be a little late from
// scheduler jitter, but not so late that the locked 20-minute profile stretches.
// Changing this after seeing a result restarts the whole calibration sequence.
const WAVE_TOLERANCE_MS = 5_000;
const SETTLE = [0,30,60,120,300,600] as const;
const CONDITIONS: readonly Condition[] = [
  "real-proxy-legacy-tee","single-reader-inspection","direct-http-baseline",
];
const LATIN: readonly (readonly Condition[])[] = [
  CONDITIONS,
  ["single-reader-inspection","direct-http-baseline","real-proxy-legacy-tee"],
  ["direct-http-baseline","real-proxy-legacy-tee","single-reader-inspection"],
];
const ORDER = [false,true,true,false,true,false] as const;

class Log {
  private writer;
  constructor(readonly path: string) { this.writer = Bun.file(path).writer(); }
  add(row: Record<string, unknown>) {
    this.writer.write(JSON.stringify({ wallMs: Date.now(), ...row }) + "\n");
  }
  async flush() { await this.writer.flush(); }
  async close() { await this.writer.flush(); this.writer.end(); }
}
function inside(base: string, target: string) {
  const r = relative(base, target);
  return r === "" || (r !== ".." && !r.startsWith(".." + sep) && !isAbsolute(r));
}
function nearest(target: string) {
  let p = target;
  while (!existsSync(p)) { const next = dirname(p); if (next === p) throw Error("no ancestor"); p = next; }
  return p;
}
function validate(base: string, lexical: string) {
  if (!inside(base, lexical)) throw Error("lexical escape");
  let p = base;
  for (const part of relative(base, lexical).split(sep).filter(Boolean)) {
    p = join(p, part); if (lstatSync(p).isSymbolicLink()) throw Error("symlink: " + p);
  }
  const real = realpathSync.native(lexical);
  if (!inside(base, real)) throw Error("canonical escape");
  return real;
}
function create(base: string, requested: string, fresh: boolean) {
  const target = resolve(requested);
  if (!inside(base, target) || (fresh && existsSync(target))) throw Error("unsafe leaf");
  const ancestor = nearest(target); let parent = validate(base, ancestor);
  for (const part of relative(ancestor, target).split(sep).filter(Boolean)) {
    const next = join(parent, part);
    if (!existsSync(next)) mkdirSync(next, { recursive: false, mode: 0o700 });
    if (lstatSync(next).isSymbolicLink()) throw Error("symlink: " + next);
    parent = realpathSync.native(next);
    if (!inside(base, parent)) throw Error("created escape");
  }
  return validate(base, target);
}
function outputRoot(requested?: string) {
  const repo = realpathSync.native(resolve(import.meta.dir, ".."));
  const allowedLexical = resolve(repo, ".tmp", "macos-rss-retention");
  validate(repo, nearest(allowedLexical)); // before the first mkdir
  const allowed = create(repo, allowedLexical, false);
  return create(allowed, requested ?? join(
    allowed, new Date().toISOString().replace(/[:.]/g, "-") + "-" + process.pid,
  ), true);
}
function host() {
  return {
    platform: platform(), release: release(), arch: arch(), bun: Bun.version,
    cpus: cpus().length, cpuModel: cpus()[0]?.model ?? null, loadavg: loadavg(),
    totalmem: totalmem(), freemem: freemem(), uptime: uptime(),
  };
}
async function pause(ms: number) { await Bun.sleep(ms); }
function frame(type: string | null, payload: unknown) {
  const data = typeof payload === "string" ? payload : JSON.stringify(payload);
  return new TextEncoder().encode((type ? "event: " + type + "\n" : "") + "data: " + data + "\n\n");
}
function fixture(log: Log, run: string) {
  let serial = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (req.method !== "POST" || new URL(req.url).pathname !== "/v1/responses") {
      return new Response("not found", { status: 404 });
    }
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const id = ++serial; let n = 0;
    log.add({
      type: "upstream-request", run, id,
      previous: typeof body.previous_response_id === "string" ? body.previous_response_id : null,
      inputItems: Array.isArray(body.input) ? body.input.length : null,
    });
    return new Response(new ReadableStream<Uint8Array>({ pull(c) {
      let kind: string, bytes: Uint8Array;
      if (n === 0) {
        kind = "created"; bytes = frame("response.created", {
          type: "response.created", response: { id: "fixture-" + id, status: "in_progress", output: [] },
        });
      } else if (n <= EVENTS) {
        kind = "delta"; bytes = frame("response.output_text.delta", {
          type: "response.output_text.delta", output_index: 0, content_index: 0,
          item_id: "msg-" + id, delta: "x".repeat(EVENT_BYTES),
        });
      } else {
        const item = { id: "msg-" + id, type: "message", status: "completed", role: "assistant", content: [] };
        if (n === EVENTS + 1) {
          kind = "item"; bytes = frame("response.output_item.done", {
            type: "response.output_item.done", output_index: 0, item,
          });
        } else if (n === EVENTS + 2) {
          kind = "completed"; bytes = frame("response.completed", {
            type: "response.completed", response: { id: "fixture-" + id, status: "completed", output: [] },
          });
        } else { kind = "done"; bytes = frame(null, "[DONE]"); }
      }
      log.add({ type: "upstream-pull", run, id, n, kind, bytes: bytes.byteLength });
      c.enqueue(bytes); n++; if (kind === "done") c.close();
    } }), { headers: { "content-type": "text/event-stream" } });
  } });
  return { url: server.url.toString().replace(/\/$/, ""), stop: () => server.stop(true) };
}

class IdParser {
  private decoder = new TextDecoder(); private buffer = ""; private id?: string;
  push(bytes: Uint8Array) {
    this.buffer += this.decoder.decode(bytes, { stream: true });
    if (this.buffer.length > 128 * 1024 && !this.buffer.includes("\n\n")) throw Error("SSE frame bound");
    for (let cut; (cut = this.buffer.indexOf("\n\n")) >= 0;) {
      const block = this.buffer.slice(0, cut); this.buffer = this.buffer.slice(cut + 2);
      const data = block.split(/\r?\n/).filter(x => x.startsWith("data:"))
        .map(x => x.slice(5).trimStart()).join("\n");
      if (data.includes('"type":"response.completed"')) {
        const parsed = JSON.parse(data) as { response?: { id?: unknown } };
        if (typeof parsed.response?.id === "string") this.id = parsed.response.id;
      }
    }
  }
  finish() {
    this.push(new Uint8Array()); if (!this.id) throw Error("completion id missing"); return this.id;
  }
}
type State = { client: number; previous?: string };
async function oneTurn(base: string, run: string, wave: number, state: State, log: Log) {
  const turn = wave + 1; const started = Date.now();
  log.add({ type: "client-start", run, wave, client: state.client, turn, previous: state.previous ?? null });
  const response = await fetch(base + "/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencodex-api-key": "fixture-admission" },
    body: JSON.stringify({
      model: "fixture/fixture-model", input: "fixture-" + state.client + "-" + turn, stream: true,
      ...(state.previous ? { previous_response_id: state.previous } : {}),
    }),
  });
  log.add({
    type: "client-http", run, wave, client: state.client, turn,
    status: response.status, body: response.body !== null,
  }); // status is durable before failure
  if (response.status !== 200 || !response.body) throw Error("HTTP " + response.status);
  const reader = response.body.getReader(); const parser = new IdParser();
  let chunk = 0, prior = Date.now();
  for (;;) {
    const part = await reader.read(); if (part.done) break;
    const now = Date.now(); parser.push(part.value);
    log.add({
      type: "client-chunk", run, wave, client: state.client, turn,
      chunk: ++chunk, bytes: part.value.byteLength, gapMs: now - prior,
      sinceTurnStartMs: now - started,
    });
    prior = now; await pause(READ_MS);
  }
  const completed = parser.finish();
  log.add({
    type: "client-end", run, wave, client: state.client, turn,
    previous: state.previous ?? null, completed, durationMs: Date.now() - started,
  });
  state.previous = completed;
}
async function workload(base: string, run: string, log: Log) {
  const states: State[] = [1,2,3].map(client => ({ client })); const origin = performance.now();
  // Persist the origin so validateWorkload can anchor every wave to origin+N*WAVE_MS.
  // Without it, drift is only visible as "each wave was internally concurrent", which
  // is exactly how an overlong run used to pass validation.
  log.add({ type: "workload-origin", run, wallMs: Date.now(), monotonicMs: origin });
  for (let wave = 0; wave < WAVES; wave++) {
    await pause(Math.max(0, origin + wave * WAVE_MS - performance.now()));
    await Promise.all(states.map(state => oneTurn(base, run, wave, state, log)));
  }
}

type Child = { process: Bun.Subprocess; base: string; drain: Promise<void> };
async function startChild(condition: Condition, url: string, dir: string, sampler: boolean): Promise<Child> {
  const real = condition === "real-proxy-legacy-tee";
  const args = real
    ? [
      create(dir, join(dir, "opencodex"), true), create(dir, join(dir, "codex"), true),
      url, join(dir, "child.jsonl"), sampler ? "on" : "off",
    ]
    : [url, join(dir, "child.jsonl"), join(dir, "child-events.jsonl"), condition, sampler ? "on" : "off"];
  const process = Bun.spawn([
    globalThis.process.execPath,
    join(import.meta.dir, real
      ? "macos-rss-retention-harness-child.ts"
      : "macos-rss-retention-single-reader-child.ts"),
    ...args,
  ], { stdout: "pipe", stderr: Bun.file(join(dir, "child.stderr.log")) });
  const reader = process.stdout.getReader(); let port: number | undefined;
  let ready!: () => void; const signal = new Promise<void>(r => { ready = r; });
  const drain = (async () => {
    const decoder = new TextDecoder(); let buffer = "";
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      buffer += decoder.decode(part.value, { stream: true });
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const value = JSON.parse(line) as { type?: string; port?: number };
          if (value.type === "ready" && value.port) { port = value.port; ready(); }
        } catch {}
      }
    }
  })();
  await Promise.race([
    signal, process.exited.then(() => { throw Error("child exited before ready"); }),
    Bun.sleep(15_000).then(() => { throw Error("readiness timeout"); }),
  ]);
  if (!port) throw Error("readiness missing");
  return { process, base: "http://127.0.0.1:" + port, drain };
}
async function stopChild(child: Child) {
  if (child.process.exitCode === null) child.process.kill("SIGTERM");
  await Promise.race([child.process.exited, Bun.sleep(5_000)]);
  if (child.process.exitCode === null) { child.process.kill("SIGKILL"); await child.process.exited; }
  await child.drain;
}
function observers(pid: number, run: string, log: Log, phase: () => string) {
  let stopped = false; const origin = performance.now(); let n = 0;
  let previousCpu = process.cpuUsage();
  const parent = setInterval(() => {
    const actual = performance.now(), memory = process.memoryUsage();
    const cpu = process.cpuUsage(previousCpu); previousCpu = process.cpuUsage();
    log.add({
      type: "parent-sample", run, phase: phase(), rss: memory.rss,
      cpuUser: cpu.user, cpuSystem: cpu.system,
      scheduled: origin + n++ * 200, actual, latenessMs: actual - (origin + (n - 1) * 200),
    });
  }, 200);
  const ps = (async () => {
    while (!stopped) {
      const child = Bun.spawn(["ps","-o","rss=","-p",String(pid)], { stdout: "pipe" });
      const text = await new Response(child.stdout).text(); await child.exited;
      log.add({ type: "ps-rss", run, phase: phase(), rss: Number(text.trim()) * 1024 });
      await pause(1_000);
    }
  })();
  return { async stop() { stopped = true; clearInterval(parent); await ps; } };
}
async function execute(root: string, log: Log, run: Run) {
  const dir = create(root, join(root, "runs", run.id), true); run.series = join(dir, "child.jsonl");
  let phase = "startup"; const up = fixture(log, run.id);
  const measured = await startChild(run.condition, up.url, dir, run.sampler);
  const watch = observers(measured.process.pid, run.id, log, () => phase);
  log.add({
    type: "run-start", run: run.id, condition: run.condition, kind: run.kind,
    sampler: run.sampler, host: host(), clients: 3, turns: 10,
    events: EVENTS, eventBytes: EVENT_BYTES, waveMs: WAVE_MS, readMs: READ_MS,
  });
  try {
    phase = "warm"; const warm = Date.now();
    log.add({ type: "warm-start", run: run.id });
    await pause(WARM);
    log.add({ type: "warm-end", run: run.id, actualMs: Date.now() - warm });
    if (Date.now() - warm < WARM || measured.process.exitCode !== null) throw Error("warm invalid");
    if (run.kind === "workload") {
      phase = "workload"; await workload(measured.base, run.id, log);
      phase = "settle"; const start = performance.now();
      for (const seconds of SETTLE) {
        await pause(Math.max(0, start + seconds * 1_000 - performance.now()));
        log.add({ type: "settle", run: run.id, seconds });
      }
    } else {
      phase = "observation"; const start = Date.now();
      log.add({ type: "observation-start", run: run.id });
      await pause(OBSERVE);
      log.add({ type: "observation-end", run: run.id, actualMs: Date.now() - start });
      log.add({ type: "client-cadence", run: run.id, chunks: 0, bytes: 0, meanGapMs: null });
    }
    if (measured.process.exitCode !== null) throw Error("child exited");
  } finally {
    await watch.stop(); await stopChild(measured); await up.stop();
    log.add({ type: "run-end", run: run.id, exitCode: measured.process.exitCode });
  }
}

function rows(path: string): Row[] {
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line, i) => {
    try { return JSON.parse(line) as Row; }
    catch (error) { throw Error("malformed JSONL line " + (i + 1) + ": " + error); }
  });
}
const med = (v: number[]) => {
  const s = [...v].sort((a,b) => a-b), m = Math.floor(s.length/2);
  if (!s.length) throw Error("empty median"); return s.length%2 ? s[m]! : (s[m-1]!+s[m]!)/2;
};
// Ordinary least squares. This MUST centre on the arithmetic mean: centring on the
// median is not OLS, and a wrong slope silently corrupts the sampler budget, the
// no-load slope envelope, and the allocator-retention classification alike.
function slope(v: Array<{ x: number; y: number }>) {
  if (v.length < 2) return 0;
  const mx = v.reduce((s,p) => s+p.x, 0)/v.length;
  const my = v.reduce((s,p) => s+p.y, 0)/v.length;
  const top = v.reduce((s,p) => s+(p.x-mx)*(p.y-my),0);
  const bottom = v.reduce((s,p) => s+(p.x-mx)**2,0);
  return bottom ? top/bottom : 0;
}

/**
 * Sampler integrity for ANY sampler-on run. Calibration and no-load control runs
 * establish the sampler budget and the envelopes, so a degraded sampler there
 * corrupts every downstream verdict while still looking valid. Applying this only
 * to workload runs — as the previous revision did — leaves that door open.
 */
function assertSamplerIntegrity(run: Run) {
  const self = rows(run.series);
  if (self.length < 2) throw Error(`sampler empty: ${run.id}`);
  const late = self.map(r => Number(r.latenessMs)).sort((a,b) => a-b);
  const p99 = late[Math.min(late.length-1, Math.floor(late.length*0.99))]!;
  if (p99 > 200) throw Error(`sampler p99 lateness ${Math.round(p99)}ms: ${run.id}`);
  for (let i = 1; i < self.length; i++) {
    if (Number(self[i]!.wallMs) - Number(self[i-1]!.wallMs) > 1_000) {
      throw Error(`sampler gap >1s: ${run.id}`);
    }
  }
}
function calibrationVerdict(all: Row[], runs: Run[]) {
  if (runs.some((r,i) => r.sampler !== ORDER[i])) throw Error("calibration order");
  runs.filter(r => r.sampler).forEach(assertSamplerIntegrity);
  const stat = (run: Run) => {
    const ps = all.filter(r => r.run === run.id && r.type === "ps-rss" && r.phase === "observation")
      .map(r => ({ x: r.wallMs, y: Number(r.rss) }));
    if (ps.length < 590) throw Error("calibration incomplete");
    return { final: ps.at(-1)!.y, peak: Math.max(...ps.map(x=>x.y)), slope: slope(ps)*60_000/MiB };
  };
  for (const run of runs.filter(r => r.sampler)) {
    const self = rows(run.series), ps = all.filter(r => r.run === run.id && r.type === "ps-rss");
    let cursor = 0, bad = 0;
    for (const os of ps) {
      while (cursor+1 < self.length
        && Math.abs(self[cursor+1]!.wallMs-os.wallMs) <= Math.abs(self[cursor]!.wallMs-os.wallMs)) cursor++;
      const sample = self[cursor], rss = Number(sample?.rss);
      if (!sample || Math.abs(sample.wallMs-os.wallMs)>600) throw Error("alignment missing");
      bad = Math.abs(rss-Number(os.rss)) > Math.max(8*MiB,rss*.01) ? bad+1 : 0;
      if (bad >= 3) throw Error("telemetry integrity");
    }
  }
  const on = runs.filter(r=>r.sampler).map(stat), off = runs.filter(r=>!r.sampler).map(stat);
  const final = med(on.map(x=>x.final))-med(off.map(x=>x.final));
  const peak = med(on.map(x=>x.peak))-med(off.map(x=>x.peak));
  const rssSlope = med(on.map(x=>x.slope))-med(off.map(x=>x.slope));
  if (final>8*MiB || peak>16*MiB || rssSlope>.5) throw Error("sampler budget");
  return { passed: true, final, peak, rssSlope };
}
function validateWorkload(all: Row[], run: Run) {
  // Whole-run sampler integrity FIRST. The active-turn checks below only cover
  // intervals while a turn is in flight, but the warm baseline and the 0..600s
  // settle samples are what decide the residual and the retention verdict — a gap
  // there would otherwise pass unnoticed.
  assertSamplerIntegrity(run);
  const m = all.filter(r=>r.run===run.id), starts=m.filter(r=>r.type==="client-start");
  const ends=m.filter(r=>r.type==="client-end"), http=m.filter(r=>r.type==="client-http");
  if (Number(m.find(r=>r.type==="warm-end")?.actualMs)<WARM
    || starts.length!==30 || ends.length!==30 || http.some(r=>r.status!==200)
    || m.filter(r=>r.type==="upstream-pull"&&r.kind==="delta").length!==30*EVENTS
    || m.filter(r=>r.type==="settle").length!==SETTLE.length) throw Error("shape invalid");
  for (let client=1;client<=3;client++) {
    const chain=ends.filter(r=>r.client===client).sort((a,b)=>Number(a.turn)-Number(b.turn));
    for(let i=1;i<chain.length;i++) if(chain[i]!.previous!==chain[i-1]!.completed) throw Error("chain");
  }
  // Wave scheduling uses Math.max(0, ...), so an overlong wave cannot be detected by
  // intra-wave checks alone: every later wave simply slides and the run quietly
  // exceeds the locked 20-minute profile while still passing shape and concurrency.
  // Anchor each wave to origin + N*120s with a pre-registered tolerance.
  const origin=Number(m.find(r=>r.type==="workload-origin")?.wallMs);
  if(!origin) throw Error("missing workload origin");
  for(let wave=0;wave<10;wave++) {
    const s=starts.filter(r=>r.wave===wave), e=ends.filter(r=>r.wave===wave);
    if(s.length!==3 || e.length!==3
      || Math.max(...s.map(r=>r.wallMs))-Math.min(...s.map(r=>r.wallMs))>1_000
      || Math.min(...e.map(r=>r.wallMs))<=Math.max(...s.map(r=>r.wallMs))) {
      throw Error("concurrency");
    }
    const target=origin+wave*WAVE_MS;
    const drift=Math.max(...s.map(r=>Math.abs(Number(r.wallMs)-target)));
    if(drift>WAVE_TOLERANCE_MS) {
      throw Error(`wave ${wave} drift ${Math.round(drift)}ms > ${WAVE_TOLERANCE_MS}ms`);
    }
  }
  for(const kind of ["created","item","completed","done"]) {
    if(m.filter(r=>r.type==="upstream-pull"&&r.kind===kind).length!==30) {
      throw Error("fixture event count");
    }
  }
  const self=rows(run.series), late=self.map(r=>Number(r.latenessMs)).sort((a,b)=>a-b);
  if(late[Math.ceil(late.length*.99)-1]!>200) throw Error("p99 lateness");
  for(const start of starts) {
    const end=ends.find(r=>r.client===start.client&&r.turn===start.turn)!;
    const t=[start.wallMs,...self.filter(r=>r.wallMs>=start.wallMs&&r.wallMs<=end.wallMs).map(r=>r.wallMs),end.wallMs];
    if(t.some((x,i)=>i>0&&x-t[i-1]!>1_000)) throw Error("active sampler gap");
  }
}
function analysis(all: Row[], calibration: Run[], controls: Run[], work: Run[]) {
  work.forEach(r=>validateWorkload(all,r));
  const envelope=(run: Run,field:"rss"|"external"|"arrayBuffers")=>{
    const start=Number(all.find(r=>r.run===run.id&&r.type==="observation-start")?.wallMs);
    const end=Number(all.find(r=>r.run===run.id&&r.type==="observation-end")?.wallMs);
    if(!start||!end||end-start<OBSERVE) throw Error("observation interval");
    const p=(field==="rss"
      ?all.filter(r=>r.run===run.id&&r.type==="ps-rss").map(r=>({x:r.wallMs,y:Number(r.rss)}))
      :rows(run.series).map(r=>({x:r.wallMs,y:Number(r[field])})))
      .filter(x=>x.x>=start&&x.x<=end);
    const base=med(p.filter(x=>x.x-p[0]!.x<=60_000).map(x=>x.y));
    let slopeEnvelope=0;
    for(const point of p) {
      const w=p.filter(x=>x.x>=point.x&&x.x<=point.x+120_000);
      if(w.length>1&&w.at(-1)!.x-w[0]!.x>=119_000) slopeEnvelope=Math.max(slopeEnvelope,Math.abs(slope(w)));
    }
    return { upper:Math.max(...p.map(x=>x.y-base)), slope:slopeEnvelope };
  };
  // Each condition's envelope must come from ITS OWN no-load runs. Borrowing the
  // real-proxy calibration samples (as the previous revision did) lets a noisy
  // proxy idle inflate a control's envelope and mask a genuine topology delta,
  // while still calling the basis "topology-matched".
  const env=Object.fromEntries(CONDITIONS.map(c=>{
    const own=controls.filter(r=>r.condition===c);
    if(own.length<3) throw Error(`need 3 no-load controls for ${c}, got ${own.length}`);
    own.forEach(assertSamplerIntegrity);
    const candidates=own;
    return [c,Object.fromEntries((["rss","external","arrayBuffers"] as const).map(f=>{
      const e=candidates.map(r=>envelope(r,f));
      return [f,{upper:Math.max(...e.map(x=>x.upper)),slope:Math.max(...e.map(x=>x.slope))}];
    }))];
  })) as Record<Condition,Record<"rss"|"external"|"arrayBuffers",{upper:number;slope:number}>>;
  const metric=(run:Run,field:"rss"|"external"|"arrayBuffers")=>{
    const manifest=all.filter(r=>r.run===run.id);
    const warmStart=Number(manifest.find(r=>r.type==="warm-start")?.wallMs);
    const warmEnd=Number(manifest.find(r=>r.type==="warm-end")?.wallMs);
    const loadStart=Number(manifest.find(r=>r.type==="client-start")?.wallMs);
    const at=(seconds:number)=>Number(manifest.find(r=>r.type==="settle"&&r.seconds===seconds)?.wallMs);
    const p=field==="rss"
      ?manifest.filter(r=>r.type==="ps-rss").map(r=>({x:r.wallMs,y:Number(r.rss)}))
      :rows(run.series).map(r=>({x:r.wallMs,y:Number(r[field])}));
    const baseline=med(p.filter(x=>x.x>=warmStart&&x.x<=warmEnd).map(x=>x.y));
    const peak=Math.max(...p.filter(x=>x.x>=loadStart&&x.x<=at(600)).map(x=>x.y))-baseline;
    const residuals=Object.fromEntries(SETTLE.map(seconds=>[
      seconds,
      p.reduce((best,x)=>Math.abs(x.x-at(seconds))<Math.abs(best.x-at(seconds))?x:best).y-baseline,
    ])) as Record<string,number>;
    const settle=p.filter(x=>x.x>=at(120)&&x.x<=at(600));
    return {baseline,peak,residuals,slope120To600:slope(settle)};
  };
  const values=Object.fromEntries(work.map(run=>[run.id,{
    rss:metric(run,"rss"),external:metric(run,"external"),
    arrayBuffers:metric(run,"arrayBuffers"),
  }])) as Record<string,Record<"rss"|"external"|"arrayBuffers",ReturnType<typeof metric>>>;
  const detectable=Object.fromEntries(CONDITIONS.map(condition=>[
    condition,
    Object.fromEntries((["rss","external","arrayBuffers"] as const).map(field=>[
      field,
      work.filter(run=>run.condition===condition)
        .every(run=>values[run.id]![field].peak>env[condition][field].upper),
    ])),
  ]));
  const peaks=(c:Condition)=>work.filter(r=>r.condition===c).map(r=>values[r.id]!.rss.peak);
  const delta=med(peaks("real-proxy-legacy-tee"))-med(peaks("single-reader-inspection"));
  const combined=env["real-proxy-legacy-tee"].rss.upper+env["single-reader-inspection"].rss.upper;
  return {
    valid:true, envelopes:env, values, detectable, exceedsCombinedEnvelope:delta>combined,
    teeOnlyAttributionAllowed:false,
    requiredLanguage:delta>combined
      ?"measurable topology delta; tee-only attribution prohibited"
      :"no measurable topology delta under this profile",
    allocatorRetention:work.map(run=>({
      run:run.id,
      signature:values[run.id]!.external.residuals["600"]<=env[run.condition].external.upper
        && values[run.id]!.arrayBuffers.residuals["600"]<=env[run.condition].arrayBuffers.upper
        && values[run.id]!.rss.residuals["600"]>env[run.condition].rss.upper
        && values[run.id]!.rss.slope120To600>=-env[run.condition].rss.slope,
    })),
  };
}
function writeSummary(root:string,value:unknown) {
  const tmp=join(root,"summary.json.tmp-"+process.pid);
  writeFileSync(tmp,JSON.stringify(value,null,2)+"\n",{mode:0o600});
  renameSync(tmp,join(root,"summary.json"));
}
async function main() {
  const mode=Bun.argv[Bun.argv.indexOf("--mode")+1] as "calibration"|"parent-pressure"|"workload";
  if(!["calibration","parent-pressure","workload"].includes(mode)) throw Error("--mode required");
  const outputIndex=Bun.argv.indexOf("--output");
  const root=outputRoot(outputIndex>=0?Bun.argv[outputIndex+1]:undefined), log=new Log(join(root,"manifest.jsonl"));
  const runs:Run[]=[], run=async(r:Run)=>{await execute(root,log,r);runs.push(r);};
  log.add({type:"session-start",mode,wallClockStart:new Date().toISOString(),host:host()});
  try {
    for(let i=0;i<6;i++) await run({
      id:"cal-"+(i+1)+"-"+(ORDER[i]?"on":"off"),condition:"real-proxy-legacy-tee",
      kind:"calibration",sampler:ORDER[i]!,series:"",
    });
    await log.flush(); const calibrated=calibrationVerdict(rows(log.path),runs);
    if(mode==="calibration"){writeSummary(root,{valid:true,calibrated});return;}
    const controls:Run[]=[];
    // Three no-load controls per topology: analysis() builds each condition's envelope
    // from its own controls only, and demands three of them.
    for(const condition of CONDITIONS)for(let replica=1;replica<=3;replica++){
      const r={id:"control-"+condition+"-"+replica,condition,kind:"parent-pressure" as const,sampler:true,series:""};
      await run(r);controls.push(r);
    }
    if(mode==="parent-pressure"){writeSummary(root,{valid:true,calibrated,controls});return;}
    const work:Run[]=[];
    for(let replica=0;replica<3;replica++)for(const condition of LATIN[replica]!){const r={id:"r"+(replica+1)+"-"+condition,condition,kind:"workload" as const,sampler:true,series:""};await run(r);work.push(r);}
    await log.flush();writeSummary(root,{valid:true,calibrated,analysis:analysis(rows(log.path),runs.slice(0,6),controls,work)});
  } catch(error){log.add({type:"session-failed",error:String(error)});writeSummary(root,{valid:false,error:String(error)});throw error;}
  finally{log.add({type:"session-end",wallClockEnd:new Date().toISOString()});await log.close();}
}
await main();
```

## Analysis and invalidation

The executable evaluator enforces sampler budgets, self/OS integrity, 60-second
baselines, topology-matched no-load envelopes, complete workload shape, per-client
chains, active-stream gaps, p99 lateness, and the combined-envelope rule. Envelope
baseline is the median first 60 post-warmup seconds; upper envelope is maximum above
it; slope envelope is the largest absolute least-squares slope in a complete
120-second window. A signal is reportable only when all three replicas exceed its
envelope.

Residuals are read at 0/30/60/120/300/600. Allocator retention requires external and
arrayBuffers inside envelope at 600, RSS above envelope, and 120–600 RSS slope no more
negative than the no-load slope envelope. Elevated live-buffer metrics mean
live-buffer retention; faster-negative RSS means slow reclaim.

Any calibration/telemetry/temporal/shape/chain/status/child/cleanup/output failure
writes `valid:false` and exits non-zero. Any workload shape, threshold, cadence,
duration, or condition change requires a fresh full sequence. Fixed 128/256-MiB
result thresholds and adaptive event-count escalation remain deleted.

## Non-goals

- Change production, tests, schema, watchdog, stream paths, rewrites, failed tails,
  provider adapters, management APIs, or CI.
- Poll management endpoints during load.
- Claim production-identical traffic or tee-only causality.
