/**
 * The Claude Messages request-token estimate, projected onto the route that will carry it.
 *
 * A Claude Code turn replays its own thinking blocks, and on a long session those blocks dominate
 * the body: on a captured 260-message turn they were 78.8% of the messages JSON, 56.7% of that
 * being base64 signatures. A routed OpenAI Chat wire serializes almost none of it — the signature
 * never, the text only for preserve-listed models — so counting the caller's own blocks published
 * a `message_start.usage.input_tokens` 3.28x the prompt the upstream actually received. Paseo's
 * context meter reads that frame, so it showed 221% of a 180k window while compaction was healthy.
 *
 * These cases pin the measure itself and the wiring that feeds it. The estimator's
 * attachment-pricing behavior lives with the endpoint suite.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { estimateClaudeRequestTokens, handleClaudeCountTokens, handleClaudeMessages } from "../../src/server/claude-messages";
import { estimateTokens } from "../../src/lib/token-estimate";
import { CLAUDE_NATIVE_THINKING, projectClaudeRequest } from "../../src/lib/claude-request-projection";
import { openAIChatSerializesThinking } from "../../src/adapters/openai-chat/messages";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { SERVER_BUDGET_MS } from "../helpers/test-budget";

let testDir = "";
let previousHome: string | undefined;
let releaseSpendHome: (() => void) | undefined;
let isolatedHomeActive = false;

/** Only the end-to-end case needs a home; the estimator cases below are pure. */
function setUpIsolatedHome(): void {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-claude-estimate-"));
  process.env.OPENCODEX_HOME = testDir;
  releaseSpendHome = acquireOwnedSpendHome();
  isolatedHomeActive = true;
}

function restoreIsolatedHome(): void {
  // The preload arms OPENCODEX_HOME for the whole process, so an unpaired restore must not
  // touch it: deleting it here left sibling files running in the same process to write the
  // real home, which the preload guard then refused.
  if (!isolatedHomeActive) return;
  isolatedHomeActive = false;
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) removeTreeWithRetry(testDir);
  testDir = "";
}

afterEach(restoreIsolatedHome);

