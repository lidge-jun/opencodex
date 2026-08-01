import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  arch,
  cpus,
  freemem,
  loadavg,
  platform,
  release,
  totalmem,
  uptime,
} from "node:os";

type Condition =
  | "real-proxy-legacy-tee"
  | "single-reader-inspection"
  | "direct-http-baseline";
type Kind = "calibration" | "parent-pressure" | "workload";
type Row = Record<string, unknown> & { type: string; wallMs: number };
type Run = {
  id: string;
  condition: Condition;
  kind: Kind;
  sampler: boolean;
  series: string;
};

const MiB = 1024 ** 2;

/**
 * Smoke mode exists to prove the pipeline runs end to end without waiting out a
 * ~7h session. It shortens durations ONLY, and every artifact it produces is
 * stamped `smoke: true` and `valid: false` so a shortened run can never be
 * mistaken for, or compared against, a real measurement. The pre-registered
 * measurement constants below are untouched in a real run.
 */
const SMOKE = process.env.OCX_RSS_HARNESS_SMOKE === "1";

const WARM = SMOKE ? 2_000 : 60_000;
const OBSERVE = SMOKE ? 6_000 : 600_000;
const WAVES = SMOKE ? 2 : 10;
const EVENTS = SMOKE ? 20 : 400;
const EVENT_BYTES = 65_536;
const WAVE_MS = SMOKE ? 4_000 : 120_000;
const READ_MS = 25;

// Scheduler jitter is tolerated, but not enough drift to stretch the locked profile.
// Changing this after seeing a result invalidates and restarts the full calibration sequence.
const WAVE_TOLERANCE_MS = 5_000;

/**
 * Total turns in a run: three clients, one turn each per wave. Derive it rather
 * than writing 30 in the validators — a literal silently becomes a lie the moment
 * the wave count changes, and the validator would then reject a correct run (or,
 * worse, accept a truncated one).
 */
const CLIENTS = 3;
const TURNS = CLIENTS * WAVES;
const SETTLE = SMOKE ? ([0, 2, 4] as const) : ([0, 30, 60, 120, 300, 600] as const);
const CONDITIONS: readonly Condition[] = [
  "real-proxy-legacy-tee",
  "single-reader-inspection",
  "direct-http-baseline",
];
const LATIN: readonly (readonly Condition[])[] = [
  CONDITIONS,
  ["single-reader-inspection", "direct-http-baseline", "real-proxy-legacy-tee"],
  ["direct-http-baseline", "real-proxy-legacy-tee", "single-reader-inspection"],
];
const ORDER = [false, true, true, false, true, false] as const;

class Log {
  private writer;

  constructor(readonly path: string) {
    this.writer = Bun.file(path).writer();
  }

  add(row: Record<string, unknown>): void {
    this.writer.write(JSON.stringify({ wallMs: Date.now(), ...row }) + "\n");
  }

  async flush(): Promise<void> {
    await this.writer.flush();
  }

  async close(): Promise<void> {
    const errors: unknown[] = [];
    try {
      await this.writer.flush();
    } catch (error) {
      errors.push(error);
    }
    try {
      this.writer.end();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) throw new AggregateError(errors, "manifest cleanup failed");
  }
}

type CleanupEntry = {
  name: string;
  cleanup: () => Promise<void>;
  stopping?: Promise<void>;
};
type CleanupHandle = { stop: () => Promise<void> };

class CleanupRegistry {
  private entries: CleanupEntry[] = [];

  register(name: string, cleanup: () => Promise<void>): CleanupHandle {
    const entry: CleanupEntry = { name, cleanup };
    this.entries.push(entry);
    return { stop: () => this.stop(entry) };
  }

  private stop(entry: CleanupEntry): Promise<void> {
    if (!entry.stopping) {
      entry.stopping = (async () => {
        try {
          await entry.cleanup();
        } finally {
          const index = this.entries.indexOf(entry);
          if (index >= 0) this.entries.splice(index, 1);
        }
      })();
    }
    return entry.stopping;
  }

  async stopAll(): Promise<void> {
    const errors: unknown[] = [];
    for (const entry of [...this.entries].reverse()) {
      try {
        await this.stop(entry);
      } catch (error) {
        errors.push(new Error(`cleanup failed for ${entry.name}`, { cause: error }));
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "registered cleanup failed");
  }
}

const resources = new CleanupRegistry();
const sessionAbort = new AbortController();
let signalCleanup: Promise<void> | null = null;
let signalCleanupFailure: unknown;

function interruptedError(): Error {
  const reason: unknown = sessionAbort.signal.reason;
  return reason instanceof Error ? reason : new Error(String(reason ?? "session interrupted"));
}

function throwIfInterrupted(): void {
  if (sessionAbort.signal.aborted) throw interruptedError();
}

function interruptible<T>(operation: PromiseLike<T>): Promise<T> {
  throwIfInterrupted();
  return new Promise<T>((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      sessionAbort.signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => rejectPromise(interruptedError()));
    sessionAbort.signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(
      value => finish(() => resolvePromise(value)),
      error => finish(() => rejectPromise(error)),
    );
  });
}

