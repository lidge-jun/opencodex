/**
 * #820 concurrent recall acceptance/profiling probe.
 *
 * This is intentionally an offline probe, not a normal test/CI job. The parent
 * owns the mock provider and load generator; a child process owns the real
 * OpenCodex proxy so RSS samples do not include the clients that create load.
 *
 * Full defaults exercise 32 sustained independent sessions for 10 barrier-
 * synchronized recall rounds, three identical waves, a 64-session burst, slow
 * consumers, parallel tool latency, and a fault wave. RSS is evidence only:
 * cleanup assertions use OpenCodex-owned counters, while process-memory slopes
 * are reported for leak-vs-allocator-retention analysis.
 */
import { join } from "node:path";
import {
  deterministicPercent,
  deterministicToolCount,
  linearSlope,
  memoryRecallSoakUsage,
  parseMemoryRecallSoakOptions,
  stableHash,
  type MemoryRecallSoakOptions,
} from "./memory-recall-soak-lib";

interface ChildReady {
  type: "ready";
  proxyUrl: string;
  controlUrl: string;
  pid: number;
  platform: string;
  bunVersion: string;
  bunRevision: string;
}

interface AppOwnedSnapshot {
  retainedBytes: number;
  evictableBytes: number;
  pinnedBytes: number;
  overBudgetBytes: number;
  observedInFlight: Record<string, { currentBytes: number; highWaterBytes: number; active: number }>;
}

interface ProbeMetrics {
  atMs: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  activeTurnCount: number;
  appOwnedBytes: AppOwnedSnapshot;
  inspectionCounters: Record<string, number>;
  responseState: Record<string, number>;
}

interface MetricPeaks {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  activeTurnCount: number;
  retainedBytes: number;
  observedInFlightBytes: number;
  observedInFlightHighWaterBytes: number;
}

interface WaveResult {
  name: string;
  sessions: number;
  rounds: number;
  completedSessions: number;
  failedSessions: number;
  requestCount: number;
  toolCallCount: number;
  peaks: MetricPeaks;
  idle: ProbeMetrics;
  durationMs: number;
}

interface SessionState {
  id: string;
  input: Array<Record<string, unknown>>;
  slow: boolean;
  requests: number;
  toolCalls: number;
  failure?: string;
}

type FaultKind = "cancel" | "http_429" | "http_503" | "pre_first_byte_stream_error";

type CompletedResponse = {
  id?: string;
  status?: string;
  output?: Array<Record<string, unknown>>;
};

const encoder = new TextEncoder();
const args = Bun.argv.slice(2);
if (args.includes("--help")) {
  console.log(memoryRecallSoakUsage());
  process.exit(0);
}

let options: MemoryRecallSoakOptions;
try {
  options = parseMemoryRecallSoakOptions(args);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(memoryRecallSoakUsage());
  process.exit(2);
}

function emit(event: Record<string, unknown>): void {
  console.log(JSON.stringify(event));
}

function sessionMarker(sessionId: string): string {
  return `OCX_MEMORY_SOAK_SESSION_${sessionId}`;
}

function roundMarker(round: number): string {
  return `OCX_MEMORY_SOAK_ROUND_${round}_DONE`;
}

function extractSessionId(body: unknown): string {
  const text = JSON.stringify(body);
  const match = text.match(/OCX_MEMORY_SOAK_SESSION_([A-Za-z0-9_-]{1,80})/);
  return match?.[1] ?? "unknown";
}

function extractRound(body: unknown): number {
  const text = JSON.stringify(body);
  let maximum = -1;
  for (const match of text.matchAll(/OCX_MEMORY_SOAK_ROUND_(\d+)_DONE/g)) {
    const value = Number(match[1]);
    if (Number.isSafeInteger(value)) maximum = Math.max(maximum, value);
  }
  return maximum + 1;
}

function advertisedToolNames(body: Record<string, unknown>): string[] {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const names: string[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) continue;
    const fn = (tool as Record<string, unknown>).function;
    if (!fn || typeof fn !== "object" || Array.isArray(fn)) continue;
    const name = (fn as Record<string, unknown>).name;
    if (typeof name === "string" && name) names.push(name);
  }
  return names;
}

