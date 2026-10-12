import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { orderDevinMessagesOutput } from "../../src/claude/devin-output-order";
import { collectAnthropicMessage, responsesSseToAnthropicSse } from "../../src/claude/outbound";
import { bridgeToResponsesSSE } from "../../src/bridge";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
import { encodeDevinSignature } from "../../src/adapters/devin/reasoning-signature";
import { mapOcxMessagesToDevin } from "../../src/adapters/devin";
import { messagesToResponsesTranslation } from "../../src/protocols/codecs/messages";
import { parseRequest } from "../../src/responses/parser";
import type { AdapterEvent, OcxConfig, OcxProviderConfig } from "../../src/types";
import type { ProviderAdapter } from "../../src/adapters/base";
import { createAdapterEventQueue } from "../../src/adapters/run-turn-queue";
import { runTurnWebSearchLoop } from "../../src/web-search/run-turn-loop";
import { DEVIN_CLI_CREDENTIALS_ENV } from "../../src/oauth/devin/cli-import";
import { saveCredential } from "../../src/oauth/store";
import { createTempHome } from "../helpers/temp-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { installIsolatedCodexHome } from "../helpers/isolated-codex-home";

const signature = encodeDevinSignature("sealed.v1.synthetic-attestation", "sealed");
const usage = { inputTokens: 12, outputTokens: 3, totalTokens: 15 };
const terminal: AdapterEvent = { type: "done", usage };
let upstreamEvents: AdapterEvent[] = [];
let afterFirstEvent: (() => Promise<void>) | undefined;
let paceFragments = false;
const resolver = await import("../../src/server/adapter-resolve");
const originalResolver = { ...resolver };
mock.module("../../src/server/adapter-resolve", () => ({ ...originalResolver,
  resolveAdapter(provider: OcxProviderConfig, cache?: "none" | "short" | "long") {
    if (provider.adapter !== "devin") return originalResolver.resolveAdapter(provider, cache);
    return {
      name: "devin",
      buildRequest: () => ({ url: provider.baseUrl, method: "POST", headers: {}, body: "" }),
      async *parseStream() { yield terminal; },
      async runTurn(_parsed, _incoming, emit) {
        for (let index = 0; index < upstreamEvents.length; index++) {
          emit(upstreamEvents[index]!);
          if (index === 0) await afterFirstEvent?.();
          if (paceFragments && index % 16 === 0) await new Promise<void>(resolve => setImmediate(resolve));
        }
      },
    } satisfies ProviderAdapter;
  },
}));
const { handleClaudeMessages } = await import("../../src/server/claude-messages");
const { handleResponses } = await import("../../src/server/responses");
afterAll(() => { mock.module("../../src/server/adapter-resolve", () => originalResolver); });

let home: ReturnType<typeof createTempHome>;
let codexHome: ReturnType<typeof installIsolatedCodexHome>;
let releaseSpend: () => void;
let previousCliCredentialsPath: string | undefined;
beforeEach(() => {
  home = createTempHome("ocx-claude-devin-output-");
  codexHome = installIsolatedCodexHome("ocx-claude-devin-codex-");
  releaseSpend = acquireOwnedSpendHome();
  previousCliCredentialsPath = process.env[DEVIN_CLI_CREDENTIALS_ENV];
  process.env[DEVIN_CLI_CREDENTIALS_ENV] = home.path("absent-devin-cli.toml");
  upstreamEvents = [];
  afterFirstEvent = undefined;
  paceFragments = false;
});
afterEach(() => {
  if (previousCliCredentialsPath === undefined) delete process.env[DEVIN_CLI_CREDENTIALS_ENV];
  else process.env[DEVIN_CLI_CREDENTIALS_ENV] = previousCliCredentialsPath;
  releaseSpend(); codexHome.restore(); home.remove();
});

async function ordered(events: AdapterEvent[]) {
  const budget = createTestTranslatorBudget();
  const abort = new AbortController();
  const output: AdapterEvent[] = [];
  for await (const event of orderDevinMessagesOutput((async function* () { yield* events; })(),
    budget, abort.signal, () => abort.abort())) output.push(event);
  return { output, budget };
}

async function message(events: AdapterEvent[]) {
  const { output, budget } = await ordered(events);
  const source = (async function* () { yield* output; })();
  const bridged = bridgeToResponsesSSE(source, "swe-2", undefined, undefined, undefined, undefined, 0, { translatorBudget: budget });
  return collectAnthropicMessage(responsesSseToAnthropicSse(bridged, "devin/swe-2", {
    translatorBudget: budget, pingIntervalMs: 0,
  }), "devin/swe-2", budget);
}

