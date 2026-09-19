import { describe, expect, test } from "bun:test";
import {
  createGrokUpstreamEnvelopeEchoBlockRewrite,
  stripGrokUpstreamEnvelopeEchoFromResponsesJson,
} from "../../src/server/grok-upstream-envelope-echo";
import { relaySseWithBlockRewrite } from "../../src/server/sse-payload-rewrite";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

function streamFromChunks(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunk));
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    text += decoder.decode(value, { stream: true });
  }
}

function frame(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

describe("xAI upstream grok-4.6 envelope-echo rewrite", () => {
  test("keeps the leading sentence and drops a mid-turn [Tool Result] paste", async () => {
    const rewrite = createGrokUpstreamEnvelopeEchoBlockRewrite();
    const upstream = [
      frame("response.output_text.delta", {
        type: "response.output_text.delta",
        delta: "I'll inspect the repositories next.\n",
      }),
      frame("response.output_text.delta", {
        type: "response.output_text.delta",
        delta: "[Tool Result]\n[tool_result]\ncall_id: 3\noutput: dumped\n",
      }),
      frame("response.output_text.delta", {
        type: "response.output_text.delta",
        delta: "this tail must not leak\n",
      }),
      frame("response.completed", {
        type: "response.completed",
        response: {
          output: [{
            type: "message",
            role: "assistant",
            content: [{
              type: "output_text",
              text: "I'll inspect the repositories next.\n[Tool Result]\n[tool_result]\ncall_id: 3\noutput: dumped\n",
            }],
          }],
        },
      }),
    ];
    const out = await readAll(relaySseWithBlockRewrite(
      streamFromChunks(...upstream),
      rewrite,
      createTestTranslatorBudget(),
    ));
    expect(out).toContain("I'll inspect the repositories next.");
    expect(out).not.toContain("[Tool Result]");
    expect(out).not.toContain("[tool_result]");
    expect(out).not.toContain("this tail must not leak");
  });

  test("strips the same envelope from a completed JSON body", () => {
    const json = JSON.stringify({
      output: [{
        type: "message",
        content: [{ type: "output_text", text: "Done.\n[Tool Result]\nsecret\n" }],
      }],
    });
    const stripped = stripGrokUpstreamEnvelopeEchoFromResponsesJson(json);
    expect(stripped).toContain("Done.");
    expect(stripped).not.toContain("[Tool Result]");
  });
});
