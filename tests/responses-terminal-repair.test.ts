import { describe, expect, test } from "bun:test";
import type { ResponsesTerminalRepairPolicy } from "../src/providers/registry";
import { relaySseWithFailedTail } from "../src/server/relay";
import {
  relayResponsesSseWithTerminalRepair,
  type ResponsesTerminalRepairScheduler,
} from "../src/server/responses-terminal-repair";
import { createTestTranslatorBudget } from "./helpers/translator-budget";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const POLICY: ResponsesTerminalRepairPolicy = { graceMs: 5_000 };

class ManualScheduler implements ResponsesTerminalRepairScheduler {
  private current = 0;
  private nextId = 1;
  private readonly jobs = new Map<number, { at: number; callback: () => void }>();

  nowMs(): number { return this.current; }

  schedule(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++;
    this.jobs.set(id, { at: this.current + delayMs, callback });
    return id;
  }

  cancel(handle: unknown): void {
    this.jobs.delete(handle as number);
  }

  advance(ms: number): void {
    this.current += ms;
    for (;;) {
      const due = [...this.jobs.entries()]
        .filter(([, job]) => job.at <= this.current)
        .sort((left, right) => left[1].at - right[1].at);
      if (due.length === 0) return;
      for (const [id, job] of due) {
        if (!this.jobs.delete(id)) continue;
        job.callback();
      }
    }
  }

  pending(): number { return this.jobs.size; }
}

function sse(event: Record<string, unknown>): string {
  return `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;
}

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function controlledSource(): {
  stream: ReadableStream<Uint8Array>;
  push(text: string): void;
  close(): void;
  cancelled(): boolean;
} {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let wasCancelled = false;
  return {
    stream: new ReadableStream<Uint8Array>({
      start(next) { controller = next; },
      cancel() { wasCancelled = true; },
    }),
    push(text) { controller?.enqueue(encoder.encode(text)); },
    close() { controller?.close(); },
    cancelled: () => wasCancelled,
  };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out + decoder.decode();
    out += decoder.decode(value, { stream: true });
  }
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Bun.sleep(0);
}

function capturedToolCallLifecycle(): string {
  return [
    sse({
      type: "response.created",
      response: { id: "resp_probe", object: "response", status: "in_progress", output: [] },
      sequence_number: 0,
    }),
    sse({
      type: "response.output_item.added",
      item: { type: "reasoning", id: "rs_probe", status: "in_progress", content: [], summary: [] },
      output_index: 0,
      sequence_number: 1,
    }),
    sse({
      type: "response.output_item.done",
      item: {
        type: "reasoning",
        id: "rs_probe",
        status: "completed",
        content: [{ type: "reasoning_text", text: "Call the probe tool." }],
        summary: [],
      },
      output_index: 0,
      sequence_number: 2,
    }),
    sse({
      type: "response.output_item.added",
      item: {
        type: "function_call",
        id: "fc_probe",
        status: "in_progress",
        arguments: "",
        call_id: "call_probe",
        name: "probe",
      },
      output_index: 1,
      sequence_number: 3,
    }),
    sse({
      type: "response.function_call_arguments.done",
      arguments: "{\"text\":\"OK\"}",
      item_id: "fc_probe",
      output_index: 1,
      sequence_number: 4,
    }),
    sse({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        id: "fc_probe",
        status: "completed",
        arguments: "{\"text\":\"OK\"}",
        call_id: "call_probe",
        name: "probe",
      },
      output_index: 1,
      sequence_number: 5,
    }),
  ].join("");
}

describe("DeepSeek Responses terminal repair", () => {
  test("a healthy stream with a real terminal is relayed byte-identical", async () => {
    const lifecycle = capturedToolCallLifecycle();
    const terminal = sse({
      type: "response.completed",
      response: { id: "resp_probe", object: "response", status: "completed", output: [] },
      sequence_number: 6,
    });
    const upstream = lifecycle + terminal + "data: [DONE]\n\n";
    const budget = createTestTranslatorBudget();

    const output = await readAll(relayResponsesSseWithTerminalRepair(
      streamFromText(upstream),
      new AbortController(),
      POLICY,
      budget,
    ));

    expect(output).toBe(upstream);
    expect(output.match(/"type":"response\.completed"/g)?.length).toBe(1);
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("a complete terminal-less tool call commits only after the grace period", async () => {
    const source = controlledSource();
    const scheduler = new ManualScheduler();
    const budget = createTestTranslatorBudget();
    const upstream = new AbortController();
    const repaired = relayResponsesSseWithTerminalRepair(source.stream, upstream, POLICY, budget, scheduler);
    let resolved = false;
    const outputPromise = readAll(relaySseWithFailedTail(repaired, upstream)).then(output => {
      resolved = true;
      return output;
    });

    source.push(capturedToolCallLifecycle());
    await settle();
    expect(scheduler.pending()).toBe(1);
    scheduler.advance(4_999);
    await settle();
    expect(resolved).toBe(false);

    scheduler.advance(1);
    const output = await outputPromise;
    expect(resolved).toBe(true);
    expect(output.match(/"type":"response\.completed"/g)?.length).toBe(1);
    expect(output.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(output).toContain('"call_id":"call_probe"');
    expect(source.cancelled()).toBe(true);
    expect(scheduler.pending()).toBe(0);
    expect(budget.snapshot().currentBytes).toBe(0);
  });
});
