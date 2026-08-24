import { describe, expect, test } from "bun:test";
import { createRelayedSseStream } from "../src/relay/sse-relay";

describe("createRelayedSseStream", () => {
  test("injects SSE heartbeat comments during idle upstream periods", async () => {
    const upstream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode("data: first\n\n"));
        await new Promise((resolve) => setTimeout(resolve, 80));
        controller.enqueue(new TextEncoder().encode("data: second\n\n"));
        controller.close();
      },
    });

    const relayed = createRelayedSseStream(upstream, {
      clientSignal: new AbortController().signal,
      upstreamSignal: new AbortController().signal,
      heartbeatIntervalMs: 30,
    });

    const reader = relayed.getReader();
    const chunks: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(new TextDecoder().decode(value));
    }
    const combined = chunks.join("");
    expect(combined).toContain("data: first\n\n");
    expect(combined).toContain(": heartbeat\n\n");
    expect(combined).toContain("data: second\n\n");
  });

  test("closes cleanly when upstream read fails after partial SSE data", async () => {
    let pulls = 0;
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(new TextEncoder().encode("data: partial\n\n"));
          return;
        }
        throw new Error("upstream read failed");
      },
    });

    const relayed = createRelayedSseStream(upstream, {
      clientSignal: new AbortController().signal,
      upstreamSignal: new AbortController().signal,
      heartbeatIntervalMs: 30,
    });

    const reader = relayed.getReader();
    const chunks: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(new TextDecoder().decode(value));
    }
    expect(chunks.join("")).toContain("data: partial");
  });

  test("defers heartbeat when upstream pauses mid SSE line", async () => {
    const upstream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"text":"hel'));
        await new Promise((resolve) => setTimeout(resolve, 80));
        controller.enqueue(new TextEncoder().encode('lo"}\n\n'));
        controller.close();
      },
    });

    const relayed = createRelayedSseStream(upstream, {
      clientSignal: new AbortController().signal,
      upstreamSignal: new AbortController().signal,
      heartbeatIntervalMs: 30,
    });

    const reader = relayed.getReader();
    const chunks: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(new TextDecoder().decode(value));
    }
    expect(chunks.join("")).toBe('data: {"text":"hello"}\n\n');
  });

  test("downstream cancel does not enqueue after cancellation", async () => {
    const upstream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode("data: first\n\n"));
        await new Promise((resolve) => setTimeout(resolve, 200));
        controller.enqueue(new TextEncoder().encode("data: second\n\n"));
        controller.close();
      },
    });

    const relayed = createRelayedSseStream(upstream, {
      clientSignal: new AbortController().signal,
      upstreamSignal: new AbortController().signal,
      heartbeatIntervalMs: 30,
    });

    const reader = relayed.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
});
