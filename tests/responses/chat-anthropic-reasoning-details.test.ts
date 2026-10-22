/**
 * #7429: a Chat Completions client routed to Claude kept losing its reasoning on every tool step.
 *
 * The proxy now returns provider-issued thinking state as OpenRouter-style `reasoning_details`
 * and, for a single first-party Anthropic route only, replays what the client echoes back as the
 * signed thinking block Anthropic requires before a `tool_use`. These cases drive the real Chat
 * ingress against a stubbed Messages endpoint, on the bridge converter and on the direct encoder,
 * streaming and not.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatCompletionsToResponsesBody } from "../../src/chat/inbound";
import { collectChatCompletion } from "../../src/chat/outbound";
import { resetWorkflowBudgetsForTest } from "../../src/lib/workflow-budget";
import { clearReasoningReplayCacheForTests } from "../../src/responses/reasoning-replay-cache";
import { getAccountSet, saveCredential, setActiveAccount } from "../../src/oauth/store";
import { resetThoughtSignatureReplayForTests } from "../../src/responses/thought-signature-replay";
import { handleChatCompletions } from "../../src/server/chat-completions";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

type Item = Record<string, unknown>;
const originalFetch = globalThis.fetch;
const originalHome = process.env.OPENCODEX_HOME;
const MODEL = "claude-sonnet-4-5";
/** Opus 5.5 thinks with `display: "updates"`: each signed block is shown to the client as content. */
const PROGRESS_MODEL = "claude-opus-5-5";
const FIRST_PARTY = "https://api.anthropic.com";
const COMPATIBLE = "https://anthropic.example.test";
const SIGNATURES = ["SyntheticStepOneSignature0000==", "SyntheticStepTwoSignature0000=="];
const THINKING = ["Step one reasoning.", "Step two reasoning."];
const REDACTED = "SyntheticRedactedThinkingPayload";
const FORMAT = "anthropic-claude-v1";
const TOOLS = [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }];
const USER = { role: "user", content: "Find it." };
let home = "";
let release: (() => void) | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-chat-reasoning-details-"));
  process.env.OPENCODEX_HOME = home;
  release = acquireOwnedSpendHome();
  clearReasoningReplayCacheForTests();
  resetThoughtSignatureReplayForTests();
  resetWorkflowBudgetsForTest();
});
afterEach(() => {
  try { release?.(); } finally {
    release = undefined;
    globalThis.fetch = originalFetch;
    clearReasoningReplayCacheForTests();
    resetThoughtSignatureReplayForTests();
    resetWorkflowBudgetsForTest();
    if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = originalHome;
    removeTreeWithRetry(home);
  }
});

/** The OAuth store knows Anthropic accounts by the canonical provider name. */
const OAUTH_PROVIDER = "anthropic";

function config(baseUrl: string, direct: boolean, oauth = false): OcxConfig {
  const name = oauth ? OAUTH_PROVIDER : "anth";
  return {
    defaultProvider: name, emptyCompletionRetry: false,
    providers: { [name]: { adapter: "anthropic", baseUrl, proxy: "direct", models: [MODEL, PROGRESS_MODEL],
      ...(oauth ? { authMode: "oauth" } : { authMode: "key", apiKey: "synthetic-test-key" }) } },
    ...(direct ? { protocols: { rollout: { directEncoders: true } } } : {}),
  } as OcxConfig;
}

