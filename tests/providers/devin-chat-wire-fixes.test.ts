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
import { createDevinAdapter, mapOcxMessagesToDevin, resolveDevinContextWindowForTests } from "../../src/adapters/devin";
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

  test("a request with only system text keeps it as a user prompt", () => {
    const buf = build([{ role: "system", content: "ONLY" }]);
    expect((topFields(buf).find((f) => f.num === 2)!.value as Buffer).length).toBe(0);
    expect(prompts(buf).map(text)).toEqual(["<system>\nONLY\n</system>"]);
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

  test("a failed tool result sets #9=1 and keeps the in-band marker", () => {
    const tool = prompts(build(mapOcxMessagesToDevin(parsed(true)))).at(-1)!;
    expect(Number(tool.find((f) => f.num === 9)?.value)).toBe(1);
    expect(text(tool)).toBe("ERROR:\nENOENT");
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
    expect(out.type).toBe("object");
    expect(out.properties.default).toEqual({ anyOf: [{ type: "integer" }, { type: "null" }] });
    expect(out.properties.tags.items).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
    expect(out.properties.mode).toEqual(schema.properties.mode);
    expect(out.additionalProperties).toBe(false);
    expect(JSON.stringify(out)).not.toContain('"type":[');
  });

  test("type-specific keywords stay beside the type union without being duplicated", () => {
    const out = normalizeDevinToolParameters("gemini-3-8-flash-medium", {
      type: "object",
      properties: {
        list: { type: ["array", "null"], description: "d", items: { type: "string" }, minItems: 1 },
        obj: { type: ["object", "null"], properties: { a: { type: "string" } }, required: ["a"] },
      },
    }) as any;
    expect(out.properties.list).toEqual({
      description: "d", items: { type: "string" }, minItems: 1, anyOf: [{ type: "array" }, { type: "null" }],
    });
    expect(out.properties.obj).toEqual({
      properties: { a: { type: "string" } }, required: ["a"], anyOf: [{ type: "object" }, { type: "null" }],
    });
  });

  test("a branch that contradicts an outer keyword keeps both constraints conjoined", () => {
    const out = normalizeDevinToolParameters("gemini-x", {
      type: ["string", "null"], maxLength: 5, anyOf: [{ maxLength: 50 }, { type: "null" }],
    }) as any;
    expect(out).toEqual({
      maxLength: 5,
      anyOf: [{ maxLength: 50 }, { type: "null" }],
      allOf: [{ anyOf: [{ type: "string" }, { type: "null" }] }],
    });
  });

  test("a type union disjoint from the existing anyOf keeps both constraints", () => {
    const out = normalizeDevinToolParameters("gemini-x", {
      type: ["string", "null"], minLength: 2, anyOf: [{ type: "integer" }],
    }) as any;
    expect(out).toEqual({
      minLength: 2,
      anyOf: [{ type: "integer" }],
      allOf: [{ anyOf: [{ type: "string" }, { type: "null" }] }],
    });
  });

  test("an existing anyOf remains a separate constraint", () => {
    const out = normalizeDevinToolParameters("MODEL_GOOGLE_GEMINI_2_5_PRO", {
      type: ["object", "null"], anyOf: [{ required: ["a"] }, { required: ["b"] }],
    }) as any;
    expect(out.allOf).toEqual([
      { anyOf: [{ type: "object" }, { type: "null" }] },
    ]);
    expect(out.anyOf).toEqual([{ required: ["a"] }, { required: ["b"] }]);
    const typed = normalizeDevinToolParameters("gemini-x", {
      type: ["string", "null"], anyOf: [{ type: "string", format: "date" }, { type: "integer" }],
    }) as any;
    expect(typed).toEqual({
      anyOf: [{ type: "string", format: "date" }, { type: "integer" }],
      allOf: [{ anyOf: [{ type: "string" }, { type: "null" }] }],
    });
  });

  test("outer enum and const exclude null from a Gemini type union", () => {
    expect(normalizeDevinToolParameters("gemini-x", { type: ["string", "null"], enum: ["a"] })).toEqual({
      type: "string", enum: ["a"],
    });
    expect(normalizeDevinToolParameters("gemini-x", { type: ["string", "null"], const: "a" })).toEqual({
      type: "string", const: "a",
    });
  });

  for (const restriction of [{ enum: ["a"] }, { const: "a" }]) {
    test(`a null-only type stays valid when ${Object.keys(restriction)[0]} excludes null`, () => {
      const parameters = { type: ["null"], ...restriction };
      // A null type and its excluding sibling constraint remain unsatisfiable,
      // without replacing a valid schema with the invalid applicator anyOf: [].
      expect(normalizeDevinToolParameters("gemini-x", parameters)).toEqual({ type: "null", ...restriction });
      const anyOf = [{ type: "null" }];
      const allOf = [{ title: "existing index zero" }];
      expect(normalizeDevinToolParameters("gemini-x", { ...parameters, anyOf, allOf })).toEqual({
        ...restriction, anyOf, allOf: [...allOf, { type: "null" }],
      });
      expect(parameters.type).toEqual(["null"]);
    });
  }

  test("an existing anyOf null branch keeps its own restrictions", () => {
    expect(normalizeDevinToolParameters("gemini-x", {
      type: ["string", "null"], anyOf: [{ type: "string" }, { type: "null", const: "a" }],
    })).toEqual({
      anyOf: [{ type: "string" }, { type: "null", const: "a" }],
      allOf: [{ anyOf: [{ type: "string" }, { type: "null" }] }],
    });
  });

  test("unevaluated annotations stay on the node so a sibling anyOf still counts as evaluated", () => {
    const out = normalizeDevinToolParameters("gemini-x", {
      type: ["object", "null"],
      unevaluatedProperties: false,
      unevaluatedItems: false,
      anyOf: [{ properties: { a: { type: "string" } } }, { type: "null" }],
    }) as any;
    expect(out.unevaluatedProperties).toBe(false);
    expect(out.unevaluatedItems).toBe(false);
    // Inside one allOf branch these keywords would lose the sibling anyOf's
    // evaluation annotations and reject valid arguments.
    expect(JSON.stringify(out.allOf)).not.toContain("unevaluatedProperties");
    expect(JSON.stringify(out.allOf)).not.toContain("unevaluatedItems");
    expect(out.allOf).toEqual([
      { anyOf: [{ type: "object" }, { type: "null" }] },
    ]);
    expect(out.anyOf).toEqual([{ properties: { a: { type: "string" } } }, { type: "null" }]);
  });

  test("existing anyOf references still resolve at the original schema resource", () => {
    const parameters = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://schemas.example.test/tool.json",
      $anchor: "tool", $dynamicAnchor: "toolDynamic",
      type: ["object", "null"],
      $defs: { Query: { type: ["string", "null"], minLength: 1 } },
      definitions: { Count: { type: "integer", minimum: 0 } },
      anyOf: [{ properties: { query: { $ref: "#/$defs/Query" }, count: { $ref: "#/definitions/Count" } } }, { type: "null" }],
    };
    const original = JSON.stringify(parameters);
    const out = normalizeDevinToolParameters("gemini-x", parameters) as any;
    for (const key of ["$schema", "$id", "$anchor", "$dynamicAnchor"] as const) {
      expect(out[key]).toBe(parameters[key]);
    }
    const properties = out.anyOf[0].properties;
    // Resolve the emitted references from the resource root, as JSON Pointer does.
    const resolve = (ref: string) => ref.slice(2).split("/").reduce((node, key) => node?.[key], out);
    expect(resolve(properties.query.$ref)).toEqual({ minLength: 1, anyOf: [{ type: "string" }, { type: "null" }] });
    expect(resolve(properties.count.$ref)).toEqual({ type: "integer", minimum: 0 });
    expect(JSON.stringify(parameters)).toBe(original);
  });

  test("outer not and oneOf still constrain the null branch", () => {
    expect(normalizeDevinToolParameters("gemini-x", {
      type: ["string", "null"], not: { type: "null" },
    })).toEqual({
      not: { type: "null" },
      anyOf: [{ type: "string" }, { type: "null" }],
    });
    expect(normalizeDevinToolParameters("gemini-x", {
      type: ["string", "null"], oneOf: [{ type: "string" }, { const: "x" }],
    })).toEqual({
      oneOf: [{ type: "string" }, { const: "x" }],
      anyOf: [{ type: "string" }, { type: "null" }],
    });
  });

  for (const withAllOf of [false, true]) {
    test(`JSON Pointer targets keep anyOf and existing allOf indices (${withAllOf ? "with" : "without"} allOf)`, () => {
      const parameters = {
        type: ["object", "null"],
        anyOf: [{ properties: {
          a: { type: "string" }, b: { $ref: "#/anyOf/0/properties/a" },
        } }, { type: "null" }],
        ...(withAllOf ? { allOf: [
          { properties: { c: { type: "integer" } } },
          { properties: { d: { $ref: "#/allOf/0/properties/c" } } },
        ] } : {}),
      };
      const original = JSON.stringify(parameters);
      const out = normalizeDevinToolParameters("gemini-x", parameters) as any;
      const resolve = (ref: string) => ref.slice(2).split("/").reduce((node, key) => node?.[key], out);
      // Resolve the original pointer before inspecting the output's shape: relocating
      // anyOf/allOf must fail as a missing target, not merely as a different spelling.
      expect(resolve("#/anyOf/0/properties/a")).toEqual({ type: "string" });
      const ref = out.anyOf[0].properties.b.$ref;
      expect(ref).toBe("#/anyOf/0/properties/a");
      expect(resolve(ref)).toEqual({ type: "string" });
      if (withAllOf) {
        expect(resolve("#/allOf/0/properties/c")).toEqual({ type: "integer" });
        expect(out.allOf[1].properties.d.$ref).toBe("#/allOf/0/properties/c");
        expect(resolve(out.allOf[1].properties.d.$ref)).toEqual({ type: "integer" });
        expect(out.allOf.slice(0, 2)).toEqual(parameters.allOf);
      }
      expect(out.allOf.at(-1)).toEqual({ anyOf: [{ type: "object" }, { type: "null" }] });
      expect(out.allOf).toHaveLength(withAllOf ? 3 : 1);
      expect(JSON.stringify(parameters)).toBe(original);
    });
  }

  test("nested multi-type schemas grow linearly", () => {
    let nested: unknown = { type: "string" };
    for (let depth = 0; depth < 24; depth += 1) {
      nested = { type: ["object", "array"], properties: { child: nested } };
    }
    const encoded = JSON.stringify(normalizeDevinToolParameters("gemini-x", nested));
    expect(encoded.length).toBeLessThan(5_000);
    expect(encoded.match(/"child"/g)).toHaveLength(24);
  });

  test("draft-7 dependencies: schema values are rewritten, name lists are left alone", () => {
    const out = normalizeDevinToolParameters("gemini-x", {
      type: "object",
      dependencies: { a: ["b", "c"], enum: { properties: { x: { type: ["string", "null"] } } } },
    }) as any;
    expect(out.dependencies.a).toEqual(["b", "c"]);
    expect(out.dependencies.enum.properties.x).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
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
  // One word piece per "word ", so `words` is the estimate.
  const history = (words: number): ChatHistoryItem[] => [{ role: "user", content: "word ".repeat(words) }];
  const base = { code: "invalid_argument", producedOutput: false, tools: undefined };

  test("at the catalog window is an overflow; 60% of it is not", () => {
    expect(isDevinHistoryOverflow({ ...base, contextWindow: 200_000, messages: history(200_000) })).toBe(true);
    expect(isDevinHistoryOverflow({ ...base, contextWindow: 200_000, messages: history(120_000) })).toBe(false);
  });

  test("a malformed large schema near the window is classified as overflow", () => {
    const tools = [{ name: "bad", description: "d", parameters: { unsupported: "x ".repeat(190_000) } }];
    expect(isDevinHistoryOverflow({ ...base, contextWindow: 200_000, messages: history(1), tools })).toBe(true);
    expect(isDevinHistoryOverflow({ ...base, contextWindow: 200_000, messages: history(1),
      tools: [{ ...tools[0], parameters: { unsupported: "x ".repeat(20_000) } }],
    })).toBe(false);
  });

  test("a huge tool description truncated on the wire stays a plain 400", () => {
    const tools = [{ name: "long", description: "word ".repeat(200_000), parameters: {} }];
    expect(build(history(1), { tools }).includes(Buffer.from("…(truncated for cloud)"))).toBe(true);
    expect(isDevinHistoryOverflow({ ...base, contextWindow: 200_000, messages: history(1), tools })).toBe(false);
    expect(isDevinHistoryOverflow({ ...base, contextWindow: undefined, messages: history(1), tools })).toBe(false);
  });

  test("dense JSON at the window is caught even though its characters per token are low", () => {
    // Measured live: 443k chars of this shape was 200,345 real tokens on swe-1-6.
    let json = "";
    for (let i = 0; json.length < 443_000; i++) json += JSON.stringify({ id: i, vals: [i % 97, -i], ok: i % 3 === 0 }) + ",\n";
    expect(isDevinHistoryOverflow({ ...base, contextWindow: 200_000, messages: [{ role: "user", content: json }] })).toBe(true);
  });

  test("the same code on a small request stays a plain refusal", () => {
    expect(isDevinHistoryOverflow({ ...base, contextWindow: 200_000, messages: history(20_000) })).toBe(false);
  });

  test("other codes, or a turn that already produced output, are never reclassified", () => {
    expect(isDevinHistoryOverflow({ ...base, code: "permission_denied", contextWindow: 200_000, messages: history(240_000) })).toBe(false);
    expect(isDevinHistoryOverflow({ ...base, producedOutput: true, contextWindow: 200_000, messages: history(240_000) })).toBe(false);
  });

  test("with no known window the byte threshold decides, and image bytes do not count", () => {
    expect(isDevinHistoryOverflow({ ...base, contextWindow: undefined, messages: history(120 * 1024) })).toBe(true);
    expect(isDevinHistoryOverflow({ ...base, contextWindow: undefined, messages: history(20 * 1024) })).toBe(false);
    const image: ChatHistoryItem[] = [{ role: "user", content: [{ type: "text", text: "see" }, { type: "image", mimeType: "image/png", base64Data: "A".repeat(2_000_000) }] }];
    expect(isDevinHistoryOverflow({ ...base, contextWindow: undefined, messages: image })).toBe(false);
  });
});

describe("selected Devin context window", () => {
  test("the selected row supplies the window, with configured context and input caps", () => {
    const row = { contextWindow: 200_000, familyUid: "swe-1-6" };
    expect(resolveDevinContextWindowForTests({ adapter: "devin", baseUrl: "" }, "swe-1-6", row)).toBe(200_000);
    expect(resolveDevinContextWindowForTests({ adapter: "devin", baseUrl: "", contextWindow: 180_000,
      modelContextWindows: { "swe-1-6": 170_000 }, modelMaxInputTokens: { "swe-1-6": 160_000 },
    }, "swe-1-6", row)).toBe(160_000);
    expect(resolveDevinContextWindowForTests({ adapter: "devin", baseUrl: "" }, "swe-1-6")).toBeUndefined();
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

  async function turn(content: string, tools?: OcxParsedRequest["context"]["tools"]): Promise<AdapterEvent[]> {
    const events: AdapterEvent[] = [];
    await createDevinAdapter({ adapter: "devin", apiKey, baseUrl: host }).runTurn!({
      modelId: "swe-1-6", stream: true, context: { messages: [{ role: "user", content, timestamp: 1 }], tools }, options: {},
    }, { headers: new Headers(), translatorBudget: createTranslatorBudget(), abortSignal: AbortSignal.timeout(5_000) }, (e) => { events.push(e); });
    return events;
  }

  test("1.2 MB of history against a 200k window", async () => {
    const events = await turn("word ".repeat(240_000));
    expect(events.at(-1)).toMatchObject({ type: "error", status: 400, code: "context_length_exceeded", errorType: "invalid_request_error", retryable: false });
  });

  test("selected catalog window classifies at 95% and leaves a smaller refusal as 400", async () => {
    const atThreshold = await turn("word ".repeat(190_000));
    expect(atThreshold.at(-1)).toMatchObject({ type: "error", status: 400, code: "context_length_exceeded" });
    const belowThreshold = await turn("word ".repeat(189_999));
    expect(belowThreshold.at(-1)).toMatchObject({ type: "error", status: 400, code: "invalid_argument" });
  });

  test("a short turn with the same refusal stays invalid_argument", async () => {
    const events = await turn("hi");
    expect(events.at(-1)).toMatchObject({ type: "error", status: 400, code: "invalid_argument" });
  });

  test("a truncated huge tool description leaves invalid_argument as a plain 400", async () => {
    const events = await turn("hi", [{ name: "long", description: "word ".repeat(200_000), parameters: {} }]);
    expect(events.at(-1)).toMatchObject({ type: "error", status: 400, code: "invalid_argument" });
  });
});