/** A Chat-completions upstream that records what the proxy actually sent it. */
function mockChatUpstreamCapturing(): { server: ReturnType<typeof Bun.serve>; captured: Array<Record<string, unknown>> } {
  const captured: Array<Record<string, unknown>> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      try { captured.push(await req.json() as Record<string, unknown>); } catch { /* keep streaming */ }
      const frames = [
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3 } })}\n\n`,
        "data: [DONE]\n\n",
      ];
      return new Response(frames.join(""), { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  return { server, captured };
}

function mockConfig(baseUrl: string): OcxConfig {
  return {
    port: 0,
    defaultProvider: "mock",
    providers: {
      mock: { adapter: "openai-chat", baseUrl, apiKey: "k", allowPrivateNetwork: true },
    },
  } as OcxConfig;
}

test("estimateClaudeRequestTokens drops replayed thinking the settled Chat wire does not send", () => {
  // The defect this pins (#4857 family): a routed openai-chat turn serializes replayed
  // thinking only as `reasoning_content`, and only for preserve-listed models — the
  // signature is never sent at all. Counting the caller's own blocks made the published
  // message_start floor 3.28x the upstream's reported prompt on a live 260-message turn.
  const thinking = {
    type: "thinking",
    thinking: "T".repeat(60_000),
    signature: "S".repeat(90_000),
  };
  const raw = {
    messages: [
      { role: "assistant", content: [thinking, { type: "text", text: "answer" }] },
      { role: "user", content: "next" },
    ],
  };
  const partsWithoutThinking = [
    JSON.stringify([{ role: "assistant", content: [{ type: "text", text: "answer" }] }, { role: "user", content: "next" }]),
  ];

  // A route whose wire serializes no replayed thinking counts only what it would send.
  const dropped = estimateClaudeRequestTokens(raw, "m", { text: false, signature: false });
  expect(dropped).toBe(Math.max(1, estimateTokens(partsWithoutThinking.join("\n"), "m")));
  // Signature-only projection still prices the model's own replayed text.
  const textOnly = estimateClaudeRequestTokens(raw, "m", { text: true, signature: false });
  expect(textOnly).toBeGreaterThan(dropped);
  // The native wire forwards the block verbatim, which is the default for an unknown route.
  const native = estimateClaudeRequestTokens(raw, "m", { text: true, signature: true });
  expect(native).toBe(Math.max(1, estimateTokens(JSON.stringify(raw.messages), "m")));
  expect(native).toBe(estimateClaudeRequestTokens(raw, "m"));
  // The dropped measure must not still be carrying the signature's bytes.
  expect(dropped).toBeLessThan(native / 3);
});

test("a redacted_thinking blob is priced where the wire carries it and dropped where it cannot", () => {
  // `redacted_thinking` rides in the same content array as `thinking` but is its own axis: the
  // Anthropic-native lane replays the opaque blob verbatim, and the Chat wire has no
  // representation for it at all. Folding it into the text/signature axes would either lose the
  // blob's real bytes on the native lane or keep pricing it on a wire that never sends it, which
  // is the same 40x over-count this file exists to prevent.
  const data = "R".repeat(90_000);
  const redactedOnly = { messages: [{ role: "assistant", content: [{ type: "redacted_thinking", data }] }] };
  const kept = estimateClaudeRequestTokens(redactedOnly, "m", { text: true, signature: true, redacted: true });
  const dropped = estimateClaudeRequestTokens(redactedOnly, "m", { text: true, signature: true, redacted: false });
  // The all-true projection is the identity fast path, so the native default must agree exactly.
  expect(kept).toBe(estimateClaudeRequestTokens(redactedOnly, "m"));
  expect(kept).toBeGreaterThan(10_000);
  // What is left is the JSON envelope around an emptied block, not 90k characters of blob.
  expect(dropped).toBeLessThan(kept / 20);
  // A signature-less thinking block beside it still answers to the axes that own it.
  const both = {
    messages: [{
      role: "assistant",
      content: [{ type: "thinking", thinking: "T".repeat(4_000), signature: "S".repeat(4_000) }, { type: "redacted_thinking", data }],
    }],
  };
  expect(estimateClaudeRequestTokens(both, "m", { text: true, signature: true, redacted: true }))
    .toBe(estimateClaudeRequestTokens(both, "m"));
  expect(estimateClaudeRequestTokens(both, "m", { text: false, signature: false, redacted: true }))
    .toBeGreaterThan(estimateClaudeRequestTokens(both, "m", { text: false, signature: false, redacted: false }) * 20);
});

test("a preserve-listed Chat model still serializes no redacted_thinking", () => {
  // The preserve list buys `reasoning_content`, nothing more: the assistant branch builds that
  // string from `type: "thinking"` parts alone. The shared helper therefore reports the blob's
  // axis false for every Chat provider, listed or not, and the estimate follows it.
  const listed: OcxProviderConfig = {
    adapter: "openai-chat",
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "k",
    preserveReasoningContentModels: ["m"],
    allowPrivateNetwork: true,
  };
  expect(openAIChatSerializesThinking(listed, "m")).toEqual({ text: true, signature: false, redacted: false });
  const raw = { messages: [{ role: "assistant", content: [{ type: "redacted_thinking", data: "R".repeat(90_000) }] }] };
  const onChat = estimateClaudeRequestTokens(raw, "m", openAIChatSerializesThinking(listed, "m"));
  expect(onChat).toBeLessThan(estimateClaudeRequestTokens(raw, "m") / 20);
});

test("projectClaudeRequest is pure, idempotent, and keeps emptied messages", () => {
  const thinking = { type: "thinking", thinking: "replayed", signature: "sig" };
  const raw = { messages: [{ role: "assistant", content: [thinking] }] };

  const projected = projectClaudeRequest(raw, { text: false, signature: false });
  expect(projected).not.toBe(raw);
  expect(projected.messages).toEqual([{ role: "assistant", content: [] }]);
  // The caller's body is shared with the outbound request builder, so it must be untouched.
  expect(raw.messages).toEqual([{ role: "assistant", content: [thinking] }]);
  // Re-running changes nothing: an emptied content array has no thinking left to drop.
  expect(projectClaudeRequest(projected, { text: false, signature: false })).toEqual(projected);
});

test("estimateClaudeRequestTokens counts a body with no thinking identically under every projection", () => {
  // Guards the default path the pre-existing estimator tests rely on: with nothing to
  // project away, the projection cannot change the answer.
  const raw = {
    system: "be brief",
    messages: [{ role: "user", content: [{ type: "text", text: "no thinking here" }] }],
    tools: [{ name: "Read", input_schema: { type: "object" } }],
  };
  const native = estimateClaudeRequestTokens(raw, "m");
  expect(estimateClaudeRequestTokens(raw, "m", { text: false, signature: false })).toBe(native);
  expect(estimateClaudeRequestTokens(raw, "m", { text: true, signature: false })).toBe(native);
});

test("count_tokens prices the wire the modelAdapters override selects, in both directions", async () => {
  // A count is a promise about the prompt a real turn would forward, so it has to settle the
  // wire the same way that turn does. Routing fills in the provider's registry adapter, and a
  // per-model override lands afterwards — pricing the provider-wide adapter instead gets the
  // answer backwards whenever the two disagree, which is precisely the case overrides exist for.
  const body = {
    model: "mock/test-model",
    messages: [
      { role: "user", content: "u" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "T".repeat(4_000), signature: "S".repeat(4_000) },
          { type: "text", text: "a" },
        ],
      },
    ],
  };
  const chatWire = estimateClaudeRequestTokens(body, "mock/test-model", { text: false, signature: false, redacted: false });
  const nativeWire = estimateClaudeRequestTokens(body, "mock/test-model", CLAUDE_NATIVE_THINKING);
  const countFor = async (providerAdapter: string, override: string): Promise<number> => {
    const config = {
      port: 0,
      defaultProvider: "mock",
      providers: {
        mock: {
          adapter: providerAdapter,
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "k",
          allowPrivateNetwork: true,
          modelAdapters: { "test-model": override },
        },
      },
    } as unknown as OcxConfig;
    const response = await handleClaudeCountTokens(new Request("http://localhost/v1/messages/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }), config);
    expect(response.status).toBe(200);
    return ((await response.json()) as { input_tokens: number }).input_tokens;
  };
  // Provider says Responses, the model says Chat: the Chat body is the one that gets sent.
  expect(await countFor("openai-responses", "openai-chat")).toBe(chatWire);
  // And the reverse: a Chat provider whose model speaks Responses forwards the thinking verbatim.
  expect(await countFor("openai-chat", "openai-responses")).toBe(nativeWire);
  // The two directions must stay distinguishable, or the assertions above are vacuous.
  expect(chatWire).toBeLessThan(nativeWire / 20);
});

test("message_start floor describes the prompt the Chat wire actually sent, not the replayed thinking", async () => {
  // End-to-end pin for the route-aware projection: the estimator must read the SETTLED route,
  // not just accept a projection when handed one. A routed openai-chat turn with no
  // preserveReasoningContentModels entry serializes no replayed thinking, so a floor that
  // still counts it overstates the prompt — the live defect that published 3.28x.
  setUpIsolatedHome();
    const upstream = mockChatUpstreamCapturing();
    saveConfig(mockConfig(`${upstream.server.url.toString().replace(/\/$/, "")}/v1`));
  const server = startServer(0);
  try {
    const thinking = {
      type: "thinking",
      thinking: "replayed reasoning ".repeat(400),
      signature: "S".repeat(20_000),
    };
    const response = await fetch(new URL("/v1/messages", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock/test-model",
        max_tokens: 128,
        stream: true,
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: [thinking, { type: "text", text: "answer" }] },
          { role: "user", content: "second" },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    const startFrame = text.slice(text.indexOf("event: message_start"));
    const published = (JSON.parse(startFrame.slice(startFrame.indexOf("data: ") + 6, startFrame.indexOf("\n\n")))
      .message.usage.input_tokens) as number;

    expect(upstream.captured).toHaveLength(1);
    const sent = upstream.captured[0]!;
    // What the wire actually carried: no signature field, and no reasoning_content because
    // this model is not on a preserve list.
    const serialized = JSON.stringify(sent.messages);
    expect(serialized).not.toContain("S".repeat(64));
    expect(serialized).not.toContain("reasoning_content");

    // The floor must therefore land near the serialized prompt, not near the caller's body.
    const sentEstimate = estimateTokens(JSON.stringify(sent.messages), "mock/test-model");
    expect(published).toBeLessThan(sentEstimate * 1.5);
    expect(published).toBeGreaterThan(sentEstimate * 0.5);
    // And it must be far below what counting the caller's own thinking would produce.
    expect(published).toBeLessThan(estimateClaudeRequestTokens({ messages: JSON.parse(JSON.stringify([thinking])) }, "mock/test-model") / 2);
  } finally {
    await server.stop(true);
    upstream.server.stop(true);
    restoreIsolatedHome();
  }
}, { timeout: SERVER_BUDGET_MS });

/** Frames an Anthropic-wire upstream answers with, including the usage frame a client reads. */
const ANTHROPIC_SSE_FRAMES = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_b","type":"message","role":"assistant","model":"m2","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":7,"output_tokens":0}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"sunny"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join("");

/** Chat-wire frames for the upstream that answers the combo's second target in the Chat case. */
const CHAT_SSE_FRAMES = [
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "sunny" } }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 3 } })}\n\n`,
  "data: [DONE]\n\n",
].join("");