function beginSignalCleanup(signal: "SIGINT" | "SIGTERM"): void {
  if (sessionAbort.signal.aborted) return;
  sessionAbort.abort(new Error(`parent received ${signal}`));
  // Closing registered servers and children also unblocks reads that cannot observe AbortSignal.
  signalCleanup = resources.stopAll().catch((error) => {
    signalCleanupFailure = error;
  });
}

function inside(base: string, target: string): boolean {
  const pathFromBase = relative(base, target);
  return pathFromBase === ""
    || (
      pathFromBase !== ".."
      && !pathFromBase.startsWith(".." + sep)
      && !isAbsolute(pathFromBase)
    );
}

function nearest(target: string): string {
  let current = target;
  while (!existsSync(current)) {
    const next = dirname(current);
    if (next === current) throw new Error("no ancestor");
    current = next;
  }
  return current;
}

function validate(base: string, lexical: string): string {
  if (!inside(base, lexical)) throw new Error("lexical escape");

  let current = base;
  for (const part of relative(base, lexical).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error("symlink: " + current);
  }

  const canonical = realpathSync.native(lexical);
  if (!inside(base, canonical)) throw new Error("canonical escape");
  return canonical;
}

function create(base: string, requested: string, fresh: boolean): string {
  const target = resolve(requested);
  if (!inside(base, target) || (fresh && existsSync(target))) {
    throw new Error("unsafe leaf");
  }

  // Validate the nearest existing ancestor before creating even the first component.
  const ancestor = nearest(target);
  let parent = validate(base, ancestor);
  for (const part of relative(ancestor, target).split(sep).filter(Boolean)) {
    const next = join(parent, part);
    if (!existsSync(next)) mkdirSync(next, { recursive: false, mode: 0o700 });
    if (lstatSync(next).isSymbolicLink()) throw new Error("symlink: " + next);
    parent = realpathSync.native(next);
    if (!inside(base, parent)) throw new Error("created escape");
  }
  return validate(base, target);
}

function outputRoot(requested?: string): string {
  const repo = realpathSync.native(resolve(import.meta.dir, ".."));
  const allowedLexical = resolve(repo, ".tmp", "macos-rss-retention");
  validate(repo, nearest(allowedLexical));
  const allowed = create(repo, allowedLexical, false);
  return create(
    allowed,
    requested ?? join(
      allowed,
      new Date().toISOString().replace(/[:.]/g, "-") + "-" + process.pid,
    ),
    true,
  );
}

function host() {
  return {
    platform: platform(),
    release: release(),
    arch: arch(),
    bun: Bun.version,
    cpus: cpus().length,
    cpuModel: cpus()[0]?.model ?? null,
    loadavg: loadavg(),
    totalmem: totalmem(),
    freemem: freemem(),
    uptime: uptime(),
  };
}

async function pause(ms: number): Promise<void> {
  const deadline = performance.now() + Math.max(0, ms);
  for (;;) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) return;
    // Bun.sleep may wake fractionally before the requested deadline. Re-sleep
    // instead of weakening a pre-registered duration.
    await interruptible(Bun.sleep(Math.ceil(remaining)));
  }
}

function frame(type: string | null, payload: unknown): Uint8Array {
  const data = typeof payload === "string" ? payload : JSON.stringify(payload);
  return new TextEncoder().encode(
    (type ? "event: " + type + "\n" : "") + "data: " + data + "\n\n",
  );
}

type Fixture = { url: string; stop: () => Promise<void> };

function fixture(log: Log, run: string): Fixture {
  throwIfInterrupted();
  let serial = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/responses") {
        return new Response("not found", { status: 404 });
      }

      const body = await request.json().catch(() => ({})) as Record<string, unknown>;
      const id = ++serial;
      let eventNumber = 0;
      log.add({
        type: "upstream-request",
        run,
        id,
        previous: typeof body.previous_response_id === "string"
          ? body.previous_response_id
          : null,
        inputItems: Array.isArray(body.input) ? body.input.length : null,
      });

      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          let kind: string;
          let bytes: Uint8Array;
          if (eventNumber === 0) {
            kind = "created";
            bytes = frame("response.created", {
              type: "response.created",
              response: {
                id: "fixture-" + id,
                status: "in_progress",
                output: [],
              },
            });
          } else if (eventNumber <= EVENTS) {
            kind = "delta";
            bytes = frame("response.output_text.delta", {
              type: "response.output_text.delta",
              output_index: 0,
              content_index: 0,
              item_id: "msg-" + id,
              delta: "x".repeat(EVENT_BYTES),
            });
          } else {
            const item = {
              id: "msg-" + id,
              type: "message",
              status: "completed",
              role: "assistant",
              content: [],
            };
            if (eventNumber === EVENTS + 1) {
              kind = "item";
              bytes = frame("response.output_item.done", {
                type: "response.output_item.done",
                output_index: 0,
                item,
              });
            } else if (eventNumber === EVENTS + 2) {
              kind = "completed";
              bytes = frame("response.completed", {
                type: "response.completed",
                response: {
                  id: "fixture-" + id,
                  status: "completed",
                  output: [],
                },
              });
            } else {
              kind = "done";
              bytes = frame(null, "[DONE]");
            }
          }

          log.add({
            type: "upstream-pull",
            run,
            id,
            n: eventNumber,
            kind,
            bytes: bytes.byteLength,
          });
          controller.enqueue(bytes);
          eventNumber++;
          if (kind === "done") controller.close();
        },
      }), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

  const cleanup = resources.register(`fixture ${run}`, async () => {
    await server.stop(true);
  });
  return {
    url: server.url.toString().replace(/\/$/, ""),
    stop: cleanup.stop,
  };
}

