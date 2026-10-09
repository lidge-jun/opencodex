import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import { nativeAnthropicProjection } from "../../src/claude/inbound";
import { anthropicToResponsesTranslation } from "../../src/claude/inbound";
import { responsesSseToAnthropicSse } from "../../src/claude/outbound";
import { decodeReasoningEnvelope, encodeReasoningEnvelope, OCX_REASONING_PREFIX } from "../../src/responses/reasoning-envelope";
import { nativeReasoningTag } from "../../src/responses/reasoning-replay-cache";
import { bindRouteReasoningReplayScope, nativeReasoningOwnerForRoute } from "../../src/server/responses/core-replay";
import { parseRequest } from "../../src/responses/parser";
import { clearReasoningReplayCacheForTests } from "../../src/responses/reasoning-replay-cache";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
import { TranslatorBudgetExceededError } from "../../src/lib/translator-budget";

const BLOB = "fixture-native-ciphertext";
const MODEL = "m";
const previousFetch = globalThis.fetch;
let previousHome: string | undefined;
let home = "";
let releaseSpend: (() => void) | undefined;

function provider(baseUrl = "https://reasoning.example/v1", apiKey = "key-a", responsesPath?: string): OcxProviderConfig {
  return { adapter: "openai-responses", authMode: "key", baseUrl, apiKey, models: [MODEL], ...(responsesPath ? { responsesPath } : {}) } as OcxProviderConfig;
}

function config(selected: OcxProviderConfig = provider()): OcxConfig {
  return { defaultProvider: "a", providers: { a: selected } } as OcxConfig;
}

function turn(signature?: string, model = MODEL, stream = false) {
  return {
    model, max_tokens: 128, stream, thinking: { type: "adaptive" },
    messages: signature ? [
      { role: "user", content: "First." },
      { role: "assistant", content: [{ type: "thinking", thinking: "Visible plan.", signature }, { type: "text", text: "Done." }] },
      { role: "user", content: "Continue." },
    ] : [{ role: "user", content: "First." }],
  };
}

function upstreamResponse(blob = BLOB) {
  return Response.json({ id: "resp_fixture", object: "response", status: "completed", output: [
    { type: "reasoning", id: "rs_fixture", summary: [{ type: "summary_text", text: "Visible plan." }], encrypted_content: blob },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] },
  ], usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 } });
}

async function send(cfg: OcxConfig, payload: ReturnType<typeof turn>, observe: (wire: Record<string, unknown>, url: string) => Response = () => upstreamResponse()) {
  const wires: Record<string, unknown>[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const wire = JSON.parse(String(init?.body)) as Record<string, unknown>;
    wires.push(wire);
    return observe(wire, String(input));
  }) as typeof fetch;
  try {
    const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    }), cfg, { model: "", provider: "" });
    const body = await response.json() as { content?: Array<{ type: string; signature?: string }> };
    expect(response.status).toBe(200);
    return { body, wires };
  } finally { globalThis.fetch = previousFetch; }
}

function signature(body: { content?: Array<{ type: string; signature?: string }> }): string {
  return body.content?.find(part => part.type === "thinking")?.signature ?? "";
}