describe("Devin Messages late signatures", () => {
  test("late signature keeps the answer last, signed reasoning intact, and exact usage", async () => {
    const result = await message([
      { type: "thinking_delta", thinking: "A thought" },
      { type: "text_delta", text: "O" }, { type: "text_delta", text: "K" },
      { type: "thinking_signature", signature }, terminal,
    ]);
    expect(result.content).toEqual([
      { type: "thinking", thinking: "A thought", signature }, { type: "text", text: "OK" },
    ]);
    expect(result.stop_reason).toBe("end_turn");
    expect(result.usage).toMatchObject({ input_tokens: 12, output_tokens: 3 });
  });

  test("signature-only turns preserve both the signature and final text", async () => {
    const result = await message([
      { type: "text_delta", text: "OK" }, { type: "thinking_signature", signature }, terminal,
    ]);
    expect(result.content).toEqual([
      { type: "thinking", thinking: "", signature }, { type: "text", text: "OK" },
    ]);
  });

  test("a signed tool turn survives Messages inbound replay to the Devin prompt", async () => {
    const result = await message([
      { type: "thinking_delta", thinking: "Read the file" },
      { type: "tool_call_start", id: "call_read", name: "Read" },
      { type: "tool_call_delta", arguments: '{"file_path":"/synthetic/file.txt"}' },
      { type: "tool_call_end" }, { type: "thinking_signature", signature }, terminal,
    ]);
    expect(result.stop_reason).toBe("tool_use");
    expect(result.content.at(-1)).toMatchObject({ type: "tool_use", id: "call_read", name: "Read",
      input: { file_path: "/synthetic/file.txt" } });
    const translated = messagesToResponsesTranslation({ model: "devin/swe-2", max_tokens: 64,
      messages: [{ role: "user", content: "Read" }, { role: "assistant", content: result.content },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_read", content: "marker" }] }],
    }, undefined, createTestTranslatorBudget());
    const history = mapOcxMessagesToDevin(parseRequest(translated.body));
    expect(history.find(row => row.role === "assistant")).toMatchObject({
      thinking: "Read the file", signature: "sealed.v1.synthetic-attestation", signature_type: "sealed",
    });
    expect(history.find(row => row.role === "tool")?.content).toBe("marker");
  });

  test("independently signed reasoning blocks retain their associations", async () => {
    const result = await message([
      { type: "thinking_delta", thinking: "First" }, { type: "thinking_signature", signature: "sig-first" },
      { type: "text_delta", text: "answer" },
      { type: "thinking_delta", thinking: "Second" }, { type: "thinking_signature", signature: "sig-second" }, terminal,
    ]);
    expect(result.content).toEqual([
      { type: "thinking", thinking: "First", signature: "sig-first" },
      { type: "thinking", thinking: "Second", signature: "sig-second" }, { type: "text", text: "answer" },
    ]);
  });

  for (const ending of [terminal, { type: "incomplete", reason: "max_tokens", usage },
    { type: "error", status: 502, message: "synthetic reset", usage }] as AdapterEvent[]) {
    test(`${ending.type} preserves partial content and the original terminal`, async () => {
      const { output, budget } = await ordered([{ type: "text_delta", text: "partial" }, ending]);
      expect(output.filter(event => event.type !== "heartbeat")).toEqual([{ type: "text_delta", text: "partial" }, ending]);
      expect(budget.snapshot().currentBytes).toBe(0);
    });
  }

  test("holding output keeps progress live and cancellation preserves the adapter terminal and usage", async () => {
    const budget = createTestTranslatorBudget();
    const abort = new AbortController();
    const queue = createAdapterEventQueue();
    const iterator = orderDevinMessagesOutput(queue.stream(), budget, abort.signal, () => abort.abort());
    queue.push({ type: "text_delta", text: "still generating" });
    expect((await iterator.next()).value).toEqual({ type: "heartbeat" });
    expect(budget.snapshot().currentBytes).toBeGreaterThan(0);
    queue.push({ type: "heartbeat", replayUnsafe: true });
    expect((await iterator.next()).value).toEqual({ type: "heartbeat", replayUnsafe: true });
    abort.abort();
    expect(budget.snapshot().currentBytes).toBe(0);
    const cancelled: AdapterEvent = { type: "error", status: 499, message: "client closed request", usage };
    queue.push(cancelled);
    queue.close();
    expect((await iterator.next()).value).toEqual(cancelled);
    expect((await iterator.next()).done).toBe(true);
  });

  test("overflow emits one typed error and stops only the producer, preserving search error classification", async () => {
    const budget = createTestTranslatorBudget({ maxTurnBytes: 160 });
    const requestAbort = new AbortController();
    const producerAbort = new AbortController();
    const output: AdapterEvent[] = [];
    const source = (async function* () {
      yield { type: "text_delta", text: "small" } as AdapterEvent;
      yield { type: "text_delta", text: "x".repeat(200) } as AdapterEvent;
      yield terminal;
    })();
    for await (const event of orderDevinMessagesOutput(source, budget, requestAbort.signal, () => producerAbort.abort())) output.push(event);
    expect(output.filter(event => event.type === "error")).toHaveLength(1);
    expect(output.at(-1)).toMatchObject({ type: "error", status: 413, code: "translation_buffer_limit" });
    expect(producerAbort.signal.aborted).toBe(true);
    expect(requestAbort.signal.aborted).toBe(false);
    expect(budget.snapshot().currentBytes).toBe(0);
  });

});

const config = (): OcxConfig => ({ port: 0, defaultProvider: "cognition-custom", claudeCode: { enabled: true },
  providers: { "cognition-custom": { adapter: "devin", baseUrl: "https://synthetic.invalid", apiKey: "synthetic-key", models: ["swe-2"] } },
});

test("retained terminal usage is isolated from producer and consumer mutations", async () => {
  const budget = createTestTranslatorBudget();
  const abort = new AbortController();
  const originalUsage = { ...usage, rawUsage: { detail: { tokens: 3 } } };
  const ending: AdapterEvent = { type: "done", usage: originalUsage };
  const iterator = orderDevinMessagesOutput((async function* () {
    yield { type: "text_delta", text: "OK" } as AdapterEvent;
    yield ending;
  })(), budget, abort.signal, () => abort.abort());
  await iterator.next(); // Progress while the answer is retained.
  expect((await iterator.next()).value).toEqual({ type: "text_delta", text: "OK" });
  const measuredBytes = budget.snapshot().currentBytes;
  originalUsage.outputTokens = 999;
  originalUsage.rawUsage.detail.tokens = 999;
  const result = (await iterator.next()).value;
  expect(result).toEqual({ type: "done", usage: { ...usage, rawUsage: { detail: { tokens: 3 } } } });
  if (!result || result.type !== "done" || !result.usage) throw new Error("missing terminal usage");
  result.usage.outputTokens = 1;
  expect(originalUsage.outputTokens).toBe(999);
  expect(budget.snapshot().currentBytes).toBeLessThan(measuredBytes);
  expect((await iterator.next()).done).toBe(true);
  expect(budget.snapshot().currentBytes).toBe(0);
});

test("a stalled Devin turn sends repeated Messages pings before releasing the held answer", async () => {
  const budget = createTestTranslatorBudget();
  const abort = new AbortController();
  const queue = createAdapterEventQueue();
  const events = orderDevinMessagesOutput(queue.stream(), budget, abort.signal, () => abort.abort());
  const bridge = bridgeToResponsesSSE(events, "swe-2", undefined, undefined, undefined, undefined, 2000, { translatorBudget: budget });
  const reader = responsesSseToAnthropicSse(bridge, "devin/swe-2", { translatorBudget: budget, pingIntervalMs: 10 }).getReader();
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  queue.push({ type: "text_delta", text: "OK" });
  try {
    await Promise.race([(async () => {
      // Include a periodic ping after the progress ping from held text.
      while ((chunks.join("").match(/event: ping/g) ?? []).length < 3) {
        const next = await reader.read();
        if (next.done) throw new Error("stream ended before the signature");
        chunks.push(decoder.decode(next.value, { stream: true }));
      }
    })(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("stalled Messages stream sent no pings")), 1000); })]);
    expect(chunks.join("")).not.toContain("text_delta");
    expect(budget.snapshot().currentBytes).toBeGreaterThan(0);
    queue.push({ type: "thinking_signature", signature });
    queue.push(terminal);
    queue.close();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(decoder.decode(next.value, { stream: true }));
    }
    const wire = chunks.join("");
    expect(wire).toContain('"text":"OK"');
    expect(wire.indexOf("signature_delta")).toBeLessThan(wire.indexOf("text_delta"));
    expect(wire).toContain("event: message_stop");
  } finally { clearTimeout(timer); queue.close(); await reader.cancel(); budget.dispose(); }
});

