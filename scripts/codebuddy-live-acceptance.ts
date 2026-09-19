/**
 * Explicitly opt-in SYNTHETIC adapter acceptance against an authenticated CodeBuddy CLI.
 * CODEBUDDY_LIVE_TEST=1, an absolute CODEBUDDY_LIVE_CLI_PATH, and CODEBUDDY_LIVE_API_KEY are
 * required. CODEBUDDY_LIVE_REGION selects the "global" (default) or "cn" preset, and the key
 * must belong to that region.
 *
 * Consumes three subscription turns. Real HOME is retained for the official CLI; OpenCodex and
 * Codex state and the listener are disposable. Do not run through `bun test`: its preload
 * deliberately replaces the real login home. No Codex client is executed and tool results are
 * fabricated by this script. Only scoped fixed-code results are printed; the API key, runtime
 * logs, and response text are not.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

type RecordValue = Record<string, unknown>;
type Stop = () => void | Promise<void>;
type Fetch = (input: URL, init: RequestInit) => Promise<Response>;
const DEFAULT_MODEL = "kimi-k2.5";
const DEADLINE_MS = 240_000;
const CLEANUP_DEADLINE_MS = 10_000;
const MAX_STREAM_BYTES = 2 * 1024 * 1024;
const MAX_EVENTS = 10_000;

export class AcceptanceFailure extends Error {
  constructor(readonly code: string) { super(code); }
}

function requireCondition(value: unknown, code: string): asserts value {
  if (!value) throw new AcceptanceFailure(code);
}

function record(value: unknown): value is RecordValue {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function assertLiveOptIn(env: NodeJS.ProcessEnv): void {
  requireCondition(env.CODEBUDDY_LIVE_TEST === "1", "explicit_opt_in_required");
  requireCondition(!env.OCX_TEST_HOME_GUARD && !env.OCX_TEST_PRELOAD_PID
    && !env.OCX_REAL_HOME && !env.BUN_TEST_WORKER_ID, "test_preload_not_supported");
  liveAcceptanceCliPath(env);
  liveAcceptanceModel(env);
  liveAcceptanceApiKey(env);
  liveAcceptanceRegion(env);
}

/** Diagnostic comparisons must never silently select a different installation. */
export function liveAcceptanceCliPath(env: NodeJS.ProcessEnv): string {
  const path = env.CODEBUDDY_LIVE_CLI_PATH?.trim();
  requireCondition(path, "explicit_cli_path_required");
  requireCondition(isAbsolute(path), "cli_path_must_be_absolute");
  return path;
}

/** Region preset under test; the account key must belong to the same region. */
export function liveAcceptanceRegion(env: NodeJS.ProcessEnv): "global" | "cn" {
  const region = env.CODEBUDDY_LIVE_REGION ?? "global";
  requireCondition(region === "global" || region === "cn", "invalid_region");
  return region;
}

/** Required and never printed: the region's console API key the CLI authenticates with. */
export function liveAcceptanceApiKey(env: NodeJS.ProcessEnv): string {
  const key = env.CODEBUDDY_LIVE_API_KEY?.trim();
  requireCondition(key, "explicit_api_key_required");
  return key;
}

export function syntheticAcceptanceResult(passed: boolean, error?: unknown) {
  return {
    passed,
    code: passed ? "synthetic_three_turn_streaming_passed"
      : error instanceof AcceptanceFailure ? error.code : "acceptance_failed",
    scope: "synthetic-adapter" as const,
    codexClientExecuted: false as const,
  };
}

/** An exact CLI selector, never a different provider or an arbitrary CLI argument. */
export function liveAcceptanceModel(env: NodeJS.ProcessEnv): string {
  const model = env.CODEBUDDY_LIVE_MODEL ?? DEFAULT_MODEL;
  requireCondition(/^[a-z0-9][a-z0-9._-]{0,63}$/.test(model), "invalid_model_selector");
  return model;
}

export function assertLoopbackListener(listener: { port: number | undefined; hostname: string | undefined; url: URL }): void {
  requireCondition(Number.isInteger(listener.port) && listener.port! > 0
    // 10100 is the only live proxy port now: the dev instance shares it with the
    // official one (they never run at once). The retired dev port 10110 must NOT
    // stay excluded, or a foreign listener there would go unflagged.
    && listener.port! <= 65535 && listener.port !== 10100, "unsafe_listener_port");
  requireCondition(listener.hostname === "127.0.0.1" && listener.url.hostname === "127.0.0.1"
    && listener.url.protocol === "http:" && Number(listener.url.port) === listener.port
    && !listener.url.username && !listener.url.password, "unsafe_listener_address");
}

