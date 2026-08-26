import { afterEach, describe, expect, test } from "bun:test";
import { runWebSearch } from "../src/web-search/executor";
import { runWithWebSearch as runWithWebSearchProduction, type WebSearchLoopDeps } from "../src/web-search/loop";
import { describeImage } from "../src/vision/describe";
import { parseRequest } from "../src/responses/parser";
import { headersForCodexAuthContext } from "../src/codex/auth-context";
import type { ProviderAdapter } from "../src/adapters/base";
import type { OcxProviderConfig } from "../src/types";
import { createTestTranslatorBudget } from "./helpers/translator-budget";

function runWithWebSearch(
  deps: Omit<WebSearchLoopDeps, "incomingMeta"> & { incomingMeta?: WebSearchLoopDeps["incomingMeta"] },
): Promise<Response> {
  return runWithWebSearchProduction({
    ...deps,
    incomingMeta: deps.incomingMeta ?? {
      headers: new Headers(),
      translatorBudget: createTestTranslatorBudget(),
    },
  });
}

const originalFetch = globalThis.fetch;

const forwardProvider: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://chatgpt.test",
  authMode: "forward",
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function installAbortAwareFetch(): () => AbortSignal {
  let seenSignal: AbortSignal | undefined;
  globalThis.fetch = ((_, init) => {
    seenSignal = init?.signal as AbortSignal | undefined;
    return new Promise<Response>((_, reject) => {
      const signal = seenSignal;
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }) as typeof fetch;
  return () => {
    if (!seenSignal) throw new Error("fetch was not called");
    return seenSignal;
  };
}

function installBodyAbortFetch(): { getSignal: () => AbortSignal; getBody: () => ReadableStream<Uint8Array> } {
  let seenSignal: AbortSignal | undefined;
  let seenBody: ReadableStream<Uint8Array> | undefined;
  globalThis.fetch = ((_, init) => {
    seenSignal = init?.signal as AbortSignal | undefined;
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    seenBody = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
      },
    });
    const signal = seenSignal;
    signal?.addEventListener("abort", () => bodyController?.error(signal.reason), { once: true });
    return Promise.resolve(new Response(seenBody, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));
  }) as typeof fetch;
  return {
    getSignal: () => {
      if (!seenSignal) throw new Error("fetch was not called");
      return seenSignal;
    },
    getBody: () => {
      if (!seenBody) throw new Error("fetch was not called");
      return seenBody;
    },
  };
}

function installPreReaderAbortFetch(
  turn: AbortController,
  reason: Error,
  status = 200,
): { getSignal: () => AbortSignal; wasBodyLockedAtAbort: () => boolean; wasBodyCanceled: () => boolean } {
  let seenSignal: AbortSignal | undefined;
  let bodyLockedAtAbort: boolean | undefined;
  let bodyCanceled = false;
  let fallback: ReturnType<typeof setTimeout> | undefined;
  globalThis.fetch = ((_, init) => {
    seenSignal = init?.signal as AbortSignal | undefined;
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        bodyController = controller;
      },
      cancel() {
        bodyCanceled = true;
        if (fallback !== undefined) clearTimeout(fallback);
      },
    });
    queueMicrotask(() => {
      bodyLockedAtAbort = body.locked;
      turn.abort(reason);
      fallback = setTimeout(() => {
        if (!bodyCanceled) bodyController?.close();
      }, 25);
    });
    return Promise.resolve(new Response(body, {
      status,
      headers: { "Content-Type": "text/event-stream" },
    }));
  }) as typeof fetch;
  return {
    getSignal: () => {
      if (!seenSignal) throw new Error("fetch was not called");
      return seenSignal;
    },
    wasBodyLockedAtAbort: () => {
      if (bodyLockedAtAbort === undefined) throw new Error("abort did not run");
      return bodyLockedAtAbort;
    },
    wasBodyCanceled: () => bodyCanceled,
  };
}

