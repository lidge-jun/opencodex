import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markResponseNonReplayable } from "../../src/lib/upstream-retry";
import { handleResponses } from "../../src/server/responses/core";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const originalFetch = globalThis.fetch;
const originalOpenCodexHome = process.env.OPENCODEX_HOME;

/** The exact Console Go rejection for a payload it accepts moments later. */
const UPLOAD_REFUSAL = JSON.stringify({
  model: "muse-spark-1.3-contributor",
  error: {
    param: null,
    type: "invalid_request_error",
    message: "Error from provider (Console Go): Upstream request failed: [invalid_request_error] Invalid upload request.",
  },
});

/** A deterministic 400 on the same wire: a verdict on the request, never a flap. */
const EFFORT_REFUSAL = JSON.stringify({
  model: "muse-spark-1.3-contributor",
  error: {
    param: "reasoning.effort",
    type: "invalid_request_error",
    message: "Error from provider (Console Go): Upstream request failed: [invalid_request_error] reasoning_effort max requires an active Muse Code subscription for model muse-spark-1.3-contributor.",
  },
});

let testDir = "";

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-console-go-upload-retry-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalOpenCodexHome;
  removeTreeWithRetry(testDir);
});

function config(): OcxConfig {
  return {
    defaultProvider: "go",
    providers: {
     go: {
       adapter: "openai-responses",
       baseUrl: "https://opencode.ai/zen/go/v1",
       authMode: "key",
       apiKey: "go-test-key",
     },
      other: {
        adapter: "openai-responses",
        baseUrl: "https://other.example.test/v1",
        authMode: "key",
        apiKey: "other-test-key",
      },
   },
 } as OcxConfig;
}

function request(stream = false, provider = "go"): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "session_id": "thread-console-go-upload-retry",
    },
    body: JSON.stringify({
      model: provider + "/muse-spark-1.3-contributor",
      stream,
      store: false,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
    }),
  });
}

function refusal(status = 400, body = UPLOAD_REFUSAL): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

function success(id: string): Response {
  return Response.json({ id, object: "response", status: "completed", model: "muse-spark-1.3-contributor", output: [] });
}

