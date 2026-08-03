import { describe, expect, test } from "bun:test";
import {
  hasResponsesItemIdRepair,
  relaySseWithResponsesItemIdRepair as relaySseWithResponsesItemIdRepairProduction,
} from "../src/server/responses-item-id-repair";
import { finalizeTranslatorBudgetResponse } from "../src/lib/translator-budget";
import { createTestTranslatorBudget } from "./helpers/translator-budget";

function relaySseWithResponsesItemIdRepair(
  body: ReadableStream<Uint8Array>,
  config: Parameters<typeof relaySseWithResponsesItemIdRepairProduction>[1],
): ReadableStream<Uint8Array> {
  const budget = createTestTranslatorBudget();
  return finalizeTranslatorBudgetResponse(
    new Response(relaySseWithResponsesItemIdRepairProduction(body, config, budget)),
    budget,
  ).body!;
}

function streamFromText(text: string): ReadableStream<Uint8Array> {
  const chunk = new TextEncoder().encode(text);
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) { controller.close(); return; }
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

async function parseSse(text: string): Promise<Record<string, unknown>[]> {
  return text
    .trim()
    .split(/\r?\n\r?\n/)
    .map(block => block.split(/\r?\n/).find(line => line.startsWith("data:"))?.slice(5).trim())
    .filter((payload): payload is string => !!payload && payload !== "[DONE]")
    .map(payload => JSON.parse(payload) as Record<string, unknown>);
}

describe("DeepSeek Responses item-id repair", () => {
  test("rewrites UUID ids and folds reasoning_text into encrypted_content", async () => {
    const upstream = [
      `event: response.created\ndata: {"type":"response.created","response":{"id":"58786d76-18be-43d9-b6f5-8922796fbe28","status":"in_progress","output":[]}}\n\n`,
      `event: response.in_progress\ndata: {"type":"response.in_progress","response":{"id":"58786d76-18be-43d9-b6f5-8922796fbe28","status":"in_progress","output":[]}}\n\n`,
      `event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"8da7b778-aff2-4d83-bfc3-8cd09ee79b34","status":"in_progress","content":[],"summary":[]}}\n\n`,
      `event: response.reasoning_text.delta\ndata: {"type":"response.reasoning_text.delta","output_index":0,"item_id":"8da7b778-aff2-4d83-bfc3-8cd09ee79b34","delta":"think"}\n\n`,
      `event: response.reasoning_text.done\ndata: {"type":"response.reasoning_text.done","output_index":0,"item_id":"8da7b778-aff2-4d83-bfc3-8cd09ee79b34","text":"think"}\n\n`,
      `event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"8da7b778-aff2-4d83-bfc3-8cd09ee79b34","status":"completed","content":[{"type":"reasoning_text","text":"think"}],"summary":[]}}\n\n`,
      `event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"type":"message","id":"1dbc05ae-0b41-40fd-961e-7a84deebe064","status":"in_progress","role":"assistant","content":[]}}\n\n`,
      `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":1,"item_id":"1dbc05ae-0b41-40fd-961e-7a84deebe064","delta":"OK","logprobs":[]}\n\n`,
      `event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":1,"item":{"type":"message","id":"1dbc05ae-0b41-40fd-961e-7a84deebe064","status":"completed","role":"assistant","content":[{"type":"output_text","text":"OK","annotations":[],"logprobs":[]}]}}\n\n`,
      `event: response.completed\ndata: {"type":"response.completed","response":{"id":"58786d76-18be-43d9-b6f5-8922796fbe28","status":"completed","output":[{"type":"reasoning","id":"8da7b778-aff2-4d83-bfc3-8cd09ee79b34","content":[{"type":"reasoning_text","text":"think"}],"summary":[]},{"type":"message","id":"1dbc05ae-0b41-40fd-961e-7a84deebe064","role":"assistant","content":[{"type":"output_text","text":"OK","annotations":[],"logprobs":[]}]}]}}\n\n`,
    ].join("");

    const repaired = await readAll(relaySseWithResponsesItemIdRepair(streamFromText(upstream), {
      rewriteNonCanonicalIds: true,
      repairMissingTerminalIds: true,
    }));
    const events = await parseSse(repaired);

    expect(repaired).toContain("data: [DONE]");
    expect(events.some(e => e.type === "response.in_progress")).toBe(false);
    expect(events.some(e => String(e.type).startsWith("response.reasoning_text"))).toBe(false);

    const reasoningAdded = events.find(e => e.type === "response.output_item.added" && (e.item as any)?.type === "reasoning")!.item as Record<string, unknown>;
    const messageAdded = events.find(e => e.type === "response.output_item.added" && (e.item as any)?.type === "message")!.item as Record<string, unknown>;
    const textDelta = events.find(e => e.type === "response.output_text.delta")!;
    const completed = events.find(e => e.type === "response.completed")!.response as { id: string; output: Record<string, unknown>[] };

    expect(reasoningAdded.id).toMatch(/^rs_ocx_[0-9a-f]+_0$/);
    expect(messageAdded.id).toMatch(/^msg_ocx_[0-9a-f]+_1$/);
    expect(textDelta.item_id).toBe(messageAdded.id);
    expect(completed.id).toMatch(/^resp_ocx_[0-9a-f]+$/);
    expect(completed.output[0].id).toBe(reasoningAdded.id);
    expect(String(completed.output[0].encrypted_content)).toMatch(/^ocxr1:/);
    expect(completed.output[1].id).toBe(messageAdded.id);
  });

  test("opt-in flag is recognized", () => {
    expect(hasResponsesItemIdRepair({ rewriteNonCanonicalIds: true })).toBe(true);
  });
});