const COMBO_THINKING = {
  type: "thinking",
  thinking: "replayed reasoning ".repeat(400),
  signature: "S".repeat(20_000),
};
const COMBO_MESSAGES = [
  { role: "user", content: "first" },
  { role: "assistant", content: [COMBO_THINKING, { type: "text", text: "answer" }] },
  { role: "user", content: "second" },
];

/**
 * One `combo/pair` turn whose first target refuses so the combo hops to `second`.
 *
 * The floor is read from the translated stream's own `message_start` frame, which is where a
 * Claude client — and Paseo's context meter — reads it.
 */
async function comboFailoverFloor(second: {
  provider: string;
  model: string;
  adapter: string;
  frames: string;
  /** Native ids the destination advertises, for a target the caller names by alias. */
  models?: string[];
  modelAliases?: Record<string, string>;
  preserveReasoningContentModels?: string[];
}): Promise<{ published: number; secondBodies: Array<Record<string, unknown>> }> {
  setUpIsolatedHome();
  clearComboSelectionState();
  clearComboTargetCooldowns();
  const firstBodies: Array<Record<string, unknown>> = [];
  const first = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      firstBodies.push(await req.json() as Record<string, unknown>);
      return Response.json({ error: { message: "fixture outage" } }, { status: 503 });
    },
  });
  const secondBodies: Array<Record<string, unknown>> = [];
  const secondServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      secondBodies.push(await req.json() as Record<string, unknown>);
      return new Response(second.frames, { headers: { "content-type": "text/event-stream" } });
    },
  });
  const loopback = (url: URL): string => url.toString().replace(/\/$/, "");
  const config = {
    port: 0,
    defaultProvider: "first",
    providers: {
      first: { adapter: "openai-chat", baseUrl: `${loopback(first.url)}/v1`, apiKey: "k", allowPrivateNetwork: true },
      [second.provider]: {
        adapter: second.adapter,
        baseUrl: second.adapter === "anthropic" ? loopback(secondServer.url) : `${loopback(secondServer.url)}/v1`,
        apiKey: "k",
        allowPrivateNetwork: true,
        ...(second.models ? { models: second.models } : {}),
        ...(second.modelAliases ? { modelAliases: second.modelAliases } : {}),
        ...(second.preserveReasoningContentModels
          ? { preserveReasoningContentModels: second.preserveReasoningContentModels }
          : {}),
      },
    },
    combos: {
      pair: {
        strategy: "failover",
        targets: [{ provider: "first", model: "m1" }, { provider: second.provider, model: second.model }],
      },
    },
  } as unknown as OcxConfig;
  try {
    const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "combo/pair", max_tokens: 128, stream: true, messages: COMBO_MESSAGES }),
    }), config, { model: "", provider: "" }, { requestId: `combo-floor-${crypto.randomUUID()}`, start: Date.now() });
    expect(response.status).toBe(200);
    const text = await response.text();
    const startFrame = text.slice(text.indexOf("event: message_start"));
    const published = (JSON.parse(startFrame.slice(startFrame.indexOf("data: ") + 6, startFrame.indexOf("\n\n")))
      .message.usage.input_tokens) as number;
    // The hop really happened: the first target refused once, the second served once.
    expect(firstBodies).toHaveLength(1);
    expect(secondBodies).toHaveLength(1);
    return { published, secondBodies };
  } finally {
    first.stop(true);
    secondServer.stop(true);
    clearComboSelectionState();
    clearComboTargetCooldowns();
    restoreIsolatedHome();
  }
}

