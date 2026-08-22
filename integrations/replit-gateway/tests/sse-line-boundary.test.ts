import { describe, expect, test } from "bun:test";
import {
  canInjectSseHeartbeat,
  createSseLineBoundaryState,
  updateSseLineBoundaryState,
} from "../src/relay/sse-line-boundary";
import { createRelayedSseStream } from "../src/relay/sse-relay";

describe("sse line boundary tracking", () => {
  test("starts at a line boundary", () => {
    const state = createSseLineBoundaryState();
    expect(canInjectSseHeartbeat(state)).toBe(true);
  });

  test("detects LF line endings", () => {
    let state = createSseLineBoundaryState();
    state = updateSseLineBoundaryState(state, new TextEncoder().encode('data: {"x":1}\n'));
    expect(canInjectSseHeartbeat(state)).toBe(true);
    state = updateSseLineBoundaryState(state, new TextEncoder().encode("data: hel"));
    expect(canInjectSseHeartbeat(state)).toBe(false);
  });

  test("detects CRLF split across chunks without a mid-line boundary", () => {
    let state = createSseLineBoundaryState();
    state = updateSseLineBoundaryState(state, new TextEncoder().encode("data: x\r"));
    expect(canInjectSseHeartbeat(state)).toBe(false);
    state = updateSseLineBoundaryState(state, new TextEncoder().encode("\n"));
    expect(canInjectSseHeartbeat(state)).toBe(true);
  });

  test("marks CR-only endings as boundary state while deferring immediate heartbeat", () => {
    let state = createSseLineBoundaryState();
    state = updateSseLineBoundaryState(state, new TextEncoder().encode("data: x\r"));
    expect(state.atBoundary).toBe(true);
    expect(state.pendingCr).toBe(true);
    expect(canInjectSseHeartbeat(state)).toBe(false);
  });

  test("resumes mid-line after CR-only boundary when next chunk starts content", () => {
    let state = createSseLineBoundaryState();
    state = updateSseLineBoundaryState(state, new TextEncoder().encode("data: x\r"));
    expect(state.atBoundary).toBe(true);
    state = updateSseLineBoundaryState(state, new TextEncoder().encode("data: y\r\n"));
    expect(canInjectSseHeartbeat(state)).toBe(true);
  });
});

describe("sse heartbeat with CR delimiters", () => {
  test("injects heartbeat after idle CR-only line ending", async () => {
    const upstream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode("data: first\r"));
        await new Promise((resolve) => setTimeout(resolve, 80));
        controller.enqueue(new TextEncoder().encode("data: second\r\n"));
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
    const combined = chunks.join("");
    expect(combined).toContain("data: first\r");
    expect(combined).toContain(": heartbeat\n\n");
    expect(combined).toContain("data: second\r\n");
    expect(combined.indexOf(": heartbeat")).toBeGreaterThan(combined.indexOf("data: first\r"));
    expect(combined.indexOf("data: second")).toBeGreaterThan(combined.indexOf(": heartbeat"));
  });

  test("does not inject heartbeat between split CRLF chunks", async () => {
    const upstream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"text":"hello"}\r'));
        await new Promise((resolve) => setTimeout(resolve, 5));
        controller.enqueue(new TextEncoder().encode("\n"));
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
    expect(chunks.join("")).toBe('data: {"text":"hello"}\r\n');
  });
});