beforeAll(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-native-provenance-"));
  process.env.OPENCODEX_HOME = home;
  releaseSpend = acquireOwnedSpendHome();
});
afterAll(() => {
  releaseSpend?.();
  globalThis.fetch = previousFetch;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

describe("Claude native reasoning provenance", () => {
  test("same route replays across a simulated restart; destination, credential and responsesPath switches strip before send", async () => {
    const first = await send(config(), turn());
    const signed = signature(first.body);
    expect(decodeReasoningEnvelope(signed)?.nat?.enc).toBe(BLOB);
    clearReasoningReplayCacheForTests();
    const same = await send(config(), turn(signed));
    expect(JSON.stringify(same.wires[0])).toContain(BLOB);
    for (const other of [provider("https://other.example/v1"), provider(undefined, "key-b"), provider(undefined, "key-a", "/custom/responses")]) {
      const switched = await send(config(other), turn(signed));
      expect(JSON.stringify(switched.wires[0])).not.toContain(BLOB);
      expect(JSON.stringify(switched.wires[0])).not.toContain("rs_fixture");
    }
  });

  test("model switch and transplanted, altered or conflicting tags never replay ciphertext", async () => {
    const signed = signature((await send(config(), turn())).body);
    const nat = decodeReasoningEnvelope(signed)!.nat!;
    const switched = await send(config(), turn(signed, "other"));
    expect(JSON.stringify(switched.wires[0])).not.toContain(BLOB);
    expect(JSON.stringify(switched.wires[0])).toContain("Visible plan.");
    for (const value of [
      { ...nat, enc: "other-ciphertext" },
      { ...nat, enc: BLOB + "altered" },
      { ...nat, tag: "0".repeat(64) },
    ]) {
      const forged = encodeReasoningEnvelope({ txt: "Visible plan.", nat: value });
      const replay = await send(config(), turn(forged));
      expect(JSON.stringify(replay.wires[0])).not.toContain(value.enc);
    }
    const duplicate = turn(signed);
    duplicate.messages.splice(2, 0, { role: "assistant", content: [{ type: "thinking", thinking: "Visible plan.", signature: encodeReasoningEnvelope({ nat: { ...nat, tag: "0".repeat(64) } }) }, { type: "text", text: "Done." }] } as typeof duplicate.messages[number]);
    const conflict = await send(config(), duplicate);
    expect(JSON.stringify(conflict.wires[0])).not.toContain(BLOB);
  });

  test("owner requires durable credential and generation and distinguishes route generations", () => {
    const key = provider();
    const owner = nativeReasoningOwnerForRoute({ provider: key });
    expect(owner).toBeDefined();
    expect(nativeReasoningTag(owner, BLOB)).toMatch(/^[a-f0-9]{64}$/);
    expect(nativeReasoningOwnerForRoute({ provider: { ...key, authMode: "forward" } })).toBeUndefined();
    expect(nativeReasoningOwnerForRoute({ provider: { ...key, apiKey: undefined } })).toBeUndefined();
    const oauth = { ...key, authMode: "oauth" } as OcxProviderConfig;
    const one = nativeReasoningOwnerForRoute({ provider: oauth, oauthCredentialSnapshot: { accountId: "slot", generation: 1 } });
    const same = nativeReasoningOwnerForRoute({ provider: oauth, oauthCredentialSnapshot: { accountId: "slot", generation: 1 } });
    const refreshed = nativeReasoningOwnerForRoute({ provider: oauth, oauthCredentialSnapshot: { accountId: "slot", generation: 2 } });
    expect(one).toEqual(same);
    expect(one).not.toEqual(refreshed);
    expect(nativeReasoningOwnerForRoute({ provider: oauth, oauthCredentialSnapshot: { accountId: "slot" } })).toBeUndefined();
  });

  test("OAuth generation changes strip both replay carriers while the same generation keeps them", () => {
    const oauth = { ...provider(), authMode: "oauth" } as OcxProviderConfig;
    const minted = nativeReasoningOwnerForRoute({ provider: oauth, oauthCredentialSnapshot: { accountId: "slot", generation: 1 } })!;
    const signed = encodeReasoningEnvelope({ txt: "Visible plan.", nat: { enc: BLOB, model: MODEL, id: "rs_fixture", tag: nativeReasoningTag(minted, BLOB)! } });
    const bind = (generation: number) => {
      const translated = anthropicToResponsesTranslation(turn(signed));
      const parsed = parseRequest(translated.body);
      parsed._nativeReasoningReplay = translated.nativeReasoningReplay;
      bindRouteReasoningReplayScope({ parsed, providerName: "a", provider: oauth, adapterName: "openai-responses",
        oauthCredentialSnapshot: { accountId: "slot", generation } });
      return parsed;
    };
    const same = bind(1);
    expect(JSON.stringify(same._rawBody)).toContain(BLOB);
    const refreshed = bind(2);
    expect(JSON.stringify(refreshed._rawBody)).not.toContain(BLOB);
    expect(JSON.stringify(refreshed.context)).not.toContain(BLOB);
  });

  test("a thinking block closing before commit has no nat; one closing after commit is tagged", async () => {
    const owner = nativeReasoningOwnerForRoute({ provider: provider() });
    const frames = `event: response.output_item.done\ndata: ${JSON.stringify({ output_index: 0, item: { type: "reasoning", id: "rs_fixture", summary: [], encrypted_content: BLOB } })}\n\n`
      + `event: response.completed\ndata: ${JSON.stringify({ response: { status: "completed", usage: {} } })}\n\n`;
    const translate = async (committed: boolean) => {
      const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(frames)); controller.close(); } });
      const text = await new Response(responsesSseToAnthropicSse(stream, MODEL, {
        translatorBudget: createTestTranslatorBudget(), nativeReasoningTagFor: blob => committed ? nativeReasoningTag(owner, blob) : undefined,
      })).text();
      const delta = text.split("\n\n").filter(frame => frame.includes('"type":"signature_delta"')).at(0);
      const data = delta?.split("data: ")[1];
      return data ? decodeReasoningEnvelope((JSON.parse(data) as { delta: { signature: string } }).delta.signature)?.nat : undefined;
    };
    expect(await translate(false)).toBeUndefined();
    expect((await translate(true))?.tag).toBe(nativeReasoningTag(owner, BLOB));
  });

  test("native Anthropic projection drops blob-only and undecodable blocks, preserves visible fields and input", () => {
    const nat = { enc: BLOB, model: MODEL, tag: "a".repeat(64) };
    const visible = encodeReasoningEnvelope({ txt: "Visible plan.", nat });
    const blobOnly = encodeReasoningEnvelope({ nat });
    const escaped = OCX_REASONING_PREFIX + Buffer.from('{"\\u006e\\u0061\\u0074":{"enc":"' + BLOB + '"}}').toString("base64");
    const raw = { messages: [{ role: "assistant", content: [
      { type: "thinking", thinking: "", signature: blobOnly },
      { type: "thinking", thinking: "Visible plan.", signature: visible },
      { type: "thinking", thinking: "", signature: escaped },
      { type: "thinking", thinking: "", signature: OCX_REASONING_PREFIX + "garbage" },
    ] }] };
    const projected = nativeAnthropicProjection(raw, createTestTranslatorBudget());
    expect(JSON.stringify(projected)).not.toContain(BLOB);
    expect((projected.messages as typeof raw.messages).at(0)?.content).toHaveLength(1);
    expect((projected.messages as typeof raw.messages)[0]!.content[0]!.signature).toBe(encodeReasoningEnvelope({ txt: "Visible plan." }));
    expect(raw.messages[0]!.content[0]!.signature).toBe(blobOnly);
  });

  test("native projection reserves decode and re-encode copies against the translator budget", () => {
    const nat = { enc: BLOB, model: MODEL, tag: "a".repeat(64) };
    const big = encodeReasoningEnvelope({ txt: "x".repeat(200_000), nat });
    const raw = { messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "x", signature: big }] }] };
    // Eight bytes per code unit of a ~270 KB signature cannot fit a 1 MiB turn budget.
    expect(() => nativeAnthropicProjection(raw, createTestTranslatorBudget({ maxTurnBytes: 1024 * 1024 }))).toThrow(TranslatorBudgetExceededError);
    const roomy = createTestTranslatorBudget({ maxTurnBytes: 32 * 1024 * 1024 });
    expect(JSON.stringify(nativeAnthropicProjection(raw, roomy))).not.toContain(BLOB);
    expect(roomy.snapshot().currentBytes).toBeGreaterThan(0);
    // Room for the decode copies but not for decode, the retained signature and the encode copies:
    // the encode reservation must reject before stringify/base64 run.
    const sigBytes = 8 * big.length;
    expect(() => nativeAnthropicProjection(raw, createTestTranslatorBudget({ maxTurnBytes: sigBytes + 1024 }))).toThrow(TranslatorBudgetExceededError);
  });

  test("a direct-forward route cannot mint a native reasoning tag", async () => {
    const forward = { ...provider(), authMode: "forward" } as OcxProviderConfig;
    const result = await send(config(forward), turn(), () => upstreamResponse());
    expect(decodeReasoningEnvelope(signature(result.body))?.nat).toBeUndefined();
  });

  test("a request without reasoning does not ask upstream for encrypted content", async () => {
    const payload = { model: MODEL, max_tokens: 64, stream: false, messages: [{ role: "user", content: "Hello." }] };
    const sent = await send(config(), payload as ReturnType<typeof turn>);
    expect(sent.wires[0]).not.toHaveProperty("include");
  });

  test("a switched openai-chat destination receives no blob through its context signature carrier", async () => {
    const signed = signature((await send(config(), turn())).body);
    const chat = { ...provider("https://chat.example/v1"), adapter: "openai-chat" } as OcxProviderConfig;
    const sent = await send(config(chat), turn(signed), () => new Response(
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"OK"}}]}\n\n'
      + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
      + 'data: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } },
    ));
    expect(JSON.stringify(sent.wires)).not.toContain(BLOB);
  });

  test("streamed passthrough failover strips the failed route's blob and tags the serving route", async () => {
    const a = provider("https://route-a.example/v1", "key-a");
    const b = provider("https://route-b.example/v1", "key-b");
    const cfg = { defaultProvider: "a", providers: { a, b }, combos: { pair: {
      strategy: "failover", targets: [{ provider: "a", model: MODEL }, { provider: "b", model: MODEL }],
    } } } as OcxConfig;
    const first = await send(cfg, turn(undefined, "combo/pair"));
    const signed = signature(first.body);
    expect(decodeReasoningEnvelope(signed)?.nat).toBeDefined();
    const servedBlob = "fixture-serving-route-ciphertext";
    const second = await send(cfg, turn(signed, "combo/pair"), (_wire, url) => {
      if (url.includes("route-a.example")) return Response.json({ error: { message: "busy" } }, { status: 429 });
      return new Response(
        `event: response.output_item.done\ndata: ${JSON.stringify({ output_index: 0, item: { type: "reasoning", id: "rs_second", summary: [], encrypted_content: servedBlob } })}\n\n`
        + `event: response.completed\ndata: ${JSON.stringify({ response: { status: "completed", usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    expect(second.wires).toHaveLength(2);
    expect(JSON.stringify(second.wires[0])).toContain(BLOB);
    expect(JSON.stringify(second.wires[1])).not.toContain(BLOB);
    const tag = decodeReasoningEnvelope(signature(second.body))?.nat?.tag;
    expect(tag).toBe(nativeReasoningTag(nativeReasoningOwnerForRoute({ provider: b }), servedBlob));
    expect(tag).not.toBe(nativeReasoningTag(nativeReasoningOwnerForRoute({ provider: a }), servedBlob));
  });

  test("both native Anthropic sends strip translated blobs, including escaped and undecodable envelopes", async () => {
    const signed = signature((await send(config(), turn())).body);
    const nat = decodeReasoningEnvelope(signed)!.nat!;
    const blobOnly = encodeReasoningEnvelope({ nat });
    const escaped = OCX_REASONING_PREFIX + Buffer.from('{"\\u006e\\u0061\\u0074":{"enc":"' + BLOB + '"}}').toString("base64");
    const malformed = OCX_REASONING_PREFIX + Buffer.from(JSON.stringify({ nat: { enc: BLOB, model: MODEL } })).toString("base64");
    for (const branch of ["caller", "managed"] as const) {
      const seen: Record<string, unknown>[] = [];
      const transport = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Response.json({ id: "msg_fixture", type: "message", role: "assistant", model: "claude-x",
          content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 2, output_tokens: 1 } });
      }) as typeof fetch;
      const nativeProvider = { adapter: "anthropic", authMode: "key", baseUrl: "https://api.anthropic.com", apiKey: "fixture-key",
        models: ["claude-x"], fetch: transport } as OcxProviderConfig & { fetch: typeof fetch };
      const cfg = branch === "managed"
        ? { defaultProvider: "native", providers: { native: nativeProvider }, protocols: { rollout: { managedMessagesNative: true } } } as OcxConfig
        : { defaultProvider: "native", providers: { native: nativeProvider }, claudeCode: { anthropicBaseUrl: "https://api.anthropic.com" } } as OcxConfig;
      const raw = {
        model: branch === "managed" ? "native/claude-x" : "claude-x", max_tokens: 128,
        messages: [
          { role: "user", content: "First." },
          { role: "assistant", content: [
            { type: "thinking", thinking: "", signature: blobOnly },
            { type: "thinking", thinking: "Visible plan.", signature: signed },
            { type: "thinking", thinking: "", signature: escaped },
            { type: "thinking", thinking: "", signature: malformed },
            { type: "thinking", thinking: "", signature: OCX_REASONING_PREFIX + "garbage" },
          ] },
          { role: "user", content: "Continue." },
        ],
      };
      globalThis.fetch = transport;
      try {
        const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
          method: "POST", headers: { "content-type": "application/json", "x-api-key": "sk-ant-fixture" }, body: JSON.stringify(raw),
        }), cfg, { model: "", provider: "" });
        await response.text();
        expect(response.status).toBe(200);
        expect(seen).toHaveLength(1);
        const wire = seen[0]!;
        const assistant = (wire.messages as Array<{ role: string; content: Array<{ signature?: string }> }>).find(message => message.role === "assistant");
        expect(assistant?.content).toHaveLength(1);
        expect(assistant?.content[0]?.signature).toBe(encodeReasoningEnvelope({ txt: "Visible plan." }));
        expect(JSON.stringify(wire)).not.toContain(blobOnly);
      } finally { globalThis.fetch = previousFetch; }
    }
  });
});