function orderedToolNames(names: readonly string[]): string[] {
  // extractRound advances from markers written by function/custom outputs. Keep a
  // marker-producing tool first so every non-empty 1..N selection advances the round.
  const ordinary = names.filter(name => !/apply_patch|tool_search/i.test(name));
  const special = names.filter(name => /apply_patch|tool_search/i.test(name));
  return [...ordinary, ...special];
}

function toolArguments(name: string, sessionId: string, round: number, index: number): string {
  if (/apply_patch/i.test(name)) {
    return JSON.stringify({ input: `*** Begin Patch\n*** Add File: soak-${round}-${index}.txt\n+probe\n*** End Patch` });
  }
  if (/tool_search/i.test(name)) {
    return JSON.stringify({ query: `probe ${round} ${index}`, limit: 3 });
  }
  return JSON.stringify({ session: sessionId, round, index, payload: "x".repeat(256 + index * 17) });
}

function faultKind(sessionId: string): FaultKind {
  const bucket = deterministicPercent(sessionId, "fault", options.seed);
  if (bucket < options.cancelPercent) return "cancel";
  const remainder = stableHash(`fault-kind:${sessionId}`, options.seed) % 3;
  return remainder === 0 ? "http_429" : remainder === 1 ? "http_503" : "pre_first_byte_stream_error";
}

function streamFrames(
  frames: readonly string[],
  jitterSeed: number,
  minimumDelayMs = 0,
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index >= frames.length) {
        controller.close();
        return;
      }
      const jitterMs = ((jitterSeed + index) & 3) === 0 ? 1 : 0;
      if (minimumDelayMs + jitterMs > 0) await Bun.sleep(minimumDelayMs + jitterMs);
      controller.enqueue(encoder.encode(frames[index++]));
    },
  });
}

function buildToolFrames(body: Record<string, unknown>): string[] {
  const sessionId = extractSessionId(body);
  const round = extractRound(body);
  const names = orderedToolNames(advertisedToolNames(body));
  if (names.length === 0) throw new Error("mock upstream received no callable tools");
  const count = deterministicToolCount(sessionId, round, options.seed);
  const selected = Array.from({ length: count }, (_, index) => names[index % names.length]);
  const starts: string[] = [];
  const finishes: string[] = [];

  for (let index = 0; index < selected.length; index++) {
    const name = selected[index];
    const toolArgs = toolArguments(name, sessionId, round, index);
    const split = Math.max(1, Math.floor(toolArgs.length / 2));
    starts.push(`data: ${JSON.stringify({
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index,
            id: `call_${stableHash(`${sessionId}:${round}:${index}`, options.seed).toString(16)}`,
            type: "function",
            function: { name, arguments: toolArgs.slice(0, split) },
          }],
        },
      }],
    })}\n\n`);
    finishes.unshift(`data: ${JSON.stringify({
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index, function: { arguments: toolArgs.slice(split) } }] },
      }],
    })}\n\n`);
  }
  return [
    ...starts,
    ...finishes,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
    "data: [DONE]\n\n",
  ];
}