for (const stream of [true, false]) {
  test(`actual Messages ingress orders a renamed Devin provider, stream=${stream}`, async () => {
    upstreamEvents = [{ type: "text_delta", text: "OK" }, { type: "thinking_signature", signature }, terminal];
    const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "cognition-custom/swe-2", max_tokens: 64, stream,
        messages: [{ role: "user", content: "Reply OK" }] }),
    }), config(), {});
    expect(response.status).toBe(200);
    const result = stream ? await collectAnthropicMessage(response.body!, "cognition-custom/swe-2", createTestTranslatorBudget())
      : await response.json();
    expect(result.content.at(-1)).toEqual({ type: "text", text: "OK" });
    expect(result.content[0]).toEqual({ type: "thinking", thinking: "", signature });
  });
}

test("the Responses ingress retains incremental text before the late signature", async () => {
  upstreamEvents = [{ type: "text_delta", text: "OK" }, { type: "thinking_signature", signature }, terminal];
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "cognition-custom/swe-2", input: "Reply OK", stream: true }),
  }), config(), {});
  const text = await response.text();
  expect(text.indexOf("response.output_text.delta")).toBeLessThan(text.indexOf("\"type\":\"reasoning\""));
});


test("a tool call with 3,000 streamed argument fragments drains without overflowing the real queue", async () => {
  const argumentsText = JSON.stringify({ file_path: "/synthetic/file.txt", content: "x".repeat(3000) });
  paceFragments = true;
  upstreamEvents = [{ type: "tool_call_start", id: "call_write", name: "Write" },
    ...[...argumentsText].map(fragment => ({ type: "tool_call_delta", arguments: fragment }) as AdapterEvent),
    { type: "tool_call_end" }, { type: "thinking_signature", signature }, terminal];
  const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "cognition-custom/swe-2", max_tokens: 4096, stream: false,
      messages: [{ role: "user", content: "Write" }],
      tools: [{ name: "Write", input_schema: { type: "object", properties: { content: { type: "string" } } } }],
    }),
  }), config(), {});
  const result = await response.json();
  expect(result.stop_reason).toBe("tool_use");
  expect(result.content.at(-1)).toMatchObject({ type: "tool_use", input: JSON.parse(argumentsText) });
  expect(result.usage).toMatchObject({ input_tokens: 12, output_tokens: 3 });
});