function frame(type: string, data: Item = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

/** One assistant turn: optional redacted block, signed thinking, then a tool call (or text). */
function upstreamTurn(step: number, stream: boolean, options: { redacted?: boolean; tool?: boolean } = {}): Response {
  const tool = options.tool !== false;
  const blocks: Item[] = [
    ...(options.redacted ? [{ type: "redacted_thinking", data: REDACTED }] : []),
    { type: "thinking", thinking: THINKING[step] ?? "Final reasoning.", signature: SIGNATURES[step] ?? "SyntheticFinalSignature00000==" },
    tool ? { type: "tool_use", id: `toolu_${step + 1}`, name: "lookup", input: {} } : { type: "text", text: "Done." },
  ];
  const stopReason = tool ? "tool_use" : "end_turn";
  if (!stream) {
    return Response.json({ id: `msg_${step}`, type: "message", role: "assistant", model: MODEL, content: blocks,
      stop_reason: stopReason, usage: { input_tokens: 2, output_tokens: 3 } });
  }
  const frames = [frame("message_start", { message: { id: `msg_${step}`, role: "assistant", content: [], usage: { input_tokens: 2 } } })];
  blocks.forEach((block, index) => {
    if (block.type === "redacted_thinking") {
      frames.push(frame("content_block_start", { index, content_block: block }));
    } else if (block.type === "thinking") {
      frames.push(
        frame("content_block_start", { index, content_block: { type: "thinking", thinking: "" } }),
        frame("content_block_delta", { index, delta: { type: "thinking_delta", thinking: block.thinking } }),
        frame("content_block_delta", { index, delta: { type: "signature_delta", signature: block.signature } }),
      );
    } else if (block.type === "tool_use") {
      frames.push(
        frame("content_block_start", { index, content_block: { ...block, input: {} } }),
        frame("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: "{}" } }),
      );
    } else {
      frames.push(
        frame("content_block_start", { index, content_block: { type: "text", text: "" } }),
        frame("content_block_delta", { index, delta: { type: "text_delta", text: block.text } }),
      );
    }
    frames.push(frame("content_block_stop", { index }));
  });
  frames.push(frame("message_delta", { delta: { stop_reason: stopReason }, usage: { output_tokens: 3 } }), frame("message_stop"));
  return new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } });
}

/**
 * A Messages endpoint that, like Anthropic with thinking on, refuses a tool-use continuation whose
 * latest assistant turn does not open with a signed or redacted thinking block.
 */
function transport(baseUrl: string, enforce: boolean, answer: (step: number, stream: boolean) => Response) {
  const bodies: Item[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== `${baseUrl}/v1/messages`) throw new Error(`Unexpected network target blocked: ${url}`);
    const body = JSON.parse(String(init?.body)) as Item;
    bodies.push(body);
    const messages = body.messages as { role: string; content: Item[] | string }[];
    const lastAssistant = [...messages].reverse().find(message => message.role === "assistant");
    if (enforce && lastAssistant && Array.isArray(lastAssistant.content)) {
      const first = lastAssistant.content[0];
      const signed = first?.type === "redacted_thinking"
        || (first?.type === "thinking" && typeof first.signature === "string" && SIGNATURES.includes(first.signature));
      if (!signed) {
        return Response.json({ type: "error", error: { type: "invalid_request_error",
          message: "messages: Expected `thinking` or `redacted_thinking`, but found `tool_use`." } }, { status: 400 });
      }
    }
    return answer(bodies.length - 1, body.stream === true);
  }) as typeof fetch;
  return bodies;
}

async function chat(cfg: OcxConfig, messages: unknown[], stream: boolean, model = MODEL, provider = "anth"): Promise<Item> {
  const request = new Request("http://localhost/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: `${provider}/${model}`, messages, tools: TOOLS, reasoning_effort: "high", stream }),
  });
  const response = await handleChatCompletions(request, cfg, { model: "", provider: "" });
  expect(response.status).toBe(200);
  const completion = stream
    ? await collectChatCompletion(response.body!, MODEL, createTestTranslatorBudget())
    : await response.json() as Item;
  const message = ((completion.choices as Item[])[0]!.message) as Item;
  // What a Chat client stores and echoes back.
  return {
    role: "assistant", content: message.content ?? null,
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
    ...(message.reasoning_details ? { reasoning_details: message.reasoning_details } : {}),
  };
}

function toolResult(assistant: Item): Item {
  const call = (assistant.tool_calls as { id: string }[])[0]!;
  return { role: "tool", tool_call_id: call.id, content: "result" };
}

function assistantTurns(body: Item): Item[][] {
  return (body.messages as { role: string; content: Item[] }[])
    .filter(message => message.role === "assistant").map(message => message.content);
}

const LANES = [
  { name: "bridge", direct: false, stream: false },
  { name: "bridge stream", direct: false, stream: true },
  { name: "direct encoder", direct: true, stream: false },
  { name: "direct encoder stream", direct: true, stream: true },
];

