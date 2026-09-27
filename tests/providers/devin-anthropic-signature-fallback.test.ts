import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createDevinAdapter } from "../../src/adapters/devin";
import { setCachedCatalogForTests } from "../../src/adapters/devin/cloud-direct/catalog";
import { devinCacheIdentity, invalidateSessionIdentity } from "../../src/adapters/devin/cloud-direct/chat";
import { encodeMessage, encodeString, encodeVarintField, iterFields } from "../../src/adapters/devin/cloud-direct/wire";
import { encodeDevinSignature } from "../../src/adapters/devin/reasoning-signature";
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
  let responses: Array<"refuse" | "ok" | "text-then-refuse" | "reasoning-then-refuse" | "reasoning-then-ok" | "usage-reasoning-then-refuse" | "usage-ok"> = [];

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

  async function run(signature: string, modelId: string): Promise<AdapterEvent[]> {
    const parsed = parseRequest({
      model: `devin/${modelId}`,
      input: [
        { role: "user", content: [{ type: "input_text", text: "go" }] },
        { type: "reasoning", id: "rs", summary: [], encrypted_content: encodeReasoningEnvelope({ txt: "summarised thought", sig: signature }) },
        { type: "function_call", call_id: "call_1", name: "get_time", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "12:00" },
      ],
    });
    parsed.modelId = modelId;
    const adapter = createDevinAdapter({ adapter: "devin", apiKey, baseUrl: host });
    const events: AdapterEvent[] = [];
    await adapter.runTurn!(parsed, { headers: new Headers(), translatorBudget: createTranslatorBudget() }, event => { events.push(event); });
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
        : next === "usage-ok" ? Buffer.concat([frame(Buffer.concat([encodeMessage(7, Buffer.concat([encodeVarintField(2, 1100), encodeVarintField(3, 20)])), encodeString(3, "ok"), encodeVarintField(5, 2)])), frame(Buffer.from("{}"), 2)])
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

  test("held reasoning emits heartbeats, never the held events", async () => {
    // Each clock read advances 20s, so every held frame is past the heartbeat interval.
    let clock = Date.now();
    const now = spyOn(Date, "now").mockImplementation(() => (clock += 20_000));
    try {
      responses = ["usage-reasoning-then-refuse", "ok"];
      const events = await run(encodeDevinSignature("EpcBClaude", "anthropic"), "claude-opus-5-5-medium");
      const kinds = events.map(e => e.type);
      expect(kinds.filter(k => k === "heartbeat").length).toBeGreaterThan(0);
      expect(kinds).not.toContain("thinking_delta");
      expect(kinds.indexOf("heartbeat")).toBeLessThan(kinds.indexOf("text_delta"));
    } finally {
      now.mockRestore();
    }
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