test("OAuth preflight releases Messages headers at the first text, before a late signature", async () => {
  await saveCredential("devin", { access: "devin-session-token$synthetic", refresh: "synthetic",
    expires: Number.MAX_SAFE_INTEGER, accountId: "synthetic-account", source: "oauth",
    apiBaseUrl: "https://server.codeium.com" });
  let finish!: () => void;
  afterFirstEvent = () => new Promise<void>(resolve => { finish = resolve; });
  upstreamEvents = [{ type: "text_delta", text: "OK" }, { type: "thinking_signature", signature }, terminal];
  const oauthConfig: OcxConfig = { port: 0, defaultProvider: "devin", claudeCode: { enabled: true },
    providers: { devin: { adapter: "devin", authMode: "oauth", baseUrl: "https://server.codeium.com", models: ["swe-2"] } } };
  const responsePromise = handleClaudeMessages(new Request("http://localhost/v1/messages", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "devin/swe-2", max_tokens: 64, stream: true,
      messages: [{ role: "user", content: "Reply OK" }] }),
  }), oauthConfig, {});
  let headerTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([responsePromise,
      new Promise<never>((_, reject) => { headerTimer = setTimeout(() => reject(new Error("headers waited for terminal")), 1000); })]);
    expect(response.status).toBe(200);
    expect(finish).toBeDefined();
    finish();
    const result = await collectAnthropicMessage(response.body!, "devin/swe-2", createTestTranslatorBudget());
    expect(result.content.at(-1)).toEqual({ type: "text", text: "OK" });
  } finally { clearTimeout(headerTimer); finish?.(); }
});


