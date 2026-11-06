import { describe, expect, test } from "bun:test";
import { mapOcxMessagesToDevin } from "../../src/adapters/devin";
import { buildGetChatMessageRequestForTests, decodeChatFrame } from "../../src/adapters/devin/cloud-direct/chat";
import { encodeString, iterFields } from "../../src/adapters/devin/cloud-direct/wire";
import { decodeDevinSignature, encodeDevinSignature, hasAnthropicSignature } from "../../src/adapters/devin/reasoning-signature";
import { encodeReasoningEnvelope } from "../../src/responses/reasoning-envelope";
import { parseRequest } from "../../src/responses/parser";
import { bridgeToResponsesSSE, buildResponseJSON } from "../../src/bridge";
import type { AdapterEvent } from "../../src/types";

// Shapes measured live on GetChatMessage: swe-2-high streams reasoning, then the
// visible answer, then one frame carrying #10 delta_signature and #21
// delta_signature_type ("sealed"); gpt-6-sol streams no thinking text and a
// signature of type "openai".
const SEALED = "sealed.v1.opaque-attestation";

function assistantPrompt(history: ReturnType<typeof mapOcxMessagesToDevin>): Map<number, string> {
  const request = buildGetChatMessageRequestForTests({
    apiKey: "devin-session-token$x", modelUid: "swe-2-high", messages: history, cascadeId: "c",
  } as never);
  const prompts = [...iterFields(request)].filter(f => f.num === 3).map(f => f.value as Buffer);
  const assistant = prompts.find(p => [...iterFields(p)].some(f => f.num === 2 && f.value === 2n))!;
  return new Map([...iterFields(assistant)].filter(f => f.wire === 2).map(f => [f.num, (f.value as Buffer).toString("utf8")]));
}