test("a combo failover publishes the floor of the target that answered, not the ingress pick", async () => {
  // The ingress route names the combo's first target; the physical send names whichever target
  // answered. Those are different bodies when the targets sit on different wires, and a memo read
  // from the ingress pick prices the wrong one: here target A is a Chat wire that would drop the
  // replayed thinking entirely, while target B is an Anthropic wire that forwards it verbatim.
  // A floor left at the ingress pick therefore understates a prompt B really received — the
  // mirror image of the over-count this file pins, and just as wrong for a context meter.
  const { published, secondBodies } = await comboFailoverFloor({
    provider: "b", model: "m2", adapter: "anthropic", frames: ANTHROPIC_SSE_FRAMES,
  });
  // B's body is the caller's, replayed thinking and signature included.
  const forwarded = JSON.stringify(secondBodies[0]!.messages);
  expect(forwarded).toContain("replayed reasoning");
  expect(forwarded).toContain("S".repeat(64));

  const nativeWire = estimateClaudeRequestTokens({ messages: COMBO_MESSAGES }, "combo/pair", CLAUDE_NATIVE_THINKING);
  const chatWire = estimateClaudeRequestTokens({ messages: COMBO_MESSAGES }, "combo/pair", { text: false, signature: false, redacted: false });
  // The ablation: the ingress pick is the Chat target, whose projection prices this body at a
  // rounding error next to what B received. Holding the floor above it is what a memo keyed on
  // the settled wire buys.
  expect(chatWire).toBeLessThan(nativeWire / 100);
  expect(published).toBeGreaterThan(chatWire * 20);
  expect(published).toBeLessThan(nativeWire * 1.5);
  expect(published).toBeGreaterThan(nativeWire * 0.5);
}, { timeout: SERVER_BUDGET_MS });