function buildCancelFrames(sessionId: string): string[] {
  const frames = Array.from({ length: 128 }, (_, index) => `data: ${JSON.stringify({
    choices: [{
      index: 0,
      delta: {
        ...(index === 0 ? { role: "assistant" } : {}),
        content: `${sessionId}:${index}:${"x".repeat(2 * 1024)}`,
      },
    }],
  })}\n\n`);
  frames.push(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
  frames.push("data: [DONE]\n\n");
  return frames;
}

const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (!url.pathname.endsWith("/chat/completions")) {
      return Response.json({ error: { message: "unexpected mock-provider path" } }, { status: 404 });
    }
    let body: Record<string, unknown>;
    try {
      body = await req.json() as Record<string, unknown>;
    } catch {
      return Response.json({ error: { message: "invalid mock-provider body" } }, { status: 400 });
    }
    const sessionId = extractSessionId(body);
    if (sessionId.startsWith("fault-")) {
      const kind = faultKind(sessionId);
      if (kind === "http_429") {
        return Response.json({ error: { message: "synthetic rate limit" } }, { status: 429 });
      }
      if (kind === "http_503") {
        return Response.json({ error: { message: "synthetic unavailable" } }, { status: 503 });
      }
      if (kind === "pre_first_byte_stream_error") {
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(new Error("synthetic pre-first-byte stream failure"));
          },
        }), { headers: { "content-type": "text/event-stream" } });
      }
      return new Response(streamFrames(buildCancelFrames(sessionId), stableHash(sessionId, options.seed), 10), {
        headers: { "content-type": "text/event-stream" },
      });
    }
    const frames = buildToolFrames(body);
    return new Response(streamFrames(frames, stableHash(sessionId, options.seed)), {
      headers: { "content-type": "text/event-stream" },
    });
  },
});

const child = Bun.spawn({
  cmd: [
    process.execPath,
    join(import.meta.dir, "memory-recall-soak-child.ts"),
    "--upstream",
    upstream.url.toString().replace(/\/$/, ""),
  ],
  cwd: join(import.meta.dir, ".."),
  stdout: "pipe",
  stderr: "pipe",
});

let resolveReady: ((value: ChildReady) => void) | null = null;
let rejectReady: ((error: Error) => void) | null = null;
const readyPromise = new Promise<ChildReady>((resolve, reject) => {
  resolveReady = resolve;
  rejectReady = reject;
});

async function consumeChildStdout(): Promise<void> {
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    if (pending.length > 16_384) pending = pending.slice(-16_384);
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (!line) continue;
      try {
        const event = JSON.parse(line) as Partial<ChildReady>;
        if (event.type === "ready" && typeof event.proxyUrl === "string" && typeof event.controlUrl === "string") {
          resolveReady?.(event as ChildReady);
          resolveReady = null;
          rejectReady = null;
        }
      } catch { /* child runtime logs are deliberately discarded */ }
    }
  }
}

async function discardChildStderr(): Promise<void> {
  const reader = child.stderr.getReader();
  while (!(await reader.read()).done) { /* drain without retaining local paths or payloads */ }
}

void consumeChildStdout().catch(error => rejectReady?.(error instanceof Error ? error : new Error(String(error))));
void discardChildStderr().catch(() => {});
void child.exited.then(code => {
  if (resolveReady) rejectReady?.(new Error(`proxy child exited before readiness with code ${code}`));
});

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function observedCurrentBytes(metrics: ProbeMetrics): number {
  return Object.values(metrics.appOwnedBytes.observedInFlight)
    .reduce((sum, row) => sum + row.currentBytes, 0);
}

function observedHighWaterBytes(metrics: ProbeMetrics): number {
  return Object.values(metrics.appOwnedBytes.observedInFlight)
    .reduce((sum, row) => sum + row.highWaterBytes, 0);
}

function metricPeaks(samples: readonly ProbeMetrics[]): MetricPeaks {
  if (samples.length === 0) throw new Error("wave collected no memory samples");
  const peaks: MetricPeaks = {
    rss: 0,
    heapUsed: 0,
    heapTotal: 0,
    external: 0,
    arrayBuffers: 0,
    activeTurnCount: 0,
    retainedBytes: 0,
    observedInFlightBytes: 0,
    observedInFlightHighWaterBytes: 0,
  };
  for (const sample of samples) {
    peaks.rss = Math.max(peaks.rss, sample.rss);
    peaks.heapUsed = Math.max(peaks.heapUsed, sample.heapUsed);
    peaks.heapTotal = Math.max(peaks.heapTotal, sample.heapTotal);
    peaks.external = Math.max(peaks.external, sample.external);
    peaks.arrayBuffers = Math.max(peaks.arrayBuffers, sample.arrayBuffers);
    peaks.activeTurnCount = Math.max(peaks.activeTurnCount, sample.activeTurnCount);
    peaks.retainedBytes = Math.max(peaks.retainedBytes, sample.appOwnedBytes.retainedBytes);
    peaks.observedInFlightBytes = Math.max(peaks.observedInFlightBytes, observedCurrentBytes(sample));
    peaks.observedInFlightHighWaterBytes = Math.max(
      peaks.observedInFlightHighWaterBytes,
      observedHighWaterBytes(sample),
    );
  }
  return peaks;
}