/** A single deadline/signal spans fetch and every read across all three turns. */
export async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new AcceptanceFailure("acceptance_aborted");
  let abort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(new AcceptanceFailure("acceptance_aborted"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([operation, interrupted]); }
  finally { signal.removeEventListener("abort", abort); }
}

export interface StreamResult {
  response: RecordValue;
  events: RecordValue[];
}

/** Strict bounded SSE parsing; even a completed event cannot hide a torn tail. */
export async function readResponseStream(response: Response, signal: AbortSignal, model = DEFAULT_MODEL): Promise<StreamResult> {
  requireCondition(response.status === 200, "unexpected_http_status");
  requireCondition(response.headers.get("content-type")?.split(";")[0]?.trim() === "text/event-stream",
    "unexpected_content_type");
  requireCondition(response.body, "missing_response_stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const events: RecordValue[] = [];
  let buffer = "";
  let bytes = 0;
  let completed: RecordValue | undefined;
  let done = false;
  const consume = (frame: string) => {
    if (!frame || frame.split("\n").every(line => !line || line.startsWith(":"))) return;
    let name: string | undefined;
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const separator = line.indexOf(":");
      requireCondition(separator >= 0, "malformed_sse");
      const field = line.slice(0, separator);
      const value = line.slice(separator + 1).replace(/^ /, "");
      if (field === "event") {
        requireCondition(name === undefined, "malformed_sse");
        name = value;
      } else if (field === "data") data.push(value);
      else requireCondition(field === "id" || field === "retry", "malformed_sse");
    }
    requireCondition(data.length > 0, "malformed_sse");
    const payload = data.join("\n");
    if (payload === "[DONE]") {
      requireCondition(completed && !done, "premature_or_duplicate_done");
      done = true;
      return;
    }
    requireCondition(!done && !completed, "event_after_completion");
    let parsed: unknown;
    try { parsed = JSON.parse(payload); } catch { throw new AcceptanceFailure("malformed_sse_json"); }
    requireCondition(record(parsed) && typeof parsed.type === "string"
      && (!name || name === parsed.type), "malformed_sse_event");
    requireCondition(parsed.type !== "error" && parsed.type !== "response.failed"
      && parsed.type !== "response.incomplete", "response_failed");
    requireCondition(events.length < MAX_EVENTS, "stream_limit_exceeded");
    events.push(parsed);
    if (parsed.type === "response.completed") {
      requireCondition(record(parsed.response), "invalid_completed_response");
      completed = parsed.response;
    }
  };
  try {
    while (true) {
      const next = await abortable(reader.read(), signal);
      if (next.done) break;
      bytes += next.value.byteLength;
      requireCondition(bytes <= MAX_STREAM_BYTES, "stream_limit_exceeded");
      buffer += decoder.decode(next.value, { stream: true });
      // Normalize only complete CRLF pairs, including ones split across chunks.
      buffer = buffer.replace(/\r\n/g, "\n");
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        consume(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
      }
    }
    buffer += decoder.decode();
    requireCondition(buffer.length === 0, "truncated_sse_frame");
    requireCondition(completed, "missing_completion");
    requireCondition(done, "missing_done");
    requireCondition(completed.status === "completed" && completed.model === model
      && typeof completed.id === "string" && completed.id.length > 0 && Array.isArray(completed.output),
    "invalid_completed_response");
    return { response: completed, events };
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error instanceof AcceptanceFailure ? error : new AcceptanceFailure("stream_read_failed");
  } finally {
    reader.releaseLock();
  }
}

/**
 * A tool leg ends at message_stop with no vendor result frame, so positive usage on the
 * completed response is the regression guard for partial-usage accounting on bridge turns.
 * Both token fields must be positive: a single-field check passed even when the synthesized
 * tool leg reported zero input tokens (the message_start omission this harness now guards).
 */
function assertReportedUsage(response: RecordValue): void {
  requireCondition(record(response.usage), "usage_missing");
  const inputTokens = typeof response.usage.input_tokens === "number" ? response.usage.input_tokens : 0;
  const outputTokens = typeof response.usage.output_tokens === "number" ? response.usage.output_tokens : 0;
  requireCondition(inputTokens > 0 && outputTokens > 0, "usage_zero");
}

export function argumentsMatch(actual: unknown, expected: RecordValue): boolean {
  if (typeof actual !== "string") return false;
  try {
    const parsed: unknown = JSON.parse(actual);
    return record(parsed) && Object.keys(parsed).length === Object.keys(expected).length
      && Object.entries(expected).every(([key, value]) => Object.hasOwn(parsed, key) && parsed[key] === value);
  } catch { return false; }
}

