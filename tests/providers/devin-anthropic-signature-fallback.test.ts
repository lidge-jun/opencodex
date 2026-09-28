import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { createDevinAdapter } from "../../src/adapters/devin";
import type { IncomingMeta } from "../../src/adapters/base";
import { parseCatalogBuffer, setCachedCatalogForTests } from "../../src/adapters/devin/cloud-direct/catalog";
import { devinCacheIdentity, invalidateSessionIdentity } from "../../src/adapters/devin/cloud-direct/chat";
import { encodeMessage, encodeString, encodeVarintField, iterFields } from "../../src/adapters/devin/cloud-direct/wire";
import { encodeDevinSignature } from "../../src/adapters/devin/reasoning-signature";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { encodeReasoningEnvelope } from "../../src/responses/reasoning-envelope";
import { parseRequest } from "../../src/responses/parser";
import type { AdapterEvent } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// Cognition streams Claude's thinking as a summary while the signature covers the
// original, so a signed replay can be refused with an opaque invalid_argument before
// any output. The adapter sends the signature (it is what carries the reasoning) and
// retries a refusal once without it.
describe("Devin Anthropic signature fallback", () => {
  const apiKey = "ocx-devin-signature-fixture";
  const host = "https://server.codeium.com";
  const previousHome = process.env.OPENCODEX_HOME;
  const previousFetch = globalThis.fetch;
  let home = "";
  let requests: Buffer[] = [];
  let responses: Array<"refuse" | "ok" | "text-then-refuse" | "reasoning-then-refuse" | "reasoning-then-ok" | "usage-reasoning-then-refuse" | "split-usage-then-refuse" | "usage-ok" | "many-reasoning-then-refuse" | "large-reasoning-then-refuse"> = [];

  const frame = (body: Buffer, flags = 0) => {
    const header = Buffer.alloc(5);
    header[0] = flags;
    header.writeUInt32BE(body.length, 1);
    return Buffer.concat([header, body]);
  };
  const refusal = frame(Buffer.from(JSON.stringify({ error: { code: "invalid_argument", message: "an internal error occurred" } })), 2);
  const ok = Buffer.concat([frame(Buffer.concat([encodeString(3, "ok"), encodeVarintField(5, 2)])), frame(Buffer.from("{}"), 2)]);

  function assistantSignature(request: Buffer): { thinking?: string; signature?: string } {
    const prompts = [...iterFields(request)].filter(f => f.num === 3).map(f => f.value as Buffer);
    const assistant = prompts.find(p => [...iterFields(p)].some(f => f.num === 2 && f.value === 2n))!;
    const byNum = new Map([...iterFields(assistant)].filter(f => f.wire === 2).map(f => [f.num, (f.value as Buffer).toString("utf8")]));
    return { thinking: byNum.get(11), signature: byNum.get(12) };
  }

  async function run(signature: string, modelId: string, observed?: AdapterEvent[], userText = "go", meta: Pick<IncomingMeta, "sendBudget" | "onRecoveryWithheld"> = {}): Promise<AdapterEvent[]> {
    const parsed = parseRequest({
      model: `devin/${modelId}`,
      input: [
        { role: "user", content: [{ type: "input_text", text: userText }] },
        { type: "reasoning", id: "rs", summary: [], encrypted_content: encodeReasoningEnvelope({ txt: "summarised thought", sig: signature }) },
        { type: "function_call", call_id: "call_1", name: "get_time", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "12:00" },
      ],
    });
    parsed.modelId = modelId;
    const adapter = createDevinAdapter({ adapter: "devin", apiKey, baseUrl: host });
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(parsed, { headers: new Headers(), translatorBudget: createTranslatorBudget(), ...meta }, event => { events.push(event); observed?.push(event); });
    return events;
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-devin-sigfallback-"));
    process.env.OPENCODEX_HOME = home;
    requests = [];
    responses = [];
    setCachedCatalogForTests(null);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).endsWith("/GetChatMessage")) return new Response("unavailable", { status: 503 });
      requests.push(Buffer.from(await (init!.body as Blob).arrayBuffer()).subarray(5));
      const next = responses.shift() ?? "ok";
      const body = next === "refuse" ? refusal
        : next === "text-then-refuse" ? Buffer.concat([frame(encodeString(3, "partial")), refusal])
        // The live shape: reasoning, its signature and a finish frame, then the refusal trailer.
        : next === "reasoning-then-refuse" ? Buffer.concat([frame(Buffer.concat([encodeString(9, "thinking"), encodeString(10, "EpcBNew"), encodeString(21, "anthropic"), encodeVarintField(5, 2)])), refusal])
        : next === "reasoning-then-ok" ? Buffer.concat([frame(Buffer.concat([encodeString(9, "thinking"), encodeString(10, "EpcBNew"), encodeString(21, "anthropic")])), ok])
        // ModelUsageStats (#7) arrives with the reasoning, before the refusal trailer.
        : next === "usage-reasoning-then-refuse" ? Buffer.concat([frame(Buffer.concat([encodeMessage(7, Buffer.concat([encodeVarintField(2, 1000), encodeVarintField(3, 40)])), encodeString(9, "thinking")])), frame(encodeString(9, " more")), refusal])
        : next === "split-usage-then-refuse" ? Buffer.concat([
          frame(encodeMessage(7, Buffer.concat([encodeVarintField(2, 1000), encodeVarintField(4, 100), encodeVarintField(5, 600)]))),
          frame(encodeMessage(7, encodeVarintField(3, 40))), refusal,
        ])
        : next === "usage-ok" ? Buffer.concat([frame(Buffer.concat([encodeMessage(7, Buffer.concat([encodeVarintField(2, 1100), encodeVarintField(3, 20)])), encodeString(3, "ok"), encodeVarintField(5, 2)])), frame(Buffer.from("{}"), 2)])
        : next === "many-reasoning-then-refuse" ? Buffer.concat([frame(encodeString(9, "x")), ...Array.from({ length: 1_024 }, () => frame(encodeString(9, "x"))), refusal])
        : next === "large-reasoning-then-refuse" ? Buffer.concat([frame(encodeString(9, "x".repeat(524_289))), refusal])
        : ok;
      return new Response(body, { headers: { "content-type": "application/connect+proto" } });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = previousFetch;
    setCachedCatalogForTests(null);
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    invalidateSessionIdentity(devinCacheIdentity(apiKey, host));
    removeTreeWithRetry(home);
  });

  test("a refused signed Claude turn is retried once with the signature withheld", async () => {
    responses = ["refuse", "ok"];
    const events = await run(encodeDevinSignature("EpcBClaude", "anthropic"), "claude-opus-5-5-medium");
    expect(requests).toHaveLength(2);
    expect(assistantSignature(requests[0]!)).toEqual({ thinking: "summarised thought", signature: "EpcBClaude" });
    expect(assistantSignature(requests[1]!)).toEqual({ thinking: "summarised thought", signature: undefined });
    expect(events.some(e => e.type === "error")).toBe(false);
    expect(events).toContainEqual({ type: "text_delta", text: "ok" });
  });

  test("a signed refusal at 95% of the catalog window retries unsigned before overflow classification", async () => {
    const modelId = "claude-opus-5-5-medium";
    setCachedCatalogForTests(parseCatalogBuffer(encodeMessage(1, Buffer.concat([
      encodeString(1, modelId), encodeString(22, modelId), encodeVarintField(18, 200_000), encodeVarintField(4, 0),
    ])), apiKey, host));
    responses = ["refuse", "ok"];
    const events = await run(encodeDevinSignature("EpcBClaude", "anthropic"), modelId, undefined, "word ".repeat(190_000));
    expect(requests).toHaveLength(2);
    expect(assistantSignature(requests[0]!).signature).toBe("EpcBClaude");
    expect(assistantSignature(requests[1]!).signature).toBeUndefined();
    expect(events).toContainEqual({ type: "text_delta", text: "ok" });
    expect(events.some(e => e.type === "error" && e.code === "context_length_exceeded")).toBe(false);
  });

  test("an unsigned retry denied by the send budget preserves the signed invalid_argument", async () => {
    responses = ["refuse", "ok"];
    const withheld: string[] = [];
    const budget = createRequestExecutionBudget({
      maxTotalModelSends: 1, baseSendAllowance: 1, finalRecoveryAllowance: 0,
      maxAlternateTargetSends: 0, maxTargetTransitions: 0,
    }, "devin-signature-refusal");
    const events = await run(encodeDevinSignature("EpcBClaude", "anthropic"), "claude-opus-5-5-medium", undefined, "go", {
      sendBudget: budget,
      onRecoveryWithheld: event => { withheld.push(event.reason); },
    });
    expect(requests).toHaveLength(1);
    expect(budget.used).toBe(1);
    expect(withheld).toEqual(["retry-send-budget"]);
    expect(events.find(e => e.type === "error")).toMatchObject({ type: "error", code: "invalid_argument", status: 400 });
  });

  test("a budget-withheld unsigned retry still classifies a full signed history as context overflow", async () => {
    const modelId = "claude-opus-5-5-medium";
    setCachedCatalogForTests(parseCatalogBuffer(encodeMessage(1, Buffer.concat([
      encodeString(1, modelId), encodeString(22, modelId), encodeVarintField(18, 200_000), encodeVarintField(4, 0),
    ])), apiKey, host));
    responses = ["refuse", "ok"];
    const budget = createRequestExecutionBudget({
      maxTotalModelSends: 1, baseSendAllowance: 1, finalRecoveryAllowance: 0,
      maxAlternateTargetSends: 0, maxTargetTransitions: 0,
    }, "devin-signature-overflow");
    const events = await run(encodeDevinSignature("EpcBClaude", "anthropic"), modelId, undefined, "word ".repeat(190_000), { sendBudget: budget });
    expect(requests).toHaveLength(1);
    expect(events.find(e => e.type === "error")).toMatchObject({ type: "error", code: "context_length_exceeded", status: 400 });
  });

  test("a refusal after reasoning alone is still retried, and the refused attempt's reasoning never reaches the client", async () => {
    responses = ["reasoning-then-refuse", "ok"];
    const events = await run(encodeDevinSignature("EpcBClaude", "anthropic"), "claude-opus-5-5-medium");
    expect(requests).toHaveLength(2);
    expect(assistantSignature(requests[1]!).signature).toBeUndefined();
    expect(events.some(e => e.type === "error")).toBe(false);
    expect(events).toContainEqual({ type: "text_delta", text: "ok" });
    // The refused attempt streamed "thinking" and signature EpcBNew; neither may leak into the turn.
    expect(events.some(e => e.type === "thinking_delta")).toBe(false);
    expect(events.some(e => e.type === "thinking_signature")).toBe(false);
  });

  test("an accepted signed turn still delivers its held reasoning", async () => {
    responses = ["reasoning-then-ok"];
    const events = await run(encodeDevinSignature("EpcBClaude", "anthropic"), "claude-opus-5-5-medium");
    expect(requests).toHaveLength(1);
    const kinds = events.map(e => e.type);
    expect(kinds).toContain("thinking_delta");
    expect(events).toContainEqual({ type: "thinking_signature", signature: encodeDevinSignature("EpcBNew", "anthropic") });
    expect(kinds.indexOf("thinking_delta")).toBeLessThan(kinds.indexOf("text_delta"));
  });

  test("the refused attempt's usage is added to the retry's", async () => {
    responses = ["usage-reasoning-then-refuse", "usage-ok"];
    const events = await run(encodeDevinSignature("EpcBClaude", "anthropic"), "claude-opus-5-5-medium");
    expect(requests).toHaveLength(2);
    const done = events.find(e => e.type === "done") as { usage?: { inputTokens?: number; outputTokens?: number } } | undefined;
    expect(done?.usage?.inputTokens).toBe(2100);
    expect(done?.usage?.outputTokens).toBe(60);
  });

  test("partial held usage frames retain input and cache counts when the last frame reports output only", async () => {
    responses = ["split-usage-then-refuse", "usage-ok"];
    const events = await run(encodeDevinSignature("EpcBClaude", "anthropic"), "claude-opus-5-5-medium");
    expect(requests).toHaveLength(2);
    const done = events.find(e => e.type === "done");
    expect(done).toMatchObject({
      type: "done",
      usage: { inputTokens: 2100, outputTokens: 60, totalTokens: 2160, cachedInputTokens: 600, cacheCreationInputTokens: 100 },
    });
  });

  test("the refused attempt's usage survives a retry with no usage frame or an early failure", async () => {
    responses = ["usage-reasoning-then-refuse", "ok"];
    const done = (await run(encodeDevinSignature("EpcBClaude", "anthropic"), "claude-opus-5-5-medium"))
      .find(e => e.type === "done") as { usage?: { inputTokens?: number; outputTokens?: number } } | undefined;
    expect(done?.usage?.inputTokens).toBe(1000);
    expect(done?.usage?.outputTokens).toBe(40);

    requests = [];
    responses = ["usage-reasoning-then-refuse", "refuse"];
    const failed = (await run(encodeDevinSignature("EpcBClaude", "anthropic"), "claude-opus-5-5-medium"))
      .find(e => e.type === "error") as { usage?: { inputTokens?: number } } | undefined;
    expect(requests).toHaveLength(2);
    expect(failed?.usage?.inputTokens).toBe(1000);
  });

  test("a held signed attempt sends a plain heartbeat while the upstream trailer is paused", async () => {
    const started = Promise.withResolvers<void>();
    const releaseTrailer = Promise.withResolvers<void>();
    const regularFetch = globalThis.fetch;
    const observed: AdapterEvent[] = [];
    let first = true;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).endsWith("/GetChatMessage") || !first) return regularFetch(input, init);
      first = false;
      requests.push(Buffer.from(await (init!.body as Blob).arrayBuffer()).subarray(5));
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(frame(encodeString(9, "held thinking")));
          started.resolve();
          void releaseTrailer.promise.then(() => {
            controller.enqueue(refusal);
            controller.close();
          });
        },
      });
      return new Response(body, { headers: { "content-type": "application/connect+proto" } });
    }) as typeof fetch;
    jest.useFakeTimers();
    try {
      const pending = run(encodeDevinSignature("EpcBClaude", "anthropic"), "claude-opus-5-5-medium", observed);
      await started.promise;
      jest.advanceTimersByTime(20_000);
      expect(observed).toContainEqual({ type: "heartbeat" });
      expect(observed.some(e => e.type === "thinking_delta")).toBe(false);
      releaseTrailer.resolve();
      const events = await pending;
      expect(requests).toHaveLength(2);
      expect(events).toContainEqual({ type: "text_delta", text: "ok" });
      const count = events.filter(e => e.type === "heartbeat").length;
      jest.advanceTimersByTime(30_000);
      expect(observed.filter(e => e.type === "heartbeat")).toHaveLength(count);
    } finally {
      releaseTrailer.resolve();
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  test("a held event count above the cap flushes and disables unsigned retry", async () => {
    responses = ["many-reasoning-then-refuse", "ok"];
    const events = await run(encodeDevinSignature("EpcBClaude", "anthropic"), "claude-opus-5-5-medium");
    expect(requests).toHaveLength(1);
    expect(events.some(e => e.type === "thinking_delta")).toBe(true);
    expect(events.some(e => e.type === "error")).toBe(true);
  });

  test("a held reasoning text budget above the cap flushes and disables unsigned retry", async () => {
    responses = ["large-reasoning-then-refuse", "ok"];
    const events = await run(encodeDevinSignature("EpcBClaude", "anthropic"), "claude-opus-5-5-medium");
    expect(requests).toHaveLength(1);
    expect(events.some(e => e.type === "thinking_delta")).toBe(true);
    expect(events.some(e => e.type === "error")).toBe(true);
  });

  test("an accepted signed Claude turn is sent once, signature included", async () => {
    responses = ["ok"];
    await run(encodeDevinSignature("EpcBClaude", "anthropic"), "claude-opus-5-5-medium");
    expect(requests).toHaveLength(1);
    expect(assistantSignature(requests[0]!).signature).toBe("EpcBClaude");
  });

  test("a refusal is not retried for a non-Anthropic signature or after output", async () => {
    responses = ["refuse", "ok"];
    const sealed = await run(encodeDevinSignature("sealed.v1.x", "sealed"), "swe-2-high");
    expect(requests).toHaveLength(1);
    expect(sealed.some(e => e.type === "error")).toBe(true);

    requests = [];
    responses = ["text-then-refuse", "ok"];
    const partial = await run(encodeDevinSignature("EpcBClaude", "anthropic"), "claude-opus-5-5-medium");
    expect(requests).toHaveLength(1);
    expect(partial.some(e => e.type === "error")).toBe(true);
  });
});