describe("Devin reasoning continuation across turns", () => {
  test("the signature frame yields its type", () => {
    const frame = Buffer.concat([encodeString(10, SEALED), encodeString(21, "sealed")]);
    expect([...decodeChatFrame(frame)]).toContainEqual({ kind: "reasoning_signature", signature: SEALED, signatureType: "sealed" });
    expect([...decodeChatFrame(encodeString(10, SEALED))]).toContainEqual({ kind: "reasoning_signature", signature: SEALED });
    expect([...decodeChatFrame(Buffer.concat([encodeString(10, SEALED), encodeString(21, "x".repeat(4_097))]))])
      .toContainEqual({ kind: "reasoning_signature", signature: SEALED });
  });

  test.each(["x".repeat(4_096), "é".repeat(2_048)])("signature types at the byte cap remain available", signatureType => {
    expect([...decodeChatFrame(Buffer.concat([encodeString(10, SEALED), encodeString(21, signatureType)]))])
      .toContainEqual({ kind: "reasoning_signature", signature: SEALED, signatureType });
  });

  test("the signature type cap counts UTF-8 bytes", () => {
    expect([...decodeChatFrame(Buffer.concat([encodeString(10, SEALED), encodeString(21, "é".repeat(2_049))]))])
      .toContainEqual({ kind: "reasoning_signature", signature: SEALED });
  });

  test("an oversized wire type retains the signature through stored-envelope replay", () => {
    const event = [...decodeChatFrame(Buffer.concat([
      encodeString(10, SEALED), encodeString(21, "x".repeat(4_097)),
    ]))].find(event => event.kind === "reasoning_signature");
    if (!event || event.kind !== "reasoning_signature") throw new Error("Missing signature event");
    expect(event.signatureType).toBeUndefined();
    const stored = encodeDevinSignature(event.signature, event.signatureType);
    expect(stored).toBe(SEALED);
    const history = mapOcxMessagesToDevin(parseRequest({
      model: "devin/swe-2",
      input: [
        { role: "user", content: [{ type: "input_text", text: "go" }] },
        { type: "reasoning", id: "rs_sig", summary: [], encrypted_content: encodeReasoningEnvelope({ sig: stored }) },
        { role: "user", content: [{ type: "input_text", text: "continue" }] },
      ],
    }));
    const assistant = history.find(message => message.role === "assistant");
    expect(assistant?.signature).toBe(SEALED);
    expect(assistant?.signature_type).toBeUndefined();
    const wire = assistantPrompt(history);
    expect(wire.get(12)).toBe(SEALED);
    expect(wire.has(18)).toBe(false);
  });

  test("the stored signature carries its type and an older stored signature still replays", () => {
    const stored = encodeDevinSignature(SEALED, "sealed");
    expect(decodeDevinSignature(stored)).toEqual({ signature: SEALED, signatureType: "sealed" });
    expect(decodeDevinSignature(SEALED)).toEqual({ signature: SEALED });
    expect(encodeDevinSignature(SEALED, undefined)).toBe(SEALED);
  });

  test("a SWE-2 turn split into a thinking item and a late signature item replays as one signed prompt", () => {
    // What the client sends back: the thinking summary item (no envelope) and the
    // signature-only item the late #10 frame became, then the tool loop.
    const history = mapOcxMessagesToDevin(parseRequest({
      model: "devin/swe-2",
      input: [
        { role: "user", content: [{ type: "input_text", text: "go" }] },
        { type: "reasoning", id: "rs_text", summary: [{ type: "summary_text", text: "pick 482916, then call the tool" }] },
        { type: "reasoning", id: "rs_sig", summary: [], encrypted_content: encodeReasoningEnvelope({ sig: encodeDevinSignature(SEALED, "sealed") }) },
        { type: "function_call", call_id: "call_1", name: "get_time", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "12:00" },
      ],
    }));
    const assistant = history.find(m => m.role === "assistant");
    expect(assistant?.thinking).toBe("pick 482916, then call the tool");
    expect(assistant?.signature).toBe(SEALED);
    expect(assistant?.signature_type).toBe("sealed");
    const wire = assistantPrompt(history);
    expect(wire.get(11)).toBe("pick 482916, then call the tool");
    expect(wire.get(12)).toBe(SEALED);
    expect(wire.get(18)).toBe("sealed");
  });

  for (const thinking of [false, true]) {
    for (const tool of [false, true]) {
      for (const earlyEnd of [false, true]) {
        test(`streamed late signature replays with thinking=${thinking}, tool=${tool}, earlyEnd=${earlyEnd}`, async () => {
          async function* upstream(): AsyncGenerator<AdapterEvent> {
            if (thinking) yield { type: "thinking_delta", thinking: "pick 482916" };
            if (tool) {
              yield { type: "tool_call_start", id: "call_1", name: "get_time" };
              yield { type: "tool_call_delta", arguments: "{}" };
              if (earlyEnd) yield { type: "tool_call_end" };
            } else yield { type: "text_delta", text: "The answer" };
            yield { type: "thinking_signature", signature: encodeDevinSignature(SEALED, "sealed"), afterOutput: true };
            if (tool && !earlyEnd) yield { type: "tool_call_end" };
            yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
          }
          const adapterEvents = await Array.fromAsync(upstream());
          const buffered = buildResponseJSON(adapterEvents, "swe-2");
          const bufferedOutput = buffered.output as any[];
          const outputs: any[][] = [bufferedOutput, bufferedOutput.map(({ id: _id, ...item }: any) => item)];
          for (const hidden of [false, true]) {
            const wire = await new Response(bridgeToResponsesSSE(
              upstream(), "swe-2", undefined, undefined, undefined, undefined, 2000,
              { hideThinkingSummary: hidden },
            )).text();
            const events = wire.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
            const terminal = events.find(event => event.type === "response.completed").response;
            const liveItems = events.filter(event => event.type === "response.output_item.done").map(event => event.item);
            for (const output of [liveItems, terminal.output]) {
              outputs.push(output, output.map(({ id: _id, ...item }: any) => item));
            }
          }
          for (const output of outputs) {
            const history = mapOcxMessagesToDevin(parseRequest({
              model: "devin/swe-2", input: [
                { role: "user", content: "go" }, ...output,
                ...(tool ? [{ type: "function_call_output", call_id: "call_1", output: "12:00" }] : []),
                { role: "user", content: "continue" },
              ],
            }));
            const assistant = history.find(message => message.role === "assistant");
            expect(assistant?.signature, JSON.stringify(output)).toBe(SEALED);
            expect(assistant?.signature_type).toBe("sealed");
            expect(assistant?.thinking).toBe(thinking ? "pick 482916" : undefined);
            const prompt = assistantPrompt(history);
            expect(prompt.get(12)).toBe(SEALED);
            expect(prompt.get(18)).toBe("sealed");
          }
        });
      }
    }
  }

  test.each(["text", "tool"])("late signature stays beside non-leading thinking after %s", async prefix => {
    for (const hidden of [false, true]) {
      for (const earlyEnd of [false, true]) {
        async function* upstream(): AsyncGenerator<AdapterEvent> {
          if (prefix === "text") yield { type: "text_delta", text: "I will inspect this." };
          else {
            yield { type: "tool_call_start", id: "call_earlier", name: "list" };
            yield { type: "tool_call_delta", arguments: "{}" };
            yield { type: "tool_call_end" };
          }
          yield { type: "thinking_delta", thinking: "non-leading thought" };
          yield { type: "tool_call_start", id: "call_owner", name: "read" };
          yield { type: "tool_call_delta", arguments: "{}" };
          if (earlyEnd) yield { type: "tool_call_end" };
          yield { type: "thinking_signature", signature: encodeDevinSignature(SEALED, "sealed"), afterOutput: true };
          if (!earlyEnd) yield { type: "tool_call_end" };
          yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
        }
        const wire = await new Response(bridgeToResponsesSSE(
          upstream(), "swe-2", undefined, undefined, undefined, undefined, 2000,
          { hideThinkingSummary: hidden },
        )).text();
        const events = wire.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
        const live = events.filter(event => event.type === "response.output_item.done").map(event => event.item);
        const snapshot = events.find(event => event.type === "response.completed").response.output;
        for (const output of [live, snapshot]) {
          for (const idless of [false, true]) {
            const parsed = parseRequest({ model: "devin/swe-2", input: [
              { role: "user", content: "go" },
              ...output.map(({ id, ...item }: any) => idless ? item : { ...item, id }),
            ] });
            const history = mapOcxMessagesToDevin(parsed);
            const assistant = history.find(message => message.role === "assistant");
            expect(assistant?.thinking).toBe("non-leading thought");
            expect(assistant?.signature).toBe(SEALED);
            expect(assistant?.signature_type).toBe("sealed");
            const prompt = assistantPrompt(history);
            expect(prompt.get(11)).toBe("non-leading thought");
            expect(prompt.get(12)).toBe(SEALED);
            expect(prompt.get(18)).toBe("sealed");
            if (!hidden) {
              const parts = parsed.context.messages.find(message => message.role === "assistant")!.content;
              expect(parts.map(part => part.type)).toEqual([prefix === "text" ? "text" : "toolCall", "thinking", "thinking", "toolCall"]);
            }
          }
        }
      }
    }
  });

  test.each([false, true])("late adjacency keeps multiple thinking blocks conservative, earlierSigned=%s", earlierSigned => {
    const signature = encodeDevinSignature(SEALED, "sealed");
    const parsed = parseRequest({ model: "devin/swe-2", input: [
      { type: "message", role: "assistant", content: "preface" },
      { type: "reasoning", summary: [{ type: "summary_text", text: "first" }],
        ...(earlierSigned ? { encrypted_content: encodeReasoningEnvelope({ sig: "earlier-signature" }) } : {}) },
      { type: "function_call", call_id: "call_earlier", name: "list", arguments: "{}" },
      { type: "reasoning", summary: [{ type: "summary_text", text: "second" }] },
      { type: "function_call", id: "fc_owner", call_id: "call_owner", name: "read", arguments: "{}" },
      { type: "reasoning", summary: [], encrypted_content: encodeReasoningEnvelope({ sig: signature, aft: "fc_owner", red: ["opaque"] }) },
    ] });
    const parts = parsed.context.messages[0]!.content;
    expect(parts.map(part => part.type)).toEqual(["text", "thinking", "toolCall", "thinking", "thinking", "toolCall"]);
    expect(parts[4]).toMatchObject({ type: "thinking", thinking: "", signature, redacted: ["opaque"] });
    const history = mapOcxMessagesToDevin(parsed);
    expect(history[0]?.signature).toBeUndefined();
    expect(assistantPrompt(history).has(12)).toBe(false);
  });

  test.each(["wrong", "user-boundary", "system-boundary", "typed-system-boundary"])("a trailer with a %s owner cannot sign the next turn", variant => {
    const history = mapOcxMessagesToDevin(parseRequest({
      model: "devin/swe-2", input: [
        { role: "user", content: "go" },
        { type: "reasoning", summary: [{ type: "summary_text", text: "earlier thought" }] },
        { type: "message", role: "assistant", id: "msg_owner", content: "answer" },
        ...(variant === "user-boundary" ? [{ role: "user", content: "boundary" }] : []),
        ...(variant === "system-boundary" ? [{ role: "system", content: "boundary" }] : []),
        ...(variant === "typed-system-boundary" ? [{ type: "message", role: "system", id: "msg_owner", content: "boundary" }] : []),
        { type: "reasoning", summary: [], encrypted_content: encodeReasoningEnvelope({
          sig: encodeDevinSignature(SEALED, "sealed"), aft: variant === "wrong" ? "msg_other" : "msg_owner",
        }) },
        { role: "assistant", content: "next answer" },
      ],
    }));
    expect(history.filter(message => message.role === "assistant").every(message => !message.signature)).toBe(true);
  });

  for (const earlyEnd of [false, true]) {
    test(`late signature survives client tool search, earlyEnd=${earlyEnd}`, async () => {
      async function* upstream(): AsyncGenerator<AdapterEvent> {
        yield { type: "thinking_delta", thinking: "find a tool" };
        yield { type: "tool_call_start", id: "call_search", name: "tool_search" };
        yield { type: "tool_call_delta", arguments: "{}" };
        if (earlyEnd) yield { type: "tool_call_end" };
        yield { type: "thinking_signature", signature: encodeDevinSignature(SEALED, "sealed"), afterOutput: true };
        if (!earlyEnd) yield { type: "tool_call_end" };
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
      }
      const buffered = buildResponseJSON(await Array.fromAsync(upstream()), "swe-2", { toolSearchToolNames: new Set(["tool_search"]) });
      const outputs: any[][] = [buffered.output as any[]];
      for (const hidden of [false, true]) {
        const wire = await new Response(bridgeToResponsesSSE(
          upstream(), "swe-2", undefined, undefined, new Set(["tool_search"]), undefined, 2000,
          { hideThinkingSummary: hidden },
        )).text();
        const events = wire.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
        outputs.push(events.filter(event => event.type === "response.output_item.done").map(event => event.item));
        outputs.push(events.find(event => event.type === "response.completed").response.output);
      }
      for (const output of outputs) {
        expect(output.find(item => item.type === "tool_search_call")).toMatchObject({ call_id: "call_search", execution: "client" });
        for (const idless of [false, true]) {
          const parsed = parseRequest({ model: "devin/swe-2", input: output.map(({ id, ...item }: any) => idless ? item : { ...item, id }) });
          const history = mapOcxMessagesToDevin(parsed);
          expect(history[0]?.signature).toBe(SEALED);
          expect(history[0]?.thinking).toBe("find a tool");
          expect(parsed.context.messages[0]?.content).toContainEqual({ type: "toolCall", id: "call_search", name: "tool_search", arguments: {} });
          expect(assistantPrompt(history).get(12)).toBe(SEALED);
        }
      }
    });
  }

  test.each([undefined, "server"])("tool search with execution=%s cannot own a late signature", execution => {
    const parsed = parseRequest({ model: "devin/swe-2", input: [
      { type: "message", role: "assistant", content: "earlier answer" },
      { type: "tool_search_call", id: "tsc_owner", call_id: "call_search", execution, arguments: {} },
      { type: "reasoning", summary: [], encrypted_content: encodeReasoningEnvelope({ sig: encodeDevinSignature(SEALED, "sealed"), aft: "tsc_owner" }) },
      { type: "message", role: "assistant", content: "next answer" },
    ] });
    expect(mapOcxMessagesToDevin(parsed).every(message => !message.signature)).toBe(true);
  });

  for (const custom of [false, true]) {
    test(`late signature binds parallel ${custom ? "custom" : "function"} calls and preserves redacted data`, async () => {
      async function* upstream(): AsyncGenerator<AdapterEvent> {
        yield { type: "thinking_delta", thinking: "parallel thought" };
        for (const id of ["call_a", "call_b"]) {
          yield { type: "tool_call_start", id, name: "read" };
          yield { type: "tool_call_delta", arguments: custom ? "raw input" : "{}" };
          yield { type: "tool_call_end" };
        }
        yield { type: "thinking_signature", signature: encodeDevinSignature(SEALED, "sealed"), afterOutput: true };
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
      }
      const wire = await new Response(bridgeToResponsesSSE(
        upstream(), "swe-2", undefined, custom ? new Set(["read"]) : undefined, undefined, undefined, 2000,
        { hideThinkingSummary: true },
      )).text();
      const events = wire.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
      const output = events.find(event => event.type === "response.completed").response.output;
      expect(output.slice(0, 2).map((item: any) => item.type)).toEqual(Array(2).fill(custom ? "custom_tool_call" : "function_call"));
      for (const idless of [false, true]) {
        const parsed = parseRequest({ model: "devin/swe-2", input: output.map(({ id, ...item }: any) => idless ? item : { ...item, id }) });
        const history = mapOcxMessagesToDevin(parsed);
        expect(history[0]?.signature).toBe(SEALED);
        expect(history[0]?.thinking).toBe("parallel thought");
        expect(parsed.context.messages[0]?.content.filter(part => part.type === "toolCall")).toHaveLength(2);
      }
      const redacted = parseRequest({ model: "m", input: [
        { type: "message", role: "assistant", content: "answer" },
        { type: "reasoning", summary: [], encrypted_content: encodeReasoningEnvelope({ sig: "sig", aft: "msg_owner", red: ["opaque"] }) },
      ] });
      expect(redacted.context.messages[0]?.content[0]).toMatchObject({ type: "thinking", signature: "sig", redacted: ["opaque"] });
    });
  }

  test("a signature separated from its text by a call is not paired", () => {
    const history = mapOcxMessagesToDevin(parseRequest({
      model: "devin/swe-2",
      input: [
        { role: "user", content: [{ type: "input_text", text: "go" }] },
        { type: "reasoning", id: "rs_text", summary: [{ type: "summary_text", text: "earlier thought" }] },
        { type: "function_call", call_id: "call_1", name: "get_time", arguments: "{}" },
        { type: "reasoning", id: "rs_unrelated", summary: [], encrypted_content: encodeReasoningEnvelope({ sig: encodeDevinSignature(SEALED, "sealed") }) },
        { type: "function_call_output", call_id: "call_1", output: "12:00" },
      ],
    }));
    const assistant = history.find(m => m.role === "assistant");
    expect(assistant?.thinking).toBe("earlier thought");
    expect(assistant?.signature).toBeUndefined();
  });

  test("a signature-only turn is replayed instead of dropped", () => {
    const openaiSig = '[{"id":"rs_1","encrypted_content":"opaque"}]';
    const history = mapOcxMessagesToDevin(parseRequest({
      model: "devin/gpt-6-sol",
      input: [
        { role: "user", content: [{ type: "input_text", text: "go" }] },
        { type: "reasoning", id: "rs_sig", summary: [], encrypted_content: encodeReasoningEnvelope({ sig: encodeDevinSignature(openaiSig, "openai") }) },
        { type: "function_call", call_id: "call_1", name: "get_time", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "12:00" },
      ],
    }));
    const assistant = history.find(m => m.role === "assistant");
    expect(assistant?.thinking).toBeUndefined();
    expect(assistant?.signature).toBe(openaiSig);
    expect(assistant?.signature_type).toBe("openai");
    const wire = assistantPrompt(history);
    expect(wire.has(11)).toBe(false);
    expect(wire.get(12)).toBe(openaiSig);
    expect(wire.get(18)).toBe("openai");

    // No text, no tool call: the signature alone still keeps the assistant turn.
    const bare = mapOcxMessagesToDevin(parseRequest({
      model: "devin/gemini-3-8-flash",
      input: [
        { role: "user", content: [{ type: "input_text", text: "go" }] },
        { type: "reasoning", id: "rs_sig", summary: [], encrypted_content: encodeReasoningEnvelope({ sig: encodeDevinSignature("AY89gemini", "gemini") }) },
        { role: "user", content: [{ type: "input_text", text: "and then?" }] },
      ],
    }));
    const kept = bare.find(m => m.role === "assistant");
    expect(kept?.signature).toBe("AY89gemini");
    expect(kept?.signature_type).toBe("gemini");
    expect(assistantPrompt(bare).get(12)).toBe("AY89gemini");
  });

  test("two late signatures beside one thinking block cannot be paired", () => {
    const history = mapOcxMessagesToDevin(parseRequest({
      model: "devin/swe-2",
      input: [
        { role: "user", content: [{ type: "input_text", text: "go" }] },
        { type: "reasoning", id: "rs_text", summary: [{ type: "summary_text", text: "thought" }] },
        { type: "reasoning", id: "rs_a", summary: [], encrypted_content: encodeReasoningEnvelope({ sig: "sealed.v1.a" }) },
        { type: "reasoning", id: "rs_b", summary: [], encrypted_content: encodeReasoningEnvelope({ sig: "sealed.v1.b" }) },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] },
      ],
    }));
    const assistant = history.find(m => m.role === "assistant");
    expect(assistant?.thinking).toBe("thought");
    expect(assistant?.signature).toBeUndefined();
  });

  test("an Anthropic signature is replayed by default and withheld only for the fallback", () => {
    const parsed = (sig: string, model: string) => parseRequest({
      model,
      input: [
        { role: "user", content: [{ type: "input_text", text: "go" }] },
        { type: "reasoning", id: "rs", summary: [], encrypted_content: encodeReasoningEnvelope({ txt: "summarised thought", sig }) },
        { type: "function_call", call_id: "call_1", name: "get_time", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "12:00" },
      ],
    });
    const typed = parsed(encodeDevinSignature("EpcBClaude", "anthropic"), "devin/claude-opus-5-5");
    const signed = mapOcxMessagesToDevin(typed);
    expect(signed.find(m => m.role === "assistant")?.signature).toBe("EpcBClaude");
    expect(hasAnthropicSignature(signed, typed.modelId)).toBe(true);
    const unsigned = mapOcxMessagesToDevin(typed, { withholdAnthropicSignatures: true }).find(m => m.role === "assistant");
    expect(unsigned?.thinking).toBe("summarised thought");
    expect(unsigned?.signature).toBeUndefined();
    // A signature stored before its type was recorded falls back to the model being called.
    const legacy = parsed("EpcBClaude", "devin/claude-opus-5-5");
    expect(hasAnthropicSignature(mapOcxMessagesToDevin(legacy), legacy.modelId)).toBe(true);
    const sealed = parsed(SEALED, "devin/swe-2");
    expect(hasAnthropicSignature(mapOcxMessagesToDevin(sealed), sealed.modelId)).toBe(false);
    expect(mapOcxMessagesToDevin(sealed, { withholdAnthropicSignatures: true }).find(m => m.role === "assistant")?.signature).toBe(SEALED);
  });
});