class IdParser {
  private decoder = new TextDecoder();
  private buffer = "";
  private id?: string;

  push(bytes: Uint8Array): void {
    this.buffer += this.decoder.decode(bytes, { stream: true });
    if (this.buffer.length > 128 * 1024 && !this.buffer.includes("\n\n")) {
      throw new Error("SSE frame bound");
    }

    for (let cut; (cut = this.buffer.indexOf("\n\n")) >= 0;) {
      const block = this.buffer.slice(0, cut);
      this.buffer = this.buffer.slice(cut + 2);
      const data = block
        .split(/\r?\n/)
        .filter(line => line.startsWith("data:"))
        .map(line => line.slice(5).trimStart())
        .join("\n");
      if (data.includes("\"type\":\"response.completed\"")) {
        const parsed = JSON.parse(data) as { response?: { id?: unknown } };
        if (typeof parsed.response?.id === "string") this.id = parsed.response.id;
      }
    }
  }

  finish(): string {
    this.push(new Uint8Array());
    if (!this.id) throw new Error("completion id missing");
    return this.id;
  }
}

type State = { client: number; previous?: string };

async function oneTurn(
  base: string,
  run: string,
  wave: number,
  state: State,
  log: Log,
): Promise<void> {
  const turn = wave + 1;
  const started = Date.now();
  log.add({
    type: "client-start",
    run,
    wave,
    client: state.client,
    turn,
    previous: state.previous ?? null,
  });

  const response = await interruptible(fetch(base + "/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Responses admission intentionally does not accept a caller Bearer token.
      "x-opencodex-api-key": "fixture-admission",
    },
    body: JSON.stringify({
      model: "fixture/fixture-model",
      input: "fixture-" + state.client + "-" + turn,
      stream: true,
      ...(state.previous ? { previous_response_id: state.previous } : {}),
    }),
  }));
  log.add({
    type: "client-http",
    run,
    wave,
    client: state.client,
    turn,
    status: response.status,
    body: response.body !== null,
  });
  // The status receipt is durable before this throws, so auth/routing failures remain auditable.
  if (response.status !== 200 || !response.body) {
    throw new Error("HTTP " + response.status);
  }

  // Chunk-wise backpressure is the measured mechanism; response.text() would erase it.
  const reader = response.body.getReader();
  const parser = new IdParser();
  let chunk = 0;
  let prior = Date.now();
  for (;;) {
    const part = await interruptible(reader.read());
    if (part.done) break;
    const now = Date.now();
    parser.push(part.value);
    log.add({
      type: "client-chunk",
      run,
      wave,
      client: state.client,
      turn,
      chunk: ++chunk,
      bytes: part.value.byteLength,
      gapMs: now - prior,
      sinceTurnStartMs: now - started,
    });
    prior = now;
    await pause(READ_MS);
  }

  const completed = parser.finish();
  log.add({
    type: "client-end",
    run,
    wave,
    client: state.client,
    turn,
    previous: state.previous ?? null,
    completed,
    durationMs: Date.now() - started,
  });
  state.previous = completed;
}

async function workload(base: string, run: string, log: Log): Promise<void> {
  // These three chain heads persist across all ten waves: one turn per client per wave.
  const states: State[] = Array.from({ length: CLIENTS }, (_, index) => ({ client: index + 1 }));
  const origin = performance.now();
  log.add({
    type: "workload-origin",
    run,
    wallMs: Date.now(),
    monotonicMs: origin,
  });

  for (let wave = 0; wave < WAVES; wave++) {
    await pause(Math.max(0, origin + wave * WAVE_MS - performance.now()));
    await Promise.all(states.map(state => oneTurn(base, run, wave, state, log)));
  }
}

type Child = {
  process: Bun.Subprocess;
  base: string;
  drain: Promise<void>;
  stop: () => Promise<void>;
};

function childStderr(path: string): string {
  try {
    if (!existsSync(path)) return "<no child stderr>";
    const text = readFileSync(path, "utf8").trim();
    return text ? text.slice(-4_000) : "<empty child stderr>";
  } catch (error) {
    return `<child stderr unreadable: ${String(error)}>`;
  }
}