function mergePeaks(peaks: readonly MetricPeaks[]): MetricPeaks {
  if (peaks.length === 0) throw new Error("no wave peaks recorded");
  return peaks.reduce<MetricPeaks>((merged, current) => ({
    rss: Math.max(merged.rss, current.rss),
    heapUsed: Math.max(merged.heapUsed, current.heapUsed),
    heapTotal: Math.max(merged.heapTotal, current.heapTotal),
    external: Math.max(merged.external, current.external),
    arrayBuffers: Math.max(merged.arrayBuffers, current.arrayBuffers),
    activeTurnCount: Math.max(merged.activeTurnCount, current.activeTurnCount),
    retainedBytes: Math.max(merged.retainedBytes, current.retainedBytes),
    observedInFlightBytes: Math.max(merged.observedInFlightBytes, current.observedInFlightBytes),
    observedInFlightHighWaterBytes: Math.max(
      merged.observedInFlightHighWaterBytes,
      current.observedInFlightHighWaterBytes,
    ),
  }));
}

function tools(): Array<Record<string, unknown>> {
  const namespaceTools = Array.from({ length: 6 }, (_, index) => ({
    type: "function",
    name: `read_${index}`,
    description: `Synthetic namespace tool ${index}`,
    parameters: {
      type: "object",
      properties: {
        session: { type: "string" },
        round: { type: "integer" },
        index: { type: "integer" },
        payload: { type: "string" },
      },
      required: ["session", "round", "index", "payload"],
      additionalProperties: false,
    },
  }));
  return [
    {
      type: "namespace",
      name: "workspace",
      description: "Synthetic MCP-style namespace",
      tools: namespaceTools,
    },
    { type: "custom", name: "apply_patch", description: "Synthetic freeform patch tool" },
    {
      type: "tool_search",
      execution: "client",
      description: "Synthetic deferred-tool search",
      parameters: {
        type: "object",
        properties: { query: { type: "string" }, limit: { type: "integer" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  ];
}

function toolSearchResultTools(): Array<Record<string, unknown>> {
  return [{
    type: "namespace",
    name: "deferred",
    description: "Synthetic deferred namespace",
    tools: [{
      type: "function",
      name: "deferred_read",
      description: "Synthetic deferred read",
      defer_loading: true,
      parameters: { type: "object", properties: {}, additionalProperties: false },
    }],
  }];
}

async function readResponseText(response: Response, slow: boolean): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (slow) await Bun.sleep(4);
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

function completedResponseFromSse(text: string): CompletedResponse | null {
  let completed: CompletedResponse | null = null;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const event = JSON.parse(data) as { type?: string; response?: CompletedResponse };
      if (event.type === "response.completed" && event.response) completed = event.response;
    } catch { /* malformed frames are validated by the absence of a completed response */ }
  }
  return completed;
}

function callableItems(output: readonly Record<string, unknown>[]): Array<Record<string, unknown>> {
  return output.filter(item => item.type === "function_call" || item.type === "custom_tool_call" || item.type === "tool_search_call");
}

function appendRecallOutput(input: Array<Record<string, unknown>>, item: Record<string, unknown>, round: number): void {
  input.push(item);
  const callId = typeof item.call_id === "string" ? item.call_id : null;
  if (!callId) throw new Error(`completed ${String(item.type)} item omitted call_id`);
  const marker = `${roundMarker(round)} ok`;
  if (item.type === "custom_tool_call") {
    input.push({ type: "custom_tool_call_output", call_id: callId, output: marker });
    return;
  }
  if (item.type === "tool_search_call") {
    input.push({
      type: "tool_search_output",
      call_id: callId,
      status: "completed",
      execution: "client",
      tools: toolSearchResultTools(),
    });
    return;
  }
  input.push({ type: "function_call_output", call_id: callId, output: marker });
}

function makeSessionState(workloadKey: string, index: number): SessionState {
  const id = `${workloadKey}-${index}`;
  return {
    id,
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `${sessionMarker(id)} run the synthetic tools` }],
    }],
    slow: deterministicPercent(id, "slow", options.seed) < options.slowConsumerPercent,
    requests: 0,
    toolCalls: 0,
  };
}

