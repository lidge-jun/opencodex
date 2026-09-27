/**
 * GetChatMessage request shape and failure mapping, each pinned by a live
 * Cognition measurement: the system prompt rides request #2, a failed tool
 * result sets ChatMessagePrompt #9, Gemini tool schemas lose type arrays, and
 * an oversized history's opaque invalid_argument becomes context_length_exceeded.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDevinAdapter, mapOcxMessagesToDevin } from "../../src/adapters/devin";
import { parseCatalogBuffer, setCachedCatalogForTests } from "../../src/adapters/devin/cloud-direct/catalog";
import { buildGetChatMessageRequestForTests, type ChatHistoryItem } from "../../src/adapters/devin/cloud-direct/chat";
import { normalizeDevinToolParameters } from "../../src/adapters/devin/cloud-direct/tool-schema";
import { isDevinHistoryOverflow } from "../../src/adapters/devin/context-overflow";
import { encodeMessage, encodeString, encodeVarintField, iterFields } from "../../src/adapters/devin/cloud-direct/wire";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import type { AdapterEvent, OcxMessage, OcxParsedRequest } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

function build(messages: ChatHistoryItem[], extra: Record<string, unknown> = {}): Buffer {
  return buildGetChatMessageRequestForTests({
    apiKey: "k", modelUid: "swe-1-6", messages, cascadeId: "c", sessionId: "s", requestId: 1n, triggerId: "t", ...extra,
  } as never);
}

function topFields(buf: Buffer) {
  return [...iterFields(buf)];
}

function prompts(buf: Buffer) {
  return topFields(buf).filter((f) => f.num === 3).map((f) => [...iterFields(f.value as Buffer)]);
}

const text = (fields: ReturnType<typeof prompts>[number]) =>
  (fields.find((f) => f.num === 3)?.value as Buffer).toString("utf8");

describe("system prompt channel", () => {
  test("leading system text is request #2 and no prompt carries a <system> wrapper", () => {
    const buf = build([
      { role: "system", content: "S1" },
      { role: "system", content: "S2" },
      { role: "user", content: "U1" },
    ]);
    const system = topFields(buf).find((f) => f.num === 2)!.value as Buffer;
    expect(system.toString("utf8")).toBe("S1\n\nS2");
    const ps = prompts(buf);
    expect(ps).toHaveLength(1);
    expect(text(ps[0]!)).toBe("U1");
  });

  test("a system message after the conversation starts still reaches the model in the next user turn", () => {
    const ps = prompts(build([
      { role: "system", content: "S1" },
      { role: "user", content: "U1" },
      { role: "assistant", content: "A1" },
      { role: "system", content: "LATE" },
      { role: "user", content: "U2" },
    ]));
    expect(ps.map(text)).toEqual(["U1", "A1", "<system>\nLATE\n</system>\nU2"]);
  });

  test("#2 stays present and empty with no system text", () => {
    const system = topFields(build([{ role: "user", content: "hi" }])).find((f) => f.num === 2)!;
    expect((system.value as Buffer).length).toBe(0);
  });
});

describe("tool_result_is_error (#9)", () => {
  const parsed = (isError: boolean): OcxParsedRequest => ({
    modelId: "swe-1-6",
    stream: true,
    context: {
      messages: [
        { role: "user", content: "read it", timestamp: 1 },
        { role: "toolResult", toolCallId: "call_1", toolName: "read", content: [{ type: "text", text: "ENOENT" }], isError, timestamp: 2 } as unknown as OcxMessage,
      ],
    },
    options: {},
  } as OcxParsedRequest);

  test("a failed tool result sets #9=1 and keeps its text unprefixed", () => {
    const tool = prompts(build(mapOcxMessagesToDevin(parsed(true)))).at(-1)!;
    expect(Number(tool.find((f) => f.num === 9)?.value)).toBe(1);
    expect(text(tool)).toBe("ENOENT");
  });

  test("a successful tool result carries no #9", () => {
    const tool = prompts(build(mapOcxMessagesToDevin(parsed(false)))).at(-1)!;
    expect(tool.some((f) => f.num === 9)).toBe(false);
  });
});

describe("Gemini tool schema type arrays", () => {
  const schema = {
    type: "object",
    properties: {
      q: { type: ["string", "null"], description: "query" },
      default: { type: ["integer", "null"] },
      tags: { type: "array", items: { type: ["string", "null"] } },
      mode: { type: "string", enum: ["a", "b"], default: "a" },
    },
    required: ["q"],
    additionalProperties: false,
  };

  test("gemini uids get anyOf unions everywhere, including under a property named default", () => {
    const out = normalizeDevinToolParameters("gemini-3-8-flash-medium", schema) as any;
    expect(out.properties.q).toEqual({ description: "query", anyOf: [{ type: "string" }, { type: "null" }] });
    expect(out.properties.default).toEqual({ anyOf: [{ type: "integer" }, { type: "null" }] });
    expect(out.properties.tags.items).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
    expect(out.properties.mode).toEqual(schema.properties.mode);
    expect(out.additionalProperties).toBe(false);
    expect(JSON.stringify(out)).not.toContain('"type":[');
  });

  test("an existing anyOf is kept beside the new union", () => {
    const out = normalizeDevinToolParameters("MODEL_GOOGLE_GEMINI_2_5_PRO", {
      type: ["object", "null"], anyOf: [{ required: ["a"] }, { required: ["b"] }],
    }) as any;
    expect(out.anyOf).toEqual([{ required: ["a"] }, { required: ["b"] }]);
    expect(out.allOf).toEqual([{ anyOf: [{ type: "object" }, { type: "null" }] }]);
  });

  test("non-gemini uids and the encoded request for them are untouched", () => {
    expect(normalizeDevinToolParameters("claude-sonnet-5-low", schema)).toBe(schema);
    const tools = [{ name: "search", description: "d", parameters: schema }];
    expect(build([{ role: "user", content: "x" }], { tools }).includes(Buffer.from('"type":["string","null"]'))).toBe(true);
    const gemini = build([{ role: "user", content: "x" }], { tools, modelUid: "gemini-3-8-flash-medium" });
    expect(gemini.includes(Buffer.from('"type":['))).toBe(false);
  });
});

describe("oversized history classification", () => {
  const history = (chars: number): ChatHistoryItem[] => [{ role: "user", content: "x".repeat(chars) }];
  const base = { code: "invalid_argument", producedOutput: false, modelUid: "swe-1-6", tools: undefined };

  test("large against the catalog window is an overflow", () => {
    expect(isDevinHistoryOverflow({ ...base, contextWindow: 200_000, messages: history(1_200_000) })).toBe(true);
  });

  test("the same code on a small request stays a plain refusal", () => {
    expect(isDevinHistoryOverflow({ ...base, contextWindow: 200_000, messages: history(20_000) })).toBe(false);
  });

  test("other codes, or a turn that already produced output, are never reclassified", () => {
    expect(isDevinHistoryOverflow({ ...base, code: "permission_denied", contextWindow: 200_000, messages: history(1_200_000) })).toBe(false);
    expect(isDevinHistoryOverflow({ ...base, producedOutput: true, contextWindow: 200_000, messages: history(1_200_000) })).toBe(false);
  });

  test("with no known window the byte threshold decides, and image bytes do not count", () => {
    expect(isDevinHistoryOverflow({ ...base, contextWindow: undefined, messages: history(600 * 1024) })).toBe(true);
    expect(isDevinHistoryOverflow({ ...base, contextWindow: undefined, messages: history(100 * 1024) })).toBe(false);
    const image: ChatHistoryItem[] = [{ role: "user", content: [{ type: "text", text: "see" }, { type: "image", mimeType: "image/png", base64Data: "A".repeat(2_000_000) }] }];
    expect(isDevinHistoryOverflow({ ...base, contextWindow: undefined, messages: image })).toBe(false);
  });
});

describe("adapter surfaces an oversized history as context_length_exceeded", () => {
  const apiKey = "ocx-devin-overflow-fixture";
  const host = "https://server.codeium.com";
  const previousHome = process.env.OPENCODEX_HOME;
  const previousFetch = globalThis.fetch;
  let home = "";

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-devin-overflow-"));
    process.env.OPENCODEX_HOME = home;
    setCachedCatalogForTests(parseCatalogBuffer(encodeMessage(1, Buffer.concat([
      encodeString(1, "swe-1-6"), encodeString(22, "swe-1-6"), encodeVarintField(18, 200_000), encodeVarintField(4, 0),
    ])), apiKey, host));
    const trailer = Buffer.from(JSON.stringify({ error: { code: "invalid_argument", message: "bad request" } }));
    const frame = Buffer.alloc(5 + trailer.length);
    frame[0] = 0x02;
    frame.writeUInt32BE(trailer.length, 1);
    trailer.copy(frame, 5);
    globalThis.fetch = (async () => new Response(frame, { status: 200, headers: { "Content-Type": "application/connect+proto" } })) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = previousFetch;
    setCachedCatalogForTests(null);
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(home);
  });

  async function turn(content: string): Promise<AdapterEvent[]> {
    const events: AdapterEvent[] = [];
    await createDevinAdapter({ adapter: "devin", apiKey, baseUrl: host }).runTurn!({
      modelId: "swe-1-6", stream: true, context: { messages: [{ role: "user", content, timestamp: 1 }] }, options: {},
    }, { headers: new Headers(), translatorBudget: createTranslatorBudget(), abortSignal: AbortSignal.timeout(5_000) }, (e) => { events.push(e); });
    return events;
  }

  test("1.2 MB of history against a 200k window", async () => {
    const events = await turn("word ".repeat(240_000));
    expect(events.at(-1)).toMatchObject({ type: "error", status: 400, code: "context_length_exceeded", errorType: "invalid_request_error", retryable: false });
  });

  test("a short turn with the same refusal stays invalid_argument", async () => {
    const events = await turn("hi");
    expect(events.at(-1)).toMatchObject({ type: "error", status: 400, code: "invalid_argument" });
  });
});