describe("#7429 Chat reasoning_details carry Anthropic thinking across tool steps", () => {
  for (const lane of LANES) {
    for (const model of [MODEL, PROGRESS_MODEL]) {
      const progress = model === PROGRESS_MODEL;
      test(`${lane.name} ${model}: signatures survive a multi-step tool loop and Anthropic accepts them`, async () => {
        const cfg = config(FIRST_PARTY, lane.direct);
        const bodies = transport(FIRST_PARTY, true, (step, stream) => upstreamTurn(step, stream, { tool: step < 2 }));
        const first = await chat(cfg, [USER], lane.stream, model);
        if (progress) {
          // The update is shown as content; the same text is what the signature covers.
          expect(first.content).toBe(THINKING[0]);
          expect(first.reasoning_content).toBeUndefined();
        } else {
          expect(first.reasoning_content).toBe(THINKING[0]);
        }
        expect(first.reasoning_details).toEqual([
          { type: "reasoning.text", text: THINKING[0], signature: SIGNATURES[0], format: FORMAT, index: 0 },
        ]);
        const second = await chat(cfg, [USER, first, toolResult(first)], lane.stream, model);
        expect((second.reasoning_details as Item[])[0]!.signature).toBe(SIGNATURES[1]);
        const final = await chat(cfg, [USER, first, toolResult(first), second, toolResult(second)], lane.stream, model);
        expect(final.content).toBe(progress ? "Final reasoning.Done." : "Done.");

        expect(bodies).toHaveLength(3);
        if (progress) expect(bodies[2]!.thinking).toMatchObject({ display: "updates" });
        const turns = assistantTurns(bodies[2]!);
        expect(turns).toHaveLength(2);
        turns.forEach((content, step) => {
          // The signed block first. A progress update's visible copy stays in the text the
          // client sent: nothing on the wire tells it from answer text, so nothing is removed.
          expect(content).toEqual([
            { type: "thinking", thinking: THINKING[step], signature: SIGNATURES[step] },
            ...(progress ? [{ type: "text", text: THINKING[step] }] : []),
            expect.objectContaining({ type: "tool_use", id: `toolu_${step + 1}` }),
          ]);
        });
      });
    }

    test(`${lane.name}: redacted thinking round-trips through reasoning.encrypted`, async () => {
      const cfg = config(FIRST_PARTY, lane.direct);
      const bodies = transport(FIRST_PARTY, true, (step, stream) => upstreamTurn(step, stream, { redacted: step === 0, tool: step === 0 }));
      const first = await chat(cfg, [USER], lane.stream);
      expect(first.reasoning_details).toEqual([
        { type: "reasoning.encrypted", data: REDACTED, format: FORMAT, index: 0 },
        { type: "reasoning.text", text: THINKING[0], signature: SIGNATURES[0], format: FORMAT, index: 1 },
      ]);
      await chat(cfg, [USER, first, toolResult(first)], lane.stream);
      expect(assistantTurns(bodies[1]!)[0]!.slice(0, 2)).toEqual([
        { type: "redacted_thinking", data: REDACTED },
        { type: "thinking", thinking: THINKING[0], signature: SIGNATURES[0] },
      ]);
    });
  }

  // A Claude subscription reaches the same first-party host with a pooled OAuth account.
  test("pooled OAuth route: signatures survive a multi-step tool loop", async () => {
    await saveCredential(OAUTH_PROVIDER, { access: "synthetic-oauth-access", refresh: "synthetic-oauth-refresh",
      expires: Date.now() + 3_600_000, accountId: "synthetic-oauth-account", source: "oauth" });
    await setActiveAccount(OAUTH_PROVIDER, getAccountSet(OAUTH_PROVIDER)!.accounts[0]!.id);
    const cfg = config(FIRST_PARTY, false, true);
    const bodies = transport(FIRST_PARTY, true, (step, stream) => upstreamTurn(step, stream, { tool: step < 2 }));
    const first = await chat(cfg, [USER], true, MODEL, OAUTH_PROVIDER);
    expect((first.reasoning_details as Item[])[0]!.signature).toBe(SIGNATURES[0]);
    const second = await chat(cfg, [USER, first, toolResult(first)], true, MODEL, OAUTH_PROVIDER);
    const final = await chat(cfg, [USER, first, toolResult(first), second, toolResult(second)], true, MODEL, OAUTH_PROVIDER);
    expect(final.content).toBe("Done.");
    expect(bodies).toHaveLength(3);
    assistantTurns(bodies[2]!).forEach((content, step) => {
      expect(content[0]).toEqual({ type: "thinking", thinking: THINKING[step], signature: SIGNATURES[step] });
    });
  });

  test("a non-first-party Anthropic destination never receives the echoed signature", async () => {
    const cfg = config(COMPATIBLE, false);
    const bodies = transport(COMPATIBLE, false, (step, stream) => upstreamTurn(step, stream, { redacted: step === 0 }));
    const first = await chat(cfg, [USER], false);
    // The response still offers the state; the gate is on what is accepted back.
    expect(first.reasoning_details).toHaveLength(2);
    await chat(cfg, [USER, first, toolResult(first)], false);
    const { reasoning_details: _dropped, ...plain } = first;
    await chat(cfg, [USER, plain, toolResult(first)], false);
    const sent = JSON.stringify(bodies[1]);
    expect(sent).not.toContain(SIGNATURES[0]);
    expect(sent).not.toContain(REDACTED);
    // Exactly today's request: as if the client had sent reasoning_content alone.
    expect(bodies[1]!.messages).toEqual(bodies[2]!.messages);
  });

  test("a missing or invalid signature keeps today's plaintext fallback", async () => {
    const cfg = config(FIRST_PARTY, false);
    const bodies = transport(FIRST_PARTY, false, (step, stream) => upstreamTurn(step, stream));
    const first = await chat(cfg, [USER], false);
    const { reasoning_details: _dropped, ...plain } = first;
    const variants: Item[] = [
      plain,
      { ...plain, reasoning_details: [{ type: "reasoning.text", text: THINKING[0], format: FORMAT, index: 0 }] },
      { ...plain, reasoning_details: [{ type: "reasoning.text", text: THINKING[0], signature: "rs_not_a_signature", format: FORMAT }] },
      { ...plain, reasoning_details: [{ type: "reasoning.text", text: THINKING[0], signature: SIGNATURES[0], format: "openai-responses-v1" }] },
      { ...plain, reasoning_details: [...(first.reasoning_details as Item[]), { type: "reasoning.summary", summary: "x" }] },
    ];
    for (const assistant of variants) await chat(cfg, [USER, assistant, toolResult(first)], false);
    const replays = bodies.slice(1).map(body => body.messages);
    for (const messages of replays) {
      expect(messages).toEqual(replays[0]!);
      expect(JSON.stringify(messages)).not.toContain(SIGNATURES[0]);
    }
  });

  test("without reasoning_details the projection is byte for byte unchanged", () => {
    const messages = [USER, { role: "assistant", content: null, reasoning_content: "prior", tool_calls: [
      { id: "toolu_1", type: "function", function: { name: "lookup", arguments: "{}" } },
    ] }, { role: "tool", tool_call_id: "toolu_1", content: "result" }];
    const body = { model: "m", messages, tools: TOOLS };
    expect(JSON.stringify(chatCompletionsToResponsesBody(body, { acceptAnthropicReasoningSignatures: true })))
      .toBe(JSON.stringify(chatCompletionsToResponsesBody(body)));
  });

  test("answer text that begins with a signed thought is replayed intact", () => {
    const messages = [USER, { role: "assistant", content: "Same answer", reasoning_details: [
      { type: "reasoning.text", text: "Same", signature: SIGNATURES[0], format: FORMAT, index: 0 },
    ] }];
    const input = chatCompletionsToResponsesBody({ model: "m", messages }, { acceptAnthropicReasoningSignatures: true }).input as Item[];
    expect(input.at(-1)).toEqual({ type: "message", role: "assistant", content: [{ type: "output_text", text: "Same answer" }] });
  });
});


