import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKiroAdapter as createKiroAdapterProduction } from "../../../src/adapters/kiro";
import { parseKiroEvent } from "../../../src/adapters/kiro-events";
import { resetKiroThrottleStateForTests } from "../../../src/adapters/kiro-retry";
import { encodeMessage } from "../../../src/lib/eventstream-decoder";
import { guardEmptyCompletionEventStream } from "../../../src/server/responses/empty-completion-guard";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import { withTestTranslatorBudget } from "../../helpers/translator-budget";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

/**
 * Kiro's safety filter refusing a turn (frame shape captured live from kiro/claude-sonnet-5.5).
 * A tool-less turn runs in `disabled` completion mode and used to map this content-free stream to
 * the replay-safe `empty_kiro_stream`, so clients resent a refusal that repeats deterministically.
 */
const enc = new TextEncoder();
const origHome = process.env.HOME;
const origRegion = process.env.KIRO_REGION;
const realFetch = globalThis.fetch;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "kiro-content-filter-"));
  process.env.HOME = tmp;
  process.env.KIRO_REGION = "us-east-1";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  resetKiroThrottleStateForTests();
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  if (origRegion === undefined) delete process.env.KIRO_REGION; else process.env.KIRO_REGION = origRegion;
  removeTreeWithRetry(tmp);
});

const provider = { adapter: "kiro", baseUrl: "https://runtime.us-east-1.kiro.dev", authMode: "oauth", apiKey: "tok-123" } as unknown as OcxProviderConfig;
const bashTool = { name: "bash", description: "Run a shell command", parameters: { type: "object" } };
const explanation = "The selected model cannot continue this conversation. Please select a different model, "
  + "or start a new conversation, or rewind the current conversation to an earlier point and try a different approach.";
const capturedRefusal = { stopDetails: { refusal: { category: "BIO", explanation } }, stopReason: "CONTENT_FILTERED" };

const frame = (eventType: string, payload: unknown) =>
  encodeMessage({ ":message-type": "event", ":event-type": eventType }, enc.encode(JSON.stringify(payload)));
const initial = () => frame("initial-response", { conversationId: "" });
const contextUsage = () => frame("contextUsageEvent", { contextUsagePercentage: 1.7943000793457031 });
const text = (content: string) => frame("assistantResponseEvent", { content });
const metadata = (payload: unknown) => frame("metadataEvent", payload);

function streamOf(...frames: Uint8Array[]): Response {
  let i = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < frames.length) c.enqueue(frames[i++]);
      else c.close();
    },
  }));
}

async function run(tools: unknown[] | undefined, ...frames: Uint8Array[]): Promise<{ events: AdapterEvent[]; fetches: number }> {
  let fetches = 0;
  // A bounded completion retry must never run for a filtered turn; one that does sees an answer.
  globalThis.fetch = (async () => {
    fetches++;
    return streamOf(text("must not run"));
  }) as unknown as typeof fetch;
  const adapter = withTestTranslatorBudget(createKiroAdapterProduction(provider));
  await adapter.buildRequest({
    modelId: "claude-sonnet-4.5", stream: true, options: {},
    context: { messages: [{ role: "user", content: "hello" }], tools },
  } as unknown as OcxParsedRequest);
  const events: AdapterEvent[] = [];
  for await (const event of adapter.parseStream(streamOf(...frames))) events.push(event);
  return { events, fetches };
}

