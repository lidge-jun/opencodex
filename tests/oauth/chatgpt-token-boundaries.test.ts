import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { ChatGptTokenError, ChatGptTokenRequestError, refreshChatGPTToken } from "../../src/oauth/chatgpt";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function stalledBody(status: number) {
  let started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  let cancelled = false;
  globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
    pull() { started(); },
    cancel() { cancelled = true; },
  }), { status })) as typeof fetch;
  return { began, cancelled: () => cancelled };
}

function instrumentCaller() {
  const caller = new AbortController();
  const listeners = new Set<EventListenerOrEventListenerObject>();
  const add = caller.signal.addEventListener.bind(caller.signal);
  const remove = caller.signal.removeEventListener.bind(caller.signal);
  spyOn(caller.signal, "addEventListener").mockImplementation((type, listener, options) => {
    if (type === "abort" && listener) listeners.add(listener);
    add(type, listener, options);
  });
  spyOn(caller.signal, "removeEventListener").mockImplementation((type, listener, options) => {
    if (type === "abort" && listener) listeners.delete(listener);
    remove(type, listener, options);
  });
  return { caller, outstanding: () => listeners.size };
}

function expectPrivateAbort(error: unknown, name: string, message: string) {
  expect(error).toBeInstanceOf(ChatGptTokenRequestError);
  expect(error).toMatchObject({ name, message, terminal: false });
  expect(error).not.toHaveProperty("cause");
  expect(error).not.toHaveProperty("reason");
  const surfaced = JSON.stringify(Object.getOwnPropertyDescriptors(error)) + String(error);
  expect(surfaced).not.toContain("invalid_grant");
  expect(surfaced).not.toContain("synthetic-private-token");
}

describe("ChatGPT token body bounds and cancellation", () => {
  for (const status of [200, 400]) {
    test(`headers arrive but ${status} body stalls past the per-fetch deadline`, async () => {
      const body = stalledBody(status);
      const pending = refreshChatGPTToken("synthetic-refresh", { timeoutMs: 20 });
      await body.began;
      expectPrivateAbort(await pending.catch(error => error), "TimeoutError", "ChatGPT token request timed out");
      expect(body.cancelled()).toBe(true);
    });

    test(`caller abort during ${status} body read is sanitized and propagated`, async () => {
      const body = stalledBody(status);
      const caller = new AbortController();
      const pending = refreshChatGPTToken("synthetic-refresh", { signal: caller.signal });
      const rejected = pending.catch(error => error);
      await body.began;
      caller.abort(new Error("invalid_grant synthetic-private-token"));
      expectPrivateAbort(await rejected, "AbortError", "ChatGPT token request cancelled");
      expect(body.cancelled()).toBe(true);
    });
  }

  test("oversized error body stops at 16 KiB bytes and discards a terminal prefix", async () => {
    let pulls = 0;
    let cancelled = false;
    const prefix = new TextEncoder().encode('{"error":"invalid_grant","padding":"');
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        const chunk = new TextEncoder().encode("é".repeat(2048));
        if (pulls === 1) chunk.set(prefix);
        controller.enqueue(chunk);
        // Advertise a much larger body without allocating or consuming it.
        if (pulls === 1000) controller.close();
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }), { status: 400 })) as typeof fetch;
    const error = await refreshChatGPTToken("synthetic-refresh").catch(error => error);
    expect(error).toBeInstanceOf(ChatGptTokenError);
    expect(error).toMatchObject({ httpStatus: 400, terminal: false, oauthError: undefined });
    expect(error.message).toBe("ChatGPT refresh failed: 400 code=none");
    expect(pulls).toBe(5);
    expect(cancelled).toBe(true);
  });

  test("success JSON exceeding 64 KiB is cancelled and sanitized before parsing", async () => {
    let cancelled = false;
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(65_537)); },
      cancel() { cancelled = true; },
    }))) as typeof fetch;
    const error = await refreshChatGPTToken("synthetic-refresh").catch(error => error);
    expect(error).toBeInstanceOf(ChatGptTokenRequestError);
    expect(error.message).toBe("ChatGPT token request failed");
    expect(cancelled).toBe(true);
  });

  test("malformed success JSON never exposes the parser's input", async () => {
    globalThis.fetch = (async () => new Response("invalid_grant synthetic-private-token")) as typeof fetch;
    const error = await refreshChatGPTToken("synthetic-refresh").catch(error => error);
    expectPrivateAbort(error, "ChatGptTokenRequestError", "ChatGPT token request failed");
  });
});

