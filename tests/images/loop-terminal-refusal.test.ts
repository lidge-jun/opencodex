import { afterEach, expect, jest, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter } from "../../src/adapters/base";
import { fetchVertexWithRetry } from "../../src/adapters/google-http";
import type { AdapterEvent, OcxParsedRequest, OcxUsage } from "../../src/types";
import type { ImageBridgePlan } from "../../src/images/types";
import { runWithImageBridge } from "../../src/images/loop";
import { markResponseNonReplayable } from "../../src/lib/upstream-retry";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * #7148: a refusal that ends an iteration carrying a complete image_gen call must end the turn.
 * Fulfilling the call and re-asking would send the refused context back to the model.
 */
const originalFetch = globalThis.fetch;
const previousHome = process.env.OPENCODEX_HOME;
let home = "";
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (home) removeTreeWithRetry(home);
});

const cases = [true, false, undefined].flatMap(terminalRefusalAsFailed =>
  ["direct", "hidden", "rotated"].map(path => ({ terminalRefusalAsFailed, path, reason: "content_filter", unfinished: false })))
  .concat([{ terminalRefusalAsFailed: false, path: "direct", reason: "max_output_tokens", unfinished: true },
    { terminalRefusalAsFailed: false, path: "direct", reason: "max_output_tokens", unfinished: false }]);
test.each(cases)("a refused image_gen iteration stops and meters usage: %j", async ({ terminalRefusalAsFailed, path, reason, unfinished }) => {
  const hasPrior = path !== "direct";
  const reported: (OcxUsage | undefined)[] = [];
  const rotated: OcxUsage[] = [];
  home = mkdtempSync(join(tmpdir(), "ocx-image-refusal-"));
  process.env.OPENCODEX_HOME = home;
  let mediaFetches = 0;
  globalThis.fetch = (async () => { mediaFetches++; return new Response("unavailable", { status: 503 }); }) as typeof fetch;
  let routedRequests = 0;
  const adapter: ProviderAdapter = {
    name: "mock-refusal",
    buildRequest: async () => {
      return { url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" };
    },
    fetchResponse: async (_request, ctx) => {
      routedRequests++;
      ctx?.onPhysicalSend?.({ ordinal: 1 });
      return new Response("ok", { status: path === "rotated" && routedRequests === 2 ? 429 : 200 });
    },
    async *parseStream() {
      yield { type: "tool_call_start", id: "call_1", name: "image_gen" } satisfies AdapterEvent;
      // Missing prompt gives the prior round a local tool error without sending a media request.
      yield { type: "tool_call_delta", arguments: hasPrior && routedRequests === 1 ? "{}" : '{"prompt":"a cat"}' } satisfies AdapterEvent;
      yield { type: "tool_call_end", ...(unfinished && !(hasPrior && routedRequests === 1) ? { incomplete: true as const } : {}) } satisfies AdapterEvent;
      if (hasPrior && routedRequests === 1) {
        yield { type: "done", usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } } satisfies AdapterEvent;
        return;
      }
      yield {
        type: "incomplete", reason, ...(reason === "content_filter" ? { retryable: false } : {}),
        message: 'upstream ended the turn with stop_reason "refusal"',
        usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
      } satisfies AdapterEvent;
    },
    async parseResponse() { throw new Error("parseResponse must be unreachable"); },
  };
  const plan = {
    provider: {} as never,
    auth: { baseUrl: "https://api.x.ai", token: "test-token" },
    model: "grok-imagine-image-quality",
    toolNames: new Set(["image_gen"]),
  } as ImageBridgePlan;

  const response = await runWithImageBridge({
    parsed: { modelId: "test-model", context: { messages: [], tools: [] }, stream: true, options: {} } as OcxParsedRequest,
    adapter,
    plan,
    incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
    terminalRefusalAsFailed,
    on429: async () => ({ adapter, recoveryKind: "oauth-account-429" }),
    onRotatedUsage: usage => { rotated.push(usage); return true; },
    onUsage: usage => reported.push(usage),
  });
  const text = await response.text();

  expect(routedRequests).toBe(path === "rotated" ? 3 : hasPrior ? 2 : 1);
  expect(mediaFetches).toBe(0);
  expect(reported).toEqual([expect.objectContaining({
    inputTokens: path === "hidden" ? 110 : 10, outputTokens: path === "hidden" ? 23 : 3,
  })]);
  expect(rotated).toEqual(path === "rotated" ? [expect.objectContaining({ inputTokens: 100, outputTokens: 20 })] : []);
  const terminal = text.split("\n").filter(line => line.startsWith("data: {"))
    .map(line => JSON.parse(line.slice(6))).find(frame => frame.type === `response.${terminalRefusalAsFailed ? "failed" : "incomplete"}`);
  expect(terminal.response.usage).toMatchObject({
    input_tokens: hasPrior ? 110 : 10, output_tokens: hasPrior ? 23 : 3, total_tokens: hasPrior ? 133 : 13,
  });
  expect(text).toContain(`event: response.${terminalRefusalAsFailed ? "failed" : "incomplete"}`);
  if (terminalRefusalAsFailed) expect(text).toContain('"code":"invalid_prompt"');
  else expect(text).toContain(`"reason":"${reason}"`);
  expect(text).not.toContain("event: response.completed");
});