describe("Kiro CONTENT_FILTERED stop", () => {
  test("metadataEvent carries the refusal category and explanation", () => {
    expect(parseKiroEvent("metadataEvent", enc.encode(JSON.stringify(capturedRefusal)))).toEqual({
      type: "metadata",
      stopReason: "CONTENT_FILTERED",
      refusal: { category: "BIO", explanation },
    });
  });

  test("a malformed stopDetails drops the details, not the stop reason", () => {
    for (const stopDetails of ["BIO", [], { refusal: "BIO" }, { refusal: { category: 7, explanation: " " } }]) {
      expect(parseKiroEvent("metadataEvent", enc.encode(JSON.stringify({ stopDetails, stopReason: "CONTENT_FILTERED" }))))
        .toEqual({ type: "metadata", stopReason: "CONTENT_FILTERED" });
    }
  });

  test("a tool-less turn with only the refusal is a non-retryable content filter", async () => {
    const { events, fetches } = await run(undefined, initial(), metadata(capturedRefusal), contextUsage());
    expect(fetches).toBe(0);
    expect(events.filter(event => event.type === "text_delta")).toEqual([]);
    const terminal = events.at(-1);
    expect(terminal).toMatchObject({ type: "incomplete", reason: "content_filter", retryable: false, endTurn: false });
    expect(terminal?.type === "incomplete" ? terminal.message : "")
      .toBe(`Kiro stopped with CONTENT_FILTERED, category BIO: ${explanation}`);
  });

  test("a tool-less turn filtered after partial text does not complete as a final answer", async () => {
    const { events } = await run(undefined, text("Partial."), metadata(capturedRefusal));
    expect(events.filter(event => event.type === "text_delta")).toEqual([{ type: "text_delta", text: "Partial." }]);
    expect(events.at(-1)).toMatchObject({ type: "incomplete", reason: "content_filter", retryable: false });
  });

  test("GUARDRAIL_INTERVENED without details is a content filter too", async () => {
    const { events } = await run(undefined, metadata({ stopReason: "GUARDRAIL_INTERVENED" }));
    expect(events.at(-1)).toMatchObject({
      type: "incomplete", reason: "content_filter", retryable: false, message: "Kiro stopped with GUARDRAIL_INTERVENED",
    });
  });

  test("required completion mode keeps its non-retryable content filter without a completion retry", async () => {
    for (const frames of [[text("Partial."), metadata(capturedRefusal)], [initial(), metadata(capturedRefusal), contextUsage()]]) {
      const { events, fetches } = await run([bashTool], ...frames);
      expect(fetches).toBe(0);
      expect(events.at(-1)).toMatchObject({
        type: "incomplete", reason: "content_filter", retryable: false,
        message: `Kiro stopped with CONTENT_FILTERED, category BIO: ${explanation}`,
      });
    }
  });

  test("a filtered bounded completion retry is a content filter, not an empty fallback", async () => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      return streamOf(initial(), metadata(capturedRefusal), contextUsage());
    }) as unknown as typeof fetch;
    const adapter = withTestTranslatorBudget(createKiroAdapterProduction(provider));
    await adapter.buildRequest({
      modelId: "claude-sonnet-4.5", stream: true, options: {},
      context: { messages: [{ role: "user", content: "hello" }], tools: [bashTool] },
    } as unknown as OcxParsedRequest);
    const events: AdapterEvent[] = [];
    // No stop reason on the first attempt sends it through the one bounded retry.
    for await (const event of adapter.parseStream(streamOf(text("Checking.")))) events.push(event);
    expect(fetches).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: "incomplete", reason: "content_filter", retryable: false });
  });

  test("a retry filtered after partial text keeps the first attempt's progress", async () => {
    // Retry text normally supersedes the first attempt's held progress. A filtered retry produced no
    // accepted answer, so both attempts' text reaches the client as commentary before the refusal.
    globalThis.fetch = (async () => streamOf(initial(), text("Partial retry"), metadata(capturedRefusal), contextUsage())) as unknown as typeof fetch;
    const adapter = withTestTranslatorBudget(createKiroAdapterProduction(provider));
    await adapter.buildRequest({
      modelId: "claude-sonnet-4.5", stream: true, options: {},
      context: { messages: [{ role: "user", content: "hello" }], tools: [bashTool] },
    } as unknown as OcxParsedRequest);
    const events: AdapterEvent[] = [];
    for await (const event of adapter.parseStream(streamOf(text("Checking.")))) events.push(event);
    const texts = events.filter(event => event.type === "text_delta").map(event => (event as { text: string }).text);
    expect(texts).toEqual(["Checking.", "Partial retry"]);
    expect(events.filter(event => event.type === "text_delta").every(event => (event as { phase?: string }).phase === "commentary")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "incomplete", reason: "content_filter", retryable: false });
  });

  test("the empty-completion guard passes the refusal through instead of retrying it", async () => {
    const { events } = await run(undefined, initial(), metadata(capturedRefusal), contextUsage());
    let continuations = 0;
    const guarded: AdapterEvent[] = [];
    for await (const event of guardEmptyCompletionEventStream({
      firstEvents: (async function* () { yield* events; })(),
      continuation: () => {
        continuations++;
        return (async function* () { yield* events; })();
      },
    })) guarded.push(event);
    expect(continuations).toBe(0);
    expect(guarded.at(-1)).toMatchObject({ type: "incomplete", reason: "content_filter", retryable: false });
  });
});

describe("Kiro empty stream without a stop reason", () => {
  test("stays the replay-safe empty_kiro_stream", async () => {
    const { events } = await run(undefined, initial(), contextUsage());
    expect(events.at(-1)).toMatchObject({
      type: "incomplete",
      reason: "empty_kiro_stream",
      message: "Kiro returned a successful but empty response stream",
      retryable: true,
    });
  });
});
