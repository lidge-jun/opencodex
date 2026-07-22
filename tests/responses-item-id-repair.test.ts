import { describe, expect, test } from "bun:test";
import { hasResponsesItemIdRepair, relaySseWithResponsesItemIdRepair } from "../src/server/responses-item-id-repair";

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

async function parseSse(text: string): Promise<Record<string, unknown>[]> {
  return text
    .trim()
    .split(/\r?\n\r?\n/)
    .map(block => block.split(/\r?\n/).find(line => line.startsWith("data:"))?.slice(5).trim())
    .filter((payload): payload is string => !!payload && payload !== "[DONE]")
    .map(payload => JSON.parse(payload) as Record<string, unknown>);
}

describe("Responses passthrough item-id repair", () => {
  test("repairs placeholder message/reasoning ids across added, delta, done, and completed", async () => {
    const upstream = [
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_0"}}\n\n',
      'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","output_index":0,"summary_index":0,"item_id":"rs_0","delta":"thinking"}\n\n',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"rs_0"}}\n\n',
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"type":"message","id":"msg_0","role":"assistant"}}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":1,"content_index":0,"item_id":"msg_0","delta":"hello"}\n\n',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":1,"item":{"type":"message","role":"assistant"}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_gateway","status":"completed","output":[{"type":"reasoning","id":"rs_0"},{"type":"message","role":"assistant"},{"type":"function_call","id":"call_redacted","call_id":"call_redacted","name":"shell","arguments":"{}"}]}}\n\n',
      "data: [DONE]\n\n",
    ].join("");

    const repaired = await readAll(relaySseWithResponsesItemIdRepair(streamFromText(upstream), {
      reasoning: ["rs_0"],
      message: ["msg_0"],
      repairMissingTerminalIds: true,
    }));
    const events = await parseSse(repaired);

    const reasoningAdded = events[0].item as Record<string, unknown>;
    const reasoningDelta = events[1];
    const reasoningDone = events[2].item as Record<string, unknown>;
    const messageAdded = events[3].item as Record<string, unknown>;
    const messageDelta = events[4];
    const messageDone = events[5].item as Record<string, unknown>;
    const completed = events[6].response as { output: Record<string, unknown>[] };

    expect(reasoningAdded.id).toMatch(/^rs_ocx_[0-9a-f]+_0$/);
    expect(reasoningDelta.item_id).toBe(reasoningAdded.id);
    expect(reasoningDone.id).toBe(reasoningAdded.id);

    expect(messageAdded.id).toMatch(/^msg_ocx_[0-9a-f]+_1$/);
    expect(messageDelta.item_id).toBe(messageAdded.id);
    expect(messageDone.id).toBe(messageAdded.id);

    expect(completed.output[0].id).toBe(reasoningAdded.id);
    expect(completed.output[1].id).toBe(messageAdded.id);
    expect(completed.output[2].id).toBe("call_redacted");
    expect(completed.output[2].call_id).toBe("call_redacted");
  });

  test("mints unique canonical ids across sequential passthrough streams", async () => {
    const upstream = [
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_0"}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_gateway","status":"completed","output":[{"type":"reasoning","id":"rs_0"}]}}\n\n',
      "data: [DONE]\n\n",
    ].join("");

    const firstEvents = await parseSse(await readAll(relaySseWithResponsesItemIdRepair(streamFromText(upstream), {
      reasoning: ["rs_0"],
    })));
    const secondEvents = await parseSse(await readAll(relaySseWithResponsesItemIdRepair(streamFromText(upstream), {
      reasoning: ["rs_0"],
    })));

    const firstId = (firstEvents[0].item as Record<string, unknown>).id;
    const secondId = (secondEvents[0].item as Record<string, unknown>).id;
    expect(firstId).not.toBe(secondId);
    expect((firstEvents[1].response as { output: Record<string, unknown>[] }).output[0].id).toBe(firstId);
    expect((secondEvents[1].response as { output: Record<string, unknown>[] }).output[0].id).toBe(secondId);
  });

  test("does not rewrite function_call fields when a malformed stream reuses a repaired output_index", async () => {
    const upstream = [
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_0"}}\n\n',
      'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","output_index":0,"summary_index":0,"item_id":"rs_0","delta":"thinking"}\n\n',
      'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_1","call_id":"call_1","delta":"{}"}\n\n',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"shell","arguments":"{}"}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[{"type":"function_call","id":"fc_1","call_id":"call_1","name":"shell","arguments":"{}"}]}}\n\n',
      "data: [DONE]\n\n",
    ].join("");

    const events = await parseSse(await readAll(relaySseWithResponsesItemIdRepair(streamFromText(upstream), {
      reasoning: ["rs_0"],
      repairMissingTerminalIds: true,
    })));
    const reasoning = events[0].item as Record<string, unknown>;
    const functionDelta = events[2];
    const functionDone = events[3].item as Record<string, unknown>;
    const completed = events[4].response as { output: Record<string, unknown>[] };

    expect(reasoning.id).toMatch(/^rs_ocx_[0-9a-f]+_0$/);
    expect(events[1].item_id).toBe(reasoning.id);
    expect(functionDelta.item_id).toBe("fc_1");
    expect(functionDelta.call_id).toBe("call_1");
    expect(functionDone.id).toBe("fc_1");
    expect(functionDone.call_id).toBe("call_1");
    expect(completed.output[0].id).toBe("fc_1");
    expect(completed.output[0].call_id).toBe("call_1");
  });

  test("keeps message and reasoning mappings separate when output_index is reused", async () => {
    const upstream = [
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_0"}}\n\n',
      'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_0","role":"assistant"}}\n\n',
      'data: {"type":"response.reasoning_summary_text.delta","output_index":0,"item_id":"rs_0","delta":"r"}\n\n',
      'data: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_0","delta":"m"}\n\n',
    ].join("");

    const events = await parseSse(await readAll(relaySseWithResponsesItemIdRepair(streamFromText(upstream), {
      reasoning: ["rs_0"],
      message: ["msg_0"],
    })));
    const reasoningId = (events[0].item as Record<string, unknown>).id;
    const messageId = (events[1].item as Record<string, unknown>).id;

    expect(reasoningId).toMatch(/^rs_ocx_[0-9a-f]+_0$/);
    expect(messageId).toMatch(/^msg_ocx_[0-9a-f]+_0$/);
    expect(events[2].item_id).toBe(reasoningId);
    expect(events[3].item_id).toBe(messageId);
  });

  test("preserves untouched SSE blocks byte-for-byte even when repair is enabled", async () => {
    const upstream = [
      ': gateway heartbeat\r\n',
      'event: response.function_call_arguments.delta\r\n',
      'data:{"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_1","call_id":"call_1","delta":"{}"}\r\n\r\n',
      'data: [DONE]\r\n\r\n',
    ].join("");

    const repaired = await readAll(relaySseWithResponsesItemIdRepair(streamFromText(upstream), {
      reasoning: ["rs_0"],
    }));

    expect(repaired).toBe(upstream);
  });

  test("reports whether a provider actually opted into repair", () => {
    expect(hasResponsesItemIdRepair(undefined)).toBe(false);
    expect(hasResponsesItemIdRepair({})).toBe(false);
    expect(hasResponsesItemIdRepair({ repairMissingTerminalIds: true })).toBe(true);
    expect(hasResponsesItemIdRepair({ message: ["msg_0"] })).toBe(true);
  });
});