describe("Anthropic reasoning state stays off the native Chat lane to other providers", () => {
  const CHAT_BASE = "https://chat.example.test";
  const CHAT_MODEL = "target-model";

  // preserveReasoningContentModels so the plaintext thinking actually serializes to the wire;
  // without it the bridge would drop the text too and there would be nothing left to assert.
  function chatDestination(): OcxConfig {
    return {
      defaultProvider: "chatv", emptyCompletionRetry: false,
      providers: { chatv: { adapter: "openai-chat", baseUrl: CHAT_BASE, proxy: "direct",
        models: [CHAT_MODEL], preserveReasoningContentModels: [CHAT_MODEL],
        authMode: "key", apiKey: "synthetic-test-key" } },
    } as OcxConfig;
  }

  function chatTransport(): Item[] {
    const bodies: Item[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url !== `${CHAT_BASE}/chat/completions`) throw new Error(`Unexpected network target blocked: ${url}`);
      const body = JSON.parse(String(init?.body)) as Item;
      bodies.push(body);
      if (body.stream === true) {
        const chunk = { id: "chatcmpl_1", object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { role: "assistant", content: "Done." }, finish_reason: "stop" }] };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return Response.json({ id: "chatcmpl_1", object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "Done." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    }) as typeof fetch;
    return bodies;
  }

  async function sendChat(messages: unknown[]): Promise<void> {
    const request = new Request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: `chatv/${CHAT_MODEL}`, messages, stream: false }),
    });
    const response = await handleChatCompletions(request, chatDestination(), { model: "", provider: "" });
    const payload = await response.json();
    expect(response.status, JSON.stringify(payload)).toBe(200);
  }

  // The marked (OpenRouter carrier) and unmarked (format omitted) spellings of the same
  // signed Anthropic state both take the bridge, where the non-Anthropic gate keeps only
  // the plaintext projection — no signature or redacted ciphertext may cross over.
  const ANTHROPIC_HISTORY: Array<[string, Item[]]> = [
    ["marked", [
      { type: "reasoning.encrypted", data: REDACTED, format: FORMAT, index: 0 },
      { type: "reasoning.text", text: THINKING[0], signature: SIGNATURES[0], format: FORMAT, index: 1 },
    ]],
    ["unmarked", [
      { type: "reasoning.text", text: THINKING[0], signature: SIGNATURES[0], index: 0 },
    ]],
  ];
  for (const [name, details] of ANTHROPIC_HISTORY) {
    test(`${name} state reaches the openai-chat upstream as plaintext only`, async () => {
      const bodies = chatTransport();
      const assistant = { role: "assistant", content: "answer", reasoning_details: details };
      await sendChat([USER, assistant]);
      expect(bodies).toHaveLength(1);
      const wireAssistant = (bodies[0]!.messages as Item[]).find(m => m.role === "assistant")!;
      expect(wireAssistant.reasoning_content).toBe(THINKING[0]);
      expect(wireAssistant.reasoning_details).toBeUndefined();
      const serialized = JSON.stringify(bodies[0]);
      expect(serialized).not.toContain(SIGNATURES[0]);
      expect(serialized).not.toContain(REDACTED);
    });
  }

  test("another provider's reasoning details keep the native passthrough", async () => {
    const bodies = chatTransport();
    const foreign = [
      { type: "reasoning.text", text: THINKING[0], format: "minimax-response-v1", index: 0 },
    ];
    await sendChat([USER, { role: "assistant", content: "answer", reasoning_details: foreign }]);
    expect(bodies).toHaveLength(1);
    const wireAssistant = (bodies[0]!.messages as Item[]).find(m => m.role === "assistant")!;
    // Native passthrough preserves caller message objects verbatim — scope stays Anthropic-only.
    expect(wireAssistant.reasoning_details).toEqual(foreign);
  });

  test("state on non-assistant messages reaches the openai-chat upstream as plaintext only", async () => {
    // The eligibility scan is role-agnostic on purpose: the native lane forwards caller
    // message objects verbatim on any role, so Anthropic state sitting on a user, system,
    // developer or tool-result message would disclose the signature and redacted ciphertext
    // exactly as an assistant slot would. The bridge projects only plaintext whatever the slot.
    const bodies = chatTransport();
    const details = ANTHROPIC_HISTORY[0]![1];
    await sendChat([
      { role: "user", content: "hi", reasoning_details: details },
      { role: "system", content: "s", reasoning_details: details },
      { role: "developer", content: "d", reasoning_details: details },
      { role: "assistant", content: null, tool_calls: [
        { id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } },
      ] },
      { role: "tool", tool_call_id: "call_1", content: "result", reasoning_details: details },
    ]);
    expect(bodies).toHaveLength(1);
    const serialized = JSON.stringify(bodies[0]);
    expect(serialized).not.toContain(SIGNATURES[0]);
    expect(serialized).not.toContain(REDACTED);
    expect(serialized).not.toContain("reasoning_details");
    // The opaque carrier is dropped, the tool result itself is not.
    expect((bodies[0]!.messages as Item[]).find(m => m.role === "tool"))
      .toMatchObject({ tool_call_id: "call_1", content: "result" });
  });

  test("another provider's reasoning details keep the native passthrough on a non-assistant role", async () => {
    // The lane is verbatim on every role, which is why the Anthropic-state scan cannot
    // afford to look at assistant messages only.
    const bodies = chatTransport();
    const foreign = [
      { type: "reasoning.text", text: THINKING[0], format: "minimax-response-v1", index: 0 },
    ];
    await sendChat([{ role: "user", content: "hi", reasoning_details: foreign }]);
    const wireUser = (bodies[0]!.messages as Item[]).find(m => m.role === "user")!;
    expect(wireUser.reasoning_details).toEqual(foreign);
  });
});
