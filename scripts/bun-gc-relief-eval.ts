/**
 * Bun.gc(true) relief evaluation (devlog/_plan/260822_260822-bun14-followup-memory/020 Phase A).
 *
 * Evaluates the 260731 allocator-residual gate on Bun 1.4: does one full GC
 * inside the measured proxy return post-load RSS growth, and does it cost
 * request latency? Two SEPARATE cell types keep the criteria uncontaminated:
 *
 * - rss cells:     load stream -> intervention -> process IDLE through +5s/+60s
 *                  samples (criterion a evidence).
 * - latency cells: load stream -> intervention -> identical POST-INTERVENTION
 *                  probe stream in both arms; probe p99 is criterion c's oracle.
 *
 * Arms: control (matched idle wait) vs gc (SIGUSR2 to the child, which runs
 * Bun.gc(true) in-process and reports {type:"gc",at,durationMs} on stdout).
 *
 * This orchestrator reuses macos-rss-retention-harness-child.ts (the real
 * startServer proxy) and an inline SSE fixture upstream. It is NOT the locked
 * 7h retention protocol; runs are short and labeled. Smoke mode
 * (OCX_GC_EVAL_SMOKE=1) shortens durations for pipeline verification only.
 *
 * Usage: bun scripts/bun-gc-relief-eval.ts <outDir>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SMOKE = process.env.OCX_GC_EVAL_SMOKE === "1";
const RUNS = SMOKE ? 1 : 3;
const LOAD_TURNS = SMOKE ? 3 : 30;
const EVENTS = SMOKE ? 20 : 200;
const EVENT_BYTES = 65_536;
const PROBE_TURNS = SMOKE ? 3 : 20;
const POST_WAIT_1_MS = 5_000;
const POST_WAIT_2_MS = SMOKE ? 10_000 : 60_000;
const READY_TIMEOUT_MS = 15_000;

const outDir = process.argv[2];
if (!outDir) throw new Error("usage: bun scripts/bun-gc-relief-eval.ts <outDir>");
mkdirSync(outDir, { recursive: true });

type Arm = "control" | "gc";
type CellKind = "rss" | "latency";

function frame(event: string | null, data: unknown): Uint8Array {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  return new TextEncoder().encode(
    (event ? "event: " + event + "\n" : "") + "data: " + payload + "\n\n",
  );
}

/** Minimal Responses-shaped SSE fixture (mirrors the retention-harness fixture). */
function startFixture(): { url: string; stop(): Promise<void> } {
  let serial = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/responses") {
        return new Response("not found", { status: 404 });
      }
      await request.json().catch(() => ({}));
      const id = ++serial;
      let n = 0;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          let bytes: Uint8Array;
          let done = false;
          if (n === 0) {
            bytes = frame("response.created", {
              type: "response.created",
              response: { id: "fixture-" + id, status: "in_progress", output: [] },
            });
          } else if (n <= EVENTS) {
            bytes = frame("response.output_text.delta", {
              type: "response.output_text.delta",
              output_index: 0,
              content_index: 0,
              item_id: "msg-" + id,
              delta: "x".repeat(EVENT_BYTES),
            });
          } else if (n === EVENTS + 1) {
            bytes = frame("response.output_item.done", {
              type: "response.output_item.done",
              output_index: 0,
              item: { id: "msg-" + id, type: "message", status: "completed", role: "assistant", content: [] },
            });
          } else if (n === EVENTS + 2) {
            bytes = frame("response.completed", {
              type: "response.completed",
              response: { id: "fixture-" + id, status: "completed", output: [] },
            });
          } else {
            bytes = frame(null, "[DONE]");
            done = true;
          }
          controller.enqueue(bytes);
          n++;
          if (done) controller.close();
        },
      }), { headers: { "content-type": "text/event-stream" } });
    },
  });
  return {
    url: server.url.toString().replace(/\/$/, ""),
    stop: () => server.stop(true),
  };
}

type ChildHandle = {
  port: number;
  pid: number;
  kill(signal: NodeJS.Signals): void;
  nextGcReceipt(): Promise<{ at: number; durationMs: number }>;
  rss(): number;
  stop(): Promise<void>;
};

async function startChild(upstreamUrl: string, dir: string): Promise<ChildHandle> {
  const home = join(dir, "opencodex-home");
  const codexHome = join(dir, "codex-home");
  mkdirSync(home, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  const child = Bun.spawn([
    process.execPath,
    join(import.meta.dir, "macos-rss-retention-harness-child.ts"),
    home,
    codexHome,
    upstreamUrl,
    join(dir, "child-series.jsonl"),
    "off",
  ], {
    stdout: "pipe",
    stderr: Bun.file(join(dir, "child.stderr.log")),
    // The child installs its SIGUSR2 collector only for this evaluation, so the
    // locked 7h retention protocol can never collect mid-run.
    env: { ...process.env, OCX_GC_EVAL: "1" },
  });

  let port = 0;
  let readyResolve!: () => void;
  const ready = new Promise<void>(resolve => { readyResolve = resolve; });
  let gcWaiter: {
    resolve: (receipt: { at: number; durationMs: number }) => void;
    reject: (error: Error) => void;
  } | null = null;

  const reader = child.stdout.getReader();
  const drain = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      buffer += decoder.decode(part.value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const value = JSON.parse(line) as { type?: string; port?: number; at?: number; durationMs?: number };
          if (value.type === "ready" && value.port) { port = value.port; readyResolve(); }
          if (value.type === "gc" && gcWaiter && typeof value.at === "number" && typeof value.durationMs === "number") {
            const w = gcWaiter; gcWaiter = null; w.resolve({ at: value.at, durationMs: value.durationMs });
          }
          // A collection that threw is a failed cell, not a 10s silence. Without
          // this the run reports "gc receipt timeout" and hides the real cause.
          if (value.type === "gc-error" && gcWaiter) {
            const w = gcWaiter; gcWaiter = null;
            w.reject(new Error(String((value as { message?: unknown }).message ?? "gc-error")));
          }
        } catch { /* startup noise */ }
      }
    }
  })();

  await Promise.race([
    ready,
    child.exited.then(() => { throw new Error("child exited before ready"); }),
    Bun.sleep(READY_TIMEOUT_MS).then(() => { throw new Error("readiness timeout"); }),
  ]);

  return {
    port,
    pid: child.pid,
    // Bun.spawn's handle.kill() does not deliver SIGUSR2 reliably on Bun 1.4
    // (verified: handle.kill silently no-ops while process.kill(pid) arrives);
    // signal through the OS instead.
    kill: signal => process.kill(child.pid, signal),
    nextGcReceipt: () => new Promise((resolve, reject) => {
      gcWaiter = { resolve, reject };
      setTimeout(() => { if (gcWaiter) { gcWaiter = null; reject(new Error("gc receipt timeout")); } }, 10_000);
    }),
    rss: () => {
      const out = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(child.pid)]);
      return Number.parseInt(out.stdout.toString().trim(), 10) * 1024;
    },
    stop: async () => {
      child.kill("SIGTERM");
      await Promise.race([child.exited, Bun.sleep(5_000)]);
      child.kill("SIGKILL");
      await drain.catch(() => {});
    },
  };
}

