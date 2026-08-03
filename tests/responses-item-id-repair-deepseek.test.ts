import { describe, expect, test } from "bun:test";
import {
  createResponsesItemIdRepairHandlers,
  hasResponsesItemIdRepair,
  relaySseWithResponsesItemIdRepair as relaySseWithResponsesItemIdRepairProduction,
} from "../src/server/responses-item-id-repair";
import { finalizeTranslatorBudgetResponse, isTranslatorBudgetExceededError } from "../src/lib/translator-budget";
import { createTestTranslatorBudget } from "./helpers/translator-budget";
import { relaySseEagerBounded } from "../src/server/relay-eager";

function relaySseWithResponsesItemIdRepair(
  body: ReadableStream<Uint8Array>,
  config: Parameters<typeof relaySseWithResponsesItemIdRepairProduction>[1],
  budget = createTestTranslatorBudget(),
): ReadableStream<Uint8Array> {
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
    expect(completed.id).toMatch(/^resp_ocx_[0-9a-f]+_\d+$/);
    expect(completed.output[0].id).toBe(reasoningAdded.id);
    expect(String(completed.output[0].encrypted_content)).toMatch(/^ocxr1:/);
    expect((completed.output[0].content as Array<{ type: string; text: string }>)[0]).toEqual({
      type: "reasoning_text",
      text: "think",
    });
    expect(completed.output[1].id).toBe(messageAdded.id);
  });

  test("clientResponseId dual-maps raw and rewritten response ids", () => {
    const handlers = createResponsesItemIdRepairHandlers({ rewriteNonCanonicalIds: true });
    const raw = "58786d76-18be-43d9-b6f5-8922796fbe28";
    // Simulate rewrite seeing the completed response first.
    handlers.rewrite(JSON.stringify({
      type: "response.completed",
      response: { id: raw, status: "completed", output: [] },
    }));
    const clientId = handlers.clientResponseId(raw);
    expect(clientId).toMatch(/^resp_ocx_[0-9a-f]+_\d+$/);
    expect(clientId).not.toBe(raw);
    // Stable across repeated lookups so continuation aliasing can dual-write safely.
    expect(handlers.clientResponseId(raw)).toBe(clientId);
  });

  test("mints unique response ids for distinct upstream response ids", async () => {
    const upstream = [
      `event: response.completed\ndata: {"type":"response.completed","response":{"id":"11111111-1111-1111-1111-111111111111","status":"completed","output":[]}}\n\n`,
      `event: response.completed\ndata: {"type":"response.completed","response":{"id":"22222222-2222-2222-2222-222222222222","status":"completed","output":[]}}\n\n`,
    ].join("");
    const events = await parseSse(await readAll(relaySseWithResponsesItemIdRepair(streamFromText(upstream), {
      rewriteNonCanonicalIds: true,
    })));
    const first = (events[0].response as { id: string }).id;
    const second = (events[1].response as { id: string }).id;
    expect(first).toMatch(/^resp_ocx_[0-9a-f]+_0$/);
    expect(second).toMatch(/^resp_ocx_[0-9a-f]+_1$/);
    expect(first).not.toBe(second);
  });

  test("mints reasoning ids when rewriteNonCanonicalIds is enabled without repairMissingTerminalIds", async () => {
    const upstream = [
      `event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","summary":[]}}\n\n`,
      `event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","summary":[]}}\n\n`,
    ].join("");
    const events = await parseSse(await readAll(relaySseWithResponsesItemIdRepair(streamFromText(upstream), {
      rewriteNonCanonicalIds: true,
    })));
    const added = events[0].item as Record<string, unknown>;
    const done = events[1].item as Record<string, unknown>;
    expect(added.id).toMatch(/^rs_ocx_[0-9a-f]+_0$/);
    expect(done.id).toBe(added.id);
  });

  test("does not duplicate an upstream [DONE] trailer", async () => {
    const upstream = [
      `event: response.completed\ndata: {"type":"response.completed","response":{"id":"58786d76-18be-43d9-b6f5-8922796fbe28","status":"completed","output":[]}}\n\n`,
      `data: [DONE]\n\n`,
    ].join("");
    const repaired = await readAll(relaySseWithResponsesItemIdRepair(streamFromText(upstream), {
      rewriteNonCanonicalIds: true,
    }));
    expect(repaired.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  test("emits [DONE] for response.failed and response.incomplete", async () => {
    for (const type of ["response.failed", "response.incomplete"] as const) {
      const upstream = `event: ${type}\ndata: {"type":"${type}","response":{"id":"58786d76-18be-43d9-b6f5-8922796fbe28","status":"${type === "response.failed" ? "failed" : "incomplete"}","output":[]}}\n\n`;
      const repaired = await readAll(relaySseWithResponsesItemIdRepair(streamFromText(upstream), {
        rewriteNonCanonicalIds: true,
      }));
      expect(repaired.match(/data: \[DONE\]/g)).toHaveLength(1);
    }
  });

  test("charges responseIdMap through TranslatorBudget", () => {
    const budget = createTestTranslatorBudget({ maxTurnBytes: 256 });
    const handlers = createResponsesItemIdRepairHandlers({ rewriteNonCanonicalIds: true }, budget);
    let overflowed = false;
    try {
      for (let i = 0; i < 200; i++) {
        const raw = `${i.toString(16).padStart(8, "0")}-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
        handlers.rewrite(JSON.stringify({
          type: "response.completed",
          response: { id: raw, status: "completed", output: [] },
        }));
      }
    } catch (error) {
      overflowed = isTranslatorBudgetExceededError(error);
    }
    expect(overflowed).toBe(true);
  });

  test("eager relay emits exactly one [DONE] trailer without upstream DONE", async () => {
    const budget = createTestTranslatorBudget();
    const handlers = createResponsesItemIdRepairHandlers({ rewriteNonCanonicalIds: true }, budget);
    const upstream = [
      `event: response.completed\ndata: {"type":"response.completed","response":{"id":"58786d76-18be-43d9-b6f5-8922796fbe28","status":"completed","output":[]}}\n\n`,
    ].join("");
    const body = streamFromText(upstream);
    const ac = new AbortController();
    const relayed = relaySseEagerBounded(body, ac, {
      inspectChunk: () => {},
      finishInspection: () => {},
      sawTerminal: () => true,
      onSynthetic: () => {},
      onClientCancel: () => {},
      onDone: () => {},
      rewritePayload: handlers.rewrite,
    }, {
      rewriteBudget: budget,
      trailer: handlers.trailer,
    });
    const repaired = await readAll(relayed);
    expect(repaired.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  test("preserves reasoning status metadata", async () => {
    const upstream = [
      `event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"8da7b778-aff2-4d83-bfc3-8cd09ee79b34","status":"in_progress","summary":[]}}\n\n`,
      `event: response.reasoning_text.delta\ndata: {"type":"response.reasoning_text.delta","output_index":0,"item_id":"8da7b778-aff2-4d83-bfc3-8cd09ee79b34","delta":"think"}\n\n`,
      `event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"8da7b778-aff2-4d83-bfc3-8cd09ee79b34","status":"completed","summary":[]}}\n\n`,
      `event: response.completed\ndata: {"type":"response.completed","response":{"id":"58786d76-18be-43d9-b6f5-8922796fbe28","status":"completed","output":[{"type":"reasoning","id":"8da7b778-aff2-4d83-bfc3-8cd09ee79b34","status":"completed","summary":[]}]}}\n\n`,
    ].join("");
    const events = await parseSse(await readAll(relaySseWithResponsesItemIdRepair(streamFromText(upstream), {
      rewriteNonCanonicalIds: true,
    })));
    const added = events.find(e => e.type === "response.output_item.added")!.item as Record<string, unknown>;
    const done = events.find(e => e.type === "response.output_item.done")!.item as Record<string, unknown>;
    const completed = events.find(e => e.type === "response.completed")!.response as { output: Record<string, unknown>[] };
    expect(added.status).toBe("in_progress");
    expect(done.status).toBe("completed");
    expect(completed.output[0].status).toBe("completed");
    expect(String(done.encrypted_content)).toMatch(/^ocxr1:/);
  });

  test("flushes retained reasoning text into terminal snapshot when item.done is missing", async () => {
    const upstream = [
      `event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"8da7b778-aff2-4d83-bfc3-8cd09ee79b34","status":"in_progress","summary":[]}}\n\n`,
      `event: response.reasoning_text.delta\ndata: {"type":"response.reasoning_text.delta","output_index":0,"item_id":"8da7b778-aff2-4d83-bfc3-8cd09ee79b34","delta":"orphan"}\n\n`,
      `event: response.completed\ndata: {"type":"response.completed","response":{"id":"58786d76-18be-43d9-b6f5-8922796fbe28","status":"completed","output":[]}}\n\n`,
    ].join("");
    const events = await parseSse(await readAll(relaySseWithResponsesItemIdRepair(streamFromText(upstream), {
      rewriteNonCanonicalIds: true,
    })));
    const completed = events.find(e => e.type === "response.completed")!.response as { output: Record<string, unknown>[] };
    expect(completed.output).toHaveLength(1);
    expect(completed.output[0].type).toBe("reasoning");
    expect(String(completed.output[0].encrypted_content)).toMatch(/^ocxr1:/);
    expect((completed.output[0].content as Array<{ text: string }>)[0].text).toBe("orphan");
  });

  test("does not overwrite an existing assistant message when flushing retained reasoning", async () => {
    const upstream = [
      `event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"1dbc05ae-0b41-40fd-961e-7a84deebe064","role":"assistant","content":[]}}\n\n`,
      // Retain reasoning text under output_index 0 even though the terminal snapshot has a message there.
      `event: response.reasoning_text.delta\ndata: {"type":"response.reasoning_text.delta","output_index":0,"item_id":"8da7b778-aff2-4d83-bfc3-8cd09ee79b34","delta":"keep-me"}\n\n`,
      `event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"1dbc05ae-0b41-40fd-961e-7a84deebe064","role":"assistant","content":[{"type":"output_text","text":"OK","annotations":[]}]}}\n\n`,
      `event: response.completed\ndata: {"type":"response.completed","response":{"id":"58786d76-18be-43d9-b6f5-8922796fbe28","status":"completed","output":[{"type":"message","id":"1dbc05ae-0b41-40fd-961e-7a84deebe064","role":"assistant","content":[{"type":"output_text","text":"OK","annotations":[]}]}]}}\n\n`,
    ].join("");
    const events = await parseSse(await readAll(relaySseWithResponsesItemIdRepair(streamFromText(upstream), {
      rewriteNonCanonicalIds: true,
    })));
    const completed = events.find(e => e.type === "response.completed")!.response as { output: Record<string, unknown>[] };
    expect(completed.output.length).toBeGreaterThanOrEqual(2);
    const reasoning = completed.output.find(item => item.type === "reasoning");
    const message = completed.output.find(item => item.type === "message");
    expect(reasoning).toBeTruthy();
    expect(message).toBeTruthy();
    expect((message!.content as Array<{ text: string }>)[0].text).toBe("OK");
    expect(String(reasoning!.encrypted_content)).toMatch(/^ocxr1:/);
  });

  test("keeps shared placeholder aliases type-scoped", async () => {
    const upstream = [
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"shared_placeholder"}}\n\n',
      'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","output_index":0,"item_id":"shared_placeholder","delta":"r"}\n\n',
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"type":"message","id":"shared_placeholder","role":"assistant"}}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":1,"item_id":"shared_placeholder","delta":"m"}\n\n',
    ].join("");
    const events = await parseSse(await readAll(relaySseWithResponsesItemIdRepair(streamFromText(upstream), {
      reasoning: ["shared_placeholder"],
      message: ["shared_placeholder"],
    })));
    const reasoningId = (events[0].item as Record<string, unknown>).id;
    const messageId = (events[2].item as Record<string, unknown>).id;
    expect(reasoningId).toMatch(/^rs_ocx_[0-9a-f]+_0$/);
    expect(messageId).toMatch(/^msg_ocx_[0-9a-f]+_1$/);
    expect(reasoningId).not.toBe(messageId);
    expect(events[1].item_id).toBe(reasoningId);
    expect(events[3].item_id).toBe(messageId);
  });

  test("charges newly retained raw aliases after an output_index is already mapped", () => {
    const budget = createTestTranslatorBudget({ maxTurnBytes: 512 });
    const handlers = createResponsesItemIdRepairHandlers({
      rewriteNonCanonicalIds: true,
    }, budget);
    // Establish one mapped reasoning id first.
    handlers.rewrite(JSON.stringify({
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "reasoning", id: "11111111-1111-4111-8111-111111111111" },
    }));
    let overflowed = false;
    try {
      for (let i = 0; i < 400; i++) {
        const raw = `${i.toString(16).padStart(8, "0")}-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
        handlers.rewrite(JSON.stringify({
          type: "response.reasoning_summary_text.delta",
          output_index: 0,
          item_id: raw,
          delta: "x",
        }));
      }
    } catch (error) {
      overflowed = isTranslatorBudgetExceededError(error);
    }
    expect(overflowed).toBe(true);
  });

  test("opt-in flag is recognized", () => {
    expect(hasResponsesItemIdRepair({ rewriteNonCanonicalIds: true })).toBe(true);
  });
});
