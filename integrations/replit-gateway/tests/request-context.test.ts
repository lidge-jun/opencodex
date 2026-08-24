import { describe, expect, test } from "bun:test";
import { createLinkedAbortController, createTimeoutSignal } from "../src/cancel";
import { createRelayExecutionContext } from "../src/request-context";

describe("createRelayExecutionContext", () => {
  test("links client abort to upstream signal", () => {
    const client = new AbortController();
    const ctx = createRelayExecutionContext({
      clientSignal: client.signal,
      clientTimeoutMs: 5000,
      upstreamTimeoutMs: 4000,
    });
    expect(ctx.upstreamSignal.aborted).toBe(false);
    client.abort();
    expect(ctx.upstreamSignal.aborted).toBe(true);
    expect(ctx.callerAborted()).toBe(true);
    expect(ctx.clientTimedOut()).toBe(false);
    ctx.cleanup();
  });

  test("marks upstream timeout separately from client abort", async () => {
    const client = new AbortController();
    const ctx = createRelayExecutionContext({
      clientSignal: client.signal,
      clientTimeoutMs: 5000,
      upstreamTimeoutMs: 20,
    });
    await Bun.sleep(30);
    expect(ctx.upstreamTimedOut()).toBe(true);
    expect(ctx.clientTimedOut()).toBe(false);
    expect(ctx.callerAborted()).toBe(false);
    expect(ctx.upstreamSignal.aborted).toBe(true);
    ctx.cleanup();
  });

  test("marks client deadline separately from caller abort and upstream timeout", async () => {
    const client = new AbortController();
    const ctx = createRelayExecutionContext({
      clientSignal: client.signal,
      clientTimeoutMs: 20,
      upstreamTimeoutMs: 5000,
    });
    await Bun.sleep(30);
    expect(ctx.clientTimedOut()).toBe(true);
    expect(ctx.callerAborted()).toBe(false);
    expect(ctx.upstreamTimedOut()).toBe(false);
    ctx.cleanup();
  });
});

describe("cancellation disposers", () => {
  test("createTimeoutSignal dispose clears pending timeout", async () => {
    const timeout = createTimeoutSignal(30);
    timeout.dispose();
    await Bun.sleep(40);
    expect(timeout.signal.aborted).toBe(false);
    expect(timeout.timedOut()).toBe(false);
  });

  test("createLinkedAbortController dispose removes parent listener", () => {
    const parent = new AbortController();
    const linked = createLinkedAbortController(parent.signal);
    linked.dispose();
    parent.abort();
    expect(linked.controller.signal.aborted).toBe(false);
  });

  test("createRelayExecutionContext cleanup prevents later timeout abort", async () => {
    const client = new AbortController();
    const ctx = createRelayExecutionContext({
      clientSignal: client.signal,
      clientTimeoutMs: 20,
      upstreamTimeoutMs: 20,
    });
    ctx.cleanup();
    await Bun.sleep(30);
    expect(ctx.clientTimedOut()).toBe(false);
    expect(ctx.upstreamTimedOut()).toBe(false);
    expect(ctx.upstreamSignal.aborted).toBe(false);
  });
});