test.each([false, true])("image bridge does not resend a terminal 429 (local marker %s)", async marked => {
  let sends = 0, rotations = 0;
  const adapter: ProviderAdapter = {
    name: "mock-refusal",
    buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
    async fetchResponse() {
      sends++;
      if (sends > 1) return new Response("unexpected resend", { status: 400 });
      const response = new Response("fixture quota", {
        status: 429, headers: marked ? {} : { "x-should-retry": "false" },
      });
      if (marked) markResponseNonReplayable(response);
      return response;
    },
    async *parseStream() { throw new Error("must not parse a rejected response"); },
  };
  const response = await runWithImageBridge({
    parsed: { modelId: "fixture", context: { messages: [], tools: [] }, stream: true, options: {} },
    adapter,
    plan: { provider: {} as never, auth: { baseUrl: "https://api.x.ai", token: "fixture" },
      model: "fixture", toolNames: new Set(["image_gen"]) } as ImageBridgePlan,
    incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
    retryOn429Policy: { enabled: true, attempts: 1, intervalMs: 1, maxIntervalMs: 1, respectRetryAfter: false },
    on429: async () => { rotations++; return { adapter, recoveryKind: "key-429" }; },
  });
  expect(await response.text()).toContain("429");
  expect(response.status).toBe(429);
  expect(response.headers.get("x-should-retry")).toBe("false");
  expect(sends).toBe(1);
  expect(rotations).toBe(0);
});

test.each([429, 503])("replay veto: image bridge retains a root refusal before recovery and formatting (%i)", async status => {
  let sends = 0, rotations = 0;
  const adapter: ProviderAdapter = {
    name: "mock-refusal",
    buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
    async fetchResponse() {
      sends++;
      return Response.json({ code: "upstream_response_refused", error: { message: "maximum context length exceeded" } },
        { status, headers: status === 503 ? { "x-should-retry": "false" } : {} });
    },
    async *parseStream() { throw new Error("must not parse a rejected response"); },
  };
  const response = await runWithImageBridge({
    parsed: { modelId: "fixture", context: { messages: [], tools: [] }, stream: true, options: {} }, adapter,
    plan: { provider: {} as never, auth: { baseUrl: "https://images.test", token: "fixture" }, model: "fixture", toolNames: new Set(["image_gen"]) } as ImageBridgePlan,
    incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() },
    retryOn429Policy: { enabled: true, attempts: 1, intervalMs: 1, maxIntervalMs: 1, respectRetryAfter: false },
    on429: async () => { rotations++; return rotations < 2 ? { adapter, recoveryKind: "key-429" } : null; },
  });
  expect(sends).toBe(1);
  expect(rotations).toBe(0);
  expect(response.status).toBe(429);
  expect(response.headers.get("x-should-retry")).toBe("false");
  expect(await response.json()).toMatchObject({ error: { code: "upstream_response_refused" } });
});