async function runSessionRound(state: SessionState, round: number, proxyBase: URL): Promise<void> {
  state.requests += 1;
  const response = await fetch(new URL("/v1/responses", proxyBase), {
    method: "POST",
    signal: AbortSignal.timeout(options.idleDeadlineMs),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "mock/test-model",
      stream: true,
      store: false,
      input: state.input,
      tools: tools(),
      tool_choice: "auto",
    }),
  });
  if (response.status !== 200) {
    const detail = (await response.text()).slice(0, 240);
    throw new Error(`round ${round} returned HTTP ${response.status}: ${detail}`);
  }
  const text = await readResponseText(response, state.slow);
  const completed = completedResponseFromSse(text);
  if (!completed || completed.status !== "completed" || !Array.isArray(completed.output)) {
    throw new Error(`round ${round} did not produce response.completed`);
  }
  const calls = callableItems(completed.output);
  const expected = deterministicToolCount(state.id, round, options.seed);
  if (calls.length !== expected) {
    throw new Error(`round ${round} completed ${calls.length} tool calls; expected ${expected}`);
  }
  const callIds = new Set(calls.map(item => item.call_id));
  if (callIds.size !== calls.length || callIds.has(undefined)) {
    throw new Error(`round ${round} produced missing or duplicate call ids`);
  }
  state.toolCalls += calls.length;
  for (const item of calls) appendRecallOutput(state.input, item, round);

  // Tool execution is external to OpenCodex. Model 1..N parallel tool calls by
  // delaying the recall by the slowest deterministic synthetic tool in this round.
  const parallelToolLatencyMs = calls.reduce((maximum, _item, index) => Math.max(
    maximum,
    10 + (stableHash(`tool-latency:${state.id}:${round}:${index}`, options.seed) % 491),
  ), 0);
  if (parallelToolLatencyMs > 0) await Bun.sleep(parallelToolLatencyMs);
}

async function sampleMetrics(controlBase: URL): Promise<ProbeMetrics> {
  const response = await fetch(new URL("/metrics", controlBase), {
    cache: "no-store",
    signal: AbortSignal.timeout(Math.min(5_000, options.idleDeadlineMs)),
  });
  if (!response.ok) throw new Error(`metrics endpoint returned ${response.status}`);
  return await response.json() as ProbeMetrics;
}

function idleInvariant(metrics: ProbeMetrics): boolean {
  if (metrics.activeTurnCount !== 0) return false;
  return Object.values(metrics.appOwnedBytes.observedInFlight)
    .every(row => row.currentBytes === 0 && row.active === 0);
}

async function waitForIdle(controlBase: URL): Promise<ProbeMetrics> {
  const deadline = Date.now() + options.idleDeadlineMs;
  let latest = await sampleMetrics(controlBase);
  while (!idleInvariant(latest) && Date.now() < deadline) {
    await Bun.sleep(Math.min(100, options.sampleIntervalMs));
    latest = await sampleMetrics(controlBase);
  }
  if (!idleInvariant(latest)) {
    throw new Error(`proxy did not return to app-owned idle invariants within ${options.idleDeadlineMs} ms`);
  }
  return latest;
}