async function oneTurn(base: string, label: string, turn: number): Promise<number> {
  const started = performance.now();
  const response = await fetch(base + "/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencodex-api-key": "fixture-admission" },
    body: JSON.stringify({ model: "fixture/fixture-model", input: label + "-" + turn, stream: true }),
  });
  if (response.status !== 200 || !response.body) throw new Error("HTTP " + response.status);
  const reader = response.body.getReader();
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
  }
  return performance.now() - started;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

type CellResult = Record<string, unknown>;

async function runCell(kind: CellKind, arm: Arm, runIndex: number): Promise<CellResult> {
  const dir = join(outDir, kind + "-" + arm + "-run" + runIndex);
  mkdirSync(dir, { recursive: true });
  const fixture = startFixture();
  const child = await startChild(fixture.url, dir);
  const base = "http://127.0.0.1:" + child.port;
  try {
    // Pre-load baseline. The 260731 gate is "at least 50% of post-load RSS
    // GROWTH is recovered", so growth has to be measurable: without a baseline,
    // `rssAfterLoad - rssPlus60s` cannot tell recovery apart from ordinary drift,
    // and dividing by total post-load RSS answers a different question than the
    // gate asks.
    const rssBeforeLoad = child.rss();

    // Load stream (identical in both arms).
    for (let turn = 0; turn < LOAD_TURNS; turn++) await oneTurn(base, kind + "-load", turn);
    const rssAfterLoad = child.rss();

    // Intervention.
    let gcReceipt: { at: number; durationMs: number } | null = null;
    if (arm === "gc") {
      const receipt = child.nextGcReceipt();
      child.kill("SIGUSR2");
      gcReceipt = await receipt;
    } else {
      await Bun.sleep(50); // matched (small) intervention window
    }

    if (kind === "rss") {
      // Idle through both samples: pure criterion-(a) evidence.
      await Bun.sleep(POST_WAIT_1_MS);
      const rssPlus5s = child.rss();
      await Bun.sleep(POST_WAIT_2_MS - POST_WAIT_1_MS);
      const rssPlus60s = child.rss();
      const postLoadGrowth = rssAfterLoad - rssBeforeLoad;
      const recoveredByPlus60s = rssAfterLoad - rssPlus60s;
      return {
        kind, arm, runIndex, smoke: SMOKE,
        rssBeforeLoad, rssAfterLoad, rssPlus5s, rssPlus60s,
        postLoadGrowth,
        gcDurationMs: gcReceipt?.durationMs ?? null,
        recoveredByPlus60s,
        // The controlling ratio, or null when the load produced no measurable
        // growth to recover (a cell that proves nothing rather than a 0% one).
        recoveryFraction: postLoadGrowth > 0 ? recoveredByPlus60s / postLoadGrowth : null,
      };
    }

    // latency cell: post-intervention probe stream is the oracle.
    const latencies: number[] = [];
    for (let turn = 0; turn < PROBE_TURNS; turn++) latencies.push(await oneTurn(base, "probe", turn));
    latencies.sort((a, b) => a - b);
    return {
      kind, arm, runIndex, smoke: SMOKE,
      probeTurns: PROBE_TURNS,
      p50Ms: quantile(latencies, 0.5),
      p99Ms: quantile(latencies, 0.99),
      maxMs: latencies[latencies.length - 1],
      gcDurationMs: gcReceipt?.durationMs ?? null,
      rssNonNormative: child.rss(),
    };
  } finally {
    await child.stop();
    await fixture.stop();
  }
}

const results: CellResult[] = [];
for (let run = 0; run < RUNS; run++) {
  for (const kind of ["rss", "latency"] as const) {
    for (const arm of ["control", "gc"] as const) {
      const cell = await runCell(kind, arm, run);
      results.push(cell);
      console.log(JSON.stringify(cell));
    }
  }
}

const report = {
  smoke: SMOKE,
  bunVersion: Bun.version,
  bunRevision: Bun.revision,
  platform: process.platform,
  arch: process.arch,
  at: new Date().toISOString(),
  runs: RUNS,
  loadTurns: LOAD_TURNS,
  events: EVENTS,
  eventBytes: EVENT_BYTES,
  results,
};
writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
console.log("report: " + join(outDir, "report.json"));
