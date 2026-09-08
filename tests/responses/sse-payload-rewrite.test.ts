/**
 * Single-pass composition of client-facing SSE payload rewrites (#588 follow-up).
 */
import { describe, expect, test } from "bun:test";
import { createImageGenCallRestoreRewrite } from "../../src/server/responses-image-gen-repair";
import { createResponsesItemIdPayloadRewrite } from "../../src/server/responses-item-id-repair";
import {
  composeSsePayloadRewrites,
  relaySseWithBlockRewrite,
  relaySseWithPayloadRewrite,
} from "../../src/server/sse-payload-rewrite";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
import { relaySseWithFailedTail } from "../../src/server/relay";
import { demaskGuardrailsText, maskGuardrailsText } from "../../src/guardrails/placeholders";
import { guardrailsSseDemaskRewrite } from "../../src/guardrails/sse-demask";

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

function streamFromTexts(texts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const text = texts[index++];
      if (text === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(text));
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

async function readAllBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

describe("SSE payload rewrite composition", () => {
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

  test("keeps pulling after a partial or intentionally dropped block", async () => {
    const budget = createTestTranslatorBudget();
    const upstream = streamFromTexts([
      'event: drop\ndata: {"type":"drop"',
      '}\n\nevent: keep\ndata: {"type":"keep","delta":"ok"}\n\n',
    ]);
    const rewritten = relaySseWithBlockRewrite(
      upstream,
      (block) => block.includes('"type":"drop"') ? [] : [block],
      budget,
    );

    expect(await readAll(rewritten)).toBe(
      'event: keep\ndata: {"type":"keep","delta":"ok"}\n\n',
    );
    expect(budget.snapshot().currentBytes).toBe(0);
  });

  test("rewrites one highly fragmented event without retaining buffer capacity", async () => {
    const event = `data: ${JSON.stringify({ type: "fragmented", delta: "x".repeat(16_384) })}\n\n`;
    const budget = createTestTranslatorBudget({ maxTurnBytes: 128 * 1024 });
    const rewritten = relaySseWithPayloadRewrite(
      streamFromTexts([...event]),
      payload => payload,
      budget,
    );

    expect(await readAll(rewritten)).toBe(event);
    expect(budget.snapshot().currentBytes).toBe(0);
    budget.dispose();
  });

  test("rewrites thousands of packed events without retaining tail copies", async () => {
    const eventCount = 4_096;
    const upstream = Array.from(
      { length: eventCount },
      (_, index) => `data: ${JSON.stringify({ type: "packed", index })}\n\n`,
    ).join("");
    const budget = createTestTranslatorBudget({ maxTurnBytes: 2 * 1024 * 1024 });
    const rewritten = relaySseWithPayloadRewrite(
      streamFromText(upstream),
      payload => payload,
      budget,
    );

    const output = await readAll(rewritten);
    expect(output).toBe(upstream);
    expect(output.match(/\n\n/g)).toHaveLength(eventCount);
    expect(budget.snapshot().currentBytes).toBe(0);
    budget.dispose();
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

  test("malformed UTF-8 falls back to byte-identical passthrough", async () => {
    const encoder = new TextEncoder();
    const prefix = encoder.encode('event: malformed\ndata: {"delta":"');
    const suffix = encoder.encode('"}\r\n\r\nevent: later\r\ndata: {"delta":"ok"}\r\n\r\n');
    const malformed = new Uint8Array(prefix.byteLength + 1 + suffix.byteLength);
    malformed.set(prefix);
    malformed[prefix.byteLength] = 0x80;
    malformed.set(suffix, prefix.byteLength + 1);
    let sent = false;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) {
          controller.close();
          return;
        }
        sent = true;
        controller.enqueue(malformed);
      },
    });
    const budget = createTestTranslatorBudget();
    const rewritten = relaySseWithBlockRewrite(
      source,
      block => [block.replace('"ok"', '"changed"')],
      budget,
    );

    expect([...await readAllBytes(rewritten)]).toEqual([...malformed]);
    expect(budget.snapshot().currentBytes).toBe(0);
    budget.dispose();
  });

  test("a failed error flush releases retained bytes and disposes the rewriter", async () => {
    const failure = new Error("synthetic flush failure");
    const budget = createTestTranslatorBudget();
    let reads = 0;
    let disposals = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads++ === 0) controller.enqueue(new TextEncoder().encode("data: partial"));
        else controller.error(new Error("synthetic source failure"));
      },
    });
    const rewrite = Object.assign((block: string) => [block], {
      flush(): string[] { throw failure; },
      dispose() { disposals++; },
    });
    try {
      await expect(readAll(relaySseWithBlockRewrite(source, rewrite, budget))).rejects.toBe(failure);
      expect(disposals).toBe(1);
      expect(budget.snapshot().currentBytes).toBe(0);
    } finally {
      budget.dispose();
    }
  });

  test("source errors deliver an already-buffered partial tail before the original error", async () => {
    const encoder = new TextEncoder();
    const failure = new Error("synthetic upstream failure");
    let pullCount = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        if (pullCount === 1) {
          controller.enqueue(encoder.encode('event: partial\ndata: {"delta":"kept"}'));
          return;
        }
        controller.error(failure);
      },
    });
    const budget = createTestTranslatorBudget();
    const reader = relaySseWithPayloadRewrite(source, payload => payload, budget).getReader();

    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toBe('event: partial\ndata: {"delta":"kept"}');
    await expect(reader.read()).rejects.toBe(failure);
    expect(budget.snapshot().currentBytes).toBe(0);
    budget.dispose();
  });

  test("source errors deliver the held Guardrails masked flush before the original error", async () => {
    const secret = "synthetic-private-value";
    const masked = maskGuardrailsText(secret, [{
      ruleId: "synthetic.secret", dataType: 1, placeholderType: "SECRET",
      start: 0, end: secret.length, value: secret,
    }]);
    const delta = `data: ${JSON.stringify({
      type: "response.output_text.delta", item_id: "message-held", output_index: 0,
      content_index: 0, delta: masked.maskedText,
    })}`;
    const guard = guardrailsSseDemaskRewrite(masked.state, payload => demaskGuardrailsText(payload, masked.state));
    const failure = new Error("synthetic source failure after held restoration");
    const budget = createTestTranslatorBudget();
    let reads = 0;
    let heldBlocks = 0;
    let disposals = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads++ === 0) controller.enqueue(new TextEncoder().encode(`${delta}\n\n`));
        else controller.error(failure);
      },
    });
    const rewrite = Object.assign((block: string) => {
      const output = guard(block);
      expect(output).toEqual([]);
      heldBlocks++;
      return output;
    }, {
      flush: () => guard.flush?.() ?? [],
      dispose: () => { disposals++; guard.dispose?.(); },
    });
    const reader = relaySseWithBlockRewrite(source, rewrite, budget).getReader();
    try {
      const first = await reader.read();
      expect(heldBlocks).toBe(1);
      expect(first.done).toBe(false);
      const wire = new TextDecoder().decode(first.value);
      expect(wire).toBe(`${delta}\n\n`);
      expect(wire).not.toContain(secret);
      await expect(reader.read()).rejects.toBe(failure);
      expect(disposals).toBe(1);
      expect(guard.flush?.()).toEqual([]);
      expect(budget.snapshot().currentBytes).toBe(0);
    } finally {
      reader.releaseLock();
      budget.dispose();
    }
  });
  test.each(["resolve", "reject"] as const)(
    "surfaces a rewrite failure before tee cancellation can %s",
    async cancellationOutcome => {
      const budget = createTestTranslatorBudget({ maxTurnBytes: 64 });
      const upstream = new AbortController();
      const cancellation = Promise.withResolvers<void>();
      const cancellationError = new Error("upstream cancellation failed");
      let cancelCalls = 0;
      let disposeCalls = 0;
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: partial"));
          controller.enqueue(new TextEncoder().encode("x".repeat(80)));
          // Keep the source open after exhausting the rewrite budget.
        },
        cancel() {
          cancelCalls += 1;
          return cancellation.promise;
        },
      });
      const [native, inspection] = source.tee();
      const inspectionReader = inspection.getReader();
      await inspectionReader.read();
      await inspectionReader.read();
      let inspectionSettled = false;
      const pendingInspection = inspectionReader.read().then(() => { inspectionSettled = true; });
      const rewrite = Object.assign((block: string) => [block], {
        dispose() { disposeCalls += 1; },
      });
      const rewritten = relaySseWithBlockRewrite(native, rewrite, budget);
      const client = relaySseWithFailedTail(rewritten, upstream);
      const completion = readAll(client);
      let deadline: ReturnType<typeof setTimeout> | undefined;

      try {
        const out = await Promise.race([
          completion,
          new Promise<never>((_, reject) => {
            deadline = setTimeout(() => reject(new Error("rewrite failure waited for the inspection tee")), 1_000);
          }),
        ]);
        expect(out.match(/event: response.failed/g)).toHaveLength(1);
        expect(out).toContain('"code":"translation_buffer_limit"');
        expect(out).toEndWith("data: [DONE]\n\n");
        expect(upstream.signal.aborted).toBe(true);
        expect(inspectionSettled).toBe(false);
        expect(cancelCalls).toBe(0);
        expect(disposeCalls).toBe(1);
        expect(budget.snapshot().currentBytes).toBe(0);
        expect(budget.snapshot().overflows).toBe(1);

        // Releasing inspection settles both tee cancellation promises. A late
        // rejection must be handled by the rewriter as well as this reader.
        const siblingCancellation = inspectionReader.cancel("inspection cleanup");
        expect(cancelCalls).toBe(1);
        if (cancellationOutcome === "reject") {
          cancellation.reject(cancellationError);
          await expect(siblingCancellation).rejects.toBe(cancellationError);
        } else {
          cancellation.resolve();
          await siblingCancellation;
        }
        await pendingInspection;
        await Bun.sleep(0); // Let the runner observe any unhandled cancellation rejection.
        expect(disposeCalls).toBe(1);
      } finally {
        clearTimeout(deadline);
        const cleanup = inspectionReader.cancel().catch(() => {});
        cancellation.resolve();
        await cleanup;
        await pendingInspection;
        await completion.catch(() => {});
        inspectionReader.releaseLock();
        budget.dispose();
      }
    },
  );
});