async function stopChildProcess(
  processHandle: Bun.Subprocess,
  drain: Promise<void>,
): Promise<void> {
  const errors: unknown[] = [];
  if (processHandle.exitCode === null) {
    try {
      processHandle.kill("SIGTERM");
    } catch (error) {
      errors.push(error);
    }
  }

  try {
    await Promise.race([processHandle.exited, Bun.sleep(5_000)]);
  } catch (error) {
    errors.push(error);
  }
  if (processHandle.exitCode === null) {
    try {
      processHandle.kill("SIGKILL");
      await processHandle.exited;
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await drain;
  } catch (error) {
    errors.push(error);
  }
  if (processHandle.exitCode !== 0) {
    errors.push(new Error(`child exit code ${String(processHandle.exitCode)}`));
  }
  if (errors.length > 0) throw new AggregateError(errors, "child cleanup failed");
}

async function startChild(
  condition: Condition,
  url: string,
  dir: string,
  sampler: boolean,
): Promise<Child> {
  throwIfInterrupted();
  const real = condition === "real-proxy-legacy-tee";
  const args = real
    ? [
      create(dir, join(dir, "opencodex"), true),
      create(dir, join(dir, "codex"), true),
      url,
      join(dir, "child.jsonl"),
      sampler ? "on" : "off",
    ]
    : [
      url,
      join(dir, "child.jsonl"),
      join(dir, "child-events.jsonl"),
      condition,
      sampler ? "on" : "off",
    ];
  const stderrPath = join(dir, "child.stderr.log");
  const processHandle = Bun.spawn([
    globalThis.process.execPath,
    join(
      import.meta.dir,
      real
        ? "macos-rss-retention-harness-child.ts"
        : "macos-rss-retention-single-reader-child.ts",
    ),
    ...args,
  ], {
    stdout: "pipe",
    stderr: Bun.file(stderrPath),
  });

  const reader = processHandle.stdout.getReader();
  let port: number | undefined;
  let ready!: () => void;
  const signal = new Promise<void>((resolveReady) => {
    ready = resolveReady;
  });
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
          const value = JSON.parse(line) as { type?: string; port?: number };
          if (value.type === "ready" && value.port) {
            port = value.port;
            ready();
          }
        } catch {
          // The real server emits human-readable startup lines before its readiness receipt.
        }
      }
    }
  })();

  // Registration happens before the first readiness await, closing the spawn-to-ready leak window.
  const cleanup = resources.register(`child ${condition}`, async () => {
    await stopChildProcess(processHandle, drain);
  });

  try {
    await interruptible(Promise.race([
      signal,
      processHandle.exited.then(() => {
        throw new Error("child exited before ready");
      }),
      drain.then(() => {
        if (!port) throw new Error("child stdout closed before ready");
      }),
      Bun.sleep(15_000).then(() => {
        throw new Error("readiness timeout");
      }),
    ]));
    if (!port) throw new Error("readiness missing");
  } catch (error) {
    const failures: unknown[] = [];
    try {
      await cleanup.stop();
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    // Read after termination so the redirected descriptor has flushed its final diagnostics.
    failures.unshift(new Error(
      `${error instanceof Error ? error.message : String(error)}; child stderr: ${childStderr(stderrPath)}`,
      { cause: error },
    ));
    throw failures.length === 1
      ? failures[0]
      : new AggregateError(failures, "child readiness and cleanup failed");
  }

  return {
    process: processHandle,
    base: "http://127.0.0.1:" + port,
    drain,
    stop: cleanup.stop,
  };
}

async function stopChild(child: Child): Promise<void> {
  await child.stop();
}

type Observers = { stop: () => Promise<void> };

function observers(
  pid: number,
  run: string,
  log: Log,
  phase: () => string,
): Observers {
  throwIfInterrupted();
  let stopped = false;
  const origin = performance.now();
  let sampleNumber = 0;
  let previousCpu = process.cpuUsage();
  const parent = setInterval(() => {
    const actual = performance.now();
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage(previousCpu);
    previousCpu = process.cpuUsage();
    const scheduled = origin + sampleNumber * 200;
    log.add({
      type: "parent-sample",
      run,
      phase: phase(),
      rss: memory.rss,
      cpuUser: cpu.user,
      cpuSystem: cpu.system,
      scheduled,
      actual,
      latenessMs: actual - scheduled,
    });
    sampleNumber++;
  }, 200);

  const ps = (async () => {
    while (!stopped) {
      const child = Bun.spawn(["ps", "-o", "rss=", "-p", String(pid)], {
        stdout: "pipe",
      });
      const text = await new Response(child.stdout).text();
      await child.exited;
      log.add({
        type: "ps-rss",
        run,
        phase: phase(),
        rss: Number(text.trim()) * 1024,
      });
      // This local wait must remain cleanable even after the session AbortSignal fires.
      await Bun.sleep(1_000);
    }
  })();

  const cleanup = resources.register(`observers ${run}`, async () => {
    stopped = true;
    clearInterval(parent);
    await ps;
  });
  return { stop: cleanup.stop };
}

function combinedFailure(message: string, errors: unknown[]): unknown | undefined {
  if (errors.length === 0) return undefined;
  if (errors.length === 1) return errors[0];
  return new AggregateError(errors, message);
}