async function runWave(
  name: string,
  workloadKey: string,
  sessions: number,
  rounds: number,
  proxyBase: URL,
  controlBase: URL,
): Promise<WaveResult> {
  const started = Date.now();
  const states = Array.from({ length: sessions }, (_, index) => makeSessionState(workloadKey, index));
  const samples: ProbeMetrics[] = [];
  let monitoring = true;
  const monitor = (async () => {
    while (monitoring) {
      try { samples.push(await sampleMetrics(controlBase)); } catch { /* wave outcome remains authoritative */ }
      if (monitoring) await Bun.sleep(options.sampleIntervalMs);
    }
  })();

  // The outer round loop is the barrier: every still-healthy session completes
  // its model stream plus external-tool latency before the next recall wave starts.
  for (let round = 0; round < rounds; round++) {
    const active = states.filter(state => state.failure === undefined);
    if (active.length === 0) break;
    const settled = await Promise.allSettled(active.map(state => runSessionRound(state, round, proxyBase)));
    for (let index = 0; index < settled.length; index++) {
      const outcome = settled[index];
      if (outcome.status === "rejected") {
        active[index].failure = String(
          outcome.reason instanceof Error ? outcome.reason.message : outcome.reason,
        ).slice(0, 240);
      }
    }
  }

  monitoring = false;
  await monitor;
  samples.push(await sampleMetrics(controlBase));
  const idle = await waitForIdle(controlBase);
  samples.push(idle);
  const completedSessions = states.filter(state => state.failure === undefined && state.requests === rounds).length;
  const failedSessions = states.length - completedSessions;
  const result: WaveResult = {
    name,
    sessions,
    rounds,
    completedSessions,
    failedSessions,
    requestCount: states.reduce((sum, state) => sum + state.requests, 0),
    toolCallCount: states.reduce((sum, state) => sum + state.toolCalls, 0),
    peaks: metricPeaks(samples),
    idle,
    durationMs: Date.now() - started,
  };
  emit({
    type: "WAVE",
    name,
    sessions,
    rounds,
    completedSessions,
    failedSessions,
    requestCount: result.requestCount,
    toolCallCount: result.toolCallCount,
    peaks: result.peaks,
    idleRss: idle.rss,
    idleRetainedBytes: idle.appOwnedBytes.retainedBytes,
    idleInspectionCounters: idle.inspectionCounters,
    idleResponseState: idle.responseState,
    durationMs: result.durationMs,
    firstFailure: states.find(state => state.failure)?.failure,
  });
  return result;
}

async function cancelOneResponse(sessionId: string, proxyBase: URL): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`cancel probe timed out after ${options.idleDeadlineMs} ms`));
  }, options.idleDeadlineMs);
  try {
    const response = await fetch(new URL("/v1/responses", proxyBase), {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock/test-model",
        stream: true,
        store: false,
        input: sessionMarker(sessionId),
        tools: tools(),
      }),
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("cancel probe response had no body");
    try {
      await reader.read();
      controller.abort(new Error("synthetic client cancel"));
      try { await reader.read(); } catch { /* cancellation is the expected outcome */ }
    } finally {
      try { await reader.cancel(); } catch { /* already aborted */ }
    }
    return "cancelled";
  } finally {
    clearTimeout(timeout);
  }
}

async function runFaultSession(index: number, proxyBase: URL): Promise<{ kind: FaultKind; outcome: string }> {
  const sessionId = `fault-${index}`;
  const kind = faultKind(sessionId);
  if (kind === "cancel") return { kind, outcome: await cancelOneResponse(sessionId, proxyBase) };

  try {
    const response = await fetch(new URL("/v1/responses", proxyBase), {
      method: "POST",
      signal: AbortSignal.timeout(options.idleDeadlineMs),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock/test-model",
        stream: true,
        store: false,
        input: sessionMarker(sessionId),
        tools: tools(),
      }),
    });
    let text = "";
    try { text = await readResponseText(response, false); } catch { return { kind, outcome: "body-read-error" }; }
    const completed = completedResponseFromSse(text);
    return { kind, outcome: completed?.status ? `terminal-${completed.status}` : `http-${response.status}` };
  } catch {
    return { kind, outcome: "fetch-error" };
  }
}