test("a combo failover to a registry provider prices its merged preserve list", async () => {
  // `preserveReasoningContentModels` is not a config-row field on most providers: it is merged
  // in from the registry by `routedProviderConfig`. A dispatch that reads the raw row therefore
  // prices a preserve-listed model as if its reasoning were dropped, which is the under-count
  // this pair of cases exists to prevent. `moonshot` is a real registry entry whose endpoint a
  // user may override, so a loopback row reaches the same merge path production does.
  const { published, secondBodies } = await comboFailoverFloor({
    provider: "moonshot", model: "kimi-k3", adapter: "openai-chat", frames: CHAT_SSE_FRAMES,
  });
  // The merged list is what made the adapter serialize the replayed text at all.
  const forwarded = JSON.stringify(secondBodies[0]!.messages);
  expect(forwarded).toContain("reasoning_content");
  expect(forwarded).toContain("replayed reasoning");
  // The signature has no Chat representation, so it is the one field the list does not buy.
  expect(forwarded).not.toContain("S".repeat(64));

  const textKept = estimateClaudeRequestTokens({ messages: COMBO_MESSAGES }, "combo/pair", { text: true, signature: false, redacted: false });
  const textDropped = estimateClaudeRequestTokens({ messages: COMBO_MESSAGES }, "combo/pair", { text: false, signature: false, redacted: false });
  expect(textKept).toBeGreaterThan(textDropped * 20);
  expect(published).toBeGreaterThan(textDropped * 20);
  expect(published).toBeLessThan(textKept * 1.5);
  expect(published).toBeGreaterThan(textKept * 0.5);
}, { timeout: SERVER_BUDGET_MS });

test("a combo target named by alias prices the preserve list under its resolved id", async () => {
  // A combo target may name a model by alias (`am`), and the Chat adapter resolves that to the
  // provider's native id before it decides whether the wire serializes replayed thinking — its
  // preserve list holds native ids, and matching is exact. An attempt that records the alias
  // therefore reads the preserve list under a name that is not in it, prices the replayed text as
  // dropped, and understates a prompt the upstream really received. The attempt row has to carry
  // the id the adapter will actually send, which is what the routing result already holds.
  const { published, secondBodies } = await comboFailoverFloor({
    provider: "aliased",
    model: "am",
    adapter: "openai-chat",
    frames: CHAT_SSE_FRAMES,
    models: ["aliased-model"],
    modelAliases: { "aliased-model": "am" },
    preserveReasoningContentModels: ["aliased-model"],
  });
  // The wire received the resolved id, and with it the replayed text the preserve list buys.
  expect(secondBodies[0]!.model).toBe("aliased-model");
  const forwarded = JSON.stringify(secondBodies[0]!.messages);
  expect(forwarded).toContain("reasoning_content");
  expect(forwarded).toContain("replayed reasoning");

  const textKept = estimateClaudeRequestTokens({ messages: COMBO_MESSAGES }, "combo/pair", { text: true, signature: false, redacted: false });
  const textDropped = estimateClaudeRequestTokens({ messages: COMBO_MESSAGES }, "combo/pair", { text: false, signature: false, redacted: false });
  expect(textKept).toBeGreaterThan(textDropped * 20);
  // The alias must not cost the projection the preserve list's verdict.
  expect(published).toBeGreaterThan(textDropped * 20);
  expect(published).toBeLessThan(textKept * 1.5);
  expect(published).toBeGreaterThan(textKept * 0.5);
}, { timeout: SERVER_BUDGET_MS });