function validateDeltas(result: StreamResult, itemId: string, kind: "function_call_arguments" | "output_text",
  expected: string, contentIndex?: number): void {
  const matches = (event: RecordValue) => event.item_id === itemId
    && (contentIndex === undefined || event.content_index === contentIndex);
  const deltas = result.events.filter(event => event.type === `response.${kind}.delta` && matches(event));
  const dones = result.events.filter(event => event.type === `response.${kind}.done` && matches(event));
  requireCondition(deltas.length > 0 && deltas.every(event => typeof event.delta === "string")
    && deltas.map(event => event.delta).join("") === expected && dones.length === 1
    && dones[0]![kind === "output_text" ? "text" : "arguments"] === expected, "stream_snapshot_mismatch");
  const doneIndex = result.events.indexOf(dones[0]!);
  requireCondition(deltas.every(event => result.events.indexOf(event) < doneIndex), "delta_after_done");
}

function toolCall(result: StreamResult, name: string, expected: RecordValue): RecordValue {
  const calls = (result.response.output as unknown[]).filter(item => record(item) && item.type === "function_call");
  requireCondition(calls.length === 1 && record(calls[0]), "unexpected_tool_count");
  const call = calls[0];
  requireCondition(call.name === name && typeof call.id === "string" && call.id.length > 0
    && typeof call.call_id === "string" && call.call_id.length > 0
    && argumentsMatch(call.arguments, expected), "tool_call_mismatch");
  validateDeltas(result, call.id, "function_call_arguments", call.arguments as string);
  return call;
}

export async function runAcceptanceScenario(baseUrl: URL, signal: AbortSignal, fetchResponse: Fetch = fetch,
  model = DEFAULT_MODEL, providerId = "codebuddy"): Promise<void> {
  liveAcceptanceModel({ CODEBUDDY_LIVE_MODEL: model });
  assertLoopbackListener({ url: baseUrl, hostname: baseUrl.hostname, port: Number(baseUrl.port) });
  // Exercise selected Codex protocol properties, NOT a real client: a turn_id is reused across every
  // Responses request of the turn (including continuations after tool outputs),
  // and parallel_tool_calls arrives as permission even though the published
  // catalog serializes tool calls.
  const turnMetadata = JSON.stringify({ turn_id: crypto.randomUUID() });
  const post = async (body: RecordValue) => readResponseStream(await abortable(fetchResponse(
    new URL("/v1/responses", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", "x-codex-turn-metadata": turnMetadata },
      body: JSON.stringify({ ...body, model: `${providerId}/${model}`, stream: true, parallel_tool_calls: true }), signal,
    }), signal), signal, model);
  const first = await post({
    input: "Call lookup_inventory exactly once with sku TEST-123. Do not answer with text.",
    tools: [{ type: "function", name: "lookup_inventory", description: "Look up inventory for an exact SKU.",
      parameters: { type: "object", properties: { sku: { type: "string" } }, required: ["sku"], additionalProperties: false } }],
    tool_choice: "required",
  });
  assertReportedUsage(first.response);
  const lookup = toolCall(first, "lookup_inventory", { sku: "TEST-123" });
  const second = await post({
    previous_response_id: first.response.id,
    input: [
      { type: "function_call_output", call_id: lookup.call_id, output: JSON.stringify({ available: 7 }) },
      { type: "message", role: "user", content: [{ type: "input_text", text:
        "Only if the preceding tool result says available is exactly 7, call reserve_inventory once for sku TEST-123 with quantity 2. Otherwise answer UNAVAILABLE without a tool." }] },
    ],
    tools: [{ type: "function", name: "reserve_inventory", description: "Reserve a quantity of an exact SKU.",
      parameters: { type: "object", properties: { sku: { type: "string" }, quantity: { type: "integer", minimum: 1 } },
        required: ["sku", "quantity"], additionalProperties: false } }],
    tool_choice: "required",
  });
  assertReportedUsage(second.response);
  const reserve = toolCall(second, "reserve_inventory", { sku: "TEST-123", quantity: 2 });
  const third = await post({
    previous_response_id: second.response.id,
    input: [
      { type: "function_call_output", call_id: reserve.call_id,
        output: JSON.stringify({ reservation_id: "R-42", reserved: true }) },
      { type: "message", role: "user", content: [{ type: "input_text", text:
        "Return only the exact reservation_id from the preceding tool result, with no other text or tool call." }] },
    ],
    tools: [], tool_choice: "none",
  });
  let finalText = "";
  for (const item of third.response.output as unknown[]) {
    requireCondition(record(item) && item.type !== "function_call", "unexpected_final_tool_call");
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    requireCondition(typeof item.id === "string", "invalid_message_id");
    item.content.forEach((part: unknown, index: number) => {
      if (!record(part) || part.type !== "output_text") return;
      requireCondition(typeof part.text === "string", "invalid_final_text");
      validateDeltas(third, item.id as string, "output_text", part.text, index);
      finalText += part.text;
    });
  }
  requireCondition(finalText.trim() === "R-42", "final_result_mismatch");
}