async function waitForBodyReader(body: ReadableStream<Uint8Array>, turn: AbortController): Promise<void> {
  for (let attempt = 0; attempt < 200 && !body.locked; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  if (body.locked) return;
  turn.abort(new Error("sidecar response body reader was not attached"));
  throw new Error("sidecar response body reader was not attached");
}

function sseText(text: string): Response {
  return new Response(
    `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":${JSON.stringify(text)}}\n\n` +
      'event: response.completed\ndata: {"type":"response.completed"}\n\n',
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

describe("sidecar abort propagation", () => {
  test("web-search loop routed-provider fetch observes the WebSocket turn abort signal", async () => {
    const getSignal = installAbortAwareFetch();
    const turn = new AbortController();
    const adapter: ProviderAdapter = {
      name: "mock",
      buildRequest: () => ({ url: "https://routed.test/v1/chat/completions", method: "POST", headers: {}, body: "{}" }),
      async *parseStream() { /* unused */ },
      async parseResponse() { return []; },
    };
    const response = runWithWebSearch({
      parsed: parseRequest({
        model: "routed/model",
        input: "Search for current docs",
        stream: true,
        tools: [{ type: "web_search" }],
      }),
      adapter,
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
      abortSignal: turn.signal,
    });

    // buildRequest is now async-capable (Vertex ADC), so the loop yields once before dispatching
    // fetch; flush the microtask/timer queue so the routed fetch is observed.
    await new Promise((r) => setTimeout(r, 0));
    const signal = getSignal();
    // The loop now links an internal AbortController to the turn signal (so a client cancel of the
    // SSE body also aborts in-flight work). The routed fetch observes that linked signal, and a turn
    // abort must propagate to it.
    expect(signal.aborted).toBe(false);
    turn.abort("replacement turn");
    expect(signal.aborted).toBe(true);
    // The eager first iteration's fetch rejects on abort → explicit client-close status.
    expect((await response).status).toBe(499);
  });

  test("web-search sidecar fetch observes the WebSocket turn abort signal", async () => {
    const getSignal = installAbortAwareFetch();
    const turn = new AbortController();
    const recorded: unknown[] = [];
    const outcome = runWebSearch(
      "current docs",
      { type: "web_search" },
      forwardProvider,
      new Headers({ authorization: "Bearer token" }),
      { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      turn.signal,
      value => recorded.push(value),
    );

    const signal = getSignal();
    expect(signal.aborted).toBe(false);
    turn.abort(new Error("aborted by turn"));
    expect(signal.aborted).toBe(true);
    expect((await outcome).error).toBe("aborted by turn");
    expect(recorded).toEqual(["connect_neutral"]);
  });

  test("web-search sidecar records HTTP and connect outcomes", async () => {
    const recorded: unknown[] = [];
    globalThis.fetch = (() => Promise.resolve(new Response("expired", { status: 401 }))) as typeof fetch;

    const httpOutcome = await runWebSearch(
      "current docs",
      { type: "web_search" },
      forwardProvider,
      new Headers({ authorization: "Bearer token" }),
      { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      undefined,
      outcome => recorded.push(outcome),
    );

    expect(httpOutcome.error).toBe("sidecar HTTP 401: expired");
    expect(recorded).toEqual([401]);

    const lateAbort = new AbortController();
    globalThis.fetch = (() => {
      const rejected = Promise.reject(new Error("network down"));
      queueMicrotask(() => lateAbort.abort(new Error("late caller abort")));
      return rejected;
    }) as typeof fetch;
    const connectOutcome = await runWebSearch(
      "current docs",
      { type: "web_search" },
      forwardProvider,
      new Headers({ authorization: "Bearer token" }),
      { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      lateAbort.signal,
      outcome => recorded.push(outcome),
    );

    expect(connectOutcome.error).toBe("network down");
    expect(recorded).toEqual([401, "connect_error"]);
  });

  test("web-search sidecar redacts echoed bearer-shaped error bodies", async () => {
    globalThis.fetch = (() => Promise.resolve(new Response("upstream echoed Bearer sk-secret-sidecar", { status: 401 }))) as typeof fetch;
    const outcome = await runWebSearch(
      "current docs",
      { type: "web_search" },
      forwardProvider,
      new Headers({ authorization: "Bearer token" }),
      { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
    );
    expect(outcome.error).toBe("sidecar HTTP 401: upstream echoed Bearer [REDACTED]");
  });

  test("web-search loop forwards sidecar outcomes", async () => {
    const recorded: unknown[] = [];
    globalThis.fetch = ((input, init) => {
      const url = String(input);
      if (url.startsWith("https://routed.test/")) {
        return Promise.resolve(new Response("{}", { status: 200 }));
      }
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer token");
      return Promise.resolve(new Response("expired", { status: 401 }));
    }) as typeof fetch;
    const adapter: ProviderAdapter = {
      name: "mock",
      buildRequest: () => ({ url: "https://routed.test/v1/chat/completions", method: "POST", headers: {}, body: "{}" }),
      async *parseStream() {
        const events = [
          { type: "tool_call_start", id: "call_1", name: "web_search" },
          { type: "tool_call_delta", id: "call_1", arguments: JSON.stringify({ query: "current docs" }) },
          { type: "tool_call_end", id: "call_1" },
          { type: "done" },
        ] as const;
        for (const event of events) yield event;
      },
      async parseResponse() { throw new Error("parseResponse must be unreachable"); },
    };

    const response = await runWithWebSearch({
      parsed: parseRequest({
        model: "routed/model",
        input: "Search for current docs",
        stream: true,
        tools: [{ type: "web_search" }],
      }),
      adapter,
      forwardProvider,
      hostedTool: { type: "web_search" },
      selectedForwardHeaders: new Headers({ authorization: "Bearer token" }),
      settings: { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      maxSearches: 1,
      recordSidecarOutcome: outcome => recorded.push(outcome),
    });

    expect(response.status).toBe(200);
    // The sidecar now runs INSIDE the SSE body (live spinner), so its outcome is recorded only once
    // the stream is consumed. Drain the body, then assert.
    const reader = response.body!.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
    expect(recorded).toEqual([401]);
  });

  test("vision sidecar fetch observes the WebSocket turn abort signal", async () => {
    const getSignal = installAbortAwareFetch();
    const turn = new AbortController();
    const recorded: unknown[] = [];
    const outcome = describeImage(
      "data:image/png;base64,iVBORw0KGgo=",
      "high",
      "inspect screenshot",
      forwardProvider,
      new Headers({ authorization: "Bearer token" }),
      { model: "gpt-5.4-mini", timeoutMs: 30_000 },
      turn.signal,
      value => recorded.push(value),
    );

    const signal = getSignal();
    expect(signal.aborted).toBe(false);
    turn.abort(new Error("aborted by turn"));
    expect(signal.aborted).toBe(true);
    expect((await outcome).error).toBe("aborted by turn");
    expect(recorded).toEqual(["connect_neutral"]);
  });

  test("response-body caller aborts stay account-neutral for both sidecars", async () => {
    const webFetch = installBodyAbortFetch();
    const webTurn = new AbortController();
    const webRecorded: unknown[] = [];
    const webOutcome = runWebSearch(
      "current docs",
      { type: "web_search" },
      forwardProvider,
      new Headers({ authorization: "Bearer token" }),
      { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      webTurn.signal,
      value => webRecorded.push(value),
    );
    const webSignal = webFetch.getSignal();
    const webBody = webFetch.getBody();
    await waitForBodyReader(webBody, webTurn);
    const webReason = new Error("web body aborted by turn");
    webTurn.abort(webReason);
    expect(webSignal.reason).toBe(webReason);
    expect((await webOutcome).error).toBe("web body aborted by turn");
    expect(webRecorded).toEqual(["connect_neutral"]);

    const visionFetch = installBodyAbortFetch();
    const visionTurn = new AbortController();
    const visionRecorded: unknown[] = [];
    const visionOutcome = describeImage(
      "data:image/png;base64,iVBORw0KGgo=",
      "high",
      "inspect screenshot",
      forwardProvider,
      new Headers({ authorization: "Bearer token" }),
      { model: "gpt-5.4-mini", timeoutMs: 30_000 },
      visionTurn.signal,
      value => visionRecorded.push(value),
    );
    const visionSignal = visionFetch.getSignal();
    const visionBody = visionFetch.getBody();
    await waitForBodyReader(visionBody, visionTurn);
    const visionReason = new Error("vision body aborted by turn");
    visionTurn.abort(visionReason);
    expect(visionSignal.reason).toBe(visionReason);
    expect((await visionOutcome).error).toBe("vision body aborted by turn");
    expect(visionRecorded).toEqual(["connect_neutral"]);
  });

  test("pre-reader caller aborts stay account-neutral for both sidecars", async () => {
    const webTurn = new AbortController();
    const webReason = new Error("web aborted before reader attach");
    const webFetch = installPreReaderAbortFetch(webTurn, webReason);
    const webRecorded: unknown[] = [];
    const webOutcome = await runWebSearch(
      "current docs",
      { type: "web_search" },
      forwardProvider,
      new Headers({ authorization: "Bearer token" }),
      { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      webTurn.signal,
      value => webRecorded.push(value),
    );
    expect(webFetch.wasBodyLockedAtAbort()).toBe(false);
    expect(webFetch.wasBodyCanceled()).toBe(true);
    expect(webFetch.getSignal().reason).toBe(webReason);
    expect(webOutcome.error).toBe("web aborted before reader attach");
    expect(webRecorded).toEqual(["connect_neutral"]);

    const visionTurn = new AbortController();
    const visionReason = new Error("vision aborted before reader attach");
    const visionFetch = installPreReaderAbortFetch(visionTurn, visionReason);
    const visionRecorded: unknown[] = [];
    const visionOutcome = await describeImage(
      "data:image/png;base64,iVBORw0KGgo=",
      "high",
      "inspect screenshot",
      forwardProvider,
      new Headers({ authorization: "Bearer token" }),
      { model: "gpt-5.4-mini", timeoutMs: 30_000 },
      visionTurn.signal,
      value => visionRecorded.push(value),
    );
    expect(visionFetch.wasBodyLockedAtAbort()).toBe(false);
    expect(visionFetch.wasBodyCanceled()).toBe(true);
    expect(visionFetch.getSignal().reason).toBe(visionReason);
    expect(visionOutcome.error).toBe("vision aborted before reader attach");
    expect(visionRecorded).toEqual(["connect_neutral"]);
  });

  test("vision guards an HTTP-error body before a pre-reader caller abort", async () => {
    const turn = new AbortController();
    const reason = new Error("vision HTTP body aborted before reader attach");
    const fetchState = installPreReaderAbortFetch(turn, reason, 403);
    const recorded: unknown[] = [];
    const outcome = await describeImage(
      "data:image/png;base64,iVBORw0KGgo=",
      "high",
      "inspect screenshot",
      forwardProvider,
      new Headers({ authorization: "Bearer token" }),
      { model: "gpt-5.4-mini", timeoutMs: 30_000 },
      turn.signal,
      value => recorded.push(value),
    );
    expect(fetchState.wasBodyLockedAtAbort()).toBe(false);
    expect(fetchState.wasBodyCanceled()).toBe(true);
    expect(fetchState.getSignal().reason).toBe(reason);
    expect(outcome.error).toBe("vision sidecar HTTP 403: ");
    expect(recorded).toEqual([403]);
  });

  test("successful SSE bodies record HTTP success once for both sidecars", async () => {
    const webRecorded: unknown[] = [];
    globalThis.fetch = (() => Promise.resolve(sseText("done"))) as typeof fetch;
    const webOutcome = await runWebSearch(
      "current docs",
      { type: "web_search" },
      forwardProvider,
      new Headers({ authorization: "Bearer token" }),
      { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
      undefined,
      value => webRecorded.push(value),
    );
    expect(webOutcome.text).toBe("done");
    expect(webRecorded).toEqual([200]);

    const visionRecorded: unknown[] = [];
    globalThis.fetch = (() => Promise.resolve(sseText("image description"))) as typeof fetch;
    const visionOutcome = await describeImage(
      "data:image/png;base64,iVBORw0KGgo=",
      "high",
      "inspect screenshot",
      forwardProvider,
      new Headers({ authorization: "Bearer token" }),
      { model: "gpt-5.4-mini", timeoutMs: 30_000 },
      undefined,
      value => visionRecorded.push(value),
    );
    expect(visionOutcome.text).toBe("image description");
    expect(visionRecorded).toEqual([200]);
  });

  test("vision sidecar records HTTP and connect outcomes", async () => {
    const recorded: unknown[] = [];
    globalThis.fetch = (() => Promise.resolve(new Response("denied", { status: 403 }))) as typeof fetch;

    const httpOutcome = await describeImage(
      "data:image/png;base64,iVBORw0KGgo=",
      "high",
      "inspect screenshot",
      forwardProvider,
      new Headers({ authorization: "Bearer token" }),
      { model: "gpt-5.4-mini", timeoutMs: 30_000 },
      undefined,
      outcome => recorded.push(outcome),
    );

    expect(httpOutcome.error).toBe("vision sidecar HTTP 403: denied");
    expect(recorded).toEqual([403]);

    const lateAbort = new AbortController();
    globalThis.fetch = (() => {
      const rejected = Promise.reject(new Error("vision network down"));
      queueMicrotask(() => lateAbort.abort(new Error("late caller abort")));
      return rejected;
    }) as typeof fetch;
    const connectOutcome = await describeImage(
      "data:image/png;base64,iVBORw0KGgo=",
      "high",
      "inspect screenshot",
      forwardProvider,
      new Headers({ authorization: "Bearer token" }),
      { model: "gpt-5.4-mini", timeoutMs: 30_000 },
      lateAbort.signal,
      outcome => recorded.push(outcome),
    );

    expect(connectOutcome.error).toBe("vision network down");
    expect(recorded).toEqual([403, "connect_error"]);
  });

  test("sidecar deadlines remain timeout health evidence", async () => {
    const webRecorded: unknown[] = [];
    installAbortAwareFetch();
    const webOutcome = await runWebSearch(
      "current docs",
      { type: "web_search" },
      forwardProvider,
      new Headers({ authorization: "Bearer token" }),
      { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 1 },
      undefined,
      outcome => webRecorded.push(outcome),
    );
    expect(webOutcome.error).toBe("Timeout elapsed");
    expect(webRecorded).toEqual(["timeout"]);

    const visionRecorded: unknown[] = [];
    installAbortAwareFetch();
    const visionOutcome = await describeImage(
      "data:image/png;base64,iVBORw0KGgo=",
      "high",
      "inspect screenshot",
      forwardProvider,
      new Headers({ authorization: "Bearer token" }),
      { model: "gpt-5.4-mini", timeoutMs: 1 },
      undefined,
      outcome => visionRecorded.push(outcome),
    );
    expect(visionOutcome.error).toBe("Timeout elapsed");
    expect(visionRecorded).toEqual(["timeout"]);
  });

  test("vision sidecar redacts echoed bearer-shaped error bodies", async () => {
    globalThis.fetch = (() => Promise.resolve(new Response("upstream echoed Bearer sk-secret-sidecar", { status: 403 }))) as typeof fetch;
    const outcome = await describeImage(
      "data:image/png;base64,iVBORw0KGgo=",
      "high",
      "inspect screenshot",
      forwardProvider,
      new Headers({ authorization: "Bearer token" }),
      { model: "gpt-5.4-mini", timeoutMs: 30_000 },
    );
    expect(outcome.error).toBe("vision sidecar HTTP 403: upstream echoed Bearer [REDACTED]");
  });

  test("web-search sidecar uses selected pool auth instead of inbound main auth", async () => {
    let seenAuthorization: string | null = null;
    let seenAccount: string | null = null;
    globalThis.fetch = ((_, init) => {
      const headers = new Headers(init?.headers);
      seenAuthorization = headers.get("authorization");
      seenAccount = headers.get("chatgpt-account-id");
      return Promise.resolve(sseText("done"));
    }) as typeof fetch;
    const selectedHeaders = headersForCodexAuthContext(
      new Headers({ authorization: "Bearer main-token", "chatgpt-account-id": "main_acc" }),
      { kind: "pool", accountId: "pool-a", generation: 1, accessToken: "pool-token", chatgptAccountId: "pool_acc" },
    );

    await runWebSearch(
      "current docs",
      { type: "web_search" },
      forwardProvider,
      selectedHeaders,
      { model: "gpt-5.4-mini", reasoning: "low", timeoutMs: 30_000 },
    );

    expect(seenAuthorization).toBe("Bearer pool-token");
    expect(seenAccount).toBe("pool_acc");
  });

  test("vision sidecar uses selected pool auth instead of inbound main auth", async () => {
    let seenAuthorization: string | null = null;
    let seenAccount: string | null = null;
    globalThis.fetch = ((_, init) => {
      const headers = new Headers(init?.headers);
      seenAuthorization = headers.get("authorization");
      seenAccount = headers.get("chatgpt-account-id");
      return Promise.resolve(sseText("image description"));
    }) as typeof fetch;
    const selectedHeaders = headersForCodexAuthContext(
      new Headers({ authorization: "Bearer main-token", "chatgpt-account-id": "main_acc" }),
      { kind: "pool", accountId: "pool-a", generation: 1, accessToken: "pool-token", chatgptAccountId: "pool_acc" },
    );

    await describeImage(
      "data:image/png;base64,iVBORw0KGgo=",
      "high",
      "inspect screenshot",
      forwardProvider,
      selectedHeaders,
      { model: "gpt-5.4-mini", timeoutMs: 30_000 },
    );

    expect(seenAuthorization).toBe("Bearer pool-token");
    expect(seenAccount).toBe("pool_acc");
  });
});
