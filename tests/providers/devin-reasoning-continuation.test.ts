import { describe, expect, test } from "bun:test";
import { mapOcxMessagesToDevin } from "../../src/adapters/devin";
import { buildGetChatMessageRequestForTests, decodeChatFrame } from "../../src/adapters/devin/cloud-direct/chat";
import { encodeString, iterFields } from "../../src/adapters/devin/cloud-direct/wire";
import { decodeDevinSignature, encodeDevinSignature } from "../../src/adapters/devin/reasoning-signature";
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
});
