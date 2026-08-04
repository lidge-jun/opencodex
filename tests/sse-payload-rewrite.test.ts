/**
 * Single-pass composition of client-facing SSE payload rewrites (#588 follow-up).
 */
import { describe, expect, test } from "bun:test";
import { createImageGenCallRestoreRewrite } from "../src/server/responses-image-gen-repair";
import { createResponsesItemIdPayloadRewrite } from "../src/server/responses-item-id-repair";
import {
  composeSsePayloadRewrites,
  createGithubCopilotObfuscationRewrite,
  relaySseWithPayloadRewrite,
} from "../src/server/sse-payload-rewrite";
import { createTestTranslatorBudget } from "./helpers/translator-budget";
import { relaySseWithFailedTail } from "../src/server/relay";

function streamFromText(text: string): ReadableStream<Uint8Array> {
  const chunk = new TextEncoder().encode(text);
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) {
        controller.close();
        return;
      }
      sent = true;
      controller.enqueue(chunk);
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

describe("SSE payload rewrite composition", () => {
  test("GitHub Copilot obfuscation rewrite turns ciphertext deltas into plaintext", async () => {
    const rewrite = createGithubCopilotObfuscationRewrite();
    const itemId = "cipher-item-id";
    const upstream = [
      'data: {"type":"response.function_call_arguments.delta","item_id":"' + itemId + '","output_index":0,"sequence_number":3,"delta":"ciphertext-chunk-1","obfuscation":"abc123"}\n\n',
      'data: {"type":"response.function_call_arguments.delta","item_id":"' + itemId + '","output_index":0,"sequence_number":4,"delta":"ciphertext-chunk-2","obfuscation":"abc123"}\n\n',
      'data: {"type":"response.function_call_arguments.done","item_id":"' + itemId + '","output_index":0,"sequence_number":5,"arguments":"{\\"a\\":2,\\"b\\":2}"}\n\n',
    ].join("");

    const rewritten = await readAll(
      relaySseWithPayloadRewrite(
        streamFromText(upstream),
        rewrite,
        createTestTranslatorBudget(),
      ),
    );

    const events = rewritten
      .split("\n\n")
      .map((block) => block.replace(/^data: /, ""))
      .filter((block) => block.length > 0)
      .map((block) => JSON.parse(block));

    expect(events.map((event) => event.type)).toEqual([
      "response.function_call_arguments.delta",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
    ]);
    expect(events[0].delta).toBe("");
    expect(events[1].delta).toBe("");
    expect(events[2].delta).toBe('{"a":2,"b":2}');
    expect(events[3].arguments).toBe('{"a":2,"b":2}');
    expect(JSON.stringify(rewritten)).not.toContain("obfuscation");
    expect(JSON.stringify(rewritten)).not.toContain("ciphertext-chunk");
  });

  test("GitHub Copilot obfuscation rewrite strips obfuscation from text deltas", async () => {
    const rewrite = createGithubCopilotObfuscationRewrite();
    const upstream =
      'data: {"type":"response.output_text.delta","item_id":"msg_0","output_index":0,"sequence_number":1,"delta":"bonjour","obfuscation":"abc123"}\n\n';

    const rewritten = await readAll(
      relaySseWithPayloadRewrite(
        streamFromText(upstream),
        rewrite,
        createTestTranslatorBudget(),
      ),
    );

    expect(rewritten).toContain('"delta":"bonjour"');
    expect(rewritten).not.toContain("obfuscation");
  });

  test("GitHub Copilot obfuscation rewrite passes clean events through unchanged", () => {
    const rewrite = createGithubCopilotObfuscationRewrite();
    const payload = '{"type":"response.output_text.delta","delta":"hello"}';
    expect(rewrite(payload)).toBe(payload);
  });

  test("applies image-gen restore and item-id repair in one relay pass", async () => {
    const upstream = [
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_0","role":"assistant"}}\n\n',
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"image_gen__imagegen","arguments":"{}"}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[{"type":"message","id":"msg_0","role":"assistant"},{"type":"function_call","id":"fc_1","call_id":"call_1","name":"image_gen__imagegen","arguments":"{}"}]}}\n\n',
    ].join("");

    let imageGenCalls = 0;
    let itemIdCalls = 0;
    const imageGen = createImageGenCallRestoreRewrite(
      new Map([["image_gen__imagegen", { namespace: "image_gen", name: "imagegen" }]]),
    )!;
    const itemId = createResponsesItemIdPayloadRewrite({
      message: ["msg_0"],
      repairMissingTerminalIds: true,
    });

    const composed = composeSsePayloadRewrites(
      (payload) => {
        imageGenCalls += 1;
        return imageGen(payload);
      },
      (payload) => {
        itemIdCalls += 1;
        return itemId(payload);
      },
    );

    const budget = createTestTranslatorBudget();
    const out = await readAll(relaySseWithPayloadRewrite(streamFromText(upstream), composed, budget));
    budget.dispose();
    expect(imageGenCalls).toBe(3);
    expect(itemIdCalls).toBe(3);
    expect(imageGenCalls).toBe(itemIdCalls);

    const events = out
      .trim()
      .split(/\r?\n\r?\n/)
      .map(block => block.split(/\r?\n/).find(line => line.startsWith("data:"))?.slice(5).trim())
      .filter((payload): payload is string => !!payload)
      .map(payload => JSON.parse(payload) as Record<string, unknown>);

    const messageAdded = events[0].item as Record<string, unknown>;
    expect(messageAdded.id).toMatch(/^msg_ocx_[0-9a-f]+_0$/);

    const functionAdded = events[1].item as Record<string, unknown>;
    expect(functionAdded).toMatchObject({
      name: "imagegen",
      namespace: "image_gen",
      call_id: "call_1",
    });

    const completed = events[2].response as { output: Record<string, unknown>[] };
    expect(completed.output[0].id).toBe(messageAdded.id);
    expect(completed.output[1]).toMatchObject({
      name: "imagegen",
      namespace: "image_gen",
    });
  });

  test("compose with no rewrites is identity", () => {
    expect(composeSsePayloadRewrites()('{"a":1}')).toBe('{"a":1}');
  });

  test("unterminated rewrite accumulation closes through a typed failed tail", async () => {
    const budget = createTestTranslatorBudget({ maxTurnBytes: 64 });
    const upstream = new AbortController();
    const rewritten = relaySseWithPayloadRewrite(
      streamFromText(`data: ${"x".repeat(80)}`),
      payload => payload,
      budget,
    );

    const out = await readAll(relaySseWithFailedTail(rewritten, upstream));
    expect(out).toContain('"code":"translation_buffer_limit"');
    expect(out).toEndWith("data: [DONE]\n\n");
    expect(upstream.signal.aborted).toBe(true);
    expect(budget.snapshot().currentBytes).toBe(0);
    budget.dispose();
  });
});
