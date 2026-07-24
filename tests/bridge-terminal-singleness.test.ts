import { describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE } from "../src/bridge";
import type { AdapterEvent } from "../src/types";

async function collectSseText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    text += decoder.decode(value, { stream: true });
  }
}

function eventNames(text: string): string[] {
  return text.split("\n\n")
    .map(frame => frame.trim())
    .filter(frame => frame.length > 0 && frame !== "data: [DONE]")
    .map(frame => frame.split("\n").find(line => line.startsWith("event: "))?.slice(7) ?? "");
}

function doneFrames(text: string): number {
  return text.split("\n\n").filter(frame => frame.trim() === "data: [DONE]").length;
}

describe("Responses bridge terminal singleness", () => {
  test("error then done emits only response.failed and one [DONE]", async () => {
    async function* source(): AsyncGenerator<AdapterEvent> {
      yield { type: "error", message: "first terminal wins" };
      yield { type: "done" };
    }

    const text = await collectSseText(bridgeToResponsesSSE(source(), "routed/model"));
    const terminals = eventNames(text).filter(name =>
      name === "response.completed" || name === "response.incomplete" || name === "response.failed"
    );

    expect(terminals).toEqual(["response.failed"]);
    expect(doneFrames(text)).toBe(1);
  });

  test("done then trailing error emits only response.completed and cleans up without awaiting return", async () => {
    let index = 0;
    let returnCalls = 0;
    let cleanupCatchAttached = false;
    const cleanup = new Promise<IteratorResult<AdapterEvent>>(() => {});
    const originalCatch = cleanup.catch.bind(cleanup);
    cleanup.catch = ((onRejected) => {
      cleanupCatchAttached = true;
      return originalCatch(onRejected);
    }) as typeof cleanup.catch;
    const values: AdapterEvent[] = [
      { type: "done" },
      { type: "error", message: "must not be consumed" },
    ];
    const source: AsyncIterable<AdapterEvent> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<AdapterEvent>> {
            const value = values[index++];
            return value ? { done: false, value } : { done: true, value: undefined };
          },
          return(): Promise<IteratorResult<AdapterEvent>> {
            returnCalls += 1;
            return cleanup;
          },
        };
      },
    };

    const text = await collectSseText(bridgeToResponsesSSE(source, "routed/model"));
    const terminals = eventNames(text).filter(name =>
      name === "response.completed" || name === "response.incomplete" || name === "response.failed"
    );

    expect(terminals).toEqual(["response.completed"]);
    expect(doneFrames(text)).toBe(1);
    expect(returnCalls).toBe(1);
    expect(cleanupCatchAttached).toBe(true);
  });

  test("runTurn-style producer aborts and its queue stops growing at the first terminal", async () => {
    const abortController = new AbortController();
    const queued: AdapterEvent[] = [];
    let waiting: ((result: IteratorResult<AdapterEvent>) => void) | undefined;
    let closed = false;
    let acceptedPushes = 0;
    let queueLengthAtAbort: number | undefined;
    let acceptedPushesAtAbort: number | undefined;

    const push = (event: AdapterEvent): void => {
      if (closed) return;
      acceptedPushes += 1;
      const reader = waiting;
      waiting = undefined;
      if (reader) reader({ done: false, value: event });
      else queued.push(event);
    };
    const close = (): void => {
      if (closed) return;
      closed = true;
      const reader = waiting;
      waiting = undefined;
      reader?.({ done: true, value: undefined });
    };
    const source: AsyncIterable<AdapterEvent> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<AdapterEvent>> {
            const value = queued.shift();
            if (value) return { done: false, value };
            if (closed) return { done: true, value: undefined };
            return new Promise(resolve => { waiting = resolve; });
          },
          async return(): Promise<IteratorResult<AdapterEvent>> {
            close();
            return { done: true, value: undefined };
          },
        };
      },
    };

    const textPromise = collectSseText(bridgeToResponsesSSE(
      source,
      "cursor/model",
      undefined,
      undefined,
      undefined,
      () => {
        abortController.abort();
        queueLengthAtAbort = queued.length;
        acceptedPushesAtAbort = acceptedPushes;
        close();
      },
    ));
    const producer = (async () => {
      push({ type: "error", message: "stop producer" });
      for (let i = 0; i < 5 && !abortController.signal.aborted; i++) {
        await Promise.resolve();
        if (!abortController.signal.aborted) push({ type: "done" });
      }
      close();
    })();

    const text = await textPromise;
    await producer;
    const queueLengthAfterProducerSettled = queued.length;

    expect(abortController.signal.aborted).toBe(true);
    expect(queueLengthAtAbort).toBeDefined();
    expect(queueLengthAfterProducerSettled).toBe(queueLengthAtAbort);
    expect(acceptedPushes).toBe(acceptedPushesAtAbort);
    expect(acceptedPushes).toBeLessThan(6);
    expect(eventNames(text).filter(name => name === "response.failed")).toHaveLength(1);
    expect(doneFrames(text)).toBe(1);
  });
});