describe("ChatGPT caller signal cleanup", () => {
  for (const outcome of ["transport failure", "JSON parse failure"] as const) {
    test(`${outcome} clears the deadline timer and removes the caller listener`, async () => {
      const { caller, outstanding } = instrumentCaller();
      const originalSetTimeout = globalThis.setTimeout;
      const originalClearTimeout = globalThis.clearTimeout;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const timers = spyOn(globalThis, "setTimeout").mockImplementation((callback, ms, ...args) => {
        deadline = originalSetTimeout(callback, ms, ...args);
        return deadline;
      });
      const cleared = spyOn(globalThis, "clearTimeout");
      let completedSignal!: AbortSignal;
      try {
        globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
          completedSignal = init!.signal!;
          if (outcome === "transport failure") throw new Error("invalid_grant synthetic-private-token");
          return new Response("invalid_grant synthetic-private-token");
        }) as typeof fetch;
        const error = await refreshChatGPTToken("synthetic-refresh", { signal: caller.signal }).catch(error => error);
        expectPrivateAbort(error, "ChatGptTokenRequestError", "ChatGPT token request failed");
        expect(timers).toHaveBeenCalledTimes(1);
        expect(timers.mock.calls[0]![1]).toBe(30_000);
        expect(deadline).toBeDefined();
        expect(cleared).toHaveBeenCalledWith(deadline!);
        expect(outstanding()).toBe(0);
        caller.abort(new Error("synthetic-private-token"));
        expect(completedSignal.aborted).toBe(false);
      } finally {
        timers.mockRestore();
        cleared.mockRestore();
        if (deadline !== undefined) originalClearTimeout(deadline);
      }
    });
  }

  for (const outcome of ["success", "HTTP failure", "timeout"] as const) {
    test(`${outcome} removes the caller listener; later abort cancels only a separate flight`, async () => {
      const { caller, outstanding } = instrumentCaller();
      let completedSignal!: AbortSignal;
      if (outcome === "timeout") {
        globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
          completedSignal = init!.signal!;
          return new Promise<Response>((_, reject) => {
            completedSignal.addEventListener("abort", () => reject(completedSignal.reason), { once: true });
          });
        }) as typeof fetch;
      } else {
        globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
          completedSignal = init!.signal!;
          return outcome === "success" ? Response.json({ access_token: "synthetic-access" })
            : Response.json({ error: "invalid_grant" }, { status: 400 });
        }) as typeof fetch;
      }
      const result = await refreshChatGPTToken("synthetic-refresh", { signal: caller.signal, timeoutMs: 20 })
        .then(() => "success", error => error);
      if (outcome === "success") expect(result).toBe("success");
      else if (outcome === "HTTP failure") expect(result).toBeInstanceOf(ChatGptTokenError);
      else expect(result).toHaveProperty("name", "TimeoutError");
      expect(outstanding()).toBe(0);
      const wasAborted = completedSignal.aborted;
      const completedReason = completedSignal.reason;
      const body = stalledBody(200);
      const pending = refreshChatGPTToken("synthetic-refresh", { signal: caller.signal });
      const rejected = pending.catch(error => error);
      await body.began;
      expect(outstanding()).toBe(1);
      caller.abort(new Error("invalid_grant synthetic-private-token"));
      expectPrivateAbort(await rejected, "AbortError", "ChatGPT token request cancelled");
      expect(outstanding()).toBe(0);
      expect(completedSignal.aborted).toBe(wasAborted);
      expect(completedSignal.reason).toBe(completedReason);
    });
  }
});