async function runFaultWave(proxyBase: URL, controlBase: URL): Promise<Record<string, number>> {
  if (options.faultSessions === 0) return {};
  const results = await Promise.all(
    Array.from({ length: options.faultSessions }, (_, index) => runFaultSession(index, proxyBase)),
  );
  const counts: Record<string, number> = {};
  for (const result of results) {
    const key = `${result.kind}:${result.outcome}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  await waitForIdle(controlBase);
  emit({ type: "FAULT_WAVE", sessions: options.faultSessions, outcomes: counts });
  return counts;
}

let exitCode = 0;
let ready: ChildReady | null = null;
let controlBase: URL | null = null;
try {
  ready = await withTimeout(readyPromise, 30_000, "proxy child readiness");
  const proxyBase = new URL(ready.proxyUrl);
  controlBase = new URL(ready.controlUrl);
  const initial = await waitForIdle(controlBase);
  emit({
    type: "START",
    seed: options.seed,
    algorithm: "stable-fnv1a32",
    child: ready,
    initialRss: initial.rss,
    initialRetainedBytes: initial.appOwnedBytes.retainedBytes,
    options,
  });

  const sustained: WaveResult[] = [];
  for (let wave = 0; wave < options.sustainedWaves; wave++) {
    sustained.push(await runWave(
      `sustained-${wave}`,
      "sustained",
      options.sustainedSessions,
      options.sustainedRounds,
      proxyBase,
      controlBase,
    ));
  }
  const burst = await runWave(
    "burst",
    "burst",
    options.burstSessions,
    options.burstRounds,
    proxyBase,
    controlBase,
  );
  const faultOutcomes = await runFaultWave(proxyBase, controlBase);
  const final = await waitForIdle(controlBase);

  const failedBaselineSessions = sustained.reduce((sum, wave) => sum + wave.failedSessions, 0) + burst.failedSessions;
  const idleRss = sustained.map(wave => wave.idle.rss);
  const idleRetained = sustained.map(wave => wave.idle.appOwnedBytes.retainedBytes);
  const peaks = mergePeaks([...sustained.map(wave => wave.peaks), burst.peaks]);
  emit({
    type: "SUMMARY",
    outcome: failedBaselineSessions === 0 ? "PASS" : "FAIL",
    seed: options.seed,
    algorithm: "stable-fnv1a32",
    platform: ready.platform,
    bunVersion: ready.bunVersion,
    bunRevision: ready.bunRevision,
    sustainedWaves: options.sustainedWaves,
    failedBaselineSessions,
    peaks,
    initialRss: initial.rss,
    finalRss: final.rss,
    rssIdleSlopeBytesPerWave: linearSlope(idleRss),
    retainedIdleSlopeBytesPerWave: linearSlope(idleRetained),
    finalRetainedBytes: final.appOwnedBytes.retainedBytes,
    finalPinnedBytes: final.appOwnedBytes.pinnedBytes,
    finalOverBudgetBytes: final.appOwnedBytes.overBudgetBytes,
    finalActiveTurnCount: final.activeTurnCount,
    finalInspectionCounters: final.inspectionCounters,
    finalResponseState: final.responseState,
    faultOutcomes,
    note: "Process-memory slopes are profiling evidence only; PASS is based on protocol completion and app-owned cleanup invariants.",
  });
  if (failedBaselineSessions !== 0) exitCode = 1;
} catch (error) {
  exitCode = 1;
  emit({
    type: "SUMMARY",
    outcome: "FAIL",
    classification: "probe-error",
    seed: options.seed,
    failure: error instanceof Error ? error.message : String(error),
    childExitCode: child.exitCode,
  });
} finally {
  if (controlBase) {
    try {
      await fetch(new URL("/shutdown", controlBase), {
        method: "POST",
        signal: AbortSignal.timeout(Math.min(2_000, options.idleDeadlineMs)),
      });
    } catch { /* child may already be gone */ }
  }
  await upstream.stop(true);
  const childExit = await Promise.race([child.exited, Bun.sleep(2_000).then(() => null)]);
  if (childExit === null) {
    try { child.kill(); } catch { /* already exited */ }
  }
}

process.exit(exitCode);
