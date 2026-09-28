import { describe, expect, test } from "bun:test";
import { mapOcxMessagesToDevin } from "../../src/adapters/devin";
import { buildGetChatMessageRequestForTests, decodeChatFrame } from "../../src/adapters/devin/cloud-direct/chat";
import { encodeString, iterFields } from "../../src/adapters/devin/cloud-direct/wire";
import { decodeDevinSignature, encodeDevinSignature, hasAnthropicSignature } from "../../src/adapters/devin/reasoning-signature";
import { encodeReasoningEnvelope } from "../../src/responses/reasoning-envelope";
import { parseRequest } from "../../src/responses/parser";

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