/** Nested cleanup owns the exact directory created here, even when stop rejects. */
export async function withIsolatedState<T>(work: (state: {
  openCodexHome: string; codexHome: string; registerStop: (stop: Stop) => void;
}) => Promise<T>): Promise<T> {
  const previous = { ...process.env };
  const root = await mkdtemp(join(tmpdir(), "ocx-codebuddy-live-"));
  let stop: Stop | undefined;
  try {
    const openCodexHome = join(root, "opencodex-home");
    const codexHome = join(root, "codex-home");
    await Promise.all([mkdir(openCodexHome), mkdir(codexHome)]);
    process.env.OPENCODEX_HOME = openCodexHome;
    process.env.CODEX_HOME = codexHome;
    return await work({ openCodexHome, codexHome, registerStop: value => { stop = value; } });
  } finally {
    try {
      if (stop) {
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), CLEANUP_DEADLINE_MS);
        try { await abortable(Promise.resolve().then(stop), timeout.signal); }
        finally { clearTimeout(timer); }
      }
    } finally {
      try {
        for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
        for (const [key, value] of Object.entries(previous)) process.env[key] = value;
      } finally { await rm(root, { recursive: true, force: true }); }
    }
  }
}

export async function runLiveAcceptance(): Promise<void> {
  assertLiveOptIn(process.env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
  const interrupt = () => controller.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    await withIsolatedState(async ({ openCodexHome, codexHome, registerStop }) => {
      // Runtime modules may capture paths at import. Import only after isolation.
      const { getConfigDir } = await import("../src/config/paths");
      const { saveConfig } = await import("../src/config");
      const { resolveCodexHomeDir } = await import("../src/codex/home");
      const { providerConfigSeed } = await import("../src/providers/derive");
      const { getProviderRegistryEntry } = await import("../src/providers/registry");
      const { startServer } = await import("../src/server");
      const { CODEBUDDY_PROFILES, clearCodeBuddyBinaryCache } = await import("../src/adapters/codebuddy/profiles");
      const { resolveCodingAgentBinary } = await import("../src/adapters/coding-agent/profile");
      requireCondition(getConfigDir() === resolve(openCodexHome)
        && resolveCodexHomeDir() === resolve(codexHome), "home_isolation_failed");
      const providerId = liveAcceptanceRegion(process.env) === "cn" ? "codebuddy-cn" : "codebuddy";
      const entry = getProviderRegistryEntry(providerId);
      requireCondition(entry, "provider_not_registered");
      const profile = CODEBUDDY_PROFILES.find(candidate => candidate.providerId === providerId);
      requireCondition(profile, "provider_not_registered");
      // The adapter resolves the CLI from PATH at request time. Front-load the operator-selected
      // installation and fail closed when that resolution does not match it exactly.
      const cliPath = liveAcceptanceCliPath(process.env);
      process.env.PATH = `${dirname(cliPath)}${delimiter}${process.env.PATH ?? ""}`;
      clearCodeBuddyBinaryCache();
      requireCondition(resolveCodingAgentBinary(profile) === cliPath, "cli_resolution_mismatch");
      saveConfig({
        port: 0,
        hostname: "127.0.0.1",
        defaultProvider: providerId,
        providers: { [providerId]: { ...providerConfigSeed(entry), apiKey: liveAcceptanceApiKey(process.env) } },
      });
      requireCondition(!controller.signal.aborted, "acceptance_aborted");
      const server = startServer(0);
      registerStop(() => server.stop(true));
      assertLoopbackListener(server);
      try { await runAcceptanceScenario(server.url, controller.signal, fetch, liveAcceptanceModel(process.env), providerId); }
      finally { controller.abort(); }
    });
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

if (import.meta.main) {
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  // Bun's console can bypass process.stdout.write, so suppress that surface too.
  const savedConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  console.log = console.info = console.warn = console.error = console.debug = () => {};
  // Runtime diagnostics can contain provider output. This standalone process has
  // one owner; suppress both channels for its entire operation and cleanup.
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  let result: ReturnType<typeof syntheticAcceptanceResult>;
  try {
    await runLiveAcceptance();
    result = syntheticAcceptanceResult(true);
  } catch (error) {
    result = syntheticAcceptanceResult(false, error);
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
    Object.assign(console, savedConsole);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.passed ? 0 : 1);
}
