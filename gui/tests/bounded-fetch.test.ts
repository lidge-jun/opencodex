import { expect, test } from "bun:test";
import { createBoundedFetch, withFetchDeadline } from "../src/bounded-fetch";

test("createBoundedFetch aborts when the controller is aborted (native path)", () => {
  const bounded = createBoundedFetch(60_000);
  expect(bounded.signal.aborted).toBe(false);
  bounded.controller.abort();
  expect(bounded.signal.aborted).toBe(true);
  bounded.clear();
});

test("createBoundedFetch aborts after the timeout on the compatibility path", async () => {
  const originalAny = Object.getOwnPropertyDescriptor(AbortSignal, "any");
  const originalTimeout = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
  // Force the manual setTimeout fallback so we exercise the timer path.
  Object.defineProperty(AbortSignal, "any", { value: undefined, configurable: true });
  Object.defineProperty(AbortSignal, "timeout", { value: undefined, configurable: true });

  try {
    const bounded = createBoundedFetch(20);
    expect(bounded.signal.aborted).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(bounded.signal.aborted).toBe(true);
    bounded.clear();
  } finally {
    if (originalAny) Object.defineProperty(AbortSignal, "any", originalAny);
    if (originalTimeout) Object.defineProperty(AbortSignal, "timeout", originalTimeout);
  }
});

test("createBoundedFetch clear cancels a pending manual timeout", async () => {
  const originalAny = Object.getOwnPropertyDescriptor(AbortSignal, "any");
  const originalTimeout = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
  Object.defineProperty(AbortSignal, "any", { value: undefined, configurable: true });
  Object.defineProperty(AbortSignal, "timeout", { value: undefined, configurable: true });

  try {
    const bounded = createBoundedFetch(100);
    bounded.clear();
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(bounded.signal.aborted).toBe(false);
  } finally {
    if (originalAny) Object.defineProperty(AbortSignal, "any", originalAny);
    if (originalTimeout) Object.defineProperty(AbortSignal, "timeout", originalTimeout);
  }
});

test.each(["native", "compatibility"] as const)("deadline bounds signal-dropping work on the %s path", async mode => {
  const originalAny = Object.getOwnPropertyDescriptor(AbortSignal, "any");
  const originalTimeout = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
  if (mode === "compatibility") {
    Object.defineProperty(AbortSignal, "any", { value: undefined, configurable: true });
    Object.defineProperty(AbortSignal, "timeout", { value: undefined, configurable: true });
  }
  let release!: () => void;
  let observed!: AbortSignal;
  let wrote = false;
  try {
    const pending = withFetchDeadline(20, undefined, async signal => {
      observed = signal;
      await new Promise<void>(resolve => { release = resolve; });
      signal.throwIfAborted();
      wrote = true;
    });
    await expect(pending).rejects.toBeDefined();
    expect(observed.aborted).toBe(true);
    release();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(wrote).toBe(false);
  } finally {
    if (originalAny) Object.defineProperty(AbortSignal, "any", originalAny);
    if (originalTimeout) Object.defineProperty(AbortSignal, "timeout", originalTimeout);
  }
});

test("lifecycle cancellation settles signal-dropping work before its deadline", async () => {
  const caller = new AbortController();
  let observed!: AbortSignal;
  const pending = withFetchDeadline(10_000, caller.signal, async signal => {
    observed = signal;
    return new Promise<void>(() => {});
  });
  caller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(observed.aborted).toBe(true);
});