describe("Console Go transient upload refusal recovery", () => {
  test("replays the refusal once and serves the retry with a byte-identical body", async () => {
    const outbound: string[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(String(init?.body));
      return outbound.length === 1 ? refusal() : success("resp-upload-retry-recovered");
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const response = await handleResponses(request(), config(), logCtx);

    expect(response.status).toBe(200);
    expect(outbound).toHaveLength(2);
    // The replay must preserve the exact serialized request.
    expect(outbound[1]).toBe(outbound[0]);
    expect(logCtx.activeAttempt?.recoveryKinds).toEqual(["console-go-upload-retry"]);
  });

  test("does not replay a different 400 from the same wire", async () => {
    let sends = 0;
    globalThis.fetch = (async () => {
      sends += 1;
      return refusal(400, EFFORT_REFUSAL);
    }) as typeof fetch;

    const response = await handleResponses(request(), config(), { model: "", provider: "" });

    expect(response.status).toBe(400);
    expect(sends).toBe(1);
  });

  test("keeps a repeated refusal visible after the single bounded replay", async () => {
    let sends = 0;
    globalThis.fetch = (async () => {
      sends += 1;
      return refusal();
    }) as typeof fetch;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const response = await handleResponses(request(), config(), logCtx);

    expect(response.status).toBe(400);
    expect(sends).toBe(2);
    expect(logCtx.activeAttempt?.recoveryKinds).toEqual(["console-go-upload-retry"]);
  });

  test("does not replay the same refusal text from a non-Console provider", async () => {
    let sends = 0;
    globalThis.fetch = (async () => {
      sends += 1;
      return refusal();
    }) as typeof fetch;

    const response = await handleResponses(request(false, "other"), config(), { model: "", provider: "" });

    expect(response.status).toBe(400);
    expect(sends).toBe(1);
  });
});


describe("Console destination and translated recovery controls", () => {
  test("a query-bearing Console destination never authorizes another POST", async () => {
    const cfg = config();
    cfg.providers.go!.baseUrl = "https://opencode.ai/zen/go/v1?tenant=fixture";
    const outbound: string[] = [];
    globalThis.fetch = (async input => { outbound.push(String(input)); return refusal(); }) as typeof fetch;
    const response = await handleResponses(request(), cfg, { model: "", provider: "" });
    expect(response.status).toBe(400);
    expect(outbound).toHaveLength(1);
    expect(new URL(outbound[0]!).search).toBe("?tenant=fixture");
  });

  test("a canonical row name cannot authorize a noncanonical generation path", async () => {
    const cfg = config();
    cfg.providers["opencode-go"] = {
      ...cfg.providers.go!,
      responsesPath: "/unrelated",
      chatCompletionsPath: "/unrelated",
    };
    const outbound: string[] = [];
    globalThis.fetch = (async input => { outbound.push(String(input)); return refusal(); }) as typeof fetch;
    const response = await handleResponses(request(false, "opencode-go"), cfg, { model: "", provider: "" });
    expect(response.status).toBe(400);
    // Canonical row names normalize their base URL. A configured send path survives
    // that normalization and reaches the effective-destination recovery gate.
    expect(outbound).toEqual(["https://opencode.ai/zen/go/v1/unrelated"]);
    expect(await response.text()).toContain("Invalid upload request.");
  });

  test("normalization to the canonical endpoint keeps its bounded recovery", async () => {
    const cfg = config();
    cfg.providers["opencode-go"] = { ...cfg.providers.go!, baseUrl: "https://other.example.test/v1" };
    const outbound: string[] = [];
    globalThis.fetch = (async input => { outbound.push(String(input)); return refusal(); }) as typeof fetch;
    const response = await handleResponses(request(false, "opencode-go"), cfg, { model: "", provider: "" });
    expect(response.status).toBe(400);
    expect(outbound).toEqual([
      "https://opencode.ai/zen/go/v1/responses",
      "https://opencode.ai/zen/go/v1/responses",
    ]);
    expect(await response.text()).toContain("Invalid upload request.");
  });

  for (const adapter of ["openai-responses", "openai-chat"] as const) {
    for (const stream of [false, true]) {
      test(`${adapter} stream=${stream} replays identical bytes once`, async () => {
        const cfg = config();
        cfg.providers.go!.adapter = adapter;
        const outbound: string[] = [];
        globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
          outbound.push(String(init?.body));
          if (outbound.length === 1) return refusal();
          if (adapter === "openai-responses") {
            const completed = { id: "resp_fixture", object: "response", status: "completed", output: [] };
            return stream ? new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: completed })}\n\n`, { headers: { "content-type": "text/event-stream" } }) : Response.json(completed);
          }
          if (!stream) return Response.json({ id: "chat_fixture", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "answer" }, finish_reason: "stop" }] });
          const chunk = { id: "chat_fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "answer" }, finish_reason: "stop" }] };
          return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
        }) as typeof fetch;
        const logCtx: RequestLogContext = { model: "", provider: "" };
        const response = await handleResponses(request(stream), cfg, logCtx);
        const body = await response.text();
        expect(response.status).toBe(200);
        expect(outbound).toHaveLength(2);
        expect(outbound[1]).toBe(outbound[0]);
        expect(logCtx.activeAttempt?.recoveryKinds).toEqual(["console-go-upload-retry"]);
        expect(body).toContain("completed");
      });
    }
    test(`${adapter} abort during backoff sends no replay`, async () => {
      const cfg = config(); cfg.providers.go!.adapter = adapter;
      const controller = new AbortController();
      let sends = 0;
      globalThis.fetch = (async () => { sends++; return refusal(); }) as typeof fetch;
      const originalTimeout = globalThis.setTimeout;
      const spy = spyOn(globalThis, "setTimeout").mockImplementation(((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
        if (ms === 800) queueMicrotask(() => controller.abort());
        return originalTimeout(handler, ms, ...args);
      }) as typeof setTimeout);
      try {
        const response = await handleResponses(request(), cfg, { model: "", provider: "" }, { abortSignal: controller.signal });
        expect(controller.signal.aborted).toBe(true);
        expect(response.status).toBe(499);
        expect(sends).toBe(1);
      } finally { spy.mockRestore(); }
    });
  }
});


describe("Console nonreplayable response boundary", () => {
  for (const adapter of ["openai-responses", "openai-chat"] as const) {
    test(`${adapter} does not replay a marked response`, async () => {
      const cfg = config(); cfg.providers.go!.adapter = adapter;
      let sends = 0;
      globalThis.fetch = (async () => {
        sends++;
        const response = refusal();
        markResponseNonReplayable(response);
        return response;
      }) as typeof fetch;
      const response = await handleResponses(request(), cfg, { model: "", provider: "" });
      expect(response.status).toBe(400);
      expect(sends).toBe(1);
      expect(await response.text()).toContain("Invalid upload request.");
    });
  }
});