async function execute(root: string, log: Log, run: Run): Promise<void> {
  const dir = create(root, join(root, "runs", run.id), true);
  run.series = join(dir, "child.jsonl");
  let phase = "startup";
  let upstream: Fixture | undefined;
  let measured: Child | undefined;
  let watch: Observers | undefined;
  const errors: unknown[] = [];

  try {
    upstream = fixture(log, run.id);
    measured = await startChild(run.condition, upstream.url, dir, run.sampler);
    watch = observers(measured.process.pid, run.id, log, () => phase);
    log.add({
      type: "run-start",
      run: run.id,
      condition: run.condition,
      kind: run.kind,
      sampler: run.sampler,
      host: host(),
      clients: 3,
      turns: 10,
      events: EVENTS,
      eventBytes: EVENT_BYTES,
      waveMs: WAVE_MS,
      readMs: READ_MS,
    });

    phase = "warm";
    const warmWall = Date.now();
    const warm = performance.now();
    log.add({ type: "warm-start", run: run.id });
    await pause(WARM);
    const warmActualMs = performance.now() - warm;
    const warmWallActualMs = Date.now() - warmWall;
    const warmExitCode = measured.process.exitCode;
    log.add({
      type: "warm-end",
      run: run.id,
      actualMs: warmActualMs,
      wallActualMs: warmWallActualMs,
      exitCodeAtGate: warmExitCode,
    });
    if (warmExitCode !== null) {
      throw new Error(`child exited during warm: exit code ${warmExitCode}`);
    }
    if (warmActualMs < WARM) {
      throw new Error(`warm duration invalid: ${warmActualMs}ms < ${WARM}ms`);
    }

    if (run.kind === "workload") {
      phase = "workload";
      await workload(measured.base, run.id, log);
      phase = "settle";
      const start = performance.now();
      for (const seconds of SETTLE) {
        await pause(Math.max(0, start + seconds * 1_000 - performance.now()));
        log.add({ type: "settle", run: run.id, seconds });
      }
    } else {
      phase = "observation";
      const observationWall = Date.now();
      const start = performance.now();
      log.add({ type: "observation-start", run: run.id });
      await pause(OBSERVE);
      const observationActualMs = performance.now() - start;
      log.add({
        type: "observation-end",
        run: run.id,
        actualMs: observationActualMs,
        wallActualMs: Date.now() - observationWall,
      });
      if (observationActualMs < OBSERVE) {
        throw new Error(
          `observation duration invalid: ${observationActualMs}ms < ${OBSERVE}ms`,
        );
      }
      log.add({
        type: "client-cadence",
        run: run.id,
        chunks: 0,
        bytes: 0,
        meanGapMs: null,
      });
    }

    if (measured.process.exitCode !== null) throw new Error("child exited");
  } catch (error) {
    errors.push(error);
  }

  // Cleanup steps are independent: every later resource is attempted even if an earlier one fails.
  if (watch) {
    try {
      await watch.stop();
    } catch (error) {
      errors.push(error);
    }
  }
  if (measured) {
    try {
      await stopChild(measured);
    } catch (error) {
      errors.push(error);
    }
  }
  if (upstream) {
    try {
      await upstream.stop();
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    log.add({
      type: "run-end",
      run: run.id,
      exitCode: measured?.process.exitCode ?? null,
    });
  } catch (error) {
    errors.push(error);
  }

  const failure = combinedFailure(`run ${run.id} failed`, errors);
  if (failure) throw failure;
}

function rows(path: string): Row[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as Row;
      } catch (error) {
        throw new Error(`malformed JSONL line ${index + 1}: ${String(error)}`);
      }
    });
}