test.each([false, true])("replay veto: image header deadline distinguishes pre-dispatch and dispatched POST (%s)", async dispatched => {
  let sends = 0;
  const wait = (signal: AbortSignal) => new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const adapter: ProviderAdapter = {
    name: "mock-deadline",
    async buildRequest(_parsed, incoming) {
      if (!dispatched) await wait(incoming.abortSignal!);
      return { url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" };
    },
    async fetchResponse(_request, ctx) {
      sends++;
      ctx!.onPhysicalSend?.({ ordinal: sends });
      return wait(ctx!.abortSignal!);
    },
    async *parseStream() { throw new Error("must not parse a timed-out response"); },
  };
  const response = await runWithImageBridge({
    parsed: { modelId: "fixture", context: { messages: [], tools: [] }, stream: true, options: {} }, adapter,
    plan: { provider: {} as never, auth: { baseUrl: "https://images.test", token: "fixture" }, model: "fixture", toolNames: new Set(["image_gen"]) } as ImageBridgePlan,
    incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, connectTimeoutMs: 10,
  });
  expect(sends).toBe(dispatched ? 1 : 0);
  expect(response.headers.get("x-should-retry")).toBe(dispatched ? "false" : null);
  expect(response.status).toBe(dispatched ? 429 : 504);
  if (dispatched) expect(await response.json()).toMatchObject({ error: { code: "upstream_reset_replay_refused" } });
});

test.each(["byte-limit", "header-clock", "adapter-header-clock", "caller-cancel"] as const)("review: sidecar refusal probe image %s", async kind => {
  const timed = kind !== "byte-limit";
  if (timed) jest.useFakeTimers();
  const caller = new AbortController();
  const probeStarted = Promise.withResolvers<void>();
  const code = "upstream_response_refused";
  const payload = JSON.stringify({ padding: timed ? "" : "x".repeat(17_000), error: { code } });
  let sends = 0, rotations = 0, externalFetches = 0;
  let physicalSignal: AbortSignal | undefined;
  let source: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;
  let detach = () => {};
  const releaseBody = () => {
    if (!source || closed) return;
    closed = true;
    source.enqueue(new TextEncoder().encode(payload));
    source.close();
  };
  globalThis.fetch = (async () => { externalFetches++; throw new Error("fixture forbids external fetch"); }) as typeof fetch;
  const adapter: ProviderAdapter = {
    name: "mock-refusal-probe",
    buildRequest: () => ({ url: "https://routed.test/v1", method: "POST", headers: {}, body: "{}" }),
    async fetchResponse(request, ctx) {
      const respond = (signal: AbortSignal) => {
        sends++;
        physicalSignal = signal;
        if (kind !== "adapter-header-clock") ctx!.onPhysicalSend?.({ ordinal: sends });
        if (!timed) return new Response(payload, { status: 429, headers: { "content-type": "application/json" } });
        const body = new ReadableStream<Uint8Array>({
          start(controller) { source = controller; },
          pull() { probeStarted.resolve(); },
          cancel() { closed = true; },
        }, { highWaterMark: 0 });
        const onAbort = () => {
          if (!closed) { closed = true; source!.error(signal.reason); }
        };
        signal.addEventListener("abort", onAbort, { once: true });
        detach = () => signal.removeEventListener("abort", onAbort);
        return new Response(body, { status: 429, headers: { "content-type": "application/json" } });
      };
      return kind === "adapter-header-clock"
        ? fetchVertexWithRetry(request, { ...ctx, executor: (async (_input, init) => respond(init!.signal!)) as typeof fetch })
        : respond(ctx!.abortSignal!);
    },
    async *parseStream() { throw new Error("fixture must not parse an HTTP refusal"); },
  };
  const pending = runWithImageBridge({
    parsed: { modelId: "fixture", context: { messages: [], tools: [] }, stream: true, options: {} }, adapter,
    plan: { provider: {} as never, auth: { baseUrl: "https://images.test", token: "fixture" }, model: "fixture", toolNames: new Set(["image_gen"]) } as ImageBridgePlan,
    incomingMeta: { headers: new Headers(), translatorBudget: createTestTranslatorBudget() }, abortSignal: caller.signal,
    connectTimeoutMs: timed ? 50 : 2000,
    ...(timed ? {} : { retryOn429Policy: { enabled: true, attempts: 1, intervalMs: 1, maxIntervalMs: 1, respectRetryAfter: false } }),
    on429: async () => { rotations++; return null; },
  });
  try {
    if (timed) {
      await probeStarted.promise;
      if (kind === "caller-cancel") caller.abort(new Error("fixture caller cancelled"));
      else jest.advanceTimersByTime(60);
      releaseBody();
    }
    const response = await pending;
    const body = await response.json();
    expect({ sends, rotations, externalFetches }).toEqual({ sends: 1, rotations: 0, externalFetches: 0 });
    expect(response.status).toBe(kind === "caller-cancel" ? 499 : 429);
    if (kind === "caller-cancel") expect(body.error.code).not.toBe("upstream_reset_replay_refused");
    else {
      expect(physicalSignal!.aborted).toBe(false);
      expect(response.headers.get("x-should-retry")).toBe("false");
      expect(body.error.code).toBe(code);
    }
  } finally {
    caller.abort(); releaseBody(); detach();
    await pending.catch(() => {});
    if (timed) jest.useRealTimers();
  }
});