test("hosted search forwards the typed overflow instead of inventing a client cancellation", async () => {
  const budget = createTestTranslatorBudget({ maxTurnBytes: 160 });
  const requestAbort = new AbortController();
  const producerAbort = new AbortController();
  const source = orderDevinMessagesOutput((async function* () {
    yield { type: "text_delta", text: "x".repeat(200) } as AdapterEvent;
  })(), budget, requestAbort.signal, () => producerAbort.abort());
  const loop = runTurnWebSearchLoop(source, {
    parsed: { modelId: "swe-2", stream: true, options: {}, context: { messages: [], tools: [] } },
    plan: { backend: "exa", hostedTool: { type: "web_search" }, maxSearches: 1,
      settings: { model: "fixture", reasoning: "low", timeoutMs: 100 },
      routedModelStallTimeoutMs: 100, stallTimeoutSec: 1, streamRoutedModelOutput: true },
    abortSignal: requestAbort.signal, translatorBudget: budget,
    dispatch: async function* () { throw new Error("no search dispatch expected"); },
  });
  const output: AdapterEvent[] = [];
  for await (const event of loop) output.push(event);
  expect(output).toEqual([expect.objectContaining({ type: "error", status: 413, code: "translation_buffer_limit" })]);
  expect(producerAbort.signal.aborted).toBe(true);
  expect(budget.snapshot().currentBytes).toBe(0);
});

test("cancelling during the terminal drain preserves usage and clears retained semantic events", async () => {
  const budget = createTestTranslatorBudget();
  const abort = new AbortController();
  const iterator = orderDevinMessagesOutput((async function* () {
    yield { type: "text_delta", text: "partial" } as AdapterEvent;
    yield terminal;
  })(), budget, abort.signal, () => abort.abort());
  expect((await iterator.next()).value).toEqual({ type: "heartbeat" });
  expect((await iterator.next()).value).toEqual({ type: "text_delta", text: "partial" });
  abort.abort();
  expect(budget.snapshot().currentBytes).toBe(0);
  expect((await iterator.next()).value).toMatchObject({ type: "error", status: 499, usage });
  expect((await iterator.next()).done).toBe(true);
});

test("a consumer return releases the ordering buffer without a terminal", async () => {
  const budget = createTestTranslatorBudget();
  const abort = new AbortController();
  const iterator = orderDevinMessagesOutput((async function* () {
    yield { type: "text_delta", text: "held" } as AdapterEvent;
    yield terminal;
  })(), budget, abort.signal, () => abort.abort());
  await iterator.next();
  expect(budget.snapshot().currentBytes).toBeGreaterThan(0);
  await iterator.return();
  expect(budget.snapshot().currentBytes).toBe(0);
});


for (const queuedTerminal of [terminal, { type: "incomplete", reason: "max_tokens", usage }] as AdapterEvent[]) {
  test(`cancel before consuming a queued ${queuedTerminal.type} keeps usage but forbids a successful terminal`, async () => {
    const budget = createTestTranslatorBudget();
    const abort = new AbortController();
    const queue = createAdapterEventQueue();
    const iterator = orderDevinMessagesOutput(queue.stream(), budget, abort.signal, () => abort.abort());
    queue.push({ type: "text_delta", text: "held" });
    expect((await iterator.next()).value).toEqual({ type: "heartbeat" });
    queue.push(queuedTerminal);
    queue.close();
    abort.abort();
    expect((await iterator.next()).value).toMatchObject({ type: "error", status: 499, retryable: false, usage });
    expect((await iterator.next()).done).toBe(true);
    expect(budget.snapshot().currentBytes).toBe(0);
  });
}

test("cancelled partial drain never commits a completed response or replay state", async () => {
  const budget = createTestTranslatorBudget();
  const abort = new AbortController();
  const orderedEvents = orderDevinMessagesOutput((async function* () {
    yield { type: "text_delta", text: "partial" } as AdapterEvent;
    yield { type: "tool_call_start", id: "call_partial", name: "Write" } as AdapterEvent;
    yield { type: "tool_call_delta", arguments: '{"content":' } as AdapterEvent;
    yield terminal;
  })(), budget, abort.signal, () => abort.abort());
  const cancelDuringDrain = (async function* () {
    for await (const event of orderedEvents) {
      yield event;
      if (event.type === "text_delta") abort.abort();
    }
  })();
  let completions = 0;
  const observedUsage: unknown[] = [];
  const bridge = bridgeToResponsesSSE(cancelDuringDrain, "swe-2", undefined, undefined, undefined, undefined, 0, {
    translatorBudget: budget, onCompletedResponse: () => { completions++; }, onUsage: value => observedUsage.push(value),
  });
  const bytes = await new Response(bridge).text();
  expect(bytes).not.toContain("response.completed");
  expect(completions).toBe(0);
  expect(observedUsage).toContainEqual(usage);
  expect(bytes).toContain("client closed request");
});