const med = (values: number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (!sorted.length) throw new Error("empty median");
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

// Ordinary least squares must centre on arithmetic means. Median centring would
// silently corrupt the sampler budget, no-load envelope, and retention verdict.
function slope(values: Array<{ x: number; y: number }>): number {
  if (values.length < 2) return 0;
  const meanX = values.reduce((sum, point) => sum + point.x, 0) / values.length;
  const meanY = values.reduce((sum, point) => sum + point.y, 0) / values.length;
  const numerator = values.reduce(
    (sum, point) => sum + (point.x - meanX) * (point.y - meanY),
    0,
  );
  const denominator = values.reduce(
    (sum, point) => sum + (point.x - meanX) ** 2,
    0,
  );
  return denominator ? numerator / denominator : 0;
}

/**
 * Calibration and controls establish all later budgets and envelopes, so sampler
 * degradation in any sampler-on run must invalidate the session immediately.
 */
function assertSamplerIntegrity(run: Run): void {
  const self = rows(run.series);
  if (self.length < 2) throw new Error(`sampler empty: ${run.id}`);
  const late = self.map(row => Number(row.latenessMs)).sort((left, right) => left - right);
  const p99 = late[Math.min(late.length - 1, Math.floor(late.length * 0.99))]!;
  if (p99 > 200) {
    throw new Error(`sampler p99 lateness ${Math.round(p99)}ms: ${run.id}`);
  }
  for (let index = 1; index < self.length; index++) {
    if (Number(self[index]!.wallMs) - Number(self[index - 1]!.wallMs) > 1_000) {
      throw new Error(`sampler gap >1s: ${run.id}`);
    }
  }
}

function calibrationVerdict(all: Row[], runs: Run[]) {
  if (runs.some((run, index) => run.sampler !== ORDER[index])) {
    throw new Error("calibration order");
  }
  runs.filter(run => run.sampler).forEach(assertSamplerIntegrity);

  const stat = (run: Run) => {
    const samples = all
      .filter(row => (
        row.run === run.id
        && row.type === "ps-rss"
        && row.phase === "observation"
      ))
      .map(row => ({ x: row.wallMs, y: Number(row.rss) }));
    // Derive the floor from OBSERVE rather than hard-coding 590: the `ps` observer
    // ticks once per second, and allowing ~2% slack absorbs scheduler jitter without
    // accepting a truncated run. A hard-coded count silently becomes wrong the moment
    // the observation window changes.
    const expected = Math.floor((OBSERVE / 1_000) * 0.98);
    if (samples.length < expected) {
      throw new Error(`calibration incomplete: ${samples.length} < ${expected} ps samples`);
    }
    return {
      final: samples.at(-1)!.y,
      peak: Math.max(...samples.map(sample => sample.y)),
      slope: slope(samples) * 60_000 / MiB,
    };
  };

  for (const run of runs.filter(candidate => candidate.sampler)) {
    const self = rows(run.series);
    const osSamples = all.filter(row => row.run === run.id && row.type === "ps-rss");
    let cursor = 0;
    let bad = 0;
    for (const osSample of osSamples) {
      while (
        cursor + 1 < self.length
        && Math.abs(self[cursor + 1]!.wallMs - osSample.wallMs)
          <= Math.abs(self[cursor]!.wallMs - osSample.wallMs)
      ) {
        cursor++;
      }
      const sample = self[cursor];
      const rss = Number(sample?.rss);
      if (!sample || Math.abs(sample.wallMs - osSample.wallMs) > 600) {
        throw new Error("alignment missing");
      }
      bad = Math.abs(rss - Number(osSample.rss)) > Math.max(8 * MiB, rss * 0.01)
        ? bad + 1
        : 0;
      if (bad >= 3) throw new Error("telemetry integrity");
    }
  }

  const on = runs.filter(run => run.sampler).map(stat);
  const off = runs.filter(run => !run.sampler).map(stat);
  const final = med(on.map(value => value.final)) - med(off.map(value => value.final));
  const peak = med(on.map(value => value.peak)) - med(off.map(value => value.peak));
  const rssSlope = med(on.map(value => value.slope)) - med(off.map(value => value.slope));
  if (final > 8 * MiB || peak > 16 * MiB || rssSlope > 0.5) {
    throw new Error("sampler budget");
  }
  return { passed: true, final, peak, rssSlope };
}

function validateWorkload(all: Row[], run: Run): void {
  assertSamplerIntegrity(run);
  const manifest = all.filter(row => row.run === run.id);
  const starts = manifest.filter(row => row.type === "client-start");
  const ends = manifest.filter(row => row.type === "client-end");
  const http = manifest.filter(row => row.type === "client-http");
  if (
    Number(manifest.find(row => row.type === "warm-end")?.actualMs) < WARM
    || starts.length !== TURNS
    || ends.length !== TURNS
    || http.some(row => row.status !== 200)
    || manifest.filter(row => row.type === "upstream-pull" && row.kind === "delta").length
      !== TURNS * EVENTS
    || manifest.filter(row => row.type === "settle").length !== SETTLE.length
  ) {
    throw new Error("shape invalid");
  }

  for (let client = 1; client <= 3; client++) {
    const chain = ends
      .filter(row => row.client === client)
      .sort((left, right) => Number(left.turn) - Number(right.turn));
    for (let index = 1; index < chain.length; index++) {
      if (chain[index]!.previous !== chain[index - 1]!.completed) {
        throw new Error("chain");
      }
    }
  }

  // Intra-wave concurrency alone cannot detect a slid schedule, so every wave is
  // anchored to the pre-recorded origin plus its locked 120-second offset.
  const origin = Number(manifest.find(row => row.type === "workload-origin")?.wallMs);
  if (!origin) throw new Error("missing workload origin");
  for (let wave = 0; wave < WAVES; wave++) {
    const waveStarts = starts.filter(row => row.wave === wave);
    const waveEnds = ends.filter(row => row.wave === wave);
    if (
      waveStarts.length !== 3
      || waveEnds.length !== 3
      || Math.max(...waveStarts.map(row => row.wallMs))
        - Math.min(...waveStarts.map(row => row.wallMs)) > 1_000
      || Math.min(...waveEnds.map(row => row.wallMs))
        <= Math.max(...waveStarts.map(row => row.wallMs))
    ) {
      throw new Error("concurrency");
    }
    const target = origin + wave * WAVE_MS;
    const drift = Math.max(
      ...waveStarts.map(row => Math.abs(Number(row.wallMs) - target)),
    );
    if (drift > WAVE_TOLERANCE_MS) {
      throw new Error(
        `wave ${wave} drift ${Math.round(drift)}ms > ${WAVE_TOLERANCE_MS}ms`,
      );
    }
  }

  for (const kind of ["created", "item", "completed", "done"]) {
    if (
      manifest.filter(row => row.type === "upstream-pull" && row.kind === kind).length
      !== TURNS
    ) {
      throw new Error("fixture event count");
    }
  }

  const self = rows(run.series);
  const late = self.map(row => Number(row.latenessMs)).sort((left, right) => left - right);
  if (late[Math.ceil(late.length * 0.99) - 1]! > 200) {
    throw new Error("p99 lateness");
  }
  for (const start of starts) {
    const end = ends.find(row => (
      row.client === start.client && row.turn === start.turn
    ))!;
    const timeline = [
      start.wallMs,
      ...self
        .filter(row => row.wallMs >= start.wallMs && row.wallMs <= end.wallMs)
        .map(row => row.wallMs),
      end.wallMs,
    ];
    if (timeline.some((value, index) => (
      index > 0 && value - timeline[index - 1]! > 1_000
    ))) {
      throw new Error("active sampler gap");
    }
  }
}

type MetricField = "rss" | "external" | "arrayBuffers";

function analysis(
  all: Row[],
  _calibration: Run[],
  controls: Run[],
  work: Run[],
) {
  work.forEach(run => validateWorkload(all, run));

  const envelope = (run: Run, field: MetricField) => {
    const observationEnd = all.find(row => (
      row.run === run.id && row.type === "observation-end"
    ));
    const start = Number(all.find(row => (
      row.run === run.id && row.type === "observation-start"
    ))?.wallMs);
    const end = Number(observationEnd?.wallMs);
    if (!start || !end || Number(observationEnd?.actualMs) < OBSERVE) {
      throw new Error("observation interval");
    }

    const points = (field === "rss"
      ? all
        .filter(row => row.run === run.id && row.type === "ps-rss")
        .map(row => ({ x: row.wallMs, y: Number(row.rss) }))
      : rows(run.series).map(row => ({ x: row.wallMs, y: Number(row[field]) })))
      .filter(point => point.x >= start && point.x <= end);
    const baseline = med(
      points.filter(point => point.x - points[0]!.x <= 60_000).map(point => point.y),
    );
    let slopeEnvelope = 0;
    for (const point of points) {
      const window = points.filter(candidate => (
        candidate.x >= point.x && candidate.x <= point.x + 120_000
      ));
      if (
        window.length > 1
        && window.at(-1)!.x - window[0]!.x >= 119_000
      ) {
        slopeEnvelope = Math.max(slopeEnvelope, Math.abs(slope(window)));
      }
    }
    return {
      upper: Math.max(...points.map(point => point.y - baseline)),
      slope: slopeEnvelope,
    };
  };

  // Envelopes are condition-local. Proxy calibration noise must never mask a control delta.
  const environments = Object.fromEntries(CONDITIONS.map((condition) => {
    const own = controls.filter(run => run.condition === condition);
    if (own.length < 3) {
      throw new Error(`need 3 no-load controls for ${condition}, got ${own.length}`);
    }
    own.forEach(assertSamplerIntegrity);
    return [
      condition,
      Object.fromEntries(([
        "rss",
        "external",
        "arrayBuffers",
      ] as const).map((field) => {
        const candidates = own.map(run => envelope(run, field));
        return [field, {
          upper: Math.max(...candidates.map(value => value.upper)),
          slope: Math.max(...candidates.map(value => value.slope)),
        }];
      })),
    ];
  })) as Record<
    Condition,
    Record<MetricField, { upper: number; slope: number }>
  >;

  const metric = (run: Run, field: MetricField) => {
    const manifest = all.filter(row => row.run === run.id);
    const warmStart = Number(manifest.find(row => row.type === "warm-start")?.wallMs);
    const warmEnd = Number(manifest.find(row => row.type === "warm-end")?.wallMs);
    const loadStart = Number(manifest.find(row => row.type === "client-start")?.wallMs);
    const at = (seconds: number): number => Number(manifest.find(row => (
      row.type === "settle" && row.seconds === seconds
    ))?.wallMs);
    const points = field === "rss"
      ? manifest
        .filter(row => row.type === "ps-rss")
        .map(row => ({ x: row.wallMs, y: Number(row.rss) }))
      : rows(run.series).map(row => ({ x: row.wallMs, y: Number(row[field]) }));
    const baseline = med(
      points
        .filter(point => point.x >= warmStart && point.x <= warmEnd)
        .map(point => point.y),
    );
    const peak = Math.max(
      ...points
        .filter(point => point.x >= loadStart && point.x <= at(600))
        .map(point => point.y),
    ) - baseline;
    const residuals = Object.fromEntries(SETTLE.map(seconds => [
      seconds,
      points.reduce((best, point) => (
        Math.abs(point.x - at(seconds)) < Math.abs(best.x - at(seconds))
          ? point
          : best
      )).y - baseline,
    ])) as Record<string, number>;
    const settle = points.filter(point => point.x >= at(120) && point.x <= at(600));
    return {
      baseline,
      peak,
      residuals,
      slope120To600: slope(settle),
    };
  };

  const values = Object.fromEntries(work.map(run => [run.id, {
    rss: metric(run, "rss"),
    external: metric(run, "external"),
    arrayBuffers: metric(run, "arrayBuffers"),
  }])) as Record<
    string,
    Record<MetricField, ReturnType<typeof metric>>
  >;
  const detectable = Object.fromEntries(CONDITIONS.map(condition => [
    condition,
    Object.fromEntries(([
      "rss",
      "external",
      "arrayBuffers",
    ] as const).map(field => [
      field,
      work
        .filter(run => run.condition === condition)
        .every(run => values[run.id]![field].peak > environments[condition][field].upper),
    ])),
  ]));
  const peaks = (condition: Condition): number[] => work
    .filter(run => run.condition === condition)
    .map(run => values[run.id]!.rss.peak);
  const delta = med(peaks("real-proxy-legacy-tee"))
    - med(peaks("single-reader-inspection"));
  const combined = environments["real-proxy-legacy-tee"].rss.upper
    + environments["single-reader-inspection"].rss.upper;

  return {
    valid: true,
    envelopes: environments,
    values,
    detectable,
    exceedsCombinedEnvelope: delta > combined,
    teeOnlyAttributionAllowed: false,
    requiredLanguage: delta > combined
      ? "measurable topology delta; tee-only attribution prohibited"
      : "no measurable topology delta under this profile",
    allocatorRetention: work.map(run => ({
      run: run.id,
      signature: values[run.id]!.external.residuals["600"]
          <= environments[run.condition].external.upper
        && values[run.id]!.arrayBuffers.residuals["600"]
          <= environments[run.condition].arrayBuffers.upper
        && values[run.id]!.rss.residuals["600"]
          > environments[run.condition].rss.upper
        && values[run.id]!.rss.slope120To600
          >= -environments[run.condition].rss.slope,
    })),
  };
}

function writeSummary(root: string, value: unknown): void {
  const temporary = join(root, "summary.json.tmp-" + process.pid);
  // A smoke run is a plumbing check, never evidence: stamp it so no later phase can
  // read a shortened series as a measurement.
  const stamped = SMOKE && value && typeof value === "object"
    ? { ...(value as Record<string, unknown>), smoke: true, valid: false }
    : value;
  writeFileSync(temporary, JSON.stringify(stamped, null, 2) + "\n", { mode: 0o600 });
  renameSync(temporary, join(root, "summary.json"));
}

async function main(): Promise<void> {
  const mode = Bun.argv[Bun.argv.indexOf("--mode") + 1] as
    | "calibration"
    | "parent-pressure"
    | "workload";
  if (!["calibration", "parent-pressure", "workload"].includes(mode)) {
    throw new Error("--mode required");
  }

  const outputIndex = Bun.argv.indexOf("--output");
  const root = outputRoot(outputIndex >= 0 ? Bun.argv[outputIndex + 1] : undefined);
  const log = new Log(join(root, "manifest.jsonl"));
  const onSigint = (): void => beginSignalCleanup("SIGINT");
  const onSigterm = (): void => beginSignalCleanup("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    const allRuns: Run[] = [];
    const run = async (value: Run): Promise<void> => {
      await execute(root, log, value);
      allRuns.push(value);
    };
    const failures: unknown[] = [];
    let summary: unknown;

    log.add({
      type: "session-start",
      mode,
      wallClockStart: new Date().toISOString(),
      host: host(),
    });

    try {
      for (let index = 0; index < 6; index++) {
        await run({
          id: "cal-" + (index + 1) + "-" + (ORDER[index] ? "on" : "off"),
          condition: "real-proxy-legacy-tee",
          kind: "calibration",
          sampler: ORDER[index]!,
          series: "",
        });
      }
      await log.flush();
      const calibrated = calibrationVerdict(rows(log.path), allRuns);

      if (mode === "calibration") {
        summary = { valid: true, calibrated };
      } else {
        const controls: Run[] = [];
        for (const condition of CONDITIONS) {
          for (let replica = 1; replica <= 3; replica++) {
            const control: Run = {
              id: "control-" + condition + "-" + replica,
              condition,
              kind: "parent-pressure",
              sampler: true,
              series: "",
            };
            await run(control);
            // Parent-pressure mode never reaches analysis(), so controls are checked here too.
            assertSamplerIntegrity(control);
            controls.push(control);
          }
        }

        if (mode === "parent-pressure") {
          summary = { valid: true, calibrated, controls };
        } else {
          const work: Run[] = [];
          for (let replica = 0; replica < 3; replica++) {
            for (const condition of LATIN[replica]!) {
              const workloadRun: Run = {
                id: "r" + (replica + 1) + "-" + condition,
                condition,
                kind: "workload",
                sampler: true,
                series: "",
              };
              await run(workloadRun);
              work.push(workloadRun);
            }
          }
          await log.flush();
          summary = {
            valid: true,
            calibrated,
            analysis: analysis(rows(log.path), allRuns.slice(0, 6), controls, work),
          };
        }
      }
    } catch (error) {
      failures.push(error);
    }

    if (signalCleanup) await signalCleanup;
    if (signalCleanupFailure) failures.push(signalCleanupFailure);
    try {
      await resources.stopAll();
    } catch (error) {
      failures.push(error);
    }

    let failure = combinedFailure("measurement session failed", failures);
    if (failure) {
      try {
        log.add({ type: "session-failed", error: String(failure) });
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      log.add({
        type: "session-end",
        wallClockEnd: new Date().toISOString(),
      });
    } catch (error) {
      failures.push(error);
    }
    try {
      await log.close();
    } catch (error) {
      failures.push(error);
    }
    failure = combinedFailure("measurement session failed", failures);

    if (failure) {
      try {
        writeSummary(root, { valid: false, error: String(failure) });
      } catch (summaryError) {
        throw new AggregateError([failure, summaryError], "failure summary write failed");
      }
      throw failure;
    }
    if (summary === undefined) {
      const error = new Error("summary missing");
      writeSummary(root, { valid: false, error: String(error) });
      throw error;
    }

    try {
      writeSummary(root, summary);
    } catch (error) {
      const outputFailure = new Error("summary output failed", { cause: error });
      try {
        writeSummary(root, { valid: false, error: String(outputFailure) });
      } catch (invalidSummaryError) {
        throw new AggregateError(
          [outputFailure, invalidSummaryError],
          "summary and invalidation output failed",
        );
      }
      throw outputFailure;
    }
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}

await main();
