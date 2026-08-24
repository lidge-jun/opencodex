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

  takeDue(ms: number): () => void {
    this.current += ms;
    const due = [...this.jobs.entries()]
      .filter(([, job]) => job.at <= this.current)
      .sort((left, right) => left[1].at - right[1].at)[0];
    if (!due) throw new Error("no due scheduler job");
    this.jobs.delete(due[0]);
    return due[1].callback;
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

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  pattern: string,
): Promise<string> {
  let out = "";
  while (!out.includes(pattern)) {
    const { done, value } = await reader.read();
    if (done) throw new Error(`stream closed before ${pattern}`);
    out += decoder.decode(value, { stream: true });
  }
  return out;
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

function completedMessageLifecycle(text = "hello"): string {
  return [
    sse({
      type: "response.created",
      response: { id: "resp_message", object: "response", status: "in_progress", output: [] },
      sequence_number: 0,
    }),
    sse({
      type: "response.output_item.added",
      item: { type: "message", id: "msg_probe", role: "assistant", status: "in_progress", content: [] },
      output_index: 0,
      sequence_number: 1,
    }),
    sse({
      type: "response.output_item.done",
      item: {
        type: "message",
        id: "msg_probe",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
      output_index: 0,
      sequence_number: 2,
    }),
  ].join("");
}

function terminalTypes(text: string): string[] {
  return [...text.matchAll(/"type":"(response\.(?:completed|failed|incomplete))"/g)]
    .map(match => match[1]!);
}

async function repairClosedText(text: string): Promise<{ output: string; cancelled: boolean }> {
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
    cancel() { cancelled = true; },
  });
  const upstream = new AbortController();
  const repaired = relayResponsesSseWithTerminalRepair(
    source,
    upstream,
    POLICY,
    createTestTranslatorBudget(),
    new ManualScheduler(),
  );
  return { output: await readAll(relaySseWithFailedTail(repaired, upstream)), cancelled };
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

  test("new activity invalidates the old grace generation and waits after the new item", async () => {
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

    source.push(completedMessageLifecycle("first"));
    await settle();
    scheduler.advance(4_999);
    source.push([
      sse({
        type: "response.output_item.added",
        item: { type: "message", id: "msg_second", role: "assistant", status: "in_progress", content: [] },
        output_index: 1,
        sequence_number: 3,
      }),
      sse({
        type: "response.output_item.done",
        item: {
          type: "message",
          id: "msg_second",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "second", annotations: [] }],
        },
        output_index: 1,
        sequence_number: 4,
      }),
    ].join(""));
    await settle();
    scheduler.advance(1);
    await settle();
    expect(resolved).toBe(false);

    scheduler.advance(4_999);
    const output = await outputPromise;
    expect(terminalTypes(output)).toEqual(["response.completed"]);
    expect(output).toContain('"text":"first"');
    expect(output).toContain('"text":"second"');
    expect(scheduler.pending()).toBe(0);
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("EOF synthesizes completed only for a complete candidate", async () => {
    const { output } = await repairClosedText(completedMessageLifecycle());
    expect(terminalTypes(output)).toEqual(["response.completed"]);
    expect(output.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  test("an unframed output item done suffix taints EOF completion", async () => {
    const framed = completedMessageLifecycle();
    const finalDelimiter = framed.lastIndexOf("\n\n");
    expect(finalDelimiter).toBeGreaterThan(0);
    const input = framed.slice(0, finalDelimiter);

    const { output } = await repairClosedText(input);

    expect(output).toContain('"type":"response.output_item.done"');
    expect(terminalTypes(output)).toEqual(["response.incomplete"]);
    expect(output).not.toContain('"type":"response.completed"');
  });

  test("unframed terminal-like suffixes stay tainted and cannot outrank incomplete", async () => {
    const fixtures = [
      {
        event: "response.completed",
        payload: { type: "response.completed", response: { id: "resp_truncated_completed", status: "completed" } },
      },
      {
        event: "response.failed",
        payload: { type: "response.failed", response: { id: "resp_truncated_failed", status: "failed" } },
      },
      {
        event: "response.incomplete",
        payload: { type: "response.incomplete", response: { id: "resp_truncated_incomplete", status: "incomplete" } },
      },
      {
        event: "error",
        payload: {
          type: "error",
          response: { id: "resp_truncated_error", status: "failed" },
          error: { type: "server_error", code: "upstream_error", message: "provider failed" },
        },
      },
      {
        event: "error",
        payload: {
          type: "error",
          error: { type: "invalid_request_error", code: "cyber_policy", message: "blocked by upstream policy" },
        },
      },
    ] as const;

    for (const newline of ["\n", "\r\n"] as const) {
      for (const fixture of fixtures) {
        const input = `event: ${fixture.event}${newline}data: ${JSON.stringify(fixture.payload)}`;
        const { output } = await repairClosedText(input);

        expect(terminalTypes(output)).toEqual(["response.incomplete"]);
        expect(output).toContain('"reason":"missing_terminal_event"');
        expect(output).not.toContain("resp_truncated_");
        expect(output).not.toContain("cyber_policy");
        expect(output.match(/data: \[DONE\]/g)?.length).toBe(1);
      }

      const { output: doneOutput } = await repairClosedText(`data: [DONE]${newline}`);
      expect(terminalTypes(doneOutput)).toEqual(["response.incomplete"]);
      expect(doneOutput).toContain('"reason":"missing_terminal_event"');
      expect(doneOutput.match(/data: \[DONE\]/g)?.length).toBe(1);
    }
  });

  test("DONE is replaced by completed then one DONE only for a complete candidate", async () => {
    const { output } = await repairClosedText(completedMessageLifecycle() + "data: [DONE]\n\n");
    expect(terminalTypes(output)).toEqual(["response.completed"]);
    expect(output.match(/data: \[DONE\]/g)?.length).toBe(1);
    expect(output.indexOf("response.completed")).toBeLessThan(output.indexOf("data: [DONE]"));
  });

  test("open output items end as incomplete, never completed", async () => {
    const input = [
      sse({ type: "response.created", response: { id: "resp_open", status: "in_progress", output: [] }, sequence_number: 0 }),
      sse({
        type: "response.output_item.added",
        item: { type: "message", id: "msg_open", role: "assistant", status: "in_progress", content: [] },
        output_index: 0,
        sequence_number: 1,
      }),
    ].join("");
    const { output } = await repairClosedText(input);
    expect(terminalTypes(output)).toEqual(["response.incomplete"]);
    expect(output).not.toContain('"type":"response.completed"');
  });

  test("invalid function arguments end as incomplete, never completed", async () => {
    const input = capturedToolCallLifecycle().replaceAll('{\\"text\\":\\"OK\\"}', "{broken");
    const { output } = await repairClosedText(input);
    expect(terminalTypes(output)).toEqual(["response.incomplete"]);
  });

  test("unknown output item types taint synthetic success", async () => {
    const input = [
      sse({ type: "response.created", response: { id: "resp_unknown", status: "in_progress", output: [] }, sequence_number: 0 }),
      sse({ type: "response.output_item.added", item: { type: "computer_call", id: "cmp_1", status: "in_progress" }, output_index: 0, sequence_number: 1 }),
      sse({ type: "response.output_item.done", item: { type: "computer_call", id: "cmp_1", status: "completed" }, output_index: 0, sequence_number: 2 }),
    ].join("");
    const { output } = await repairClosedText(input);
    expect(terminalTypes(output)).toEqual(["response.incomplete"]);
  });

  test("duplicate or contradictory output indices taint synthetic success", async () => {
    const input = [
      sse({ type: "response.created", response: { id: "resp_duplicate", status: "in_progress", output: [] }, sequence_number: 0 }),
      sse({ type: "response.output_item.added", item: { type: "reasoning", id: "rs_1", status: "in_progress", content: [] }, output_index: 0, sequence_number: 1 }),
      sse({ type: "response.output_item.added", item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] }, output_index: 0, sequence_number: 2 }),
      sse({
        type: "response.output_item.done",
        item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "x" }] },
        output_index: 0,
        sequence_number: 3,
      }),
    ].join("");
    const { output } = await repairClosedText(input);
    expect(terminalTypes(output)).toEqual(["response.incomplete"]);
  });

  test("real completed failed and incomplete terminals beat the timer", async () => {
    for (const terminal of ["completed", "failed", "incomplete"] as const) {
      const scheduler = new ManualScheduler();
      const suffix = sse({
        type: `response.${terminal}`,
        response: { id: `resp_${terminal}`, status: terminal },
        sequence_number: 3,
      });
      const input = completedMessageLifecycle() + suffix + "data: [DONE]\n\n";
      const budget = createTestTranslatorBudget();
      const output = await readAll(relayResponsesSseWithTerminalRepair(
        streamFromText(input),
        new AbortController(),
        POLICY,
        budget,
        scheduler,
      ));
      scheduler.advance(5_000);
      expect(terminalTypes(output)).toEqual([`response.${terminal}`]);
      expect(scheduler.pending()).toBe(0);
      expect(budget.snapshot().currentBytes).toBe(0);
    }
  });

  test("a timer racing a real terminal commits exactly one terminal", async () => {
    const source = controlledSource();
    const scheduler = new ManualScheduler();
    const budget = createTestTranslatorBudget();
    const outputPromise = readAll(relayResponsesSseWithTerminalRepair(
      source.stream,
      new AbortController(),
      POLICY,
      budget,
      scheduler,
    ));
    source.push(completedMessageLifecycle());
    await settle();
    expect(scheduler.pending()).toBe(1);
    const dueCallback = scheduler.takeDue(5_000);
    source.push(sse({ type: "response.completed", response: { id: "resp_message", status: "completed" }, sequence_number: 3 }));
    source.close();
    await settle();
    dueCallback();
    const output = await outputPromise;
    expect(terminalTypes(output)).toEqual(["response.completed"]);
    expect(scheduler.pending()).toBe(0);
  });

  test("fragmented UTF-8 and SSE delimiters preserve lifecycle state", async () => {
    const input = completedMessageLifecycle("你好")
      + sse({ type: "response.completed", response: { id: "resp_message", status: "completed" }, sequence_number: 3 })
      + "data: [DONE]\n\n";
    const bytes = encoder.encode(input);
    const chunks = [bytes.subarray(0, 37), bytes.subarray(37, 91), bytes.subarray(91, 173), bytes.subarray(173)];
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const output = await readAll(relayResponsesSseWithTerminalRepair(
      source,
      new AbortController(),
      POLICY,
      createTestTranslatorBudget(),
      new ManualScheduler(),
    ));
    expect(output).toBe(input);
    expect(terminalTypes(output)).toEqual(["response.completed"]);
  });

  test("client cancel and upstream abort suppress synthetic completion", async () => {
    const cancelSource = controlledSource();
    const cancelScheduler = new ManualScheduler();
    const cancelUpstream = new AbortController();
    const cancelled = relayResponsesSseWithTerminalRepair(
      cancelSource.stream,
      cancelUpstream,
      POLICY,
      createTestTranslatorBudget(),
      cancelScheduler,
    );
    const cancelReader = cancelled.getReader();
    cancelSource.push(completedMessageLifecycle());
    expect(await readUntil(cancelReader, "response.output_item.done")).toContain("response.output_item.done");
    expect(cancelScheduler.pending()).toBe(1);
    await cancelReader.cancel("client gone");
    cancelScheduler.advance(5_000);
    expect(cancelSource.cancelled()).toBe(true);
    expect(cancelScheduler.pending()).toBe(0);

    const abortSource = controlledSource();
    const abortScheduler = new ManualScheduler();
    const abortUpstream = new AbortController();
    const aborted = relayResponsesSseWithTerminalRepair(
      abortSource.stream,
      abortUpstream,
      POLICY,
      createTestTranslatorBudget(),
      abortScheduler,
    );
    const abortReader = aborted.getReader();
    abortSource.push(completedMessageLifecycle());
    expect(await readUntil(abortReader, "response.output_item.done")).toContain("response.output_item.done");
    expect(abortScheduler.pending()).toBe(1);
    abortUpstream.abort("shutdown");
    await settle();
    expect(abortSource.cancelled()).toBe(true);
    expect(abortScheduler.pending()).toBe(0);
    await abortReader.cancel("test cleanup");
  });

  test("retained-state overflow throws translation_buffer_limit and releases budget", async () => {
    const budget = createTestTranslatorBudget({ maxTurnBytes: 128 });
    const source = streamFromText(completedMessageLifecycle("x".repeat(512)));
    const repaired = relayResponsesSseWithTerminalRepair(
      source,
      new AbortController(),
      POLICY,
      budget,
      new ManualScheduler(),
    );
    await expect(readAll(repaired)).rejects.toMatchObject({ code: "translation_buffer_limit" });
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("the wrapper does not continuously read ahead without downstream pulls", async () => {
    let pulls = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls <= 5) controller.enqueue(encoder.encode(`: heartbeat ${pulls}\n\n`));
      },
    });
    const repaired = relayResponsesSseWithTerminalRepair(
      source,
      new AbortController(),
      POLICY,
      createTestTranslatorBudget(),
      new ManualScheduler(),
    );

    await settle();
    // One chunk may be prefetched by each Web Stream layer; continuous read-ahead must stop there.
    expect(pulls).toBeLessThanOrEqual(2);
    await repaired.cancel("test cleanup");
  });
});
